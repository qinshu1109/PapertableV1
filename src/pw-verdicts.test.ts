import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ensurePwVerdictTables,
  listDuePwBets,
  listPwVerdicts,
  searchPwVerdicts,
  settlePwBet,
  tombstoneCauseStats,
} from "./pw-verdicts.ts";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE pw_bets (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, thesis TEXT NOT NULL,
      metric TEXT, metric_target TEXT, confidence INTEGER,
      data_source_plan TEXT, checkout_date TEXT,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','pending','settled','void')),
      gold_refs_json TEXT NOT NULL DEFAULT '[]', created_from TEXT,
      created_at TEXT NOT NULL, settled_verdict_id TEXT
    );
    CREATE TABLE pw_data_docs (id TEXT PRIMARY KEY, bet_id TEXT NOT NULL);
  `);
  ensurePwVerdictTables(db);
  ensurePwVerdictTables(db);
  return db;
}

function insertBet(db: DatabaseSync, id: string, checkoutDate = "2026-08-01", status = "pending") {
  db.prepare(`
    INSERT INTO pw_bets(id, title, thesis, metric, data_source_plan, checkout_date,
      status, confidence, created_at)
    VALUES(?, 'title', 'thesis', 'metric', 'source', ?, ?, 73, '2026-07-01T00:00:00.000Z')
  `).run(id, checkoutDate, status);
}

test("settles gold, tomb, and void with their required fields", () => {
  const db = fixture();
  try {
    insertBet(db, "gold-bet");
    db.prepare("INSERT INTO pw_data_docs(id, bet_id) VALUES('doc-gold', 'gold-bet')").run();
    const gold = settlePwBet(db, "gold-bet", {
      outcome: "gold", lesson: "有效判断", evidenceDocIds: ["doc-gold"], decidedAt: "2026-08-02",
    });
    assert.equal(gold.outcome, "gold");
    assert.equal(gold.lesson, "有效判断");
    assert.equal(gold.confidence_snapshot, 73);
    assert.throws(() => settlePwBet(db, "gold-bet", {
      outcome: "gold", lesson: "再次结账", evidenceDocIds: ["doc-gold"],
    }), /settled|pending/);

    insertBet(db, "tomb-bet");
    db.prepare("INSERT INTO pw_data_docs(id, bet_id) VALUES('doc-tomb', 'tomb-bet')").run();
    assert.throws(() => settlePwBet(db, "tomb-bet", {
      outcome: "tomb", evidenceDocIds: ["doc-tomb"],
    }), /cause_of_death/);
    const tomb = settlePwBet(db, "tomb-bet", {
      outcome: "tomb", causeOfDeath: "没人需要", evidenceDocIds: ["doc-tomb"],
    });
    assert.equal(tomb.cause_of_death, "没人需要");

    insertBet(db, "void-bet");
    const voidVerdict = settlePwBet(db, "void-bet", { outcome: "void" });
    assert.equal(voidVerdict.outcome, "void");
    assert.deepEqual(JSON.parse(voidVerdict.evidence_doc_ids_json), []);
  } finally {
    db.close();
  }
});

test("requires existing evidence, keeps void retryable, and enforces human at the DB", () => {
  const db = fixture();
  try {
    insertBet(db, "retry-bet");
    assert.throws(() => settlePwBet(db, "retry-bet", {
      outcome: "gold", lesson: "判断", evidenceDocIds: ["missing"],
    }), /数据文档不存在/);
    const voidVerdict = settlePwBet(db, "retry-bet", { outcome: "void" });
    assert.equal(voidVerdict.outcome, "void");
    db.prepare("INSERT INTO pw_data_docs(id, bet_id) VALUES('retry-doc', 'retry-bet')").run();
    const gold = settlePwBet(db, "retry-bet", {
      outcome: "gold", lesson: "重新验证后成立", evidenceDocIds: ["retry-doc"],
    });
    assert.equal(gold.outcome, "gold");
  } catch (error) {
    assert.fail(`void retry should succeed: ${String(error)}`);
  } finally {
    db.close();
  }

  const humanDb = fixture();
  try {
    insertBet(humanDb, "human-bet");
    assert.throws(() => settlePwBet(humanDb, "human-bet", {
      outcome: "void", decidedBy: "ai",
    }), /CHECK constraint failed|decided_by/);
  } finally {
    humanDb.close();
  }
});

test("does not let a due query include future or non-pending bets", () => {
  const db = fixture();
  try {
    insertBet(db, "due", "2026-08-01");
    insertBet(db, "future", "2026-08-05");
    insertBet(db, "settled", "2026-07-01", "settled");
    assert.deepEqual(listDuePwBets(db, "2026-08-04").map((row) => row.id), ["due"]);
  } finally {
    db.close();
  }
});

test("lists, searches, and aggregates verdicts", () => {
  const db = fixture();
  try {
    insertBet(db, "gold-bet");
    insertBet(db, "tomb-a");
    insertBet(db, "tomb-b");
    db.prepare("INSERT INTO pw_data_docs(id, bet_id) VALUES('doc-1', 'gold-bet'), ('doc-2', 'tomb-a'), ('doc-3', 'tomb-b')").run();
    settlePwBet(db, "gold-bet", { outcome: "gold", lesson: "用户愿意收藏", evidenceDocIds: ["doc-1"] });
    settlePwBet(db, "tomb-a", { outcome: "tomb", causeOfDeath: "没人需要", evidenceDocIds: ["doc-2"] });
    settlePwBet(db, "tomb-b", { outcome: "tomb", causeOfDeath: "没人需要", evidenceDocIds: ["doc-3"] });
    assert.equal(listPwVerdicts(db, { outcome: "gold" }).length, 1);
    assert.equal(searchPwVerdicts(db, "收藏").length, 1);
    assert.deepEqual(tombstoneCauseStats(db), { "没人需要": 2 });
  } finally {
    db.close();
  }
});
