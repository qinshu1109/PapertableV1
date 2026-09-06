/**
 * TASK-PW-30：引用落库与弹药架测试（内存库自包含 + mock provider 端到端）。
 * 覆盖：ensure 幂等与结构、parseSectionMarkers、pwCollabRefTable 合成、
 * record 命中/伪造丢弃/唯一索引幂等、混合编号表、listPwAmmoShelf（计数/时间/倒序/源行删除）、
 * listPwVerdictRefLog 升序、collab 端到端（assistant 带 §1 落库、user 带 §1 不落库）。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openDataStore } from "./data.ts";
import { createPwBet, ensurePwBetTables } from "./pw-bets.ts";
import { ensurePwArtifactTables } from "./pw-artifacts.ts";
import { ensurePwCollabTables, runCollabTurn } from "./pw-collab.ts";
import { ensurePwConnectionTables } from "./pw-connections.ts";
import { ensurePwCorpusTables } from "./pw-corpus.ts";
import { ensurePwDataDocTables } from "./pw-data-docs.ts";
import { ensurePwDraftTables } from "./pw-drafts.ts";
import { ensurePwGoldMirrorTables } from "./pw-gold-sync.ts";
import { buildCollabContext, type PwCollabContext } from "./pw-context.ts";
import { ensurePwRunTables } from "./pw-runs.ts";
import { ensurePwSieveTables } from "./pw-sieve.ts";
import { ensurePwVerdictTables } from "./pw-verdicts.ts";
import { ensurePwVoiceTables } from "./pw-voice.ts";
import { createSessionRepo, type SessionRepo } from "./sessions.ts";
import {
  ensurePwVerdictRefTables,
  listPwAmmoShelf,
  listPwVerdictRefLog,
  parseSectionMarkers,
  pwCollabRefTable,
  recordPwVerdictRefs,
  type AmmoRow,
  type PwVerdictRefRow,
  type RefTableItem,
} from "./pw-verdict-refs.ts";

type Json = Record<string, unknown>;

// ---- 单元测试夹具：pw_verdicts / pw_gold_mirror / pw_verdict_refs ----

function makeUnitDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwVerdictTables(db);
  ensurePwGoldMirrorTables(db);
  ensurePwVerdictRefTables(db);
  return db;
}

function seedGold(db: DatabaseSync, input: { id: string; lesson: string }): void {
  db.prepare(`
    INSERT INTO pw_verdicts(
      id, bet_id, outcome, lesson, cause_of_death, evidence_doc_ids_json,
      confidence_snapshot, decided_by, decided_at, created_at
    ) VALUES(?, ?, 'gold', ?, NULL, '[]', NULL, 'human', ?, ?)
  `).run(input.id, `bet-${input.id}`, input.lesson, "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z");
}

function seedTomb(db: DatabaseSync, input: { id: string; causeOfDeath: string }): void {
  db.prepare(`
    INSERT INTO pw_verdicts(
      id, bet_id, outcome, lesson, cause_of_death, evidence_doc_ids_json,
      confidence_snapshot, decided_by, decided_at, created_at
    ) VALUES(?, ?, 'tomb', NULL, ?, '[]', NULL, 'human', ?, ?)
  `).run(input.id, `bet-${input.id}`, input.causeOfDeath, "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z");
}

function seedMirror(db: DatabaseSync, input: { id: string; text: string }): void {
  db.prepare(`
    INSERT INTO pw_gold_mirror(
      id, source_verdict_id, kind, text, handle, project_id, card_id, confirmed_at, mirrored_at
    ) VALUES(?, ?, 'gold', ?, NULL, NULL, NULL, NULL, ?)
  `).run(input.id, input.id, input.text, "2026-07-30T00:00:00Z");
}

function refCount(db: DatabaseSync): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM pw_verdict_refs").get() as { n: number }).n);
}

// ---- 端到端夹具：临时数据目录 + 全表 ensure + mock provider ----

async function makeE2eDb(dir: string): Promise<{ db: DatabaseSync; sessions: SessionRepo }> {
  const store = openDataStore(dir);
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
  return { db: store.db, sessions: createSessionRepo(store) };
}

function makeBet(db: DatabaseSync, overrides: Json = {}): string {
  return createPwBet(db, {
    title: "直播做产品实践",
    thesis: "直播系列能成",
    metric: "三期平均播放 ≥ 5000",
    metricTarget: ">= 5000",
    dataSourcePlan: "B站",
    checkoutDate: "2026-09-01",
    confidence: 70,
    status: "pending",
    ...overrides,
  }).id;
}

function startMockModel(): Promise<{ port: number; answer: (text: string) => void; close: () => void }> {
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
      const text = nextAnswer;
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
  let nextAnswer = "";
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ port, answer: (text) => { nextAnswer = text; }, close: () => server.close() });
    });
  });
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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

// ---- 测试清单 ----

test("1. ensure 幂等（两次调用）+ 列/索引/CHECK 结构断言", () => {
  const db = new DatabaseSync(":memory:");
  try {
    ensurePwVerdictRefTables(db);
    ensurePwVerdictRefTables(db);
    const columns = (db.prepare("PRAGMA table_info(pw_verdict_refs)").all() as Array<{
      name: string;
      notnull: number;
      pk: number;
    }>);
    assert.deepEqual(
      columns.map((column) => column.name),
      ["id", "verdict_id", "verdict_source", "verdict_kind", "source_kind", "source_id", "marker", "created_at"],
    );
    // SQLite 对非 INTEGER 的 PRIMARY KEY 列在 table_info 里 notnull=0，跳过主键列单独断言
    for (const column of columns) {
      if (column.pk === 1) continue;
      assert.equal(column.notnull, 1, `${column.name} 应 NOT NULL`);
    }
    assert.equal(columns.find((column) => column.name === "id")?.pk, 1, "id 应为主键");
    const indexes = db.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'pw_verdict_refs'
    `).all() as Array<{ name: string; sql: string | null }>;
    const byName = new Map(indexes.map((index) => [index.name, index.sql ?? ""]));
    assert.equal(byName.has("pw_verdict_refs_dedup"), true, "应有去重唯一索引");
    assert.equal(byName.has("pw_verdict_refs_by_verdict"), true, "应有按 verdict 索引");
    assert.match(byName.get("pw_verdict_refs_dedup") ?? "", /UNIQUE/);
    const tableSql = (db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pw_verdict_refs'
    `).get() as { sql: string }).sql;
    assert.match(tableSql, /verdict_source IN \('paperweight','papertable'\)/);
    assert.match(tableSql, /verdict_kind IN \('gold','tomb'\)/);
    assert.match(tableSql, /source_kind IN \('collab_message','content_draft'\)/);
  } finally {
    db.close();
  }
});

test("2. parseSectionMarkers：多标注按序去重；无标注空数组；§ 后非数字不命中", () => {
  assert.deepEqual(parseSectionMarkers("先看 §1，再看 §3 和 §1"), ["§1", "§3"]);
  assert.deepEqual(parseSectionMarkers("没有任何标注"), []);
  assert.deepEqual(parseSectionMarkers("§a § 1 §x §一"), []);
  assert.deepEqual(parseSectionMarkers("§1§2§10"), ["§1", "§2", "§10"]);
  assert.deepEqual(parseSectionMarkers(""), []);
});

test("3. record 命中编号表：行字段全对（verdict_id/source/kind/marker/source_kind/source_id）", () => {
  const db = makeUnitDb();
  try {
    seedGold(db, { id: "gold-1", lesson: "开头 30 秒放痛点有效" });
    const refTable: RefTableItem[] = [{ ref: "§1", id: "gold-1", source: "paperweight", kind: "gold" }];
    const result = recordPwVerdictRefs(db, {
      sourceKind: "collab_message",
      sourceId: "msg-assistant-1",
      text: "参考了 §1。",
      refTable,
    });
    assert.deepEqual(result, { inserted: 1, dropped: [] });
    const rows = db.prepare("SELECT * FROM pw_verdict_refs").all() as PwVerdictRefRow[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].verdict_id, "gold-1");
    assert.equal(rows[0].verdict_source, "paperweight");
    assert.equal(rows[0].verdict_kind, "gold");
    assert.equal(rows[0].source_kind, "collab_message");
    assert.equal(rows[0].source_id, "msg-assistant-1");
    assert.equal(rows[0].marker, "§1");
    assert.ok(rows[0].created_at, "created_at 应落库");
  } finally {
    db.close();
  }
});

test("4. 伪造标注 §99（编号表外）：dropped 收集、不入库", () => {
  const db = makeUnitDb();
  try {
    seedGold(db, { id: "gold-1", lesson: "x" });
    const refTable: RefTableItem[] = [{ ref: "§1", id: "gold-1", source: "paperweight", kind: "gold" }];
    const result = recordPwVerdictRefs(db, {
      sourceKind: "collab_message",
      sourceId: "m1",
      text: "参考 §99 和 §1",
      refTable,
    });
    assert.deepEqual(result, { inserted: 1, dropped: ["§99"] });
    const rows = (db.prepare("SELECT verdict_id, marker FROM pw_verdict_refs").all() as Array<{
      verdict_id: string;
      marker: string;
    }>).map((row) => ({ ...row }));
    assert.deepEqual(rows, [{ verdict_id: "gold-1", marker: "§1" }]);
  } finally {
    db.close();
  }
});

test("5. 幂等：同 source 重复 record → 唯一索引去重，计数不变", () => {
  const db = makeUnitDb();
  try {
    seedGold(db, { id: "gold-1", lesson: "x" });
    const refTable: RefTableItem[] = [{ ref: "§1", id: "gold-1", source: "paperweight", kind: "gold" }];
    const first = recordPwVerdictRefs(db, { sourceKind: "collab_message", sourceId: "m1", text: "§1", refTable });
    assert.deepEqual(first, { inserted: 1, dropped: [] });
    const second = recordPwVerdictRefs(db, {
      sourceKind: "collab_message",
      sourceId: "m1",
      text: "§1 再说一次 §1",
      refTable,
    });
    assert.deepEqual(second, { inserted: 0, dropped: [] });
    assert.equal(refCount(db), 1, "同 source 重复标注不得重复计数");
    const third = recordPwVerdictRefs(db, { sourceKind: "collab_message", sourceId: "m2", text: "§1", refTable });
    assert.deepEqual(third, { inserted: 1, dropped: [] });
    assert.equal(refCount(db), 2, "不同 source 可再落一笔");
  } finally {
    db.close();
  }
});

test("6. 混合编号表：§1=gold(own)、§2=gold(mirror)、§3=tomb → 各行 source/kind 各对", () => {
  const db = makeUnitDb();
  try {
    seedGold(db, { id: "gold-1", lesson: "own 教训" });
    seedMirror(db, { id: "mirror-1", text: "镜像金句" });
    seedTomb(db, { id: "tomb-1", causeOfDeath: "无剪辑录屏没人看" });
    const refTable: RefTableItem[] = [
      { ref: "§1", id: "gold-1", source: "paperweight", kind: "gold" },
      { ref: "§2", id: "mirror-1", source: "papertable", kind: "gold" },
      { ref: "§3", id: "tomb-1", source: "paperweight", kind: "tomb" },
    ];
    const result = recordPwVerdictRefs(db, { sourceKind: "collab_message", sourceId: "m1", text: "§1 §2 §3", refTable });
    assert.deepEqual(result, { inserted: 3, dropped: [] });
    const rows = (db.prepare(`
      SELECT verdict_id, verdict_source, verdict_kind, marker FROM pw_verdict_refs
    `).all() as Array<{ verdict_id: string; verdict_source: string; verdict_kind: string; marker: string }>)
      .map((row) => ({ ...row }));
    const byMarker = new Map(rows.map((row) => [row.marker, row]));
    assert.deepEqual(byMarker.get("§1"), { verdict_id: "gold-1", verdict_source: "paperweight", verdict_kind: "gold", marker: "§1" });
    assert.deepEqual(byMarker.get("§2"), { verdict_id: "mirror-1", verdict_source: "papertable", verdict_kind: "gold", marker: "§2" });
    assert.deepEqual(byMarker.get("§3"), { verdict_id: "tomb-1", verdict_source: "paperweight", verdict_kind: "tomb", marker: "§3" });
  } finally {
    db.close();
  }
});

test("6b. pwCollabRefTable：golds/tombs 合成编号表（tomb source 恒 paperweight）", () => {
  const ctx: PwCollabContext = {
    markdown: "",
    charUsed: 0,
    golds: [
      { ref: "§1", id: "g1", source: "paperweight", text: "a" },
      { ref: "§2", id: "g2", source: "papertable", text: "b" },
    ],
    tombs: [{ ref: "§3", id: "t1", causeOfDeath: "c" }],
  };
  assert.deepEqual(pwCollabRefTable(ctx), [
    { ref: "§1", id: "g1", source: "paperweight", kind: "gold" },
    { ref: "§2", id: "g2", source: "papertable", kind: "gold" },
    { ref: "§3", id: "t1", source: "paperweight", kind: "tomb" },
  ]);
});

test("7. listPwAmmoShelf：计数与首末时间正确、未引用的不出现、last_used_at 倒序", () => {
  const db = makeUnitDb();
  try {
    seedGold(db, { id: "gold-a", lesson: "金 A 教训" });
    seedGold(db, { id: "gold-b", lesson: "金 B 教训" });
    seedGold(db, { id: "gold-c", lesson: "从未被引用的金 C" });
    seedTomb(db, { id: "tomb-x", causeOfDeath: "墓碑 X" });
    seedMirror(db, { id: "mirror-y", text: "镜像 Y" });
    const refTable: RefTableItem[] = [
      { ref: "§1", id: "gold-a", source: "paperweight", kind: "gold" },
      { ref: "§2", id: "gold-b", source: "paperweight", kind: "gold" },
      { ref: "§3", id: "tomb-x", source: "paperweight", kind: "tomb" },
      { ref: "§4", id: "mirror-y", source: "papertable", kind: "gold" },
    ];
    recordPwVerdictRefs(db, { sourceKind: "collab_message", sourceId: "m1", text: "§1 §2 §3 §4", refTable });
    recordPwVerdictRefs(db, { sourceKind: "collab_message", sourceId: "m2", text: "§1 §3", refTable });
    // 校准时间轴保证倒序断言确定性：m2（gold-a/tomb-x）晚于 m1
    db.prepare("UPDATE pw_verdict_refs SET created_at = '2026-08-01T00:00:00Z' WHERE source_id = 'm1'").run();
    db.prepare("UPDATE pw_verdict_refs SET created_at = '2026-08-02T00:00:00Z' WHERE source_id = 'm2'").run();

    const shelf = listPwAmmoShelf(db);
    assert.equal(shelf.length, 4, "gold-c 未被引用不得出现");
    assert.ok(!shelf.some((row) => row.verdict_id === "gold-c"));
    // last_used_at 倒序：gold-a/tomb-x(08-02) 在前，gold-b/mirror-y(08-01) 在后（同刻按 id 稳定）
    assert.deepEqual(
      shelf.map((row) => row.verdict_id),
      ["gold-a", "tomb-x", "gold-b", "mirror-y"],
    );
    const a = shelf.find((row) => row.verdict_id === "gold-a")!;
    assert.equal(a.text, "金 A 教训");
    assert.equal(a.verdict_source, "paperweight");
    assert.equal(a.verdict_kind, "gold");
    assert.equal(a.ref_count, 2);
    assert.equal(a.first_used_at, "2026-08-01T00:00:00Z");
    assert.equal(a.last_used_at, "2026-08-02T00:00:00Z");
    const b = shelf.find((row) => row.verdict_id === "gold-b")!;
    assert.equal(b.ref_count, 1);
    assert.equal(b.first_used_at, "2026-08-01T00:00:00Z");
    assert.equal(b.last_used_at, "2026-08-01T00:00:00Z");
    const x = shelf.find((row) => row.verdict_id === "tomb-x")!;
    assert.equal(x.text, "墓碑 X");
    assert.equal(x.verdict_kind, "tomb");
    const y = shelf.find((row) => row.verdict_id === "mirror-y")!;
    assert.equal(y.text, "镜像 Y");
    assert.equal(y.verdict_source, "papertable");
  } finally {
    db.close();
  }
});

test("7b. listPwAmmoShelf：源行已删 → text=null 仍列出", () => {
  const db = makeUnitDb();
  try {
    seedGold(db, { id: "gold-a", lesson: "教训" });
    seedMirror(db, { id: "mirror-y", text: "镜像" });
    const refTable: RefTableItem[] = [
      { ref: "§1", id: "gold-a", source: "paperweight", kind: "gold" },
      { ref: "§2", id: "mirror-y", source: "papertable", kind: "gold" },
    ];
    recordPwVerdictRefs(db, { sourceKind: "collab_message", sourceId: "m1", text: "§1 §2", refTable });
    db.prepare("DELETE FROM pw_verdicts WHERE id = 'gold-a'").run();
    db.prepare("DELETE FROM pw_gold_mirror WHERE id = 'mirror-y'").run();
    const shelf = listPwAmmoShelf(db);
    assert.equal(shelf.length, 2, "源行删除后引用仍列出（text=null）");
    // 两条引用同一次调用逐行 nowIso()，跨毫秒边界时 last_used_at 不同会翻转顺序——
    // 本用例只考「源行删除后仍列出且 text=null」，按 id 定位断言（顺序由 7 用例考）
    const gold = shelf.find((row) => row.verdict_id === "gold-a")!;
    assert.equal(gold.text, null);
    const mirror = shelf.find((row) => row.verdict_id === "mirror-y")!;
    assert.equal(mirror.text, null);
  } finally {
    db.close();
  }
});

test("8. listPwVerdictRefLog：该 verdict 全部引用记录按 created_at 升序", () => {
  const db = makeUnitDb();
  try {
    seedGold(db, { id: "gold-1", lesson: "x" });
    const refTable: RefTableItem[] = [{ ref: "§1", id: "gold-1", source: "paperweight", kind: "gold" }];
    recordPwVerdictRefs(db, { sourceKind: "collab_message", sourceId: "m1", text: "§1", refTable });
    recordPwVerdictRefs(db, { sourceKind: "content_draft", sourceId: "draft-1", text: "§1", refTable });
    recordPwVerdictRefs(db, { sourceKind: "collab_message", sourceId: "m2", text: "§1", refTable });
    db.prepare("UPDATE pw_verdict_refs SET created_at = '2026-08-01T00:00:00Z' WHERE source_id = 'm1'").run();
    db.prepare("UPDATE pw_verdict_refs SET created_at = '2026-08-02T00:00:00Z' WHERE source_id = 'draft-1'").run();
    db.prepare("UPDATE pw_verdict_refs SET created_at = '2026-08-03T00:00:00Z' WHERE source_id = 'm2'").run();
    const log = listPwVerdictRefLog(db, "gold-1");
    assert.deepEqual(log.map((row) => row.created_at), [
      "2026-08-01T00:00:00Z",
      "2026-08-02T00:00:00Z",
      "2026-08-03T00:00:00Z",
    ]);
    assert.deepEqual(log.map((row) => row.source_id), ["m1", "draft-1", "m2"]);
    assert.equal(listPwVerdictRefLog(db, "no-such-verdict").length, 0);
  } finally {
    db.close();
  }
});

test("9. 端到端（mock provider SSE）：assistant 回答带 §1 → 落库恰一笔、marker='§1'", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pw-verdict-refs-"));
  const mock = await startMockModel();
  const originalBaseUrl = process.env.PAPERTABLE_BASE_URL;
  const originalApiKey = process.env.PAPERTABLE_API_KEY;
  const originalModel = process.env.PAPERTABLE_MODEL;
  try {
    process.env.PAPERTABLE_BASE_URL = `http://127.0.0.1:${mock.port}/v1`;
    process.env.PAPERTABLE_API_KEY = "mock-key";
    process.env.PAPERTABLE_MODEL = "mock-1";
    const { db, sessions } = await makeE2eDb(dir);
    const betId = makeBet(db);
    db.prepare(`
      INSERT INTO pw_verdicts(
        id, bet_id, outcome, lesson, cause_of_death, evidence_doc_ids_json,
        confidence_snapshot, decided_by, decided_at, created_at
      ) VALUES('gold-1', 'b-other', 'gold', '开头 30 秒放痛点有效', NULL, '[]', NULL, 'human', ?, ?)
    `).run("2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z");
    // 装配里只有这一条金子候选 → §1 即 gold-1（确定性编号）
    const ctx = buildCollabContext(db, betId);
    assert.equal(ctx.golds.length, 1);
    assert.equal(ctx.golds[0].ref, "§1");
    assert.equal(ctx.golds[0].id, "gold-1");

    mock.answer("根据 §1 的教训，开头 30 秒放痛点最有效。");
    const events: string[] = [];
    const result = await runCollabTurn(
      { db, sessions },
      betId,
      "这张押注怎么推进？",
      (name) => { events.push(name); },
    );
    assert.equal(result.ok, true, result.error);
    assert.ok(events.includes("run_end"));

    const refs = db.prepare("SELECT * FROM pw_verdict_refs").all() as PwVerdictRefRow[];
    assert.equal(refs.length, 1, "assistant 回答的 §1 应恰落一笔");
    assert.equal(refs[0].verdict_id, "gold-1");
    assert.equal(refs[0].marker, "§1");
    assert.equal(refs[0].verdict_source, "paperweight");
    assert.equal(refs[0].verdict_kind, "gold");
    assert.equal(refs[0].source_kind, "collab_message");
    const assistant = db.prepare(`
      SELECT id FROM pw_collab_messages WHERE role = 'assistant' ORDER BY created_at LIMIT 1
    `).get() as { id: string };
    assert.equal(refs[0].source_id, assistant.id, "source_id 应指向 assistant 消息行");
    // 弹药架能读出这笔引用
    const shelf = listPwAmmoShelf(db) as AmmoRow[];
    assert.equal(shelf.length, 1);
    assert.equal(shelf[0].verdict_id, "gold-1");
    assert.equal(shelf[0].text, "开头 30 秒放痛点有效");
    assert.equal(shelf[0].ref_count, 1);
  } finally {
    mock.close();
    restoreEnv("PAPERTABLE_BASE_URL", originalBaseUrl);
    restoreEnv("PAPERTABLE_API_KEY", originalApiKey);
    restoreEnv("PAPERTABLE_MODEL", originalModel);
    await rm(dir, { recursive: true, force: true });
  }
});

test("10. 端到端：用户消息带 §1 → 不落库（只解析 assistant）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pw-verdict-refs-"));
  const mock = await startMockModel();
  const originalBaseUrl = process.env.PAPERTABLE_BASE_URL;
  const originalApiKey = process.env.PAPERTABLE_API_KEY;
  const originalModel = process.env.PAPERTABLE_MODEL;
  try {
    process.env.PAPERTABLE_BASE_URL = `http://127.0.0.1:${mock.port}/v1`;
    process.env.PAPERTABLE_API_KEY = "mock-key";
    process.env.PAPERTABLE_MODEL = "mock-1";
    const { db, sessions } = await makeE2eDb(dir);
    const betId = makeBet(db);
    db.prepare(`
      INSERT INTO pw_verdicts(
        id, bet_id, outcome, lesson, cause_of_death, evidence_doc_ids_json,
        confidence_snapshot, decided_by, decided_at, created_at
      ) VALUES('gold-1', 'b-other', 'gold', '开头 30 秒放痛点有效', NULL, '[]', NULL, 'human', ?, ?)
    `).run("2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z");

    mock.answer("明白，我会继续跟进。");
    const result = await runCollabTurn(
      { db, sessions },
      betId,
      "请参考 §1 的金子再回答",
      () => undefined,
    );
    assert.equal(result.ok, true, result.error);
    // user 文本的 §1 不得入账；assistant 文本无标注也不入账
    assert.equal(refCount(db), 0, "user 消息的 §1 不落库（只解析 assistant）");
    const userRows = db.prepare(`
      SELECT COUNT(*) AS n FROM pw_collab_messages WHERE role = 'user'
    `).get() as { n: number };
    assert.equal(Number(userRows.n), 1, "user 消息行本身仍落库");
  } finally {
    mock.close();
    restoreEnv("PAPERTABLE_BASE_URL", originalBaseUrl);
    restoreEnv("PAPERTABLE_API_KEY", originalApiKey);
    restoreEnv("PAPERTABLE_MODEL", originalModel);
    await rm(dir, { recursive: true, force: true });
  }
});
