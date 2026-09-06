/**
 * 简报 21 · 任务二/三：成熟度总账与双账度量测试。
 * 内存库自包含：pw_bets + pw_draft_events + pw_data_docs + pw_connections +
 * pw_verdicts + pw_corpus_docs。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createPwBet, ensurePwBetTables } from "./pw-bets.ts";
import { ensurePwDraftTables } from "./pw-drafts.ts";
import { ensurePwDataDocTables } from "./pw-data-docs.ts";
import { BILIBILI_PLATFORM, ensurePwConnectionTables } from "./pw-connections.ts";
import { ensurePwVerdictTables } from "./pw-verdicts.ts";
import { ensurePwCorpusTables } from "./pw-corpus.ts";
import {
  getPwBetLedger,
  getPwHealthAccounts,
} from "./pw-bet-health.ts";

const NOW = "2026-08-15T00:00:00.000Z";
const TODAY = "2026-08-15";

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwBetTables(db);
  ensurePwDraftTables(db);
  ensurePwDataDocTables(db);
  ensurePwConnectionTables(db);
  ensurePwVerdictTables(db);
  ensurePwCorpusTables(db);
  return db;
}

let seq = 0;
/** 直插 pending 押注（含指标缺失等非法形态——createPwBet 会拦，这里模拟存量脏数据）。 */
function seedPending(
  db: DatabaseSync,
  input: {
    title?: string;
    checkoutDate: string | null;
    metric?: string | null;
    metricTarget?: string | null;
    dataSourcePlan?: string | null;
    dataDocs?: number;
    confidence?: number | null;
    created?: string;
  },
): string {
  seq += 1;
  const id = `bet-${seq}`;
  const metric = input.metric === undefined ? "播放量" : input.metric;
  const metricTarget = input.metricTarget === undefined ? "> 1000" : input.metricTarget;
  const createdAt = input.created ?? NOW;
  db.prepare(`
    INSERT INTO pw_bets(
      id, title, thesis, metric, metric_target, confidence, data_source_plan,
      checkout_date, status, gold_refs_json, created_from, created_at,
      settled_verdict_id, kind, source_card_id
    ) VALUES(?, ?, '假设', ?, ?, ?, ?, ?, 'pending', '[]', 'manual', ?, NULL, 'verdict', NULL)
  `).run(
    id,
    input.title ?? `押注-${seq}`,
    metric,
    metricTarget,
    input.confidence ?? null,
    input.dataSourcePlan ?? "B站后台",
    input.checkoutDate ?? null,
    createdAt,
  );
  if (input.dataDocs) {
    for (let index = 0; index < input.dataDocs; index += 1) {
      db.prepare(`
        INSERT INTO pw_data_docs(
          id, bet_id, artifact_id, platform, collected_at, method, metrics_json,
          raw_ref, source_hash, version, frozen, created_at
        ) VALUES(?, ?, NULL, 'B站', ?, 'sync', '{}', NULL, NULL, 1, 0, ?)
      `).run(`doc-${seq}-${index}`, id, "2026-08-14T00:00:00.000Z", "2026-08-14T00:00:00.000Z");
    }
  }
  return id;
}

function seedDraftConfirmed(
  db: DatabaseSync,
  checkoutDate: string,
): string {
  const bet = createPwBet(db, {
    title: "草稿转正押注",
    thesis: "假设",
    status: "draft",
    metric: "收藏数",
    metric_target: "> 100",
    data_source_plan: "B站后台",
    checkout_date: checkoutDate,
  });
  db.prepare(`
    INSERT INTO pw_draft_events(id, bet_id, action, draft_hash, actor, reason, created_at)
    VALUES(?, ?, 'confirm', 'hash', 'human', NULL, ?)
  `).run(`de-${seq++}`, bet.id, "2026-08-10T08:00:00.000Z");
  db.prepare("UPDATE pw_bets SET status = 'pending' WHERE id = ?").run(bet.id);
  return bet.id;
}

function seedVerdict(
  db: DatabaseSync,
  betId: string,
  outcome: "gold" | "tomb" | "void",
  decidedAt: string,
  confidence: number | null = null,
): void {
  db.prepare(`
    INSERT INTO pw_verdicts(
      id, bet_id, outcome, lesson, cause_of_death, evidence_doc_ids_json,
      confidence_snapshot, decided_by, decided_at, created_at
    ) VALUES(?, ?, ?, ?, ?, '[]', ?, 'human', ?, ?)
  `).run(`v-${seq++}`, betId, outcome, outcome === "gold" ? "教训" : null, outcome === "tomb" ? "死因" : null, confidence, decidedAt, decidedAt);
}

function seedCorpus(db: DatabaseSync, status: string): void {
  seq += 1;
  db.prepare(`
    INSERT INTO pw_corpus_docs(
      id, bvid, title, up_name, kinds, status, path, sha256, video_stat_json,
      comment_count, authorized_by, error, fetched_at, created_at
    ) VALUES(?, ?, NULL, NULL, 'video,comments', ?, NULL, NULL, NULL, NULL, 'human', NULL, NULL, ?)
  `).run(`corpus-${seq}`, `BV${String(seq).padStart(10, "0")}`, status, NOW);
}

test("1. 空库：ledger 空行，health 全 0/空/null", () => {
  const db = database();
  try {
    assert.deepEqual(getPwBetLedger(db, { now: NOW }).rows, []);
    const accounts = getPwHealthAccounts(db, { now: NOW });
    assert.deepEqual(accounts, {
      epistemic: { validSettlements: 0, byCohort: [] },
      operational: {
        dueReadyRate: null,
        validSettlementRate: null,
        avgSettleLatencyDays: null,
        settleDebtDays: 0,
        avoidableVoidRate: null,
        autoFeedSuccessRate: null,
        recurringVoidCauses: [],
      },
    });
  } finally {
    db.close();
  }
});

test("2. ledger：maturity 分类与排序（overdue→due_missing_data→metric_invalid→due_ready→not_due）", () => {
  const db = database();
  try {
    seedPending(db, { checkoutDate: "2026-08-12", dataDocs: 1 });          // overdue
    seedPending(db, { checkoutDate: "2026-08-12", dataDocs: 0 });          // due_missing_data
    seedPending(db, { checkoutDate: "2026-08-12", metric: null, metricTarget: null, dataDocs: 1 }); // metric_invalid
    seedPending(db, { checkoutDate: TODAY, dataDocs: 1 });                 // due_ready
    seedPending(db, { checkoutDate: "2026-08-20" });                       // not_due
    seedPending(db, { checkoutDate: null });                               // not_due（缺失殿后）

    const rows = getPwBetLedger(db, { now: NOW }).rows;
    assert.deepEqual(rows.map((row) => row.maturity), [
      "overdue",
      "due_missing_data",
      "metric_invalid",
      "due_ready",
      "not_due",
      "not_due",
    ]);
  } finally {
    db.close();
  }
});

test("3. ledger：行字段齐全（activatedAt/revisionCount/nextForcedEvent/dataSource 口径）", () => {
  const db = database();
  try {
    const direct = seedPending(db, {
      title: "直接落 pending",
      checkoutDate: "2026-08-20",
      dataDocs: 2,
      confidence: 70,
    });
    const confirmed = seedDraftConfirmed(db, "2026-08-12");
    db.prepare(`
      INSERT INTO pw_data_docs(
        id, bet_id, artifact_id, platform, collected_at, method, metrics_json,
        raw_ref, source_hash, version, frozen, created_at
      ) VALUES('doc-confirmed', ?, NULL, 'B站', '2026-08-13T00:00:00.000Z', 'sync', '{}', NULL, NULL, 1, 0, ?)
    `).run(confirmed, "2026-08-13T00:00:00.000Z");

    const rows = getPwBetLedger(db, { now: NOW }).rows;
    assert.equal(rows.length, 2);

    const directRow = rows.find((row) => row.betId === direct)!;
    assert.equal(directRow.title, "直接落 pending");
    assert.equal(directRow.betType, "verdict");
    assert.equal(directRow.activatedAt, (db.prepare(
      "SELECT created_at FROM pw_bets WHERE id = ?",
    ).get(direct) as { created_at: string }).created_at);
    assert.equal(directRow.dueAt, "2026-08-20");
    assert.equal(directRow.confidence, 70);
    assert.equal(directRow.metricSummary, "播放量（目标 > 1000）");
    assert.equal(directRow.dataSource.kind, "auto");
    assert.equal(directRow.dataSource.status, "unbound");
    assert.equal(directRow.dataSource.lastDataAt, "2026-08-14T00:00:00.000Z");
    assert.equal(directRow.maturity, "not_due");
    assert.equal(directRow.revisionCount, 2);
    assert.equal(directRow.nextForcedEvent, "2026-08-20");

    const confirmedRow = rows.find((row) => row.betId === confirmed)!;
    assert.equal(confirmedRow.activatedAt, "2026-08-10T08:00:00.000Z", "转正押注取确认事件时间");
    assert.equal(confirmedRow.maturity, "overdue");
    assert.equal(confirmedRow.nextForcedEvent, null, "已逾期押注的强制事件已过，返回 null");
  } finally {
    db.close();
  }
});

test("4. health：认识论账只计有效结账，byCohort 按决定月份带置信度", () => {
  const db = database();
  try {
    const a = seedPending(db, { checkoutDate: "2026-08-10", dataDocs: 1 });
    const b = seedPending(db, { checkoutDate: "2026-08-10", dataDocs: 1 });
    const c = seedPending(db, { checkoutDate: "2026-08-10", dataDocs: 1 });
    seedVerdict(db, a, "gold", "2026-08-12T10:00:00.000Z", 70);
    seedVerdict(db, b, "tomb", "2026-08-13T10:00:00.000Z", null);
    seedVerdict(db, c, "void", "2026-08-14T10:00:00.000Z");
    const accounts = getPwHealthAccounts(db, { now: NOW });
    assert.equal(accounts.epistemic.validSettlements, 2);
    assert.deepEqual(accounts.epistemic.byCohort, [
      { cohort: "2026-08", validSettlements: 2, withConfidence: 1 },
    ]);
  } finally {
    db.close();
  }
});

test("5. health：运行账各率（dueReady/validSettlement/延迟/欠账/可避免作废/自动供血）", () => {
  const db = database();
  try {
    seedConnection(db, "active");
    // 在途到期 4 笔：2 就绪可结（overdue）、1 缺数据（due_missing_data）、1 指标失效
    seedPending(db, { checkoutDate: "2026-08-10", dataDocs: 1 });        // ready
    seedPending(db, { checkoutDate: "2026-08-12", dataDocs: 1 });        // ready（欠 3 天）
    seedPending(db, { checkoutDate: "2026-08-13", dataDocs: 0 });        // 缺数据（欠 2 天）
    seedPending(db, { checkoutDate: "2026-08-11", metric: null, metricTarget: null, dataDocs: 1 }); // 指标失效（欠 4 天）
    // 结账：gold 迟到 3 天、tomb 迟到 1 天；两个 void（一个可避免：无数据；一个不可判：有数据有指标）
    const ready1 = seedPending(db, { checkoutDate: "2026-08-01", dataDocs: 1 });
    const ready2 = seedPending(db, { checkoutDate: "2026-08-01", dataDocs: 1 });
    const voidAvoidable = seedPending(db, { checkoutDate: "2026-08-01", dataDocs: 0 });
    const voidOther = seedPending(db, { checkoutDate: "2026-08-01", dataDocs: 1 });
    seedVerdict(db, ready1, "gold", "2026-08-04T00:00:00.000Z", 80);
    seedVerdict(db, ready2, "tomb", "2026-08-02T00:00:00.000Z", null);
    seedVerdict(db, voidAvoidable, "void", "2026-08-05T00:00:00.000Z");
    seedVerdict(db, voidOther, "void", "2026-08-06T00:00:00.000Z");
    // 结账后押注状态落库（模拟 settlePwBet 行为）：gold/tomb → settled，void → void
    for (const id of [ready1, ready2]) {
      db.prepare("UPDATE pw_bets SET status = 'settled' WHERE id = ?").run(id);
    }
    for (const id of [voidAvoidable, voidOther]) {
      db.prepare("UPDATE pw_bets SET status = 'void' WHERE id = ?").run(id);
    }
    // 自动供血：done 2、failed 1、needs_human 1 → 50%
    seedCorpus(db, "done");
    seedCorpus(db, "done");
    seedCorpus(db, "failed");
    seedCorpus(db, "needs_human");

    const accounts = getPwHealthAccounts(db, { now: NOW });
    assert.equal(accounts.epistemic.validSettlements, 2);
    assert.equal(accounts.operational.dueReadyRate, 0.5, "4 笔到期，2 笔就绪");
    assert.equal(accounts.operational.validSettlementRate, 0.5, "4 判决，2 有效");
    assert.equal(accounts.operational.avgSettleLatencyDays, 2, "gold 3 天 + tomb 1 天 平均 2");
    assert.equal(accounts.operational.settleDebtDays, 14, "欠账：5+3+2+4=14");
    assert.equal(accounts.operational.avoidableVoidRate, 0.5, "2 作废，1 可避免");
    assert.equal(accounts.operational.autoFeedSuccessRate, 0.5, "done 2 / (2+1+1)");
    assert.deepEqual(accounts.operational.recurringVoidCauses, [
      { cause: "其他", count: 1 },
      { cause: "无回流数据", count: 1 },
    ]);
  } finally {
    db.close();
  }
});

test("6. health：无作废/无自动供血终态 → null/空，不编数", () => {
  const db = database();
  try {
    seedPending(db, { checkoutDate: "2026-08-20", dataDocs: 1 });
    const accounts = getPwHealthAccounts(db, { now: NOW });
    assert.equal(accounts.operational.avoidableVoidRate, null);
    assert.equal(accounts.operational.autoFeedSuccessRate, null);
    assert.deepEqual(accounts.operational.recurringVoidCauses, []);
  } finally {
    db.close();
  }
});

function seedConnection(
  db: DatabaseSync,
  status: "active" | "needs_human" | "paused",
): void {
  db.prepare(`
    INSERT INTO pw_connections(
      id, platform, account_label, auth_ref, status, last_sync_at, risk_events_json, created_at
    ) VALUES('conn-1', ?, NULL, NULL, ?, ?, '[]', ?)
  `).run(BILIBILI_PLATFORM, status, "2026-08-10T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
}
