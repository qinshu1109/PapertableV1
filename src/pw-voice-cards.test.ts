import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { authorizePwCorpus, donePwCorpus, ensurePwCorpusTables } from "./pw-corpus.ts";
import { ensurePwRunTables } from "./pw-runs.ts";
import {
  aggregatePwVoiceThemeCards,
  collectPwVoiceThemeCard,
  ensurePwVoiceCardTables,
  listPwVoiceThemeCards,
  rejectPwVoiceThemeCard,
} from "./pw-voice-cards.ts";
import { addPwVoiceItem, ensurePwVoiceTables, setPwVoiceAutoClassifier } from "./pw-voice.ts";

const BVID = "BV1NprhBPEtR";
type Comment = { rpid: number; uname: string | null; message: string; like: number; ctime: number | null; replies: number };

async function fixture(count: number, run: (db: DatabaseSync, comments: Comment[]) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pw-voice-cards-"));
  const db = new DatabaseSync(":memory:");
  const comments = Array.from({ length: count }, (_, index) => ({
    rpid: index + 1, uname: index === 0 ? null : `用户${index + 1}`,
    message: `评论原文${index + 1}`, like: index + 1,
    ctime: index === 0 ? null : 1_700_000_000 + index, replies: 0,
  }));
  try {
    ensurePwRunTables(db); ensurePwVoiceTables(db); ensurePwCorpusTables(db); ensurePwVoiceCardTables(db);
    await writeFile(join(dir, "comments.jsonl"), comments.map(JSON.stringify).join("\n") + "\n");
    const { doc } = authorizePwCorpus(db, { bvid: BVID });
    donePwCorpus(db, doc.id, { path: dir, comments, commentCount: count });
    await run(db, comments);
  } finally {
    setPwVoiceAutoClassifier(null);
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("聚合容错、外 rpid 丢弃、未归堆，且 like 降序只取 300 条", async () => fixture(305, async (db) => {
  let prompt = "";
  const result = await aggregatePwVoiceThemeCards(db, BVID, {
    llm: async (value) => {
      prompt = value;
      return { text: `前缀 ${JSON.stringify([
        { title: "高赞主题", summary: "大家在乎高赞问题", rpids: [305] },
        { title: "外部坏卡", rpids: [9999] },
        { title: "坏项", rpids: "1" },
      ])}`, inputTokens: 100, outputTokens: 50 };
    },
    now: () => "2026-08-11T10:00:00+08:00", modelLabel: "mock",
  });
  assert.equal(result.cards, 2);
  assert.equal((prompt.match(/^\[\d+\]/gmu) ?? []).length, 300);
  assert.match(prompt, /^\[305\]/mu);
  assert.doesNotMatch(prompt, /^\[5\]/mu, "最低赞 5 条被截掉");
  assert.deepEqual(listPwVoiceThemeCards(db, BVID).cards.map((card) => card.title).sort(), ["未归堆", "高赞主题"]);
}));

test("重聚不翻倍，collected/rejected 卡与 rpid 保持不动", async () => fixture(3, async (db) => {
  const llm = async () => ({ text: JSON.stringify([
    { title: "主题一", rpids: [1] }, { title: "主题二", rpids: [2, 3] },
  ]), inputTokens: 10, outputTokens: 10 });
  await aggregatePwVoiceThemeCards(db, BVID, { llm, now: () => "2026-08-11T10:00:00+08:00" });
  const first = listPwVoiceThemeCards(db, BVID).cards;
  await aggregatePwVoiceThemeCards(db, BVID, { llm, now: () => "2026-08-11T10:00:30+08:00" });
  const second = listPwVoiceThemeCards(db, BVID).cards;
  assert.equal(second.length, first.length, "同视频连续重聚卡数不翻倍");
  rejectPwVoiceThemeCard(db, second.find((card) => card.title === "主题一")!.id as string);
  const collectedId = second.find((card) => card.title === "主题二")!.id as string;
  collectPwVoiceThemeCard(db, collectedId);
  await aggregatePwVoiceThemeCards(db, BVID, { llm, now: () => "2026-08-11T10:01:00+08:00" });
  assert.equal(listPwVoiceThemeCards(db, BVID, "rejected").cards.length, 1);
  assert.equal(listPwVoiceThemeCards(db, BVID, "collected").cards[0].id, collectedId);
  assert.equal(listPwVoiceThemeCards(db, BVID).cards.length, 0, "已处理 rpid 不再重聚");
}));

test("整卡收录逐字防重、回写 voice_id、时间作者与自动分拣正确", async () => fixture(3, async (db) => {
  const classified: string[] = [];
  setPwVoiceAutoClassifier((_db, ids) => classified.push(...ids));
  const existing = addPwVoiceItem(db, {
    platform: `bilibili:${BVID}`, content: "评论原文2", author: "已有", capturedAt: "2026-01-01T00:00:00.000Z",
  });
  await aggregatePwVoiceThemeCards(db, BVID, {
    llm: async () => ({ text: JSON.stringify([{ title: "整卡", rpids: [1, 2, 3] }]), inputTokens: 10, outputTokens: 10 }),
  });
  classified.length = 0;
  const cardId = listPwVoiceThemeCards(db, BVID).cards[0].id as string;
  const result = collectPwVoiceThemeCard(db, cardId);
  assert.deepEqual({ collected: result.collected, skipped: result.skipped }, { collected: 2, skipped: 1 });
  assert.equal(classified.length, 2);
  const items = (result.card.items as Array<Record<string, unknown>>);
  assert.equal(items.find((item) => item.rpid === 2)!.voiceId, existing.id);
  assert.ok(items.every((item) => item.collected === true));
  const anonymous = db.prepare(`SELECT captured_at FROM pw_voice_items WHERE content='评论原文1'`).get() as { captured_at: string };
  assert.ok(Number.isFinite(new Date(anonymous.captured_at).getTime()));
  assert.throws(() => collectPwVoiceThemeCard(db, cardId), /卡已处理/);
}));

test("弃卡后 rpid 不再浮出，成本超限写 failed 台账", async () => fixture(2, async (db) => {
  await aggregatePwVoiceThemeCards(db, BVID, {
    llm: async () => ({ text: JSON.stringify([{ title: "弃主题", rpids: [1] }]), inputTokens: 10, outputTokens: 10 }),
  });
  const rejectId = listPwVoiceThemeCards(db, BVID).cards.find((card) => card.title === "弃主题")!.id as string;
  rejectPwVoiceThemeCard(db, rejectId);
  await aggregatePwVoiceThemeCards(db, BVID, { llm: async () => "not json" });
  const suggestedItems = listPwVoiceThemeCards(db, BVID).cards.flatMap((card) => card.items as Array<{ rpid: number }>);
  assert.ok(!suggestedItems.some((item) => item.rpid === 1));
  await assert.rejects(aggregatePwVoiceThemeCards(db, BVID, {
    llm: async () => ({ text: "[]", inputTokens: 0, outputTokens: 20_000 }),
  }), /超预算/);
  const run = db.prepare(`SELECT status FROM pw_voice_card_runs ORDER BY rowid DESC LIMIT 1`).get() as { status: string };
  assert.match(run.status, /^failed:/);
}));
