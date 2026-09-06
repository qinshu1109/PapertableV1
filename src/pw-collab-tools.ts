/**
 * TASK-PW-24：人发话写工具进表（9 exec + 1 只读查账）——exec 工具 description 以「人发话才执行：」
 * 开头，执行时必须携带当轮用户指令（instruction 缺失即 500），统一走 recordPwExecEvent 落 ai_exec 账。
 * TASK-PW-25：铸币级执行工具与冲正键进表（6 exec：settle_bet / pick_sieve_card / reject_sieve_card /
 * reject_all_and_resieve / unpick_sieve_card / void_settlement）——挑/否/结账/冲正由人发话你执行，
 * 冲正键只有两个（unpick_sieve_card / void_settlement）。
 * TASK-PW-42：方向输入进表（exec：set_sieve_direction；reject_all_and_resieve 加可选 direction）。
 * TASK-PW-45：声音提请候选卡进表（exec：promote_voice_to_card）——10 exec + 1 只读查账。
 *
 * 纪律：
 * - allow 只读工具自动执行；auto（fetch_corpus，PW-26 起）AI 自主直抓公开语料——
 *   判明需要就抓、人事后审，行为限速写进店规；draft_bet / draft_settle 只产草稿
 *   （draft_hash 固化），人确认转正。
 * - exec 工具（PW-24 起）仅在人当轮明确指令后调用，落账必带指令引用（单账原则见 TASK-PW-24 第〇节）。
 * - 冲正键语义：unpick_sieve_card 撤销挑卡（押注 void + 候选卡回 pending，同一事务）、
 *   void_settlement 作废结账（判决 void + 押注 void，可重结）——不是通用回退。
 * - 金子同步绝不进入工具表：mirror_golds 在 deny 名单中（deny 即不存在，测试断言）。
 * - 工具描述用中文，明确「只读」「只产草稿，人确认后生效」「自主执行」「人发话才执行」语义。
 */
import type { DatabaseSync } from "node:sqlite";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { httpError } from "./data.ts";
import { createPwBet, getPwBet, updatePwBetFields, type PwBetRow } from "./pw-bets.ts";
import { attachPwArtifact, detachPwArtifact, listPwArtifacts, type PwArtifactType } from "./pw-artifacts.ts";
import { freezePwDataDoc, getPwDataDoc, listPwDataDocs, listPwDataDocVersions } from "./pw-data-docs.ts";
import { getPwVerdictDetail, searchPwVerdicts, settlePwBet, voidPwSettlement } from "./pw-verdicts.ts";
// 简报 23 · 曝光自动记账：search_verdicts 工具把检索命中的判决注入模型上下文（actor=ai）
import { recordPwVerdictExposure } from "./pw-closed-loop.ts";
import {
  authorizePwCorpus,
  getPwCorpusDoc,
  listPwCorpus,
  readPwCorpusComments,
  searchPwCorpus,
} from "./pw-corpus.ts";
import { triggerPwCorpusFetch, type PwCorpusFetchTrigger } from "./pw-corpus-fetch-runner.ts";
import { mirrorConfirmedGolds } from "./pw-gold-sync.ts";
import { getPwConnectionStatus } from "./pw-connections.ts";
import { getPwSieveCard, listPwSieveCardsByStatus, pwSieveCardLabels, resieveAllPwSieve, setSieveDirection, type PwSieveCardRow, type SieveNotifier } from "./pw-sieve.ts";
import { confirmPwBetDraft, createPwBetDraft, hashPwBetDraft, rejectPwBetDraft, type PwBetDraftEdits } from "./pw-drafts.ts";
import { maybeAutoFirePwDraft } from "./pw-draft-autofire.ts";
import { listPwRuns, recordPwEvent, recordPwExecEvent, type PwEventType } from "./pw-runs.ts";
import {
  approvePwSettleDraft,
  createPwSettleDraft,
  getPwSettleDraft,
  type PwSettleRecommendation,
} from "./pw-collab.ts";
import { addPwVoiceItem } from "./pw-voice.ts";
import { promotePwVoiceToCard } from "./pw-voice-promote.ts";
import {
  listContentBets,
  pickPwSieveCard,
  rejectPwSieveCard,
  rejectAllPendingPwSieveCards,
  sortContentBetsForDisplay,
  unpickPwContentBet,
} from "./pw-content-bets.ts";
import { PW_COLLAB_GLOBAL_BET_ID } from "./pw-context.ts";

export type CollabToolPolicy = "allow" | "ask" | "draft" | "exec" | "auto";

export type CollabToolDetails = {
  summary?: string;
  kind?: "bet" | "settle";
  draftId?: string;
  hash?: string;
  corpusId?: string;
  bvid?: string;
};

export type CollabToolContext = {
  db: DatabaseSync;
  betId: string;
  /** 装配 v2 的 id → §N 编号表，同一次对话内全轮稳定。 */
  refs: ReadonlyMap<string, string>;
  /** TASK-PW-24：当轮用户消息（落库后）——exec 工具执行时缺此即 500。 */
  instruction?: { text: string; messageId: string };
  /** TASK-PW-24：筛子到达通知器（run_sieve 消费；main.ts 装配后经 runCollabTurn 传入）。 */
  sieve?: SieveNotifier;
  /** TASK-PW-26：抓取触发器（fetch_corpus 自主档消费；缺省真 triggerPwCorpusFetch，测试注入 spy）。 */
  fetchRunner?: () => PwCorpusFetchTrigger;
};

export type CollabTool = AgentHarnessTool<CollabToolContext, TSchema, CollabToolDetails> & {
  policy: CollabToolPolicy;
};

export const COLLAB_MAX_TOOL_ROUNDS = 4;

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw httpError(400, `${field} 必填`);
  return value.trim();
}

function compactJson(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json));
  } catch {
    return json;
  }
}

const emptySchema = Type.Object({});

/** TASK-PW-22：全局会话里按 betId 查卡的工具共用 schema（可选 betId 参数）。 */
const optionalBetIdSchema = Type.Object({
  betId: Type.Optional(Type.String({ description: "指定押注卡 id；缺省为当前对话的卡（全局对话时必填）。" })),
});

/**
 * TASK-PW-22：解析工具的目标押注卡——参数优先，其次当前会话卡；
 * 全局会话且未指定时返回 null（由工具回引导语，不抛错）。
 */
function resolveToolBetId(context: CollabToolContext, args: { betId?: unknown }): string | null {
  const explicit = optionalText(args.betId);
  if (explicit) return explicit;
  return context.betId === PW_COLLAB_GLOBAL_BET_ID ? null : context.betId;
}

/** 全局会话未指定押注卡时的引导语。 */
function needBetIdText() {
  return {
    content: [{
      type: "text" as const,
      text: "当前是全局对话，未指定押注卡。可先用 list_content_bets 或 list_sieve_cards 找到目标卡，再用 betId 参数指定。",
    }],
    details: { summary: "未指定押注卡（全局对话）" },
  };
}

/**
 * TASK-PW-24：exec 工具守门——当轮用户指令缺失即 500（不该发生，发生了说明装配漏了）。
 * 返回 { text, messageId }，供记账复用（同一轮只取一次）。
 */
function requireExecInstruction(context: CollabToolContext): { text: string; messageId: string } {
  const instruction = context.instruction;
  if (
    !instruction
    || typeof instruction.text !== "string"
    || !instruction.text.trim()
    || typeof instruction.messageId !== "string"
    || !instruction.messageId.trim()
  ) {
    throw httpError(500, "exec 工具缺少当轮用户指令（装配漏注入 instruction）");
  }
  return { text: instruction.text.trim(), messageId: instruction.messageId };
}

/**
 * TASK-PW-24：exec 工具统一落账——一条 ai_exec 行（kind 固定 ai_exec、actor 固定 ai），
 * 带当轮指令两列；betId 缺省用当前会话卡，可显式覆盖（null 表示与押注无关）。
 */
function recordExecEvent(
  context: CollabToolContext,
  eventType: PwEventType,
  payload: Record<string, unknown>,
  relatedIds?: readonly string[],
  betId?: string | null,
): void {
  const instruction = requireExecInstruction(context);
  recordPwExecEvent(context.db, {
    eventType,
    instructionText: instruction.text,
    instructionMessageId: instruction.messageId,
    payloadJson: JSON.stringify(payload),
    relatedIds: relatedIds ?? [],
    betId: betId !== undefined ? betId : context.betId,
  });
}

/** 解析 payload（损坏按空对象，不阻断查账）。 */
function safeJson(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/** TASK-PW-24：查账——ai_exec/ai_draft/ai_auto（PW-26 自主档也入查账）倒序合并，默认 20。 */
function listActionRuns(db: DatabaseSync, limit: number) {
  const execRows = listPwRuns(db, { kind: "ai_exec", limit });
  const draftRows = listPwRuns(db, { kind: "ai_draft", limit });
  const autoRows = listPwRuns(db, { kind: "ai_auto", limit });
  return [...execRows, ...draftRows, ...autoRows]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit);
}

const EXEC_ACTION_LABELS: Record<string, string> = {
  confirm: "确认草稿",
  reject: "驳回草稿",
  create: "新建押注",
  edit: "修改押注",
  freeze: "冻结数据文档",
  sieve_run: "触发筛子",
  voice: "录入声音",
  attach: "挂/摘产出物",
  draft: "起草",
  fetch_propose: "提议抓取",
  // TASK-PW-25：铸币级动作
  settle: "结账",
  undo: "冲正",
  // TASK-PW-26：自主档（ai_auto 账；无指令引用，查账行显示「自主」）
  corpus: "自主抓取语料",
};

const readBetTool: CollabTool = {
  name: "read_bet",
  label: "read bet",
  policy: "allow",
  description: "只读：查看押注卡全文（标题/假设/验证指标/指标目标/置信度/数据来源/结账日/状态）以及已挂载的产出物列表；缺省为当前对话的卡，可用 betId 指定。",
  parameters: optionalBetIdSchema,
  async execute(_toolCallId, args, _signal, _onUpdate, context) {
    const betId = resolveToolBetId(context, args);
    if (!betId) return needBetIdText();
    const bet = getPwBet(context.db, betId);
    if (!bet) throw httpError(404, "押注不存在");
    const artifacts = listPwArtifacts(context.db, betId);
    const lines = [
      `标题：${bet.title}`,
      `假设：${bet.thesis}`,
      `验证指标：${bet.metric ?? "—"}（目标：${bet.metric_target ?? "—"}）`,
      `置信度：${bet.confidence ?? "—"}%`,
      `数据来源：${bet.data_source_plan ?? "—"}`,
      `结账日：${bet.checkout_date ?? "—"}`,
      `状态：${bet.status}`,
      `产出物：${artifacts.length === 0 ? "无" : ""}`,
      ...artifacts.map((artifact) => `- [${artifact.type}] ${artifact.platform}：${artifact.title ?? artifact.url ?? artifact.id}`),
    ];
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { summary: `押注「${bet.title}」，产出物 ${artifacts.length} 个` },
    };
  },
};

const readDataDocsTool: CollabTool = {
  name: "read_data_docs",
  label: "read data docs",
  policy: "allow",
  description: "只读：本押注已回流的数据文档，按采集时间正序（菜号牌 文档 N + id/平台/指标 JSON/版本/采集时间）——结账指认证据时用这里的文档 id。",
  parameters: emptySchema,
  async execute(_toolCallId, _args, _signal, _onUpdate, context) {
    const docs = listPwDataDocs(context.db, context.betId)
      .slice()
      .sort((a, b) =>
        a.collected_at.localeCompare(b.collected_at)
        || a.created_at.localeCompare(b.created_at)
      );
    const text = docs.length === 0
      ? "本押注暂无数据文档。"
      : docs.map((doc, index) =>
        `- [文档 ${index + 1}·${doc.id}] [${doc.platform}] 采集 ${doc.collected_at} v${doc.version}：${compactJson(doc.metrics_json)}`
      ).join("\n");
    return {
      content: [{ type: "text", text }],
      details: { summary: `数据文档 ${docs.length} 条` },
    };
  },
};

const searchVerdictsSchema = Type.Object({
  q: Type.String({ description: "检索关键词，匹配金子的 lesson 或墓碑的 cause_of_death。" }),
});

const searchVerdictsTool: CollabTool = {
  name: "search_verdicts",
  label: "search verdicts",
  policy: "allow",
  description: "只读：在已确认的金子与墓碑中检索，结果带 §N 编号（与注入上下文一致）。引用时用 §N 标注。",
  parameters: searchVerdictsSchema,
  async execute(_toolCallId, { q }, _signal, _onUpdate, context) {
    const query = requiredText(q, "q");
    const rows = searchPwVerdicts(context.db, query);
    // 简报 23 · 曝光自动记账：工具结果（非 void 判决）注入模型上下文，actor=ai
    recordPwVerdictExposure(context.db, {
      surface: "collab_tool",
      betId: context.betId,
      verdictIds: rows.filter((row) => row.outcome !== "void").map((row) => row.id),
      actor: "ai",
    });
    const lines: string[] = [];
    for (const row of rows) {
      if (row.outcome === "void") continue;
      const ref = context.refs.get(row.id);
      const kind = row.outcome === "gold" ? "金子" : "墓碑";
      const text = row.outcome === "gold" ? row.lesson : row.cause_of_death;
      const prefix = ref ? `${ref} ` : "";
      lines.push(`${prefix}[${kind}·${row.id}] ${text ?? ""}`);
    }
    return {
      content: [{
        type: "text",
        text: lines.length === 0 ? "没有匹配的已确认判决。" : lines.join("\n"),
      }],
      details: { summary: `命中 ${lines.length} 条判决` },
    };
  },
};

const searchCorpusSchema = Type.Object({
  q: Type.String({ description: "检索关键词，匹配已抓取视频的评论内容。" }),
});

const searchCorpusTool: CollabTool = {
  name: "search_corpus",
  label: "search corpus",
  policy: "allow",
  description: "只读：在已抓取的语料评论中检索，返回 bvid / UP主 / 点赞 / 命中片段。",
  parameters: searchCorpusSchema,
  async execute(_toolCallId, { q }, _signal, _onUpdate, context) {
    const query = requiredText(q, "q");
    const hits = searchPwCorpus(context.db, query);
    const text = hits.length === 0
      ? "语料中未命中相关评论。"
      : hits.map((hit) => `${hit.bvid} @${hit.uname ?? "匿名"}（赞 ${hit.like ?? 0}）：${hit.snippet}`).join("\n");
    return {
      content: [{ type: "text", text }],
      details: { summary: `语料命中 ${hits.length} 条` },
    };
  },
};

const readVoiceTool: CollabTool = {
  name: "read_voice",
  label: "read voice",
  policy: "allow",
  description: "只读：指定押注卡关联产出物的观众声音（含分拣信号类型 signal_type；已丢弃条目不显示）；缺省为当前对话的卡，可用 betId 指定；全局会话（或不绑定卡）时列出全部未丢弃声音（含不挂卡的游离条目，带完整 voiceId），供指认后 promote_voice_to_card 提请。",
  parameters: optionalBetIdSchema,
  async execute(_toolCallId, args, _signal, _onUpdate, context) {
    const betId = resolveToolBetId(context, args);
    // TASK-PW-45：全局模式——无卡上下文时列出全部未丢弃声音（含游离），提请链的指认入口
    if (!betId || betId === "global") {
      const rows = context.db.prepare(`
        SELECT id, platform, content, captured_at, signal_type, promoted_to_draft_id
        FROM pw_voice_items
        WHERE dropped_reason IS NULL
        ORDER BY captured_at DESC, id
        LIMIT 50
      `).all() as Array<{
        id: string;
        platform: string;
        content: string;
        captured_at: string;
        signal_type: string | null;
        promoted_to_draft_id: string | null;
      }>;
      const text = rows.length === 0
        ? "观众声音表暂无条目。"
        : rows.map((row) =>
          `[voiceId=${row.id}｜${row.platform}｜${row.signal_type ?? "未分拣"}${row.promoted_to_draft_id ? "｜已提请" : ""}] ${row.content}`
        ).join("\n");
      return {
        content: [{ type: "text", text }],
        details: { summary: `观众声音（全局）${rows.length} 条` },
      };
    }
    const rows = context.db.prepare(`
      SELECT v.id, v.platform, v.content, v.captured_at, v.signal_type,
             a.type AS artifact_type, a.title AS artifact_title
      FROM pw_voice_items v
      JOIN pw_artifacts a ON a.id = v.artifact_id
      WHERE a.bet_id = ? AND a.detached_at IS NULL AND v.dropped_reason IS NULL
      ORDER BY v.captured_at, v.id
    `).all(betId) as Array<{
      id: string;
      platform: string;
      content: string;
      captured_at: string;
      signal_type: string | null;
      artifact_type: string;
      artifact_title: string | null;
    }>;
    const text = rows.length === 0
      ? "本押注尚无关联观众声音。"
      : rows.map((row) =>
        `[${row.platform}/${row.artifact_type}] ${row.signal_type ?? "未分拣"}：${row.content}`
      ).join("\n");
    return {
      content: [{ type: "text", text }],
      details: { summary: `观众声音 ${rows.length} 条` },
    };
  },
};

// ---- TASK-PW-21：对话深挖只读工具（全 allow，消费 PW-17/PW-18 读函数）----

const listCorpusTool: CollabTool = {
  name: "list_corpus",
  label: "list corpus",
  policy: "allow",
  description: "只读：列出语料库中已登记抓取的视频清单（bvid/标题/UP主/状态/评论数/抓取时间）。",
  parameters: emptySchema,
  async execute(_toolCallId, _args, _signal, _onUpdate, context) {
    const rows = listPwCorpus(context.db);
    const text = rows.length === 0
      ? "语料库暂无已登记的视频。"
      : rows.map((row) =>
        `- ${row.bvid} ${row.title ?? "（无标题）"} @${row.up_name ?? "?"} 状态=${row.status} 评论=${row.comment_count ?? 0} 抓取=${row.fetched_at ?? "—"}`
      ).join("\n");
    return {
      content: [{ type: "text", text }],
      details: { summary: `语料条目 ${rows.length} 条` },
    };
  },
};

const readCorpusDocSchema = Type.Object({
  bvid: Type.String({ description: "B 站视频 BV 号。" }),
});

const readCorpusDocTool: CollabTool = {
  name: "read_corpus_doc",
  label: "read corpus doc",
  policy: "allow",
  description: "只读：读取某条语料视频的完整详情（标题/UP主/状态/评论数/抓取时间 + video_stat 播放/弹幕/评论/收藏/投币/分享/点赞七项）。",
  parameters: readCorpusDocSchema,
  async execute(_toolCallId, { bvid }, _signal, _onUpdate, context) {
    const doc = getPwCorpusDoc(context.db, requiredText(bvid, "bvid"));
    const stat = doc.video_stat
      ? Object.entries(doc.video_stat).map(([key, value]) => `${key}=${value}`).join(" ")
      : "—";
    const lines = [
      `bvid：${doc.bvid}`,
      `标题：${doc.title ?? "—"}`,
      `UP主：${doc.up_name ?? "—"}`,
      `状态：${doc.status}`,
      `评论数：${doc.comment_count ?? "—"}`,
      `抓取时间：${doc.fetched_at ?? "—"}`,
      `video_stat：${stat}`,
    ];
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { summary: `语料 ${doc.bvid}（${doc.title ?? "无标题"}）` },
    };
  },
};

const readCorpusCommentsSchema = Type.Object({
  bvid: Type.String({ description: "B 站视频 BV 号。" }),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "分页偏移，默认 0。" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "分页条数（正整数），缺省返回全部。" })),
});

const readCorpusCommentsTool: CollabTool = {
  name: "read_corpus_comments",
  label: "read corpus comments",
  policy: "allow",
  description: "只读：分页读取某条已抓取视频的评论全文（含 rpid/评论时间 ctime/楼中楼回复数 replies）。",
  parameters: readCorpusCommentsSchema,
  async execute(_toolCallId, { bvid, offset, limit }, _signal, _onUpdate, context) {
    const comments = readPwCorpusComments(context.db, requiredText(bvid, "bvid"), {
      offset: offset == null ? 0 : Number(offset),
      limit: limit == null ? undefined : Number(limit),
    });
    const text = comments.length === 0
      ? "该视频暂无评论。"
      : comments.map((comment) =>
        `- [rpid=${comment.rpid ?? "—"}] @${comment.uname ?? "匿名"}（赞 ${comment.like ?? 0}，ctime=${comment.ctime ?? "—"}，回复 ${comment.replies ?? 0}）：${comment.message}`
      ).join("\n");
    return {
      content: [{ type: "text", text }],
      details: { summary: `评论 ${comments.length} 条` },
    };
  },
};

const readDocVersionsTool: CollabTool = {
  name: "read_doc_versions",
  label: "read doc versions",
  policy: "allow",
  description: "只读：指定押注卡数据文档的完整版本链历史（version 正序，含 method/冻结/采集时间/指标摘要）；缺省为当前对话的卡，可用 betId 指定。",
  parameters: optionalBetIdSchema,
  async execute(_toolCallId, args, _signal, _onUpdate, context) {
    const betId = resolveToolBetId(context, args);
    if (!betId) return needBetIdText();
    const rows = listPwDataDocVersions(context.db, { betId });
    const text = rows.length === 0
      ? "本押注暂无数据文档版本。"
      : rows.map((row) =>
        `- v${row.version} [${row.platform}] 采集 ${row.collected_at}（${row.method}${row.frozen ? "，已冻结" : ""}）：${compactJson(row.metrics_json)}`
      ).join("\n");
    return {
      content: [{ type: "text", text }],
      details: { summary: `版本链 ${rows.length} 条` },
    };
  },
};

const readVerdictEvidenceSchema = Type.Object({
  id: Type.String({ description: "判决 id（金子的 lesson 或墓碑的 cause_of_death）。" }),
});

const readVerdictEvidenceTool: CollabTool = {
  name: "read_verdict_evidence",
  label: "read verdict evidence",
  policy: "allow",
  description: "只读：查看某条判决的详情——判决正文 + 证据链（数据文档摘要）+ 来源押注标题。",
  parameters: readVerdictEvidenceSchema,
  async execute(_toolCallId, { id }, _signal, _onUpdate, context) {
    const detail = getPwVerdictDetail(context.db, requiredText(id, "id"));
    const kind = detail.outcome === "gold" ? "金子" : detail.outcome === "tomb" ? "墓碑" : "void";
    const lines = [
      `判决：${detail.id}（${kind}）`,
      `来源押注：${detail.bet_title ?? "—"}`,
      `正文：${detail.outcome === "gold" ? detail.lesson : detail.cause_of_death ?? ""}`,
      `置信度快照：${detail.confidence_snapshot ?? "—"}%`,
      `结账时间：${detail.decided_at}`,
      `证据链：${detail.evidence_docs.length === 0 ? "无" : ""}`,
      ...detail.evidence_docs.map((doc) => `- [${doc.platform}] 采集 ${doc.collected_at}：${doc.metrics}`),
    ];
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { summary: `判决 ${detail.id}（${detail.outcome}）` },
    };
  },
};

const readConnectionsTool: CollabTool = {
  name: "read_connections",
  label: "read connections",
  policy: "allow",
  description: "只读：查看各平台连接状态（status/最近同步时间 last_sync_at/风险事件列表）。",
  parameters: emptySchema,
  async execute(_toolCallId, _args, _signal, _onUpdate, context) {
    const view = getPwConnectionStatus(context.db);
    const rows = Array.isArray(view) ? view : [view];
    const text = rows.length === 0
      ? "暂无已登记的平台连接。"
      : rows.map((conn) =>
        `- [${conn.platform}] ${conn.account_label ?? "无标签"} 状态=${conn.status} 最近同步=${conn.last_sync_at ?? "—"}`
        + (conn.risk_events.length > 0
          ? ` 风险事件：${conn.risk_events.map((event) => `${event.at} ${event.reason}`).join("；")}`
          : "")
      ).join("\n");
    return {
      content: [{ type: "text", text }],
      details: { summary: `连接 ${rows.length} 个` },
    };
  },
};

const listSieveCardsSchema = Type.Object({
  status: Type.Optional(Type.Union([
    Type.Literal("pending"),
    Type.Literal("picked"),
    Type.Literal("edited"),
    Type.Literal("rejected"),
  ], { description: "按状态过滤，缺省返回全部候选卡。" })),
});

const listSieveCardsTool: CollabTool = {
  name: "list_sieve_cards",
  label: "list sieve cards",
  policy: "allow",
  description: "只读：列出筛子候选卡（菜号牌 证据 N/少数派 N 与协作台屏幕徽标同源 + 引文原文/scale·hook·freshness 四字段/sort_score/status）；wildcard（少数派）另置一区不参与排序；指认挑否时请带 status='pending' 过滤以对准屏幕序号。",
  parameters: listSieveCardsSchema,
  async execute(_toolCallId, { status }, _signal, _onUpdate, context) {
    const rows = listPwSieveCardsByStatus(
      context.db,
      status as PwSieveCardRow["status"] | undefined,
    );
    // TASK-PW-27：菜号牌——序号=返回列表内按 kind 分区的相对序（与装配/屏幕同源）
    const labels = pwSieveCardLabels(rows);
    const text = rows.length === 0
      ? "暂无候选卡。"
      : rows.map((card) => {
        return `- [${labels.get(card.id)}·${card.id}] 「${card.quote_text}」`
          + `（scale=${card.scale_value}${card.scale_note ? ` ${card.scale_note}` : ""}，`
          + `hook=${card.hook_note ?? "—"}，freshness=${card.freshness_note ?? "—"}，`
          + `score=${card.sort_score}，status=${card.status}）`;
      }).join("\n");
    return {
      content: [{ type: "text", text }],
      details: { summary: `候选卡 ${rows.length} 张` },
    };
  },
};

const readSieveCardSchema = Type.Object({
  id: Type.String({ description: "候选卡 id。" }),
});

const readSieveCardTool: CollabTool = {
  name: "read_sieve_card",
  label: "read sieve card",
  policy: "allow",
  description: "只读：查看某张候选卡的完整详情——引文原文 + quote_source 出处 JSON 全量 + scale/hook/freshness 四字段 + sort_score/status。",
  parameters: readSieveCardSchema,
  async execute(_toolCallId, { id }, _signal, _onUpdate, context) {
    const card = getPwSieveCard(context.db, requiredText(id, "id"));
    const lines = [
      `候选卡：${card.id}`,
      `kind：${card.kind}${card.kind === "wildcard" ? "（少数派）" : ""}`,
      `引文原文：${card.quote_text}`,
      `引文出处（quote_source）：${compactJson(card.quote_source_json)}`,
      `规模：${card.scale_value}${card.scale_note ? `（${card.scale_note}）` : ""}`,
      `挂钩点：${card.hook_note ?? "—"}`,
      `新鲜度：${card.freshness_note ?? "—"}`,
      `sort_score：${card.sort_score}`,
      `状态：${card.status}`,
      `创建时间：${card.created_at}`,
    ];
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { summary: `候选卡 ${card.id}（${card.kind}）` },
    };
  },
};

const fetchCorpusSchema = Type.Object({
  bvid: Type.String({ description: "B 站视频 BV 号，形如 BV1xx411c7mD（10 位数字/字母）。" }),
  reason: Type.Optional(Type.String({ description: "抓取依据（自主说明：为什么这条值得抓）。" })),
});

const fetchCorpusTool: CollabTool = {
  name: "fetch_corpus",
  label: "fetch corpus",
  policy: "auto",
  description: "自主执行：直接抓取某条 B 站视频的公开数据与评论进语料库（不需人批准，人事后审）。判明确有需要才抓；限速纪律——调用前可用 read_connections 看风控信号，有风控/限速迹象就少抓、慢抓或暂停并说明；撞墙（needs_human）立即停手交人。执行后落一条 ai_auto 自主账。",
  parameters: fetchCorpusSchema,
  async execute(_toolCallId, { bvid, reason }, _signal, _onUpdate, context) {
    const { doc, existed } = authorizePwCorpus(context.db, { bvid }, { actor: "ai" });
    if (existed) {
      return {
        content: [{
          type: "text",
          text: `该 BV 已有语料条目（status=${doc.status}），不重复抓取；如需重抓请人来操作（force）。`,
        }],
        details: { summary: `语料已存在 ${doc.bvid}（${doc.status}）`, corpusId: doc.id, bvid: doc.bvid },
      };
    }
    const trigger = (context.fetchRunner ?? triggerPwCorpusFetch)();
    // TASK-PW-26：自主档账——kind=ai_auto、actor=ai、无指令引用（PW-27 擅自发动断言只扫 ai_exec）
    recordPwEvent(context.db, {
      kind: "ai_auto",
      eventType: "corpus",
      actor: "ai",
      betId: context.betId,
      relatedIds: [doc.id],
      payloadJson: JSON.stringify({
        corpusId: doc.id,
        bvid: doc.bvid,
        reason: optionalText(reason),
        runnerStarted: trigger.started,
        runnerReason: trigger.reason ?? null,
      }),
    });
    const text = trigger.started
      ? `已自主登记并启动抓取 ${doc.bvid}（抓取器单飞运行中，完成后语料自动入库、筛子会补筛）。人事后可在数据源屏审。`
      : `已自主登记 ${doc.bvid} 进抓取队列，但抓取器未启动（${trigger.reason ?? "未知原因"}）——可人工补跑：ego-browser nodejs < scripts/pw-fetch-bili-corpus.js`;
    return {
      content: [{ type: "text", text }],
      details: { summary: `自主抓取 ${doc.bvid}${trigger.started ? "" : "（抓取器未启动）"}`, corpusId: doc.id, bvid: doc.bvid },
    };
  },
};

const draftBetSchema = Type.Object({
  title: Type.String({ description: "押注标题（必填）。" }),
  thesis: Type.String({ description: "押注假设（必填）。" }),
  metric: Type.Optional(Type.String({ description: "验证指标。" })),
  metricTarget: Type.Optional(Type.String({ description: "指标目标。" })),
  confidence: Type.Optional(Type.Integer({ minimum: 0, maximum: 100, description: "置信度，0–100 整数。" })),
  dataSourcePlan: Type.Optional(Type.String({ description: "数据来源计划。" })),
  checkoutDate: Type.Optional(Type.String({ description: "结账日 YYYY-MM-DD。" })),
  goldRefs: Type.Optional(Type.Array(Type.String(), { description: "引用的金子 id 列表。" })),
  kind: Type.Optional(Type.Union([
    Type.Literal("verdict"),
    Type.Literal("content"),
  ], { description: "内容向押注（选题/视频/直播）用 content；判断/生活向缺省 verdict。" })),
  sourceCardId: Type.Optional(Type.String({ description: "仅 kind='content' 时可用，取值 pw_sieve_cards 行 id；从候选卡聊出的草稿必须带上。" })),
});

const draftBetTool: CollabTool = {
  name: "draft_bet",
  label: "draft bet",
  policy: "draft",
  description: "起草押注：只创建押注草稿（draft 态，draft_hash 固化）。起草内容向押注（选题、视频、直播选题）必须传 kind='content'，否则确认后不会出现在协作台在途押注 rail。用户明确说「确认/转正」时，用 confirm_bet_draft 执行。",
  parameters: draftBetSchema,
  async execute(_toolCallId, args, _signal, _onUpdate, context) {
    const kind = args.kind ?? "verdict";
    const sourceCardId = optionalText(args.sourceCardId);
    const draft = createPwBetDraft(context.db, {
      title: requiredText(args.title, "title"),
      thesis: requiredText(args.thesis, "thesis"),
      metric: optionalText(args.metric),
      metricTarget: optionalText(args.metricTarget),
      confidence: args.confidence == null ? undefined : Number(args.confidence),
      dataSourcePlan: optionalText(args.dataSourcePlan),
      checkoutDate: optionalText(args.checkoutDate),
      goldRefs: Array.isArray(args.goldRefs) ? args.goldRefs : [],
      kind,
      sourceCardId,
    }, "collab-ai");
    const row = getPwBet(context.db, draft.id)!;
    const hash = hashPwBetDraft(betDraftContent(row));
    recordPwEvent(context.db, {
      kind: "ai_draft",
      eventType: "draft",
      actor: "ai",
      betId: draft.id,
      relatedIds: [draft.id],
      payloadJson: JSON.stringify({
        draftId: draft.id,
        hash,
        title: draft.title,
        source: "collab-ai",
        kind,
        sourceCardId,
      }),
    });
    const note = kind === "content"
      ? "内容押注草稿——确认转正后会上协作台在途 rail。"
      : "";
    return {
      content: [{ type: "text", text: `已起草押注草稿「${draft.title}」（草稿 id ${draft.id}）。${note}草稿已固化——用户说「确认」时用 confirm_bet_draft 转正。` }],
      details: { summary: `已起草押注草稿「${draft.title}」`, kind: "bet", draftId: draft.id, hash },
    };
  },
};

const draftSettleSchema = Type.Object({
  recommendation: Type.Union([
    Type.Literal("settle_gold"),
    Type.Literal("settle_tomb"),
    Type.Literal("wait"),
  ], { description: "结账建议：settle_gold（铸金）/ settle_tomb（立碑）/ wait（再等等）。" }),
  lesson: Type.Optional(Type.String({ description: "铸金时建议写入的 lesson。" })),
  cause_of_death: Type.Optional(Type.String({ description: "立碑时建议的死因。" })),
  note: Type.Optional(Type.String({ description: "补充备注。" })),
});

const draftSettleTool: CollabTool = {
  name: "draft_settle",
  label: "draft settle",
  policy: "draft",
  description: "起草结账建议：只创建结账建议草稿（draft_hash 固化）。",
  parameters: draftSettleSchema,
  async execute(_toolCallId, args, _signal, _onUpdate, context) {
    const recommendation = args.recommendation as PwSettleRecommendation;
    const draft = createPwSettleDraft(context.db, context.betId, {
      recommendation,
      lesson: optionalText(args.lesson),
      cause_of_death: optionalText(args.cause_of_death),
      note: optionalText(args.note),
    });
    recordPwEvent(context.db, {
      kind: "ai_draft",
      eventType: "draft",
      actor: "ai",
      betId: context.betId,
      relatedIds: [draft.id],
      payloadJson: JSON.stringify({ draftId: draft.id, hash: draft.draft_hash, recommendation }),
    });
    return {
      content: [{ type: "text", text: `已起草结账建议（${recommendation}，草案 id ${draft.id}）。草案已固化——用户说「确认结账」时用 settle_bet 一步结掉。` }],
      details: { summary: `已起草结账建议（${recommendation}）`, kind: "settle", draftId: draft.id },
    };
  },
};

/** TASK-PW-22：全局证据——在途内容押注卡清单（只读）。 */
const listContentBetsTool: CollabTool = {
  name: "list_content_bets",
  label: "list content bets",
  policy: "allow",
  description: "只读：列出全部内容押注卡（不含作废）——菜号牌 注 N（与协作台 rail 徽标同源）/标题/状态/转化信号与目标/看结果日/id；全局对话里定位某张卡后用 read_bet(betId) 看全文。",
  parameters: emptySchema,
  async execute(_toolCallId, _args, _signal, _onUpdate, context) {
    // TASK-PW-27：菜号牌「注 N」——与 rail 同排序（sortContentBetsForDisplay）
    const rows = sortContentBetsForDisplay(listContentBets(context.db));
    const text = rows.length === 0
      ? "还没有内容押注卡。"
      : rows.map((bet, index) =>
        `- [注 ${index + 1}·${bet.id}] ${bet.title}｜状态=${bet.status}｜转化信号：${bet.metric ?? "—"}（目标 ${bet.metric_target ?? "—"}）｜看结果日：${bet.checkout_date ?? "—"}`
      ).join("\n");
    return {
      content: [{ type: "text", text }],
      details: { summary: `内容押注卡 ${rows.length} 张` },
    };
  },
};

// ---- TASK-PW-24：人发话写工具（exec policy，description 以「人发话才执行：」开头）----

/** 押注字段编辑 schema（confirm_bet_draft.edits 与 edit_bet.fields 共用）。 */
const betFieldEditsSchema = Type.Object({
  title: Type.Optional(Type.String({ description: "标题。" })),
  thesis: Type.Optional(Type.String({ description: "押注假设。" })),
  metric: Type.Optional(Type.String({ description: "验证指标。" })),
  metricTarget: Type.Optional(Type.String({ description: "指标目标。" })),
  confidence: Type.Optional(Type.Integer({ minimum: 0, maximum: 100, description: "置信度，0–100 整数。" })),
  dataSourcePlan: Type.Optional(Type.String({ description: "数据来源计划。" })),
  checkoutDate: Type.Optional(Type.String({ description: "结账日 YYYY-MM-DD。" })),
});

const confirmBetDraftSchema = Type.Object({
  draftId: Type.String({ description: "押注草稿 id（草稿 A）。" }),
  edits: Type.Optional(betFieldEditsSchema),
});

const confirmBetDraftTool: CollabTool = {
  name: "confirm_bet_draft",
  label: "confirm bet draft",
  policy: "exec",
  description: "人发话才执行：把指定押注草稿转正为 pending 押注（草稿三行赌注不齐会拒绝转正）；可在转正同时修改字段；执行后落一条 ai_exec 审计账。",
  parameters: confirmBetDraftSchema,
  async execute(_toolCallId, { draftId, edits }, _signal, _onUpdate, context) {
    requireExecInstruction(context);
    const normalizedEdits = edits ?? {};
    const bet = confirmPwBetDraft(
      context.db,
      requiredText(draftId, "draftId"),
      normalizedEdits as PwBetDraftEdits,
      "ai",
    );
    recordExecEvent(context, "confirm", {
      draftId: bet.id,
      betId: bet.id,
      edits: normalizedEdits as Record<string, unknown>,
    }, undefined, bet.id);
    // TASK-PW-33：押注确认成立后自动起草（fire-and-forget，不阻塞确认响应；守卫由发动函数把关）
    void maybeAutoFirePwDraft(context.db, bet.id, { trigger: "confirm_bet_draft" });
    return {
      content: [{ type: "text", text: `已按你的指令把草稿「${bet.title}」转正为待结账押注（id ${bet.id}）。` }],
      details: { summary: `已确认草稿「${bet.title}」`, kind: "bet", draftId: bet.id },
    };
  },
};

const rejectBetDraftSchema = Type.Object({
  draftId: Type.String({ description: "押注草稿 id（草稿 A）。" }),
  reason: Type.Optional(Type.String({ description: "驳回理由（可选，缺省记「用户指令驳回」）。" })),
});

const rejectBetDraftTool: CollabTool = {
  name: "reject_bet_draft",
  label: "reject bet draft",
  policy: "exec",
  description: "人发话才执行：把指定押注草稿作废（status→void），可附驳回理由；执行后落一条 ai_exec 审计账。",
  parameters: rejectBetDraftSchema,
  async execute(_toolCallId, { draftId, reason }, _signal, _onUpdate, context) {
    requireExecInstruction(context);
    const reasonText = optionalText(reason) ?? "用户指令驳回";
    const bet = rejectPwBetDraft(context.db, requiredText(draftId, "draftId"), reasonText, "ai");
    recordExecEvent(context, "reject", { draftId: bet.id, reason: bet.reason }, undefined, bet.id);
    return {
      content: [{ type: "text", text: `已按你的指令驳回草稿「${bet.title}」（作废，reason=${bet.reason}）。` }],
      details: { summary: `已驳回草稿「${bet.title}」`, kind: "bet", draftId: bet.id },
    };
  },
};

const createBetSchema = Type.Object({
  title: Type.String({ description: "押注标题（必填）。" }),
  thesis: Type.String({ description: "押注假设（必填）。" }),
  metric: Type.Optional(Type.String({ description: "验证指标。" })),
  metricTarget: Type.Optional(Type.String({ description: "指标目标。" })),
  confidence: Type.Optional(Type.Integer({ minimum: 0, maximum: 100, description: "置信度，0–100 整数。" })),
  dataSourcePlan: Type.Optional(Type.String({ description: "数据来源计划。" })),
  checkoutDate: Type.Optional(Type.String({ description: "结账日 YYYY-MM-DD。" })),
});

const createBetTool: CollabTool = {
  name: "create_bet",
  label: "create bet",
  policy: "exec",
  description: "人发话才执行：新建一条押注——验证指标/数据来源/结账日三行齐全落 pending，三行不齐只能落 draft（草稿态，需另行确认转正）；执行后落一条 ai_exec 审计账。",
  parameters: createBetSchema,
  async execute(_toolCallId, args, _signal, _onUpdate, context) {
    requireExecInstruction(context);
    const metric = optionalText(args.metric);
    const dataSourcePlan = optionalText(args.dataSourcePlan);
    const checkoutDate = optionalText(args.checkoutDate);
    const status = metric && dataSourcePlan && checkoutDate ? "pending" : "draft";
    const bet = createPwBet(context.db, {
      title: requiredText(args.title, "title"),
      thesis: requiredText(args.thesis, "thesis"),
      metric,
      metricTarget: optionalText(args.metricTarget),
      confidence: args.confidence == null ? undefined : Number(args.confidence),
      dataSourcePlan,
      checkoutDate,
      status,
      createdFrom: "collab-ai",
    });
    recordExecEvent(context, "create", { betId: bet.id, title: bet.title, status: bet.status }, undefined, bet.id);
    return {
      content: [{ type: "text", text: `已按你的指令新建押注「${bet.title}」（状态 ${bet.status}，id ${bet.id}）。` }],
      details: { summary: `已新建押注「${bet.title}」`, kind: "bet", draftId: bet.status === "draft" ? bet.id : undefined },
    };
  },
};

const editBetSchema = Type.Object({
  betId: Type.Optional(Type.String({ description: "押注 id；缺省为当前对话的卡（全局对话时必填）。" })),
  fields: betFieldEditsSchema,
});

const editBetTool: CollabTool = {
  name: "edit_bet",
  label: "edit bet",
  policy: "exec",
  description: "人发话才执行：修改指定押注的字段——仅 draft/pending 态可编辑，settled/void 拒绝（409）；只改传入字段；betId 缺省为当前对话的卡；执行后落一条 ai_exec 审计账（payload 带改动字段名）。",
  parameters: editBetSchema,
  async execute(_toolCallId, { betId, fields }, _signal, _onUpdate, context) {
    requireExecInstruction(context);
    const id = resolveToolBetId(context, { betId });
    if (!id) throw httpError(400, "全局对话需显式 betId（指认规矩：先说清改哪张卡）");
    const edits = fields ?? {};
    const changed = Object.keys(edits).filter((key) => edits[key] !== undefined);
    const bet = updatePwBetFields(context.db, id, edits);
    recordExecEvent(context, "edit", { betId: id, changedFields: changed }, undefined, id);
    return {
      content: [{ type: "text", text: `已按你的指令修改押注「${bet.title}」（改动字段：${changed.join("、") || "无"}）。` }],
      details: { summary: `已修改押注「${bet.title}」`, kind: "bet" },
    };
  },
};

const freezeDataDocSchema = Type.Object({
  docId: Type.String({ description: "数据文档 id。" }),
});

const freezeDataDocTool: CollabTool = {
  name: "freeze_data_doc",
  label: "freeze data doc",
  policy: "exec",
  description: "人发话才执行：冻结指定数据文档（该押注该平台的整条版本链从此不可再追加版本）；执行后落一条 ai_exec 审计账。",
  parameters: freezeDataDocSchema,
  async execute(_toolCallId, { docId }, _signal, _onUpdate, context) {
    requireExecInstruction(context);
    const id = requiredText(docId, "docId");
    const doc = getPwDataDoc(context.db, id);
    freezePwDataDoc(context.db, id);
    recordExecEvent(context, "freeze", { docId: id, betId: doc.bet_id, platform: doc.platform }, undefined, doc.bet_id);
    return {
      content: [{ type: "text", text: `已按你的指令冻结数据文档 ${id}（${doc.platform}，后续版本不可追加）。` }],
      details: { summary: `已冻结数据文档 ${id}` },
    };
  },
};

const runSieveTool: CollabTool = {
  name: "run_sieve",
  label: "run sieve",
  policy: "exec",
  description: "人发话才执行：立即触发一轮筛子 run（绕过安静窗的手动触发语义；当前无待筛新到达时返回空 runId；筛子运行中会拒绝 409）。执行后另落一条 ai_exec 指令账（机制账由筛子自记）。",
  parameters: emptySchema,
  async execute(_toolCallId, _args, _signal, _onUpdate, context) {
    requireExecInstruction(context);
    const sieve = context.sieve;
    if (!sieve) throw httpError(500, "筛子运行器未注入（exec 工具装配缺 sieve）");
    const result = await sieve.flushNow();
    recordExecEvent(context, "sieve_run", { runId: result.runId }, undefined, null);
    const text = result.runId
      ? `已按你的指令触发筛子 run（runId ${result.runId}）。`
      : "已按你的指令触发筛子，但当前没有待筛的新到达数据（队列为空，未产生 run）。";
    return {
      content: [{ type: "text", text }],
      details: { summary: result.runId ? `已触发筛子 run ${result.runId}` : "筛子队列为空，未运行" },
    };
  },
};

const addVoiceSchema = Type.Object({
  artifactId: Type.String({ description: "产出物 id（挂哪条产出物）。" }),
  content: Type.String({ description: "观众原话，逐字（原文原则，不改写不概括）。" }),
  platform: Type.String({ description: "平台标识（bilibili / 小红书 等）。" }),
});

const addVoiceTool: CollabTool = {
  name: "add_voice",
  label: "add voice",
  policy: "exec",
  description: "人发话才执行：把一条观众原话录入指定产出物的观众声音表（作者以 ai 占位；signal_type 未分拣，留待人工分拣）；经 audit 参数合成一条 ai_exec 审计账。",
  parameters: addVoiceSchema,
  async execute(_toolCallId, { artifactId, content, platform }, _signal, _onUpdate, context) {
    const instruction = requireExecInstruction(context);
    const row = addPwVoiceItem(context.db, {
      artifactId: requiredText(artifactId, "artifactId"),
      platform: requiredText(platform, "platform"),
      content: requiredText(content, "content"),
      capturedAt: new Date().toISOString(),
      author: "ai",
    }, {
      actor: "ai",
      instructionText: instruction.text,
      instructionMessageId: instruction.messageId,
    });
    return {
      content: [{ type: "text", text: `已按你的指令录入一条观众声音（id ${row.id}，平台 ${row.platform}）。` }],
      details: { summary: `已录入观众声音 ${row.id}` },
    };
  },
};

const promoteVoiceSchema = Type.Object({
  voiceId: Type.String({ description: "观众声音 id（list 声音时可见）。" }),
});

const promoteVoiceToCardTool: CollabTool = {
  name: "promote_voice_to_card",
  label: "promote voice to card",
  policy: "exec",
  description: "人发话才执行：把一条观众声音原文逐字提升为协作台候选卡草稿（批评类进少数派区，其余进证据区；已丢弃/噪音/已提升拒绝 409）；提请过的声音回写防重，不会重复产卡；执行后落一条 ai_exec 审计账。",
  parameters: promoteVoiceSchema,
  async execute(_toolCallId, { voiceId }, _signal, _onUpdate, context) {
    const instruction = requireExecInstruction(context);
    const { runId, card } = promotePwVoiceToCard(context.db, requiredText(voiceId, "voiceId"), {
      actor: "ai",
      instructionText: instruction.text,
      instructionMessageId: instruction.messageId,
    });
    const zone = card.kind === "wildcard" ? "少数派区" : "证据区";
    return {
      content: [{
        type: "text",
        text: `已按你的指令把该声音提升为候选卡（卡 id ${card.id}，进${zone}，runId ${runId}）。`,
      }],
      details: { summary: `已提升声音为候选卡 ${card.id}（${zone}）` },
    };
  },
};

const attachArtifactSchema = Type.Object({
  betId: Type.String({ description: "押注 id。" }),
  type: Type.String({ description: "产出物类型：video / livestream / article / cover / link。" }),
  platform: Type.String({ description: "平台标识。" }),
  url: Type.Optional(Type.String({ description: "URL（与 title 至少一项）。" })),
  title: Type.Optional(Type.String({ description: "标题（与 url 至少一项）。" })),
});

const attachArtifactTool: CollabTool = {
  name: "attach_artifact",
  label: "attach artifact",
  policy: "exec",
  description: "人发话才执行：给指定押注挂一条产出物（type/platform 必填，URL 或标题至少一项）；执行后落一条 ai_exec 审计账。",
  parameters: attachArtifactSchema,
  async execute(_toolCallId, args, _signal, _onUpdate, context) {
    requireExecInstruction(context);
    const betId = requiredText(args.betId, "betId");
    const artifact = attachPwArtifact(context.db, {
      betId,
      platform: requiredText(args.platform, "platform"),
      type: requiredText(args.type, "type") as PwArtifactType,
      url: optionalText(args.url),
      title: optionalText(args.title),
    });
    recordExecEvent(context, "attach", {
      artifactId: artifact.id,
      betId,
      type: artifact.type,
      platform: artifact.platform,
    }, [artifact.id], betId);
    return {
      content: [{ type: "text", text: `已按你的指令给押注挂上产出物（id ${artifact.id}，${artifact.type}/${artifact.platform}）。` }],
      details: { summary: `已挂产出物 ${artifact.id}` },
    };
  },
};

const detachArtifactSchema = Type.Object({
  artifactId: Type.String({ description: "产出物 id。" }),
});

const detachArtifactTool: CollabTool = {
  name: "detach_artifact",
  label: "detach artifact",
  policy: "exec",
  description: "人发话才执行：把指定产出物从押注上摘下（软删除 detached_at）；执行后落一条 ai_exec 审计账（沿用路由层 event_type=attach 语义）。",
  parameters: detachArtifactSchema,
  async execute(_toolCallId, { artifactId }, _signal, _onUpdate, context) {
    requireExecInstruction(context);
    const id = requiredText(artifactId, "artifactId");
    const artifact = detachPwArtifact(context.db, id);
    recordExecEvent(context, "attach", { artifactId: id, detached: true, betId: artifact.bet_id }, [id], artifact.bet_id);
    return {
      content: [{ type: "text", text: `已按你的指令摘下产出物（id ${id}）。` }],
      details: { summary: `已摘下产出物 ${id}` },
    };
  },
};

const listMyActionsSchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "条数上限，缺省 20。" })),
});

/** TASK-PW-24：查账工具（allow 只读）——回答「你最近代办了什么」。 */
const listMyActionsTool: CollabTool = {
  name: "list_my_actions",
  label: "list my actions",
  policy: "allow",
  description: "只读：列出 AI 最近替用户执行（或起草/自主干）的写动作（ai_exec/ai_draft/ai_auto，倒序，默认 20 条）；每行含时间/动作/对象/依据指令（指令原话截断 60 字，exec 缺指令标注「无引用！」，自主档标「自主」）。",
  parameters: listMyActionsSchema,
  async execute(_toolCallId, { limit }, _signal, _onUpdate, context) {
    const rows = listActionRuns(context.db, limit == null ? 20 : Number(limit));
    const text = rows.length === 0
      ? "我还没有替用户执行过写动作。"
      : rows.map((row) => {
        const payload = safeJson(row.payload_json);
        const object = typeof payload.title === "string" ? payload.title
          : typeof payload.bvid === "string" ? payload.bvid
          : typeof payload.betId === "string" ? payload.betId
          : typeof payload.draftId === "string" ? payload.draftId
          : typeof payload.runId === "string" ? payload.runId
          : typeof payload.voiceId === "string" ? payload.voiceId
          : typeof payload.artifactId === "string" ? payload.artifactId
          : typeof payload.corpusId === "string" ? payload.corpusId
          : "—";
        const instruction = row.instruction_text
          ? `「${row.instruction_text.length > 60 ? `${row.instruction_text.slice(0, 60)}…` : row.instruction_text}」`
          : row.kind === "ai_auto"
            ? "自主（无需指令）"
            : row.kind === "ai_draft"
              ? "起草（无需指令）"
              : "无引用！";
        const label = EXEC_ACTION_LABELS[row.event_type] ?? row.event_type;
        return `- ${row.created_at.slice(0, 19)} ${label}：${object}｜依据：${instruction}`;
      }).join("\n");
    return {
      content: [{ type: "text", text }],
      details: { summary: `已代办 ${rows.length} 条` },
    };
  },
};

// ---- TASK-PW-25：铸币级执行工具与冲正键（6 exec，description 以「人发话才执行：」开头）----

const settleBetSchema = Type.Object({
  draftId: Type.Optional(Type.String({ description: "结账草案 id（draft_settle 产出）；缺省取当前对话卡唯一的 pending 结账草案。" })),
  evidenceDocIds: Type.Array(Type.String(), { description: "证据文档 id 列表（先用 read_data_docs 选定）。" }),
});

const settleBetTool: CollabTool = {
  name: "settle_bet",
  label: "settle bet",
  policy: "exec",
  description: "人发话才执行：把已固化的结账草案一步结掉（两跳合一跳）——草案内容即结账内容；draftId 缺省取当前卡唯一 pending 草案；evidenceDocIds 必填（先用 read_data_docs 选定证据文档）；没有 pending 结账草案时报错并提示先用 draft_settle 起草；执行后落一条 ai_exec 审计账。",
  parameters: settleBetSchema,
  async execute(_toolCallId, { draftId, evidenceDocIds }, _signal, _onUpdate, context) {
    requireExecInstruction(context);
    const evidence = Array.isArray(evidenceDocIds) ? evidenceDocIds : [];
    if (evidence.length === 0) throw httpError(400, "evidenceDocIds 必填（先用 read_data_docs 选定证据文档）");
    if (evidence.some((docId) => typeof docId !== "string" || !docId.trim())) {
      throw httpError(400, "evidenceDocIds 必须是文档 id 数组");
    }
    // draftId 缺省：取当前会话卡唯一 pending 草案；多张则要求指认（全局会话必须显式 draftId）
    let id = optionalText(draftId);
    if (!id) {
      if (context.betId === PW_COLLAB_GLOBAL_BET_ID) {
        throw httpError(400, "全局对话需显式 draftId（指认规矩：先说清结哪张卡的账）");
      }
      const pendings = context.db.prepare(`
        SELECT id FROM pw_settle_drafts WHERE bet_id = ? AND status = 'pending' ORDER BY created_at, id
      `).all(context.betId) as Array<{ id: string }>;
      if (pendings.length === 0) throw httpError(409, "没有 pending 结账草案（先用 draft_settle 起草）");
      if (pendings.length > 1) {
        throw httpError(400, `当前卡有 ${pendings.length} 份 pending 结账草案，请指认一份：${pendings.map((row) => row.id).join("、")}`);
      }
      id = pendings[0]!.id;
    }
    const draft = getPwSettleDraft(context.db, id);
    if (draft.status !== "pending") throw httpError(409, "结账草案不是 pending 态（先用 draft_settle 起草）");
    const advice = safeJson(draft.advice_json);
    const recommendation = advice.recommendation;
    if (recommendation !== "settle_gold" && recommendation !== "settle_tomb") {
      throw httpError(400, "wait 草案不可结账");
    }
    const outcome = recommendation === "settle_gold" ? "gold" : "tomb";
    const lesson = typeof advice.lesson === "string" && advice.lesson.trim() ? advice.lesson.trim() : null;
    const causeOfDeath = typeof advice.cause_of_death === "string" && advice.cause_of_death.trim()
      ? advice.cause_of_death.trim()
      : null;
    if (outcome === "gold" && !lesson) throw httpError(400, "settle_gold 草案缺 lesson（先用 draft_settle 补全）");
    if (outcome === "tomb" && !causeOfDeath) throw httpError(400, "settle_tomb 草案缺 cause_of_death（先用 draft_settle 补全）");
    // 顺序两步非单事务：settlePwBet 内部自带 BEGIN/COMMIT 不可嵌套；落账在最后保证「成了才有账」
    const verdict = settlePwBet(context.db, draft.bet_id, {
      outcome,
      lesson,
      causeOfDeath,
      evidenceDocIds: evidence,
    });
    approvePwSettleDraft(context.db, id);
    recordExecEvent(context, "settle", {
      draftId: id,
      betId: draft.bet_id,
      verdictId: verdict.id,
      outcome: verdict.outcome,
    }, undefined, draft.bet_id);
    // TASK-PW-26：结账后金子镜像自动同步（actor=system；失败不拖垮结账，人工镜像按钮后路仍在）
    try {
      mirrorConfirmedGolds(context.db, { actor: "system" });
    } catch {
      // 镜像失败只留未同步，人工可手动补（路由保留）
    }
    return {
      content: [{ type: "text", text: `已按你的指令把结账草案一步结掉（${recommendation}）：押注 ${draft.bet_id} → settled，判决 ${verdict.id}（${outcome}），证据 ${evidence.length} 份。` }],
      details: { summary: `已结账押注（${outcome}）`, kind: "settle", draftId: id },
    };
  },
};

const pickSieveCardSchema = Type.Object({
  cardId: Type.String({ description: "候选卡 id。" }),
  overrides: Type.Optional(Type.Object({
    title: Type.Optional(Type.String({ description: "押注标题覆盖。" })),
    conversionSignal: Type.Optional(Type.String({ description: "转化信号覆盖。" })),
    metricTarget: Type.Optional(Type.String({ description: "指标目标覆盖。" })),
    reviewDate: Type.Optional(Type.String({ description: "看结果日 YYYY-MM-DD 覆盖。" })),
  })),
});

const pickSieveCardTool: CollabTool = {
  name: "pick_sieve_card",
  label: "pick sieve card",
  policy: "exec",
  description: "人发话才执行：把 pending 候选卡挑成内容押注卡（卡转 picked/edited，可带 overrides 覆盖标题/转化信号/指标目标/看结果日）；执行后落一条 ai_exec 审计账。",
  parameters: pickSieveCardSchema,
  async execute(_toolCallId, { cardId, overrides }, _signal, _onUpdate, context) {
    const instruction = requireExecInstruction(context);
    const bet = pickPwSieveCard(context.db, requiredText(cardId, "cardId"), overrides ?? {}, {
      actor: "ai",
      instructionText: instruction.text,
      instructionMessageId: instruction.messageId,
    });
    // TASK-PW-33：挑卡成立内容押注后自动起草（fire-and-forget，不阻塞工具返回；守卫由发动函数把关）
    void maybeAutoFirePwDraft(context.db, bet.id, { trigger: "pick_sieve_card" });
    return {
      content: [{ type: "text", text: `已按你的指令把候选卡挑成内容押注「${bet.title}」（id ${bet.id}，状态 pending）。` }],
      details: { summary: `已挑卡「${bet.title}」`, kind: "bet", draftId: bet.id },
    };
  },
};

const rejectSieveCardSchema = Type.Object({
  cardId: Type.String({ description: "候选卡 id。" }),
  reason: Type.Optional(Type.String({ description: "否掉理由（可选）。" })),
});

const rejectSieveCardTool: CollabTool = {
  name: "reject_sieve_card",
  label: "reject sieve card",
  policy: "exec",
  description: "人发话才执行：把 pending 候选卡否掉（status→rejected），可附理由；执行后落一条 ai_exec 审计账。",
  parameters: rejectSieveCardSchema,
  async execute(_toolCallId, { cardId, reason }, _signal, _onUpdate, context) {
    const instruction = requireExecInstruction(context);
    const id = requiredText(cardId, "cardId");
    rejectPwSieveCard(context.db, id, optionalText(reason) ?? undefined, {
      actor: "ai",
      instructionText: instruction.text,
      instructionMessageId: instruction.messageId,
    });
    return {
      content: [{ type: "text", text: `已按你的指令否掉候选卡 ${id}。` }],
      details: { summary: `已否掉候选卡 ${id}` },
    };
  },
};

const rejectAllAndResieveSchema = Type.Object({
  reason: Type.Optional(Type.String({ description: "全否理由（可选）。" })),
  direction: Type.Optional(Type.String({ description: "新方向（可选）：非空时先换方向再全否重筛；留空/省略 = 原方向重筛（行为与现状一致）。" })),
  resieveAll: Type.Optional(Type.Boolean({ description: "resieveAll=true 时把现有语料也重过一遍。" })),
});

const rejectAllAndResieveTool: CollabTool = {
  name: "reject_all_and_resieve",
  label: "reject all and resieve",
  policy: "exec",
  description: "人发话才执行：把全部 pending 候选卡否掉并立即触发一轮筛子重筛；可附 direction 先换方向（留空 = 原方向重筛）；resieveAll=true 时把现有语料也重过一遍；执行后落两条 ai_exec 审计账（reject + sieve_run，同指令引用）。",
  parameters: rejectAllAndResieveSchema,
  async execute(_toolCallId, { reason, direction, resieveAll }, _signal, _onUpdate, context) {
    const instruction = requireExecInstruction(context);
    const sieve = context.sieve;
    if (!sieve) throw httpError(500, "筛子运行器未注入（exec 工具装配缺 sieve）");
    // TASK-PW-42：有值先换方向（重筛按新方向捞）；无 direction 不碰方向（行为与现状一致）
    const newDirection = optionalText(direction);
    if (newDirection !== null) {
      setSieveDirection(context.db, newDirection);
    }
    const audit = {
      actor: "ai" as const,
      instructionText: instruction.text,
      instructionMessageId: instruction.messageId,
    };
    const cardIds = rejectAllPendingPwSieveCards(context.db, optionalText(reason) ?? undefined, audit);
    // TASK-PW-48：resieveAll=true 时把现有语料也重过一遍（直通主管线，绕过 notifier 去重）
    const resieveOld = resieveAll === true;
    const result = resieveOld
      ? await resieveAllPwSieve(context.db)
      : await sieve.flushNow();
    recordExecEvent(context, "sieve_run", { runId: result.runId }, undefined, null);
    const directionNote = newDirection !== null ? `，方向已换为「${newDirection}」` : "";
    // 重复出卡说明：老料重筛可能把挑过的评论再筛出来，候选卡是草稿，人否掉即可
    const resieveNote = resieveOld ? "老料重筛可能把挑过的评论再筛出来，候选卡是草稿，人否掉即可。" : "";
    const text = cardIds.length > 0
      ? `已按你的指令否掉 ${cardIds.length} 张候选卡并触发一轮重筛${directionNote}${result.runId ? `（runId ${result.runId}）` : "（当前无待筛数据）"}。${resieveNote}`
      : `已按你的指令触发重筛${directionNote}，但当前没有 pending 候选卡可否。${resieveNote}`;
    return {
      content: [{ type: "text", text }],
      details: { summary: `已全否 ${cardIds.length} 张卡并重筛` },
    };
  },
};

const setSieveDirectionSchema = Type.Object({
  direction: Type.Optional(Type.String({ description: "新方向（一句话，如「AI 办公提效」）；留空/省略 = 清除方向恢复默认（捞路人困惑）。" })),
});

const setSieveDirectionTool: CollabTool = {
  name: "set_sieve_direction",
  label: "set sieve direction",
  policy: "exec",
  description: "人发话才执行：设置筛子当前方向（捞取取向，一句话，如「AI 办公提效」；后续每轮筛子都朝这个方向捞）；留空 = 清除方向恢复默认（捞路人困惑）；执行后落一条 ai_exec 审计账。",
  parameters: setSieveDirectionSchema,
  async execute(_toolCallId, { direction }, _signal, _onUpdate, context) {
    requireExecInstruction(context);
    const next = optionalText(direction);
    setSieveDirection(context.db, next);
    recordExecEvent(context, "edit", { direction: next }, undefined, null);
    const text = next === null
      ? "已按你的指令清除筛子方向（恢复默认：捞路人困惑）。"
      : `已按你的指令把筛子方向设为「${next}」。`;
    return {
      content: [{ type: "text", text }],
      details: { summary: next === null ? "已清除筛子方向" : `已设筛子方向「${next}」` },
    };
  },
};

const unpickSieveCardSchema = Type.Object({
  betId: Type.String({ description: "内容押注 id（挑卡产生的押注）。" }),
});

const unpickSieveCardTool: CollabTool = {
  name: "unpick_sieve_card",
  label: "unpick sieve card",
  policy: "exec",
  description: "人发话才执行：冲正键——仅限撤销一次挑卡：生成的内容押注作废（status→void）+ 来源候选卡退回 pending，同一事务；不是通用回退；执行后落一条 ai_exec 审计账。",
  parameters: unpickSieveCardSchema,
  async execute(_toolCallId, { betId }, _signal, _onUpdate, context) {
    const instruction = requireExecInstruction(context);
    const id = requiredText(betId, "betId");
    const bet = unpickPwContentBet(context.db, id, {
      actor: "ai",
      instructionText: instruction.text,
      instructionMessageId: instruction.messageId,
    });
    return {
      content: [{ type: "text", text: `已按你的指令撤销挑卡：押注「${bet.title}」（${bet.id}）→ void，候选卡退回 pending。` }],
      details: { summary: `已撤销挑卡「${bet.title}」` },
    };
  },
};

const voidSettlementSchema = Type.Object({
  betId: Type.String({ description: "押注 id。" }),
});

const voidSettlementTool: CollabTool = {
  name: "void_settlement",
  label: "void settlement",
  policy: "exec",
  description: "人发话才执行：冲正键——仅限作废一笔结账：判决 outcome→void（教材原文不涂改）+ 押注 settled→void，可再重结；执行后落一条 ai_exec 审计账。",
  parameters: voidSettlementSchema,
  async execute(_toolCallId, { betId }, _signal, _onUpdate, context) {
    const instruction = requireExecInstruction(context);
    const id = requiredText(betId, "betId");
    const verdict = voidPwSettlement(context.db, id, {
      actor: "ai",
      instructionText: instruction.text,
      instructionMessageId: instruction.messageId,
    });
    return {
      content: [{ type: "text", text: `已按你的指令作废结账：押注 ${id} → void，判决 ${verdict.id} → void（教材原文保留），可再重结。` }],
      details: { summary: `已作废结账 ${id}` },
    };
  },
};

export const pwCollabTools: readonly CollabTool[] = [
  readBetTool,
  readDataDocsTool,
  searchVerdictsTool,
  searchCorpusTool,
  readVoiceTool,
  // TASK-PW-21：对话深挖只读工具（全 allow）
  listCorpusTool,
  readCorpusDocTool,
  readCorpusCommentsTool,
  readDocVersionsTool,
  readVerdictEvidenceTool,
  readConnectionsTool,
  listSieveCardsTool,
  readSieveCardTool,
  // TASK-PW-22：全局证据（全 allow，内容押注卡清单）
  listContentBetsTool,
  fetchCorpusTool,
  draftBetTool,
  draftSettleTool,
  // TASK-PW-24：人发话写工具（9 exec，description 以「人发话才执行：」开头）+ 查账（allow）
  confirmBetDraftTool,
  rejectBetDraftTool,
  createBetTool,
  editBetTool,
  freezeDataDocTool,
  runSieveTool,
  addVoiceTool,
  // TASK-PW-45：声音提请候选卡（exec，人发话才执行）
  promoteVoiceToCardTool,
  attachArtifactTool,
  detachArtifactTool,
  listMyActionsTool,
  // TASK-PW-25：铸币级执行工具与冲正键（6 exec）
  settleBetTool,
  pickSieveCardTool,
  rejectSieveCardTool,
  rejectAllAndResieveTool,
  // TASK-PW-42：方向输入（exec，人发话才执行）
  setSieveDirectionTool,
  unpickSieveCardTool,
  voidSettlementTool,
];

/** TASK-PW-25：结账已进表（settle_bet）；金子同步与常规回退等仍 deny（deny 即不存在）。 */
export const pwCollabDeniedToolNames = [
  "mirror_golds",
  // TASK-PW-25：挑/否进表（pick_sieve_card / reject_sieve_card / reject_all_and_resieve）；
  // create_content_bet 无独立工具（挑卡带 overrides 即改挑）。
  // 常规回退 revert_sieve_card 仍 deny——unpick 冲正键是候选卡唯一回退口。
  "delete_bet",
  "rewrite_verdict",
  "revert_sieve_card",
  "reset_sieve_watermark",
  "delete_collab_message",
  "force_mirror_refresh",
  "clear_risk_events",
] as const;

function betDraftContent(row: PwBetRow) {
  return {
    title: row.title,
    thesis: row.thesis,
    metric: row.metric,
    metric_target: row.metric_target,
    confidence: row.confidence,
    data_source_plan: row.data_source_plan,
    checkout_date: row.checkout_date,
    gold_refs: JSON.parse(row.gold_refs_json) as string[],
  };
}
