/**
 * TASK-PW-15：协作台对话 API（pw_collab_messages 会话流 + pw_settle_drafts 结账草稿）。
 *
 * 纪律：
 * - 会话按押注一条连续流：pw_collab_messages 是回放真值源（GET 正序返回），
 *   同时为每张押注建一条持久 pi session 供 AgentHarness 维护模型可见历史。
 * - 不建 run 回放：POST 直接 SSE 流，事件名见 runCollabTurn。
 * - PW-24 起：exec 档写工具进表——人发话才执行（店规纪律+指令引用落账）；PW-25 挑/否/结账/冲正进表。
 * - PW-26 起：fetch_corpus 转自主档（auto）——AI 自主直抓、人事后审；SSE 事件 fetch_started。
 */
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { contentText } from "@earendil-works/pi-ai";
import { AgentHarness, type AgentHarnessEvent } from "@earendil-works/pi-agent-core";
import { httpError, nowIso } from "./data.ts";
import { getPwBet } from "./pw-bets.ts";
import { listPwBetDrafts } from "./pw-drafts.ts";
import { recordPwEvent } from "./pw-runs.ts";
import { buildCollabContext, PW_COLLAB_GLOBAL_BET_ID } from "./pw-context.ts";
import { pwCollabRefTable, recordPwVerdictRefs } from "./pw-verdict-refs.ts";
// 简报 23 · 曝光自动记账：协作台 §N 注入点（buildCollabContext 装配的 golds/tombs 进 system prompt 时记一行）
import { recordPwVerdictExposure } from "./pw-closed-loop.ts";
import { listPwCorpusProposed } from "./pw-corpus.ts";
import { createPapertableProvider, type PapertableProvider } from "./provider-settings.ts";
import { closeSession, type PiSession, type SessionRepo } from "./sessions.ts";
import type { SieveNotifier } from "./pw-sieve.ts";
import {
  COLLAB_MAX_TOOL_ROUNDS,
  pwCollabTools,
  type CollabToolContext,
} from "./pw-collab-tools.ts";

export type PwCollabRole = "user" | "assistant";

export type PwCollabMessageRow = {
  id: string;
  bet_id: string;
  role: PwCollabRole;
  text: string;
  tool_calls_json: string;
  created_at: string;
};

export type PwSettleRecommendation = "settle_gold" | "settle_tomb" | "wait";

export type PwSettleAdvice = {
  recommendation: PwSettleRecommendation;
  lesson?: string | null;
  cause_of_death?: string | null;
  note?: string | null;
};

export type PwSettleDraftRow = {
  id: string;
  bet_id: string;
  advice_json: string;
  draft_hash: string;
  status: "pending" | "approved" | "rejected";
  reject_reason: string | null;
  created_by: string;
  created_at: string;
};

const SETTLE_RECOMMENDATIONS: readonly PwSettleRecommendation[] = [
  "settle_gold",
  "settle_tomb",
  "wait",
];

export function ensurePwCollabTables(db: DatabaseSync): void {
  // TASK-PW-22：pw_collab_messages 改为 id 弱引用（去物理外键）——'global' 哨兵会话
  // 不对应真实押注；与仓库「跨模块引用只存 id 字符串」约定一致。旧库含 FK 时重建迁移。
  const msgSql = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type='table' AND name='pw_collab_messages'
  `).get() as { sql: string } | undefined;
  if (msgSql && msgSql.sql.includes("REFERENCES pw_bets")) {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE pw_collab_messages_new (
        id TEXT PRIMARY KEY,
        bet_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user','assistant')),
        text TEXT NOT NULL,
        tool_calls_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      INSERT INTO pw_collab_messages_new SELECT * FROM pw_collab_messages;
      DROP TABLE pw_collab_messages;
      ALTER TABLE pw_collab_messages_new RENAME TO pw_collab_messages;
      COMMIT;
    `);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS pw_collab_messages (
      id TEXT PRIMARY KEY,
      bet_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      text TEXT NOT NULL,
      tool_calls_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pw_collab_messages_bet_created
      ON pw_collab_messages(bet_id, created_at);
    CREATE TABLE IF NOT EXISTS pw_settle_drafts (
      id TEXT PRIMARY KEY,
      bet_id TEXT NOT NULL REFERENCES pw_bets(id),
      advice_json TEXT NOT NULL,
      draft_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','approved','rejected')),
      reject_reason TEXT,
      created_by TEXT NOT NULL DEFAULT 'ai',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pw_settle_drafts_pending
      ON pw_settle_drafts(status, created_at);
  `);
}

export function appendPwCollabMessage(
  db: DatabaseSync,
  betId: string,
  role: PwCollabRole,
  text: string,
  toolCallsJson = "[]",
): PwCollabMessageRow {
  if (role !== "user" && role !== "assistant") throw httpError(400, "非法角色");
  // TASK-PW-22：'global' 哨兵会话（全局证据对话）不校验押注存在
  if (betId !== PW_COLLAB_GLOBAL_BET_ID && !getPwBet(db, betId)) throw httpError(404, "押注不存在");
  if (typeof text !== "string") throw httpError(400, "text 必须是字符串");
  assertToolCallsJson(toolCallsJson);
  const id = randomUUID();
  db.prepare(`
    INSERT INTO pw_collab_messages(id, bet_id, role, text, tool_calls_json, created_at)
    VALUES(?, ?, ?, ?, ?, ?)
  `).run(id, betId, role, text, toolCallsJson, nowIso());
  return getPwCollabMessage(db, id);
}

export function listPwCollabMessages(db: DatabaseSync, betId: string): PwCollabMessageRow[] {
  return db.prepare(`
    SELECT id, bet_id, role, text, tool_calls_json, created_at
    FROM pw_collab_messages
    WHERE bet_id = ?
    ORDER BY created_at, id
  `).all(betId) as PwCollabMessageRow[];
}

export function createPwSettleDraft(
  db: DatabaseSync,
  betId: string,
  advice: PwSettleAdvice,
): PwSettleDraftRow {
  if (!getPwBet(db, betId)) throw httpError(404, "押注不存在");
  const recommendation = advice?.recommendation;
  if (!SETTLE_RECOMMENDATIONS.includes(recommendation)) throw httpError(400, "非法 recommendation");
  const normalized: PwSettleAdvice = {
    recommendation,
    lesson: advice.lesson ?? null,
    cause_of_death: advice.cause_of_death ?? null,
    note: advice.note ?? null,
  };
  const adviceJson = JSON.stringify(normalized);
  const draftHash = createHash("sha256").update(adviceJson, "utf8").digest("hex");
  const id = randomUUID();
  const createdAt = nowIso();
  db.prepare(`
    INSERT INTO pw_settle_drafts(
      id, bet_id, advice_json, draft_hash, status, reject_reason, created_by, created_at
    ) VALUES(?, ?, ?, ?, 'pending', NULL, 'ai', ?)
  `).run(id, betId, adviceJson, draftHash, createdAt);
  return getPwSettleDraft(db, id);
}

export function listPwSettleDrafts(db: DatabaseSync): PwSettleDraftRow[] {
  return db.prepare(`
    SELECT * FROM pw_settle_drafts
    WHERE status = 'pending'
    ORDER BY created_at, id
  `).all() as PwSettleDraftRow[];
}

export function approvePwSettleDraft(db: DatabaseSync, id: string): PwSettleDraftRow {
  const draft = requirePwSettleDraft(db, id);
  if (draft.status !== "pending") throw httpError(400, "仅 pending 结账草稿可批准");
  db.prepare("UPDATE pw_settle_drafts SET status = 'approved' WHERE id = ?").run(id);
  return getPwSettleDraft(db, id);
}

export function rejectPwSettleDraft(db: DatabaseSync, id: string, reason: unknown): PwSettleDraftRow {
  const draft = requirePwSettleDraft(db, id);
  if (draft.status !== "pending") throw httpError(400, "仅 pending 结账草稿可驳回");
  if (typeof reason !== "string" || !reason.trim()) throw httpError(400, "reason 必填");
  db.prepare("UPDATE pw_settle_drafts SET status = 'rejected', reject_reason = ? WHERE id = ?")
    .run(reason.trim(), id);
  return getPwSettleDraft(db, id);
}

/** 待确认队列三态聚合：押注草稿 / 结账草稿 / 语料提议。 */
export function collabPendingQueue(db: DatabaseSync): {
  betDrafts: ReturnType<typeof listPwBetDrafts>;
  settleDrafts: PwSettleDraftRow[];
  corpusProposed: ReturnType<typeof listPwCorpusProposed>;
} {
  return {
    betDrafts: listPwBetDrafts(db),
    settleDrafts: listPwSettleDrafts(db),
    corpusProposed: listPwCorpusProposed(db),
  };
}

export const COLLAB_SYSTEM_PROMPT = [
  "你是「镇纸 Paperweight」的创作副驾驶，只和用户讨论当前这一张押注卡。",
  "数据只信两类来源：注入的上下文（§N 编号的金子/墓碑、数据文档、语料摘要）和你可用的工具；不知道就说不知道，不编造数字。",
  "引用金子/墓碑时用 §N 标注。",
  // TASK-PW-21 纪律①：原文原则——引用评论/语料必须逐字引用原文
  "引用评论或语料必须逐字引用原文（原文原则），禁止改写或概括。",
  // TASK-PW-25：候选卡挑/改/否、全否重筛进表（人发话才执行）
  "候选卡的挑/改/否、全否重筛由人发话、你执行（pick_sieve_card / reject_sieve_card / reject_all_and_resieve）；人没发话你不主动挑否。",
  "你可以用 draft_bet / draft_settle 起草押注或结账建议；用户明确说「确认」时，用 confirm_bet_draft 把押注草稿转正——落笔=人发话、你执行。",
  // TASK-PW-28：起草押注先分户口——内容向必须 kind='content'，否则不进协作台在途 rail
  "起草押注先分户口：选题/内容向 → draft_bet 传 kind='content'（从候选卡聊出的带 sourceCardId）；判断/生活向 → 缺省不传。只有 kind='content' 的押注才会出现在协作台在途押注 rail。",
  "你可以用 fetch_corpus 自主抓取某条视频的公开数据与评论——判明确有需要就抓，不必等人批准，人事后会审；限速纪律：抓前可用 read_connections 看风控信号，有风控/限速迹象就少抓、慢抓或暂停并说明，撞墙（needs_human）立即停手交人。",
  // TASK-PW-24 店规三段（原文照录，测试做包含断言；PW-25 起候选卡挑/否/结账/冲正进表）
  "写工具纪律：凡 description 以「人发话才执行」开头的工具，只有在用户当轮消息明确提出该动作时才允许调用；用户没说的写入一律不做，宁可反问。",
  "指认规矩：摆对象时用菜号牌（候选卡=证据 N / 少数派 N，在途押注=注 N，数据文档=文档 N，草稿=草稿 id 前 8 位，语料=BV 号，金子墓碑=§N）——这些编号和用户在屏幕上看到的徽标同源；用户说「就这张」时锚定当前话题对象；指认明确就直接执行，不复述不二次确认；指认含糊必须反问，绝不猜——同名区有多张时（如少数派 1/2/3），「那张」一律反问到哪一张。",
  "查账：用户问「你最近代办了什么」时用 list_my_actions 如实摆出，包括依据的是哪句话。",
  // TASK-PW-25 铸币纪律：结账按草案一步结掉；冲正键只有两个
  "铸币纪律：结账（settle_bet）按已固化的结账草案一步结掉，草案内容即结账内容，不临场改写；撤销挑卡（unpick_sieve_card）与结账作废（void_settlement）是仅有的两个冲正键，只在用户明确说撤销/作废时使用。",
  "回答风格：直接、具体、短段落。",
].join("\n");

/** TASK-PW-22：全局会话（betId='global'）时追加的说明——全局证据视角。 */
export const COLLAB_GLOBAL_PROMPT_NOTE = [
  "当前是全局证据对话（不绑定单张押注卡）：你能看到全部在途内容押注卡、待选候选卡、语料库与判决簿。",
  "用户问全局问题时用全局视角回答；需要某张卡的细节时，用 read_bet / list_sieve_cards / read_sieve_card 等工具并在回答里说清是哪张卡。",
  "全局对话里同样可以按人指令执行挑/否/结账/冲正——先指认对象（哪张卡/哪笔结账），再执行。",
].join("\n");

/**
 * 协作台单轮对话：存 user 行 → 装配 v2 拼 system → AgentHarness（持久 per-bet session）
 * → 事件映射为 SSE（tool_start/tool_end/answer_delta/draft_created/fetch_proposed/run_end）
 * → 存 assistant 行。
 * onEvent 只写流，由 main.ts 落 SSE；run_end 之后 main.ts 结束响应。
 */
export async function runCollabTurn(
  services: { db: DatabaseSync; sessions: SessionRepo; sieve?: SieveNotifier },
  betId: string,
  userText: string,
  onEvent: (name: string, payload: Record<string, unknown>) => void | Promise<void>,
): Promise<{ ok: boolean; error?: string }> {
  const isGlobal = betId === PW_COLLAB_GLOBAL_BET_ID;
  // TASK-PW-22：'global' 哨兵会话不校验押注存在
  if (!isGlobal && !getPwBet(services.db, betId)) throw httpError(404, "押注不存在");
  const userRow = appendPwCollabMessage(services.db, betId, "user", userText, "[]");
  // TASK-PW-23：用户消息落账（指针式，actor=human；messageId 弱引用 pw_collab_messages 行）
  recordPwEvent(services.db, {
    eventType: "message",
    actor: "human",
    payloadJson: JSON.stringify({
      betId,
      messageId: userRow.id,
      role: "user",
      len: userText.length,
    }),
  });
  await onEvent("user_saved", { messageId: userRow.id });

  const context = buildCollabContext(services.db, betId);
  // 简报 23 · 曝光自动记账：本次放进上下文的判决 = 装配进来的 golds+tombs（§N 编号表同源）
  const exposedVerdictIds = [...context.golds.map((gold) => gold.id), ...context.tombs.map((tomb) => tomb.id)];
  recordPwVerdictExposure(services.db, {
    surface: "collab",
    betId,
    verdictIds: exposedVerdictIds,
    actor: "system",
  });
  const refs = new Map<string, string>();
  for (const gold of context.golds) refs.set(gold.id, gold.ref);
  for (const tomb of context.tombs) refs.set(tomb.id, tomb.ref);
  // TASK-PW-24：exec 工具注入当轮用户指令（落库后的原文与 id）；sieve 由 main.ts 装配后传入
  const toolContext: CollabToolContext = {
    db: services.db,
    betId,
    refs,
    instruction: { text: userRow.text, messageId: userRow.id },
    sieve: services.sieve,
  };

  let provider: PapertableProvider;
  try {
    provider = createPapertableProvider();
  } catch (error) {
    const message = safeErrorText(error);
    await onEvent("run_end", { reason: "error", error: message });
    return { ok: false, error: message };
  }

  let session: PiSession | undefined;
  let harness: AgentHarness<CollabToolContext> | undefined;
  const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
  let text = "";
  let toolRounds = 0;
  let blockedCalls = 0;
  try {
    session = await openCollabSession(services.sessions, betId);
    harness = new AgentHarness<CollabToolContext>({
      session,
      models: provider.models,
      model: provider.model,
      thinkingLevel: provider.thinkingLevel,
      systemPrompt: COLLAB_SYSTEM_PROMPT + (isGlobal ? "\n" + COLLAB_GLOBAL_PROMPT_NOTE : "") + "\n\n" + context.markdown,
      toolContext,
      tools: pwCollabTools,
      streamOptions: {
        timeoutMs: 120_000,
        maxRetries: 2,
        maxRetryDelayMs: 12_000,
      },
    });
    harness.on("tool_call", (event) => {
      if (toolRounds >= COLLAB_MAX_TOOL_ROUNDS) {
        blockedCalls += 1;
        // 安全阀：模型无视上限死循环时强行中止
        if (blockedCalls > COLLAB_MAX_TOOL_ROUNDS + 4) {
          void harness?.abort().catch(() => undefined);
        }
        return {
          block: true,
          reason: `本轮工具循环已达上限（${COLLAB_MAX_TOOL_ROUNDS} 轮），请停止调用工具，直接回答。`,
        };
      }
      return undefined;
    });
    harness.subscribe((event) =>
      handleHarnessEvent(event, {
        onEvent,
        toolCalls,
        onToolRound: () => {
          toolRounds += 1;
        },
        onText: (delta) => {
          text += delta;
        },
      })
    );
    const assistant = await harness.prompt(userText);
    const finalText = text || contentText(assistant.content, "");
    const assistantRow = appendPwCollabMessage(
      services.db,
      betId,
      "assistant",
      finalText,
      JSON.stringify(toolCalls),
    );
    // TASK-PW-23：assistant 消息落账（actor=ai，kind=manual_event 为白名单唯一例外）
    recordPwEvent(services.db, {
      kind: "manual_event",
      eventType: "message",
      actor: "ai",
      payloadJson: JSON.stringify({
        betId,
        messageId: assistantRow.id,
        role: "assistant",
        len: finalText.length,
      }),
    });
    // TASK-PW-30：引用落库——§N 标注命中编号表才记账；伪造/未知标注丢弃，绝不拿 provided 冒充 used
    const { inserted, dropped } = recordPwVerdictRefs(services.db, {
      sourceKind: "collab_message",
      sourceId: assistantRow.id,
      text: finalText,
      refTable: pwCollabRefTable(context),
    });
    if (dropped.length > 0) console.warn(`[pw-verdict-refs] 未命中编号表丢弃：${dropped.join(", ")}（inserted=${inserted}）`);
    await onEvent("run_end", { reason: "done" });
    return { ok: true };
  } catch (error) {
    const message = safeErrorText(error);
    try {
      if (text.trim() || toolCalls.length > 0) {
        appendPwCollabMessage(services.db, betId, "assistant", text, JSON.stringify(toolCalls));
      }
    } catch {
      // 存储尽力而为，不让一条失败轮阻塞 run_end
    }
    await onEvent("run_end", { reason: "error", error: message });
    return { ok: false, error: message };
  } finally {
    if (session) await closeSession(session).catch(() => undefined);
  }
}

function handleHarnessEvent(
  event: AgentHarnessEvent,
  handlers: {
    onEvent: (name: string, payload: Record<string, unknown>) => void | Promise<void>;
    toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
    onToolRound: () => void;
    onText: (delta: string) => void;
  },
): Promise<void> {
  if (event.type === "tool_execution_start") {
    handlers.onToolRound();
    const args = asRecord(event.args);
    handlers.toolCalls.push({ id: event.toolCallId, name: event.toolName, args });
    return Promise.resolve(handlers.onEvent("tool_start", {
      tool: event.toolName,
      argsSummary: summarizeArgs(args),
    }));
  }
  if (event.type === "tool_execution_end") {
    const result = asRecord(event.result);
    const details = asRecord(result.details);
    const summary = typeof details.summary === "string" ? details.summary : "";
    const calls: Array<Promise<unknown>> = [
      Promise.resolve(handlers.onEvent("tool_end", { tool: event.toolName, summary })),
    ];
    if (!event.isError && event.toolName === "fetch_corpus") {
      if (typeof details.corpusId === "string") {
        calls.push(Promise.resolve(handlers.onEvent("fetch_started", {
          corpusId: details.corpusId,
          bvid: details.bvid,
        })));
      }
    } else if (
      !event.isError
      && (event.toolName === "draft_bet" || event.toolName === "draft_settle")
    ) {
      if (typeof details.draftId === "string") {
        calls.push(Promise.resolve(handlers.onEvent("draft_created", {
          kind: details.kind ?? (event.toolName === "draft_bet" ? "bet" : "settle"),
          draftId: details.draftId,
        })));
      }
    }
    return Promise.all(calls).then(() => undefined);
  }
  if (event.type === "message_update") {
    const upstream = event.assistantMessageEvent;
    if (upstream.type === "text_delta") {
      handlers.onText(upstream.delta);
      return Promise.resolve(handlers.onEvent("answer_delta", { delta: upstream.delta }));
    }
  }
  return Promise.resolve();
}

function collabSessionCwd(betId: string): string {
  return `papertable-pw-collab:${betId}`;
}

function collabSessionId(betId: string): string {
  return `pw-collab-${betId}`;
}

async function openCollabSession(repo: SessionRepo, betId: string): Promise<PiSession> {
  const cwd = collabSessionCwd(betId);
  const id = collabSessionId(betId);
  const existing = (await repo.list({ cwd })).find((session) => session.id === id);
  return existing ? repo.open(existing) : repo.create({ id, cwd });
}

function getPwCollabMessage(db: DatabaseSync, id: string): PwCollabMessageRow {
  const row = db.prepare(`
    SELECT id, bet_id, role, text, tool_calls_json, created_at
    FROM pw_collab_messages WHERE id = ?
  `).get(id) as PwCollabMessageRow | undefined;
  if (!row) throw httpError(404, "消息不存在");
  return row;
}

function requirePwSettleDraft(db: DatabaseSync, id: string): PwSettleDraftRow {
  const row = db.prepare("SELECT * FROM pw_settle_drafts WHERE id = ?").get(id) as
    | PwSettleDraftRow
    | undefined;
  if (!row) throw httpError(404, "结账草稿不存在");
  return row;
}

export function getPwSettleDraft(db: DatabaseSync, id: string): PwSettleDraftRow {
  return requirePwSettleDraft(db, id);
}

function assertToolCallsJson(value: string): void {
  if (typeof value !== "string") throw httpError(400, "tool_calls_json 必须是字符串");
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error();
  } catch {
    throw httpError(400, "tool_calls_json 必须是合法 JSON 数组");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function summarizeArgs(args: Record<string, unknown>): string {
  const parts = Object.entries(args).map(([key, value]) => {
    const rendered = typeof value === "string" ? value : JSON.stringify(value);
    return `${key}=${rendered}`;
  });
  const joined = parts.join(" ");
  return joined.length > 120 ? `${joined.slice(0, 117)}…` : joined;
}

function safeErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
