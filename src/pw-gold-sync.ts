import type { DatabaseSync } from "node:sqlite";
import { recordPwEvent } from "./pw-runs.ts";
import { goldBody, goldSummary, goldTitle } from "./pw-gold-format.ts";

export type PwGoldMirrorRow = {
  id: string;
  source_verdict_id: string;
  kind: "gold";
  text: string;
  /** TASK-PW-57：行内标题（stripMd 派生，全文 text 原样保留） */
  title: string;
  /** TASK-PW-57：行内一句摘要（stripMd 派生，取前 120 字） */
  summary: string;
  /** TASK-PW-57：归一化后的 markdown 全文（前端展开区渲染用） */
  body: string;
  handle: string | null;
  project_id: string;
  card_id: string | null;
  confirmed_at: string | null;
  mirrored_at: string;
};

/** TASK-PW-57：查询行追加 title/summary/body 派生字段，其余字段原样透传。 */
function withGoldFormat(row: PwGoldMirrorRow): PwGoldMirrorRow {
  return {
    ...row,
    title: goldTitle(row.text),
    summary: goldSummary(row.text),
    body: goldBody(row.text),
  };
}

type ConfirmedGoldRow = {
  id: string;
  kind: "gold";
  text: string;
  handle: string | null;
  project_id: string;
  card_id: string | null;
  updated_at: string;
};

export function ensurePwGoldMirrorTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pw_gold_mirror (
      id TEXT PRIMARY KEY,
      source_verdict_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK(kind IN ('gold')),
      text TEXT NOT NULL,
      handle TEXT,
      project_id TEXT,
      card_id TEXT,
      confirmed_at TEXT,
      mirrored_at TEXT NOT NULL
    );
  `);
}

export function mirrorConfirmedGolds(
  db: DatabaseSync,
  options: { actor?: "human" | "system" } = {},
): { added: number; skipped: number } {
  const sourceRows = db.prepare(`
    SELECT id, kind, text, handle, project_id, card_id, updated_at
    FROM pt_verdicts
    WHERE kind = 'gold' AND status = 'confirmed'
    ORDER BY updated_at, id
  `).all() as ConfirmedGoldRow[];
  const insert = db.prepare(`
    INSERT OR IGNORE INTO pw_gold_mirror(
      id, source_verdict_id, kind, text, handle, project_id, card_id,
      confirmed_at, mirrored_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let added = 0;
  let skipped = 0;
  for (const row of sourceRows) {
    const result = insert.run(
      row.id,
      row.id,
      row.kind,
      row.text,
      row.handle,
      row.project_id,
      row.card_id,
      row.updated_at,
      new Date().toISOString(),
    );
    if (Number(result.changes) === 1) added += 1;
    else skipped += 1;
  }
  // TASK-PW-23：金子镜像同步记账；TASK-PW-26：缺省 actor=human（UI/路由后路），自动镜像传 system
  recordPwEvent(db, {
    eventType: "mirror",
    actor: options.actor ?? "human",
    payloadJson: JSON.stringify({ inserted: added, total: added + skipped }),
  });
  return { added, skipped };
}

export function listMirroredGolds(
  db: DatabaseSync,
  options: { keyword?: string } = {},
): PwGoldMirrorRow[] {
  const keyword = options.keyword?.trim();
  if (!keyword) {
    return db.prepare(`
      SELECT id, source_verdict_id, kind, text, handle, project_id, card_id,
             confirmed_at, mirrored_at
      FROM pw_gold_mirror
      ORDER BY mirrored_at, id
    `).all().map(withGoldFormat) as PwGoldMirrorRow[];
  }
  return db.prepare(`
    SELECT id, source_verdict_id, kind, text, handle, project_id, card_id,
           confirmed_at, mirrored_at
    FROM pw_gold_mirror
    WHERE instr(lower(text), lower(?)) > 0
       OR instr(lower(COALESCE(handle, '')), lower(?)) > 0
    ORDER BY mirrored_at, id
  `).all(keyword, keyword).map(withGoldFormat) as PwGoldMirrorRow[];
}
