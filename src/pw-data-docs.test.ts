import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  appendPwDataDocVersion,
  createPwDataDoc,
  ensurePwDataDocTables,
  freezePwDataDoc,
  getPwDataDoc,
  listPwDataDocs,
} from "./pw-data-docs.ts";

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwDataDocTables(db);
  return db;
}

test("creates, versions, freezes, and lists the latest data document", () => {
  const db = database();
  try {
    const first = createPwDataDoc(db, {
      betId: "bet-1",
      artifactId: "artifact-1",
      platform: "bilibili",
      collectedAt: "2026-08-04T00:00:00.000Z",
      metricsJson: '{"plays":10}',
      rawRef: "manual-entry",
      sourceHash: "hash-1",
    });

    assert.equal(first.method, "manual");
    assert.equal(first.version, 1);
    assert.equal(first.metrics_json, '{"plays":10}');

    assert.throws(
      () => createPwDataDoc(db, {
        betId: "bet-1",
        platform: "bilibili",
        metricsJson: "not-json",
      }),
      /metrics_json/,
    );

    const second = appendPwDataDocVersion(db, first.id, '{"plays":20}');
    assert.notEqual(second.id, first.id);
    assert.equal(second.version, 2);
    assert.equal(second.metrics_json, '{"plays":20}');
    assert.equal(second.bet_id, first.bet_id);
    assert.equal(second.artifact_id, first.artifact_id);
    assert.equal(second.platform, first.platform);
    assert.equal(getPwDataDoc(db, first.id).version, 1);
    assert.equal(getPwDataDoc(db, first.id).metrics_json, '{"plays":10}');
    assert.deepEqual(listPwDataDocs(db, "bet-1"), [second]);

    freezePwDataDoc(db, second.id);
    assert.equal(getPwDataDoc(db, second.id).frozen, 1);
    assert.throws(
      () => appendPwDataDocVersion(db, second.id, '{"plays":30}'),
      /Frozen/,
    );
    assert.throws(
      () => appendPwDataDocVersion(db, first.id, '{"plays":30}'),
      /Frozen/,
    );
  } finally {
    db.close();
  }
});
