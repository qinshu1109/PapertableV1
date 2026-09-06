/**
 * TASK-PW-23 审计地基扩容测试。
 * 覆盖规格第三节六组：旧库迁移、白名单矩阵、recordPwExecEvent、
 * 盲区逐点接线（13 个审计事件）、append-only 导出、新 event_type 枚举守卫。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openDataStore } from "./data.ts";
import { createPwBet, ensurePwBetTables } from "./pw-bets.ts";
import { ensurePwArtifactTables } from "./pw-artifacts.ts";
import { ensurePwCollabTables, runCollabTurn } from "./pw-collab.ts";
import {
  authorizePwCorpus,
  donePwCorpus,
  ensurePwCorpusTables,
  failPwCorpus,
  markPwCorpusFetching,
} from "./pw-corpus.ts";
import {
  registerPwConnection,
  setPwConnectionStatus,
  ensurePwConnectionTables,
} from "./pw-connections.ts";
import { ensurePwDataDocTables } from "./pw-data-docs.ts";
import { ensurePwDraftTables } from "./pw-drafts.ts";
import { ensurePwGoldMirrorTables, mirrorConfirmedGolds } from "./pw-gold-sync.ts";
import {
  ensurePwRunTables,
  listPwRuns,
  recordPwEvent,
  recordPwExecEvent,
  type PwEventType,
  type PwRunRow,
} from "./pw-runs.ts";
import { ensurePwSieveTables } from "./pw-sieve.ts";
import { ensurePwVerdictTables } from "./pw-verdicts.ts";
import { ensurePwVerdictRefTables } from "./pw-verdict-refs.ts";
import {
  addPwVoiceItem,
  classifyPwVoiceItems,
  dropPwVoiceItem,
  ensurePwVoiceTables,
} from "./pw-voice.ts";
import { createSessionRepo } from "./sessions.ts";

function makeRunsDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwRunTables(db);
  return db;
}

/** 盲区逐点测试库：写动作模块 + 账本 + mirror 依赖的 pt_verdicts。 */
function auditDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwRunTables(db);
  ensurePwVoiceTables(db);
  ensurePwCorpusTables(db);
  ensurePwConnectionTables(db);
  ensurePwGoldMirrorTables(db);
  db.exec(`
    CREATE TABLE pt_verdicts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      card_id TEXT,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      handle TEXT,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO pt_verdicts VALUES
      ('gold-1', 'project-1', 'card-1', 'gold', '可复用金子', '句柄', 'confirmed', '2026-08-04T00:00:00.000Z');
  `);
  return db;
}

function allRuns(db: DatabaseSync): PwRunRow[] {
  return db.prepare("SELECT * FROM pw_runs ORDER BY created_at, rowid").all() as PwRunRow[];
}

test("迁移：旧 schema 库重建，新列在、历史行保留且指令两列为 NULL", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE pw_runs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('manual_event','ai_draft','sync','sieve')),
      event_type TEXT NOT NULL CHECK(event_type IN (
        'create','attach','data_doc','draft','confirm','reject','settle','fetch_propose','sieve_run'
      )),
      actor TEXT NOT NULL CHECK(actor IN ('human','ai','system')),
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      parent_id TEXT,
      related_ids_json TEXT NOT NULL DEFAULT '[]',
      bet_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX pw_runs_bet_created ON pw_runs(bet_id, created_at);
    INSERT INTO pw_runs VALUES
      ('hist-1','manual_event','create','human','{"n":1}','hash-1',NULL,'[]','bet-1','2026-08-01T00:00:00.000Z'),
      ('hist-2','sync','data_doc','system','{"n":2}','hash-2',NULL,'[]','bet-1','2026-08-01T00:00:01.000Z');
  `);
  try {
    ensurePwRunTables(db);

    const names = (db.prepare("PRAGMA table_info(pw_runs)").all() as Array<{ name: string }>)
      .map(({ name }) => name);
    assert.ok(names.includes("instruction_text"));
    assert.ok(names.includes("instruction_message_id"));

    const definition = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pw_runs'",
    ).get() as { sql: string }).sql;
    assert.ok(definition.includes("ai_exec"), "重建后 kind 枚举含 ai_exec");
    assert.ok(definition.includes("'message'"), "重建后 event_type 枚举含 message");

    const hist1 = db.prepare("SELECT * FROM pw_runs WHERE id = 'hist-1'").get() as PwRunRow;
    const hist2 = db.prepare("SELECT * FROM pw_runs WHERE id = 'hist-2'").get() as PwRunRow;
    assert.equal(hist1.kind, "manual_event");
    assert.equal(hist1.instruction_text, null);
    assert.equal(hist1.instruction_message_id, null);
    assert.equal(hist2.kind, "sync");
    assert.equal(hist2.instruction_text, null);
    assert.equal(hist2.instruction_message_id, null);

    // 新枚举与 ai_exec 在新表可插
    const exec = recordPwExecEvent(db, {
      eventType: "edit",
      instructionText: "把标题改一下",
      instructionMessageId: "msg-9",
      payloadJson: "{}",
    });
    assert.equal(exec.kind, "ai_exec");
    recordPwEvent(db, { eventType: "voice", payload_json: "{}" });

    // 幂等：二次 ensure 不重建（检测条件命中，直接跳过）
    const before = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pw_runs'",
    ).get() as { sql: string }).sql;
    ensurePwRunTables(db);
    const after = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pw_runs'",
    ).get() as { sql: string }).sql;
    assert.equal(before, after, "二次 ensure 不应重建表");
  } finally {
    db.close();
  }
});

test("(actor, kind) 白名单矩阵：非法组合拒、白名单组合收", () => {
  const db = makeRunsDb();
  const base = { bet_id: "bet-1", payload_json: "{}" };
  try {
    // 拒
    assert.throws(() => recordPwEvent(db, { ...base, kind: "ai_exec", actor: "human" }), /actor=human/);
    assert.throws(() => recordPwEvent(db, { ...base, kind: "sync", actor: "human" }), /actor=human/);
    assert.throws(() => recordPwEvent(db, { ...base, kind: "sieve", actor: "human" }), /actor=human/);
    assert.throws(() => recordPwEvent(db, { ...base, kind: "ai_exec", actor: "system" }), /actor=system/);
    assert.throws(() => recordPwEvent(db, { ...base, kind: "ai_draft", actor: "system" }), /actor=system/);
    assert.throws(() => recordPwEvent(db, { ...base, kind: "sync", actor: "ai" }), /actor=ai/);
    assert.throws(() => recordPwEvent(db, { ...base, kind: "sieve", actor: "ai" }), /actor=ai/);
    // ai + manual_event + 非 message 拒（白名单唯一例外的反面）
    assert.throws(() => recordPwEvent(db, { ...base, kind: "manual_event", actor: "ai", event_type: "confirm" }), /actor=ai/);

    // 收
    recordPwEvent(db, { ...base, event_type: "create" }); // human + manual_event
    recordPwEvent(db, { ...base, kind: "manual_event", event_type: "message", actor: "ai" }); // 唯一例外
    recordPwEvent(db, { ...base, kind: "sync", event_type: "data_doc", actor: "system" });
    recordPwEvent(db, { ...base, kind: "sieve", event_type: "sieve_run", actor: "system" });
    recordPwEvent(db, { ...base, kind: "ai_draft", event_type: "draft", actor: "ai" });
    recordPwEvent(db, { ...base, kind: "ai_exec", event_type: "edit", actor: "ai" });

    assert.deepEqual(
      allRuns(db).map((row) => `${row.actor}:${row.kind}`).sort(),
      [
        "ai:ai_draft",
        "ai:ai_exec",
        "ai:manual_event",
        "human:manual_event",
        "system:sieve",
        "system:sync",
      ].sort(),
    );
  } finally {
    db.close();
  }
});

test("recordPwExecEvent：缺指令引用即拒，齐备落 ai_exec 行且两列正确", () => {
  const db = makeRunsDb();
  try {
    assert.throws(
      () => recordPwExecEvent(db, { eventType: "edit", instructionMessageId: "msg-1", payloadJson: "{}" }),
      /instructionText/,
    );
    assert.throws(
      () => recordPwExecEvent(db, { eventType: "edit", instructionText: "改一下", payloadJson: "{}" }),
      /instructionMessageId/,
    );

    const row = recordPwExecEvent(db, {
      eventType: "edit",
      betId: "bet-1",
      instructionText: "把标题改成 X",
      instructionMessageId: "msg-9",
      payloadJson: JSON.stringify({ betId: "bet-1", fields: { title: "X" } }),
    });
    assert.equal(row.kind, "ai_exec");
    assert.equal(row.actor, "ai");
    assert.equal(row.event_type, "edit");
    assert.equal(row.instruction_text, "把标题改成 X");
    assert.equal(row.instruction_message_id, "msg-9");
    assert.equal(
      row.payload_hash,
      createHash("sha256").update(row.payload_json, "utf8").digest("hex"),
    );

    const stored = db.prepare("SELECT * FROM pw_runs WHERE id = ?").get(row.id) as PwRunRow;
    assert.equal(stored.instruction_text, "把标题改成 X");
    assert.equal(stored.instruction_message_id, "msg-9");
  } finally {
    db.close();
  }
});

test("盲区逐点：voice/corpus/connection/mirror 模块内落账（12 函数 → 13 条审计事件）", async () => {
  const db = auditDb();
  try {
    // ① 观众声音录入（voice / human）
    const v1 = addPwVoiceItem(db, {
      platform: "B站",
      content: "建议加一版分镜",
      capturedAt: "2026-08-04T00:00:00.000Z",
      author: "观众甲",
      artifactId: "art-1",
    });
    // ② 分拣（classify / system）
    await classifyPwVoiceItems(db, [v1.id], async () => JSON.stringify([
      { id: v1.id, signal_type: "form_suggestion", cluster: "分镜" },
    ]));
    // ③ 丢弃（drop / human）
    dropPwVoiceItem(db, v1.id, "与主线无关");
    // ④ 语料授权（corpus / human）
    const { doc: c1 } = authorizePwCorpus(db, { bvid: "BV0000000001" });
    // ⑤ 抓取开工（corpus / system）
    markPwCorpusFetching(db, c1.id);
    // ⑥ 抓取完成（corpus / system）
    donePwCorpus(db, c1.id, { title: "科普视频", comments: [{ message: "这个实验设计不错" }] });
    // ⑦ 失败路径（corpus / system）：另授权一条再 fail
    const { doc: c2 } = authorizePwCorpus(db, { bvid: "BV0000000002" });
    markPwCorpusFetching(db, c2.id);
    failPwCorpus(db, c2.id, { status: "needs_human", error: "撞风控" });
    // ⑧ 连接登记（connection / human）
    const conn = registerPwConnection(db, { platform: "B站" });
    // ⑨ 状态置 needs_human（connection / system）
    setPwConnectionStatus(db, conn.id, "needs_human", "验证码墙");
    // ⑩ 状态恢复 active（connection / human）
    setPwConnectionStatus(db, conn.id, "active");
    // ⑪ 金子镜像（mirror / human）
    mirrorConfirmedGolds(db);

    const rows = allRuns(db);
    assert.equal(rows.length, 13, `应落 13 条审计事件，实际 ${rows.length}`);

    const byType = (eventType: string) =>
      rows.filter((row) => row.event_type === eventType);

    // voice
    const voiceRows = byType("voice");
    assert.equal(voiceRows.length, 1);
    assert.equal(voiceRows[0].actor, "human");
    const voicePayload = JSON.parse(voiceRows[0].payload_json) as {
      voiceId: string;
      artifactId: string | null;
      platform: string;
    };
    assert.equal(voicePayload.voiceId, v1.id);
    assert.equal(voicePayload.artifactId, "art-1");
    assert.equal(voicePayload.platform, "B站");

    // classify
    const classifyRows = byType("classify");
    assert.equal(classifyRows.length, 1);
    assert.equal(classifyRows[0].actor, "system");
    assert.deepEqual(JSON.parse(classifyRows[0].payload_json), { classified: 1, failed: 0 });

    // drop
    const dropRows = byType("drop");
    assert.equal(dropRows.length, 1);
    assert.equal(dropRows[0].actor, "human");
    assert.deepEqual(JSON.parse(dropRows[0].payload_json), { voiceId: v1.id, reason: "与主线无关" });

    // corpus：授权×2（新建分支）、开工×2、完成×1、失败×1
    const corpusRows = byType("corpus");
    assert.equal(corpusRows.length, 6);
    assert.ok(corpusRows.every((row) => row.actor === "human" || row.actor === "system"));
    const authorize1 = JSON.parse(corpusRows[0].payload_json) as {
      corpusId: string;
      bvid: string;
      status: string;
      force: boolean;
    };
    assert.equal(corpusRows[0].actor, "human");
    assert.equal(authorize1.corpusId, c1.id);
    assert.equal(authorize1.bvid, "BV0000000001");
    assert.equal(authorize1.status, "pending");
    assert.equal(authorize1.force, false);
    const fetching1 = JSON.parse(corpusRows[1].payload_json) as { status: string; bvid: string };
    assert.equal(corpusRows[1].actor, "system");
    assert.equal(fetching1.status, "fetching");
    assert.equal(fetching1.bvid, "BV0000000001");
    const done = JSON.parse(corpusRows[2].payload_json) as {
      corpusId: string;
      status: string;
      comment_count: number;
    };
    assert.equal(corpusRows[2].actor, "system");
    assert.equal(done.corpusId, c1.id);
    assert.equal(done.status, "done");
    assert.equal(done.comment_count, 1);
    const fail = JSON.parse(corpusRows[5].payload_json) as {
      corpusId: string;
      bvid: string;
      status: string;
      error: string | null;
    };
    assert.equal(corpusRows[5].actor, "system");
    assert.equal(fail.corpusId, c2.id);
    assert.equal(fail.status, "needs_human");
    assert.equal(fail.error, "撞风控");

    // connection：登记 + 两分支状态变更
    const connectionRows = byType("connection");
    assert.equal(connectionRows.length, 3);
    const connRegister = JSON.parse(connectionRows[0].payload_json) as {
      connectionId: string;
      platform: string;
      status: string;
    };
    assert.equal(connectionRows[0].actor, "human");
    assert.equal(connRegister.connectionId, conn.id);
    assert.equal(connRegister.platform, "B站");
    assert.equal(connRegister.status, "active");
    const needsHuman = JSON.parse(connectionRows[1].payload_json) as { status: string };
    assert.equal(connectionRows[1].actor, "system", "needs_human 交人记 system");
    assert.equal(needsHuman.status, "needs_human");
    const active = JSON.parse(connectionRows[2].payload_json) as { status: string };
    assert.equal(connectionRows[2].actor, "human", "其余状态变更记 human");
    assert.equal(active.status, "active");

    // mirror
    const mirrorRows = byType("mirror");
    assert.equal(mirrorRows.length, 1);
    assert.equal(mirrorRows[0].actor, "human");
    assert.deepEqual(JSON.parse(mirrorRows[0].payload_json), { inserted: 1, total: 1 });
  } finally {
    db.close();
  }
});

test("盲区逐点：协作台消息落账（user→human，assistant→ai 唯一例外）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pw-audit-collab-"));
  const store = openDataStore(dir);
  const mock = await startMockModel();
  const originalBaseUrl = process.env.PAPERTABLE_BASE_URL;
  const originalApiKey = process.env.PAPERTABLE_API_KEY;
  const originalModel = process.env.PAPERTABLE_MODEL;
  try {
    ensurePwBetTables(store.db);
    ensurePwArtifactTables(store.db);
    ensurePwDataDocTables(store.db);
    ensurePwVerdictTables(store.db);
    ensurePwGoldMirrorTables(store.db);
    ensurePwVoiceTables(store.db);
    ensurePwDraftTables(store.db);
    ensurePwRunTables(store.db);
    ensurePwConnectionTables(store.db);
    ensurePwCorpusTables(store.db);
    ensurePwCollabTables(store.db);
    ensurePwSieveTables(store.db);
    ensurePwVerdictRefTables(store.db);
    const sessions = createSessionRepo(store);

    process.env.PAPERTABLE_BASE_URL = `http://127.0.0.1:${mock.port}/v1`;
    process.env.PAPERTABLE_API_KEY = "mock-key";
    process.env.PAPERTABLE_MODEL = "mock-1";

    const bet = createPwBet(store.db, {
      title: "协作台押注",
      thesis: "直播系列能成",
      metric: "三期平均播放",
      dataSourcePlan: "B站",
      checkoutDate: "2026-09-01",
      status: "pending",
      confidence: 60,
    });

    const result = await runCollabTurn(
      { db: store.db, sessions },
      bet.id,
      "请推进这张押注",
      async () => undefined,
    );
    assert.equal(result.ok, true, `协作台回合应成功：${result.error ?? ""}`);

    const messageRows = store.db.prepare(
      "SELECT * FROM pw_runs WHERE event_type = 'message' ORDER BY created_at, rowid",
    ).all() as PwRunRow[];
    assert.equal(messageRows.length, 2, "user + assistant 各一条 message 审计行");

    const userRow = messageRows[0];
    assert.equal(userRow.actor, "human");
    assert.equal(userRow.kind, "manual_event");
    const userPayload = JSON.parse(userRow.payload_json) as {
      betId: string;
      messageId: string;
      role: string;
      len: number;
    };
    assert.equal(userPayload.betId, bet.id);
    assert.equal(userPayload.role, "user");
    assert.equal(userPayload.len, "请推进这张押注".length);
    assert.equal(
      (store.db.prepare("SELECT COUNT(*) AS n FROM pw_collab_messages WHERE id = ?")
        .get(userPayload.messageId) as { n: number }).n,
      1,
      "messageId 弱引用 pw_collab_messages 行",
    );

    const assistantRow = messageRows[1];
    assert.equal(assistantRow.actor, "ai");
    assert.equal(assistantRow.kind, "manual_event", "assistant 消息走白名单唯一例外");
    const assistantPayload = JSON.parse(assistantRow.payload_json) as {
      betId: string;
      messageId: string;
      role: string;
      len: number;
    };
    assert.equal(assistantPayload.betId, bet.id);
    assert.equal(assistantPayload.role, "assistant");
    assert.ok(assistantPayload.len > 0);
  } finally {
    mock.close();
    restoreEnv("PAPERTABLE_BASE_URL", originalBaseUrl);
    restoreEnv("PAPERTABLE_API_KEY", originalApiKey);
    restoreEnv("PAPERTABLE_MODEL", originalModel);
    store.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("append-only：pw-runs 模块不暴露任何 update/delete 导出", () => {
  const source = readFileSync(new URL("./pw-runs.ts", import.meta.url), "utf8");
  const exported = [...source.matchAll(/^export function (\w+)/gm)].map((match) => match[1]).sort();
  assert.deepEqual(exported, [
    "ensurePwRunTables",
    "getPwActivityDaily",
    "getPwBetTimeline",
    "listPwRuns",
    "recordPwEvent",
    "recordPwExecEvent",
  ]);
  for (const name of exported) {
    assert.doesNotMatch(name, /^(update|delete|remove|drop|set)/i, `${name} 不应是修改/删除 pw_runs 的导出`);
  }
});

test("新 event_type：10 个新增枚举可收，非法值仍拒", () => {
  const db = makeRunsDb();
  try {
    const added: PwEventType[] = [
      "edit",
      "freeze",
      "voice",
      "classify",
      "drop",
      "mirror",
      "corpus",
      "connection",
      "message",
      "undo",
    ];
    for (const eventType of added) {
      recordPwEvent(db, { event_type: eventType, payload_json: "{}" });
    }
    assert.throws(
      () => recordPwEvent(db, { event_type: "bogus", payload_json: "{}" }),
      /非法 event_type/,
    );
    assert.throws(
      () => listPwRuns(db, { eventType: "bogus" as PwEventType }),
      /非法 event_type/,
    );
    assert.equal(allRuns(db).length, 10);
  } finally {
    db.close();
  }
});

/** 本地 mock Anthropic /v1/messages 流式服务（照 pw-collab.test.ts 的 SSE 事件序列）。 */
function startMockModel(): Promise<{ port: number; close: () => void }> {
  const server: Server = createServer((request, response) => {
    if (request.method !== "POST" || !request.url?.includes("/v1/messages")) {
      response.writeHead(404).end();
      return;
    }
    request.resume();
    const text = "收到，建议先挂产出物、等数据回流，再决定结账。";
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
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
