/**
 * TASK-PW-25：铸币级执行工具与冲正键测试。
 * 覆盖规格第五节 7 组：
 * 1. 6 个新 exec 工具逐个：业务行正确 + pw_runs 恰一条 ai_exec（event_type/指令两列/payload 关键字段对）；
 *    缺 instruction 抛错（每工具一次）；
 * 2. settle_bet 状态机：无草案 404 / 非 pending 409 / wait 400 / gold 缺 lesson 400 /
 *    未到结账日错误透传 / 成功后草案 approved + 押注 settled + 判决行正确 + evidenceDocIds 进判决；
 * 3. unpick 状态机：非 content 409 / 非 pending 409 / 候选卡非 picked/edited 409 /
 *    成功路径（押注 void、卡回 pending、undo 账）+ 唯一索引不破（撤销后可对同卡再 pick）；
 * 4. void_settlement：非 settled 409 / 成功路径（判决 outcome=void 且原文保留、押注 void）+
 *    可重结断言（重结后新判决非 void、押注 settled）；
 * 5. reject_all_and_resieve：3 张 pending 全拒 + flushNow 被调 + 两条 ai_exec（reject+sieve_run
 *    同指令引用）；0 张 pending 时不报错、只落 sieve_run 账；
 * 6. deny 名单新集逐字断言 + 工具表 35 计数 + 提示词新旧措辞断言（新三条包含、旧两句不存在）；
 * 7. 缺省路径（无 audit）维持 PW-19 行为；audit 路径单条 ai_exec 无双账。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { nowIso } from "./data.ts";
import { createPwBet, ensurePwBetTables, getPwBet, type PwBetRow } from "./pw-bets.ts";
import { ensurePwDataDocTables, createPwDataDoc } from "./pw-data-docs.ts";
import { ensurePwVerdictTables, settlePwBet, voidPwSettlement, type PwVerdictRow } from "./pw-verdicts.ts";
import { ensurePwRunTables } from "./pw-runs.ts";
import {
  ensurePwCollabTables,
  createPwSettleDraft,
  getPwSettleDraft,
  approvePwSettleDraft,
  COLLAB_SYSTEM_PROMPT,
  COLLAB_GLOBAL_PROMPT_NOTE,
} from "./pw-collab.ts";
import { ensurePwSieveTables } from "./pw-sieve.ts";
import {
  pwCollabTools,
  pwCollabDeniedToolNames,
  type CollabTool,
  type CollabToolContext,
} from "./pw-collab-tools.ts";
import {
  pickPwSieveCard,
  rejectPwSieveCard,
  rejectAllPendingPwSieveCards,
  unpickPwContentBet,
} from "./pw-content-bets.ts";

type Json = Record<string, unknown>;

const AUDIT = { actor: "ai" as const, instructionText: "撤销", instructionMessageId: "msg-u" };

function newDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwBetTables(db);
  ensurePwDataDocTables(db);
  ensurePwVerdictTables(db);
  ensurePwRunTables(db);
  ensurePwCollabTables(db);
  ensurePwSieveTables(db);
  return db;
}

function makeBet(db: DatabaseSync, overrides: Json = {}): string {
  const bet = createPwBet(db, {
    title: "直播做产品实践",
    thesis: "直播系列能成",
    metric: "三期平均播放 ≥ 5000",
    metricTarget: ">= 5000",
    dataSourcePlan: "B站",
    checkoutDate: "2020-01-01",
    confidence: 70,
    status: "pending",
    ...overrides,
  });
  return bet.id;
}

type SieveCardSeed = {
  quote_text?: string;
  status?: "pending" | "picked" | "edited" | "rejected";
};

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
    JSON.stringify({ bvid: "BV1NprhBPEtR", uname: "路人甲", like: 42 }),
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

// ---------------------------------------------------------------------------
// 第 1 组：6 个新 exec 工具逐个（业务行正确 + 恰一条 ai_exec）+ 缺 instruction 抛错
// ---------------------------------------------------------------------------

test("第1组：6 个新 exec 工具逐个——业务行正确 + 恰一条 ai_exec（event_type/指令/payload 对）", async () => {
  // (1) settle_bet：草案一步结掉
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      const doc1 = createPwDataDoc(db, { betId, platform: "bilibili", metricsJson: "{}" }).id;
      const doc2 = createPwDataDoc(db, { betId, platform: "bilibili", metricsJson: "{}" }).id;
      const draft = createPwSettleDraft(db, betId, {
        recommendation: "settle_gold",
        lesson: "开头 30 秒放痛点有效",
      });
      await runTool("settle_bet", { draftId: draft.id, evidenceDocIds: [doc1, doc2] }, execContext(db, betId, {
        instruction: { text: "确认结账", messageId: "msg-settle" },
      }));
      assert.equal(getPwBet(db, betId)!.status, "settled");
      assert.equal(getPwSettleDraft(db, draft.id).status, "approved");
      const verdict = db.prepare("SELECT * FROM pw_verdicts WHERE bet_id = ?").get(betId) as PwVerdictRow;
      assert.equal(verdict.outcome, "gold");
      assert.equal(verdict.lesson, "开头 30 秒放痛点有效");
      assert.deepEqual(JSON.parse(verdict.evidence_doc_ids_json), [doc1, doc2], "evidenceDocIds 进判决");
      assert.equal(getPwBet(db, betId)!.settled_verdict_id, verdict.id);
      assert.equal(countRuns(db, "kind = 'ai_exec'"), 1);
      const exec = latestExec(db);
      assert.equal(exec.event_type, "settle");
      assert.equal(exec.instruction_text, "确认结账");
      assert.equal(exec.instruction_message_id, "msg-settle");
      assert.equal(exec.bet_id, betId);
      const payload = JSON.parse(exec.payload_json) as Json;
      assert.equal(payload.draftId, draft.id);
      assert.equal(payload.betId, betId);
      assert.equal(payload.verdictId, verdict.id);
      assert.equal(payload.outcome, "gold");
    } finally {
      db.close();
    }
  }
  // (2) pick_sieve_card：挑卡 + confirm 账
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      const cardId = seedCard(db, { quote_text: "直播做产品实践这个实验设计得真巧妙" });
      await runTool("pick_sieve_card", { cardId }, execContext(db, betId, {
        instruction: { text: "就这张，挑了", messageId: "msg-pick" },
      }));
      assert.equal(cardStatus(db, cardId), "picked");
      const bet = db.prepare("SELECT * FROM pw_bets WHERE kind = 'content'").get() as PwBetRow;
      assert.equal(bet.status, "pending");
      assert.equal(bet.source_card_id, cardId);
      assert.equal(countRuns(db, "kind = 'ai_exec'"), 1);
      const exec = latestExec(db);
      assert.equal(exec.event_type, "confirm");
      assert.equal(exec.instruction_text, "就这张，挑了");
      assert.equal(exec.instruction_message_id, "msg-pick");
      assert.equal(exec.bet_id, bet.id);
      const payload = JSON.parse(exec.payload_json) as Json;
      assert.equal(payload.cardId, cardId);
      assert.equal(payload.betId, bet.id);
      assert.deepEqual(payload.overrides, {});
    } finally {
      db.close();
    }
  }
  // (3) reject_sieve_card：否卡 + reject 账
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      const cardId = seedCard(db);
      await runTool("reject_sieve_card", { cardId, reason: "方向不对" }, execContext(db, betId, {
        instruction: { text: "这张否掉", messageId: "msg-reject" },
      }));
      assert.equal(cardStatus(db, cardId), "rejected");
      assert.equal(countRuns(db, "kind = 'ai_exec'"), 1);
      const exec = latestExec(db);
      assert.equal(exec.event_type, "reject");
      assert.equal(exec.instruction_text, "这张否掉");
      assert.equal(exec.instruction_message_id, "msg-reject");
      const payload = JSON.parse(exec.payload_json) as Json;
      assert.equal(payload.cardId, cardId);
      assert.equal(payload.reason, "方向不对");
    } finally {
      db.close();
    }
  }
  // (4) reject_all_and_resieve：全否 + 重筛，两条 ai_exec 同指令
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      const ids = [
        seedCard(db, { quote_text: "卡一" }),
        seedCard(db, { quote_text: "卡二" }),
        seedCard(db, { quote_text: "卡三" }),
      ];
      const { notifier, flushCount } = mockNotifier("run-x");
      await runTool("reject_all_and_resieve", { reason: "全否重筛" }, execContext(db, betId, {
        instruction: { text: "全部否掉重筛", messageId: "msg-reall" },
        sieve: notifier,
      }));
      for (const id of ids) assert.equal(cardStatus(db, id), "rejected");
      assert.equal(flushCount(), 1);
      assert.equal(countRuns(db, "kind = 'ai_exec'"), 2);
      const rows = allExec(db);
      assert.deepEqual(rows.map((row) => row.event_type), ["reject", "sieve_run"]);
      for (const row of rows) {
        assert.equal(row.instruction_text, "全部否掉重筛");
        assert.equal(row.instruction_message_id, "msg-reall");
      }
      const rejectPayload = JSON.parse(rows[0].payload_json) as Json;
      assert.deepEqual((rejectPayload.cardIds as string[]).sort(), [...ids].sort());
      assert.equal(rejectPayload.reason, "全否重筛");
      assert.equal((JSON.parse(rows[1].payload_json) as Json).runId, "run-x");
    } finally {
      db.close();
    }
  }
  // (5) unpick_sieve_card：撤销挑卡 + undo 账
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      const cardId = seedCard(db);
      const picked = pickPwSieveCard(db, cardId);
      await runTool("unpick_sieve_card", { betId: picked.id }, execContext(db, betId, {
        instruction: { text: "刚才那张挑错了，撤销", messageId: "msg-unpick" },
      }));
      assert.equal(getPwBet(db, picked.id)!.status, "void");
      assert.equal(cardStatus(db, cardId), "pending");
      assert.equal(countRuns(db, "kind = 'ai_exec'"), 1);
      const exec = latestExec(db);
      assert.equal(exec.event_type, "undo");
      assert.equal(exec.instruction_text, "刚才那张挑错了，撤销");
      assert.equal(exec.instruction_message_id, "msg-unpick");
      assert.equal(exec.bet_id, picked.id);
      const payload = JSON.parse(exec.payload_json) as Json;
      assert.equal(payload.betId, picked.id);
      assert.equal(payload.cardId, cardId);
    } finally {
      db.close();
    }
  }
  // (6) void_settlement：作废结账 + undo 账
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      const docId = createPwDataDoc(db, { betId, platform: "bilibili", metricsJson: "{}" }).id;
      const verdict = settlePwBet(db, betId, {
        outcome: "gold",
        lesson: "开头 30 秒放痛点有效",
        evidenceDocIds: [docId],
      });
      await runTool("void_settlement", { betId }, execContext(db, betId, {
        instruction: { text: "结错了，作废", messageId: "msg-void" },
      }));
      assert.equal(getPwBet(db, betId)!.status, "void");
      const voided = db.prepare("SELECT * FROM pw_verdicts WHERE id = ?").get(verdict.id) as PwVerdictRow;
      assert.equal(voided.outcome, "void");
      assert.equal(voided.lesson, "开头 30 秒放痛点有效", "教材原文保留");
      assert.equal(countRuns(db, "kind = 'ai_exec'"), 1);
      const exec = latestExec(db);
      assert.equal(exec.event_type, "undo");
      assert.equal(exec.instruction_text, "结错了，作废");
      assert.equal(exec.instruction_message_id, "msg-void");
      const payload = JSON.parse(exec.payload_json) as Json;
      assert.equal(payload.betId, betId);
      assert.equal(payload.verdictId, verdict.id);
    } finally {
      db.close();
    }
  }
});

test("第1组补充：6 个新 exec 工具缺 instruction 即抛错（每工具一次）", async () => {
  const db = newDb();
  try {
    const betId = makeBet(db);
    const cardId = seedCard(db);
    const ctx: CollabToolContext = { db, betId, refs: new Map() };
    const cases: Array<[string, Json]> = [
      ["settle_bet", { draftId: "no-such", evidenceDocIds: ["d"] }],
      ["pick_sieve_card", { cardId }],
      ["reject_sieve_card", { cardId }],
      ["reject_all_and_resieve", {}],
      ["unpick_sieve_card", { betId }],
      ["void_settlement", { betId }],
    ];
    for (const [name, args] of cases) {
      await assert.rejects(
        () => runTool(name, args, ctx),
        /指令/,
        `${name} 缺 instruction 应抛错`,
      );
    }
    assert.equal(countRuns(db, "kind = 'ai_exec'"), 0, "抛错路径不得落账");
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// 第 2 组：settle_bet 状态机
// ---------------------------------------------------------------------------

test("第2组：settle_bet 状态机——无草案 404 / 非 pending 409 / wait 400 / gold 缺 lesson 400 / 未到结账日透传 / 成功终态", async () => {
  // 无草案 404（getPwSettleDraft 语义，见规格三.1）
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      await assert.rejects(
        () => runTool("settle_bet", { draftId: "no-such-draft", evidenceDocIds: ["d"] }, execContext(db, betId)),
        (error: unknown) => (error as { status?: number }).status === 404,
        "不存在的草案应 404",
      );
    } finally {
      db.close();
    }
  }
  // 非 pending 草案 409
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      const draft = createPwSettleDraft(db, betId, { recommendation: "settle_gold", lesson: "l" });
      approvePwSettleDraft(db, draft.id);
      await assert.rejects(
        () => runTool("settle_bet", { draftId: draft.id, evidenceDocIds: ["d"] }, execContext(db, betId)),
        (error: unknown) => (error as { status?: number }).status === 409,
        "非 pending 草案应 409",
      );
    } finally {
      db.close();
    }
  }
  // wait 草案 400
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      const draft = createPwSettleDraft(db, betId, { recommendation: "wait" });
      await assert.rejects(
        () => runTool("settle_bet", { draftId: draft.id, evidenceDocIds: ["d"] }, execContext(db, betId)),
        (error: unknown) => (error as { status?: number }).status === 400
          && /wait 草案不可结账/.test(String((error as Error).message)),
        "wait 草案应 400",
      );
    } finally {
      db.close();
    }
  }
  // gold 缺 lesson 400
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      const draft = createPwSettleDraft(db, betId, { recommendation: "settle_gold" });
      await assert.rejects(
        () => runTool("settle_bet", { draftId: draft.id, evidenceDocIds: ["d"] }, execContext(db, betId)),
        (error: unknown) => (error as { status?: number }).status === 400
          && /缺 lesson/.test(String((error as Error).message)),
        "gold 草案缺 lesson 应 400",
      );
    } finally {
      db.close();
    }
  }
  // 未到结账日：settlePwBet 的既有报错原样透传
  {
    const db = newDb();
    try {
      const betId = makeBet(db, { checkoutDate: "2099-01-01" });
      const docId = createPwDataDoc(db, { betId, platform: "bilibili", metricsJson: "{}" }).id;
      const draft = createPwSettleDraft(db, betId, { recommendation: "settle_gold", lesson: "l" });
      await assert.rejects(
        () => runTool("settle_bet", { draftId: draft.id, evidenceDocIds: [docId] }, execContext(db, betId)),
        /尚未到结账日/,
        "未到结账日的既有报错应原样透传",
      );
    } finally {
      db.close();
    }
  }
  // 成功终态：草案 approved + 押注 settled + 判决行正确 + evidenceDocIds 进判决
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      const docId = createPwDataDoc(db, { betId, platform: "bilibili", metricsJson: "{}" }).id;
      const draft = createPwSettleDraft(db, betId, { recommendation: "settle_gold", lesson: "确认的lesson" });
      await runTool("settle_bet", { draftId: draft.id, evidenceDocIds: [docId] }, execContext(db, betId));
      assert.equal(getPwSettleDraft(db, draft.id).status, "approved");
      assert.equal(getPwBet(db, betId)!.status, "settled");
      const verdict = db.prepare("SELECT * FROM pw_verdicts WHERE bet_id = ?").get(betId) as PwVerdictRow;
      assert.equal(verdict.outcome, "gold");
      assert.equal(verdict.lesson, "确认的lesson");
      assert.deepEqual(JSON.parse(verdict.evidence_doc_ids_json), [docId]);
    } finally {
      db.close();
    }
  }
});

// ---------------------------------------------------------------------------
// 第 3 组：unpick 状态机
// ---------------------------------------------------------------------------

test("第3组：unpick 状态机——非 content 409 / 非 pending 409 / 候选卡非 picked/edited 409 / 成功 + 唯一索引不破", () => {
  // 非 content 押注 409
  {
    const db = newDb();
    try {
      const betId = makeBet(db); // kind='verdict'
      assert.throws(() => unpickPwContentBet(db, betId, AUDIT), (error) => {
        assertStatus(error, 409);
        return true;
      });
    } finally {
      db.close();
    }
  }
  // 非 pending 409
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      const cardId = seedCard(db);
      const picked = pickPwSieveCard(db, cardId);
      db.prepare("UPDATE pw_bets SET status = 'settled' WHERE id = ?").run(picked.id);
      assert.throws(() => unpickPwContentBet(db, picked.id), (error) => {
        assertStatus(error, 409);
        return true;
      });
    } finally {
      db.close();
    }
  }
  // 候选卡非 picked/edited 409
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      const cardId = seedCard(db);
      const picked = pickPwSieveCard(db, cardId);
      db.prepare("UPDATE pw_sieve_cards SET status = 'rejected' WHERE id = ?").run(cardId);
      assert.throws(() => unpickPwContentBet(db, picked.id), (error) => {
        assertStatus(error, 409);
        return true;
      });
    } finally {
      db.close();
    }
  }
  // 成功路径 + 唯一索引不破（撤销后可对同卡再 pick）
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      const cardId = seedCard(db);
      const picked = pickPwSieveCard(db, cardId);
      const undone = unpickPwContentBet(db, picked.id, AUDIT);
      assert.equal(undone.status, "void");
      assert.equal(undone.source_card_id, cardId);
      assert.equal(cardStatus(db, cardId), "pending");
      assert.equal(countRuns(db, "kind = 'ai_exec' AND event_type = 'undo'"), 1, "undo 账落一条");
      assert.equal(countRuns(db, "kind = 'manual_event' AND event_type = 'undo'"), 0, "audit 路径不得记 manual undo 双账");
      // 唯一索引不破：同卡再 pick 成功（重新生成押注、卡再 picked）
      const repicked = pickPwSieveCard(db, cardId);
      assert.equal(repicked.status, "pending");
      assert.equal(repicked.source_card_id, cardId);
      assert.equal(cardStatus(db, cardId), "picked");
      assert.equal(countRuns(db, "kind = 'manual_event' AND event_type = 'confirm'"), 2, "两次挑卡各一条 confirm");
    } finally {
      db.close();
    }
  }
});

// ---------------------------------------------------------------------------
// 第 4 组：void_settlement 状态机
// ---------------------------------------------------------------------------

test("第4组：void_settlement——非 settled 409 / 成功（判决 void 原文保留、押注 void）+ 可重结断言", () => {
  // 非 settled 409
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      assert.throws(() => voidPwSettlement(db, betId, AUDIT), (error) => {
        assertStatus(error, 409);
        return true;
      });
    } finally {
      db.close();
    }
  }
  // 成功 + 可重结
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      const docId = createPwDataDoc(db, { betId, platform: "bilibili", metricsJson: "{}" }).id;
      const first = settlePwBet(db, betId, {
        outcome: "gold",
        lesson: "确认的lesson",
        evidenceDocIds: [docId],
      });
      const voided = voidPwSettlement(db, betId, AUDIT);
      assert.equal(voided.id, first.id, "作废的是原判决行");
      assert.equal(voided.outcome, "void");
      assert.equal(voided.lesson, "确认的lesson", "教材原文不涂改");
      const bet = getPwBet(db, betId)!;
      assert.equal(bet.status, "void");
      assert.equal(bet.settled_verdict_id, first.id, "历史指针保留");
      // 可重结断言：canRetryAfterVoid 通路——重结后新判决非 void、押注 settled
      const again = settlePwBet(db, betId, {
        outcome: "gold",
        lesson: "重结后的lesson",
        evidenceDocIds: [docId],
      });
      assert.equal(again.outcome, "gold");
      assert.notEqual(again.id, first.id);
      assert.equal(getPwBet(db, betId)!.status, "settled");
      const verdicts = db.prepare(
        "SELECT outcome FROM pw_verdicts WHERE bet_id = ? ORDER BY created_at, id",
      ).all(betId) as Array<{ outcome: string }>;
      assert.deepEqual(
        verdicts.map((row) => row.outcome).sort(),
        ["gold", "void"],
        "唯一索引放行重结：旧判决保持 void、新判决 gold（created_at 同毫秒时 id 随机，按集合断言）",
      );
    } finally {
      db.close();
    }
  }
});

// ---------------------------------------------------------------------------
// 第 5 组：reject_all_and_resieve
// ---------------------------------------------------------------------------

test("第5组：reject_all_and_resieve——3 张全拒 + flushNow 被调 + 两条 ai_exec 同指令；0 张时不报错只落 sieve_run", async () => {
  // 3 张 pending
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      const ids = [seedCard(db, { quote_text: "甲" }), seedCard(db, { quote_text: "乙" }), seedCard(db, { quote_text: "丙" })];
      const { notifier, flushCount } = mockNotifier("run-1");
      await runTool("reject_all_and_resieve", { reason: "都不行" }, execContext(db, betId, {
        instruction: { text: "全部否掉重筛", messageId: "msg-a" },
        sieve: notifier,
      }));
      for (const id of ids) assert.equal(cardStatus(db, id), "rejected");
      assert.equal(flushCount(), 1);
      assert.equal(countRuns(db, "kind = 'ai_exec'"), 2);
      const rows = allExec(db);
      assert.deepEqual(rows.map((row) => row.event_type), ["reject", "sieve_run"]);
      for (const row of rows) {
        assert.equal(row.instruction_text, "全部否掉重筛");
        assert.equal(row.instruction_message_id, "msg-a");
      }
      assert.equal((JSON.parse(rows[0].payload_json) as Json).reason, "都不行");
      assert.equal((JSON.parse(rows[1].payload_json) as Json).runId, "run-1");
    } finally {
      db.close();
    }
  }
  // 0 张 pending
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      const { notifier, flushCount } = mockNotifier("run-2");
      await runTool("reject_all_and_resieve", {}, execContext(db, betId, {
        instruction: { text: "重筛", messageId: "msg-b" },
        sieve: notifier,
      }));
      assert.equal(flushCount(), 1);
      assert.equal(countRuns(db, "kind = 'ai_exec'"), 1, "0 张时不落 reject 账，只落 sieve_run");
      const row = allExec(db)[0];
      assert.equal(row.event_type, "sieve_run");
      assert.equal(row.instruction_text, "重筛");
      assert.equal(row.instruction_message_id, "msg-b");
    } finally {
      db.close();
    }
  }
});

// ---------------------------------------------------------------------------
// 第 6 组：deny 名单新集逐字 + 工具表 35 + 提示词新旧措辞
// ---------------------------------------------------------------------------

test("第6组：deny 名单新集逐字断言 + 工具表 35 计数 + 6 新 exec 前缀与语义 + 提示词新三条/旧两句", () => {
  assert.deepEqual([...pwCollabDeniedToolNames], [
    "mirror_golds",
    "delete_bet",
    "rewrite_verdict",
    "revert_sieve_card",
    "reset_sieve_watermark",
    "delete_collab_message",
    "force_mirror_refresh",
    "clear_risk_events",
  ], "deny 名单新集逐字断言（settle_bet/pick/reject/create_content_bet 已移出）");
  assert.equal(pwCollabTools.length, 35, "工具表 34 → 35（PW-45 新增 promote_voice_to_card）");
  const byName = new Map(pwCollabTools.map((tool) => [tool.name, tool]));
  for (const name of [
    "settle_bet",
    "pick_sieve_card",
    "reject_sieve_card",
    "reject_all_and_resieve",
    "unpick_sieve_card",
    "void_settlement",
  ]) {
    const tool = byName.get(name);
    assert.ok(tool, `工具 ${name} 存在`);
    assert.equal(tool!.policy, "exec", `${name} 应为 exec policy`);
    assert.ok(tool!.description.startsWith("人发话才执行："), `${name} 描述必须以「人发话才执行：」开头`);
  }
  // 规格写死的语义边界在描述里
  assert.ok(byName.get("settle_bet")!.description.includes("把已固化的结账草案一步结掉（两跳合一跳）"));
  assert.ok(byName.get("settle_bet")!.description.includes("evidenceDocIds 必填"));
  assert.ok(byName.get("settle_bet")!.description.includes("没有 pending 结账草案时报错并提示先用 draft_settle 起草"));
  assert.ok(byName.get("unpick_sieve_card")!.description.includes("冲正键——仅限撤销一次挑卡"));
  assert.ok(byName.get("unpick_sieve_card")!.description.includes("不是通用回退"));
  assert.ok(byName.get("void_settlement")!.description.includes("冲正键——仅限作废一笔结账"));
  assert.ok(byName.get("void_settlement")!.description.includes("教材原文不涂改"));

  // 提示词：新三条包含、旧两句不存在
  const prompt = COLLAB_SYSTEM_PROMPT;
  assert.ok(prompt.includes(
    "候选卡的挑/改/否、全否重筛由人发话、你执行（pick_sieve_card / reject_sieve_card / reject_all_and_resieve）；人没发话你不主动挑否。",
  ), "新措辞①在系统提示词中");
  assert.ok(prompt.includes(
    "铸币纪律：结账（settle_bet）按已固化的结账草案一步结掉，草案内容即结账内容，不临场改写；撤销挑卡（unpick_sieve_card）与结账作废（void_settlement）是仅有的两个冲正键，只在用户明确说撤销/作废时使用。",
  ), "铸币纪律在系统提示词中");
  assert.ok(COLLAB_GLOBAL_PROMPT_NOTE.includes(
    "全局对话里同样可以按人指令执行挑/否/结账/冲正——先指认对象（哪张卡/哪笔结账），再执行。",
  ), "新措辞②在全局提示词中");
  assert.ok(!prompt.includes("候选卡只是草稿——挑/改/否只能人做，你没有这个工具。"), "旧措辞①已不存在");
  assert.ok(!COLLAB_GLOBAL_PROMPT_NOTE.includes("挑/改/否仍然只能人做——全局对话里你同样没有这个工具。"), "旧措辞②已不存在");
});

// ---------------------------------------------------------------------------
// 第 7 组：缺省路径（无 audit）维持 PW-19 行为；audit 路径单条 ai_exec 无双账
// ---------------------------------------------------------------------------

test("第7组：缺省路径（无 audit）维持 manual_event/human；audit 路径单条 ai_exec 无双账", () => {
  // pick 缺省 → manual_event/human confirm
  {
    const db = newDb();
    try {
      const cardId = seedCard(db);
      pickPwSieveCard(db, cardId);
      assert.equal(countRuns(db, "kind = 'manual_event' AND event_type = 'confirm' AND actor = 'human'"), 1);
      assert.equal(countRuns(db, "kind = 'ai_exec'"), 0);
    } finally {
      db.close();
    }
  }
  // pick audit → 单条 ai_exec(confirm)，无双账
  {
    const db = newDb();
    try {
      const cardId = seedCard(db);
      pickPwSieveCard(db, cardId, {}, AUDIT);
      assert.equal(countRuns(db, "kind = 'ai_exec' AND event_type = 'confirm'"), 1);
      assert.equal(countRuns(db, "kind = 'manual_event'"), 0, "audit 路径不得双账");
    } finally {
      db.close();
    }
  }
  // reject 缺省 → manual_event/human reject
  {
    const db = newDb();
    try {
      const cardId = seedCard(db);
      rejectPwSieveCard(db, cardId, "理由");
      assert.equal(countRuns(db, "kind = 'manual_event' AND event_type = 'reject' AND actor = 'human'"), 1);
    } finally {
      db.close();
    }
  }
  // rejectAllPending 缺省 → manual_event/human reject（含 cardIds）
  {
    const db = newDb();
    try {
      const ids = [seedCard(db, { quote_text: "a" }), seedCard(db, { quote_text: "b" })];
      const rejected = rejectAllPendingPwSieveCards(db, "全否");
      assert.deepEqual(rejected.sort(), [...ids].sort());
      const row = db.prepare(`
        SELECT payload_json FROM pw_runs WHERE kind = 'manual_event' AND event_type = 'reject'
      `).get() as { payload_json: string };
      const payload = JSON.parse(row.payload_json) as Json;
      assert.deepEqual((payload.cardIds as string[]).sort(), [...ids].sort());
      assert.equal(payload.reason, "全否");
    } finally {
      db.close();
    }
  }
  // rejectAllPending 0 张 → 空数组、不落账
  {
    const db = newDb();
    try {
      const rejected = rejectAllPendingPwSieveCards(db);
      assert.deepEqual(rejected, []);
      assert.equal(countRuns(db, "kind = 'manual_event'"), 0);
      assert.equal(countRuns(db, "kind = 'ai_exec'"), 0);
    } finally {
      db.close();
    }
  }
  // unpick 缺省 → manual_event/human undo
  {
    const db = newDb();
    try {
      const cardId = seedCard(db);
      const picked = pickPwSieveCard(db, cardId);
      unpickPwContentBet(db, picked.id);
      assert.equal(countRuns(db, "kind = 'manual_event' AND event_type = 'undo' AND actor = 'human'"), 1);
    } finally {
      db.close();
    }
  }
  // voidPwSettlement 缺省 → manual_event/human undo
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      const docId = createPwDataDoc(db, { betId, platform: "bilibili", metricsJson: "{}" }).id;
      settlePwBet(db, betId, { outcome: "gold", lesson: "l", evidenceDocIds: [docId] });
      voidPwSettlement(db, betId);
      assert.equal(countRuns(db, "kind = 'manual_event' AND event_type = 'undo' AND actor = 'human'"), 1);
    } finally {
      db.close();
    }
  }
});
