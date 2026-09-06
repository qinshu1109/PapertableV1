/**
 * host 半 4317 fetch 层。
 *
 * 铁律：只走 http://127.0.0.1:4317 HTTP API；不直连 SQLite、不建缓存镜像表。
 * 所有函数都是“现拉现裁”，个人量级毫秒级响应。
 */
import { createHash } from "node:crypto";
import {
  type PwBetKind,
  type PwBetStatus,
  type PwBetView,
  type PwDataDocView,
  type PwDraftBetInput,
  type PwDraftView,
  type PwOutcome,
  type PwPrecedentView,
  type PwVerdictView,
} from "../types.js";

/* ------------------------------------------------------------------ */
/* 通用 fetch                                                          */
/* ------------------------------------------------------------------ */

export class PwApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "PwApiError";
    this.status = status;
  }
}

export async function pwFetch(
  baseUrl: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  const requestSignal = signal
    ? AbortSignal.any([controller.signal, signal])
    : controller.signal;
  try {
    const res = await fetch(baseUrl + path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: requestSignal,
    });
    const text = await res.text();
    let data: any = null;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text.slice(0, 300) };
      }
    }
    if (!res.ok) {
      const message = data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `HTTP ${res.status}`;
      throw new PwApiError(`${method} ${path} 失败：${message}`, res.status);
    }
    return data;
  } catch (error) {
    if (error instanceof PwApiError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new PwApiError(`${method} ${path} 连接 4317 失败：${message}`, 0);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* 裁剪/装配                                                           */
/* ------------------------------------------------------------------ */

export function daysToCheckout(checkoutDate: string | null, status: PwBetStatus): number | null {
  if (!checkoutDate || status !== "pending") return null;
  const ms = Date.parse(`${checkoutDate}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  const now = Date.now();
  const diff = ms - now;
  return diff <= 0 ? 0 : Math.ceil(diff / 86_400_000);
}

export function normalizeBet(row: any): PwBetView {
  return {
    id: String(row.id),
    title: String(row.title ?? ""),
    thesis: String(row.thesis ?? ""),
    metric: row.metric ?? null,
    metricTarget: row.metric_target ?? row.metricTarget ?? null,
    confidence: row.confidence ?? null,
    dataSourcePlan: row.data_source_plan ?? row.dataSourcePlan ?? null,
    checkoutDate: row.checkout_date ?? row.checkoutDate ?? null,
    status: row.status as PwBetStatus,
    kind: (row.kind ?? "verdict") as PwBetKind,
    sourceCardId: row.source_card_id ?? row.sourceCardId ?? null,
    createdAt: row.created_at ?? row.createdAt ?? "",
    settledVerdictId: row.settled_verdict_id ?? row.settledVerdictId ?? null,
    daysToCheckout: daysToCheckout(
      row.checkout_date ?? row.checkoutDate ?? null,
      row.status as PwBetStatus,
    ),
    ...(row.draft_count === undefined ? {} : { draftCount: Number(row.draft_count) }),
  };
}

/** 把 4317 草稿行裁成 PwDraftView；draftHash 按 createDraft 同口径补算，失败则省略。 */
export function normalizeDraft(row: any): PwDraftView {
  const view: PwDraftView = normalizeBet(row);
  const hash = draftHashFromRow(row);
  if (hash) view.draftHash = hash;
  return view;
}

function draftHashFromRow(row: any): string | undefined {
  try {
    const rawRefs = row.gold_refs_json ?? row.goldRefs ?? row.gold_refs;
    const refs = Array.isArray(rawRefs)
      ? rawRefs.map(String)
      : JSON.parse(String(rawRefs ?? "[]"));
    return draftHashOf({
      title: String(row.title ?? ""),
      thesis: String(row.thesis ?? ""),
      metric: row.metric ?? null,
      metricTarget: row.metric_target ?? row.metricTarget ?? null,
      confidence: row.confidence ?? null,
      dataSourcePlan: row.data_source_plan ?? row.dataSourcePlan ?? null,
      checkoutDate: row.checkout_date ?? row.checkoutDate ?? null,
      goldRefs: Array.isArray(refs) ? refs.map(String).filter(Boolean) : [],
      kind: row.kind ?? "verdict",
    });
  } catch {
    return undefined;
  }
}

export function normalizeDataDoc(row: any): PwDataDocView {
  let metrics: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(row.metrics_json ?? "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      metrics = parsed as Record<string, unknown>;
    }
  } catch {
    metrics = { raw: String(row.metrics_json ?? "") };
  }
  return {
    id: String(row.id),
    betId: String(row.bet_id ?? row.betId ?? ""),
    artifactId: row.artifact_id ?? row.artifactId ?? null,
    platform: String(row.platform ?? ""),
    collectedAt: row.collected_at ?? row.collectedAt ?? "",
    method: (row.method ?? "manual") as "manual" | "export" | "sync",
    metrics,
    rawRef: row.raw_ref ?? row.rawRef ?? null,
    sourceHash: row.source_hash ?? row.sourceHash ?? null,
    version: Number(row.version ?? 1),
    frozen: Boolean(row.frozen),
    createdAt: row.created_at ?? row.createdAt ?? "",
    betTitle: row.bet_title ?? row.betTitle ?? null,
    artifactTitle: row.artifact_title ?? row.artifactTitle ?? null,
  };
}

export function normalizeVerdict(row: any, betTitle: string | null = null): PwVerdictView {
  let evidenceDocIds: string[] = [];
  try {
    const parsed = JSON.parse(String(row.evidence_doc_ids_json ?? "[]"));
    if (Array.isArray(parsed)) evidenceDocIds = parsed.map(String);
  } catch {
    evidenceDocIds = [];
  }
  return {
    id: String(row.id),
    betId: String(row.bet_id ?? row.betId ?? ""),
    betTitle: betTitle ?? row.bet_title ?? null,
    outcome: row.outcome as PwOutcome,
    lesson: row.lesson ?? null,
    causeOfDeath: row.cause_of_death ?? row.causeOfDeath ?? null,
    evidenceDocIds,
    confidenceSnapshot: row.confidence_snapshot ?? row.confidenceSnapshot ?? null,
    decidedBy: (row.decided_by ?? "human") as "human",
    decidedAt: row.decided_at ?? row.decidedAt ?? "",
    createdAt: row.created_at ?? row.createdAt ?? "",
  };
}

export function normalizePrecedent(row: any): PwPrecedentView {
  return {
    verdictId: String(row.verdictId ?? row.verdict_id ?? ""),
    outcome: row.outcome as "gold" | "tomb",
    text: String(row.text ?? ""),
    source: row.source as "own" | "mirror",
    promotion: row.promotion ?? null,
    matchReason: String(row.matchReason ?? row.match_reason ?? ""),
  };
}

/* ------------------------------------------------------------------ */
/* 4317 只读取数                                                       */
/* ------------------------------------------------------------------ */

export async function fetchBets(baseUrl: string, status?: string, signal?: AbortSignal): Promise<PwBetView[]> {
  const query = status && status !== "all" ? `?status=${encodeURIComponent(status)}` : "";
  const data = await pwFetch(baseUrl, "GET", `/api/pw/bets${query}`, undefined, signal);
  return (Array.isArray(data?.bets) ? data.bets : []).map(normalizeBet);
}

export async function fetchBet(baseUrl: string, betId: string): Promise<PwBetView> {
  const row = await pwFetch(baseUrl, "GET", `/api/pw/bets/${encodeURIComponent(betId)}`);
  return normalizeBet(row);
}

export async function fetchBetDataDocs(baseUrl: string, betId: string): Promise<PwDataDocView[]> {
  const data = await pwFetch(baseUrl, "GET", `/api/pw/bets/${encodeURIComponent(betId)}/data-docs`);
  return (Array.isArray(data?.docs) ? data.docs : []).map(normalizeDataDoc);
}

export async function fetchBetPrecedents(baseUrl: string, betId: string): Promise<PwPrecedentView[]> {
  const data = await pwFetch(baseUrl, "GET", `/api/pw/bets/${encodeURIComponent(betId)}/precedents`);
  return (Array.isArray(data?.items) ? data.items : []).map(normalizePrecedent);
}

export async function fetchBetContext(baseUrl: string, betId: string): Promise<string> {
  const data = await pwFetch(baseUrl, "GET", `/api/pw/bets/${encodeURIComponent(betId)}/context`);
  return String(data?.markdown ?? "");
}

export async function fetchAllDataDocs(baseUrl: string): Promise<PwDataDocView[]> {
  const data = await pwFetch(baseUrl, "GET", "/api/pw/data-docs");
  return (Array.isArray(data?.docs) ? data.docs : []).map(normalizeDataDoc);
}

/** 开场快照用：只拉判决行，不逐条 fetchBet 补标题。禁止 notice 走 fetchVerdicts()。 */
export async function fetchVerdictRows(baseUrl: string, signal?: AbortSignal): Promise<Array<{
  id: string;
  betId: string;
  outcome: string;
  lesson: string | null;
  causeOfDeath: string | null;
  decidedAt: string;
}>> {
  const data = await pwFetch(baseUrl, "GET", "/api/pw/verdicts", undefined, signal);
  const rows = Array.isArray(data?.verdicts) ? data.verdicts : [];
  return rows.map((row: any) => ({
    id: String(row.id),
    betId: String(row.bet_id ?? row.betId ?? ""),
    outcome: String(row.outcome ?? ""),
    lesson: row.lesson ?? null,
    causeOfDeath: row.cause_of_death ?? row.causeOfDeath ?? null,
    decidedAt: String(row.decided_at ?? row.decidedAt ?? ""),
  }));
}

export async function fetchVerdicts(
  baseUrl: string,
  options: { outcome?: string; q?: string } = {},
): Promise<PwVerdictView[]> {
  let path = "/api/pw/verdicts";
  if (options.q) {
    path = `/api/pw/verdicts/search?q=${encodeURIComponent(options.q)}`;
  } else if (options.outcome) {
    path = `/api/pw/verdicts?outcome=${encodeURIComponent(options.outcome)}`;
  }
  const data = await pwFetch(baseUrl, "GET", path);
  const rows = Array.isArray(data?.verdicts) ? data.verdicts : [];
  // 联查押注标题（每行 bet_id 逐个查；个人量级可接受）
  const withTitles: PwVerdictView[] = [];
  for (const row of rows) {
    let title: string | null = null;
    try {
      const bet = await fetchBet(baseUrl, String(row.bet_id));
      title = bet.title;
    } catch {
      title = null;
    }
    withTitles.push(normalizeVerdict(row, title));
  }
  return withTitles;
}

export async function fetchVerdictEvidence(
  baseUrl: string,
  verdictId: string,
): Promise<{ verdict: PwVerdictView; evidence: PwDataDocView[] }> {
  const all = await fetchVerdicts(baseUrl);
  const row = all.find((item) => item.id === verdictId);
  if (!row) throw new PwApiError(`判决不存在：${verdictId}`, 404);
  const docs = await fetchAllDataDocs(baseUrl);
  const byId = new Map(docs.map((doc) => [doc.id, doc]));
  const evidence = row.evidenceDocIds
    .map((id) => byId.get(id))
    .filter((doc): doc is PwDataDocView => Boolean(doc));
  return { verdict: row, evidence };
}

export async function fetchCorpus(baseUrl: string): Promise<Array<Record<string, unknown>>> {
  const data = await pwFetch(baseUrl, "GET", "/api/pw/corpus");
  return Array.isArray(data?.items) ? data.items : [];
}

export async function fetchVoiceCards(
  baseUrl: string,
  bvid: string,
  status = "suggested",
): Promise<{ id: string; bvid: string; title: string; summary: string | null; status: string; createdAt: string; items: any[] }[]> {
  const data = await pwFetch(
    baseUrl,
    "GET",
    `/api/pw/voice/corpus-cards?bvid=${encodeURIComponent(bvid)}&status=${encodeURIComponent(status)}`,
  );
  return Array.isArray(data?.cards) ? data.cards : [];
}

export async function fetchNotes(baseUrl: string, limit = 50): Promise<any[]> {
  const data = await pwFetch(baseUrl, "GET", `/api/pw/notes?limit=${limit}`);
  return Array.isArray(data?.notes) ? data.notes : [];
}

export async function fetchNotesStatus(baseUrl: string): Promise<Record<string, unknown>> {
  return pwFetch(baseUrl, "GET", "/api/pw/notes/status");
}

export async function fetchNotesTree(baseUrl: string): Promise<any> {
  return pwFetch(baseUrl, "GET", "/api/pw/notes/tree");
}

export async function fetchNotesRecall(baseUrl: string, betId: string): Promise<any> {
  return pwFetch(baseUrl, "GET", `/api/pw/notes/recall?betId=${encodeURIComponent(betId)}`);
}

export async function fetchConnections(baseUrl: string, signal?: AbortSignal): Promise<any[]> {
  const data = await pwFetch(baseUrl, "GET", "/api/pw/connections", undefined, signal);
  return Array.isArray(data?.connections) ? data.connections : [];
}

export async function fetchActivityDaily(baseUrl: string, days = 7): Promise<unknown> {
  const data = await pwFetch(baseUrl, "GET", `/api/pw/activity-daily?days=${days}`);
  return data ?? {};
}

export async function fetchServerStatus(baseUrl: string): Promise<Record<string, unknown>> {
  return pwFetch(baseUrl, "GET", "/api/status");
}

export async function fetchSieveCards(baseUrl: string, status?: string, signal?: AbortSignal): Promise<any[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  const data = await pwFetch(baseUrl, "GET", `/api/pw/sieve/cards${query}`, undefined, signal);
  return Array.isArray(data?.cards) ? data.cards : [];
}

export async function fetchDrafts(baseUrl: string, signal?: AbortSignal): Promise<PwDraftView[]> {
  const data = await pwFetch(baseUrl, "GET", "/api/pw/drafts", undefined, signal);
  return (Array.isArray(data?.drafts) ? data.drafts : []).map(normalizeDraft);
}

export async function fetchDueBets(baseUrl: string, signal?: AbortSignal): Promise<PwBetView[]> {
  const data = await pwFetch(baseUrl, "GET", "/api/pw/bets/due", undefined, signal);
  return (Array.isArray(data?.bets) ? data.bets : []).map(normalizeBet);
}

/* ------------------------------------------------------------------ */
/* 4317 写：仅两类                                                     */
/* ------------------------------------------------------------------ */

/** 与 4317 hashPwBetDraft 同口径的规范化草稿内容（字段顺序必须一致）。 */
function normalizeDraftContent(input: PwDraftBetInput): Record<string, unknown> {
  const text = (value: unknown): string | null =>
    value == null ? null : (String(value).trim() || null);
  const target = input.metricTarget !== undefined ? input.metricTarget : input.metric_target;
  const plan = input.dataSourcePlan !== undefined ? input.dataSourcePlan : input.data_source_plan;
  const date = input.checkoutDate !== undefined ? input.checkoutDate : input.checkout_date;
  const refs = input.gold_refs !== undefined ? input.gold_refs : input.goldRefs;
  return {
    title: text(input.title) ?? "",
    thesis: text(input.thesis) ?? "",
    metric: text(input.metric),
    metric_target: text(target),
    confidence: input.confidence == null ? null : Number(input.confidence),
    data_source_plan: text(plan),
    checkout_date: text(date),
    gold_refs: Array.isArray(refs) ? refs.map((ref) => String(ref).trim()).filter(Boolean) : [],
  };
}

export function draftHashOf(input: PwDraftBetInput): string {
  return createHash("sha256").update(JSON.stringify(normalizeDraftContent(input))).digest("hex");
}

export async function createDraft(
  baseUrl: string,
  input: PwDraftBetInput,
): Promise<{ draft: PwBetView & { createdFrom: string | null }; draftHash: string }> {
  const body: Record<string, unknown> = {
    ...normalizeDraftContent(input),
    kind: input.kind ?? "verdict",
  };
  if (input.sourceCardId !== undefined && input.sourceCardId !== null) {
    body.sourceCardId = input.sourceCardId;
  }
  body.source = "dsh-ai-draft";
  const row = await pwFetch(baseUrl, "POST", "/api/pw/drafts", body);
  return {
    draft: {
      ...normalizeBet(row),
      createdFrom: row.created_from ?? row.createdFrom ?? "dsh-ai-draft",
    },
    draftHash: draftHashOf(input),
  };
}
