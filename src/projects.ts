import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  httpError,
  jsonObject,
  nowIso,
  requireCard,
  requireProject,
  type CardRow,
  type DataStore,
  type ProjectRow,
} from "./data.ts";
import { inheritDefaultLibrary, listProjectMaterials } from "./notes.ts";
import { publicCard } from "./engine.ts";

export function createProject(store: DataStore, nameInput: string): Record<string, unknown> {
  const name = displayName(nameInput, "项目");
  const id = randomUUID();
  const now = nowIso();
  store.db.prepare(
    "INSERT INTO pt_projects(id, name, created_at, updated_at) VALUES(?, ?, ?, ?)",
  ).run(id, name, now, now);
  const inheritedLibrary = inheritDefaultLibrary(store, id);
  return { id, name, createdAt: now, updatedAt: now, inheritedLibrary };
}

export function renameProject(
  store: DataStore,
  projectId: string,
  nameInput: string,
): Record<string, unknown> {
  requireProject(store.db, projectId);
  const name = displayName(nameInput, "项目");
  const updatedAt = nowIso();
  store.db.prepare("UPDATE pt_projects SET name = ?, updated_at = ? WHERE id = ?")
    .run(name, updatedAt, projectId);
  return { id: projectId, name, updatedAt };
}

export function renameCard(
  store: DataStore,
  cardId: string,
  titleInput: string,
): Record<string, unknown> {
  const card = requireCard(store.db, cardId);
  const title = displayName(titleInput, "卡片");
  const updatedAt = nowIso();
  store.db.exec("BEGIN IMMEDIATE");
  try {
    store.db.prepare("UPDATE pt_cards SET title = ?, updated_at = ? WHERE id = ?")
      .run(title, updatedAt, cardId);
    store.db.prepare("UPDATE pt_projects SET updated_at = ? WHERE id = ?")
      .run(updatedAt, card.project_id);
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
  return publicCard({ ...card, title, updated_at: updatedAt });
}

export type PurgeResult = {
  purged: string[];
  skipped: Array<{ cardId: string; reason: string }>;
};

/**
 * 物理删除当前项目的卡片：外键级联清掉运行、运行事件、运行来源与关系边。
 * 运行中的卡片和被任何判决引用的卡片只跳过、不删除——判决链的可追溯性优先。
 */
export function purgeCards(
  store: DataStore,
  projectId: string,
  cardIds: readonly string[],
): PurgeResult {
  requireProject(store.db, projectId);
  const cardStmt = store.db.prepare("SELECT id FROM pt_cards WHERE id = ? AND project_id = ?");
  const runningStmt = store.db.prepare(
    "SELECT COUNT(*) AS n FROM pt_runs WHERE card_id = ? AND status = 'running'",
  );
  const verdictStmt = store.db.prepare("SELECT COUNT(*) AS n FROM pt_verdicts WHERE card_id = ?");
  const deleteStmt = store.db.prepare("DELETE FROM pt_cards WHERE id = ?");
  const purged: string[] = [];
  const skipped: Array<{ cardId: string; reason: string }> = [];
  store.db.exec("BEGIN IMMEDIATE");
  try {
    for (const cardId of cardIds) {
      if (!cardStmt.get(cardId, projectId)) {
        skipped.push({ cardId, reason: "卡片不存在" });
        continue;
      }
      if (Number((runningStmt.get(cardId) as { n: number }).n) > 0) {
        skipped.push({ cardId, reason: "有正在生成的回答" });
        continue;
      }
      if (Number((verdictStmt.get(cardId) as { n: number }).n) > 0) {
        skipped.push({ cardId, reason: "被判决引用，不能物理删除" });
        continue;
      }
      deleteStmt.run(cardId);
      purged.push(cardId);
    }
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
  return { purged, skipped };
}

export function listProjects(db: DatabaseSync): Array<Record<string, unknown>> {
  const rows = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM pt_cards c WHERE c.project_id = p.id) AS card_count,
      (SELECT COUNT(*) FROM pt_documents d
        WHERE d.project_id = p.id AND d.source_kind = 'project_material') AS material_count
    FROM pt_projects p
    ORDER BY p.updated_at DESC
  `).all() as Array<ProjectRow & { card_count: number; material_count: number }>;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    cardCount: Number(row.card_count),
    materialCount: Number(row.material_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function projectDetail(store: DataStore, projectId: string): Record<string, unknown> {
  const project = requireProject(store.db, projectId);
  const library = store.db.prepare(`
    SELECT root_path, indexed_at, document_count, chunk_count
    FROM pt_project_libraries WHERE project_id = ?
  `).get(projectId) as {
    root_path: string;
    indexed_at: string | null;
    document_count: number;
    chunk_count: number;
  } | undefined;
  const cards = store.db.prepare(
    "SELECT * FROM pt_cards WHERE project_id = ? ORDER BY created_at",
  ).all(projectId) as CardRow[];
  const edges = store.db.prepare(`
    SELECT id, source_card_id, target_card_id, kind, snapshot_json, created_at
    FROM pt_edges WHERE project_id = ? ORDER BY created_at
  `).all(projectId) as Array<{
    id: string;
    source_card_id: string;
    target_card_id: string;
    kind: string;
    snapshot_json: string;
    created_at: string;
  }>;
  return {
    id: project.id,
    name: project.name,
    createdAt: project.created_at,
    updatedAt: project.updated_at,
    library: library ? {
      path: library.root_path,
      indexedAt: library.indexed_at,
      documents: Number(library.document_count),
      chunks: Number(library.chunk_count),
    } : null,
    materials: listProjectMaterials(store.db, projectId),
    cards: cards.map(publicCard),
    edges: edges.map((edge) => ({
      id: edge.id,
      sourceCardId: edge.source_card_id,
      targetCardId: edge.target_card_id,
      kind: edge.kind,
      snapshot: jsonObject(edge.snapshot_json),
      createdAt: edge.created_at,
    })),
    pendingMemoryStages: Number((store.db.prepare(`
      SELECT COUNT(*) AS count FROM pt_stage_exports
      WHERE project_id = ? AND status = 'pending'
    `).get(projectId) as { count: number }).count),
  };
}

function displayName(input: string, kind: "项目" | "卡片"): string {
  const value = String(input || "").replace(/\s+/gu, " ").trim();
  if (!value) throw httpError(400, `${kind}名称不能为空`);
  if ([...value].length > 100) throw httpError(400, `${kind}名称不能超过 100 个字符`);
  return value;
}
