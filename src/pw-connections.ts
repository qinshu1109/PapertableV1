/**
 * TASK-PW-13：平台连接（pw_connections）与 B站低频同步落库。
 *
 * 军规（写进表结构的纪律）：
 * - auth_ref 恒为 NULL：表内永不存 cookie / 登录态本体，AI 不碰凭证；
 *   登录态只活在用户侧的 ego lite 浏览器里。
 * - 同步只读：sync 只落 pw_data_docs（method='sync'，version 只增不改）与
 *   pw_runs 留痕，不回写任何业务表。
 * - 验证码 / 登录墙一律置 needs_human 交人，恢复 active 不清空 risk_events。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { httpError, nowIso } from "./data.ts";
import { recordPwEvent, type PwEventActor } from "./pw-runs.ts";

export const BILIBILI_PLATFORM = "B站";

export type PwConnectionStatus = "active" | "needs_human" | "paused";

export type PwConnectionRow = {
  id: string;
  platform: string;
  account_label: string | null;
  /** 恒为 NULL：cookie 本体永不落库（见文件头军规）。 */
  auth_ref: string | null;
  status: PwConnectionStatus;
  last_sync_at: string | null;
  risk_events_json: string;
  created_at: string;
};

export type PwConnectionWithDocs = PwConnectionRow & { docs_count: number };

export type PwDataDocJoined = {
  id: string;
  bet_id: string;
  artifact_id: string | null;
  platform: string;
  collected_at: string;
  method: string;
  metrics_json: string;
  raw_ref: string | null;
  source_hash: string | null;
  version: number;
  frozen: number;
  created_at: string;
  bet_title: string | null;
  artifact_title: string | null;
};

export type SyncBilibiliItem = {
  artifactId?: unknown;
  metrics?: unknown;
  rawRef?: unknown;
};

export type SyncBilibiliResult = {
  created: number;
  /** 本批实际插入的 pw_data_docs 行 UUID（供筛子到达通知按行去重）。 */
  createdIds: string[];
  errors: Array<{ artifactId: string | null; reason: string }>;
};

const STATUSES = new Set<PwConnectionStatus>(["active", "needs_human", "paused"]);

export function ensurePwConnectionTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pw_connections (
      id TEXT PRIMARY KEY,
      -- 一个平台一条连接
      platform TEXT NOT NULL UNIQUE,
      account_label TEXT,
      -- 军规：恒为 NULL，cookie / 登录态本体永不进库
      auth_ref TEXT,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'needs_human', 'paused')),
      last_sync_at TEXT,
      risk_events_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
  `);
}

/** 连接列表 + 每平台 method='sync' 的数据文档数。 */
export function listPwConnections(db: DatabaseSync): PwConnectionWithDocs[] {
  return db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM pw_data_docs d
        WHERE d.platform = c.platform AND d.method = 'sync') AS docs_count
    FROM pw_connections c
    ORDER BY c.created_at, c.id
  `).all() as PwConnectionWithDocs[];
}

export type PwConnectionStatusView = {
  id: string;
  platform: string;
  account_label: string | null;
  status: PwConnectionStatus;
  last_sync_at: string | null;
  /** risk_events_json 解析后的数组（[{at, reason}]，只增不清） */
  risk_events: Array<{ at: string; reason: string }>;
  created_at: string;
};

/**
 * TASK-PW-17：连接与同步状态读取。platform 省略时返回全量数组；
 * 指定平台返回单条（不存在抛 404）。risk_events_json 解析为数组。只读。
 */
export function getPwConnectionStatus(
  db: DatabaseSync,
  platform?: string,
): PwConnectionStatusView | PwConnectionStatusView[] {
  if (platform === undefined || platform === null) {
    const rows = db.prepare(
      "SELECT * FROM pw_connections ORDER BY created_at, id",
    ).all() as PwConnectionRow[];
    return rows.map(toStatusView);
  }
  const name = typeof platform === "string" ? platform.trim() : "";
  if (!name) throw httpError(400, "platform 不能为空");
  const row = db.prepare("SELECT * FROM pw_connections WHERE platform = ?").get(name) as
    | PwConnectionRow
    | undefined;
  if (!row) throw httpError(404, "连接不存在");
  return toStatusView(row);
}

function toStatusView(row: PwConnectionRow): PwConnectionStatusView {
  return {
    id: row.id,
    platform: row.platform,
    account_label: row.account_label,
    status: row.status,
    last_sync_at: row.last_sync_at,
    risk_events: parseRiskEvents(row.risk_events_json),
    created_at: row.created_at,
  };
}

/** 登记连接：同 platform 幂等返回既有，否则创建 status='active'。 */
export function registerPwConnection(
  db: DatabaseSync,
  input: { platform?: unknown; accountLabel?: unknown },
): PwConnectionRow {
  const platform = requiredText(input.platform, "platform");
  const existing = db.prepare(
    "SELECT * FROM pw_connections WHERE platform = ?",
  ).get(platform) as PwConnectionRow | undefined;
  if (existing) return existing;

  const accountLabel = input.accountLabel == null ? null : requiredText(input.accountLabel, "accountLabel");
  const id = randomUUID();
  // auth_ref 不接收任何入参，恒 NULL（军规：cookie 本体永不落库）
  db.prepare(`
    INSERT INTO pw_connections(
      id, platform, account_label, auth_ref, status, last_sync_at, risk_events_json, created_at
    ) VALUES(?, ?, ?, NULL, 'active', NULL, '[]', ?)
  `).run(id, platform, accountLabel, nowIso());
  // TASK-PW-23：平台连接登记记账（actor=human）
  recordPwEvent(db, {
    eventType: "connection",
    actor: "human",
    payloadJson: JSON.stringify({ connectionId: id, platform, status: "active" }),
  });
  return getPwConnection(db, id);
}

/**
 * 状态机：active / needs_human / paused。
 * 变为 needs_human 时向 risk_events_json 追加 {at, reason}；恢复 active 不清空。
 */
export function setPwConnectionStatus(
  db: DatabaseSync,
  id: string,
  status: unknown,
  reason?: unknown,
): PwConnectionRow {
  if (typeof status !== "string" || !STATUSES.has(status as PwConnectionStatus)) {
    throw httpError(400, "非法 status");
  }
  const next = status as PwConnectionStatus;
  const conn = getPwConnection(db, id);

  // TASK-PW-23：状态变更记账按结果分流——needs_human（交人）记 system，其余记 human
  const actor: PwEventActor = next === "needs_human" ? "system" : "human";
  let riskEvents = parseRiskEvents(conn.risk_events_json);
  if (next === "needs_human" && conn.status !== "needs_human") {
    riskEvents = [
      ...riskEvents,
      {
        at: nowIso(),
        reason: typeof reason === "string" && reason.trim() ? reason.trim() : "人工标记",
      },
    ];
    db.prepare(
      "UPDATE pw_connections SET status = ?, risk_events_json = ? WHERE id = ?",
    ).run(next, JSON.stringify(riskEvents), id);
  } else {
    db.prepare("UPDATE pw_connections SET status = ? WHERE id = ?").run(next, id);
  }
  recordPwEvent(db, {
    eventType: "connection",
    actor,
    payloadJson: JSON.stringify({
      connectionId: id,
      platform: conn.platform,
      status: next,
    }),
  });
  return getPwConnection(db, id);
}

/**
 * B站低频同步落库：逐条校验产出物（存在、platform='B站'、未摘除），
 * 落 pw_data_docs（method='sync'，version=该 artifact 已有文档数+1，只增不改），
 * 每条写 pw_runs（kind='sync', event_type='data_doc', actor='system'）；
 * 全部处理后更新连接 last_sync_at。
 */
export function syncPwBilibili(
  db: DatabaseSync,
  items: unknown,
): SyncBilibiliResult {
  const conn = db.prepare(
    "SELECT * FROM pw_connections WHERE platform = ?",
  ).get(BILIBILI_PLATFORM) as PwConnectionRow | undefined;
  if (!conn) throw httpError(404, "尚无 B站连接，请先在数据源屏登记");
  if (!Array.isArray(items)) throw httpError(400, "items 必须是数组");

  const result: SyncBilibiliResult = { created: 0, errors: [], createdIds: [] };
  for (const raw of items) {
    const item = (raw ?? {}) as SyncBilibiliItem;
    const artifactId = typeof item.artifactId === "string" ? item.artifactId : null;
    const reject = (reason: string) => result.errors.push({ artifactId, reason });

    if (!artifactId) {
      reject("artifactId 缺失或非法");
      continue;
    }
    const artifact = db.prepare(
      "SELECT id, bet_id, platform, detached_at FROM pw_artifacts WHERE id = ?",
    ).get(artifactId) as
      | { id: string; bet_id: string; platform: string; detached_at: string | null }
      | undefined;
    if (!artifact) {
      reject("产出物不存在");
      continue;
    }
    if (artifact.platform !== BILIBILI_PLATFORM) {
      reject(`产出物平台不是 ${BILIBILI_PLATFORM}`);
      continue;
    }
    if (artifact.detached_at !== null) {
      reject("产出物已摘除");
      continue;
    }
    let metricsJson: string;
    try {
      metricsJson = metricsToJson(item.metrics);
    } catch (error) {
      reject(error instanceof Error ? error.message : String(error));
      continue;
    }
    const rawRef = typeof item.rawRef === "string" && item.rawRef.trim() ? item.rawRef.trim() : null;

    const { n } = db.prepare(
      "SELECT COUNT(*) AS n FROM pw_data_docs WHERE artifact_id = ?",
    ).get(artifactId) as { n: number };
    const docId = randomUUID();
    const now = nowIso();
    db.prepare(`
      INSERT INTO pw_data_docs(
        id, bet_id, artifact_id, platform, collected_at, method, metrics_json,
        raw_ref, source_hash, version, frozen, created_at
      ) VALUES(?, ?, ?, ?, ?, 'sync', ?, ?, NULL, ?, 0, ?)
    `).run(docId, artifact.bet_id, artifactId, BILIBILI_PLATFORM, now, metricsJson, rawRef, n + 1, now);

    recordPwEvent(db, {
      kind: "sync",
      eventType: "data_doc",
      actor: "system",
      payloadJson: JSON.stringify({ artifactId, metrics: JSON.parse(metricsJson) }),
      relatedIds: [docId, artifactId],
      betId: artifact.bet_id,
    });
    result.created += 1;
    result.createdIds.push(docId);
  }

  db.prepare("UPDATE pw_connections SET last_sync_at = ? WHERE id = ?").run(nowIso(), conn.id);
  return result;
}

/** 全量数据文档（数据源屏表格）：join 押注 / 产出物标题，collected_at 倒序；作废押注的文档不进表（作废不计入判断账）。 */
export function listAllPwDataDocs(db: DatabaseSync): PwDataDocJoined[] {
  return db.prepare(`
    SELECT d.*, b.title AS bet_title, a.title AS artifact_title
    FROM pw_data_docs d
    LEFT JOIN pw_bets b ON b.id = d.bet_id
    LEFT JOIN pw_artifacts a ON a.id = d.artifact_id
    WHERE b.status IS NULL OR b.status != 'void'
    ORDER BY d.collected_at DESC, d.id DESC
  `).all() as PwDataDocJoined[];
}

function getPwConnection(db: DatabaseSync, id: string): PwConnectionRow {
  const row = db.prepare("SELECT * FROM pw_connections WHERE id = ?").get(id) as
    | PwConnectionRow
    | undefined;
  if (!row) throw httpError(404, "连接不存在");
  return row;
}

function parseRiskEvents(json: string): Array<{ at: string; reason: string }> {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? (value as Array<{ at: string; reason: string }>) : [];
  } catch {
    return [];
  }
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw httpError(400, `${field} 不能为空`);
  return value.trim();
}

function metricsToJson(metrics: unknown): string {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
    throw new Error("metrics 必须是 JSON 对象");
  }
  return JSON.stringify(metrics);
}
