import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ensurePwGoldMirrorTables,
  listMirroredGolds,
  mirrorConfirmedGolds,
} from "./pw-gold-sync.ts";
import { ensurePwRunTables } from "./pw-runs.ts";

test("镜像已确认金子且保持单向、增量和可检索", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE pt_verdicts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      card_id TEXT,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      handle TEXT,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO pt_verdicts VALUES
      ('gold-confirmed', 'project-1', 'card-1', 'gold', '确认的金子', '可复用句柄', 'confirmed', '2026-08-04T01:00:00.000Z'),
      ('gold-proposed', 'project-1', 'card-2', 'gold', '未确认金子', NULL, 'proposed', '2026-08-04T02:00:00.000Z'),
      ('gold-superseded', 'project-1', 'card-3', 'gold', '已替代金子', NULL, 'superseded', '2026-08-04T03:00:00.000Z'),
      ('tombstone-confirmed', 'project-1', 'card-4', 'tombstone', '确认墓碑', NULL, 'confirmed', '2026-08-04T04:00:00.000Z');
  `);
  try {
    ensurePwGoldMirrorTables(db);
    // TASK-PW-23：写动作模块内记账，测试库需有 pw_runs 账本
    ensurePwRunTables(db);
    assert.deepEqual(mirrorConfirmedGolds(db), { added: 1, skipped: 0 });

    const rows = listMirroredGolds(db);
    assert.equal(rows.length, 1);
    assert.deepEqual({ ...rows[0] }, {
      id: "gold-confirmed",
      source_verdict_id: "gold-confirmed",
      kind: "gold",
      text: "确认的金子",
      title: "确认的金子",
      summary: "确认的金子",
      body: "确认的金子",
      handle: "可复用句柄",
      project_id: "project-1",
      card_id: "card-1",
      confirmed_at: "2026-08-04T01:00:00.000Z",
      mirrored_at: rows[0].mirrored_at,
    });
    // TASK-PW-57：两条查询路径都带派生字段 title/summary/body
    const kwRows = listMirroredGolds(db, { keyword: "句柄" });
    assert.equal(kwRows.length, 1);
    assert.equal(kwRows[0].title, "确认的金子");
    assert.equal(kwRows[0].summary, "确认的金子");
    assert.equal(kwRows[0].body, "确认的金子");
    assert.equal(listMirroredGolds(db, { keyword: "未确认" }).length, 0);
    assert.deepEqual(mirrorConfirmedGolds(db), { added: 0, skipped: 1 });
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM pw_gold_mirror").get() as { count: number }).count, 1);

    const source = readFileSync(new URL("./pw-gold-sync.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+pt_verdicts\b/i);
    assert.doesNotMatch(source, /memos\.ts/i);
  } finally {
    db.close();
  }
});
