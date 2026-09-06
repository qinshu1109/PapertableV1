/**
 * TASK-PW-14（简报 14）：协作台「模式与对账条」只读聚合测试。
 * 覆盖：空库全 0/null；灌入待处理草稿与若干 run 后计数与排序正确；只数待处理状态
 * （已批准/已拒绝/已结/已完成不计）。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ensurePwBetTables } from "./pw-bets.ts";
import { ensurePwCollabTables } from "./pw-collab.ts";
import { ensurePwCorpusTables } from "./pw-corpus.ts";
import { getPwModeBar, PW_MODE_BAR_WRITE_DISCIPLINE } from "./pw-mode-bar.ts";
import { ensurePwRunTables } from "./pw-runs.ts";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwBetTables(db);
  ensurePwCollabTables(db);
  ensurePwCorpusTables(db);
  ensurePwRunTables(db);
  return db;
}

function seedBet(db: DatabaseSync, id: string, status: string): void {
  db.prepare(`
    INSERT INTO pw_bets(id, title, thesis, status, gold_refs_json, created_at, kind)
    VALUES(?, ?, '论点', ?, '[]', '2026-08-01T00:00:00+08:00', 'content')
  `).run(id, `押注 ${id}`, status);
}

function seedSettleDraft(db: DatabaseSync, id: string, betId: string, status: string): void {
  db.prepare(`
    INSERT INTO pw_settle_drafts(id, bet_id, advice_json, draft_hash, status, reject_reason, created_by, created_at)
    VALUES(?, ?, '{}', 'h', ?, NULL, 'ai', '2026-08-02T00:00:00+08:00')
  `).run(id, betId, status);
}

function seedCorpus(db: DatabaseSync, id: string, bvid: string, status: string): void {
  db.prepare(`
    INSERT INTO pw_corpus_docs(id, bvid, title, status, created_at)
    VALUES(?, ?, '标题', ?, '2026-08-03T00:00:00+08:00')
  `).run(id, bvid, status);
}

function seedRun(db: DatabaseSync, id: string, createdAt: string): void {
  db.prepare(`
    INSERT INTO pw_runs(id, kind, event_type, actor, payload_json, payload_hash, related_ids_json, bet_id, created_at)
    VALUES(?, 'manual_event', 'create', 'human', '{}', 'h', '[]', NULL, ?)
  `).run(id, createdAt);
}

test("空库：pendingReview 全 0、recentRuns []、lastActivityAt null、writeDiscipline 固定文案", () => {
  const db = makeDb();
  try {
    const bar = getPwModeBar(db, () => "2026-08-12T12:00:00.000Z");
    assert.equal(bar.generatedAt, "2026-08-12T12:00:00.000Z");
    assert.deepEqual(bar.pendingReview, { betDrafts: 0, settleDrafts: 0, corpusProposed: 0, proposals: 0, total: 0 });
    assert.deepEqual(bar.recentRuns, []);
    assert.equal(bar.lastActivityAt, null);
    assert.equal(bar.writeDiscipline, PW_MODE_BAR_WRITE_DISCIPLINE);
    assert.equal(bar.writeDiscipline, "AI 只摆证据与起草；挑/否/定稿/结账/守门文件改动，只有人能做。");
  } finally {
    db.close();
  }
});

test("灌入待处理草稿与 run：三类计数正确、recentRuns 按 created_at 倒序取 8 条、lastActivityAt 最新", () => {
  const db = makeDb();
  try {
    // 押注草稿：2 draft 计入
    seedBet(db, "draft-1", "draft");
    seedBet(db, "draft-2", "draft");
    // 结账草稿：2 pending 计入
    seedSettleDraft(db, "sd-1", "draft-1", "pending");
    seedSettleDraft(db, "sd-2", "draft-2", "pending");
    // 语料提议：2 proposed 计入
    seedCorpus(db, "c-1", "BV1aaaaaaaaaa", "proposed");
    seedCorpus(db, "c-2", "BV1bbbbbbbbbb", "proposed");
    // runs：10 条，created_at 递增
    for (let i = 1; i <= 10; i += 1) {
      seedRun(db, `run-${i}`, `2026-08-${String(i).padStart(2, "0")}T00:00:00+08:00`);
    }

    const bar = getPwModeBar(db, () => "2026-08-12T12:00:00.000Z");
    assert.deepEqual(bar.pendingReview, { betDrafts: 2, settleDrafts: 2, corpusProposed: 2, proposals: 0, total: 6 });

    // recentRuns：最近 8 条、created_at 倒序（08-10 最先、08-03 第八）
    assert.equal(bar.recentRuns.length, 8);
    assert.equal(bar.recentRuns[0].createdAt, "2026-08-10T00:00:00+08:00");
    assert.equal(bar.recentRuns[7].createdAt, "2026-08-03T00:00:00+08:00");
    assert.deepEqual(Object.keys(bar.recentRuns[0]).sort(), ["betId", "createdAt", "eventType", "kind"]);
    assert.equal(bar.recentRuns[0].kind, "manual_event");
    assert.equal(bar.recentRuns[0].eventType, "create");
    assert.equal(bar.recentRuns[0].betId, null);
    assert.equal(bar.lastActivityAt, "2026-08-10T00:00:00+08:00", "pw_runs 最新 created_at");
  } finally {
    db.close();
  }
});

test("只数待处理状态：已批准/已拒绝/已结/已完成不计入", () => {
  const db = makeDb();
  try {
    // 每类只留 1 条待处理，其余非待处理态全部不计
    seedBet(db, "draft-only", "draft");                    // 计入
    seedBet(db, "pending-1", "pending");                   // 不计（非 draft）
    seedBet(db, "settled-1", "settled");                   // 不计
    seedBet(db, "void-1", "void");                         // 不计
    seedSettleDraft(db, "sd-pending", "draft-only", "pending");   // 计入
    seedSettleDraft(db, "sd-approved", "draft-only", "approved"); // 不计
    seedSettleDraft(db, "sd-rejected", "draft-only", "rejected"); // 不计
    seedCorpus(db, "cp-proposed", "BV1aaaaaaaaaa", "proposed");    // 计入
    seedCorpus(db, "cp-done", "BV1bbbbbbbbbb", "done");            // 不计
    seedCorpus(db, "cp-failed", "BV1cccccccccc", "failed");        // 不计
    seedCorpus(db, "cp-fetching", "BV1dddddddddd", "fetching");    // 不计

    const bar = getPwModeBar(db, () => "2026-08-12T12:00:00.000Z");
    assert.deepEqual(bar.pendingReview, { betDrafts: 1, settleDrafts: 1, corpusProposed: 1, proposals: 0, total: 3 });
  } finally {
    db.close();
  }
});
