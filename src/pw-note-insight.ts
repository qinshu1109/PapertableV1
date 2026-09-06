/**
 * TASK-PW-53：笔记定向洞察（后端）。
 *
 * 职责：拿在途押注捞取相关旧笔记（PW-40 读函数），一次性模型调用产出五段洞察报告
 * （事实/模式/矛盾/假设/最小验证），落镇纸新正式表 pw_note_insights，供前端「跑洞察」
 * 与「历史洞察」翻查。
 *
 * 纪律：
 * - Memos 库只读：只调 pw-note-recall.ts / pw-notes.ts 的读函数，不改 PW-39/40 任何读函数。
 * - 报告原文落库不改写；对押注（pw_bets）只读（getPwBet）。
 * - 一次性模型调用范式照 defaultSieveLlm（completeSimple + maxRetries 0）；
 *   异常或空文本重试 1 次，仍败抛 httpError(502)，不落行。
 * - 0 命中不调模型不落行：httpError(400, …带捞取词)。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { contentText } from "@earendil-works/pi-ai";
import { httpError, nowIso } from "./data.ts";
import { getPwBet, type PwBetRow } from "./pw-bets.ts";
import { recallPwNotesForBet, type PwNoteEchoBet } from "./pw-note-recall.ts";
import { createPapertableProvider, type PapertableProvider } from "./provider-settings.ts";

export type PwNoteInsightRow = {
  id: string;
  bet_id: string;
  /** 捞取关键词 JSON 数组（前端展示「捞了哪些词」）。 */
  keywords_json: string;
  /** [{ uid, url, createdAt, matchedKeywords }]（前端来源 chips 用）。 */
  note_refs_json: string;
  /** provider.model.id；注入 mock llm 时记 opts.modelLabel 或 null。 */
  model: string | null;
  report: string;
  created_at: string;
};

/** 来源笔记引用（note_refs_json 解析后的元素形状）。 */
export type PwNoteInsightRef = {
  uid: string;
  url: string;
  createdAt: string;
  matchedKeywords: string[];
};

/** 路由输出形状（前端契约）：keywords/noteRefs 解析成数组，camelCase。 */
export type PublicPwNoteInsight = {
  id: string;
  betId: string;
  keywords: string[];
  noteRefs: PwNoteInsightRef[];
  model: string | null;
  report: string;
  createdAt: string;
};

/** 行 → 路由输出：JSON 列解析（坏 JSON 兜底空数组，不炸路由）。 */
export function publicPwNoteInsight(row: PwNoteInsightRow): PublicPwNoteInsight {
  return {
    id: row.id,
    betId: row.bet_id,
    keywords: parseJsonArray<string>(row.keywords_json),
    noteRefs: parseJsonArray<PwNoteInsightRef>(row.note_refs_json),
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

/** 《洞察纪律》systemPrompt（TASK-PW-53 规格写死，逐字进常量）。 */
export const INSIGHT_SYSTEM_PROMPT = `你是「镇纸 Paperweight」的笔记洞察器。只依据给定的笔记与押注上下文输出，固定五段、顺序固定：
## 可核对的事实与原文线索
## 反复出现的模式
## 当前主要矛盾
## 尚未证实的假设
## 一个最小验证动作
纪律：
1. 事实与推断必须分开：第一段只写笔记里能直接看到的；其余各段每条开头标【推断】。
2. 每条事实或线索末尾标注来源，格式 [笔记N]，N 是输入笔记的编号；禁止笼统说"某条笔记"。
3. 不要补全笔记里没有的信息；没有证据就写"未知"。
4. 不做人格或动机诊断，不替用户做决策。
5. 某段确实没内容可写时写"（无）"，禁止硬凑。`;

/** 建表（ensure 范式，幂等；TASK-PW-53 规格列）。 */
export function ensurePwNoteInsightTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pw_note_insights(
      id TEXT PRIMARY KEY,
      bet_id TEXT NOT NULL,
      keywords_json TEXT NOT NULL,
      note_refs_json TEXT NOT NULL,
      model TEXT,
      report TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
}

// ---------------------------------------------------------------------------
// LLM：一次性调用（非工具循环）；测试注入 mock llm
// ---------------------------------------------------------------------------

export type PwNoteInsightLlm = (prompt: string) => Promise<string>;

function defaultInsightLlm(provider: PapertableProvider): PwNoteInsightLlm {
  return async (prompt) => {
    const response = await provider.models.completeSimple(provider.model, {
      systemPrompt: INSIGHT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    }, {
      maxTokens: 4000,
      timeoutMs: 90_000,
      maxRetries: 0,
      maxRetryDelayMs: 0,
    });
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage || `笔记洞察调用失败：${response.stopReason}`);
    }
    return contentText(response.content, "");
  };
}

/** 装配用户消息：押注标题 + thesis、关键词清单、命中笔记逐条编号（[笔记N] + 时间 + 全文 + 命中词）
 *  + 输出五段标题（规格测试断言 prompt 含五段标题；段内规矩仍在 systemPrompt《洞察纪律》）。 */
function buildInsightPrompt(bet: PwBetRow, echo: PwNoteEchoBet): string {
  return [
    `押注标题：${bet.title}`,
    `押注假设：${bet.thesis}`,
    `捞取关键词：${echo.keywords.join("、")}`,
    `命中笔记（共 ${echo.hits.length} 条，逐条编号）：`,
    ...echo.hits.map((hit, index) =>
      `[笔记${index + 1}]（${hit.createdAt}）\n${hit.content}\n命中词：${hit.matchedKeywords.join("、")}`),
    `输出固定五段、顺序固定（段内其余规矩按《洞察纪律》执行）：\n## 可核对的事实与原文线索\n## 反复出现的模式\n## 当前主要矛盾\n## 尚未证实的假设\n## 一个最小验证动作`,
  ].join("\n\n");
}

export type PwNoteInsightOptions = {
  /** 注入 mock llm（测试）；缺省用 createPapertableProvider 的真实模型。 */
  llm?: PwNoteInsightLlm;
  /** 注入时钟（测试断言 created_at），缺省 nowIso。 */
  now?: () => string;
  /** 注入 llm 时记录到行 model 的标签；缺省 null。 */
  modelLabel?: string | null;
};

/**
 * 单次笔记洞察：getPwBet（无 → 404）→ recallPwNotesForBet(maxHits 10)（0 命中 → 400
 * 不调模型不落行）→ 装配 prompt → 一次性模型调用（异常/空文本重试 1 次，仍败 → 502
 * 不落行）→ 落行返回。
 */
export async function runPwNoteInsight(
  db: DatabaseSync,
  betId: string,
  options: PwNoteInsightOptions = {},
): Promise<PwNoteInsightRow> {
  const bet = getPwBet(db, betId);
  if (!bet) throw httpError(404, "押注不存在");

  const echo = recallPwNotesForBet(
    { id: bet.id, title: bet.title, thesis: bet.thesis },
    { maxHits: 10 },
  );
  if (echo.hits.length === 0) {
    throw httpError(
      400,
      `没有捞到相关旧笔记（捞了：${echo.keywords.slice(0, 10).join("、")}…），先记几条相关笔记再跑洞察`,
    );
  }
  const prompt = buildInsightPrompt(bet, echo);

  let model = options.modelLabel ?? null;
  let runLlm: PwNoteInsightLlm;
  if (options.llm) {
    runLlm = options.llm;
  } else {
    const provider = createPapertableProvider();
    model = provider.model.id;
    runLlm = defaultInsightLlm(provider);
  }

  let report: string | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await runLlm(prompt);
      if (!raw.trim()) throw new Error("洞察模型产出为空");
      report = raw;
      break;
    } catch (error) {
      lastError = error;
      // 异常或空文本：第 2 次循环即重试 1 次
    }
  }
  if (!report) {
    throw httpError(502, `笔记洞察模型调用失败：${safeErrorText(lastError)}`);
  }

  const id = randomUUID();
  const createdAt = options.now ? options.now() : nowIso();
  const row: PwNoteInsightRow = {
    id,
    bet_id: bet.id,
    keywords_json: JSON.stringify(echo.keywords),
    note_refs_json: JSON.stringify(echo.hits.map((hit) => ({
      uid: hit.uid,
      url: hit.url,
      createdAt: hit.createdAt,
      matchedKeywords: hit.matchedKeywords,
    }))),
    model,
    report,
    created_at: createdAt,
  };
  db.prepare(`
    INSERT INTO pw_note_insights(
      id, bet_id, keywords_json, note_refs_json, model, report, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.bet_id, row.keywords_json, row.note_refs_json, row.model, row.report, row.created_at);
  return row;
}

/** 历史洞察：按 betId 过滤，created_at DESC, id DESC，封顶 50。 */
export function listPwNoteInsights(db: DatabaseSync, betId: string): PwNoteInsightRow[] {
  return db.prepare(`
    SELECT * FROM pw_note_insights
    WHERE bet_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 50
  `).all(betId) as PwNoteInsightRow[];
}

function safeErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
