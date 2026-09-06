import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type PwRunKind =
  | "manual_event"
  | "ai_draft"
  | "ai_exec"
  | "sync"
  | "sieve"
  | "ai_auto"
  | "pt_chain_export";
export type PwEventType =
  | "create"
  | "attach"
  | "data_doc"
  | "draft"
  | "confirm"
  | "reject"
  | "settle"
  | "fetch_propose"
  | "sieve_run"
  // TASK-PW-23：新增 10 个（edit/freeze/undo 供 PW-24/25 用，本刀只扩枚举）
  | "edit"
  | "freeze"
  | "voice"
  | "classify"
  | "drop"
  | "mirror"
  | "corpus"
  | "connection"
  | "message"
  | "undo";
export type PwEventActor = "human" | "ai" | "system";

export type PwRunRow = {
  id: string;
  kind: PwRunKind;
  event_type: PwEventType;
  actor: PwEventActor;
  payload_json: string;
  payload_hash: string;
  parent_id: string | null;
  related_ids_json: string;
  bet_id: string | null;
  created_at: string;
  /** TASK-PW-23：ai_exec 行的指令原话；TASK-PW-26：ai_auto 行无指令引用（恒 NULL）；历史行与其余 kind 恒为 NULL。 */
  instruction_text: string | null;
  /** TASK-PW-23：来源 pw_collab_messages 行 id（弱引用）。 */
  instruction_message_id: string | null;
};

export type PwEventInput = {
  id?: string;
  kind?: PwRunKind;
  eventType?: PwEventType;
  event_type?: PwEventType;
  actor?: PwEventActor;
  payloadJson?: string;
  payload_json?: string;
  /** Accepted for callers that already computed a digest; the module always wins. */
  payloadHash?: string;
  payload_hash?: string;
  parentId?: string | null;
  parent_id?: string | null;
  relatedIds?: readonly string[];
  related_ids?: readonly string[];
  betId?: string | null;
  bet_id?: string | null;
  createdAt?: string;
  created_at?: string;
  /** TASK-PW-23：指令原话（ai_exec 行必填，helper 层强制）。 */
  instructionText?: string | null;
  instruction_text?: string | null;
  /** TASK-PW-23：来源 pw_collab_messages 行 id（ai_exec 行必填，helper 层强制）。 */
  instructionMessageId?: string | null;
  instruction_message_id?: string | null;
};

const EVENT_TYPES = new Set<PwEventType>([
  "create",
  "attach",
  "data_doc",
  "draft",
  "confirm",
  "reject",
  "settle",
  "fetch_propose",
  "sieve_run",
  "edit",
  "freeze",
  "voice",
  "classify",
  "drop",
  "mirror",
  "corpus",
  "connection",
  "message",
  "undo",
]);

const RUN_KINDS = new Set<PwRunKind>([
  "manual_event",
  "ai_draft",
  "ai_exec",
  "sync",
  "sieve",
  "ai_auto",
  "pt_chain_export",
]);

export function ensurePwRunTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pw_runs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('manual_event','ai_draft','ai_exec','sync','sieve','ai_auto','pt_chain_export')),
      event_type TEXT NOT NULL CHECK(event_type IN (
        'create','attach','data_doc','draft','confirm','reject','settle','fetch_propose','sieve_run',
        'edit','freeze','voice','classify','drop','mirror','corpus','connection','message','undo'
      )),
      actor TEXT NOT NULL CHECK(actor IN ('human','ai','system')),
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      parent_id TEXT,
      related_ids_json TEXT NOT NULL DEFAULT '[]',
      bet_id TEXT,
      created_at TEXT NOT NULL,
      instruction_text TEXT,
      instruction_message_id TEXT
    );
    CREATE INDEX IF NOT EXISTS pw_runs_bet_created
      ON pw_runs(bet_id, created_at);
  `);
  migratePwRunsCheck(db);
}

/**
 * TASK-PW-15：既有库的 pw_runs CHECK 不含 'fetch_propose'；
 * TASK-PW-18：不含 'sieve'/'sieve_run'，重建表迁移；
 * TASK-PW-23：缺 'ai_exec' 或缺 instruction_text/instruction_message_id 列时重建迁移
 * （CREATE TABLE IF NOT EXISTS 不会改动既有约束；本表无外键，可整体重建）。
 * TASK-PW-26：缺 'ai_auto' 时同样重建；instruction 两列按旧表是否具备选择拷贝（数据全量拷贝）。
 */
function migratePwRunsCheck(db: DatabaseSync): void {
  const definition = (db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pw_runs'
  `).get() as { sql?: string } | undefined)?.sql ?? "";
  if (
    definition.includes("ai_exec")
    && definition.includes("ai_auto")
    && definition.includes("pt_chain_export")
    && definition.includes("instruction_text")
    && definition.includes("instruction_message_id")
  ) {
    return;
  }
  // PW-23 起旧表已带 instruction 两列（PW-26 重建须保留其数据）；更早的表无此列则补 NULL。
  const copiedColumns = definition.includes("instruction_text")
    ? "id, kind, event_type, actor, payload_json, payload_hash, parent_id, related_ids_json, bet_id, created_at, instruction_text, instruction_message_id"
    : "id, kind, event_type, actor, payload_json, payload_hash, parent_id, related_ids_json, bet_id, created_at, NULL, NULL";
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE pw_runs_v2 (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('manual_event','ai_draft','ai_exec','sync','sieve','ai_auto','pt_chain_export')),
        event_type TEXT NOT NULL CHECK(event_type IN (
          'create','attach','data_doc','draft','confirm','reject','settle','fetch_propose','sieve_run',
          'edit','freeze','voice','classify','drop','mirror','corpus','connection','message','undo'
        )),
        actor TEXT NOT NULL CHECK(actor IN ('human','ai','system')),
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        parent_id TEXT,
        related_ids_json TEXT NOT NULL DEFAULT '[]',
        bet_id TEXT,
        created_at TEXT NOT NULL,
        instruction_text TEXT,
        instruction_message_id TEXT
      );
      INSERT INTO pw_runs_v2
        SELECT ${copiedColumns}
        FROM pw_runs;
      DROP TABLE pw_runs;
      ALTER TABLE pw_runs_v2 RENAME TO pw_runs;
      CREATE INDEX pw_runs_bet_created ON pw_runs(bet_id, created_at);
      COMMIT;
    `);
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original constraint error.
    }
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

export function recordPwEvent(db: DatabaseSync, input: PwEventInput): PwRunRow {
  const kind = input.kind ?? "manual_event";
  const actor = input.actor ?? "human";
  const eventType = input.eventType ?? input.event_type;
  const payloadJson = input.payloadJson ?? input.payload_json;
  // PW-13 起允许 kind=sync；TASK-PW-15 起允许 kind=ai_draft（AI 协作台审计）；
  // TASK-PW-18 起允许 kind=sieve（筛子 run 审计）；TASK-PW-23 起允许 kind=ai_exec（AI 执行类写入）；
  // TASK-PW-26 起允许 kind=ai_auto（AI 自主档账：机制允许的 AI 自行动作，无指令引用，actor='ai'）
  if (!RUN_KINDS.has(kind)) {
    throw badRequest("只允许 kind=manual_event / ai_draft / ai_exec / sync / sieve / ai_auto / pt_chain_export");
  }
  if (actor !== "human" && actor !== "system" && actor !== "ai") {
    throw badRequest("非法 actor");
  }
  // TASK-PW-23：(actor, kind) 白名单：
  // human → manual_event；system → manual_event / sync / sieve；
  // ai → ai_draft / ai_exec / ai_auto（TASK-PW-26 自主档），
  //      唯一例外 (ai, manual_event) 仅允许 event_type='message'（协作台 assistant 消息）
  assertActorKindPair(actor, kind, eventType);
  if (!eventType || !EVENT_TYPES.has(eventType)) throw badRequest("非法 event_type");
  if (typeof payloadJson !== "string") throw badRequest("payload_json 必须是字符串");

  try {
    JSON.parse(payloadJson);
  } catch {
    throw badRequest("payload_json 必须是合法 JSON");
  }

  const relatedIds = input.relatedIds ?? input.related_ids ?? [];
  if (!Array.isArray(relatedIds) || relatedIds.some((id) => typeof id !== "string")) {
    throw badRequest("related_ids 必须是字符串数组");
  }

  const row: PwRunRow = {
    id: input.id ?? randomUUID(),
    kind,
    event_type: eventType,
    actor,
    payload_json: payloadJson,
    payload_hash: createHash("sha256").update(payloadJson, "utf8").digest("hex"),
    parent_id: input.parentId ?? input.parent_id ?? null,
    related_ids_json: JSON.stringify(relatedIds),
    bet_id: input.betId ?? input.bet_id ?? null,
    created_at: input.createdAt ?? input.created_at ?? new Date().toISOString(),
    instruction_text: input.instructionText ?? input.instruction_text ?? null,
    instruction_message_id: input.instructionMessageId ?? input.instruction_message_id ?? null,
  };

  db.prepare(`
    INSERT INTO pw_runs(
      id, kind, event_type, actor, payload_json, payload_hash,
      parent_id, related_ids_json, bet_id, created_at, instruction_text, instruction_message_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.kind,
    row.event_type,
    row.actor,
    row.payload_json,
    row.payload_hash,
    row.parent_id,
    row.related_ids_json,
    row.bet_id,
    row.created_at,
    row.instruction_text,
    row.instruction_message_id,
  );
  return row;
}

/**
 * TASK-PW-23：AI 执行类写入统一入口（PW-24/25 的 exec 工具走它）。
 * 固定 actor='ai'、kind='ai_exec'；instruction 两列缺一即 badRequest；
 * 其余校验与落行同 recordPwEvent（payload_hash 照算）。
 */
export function recordPwExecEvent(
  db: DatabaseSync,
  input: PwEventInput & { instructionText: string; instructionMessageId: string },
): PwRunRow {
  const instructionText = input.instructionText;
  const instructionMessageId = input.instructionMessageId;
  if (typeof instructionText !== "string" || !instructionText.trim()) {
    throw badRequest("instructionText 必填（ai_exec 行必须携带指令原话）");
  }
  if (typeof instructionMessageId !== "string" || !instructionMessageId.trim()) {
    throw badRequest("instructionMessageId 必填（ai_exec 行必须携带指令来源消息 id）");
  }
  return recordPwEvent(db, {
    ...input,
    kind: "ai_exec",
    actor: "ai",
    instructionText,
    instructionMessageId,
  });
}

/** TASK-PW-23：(actor, kind) 白名单；非法组合 badRequest。 */
function assertActorKindPair(
  actor: PwEventActor,
  kind: PwRunKind,
  eventType: PwEventType | undefined,
): void {
  if (actor === "human") {
    if (kind !== "manual_event") throw badRequest("actor=human 只允许 kind=manual_event");
    return;
  }
  if (actor === "system") {
    if (kind !== "manual_event" && kind !== "sync" && kind !== "sieve" && kind !== "pt_chain_export") {
      throw badRequest("actor=system 只允许系统审计 kind");
    }
    return;
  }
  // actor === "ai"
  if (kind === "ai_draft" || kind === "ai_exec" || kind === "ai_auto") return;
  if (kind === "manual_event" && eventType === "message") return;
  throw badRequest("actor=ai 只允许 kind=ai_draft / ai_exec / ai_auto");
}

export function getPwBetTimeline(db: DatabaseSync, betId: string): PwRunRow[] {
  return db.prepare(`
    SELECT id, kind, event_type, actor, payload_json, payload_hash,
           parent_id, related_ids_json, bet_id, created_at,
           instruction_text, instruction_message_id
    FROM pw_runs
    WHERE bet_id = ?
    ORDER BY created_at ASC, rowid ASC
  `).all(betId) as PwRunRow[];
}

/**
 * TASK-PW-17：事件流读取（created_at 倒序分页）。kind/event_type/betId 过滤可选，
 * before 为 created_at 游标（严格早于）；limit 默认 50。只读。
 */
export function listPwRuns(
  db: DatabaseSync,
  options: {
    kind?: PwRunKind;
    eventType?: PwEventType;
    betId?: string | null;
    limit?: number;
    before?: string;
  } = {},
): PwRunRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.kind !== undefined) {
    if (!RUN_KINDS.has(options.kind)) throw badRequest("非法 kind");
    clauses.push("kind = ?");
    params.push(options.kind);
  }
  if (options.eventType !== undefined) {
    if (!EVENT_TYPES.has(options.eventType)) throw badRequest("非法 event_type");
    clauses.push("event_type = ?");
    params.push(options.eventType);
  }
  if (options.betId !== undefined && options.betId !== null) {
    clauses.push("bet_id = ?");
    params.push(options.betId);
  }
  if (options.before !== undefined) {
    if (typeof options.before !== "string" || !options.before.trim()) {
      throw badRequest("before 必须是 created_at 游标");
    }
    clauses.push("created_at < ?");
    params.push(options.before);
  }
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1) throw badRequest("limit 必须是正整数");
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`
    SELECT id, kind, event_type, actor, payload_json, payload_hash,
           parent_id, related_ids_json, bet_id, created_at,
           instruction_text, instruction_message_id
    FROM pw_runs
    ${where}
    ORDER BY created_at DESC, rowid DESC
    LIMIT ?
  `).all(...params, limit) as PwRunRow[];
}

export type PwActivityDay = {
  day: string;
  human: number;
  ai: number;
  system: number;
};

/**
 * TASK-PW-55：大盘「本周动作流水」聚合源（账本同源，故放本文件而非新建 pw-activity.ts）。
 * pw_runs 按 date(created_at,'localtime') 分组计数 human/ai/system 三 actor；
 * 近 N 天（默认 7、上限 30；非正整数或越界抛 400），缺日补零（含今天），按日升序。只读。
 */
export function getPwActivityDaily(
  db: DatabaseSync,
  options: { days?: number } = {},
): { days: PwActivityDay[] } {
  const days = options.days ?? 7;
  if (!Number.isInteger(days) || days < 1 || days > 30) {
    throw badRequest("days 必须是 1-30 的整数");
  }
  const now = new Date();
  const today = localDay(now);
  const start = new Date(now);
  start.setDate(start.getDate() - (days - 1));
  const startDay = localDay(start);

  const rows = db.prepare(`
    SELECT date(created_at, 'localtime') AS day, actor, COUNT(*) AS n
    FROM pw_runs
    WHERE date(created_at, 'localtime') BETWEEN ? AND ?
    GROUP BY day, actor
  `).all(startDay, today) as Array<{ day: string; actor: PwEventActor; n: number }>;

  const byDay = new Map<string, PwActivityDay>();
  for (let i = 0; i < days; i += 1) {
    const cursor = new Date(start);
    cursor.setDate(start.getDate() + i);
    const day = localDay(cursor);
    byDay.set(day, { day, human: 0, ai: 0, system: 0 });
  }
  for (const row of rows) {
    const target = byDay.get(row.day);
    if (!target) continue;
    if (row.actor === "human") target.human += row.n;
    else if (row.actor === "ai") target.ai += row.n;
    else if (row.actor === "system") target.system += row.n;
  }
  return { days: [...byDay.values()] };
}

/** 本地时区的 YYYY-MM-DD（与 SQLite date(col,'localtime') 口径一致）。 */
function localDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function badRequest(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 400 });
}
