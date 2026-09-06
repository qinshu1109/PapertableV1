/**
 * TASK-PW-12（简报 12）：笔记召回事件账本（一期）。
 * 给「系统把某条笔记摆到人面前」或「人对摆出的笔记做了动作」记账，先拿使用率分母——
 * 分不清 0.2% 使用率是「没叫货」还是「叫了没人用」，要靠这张表区分召回机会与真实使用。
 *
 * 一期纯加法：一张事件表 + 在四个现有出口打点 + 两个只读统计接口。不改任何现有表结构、
 * 不改现有行为、不调 LLM、不碰 Memos 库（保持只读）。
 *
 * 纪律：
 * - 打点红线：AI/系统只能写 `surfaced`（echo/miner 摆出）；`confirmed`/`rejected`/
 *   `attached`/`settled` 只来自人触发的现有接口动作。`used` 一期无现成入口不产生，
 *   表结构预留即可，不为它发明新流程。
 * - 只读接口：summary / list 均只 SELECT；建表只由 ensure 负责（幂等）。
 * - 失败处理：echo 打点由 buildPwNoteEcho 包 try/catch 兜底（不得改变回响返回）；
 *   其余打点失败按所在模块现有错误纪律（事务内则整体回滚）。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { httpError, jsonObject, nowIso } from "./data.ts";

export const PW_RECALL_EVENT_KINDS = [
  "surfaced", "confirmed", "rejected", "attached", "used", "settled",
] as const;
export const PW_RECALL_SURFACES = ["echo", "miner", "note_tree", "verdict"] as const;
export type PwRecallEventKind = typeof PW_RECALL_EVENT_KINDS[number];
export type PwRecallSurface = typeof PW_RECALL_SURFACES[number];

export type PwRecallEventInput = {
  eventKind: PwRecallEventKind;
  surface: PwRecallSurface;
  betId?: string | null;
  noteUid?: string | null;
  minerCandidateId?: string | null;
  runId?: string | null;
  role?: string | null;
  meta?: Record<string, unknown> | null;
};

export function ensurePwRecallEventTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pw_recall_events (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      event_kind TEXT NOT NULL CHECK(event_kind IN ('surfaced','confirmed','rejected','attached','used','settled')),
      surface TEXT NOT NULL CHECK(surface IN ('echo','miner','note_tree','verdict')),
      bet_id TEXT,
      note_uid TEXT,
      miner_candidate_id TEXT,
      run_id TEXT,
      role TEXT,
      meta_json TEXT
    );
    CREATE INDEX IF NOT EXISTS pw_recall_events_bet
      ON pw_recall_events(bet_id, created_at);
    CREATE INDEX IF NOT EXISTS pw_recall_events_note
      ON pw_recall_events(note_uid, created_at);
    CREATE INDEX IF NOT EXISTS pw_recall_events_kind
      ON pw_recall_events(event_kind, created_at);
  `);
}

/** 记一行事件。打点失败按调用方纪律处理（echo 由调用方 try/catch 兜底）。 */
export function recordPwRecallEvent(db: DatabaseSync, event: PwRecallEventInput): void {
  ensurePwRecallEventTables(db);
  db.prepare(`
    INSERT INTO pw_recall_events(
      id, created_at, event_kind, surface, bet_id, note_uid,
      miner_candidate_id, run_id, role, meta_json
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    nowIso(),
    event.eventKind,
    event.surface,
    event.betId ?? null,
    event.noteUid ?? null,
    event.minerCandidateId ?? null,
    event.runId ?? null,
    event.role ?? null,
    event.meta ? JSON.stringify(event.meta) : null,
  );
}

/**
 * 只读汇总：按 surface×event_kind 聚合 + totals + distinct 去重笔记数 + 按天趋势。
 * days 默认 30、上限 365；按 created_at（ISO UTC，字符串可比）过滤近 N 天。
 * now 可注入（测试固定「当前」），路由不传即用真实时钟。
 */
export function getPwRecallEventsSummary(
  db: DatabaseSync,
  daysRaw: unknown = 30,
  now: () => string = nowIso,
): {
  days: number;
  bySurface: Record<PwRecallSurface, Record<PwRecallEventKind, number>>;
  totals: Record<PwRecallEventKind, number>;
  distinctNotesSurfaced: number;
  distinctNotesConfirmed: number;
  byDay: Array<{ date: string; surfaced: number; confirmed: number }>;
} {
  ensurePwRecallEventTables(db);
  const days = clampDays(daysRaw);
  const cutoff = new Date(Date.parse(now()) - days * 86_400_000).toISOString();

  const zeroKinds = Object.fromEntries(PW_RECALL_EVENT_KINDS.map((kind) => [kind, 0])) as
    Record<PwRecallEventKind, number>;
  const bySurface = Object.fromEntries(PW_RECALL_SURFACES.map((surface) => [surface, { ...zeroKinds }])) as
    Record<PwRecallSurface, Record<PwRecallEventKind, number>>;
  const totals: Record<PwRecallEventKind, number> = { ...zeroKinds };

  const rows = db.prepare(`
    SELECT surface, event_kind, COUNT(*) AS n
    FROM pw_recall_events
    WHERE created_at >= ?
    GROUP BY surface, event_kind
  `).all(cutoff) as Array<{ surface: PwRecallSurface; event_kind: PwRecallEventKind; n: number }>;
  for (const row of rows) {
    if (row.surface in bySurface) bySurface[row.surface][row.event_kind] = Number(row.n);
    if (row.event_kind in totals) totals[row.event_kind] += Number(row.n);
  }

  const distinctNotes = (kind: PwRecallEventKind): number => Number((
    db.prepare(`
      SELECT COUNT(DISTINCT note_uid) AS n FROM pw_recall_events
      WHERE created_at >= ? AND event_kind = ? AND note_uid IS NOT NULL
    `).get(cutoff, kind) as { n: number }
  ).n);

  const byDay = (db.prepare(`
    SELECT date(created_at) AS d,
      SUM(CASE WHEN event_kind='surfaced' THEN 1 ELSE 0 END) AS surfaced,
      SUM(CASE WHEN event_kind='confirmed' THEN 1 ELSE 0 END) AS confirmed
    FROM pw_recall_events
    WHERE created_at >= ?
    GROUP BY date(created_at)
    ORDER BY d ASC
  `).all(cutoff) as Array<{ d: string; surfaced: number; confirmed: number }>)
    .map((row) => ({ date: row.d, surfaced: Number(row.surfaced), confirmed: Number(row.confirmed) }));

  return {
    days,
    bySurface,
    totals,
    distinctNotesSurfaced: distinctNotes("surfaced"),
    distinctNotesConfirmed: distinctNotes("confirmed"),
    byDay,
  };
}

/** 原始翻页：created_at 倒序。limit 默认 100、上限 500；offset 默认 0。 */
export function listPwRecallEvents(
  db: DatabaseSync,
  limitRaw: unknown = 100,
  offsetRaw: unknown = 0,
): { events: Array<Record<string, unknown>>; limit: number; offset: number } {
  ensurePwRecallEventTables(db);
  const limit = clampLimit(limitRaw, 100, 500, "limit");
  const offset = clampOffset(offsetRaw);
  const rows = db.prepare(`
    SELECT id, created_at, event_kind, surface, bet_id, note_uid,
           miner_candidate_id, run_id, role, meta_json
    FROM pw_recall_events
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset) as Array<{
    id: string;
    created_at: string;
    event_kind: PwRecallEventKind;
    surface: PwRecallSurface;
    bet_id: string | null;
    note_uid: string | null;
    miner_candidate_id: string | null;
    run_id: string | null;
    role: string | null;
    meta_json: string | null;
  }>;
  return {
    events: rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      eventKind: row.event_kind,
      surface: row.surface,
      betId: row.bet_id,
      noteUid: row.note_uid,
      minerCandidateId: row.miner_candidate_id,
      runId: row.run_id,
      role: row.role,
      meta: row.meta_json ? jsonObject(row.meta_json) : null,
    })),
    limit,
    offset,
  };
}

function clampDays(value: unknown): number {
  const days = value === undefined || value === null || value === "" ? 30 : Number(String(value).trim());
  if (!Number.isInteger(days) || days < 1 || days > 365) throw httpError(400, "days 必须是 1-365 的整数");
  return days;
}

function clampLimit(value: unknown, fallback: number, cap: number, label: string): number {
  const n = value === undefined || value === null || value === "" ? fallback : Number(String(value).trim());
  if (!Number.isInteger(n) || n < 1) throw httpError(400, `${label} 必须是正整数`);
  return Math.min(n, cap);
}

function clampOffset(value: unknown): number {
  const n = value === undefined || value === null || value === "" ? 0 : Number(String(value).trim());
  if (!Number.isInteger(n) || n < 0) throw httpError(400, "offset 必须是 ≥0 的整数");
  return n;
}
