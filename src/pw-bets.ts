import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { httpError, nowIso } from "./data.ts";

export type PwBetStatus = "draft" | "pending" | "settled" | "void";

export type CreatePwBetInput = {
  title: string;
  thesis: string;
  metric?: string | null;
  metricTarget?: string | null;
  metric_target?: string | null;
  confidence?: number | null;
  dataSourcePlan?: string | null;
  data_source_plan?: string | null;
  checkoutDate?: string | null;
  checkout_date?: string | null;
  status?: "draft" | "pending";
  goldRefs?: string[] | null;
  gold_refs?: string[] | null;
  createdFrom?: string | null;
  created_from?: string | null;
};

export type PwBetKind = "verdict" | "content";

export type PwBetRow = {
  id: string;
  title: string;
  thesis: string;
  metric: string | null;
  metric_target: string | null;
  confidence: number | null;
  data_source_plan: string | null;
  checkout_date: string | null;
  status: PwBetStatus;
  gold_refs_json: string;
  created_from: string | null;
  created_at: string;
  settled_verdict_id: string | null;
  /** TASK-PW-19：'verdict'（传统押注/草稿）| 'content'（内容押注卡）。 */
  kind: PwBetKind;
  /** TASK-PW-19：来源筛子候选卡 id（弱引用 pw_sieve_cards.id，不加外键）。 */
  source_card_id: string | null;
};

export function ensurePwBetTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pw_bets (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      thesis TEXT NOT NULL,
      metric TEXT,
      metric_target TEXT,
      confidence INTEGER,
      data_source_plan TEXT,
      checkout_date TEXT,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft', 'pending', 'settled', 'void')),
      gold_refs_json TEXT NOT NULL DEFAULT '[]',
      created_from TEXT,
      created_at TEXT NOT NULL,
      settled_verdict_id TEXT,
      kind TEXT NOT NULL DEFAULT 'verdict',
      source_card_id TEXT
    );
  `);
  migratePwBetContentColumns(db);
}

/**
 * TASK-PW-19：既有库的 pw_bets 无 kind/source_card_id 两列（ALTER 追加）；
 * 已带新列的库（新建表）幂等跳过。旧行全部落 kind='verdict'。
 */
function migratePwBetContentColumns(db: DatabaseSync): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(pw_bets)").all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
  if (!columns.has("kind")) {
    db.exec("ALTER TABLE pw_bets ADD COLUMN kind TEXT NOT NULL DEFAULT 'verdict'");
  }
  if (!columns.has("source_card_id")) {
    db.exec("ALTER TABLE pw_bets ADD COLUMN source_card_id TEXT");
  }
}

export function createPwBet(db: DatabaseSync, input: CreatePwBetInput): PwBetRow {
  const title = requiredText(input.title, "标题");
  const thesis = requiredText(input.thesis, "押注假设");
  const status = input.status ?? "draft";
  if (status !== "draft" && status !== "pending") {
    throw httpError(400, "新押注只能创建为 draft 或 pending");
  }

  const metric = optionalText(input.metric);
  const metricTarget = optionalText(
    input.metric_target !== undefined ? input.metric_target : input.metricTarget,
  );
  const dataSourcePlan = optionalText(
    input.data_source_plan !== undefined ? input.data_source_plan : input.dataSourcePlan,
  );
  const checkoutDate = optionalText(
    input.checkout_date !== undefined ? input.checkout_date : input.checkoutDate,
  );
  if (status === "pending" && (!metric || !dataSourcePlan || !checkoutDate)) {
    throw httpError(400, "pending 押注必须填写验证指标、数据来源和结账日");
  }

  if (
    input.confidence !== undefined
    && input.confidence !== null
    && (!Number.isInteger(input.confidence) || input.confidence < 0 || input.confidence > 100)
  ) {
    throw httpError(400, "置信度必须是 0–100 的整数");
  }

  const goldRefsValue = input.gold_refs !== undefined ? input.gold_refs : input.goldRefs ?? [];
  if (
    !Array.isArray(goldRefsValue)
    || goldRefsValue.some((id) => typeof id !== "string" || !id.trim())
  ) {
    throw httpError(400, "goldRefs 必须是金子 id 数组");
  }
  const goldRefs = goldRefsValue.map((id) => id.trim());

  const id = randomUUID();
  db.prepare(`
    INSERT INTO pw_bets(
      id, title, thesis, metric, metric_target, confidence,
      data_source_plan, checkout_date, status, gold_refs_json,
      created_from, created_at, settled_verdict_id
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    id,
    title,
    thesis,
    metric,
    metricTarget,
    input.confidence ?? null,
    dataSourcePlan,
    checkoutDate,
    status,
    JSON.stringify(goldRefs),
    optionalText(input.created_from !== undefined ? input.created_from : input.createdFrom),
    nowIso(),
  );
  return getPwBet(db, id)!;
}

/** TASK-PW-24：可编辑字段（仅 draft/pending 态；只更新传入字段）。 */
export type PwBetFieldEdits = {
  title?: string;
  thesis?: string;
  metric?: string | null;
  metricTarget?: string | null;
  confidence?: number | null;
  checkoutDate?: string | null;
};

/**
 * TASK-PW-24：编辑押注字段（exec 工具 edit_bet 消费）。
 * - 仅 draft/pending 态可编辑；settled/void → 409；
 * - 只更新传入字段（undefined 跳过；null 清空可空字段）；
 * - 字段校验与 createPwBet 同款（标题/假设必填、置信度 0–100 整数）。
 */
export function updatePwBetFields(
  db: DatabaseSync,
  betId: string,
  fields: PwBetFieldEdits = {},
): PwBetRow {
  const bet = getPwBet(db, betId);
  if (!bet) throw httpError(404, "押注不存在");
  if (bet.status !== "draft" && bet.status !== "pending") {
    throw httpError(409, `仅 draft/pending 押注可编辑，当前状态 ${bet.status}`);
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  if (fields.title !== undefined) {
    sets.push("title = ?");
    params.push(requiredText(fields.title, "标题"));
  }
  if (fields.thesis !== undefined) {
    sets.push("thesis = ?");
    params.push(requiredText(fields.thesis, "押注假设"));
  }
  if (fields.metric !== undefined) {
    sets.push("metric = ?");
    params.push(optionalText(fields.metric));
  }
  if (fields.metricTarget !== undefined) {
    sets.push("metric_target = ?");
    params.push(optionalText(fields.metricTarget));
  }
  if (fields.confidence !== undefined) {
    if (
      fields.confidence !== null
      && (!Number.isInteger(fields.confidence) || fields.confidence < 0 || fields.confidence > 100)
    ) {
      throw httpError(400, "置信度必须是 0–100 的整数");
    }
    sets.push("confidence = ?");
    params.push(fields.confidence);
  }
  if (fields.checkoutDate !== undefined) {
    sets.push("checkout_date = ?");
    params.push(optionalText(fields.checkoutDate));
  }
  if (sets.length === 0) return bet;
  db.prepare(`UPDATE pw_bets SET ${sets.join(", ")} WHERE id = ?`).run(...params, betId);
  return getPwBet(db, betId)!;
}

export function getPwBet(db: DatabaseSync, id: string): PwBetRow | undefined {
  return db.prepare("SELECT * FROM pw_bets WHERE id = ?").get(id) as PwBetRow | undefined;
}

export function listPwBets(
  db: DatabaseSync,
  options: { status?: PwBetStatus } = {},
): PwBetRow[] {
  if (options.status) {
    return db.prepare(`
      SELECT * FROM pw_bets
      WHERE status = ?
      ORDER BY created_at, id
    `).all(options.status) as PwBetRow[];
  }
  return db.prepare(`
    SELECT * FROM pw_bets
    WHERE status <> 'draft'
    ORDER BY created_at, id
  `).all() as PwBetRow[];
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw httpError(400, `${label}不能为空`);
  const text = value.trim();
  return text;
}

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw httpError(400, "文本字段格式非法");
  const text = value.trim();
  return text || null;
}
