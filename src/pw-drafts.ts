import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type PwBetDraftInput = {
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
  /** TASK-PW-28：户口——'verdict'（判断/生活向，缺省）| 'content'（内容向押注，选题/视频/直播）。 */
  kind?: "verdict" | "content";
  /** TASK-PW-28：来源筛子候选卡 id（弱引用 pw_sieve_cards.id）；仅 kind='content' 时可用。 */
  sourceCardId?: string | null;
};

export type PwBetDraftEdits = Partial<PwBetDraftInput>;

type PwBetRow = {
  id: string;
  title: string;
  thesis: string;
  metric: string | null;
  metric_target: string | null;
  confidence: number | null;
  data_source_plan: string | null;
  checkout_date: string | null;
  status: "draft" | "pending" | "settled" | "void";
  gold_refs_json: string;
  created_from: string | null;
  created_at: string;
  settled_verdict_id: string | null;
};

export type PwBetDraftContent = {
  title: string;
  thesis: string;
  metric: string | null;
  metric_target: string | null;
  confidence: number | null;
  data_source_plan: string | null;
  checkout_date: string | null;
  gold_refs: string[];
};

function error(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 400 });
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw error(`${name} 必填`);
  return value.trim();
}

function optionalText(value: unknown): string | null {
  if (value == null || (typeof value === "string" && !value.trim())) return null;
  if (typeof value !== "string") throw error("文本字段格式不正确");
  return value.trim();
}

function confidence(value: unknown): number | null {
  if (value == null) return null;
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 100) {
    throw error("confidence 必须是 0–100 的整数");
  }
  return Number(value);
}

function goldRefs(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw error("gold_refs 必须是字符串数组");
  }
  return value.map((item) => item.trim());
}

function contentFromInput(input: PwBetDraftInput): PwBetDraftContent {
  return {
    title: requiredText(input?.title, "title"),
    thesis: requiredText(input?.thesis, "thesis"),
    metric: optionalText(input?.metric),
    metric_target: optionalText(input?.metric_target !== undefined
      ? input.metric_target
      : input?.metricTarget),
    confidence: confidence(input?.confidence),
    data_source_plan: optionalText(input?.data_source_plan !== undefined
      ? input.data_source_plan
      : input?.dataSourcePlan),
    checkout_date: optionalText(input?.checkout_date !== undefined
      ? input.checkout_date
      : input?.checkoutDate),
    gold_refs: goldRefs(input?.gold_refs !== undefined ? input.gold_refs : input?.goldRefs),
  };
}

function contentFromRow(row: PwBetRow): PwBetDraftContent {
  let refs: unknown;
  try {
    refs = JSON.parse(row.gold_refs_json);
  } catch {
    throw error("gold_refs_json 不是合法 JSON");
  }
  return {
    title: row.title,
    thesis: row.thesis,
    metric: row.metric,
    metric_target: row.metric_target,
    confidence: row.confidence,
    data_source_plan: row.data_source_plan,
    checkout_date: row.checkout_date,
    gold_refs: goldRefs(refs),
  };
}

function applyEdits(row: PwBetRow, edits: PwBetDraftEdits): PwBetDraftContent {
  const current = contentFromRow(row);
  const metric = edits?.metric;
  const metricTarget = edits?.metric_target !== undefined
    ? edits.metric_target
    : edits?.metricTarget;
  const dataSourcePlan = edits?.data_source_plan !== undefined
    ? edits.data_source_plan
    : edits?.dataSourcePlan;
  const checkoutDate = edits?.checkout_date !== undefined
    ? edits.checkout_date
    : edits?.checkoutDate;
  const refs = edits?.gold_refs !== undefined ? edits.gold_refs : edits?.goldRefs;
  return {
    title: edits?.title === undefined ? current.title : requiredText(edits.title, "title"),
    thesis: edits?.thesis === undefined ? current.thesis : requiredText(edits.thesis, "thesis"),
    metric: metric === undefined ? current.metric : optionalText(metric),
    metric_target: metricTarget === undefined
      ? current.metric_target
      : optionalText(metricTarget),
    confidence: edits?.confidence === undefined
      ? current.confidence
      : confidence(edits.confidence),
    data_source_plan: dataSourcePlan === undefined
      ? current.data_source_plan
      : optionalText(dataSourcePlan),
    checkout_date: checkoutDate === undefined
      ? current.checkout_date
      : optionalText(checkoutDate),
    gold_refs: refs === undefined ? current.gold_refs : goldRefs(refs),
  };
}

function assertBetComplete(content: PwBetDraftContent): void {
  if (!content.metric || !content.data_source_plan || !content.checkout_date) {
    throw error("转正前必须补齐 metric、data_source_plan、checkout_date 三行赌注");
  }
}

function actor(value: string | undefined): string {
  return value?.trim() || "human";
}

function nowIso(): string {
  return new Date().toISOString();
}

function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (caught) {
    db.exec("ROLLBACK");
    throw caught;
  }
}

export function ensurePwDraftTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pw_draft_events (
      id TEXT PRIMARY KEY,
      bet_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('confirm','reject')),
      draft_hash TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'human',
      reason TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

export function hashPwBetDraft(content: PwBetDraftContent): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

export function createPwBetDraft(
  db: DatabaseSync,
  input: PwBetDraftInput,
  source: string,
): PwBetRow {
  const content = contentFromInput(input);
  const createdFrom = requiredText(source, "source");
  // TASK-PW-28：户口校验——kind 缺省 'verdict'（回归不变）；content 可选挂候选卡
  const kind = input?.kind ?? "verdict";
  if (kind !== "verdict" && kind !== "content") throw error("非法 kind 值（仅 'verdict'/'content'）");
  const sourceCardId = optionalText(input?.sourceCardId);
  if (sourceCardId) {
    if (kind === "verdict") throw error("verdict 押注不允许挂候选卡");
    if (!db.prepare("SELECT id FROM pw_sieve_cards WHERE id = ?").get(sourceCardId)) {
      throw error("候选卡不存在");
    }
  }
  const id = randomUUID();
  const createdAt = nowIso();
  db.prepare(`
    INSERT INTO pw_bets(
      id, title, thesis, metric, metric_target, confidence, data_source_plan,
      checkout_date, status, gold_refs_json, created_from, created_at, settled_verdict_id,
      kind, source_card_id
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, NULL, ?, ?)
  `).run(
    id,
    content.title,
    content.thesis,
    content.metric,
    content.metric_target,
    content.confidence,
    content.data_source_plan,
    content.checkout_date,
    JSON.stringify(content.gold_refs),
    createdFrom,
    createdAt,
    kind,
    sourceCardId,
  );
  return db.prepare("SELECT * FROM pw_bets WHERE id = ?").get(id) as PwBetRow;
}

export function confirmPwBetDraft(
  db: DatabaseSync,
  draftId: string,
  edits: PwBetDraftEdits = {},
  confirmedBy?: string,
): PwBetRow & { draft_hash: string } {
  return inTransaction(db, () => {
    const draft = db.prepare("SELECT * FROM pw_bets WHERE id = ?").get(draftId) as PwBetRow | undefined;
    if (!draft || draft.status !== "draft") throw error("押注草稿不存在或已不是 draft 态");
    const content = applyEdits(draft, edits);
    assertBetComplete(content);
    const draftHash = hashPwBetDraft(content);
    const updatedAt = nowIso();
    db.prepare(`
      UPDATE pw_bets
      SET title = ?, thesis = ?, metric = ?, metric_target = ?, confidence = ?,
          data_source_plan = ?, checkout_date = ?, gold_refs_json = ?, status = 'pending'
      WHERE id = ? AND status = 'draft'
    `).run(
      content.title,
      content.thesis,
      content.metric,
      content.metric_target,
      content.confidence,
      content.data_source_plan,
      content.checkout_date,
      JSON.stringify(content.gold_refs),
      draftId,
    );
    db.prepare(`
      INSERT INTO pw_draft_events(id, bet_id, action, draft_hash, actor, reason, created_at)
      VALUES(?, ?, 'confirm', ?, ?, NULL, ?)
    `).run(randomUUID(), draftId, draftHash, actor(confirmedBy), updatedAt);
    const updated = db.prepare("SELECT * FROM pw_bets WHERE id = ?").get(draftId) as PwBetRow;
    return { ...updated, draft_hash: draftHash };
  });
}

export function rejectPwBetDraft(
  db: DatabaseSync,
  draftId: string,
  reason: string,
  rejectedBy?: string,
): PwBetRow & { draft_hash: string; reason: string } {
  return inTransaction(db, () => {
    const draft = db.prepare("SELECT * FROM pw_bets WHERE id = ?").get(draftId) as PwBetRow | undefined;
    if (!draft || draft.status !== "draft") throw error("押注草稿不存在或已不是 draft 态");
    const rejectionReason = requiredText(reason, "reason");
    const draftHash = hashPwBetDraft(contentFromRow(draft));
    const createdAt = nowIso();
    db.prepare("UPDATE pw_bets SET status = 'void' WHERE id = ? AND status = 'draft'")
      .run(draftId);
    db.prepare(`
      INSERT INTO pw_draft_events(id, bet_id, action, draft_hash, actor, reason, created_at)
      VALUES(?, ?, 'reject', ?, ?, ?, ?)
    `).run(randomUUID(), draftId, draftHash, actor(rejectedBy), rejectionReason, createdAt);
    return { ...draft, status: "void", draft_hash: draftHash, reason: rejectionReason };
  });
}

export function listPwBetDrafts(db: DatabaseSync): PwBetRow[] {
  return db.prepare(
    "SELECT * FROM pw_bets WHERE status = 'draft' ORDER BY created_at ASC, id ASC",
  ).all() as PwBetRow[];
}
