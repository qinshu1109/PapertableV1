/**
 * TASK-PW-51：方向成绩单（只读聚合）测试。
 * 覆盖规格用例：
 * 1. 空库返回空数组；
 * 2. 两方向各跑过 run 带卡 → 聚合正确（runs 降序、NULL 归「默认」、edited 计入挑中、
 *    0 卡 run 计入轮数）；
 * 3. voice_promotion 哨兵 run 计入其 direction 分组（真实 promotePwVoiceToCard 路径）；
 * 4. GET /api/pw/sieve/direction-stats 路由接线（空库空数组 + 直插 run 后有行）。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ensurePwBetTables } from "./pw-bets.ts";
import { ensurePwArtifactTables } from "./pw-artifacts.ts";
import { ensurePwDataDocTables } from "./pw-data-docs.ts";
import { ensurePwVerdictTables } from "./pw-verdicts.ts";
import { ensurePwRunTables } from "./pw-runs.ts";
import { ensurePwConnectionTables } from "./pw-connections.ts";
import { ensurePwVoiceTables, addPwVoiceItem } from "./pw-voice.ts";
import { ensurePwCorpusTables } from "./pw-corpus.ts";
import {
  ensurePwSieveTables,
  getPwSieveDirectionStats,
  setSieveDirection,
} from "./pw-sieve.ts";
import { promotePwVoiceToCard } from "./pw-voice-promote.ts";
import { createApp, type PapertableApp } from "./main.ts";

type Json = Record<string, unknown>;

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwBetTables(db);
  ensurePwArtifactTables(db);
  ensurePwDataDocTables(db);
  ensurePwVerdictTables(db);
  ensurePwRunTables(db);
  ensurePwConnectionTables(db);
  ensurePwVoiceTables(db);
  ensurePwCorpusTables(db);
  ensurePwSieveTables(db);
  return db;
}

/** 直插一轮 done run + 若干卡（status/kind 可指定；0 张卡 = 空轮也计入 runs）。 */
function seedRun(
  db: DatabaseSync,
  direction: string | null,
  cards: Array<{ status: string; kind?: string }>,
): void {
  const runId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO pw_sieve_runs(
      id, trigger_source, input_ids_json, cards_count, dropped_count,
      status, error, model, direction, created_at, finished_at
    ) VALUES(?, 'manual', '[]', ?, 0, 'done', NULL, NULL, ?, ?, ?)
  `).run(runId, cards.length, direction, now, now);
  for (const card of cards) {
    db.prepare(`
      INSERT INTO pw_sieve_cards(
        id, run_id, kind, quote_text, quote_source_json, scale_note, scale_value,
        hook_note, freshness_note, sort_score, status, created_at
      ) VALUES(?, ?, ?, '引文', '{}', NULL, 0, NULL, NULL, 0, ?, ?)
    `).run(randomUUID(), runId, card.kind ?? "normal", card.status, now);
  }
}

async function listenAndBase(app: PapertableApp): Promise<string> {
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", () => resolve()));
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}

// ---------------------------------------------------------------------------
// 用例 1：空库返回空数组
// ---------------------------------------------------------------------------

test("direction-stats：空库返回空数组", () => {
  const db = makeDb();
  try {
    assert.deepEqual(getPwSieveDirectionStats(db), []);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// 用例 2：两方向聚合正确（runs 降序、NULL 归默认、edited 计入挑中、0 卡 run 计入轮数）
// ---------------------------------------------------------------------------

test("direction-stats：两方向 + NULL 归默认 + edited 计入挑中 + 0 卡 run 计入轮数，按 runs 降序", () => {
  const db = makeDb();
  try {
    // 方向 A：run1（3 卡：pending/picked/rejected）+ run2（0 卡）→ runs 2、cards 3
    seedRun(db, "AI 办公提效", [
      { status: "pending" },
      { status: "picked" },
      { status: "rejected" },
    ]);
    seedRun(db, "AI 办公提效", []);
    // 方向 B：run3（1 卡 edited=带改挑，计入挑中）→ runs 1、cards 1
    seedRun(db, "编程工具对比", [{ status: "edited" }]);
    // NULL → 默认：run4（1 卡 pending）→ runs 1、cards 1
    seedRun(db, null, [{ status: "pending" }]);

    const rows = getPwSieveDirectionStats(db);
    assert.deepEqual(
      rows.map((row) => row.runs),
      [2, 1, 1],
      "按 runs 降序",
    );
    // node:sqlite 行是 null-prototype 对象，展开成普通对象再做深比较
    const a = { ...rows.find((row) => row.direction === "AI 办公提效")! };
    assert.deepEqual(a, {
      direction: "AI 办公提效",
      runs: 2,
      cards: 3,
      picked: 1,
      rejected: 1,
      pending: 1,
    });
    const b = { ...rows.find((row) => row.direction === "编程工具对比")! };
    assert.deepEqual(b, {
      direction: "编程工具对比",
      runs: 1,
      cards: 1,
      picked: 1,
      rejected: 0,
      pending: 0,
    }, "edited 计入挑中（cards = picked + rejected + pending 正好分完）");
    const def = { ...rows.find((row) => row.direction === "默认")! };
    assert.deepEqual(def, {
      direction: "默认",
      runs: 1,
      cards: 1,
      picked: 0,
      rejected: 0,
      pending: 1,
    }, "direction NULL 归「默认」");
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// 用例 3：voice_promotion 哨兵 run 计入其 direction 分组（真实提请路径）
// ---------------------------------------------------------------------------

test("direction-stats：voice_promotion 哨兵 run 计入其 direction 分组", () => {
  const db = makeDb();
  try {
    setSieveDirection(db, "AI 办公提效");
    seedRun(db, "AI 办公提效", [{ status: "pending" }]);
    // 真实提请：哨兵 run + 1 张 pending 卡，direction 取当前快照「AI 办公提效」
    const voice = addPwVoiceItem(db, {
      platform: "bilibili",
      author: "观众甲",
      content: "希望出个踩坑合集",
      capturedAt: "2026-08-04T00:00:00.000Z",
    });
    const { runId, card } = promotePwVoiceToCard(db, voice.id);
    const run = db.prepare("SELECT trigger_source, direction FROM pw_sieve_runs WHERE id = ?")
      .get(runId) as { trigger_source: string; direction: string | null };
    assert.equal(run.trigger_source, "voice_promotion");
    assert.equal(run.direction, "AI 办公提效");
    assert.equal(
      db.prepare("SELECT status FROM pw_sieve_cards WHERE id = ?").get(card.id).status,
      "pending",
    );

    const rows = getPwSieveDirectionStats(db);
    assert.equal(rows.length, 1, "哨兵 run 归入已有方向分组，不新开方向");
    assert.deepEqual({ ...rows[0] }, {
      direction: "AI 办公提效",
      runs: 2,
      cards: 2,
      picked: 0,
      rejected: 0,
      pending: 2,
    }, "哨兵 run 计入该 direction 的 runs 与其卡计入 cards/pending");
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// 用例 4：GET /api/pw/sieve/direction-stats 路由接线
// ---------------------------------------------------------------------------

test("GET /api/pw/sieve/direction-stats：空库返回空数组；直插 run 后有行", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pw-dir-stats-"));
  let app: PapertableApp | undefined;
  try {
    app = await createApp(dir);
    const base = await listenAndBase(app);

    const empty = (await fetch(`${base}/api/pw/sieve/direction-stats`).then((r) => r.json())) as Json;
    assert.deepEqual(empty.rows, [], "空库空数组");

    // 直插两方向 run + 卡，再查（AI 办公提效 2 轮 > 默认 1 轮，runs 降序可确定性断言）
    seedRun(app.store.db, "AI 办公提效", [{ status: "pending" }]);
    seedRun(app.store.db, "AI 办公提效", [{ status: "rejected" }]);
    seedRun(app.store.db, null, [{ status: "rejected" }]);
    const body = (await fetch(`${base}/api/pw/sieve/direction-stats`).then((r) => r.json())) as {
      rows: Array<Record<string, unknown>>;
    };
    assert.equal(body.rows.length, 2);
    assert.equal(body.rows[0].direction, "AI 办公提效", "runs 降序：2 组先出");
    const def = body.rows.find((row) => row.direction === "默认") as Record<string, number>;
    assert.deepEqual(
      { runs: def.runs, cards: def.cards, rejected: def.rejected },
      { runs: 1, cards: 1, rejected: 1 },
    );
  } finally {
    if (app) await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
