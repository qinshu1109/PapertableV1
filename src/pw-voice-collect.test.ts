/**
 * TASK-PW-46：语料评论双通路测试。
 * 覆盖规格第 3 条全部用例：
 * 1. 收录成功（platform 格式/逐字/author/capturedAt=ctime 转换/自动分拣 spy 触发）；
 * 2. 409 带既有声音 id；
 * 3. 404 rpid 不存在；
 * 4. collected 标记两态（含分页）；
 * 5. dropped 后可再收录（旧条不参与防重，丢弃留痕保留）。
 * 另补：uname 为空 → author 匿名；ctime 为空 → capturedAt 当前刻。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { authorizePwCorpus, donePwCorpus, ensurePwCorpusTables } from "./pw-corpus.ts";
import { ensurePwRunTables } from "./pw-runs.ts";
import { dropPwVoiceItem, ensurePwVoiceTables, setPwVoiceAutoClassifier } from "./pw-voice.ts";
import { collectPwCorpusComment, listPwVoiceCorpusComments } from "./pw-voice-promote.ts";

type Json = Record<string, unknown>;

const BV1 = "BV1NprhBPEtR";

const COMMENTS = [
  { rpid: 101, uname: "甲", message: "这条评论一", like: 12, ctime: 1700000001, replies: 3 },
  { rpid: 102, uname: null, message: "匿名评论二", like: 8, ctime: 1700000002, replies: 0 },
  { rpid: 103, uname: "丙", message: "无时间评论三", like: 5, ctime: null, replies: 1 },
];

const META = {
  bvid: BV1,
  aid: 123456,
  title: "测试成片",
  up_name: "某UP主",
  pubdate: 1700000000,
  stat: { 播放: 100, 弹幕: 5, 评论: 3, 收藏: 20, 投币: 10, 分享: 3, 点赞: 30 },
  fetched_at: "2026-08-05T00:00:00.000Z",
  source: "api.bilibili.com/x/web-interface/view",
};

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwVoiceTables(db);
  ensurePwRunTables(db);
  ensurePwCorpusTables(db);
  return db;
}

/** 造 done 语料条目：DB 行指向临时目录，目录里写 meta.json + comments.jsonl。 */
async function seedDoneCorpus(db: DatabaseSync, dir: string): Promise<void> {
  await writeFile(join(dir, "meta.json"), JSON.stringify(META, null, 2));
  await writeFile(
    join(dir, "comments.jsonl"),
    COMMENTS.map((comment) => JSON.stringify(comment)).join("\n") + "\n",
  );
  const { doc } = authorizePwCorpus(db, { bvid: BV1 });
  donePwCorpus(db, doc.id, {
    title: META.title,
    upName: META.up_name,
    path: dir,
    videoStat: META.stat,
    commentCount: COMMENTS.length,
    comments: COMMENTS.map((comment) => ({
      uname: comment.uname,
      message: comment.message,
      like: comment.like,
    })),
  });
}

function hasStatus(error: unknown, status: number): boolean {
  return typeof error === "object" && error !== null && "status" in error
    && (error as { status: unknown }).status === status;
}

test("收录成功：platform 格式/逐字/author 哈希/capturedAt=ctime 转 ISO/自动分拣 spy 触发/human 账", async () => {
  const db = makeDb();
  const dir = await mkdtemp(join(tmpdir(), "pw-voice-collect-"));
  const classified: string[] = [];
  setPwVoiceAutoClassifier((_db, ids) => {
    classified.push(...ids);
  });
  try {
    await seedDoneCorpus(db, dir);
    const row = collectPwCorpusComment(db, { bvid: BV1, rpid: 101 });
    assert.equal(row.platform, `bilibili:${BV1}`, "platform 格式 bilibili:{bvid}");
    assert.equal(row.content, "这条评论一", "content 逐字");
    assert.equal(
      row.author_hash,
      createHash("sha256").update("甲", "utf8").digest("hex"),
    );
    assert.equal(row.captured_at, new Date(1700000001 * 1000).toISOString(), "capturedAt=ctime 转 ISO");
    assert.deepEqual(classified, [row.id], "PW-26 自动分拣挂钩自然触发（收录即分拣）");
    const run = db.prepare(
      "SELECT * FROM pw_runs WHERE kind = 'manual_event' AND event_type = 'voice'",
    ).get() as Json;
    assert.ok(run, "human(voice) 账经 addPwVoiceItem 既有路径");
    assert.equal(run.actor, "human");
  } finally {
    setPwVoiceAutoClassifier(null);
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("收录：uname 为空 → author 匿名；ctime 为空 → capturedAt 当前刻", async () => {
  const db = makeDb();
  const dir = await mkdtemp(join(tmpdir(), "pw-voice-collect-"));
  try {
    await seedDoneCorpus(db, dir);
    const anonymous = collectPwCorpusComment(db, { bvid: BV1, rpid: 102 });
    assert.equal(
      anonymous.author_hash,
      createHash("sha256").update("匿名", "utf8").digest("hex"),
      "uname 缺失用「匿名」",
    );
    const noTime = collectPwCorpusComment(db, { bvid: BV1, rpid: 103 });
    const capturedMs = new Date(noTime.captured_at).getTime();
    assert.ok(
      Math.abs(capturedMs - Date.now()) < 5000,
      "ctime 为空用当前刻",
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("409：重复收录带既有声音 id", async () => {
  const db = makeDb();
  const dir = await mkdtemp(join(tmpdir(), "pw-voice-collect-"));
  try {
    await seedDoneCorpus(db, dir);
    const first = collectPwCorpusComment(db, { bvid: BV1, rpid: 101 });
    await assert.rejects(async () => collectPwCorpusComment(db, { bvid: BV1, rpid: 101 }), (error: unknown) => {
      assert.ok(hasStatus(error, 409), "重复收录应 409");
      assert.ok(String((error as Error).message).includes(first.id), "报错带既有声音 id");
      return true;
    });
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("404：rpid 不存在", async () => {
  const db = makeDb();
  const dir = await mkdtemp(join(tmpdir(), "pw-voice-collect-"));
  try {
    await seedDoneCorpus(db, dir);
    await assert.rejects(async () => collectPwCorpusComment(db, { bvid: BV1, rpid: 999 }), (error: unknown) =>
      hasStatus(error, 404));
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("collected 标记两态：未收录全 false；收录后对应评论 true、其余 false；分页正常", async () => {
  const db = makeDb();
  const dir = await mkdtemp(join(tmpdir(), "pw-voice-collect-"));
  try {
    await seedDoneCorpus(db, dir);
    const before = listPwVoiceCorpusComments(db, BV1);
    assert.equal(before.length, 3);
    assert.ok(before.every((comment) => comment.collected === false), "未收录时全 false");

    collectPwCorpusComment(db, { bvid: BV1, rpid: 101 });
    const after = listPwVoiceCorpusComments(db, BV1);
    assert.equal(after.find((comment) => comment.rpid === 101)!.collected, true);
    assert.equal(after.find((comment) => comment.rpid === 102)!.collected, false);
    assert.equal(after.find((comment) => comment.rpid === 103)!.collected, false);

    const page = listPwVoiceCorpusComments(db, BV1, { offset: 1, limit: 1 });
    assert.equal(page.length, 1, "分页条数生效");
    assert.equal(page[0].rpid, 102, "分页偏移生效");
    assert.equal(page[0].collected, false);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("dropped 后可再收录：旧条不参与防重，丢弃留痕保留", async () => {
  const db = makeDb();
  const dir = await mkdtemp(join(tmpdir(), "pw-voice-collect-"));
  try {
    await seedDoneCorpus(db, dir);
    const first = collectPwCorpusComment(db, { bvid: BV1, rpid: 101 });
    dropPwVoiceItem(db, first.id, "误收");
    const second = collectPwCorpusComment(db, { bvid: BV1, rpid: 101 });
    assert.notEqual(second.id, first.id, "dropped 旧条不参与防重，允许再收");
    assert.equal(second.platform, `bilibili:${BV1}`);
    const droppedRow = db.prepare("SELECT * FROM pw_voice_items WHERE id = ?").get(first.id) as Json;
    assert.equal(droppedRow.dropped_reason, "误收", "旧条保留丢弃留痕");
    // 新条与旧条同原文同平台，但因旧条已丢，防重只认未丢弃行 → 第二条 collected=true
    const after = listPwVoiceCorpusComments(db, BV1);
    assert.equal(after.find((comment) => comment.rpid === 101)!.collected, true);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
