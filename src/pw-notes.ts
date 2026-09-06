/**
 * TASK-PW-39：笔记只读连接与读取函数（Memos SQLite 库只读消费，供 PW-40 回顾 / PW-41 第七屏）。
 *
 * 纪律：
 * - 零写入：只读打开（node:sqlite DatabaseSync 第二参 { readOnly: true }，本机 node v24.18.0
 *   实测可用；等价备用方案 file:...?mode=ro URI 同样实测可行）。只读连接上任何写操作都会抛
 *   "attempt to write a readonly database"。禁止 immutable=1（规格已核验：WAL 模式下 immutable
 *   打开看不见 WAL 里的新数据，连表都查不到；只读打开则能读到 WAL 未 checkpoint 的数据）。
 * - 每次调用即开即关，不做进程级单例：Memos 重启/重建库文件后长连接会指向旧 inode、读到
 *   陈旧数据；只读连接不持写锁，个人量级开/关开销可忽略；零写入审计的文件影响边界也更清晰。
 * - 只读连接会改写瞬时 wal-index 文件（-shm，写入读标记；SQLite WAL 读协议固有行为），
 *   但主库文件与 -wal 字节不变——零写入对账以 db + -wal 为准（规格如此）。
 * - 归档（row_status='ARCHIVED'）一律不返回；本模块不接 HTTP 路由、不碰 main.ts/frontend，
 *   留给 PW-40/41 挂载（沿 PW-19 先例）。
 * - 调用方错误处理：库文件不存在/打开失败 → 抛带路径的 Error；getPwNotesStatus 兜底
 *   ok:false，其余函数不吞错。
 * - search / queryPwNotesByKeywords 的 limit 沿用 list 的默认 50、上限 200。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type PwNote = {
  uid: string;
  content: string;
  /** ISO 本地时间（含时区偏移，如 2026-08-08T17:30:00+08:00） */
  createdAt: string;
  updatedAt: string;
  visibility: "PUBLIC" | "PROTECTED" | "PRIVATE";
  pinned: boolean;
  /** json_extract(payload,'$.tags') 解析结果；payload 为空/非法 JSON/非数组一律 [] */
  tags: string[];
  /** {MEMOS_BASE_URL 默认 http://127.0.0.1:5230}/memos/{uid}（v0.30 web 路由 memos/:uid） */
  url: string;
};

/** date=YYYY-MM-DD（本地时区），缺日 count:0，热力图直接可画 */
export type PwNoteDayStat = { date: string; count: number };

/** TASK-PW-41：标签聚合计数（标签树原料）。嵌套标签（镇纸/协作台）原样返回，树由前端按 / 拼。 */
export type PwNoteTagCount = { tag: string; count: number };

export type PwNoteHit = PwNote & { matchedKeywords: string[] };

const DEFAULT_MEMOS_DB_PATH = join(
  homedir(),
  "Library",
  "Application Support",
  "memos",
  "memos_prod.db",
);
const DEFAULT_MEMOS_BASE_URL = "http://127.0.0.1:5230";

/** 各读函数共用的列投影：tags 经 json_valid 兜底，payload 非法 JSON 时按 NULL（→ []）处理 */
const SELECT_NOTE_SQL = `
  SELECT uid, content, created_ts, updated_ts, visibility, pinned,
    CASE WHEN json_valid(payload) THEN json_extract(payload, '$.tags') ELSE NULL END AS tags_json
  FROM memo
  WHERE row_status = 'NORMAL'`;

type MemoRow = {
  uid: string;
  content: string;
  created_ts: number;
  updated_ts: number;
  visibility: PwNote["visibility"];
  pinned: number;
  tags_json: string | null;
};

/** 环境变量 MEMOS_DB_PATH 优先（trim），缺省 ~/Library/Application Support/memos/memos_prod.db。 */
export function resolvePwNotesDbPath(): string {
  const env = process.env.MEMOS_DB_PATH?.trim();
  return env || DEFAULT_MEMOS_DB_PATH;
}

/** 打开失败统一抛带路径的 Error（getPwNotesStatus 会捕获转 ok:false）。 */
function openPwNotesReadOnly(dbPath: string): DatabaseSync {
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`无法只读打开笔记库 ${dbPath}：${detail}`);
  }
}

/** 最近笔记：row_status='NORMAL'，created_ts 倒序；limit 默认 50 上限 200。 */
export function readPwNotesList(opts: { limit?: number; offset?: number } = {}): PwNote[] {
  const limit = clampPositiveInt(opts.limit, 50, 200, "limit");
  const offset = opts.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) throw new Error("offset 必须是 ≥0 的整数");
  const db = openPwNotesReadOnly(resolvePwNotesDbPath());
  try {
    const rows = db.prepare(`
      ${SELECT_NOTE_SQL}
      ORDER BY created_ts DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as MemoRow[];
    return rows.map((row) => rowToPwNote(row, resolvePwNotesBaseUrl()));
  } finally {
    db.close();
  }
}

/** 全文 LIKE 搜索：参数化绑定，用户输入的 %/_ 经 ESCAPE 转义按字面匹配；空串返回 []。 */
export function searchPwNotes(query: string, opts: { limit?: number } = {}): PwNote[] {
  const trimmed = typeof query === "string" ? query.trim() : "";
  if (!trimmed) return [];
  const limit = clampPositiveInt(opts.limit, 50, 200, "limit");
  const db = openPwNotesReadOnly(resolvePwNotesDbPath());
  try {
    const rows = db.prepare(`
      ${SELECT_NOTE_SQL}
      AND content LIKE ? ESCAPE '!'
      ORDER BY created_ts DESC, id DESC
      LIMIT ?
    `).all(escapeLike(trimmed), limit) as MemoRow[];
    return rows.map((row) => rowToPwNote(row, resolvePwNotesBaseUrl()));
  } finally {
    db.close();
  }
}

/**
 * TASK-PW-58：按日读笔记——date=YYYY-MM-DD（本地时区），等价 createdAt 前 10 位 = date
 * （createdAt 由 created_ts 本地化派生，与 SQL date(created_ts,'unixepoch','localtime')
 * 同口径），createdAt ASC（created_ts ASC 同序，供笔记自动卷积逐日卷日报）。
 */
export function readPwNotesByDay(date: string): PwNote[] {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    throw new Error("date 必须是 YYYY-MM-DD");
  }
  const db = openPwNotesReadOnly(resolvePwNotesDbPath());
  try {
    const rows = db.prepare(`
      ${SELECT_NOTE_SQL}
      AND date(created_ts, 'unixepoch', 'localtime') = ?
      ORDER BY created_ts ASC, id ASC
    `).all(date) as MemoRow[];
    return rows.map((row) => rowToPwNote(row, resolvePwNotesBaseUrl()));
  } finally {
    db.close();
  }
}

/**
 * 按日统计：date(created_ts,'unixepoch','localtime') 按本地时区聚合，返回最近 days 天
 * 的连续日期段（缺日补 count:0）；days 默认 365 上限 370。
 */
export function getPwNotesDailyStats(opts: { days?: number } = {}): PwNoteDayStat[] {
  const days = clampPositiveInt(opts.days, 365, 370, "days");
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const since = Math.floor(start.getTime() / 1000);
  const db = openPwNotesReadOnly(resolvePwNotesDbPath());
  try {
    const rows = db.prepare(`
      SELECT date(created_ts, 'unixepoch', 'localtime') AS day, count(*) AS cnt
      FROM memo
      WHERE row_status = 'NORMAL' AND created_ts >= ?
      GROUP BY day
    `).all(since) as Array<{ day: string; cnt: number }>;
    const counts = new Map(rows.map((row) => [row.day, row.cnt]));
    const result: PwNoteDayStat[] = [];
    const cursor = new Date(start);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    while (cursor.getTime() <= today.getTime()) {
      const key = formatLocalDate(cursor);
      result.push({ date: key, count: counts.get(key) ?? 0 });
      cursor.setDate(cursor.getDate() + 1);
    }
    return result;
  } finally {
    db.close();
  }
}

/** 总条数（row_status='NORMAL'；归档不计）。供多源可视化笔记行等聚合场景。 */
export function countPwNotes(): number {
  const db = openPwNotesReadOnly(resolvePwNotesDbPath());
  try {
    const row = db.prepare(`
      SELECT count(*) AS cnt FROM memo WHERE row_status = 'NORMAL'
    `).get() as { cnt: number };
    return row.cnt;
  } finally {
    db.close();
  }
}

/**
 * 多关键词检索（供 PW-40 回顾捞取）：关键词 LIKE OR，按命中关键词数降序、同数按
 * created_ts 倒序；matchedKeywords 与 SQL LIKE 语义对齐（ASCII 大小写不敏感）。
 * 空关键词数组返回 []。
 */
export function queryPwNotesByKeywords(keywords: string[], opts: { limit?: number } = {}): PwNoteHit[] {
  const limit = clampPositiveInt(opts.limit, 50, 200, "limit");
  const terms = (Array.isArray(keywords) ? keywords : [])
    .map((keyword) => (typeof keyword === "string" ? keyword.trim() : ""))
    .filter((keyword) => keyword.length > 0);
  if (terms.length === 0) return [];
  const needles = terms.map(escapeLike);
  const match = needles.map((_, index) => `content LIKE ?${index + 1} ESCAPE '!'`).join(" OR ");
  const hitCount = needles.map((_, index) => `(content LIKE ?${index + 1} ESCAPE '!')`).join(" + ");
  const db = openPwNotesReadOnly(resolvePwNotesDbPath());
  try {
    const rows = db.prepare(`
      ${SELECT_NOTE_SQL}
      AND (${match})
      ORDER BY (${hitCount}) DESC, created_ts DESC, id DESC
      LIMIT ?
    `).all(...needles, limit) as MemoRow[];
    const baseUrl = resolvePwNotesBaseUrl();
    return rows.map((row) => {
      const note = rowToPwNote(row, baseUrl);
      const content = note.content.toLowerCase();
      return {
        ...note,
        matchedKeywords: terms.filter((term) => content.includes(term.toLowerCase())),
      };
    });
  } finally {
    db.close();
  }
}

/** 状态探测（供 PW-41 空态与排障）：库文件是否存在、只读打开是否成功；失败兜底 ok:false。 */
export function getPwNotesStatus(): { ok: boolean; path: string; error?: string } {
  const path = resolvePwNotesDbPath();
  if (!existsSync(path)) {
    return { ok: false, path, error: `笔记库文件不存在：${path}` };
  }
  try {
    const db = openPwNotesReadOnly(path);
    db.close();
    return { ok: true, path };
  } catch (error) {
    return {
      ok: false,
      path,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * TASK-PW-41：全量标签聚合计数（第七屏标签树原料）。
 * payload $.tags 经 json_each 展开；坏 JSON payload 按 NULL（零行）处理、归档行不进统计；
 * 嵌套标签（镇纸/协作台）原样返回——树由前端按 / 拼，后端保持扁平事实。
 * 按 count 降序、同数按 tag 升序（确定性）。
 */
export function getPwNotesTagCounts(): PwNoteTagCount[] {
  const db = openPwNotesReadOnly(resolvePwNotesDbPath());
  try {
    const rows = db.prepare(`
      SELECT tag.value AS tag, count(*) AS cnt
      FROM memo,
        json_each(
          CASE WHEN json_valid(payload)
            THEN CASE WHEN json_type(payload, '$.tags') = 'array'
              THEN json_extract(payload, '$.tags')
              ELSE NULL END
            ELSE NULL END
        ) AS tag
      WHERE row_status = 'NORMAL'
      GROUP BY tag.value
      ORDER BY cnt DESC, tag.value ASC
    `).all() as Array<{ tag: unknown; cnt: number }>;
    return rows
      .filter((row): row is { tag: string; cnt: number } => typeof row.tag === "string")
      .map((row) => ({ tag: row.tag, count: row.cnt }));
  } finally {
    db.close();
  }
}

function resolvePwNotesBaseUrl(): string {
  const env = process.env.MEMOS_BASE_URL?.trim();
  return env ? env.replace(/\/+$/, "") : DEFAULT_MEMOS_BASE_URL;
}

function rowToPwNote(row: MemoRow, baseUrl: string): PwNote {
  return {
    uid: row.uid,
    content: row.content,
    createdAt: toLocalIso(row.created_ts),
    updatedAt: toLocalIso(row.updated_ts),
    visibility: row.visibility,
    pinned: row.pinned === 1,
    tags: parseTags(row.tags_json),
    url: `${baseUrl}/memos/${row.uid}`,
  };
}

function escapeLike(text: string): string {
  return `%${text.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_")}%`;
}

function parseTags(json: string | null): string[] {
  if (json == null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === "string")
      : [];
  } catch {
    return [];
  }
}

function clampPositiveInt(
  value: number | undefined,
  fallback: number,
  cap: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) throw new Error(`${label} 必须是正整数`);
  return Math.min(resolved, cap);
}

/** Unix 秒 → ISO 本地时间（含时区偏移，如 2026-08-08T17:30:00+08:00） */
function toLocalIso(unixSeconds: number): string {
  const d = new Date(Math.trunc(unixSeconds) * 1000);
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function formatLocalDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
