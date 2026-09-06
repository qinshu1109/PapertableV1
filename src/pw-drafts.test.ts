import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  confirmPwBetDraft,
  createPwBetDraft,
  ensurePwDraftTables,
  hashPwBetDraft,
  listPwBetDrafts,
  rejectPwBetDraft,
  type PwBetDraftContent,
} from "./pw-drafts.ts";

function fixture(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE pw_bets (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      thesis TEXT NOT NULL,
      metric TEXT,
      metric_target TEXT,
      confidence INTEGER,
      data_source_plan TEXT,
      checkout_date TEXT,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending','settled','void')),
      gold_refs_json TEXT NOT NULL DEFAULT '[]',
      created_from TEXT,
      created_at TEXT NOT NULL,
      settled_verdict_id TEXT,
      kind TEXT NOT NULL DEFAULT 'verdict',
      source_card_id TEXT
    );
  `);
  ensurePwDraftTables(db);
  ensurePwDraftTables(db);
  return db;
}

function createDraft(db: DatabaseSync) {
  return createPwBetDraft(db, {
    title: "短视频选题",
    thesis: "连续发布能带来关注",
    confidence: 60,
    gold_refs: ["gold-1"],
  }, "manual");
}

test("creates drafts and lists only draft status", () => {
  const db = fixture();
  try {
    const draft = createDraft(db);
    assert.equal(draft.status, "draft");
    assert.equal(draft.created_from, "manual");
    assert.deepEqual(JSON.parse(draft.gold_refs_json), ["gold-1"]);
    db.prepare(`
      INSERT INTO pw_bets(
        id, title, thesis, status, created_at
      ) VALUES('pending-1', '已确认', '内容', 'pending', ?)
    `).run(new Date().toISOString());
    assert.deepEqual(listPwBetDrafts(db).map((row) => row.id), [draft.id]);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM pw_draft_events").get() as { n: number }).n,
      0,
    );
  } finally {
    db.close();
  }
});

test("confirms edited content transactionally and records a reproducible hash", () => {
  const db = fixture();
  try {
    const draft = createDraft(db);
    const result = confirmPwBetDraft(db, draft.id, {
      metric: "关注数",
      metric_target: ">= 100",
      data_source_plan: "平台后台数据",
      checkout_date: "2026-09-01",
      title: "连续选题实验",
    }, "qinshu");
    const content: PwBetDraftContent = {
      title: "连续选题实验",
      thesis: "连续发布能带来关注",
      metric: "关注数",
      metric_target: ">= 100",
      confidence: 60,
      data_source_plan: "平台后台数据",
      checkout_date: "2026-09-01",
      gold_refs: ["gold-1"],
    };
    const expected = createHash("sha256").update(JSON.stringify(content)).digest("hex");
    assert.equal(result.status, "pending");
    assert.equal(result.draft_hash, expected);
    assert.equal(result.draft_hash, hashPwBetDraft(content));
    assert.equal(
      (db.prepare("SELECT status FROM pw_bets WHERE id = ?").get(draft.id) as { status: string }).status,
      "pending",
    );
    const event = db.prepare("SELECT * FROM pw_draft_events WHERE bet_id = ?").get(draft.id) as Record<string, unknown>;
    assert.equal(event.action, "confirm");
    assert.equal(event.draft_hash, expected);
    assert.equal(event.actor, "qinshu");
  } finally {
    db.close();
  }
});

test("refuses incomplete confirmation without changing the draft", () => {
  const db = fixture();
  try {
    const draft = createDraft(db);
    assert.throws(
      () => confirmPwBetDraft(db, draft.id, { metric: "关注数" }, "qinshu"),
      /三行赌注/,
    );
    assert.equal(
      (db.prepare("SELECT status FROM pw_bets WHERE id = ?").get(draft.id) as { status: string }).status,
      "draft",
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM pw_draft_events").get() as { n: number }).n,
      0,
    );
  } finally {
    db.close();
  }
});

test("rejects with a required reason and records the actor", () => {
  const db = fixture();
  try {
    const draft = createDraft(db);
    assert.throws(() => rejectPwBetDraft(db, draft.id, "  ", "qinshu"), /reason 必填/);
    const result = rejectPwBetDraft(db, draft.id, "方向不成立", "qinshu");
    assert.equal(result.status, "void");
    const event = db.prepare("SELECT * FROM pw_draft_events WHERE bet_id = ?").get(draft.id) as Record<string, unknown>;
    assert.equal(event.action, "reject");
    assert.equal(event.reason, "方向不成立");
    assert.equal(event.actor, "qinshu");
    assert.match(String(event.draft_hash), /^[a-f0-9]{64}$/);
  } finally {
    db.close();
  }
});

test("does not confirm or reject a non-draft bet", () => {
  const db = fixture();
  try {
    const draft = createDraft(db);
    confirmPwBetDraft(db, draft.id, {
      metric: "关注数",
      data_source_plan: "平台后台",
      checkout_date: "2026-09-01",
    });
    assert.throws(() => confirmPwBetDraft(db, draft.id, {}), /不是 draft/);
    assert.throws(() => rejectPwBetDraft(db, draft.id, "不再做"), /不是 draft/);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM pw_draft_events").get() as { n: number }).n,
      1,
    );
  } finally {
    db.close();
  }
});
