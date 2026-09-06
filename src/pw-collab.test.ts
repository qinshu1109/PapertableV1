/**
 * TASK-PW-15 协作台 Harness 测试。
 * 覆盖：权限表静态化、fetch_corpus 自主直抓（PW-26 起 auto 档）、draft_bet 落 draft + ai_draft hash、
 * 装配 v2（墓碑 §N 续接 / 数据文档 / 语料预检）、批准流、消息存取、SSE 端到端（本地 mock 模型）。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ensurePwArtifactTables } from "./pw-artifacts.ts";
import { createPwBet, ensurePwBetTables, getPwBet } from "./pw-bets.ts";
import {
  ensurePwCollabTables,
  appendPwCollabMessage,
  listPwCollabMessages,
  createPwSettleDraft,
  listPwSettleDrafts,
  approvePwSettleDraft,
  rejectPwSettleDraft,
  collabPendingQueue,
} from "./pw-collab.ts";
import {
  ensurePwConnectionTables,
} from "./pw-connections.ts";
import {
  authorizePwCorpus,
  approvePwCorpusProposal,
  donePwCorpus,
  ensurePwCorpusTables,
  listPwCorpusPending,
  listPwCorpusProposed,
  proposePwCorpus,
  rejectPwCorpusProposal,
} from "./pw-corpus.ts";
import { buildCollabContext } from "./pw-context.ts";
import { ensurePwDataDocTables, createPwDataDoc } from "./pw-data-docs.ts";
import { ensurePwDraftTables } from "./pw-drafts.ts";
import { ensurePwGoldMirrorTables } from "./pw-gold-sync.ts";
import { ensurePwRunTables } from "./pw-runs.ts";
import { ensurePwSieveTables } from "./pw-sieve.ts";
import { ensurePwVerdictTables } from "./pw-verdicts.ts";
import { ensurePwVoiceTables } from "./pw-voice.ts";
import {
  pwCollabTools,
  pwCollabDeniedToolNames,
  type CollabTool,
  type CollabToolContext,
} from "./pw-collab-tools.ts";
import { createApp, type PapertableApp } from "./main.ts";

type Json = Record<string, unknown>;

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

function insertVerdict(
  db: DatabaseSync,
  input: {
    id: string;
    betId: string;
    outcome: "gold" | "tomb";
    lesson?: string;
    causeOfDeath?: string;
    decidedAt?: string;
  },
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
    input.lesson ?? null,
    input.causeOfDeath ?? null,
    input.decidedAt ?? "2026-08-01T00:00:00Z",
    input.decidedAt ?? "2026-08-01T00:00:00Z",
  );
}

function insertMirror(db: DatabaseSync, input: { id: string; text: string; mirroredAt: string }): void {
  db.prepare(`
    INSERT INTO pw_gold_mirror(
      id, source_verdict_id, kind, text, handle, project_id, card_id, confirmed_at, mirrored_at
    ) VALUES(?, ?, 'gold', ?, NULL, NULL, NULL, NULL, ?)
  `).run(input.id, input.id, input.text, input.mirroredAt);
}

function toolContext(db: DatabaseSync, betId: string): CollabToolContext {
  return { db, betId, refs: new Map() };
}

function requireTool(name: string): CollabTool {
  const tool = pwCollabTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`工具不存在: ${name}`);
  return tool;
}

test("权限表静态化：无写正式表工具，policy 静态写死", () => {
  const names = new Set(pwCollabTools.map((tool) => tool.name));
  for (const denied of pwCollabDeniedToolNames) {
    assert.equal(names.has(denied), false, `工具表不允许出现 ${denied}`);
  }
  const policyOf = new Map(pwCollabTools.map((tool) => [tool.name, tool.policy]));
  assert.equal(policyOf.get("read_bet"), "allow");
  assert.equal(policyOf.get("read_data_docs"), "allow");
  assert.equal(policyOf.get("search_verdicts"), "allow");
  assert.equal(policyOf.get("search_corpus"), "allow");
  assert.equal(policyOf.get("read_voice"), "allow");
  assert.equal(policyOf.get("fetch_corpus"), "auto");
  assert.equal(policyOf.get("draft_bet"), "draft");
  assert.equal(policyOf.get("draft_settle"), "draft");
  // TASK-PW-21：8 个深挖只读工具全 allow
  for (const name of [
    "list_corpus",
    "read_corpus_doc",
    "read_corpus_comments",
    "read_doc_versions",
    "read_verdict_evidence",
    "read_connections",
    "list_sieve_cards",
    "read_sieve_card",
    "list_content_bets",
  ]) {
    assert.equal(policyOf.get(name), "allow", `${name} 应为只读 allow`);
  }
  assert.equal(pwCollabTools.length, 35, "PW-45 新增 promote_voice_to_card 后工具表 35");
});

test("fetch_corpus 自主直抓：authorize 进 pending + 触发抓取器 + ai_auto 账", async () => {
  const db = makeDb();
  try {
    const betId = makeBet(db);
    let runnerCalls = 0;
    const context: CollabToolContext = {
      ...toolContext(db, betId),
      fetchRunner: () => {
        runnerCalls += 1;
        return { started: true };
      },
    };
    const result = await requireTool("fetch_corpus").execute(
      "call-1",
      { bvid: "BV1NprhBPEtR", reason: "选题调研" },
      undefined,
      undefined,
      context,
    );
    const details = result.details as { corpusId?: string };
    assert.ok(details.corpusId);
    // 直接进授权队列（不再是 proposed 待批）
    const doc = db.prepare("SELECT * FROM pw_corpus_docs WHERE id = ?").get(details.corpusId!) as
      | { status: string; authorized_by: string }
      | undefined;
    assert.equal(doc?.status, "pending");
    assert.equal(doc?.authorized_by, "ai");
    assert.deepEqual(listPwCorpusPending(db).map((row) => row.id), [details.corpusId]);
    assert.equal(runnerCalls, 1);
    // 自主档账：ai_auto + corpus + actor=ai + 无指令引用 + payload 带 runnerStarted
    const event = db.prepare(`
      SELECT * FROM pw_runs WHERE kind = 'ai_auto' AND event_type = 'corpus'
    `).get() as { actor: string; bet_id: string; instruction_text: string | null; payload_json: string };
    assert.equal(event.actor, "ai");
    assert.equal(event.bet_id, betId);
    assert.equal(event.instruction_text, null);
    const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
    assert.equal(payload.bvid, "BV1NprhBPEtR");
    assert.equal(payload.reason, "选题调研");
    assert.equal(payload.runnerStarted, true);
    // 既有条目不重复抓、不重复记账、不再触发抓取器
    const again = await requireTool("fetch_corpus").execute(
      "call-2",
      { bvid: "BV1NprhBPEtR" },
      undefined,
      undefined,
      context,
    );
    assert.match((again.content[0] as { text: string }).text, /不重复抓取/);
    assert.equal(runnerCalls, 1);
    const autoCount = db.prepare(`
      SELECT COUNT(*) AS count FROM pw_runs WHERE kind = 'ai_auto'
    `).get() as { count: number };
    assert.equal(Number(autoCount.count), 1);
  } finally {
    db.close();
  }
});

test("draft_bet 落 pw_bets draft 态 + ai_draft 事件 hash 一致", async () => {
  const db = makeDb();
  try {
    const betId = makeBet(db);
    const result = await requireTool("draft_bet").execute(
      "call-2",
      {
        title: "AI 起草押注",
        thesis: "短内容日更能涨粉",
        metric: "粉丝数",
        confidence: 60,
      },
      undefined,
      undefined,
      toolContext(db, betId),
    );
    const details = result.details as { draftId?: string; hash?: string };
    assert.ok(details.draftId);
    const row = getPwBet(db, details.draftId!)!;
    assert.equal(row.status, "draft");
    assert.equal(row.created_from, "collab-ai");
    const content = {
      title: row.title,
      thesis: row.thesis,
      metric: row.metric,
      metric_target: row.metric_target,
      confidence: row.confidence,
      data_source_plan: row.data_source_plan,
      checkout_date: row.checkout_date,
      gold_refs: JSON.parse(row.gold_refs_json) as string[],
    };
    const expected = createHash("sha256").update(JSON.stringify(content)).digest("hex");
    assert.equal(details.hash, expected);
    const event = db.prepare(`
      SELECT * FROM pw_runs WHERE kind = 'ai_draft' AND event_type = 'draft'
      ORDER BY created_at DESC LIMIT 1
    `).get() as { actor: string; bet_id: string; payload_json: string };
    assert.equal(event.actor, "ai");
    assert.equal(event.bet_id, details.draftId);
    assert.equal((JSON.parse(event.payload_json) as { hash: string }).hash, expected);
  } finally {
    db.close();
  }
});

test("装配 v2：墓碑 §N 续接、数据文档序列、语料预检命中", () => {
  const db = makeDb();
  try {
    const betId = makeBet(db);
    insertVerdict(db, { id: "gold-1", betId: "g", outcome: "gold", lesson: "开头 30 秒放痛点有效" });
    insertVerdict(db, { id: "tomb-1", betId: "t", outcome: "tomb", causeOfDeath: "无剪辑录屏没人看" });
    insertMirror(db, { id: "m-1", text: "小红书封面大字标题点击率更高", mirroredAt: "2026-07-30T00:00:00Z" });
    createPwDataDoc(db, {
      betId,
      platform: "bilibili",
      metricsJson: JSON.stringify({ play: 12403, retention3s: 0.68 }),
    });
    const { doc } = authorizePwCorpus(db, { bvid: "BV1NprhBPEtR" });
    donePwCorpus(db, doc.id, {
      title: "成片",
      comments: [{ uname: "甲", message: "直播做产品实践这个实验设计得真巧妙", like: 9 }],
    });

    const ctx = buildCollabContext(db, betId);
    assert.ok(ctx.golds.length >= 2, "本域金子 + 镜像金子在列");
    assert.ok(ctx.markdown.includes("§1"));
    const tomb = ctx.tombs.find((item) => item.id === "tomb-1");
    assert.ok(tomb, "墓碑入装配");
    assert.equal(tomb!.ref, `§${ctx.golds.length + 1}`, "墓碑编号在金子后续接");
    assert.match(ctx.markdown, /数据文档/);
    assert.match(ctx.markdown, /12403/);
    assert.match(ctx.markdown, /语料预检/);
    assert.match(ctx.markdown, /BV1NprhBPEtR/);
    assert.ok(ctx.charUsed > 0);
  } finally {
    db.close();
  }
});

test("批准流：corpus proposed→approve→pending；reject→failed；settle approve 不写 pw_verdicts", () => {
  const db = makeDb();
  try {
    const betId = makeBet(db);

    const proposal = proposePwCorpus(db, "BV1NprhBPEtR");
    assert.equal(proposal.status, "proposed");
    assert.equal(listPwCorpusProposed(db).length, 1);
    assert.equal(listPwCorpusPending(db).length, 0);
    const approved = approvePwCorpusProposal(db, proposal.id);
    assert.equal(approved.status, "pending");
    assert.equal(approved.authorized_by, "human");
    assert.deepEqual(listPwCorpusPending(db).map((row) => row.id), [proposal.id]);

    const proposal2 = proposePwCorpus(db, "BV1xx411c7mD");
    const rejected = rejectPwCorpusProposal(db, proposal2.id);
    assert.equal(rejected.status, "failed");
    assert.equal(rejected.error, "人工驳回");
    assert.equal(listPwCorpusPending(db).length, 1);

    const draft = createPwSettleDraft(db, betId, { recommendation: "settle_gold", lesson: "建议的lesson" });
    const before = (db.prepare("SELECT COUNT(*) AS n FROM pw_verdicts").get() as { n: number }).n;
    const approvedDraft = approvePwSettleDraft(db, draft.id);
    assert.equal(approvedDraft.status, "approved");
    const after = (db.prepare("SELECT COUNT(*) AS n FROM pw_verdicts").get() as { n: number }).n;
    assert.equal(after, before, "批准结账草稿不得写入 pw_verdicts");

    const draft2 = createPwSettleDraft(db, betId, { recommendation: "wait" });
    assert.throws(() => rejectPwSettleDraft(db, draft2.id, "  "), /reason 必填/);
    const rejectedDraft = rejectPwSettleDraft(db, draft2.id, "再等等");
    assert.equal(rejectedDraft.status, "rejected");
    assert.equal(rejectedDraft.reject_reason, "再等等");
    assert.equal(listPwSettleDrafts(db).length, 0, "approved/rejected 不进待确认队列");

    const queue = collabPendingQueue(db);
    assert.ok(Array.isArray(queue.betDrafts));
    assert.equal(queue.settleDrafts.length, 0);
    assert.equal(queue.corpusProposed.length, 0);
  } finally {
    db.close();
  }
});

test("消息存取：追加后 GET 正序返回，且按押注隔离", () => {
  const db = makeDb();
  try {
    const betId = makeBet(db);
    const first = appendPwCollabMessage(db, betId, "user", "你好，看看这张押注", "[]");
    const second = appendPwCollabMessage(
      db,
      betId,
      "assistant",
      "收到。",
      JSON.stringify([{ id: "t1", name: "read_bet", args: {} }]),
    );
    db.prepare("UPDATE pw_collab_messages SET created_at = ? WHERE id = ?")
      .run("2026-08-01T00:00:00.000Z", first.id);
    db.prepare("UPDATE pw_collab_messages SET created_at = ? WHERE id = ?")
      .run("2026-08-01T00:00:01.000Z", second.id);

    const messages = listPwCollabMessages(db, betId);
    assert.deepEqual(messages.map((message) => message.id), [first.id, second.id]);
    assert.equal(messages[0].role, "user");
    assert.equal(messages[1].role, "assistant");
    assert.deepEqual(JSON.parse(messages[1].tool_calls_json), [{ id: "t1", name: "read_bet", args: {} }]);

    const otherBetId = makeBet(db, { title: "另一张押注", thesis: "另一假设" });
    assert.equal(listPwCollabMessages(db, otherBetId).length, 0);
    assert.throws(() => appendPwCollabMessage(db, "missing-bet", "user", "x"), /押注不存在/);
  } finally {
    db.close();
  }
});

test("SSE 端到端：POST messages 读 user_saved→…→run_end，assistant 行落库", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pw-collab-"));
  const mock = await startMockModel();
  const originalBaseUrl = process.env.PAPERTABLE_BASE_URL;
  const originalApiKey = process.env.PAPERTABLE_API_KEY;
  const originalModel = process.env.PAPERTABLE_MODEL;
  let app: PapertableApp | undefined;
  try {
    process.env.PAPERTABLE_BASE_URL = `http://127.0.0.1:${mock.port}/v1`;
    process.env.PAPERTABLE_API_KEY = "mock-key";
    process.env.PAPERTABLE_MODEL = "mock-1";
    app = await createApp(dir);
    await new Promise<void>((resolve) => app!.server.listen(0, "127.0.0.1", () => resolve()));
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;

    const betResponse = await fetch(`${base}/api/pw/bets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "协作台押注",
        thesis: "直播系列能成",
        metric: "三期平均播放",
        dataSourcePlan: "B站",
        checkoutDate: "2026-09-01",
        status: "pending",
        confidence: 60,
      }),
    });
    assert.equal(betResponse.status, 201);
    const bet = (await betResponse.json()) as { id: string };
    const betId = bet.id;

    const response = await fetch(`${base}/api/pw/collab/${betId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "看看这张押注怎么推进？" }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    const events = parseSse(body);
    const names = events.map((event) => event.event);
    assert.ok(names.includes("user_saved"), `缺 user_saved：${names.join(",")}`);
    assert.ok(names.includes("answer_delta"), `缺 answer_delta：${names.join(",")}`);
    assert.ok(names.includes("run_end"), `缺 run_end：${names.join(",")}`);
    const runEnd = events.find((event) => event.event === "run_end")!;
    assert.equal(runEnd.data.reason, "done");
    assert.ok(names.lastIndexOf("run_end") > names.indexOf("answer_delta"), "run_end 在流末尾");

    const messagesResponse = await fetch(`${base}/api/pw/collab/${betId}/messages`);
    const messages = ((await messagesResponse.json()) as { messages: Array<{ role: string; text: string }> }).messages;
    assert.equal(messages.length, 2, "user + assistant 各一行");
    assert.equal(messages[0].role, "user");
    assert.equal(messages[1].role, "assistant");
    assert.ok(messages[1].text.length > 0, "assistant 正文落库");
  } finally {
    mock.close();
    if (app) await app.close();
    restoreEnv("PAPERTABLE_BASE_URL", originalBaseUrl);
    restoreEnv("PAPERTABLE_API_KEY", originalApiKey);
    restoreEnv("PAPERTABLE_MODEL", originalModel);
    await rm(dir, { recursive: true, force: true });
  }
});

async function startMockModel(): Promise<{ port: number; close: () => void }> {
  const server: Server = createServer((request, response) => {
    if (request.method !== "POST" || !request.url?.includes("/v1/messages")) {
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      let body: Json = {};
      try {
        body = JSON.parse(raw) as Json;
      } catch {
        // ignore
      }
      const text = [
        "根据注入上下文，这张押注验证三期平均播放，结账日在 2026-09-01，置信度 60%。",
        "建议先挂产出物、等数据回流，再决定结账。",
      ].join("");
      if (body.stream) {
        writeSseAnswer(response, text);
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: "msg_mock",
          type: "message",
          role: "assistant",
          model: "mock-1",
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 40 },
        }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { port, close: () => server.close() };
}

function writeSseAnswer(response: ServerResponse, text: string): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
  });
  const send = (event: string, data: unknown): void => {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send("message_start", {
    type: "message_start",
    message: {
      id: "msg_mock",
      type: "message",
      role: "assistant",
      model: "mock-1",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  send("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  for (let index = 0; index < text.length; index += 20) {
    send("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: text.slice(index, index + 20) },
    });
  }
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 40 },
  });
  send("message_stop", { type: "message_stop" });
  response.end();
}

function parseSse(body: string): Array<{ event: string; data: Json }> {
  const events: Array<{ event: string; data: Json }> = [];
  for (const block of body.split("\n\n")) {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
      // 心跳注释行（: keepalive）跳过
    }
    if (dataLines.length === 0) continue;
    try {
      events.push({ event, data: JSON.parse(dataLines.join("\n")) as Json });
    } catch {
      // ignore malformed
    }
  }
  return events;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
