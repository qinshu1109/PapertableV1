import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  attachPwArtifact,
  detachPwArtifact,
  ensurePwArtifactTables,
  listPwArtifacts,
} from "./pw-artifacts.ts";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE pw_bets (id TEXT PRIMARY KEY)");
  db.prepare("INSERT INTO pw_bets(id) VALUES (?)").run("bet-1");
  ensurePwArtifactTables(db);
  return db;
}

test("attaches an artifact to an existing bet and lists it", () => {
  const db = fixture();
  try {
    const artifact = attachPwArtifact(db, {
      betId: "bet-1",
      platform: "B站",
      type: "video",
      url: "https://example.test/video",
      title: "第一期",
    });
    assert.equal(artifact.bet_id, "bet-1");
    assert.equal(listPwArtifacts(db, "bet-1").length, 1);
  } finally {
    db.close();
  }
});

test("rejects a missing bet, invalid type, and missing URL/title", () => {
  const db = fixture();
  try {
    assert.throws(
      () => attachPwArtifact(db, { betId: "missing", platform: "B站", type: "video", url: "x" }),
      /押注不存在/,
    );
    assert.throws(
      () => attachPwArtifact(db, { betId: "bet-1", platform: "B站", type: "podcast" as "video", url: "x" }),
      /类型非法/,
    );
    assert.throws(
      () => attachPwArtifact(db, { betId: "bet-1", platform: "B站", type: "video" }),
      /URL 或标题/,
    );
  } finally {
    db.close();
  }
});

test("detaching hides the row by default but keeps its history", () => {
  const db = fixture();
  try {
    const artifact = attachPwArtifact(db, {
      betId: "bet-1",
      platform: "小红书",
      type: "cover",
      title: "封面",
    });
    detachPwArtifact(db, artifact.id);
    assert.equal(listPwArtifacts(db, "bet-1").length, 0);
    assert.equal(listPwArtifacts(db, "bet-1", { includeDetached: true }).length, 1);
    const row = db.prepare("SELECT detached_at FROM pw_artifacts WHERE id = ?").get(artifact.id) as {
      detached_at: string | null;
    };
    assert.ok(row.detached_at);
  } finally {
    db.close();
  }
});
