/**
 * TASK-PW-48：老料重筛（resieveAllPwSieve）测试。
 * 覆盖规格用例：
 * 1. resieveAllPwSieve 能把「已进过 done run 的行」重新筛出卡（mock llm）；
 * 2. 空输入不调 LLM（返回 runId null，不建 run 行）；
 * 3. 在途 409（与 flushNow 一致）；
 * 4. reject_all_and_resieve 工具 resieveAll=true：直通主管线（不调 notifier flushNow）、
 *    返回文本含重复出卡提示、两笔 ai_exec 账；
 * 5. reject-all 端点缺省回归（响应与现状逐字一致）；resieveAll=true 走老料重筛（run + note）。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createPwBet, ensurePwBetTables } from "./pw-bets.ts";
import { ensurePwArtifactTables } from "./pw-artifacts.ts";
import { createPwDataDoc, ensurePwDataDocTables } from "./pw-data-docs.ts";
import { ensurePwVerdictTables } from "./pw-verdicts.ts";
import { ensurePwRunTables } from "./pw-runs.ts";
import { ensurePwConnectionTables } from "./pw-connections.ts";
import { ensurePwVoiceTables } from "./pw-voice.ts";
import { authorizePwCorpus, donePwCorpus, ensurePwCorpusTables } from "./pw-corpus.ts";
import {
  ensurePwSieveTables,
  getSieveDirection,
  resieveAllPwSieve,
  runPwSieve,
  type PwSieveRunRow,
  type SieveLlm,
} from "./pw-sieve.ts";
import {
  pwCollabTools,
  type CollabTool,
  type CollabToolContext,
} from "./pw-collab-tools.ts";
import { createApp, type PapertableApp } from "./main.ts";

type Json = Record<string, unknown>;

const BV1 = "BV1NprhBPEtR";
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
];

const META = {
  bvid: BV1,
  aid: 123456,
  title: "测试成片",
  up_name: "某UP主",
  pubdate: 1700000000,
  stat: { 播放: 100, 弹幕: 5, 评论: 2, 收藏: 20, 投币: 10, 分享: 3, 点赞: 30 },
  fetched_at: "2026-08-05T00:00:00.000Z",
  source: "api.bilibili.com/x/web-interface/view",
};

const MOCK_CARDS = [
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
];

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

function mockLlm(cards: unknown[]): SieveLlm {
  return async () => JSON.stringify({ cards });
}

function countRows(db: DatabaseSync, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

function getRun(db: DatabaseSync, runId: string): PwSieveRunRow {
  return db.prepare("SELECT * FROM pw_sieve_runs WHERE id = ?").get(runId) as PwSieveRunRow;
}

/** 直接插一轮 done run + 一张 pending 候选卡（工具/端点测试用）。 */
function seedCard(db: DatabaseSync): string {
  const runId = randomUUID();
  db.prepare(`
    INSERT INTO pw_sieve_runs(
      id, trigger_source, input_ids_json, cards_count, dropped_count,
      status, error, model, direction, created_at, finished_at
    ) VALUES(?, 'manual', '[]', 0, 0, 'done', NULL, NULL, NULL, ?, NULL)
  `).run(runId, new Date().toISOString());
  const cardId = randomUUID();
  db.prepare(`
    INSERT INTO pw_sieve_cards(
      id, run_id, kind, quote_text, quote_source_json, scale_note, scale_value,
      hook_note, freshness_note, sort_score, status, created_at
    ) VALUES(?, ?, 'normal', '私域课定价这么贵还有人买', ?, NULL, 1, NULL, NULL, 0, 'pending', ?)
  `).run(
    cardId,
    runId,
    JSON.stringify({ bvid: BV1, uname: "路人甲", like: 42 }),
    new Date().toISOString(),
  );
  return cardId;
}

function makeBet(db: DatabaseSync): string {
  return createPwBet(db, {
    title: "直播做产品实践",
    thesis: "直播系列能成",
    metric: "三期平均播放 ≥ 5000",
    metricTarget: ">= 5000",
    dataSourcePlan: "B站",
    checkoutDate: "2026-09-01",
    confidence: 70,
    status: "pending",
  }).id;
}

function execContext(
  db: DatabaseSync,
  betId: string,
  overrides: Partial<CollabToolContext> = {},
): CollabToolContext {
  return {
    db,
    betId,
    refs: new Map(),
    instruction: { text: "请执行", messageId: "msg-1" },
    ...overrides,
  };
}

function requireTool(name: string): CollabTool {
  const tool = pwCollabTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`工具不存在: ${name}`);
  return tool;
}

async function runTool(name: string, args: Json, context: CollabToolContext) {
  return requireTool(name).execute("call-1", args, undefined, undefined, context);
}

function cardStatus(db: DatabaseSync, cardId: string): string {
  return (db.prepare("SELECT status FROM pw_sieve_cards WHERE id = ?").get(cardId) as { status: string })
    .status;
}

function countRuns(db: DatabaseSync, where: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM pw_runs WHERE ${where}`).get() as { n: number }).n);
}

/** mock 筛子通知器：只记 flushNow 调用次数，返回固定 runId。 */
function mockNotifier(runId: string | null) {
  let calls = 0;
  const notifier = {
    flushNow: async () => {
      calls += 1;
      return { runId };
    },
  } as unknown as CollabToolContext["sieve"];
  return { notifier, flushCount: () => calls };
}

async function listenAndBase(app: PapertableApp): Promise<string> {
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", () => resolve()));
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}

// ---------------------------------------------------------------------------
// 用例 1：已进过 done run 的行仍能重筛出卡（绕过 filterUnsieved）
// ---------------------------------------------------------------------------

test("resieveAllPwSieve：已进过 done run 的行仍重筛出卡（直通主管线，mock llm）", async () => {
  const db = makeDb();
  const dir = await mkdtemp(join(tmpdir(), "pw-sieve-resieve-"));
  try {
    const corpusId = await seedDoneCorpus(db, dir);

    // 第一轮正常筛：该行进 done run，产 2 卡
    const first = await runPwSieve(db, "corpus_done", [corpusId], {
      llm: mockLlm(MOCK_CARDS),
      now: () => NOW_MS,
    });
    assert.equal(first.status, "done");
    assert.equal(countRows(db, "pw_sieve_cards"), 2);

    // 老料重筛：不走 filterUnsieved，同一行再次筛出卡（草稿，人否掉即可——不做机器去重）
    const result = await resieveAllPwSieve(db, { llm: mockLlm(MOCK_CARDS), now: () => NOW_MS });
    assert.ok(result.runId, "重筛产生 runId");
    const run = getRun(db, result.runId!);
    assert.equal(run.status, "done");
    assert.equal(run.trigger_source, "manual");
    assert.deepEqual(JSON.parse(run.input_ids_json), [corpusId]);
    assert.equal(countRows(db, "pw_sieve_cards"), 4, "同一引文重复出卡（规格：候选卡是草稿，人否掉即可）");

    // 水位自然推齐（既有行为 advanceWatermarkFromInput，不特判）
    const watermark = JSON.parse(
      (db.prepare("SELECT value FROM pw_sieve_state WHERE key = 'last_watermark_json'").get() as { value: string })
        .value,
    ) as { corpus_docs?: { id: string } };
    assert.equal(watermark.corpus_docs?.id, corpusId, "重筛 run 后水位已推进到该语料");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 用例 2：空输入不调 LLM
// ---------------------------------------------------------------------------

test("resieveAllPwSieve：全空输入返回 runId null 且不调 LLM、不建 run 行", async () => {
  const db = makeDb();
  let calls = 0;
  const llm: SieveLlm = async () => {
    calls += 1;
    return JSON.stringify({ cards: [] });
  };
  try {
    const result = await resieveAllPwSieve(db, { llm });
    assert.deepEqual(result, { runId: null }, "空输入直接返回 runId null");
    assert.equal(calls, 0, "不调 LLM");
    assert.equal(countRows(db, "pw_sieve_runs"), 0, "不建 run 行");
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// 用例 3：在途 409（与 flushNow 一致）
// ---------------------------------------------------------------------------

test("resieveAllPwSieve：有 running 行 → 409 筛子运行中", async () => {
  const db = makeDb();
  db.prepare(`
    INSERT INTO pw_sieve_runs(
      id, trigger_source, input_ids_json, cards_count, dropped_count,
      status, error, model, direction, created_at, finished_at
    ) VALUES('run-inflight', 'manual', '[]', 0, 0, 'running', NULL, NULL, NULL, ?, NULL)
  `).run(new Date().toISOString());
  try {
    await assert.rejects(
      () => resieveAllPwSieve(db, { llm: async () => "" }),
      (error: unknown) => (error as { status?: number }).status === 409
        && /筛子运行中/.test(String((error as Error).message)),
      "在途时应抛 409",
    );
    assert.equal(countRows(db, "pw_sieve_runs"), 1, "409 不产生新 run");
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// 用例 4：reject_all_and_resieve 工具 resieveAll=true
// ---------------------------------------------------------------------------

test("reject_all_and_resieve：resieveAll=true 直通主管线（不调 flushNow）+ 返回文本含重复出卡提示", async () => {
  const db = makeDb();
  try {
    const betId = makeBet(db);
    const cardIds = [seedCard(db), seedCard(db)];
    const { notifier, flushCount } = mockNotifier("run-x");
    const result = await runTool("reject_all_and_resieve", {
      reason: "都不行",
      direction: "AI 办公提效",
      resieveAll: true,
    }, execContext(db, betId, {
      instruction: { text: "全否并重筛老料", messageId: "msg-48" },
      sieve: notifier,
    }));
    assert.equal(getSieveDirection(db), "AI 办公提效", "先换方向");
    for (const id of cardIds) assert.equal(cardStatus(db, id), "rejected", "全部否掉");
    assert.equal(flushCount(), 0, "resieveAll 直通主管线，不调 notifier flushNow");
    assert.equal(countRuns(db, "kind = 'ai_exec'"), 2, "两笔账：reject + sieve_run");
    assert.ok(result.content[0].text.includes("否掉 2 张候选卡"), "返回文本含全否计数");
    assert.ok(result.content[0].text.includes("AI 办公提效"), "返回文本含新方向");
    // 空库无输入行 → runId null 分支
    assert.ok(result.content[0].text.includes("（当前无待筛数据）"), "无输入时说明未产生 run");
    assert.ok(
      result.content[0].text.includes("老料重筛可能把挑过的评论再筛出来，候选卡是草稿，人否掉即可。"),
      "返回文本含重复出卡提示",
    );
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// 用例 5a：reject-all 端点缺省回归（行为与现状逐字一致）
// ---------------------------------------------------------------------------

test("POST /api/pw/sieve/reject-all 缺省：响应与现状逐字一致（全否 + flushNow，无 note）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pw-reject-all-default-"));
  let app: PapertableApp | undefined;
  try {
    app = await createApp(dir);
    const base = await listenAndBase(app);
    // 直插一张 pending 候选卡；无新到达 → flushNow 返回 runId null（不调 LLM）
    seedCard(app.store.db);

    const response = await fetch(`${base}/api/pw/sieve/reject-all`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as Json;
    assert.deepEqual(body, { rejected: 1, runId: null, direction: null }, "缺省响应与现状逐字一致");
    assert.ok(!("note" in body), "缺省不带 note 字段");
    const card = app.store.db.prepare(
      "SELECT status FROM pw_sieve_cards",
    ).all() as Array<{ status: string }>;
    assert.equal(card[0].status, "rejected", "pending 卡已被全否");
  } finally {
    if (app) await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 用例 5b：reject-all 端点 resieveAll=true → 老料重筛（run + note + direction）
// ---------------------------------------------------------------------------

test("POST /api/pw/sieve/reject-all resieveAll=true：全否 + 老料重筛出 run，返回 note 提示重复出卡", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pw-reject-all-resieve-"));
  let app: PapertableApp | undefined;
  try {
    app = await createApp(dir);
    const base = await listenAndBase(app);
    // 造一个数据文档（三线之一）：无评论 → run done 0 卡，不调 LLM（无需 mock 模型）
    const betId = createPwBet(app.store.db, { title: "押注一", thesis: "假设一" }).id;
    createPwDataDoc(app.store.db, { betId, platform: "bilibili", metricsJson: '{"播放":1}' });
    seedCard(app.store.db);

    const response = await fetch(`${base}/api/pw/sieve/reject-all`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ direction: "AI 办公提效", resieveAll: true }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as Json;
    assert.equal(body.rejected, 1, "pending 卡已全否");
    assert.ok(typeof body.runId === "string", "老料重筛产生 runId");
    assert.equal(body.direction, "AI 办公提效");
    assert.ok(
      typeof body.note === "string" && body.note.includes("老料重筛可能把挑过的评论再筛出来"),
      "resieveAll 返回重复出卡提示",
    );
    const run = app.store.db.prepare(
      "SELECT status, trigger_source, direction FROM pw_sieve_runs WHERE id = ?",
    ).get(String(body.runId)) as { status: string; trigger_source: string; direction: string | null };
    assert.equal(run.status, "done");
    assert.equal(run.trigger_source, "manual", "直通主管线");
    assert.equal(run.direction, "AI 办公提效", "run 方向快照为新方向");
    const inputIds = JSON.parse(
      (app.store.db.prepare(
        "SELECT input_ids_json FROM pw_sieve_runs WHERE id = ?",
      ).get(String(body.runId)) as { input_ids_json: string }).input_ids_json,
    ) as string[];
    assert.equal(inputIds.length, 1, "全量输入含数据文档行");
  } finally {
    if (app) await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
