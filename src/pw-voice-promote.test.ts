/**
 * TASK-PW-45：观众声音提升链测试。
 * 覆盖规格第 5 条全部用例：
 * 1. trigger_source CHECK 迁移幂等（二次 ensure 不炸、旧行保留、新 trigger 可写、外键不丢行）；
 * 2. promote 成功（卡字段逐字 / kind 映射两态 / 哨兵 run direction 快照 / 回写 / 两路账）；
 * 3. 409 三连（重复提升带既有卡 id / 噪音 / 已丢弃）；
 * 4. exec 工具 promote_voice_to_card 缺 instruction → 500；
 * 5. 事务回滚（模拟产卡失败 → run 与回写都不留、不落账）。
 * 另补：工具人发话 happy path（产卡 + 单条 ai_exec(voice) + 回文报卡 id 与区）。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pwCollabTools, type CollabToolContext } from "./pw-collab-tools.ts";
import { ensurePwRunTables } from "./pw-runs.ts";
import { ensurePwSieveTables, getSieveDirection, setSieveDirection } from "./pw-sieve.ts";
import { dropPwVoiceItem, ensurePwVoiceTables } from "./pw-voice.ts";
import { ensurePwArtifactTables } from "./pw-artifacts.ts";
import { promotePwVoiceToCard } from "./pw-voice-promote.ts";

type Json = Record<string, unknown>;

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwVoiceTables(db);
  ensurePwRunTables(db);
  ensurePwSieveTables(db);
  ensurePwArtifactTables(db);
  return db;
}

/** 直插声音行（绕过 addPwVoiceItem 的录入账，让 promote 账断言干净）。 */
function insertVoice(db: DatabaseSync, content: string, signalType: string | null = null): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO pw_voice_items(
      id, artifact_id, platform, author_hash, content, captured_at,
      signal_type, cluster_id, promoted_to_draft_id, dropped_reason, created_at
    ) VALUES(?, NULL, 'bilibili', 'hash', ?, ?, ?, NULL, NULL, NULL, ?)
  `).run(id, content, "2026-08-01T00:00:00Z", signalType, "2026-08-01T00:00:00Z");
  return id;
}

function hasStatus(error: unknown, status: number): boolean {
  return typeof error === "object" && error !== null && "status" in error
    && (error as { status: unknown }).status === status;
}

function requireTool(name: string) {
  const tool = pwCollabTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`工具不存在: ${name}`);
  return tool;
}

// ---------------------------------------------------------------------------
// 1. trigger_source CHECK 迁移（重建表，幂等；外键不丢行）
// ---------------------------------------------------------------------------

test("PW-45 迁移：旧库 pw_sieve_runs 重建含 voice_promotion，二次 ensure 幂等，旧行与外键不丢", () => {
  const db = new DatabaseSync(":memory:");
  try {
    // 造 PW-42 时代的旧表（CHECK 无 voice_promotion，带 direction 列）+ 旧卡引用旧 run
    db.exec(`
      CREATE TABLE pw_sieve_runs (
        id TEXT PRIMARY KEY,
        trigger_source TEXT NOT NULL CHECK(trigger_source IN (
          'sync','corpus_done','manual_entry','voice','open_fallback','watermark','manual'
        )),
        input_ids_json TEXT NOT NULL,
        cards_count INTEGER NOT NULL DEFAULT 0,
        dropped_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK(status IN ('running','done','failed')),
        error TEXT,
        model TEXT,
        direction TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE TABLE pw_sieve_cards (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES pw_sieve_runs(id),
        kind TEXT NOT NULL CHECK(kind IN ('normal','wildcard')),
        quote_text TEXT NOT NULL,
        quote_source_json TEXT NOT NULL,
        scale_note TEXT,
        scale_value INTEGER NOT NULL DEFAULT 0,
        hook_note TEXT,
        freshness_note TEXT,
        sort_score REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','picked','edited','rejected')),
        created_at TEXT NOT NULL
      );
      INSERT INTO pw_sieve_runs(
        id, trigger_source, input_ids_json, cards_count, dropped_count,
        status, error, model, direction, created_at, finished_at
      ) VALUES(
        'old-run-1', 'sync', '[]', 2, 0, 'done', NULL, 'm', '旧方向',
        '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:01.000Z'
      );
      INSERT INTO pw_sieve_cards(
        id, run_id, kind, quote_text, quote_source_json, scale_note, scale_value,
        hook_note, freshness_note, sort_score, status, created_at
      ) VALUES(
        'old-card-1', 'old-run-1', 'normal', '旧引文', '{}', NULL, 1,
        NULL, NULL, 0, 'pending', '2026-08-01T00:00:00.000Z'
      );
    `);
    // 二次 ensure：第一次触发重建迁移，第二次幂等不炸
    ensurePwSieveTables(db);
    ensurePwSieveTables(db);

    const definition = (db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pw_sieve_runs'
    `).get() as { sql?: string }).sql ?? "";
    assert.ok(definition.includes("voice_promotion"), "迁移后 CHECK 含 voice_promotion");

    // 旧行保留（run 与引用它的卡都不丢）
    const oldRun = db.prepare("SELECT * FROM pw_sieve_runs WHERE id = 'old-run-1'").get() as Json;
    assert.ok(oldRun, "旧 run 行保留");
    assert.equal(oldRun.direction, "旧方向", "旧行方向数据保留");
    const oldCard = db.prepare("SELECT * FROM pw_sieve_cards WHERE id = 'old-card-1'").get() as Json;
    assert.ok(oldCard, "旧卡行保留（外键引用不得丢行）");
    assert.equal(oldCard.run_id, "old-run-1");

    // 新 trigger_source 可写
    db.prepare(`
      INSERT INTO pw_sieve_runs(
        id, trigger_source, input_ids_json, cards_count, dropped_count,
        status, error, model, direction, created_at, finished_at
      ) VALUES(
        'new-run-1', 'voice_promotion', '["v-1"]', 1, 0, 'done', NULL, NULL, NULL,
        '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z'
      )
    `).run();

    // 外键仍生效：引用不存在的 run 会被拒
    assert.throws(() => db.prepare(`
      INSERT INTO pw_sieve_cards(
        id, run_id, kind, quote_text, quote_source_json, scale_note, scale_value,
        hook_note, freshness_note, sort_score, status, created_at
      ) VALUES(
        'bad-card', 'no-such-run', 'normal', 'q', '{}', NULL, 0,
        NULL, NULL, 0, 'pending', '2026-08-02T00:00:00.000Z'
      )
    `).run(), /FOREIGN KEY|constraint/u);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// 2. promote 成功：卡字段逐字 / kind 两态 / 哨兵 run / 回写 / 两路账
// ---------------------------------------------------------------------------

test("promote 成功：卡字段逐字 + 哨兵 run（direction 快照/同刻完成/model NULL）+ 回写 + human 账", () => {
  const db = database();
  try {
    setSieveDirection(db, "AI 办公提效");
    const voiceId = insertVoice(db, "直播做产品实践这个实验设计得真巧妙", "topic_lead");
    const { runId, card } = promotePwVoiceToCard(db, voiceId);
    // 提请后再换方向，哨兵 run 的快照不变
    setSieveDirection(db, "换后的方向");

    // 卡：逐字、kind=normal（topic_lead → 证据区）、pending、零分
    assert.equal(card.kind, "normal");
    assert.equal(card.quote_text, "直播做产品实践这个实验设计得真巧妙", "quote_text 必须逐字");
    const source = JSON.parse(card.quote_source_json) as Json;
    assert.equal(source.bvid, "voice");
    assert.equal(source.uname, "观众声音·bilibili");
    assert.equal(source.voice_id, voiceId);
    assert.equal(source.signal_type, "topic_lead");
    assert.equal(source.like, null);
    assert.equal(source.rpid, null);
    assert.equal(card.scale_note, null);
    assert.equal(card.hook_note, null);
    assert.equal(card.freshness_note, null);
    assert.equal(card.scale_value, 0);
    assert.equal(card.sort_score, 0);
    assert.equal(card.status, "pending");

    // 哨兵 run：trigger_source / input / 计数 / done / 方向快照 / model NULL / 同刻完成
    const run = db.prepare("SELECT * FROM pw_sieve_runs WHERE id = ?").get(runId) as Json;
    assert.ok(run, "哨兵 run 存在");
    assert.equal(run.trigger_source, "voice_promotion");
    assert.equal(run.input_ids_json, JSON.stringify([voiceId]));
    assert.equal(run.cards_count, 1);
    assert.equal(run.dropped_count, 0);
    assert.equal(run.status, "done");
    assert.equal(run.error, null);
    assert.equal(run.model, null);
    assert.equal(run.direction, "AI 办公提效", "direction 必须是提请时点的快照");
    assert.equal(run.created_at, run.finished_at, "created_at=finished_at 同刻");

    // 回写防重
    const voice = db.prepare("SELECT * FROM pw_voice_items WHERE id = ?").get(voiceId) as Json;
    assert.equal(voice.promoted_to_draft_id, card.id);

    // 两路账之一：缺省 human(voice)，payload 含 voiceId/cardId/runId
    const runs = db.prepare("SELECT * FROM pw_runs").all() as Array<{ kind: string; event_type: string; actor: string; payload_json: string }>;
    assert.equal(runs.length, 1, "直插声音 + promote 缺省账 = 恰一条");
    assert.equal(runs[0].kind, "manual_event");
    assert.equal(runs[0].event_type, "voice");
    assert.equal(runs[0].actor, "human");
    assert.deepEqual(JSON.parse(runs[0].payload_json), { voiceId, cardId: card.id, runId });
  } finally {
    db.close();
  }
});

test("promote 成功：kind 映射——content_critique → wildcard 少数派区；未分拣 → normal", () => {
  const db = database();
  try {
    const critique = insertVoice(db, "批评：这个选题方向不对", "content_critique");
    const unprocessed = insertVoice(db, "还没分拣的观众原话", null);
    const form = insertVoice(db, "形式建议：节奏再紧凑些", "form_suggestion");

    const critiqueCard = promotePwVoiceToCard(db, critique).card;
    assert.equal(critiqueCard.kind, "wildcard", "content_critique（批评）→ wildcard 少数派区");
    const unprocessedCard = promotePwVoiceToCard(db, unprocessed).card;
    assert.equal(unprocessedCard.kind, "normal", "NULL（未分拣）→ normal 证据区");
    const formCard = promotePwVoiceToCard(db, form).card;
    assert.equal(formCard.kind, "normal", "form_suggestion → normal 证据区");
  } finally {
    db.close();
  }
});

test("promote 成功：audit 传入 → 单条 ai_exec(voice)，无双账；无方向时 run.direction 为 NULL", () => {
  const db = database();
  try {
    assert.equal(getSieveDirection(db), null, "未设方向");
    const voiceId = insertVoice(db, "带审计路径的声音");
    const { card } = promotePwVoiceToCard(db, voiceId, {
      actor: "ai",
      instructionText: "把这条声音提请候选",
      instructionMessageId: "msg-promote",
    });
    const run = db.prepare("SELECT * FROM pw_sieve_runs").get() as Json;
    assert.equal(run.direction, null, "无方向时哨兵 run.direction 为 NULL");
    const exec = db.prepare("SELECT * FROM pw_runs WHERE kind = 'ai_exec'").get() as Json;
    assert.ok(exec, "恰一条 ai_exec 账");
    assert.equal(exec.event_type, "voice");
    assert.equal(exec.actor, "ai");
    assert.equal(exec.instruction_text, "把这条声音提请候选");
    assert.equal(exec.instruction_message_id, "msg-promote");
    assert.deepEqual(JSON.parse(String(exec.payload_json)), {
      voiceId,
      cardId: card.id,
      runId: run.id,
    });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pw_runs WHERE kind = 'manual_event'").get().n, 0, "audit 路径不得双账");
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// 3. 409 三连：重复提升（带既有卡 id）/ 噪音 / 已丢弃
// ---------------------------------------------------------------------------

test("promote 409 三连：重复提升带既有卡 id；噪音拒绝；已丢弃拒绝", async () => {
  const db = database();
  try {
    // (1) 重复提升：报错带既有卡 id
    const voiceId = insertVoice(db, "重复提请的声音");
    const first = promotePwVoiceToCard(db, voiceId);
    await assert.rejects(async () => promotePwVoiceToCard(db, voiceId), (error: unknown) => {
      assert.ok(hasStatus(error, 409), "重复提升应 409");
      assert.ok(String((error as Error).message).includes(first.card.id), "报错信息带既有卡 id");
      return true;
    });
    // (2) 噪音
    const noiseId = insertVoice(db, "纯广告噪音", "noise");
    await assert.rejects(async () => promotePwVoiceToCard(db, noiseId), (error: unknown) => {
      assert.ok(hasStatus(error, 409), "噪音应 409");
      assert.match(String((error as Error).message), /噪音不进候选/);
      return true;
    });
    // (3) 已丢弃
    const droppedId = insertVoice(db, "被丢过的声音");
    dropPwVoiceItem(db, droppedId, "低质");
    await assert.rejects(async () => promotePwVoiceToCard(db, droppedId), (error: unknown) => {
      assert.ok(hasStatus(error, 409), "已丢弃应 409");
      assert.match(String((error as Error).message), /已丢弃/);
      return true;
    });
    // (4) 条目不存在 404
    await assert.rejects(async () => promotePwVoiceToCard(db, "no-such-voice"), (error: unknown) =>
      hasStatus(error, 404));
    // 以上失败路径全部零产出
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pw_sieve_runs").get().n, 1, "只有第一次成功产 run");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pw_sieve_cards").get().n, 1, "只有第一次成功产卡");
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// 4. exec 工具 promote_voice_to_card：缺 instruction → 500；人发话 happy path
// ---------------------------------------------------------------------------

test("promote_voice_to_card 缺 instruction → 500，且零产出", async () => {
  const db = database();
  try {
    const voiceId = insertVoice(db, "缺指令的声音");
    const context: CollabToolContext = { db, betId: "bet-x", refs: new Map() };
    await assert.rejects(
      requireTool("promote_voice_to_card").execute("call-1", { voiceId }, undefined, undefined, context),
      (error: unknown) => hasStatus(error, 500),
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pw_sieve_runs").get().n, 0, "缺指令不得产 run");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pw_sieve_cards").get().n, 0, "缺指令不得产卡");
  } finally {
    db.close();
  }
});

test("promote_voice_to_card 人发话执行：产卡 + 单条 ai_exec(voice) + 回文报卡 id 与区", async () => {
  const db = database();
  try {
    const voiceId = insertVoice(db, "对话里提请的声音", "content_critique");
    const result = await requireTool("promote_voice_to_card").execute(
      "call-1",
      { voiceId },
      undefined,
      undefined,
      {
        db,
        betId: "bet-x",
        refs: new Map(),
        instruction: { text: "把这条声音提请候选", messageId: "msg-p" },
      },
    );
    const text = result.content[0].text;
    assert.match(text, /少数派区/, "批评类回文报少数派区");
    assert.match(text, /候选卡/);
    const exec = db.prepare("SELECT * FROM pw_runs WHERE kind = 'ai_exec'").get() as Json;
    assert.ok(exec, "恰一条 ai_exec");
    assert.equal(exec.event_type, "voice");
    assert.equal(exec.instruction_message_id, "msg-p");
    const card = db.prepare("SELECT * FROM pw_sieve_cards").get() as Json;
    assert.ok(text.includes(String(card.id)), "回文带卡 id");
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// 5. 事务回滚：模拟产卡失败 → 哨兵 run 与回写都不留、不落账
// ---------------------------------------------------------------------------

test("promote 事务回滚：产卡失败 → run 与回写都不留、不落账", () => {
  const db = database();
  try {
    const voiceId = insertVoice(db, "事务回滚的声音");
    // 让卡 INSERT 必炸：BEFORE INSERT 触发器 RAISE(ABORT)
    db.exec(`
      CREATE TRIGGER fail_card_insert BEFORE INSERT ON pw_sieve_cards
      BEGIN
        SELECT RAISE(ABORT, 'simulated card insert failure');
      END;
    `);
    assert.throws(() => promotePwVoiceToCard(db, voiceId), /simulated card insert failure/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pw_sieve_runs").get().n, 0, "run 不留");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pw_sieve_cards").get().n, 0, "卡不留");
    const voice = db.prepare("SELECT * FROM pw_voice_items WHERE id = ?").get(voiceId) as Json;
    assert.equal(voice.promoted_to_draft_id, null, "回写不留");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pw_runs").get().n, 0, "失败不落账");
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// 6. read_voice 全局模式（PW-45 冒烟缺口补丁：游离声音在对话层可见可指认）
// ---------------------------------------------------------------------------

test("read_voice 全局会话：列出全部未丢弃声音（含游离）带完整 voiceId 与已提请标记", async () => {
  const db = database();
  try {
    const freeId = insertVoice(db, "游离声音不挂任何卡", "topic_lead");
    const droppedId = insertVoice(db, "已丢弃的声音", null);
    dropPwVoiceItem(db, droppedId, "测试丢弃");
    const promotedId = insertVoice(db, "已提请的声音", null);
    promotePwVoiceToCard(db, promotedId);
    const result = await requireTool("read_voice").execute(
      "call-g",
      {},
      undefined,
      undefined,
      { db, betId: "global", refs: new Map() },
    );
    const text = result.content[0].text;
    assert.ok(text.includes(`voiceId=${freeId}`), "游离声音带完整 id 可见");
    assert.ok(!text.includes("已丢弃的声音"), "已丢弃不显示");
    assert.ok(text.includes("已提请"), "已提请标记在");
  } finally {
    db.close();
  }
});

test("read_voice 指定 betId：游离声音不出现（JOIN 语义回归）", async () => {
  const db = database();
  try {
    insertVoice(db, "游离声音不挂任何卡", null);
    const result = await requireTool("read_voice").execute(
      "call-b",
      { betId: "bet-none" },
      undefined,
      undefined,
      { db, betId: "bet-none", refs: new Map() },
    );
    assert.match(result.content[0].text, /尚无关联观众声音/, "游离条目不混入按卡视图");
  } finally {
    db.close();
  }
});
