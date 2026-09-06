/**
 * TASK-PW-28：起草内容押注通路（draft_bet 补户口）测试。
 * 覆盖：draft 管线 kind 缺省 'verdict' 回归、kind='content' 落库（无/有 sourceCardId）、
 * 户口校验抛错（verdict 挂卡 / content 挂不存在的卡）、content 草稿 confirm 转正后
 * 进 listContentBets（verdict 草稿不进）、draft_bet 工具层 ai_draft 审计 payload 带 kind/sourceCardId。
 * 范式复用 pw-content-bets.test.ts（makeDb / seedCard）。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { nowIso } from "./data.ts";
import { ensurePwBetTables } from "./pw-bets.ts";
import { confirmPwBetDraft, createPwBetDraft, ensurePwDraftTables } from "./pw-drafts.ts";
import { ensurePwRunTables } from "./pw-runs.ts";
import { ensurePwSieveTables } from "./pw-sieve.ts";
import { listContentBets } from "./pw-content-bets.ts";
import { pwCollabTools, type CollabToolContext } from "./pw-collab-tools.ts";

type SieveCardSeed = {
  quote_text?: string;
  quote_source_json?: string;
  status?: "pending" | "picked" | "edited" | "rejected";
};

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwBetTables(db);
  ensurePwSieveTables(db);
  ensurePwRunTables(db);
  ensurePwDraftTables(db);
  return db;
}

/** 造一张筛子候选卡（挂在一个 done run 下），返回卡 id。 */
function seedCard(db: DatabaseSync, seed: SieveCardSeed = {}): string {
  const runId = randomUUID();
  db.prepare(`
    INSERT INTO pw_sieve_runs(
      id, trigger_source, input_ids_json, cards_count, dropped_count,
      status, error, model, created_at, finished_at
    ) VALUES(?, 'manual', '[]', 0, 0, 'done', NULL, NULL, ?, NULL)
  `).run(runId, nowIso());
  const cardId = randomUUID();
  db.prepare(`
    INSERT INTO pw_sieve_cards(
      id, run_id, kind, quote_text, quote_source_json, scale_note, scale_value,
      hook_note, freshness_note, sort_score, status, created_at
    ) VALUES(?, ?, 'normal', ?, ?, NULL, 1, NULL, NULL, 0, ?, ?)
  `).run(
    cardId,
    runId,
    seed.quote_text ?? "私域课定价这么贵还有人买",
    seed.quote_source_json ?? JSON.stringify({ bvid: "BV1NprhBPEtR", uname: "路人甲", like: 42 }),
    seed.status ?? "pending",
    nowIso(),
  );
  return cardId;
}

function betKind(db: DatabaseSync, betId: string): { kind: string; source_card_id: string | null } {
  return db.prepare("SELECT kind, source_card_id FROM pw_bets WHERE id = ?").get(betId) as
    | { kind: string; source_card_id: string | null }
    | undefined;
}

function assertStatus(error: unknown, status: number): void {
  assert.equal((error as { status?: number }).status, status);
}

/** 完整三行赌注的草稿（可 confirm 转正）。 */
function completeDraftInput(overrides: Record<string, unknown> = {}) {
  return {
    title: "切片节奏选题",
    thesis: "真实过程更让人追更",
    metric: "平均播放",
    metricTarget: ">= 5000",
    dataSourcePlan: "B站后台",
    checkoutDate: "2026-09-01",
    ...overrides,
  };
}

test("TASK-PW-28 回归：createPwBetDraft 不传 kind → 行 kind='verdict'", () => {
  const db = makeDb();
  try {
    const draft = createPwBetDraft(db, { title: "判断押注", thesis: "假设" }, "manual");
    const row = betKind(db, draft.id);
    assert.equal(row?.kind, "verdict");
    assert.equal(row?.source_card_id, null);
    assert.equal(draft.status, "draft");
  } finally {
    db.close();
  }
});

test("TASK-PW-28：kind='content' 无 sourceCardId → content/draft、source_card_id 为 NULL", () => {
  const db = makeDb();
  try {
    const draft = createPwBetDraft(
      db,
      { title: "内容选题押注", thesis: "这个选题值得做", kind: "content" },
      "manual",
    );
    const row = betKind(db, draft.id);
    assert.equal(row?.kind, "content");
    assert.equal(row?.source_card_id, null);
    assert.equal(draft.status, "draft");
  } finally {
    db.close();
  }
});

test("TASK-PW-28：kind='content' + 合法 sourceCardId → source_card_id 落列", () => {
  const db = makeDb();
  try {
    const cardId = seedCard(db);
    const draft = createPwBetDraft(
      db,
      { title: "从候选卡聊出的选题", thesis: "这条引文值得验证", kind: "content", sourceCardId: cardId },
      "manual",
    );
    const row = betKind(db, draft.id);
    assert.equal(row?.kind, "content");
    assert.equal(row?.source_card_id, cardId);
  } finally {
    db.close();
  }
});

test("TASK-PW-28：kind='verdict' + sourceCardId → 400 抛错", () => {
  const db = makeDb();
  try {
    const cardId = seedCard(db);
    assert.throws(
      () => createPwBetDraft(
        db,
        { title: "不该挂卡", thesis: "假设", kind: "verdict", sourceCardId: cardId },
        "manual",
      ),
      (error) => {
        assertStatus(error, 400);
        assert.match(String((error as Error).message), /不允许挂候选卡/);
        return true;
      },
    );
  } finally {
    db.close();
  }
});

test("TASK-PW-28：kind='content' + 不存在的 sourceCardId → 400 抛错", () => {
  const db = makeDb();
  try {
    assert.throws(
      () => createPwBetDraft(
        db,
        { title: "挂不存在的卡", thesis: "假设", kind: "content", sourceCardId: "no-such-card" },
        "manual",
      ),
      (error) => {
        assertStatus(error, 400);
        assert.match(String((error as Error).message), /候选卡不存在/);
        return true;
      },
    );
  } finally {
    db.close();
  }
});

test("TASK-PW-28：content 草稿 confirm 转正进 listContentBets（verdict 草稿不进）", () => {
  const db = makeDb();
  try {
    const cardId = seedCard(db);
    const contentDraft = createPwBetDraft(
      db,
      { ...completeDraftInput(), kind: "content", sourceCardId: cardId },
      "manual",
    );
    const verdictDraft = createPwBetDraft(db, completeDraftInput(), "manual");
    confirmPwBetDraft(db, contentDraft.id);
    confirmPwBetDraft(db, verdictDraft.id);
    const listed = listContentBets(db);
    assert.deepEqual(
      listed.map((row) => row.id),
      [contentDraft.id],
      "content 草稿转正后应出现在内容押注列表，verdict 草稿不出现在内",
    );
    assert.equal(listed[0]?.kind, "content");
  } finally {
    db.close();
  }
});

test("TASK-PW-28：draft_bet 工具层（kind='content' + sourceCardId）→ ai_draft 审计 payload 含 kind 与 sourceCardId", async () => {
  const db = makeDb();
  try {
    const cardId = seedCard(db);
    const context: CollabToolContext = { db, betId: "global", refs: new Map() };
    const tool = pwCollabTools.find((candidate) => candidate.name === "draft_bet");
    assert.ok(tool, "工具表应含 draft_bet");
    const result = await tool.execute(
      "call-1",
      {
        title: "切片节奏选题",
        thesis: "真实过程更让人追更",
        metric: "平均播放",
        metricTarget: ">= 5000",
        dataSourcePlan: "B站后台",
        checkoutDate: "2026-09-01",
        kind: "content",
        sourceCardId: cardId,
      },
      undefined,
      undefined,
      context,
    );
    assert.ok(
      (result.content[0] as { text: string }).text.includes("内容押注草稿"),
      "content 草稿返回文本应说明确认转正后会上协作台在途 rail",
    );
    const event = db.prepare(`
      SELECT * FROM pw_runs WHERE kind = 'ai_draft' AND event_type = 'draft'
    `).get() as { payload_json: string } | undefined;
    assert.ok(event, "应有 ai_draft 审计事件");
    const payload = JSON.parse(event.payload_json) as { kind: string; sourceCardId: string };
    assert.equal(payload.kind, "content");
    assert.equal(payload.sourceCardId, cardId);
    const details = result.details as { draftId?: string };
    const row = details.draftId ? betKind(db, details.draftId) : undefined;
    assert.equal(row?.kind, "content");
    assert.equal(row?.source_card_id, cardId);
  } finally {
    db.close();
  }
});
