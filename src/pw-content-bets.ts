/**
 * TASK-PW-19：内容押注卡（挑 / 改 / 否）。
 *
 * 数据真值源：pw_bets（kind='content'、source_card_id 弱引用候选卡）+ pw_sieve_cards
 * 状态流转（pending→picked/edited/rejected，单向不可逆）+ pw_runs 留痕
 * （kind='manual_event'、event_type='confirm'/'reject'，无 CHECK 迁移，动作细节进 payload）。
 *
 * 纪律：
 * - TASK-PW-19：转卡只能人触发；TASK-PW-25 起挑/否进 collab 工具表（人发话才执行，
 *   audit 参数合成 ai_exec 账）；unpick 冲正键是候选卡唯一回退口（常规回退仍 deny）。
 * - 生产版三行（SPEC-collab-harness-effect §5.1）：演示困惑（thesis）/ 转化信号（metric）/
 *   看结果日（checkout_date）；默认值：'私域加群/问工具人数'、目标 '10'、+7 天。
 * - 卡状态机：picked/edited/rejected 只允许从 pending 流转（函数级断言 +
 *   事务内 UPDATE ... WHERE status='pending' 兜底，竞态时 409）；唯一反向流转是
 *   unpick 冲正（picked/edited → pending，押注同事务作废）。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { httpError, nowIso } from "./data.ts";
import { getPwBet, type PwBetRow } from "./pw-bets.ts";
import { recordPwEvent, recordPwExecEvent } from "./pw-runs.ts";
import type { PwSieveCardRow } from "./pw-sieve.ts";

/** pick 的可选改写（camelCase 覆盖字段；与 pw_bets 列的映射见函数体）。 */
export type ContentBetOverrides = {
  title?: string;
  conversionSignal?: string;
  metricTarget?: string;
  reviewDate?: string;
};

/** TASK-PW-25：AI 执行审计——传入后自记账改走 recordPwExecEvent 合成一条 ai_exec（confirm/reject/undo）账。 */
export type PwContentBetAudit = {
  actor: "ai";
  instructionText: string;
  instructionMessageId: string;
};

export type ContentBetRow = PwBetRow & { quote_text: string | null };

const DEFAULT_METRIC = "私域加群/问工具人数";
const DEFAULT_METRIC_TARGET = "10";
const DEFAULT_DATA_SOURCE_PLAN = "私域群/评论区人工统计";
const CHECKOUT_DAYS = 7;
const TITLE_MAX_CHARS = 30;

function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (caught) {
    db.exec("ROLLBACK");
    throw caught;
  }
}

function getCard(db: DatabaseSync, cardId: string): PwSieveCardRow | undefined {
  return db.prepare("SELECT * FROM pw_sieve_cards WHERE id = ?").get(cardId) as PwSieveCardRow | undefined;
}

function overrideText(value: string | undefined): string | null {
  if (value === undefined) return null;
  const text = value.trim();
  return text || null;
}

/** quote_source_json 容错读取：损坏/缺字段按缺失处理，不阻断转卡。 */
function sourceParts(
  quoteSourceJson: string,
): { bvid: string | null; uname: string | null; like: number | null } {
  try {
    const parsed: unknown = JSON.parse(quoteSourceJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      return {
        bvid: typeof record.bvid === "string" ? record.bvid : null,
        uname: typeof record.uname === "string" ? record.uname : null,
        like: typeof record.like === "number" ? record.like : null,
      };
    }
  } catch {
    // 忽略损坏来源
  }
  return { bvid: null, uname: null, like: null };
}

/** title 默认：quote_text 截断（≤30 字，直接截不补省略号以严格满足长度约束）。 */
function defaultTitle(quoteText: string): string {
  return quoteText.length <= TITLE_MAX_CHARS ? quoteText : quoteText.slice(0, TITLE_MAX_CHARS);
}

/** thesis（演示困惑）：quote_text 原文 + 来源（bvid/uname/like）。 */
function buildThesis(
  quoteText: string,
  source: { bvid: string | null; uname: string | null; like: number | null },
): string {
  const parts = [
    `bvid=${source.bvid ?? "?"}`,
    `uname=${source.uname ?? "?"}`,
    `like=${source.like ?? 0}`,
  ];
  return `原文：${quoteText}\n来源：${parts.join("，")}`;
}

/** checkout_date 默认（看结果日）：+7 天，UTC 日期 yyyy-mm-dd（与既有日期串风格一致）。 */
function defaultCheckoutDate(nowMs: number = Date.now()): string {
  return new Date(nowMs + CHECKOUT_DAYS * 86_400_000).toISOString().slice(0, 10);
}

/**
 * 挑（可改）：pending 候选卡 → 内容押注卡（kind='content'，status='pending'）。
 * 无 overrides → 卡 'picked'；有 overrides → 卡 'edited'。pw_runs 留 confirm 痕。
 * 卡非 pending（含不存在）→ 409；状态流转与押注创建同事务，不可逆。
 * TASK-PW-25：传入 audit 时改走 recordPwExecEvent 合成一条 ai_exec(confirm) 账（不记 manual_event）。
 */
export function pickPwSieveCard(
  db: DatabaseSync,
  cardId: string,
  overrides: ContentBetOverrides = {},
  audit?: PwContentBetAudit,
): PwBetRow {
  return inTransaction(db, () => {
    const card = getCard(db, cardId);
    if (!card || card.status !== "pending") {
      throw httpError(409, "候选卡不存在或不是 pending 态");
    }

    const title = overrideText(overrides.title) ?? defaultTitle(card.quote_text);
    const source = sourceParts(card.quote_source_json);
    const thesis = buildThesis(card.quote_text, source);
    const metric = overrideText(overrides.conversionSignal) ?? DEFAULT_METRIC;
    const metricTarget = overrideText(overrides.metricTarget) ?? DEFAULT_METRIC_TARGET;
    const checkoutDate = overrideText(overrides.reviewDate) ?? defaultCheckoutDate();
    const betId = randomUUID();
    const createdAt = nowIso();

    db.prepare(`
      INSERT INTO pw_bets(
        id, title, thesis, metric, metric_target, confidence, data_source_plan,
        checkout_date, status, gold_refs_json, created_from, created_at,
        settled_verdict_id, kind, source_card_id
      ) VALUES(?, ?, ?, ?, ?, NULL, ?, ?, 'pending', '[]', NULL, ?, NULL, 'content', ?)
    `).run(
      betId,
      title,
      thesis,
      metric,
      metricTarget,
      DEFAULT_DATA_SOURCE_PLAN,
      checkoutDate,
      createdAt,
      cardId,
    );

    const hasOverrides = overrides.title !== undefined
      || overrides.conversionSignal !== undefined
      || overrides.metricTarget !== undefined
      || overrides.reviewDate !== undefined;
    const nextStatus = hasOverrides ? "edited" : "picked";
    const updated = db.prepare(`
      UPDATE pw_sieve_cards SET status = ? WHERE id = ? AND status = 'pending'
    `).run(nextStatus, cardId);
    if (updated.changes !== 1) throw httpError(409, "候选卡状态已变化");

    if (audit) {
      recordPwExecEvent(db, {
        eventType: "confirm",
        instructionText: audit.instructionText,
        instructionMessageId: audit.instructionMessageId,
        betId,
        payloadJson: JSON.stringify({ cardId, betId, overrides }),
      });
    } else {
      recordPwEvent(db, {
        kind: "manual_event",
        eventType: "confirm",
        actor: "human",
        betId,
        payloadJson: JSON.stringify({ cardId, betId, overrides }),
      });
    }
    return getPwBet(db, betId)!;
  });
}

/**
 * 否：pending 候选卡 → 'rejected' + pw_runs reject 留痕（reason 可空，进 payload）。
 * 卡非 pending（含不存在）→ 409；流转与留痕同事务，不可逆。
 * TASK-PW-25：传入 audit 时改走 recordPwExecEvent 合成一条 ai_exec(reject) 账。
 */
export function rejectPwSieveCard(
  db: DatabaseSync,
  cardId: string,
  reason?: string,
  audit?: PwContentBetAudit,
): void {
  inTransaction(db, () => {
    const card = getCard(db, cardId);
    if (!card || card.status !== "pending") {
      throw httpError(409, "候选卡不存在或不是 pending 态");
    }
    const updated = db.prepare(`
      UPDATE pw_sieve_cards SET status = 'rejected' WHERE id = ? AND status = 'pending'
    `).run(cardId);
    if (updated.changes !== 1) throw httpError(409, "候选卡状态已变化");
    if (audit) {
      recordPwExecEvent(db, {
        eventType: "reject",
        instructionText: audit.instructionText,
        instructionMessageId: audit.instructionMessageId,
        payloadJson: JSON.stringify({ cardId, reason: reason ?? null }),
      });
    } else {
      recordPwEvent(db, {
        kind: "manual_event",
        eventType: "reject",
        actor: "human",
        payloadJson: JSON.stringify({ cardId, reason: reason ?? null }),
      });
    }
  });
}

/**
 * TASK-PW-25：全否——事务内把全部 pending 候选卡置 'rejected'，返回被拒 cardId 数组。
 * 0 张时正常返回空数组、不落账不报错。自记账一条（audit 走 exec/reject，缺省 manual_event/human）。
 */
export function rejectAllPendingPwSieveCards(
  db: DatabaseSync,
  reason?: string,
  audit?: PwContentBetAudit,
): string[] {
  return inTransaction(db, () => {
    const pending = db.prepare(`
      SELECT id FROM pw_sieve_cards WHERE status = 'pending' ORDER BY created_at, id
    `).all() as Array<{ id: string }>;
    const cardIds = pending.map((row) => row.id);
    if (cardIds.length === 0) return cardIds;
    const placeholders = cardIds.map(() => "?").join(", ");
    const updated = db.prepare(`
      UPDATE pw_sieve_cards SET status = 'rejected'
      WHERE id IN (${placeholders}) AND status = 'pending'
    `).run(...cardIds);
    if (Number(updated.changes) !== cardIds.length) throw httpError(409, "候选卡状态已变化");
    if (audit) {
      recordPwExecEvent(db, {
        eventType: "reject",
        instructionText: audit.instructionText,
        instructionMessageId: audit.instructionMessageId,
        payloadJson: JSON.stringify({ cardIds, reason: reason ?? null }),
      });
    } else {
      recordPwEvent(db, {
        kind: "manual_event",
        eventType: "reject",
        actor: "human",
        payloadJson: JSON.stringify({ cardIds, reason: reason ?? null }),
      });
    }
    return cardIds;
  });
}

/**
 * TASK-PW-25：冲正键——撤销一次挑卡（候选卡唯一回退口，常规回退仍 deny）。
 * 事务内：押注必须 kind='content' 且 status='pending' 且 source_card_id 非空（否则 409）；
 * 押注 status→'void'；来源候选卡必须 picked/edited（否则 409）→'pending'。
 * 自记账一条 undo（audit 走 exec/undo，缺省 manual_event/human）。
 */
export function unpickPwContentBet(
  db: DatabaseSync,
  betId: string,
  audit?: PwContentBetAudit,
): PwBetRow {
  return inTransaction(db, () => {
    const bet = getPwBet(db, betId);
    if (!bet) throw httpError(409, "押注不存在或不是 content 押注");
    if (bet.kind !== "content") throw httpError(409, "仅 content 押注可撤销挑卡");
    if (bet.status !== "pending") throw httpError(409, "仅 pending 押注可撤销挑卡");
    if (!bet.source_card_id) throw httpError(409, "押注无来源候选卡");
    const card = getCard(db, bet.source_card_id);
    if (!card || (card.status !== "picked" && card.status !== "edited")) {
      throw httpError(409, "来源候选卡不在 picked/edited 态");
    }
    db.prepare("UPDATE pw_bets SET status = 'void' WHERE id = ?").run(betId);
    const updated = db.prepare(`
      UPDATE pw_sieve_cards SET status = 'pending'
      WHERE id = ? AND status IN ('picked', 'edited')
    `).run(bet.source_card_id);
    if (updated.changes !== 1) throw httpError(409, "候选卡状态已变化");
    if (audit) {
      recordPwExecEvent(db, {
        eventType: "undo",
        instructionText: audit.instructionText,
        instructionMessageId: audit.instructionMessageId,
        betId,
        payloadJson: JSON.stringify({ betId, cardId: bet.source_card_id }),
      });
    } else {
      recordPwEvent(db, {
        kind: "manual_event",
        eventType: "undo",
        actor: "human",
        betId,
        payloadJson: JSON.stringify({ betId, cardId: bet.source_card_id }),
      });
    }
    return getPwBet(db, betId)!;
  });
}

/** kind='content' 押注列表（含 source_card_id 联查候选卡 quote）。 */
export function listContentBets(db: DatabaseSync): ContentBetRow[] {
  // TASK-PW-22：作废（void）不进列表——rail/大屏只看活着的押注。
  return db.prepare(`
    SELECT b.*, c.quote_text
    FROM pw_bets b
    LEFT JOIN pw_sieve_cards c ON c.id = b.source_card_id
    WHERE b.kind = 'content' AND b.status != 'void'
    ORDER BY b.created_at, b.id
  `).all() as ContentBetRow[];
}

/**
 * TASK-PW-27：菜号牌——在途内容押注展示序（对话「注 N」 ↔ 协作台 rail 徽标同源）。
 * 规则：pending 优先，其余按看结果日升序（无日期殿后），created_at、id 兜底。
 * 前端 Collab.tsx rail 用同一规则排序（两边注释互指，改动须同步）。
 */
export function sortContentBetsForDisplay<
  T extends { status: string; checkout_date: string | null; created_at: string; id: string },
>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    if ((a.status === "pending") !== (b.status === "pending")) return a.status === "pending" ? -1 : 1;
    return (a.checkout_date ?? "9999").localeCompare(b.checkout_date ?? "9999")
      || a.created_at.localeCompare(b.created_at)
      || a.id.localeCompare(b.id);
  });
}
