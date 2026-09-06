/**
 * TASK-PW-35 收工小结：只读聚合 pw_runs（全 kind），联查 pw_bets / pw_sieve_cards / pw_content_drafts
 * 取押注标题与卡片引文。无新表、无写操作；日窗口按本机本地时区解释（后端与用户同机）。
 *
 * 分类规则见 docs/TASK-PW-35-day-summary.md §3：一行只归一档，按优先级命中即止；
 * payload 非法 JSON 的行跳过分类但计入「其余事件」。对账锚点：各栏目计数和 + otherCount = totalEvents。
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { PwEventActor, PwRunRow } from "./pw-runs.ts";
// TASK-PW-40：收工小结末尾追加「旧笔记回响」（内部装配，纯展示，不参与任何一档计数）
import { buildPwNoteEcho } from "./pw-note-recall.ts";
import type { PwNoteEcho } from "./pw-note-recall.ts";

/** 挑卡条目：confirm 且 payload.cardId。 */
export type DayPickItem = {
  /** 本地 HH:MM */
  time: string;
  /** 卡片引文截断 40 字；卡片行被删 → id 前 8 位 */
  quote: string;
  /** 押注标题；押注行被删 → id 前 8 位 */
  betTitle: string;
  /** overrides 非空对象 = 挑改 */
  edited: boolean;
  actor: PwEventActor;
};

/** 押注转正条目：confirm 且无 cardId/artifactId/settleDraftId，命中两路之一——
 * a) payload.draftId === payload.betId（工具面内部账）；b) payload.draftHash 且 row.bet_id 非空（REST 面路由账）。 */
export type DayBetConfirmItem = {
  time: string;
  betTitle: string;
  actor: PwEventActor;
};

/** 定稿条目：confirm 且 payload.draftId+betId 且 draftId !== betId（素材草案定稿账；artifactId 非必要）。 */
export type DayFinalizeItem = {
  time: string;
  /** 草案 route（联查 pw_content_drafts；行被删 → id 前 8 位） */
  draftRoute: string;
  /** 草案标题 title_candidate（行被删 → id 前 8 位） */
  draftTitle: string;
  betTitle: string;
  actor: PwEventActor;
};

/** 否卡条目：reject 且 payload.cardId。 */
export type DayCardRejectItem = {
  time: string;
  /** 引文截断 40 字；卡片行被删 → id 前 8 位 */
  quote: string;
  reason: string | null;
};

/** 否草案条目：reject 且 payload.draftId 且无 cardId。 */
export type DayDraftRejectItem = {
  time: string;
  route: string;
  title: string;
  reason: string | null;
};

/** 起草批次条目：kind='ai_draft' 且 event_type='draft'。 */
export type DayDraftRunItem = {
  time: string;
  trigger: string;
  /** 本批产出份数（payload.created） */
  created: number;
  /** 失败批的 error（payload.error）；成功批为 null */
  error: string | null;
};

/** AI 代办条目：kind='ai_exec'。 */
export type DayExecItem = {
  time: string;
  eventType: string;
  /** payload 首个可用键（同 list_my_actions 口径）；无键 → — */
  object: string;
  /** 指令原话截断 60 字；NULL（旧行缺指令）→ 无引用！ */
  instruction: string | null;
};

/** AI 自主条目：kind='ai_auto'（渲染标「自主」）。 */
export type DayAutoItem = {
  time: string;
  eventType: string;
  object: string;
};

/** 其余事件分布摘要（kind 非 manual_event 用 kind，否则用 event_type）。 */
export type DayOtherDist = { label: string; count: number };

export type PwDaySummary = {
  /** YYYY-MM-DD（本地日） */
  date: string;
  startIso: string;
  endIso: string;
  generatedAt: string;
  /** 窗口内全部行数（含非法 JSON 行）——对账锚点 */
  totalEvents: number;
  otherCount: number;
  otherDist: DayOtherDist[];
  /** = draftRuns.length，独立暴露便于对账 */
  draftRunBatches: number;
  /** 各批 created 求和 */
  draftsCreated: number;
  picks: DayPickItem[];
  betConfirms: DayBetConfirmItem[];
  finalizes: DayFinalizeItem[];
  cardRejects: DayCardRejectItem[];
  draftRejects: DayDraftRejectItem[];
  draftRuns: DayDraftRunItem[];
  execActions: DayExecItem[];
  autoActions: DayAutoItem[];
  /** TASK-PW-40：旧笔记回响（只读装配，纯展示；不参与九档计数，对账锚点不含它） */
  noteEcho: PwNoteEcho;
};

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** payload 对象键的取用顺序（与 list_my_actions 同口径）。 */
const OBJECT_KEYS = [
  "title",
  "bvid",
  "betId",
  "draftId",
  "runId",
  "voiceId",
  "artifactId",
  "corpusId",
] as const;

export function getPwDaySummary(
  db: DatabaseSync,
  options: { date?: string; now?: Date } = {},
): PwDaySummary {
  const now = options.now ?? new Date();
  const date = options.date ?? localDateKey(now);
  const { startIso, endIso } = localDayWindow(date);

  const rows = db.prepare(`
    SELECT * FROM pw_runs
    WHERE created_at >= ? AND created_at < ?
    ORDER BY created_at ASC, rowid ASC
  `).all(startIso, endIso) as PwRunRow[];

  const betTitleStmt = db.prepare("SELECT title FROM pw_bets WHERE id = ?");
  const cardQuoteStmt = db.prepare("SELECT quote_text FROM pw_sieve_cards WHERE id = ?");
  const draftStmt = db.prepare("SELECT route, title_candidate FROM pw_content_drafts WHERE id = ?");

  const summary: PwDaySummary = {
    date,
    startIso,
    endIso,
    generatedAt: now.toISOString(),
    totalEvents: rows.length,
    otherCount: 0,
    otherDist: [],
    draftRunBatches: 0,
    draftsCreated: 0,
    picks: [],
    betConfirms: [],
    finalizes: [],
    cardRejects: [],
    draftRejects: [],
    draftRuns: [],
    execActions: [],
    autoActions: [],
    // TASK-PW-40 占位：末尾装配回响后覆盖（先过九档分类，回响不参与任何计数）
    noteEcho: { status: "no_bets" },
  };

  for (const row of rows) {
    const payload = safeJson(row.payload_json);
    const time = localHm(row.created_at);
    // §3 优先级：picks → betConfirms → finalizes → cardRejects → draftRejects → draftRuns → exec → auto → other
    if (row.event_type === "confirm" && typeof payload.cardId === "string") {
      summary.picks.push({
        time,
        quote: truncate(cardQuote(cardQuoteStmt, payload.cardId) ?? payload.cardId.slice(0, 8), 40),
        betTitle: betTitle(betTitleStmt, payload.betId),
        edited: isNonEmptyObject(payload.overrides),
        actor: row.actor,
      });
    } else if (
      row.event_type === "confirm"
      && payload.cardId === undefined
      && payload.artifactId === undefined
      && payload.settleDraftId === undefined
      && (
        // a) 工具面押注转正内部账：payload {draftId, betId, edits} 且 draftId === betId
        (typeof payload.draftId === "string" && payload.draftId === payload.betId)
        // b) REST 面路由层账：payload {draftHash}，bet_id 列 = 押注 id（标题经 row.bet_id 联查）
        || (typeof payload.draftHash === "string" && typeof row.bet_id === "string" && row.bet_id !== "")
      )
    ) {
      const confirmBetId = typeof payload.draftId === "string" && payload.draftId === payload.betId
        ? payload.betId
        : row.bet_id;
      summary.betConfirms.push({
        time,
        betTitle: betTitle(betTitleStmt, confirmBetId),
        actor: row.actor,
      });
    } else if (
      row.event_type === "confirm"
      && typeof payload.draftId === "string"
      && typeof payload.betId === "string"
      && payload.draftId !== payload.betId
    ) {
      const draft = draftRow(draftStmt, payload.draftId);
      summary.finalizes.push({
        time,
        draftRoute: draft?.route ?? payload.draftId.slice(0, 8),
        draftTitle: draft?.title ?? payload.draftId.slice(0, 8),
        betTitle: betTitle(betTitleStmt, payload.betId),
        actor: row.actor,
      });
    } else if (row.event_type === "reject" && typeof payload.cardId === "string") {
      summary.cardRejects.push({
        time,
        quote: truncate(cardQuote(cardQuoteStmt, payload.cardId) ?? payload.cardId.slice(0, 8), 40),
        reason: typeof payload.reason === "string" ? payload.reason : null,
      });
    } else if (
      row.event_type === "reject"
      && typeof payload.draftId === "string"
      && payload.cardId === undefined
    ) {
      const draft = draftRow(draftStmt, payload.draftId);
      summary.draftRejects.push({
        time,
        route: draft?.route ?? payload.draftId.slice(0, 8),
        title: draft?.title ?? payload.draftId.slice(0, 8),
        reason: typeof payload.reason === "string" ? payload.reason : null,
      });
    } else if (row.kind === "ai_draft" && row.event_type === "draft") {
      const created = typeof payload.created === "number" ? payload.created : 0;
      summary.draftRuns.push({
        time,
        trigger: typeof payload.trigger === "string" ? payload.trigger : "—",
        created,
        error: typeof payload.error === "string" ? payload.error : null,
      });
      summary.draftRunBatches += 1;
      summary.draftsCreated += created;
    } else if (row.kind === "ai_exec") {
      summary.execActions.push({
        time,
        eventType: row.event_type,
        object: payloadObject(payload),
        instruction: typeof row.instruction_text === "string" ? truncate(row.instruction_text, 60) : null,
      });
    } else if (row.kind === "ai_auto") {
      summary.autoActions.push({
        time,
        eventType: row.event_type,
        object: payloadObject(payload),
      });
    } else {
      summary.otherCount += 1;
      const label = row.kind === "manual_event" ? row.event_type : row.kind;
      const existing = summary.otherDist.find((d) => d.label === label);
      if (existing) {
        existing.count += 1;
      } else {
        summary.otherDist.push({ label, count: 1 });
      }
    }
  }

  // TASK-PW-40：内部末尾装配「旧笔记回响」——safeNoteEcho 兜底 unavailable，绝不能让回响把收工小结搞崩
  summary.noteEcho = safeNoteEcho(db);

  return summary;
}

/** TASK-PW-40：回响装配兜底（buildPwNoteEcho 自身已把库错误转 unavailable，这里再包一层，
 *  任何异常都不逃——回响绝不能把收工小结搞崩）。 */
function safeNoteEcho(db: DatabaseSync): PwNoteEcho {
  try {
    return buildPwNoteEcho(db);
  } catch (error) {
    return {
      status: "unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 纯文本导出（非 markdown 表格）；空日只出标题行 + 无事件提示。 */
export function renderPwDaySummaryText(summary: PwDaySummary): string {
  if (summary.totalEvents === 0) {
    // TASK-PW-40：回响与当日事件无关，空事件日早退分支同样追加回响段
    return `收工小结 ${summary.date}\n\n今天没有协作台事件。\n\n${renderNoteEcho(summary.noteEcho)}`;
  }
  const parts: string[] = [`收工小结 ${summary.date}`, countLine(summary)];
  if (summary.picks.length > 0) parts.push(section("挑卡", summary.picks, renderPick));
  if (summary.betConfirms.length > 0) parts.push(section("押注转正", summary.betConfirms, renderBetConfirm));
  if (summary.finalizes.length > 0) parts.push(section("定稿", summary.finalizes, renderFinalize));
  if (summary.cardRejects.length > 0) parts.push(section("否卡", summary.cardRejects, renderCardReject));
  if (summary.draftRejects.length > 0) parts.push(section("否草案", summary.draftRejects, renderDraftReject));
  if (summary.draftRuns.length > 0) parts.push(section("起草批次", summary.draftRuns, renderDraftRun));
  if (summary.execActions.length > 0) parts.push(section("AI 代办", summary.execActions, renderExec));
  if (summary.autoActions.length > 0) parts.push(section("AI 自主", summary.autoActions, renderAuto));
  if (summary.otherCount > 0) {
    const dist = summary.otherDist.map((d) => `${d.label}×${d.count}`).join("、");
    parts.push(`另有余系统事件 ${summary.otherCount} 笔（${dist}）。`);
  }
  // TASK-PW-40：回响段恒追加在末尾（纯展示，不进任何一档计数，对账锚点不含它）
  parts.push(renderNoteEcho(summary.noteEcho));
  return parts.join("\n\n");
}

function countLine(summary: PwDaySummary): string {
  return `挑 ${summary.picks.length} · 否 ${summary.cardRejects.length + summary.draftRejects.length} · 押 ${summary.betConfirms.length} · 定稿 ${summary.finalizes.length} · 起草 ${summary.draftRunBatches} 批（${summary.draftsCreated} 份）· AI 代办 ${summary.execActions.length} 件 · 自主 ${summary.autoActions.length} 件`;
}

function section<T>(title: string, items: T[], render: (item: T) => string): string {
  return [`■ ${title}（${items.length}）`, ...items.map((item) => `  ${render(item)}`)].join("\n");
}

function renderPick(item: DayPickItem): string {
  const suffix = `${item.edited ? "（挑改）" : ""}${actorMarker(item.actor)}`;
  return `「${item.quote}」→ 押注《${item.betTitle}》${suffix}`.trimEnd();
}

function renderBetConfirm(item: DayBetConfirmItem): string {
  return `《${item.betTitle}》${actorMarker(item.actor)}`;
}

function renderFinalize(item: DayFinalizeItem): string {
  return `${item.draftRoute}《${item.draftTitle}》→ 押注《${item.betTitle}》${actorMarker(item.actor)}`.trimEnd();
}

function renderCardReject(item: DayCardRejectItem): string {
  return `否卡「${item.quote}」｜理由：${item.reason ?? "—"}`;
}

function renderDraftReject(item: DayDraftRejectItem): string {
  return `否草案《${item.title}》（${item.route}）｜理由：${item.reason ?? "—"}`;
}

function renderDraftRun(item: DayDraftRunItem): string {
  return item.error
    ? `起草「${item.trigger}」→ 失败：${item.error}`
    : `起草「${item.trigger}」→ ${item.created} 份`;
}

function renderExec(item: DayExecItem): string {
  return `${item.eventType}《${item.object}》｜依据${item.instruction ? `「${item.instruction}」` : " 无引用！"}`;
}

function renderAuto(item: DayAutoItem): string {
  return `${item.eventType}《${item.object}》（自主）`;
}

/** TASK-PW-40「旧笔记回响」段：纯追加展示，不进任何计数；命中内容截断 50 字，
 *  无命中押注的关键词展示截断 8 个（超补 …）。 */
function renderNoteEcho(echo: PwNoteEcho): string {
  const lines = ["■ 旧笔记回响"];
  if (echo.status === "no_bets") {
    lines.push("  当前无在途内容押注，今日不捞。");
  } else if (echo.status === "unavailable") {
    lines.push(`  连不上笔记库：${echo.error}`);
  } else {
    for (const bet of echo.bets) {
      if (bet.keywords.length === 0) {
        lines.push(`  押注《${bet.betTitle}》→ 无可捞关键词，跳过。`);
      } else if (bet.hits.length === 0) {
        const shown = `${bet.keywords.slice(0, 8).join("、")}${bet.keywords.length > 8 ? "…" : ""}`;
        lines.push(`  押注《${bet.betTitle}》→ 无命中（捞了：${shown}）`);
      } else {
        lines.push(`  押注《${bet.betTitle}》→ 命中 ${bet.hits.length} 条：`);
        for (const hit of bet.hits) {
          // createdAt 是含时区偏移的 ISO 本地时间（PW-39），取中间 5 位即 MM-DD
          lines.push(
            `    「${truncate(hit.content, 50)}」（${hit.createdAt.slice(5, 10)}，命中词：${hit.matchedKeywords.join("、")}）→ ${hit.url}`,
          );
        }
      }
    }
  }
  return lines.join("\n");
}

function actorMarker(actor: PwEventActor): string {
  return actor === "ai" ? "（AI 代办）" : actor === "system" ? "（系统）" : "";
}

/** YYYY-MM-DD（本地时区）；非法抛 400。 */
function localDayWindow(date: string): { startIso: string; endIso: string } {
  if (typeof date !== "string") throw badRequest("date 必须是 YYYY-MM-DD");
  const m = DATE_RE.exec(date);
  if (!m) throw badRequest("date 必须是 YYYY-MM-DD");
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) throw badRequest("date 必须是 YYYY-MM-DD");
  const start = new Date(year, month - 1, day);
  if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) {
    throw badRequest("date 必须是 YYYY-MM-DD");
  }
  return {
    startIso: start.toISOString(),
    endIso: new Date(year, month - 1, day + 1).toISOString(),
  };
}

function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** ISO UTC → 本地 HH:MM。 */
function localHm(iso: string): string {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function betTitle(stmt: StatementSync, betId: unknown): string {
  if (typeof betId !== "string" || !betId) return "—";
  const row = stmt.get(betId) as { title?: string } | undefined;
  return row?.title ?? betId.slice(0, 8);
}

function cardQuote(stmt: StatementSync, cardId: unknown): string | null {
  if (typeof cardId !== "string" || !cardId) return null;
  const row = stmt.get(cardId) as { quote_text?: string } | undefined;
  return row?.quote_text ?? null;
}

function draftRow(
  stmt: StatementSync,
  draftId: unknown,
): { route: string; title: string } | undefined {
  if (typeof draftId !== "string" || !draftId) return undefined;
  const row = stmt.get(draftId) as { route?: string; title_candidate?: string } | undefined;
  if (!row) return undefined;
  return { route: row.route ?? "", title: row.title_candidate ?? "" };
}

function payloadObject(payload: Record<string, unknown>): string {
  for (const key of OBJECT_KEYS) {
    const value = payload[key];
    if (typeof value === "string") return value;
  }
  return "—";
}

function isNonEmptyObject(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length > 0;
}

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

function badRequest(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 400 });
}
