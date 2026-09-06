/**
 * 简报 21 · 任务一：激活前数据就绪闸门测试。
 * 内存库自包含：pw_bets + pw_draft_events + pw_data_docs + pw_connections。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createPwBet, ensurePwBetTables } from "./pw-bets.ts";
import { ensurePwDraftTables } from "./pw-drafts.ts";
import { ensurePwDataDocTables } from "./pw-data-docs.ts";
import { BILIBILI_PLATFORM, ensurePwConnectionTables } from "./pw-connections.ts";
import {
  activatePwBet,
  getPwDataSourceStatus,
  preflightPwBetActivation,
  type PwPreflight,
} from "./pw-bet-gate.ts";

const NOW = "2026-08-15T00:00:00.000Z";

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwBetTables(db);
  ensurePwDraftTables(db);
  ensurePwDataDocTables(db);
  ensurePwConnectionTables(db);
  return db;
}

function seedConnection(
  db: DatabaseSync,
  status: "active" | "needs_human" | "paused",
  lastSyncAt: string | null = "2026-08-10T00:00:00.000Z",
): void {
  db.prepare(`
    INSERT INTO pw_connections(
      id, platform, account_label, auth_ref, status, last_sync_at, risk_events_json, created_at
    ) VALUES('conn-1', ?, NULL, NULL, ?, ?, '[]', '2026-08-01T00:00:00.000Z')
    ON CONFLICT(platform) DO UPDATE SET status = excluded.status, last_sync_at = excluded.last_sync_at
  `).run(BILIBILI_PLATFORM, status, lastSyncAt);
}

let docSeq = 0;
function seedDataDoc(db: DatabaseSync, betId: string, collectedAt: string): void {
  docSeq += 1;
  db.prepare(`
    INSERT INTO pw_data_docs(
      id, bet_id, artifact_id, platform, collected_at, method, metrics_json,
      raw_ref, source_hash, version, frozen, created_at
    ) VALUES(?, ?, NULL, 'B站', ?, 'sync', '{"view":100}', NULL, NULL, 1, 0, ?)
  `).run(`doc-${docSeq}`, betId, collectedAt, collectedAt);
}

/** 三行齐备的草稿（B站自动源）。 */
function draftBilibili(db: DatabaseSync, overrides: Record<string, unknown> = {}): string {
  const bet = createPwBet(db, {
    title: "直播切片试水",
    thesis: "真实过程比教程更容易让观众追更",
    status: "draft",
    metric: "三期平均播放量",
    metric_target: "不低于 5000",
    data_source_plan: "B站创作中心",
    checkout_date: "2026-08-20",
    ...overrides,
  });
  return bet.id;
}

function checkResult(preflight: PwPreflight, name: string): string {
  return preflight.checks.find((check) => check.name === name)!.result;
}

test("1. 预检：押注不存在 → 404；非 draft 态 → 409", () => {
  const db = database();
  try {
    assert.throws(() => preflightPwBetActivation(db, "missing"), (error: unknown) =>
      (error as { status?: number }).status === 404);
    const pending = createPwBet(db, {
      title: "已在途",
      thesis: "假设",
      status: "pending",
      metric: "收藏数",
      data_source_plan: "私域群/评论区人工统计",
      checkout_date: "2026-08-20",
    });
    assert.throws(
      () => preflightPwBetActivation(db, pending.id, { now: NOW }),
      (error: unknown) => (error as { status?: number }).status === 409,
    );
  } finally {
    db.close();
  }
});

test("2. 自动源 active + 三行齐备 → 全 pass，pass=true", () => {
  const db = database();
  try {
    seedConnection(db, "active");
    const id = draftBilibili(db);
    seedDataDoc(db, id, "2026-08-14T00:00:00.000Z");
    const preflight = preflightPwBetActivation(db, id, { now: NOW });
    assert.equal(preflight.pass, true);
    assert.deepEqual(preflight.checks.map((check) => check.name), [
      "data_source",
      "metric",
      "checkout_date",
    ]);
    assert.ok(preflight.checks.every((check) => check.result === "pass"));
    assert.match(preflight.checks[0]!.detail, /试读到回流数据/);
    assert.match(preflight.checks[0]!.detail, /active/);
  } finally {
    db.close();
  }
});

test("3. 手动录入源 → data_source=needs_human，但不拦激活（pass=true）", () => {
  const db = database();
  try {
    const id = draftBilibili(db, { data_source_plan: "私域群/评论区人工统计" });
    const preflight = preflightPwBetActivation(db, id, { now: NOW });
    assert.equal(preflight.pass, true);
    assert.equal(checkResult(preflight, "data_source"), "needs_human");
    assert.match(preflight.checks[0]!.detail, /已确认走手动录入/);
  } finally {
    db.close();
  }
});

test("4. 指标失效：缺 metric 或缺 metric_target → fail", () => {
  const db = database();
  try {
    seedConnection(db, "active");
    const noMetric = draftBilibili(db, { metric: null, metric_target: null });
    const noMetricTarget = draftBilibili(db, { metric_target: null });
    const a = preflightPwBetActivation(db, noMetric, { now: NOW });
    assert.equal(a.pass, false);
    assert.equal(checkResult(a, "metric"), "fail");
    const b = preflightPwBetActivation(db, noMetricTarget, { now: NOW });
    assert.equal(b.pass, false);
    assert.match(b.checks.find((check) => check.name === "metric")!.detail, /判定规则/);
  } finally {
    db.close();
  }
});

test("5. 结账日：缺失或过去 → fail", () => {
  const db = database();
  try {
    seedConnection(db, "active");
    const noDate = draftBilibili(db, { checkout_date: null });
    const past = draftBilibili(db, { checkout_date: "2026-08-14" });
    const a = preflightPwBetActivation(db, noDate, { now: NOW });
    assert.equal(checkResult(a, "checkout_date"), "fail");
    const b = preflightPwBetActivation(db, past, { now: NOW });
    assert.equal(b.pass, false);
    assert.match(b.checks.find((check) => check.name === "checkout_date")!.detail, /已是过去/);
  } finally {
    db.close();
  }
});

test("6. 自动源连接状态：未绑定/暂停 → fail；needs_human → needs_human 不拦", () => {
  const db = database();
  try {
    const unbound = draftBilibili(db);
    const a = preflightPwBetActivation(db, unbound, { now: NOW });
    assert.equal(a.pass, false);
    assert.equal(checkResult(a, "data_source"), "fail");
    assert.match(a.checks[0]!.detail, /未绑定/);

    seedConnection(db, "needs_human");
    const human = draftBilibili(db);
    const b = preflightPwBetActivation(db, human, { now: NOW });
    assert.equal(b.pass, true);
    assert.equal(checkResult(b, "data_source"), "needs_human");

    seedConnection(db, "paused");
    const paused = draftBilibili(db);
    const c = preflightPwBetActivation(db, paused, { now: NOW });
    assert.equal(c.pass, false);
    assert.equal(checkResult(c, "data_source"), "fail");
    assert.match(c.checks[0]!.detail, /暂停/);
  } finally {
    db.close();
  }
});

test("6b. 数据来源计划为空 → fail（不是 needs_human）", () => {
  const db = database();
  try {
    const bet = createPwBet(db, {
      title: "无数据源草稿",
      thesis: "假设",
      status: "draft",
      metric: "播放量",
      metric_target: ">1000",
      checkout_date: "2026-08-20",
    });
    const preflight = preflightPwBetActivation(db, bet.id, { now: NOW });
    assert.equal(preflight.pass, false);
    assert.equal(checkResult(preflight, "data_source"), "fail");
    assert.match(preflight.checks[0]!.detail, /为空/);
    assert.equal(getPwDataSourceStatus(db, null).status, "unbound");
    assert.equal(getPwDataSourceStatus(db, "  ").status, "unbound");
  } finally {
    db.close();
  }
});

test("7. 预检只读幂等：不产生任何写", () => {
  const db = database();
  try {
    seedConnection(db, "active");
    const id = draftBilibili(db);
    const before = db.prepare("SELECT COUNT(*) AS n FROM pw_draft_events").get() as { n: number };
    const betBefore = db.prepare("SELECT status FROM pw_bets WHERE id = ?").get(id) as { status: string };
    preflightPwBetActivation(db, id, { now: NOW });
    preflightPwBetActivation(db, id, { now: NOW });
    const after = db.prepare("SELECT COUNT(*) AS n FROM pw_draft_events").get() as { n: number };
    const betAfter = db.prepare("SELECT status FROM pw_bets WHERE id = ?").get(id) as { status: string };
    assert.equal(after.n, before.n);
    assert.equal(betAfter.status, betBefore.status);
    assert.equal(betAfter.status, "draft");
  } finally {
    db.close();
  }
});

test("8. activate：预检有 fail → 409（details 带失败清单），押注保持 draft", () => {
  const db = database();
  try {
    // 未绑定 B站 连接 → data_source fail
    const id = draftBilibili(db);
    assert.throws(
      () => activatePwBet(db, id, {}, { now: NOW }),
      (error: unknown) => {
        const e = error as { status?: number; details?: { checks?: PwPreflight["checks"]; pass?: boolean } };
        assert.equal(e.status, 409);
        assert.equal(e.details?.pass, false);
        assert.ok((e.details?.checks ?? []).some((check) => check.result === "fail"));
        return true;
      },
    );
    assert.equal(
      (db.prepare("SELECT status FROM pw_bets WHERE id = ?").get(id) as { status: string }).status,
      "draft",
      "fail 时不得写入任何状态",
    );
  } finally {
    db.close();
  }
});

test("9. activate：全 pass → draft→pending，draft_hash 与确认事件落库，响应带回预检", () => {
  const db = database();
  try {
    seedConnection(db, "active");
    const id = draftBilibili(db);
    const result = activatePwBet(db, id, {}, { now: NOW });
    assert.equal(result.bet.status, "pending");
    assert.equal(result.preflight.pass, true);
    assert.ok(result.bet.draft_hash);
    const events = db.prepare(
      "SELECT action FROM pw_draft_events WHERE bet_id = ?",
    ).all(id) as Array<{ action: string }>;
    assert.deepEqual(events.map((row) => row.action), ["confirm"]);
  } finally {
    db.close();
  }
});

test("10. activate：仅 needs_human（手动录入源）→ 仍激活，响应带回提示", () => {
  const db = database();
  try {
    const id = draftBilibili(db, { data_source_plan: "私域群/评论区人工统计" });
    const result = activatePwBet(db, id, {}, { now: NOW });
    assert.equal(result.bet.status, "pending");
    assert.equal(result.preflight.pass, true);
    assert.equal(checkResult(result.preflight, "data_source"), "needs_human");
  } finally {
    db.close();
  }
});

test("11. activate：edits 补齐缺口 → 按合并后状态过闸并激活", () => {
  const db = database();
  try {
    seedConnection(db, "active");
    // 草稿缺 metric/metric_target，activate 时用 edits 补齐
    const bet = createPwBet(db, {
      title: "草稿缺指标",
      thesis: "假设",
      status: "draft",
      data_source_plan: "B站创作中心",
      checkout_date: "2026-08-20",
    });
    const result = activatePwBet(db, bet.id, {
      metric: "播放量",
      metricTarget: "> 1万",
    }, { now: NOW });
    assert.equal(result.bet.status, "pending");
    assert.equal(result.bet.metric, "播放量");
    assert.equal(result.bet.metric_target, "> 1万");
    assert.equal(result.preflight.pass, true);
  } finally {
    db.close();
  }
});

test("12. getPwDataSourceStatus：manual/auto 各态映射", () => {
  const db = database();
  try {
    assert.deepEqual(
      { ...getPwDataSourceStatus(db, "私域群/评论区人工统计"), lastSyncAt: null, detail: "" },
      { kind: "manual", status: "manual", lastSyncAt: null, detail: "" },
    );
    assert.equal(getPwDataSourceStatus(db, "B站后台").status, "unbound");
    const setStatus = (status: "active" | "needs_human" | "paused") => {
      db.prepare(`
        INSERT INTO pw_connections(
          id, platform, account_label, auth_ref, status, last_sync_at, risk_events_json, created_at
        ) VALUES('conn-1', ?, NULL, NULL, ?, '2026-08-10T00:00:00.000Z', '[]', ?)
        ON CONFLICT(platform) DO UPDATE SET status = excluded.status
      `).run(BILIBILI_PLATFORM, status, "2026-08-01T00:00:00.000Z");
    };
    setStatus("active");
    assert.equal(getPwDataSourceStatus(db, "B站创作中心").status, "active");
    setStatus("needs_human");
    assert.equal(getPwDataSourceStatus(db, "B站同步").status, "needs_human");
    setStatus("paused");
    assert.equal(getPwDataSourceStatus(db, "B站同步").status, "paused");
  } finally {
    db.close();
  }
});
