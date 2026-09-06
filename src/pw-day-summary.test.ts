/**
 * TASK-PW-35 收工小结 测试（8 组，内存库自包含）。
 * TASK-PW-40 连带：getPwDaySummary 末尾装配「旧笔记回响」会经 MEMOS_DB_PATH 打开笔记库——
 * 全部用例统一指向不存在的路径，保证确定性、绝不触碰真实 Memos 库（断言语义不变）。
 * 运行：PATH="$HOME/.local/node/bin:$PATH" node --test src/pw-day-summary.test.ts
 */
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { getPwDaySummary, renderPwDaySummaryText, type PwDaySummary } from "./pw-day-summary.ts";
import { ensurePwRunTables, recordPwEvent, type PwEventInput } from "./pw-runs.ts";

/** TASK-PW-40 连带：笔记库路径统一指向不存在的 tmp 路径（每个测试进程独立，先跑后还原）。 */
const ORIGINAL_MEMOS_DB_PATH = process.env.MEMOS_DB_PATH;
test.before(() => {
  process.env.MEMOS_DB_PATH = join(tmpdir(), `pw-day-summary-no-memos-${process.pid}.db`);
});
test.after(() => {
  if (ORIGINAL_MEMOS_DB_PATH === undefined) delete process.env.MEMOS_DB_PATH;
  else process.env.MEMOS_DB_PATH = ORIGINAL_MEMOS_DB_PATH;
});

/** 内存库：pw_runs 走正式建表；联查三表只建本刀用到的列（自包含，不依赖其它模块建表）。 */
function fixture(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwRunTables(db);
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
      settled_verdict_id TEXT,
      kind TEXT NOT NULL DEFAULT 'verdict',
      source_card_id TEXT
    );
    CREATE TABLE pw_sieve_cards (
      id TEXT PRIMARY KEY,
      quote_text TEXT NOT NULL
    );
    CREATE TABLE pw_content_drafts (
      id TEXT PRIMARY KEY,
      route TEXT NOT NULL,
      title_candidate TEXT NOT NULL
    );
  `);
  return db;
}

function addBet(db: DatabaseSync, id: string, title: string): void {
  db.prepare("INSERT INTO pw_bets (id, title, thesis, created_at) VALUES (?, ?, '', ?)")
    .run(id, title, "2026-01-01T00:00:00.000Z");
}

function addCard(db: DatabaseSync, id: string, quote: string): void {
  db.prepare("INSERT INTO pw_sieve_cards (id, quote_text) VALUES (?, ?)").run(id, quote);
}

function addDraft(db: DatabaseSync, id: string, route: string, title: string): void {
  db.prepare("INSERT INTO pw_content_drafts (id, route, title_candidate) VALUES (?, ?, ?)").run(id, route, title);
}

/** 2026-08-08 本地时区的 hh:mm。 */
function at(hour: number, minute: number): Date {
  return new Date(2026, 7, 8, hour, minute);
}

function ev(db: DatabaseSync, when: Date, input: PwEventInput): void {
  recordPwEvent(db, { created_at: when.toISOString(), ...input });
}

/** 直接落一行（绕过 recordPwEvent 的 payload 合法性校验，模拟非法 JSON 行）。 */
function evRaw(
  db: DatabaseSync,
  when: Date,
  id: string,
  kind: string,
  eventType: string,
  actor: string,
  payloadJson: string,
): void {
  db.prepare(`
    INSERT INTO pw_runs(
      id, kind, event_type, actor, payload_json, payload_hash,
      parent_id, related_ids_json, bet_id, created_at, instruction_text, instruction_message_id
    ) VALUES (?, ?, ?, ?, ?, '', NULL, '[]', NULL, ?, NULL, NULL)
  `).run(id, kind, eventType, actor, payloadJson, when.toISOString());
}

function summary(db: DatabaseSync, date = "2026-08-08"): PwDaySummary {
  return getPwDaySummary(db, { date, now: new Date(2026, 7, 8, 20, 0) });
}

function reconcile(s: PwDaySummary): number {
  return s.picks.length + s.betConfirms.length + s.finalizes.length
    + s.cardRejects.length + s.draftRejects.length + s.draftRunBatches
    + s.execActions.length + s.autoActions.length + s.otherCount;
}

test("1 空日零态：全零、各栏目空数组、otherCount=0、totalEvents=0、文本含「没有」", () => {
  const db = fixture();
  const s = summary(db);
  assert.equal(s.date, "2026-08-08");
  assert.equal(s.totalEvents, 0);
  assert.equal(s.otherCount, 0);
  assert.equal(s.draftRunBatches, 0);
  assert.equal(s.draftsCreated, 0);
  assert.deepEqual(s.picks, []);
  assert.deepEqual(s.betConfirms, []);
  assert.deepEqual(s.finalizes, []);
  assert.deepEqual(s.cardRejects, []);
  assert.deepEqual(s.draftRejects, []);
  assert.deepEqual(s.draftRuns, []);
  assert.deepEqual(s.execActions, []);
  assert.deepEqual(s.autoActions, []);
  assert.deepEqual(s.otherDist, []);
  const text = renderPwDaySummaryText(s);
  assert.match(text, /收工小结 2026-08-08/);
  assert.match(text, /没有/);
});

test("2 全口径一天：每档各 1-2 笔 + 对账断言", () => {
  const db = fixture();
  addBet(db, "bet-1", "5年153期：全能型选手");
  addBet(db, "bet-2", "押注一确认就自动起草");
  addCard(db, "card-1", "这也太全能了吧，一个人干了一个团队的活。");
  addCard(db, "card-2", "一个人干了一个团队的活");
  addCard(db, "card-3", "跑题原文");
  addDraft(db, "draft-2", "正文稿", "押注一确认就自动起草的复盘");
  addDraft(db, "draft-3", "口播稿", "某草案");

  // 其余事件：sync + mirror
  ev(db, at(9, 0), { kind: "sync", actor: "system", event_type: "data_doc", payload_json: "{}" });
  ev(db, at(9, 5), { kind: "manual_event", actor: "human", event_type: "mirror", payload_json: JSON.stringify({ inserted: 1 }) });
  // 起草批次：成功 1 批 + 失败 1 批
  ev(db, at(10, 0), { kind: "ai_draft", actor: "ai", event_type: "draft", payload_json: JSON.stringify({ betId: "bet-1", batchId: "b1", routes: ["正文稿"], created: 3, trigger: "指令A" }) });
  ev(db, at(10, 30), { kind: "ai_draft", actor: "ai", event_type: "draft", payload_json: JSON.stringify({ betId: "bet-2", batchId: "b2", created: 0, trigger: "指令B", error: "模型超时" }) });
  // 挑卡：挑改 + 普通
  ev(db, at(14, 2), { event_type: "confirm", actor: "human", payload_json: JSON.stringify({ cardId: "card-1", betId: "bet-1", overrides: { title: "x" } }) });
  ev(db, at(15, 40), { event_type: "confirm", actor: "human", payload_json: JSON.stringify({ cardId: "card-2", betId: "bet-1" }) });
  // 押注转正·工具面：confirm 账 payload {draftId, betId, edits} 且 draftId === betId
  ev(db, at(15, 59), { kind: "ai_exec", actor: "ai", event_type: "confirm", payload_json: JSON.stringify({ draftId: "bet-1", betId: "bet-1", edits: [] }), instruction_text: "把草稿 66b954fa 确认转正", instruction_message_id: "m1" });
  // 押注转正·REST 面：路由层 confirm 账 payload {draftHash} + bet_id 列 = 押注 id
  ev(db, at(16, 5), { event_type: "confirm", actor: "human", payload_json: JSON.stringify({ draftHash: "abc123" }), bet_id: "bet-2" });
  // AI 代办：缺指令行
  ev(db, at(16, 20), { kind: "ai_exec", actor: "ai", event_type: "edit", payload_json: JSON.stringify({ title: "某押注" }) });
  // 定稿：legacy 素材草案账（draftId !== betId、无 artifactId）
  ev(db, at(16, 30), { event_type: "confirm", actor: "human", payload_json: JSON.stringify({ draftId: "draft-2", betId: "bet-2" }) });
  // 否卡 / 否草案
  ev(db, at(17, 0), { event_type: "reject", actor: "human", payload_json: JSON.stringify({ cardId: "card-3", reason: "跑题了" }) });
  ev(db, at(17, 10), { event_type: "reject", actor: "human", payload_json: JSON.stringify({ draftId: "draft-3", reason: "太水" }) });
  // 其余事件：非法 payload_json 行（跳过分类但计 otherCount）
  evRaw(db, at(17, 30), "raw-1", "manual_event", "settle", "human", "not-json{{{");
  // AI 自主
  ev(db, at(18, 0), { kind: "ai_auto", actor: "ai", event_type: "corpus", payload_json: JSON.stringify({ corpusId: "c1" }) });

  const s = summary(db);
  assert.equal(s.totalEvents, 14);
  // 挑卡
  assert.equal(s.picks.length, 2);
  assert.equal(s.picks[0].quote, "这也太全能了吧，一个人干了一个团队的活。");
  assert.equal(s.picks[0].betTitle, "5年153期：全能型选手");
  assert.equal(s.picks[0].edited, true);
  assert.equal(s.picks[0].actor, "human");
  assert.equal(s.picks[1].edited, false);
  // 押注转正：工具面（draftId===betId，标题经 payload.betId）+ REST 面（draftHash，标题经 row.bet_id）
  assert.equal(s.betConfirms.length, 2);
  assert.equal(s.betConfirms[0].betTitle, "5年153期：全能型选手");
  assert.equal(s.betConfirms[0].actor, "ai");
  assert.equal(s.betConfirms[1].betTitle, "押注一确认就自动起草");
  assert.equal(s.betConfirms[1].actor, "human");
  // 定稿：legacy 无 artifactId 的素材草案账
  assert.equal(s.finalizes.length, 1);
  assert.equal(s.finalizes[0].draftRoute, "正文稿");
  assert.equal(s.finalizes[0].draftTitle, "押注一确认就自动起草的复盘");
  assert.equal(s.finalizes[0].betTitle, "押注一确认就自动起草");
  // 否卡 / 否草案
  assert.equal(s.cardRejects.length, 1);
  assert.equal(s.cardRejects[0].quote, "跑题原文");
  assert.equal(s.cardRejects[0].reason, "跑题了");
  assert.equal(s.draftRejects.length, 1);
  assert.equal(s.draftRejects[0].route, "口播稿");
  assert.equal(s.draftRejects[0].title, "某草案");
  assert.equal(s.draftRejects[0].reason, "太水");
  // 起草批次
  assert.equal(s.draftRuns.length, 2);
  assert.equal(s.draftRunBatches, 2);
  assert.equal(s.draftsCreated, 3);
  assert.equal(s.draftRuns[0].trigger, "指令A");
  assert.equal(s.draftRuns[0].created, 3);
  assert.equal(s.draftRuns[0].error, null);
  assert.equal(s.draftRuns[1].error, "模型超时");
  // AI 代办 / AI 自主
  assert.equal(s.execActions.length, 1);
  assert.equal(s.execActions[0].instruction, null, "缺指令行标无引用");
  assert.equal(s.autoActions.length, 1);
  assert.equal(s.autoActions[0].object, "c1");
  // 其余事件
  assert.equal(s.otherCount, 3);
  assert.deepEqual(s.otherDist, [
    { label: "sync", count: 1 },
    { label: "mirror", count: 1 },
    { label: "settle", count: 1 },
  ]);
  // 对账锚点：各栏目计数和 + otherCount = totalEvents
  assert.equal(reconcile(s), s.totalEvents);
  // 文本导出整体可渲染
  const text = renderPwDaySummaryText(s);
  assert.match(text, /挑 2 · 否 2 · 押 2 · 定稿 1 · 起草 2 批（3 份）· AI 代办 1 件 · 自主 1 件/);
  assert.match(text, /另有余系统事件 3 笔（sync×1、mirror×1、settle×1）/);
  assert.match(text, /（AI 代办）/);
});

test("3 窗口边界：startIso 前 1 秒排除、startIso 恰含、endIso 恰排除", () => {
  const db = fixture();
  const start = new Date(2026, 7, 8);
  const startIso = start.toISOString();
  const beforeIso = new Date(start.getTime() - 1000).toISOString();
  const endIso = new Date(2026, 7, 9).toISOString();
  ev(db, new Date(beforeIso), { kind: "sync", actor: "system", event_type: "data_doc", payload_json: "{}" });
  ev(db, new Date(startIso), { kind: "sync", actor: "system", event_type: "data_doc", payload_json: "{}" });
  ev(db, new Date(endIso), { kind: "sync", actor: "system", event_type: "data_doc", payload_json: "{}" });
  const s = summary(db);
  assert.equal(s.startIso, startIso);
  assert.equal(s.endIso, endIso);
  assert.equal(s.totalEvents, 1);
  assert.equal(s.otherCount, 1);
  assert.equal(reconcile(s), s.totalEvents);
});

test("4 双路径去重：REST draftHash+bet_id 归 betConfirms、孤儿 draftHash 落 otherCount、legacy 定稿账归 finalizes", () => {
  const db = fixture();
  addBet(db, "bet-B", "同一押注");
  addDraft(db, "d2", "正文稿", "旧版定稿标题");
  // REST 面：payload {draftHash} + bet_id 列 = 押注 id → betConfirms（标题经 bet_id 联查）
  ev(db, at(10, 0), { event_type: "confirm", actor: "human", payload_json: JSON.stringify({ draftHash: "abc123" }), bet_id: "bet-B" });
  // 工具面：payload {draftId, betId, edits} 且 draftId === betId → betConfirms
  ev(db, at(10, 1), { kind: "ai_exec", actor: "ai", event_type: "confirm", payload_json: JSON.stringify({ draftId: "bet-B", betId: "bet-B", edits: [] }) });
  // legacy 素材草案定稿账：confirm + {draftId, betId} 且 draftId !== betId、无 artifactId → finalizes
  ev(db, at(10, 2), { event_type: "confirm", actor: "human", payload_json: JSON.stringify({ draftId: "d2", betId: "bet-B" }) });
  // 挑卡同 betId → picks
  ev(db, at(10, 3), { event_type: "confirm", actor: "human", payload_json: JSON.stringify({ cardId: "c9", betId: "bet-B" }) });
  // 孤儿路由账：draftHash 但 bet_id 为 NULL → otherCount
  ev(db, at(10, 4), { event_type: "confirm", actor: "human", payload_json: JSON.stringify({ draftHash: "orphan" }) });
  const s = summary(db);
  assert.equal(s.betConfirms.length, 2);
  assert.equal(s.betConfirms[0].betTitle, "同一押注", "REST 面标题经 bet_id 联查");
  assert.equal(s.betConfirms[1].betTitle, "同一押注", "工具面标题经 payload.betId 联查");
  assert.equal(s.finalizes.length, 1);
  assert.equal(s.finalizes[0].draftRoute, "正文稿");
  assert.equal(s.finalizes[0].draftTitle, "旧版定稿标题");
  assert.equal(s.picks.length, 1);
  assert.equal(s.otherCount, 1, "孤儿 draftHash（bet_id NULL）落 otherCount");
  assert.equal(s.totalEvents, 5);
  assert.equal(reconcile(s), s.totalEvents);
});

test("5 exec 清单行：instruction 超 60 截断带…、NULL 标「无引用！」、ai_auto 标「自主」", () => {
  const db = fixture();
  const long = `指令「${"好".repeat(65)}」结束`;
  ev(db, at(9, 0), { kind: "ai_exec", actor: "ai", event_type: "confirm", payload_json: JSON.stringify({ title: "长指令押注" }), instruction_text: long, instruction_message_id: "m1" });
  ev(db, at(9, 1), { kind: "ai_exec", actor: "ai", event_type: "edit", payload_json: JSON.stringify({ betId: "b2" }) });
  ev(db, at(9, 2), { kind: "ai_auto", actor: "ai", event_type: "corpus", payload_json: JSON.stringify({ corpusId: "c1" }) });
  const s = summary(db);
  assert.equal(s.execActions.length, 2);
  assert.equal(s.autoActions.length, 1);
  assert.ok(s.execActions[0].instruction !== null);
  assert.equal(s.execActions[0].instruction.length, 61, "60 字 + 省略号");
  assert.ok(s.execActions[0].instruction.endsWith("…"));
  assert.equal(s.execActions[1].instruction, null);
  assert.equal(s.execActions[1].object, "b2");
  const text = renderPwDaySummaryText(s);
  assert.match(text, /无引用！/);
  assert.match(text, /自主/);
  assert.equal(reconcile(s), s.totalEvents);
});

test("6 文本导出：日期头、计数行、关键条目；空栏目整栏不出现", () => {
  const db = fixture();
  addBet(db, "bet-1", "5年153期：全能型选手");
  addBet(db, "bet-2", "押注一确认就自动起草");
  const longQuote = "这也太全能了吧，一个人干了一个团队的活，还顺手把明天的事也干完了，甚至把下个月的计划都提前安排好了。";
  addCard(db, "card-1", longQuote);
  addCard(db, "card-2", "跑题原文");
  ev(db, at(14, 2), { event_type: "confirm", actor: "human", payload_json: JSON.stringify({ cardId: "card-1", betId: "bet-1", overrides: { title: "挑改标题" } }) });
  ev(db, at(16, 1), { kind: "ai_exec", actor: "ai", event_type: "confirm", payload_json: JSON.stringify({ draftId: "bet-2", betId: "bet-2", edits: [] }) });
  ev(db, at(17, 0), { event_type: "reject", actor: "human", payload_json: JSON.stringify({ cardId: "card-2", reason: "跑题了" }) });
  const s = summary(db);
  const text = renderPwDaySummaryText(s);
  assert.match(text, /收工小结 2026-08-08/);
  assert.match(text, /挑 1 · 否 1 · 押 1 · 定稿 0 · 起草 0 批（0 份）· AI 代办 0 件 · 自主 0 件/);
  assert.match(text, /押注《5年153期：全能型选手》/);
  assert.ok(text.includes(`${longQuote.slice(0, 40)}…`), "引文截断 40 字带省略号");
  assert.match(text, /跑题了/);
  assert.match(text, /（挑改）/);
  assert.match(text, /（AI 代办）/);
  assert.ok(!text.includes("■ 定稿"), "空栏目整栏不出现");
  assert.ok(!text.includes("■ 否草案"));
  assert.ok(!text.includes("■ 起草批次"));
  assert.ok(!text.includes("■ AI 代办"));
  assert.ok(!text.includes("■ AI 自主"));
  assert.ok(!text.includes("另有余系统事件"));
});

test("7 date 非法 → 400；缺省 date 用注入 now 的本地日", () => {
  const db = fixture();
  for (const bad of ["昨天", "2026-13-01", "2026-02-30", "20260808", ""]) {
    assert.throws(() => getPwDaySummary(db, { date: bad }), (error: unknown) => {
      assert.equal((error as { status?: number }).status, 400, `date=${bad}`);
      return true;
    });
  }
  const s = getPwDaySummary(db, { now: new Date(2026, 7, 8, 23, 45) });
  assert.equal(s.date, "2026-08-08");
});

test("8 联查兜底：bet/card/draft 行不存在 → 显示 id 前 8 位不炸", () => {
  const db = fixture();
  ev(db, at(10, 0), { event_type: "confirm", actor: "human", payload_json: JSON.stringify({ cardId: "card-missing-12345", betId: "bet-missing-12345" }) });
  ev(db, at(10, 1), { event_type: "confirm", actor: "human", payload_json: JSON.stringify({ draftId: "draft-missing-88888", betId: "bet-missing-77777", artifactId: "art-1" }) });
  ev(db, at(10, 2), { event_type: "confirm", actor: "human", payload_json: JSON.stringify({ draftId: "bet-missing-22222", betId: "bet-missing-22222", edits: [] }) });
  ev(db, at(10, 3), { event_type: "reject", actor: "human", payload_json: JSON.stringify({ draftId: "draft-missing-66666", reason: "太水" }) });
  const s = summary(db);
  assert.equal(s.picks.length, 1);
  assert.equal(s.picks[0].quote, "card-mis");
  assert.equal(s.picks[0].betTitle, "bet-miss");
  assert.equal(s.finalizes.length, 1);
  assert.equal(s.finalizes[0].draftRoute, "draft-mi");
  assert.equal(s.finalizes[0].draftTitle, "draft-mi");
  assert.equal(s.finalizes[0].betTitle, "bet-miss");
  assert.equal(s.betConfirms.length, 1);
  assert.equal(s.betConfirms[0].betTitle, "bet-miss");
  assert.equal(s.draftRejects.length, 1);
  assert.equal(s.draftRejects[0].route, "draft-mi");
  assert.equal(s.draftRejects[0].title, "draft-mi");
  assert.equal(reconcile(s), s.totalEvents);
  const text = renderPwDaySummaryText(s);
  assert.ok(text.length > 0);
});
