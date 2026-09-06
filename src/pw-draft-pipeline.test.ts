/**
 * TASK-PW-32：素材起草管线测试（内存库自包含 + mock llm，照 pw-sieve.test.ts /
 * pw-content-bets.test.ts 先例）。
 * 覆盖：证据装配各区块 / 非 content|pending 押注 409 / 正常三份落库 + ai_draft 痕 /
 * 节点数越界丢弃 / 存活 <2 防平庸停线 / 宣告扫描 / gold_ref 编号表规范化 /
 * §N 引用落库与幂等 / LLM 重试 / 重复路子与缺路子 / eval 复用 dry-run。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { nowIso } from "./data.ts";
import { createPwBet, ensurePwBetTables } from "./pw-bets.ts";
import { ensurePwDataDocTables } from "./pw-data-docs.ts";
import { ensurePwCorpusTables } from "./pw-corpus.ts";
import { pickPwSieveCard, rejectPwSieveCard } from "./pw-content-bets.ts";
import {
  createPwContentDrafts,
  ensurePwContentDraftTables,
  rejectPwContentDraft,
  updatePwContentDraft,
} from "./pw-content-drafts.ts";
import { ensurePwGoldMirrorTables } from "./pw-gold-sync.ts";
import { ensurePwRunTables } from "./pw-runs.ts";
import { ensurePwSieveTables } from "./pw-sieve.ts";
import { ensurePwVerdictTables } from "./pw-verdicts.ts";
import {
  ensurePwVerdictRefTables,
  recordPwVerdictRefs,
  type PwVerdictRefRow,
  type RefTableItem,
} from "./pw-verdict-refs.ts";
import {
  buildDraftEvidence,
  buildDraftPrompt,
  parseDraftJson,
  postProcessDrafts,
  runPwDraftPipeline,
  type DraftLlm,
  type ParsedDraft,
} from "./pw-draft-pipeline.ts";

type Json = Record<string, unknown>;

// ---- 内存库与种子 ----

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwBetTables(db);
  ensurePwSieveTables(db);
  ensurePwRunTables(db);
  ensurePwContentDraftTables(db);
  ensurePwVerdictTables(db);
  ensurePwGoldMirrorTables(db);
  ensurePwVerdictRefTables(db);
  ensurePwDataDocTables(db);
  ensurePwCorpusTables(db);
  return db;
}

type CardSeed = {
  quote_text?: string;
  status?: "pending" | "picked" | "edited" | "rejected";
};

/** 造一张筛子候选卡（挂在一个 done run 下），返回卡 id。 */
function seedCard(db: DatabaseSync, seed: CardSeed = {}): string {
  const runId = randomUUID();
  db.prepare(`
    INSERT INTO pw_sieve_runs(
      id, trigger_source, input_ids_json, cards_count, dropped_count,
      status, error, model, created_at, finished_at
    ) VALUES(?, 'manual', '[]', 0, 0, 'done', NULL, NULL, ?, NULL)
  `).run(runId, nowIso());
  const cardId = randomUUID();
  db.prepare(`
    INSERT INTO pw_sieve_cards(
      id, run_id, kind, quote_text, quote_source_json, scale_note, scale_value,
      hook_note, freshness_note, sort_score, status, created_at
    ) VALUES(?, ?, 'normal', ?, ?, NULL, 1, NULL, NULL, 0, ?, ?)
  `).run(
    cardId,
    runId,
    seed.quote_text ?? "私域课定价这么贵还有人买",
    JSON.stringify({ bvid: "BV1NprhBPEtR", uname: "路人甲", like: 42 }),
    seed.status ?? "pending",
    nowIso(),
  );
  return cardId;
}

/** 挑一张卡成在途内容押注（kind=content、status=pending）。 */
function seedContentBet(db: DatabaseSync, quote = "私域课定价这么贵还有人买"): { betId: string; cardId: string } {
  const cardId = seedCard(db, { quote_text: quote });
  const bet = pickPwSieveCard(db, cardId);
  return { betId: bet.id, cardId };
}

/** 造一张否过的候选卡（含 reject 留痕）。 */
function seedRejectedCard(db: DatabaseSync, quoteText: string, reason?: string): string {
  const cardId = seedCard(db, { quote_text: quoteText });
  rejectPwSieveCard(db, cardId, reason);
  return cardId;
}

/** 造一份否过的素材草案（bad case）。 */
function seedBadDraft(db: DatabaseSync, betId: string, route: string, titleCandidate: string, reason?: string): void {
  const [draft] = createPwContentDrafts(db, betId, [{
    route,
    titleCandidate,
    skeletonJson: JSON.stringify([{ text: "骨架节点" }]),
  }]);
  rejectPwContentDraft(db, draft.id, reason);
}

/** 造一条改稿痕迹（edits 行）。 */
function seedEditTrail(db: DatabaseSync, betId: string): void {
  const [draft] = createPwContentDrafts(db, betId, [{
    route: "贴热点",
    titleCandidate: "改前标题",
    skeletonJson: JSON.stringify([{ text: "改前骨架" }]),
  }]);
  updatePwContentDraft(db, draft.id, {
    titleCandidate: "改后标题",
    skeletonJson: JSON.stringify([{ text: "改后骨架" }, { text: "新增节点" }]),
  });
}

/** 造一条镇纸金子（pw_verdicts）。 */
function seedGold(db: DatabaseSync, id: string, lesson: string): void {
  db.prepare(`
    INSERT INTO pw_verdicts(
      id, bet_id, outcome, lesson, cause_of_death, evidence_doc_ids_json,
      confidence_snapshot, decided_by, decided_at, created_at
    ) VALUES(?, ?, 'gold', ?, NULL, '[]', NULL, 'human', ?, ?)
  `).run(id, `bet-${id}`, lesson, "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z");
}

/** 造一条镇纸墓碑（pw_verdicts）。 */
function seedTomb(db: DatabaseSync, id: string, causeOfDeath: string): void {
  db.prepare(`
    INSERT INTO pw_verdicts(
      id, bet_id, outcome, lesson, cause_of_death, evidence_doc_ids_json,
      confidence_snapshot, decided_by, decided_at, created_at
    ) VALUES(?, ?, 'tomb', NULL, ?, '[]', NULL, 'human', ?, ?)
  `).run(id, `bet-${id}`, causeOfDeath, "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z");
}

// ---- mock llm 与载荷 ----

/** mock llm：直接返回写死的草案数组 JSON。 */
function mockDraftLlm(drafts: unknown[]): DraftLlm {
  return async () => JSON.stringify(drafts);
}

/** 6 节点大纲（节点数落在 5–7 区间）。 */
function sixNodes(prefix: string, goldRef: string | null = null): Array<{ text: string; gold_ref: string | null }> {
  return Array.from({ length: 6 }, (_, i) => ({ text: `${prefix}节点${i + 1}`, gold_ref: goldRef }));
}

/** 标准三路载荷（每份 6 节点）。 */
function threeRoutePayload(goldRef: string | null = null): unknown[] {
  return [
    { route: "贴热点", title_candidate: "热点标题候选", skeleton: sixNodes("贴热点", goldRef) },
    { route: "少数派", title_candidate: "少数派标题候选", skeleton: sixNodes("少数派", goldRef) },
    { route: "反共识", title_candidate: "反共识标题候选", skeleton: sixNodes("反共识", goldRef) },
  ];
}

function countRows(db: DatabaseSync, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

function assertStatus(error: unknown, status: number): void {
  assert.equal((error as { status?: number }).status, status);
}

// ---- 测试清单 ----

test("1. buildDraftEvidence：押注三行/否过候选卡（含 reason）/否过草案/改稿 diff/金子墓碑 §N 各区块齐", () => {
  const db = makeDb();
  try {
    const { betId } = seedContentBet(db);
    seedRejectedCard(db, "被否掉的引文", "方向不对");
    seedBadDraft(db, betId, "贴热点", "被否的草案标题", "跑题了");
    seedEditTrail(db, betId);
    seedGold(db, "gold-1", "开头 30 秒放痛点有效");
    seedTomb(db, "tomb-1", "无剪辑录屏没人看");

    const evidence = buildDraftEvidence(db, betId);

    assert.equal(evidence.bet.id, betId);
    assert.equal(evidence.bet.title, "私域课定价这么贵还有人买");
    assert.ok(evidence.bet.thesis.includes("私域课定价这么贵还有人买"), "thesis 应含押注引文（演示困惑）");
    assert.ok(evidence.bet.thesis.includes("BV1NprhBPEtR"), "thesis 应含 bvid 来源");
    assert.equal(evidence.bet.metric, "私域加群/问工具人数");
    assert.equal(evidence.bet.metricTarget, "10");
    assert.equal(evidence.bet.dataSourcePlan, "私域群/评论区人工统计");
    assert.match(evidence.bet.checkoutDate ?? "", /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(evidence.bet.confidence, null);

    assert.equal(evidence.rejectedCards.length, 1, "否过候选卡近 5 张");
    assert.equal(evidence.rejectedCards[0].quoteText, "被否掉的引文");
    assert.equal(evidence.rejectedCards[0].reason, "方向不对", "reason 从 reject 事件 payload 解析");

    assert.equal(evidence.badCases.length, 1, "bad case 近 5 条");
    assert.equal(evidence.badCases[0].route, "贴热点");
    assert.equal(evidence.badCases[0].titleCandidate, "被否的草案标题");
    assert.equal(evidence.badCases[0].rejectReason, "跑题了");
    assert.equal(evidence.badCases[0].betTitle, "私域课定价这么贵还有人买");

    assert.equal(evidence.editTrails.length, 1, "改稿痕迹近 3 条");
    assert.ok(evidence.editTrails[0].before.includes("改前标题"));
    assert.ok(evidence.editTrails[0].after.includes("改后标题"));

    assert.equal(evidence.refTable.length, 2, "金子 + 墓碑编号表");
    assert.deepEqual(evidence.refTable[0], { ref: "§1", id: "gold-1", source: "paperweight", kind: "gold" });
    assert.deepEqual(evidence.refTable[1], { ref: "§2", id: "tomb-1", source: "paperweight", kind: "tomb" });
    assert.ok(evidence.collabMarkdown.includes("开头 30 秒放痛点有效"), "collab 区块含金子原文");
    assert.ok(evidence.collabMarkdown.includes("§1"), "collab 区块含 §N 标注");
  } finally {
    db.close();
  }
});

test("2. 非 content 或非 pending 押注 → 409；押注不存在 → 409", async () => {
  const db = makeDb();
  try {
    const cardId = seedCard(db, { quote_text: "普通引文" });

    // kind='verdict' 且 pending → 409
    const verdictBet = createPwBet(db, {
      title: "传统押注",
      thesis: "假设",
      status: "pending",
      metric: "播放量",
      data_source_plan: "B站",
      checkout_date: "2026-08-15",
    });
    assert.throws(() => buildDraftEvidence(db, verdictBet.id), (error) => {
      assertStatus(error, 409);
      return true;
    });
    await assert.rejects(runPwDraftPipeline(db, verdictBet.id, { llm: mockDraftLlm([]) }), (error) => {
      assertStatus(error, 409);
      return true;
    });

    // kind='content' 但已非 pending → 409
    const content = pickPwSieveCard(db, cardId);
    db.prepare("UPDATE pw_bets SET status = 'settled' WHERE id = ?").run(content.id);
    await assert.rejects(runPwDraftPipeline(db, content.id, { llm: mockDraftLlm([]) }), (error) => {
      assertStatus(error, 409);
      return true;
    });

    // 押注不存在 → 409
    await assert.rejects(runPwDraftPipeline(db, "no-such-bet", { llm: mockDraftLlm([]) }), (error) => {
      assertStatus(error, 409);
      return true;
    });
  } finally {
    db.close();
  }
});

test("3. mock llm 正常三份 → 三份落库（同 batch、route 齐、status=draft）+ pw_runs ai_draft/draft 痕（payload created=3）", async () => {
  const db = makeDb();
  try {
    const { betId } = seedContentBet(db);
    const result = await runPwDraftPipeline(db, betId, { llm: mockDraftLlm(threeRoutePayload()) });

    assert.equal(result.created.length, 3);
    assert.equal(new Set(result.created.map((row) => row.batch_id)).size, 1, "同批共用 batchId");
    assert.deepEqual(
      [...new Set(result.created.map((row) => row.route))].sort(),
      ["反共识", "少数派", "贴热点"],
    );
    assert.ok(result.created.every((row) => row.status === "draft"));
    assert.deepEqual(result.dropped, []);
    assert.deepEqual(result.refStats, { inserted: 0, dropped: [] });

    const event = db.prepare(`
      SELECT * FROM pw_runs WHERE kind = 'ai_draft' AND event_type = 'draft'
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get() as Json;
    assert.ok(event, "应有 ai_draft/draft 留痕");
    assert.equal(event.actor, "ai");
    assert.equal(event.bet_id, betId);
    const payload = JSON.parse(String(event.payload_json)) as Json;
    assert.equal(payload.betId, betId);
    assert.equal(payload.created, 3);
    assert.deepEqual(payload.routes, ["贴热点", "少数派", "反共识"]);
    assert.equal(payload.model, null, "注入 mock 且未给 modelLabel → model=null");
  } finally {
    db.close();
  }
});

test("4. 节点数越界（4 节点）那份被 drop、其余存活 → run done", async () => {
  const db = makeDb();
  try {
    const { betId } = seedContentBet(db);
    const payload = [
      { route: "贴热点", title_candidate: "t1", skeleton: sixNodes("贴热点").slice(0, 4) },
      { route: "少数派", title_candidate: "t2", skeleton: sixNodes("少数派") },
      { route: "反共识", title_candidate: "t3", skeleton: sixNodes("反共识") },
    ];
    const result = await runPwDraftPipeline(db, betId, { llm: mockDraftLlm(payload) });

    assert.equal(result.created.length, 2, "越界份被 drop，其余两路存活");
    assert.deepEqual(result.created.map((row) => row.route).sort(), ["反共识", "少数派"]);
    assert.equal(result.dropped.length, 1);
    assert.equal(result.dropped[0].route, "贴热点");
    assert.match(result.dropped[0].reason, /节点数 4 越界/);
    assert.deepEqual(result.droppedReasons, ["节点数 4 越界（须 5–7）"]);
    assert.equal(countRows(db, "pw_content_drafts"), 2);
  } finally {
    db.close();
  }
});

test("5. 存活 <2 份 → run failed、零草案落库、失败痕 payload 含原因", async () => {
  const db = makeDb();
  try {
    const { betId } = seedContentBet(db);
    const payload = [
      { route: "贴热点", title_candidate: "t1", skeleton: sixNodes("贴热点").slice(0, 4) },
      { route: "少数派", title_candidate: "t2", skeleton: sixNodes("少数派").slice(0, 4) },
    ];
    const result = await runPwDraftPipeline(db, betId, { llm: mockDraftLlm(payload) });

    assert.equal(result.created.length, 0, "failed 零草案落库");
    assert.equal(countRows(db, "pw_content_drafts"), 0);
    assert.equal(countRows(db, "pw_verdict_refs"), 0);
    assert.equal(result.dropped.length, 2);

    const event = db.prepare(`
      SELECT * FROM pw_runs WHERE kind = 'ai_draft' AND event_type = 'draft'
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get() as Json;
    const failurePayload = JSON.parse(String(event.payload_json)) as Json;
    assert.equal(failurePayload.created, 0);
    assert.ok(String(failurePayload.error).includes("防平庸停线"), "失败痕 payload 含原因");
    assert.ok(String(failurePayload.error).includes("节点数 4 越界"), "失败原因明细带进 error");
  } finally {
    db.close();
  }
});

test("6. 宣告扫描：含「已避开墓碑」/「推荐选这份」的份被 drop（title 与节点文本都扫）", () => {
  const parsed: ParsedDraft[] = [
    { route: "贴热点", titleCandidate: "已避开墓碑的标题", skeleton: sixNodes("贴热点") },
    {
      route: "少数派",
      titleCandidate: "少数派标题",
      skeleton: [
        { text: "推荐选这份", gold_ref: null },
        { text: "n2", gold_ref: null },
        { text: "n3", gold_ref: null },
        { text: "n4", gold_ref: null },
        { text: "n5", gold_ref: null },
        { text: "n6", gold_ref: null },
      ],
    },
    { route: "反共识", titleCandidate: "反共识标题", skeleton: sixNodes("反共识") },
  ];
  const { kept, dropped } = postProcessDrafts(parsed, []);

  assert.equal(kept.length, 1, "宣告两份被 drop，仅反共识存活");
  assert.equal(kept[0].route, "反共识");
  assert.equal(dropped.length, 2);
  assert.ok(dropped.every((item) => item.reason === "宣告扫描命中（成稿不宣告、不给结论）"));
  assert.deepEqual(dropped.map((item) => item.route), ["贴热点", "少数派"]);
});

test("7. gold_ref 编号表外 → 置 null + dropped 计数；编号表内 → 保留", () => {
  const refTable: RefTableItem[] = [{ ref: "§1", id: "gold-1", source: "paperweight", kind: "gold" }];
  const parsed: ParsedDraft[] = [{
    route: "贴热点",
    titleCandidate: "t",
    skeleton: [
      { text: "开场", gold_ref: "§1" },
      { text: "正文", gold_ref: "§99" },
      { text: "n3", gold_ref: null },
      { text: "n4", gold_ref: null },
      { text: "n5", gold_ref: null },
      { text: "n6", gold_ref: null },
    ],
  }];
  const { kept, dropped } = postProcessDrafts(parsed, refTable);

  assert.equal(kept.length, 1, "编号表外不清退整份");
  assert.deepEqual(
    kept[0].skeleton.map((node) => node.gold_ref),
    ["§1", null, null, null, null, null],
    "表内 §1 保留、表外 §99 置 null",
  );
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].reason, /§99/);
});

test("8. refs 落库：kept 草案 gold_ref → pw_verdict_refs（content_draft/草案 id/marker 正确）；重放幂等不重复", async () => {
  const db = makeDb();
  try {
    const { betId } = seedContentBet(db);
    seedGold(db, "gold-1", "开头 30 秒放痛点有效");
    const evidence = buildDraftEvidence(db, betId);
    assert.ok(evidence.refTable.some((item) => item.ref === "§1"), "编号表应含 §1");

    const result = await runPwDraftPipeline(db, betId, { llm: mockDraftLlm(threeRoutePayload("§1")) });

    assert.equal(result.created.length, 3);
    assert.equal(result.refStats.inserted, 3, "每份草案各落一笔 §1 引用");
    const refs = db.prepare("SELECT * FROM pw_verdict_refs").all() as PwVerdictRefRow[];
    assert.equal(refs.length, 3);
    const createdIds = new Set(result.created.map((row) => row.id));
    for (const ref of refs) {
      assert.equal(ref.source_kind, "content_draft");
      assert.ok(createdIds.has(ref.source_id), "source_id 指向草案 id");
      assert.equal(ref.verdict_id, "gold-1");
      assert.equal(ref.verdict_source, "paperweight");
      assert.equal(ref.verdict_kind, "gold");
      assert.equal(ref.marker, "§1");
    }

    // 同 source 重放：唯一索引去重，不重复
    const replay = recordPwVerdictRefs(db, {
      sourceKind: "content_draft",
      sourceId: result.created[0].id,
      text: "§1",
      refTable: evidence.refTable,
    });
    assert.equal(replay.inserted, 0);
    assert.equal(countRows(db, "pw_verdict_refs"), 3, "重放不新增");
  } finally {
    db.close();
  }
});

test("9. LLM 首炸次好 → 重试成功；两炸 → failed 零草案", async () => {
  const db = makeDb();
  try {
    const { betId } = seedContentBet(db);

    // (a) 第一次调用抛错、第二次返回合法 JSON → 重试成功
    let calls = 0;
    const flaky: DraftLlm = async () => {
      calls += 1;
      if (calls === 1) throw new Error("模型炸了");
      return JSON.stringify(threeRoutePayload());
    };
    const ok = await runPwDraftPipeline(db, betId, { llm: flaky });
    assert.equal(calls, 2, "应重试 1 次");
    assert.equal(ok.created.length, 3, "重试后正常三份落库");

    // (b) 两炸 → failed 零草案，失败痕 payload 含模型错误
    const alwaysFail: DraftLlm = async () => {
      throw new Error("模型两炸");
    };
    const failed = await runPwDraftPipeline(db, betId, { llm: alwaysFail });
    assert.equal(failed.created.length, 0, "两炸零草案");
    const event = db.prepare(`
      SELECT * FROM pw_runs WHERE kind = 'ai_draft' AND event_type = 'draft'
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get() as Json;
    const payload = JSON.parse(String(event.payload_json)) as Json;
    assert.ok(String(payload.error).includes("模型两炸"));
    assert.equal(payload.created, 0);
    assert.equal(countRows(db, "pw_content_drafts"), 3, "第一轮 3 份仍在，第二轮零新增");
  } finally {
    db.close();
  }
});

test("10. 重复路子只留一份；缺一路子但另两路存活 → done 两份", async () => {
  const db = makeDb();
  try {
    const { betId } = seedContentBet(db);

    // (a) 重复路子：两份贴热点只留第一份
    const dupPayload = [
      { route: "贴热点", title_candidate: "t1", skeleton: sixNodes("贴热点甲") },
      { route: "贴热点", title_candidate: "t2", skeleton: sixNodes("贴热点乙") },
      { route: "少数派", title_candidate: "t3", skeleton: sixNodes("少数派") },
    ];
    const dup = await runPwDraftPipeline(db, betId, { llm: mockDraftLlm(dupPayload) });
    assert.equal(dup.created.length, 2, "重复路子只留一份");
    assert.deepEqual(dup.created.map((row) => row.route).sort(), ["少数派", "贴热点"]);
    assert.deepEqual(dup.created.map((row) => row.title_candidate).sort(), ["t1", "t3"]);
    assert.equal(dup.dropped.length, 1);
    assert.equal(dup.dropped[0].route, "贴热点");
    assert.match(dup.dropped[0].reason, /重复路子/);

    // (b) 缺一路子但另两路存活 → done 两份
    const missingPayload = [
      { route: "贴热点", title_candidate: "t4", skeleton: sixNodes("贴热点") },
      { route: "反共识", title_candidate: "t5", skeleton: sixNodes("反共识") },
    ];
    const missing = await runPwDraftPipeline(db, betId, { llm: mockDraftLlm(missingPayload) });
    assert.equal(missing.created.length, 2, "缺一路子但两路存活 → done");
    assert.deepEqual(missing.created.map((row) => row.route).sort(), ["反共识", "贴热点"]);
  } finally {
    db.close();
  }
});

test("11. eval 复用：buildDraftEvidence/buildDraftPrompt/parseDraftJson/postProcessDrafts 独立调用不落库（dry-run 路径通畅）", () => {
  const db = makeDb();
  try {
    const { betId } = seedContentBet(db);
    seedRejectedCard(db, "被否引文", "否因");
    seedGold(db, "gold-1", "开头 30 秒放痛点有效");
    const before = {
      drafts: countRows(db, "pw_content_drafts"),
      refs: countRows(db, "pw_verdict_refs"),
      runs: countRows(db, "pw_runs"),
    };

    const evidence = buildDraftEvidence(db, betId);
    const prompt = buildDraftPrompt(evidence);
    assert.ok(prompt.includes("当前押注卡"));
    assert.ok(prompt.includes("否过的候选卡"));
    assert.ok(prompt.includes("被否引文"));
    assert.ok(prompt.includes("§1"));

    const parsed = parseDraftJson(JSON.stringify(threeRoutePayload("§1")));
    assert.equal(parsed.length, 3);
    assert.equal(parsed[0].route, "贴热点");
    assert.equal(parsed[0].skeleton.length, 6);
    assert.equal(parsed[0].skeleton[0].gold_ref, "§1");

    const { kept, dropped } = postProcessDrafts(parsed, evidence.refTable);
    assert.equal(kept.length, 3);
    assert.deepEqual(dropped, []);

    assert.equal(countRows(db, "pw_content_drafts"), before.drafts, "dry-run 不落草案");
    assert.equal(countRows(db, "pw_verdict_refs"), before.refs, "dry-run 不落引用");
    assert.equal(countRows(db, "pw_runs"), before.runs, "dry-run 不留审计痕");
  } finally {
    db.close();
  }
});
