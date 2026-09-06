/**
 * TASK-PW-40：按押注回顾捞取（旧笔记回响）。
 *
 * 职责：拿在途内容押注的标题/引文抽确定性关键词（无 LLM），去 Memos 笔记库（PW-39 只读
 * 消费）捞旧笔记，过命中门槛后装配成 PwNoteEcho，供收工小结（PW-35）末尾回响段与 PW-41
 * 第七屏「相关旧笔记」区消费。
 *
 * 纪律：
 * - 本模块对 Memos 库只读（只调 pw-notes 读函数）；对镇纸库只读（只 SELECT pw_bets，无写）。
 * - 关键词抽取是规格写死的确定性算法：不调 LLM、不做相似度排序——宁缺毋滥，防平庸纪律。
 * - 库打开/查询失败：recallPwNotesForBet 不吞错（抛给上层），buildPwNoteEcho 统一兜底成
 *   { status: "unavailable" }，不让异常逃出。
 * - 本模块不接 HTTP 路由、不碰 main.ts/frontend；无新正式表。
 */
import type { DatabaseSync } from "node:sqlite";
import { listContentBets, sortContentBetsForDisplay } from "./pw-content-bets.ts";
import { queryPwNotesByKeywords, type PwNoteHit } from "./pw-notes.ts";
import { recordPwRecallEvent } from "./pw-recall-events.ts";

/** 单押注回响：捞取关键词 + 过门槛命中（≤maxHits，按 PW-39 排序）。 */
export type PwNoteEchoBet = {
  betId: string;
  betTitle: string;
  /** 实际用于捞取的关键词（封顶 40，展示时可截断） */
  keywords: string[];
  /** 过门槛的命中，≤3 条，按 PW-39 排序 */
  hits: PwNoteHit[];
};

/** 回响三态：ok（bets 可为空数组以外的任意命中组合）/ no_bets（无在途内容押注）/ unavailable（笔记库连不上）。 */
export type PwNoteEcho =
  | { status: "ok"; bets: PwNoteEchoBet[] }
  | { status: "no_bets" }
  | { status: "unavailable"; error: string };

/** 停用词表（TASK-PW-40 规格写死）：段级整段命中即丢弃。
 *  注意只过滤「段」——段内生成的二字组不再二次过滤，防过度收敛靠命中门槛兜底。 */
const STOPWORDS = new Set([
  "的", "了", "是", "我", "你", "他", "她", "它", "我们", "你们", "也", "就", "都", "和", "与",
  "或", "及", "一个", "这个", "那个", "这些", "那些", "什么", "怎么", "为什么", "如何", "可以",
  "应该", "因为", "所以", "但是", "如果", "不是", "没有", "以及", "或者", "对于", "关于", "原文", "来源",
]);

/** 关键词总量封顶（规格写死 40）。 */
const MAX_RECALL_KEYWORDS = 40;

/** 命中门槛（规格写死）：至少 2 个不同关键词命中才算相关——只命中一个二字组太弱
 *  （如「全能」单独命中不足为凭）；实际关键词总数不足 2 时按实际数降级（单关键词按 1 计）。 */
const MIN_MATCHED_KEYWORDS = 2;

/** 段切分：一切非字母/数字字符都是分隔符（unicode 全量覆盖中文）。 */
const SEGMENT_SPLIT_RE = /[^\p{L}\p{N}]+/u;
/** 纯数字段（如「153」）段级过滤时丢弃。 */
const PURE_DIGIT_RE = /^\p{N}+$/u;
/** ASCII 字母数字段（如 AU、C4D、cozai）：整词保留、不拆二字组。 */
const ASCII_WORD_RE = /^[A-Za-z0-9]+$/;

/**
 * 确定性关键词抽取（TASK-PW-40 规格 §关键词抽取，照做）：
 * 1) 文本 = title + "\n" + thesis 剔除「来源：」行与行首「原文：」前缀后的部分
 *    （thesis 噪声来自 PW-19 buildThesis 的 bvid/uname/like，必须剔除）；
 * 2) 以 [^\p{L}\p{N}]+（unicode）切分成段，丢弃空段；
 * 3) 段级过滤：纯数字段 / 单字符段 / 停用词段整段丢弃；
 * 4) ASCII 词段整词保留为一个关键词（不拆）；其余段（含中文）生成全部相邻二字组
 *    （段长恰为 2 时即段本身）；
 * 5) 按出现顺序去重（title 的段先于 thesis 的段——title 权重天然靠前），总量封顶 40。
 * 返回 [] = 无可捞关键词（调用方按「无命中」处理，不调查询）。
 */
export function extractPwRecallKeywords(title: string, thesis: string): string[] {
  // 逐行处理：丢弃以「来源：」开头的行，去掉行首「原文：」前缀
  const lines = [title, ...thesis.split("\n")].flatMap((line) => {
    if (line.startsWith("来源：")) return [];
    return [line.replace(/^原文：/, "")];
  });
  const segments = lines.join("\n").split(SEGMENT_SPLIT_RE).filter((segment) => segment.length > 0);

  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const segment of segments) {
    if (keywords.length >= MAX_RECALL_KEYWORDS) break;
    if (PURE_DIGIT_RE.test(segment)) continue;
    if (segment.length < 2) continue;
    if (STOPWORDS.has(segment)) continue;
    const terms = ASCII_WORD_RE.test(segment) ? [segment] : allBigrams(segment);
    for (const term of terms) {
      if (seen.has(term)) continue;
      seen.add(term);
      keywords.push(term);
      if (keywords.length >= MAX_RECALL_KEYWORDS) break;
    }
  }
  return keywords;
}

/** 全部相邻二字组（bigram）；段长恰为 2 时返回段本身。 */
function allBigrams(segment: string): string[] {
  const bigrams: string[] = [];
  for (let index = 0; index + 1 < segment.length; index++) {
    bigrams.push(segment.slice(index, index + 2));
  }
  return bigrams;
}

/** 正整数钳制（对齐 pw-notes.ts 内部同名助手）：缺省取 fallback，超上限取 cap，非法抛错。 */
function clampPositiveInt(value: number | undefined, fallback: number, cap: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) throw new Error(`${label} 必须是正整数`);
  return Math.min(resolved, cap);
}

/**
 * 单押注捞取：抽词 → queryPwNotesByKeywords → 过命中门槛的行按原排序（PW-39：命中词数降序 +
 * created_ts 倒序）截到 maxHits（默认 3，上限 10）。
 * 关键词为空 → hits: []，不查库。库打开失败不吞错（由 buildPwNoteEcho 统一兜底成 unavailable）。
 */
export function recallPwNotesForBet(
  bet: { id: string; title: string; thesis: string },
  opts: { maxHits?: number } = {},
): PwNoteEchoBet {
  const maxHits = clampPositiveInt(opts.maxHits, 3, 10, "maxHits");
  const keywords = extractPwRecallKeywords(bet.title, bet.thesis);
  if (keywords.length === 0) {
    return { betId: bet.id, betTitle: bet.title, keywords, hits: [] };
  }
  // 查询上限按 maxHits 放大一档（3 倍）：单词命中的行会被门槛挡掉，放大后仍可能凑够 maxHits
  const queryLimit = maxHits * 3;
  const rows = queryPwNotesByKeywords(keywords, { limit: queryLimit });
  const threshold = Math.min(MIN_MATCHED_KEYWORDS, keywords.length);
  const hits = rows.filter((hit) => hit.matchedKeywords.length >= threshold).slice(0, maxHits);
  return { betId: bet.id, betTitle: bet.title, keywords, hits };
}

/**
 * 装配回响（供 getPwDaySummary 内部调用）：
 * - 在途内容押注：listContentBets（PW-19，已排除 void）过滤 status==='pending'，
 *   sortContentBetsForDisplay（PW-27 菜号牌展示序）排序，取前 maxBets（默认 5，上限 20）；
 *   0 张 → { status: "no_bets" }。
 * - 逐张调 recallPwNotesForBet；跨押注去重：同一条笔记只挂在展示序第一张命中它的押注下，
 *   后续押注剔除（剔除后不补位）。
 * - 笔记库打开/查询失败（pw-notes 抛错）→ 整体 { status: "unavailable", error }，不让异常逃出。
 */
export function buildPwNoteEcho(
  db: DatabaseSync,
  opts: { maxBets?: number; maxHitsPerBet?: number } = {},
): PwNoteEcho {
  try {
    const maxBets = clampPositiveInt(opts.maxBets, 5, 20, "maxBets");
    const maxHitsPerBet = clampPositiveInt(opts.maxHitsPerBet, 3, 10, "maxHitsPerBet");
    const displayOrder = sortContentBetsForDisplay(
      listContentBets(db).filter((bet) => bet.status === "pending"),
    ).slice(0, maxBets);
    if (displayOrder.length === 0) return { status: "no_bets" };

    const seenUids = new Set<string>();
    const bets: PwNoteEchoBet[] = [];
    for (const bet of displayOrder) {
      const echoBet = recallPwNotesForBet(
        { id: bet.id, title: bet.title, thesis: bet.thesis },
        { maxHits: maxHitsPerBet },
      );
      const hits = echoBet.hits.filter((hit) => {
        if (seenUids.has(hit.uid)) return false;
        seenUids.add(hit.uid);
        return true;
      });
      bets.push({ betId: echoBet.betId, betTitle: echoBet.betTitle, keywords: echoBet.keywords, hits });
    }
    // TASK-PW-12：每条过门槛命中记 surfaced（surface=echo）。打点是写操作——失败不得
    // 让回响装配失败：包 try/catch 静默跳过（记 warn），绝不改变 ok 返回。
    try {
      for (const bet of bets) {
        for (const hit of bet.hits) {
          recordPwRecallEvent(db, {
            eventKind: "surfaced",
            surface: "echo",
            betId: bet.betId,
            noteUid: hit.uid,
            meta: { matchedKeywords: hit.matchedKeywords },
          });
        }
      }
    } catch (error) {
      console.warn(`[PW-12] echo surfaced 打点失败（不影响回响）：${error instanceof Error ? error.message : String(error)}`);
    }
    return { status: "ok", bets };
  } catch (error) {
    return {
      status: "unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
