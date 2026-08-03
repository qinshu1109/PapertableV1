import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type SourceKind = "library" | "project_material";
export type BranchKind = "root" | "deep_dive" | "diverge" | "reroute" | "concept";

export type ProjectRow = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
};

export type CardRow = {
  id: string;
  project_id: string;
  session_id: string;
  title: string;
  branch_kind: BranchKind;
  source_card_id: string | null;
  branch_context_json: string | null;
  created_at: string;
  updated_at: string;
};

export type RunRow = {
  id: string;
  project_id: string;
  card_id: string;
  question: string;
  status: "running" | "ended";
  result: string | null;
  reason: string | null;
  scope_json: string;
  previous_leaf_id: string | null;
  answer: string | null;
  error: string | null;
  created_at: string;
  ended_at: string | null;
  /** answer = 卡片正式轮；concept_preview = 用户点击触发的按需概念会话 */
  kind: string;
  /** concept_preview 的独立会话；正式轮为 NULL（用卡片会话） */
  session_id: string | null;
  /** concept_preview 的来源正式轮 */
  source_run_id: string | null;
  /** concept_preview 的概念词 */
  concept_term: string | null;
};

export type DataStore = {
  db: DatabaseSync;
  dataDir: string;
  databasePath: string;
  projectsDir: string;
  stagesDir: string;
};

export function openDataStore(dataDirectory = process.env.PAPERTABLE_DATA_DIR): DataStore {
  const dataDir = resolve(
    dataDirectory?.trim()
      || join(homedir(), "Library", "Application Support", "Papertable"),
  );
  const projectsDir = join(dataDir, "projects");
  const stagesDir = join(dataDir, "stages");
  mkdirSync(projectsDir, { recursive: true, mode: 0o700 });
  mkdirSync(stagesDir, { recursive: true, mode: 0o700 });

  const databasePath = join(dataDir, "papertable.sqlite3");
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS pt_schema (
      version INTEGER NOT NULL
    );
    INSERT INTO pt_schema(version)
      SELECT 3 WHERE NOT EXISTS (SELECT 1 FROM pt_schema);

    CREATE TABLE IF NOT EXISTS pt_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pt_project_libraries (
      project_id TEXT PRIMARY KEY REFERENCES pt_projects(id) ON DELETE CASCADE,
      root_path TEXT NOT NULL,
      indexed_at TEXT,
      document_count INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS pt_documents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES pt_projects(id) ON DELETE CASCADE,
      source_kind TEXT NOT NULL CHECK(source_kind IN ('library', 'project_material')),
      relative_path TEXT NOT NULL,
      actual_path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(project_id, source_kind, relative_path)
    );
    CREATE INDEX IF NOT EXISTS pt_documents_project_kind
      ON pt_documents(project_id, source_kind);

    CREATE TABLE IF NOT EXISTS pt_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES pt_documents(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES pt_projects(id) ON DELETE CASCADE,
      source_kind TEXT NOT NULL CHECK(source_kind IN ('library', 'project_material')),
      relative_path TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pt_chunks_document ON pt_chunks(document_id);
    CREATE INDEX IF NOT EXISTS pt_chunks_scope ON pt_chunks(project_id, document_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS pt_chunks_fts USING fts5(
      chunk_id UNINDEXED,
      project_id UNINDEXED,
      text,
      tokenize='trigram'
    );

    CREATE TABLE IF NOT EXISTS pt_cards (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES pt_projects(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      branch_kind TEXT NOT NULL CHECK(branch_kind IN ('root', 'deep_dive', 'diverge', 'reroute', 'concept')),
      source_card_id TEXT REFERENCES pt_cards(id) ON DELETE SET NULL,
      branch_context_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pt_cards_project ON pt_cards(project_id, created_at);

    CREATE TABLE IF NOT EXISTS pt_edges (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES pt_projects(id) ON DELETE CASCADE,
      source_card_id TEXT NOT NULL REFERENCES pt_cards(id) ON DELETE CASCADE,
      target_card_id TEXT NOT NULL REFERENCES pt_cards(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('deep_dive', 'diverge', 'reroute', 'concept')),
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pt_edges_project ON pt_edges(project_id, created_at);

    CREATE TABLE IF NOT EXISTS pt_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES pt_projects(id) ON DELETE CASCADE,
      card_id TEXT NOT NULL REFERENCES pt_cards(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running', 'ended')),
      result TEXT,
      reason TEXT,
      scope_json TEXT NOT NULL,
      previous_leaf_id TEXT,
      answer TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      ended_at TEXT,
      kind TEXT NOT NULL DEFAULT 'answer',
      session_id TEXT,
      source_run_id TEXT,
      concept_term TEXT
    );
    CREATE INDEX IF NOT EXISTS pt_runs_card ON pt_runs(card_id, created_at);

    CREATE TABLE IF NOT EXISTS pt_run_sources (
      run_id TEXT NOT NULL REFERENCES pt_runs(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK(source_kind IN ('library', 'project_material')),
      relative_path TEXT NOT NULL,
      actual_path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      PRIMARY KEY(run_id, document_id)
    );

    CREATE TABLE IF NOT EXISTS pt_run_events (
      run_id TEXT NOT NULL REFERENCES pt_runs(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(run_id, seq)
    );

    CREATE TABLE IF NOT EXISTS pt_stage_exports (
      stage_key TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES pt_projects(id) ON DELETE CASCADE,
      card_id TEXT NOT NULL REFERENCES pt_cards(id) ON DELETE CASCADE,
      transcript_path TEXT NOT NULL,
      transcript_offset INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'submitted')),
      reason TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      submitted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS pt_stage_pending ON pt_stage_exports(status, created_at);

    CREATE TABLE IF NOT EXISTS pt_promotions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES pt_projects(id) ON DELETE CASCADE,
      card_id TEXT NOT NULL REFERENCES pt_cards(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES pt_runs(id) ON DELETE CASCADE,
      record_id TEXT NOT NULL,
      preview_digest TEXT NOT NULL,
      target_path TEXT NOT NULL,
      knowledge_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('previewed', 'published', 'reconcile_pending', 'verified')),
      preview_json TEXT NOT NULL,
      publish_json TEXT,
      verify_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  migrateSchema(db);
  return { db, dataDir, databasePath, projectsDir, stagesDir };
}

function migrateSchema(db: DatabaseSync): void {
  const row = db.prepare("SELECT version FROM pt_schema LIMIT 1").get() as { version: number };
  if (row.version >= 2) {
    migrateRunsV3(db, row.version);
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec(`
      BEGIN IMMEDIATE;

      CREATE TABLE pt_cards_v2 (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES pt_projects(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        branch_kind TEXT NOT NULL CHECK(branch_kind IN ('root', 'deep_dive', 'diverge', 'reroute', 'concept')),
        source_card_id TEXT REFERENCES pt_cards_v2(id) ON DELETE SET NULL,
        branch_context_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO pt_cards_v2
        SELECT id, project_id, session_id, title, branch_kind, source_card_id,
               branch_context_json, created_at, updated_at
        FROM pt_cards;
      DROP TABLE pt_cards;
      ALTER TABLE pt_cards_v2 RENAME TO pt_cards;
      CREATE INDEX pt_cards_project ON pt_cards(project_id, created_at);

      CREATE TABLE pt_edges_v2 (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES pt_projects(id) ON DELETE CASCADE,
        source_card_id TEXT NOT NULL REFERENCES pt_cards(id) ON DELETE CASCADE,
        target_card_id TEXT NOT NULL REFERENCES pt_cards(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('deep_dive', 'diverge', 'reroute', 'concept')),
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO pt_edges_v2
        SELECT id, project_id, source_card_id, target_card_id, kind, snapshot_json, created_at
        FROM pt_edges;
      DROP TABLE pt_edges;
      ALTER TABLE pt_edges_v2 RENAME TO pt_edges;
      CREATE INDEX pt_edges_project ON pt_edges(project_id, created_at);

      UPDATE pt_schema SET version = 2;
      COMMIT;
    `);
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Transaction may already have rolled back.
    }
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }

  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length > 0) throw new Error("Schema migration left invalid foreign keys");

  migrateRunsV3(db, 2);
}

/** v3：pt_runs 增加按需概念会话所需的列（正式轮不受影响，默认 kind='answer'）。 */
function migrateRunsV3(db: DatabaseSync, version: number): void {
  if (version >= 3) return;
  const columns = (db.prepare("PRAGMA table_info(pt_runs)").all() as Array<{ name: string }>)
    .map((column) => column.name);
  // CREATE TABLE IF NOT EXISTS 先跑过：全新库的 pt_runs 已带新列，只需升版本号
  if (columns.includes("kind")) {
    db.exec("UPDATE pt_schema SET version = 3");
    return;
  }
  db.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE pt_runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'answer';
    ALTER TABLE pt_runs ADD COLUMN session_id TEXT;
    ALTER TABLE pt_runs ADD COLUMN source_run_id TEXT;
    ALTER TABLE pt_runs ADD COLUMN concept_term TEXT;
    UPDATE pt_schema SET version = 3;
    COMMIT;
  `);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function requireProject(db: DatabaseSync, projectId: string): ProjectRow {
  const row = db.prepare("SELECT * FROM pt_projects WHERE id = ?").get(projectId) as ProjectRow | undefined;
  if (!row) throw httpError(404, "Project not found");
  return row;
}

export function requireCard(db: DatabaseSync, cardId: string): CardRow {
  const row = db.prepare("SELECT * FROM pt_cards WHERE id = ?").get(cardId) as CardRow | undefined;
  if (!row) throw httpError(404, "Card not found");
  return row;
}

export function requireRun(db: DatabaseSync, runId: string): RunRow {
  const row = db.prepare("SELECT * FROM pt_runs WHERE id = ?").get(runId) as RunRow | undefined;
  if (!row) throw httpError(404, "Run not found");
  return row;
}

export function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

export function jsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
