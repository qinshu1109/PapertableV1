/**
 * TASK-PW-16（简报 16）：提案契约 + 状态机（后端）。
 * 协作台 = 外部智能的入境口岸：外部 agent（claude/codex/kimi/script）的产出统一走「提案」
 * 进入系统——固定版本 + 证据包 + 自动检查 + 人类状态迁移。铸币权在人：只有人能点的状态
 * 迁移由人来触发，批准后由可信服务机械记账。本模块纯加法，不替任何业务表写数据。
 *
 * 状态机（写死，非法迁移 400）：
 *   submitted → in_review → accepted → applied → verified
 *       ↑          ├→ changes_requested ─┘（退回后由提交方重提：新提案或重新 submit）
 *       │          └→ rejected（终态）
 *       └→ rejected（终态）
 *   applied → rolled_back（冲正，记 review_note）
 *   任何状态（非终态）→ expired（仅系统/人显式触发或过期校验时）
 * v1 的 5 条路由只触发可达子集：create→submitted、review 从 submitted/in_review →
 * accepted/rejected/changes_requested、apply 从 accepted → applied。in_review /
 * changes_requested→submitted / applied→verified / applied→rolled_back / →expired 在机器里
 * 合法但不经本批路由可达（重提 = 新建提案；其余留给后续批次）。
 *
 * 过期：只读查询不自动翻状态；accept/apply 时校验 expires_at，已过 → 409。
 * base_version：apply 时由可信调用方带 currentVersion 校验（v1 后端不持有 git/草案版本源，
 * 只做状态记账；不等 → 409 stale base，需人重新 accept）。
 *
 * 红线（GUARDRAILS.md）：agent 通道创建只能为 submitted；review / apply 只供人触发——
 * agent 调用即违反守门红线。本地单用户不加鉴权，靠纪律 + 事件审计：每次状态迁移
 * recordPwEvent 落 pw_runs（create/confirm/reject/edit，payload 带 proposalId 与迁移对）。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { httpError, nowIso } from "./data.ts";
import { recordPwEvent } from "./pw-runs.ts";

export type PwProposalLane = "content" | "ops";
export type PwProposalStatus =
  | "submitted" | "in_review" | "accepted" | "applied" | "verified"
  | "rejected" | "changes_requested" | "rolled_back" | "expired";

export type PwProposalRow = {
  id: string;
  schema_version: number;
  lane: PwProposalLane;
  title: string;
  target_kind: string;
  target_id: string | null;
  base_version: string | null;
  brief_ref: string | null;
  proposed_by: string;
  payload_json: string;
  evidence_json: string | null;
  checks_json: string | null;
  risk: string | null;
  requested_action: string | null;
  status: PwProposalStatus;
  review_note: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  applied_at: string | null;
  applied_by: string | null;
};

/** 待处理（等人在看）的提案状态：mode-bar pendingReview.proposals 口径。 */
export const PENDING_PROPOSAL_STATUSES = ["submitted", "in_review", "changes_requested"] as const;

export type PwProposalCreateInput = {
  title: string;
  lane: unknown;
  targetKind?: unknown;
  target_kind?: unknown;
  proposedBy?: unknown;
  proposed_by?: unknown;
  targetId?: unknown;
  target_id?: unknown;
  baseVersion?: unknown;
  base_version?: unknown;
  briefRef?: unknown;
  brief_ref?: unknown;
  payload?: unknown;
  evidence?: unknown;
  checks?: unknown;
  risk?: unknown;
  requestedAction?: unknown;
  requested_action?: unknown;
  expiresAt?: unknown;
  expires_at?: unknown;
};

export type PwProposalReviewInput = {
  action: "accept" | "reject" | "request_changes";
  note?: unknown;
};

export type PwProposalApplyInput = {
  currentVersion?: unknown;
  current_version?: unknown;
  appliedBy?: unknown;
  applied_by?: unknown;
};

export function ensurePwProposalTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pw_proposals (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL DEFAULT 1,
      lane TEXT NOT NULL CHECK(lane IN ('content','ops')),
      title TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target_id TEXT,
      base_version TEXT,
      brief_ref TEXT,
      proposed_by TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      evidence_json TEXT,
      checks_json TEXT,
      risk TEXT,
      requested_action TEXT,
      status TEXT NOT NULL CHECK(status IN (
        'submitted','in_review','accepted','applied','verified',
        'rejected','changes_requested','rolled_back','expired'
      )),
      review_note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT,
      applied_at TEXT,
      applied_by TEXT
    );
    CREATE INDEX IF NOT EXISTS pw_proposals_lane_status
      ON pw_proposals(lane, status);
    CREATE INDEX IF NOT EXISTS pw_proposals_status_created
      ON pw_proposals(status, created_at);
  `);
}

/** agent 通道：创建提案，只能为 submitted。 */
export function createPwProposal(db: DatabaseSync, input: PwProposalCreateInput): PwProposalRow {
  ensurePwProposalTables(db);
  const title = requiredText(input.title, "title");
  const lane = requiredLane(input.lane);
  const targetKind = requiredText(pick(input.targetKind, input.target_kind), "target_kind");
  const proposedBy = requiredText(pick(input.proposedBy, input.proposed_by), "proposed_by");
  const id = randomUUID();
  const at = nowIso();
  db.prepare(`
    INSERT INTO pw_proposals(
      id, schema_version, lane, title, target_kind, target_id, base_version, brief_ref,
      proposed_by, payload_json, evidence_json, checks_json, risk, requested_action,
      status, review_note, created_at, updated_at, expires_at, applied_at, applied_by
    ) VALUES(?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', NULL, ?, ?, ?, NULL, NULL)
  `).run(
    id,
    lane,
    title,
    targetKind,
    optionalText(pick(input.targetId, input.target_id)),
    optionalText(pick(input.baseVersion, input.base_version)),
    optionalText(pick(input.briefRef, input.brief_ref)),
    proposedBy,
    payloadJson(input.payload),
    optionalJson(input.evidence),
    optionalJson(input.checks),
    optionalText(input.risk),
    optionalText(pick(input.requestedAction, input.requested_action)),
    at,
    at,
    optionalText(pick(input.expiresAt, input.expires_at)),
  );
  recordPwEvent(db, {
    eventType: "create",
    actor: "ai",
    kind: "ai_draft",
    payloadJson: JSON.stringify({ proposalId: id, status: "submitted", proposedBy }),
    relatedIds: [id],
  });
  return getPwProposal(db, id);
}
export function listPwProposals(
  db: DatabaseSync,
  options: { lane?: unknown; status?: unknown; limit?: unknown; offset?: unknown } = {},
): { proposals: Array<Record<string, unknown>>; limit: number; offset: number } {
  ensurePwProposalTables(db);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.lane !== undefined && options.lane !== null && String(options.lane).trim()) {
    const lane = requiredLane(options.lane);
    clauses.push("lane = ?");
    params.push(lane);
  }
  if (options.status !== undefined && options.status !== null && String(options.status).trim()) {
    const status = String(options.status).trim();
    if (!Object.hasOwn(PROPOSAL_TRANSITIONS, status)) throw httpError(400, `status 非法：${status}`);
    clauses.push("status = ?");
    params.push(status);
  }
  const limit = clampInt(options.limit, 50, 200, "limit");
  const offset = clampOffset(options.offset);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`
    SELECT * FROM pw_proposals
    ${where}
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as PwProposalRow[];
  return { proposals: rows.map(proposalPublic), limit, offset };
}

export function getPwProposal(db: DatabaseSync, idRaw: string): Record<string, unknown> {
  ensurePwProposalTables(db);
  const id = requiredText(idRaw, "id");
  return proposalPublic(requireProposal(db, id));
}

/** 原始行（内部状态迁移用）。 */
function requireProposal(db: DatabaseSync, id: string): PwProposalRow {
  const row = db.prepare("SELECT * FROM pw_proposals WHERE id = ?").get(id) as PwProposalRow | undefined;
  if (!row) throw httpError(404, "提案不存在");
  return row;
}

/** 人通道：review（accept/reject/request_changes）。只供人触发；agent 调用即违反 GUARDRAILS.md。 */
export function reviewPwProposal(
  db: DatabaseSync,
  idRaw: string,
  input: PwProposalReviewInput,
): Record<string, unknown> {
  ensurePwProposalTables(db);
  const id = requiredText(idRaw, "id");
  const proposal = requireProposal(db, id);
  const action = input.action;
  if (!action || !(action in REVIEW_ACTIONS)) throw httpError(400, "action 必须是 accept/reject/request_changes");
  const target = REVIEW_ACTIONS[action];
  assertProposalTransition(proposal.status, target);
  if (action === "accept" && isExpired(proposal)) throw httpError(409, "提案已过期，不能接受");
  const note = optionalText(input.note);
  const at = nowIso();
  db.prepare("UPDATE pw_proposals SET status = ?, review_note = ?, updated_at = ? WHERE id = ?")
    .run(target, note, at, proposal.id);
  recordPwEvent(db, {
    eventType: REVIEW_EVENT_TYPES[action],
    actor: "human",
    kind: "manual_event",
    payloadJson: JSON.stringify({
      proposalId: proposal.id, fromStatus: proposal.status, toStatus: target, action,
    }),
    relatedIds: [proposal.id],
  });
  return getPwProposal(db, id);
}

/** 可信服务：apply，仅当 accepted；base_version stale → 409。只供人触发；agent 调用即违反 GUARDRAILS.md。 */
export function applyPwProposal(
  db: DatabaseSync,
  idRaw: string,
  input: PwProposalApplyInput = {},
): Record<string, unknown> {
  ensurePwProposalTables(db);
  const id = requiredText(idRaw, "id");
  const proposal = requireProposal(db, id);
  assertProposalTransition(proposal.status, "applied");
  if (isExpired(proposal)) throw httpError(409, "提案已过期，不能应用");
  if (proposal.base_version) {
    const currentVersion = optionalText(pick(input.currentVersion, input.current_version));
    if (currentVersion !== proposal.base_version) {
      throw httpError(409, "基准版本已变化，需重新接受");
    }
  }
  const appliedBy = optionalText(pick(input.appliedBy, input.applied_by)) ?? "human";
  const at = nowIso();
  db.prepare(`
    UPDATE pw_proposals SET status = 'applied', applied_at = ?, applied_by = ?, updated_at = ?
    WHERE id = ?
  `).run(at, appliedBy, at, proposal.id);
  recordPwEvent(db, {
    eventType: "confirm",
    actor: "system",
    kind: "manual_event",
    payloadJson: JSON.stringify({
      proposalId: proposal.id, fromStatus: proposal.status, toStatus: "applied", appliedBy,
    }),
    relatedIds: [proposal.id],
  });
  return getPwProposal(db, id);
}

/** 待处理提案计数（mode-bar pendingReview.proposals 口径）。 */
export function countPendingPwProposals(db: DatabaseSync): number {
  ensurePwProposalTables(db);
  const placeholders = PENDING_PROPOSAL_STATUSES.map(() => "?").join(",");
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM pw_proposals WHERE status IN (${placeholders})`,
  ).get(...PENDING_PROPOSAL_STATUSES) as { n: number };
  return Number(row.n);
}

const REVIEW_ACTIONS = {
  accept: "accepted",
  reject: "rejected",
  request_changes: "changes_requested",
} as const;
const REVIEW_EVENT_TYPES = {
  accept: "confirm",
  reject: "reject",
  request_changes: "edit",
} as const;

/** 状态机（写死）：每个状态的合法出边。终态（rejected/verified/rolled_back/expired）无出边。 */
const PROPOSAL_TRANSITIONS: Record<PwProposalStatus, ReadonlySet<PwProposalStatus>> = {
  submitted: new Set(["in_review", "accepted", "rejected", "changes_requested", "expired"]),
  in_review: new Set(["accepted", "rejected", "changes_requested", "expired"]),
  changes_requested: new Set(["submitted", "expired"]),
  accepted: new Set(["applied", "expired"]),
  applied: new Set(["verified", "rolled_back"]),
  verified: new Set(),
  rejected: new Set(),
  rolled_back: new Set(),
  expired: new Set(),
};

function assertProposalTransition(from: PwProposalStatus, to: PwProposalStatus): void {
  if (!PROPOSAL_TRANSITIONS[from]?.has(to)) {
    throw httpError(400, `非法状态迁移：${from} → ${to}`);
  }
}

function isExpired(proposal: PwProposalRow): boolean {
  if (!proposal.expires_at) return false;
  const ms = Date.parse(proposal.expires_at);
  return Number.isFinite(ms) && ms <= Date.now();
}

function proposalPublic(row: PwProposalRow): Record<string, unknown> {
  return {
    id: row.id,
    schemaVersion: row.schema_version,
    lane: row.lane,
    title: row.title,
    targetKind: row.target_kind,
    targetId: row.target_id,
    baseVersion: row.base_version,
    briefRef: row.brief_ref,
    proposedBy: row.proposed_by,
    payload: parseJson(row.payload_json),
    evidence: row.evidence_json ? parseJson(row.evidence_json) : null,
    checks: row.checks_json ? parseJson(row.checks_json) : null,
    risk: row.risk,
    requestedAction: row.requested_action,
    status: row.status,
    reviewNote: row.review_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    appliedAt: row.applied_at,
    appliedBy: row.applied_by,
  };
}

function payloadJson(value: unknown): string {
  if (value === undefined || value === null || value === "") return "{}";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function optionalJson(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw httpError(400, `${field} 必填`);
  return value.trim();
}

function requiredLane(value: unknown): PwProposalLane {
  const lane = requiredText(value, "lane");
  if (lane !== "content" && lane !== "ops") throw httpError(400, "lane 必须是 content 或 ops");
  return lane;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function pick(camel: unknown, snake: unknown): unknown {
  return camel === undefined ? snake : camel;
}

function clampInt(value: unknown, fallback: number, cap: number, label: string): number {
  const n = value === undefined || value === null || value === "" ? fallback : Number(String(value).trim());
  if (!Number.isInteger(n) || n < 1) throw httpError(400, `${label} 必须是正整数`);
  return Math.min(n, cap);
}

function clampOffset(value: unknown): number {
  const n = value === undefined || value === null || value === "" ? 0 : Number(String(value).trim());
  if (!Number.isInteger(n) || n < 0) throw httpError(400, "offset 必须是 ≥0 的整数");
  return n;
}
