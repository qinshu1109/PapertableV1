/**
 * 判决簿：MemOS 是唯一真值；本地表只承担草稿、写队列、缓存和实验事件。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { contentText } from "@earendil-works/pi-ai";
import {
  httpError,
  jsonObject,
  nowIso,
  requireCard,
  requireRun,
  type DataStore,
} from "./data.ts";
import type { PapertableEngine } from "./engine.ts";
import { callMemos } from "./memos.ts";
import {
  activeConversation,
  closeSession,
  openSessionById,
  type SessionRepo,
} from "./sessions.ts";
import {
  createVerdictRemote,
  normalizeVerdictInput,
  VerdictContractError,
  type RemoteVerdict,
  type RemoteVerdictList,
  type VerdictInput,
  type VerdictRemote,
  type VerdictSourceKind,
  type VerdictType,
} from "./verdict-memos.ts";
import { createPapertableProvider } from "./provider-settings.ts";

export const VERDICT_PROMPT_VERSION = "verdict-v2";
const LINE_LIMIT = 500;
// 每个干净上下文最多提供的有效判决条数；单项目超过后另立预筛任务，不在此处匹配。
const PROVIDE_LIMIT = 10;
const DEFAULT_REMOTE = createVerdictRemote(callMemos);
const pendingActions = new Map<string, Promise<unknown>>();

// TASK-PW-26：金子确认订阅——确认成功后逐个调监听（自动镜像等自主动作）；
// 单个监听抛错只吞掉自身，不拖垮确认返回。接线由主代理在 main.ts 完成。
type VerdictConfirmedListener = (db: DatabaseSync, verdictId: string) => void;
let verdictConfirmedListeners: VerdictConfirmedListener[] = [];

export function onVerdictConfirmed(fn: VerdictConfirmedListener): void {
  verdictConfirmedListeners.push(fn);
}

/** TASK-PW-26：测试复位模块级订阅（跨用例隔离）。 */
export function _resetVerdictConfirmedListenersForTest(): void {
  verdictConfirmedListeners = [];
}

export type VerdictAvailability = "available" | "degraded" | "unavailable";

export type VerdictTrace = {
  promptVersion: string;
  injectionEnabled: boolean;
  query: string;
  availability: VerdictAvailability;
  source: "memos" | "local-cache" | "none";
  /** 本轮实际提供给模型的有效判决（模型自行决定是否引用）。 */
  verdicts: Array<{
    id: string;
    verdictType: VerdictType;
    snapshot: string;
  }>;
  providedTotal: number;
  truncated: boolean;
  unavailableCode?: string;
};

export type VerdictContextItem = {
  id: string;
  verdictType: VerdictType;
  content: string;
};

export type VerdictSyncStatus = {
  available: boolean;
  pending: number;
  failed: number;
  usingLocalCache: boolean;
  error?: string;
};

export type VerdictRow = {
  id: string;
  project_id: string;
  card_id: string | null;
  run_id: string | null;
  kind: VerdictType;
  text: string;
  handle: string | null;
  status: "proposed" | "confirmed" | "superseded";
  memos_status: string;
  created_at: string;
  updated_at: string;
  source_kind: VerdictSourceKind | null;
  source_id: string | null;
  concepts_json: string;
  original_text: string | null;
  edit_ratio: number | null;
  idempotency_key: string | null;
  memos_memory_id: string | null;
  supersedes_local_id: string | null;
  supersedes_memory_id: string | null;
  retry_count: number;
  last_error: string | null;
  submitted_at: string | null;
  resumed_run_id: string | null;
  abandoned_at: string | null;
  draft_error: string | null;
};

const VERDICT_COLUMNS: Record<string, string> = {
  source_kind: "TEXT",
  source_id: "TEXT",
  concepts_json: "TEXT NOT NULL DEFAULT '[]'",
  original_text: "TEXT",
  edit_ratio: "REAL",
  idempotency_key: "TEXT",
  memos_memory_id: "TEXT",
  supersedes_local_id: "TEXT",
  supersedes_memory_id: "TEXT",
  retry_count: "INTEGER NOT NULL DEFAULT 0",
  last_error: "TEXT",
  submitted_at: "TEXT",
  resumed_run_id: "TEXT",
  abandoned_at: "TEXT",
  draft_error: "TEXT",
};

export function ensureVerdictTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pt_verdicts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES pt_projects(id) ON DELETE CASCADE,
      card_id TEXT,
      run_id TEXT,
      kind TEXT NOT NULL CHECK(kind IN ('tombstone', 'gold')),
      text TEXT NOT NULL,
      handle TEXT,
      status TEXT NOT NULL CHECK(status IN ('proposed', 'confirmed', 'superseded')),
      memos_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      source_kind TEXT,
      source_id TEXT,
      concepts_json TEXT NOT NULL DEFAULT '[]',
      original_text TEXT,
      edit_ratio REAL,
      idempotency_key TEXT,
      memos_memory_id TEXT,
      supersedes_local_id TEXT,
      supersedes_memory_id TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      submitted_at TEXT,
      resumed_run_id TEXT,
      abandoned_at TEXT,
      draft_error TEXT
    );
  `);
  const columns = new Set(
    (db.prepare("PRAGMA table_info(pt_verdicts)").all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
  for (const [name, definition] of Object.entries(VERDICT_COLUMNS)) {
    if (!columns.has(name)) db.exec(`ALTER TABLE pt_verdicts ADD COLUMN ${name} ${definition}`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS pt_verdicts_project
      ON pt_verdicts(project_id, status, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS pt_verdicts_idempotency
      ON pt_verdicts(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS pt_verdicts_memory
      ON pt_verdicts(memos_memory_id) WHERE memos_memory_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS pt_verdict_events (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES pt_projects(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL CHECK(event_type IN (
        'reroute-eligible',
        'tombstone-confirmed',
        'tombstone-rewritten',
        'tombstone-abandoned'
      )),
      target_card_id TEXT NOT NULL,
      source_card_id TEXT,
      source_id TEXT,
      verdict_id TEXT,
      original_text TEXT,
      final_text TEXT,
      edit_ratio REAL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pt_verdict_events_project
      ON pt_verdict_events(project_id, event_type, created_at);
  `);
  backfillVerdictRows(db);
}

function backfillVerdictRows(db: DatabaseSync): void {
  const rows = db.prepare("SELECT * FROM pt_verdicts ORDER BY created_at").all() as VerdictRow[];
  for (const row of rows) {
    const edge = row.kind === "tombstone" && row.card_id
      ? db.prepare("SELECT id FROM pt_edges WHERE target_card_id = ? LIMIT 1")
        .get(row.card_id) as { id: string } | undefined
      : undefined;
    const sourceKind = row.source_kind ?? (row.kind === "gold" ? "turn" : "edge");
    const sourceId = row.source_id
      ?? (row.kind === "gold" ? row.run_id : edge?.id)
      ?? row.id;
    const concepts = parseConcepts(row.concepts_json);
    const nextConcepts = concepts.length ? concepts : deriveConcepts(
      db,
      row.card_id,
      row.handle ? [row.handle] : [row.text],
    );
    let idempotencyKey = row.idempotency_key;
    if (row.status === "confirmed" && !idempotencyKey) {
      try {
        idempotencyKey = normalizeVerdictInput(
          rowInput({ ...row, source_kind: sourceKind, source_id: sourceId }, nextConcepts),
          row.supersedes_memory_id,
        ).idempotencyKey;
      } catch {
        // The retry path records an explicit failure if a legacy row cannot be repaired.
      }
    }
    db.prepare(`
      UPDATE pt_verdicts
      SET source_kind = ?, source_id = ?, concepts_json = ?, original_text = COALESCE(original_text, text),
          idempotency_key = COALESCE(idempotency_key, ?)
      WHERE id = ?
    `).run(sourceKind, sourceId, JSON.stringify(nextConcepts), idempotencyKey, row.id);
  }
}

function requireVerdict(db: DatabaseSync, id: string): VerdictRow {
  const row = db.prepare("SELECT * FROM pt_verdicts WHERE id = ?").get(id) as VerdictRow | undefined;
  if (!row) throw httpError(404, "判决不存在");
  return row;
}

function publicStatus(row: VerdictRow): "proposed" | "confirmed" | "superseded" | "abandoned" {
  return row.abandoned_at ? "abandoned" : row.status;
}

export function publicVerdict(row: VerdictRow): Record<string, unknown> {
  return {
    id: row.id,
    projectId: row.project_id,
    cardId: row.card_id,
    runId: row.run_id,
    kind: row.kind,
    text: row.text,
    handle: row.handle,
    status: publicStatus(row),
    memosStatus: row.memos_status,
    memoryId: row.memos_memory_id,
    syncError: row.last_error,
    originalText: row.original_text,
    editRatio: row.edit_ratio,
    supersedesMemoryId: row.supersedes_memory_id,
    resumedRunId: row.resumed_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listVerdicts(
  store: DataStore,
  projectId: string,
  remote: VerdictRemote = DEFAULT_REMOTE,
): Promise<{ verdicts: Array<Record<string, unknown>>; status: VerdictSyncStatus }> {
  let available = false;
  let error: string | undefined;
  try {
    const listed = await remote.list(projectId);
    cacheRemoteVerdicts(store.db, listed);
    available = true;
  } catch (cause) {
    error = safeMessage(cause);
  }
  const rows = store.db.prepare(`
    SELECT * FROM pt_verdicts WHERE project_id = ? ORDER BY created_at DESC
  `).all(projectId) as VerdictRow[];
  return {
    verdicts: rows.map(publicVerdict),
    status: localSyncStatus(store.db, available, error),
  };
}

export async function getVerdictStatus(
  store: DataStore,
  remote: VerdictRemote = DEFAULT_REMOTE,
): Promise<VerdictSyncStatus> {
  try {
    await remote.health();
    return localSyncStatus(store.db, true);
  } catch (error) {
    return localSyncStatus(store.db, false, safeMessage(error));
  }
}

function localSyncStatus(
  db: DatabaseSync,
  available: boolean,
  error?: string,
): VerdictSyncStatus {
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'confirmed' AND memos_status != 'submitted' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'confirmed' AND memos_status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM pt_verdicts
  `).get() as { pending: number | null; failed: number | null };
  return {
    available,
    pending: Number(counts.pending ?? 0),
    failed: Number(counts.failed ?? 0),
    usingLocalCache: !available,
    ...(error ? { error } : {}),
  };
}

export async function initializeVerdicts(
  store: DataStore,
  remote: VerdictRemote = DEFAULT_REMOTE,
): Promise<VerdictSyncStatus> {
  ensureVerdictTables(store.db);
  await retryPendingVerdicts(store, remote);
  return getVerdictStatus(store, remote);
}

export async function retryPendingVerdicts(
  store: DataStore,
  remote: VerdictRemote = DEFAULT_REMOTE,
): Promise<number> {
  const rows = store.db.prepare(`
    SELECT id FROM pt_verdicts
    WHERE status = 'confirmed' AND memos_status != 'submitted'
    ORDER BY created_at LIMIT 100
  `).all() as Array<{ id: string }>;
  for (const row of rows) {
    await syncVerdictToMemos(store, row.id, remote).catch(() => undefined);
  }
  return rows.length;
}

export async function syncVerdictToMemos(
  store: DataStore,
  id: string,
  remote: VerdictRemote = DEFAULT_REMOTE,
  stack = new Set<string>(),
): Promise<RemoteVerdict> {
  const key = `sync:${id}`;
  return serial(key, async () => {
    let row = requireVerdict(store.db, id);
    if (row.status !== "confirmed") throw new Error("只有用户确认的判决可以写入 MemOS");
    if (row.memos_status === "submitted" && row.memos_memory_id) {
      return remoteFromRow(row);
    }
    if (stack.has(id)) throw new Error("判决 supersede 链存在循环");
    stack.add(id);
    let supersedesMemoryId = row.supersedes_memory_id;
    if (row.supersedes_local_id && !supersedesMemoryId) {
      const parent = await syncVerdictToMemos(store, row.supersedes_local_id, remote, stack);
      supersedesMemoryId = parent.id;
      store.db.prepare(`
        UPDATE pt_verdicts SET supersedes_memory_id = ?, updated_at = ? WHERE id = ?
      `).run(parent.id, nowIso(), id);
      row = requireVerdict(store.db, id);
    }
    const normalized = normalizeVerdictInput(rowInput(row), supersedesMemoryId);
    store.db.prepare(`
      UPDATE pt_verdicts
      SET idempotency_key = ?, memos_status = 'submitting', last_error = NULL, updated_at = ?
      WHERE id = ?
    `).run(normalized.idempotencyKey, nowIso(), id);
    try {
      const result = supersedesMemoryId
        ? await remote.supersede(supersedesMemoryId, normalized)
        : await remote.confirm(normalized);
      if (result.verdict.idempotencyKey !== normalized.idempotencyKey) {
        throw new Error("MemOS 返回的幂等键与本地判决不一致");
      }
      store.db.prepare(`
        UPDATE pt_verdicts
        SET memos_status = 'submitted', memos_memory_id = ?, supersedes_memory_id = ?,
            last_error = NULL, submitted_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        result.verdict.id,
        result.verdict.supersedesMemoryId,
        nowIso(),
        nowIso(),
        id,
      );
      return result.verdict;
    } catch (error) {
      const message = safeMessage(error);
      store.db.prepare(`
        UPDATE pt_verdicts
        SET memos_status = 'failed', retry_count = retry_count + 1,
            last_error = ?, updated_at = ?
        WHERE id = ?
      `).run(message, nowIso(), id);
      throw error;
    }
  });
}

function remoteFromRow(row: VerdictRow): RemoteVerdict {
  const input = rowInput(row);
  return {
    id: row.memos_memory_id!,
    ...input,
    status: "confirmed",
    idempotencyKey: row.idempotency_key!,
    supersedesMemoryId: row.supersedes_memory_id,
  };
}

function cacheRemoteVerdicts(db: DatabaseSync, list: RemoteVerdictList): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const verdict of list.history) {
      const existing = db.prepare(`
        SELECT * FROM pt_verdicts
        WHERE memos_memory_id = ? OR idempotency_key = ? LIMIT 1
      `).get(verdict.id, verdict.idempotencyKey) as VerdictRow | undefined;
      const id = existing?.id ?? verdict.id;
      const now = nowIso();
      if (existing) {
        db.prepare(`
          UPDATE pt_verdicts
          SET text = ?, handle = ?, source_kind = ?, source_id = ?, concepts_json = ?,
              idempotency_key = ?, memos_memory_id = ?, supersedes_memory_id = ?,
              memos_status = 'submitted', last_error = NULL, submitted_at = COALESCE(submitted_at, ?),
              updated_at = ?
          WHERE id = ?
        `).run(
          verdict.content,
          verdict.verdictType === "gold" ? verdict.concepts[0] ?? null : existing.handle,
          verdict.sourceKind,
          verdict.sourceId,
          JSON.stringify(verdict.concepts),
          verdict.idempotencyKey,
          verdict.id,
          verdict.supersedesMemoryId,
          now,
          now,
          id,
        );
      } else {
        db.prepare(`
          INSERT INTO pt_verdicts(
            id, project_id, card_id, run_id, kind, text, handle, status, memos_status,
            created_at, updated_at, source_kind, source_id, concepts_json, original_text,
            idempotency_key, memos_memory_id, supersedes_memory_id, retry_count, submitted_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, 'confirmed', 'submitted', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        `).run(
          id,
          verdict.projectId,
          verdict.sourceCardId ?? null,
          verdict.sourceTurnId ?? null,
          verdict.verdictType,
          verdict.content,
          verdict.verdictType === "gold" ? verdict.concepts[0] ?? null : null,
          now,
          now,
          verdict.sourceKind,
          verdict.sourceId,
          JSON.stringify(verdict.concepts),
          verdict.content,
          verdict.idempotencyKey,
          verdict.id,
          verdict.supersedesMemoryId,
          now,
        );
      }
    }
    for (const verdict of list.history) {
      if (!verdict.supersedesMemoryId) continue;
      const parent = db.prepare(
        "SELECT id FROM pt_verdicts WHERE memos_memory_id = ?",
      ).get(verdict.supersedesMemoryId) as { id: string } | undefined;
      const child = db.prepare(
        "SELECT id FROM pt_verdicts WHERE memos_memory_id = ?",
      ).get(verdict.id) as { id: string } | undefined;
      if (parent) {
        db.prepare("UPDATE pt_verdicts SET status = 'superseded' WHERE id = ?")
          .run(parent.id);
      }
      if (parent && child) {
        db.prepare("UPDATE pt_verdicts SET supersedes_local_id = ? WHERE id = ?")
          .run(parent.id, child.id);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function loadVerdictContext(
  store: DataStore,
  input: { projectId: string; cardId: string; question: string },
  remote: VerdictRemote = DEFAULT_REMOTE,
): Promise<{ items: readonly VerdictContextItem[]; trace: VerdictTrace }> {
  requireCard(store.db, input.cardId);
  const injectionEnabled = process.env.PAPERTABLE_VERDICT_INJECTION !== "off";
  let provided: VerdictContextItem[] = [];
  let availability: VerdictAvailability = "available";
  let source: VerdictTrace["source"] = "memos";
  let unavailableCode: string | undefined;
  try {
    // 不做系统侧相关性匹配：提供本项目全部有效判决，由模型按本轮问题自行
    // 决定是否引用，引用必须显式标注（见 verdictInjectionBlock 契约）。
    const listed = await remote.list(input.projectId);
    cacheRemoteVerdicts(store.db, listed);
    provided = freezeRemoteVerdicts(input.projectId, listed);
  } catch (error) {
    unavailableCode = error instanceof VerdictContractError
      ? "invalid_remote_contract"
      : "unavailable";
    provided = localVerdictContextItems(store.db, input.projectId);
    availability = provided.length ? "degraded" : "unavailable";
    source = provided.length ? "local-cache" : "none";
  }
  const providedTotal = provided.length;
  const truncated = providedTotal > PROVIDE_LIMIT;
  const items = truncated ? provided.slice(0, PROVIDE_LIMIT) : provided;
  const trace: VerdictTrace = {
    promptVersion: VERDICT_PROMPT_VERSION,
    injectionEnabled,
    query: input.question,
    availability,
    source: items.length ? source : "none",
    verdicts: items.map((item) => ({
      id: item.id,
      verdictType: item.verdictType,
      snapshot: item.content,
    })),
    providedTotal,
    truncated,
    ...(unavailableCode ? { unavailableCode } : {}),
  };
  return { items: injectionEnabled ? Object.freeze(items) : Object.freeze([]), trace };
}

/**
 * 从完成回答中提取模型显式标注的 [[verdict:id]]：只承认本轮提供集合内的 id，
 * 按首次出现去重；伪造或未知 id 计入 unknownCount，绝不冒充复用。
 */
export function extractVerdictUse(
  answer: string,
  providedIds: readonly string[],
): { used: string[]; unknownCount: number } {
  const provided = new Set(providedIds);
  const used: string[] = [];
  let unknownCount = 0;
  for (const match of answer.matchAll(/\[\[verdict:([^\]\s]+)\]\]/gu)) {
    const id = match[1];
    if (!provided.has(id)) {
      unknownCount += 1;
    } else if (!used.includes(id)) {
      used.push(id);
    }
  }
  return { used, unknownCount };
}

function freezeRemoteVerdicts(
  projectId: string,
  response: RemoteVerdictList,
): VerdictContextItem[] {
  const valid = (verdict: RemoteVerdict): VerdictContextItem | null => {
    const content = safeLine(verdict.content);
    if (
      verdict.projectId !== projectId
      || verdict.status !== "confirmed"
      || !content
    ) {
      return null;
    }
    return { id: verdict.id, verdictType: verdict.verdictType, content };
  };
  const history = response.history
    .map((source) => ({ source, item: valid(source) }))
    .filter((value): value is { source: RemoteVerdict; item: VerdictContextItem } =>
      Boolean(value.item));
  const advertisedTails = new Set(
    response.verdicts.map(valid).filter((item): item is VerdictContextItem => Boolean(item))
      .map((item) => item.id),
  );
  const superseded = new Set(
    history.map(({ source }) => source.supersedesMemoryId).filter(Boolean),
  );
  const seen = new Set<string>();
  return history
    .map(({ item }) => item)
    .filter((item) =>
      advertisedTails.has(item.id)
      && !superseded.has(item.id)
      && !seen.has(item.id)
      && Boolean(seen.add(item.id)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function localVerdictContextItems(
  db: DatabaseSync,
  projectId: string,
): VerdictContextItem[] {
  const rows = db.prepare(`
    SELECT * FROM pt_verdicts
    WHERE project_id = ? AND status = 'confirmed' AND abandoned_at IS NULL
    ORDER BY created_at
  `).all(projectId) as VerdictRow[];
  const superseded = new Set(rows.map((row) => row.supersedes_local_id).filter(Boolean));
  return rows
    .flatMap((row) => {
      const content = safeLine(row.text);
      if (!content || superseded.has(row.id)) return [];
      return [{ id: row.memos_memory_id ?? row.id, verdictType: row.kind, content }];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function verdictInjectionBlock(
  items: readonly VerdictContextItem[],
  availability: VerdictAvailability,
): string {
  if (!items.length) return "";
  const lines = [
    "",
    "<verdict_ledger>",
    "以下不是参考资料，而是用户亲自确认过的判决，效力高于普通资料。规则：回答前先逐条核对每条金子——只要它的结论与本回答的论述一致、能够支持本回答或与本轮问题直接相关，就视为参考，必须在对应论述的句末附上该条的标注令牌（原样照抄）；只有与本轮问题完全无关的金子才不附。不得为了显得尊重而附确实没有参考的判决。墓碑是用户否决过的默认方向：任何时候都必须避开，无需标注。不得修改或伪造这些判决；前提明显变化时可以说明为何建议重审。",
  ];
  if (availability === "degraded") {
    lines.push("MemOS 当前不可用；以下来自本机待同步/缓存副本，本轮必须明确视为降级使用，不得假装远端召回成功。");
  }
  for (const item of items) {
    if (item.verdictType === "gold") {
      lines.push(`金子 | 结论：${item.content} | 标注令牌（原样照抄）：[[verdict:${item.id}]]`);
    } else {
      lines.push(`墓碑 | 结论：${item.content} | 必须避开，无需标注`);
    }
  }
  lines.push("</verdict_ledger>");
  return lines.join("\n");
}

export type RerouteRound = {
  user: { entryId: string; text: string };
  assistant: { entryId: string; text: string };
};

export function extractCutRerouteRounds(
  conversation: Array<{ entryId: string; role: "user" | "assistant"; text: string }>,
  sourceEntryId: string,
): RerouteRound[] {
  const start = conversation.findIndex(
    (entry) => entry.entryId === sourceEntryId && entry.role === "user",
  );
  if (start < 0) return [];
  const rounds: RerouteRound[] = [];
  for (let index = start; index < conversation.length - 1; index += 1) {
    const user = conversation[index];
    const assistant = conversation[index + 1];
    if (user.role === "user" && assistant.role === "assistant") {
      rounds.push({ user, assistant });
      index += 1;
    }
  }
  return rounds;
}

export function rewriteRatio(before: string, after: string): number {
  const left = [...before];
  const right = [...after];
  if (!left.length) return right.length ? 1 : 0;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column];
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length] / Math.max(left.length, right.length, 1);
}

export async function createTombstoneDraft(
  store: DataStore,
  sessions: SessionRepo,
  targetCardId: string,
  draft: (material: string) => Promise<string> = draftTombstone,
): Promise<Record<string, unknown> | null> {
  const card = requireCard(store.db, targetCardId);
  if (card.branch_kind !== "reroute" || !card.source_card_id) return null;
  const context = jsonObject(card.branch_context_json);
  const sourceEntryId = String(context.sourceEntryId || "");
  const sourceCard = requireCard(store.db, card.source_card_id);
  const session = await openSessionById(sessions, sourceCard.session_id, sourceCard.project_id);
  let rounds: RerouteRound[];
  try {
    rounds = extractCutRerouteRounds(await activeConversation(session), sourceEntryId);
  } finally {
    await closeSession(session).catch(() => undefined);
  }
  if (!rounds.length) return null;
  const material = [
    `来源卡片：${sourceCard.title}`,
    ...rounds.flatMap((round, index) => [
      `第 ${index + 1} 轮用户：${round.user.text}`,
      `第 ${index + 1} 轮助手：${round.assistant.text}`,
    ]),
  ].join("\n");
  let draftError: string | null = null;
  let text: string;
  try {
    text = normalizeLine(await draft(material));
  } catch (error) {
    draftError = safeMessage(error);
    const replaced = String(context.replacedQuestion || sourceCard.title);
    text = normalizeLine(`用户否决了「${replaced}」这条推进方向，改道后不再把它作为默认答案。`);
  }
  const edge = store.db.prepare(
    "SELECT id FROM pt_edges WHERE target_card_id = ? AND kind = 'reroute' LIMIT 1",
  ).get(targetCardId) as { id: string } | undefined;
  if (!edge) throw new Error("改道边不存在，不能起草墓碑");
  const id = randomUUID();
  const now = nowIso();
  const concepts = deriveConcepts(store.db, targetCardId, [
    String(context.pendingQuestion || card.title),
    card.title,
    ...cardConcepts(store.db, sourceCard.id),
  ]);
  store.db.exec("BEGIN IMMEDIATE");
  try {
    store.db.prepare(`
      INSERT INTO pt_verdicts(
        id, project_id, card_id, run_id, kind, text, handle, status, memos_status,
        created_at, updated_at, source_kind, source_id, concepts_json, original_text, draft_error
      ) VALUES(?, ?, ?, NULL, 'tombstone', ?, NULL, 'proposed', 'not_applicable',
        ?, ?, 'edge', ?, ?, ?, ?)
    `).run(
      id,
      card.project_id,
      targetCardId,
      text,
      now,
      now,
      edge.id,
      JSON.stringify(concepts),
      text,
      draftError,
    );
    recordVerdictEvent(store.db, {
      projectId: card.project_id,
      type: "reroute-eligible",
      targetCardId,
      sourceCardId: sourceCard.id,
      sourceId: edge.id,
      verdictId: id,
      originalText: text,
    });
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
  return publicVerdict(requireVerdict(store.db, id));
}

async function draftTombstone(material: string): Promise<string> {
  const { models, model } = createPapertableProvider();
  const response = await models.completeSimple(model, {
    systemPrompt:
      "根据被改道裁掉的完整问答，起草一句墓碑：只说明这条旧方向为何不再作为默认答案。不得扩展新事实，不得给建议，不得使用换行，只输出一句最多 500 字的正文。",
    messages: [{
      role: "user",
      content: material.slice(0, 120_000),
      timestamp: Date.now(),
    }],
  }, {
    maxTokens: 600,
    timeoutMs: 30_000,
    maxRetries: 2,
    maxRetryDelayMs: 12_000,
  });
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage || `墓碑起草失败：${response.stopReason}`);
  }
  return contentText(response.content, "");
}

export async function confirmVerdict(
  store: DataStore,
  engine: PapertableEngine,
  id: string,
  textOverride?: string,
  remote: VerdictRemote = DEFAULT_REMOTE,
): Promise<{ verdict: Record<string, unknown>; runId: string }> {
  return serial(`confirm:${id}`, async () => {
    let row = requireVerdict(store.db, id);
    if (row.status === "superseded") throw httpError(409, "判决已被 supersede，不能再确认");
    if (row.abandoned_at) throw httpError(409, "这张墓碑已经明确放弃");
    if (row.status !== "confirmed") {
      const original = normalizeLine(row.original_text ?? row.text);
      const finalText = normalizeLine(textOverride ?? row.text);
      const ratio = rewriteRatio(original, finalText);
      const normalized = normalizeVerdictInput({
        ...rowInput({ ...row, text: finalText }),
        content: finalText,
      });
      store.db.exec("BEGIN IMMEDIATE");
      try {
        store.db.prepare(`
          UPDATE pt_verdicts
          SET text = ?, status = 'confirmed', memos_status = 'pending', original_text = ?,
              edit_ratio = ?, idempotency_key = ?, updated_at = ?
          WHERE id = ?
        `).run(finalText, original, ratio, normalized.idempotencyKey, nowIso(), id);
        recordVerdictEvent(store.db, {
          projectId: row.project_id,
          type: "tombstone-confirmed",
          targetCardId: row.card_id!,
          sourceId: row.source_id ?? undefined,
          verdictId: id,
          originalText: original,
          finalText,
          editRatio: ratio,
        });
        if (ratio > 0) {
          recordVerdictEvent(store.db, {
            projectId: row.project_id,
            type: "tombstone-rewritten",
            targetCardId: row.card_id!,
            sourceId: row.source_id ?? undefined,
            verdictId: id,
            originalText: original,
            finalText,
            editRatio: ratio,
          });
        }
        store.db.exec("COMMIT");
      } catch (error) {
        store.db.exec("ROLLBACK");
        throw error;
      }
      row = requireVerdict(store.db, id);
    }
    await syncVerdictToMemos(store, id, remote).catch(() => undefined);
    const runId = await resumeReroute(store, engine, id);
    const result = { verdict: publicVerdict(requireVerdict(store.db, id)), runId };
    // TASK-PW-26：确认成功后逐个调监听（自动镜像 actor=system）；监听抛错不拖垮确认。
    for (const listener of verdictConfirmedListeners) {
      try {
        listener(store.db, id);
      } catch {
        // 镜像等自主动作失败不拖垮确认（人工后路按钮/路由仍在）。
      }
    }
    return result;
  });
}

export async function abandonTombstone(
  store: DataStore,
  engine: PapertableEngine,
  id: string,
): Promise<{ verdict: Record<string, unknown>; runId: string }> {
  return serial(`abandon:${id}`, async () => {
    let row = requireVerdict(store.db, id);
    if (row.status === "confirmed") throw httpError(409, "已确认的墓碑不能改成放弃");
    if (row.status === "superseded") throw httpError(409, "已失效的墓碑不能操作");
    if (!row.abandoned_at) {
      const abandonedAt = nowIso();
      store.db.exec("BEGIN IMMEDIATE");
      try {
        store.db.prepare(`
          UPDATE pt_verdicts SET abandoned_at = ?, updated_at = ? WHERE id = ?
        `).run(abandonedAt, abandonedAt, id);
        recordVerdictEvent(store.db, {
          projectId: row.project_id,
          type: "tombstone-abandoned",
          targetCardId: row.card_id!,
          sourceId: row.source_id ?? undefined,
          verdictId: id,
          originalText: row.original_text ?? row.text,
        });
        store.db.exec("COMMIT");
      } catch (error) {
        store.db.exec("ROLLBACK");
        throw error;
      }
      row = requireVerdict(store.db, id);
    }
    const runId = await resumeReroute(store, engine, id);
    return { verdict: publicVerdict(row), runId };
  });
}

async function resumeReroute(
  store: DataStore,
  engine: PapertableEngine,
  verdictId: string,
): Promise<string> {
  const row = requireVerdict(store.db, verdictId);
  if (row.resumed_run_id) return row.resumed_run_id;
  if (!row.card_id) throw new Error("墓碑没有关联改道卡片");
  const existingRun = store.db.prepare(`
    SELECT id FROM pt_runs WHERE card_id = ? ORDER BY created_at ASC LIMIT 1
  `).get(row.card_id) as { id: string } | undefined;
  if (existingRun) {
    store.db.prepare(`
      UPDATE pt_verdicts SET resumed_run_id = ?, updated_at = ? WHERE id = ?
    `).run(existingRun.id, nowIso(), verdictId);
    return existingRun.id;
  }
  const card = requireCard(store.db, row.card_id);
  const question = normalizeLine(String(
    jsonObject(card.branch_context_json).pendingQuestion || card.title,
  ));
  const runId = await engine.startRun(card.id, question);
  store.db.prepare(`
    UPDATE pt_verdicts SET resumed_run_id = ?, updated_at = ? WHERE id = ?
  `).run(runId, nowIso(), verdictId);
  return runId;
}

export async function supersedeVerdict(
  store: DataStore,
  id: string,
  replacementText: string,
  replacementHandle?: string,
  remote: VerdictRemote = DEFAULT_REMOTE,
): Promise<Record<string, unknown>> {
  return serial(`supersede:${id}`, async () => {
    const original = requireVerdict(store.db, id);
    if (original.status !== "confirmed") throw httpError(409, "只有已确认判决可以修订");
    const existing = store.db.prepare(`
      SELECT * FROM pt_verdicts WHERE supersedes_local_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(id) as VerdictRow | undefined;
    if (existing) {
      await syncVerdictToMemos(store, existing.id, remote).catch(() => undefined);
      return publicVerdict(requireVerdict(store.db, existing.id));
    }
    const text = normalizeLine(replacementText);
    const handle = original.kind === "gold"
      ? normalizeConcept(replacementHandle ?? original.handle ?? "")
      : null;
    const concepts = original.kind === "gold"
      ? [handle!]
      : deriveConcepts(store.db, original.card_id, parseConcepts(original.concepts_json));
    const input = rowInput({ ...original, text, handle }, concepts);
    const key = original.memos_memory_id
      ? normalizeVerdictInput(input, original.memos_memory_id).idempotencyKey
      : null;
    const replacementId = randomUUID();
    const now = nowIso();
    store.db.exec("BEGIN IMMEDIATE");
    try {
      store.db.prepare(`
        UPDATE pt_verdicts SET status = 'superseded', updated_at = ? WHERE id = ?
      `).run(now, id);
      store.db.prepare(`
        INSERT INTO pt_verdicts(
          id, project_id, card_id, run_id, kind, text, handle, status, memos_status,
          created_at, updated_at, source_kind, source_id, concepts_json, original_text,
          idempotency_key, supersedes_local_id, supersedes_memory_id
        ) VALUES(?, ?, ?, ?, ?, ?, ?, 'confirmed', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        replacementId,
        original.project_id,
        original.card_id,
        original.run_id,
        original.kind,
        text,
        handle,
        now,
        now,
        original.source_kind,
        original.source_id,
        JSON.stringify(concepts),
        text,
        key,
        original.id,
        original.memos_memory_id,
      );
      store.db.exec("COMMIT");
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }
    await syncVerdictToMemos(store, replacementId, remote).catch(() => undefined);
    return publicVerdict(requireVerdict(store.db, replacementId));
  });
}

export async function adoptRun(
  store: DataStore,
  runId: string,
  handleInput: string,
  textInput?: string,
  remote: VerdictRemote = DEFAULT_REMOTE,
): Promise<Record<string, unknown>> {
  return serial(`adopt:${runId}`, async () => {
    const run = requireRun(store.db, runId);
    if (run.result !== "completed" || !run.answer) {
      throw httpError(409, "只有已完成的回答才能被采纳为金子");
    }
    const handle = normalizeConcept(handleInput);
    const text = normalizeLine(textInput ?? firstSentence(run.answer));
    const current = store.db.prepare(`
      SELECT * FROM pt_verdicts
      WHERE run_id = ? AND kind = 'gold' AND status = 'confirmed'
      ORDER BY created_at DESC LIMIT 1
    `).get(runId) as VerdictRow | undefined;
    if (current) {
      if (current.text === text && current.handle === handle) {
        await syncVerdictToMemos(store, current.id, remote).catch(() => undefined);
        return publicVerdict(requireVerdict(store.db, current.id));
      }
      return supersedeVerdict(store, current.id, text, handle, remote);
    }
    const input: VerdictInput = {
      projectId: run.project_id,
      verdictType: "gold",
      sourceKind: "turn",
      sourceId: run.id,
      sourceCardId: run.card_id,
      sourceTurnId: run.id,
      content: text,
      concepts: [handle],
    };
    const normalized = normalizeVerdictInput(input);
    const id = randomUUID();
    const now = nowIso();
    store.db.prepare(`
      INSERT INTO pt_verdicts(
        id, project_id, card_id, run_id, kind, text, handle, status, memos_status,
        created_at, updated_at, source_kind, source_id, concepts_json, original_text,
        idempotency_key
      ) VALUES(?, ?, ?, ?, 'gold', ?, ?, 'confirmed', 'pending', ?, ?, 'turn', ?, ?, ?, ?)
    `).run(
      id,
      run.project_id,
      run.card_id,
      run.id,
      text,
      handle,
      now,
      now,
      run.id,
      JSON.stringify([handle]),
      text,
      normalized.idempotencyKey,
    );
    await syncVerdictToMemos(store, id, remote).catch(() => undefined);
    return publicVerdict(requireVerdict(store.db, id));
  });
}

export function verdictEventStats(db: DatabaseSync, projectId: string): Record<string, number> {
  const rows = db.prepare(`
    SELECT event_type, COUNT(*) AS count
    FROM pt_verdict_events WHERE project_id = ? GROUP BY event_type
  `).all(projectId) as Array<{ event_type: string; count: number }>;
  return Object.fromEntries(rows.map((row) => [row.event_type, Number(row.count)]));
}

function recordVerdictEvent(
  db: DatabaseSync,
  event: {
    projectId: string;
    type: "reroute-eligible" | "tombstone-confirmed" | "tombstone-rewritten" | "tombstone-abandoned";
    targetCardId: string;
    sourceCardId?: string;
    sourceId?: string;
    verdictId?: string;
    originalText?: string;
    finalText?: string;
    editRatio?: number;
  },
): void {
  db.prepare(`
    INSERT INTO pt_verdict_events(
      id, project_id, event_type, target_card_id, source_card_id, source_id,
      verdict_id, original_text, final_text, edit_ratio, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    event.projectId,
    event.type,
    event.targetCardId,
    event.sourceCardId ?? null,
    event.sourceId ?? null,
    event.verdictId ?? null,
    event.originalText ?? null,
    event.finalText ?? null,
    event.editRatio ?? null,
    nowIso(),
  );
}

function rowInput(row: VerdictRow, concepts = parseConcepts(row.concepts_json)): VerdictInput {
  if (!row.source_kind || !row.source_id) throw new Error("本地判决缺少稳定来源");
  return {
    projectId: row.project_id,
    verdictType: row.kind,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    ...(row.kind === "gold" && row.card_id && row.run_id
      ? { sourceCardId: row.card_id, sourceTurnId: row.run_id }
      : {}),
    content: normalizeLine(row.text),
    concepts: concepts.length ? concepts : deriveConcepts(undefined, undefined, [row.text]),
  };
}

function cardConcepts(db: DatabaseSync, cardId: string): string[] {
  const rows = db.prepare(`
    SELECT e.payload_json
    FROM pt_run_events e JOIN pt_runs r ON r.id = e.run_id
    WHERE r.card_id = ? AND e.event_type = 'concepts_ready'
    ORDER BY e.created_at DESC LIMIT 20
  `).all(cardId) as Array<{ payload_json: string }>;
  const terms: string[] = [];
  for (const row of rows) {
    const values = jsonObject(row.payload_json).concepts;
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (object(value)?.term) terms.push(String(object(value)!.term));
    }
  }
  const card = requireCard(db, cardId);
  const branch = jsonObject(card.branch_context_json);
  for (const value of [branch.term, branch.topic]) {
    if (typeof value === "string") terms.push(value);
  }
  return [...new Set(terms.flatMap((value) => {
    const clean = value.normalize("NFC").replace(/\s+/gu, " ").trim();
    return clean ? [[...clean].slice(0, 80).join("")] : [];
  }))].slice(0, 16);
}

function deriveConcepts(
  db: DatabaseSync | undefined,
  cardId: string | null | undefined,
  values: readonly string[],
): string[] {
  const all = [...values];
  if (db && cardId) {
    const card = db.prepare("SELECT title, branch_context_json FROM pt_cards WHERE id = ?")
      .get(cardId) as { title: string; branch_context_json: string | null } | undefined;
    if (card) {
      const context = jsonObject(card.branch_context_json);
      all.push(card.title, String(context.pendingQuestion || ""), String(context.replacedQuestion || ""));
    }
  }
  const concepts = all.flatMap((value) => {
    const clean = value.normalize("NFC").replace(/\s+/gu, " ").trim();
    if (!clean) return [];
    return [[...clean].slice(0, 80).join("")];
  });
  return [...new Set(concepts)].slice(0, 16).length
    ? [...new Set(concepts)].slice(0, 16)
    : ["用户判决"];
}

function parseConcepts(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function firstSentence(answer: string): string {
  const plain = answer
    .replace(/\[\[source:[^\]]+\]\]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const match = plain.match(/^.{10,}?[。！？.!?]/u);
  return (match ? match[0] : plain).slice(0, LINE_LIMIT);
}

function safeLine(value: string): string | null {
  const line = value.normalize("NFC").trim();
  if (
    !line
    || /[\r\n\p{Cc}\p{Cf}\u2028\u2029]/u.test(line)
    || [...line].length > LINE_LIMIT
  ) {
    return null;
  }
  return line;
}

function normalizeLine(value: string): string {
  const line = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (!line) throw httpError(400, "判决内容不能为空");
  if ([...line].length > LINE_LIMIT) throw httpError(400, `判决最多 ${LINE_LIMIT} 个字符`);
  return line;
}

function normalizeConcept(value: string): string {
  const line = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (!line) throw httpError(400, "必须亲手为这条金子铸一个概念把手");
  if ([...line].length > 80) throw httpError(400, "概念把手最多 80 个字符");
  return line;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const apiKey = process.env.PAPERTABLE_API_KEY;
  return (apiKey ? message.replaceAll(apiKey, "[redacted]") : message)
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/gu, "[redacted]")
    .slice(0, 600);
}

async function serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const current = pendingActions.get(key) as Promise<T> | undefined;
  if (current) return current;
  const promise = operation().finally(() => pendingActions.delete(key));
  pendingActions.set(key, promise);
  return promise;
}
