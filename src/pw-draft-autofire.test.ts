/**
 * TASK-PW-33：自动起草发动与定稿挂载测试（内存库自包含，照 pw-draft-pipeline.test.ts /
 * pw-content-bets.test.ts 先例）。
 * 覆盖规格 §7 八组：黑名单全通路 / 发动成功（trigger 进留痕）/ 拉黑不发动 /
 * 非 content 不发动 / 已有草案不发动 / 管线失败绝不 reject / 定稿挂载 / 挂载原子性。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { nowIso } from "./data.ts";
import { createPwBet, ensurePwBetTables, getPwBet } from "./pw-bets.ts";
import { ensurePwDataDocTables } from "./pw-data-docs.ts";
import { ensurePwCorpusTables } from "./pw-corpus.ts";
import { pickPwSieveCard } from "./pw-content-bets.ts";
import { ensurePwArtifactTables, listPwArtifacts } from "./pw-artifacts.ts";
import {
  createPwContentDrafts,
  ensurePwContentDraftTables,
  finalizePwContentDraft,
  getPwContentDraft,
  listPwContentDraftsByBet,
} from "./pw-content-drafts.ts";
import { ensurePwGoldMirrorTables } from "./pw-gold-sync.ts";
import { ensurePwRunTables } from "./pw-runs.ts";
import { ensurePwSieveTables } from "./pw-sieve.ts";
import { ensurePwVerdictTables } from "./pw-verdicts.ts";
import { ensurePwVerdictRefTables } from "./pw-verdict-refs.ts";
import {
  addPwDraftBlacklist,
  ensurePwDraftBlacklistTables,
  isPwDraftBlacklisted,
  listPwDraftBlacklist,
  maybeAutoFirePwDraft,
  removePwDraftBlacklist,
} from "./pw-draft-autofire.ts";
import type { DraftLlm } from "./pw-draft-pipeline.ts";

type Json = Record<string, unknown>;

// ---- 内存库与种子 ----

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwBetTables(db);
  ensurePwSieveTables(db);
  ensurePwRunTables(db);
  ensurePwContentDraftTables(db);
  ensurePwVerdictTables(db);
  ensurePwGoldMirrorTables(db);
  ensurePwVerdictRefTables(db);
  ensurePwDataDocTables(db);
  ensurePwCorpusTables(db);
  ensurePwDraftBlacklistTables(db);
  ensurePwArtifactTables(db);
  return db;
}

/** 造一张筛子候选卡（挂在一个 done run 下），返回卡 id。 */
function seedCard(db: DatabaseSync): string {
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
    ) VALUES(?, ?, 'normal', ?, ?, NULL, 1, NULL, NULL, 0, 'pending', ?)
  `).run(
    cardId,
    runId,
    "私域课定价这么贵还有人买",
    JSON.stringify({ bvid: "BV1NprhBPEtR", uname: "路人甲", like: 42 }),
    nowIso(),
  );
  return cardId;
}

/** 挑一张卡成在途内容押注（kind=content、status=pending）。 */
function seedContentBet(db: DatabaseSync): { betId: string; cardId: string } {
  const cardId = seedCard(db);
  const bet = pickPwSieveCard(db, cardId);
  return { betId: bet.id, cardId };
}

/** mock llm：直接返回写死的草案数组 JSON。 */
function mockDraftLlm(drafts: unknown[]): DraftLlm {
  return async () => JSON.stringify(drafts);
}

/** 6 节点大纲（节点数落在 5–7 区间）。 */
function sixNodes(prefix: string): Array<{ text: string; gold_ref: string | null }> {
  return Array.from({ length: 6 }, (_, i) => ({ text: `${prefix}节点${i + 1}`, gold_ref: null }));
}

/** 标准三路载荷（每份 6 节点）。 */
function threeRoutePayload(): unknown[] {
  return [
    { route: "贴热点", title_candidate: "热点标题候选", skeleton: sixNodes("贴热点") },
    { route: "少数派", title_candidate: "少数派标题候选", skeleton: sixNodes("少数派") },
    { route: "反共识", title_candidate: "反共识标题候选", skeleton: sixNodes("反共识") },
  ];
}

function countRows(db: DatabaseSync, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

function countAiDraftEvents(db: DatabaseSync): number {
  return Number((db.prepare(
    "SELECT COUNT(*) AS n FROM pw_runs WHERE kind = 'ai_draft' AND event_type = 'draft'",
  ).get() as { n: number }).n);
}

function assertStatus(error: unknown, status: number): void {
  assert.equal((error as { status?: number }).status, status);
}

function is404(error: unknown): boolean {
  assertStatus(error, 404);
  return true;
}

// ---- 测试清单（规格 §7 八组）----

test("1. 黑名单：ensure 幂等；add/is/list/remove 全走通；add 重复幂等不报错不覆盖 reason；remove 不存在 404；两笔黑名单账 action 正确", () => {
  const db = makeDb();
  try {
    ensurePwDraftBlacklistTables(db); // ensure 幂等再跑

    const { betId } = seedContentBet(db);
    const bet = getPwBet(db, betId)!;

    const added = addPwDraftBlacklist(db, betId, "先压着");
    assert.equal(added.bet_id, betId);
    assert.equal(added.reason, "先压着");
    assert.ok(added.created_at);
    assert.equal(isPwDraftBlacklisted(db, betId), true);

    const listed = listPwDraftBlacklist(db);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].bet_id, betId);
    assert.equal(listed[0].bet_title, bet.title, "联查押注标题");
    assert.equal(listed[0].reason, "先压着");

    // add 重复：幂等不报错、reason 不覆盖
    const again = addPwDraftBlacklist(db, betId, "换了理由");
    assert.equal(again.reason, "先压着", "已存在不覆盖 reason");
    assert.equal(listPwDraftBlacklist(db).length, 1);

    // remove 成功
    const removed = removePwDraftBlacklist(db, betId);
    assert.equal(removed.bet_id, betId);
    assert.equal(isPwDraftBlacklisted(db, betId), false);
    assert.equal(listPwDraftBlacklist(db).length, 0);

    // remove 不存在 → 404；add 不存在的押注 → 404
    assert.throws(() => removePwDraftBlacklist(db, betId), is404);
    assert.throws(() => addPwDraftBlacklist(db, "no-such-bet"), is404);

    // 账：add×2 + remove×1 各一笔 edit 账，action 正确
    const events = db.prepare(`
      SELECT payload_json FROM pw_runs
      WHERE kind = 'manual_event' AND event_type = 'edit' AND bet_id = ?
      ORDER BY rowid ASC
    `).all(betId) as Array<{ payload_json: string }>;
    assert.equal(events.length, 3, "add×2 + remove×1 各留一笔 edit 账");
    assert.deepEqual(
      events.map((row) => (JSON.parse(row.payload_json) as { action: string }).action),
      ["draft_blacklist_add", "draft_blacklist_add", "draft_blacklist_remove"],
    );
  } finally {
    db.close();
  }
});

test("2. 发动成功：content+pending 押注 + mock llm 出三份 → {fired:true}，三份草案落库，ai_draft/draft 事件 payload trigger==='confirm_bet_draft'", async () => {
  const db = makeDb();
  try {
    const { betId } = seedContentBet(db);
    const result = await maybeAutoFirePwDraft(db, betId, {
      trigger: "confirm_bet_draft",
      llm: mockDraftLlm(threeRoutePayload()),
    });

    assert.equal(result.fired, true);
    assert.equal(countRows(db, "pw_content_drafts"), 3, "三份草案落库");
    const drafts = listPwContentDraftsByBet(db, betId);
    assert.equal(drafts.length, 3);
    assert.ok(drafts.every((row) => row.status === "draft"));

    const event = db.prepare(`
      SELECT * FROM pw_runs WHERE kind = 'ai_draft' AND event_type = 'draft'
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get() as Json;
    assert.ok(event, "应有 ai_draft/draft 留痕");
    const payload = JSON.parse(String(event.payload_json)) as Json;
    assert.equal(payload.trigger, "confirm_bet_draft");
    assert.equal(payload.created, 3);
    assert.equal(payload.betId, betId);
  } finally {
    db.close();
  }
});

test("3. 拉黑不发动：先 add 黑名单 → {fired:false}；零草案、零新 ai_draft 事件", async () => {
  const db = makeDb();
  try {
    const { betId } = seedContentBet(db);
    addPwDraftBlacklist(db, betId);

    const result = await maybeAutoFirePwDraft(db, betId, {
      trigger: "pick_sieve_card",
      llm: mockDraftLlm(threeRoutePayload()),
    });
    assert.equal(result.fired, false);
    assert.equal(result.reason, "押注在起草黑名单");
    assert.equal(countRows(db, "pw_content_drafts"), 0, "零草案");
    assert.equal(countAiDraftEvents(db), 0, "守卫未过零新 ai_draft 事件");
  } finally {
    db.close();
  }
});

test("4. 非 content 押注（kind='verdict'）→ {fired:false} 零草案", async () => {
  const db = makeDb();
  try {
    const verdictBet = createPwBet(db, {
      title: "传统押注",
      thesis: "假设",
      status: "pending",
      metric: "播放量",
      data_source_plan: "B站",
      checkout_date: "2026-08-15",
    });
    assert.equal(verdictBet.kind, "verdict");

    const result = await maybeAutoFirePwDraft(db, verdictBet.id, {
      trigger: "confirm_bet_draft",
      llm: mockDraftLlm(threeRoutePayload()),
    });
    assert.equal(result.fired, false);
    assert.match(result.reason ?? "", /非 content/);
    assert.equal(countRows(db, "pw_content_drafts"), 0);
    assert.equal(countAiDraftEvents(db), 0);
  } finally {
    db.close();
  }
});

test("5. 已有草案的押注 → {fired:false, reason 含 '已有草案'} 不重复发动", async () => {
  const db = makeDb();
  try {
    const { betId } = seedContentBet(db);
    createPwContentDrafts(db, betId, [{
      route: "贴热点",
      titleCandidate: "已有草案",
      skeletonJson: JSON.stringify([{ text: "骨架" }]),
    }]);

    const result = await maybeAutoFirePwDraft(db, betId, {
      trigger: "confirm_bet_draft",
      llm: mockDraftLlm(threeRoutePayload()),
    });
    assert.equal(result.fired, false);
    assert.ok((result.reason ?? "").includes("已有草案"), "reason 应含「已有草案」");
    assert.equal(countRows(db, "pw_content_drafts"), 1, "不重复发动");
    assert.equal(countAiDraftEvents(db), 0, "守卫未过零新 ai_draft 事件");
  } finally {
    db.close();
  }
});

test("6. 管线失败兜底：mock llm 两次都抛 → 绝不 reject；库里有 ai_draft/draft 失败痕（管线自留）；押注仍 pending", async () => {
  const db = makeDb();
  try {
    const { betId } = seedContentBet(db);
    const alwaysFail: DraftLlm = async () => {
      throw new Error("模型两炸");
    };

    const result = await maybeAutoFirePwDraft(db, betId, {
      trigger: "confirm_bet_draft",
      llm: alwaysFail,
    });
    // 绝不 reject：fired 可为 true（已发动、管线自记失败）或 false，都在允许范围内
    assert.equal(typeof result.fired, "boolean");

    const failureEvent = db.prepare(`
      SELECT * FROM pw_runs WHERE kind = 'ai_draft' AND event_type = 'draft'
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get() as Json;
    assert.ok(failureEvent, "库里有 ai_draft/draft 失败痕（管线自留）");
    const payload = JSON.parse(String(failureEvent.payload_json)) as Json;
    assert.equal(payload.created, 0);
    assert.ok(String(payload.error).includes("模型两炸"), "失败痕含模型错误");
    assert.equal(payload.trigger, "confirm_bet_draft");

    assert.equal(getPwBet(db, betId)!.status, "pending", "发动失败不影响押注成立");
    assert.equal(countRows(db, "pw_content_drafts"), 0);
  } finally {
    db.close();
  }
});

test("7. 定稿挂载：draft 定稿 → pw_artifacts 多一行（platform='paperweight'、type='article'、title=title_candidate、note 含 draft id 与 route）；confirm 事件 payload 含 artifactId；押注状态不变", () => {
  const db = makeDb();
  try {
    const { betId } = seedContentBet(db);
    const [draft] = createPwContentDrafts(db, betId, [{
      route: "贴热点",
      titleCandidate: "定稿标题候选",
      skeletonJson: JSON.stringify([{ text: "骨架一" }, { text: "骨架二" }]),
    }]);
    const artifactsBefore = countRows(db, "pw_artifacts");
    const betStatusBefore = getPwBet(db, betId)!.status;

    const finalized = finalizePwContentDraft(db, draft.id);
    assert.equal(finalized.status, "finalized");

    const artifacts = listPwArtifacts(db, betId);
    assert.equal(artifacts.length, artifactsBefore + 1, "pw_artifacts 多一行");
    const artifact = artifacts[0]!;
    assert.equal(artifact.bet_id, betId);
    assert.equal(artifact.platform, "paperweight");
    assert.equal(artifact.type, "article");
    assert.equal(artifact.title, "定稿标题候选");
    assert.ok(artifact.note?.includes(draft.id), "note 含 draft id");
    assert.ok(artifact.note?.includes("贴热点"), "note 含 route");

    const confirmEvent = db.prepare(`
      SELECT * FROM pw_runs WHERE kind = 'manual_event' AND event_type = 'confirm'
      ORDER BY rowid DESC LIMIT 1
    `).get() as Json;
    assert.ok(confirmEvent, "应有 confirm 留痕");
    const payload = JSON.parse(String(confirmEvent.payload_json)) as Json;
    assert.equal(payload.draftId, draft.id);
    assert.equal(payload.betId, betId);
    assert.equal(payload.artifactId, artifact.id, "confirm payload 含 artifactId");

    assert.equal(getPwBet(db, betId)!.status, betStatusBefore, "押注状态不变（继续在途）");
  } finally {
    db.close();
  }
});

test("8. 定稿挂载原子性：直接 SQL 删掉 pw_artifacts 表制造 attach 必败 → finalize 整体抛错且 draft 仍是 draft 态（回滚）", () => {
  const db = makeDb();
  try {
    const { betId } = seedContentBet(db);
    const [draft] = createPwContentDrafts(db, betId, [{
      route: "少数派",
      titleCandidate: "原子性标题",
      skeletonJson: JSON.stringify([{ text: "骨架" }]),
    }]);
    db.exec("DROP TABLE pw_artifacts");

    assert.throws(() => finalizePwContentDraft(db, draft.id), /no such table/i, "attach 必败应抛错");
    const row = getPwContentDraft(db, draft.id);
    assert.equal(row.status, "draft", "attach 失败整体回滚，draft 仍是 draft 态");
    // pick 的 confirm 账（cardId/betId）不算：定稿 confirm（payload 含 draftId）不得出现
    const confirmRows = db.prepare(
      "SELECT payload_json FROM pw_runs WHERE event_type = 'confirm'",
    ).all() as Array<{ payload_json: string }>;
    const finalizeConfirms = confirmRows.filter((item) => {
      let payload: { draftId?: string };
      try {
        payload = JSON.parse(item.payload_json) as { draftId?: string };
      } catch {
        return false;
      }
      return payload.draftId === draft.id;
    });
    assert.equal(finalizeConfirms.length, 0, "回滚不留定稿 confirm 痕");
    assert.equal(getPwBet(db, betId)!.status, "pending", "押注不受影响");
  } finally {
    db.close();
  }
});
