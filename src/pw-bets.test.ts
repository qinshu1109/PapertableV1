import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createPwBet,
  ensurePwBetTables,
  getPwBet,
  listPwBets,
} from "./pw-bets.ts";

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwBetTables(db);
  ensurePwBetTables(db);
  return db;
}

function assertBad(action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    assert.equal((error as { status?: number }).status, 400);
    return true;
  });
}

test("建表幂等且只保留押注领域字段", () => {
  const db = database();
  try {
    const columns = (db.prepare("PRAGMA table_info(pw_bets)").all() as Array<{ name: string }>)
      .map(({ name }) => name);
    assert.deepEqual(columns, [
      "id",
      "title",
      "thesis",
      "metric",
      "metric_target",
      "confidence",
      "data_source_plan",
      "checkout_date",
      "status",
      "gold_refs_json",
      "created_from",
      "created_at",
      "settled_verdict_id",
      "kind",
      "source_card_id",
    ]);
    assert.equal(columns.includes("priority"), false);
    assert.equal(columns.includes("owner"), false);
    assert.equal(columns.includes("board_column"), false);
    assert.equal(columns.includes("due_date"), false);
  } finally {
    db.close();
  }
});

test("draft 创建成功，pending 强制三行赌注", () => {
  const db = database();
  try {
    const draft = createPwBet(db, {
      title: "先做一条直播切片",
      thesis: "真实过程比教程更容易让观众追更",
    });
    assert.equal(draft.status, "draft");
    assert.equal(draft.metric, null);
    assert.deepEqual(JSON.parse(draft.gold_refs_json), []);

    for (const missing of [
      { dataSourcePlan: "B站后台", checkoutDate: "2026-08-10" },
      { metric: "播放量", checkoutDate: "2026-08-10" },
      { metric: "播放量", dataSourcePlan: "B站后台" },
    ]) {
      assertBad(() => createPwBet(db, {
        title: "待确认押注",
        thesis: "假设",
        status: "pending",
        ...missing,
      }));
    }

    const pending = createPwBet(db, {
      title: "待确认押注",
      thesis: "假设",
      status: "pending",
      metric: "三期平均播放量",
      metric_target: "不低于 5000",
      data_source_plan: "B站创作中心",
      checkout_date: "2026-08-10",
      confidence: 70,
      createdFrom: "manual",
    });
    assert.equal(pending.status, "pending");
    assert.equal(pending.metric_target, "不低于 5000");
    assert.equal(pending.confidence, 70);
  } finally {
    db.close();
  }
});

test("confidence 越界或非整数报错", () => {
  const db = database();
  try {
    for (const confidence of [-1, 101, 50.5, Number.NaN]) {
      assertBad(() => createPwBet(db, {
        title: "押注",
        thesis: "假设",
        confidence,
      }));
    }
    assert.equal(createPwBet(db, {
      title: "押注",
      thesis: "无置信度也可以",
      confidence: null,
    }).confidence, null);
  } finally {
    db.close();
  }
});

test("gold_refs 按快照存取，list 默认过滤 draft", () => {
  const db = database();
  try {
    const goldRefs = ["gold-1", "gold-2"];
    const draft = createPwBet(db, {
      title: "草稿",
      thesis: "先不进押注台",
      goldRefs,
    });
    goldRefs.push("gold-3");
    const stored = getPwBet(db, draft.id)!;
    assert.deepEqual(JSON.parse(stored.gold_refs_json), ["gold-1", "gold-2"]);

    const pending = createPwBet(db, {
      title: "正式押注",
      thesis: "进入押注台",
      status: "pending",
      metric: "收藏数",
      data_source_plan: "平台后台",
      checkout_date: "2026-08-10",
      gold_refs: ["gold-9"],
    });
    assert.deepEqual(listPwBets(db).map((row) => row.id), [pending.id]);
    assert.deepEqual(listPwBets(db, { status: "draft" }).map((row) => row.id), [draft.id]);
    assert.deepEqual(JSON.parse(getPwBet(db, pending.id)!.gold_refs_json), ["gold-9"]);
  } finally {
    db.close();
  }
});
