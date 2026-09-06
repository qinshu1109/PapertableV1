/**
 * TASK-PW-18：筛子 run 测试。
 * 覆盖：去抖合并（假时钟）、watermark 兜底、到达去重、原文断言、推荐语扫描、
 * wildcard 停线、只产草稿、mock 端到端（createApp + 本地 mock 模型 + HTTP 路由）、
 * pw_runs CHECK 迁移放行 sieve/sieve_run。
 * 时钟全部可注入（假时钟），不真等 10 分钟 / 60 秒。
 */
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createPwBet, ensurePwBetTables } from "./pw-bets.ts";
import { ensurePwArtifactTables } from "./pw-artifacts.ts";
import { createPwDataDoc, ensurePwDataDocTables } from "./pw-data-docs.ts";
import { ensurePwVerdictTables } from "./pw-verdicts.ts";
import { ensurePwRunTables, recordPwEvent } from "./pw-runs.ts";
import { ensurePwConnectionTables } from "./pw-connections.ts";
import { ensurePwVoiceTables } from "./pw-voice.ts";
import { authorizePwCorpus, donePwCorpus, ensurePwCorpusTables } from "./pw-corpus.ts";
import {
  createSieveNotifier,
  ensurePwSieveTables,
  listPwSieveCards,
  runPwSieve,
  type PwSieveRunRow,
  type SieveLlm,
} from "./pw-sieve.ts";
import { createApp, type PapertableApp } from "./main.ts";

type Json = Record<string, unknown>;

const BV1 = "BV1NprhBPEtR";
/** 固定假时钟（ms），让新鲜度权重与排序分断言完全确定。 */
const NOW_MS = 1_760_000_000_000;
const DAY_MS = 86_400_000;
const epochSec = (ms: number): number => Math.floor(ms / 1000);

const COMMENTS = [
  {
    rpid: 101,
    uname: "甲",
    message: "直播做产品实践这个实验设计得真巧妙",
    like: 12,
    ctime: epochSec(NOW_MS - DAY_MS),
  },
  {
    rpid: 102,
    uname: "乙",
    message: "少数派声音：录屏不剪辑也有人看",
    like: 3,
    ctime: epochSec(NOW_MS - DAY_MS),
  },
  {
    rpid: 103,
    uname: "丙",
    message: "干货密度高，全程无尿点",
    like: 8,
    ctime: epochSec(NOW_MS - 3 * DAY_MS),
  },
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
  ensurePwBetTables(db);
  ensurePwArtifactTables(db);
  ensurePwDataDocTables(db);
  ensurePwVerdictTables(db);
  ensurePwRunTables(db);
  ensurePwConnectionTables(db);
  ensurePwVoiceTables(db);
  ensurePwCorpusTables(db);
  ensurePwSieveTables(db);
  return db;
}

/** 造 done 语料条目：DB 行指向临时目录，目录里写 meta.json + comments.jsonl。 */
async function seedDoneCorpus(
  db: DatabaseSync,
  dir: string,
  comments = COMMENTS,
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

/** mock llm：直接返回写死的卡片 JSON。 */
function mockLlm(cards: unknown[]): SieveLlm {
  return async () => JSON.stringify({ cards });
}

/** 假时钟：不真等安静窗；fireDue 执行到期定时器。 */
function fakeClock() {
  let t = 1_000_000;
  const timers: Array<{ at: number; fn: () => void | Promise<void> }> = [];
  return {
    now: () => t,
    set(fn: () => void | Promise<void>, ms: number) {
      const handle = { at: t + ms, fn };
      timers.push(handle);
      return handle;
    },
    clear(handle: unknown) {
      const index = timers.indexOf(handle as { at: number });
      if (index >= 0) timers.splice(index, 1);
    },
    advance(ms: number) {
      t += ms;
    },
    async fireDue() {
      const due = timers.filter((timer) => timer.at <= t);
      for (const timer of due) {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
      }
      for (const timer of due) await timer.fn();
    },
    pending() {
      return timers.length;
    },
  };
}

function notifierWith(db: DatabaseSync, clock: ReturnType<typeof fakeClock>, llm?: SieveLlm) {
  return createSieveNotifier({
    db,
    debounceMs: 600_000,
    llm,
    now: clock.now,
    schedule: clock.set,
    clearSchedule: clock.clear,
  });
}

function listRuns(db: DatabaseSync): PwSieveRunRow[] {
  return db.prepare("SELECT * FROM pw_sieve_runs ORDER BY created_at, rowid").all() as PwSieveRunRow[];
}

function countRows(db: DatabaseSync, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

test("去抖：连续 3 次 notify 合并为 1 次 run（假时钟安静窗）", async () => {
  const db = makeDb();
  const clock = fakeClock();
  const notifier = notifierWith(db, clock);
  try {
    notifier.notifyArrival("sync", ["d1"]);
    notifier.notifyArrival("sync", ["d2"]);
    notifier.notifyArrival("corpus_done", ["c1"]);
    assert.equal(clock.pending(), 1, "每次 notify 重置安静窗，只保留一个定时器");

    clock.advance(600_000);
    await clock.fireDue();

    const runs = listRuns(db);
    assert.equal(runs.length, 1, "三次到达合并为一次 run");
    assert.deepEqual(JSON.parse(runs[0].input_ids_json), ["d1", "d2", "c1"]);
    assert.equal(runs[0].trigger_source, "sync", "合并批触发源取最先到达者");
    assert.equal(runs[0].status, "done");
  } finally {
    notifier.close();
    db.close();
  }
});

test("watermark：清空内存队列后造新行水位差 → 兜底补筛触发", async () => {
  const db = makeDb();
  const clock = fakeClock();
  const notifier = notifierWith(db, clock);
  try {
    const betId = createPwBet(db, { title: "押注一", thesis: "假设一" }).id;
    const d1 = createPwDataDoc(db, { betId, platform: "bilibili", metricsJson: '{"播放":1}' });
    db.prepare("UPDATE pw_data_docs SET created_at = '2026-08-01T00:00:00.000Z' WHERE id = ?")
      .run(d1.id);

    // 第一次 notify 正常筛掉 d1（水位推进到 d1）
    notifier.notifyArrival("sync", [d1.id]);
    clock.advance(600_000);
    await clock.fireDue();
    assert.equal(listRuns(db).length, 1);

    // 直接 INSERT 新行（不走 notify，模拟内存队列丢失 / 崩溃恢复）
    const d2 = createPwDataDoc(db, { betId, platform: "bilibili", metricsJson: '{"播放":2}' });
    db.prepare("UPDATE pw_data_docs SET created_at = '2026-08-02T00:00:00.000Z' WHERE id = ?")
      .run(d2.id);

    await notifier.tickWatermark();

    const runs = listRuns(db);
    assert.equal(runs.length, 2, "水位差触发兜底补筛");
    assert.equal(runs[1].trigger_source, "watermark");
    assert.deepEqual(JSON.parse(runs[1].input_ids_json), [d2.id]);
  } finally {
    notifier.close();
    db.close();
  }
});

test("去重：同一 doc id 两次到达 → 不重复产卡；已筛后再通知不重复 run", async () => {
  const db = makeDb();
  const dir = await mkdtemp(join(tmpdir(), "pw-sieve-dedup-"));
  const clock = fakeClock();
  const llm = mockLlm([
    {
      quote_text: "干货密度高，全程无尿点",
      quote_source: { bvid: BV1, uname: "丙", like: 8 },
      scale_note: "高赞",
      hook_note: "开头钩子",
      freshness_note: "新发布",
      wildcard: false,
    },
    {
      quote_text: "少数派声音：录屏不剪辑也有人看",
      quote_source: { bvid: BV1, uname: "乙", like: 3 },
      scale_note: "少数人",
      hook_note: "异类视角",
      freshness_note: "新发布",
      wildcard: true,
    },
  ]);
  const notifier = notifierWith(db, clock, llm);
  try {
    const corpusId = await seedDoneCorpus(db, dir);

    notifier.notifyArrival("corpus_done", [corpusId]);
    notifier.notifyArrival("corpus_done", [corpusId]);
    clock.advance(600_000);
    await clock.fireDue();

    const runs = listRuns(db);
    assert.equal(runs.length, 1, "两次到达合并为一次 run");
    assert.deepEqual(JSON.parse(runs[0].input_ids_json), [corpusId]);
    assert.equal(countRows(db, "pw_sieve_cards"), 2, "一卡 normal 一卡 wildcard，不重复产卡");

    // 已筛后再通知同一行：done run 的 input 已含该 id → 不重复 run
    notifier.notifyArrival("corpus_done", [corpusId]);
    clock.advance(600_000);
    await clock.fireDue();
    assert.equal(listRuns(db).length, 1, "同一行已筛后不再重复 run");
    assert.equal(countRows(db, "pw_sieve_cards"), 2);
  } finally {
    notifier.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("原文断言：篡改引文丢弃+dropped_count，逐字引文保留", async () => {
  const db = makeDb();
  const dir = await mkdtemp(join(tmpdir(), "pw-sieve-verbatim-"));
  try {
    const corpusId = await seedDoneCorpus(db, dir);
    const llm = mockLlm([
      {
        quote_text: "这句是模型篡改的引文，输入评论里根本不存在",
        quote_source: { bvid: BV1, uname: "甲" },
        scale_note: "高赞",
        hook_note: "钩子",
        freshness_note: "新",
        wildcard: false,
      },
      {
        quote_text: "直播做产品实践这个实验设计得真巧妙",
        quote_source: { bvid: BV1, uname: "甲", like: 12 },
        scale_note: "高赞评论",
        hook_note: "可作开头案例",
        freshness_note: "新发布",
        wildcard: false,
      },
      {
        quote_text: "少数派声音：录屏不剪辑也有人看",
        quote_source: { bvid: BV1, uname: "乙", like: 3 },
        scale_note: "少数人",
        hook_note: "异类视角",
        freshness_note: "新发布",
        wildcard: true,
      },
    ]);

    const run = await runPwSieve(db, "corpus_done", [corpusId], { llm, now: () => NOW_MS });

    assert.equal(run.status, "done");
    assert.equal(run.dropped_count, 1, "篡改引文丢弃并计数");
    const cards = listPwSieveCards(db, run.id);
    assert.equal(cards.length, 2);
    assert.deepEqual(
      cards.map((card) => card.quote_text),
      ["直播做产品实践这个实验设计得真巧妙", "少数派声音：录屏不剪辑也有人看"],
    );

    const normal = cards.find((card) => card.kind === "normal")!;
    const source = JSON.parse(normal.quote_source_json) as Record<string, unknown>;
    assert.equal(source.bvid, BV1);
    assert.equal(source.uname, "甲");
    assert.equal(source.like, 12);
    assert.equal(source.rpid, 101);
    assert.equal(normal.scale_value, 1, "同类命中计数=输入评论中含该引文的条数");
    // sort_score = scale*2 + min(like,100)/50 + 新鲜度(ctime=1 天前 → 2.0)
    assert.ok(Math.abs(normal.sort_score - (1 * 2 + 12 / 50 + 2.0)) < 1e-6);
    const wildcard = cards.find((card) => card.kind === "wildcard")!;
    assert.equal(wildcard.sort_score, 0, "wildcard 不参与排序，另置一区");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("推荐语扫描：hook_note 含「推荐」→ 整卡丢弃", async () => {
  const db = makeDb();
  const dir = await mkdtemp(join(tmpdir(), "pw-sieve-recommend-"));
  try {
    const corpusId = await seedDoneCorpus(db, dir);
    const llm = mockLlm([
      {
        quote_text: "直播做产品实践这个实验设计得真巧妙",
        quote_source: { bvid: BV1, uname: "甲" },
        scale_note: "高赞",
        hook_note: "推荐你试试这个方向",
        freshness_note: "新",
        wildcard: false,
      },
      {
        quote_text: "干货密度高，全程无尿点",
        quote_source: { bvid: BV1, uname: "丙" },
        scale_note: "高赞",
        hook_note: "开头钩子",
        freshness_note: "新",
        wildcard: false,
      },
      {
        quote_text: "少数派声音：录屏不剪辑也有人看",
        quote_source: { bvid: BV1, uname: "乙" },
        scale_note: "少数人",
        hook_note: "异类视角",
        freshness_note: "新",
        wildcard: true,
      },
    ]);

    const run = await runPwSieve(db, "corpus_done", [corpusId], { llm, now: () => NOW_MS });

    assert.equal(run.status, "done");
    assert.equal(run.dropped_count, 1, "含推荐措辞的整卡丢弃并计数");
    const cards = listPwSieveCards(db, run.id);
    assert.equal(cards.length, 2);
    for (const card of cards) {
      const notes = [card.scale_note, card.hook_note, card.freshness_note].join(" ");
      assert.ok(!/推荐|建议|应该/u.test(notes), "保留卡不含推荐性措辞");
    }
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("wildcard：0 条 → run 标记 failed 不产卡；≥1 → 通过", async () => {
  const db = makeDb();
  const dir = await mkdtemp(join(tmpdir(), "pw-sieve-wildcard-"));
  try {
    const corpusId = await seedDoneCorpus(db, dir);

    // (a) 模型只回 normal 卡 → 防平庸停线
    let run = await runPwSieve(db, "corpus_done", [corpusId], {
      llm: mockLlm([
        {
          quote_text: "直播做产品实践这个实验设计得真巧妙",
          quote_source: { bvid: BV1, uname: "甲" },
          scale_note: "高赞",
          hook_note: "钩子",
          freshness_note: "新",
          wildcard: false,
        },
      ]),
      now: () => NOW_MS,
    });
    assert.equal(run.status, "failed");
    assert.match(run.error ?? "", /wildcard/);
    assert.equal(countRows(db, "pw_sieve_cards"), 0, "failed 不产卡");

    // (b) 含 ≥1 条 wildcard → 通过
    run = await runPwSieve(db, "corpus_done", [corpusId], {
      llm: mockLlm([
        {
          quote_text: "干货密度高，全程无尿点",
          quote_source: { bvid: BV1, uname: "丙" },
          scale_note: "高赞",
          hook_note: "开头钩子",
          freshness_note: "新",
          wildcard: false,
        },
        {
          quote_text: "少数派声音：录屏不剪辑也有人看",
          quote_source: { bvid: BV1, uname: "乙" },
          scale_note: "少数人",
          hook_note: "异类视角",
          freshness_note: "新",
          wildcard: true,
        },
      ]),
      now: () => NOW_MS,
    });
    assert.equal(run.status, "done");
    assert.equal(countRows(db, "pw_sieve_cards"), 2);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("只产草稿：run 前后 pw_bets/pw_verdicts/pw_data_docs/pw_corpus_docs 行数不变", async () => {
  const db = makeDb();
  const dir = await mkdtemp(join(tmpdir(), "pw-sieve-draft-only-"));
  try {
    const betId = createPwBet(db, { title: "押注一", thesis: "假设一" }).id;
    createPwDataDoc(db, { betId, platform: "bilibili", metricsJson: '{"播放":1}' });
    const corpusId = await seedDoneCorpus(db, dir);

    const before = {
      bets: countRows(db, "pw_bets"),
      verdicts: countRows(db, "pw_verdicts"),
      dataDocs: countRows(db, "pw_data_docs"),
      corpusDocs: countRows(db, "pw_corpus_docs"),
      runs: countRows(db, "pw_runs"),
    };

    const run = await runPwSieve(db, "corpus_done", [corpusId], {
      llm: mockLlm([
        {
          quote_text: "干货密度高，全程无尿点",
          quote_source: { bvid: BV1, uname: "丙" },
          scale_note: "高赞",
          hook_note: "钩子",
          freshness_note: "新",
          wildcard: false,
        },
        {
          quote_text: "少数派声音：录屏不剪辑也有人看",
          quote_source: { bvid: BV1, uname: "乙" },
          scale_note: "少数人",
          hook_note: "异类视角",
          freshness_note: "新",
          wildcard: true,
        },
      ]),
      now: () => NOW_MS,
    });
    assert.equal(run.status, "done");

    assert.equal(countRows(db, "pw_bets"), before.bets, "pw_bets 不变");
    assert.equal(countRows(db, "pw_verdicts"), before.verdicts, "pw_verdicts 不变");
    assert.equal(countRows(db, "pw_data_docs"), before.dataDocs, "pw_data_docs 不变");
    assert.equal(countRows(db, "pw_corpus_docs"), before.corpusDocs, "pw_corpus_docs 不变");
    // 草稿侧与审计增长
    assert.equal(countRows(db, "pw_sieve_runs"), 1);
    assert.equal(countRows(db, "pw_sieve_cards"), 2);
    assert.equal(countRows(db, "pw_runs"), before.runs + 1, "仅新增 sieve_run 审计事件");
    const event = db.prepare("SELECT * FROM pw_runs WHERE event_type = 'sieve_run'").get() as Json;
    assert.equal(event.kind, "sieve");
    assert.equal(event.actor, "system");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("pw_runs CHECK 迁移：旧枚举重建后放行 kind=sieve / event_type=sieve_run", () => {
  const db = new DatabaseSync(":memory:");
  // 模拟 TASK-PW-15 时代的旧表（无 sieve/sieve_run）
  db.exec(`
    CREATE TABLE pw_runs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('manual_event','ai_draft','sync')),
      event_type TEXT NOT NULL CHECK(event_type IN (
        'create','attach','data_doc','draft','confirm','reject','settle','fetch_propose'
      )),
      actor TEXT NOT NULL CHECK(actor IN ('human','ai','system')),
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      parent_id TEXT,
      related_ids_json TEXT NOT NULL DEFAULT '[]',
      bet_id TEXT,
      created_at TEXT NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO pw_runs(id, kind, event_type, actor, payload_json, payload_hash,
                        related_ids_json, created_at)
    VALUES('old', 'sync', 'data_doc', 'system', '{}', 'h', '[]', '2026-08-01T00:00:00Z')
  `).run();
  try {
    ensurePwRunTables(db);
    const event = recordPwEvent(db, {
      kind: "sieve",
      eventType: "sieve_run",
      actor: "system",
      payloadJson: '{"runId":"r1","inputIds":[],"cardsCount":1,"droppedCount":0}',
    });
    assert.equal(event.kind, "sieve");
    assert.equal(event.event_type, "sieve_run");
    assert.ok(db.prepare("SELECT id FROM pw_runs WHERE id = 'old'").get(), "旧行保留");
  } finally {
    db.close();
  }
});

test("mock 端到端：notify→run→cards 落表+sieve_run 事件+GET status 字段正确", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pw-sieve-e2e-"));
  const mock = await startMockModel();
  const originalBaseUrl = process.env.PAPERTABLE_BASE_URL;
  const originalApiKey = process.env.PAPERTABLE_API_KEY;
  const originalModel = process.env.PAPERTABLE_MODEL;
  let app: PapertableApp | undefined;
  try {
    process.env.PAPERTABLE_BASE_URL = `http://127.0.0.1:${mock.port}/v1`;
    process.env.PAPERTABLE_API_KEY = "mock-key";
    process.env.PAPERTABLE_MODEL = "mock-1";
    app = await createApp(dir);
    await new Promise<void>((resolve) => app!.server.listen(0, "127.0.0.1", () => resolve()));
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;

    // 1) 授权语料（走真实路由）
    const authResponse = await fetch(`${base}/api/pw/corpus`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bvid: BV1 }),
    });
    assert.equal(authResponse.status, 201);
    const corpus = (await authResponse.json()) as { id: string };
    const corpusId = corpus.id;

    // 2) 落盘文件 + done（done 路由成功返回即触发到达收口）
    const e2eComments = [
      { rpid: 1, uname: "甲", message: "直播做产品实践这个实验设计得真巧妙", like: 12, ctime: 1700000001 },
      { rpid: 2, uname: "乙", message: "少数派声音：录屏不剪辑也有人看", like: 3, ctime: 1700000002 },
    ];
    await writeFile(join(dir, "meta.json"), JSON.stringify(META, null, 2));
    await writeFile(
      join(dir, "comments.jsonl"),
      e2eComments.map((comment) => JSON.stringify(comment)).join("\n") + "\n",
    );
    const doneResponse = await fetch(`${base}/api/pw/corpus/${corpusId}/done`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: META.title,
        upName: META.up_name,
        path: dir,
        videoStat: META.stat,
        comments: e2eComments.map((comment) => ({
          uname: comment.uname,
          message: comment.message,
          like: comment.like,
        })),
      }),
    });
    assert.equal(doneResponse.status, 200);

    // 3) 到达已入队：pending_arrivals=1
    let status = (await fetch(`${base}/api/pw/sieve/status`).then((r) => r.json())) as Json;
    assert.equal(status.pending_arrivals, 1, JSON.stringify(status));
    assert.equal(status.cards_pending, 0);
    assert.equal(status.last_run_at, null);

    // 4) POST run → 立即筛（绕过安静窗）
    const runResponse = await fetch(`${base}/api/pw/sieve/run`, { method: "POST" });
    assert.equal(runResponse.status, 200);
    const runBody = (await runResponse.json()) as { runId: string };
    assert.ok(runBody.runId);

    // 5) cards 落表（逐字引文 + wildcard ≥1）
    const cards = app!.store.db.prepare(
      "SELECT * FROM pw_sieve_cards WHERE run_id = ?",
    ).all(runBody.runId) as Array<{ kind: string; quote_text: string; status: string }>;
    assert.equal(cards.length, 2);
    assert.equal(cards.filter((card) => card.kind === "wildcard").length, 1);
    for (const card of cards) {
      assert.ok(card.quote_text.length > 0, "逐字引文落表");
      assert.equal(card.status, "pending", "卡片以 pending 草稿态落表");
    }

    // 6) sieve_run 审计事件
    const event = app!.store.db.prepare(
      "SELECT * FROM pw_runs WHERE event_type = 'sieve_run'",
    ).get() as Json;
    assert.ok(event, "sieve_run 事件存在");
    assert.equal(event.kind, "sieve");
    assert.equal(event.actor, "system");
    const payload = JSON.parse(String(event.payload_json)) as Json;
    assert.equal(payload.runId, runBody.runId);
    assert.deepEqual(payload.inputIds, [corpusId]);
    assert.equal(payload.cardsCount, 2);

    // 7) status 字段正确
    status = (await fetch(`${base}/api/pw/sieve/status`).then((r) => r.json())) as Json;
    assert.ok(status.last_run_at, "last_run_at 已填充");
    assert.equal(status.pending_arrivals, 0);
    assert.equal(status.cards_pending, 2);
  } finally {
    mock.close();
    if (app) await app.close();
    restoreEnv("PAPERTABLE_BASE_URL", originalBaseUrl);
    restoreEnv("PAPERTABLE_API_KEY", originalApiKey);
    restoreEnv("PAPERTABLE_MODEL", originalModel);
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 本地 mock 模型（anthropic-messages 兼容；流式 + 非流式都支持）
// ---------------------------------------------------------------------------

const MOCK_CARDS_JSON = JSON.stringify({
  cards: [
    {
      quote_text: "直播做产品实践这个实验设计得真巧妙",
      quote_source: { bvid: BV1, uname: "甲", like: 12 },
      scale_note: "高赞评论",
      hook_note: "可作开头案例",
      freshness_note: "新发布",
      wildcard: false,
    },
    {
      quote_text: "少数派声音：录屏不剪辑也有人看",
      quote_source: { bvid: BV1, uname: "乙", like: 3 },
      scale_note: "少数人",
      hook_note: "异类视角",
      freshness_note: "新发布",
      wildcard: true,
    },
  ],
});

async function startMockModel(): Promise<{ port: number; close: () => void }> {
  const server: Server = createServer((request, response) => {
    if (request.method !== "POST" || !request.url?.includes("/v1/messages")) {
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      let body: Json = {};
      try {
        body = JSON.parse(raw) as Json;
      } catch {
        // ignore
      }
      if (body.stream) {
        writeSseJson(response, MOCK_CARDS_JSON);
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: "msg_mock",
          type: "message",
          role: "assistant",
          model: "mock-1",
          content: [{ type: "text", text: MOCK_CARDS_JSON }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 80 },
        }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { port, close: () => server.close() };
}

function writeSseJson(response: ServerResponse, text: string): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
  });
  const send = (event: string, data: unknown): void => {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send("message_start", {
    type: "message_start",
    message: {
      id: "msg_mock",
      type: "message",
      role: "assistant",
      model: "mock-1",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  send("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  send("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  });
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 80 },
  });
  send("message_stop", { type: "message_stop" });
  response.end();
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
