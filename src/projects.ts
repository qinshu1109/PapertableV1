import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  httpError,
  jsonObject,
  nowIso,
  requireProject,
  type CardRow,
  type DataStore,
  type ProjectRow,
} from "./data.ts";
import { inheritDefaultLibrary, listProjectMaterials } from "./notes.ts";
import { publicCard } from "./engine.ts";

export function createProject(store: DataStore, nameInput: string): Record<string, unknown> {
  const name = String(nameInput || "").replace(/\s+/gu, " ").trim();
  if (!name) throw httpError(400, "项目名称不能为空");
  if (name.length > 100) throw httpError(400, "项目名称不能超过 100 个字符");
  const id = randomUUID();
  const now = nowIso();
  store.db.prepare(
    "INSERT INTO pt_projects(id, name, created_at, updated_at) VALUES(?, ?, ?, ?)",
  ).run(id, name, now, now);
  const inheritedLibrary = inheritDefaultLibrary(store, id);
  return { id, name, createdAt: now, updatedAt: now, inheritedLibrary };
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
