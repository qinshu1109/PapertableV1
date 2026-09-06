/**
 * 简报 23 · 第二期学习闭环编译层（后端）测试。
 * 覆盖：
 * - 判决晋级：promote 落行（decided_by=human）、同 verdict 旧 active 置 superseded 接链、
 *   case_only 落行、GET 当前 active/null、参数校验、DB 层 decided_by 约束；
 * - 先例召回：own gold/tomb + 纸桌镜像金子、强命中/词面重叠、适用范围命中、
 *   宁缺毋滥空数组、按适用排序（不按新近度）；
 * - 先例处置：落账、overridden 必填 reason、disposition/promotionId 校验；
 * - 激活联动闸门：未处置 → 409+清单+零写入、处置完放行、无相关先例放行、激活曝光；
 * - 曝光流水：记录/按判决查询（json 数组精确匹配）、参数校验；
 * - 注入点集成：筛子每轮注入（runPwSieve）、捞料来源池注入（runPwMiner）。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createPwBet, ensurePwBetTables } from "./pw-bets.ts";
import { ensurePwDraftTables } from "./pw-drafts.ts";
import { ensurePwDataDocTables } from "./pw-data-docs.ts";
import { ensurePwVerdictTables } from "./pw-verdicts.ts";
import { ensurePwGoldMirrorTables } from "./pw-gold-sync.ts";
import { ensurePwConnectionTables } from "./pw-connections.ts";
import { ensurePwArtifactTables } from "./pw-artifacts.ts";
import { ensurePwRunTables } from "./pw-runs.ts";
import { ensurePwVoiceTables } from "./pw-voice.ts";
import { ensurePwCorpusTables, authorizePwCorpus, donePwCorpus } from "./pw-corpus.ts";
import { ensurePwSieveTables, runPwSieve, setSieveDirection, type SieveLlm } from "./pw-sieve.ts";
import { ensurePwMinerTables, runPwMiner } from "./pw-miner.ts";
import { ensurePwNoteTreeTables } from "./pw-note-tree.ts";
import { activatePwBet } from "./pw-bet-gate.ts";
import {
  disposePwPrecedents,
  getPwVerdictPromotion,
  listPwBetPrecedents,
  listPwVerdictExposures,
  listUndisposedPrecedents,
  promotePwVerdict,
  recordPwVerdictExposure,
} from "./pw-closed-loop.ts";

// ---------------------------------------------------------------------------
// 夹具：三张新表 DDL 与 data.ts 逐字一致（测试只建自己需要的表）
// ---------------------------------------------------------------------------

function ensureClosedLoopTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pw_verdict_promotions (
      id TEXT PRIMARY KEY,
      verdict_id TEXT NOT NULL REFERENCES pw_verdicts(id),
      level TEXT NOT NULL CHECK(level IN ('case_only','prior','warning','hard_constraint','action_item')),
      scope TEXT,
      review_by TEXT,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded','expired')),
      superseded_by TEXT REFERENCES pw_verdict_promotions(id),
      decided_by TEXT NOT NULL DEFAULT 'human' CHECK(decided_by='human'),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pw_verdict_promotions_verdict_status
      ON pw_verdict_promotions(verdict_id, status);
    CREATE TABLE IF NOT EXISTS pw_precedent_dispositions (
      id TEXT PRIMARY KEY,
      bet_id TEXT NOT NULL REFERENCES pw_bets(id),
      verdict_id TEXT NOT NULL,
      promotion_id TEXT REFERENCES pw_verdict_promotions(id),
      disposition TEXT NOT NULL CHECK(disposition IN ('adopted','distinguished','not_applicable','overridden')),
      reason TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pw_precedent_dispositions_bet
      ON pw_precedent_dispositions(bet_id);
    CREATE TABLE IF NOT EXISTS pw_verdict_exposures (
      id TEXT PRIMARY KEY,
      surface TEXT NOT NULL,
      bet_id TEXT,
      verdict_ids_json TEXT NOT NULL,
      actor TEXT NOT NULL,
      run_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pw_verdict_exposures_created
      ON pw_verdict_exposures(created_at);
    CREATE INDEX IF NOT EXISTS pw_verdict_exposures_bet
      ON pw_verdict_exposures(bet_id);
  `);
}

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwBetTables(db);
  ensurePwDraftTables(db);
  ensurePwDataDocTables(db);
  ensurePwVerdictTables(db);
  ensurePwGoldMirrorTables(db);
  ensurePwConnectionTables(db);
  ensureClosedLoopTables(db);
  return db;
}

/** 插一条判决（gold 用 lesson、tomb 用 cause_of_death；每判决独立 bet_id 避开非 void 唯一索引）。 */
function seedVerdict(
  db: DatabaseSync,
  id: string,
  outcome: "gold" | "tomb",
  text: string,
  decidedAt = "2026-08-10T00:00:00.000Z",
): void {
  db.prepare(`
    INSERT INTO pw_verdicts(
      id, bet_id, outcome, lesson, cause_of_death, evidence_doc_ids_json,
      confidence_snapshot, decided_by, decided_at, created_at
    ) VALUES(?, ?, ?, ?, ?, '[]', NULL, 'human', ?, ?)
  `).run(id, `bet-${id}`, outcome, outcome === "gold" ? text : null, outcome === "gold" ? null : text, decidedAt, decidedAt);
}

/** 插一条纸桌镜像金子。 */
function seedMirrorGold(db: DatabaseSync, id: string, text: string): void {
  db.prepare(`
    INSERT INTO pw_gold_mirror(
      id, source_verdict_id, kind, text, handle, project_id, card_id, confirmed_at, mirrored_at
    ) VALUES(?, ?, 'gold', ?, NULL, NULL, NULL, '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z')
  `).run(id, id, text);
}

/** 三行齐备的手动源草稿（激活预检 needs_human 不拦，能走到先例闸门）。 */
function draftBet(db: DatabaseSync, overrides: Record<string, unknown> = {}): string {
  return createPwBet(db, {
    title: "直播切片试水",
    thesis: "真实过程比教程更容易让观众追更",
    status: "draft",
    metric: "三期平均播放量",
    metric_target: "不低于 5000",
    data_source_plan: "私域群/评论区人工统计",
    checkout_date: "2099-12-31",
    ...overrides,
  }).id;
}

// ---------------------------------------------------------------------------
// 判决晋级
// ---------------------------------------------------------------------------

test("晋级：创建 active 行（decided_by=human），GET 返回当前 active", () => {
  const db = database();
  try {
    seedVerdict(db, "v-1", "gold", "直播切片试水的播放量达标了");
    const row = promotePwVerdict(db, "v-1", { level: "warning", scope: "直播切片类选题", reviewBy: "2026-09-01", reason: "影响后续选题" });
    assert.equal(row.verdict_id, "v-1");
    assert.equal(row.level, "warning");
    assert.equal(row.scope, "直播切片类选题");
    assert.equal(row.review_by, "2026-09-01");
    assert.equal(row.status, "active");
    assert.equal(row.decided_by, "human");
    assert.equal(row.superseded_by, null);
    const current = getPwVerdictPromotion(db, "v-1");
    assert.equal(current?.id, row.id);
  } finally {
    db.close();
  }
});

test("晋级：同 verdict 再晋级 → 旧的置 superseded 并接 superseded 链，GET 返回新行", () => {
  const db = database();
  try {
    seedVerdict(db, "v-2", "tomb", "没人需要直播切片");
    const first = promotePwVerdict(db, "v-2", { level: "prior", scope: "切片类选题" });
    const second = promotePwVerdict(db, "v-2", { level: "hard_constraint", scope: "所有切片选题", reason: "升级" });
    const oldRow = db.prepare("SELECT * FROM pw_verdict_promotions WHERE id = ?").get(first.id) as {
      status: string;
      superseded_by: string | null;
    };
    assert.equal(oldRow.status, "superseded");
    assert.equal(oldRow.superseded_by, second.id);
    assert.equal(getPwVerdictPromotion(db, "v-2")?.id, second.id);
    // 链上只有两条，无第三行
    const count = db.prepare("SELECT COUNT(*) AS n FROM pw_verdict_promotions WHERE verdict_id = 'v-2'").get() as { n: number };
    assert.equal(count.n, 2);
  } finally {
    db.close();
  }
});

test("晋级：case_only 也落一行（人看过、决定不晋级），并 supersede 既有 active", () => {
  const db = database();
  try {
    seedVerdict(db, "v-3", "gold", "直播切片试水的播放量达标了");
    promotePwVerdict(db, "v-3", { level: "action_item", scope: "直播切片", reason: "先升级" });
    const archived = promotePwVerdict(db, "v-3", { level: "case_only", reason: "本轮不晋级" });
    assert.equal(archived.status, "active");
    assert.equal(archived.level, "case_only");
    const current = getPwVerdictPromotion(db, "v-3");
    assert.equal(current?.id, archived.id);
    assert.equal(current?.level, "case_only");
    const superseded = db.prepare("SELECT status FROM pw_verdict_promotions WHERE level = 'action_item'").get() as { status: string };
    assert.equal(superseded.status, "superseded");
  } finally {
    db.close();
  }
});

test("晋级：level 非法 → 400；判决不存在 → 404；GET 无晋级 → null；GET 判决不存在 → 404", () => {
  const db = database();
  try {
    seedVerdict(db, "v-4", "gold", "直播切片试水的播放量达标了");
    assert.throws(() => promotePwVerdict(db, "v-4", { level: "gold" as never }), (error: unknown) =>
      (error as { status?: number }).status === 400);
    assert.throws(() => promotePwVerdict(db, "missing", { level: "prior", scope: "x" }), (error: unknown) =>
      (error as { status?: number }).status === 404);
    assert.equal(getPwVerdictPromotion(db, "v-4"), null);
    assert.throws(() => getPwVerdictPromotion(db, "missing"), (error: unknown) =>
      (error as { status?: number }).status === 404);
  } finally {
    db.close();
  }
});

test("晋级：简报 24 口径——非 case_only 必须带 scope（缺失/空 → 400）；case_only 允许无 scope", () => {
  const db = database();
  try {
    seedVerdict(db, "v-scope-req", "gold", "直播切片试水的播放量达标了");
    // prior 不带 scope → 400（验收现场复现：body {"level":"prior"} 曾错误 201）
    assert.throws(() => promotePwVerdict(db, "v-scope-req", { level: "prior" }), (error: unknown) =>
      (error as { status?: number }).status === 400
      && /scope/.test((error as Error).message));
    // scope 空串同样 400
    assert.throws(() => promotePwVerdict(db, "v-scope-req", { level: "warning", scope: "  " }), (error: unknown) =>
      (error as { status?: number }).status === 400);
    // 带 scope 通过
    const ok = promotePwVerdict(db, "v-scope-req", { level: "prior", scope: "切片类选题" });
    assert.equal(ok.scope, "切片类选题");
    // case_only 是唯一允许无 scope 的档位
    const archived = promotePwVerdict(db, "v-scope-req", { level: "case_only", reason: "本轮不晋级" });
    assert.equal(archived.level, "case_only");
    assert.equal(archived.scope, null);
    // 五个非 case_only 档位缺 scope 全部 400
    for (const level of ["prior", "warning", "hard_constraint", "action_item"] as const) {
      assert.throws(() => promotePwVerdict(db, "v-scope-req", { level }), (error: unknown) =>
        (error as { status?: number }).status === 400, `${level} 缺 scope 必须 400`);
    }
  } finally {
    db.close();
  }
});

test("晋级：数据库层 decided_by 只许 human（直接插 ai 被 CHECK 拦下）", () => {
  const db = database();
  try {
    seedVerdict(db, "v-5", "gold", "直播切片试水的播放量达标了");
    assert.throws(() => db.prepare(`
      INSERT INTO pw_verdict_promotions(
        id, verdict_id, level, scope, review_by, reason, status, superseded_by, decided_by, created_at
      ) VALUES('bad', 'v-5', 'prior', NULL, NULL, NULL, 'active', NULL, 'ai', '2026-08-14T00:00:00.000Z')
    `).run(), /CHECK constraint failed|decided_by/);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// 先例召回
// ---------------------------------------------------------------------------

test("先例：own gold 按指标词强命中召回，带 active 晋级信息与 matchReason", () => {
  const db = database();
  try {
    seedVerdict(db, "v-gold", "gold", "播放量是直播切片的核心指标，达标才算数");
    promotePwVerdict(db, "v-gold", { level: "warning", scope: "直播切片类选题" });
    // 指标词用短词「播放量」→ 整词逐字命中 = 强命中；标题长词走词面重叠
    const betId = draftBet(db, { metric: "播放量", metric_target: "> 5000" });
    const items = listPwBetPrecedents(db, betId);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.verdictId, "v-gold");
    assert.equal(items[0]!.outcome, "gold");
    assert.equal(items[0]!.source, "own");
    assert.match(items[0]!.text, /播放量/);
    assert.deepEqual(items[0]!.promotion, { level: "warning", scope: "直播切片类选题" });
    assert.match(items[0]!.matchReason, /指标词命中：播放量/);
  } finally {
    db.close();
  }
});

test("先例：中文短语无整词命中时按双字 shingle 词面重叠召回（≥2 个重叠）", () => {
  const db = database();
  try {
    // 押注标题「直播切片试水」（长词），判决正文含「直播切片」→ shingle 重叠 直播/播切/切片
    seedVerdict(db, "v-face", "gold", "直播切片比完整教程更吸引人");
    const betId = draftBet(db);
    const items = listPwBetPrecedents(db, betId);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.verdictId, "v-face");
    assert.match(items[0]!.matchReason, /标题词词面重叠：直播切片试水/);
  } finally {
    db.close();
  }
});

test("先例：纸桌镜像金子参与召回（source=mirror，outcome=gold）", () => {
  const db = database();
  try {
    seedMirrorGold(db, "m-1", "播放量不达标的切片选题不该再做");
    const betId = draftBet(db);
    const items = listPwBetPrecedents(db, betId);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.verdictId, "m-1");
    assert.equal(items[0]!.source, "mirror");
    assert.equal(items[0]!.outcome, "gold");
  } finally {
    db.close();
  }
});

test("先例：适用范围文本命中（晋级 scope 与押注词面重叠）", () => {
  const db = database();
  try {
    seedVerdict(db, "v-scope", "tomb", "这条死因与播放量无关");
    promotePwVerdict(db, "v-scope", { level: "hard_constraint", scope: "直播切片选题一律先看播放量" });
    const betId = draftBet(db);
    const items = listPwBetPrecedents(db, betId);
    assert.equal(items.length, 1);
    assert.match(items[0]!.matchReason, /适用范围/);
  } finally {
    db.close();
  }
});

test("先例：宁缺毋滥——无相关判决返回空数组（不拿最近 N 条凑数）", () => {
  const db = database();
  try {
    seedVerdict(db, "v-unrelated", "gold", "做菜教程永远有人看");
    seedVerdict(db, "v-unrelated-2", "tomb", "没人需要唱歌教学");
    const betId = draftBet(db);
    assert.deepEqual(listPwBetPrecedents(db, betId), []);
    // 库里有判决但都不相关 → 空数组，而不是退回「最近 10 条」
    const all = db.prepare("SELECT COUNT(*) AS n FROM pw_verdicts").get() as { n: number };
    assert.equal(all.n, 2);
  } finally {
    db.close();
  }
});

test("先例：按适用匹配排序（命中多的在前），不按新近度", () => {
  const db = database();
  try {
    // 新但只弱命中的判决 vs 旧但强命中的判决——旧的强命中必须排前面
    seedVerdict(db, "v-new-weak", "gold", "直播切片有人看", "2026-08-14T00:00:00.000Z");
    seedVerdict(db, "v-old-strong", "gold", "播放量是直播切片的核心指标，达标才算数", "2026-07-01T00:00:00.000Z");
    const betId = draftBet(db);
    const items = listPwBetPrecedents(db, betId);
    assert.equal(items.length, 2);
    assert.equal(items[0]!.verdictId, "v-old-strong", "命中权重高者必须在前（适用优先，不按新近度）");
  } finally {
    db.close();
  }
});

test("先例：押注不存在 → 404", () => {
  const db = database();
  try {
    assert.throws(() => listPwBetPrecedents(db, "missing"), (error: unknown) =>
      (error as { status?: number }).status === 404);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// 先例处置
// ---------------------------------------------------------------------------

test("处置：落账 + overridden 必填 reason + 非法枚举/promotionId/verdictId 校验", () => {
  const db = database();
  try {
    seedVerdict(db, "v-dispose", "gold", "播放量是直播切片的核心指标");
    const betId = draftBet(db);
    const promotion = promotePwVerdict(db, "v-dispose", { level: "warning", scope: "直播切片类选题" });

    const rows = disposePwPrecedents(db, betId, [
      { verdictId: "v-dispose", promotionId: promotion.id, disposition: "adopted", reason: "采纳" },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.verdict_id, "v-dispose");
    assert.equal(rows[0]!.promotion_id, promotion.id);
    assert.equal(rows[0]!.disposition, "adopted");

    // overridden 无 reason → 400
    assert.throws(() => disposePwPrecedents(db, betId, [
      { verdictId: "v-dispose", disposition: "overridden" },
    ]), (error: unknown) => (error as { status?: number }).status === 400 && /reason/.test((error as Error).message));
    // overridden 带 reason → 通过
    disposePwPrecedents(db, betId, [{ verdictId: "v-dispose", disposition: "overridden", reason: "判例过时" }]);
    // 非法 disposition → 400
    assert.throws(() => disposePwPrecedents(db, betId, [
      { verdictId: "v-dispose", disposition: "ignore" as never },
    ]), (error: unknown) => (error as { status?: number }).status === 400);
    // 不存在的 promotionId → 400
    assert.throws(() => disposePwPrecedents(db, betId, [
      { verdictId: "v-dispose", promotionId: "no-such", disposition: "adopted" },
    ]), (error: unknown) => (error as { status?: number }).status === 400);
    // 缺 verdictId → 400
    assert.throws(() => disposePwPrecedents(db, betId, [
      { verdictId: "", disposition: "adopted" },
    ]), (error: unknown) => (error as { status?: number }).status === 400);
    // 押注不存在 → 404
    assert.throws(() => disposePwPrecedents(db, "missing", [
      { verdictId: "v-dispose", disposition: "adopted" },
    ]), (error: unknown) => (error as { status?: number }).status === 404);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// 激活联动闸门
// ---------------------------------------------------------------------------

test("闸门：相关先例未处置 → 激活 409 + 未处置清单 + 激活曝光，押注保持 draft", () => {
  const db = database();
  try {
    seedVerdict(db, "v-gate", "gold", "播放量是直播切片的核心指标，达标才算数");
    const betId = draftBet(db);
    assert.throws(() => activatePwBet(db, betId), (error: unknown) => {
      const e = error as { status?: number; details?: { undisposed?: unknown[]; total?: number } };
      assert.equal(e.status, 409);
      assert.equal(e.details?.total, 1);
      assert.equal(e.details?.undisposed?.[0] && (e.details.undisposed[0] as { verdictId: string }).verdictId, "v-gate");
      return true;
    });
    // 零写入：押注仍是 draft，未产生确认事件
    const bet = db.prepare("SELECT status FROM pw_bets WHERE id = ?").get(betId) as { status: string };
    assert.equal(bet.status, "draft");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM pw_draft_events").get() as { n: number }).n, 0);
    // 激活曝光已记
    const exposures = listPwVerdictExposures(db, "v-gate");
    assert.ok(exposures.some((row) => row.surface === "activation" && row.betId === betId && row.actor === "system"));
  } finally {
    db.close();
  }
});

test("闸门：全部处置完 → 激活放行（draft → pending）", () => {
  const db = database();
  try {
    seedVerdict(db, "v-gate2", "gold", "播放量是直播切片的核心指标，达标才算数");
    const betId = draftBet(db);
    disposePwPrecedents(db, betId, [{ verdictId: "v-gate2", disposition: "adopted" }]);
    assert.deepEqual(listUndisposedPrecedents(db, betId), []);
    const result = activatePwBet(db, betId);
    assert.equal(result.bet.status, "pending");
    assert.equal(result.preflight.pass, true);
  } finally {
    db.close();
  }
});

test("闸门：无相关先例 → 直接放行，不要求处置", () => {
  const db = database();
  try {
    seedVerdict(db, "v-unrelated-gate", "gold", "做菜教程永远有人看");
    const betId = draftBet(db);
    const result = activatePwBet(db, betId);
    assert.equal(result.bet.status, "pending");
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// 曝光流水
// ---------------------------------------------------------------------------

test("曝光：记录 + 按判决查流水（json 数组精确匹配）+ 参数校验", () => {
  const db = database();
  try {
    const row = recordPwVerdictExposure(db, {
      surface: "collab",
      betId: "bet-a",
      verdictIds: ["v-1", "v-2"],
      actor: "system",
    });
    assert.ok(row);
    assert.deepEqual(row.verdictIds, ["v-1", "v-2"]);
    recordPwVerdictExposure(db, {
      surface: "sieve",
      verdictIds: ["v-2", "v-3"],
      actor: "system",
      runId: "run-1",
    });

    const forV1 = listPwVerdictExposures(db, "v-1");
    assert.equal(forV1.length, 1);
    assert.equal(forV1[0]!.surface, "collab");
    const forV2 = listPwVerdictExposures(db, "v-2");
    assert.equal(forV2.length, 2, "v-2 出现在两行里，都要查到");
    const forMissing = listPwVerdictExposures(db, "no-such");
    assert.deepEqual(forMissing, []);

    // 校验：surface 空 / actor 非法 → 400；空 verdictIds = 本次无判决进上下文 → 不落行返回 null
    assert.throws(() => recordPwVerdictExposure(db, { surface: "", verdictIds: ["v-1"], actor: "system" }),
      (error: unknown) => (error as { status?: number }).status === 400);
    assert.throws(() => recordPwVerdictExposure(db, { surface: "collab", verdictIds: ["v-1"], actor: "robot" as never }),
      (error: unknown) => (error as { status?: number }).status === 400);
    assert.equal(recordPwVerdictExposure(db, { surface: "collab", verdictIds: [], actor: "system" }), null);
    assert.throws(() => listPwVerdictExposures(db, ""),
      (error: unknown) => (error as { status?: number }).status === 400);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// 注入点集成：筛子每轮注入 / 捞料来源池注入
// ---------------------------------------------------------------------------

const BV = "BV1NprhBPEtR";
const NOW_MS = 1_760_000_000_000;
const DAY_MS = 86_400_000;
const epochSec = (ms: number): number => Math.floor(ms / 1000);

const SIEVE_COMMENTS = [
  {
    rpid: 101,
    uname: "甲",
    message: "直播做产品实践这个实验设计得真巧妙",
    like: 12,
    ctime: epochSec(NOW_MS - DAY_MS),
  },
];

const SIEVE_META = {
  bvid: BV,
  aid: 123456,
  title: "测试成片",
  up_name: "某UP主",
  pubdate: 1700000000,
  stat: { 播放: 100, 弹幕: 5, 评论: 1, 收藏: 20, 投币: 10, 分享: 3, 点赞: 30 },
  fetched_at: "2026-08-05T00:00:00.000Z",
  source: "api.bilibili.com/x/web-interface/view",
};

async function seedSieveCorpus(db: DatabaseSync, dir: string): Promise<string> {
  await writeFile(join(dir, "meta.json"), JSON.stringify(SIEVE_META, null, 2));
  await writeFile(
    join(dir, "comments.jsonl"),
    SIEVE_COMMENTS.map((comment) => JSON.stringify(comment)).join("\n") + "\n",
  );
  const { doc } = authorizePwCorpus(db, { bvid: SIEVE_META.bvid });
  donePwCorpus(db, doc.id, {
    title: SIEVE_META.title,
    upName: SIEVE_META.up_name,
    path: dir,
    videoStat: SIEVE_META.stat,
    commentCount: SIEVE_COMMENTS.length,
    comments: SIEVE_COMMENTS.map((comment) => ({
      uname: comment.uname,
      message: comment.message,
      like: comment.like,
    })),
  });
  return doc.id;
}

test("注入点：筛子每轮把判决放进提示词时记一行曝光（surface=sieve，带 runId）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pw-closed-sieve-"));
  const db = new DatabaseSync(":memory:");
  try {
    ensurePwBetTables(db);
    ensurePwArtifactTables(db);
    ensurePwDataDocTables(db);
    ensurePwVerdictTables(db);
    ensurePwRunTables(db);
    ensurePwConnectionTables(db);
    ensurePwVoiceTables(db);
    ensurePwCorpusTables(db);
    ensurePwSieveTables(db);
    ensureClosedLoopTables(db);
    seedVerdict(db, "sieve-v1", "gold", "播放量是直播切片的核心指标", "2026-08-10T00:00:00.000Z");
    seedVerdict(db, "sieve-v2", "tomb", "没人需要直播切片", "2026-08-11T00:00:00.000Z");

    const corpusId = await seedSieveCorpus(db, dir);
    const llm: SieveLlm = async () => JSON.stringify({
      cards: [{
        quote_text: "直播做产品实践这个实验设计得真巧妙",
        quote_source: { bvid: BV, uname: "甲", like: 12, rpid: 101 },
        scale_note: "同类 1 条",
        hook_note: "真实过程更有说服力",
        freshness_note: "近期",
        wildcard: true,
      }],
    });
    const run = await runPwSieve(db, "manual", [corpusId], { llm, now: () => NOW_MS });
    assert.equal(run.status, "done");

    const exposures = db.prepare(`
      SELECT * FROM pw_verdict_exposures WHERE surface = 'sieve'
    `).all() as Array<{ run_id: string; verdict_ids_json: string; actor: string }>;
    assert.equal(exposures.length, 1);
    assert.equal(exposures[0]!.run_id, run.id);
    assert.equal(exposures[0]!.actor, "system");
    const ids = JSON.parse(exposures[0]!.verdict_ids_json) as string[];
    assert.deepEqual(new Set(ids), new Set(["sieve-v1", "sieve-v2"]));
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

const MEMOS_SCHEMA = `CREATE TABLE memo (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL UNIQUE, creator_id INTEGER,
  created_ts INTEGER, updated_ts INTEGER, row_status TEXT NOT NULL DEFAULT 'NORMAL',
  content TEXT, visibility TEXT NOT NULL DEFAULT 'PRIVATE', pinned INTEGER NOT NULL DEFAULT 0,
  payload TEXT
)`;

test("注入点：捞料来源池（含镜像金子）进提示词时记一行曝光（surface=miner，带 runId）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pw-closed-miner-"));
  const memosPath = join(dir, "memos.db");
  const memos = new DatabaseSync(memosPath);
  const db = new DatabaseSync(":memory:");
  const saved = process.env.MEMOS_DB_PATH;
  try {
    memos.exec("PRAGMA journal_mode=WAL");
    memos.exec(MEMOS_SCHEMA);
    memos.prepare(`INSERT INTO memo(
      uid,creator_id,created_ts,updated_ts,row_status,content,visibility,pinned,payload
    ) VALUES('note-1',1,100,100,'NORMAL','直播陪跑需要真实案例','PRIVATE',0,NULL)`).run();
    process.env.MEMOS_DB_PATH = memosPath;

    ensurePwBetTables(db);
    ensurePwSieveTables(db);
    ensurePwVerdictTables(db);
    ensurePwGoldMirrorTables(db);
    ensurePwNoteTreeTables(db);
    ensurePwMinerTables(db);
    ensureClosedLoopTables(db);
    db.prepare(`INSERT INTO pw_bets(
      id,title,thesis,status,gold_refs_json,created_at,kind
    ) VALUES('bet-1','直播陪跑','验证陪跑内容','pending','[]','2026-08-01T00:00:00+08:00','content')`).run();
    setSieveDirection(db, "直播销售");
    seedVerdict(db, "miner-v1", "gold", "播放量是直播切片的核心指标", "2026-08-10T00:00:00.000Z");
    seedMirrorGold(db, "miner-m1", "直播销售的旧判断：真实案例比教程可信");

    const llm = async () => JSON.stringify([]);
    const run = await runPwMiner(db, {
      llm,
      searchMemos: async () => [],
      now: () => "2026-08-11T06:31:00+08:00",
      modelLabel: "mock-deepseek",
    });
    assert.equal(run.candidates, 0);

    const exposures = db.prepare(`
      SELECT * FROM pw_verdict_exposures WHERE surface = 'miner'
    `).all() as Array<{ run_id: string; verdict_ids_json: string; actor: string }>;
    assert.equal(exposures.length, 1);
    assert.equal(exposures[0]!.run_id, run.id);
    assert.equal(exposures[0]!.actor, "system");
    const ids = JSON.parse(exposures[0]!.verdict_ids_json) as string[];
    assert.deepEqual(new Set(ids), new Set(["miner-v1", "miner-m1"]), "own 判决与镜像金子都要进曝光");
  } finally {
    if (saved === undefined) delete process.env.MEMOS_DB_PATH;
    else process.env.MEMOS_DB_PATH = saved;
    memos.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
