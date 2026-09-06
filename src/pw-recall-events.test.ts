/**
 * TASK-PW-12（简报 12）：笔记召回事件账本测试。
 * 覆盖：建表幂等、四类打点各记对字段（echo/miner/note_tree/verdict）、summary 聚合
 * 数字手算对得上、days 过滤生效、list 翻页、echo 打点失败不影响 buildPwNoteEcho 返回。
 * 镇纸 mock 库走内存库；Memos mock 库走 tmp 目录 + WAL，经 MEMOS_DB_PATH 指向，绝不碰真库。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ensurePwBetTables } from "./pw-bets.ts";
import { ensurePwDataDocTables } from "./pw-data-docs.ts";
import { ensurePwGoldMirrorTables } from "./pw-gold-sync.ts";
import {
  confirmPwMinerCandidate,
  ensurePwMinerTables,
  rejectPwMinerCandidate,
  runPwMiner,
} from "./pw-miner.ts";
import { buildPwNoteEcho } from "./pw-note-recall.ts";
import { confirmPwNoteAttach, ensurePwNoteTreeTables } from "./pw-note-tree.ts";
import {
  ensurePwRecallEventTables,
  getPwRecallEventsSummary,
  listPwRecallEvents,
  PW_RECALL_EVENT_KINDS,
  PW_RECALL_SURFACES,
} from "./pw-recall-events.ts";
import { ensurePwSieveTables, setSieveDirection } from "./pw-sieve.ts";
import { ensurePwVerdictTables, settlePwBet } from "./pw-verdicts.ts";

const MEMOS_SCHEMA = `CREATE TABLE memo (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL UNIQUE, creator_id INTEGER,
  created_ts INTEGER, updated_ts INTEGER, row_status TEXT NOT NULL DEFAULT 'NORMAL',
  content TEXT, visibility TEXT NOT NULL DEFAULT 'PRIVATE', pinned INTEGER NOT NULL DEFAULT 0,
  payload TEXT
)`;

type RecallRow = {
  id: string;
  created_at: string;
  event_kind: string;
  surface: string;
  bet_id: string | null;
  note_uid: string | null;
  miner_candidate_id: string | null;
  run_id: string | null;
  role: string | null;
  meta_json: string | null;
};

/** 镇纸 mock 库：建全本刀用到的 pw 表。 */
function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwRecallEventTables(db);
  ensurePwBetTables(db);
  ensurePwSieveTables(db);
  ensurePwVerdictTables(db);
  ensurePwGoldMirrorTables(db);
  ensurePwNoteTreeTables(db);
  ensurePwMinerTables(db);
  ensurePwDataDocTables(db);
  return db;
}

/** 落一张 content 押注（status/checkout_date/confidence 可覆盖，settle 依赖）。 */
function seedBet(
  db: DatabaseSync,
  seed: { id: string; title?: string; thesis?: string; status?: string; checkout_date?: string | null },
): void {
  db.prepare(`
    INSERT INTO pw_bets(
      id, title, thesis, confidence, checkout_date, status, gold_refs_json, created_at, kind
    ) VALUES(?, ?, ?, 80, ?, ?, '[]', '2026-08-01T00:00:00+08:00', 'content')
  `).run(
    seed.id,
    seed.title ?? "测试押注",
    seed.thesis ?? "论点",
    seed.checkout_date ?? null,
    seed.status ?? "pending",
  );
}

/** settlePwBet 的 evidence_doc_ids 需要 pw_data_docs 行存在。 */
function seedDataDoc(db: DatabaseSync, id: string, betId: string): void {
  db.prepare(`
    INSERT INTO pw_data_docs(id, bet_id, platform, collected_at, method, metrics_json, created_at)
    VALUES(?, ?, 'bilibili', '2026-08-01T00:00:00+08:00', 'manual', '{}', '2026-08-01T00:00:00+08:00')
  `).run(id, betId);
}

function makeMockMemos(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(MEMOS_SCHEMA);
  return db;
}

function insertMemo(db: DatabaseSync, row: { uid: string; created_ts: number; content: string }): void {
  db.prepare(`
    INSERT INTO memo(uid, creator_id, created_ts, updated_ts, row_status, content, visibility, pinned, payload)
    VALUES(?, 1, ?, ?, 'NORMAL', ?, 'PRIVATE', 0, NULL)
  `).run(row.uid, row.created_ts, row.created_ts, row.content);
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pw-recall-events-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(env)) saved.set(key, process.env[key]);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function listAll(db: DatabaseSync, table: string): RecallRow[] {
  return db.prepare(`SELECT * FROM ${table} ORDER BY created_at, id`).all() as RecallRow[];
}

function insertEvent(
  db: DatabaseSync,
  id: string,
  createdAt: string,
  eventKind: string,
  surface: string,
  betId: string | null,
  noteUid: string | null,
  metaJson: string | null = null,
): void {
  db.prepare(`
    INSERT INTO pw_recall_events(id, created_at, event_kind, surface, bet_id, note_uid, meta_json)
    VALUES(?, ?, ?, ?, ?, ?, ?)
  `).run(id, createdAt, eventKind, surface, betId, noteUid, metaJson);
}

function hasStatus(error: unknown, status: number): boolean {
  return typeof error === "object" && error !== null && "status" in error
    && (error as { status: unknown }).status === status;
}

// ---- 1) 建表幂等 ----

test("建表幂等：重复 ensure 不报错，列与索引完整", () => {
  const db = new DatabaseSync(":memory:");
  try {
    ensurePwRecallEventTables(db);
    ensurePwRecallEventTables(db);
    const cols = (db.prepare("PRAGMA table_info(pw_recall_events)").all() as Array<{ name: string }>)
      .map((c) => c.name);
    for (const col of ["id", "created_at", "event_kind", "surface", "bet_id", "note_uid",
      "miner_candidate_id", "run_id", "role", "meta_json"]) {
      assert.ok(cols.includes(col), `缺列 ${col}`);
    }
    const indexes = (db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='index' AND tbl_name='pw_recall_events' AND name LIKE 'pw_recall_events_%'
    `).all() as Array<{ name: string }>).map((r) => r.name).sort();
    assert.deepEqual(indexes, ["pw_recall_events_bet", "pw_recall_events_kind", "pw_recall_events_note"]);
    assert.ok(PW_RECALL_EVENT_KINDS.includes("used"), "used 类型预留");
    assert.ok(PW_RECALL_SURFACES.includes("verdict"));
  } finally {
    db.close();
  }
});

// ---- 2) echo 打点：surfaced ----

test("echo 打点：buildPwNoteEcho ok 时每条命中记 surfaced（surface=echo，betId/noteUid/meta.matchedKeywords）", async () => {
  await withDir(async (dir) => {
    const notesPath = join(dir, "memos.db");
    const notesWriter = makeMockMemos(notesPath);
    const papertable = makeDb();
    try {
      seedBet(papertable, { id: "bet-1", title: "全能力量测试", thesis: "原文：AI 全能力量验证\n来源：bvid=BV1NprhBPEtR，uname=甲，like=1" });
      insertMemo(notesWriter, { uid: "n-a", created_ts: 100, content: "全能 力量 能力 都在" });
      withEnv({ MEMOS_DB_PATH: notesPath }, () => {
        const echo = buildPwNoteEcho(papertable);
        assert.equal(echo.status, "ok");
        assert.ok(echo.status === "ok");
        const events = listAll(papertable, "pw_recall_events");
        assert.equal(events.length, 1);
        assert.equal(events[0].event_kind, "surfaced");
        assert.equal(events[0].surface, "echo");
        assert.equal(events[0].bet_id, "bet-1");
        assert.equal(events[0].note_uid, "n-a");
        assert.deepEqual(JSON.parse(events[0].meta_json!), { matchedKeywords: ["全能", "能力", "力量"] });
      });
    } finally {
      notesWriter.close();
      papertable.close();
    }
  });
});

// ---- 3) miner 打点：run 落候选 surfaced + confirm/reject confirmed/rejected ----

test("miner 打点：run 落候选记 surfaced；confirm 记 confirmed、reject 记 rejected（字段含 miner_candidate_id/run_id）", async () => {
  await withDir(async (dir) => {
    const notesPath = join(dir, "memos.db");
    const memos = makeMockMemos(notesPath);
    const db = makeDb();
    const saved = process.env.MEMOS_DB_PATH;
    try {
      process.env.MEMOS_DB_PATH = notesPath;
      seedBet(db, { id: "bet-1", title: "直播陪跑", thesis: "验证陪跑内容" });
      setSieveDirection(db, "直播销售");
      insertMemo(memos, { uid: "note-1", created_ts: 100, content: "直播陪跑需要真实案例" });
      let calls = 0;
      const llm = async () => ({
        text: calls++ === 0
          ? JSON.stringify([{ source: "note", refUid: "note-1", betId: "bet-1", reason: "能当案例" }])
          : "[]",
        inputTokens: 10,
        outputTokens: 10,
      });
      const run = await runPwMiner(db, {
        llm,
        searchMemos: async () => [],
        now: () => "2026-08-11T06:31:00+08:00",
        modelLabel: "mock-deepseek",
      });
      assert.equal(run.candidates, 1);

      // 落候选 → surfaced
      const surfaced = listAll(db, "pw_recall_events").filter((e) => e.surface === "miner" && e.event_kind === "surfaced");
      assert.equal(surfaced.length, 1);
      const s = surfaced[0];
      assert.equal(s.bet_id, "bet-1");
      assert.equal(s.note_uid, "note-1");
      assert.ok(s.miner_candidate_id, "miner_candidate_id 应填");
      assert.ok(s.run_id, "run_id 应填");

      // 确认 → confirmed（含 role）
      confirmPwMinerCandidate(db, { id: s.miner_candidate_id!, betId: "bet-1", role: "案例" });
      const confirmed = listAll(db, "pw_recall_events").filter((e) => e.event_kind === "confirmed" && e.surface === "miner");
      assert.equal(confirmed.length, 1);
      assert.equal(confirmed[0].note_uid, "note-1");
      assert.equal(confirmed[0].miner_candidate_id, s.miner_candidate_id);
      assert.equal(confirmed[0].role, "案例");
      assert.equal(confirmed[0].bet_id, "bet-1");

      // 确认时 confirmPwNoteAttach 也触发 note_tree attached
      const attached = listAll(db, "pw_recall_events").filter((e) => e.event_kind === "attached" && e.surface === "note_tree");
      assert.equal(attached.length, 1);
      assert.equal(attached[0].note_uid, "note-1");
      assert.equal(attached[0].role, "案例");

      // 第二条候选拒绝 → rejected
      // 直接插一条 suggested 候选再拒
      const cand2 = "cand-2";
      db.prepare(`
        INSERT INTO pw_miner_candidates(id, run_id, source, ref_uid, snippet, suggested_bet_id, reason, status, decided_at, created_at)
        VALUES(?, 'run-2', 'note', 'note-2', 'snippet', NULL, 'r', 'suggested', NULL, '2026-08-11T06:31:00+08:00')
      `).run(cand2);
      rejectPwMinerCandidate(db, cand2);
      const rejected = listAll(db, "pw_recall_events").filter((e) => e.event_kind === "rejected" && e.surface === "miner");
      assert.equal(rejected.length, 1);
      assert.equal(rejected[0].note_uid, "note-2");
      assert.equal(rejected[0].miner_candidate_id, cand2);
    } finally {
      if (saved === undefined) delete process.env.MEMOS_DB_PATH;
      else process.env.MEMOS_DB_PATH = saved;
      memos.close();
      db.close();
    }
  });
});

// ---- 4) note_tree 打点：attached ----

test("note_tree 打点：confirmPwNoteAttach 记 attached（surface=note_tree，betId/noteUid/role）", () => {
  const db = makeDb();
  try {
    seedBet(db, { id: "bet-1" });
    confirmPwNoteAttach(db, "note-x", "bet-1", "案例");
    const events = listAll(db, "pw_recall_events");
    assert.equal(events.length, 1);
    assert.equal(events[0].event_kind, "attached");
    assert.equal(events[0].surface, "note_tree");
    assert.equal(events[0].bet_id, "bet-1");
    assert.equal(events[0].note_uid, "note-x");
    assert.equal(events[0].role, "案例");
  } finally {
    db.close();
  }
});

// ---- 5) verdict 打点：settled ----

test("verdict 打点：settlePwBet 成功对已 attached 笔记每条记 settled；void 作废不记", () => {
  const db = makeDb();
  try {
    seedBet(db, { id: "bet-1", checkout_date: "2026-08-01" });
    seedDataDoc(db, "doc-1", "bet-1");
    confirmPwNoteAttach(db, "note-a", "bet-1", "案例");
    confirmPwNoteAttach(db, "note-b", "bet-1", "论点");
    const verdict = settlePwBet(db, "bet-1", { outcome: "gold", lesson: "有用", evidenceDocIds: ["doc-1"] });
    assert.ok(verdict.id);
    const settled = listAll(db, "pw_recall_events").filter((e) => e.event_kind === "settled");
    assert.equal(settled.length, 2, "两张已 attached 笔记各记一条 settled");
    assert.deepEqual(settled.map((e) => e.note_uid).sort(), ["note-a", "note-b"]);
    assert.equal(settled[0].surface, "verdict");
    assert.equal(settled[0].bet_id, "bet-1");

    // void 作废：即便有 attached 笔记也不记 settled
    seedBet(db, { id: "bet-void", checkout_date: "2026-08-01" });
    confirmPwNoteAttach(db, "note-v", "bet-void", "案例");
    settlePwBet(db, "bet-void", { outcome: "void" });
    assert.equal(
      listAll(db, "pw_recall_events").filter((e) => e.event_kind === "settled").length,
      2,
      "void 作废不记 settled",
    );
  } finally {
    db.close();
  }
});

// ---- 6) summary 聚合手算对得上 ----

test("summary 聚合：bySurface/totals/distinctNotes/byDay 手算对得上", () => {
  const db = makeDb();
  try {
    insertEvent(db, "1", "2026-08-12T10:00:00.000Z", "surfaced", "echo", "b1", "n1", JSON.stringify({ matchedKeywords: ["x"] }));
    insertEvent(db, "2", "2026-08-12T10:01:00.000Z", "surfaced", "echo", "b1", "n2");
    insertEvent(db, "3", "2026-08-12T10:02:00.000Z", "surfaced", "miner", "b1", "n1"); // n1 第二次 surfaced
    insertEvent(db, "4", "2026-08-12T10:03:00.000Z", "confirmed", "miner", "b1", "n1");
    insertEvent(db, "5", "2026-08-12T10:04:00.000Z", "confirmed", "note_tree", "b1", "n3");
    insertEvent(db, "6", "2026-08-12T11:00:00.000Z", "settled", "verdict", "b1", "n1");
    insertEvent(db, "7", "2026-08-11T09:00:00.000Z", "surfaced", "echo", "b1", "n9");
    insertEvent(db, "8", "2026-08-01T00:00:00.000Z", "surfaced", "echo", "b1", "n0"); // 30 天窗口内

    const s = getPwRecallEventsSummary(db, 30, () => "2026-08-12T12:00:00.000Z");
    assert.equal(s.days, 30);
    assert.deepEqual(s.totals, {
      surfaced: 5, confirmed: 2, rejected: 0, attached: 0, used: 0, settled: 1,
    });
    assert.equal(s.bySurface.echo.surfaced, 4);
    assert.equal(s.bySurface.miner.surfaced, 1);
    assert.equal(s.bySurface.miner.confirmed, 1);
    assert.equal(s.bySurface.note_tree.confirmed, 1);
    assert.equal(s.bySurface.verdict.settled, 1);
    assert.equal(s.bySurface.echo.confirmed, 0);
    assert.equal(s.distinctNotesSurfaced, 4, "n1 去重只算一次，加 n2/n9/n0");
    assert.equal(s.distinctNotesConfirmed, 2, "n1、n3");

    const byDate = Object.fromEntries(s.byDay.map((d) => [d.date, d]));
    assert.deepEqual(byDate["2026-08-12"], { date: "2026-08-12", surfaced: 3, confirmed: 2 });
    assert.deepEqual(byDate["2026-08-11"], { date: "2026-08-11", surfaced: 1, confirmed: 0 });
    assert.deepEqual(byDate["2026-08-01"], { date: "2026-08-01", surfaced: 1, confirmed: 0 });
    assert.equal(s.byDay.length, 3);
  } finally {
    db.close();
  }
});

// ---- 7) days 过滤生效 + 参数校验 ----

test("days 过滤生效：超窗事件不计入；非法 days 400", () => {
  const db = makeDb();
  try {
    insertEvent(db, "1", "2026-08-12T10:00:00.000Z", "surfaced", "echo", "b1", "n1");
    insertEvent(db, "2", "2026-05-01T10:00:00.000Z", "surfaced", "echo", "b1", "n-old"); // 3 个月前

    const s30 = getPwRecallEventsSummary(db, 30, () => "2026-08-12T12:00:00.000Z");
    assert.equal(s30.totals.surfaced, 1);
    assert.equal(s30.distinctNotesSurfaced, 1);
    assert.equal(s30.byDay.length, 1);

    const s365 = getPwRecallEventsSummary(db, 365, () => "2026-08-12T12:00:00.000Z");
    assert.equal(s365.totals.surfaced, 2, "365 天窗口纳入 5 月事件");

    assert.throws(() => getPwRecallEventsSummary(db, 0), (e: unknown) => hasStatus(e, 400));
    assert.throws(() => getPwRecallEventsSummary(db, 366), (e: unknown) => hasStatus(e, 400));
    assert.throws(() => getPwRecallEventsSummary(db, "abc"), (e: unknown) => hasStatus(e, 400));
  } finally {
    db.close();
  }
});

// ---- 8) list 原始翻页 ----

test("list 原始翻页：created_at 倒序、limit/offset 生效、camelCase", () => {
  const db = makeDb();
  try {
    insertEvent(db, "1", "2026-08-12T10:00:00.000Z", "surfaced", "echo", "b1", "n1");
    insertEvent(db, "2", "2026-08-12T09:00:00.000Z", "confirmed", "miner", "b1", "n2");
    insertEvent(db, "3", "2026-08-12T08:00:00.000Z", "attached", "note_tree", "b1", "n3");
    const page = listPwRecallEvents(db, 2, 0);
    assert.equal(page.limit, 2);
    assert.equal(page.offset, 0);
    assert.deepEqual(page.events.map((e) => e.id), ["1", "2"]);
    assert.equal(page.events[0].eventKind, "surfaced");
    assert.equal(page.events[0].surface, "echo");
    assert.equal(page.events[0].betId, "b1");
    assert.equal(page.events[0].noteUid, "n1");
    const page2 = listPwRecallEvents(db, 2, 2);
    assert.deepEqual(page2.events.map((e) => e.id), ["3"]);
    assert.throws(() => listPwRecallEvents(db, 0, 0), (e: unknown) => hasStatus(e, 400));
    assert.throws(() => listPwRecallEvents(db, 100, -1), (e: unknown) => hasStatus(e, 400));
  } finally {
    db.close();
  }
});

// ---- 9) echo 打点失败不影响 buildPwNoteEcho 返回 ----

test("echo 打点失败不影响 buildPwNoteEcho 返回（try/catch 兜底）", async () => {
  await withDir(async (dir) => {
    const notesPath = join(dir, "memos.db");
    const notesWriter = makeMockMemos(notesPath);
    const papertable = new DatabaseSync(":memory:");
    ensurePwBetTables(papertable);
    // listContentBets LEFT JOIN pw_sieve_cards，缺表即报错 → 补最小表
    papertable.exec("CREATE TABLE pw_sieve_cards (id TEXT PRIMARY KEY, quote_text TEXT NOT NULL)");
    // 手工建必失败的事件表（CHECK(0)）：ensure IF NOT EXISTS 跳过，INSERT 必抛约束错误
    papertable.exec(`
      CREATE TABLE pw_recall_events (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, event_kind TEXT, surface TEXT,
        bet_id TEXT, note_uid TEXT, miner_candidate_id TEXT, run_id TEXT, role TEXT, meta_json TEXT,
        CHECK (0)
      );
    `);
    try {
      seedBet(papertable, { id: "bet-1", title: "全能力量测试", thesis: "原文：AI 全能力量验证\n来源：bvid=BV1NprhBPEtR，uname=甲，like=1" });
      insertMemo(notesWriter, { uid: "n-a", created_ts: 100, content: "全能 力量 能力 都在" });
      withEnv({ MEMOS_DB_PATH: notesPath }, () => {
        const echo = buildPwNoteEcho(papertable);
        assert.equal(echo.status, "ok", "打点失败不得改变 ok 返回");
        assert.ok(echo.status === "ok");
        assert.deepEqual(echo.bets[0].hits.map((h) => h.uid), ["n-a"]);
        assert.equal(echo.bets[0].betId, "bet-1");
      });
    } finally {
      notesWriter.close();
      papertable.close();
    }
  });
});
