/**
 * TASK-PW-26 AI 自主档落地（模块侧）测试。
 * 覆盖规格第五节六组：kind 迁移（含 PW-23 时代旧库重建与 foreign_keys 复原）、
 * ai_auto 账、runner 单飞/降级、镜像 actor、确认挂钩、声音挂钩。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { openDataStore, nowIso, type DataStore } from "./data.ts";
import type { PapertableEngine } from "./engine.ts";
import {
  _resetPwCorpusFetchRunnerForTest,
  triggerPwCorpusFetch,
} from "./pw-corpus-fetch-runner.ts";
import { ensurePwGoldMirrorTables, mirrorConfirmedGolds } from "./pw-gold-sync.ts";
import { ensurePwRunTables, listPwRuns, recordPwEvent } from "./pw-runs.ts";
import {
  addPwVoiceItem,
  ensurePwVoiceTables,
  setPwVoiceAutoClassifier,
} from "./pw-voice.ts";
import {
  normalizeVerdictInput,
  type RemoteVerdict,
  type VerdictRemote,
} from "./verdict-memos.ts";
import {
  confirmVerdict,
  ensureVerdictTables,
  onVerdictConfirmed,
  _resetVerdictConfirmedListenersForTest,
} from "./verdicts.ts";

test("迁移：PW-23 时代 CHECK（无 ai_auto）重建，ai_auto 可写、既有行与指令两列全保留、foreign_keys 复原 ON", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE pw_runs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('manual_event','ai_draft','ai_exec','sync','sieve')),
      event_type TEXT NOT NULL CHECK(event_type IN (
        'create','attach','data_doc','draft','confirm','reject','settle','fetch_propose','sieve_run',
        'edit','freeze','voice','classify','drop','mirror','corpus','connection','message','undo'
      )),
      actor TEXT NOT NULL CHECK(actor IN ('human','ai','system')),
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      parent_id TEXT,
      related_ids_json TEXT NOT NULL DEFAULT '[]',
      bet_id TEXT,
      created_at TEXT NOT NULL,
      instruction_text TEXT,
      instruction_message_id TEXT
    );
    CREATE INDEX pw_runs_bet_created ON pw_runs(bet_id, created_at);
    INSERT INTO pw_runs VALUES
      ('hist-1','manual_event','create','human','{"n":1}','hash-1',NULL,'[]','bet-1','2026-08-01T00:00:00.000Z',NULL,NULL),
      ('hist-2','ai_exec','edit','ai','{"n":2}','hash-2',NULL,'[]','bet-1','2026-08-01T00:00:01.000Z','把标题改成 X','msg-9');
  `);
  try {
    ensurePwRunTables(db);

    const definition = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pw_runs'",
    ).get() as { sql: string }).sql;
    assert.ok(definition.includes("ai_auto"), "重建后 kind 枚举含 ai_auto");

    // 既有行全保留，且 PW-23 时代的 instruction 两列数据不丢（数据全量拷贝）
    const hist1 = db.prepare("SELECT * FROM pw_runs WHERE id = 'hist-1'").get() as Record<string, unknown>;
    assert.equal(hist1.kind, "manual_event");
    assert.equal(hist1.instruction_text, null);
    assert.equal(hist1.instruction_message_id, null);
    const hist2 = db.prepare("SELECT * FROM pw_runs WHERE id = 'hist-2'").get() as Record<string, unknown>;
    assert.equal(hist2.kind, "ai_exec");
    assert.equal(hist2.actor, "ai");
    assert.equal(hist2.instruction_text, "把标题改成 X");
    assert.equal(hist2.instruction_message_id, "msg-9");

    // ai_auto 可写入
    const row = recordPwEvent(db, {
      kind: "ai_auto",
      eventType: "corpus",
      actor: "ai",
      payloadJson: JSON.stringify({ bvid: "BV0000000001", triggered: true }),
    });
    assert.equal(row.kind, "ai_auto");

    // foreign_keys 复原为 ON
    const foreignKeys = (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys;
    assert.equal(foreignKeys, 1, "迁移后 foreign_keys 应复原为 ON");

    // 幂等：二次 ensure 不重建
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

test("新库直接建表含 ai_auto", () => {
  const db = new DatabaseSync(":memory:");
  try {
    ensurePwRunTables(db);
    const definition = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pw_runs'",
    ).get() as { sql: string }).sql;
    assert.ok(definition.includes("ai_auto"), "新建表 kind 枚举含 ai_auto");
  } finally {
    db.close();
  }
});

test("ai_auto 账：kind=ai_auto + corpus + actor=ai，指令两列恒 NULL", () => {
  const db = new DatabaseSync(":memory:");
  try {
    ensurePwRunTables(db);
    const row = recordPwEvent(db, {
      kind: "ai_auto",
      eventType: "corpus",
      actor: "ai",
      payloadJson: JSON.stringify({ bvid: "BV0000000001" }),
    });
    assert.equal(row.kind, "ai_auto");
    assert.equal(row.event_type, "corpus");
    assert.equal(row.actor, "ai");
    assert.equal(row.instruction_text, null);
    assert.equal(row.instruction_message_id, null);

    const stored = db.prepare("SELECT * FROM pw_runs WHERE id = ?").get(row.id) as Record<string, unknown>;
    assert.equal(stored.kind, "ai_auto");
    assert.equal(stored.event_type, "corpus");
    assert.equal(stored.actor, "ai");
    assert.equal(stored.instruction_text, null);
    assert.equal(stored.instruction_message_id, null);
    assert.deepEqual(JSON.parse(stored.payload_json as string), { bvid: "BV0000000001" });
  } finally {
    db.close();
  }
});

test("runner：正常触发参数正确、单飞、exit 后复位可再触发", () => {
  _resetPwCorpusFetchRunnerForTest();
  const spawnCalls: Array<{
    command: string;
    args: readonly string[];
    options: { detached: boolean; stdio: "ignore" };
  }> = [];
  const makeChild = () => {
    const emitter = new EventEmitter();
    return {
      unref: () => undefined,
      on: (event: string, listener: (...args: any[]) => void) => {
        emitter.on(event, listener);
        return undefined as unknown;
      },
      emit: (event: string, ...args: unknown[]) => emitter.emit(event, ...args),
    };
  };
  const first = makeChild();
  const scriptPath = "/repo/scripts/pw-fetch-bili-corpus.js";
  const spawnFn = (
    command: string,
    args: readonly string[],
    options: { detached: boolean; stdio: "ignore" },
  ) => {
    spawnCalls.push({ command, args, options });
    return first;
  };
  try {
    assert.deepEqual(triggerPwCorpusFetch({ spawnFn, scriptPath }), { started: true });
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].command, "sh");
    assert.equal(spawnCalls[0].args[0], "-c");
    assert.ok(spawnCalls[0].args[1].includes("ego-browser"));
    assert.ok(spawnCalls[0].args[1].includes("nodejs"));
    assert.ok(spawnCalls[0].args[1].includes(scriptPath));
    assert.equal(spawnCalls[0].options.detached, true);
    assert.equal(spawnCalls[0].options.stdio, "ignore");

    // 二次触发：已在跑
    assert.deepEqual(
      triggerPwCorpusFetch({ spawnFn, scriptPath }),
      { started: false, reason: "already_running" },
    );
    assert.equal(spawnCalls.length, 1, "单飞中不应再次 spawn");

    // 子进程 exit 后复位，可再触发
    first.emit("exit");
    assert.deepEqual(triggerPwCorpusFetch({ spawnFn, scriptPath }), { started: true });
    assert.equal(spawnCalls.length, 2);
  } finally {
    _resetPwCorpusFetchRunnerForTest();
  }
});

test("runner：spawn 抛错降级返回 spawn_failed 且不抛出，running 未卡死", () => {
  _resetPwCorpusFetchRunnerForTest();
  try {
    const failed = triggerPwCorpusFetch({
      spawnFn: () => {
        throw new Error("ego CLI 不在");
      },
      scriptPath: "/repo/scripts/pw-fetch-bili-corpus.js",
    });
    assert.equal(failed.started, false);
    assert.ok((failed.reason ?? "").startsWith("spawn_failed:"), `reason=${failed.reason}`);
    assert.ok((failed.reason ?? "").includes("ego CLI 不在"));

    // 降级后 running 未卡死，下一次可正常触发
    assert.deepEqual(
      triggerPwCorpusFetch({
        spawnFn: () => ({ unref: () => undefined, on: () => undefined }),
        scriptPath: "/repo/scripts/pw-fetch-bili-corpus.js",
      }),
      { started: true },
    );
  } finally {
    _resetPwCorpusFetchRunnerForTest();
  }
});

test("镜像 actor：缺省 human（后路不破），传 system 记 system", () => {
  const db = new DatabaseSync(":memory:");
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
      ('gold-confirmed', 'project-1', 'card-1', 'gold', '确认的金子', '句柄', 'confirmed', '2026-08-04T01:00:00.000Z');
  `);
  try {
    ensurePwGoldMirrorTables(db);
    ensurePwRunTables(db);

    assert.deepEqual(mirrorConfirmedGolds(db), { added: 1, skipped: 0 });
    let rows = listPwRuns(db, { eventType: "mirror" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor, "human");

    assert.deepEqual(mirrorConfirmedGolds(db, { actor: "system" }), { added: 0, skipped: 1 });
    rows = listPwRuns(db, { eventType: "mirror" });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].actor, "system", "listPwRuns 倒序：最新一条是自动镜像");
    assert.equal(rows[0].kind, "manual_event");
    assert.equal(rows[1].actor, "human");
  } finally {
    db.close();
  }
});

test("确认挂钩：confirmVerdict 成功路径触发一次且参数正确", async () => {
  const value = await verdictFixture();
  const memos = memoryRemote();
  const calls: Array<{ db: unknown; verdictId: string }> = [];
  try {
    insertProposedTombstone(value.store);
    onVerdictConfirmed((db, verdictId) => {
      calls.push({ db, verdictId });
    });
    const result = await confirmVerdict(value.store, value.engine, "verdict-1", undefined, memos.remote);
    assert.equal(result.runId, "run-started");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].db, value.store.db);
    assert.equal(calls[0].verdictId, "verdict-1");
  } finally {
    await value.close();
  }
});

test("确认挂钩：监听抛错不影响确认返回", async () => {
  const value = await verdictFixture();
  const memos = memoryRemote();
  try {
    insertProposedTombstone(value.store);
    onVerdictConfirmed(() => {
      throw new Error("镜像挂了");
    });
    const result = await confirmVerdict(value.store, value.engine, "verdict-1", undefined, memos.remote);
    assert.equal(result.runId, "run-started");
    assert.equal(memos.writes, 1, "确认本身仍完成 MemOS 写入");
  } finally {
    await value.close();
  }
});

test("确认挂钩：未确认（superseded）不触发", async () => {
  const value = await verdictFixture();
  const memos = memoryRemote();
  let fired = 0;
  try {
    const now = nowIso();
    value.store.db.prepare(`
      INSERT INTO pt_verdicts(
        id, project_id, card_id, run_id, kind, text, handle, status, memos_status,
        created_at, updated_at, source_kind, source_id, concepts_json, original_text
      ) VALUES('v-superseded', 'p', 'target', NULL, 'tombstone', '已被替代', NULL, 'superseded',
        'pending', ?, ?, 'edge', 'edge-1', '["x"]', '已被替代')
    `).run(now, now);
    onVerdictConfirmed(() => {
      fired += 1;
    });
    await assert.rejects(
      confirmVerdict(value.store, value.engine, "v-superseded", undefined, memos.remote),
      /supersede/,
    );
    assert.equal(fired, 0, "未确认成功不得触发监听");
  } finally {
    await value.close();
  }
});

test("声音挂钩：setPwVoiceAutoClassifier 后录入触发 spy（含 audit 与缺省），spy 抛错不拖垮录入，置 null 不再调", () => {
  const db = new DatabaseSync(":memory:");
  try {
    ensurePwVoiceTables(db);
    ensurePwRunTables(db);
    const calls: Array<{ db: unknown; ids: string[] }> = [];
    setPwVoiceAutoClassifier((voiceDb, ids) => {
      calls.push({ db: voiceDb, ids });
    });

    const a = addPwVoiceItem(db, {
      platform: "bilibili",
      author: "甲",
      content: "想看更多复盘",
      capturedAt: "2026-08-04T00:00:00.000Z",
    });
    const b = addPwVoiceItem(db, {
      platform: "bilibili",
      author: "乙",
      content: "AI 录入的声音",
      capturedAt: "2026-08-04T00:01:00.000Z",
    }, {
      actor: "ai",
      instructionText: "录一条声音",
      instructionMessageId: "msg-1",
    });
    assert.equal(calls.length, 2, "缺省与 audit 两种录入都应触发自动分拣挂钩");
    assert.equal(calls[0].db, db);
    assert.deepEqual(calls[0].ids, [a.id]);
    assert.deepEqual(calls[1].ids, [b.id]);

    // spy 抛错不拖垮录入
    setPwVoiceAutoClassifier(() => {
      throw new Error("分类器挂了");
    });
    const c = addPwVoiceItem(db, {
      platform: "xiaohongshu",
      author: "丙",
      content: "标题太长了",
      capturedAt: "2026-08-04T00:02:00.000Z",
    });
    assert.equal(c.signal_type, null, "分拣失败条目保持未分拣");
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM pw_voice_items").get() as { n: number }).n,
      3,
    );

    // 置 null 后不再调
    setPwVoiceAutoClassifier(null);
    addPwVoiceItem(db, {
      platform: "bilibili",
      author: "丁",
      content: "置空后录入",
      capturedAt: "2026-08-04T00:03:00.000Z",
    });
    assert.equal(calls.length, 2, "置 null 后不再调用分类器");
  } finally {
    setPwVoiceAutoClassifier(null);
    db.close();
  }
});

afterEach(() => {
  _resetVerdictConfirmedListenersForTest();
  _resetPwCorpusFetchRunnerForTest();
});

/** confirmVerdict 挂钩测试夹具（照 verdicts.test.ts 的 fixture 精简）。 */
async function verdictFixture() {
  const directory = await mkdtemp(join(tmpdir(), "pw-autonomous-verdict-"));
  const store = openDataStore(directory);
  ensureVerdictTables(store.db);
  const now = nowIso();
  store.db.prepare(
    "INSERT INTO pt_projects(id, name, created_at, updated_at) VALUES('p', '项目', ?, ?)",
  ).run(now, now);
  store.db.prepare(`
    INSERT INTO pt_cards(
      id, project_id, session_id, title, branch_kind, source_card_id,
      branch_context_json, created_at, updated_at
    ) VALUES('source', 'p', 'session-source', '自动写笔记', 'root', NULL, NULL, ?, ?)
  `).run(now, now);
  store.db.prepare(`
    INSERT INTO pt_cards(
      id, project_id, session_id, title, branch_kind, source_card_id,
      branch_context_json, created_at, updated_at
    ) VALUES('target', 'p', 'session-target', '换方向', 'reroute', 'source', ?, ?, ?)
  `).run(JSON.stringify({ pendingQuestion: "为什么自动写笔记会失败？" }), now, now);
  store.db.prepare(`
    INSERT INTO pt_edges(
      id, project_id, source_card_id, target_card_id, kind, snapshot_json, created_at
    ) VALUES('edge-1', 'p', 'source', 'target', 'reroute', '{}', ?)
  `).run(now);
  const engine = {
    startRun: async () => "run-started",
  } as PapertableEngine;
  return {
    store,
    engine,
    async close() {
      store.db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function insertProposedTombstone(store: DataStore, id = "verdict-1"): void {
  const now = nowIso();
  store.db.prepare(`
    INSERT INTO pt_verdicts(
      id, project_id, card_id, run_id, kind, text, handle, status, memos_status,
      created_at, updated_at, source_kind, source_id, concepts_json, original_text
    ) VALUES(?, 'p', 'target', NULL, 'tombstone', '旧草稿', NULL, 'proposed',
      'not_applicable', ?, ?, 'edge', 'edge-1', '["自动写笔记"]', '旧草稿')
  `).run(id, now, now);
}

/** 本地内存 MemOS remote（照 verdicts.test.ts）。 */
function memoryRemote() {
  const records: RemoteVerdict[] = [];
  let fail = false;
  let writes = 0;
  const remote: VerdictRemote = {
    health: async () => {
      if (fail) throw new Error("offline");
      return { available: true, cubeId: "papertable-verdicts" };
    },
    ensureCube: async () => ({ cubeId: "papertable-verdicts", created: false }),
    list: async (projectId, query) => {
      if (fail) throw new Error("offline");
      const project = records.filter((item) => item.projectId === projectId);
      const superseded = new Set(project.map((item) => item.supersedesMemoryId).filter(Boolean));
      const needle = query?.toLocaleLowerCase();
      const matches = (item: RemoteVerdict) => !needle
        || item.content.toLocaleLowerCase().includes(needle)
        || item.concepts.some((concept) => {
          const value = concept.toLocaleLowerCase();
          return value.includes(needle) || needle.includes(value);
        });
      return {
        history: project.filter(matches),
        verdicts: project.filter((item) => !superseded.has(item.id) && matches(item)),
      };
    },
    confirm: async (input) => {
      if (fail) throw new Error("offline");
      const normalized = normalizeVerdictInput(input);
      const existing = records.find((item) => item.idempotencyKey === normalized.idempotencyKey);
      if (existing) return { verdict: existing, created: false };
      writes += 1;
      const verdict: RemoteVerdict = {
        id: `memory-${records.length + 1}`,
        ...normalized,
        status: "confirmed",
        supersedesMemoryId: null,
      };
      records.push(verdict);
      return { verdict, created: true };
    },
    supersede: async (memoryId, input) => {
      if (fail) throw new Error("offline");
      assert.ok(records.some((item) => item.id === memoryId));
      const normalized = normalizeVerdictInput(input, memoryId);
      const existing = records.find((item) => item.idempotencyKey === normalized.idempotencyKey);
      if (existing) return { verdict: existing, created: false };
      writes += 1;
      const verdict: RemoteVerdict = {
        id: `memory-${records.length + 1}`,
        ...normalized,
        status: "confirmed",
        supersedesMemoryId: memoryId,
      };
      records.push(verdict);
      return { verdict, created: true };
    },
  };
  return {
    remote,
    records,
    get writes() {
      return writes;
    },
    setFail(value: boolean) {
      fail = value;
    },
  };
}
