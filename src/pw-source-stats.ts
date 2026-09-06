/**
 * TASK-PW-34：多源可视化数据（来源对比 + 产出榜，只读统计）。
 *
 * 数据真值源（无新表、无写操作）：
 *   pw_corpus_docs / pw_sieve_cards / pw_bets / pw_verdicts /
 *   pw_verdict_refs / pw_content_drafts / pw_collab_messages / pw_runs。
 *
 * 口径（规格 §2）：
 * - 来源行 = pw_corpus_docs 全部行，不因时间窗隐藏；另固定返回
 *   pendingLanes（无抓取通路的来源占位灰显）。
 * - 笔记通路（PW-39/40/41 接通 Memos 后）：notesLane 实行为
 *   { total 总条数, addedInRange 窗口内新增 }——按本地自然日聚合（同第七屏热力图
 *   口径），与 cutoff 滚动窗略有口径差，仅作活跃度指示；笔记不进归因链。
 *   Memos 库不可达时 notesLane=null 且「笔记」回退 pendingLanes 灰行。
 * - 时间窗：rangeDays 仅 7/30（非法回退 7），now 可注入；窗口下界 cutoff 为
 *   ISO 串（字典序可比）。评论数 comment_count 是存量不随窗，其余计数窗口内发生。
 * - 归因链：卡片 bvid 一律 json_extract(quote_source_json, '$.bvid')；
 *   verdict/draft/collab_message 经 pw_bets.source_card_id 回指卡片取 bvid；
 *   collab_message 的 bet_id='global' 不归因任何来源。
 * - 挑卡：pw_runs event_type='confirm' 且 payload 能解出 cardId 的行
 *   （manual_event 与 ai_exec 都算）；payload 非法 JSON 不炸不计数。
 */
import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "./data.ts";
import {
  countPwNotes,
  getPwNotesDailyStats,
  getPwNotesStatus,
} from "./pw-notes.ts";

export type PwSourceStatsOptions = {
  /** 窗口天数：仅 7 / 30（缺省 7）；非法值回退 7。 */
  rangeDays?: unknown;
  /** 基准时刻（测试注入）：ISO 串原样使用；缺省当前时刻。 */
  now?: string | Date;
};

export type PwSourceComparisonRow = {
  bvid: string;
  title: string | null;
  upName: string | null;
  comments: number;
  candidates: number;
  wildcards: number;
  golds: number;
  picked: number;
  refs: number;
  finalized: number;
  intoChain: number;
};

export type PwSourceComparison = {
  rangeDays: number;
  generatedAt: string;
  pendingLanes: string[];
  sources: PwSourceComparisonRow[];
  /** 笔记通路实行计数；Memos 不可达为 null（屏层回退灰行）。 */
  notesLane: PwNotesLane | null;
};

/** 笔记行：总条数 + 窗口内新增（本地自然日口径）；笔记不进归因链。 */
export type PwNotesLane = { total: number; addedInRange: number };

export type PwOutputRankingRow = {
  bvid: string;
  title: string | null;
  upName: string | null;
  produced: number;
  picked: number;
  refCount: number;
};

export type PwOutputRanking = {
  rangeDays: number;
  generatedAt: string;
  ranking: PwOutputRankingRow[];
};

type Window = { rangeDays: number; generatedAt: string; cutoff: string };

type CardBvidCountRow = { bvid: string | null; n: number; wc: number };
type CardBvidRow = { id: string; bvid: string | null };
type BetSourceRow = { id: string; source_card_id: string | null };
type BetIdRow = { bet_id: string };
type BetIdSourceRow = { id: string; bet_id: string };
type PayloadRow = { payload_json: string };
type RefRow = { source_kind: string; source_id: string };
type CorpusDocRow = {
  bvid: string;
  title: string | null;
  up_name: string | null;
  comment_count: number | null;
};

type ZeroCounts = {
  candidates: number;
  wildcards: number;
  golds: number;
  picked: number;
  refs: number;
  finalized: number;
};

const ZERO_COUNTS: ZeroCounts = {
  candidates: 0,
  wildcards: 0,
  golds: 0,
  picked: 0,
  refs: 0,
  finalized: 0,
};

/** 窗口参数解析：rangeDays 仅 7/30 合法（非法回退 7）；cutoff = now - rangeDays 天。 */
function resolveWindow(options: PwSourceStatsOptions): Window {
  const rangeDays = options.rangeDays === 30 ? 30 : 7;
  const generatedAt = options.now === undefined
    ? nowIso()
    : typeof options.now === "string"
      ? options.now
      : options.now.toISOString();
  const cutoff = new Date(Date.parse(generatedAt) - rangeDays * 86_400_000).toISOString();
  return { rangeDays, generatedAt, cutoff };
}

/** 来源行底表：pw_corpus_docs 全部行（不因时间窗隐藏），按 bvid 稳定排序。 */
function listSourceDocs(db: DatabaseSync): CorpusDocRow[] {
  return db.prepare(`
    SELECT bvid, title, up_name, comment_count
    FROM pw_corpus_docs
    ORDER BY bvid
  `).all() as CorpusDocRow[];
}

/**
 * 窗口内各来源计数（按 bvid 归属）。只读；JSON 提取缺失/非法一律按
 * "不归因"处理：不炸、不计入任何来源。
 */
function collectSourceCounts(db: DatabaseSync, cutoff: string): Map<string, ZeroCounts> {
  const counts = new Map<string, ZeroCounts>();
  const add = (bvid: string | null, key: keyof ZeroCounts, n: number): void => {
    if (bvid == null) return;
    const entry = counts.get(bvid) ?? { ...ZERO_COUNTS };
    entry[key] += n;
    counts.set(bvid, entry);
  };

  // candidates / wildcards：窗口内创建的卡片，bvid 取自 quote_source_json
  const cardRows = db.prepare(`
    SELECT json_extract(quote_source_json, '$.bvid') AS bvid,
           COUNT(*) AS n,
           SUM(CASE WHEN kind = 'wildcard' THEN 1 ELSE 0 END) AS wc
    FROM pw_sieve_cards
    WHERE created_at >= ?
    GROUP BY bvid
  `).all(cutoff) as CardBvidCountRow[];
  for (const row of cardRows) {
    if (typeof row.bvid !== "string") continue;
    add(row.bvid, "candidates", Number(row.n));
    add(row.bvid, "wildcards", Number(row.wc));
  }

  // 卡片 id → bvid 索引（挑卡与押注链归因共用）
  const cardBvid = new Map<string, string>();
  const allCards = db.prepare(`
    SELECT id, json_extract(quote_source_json, '$.bvid') AS bvid
    FROM pw_sieve_cards
  `).all() as CardBvidRow[];
  for (const row of allCards) {
    if (typeof row.bvid === "string") cardBvid.set(row.id, row.bvid);
  }

  // 押注 id → bvid（经 source_card_id 回指卡片）
  const betBvid = new Map<string, string>();
  const betRows = db.prepare("SELECT id, source_card_id FROM pw_bets").all() as BetSourceRow[];
  for (const row of betRows) {
    const bvid = row.source_card_id == null ? null : cardBvid.get(row.source_card_id);
    if (bvid != null) betBvid.set(row.id, bvid);
  }

  // golds：窗口内 decided_at 的 gold 判决（verdict → bet → 卡 → bvid）
  const goldRows = db.prepare(`
    SELECT bet_id FROM pw_verdicts WHERE outcome = 'gold' AND decided_at >= ?
  `).all(cutoff) as BetIdRow[];
  for (const row of goldRows) {
    add(betBvid.get(row.bet_id) ?? null, "golds", 1);
  }

  // picked：窗口内 confirm 事件，payload 能解出 cardId 且该卡归属本 bvid
  const confirmRows = db.prepare(`
    SELECT payload_json FROM pw_runs
    WHERE event_type = 'confirm' AND created_at >= ?
  `).all(cutoff) as PayloadRow[];
  for (const row of confirmRows) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      continue; // 非法 JSON 不炸不计数
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    const cardId = (payload as Record<string, unknown>).cardId;
    if (typeof cardId !== "string") continue;
    add(cardBvid.get(cardId) ?? null, "picked", 1);
  }

  // 引用源行索引：content_draft / collab_message → bet_id
  const draftBet = new Map<string, string>();
  const draftRows = db.prepare("SELECT id, bet_id FROM pw_content_drafts").all() as BetIdSourceRow[];
  for (const row of draftRows) draftBet.set(row.id, row.bet_id);
  const messageBet = new Map<string, string>();
  const messageRows = db.prepare("SELECT id, bet_id FROM pw_collab_messages").all() as BetIdSourceRow[];
  for (const row of messageRows) messageBet.set(row.id, row.bet_id);

  // refs：窗口内引用笔数；collab_message 的 bet_id='global' 不归因任何来源
  const refRows = db.prepare(`
    SELECT source_kind, source_id FROM pw_verdict_refs
    WHERE created_at >= ?
  `).all(cutoff) as RefRow[];
  for (const row of refRows) {
    let bvid: string | null = null;
    if (row.source_kind === "content_draft") {
      const betId = draftBet.get(row.source_id);
      if (betId != null) bvid = betBvid.get(betId) ?? null;
    } else if (row.source_kind === "collab_message") {
      const betId = messageBet.get(row.source_id);
      if (betId != null && betId !== "global") bvid = betBvid.get(betId) ?? null;
    }
    add(bvid, "refs", 1);
  }

  // finalized：窗口内定稿（updated_at 在窗内），经 bet 链归因
  const finalRows = db.prepare(`
    SELECT bet_id FROM pw_content_drafts
    WHERE status = 'finalized' AND updated_at >= ?
  `).all(cutoff) as BetIdRow[];
  for (const row of finalRows) {
    add(betBvid.get(row.bet_id) ?? null, "finalized", 1);
  }

  return counts;
}

/**
 * 来源对比：每来源一行全口径。评论数存量不随窗；其余计数窗口内发生。
 * 书/文章无抓取通路 → pendingLanes 固定占位（屏层灰显"待来源通路"）；
 * 笔记通路接通 → notesLane 实行，不可达回退灰行。
 */
export function getPwSourceComparison(
  db: DatabaseSync,
  options: PwSourceStatsOptions = {},
): PwSourceComparison {
  const { rangeDays, generatedAt, cutoff } = resolveWindow(options);
  const counts = collectSourceCounts(db, cutoff);
  const sources = listSourceDocs(db).map((doc) => {
    const c = counts.get(doc.bvid) ?? { ...ZERO_COUNTS };
    return {
      bvid: doc.bvid,
      title: doc.title,
      upName: doc.up_name,
      comments: doc.comment_count ?? 0,
      candidates: c.candidates,
      wildcards: c.wildcards,
      golds: c.golds,
      picked: c.picked,
      refs: c.refs,
      finalized: c.finalized,
      intoChain: c.picked + c.refs + c.finalized,
    };
  });
  const notesLane = collectNotesLane(rangeDays);
  const pendingLanes = notesLane ? ["书/文章"] : ["书/文章", "笔记"];
  return { rangeDays, generatedAt, pendingLanes, sources, notesLane };
}

/** 笔记行计数：Memos 只读；任何不可达/异常一律回退 null（灰行），不炸统计。 */
function collectNotesLane(rangeDays: number): PwNotesLane | null {
  try {
    if (!getPwNotesStatus().ok) return null;
    const total = countPwNotes();
    const addedInRange = getPwNotesDailyStats({ days: rangeDays })
      .reduce((sum, row) => sum + row.count, 0);
    return { total, addedInRange };
  } catch {
    return null;
  }
}

/**
 * 产出榜：每来源 produced/picked/refCount，排序 produced desc → picked desc →
 * bvid asc；零产出来源保留在榜（垫底又不出活=该清，藏了就看不见）。
 */
export function getPwOutputRanking(
  db: DatabaseSync,
  options: PwSourceStatsOptions = {},
): PwOutputRanking {
  const { rangeDays, generatedAt, cutoff } = resolveWindow(options);
  const counts = collectSourceCounts(db, cutoff);
  const ranking = listSourceDocs(db).map((doc) => {
    const c = counts.get(doc.bvid) ?? { ...ZERO_COUNTS };
    return {
      bvid: doc.bvid,
      title: doc.title,
      upName: doc.up_name,
      produced: c.candidates,
      picked: c.picked,
      refCount: c.refs,
    };
  }).sort((a, b) =>
    b.produced - a.produced
    || b.picked - a.picked
    || (a.bvid < b.bvid ? -1 : a.bvid > b.bvid ? 1 : 0)
  );
  return { rangeDays, generatedAt, ranking };
}
