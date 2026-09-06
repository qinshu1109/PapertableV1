import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { httpError, nowIso } from "./data.ts";

export type PwArtifactType = "video" | "livestream" | "article" | "cover" | "link";

export type PwArtifactRow = {
  id: string;
  bet_id: string;
  platform: string;
  url: string | null;
  title: string | null;
  type: PwArtifactType;
  published_at: string | null;
  note: string | null;
  created_at: string;
  detached_at: string | null;
};

export type PwArtifactInput = {
  betId: string;
  platform: string;
  type: PwArtifactType;
  url?: string | null;
  title?: string | null;
  publishedAt?: string | null;
  note?: string | null;
};

export function ensurePwArtifactTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pw_artifacts (
      id TEXT PRIMARY KEY,
      bet_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      url TEXT,
      title TEXT,
      type TEXT NOT NULL CHECK(type IN ('video', 'livestream', 'article', 'cover', 'link')),
      published_at TEXT,
      note TEXT,
      created_at TEXT NOT NULL,
      detached_at TEXT
    );
  `);
}

export function attachPwArtifact(db: DatabaseSync, input: PwArtifactInput): PwArtifactRow {
  const betId = required(input.betId, "押注");
  if (!db.prepare("SELECT id FROM pw_bets WHERE id = ?").get(betId)) {
    throw httpError(404, "押注不存在");
  }
  const platform = required(input.platform, "平台");
  const type = required(input.type, "产出物类型");
  if (!["video", "livestream", "article", "cover", "link"].includes(type)) {
    throw httpError(400, "产出物类型非法");
  }
  const url = optional(input.url);
  const title = optional(input.title);
  if (!url && !title) throw httpError(400, "产出物至少需要 URL 或标题");

  const id = randomUUID();
  db.prepare(`
    INSERT INTO pw_artifacts(
      id, bet_id, platform, url, title, type, published_at, note, created_at, detached_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    id,
    betId,
    platform,
    url,
    title,
    type,
    optional(input.publishedAt),
    optional(input.note),
    nowIso(),
  );
  return getPwArtifact(db, id);
}

export function detachPwArtifact(db: DatabaseSync, id: string): PwArtifactRow {
  getPwArtifact(db, id);
  db.prepare("UPDATE pw_artifacts SET detached_at = ? WHERE id = ?").run(nowIso(), id);
  return getPwArtifact(db, id);
}

export function listPwArtifacts(
  db: DatabaseSync,
  betId: string,
  options: { includeDetached?: boolean } = {},
): PwArtifactRow[] {
  const condition = options.includeDetached ? "" : " AND detached_at IS NULL";
  return db.prepare(`
    SELECT id, bet_id, platform, url, title, type, published_at, note, created_at, detached_at
    FROM pw_artifacts
    WHERE bet_id = ?${condition}
    ORDER BY created_at, id
  `).all(betId) as PwArtifactRow[];
}

function getPwArtifact(db: DatabaseSync, id: string): PwArtifactRow {
  const row = db.prepare(`
    SELECT id, bet_id, platform, url, title, type, published_at, note, created_at, detached_at
    FROM pw_artifacts WHERE id = ?
  `).get(id) as PwArtifactRow | undefined;
  if (!row) throw httpError(404, "产出物不存在");
  return row;
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw httpError(400, `${name}不能为空`);
  return value.trim();
}

function optional(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw httpError(400, "文本字段格式非法");
  const trimmed = value.trim();
  return trimmed || null;
}
