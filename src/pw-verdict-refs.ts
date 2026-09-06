/**
 * TASK-PW-30：引用落库与弹药架。
 *
 * 给「AI 到底用没用过你的金子」记账：解析 assistant 消息文本中的 §N 标注，
 * 命中装配编号表（pwCollabRefTable）才落 pw_verdict_refs，伪造/未知标注丢弃不入库；
 * 弹药架（listPwAmmoShelf）只摆真正被引用过的 verdict。
 * 纪律对照纸桌 verdict_use：伪造/未知标注不计入；绝不拿「提供过（provided）」冒充「用过（used）」。
 *
 * 表一律弱引用（无物理外键）；source_kind 预留 'content_draft'（本批只消费 'collab_message'）。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { httpError, nowIso } from "./data.ts";
import type { PwCollabContext, PwContextSource } from "./pw-context.ts";

export type PwVerdictRefSourceKind = "collab_message" | "content_draft";

export type PwVerdictRefRow = {
  id: string;
  verdict_id: string;
  verdict_source: PwContextSource;
  verdict_kind: "gold" | "tomb";
  source_kind: PwVerdictRefSourceKind;
  source_id: string;
  marker: string;
  created_at: string;
};

/** 编号表条目：由装配上下文（golds/tombs）合成，供 record 时把 §N 解析成 verdict。 */
export type RefTableItem = {
  ref: string;
  id: string;
  source: PwContextSource;
  kind: "gold" | "tomb";
};

/** 弹药架行：只含实际被引用过的 verdict。 */
export type AmmoRow = {
  verdict_id: string;
  verdict_source: PwContextSource;
  verdict_kind: "gold" | "tomb";
  text: string | null;
  ref_count: number;
  first_used_at: string;
  last_used_at: string;
};

const REF_SOURCE_KINDS = new Set<PwVerdictRefSourceKind>(["collab_message", "content_draft"]);

export function ensurePwVerdictRefTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pw_verdict_refs (
      id TEXT PRIMARY KEY,
      verdict_id TEXT NOT NULL,
      verdict_source TEXT NOT NULL CHECK(verdict_source IN ('paperweight','papertable')),
      verdict_kind TEXT NOT NULL CHECK(verdict_kind IN ('gold','tomb')),
      source_kind TEXT NOT NULL CHECK(source_kind IN ('collab_message','content_draft')),
      source_id TEXT NOT NULL,
      marker TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS pw_verdict_refs_dedup
      ON pw_verdict_refs(source_kind, source_id, verdict_id);
    CREATE INDEX IF NOT EXISTS pw_verdict_refs_by_verdict
      ON pw_verdict_refs(verdict_id, created_at);
  `);
}

/** 提取 §(\d+) 标注，按出现顺序去重（§ 后非数字不命中）。 */
export function parseSectionMarkers(text: string): string[] {
  const markers: string[] = [];
  const pattern = /§(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const marker = `§${match[1]}`;
    if (!markers.includes(marker)) markers.push(marker);
  }
  return markers;
}

/** 由装配上下文合成编号表：golds → gold；tombs → tomb（source 恒 'paperweight'）。 */
export function pwCollabRefTable(ctx: PwCollabContext): RefTableItem[] {
  return [
    ...ctx.golds.map((gold) => ({
      ref: gold.ref,
      id: gold.id,
      source: gold.source,
      kind: "gold" as const,
    })),
    ...ctx.tombs.map((tomb) => ({
      ref: tomb.ref,
      id: tomb.id,
      source: "paperweight" as const,
      kind: "tomb" as const,
    })),
  ];
}

/**
 * 对 text 中每个 §N 标注记账：命中编号表 → INSERT OR IGNORE（同 source+verdict 唯一去重）；
 * 未命中 → 进 dropped（不入库）。返回 { inserted, dropped }。
 */
export function recordPwVerdictRefs(
  db: DatabaseSync,
  input: {
    sourceKind: PwVerdictRefSourceKind;
    sourceId: string;
    text: string;
    refTable: RefTableItem[];
  },
): { inserted: number; dropped: string[] } {
  if (!REF_SOURCE_KINDS.has(input.sourceKind)) throw httpError(400, "非法 sourceKind");
  if (typeof input.sourceId !== "string" || !input.sourceId.trim()) throw httpError(400, "sourceId 必填");
  if (typeof input.text !== "string") throw httpError(400, "text 必须是字符串");
  const byRef = new Map(input.refTable.map((item) => [item.ref, item]));
  const insert = db.prepare(`
    INSERT OR IGNORE INTO pw_verdict_refs(
      id, verdict_id, verdict_source, verdict_kind, source_kind, source_id, marker, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let inserted = 0;
  const dropped: string[] = [];
  for (const marker of parseSectionMarkers(input.text)) {
    const item = byRef.get(marker);
    if (!item) {
      dropped.push(marker);
      continue;
    }
    const result = insert.run(
      randomUUID(),
      item.id,
      item.source,
      item.kind,
      input.sourceKind,
      input.sourceId.trim(),
      marker,
      nowIso(),
    );
    if (Number(result.changes) === 1) inserted += 1;
  }
  return { inserted, dropped };
}

/** 弹药架：只列实际被引用过的 verdict，按 last_used_at 倒序（同刻以 verdict_id 兜底稳定）。 */
export function listPwAmmoShelf(db: DatabaseSync): AmmoRow[] {
  const rows = db.prepare(`
    SELECT verdict_id, verdict_source, verdict_kind,
           COUNT(*) AS ref_count,
           MIN(created_at) AS first_used_at,
           MAX(created_at) AS last_used_at
    FROM pw_verdict_refs
    GROUP BY verdict_id, verdict_source, verdict_kind
    ORDER BY last_used_at DESC, verdict_id
  `).all() as Array<{
    verdict_id: string;
    verdict_source: PwContextSource;
    verdict_kind: "gold" | "tomb";
    ref_count: number;
    first_used_at: string;
    last_used_at: string;
  }>;
  return rows.map((row) => ({
    verdict_id: row.verdict_id,
    verdict_source: row.verdict_source,
    verdict_kind: row.verdict_kind,
    text: ammoSourceText(db, row.verdict_source, row.verdict_kind, row.verdict_id),
    ref_count: Number(row.ref_count),
    first_used_at: row.first_used_at,
    last_used_at: row.last_used_at,
  }));
}

function ammoSourceText(
  db: DatabaseSync,
  source: PwContextSource,
  kind: "gold" | "tomb",
  verdictId: string,
): string | null {
  if (source === "papertable") {
    const row = db.prepare("SELECT text FROM pw_gold_mirror WHERE id = ?").get(verdictId) as
      | { text: string }
      | undefined;
    return row?.text ?? null;
  }
  const row = db.prepare("SELECT lesson, cause_of_death FROM pw_verdicts WHERE id = ?")
    .get(verdictId) as { lesson: string | null; cause_of_death: string | null } | undefined;
  if (!row) return null;
  return kind === "tomb" ? row.cause_of_death : row.lesson;
}

/** 某 verdict 的全部引用记录（created_at 升序；同刻以 id 兜底稳定）。 */
export function listPwVerdictRefLog(db: DatabaseSync, verdictId: string): PwVerdictRefRow[] {
  return db.prepare(`
    SELECT id, verdict_id, verdict_source, verdict_kind, source_kind, source_id, marker, created_at
    FROM pw_verdict_refs
    WHERE verdict_id = ?
    ORDER BY created_at, id
  `).all(verdictId) as PwVerdictRefRow[];
}
