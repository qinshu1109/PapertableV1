import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ensurePwBetTables } from "./pw-bets.ts";
import { ensurePwSieveTables, setSieveDirection } from "./pw-sieve.ts";
import {
  buildPwNoteTree,
  confirmPwNoteAttach,
  ensurePwNoteTreeTables,
  runPwNoteTreeTick,
  setPwNoteKeyword,
} from "./pw-note-tree.ts";

const MEMOS_SCHEMA = `CREATE TABLE memo (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL UNIQUE, creator_id INTEGER,
  created_ts INTEGER, updated_ts INTEGER, row_status TEXT NOT NULL DEFAULT 'NORMAL',
  content TEXT, visibility TEXT NOT NULL DEFAULT 'PRIVATE', pinned INTEGER NOT NULL DEFAULT 0,
  payload TEXT
)`;

function papertableDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwBetTables(db);
  ensurePwSieveTables(db);
  ensurePwNoteTreeTables(db);
  return db;
}

function seedBet(db: DatabaseSync, id: string, title: string): void {
  db.prepare(`INSERT INTO pw_bets(
    id,title,thesis,status,gold_refs_json,created_at,kind
  ) VALUES(?,?,?,'pending','[]','2026-08-01T00:00:00.000Z','content')`).run(id, title, `${title}假设`);
}

function seedNote(db: DatabaseSync, uid: string, created: number, content: string): void {
  db.prepare(`INSERT INTO memo(
    uid,creator_id,created_ts,updated_ts,row_status,content,visibility,pinned,payload
  ) VALUES(?,1,?,?,'NORMAL',?,'PRIVATE',0,NULL)`).run(uid, created, created, content);
}

async function fixture(run: (db: DatabaseSync) => void | Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pw-note-tree-"));
  const memos = new DatabaseSync(join(dir, "memos.db"));
  const db = papertableDb();
  const saved = process.env.MEMOS_DB_PATH;
  try {
    memos.exec("PRAGMA journal_mode=WAL");
    memos.exec(MEMOS_SCHEMA);
    seedNote(memos, "n-new", 200, "最近在研究直播转化");
    seedNote(memos, "n-old", 100, "旧的选题记录");
    process.env.MEMOS_DB_PATH = join(dir, "memos.db");
    await run(db);
  } finally {
    if (saved === undefined) delete process.env.MEMOS_DB_PATH;
    else process.env.MEMOS_DB_PATH = saved;
    memos.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("建表幂等且列完整", () => {
  const db = new DatabaseSync(":memory:");
  ensurePwNoteTreeTables(db);
  ensurePwNoteTreeTables(db);
  assert.deepEqual(
    (db.prepare("PRAGMA table_info(pw_note_attach)").all() as Array<{ name: string }>).map((row) => row.name),
    ["note_uid", "bet_id", "status", "keyword", "created_at", "updated_at", "role"],
  );
  db.close();
});

test("树装配区分已挂枝、AI 建议和待归位", async () => fixture((db) => {
  seedBet(db, "bet-a", "直播转化");
  setSieveDirection(db, "做销售，不做粉丝");
  confirmPwNoteAttach(db, "n-new", "bet-a");
  setPwNoteKeyword(db, "n-new", "直播转化");
  const tree = buildPwNoteTree(db);
  assert.equal(tree.direction, "做销售，不做粉丝");
  assert.equal(tree.bets[0].lastNoteAt, tree.bets[0].notes[0].createdAt);
  assert.deepEqual(tree.bets[0].notes.map((note) => note.uid), ["n-new"]);
  assert.deepEqual(tree.unassigned.map((note) => note.uid), ["n-old"]);
}));

test("confirm 可改挂或放回待归位；关键词人改且限制 12 字", async () => fixture((db) => {
  seedBet(db, "bet-a", "A");
  seedBet(db, "bet-b", "B");
  confirmPwNoteAttach(db, "n-new", "bet-a");
  confirmPwNoteAttach(db, "n-new", "bet-b");
  setPwNoteKeyword(db, "n-new", "人改关键词");
  let row = db.prepare("SELECT * FROM pw_note_attach WHERE note_uid='n-new'").get() as Record<string, unknown>;
  assert.equal(row.bet_id, "bet-b");
  assert.equal(row.status, "confirmed");
  assert.equal(row.keyword, "人改关键词");
  confirmPwNoteAttach(db, "n-new", null);
  row = db.prepare("SELECT * FROM pw_note_attach WHERE note_uid='n-new'").get() as Record<string, unknown>;
  assert.equal(row.bet_id, null);
  assert.throws(() => setPwNoteKeyword(db, "n-new", "一二三四五六七八九十一二三"), /12/);
}));

test("tick 最多各十条并把关键词和挂接写为 suggested", async () => fixture(async (db) => {
  seedBet(db, "bet-a", "直播转化");
  const result = await runPwNoteTreeTick(db, {
    llm: async () => '{"keyword":"这是一个超过十二个字的关键词会截断","betId":"bet-a"}',
    now: () => "2026-08-10T00:00:00.000Z",
  });
  assert.deepEqual(result, { keywords: 2, suggestions: 2 });
  const rows = db.prepare("SELECT * FROM pw_note_attach ORDER BY note_uid").all() as Array<{
    status: string; keyword: string; bet_id: string;
  }>;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.status === "suggested" && row.bet_id === "bet-a"));
  assert.ok(rows.every((row) => [...row.keyword].length === 12));
  const tree = buildPwNoteTree(db);
  assert.equal(tree.bets[0].notes.length, 0, "AI 建议不能直接挂枝");
  assert.ok(tree.unassigned.every((note) => note.suggestedBetId === "bet-a"));
}));
