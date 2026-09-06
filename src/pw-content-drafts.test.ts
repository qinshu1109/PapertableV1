/**
 * TASK-PW-31：素材草案体系测试。
 * 覆盖：ensure 幂等与结构、批量创建（batchId/字段/404 无孤儿）、skeletonJson 校验、
 * list/count 角标语义、update 改稿留痕（before/after + updated_at 前进）、
 * finalize/reject 状态机单向与 pw_runs 留痕、bad case 集联查、audit 双路、AI 无通路断言。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createPwBet, ensurePwBetTables } from "./pw-bets.ts";
import { ensurePwArtifactTables } from "./pw-artifacts.ts";
import { ensurePwRunTables } from "./pw-runs.ts";
import { pwCollabDeniedToolNames, pwCollabTools } from "./pw-collab-tools.ts";
import {
  countPwContentDraftsByBet,
  createPwContentDrafts,
  ensurePwContentDraftTables,
  finalizePwContentDraft,
  getPwContentDraft,
  listPwContentDraftsByBet,
  listPwDraftBadCases,
  rejectPwContentDraft,
  updatePwContentDraft,
  type NewPwContentDraft,
  type PwContentDraftEditRow,
  type PwContentDraftRow,
} from "./pw-content-drafts.ts";

type RunRow = {
  id: string;
  kind: string;
  event_type: string;
  actor: string;
  payload_json: string;
  bet_id: string | null;
  instruction_text: string | null;
  instruction_message_id: string | null;
};

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwBetTables(db);
  ensurePwArtifactTables(db);
  ensurePwRunTables(db);
  ensurePwContentDraftTables(db);
  return db;
}

/** 造一张在途（pending）内容押注，返回 betId。 */
function seedBet(db: DatabaseSync, title = "在途押注"): string {
  const bet = createPwBet(db, {
    title,
    thesis: "内容押注假设",
    status: "pending",
    metric: "私域加群/问工具人数",
    data_source_plan: "私域群/评论区人工统计",
    checkout_date: "2026-08-15",
  });
  return bet.id;
}

function newDraft(overrides: Partial<NewPwContentDraft> = {}): NewPwContentDraft {
  return {
    route: "贴热点",
    titleCandidate: "标题候选",
    skeletonJson: JSON.stringify([{ text: "开场钩子" }, { text: "正文骨架" }]),
    ...overrides,
  };
}

function assertStatus(error: unknown, status: number): void {
  assert.equal((error as { status?: number }).status, status);
}

function is409(error: unknown): boolean {
  assertStatus(error, 409);
  return true;
}

function is400(error: unknown): boolean {
  assertStatus(error, 400);
  return true;
}

function is404(error: unknown): boolean {
  assertStatus(error, 404);
  return true;
}

test("ensure 幂等：两表结构与索引齐、CHECK 约束在，重复调用结构不变", () => {
  const db = makeDb();
  try {
    ensurePwContentDraftTables(db);
    ensurePwContentDraftTables(db);
    const tables = (db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('pw_content_drafts', 'pw_content_draft_edits')
    `).all() as Array<{ name: string }>).map((row) => row.name).sort();
    assert.deepEqual(tables, ["pw_content_draft_edits", "pw_content_drafts"]);

    const draftColumns = (db.prepare("PRAGMA table_info(pw_content_drafts)").all() as Array<{ name: string }>)
      .map((column) => column.name);
    assert.deepEqual(draftColumns, [
      "id", "bet_id", "batch_id", "route", "title_candidate", "skeleton_json",
      "status", "reject_reason", "created_at", "updated_at",
    ]);
    const editColumns = (db.prepare("PRAGMA table_info(pw_content_draft_edits)").all() as Array<{ name: string }>)
      .map((column) => column.name);
    assert.deepEqual(editColumns, ["id", "draft_id", "before_json", "after_json", "actor", "created_at"]);

    const indexNames = (db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name IN ('pw_content_drafts_by_bet', 'pw_content_draft_edits_by_draft')
    `).all() as Array<{ name: string }>).map((row) => row.name).sort();
    assert.deepEqual(indexNames, ["pw_content_draft_edits_by_draft", "pw_content_drafts_by_bet"]);

    const draftsDdl = (db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pw_content_drafts'
    `).get() as { sql: string }).sql;
    assert.match(draftsDdl, /CHECK\(status IN \('draft','finalized','rejected'\)\)/);
    const editsDdl = (db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pw_content_draft_edits'
    `).get() as { sql: string }).sql;
    assert.match(editsDdl, /CHECK\(actor IN \('human','ai'\)\)/);

    // 幂等：再跑一遍结构不变
    const columnsBefore = (db.prepare("PRAGMA table_info(pw_content_drafts)").all() as Array<{ name: string }>)
      .map((column) => column.name);
    ensurePwContentDraftTables(db);
    const columnsAfter = (db.prepare("PRAGMA table_info(pw_content_drafts)").all() as Array<{ name: string }>)
      .map((column) => column.name);
    assert.deepEqual(columnsAfter, columnsBefore);
  } finally {
    db.close();
  }
});

test("create：三份同 batch_id 字段正确；显式 batchId 生效；bet 不存在 → 404 无孤儿", () => {
  const db = makeDb();
  try {
    const betId = seedBet(db);
    const created = createPwContentDrafts(db, betId, [
      newDraft({ route: "贴热点", titleCandidate: "标题一" }),
      newDraft({ route: "少数派", titleCandidate: "标题二", skeletonJson: JSON.stringify([{ text: "单节点" }]) }),
      newDraft({ route: "反共识", titleCandidate: "标题三" }),
    ]);
    assert.equal(created.length, 3);
    assert.ok(created.every((row) => row.bet_id === betId), "全部挂在押注下");
    assert.equal(new Set(created.map((row) => row.batch_id)).size, 1, "同批共用 batchId");
    assert.ok(created.every((row) => row.status === "draft"), "新建恒为 draft");
    assert.ok(created.every((row) => row.reject_reason === null));
    assert.ok(created.every((row) => row.updated_at === row.created_at));

    // 逐列断言（getPwContentDraft 读回）
    const first = getPwContentDraft(db, created[0].id);
    assert.equal(first.route, "贴热点");
    assert.equal(first.title_candidate, "标题一");
    assert.equal(first.skeleton_json, JSON.stringify([{ text: "开场钩子" }, { text: "正文骨架" }]));
    assert.equal(first.batch_id, created[0].batch_id);

    // 显式 batchId
    const explicit = createPwContentDrafts(db, betId, [newDraft()], { batchId: "batch-x" });
    assert.equal(explicit[0].batch_id, "batch-x");

    // bet 不存在 → 404 且无孤儿行
    assert.throws(() => createPwContentDrafts(db, "no-such-bet", [newDraft()]), is404);
    const orphan = db.prepare("SELECT COUNT(*) AS n FROM pw_content_drafts WHERE bet_id = 'no-such-bet'")
      .get() as { n: number };
    assert.equal(orphan.n, 0, "404 后不得残留孤儿行");

    // getPwContentDraft 不存在 → 404
    assert.throws(() => getPwContentDraft(db, "no-such-draft"), is404);

    // create 留痕（manual_event/human，无 audit 通道）
    const createEvent = db.prepare(`
      SELECT * FROM pw_runs WHERE kind = 'manual_event' AND event_type = 'create' AND bet_id = ?
    `).all(betId) as RunRow[];
    assert.equal(createEvent.length, 2, "两次批量各留一条 create 痕");
    const payload = JSON.parse(createEvent[0].payload_json) as { betId: string; draftIds: string[] };
    assert.equal(payload.betId, betId);
    assert.equal(payload.draftIds.length, 3);
  } finally {
    db.close();
  }
});

test("create 校验：skeletonJson 非法与 route/titleCandidate 空 → 400，边界 1/10 节点合法", () => {
  const db = makeDb();
  try {
    const betId = seedBet(db);
    const badSkeletons: Array<[string, string]> = [
      ["非数组", "{}"],
      ["空数组", "[]"],
      ["节点缺 text", JSON.stringify([{ hook: "无 text" }])],
      ["节点非对象", JSON.stringify(["裸字符串"])],
      ["超 10 节点", JSON.stringify(Array.from({ length: 11 }, (_, i) => ({ text: `n${i}` })))],
    ];
    for (const [label, skeletonJson] of badSkeletons) {
      assert.throws(
        () => createPwContentDrafts(db, betId, [newDraft({ skeletonJson })]),
        is400,
        label,
      );
    }
    assert.throws(() => createPwContentDrafts(db, betId, [newDraft({ route: "  " })]), is400, "route 空");
    assert.throws(() => createPwContentDrafts(db, betId, [newDraft({ titleCandidate: "" })]), is400, "titleCandidate 空");
    assert.throws(() => createPwContentDrafts(db, betId, []), is400, "空批量");
    // 全部校验失败后无任何行落库（事务回滚）
    const total = (db.prepare("SELECT COUNT(*) AS n FROM pw_content_drafts").get() as { n: number }).n;
    assert.equal(total, 0);
    // 边界合法：1 节点（带额外字段）与 10 节点都过
    createPwContentDrafts(db, betId, [newDraft({ skeletonJson: JSON.stringify([{ text: "x", extra: 1 }]) })]);
    createPwContentDrafts(db, betId, [
      newDraft({ skeletonJson: JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ text: `n${i}` }))) }),
    ]);
    const after = (db.prepare("SELECT COUNT(*) AS n FROM pw_content_drafts").get() as { n: number }).n;
    assert.equal(after, 2);
  } finally {
    db.close();
  }
});

test("list/count：角标语义（draft 态计数）与 status 过滤", () => {
  const db = makeDb();
  try {
    const betId = seedBet(db);
    const [a, b, c] = createPwContentDrafts(db, betId, [
      newDraft({ route: "贴热点", titleCandidate: "A 标题" }),
      newDraft({ route: "少数派", titleCandidate: "B 标题" }),
      newDraft({ route: "反共识", titleCandidate: "C 标题" }),
    ]);
    finalizePwContentDraft(db, a.id);
    rejectPwContentDraft(db, b.id, "跑题");

    assert.deepEqual(countPwContentDraftsByBet(db, betId), { total: 3, draft: 1, finalized: 1, rejected: 1 });
    assert.deepEqual(countPwContentDraftsByBet(db, "no-such-bet"), { total: 0, draft: 0, finalized: 0, rejected: 0 });

    const all = listPwContentDraftsByBet(db, betId);
    assert.equal(all.length, 3);
    // created_at、route 升序：逐对断言（created_at 同毫秒时由 route 决定次序）
    for (let i = 1; i < all.length; i++) {
      const prev = all[i - 1]!;
      const curr = all[i]!;
      const prevKey = prev.created_at + "\u0000" + prev.route;
      const currKey = curr.created_at + "\u0000" + curr.route;
      assert.ok(prevKey <= currKey, "created_at、route 应升序");
    }
    assert.deepEqual(
      listPwContentDraftsByBet(db, betId, { status: "draft" }).map((row) => row.id),
      [c.id],
    );
    assert.deepEqual(
      listPwContentDraftsByBet(db, betId, { status: "finalized" }).map((row) => row.id),
      [a.id],
    );
    assert.deepEqual(
      listPwContentDraftsByBet(db, betId, { status: "rejected" }).map((row) => row.id),
      [b.id],
    );
    assert.deepEqual(listPwContentDraftsByBet(db, "no-such-bet"), []);
  } finally {
    db.close();
  }
});

test("update：edits 行 before/after 全文正确 + updated_at 前进；非 draft → 409", () => {
  const db = makeDb();
  try {
    const betId = seedBet(db);
    const [draft] = createPwContentDrafts(db, betId, [newDraft({
      route: "贴热点",
      titleCandidate: "原标题",
      skeletonJson: JSON.stringify([{ text: "骨架一" }]),
    })]);
    const updated = updatePwContentDraft(db, draft.id, {
      titleCandidate: "新标题",
      skeletonJson: JSON.stringify([{ text: "骨架二" }, { text: "骨架三" }]),
    });
    assert.equal(updated.title_candidate, "新标题");
    assert.equal(updated.skeleton_json, JSON.stringify([{ text: "骨架二" }, { text: "骨架三" }]));
    assert.ok(updated.updated_at > draft.created_at, "updated_at 应前进");

    const edits = db.prepare("SELECT * FROM pw_content_draft_edits WHERE draft_id = ?")
      .all(draft.id) as PwContentDraftEditRow[];
    assert.equal(edits.length, 1);
    assert.equal(edits[0].actor, "human", "无 audit 改稿 actor=human");
    assert.deepEqual(JSON.parse(edits[0].before_json), {
      titleCandidate: "原标题",
      skeletonJson: JSON.stringify([{ text: "骨架一" }]),
    });
    assert.deepEqual(JSON.parse(edits[0].after_json), {
      titleCandidate: "新标题",
      skeletonJson: JSON.stringify([{ text: "骨架二" }, { text: "骨架三" }]),
    });

    // 改坏 skeleton → 400 且不留 edit 行（事务回滚）
    assert.throws(
      () => updatePwContentDraft(db, draft.id, { skeletonJson: "[]" }),
      is400,
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM pw_content_draft_edits WHERE draft_id = ?").get(draft.id) as { n: number }).n,
      1,
      "失败的改稿不得留痕",
    );

    // 定稿后不可再改 → 409；不存在 → 404
    finalizePwContentDraft(db, draft.id);
    assert.throws(() => updatePwContentDraft(db, draft.id, { titleCandidate: "再改" }), is409);
    assert.throws(() => updatePwContentDraft(db, "no-such-draft", { titleCandidate: "x" }), is404);
  } finally {
    db.close();
  }
});

test("finalize：draft→finalized + pw_runs confirm 痕（payload 含 draftId/betId）；重复 finalize → 409", () => {
  const db = makeDb();
  try {
    const betId = seedBet(db);
    const [draft] = createPwContentDrafts(db, betId, [newDraft({ titleCandidate: "定稿标题" })]);
    const finalized = finalizePwContentDraft(db, draft.id);
    assert.equal(finalized.status, "finalized");
    assert.ok(finalized.updated_at >= finalized.created_at);

    const event = db.prepare(`
      SELECT * FROM pw_runs WHERE kind = 'manual_event' AND event_type = 'confirm'
    `).get() as RunRow;
    assert.ok(event, "应有 confirm 留痕");
    const payload = JSON.parse(event.payload_json) as { draftId: string; betId: string };
    assert.equal(payload.draftId, draft.id);
    assert.equal(payload.betId, betId);
    assert.equal(event.bet_id, betId, "留痕应挂到押注 timeline");

    assert.throws(() => finalizePwContentDraft(db, draft.id), is409);
    assert.throws(() => finalizePwContentDraft(db, "no-such-draft"), is404);
  } finally {
    db.close();
  }
});

test("reject + reason：bad case 集联查 bet title 查得出；无 reason → null 也可", () => {
  const db = makeDb();
  try {
    const betId = seedBet(db, "在途押注-标题");
    const [r1] = createPwContentDrafts(db, betId, [newDraft({ titleCandidate: "被否" })]);
    const [r2] = createPwContentDrafts(db, betId, [newDraft({ titleCandidate: "无理由" })]);
    const rejected = rejectPwContentDraft(db, r1.id, "跑题了");
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.reject_reason, "跑题了");
    rejectPwContentDraft(db, r2.id);
    const noReasonRow = db.prepare("SELECT reject_reason FROM pw_content_drafts WHERE id = ?")
      .get(r2.id) as { reject_reason: string | null };
    assert.equal(noReasonRow.reject_reason, null);

    // bad case 集：rejected 全部 + 联查押注标题
    const bad = listPwDraftBadCases(db);
    assert.equal(bad.length, 2);
    assert.ok(bad.every((row) => row.bet_title === "在途押注-标题"));
    const byId = new Map(bad.map((row) => [row.id, row]));
    assert.equal(byId.get(r1.id)?.reject_reason, "跑题了");
    assert.equal(byId.get(r2.id)?.reject_reason, null);
    assert.ok(bad.every((row) => row.status === "rejected"));

    // finalized 不进 bad case；另一押注的 rejected 也进集
    const [r3] = createPwContentDrafts(db, betId, [newDraft({ titleCandidate: "定稿" })]);
    finalizePwContentDraft(db, r3.id);
    const bet2 = seedBet(db, "另一押注");
    const [r4] = createPwContentDrafts(db, bet2, [newDraft({ titleCandidate: "重复" })]);
    rejectPwContentDraft(db, r4.id, "重复选题");
    const all = listPwDraftBadCases(db);
    assert.equal(all.length, 3);
    const byIdAll = new Map(all.map((row) => [row.id, row]));
    assert.equal(byIdAll.get(r3.id), undefined, "finalized 不得进 bad case");
    assert.equal(byIdAll.get(r4.id)?.bet_title, "另一押注");
    // created_at 升序
    for (let i = 1; i < all.length; i++) {
      assert.ok(all[i - 1]!.created_at <= all[i]!.created_at, "bad case 应按 created_at 升序");
    }
  } finally {
    db.close();
  }
});

test("状态机单向：finalized 不可 reject/update；rejected 不可 update/finalize（各 409）", () => {
  const db = makeDb();
  try {
    const betId = seedBet(db);
    const [f] = createPwContentDrafts(db, betId, [newDraft({ titleCandidate: "定稿" })]);
    finalizePwContentDraft(db, f.id);
    assert.throws(() => updatePwContentDraft(db, f.id, { titleCandidate: "改" }), is409);
    assert.throws(() => rejectPwContentDraft(db, f.id, "x"), is409);

    const [r] = createPwContentDrafts(db, betId, [newDraft({ titleCandidate: "否掉" })]);
    rejectPwContentDraft(db, r.id);
    assert.throws(() => updatePwContentDraft(db, r.id, { titleCandidate: "改" }), is409);
    assert.throws(() => finalizePwContentDraft(db, r.id), is409);
  } finally {
    db.close();
  }
});

test("audit 双路：传 audit → ai_exec 账（instruction 两列齐）；不传 → manual_event/human", () => {
  const db = makeDb();
  try {
    const betId = seedBet(db);
    const audit = { actor: "ai" as const, instructionText: "按我说的改一稿", instructionMessageId: "msg-1" };
    const [d1] = createPwContentDrafts(db, betId, [newDraft({ titleCandidate: "A" })]);
    const [d2] = createPwContentDrafts(db, betId, [newDraft({ titleCandidate: "B" })]);

    // 传 audit：update → ai_exec/edit，instruction 两列齐
    updatePwContentDraft(db, d1.id, { titleCandidate: "A2" }, audit);
    const editRow = db.prepare(`
      SELECT * FROM pw_runs WHERE kind = 'ai_exec' AND event_type = 'edit'
    `).get() as RunRow;
    assert.ok(editRow, "应有 ai_exec/edit 账");
    assert.equal(editRow.actor, "ai");
    assert.equal(editRow.instruction_text, "按我说的改一稿");
    assert.equal(editRow.instruction_message_id, "msg-1");
    assert.equal(editRow.bet_id, betId);
    const editPayload = JSON.parse(editRow.payload_json) as { draftId: string; changedFields: string[] };
    assert.equal(editPayload.draftId, d1.id);
    assert.deepEqual(editPayload.changedFields, ["titleCandidate"]);

    // 传 audit：finalize → ai_exec/confirm；reject → ai_exec/reject
    finalizePwContentDraft(db, d2.id, audit);
    const confirmRow = db.prepare(`
      SELECT * FROM pw_runs WHERE kind = 'ai_exec' AND event_type = 'confirm'
    `).get() as RunRow;
    assert.ok(confirmRow, "应有 ai_exec/confirm 账");
    assert.equal(confirmRow.instruction_message_id, "msg-1");
    const [d3] = createPwContentDrafts(db, betId, [newDraft({ titleCandidate: "C" })]);
    rejectPwContentDraft(db, d3.id, "方向不对", audit);
    const rejectRow = db.prepare(`
      SELECT * FROM pw_runs WHERE kind = 'ai_exec' AND event_type = 'reject'
    `).get() as RunRow;
    assert.ok(rejectRow, "应有 ai_exec/reject 账");

    // 不传 audit：manual_event/human，instruction 两列恒 NULL
    const [d4] = createPwContentDrafts(db, betId, [newDraft({ titleCandidate: "D" })]);
    updatePwContentDraft(db, d4.id, { titleCandidate: "D2" });
    const manualRow = db.prepare(`
      SELECT * FROM pw_runs WHERE kind = 'manual_event' AND event_type = 'edit'
    `).get() as RunRow;
    assert.ok(manualRow, "应有 manual_event/edit 账");
    assert.equal(manualRow.actor, "human");
    assert.equal(manualRow.instruction_text, null);
    assert.equal(manualRow.instruction_message_id, null);
  } finally {
    db.close();
  }
});

test("TASK-PW-31：AI 无通路——pw-collab-tools.ts 不含素材草案工具名", () => {
  const names = new Set(pwCollabTools.map((tool) => tool.name));
  const deny = new Set(pwCollabDeniedToolNames);
  for (const name of names) {
    assert.equal(name.includes("content_draft"), false, `工具表不允许出现素材草案工具 ${name}`);
  }
  for (const name of [
    "create_content_drafts",
    "update_content_draft",
    "finalize_content_draft",
    "reject_content_draft",
    "list_content_drafts",
    "list_draft_bad_cases",
  ]) {
    assert.equal(names.has(name), false, `工具表不允许出现 ${name}`);
    assert.equal(deny.has(name), false, `${name} 不应在 deny 名单`);
  }
});
