/**
 * TASK-PW-17：数据读取通路补课测试。
 * 覆盖：语料整行/落盘评论分页/落盘 meta、数据文档版本链、判决证据链、
 * 连接状态与 risk_events、事件流过滤分页、read_voice dropped 过滤。
 * 全部断言走内存库 + 临时目录（corpus 落盘文件），不碰真实数据目录。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createPwBet, ensurePwBetTables } from "./pw-bets.ts";
import { attachPwArtifact, ensurePwArtifactTables } from "./pw-artifacts.ts";
import {
  appendPwDataDocVersion,
  createPwDataDoc,
  ensurePwDataDocTables,
  listPwDataDocVersions,
} from "./pw-data-docs.ts";
import { ensurePwVerdictTables, getPwVerdictDetail, settlePwBet } from "./pw-verdicts.ts";
import { ensurePwRunTables, listPwRuns, recordPwEvent } from "./pw-runs.ts";
import {
  ensurePwConnectionTables,
  getPwConnectionStatus,
  registerPwConnection,
  setPwConnectionStatus,
} from "./pw-connections.ts";
import { addPwVoiceItem, dropPwVoiceItem, ensurePwVoiceTables } from "./pw-voice.ts";
import {
  authorizePwCorpus,
  donePwCorpus,
  ensurePwCorpusTables,
  getPwCorpusDoc,
  readPwCorpusComments,
  readPwCorpusMeta,
} from "./pw-corpus.ts";
import {
  pwCollabTools,
  type CollabToolContext,
} from "./pw-collab-tools.ts";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwBetTables(db);
  ensurePwArtifactTables(db);
  ensurePwDataDocTables(db);
  ensurePwVerdictTables(db);
  ensurePwRunTables(db);
  ensurePwConnectionTables(db);
  ensurePwVoiceTables(db);
  ensurePwCorpusTables(db);
  return db;
}

function hasStatus(error: unknown, status: number): boolean {
  return typeof error === "object" && error !== null && "status" in error
    && (error as { status: unknown }).status === status;
}

function makeBet(db: DatabaseSync, overrides: Record<string, unknown> = {}): string {
  return createPwBet(db, {
    title: "直播做产品实践",
    thesis: "直播系列能成",
    status: "draft",
    ...overrides,
  }).id;
}

const BV1 = "BV1NprhBPEtR";

const JSONL_COMMENTS = [
  { rpid: 101, uname: "甲", message: "这条评论一", like: 12, ctime: 1700000001, replies: 3 },
  { rpid: 102, uname: "乙", message: "这条评论二", like: 8, ctime: 1700000002, replies: 0 },
  { rpid: 103, uname: "丙", message: "这条评论三", like: 5, ctime: 1700000003, replies: 1 },
  { rpid: 104, uname: "丁", message: "这条评论四", like: 2, ctime: 1700000004, replies: 0 },
];

const META = {
  bvid: BV1,
  aid: 123456,
  title: "测试成片",
  up_name: "某UP主",
  pubdate: 1700000000,
  stat: { 播放: 100, 弹幕: 5, 评论: 4, 收藏: 20, 投币: 10, 分享: 3, 点赞: 30 },
  fetched_at: "2026-08-05T00:00:00.000Z",
  source: "api.bilibili.com/x/web-interface/view",
};

/** 造 done 语料条目：DB 行指向临时目录，目录里写 meta.json + comments.jsonl。 */
async function seedDoneCorpus(
  db: DatabaseSync,
  dir: string,
  comments = JSONL_COMMENTS,
): Promise<string> {
  await writeFile(join(dir, "meta.json"), JSON.stringify(META, null, 2));
  await writeFile(
    join(dir, "comments.jsonl"),
    comments.map((comment) => JSON.stringify(comment)).join("\n") + "\n",
  );
  const { doc } = authorizePwCorpus(db, { bvid: META.bvid });
  donePwCorpus(db, doc.id, {
    title: META.title,
    upName: META.up_name,
    path: dir,
    videoStat: META.stat,
    commentCount: comments.length,
    comments: comments.map((comment) => ({
      uname: comment.uname,
      message: comment.message,
      like: comment.like,
    })),
  });
  return doc.id;
}

test("语料：getPwCorpusDoc 按 id/bvid 读整行，video_stat_json 解析为七项对象", async () => {
  const db = makeDb();
  const dir = await mkdtemp(join(tmpdir(), "pw-read-corpus-"));
  try {
    const id = await seedDoneCorpus(db, dir);
    const byBvid = getPwCorpusDoc(db, BV1);
    assert.equal(byBvid.id, id);
    assert.equal(byBvid.bvid, BV1);
    assert.equal(byBvid.status, "done");
    assert.equal(byBvid.path, dir);
    assert.equal(byBvid.comment_count, 4);
    assert.ok(byBvid.fetched_at);
    assert.deepEqual(byBvid.video_stat, META.stat);

    const byId = getPwCorpusDoc(db, id);
    assert.equal(byId.id, id);
    assert.equal(byId.bvid, BV1);
    assert.equal(byId.video_stat?.["点赞"], 30);

    assert.throws(() => getPwCorpusDoc(db, "missing"), (error: unknown) =>
      hasStatus(error, 404));
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("语料：readPwCorpusComments 分页读全量评论，含 rpid/ctime/replies", async () => {
  const db = makeDb();
  const dir = await mkdtemp(join(tmpdir(), "pw-read-comments-"));
  try {
    await seedDoneCorpus(db, dir);

    const all = readPwCorpusComments(db, BV1);
    assert.equal(all.length, 4);
    assert.deepEqual(all.map((comment) => comment.rpid), [101, 102, 103, 104]);
    assert.equal(all[0].uname, "甲");
    assert.equal(all[0].message, "这条评论一");
    assert.equal(all[0].like, 12);
    assert.equal(all[0].ctime, 1700000001);
    assert.equal(all[0].replies, 3);

    // 分页：offset/limit 切片
    assert.deepEqual(
      readPwCorpusComments(db, BV1, { offset: 1, limit: 2 }).map((c) => c.rpid),
      [102, 103],
    );
    assert.deepEqual(
      readPwCorpusComments(db, BV1, { limit: 2 }).map((c) => c.rpid),
      [101, 102],
    );
    assert.deepEqual(
      readPwCorpusComments(db, BV1, { offset: 3 }).map((c) => c.rpid),
      [104],
    );
    assert.equal(readPwCorpusComments(db, BV1, { offset: 99 }).length, 0);

    // 非法分页参数拒绝
    for (const options of [{ offset: -1 }, { offset: 1.5 }, { limit: 0 }, { limit: -2 }]) {
      assert.throws(() => readPwCorpusComments(db, BV1, options), (error: unknown) =>
        hasStatus(error, 400));
    }
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("语料：条目非 done 或落盘文件缺失抛明确 httpError，不吞不降级", async () => {
  const db = makeDb();
  const dir = await mkdtemp(join(tmpdir(), "pw-read-missing-"));
  const emptyDir = await mkdtemp(join(tmpdir(), "pw-read-empty-"));
  try {
    // 非 done（pending）条目：评论与 meta 都拒绝
    const { doc } = authorizePwCorpus(db, { bvid: BV1 });
    assert.throws(() => readPwCorpusComments(db, BV1), (error: unknown) =>
      hasStatus(error, 409));
    assert.throws(() => readPwCorpusMeta(db, BV1), (error: unknown) =>
      hasStatus(error, 409));

    // done 但目录没有落盘文件：404
    donePwCorpus(db, doc.id, { path: emptyDir });
    assert.throws(() => readPwCorpusComments(db, BV1), (error: unknown) =>
      hasStatus(error, 404));
    assert.throws(() => readPwCorpusMeta(db, BV1), (error: unknown) =>
      hasStatus(error, 404));

    // done 但目录整体不存在：404
    const missingDir = await mkdtemp(join(tmpdir(), "pw-read-gone-"));
    await rm(missingDir, { recursive: true, force: true });
    await seedDoneCorpus(db, dir);
    db.prepare("UPDATE pw_corpus_docs SET path = ? WHERE bvid = ?").run(missingDir, BV1);
    assert.throws(() => readPwCorpusComments(db, BV1), (error: unknown) =>
      hasStatus(error, 404));

    // 不存在的 bvid：404
    assert.throws(() => readPwCorpusComments(db, "BV1xx411c7mD"), (error: unknown) =>
      hasStatus(error, 404));
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
    await rm(emptyDir, { recursive: true, force: true });
  }
});

test("语料：readPwCorpusMeta 读落盘 meta.json（bvid/aid/title/up_name/pubdate/stat/fetched_at）", async () => {
  const db = makeDb();
  const dir = await mkdtemp(join(tmpdir(), "pw-read-meta-"));
  try {
    await seedDoneCorpus(db, dir);
    const meta = readPwCorpusMeta(db, BV1);
    assert.equal(meta.bvid, BV1);
    assert.equal(meta.aid, 123456);
    assert.equal(meta.title, "测试成片");
    assert.equal(meta.up_name, "某UP主");
    assert.equal(meta.pubdate, 1700000000);
    assert.deepEqual(meta.stat, META.stat);
    assert.equal(meta.fetched_at, "2026-08-05T00:00:00.000Z");
    assert.equal(meta.source, "api.bilibili.com/x/web-interface/view");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("版本链：append 两版后 listPwDataDocVersions 回 2 行正序，带 method/frozen/artifact 标题", () => {
  const db = makeDb();
  try {
    const betId = makeBet(db);
    const artifact = attachPwArtifact(db, {
      betId,
      platform: "B站",
      type: "video",
      url: "https://b23.tv/BV1xx",
      title: "第1期成片",
    });
    const first = createPwDataDoc(db, {
      betId,
      artifactId: artifact.id,
      platform: "bilibili",
      collectedAt: "2026-08-01T00:00:00.000Z",
      metricsJson: '{"播放":10}',
      rawRef: "ref-1",
    });
    const second = appendPwDataDocVersion(db, first.id, '{"播放":20}');
    assert.equal(second.version, 2);

    const versions = listPwDataDocVersions(db, { betId });
    assert.equal(versions.length, 2);
    assert.deepEqual(versions.map((row) => row.version), [1, 2]);
    for (const row of versions) {
      assert.equal(row.method, "manual");
      assert.equal(row.frozen, 0);
      assert.equal(row.raw_ref, "ref-1");
      assert.equal(row.artifact_title, "第1期成片");
    }
    assert.equal(versions[0].metrics_json, '{"播放":10}');
    assert.equal(versions[1].metrics_json, '{"播放":20}');

    // platform / artifactId 过滤
    assert.equal(listPwDataDocVersions(db, { betId, platform: "bilibili" }).length, 2);
    assert.equal(listPwDataDocVersions(db, { betId, platform: "小红书" }).length, 0);
    assert.equal(listPwDataDocVersions(db, { betId, artifactId: artifact.id }).length, 2);
    assert.equal(listPwDataDocVersions(db, { betId, artifactId: "missing" }).length, 0);

    assert.throws(() => listPwDataDocVersions(db, { betId: "" }), /betId/);
  } finally {
    db.close();
  }
});

test("证据链：getPwVerdictDetail 回 verdict 整行 + evidence 摘要 + 押注标题", () => {
  const db = makeDb();
  try {
    const betId = createPwBet(db, {
      title: "直播做产品实践",
      thesis: "直播系列能成",
      metric: "三期平均播放",
      dataSourcePlan: "B站",
      checkoutDate: "2026-08-01",
      confidence: 70,
      status: "pending",
    }).id;
    const doc = createPwDataDoc(db, {
      betId,
      platform: "bilibili",
      collectedAt: "2026-08-02T00:00:00.000Z",
      metricsJson: '{"播放": 100, "点赞": 5}',
      rawRef: "ref-1",
    });
    const verdict = settlePwBet(db, betId, {
      outcome: "gold",
      lesson: "开头 30 秒放痛点有效",
      evidenceDocIds: [doc.id],
      asOfDate: "2026-08-02",
    });

    const detail = getPwVerdictDetail(db, verdict.id);
    assert.equal(detail.id, verdict.id);
    assert.equal(detail.outcome, "gold");
    assert.equal(detail.lesson, "开头 30 秒放痛点有效");
    assert.equal(detail.confidence_snapshot, 70);
    assert.ok(detail.decided_at);
    assert.equal(detail.bet_title, "直播做产品实践");
    assert.equal(detail.evidence_docs.length, 1);
    assert.equal(detail.evidence_docs[0].id, doc.id);
    assert.equal(detail.evidence_docs[0].platform, "bilibili");
    assert.equal(detail.evidence_docs[0].collected_at, "2026-08-02T00:00:00.000Z");
    assert.equal(detail.evidence_docs[0].metrics, '{"播放":100,"点赞":5}');

    assert.throws(() => getPwVerdictDetail(db, "missing"), (error: unknown) =>
      hasStatus(error, 404));
  } finally {
    db.close();
  }
});

test("connections：getPwConnectionStatus 单条/全量，risk_events 解析为数组", () => {
  const db = makeDb();
  try {
    const conn = registerPwConnection(db, { platform: "B站", accountLabel: "琴疏" });
    setPwConnectionStatus(db, conn.id, "needs_human", "出现滑块验证");
    setPwConnectionStatus(db, conn.id, "active");

    const all = getPwConnectionStatus(db) as Array<Record<string, unknown>>;
    assert.equal(all.length, 1);
    assert.deepEqual(all[0].risk_events, [{ at: all[0].risk_events[0].at, reason: "出现滑块验证" }]);
    assert.ok((all[0].risk_events as Array<{ at: string }>)[0].at);

    const single = getPwConnectionStatus(db, "B站") as {
      platform: string;
      status: string;
      last_sync_at: string | null;
      risk_events: Array<{ at: string; reason: string }>;
    };
    assert.equal(single.platform, "B站");
    assert.equal(single.account_label, "琴疏");
    assert.equal(single.status, "active");
    assert.equal(single.last_sync_at, null);
    assert.equal(single.risk_events.length, 1);
    assert.equal(single.risk_events[0].reason, "出现滑块验证");

    assert.throws(() => getPwConnectionStatus(db, "小红书"), (error: unknown) =>
      hasStatus(error, 404));
    assert.throws(() => getPwConnectionStatus(db, "  "), (error: unknown) =>
      hasStatus(error, 400));
  } finally {
    db.close();
  }
});

test("runs：listPwRuns created_at 倒序分页，kind/eventType/betId 过滤正确", () => {
  const db = makeDb();
  try {
    recordPwEvent(db, {
      id: "e1",
      bet_id: "bet-1",
      event_type: "create",
      payload_json: "{\"step\":1}",
      created_at: "2026-08-01T00:00:01.000Z",
    });
    recordPwEvent(db, {
      id: "e2",
      bet_id: "bet-1",
      kind: "sync",
      event_type: "data_doc",
      actor: "system",
      payload_json: "{}",
      created_at: "2026-08-01T00:00:02.000Z",
    });
    recordPwEvent(db, {
      id: "e3",
      bet_id: "bet-2",
      event_type: "settle",
      payload_json: "{}",
      created_at: "2026-08-01T00:00:03.000Z",
    });
    recordPwEvent(db, {
      id: "e4",
      bet_id: "bet-1",
      event_type: "attach",
      payload_json: "{}",
      created_at: "2026-08-01T00:00:04.000Z",
    });

    assert.deepEqual(listPwRuns(db).map((run) => run.id), ["e4", "e3", "e2", "e1"]);
    assert.deepEqual(listPwRuns(db, { betId: "bet-1" }).map((run) => run.id), ["e4", "e2", "e1"]);
    assert.deepEqual(listPwRuns(db, { kind: "sync" }).map((run) => run.id), ["e2"]);
    assert.deepEqual(listPwRuns(db, { eventType: "settle" }).map((run) => run.id), ["e3"]);
    assert.deepEqual(listPwRuns(db, { kind: "sync", eventType: "data_doc", betId: "bet-1" })
      .map((run) => run.id), ["e2"]);

    // 分页：limit 取最新；before 游标续取更早
    assert.deepEqual(listPwRuns(db, { limit: 2 }).map((run) => run.id), ["e4", "e3"]);
    const page = listPwRuns(db, { limit: 2 });
    assert.deepEqual(
      listPwRuns(db, { before: page[page.length - 1].created_at }).map((run) => run.id),
      ["e2", "e1"],
    );
    assert.deepEqual(
      listPwRuns(db, { before: "2026-08-01T00:00:04.000Z", limit: 1 }).map((run) => run.id),
      ["e3"],
    );

    assert.throws(() => listPwRuns(db, { kind: "bogus" }), /非法 kind/);
    assert.throws(() => listPwRuns(db, { eventType: "bogus" }), /非法 event_type/);
    assert.throws(() => listPwRuns(db, { limit: 0 }), /limit/);
    assert.throws(() => listPwRuns(db, { before: "" }), /before/);
  } finally {
    db.close();
  }
});

test("read_voice：dropped 条目不再出现（修复前后对照各断言一次）", async () => {
  const db = makeDb();
  try {
    const betId = makeBet(db);
    const artifact = attachPwArtifact(db, {
      betId,
      platform: "B站",
      type: "video",
      url: "https://b23.tv/BV1xx",
      title: "第1期成片",
    });
    const kept = addPwVoiceItem(db, {
      platform: "B站",
      content: "这条声音保留",
      author: "观众A",
      artifactId: artifact.id,
      capturedAt: "2026-08-01T00:00:00.000Z",
    });
    const dropped = addPwVoiceItem(db, {
      platform: "B站",
      content: "这条声音已丢弃",
      author: "观众B",
      artifactId: artifact.id,
      capturedAt: "2026-08-01T00:00:01.000Z",
    });
    const droppedRow = dropPwVoiceItem(db, dropped.id, "广告噪音");

    // 修复后：工具结果不再返回 dropped 条目，未过滤字段（content/signal_type）仍在
    const tool = pwCollabTools.find((candidate) => candidate.name === "read_voice");
    assert.ok(tool, "read_voice 工具存在");
    const result = await tool!.execute(
      "call-1",
      {},
      undefined,
      undefined,
      { db, betId, refs: new Map() } satisfies CollabToolContext,
    );
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    assert.ok(text.includes("这条声音保留"));
    assert.ok(!text.includes("这条声音已丢弃"));

    // 修复前对照：去掉 dropped 过滤的同一 SQL 仍能查出 dropped 条目
    const unfiltered = db.prepare(`
      SELECT v.content
      FROM pw_voice_items v
      JOIN pw_artifacts a ON a.id = v.artifact_id
      WHERE a.bet_id = ? AND a.detached_at IS NULL
      ORDER BY v.captured_at, v.id
    `).all(betId) as Array<{ content: string }>;
    assert.deepEqual(unfiltered.map((row) => row.content), ["这条声音保留", "这条声音已丢弃"]);
    assert.equal(kept.dropped_reason, null);
    assert.equal(droppedRow.dropped_reason, "广告噪音");
  } finally {
    db.close();
  }
});
