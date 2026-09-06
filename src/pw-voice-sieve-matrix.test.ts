import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ensurePwCorpusTables } from "./pw-corpus.ts";
import { ensurePwRunTables } from "./pw-runs.ts";
import {
  ensurePwVoiceSieveTables,
  getPwVoiceSieveMatrix,
  importPwVoiceSieveRun,
  PW_VOICE_SIEVE_BUCKETS,
} from "./pw-voice-sieve.ts";

const BVID = "BV1dEuZ6mEii";
const NOW_A = "2026-08-11T10:00:00+08:00";
const NOW_B = "2026-08-11T11:00:00+08:00";

type Comment = { rpid: number; uname: string | null; message: string; like: number | null; ctime: number; replies: number };
type Verdict = { rpid: string; verdict: "signal" | "noise"; bucket: string | null; reason: string | null };

const COMMENTS_6: Comment[] = [
  { rpid: 1, uname: "甲", message: "评论一", like: 50, ctime: 1_700_000_000, replies: 0 },
  { rpid: 2, uname: "乙", message: "评论二", like: 40, ctime: 1_700_000_001, replies: 0 },
  { rpid: 3, uname: "丙", message: "评论三", like: 30, ctime: 1_700_000_002, replies: 0 },
  { rpid: 4, uname: "丁", message: "评论四", like: 20, ctime: 1_700_000_003, replies: 0 },
  { rpid: 5, uname: "戊", message: "评论五", like: 10, ctime: 1_700_000_004, replies: 0 },
  { rpid: 6, uname: "己", message: "评论六", like: 5, ctime: 1_700_000_005, replies: 0 },
];

type Fixture = {
  db: DatabaseSync;
  dataDir: string;
  commentsPath: string;
  root: string;
  cleanup: () => Promise<void>;
};

async function fixture(comments: Comment[]): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pw-voice-sieve-matrix-"));
  const dataDir = join(root, "data");
  const db = new DatabaseSync(":memory:");
  ensurePwRunTables(db);
  ensurePwCorpusTables(db);
  ensurePwVoiceSieveTables(db);
  const commentsPath = join(root, "comments.jsonl");
  await writeFile(commentsPath, comments.map(JSON.stringify).join("\n") + "\n");
  return {
    db,
    dataDir,
    commentsPath,
    root,
    cleanup: async () => {
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** 单独一个 results 目录导一次 run，返回 runId。 */
async function importRun(
  fx: Fixture,
  dirName: string,
  verdicts: Verdict[],
  provider: string,
  model: string,
  now: string,
): Promise<string> {
  const dir = join(fx.root, dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "batch-01.jsonl"), verdicts.map(JSON.stringify).join("\n") + "\n");
  return importPwVoiceSieveRun(fx.db, {
    bvid: BVID,
    resultsPath: dir,
    commentsPath: fx.commentsPath,
    provider,
    model,
  }, { dataDir: fx.dataDir, now: () => now }).runId;
}

function hasStatus(error: unknown, status: number): boolean {
  return typeof error === "object" && error !== null && "status" in error
    && (error as { status: unknown }).status === status;
}

/** 语料 6 条时每个 run 都得给出全部 6 条判决，否则对账 400。 */
const NOISE_3_4_5_6: Verdict[] = [
  { rpid: "3", verdict: "noise", bucket: null, reason: "n3" },
  { rpid: "4", verdict: "noise", bucket: null, reason: "n4" },
  { rpid: "5", verdict: "noise", bucket: null, reason: "n5" },
  { rpid: "6", verdict: "noise", bucket: null, reason: "n6" },
];

test("两个 run（不同家族）部分重合：复现 signalRunCount=2/familyCount=2、异议各 1、一桶两版计数不同", async () => {
  const fx = await fixture(COMMENTS_6);
  try {
    const runA = await importRun(fx, "a", [
      { rpid: "1", verdict: "signal", bucket: "对比", reason: "r1a" },
      { rpid: "2", verdict: "signal", bucket: "功能", reason: "r2a" },
      { rpid: "3", verdict: "signal", bucket: "功能", reason: "r3a" },
      ...NOISE_3_4_5_6.filter((v) => v.rpid !== "3"),
    ], "deepseek", "mock", NOW_A);
    const runB = await importRun(fx, "b", [
      { rpid: "1", verdict: "signal", bucket: "对比", reason: "r1b" },
      { rpid: "2", verdict: "signal", bucket: "功能", reason: "r2b" },
      { rpid: "4", verdict: "signal", bucket: "建议", reason: "r4b" },
      ...NOISE_3_4_5_6.filter((v) => v.rpid !== "4"),
    ], "openai", "mock", NOW_B);

    const matrix = getPwVoiceSieveMatrix(fx.db, BVID);
    assert.equal(matrix.bvid, BVID);
    // runs：created_at 新在前（B 晚于 A），带 family
    assert.deepEqual(matrix.runs.map((run) => run.id), [runB, runA]);
    assert.equal(matrix.runs[0].family, "openai/mock");
    assert.equal(matrix.runs[1].family, "deepseek/mock");
    assert.deepEqual(matrix.summary, {
      runCount: 2,
      familyCount: 2,
      unionSignals: 4,
      consensusSignals: 2,
      singletonSignals: 2,
    });

    const byRpid = new Map(matrix.items.map((item) => [item.rpid, item]));
    assert.deepEqual([...byRpid.keys()].sort(), ["1", "2", "3", "4"], "任一版本判过信号的 rpid 并集");
    // 复现：两版都挑
    assert.equal(byRpid.get("1")!.signalRunCount, 2);
    assert.equal(byRpid.get("1")!.familyCount, 2);
    assert.deepEqual(byRpid.get("1")!.noiseRuns, []);
    assert.equal(byRpid.get("2")!.signalRunCount, 2);
    assert.equal(byRpid.get("2")!.familyCount, 2);
    // 异议：只有一版挑，另一版标噪音
    assert.equal(byRpid.get("3")!.signalRunCount, 1);
    assert.equal(byRpid.get("3")!.familyCount, 1);
    assert.deepEqual(byRpid.get("3")!.noiseRuns, [runB]);
    assert.equal(byRpid.get("4")!.signalRunCount, 1);
    assert.deepEqual(byRpid.get("4")!.noiseRuns, [runA]);

    // 桶矩阵：功能桶两版计数不同（A=2、B=1），total=3
    const func = matrix.bucketMatrix.find((bucket) => bucket.bucket === "功能")!;
    assert.equal(func.total, 3);
    assert.deepEqual(
      func.perRun.map((entry) => ({ runId: entry.runId, count: entry.count })),
      [{ runId: runB, count: 1 }, { runId: runA, count: 2 }],
    );
  } finally {
    await fx.cleanup();
  }
});

test("同家族两版（同 provider+model）：重合 rpid signalRunCount=2 但 familyCount=1（伪复现不加分）", async () => {
  const fx = await fixture(COMMENTS_6);
  try {
    await importRun(fx, "a", [
      { rpid: "1", verdict: "signal", bucket: "对比", reason: "r1a" },
      { rpid: "2", verdict: "signal", bucket: "功能", reason: "r2a" },
      ...NOISE_3_4_5_6,
    ], "deepseek", "mock", NOW_A);
    await importRun(fx, "b", [
      { rpid: "1", verdict: "signal", bucket: "对比", reason: "r1b" },
      { rpid: "2", verdict: "signal", bucket: "功能", reason: "r2b" },
      ...NOISE_3_4_5_6,
    ], "deepseek", "mock", NOW_B);

    const matrix = getPwVoiceSieveMatrix(fx.db, BVID);
    assert.equal(matrix.summary.familyCount, 1, "同 provider+model 只算一个家族");
    assert.equal(matrix.summary.unionSignals, 2);
    assert.equal(matrix.summary.consensusSignals, 2);
    const item = matrix.items.find((entry) => entry.rpid === "1")!;
    assert.equal(item.signalRunCount, 2);
    assert.equal(item.signalRuns.length, 2);
    assert.equal(item.familyCount, 1, "同家族两版不因伪复现加分");
  } finally {
    await fx.cleanup();
  }
});

test("分歧 rpid：A 版 signal（带桶）B 版 noise → signalRuns 一条、noiseRuns 含 B", async () => {
  const fx = await fixture(COMMENTS_6);
  try {
    const runA = await importRun(fx, "a", [
      { rpid: "1", verdict: "signal", bucket: "功能", reason: "r1a" },
      { rpid: "2", verdict: "noise", bucket: null, reason: "n2a" },
      { rpid: "3", verdict: "noise", bucket: null, reason: "n3a" },
      { rpid: "4", verdict: "noise", bucket: null, reason: "n4a" },
      { rpid: "5", verdict: "noise", bucket: null, reason: "n5a" },
      { rpid: "6", verdict: "noise", bucket: null, reason: "n6a" },
    ], "deepseek", "mock", NOW_A);
    const runB = await importRun(fx, "b", [
      { rpid: "1", verdict: "noise", bucket: null, reason: "n1b" },
      { rpid: "2", verdict: "signal", bucket: "价格", reason: "r2b" },
      { rpid: "3", verdict: "noise", bucket: null, reason: "n3b" },
      { rpid: "4", verdict: "noise", bucket: null, reason: "n4b" },
      { rpid: "5", verdict: "noise", bucket: null, reason: "n5b" },
      { rpid: "6", verdict: "noise", bucket: null, reason: "n6b" },
    ], "openai", "mock", NOW_B);

    const matrix = getPwVoiceSieveMatrix(fx.db, BVID);
    const item1 = matrix.items.find((entry) => entry.rpid === "1")!;
    assert.equal(item1.signalRunCount, 1);
    assert.deepEqual(
      (item1.signalRuns as Array<{ runId: string; bucket?: string }>).map((s) => ({ runId: s.runId, bucket: s.bucket })),
      [{ runId: runA, bucket: "功能" }],
    );
    assert.deepEqual(item1.noiseRuns, [runB]);
    const item2 = matrix.items.find((entry) => entry.rpid === "2")!;
    assert.deepEqual((item2.signalRuns as Array<{ runId: string }>).map((s) => s.runId), [runB]);
    assert.deepEqual(item2.noiseRuns, [runA]);
  } finally {
    await fx.cleanup();
  }
});

test("同 rpid 两版判不同桶：signalRuns 两条各自带桶", async () => {
  const fx = await fixture(COMMENTS_6);
  try {
    const runA = await importRun(fx, "a", [
      { rpid: "1", verdict: "signal", bucket: "对比", reason: "r1a" },
      { rpid: "2", verdict: "signal", bucket: "功能", reason: "r2a" },
      { rpid: "3", verdict: "noise", bucket: null, reason: "n3a" },
      { rpid: "4", verdict: "noise", bucket: null, reason: "n4a" },
      { rpid: "5", verdict: "noise", bucket: null, reason: "n5a" },
      { rpid: "6", verdict: "noise", bucket: null, reason: "n6a" },
    ], "deepseek", "mock", NOW_A);
    const runB = await importRun(fx, "b", [
      { rpid: "1", verdict: "signal", bucket: "建议", reason: "r1b" },
      { rpid: "2", verdict: "noise", bucket: null, reason: "n2b" },
      { rpid: "3", verdict: "signal", bucket: "场景", reason: "r3b" },
      { rpid: "4", verdict: "noise", bucket: null, reason: "n4b" },
      { rpid: "5", verdict: "noise", bucket: null, reason: "n5b" },
      { rpid: "6", verdict: "noise", bucket: null, reason: "n6b" },
    ], "openai", "mock", NOW_B);

    const matrix = getPwVoiceSieveMatrix(fx.db, BVID);
    const item1 = matrix.items.find((entry) => entry.rpid === "1")!;
    assert.equal(item1.signalRunCount, 2);
    const bucketByRun = new Map(
      (item1.signalRuns as Array<{ runId: string; bucket?: string }>).map((s) => [s.runId, s.bucket]),
    );
    assert.equal(bucketByRun.get(runA), "对比");
    assert.equal(bucketByRun.get(runB), "建议");
  } finally {
    await fx.cleanup();
  }
});

test("无 run 的 bvid 返回 200 空结构；缺 bvid 参数抛 400", async () => {
  const fx = await fixture(COMMENTS_6);
  try {
    const matrix = getPwVoiceSieveMatrix(fx.db, "BV1aaaaaaaaaa");
    assert.equal(matrix.bvid, "BV1aaaaaaaaaa");
    assert.deepEqual(matrix.runs, []);
    assert.deepEqual(matrix.summary, {
      runCount: 0,
      familyCount: 0,
      unionSignals: 0,
      consensusSignals: 0,
      singletonSignals: 0,
    });
    assert.deepEqual(matrix.items, []);
    assert.equal(matrix.bucketMatrix.length, 8, "8 桶恒在");
    assert.deepEqual(
      matrix.bucketMatrix.map((bucket) => bucket.bucket),
      PW_VOICE_SIEVE_BUCKETS.slice(),
      "空结构按桶原序",
    );
    for (const bucket of matrix.bucketMatrix) {
      assert.equal(bucket.total, 0);
      assert.deepEqual(bucket.perRun, []);
    }

    assert.throws(() => getPwVoiceSieveMatrix(fx.db, ""), (error: unknown) => {
      assert.equal(hasStatus(error, 400), true);
      assert.ok(String((error as Error).message).includes("bvid 必填"));
      return true;
    });
  } finally {
    await fx.cleanup();
  }
});

test("排序：signalRunCount 降序 → 并列按 like 降序（null 垫底）", async () => {
  const comments: Comment[] = [
    { rpid: 1, uname: "u1", message: "m1", like: 10, ctime: 1, replies: 0 },
    { rpid: 2, uname: "u2", message: "m2", like: 20, ctime: 2, replies: 0 },
    { rpid: 3, uname: "u3", message: "m3", like: 30, ctime: 3, replies: 0 },
    { rpid: 4, uname: "u4", message: "m4", like: 40, ctime: 4, replies: 0 },
    { rpid: 5, uname: "u5", message: "m5", like: 50, ctime: 5, replies: 0 },
    { rpid: 6, uname: "u6", message: "m6", like: 60, ctime: 6, replies: 0 },
    { rpid: 7, uname: "u7", message: "m7", like: null, ctime: 7, replies: 0 },
  ];
  const fx = await fixture(comments);
  try {
    await importRun(fx, "a", [
      { rpid: "1", verdict: "signal", bucket: "对比", reason: "r1a" },
      { rpid: "2", verdict: "signal", bucket: "功能", reason: "r2a" },
      { rpid: "3", verdict: "signal", bucket: "功能", reason: "r3a" },
      { rpid: "7", verdict: "signal", bucket: "建议", reason: "r7a" },
      { rpid: "4", verdict: "noise", bucket: null, reason: "n4a" },
      { rpid: "5", verdict: "noise", bucket: null, reason: "n5a" },
      { rpid: "6", verdict: "noise", bucket: null, reason: "n6a" },
    ], "deepseek", "mock", NOW_A);
    await importRun(fx, "b", [
      { rpid: "1", verdict: "signal", bucket: "对比", reason: "r1b" },
      { rpid: "4", verdict: "signal", bucket: "建议", reason: "r4b" },
      { rpid: "2", verdict: "noise", bucket: null, reason: "n2b" },
      { rpid: "3", verdict: "noise", bucket: null, reason: "n3b" },
      { rpid: "5", verdict: "noise", bucket: null, reason: "n5b" },
      { rpid: "6", verdict: "noise", bucket: null, reason: "n6b" },
      { rpid: "7", verdict: "noise", bucket: null, reason: "n7b" },
    ], "openai", "mock", NOW_B);

    const matrix = getPwVoiceSieveMatrix(fx.db, BVID);
    assert.deepEqual(
      matrix.items.map((item) => item.rpid),
      ["1", "4", "3", "2", "7"],
      "count=2 在最前；count=1 组按 like 降序，like null 垫底",
    );
    assert.deepEqual(matrix.items.map((item) => item.like), [10, 40, 30, 20, null]);
  } finally {
    await fx.cleanup();
  }
});
