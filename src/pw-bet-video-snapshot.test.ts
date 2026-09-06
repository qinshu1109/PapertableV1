import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ensurePwArtifactTables, attachPwArtifact, detachPwArtifact } from "./pw-artifacts.ts";
import { ensurePwBetTables, createPwBet } from "./pw-bets.ts";
import {
  ensurePwDataDocTables,
  createPwDataDoc,
  listPwDataDocs,
} from "./pw-data-docs.ts";
import { snapshotPwBetVideoStats } from "./pw-bet-video-snapshot.ts";
import {
  ensurePwRunTables,
  getPwActivityDaily,
  recordPwEvent,
} from "./pw-runs.ts";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwBetTables(db);
  ensurePwArtifactTables(db);
  ensurePwDataDocTables(db);
  ensurePwRunTables(db);
  return db;
}

function seedBet(db: DatabaseSync, title: string): string {
  return createPwBet(db, { title, thesis: "thesis" }).id;
}

function seedVideoArtifact(db: DatabaseSync, betId: string, url: string): string {
  return attachPwArtifact(db, { betId, platform: "B站", type: "video", url }).id;
}

/** 短链解析 mock：记调用次数，固定返回 bvid（null 表示解析不出）。 */
function spyResolver(bvid: string | null): {
  resolveShortLink: (url: string) => Promise<string | null>;
  calls: () => number;
} {
  let calls = 0;
  return {
    resolveShortLink: async () => {
      calls += 1;
      return bvid;
    },
    calls: () => calls,
  };
}

const STAT = { 播放: 100, 点赞: 5, 评论: 3 };

test("PW-55B 快照：无既有文档 → 写 doc 并落 pw_runs 账（system/data_doc/sync）", async () => {
  const db = makeDb();
  const betId = seedBet(db, "bet-1");
  const artifactId = seedVideoArtifact(db, betId, "https://www.bilibili.com/video/BV1abcDEF123");

  const result = await snapshotPwBetVideoStats(db, {
    fetchStat: () => STAT,
    now: "2026-08-10T00:00:00.000Z",
  });

  assert.deepEqual(result, { written: 1, skipped: 0, errors: [] });
  const docs = listPwDataDocs(db, betId);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].artifact_id, artifactId);
  assert.equal(docs[0].platform, "B站");
  assert.equal(docs[0].collected_at, "2026-08-10T00:00:00.000Z");
  assert.deepEqual(JSON.parse(docs[0].metrics_json), STAT);

  const runs = db.prepare("SELECT * FROM pw_runs WHERE bet_id = ?").all(betId) as Array<{
    kind: string;
    event_type: string;
    actor: string;
  }>;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].kind, "sync");
  assert.equal(runs[0].event_type, "data_doc");
  assert.equal(runs[0].actor, "system");
});

test("PW-55B 快照：与最新 doc 播放/点赞/评论三项全同 → 跳过不写", async () => {
  const db = makeDb();
  const betId = seedBet(db, "bet-2");
  seedVideoArtifact(db, betId, "https://www.bilibili.com/video/BV1abcDEF123");
  createPwDataDoc(db, {
    betId,
    platform: "B站",
    metricsJson: JSON.stringify(STAT),
    collectedAt: "2026-08-09T00:00:00.000Z",
  });

  const result = await snapshotPwBetVideoStats(db, { fetchStat: () => STAT });
  assert.deepEqual(result, { written: 0, skipped: 1, errors: [] });
  assert.equal(listPwDataDocs(db, betId).length, 1);
  // createPwDataDoc 不落 pw_runs；同值跳过也没有任何新账
  const runCount = db.prepare("SELECT COUNT(*) AS n FROM pw_runs").get() as { n: number };
  assert.equal(runCount.n, 0);
});

test("PW-55B 快照：已摘除产出物不进处理范围（不写、不算 skipped）", async () => {
  const db = makeDb();
  const attachedBet = seedBet(db, "attached");
  const detachedBet = seedBet(db, "detached");
  const attachedId = seedVideoArtifact(db, attachedBet, "https://www.bilibili.com/video/BV1abcDEF123");
  const detachedId = seedVideoArtifact(db, detachedBet, "https://www.bilibili.com/video/BV2xyzGHI456");
  detachPwArtifact(db, detachedId);

  const result = await snapshotPwBetVideoStats(db, { fetchStat: () => STAT });
  assert.deepEqual(result, { written: 1, skipped: 0, errors: [] });
  assert.equal(listPwDataDocs(db, attachedBet)[0].artifact_id, attachedId);
  assert.equal(listPwDataDocs(db, detachedBet).length, 0);
});

test("PW-56 快照：b23.tv 短链 resolver 返回 null → 跳过并 console.warn 留痕", async () => {
  const db = makeDb();
  const betId = seedBet(db, "bet-3");
  seedVideoArtifact(db, betId, "https://b23.tv/shortlink-null");

  const originalWarn = console.warn;
  let warned = 0;
  console.warn = () => {
    warned += 1;
  };
  try {
    const result = await snapshotPwBetVideoStats(db, {
      fetchStat: () => STAT,
      resolveShortLink: spyResolver(null).resolveShortLink,
    });
    assert.deepEqual(result, { written: 0, skipped: 1, errors: [] });
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(warned >= 1, "无 BV 跳过必须留痕");
  assert.equal(listPwDataDocs(db, betId).length, 0);
});

test("PW-55B 快照：多 artifact 逐 bet 各自写 doc（fetchStat 按 bvid 取数）", async () => {
  const db = makeDb();
  const betA = seedBet(db, "bet-a");
  const betB = seedBet(db, "bet-b");
  seedVideoArtifact(db, betA, "https://www.bilibili.com/video/BV1aaaAAA111");
  seedVideoArtifact(db, betB, "https://www.bilibili.com/video/BV2bbbBBB222");

  const result = await snapshotPwBetVideoStats(db, {
    fetchStat: (bvid) =>
      bvid === "BV1aaaAAA111" ? { 播放: 10, 点赞: 1, 评论: 0 } : { 播放: 20, 点赞: 2, 评论: 4 },
  });
  assert.deepEqual(result, { written: 2, skipped: 0, errors: [] });
  assert.deepEqual(JSON.parse(listPwDataDocs(db, betA)[0].metrics_json), {
    播放: 10,
    点赞: 1,
    评论: 0,
  });
  assert.deepEqual(JSON.parse(listPwDataDocs(db, betB)[0].metrics_json), {
    播放: 20,
    点赞: 2,
    评论: 4,
  });
  const betRuns = db.prepare(
    "SELECT bet_id FROM pw_runs WHERE event_type = 'data_doc'",
  ).all() as Array<{ bet_id: string }>;
  assert.deepEqual(betRuns.map((r) => r.bet_id).sort(), [betA, betB].sort());
});

test("PW-55B 快照：单条失败不阻断其余（fetchStat 抛错 → errors，其余照写）", async () => {
  const db = makeDb();
  const badBet = seedBet(db, "bad");
  const goodBet = seedBet(db, "good");
  seedVideoArtifact(db, badBet, "https://www.bilibili.com/video/BV1badBAD000");
  seedVideoArtifact(db, goodBet, "https://www.bilibili.com/video/BV1gooGOO111");

  const result = await snapshotPwBetVideoStats(db, {
    fetchStat: (bvid) => {
      if (bvid === "BV1badBAD000") throw new Error("抓取炸了");
      return STAT;
    },
  });
  assert.equal(result.written, 1);
  assert.equal(result.skipped, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].reason, /抓取炸了/);
  assert.equal(listPwDataDocs(db, goodBet).length, 1);
  assert.equal(listPwDataDocs(db, badBet).length, 0);
});

test("PW-56 快照：b23.tv 短链经 mock resolver 解出 BV → 正常写 doc 落账", async () => {
  const db = makeDb();
  const betId = seedBet(db, "bet-4");
  const artifactId = seedVideoArtifact(db, betId, "https://b23.tv/shortlink-ok");

  const result = await snapshotPwBetVideoStats(db, {
    fetchStat: () => STAT,
    resolveShortLink: spyResolver("BV1shortLINK1").resolveShortLink,
    now: "2026-08-10T00:00:00.000Z",
  });

  assert.deepEqual(result, { written: 1, skipped: 0, errors: [] });
  const docs = listPwDataDocs(db, betId);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].artifact_id, artifactId);
  assert.equal(docs[0].platform, "B站");
  assert.equal(docs[0].collected_at, "2026-08-10T00:00:00.000Z");
  assert.deepEqual(JSON.parse(docs[0].metrics_json), STAT);
  const runs = db.prepare("SELECT * FROM pw_runs WHERE bet_id = ?").all(betId) as Array<{
    kind: string;
    event_type: string;
    actor: string;
  }>;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].kind, "sync");
  assert.equal(runs[0].event_type, "data_doc");
  assert.equal(runs[0].actor, "system");
});

test("PW-56 快照：URL 直接含 BV → resolver 未被调用（零网络）", async () => {
  const db = makeDb();
  const betId = seedBet(db, "bet-5");
  seedVideoArtifact(db, betId, "https://www.bilibili.com/video/BV1abcDEF123");

  const spy = spyResolver("BV9zzZZZ999");
  const result = await snapshotPwBetVideoStats(db, {
    fetchStat: (bvid) => {
      assert.equal(bvid, "BV1abcDEF123", "直接含 BV 的 url 应直接用 BV，不走 resolver");
      return STAT;
    },
    resolveShortLink: spy.resolveShortLink,
  });

  assert.equal(spy.calls(), 0, "直接含 BV 的 url 不应触发短链解析");
  assert.deepEqual(result, { written: 1, skipped: 0, errors: [] });
  assert.equal(listPwDataDocs(db, betId).length, 1);
});

test("PW-56 快照：同一短链第二次走缓存（resolver 计数不增）", async () => {
  const db = makeDb();
  const betA = seedBet(db, "bet-a-cache");
  const betB = seedBet(db, "bet-b-cache");
  seedVideoArtifact(db, betA, "https://b23.tv/shortlink-cache");
  seedVideoArtifact(db, betB, "https://b23.tv/shortlink-cache");

  const spy = spyResolver("BV1cacheCACH1");
  const result = await snapshotPwBetVideoStats(db, {
    fetchStat: () => STAT,
    resolveShortLink: spy.resolveShortLink,
  });

  assert.deepEqual(result, { written: 2, skipped: 0, errors: [] });
  assert.equal(spy.calls(), 1, "同一短链第二次应命中进程内缓存，不重复解析");
});

// ---------- activity-daily ----------

function localDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 今天往前 offset 天的本地 YYYY-MM-DD（与 pw-runs localDay 口径一致）。 */
function dayOffset(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return localDay(date);
}

/** 让该本地日中午 12:00 的 ISO 时刻：date(iso,'localtime') 恒等于 day。 */
function isoAtLocalNoon(day: string): string {
  return new Date(`${day}T12:00:00`).toISOString();
}

test("PW-55B activity-daily：多天多 actor 聚合，按日升序，窗口外不计", () => {
  const db = makeDb();
  const today = dayOffset(0);
  const yesterday = dayOffset(-1);
  const twoDaysAgo = dayOffset(-2);
  const tenDaysAgo = dayOffset(-10);
  // 窗口内
  recordPwEvent(db, { event_type: "create", payload_json: "{}", created_at: isoAtLocalNoon(twoDaysAgo) });
  recordPwEvent(db, { event_type: "confirm", actor: "human", payload_json: "{}", created_at: isoAtLocalNoon(twoDaysAgo) });
  recordPwEvent(db, { event_type: "draft", actor: "ai", kind: "ai_draft", payload_json: "{}", created_at: isoAtLocalNoon(twoDaysAgo) });
  recordPwEvent(db, { event_type: "settle", actor: "human", payload_json: "{}", created_at: isoAtLocalNoon(yesterday) });
  recordPwEvent(db, { event_type: "corpus", actor: "system", kind: "sync", payload_json: "{}", created_at: isoAtLocalNoon(yesterday) });
  recordPwEvent(db, { event_type: "corpus", actor: "system", kind: "sync", payload_json: "{}", created_at: isoAtLocalNoon(yesterday) });
  recordPwEvent(db, { event_type: "message", actor: "ai", kind: "ai_draft", payload_json: "{}", created_at: isoAtLocalNoon(today) });
  // 窗口外（10 天前）不应计入
  recordPwEvent(db, { event_type: "create", actor: "human", payload_json: "{}", created_at: isoAtLocalNoon(tenDaysAgo) });

  const { days } = getPwActivityDaily(db);
  assert.equal(days.length, 7);
  assert.deepEqual(days[0], { day: dayOffset(-6), human: 0, ai: 0, system: 0 });
  const byDay = new Map(days.map((d) => [d.day, d]));
  assert.deepEqual(byDay.get(twoDaysAgo), { day: twoDaysAgo, human: 2, ai: 1, system: 0 });
  assert.deepEqual(byDay.get(yesterday), { day: yesterday, human: 1, ai: 0, system: 2 });
  assert.deepEqual(byDay.get(today), { day: today, human: 0, ai: 1, system: 0 });
});

test("PW-55B activity-daily：缺日补零（含今天），日升序", () => {
  const db = makeDb();
  const today = dayOffset(0);
  recordPwEvent(db, { event_type: "create", actor: "system", kind: "sync", payload_json: "{}", created_at: isoAtLocalNoon(dayOffset(-3)) });

  const { days } = getPwActivityDaily(db, { days: 4 });
  assert.equal(days.length, 4);
  assert.deepEqual(days.map((d) => d.day), [dayOffset(-3), dayOffset(-2), dayOffset(-1), today]);
  assert.deepEqual(days[0], { day: dayOffset(-3), human: 0, ai: 0, system: 1 });
  assert.deepEqual(days[1], { day: dayOffset(-2), human: 0, ai: 0, system: 0 });
  assert.deepEqual(days[2], { day: dayOffset(-1), human: 0, ai: 0, system: 0 });
  assert.deepEqual(days[3], { day: today, human: 0, ai: 0, system: 0 });
});

test("PW-55B activity-daily：days 钳制（默认 7、上限 30、非法 400）", () => {
  const db = makeDb();
  assert.equal(getPwActivityDaily(db).days.length, 7);
  assert.equal(getPwActivityDaily(db, { days: 30 }).days.length, 30);
  const bad = (days: number) => assert.throws(
    () => getPwActivityDaily(db, { days }),
    (error: unknown) => (error as { status?: number }).status === 400,
  );
  bad(0);
  bad(-1);
  bad(31);
  bad(2.5);
});
