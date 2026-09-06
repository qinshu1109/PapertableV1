/**
 * 简报 21 · 任务二/三：押注成熟度总账（ledger）与双账度量（health-accounts）。
 *
 * 全部从现有表只读聚合，零写、不建表（守门②）；字段缺数据给 null，不编造。
 *
 * ── 任务二：GET /api/pw/bets/ledger ──────────────────────────────
 * 只列在途（status='pending'）押注。maturity 口径：
 * - not_due           未到期（checkout_date 缺失或晚于今天）
 * - metric_invalid    已到期但指标失效（metric 或 metric_target 缺失，判定不了）
 * - due_missing_data  已到期、指标可判，但无回流数据文档
 * - overdue           已到期（早于今天）、指标可判、有数据 → 可结未结，逾期
 * - due_ready         今天到期、指标可判、有数据 → 今天就绪可结（还没开始欠账）
 * 排序：overdue → due_missing_data → metric_invalid → due_ready → not_due，
 * 同成熟度内结账日近的先（缺失殿后）。
 *
 * ── 任务三：GET /api/pw/health-accounts ─────────────────────────
 * 口径（研究报告第 6 节方向：认识论账只计有效结账；运行账计逾期/可避免作废/
 * 数据故障/自动供血；算不出的给 null）：
 * - epistemic.validSettlements        gold+tomb 判决数（有效结账）
 * - epistemic.byCohort                有效结账按 decided_at 月份（YYYY-MM）分队列，
 *                                     带 withConfidence（快照了置信度的次数）
 * - operational.dueReadyRate          在途已到期押注中「数据+指标就绪可结」占比
 *                                     （overdue+due_ready）/ 全部已到期；无到期押注 → null
 * - operational.validSettlementRate   有效结账 / 全部判决；无判决 → null
 * - operational.avgSettleLatencyDays  有效结账从结账日到裁决日的平均天数；无可算 → null
 * - operational.settleDebtDays        在途逾期押注的累计欠账天数（今天-结账日）；无逾期 → 0
 * - operational.avoidableVoidRate     作废中「闸门可避免」占比（无回流数据 / 指标失效 /
 *                                     自动源未绑定或停用）——即激活前闸门本应拦下的作废；
 *                                     无作废 → null
 * - operational.autoFeedSuccessRate   自动供血成功率 = 语料抓取 done /
 *                                     (done+failed+needs_human)（pw_corpus_docs 有持久化终态）；
 *                                     B站同步失败不落库（errors 只回响应），无法纳入分母 →
 *                                     该口径只覆盖可计量的抓取通路；无终态语料 → null
 * - operational.recurringVoidCauses   作废押注按根因聚合（无回流数据 / 指标缺失 /
 *                                     数据源未绑定或停用 / 其他）
 */
import type { DatabaseSync } from "node:sqlite";
import { getPwDataSourceStatus } from "./pw-bet-gate.ts";

export type PwBetMaturity =
  | "not_due"
  | "due_ready"
  | "due_missing_data"
  | "metric_invalid"
  | "overdue";

export type PwLedgerRow = {
  betId: string;
  title: string;
  betType: string;
  activatedAt: string | null;
  dueAt: string | null;
  confidence: number | null;
  metricSummary: string | null;
  dataSource: { kind: "auto" | "manual"; status: string; lastDataAt: string | null };
  maturity: PwBetMaturity;
  revisionCount: number;
  nextForcedEvent: string | null;
};

export type PwBetLedger = { rows: PwLedgerRow[] };

export type PwHealthAccounts = {
  epistemic: {
    validSettlements: number;
    byCohort: Array<{ cohort: string; validSettlements: number; withConfidence: number }>;
  };
  operational: {
    dueReadyRate: number | null;
    validSettlementRate: number | null;
    avgSettleLatencyDays: number | null;
    settleDebtDays: number;
    avoidableVoidRate: number | null;
    autoFeedSuccessRate: number | null;
    recurringVoidCauses: Array<{ cause: string; count: number }>;
  };
};

export type PwBetHealthOptions = {
  /** 基准时刻（测试注入）：ISO 串或 Date；缺省当前时刻。 */
  now?: string | Date;
};

const MATURITY_ORDER: Record<PwBetMaturity, number> = {
  overdue: 0,
  due_missing_data: 1,
  metric_invalid: 2,
  due_ready: 3,
  not_due: 4,
};

type PendingBetRow = {
  id: string;
  title: string;
  kind: string;
  metric: string | null;
  metric_target: string | null;
  confidence: number | null;
  data_source_plan: string | null;
  checkout_date: string | null;
  created_at: string;
};

/** ── 任务二：成熟度总账（只列在途 pending 押注）── */
export function getPwBetLedger(db: DatabaseSync, options: PwBetHealthOptions = {}): PwBetLedger {
  const today = dayOf(options.now);
  const bets = db.prepare(`
    SELECT id, title, kind, metric, metric_target, confidence, data_source_plan,
           checkout_date, created_at
    FROM pw_bets
    WHERE status = 'pending'
  `).all() as PendingBetRow[];

  const rows = bets.map((bet) => {
    const metricReady = Boolean(bet.metric && bet.metric_target);
    const dataCount = Number(
      (db.prepare("SELECT COUNT(*) AS n FROM pw_data_docs WHERE bet_id = ?").get(bet.id) as { n: number }).n,
    );
    const hasData = dataCount > 0;
    const due = bet.checkout_date !== null && bet.checkout_date <= today;
    const maturity: PwBetMaturity = !due
      ? "not_due"
      : !metricReady
        ? "metric_invalid"
        : !hasData
          ? "due_missing_data"
          : bet.checkout_date! < today
            ? "overdue"
            : "due_ready";

    const sourceStatus = getPwDataSourceStatus(db, bet.data_source_plan);
    const lastDataAt = (db.prepare(
      "SELECT MAX(collected_at) AS at FROM pw_data_docs WHERE bet_id = ?",
    ).get(bet.id) as { at: string | null }).at ?? null;

    return {
      betId: bet.id,
      title: bet.title,
      betType: bet.kind,
      activatedAt: activatedAtOf(db, bet),
      dueAt: bet.checkout_date,
      confidence: bet.confidence,
      metricSummary: metricSummaryOf(bet),
      dataSource: {
        kind: sourceStatus.kind,
        status: sourceStatus.status,
        lastDataAt,
      },
      maturity,
      revisionCount: dataCount,
      nextForcedEvent: bet.checkout_date && bet.checkout_date >= today ? bet.checkout_date : null,
    };
  });

  rows.sort((a, b) =>
    MATURITY_ORDER[a.maturity] - MATURITY_ORDER[b.maturity]
    || (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999")
    || a.betId.localeCompare(b.betId),
  );
  return { rows };
}

/** ── 任务三：双账度量 ── */
export function getPwHealthAccounts(db: DatabaseSync, options: PwBetHealthOptions = {}): PwHealthAccounts {
  const today = dayOf(options.now);

  // 认识论账：只计有效结账（gold + tomb）
  const verdictTotals = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN outcome IN ('gold','tomb') THEN 1 ELSE 0 END) AS valid,
      SUM(CASE WHEN outcome = 'void' THEN 1 ELSE 0 END) AS voids
    FROM pw_verdicts
  `).get() as { total: number; valid: number; voids: number };
  const totalVerdicts = Number(verdictTotals.total);
  const validSettlements = Number(verdictTotals.valid);
  const voidCount = Number(verdictTotals.voids);

  const cohortRows = db.prepare(`
    SELECT substr(decided_at, 1, 7) AS cohort,
           COUNT(*) AS n,
           SUM(CASE WHEN confidence_snapshot IS NOT NULL THEN 1 ELSE 0 END) AS with_conf
    FROM pw_verdicts
    WHERE outcome IN ('gold','tomb')
    GROUP BY cohort
    ORDER BY cohort
  `).all() as Array<{ cohort: string; n: number; with_conf: number }>;
  const byCohort = cohortRows.map((row) => ({
    cohort: row.cohort,
    validSettlements: Number(row.n),
    withConfidence: Number(row.with_conf),
  }));

  // 运行账：逾期 / 可避免作废 / 数据故障 / 自动供血
  const duePending = db.prepare(`
    SELECT id, metric, metric_target, checkout_date, data_source_plan
    FROM pw_bets
    WHERE status = 'pending' AND checkout_date IS NOT NULL AND checkout_date <= ?
  `).all(today) as Array<{
    id: string;
    metric: string | null;
    metric_target: string | null;
    checkout_date: string;
    data_source_plan: string | null;
  }>;

  let readyDue = 0;
  let debtDays = 0;
  for (const bet of duePending) {
    const metricReady = Boolean(bet.metric && bet.metric_target);
    const hasData = Number(
      (db.prepare("SELECT COUNT(*) AS n FROM pw_data_docs WHERE bet_id = ?").get(bet.id) as { n: number }).n,
    ) > 0;
    if (metricReady && hasData) readyDue += 1;
    if (bet.checkout_date < today) {
      debtDays += daysBetween(bet.checkout_date, today);
    }
  }
  const dueReadyRate = duePending.length === 0 ? null : round2(readyDue / duePending.length);

  const validSettlementRate = totalVerdicts === 0 ? null : round2(validSettlements / totalVerdicts);

  // 平均结账延迟：有效结账（gold/tomb）的 decided_at − 押注 checkout_date（天）
  const latencyRows = db.prepare(`
    SELECT v.decided_at, b.checkout_date
    FROM pw_verdicts v
    JOIN pw_bets b ON b.id = v.bet_id
    WHERE v.outcome IN ('gold','tomb') AND b.checkout_date IS NOT NULL
  `).all() as Array<{ decided_at: string; checkout_date: string }>;
  const latencies: number[] = [];
  for (const row of latencyRows) {
    const days = daysBetween(row.checkout_date, row.decided_at.slice(0, 10));
    if (days >= 0) latencies.push(days);
  }
  const avgSettleLatencyDays = latencies.length === 0
    ? null
    : round2(latencies.reduce((sum, days) => sum + days, 0) / latencies.length);

  // 可避免作废：作废押注中「闸门本应拦下」的（无回流数据 / 指标失效 / 自动源未绑定或停用）
  const voidBets = db.prepare(`
    SELECT b.id, b.metric, b.metric_target, b.data_source_plan
    FROM pw_verdicts v
    JOIN pw_bets b ON b.id = v.bet_id
    WHERE v.outcome = 'void'
  `).all() as Array<{
    id: string;
    metric: string | null;
    metric_target: string | null;
    data_source_plan: string | null;
  }>;

  const causeCounts = new Map<string, number>();
  let avoidableVoids = 0;
  for (const bet of voidBets) {
    const cause = voidCauseOf(db, bet);
    causeCounts.set(cause, (causeCounts.get(cause) ?? 0) + 1);
    if (cause !== "其他") avoidableVoids += 1;
  }
  const avoidableVoidRate = voidCount === 0 ? null : round2(avoidableVoids / voidCount);
  const recurringVoidCauses = [...causeCounts.entries()]
    .map(([cause, count]) => ({ cause, count }))
    .sort((a, b) => b.count - a.count || a.cause.localeCompare(b.cause));

  // 自动供血成功率：语料抓取通路（有持久化终态）；B站同步失败不落库，无法纳入
  const corpusFeed = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
      SUM(CASE WHEN status IN ('failed','needs_human') THEN 1 ELSE 0 END) AS failed
    FROM pw_corpus_docs
  `).get() as { done: number; failed: number };
  const feedDone = Number(corpusFeed.done);
  const feedFailed = Number(corpusFeed.failed);
  const autoFeedSuccessRate = feedDone + feedFailed === 0
    ? null
    : round2(feedDone / (feedDone + feedFailed));

  return {
    epistemic: { validSettlements, byCohort },
    operational: {
      dueReadyRate,
      validSettlementRate,
      avgSettleLatencyDays,
      settleDebtDays: debtDays,
      avoidableVoidRate,
      autoFeedSuccessRate,
      recurringVoidCauses,
    },
  };
}

/** 激活时间：draft 转正押注取 pw_draft_events(confirm) 时间；直接落 pending 的取 created_at。 */
function activatedAtOf(db: DatabaseSync, bet: PendingBetRow): string | null {
  const confirm = db.prepare(`
    SELECT created_at FROM pw_draft_events
    WHERE bet_id = ? AND action = 'confirm'
    ORDER BY created_at, rowid
    LIMIT 1
  `).get(bet.id) as { created_at: string } | undefined;
  return confirm?.created_at ?? bet.created_at ?? null;
}

function metricSummaryOf(bet: PendingBetRow): string | null {
  if (!bet.metric) return null;
  return bet.metric_target ? `${bet.metric}（目标 ${bet.metric_target}）` : bet.metric;
}

/** 作废押注根因（与 avoidableVoidRate 同口径：前三类可避免，其他不可判）。 */
function voidCauseOf(
  db: DatabaseSync,
  bet: { id: string; metric: string | null; metric_target: string | null; data_source_plan: string | null },
): string {
  const hasData = Number(
    (db.prepare("SELECT COUNT(*) AS n FROM pw_data_docs WHERE bet_id = ?").get(bet.id) as { n: number }).n,
  ) > 0;
  if (!hasData) return "无回流数据";
  if (!bet.metric || !bet.metric_target) return "指标缺失";
  const source = getPwDataSourceStatus(db, bet.data_source_plan);
  if (source.status === "unbound" || source.status === "paused") return "数据源未绑定或停用";
  return "其他";
}

/** 两个 yyyy-mm-dd 之间的整天数（b - a）。 */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function dayOf(value: string | Date | undefined): string {
  if (value === undefined) return new Date().toISOString().slice(0, 10);
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}
