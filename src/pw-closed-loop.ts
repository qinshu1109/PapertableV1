/**
 * 简报 23 · 第二期学习闭环编译层（后端）。
 *
 * 三张新表（用户 2026-08-14 逐项批准，建表在 src/data.ts，本模块只读写不建表）：
 * - pw_verdict_promotions  判决晋级（人看过判决后定级：仅归档/先例/警告/硬约束/待办，
 *                          同判决的 active 晋级被新晋级置 superseded 并接链）
 * - pw_precedent_dispositions  押注对相关先例判决的处置落账（adopted / distinguished /
 *                          not_applicable / overridden；overridden 必须带 reason）
 * - pw_verdict_exposures   判决被注入上下文的曝光流水（协作台 §N / 筛子每轮 / 捞料来源池 /
 *                          激活闸门 / 协作台检索工具；actor=system 系统自动注入，ai=模型工具触发）
 *
 * 先例召回口径（写入本模块注释即口径）：
 * - 只从金子墓碑库召回「与当前押注相关」的判决（own：pw_verdicts 的 gold/tomb；
 *   含纸桌镜像金子 pw_gold_mirror）；无相关就返回空数组，绝不拿「最近 N 条」凑数。
 * - 相关 = 押注的指标词/标题词/来源词与判决正文或其 active 晋级的适用范围文本有 ≥1 个
 *   关键词重叠（分词口径与 pw-context.extractKeywords 一致：按非字母数字切分、长度 ≥2）。
 * - 排序按命中词数降序（适用匹配优先，不按新近度）；同分按 id 稳定。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { httpError, nowIso } from "./data.ts";
import { getPwBet } from "./pw-bets.ts";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type PwPromotionLevel = "case_only" | "prior" | "warning" | "hard_constraint" | "action_item";

export const PW_PROMOTION_LEVELS: readonly PwPromotionLevel[] = [
  "case_only",
  "prior",
  "warning",
  "hard_constraint",
  "action_item",
];

export type PwPromotionStatus = "active" | "superseded" | "expired";

export type PwVerdictPromotionRow = {
  id: string;
  verdict_id: string;
  level: PwPromotionLevel;
  scope: string | null;
  review_by: string | null;
  reason: string | null;
  status: PwPromotionStatus;
  superseded_by: string | null;
  decided_by: "human";
  created_at: string;
};

export type PwPromoteInput = {
  level: PwPromotionLevel;
  scope?: string | null;
  reviewBy?: string | null;
  review_by?: string | null;
  reason?: string | null;
};

export type PwDispositionValue = "adopted" | "distinguished" | "not_applicable" | "overridden";

export const PW_DISPOSITIONS: readonly PwDispositionValue[] = [
  "adopted",
  "distinguished",
  "not_applicable",
  "overridden",
];

export type PwDispositionRow = {
  id: string;
  bet_id: string;
  verdict_id: string;
  promotion_id: string | null;
  disposition: PwDispositionValue;
  reason: string | null;
  created_at: string;
};

export type PwDisposeInput = {
  verdictId: string;
  promotionId?: string | null;
  disposition: PwDispositionValue;
  reason?: string | null;
};

export type PwPrecedentItem = {
  verdictId: string;
  outcome: "gold" | "tomb";
  text: string;
  source: "own" | "mirror";
  promotion: { level: PwPromotionLevel; scope: string | null } | null;
  matchReason: string;
};

export type PwVerdictExposureActor = "system" | "ai";

export type PwVerdictExposureInput = {
  surface: string;
  betId?: string | null;
  verdictIds: readonly string[];
  actor: PwVerdictExposureActor;
  runId?: string | null;
};

export type PwVerdictExposureView = {
  id: string;
  surface: string;
  betId: string | null;
  verdictIds: string[];
  actor: PwVerdictExposureActor;
  runId: string | null;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// 建表（自足）：DDL 与 src/data.ts 顶部逐字一致（简报 23 硬约束「建表进 src/data.ts」，
// 正式表由 data.ts 建；本 ensure 只在测试/部分夹具缺表时自愈，幂等无副作用。
// 与 pw-recall-events.recordPwRecallEvent 内部 ensure 同一模式。）
// ---------------------------------------------------------------------------

export function ensurePwClosedLoopTables(db: DatabaseSync): void {
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

// ---------------------------------------------------------------------------
// 判决晋级（pw_verdict_promotions）
// ---------------------------------------------------------------------------

/**
 * 创建晋级（decided_by=human 由表约束锁死）。同 verdict 已有 active 晋级 →
 * 旧的置 superseded、superseded_by 指向新行（接 superseded 链）；新行 status='active'。
 * level='case_only' 也照落一行（语义=人看过、决定不晋级）。
 * 简报 24 验收口径：非 case_only 晋级必须带适用范围 scope（缺失/空 → 400），
 * case_only 是唯一允许 scope 为空的档位。
 */
export function promotePwVerdict(
  db: DatabaseSync,
  verdictId: string,
  input: PwPromoteInput,
): PwVerdictPromotionRow {
  ensurePwClosedLoopTables(db);
  if (!db.prepare("SELECT id FROM pw_verdicts WHERE id = ?").get(verdictId)) {
    throw httpError(404, "判决不存在");
  }
  const level = input?.level;
  if (!isPromotionLevel(level)) throw httpError(400, "level 非法（case_only|prior|warning|hard_constraint|action_item）");
  const scope = optionalText(input?.scope);
  if (level !== "case_only" && !scope) {
    throw httpError(400, "非 case_only 晋级必须填写适用范围 scope");
  }
  const reviewBy = optionalText(input?.review_by !== undefined ? input.review_by : input?.reviewBy);
  const reason = optionalText(input?.reason);
  const id = randomUUID();
  const createdAt = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    const active = db.prepare(`
      SELECT id FROM pw_verdict_promotions
      WHERE verdict_id = ? AND status = 'active'
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(verdictId) as { id: string } | undefined;
    db.prepare(`
      INSERT INTO pw_verdict_promotions(
        id, verdict_id, level, scope, review_by, reason,
        status, superseded_by, decided_by, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, 'active', NULL, 'human', ?)
    `).run(id, verdictId, level, scope, reviewBy, reason, createdAt);
    if (active) {
      db.prepare(`
        UPDATE pw_verdict_promotions SET status = 'superseded', superseded_by = ?
        WHERE id = ? AND status = 'active'
      `).run(id, active.id);
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original constraint or validation error.
    }
    throw error;
  }
  return db.prepare("SELECT * FROM pw_verdict_promotions WHERE id = ?").get(id) as PwVerdictPromotionRow;
}

/** 当前 active 晋级或 null（判决不存在 → 404）。 */
export function getPwVerdictPromotion(
  db: DatabaseSync,
  verdictId: string,
): PwVerdictPromotionRow | null {
  ensurePwClosedLoopTables(db);
  if (!db.prepare("SELECT id FROM pw_verdicts WHERE id = ?").get(verdictId)) {
    throw httpError(404, "判决不存在");
  }
  const row = db.prepare(`
    SELECT * FROM pw_verdict_promotions
    WHERE verdict_id = ? AND status = 'active'
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(verdictId) as PwVerdictPromotionRow | undefined;
  return row ?? null;
}

// ---------------------------------------------------------------------------
// 先例召回（GET /api/pw/bets/:id/precedents）——按适用匹配，不按新近度
// ---------------------------------------------------------------------------

type BetKeyword = { word: string; origin: string };

/**
 * 先例召回：金子墓碑库（own gold/tomb + 纸桌镜像金子）里与当前押注相关的判决。
 * 匹配依据 = 押注的标题词/指标词/来源词 与 判决正文或其 active 晋级适用范围文本 的重叠。
 * 匹配粒度（宁缺毋滥，写死为口径）：
 * - 强命中：关键词整词出现在判决正文/适用范围（如指标词「播放量」逐字出现）；
 * - 词面重叠：中文短语（≥3 个汉字）在对方文本里至少有 2 个连续双字 shingle 重叠
 *   （如「直播切片试水」与「直播切片比教程更吸引人」重叠「直播、切片」），纯字母数字
 *   词不派生 shingle，只认整词；
 * - 至少 1 个关键词命中才召回；无相关返回空数组，绝不拿「最近 N 条」凑数。
 * 排序按命中权重降序（强命中 2 分、词面重叠 1 分，适用优先不按新近度），同分按 verdictId 稳定。
 */
export function listPwBetPrecedents(db: DatabaseSync, betId: string): PwPrecedentItem[] {
  ensurePwClosedLoopTables(db);
  const bet = getPwBet(db, betId);
  if (!bet) throw httpError(404, "押注不存在");
  const keywords = betKeywords(bet);
  if (keywords.length === 0) return [];

  const candidates = loadPrecedentCandidates(db);
  const activePromotions = loadActivePromotions(db);

  const scored: Array<{ item: PwPrecedentItem; score: number }> = [];
  for (const candidate of candidates) {
    const promotion = activePromotions.get(candidate.id) ?? null;
    const scope = promotion?.scope ?? "";
    const textLower = candidate.text.toLowerCase();
    const scopeLower = scope.toLowerCase();
    const matchedText = new Map<string, { strong: string[]; weak: Array<{ word: string; evidence: string }> }>();
    const matchedScope: Array<{ word: string; strong: boolean; evidence: string }> = [];
    let score = 0;
    for (const { word, origin } of keywords) {
      const inText = matchKeyword(word, textLower);
      const inScope = scopeLower.length > 0 ? matchKeyword(word, scopeLower) : null;
      if (!inText && !inScope) continue;
      // 并集计分：一词正文或适用范围任一命中即计（取最强形态的分值，不重复计）
      score += Math.max(weightOf(inText), weightOf(inScope));
      if (inText) {
        const bucket = matchedText.get(origin) ?? { strong: [], weak: [] };
        if (inText.kind === "strong") bucket.strong.push(word);
        else bucket.weak.push({ word, evidence: inText.evidence });
        matchedText.set(origin, bucket);
      }
      if (inScope) {
        matchedScope.push({ word, strong: inScope.kind === "strong", evidence: inScope.evidence });
      }
    }
    if (score === 0) continue;
    const reasonParts: string[] = [];
    for (const [origin, bucket] of matchedText) {
      if (bucket.strong.length > 0) reasonParts.push(`${origin}命中：${bucket.strong.join("、")}`);
      for (const weak of bucket.weak) {
        reasonParts.push(`${origin}词面重叠：${weak.word}（重叠：${weak.evidence}）`);
      }
    }
    for (const item of matchedScope) {
      reasonParts.push(
        item.strong
          ? `适用范围命中：${item.word}`
          : `适用范围词面重叠：${item.word}（重叠：${item.evidence}）`,
      );
    }
    scored.push({
      item: {
        verdictId: candidate.id,
        outcome: candidate.outcome,
        text: candidate.text,
        source: candidate.source,
        promotion: promotion ? { level: promotion.level, scope: promotion.scope } : null,
        matchReason: reasonParts.join("；"),
      },
      score,
    });
  }
  scored.sort((a, b) => b.score - a.score || a.item.verdictId.localeCompare(b.item.verdictId));
  return scored.map((entry) => entry.item);
}

type PrecedentCandidate = {
  id: string;
  outcome: "gold" | "tomb";
  text: string;
  source: "own" | "mirror";
};

/**
 * 金子墓碑库：own（pw_verdicts gold/tomb）+ 纸桌镜像金子（pw_gold_mirror）。
 * 两表属其他模块；部分测试夹具不建它们时按 sqlite_master 跳过（照 pw-verdicts.ts 判
 * pw_note_attach 是否存在的先例），不因缺表炸掉先例查询。
 */
function loadPrecedentCandidates(db: DatabaseSync): PrecedentCandidate[] {
  const candidates: PrecedentCandidate[] = [];
  const hasTable = (name: string): boolean =>
    Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  if (hasTable("pw_verdicts")) {
    const own = db.prepare(`
      SELECT id, outcome, lesson, cause_of_death FROM pw_verdicts
      WHERE outcome IN ('gold','tomb')
    `).all() as Array<{
      id: string;
      outcome: "gold" | "tomb";
      lesson: string | null;
      cause_of_death: string | null;
    }>;
    for (const row of own) {
      const text = row.outcome === "gold" ? row.lesson : row.cause_of_death;
      if (!text?.trim()) continue;
      candidates.push({ id: row.id, outcome: row.outcome, text: text, source: "own" });
    }
  }
  if (hasTable("pw_gold_mirror")) {
    const mirrors = db.prepare("SELECT id, text FROM pw_gold_mirror").all() as Array<{
      id: string;
      text: string;
    }>;
    for (const row of mirrors) {
      if (!row.text?.trim()) continue;
      candidates.push({ id: row.id, outcome: "gold", text: row.text, source: "mirror" });
    }
  }
  return candidates;
}

/** 全部 active 晋级（verdict_id → row；supersede 链保证同判决至多一条 active）。 */
function loadActivePromotions(db: DatabaseSync): Map<string, PwVerdictPromotionRow> {
  const rows = db.prepare(`
    SELECT * FROM pw_verdict_promotions WHERE status = 'active'
  `).all() as PwVerdictPromotionRow[];
  return new Map(rows.map((row) => [row.verdict_id, row]));
}

/** 押注关键词（含出处标签，供 matchReason 人读）：标题+假设→标题词；指标+目标→指标词；来源→来源词。 */
function betKeywords(bet: {
  title: string;
  thesis: string;
  metric: string | null;
  metric_target: string | null;
  data_source_plan: string | null;
}): BetKeyword[] {
  const out: BetKeyword[] = [];
  const push = (text: string | null, origin: string) => {
    for (const word of extractWords(text ?? "")) {
      if (!out.some((entry) => entry.word === word && entry.origin === origin)) out.push({ word, origin });
    }
  };
  push(`${bet.title}\n${bet.thesis}`, "标题词");
  push(`${bet.metric ?? ""}\n${bet.metric_target ?? ""}`, "指标词");
  push(bet.data_source_plan, "来源词");
  return out;
}

/** 分词口径与 pw-context.extractKeywords 一致：非字母数字切分、长度 ≥2、小写。 */
function extractWords(text: string): string[] {
  const tokens = text.toLowerCase().split(/[^a-z0-9一-鿿]+/u);
  return tokens.filter((token) => token.length >= 2);
}

type KeywordMatch = { kind: "strong" | "weak"; evidence: string } | null;

/**
 * 单关键词匹配：整词逐字出现 → 强命中；纯字母数字词只认整词；
 * 中文短语（能派生出 ≥2 个双字 shingle 的）在对方文本 ≥2 个 shingle 重叠 → 词面重叠（弱）。
 */
function matchKeyword(word: string, haystack: string): KeywordMatch {
  if (haystack.includes(word)) return { kind: "strong", evidence: word };
  const shingles = cjkShingles(word);
  if (shingles.length >= 2) {
    const overlap = shingles.filter((shingle) => haystack.includes(shingle));
    if (overlap.length >= 2) return { kind: "weak", evidence: overlap.join("、") };
  }
  return null;
}

function weightOf(match: KeywordMatch): number {
  return match === null ? 0 : match.kind === "strong" ? 2 : 1;
}

/** 中文连续双字 shingle：仅取两个字符都在 CJK 区间的相邻对（混合词只派生纯中文部分）。 */
function cjkShingles(word: string): string[] {
  const CJK = /^[\u4e00-\u9fff]$/u;
  const shingles: string[] = [];
  for (let index = 0; index < word.length - 1; index += 1) {
    const pair = word.slice(index, index + 2);
    if (CJK.test(pair[0]!) && CJK.test(pair[1]!)) shingles.push(pair);
  }
  return shingles;
}

// ---------------------------------------------------------------------------
// 先例处置（pw_precedent_dispositions）
// ---------------------------------------------------------------------------

/**
 * 落账先例处置：每项 {verdictId, promotionId?, disposition, reason?}。
 * - verdictId 必填非空；disposition 必须在枚举内；
 * - overridden 必须带 reason（后端校验，否则 400）；
 * - promotionId 若提供必须存在于 pw_verdict_promotions（否则 400，让调用方先建晋级）。
 */
export function disposePwPrecedents(
  db: DatabaseSync,
  betId: string,
  dispositions: readonly PwDisposeInput[],
): PwDispositionRow[] {
  ensurePwClosedLoopTables(db);
  if (!getPwBet(db, betId)) throw httpError(404, "押注不存在");
  if (!Array.isArray(dispositions)) throw httpError(400, "dispositions 必须是数组");
  const insert = db.prepare(`
    INSERT INTO pw_precedent_dispositions(
      id, bet_id, verdict_id, promotion_id, disposition, reason, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?)
  `);
  const created: PwDispositionRow[] = [];
  for (const item of dispositions) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw httpError(400, "处置项格式非法");
    const verdictId = typeof item.verdictId === "string" ? item.verdictId.trim() : "";
    if (!verdictId) throw httpError(400, "verdictId 必填");
    const disposition = item.disposition;
    if (!PW_DISPOSITIONS.includes(disposition)) {
      throw httpError(400, "disposition 非法（adopted|distinguished|not_applicable|overridden）");
    }
    const reason = optionalText(item.reason);
    if (disposition === "overridden" && !reason) {
      throw httpError(400, "overridden 处置必须带 reason");
    }
    let promotionId: string | null = null;
    if (item.promotionId !== undefined && item.promotionId !== null) {
      if (typeof item.promotionId !== "string" || !item.promotionId.trim()) {
        throw httpError(400, "promotionId 格式非法");
      }
      promotionId = item.promotionId.trim();
      if (!db.prepare("SELECT id FROM pw_verdict_promotions WHERE id = ?").get(promotionId)) {
        throw httpError(400, "promotionId 不存在");
      }
    }
    const id = randomUUID();
    const createdAt = nowIso();
    insert.run(id, betId, verdictId, promotionId, disposition, reason, createdAt);
    created.push({
      id,
      bet_id: betId,
      verdict_id: verdictId,
      promotion_id: promotionId,
      disposition,
      reason,
      created_at: createdAt,
    });
  }
  return created;
}

/**
 * 激活联动闸门用：该押注的先例中「尚未处置」的清单（= 相关先例减去已有处置行的）。
 * 全部处置完（或无相关先例）返回空数组。
 */
export function listUndisposedPrecedents(db: DatabaseSync, betId: string): PwPrecedentItem[] {
  const precedents = listPwBetPrecedents(db, betId);
  if (precedents.length === 0) return [];
  const disposed = new Set(
    (db.prepare("SELECT verdict_id FROM pw_precedent_dispositions WHERE bet_id = ?")
      .all(betId) as Array<{ verdict_id: string }>).map((row) => row.verdict_id),
  );
  return precedents.filter((item) => !disposed.has(item.verdictId));
}

// ---------------------------------------------------------------------------
// 曝光流水（pw_verdict_exposures）
// ---------------------------------------------------------------------------

/** 写一行曝光（每次判决被注入上下文时调用；verdictIds 为本次放进上下文的判决 id 数组）。
 *  verdictIds 为空 = 本次没有判决进上下文，不产生行，返回 null（不抛错——注入点常遇到
 *  判决库为空，如全新库的协作台首轮）。 */
export function recordPwVerdictExposure(
  db: DatabaseSync,
  input: PwVerdictExposureInput,
): PwVerdictExposureView | null {
  ensurePwClosedLoopTables(db);
  const surface = typeof input?.surface === "string" ? input.surface.trim() : "";
  if (!surface) throw httpError(400, "surface 必填");
  if (input.actor !== "system" && input.actor !== "ai") throw httpError(400, "actor 只能是 system/ai");
  if (!Array.isArray(input.verdictIds)) throw httpError(400, "verdictIds 必须是非空字符串数组");
  const verdictIds = input.verdictIds.map((id) => (typeof id === "string" ? id.trim() : ""));
  if (verdictIds.length === 0) return null;
  if (verdictIds.some((id) => !id)) throw httpError(400, "verdictIds 必须是非空字符串数组");
  const betId = optionalText(input.betId);
  const runId = optionalText(input.runId);
  const id = randomUUID();
  const createdAt = nowIso();
  db.prepare(`
    INSERT INTO pw_verdict_exposures(
      id, surface, bet_id, verdict_ids_json, actor, run_id, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?)
  `).run(id, surface, betId, JSON.stringify(verdictIds), input.actor, runId, createdAt);
  return { id, surface, betId, verdictIds, actor: input.actor, runId, createdAt };
}

/** 某判决的曝光流水（verdict_ids_json 含该 id 的所有行；按时间正序 = 流水）。 */
export function listPwVerdictExposures(db: DatabaseSync, verdictId: string): PwVerdictExposureView[] {
  ensurePwClosedLoopTables(db);
  if (typeof verdictId !== "string" || !verdictId.trim()) throw httpError(400, "verdictId 必填");
  const rows = db.prepare(`
    SELECT id, surface, bet_id, verdict_ids_json, actor, run_id, created_at
    FROM pw_verdict_exposures
    WHERE EXISTS (
      SELECT 1 FROM json_each(pw_verdict_exposures.verdict_ids_json) WHERE json_each.value = ?
    )
    ORDER BY created_at, id
  `).all(verdictId.trim()) as Array<{
    id: string;
    surface: string;
    bet_id: string | null;
    verdict_ids_json: string;
    actor: PwVerdictExposureActor;
    run_id: string | null;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    surface: row.surface,
    betId: row.bet_id,
    verdictIds: parseVerdictIds(row.verdict_ids_json),
    actor: row.actor,
    runId: row.run_id,
    createdAt: row.created_at,
  }));
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function parseVerdictIds(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function isPromotionLevel(value: unknown): value is PwPromotionLevel {
  return PW_PROMOTION_LEVELS.includes(value as PwPromotionLevel);
}

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw httpError(400, "文本字段格式非法");
  const text = value.trim();
  return text || null;
}
