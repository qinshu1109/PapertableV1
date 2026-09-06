/**
 * TASK-PW-34：多源可视化数据（来源对比 + 产出榜）测试。
 * 覆盖：空库、单来源全口径、窗口过滤、评论数存量口径、零来源计数、
 * 产出榜排序、rangeDays 非法回退、坏数据韧性（非法 payload_json / 缺 bvid 卡）。
 * 种子数据手写 SQL 直插各 pw_* 表（pw_sieve_cards 依赖先有 pw_sieve_runs 行）。
 *
 * 笔记通路接线连带（PW-38 批次尾巴收口）：getPwSourceComparison 会经 MEMOS_DB_PATH
 * 只读打开笔记库装配 notesLane——统一指向不存在的 tmp 路径保证确定性（notesLane=null、
 * pendingLanes 双行），绝不触碰真实 Memos 库；测试 9 单建临时笔记库验 notesLane 实行。
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ensurePwBetTables } from "./pw-bets.ts";
import { ensurePwCollabTables } from "./pw-collab.ts";
import { ensurePwContentDraftTables } from "./pw-content-drafts.ts";
import { ensurePwCorpusTables } from "./pw-corpus.ts";
import { ensurePwRunTables } from "./pw-runs.ts";
import { ensurePwSieveTables } from "./pw-sieve.ts";
import { ensurePwVerdictRefTables } from "./pw-verdict-refs.ts";
import { ensurePwVerdictTables } from "./pw-verdicts.ts";
import {
  getPwOutputRanking,
  getPwSourceComparison,
} from "./pw-source-stats.ts";

/** 注入基准时刻：7 天窗下界 2026-08-01，30 天窗下界 2026-07-09。 */
const NOW = "2026-08-08T00:00:00Z";
const BV1 = "BV1234567890";

/** 笔记通路接线连带：笔记库路径统一指向不存在的 tmp 路径（每个测试进程独立，先跑后还原）。 */
const ORIGINAL_MEMOS_DB_PATH = process.env.MEMOS_DB_PATH;
test.before(() => {
  process.env.MEMOS_DB_PATH = join(tmpdir(), `pw-source-stats-no-memos-${process.pid}.db`);
});
test.after(() => {
  if (ORIGINAL_MEMOS_DB_PATH === undefined) delete process.env.MEMOS_DB_PATH;
  else process.env.MEMOS_DB_PATH = ORIGINAL_MEMOS_DB_PATH;
});

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwCorpusTables(db);
  ensurePwSieveTables(db);
  ensurePwBetTables(db);
  ensurePwVerdictTables(db);
  ensurePwVerdictRefTables(db);
  ensurePwContentDraftTables(db);
  ensurePwCollabTables(db);
  ensurePwRunTables(db);
  return db;
}

function seedDoc(
  db: DatabaseSync,
  input: {
    id: string;
    bvid: string;
    title?: string;
    upName?: string;
    commentCount?: number;
    fetchedAt?: string;
    createdAt?: string;
  },
): void {
  db.prepare(`
    INSERT INTO pw_corpus_docs(
      id, bvid, title, up_name, kinds, status, path, sha256, video_stat_json,
      comment_count, authorized_by, error, fetched_at, created_at
    ) VALUES(?, ?, ?, ?, 'video,comments', 'done', NULL, NULL, NULL, ?, 'human', NULL, ?, ?)
  `).run(
    input.id, input.bvid, input.title ?? null, input.upName ?? null,
    input.commentCount ?? 0, input.fetchedAt ?? NOW, input.createdAt ?? NOW,
  );
}

/** 造一轮筛子 run（pw_sieve_cards 外键依赖 pw_sieve_runs）。 */
function seedSieveRun(db: DatabaseSync, id: string, createdAt: string): void {
  db.prepare(`
    INSERT INTO pw_sieve_runs(
      id, trigger_source, input_ids_json, cards_count, dropped_count,
      status, error, model, created_at, finished_at
    ) VALUES(?, 'manual', '[]', 0, 0, 'done', NULL, NULL, ?, ?)
  `).run(id, createdAt, createdAt);
}

function seedCard(
  db: DatabaseSync,
  input: {
    id: string;
    runId: string;
    kind?: string;
    bvid?: string;
    quoteSourceJson?: string;
    createdAt?: string;
  },
): void {
  db.prepare(`
    INSERT INTO pw_sieve_cards(
      id, run_id, kind, quote_text, quote_source_json, scale_note, scale_value,
      hook_note, freshness_note, sort_score, status, created_at
    ) VALUES(?, ?, ?, '引文', ?, NULL, 1, NULL, NULL, 0, 'pending', ?)
  `).run(
    input.id, input.runId, input.kind ?? "normal",
    input.quoteSourceJson ?? JSON.stringify({ bvid: input.bvid }),
    input.createdAt ?? NOW,
  );
}

function seedBet(
  db: DatabaseSync,
  input: { id: string; sourceCardId?: string; kind?: string; title?: string },
): void {
  db.prepare(`
    INSERT INTO pw_bets(
      id, title, thesis, metric, metric_target, confidence, data_source_plan,
      checkout_date, status, gold_refs_json, created_from, created_at,
      settled_verdict_id, kind, source_card_id
    ) VALUES(?, ?, '假设', NULL, NULL, NULL, NULL, NULL, 'pending', '[]', NULL, ?, NULL, ?, ?)
  `).run(input.id, input.title ?? "押注", NOW, input.kind ?? "content", input.sourceCardId ?? null);
}

function seedVerdict(
  db: DatabaseSync,
  input: { id: string; betId: string; outcome?: string; decidedAt?: string },
): void {
  db.prepare(`
    INSERT INTO pw_verdicts(
      id, bet_id, outcome, lesson, cause_of_death, evidence_doc_ids_json,
      confidence_snapshot, decided_by, decided_at, created_at
    ) VALUES(?, ?, ?, '教训', NULL, '[]', NULL, 'human', ?, ?)
  `).run(input.id, input.betId, input.outcome ?? "gold", input.decidedAt ?? NOW, input.decidedAt ?? NOW);
}

function seedRef(
  db: DatabaseSync,
  input: { id: string; verdictId: string; sourceKind: string; sourceId: string; createdAt?: string },
): void {
  db.prepare(`
    INSERT INTO pw_verdict_refs(
      id, verdict_id, verdict_source, verdict_kind, source_kind, source_id, marker, created_at
    ) VALUES(?, ?, 'paperweight', 'gold', ?, ?, '§1', ?)
  `).run(input.id, input.verdictId, input.sourceKind, input.sourceId, input.createdAt ?? NOW);
}

function seedDraft(
  db: DatabaseSync,
  input: { id: string; betId: string; status?: string; createdAt?: string; updatedAt?: string },
): void {
  db.prepare(`
    INSERT INTO pw_content_drafts(
      id, bet_id, batch_id, route, title_candidate, skeleton_json,
      status, reject_reason, created_at, updated_at
    ) VALUES(?, ?, 'batch', 'route', '标题', '[]', ?, NULL, ?, ?)
  `).run(input.id, input.betId, input.status ?? "draft", input.createdAt ?? NOW, input.updatedAt ?? NOW);
}

function seedMessage(db: DatabaseSync, input: { id: string; betId: string; createdAt?: string }): void {
  db.prepare(`
    INSERT INTO pw_collab_messages(id, bet_id, role, text, tool_calls_json, created_at)
    VALUES(?, ?, 'assistant', '消息', '[]', ?)
  `).run(input.id, input.betId, input.createdAt ?? NOW);
}

/** 造一条 event_type='confirm' 审计行（payloadJson 缺省 {cardId, betId}）。 */
function seedConfirmRun(
  db: DatabaseSync,
  input: { id: string; cardId?: string; payloadJson?: string; createdAt?: string; kind?: string },
): void {
  const payload = input.payloadJson ?? JSON.stringify({ cardId: input.cardId, betId: "x" });
  db.prepare(`
    INSERT INTO pw_runs(
      id, kind, event_type, actor, payload_json, payload_hash,
      parent_id, related_ids_json, bet_id, created_at, instruction_text, instruction_message_id
    ) VALUES(?, ?, 'confirm', 'human', ?, 'hash', NULL, '[]', NULL, ?, NULL, NULL)
  `).run(input.id, input.kind ?? "manual_event", payload, input.createdAt ?? NOW);
}

test("1. 空库：sources 空数组、pendingLanes 固定、产出榜空", () => {
  const db = makeDb();
  try {
    const comparison = getPwSourceComparison(db, { now: NOW });
    assert.deepEqual(comparison.sources, []);
    assert.deepEqual(comparison.pendingLanes, ["书/文章", "笔记"]);
    assert.equal(comparison.notesLane, null, "笔记库不可达 → notesLane=null（屏层回退灰行）");
    assert.equal(comparison.rangeDays, 7);
    assert.equal(comparison.generatedAt, NOW, "注入 now 原样透出");

    const ranking = getPwOutputRanking(db, { now: NOW });
    assert.deepEqual(ranking.ranking, []);
    assert.equal(ranking.rangeDays, 7);
    assert.equal(ranking.generatedAt, NOW);
  } finally {
    db.close();
  }
});

test("2. 单来源全口径：comments=100 / candidates=4 / wildcards=1 / golds=1 / picked=1 / refs=2 / finalized=1 / intoChain=4", () => {
  const db = makeDb();
  try {
    seedDoc(db, { id: "doc-1", bvid: BV1, title: "测试视频", upName: "测试UP", commentCount: 100 });
    seedSieveRun(db, "run-1", "2026-08-02T00:00:00Z");
    for (const id of ["card-1", "card-2", "card-3"]) {
      seedCard(db, { id, runId: "run-1", bvid: BV1, createdAt: "2026-08-02T00:00:00Z" });
    }
    seedCard(db, { id: "card-4", runId: "run-1", kind: "wildcard", bvid: BV1, createdAt: "2026-08-02T00:00:00Z" });
    seedConfirmRun(db, { id: "run-confirm-1", cardId: "card-2", createdAt: "2026-08-02T00:00:00Z" });
    seedBet(db, { id: "bet-1", sourceCardId: "card-2" });
    seedVerdict(db, { id: "v-1", betId: "bet-1", decidedAt: "2026-08-02T00:00:00Z" });
    seedDraft(db, { id: "draft-1", betId: "bet-1", createdAt: "2026-08-02T00:00:00Z" });
    seedDraft(db, {
      id: "draft-2", betId: "bet-1", status: "finalized",
      createdAt: "2026-08-02T00:00:00Z", updatedAt: "2026-08-03T00:00:00Z",
    });
    seedMessage(db, { id: "msg-1", betId: "bet-1", createdAt: "2026-08-02T00:00:00Z" });
    seedMessage(db, { id: "msg-global", betId: "global", createdAt: "2026-08-02T00:00:00Z" });
    seedRef(db, { id: "ref-1", verdictId: "v-1", sourceKind: "content_draft", sourceId: "draft-1", createdAt: "2026-08-02T00:00:00Z" });
    seedRef(db, { id: "ref-2", verdictId: "v-1", sourceKind: "collab_message", sourceId: "msg-1", createdAt: "2026-08-02T00:00:00Z" });
    seedRef(db, { id: "ref-3", verdictId: "v-1", sourceKind: "collab_message", sourceId: "msg-global", createdAt: "2026-08-02T00:00:00Z" });

    const result = getPwSourceComparison(db, { now: NOW });
    assert.equal(result.sources.length, 1);
    assert.deepEqual(result.sources[0], {
      bvid: BV1,
      title: "测试视频",
      upName: "测试UP",
      comments: 100,
      candidates: 4,
      wildcards: 1,
      golds: 1,
      picked: 1,
      refs: 2,
      finalized: 1,
      intoChain: 4,
    });
  } finally {
    db.close();
  }
});

test("3. 窗口过滤：8 天前创建的卡 → 近 7 天 candidates=0、30 天 candidates=1", () => {
  const db = makeDb();
  try {
    seedDoc(db, { id: "doc-1", bvid: BV1 });
    seedSieveRun(db, "run-1", "2026-07-31T00:00:00Z");
    seedCard(db, { id: "card-1", runId: "run-1", bvid: BV1, createdAt: "2026-07-31T00:00:00Z" });

    const days7 = getPwSourceComparison(db, { now: NOW, rangeDays: 7 });
    assert.equal(days7.sources[0].candidates, 0, "8 天前的卡在 7 天窗外");
    const days30 = getPwSourceComparison(db, { now: NOW, rangeDays: 30 });
    assert.equal(days30.sources[0].candidates, 1, "30 天窗内计入");

    const ranking7 = getPwOutputRanking(db, { now: NOW, rangeDays: 7 });
    assert.equal(ranking7.ranking[0].produced, 0, "产出榜同口径随窗");
  } finally {
    db.close();
  }
});

test("4. 评论数存量口径：doc fetched 8 天前，近 7 天行 comments 仍 =100", () => {
  const db = makeDb();
  try {
    seedDoc(db, {
      id: "doc-1", bvid: BV1, commentCount: 100,
      fetchedAt: "2026-07-31T00:00:00Z", createdAt: "2026-07-31T00:00:00Z",
    });
    const result = getPwSourceComparison(db, { now: NOW });
    assert.equal(result.sources.length, 1, "来源行不因时间窗隐藏");
    assert.equal(result.sources[0].comments, 100, "评论数是存量，不随窗");
  } finally {
    db.close();
  }
});

test("5. 零来源计数：doc 无任何卡 → 各计数 0，行仍在（不藏）", () => {
  const db = makeDb();
  try {
    seedDoc(db, { id: "doc-1", bvid: BV1, commentCount: 5 });
    const result = getPwSourceComparison(db, { now: NOW });
    assert.equal(result.sources.length, 1);
    const row = result.sources[0];
    assert.deepEqual(
      [row.candidates, row.wildcards, row.golds, row.picked, row.refs, row.finalized, row.intoChain],
      [0, 0, 0, 0, 0, 0, 0],
    );
    const ranking = getPwOutputRanking(db, { now: NOW });
    assert.equal(ranking.ranking.length, 1, "零产出来源保留在榜");
    assert.equal(ranking.ranking[0].produced, 0);
  } finally {
    db.close();
  }
});

test("6. 产出榜排序：produced desc → picked desc → bvid asc，零产出来源垫底保留", () => {
  const db = makeDb();
  try {
    seedDoc(db, { id: "doc-a", bvid: "BVAAAAAAAAAA", title: "A" });
    seedDoc(db, { id: "doc-b", bvid: "BVBBBBBBBBBB", title: "B" });
    seedDoc(db, { id: "doc-c", bvid: "BVCCCCCCCCCC", title: "C" });
    seedDoc(db, { id: "doc-d", bvid: "BVDDDDDDDDDD", title: "D" });
    seedDoc(db, { id: "doc-e", bvid: "BVEEEEEEEEEE", title: "E" });
    seedSieveRun(db, "run-1", "2026-08-02T00:00:00Z");
    const seedSource = (bvid: string, cards: number, picks: number): void => {
      for (let index = 0; index < cards; index += 1) {
        seedCard(db, { id: `${bvid}-c${index}`, runId: "run-1", bvid, createdAt: "2026-08-02T00:00:00Z" });
      }
      for (let index = 0; index < picks; index += 1) {
        seedConfirmRun(db, { id: `${bvid}-p${index}`, cardId: `${bvid}-c${index}`, createdAt: "2026-08-02T00:00:00Z" });
      }
    };
    seedSource("BVAAAAAAAAAA", 3, 1); // produced 3、picked 1 → 靠后
    seedSource("BVBBBBBBBBBB", 5, 0); // produced 5 → 最前
    seedSource("BVCCCCCCCCCC", 3, 2); // produced 3、picked 2
    seedSource("BVDDDDDDDDDD", 3, 2); // produced 3、picked 2 → 与 C 并列再按 bvid
    // E 零产出 → 垫底仍保留
    seedBet(db, { id: "bet-c", sourceCardId: "BVCCCCCCCCCC-c0" });
    seedVerdict(db, { id: "v-c", betId: "bet-c", decidedAt: "2026-08-02T00:00:00Z" });
    seedMessage(db, { id: "msg-c", betId: "bet-c", createdAt: "2026-08-02T00:00:00Z" });
    seedRef(db, { id: "ref-c", verdictId: "v-c", sourceKind: "collab_message", sourceId: "msg-c", createdAt: "2026-08-02T00:00:00Z" });

    const ranking = getPwOutputRanking(db, { now: NOW });
    assert.deepEqual(
      ranking.ranking.map((row) => row.bvid),
      ["BVBBBBBBBBBB", "BVCCCCCCCCCC", "BVDDDDDDDDDD", "BVAAAAAAAAAA", "BVEEEEEEEEEE"],
    );
    const c = ranking.ranking[1];
    assert.deepEqual(
      { produced: c.produced, picked: c.picked, refCount: c.refCount, title: c.title, upName: c.upName },
      { produced: 3, picked: 2, refCount: 1, title: "C", upName: null },
    );
    const e = ranking.ranking[4];
    assert.equal(e.bvid, "BVEEEEEEEEEE");
    assert.equal(e.produced, 0, "零产出来源保留在榜");
  } finally {
    db.close();
  }
});

test("7. rangeDays 非法（13）→ 按 7 算且返回 rangeDays=7", () => {
  const db = makeDb();
  try {
    seedDoc(db, { id: "doc-1", bvid: BV1 });
    seedSieveRun(db, "run-1", "2026-07-29T00:00:00Z");
    seedCard(db, { id: "card-1", runId: "run-1", bvid: BV1, createdAt: "2026-07-29T00:00:00Z" });

    const comparison = getPwSourceComparison(db, { now: NOW, rangeDays: 13 });
    assert.equal(comparison.rangeDays, 7);
    assert.equal(comparison.sources[0].candidates, 0, "按 7 天窗算，卡在窗外");
    const ranking = getPwOutputRanking(db, { now: NOW, rangeDays: "30" });
    assert.equal(ranking.rangeDays, 7, "字符串 30 也是非法值 → 回退 7");
    const days30 = getPwOutputRanking(db, { now: NOW, rangeDays: 30 });
    assert.equal(days30.ranking[0].produced, 1, "合法 30 天窗该卡计入");
  } finally {
    db.close();
  }
});

test("8. 坏数据韧性：非法 payload_json 不炸不计数；缺 bvid 的卡不炸、归入无", () => {
  const db = makeDb();
  try {
    seedDoc(db, { id: "doc-1", bvid: BV1 });
    seedSieveRun(db, "run-1", "2026-08-02T00:00:00Z");
    seedCard(db, { id: "card-ok", runId: "run-1", bvid: BV1, createdAt: "2026-08-02T00:00:00Z" });
    seedCard(db, {
      id: "card-nobvid", runId: "run-1",
      quoteSourceJson: JSON.stringify({ uname: "匿名" }), createdAt: "2026-08-02T00:00:00Z",
    });
    seedConfirmRun(db, { id: "run-valid", cardId: "card-ok", createdAt: "2026-08-02T00:00:00Z" });
    seedConfirmRun(db, { id: "run-bad-json", payloadJson: "{not json", createdAt: "2026-08-02T00:00:00Z" });
    seedConfirmRun(db, { id: "run-nobvid-card", cardId: "card-nobvid", createdAt: "2026-08-02T00:00:00Z" });

    const result = getPwSourceComparison(db, { now: NOW });
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].candidates, 1, "缺 bvid 的卡不计入 candidates");
    assert.equal(result.sources[0].picked, 1, "非法 JSON 与缺 bvid 卡的 confirm 不计数");
  } finally {
    db.close();
  }
});

test("9. 笔记通路接线：Memos 可达 → notesLane 实行、pendingLanes 只剩书/文章；归档不计", () => {
  const db = makeDb();
  const notesPath = join(tmpdir(), `pw-source-stats-memos-${process.pid}.db`);
  rmSync(notesPath, { force: true });
  const notes = new DatabaseSync(notesPath);
  notes.exec(`
    CREATE TABLE memo (
      id INTEGER PRIMARY KEY,
      created_ts INTEGER NOT NULL,
      row_status TEXT NOT NULL DEFAULT 'NORMAL'
    );
  `);
  const nowSec = Math.floor(Date.now() / 1000);
  const insert = notes.prepare(`INSERT INTO memo (created_ts, row_status) VALUES (?, ?)`);
  insert.run(nowSec, "NORMAL"); // 今天：窗口内
  insert.run(nowSec - 10 * 86_400, "NORMAL"); // 10 天前：7 天窗外、30 天窗内
  insert.run(nowSec, "ARCHIVED"); // 归档：任何口径都不计
  notes.close();
  const saved = process.env.MEMOS_DB_PATH;
  process.env.MEMOS_DB_PATH = notesPath;
  try {
    const lane7 = getPwSourceComparison(db, { now: NOW, rangeDays: 7 });
    assert.deepEqual(lane7.notesLane, { total: 2, addedInRange: 1 }, "7 天窗：总条数 2、窗口新增 1");
    assert.deepEqual(lane7.pendingLanes, ["书/文章"], "笔记实行后灰行只剩书/文章");

    const lane30 = getPwSourceComparison(db, { now: NOW, rangeDays: 30 });
    assert.deepEqual(lane30.notesLane, { total: 2, addedInRange: 2 }, "30 天窗：两条都进窗口");
    assert.equal(lane30.rangeDays, 30);
  } finally {
    if (saved === undefined) delete process.env.MEMOS_DB_PATH;
    else process.env.MEMOS_DB_PATH = saved;
    db.close();
    rmSync(notesPath, { force: true });
  }
});
