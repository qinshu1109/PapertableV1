/**
 * TASK-PW-32：素材起草管线（AI 给一张在途内容押注卡写三份素材大纲）。
 *
 * 照 runPwSieve 管线范式（src/pw-sieve.ts:589）：装配 → 单次 LLM 结构化产出
 * （非工具循环）→ 确定性后处理 → 落表 + 审计。LLM 注入点照 SieveLlm：
 * options.llm 注入 mock（测试），缺省 createPapertableProvider() 真实模型；
 * LLM 异常/JSON 失败重试 1 次。
 *
 * 数据真值源：写 pw_content_drafts（PW-31 createPwContentDrafts）与 pw_verdict_refs
 * （PW-30 recordPwVerdictRefs，source_kind='content_draft'）；读 pw_bets /
 * pw_sieve_cards / pw_content_draft_edits / pw_verdicts / pw_gold_mirror；
 * pw_runs 留痕（kind='ai_draft'、event_type='draft'，均在既有枚举内）。无新表。
 *
 * 质量四件套（验收硬门）：
 * ① 装配喂判断痕迹——否过的候选卡与草案、押注三行、改稿 diff 全进证据；
 * ② 三份对照散盘只出大纲——每份 5–7 行大纲节点，不写成稿、不下结论；
 * ③ bad case 集可回流——src/pw-eval-drafts.ts 复用本模块装配+prompt+parse+后处理，只打印不落库；
 * ④ 标题等易平庸字段只给候选——title_candidate 只给候选（可「｜」分隔多候选），不写死成稿标题。
 * 另两条防平庸停线：宣告扫描丢弃（墓碑/已避开/避开了/绕开/推荐选/建议选）；
 * 存活 <2 份整轮 failed 不产草案（对照至少两份才有意义）。
 *
 * §N 编号表：直接复用 buildCollabContext(db, betId) 的 golds/tombs 装配
 * （编号从 §1 起、墓碑续接），不自建第二套编号；pwCollabRefTable(context) 合成编号表。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { contentText } from "@earendil-works/pi-ai";
import { httpError } from "./data.ts";
import { getPwBet } from "./pw-bets.ts";
import {
  createPwContentDrafts,
  listPwDraftBadCases,
  type PwContentDraftRow,
} from "./pw-content-drafts.ts";
import { buildCollabContext } from "./pw-context.ts";
import { recordPwEvent } from "./pw-runs.ts";
import { pwCollabRefTable, recordPwVerdictRefs, type RefTableItem } from "./pw-verdict-refs.ts";
import { createPapertableProvider, type PapertableProvider } from "./provider-settings.ts";

/** 缺省三路：贴热点 / 少数派 / 反共识（每份走一路，互不混路）。 */
export const DEFAULT_DRAFT_ROUTES = ["贴热点", "少数派", "反共识"] as const;

/** 大纲节点数硬区间：越界即整份丢弃（成稿不宣告、不给结论的前提是节点够少够大纲化）。 */
const MIN_NODES = 5;
const MAX_NODES = 7;

/** 宣告扫描：成稿里不许出现的嘴脸（命中即整份丢弃，不落入草案）。 */
const DECLARATION_PATTERN = /墓碑|已避开|避开了|绕开|推荐选|建议选/u;

const REJECTED_CARDS_LIMIT = 5;
const BAD_CASES_LIMIT = 5;
const EDIT_TRAILS_LIMIT = 3;

// ---------------------------------------------------------------------------
// 起草器主提示词（中文常量，写死在代码里；集中导出供评测回流对比）
// ---------------------------------------------------------------------------

export const DRAFT_SYSTEM_PROMPT = [
  "你是「镇纸 Paperweight」的素材起草器：给一张在途内容押注卡写三份素材大纲。每份只出 5–7 行大纲节点，不写成稿、不下结论。",
  "1. 三份各走一路，互不混路：贴热点、少数派、反共识（严格按证据里给出的路子清单）。",
  "2. 对照输入证据，别重蹈覆辙：否过的候选卡与素材草案、改稿痕迹都是你该避开的坑；押注三行（假设/转化信号/看结果日）决定大纲方向；金子墓碑 §N 是唯一可引用的真判断。",
  "3. 标题只给候选，不写死成稿标题；可用「｜」分隔 2–3 个候选供人挑。",
  "4. 大纲节点可标 gold_ref（§N）：只能引用证据里编号表给出的编号；没把握就写 null，禁止编造编号。",
  "5. 禁止出现「墓碑」「已避开」「避开了」「绕开」「推荐选」「建议选」等宣告/推荐措辞——只摆大纲，不宣告规避动作，不给选择建议。",
  "6. 只输出一个 JSON 数组，不要 Markdown 代码块以外的任何文字。格式：",
  '[{"route":"贴热点","title_candidate":"标题候选｜标题候选2","skeleton":[{"text":"大纲节点","gold_ref":"§1"},{"text":"大纲节点","gold_ref":null}]}]',
].join("\n");

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 单节点：大纲一行 + 可选真金子编号（§N，只可引编号表内的）。 */
export type DraftSkeletonNode = {
  text: string;
  gold_ref: string | null;
};

/** 模型输出的单份草案（parseDraftJson 产物）。 */
export type ParsedDraft = {
  route: string;
  titleCandidate: string;
  skeleton: DraftSkeletonNode[];
};

/** LLM 注入点：与 SieveLlm 同形，测试注入 mock。 */
export type DraftLlm = (inputText: string) => Promise<string>;

/** 确定性装配产物：押注三行 + 否过候选卡 + 否过草案 + 改稿痕迹 + 金子墓碑编号表。 */
export type DraftEvidence = {
  bet: {
    id: string;
    title: string;
    thesis: string;
    metric: string | null;
    metricTarget: string | null;
    dataSourcePlan: string | null;
    checkoutDate: string | null;
    confidence: number | null;
  };
  rejectedCards: Array<{ quoteText: string; reason: string | null }>;
  badCases: Array<{
    route: string;
    titleCandidate: string;
    rejectReason: string | null;
    betTitle: string | null;
  }>;
  editTrails: Array<{ before: string; after: string }>;
  /** buildCollabContext 的整块 markdown（金子/墓碑 §N 编号 + 押注卡/数据文档等上下文）。 */
  collabMarkdown: string;
  /** pwCollabRefTable 编号表：§N → verdict（管线落引用与后处理共用同一套）。 */
  refTable: RefTableItem[];
};

export type DraftRunOptions = {
  /** 注入 mock llm（测试）；缺省用 createPapertableProvider 的真实模型。 */
  llm?: DraftLlm;
  /** 本批路子（缺省三路）；提示词与留痕都用它。 */
  routes?: readonly string[];
  /** 本批批次 id（缺省自动生成）。 */
  batchId?: string;
  /** 注入 llm 时记录到留痕 payload.model 的标签（缺省 null）。 */
  modelLabel?: string | null;
  /** TASK-PW-33：发动来源，进留痕 payload.trigger（缺省 "manual"）。 */
  trigger?: string;
};

export type DraftRunResult = {
  batchId: string;
  /** 落库的草案行（存活 ≥2 份才有；否则空数组）。 */
  created: PwContentDraftRow[];
  /** 后处理丢弃明细（route + reason）。 */
  dropped: Array<{ route: string; reason: string }>;
  /** 丢弃原因去重汇总（供失败留痕与提示）。 */
  droppedReasons: string[];
  /** 引用落库统计：inserted 行数 + dropped 未命中标注（后处理已置 null，通常为空）。 */
  refStats: { inserted: number; dropped: string[] };
};

// ---------------------------------------------------------------------------
// 装配：buildDraftEvidence（确定性读取，导出供测试与评测）
// ---------------------------------------------------------------------------

/**
 * 确定性装配起草证据。非 content 或非 pending 押注 → 409（仅 in-flight 内容押注卡可起草）；
 * 押注不存在同样 409（不是合法内容押注卡）。
 */
export function buildDraftEvidence(db: DatabaseSync, betId: string): DraftEvidence {
  const bet = getPwBet(db, betId);
  if (!bet || bet.kind !== "content" || bet.status !== "pending") {
    throw httpError(409, "仅 in-flight 内容押注卡可起草（kind=content、status=pending）");
  }

  // 否过的候选卡（近 5 张）：reason 从 pw_runs reject 事件 payload 解析，找不到则 null
  const rejectReasonByCard = collectRejectReasons(db);
  const rejectedCardRows = db.prepare(`
    SELECT id, quote_text FROM pw_sieve_cards
    WHERE status = 'rejected'
    ORDER BY created_at DESC, id DESC
    LIMIT ${REJECTED_CARDS_LIMIT}
  `).all() as Array<{ id: string; quote_text: string }>;
  const rejectedCards = rejectedCardRows.map((row) => ({
    quoteText: row.quote_text,
    reason: rejectReasonByCard.get(row.id) ?? null,
  }));

  // 否过的素材草案（bad case 集近 5 条，新在前）
  const badCases = [...listPwDraftBadCases(db)].slice(-BAD_CASES_LIMIT).reverse().map((row) => ({
    route: row.route,
    titleCandidate: row.title_candidate,
    rejectReason: row.reject_reason,
    betTitle: row.bet_title,
  }));

  // 改稿痕迹（近 3 条，before → after）
  const editRows = db.prepare(`
    SELECT before_json, after_json FROM pw_content_draft_edits
    ORDER BY created_at DESC, id DESC
    LIMIT ${EDIT_TRAILS_LIMIT}
  `).all() as Array<{ before_json: string; after_json: string }>;
  const editTrails = editRows.map((row) => ({ before: row.before_json, after: row.after_json }));

  // 金子墓碑：直接复用协作台装配（golds/tombs 区块 + §N 编号表），不自建第二套编号
  const context = buildCollabContext(db, betId);

  return {
    bet: {
      id: bet.id,
      title: bet.title,
      thesis: bet.thesis,
      metric: bet.metric,
      metricTarget: bet.metric_target,
      dataSourcePlan: bet.data_source_plan,
      checkoutDate: bet.checkout_date,
      confidence: bet.confidence,
    },
    rejectedCards,
    badCases,
    editTrails,
    collabMarkdown: context.markdown,
    refTable: pwCollabRefTable(context),
  };
}

/** pw_runs 全部 reject 事件的 cardId/cardIds → reason（后到覆盖先到；损坏 payload 跳过）。 */
function collectRejectReasons(db: DatabaseSync): Map<string, string | null> {
  const rows = db.prepare(`
    SELECT payload_json FROM pw_runs WHERE event_type = 'reject' ORDER BY created_at, rowid
  `).all() as Array<{ payload_json: string }>;
  const byCard = new Map<string, string | null>();
  for (const row of rows) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      continue;
    }
    if (!isRecord(payload)) continue;
    const reason = typeof payload.reason === "string" ? payload.reason : null;
    if (typeof payload.cardId === "string") byCard.set(payload.cardId, reason);
    if (Array.isArray(payload.cardIds)) {
      for (const cardId of payload.cardIds) {
        if (typeof cardId === "string") byCard.set(cardId, reason);
      }
    }
  }
  return byCard;
}

// ---------------------------------------------------------------------------
// 提示词拼装：buildDraftPrompt（导出供评测）
// ---------------------------------------------------------------------------

/**
 * DRAFT_SYSTEM_PROMPT 之外的用户侧证据区块。routes 缺省三路；
 * 显式传 routes 时（runPwDraftPipeline 透传）提示词与留痕一致。
 */
export function buildDraftPrompt(
  evidence: DraftEvidence,
  routes: readonly string[] = DEFAULT_DRAFT_ROUTES,
): string {
  const sections: string[] = [];
  sections.push(
    "### 本批路子（三份各走一路）\n"
    + routes.map((route) => `- ${route}`).join("\n"),
  );
  sections.push(
    "### 当前押注卡（三行）\n"
    + [
      `- 押注：${evidence.bet.title}`,
      `- 假设：${evidence.bet.thesis}`,
      `- 转化信号：${evidence.bet.metric ?? "—"}${evidence.bet.metricTarget ? `（目标 ${evidence.bet.metricTarget}）` : ""}`,
      `- 看结果日：${evidence.bet.checkoutDate ?? "—"} · 置信度：${evidence.bet.confidence ?? "—"}%`,
    ].join("\n"),
  );
  sections.push(
    "### 否过的候选卡（对照，别重蹈覆辙）\n"
    + (evidence.rejectedCards.length
      ? evidence.rejectedCards
        .map((card) => `- ${card.quoteText}${card.reason ? `（否因：${card.reason}）` : ""}`)
        .join("\n")
      : "（无）"),
  );
  sections.push(
    "### 否过的素材草案（bad case，对照）\n"
    + (evidence.badCases.length
      ? evidence.badCases
        .map((bad) => `- [${bad.route}] ${bad.titleCandidate}（押注：${bad.betTitle ?? "?"}${bad.rejectReason ? `；否因：${bad.rejectReason}` : ""}）`)
        .join("\n")
      : "（无）"),
  );
  sections.push(
    "### 改稿痕迹（近 3 条，before → after）\n"
    + (evidence.editTrails.length
      ? evidence.editTrails.map((edit) => `- ${edit.before} → ${edit.after}`).join("\n")
      : "（无）"),
  );
  sections.push(
    "### 有效判断与墓碑（编号表：§N 只可从这里引用）\n"
    + (evidence.collabMarkdown.trim() ? evidence.collabMarkdown : "（无）"),
  );
  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// LLM：单次结构化产出（非工具循环）；测试注入 mock llm
// ---------------------------------------------------------------------------

function defaultDraftLlm(provider: PapertableProvider): DraftLlm {
  return async (inputText) => {
    const response = await provider.models.completeSimple(provider.model, {
      systemPrompt: DRAFT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: inputText, timestamp: Date.now() }],
    }, {
      maxTokens: 6000,
      timeoutMs: 60_000,
      maxRetries: 0,
      maxRetryDelayMs: 0,
    });
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage || `起草器调用失败：${response.stopReason}`);
    }
    return contentText(response.content, "");
  };
}

/**
 * JSON 校验：顶层数组，每份 route/title_candidate 非空、skeleton 为数组、
 * 节点至少含 text 非空、gold_ref 为 '§N' 或 null；不合格抛错（触发重试 1 次）。
 */
export function parseDraftJson(raw: string): ParsedDraft[] {
  const unwrapped = raw.trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapped);
  } catch {
    throw new Error("草案输出不是合法 JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("草案输出必须是 JSON 数组");
  const result: ParsedDraft[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) throw new Error("每份草案必须是 JSON 对象");
    const route = item.route;
    if (typeof route !== "string" || !route.trim()) throw new Error("草案缺 route");
    const titleCandidate = item.title_candidate;
    if (typeof titleCandidate !== "string" || !titleCandidate.trim()) {
      throw new Error("草案缺 title_candidate");
    }
    const skeleton = item.skeleton;
    if (!Array.isArray(skeleton)) throw new Error("草案 skeleton 必须是数组");
    const nodes: DraftSkeletonNode[] = [];
    for (const node of skeleton) {
      if (!isRecord(node)) throw new Error("skeleton 节点必须是对象");
      if (typeof node.text !== "string" || !node.text.trim()) throw new Error("skeleton 节点缺 text");
      const goldRef = node.gold_ref;
      if (goldRef !== null && goldRef !== undefined) {
        if (typeof goldRef !== "string" || !/^§\d+$/u.test(goldRef)) {
          throw new Error("gold_ref 必须是 §N 或 null");
        }
      }
      nodes.push({
        text: node.text.trim(),
        gold_ref: typeof goldRef === "string" ? goldRef : null,
      });
    }
    result.push({
      route: route.trim(),
      titleCandidate: titleCandidate.trim(),
      skeleton: nodes,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// 确定性后处理（不信模型自报）：节点数 / 重复路子 / 宣告扫描 / gold_ref 规范化
// ---------------------------------------------------------------------------

export type PostProcessResult = {
  kept: ParsedDraft[];
  dropped: Array<{ route: string; reason: string }>;
};

/**
 * 确定性后处理（导出供测试与评测）：
 * - 节点数 5–7，越界 → 整份 drop；
 * - 同一路子多份 → 只留第一份，其余 drop；
 * - 宣告扫描：title+skeleton 文本命中「墓碑/已避开/避开了/绕开/推荐选/建议选」→ 整份 drop；
 * - gold_ref 在编号表外 → 置 null 并记一条 dropped（不清退整份）。
 */
export function postProcessDrafts(
  parsed: ParsedDraft[],
  refTable: RefTableItem[],
): PostProcessResult {
  const inTable = new Set(refTable.map((item) => item.ref));
  const kept: ParsedDraft[] = [];
  const dropped: Array<{ route: string; reason: string }> = [];
  const keptRoutes = new Set<string>();

  for (const draft of parsed) {
    const nodeCount = draft.skeleton.length;
    if (nodeCount < MIN_NODES || nodeCount > MAX_NODES) {
      dropped.push({ route: draft.route, reason: `节点数 ${nodeCount} 越界（须 ${MIN_NODES}–${MAX_NODES}）` });
      continue;
    }
    if (keptRoutes.has(draft.route)) {
      dropped.push({ route: draft.route, reason: `重复路子「${draft.route}」仅保留第一份` });
      continue;
    }
    const searchable = [draft.titleCandidate, ...draft.skeleton.map((node) => node.text)].join(" ");
    if (DECLARATION_PATTERN.test(searchable)) {
      dropped.push({ route: draft.route, reason: "宣告扫描命中（成稿不宣告、不给结论）" });
      continue;
    }
    const badRefs: string[] = [];
    const normalized = draft.skeleton.map((node) => {
      if (node.gold_ref !== null && !inTable.has(node.gold_ref)) {
        badRefs.push(node.gold_ref);
        return { text: node.text, gold_ref: null as string | null };
      }
      return node;
    });
    if (badRefs.length > 0) {
      dropped.push({ route: draft.route, reason: `gold_ref ${badRefs.join(" ")} 不在编号表，已置 null` });
    }
    keptRoutes.add(draft.route);
    kept.push({ ...draft, skeleton: normalized });
  }
  return { kept, dropped };
}

// ---------------------------------------------------------------------------
// 主管线 runPwDraftPipeline
// ---------------------------------------------------------------------------

/**
 * 单次起草：装配 → 单次 LLM 结构化产出（非工具循环）→ 确定性后处理 →
 * 存活 ≥2 份才落草稿表（PW-31）+ §N 引用落库（PW-30）+ 审计事件。
 * LLM 异常 / JSON 校验失败重试 1 次；仍败置 failed 零草案。
 * 防平庸停线：后处理存活 <2 份整轮 failed 不产草案（对照至少两份才有意义）。
 */
export async function runPwDraftPipeline(
  db: DatabaseSync,
  betId: string,
  options: DraftRunOptions = {},
): Promise<DraftRunResult> {
  const routes = options.routes && options.routes.length > 0
    ? [...options.routes]
    : [...DEFAULT_DRAFT_ROUTES];
  const batchId = options.batchId !== undefined && options.batchId.trim()
    ? options.batchId.trim()
    : randomUUID();
  const evidence = buildDraftEvidence(db, betId);

  let provider: PapertableProvider | null = null;
  const llm = options.llm ?? null;
  let model = options.modelLabel ?? null;
  if (!llm) {
    provider = createPapertableProvider();
    model = provider.model.id;
  }
  const runLlm = llm ?? defaultDraftLlm(provider!);

  const fail = (
    error: string,
    state: { dropped: Array<{ route: string; reason: string }>; droppedReasons: string[] } = { dropped: [], droppedReasons: [] },
  ): DraftRunResult => {
    recordPwEvent(db, {
      kind: "ai_draft",
      eventType: "draft",
      actor: "ai",
      betId,
      payloadJson: JSON.stringify({
        betId, batchId, routes, created: 0, dropped: state.droppedReasons, model, error,
        trigger: options.trigger ?? "manual",
      }),
    });
    return {
      batchId,
      created: [],
      dropped: state.dropped,
      droppedReasons: state.droppedReasons,
      refStats: { inserted: 0, dropped: [] },
    };
  };

  let parsed: ParsedDraft[] | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await runLlm(buildDraftPrompt(evidence, routes));
      parsed = parseDraftJson(raw);
      break;
    } catch (error) {
      lastError = error;
      // LLM 异常或 JSON 校验失败：第 2 次循环即重试 1 次
    }
  }
  if (!parsed) {
    return fail(`草案模型产出失败：${safeErrorText(lastError)}`);
  }

  const { kept, dropped } = postProcessDrafts(parsed, evidence.refTable);
  const droppedReasons = [...new Set(dropped.map((item) => item.reason))];
  if (kept.length < 2) {
    // 防平庸停线：对照至少两份才有意义（策略失败，重试不救，不产草案）
    return fail(
      `存活草案 ${kept.length} 份，少于 2 份（防平庸停线）${droppedReasons.length ? `：${droppedReasons.join("；")}` : ""}`,
      { dropped, droppedReasons },
    );
  }

  const created = createPwContentDrafts(db, betId, kept.map((draft) => ({
    route: draft.route,
    titleCandidate: draft.titleCandidate,
    skeletonJson: JSON.stringify(draft.skeleton),
  })), { batchId });

  const refStats = { inserted: 0, dropped: [] as string[] };
  for (const draft of created) {
    const result = recordPwVerdictRefs(db, {
      sourceKind: "content_draft",
      sourceId: draft.id,
      text: goldRefTextFromSkeleton(draft.skeleton_json),
      refTable: evidence.refTable,
    });
    refStats.inserted += result.inserted;
    refStats.dropped.push(...result.dropped);
  }

  recordPwEvent(db, {
    kind: "ai_draft",
    eventType: "draft",
    actor: "ai",
    betId,
    payloadJson: JSON.stringify({
      betId, batchId, routes, created: created.length, dropped: droppedReasons, model,
      trigger: options.trigger ?? "manual",
    }),
  });

  return { batchId, created, dropped, droppedReasons, refStats };
}

/** 从落库的 skeleton_json 提取全部 §N 标注（按节点序、去重交给 recordPwVerdictRefs）。 */
function goldRefTextFromSkeleton(skeletonJson: string): string {
  let nodes: unknown;
  try {
    nodes = JSON.parse(skeletonJson);
  } catch {
    return "";
  }
  if (!Array.isArray(nodes)) return "";
  const markers: string[] = [];
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    const ref = node.gold_ref;
    if (typeof ref === "string" && /^§\d+$/u.test(ref)) markers.push(ref);
  }
  return markers.join(" ");
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
