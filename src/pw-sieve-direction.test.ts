/**
 * TASK-PW-42：方向输入·后端测试。
 * 覆盖规格第 5 条全部用例：
 * 1. state set/get 往返、空串归 null、未设过返回 null；
 * 2. 迁移幂等（二次调用不炸、旧行 direction 为 NULL）；
 * 3. 无方向时 buildSievePrompt 输出与现状逐字节一致（防回归金线，硬断言）；
 * 4. 有方向时 prompt 首段为方向段且含原文；
 * 5. run 落 direction 快照；sieveStatus 带 direction；候选卡读函数带 run_direction；
 * 6. set_sieve_direction 工具：无 instruction → 500；有 instruction → 落 ai_exec 账 + state 更新；
 * 7. reject_all_and_resieve 带 direction：state 更新 + 两笔账（reject + sieve_run）+ 返回文本含方向；
 *    不带 direction 回归（返回文本与现状逐字一致）。
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
  buildSievePrompt,
  createSieveNotifier,
  ensurePwSieveTables,
  getPwSieveCard,
  getSieveDirection,
  listPwSieveCards,
  listPwSieveCardsByStatus,
  runPwSieve,
  setSieveDirection,
  sieveStatus,
  type SieveInput,
  type SieveLlm,
  type SieveNotifier,
} from "./pw-sieve.ts";
import {
  pwCollabTools,
  type CollabTool,
  type CollabToolContext,
} from "./pw-collab-tools.ts";

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

/** PW-42 方向段标题（规格逐字：sections 顶部注入，无方向整段不出现）。 */
const DIRECTION_HEADER = "### 当前方向（人定的捞取取向，搬运摆盘时优先朝这个方向捞；其余纪律不变）\n";

/** 空输入下 buildSievePrompt 的现状输出（无方向，防回归金线——硬断言逐字节一致）。 */
const EMPTY_PROMPT_GOLDEN = [
  "### 输入语料评论（按点赞/时间排序，已按预算截断；共 0 条，展示 0 条）",
  "（无）",
  "",
  "### 输入语料（meta/stat）",
  "（无）",
  "",
  "### 数据文档版本链",
  "（无）",
  "",
  "### 观众声音",
  "（无）",
  "",
  "### 相关金子墓碑（判决摘要，只供背景参考）",
  "（无）",
].join("\n");

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

/** mock llm：返回写死的两卡（normal + wildcard），并记录最后一次收到的 prompt。 */
function capturingLlm(): { llm: SieveLlm; lastPrompt: () => string | null } {
  let last: string | null = null;
  return {
    llm: async (input: string) => {
      last = input;
      return JSON.stringify({ cards: MOCK_CARDS });
    },
    lastPrompt: () => last,
  };
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

/** 直接插一轮 done run + 一张 pending 候选卡（跨 run 快照对照用）。 */
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

function cardStatus(db: DatabaseSync, cardId: string): string {
  return (db.prepare("SELECT status FROM pw_sieve_cards WHERE id = ?").get(cardId) as { status: string })
    .status;
}

function countRuns(db: DatabaseSync, where: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM pw_runs WHERE ${where}`).get() as { n: number }).n);
}

type ExecRow = {
  event_type: string;
  instruction_text: string | null;
  instruction_message_id: string | null;
  payload_json: string;
  bet_id: string | null;
};

function latestExec(db: DatabaseSync): ExecRow {
  return db.prepare(`
    SELECT event_type, instruction_text, instruction_message_id, payload_json, bet_id
    FROM pw_runs WHERE kind = 'ai_exec'
    ORDER BY rowid DESC LIMIT 1
  `).get() as ExecRow;
}

function allExec(db: DatabaseSync): ExecRow[] {
  return db.prepare(`
    SELECT event_type, instruction_text, instruction_message_id, payload_json, bet_id
    FROM pw_runs WHERE kind = 'ai_exec'
    ORDER BY rowid ASC
  `).all() as ExecRow[];
}

/** mock 筛子通知器：只记 flushNow 调用次数，返回固定 runId（不断言真实 run 落库）。 */
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

// ---------------------------------------------------------------------------
// 用例 1：state set/get 往返、空串归 null、未设过返回 null
// ---------------------------------------------------------------------------

test("方向 state：未设过返回 null；set/get 往返（trim）；空串/空白/显式 null 均归 null", () => {
  const db = makeDb();
  try {
    assert.equal(getSieveDirection(db), null, "未设过返回 null");
    setSieveDirection(db, "  AI 办公提效  ");
    assert.equal(getSieveDirection(db), "AI 办公提效", "写入带空白，读回 trim 后原文");
    setSieveDirection(db, "编程工具对比");
    assert.equal(getSieveDirection(db), "编程工具对比", "覆盖旧方向");
    setSieveDirection(db, "");
    assert.equal(getSieveDirection(db), null, "空串归 null");
    setSieveDirection(db, "   ");
    assert.equal(getSieveDirection(db), null, "纯空白归 null");
    setSieveDirection(db, "AI 办公提效");
    assert.equal(getSieveDirection(db), "AI 办公提效");
    setSieveDirection(db, null);
    assert.equal(getSieveDirection(db), null, "set null 清除");
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// 用例 2：迁移幂等（二次调用不炸、旧行 direction 为 NULL）
// ---------------------------------------------------------------------------

test("迁移幂等：缺 direction 列旧表 ALTER 补列，旧行 NULL；二次 ensure 不炸", () => {
  const db = new DatabaseSync(":memory:");
  // 模拟 PW-42 之前的旧表（无 direction 列）
  db.exec(`
    CREATE TABLE pw_sieve_runs (
      id TEXT PRIMARY KEY,
      trigger_source TEXT NOT NULL,
      input_ids_json TEXT NOT NULL,
      cards_count INTEGER NOT NULL DEFAULT 0,
      dropped_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('running','done','failed')),
      error TEXT,
      model TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT
    );
  `);
  db.prepare(`
    INSERT INTO pw_sieve_runs(id, trigger_source, input_ids_json, status, created_at)
    VALUES('old-run', 'sync', '[]', 'done', '2026-08-01T00:00:00Z')
  `).run();
  try {
    ensurePwSieveTables(db);
    ensurePwSieveTables(db);
    const columns = new Set(
      (db.prepare("PRAGMA table_info(pw_sieve_runs)").all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    assert.ok(columns.has("direction"), "direction 列已补");
    const old = db.prepare("SELECT direction FROM pw_sieve_runs WHERE id = 'old-run'").get() as {
      direction: string | null;
    };
    assert.equal(old.direction, null, "旧行 direction 为 NULL");
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// 用例 3 + 4：buildSievePrompt——无方向逐字节一致（金线）；有方向首段为方向段且含原文
// ---------------------------------------------------------------------------

test("buildSievePrompt：无方向输出与现状逐字节一致（防回归金线）；空串/空白方向也不出现方向段", () => {
  const input: SieveInput = { corpora: [], comments: [], dataDocs: [], voiceItems: [], verdicts: [] };
  const baseline = buildSievePrompt(input, null);
  assert.equal(baseline, EMPTY_PROMPT_GOLDEN, "无方向输出必须与现状逐字节一致（防回归金线）");
  assert.ok(!baseline.includes("当前方向"), "无方向不得出现方向段");
  assert.equal(buildSievePrompt(input, ""), baseline, "空串方向等价无方向");
});

test("buildSievePrompt：有方向时首段为方向段且含原文，其余段逐字节不变", () => {
  const input: SieveInput = { corpora: [], comments: [], dataDocs: [], voiceItems: [], verdicts: [] };
  const direction = "AI 办公提效";
  const prompt = buildSievePrompt(input, direction);
  assert.ok(prompt.startsWith(DIRECTION_HEADER + direction + "\n\n"), "方向段在最前且紧随原内容");
  assert.ok(prompt.includes(direction), "prompt 含方向原文");
  assert.equal(prompt, DIRECTION_HEADER + direction + "\n\n" + EMPTY_PROMPT_GOLDEN, "有方向 = 方向段 + 原内容逐字节");
});

// ---------------------------------------------------------------------------
// 用例 5：run 落 direction 快照；sieveStatus 带 direction；候选卡读函数带 run_direction
// ---------------------------------------------------------------------------

test("runPwSieve：方向快照落 run 行 + prompt 注入；sieveStatus/list/get 带方向；无方向 = NULL", async () => {
  const db = makeDb();
  const dir = await mkdtemp(join(tmpdir(), "pw-sieve-dir-"));
  const { llm, lastPrompt } = capturingLlm();
  const notifier: SieveNotifier = createSieveNotifier({ db });
  try {
    const corpusId = await seedDoneCorpus(db, dir);

    // (a) 有方向：run 落快照、prompt 首段为方向段、候选卡带 run_direction、sieveStatus 带 direction
    setSieveDirection(db, "AI 办公提效");
    const run = await runPwSieve(db, "corpus_done", [corpusId], { llm, now: () => NOW_MS });
    assert.equal(run.status, "done");
    assert.equal(run.direction, "AI 办公提效", "run 行写方向快照");
    const prompt = lastPrompt()!;
    assert.ok(prompt.startsWith(DIRECTION_HEADER), "prompt 首段为方向段");
    assert.ok(prompt.includes("AI 办公提效"), "prompt 含方向原文");

    const runCards = listPwSieveCards(db, run.id);
    assert.equal(runCards.length, 2);
    for (const card of runCards) {
      assert.equal(card.run_direction, "AI 办公提效", "候选卡列表带 run 方向快照");
    }
    const byStatus = listPwSieveCardsByStatus(db, "pending");
    assert.ok(byStatus.length >= 2);
    for (const card of byStatus) assert.equal(card.run_direction, "AI 办公提效");
    assert.equal(getPwSieveCard(db, runCards[0].id).run_direction, "AI 办公提效", "单卡读函数带 run_direction");
    assert.equal(sieveStatus(db, notifier).direction, "AI 办公提效", "sieveStatus 带 direction");

    // (b) 无方向：run 快照 NULL、prompt 无方向段、sieveStatus direction 为 null
    setSieveDirection(db, null);
    const run2 = await runPwSieve(db, "corpus_done", [corpusId], { llm, now: () => NOW_MS });
    assert.equal(run2.status, "done");
    assert.equal(run2.direction, null, "无方向 run direction 为 NULL");
    assert.ok(!lastPrompt()!.includes("当前方向"), "无方向 prompt 无方向段");
    const run2Cards = listPwSieveCards(db, run2.id);
    for (const card of run2Cards) assert.equal(card.run_direction, null, "无方向 run 的卡 run_direction 为 NULL");
    assert.equal(sieveStatus(db, notifier).direction, null, "清除后 sieveStatus direction 为 null");
  } finally {
    notifier.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 用例 6：set_sieve_direction 工具——无 instruction → 500；有 → 落 ai_exec 账 + state 更新
// ---------------------------------------------------------------------------

test("set_sieve_direction：无 instruction → 500 不落账；有 instruction → state 更新 + 恰一条 ai_exec(edit) 带指令", async () => {
  // 无 instruction → 500
  {
    const db = makeDb();
    try {
      const ctx: CollabToolContext = { db, betId: "b-x", refs: new Map() };
      await assert.rejects(
        () => runTool("set_sieve_direction", { direction: "x" }, ctx),
        (error: unknown) => (error as { status?: number }).status === 500
          && /指令/.test(String((error as Error).message)),
        "缺 instruction 应抛 500",
      );
      assert.equal(countRuns(db, "kind = 'ai_exec'"), 0, "抛错路径不得落账");
      assert.equal(getSieveDirection(db), null, "抛错路径不得改 state");
    } finally {
      db.close();
    }
  }
  // 有 instruction → 设方向，落一条 ai_exec(edit)
  {
    const db = makeDb();
    try {
      const betId = makeBet(db);
      const result = await runTool("set_sieve_direction", { direction: "AI 办公提效" }, execContext(db, betId, {
        instruction: { text: "把筛子方向换成 AI 办公提效", messageId: "msg-dir" },
      }));
      assert.equal(getSieveDirection(db), "AI 办公提效", "state 更新");
      assert.ok(result.content[0].text.includes("AI 办公提效"), "返回文本报新方向");
      assert.equal(countRuns(db, "kind = 'ai_exec'"), 1);
      const exec = latestExec(db);
      assert.equal(exec.event_type, "edit");
      assert.equal(exec.instruction_text, "把筛子方向换成 AI 办公提效");
      assert.equal(exec.instruction_message_id, "msg-dir");
      assert.equal(exec.bet_id, null, "方向与押注无关，bet_id 为 null");
      assert.equal((JSON.parse(exec.payload_json) as Json).direction, "AI 办公提效", "payload 含 direction 原文");
    } finally {
      db.close();
    }
  }
  // 留空 = 清除方向（payload direction 为 null）
  {
    const db = makeDb();
    try {
      const betId = makeBet(db);
      setSieveDirection(db, "编程工具对比");
      const result = await runTool("set_sieve_direction", {}, execContext(db, betId, {
        instruction: { text: "方向不要了", messageId: "msg-dir2" },
      }));
      assert.equal(getSieveDirection(db), null, "留空清除方向");
      assert.ok(result.content[0].text.includes("清除"), "返回文本说明已清除");
      assert.equal((JSON.parse(latestExec(db).payload_json) as Json).direction, null, "payload 带 null=清除");
    } finally {
      db.close();
    }
  }
});

// ---------------------------------------------------------------------------
// 用例 7：reject_all_and_resieve 带 direction；不带 direction 回归
// ---------------------------------------------------------------------------

test("reject_all_and_resieve 带 direction：先换方向 → 全否 + 重筛，两笔 ai_exec，返回文本含方向", async () => {
  const db = makeDb();
  try {
    const betId = makeBet(db);
    const cardIds = [seedCard(db), seedCard(db), seedCard(db)];
    const { notifier, flushCount } = mockNotifier("run-42");
    const result = await runTool("reject_all_and_resieve", {
      reason: "都不行",
      direction: "AI 办公提效",
    }, execContext(db, betId, {
      instruction: { text: "全部否掉换方向重筛", messageId: "msg-42" },
      sieve: notifier,
    }));
    assert.equal(getSieveDirection(db), "AI 办公提效", "先换方向再全否重筛");
    for (const id of cardIds) assert.equal(cardStatus(db, id), "rejected", "全部否掉");
    assert.equal(flushCount(), 1, "触发一轮重筛");
    assert.equal(countRuns(db, "kind = 'ai_exec'"), 2, "两笔账：reject + sieve_run");
    const rows = allExec(db);
    assert.deepEqual(rows.map((row) => row.event_type), ["reject", "sieve_run"]);
    for (const row of rows) {
      assert.equal(row.instruction_text, "全部否掉换方向重筛");
      assert.equal(row.instruction_message_id, "msg-42");
    }
    assert.equal((JSON.parse(rows[0].payload_json) as Json).reason, "都不行");
    assert.equal((JSON.parse(rows[1].payload_json) as Json).runId, "run-42");
    assert.ok(result.content[0].text.includes("AI 办公提效"), "返回文本含新方向");
    assert.ok(result.content[0].text.includes("否掉 3 张候选卡"), "返回文本含全否计数");
  } finally {
    db.close();
  }
});

test("reject_all_and_resieve 不带 direction：行为与现状一致（不碰方向、返回文本逐字不变）", async () => {
  const db = makeDb();
  try {
    const betId = makeBet(db);
    const cardIds = [seedCard(db), seedCard(db)];
    const { notifier, flushCount } = mockNotifier("run-43");
    const result = await runTool("reject_all_and_resieve", {}, execContext(db, betId, {
      instruction: { text: "重筛", messageId: "msg-43" },
      sieve: notifier,
    }));
    assert.equal(getSieveDirection(db), null, "无 direction 不碰方向");
    for (const id of cardIds) assert.equal(cardStatus(db, id), "rejected");
    assert.equal(flushCount(), 1);
    assert.equal(countRuns(db, "kind = 'ai_exec'"), 2, "两笔账：reject + sieve_run");
    assert.deepEqual(allExec(db).map((row) => row.event_type), ["reject", "sieve_run"]);
    assert.equal(
      result.content[0].text,
      "已按你的指令否掉 2 张候选卡并触发一轮重筛（runId run-43）。",
      "无 direction 返回文本与现状逐字一致",
    );
  } finally {
    db.close();
  }
});
