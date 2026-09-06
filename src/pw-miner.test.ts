import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ensurePwBetTables } from "./pw-bets.ts";
import { ensurePwGoldMirrorTables } from "./pw-gold-sync.ts";
import {
  calculateMinerCostCny,
  confirmPwMinerCard,
  confirmPwMinerCandidate,
  ensurePwMinerTables,
  listPwMinerCandidates,
  listPwMinerCards,
  migratePwMinerCards,
  rejectPwMinerCard,
  rejectPwMinerCandidate,
  runPwMiner,
  runPwMinerScheduledTick,
  seedPwMinerCard,
} from "./pw-miner.ts";
import { ensurePwNoteTreeTables } from "./pw-note-tree.ts";
import { ensurePwSieveTables, setSieveDirection } from "./pw-sieve.ts";
import { ensurePwVerdictTables } from "./pw-verdicts.ts";

const MEMOS_SCHEMA = `CREATE TABLE memo (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL UNIQUE, creator_id INTEGER,
  created_ts INTEGER, updated_ts INTEGER, row_status TEXT NOT NULL DEFAULT 'NORMAL',
  content TEXT, visibility TEXT NOT NULL DEFAULT 'PRIVATE', pinned INTEGER NOT NULL DEFAULT 0,
  payload TEXT
)`;

async function fixture(run: (db: DatabaseSync) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pw-miner-"));
  const path = join(dir, "memos.db");
  const memos = new DatabaseSync(path);
  const db = new DatabaseSync(":memory:");
  const saved = process.env.MEMOS_DB_PATH;
  try {
    memos.exec("PRAGMA journal_mode=WAL");
    memos.exec(MEMOS_SCHEMA);
    memos.prepare(`INSERT INTO memo(
      uid,creator_id,created_ts,updated_ts,row_status,content,visibility,pinned,payload
    ) VALUES('note-1',1,100,100,'NORMAL','直播陪跑需要真实案例','PRIVATE',0,NULL)`).run();
    const insertMemo = memos.prepare(`INSERT INTO memo(
      uid,creator_id,created_ts,updated_ts,row_status,content,visibility,pinned,payload
    ) VALUES(?,1,?,?, 'NORMAL',?,'PRIVATE',0,NULL)`);
    for (let index = 2; index <= 45; index += 1) {
      insertMemo.run(`note-${index}`, index, index, `近期通用笔记 ${index}`);
    }
    process.env.MEMOS_DB_PATH = path;
    ensurePwBetTables(db);
    ensurePwSieveTables(db);
    ensurePwVerdictTables(db);
    ensurePwGoldMirrorTables(db);
    ensurePwNoteTreeTables(db);
    ensurePwMinerTables(db);
    db.prepare(`INSERT INTO pw_bets(
      id,title,thesis,status,gold_refs_json,created_at,kind
    ) VALUES('bet-1','直播陪跑','验证陪跑内容','pending','[]','2026-08-01T00:00:00+08:00','content')`).run();
    setSieveDirection(db, "直播销售");
    await run(db);
  } finally {
    if (saved === undefined) delete process.env.MEMOS_DB_PATH;
    else process.env.MEMOS_DB_PATH = saved;
    memos.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("捞料幂等、分组、确认角色与弃回流", async () => fixture(async (db) => {
  let prompt = "";
  const llm = async (text: string) => {
    prompt = text;
    return {
      text: JSON.stringify([
        { source: "note", refUid: "note-1", betId: "bet-1", reason: "能当案例" },
        { source: "memos", refUid: "memory-1", betId: "bet-1", reason: "旧判断" },
      ]),
      inputTokens: 100,
      outputTokens: 50,
    };
  };
  const options = {
    llm,
    searchMemos: async () => [{ id: "memory-1", text: "直播销售的旧判断" }],
    now: () => "2026-08-11T06:31:00+08:00",
    modelLabel: "mock-deepseek",
  };
  const first = await runPwMiner(db, options);
  assert.equal(first.candidates, 2);
  assert.ok(first.costCny > 0 && first.costCny <= 0.1);
  assert.equal(first.sourcePool.note, 40, "关键词命中不足 20 时近期笔记补齐到 40");
  assert.equal(listPwMinerCandidates(db).groups[0].items.length, 2);

  const noteId = (db.prepare(`SELECT id FROM pw_miner_candidates WHERE source='note'`).get() as { id: string }).id;
  const memoryId = (db.prepare(`SELECT id FROM pw_miner_candidates WHERE source='memos'`).get() as { id: string }).id;
  confirmPwMinerCandidate(db, { id: noteId, betId: "bet-1", role: "案例" });
  rejectPwMinerCandidate(db, memoryId);
  const attach = db.prepare(`SELECT status, role FROM pw_note_attach WHERE note_uid='note-1'`).get() as {
    status: string; role: string;
  };
  assert.equal(attach.status, "confirmed");
  assert.equal(attach.role, "案例");

  const second = await runPwMiner(db, { ...options, now: () => "2026-08-12T06:31:00+08:00" });
  assert.equal(second.candidates, 0, "同 source/ref/bet 不重复建议");
  assert.match(prompt, /memory-1/, "近 30 天被弃 ref_uid 进入下一轮 prompt");
}));

test("诊断列兼容迁移并落 raw_response/source_pool", async () => fixture(async (db) => {
  db.prepare("UPDATE pw_bets SET title='量子火箭', thesis='深空推进' WHERE id='bet-1'").run();
  setSieveDirection(db, null);
  db.exec("DROP TABLE pw_miner_candidates; DROP TABLE pw_miner_runs");
  db.exec(`CREATE TABLE pw_miner_runs (
    id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
    trigger_kind TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
    candidates_count INTEGER NOT NULL DEFAULT 0, by_source_json TEXT,
    cost_cny REAL, status TEXT NOT NULL
  )`);
  ensurePwMinerTables(db);
  const result = await runPwMiner(db, {
    llm: async () => ({ text: "[]", inputTokens: 10, outputTokens: 10 }),
    searchMemos: async () => [],
    now: () => "2026-08-11T07:00:00+08:00",
  });
  assert.equal(result.sourcePool.note, 40, "关键词零命中仍有 40 条真实近期笔记");
  const row = db.prepare("SELECT raw_response,source_pool_json FROM pw_miner_runs WHERE id=?").get(result.id) as { raw_response: string; source_pool_json: string };
  assert.equal(row.raw_response, "[]\n\n--- aggregate ---\n[]");
  assert.equal(JSON.parse(row.source_pool_json).note, 40);
}));

test("DeepSeek 抄成 source:<uid> 时拆前缀并保留候选", async () => fixture(async (db) => {
  const result = await runPwMiner(db, {
    llm: async () => ({
      text: JSON.stringify([{
        source: "memos:087fc0fa-1419-42a9-9b74-74b22557ef83",
        refUid: "",
        betId: "bet-1",
        reason: "旧判断可复用",
      }]),
      inputTokens: 10,
      outputTokens: 10,
    }),
    searchMemos: async () => [{
      id: "087fc0fa-1419-42a9-9b74-74b22557ef83",
      text: "一条真实旧判断",
    }],
    now: () => "2026-08-11T07:30:00+08:00",
  });
  assert.equal(result.candidates, 1);
  const row = db.prepare("SELECT source,ref_uid FROM pw_miner_candidates").get() as { source: string; ref_uid: string };
  assert.equal(row.source, "memos");
  assert.equal(row.ref_uid, "087fc0fa-1419-42a9-9b74-74b22557ef83");
}));

test("06:30 调度同日只跑一次，成本公式受预算钉死", async () => fixture(async (db) => {
  const llm = async () => ({ text: "[]", inputTokens: 10, outputTokens: 10 });
  const searchMemos = async () => [];
  assert.equal(await runPwMinerScheduledTick(db, {
    llm, searchMemos, now: () => "2026-08-11T06:29:00+08:00",
  }), null);
  assert.ok(await runPwMinerScheduledTick(db, {
    llm, searchMemos, now: () => "2026-08-11T06:30:00+08:00",
  }));
  assert.equal(await runPwMinerScheduledTick(db, {
    llm, searchMemos, now: () => "2026-08-11T12:00:00+08:00",
  }), null);
  assert.equal(calculateMinerCostCny(1_000_000, 1_000_000), 10);
}));

test("概念卡解析容错、未认领兜底与 suggested 重聚换卡", async () => fixture(async (db) => {
  let call = 0;
  const llm = async () => ({
    text: call++ === 0
      ? JSON.stringify([
        { source: "note", refUid: "note-1", betId: "bet-1", reason: "案例" },
        { source: "note", refUid: "note-45", betId: null, reason: "旁证" },
      ])
      : `杂字 ${JSON.stringify([
        { kind: "concept", title: "直播案例", summary: "同向", suggestedBetId: "bet-1", candidateKeys: [{ source: "note", refUid: "note-1" }] },
        { kind: "bad", title: "坏项", candidateKeys: [] },
        { kind: "concept", title: "空卡", candidateKeys: [{ source: "note", refUid: "missing" }] },
      ])}`,
    inputTokens: 10, outputTokens: 10,
  });
  await runPwMiner(db, { llm, searchMemos: async () => [], now: () => "2026-08-11T07:00:00+08:00" });
  assert.deepEqual(listPwMinerCards(db).cards.map((card) => card.title).sort(), ["未归堆", "直播案例"]);
  const before = db.prepare(`SELECT card_id FROM pw_miner_candidates WHERE ref_uid='note-1'`).get() as { card_id: string };
  await migratePwMinerCards(db, {
    llm: async () => ({ text: JSON.stringify([{ kind: "concept", title: "新卡", candidateKeys: [
      { source: "note", refUid: "note-1" }, { source: "note", refUid: "note-45" },
    ] }]), inputTokens: 10, outputTokens: 10 }),
    now: () => "2026-08-11T08:00:00+08:00",
  });
  const after = db.prepare(`SELECT card_id FROM pw_miner_candidates WHERE ref_uid='note-1'`).get() as { card_id: string };
  assert.notEqual(after.card_id, before.card_id);
  assert.equal(listPwMinerCards(db).cards.length, 1);
}));

test("整卡确认、弃与方向种子严格联动", async () => fixture(async (db) => {
  const insertCard = db.prepare(`INSERT INTO pw_miner_cards(id,run_id,kind,title,status,created_at) VALUES(?,?, 'concept',?,'suggested',?)`);
  const insertCandidate = db.prepare(`INSERT INTO pw_miner_candidates(id,run_id,source,ref_uid,snippet,status,created_at,card_id) VALUES(?,?,?,?,?,'suggested',?,?)`);
  insertCard.run("card-confirm", "run", "确认卡", "2026-08-11");
  insertCandidate.run("candidate-note", "run", "note", "note-1", "证据", "2026-08-11", "card-confirm");
  insertCandidate.run("candidate-memos", "run", "memos", "memory-1", "旧判断", "2026-08-11", "card-confirm");
  assert.throws(() => confirmPwMinerCard(db, { cardId: "card-confirm", betId: "missing", role: "案例" }), /押注不存在/);
  confirmPwMinerCard(db, { cardId: "card-confirm", betId: "bet-1", role: "案例" });
  assert.equal((db.prepare(`SELECT role FROM pw_note_attach WHERE note_uid='note-1'`).get() as { role: string }).role, "案例");
  assert.equal((db.prepare(`SELECT count(*) n FROM pw_miner_candidates WHERE card_id='card-confirm' AND status='confirmed'`).get() as { n: number }).n, 2);
  assert.throws(() => confirmPwMinerCard(db, { cardId: "card-confirm", betId: "bet-1", role: "案例" }), /卡已处理/);

  insertCard.run("card-reject", "run", "弃卡", "2026-08-11");
  insertCandidate.run("candidate-reject", "run", "memos", "memory-reject", "弃证据", "2026-08-11", "card-reject");
  rejectPwMinerCard(db, "card-reject");
  assert.equal((db.prepare(`SELECT status FROM pw_miner_candidates WHERE id='candidate-reject'`).get() as { status: string }).status, "rejected");

  insertCard.run("card-seed", "run", "种子卡", "2026-08-11");
  insertCandidate.run("candidate-seed", "run", "memos", "memory-seed", "种子证据", "2026-08-11", "card-seed");
  seedPwMinerCard(db, "card-seed");
  assert.equal((db.prepare(`SELECT status FROM pw_miner_candidates WHERE id='candidate-seed'`).get() as { status: string }).status, "suggested");
  assert.equal((db.prepare(`SELECT count(*) n FROM pw_bets`).get() as { n: number }).n, 1);
}));

test("调度按本地日去重、迁移幂等、两笔成本合计护栏", async () => fixture(async (db) => {
  db.prepare(`INSERT INTO pw_miner_runs(id,started_at,trigger_kind,provider,model,status) VALUES('utc-run','2026-08-10T23:48:00Z','scheduled','deepseek','mock','done')`).run();
  assert.equal(await runPwMinerScheduledTick(db, {
    llm: async () => "[]", searchMemos: async () => [], now: () => "2026-08-11T06:35:00+08:00",
  }), null);

  db.prepare(`INSERT INTO pw_miner_candidates(id,run_id,source,ref_uid,snippet,status,created_at) VALUES('migration-item','old','memos','migration-ref','积压','suggested','2026-08-10')`).run();
  const aggregate = async () => ({ text: "not json", inputTokens: 10, outputTokens: 10 });
  await migratePwMinerCards(db, { llm: aggregate, now: () => "2026-08-11T09:00:00+08:00" });
  await migratePwMinerCards(db, { llm: aggregate, now: () => "2026-08-11T09:01:00+08:00" });
  assert.equal(listPwMinerCards(db).cards.length, 1);

  let calls = 0;
  await assert.rejects(runPwMiner(db, {
    llm: async () => ({ text: calls++ === 0 ? JSON.stringify([{ source: "note", refUid: "note-1", betId: null }]) : "[]", inputTokens: 0, outputTokens: 10_000 }),
    searchMemos: async () => [], now: () => "2026-08-12T07:00:00+08:00",
  }), /超预算/);
  assert.match((db.prepare(`SELECT status FROM pw_miner_runs ORDER BY started_at DESC LIMIT 1`).get() as { status: string }).status, /^failed:/);
}));
