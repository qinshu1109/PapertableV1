/**
 * TASK-PW-22 全局证据对话测试。
 * 覆盖：'global' 哨兵会话（append/list 无需押注行）、全局装配块、
 * betId 参数化工具（read_bet 引导语/指定）、list_content_bets 工具、
 * listContentBets 过滤 void、权限表纪律延续。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { nowIso } from "./data.ts";
import { ensurePwArtifactTables } from "./pw-artifacts.ts";
import { createPwBet, ensurePwBetTables } from "./pw-bets.ts";
import { appendPwCollabMessage, ensurePwCollabTables, listPwCollabMessages } from "./pw-collab.ts";
import { listContentBets } from "./pw-content-bets.ts";
import { ensurePwConnectionTables } from "./pw-connections.ts";
import { ensurePwCorpusTables } from "./pw-corpus.ts";
import { buildCollabContext, PW_COLLAB_GLOBAL_BET_ID } from "./pw-context.ts";
import { ensurePwDataDocTables } from "./pw-data-docs.ts";
import { ensurePwDraftTables } from "./pw-drafts.ts";
import { ensurePwGoldMirrorTables } from "./pw-gold-sync.ts";
import { ensurePwRunTables } from "./pw-runs.ts";
import { ensurePwSieveTables } from "./pw-sieve.ts";
import { ensurePwVerdictTables } from "./pw-verdicts.ts";
import { ensurePwVoiceTables } from "./pw-voice.ts";
import {
  pwCollabDeniedToolNames,
  pwCollabTools,
  type CollabToolContext,
} from "./pw-collab-tools.ts";

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

function seedContentBet(db: DatabaseSync, id: string, status: string, title = "演示困惑X"): void {
  db.prepare(`
    INSERT INTO pw_bets(
      id, title, thesis, metric, metric_target, confidence, data_source_plan,
      checkout_date, status, gold_refs_json, created_from, created_at,
      settled_verdict_id, kind, source_card_id
    ) VALUES(?, ?, '原文：X\n来源：bvid=BV1', '私域加群/问工具人数', '10', NULL,
      '私域群/评论区人工统计', '2026-08-20', ?, '[]', 'collab-pick', ?, NULL, 'content', NULL)
  `).run(id, title, status, nowIso());
}

function seedSievePendingCard(db: DatabaseSync): void {
  db.prepare(`
    INSERT INTO pw_sieve_runs(
      id, trigger_source, input_ids_json, cards_count, dropped_count, status,
      error, model, created_at, finished_at
    ) VALUES('run-g1', 'manual', '[]', 1, 0, 'done', NULL, 'mock', ?, ?)
  `).run(nowIso(), nowIso());
  db.prepare(`
    INSERT INTO pw_sieve_cards(
      id, run_id, kind, quote_text, quote_source_json, scale_note, scale_value,
      hook_note, freshness_note, sort_score, status, created_at
    ) VALUES('card-g1', 'run-g1', 'normal', 'AI 查资料瞎编', '{"bvid":"BV1","uname":"路人"}', NULL, 1, NULL, NULL, 2.5, 'pending', ?)
  `).run(nowIso());
}

function seedCorpusDone(db: DatabaseSync): void {
  db.prepare(`
    INSERT INTO pw_corpus_docs(
      id, bvid, title, up_name, kinds, status, path, sha256, video_stat_json,
      comment_count, authorized_by, error, fetched_at, created_at
    ) VALUES('corpus-g1', 'BV1GLOBAL', '测试视频', '测试UP', 'video,comments', 'done',
      '/tmp/x', 'sha-g1', '{}', 100, 'human', NULL, ?, ?)
  `).run(nowIso(), nowIso());
}

function globalContext(db: DatabaseSync): CollabToolContext {
  return { db, betId: PW_COLLAB_GLOBAL_BET_ID, refs: new Map() };
}

test("'global' 哨兵会话：append/list 不需要 pw_bets 行", () => {
  const db = makeDb();
  const row = appendPwCollabMessage(db, PW_COLLAB_GLOBAL_BET_ID, "user", "全局第一问");
  assert.equal(row.bet_id, "global");
  const rows = listPwCollabMessages(db, PW_COLLAB_GLOBAL_BET_ID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, "全局第一问");
});

test("全局装配：不 404，含在途押注/候选卡/语料清单三块", () => {
  const db = makeDb();
  seedContentBet(db, "bet-g1", "pending");
  seedSievePendingCard(db);
  seedCorpusDone(db);
  const ctx = buildCollabContext(db, PW_COLLAB_GLOBAL_BET_ID);
  assert.match(ctx.markdown, /在途内容押注卡/);
  assert.match(ctx.markdown, /演示困惑X/);
  assert.match(ctx.markdown, /待选候选卡/);
  assert.match(ctx.markdown, /AI 查资料瞎编/);
  assert.match(ctx.markdown, /语料库清单/);
  assert.match(ctx.markdown, /BV1GLOBAL/);
});

test("read_bet：全局未指定回引导语；带 betId 参数返回卡", async () => {
  const db = makeDb();
  const bet = createPwBet(db, {
    title: "真实卡", thesis: "t", metric: "m", metricTarget: null,
    dataSourcePlan: "s", checkoutDate: "2026-09-01", confidence: null, status: "pending",
  });
  const tool = pwCollabTools.find((t) => t.name === "read_bet")!;
  const noArgs = await tool.execute("c1", {}, null as never, () => undefined, globalContext(db));
  assert.match(noArgs.content[0].text, /未指定押注卡/);
  assert.match(noArgs.content[0].text, /list_content_bets/);
  const withId = await tool.execute("c2", { betId: bet.id }, null as never, () => undefined, globalContext(db));
  assert.match(withId.content[0].text, /真实卡/);
});

test("list_content_bets 工具：allow 只读且返回在途卡", async () => {
  const db = makeDb();
  seedContentBet(db, "bet-g1", "pending", "在途卡A");
  const tool = pwCollabTools.find((t) => t.name === "list_content_bets")!;
  assert.equal(tool.policy, "allow");
  const result = await tool.execute("c1", {}, null as never, () => undefined, globalContext(db));
  assert.match(result.content[0].text, /在途卡A/);
  assert.match(result.content[0].text, /bet-g1/);
});

test("listContentBets 过滤 void：作废押注不进列表", () => {
  const db = makeDb();
  seedContentBet(db, "bet-live", "pending", "活着的");
  seedContentBet(db, "bet-dead", "void", "作废的");
  const rows = listContentBets(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "bet-live");
});

test("权限纪律延续：deny 名单不在工具 schema；pick/reject 已进表（PW-25）", () => {
  const names = new Set(pwCollabTools.map((t) => t.name));
  for (const denied of pwCollabDeniedToolNames) {
    assert.ok(!names.has(denied), `${denied} 不应出现在工具表`);
  }
  assert.ok(names.has("pick_sieve_card"), "pick_sieve_card 已进表（PW-25）");
  assert.ok(names.has("reject_sieve_card"), "reject_sieve_card 已进表（PW-25）");
  assert.ok(!names.has("create_content_bet"), "create_content_bet 无独立工具不进表");
});
