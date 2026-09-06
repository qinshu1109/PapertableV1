import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  authorizePwCorpus,
  donePwCorpus,
  ensurePwCorpusTables,
  readPwCorpusComments,
} from "./pw-corpus.ts";
import { ensurePwRunTables } from "./pw-runs.ts";
import {
  ensurePwVoiceSieveTables,
  getPwVoiceSieveRun,
  importPwVoiceSieveRun,
  listPwVoiceSieveRuns,
} from "./pw-voice-sieve.ts";

const BVID = "BV1dEuZ6mEii";
const NOW = "2026-08-11T10:00:00+08:00";

type Comment = { rpid: number; uname: string | null; message: string; like: number; ctime: number; replies: number };

/** 语料：8 条，4 条「对比」、1 条「价格」、1 条「建议」、2 条噪音。 */
const COMMENTS: Comment[] = [
  { rpid: 1, uname: "甲", message: "这个比 X 好用多了", like: 50, ctime: 1_700_000_000, replies: 0 },
  { rpid: 2, uname: "乙", message: "比 Y 还是差点", like: 40, ctime: 1_700_000_001, replies: 0 },
  { rpid: 3, uname: "丙", message: "两个都试过，Z 更稳", like: 30, ctime: 1_700_000_002, replies: 0 },
  { rpid: 4, uname: "丁", message: "对比还得看场景", like: 20, ctime: 1_700_000_003, replies: 0 },
  { rpid: 5, uname: "戊", message: "价格太贵了", like: 60, ctime: 1_700_000_004, replies: 0 },
  { rpid: 6, uname: "己", message: "希望加个批量导出", like: 5, ctime: 1_700_000_005, replies: 0 },
  { rpid: 7, uname: "庚", message: "笑死我了哈哈", like: 25, ctime: 1_700_000_006, replies: 0 },
  { rpid: 8, uname: "辛", message: "[脱单doge]", like: 10, ctime: 1_700_000_007, replies: 0 },
];

const VERDICT_LINES = [
  { rpid: "1", verdict: "signal", bucket: "对比", reason: "比较X与Y" },
  { rpid: "2", verdict: "signal", bucket: "对比", reason: "对比两方案" },
  { rpid: "3", verdict: "signal", bucket: "对比", reason: "实测对比" },
  { rpid: "4", verdict: "signal", bucket: "对比", reason: "对比看法" },
  { rpid: "5", verdict: "signal", bucket: "价格", reason: "吐槽价格" },
  { rpid: "6", verdict: "signal", bucket: "建议", reason: "功能建议" },
  { rpid: "7", verdict: "noise", bucket: null, reason: "玩梗无信息" },
  { rpid: "8", verdict: "noise", bucket: "null", reason: "纯表情" }, // 字符串 "null" 归一 NULL
];

type Fixture = {
  db: DatabaseSync;
  dataDir: string;
  resultsDir: string;
  commentsPath: string;
  cleanup: () => Promise<void>;
};

async function fixture(comments: Comment[] = COMMENTS, verdictLines: typeof VERDICT_LINES = VERDICT_LINES): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pw-voice-sieve-"));
  const dataDir = join(root, "data");
  const resultsDir = join(root, "results");
  await mkdir(resultsDir, { recursive: true });
  const db = new DatabaseSync(":memory:");
  ensurePwRunTables(db);
  ensurePwCorpusTables(db);
  ensurePwVoiceSieveTables(db);
  const commentsPath = join(root, "comments.jsonl");
  await writeFile(commentsPath, comments.map(JSON.stringify).join("\n") + "\n");
  await writeFile(join(resultsDir, "batch-01.jsonl"), verdictLines.map(JSON.stringify).join("\n") + "\n");
  return {
    db,
    dataDir,
    resultsDir,
    commentsPath,
    cleanup: async () => {
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function hasStatus(error: unknown, status: number): boolean {
  return typeof error === "object" && error !== null && "status" in error
    && (error as { status: unknown }).status === status;
}

function reconcileDetails(error: unknown): { ok: boolean; missing?: string[]; extra?: string[]; dup?: string[] } {
  return (error as { details: { reconcile: { ok: boolean; missing?: string[]; extra?: string[]; dup?: string[] } } }).details.reconcile;
}

test("导入成功：注册语料、落 run+items，返回对账通过与桶计数", async () => {
  const fx = await fixture();
  try {
    const result = importPwVoiceSieveRun(fx.db, {
      bvid: BVID, resultsPath: fx.resultsDir, commentsPath: fx.commentsPath,
      provider: "deepseek", model: "deepseek-v4-flash", reassigned: 2, reportPath: "/tmp/report.md",
    }, { dataDir: fx.dataDir, now: () => NOW });
    assert.ok(result.runId);
    assert.deepEqual({ total: result.total, signal: result.signal, noise: result.noise }, { total: 8, signal: 6, noise: 2 });
    assert.equal(result.reconcile.ok, true);
    assert.deepEqual(result.buckets["对比"], 4);
    assert.deepEqual(result.buckets["价格"], 1);
    assert.deepEqual(result.buckets["建议"], 1);
    assert.deepEqual(result.buckets["功能"], 0);
    assert.equal(result.buckets["null"], undefined, "无桶为 null 的信号时不出现 null 键");

    // 语料补录：pw_corpus_docs done，落盘文件与导入源一致
    const doc = fx.db.prepare("SELECT * FROM pw_corpus_docs WHERE bvid=?").get(BVID) as { status: string; comment_count: number };
    assert.equal(doc.status, "done");
    assert.equal(doc.comment_count, 8);
    const written = JSON.parse((await readFile(join(fx.dataDir, "corpus", BVID, "comments.jsonl"), "utf8")).split("\n")[0]);
    assert.equal(written.rpid, 1);
    assert.equal(written.message, "这个比 X 好用多了");

    // run + items 落库
    const run = fx.db.prepare("SELECT * FROM pw_voice_sieve_runs WHERE id=?").get(result.runId) as {
      bvid: string; total: number; signal: number; noise: number; reassigned: number; report_path: string; status: string;
    };
    assert.equal(run.bvid, BVID);
    assert.deepEqual([run.total, run.signal, run.noise, run.reassigned, run.report_path, run.status], [8, 6, 2, 2, "/tmp/report.md", "done"]);
    const rows = fx.db.prepare("SELECT * FROM pw_voice_sieve_items WHERE run_id=? ORDER BY rpid").all(result.runId) as Array<{ rpid: string; verdict: string; bucket: string | null }>;
    assert.equal(rows.length, 8);
    assert.equal(rows.find((row) => row.rpid === "8")!.bucket, null, "字符串 null 桶归一为 NULL");
  } finally {
    await fx.cleanup();
  }
});

test("对账缺漏拒绝：少一条判决不落库，400 带 missing 列表", async () => {
  const fx = await fixture(COMMENTS, VERDICT_LINES.filter((line) => line.rpid !== "5"));
  try {
    assert.throws(() => importPwVoiceSieveRun(fx.db, {
      bvid: BVID, resultsPath: fx.resultsDir, commentsPath: fx.commentsPath,
      provider: "deepseek", model: "mock",
    }, { dataDir: fx.dataDir }), (error: unknown) => {
      assert.equal(hasStatus(error, 400), true);
      assert.deepEqual(reconcileDetails(error).missing, ["5"]);
      assert.deepEqual(reconcileDetails(error).dup, []);
      assert.deepEqual(reconcileDetails(error).extra, []);
      return true;
    });
    assert.equal(listPwVoiceSieveRuns(fx.db, BVID).length, 0, "对账失败不落 run");
    assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM pw_voice_sieve_items").get()!.n, 0, "对账失败不落 items");
  } finally {
    await fx.cleanup();
  }
});

test("重复 rpid 拒绝：同一条判两遍 400 带 dup 列表，不落库", async () => {
  const verdicts = [...VERDICT_LINES, { rpid: "3", verdict: "signal", bucket: "对比", reason: "重复判决" }];
  const fx = await fixture(COMMENTS, verdicts);
  try {
    assert.throws(() => importPwVoiceSieveRun(fx.db, {
      bvid: BVID, resultsPath: fx.resultsDir, commentsPath: fx.commentsPath,
      provider: "deepseek", model: "mock",
    }, { dataDir: fx.dataDir }), (error: unknown) => {
      assert.equal(hasStatus(error, 400), true);
      assert.deepEqual(reconcileDetails(error).dup, ["3"]);
      return true;
    });
    assert.equal(listPwVoiceSieveRuns(fx.db, BVID).length, 0);
  } finally {
    await fx.cleanup();
  }
});

test("多余 rpid 拒绝：判决含语料外 rpid 400 带 extra 列表，不落库", async () => {
  const verdicts = [...VERDICT_LINES, { rpid: "9999", verdict: "noise", bucket: null, reason: "外来的" }];
  const fx = await fixture(COMMENTS, verdicts);
  try {
    assert.throws(() => importPwVoiceSieveRun(fx.db, {
      bvid: BVID, resultsPath: fx.resultsDir, commentsPath: fx.commentsPath,
      provider: "deepseek", model: "mock",
    }, { dataDir: fx.dataDir }), (error: unknown) => {
      assert.equal(hasStatus(error, 400), true);
      assert.deepEqual(reconcileDetails(error).extra, ["9999"]);
      return true;
    });
    assert.equal(listPwVoiceSieveRuns(fx.db, BVID).length, 0);
  } finally {
    await fx.cleanup();
  }
});

test("查询聚合结构：8 桶全量（空桶 0）、按 totalLikes 降序、top3 按赞降序、noise 全量", async () => {
  const fx = await fixture();
  try {
    const result = importPwVoiceSieveRun(fx.db, {
      bvid: BVID, resultsPath: fx.resultsDir, commentsPath: fx.commentsPath,
      provider: "deepseek", model: "mock",
    }, { dataDir: fx.dataDir, now: () => NOW });
    const detail = getPwVoiceSieveRun(fx.db, result.runId);

    assert.equal(detail.run.bvid, BVID);
    assert.deepEqual(detail.run.total, 8);
    assert.deepEqual(detail.run.signal, 6);
    assert.deepEqual(detail.run.noise, 2);
    assert.equal(detail.run.createdAt, NOW);

    // 8 桶全返回：对比 totalLikes=140 首位，价格 60 次之，建议 5，其余空桶 0（并列按固定桶序）
    assert.equal(detail.buckets.length, 8);
    assert.deepEqual(detail.buckets.map((bucket) => bucket.bucket),
      ["对比", "价格", "建议", "bug反馈", "功能", "求助", "场景", "评价"]);
    const compare = detail.buckets[0];
    assert.deepEqual({ bucket: compare.bucket, count: compare.count, totalLikes: compare.totalLikes }, { bucket: "对比", count: 4, totalLikes: 140 });
    assert.deepEqual(compare.top.map((item) => ({ rpid: item.rpid, like: item.like })), [
      { rpid: "1", like: 50 }, { rpid: "2", like: 40 }, { rpid: "3", like: 30 },
    ]);
    const empty = detail.buckets.find((bucket) => bucket.bucket === "功能")!;
    assert.deepEqual({ count: empty.count, totalLikes: empty.totalLikes, top: empty.top }, { count: 0, totalLikes: 0, top: [] });

    // signals：8 桶键全在，桶内赞降序，条目含 rpid/uname/message/like/ctime/reason
    assert.deepEqual(Object.keys(detail.signals).sort(), ["bug反馈", "功能", "评价", "对比", "求助", "场景", "价格", "建议"].sort());
    assert.equal(detail.signals["对比"].length, 4);
    assert.deepEqual(detail.signals["对比"].map((item) => item.like), [50, 40, 30, 20]);
    const item = detail.signals["对比"][0];
    assert.deepEqual({
      rpid: item.rpid, uname: item.uname, message: item.message, like: item.like, ctime: item.ctime, reason: item.reason,
    }, { rpid: "1", uname: "甲", message: "这个比 X 好用多了", like: 50, ctime: 1_700_000_000, reason: "比较X与Y" });
    assert.deepEqual(detail.signals["功能"], []);
    assert.equal("null" in detail.signals, false, "无桶为 null 的信号时不出现 null 键");

    // noise：全量按赞降序（25 在 10 前），rpid 8 的字符串 null 桶已归一
    assert.equal(detail.noise.length, 2);
    assert.deepEqual(detail.noise.map((item) => item.like), [25, 10]);
    assert.deepEqual(detail.noise.map((item) => item.bucket), [undefined, undefined]);
    assert.deepEqual(detail.noise.map((item) => item.rpid), ["7", "8"]);
  } finally {
    await fx.cleanup();
  }
});

test("爬虫原始 json 导入：拉平 replies、注册语料元数据、字符串 null 桶归一", async () => {
  const root = await mkdtemp(join(tmpdir(), "pw-voice-sieve-json-"));
  const db = new DatabaseSync(":memory:");
  ensurePwRunTables(db);
  ensurePwCorpusTables(db);
  ensurePwVoiceSieveTables(db);
  try {
    const dataDir = join(root, "data");
    const resultsDir = join(root, "results");
    await mkdir(resultsDir, { recursive: true });
    // B站 view 接口形态：{data:{title,owner,comments:[递归 replies]}}
    const rawJson = join(root, "raw.json");
    await writeFile(rawJson, JSON.stringify({
      data: {
        title: "实测视频",
        owner: { name: "某UP主", mid: 1 },
        comments: [
          { rpid: "101", text: "主评一", likes: 11, created_at: "2026-08-01T00:00:00.000Z", author: { name: "A" }, replies: [
            { rpid: "102", text: "楼中楼回复", likes: 2, created_at: "2026-08-01T00:01:00.000Z", author: { name: "B" }, replies: [] },
          ] },
          { rpid: "103", text: "主评二", likes: 0, created_at: "2026-08-01T00:02:00.000Z", author: { name: "C" }, replies: [] },
        ],
      },
    }));
    await writeFile(join(resultsDir, "batch-01.jsonl"), [
      JSON.stringify({ rpid: "101", verdict: "signal", bucket: "评价", reason: "主评" }),
      JSON.stringify({ rpid: "102", verdict: "noise", bucket: null, reason: "灌水" }),
      JSON.stringify({ rpid: "103", verdict: "signal", bucket: "场景", reason: "使用现状" }),
    ].join("\n") + "\n");
    const result = importPwVoiceSieveRun(db, {
      bvid: BVID, resultsPath: resultsDir, commentsPath: rawJson, provider: "deepseek", model: "mock",
    }, { dataDir });
    assert.deepEqual({ total: result.total, signal: result.signal, noise: result.noise }, { total: 3, signal: 2, noise: 1 });

    // 语料：拉平后 3 条；title/up_name 注册；ctime 由 ISO 转秒
    const doc = db.prepare("SELECT * FROM pw_corpus_docs WHERE bvid=?").get(BVID) as { title: string | null; up_name: string | null; comment_count: number };
    assert.deepEqual([doc.title, doc.up_name, doc.comment_count], ["实测视频", "某UP主", 3]);
    const comments = readPwCorpusComments(db, BVID);
    assert.deepEqual(comments.map((comment) => comment.rpid), [101, 102, 103]);
    assert.equal(comments[0].ctime, Math.floor(Date.parse("2026-08-01T00:00:00.000Z") / 1000));
    assert.equal(comments[0].replies, 1);
    assert.equal(comments[1].message, "楼中楼回复");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("既有 done 语料复用：导入不重写语料文件，按既有语料对账", async () => {
  const root = await mkdtemp(join(tmpdir(), "pw-voice-sieve-reuse-"));
  const db = new DatabaseSync(":memory:");
  ensurePwRunTables(db);
  ensurePwCorpusTables(db);
  ensurePwVoiceSieveTables(db);
  try {
    const dataDir = join(root, "data");
    const corpusDir = join(dataDir, "corpus", BVID);
    await mkdir(corpusDir, { recursive: true });
    const existingLines = [
      { rpid: 1, uname: "原甲", message: "既有的原文一", like: 90, ctime: 1_700_000_100, replies: 0 },
      { rpid: 2, uname: "原乙", message: "既有的原文二", like: 80, ctime: 1_700_000_101, replies: 0 },
    ];
    await writeFile(join(corpusDir, "comments.jsonl"), existingLines.map(JSON.stringify).join("\n") + "\n");
    const { doc } = authorizePwCorpus(db, { bvid: BVID });
    donePwCorpus(db, doc.id, { path: corpusDir, comments: existingLines, commentCount: 2 });

    const resultsDir = join(root, "results");
    await mkdir(resultsDir, { recursive: true });
    await writeFile(join(resultsDir, "batch-01.jsonl"), [
      JSON.stringify({ rpid: "1", verdict: "signal", bucket: "评价", reason: "好" }),
      JSON.stringify({ rpid: "2", verdict: "signal", bucket: "功能", reason: "咨询" }),
    ].join("\n") + "\n");
    // commentsPath 指向另一份（应被忽略），导入必须复用既有语料
    const otherComments = join(root, "other.jsonl");
    await writeFile(otherComments, COMMENTS.map(JSON.stringify).join("\n") + "\n");
    const result = importPwVoiceSieveRun(db, {
      bvid: BVID, resultsPath: resultsDir, commentsPath: otherComments, provider: "deepseek", model: "mock",
    }, { dataDir });
    assert.equal(result.total, 2);

    const detail = getPwVoiceSieveRun(db, result.runId);
    assert.deepEqual(detail.signals["评价"][0].message, "既有的原文一", "按既有语料 join");
    const onDisk = await readFile(join(corpusDir, "comments.jsonl"), "utf8");
    assert.equal(onDisk, existingLines.map(JSON.stringify).join("\n") + "\n", "既有语料文件一字不动");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("非法输入：bad bvid / 缺 provider / 目录无 batch 文件 都 400 且不落库", async () => {
  const fx = await fixture();
  try {
    const base = { resultsPath: fx.resultsDir, commentsPath: fx.commentsPath, provider: "deepseek", model: "mock" };
    assert.throws(() => importPwVoiceSieveRun(fx.db, { ...base, bvid: "av123" }, { dataDir: fx.dataDir }), (error: unknown) => hasStatus(error, 400));
    assert.throws(() => importPwVoiceSieveRun(fx.db, { ...base, bvid: BVID, provider: "" }, { dataDir: fx.dataDir }), (error: unknown) => hasStatus(error, 400));
    const emptyDir = join(fx.resultsDir, "empty");
    await mkdir(emptyDir);
    assert.throws(() => importPwVoiceSieveRun(fx.db, { ...base, bvid: BVID, resultsPath: emptyDir }, { dataDir: fx.dataDir }), (error: unknown) => hasStatus(error, 400));
    assert.equal(listPwVoiceSieveRuns(fx.db, BVID).length, 0);
  } finally {
    await fx.cleanup();
  }
});
