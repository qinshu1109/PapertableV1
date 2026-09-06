/**
 * TASK-PW-19：内容押注卡（挑/改/否）测试。
 * 覆盖：pw_bets kind/source_card_id 迁移（旧行 verdict）、pick 默认三行与留痕、
 * pick 改写（卡 edited）、reject + 状态机 409、draft 管线 kind='verdict' 回归、
 * TASK-PW-25 后 pick/reject 已进 collab 工具表（人发话才执行，create_content_bet 仍无独立工具）。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { nowIso } from "./data.ts";
import { createPwBet, ensurePwBetTables } from "./pw-bets.ts";
import { createPwBetDraft, ensurePwDraftTables } from "./pw-drafts.ts";
import { ensurePwRunTables } from "./pw-runs.ts";
import { ensurePwSieveTables } from "./pw-sieve.ts";
import { pwCollabDeniedToolNames, pwCollabTools } from "./pw-collab-tools.ts";
import {
  listContentBets,
  pickPwSieveCard,
  rejectPwSieveCard,
} from "./pw-content-bets.ts";

type SieveCardSeed = {
  quote_text?: string;
  quote_source_json?: string;
  status?: "pending" | "picked" | "edited" | "rejected";
};

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwBetTables(db);
  ensurePwSieveTables(db);
  ensurePwRunTables(db);
  ensurePwDraftTables(db);
  return db;
}

/** 造一张筛子候选卡（挂在一个 done run 下），返回卡 id。 */
function seedCard(db: DatabaseSync, seed: SieveCardSeed = {}): string {
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
    seed.quote_source_json ?? JSON.stringify({ bvid: "BV1NprhBPEtR", uname: "路人甲", like: 42 }),
    seed.status ?? "pending",
    nowIso(),
  );
  return cardId;
}

function cardStatus(db: DatabaseSync, cardId: string): string {
  return (db.prepare("SELECT status FROM pw_sieve_cards WHERE id = ?").get(cardId) as { status: string })
    .status;
}

function assertStatus(error: unknown, status: number): void {
  assert.equal((error as { status?: number }).status, status);
}

test("迁移：无 kind 列旧库升级后旧行 kind='verdict'，新列存在且幂等", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE pw_bets (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        thesis TEXT NOT NULL,
        metric TEXT,
        metric_target TEXT,
        confidence INTEGER,
        data_source_plan TEXT,
        checkout_date TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        gold_refs_json TEXT NOT NULL DEFAULT '[]',
        created_from TEXT,
        created_at TEXT NOT NULL,
        settled_verdict_id TEXT
      );
    `);
    db.prepare(`
      INSERT INTO pw_bets(id, title, thesis, status, created_at)
      VALUES('bet-old', '旧押注', '旧假设', 'pending', ?)
    `).run(nowIso());

    ensurePwBetTables(db);
    const columns = (db.prepare("PRAGMA table_info(pw_bets)").all() as Array<{ name: string }>)
      .map(({ name }) => name);
    assert.ok(columns.includes("kind"));
    assert.ok(columns.includes("source_card_id"));
    const row = db.prepare("SELECT kind, source_card_id FROM pw_bets WHERE id = 'bet-old'").get() as
      | { kind: string; source_card_id: string | null };
    assert.equal(row.kind, "verdict");
    assert.equal(row.source_card_id, null);

    // 再跑一次（新建库路径）幂等：列结构不再变化
    ensurePwBetTables(db);
    assert.deepEqual(
      (db.prepare("PRAGMA table_info(pw_bets)").all() as Array<{ name: string }>)
        .map(({ name }) => name),
      columns,
    );
  } finally {
    db.close();
  }
});

test("pick 无 overrides：卡 picked、content 押注默认三行、留痕与联查", () => {
  const db = makeDb();
  try {
    const quote = "私域课定价这么贵居然还有人买，这东西真有这么值吗？还是说大部分人都被割了韭菜";
    const cardId = seedCard(db, {
      quote_text: quote,
      quote_source_json: JSON.stringify({ bvid: "BV1NprhBPEtR", uname: "路人甲", like: 42 }),
    });
    const bet = pickPwSieveCard(db, cardId);

    assert.equal(bet.kind, "content");
    assert.equal(bet.source_card_id, cardId);
    assert.equal(bet.status, "pending");
    assert.equal(bet.title.length, 30, "title 应截断到 ≤30 字");
    assert.equal(bet.title, quote.slice(0, 30));
    assert.ok(bet.thesis.includes(quote), "thesis 应含引文原文");
    assert.ok(bet.thesis.includes("BV1NprhBPEtR"), "thesis 应含 bvid 来源");
    assert.ok(bet.thesis.includes("路人甲"), "thesis 应含 uname 来源");
    assert.equal(bet.metric, "私域加群/问工具人数");
    assert.equal(bet.metric_target, "10");
    assert.equal(bet.data_source_plan, "私域群/评论区人工统计");
    assert.match(bet.checkout_date ?? "", /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(
      bet.checkout_date,
      new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
      "默认 checkout_date 应为 +7 天",
    );

    assert.equal(cardStatus(db, cardId), "picked");

    const event = db.prepare(`
      SELECT * FROM pw_runs WHERE kind = 'manual_event' AND event_type = 'confirm'
    `).get() as { payload_json: string; bet_id: string };
    assert.ok(event, "应有 confirm 留痕");
    const payload = JSON.parse(event.payload_json) as { cardId: string; betId: string };
    assert.equal(payload.cardId, cardId);
    assert.equal(payload.betId, bet.id);
    assert.equal(event.bet_id, bet.id, "留痕应挂到押注 timeline");

    const listed = listContentBets(db);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, bet.id);
    assert.equal(listed[0].quote_text, quote, "联查应带回候选卡原文");
  } finally {
    db.close();
  }
});

test("pick 有 overrides：卡 edited、覆盖字段生效、留痕含 overrides", () => {
  const db = makeDb();
  try {
    const cardId = seedCard(db, { quote_text: "短引文" });
    const overrides = {
      title: "手搓选题标题",
      conversionSignal: "评论区问工具人数",
      metricTarget: "50",
      reviewDate: "2026-08-20",
    };
    const bet = pickPwSieveCard(db, cardId, overrides);

    assert.equal(bet.title, "手搓选题标题");
    assert.equal(bet.metric, "评论区问工具人数");
    assert.equal(bet.metric_target, "50");
    assert.equal(bet.checkout_date, "2026-08-20");
    assert.equal(cardStatus(db, cardId), "edited");

    const event = db.prepare(`
      SELECT * FROM pw_runs WHERE kind = 'manual_event' AND event_type = 'confirm'
    `).get() as { payload_json: string };
    const payload = JSON.parse(event.payload_json) as { overrides: Record<string, string> };
    assert.deepEqual(payload.overrides, overrides);
  } finally {
    db.close();
  }
});

test("reject：pending→rejected + 留痕；非 pending 卡 pick/reject→409", () => {
  const db = makeDb();
  try {
    const cardId = seedCard(db, { quote_text: "要否掉的引文" });
    rejectPwSieveCard(db, cardId, "方向不对");
    assert.equal(cardStatus(db, cardId), "rejected");
    const event = db.prepare(`
      SELECT * FROM pw_runs WHERE kind = 'manual_event' AND event_type = 'reject'
    `).get() as { payload_json: string };
    const payload = JSON.parse(event.payload_json) as { cardId: string; reason: string };
    assert.equal(payload.cardId, cardId);
    assert.equal(payload.reason, "方向不对");

    // 已 rejected：pick/reject 都 409（状态机单向）
    assert.throws(() => pickPwSieveCard(db, cardId), (error) => {
      assertStatus(error, 409);
      return true;
    });
    assert.throws(() => rejectPwSieveCard(db, cardId), (error) => {
      assertStatus(error, 409);
      return true;
    });

    // 不存在的卡 → 409
    assert.throws(() => pickPwSieveCard(db, "no-such-card"), (error) => {
      assertStatus(error, 409);
      return true;
    });
    assert.throws(() => rejectPwSieveCard(db, "no-such-card"), (error) => {
      assertStatus(error, 409);
      return true;
    });

    // 已 picked 的卡 → pick/reject 都 409
    const pickedId = seedCard(db, { status: "picked" });
    assert.throws(() => pickPwSieveCard(db, pickedId), (error) => {
      assertStatus(error, 409);
      return true;
    });
    assert.throws(() => rejectPwSieveCard(db, pickedId), (error) => {
      assertStatus(error, 409);
      return true;
    });

    // reject 无 reason 也允许，payload.reason 为 null
    const noReasonId = seedCard(db, { quote_text: "无理由否掉" });
    rejectPwSieveCard(db, noReasonId);
    const rejectRows = db.prepare(`
      SELECT payload_json FROM pw_runs WHERE kind = 'manual_event' AND event_type = 'reject'
    `).all() as Array<{ payload_json: string }>;
    const noReasonPayload = rejectRows
      .map((row) => JSON.parse(row.payload_json) as { cardId: string; reason: string | null })
      .find((item) => item.cardId === noReasonId);
    assert.deepEqual(noReasonPayload, { cardId: noReasonId, reason: null });
  } finally {
    db.close();
  }
});

test("draft 管线回归：createPwBetDraft / createPwBet 产物 kind='verdict'", () => {
  const db = makeDb();
  try {
    const draft = createPwBetDraft(db, { title: "切片选题", thesis: "真实过程更让人追更" }, "manual");
    assert.equal(draft.status, "draft");
    const draftRow = db.prepare("SELECT kind, source_card_id FROM pw_bets WHERE id = ?")
      .get(draft.id) as { kind: string; source_card_id: string | null };
    assert.equal(draftRow.kind, "verdict");
    assert.equal(draftRow.source_card_id, null);

    const pending = createPwBet(db, {
      title: "待确认押注",
      thesis: "假设",
      status: "pending",
      metric: "播放量",
      data_source_plan: "B站后台",
      checkout_date: "2026-08-10",
    });
    const pendingRow = db.prepare("SELECT kind FROM pw_bets WHERE id = ?").get(pending.id) as { kind: string };
    assert.equal(pendingRow.kind, "verdict");
  } finally {
    db.close();
  }
});

test("TASK-PW-25：pick/reject 进表（人发话才执行）；create_content_bet 无独立工具且已移出 deny", () => {
  const names = new Set(pwCollabTools.map((tool) => tool.name));
  const deny = new Set(pwCollabDeniedToolNames);
  // PW-25：挑/否进工具表（不再 deny）
  for (const name of ["pick_sieve_card", "reject_sieve_card"]) {
    assert.equal(names.has(name), true, `工具表应含 ${name}`);
    assert.equal(deny.has(name), false, `${name} 已移出 deny`);
  }
  // create_content_bet 无独立工具（挑卡带 overrides 即改挑）：不进表、不在 deny
  assert.equal(names.has("create_content_bet"), false, "工具表不允许出现 create_content_bet");
  assert.equal(deny.has("create_content_bet"), false, "create_content_bet 已移出 deny");
});
