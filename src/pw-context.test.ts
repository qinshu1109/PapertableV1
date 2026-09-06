import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { assembleJudgmentContext } from "./pw-context.ts";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE pw_bets (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, thesis TEXT NOT NULL,
      metric TEXT, data_source_plan TEXT
    );
    CREATE TABLE pw_verdicts (
      id TEXT PRIMARY KEY, outcome TEXT NOT NULL, lesson TEXT, decided_at TEXT NOT NULL
    );
    CREATE TABLE pw_gold_mirror (
      id TEXT PRIMARY KEY, text TEXT NOT NULL, mirrored_at TEXT NOT NULL
    );
    INSERT INTO pw_bets(id, title, thesis, metric, data_source_plan)
    VALUES('bet-1', '直播做产品实践', '直播系列能成', '三期平均播放 ≥ 5000', 'B站');
    INSERT INTO pw_verdicts(id, outcome, lesson, decided_at) VALUES
      ('v-own', 'gold', 'B站开头 30 秒放痛点，播放完成率明显更好', '2026-08-01T00:00:00Z'),
      ('v-tomb', 'tomb', NULL, '2026-08-01T00:00:00Z');
    INSERT INTO pw_gold_mirror(id, text, mirrored_at) VALUES
      ('m-1', '小红书封面大字标题点击率更高', '2026-07-30T00:00:00Z'),
      ('m-2', '无关领域的一条旧判断', '2026-07-29T00:00:00Z');
  `);
  return db;
}

test("装配输出包含本域与镜像金子，tomb 不进入", () => {
  const db = makeDb();
  const ctx = assembleJudgmentContext(db, "bet-1");
  assert.match(ctx.markdown, /开头 30 秒放痛点/);
  assert.match(ctx.markdown, /小红书封面/);
  assert.equal(ctx.total, 3);
  assert.equal(ctx.included.length, 3);
  db.close();
});

test("相关度排序：与押注平台/指标匹配的金子在前，且结果确定", () => {
  const db = makeDb();
  const first = assembleJudgmentContext(db, "bet-1");
  const second = assembleJudgmentContext(db, "bet-1");
  assert.deepEqual(first.included.map((i) => i.id), second.included.map((i) => i.id));
  assert.equal(first.included[0].id, "v-own"); // 同时命中 B站 与 播放
  db.close();
});

test("字符预算截断并标记 truncated", () => {
  const db = makeDb();
  const ctx = assembleJudgmentContext(db, "bet-1", { charBudget: 60 });
  assert.ok(ctx.included.length < ctx.total);
  assert.equal(ctx.truncated, true);
  assert.ok(ctx.markdown.length <= 60 + "## 有效判断（金子，只读引用）\n".length + 200);
  db.close();
});

test("押注不存在报 404", () => {
  const db = makeDb();
  assert.throws(() => assembleJudgmentContext(db, "nope"), /押注不存在/);
  db.close();
});
