/**
 * TASK-PW-31：素材草案体系（AI 写的素材草案正式户口）。
 *
 * 数据真值源：pw_content_drafts + pw_content_draft_edits（唯一归属：内容生产）；
 * 弱引用 pw_bets（写入前存在性校验，无物理外键）+ pw_runs 留痕（复用既有
 * event_type 枚举 create/edit/confirm/reject，均在 CHECK 内，无迁移）。
 *
 * 状态机：draft → finalized / rejected，单向不可逆，反悔一律 409；竞态兜底照
 * TASK-PW-19 先例（事务内 UPDATE ... WHERE status='draft'，changes !== 1 → 409）。
 * 审计照 PwContentBetAudit 先例：audit 传入走 recordPwExecEvent 合成一条 ai_exec 账，
 * 缺省走 recordPwEvent（manual_event/human）。create 无 audit 通道（本刀签名不含），
 * 恒落 manual_event/human。
 *
 * 命名避让：src/pw-drafts.ts 是「押注草稿」（PW-09/28，settle/bet 草稿）；
 * 本模块一律用 pw_content_drafts / pw-content-drafts.ts。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { httpError, nowIso } from "./data.ts";
import { attachPwArtifact } from "./pw-artifacts.ts";
import { getPwBet } from "./pw-bets.ts";
import { recordPwEvent, recordPwExecEvent } from "./pw-runs.ts";

export type PwContentDraftStatus = "draft" | "finalized" | "rejected";

/** TASK-PW-31：AI 执行审计——传入后自记账改走 recordPwExecEvent 合成一条 ai_exec 账。 */
export type PwContentDraftAudit = {
  actor: "ai";
  instructionText: string;
  instructionMessageId: string;
};

/** 新建素材草案输入（skeletonJson 为节点数组的 JSON 串，见 validateSkeletonJson）。 */
export type NewPwContentDraft = {
  route: string;
  titleCandidate: string;
  skeletonJson: string;
};

export type PwContentDraftRow = {
  id: string;
  bet_id: string;
  batch_id: string;
  route: string;
  title_candidate: string;
  skeleton_json: string;
  status: PwContentDraftStatus;
  reject_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type PwContentDraftEditRow = {
  id: string;
  draft_id: string;
  before_json: string;
  after_json: string;
  actor: string;
  created_at: string;
};

/** bad case 集行：rejected 素材草案 + 联查押注标题。 */
export type PwDraftBadCaseRow = PwContentDraftRow & { bet_title: string | null };

const MAX_SKELETON_NODES = 10;

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

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw httpError(400, `${label}不能为空`);
  return value.trim();
}

/** skeletonJson 必须是合法 JSON 数组：元素至少含 text 字段，节点数 1..10。 */
function validateSkeletonJson(value: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw httpError(400, "skeletonJson 必须是合法 JSON");
  }
  if (!Array.isArray(parsed)) throw httpError(400, "skeletonJson 必须是 JSON 数组");
  if (parsed.length < 1 || parsed.length > MAX_SKELETON_NODES) {
    throw httpError(400, `skeletonJson 节点数须在 1–${MAX_SKELETON_NODES} 之间`);
  }
  for (const node of parsed) {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      throw httpError(400, "skeletonJson 每个节点必须是对象");
    }
    if (typeof (node as Record<string, unknown>).text !== "string") {
      throw httpError(400, "skeletonJson 每个节点必须含 text 字段");
    }
  }
}

/** updated_at 单调前进：同毫秒内连续更新也严格递增（ISO 串字典序可比）。 */
function nextUpdatedAt(previous: string): string {
  const now = nowIso();
  if (now > previous) return now;
  return new Date(Date.parse(previous) + 1).toISOString();
}

function getPwContentDraftRow(db: DatabaseSync, id: string): PwContentDraftRow | undefined {
  return db.prepare("SELECT * FROM pw_content_drafts WHERE id = ?").get(id) as PwContentDraftRow | undefined;
}

/** TASK-PW-31：审计账——audit 传入走 recordPwExecEvent（ai_exec，instruction 两列齐），缺省 manual_event/human。 */
function recordDraftEvent(
  db: DatabaseSync,
  eventType: "create" | "edit" | "confirm" | "reject",
  betId: string,
  payload: Record<string, unknown>,
  audit?: PwContentDraftAudit,
): void {
  if (audit) {
    recordPwExecEvent(db, {
      eventType,
      instructionText: audit.instructionText,
      instructionMessageId: audit.instructionMessageId,
      betId,
      payloadJson: JSON.stringify(payload),
    });
  } else {
    recordPwEvent(db, {
      kind: "manual_event",
      eventType,
      actor: "human",
      betId,
      payloadJson: JSON.stringify(payload),
    });
  }
}

/** 幂等建表：素材草案 + 改稿留痕两表（DDL 见 TASK-PW-31）。 */
export function ensurePwContentDraftTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pw_content_drafts (
      id TEXT PRIMARY KEY,
      bet_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      route TEXT NOT NULL,
      title_candidate TEXT NOT NULL,
      skeleton_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','finalized','rejected')),
      reject_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pw_content_drafts_by_bet
      ON pw_content_drafts(bet_id, status);

    CREATE TABLE IF NOT EXISTS pw_content_draft_edits (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      before_json TEXT NOT NULL,
      after_json TEXT NOT NULL,
      actor TEXT NOT NULL CHECK(actor IN ('human','ai')),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pw_content_draft_edits_by_draft
      ON pw_content_draft_edits(draft_id, created_at);
  `);
}

/**
 * 批量创建素材草案（1..N 份，共用 batchId）。bet 不存在 → 404（写入前校验，无孤儿）；
 * route/titleCandidate 非空、skeletonJson 合法（节点数组 1..10 且元素含 text），否则 400；
 * 未给 batchId 自动生成。pw_runs 留 create 痕（manual_event/human——本签名无 audit 通道）。
 */
export function createPwContentDrafts(
  db: DatabaseSync,
  betId: string,
  drafts: NewPwContentDraft[],
  options: { batchId?: string } = {},
): PwContentDraftRow[] {
  return inTransaction(db, () => {
    const bet = getPwBet(db, betId);
    if (!bet) throw httpError(404, "押注不存在");
    if (!Array.isArray(drafts) || drafts.length < 1) throw httpError(400, "drafts 至少 1 份");
    const batchId = options.batchId !== undefined && options.batchId.trim()
      ? options.batchId.trim()
      : randomUUID();
    const createdAt = nowIso();
    const draftIds: string[] = [];
    for (const draft of drafts) {
      const route = requiredText(draft.route, "route");
      const titleCandidate = requiredText(draft.titleCandidate, "titleCandidate");
      validateSkeletonJson(draft.skeletonJson);
      const id = randomUUID();
      db.prepare(`
        INSERT INTO pw_content_drafts(
          id, bet_id, batch_id, route, title_candidate, skeleton_json,
          status, reject_reason, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, 'draft', NULL, ?, ?)
      `).run(id, betId, batchId, route, titleCandidate, draft.skeletonJson, createdAt, createdAt);
      draftIds.push(id);
    }
    recordDraftEvent(db, "create", betId, { betId, batchId, draftIds });
    return draftIds.map((id) => getPwContentDraftRow(db, id)!);
  });
}

/** 押注下素材草案列表（created_at、route 升序；status 可选过滤）。 */
export function listPwContentDraftsByBet(
  db: DatabaseSync,
  betId: string,
  options: { status?: PwContentDraftStatus } = {},
): PwContentDraftRow[] {
  if (options.status) {
    return db.prepare(`
      SELECT * FROM pw_content_drafts
      WHERE bet_id = ? AND status = ?
      ORDER BY created_at, route
    `).all(betId, options.status) as PwContentDraftRow[];
  }
  return db.prepare(`
    SELECT * FROM pw_content_drafts
    WHERE bet_id = ?
    ORDER BY created_at, route
  `).all(betId) as PwContentDraftRow[];
}

/** 押注下素材草案计数（draft = 角标语义的「待处理」计数）。 */
export function countPwContentDraftsByBet(
  db: DatabaseSync,
  betId: string,
): { total: number; draft: number; finalized: number; rejected: number } {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS n
    FROM pw_content_drafts
    WHERE bet_id = ?
    GROUP BY status
  `).all(betId) as Array<{ status: string; n: number }>;
  const counts = { draft: 0, finalized: 0, rejected: 0 };
  for (const row of rows) {
    if (row.status === "draft") counts.draft = row.n;
    else if (row.status === "finalized") counts.finalized = row.n;
    else if (row.status === "rejected") counts.rejected = row.n;
  }
  return { total: counts.draft + counts.finalized + counts.rejected, ...counts };
}

/** 单份素材草案；不存在 → 404。 */
export function getPwContentDraft(db: DatabaseSync, id: string): PwContentDraftRow {
  const row = getPwContentDraftRow(db, id);
  if (!row) throw httpError(404, "素材草案不存在");
  return row;
}

/**
 * 改稿：仅 draft 态可改（否则 409，竞态兜底同款）。
 * 事务内先写 pw_content_draft_edits（before/after 全文 JSON）再更新主表 + updated_at 前进；
 * 只更新传入字段。pw_runs 留 edit 痕（audit 双路）。
 */
export function updatePwContentDraft(
  db: DatabaseSync,
  id: string,
  changes: { titleCandidate?: string; skeletonJson?: string },
  audit?: PwContentDraftAudit,
): PwContentDraftRow {
  const changedFields = Object.keys(changes).filter((key) => changes[key as keyof typeof changes] !== undefined);
  if (changedFields.length === 0) return getPwContentDraft(db, id);
  return inTransaction(db, () => {
    const draft = getPwContentDraft(db, id);
    if (draft.status !== "draft") throw httpError(409, "仅 draft 态素材草案可修改");
    const nextTitleCandidate = changes.titleCandidate !== undefined
      ? requiredText(changes.titleCandidate, "titleCandidate")
      : draft.title_candidate;
    const nextSkeletonJson = changes.skeletonJson !== undefined
      ? (validateSkeletonJson(changes.skeletonJson), changes.skeletonJson)
      : draft.skeleton_json;
    db.prepare(`
      INSERT INTO pw_content_draft_edits(id, draft_id, before_json, after_json, actor, created_at)
      VALUES(?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      id,
      JSON.stringify({ titleCandidate: draft.title_candidate, skeletonJson: draft.skeleton_json }),
      JSON.stringify({ titleCandidate: nextTitleCandidate, skeletonJson: nextSkeletonJson }),
      audit ? "ai" : "human",
      nowIso(),
    );
    const updatedAt = nextUpdatedAt(draft.updated_at);
    const sets: string[] = ["updated_at = ?"];
    const params: unknown[] = [updatedAt];
    if (changes.titleCandidate !== undefined) {
      sets.push("title_candidate = ?");
      params.push(nextTitleCandidate);
    }
    if (changes.skeletonJson !== undefined) {
      sets.push("skeleton_json = ?");
      params.push(nextSkeletonJson);
    }
    const updated = db.prepare(
      `UPDATE pw_content_drafts SET ${sets.join(", ")} WHERE id = ? AND status = 'draft'`,
    ).run(...params, id);
    if (updated.changes !== 1) throw httpError(409, "素材草案状态已变化");
    recordDraftEvent(db, "edit", draft.bet_id, { draftId: id, betId: draft.bet_id, changedFields }, audit);
    return getPwContentDraftRow(db, id)!;
  });
}

/**
 * 定稿：draft → finalized（单向，反悔 409）。同事务内、状态翻转成功后把产出物挂到押注
 * （TASK-PW-33：platform='paperweight'、type='article'、title=title_candidate、note 含草案
 * id 与 route）——押注行零改动（继续在途）；attach 抛错则整个定稿事务回滚（定稿与挂载
 * 同生共死）。pw_runs 留 confirm 痕（payload 含 draftId/betId/artifactId，audit 双路）。
 */
export function finalizePwContentDraft(
  db: DatabaseSync,
  id: string,
  audit?: PwContentDraftAudit,
): PwContentDraftRow {
  return inTransaction(db, () => {
    const draft = getPwContentDraft(db, id);
    if (draft.status !== "draft") throw httpError(409, "仅 draft 态素材草案可定稿");
    const updatedAt = nextUpdatedAt(draft.updated_at);
    const updated = db.prepare(`
      UPDATE pw_content_drafts SET status = 'finalized', updated_at = ?
      WHERE id = ? AND status = 'draft'
    `).run(updatedAt, id);
    if (updated.changes !== 1) throw httpError(409, "素材草案状态已变化");
    const artifact = attachPwArtifact(db, {
      betId: draft.bet_id,
      platform: "paperweight",
      type: "article",
      title: draft.title_candidate,
      note: `素材草案定稿 ${draft.id}（${draft.route}）`,
    });
    recordDraftEvent(
      db,
      "confirm",
      draft.bet_id,
      { draftId: id, betId: draft.bet_id, artifactId: artifact.id },
      audit,
    );
    return getPwContentDraftRow(db, id)!;
  });
}

/**
 * 否掉：draft → rejected + reject_reason（可空，空白串按 null）。pw_runs 留 reject 痕
 * （payload 含 draftId/betId/reason，audit 双路）。
 */
export function rejectPwContentDraft(
  db: DatabaseSync,
  id: string,
  reason?: string,
  audit?: PwContentDraftAudit,
): PwContentDraftRow {
  return inTransaction(db, () => {
    const draft = getPwContentDraft(db, id);
    if (draft.status !== "draft") throw httpError(409, "仅 draft 态素材草案可否掉");
    const reasonText = typeof reason === "string" && reason.trim() ? reason.trim() : null;
    const updatedAt = nextUpdatedAt(draft.updated_at);
    const updated = db.prepare(`
      UPDATE pw_content_drafts SET status = 'rejected', reject_reason = ?, updated_at = ?
      WHERE id = ? AND status = 'draft'
    `).run(reasonText, updatedAt, id);
    if (updated.changes !== 1) throw httpError(409, "素材草案状态已变化");
    recordDraftEvent(db, "reject", draft.bet_id, { draftId: id, betId: draft.bet_id, reason: reasonText }, audit);
    return getPwContentDraftRow(db, id)!;
  });
}

/**
 * bad case 集：rejected 素材草案全部（含 reject_reason），联查押注标题，created_at 升序
 * （供 PW-32 起草管线回流调教）。
 */
export function listPwDraftBadCases(db: DatabaseSync): PwDraftBadCaseRow[] {
  return db.prepare(`
    SELECT d.*, b.title AS bet_title
    FROM pw_content_drafts d
    LEFT JOIN pw_bets b ON b.id = d.bet_id
    WHERE d.status = 'rejected'
    ORDER BY d.created_at, d.id
  `).all() as PwDraftBadCaseRow[];
}
