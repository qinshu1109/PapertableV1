/**
 * TASK-PW-65：评论筛子判决结果落库 + 查询。
 * TASK-PW-66：赛道轴（pw_voice_tracks + pw_voice_track_videos）跨视频桶聚合。
 *
 * 背景：skills/voice-comment-sieve 由外部 agent 跑完，产出逐条判决 jsonl
 * （results/{bvid}/batch-*.jsonl，每行 {"rpid":"字符串","verdict":"signal|noise",
 * "bucket":"对比|价格|bug反馈|功能|求助|场景|建议|评价|null","reason":"…"}）。
 * 本模块把判决导入 sqlite（pw_voice_sieve_runs + pw_voice_sieve_items）并供前端查询。
 * 评论原文不落库重复存——真值仍留语料库 comments.jsonl，查询按 rpid join（拉平 replies）。
 *
 * 纪律：
 * - 对账不过不落库：rpid 无重无漏（缺漏/多余/重复都 400 + missing/extra/dup 列表）。
 * - 语料缺失时由本模块从评论源文件补录 pw_corpus_docs（status done，评论文件照抄
 *   data/corpus/{bvid}/comments.jsonl）；既有 done 语料一字不动。
 * - bucket 归一：null / 空串 / 字符串 "null" 一律归一为 NULL（实测数据两者都有）。
 * - 真库只读纪律由运行方保证（导入/测试走 dev 数据目录）。
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { httpError, nowIso } from "./data.ts";
import {
  authorizePwCorpus,
  donePwCorpus,
  readPwCorpusComments,
} from "./pw-corpus.ts";

/** 固定 8 桶，与 skills/voice-comment-sieve/SKILL.md 逐字一致。 */
export const PW_VOICE_SIEVE_BUCKETS = [
  "对比", "价格", "bug反馈", "功能", "求助", "场景", "建议", "评价",
] as const;

const BVID_PATTERN = /^BV[0-9A-Za-z]{10}$/u;

export type PwVoiceSieveVerdict = "signal" | "noise";

export type PwVoiceSieveRunRow = {
  id: string;
  bvid: string;
  provider: string;
  model: string;
  total: number;
  signal: number;
  noise: number;
  reassigned: number;
  report_path: string | null;
  created_at: string;
  status: string;
};

export type PwVoiceSieveItemRow = {
  run_id: string;
  rpid: string;
  verdict: PwVoiceSieveVerdict;
  bucket: string | null;
  reason: string | null;
};

// TASK-PW-66：赛道轴——一个选题赛道盯多个视频，跨视频聚合同一个桶。
export type PwVoiceTrackRow = {
  id: string;
  name: string;
  created_at: string;
};

export type PwVoiceTrackVideoRow = {
  track_id: string;
  bvid: string;
};

export type PwVoiceSieveImportInput = {
  bvid: unknown;
  resultsPath: unknown;
  commentsPath: unknown;
  reportPath?: unknown;
  provider: unknown;
  model: unknown;
  reassigned?: unknown;
};

type VerdictRow = { rpid: string; verdict: PwVoiceSieveVerdict; bucket: string | null; reason: string | null };

/** 语料评论归一后的行（与 PwCorpusCommentDetail 同构，rpid 为 number 便于落盘）。 */
type CommentRow = {
  rpid: number | null;
  uname: string | null;
  message: string;
  like: number | null;
  ctime: number | null;
  replies: number | null;
};

export function ensurePwVoiceSieveTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pw_voice_sieve_runs (
      id TEXT PRIMARY KEY,
      bvid TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      total INTEGER NOT NULL,
      signal INTEGER NOT NULL,
      noise INTEGER NOT NULL,
      reassigned INTEGER NOT NULL DEFAULT 0,
      report_path TEXT,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'done'
    );
    CREATE TABLE IF NOT EXISTS pw_voice_sieve_items (
      run_id TEXT NOT NULL,
      rpid TEXT NOT NULL,
      verdict TEXT NOT NULL CHECK(verdict IN ('signal','noise')),
      bucket TEXT,
      reason TEXT,
      PRIMARY KEY (run_id, rpid)
    );
    CREATE INDEX IF NOT EXISTS pw_voice_sieve_runs_bvid
      ON pw_voice_sieve_runs(bvid, created_at);
  `);
}

/** TASK-PW-66：赛道（跨视频桶聚合轴）。视频挂载幂等（PRIMARY KEY (track_id,bvid)）。 */
export function ensurePwVoiceTrackTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pw_voice_tracks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pw_voice_track_videos (
      track_id TEXT NOT NULL,
      bvid TEXT NOT NULL,
      PRIMARY KEY (track_id, bvid)
    );
  `);
}

/**
 * 导入一次筛子 run。对账不过抛 400（details.reconcile 带 missing/extra/dup），不落库。
 * 对账通过后事务内 insert run + items。dataDir 为语料补录的落盘根目录（服务端传
 * services.store.dataDir；测试传临时目录）。
 */
export function importPwVoiceSieveRun(
  db: DatabaseSync,
  input: PwVoiceSieveImportInput,
  options: { dataDir: string; now?: () => string } = {},
): {
  runId: string;
  total: number;
  signal: number;
  noise: number;
  buckets: Record<string, number>;
  reconcile: { ok: true };
} {
  ensurePwVoiceSieveTables(db);
  const bvid = requiredText(input.bvid, "bvid");
  if (!BVID_PATTERN.test(bvid)) throw httpError(400, "非法 BV 号");
  const resultsPath = requiredText(input.resultsPath, "resultsPath");
  const commentsPath = requiredText(input.commentsPath, "commentsPath");
  const provider = requiredText(input.provider, "provider");
  const model = requiredText(input.model, "model");
  const reportPath = optionalText(input.reportPath);
  const reassigned = optionalInt(input.reassigned, "reassigned");

  const comments = ensureCorpus(db, bvid, commentsPath, options.dataDir);
  const verdicts = readVerdicts(resultsPath);

  // ---- 对账：rpid 无重无漏、signal+noise=total ----
  const corpusRpids = new Set<string>();
  for (const comment of comments) {
    if (comment.rpid !== null) corpusRpids.add(String(comment.rpid));
  }
  const seen = new Map<string, number>();
  let signal = 0;
  let noise = 0;
  for (const verdict of verdicts) {
    seen.set(verdict.rpid, (seen.get(verdict.rpid) ?? 0) + 1);
    if (verdict.verdict === "signal") signal += 1;
    else noise += 1;
  }
  const dup = [...seen].filter(([, count]) => count > 1).map(([rpid]) => rpid).sort();
  const missing = [...corpusRpids].filter((rpid) => !seen.has(rpid)).sort();
  const extra = [...seen.keys()].filter((rpid) => !corpusRpids.has(rpid)).sort();
  const problems: string[] = [];
  if (dup.length) problems.push(`重复 rpid ${dup.length} 条`);
  if (missing.length) problems.push(`缺漏 rpid ${missing.length} 条`);
  if (extra.length) problems.push(`多余 rpid ${extra.length} 条`);
  if (signal + noise !== verdicts.length) problems.push("signal+noise≠total");
  if (problems.length) {
    throw httpError(400, `对账失败：${problems.join("、")}`, {
      reconcile: { ok: false, missing, extra, dup, signal, noise, total: verdicts.length },
    });
  }

  // ---- 对账通过：事务落库 ----
  const runId = randomUUID();
  const at = options.now ? options.now() : nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO pw_voice_sieve_runs(
        id,bvid,provider,model,total,signal,noise,reassigned,report_path,created_at,status
      ) VALUES(?,?,?,?,?,?,?,?,?,?,'done')
    `).run(runId, bvid, provider, model, verdicts.length, signal, noise, reassigned, reportPath, at);
    const insertItem = db.prepare(
      `INSERT INTO pw_voice_sieve_items(run_id,rpid,verdict,bucket,reason) VALUES(?,?,?,?,?)`,
    );
    for (const verdict of verdicts) {
      insertItem.run(runId, verdict.rpid, verdict.verdict, verdict.bucket, verdict.reason);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return {
    runId,
    total: verdicts.length,
    signal,
    noise,
    buckets: bucketCounts(verdicts),
    reconcile: { ok: true },
  };
}

/** 该 bvid 的 run 列表，created_at 新在前。 */
export function listPwVoiceSieveRuns(db: DatabaseSync, bvidRaw: unknown): Array<Record<string, unknown>> {
  ensurePwVoiceSieveTables(db);
  const bvid = requiredText(bvidRaw, "bvid");
  const rows = db.prepare(
    `SELECT * FROM pw_voice_sieve_runs WHERE bvid=? ORDER BY created_at DESC, id DESC`,
  ).all(bvid) as PwVoiceSieveRunRow[];
  return rows.map(runToPublic);
}

/**
 * 单个 run 详情：{run, buckets, signals, noise}。
 * buckets：8 桶全返回（空桶 count:0），按 totalLikes 降序，每桶 top = 赞降序前 3 条；
 * signals：{桶名: 该桶全部信号条目（赞降序）}，桶为 null 的信号归 "null" 键；
 * noise：全部噪音条目（赞降序）。条目字段从语料 comments.jsonl 按 rpid join（拉平 replies）。
 */
export function getPwVoiceSieveRun(
  db: DatabaseSync,
  runIdRaw: string,
): {
  run: Record<string, unknown>;
  buckets: Array<Record<string, unknown>>;
  signals: Record<string, Array<Record<string, unknown>>>;
  noise: Array<Record<string, unknown>>;
} {
  ensurePwVoiceSieveTables(db);
  const runId = requiredText(runIdRaw, "runId");
  const run = db.prepare(`SELECT * FROM pw_voice_sieve_runs WHERE id=?`).get(runId) as PwVoiceSieveRunRow | undefined;
  if (!run) throw httpError(404, "筛子 run 不存在");
  const items = db.prepare(`SELECT * FROM pw_voice_sieve_items WHERE run_id=? ORDER BY rpid`).all(runId) as PwVoiceSieveItemRow[];

  // 语料 join：rpid 字符串化对齐。语料文件被删时条目原文字段留空，不吞其他错误。
  const comments = new Map<string, CommentRow>();
  try {
    for (const comment of readPwCorpusComments(db, run.bvid)) {
      if (comment.rpid !== null) comments.set(String(comment.rpid), comment);
    }
  } catch (error) {
    if (error && typeof error === "object" && "status" in error) {
      console.warn(`[PW-65] 语料不可读，run ${runId} 条目原文留空：${(error as Error).message}`);
    } else {
      throw error;
    }
  }

  const signalsByBucket = new Map<string, Array<Record<string, unknown>>>();
  const noiseItems: Array<Record<string, unknown>> = [];
  for (const item of items) {
    const display = displayItem(item, comments);
    if (item.verdict === "signal") {
      const key = item.bucket ?? "null";
      const list = signalsByBucket.get(key) ?? [];
      list.push(display);
      signalsByBucket.set(key, list);
    } else {
      noiseItems.push(display);
    }
  }
  for (const list of signalsByBucket.values()) list.sort(byLikesDesc);
  noiseItems.sort(byLikesDesc);

  const bucketStats = PW_VOICE_SIEVE_BUCKETS.map((bucket) => {
    const list = signalsByBucket.get(bucket) ?? [];
    return {
      bucket,
      count: list.length,
      totalLikes: list.reduce((sum, item) => sum + (typeof item.like === "number" ? item.like : 0), 0),
      top: list.slice(0, 3),
    };
  }).sort(
    (a, b) => b.totalLikes - a.totalLikes
      || PW_VOICE_SIEVE_BUCKETS.indexOf(a.bucket as (typeof PW_VOICE_SIEVE_BUCKETS)[number])
      - PW_VOICE_SIEVE_BUCKETS.indexOf(b.bucket as (typeof PW_VOICE_SIEVE_BUCKETS)[number]),
  );

  const signals: Record<string, Array<Record<string, unknown>>> = {};
  for (const bucket of PW_VOICE_SIEVE_BUCKETS) signals[bucket] = signalsByBucket.get(bucket) ?? [];
  const nullSignals = signalsByBucket.get("null");
  if (nullSignals) signals["null"] = nullSignals;

  return { run: runToPublic(run), buckets: bucketStats, signals, noise: noiseItems };
}

// ---- TASK-PW-66：赛道轴（跨视频桶聚合）----

/** 建赛道。name 必填；createdAt 由 now 注入（测试固定）。 */
export function createPwVoiceTrack(
  db: DatabaseSync,
  nameRaw: unknown,
  options: { now?: () => string } = {},
): { id: string; name: string; createdAt: string } {
  ensurePwVoiceTrackTables(db);
  const name = requiredText(nameRaw, "name");
  const id = randomUUID();
  const at = options.now ? options.now() : nowIso();
  db.prepare(`INSERT INTO pw_voice_tracks(id,name,created_at) VALUES(?,?,?)`).run(id, name, at);
  return { id, name, createdAt: at };
}

/** 全部赛道 + 各自挂载的视频。列表按建赛道先后。 */
export function listPwVoiceTracks(db: DatabaseSync): Array<{ id: string; name: string; createdAt: string; videos: string[] }> {
  ensurePwVoiceTrackTables(db);
  const tracks = db.prepare(`SELECT * FROM pw_voice_tracks ORDER BY created_at ASC, id ASC`).all() as PwVoiceTrackRow[];
  const videoRows = db.prepare(`SELECT track_id, bvid FROM pw_voice_track_videos ORDER BY rowid`).all() as PwVoiceTrackVideoRow[];
  const byTrack = new Map<string, string[]>();
  for (const row of videoRows) {
    const list = byTrack.get(row.track_id) ?? [];
    list.push(row.bvid);
    byTrack.set(row.track_id, list);
  }
  return tracks.map((track) => ({
    id: track.id,
    name: track.name,
    createdAt: track.created_at,
    videos: byTrack.get(track.id) ?? [],
  }));
}

/** 给赛道挂一个视频（幂等，重复挂不报错）。返回挂载后的赛道。 */
export function addPwVoiceTrackVideo(
  db: DatabaseSync,
  trackIdRaw: unknown,
  bvidRaw: unknown,
): { id: string; name: string; createdAt: string; videos: string[] } {
  ensurePwVoiceTrackTables(db);
  const trackId = requiredText(trackIdRaw, "trackId");
  const bvid = requiredText(bvidRaw, "bvid");
  const track = requireTrack(db, trackId);
  if (!BVID_PATTERN.test(bvid)) throw httpError(400, "非法 BV 号");
  db.prepare(`INSERT OR IGNORE INTO pw_voice_track_videos(track_id,bvid) VALUES(?,?)`).run(trackId, bvid);
  return trackPublic(db, track);
}

/** 从赛道摘下视频（摘不存在的视频幂等）。返回摘下后的赛道。 */
export function removePwVoiceTrackVideo(
  db: DatabaseSync,
  trackIdRaw: unknown,
  bvidRaw: unknown,
): { id: string; name: string; createdAt: string; videos: string[] } {
  ensurePwVoiceTrackTables(db);
  const trackId = requiredText(trackIdRaw, "trackId");
  const bvid = requiredText(bvidRaw, "bvid");
  const track = requireTrack(db, trackId);
  db.prepare(`DELETE FROM pw_voice_track_videos WHERE track_id=? AND bvid=?`).run(trackId, bvid);
  return trackPublic(db, track);
}

/**
 * 赛道聚合：对每个挂载视频取最新一条 done run（无 run 的视频跳过并在 videos 里标
 * hasRun:false），按桶跨视频汇总。buckets 8 桶全返（空桶 count:0）按 totalLikes 降序，
 * 每桶 top = 赞降序前 3 条；signals = {桶名:[该桶全部信号条目（赞降序）]}，桶为 null 的
 * 信号归 "null" 键。聚合条目在原 PwVoiceSieveItem 字段基础上多一个 bvid 标注来源视频。
 */
export function aggregatePwVoiceTrack(
  db: DatabaseSync,
  trackIdRaw: string,
): {
  track: { id: string; name: string };
  videos: Array<{ bvid: string; runId: string | null; signal: number | null; noise: number | null; hasRun: boolean }>;
  buckets: Array<{ bucket: string; count: number; totalLikes: number; top: Array<Record<string, unknown>> }>;
  signals: Record<string, Array<Record<string, unknown>>>;
} {
  ensurePwVoiceTrackTables(db);
  const trackId = requiredText(trackIdRaw, "trackId");
  const track = requireTrack(db, trackId);
  const videoRows = db.prepare(
    `SELECT bvid FROM pw_voice_track_videos WHERE track_id=? ORDER BY rowid`,
  ).all(trackId) as Array<{ bvid: string }>;

  const signalsByBucket = new Map<string, Array<Record<string, unknown>>>();
  const videos: Array<{ bvid: string; runId: string | null; signal: number | null; noise: number | null; hasRun: boolean }> = [];
  for (const { bvid } of videoRows) {
    const run = db.prepare(
      `SELECT * FROM pw_voice_sieve_runs WHERE bvid=? AND status='done' ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(bvid) as PwVoiceSieveRunRow | undefined;
    if (!run) {
      videos.push({ bvid, runId: null, signal: null, noise: null, hasRun: false });
      continue;
    }
    videos.push({ bvid, runId: run.id, signal: run.signal, noise: run.noise, hasRun: true });

    const items = db.prepare(`SELECT * FROM pw_voice_sieve_items WHERE run_id=? ORDER BY rpid`).all(run.id) as PwVoiceSieveItemRow[];
    // 语料 join：rpid 字符串化对齐；语料文件被删时条目原文字段留空，不吞其他错误。
    const comments = new Map<string, CommentRow>();
    try {
      for (const comment of readPwCorpusComments(db, bvid)) {
        if (comment.rpid !== null) comments.set(String(comment.rpid), comment);
      }
    } catch (error) {
      if (error && typeof error === "object" && "status" in error) {
        console.warn(`[PW-66] 语料不可读，赛道 ${trackId} 视频 ${bvid} 条目原文留空：${(error as Error).message}`);
      } else {
        throw error;
      }
    }
    for (const item of items) {
      if (item.verdict !== "signal") continue;
      const key = item.bucket ?? "null";
      const list = signalsByBucket.get(key) ?? [];
      list.push(displayItem(item, comments, bvid));
      signalsByBucket.set(key, list);
    }
  }
  for (const list of signalsByBucket.values()) list.sort(byLikesDesc);

  const buckets = PW_VOICE_SIEVE_BUCKETS.map((bucket) => {
    const list = signalsByBucket.get(bucket) ?? [];
    return {
      bucket,
      count: list.length,
      totalLikes: list.reduce((sum, item) => sum + (typeof item.like === "number" ? item.like : 0), 0),
      top: list.slice(0, 3),
    };
  }).sort(
    (a, b) => b.totalLikes - a.totalLikes
      || PW_VOICE_SIEVE_BUCKETS.indexOf(a.bucket as (typeof PW_VOICE_SIEVE_BUCKETS)[number])
      - PW_VOICE_SIEVE_BUCKETS.indexOf(b.bucket as (typeof PW_VOICE_SIEVE_BUCKETS)[number]),
  );

  const signals: Record<string, Array<Record<string, unknown>>> = {};
  for (const bucket of PW_VOICE_SIEVE_BUCKETS) signals[bucket] = signalsByBucket.get(bucket) ?? [];
  const nullSignals = signalsByBucket.get("null");
  if (nullSignals) signals["null"] = nullSignals;

  return { track: { id: track.id, name: track.name }, videos, buckets, signals };
}

function requireTrack(db: DatabaseSync, trackId: string): PwVoiceTrackRow {
  const track = db.prepare(`SELECT * FROM pw_voice_tracks WHERE id=?`).get(trackId) as PwVoiceTrackRow | undefined;
  if (!track) throw httpError(404, "赛道不存在");
  return track;
}

function trackPublic(
  db: DatabaseSync,
  track: PwVoiceTrackRow,
): { id: string; name: string; createdAt: string; videos: string[] } {
  const videos = (db.prepare(
    `SELECT bvid FROM pw_voice_track_videos WHERE track_id=? ORDER BY rowid`,
  ).all(track.id) as Array<{ bvid: string }>).map((row) => row.bvid);
  return { id: track.id, name: track.name, createdAt: track.created_at, videos };
}

/** 语料补录：缺失时从评论源文件读并注册 pw_corpus_docs；既有 done 语料直接复用。 */
function ensureCorpus(db: DatabaseSync, bvid: string, commentsPath: string, dataDir: string): CommentRow[] {
  const existing = db.prepare("SELECT status FROM pw_corpus_docs WHERE bvid = ?").get(bvid) as
    | { status: string }
    | undefined;
  if (existing) {
    if (existing.status === "done") return readPwCorpusComments(db, bvid);
    if (existing.status === "pending" || existing.status === "fetching") {
      throw httpError(409, `语料抓取中（status=${existing.status}），稍后再试`);
    }
    // failed / needs_human / proposed：force 重置回 pending 后由本导入补录
    authorizePwCorpus(db, { bvid, force: 1 });
  }
  const { comments, title, upName } = readCommentsFile(commentsPath);
  const dir = join(dataDir, "corpus", bvid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "comments.jsonl"), comments.map((comment) => JSON.stringify(comment)).join("\n") + "\n");
  const { doc } = authorizePwCorpus(db, { bvid, force: 1 });
  donePwCorpus(db, doc.id, {
    title,
    upName,
    path: dir, // 绝对路径，语料目录解析不受 PAPERTABLE_DATA_DIR 环境变量影响
    comments,
    commentCount: comments.length,
  });
  return comments;
}

/** 读评论源文件：.jsonl 已是 papertable 格式每行一条；.json 为爬虫原始格式（递归拉平 replies）。 */
function readCommentsFile(path: string): { comments: CommentRow[]; title: string | null; upName: string | null } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw httpError(400, `评论文件不可读：${path}（${error instanceof Error ? error.message : String(error)}）`);
  }
  if (/\.jsonl$/iu.test(path)) {
    const comments: CommentRow[] = [];
    for (const [index, line] of raw.split("\n").entries()) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw httpError(400, `评论文件损坏：${path} 第 ${index + 1} 行不是合法 JSON`);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw httpError(400, `评论文件损坏：${path} 第 ${index + 1} 行不是 JSON 对象`);
      }
      comments.push(normalizeComment(parsed as Record<string, unknown>));
    }
    return { comments, title: null, upName: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw httpError(400, `评论文件不是合法 JSON：${path}`);
  }
  const root = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  // 兼容两种形态：{data:{comments:[…]}}（B站 view 接口）与 {comments:[…]}（实测爬虫产物）
  const data = root.data && typeof root.data === "object" && !Array.isArray(root.data)
    ? root.data as Record<string, unknown>
    : root;
  const rawComments = Array.isArray(data.comments) ? data.comments : [];
  const comments: CommentRow[] = [];
  flattenRawComments(rawComments, comments);
  return {
    comments,
    title: strOrNull(data.title),
    upName: authorName(data.owner) ?? strOrNull(data.up_name),
  };
}

/** 爬虫原始评论递归拉平（每条评论与它的 replies 各成一行，reply 数 = 该条 replies 数组长度）。 */
function flattenRawComments(raws: unknown[], out: CommentRow[]): void {
  for (const value of raws) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const raw = value as Record<string, unknown>;
    out.push(normalizeComment(raw));
    if (Array.isArray(raw.replies)) flattenRawComments(raw.replies, out);
  }
}

function normalizeComment(raw: Record<string, unknown>): CommentRow {
  return {
    rpid: toIntOrNull(raw.rpid),
    uname: strOrNull(raw.uname) ?? authorName(raw.author),
    message: strOrNull(raw.message) ?? strOrNull(raw.text) ?? "",
    like: toIntOrNull(raw.like ?? raw.likes),
    ctime: toIntOrNull(raw.ctime) ?? isoToUnix(raw.created_at),
    replies: typeof raw.replies === "number"
      ? (Number.isInteger(raw.replies) && raw.replies >= 0 ? raw.replies : null)
      : Array.isArray(raw.replies) ? raw.replies.length : null,
  };
}

/** 读 resultsPath 目录下全部 batch-*.jsonl（按文件名排序），逐行校验判决格式。 */
function readVerdicts(resultsPath: string): VerdictRow[] {
  let files: string[];
  try {
    files = readdirSync(resultsPath);
  } catch (error) {
    throw httpError(400, `判决目录不可读：${resultsPath}（${error instanceof Error ? error.message : String(error)}）`);
  }
  const batches = files.filter((name) => /^batch-.+\.jsonl$/iu.test(name)).sort();
  if (!batches.length) throw httpError(400, `判决目录没有 batch-*.jsonl 文件：${resultsPath}`);
  const verdicts: VerdictRow[] = [];
  for (const name of batches) {
    const full = join(resultsPath, name);
    let raw: string;
    try {
      raw = readFileSync(full, "utf8");
    } catch (error) {
      throw httpError(400, `判决文件不可读：${full}（${error instanceof Error ? error.message : String(error)}）`);
    }
    for (const [index, line] of raw.split("\n").entries()) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw httpError(400, `判决文件损坏：${full} 第 ${index + 1} 行不是合法 JSON`);
      }
      verdicts.push(parseVerdict(parsed, full, index + 1));
    }
  }
  return verdicts;
}

function parseVerdict(value: unknown, file: string, line: number): VerdictRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, `判决格式错误：${file} 第 ${line} 行不是 JSON 对象`);
  }
  const raw = value as Record<string, unknown>;
  const rpid = typeof raw.rpid === "string" && raw.rpid.trim() ? raw.rpid.trim() : "";
  if (!rpid) throw httpError(400, `判决缺 rpid：${file} 第 ${line} 行`);
  if (raw.verdict !== "signal" && raw.verdict !== "noise") {
    throw httpError(400, `判决 verdict 非法（${String(raw.verdict)}）：${file} 第 ${line} 行`);
  }
  let bucket: string | null = null;
  if (typeof raw.bucket === "string") {
    const candidate = raw.bucket.trim();
    if (candidate && candidate !== "null" && candidate !== "NULL") {
      if (!(PW_VOICE_SIEVE_BUCKETS as readonly string[]).includes(candidate)) {
        throw httpError(400, `判决 bucket 非法（${candidate}）：${file} 第 ${line} 行`);
      }
      bucket = candidate;
    }
  } else if (raw.bucket != null) {
    throw httpError(400, `判决 bucket 非法：${file} 第 ${line} 行`);
  }
  const reason = strOrNull(raw.reason);
  return { rpid, verdict: raw.verdict as PwVoiceSieveVerdict, bucket, reason };
}

function displayItem(
  item: PwVoiceSieveItemRow,
  comments: Map<string, CommentRow>,
  bvid?: string,
): Record<string, unknown> {
  const comment = comments.get(item.rpid);
  return {
    rpid: item.rpid,
    uname: comment?.uname ?? null,
    message: comment?.message ?? "",
    like: comment?.like ?? null,
    ctime: comment?.ctime ?? null,
    ...(item.bucket ? { bucket: item.bucket } : {}),
    ...(item.reason ? { reason: item.reason } : {}),
    // TASK-PW-66：跨视频聚合条目用 bvid 标注来源视频（单视频查询不出现该字段）
    ...(bvid !== undefined ? { bvid } : {}),
  };
}

function runToPublic(run: PwVoiceSieveRunRow): Record<string, unknown> {
  return {
    id: run.id,
    bvid: run.bvid,
    provider: run.provider,
    model: run.model,
    total: run.total,
    signal: run.signal,
    noise: run.noise,
    reassigned: run.reassigned,
    reportPath: run.report_path,
    createdAt: run.created_at,
    status: run.status,
  };
}

/** 信号条按桶计数：8 桶恒在；桶为 null 的信号归 "null" 键（实测均为噪音，极少出现）。 */
function bucketCounts(verdicts: VerdictRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const bucket of PW_VOICE_SIEVE_BUCKETS) counts[bucket] = 0;
  let nullCount = 0;
  for (const verdict of verdicts) {
    if (verdict.verdict !== "signal") continue;
    if (verdict.bucket) counts[verdict.bucket] = (counts[verdict.bucket] ?? 0) + 1;
    else nullCount += 1;
  }
  if (nullCount) counts["null"] = nullCount;
  return counts;
}

function byLikesDesc(a: Record<string, unknown>, b: Record<string, unknown>): number {
  return (Number(b.like) || -1) - (Number(a.like) || -1) || String(a.rpid).localeCompare(String(b.rpid));
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw httpError(400, `${field} 必填`);
  return value.trim();
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalInt(value: unknown, field: string): number {
  if (value == null || value === "") return 0;
  const number = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(number) || number < 0) throw httpError(400, `${field} 必须是非负整数`);
  return number;
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function authorName(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return strOrNull((value as Record<string, unknown>).name);
}

function toIntOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/u.test(value.trim())) {
    const number = Number(value.trim());
    return Number.isSafeInteger(number) ? number : null;
  }
  return null;
}

function isoToUnix(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1_000) : null;
}

/**
 * TASK-PW-71：筛子多版本交叉检出矩阵（纯只读聚合）。
 * 一个 bvid 的全部 done run 摆在一起对账：每个桶各版本检出几条信号、每条被任一版本
 * 判过信号的评论标注它被哪些版本判信号（含桶名）与哪些版本判噪音。多版都挑的（复现）
 * 排最前，单版独有（异议）整队可见。语料 join 容错照 getPwVoiceSieveRun——语料被删时
 * 条目原文字段留空，不吞其他错误。不建表、不开事务、不写行。
 */
export function getPwVoiceSieveMatrix(
  db: DatabaseSync,
  bvidRaw: unknown,
): {
  bvid: string;
  runs: Array<Record<string, unknown>>;
  summary: {
    runCount: number;
    familyCount: number;
    unionSignals: number;
    consensusSignals: number;
    singletonSignals: number;
  };
  bucketMatrix: Array<{ bucket: string; total: number; perRun: Array<{ runId: string; count: number }> }>;
  items: Array<Record<string, unknown>>;
} {
  ensurePwVoiceSieveTables(db);
  const bvid = requiredText(bvidRaw, "bvid");
  const runs = db.prepare(
    `SELECT * FROM pw_voice_sieve_runs WHERE bvid=? AND status='done' ORDER BY created_at DESC, id DESC`,
  ).all(bvid) as PwVoiceSieveRunRow[];
  const runIds = runs.map((run) => run.id);

  // 语料 join：rpid 字符串化对齐。语料文件被删时条目原文字段留空，不吞其他错误。
  const comments = new Map<string, CommentRow>();
  try {
    for (const comment of readPwCorpusComments(db, bvid)) {
      if (comment.rpid !== null) comments.set(String(comment.rpid), comment);
    }
  } catch (error) {
    if (error && typeof error === "object" && "status" in error) {
      console.warn(`[PW-71] 语料不可读，bvid ${bvid} 矩阵条目原文留空：${(error as Error).message}`);
    } else {
      throw error;
    }
  }

  // 每个 run 的 items 一次查出
  const itemsByRun = new Map<string, PwVoiceSieveItemRow[]>();
  for (const runId of runIds) itemsByRun.set(runId, []);
  if (runIds.length) {
    const placeholders = runIds.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT * FROM pw_voice_sieve_items WHERE run_id IN (${placeholders}) ORDER BY rpid`,
    ).all(...runIds) as PwVoiceSieveItemRow[];
    for (const row of rows) itemsByRun.get(row.run_id)?.push(row);
  }

  // 聚合：rpid → 各版本信号/噪音。family = provider/model；判信号的 run 按家族去重。
  const byRpid = new Map<string, {
    signalRuns: Array<{ runId: string; bucket: string | null; reason: string | null }>;
    noiseRuns: string[];
    families: Set<string>;
  }>();
  const runFamily = new Map<string, string>();
  for (const run of runs) {
    const family = `${run.provider}/${run.model}`;
    runFamily.set(run.id, family);
    for (const item of itemsByRun.get(run.id) ?? []) {
      const entry = byRpid.get(item.rpid) ?? { signalRuns: [], noiseRuns: [], families: new Set<string>() };
      if (item.verdict === "signal") {
        entry.signalRuns.push({ runId: item.run_id, bucket: item.bucket, reason: item.reason });
        entry.families.add(family);
      } else {
        entry.noiseRuns.push(item.run_id);
      }
      byRpid.set(item.rpid, entry);
    }
  }

  // items：任一 run 判过 signal 的 rpid 并集。排序：signalRunCount 降序 → familyCount
  // 降序 → like 降序（like null 垫底）→ rpid 字典序（由 byLikesDesc 兜底）。
  const items: Array<Record<string, unknown>> = [];
  for (const [rpid, entry] of byRpid) {
    if (!entry.signalRuns.length) continue;
    const comment = comments.get(rpid);
    items.push({
      rpid,
      uname: comment?.uname ?? null,
      message: comment?.message ?? "",
      like: comment?.like ?? null,
      ctime: comment?.ctime ?? null,
      signalRuns: entry.signalRuns.map((signal) => ({
        runId: signal.runId,
        ...(signal.bucket ? { bucket: signal.bucket } : {}),
        ...(signal.reason ? { reason: signal.reason } : {}),
      })),
      noiseRuns: entry.noiseRuns,
      signalRunCount: entry.signalRuns.length,
      familyCount: entry.families.size,
    });
  }
  items.sort(
    (a, b) => Number(b.signalRunCount) - Number(a.signalRunCount)
      || Number(b.familyCount) - Number(a.familyCount)
      || byLikesDesc(a, b),
  );

  const familyCount = new Set(runFamily.values()).size;
  const unionSignals = items.length;
  const consensusSignals = runs.length
    ? items.filter((item) => Number(item.signalRunCount) === runs.length).length
    : 0;
  const singletonSignals = items.filter((item) => Number(item.signalRunCount) === 1).length;

  // 桶矩阵：8 桶恒在，按 total 降序，并列按 PW_VOICE_SIEVE_BUCKETS 原序。
  const bucketMatrix = PW_VOICE_SIEVE_BUCKETS.map((bucket) => {
    const perRun = runs.map((run) => ({
      runId: run.id,
      count: (itemsByRun.get(run.id) ?? []).filter(
        (item) => item.verdict === "signal" && item.bucket === bucket,
      ).length,
    }));
    return {
      bucket,
      total: perRun.reduce((sum, entry) => sum + entry.count, 0),
      perRun,
    };
  }).sort(
    (a, b) => b.total - a.total
      || PW_VOICE_SIEVE_BUCKETS.indexOf(a.bucket as (typeof PW_VOICE_SIEVE_BUCKETS)[number])
      - PW_VOICE_SIEVE_BUCKETS.indexOf(b.bucket as (typeof PW_VOICE_SIEVE_BUCKETS)[number]),
  );

  return {
    bvid,
    runs: runs.map((run) => ({ ...runToPublic(run), family: runFamily.get(run.id) })),
    summary: { runCount: runs.length, familyCount, unionSignals, consensusSignals, singletonSignals },
    bucketMatrix,
    items,
  };
}
