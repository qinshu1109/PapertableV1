/**
 * TASK-PW-72 批次 A：押注信号 / 发件箱 / 处置令牌。
 * 纯函数模块，db 由调用方传入；不读凭证、不发网络请求。
 */
import { hash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const PW_NOTIFY_KINDS = [
  "SETTLEMENT_NEAR",
  "USER_TIMER_DUE",
  "EVIDENCE_CHANGED",
  "STALE_LOCAL",
  "MANUAL_TEST",
] as const;

export type PwNotifyKind = (typeof PW_NOTIFY_KINDS)[number];
export type PwNotifySeverity = "low" | "normal" | "high";

export type PwBetSignalRow = {
  id: string;
  event_uuid: string;
  bet_id: string;
  kind: PwNotifyKind;
  observed_at: string;
  bet_version: number;
  evidence_snapshot_id: string | null;
  reason_json: string;
  severity: PwNotifySeverity;
  created_at: string;
};

export type PwNotificationOutboxRow = {
  id: string;
  event_uuid: string;
  transport: string;
  payload_json: string;
  attempts: number;
  next_attempt_at: string;
  sent_at: string | null;
  last_error: string | null;
  created_at: string;
};

export type PwDispositionTokenRow = {
  id: string;
  token_hash: string;
  event_uuid: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
};

export type CreateBetSignalInput = {
  betId: string;
  kind: PwNotifyKind;
  severity?: PwNotifySeverity;
  reason?: unknown;
};

export type CreateBetSignalOpts = {
  now: string;
  tokenTtlHours?: number;
  baseUrl?: string;
};

export type CreateBetSignalResult = {
  alreadyExists: boolean;
  signal: PwBetSignalRow;
  tokenPlaintext?: string;
};

export type ComputeDueSignalsOpts = {
  now: string;
  leadHours?: number;
};

export type NotifyBet = {
  id: string;
  title?: string | null;
  thesis?: string | null;
  metric?: string | null;
};

export type VerifyDispositionOk = {
  status: "ok";
  eventUuid: string;
  signal: {
    id: string;
    betId: string;
    kind: PwNotifyKind;
    observedAt: string;
    severity: PwNotifySeverity;
    reason: unknown;
    betVersion: number;
  };
};

export type VerifyDispositionResult =
  | { status: "not_found" }
  | { status: "expired" }
  | VerifyDispositionOk;

const KIND_SET = new Set<string>(PW_NOTIFY_KINDS);
const SEVERITY_SET = new Set<string>(["low", "normal", "high"]);
const DEFAULT_TOKEN_TTL_HOURS = 48;
const DEFAULT_LEAD_HOURS = 24;
const DEFAULT_BASE_URL = "https://dsh.cozai.net";
const BACKOFF_BASE_MS = 60 * 1000;
const BACKOFF_CAP_MS = 30 * 60 * 1000;
const P1_BET_VERSION = 1;

const REASON_LINE: Record<PwNotifyKind, string> = {
  SETTLEMENT_NEAR: "结账日临近",
  USER_TIMER_DUE: "用户计时到期",
  EVIDENCE_CHANGED: "证据变化",
  STALE_LOCAL: "本地过期",
  MANUAL_TEST: "测试信号",
};

export function ensurePwNotifyTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pw_bet_signals (
      id TEXT PRIMARY KEY,
      event_uuid TEXT NOT NULL UNIQUE,
      bet_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN (
        'SETTLEMENT_NEAR','USER_TIMER_DUE','EVIDENCE_CHANGED','STALE_LOCAL','MANUAL_TEST'
      )),
      observed_at TEXT NOT NULL,
      bet_version INTEGER NOT NULL DEFAULT 1,
      evidence_snapshot_id TEXT,
      reason_json TEXT NOT NULL DEFAULT '{}',
      severity TEXT NOT NULL DEFAULT 'normal' CHECK(severity IN ('low','normal','high')),
      created_at TEXT NOT NULL,
      UNIQUE(bet_id, kind, bet_version)
    );
    CREATE TABLE IF NOT EXISTS pw_notification_outbox (
      id TEXT PRIMARY KEY,
      event_uuid TEXT NOT NULL UNIQUE,
      transport TEXT NOT NULL DEFAULT 'feishu',
      payload_json TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      sent_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pw_disposition_tokens (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      event_uuid TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

export function createBetSignal(
  db: DatabaseSync,
  input: CreateBetSignalInput,
  opts: CreateBetSignalOpts,
): CreateBetSignalResult {
  ensurePwNotifyTables(db);
  const kind = requireKind(input.kind);
  const severity = requireSeverity(input.severity ?? "normal");
  const betId = requiredText(input.betId, "betId");
  const now = requiredText(opts.now, "now");
  const existing = db.prepare(`
    SELECT * FROM pw_bet_signals
    WHERE bet_id = ? AND kind = ? AND bet_version = ?
  `).get(betId, kind, P1_BET_VERSION) as PwBetSignalRow | undefined;
  if (existing) {
    return { alreadyExists: true, signal: existing };
  }

  const eventUuid = randomUUID();
  const signalId = randomUUID();
  const outboxId = randomUUID();
  const tokenId = randomUUID();
  const tokenPlaintext = randomBytes(16).toString("hex");
  const tokenHash = sha256Hex(tokenPlaintext);
  const ttlHours = opts.tokenTtlHours ?? DEFAULT_TOKEN_TTL_HOURS;
  const expiresAt = addMs(now, ttlHours * 60 * 60 * 1000);
  const reasonJson = JSON.stringify(input.reason ?? {});
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const signal: PwBetSignalRow = {
    id: signalId,
    event_uuid: eventUuid,
    bet_id: betId,
    kind,
    observed_at: now,
    bet_version: P1_BET_VERSION,
    evidence_snapshot_id: null,
    reason_json: reasonJson,
    severity,
    created_at: now,
  };
  const payload = buildNotifyPayload(signal, { id: betId }, tokenPlaintext, baseUrl);

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO pw_bet_signals(
        id, event_uuid, bet_id, kind, observed_at, bet_version,
        evidence_snapshot_id, reason_json, severity, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
    `).run(
      signalId,
      eventUuid,
      betId,
      kind,
      now,
      P1_BET_VERSION,
      reasonJson,
      severity,
      now,
    );
    db.prepare(`
      INSERT INTO pw_notification_outbox(
        id, event_uuid, transport, payload_json, attempts,
        next_attempt_at, sent_at, last_error, created_at
      ) VALUES(?, ?, 'feishu', ?, 0, ?, NULL, NULL, ?)
    `).run(outboxId, eventUuid, JSON.stringify(payload), now, now);
    db.prepare(`
      INSERT INTO pw_disposition_tokens(
        id, token_hash, event_uuid, expires_at, used_at, created_at
      ) VALUES(?, ?, ?, ?, NULL, ?)
    `).run(tokenId, tokenHash, eventUuid, expiresAt, now);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Keep the original error (constraint / ABORT).
    }
    if (isUniqueConstraint(error)) {
      const raced = db.prepare(`
        SELECT * FROM pw_bet_signals
        WHERE bet_id = ? AND kind = ? AND bet_version = ?
      `).get(betId, kind, P1_BET_VERSION) as PwBetSignalRow | undefined;
      if (raced) return { alreadyExists: true, signal: raced };
    }
    throw error;
  }

  return { alreadyExists: false, signal, tokenPlaintext };
}

export function computeDueSignals(
  db: DatabaseSync,
  opts: ComputeDueSignalsOpts,
): CreateBetSignalResult[] {
  ensurePwNotifyTables(db);
  const now = requiredText(opts.now, "now");
  const leadHours = opts.leadHours ?? DEFAULT_LEAD_HOURS;
  const windowEnd = addMs(now, leadHours * 60 * 60 * 1000);
  const due = db.prepare(`
    SELECT id FROM pw_bets
    WHERE status = 'pending'
      AND checkout_date IS NOT NULL
      AND checkout_date != ''
      AND checkout_date <= ?
  `).all(windowEnd) as Array<{ id: string }>;
  return due.map((row) =>
    createBetSignal(db, { betId: row.id, kind: "SETTLEMENT_NEAR" }, { now }),
  );
}

export function listPendingOutbox(
  db: DatabaseSync,
  now: string,
): PwNotificationOutboxRow[] {
  ensurePwNotifyTables(db);
  return db.prepare(`
    SELECT * FROM pw_notification_outbox
    WHERE sent_at IS NULL AND next_attempt_at <= ?
    ORDER BY created_at ASC
  `).all(requiredText(now, "now")) as PwNotificationOutboxRow[];
}

export function markOutboxSent(db: DatabaseSync, id: string, sentAt: string): void {
  ensurePwNotifyTables(db);
  const result = db.prepare(`
    UPDATE pw_notification_outbox SET sent_at = ? WHERE id = ?
  `).run(requiredText(sentAt, "sentAt"), requiredText(id, "id"));
  if (result.changes === 0) {
    throw new Error(`outbox not found: ${id}`);
  }
}

export function markOutboxFailed(
  db: DatabaseSync,
  id: string,
  error: string,
  opts: { now: string },
): PwNotificationOutboxRow {
  ensurePwNotifyTables(db);
  const now = requiredText(opts.now, "now");
  const row = db.prepare(`
    SELECT * FROM pw_notification_outbox WHERE id = ?
  `).get(requiredText(id, "id")) as PwNotificationOutboxRow | undefined;
  if (!row) throw new Error(`outbox not found: ${id}`);
  const attempts = row.attempts + 1;
  const delayMs = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * (2 ** (attempts - 1)));
  const nextAttemptAt = addMs(now, delayMs);
  db.prepare(`
    UPDATE pw_notification_outbox
    SET attempts = ?, next_attempt_at = ?, last_error = ?
    WHERE id = ?
  `).run(attempts, nextAttemptAt, error, id);
  return db.prepare(`
    SELECT * FROM pw_notification_outbox WHERE id = ?
  `).get(id) as PwNotificationOutboxRow;
}

export function verifyDispositionToken(
  db: DatabaseSync,
  tokenPlaintext: string,
  now: string,
): VerifyDispositionResult {
  const hash = sha256Hex(requiredText(tokenPlaintext, "token"));
  const row = db.prepare(`
    SELECT
      t.event_uuid AS event_uuid,
      t.expires_at AS expires_at,
      s.id AS signal_id,
      s.bet_id AS bet_id,
      s.kind AS kind,
      s.observed_at AS observed_at,
      s.severity AS severity,
      s.reason_json AS reason_json,
      s.bet_version AS bet_version
    FROM pw_disposition_tokens t
    LEFT JOIN pw_bet_signals s ON s.event_uuid = t.event_uuid
    WHERE t.token_hash = ?
  `).get(hash) as
    | {
      event_uuid: string;
      expires_at: string;
      signal_id: string | null;
      bet_id: string | null;
      kind: PwNotifyKind | null;
      observed_at: string | null;
      severity: PwNotifySeverity | null;
      reason_json: string | null;
      bet_version: number | null;
    }
    | undefined;
  if (!row) return { status: "not_found" };
  if (Date.parse(row.expires_at) <= Date.parse(requiredText(now, "now"))) {
    return { status: "expired" };
  }
  if (!row.signal_id || !row.bet_id || !row.kind || !row.observed_at || !row.severity) {
    return { status: "not_found" };
  }
  let reason: unknown = {};
  try {
    reason = row.reason_json ? JSON.parse(row.reason_json) : {};
  } catch {
    reason = {};
  }
  return {
    status: "ok",
    eventUuid: row.event_uuid,
    signal: {
      id: row.signal_id,
      betId: row.bet_id,
      kind: row.kind,
      observedAt: row.observed_at,
      severity: row.severity,
      reason,
      betVersion: row.bet_version ?? P1_BET_VERSION,
    },
  };
}

export function buildNotifyPayload(
  signal: Pick<PwBetSignalRow, "kind">,
  _bet: NotifyBet,
  tokenPlaintext: string,
  baseUrl: string,
): Record<string, unknown> {
  const reasonLine = REASON_LINE[signal.kind] ?? "押注状态变化";
  const url = `${baseUrl.replace(/\/+$/, "")}/n/${tokenPlaintext}`;
  return {
    config: { wide_screen_mode: true },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "押注状态变化" },
    },
    elements: [
      {
        tag: "div",
        text: { tag: "plain_text", content: reasonLine },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            type: "primary",
            text: { tag: "plain_text", content: "查看证据" },
            url,
          },
        ],
      },
    ],
  };
}

function requireKind(kind: string): PwNotifyKind {
  if (!KIND_SET.has(kind)) {
    throw new Error(`invalid signal kind: ${kind}`);
  }
  return kind as PwNotifyKind;
}

function requireSeverity(severity: string): PwNotifySeverity {
  if (!SEVERITY_SET.has(severity)) {
    throw new Error(`invalid severity: ${severity}`);
  }
  return severity as PwNotifySeverity;
}

function requiredText(value: string | undefined, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} required`);
  }
  return value;
}

function sha256Hex(value: string): string {
  return hash("sha256", value, "hex");
}

function addMs(iso: string, ms: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`invalid time: ${iso}`);
  return new Date(t + ms).toISOString();
}

function isUniqueConstraint(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed");
}
