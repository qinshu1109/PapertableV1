import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ensurePwCorpusTables } from "./pw-corpus.ts";
import { ensurePwRunTables } from "./pw-runs.ts";
import {
  addPwVoiceTrackVideo,
  aggregatePwVoiceTrack,
  createPwVoiceTrack,
  ensurePwVoiceSieveTables,
  ensurePwVoiceTrackTables,
  importPwVoiceSieveRun,
  listPwVoiceTracks,
  removePwVoiceTrackVideo,
} from "./pw-voice-sieve.ts";

const BVID_A = "BV1dEuZ6mEii";
const BVID_B = "BV1Ncs1z2Ego";
const BVID_C = "BV1Tq4y1k7mJ"; // 只挂不筛，无 run
const NOW = "2026-08-12T10:00:00+08:00";

type Comment = { rpid: number; uname: string; message: string; like: number; ctime: number; replies: number };
type Verdict = { rpid: string; verdict: string; bucket: string | null; reason: string };

/** A：4 条对比 + 1 条价格 + 1 条噪音（signal 5 / noise 1）。 */
const COMMENTS_A: Comment[] = [
  { rpid: 101, uname: "A甲", message: "这个比 X 好用多了", like: 50, ctime: 1_700_000_000, replies: 0 },
  { rpid: 102, uname: "A乙", message: "比 Y 还是差点", like: 40, ctime: 1_700_000_001, replies: 0 },
  { rpid: 103, uname: "A丙", message: "两个都试过，Z 更稳", like: 30, ctime: 1_700_000_002, replies: 0 },
  { rpid: 104, uname: "A丁", message: "对比还得看场景", like: 20, ctime: 1_700_000_003, replies: 0 },
  { rpid: 105, uname: "A戊", message: "价格太贵了", like: 60, ctime: 1_700_000_004, replies: 0 },
  { rpid: 106, uname: "A己", message: "笑死我了哈哈", like: 25, ctime: 1_700_000_005, replies: 0 },
];
const VERDICTS_A: Verdict[] = [
  { rpid: "101", verdict: "signal", bucket: "对比", reason: "比较X与Y" },
  { rpid: "102", verdict: "signal", bucket: "对比", reason: "对比两方案" },
  { rpid: "103", verdict: "signal", bucket: "对比", reason: "实测对比" },
  { rpid: "104", verdict: "signal", bucket: "对比", reason: "对比看法" },
  { rpid: "105", verdict: "signal", bucket: "价格", reason: "吐槽价格" },
  { rpid: "106", verdict: "noise", bucket: null, reason: "玩梗无信息" },
];

/** B：2 条对比 + 1 条求助 + 1 条噪音（signal 3 / noise 1）。 */
const COMMENTS_B: Comment[] = [
  { rpid: 201, uname: "B甲", message: "另一条视频的对比一", like: 100, ctime: 1_700_000_100, replies: 0 },
  { rpid: 202, uname: "B乙", message: "另一条视频的对比二", like: 15, ctime: 1_700_000_101, replies: 0 },
  { rpid: 203, uname: "B丙", message: "求个使用教程", like: 45, ctime: 1_700_000_102, replies: 0 },
  { rpid: 204, uname: "B丁", message: "凑个热闹", like: 3, ctime: 1_700_000_103, replies: 0 },
];
const VERDICTS_B: Verdict[] = [
  { rpid: "201", verdict: "signal", bucket: "对比", reason: "对比观点" },
  { rpid: "202", verdict: "signal", bucket: "对比", reason: "对比数据" },
  { rpid: "203", verdict: "signal", bucket: "求助", reason: "求教程" },
  { rpid: "204", verdict: "noise", bucket: null, reason: "灌水" },
];

type Fixture = {
  db: DatabaseSync;
  dataDir: string;
  resultsDir: string;
  commentsPath: (bvid: string) => string;
  cleanup: () => Promise<void>;
};

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pw-voice-track-"));
  const dataDir = join(root, "data");
  const resultsDir = join(root, "results");
  const db = new DatabaseSync(":memory:");
  ensurePwRunTables(db);
  ensurePwCorpusTables(db);
  ensurePwVoiceSieveTables(db);
  ensurePwVoiceTrackTables(db);
  return {
    db,
    dataDir,
    resultsDir,
    commentsPath: (bvid) => join(root, `comments-${bvid}.jsonl`),
    cleanup: async () => {
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** 给一个视频写语料 + 判决并导入一次 run，返回 runId。 */
async function seedVideo(fx: Fixture, bvid: string, comments: Comment[], verdicts: Verdict[]): Promise<string> {
  await writeFile(fx.commentsPath(bvid), comments.map(JSON.stringify).join("\n") + "\n");
  const dir = join(fx.resultsDir, bvid);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "batch-01.jsonl"), verdicts.map(JSON.stringify).join("\n") + "\n");
  const result = importPwVoiceSieveRun(fx.db, {
    bvid, resultsPath: dir, commentsPath: fx.commentsPath(bvid),
    provider: "deepseek", model: "mock",
  }, { dataDir: fx.dataDir, now: () => NOW });
  return result.runId;
}

function hasStatus(error: unknown, status: number): boolean {
  return typeof error === "object" && error !== null && "status" in error
    && (error as { status: unknown }).status === status;
}

test("建赛道/挂视频幂等/非法输入", async () => {
  const fx = await fixture();
  try {
    const created = createPwVoiceTrack(fx.db, "求助需求池", { now: () => NOW });
    assert.ok(created.id);
    assert.deepEqual({ name: created.name, createdAt: created.createdAt }, { name: "求助需求池", createdAt: NOW });

    const listed = listPwVoiceTracks(fx.db);
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0], { id: created.id, name: "求助需求池", createdAt: NOW, videos: [] });

    // 挂视频 + 重复挂幂等
    assert.deepEqual(addPwVoiceTrackVideo(fx.db, created.id, BVID_A).videos, [BVID_A]);
    assert.deepEqual(addPwVoiceTrackVideo(fx.db, created.id, BVID_A).videos, [BVID_A], "重复挂同视频幂等");
    assert.deepEqual(addPwVoiceTrackVideo(fx.db, created.id, BVID_B).videos, [BVID_A, BVID_B]);
    assert.deepEqual(listPwVoiceTracks(fx.db)[0].videos, [BVID_A, BVID_B]);

    // 非法输入：坏 bvid / 空名 / 赛道不存在
    assert.throws(() => addPwVoiceTrackVideo(fx.db, created.id, "av123"), (error: unknown) => hasStatus(error, 400));
    assert.throws(() => createPwVoiceTrack(fx.db, "   "), (error: unknown) => hasStatus(error, 400));
    assert.throws(() => addPwVoiceTrackVideo(fx.db, "no-such-track", BVID_A), (error: unknown) => hasStatus(error, 404));
    assert.throws(() => aggregatePwVoiceTrack(fx.db, "no-such-track"), (error: unknown) => hasStatus(error, 404));
  } finally {
    await fx.cleanup();
  }
});

test("聚合跨视频合并：桶 count 合并、条目带 bvid、8 桶全返按 totalLikes 降序", async () => {
  const fx = await fixture();
  try {
    const trackId = createPwVoiceTrack(fx.db, "对比争议", { now: () => NOW }).id;
    const runA = await seedVideo(fx, BVID_A, COMMENTS_A, VERDICTS_A);
    const runB = await seedVideo(fx, BVID_B, COMMENTS_B, VERDICTS_B);
    addPwVoiceTrackVideo(fx.db, trackId, BVID_A);
    addPwVoiceTrackVideo(fx.db, trackId, BVID_B);

    const agg = aggregatePwVoiceTrack(fx.db, trackId);
    assert.deepEqual(agg.track, { id: trackId, name: "对比争议" });

    // videos：两个都有 run，signal/noise 取各自 run 计数
    assert.equal(agg.videos.length, 2);
    const va = agg.videos.find((v) => v.bvid === BVID_A)!;
    assert.deepEqual({ runId: va.runId, signal: va.signal, noise: va.noise, hasRun: va.hasRun },
      { runId: runA, signal: 5, noise: 1, hasRun: true });
    const vb = agg.videos.find((v) => v.bvid === BVID_B)!;
    assert.deepEqual({ runId: vb.runId, signal: vb.signal, noise: vb.noise, hasRun: vb.hasRun },
      { runId: runB, signal: 3, noise: 1, hasRun: true });

    // 8 桶全返，按 totalLikes 降序：对比(255) > 价格(60) > 求助(45)，空桶并列按固定桶序
    assert.equal(agg.buckets.length, 8);
    assert.deepEqual(agg.buckets.map((bucket) => bucket.bucket),
      ["对比", "价格", "求助", "bug反馈", "功能", "场景", "建议", "评价"]);
    const compare = agg.buckets[0];
    assert.deepEqual({ bucket: compare.bucket, count: compare.count, totalLikes: compare.totalLikes },
      { bucket: "对比", count: 6, totalLikes: 255 });
    // top 跨视频按赞降序前 3，条目带 bvid
    assert.deepEqual(compare.top.map((item) => ({ bvid: item.bvid, rpid: item.rpid, like: item.like })), [
      { bvid: BVID_B, rpid: "201", like: 100 },
      { bvid: BVID_A, rpid: "101", like: 50 },
      { bvid: BVID_A, rpid: "102", like: 40 },
    ]);
    const empty = agg.buckets.find((bucket) => bucket.bucket === "建议")!;
    assert.deepEqual({ count: empty.count, totalLikes: empty.totalLikes, top: empty.top },
      { count: 0, totalLikes: 0, top: [] });

    // signals：8 桶键全在、桶内赞降序、条目带 bvid 标注来源
    assert.equal(agg.signals["对比"].length, 6);
    assert.deepEqual(agg.signals["对比"].map((item) => item.like), [100, 50, 40, 30, 20, 15]);
    assert.equal(agg.signals["对比"][0].bvid, BVID_B);
    assert.equal(agg.signals["对比"][1].bvid, BVID_A);
    const help = agg.signals["求助"][0];
    assert.deepEqual({
      bvid: help.bvid, rpid: help.rpid, uname: help.uname, message: help.message,
      like: help.like, ctime: help.ctime, reason: help.reason,
    }, { bvid: BVID_B, rpid: "203", uname: "B丙", message: "求个使用教程", like: 45, ctime: 1_700_000_102, reason: "求教程" });
    assert.deepEqual(agg.signals["建议"], []);
    assert.equal("null" in agg.signals, false, "无桶为 null 的信号时不出现 null 键");
  } finally {
    await fx.cleanup();
  }
});

test("无 run 视频：hasRun:false 留在 videos，不出桶", async () => {
  const fx = await fixture();
  try {
    const trackId = createPwVoiceTrack(fx.db, "需求池", { now: () => NOW }).id;
    await seedVideo(fx, BVID_A, COMMENTS_A, VERDICTS_A);
    addPwVoiceTrackVideo(fx.db, trackId, BVID_A);
    addPwVoiceTrackVideo(fx.db, trackId, BVID_C); // 只挂不筛

    const agg = aggregatePwVoiceTrack(fx.db, trackId);
    assert.equal(agg.videos.length, 2);
    assert.deepEqual(agg.videos.find((v) => v.bvid === BVID_C),
      { bvid: BVID_C, runId: null, signal: null, noise: null, hasRun: false });
    assert.equal(agg.videos.find((v) => v.bvid === BVID_A)!.hasRun, true);
    assert.equal(agg.signals["对比"].length, 4);
    assert.equal(agg.signals["对比"].every((item) => item.bvid === BVID_A), true, "桶里只含 A 的信号");
    assert.equal(agg.signals["价格"][0].bvid, BVID_A);
  } finally {
    await fx.cleanup();
  }
});

test("摘视频：列表与聚合同步移除该视频", async () => {
  const fx = await fixture();
  try {
    const trackId = createPwVoiceTrack(fx.db, "对比争议", { now: () => NOW }).id;
    await seedVideo(fx, BVID_A, COMMENTS_A, VERDICTS_A);
    await seedVideo(fx, BVID_B, COMMENTS_B, VERDICTS_B);
    addPwVoiceTrackVideo(fx.db, trackId, BVID_A);
    addPwVoiceTrackVideo(fx.db, trackId, BVID_B);

    assert.deepEqual(removePwVoiceTrackVideo(fx.db, trackId, BVID_A).videos, [BVID_B]);
    assert.deepEqual(listPwVoiceTracks(fx.db)[0].videos, [BVID_B]);

    const agg = aggregatePwVoiceTrack(fx.db, trackId);
    assert.deepEqual(agg.videos.map((v) => v.bvid), [BVID_B]);
    assert.equal(agg.signals["价格"].length, 0, "A 的条目随摘下移除");
    assert.deepEqual(agg.signals["对比"].map((item) => item.bvid), [BVID_B, BVID_B]);
    assert.deepEqual(agg.signals["对比"].map((item) => item.like), [100, 15]);

    // 摘不存在的视频幂等；摘不存在的赛道 404
    assert.deepEqual(removePwVoiceTrackVideo(fx.db, trackId, BVID_A).videos, [BVID_B]);
    assert.throws(() => removePwVoiceTrackVideo(fx.db, "no-such", BVID_B), (error: unknown) => hasStatus(error, 404));
  } finally {
    await fx.cleanup();
  }
});
