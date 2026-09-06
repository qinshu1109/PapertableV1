/**
 * TASK-PW-14：定向语料通路（pw_corpus_docs 授权队列 + pw_corpus_fts 评论全文索引）。
 *
 * 纪律：
 * - 人工授权制：抓取器只打 status='pending' 的授权队列，无白名单表；
 *   授权动作 = 人在界面/对话里对某个 BV 点一次「获取」。
 * - 公开数据不哈希：UP 主名、评论昵称原样存（不套 pw_voice_items 的哈希纪律）。
 * - 低频：同 bvid 7 天内不重复抓由抓取器执行；撞风控 fail(needs_human) 交人。
 * - 语料正文是本地文件 data/corpus/{bvid}/（meta.json + comments.jsonl），
 *   库内只存相对路径与 sha256 引用。
 * - FTS 用 trigram（同 pt_chunks_fts）：中文评论按字组切词才能命中。
 *   likes 列只存不索引，供检索结果回显点赞数（API 字段名 like）。
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { httpError, nowIso } from "./data.ts";
import { recordPwEvent } from "./pw-runs.ts";
import { snapshotPwBetVideoStats } from "./pw-bet-video-snapshot.ts";

export type PwCorpusStatus =
  | "proposed"
  | "pending"
  | "fetching"
  | "done"
  | "needs_human"
  | "failed";

export type PwCorpusDocRow = {
  id: string;
  bvid: string;
  title: string | null;
  up_name: string | null;
  kinds: string;
  status: PwCorpusStatus;
  path: string | null;
  sha256: string | null;
  video_stat_json: string | null;
  comment_count: number | null;
  authorized_by: string;
  error: string | null;
  fetched_at: string | null;
  created_at: string;
};

export type PwCorpusComment = {
  uname: string | null;
  message: string;
  like: number | null;
};

export type PwCorpusHit = {
  bvid: string;
  uname: string | null;
  /** snippet() 产物，命中词包 <b></b> */
  snippet: string;
  like: number | null;
};

const BVID_PATTERN = /^BV[0-9A-Za-z]{10}$/u;
const FAIL_STATUSES = new Set<PwCorpusStatus>(["needs_human", "failed"]);

export function ensurePwCorpusTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pw_corpus_docs (
      id TEXT PRIMARY KEY,
      bvid TEXT NOT NULL UNIQUE,
      title TEXT,
      up_name TEXT,
      kinds TEXT NOT NULL DEFAULT 'video,comments',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('proposed', 'pending', 'fetching', 'done', 'needs_human', 'failed')),
      -- 语料目录相对路径（corpus/{bvid}），正文在本地文件不落库
      path TEXT,
      sha256 TEXT,
      video_stat_json TEXT,
      comment_count INTEGER,
      authorized_by TEXT NOT NULL DEFAULT 'human',
      error TEXT,
      fetched_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS pw_corpus_fts USING fts5(
      bvid UNINDEXED,
      uname,
      message,
      likes UNINDEXED,
      tokenize='trigram'
    );
  `);
  migratePwCorpusCheck(db);
}

/**
 * TASK-PW-15：既有库的 pw_corpus_docs CHECK 不含 'proposed'，重建表迁移
 * （CREATE TABLE IF NOT EXISTS 不会改动既有约束；本表无外键，可整体重建）。
 */
function migratePwCorpusCheck(db: DatabaseSync): void {
  const definition = (db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pw_corpus_docs'
  `).get() as { sql?: string } | undefined)?.sql ?? "";
  if (definition.includes("'proposed'")) return;
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE pw_corpus_docs_v2 (
        id TEXT PRIMARY KEY,
        bvid TEXT NOT NULL UNIQUE,
        title TEXT,
        up_name TEXT,
        kinds TEXT NOT NULL DEFAULT 'video,comments',
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('proposed', 'pending', 'fetching', 'done', 'needs_human', 'failed')),
        path TEXT,
        sha256 TEXT,
        video_stat_json TEXT,
        comment_count INTEGER,
        authorized_by TEXT NOT NULL DEFAULT 'human',
        error TEXT,
        fetched_at TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO pw_corpus_docs_v2
        SELECT id, bvid, title, up_name, kinds, status, path, sha256,
               video_stat_json, comment_count, authorized_by, error, fetched_at, created_at
        FROM pw_corpus_docs;
      DROP TABLE pw_corpus_docs;
      ALTER TABLE pw_corpus_docs_v2 RENAME TO pw_corpus_docs;
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

/**
 * 登记授权：bvid 非法 400。已存在时 pending/fetching 幂等返回既有；
 * done/needs_human/failed 且 force≠1 返回既有（existed=true，不重复抓）；
 * force=1 重置回 pending、error 清空（重抓 / 已处理 / 重试）。
 * 新建 existed=false（路由据此回 201）。note 仅作授权语义入参，表无此列不落库。
 * TASK-PW-26：audit.actor='ai'（AI 自主直抓）时 authorized_by='ai' 且本函数
 * 不自记账——由调用方（fetch_corpus 工具）在拿到抓取触发结果后合成一条 ai_auto 账（单账原则）。
 */
export function authorizePwCorpus(
  db: DatabaseSync,
  input: { bvid?: unknown; kinds?: unknown; note?: unknown; force?: unknown },
  audit?: { actor?: "ai" },
): { doc: PwCorpusDocRow; existed: boolean } {
  const bvid = typeof input.bvid === "string" ? input.bvid.trim() : "";
  if (!BVID_PATTERN.test(bvid)) throw httpError(400, "非法 BV 号");

  const existing = db.prepare(
    "SELECT * FROM pw_corpus_docs WHERE bvid = ?",
  ).get(bvid) as PwCorpusDocRow | undefined;
  if (existing) {
    const force = input.force === 1 || input.force === "1" || input.force === true;
    if (!force || existing.status === "pending" || existing.status === "fetching") {
      return { doc: existing, existed: true };
    }
    db.prepare(
      "UPDATE pw_corpus_docs SET status = 'pending', error = NULL WHERE id = ?",
    ).run(existing.id);
    // TASK-PW-23：人工授权登记记账（force 重抓分支，actor=human）；TASK-PW-26：AI 自主不记，工具层合成 ai_auto
    if (audit?.actor !== "ai") {
      recordPwEvent(db, {
        eventType: "corpus",
        actor: "human",
        payloadJson: JSON.stringify({
          corpusId: existing.id,
          bvid,
          status: "pending",
          force: true,
        }),
      });
    }
    return { doc: getPwCorpusDocRow(db, existing.id), existed: true };
  }

  const kinds = input.kinds == null ? "video,comments" : requiredText(input.kinds, "kinds");
  const id = randomUUID();
  db.prepare(`
    INSERT INTO pw_corpus_docs(
      id, bvid, title, up_name, kinds, status, path, sha256, video_stat_json,
      comment_count, authorized_by, error, fetched_at, created_at
    ) VALUES(?, ?, NULL, NULL, ?, 'pending', NULL, NULL, NULL, NULL, ?, NULL, NULL, ?)
  `).run(id, bvid, kinds, audit?.actor === "ai" ? "ai" : "human", nowIso());
  // TASK-PW-23：人工授权登记记账（新建分支，actor=human）；TASK-PW-26：AI 自主不记，工具层合成 ai_auto
  if (audit?.actor !== "ai") {
    recordPwEvent(db, {
      eventType: "corpus",
      actor: "human",
      payloadJson: JSON.stringify({
        corpusId: id,
        bvid,
        status: "pending",
        force: false,
      }),
    });
  }
  return { doc: getPwCorpusDocRow(db, id), existed: false };
}

/** 全量授权条目（数据源屏）：created_at 倒序。 */
export function listPwCorpus(db: DatabaseSync): PwCorpusDocRow[] {
  return db.prepare(
    "SELECT * FROM pw_corpus_docs ORDER BY created_at DESC, id DESC",
  ).all() as PwCorpusDocRow[];
}

/** 抓取器取队列：status='pending'，created_at 正序（先登先抓）。 */
export function listPwCorpusPending(db: DatabaseSync): PwCorpusDocRow[] {
  return db.prepare(`
    SELECT * FROM pw_corpus_docs
    WHERE status = 'pending'
    ORDER BY created_at, id
  `).all() as PwCorpusDocRow[];
}

/**
 * TASK-PW-15（AI 提议）：fetch_corpus 工具专用。只创建 status='proposed'、
 * authorized_by='ai' 的行，永远不会被抓取器取走；bvid 已存在时幂等返回既有行。
 * 人工批准后（approvePwCorpusProposal）才转 pending 进入抓取队列。
 */
export function proposePwCorpus(db: DatabaseSync, bvidInput: unknown): PwCorpusDocRow {
  const bvid = typeof bvidInput === "string" ? bvidInput.trim() : "";
  if (!BVID_PATTERN.test(bvid)) throw httpError(400, "非法 BV 号");

  const existing = db.prepare("SELECT id FROM pw_corpus_docs WHERE bvid = ?").get(bvid) as
    | { id: string }
    | undefined;
  if (existing) return getPwCorpusDocRow(db, existing.id);

  const id = randomUUID();
  db.prepare(`
    INSERT INTO pw_corpus_docs(
      id, bvid, title, up_name, kinds, status, path, sha256, video_stat_json,
      comment_count, authorized_by, error, fetched_at, created_at
    ) VALUES(?, ?, NULL, NULL, 'video,comments', 'proposed', NULL, NULL, NULL, NULL, 'ai', NULL, NULL, ?)
  `).run(id, bvid, nowIso());
  return getPwCorpusDocRow(db, id);
}

/** AI 提议队列：status='proposed'，created_at 正序。 */
export function listPwCorpusProposed(db: DatabaseSync): PwCorpusDocRow[] {
  return db.prepare(`
    SELECT * FROM pw_corpus_docs
    WHERE status = 'proposed'
    ORDER BY created_at, id
  `).all() as PwCorpusDocRow[];
}

export type PwCorpusDocDetail = Omit<PwCorpusDocRow, "video_stat_json"> & {
  /** video_stat_json 解析后的对象（B站 view 接口 stat：播放/弹幕/评论/收藏/投币/分享/点赞） */
  video_stat: Record<string, number> | null;
};

/**
 * TASK-PW-17：按 id 或 bvid 读单条语料，video_stat_json 解析为对象返回。
 * 只读；不存在的条目抛 404。
 */
export function getPwCorpusDoc(db: DatabaseSync, idOrBvid: string): PwCorpusDocDetail {
  const row = db.prepare(
    BVID_PATTERN.test(idOrBvid)
      ? "SELECT * FROM pw_corpus_docs WHERE bvid = ?"
      : "SELECT * FROM pw_corpus_docs WHERE id = ?",
  ).get(idOrBvid) as PwCorpusDocRow | undefined;
  if (!row) throw httpError(404, "语料条目不存在");
  return { ...row, video_stat: parseVideoStat(row.video_stat_json) };
}

/** 人工批准 AI 提议：proposed → pending（此后抓取器可见），authorized_by 落 human。 */
export function approvePwCorpusProposal(db: DatabaseSync, id: string): PwCorpusDocRow {
  const doc = getPwCorpusDocRow(db, id);
  if (doc.status !== "proposed") throw httpError(400, "仅 proposed 语料提议可批准");
  db.prepare(`
    UPDATE pw_corpus_docs SET status = 'pending', authorized_by = 'human', error = NULL WHERE id = ?
  `).run(id);
  return getPwCorpusDocRow(db, id);
}

/** 人工驳回 AI 提议：proposed → failed，error='人工驳回'。 */
export function rejectPwCorpusProposal(db: DatabaseSync, id: string): PwCorpusDocRow {
  const doc = getPwCorpusDocRow(db, id);
  if (doc.status !== "proposed") throw httpError(400, "仅 proposed 语料提议可驳回");
  db.prepare(`
    UPDATE pw_corpus_docs
    SET status = 'failed', error = '人工驳回', authorized_by = 'human'
    WHERE id = ?
  `).run(id);
  return getPwCorpusDocRow(db, id);
}

/** 抓取器开工：置 fetching。 */
export function markPwCorpusFetching(db: DatabaseSync, id: string): PwCorpusDocRow {
  const doc = getPwCorpusDocRow(db, id);
  db.prepare("UPDATE pw_corpus_docs SET status = 'fetching' WHERE id = ?").run(id);
  // TASK-PW-23：抓取器开工记账（actor=system）
  recordPwEvent(db, {
    eventType: "corpus",
    actor: "system",
    payloadJson: JSON.stringify({ corpusId: id, bvid: doc.bvid, status: "fetching" }),
  });
  return getPwCorpusDocRow(db, id);
}

/**
 * 抓取器回报成功：同事务更新行 + 按 bvid 重建评论 FTS（删旧插新），
 * error 清空，fetched_at 落当前时间。comments 里缺 message 的脏行跳过。
 */
export function donePwCorpus(
  db: DatabaseSync,
  id: string,
  input: {
    title?: unknown;
    upName?: unknown;
    path?: unknown;
    sha256?: unknown;
    videoStat?: unknown;
    commentCount?: unknown;
    comments?: unknown;
  },
): PwCorpusDocRow {
  const doc = getPwCorpusDocRow(db, id);
  const title = optionalText(input.title);
  const upName = optionalText(input.upName);
  const path = optionalText(input.path);
  const sha256 = optionalText(input.sha256);
  const videoStatJson = videoStatToJson(input.videoStat);
  const comments = normalizeComments(input.comments);
  const commentCount = typeof input.commentCount === "number"
    && Number.isInteger(input.commentCount)
    && input.commentCount >= 0
    ? input.commentCount
    : comments.length;

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      UPDATE pw_corpus_docs
      SET status = 'done', title = ?, up_name = ?, path = ?, sha256 = ?,
        video_stat_json = ?, comment_count = ?, error = NULL, fetched_at = ?
      WHERE id = ?
    `).run(title, upName, path, sha256, videoStatJson, commentCount, nowIso(), id);
    db.prepare("DELETE FROM pw_corpus_fts WHERE bvid = ?").run(doc.bvid);
    const insert = db.prepare(
      "INSERT INTO pw_corpus_fts(bvid, uname, message, likes) VALUES(?, ?, ?, ?)",
    );
    for (const comment of comments) {
      insert.run(doc.bvid, comment.uname, comment.message, comment.like);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  // TASK-PW-23：抓取完成记账（actor=system）
  recordPwEvent(db, {
    eventType: "corpus",
    actor: "system",
    payloadJson: JSON.stringify({
      corpusId: id,
      bvid: doc.bvid,
      status: "done",
      comment_count: commentCount,
    }),
  });
  // TASK-PW-55B：语料 done 触发位——该 bvid 若挂着在途押注的 B站 video 产出物，
  // 顺带自动回流记账。选择依据（a 而非 b）：Node 进程内没有 B站 fetch 客户端
  // （抓取只发生在 ego-browser 脚本里），语料 done 是唯一「既有抓取刚产出 stat、
  // 且写的是语料行而非数据文档」的位置；而 B站同步收工处 syncPwBilibili 自己已落
  // 数据文档，再挂全量 snapshot 会重复记账。这里直接复用本次刚抓到的 videoStat
  // （fetchStat 恒返回它），不新起抓取、不新上依赖；snapshot 内部逐条失败不阻断。
  // TASK-PW-56：快照改 async（b23.tv 短链解析要发网络请求）——done 路由不等快照写完，
  // 回流记账最终一致：fire-and-forget 触发，成功/失败都只 console.warn 留痕，不改变
  // 语料 done 的成功结果。
  try {
    // pw_artifacts 表不存在（如单元测试最小库）时跳过，不靠异常流保底
    const hasArtifacts = Boolean(db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pw_artifacts'",
    ).get());
    const videoStat = hasArtifacts ? normalizeVideoStat(input.videoStat) : null;
    if (videoStat) {
      void snapshotPwBetVideoStats(db, {
        fetchStat: (bvid) => (bvid === doc.bvid ? videoStat : null),
        bvidFilter: doc.bvid,
      }).then((snapshot) => {
        if (snapshot.written > 0 || snapshot.errors.length > 0) {
          console.warn(
            `[PW-55B] 语料 done 触发自动记账：bvid=${doc.bvid} `
            + `written=${snapshot.written} skipped=${snapshot.skipped} `
            + `errors=${JSON.stringify(snapshot.errors)}`,
          );
        }
      }).catch((error) => {
        console.warn(`[PW-55B] 语料 done 触发自动记账失败（不阻断）：${error instanceof Error ? error.message : String(error)}`);
      });
    }
  } catch (error) {
    // 回流记账失败不阻断语料 done（抓取报成功优先）
    console.warn(`[PW-55B] 语料 done 触发自动记账失败（不阻断）：${error instanceof Error ? error.message : String(error)}`);
  }
  return getPwCorpusDocRow(db, id);
}

/**
 * TASK-PW-17：落盘评论全量读取（含 rpid/ctime/replies——DB 层入库时已丢弃，
 * 全量只在磁盘 pw_corpus_docs.path 指向的目录）。只读。
 * 条目非 done / 落盘文件缺失抛明确 httpError，不吞不降级。
 */
export type PwCorpusCommentDetail = {
  rpid: number | null;
  uname: string | null;
  message: string;
  like: number | null;
  ctime: number | null;
  /** 楼中楼回复数（抓取器落的是 rcount，非回复正文） */
  replies: number | null;
};

export function readPwCorpusComments(
  db: DatabaseSync,
  bvid: string,
  options: { offset?: number; limit?: number } = {},
): PwCorpusCommentDetail[] {
  const offset = options.offset ?? 0;
  const limit = options.limit;
  if (!Number.isInteger(offset) || offset < 0) throw httpError(400, "offset 必须是非负整数");
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw httpError(400, "limit 必须是正整数");
  }
  const doc = requireDonePwCorpusDoc(db, bvid);
  let raw: string;
  try {
    raw = readFileSync(join(corpusDir(doc), "comments.jsonl"), "utf8");
  } catch {
    throw httpError(404, "语料评论文件缺失");
  }
  const comments: PwCorpusCommentDetail[] = [];
  for (const [index, line] of raw.split("\n").entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw httpError(500, `语料评论文件损坏：第 ${index + 1} 行不是合法 JSON`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw httpError(500, `语料评论文件损坏：第 ${index + 1} 行不是 JSON 对象`);
    }
    const item = parsed as Record<string, unknown>;
    comments.push({
      rpid: typeof item.rpid === "number" ? item.rpid : null,
      uname: typeof item.uname === "string" && item.uname.trim() ? item.uname.trim() : null,
      message: typeof item.message === "string" ? item.message : "",
      like: typeof item.like === "number" && Number.isFinite(item.like)
        ? Math.trunc(item.like)
        : null,
      ctime: typeof item.ctime === "number" ? item.ctime : null,
      replies: typeof item.replies === "number" ? item.replies : null,
    });
  }
  return comments.slice(offset, limit === undefined ? undefined : offset + limit);
}

/** TASK-PW-17：落盘 meta.json 读取（bvid/aid/title/up_name/pubdate/stat/fetched_at/source）。只读。 */
export type PwCorpusMeta = {
  bvid?: string;
  aid?: number;
  title?: string;
  up_name?: string;
  pubdate?: number;
  stat?: Record<string, number>;
  fetched_at?: string;
  source?: string;
};

export function readPwCorpusMeta(db: DatabaseSync, bvid: string): PwCorpusMeta {
  const doc = requireDonePwCorpusDoc(db, bvid);
  let raw: string;
  try {
    raw = readFileSync(join(corpusDir(doc), "meta.json"), "utf8");
  } catch {
    throw httpError(404, "语料元数据文件缺失");
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("meta.json 不是对象");
    }
    return parsed as PwCorpusMeta;
  } catch {
    throw httpError(500, "语料元数据文件损坏");
  }
}

/** 抓取器回报失败：status 仅允许 needs_human（撞风控交人）/ failed，error 留痕。 */
export function failPwCorpus(
  db: DatabaseSync,
  id: string,
  input: { status?: unknown; error?: unknown },
): PwCorpusDocRow {
  if (typeof input.status !== "string" || !FAIL_STATUSES.has(input.status as PwCorpusStatus)) {
    throw httpError(400, "非法 status：仅允许 needs_human / failed");
  }
  const doc = getPwCorpusDocRow(db, id);
  const error = optionalText(input.error);
  db.prepare("UPDATE pw_corpus_docs SET status = ?, error = ? WHERE id = ?").run(
    input.status,
    error,
    id,
  );
  // TASK-PW-23：抓取失败记账（actor=system）
  recordPwEvent(db, {
    eventType: "corpus",
    actor: "system",
    payloadJson: JSON.stringify({ corpusId: id, bvid: doc.bvid, status: input.status, error }),
  });
  return getPwCorpusDocRow(db, id);
}

/**
 * 评论全文检索：FTS MATCH message，snippet 带 <b> 高亮，上限 20 条。
 * q 为空返回 []；查询整体按短语转义，FTS 语法异常按空结果处理。
 * trigram 分词器不覆盖 <3 字查询，短词（如「分镜」）退化为 LIKE 扫描（个人量级可接受）。
 * 模型常把多组关键词塞进一次调用（「干货/过程/步骤」）：含分隔符时拆成 ≥2 字词组 OR 检索。
 */
export function searchPwCorpus(db: DatabaseSync, q: unknown): PwCorpusHit[] {
  const query = typeof q === "string" ? q.trim() : "";
  if (!query) return [];
  if (query.length < 3) {
    const needle = `%${query.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_")}%`;
    return db.prepare(`
      SELECT bvid, uname, likes AS "like",
        replace(substr(message, max(1, instr(message, ?1) - 16), 40), ?2, '<b>' || ?2 || '</b>') AS snippet
      FROM pw_corpus_fts
      WHERE message LIKE ?3 ESCAPE '!'
      ORDER BY likes DESC
      LIMIT 20
    `).all(query, query, needle) as unknown as PwCorpusHit[];
  }
  const terms = query.split(/[^a-zA-Z0-9一-鿿]+/u).filter((term) => term.length >= 2);
  if (terms.length >= 2) {
    // 多词查询（模型常塞「干货/过程/步骤」）：LIKE OR 命中任一词（trigram 不覆盖两字词，统一走 LIKE）
    const escaped = terms.map(
      (term) => `%${term.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_")}%`,
    );
    const where = escaped.map((_, index) => `message LIKE ?${index + 1} ESCAPE '!'`).join(" OR ");
    const rows = db.prepare(`
      SELECT bvid, uname, likes AS "like", message
      FROM pw_corpus_fts
      WHERE ${where}
      ORDER BY likes DESC
      LIMIT 20
    `).all(...escaped) as Array<{
      bvid: string;
      uname: string | null;
      like: number | null;
      message: string;
    }>;
    return rows.map((row) => ({
      bvid: row.bvid,
      uname: row.uname,
      like: row.like,
      snippet: multiTermSnippet(row.message, terms),
    }));
  }
  try {
    return db.prepare(`
      SELECT bvid, uname, likes AS "like",
        snippet(pw_corpus_fts, 2, '<b>', '</b>', '…', 16) AS snippet
      FROM pw_corpus_fts
      WHERE message MATCH ?
      ORDER BY bm25(pw_corpus_fts)
      LIMIT 20
    `).all(`"${query.replaceAll('"', '""')}"`) as unknown as PwCorpusHit[];
  } catch {
    return [];
  }
}

/** 多词 LIKE 命中的片段：以最先出现的词定位窗口，各词都包 <b> 高亮。 */
function multiTermSnippet(message: string, terms: string[]): string {
  let first = -1;
  for (const term of terms) {
    const idx = message.indexOf(term);
    if (idx >= 0 && (first < 0 || idx < first)) first = idx;
  }
  if (first < 0) return message.slice(0, 40);
  const start = Math.max(0, first - 16);
  let window = message.slice(start, start + 40);
  for (const term of terms) window = window.replaceAll(term, `<b>${term}</b>`);
  return (start > 0 ? "…" : "") + window;
}

/** 按 id 取原始行（写路径与队列内部用；公开读入口见 getPwCorpusDoc）。 */
function getPwCorpusDocRow(db: DatabaseSync, id: string): PwCorpusDocRow {
  const row = db.prepare("SELECT * FROM pw_corpus_docs WHERE id = ?").get(id) as
    | PwCorpusDocRow
    | undefined;
  if (!row) throw httpError(404, "语料条目不存在");
  return row;
}

/** 落盘读取前提：条目必须存在且 status='done'（文件只在抓取完成后才写）。 */
function requireDonePwCorpusDoc(db: DatabaseSync, bvid: string): PwCorpusDocRow {
  const doc = db.prepare("SELECT * FROM pw_corpus_docs WHERE bvid = ?").get(bvid) as
    | PwCorpusDocRow
    | undefined;
  if (!doc) throw httpError(404, "语料条目不存在");
  if (doc.status !== "done") throw httpError(409, `语料尚未抓取完成（status=${doc.status}）`);
  if (!doc.path) throw httpError(404, "语料落盘目录缺失");
  return doc;
}

/** 语料目录解析：绝对路径原样用；相对路径按数据目录（PAPERTABLE_DATA_DIR，缺省同 data.ts）解析。 */
function corpusDir(doc: PwCorpusDocRow): string {
  const base = process.env.PAPERTABLE_DATA_DIR?.trim()
    || join(homedir(), "Library", "Application Support", "Papertable");
  return isAbsolute(doc.path!) ? doc.path! : resolve(base, doc.path!);
}

function parseVideoStat(json: string | null): Record<string, number> | null {
  if (json == null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, number>;
  } catch {
    return null;
  }
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw httpError(400, `${field} 不能为空`);
  return value.trim();
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function videoStatToJson(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, "videoStat 必须是 JSON 对象");
  }
  return JSON.stringify(value);
}

/** TASK-PW-55B：donePwCorpus 触发位复用本次抓到的 stat（videoStatToJson 已先行校验过对象性）。 */
function normalizeVideoStat(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, number>;
}

function normalizeComments(value: unknown): PwCorpusComment[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw httpError(400, "comments 必须是数组");
  const comments: PwCorpusComment[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as { uname?: unknown; message?: unknown; like?: unknown };
    const message = typeof item.message === "string" ? item.message.trim() : "";
    if (!message) continue;
    comments.push({
      uname: typeof item.uname === "string" && item.uname.trim() ? item.uname.trim() : null,
      message,
      like: typeof item.like === "number" && Number.isFinite(item.like)
        ? Math.trunc(item.like)
        : null,
    });
  }
  return comments;
}
