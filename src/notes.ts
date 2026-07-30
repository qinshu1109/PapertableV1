import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Type } from "@earendil-works/pi-ai";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import {
  httpError,
  nowIso,
  requireProject,
  type DataStore,
  type SourceKind,
} from "./data.ts";

export const MAX_NOTE_CHUNK_CHARS = 800;
export const NOTE_CHUNK_OVERLAP_CHARS = 80;
export const MAX_MATERIAL_BYTES = 20 * 1024 * 1024;

export type FrozenDocument = {
  id: string;
  sha256: string;
  sourceKind: SourceKind;
  path: string;
};

export type RunContext = {
  db: DatabaseSync;
  projectId: string;
  documents: FrozenDocument[];
  documentIds: Set<string>;
  readableIds: Set<string>;
  readIds: Set<string>;
};

export type ChunkCitation = {
  chunkId: string;
  documentId: string;
  sourceKind: SourceKind;
  path: string;
  start: number;
  end: number;
  excerpt: string;
  actualPath: string;
};

type ChunkRow = {
  id: string;
  document_id: string;
  source_kind: SourceKind;
  relative_path: string;
  start_offset: number;
  end_offset: number;
  text: string;
};

type SearchDetails = {
  hitCount: number;
  readableIds: string[];
};

type ReadDetails = {
  readCount: number;
  readIds: string[];
};

const searchSchema = Type.Object({
  query: Type.String({ description: "用于检索本轮冻结资料的具体、简短关键词、短语或唯一标识。" }),
});

const readSchema = Type.Object({
  chunkIds: Type.Array(Type.String(), {
    minItems: 1,
    maxItems: 4,
    description: "本问题中 search_notes 已返回的 chunkId，一次最多四个。",
  }),
});

export async function bindLibrary(store: DataStore, projectId: string, rootInput: string): Promise<void> {
  requireProject(store.db, projectId);
  assertProjectMutable(store.db, projectId);
  const requestedRoot = rootInput.trim();
  if (!requestedRoot) throw httpError(400, "长期资料库路径不能为空");
  const root = resolve(requestedRoot);
  const info = await lstat(root).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw httpError(400, "长期资料库必须是一个真实目录，不能是符号链接");
  }
  assertProjectMutable(store.db, projectId);
  store.db.exec("BEGIN IMMEDIATE");
  try {
    store.db.prepare(`
      DELETE FROM pt_chunks_fts
      WHERE chunk_id IN (
        SELECT id FROM pt_chunks WHERE project_id = ? AND source_kind = 'library'
      )
    `).run(projectId);
    store.db.prepare(
      "DELETE FROM pt_documents WHERE project_id = ? AND source_kind = 'library'",
    ).run(projectId);
    store.db.prepare(`
      INSERT INTO pt_project_libraries(project_id, root_path)
      VALUES(?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        root_path = excluded.root_path,
        indexed_at = NULL,
        document_count = 0,
        chunk_count = 0
    `).run(projectId, root);
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}

export async function reindexLibrary(store: DataStore, projectId: string): Promise<{
  documents: number;
  chunks: number;
  indexedAt: string;
}> {
  requireProject(store.db, projectId);
  assertProjectMutable(store.db, projectId);
  const binding = store.db.prepare(
    "SELECT root_path FROM pt_project_libraries WHERE project_id = ?",
  ).get(projectId) as { root_path: string } | undefined;
  if (!binding) throw httpError(409, "请先绑定长期资料库");

  const info = await lstat(binding.root_path).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw httpError(400, "长期资料库路径不存在、不是目录或已经变成符号链接");
  }
  const files = await textFiles(binding.root_path);
  const indexed = await Promise.all(files.map(async (actualPath) => {
    const [bytes, metadata] = await Promise.all([readFile(actualPath), stat(actualPath)]);
    const content = decodeUtf8(bytes, `无法读取 ${relative(binding.root_path, actualPath)}`);
    return {
      id: randomUUID(),
      actualPath,
      relativePath: safeRelative(binding.root_path, actualPath),
      sha256: sha256(bytes),
      byteSize: bytes.byteLength,
      mtimeMs: Math.round(metadata.mtimeMs),
      chunks: splitText(content, safeRelative(binding.root_path, actualPath)),
    };
  }));

  const db = store.db;
  assertProjectMutable(db, projectId);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      DELETE FROM pt_chunks_fts
      WHERE chunk_id IN (
        SELECT id FROM pt_chunks WHERE project_id = ? AND source_kind = 'library'
      )
    `).run(projectId);
    db.prepare("DELETE FROM pt_documents WHERE project_id = ? AND source_kind = 'library'").run(projectId);

    const insertDocument = db.prepare(`
      INSERT INTO pt_documents(
        id, project_id, source_kind, relative_path, actual_path, sha256,
        byte_size, mtime_ms, created_at
      ) VALUES(?, ?, 'library', ?, ?, ?, ?, ?, ?)
    `);
    const insertChunk = db.prepare(`
      INSERT INTO pt_chunks(
        id, document_id, project_id, source_kind, relative_path,
        ordinal, start_offset, end_offset, text
      ) VALUES(?, ?, ?, 'library', ?, ?, ?, ?, ?)
    `);
    const insertFts = db.prepare(
      "INSERT INTO pt_chunks_fts(chunk_id, project_id, text) VALUES(?, ?, ?)",
    );
    const indexedAt = nowIso();
    let chunkCount = 0;
    for (const document of indexed) {
      insertDocument.run(
        document.id,
        projectId,
        document.relativePath,
        document.actualPath,
        document.sha256,
        document.byteSize,
        document.mtimeMs,
        indexedAt,
      );
      for (const chunk of document.chunks) {
        const chunkId = stableChunkId(
          projectId,
          "library",
          document.sha256,
          document.relativePath,
          chunk.ordinal,
          chunk.start,
          chunk.end,
        );
        insertChunk.run(
          chunkId,
          document.id,
          projectId,
          document.relativePath,
          chunk.ordinal,
          chunk.start,
          chunk.end,
          chunk.text,
        );
        insertFts.run(chunkId, projectId, chunk.text);
        chunkCount += 1;
      }
    }
    db.prepare(`
      UPDATE pt_project_libraries
      SET indexed_at = ?, document_count = ?, chunk_count = ?
      WHERE project_id = ?
    `).run(indexedAt, indexed.length, chunkCount, projectId);
    db.exec("COMMIT");
    return { documents: indexed.length, chunks: chunkCount, indexedAt };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function addProjectMaterial(
  store: DataStore,
  projectId: string,
  originalName: string,
  bytes: Uint8Array,
): Promise<{ id: string; name: string; chunks: number }> {
  requireProject(store.db, projectId);
  assertProjectMutable(store.db, projectId);
  const name = validateTextFilename(originalName);
  if (bytes.byteLength === 0) throw httpError(400, "临时材料不能为空");
  if (bytes.byteLength > MAX_MATERIAL_BYTES) throw httpError(413, "单个临时材料不能超过 20 MiB");
  decodeUtf8(bytes, "临时材料必须是 UTF-8 文本");
  const duplicate = store.db.prepare(`
    SELECT 1 FROM pt_documents
    WHERE project_id = ? AND source_kind = 'project_material' AND relative_path = ?
  `).get(projectId, name);
  if (duplicate) throw httpError(409, "项目中已经有同名临时材料");

  const id = randomUUID();
  const materialDir = join(store.projectsDir, projectId, "materials");
  await mkdir(materialDir, { recursive: true, mode: 0o700 });
  const actualPath = join(materialDir, `${id}-${safeBasename(name)}`);
  await writeFile(actualPath, bytes, { mode: 0o600, flag: "wx" });
  try {
    assertProjectMutable(store.db, projectId);
    const result = indexOneDocument(
      store.db,
      projectId,
      "project_material",
      id,
      name,
      actualPath,
      bytes,
      Date.now(),
    );
    return { id, name, chunks: result };
  } catch (error) {
    await unlink(actualPath).catch(() => undefined);
    throw error;
  }
}

export async function deleteProjectMaterial(
  store: DataStore,
  projectId: string,
  materialId: string,
): Promise<void> {
  requireProject(store.db, projectId);
  assertProjectMutable(store.db, projectId);
  const row = store.db.prepare(`
    SELECT actual_path FROM pt_documents
    WHERE id = ? AND project_id = ? AND source_kind = 'project_material'
  `).get(materialId, projectId) as { actual_path: string } | undefined;
  if (!row) throw httpError(404, "临时材料不存在");
  store.db.exec("BEGIN IMMEDIATE");
  try {
    store.db.prepare(`
      DELETE FROM pt_chunks_fts
      WHERE chunk_id IN (SELECT id FROM pt_chunks WHERE document_id = ?)
    `).run(materialId);
    store.db.prepare("DELETE FROM pt_documents WHERE id = ?").run(materialId);
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
  await unlink(row.actual_path).catch(() => undefined);
}

export function freezeProjectScope(db: DatabaseSync, projectId: string): RunContext {
  requireProject(db, projectId);
  const rows = db.prepare(`
    SELECT id, sha256, source_kind, relative_path
    FROM pt_documents
    WHERE project_id = ?
    ORDER BY source_kind, relative_path
  `).all(projectId) as Array<{
    id: string;
    sha256: string;
    source_kind: SourceKind;
    relative_path: string;
  }>;
  const documents = rows.map((row) => ({
    id: row.id,
    sha256: row.sha256,
    sourceKind: row.source_kind,
    path: row.relative_path,
  }));
  return {
    db,
    projectId,
    documents,
    documentIds: new Set(documents.map((document) => document.id)),
    readableIds: new Set(),
    readIds: new Set(),
  };
}

export const searchNotes: AgentHarnessTool<RunContext, typeof searchSchema, SearchDetails> = {
  name: "search_notes",
  label: "search notes",
  description: "在本轮宿主冻结的长期资料库与项目临时材料中检索相关片段和安全相对路径。搜索命中不能直接引用；不要猜测路径或扩大资料范围。",
  parameters: searchSchema,
  async execute(_toolCallId, { query }, _signal, onUpdate, context) {
    const normalized = query.replace(/\s+/gu, " ").trim();
    if (!normalized || normalized.length > 160) {
      throw new Error("search_notes requires a non-empty query of at most 160 characters");
    }
    const rows = searchChunks(context, normalized);
    for (const row of rows) context.readableIds.add(row.id);
    await onUpdate?.({
      content: [{ type: "text", text: `Found ${rows.length} candidate chunks.` }],
      details: { hitCount: rows.length, readableIds: rows.map((row) => row.id) },
    });
    const text = rows.length === 0
      ? "No matching source chunks were found. Do not claim that a source was read."
      : rows.map((row) => [
        `ID: ${row.id}`,
        `Channel: ${row.source_kind === "library" ? "long-term library" : "project material"}`,
        `Path: ${row.relative_path}`,
        `Anchor: ${row.start_offset}-${row.end_offset}`,
        `Snippet: ${snippet(row.text)}`,
      ].join("\n")).join("\n\n");
    return {
      content: [{ type: "text", text }],
      details: { hitCount: rows.length, readableIds: rows.map((row) => row.id) },
    };
  },
};

export const readNotes: AgentHarnessTool<RunContext, typeof readSchema, ReadDetails> = {
  name: "read_notes",
  label: "read notes",
  description: "读取本问题中刚由 search_notes 返回的少量片段。只能传入该搜索结果中的 chunkId，一次最多四个。",
  parameters: readSchema,
  async execute(_toolCallId, { chunkIds }, _signal, onUpdate, context) {
    const ids = [...new Set(chunkIds)];
    if (ids.length === 0 || ids.length > 4) {
      throw new Error("read_notes accepts one to four unique chunk IDs");
    }
    if (ids.some((id) => !context.readableIds.has(id))) {
      throw new Error("Chunk was not returned by search_notes in this question");
    }
    const rows = rowsByIds(context, ids);
    if (rows.length !== ids.length) throw new Error("A searched chunk is outside the frozen source scope");
    for (const id of ids) context.readIds.add(id);
    await onUpdate?.({
      content: [{ type: "text", text: `Read ${ids.length} source chunks.` }],
      details: { readCount: ids.length, readIds: ids },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return {
      content: [{
        type: "text",
        text: ids.map((id) => {
          const row = byId.get(id)!;
          return [
            `[${row.id}]`,
            `Citation token (copy exactly): [[source:${row.id}]]`,
            `Channel: ${row.source_kind === "library" ? "long-term library" : "project material"}`,
            `Path: ${row.relative_path}`,
            `Anchor: ${row.start_offset}-${row.end_offset}`,
            row.text,
          ].join("\n");
        }).join("\n\n"),
      }],
      details: { readCount: ids.length, readIds: ids },
    };
  },
};

export function getChunkCitation(context: RunContext, chunkId: string): ChunkCitation | undefined {
  if (!context.readIds.has(chunkId)) return undefined;
  const placeholders = [...context.documentIds].map(() => "?").join(",");
  if (!placeholders) return undefined;
  const row = context.db.prepare(`
    SELECT c.id, c.document_id, c.source_kind, c.relative_path,
           c.start_offset, c.end_offset, c.text, d.actual_path
    FROM pt_chunks c
    JOIN pt_documents d ON d.id = c.document_id
    WHERE c.id = ? AND c.document_id IN (${placeholders})
  `).get(chunkId, ...context.documentIds) as (ChunkRow & { actual_path: string }) | undefined;
  return row ? {
    chunkId: row.id,
    documentId: row.document_id,
    sourceKind: row.source_kind,
    path: row.relative_path,
    start: row.start_offset,
    end: row.end_offset,
    excerpt: row.text,
    actualPath: row.actual_path,
  } : undefined;
}

export function listProjectMaterials(db: DatabaseSync, projectId: string): Array<Record<string, unknown>> {
  return db.prepare(`
    SELECT id, relative_path AS name, sha256, byte_size AS bytes, created_at
    FROM pt_documents
    WHERE project_id = ? AND source_kind = 'project_material'
    ORDER BY created_at
  `).all(projectId) as Array<Record<string, unknown>>;
}

function indexOneDocument(
  db: DatabaseSync,
  projectId: string,
  sourceKind: SourceKind,
  documentId: string,
  relativePath: string,
  actualPath: string,
  bytes: Uint8Array,
  mtimeMs: number,
): number {
  const content = decodeUtf8(bytes, "材料必须是 UTF-8 文本");
  const digest = sha256(bytes);
  const chunks = splitText(content, relativePath);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO pt_documents(
        id, project_id, source_kind, relative_path, actual_path, sha256,
        byte_size, mtime_ms, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      documentId,
      projectId,
      sourceKind,
      relativePath,
      actualPath,
      digest,
      bytes.byteLength,
      Math.round(mtimeMs),
      nowIso(),
    );
    const insertChunk = db.prepare(`
      INSERT INTO pt_chunks(
        id, document_id, project_id, source_kind, relative_path,
        ordinal, start_offset, end_offset, text
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = db.prepare(
      "INSERT INTO pt_chunks_fts(chunk_id, project_id, text) VALUES(?, ?, ?)",
    );
    for (const chunk of chunks) {
      const id = stableChunkId(
        projectId,
        sourceKind,
        digest,
        relativePath,
        chunk.ordinal,
        chunk.start,
        chunk.end,
      );
      insertChunk.run(
        id,
        documentId,
        projectId,
        sourceKind,
        relativePath,
        chunk.ordinal,
        chunk.start,
        chunk.end,
        chunk.text,
      );
      insertFts.run(id, projectId, chunk.text);
    }
    db.exec("COMMIT");
    return chunks.length;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function searchChunks(context: RunContext, query: string): ChunkRow[] {
  if (context.documentIds.size === 0) return [];
  const documentIds = [...context.documentIds];
  const documentPlaceholders = documentIds.map(() => "?").join(",");
  const hits: ChunkRow[] = [];
  const seen = new Set<string>();
  const add = (rows: ChunkRow[]) => {
    for (const row of rows) {
      if (hits.length >= 8 || seen.has(row.id)) continue;
      seen.add(row.id);
      hits.push(row);
    }
  };
  const terms = searchTerms(query);
  if (terms.length > 0) {
    try {
      const ftsQuery = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
      add(context.db.prepare(`
        SELECT c.id, c.document_id, c.source_kind, c.relative_path,
               c.start_offset, c.end_offset, c.text
        FROM pt_chunks_fts f
        JOIN pt_chunks c ON c.id = f.chunk_id
        WHERE f.pt_chunks_fts MATCH ?
          AND c.project_id = ?
          AND c.document_id IN (${documentPlaceholders})
        ORDER BY CASE
          WHEN c.source_kind = 'project_material' THEN 0
          WHEN c.relative_path LIKE '10_活跃知识/%' THEN 1
          WHEN c.relative_path LIKE '80_AI暂存/%'
            OR c.relative_path LIKE 'OH-Works/小琴助理-activity/%' THEN 3
          ELSE 2
        END, bm25(pt_chunks_fts)
        LIMIT 8
      `).all(ftsQuery, context.projectId, ...documentIds) as ChunkRow[]);
    } catch {
      // Deterministic substring fallback below handles punctuation and malformed FTS input.
    }
  }
  if (hits.length < 8) {
    const fallbackTerms = (terms.length > 0 ? terms : [query]).slice(0, 8);
    const where = fallbackTerms.map(() => "instr(lower(c.text), lower(?)) > 0").join(" OR ");
    add(context.db.prepare(`
      SELECT c.id, c.document_id, c.source_kind, c.relative_path,
             c.start_offset, c.end_offset, c.text
      FROM pt_chunks c
      WHERE c.project_id = ?
        AND c.document_id IN (${documentPlaceholders})
        AND (${where})
      ORDER BY CASE
        WHEN c.source_kind = 'project_material' THEN 0
        WHEN c.relative_path LIKE '10_活跃知识/%' THEN 1
        WHEN c.relative_path LIKE '80_AI暂存/%'
          OR c.relative_path LIKE 'OH-Works/小琴助理-activity/%' THEN 3
        ELSE 2
      END
      LIMIT 8
    `).all(context.projectId, ...documentIds, ...fallbackTerms) as ChunkRow[]);
  }
  return hits;
}

function rowsByIds(context: RunContext, ids: string[]): ChunkRow[] {
  if (context.documentIds.size === 0) return [];
  const docs = [...context.documentIds];
  return context.db.prepare(`
    SELECT id, document_id, source_kind, relative_path, start_offset, end_offset, text
    FROM pt_chunks
    WHERE id IN (${ids.map(() => "?").join(",")})
      AND document_id IN (${docs.map(() => "?").join(",")})
  `).all(...ids, ...docs) as ChunkRow[];
}

function searchTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const word of query.match(/[A-Za-z0-9_-]{3,}/g) ?? []) terms.add(word);
  for (const run of query.match(/[\u3400-\u9fff]{3,}/gu) ?? []) {
    for (let index = 0; index <= run.length - 3; index += 1) terms.add(run.slice(index, index + 3));
  }
  return [...terms].slice(0, 24);
}

async function textFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await textFiles(fullPath));
    else if (entry.isFile() && isTextExtension(entry.name)) files.push(fullPath);
  }
  return files.sort();
}

export function splitText(content: string, path: string): Array<{
  ordinal: number;
  start: number;
  end: number;
  text: string;
}> {
  const chunks: Array<{ ordinal: number; start: number; end: number; text: string }> = [];
  let start = 0;
  while (start < content.length) {
    let end = Math.min(start + MAX_NOTE_CHUNK_CHARS, content.length);
    if (end < content.length) {
      const preferred = Math.max(
        content.lastIndexOf("\n\n", end),
        content.lastIndexOf("\n", end),
        content.lastIndexOf("。", end),
        content.lastIndexOf(". ", end),
      );
      if (preferred > start + Math.floor(MAX_NOTE_CHUNK_CHARS / 2)) end = preferred + 1;
    }
    const raw = content.slice(start, end);
    const leading = raw.match(/^\s*/u)?.[0].length ?? 0;
    const trailing = raw.match(/\s*$/u)?.[0].length ?? 0;
    const text = raw.slice(leading, raw.length - trailing);
    if (text) {
      chunks.push({
        ordinal: chunks.length,
        start: start + leading,
        end: end - trailing,
        text,
      });
    }
    if (end === content.length) break;
    start = Math.max(end - NOTE_CHUNK_OVERLAP_CHARS, start + 1);
  }
  void path;
  return chunks;
}

function stableChunkId(
  projectId: string,
  sourceKind: SourceKind,
  documentHash: string,
  path: string,
  ordinal: number,
  start: number,
  end: number,
): string {
  return `chunk-${sha256(
    `${projectId}\0${sourceKind}\0${documentHash}\0${path}\0${ordinal}\0${start}\0${end}`,
  ).slice(0, 24)}`;
}

function validateTextFilename(value: string): string {
  const name = basename(value.trim());
  if (!name || name === "." || name === "..") throw httpError(400, "临时材料缺少文件名");
  if (!isTextExtension(name)) throw httpError(415, "首版只接受 .md、.markdown 和 .txt 文件");
  return name;
}

function isTextExtension(path: string): boolean {
  return [".md", ".markdown", ".txt"].includes(extname(path).toLowerCase());
}

function safeBasename(value: string): string {
  return value.replace(/[^A-Za-z0-9._\-\u3400-\u9fff]/gu, "_").slice(-180);
}

function safeRelative(root: string, path: string): string {
  const value = relative(root, path).split("\\").join("/");
  if (!value || value.startsWith("../") || value.includes("/../")) {
    throw httpError(400, "资料路径越过已绑定目录");
  }
  return value;
}

function decodeUtf8(bytes: Uint8Array, errorMessage: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw httpError(415, errorMessage);
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function snippet(text: string): string {
  return text.replace(/\s+/gu, " ").trim().slice(0, 260);
}

function assertProjectMutable(db: DatabaseSync, projectId: string): void {
  const active = db.prepare(
    "SELECT 1 FROM pt_runs WHERE project_id = ? AND status = 'running' LIMIT 1",
  ).get(projectId);
  if (active) throw httpError(409, "项目正在回答，结束或停止后才能修改资料范围");
}
