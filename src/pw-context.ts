/**
 * 协作台上下文装配（P0 形态）：确定性读取 Paperweight 金子（pw_verdicts）
 * 与 Papertable 同步来的金子（pw_gold_mirror），按与当前押注的关键词相关度
 * 排序，按字符预算截断，产出只读 Markdown 块。
 *
 * 设计约束（PRD v0.2）：不引入自主记忆系统；个人量级（几十到几百条）不做
 * 向量检索；装配是确定性代码，模型不参与选择。
 */
import type { DatabaseSync } from "node:sqlite";
import { httpError } from "./data.ts";
import type { PwDataDocRow } from "./pw-data-docs.ts";
import { listPwDataDocs } from "./pw-data-docs.ts";
import {
  listPwCorpus,
  searchPwCorpus,
  type PwCorpusDocRow,
  type PwCorpusHit,
} from "./pw-corpus.ts";
import { listPwSieveCardsByStatus, pwSieveCardLabels, type PwSieveCardRow } from "./pw-sieve.ts";
import { listContentBets, sortContentBetsForDisplay } from "./pw-content-bets.ts";

/** TASK-PW-22：全局证据对话的哨兵会话 id（pw_collab_messages.bet_id 可取该值，不对应真实押注）。 */
export const PW_COLLAB_GLOBAL_BET_ID = "global";

export type PwContextSource = "paperweight" | "papertable";

export type PwContextItem = {
  id: string;
  source: PwContextSource;
  text: string;
  score: number;
  recency: string;
};

export type PwJudgmentContext = {
  markdown: string;
  included: PwContextItem[];
  truncated: boolean;
  total: number;
};

const DEFAULT_CHAR_BUDGET = 2000;

export function assembleJudgmentContext(
  db: DatabaseSync,
  betId: string,
  options: { charBudget?: number } = {},
): PwJudgmentContext {
  const bet = db.prepare(`
    SELECT id, title, thesis, metric, data_source_plan
    FROM pw_bets WHERE id = ?
  `).get(betId) as {
    id: string;
    title: string;
    thesis: string;
    metric: string | null;
    data_source_plan: string | null;
  } | undefined;
  if (!bet) throw httpError(404, "押注不存在");

  const keywords = extractKeywords(
    [bet.title, bet.thesis, bet.metric ?? "", bet.data_source_plan ?? ""].join("\n"),
  );
  const budget = options.charBudget ?? DEFAULT_CHAR_BUDGET;

  const candidates = loadGoldCandidates(db)
    .map((item) => ({ ...item, score: relevance(item.text, keywords) }))
    .sort((a, b) =>
      b.score - a.score
      || b.recency.localeCompare(a.recency)
      || a.id.localeCompare(b.id)
    );

  const included: PwContextItem[] = [];
  let used = 0;
  for (const item of candidates) {
    const line = renderLine(item, included.length + 1);
    if (included.length > 0 && used + line.length > budget) break;
    included.push(item);
    used += line.length;
  }

  const header = "## 有效判断（金子，只读引用）\n";
  const markdown = included.length === 0
    ? ""
    : header + included.map((item, index) => renderLine(item, index + 1)).join("");

  return {
    markdown,
    included,
    truncated: included.length < candidates.length,
    total: candidates.length,
  };
}

function loadGoldCandidates(db: DatabaseSync): PwContextItem[] {
  const own = db.prepare(`
    SELECT id, lesson, decided_at FROM pw_verdicts
    WHERE outcome = 'gold' AND lesson IS NOT NULL
  `).all() as Array<{ id: string; lesson: string; decided_at: string }>;
  const mirrored = db.prepare(`
    SELECT id, text, mirrored_at FROM pw_gold_mirror
  `).all() as Array<{ id: string; text: string; mirrored_at: string }>;
  return [
    ...own.map((row) => ({
      id: row.id,
      source: "paperweight" as const,
      text: row.lesson,
      score: 0,
      recency: row.decided_at,
    })),
    ...mirrored.map((row) => ({
      id: row.id,
      source: "papertable" as const,
      text: row.text,
      score: 0,
      recency: row.mirrored_at,
    })),
  ];
}

function extractKeywords(text: string): Set<string> {
  const tokens = text.toLowerCase().split(/[^a-z0-9一-鿿]+/u);
  return new Set(tokens.filter((token) => token.length >= 2));
}

function relevance(text: string, keywords: Set<string>): number {
  if (keywords.size === 0) return 0;
  const lower = text.toLowerCase();
  let score = 0;
  for (const keyword of keywords) {
    if (lower.includes(keyword)) score += 1;
  }
  return score;
}

function renderLine(item: PwContextItem, index: number): string {
  const tag = item.source === "paperweight" ? "镇纸" : "纸桌";
  return `- §${index} [${tag}·${item.id}] ${item.text}\n`;
}

// ---- TASK-PW-15：协作台装配 v2（buildCollabContext）；TASK-PW-21 扩展为 v3 ----

export type PwCollabGoldItem = {
  ref: string;
  id: string;
  source: PwContextSource;
  text: string;
};

export type PwCollabTombItem = {
  ref: string;
  id: string;
  causeOfDeath: string;
};

export type PwCollabContext = {
  markdown: string;
  golds: PwCollabGoldItem[];
  tombs: PwCollabTombItem[];
  charUsed: number;
};

const COLLAB_CHAR_BUDGET = 4000;

/**
 * 协作台装配 v3：在金子 §N 之上叠加墓碑（编号续接）、本押注数据文档序列、
 * 语料预检、当前押注卡、待选候选卡（草稿）与语料库清单，产出只读 Markdown 注入 system prompt。
 * §N 在同一次对话内全轮稳定：search_verdicts 工具引用同一编号表（见 pw-collab-tools）。
 */
export function buildCollabContext(
  db: DatabaseSync,
  betId: string,
  options: { charBudget?: number } = {},
): PwCollabContext {
  // TASK-PW-22：全局证据对话走全局装配（无单卡，不 404）
  if (betId === PW_COLLAB_GLOBAL_BET_ID) return buildGlobalCollabContext(db, options);
  const bet = db.prepare(`
    SELECT id, title, thesis, metric, metric_target, confidence,
           data_source_plan, checkout_date, status
    FROM pw_bets WHERE id = ?
  `).get(betId) as {
    id: string;
    title: string;
    thesis: string;
    metric: string | null;
    metric_target: string | null;
    confidence: number | null;
    data_source_plan: string | null;
    checkout_date: string | null;
    status: string;
  } | undefined;
  if (!bet) throw httpError(404, "押注不存在");

  const budget = options.charBudget ?? COLLAB_CHAR_BUDGET;
  const keywords = extractKeywords(
    [bet.title, bet.thesis, bet.metric ?? "", bet.data_source_plan ?? ""].join("\n"),
  );

  const golds = collabGolds(db, keywords, budget);
  const tombs = collabTombs(db, golds.length);
  const refs = new Map<string, string>();
  for (const gold of golds) refs.set(gold.id, gold.ref);
  for (const tomb of tombs) refs.set(tomb.id, tomb.ref);

  const sections: string[] = [];
  sections.push([
    "## 当前押注卡",
    `- 押注：${bet.title}（id ${bet.id}，状态 ${bet.status}）`,
    `- 假设：${bet.thesis}`,
    `- 验证指标：${bet.metric ?? "—"}${bet.metric_target ? `（目标 ${bet.metric_target}）` : ""}`,
    `- 数据来源：${bet.data_source_plan ?? "—"}`,
    `- 结账日：${bet.checkout_date ?? "—"} · 置信度：${bet.confidence ?? "—"}%`,
    "",
  ].join("\n"));

  if (golds.length > 0) {
    sections.push(
      "## 有效判断（金子，只读引用）\n"
      + golds.map((gold) => {
        const tag = gold.source === "paperweight" ? "镇纸" : "纸桌";
        return `- ${gold.ref} [${tag}·${gold.id}] ${gold.text}\n`;
      }).join(""),
    );
  }
  if (tombs.length > 0) {
    sections.push(
      "## 墓碑（只读引用）\n"
      + tombs.map((tomb) => `- ${tomb.ref} [镇纸·${tomb.id}] ${tomb.causeOfDeath}\n`).join(""),
    );
  }

  const docs = collabDataDocs(db, betId);
  if (docs.length > 0) {
    // TASK-PW-27：菜号牌「文档 N」（与 read_data_docs 工具同源排序）
    sections.push(
      "## 数据文档（本押注）\n"
      + docs.map((doc, index) => `- [文档 ${index + 1}·${doc.id}] [${doc.platform}] 采集 ${doc.collected_at} v${doc.version}：${compactJson(doc.metrics_json)}\n`).join(""),
    );
  }

  const corpusHits = collabCorpusPrecheck(db, bet);
  if (corpusHits.length > 0) {
    sections.push(
      "## 语料预检（评论 top 5）\n"
      + corpusHits.map((hit) => `- ${hit.bvid} @${hit.uname ?? "匿名"}（赞 ${hit.like ?? 0}）：${hit.snippet}\n`).join(""),
    );
  }

  // TASK-PW-21：装配 v3 —— 待选候选卡（草稿，只读引用）与语料库清单
  // TASK-PW-27：菜号牌「证据 N / 少数派 N」（与协作台候选卡区徽标同源）
  const pendingCards = collabPendingCards(db);
  if (pendingCards.length > 0) {
    const cardLabels = pwSieveCardLabels(pendingCards);
    sections.push(
      "## 待选候选卡（草稿，只读引用）\n"
      + pendingCards.map((card) => {
        return `- [${cardLabels.get(card.id)}·${card.id}] ${card.quote_text}（scale=${card.scale_value}，score=${card.sort_score}）\n`;
      }).join(""),
    );
  }

  const corpusList = collabCorpusList(db);
  if (corpusList.length > 0) {
    sections.push(
      "## 语料库清单\n"
      + corpusList.map((row) =>
        `- ${row.bvid} ${row.title ?? "（无标题）"} 评论=${row.comment_count ?? 0} 状态=${row.status}\n`
      ).join(""),
    );
  }

  const markdown = sections.join("\n");
  return { markdown, golds, tombs, charUsed: markdown.length };
}

/**
 * TASK-PW-22：全局装配（betId='global'）——无单卡视角，注入全部全局证据：
 * 在途内容押注卡（pending）+ 待选候选卡 + 语料库清单 + 金子墓碑 §N（无关键词预筛，按基础序）。
 */
function buildGlobalCollabContext(
  db: DatabaseSync,
  options: { charBudget?: number } = {},
): PwCollabContext {
  const budget = options.charBudget ?? COLLAB_CHAR_BUDGET;
  const golds = collabGolds(db, new Set(), budget);
  const tombs = collabTombs(db, golds.length);

  const sections: string[] = [];
  // TASK-PW-27：菜号牌「注 N」——与协作台 rail 同源（同集合 listContentBets + 同排序 sortContentBetsForDisplay）
  const contentBets = sortContentBetsForDisplay(listContentBets(db));
  if (contentBets.length > 0) {
    sections.push(
      "## 在途内容押注卡\n"
      + contentBets.map((bet, index) =>
        `- [注 ${index + 1}·${bet.id}] ${bet.title}｜转化信号：${bet.metric ?? "—"}（目标 ${bet.metric_target ?? "—"}）｜看结果日：${bet.checkout_date ?? "—"}｜状态：${bet.status}\n`
      ).join(""),
    );
  }

  if (golds.length > 0) {
    sections.push(
      "## 有效判断（金子，只读引用）\n"
      + golds.map((gold) => {
        const tag = gold.source === "paperweight" ? "镇纸" : "纸桌";
        return `- ${gold.ref} [${tag}·${gold.id}] ${gold.text}\n`;
      }).join(""),
    );
  }
  if (tombs.length > 0) {
    sections.push(
      "## 墓碑（只读引用）\n"
      + tombs.map((tomb) => `- ${tomb.ref} [镇纸·${tomb.id}] ${tomb.causeOfDeath}\n`).join(""),
    );
  }

  const pendingCards = collabPendingCards(db);
  if (pendingCards.length > 0) {
    // TASK-PW-27：菜号牌「证据 N / 少数派 N」（与协作台候选卡区徽标同源）
    const cardLabels = pwSieveCardLabels(pendingCards);
    sections.push(
      "## 待选候选卡（草稿，只读引用）\n"
      + pendingCards.map((card) => {
        return `- [${cardLabels.get(card.id)}·${card.id}] ${card.quote_text}（scale=${card.scale_value}，score=${card.sort_score}）\n`;
      }).join(""),
    );
  }

  const corpusList = collabCorpusList(db);
  if (corpusList.length > 0) {
    sections.push(
      "## 语料库清单\n"
      + corpusList.map((row) =>
        `- ${row.bvid} ${row.title ?? "（无标题）"} 评论=${row.comment_count ?? 0} 状态=${row.status}\n`
      ).join(""),
    );
  }

  const markdown = sections.join("\n");
  return { markdown, golds, tombs, charUsed: markdown.length };
}

function collabGolds(
  db: DatabaseSync,
  keywords: Set<string>,
  budget: number,
): PwCollabGoldItem[] {
  const candidates = loadGoldCandidates(db)
    .map((item) => ({ ...item, score: relevance(item.text, keywords) }))
    .sort((a, b) =>
      b.score - a.score
      || b.recency.localeCompare(a.recency)
      || a.id.localeCompare(b.id)
    );
  const items: PwCollabGoldItem[] = [];
  let used = 0;
  for (const item of candidates) {
    const line = renderLine(item, items.length + 1);
    if (items.length > 0 && used + line.length > budget) break;
    items.push({ ref: `§${items.length + 1}`, id: item.id, source: item.source, text: item.text });
    used += line.length;
  }
  return items;
}

function collabTombs(db: DatabaseSync, startIndex: number): PwCollabTombItem[] {
  const rows = db.prepare(`
    SELECT id, cause_of_death FROM pw_verdicts
    WHERE outcome = 'tomb' AND cause_of_death IS NOT NULL
    ORDER BY decided_at, created_at
  `).all() as Array<{ id: string; cause_of_death: string }>;
  return rows.map((row, index) => ({
    ref: `§${startIndex + index + 1}`,
    id: row.id,
    causeOfDeath: row.cause_of_death,
  }));
}

function collabDataDocs(db: DatabaseSync, betId: string): PwDataDocRow[] {
  return listPwDataDocs(db, betId)
    .slice()
    .sort((a, b) =>
      a.collected_at.localeCompare(b.collected_at)
      || a.created_at.localeCompare(b.created_at)
    );
}

function collabCorpusPrecheck(
  db: DatabaseSync,
  bet: { title: string; metric: string | null },
): PwCorpusHit[] {
  const keywords = [...extractKeywords([bet.title, bet.metric ?? ""].join("\n"))]
    .sort((a, b) => b.length - a.length)
    .slice(0, 3);
  const seen = new Set<string>();
  const hits: PwCorpusHit[] = [];
  for (const keyword of keywords) {
    for (const hit of searchPwCorpus(db, keyword)) {
      if (seen.has(hit.bvid)) continue;
      seen.add(hit.bvid);
      hits.push(hit);
      if (hits.length >= 5) return hits;
    }
  }
  return hits;
}

// ---- TASK-PW-21：装配 v3（待选候选卡 / 语料库清单，按条数截断照既有风格）----

const COLLAB_PENDING_CARDS_MAX = 5;
const COLLAB_CORPUS_LIST_MAX = 10;

/** 待选候选卡：status='pending'，normal 按 sort_score 降序、wildcard 另置一区（不参与排序），取 top 5。 */
function collabPendingCards(db: DatabaseSync): PwSieveCardRow[] {
  return listPwSieveCardsByStatus(db, "pending").slice(0, COLLAB_PENDING_CARDS_MAX);
}

/** 语料库清单：已登记抓取的 BV ≤10 条（与 list_corpus 工具同源）。 */
function collabCorpusList(db: DatabaseSync): PwCorpusDocRow[] {
  return listPwCorpus(db).slice(0, COLLAB_CORPUS_LIST_MAX);
}

function compactJson(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json));
  } catch {
    return json;
  }
}
