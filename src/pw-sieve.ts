/**
 * TASK-PW-18：筛子 run（选题候选筛选管线 + 到达扳机去抖 + watermark 兜底）。
 *
 * 纪律（写进表结构的纪律）：
 * - 只产草稿不写正式表：筛子只写 pw_sieve_runs / pw_sieve_cards / pw_sieve_state
 *   与 pw_runs 审计事件（kind='sieve'），绝不写 pw_bets/pw_verdicts/pw_data_docs/pw_corpus_docs。
 * - 原文原则确定性断言：quote_text 必须是输入评论集合中某条的逐字子串（规范化空白后比对），
 *   不是模型说什么信什么；scale_value 由代码统计（同类命中计数），不取模型数字。
 * - 排序√推荐×：sort_score 由确定性公式算出；quote 外文本字段含「推荐/建议/应该」的整卡丢弃。
 * - 防平庸停线：每轮必须产出 ≥1 条 wildcard（异类区），否则 run 置 failed 不产卡。
 * - 到达按行 UUID 判定与去重（sync 无幂等键、批次无整体事务）；needs_human/failed 不产生到达。
 * - 单飞：同时至多一个 run 在途；在途时新到达只入队，等安静窗。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { contentText } from "@earendil-works/pi-ai";
import { httpError, nowIso } from "./data.ts";
import { getPwCorpusDoc, readPwCorpusComments, type PwCorpusCommentDetail } from "./pw-corpus.ts";
import { listPwDataDocVersions, type PwDataDocVersionRow } from "./pw-data-docs.ts";
import { getPwVerdictDetail } from "./pw-verdicts.ts";
import { recordPwEvent } from "./pw-runs.ts";
// 简报 23 · 曝光自动记账：筛子每轮注入点（buildSieveInput 装配的判决进提示词时记一行）
import { recordPwVerdictExposure } from "./pw-closed-loop.ts";
import { createPapertableProvider, type PapertableProvider } from "./provider-settings.ts";

export type PwSieveTriggerSource =
  | "sync"
  | "corpus_done"
  | "manual_entry"
  | "voice"
  | "open_fallback"
  | "watermark"
  | "manual"
  // TASK-PW-45：声音提请提升链的哨兵 run（人主动提请直写，不经过主筛线）
  | "voice_promotion";

const TRIGGER_SOURCES = new Set<PwSieveTriggerSource>([
  "sync",
  "corpus_done",
  "manual_entry",
  "voice",
  "open_fallback",
  "watermark",
  "manual",
  "voice_promotion",
]);

export type PwSieveRunRow = {
  id: string;
  trigger_source: PwSieveTriggerSource;
  input_ids_json: string;
  cards_count: number;
  dropped_count: number;
  status: "running" | "done" | "failed";
  error: string | null;
  model: string | null;
  /** TASK-PW-42：本轮 run 的方向快照（无方向 = NULL）。 */
  direction: string | null;
  created_at: string;
  finished_at: string | null;
};

export type PwSieveCardRow = {
  id: string;
  run_id: string;
  kind: "normal" | "wildcard";
  quote_text: string;
  quote_source_json: string;
  scale_note: string | null;
  scale_value: number;
  hook_note: string | null;
  freshness_note: string | null;
  sort_score: number;
  status: "pending" | "picked" | "edited" | "rejected";
  created_at: string;
};

/**
 * TASK-PW-42：候选卡读函数（联 pw_sieve_runs）的输出行——卡片自带的 run 方向快照，
 * 供 PW-44 卡脚展示（旧卡 direction 为 NULL = 默认）。
 */
export type PwSieveCardWithRun = PwSieveCardRow & { run_direction: string | null };

export function ensurePwSieveTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pw_sieve_runs (
      id TEXT PRIMARY KEY,
      trigger_source TEXT NOT NULL CHECK(trigger_source IN (
        'sync','corpus_done','manual_entry','voice','open_fallback','watermark','manual','voice_promotion'
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
    CREATE INDEX IF NOT EXISTS pw_sieve_runs_created ON pw_sieve_runs(created_at);
    CREATE TABLE IF NOT EXISTS pw_sieve_cards (
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
    CREATE INDEX IF NOT EXISTS pw_sieve_cards_run ON pw_sieve_cards(run_id);
    CREATE INDEX IF NOT EXISTS pw_sieve_cards_pending ON pw_sieve_cards(status, created_at);
    CREATE TABLE IF NOT EXISTS pw_sieve_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  migratePwSieveRunsDirection(db);
  migratePwSieveRunsCheck(db);
}

/**
 * TASK-PW-42：既有库的 pw_sieve_runs 无 direction 列（ALTER 追加）；
 * 已带新列的库（新建表）幂等跳过。旧行 direction 全部为 NULL。
 */
function migratePwSieveRunsDirection(db: DatabaseSync): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(pw_sieve_runs)").all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
  if (!columns.has("direction")) {
    db.exec("ALTER TABLE pw_sieve_runs ADD COLUMN direction TEXT");
  }
}

/**
 * TASK-PW-45：既有库的 pw_sieve_runs CHECK 不含 'voice_promotion'，重建表迁移
 * （CREATE TABLE IF NOT EXISTS 不会改动既有约束）。
 * 本表被 pw_sieve_cards.run_id 外键引用——PRAGMA foreign_keys 先关后开，数据全量拷贝，
 * 重建期间不动 pw_sieve_cards（外键按表名解析，RENAME 后照常指回新表，不丢行）；
 * 重建后补齐 runs 表的 created_at 索引（DROP TABLE 会连索引一起删）。
 */
function migratePwSieveRunsCheck(db: DatabaseSync): void {
  const definition = (db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pw_sieve_runs'
  `).get() as { sql?: string } | undefined)?.sql ?? "";
  if (definition.includes("voice_promotion")) return;
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE pw_sieve_runs_v2 (
        id TEXT PRIMARY KEY,
        trigger_source TEXT NOT NULL CHECK(trigger_source IN (
          'sync','corpus_done','manual_entry','voice','open_fallback','watermark','manual','voice_promotion'
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
      INSERT INTO pw_sieve_runs_v2
        SELECT id, trigger_source, input_ids_json, cards_count, dropped_count,
               status, error, model, direction, created_at, finished_at
        FROM pw_sieve_runs;
      DROP TABLE pw_sieve_runs;
      ALTER TABLE pw_sieve_runs_v2 RENAME TO pw_sieve_runs;
      CREATE INDEX pw_sieve_runs_created ON pw_sieve_runs(created_at);
      COMMIT;
    `);
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original constraint error.
    }
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

// ---------------------------------------------------------------------------
// 筛子主提示词（中文常量，写死在代码里；只搬运摆盘不掌勺）
// ---------------------------------------------------------------------------

export const SIEVE_SYSTEM_PROMPT = [
  "你是「镇纸 Paperweight」的选题筛子：只搬运和摆盘，不掌勺。",
  "1. 引文必须逐字复制输入语料评论的原文，禁止改写、概括、翻译；quote_source 里填引文出处。",
  "2. 必须输出 1~3 条 wildcard=true 的卡：归不进堆的、反常识的、少数人说但说得狠的异类信号。",
  "3. 禁止出现推荐性措辞（如「推荐」「建议」「应该」），只摆证据，不做决策。",
  "4. 规模感只描述现象，不编造数字；数字由系统按数据统计。",
  "5. 没有可搬运的引文时，输出空 cards（{\"cards\":[]}）。",
  "6. 只输出一个 JSON 对象，不要 Markdown 代码块以外的任何文字。格式：",
  "{\"cards\":[{\"quote_text\":\"引文逐字原文\",\"quote_source\":{\"bvid\":\"BV号\",\"uname\":\"评论者\",\"like\":数字,\"rpid\":数字},\"scale_note\":\"规模备注\",\"hook_note\":\"挂钩点备注\",\"freshness_note\":\"新鲜度备注\",\"wildcard\":false}]}",
].join("\n");

/** 输入装配字符预算（建议 60k；评论超出按点赞/时间排序截断，保留高优先）。 */
const SIEVE_CHAR_BUDGET = 60_000;

/** 观众声音伪来源标记：声音没有 BV 号，quote_source.bvid 用该固定值区分。 */
const VOICE_BVID = "voice";

/** 推荐语扫描：quote 外文本字段命中即整卡丢弃（停线 1 的机器兜底）。 */
const RECOMMEND_PATTERN = /推荐|建议|应该/u;

/**
 * 新鲜度权重（常数）：按评论 ctime 距今天数分档。
 * ≤1 天 → 2.0；≤7 天 → 1.0；≤30 天 → 0.5；>30 天 → 0；无 ctime → 0。
 */
function freshnessWeight(ctimeSec: number | null, nowMs: number): number {
  if (ctimeSec == null || !Number.isFinite(ctimeSec)) return 0;
  const days = Math.floor((nowMs / 1000 - ctimeSec) / 86_400);
  if (days <= 1) return 2.0;
  if (days <= 7) return 1.0;
  if (days <= 30) return 0.5;
  return 0;
}

// ---------------------------------------------------------------------------
// 装配：buildSieveInput（评论全文 + meta/stat + data_docs 版本 + 金子墓碑）
// ---------------------------------------------------------------------------

export type SieveComment = {
  bvid: string;
  uname: string | null;
  message: string;
  like: number | null;
  ctime: number | null;
  rpid: number | null;
};

export type SieveInput = {
  corpora: Array<{
    id: string;
    bvid: string;
    title: string | null;
    up_name: string | null;
    comment_count: number | null;
    stat: Record<string, number> | null;
  }>;
  comments: SieveComment[];
  dataDocs: Array<{
    id: string;
    betId: string;
    betTitle: string | null;
    platform: string;
    method: string;
    version: number;
    collectedAt: string;
    metricsJson: string;
    versions: PwDataDocVersionRow[];
  }>;
  voiceItems: Array<{ id: string; platform: string; capturedAt: string; content: string }>;
  verdicts: Array<{ id: string; outcome: string; text: string; betTitle: string | null }>;
};

/**
 * 按行 UUID 归类到达 id（同一 id 只归入第一个命中的表；两表都不在的丢弃）。
 * 只读，不吞异常之外的错误。
 */
function classifyArrivalIds(
  db: DatabaseSync,
  ids: readonly string[],
): { dataDocIds: string[]; corpusIds: string[]; voiceIds: string[] } {
  const dataDocIds: string[] = [];
  const corpusIds: string[] = [];
  const voiceIds: string[] = [];
  const inTable = (table: string): Set<string> => {
    const clean = dedupeArrivalIds(ids);
    if (clean.length === 0) return new Set();
    const rows = db.prepare(
      `SELECT id FROM ${table} WHERE id IN (${clean.map(() => "?").join(", ")})`,
    ).all(...clean) as Array<{ id: string }>;
    return new Set(rows.map((row) => row.id));
  };
  const data = inTable("pw_data_docs");
  const corpus = inTable("pw_corpus_docs");
  const voice = inTable("pw_voice_items");
  for (const id of dedupeArrivalIds(ids)) {
    if (data.has(id)) dataDocIds.push(id);
    else if (corpus.has(id)) corpusIds.push(id);
    else if (voice.has(id)) voiceIds.push(id);
  }
  return { dataDocIds, corpusIds, voiceIds };
}

/** 输入评论集合：语料全量评论 + 未丢弃的观众声音（伪 bvid='voice'）。损坏语料跳过。 */
function collectInputComments(db: DatabaseSync, inputIds: readonly string[]): SieveComment[] {
  const { corpusIds, voiceIds } = classifyArrivalIds(db, inputIds);
  const comments: SieveComment[] = [];
  for (const corpusId of corpusIds) {
    try {
      const doc = getPwCorpusDoc(db, corpusId);
      if (doc.status !== "done" || !doc.bvid) continue;
      for (const comment of readPwCorpusComments(db, doc.bvid)) {
        comments.push({
          bvid: doc.bvid,
          uname: comment.uname,
          message: comment.message,
          like: comment.like,
          ctime: comment.ctime,
          rpid: comment.rpid,
        });
      }
    } catch {
      // 语料行非 done / 落盘文件缺失：跳过该语料（防御，不让整批失败）
      continue;
    }
  }
  if (voiceIds.length > 0) {
    const rows = db.prepare(`
      SELECT id, platform, content, captured_at
      FROM pw_voice_items
      WHERE id IN (${voiceIds.map(() => "?").join(", ")}) AND dropped_reason IS NULL
    `).all(...voiceIds) as Array<{ id: string; platform: string; content: string; captured_at: string }>;
    for (const row of rows) {
      comments.push({
        bvid: VOICE_BVID,
        uname: null,
        message: row.content,
        like: null,
        ctime: toEpochSeconds(row.captured_at),
        rpid: null,
      });
    }
  }
  return comments;
}

/** TASK-PW-18：装配筛子输入（只读消费 PW-17 读通路；损坏数据跳过不阻断整批）。 */
export function buildSieveInput(db: DatabaseSync, ids: readonly string[]): SieveInput {
  const { dataDocIds, corpusIds, voiceIds } = classifyArrivalIds(db, ids);
  const corpora: SieveInput["corpora"] = [];
  for (const corpusId of corpusIds) {
    try {
      const doc = getPwCorpusDoc(db, corpusId);
      if (doc.status !== "done" || !doc.bvid) continue;
      corpora.push({
        id: doc.id,
        bvid: doc.bvid,
        title: doc.title,
        up_name: doc.up_name,
        comment_count: doc.comment_count,
        stat: doc.video_stat,
      });
    } catch {
      continue;
    }
  }

  const comments = collectInputComments(db, ids);

  const dataDocs: SieveInput["dataDocs"] = [];
  if (dataDocIds.length > 0) {
    const rows = db.prepare(`
      SELECT d.*, b.title AS bet_title, a.title AS artifact_title
      FROM pw_data_docs d
      LEFT JOIN pw_bets b ON b.id = d.bet_id
      LEFT JOIN pw_artifacts a ON a.id = d.artifact_id
      WHERE d.id IN (${dataDocIds.map(() => "?").join(", ")})
      ORDER BY d.created_at, d.id
    `).all(...dataDocIds) as Array<Record<string, unknown>>;
    for (const row of rows) {
      let versions: PwDataDocVersionRow[] = [];
      try {
        versions = listPwDataDocVersions(db, {
          betId: String(row.bet_id),
          platform: String(row.platform),
          artifactId: row.artifact_id == null ? null : String(row.artifact_id),
        });
      } catch {
        versions = [];
      }
      dataDocs.push({
        id: String(row.id),
        betId: String(row.bet_id),
        betTitle: typeof row.bet_title === "string" ? row.bet_title : null,
        platform: String(row.platform),
        method: String(row.method),
        version: Number(row.version),
        collectedAt: String(row.collected_at),
        metricsJson: String(row.metrics_json),
        versions,
      });
    }
  }

  const voiceItems: SieveInput["voiceItems"] = [];
  if (voiceIds.length > 0) {
    const rows = db.prepare(`
      SELECT id, platform, content, captured_at
      FROM pw_voice_items
      WHERE id IN (${voiceIds.map(() => "?").join(", ")}) AND dropped_reason IS NULL
    `).all(...voiceIds) as Array<{ id: string; platform: string; content: string; captured_at: string }>;
    for (const row of rows) {
      voiceItems.push({
        id: row.id,
        platform: row.platform,
        capturedAt: row.captured_at,
        content: row.content,
      });
    }
  }

  // 相关金子墓碑摘要：全项目 gold/tomb 判决（decided_at 倒序，上限 10 条）
  const verdicts: SieveInput["verdicts"] = [];
  const verdictRows = db.prepare(`
    SELECT id FROM pw_verdicts
    WHERE outcome IN ('gold','tomb')
    ORDER BY decided_at DESC, created_at DESC
    LIMIT 10
  `).all() as Array<{ id: string }>;
  for (const verdictRow of verdictRows) {
    try {
      const detail = getPwVerdictDetail(db, verdictRow.id);
      const text = detail.outcome === "gold" ? detail.lesson ?? "" : detail.cause_of_death ?? "";
      verdicts.push({
        id: detail.id,
        outcome: detail.outcome,
        text,
        betTitle: detail.bet_title,
      });
    } catch {
      continue;
    }
  }

  return { corpora, comments, dataDocs, voiceItems, verdicts };
}

/**
 * 提示词渲染：评论先按点赞/时间排序，超预算从低优先级截断。
 * TASK-PW-42：direction 非空时在 sections 顶部注入「当前方向」段；无方向整段不出现，
 * 输出与 PW-42 之前逐字节一致（防回归金线，测试硬断言）。
 */
export function buildSievePrompt(input: SieveInput, direction: string | null): string {
  const sorted = [...input.comments].sort(
    (a, b) => (b.like ?? 0) - (a.like ?? 0) || (b.ctime ?? 0) - (a.ctime ?? 0),
  );
  const commentLines: string[] = [];
  let used = 0;
  for (const comment of sorted) {
    const line =
      `[bvid=${comment.bvid}|uname=${comment.uname ?? "?"}|like=${comment.like ?? 0}|`
      + `ctime=${comment.ctime ?? 0}] ${comment.message}`;
    if (used + line.length > SIEVE_CHAR_BUDGET) break;
    commentLines.push(line);
    used += line.length;
  }

  const sections: string[] = [];
  if (direction) {
    sections.push(
      "### 当前方向（人定的捞取取向，搬运摆盘时优先朝这个方向捞；其余纪律不变）\n" + direction,
    );
  }
  sections.push(
    `### 输入语料评论（按点赞/时间排序，已按预算截断；共 ${sorted.length} 条，展示 ${commentLines.length} 条）\n`
    + (commentLines.join("\n") || "（无）"),
  );
  sections.push(
    "### 输入语料（meta/stat）\n"
    + (input.corpora.length
      ? input.corpora.map((doc) =>
        `- [bvid=${doc.bvid}|title=${doc.title ?? "?"}|up_name=${doc.up_name ?? "?"}|`
        + `comment_count=${doc.comment_count ?? 0}] stat=${JSON.stringify(doc.stat ?? {})}`)
        .join("\n")
      : "（无）"),
  );
  sections.push(
    "### 数据文档版本链\n"
    + (input.dataDocs.length
      ? input.dataDocs.map((doc) => {
        const chain = doc.versions.slice(0, 5)
          .map((version) => `      version ${version.version}（${version.created_at}）metrics=${version.metrics_json}`)
          .join("\n");
        return `- data_doc ${doc.id}（bet=${doc.betTitle ?? doc.betId}，platform=${doc.platform}，`
          + `method=${doc.method}，version=${doc.version}，collected=${doc.collectedAt}）metrics=${doc.metricsJson}\n${chain}`;
      }).join("\n")
      : "（无）"),
  );
  sections.push(
    "### 观众声音\n"
    + (input.voiceItems.length
      ? input.voiceItems.map((item) =>
        `- [voice ${item.id}|platform=${item.platform}|captured=${item.capturedAt}] ${item.content}`)
        .join("\n")
      : "（无）"),
  );
  sections.push(
    "### 相关金子墓碑（判决摘要，只供背景参考）\n"
    + (input.verdicts.length
      ? input.verdicts.map((verdict) => `- [${verdict.outcome} ${verdict.id}] ${verdict.text}`).join("\n")
      : "（无）"),
  );
  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// LLM：单次结构化产出（非工具循环）；测试注入 mock llm
// ---------------------------------------------------------------------------

export type SieveLlm = (inputText: string) => Promise<string>;

function defaultSieveLlm(provider: PapertableProvider): SieveLlm {
  return async (inputText) => {
    const response = await provider.models.completeSimple(provider.model, {
      systemPrompt: SIEVE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: inputText, timestamp: Date.now() }],
    }, {
      maxTokens: 6000,
      timeoutMs: 60_000,
      maxRetries: 0,
      maxRetryDelayMs: 0,
    });
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage || `筛子调用失败：${response.stopReason}`);
    }
    return contentText(response.content, "");
  };
}

type ParsedSieveCard = {
  quote_text: string;
  quote_source: Record<string, unknown>;
  scale_note: string | null;
  hook_note: string | null;
  freshness_note: string | null;
  wildcard: boolean;
};

/** JSON 校验：结构不符抛错（触发重试 1 次）；可选字段宽松取。 */
function parseSieveJson(raw: string): ParsedSieveCard[] {
  const unwrapped = raw.trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapped);
  } catch {
    throw new Error("筛子输出不是合法 JSON");
  }
  if (!isRecord(parsed)) throw new Error("筛子输出必须是 JSON 对象");
  const cards = parsed.cards;
  if (!Array.isArray(cards)) throw new Error("筛子输出缺 cards 数组");
  const result: ParsedSieveCard[] = [];
  for (const item of cards) {
    if (!isRecord(item)) throw new Error("卡片必须是 JSON 对象");
    if (typeof item.quote_text !== "string" || !item.quote_text.trim()) {
      throw new Error("卡片缺 quote_text 原文引文");
    }
    result.push({
      quote_text: item.quote_text,
      quote_source: isRecord(item.quote_source) ? item.quote_source : {},
      scale_note: optionalString(item.scale_note),
      hook_note: optionalString(item.hook_note),
      freshness_note: optionalString(item.freshness_note),
      wildcard: item.wildcard === true,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// 确定性后处理（不信模型自报）：原文断言 / scale 统计 / 排序分 / 推荐语扫描
// ---------------------------------------------------------------------------

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * 后处理：返回保留卡与丢弃计数。
 * - 原文断言：规范化空白后的引文必须是某条输入评论的逐字子串，否则丢弃；
 * - 同引文去重：同一规范化引文只保留一次（确定性卫生），重复丢弃；
 * - 推荐语扫描：quote 外文本字段（scale/hook/freshness_note）含「推荐/建议/应该」整卡丢弃；
 * - scale_value：输入评论中含该引文的条数（同类命中计数，代码统计）；
 * - sort_score = scale_value*2 + min(like,100)/50 + 新鲜度权重；wildcard 不参与排序（0）。
 */
function postProcessCards(
  db: DatabaseSync,
  runId: string,
  inputIds: readonly string[],
  parsedCards: ParsedSieveCard[],
  nowMs: number,
): { kept: PwSieveCardRow[]; dropped: number } {
  const comments = collectInputComments(db, inputIds);
  const normalized = comments.map((comment) => ({
    comment,
    norm: normalizeWhitespace(comment.message),
  }));
  const kept: PwSieveCardRow[] = [];
  let dropped = 0;
  const seenQuotes = new Set<string>();
  const createdAt = nowIso();

  for (const card of parsedCards) {
    const quote = normalizeWhitespace(card.quote_text);
    if (!quote) {
      dropped += 1;
      continue;
    }
    const matches = normalized.filter((entry) => entry.norm.includes(quote));
    if (matches.length === 0) {
      dropped += 1;
      continue;
    }
    const notes = [card.scale_note, card.hook_note, card.freshness_note].filter(Boolean).join(" ");
    if (RECOMMEND_PATTERN.test(notes)) {
      dropped += 1;
      continue;
    }
    if (seenQuotes.has(quote)) {
      dropped += 1;
      continue;
    }
    seenQuotes.add(quote);

    const best = matches.sort((a, b) => (b.comment.like ?? 0) - (a.comment.like ?? 0))[0].comment;
    const like = best.like ?? 0;
    const scaleValue = matches.length;
    const wildcard = card.wildcard;
    const sortScore = wildcard
      ? 0
      : scaleValue * 2 + Math.min(like, 100) / 50 + freshnessWeight(best.ctime, nowMs);

    const source: Record<string, unknown> = { bvid: best.bvid, uname: best.uname };
    if (best.like != null) source.like = best.like;
    if (best.rpid != null) source.rpid = best.rpid;

    kept.push({
      id: randomUUID(),
      run_id: runId,
      kind: wildcard ? "wildcard" : "normal",
      quote_text: quote,
      quote_source_json: JSON.stringify(source),
      scale_note: card.scale_note,
      scale_value: scaleValue,
      hook_note: card.hook_note,
      freshness_note: card.freshness_note,
      sort_score: sortScore,
      status: "pending",
      created_at: createdAt,
    });
  }
  return { kept, dropped };
}

// ---------------------------------------------------------------------------
// 主管线 runPwSieve
// ---------------------------------------------------------------------------

export type SieveRunOptions = {
  /** 注入 mock llm（测试）；缺省用 createPapertableProvider 的真实模型。 */
  llm?: SieveLlm;
  /** 注入时钟（测试排序分新鲜度），缺省 Date.now。 */
  now?: () => number;
  /** 注入 llm 时记录到 run.model 的标签。 */
  modelLabel?: string | null;
};

/**
 * 单次筛选：装配 → 单次 LLM 结构化产出（非工具循环）→ 确定性后处理 → 落草稿表 + 审计事件。
 * LLM 异常 / JSON 校验失败重试 1 次；仍败置 failed 不产卡、watermark 不前进。
 * 防平庸停线：后处理后 wildcard=0 置 failed（策略失败不重试）。
 * 返回落库后的 run 行（调用方据此读卡片）。
 */
export async function runPwSieve(
  db: DatabaseSync,
  source: PwSieveTriggerSource,
  ids: readonly string[],
  options: SieveRunOptions = {},
): Promise<PwSieveRunRow> {
  if (!TRIGGER_SOURCES.has(source)) throw httpError(400, "非法筛子触发源");
  const inputIds = dedupeArrivalIds(ids);
  const createdAt = nowIso();
  const nowMs = options.now ? options.now() : Date.now();
  const runId = randomUUID();
  // TASK-PW-42：本轮 run 的方向快照（run 开始时读取，无方向 = NULL）
  const direction = getSieveDirection(db);

  let provider: PapertableProvider | null = null;
  const llm = options.llm ?? null;
  let model = options.modelLabel ?? null;

  db.prepare(`
    INSERT INTO pw_sieve_runs(
      id, trigger_source, input_ids_json, cards_count, dropped_count,
      status, error, model, direction, created_at, finished_at
    ) VALUES(?, ?, ?, 0, 0, 'running', NULL, ?, ?, ?, NULL)
  `).run(runId, source, JSON.stringify(inputIds), model, direction, createdAt);

  const finish = (status: "done" | "failed", error: string | null): PwSieveRunRow => {
    db.prepare(`
      UPDATE pw_sieve_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?
    `).run(status, error, nowIso(), runId);
    return getSieveRun(db, runId);
  };

  try {
    const input = buildSieveInput(db, inputIds);
    if (input.comments.length === 0) {
      // 无可搬运评论（例如只到了 data_doc / 已丢弃声音）：直接完成不调模型，0 卡不算失败
      advanceWatermarkFromInput(db, inputIds);
      return finish("done", null);
    }
    // 简报 23 · 曝光自动记账：本轮实际会把 input.verdicts 放进提示词「相关金子墓碑」段
    recordPwVerdictExposure(db, {
      surface: "sieve",
      verdictIds: input.verdicts.map((verdict) => verdict.id),
      actor: "system",
      runId,
    });

    if (!llm) {
      provider = createPapertableProvider();
      model = provider.model.id;
      db.prepare("UPDATE pw_sieve_runs SET model = ? WHERE id = ?").run(model, runId);
    }
    const runLlm = llm ?? defaultSieveLlm(provider!);

    let parsed: ParsedSieveCard[] | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const raw = await runLlm(buildSievePrompt(input, direction));
        parsed = parseSieveJson(raw);
        break;
      } catch (error) {
        lastError = error;
        // LLM 异常或 JSON 校验失败：第 2 次循环即重试 1 次
      }
    }
    if (!parsed) {
      return finish("failed", `筛子模型产出失败：${safeErrorText(lastError)}`);
    }

    const { kept, dropped } = postProcessCards(db, runId, inputIds, parsed, nowMs);
    if (kept.filter((card) => card.kind === "wildcard").length === 0) {
      // 防平庸停线：没有 wildcard 的轮次不合格（策略失败，重试不救，不产卡）
      return finish("failed", "wildcard 缺失：本轮未产出任何 wildcard 卡（防平庸停线）");
    }

    const insertCard = db.prepare(`
      INSERT INTO pw_sieve_cards(
        id, run_id, kind, quote_text, quote_source_json, scale_note, scale_value,
        hook_note, freshness_note, sort_score, status, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `);
    for (const card of kept) {
      insertCard.run(
        card.id, card.run_id, card.kind, card.quote_text, card.quote_source_json,
        card.scale_note, card.scale_value, card.hook_note, card.freshness_note,
        card.sort_score, card.created_at,
      );
    }
    recordPwEvent(db, {
      kind: "sieve",
      eventType: "sieve_run",
      actor: "system",
      payloadJson: JSON.stringify({
        runId,
        inputIds,
        cardsCount: kept.length,
        droppedCount: dropped,
      }),
      relatedIds: inputIds,
    });
    advanceWatermarkFromInput(db, inputIds);
    db.prepare(`
      UPDATE pw_sieve_runs
      SET status = 'done', error = NULL, finished_at = ?, cards_count = ?, dropped_count = ?
      WHERE id = ?
    `).run(nowIso(), kept.length, dropped, runId);
    return getSieveRun(db, runId);
  } catch (error) {
    // 装配数据错误等未预期异常：置 failed（watermark 不前进，下轮可补筛）
    return finish("failed", safeErrorText(error));
  }
}

// ---------------------------------------------------------------------------
// TASK-PW-42：方向（pw_sieve_state key='sieve_direction'，直接 SQL 照 watermark 先例）
// ---------------------------------------------------------------------------

/** 读当前方向（空白视为 null；未设过返回 null）。 */
export function getSieveDirection(db: DatabaseSync): string | null {
  const row = db.prepare(
    "SELECT value FROM pw_sieve_state WHERE key = 'sieve_direction'",
  ).get() as { value: string } | undefined;
  if (!row) return null;
  const text = row.value.trim();
  return text || null;
}

/** 写方向（空白/null = 删行清除，读回统一 null）。 */
export function setSieveDirection(db: DatabaseSync, direction: string | null): void {
  const text = direction?.trim() ?? "";
  if (!text) {
    db.prepare("DELETE FROM pw_sieve_state WHERE key = 'sieve_direction'").run();
    return;
  }
  db.prepare(`
    INSERT INTO pw_sieve_state(key, value) VALUES('sieve_direction', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(text);
}

// ---------------------------------------------------------------------------
// watermark：pw_sieve_state.last_watermark_json（三线水位）
// ---------------------------------------------------------------------------

type Watermark = {
  data_docs?: { created_at: string; id: string };
  corpus_docs?: { fetched_at: string; id: string };
  voice_items?: { created_at: string; id: string };
};

function readWatermark(db: DatabaseSync): Watermark {
  const row = db.prepare(
    "SELECT value FROM pw_sieve_state WHERE key = 'last_watermark_json'",
  ).get() as { value: string } | undefined;
  if (!row) return {};
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Watermark;
    }
  } catch {
    // 损坏水位按空处理（全量重筛兜底）
  }
  return {};
}

function writeWatermark(db: DatabaseSync, watermark: Watermark): void {
  db.prepare(`
    INSERT INTO pw_sieve_state(key, value) VALUES('last_watermark_json', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(JSON.stringify(watermark));
}

function maxTuple(
  current: { created_at: string; id: string } | undefined,
  candidate: { created_at: string; id: string } | null,
): { created_at: string; id: string } | undefined {
  if (!candidate) return current;
  if (!current || candidate.created_at > current.created_at
    || (candidate.created_at === current.created_at && candidate.id > current.id)) {
    return candidate;
  }
  return current;
}

/**
 * run 成功后按实际消费的输入行推进水位（每线取消费行的最大位置，与既有水位合并）。
 * 只推进「本轮真正筛过」的行，未消费的更新行留在水位之上，下轮仍可补筛。
 */
function advanceWatermarkFromInput(db: DatabaseSync, inputIds: readonly string[]): void {
  if (inputIds.length === 0) return;
  const next: Watermark = { ...readWatermark(db) };
  const placeholders = inputIds.map(() => "?").join(", ");

  const dataRows = db.prepare(
    `SELECT id, created_at FROM pw_data_docs WHERE id IN (${placeholders})`,
  ).all(...inputIds) as Array<{ id: string; created_at: string }>;
  for (const row of dataRows) {
    next.data_docs = maxTuple(next.data_docs, { created_at: row.created_at, id: row.id });
  }

  const corpusRows = db.prepare(
    `SELECT id, fetched_at FROM pw_corpus_docs
     WHERE id IN (${placeholders}) AND status = 'done' AND fetched_at IS NOT NULL`,
  ).all(...inputIds) as Array<{ id: string; fetched_at: string }>;
  for (const row of corpusRows) {
    next.corpus_docs = maxTuple(next.corpus_docs, { created_at: row.fetched_at, id: row.id });
  }

  const voiceRows = db.prepare(
    `SELECT id, created_at FROM pw_voice_items WHERE id IN (${placeholders})`,
  ).all(...inputIds) as Array<{ id: string; created_at: string }>;
  for (const row of voiceRows) {
    next.voice_items = maxTuple(next.voice_items, { created_at: row.created_at, id: row.id });
  }

  writeWatermark(db, next);
}

/** 60s 兜底比对：返回三线水位之上的新行 UUID（崩溃恢复，内存队列会丢）。 */
function collectWatermarkGap(db: DatabaseSync): string[] {
  const watermark = readWatermark(db);
  const ids: string[] = [];

  if (watermark.data_docs) {
    const rows = db.prepare(`
      SELECT id FROM pw_data_docs
      WHERE created_at > ? OR (created_at = ? AND id > ?)
      ORDER BY created_at, id
    `).all(watermark.data_docs.created_at, watermark.data_docs.created_at, watermark.data_docs.id) as Array<{ id: string }>;
    ids.push(...rows.map((row) => row.id));
  } else {
    const rows = db.prepare(
      "SELECT id FROM pw_data_docs ORDER BY created_at, id",
    ).all() as Array<{ id: string }>;
    ids.push(...rows.map((row) => row.id));
  }

  if (watermark.corpus_docs) {
    const rows = db.prepare(`
      SELECT id FROM pw_corpus_docs
      WHERE status = 'done' AND fetched_at IS NOT NULL
        AND (fetched_at > ? OR (fetched_at = ? AND id > ?))
      ORDER BY fetched_at, id
    `).all(watermark.corpus_docs.fetched_at, watermark.corpus_docs.fetched_at, watermark.corpus_docs.id) as Array<{ id: string }>;
    ids.push(...rows.map((row) => row.id));
  } else {
    const rows = db.prepare(`
      SELECT id FROM pw_corpus_docs
      WHERE status = 'done' AND fetched_at IS NOT NULL
      ORDER BY fetched_at, id
    `).all() as Array<{ id: string }>;
    ids.push(...rows.map((row) => row.id));
  }

  if (watermark.voice_items) {
    const rows = db.prepare(`
      SELECT id FROM pw_voice_items
      WHERE created_at > ? OR (created_at = ? AND id > ?)
      ORDER BY created_at, id
    `).all(watermark.voice_items.created_at, watermark.voice_items.created_at, watermark.voice_items.id) as Array<{ id: string }>;
    ids.push(...rows.map((row) => row.id));
  } else {
    const rows = db.prepare(
      "SELECT id FROM pw_voice_items ORDER BY created_at, id",
    ).all() as Array<{ id: string }>;
    ids.push(...rows.map((row) => row.id));
  }

  return ids;
}

/** 已在任一 done run 的输入里出现过的行视为已筛（去重按行 UUID）。 */
function filterUnsieved(db: DatabaseSync, ids: readonly string[]): string[] {
  if (ids.length === 0) return [];
  const sieved = new Set<string>();
  const rows = db.prepare(
    "SELECT input_ids_json FROM pw_sieve_runs WHERE status = 'done'",
  ).all() as Array<{ input_ids_json: string }>;
  for (const row of rows) {
    try {
      const parsed: unknown = JSON.parse(row.input_ids_json);
      if (!Array.isArray(parsed)) continue;
      for (const id of parsed) if (typeof id === "string") sieved.add(id);
    } catch {
      // 忽略损坏行
    }
  }
  return ids.filter((id) => !sieved.has(id));
}

// ---------------------------------------------------------------------------
// TASK-PW-48：老料重筛直通通路（绕过 notifier 层）
// filterUnsieved 只在 notifier 层生效，runPwSieve 本体不过滤——所以重筛老料
// 不需要动 watermark：run 成功后 advanceWatermarkFromInput 自然把水位推齐（既有行为）。
// ---------------------------------------------------------------------------

/** 全量输入 ids（三表口径照 collectWatermarkGap）：done 语料 + 未丢弃声音 + 数据文档。 */
function collectAllResieveIds(db: DatabaseSync): string[] {
  const ids: string[] = [];
  const dataRows = db.prepare(
    "SELECT id FROM pw_data_docs ORDER BY created_at, id",
  ).all() as Array<{ id: string }>;
  ids.push(...dataRows.map((row) => row.id));

  const corpusRows = db.prepare(`
    SELECT id FROM pw_corpus_docs
    WHERE status = 'done' AND fetched_at IS NOT NULL
    ORDER BY fetched_at, id
  `).all() as Array<{ id: string }>;
  ids.push(...corpusRows.map((row) => row.id));

  const voiceRows = db.prepare(`
    SELECT id FROM pw_voice_items WHERE dropped_reason IS NULL ORDER BY created_at, id
  `).all() as Array<{ id: string }>;
  ids.push(...voiceRows.map((row) => row.id));

  return ids;
}

/**
 * TASK-PW-48：老料重筛——把三线全量输入直接送进主管线重筛一遍（绕过 notifier 层，
 * 不走 filterUnsieved，已进过 done run 的行也会重筛）。
 * 在途 409 与 flushNow 一致（runPwSieve 建行发生在首个 await 之前，查 running 行
 * 即可拦下同一进程内的在途 run）；输入全空直接返回 runId null 不调 LLM。
 */
export async function resieveAllPwSieve(
  db: DatabaseSync,
  options: SieveRunOptions = {},
): Promise<{ runId: string | null }> {
  const inflight = db.prepare(
    "SELECT id FROM pw_sieve_runs WHERE status = 'running' LIMIT 1",
  ).get() as { id: string } | undefined;
  if (inflight) throw httpError(409, "筛子运行中");
  const ids = collectAllResieveIds(db);
  if (ids.length === 0) return { runId: null };
  const run = await runPwSieve(db, "manual", ids, options);
  return { runId: run.id };
}

// ---------------------------------------------------------------------------
// 到达通知器：内存去抖队列（10 分钟安静窗合并）+ 单飞 + watermark 兜底
// ---------------------------------------------------------------------------

const DEFAULT_DEBOUNCE_MS = 10 * 60_000;

export type SieveNotifierOptions = {
  db: DatabaseSync;
  /** 注入 mock llm（测试）；缺省用真实 provider。 */
  llm?: SieveLlm;
  /** 注入时钟（测试），缺省 Date.now。 */
  now?: () => number;
  /** 安静窗毫秒，缺省 10 分钟。 */
  debounceMs?: number;
  /** 注入定时器调度（测试假时钟），缺省 setTimeout（unref）。 */
  schedule?: (fn: () => void | Promise<void>, ms: number) => unknown;
  clearSchedule?: (handle: unknown) => void;
};

export type SieveNotifier = {
  /** 四条到达线统一收口：内存去抖队列；去重按行 UUID。 */
  notifyArrival(source: PwSieveTriggerSource, ids: readonly string[]): void;
  /** 手动/兜底：立即触发一筛（绕过安静窗）；在途则抛 409。 */
  flushNow(): Promise<{ runId: string | null }>;
  /** 60s 周期兜底：比对三线水位，有差且无在途 run 且不在内存队列 → 补筛。 */
  tickWatermark(): Promise<void>;
  pendingCount(): number;
  status(): { running: boolean; pendingArrivals: number };
  close(): void;
};

function defaultSchedule(fn: () => void | Promise<void>, ms: number): unknown {
  const timer = setTimeout(() => void fn(), ms);
  timer.unref?.();
  return timer;
}

export function createSieveNotifier(options: SieveNotifierOptions): SieveNotifier {
  const db = options.db;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? defaultSchedule;
  const clearSchedule = options.clearSchedule ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));

  let pending: Array<{ source: PwSieveTriggerSource; ids: string[] }> = [];
  let timer: unknown = null;
  let running = false;

  const arm = (): void => {
    if (timer !== null) clearSchedule(timer);
    timer = schedule(async () => {
      timer = null;
      await flush();
    }, debounceMs);
  };

  async function flush(): Promise<{ runId: string | null }> {
    if (running) {
      // 单飞：在途时新到达只入队（已入队），重新计时等下次安静窗
      if (pending.length > 0) arm();
      return { runId: null };
    }
    const batch = pending;
    pending = [];
    const rawIds = dedupeArrivalIds(batch.flatMap((entry) => entry.ids));
    const ids = filterUnsieved(db, rawIds);
    if (ids.length === 0) return { runId: null };
    // 合并批的触发源取最先到达者（多源合并时以第一线为准）
    const source = batch.length > 0 ? batch[0].source : "manual";
    running = true;
    try {
      const run = await runPwSieve(db, source, ids, { llm: options.llm, now: options.now });
      return { runId: run.id };
    } catch {
      // runPwSieve 内部已把失败落表为 failed；这里只防未预期异常
      return { runId: null };
    } finally {
      running = false;
      if (pending.length > 0) arm();
    }
  }

  async function flushNow(): Promise<{ runId: string | null }> {
    if (running) throw httpError(409, "筛子运行中");
    if (timer !== null) {
      clearSchedule(timer);
      timer = null;
    }
    const batch = pending;
    pending = [];
    const rawIds = dedupeArrivalIds(batch.flatMap((entry) => entry.ids));
    const ids = filterUnsieved(db, rawIds);
    if (ids.length === 0) return { runId: null };
    running = true;
    try {
      const run = await runPwSieve(db, "manual", ids, { llm: options.llm, now: options.now });
      return { runId: run.id };
    } catch {
      return { runId: null };
    } finally {
      running = false;
      if (pending.length > 0) arm();
    }
  }

  async function tickWatermark(): Promise<void> {
    if (running) return;
    const gapIds = collectWatermarkGap(db);
    if (gapIds.length === 0) return;
    const pendingIds = new Set(pending.flatMap((entry) => entry.ids));
    const ids = gapIds.filter((id) => !pendingIds.has(id));
    if (ids.length === 0) return;
    running = true;
    try {
      await runPwSieve(db, "watermark", ids, { llm: options.llm, now: options.now });
    } catch {
      // 同上：失败已落表，不抛出
    } finally {
      running = false;
      if (pending.length > 0) arm();
    }
  }

  return {
    notifyArrival(source, ids) {
      const clean = dedupeArrivalIds(ids);
      if (clean.length === 0) return;
      pending.push({ source, ids: clean });
      arm();
    },
    flushNow,
    tickWatermark,
    pendingCount() {
      return new Set(pending.flatMap((entry) => entry.ids)).size;
    },
    status() {
      return { running, pendingArrivals: new Set(pending.flatMap((entry) => entry.ids)).size };
    },
    close() {
      if (timer !== null) {
        clearSchedule(timer);
        timer = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 读取：状态与卡片（供 GET /api/pw/sieve/status 与 PW-20 协作台屏消费）
// ---------------------------------------------------------------------------

export function sieveStatus(
  db: DatabaseSync,
  notifier: SieveNotifier,
): { last_run_at: string | null; pending_arrivals: number; cards_pending: number; direction: string | null } {
  const latest = db.prepare(`
    SELECT created_at, finished_at FROM pw_sieve_runs
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get() as { created_at: string; finished_at: string | null } | undefined;
  const cardsPending = db.prepare(
    "SELECT COUNT(*) AS n FROM pw_sieve_cards WHERE status = 'pending'",
  ).get() as { n: number };
  return {
    last_run_at: latest ? (latest.finished_at ?? latest.created_at) : null,
    pending_arrivals: notifier.pendingCount(),
    cards_pending: Number(cardsPending.n),
    direction: getSieveDirection(db),
  };
}

export type PwSieveDirectionStatsRow = {
  direction: string;
  runs: number;
  cards: number;
  picked: number;
  rejected: number;
  pending: number;
};

/**
 * TASK-PW-51：方向成绩单（只读聚合）——按 direction 聚合 pw_sieve_runs JOIN pw_sieve_cards，
 * 每行 {direction（NULL 归「默认」）、runs、cards、picked、rejected、pending}，按 runs 降序。
 * - runs：该方向的 run 数（含 voice_promotion 哨兵 run、failed/0 卡 run——都算跑过一轮）；
 * - picked：挑中数 = status IN ('picked','edited')（带改挑也是挑中，出活率 挑÷(挑+否) 才完整）；
 * - cards = picked + rejected + pending（卡片状态四值之一 edited 并入 picked，三栏正好分完）。
 */
export function getPwSieveDirectionStats(db: DatabaseSync): PwSieveDirectionStatsRow[] {
  return db.prepare(`
    SELECT
      COALESCE(r.direction, '默认') AS direction,
      COUNT(DISTINCT r.id) AS runs,
      COUNT(c.id) AS cards,
      COUNT(CASE WHEN c.status IN ('picked', 'edited') THEN 1 END) AS picked,
      COUNT(CASE WHEN c.status = 'rejected' THEN 1 END) AS rejected,
      COUNT(CASE WHEN c.status = 'pending' THEN 1 END) AS pending
    FROM pw_sieve_runs r
    LEFT JOIN pw_sieve_cards c ON c.run_id = r.id
    GROUP BY COALESCE(r.direction, '默认')
    ORDER BY runs DESC
  `).all() as PwSieveDirectionStatsRow[];
}

/** 某轮产出的卡片：normal 按 sort_score 倒序，wildcard 另置一区（恒在 normal 之后）。 */
export function listPwSieveCards(db: DatabaseSync, runId: string): PwSieveCardWithRun[] {
  return db.prepare(`
    SELECT c.*, r.direction AS run_direction
    FROM pw_sieve_cards c
    LEFT JOIN pw_sieve_runs r ON r.id = c.run_id
    WHERE c.run_id = ?
    ORDER BY CASE WHEN c.kind = 'wildcard' THEN 1 ELSE 0 END, c.sort_score DESC, c.created_at, c.id
  `).all(runId) as PwSieveCardWithRun[];
}

/**
 * TASK-PW-21：候选卡跨 run 列表，可选 status 过滤。排序语义与 listPwSieveCards 一致：
 * normal 按 sort_score 倒序，wildcard 另置一区（恒在 normal 之后、不参与排序）。只读。
 * TASK-PW-42：行带 run_direction（联 pw_sieve_runs 的方向快照）。
 */
export function listPwSieveCardsByStatus(
  db: DatabaseSync,
  status?: PwSieveCardRow["status"],
): PwSieveCardWithRun[] {
  const order = "CASE WHEN c.kind = 'wildcard' THEN 1 ELSE 0 END, c.sort_score DESC, c.created_at, c.id";
  const rows = status === undefined
    ? db.prepare(`
      SELECT c.*, r.direction AS run_direction
      FROM pw_sieve_cards c
      LEFT JOIN pw_sieve_runs r ON r.id = c.run_id
      ORDER BY ${order}
    `).all()
    : db.prepare(`
      SELECT c.*, r.direction AS run_direction
      FROM pw_sieve_cards c
      LEFT JOIN pw_sieve_runs r ON r.id = c.run_id
      WHERE c.status = ?
      ORDER BY ${order}
    `).all(status);
  return rows as PwSieveCardWithRun[];
}

/**
 * TASK-PW-27：菜号牌——候选卡短标签（对话 ↔ 屏幕同源）。
 * 序号 = 传入列表内按 kind 分区的相对序：normal「证据 N」、wildcard「少数派 N」。
 * 调用方必须传与屏幕同源的列表序（listPwSieveCardsByStatus 的输出序；
 * 前端 Collab.tsx 候选卡区按同一函数输出渲染「证据 N」徽标）。
 */
export function pwSieveCardLabels(cards: readonly PwSieveCardRow[]): Map<string, string> {
  const labels = new Map<string, string>();
  let normal = 0;
  let wildcard = 0;
  for (const card of cards) {
    if (card.kind === "wildcard") labels.set(card.id, `少数派 ${++wildcard}`);
    else labels.set(card.id, `证据 ${++normal}`);
  }
  return labels;
}

/** TASK-PW-21：按 id 取单卡（quote_source_json 原样保留供全量回显）；不存在抛 404。只读。
 *  TASK-PW-42：行带 run_direction（联 pw_sieve_runs 的方向快照）。 */
export function getPwSieveCard(db: DatabaseSync, id: string): PwSieveCardWithRun {
  const row = db.prepare(`
    SELECT c.*, r.direction AS run_direction
    FROM pw_sieve_cards c
    LEFT JOIN pw_sieve_runs r ON r.id = c.run_id
    WHERE c.id = ?
  `).get(id) as
    | PwSieveCardWithRun
    | undefined;
  if (!row) throw httpError(404, "候选卡不存在");
  return row;
}

function getSieveRun(db: DatabaseSync, id: string): PwSieveRunRow {
  const row = db.prepare("SELECT * FROM pw_sieve_runs WHERE id = ?").get(id) as PwSieveRunRow | undefined;
  if (!row) throw httpError(404, "筛子 run 不存在");
  return row;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function dedupeArrivalIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => typeof id === "string" && id.trim()))];
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function toEpochSeconds(iso: string): number | null {
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
