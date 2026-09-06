/**
 * TASK-PW-58：笔记自动卷积（日报/周报/月报，后端）。
 *
 * 职责：常驻巡检把已结束且有料的期一层层卷成报告——日报由当天笔记卷、周报由日报卷、
 * 月报由周报卷——落镇纸新正式表 pw_note_rollups（内容生产唯一归属：笔记卷积报告），
 * 供笔记屏「卷积」区只读翻看。AI 只出草稿，不做任何决定；没料的日子不硬凑；生成失败
 * 不落行、下轮巡检自动重试。
 *
 * 纪律：
 * - Memos 库只读：只调 pw-notes.ts 读函数 + 本模块自己的只读日期扫描，零写入；
 *   pw_note_insights / pw_note_recall 等既有模块一个不改。
 * - 模型复用 createPapertableProvider() 全局激活 provider（已拍板，不新接配置），
 *   provider.model.id 记进行。
 * - 一次性模型调用范式照 defaultInsightLlm（completeSimple + maxRetries 0）；
 *   异常或空文本重试 1 次，仍败**跳过该期不落行**，下轮再试（不抛错中断整轮巡检）。
 * - 每轮预算分层：日报 ≤3、周报 ≤1、月报 ≤1（合计 ≤5），层间不挪用——防历史回补期间
 *   日报候选长期占满预算、周报/月报永远轮不到；各层内期按最近优先（先日报 → 再周报 → 再月报）。
 * - INSERT OR IGNORE + UNIQUE(kind, period) 幂等：同一期重复巡检不重复生成。
 * - 模块本体不自带定时器：调度只在 main.ts（setInterval 30 分钟 + 启动 1 分钟首跑）。
 */
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { contentText } from "@earendil-works/pi-ai";
import { nowIso } from "./data.ts";
import { readPwNotesByDay, resolvePwNotesDbPath, type PwNote } from "./pw-notes.ts";
import { createPapertableProvider, type PapertableProvider } from "./provider-settings.ts";

export type PwNoteRollupKind = "day" | "week" | "month";

export type PwNoteRollupRow = {
  id: string;
  kind: PwNoteRollupKind;
  /** day: 2026-08-09 / week: 2026-W32（周一起）/ month: 2026-08 */
  period: string;
  /** 日报: [{uid,url,createdAt}]；周报/月报: [{id,period}] */
  source_refs_json: string;
  source_count: number;
  /** provider.model.id；注入 mock llm 时记 opts.modelLabel 或 null。 */
  model: string | null;
  report: string;
  created_at: string;
};

/** 来源引用（source_refs_json 解析后的元素形状：日报=笔记，周报/月报=下级报告）。 */
export type PwNoteRollupSourceRef =
  | { uid: string; url: string; createdAt: string }
  | { id: string; period: string };

/** 路由输出形状（前端契约）：sourceRefs 解析成数组，camelCase。 */
export type PublicPwNoteRollup = {
  id: string;
  kind: PwNoteRollupKind;
  period: string;
  sourceRefs: PwNoteRollupSourceRef[];
  sourceCount: number;
  model: string | null;
  report: string;
  createdAt: string;
};

/** 行 → 路由输出：JSON 列解析（坏 JSON 兜底空数组，不炸路由）。 */
export function publicPwNoteRollup(row: PwNoteRollupRow): PublicPwNoteRollup {
  return {
    id: row.id,
    kind: row.kind,
    period: row.period,
    sourceRefs: parseJsonArray<PwNoteRollupSourceRef>(row.source_refs_json),
    sourceCount: row.source_count,
    model: row.model,
    report: row.report,
    createdAt: row.created_at,
  };
}

function parseJsonArray<T>(raw: string): T[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** 《卷积纪律》systemPrompt（TASK-PW-58 规格写死，逐字进常量）。 */
export const ROLLUP_SYSTEM_PROMPT = `你是「镇纸 Paperweight」的笔记卷积器。把给出的来源报告逐层卷成一份汇总报告，固定五段、顺序固定：
## 事实
## 模式
## 矛盾
## 假设
## 最小验证
纪律：
1. 事实与推断必须分开：第一段只写来源里能直接看到的；其余各段每条开头标【推断】。
2. 每条事实或线索末尾标注来源，格式 [笔记N]/[日报N]/[周报N]，N 是输入来源的编号；禁止笼统说"某条笔记"或"某份报告"。
3. 不要补全来源里没有的信息；没有证据就写"未知"。
4. 不做人格或动机诊断，不替用户做决策。
5. 某段确实没内容可写时写"（无）"，禁止硬凑。`;

/** 建表（ensure 范式，幂等；TASK-PW-58 规格列）。 */
export function ensurePwNoteRollupTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pw_note_rollups(
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('day','week','month')),
      period TEXT NOT NULL,
      source_refs_json TEXT NOT NULL,
      source_count INTEGER NOT NULL,
      model TEXT,
      report TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(kind, period)
    )
  `);
}

// ---------------------------------------------------------------------------
// 期计算（本地时区；笔记 createdAt 是带偏移的本地 ISO，日期即前 10 位）
// ---------------------------------------------------------------------------

/** ISO 周（周一起）编号：{ year, week }，算法基于 UTC 拷贝避免 DST 干扰。 */
export function isoWeekOf(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7; // 周日=7，周一=1
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // 移到本周四
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

/** 本地日期 YYYY-MM-DD → 周期 YYYY-Www（ISO 周，周一起）。 */
export function weekPeriodOf(day: string): string {
  const week = isoWeekOf(new Date(`${day}T00:00:00`));
  return `${week.year}-W${String(week.week).padStart(2, "0")}`;
}

/** 第 week 周的本地周一 00:00（week 编号按 ISO：含当年 1 月 4 日的第一周为第 1 周）。 */
function mondayOfIsoWeek(year: number, week: number): Date {
  const jan4 = new Date(year, 0, 4);
  const daysSinceMonday = (jan4.getDay() + 6) % 7;
  const monday1 = new Date(year, 0, 4 - daysSinceMonday);
  return new Date(monday1.getFullYear(), monday1.getMonth(), monday1.getDate() + (week - 1) * 7);
}

/** 期的本地午夜边界：start（含）→ end（不含，= 下一起点）。 */
function periodBounds(kind: PwNoteRollupKind, period: string): { start: Date; end: Date } {
  if (kind === "day") {
    const [y, m, d] = period.split("-").map(Number);
    return { start: new Date(y, m - 1, d), end: new Date(y, m - 1, d + 1) };
  }
  if (kind === "month") {
    const [y, m] = period.split("-").map(Number);
    return { start: new Date(y, m - 1, 1), end: new Date(y, m, 1) };
  }
  const match = /^(\d{4})-W(\d{2})$/u.exec(period);
  if (!match) throw new Error(`非法周期格式：${period}`);
  const monday = mondayOfIsoWeek(Number(match[1]), Number(match[2]));
  return {
    start: monday,
    end: new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7),
  };
}

/** 已结束：期结束时刻不晚于当前本地时间（今天/本周/本月一律不算，天然满足）。 */
function isPeriodEnded(kind: PwNoteRollupKind, period: string, now: Date): boolean {
  return periodBounds(kind, period).end.getTime() <= now.getTime();
}

// ---------------------------------------------------------------------------
// 笔记库只读日期扫描（Memos 零写入；与 pw-notes 同口径 row_status='NORMAL'）
// ---------------------------------------------------------------------------

/** 有笔记的本地日期（DESC）；打开失败抛带路径的 Error（同 pw-notes 口径）。 */
function readPwNotesDaysDesc(): string[] {
  const dbPath = resolvePwNotesDbPath();
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`无法只读打开笔记库 ${dbPath}：${detail}`);
  }
  try {
    const rows = db.prepare(`
      SELECT DISTINCT date(created_ts, 'unixepoch', 'localtime') AS day
      FROM memo
      WHERE row_status = 'NORMAL'
      ORDER BY day DESC
    `).all() as Array<{ day: string }>;
    return rows.map((row) => row.day);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// LLM：一次性调用（非工具循环）；测试注入 mock llm
// ---------------------------------------------------------------------------

export type PwNoteRollupLlm = (prompt: string) => Promise<string>;

function defaultRollupLlm(provider: PapertableProvider): PwNoteRollupLlm {
  return async (prompt) => {
    const response = await provider.models.completeSimple(provider.model, {
      systemPrompt: ROLLUP_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    }, {
      maxTokens: 4000,
      timeoutMs: 90_000,
      maxRetries: 0,
      maxRetryDelayMs: 0,
    });
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage || `笔记卷积调用失败：${response.stopReason}`);
    }
    return contentText(response.content, "");
  };
}

export type PwNoteRollupOptions = {
  /** 注入 mock llm（测试）；缺省用 createPapertableProvider 的真实模型。 */
  llm?: PwNoteRollupLlm;
  /** 注入时钟（测试断言 created_at 与已结束判定），缺省 nowIso。 */
  now?: () => string;
  /** 注入 llm 时记录到行 model 的标签；缺省 null。 */
  modelLabel?: string | null;
};

/** 解析 llm 与 model：注入 llm 优先；否则复用全局激活 provider，model id 记进行。 */
function resolveRollupLlm(
  options: PwNoteRollupOptions,
): { runLlm: PwNoteRollupLlm; model: string | null } {
  if (options.llm) return { runLlm: options.llm, model: options.modelLabel ?? null };
  const provider = createPapertableProvider();
  return { runLlm: defaultRollupLlm(provider), model: provider.model.id };
}

// ---------------------------------------------------------------------------
// Prompt 装配（来源逐条编号 [笔记N]/[日报N]/[周报N] + 固定五段标题）
// ---------------------------------------------------------------------------

type RollupSource = { label: string; meta: string; text: string };

const KIND_LABEL: Record<PwNoteRollupKind, string> = { day: "日报", week: "周报", month: "月报" };
const SOURCE_LABEL: Record<PwNoteRollupKind, string> = { day: "笔记", week: "日报", month: "周报" };

function buildRollupPrompt(
  kind: PwNoteRollupKind,
  period: string,
  sources: RollupSource[],
): string {
  return [
    `卷积期：${period}（${KIND_LABEL[kind]}，${sources.length} 条${SOURCE_LABEL[kind]}）`,
    `来源（共 ${sources.length} 条，逐条编号）：`,
    ...sources.map((source) => `${source.label}（${source.meta}）\n${source.text}`),
    `输出固定五段、顺序固定（段内其余规矩按《卷积纪律》执行）：\n## 事实\n## 模式\n## 矛盾\n## 假设\n## 最小验证`,
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// 巡检：runPwNoteRollupTick（先日报 → 再周报 → 再月报；每轮合计最多 5 条，最近优先）
// ---------------------------------------------------------------------------

/** 每轮巡检预算分层（规格写死）：日报 ≤3、周报 ≤1、月报 ≤1，合计 ≤5；层间不挪用。 */
export const ROLLUP_DAY_QUOTA_PER_TICK = 3;
export const ROLLUP_WEEK_QUOTA_PER_TICK = 1;
export const ROLLUP_MONTH_QUOTA_PER_TICK = 1;

/** 合计封顶（= 3+1+1，规格「合计 ≤5」）。 */
export const MAX_ROLLUPS_PER_TICK =
  ROLLUP_DAY_QUOTA_PER_TICK + ROLLUP_WEEK_QUOTA_PER_TICK + ROLLUP_MONTH_QUOTA_PER_TICK;

type RollupRowLike = { id: string; period: string; report: string };

/** 已有报告行（生成周报/月报的来源与完整性判定用）。 */
function listRollupRows(db: DatabaseSync, kind: PwNoteRollupKind): RollupRowLike[] {
  return db.prepare("SELECT id, period, report FROM pw_note_rollups WHERE kind = ?")
    .all(kind) as RollupRowLike[];
}

function hasRollup(db: DatabaseSync, kind: PwNoteRollupKind, period: string): boolean {
  return db.prepare("SELECT 1 FROM pw_note_rollups WHERE kind = ? AND period = ?")
    .get(kind, period) !== undefined;
}

/** 有笔记的日期按周分组（周期 → 该周内有笔记的日期）。 */
function groupDaysByWeek(noteDays: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const day of noteDays) {
    const weekPeriod = weekPeriodOf(day);
    const list = map.get(weekPeriod) ?? [];
    list.push(day);
    map.set(weekPeriod, list);
  }
  return map;
}

/** 已有日报按自然月分组（月 → 该月内有日报的周的周期集合）。 */
function groupWeeksByMonth(dayRows: RollupRowLike[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const row of dayRows) {
    const month = row.period.slice(0, 7);
    const weekPeriod = weekPeriodOf(row.period);
    const set = map.get(month) ?? new Set<string>();
    set.add(weekPeriod);
    map.set(month, set);
  }
  return map;
}

/**
 * 单条报告生成：装配 prompt → 一次性模型调用（异常/空文本重试 1 次，仍败返回 false
 * 不落行，下轮再试）→ INSERT OR IGNORE（UNIQUE(kind,period) 幂等，重复即忽略）。
 */
async function insertRollup(
  db: DatabaseSync,
  kind: PwNoteRollupKind,
  period: string,
  sources: RollupSource[],
  refs: PwNoteRollupSourceRef[],
  now: Date,
  options: PwNoteRollupOptions,
  getBundle: () => { runLlm: PwNoteRollupLlm; model: string | null },
): Promise<boolean> {
  const prompt = buildRollupPrompt(kind, period, sources);
  let bundle: { runLlm: PwNoteRollupLlm; model: string | null };
  try {
    bundle = getBundle();
  } catch {
    return false; // provider 未配置：本 tick 该期跳过，下轮再试
  }
  let report: string | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await bundle.runLlm(prompt);
      if (!raw.trim()) throw new Error("卷积模型产出为空");
      report = raw;
      break;
    } catch {
      // 异常或空文本：第 2 次循环即重试 1 次；仍败走下方 return false
    }
  }
  if (!report) return false;

  const createdAt = options.now ? options.now() : nowIso();
  const result = db.prepare(`
    INSERT OR IGNORE INTO pw_note_rollups(
      id, kind, period, source_refs_json, source_count, model, report, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    kind,
    period,
    JSON.stringify(refs),
    sources.length,
    bundle.model,
    report,
    createdAt,
  );
  return result.changes === 1;
}

async function generateDayRollup(
  db: DatabaseSync,
  day: string,
  now: Date,
  options: PwNoteRollupOptions,
  getBundle: () => { runLlm: PwNoteRollupLlm; model: string | null },
): Promise<boolean> {
  const notes: PwNote[] = readPwNotesByDay(day);
  const sources: RollupSource[] = notes.map((note, index) => ({
    label: `[笔记${index + 1}]`,
    meta: note.createdAt,
    text: note.content,
  }));
  const refs: PwNoteRollupSourceRef[] = notes.map((note) => ({
    uid: note.uid,
    url: note.url,
    createdAt: note.createdAt,
  }));
  return insertRollup(db, "day", day, sources, refs, now, options, getBundle);
}

type WeekCandidate = { period: string; days: string[] };

async function generateWeekRollup(
  db: DatabaseSync,
  week: WeekCandidate,
  dayRows: RollupRowLike[],
  now: Date,
  options: PwNoteRollupOptions,
  getBundle: () => { runLlm: PwNoteRollupLlm; model: string | null },
): Promise<boolean> {
  const rows = dayRows
    .filter((row) => week.days.includes(row.period))
    .sort((a, b) => a.period.localeCompare(b.period)); // 期 ASC = 时间正序，[日报1] 为最早
  const sources: RollupSource[] = rows.map((row, index) => ({
    label: `[日报${index + 1}]`,
    meta: row.period,
    text: row.report,
  }));
  const refs: PwNoteRollupSourceRef[] = rows.map((row) => ({ id: row.id, period: row.period }));
  return insertRollup(db, "week", week.period, sources, refs, now, options, getBundle);
}

type MonthCandidate = { period: string; weeks: string[] };

async function generateMonthRollup(
  db: DatabaseSync,
  month: MonthCandidate,
  weekRows: RollupRowLike[],
  now: Date,
  options: PwNoteRollupOptions,
  getBundle: () => { runLlm: PwNoteRollupLlm; model: string | null },
): Promise<boolean> {
  const rows = weekRows
    .filter((row) => month.weeks.includes(row.period))
    .sort((a, b) => a.period.localeCompare(b.period)); // 期 ASC = 时间正序，[周报1] 为最早
  const sources: RollupSource[] = rows.map((row, index) => ({
    label: `[周报${index + 1}]`,
    meta: row.period,
    text: row.report,
  }));
  const refs: PwNoteRollupSourceRef[] = rows.map((row) => ({ id: row.id, period: row.period }));
  return insertRollup(db, "month", month.period, sources, refs, now, options, getBundle);
}

/**
 * 巡检一轮：先日报 → 再周报 → 再月报；每轮预算分层——日报 ≤3、周报 ≤1、月报 ≤1
 * （合计 ≤5），层间不挪用（防历史回补期间日报候选长期占满预算、周报/月报永远轮不到）；
 * 各层内期按最近优先；只卷已结束且有料的期；生成失败不落行、下轮重试；INSERT OR IGNORE 幂等。
 * 返回本轮实际生成条数（POST /tick 用）。
 */
export async function runPwNoteRollupTick(
  db: DatabaseSync,
  options: PwNoteRollupOptions = {},
): Promise<number> {
  ensurePwNoteRollupTables(db);
  const now = new Date(options.now ? options.now() : nowIso());

  let bundle: { runLlm: PwNoteRollupLlm; model: string | null } | null = null;
  const getBundle = (): { runLlm: PwNoteRollupLlm; model: string | null } => {
    bundle ??= resolveRollupLlm(options);
    return bundle;
  };

  let generated = 0;

  // ① 日报（配额 3）：有笔记的、已结束的、还没有日报的日子（界：最早一条笔记的日期起）
  const noteDays = readPwNotesDaysDesc();
  let dayBudget = ROLLUP_DAY_QUOTA_PER_TICK;
  for (const day of noteDays) {
    if (dayBudget <= 0) break;
    if (!isPeriodEnded("day", day, now)) continue;
    if (hasRollup(db, "day", day)) continue;
    if (await generateDayRollup(db, day, now, options, getBundle)) {
      generated += 1;
      dayBudget -= 1;
    }
  }

  // ② 周报（配额 1）：已结束的周，本周内有笔记的日子全部已有日报且 ≥1 条，周报还没有
  const dayRows = listRollupRows(db, "day");
  const daysByWeek = groupDaysByWeek(noteDays);
  const weekCandidates: WeekCandidate[] = [];
  for (const weekPeriod of [...daysByWeek.keys()].sort().reverse()) {
    const daysInWeek = daysByWeek.get(weekPeriod)!;
    if (!isPeriodEnded("week", weekPeriod, now)) continue;
    if (daysInWeek.some((day) => !dayRows.some((row) => row.period === day))) continue;
    if (hasRollup(db, "week", weekPeriod)) continue;
    weekCandidates.push({ period: weekPeriod, days: daysInWeek });
  }
  let weekBudget = ROLLUP_WEEK_QUOTA_PER_TICK;
  for (const week of weekCandidates) {
    if (weekBudget <= 0) break;
    if (await generateWeekRollup(db, week, dayRows, now, options, getBundle)) {
      generated += 1;
      weekBudget -= 1;
    }
  }

  // ③ 月报（配额 1）：已结束的月，本月内有日报的周全部已有周报且 ≥1 条，月报还没有
  const weekRows = listRollupRows(db, "week");
  const weeksByMonth = groupWeeksByMonth(dayRows);
  const monthCandidates: MonthCandidate[] = [];
  for (const month of [...weeksByMonth.keys()].sort().reverse()) {
    if (!isPeriodEnded("month", month, now)) continue;
    const weeksInMonth = [...weeksByMonth.get(month)!];
    if (weeksInMonth.some((weekPeriod) => !weekRows.some((row) => row.period === weekPeriod))) {
      continue;
    }
    if (hasRollup(db, "month", month)) continue;
    monthCandidates.push({ period: month, weeks: weeksInMonth });
  }
  let monthBudget = ROLLUP_MONTH_QUOTA_PER_TICK;
  for (const month of monthCandidates) {
    if (monthBudget <= 0) break;
    if (await generateMonthRollup(db, month, weekRows, now, options, getBundle)) {
      generated += 1;
      monthBudget -= 1;
    }
  }

  return generated;
}

/** 卷积报告列表：kind 可选过滤，period DESC 封顶 200（route 层做 camelCase 输出）。 */
export function listPwNoteRollups(
  db: DatabaseSync,
  opts: { kind?: PwNoteRollupKind } = {},
): PwNoteRollupRow[] {
  const rows = opts.kind
    ? db.prepare(`
        SELECT * FROM pw_note_rollups
        WHERE kind = ?
        ORDER BY period DESC, created_at DESC, id DESC
        LIMIT 200
      `).all(opts.kind)
    : db.prepare(`
        SELECT * FROM pw_note_rollups
        ORDER BY period DESC, created_at DESC, id DESC
        LIMIT 200
      `).all();
  return rows as PwNoteRollupRow[];
}
