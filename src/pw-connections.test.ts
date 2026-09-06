import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createPwBet, ensurePwBetTables } from "./pw-bets.ts";
import {
  attachPwArtifact,
  detachPwArtifact,
  ensurePwArtifactTables,
} from "./pw-artifacts.ts";
import { ensurePwDataDocTables } from "./pw-data-docs.ts";
import { ensurePwRunTables } from "./pw-runs.ts";
import {
  ensurePwConnectionTables,
  listAllPwDataDocs,
  listPwConnections,
  registerPwConnection,
  setPwConnectionStatus,
  syncPwBilibili,
} from "./pw-connections.ts";

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwBetTables(db);
  ensurePwArtifactTables(db);
  ensurePwDataDocTables(db);
  ensurePwRunTables(db);
  ensurePwConnectionTables(db);
  return db;
}

function seedBilibiliArtifact(db: DatabaseSync, platform = "B站") {
  const bet = createPwBet(db, { title: "测试押注", thesis: "假设", status: "draft" });
  const artifact = attachPwArtifact(db, {
    betId: bet.id,
    platform,
    type: "video",
    url: "https://b23.tv/BV1xx",
    title: "第1期成片",
  });
  return { bet, artifact };
}

test("连接登记幂等：同 platform 返回既有，docs_count 随之统计", () => {
  const db = database();
  try {
    const first = registerPwConnection(db, { platform: "B站", accountLabel: "琴疏" });
    assert.equal(first.status, "active");
    assert.equal(first.account_label, "琴疏");
    assert.equal(first.auth_ref, null);
    assert.equal(first.last_sync_at, null);
    assert.equal(first.risk_events_json, "[]");

    const again = registerPwConnection(db, { platform: "B站", accountLabel: "另一个号" });
    assert.equal(again.id, first.id);
    assert.equal(again.account_label, "琴疏");
    assert.equal(listPwConnections(db).length, 1);

    assert.throws(
      () => registerPwConnection(db, { platform: "  " }),
      /platform/,
    );
  } finally {
    db.close();
  }
});

test("状态机：needs_human 追加 risk_events，恢复 active 不清空，非法 status 拒绝", () => {
  const db = database();
  try {
    const conn = registerPwConnection(db, { platform: "B站" });

    const warned = setPwConnectionStatus(db, conn.id, "needs_human", "出现滑块验证");
    assert.equal(warned.status, "needs_human");
    const events = JSON.parse(warned.risk_events_json) as Array<{ at: string; reason: string }>;
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, "出现滑块验证");
    assert.ok(events[0].at);

    // 默认原因
    setPwConnectionStatus(db, conn.id, "active");
    const warned2 = setPwConnectionStatus(db, conn.id, "needs_human");
    const events2 = JSON.parse(warned2.risk_events_json) as Array<{ reason: string }>;
    assert.equal(events2.length, 2);
    assert.equal(events2[1].reason, "人工标记");

    // 恢复 active 不清空 risk_events
    const restored = setPwConnectionStatus(db, conn.id, "active");
    assert.equal(restored.status, "active");
    assert.equal((JSON.parse(restored.risk_events_json) as unknown[]).length, 2);

    assert.throws(() => setPwConnectionStatus(db, conn.id, "broken"), /非法 status/);
    assert.throws(() => setPwConnectionStatus(db, "missing", "active"), /连接不存在/);
  } finally {
    db.close();
  }
});

test("sync 落库：version 递增、留痕 kind=sync，非 B站 / 已摘除 / 不存在进 errors", () => {
  const db = database();
  try {
    registerPwConnection(db, { platform: "B站" });
    const { artifact } = seedBilibiliArtifact(db);
    const { artifact: xhsArtifact } = seedBilibiliArtifact(db, "小红书");
    const { artifact: detached } = seedBilibiliArtifact(db);
    detachPwArtifact(db, detached.id);

    const first = syncPwBilibili(db, [
      { artifactId: artifact.id, metrics: { 播放: 100, 点赞: 5 }, rawRef: "创作中心" },
      { artifactId: xhsArtifact.id, metrics: { 播放: 1 } },
      { artifactId: detached.id, metrics: { 播放: 1 } },
      { artifactId: "missing", metrics: { 播放: 1 } },
      { artifactId: artifact.id, metrics: "bad" },
    ]);
    assert.equal(first.created, 1);
    assert.equal(first.errors.length, 4);
    assert.match(first.errors[0].reason, /平台不是/);
    assert.match(first.errors[1].reason, /已摘除/);
    assert.match(first.errors[2].reason, /不存在/);
    assert.match(first.errors[3].reason, /metrics/);

    const docs = listAllPwDataDocs(db);
    assert.equal(docs.length, 1);
    assert.equal(docs[0].method, "sync");
    assert.equal(docs[0].version, 1);
    assert.equal(docs[0].frozen, 0);
    assert.equal(docs[0].platform, "B站");
    assert.equal(docs[0].raw_ref, "创作中心");
    assert.equal(docs[0].artifact_title, "第1期成片");
    assert.equal(docs[0].bet_title, "测试押注");

    // 再次同步 version 递增，只增不改
    const second = syncPwBilibili(db, [
      { artifactId: artifact.id, metrics: { 播放: 200 } },
    ]);
    assert.equal(second.created, 1);
    const versions = db.prepare(
      "SELECT version FROM pw_data_docs WHERE artifact_id = ? ORDER BY version",
    ).all(artifact.id) as Array<{ version: number }>;
    assert.deepEqual(versions.map(({ version }) => version), [1, 2]);

    // pw_runs 留痕：kind=sync, event_type=data_doc, actor=system
    // （TASK-PW-23 起 registerPwConnection 也会落 connection 审计行，故按 event_type 过滤同步留痕）
    const runs = db.prepare(
      "SELECT kind, event_type, actor, payload_json, bet_id FROM pw_runs WHERE event_type = 'data_doc' ORDER BY created_at, rowid",
    ).all() as Array<{
      kind: string;
      event_type: string;
      actor: string;
      payload_json: string;
      bet_id: string | null;
    }>;
    assert.equal(runs.length, 2);
    for (const run of runs) {
      assert.equal(run.kind, "sync");
      assert.equal(run.event_type, "data_doc");
      assert.equal(run.actor, "system");
      assert.ok(run.bet_id);
      assert.equal(JSON.parse(run.payload_json).artifactId, artifact.id);
    }

    // last_sync_at 更新，docs_count 统计 sync 文档
    const conns = listPwConnections(db);
    assert.ok(conns[0].last_sync_at);
    assert.equal(conns[0].docs_count, 2);
  } finally {
    db.close();
  }
});

test("无 B站连接时 sync 拒绝；pw_connections.auth_ref 恒 null", () => {
  const db = database();
  try {
    assert.throws(
      () => syncPwBilibili(db, []),
      (error: unknown) =>
        typeof error === "object" && error !== null && "status" in error
        && (error as { status: unknown }).status === 404,
    );

    const { artifact } = seedBilibiliArtifact(db);
    registerPwConnection(db, { platform: "B站", accountLabel: "琴疏" });
    syncPwBilibili(db, [{ artifactId: artifact.id, metrics: { 播放: 1 } }]);
    const rows = db.prepare("SELECT auth_ref FROM pw_connections").all() as Array<{
      auth_ref: string | null;
    }>;
    assert.ok(rows.length > 0);
    for (const row of rows) assert.equal(row.auth_ref, null);
  } finally {
    db.close();
  }
});
