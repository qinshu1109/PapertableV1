/**
 * TASK-PW-21：对话深挖工具扩容测试。
 * 覆盖：8 个新只读工具逐个执行断言（内存库 + 临时目录落盘语料：done 语料、
 * 版本链、verdict、connections、pending 卡）、权限静态化延续（无写正式表工具、
 * 无 pick/reject 名单，与 PW-19 §三 同名单独立断言）、装配 v3（待选候选卡块
 * wildcard 标注「少数派」+ 语料库清单块，§N 全轮稳定）。
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
import {
  ensurePwConnectionTables,
  registerPwConnection,
  setPwConnectionStatus,
} from "./pw-connections.ts";
import {
  appendPwDataDocVersion,
  createPwDataDoc,
  ensurePwDataDocTables,
} from "./pw-data-docs.ts";
import { ensurePwDraftTables } from "./pw-drafts.ts";
import { ensurePwGoldMirrorTables } from "./pw-gold-sync.ts";
import { ensurePwRunTables } from "./pw-runs.ts";
import { ensurePwSieveTables } from "./pw-sieve.ts";
import { ensurePwVerdictTables, settlePwBet } from "./pw-verdicts.ts";
import { ensurePwVoiceTables } from "./pw-voice.ts";
import {
  authorizePwCorpus,
  donePwCorpus,
  ensurePwCorpusTables,
} from "./pw-corpus.ts";
import { buildCollabContext } from "./pw-context.ts";
import { ensurePwCollabTables } from "./pw-collab.ts";
import {
  pwCollabDeniedToolNames,
  pwCollabTools,
  type CollabTool,
  type CollabToolContext,
} from "./pw-collab-tools.ts";

type Json = Record<string, unknown>;

const BV1 = "BV1NprhBPEtR";
const BV2 = "BV1xx411c7mD";

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

const COMMENTS = [
  { rpid: 101, uname: "甲", message: "直播做产品实践这个实验设计得真巧妙", like: 12, ctime: 1700000001, replies: 3 },
  { rpid: 102, uname: "乙", message: "少数派声音：录屏不剪辑也有人看", like: 3, ctime: 1700000002, replies: 0 },
  { rpid: 103, uname: "丙", message: "干货密度高，全程无尿点", like: 8, ctime: 1700000003, replies: 1 },
  { rpid: 104, uname: "丁", message: "这期节奏太慢了", like: 2, ctime: 1700000004, replies: 0 },
];

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwBetTables(db);
  ensurePwArtifactTables(db);
  ensurePwDataDocTables(db);
  ensurePwVerdictTables(db);
  ensurePwGoldMirrorTables(db);
  ensurePwVoiceTables(db);
  ensurePwDraftTables(db);
  ensurePwRunTables(db);
  ensurePwConnectionTables(db);
  ensurePwCorpusTables(db);
  ensurePwCollabTables(db);
  ensurePwSieveTables(db);
  return db;
}

function makeBet(db: DatabaseSync, overrides: Json = {}): string {
  return createPwBet(db, {
    title: "直播做产品实践",
    thesis: "直播系列能成",
    metric: "三期平均播放 ≥ 5000",
    dataSourcePlan: "B站",
    checkoutDate: "2026-09-01",
    confidence: 70,
    status: "pending",
    ...overrides,
  }).id;
}

function toolContext(db: DatabaseSync, betId: string): CollabToolContext {
  return { db, betId, refs: new Map() };
}

function requireTool(name: string): CollabTool {
  const tool = pwCollabTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`工具不存在: ${name}`);
  return tool;
}

function resultText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0].text;
}

function hasStatus(error: unknown, status: number): boolean {
  return typeof error === "object" && error !== null && "status" in error
    && (error as { status: unknown }).status === status;
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

/** 造一张筛子候选卡（挂在一个 done run 下），返回卡 id。 */
function seedCard(
  db: DatabaseSync,
  seed: {
    kind?: "normal" | "wildcard";
    quoteText?: string;
    quoteSourceJson?: string;
    sortScore?: number;
    status?: "pending" | "picked" | "edited" | "rejected";
    scaleNote?: string | null;
    hookNote?: string | null;
    freshnessNote?: string | null;
  } = {},
): string {
  const runId = randomUUID();
  db.prepare(`
    INSERT INTO pw_sieve_runs(
      id, trigger_source, input_ids_json, cards_count, dropped_count,
      status, error, model, created_at, finished_at
    ) VALUES(?, 'manual', '[]', 0, 0, 'done', NULL, NULL, ?, NULL)
  `).run(runId, new Date().toISOString());
  const cardId = randomUUID();
  db.prepare(`
    INSERT INTO pw_sieve_cards(
      id, run_id, kind, quote_text, quote_source_json, scale_note, scale_value,
      hook_note, freshness_note, sort_score, status, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
  `).run(
    cardId,
    runId,
    seed.kind ?? "normal",
    seed.quoteText ?? "私域课定价这么贵还有人买",
    seed.quoteSourceJson ?? JSON.stringify({ bvid: BV1, uname: "路人甲", like: 42 }),
    seed.scaleNote ?? null,
    seed.hookNote ?? null,
    seed.freshnessNote ?? null,
    seed.sortScore ?? 0,
    seed.status ?? "pending",
    new Date().toISOString(),
  );
  return cardId;
}

function insertVerdict(
  db: DatabaseSync,
  input: { id: string; betId: string; outcome: "gold" | "tomb"; text: string },
): void {
  db.prepare(`
    INSERT INTO pw_verdicts(
      id, bet_id, outcome, lesson, cause_of_death, evidence_doc_ids_json,
      confidence_snapshot, decided_by, decided_at, created_at
    ) VALUES(?, ?, ?, ?, ?, '[]', NULL, 'human', ?, ?)
  `).run(
    input.id,
    input.betId,
    input.outcome,
    input.outcome === "gold" ? input.text : null,
    input.outcome === "tomb" ? input.text : null,
    "2026-08-01T00:00:00Z",
    "2026-08-01T00:00:00Z",
  );
}

// ---------------------------------------------------------------------------
// 八个新只读工具逐个执行断言
// ---------------------------------------------------------------------------

test("list_corpus：已抓 BV 清单（bvid/标题/UP主/状态/评论数/抓取时间）", async () => {
  const db = makeDb();
  const dir = await mkdtemp(join(tmpdir(), "pw21-list-corpus-"));
  try {
    const betId = makeBet(db);
    await seedDoneCorpus(db, dir);
    const pending = authorizePwCorpus(db, { bvid: BV2 });

    const result = await requireTool("list_corpus").execute(
      "call-1", {}, undefined, undefined, toolContext(db, betId),
    );
    const text = resultText(result);
    assert.ok(text.includes(BV1), "done 语料在列");
    assert.ok(text.includes("测试成片"));
    assert.ok(text.includes("某UP主"));
    assert.ok(text.includes("状态=done"));
    assert.ok(text.includes(`状态=${pending.doc.status}`), "pending 语料在列");
    assert.ok(text.includes("评论=4"));
    assert.match(text, /抓取=\d{4}-/);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("read_corpus_doc：整 doc + video_stat 七项", async () => {
  const db = makeDb();
  const dir = await mkdtemp(join(tmpdir(), "pw21-read-doc-"));
  try {
    const betId = makeBet(db);
    await seedDoneCorpus(db, dir);

    const result = await requireTool("read_corpus_doc").execute(
      "call-2", { bvid: BV1 }, undefined, undefined, toolContext(db, betId),
    );
    const text = resultText(result);
    assert.ok(text.includes(`bvid：${BV1}`));
    assert.ok(text.includes("测试成片"));
    assert.ok(text.includes("某UP主"));
    assert.ok(text.includes("状态：done"));
    assert.ok(text.includes("评论数：4"));
    for (const field of ["播放=100", "弹幕=5", "评论=4", "收藏=20", "投币=10", "分享=3", "点赞=30"]) {
      assert.ok(text.includes(field), `video_stat 应含 ${field}`);
    }
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("read_corpus_comments：评论全文分页（含 rpid/ctime/replies）", async () => {
  const db = makeDb();
  const dir = await mkdtemp(join(tmpdir(), "pw21-read-comments-"));
  try {
    const betId = makeBet(db);
    await seedDoneCorpus(db, dir);

    const tool = requireTool("read_corpus_comments");
    const first = await tool.execute(
      "call-3", { bvid: BV1, offset: 0, limit: 2 }, undefined, undefined, toolContext(db, betId),
    );
    const firstText = resultText(first);
    assert.ok(firstText.includes("[rpid=101]"));
    assert.ok(firstText.includes("直播做产品实践这个实验设计得真巧妙"));
    assert.ok(firstText.includes("ctime=1700000001"));
    assert.ok(firstText.includes("回复 3"));
    assert.ok(!firstText.includes("这期节奏太慢了"), "limit=2 截断后不出现第四条");

    const second = await tool.execute(
      "call-4", { bvid: BV1, offset: 2 }, undefined, undefined, toolContext(db, betId),
    );
    const secondText = resultText(second);
    assert.ok(secondText.includes("[rpid=103]"));
    assert.ok(secondText.includes("[rpid=104]"));

    // bvid 非法/缺失 → 404
    await assert.rejects(
      () => tool.execute("call-5", { bvid: "BV1xx411c7mD" }, undefined, undefined, toolContext(db, betId)),
      (error: unknown) => hasStatus(error, 404),
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("read_doc_versions：版本链全历史（version 正序，含 method/冻结/采集时间）", async () => {
  const db = makeDb();
  try {
    const betId = makeBet(db);
    const first = createPwDataDoc(db, {
      betId,
      platform: "bilibili",
      collectedAt: "2026-08-01T00:00:00.000Z",
      metricsJson: '{"播放":10}',
      rawRef: "ref-1",
    });
    appendPwDataDocVersion(db, first.id, '{"播放":20}');

    const result = await requireTool("read_doc_versions").execute(
      "call-6", {}, undefined, undefined, toolContext(db, betId),
    );
    const text = resultText(result);
    assert.ok(text.includes("v1 [bilibili]"), "v1 在版本链");
    assert.ok(text.includes("v2 [bilibili]"), "v2 在版本链");
    assert.ok(text.includes("采集 2026-08-01T00:00:00.000Z"));
    assert.ok(text.includes("{\"播放\":10}") && text.includes("{\"播放\":20}"));
    assert.ok(text.indexOf("v1") < text.indexOf("v2"), "version 正序");
  } finally {
    db.close();
  }
});

test("read_verdict_evidence：判决 + 证据链 + 来源押注", async () => {
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

    const result = await requireTool("read_verdict_evidence").execute(
      "call-7", { id: verdict.id }, undefined, undefined, toolContext(db, betId),
    );
    const text = resultText(result);
    assert.ok(text.includes("（金子）"));
    assert.ok(text.includes("来源押注：直播做产品实践"));
    assert.ok(text.includes("开头 30 秒放痛点有效"));
    assert.ok(text.includes("置信度快照：70%"));
    assert.ok(text.includes("[bilibili] 采集 2026-08-02T00:00:00.000Z"));
    assert.ok(text.includes('{"播放":100,"点赞":5}'));
  } finally {
    db.close();
  }
});

test("read_connections：连接状态/last_sync_at/risk_events", async () => {
  const db = makeDb();
  try {
    const betId = makeBet(db);
    const conn = registerPwConnection(db, { platform: "B站", accountLabel: "琴疏" });
    setPwConnectionStatus(db, conn.id, "needs_human", "出现滑块验证");

    const result = await requireTool("read_connections").execute(
      "call-8", {}, undefined, undefined, toolContext(db, betId),
    );
    const text = resultText(result);
    assert.ok(text.includes("[B站]"));
    assert.ok(text.includes("状态=needs_human"));
    assert.ok(text.includes("最近同步=—"));
    assert.ok(text.includes("出现滑块验证"), "risk_events 明细在输出");
  } finally {
    db.close();
  }
});

test("list_sieve_cards：候选卡列表（kind/引文/四字段/score/status），wildcard 另置一区，支持 status 过滤", async () => {
  const db = makeDb();
  try {
    const betId = makeBet(db);
    const high = seedCard(db, {
      quoteText: "干货密度高，全程无尿点",
      quoteSourceJson: JSON.stringify({ bvid: BV1, uname: "丙", like: 8 }),
      sortScore: 9,
      scaleNote: "高赞",
      hookNote: "开头钩子",
      freshnessNote: "新发布",
    });
    const low = seedCard(db, {
      quoteText: "这期节奏太慢了",
      quoteSourceJson: JSON.stringify({ bvid: BV1, uname: "丁", like: 2 }),
      sortScore: 3,
    });
    const wild = seedCard(db, {
      kind: "wildcard",
      quoteText: "少数派声音：录屏不剪辑也有人看",
      quoteSourceJson: JSON.stringify({ bvid: BV1, uname: "乙", like: 3 }),
      sortScore: 0,
    });
    const picked = seedCard(db, {
      quoteText: "已挑选的内容押注引文",
      status: "picked",
      sortScore: 99,
    });

    const tool = requireTool("list_sieve_cards");
    const all = resultText(await tool.execute(
      "call-9", {}, undefined, undefined, toolContext(db, betId),
    ));
    assert.ok(all.includes(high), "normal 卡在列");
    assert.ok(all.includes(low));
    assert.ok(all.includes(wild));
    assert.ok(all.includes("少数派 1"), "wildcard 菜号牌标注少数派 N");
    assert.ok(all.indexOf(high) < all.indexOf(low), "normal 按 sort_score 降序");
    assert.ok(all.indexOf(low) < all.indexOf(wild), "wildcard 另置在 normal 之后");
    assert.ok(all.includes("scale=1 高赞") && all.includes("hook=开头钩子") && all.includes("freshness=新发布"));
    assert.ok(all.includes(`score=9`));
    assert.ok(all.includes("status=pending"));

    const pendingOnly = resultText(await tool.execute(
      "call-10", { status: "pending" }, undefined, undefined, toolContext(db, betId),
    ));
    assert.ok(!pendingOnly.includes(picked), "status=pending 过滤掉 picked 卡");

    const pickedOnly = resultText(await tool.execute(
      "call-11", { status: "picked" }, undefined, undefined, toolContext(db, betId),
    ));
    assert.ok(pickedOnly.includes(picked));
    assert.ok(!pickedOnly.includes(high));
  } finally {
    db.close();
  }
});

test("read_sieve_card：单卡详情（quote_source_json 全量），不存在明确报错", async () => {
  const db = makeDb();
  try {
    const betId = makeBet(db);
    const cardId = seedCard(db, {
      kind: "wildcard",
      quoteText: "少数派声音：录屏不剪辑也有人看",
      quoteSourceJson: JSON.stringify({ bvid: BV1, uname: "乙", like: 3, rpid: 102 }),
      sortScore: 0,
    });

    const result = await requireTool("read_sieve_card").execute(
      "call-12", { id: cardId }, undefined, undefined, toolContext(db, betId),
    );
    const text = resultText(result);
    assert.ok(text.includes("（少数派）"));
    assert.ok(text.includes("少数派声音：录屏不剪辑也有人看"));
    assert.ok(text.includes('{"bvid":"BV1NprhBPEtR","uname":"乙","like":3,"rpid":102}'),
      "quote_source_json 全量回显");
    assert.ok(text.includes("sort_score：0"));
    assert.ok(text.includes("状态：pending"));

    await assert.rejects(
      () => requireTool("read_sieve_card").execute(
        "call-13", { id: "missing-card" }, undefined, undefined, toolContext(db, betId),
      ),
      (error: unknown) => hasStatus(error, 404),
    );
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// 权限静态化延续：无写正式表工具；pick/reject 已进表（PW-25，人发话才执行）
// ---------------------------------------------------------------------------

test("权限静态化：无写正式表工具；新工具全 allow 只读；pick/reject 已进表", () => {
  const names = new Set(pwCollabTools.map((tool) => tool.name));
  for (const denied of pwCollabDeniedToolNames) {
    assert.equal(names.has(denied), false, `工具表不允许出现 ${denied}`);
  }
  // 本任务 8 个新工具全部 allow 只读
  for (const name of [
    "list_corpus",
    "read_corpus_doc",
    "read_corpus_comments",
    "read_doc_versions",
    "read_verdict_evidence",
    "read_connections",
    "list_sieve_cards",
    "read_sieve_card",
  ]) {
    const tool = pwCollabTools.find((candidate) => candidate.name === name);
    assert.ok(tool, `工具 ${name} 存在`);
    assert.equal(tool!.policy, "allow", `${name} 应为 allow 只读`);
    assert.match(tool!.description, /只读/, `${name} 描述应带只读语义`);
  }
  // TASK-PW-25：挑/否进表（人发话才执行）；create_content_bet 无独立工具且已移出 deny
  assert.equal(names.has("pick_sieve_card"), true, "工具表应含 pick_sieve_card");
  assert.equal(names.has("reject_sieve_card"), true, "工具表应含 reject_sieve_card");
  assert.equal(names.has("create_content_bet"), false, "工具表不允许出现 create_content_bet");
  assert.equal(pwCollabDeniedToolNames.includes("create_content_bet"), false, "create_content_bet 已移出 deny");
});

// ---------------------------------------------------------------------------
// 装配 v3：待选候选卡块（wildcard 标注）+ 语料库清单块；§N 全轮稳定
// ---------------------------------------------------------------------------

test("装配 v3：注入待选候选卡块（wildcard 标注少数派）与语料库清单块；§N 稳定", async () => {
  const db = makeDb();
  const dir = await mkdtemp(join(tmpdir(), "pw21-context-"));
  try {
    const betId = makeBet(db);
    insertVerdict(db, { id: "gold-1", betId: "g", outcome: "gold", text: "开头 30 秒放痛点有效" });
    insertVerdict(db, { id: "tomb-1", betId: "t", outcome: "tomb", text: "无剪辑录屏没人看" });
    await seedDoneCorpus(db, dir);
    authorizePwCorpus(db, { bvid: BV2 });

    const normalHigh = seedCard(db, {
      quoteText: "干货密度高，全程无尿点",
      quoteSourceJson: JSON.stringify({ bvid: BV1, uname: "丙", like: 8 }),
      sortScore: 9,
    });
    const normalLow = seedCard(db, {
      quoteText: "这期节奏太慢了",
      quoteSourceJson: JSON.stringify({ bvid: BV1, uname: "丁", like: 2 }),
      sortScore: 3,
    });
    const wild = seedCard(db, {
      kind: "wildcard",
      quoteText: "少数派声音：录屏不剪辑也有人看",
      quoteSourceJson: JSON.stringify({ bvid: BV1, uname: "乙", like: 3 }),
      sortScore: 0,
    });
    const picked = seedCard(db, {
      quoteText: "已挑选的引文不应进待选块",
      status: "picked",
      sortScore: 99,
    });

    const first = buildCollabContext(db, betId);
    const markdown = first.markdown;
    assert.ok(markdown.includes("## 待选候选卡（草稿，只读引用）"), "待选候选卡块存在");
    assert.ok(markdown.includes("## 语料库清单"), "语料库清单块存在");

    // 候选卡块：normal 按 sort_score 降序，wildcard 单列；TASK-PW-27 菜号牌「证据 N / 少数派 N·id」
    const cardSection = markdown.split("## 语料库清单")[0];
    const cardIds = [normalHigh, normalLow, wild].map((id) => `·${id}]`);
    const positions = cardIds.map((needle) => cardSection.indexOf(needle));
    assert.ok(positions.every((position) => position >= 0), "三张 pending 卡都在候选卡块");
    assert.ok(positions[0] < positions[1] && positions[1] < positions[2], "sort_score 降序且 wildcard 置后");
    assert.ok(cardSection.includes(`[证据 1·${normalHigh}]`), "normal 首卡菜号牌证据 1");
    assert.ok(cardSection.includes(`[少数派 1·${wild}] 少数派声音：录屏不剪辑也有人看`), "wildcard 菜号牌少数派 1");
    assert.ok(!cardSection.includes(picked), "非 pending 卡不进待选块");

    // 语料库清单块：done 与 pending 都列，含评论数与状态
    const corpusSection = markdown.split("## 语料库清单")[1];
    assert.ok(corpusSection.includes(BV1));
    assert.ok(corpusSection.includes(BV2));
    assert.ok(corpusSection.includes("评论=4") && corpusSection.includes("状态=done"));
    assert.ok(corpusSection.includes("状态=pending"));

    // §N 全轮稳定：两次装配编号与内容完全一致
    const second = buildCollabContext(db, betId);
    assert.deepEqual(
      first.golds.map((gold) => `${gold.ref}:${gold.id}`),
      second.golds.map((gold) => `${gold.ref}:${gold.id}`),
    );
    assert.deepEqual(
      first.tombs.map((tomb) => `${tomb.ref}:${tomb.id}`),
      second.tombs.map((tomb) => `${tomb.ref}:${tomb.id}`),
    );
    const tomb = first.tombs.find((item) => item.id === "tomb-1");
    assert.equal(tomb!.ref, `§${first.golds.length + 1}`, "墓碑编号在金子后续接，规则不变");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
