/** TASK-PW-61：笔记大盘只读聚合 + 可重建身价日快照。 */
import type { DatabaseSync } from "node:sqlite";
import { httpError } from "./data.ts";
import { listContentBets } from "./pw-content-bets.ts";
import { countPwNotes, readPwNotesList, type PwNote } from "./pw-notes.ts";

type ValueRow = {
  note_uid: string;
  bet_id: string | null;
  role: string | null;
  keyword: string | null;
  attach_at: string;
  drafts: number;
  products: number;
  outcome: "gold" | "tomb" | "void" | null;
  decided_at: string | null;
  last_draft_at: string | null;
  last_product_at: string | null;
};

export function ensurePwNoteBoardTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pw_note_value_daily (
      note_uid TEXT NOT NULL,
      day TEXT NOT NULL,
      score REAL NOT NULL,
      PRIMARY KEY(note_uid, day)
    )
  `);
}

/**
 * 身价公式（写死）：确认挂接×1 + 进草案×3 + 进成品×5 + 结账胜+10/平+3/败+0。
 * 现有 pw_verdicts 只有 gold/tomb/void，没有“平”档，故 draw 当前推不出并记 0；
 * tomb（败）不扣分，只在输出挂 reviewPending=true。
 */
export function noteValueScore(row: Pick<ValueRow, "drafts" | "products" | "outcome">): number {
  return 1 + row.drafts * 3 + row.products * 5 + (row.outcome === "gold" ? 10 : 0);
}

/** 每天 miner tick 后全量重算；INSERT OR REPLACE 使快照可重建、同日幂等。 */
export function snapshotPwNoteValues(db: DatabaseSync, day = localDay(new Date())): number {
  ensurePwNoteBoardTables(db);
  const rows = valueRows(db);
  const put = db.prepare(`
    INSERT OR REPLACE INTO pw_note_value_daily(note_uid, day, score) VALUES(?, ?, ?)
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) put.run(row.note_uid, day, noteValueScore(row));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return rows.length;
}

export function getPwNoteBoard(db: DatabaseSync, now = new Date()): Record<string, unknown> {
  ensurePwNoteBoardTables(db);
  const notes = readAllNotes();
  const notesByUid = new Map(notes.map((note) => [note.uid, note]));
  const values = valueRows(db);
  const usedNotes = values.length;
  const intoDrafts = values.filter((row) => row.drafts > 0).length;
  const intoProducts = values.filter((row) => row.products > 0).length;
  const checkoutBack = values.filter((row) => row.outcome === "gold" || row.outcome === "tomb").length;
  const lastRun = latestRun(db);

  const topNotes = values.map((row) => {
    const note = notesByUid.get(row.note_uid);
    const score = noteValueScore(row);
    const trend = dailyTrend(db, row.note_uid, now);
    const checkout = row.outcome === "gold"
      ? "win"
      : row.outcome === "tomb"
        ? "loss"
        : row.bet_id ? "pending" : "none";
    return {
      uid: row.note_uid,
      keyword: row.keyword || truncate(note?.content ?? row.note_uid, 20),
      score,
      trend,
      citations: 1,
      drafts: row.drafts,
      products: row.products,
      checkout,
      ...(checkout === "loss" ? { reviewPending: true } : {}),
      roles: row.role ? { [row.role]: 1 } : {},
      lastUsedAt: latest([row.attach_at, row.last_draft_at, row.last_product_at, row.decided_at]),
      memosUrl: note?.url ?? null,
    };
  }).sort((a, b) => b.score - a.score || a.uid.localeCompare(b.uid)).slice(0, 5);

  const totalNotes = countPwNotes();
  const unusedCount = Math.max(0, totalNotes - usedNotes);
  const rejectedEver = Number((db.prepare(`
    SELECT count(DISTINCT ref_uid) AS n FROM pw_miner_candidates
    WHERE source='note' AND status='rejected'
  `).get() as { n: number }).n);

  return {
    lastRun,
    kpis: { totalNotes, usedNotes, intoDrafts, intoProducts, checkoutBack },
    todayBySource: lastRun?.bySource ?? { note: 0, gold: 0, tombstone: 0, memos: 0 },
    week: weekRows(db, now),
    topNotes,
    gaps: buildGaps(db),
    unused: {
      count: unusedCount,
      pct: totalNotes === 0 ? 0 : Number((unusedCount * 100 / totalNotes).toFixed(1)),
      rejectedEver,
    },
  };
}

export function getPwNoteJourney(db: DatabaseSync, uidRaw: string): { events: Array<Record<string, unknown>> } {
  const uid = typeof uidRaw === "string" ? uidRaw.trim() : "";
  if (!uid) throw httpError(400, "uid 必填");
  const attach = db.prepare("SELECT * FROM pw_note_attach WHERE note_uid=? AND status='confirmed'")
    .get(uid) as { bet_id: string | null; role: string | null; updated_at: string } | undefined;
  if (!attach) return { events: [] };
  const events: Array<{ at: string; kind: "attach" | "draft" | "product" | "data" | "checkout"; label: string }> = [{
    at: attach.updated_at,
    kind: "attach",
    label: `确认挂接${attach.role ? ` · ${attach.role}` : ""}（身价 +1）`,
  }];
  if (attach.bet_id) {
    const drafts = db.prepare(`SELECT created_at FROM pw_content_drafts WHERE bet_id=? ORDER BY created_at`)
      .all(attach.bet_id) as Array<{ created_at: string }>;
    events.push(...drafts.map((row) => ({ at: row.created_at, kind: "draft" as const, label: "进入草案（身价 +3）" })));
    const products = db.prepare(`
      SELECT created_at, type FROM pw_artifacts WHERE bet_id=? AND detached_at IS NULL ORDER BY created_at
    `).all(attach.bet_id) as Array<{ created_at: string; type: string }>;
    events.push(...products.map((row) => ({ at: row.created_at, kind: "product" as const, label: `进入成品 · ${row.type}（身价 +5）` })));
    const docs = db.prepare(`SELECT created_at FROM pw_data_docs WHERE bet_id=? ORDER BY created_at`)
      .all(attach.bet_id) as Array<{ created_at: string }>;
    events.push(...docs.map((row) => ({ at: row.created_at, kind: "data" as const, label: "数据回流" })));
    const verdict = db.prepare(`
      SELECT outcome, decided_at FROM pw_verdicts
      WHERE bet_id=? AND outcome!='void' ORDER BY decided_at DESC LIMIT 1
    `).get(attach.bet_id) as { outcome: "gold" | "tomb"; decided_at: string } | undefined;
    if (verdict) events.push({
      at: verdict.decided_at,
      kind: "checkout",
      label: verdict.outcome === "gold" ? "结账胜（身价 +10）" : "结账败 · 待复核（身价 +0）",
    });
  }
  events.sort((a, b) => a.at.localeCompare(b.at));
  return { events };
}

function valueRows(db: DatabaseSync): ValueRow[] {
  return db.prepare(`
    SELECT a.note_uid, a.bet_id, a.role, a.keyword, a.updated_at AS attach_at,
      count(DISTINCT d.id) AS drafts,
      count(DISTINCT p.id) AS products,
      v.outcome,
      v.decided_at,
      max(d.created_at) AS last_draft_at,
      max(p.created_at) AS last_product_at
    FROM pw_note_attach a
    LEFT JOIN pw_content_drafts d ON d.bet_id=a.bet_id
    LEFT JOIN pw_artifacts p ON p.bet_id=a.bet_id AND p.detached_at IS NULL
    LEFT JOIN pw_verdicts v ON v.bet_id=a.bet_id AND v.outcome!='void'
    WHERE a.status='confirmed'
    GROUP BY a.note_uid, a.bet_id, a.role, a.keyword, a.updated_at, v.outcome, v.decided_at
  `).all() as ValueRow[];
}

function latestRun(db: DatabaseSync): null | {
  at: string;
  triggerKind: string;
  candidates: number;
  confirmed: number;
  rejected: number;
  costCny: number;
  bySource: Record<string, number>;
} {
  const row = db.prepare(`
    SELECT * FROM pw_miner_runs WHERE status='done' ORDER BY finished_at DESC, id DESC LIMIT 1
  `).get() as {
    id: string;
    finished_at: string;
    trigger_kind: string;
    candidates_count: number;
    cost_cny: number | null;
    by_source_json: string | null;
  } | undefined;
  if (!row) return null;
  const counts = db.prepare(`
    SELECT status, count(*) AS n FROM pw_miner_candidates WHERE run_id=? GROUP BY status
  `).all(row.id) as Array<{ status: string; n: number }>;
  return {
    at: row.finished_at,
    triggerKind: row.trigger_kind,
    candidates: row.candidates_count,
    confirmed: counts.find((item) => item.status === "confirmed")?.n ?? 0,
    rejected: counts.find((item) => item.status === "rejected")?.n ?? 0,
    costCny: row.cost_cny ?? 0,
    bySource: parseObject(row.by_source_json),
  };
}

function weekRows(db: DatabaseSync, now: Date): Array<{ day: string; fished: number; confirmed: number }> {
  const result: Array<{ day: string; fished: number; confirmed: number }> = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    const day = localDay(date);
    const row = db.prepare(`
      SELECT count(c.id) AS fished,
        sum(CASE WHEN c.status='confirmed' THEN 1 ELSE 0 END) AS confirmed
      FROM pw_miner_runs r
      LEFT JOIN pw_miner_candidates c ON c.run_id=r.id
      WHERE substr(r.started_at,1,10)=?
    `).get(day) as { fished: number; confirmed: number | null };
    result.push({ day: day.slice(5), fished: Number(row.fished), confirmed: Number(row.confirmed ?? 0) });
  }
  return result;
}

function buildGaps(db: DatabaseSync): Array<Record<string, unknown>> {
  const runIds = (db.prepare(`
    SELECT id FROM pw_miner_runs WHERE status='done' ORDER BY finished_at DESC, id DESC LIMIT 3
  `).all() as Array<{ id: string }>).map((row) => row.id);
  return listContentBets(db).filter((bet) => bet.status === "pending").flatMap((bet) => {
    const relatedNotes = Number((db.prepare(`
      SELECT count(*) AS n FROM pw_miner_candidates WHERE suggested_bet_id=? AND source='note'
    `).get(bet.id) as { n: number }).n);
    const confirmedNotes = Number((db.prepare(`
      SELECT count(*) AS n FROM pw_note_attach WHERE bet_id=? AND status='confirmed'
    `).get(bet.id) as { n: number }).n);
    const drafts = Number((db.prepare(`SELECT count(*) AS n FROM pw_content_drafts WHERE bet_id=?`)
      .get(bet.id) as { n: number }).n);
    const runsZero = runIds.filter((runId) => !db.prepare(`
      SELECT 1 FROM pw_miner_candidates WHERE run_id=? AND suggested_bet_id=? LIMIT 1
    `).get(runId, bet.id)).length;
    const kind = runIds.length >= 3 && runsZero >= 3
      ? "no_material"
      : relatedNotes > 0 && confirmedNotes === 0
        ? "material_unused"
        : confirmedNotes > 0 && drafts === 0
          ? "no_output"
          : null;
    return kind ? [{
      betId: bet.id,
      title: bet.title,
      kind,
      runsZero,
      relatedNotes,
      confirmedNotes,
      drafts,
    }] : [];
  });
}

function dailyTrend(db: DatabaseSync, uid: string, now: Date): number[] {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  const rows = db.prepare(`
    SELECT day, score FROM pw_note_value_daily WHERE note_uid=? AND day>=? ORDER BY day
  `).all(uid, localDay(start)) as Array<{ day: string; score: number }>;
  const byDay = new Map(rows.map((row) => [row.day, row.score]));
  const trend: number[] = [];
  let last = 0;
  for (let offset = 6; offset >= 0; offset -= 1) {
    const day = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset));
    last = byDay.get(day) ?? last;
    trend.push(last);
  }
  return trend;
}

function readAllNotes(): PwNote[] {
  const notes: PwNote[] = [];
  for (let offset = 0;; offset += 200) {
    const page = readPwNotesList({ limit: 200, offset });
    notes.push(...page);
    if (page.length < 200) return notes;
  }
}

function latest(values: Array<string | null>): string | null {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
}

function parseObject(raw: string | null): Record<string, number> {
  try {
    const value: unknown = JSON.parse(raw ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, number>
      : {};
  } catch {
    return {};
  }
}

function truncate(value: string, max: number): string {
  return [...value.trim()].slice(0, max).join("");
}

function localDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
