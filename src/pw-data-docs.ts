import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { httpError, nowIso } from "./data.ts";

export type PwDataDocRow = {
  id: string;
  bet_id: string;
  artifact_id: string | null;
  platform: string;
  collected_at: string;
  method: "manual" | "export" | "sync";
  metrics_json: string;
  raw_ref: string | null;
  source_hash: string | null;
  version: number;
  frozen: number;
  created_at: string;
};

export type CreatePwDataDocInput = {
  betId: string;
  artifactId?: string | null;
  platform: string;
  collectedAt?: string;
  method?: "manual" | "export" | "sync";
  metricsJson: string;
  rawRef?: string | null;
  sourceHash?: string | null;
};

export function ensurePwDataDocTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pw_data_docs (
      id TEXT PRIMARY KEY,
      bet_id TEXT NOT NULL,
      artifact_id TEXT,
      platform TEXT NOT NULL,
      collected_at TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT 'manual' CHECK(method IN ('manual','export','sync')),
      metrics_json TEXT NOT NULL,
      raw_ref TEXT,
      source_hash TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      frozen INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);
}

export function createPwDataDoc(
  db: DatabaseSync,
  input: CreatePwDataDocInput,
): PwDataDocRow {
  const betId = required(input.betId, "bet_id");
  const platform = required(input.platform, "platform");
  const collectedAt = required(input.collectedAt ?? nowIso(), "collected_at");
  if ((input.method ?? "manual") !== "manual") {
    throw new Error("P0 data documents only support method=manual");
  }
  assertMetricsObject(input.metricsJson);

  const id = randomUUID();
  db.prepare(`
    INSERT INTO pw_data_docs(
      id, bet_id, artifact_id, platform, collected_at, method, metrics_json,
      raw_ref, source_hash, version, frozen, created_at
    ) VALUES(?, ?, ?, ?, ?, 'manual', ?, ?, ?, 1, 0, ?)
  `).run(
    id,
    betId,
    input.artifactId ?? null,
    platform,
    collectedAt,
    input.metricsJson,
    input.rawRef ?? null,
    input.sourceHash ?? null,
    nowIso(),
  );
  return getPwDataDoc(db, id);
}

export function appendPwDataDocVersion(
  db: DatabaseSync,
  docId: string,
  metricsJson: string,
): PwDataDocRow {
  assertMetricsObject(metricsJson);
  db.exec("BEGIN IMMEDIATE");
  try {
    const source = getPwDataDoc(db, docId);
    const latest = latestForDocument(db, source);
    if (latest.frozen) throw new Error("Frozen data documents cannot be versioned");

    const id = randomUUID();
    db.prepare(`
      INSERT INTO pw_data_docs(
        id, bet_id, artifact_id, platform, collected_at, method, metrics_json,
        raw_ref, source_hash, version, frozen, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      id,
      latest.bet_id,
      latest.artifact_id,
      latest.platform,
      latest.collected_at,
      latest.method,
      metricsJson,
      latest.raw_ref,
      latest.source_hash,
      latest.version + 1,
      nowIso(),
    );
    db.exec("COMMIT");
    return getPwDataDoc(db, id);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function freezePwDataDoc(db: DatabaseSync, id: string): void {
  const source = getPwDataDoc(db, id);
  db.prepare(`
    UPDATE pw_data_docs
    SET frozen = 1
    WHERE bet_id = ?
      AND platform = ?
      AND (artifact_id = ? OR (artifact_id IS NULL AND ? IS NULL))
  `).run(source.bet_id, source.platform, source.artifact_id, source.artifact_id);
}

export function getPwDataDoc(db: DatabaseSync, id: string): PwDataDocRow {
  const row = db.prepare("SELECT * FROM pw_data_docs WHERE id = ?").get(id) as PwDataDocRow | undefined;
  if (!row) throw new Error("Data document not found");
  return row;
}

export function listPwDataDocs(db: DatabaseSync, betId: string): PwDataDocRow[] {
  return db.prepare(`
    SELECT d.*
    FROM pw_data_docs d
    WHERE d.bet_id = ?
      AND NOT EXISTS (
        SELECT 1
        FROM pw_data_docs newer
        WHERE newer.bet_id = d.bet_id
          AND newer.platform = d.platform
          AND (newer.artifact_id = d.artifact_id
            OR (newer.artifact_id IS NULL AND d.artifact_id IS NULL))
          AND newer.version > d.version
      )
    ORDER BY d.created_at, d.id
  `).all(betId) as PwDataDocRow[];
}

export type PwDataDocVersionRow = PwDataDocRow & {
  artifact_title: string | null;
};

/**
 * TASK-PW-17：版本链全量读取（不做 NOT EXISTS 过滤），每行带
 * method/frozen/raw_ref/version，join 产出物标题；version 正序。
 * 与 listPwDataDocs（只回每组最新版）互补，供趋势与溯源消费。只读。
 */
export function listPwDataDocVersions(
  db: DatabaseSync,
  options: { betId: string; platform?: string; artifactId?: string | null },
): PwDataDocVersionRow[] {
  const betId = typeof options.betId === "string" ? options.betId.trim() : "";
  if (!betId) throw httpError(400, "betId 必填");
  const clauses = ["d.bet_id = ?"];
  const params: unknown[] = [betId];
  if (options.platform !== undefined) {
    const platform = typeof options.platform === "string" ? options.platform.trim() : "";
    if (!platform) throw httpError(400, "platform 不能为空");
    clauses.push("d.platform = ?");
    params.push(platform);
  }
  if (options.artifactId !== undefined) {
    if (options.artifactId === null) {
      clauses.push("d.artifact_id IS NULL");
    } else {
      clauses.push("d.artifact_id = ?");
      params.push(options.artifactId);
    }
  }
  return db.prepare(`
    SELECT d.*, a.title AS artifact_title
    FROM pw_data_docs d
    LEFT JOIN pw_artifacts a ON a.id = d.artifact_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY d.version ASC, d.created_at ASC, d.id ASC
  `).all(...params) as PwDataDocVersionRow[];
}

function latestForDocument(db: DatabaseSync, source: PwDataDocRow): PwDataDocRow {
  const row = db.prepare(`
    SELECT *
    FROM pw_data_docs
    WHERE bet_id = ?
      AND platform = ?
      AND (artifact_id = ? OR (artifact_id IS NULL AND ? IS NULL))
    ORDER BY version DESC, created_at DESC, id DESC
    LIMIT 1
  `).get(source.bet_id, source.platform, source.artifact_id, source.artifact_id) as PwDataDocRow | undefined;
  if (!row) throw new Error("Data document not found");
  return row;
}

function required(value: string | undefined, field: string): string {
  if (!value?.trim()) throw new Error(`${field} is required`);
  return value;
}

function assertMetricsObject(metricsJson: string): void {
  try {
    const value: unknown = JSON.parse(metricsJson);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("metrics_json must be a JSON object");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "metrics_json must be a JSON object") throw error;
    throw new Error("metrics_json must be valid JSON object");
  }
}
