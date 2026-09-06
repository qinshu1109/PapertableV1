import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ensurePwArtifactTables } from "./pw-artifacts.ts";
import { ensurePwBetTables } from "./pw-bets.ts";
import { ensurePwContentDraftTables } from "./pw-content-drafts.ts";
import { ensurePwDataDocTables } from "./pw-data-docs.ts";
import { ensurePwMinerTables } from "./pw-miner.ts";
import {
  ensurePwNoteBoardTables,
  getPwNoteBoard,
  getPwNoteJourney,
  noteValueScore,
  snapshotPwNoteValues,
} from "./pw-note-board.ts";
import { ensurePwNoteTreeTables } from "./pw-note-tree.ts";
import { ensurePwSieveTables } from "./pw-sieve.ts";
import { ensurePwVerdictTables } from "./pw-verdicts.ts";

const MEMOS_SCHEMA = `CREATE TABLE memo (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL UNIQUE, creator_id INTEGER,
  created_ts INTEGER, updated_ts INTEGER, row_status TEXT NOT NULL DEFAULT 'NORMAL',
  content TEXT, visibility TEXT NOT NULL DEFAULT 'PRIVATE', pinned INTEGER NOT NULL DEFAULT 0,
  payload TEXT
)`;

test("大盘、身价快照与流水账共用确定性执行侧真值", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pw-board-"));
  const path = join(dir, "memos.db");
  const memos = new DatabaseSync(path);
  const db = new DatabaseSync(":memory:");
  const saved = process.env.MEMOS_DB_PATH;
  try {
    memos.exec("PRAGMA journal_mode=WAL");
    memos.exec(MEMOS_SCHEMA);
    memos.prepare(`INSERT INTO memo(
      uid,creator_id,created_ts,updated_ts,row_status,content,visibility,pinned,payload
    ) VALUES('note-1',1,100,100,'NORMAL','观众要的不是教程','PRIVATE',0,NULL),
             ('note-2',1,90,90,'NORMAL','从没用过的笔记','PRIVATE',0,NULL)`).run();
    process.env.MEMOS_DB_PATH = path;
    ensurePwBetTables(db);
    ensurePwSieveTables(db);
    ensurePwVerdictTables(db);
    ensurePwArtifactTables(db);
    ensurePwDataDocTables(db);
    ensurePwContentDraftTables(db);
    ensurePwNoteTreeTables(db);
    ensurePwMinerTables(db);
    ensurePwNoteBoardTables(db);
    db.prepare(`INSERT INTO pw_bets(
      id,title,thesis,status,gold_refs_json,created_at,kind,settled_verdict_id
    ) VALUES('bet-1','直播陪跑','假设','settled','[]','2026-08-01T00:00:00+08:00','content','v-1')`).run();
    db.prepare(`INSERT INTO pw_note_attach(
      note_uid,bet_id,status,keyword,created_at,updated_at,role
    ) VALUES('note-1','bet-1','confirmed','观众需求','2026-08-01T00:00:00+08:00','2026-08-01T00:00:00+08:00','论点')`).run();
    db.prepare(`INSERT INTO pw_content_drafts(
      id,bet_id,batch_id,route,title_candidate,skeleton_json,status,created_at,updated_at
    ) VALUES('d-1','bet-1','batch','route','标题','[{"text":"x"}]','finalized','2026-08-02T00:00:00+08:00','2026-08-02T00:00:00+08:00')`).run();
    db.prepare(`INSERT INTO pw_artifacts(
      id,bet_id,platform,title,type,created_at
    ) VALUES('p-1','bet-1','bilibili','成品','video','2026-08-03T00:00:00+08:00')`).run();
    db.prepare(`INSERT INTO pw_data_docs(
      id,bet_id,platform,collected_at,method,metrics_json,version,frozen,created_at
    ) VALUES('data-1','bet-1','bilibili','2026-08-04T00:00:00+08:00','manual','{}',1,0,'2026-08-04T00:00:00+08:00')`).run();
    db.prepare(`INSERT INTO pw_verdicts(
      id,bet_id,outcome,lesson,evidence_doc_ids_json,decided_by,decided_at,created_at
    ) VALUES('v-1','bet-1','gold','胜','["data-1"]','human','2026-08-05T00:00:00+08:00','2026-08-05T00:00:00+08:00')`).run();
    db.prepare(`INSERT INTO pw_miner_runs(
      id,started_at,finished_at,trigger_kind,provider,model,candidates_count,by_source_json,cost_cny,status
    ) VALUES('r-1','2026-08-11T06:30:00+08:00','2026-08-11T06:31:00+08:00','scheduled','deepseek','mock',1,'{"note":1,"gold":0,"tombstone":0,"memos":0}',0.01,'done')`).run();
    db.prepare(`INSERT INTO pw_miner_candidates(
      id,run_id,source,ref_uid,snippet,suggested_bet_id,status,decided_at,created_at
    ) VALUES('c-1','r-1','note','note-1','摘要','bet-1','confirmed','2026-08-11T06:32:00+08:00','2026-08-11T06:31:00+08:00')`).run();

    assert.equal(snapshotPwNoteValues(db, "2026-08-11"), 1);
    const board = getPwNoteBoard(db, new Date("2026-08-11T12:00:00+08:00")) as any;
    assert.deepEqual(board.kpis, {
      totalNotes: 2, usedNotes: 1, intoDrafts: 1, intoProducts: 1, checkoutBack: 1,
    });
    assert.equal(board.topNotes[0].score, 19);
    assert.equal(board.topNotes[0].checkout, "win");
    assert.deepEqual(board.topNotes[0].roles, { "论点": 1 });
    assert.deepEqual(board.unused, { count: 1, pct: 50, rejectedEver: 0 });
    assert.deepEqual(getPwNoteJourney(db, "note-1").events.map((event) => event.kind), [
      "attach", "draft", "product", "data", "checkout",
    ]);
    assert.equal(noteValueScore({ drafts: 0, products: 0, outcome: "tomb" }), 1, "败不扣分");
  } finally {
    if (saved === undefined) delete process.env.MEMOS_DB_PATH;
    else process.env.MEMOS_DB_PATH = saved;
    memos.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
