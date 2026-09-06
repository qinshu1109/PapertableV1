/**
 * TASK-PW-24：人发话写工具（exec policy）测试。
 * 覆盖规格第六节 7 组：
 * 1. 9 个 exec 工具逐个：业务行正确 + pw_runs 恰一条 ai_exec（event_type/instruction 两列/payload 关键字段对）；
 * 2. exec 工具缺 instruction → 抛错；
 * 3. edit_bet 状态机（draft/pending 可改、settled/void 409、只改传入字段）+ create_bet 三行不齐落 draft；
 * 4. add_voice audit 参数（传 ai 单条 exec(voice) 无双账；缺省维持 human 账）；
 * 5. deny 名单缩减新集 + 工具表 35 计数 + 9 exec policy/描述前缀断言（PW-25 新 6 个 exec 在 pw-mint-undo.test.ts 断言）；
 * 6. 店规提示词三段包含断言 + PW-25 新措辞（旧「无转卡工具」两句已替换）；
 * 7. list_my_actions（instruction 截断与「无引用！」标记）。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { attachPwArtifact, ensurePwArtifactTables } from "./pw-artifacts.ts";
import { createPwBet, ensurePwBetTables, getPwBet } from "./pw-bets.ts";
import { COLLAB_SYSTEM_PROMPT, ensurePwCollabTables } from "./pw-collab.ts";
import { ensurePwConnectionTables } from "./pw-connections.ts";
import { ensurePwCorpusTables } from "./pw-corpus.ts";
import { createPwDataDoc, ensurePwDataDocTables } from "./pw-data-docs.ts";
import { createPwBetDraft, ensurePwDraftTables } from "./pw-drafts.ts";
import { ensurePwGoldMirrorTables } from "./pw-gold-sync.ts";
import { ensurePwRunTables, recordPwEvent, recordPwExecEvent } from "./pw-runs.ts";
import { createSieveNotifier, ensurePwSieveTables } from "./pw-sieve.ts";
import { ensurePwVerdictTables } from "./pw-verdicts.ts";
import { addPwVoiceItem, ensurePwVoiceTables } from "./pw-voice.ts";
import {
  pwCollabTools,
  pwCollabDeniedToolNames,
  type CollabTool,
  type CollabToolContext,
} from "./pw-collab-tools.ts";

type Json = Record<string, unknown>;

function newDb(): DatabaseSync {
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
  const bet = createPwBet(db, {
    title: "直播做产品实践",
    thesis: "直播系列能成",
    metric: "三期平均播放 ≥ 5000",
    metricTarget: ">= 5000",
    dataSourcePlan: "B站",
    checkoutDate: "2026-09-01",
    confidence: 70,
    status: "pending",
    ...overrides,
  });
  return bet.id;
}

/** 完整三行赌注的草稿（可 confirm 转正）。 */
function makeDraft(db: DatabaseSync): string {
  const draft = createPwBetDraft(db, {
    title: "AI 起草押注",
    thesis: "原始假设",
    metric: "播放量",
    metricTarget: ">= 3000",
    confidence: 60,
    dataSourcePlan: "B站",
    checkoutDate: "2026-09-01",
  }, "collab-ai");
  return draft.id;
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

function insertVoice(db: DatabaseSync, content: string): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO pw_voice_items(id, artifact_id, platform, author_hash, content, captured_at, created_at)
    VALUES(?, NULL, 'bilibili', 'hash', ?, ?, ?)
  `).run(id, content, "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z");
  return id;
}

/** mock 筛子 LLM：返回写死的两卡（normal + wildcard），引文与注入声音逐字一致。 */
function mockSieveLlm(): (input: string) => Promise<string> {
  return async () => JSON.stringify({ cards: [
    {
      quote_text: "直播做产品实践这个实验设计得真巧妙",
      quote_source: { bvid: "voice", uname: "甲" },
      scale_note: "高赞",
      hook_note: "开头钩子",
      freshness_note: "新发布",
      wildcard: false,
    },
    {
      quote_text: "少数派声音：录屏不剪辑也有人看",
      quote_source: { bvid: "voice", uname: "乙" },
      scale_note: "少数人",
      hook_note: "异类视角",
      freshness_note: "新发布",
      wildcard: true,
    },
  ] });
}

// ---------------------------------------------------------------------------
// 第 1 组：9 个 exec 工具逐个（业务行正确 + pw_runs 恰一条 ai_exec）
// ---------------------------------------------------------------------------

test("第1组：9 个 exec 工具逐个——业务行正确 + 恰一条 ai_exec（event_type/instruction/payload 对）", async () => {
  // (1) confirm_bet_draft：草稿转正 pending
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      const draftId = makeDraft(db);
      await runTool("confirm_bet_draft", { draftId }, execContext(db, betId, {
        instruction: { text: "确认这份草稿", messageId: "msg-confirm" },
      }));
      assert.equal(getPwBet(db, draftId)!.status, "pending", "confirm 后草稿转 pending");
      assert.equal(countRuns(db, "kind = 'ai_exec'"), 1);
      const exec = latestExec(db);
      assert.equal(exec.event_type, "confirm");
      assert.equal(exec.instruction_text, "确认这份草稿");
      assert.equal(exec.instruction_message_id, "msg-confirm");
      assert.equal(exec.bet_id, draftId);
      const payload = JSON.parse(exec.payload_json) as Json;
      assert.equal(payload.draftId, draftId);
      assert.equal(payload.betId, draftId);
      assert.deepEqual(payload.edits, {});
    } finally {
      db.close();
    }
  }
  // (2) reject_bet_draft：草稿作废
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      const draftId = makeDraft(db);
      await runTool("reject_bet_draft", { draftId, reason: "方向不对" }, execContext(db, betId, {
        instruction: { text: "这张草稿不要了", messageId: "msg-reject" },
      }));
      assert.equal(getPwBet(db, draftId)!.status, "void", "reject 后草稿作废");
      assert.equal(countRuns(db, "kind = 'ai_exec'"), 1);
      const exec = latestExec(db);
      assert.equal(exec.event_type, "reject");
      assert.equal(exec.instruction_text, "这张草稿不要了");
      assert.equal(exec.instruction_message_id, "msg-reject");
      const payload = JSON.parse(exec.payload_json) as Json;
      assert.equal(payload.draftId, draftId);
      assert.equal(payload.reason, "方向不对");
    } finally {
      db.close();
    }
  }
  // (3) create_bet：三行齐 → pending
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      await runTool("create_bet", {
        title: "新押注",
        thesis: "短内容日更涨粉",
        metric: "粉丝数",
        metricTarget: ">1000",
        confidence: 70,
        dataSourcePlan: "B站后台",
        checkoutDate: "2026-09-01",
      }, execContext(db, betId, { instruction: { text: "帮我记一笔押注", messageId: "msg-create" } }));
      assert.equal(countRuns(db, "kind = 'ai_exec'"), 1);
      const exec = latestExec(db);
      assert.equal(exec.event_type, "create");
      assert.equal(exec.instruction_text, "帮我记一笔押注");
      const payload = JSON.parse(exec.payload_json) as Json;
      assert.equal(payload.status, "pending", "三行齐全落 pending");
      assert.ok(typeof payload.betId === "string");
      assert.equal(getPwBet(db, payload.betId as string)!.status, "pending");
      assert.equal(getPwBet(db, payload.betId as string)!.created_from, "collab-ai");
    } finally {
      db.close();
    }
  }
  // (4) edit_bet：改标题，只改传入字段
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      await runTool("edit_bet", { betId, fields: { title: "改名后的押注" } }, execContext(db, betId, {
        instruction: { text: "标题改一下", messageId: "msg-edit" },
      }));
      const bet = getPwBet(db, betId)!;
      assert.equal(bet.title, "改名后的押注");
      assert.equal(bet.thesis, "直播系列能成", "未传入字段不变");
      assert.equal(countRuns(db, "kind = 'ai_exec'"), 1);
      const exec = latestExec(db);
      assert.equal(exec.event_type, "edit");
      const payload = JSON.parse(exec.payload_json) as Json;
      assert.equal(payload.betId, betId);
      assert.deepEqual(payload.changedFields, ["title"]);
    } finally {
      db.close();
    }
  }
  // (5) freeze_data_doc：冻结版本链
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      const doc = createPwDataDoc(db, { betId, platform: "bilibili", metricsJson: "{}" });
      await runTool("freeze_data_doc", { docId: doc.id }, execContext(db, betId, {
        instruction: { text: "把数据文档冻住", messageId: "msg-freeze" },
      }));
      const frozen = (db.prepare("SELECT frozen FROM pw_data_docs WHERE id = ?").get(doc.id) as { frozen: number }).frozen;
      assert.equal(frozen, 1);
      assert.equal(countRuns(db, "kind = 'ai_exec'"), 1);
      const exec = latestExec(db);
      assert.equal(exec.event_type, "freeze");
      const payload = JSON.parse(exec.payload_json) as Json;
      assert.equal(payload.docId, doc.id);
      assert.equal(payload.betId, betId);
      assert.equal(payload.platform, "bilibili");
    } finally {
      db.close();
    }
  }
  // (6) run_sieve：真实触发一筛（机制账 + 指令账两条，ai_exec 恰一条）
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      const v1 = insertVoice(db, "直播做产品实践这个实验设计得真巧妙");
      const v2 = insertVoice(db, "少数派声音：录屏不剪辑也有人看");
      const notifier = createSieveNotifier({ db, llm: mockSieveLlm() });
      notifier.notifyArrival("manual", [v1, v2]);
      await runTool("run_sieve", {}, execContext(db, betId, {
        instruction: { text: "现在跑一筛", messageId: "msg-sieve" },
        sieve: notifier,
      }));
      const run = db.prepare("SELECT * FROM pw_sieve_runs").get() as { id: string; status: string; cards_count: number };
      assert.equal(run.status, "done");
      assert.equal(run.cards_count, 2);
      assert.equal(countRuns(db, "kind = 'ai_exec'"), 1);
      const exec = latestExec(db);
      assert.equal(exec.event_type, "sieve_run");
      assert.equal(exec.instruction_text, "现在跑一筛");
      assert.equal(exec.instruction_message_id, "msg-sieve");
      assert.equal(exec.bet_id, null, "筛子 run 与押注无关，bet_id 为 null");
      const payload = JSON.parse(exec.payload_json) as Json;
      assert.equal(payload.runId, run.id);
      assert.equal(countRuns(db, "kind = 'sieve' AND event_type = 'sieve_run' AND actor = 'system'"), 1, "机制账照记");
      // 队列空：flushNow 返回 runId:null 属既有语义
      const emptyNotifier = createSieveNotifier({ db });
      const result = await runTool("run_sieve", {}, execContext(db, betId, {
        instruction: { text: "再跑一筛", messageId: "msg-sieve-2" },
        sieve: emptyNotifier,
      }));
      const text = result.content[0].text;
      assert.ok(text.includes("队列为空"), "队列空时应如实说明");
      const exec2 = db.prepare(`
        SELECT payload_json FROM pw_runs WHERE kind = 'ai_exec' ORDER BY rowid DESC LIMIT 1
      `).get() as { payload_json: string };
      assert.equal((JSON.parse(exec2.payload_json) as Json).runId, null);
    } finally {
      db.close();
    }
  }
  // (7) add_voice：录入观众声音（合成一条 exec(voice)）
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      const artifactId = attachPwArtifact(db, { betId, platform: "bilibili", type: "video", url: "https://b23.tv/x" }).id;
      await runTool("add_voice", {
        artifactId,
        content: "这句话很有意思，值得记",
        platform: "bilibili",
      }, execContext(db, betId, { instruction: { text: "把这条评论记进声音", messageId: "msg-voice" } }));
      const voice = db.prepare("SELECT artifact_id, content, author_hash FROM pw_voice_items").get() as {
        artifact_id: string | null;
        content: string;
        author_hash: string;
      };
      assert.equal(voice.artifact_id, artifactId);
      assert.equal(voice.content, "这句话很有意思，值得记");
      assert.equal(countRuns(db, "kind = 'ai_exec'"), 1);
      assert.equal(countRuns(db, "kind = 'manual_event'"), 0, "audit 路径不得双账");
      const exec = latestExec(db);
      assert.equal(exec.event_type, "voice");
      assert.equal(exec.instruction_text, "把这条评论记进声音");
      assert.equal(exec.instruction_message_id, "msg-voice");
      const payload = JSON.parse(exec.payload_json) as Json;
      assert.equal(payload.artifactId, artifactId);
      assert.equal(payload.platform, "bilibili");
      assert.ok(typeof payload.voiceId === "string");
    } finally {
      db.close();
    }
  }
  // (8) attach_artifact：挂产出物
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      await runTool("attach_artifact", {
        betId,
        type: "video",
        platform: "bilibili",
        url: "https://b23.tv/abc",
        title: "第一期成片",
      }, execContext(db, betId, { instruction: { text: "把成片挂上去", messageId: "msg-attach" } }));
      const artifact = db.prepare("SELECT bet_id, type, platform, url, title FROM pw_artifacts").get() as {
        bet_id: string;
        type: string;
        platform: string;
        url: string | null;
        title: string | null;
      };
      assert.equal(artifact.bet_id, betId);
      assert.equal(artifact.type, "video");
      assert.equal(artifact.url, "https://b23.tv/abc");
      assert.equal(countRuns(db, "kind = 'ai_exec'"), 1);
      const exec = latestExec(db);
      assert.equal(exec.event_type, "attach");
      const payload = JSON.parse(exec.payload_json) as Json;
      assert.equal(payload.betId, betId);
      assert.equal(payload.type, "video");
      assert.ok(typeof payload.artifactId === "string");
    } finally {
      db.close();
    }
  }
  // (9) detach_artifact：摘下产出物（沿用路由层 event_type=attach + detached:true）
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      const artifactId = attachPwArtifact(db, { betId, platform: "bilibili", type: "video", url: "https://b23.tv/x" }).id;
      await runTool("detach_artifact", { artifactId }, execContext(db, betId, {
        instruction: { text: "把那条产出物摘了", messageId: "msg-detach" },
      }));
      const detached = (db.prepare("SELECT detached_at FROM pw_artifacts WHERE id = ?").get(artifactId) as { detached_at: string | null }).detached_at;
      assert.ok(detached, "detach 软删除");
      assert.equal(countRuns(db, "kind = 'ai_exec'"), 1);
      const exec = latestExec(db);
      assert.equal(exec.event_type, "attach");
      const payload = JSON.parse(exec.payload_json) as Json;
      assert.equal(payload.artifactId, artifactId);
      assert.equal(payload.detached, true);
      assert.equal(payload.betId, betId);
    } finally {
      db.close();
    }
  }
});

// ---------------------------------------------------------------------------
// 第 2 组：exec 工具缺 instruction → 抛错（每工具一次）
// ---------------------------------------------------------------------------

test("第2组：exec 工具缺 instruction 即抛错（每工具断言一次）", async () => {
  const db = newDb();
  try {
    const betId = makeBet(db);
    const draftId = makeDraft(db);
    const doc = createPwDataDoc(db, { betId, platform: "bilibili", metricsJson: "{}" });
    const artifactId = attachPwArtifact(db, { betId, platform: "bilibili", type: "video", url: "https://x" }).id;
    const ctx: CollabToolContext = { db, betId, refs: new Map() };
    const cases: Array<[string, Json]> = [
      ["confirm_bet_draft", { draftId }],
      ["reject_bet_draft", { draftId }],
      ["create_bet", { title: "t", thesis: "t" }],
      ["edit_bet", { betId, fields: { title: "x" } }],
      ["freeze_data_doc", { docId: doc.id }],
      ["run_sieve", {}],
      ["add_voice", { artifactId, content: "c", platform: "bilibili" }],
      ["attach_artifact", { betId, type: "video", platform: "bilibili", url: "https://x" }],
      ["detach_artifact", { artifactId }],
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
// 第 3 组：edit_bet 状态机 + create_bet 三行不齐落 draft
// ---------------------------------------------------------------------------

test("第3组：edit_bet 状态机（draft/pending 可改、settled/void 409、只改传入字段）+ create_bet 三行不齐落 draft", async () => {
  // draft 可改，只改传入字段
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      const draftId = makeDraft(db);
      await runTool("edit_bet", { betId: draftId, fields: { title: "草稿新标题" } }, execContext(db, betId));
      const draft = getPwBet(db, draftId)!;
      assert.equal(draft.title, "草稿新标题");
      assert.equal(draft.thesis, "原始假设", "未传入字段不变");
      assert.equal(draft.status, "draft");
    } finally {
      db.close();
    }
  }
  // pending 可改
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      await runTool("edit_bet", { betId, fields: { metric: "新指标" } }, execContext(db, betId));
      assert.equal(getPwBet(db, betId)!.metric, "新指标");
      assert.equal(getPwBet(db, betId)!.status, "pending");
    } finally {
      db.close();
    }
  }
  // settled → 409
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      db.prepare("UPDATE pw_bets SET status = 'settled' WHERE id = ?").run(betId);
      await assert.rejects(
        () => runTool("edit_bet", { betId, fields: { title: "x" } }, execContext(db, betId)),
        (error: unknown) => (error as { status?: number }).status === 409
          && /draft\/pending/.test(String((error as Error).message)),
        "settled 押注编辑应 409",
      );
      assert.equal(getPwBet(db, betId)!.title, "直播做产品实践", "409 不落任何修改");
    } finally {
      db.close();
    }
  }
  // void → 409
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      db.prepare("UPDATE pw_bets SET status = 'void' WHERE id = ?").run(betId);
      await assert.rejects(
        () => runTool("edit_bet", { betId, fields: { title: "x" } }, execContext(db, betId)),
        (error: unknown) => (error as { status?: number }).status === 409
          && /draft\/pending/.test(String((error as Error).message)),
        "void 押注编辑应 409",
      );
    } finally {
      db.close();
    }
  }
  // 缺字段清空（metric 传 null 清空）
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      await runTool("edit_bet", { betId, fields: { metric: null } }, execContext(db, betId));
      assert.equal(getPwBet(db, betId)!.metric, null, "显式 null 清空可空字段");
    } finally {
      db.close();
    }
  }
  // create_bet 三行不齐 → 只能落 draft
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      await runTool("create_bet", { title: "不齐押注", thesis: "只有假设" }, execContext(db, betId));
      assert.equal(countRuns(db, "kind = 'ai_exec'"), 1);
      const payload = JSON.parse(latestExec(db).payload_json) as Json;
      assert.equal(payload.status, "draft", "三行不齐落 draft");
      assert.equal(getPwBet(db, payload.betId as string)!.status, "draft");
    } finally {
      db.close();
    }
  }
});

// ---------------------------------------------------------------------------
// 第 4 组：add_voice audit 参数（传 ai 单条 exec(voice) 无双账；缺省维持 human 账）
// ---------------------------------------------------------------------------

test("第4组：add_voice audit 参数——传 ai 单条 exec(voice) 无双账；缺省维持 human 账（PW-23 不破）", () => {
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      const artifactId = attachPwArtifact(db, { betId, platform: "bilibili", type: "video", url: "https://x" }).id;
      addPwVoiceItem(db, {
        artifactId,
        platform: "bilibili",
        content: "观众原话",
        capturedAt: "2026-08-01T00:00:00Z",
        author: "观众甲",
      }, {
        actor: "ai",
        instructionText: "记下这句",
        instructionMessageId: "msg-v",
      });
      assert.equal(countRuns(db, "kind = 'ai_exec'"), 1, "audit 路径恰一条 ai_exec");
      assert.equal(countRuns(db, "kind = 'manual_event'"), 0, "audit 路径不得有 manual_event 双账");
      const exec = latestExec(db);
      assert.equal(exec.event_type, "voice");
      assert.equal(exec.instruction_text, "记下这句");
      assert.equal(exec.instruction_message_id, "msg-v");
      assert.ok(typeof (JSON.parse(exec.payload_json) as Json).voiceId === "string");
    } finally {
      db.close();
    }
  }
  {
    const db = newDb();
    try {
      const betId = makeBet(db);
      const artifactId = attachPwArtifact(db, { betId, platform: "bilibili", type: "video", url: "https://x" }).id;
      addPwVoiceItem(db, {
        artifactId,
        platform: "bilibili",
        content: "又一条",
        capturedAt: "2026-08-01T00:00:00Z",
        author: "观众乙",
      });
      assert.equal(countRuns(db, "kind = 'manual_event' AND event_type = 'voice' AND actor = 'human'"), 1, "缺省维持 human 账");
      assert.equal(countRuns(db, "kind = 'ai_exec'"), 0);
    } finally {
      db.close();
    }
  }
});

// ---------------------------------------------------------------------------
// 第 5 组：deny 名单缩减新集 + 工具表 35 计数 + 9 exec policy/描述前缀断言
// ---------------------------------------------------------------------------

test("第5组：deny 名单缩减新集断言 + 工具表 35 计数 + 9 exec policy 与「人发话才执行：」前缀", () => {
  const names = new Set(pwCollabTools.map((tool) => tool.name));
  const deny = new Set(pwCollabDeniedToolNames);
  assert.equal(pwCollabTools.length, 35, "工具表 34 → 35（PW-45 新增 promote_voice_to_card）");
  assert.equal(deny.has("create_pending_bet"), false, "create_pending_bet 已移出 deny（create_bet/confirm 进表）");
  // TASK-PW-25：settle_bet / pick_sieve_card / reject_sieve_card / create_content_bet 移出 deny
  assert.equal(deny.has("settle_bet"), false, "settle_bet 已移出 deny（settle_bet 进表）");
  assert.equal(deny.has("pick_sieve_card"), false, "pick_sieve_card 已移出 deny（pick_sieve_card 进表）");
  assert.equal(deny.has("reject_sieve_card"), false, "reject_sieve_card 已移出 deny（reject_sieve_card 进表）");
  assert.equal(deny.has("create_content_bet"), false, "create_content_bet 已移出 deny（无独立工具，挑卡带 overrides 即改挑）");
  const retained = ["mirror_golds"];
  const added = [
    "delete_bet",
    "rewrite_verdict",
    "revert_sieve_card",
    "reset_sieve_watermark",
    "delete_collab_message",
    "force_mirror_refresh",
    "clear_risk_events",
  ];
  for (const name of [...retained, ...added]) {
    assert.equal(deny.has(name), true, `deny 名单应含 ${name}`);
    assert.equal(names.has(name), false, `工具表不允许出现 ${name}`);
  }
  const execNames = [
    "confirm_bet_draft",
    "reject_bet_draft",
    "create_bet",
    "edit_bet",
    "freeze_data_doc",
    "run_sieve",
    "add_voice",
    "attach_artifact",
    "detach_artifact",
  ];
  const policyOf = new Map(pwCollabTools.map((tool) => [tool.name, tool.policy]));
  for (const name of execNames) {
    const tool = requireTool(name);
    assert.equal(policyOf.get(name), "exec", `${name} 应为 exec policy`);
    assert.ok(tool.description.startsWith("人发话才执行："), `${name} 描述必须以「人发话才执行：」开头`);
  }
  assert.equal(policyOf.get("list_my_actions"), "allow", "查账工具 allow 只读");
});

// ---------------------------------------------------------------------------
// 第 6 组：店规提示词三段包含断言 + 「无转卡工具」措辞已替换为 PW-25 新措辞
// ---------------------------------------------------------------------------

test("第6组：店规提示词三段原文照录（包含断言）；既有纪律（逐字引用）原样保留 + PW-25 新措辞替换旧句", () => {
  const prompt = COLLAB_SYSTEM_PROMPT;
  assert.ok(prompt.includes(
    "写工具纪律：凡 description 以「人发话才执行」开头的工具，只有在用户当轮消息明确提出该动作时才允许调用；用户没说的写入一律不做，宁可反问。",
  ), "店规段①在提示词中");
  assert.ok(prompt.includes(
    "指认规矩：摆对象时用菜号牌（候选卡=证据 N / 少数派 N，在途押注=注 N，数据文档=文档 N，草稿=草稿 id 前 8 位，语料=BV 号，金子墓碑=§N）——这些编号和用户在屏幕上看到的徽标同源；用户说「就这张」时锚定当前话题对象；指认明确就直接执行，不复述不二次确认；指认含糊必须反问，绝不猜——同名区有多张时（如少数派 1/2/3），「那张」一律反问到哪一张。",
  ), "店规段②在提示词中");
  assert.ok(prompt.includes(
    "查账：用户问「你最近代办了什么」时用 list_my_actions 如实摆出，包括依据的是哪句话。",
  ), "店规段③在提示词中");
  // 既有纪律原样保留
  assert.ok(prompt.includes("引用评论或语料必须逐字引用原文（原文原则），禁止改写或概括。"), "原文原则仍在");
  // TASK-PW-25：候选卡挑/改/否进表——旧「无转卡工具」措辞替换为新措辞
  assert.ok(prompt.includes(
    "候选卡的挑/改/否、全否重筛由人发话、你执行（pick_sieve_card / reject_sieve_card / reject_all_and_resieve）；人没发话你不主动挑否。",
  ), "PW-25 新措辞在提示词中");
  assert.ok(!prompt.includes("候选卡只是草稿——挑/改/否只能人做，你没有这个工具。"), "旧「无转卡工具」措辞已替换");
});

// ---------------------------------------------------------------------------
// 第 7 组：list_my_actions（instruction 截断与「无引用！」标记）
// ---------------------------------------------------------------------------

test("第7组：list_my_actions——instruction 截 60 字带省略号；缺指令标「无引用！」", async () => {
  const db = newDb();
  try {
    const betId = makeBet(db);
    const longInstruction = "改".repeat(70);
    recordPwExecEvent(db, {
      eventType: "edit",
      instructionText: longInstruction,
      instructionMessageId: "msg-long",
      payloadJson: JSON.stringify({ betId: "b-x", changedFields: ["title"] }),
    });
    recordPwEvent(db, {
      kind: "ai_draft",
      eventType: "draft",
      actor: "ai",
      payloadJson: JSON.stringify({ draftId: "d-x", title: "AI 起草草稿", source: "collab-ai" }),
      relatedIds: ["d-x"],
    });
    const result = await runTool("list_my_actions", { limit: 10 }, { db, betId, refs: new Map() });
    const text = result.content[0].text;
    assert.ok(text.includes("改".repeat(60) + "…"), "超 60 字指令应截断并带省略号");
    // TASK-PW-27：ai_draft 缺指令属设计（draft 档无指令列），标「起草（无需指令）」而非「无引用！」
    assert.ok(text.includes("起草（无需指令）"), "缺指令的 ai_draft 行应标「起草（无需指令）」");
    assert.ok(!text.includes("无引用！"), "ai_draft 不再误标「无引用！」");
    assert.ok(text.includes("AI 起草草稿"), "对象取自 payload.title");
    assert.ok(text.includes("修改押注"), "动作映射为中文标签");
  } finally {
    db.close();
  }
});
