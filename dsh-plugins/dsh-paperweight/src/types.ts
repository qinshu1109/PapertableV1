/**
 * dsh-paperweight 前后端共享契约
 * ---------------------------------------------------------------
 * 归属：dsh-cc（后端/host 半）先写定稿；Claude（client 半）只消费。
 * 改契约 = 双方都不许私改；必须写 agent-bridge/out/37-contract-changes.md 留痕并回报。
 *
 * 铁律映射（全文以 briefs/37 为准）：
 * - host 只经 http://127.0.0.1:4317 HTTP API 取数，不直连 SQLite，不建缓存镜像表。
 * - 写路径只有两类：AI 起草落 draft（POST /pw/api/draft/bet）；
 *   人亲手点的按钮走 POST /pw/api/action（host 记录 source=human-click 再转发 4317）。
 * - AI 工具数组只有只读工具 + pw_draft_bet，永无 settle/confirm/verdict 写 schema。
 * - 推送 feed 是插件自己的“推送收件箱”（未读标记），不是镇纸业务数据副本。
 *
 * 包骨架约定（已协商）：
 * - host 半已由 dsh-cc 完成：main=lib/index.js、exports["./client"] 已预留。
 * - `dsh.client` 声明（platform web + inject 列表）由 Claude 在写完 client 入口后补进
 *   package.json；在 client 构建产出 lib/client.js 之前不声明，避免 dsh 提前加载空入口。
 */

/** 4317 唯一数据门。 */
export const PW_BASE_URL = "http://127.0.0.1:4317";

/** dsh webServer 同源 API 统一前缀；client 只准调这些路由。 */
export const PW_API_PREFIX = "/pw/api";

/* ------------------------------------------------------------------ */
/* 路由表：client 面 → host 面 → 4317 面                               */
/* ------------------------------------------------------------------ */

export type PwHttpMethod = "GET" | "POST";

export interface PwRouteEntry {
  /** client 只准调的这个路由（方法 + 路径模式）。 */
  route: string;
  /** host 转发到 4317 的既有路由（方法 + 路径，可多条）。 */
  upstream: string[];
  /** 裁剪/装配说明。 */
  note: string;
}

export const PW_ROUTE_TABLE: PwRouteEntry[] = [
  { route: "GET /pw/api/bets", upstream: ["GET /api/pw/bets"], note: "押注列表，支持 status 过滤；裁剪为 PwBetView" },
  { route: "GET /pw/api/drafts", upstream: ["GET /api/pw/drafts"], note: "草稿列表：现拉现裁为 PwDraftView（PwBetView 兼容 + 可选 draftHash）" },
  { route: "GET /pw/api/bets/:id", upstream: ["GET /api/pw/bets/:id", "GET /api/pw/bets/:id/data-docs", "GET /api/pw/bets/:id/precedents", "GET /api/pw/bets/:id/context"], note: "单卡装配：赌注/置信度/距结账天数/数据文档摘要/相关判例" },
  { route: "GET /pw/api/verdicts", upstream: ["GET /api/pw/verdicts", "GET /api/pw/verdicts/search"], note: "金/碑列表（outcome 或 q 过滤）" },
  { route: "GET /pw/api/verdicts/:id/evidence", upstream: ["GET /api/pw/verdicts", "GET /api/pw/data-docs", "GET /api/pw/bets/:id"], note: "判决 + 证据链装配（4317 无单条 evidence 路由，host 用既有只读路由拼装）" },
  { route: "GET /pw/api/voice/themes", upstream: ["GET /api/pw/corpus", "GET /api/pw/voice/corpus-cards"], note: "观众声音分桶（按 bvid 聚合 suggested 主题卡）" },
  { route: "GET /pw/api/voice/items?theme=", upstream: ["GET /api/pw/corpus", "GET /api/pw/voice/corpus-cards"], note: "某主题逐字原文+赞数展开" },
  { route: "GET /pw/api/notes/today", upstream: ["GET /api/pw/notes", "GET /api/pw/notes/status"], note: "大盘笔记：最近笔记 + Memos 状态" },
  { route: "GET /pw/api/notes/tree", upstream: ["GET /api/pw/notes/tree"], note: "笔记树" },
  { route: "GET /pw/api/ops/status", upstream: ["GET /api/status", "GET /api/pw/connections", "GET /api/pw/bets", "GET /api/pw/verdicts", "GET /api/pw/data-docs", "GET /api/pw/drafts", "GET /api/pw/sieve/cards"], note: "运维数据源 + 三处可对账数字" },
  { route: "GET /pw/api/push/feed", upstream: [], note: "插件本地推送收件箱（未读标记）" },
  { route: "POST /pw/api/push/mark-read", upstream: [], note: "标记推送已读" },
  { route: "POST /pw/api/draft/bet", upstream: ["POST /api/pw/drafts"], note: "AI 起草，落 draft，host 补算 draft_hash" },
  { route: "POST /pw/api/action", upstream: ["POST /api/pw/sieve/cards/:id/pick", "POST /api/pw/sieve/cards/:id/reject", "POST /api/pw/drafts/:id/confirm"], note: "人点按钮：挑/改挑/否/确认；host 记 source=human-click 再转发" },
];

/* ------------------------------------------------------------------ */
/* 押注台                                                              */
/* ------------------------------------------------------------------ */

export type PwBetStatus = "draft" | "pending" | "settled" | "void";
export type PwBetKind = "verdict" | "content";

export interface PwBetView {
  id: string;
  title: string;
  thesis: string;
  metric: string | null;
  metricTarget: string | null;
  confidence: number | null;
  dataSourcePlan: string | null;
  checkoutDate: string | null;
  status: PwBetStatus;
  kind: PwBetKind;
  sourceCardId: string | null;
  createdAt: string;
  settledVerdictId: string | null;
  /** 距结账日天数（按 UTC 日期算；null 表示无结账日或已结算）。 */
  daysToCheckout: number | null;
  /** 内容押注附的草稿份数（4317 /api/pw/content-bets 口径）。 */
  draftCount?: number;
}

/** 草稿视图：与 PwBetView 兼容，另带可选的 draftHash（4317 列表不直接给出时可为 undefined）。 */
export interface PwDraftView extends PwBetView {
  /** 草稿内容规范化 hash；host 按与 createDraft 同口径补算，仅作标识/对账用。 */
  draftHash?: string;
}

export interface PwDataDocView {
  id: string;
  betId: string;
  artifactId: string | null;
  platform: string;
  collectedAt: string;
  method: "manual" | "export" | "sync";
  metrics: Record<string, unknown>;
  rawRef: string | null;
  sourceHash: string | null;
  version: number;
  frozen: boolean;
  createdAt: string;
  betTitle?: string | null;
  artifactTitle?: string | null;
}

export interface PwPrecedentView {
  verdictId: string;
  outcome: "gold" | "tomb";
  text: string;
  source: "own" | "mirror";
  promotion: { level: string; scope: string | null } | null;
  matchReason: string;
}

export interface PwBetDetail extends PwBetView {
  dataDocs: PwDataDocView[];
  precedents: PwPrecedentView[];
  /** /api/pw/bets/:id/context 的只读 Markdown（判例编号稳定，可点开复核）。 */
  contextMarkdown: string;
}

/* ------------------------------------------------------------------ */
/* 金子墓碑库                                                          */
/* ------------------------------------------------------------------ */

export type PwOutcome = "gold" | "tomb" | "void";

export interface PwVerdictView {
  id: string;
  betId: string;
  betTitle: string | null;
  outcome: PwOutcome;
  lesson: string | null;
  causeOfDeath: string | null;
  evidenceDocIds: string[];
  confidenceSnapshot: number | null;
  decidedBy: "human";
  decidedAt: string;
  createdAt: string;
}

export interface PwVerdictEvidenceView {
  verdict: PwVerdictView;
  evidence: PwDataDocView[];
}

/* ------------------------------------------------------------------ */
/* 观众声音                                                            */
/* ------------------------------------------------------------------ */

export interface PwVoiceTheme {
  id: string;
  bvid: string;
  videoTitle: string | null;
  title: string;
  summary: string | null;
  status: "suggested" | "collected" | "rejected";
  itemCount: number;
  createdAt: string;
}

export interface PwVoiceItem {
  rpid: number;
  message: string;
  uname: string | null;
  like: number | null;
  ctime: number | null;
  collected: boolean;
  voiceId: string | null;
}

export interface PwVoiceThemeDetail extends PwVoiceTheme {
  items: PwVoiceItem[];
}

/* ------------------------------------------------------------------ */
/* 大盘笔记                                                            */
/* ------------------------------------------------------------------ */

export interface PwNoteView {
  uid: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  visibility: "PUBLIC" | "PROTECTED" | "PRIVATE";
  pinned: boolean;
  tags: string[];
  url: string;
}

export interface PwNoteTreeView {
  direction: string | null;
  bets: Array<{
    betId: string;
    title: string;
    status: string;
    dueDate: string | null;
    lastNoteAt: string | null;
    notes: Array<{ uid: string; keyword: string | null; createdAt: string; attachStatus: "confirmed" }>;
  }>;
  unassigned: Array<{ uid: string; keyword: string | null; createdAt: string; suggestedBetId: string | null }>;
}

/* ------------------------------------------------------------------ */
/* 运维数据源                                                          */
/* ------------------------------------------------------------------ */

export interface PwOpsStatus {
  server: {
    ready: boolean;
    node: string;
    modelConfigured: boolean;
    protocol: string | null;
    memory: { available: boolean; error?: string };
    verdicts: Record<string, unknown>;
  };
  connections: Array<{
    id: string;
    platform: string;
    accountLabel: string | null;
    status: "active" | "needs_human" | "paused";
    lastSyncAt: string | null;
    riskEvents: Array<{ at: string; reason: string }>;
    docsCount: number;
  }>;
  counts: {
    bets: number;
    pendingBets: number;
    verdicts: number;
    dataDocs: number;
    drafts: number;
    sievePending: number;
  };
  /** 4317 /api/pw/activity-daily 原样透传（轻量）。 */
  activity: unknown;
  fetchedAt: string;
}

/* ------------------------------------------------------------------ */
/* 推送区                                                              */
/* ------------------------------------------------------------------ */

export type PwPushKind = "daily" | "due" | "needs_human";

export interface PwPushSourceRef {
  type: "bet" | "sieve_card" | "draft" | "connection" | "voice_theme" | "note";
  id: string;
  label: string;
}

export interface PwPushFeedItem {
  id: string;
  kind: PwPushKind;
  title: string;
  summary: string;
  sourceRefs: PwPushSourceRef[];
  /** 本地日期 YYYY-MM-DD（daily 用；提醒类也有 createdAt）。 */
  date: string;
  createdAt: string;
  read: boolean;
}

export interface PwPushFeed {
  items: PwPushFeedItem[];
  unread: number;
}

/* ------------------------------------------------------------------ */
/* 写：AI 起草                                                         */
/* ------------------------------------------------------------------ */

export interface PwDraftBetInput {
  title: string;
  thesis: string;
  metric?: string | null;
  metricTarget?: string | null;
  metric_target?: string | null;
  confidence?: number | null;
  dataSourcePlan?: string | null;
  data_source_plan?: string | null;
  checkoutDate?: string | null;
  checkout_date?: string | null;
  goldRefs?: string[];
  gold_refs?: string[];
  kind?: "verdict" | "content";
  sourceCardId?: string | null;
}

export interface PwDraftBetResult {
  ok: true;
  draft: PwBetView & { createdFrom: string | null };
  draftHash: string;
}

/* ------------------------------------------------------------------ */
/* 写：人点按钮（挑/改/否/确认）                                       */
/* ------------------------------------------------------------------ */

export type PwActionKind = "pick" | "edit" | "reject" | "confirm";

export interface PwContentBetOverrides {
  title?: string;
  conversionSignal?: string;
  metricTarget?: string;
  reviewDate?: string;
}

export interface PwActionInput {
  action: PwActionKind;
  /**
   * pick/edit/reject 作用于候选卡（sieve_card）；
   * confirm 作用于草稿（draft）。缺省按 targetId 在 4317 侧语义推断。
   */
  targetType?: "sieve_card" | "draft";
  targetId: string;
  /** pick/edit 的可选改写（有 overrides = 改挑）。 */
  overrides?: PwContentBetOverrides;
  /** confirm 的可选编辑（确认转正前可带 edits）。 */
  edits?: PwDraftBetInput;
  reason?: string;
}

export interface PwActionSuccess {
  ok: true;
  action: PwActionKind;
  source: "human-click";
  result: unknown;
}

/* ------------------------------------------------------------------ */
/* agent 工具面                                                        */
/* ------------------------------------------------------------------ */

/**
 * host 半注册给 AI 的全部工具名。
 * 只读 8 个 + 唯一起草 1 个；禁止 settle/confirm/verdict 写 schema。
 */
export const PW_TOOL_NAMES = [
  "pw_list_bets",
  "pw_read_bet",
  "pw_read_data_docs",
  "pw_search_verdicts",
  "pw_read_verdict_evidence",
  "pw_query_voice",
  "pw_recall_notes",
  "pw_ops_status",
  "pw_draft_bet",
] as const;

export type PwToolName = (typeof PW_TOOL_NAMES)[number];

/** 验收自检：工具名黑名单（出现即返工）。 */
export const PW_FORBIDDEN_TOOL_SUBSTRINGS = ["settle", "confirm", "verdict_settle", "settle_bet", "confirm_bet"] as const;

/* ------------------------------------------------------------------ */
/* host 侧实现内部类型（client 不需要直接依赖）                         */
/* ------------------------------------------------------------------ */

export interface PwHostDeps {
  /** 4317 根地址，测试可注入。 */
  baseUrl?: string;
  /** 推送收件箱持久化目录；缺省 DSH_HOME/papertable/dsh-paperweight。 */
  dataDir?: string;
  /** 每日推送生成时间（本地 HH:MM），默认 06:30。 */
  dailyTime?: string;
}
