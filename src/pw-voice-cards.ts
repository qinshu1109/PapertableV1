/** TASK-PW-64：把单视频评论聚成主题卡；评论文件仍是只读真值源。 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { contentText } from "@earendil-works/pi-ai";
import { httpError, nowIso } from "./data.ts";
import { readPwCorpusComments, type PwCorpusCommentDetail } from "./pw-corpus.ts";
import { calculateMinerCostCny } from "./pw-miner.ts";
import { addPwVoiceItem, type PwVoiceAudit } from "./pw-voice.ts";
import { createDeepSeekProvider } from "./provider-settings.ts";

export type PwVoiceCardStatus = "suggested" | "collected" | "rejected";
type LlmResult = { text: string; inputTokens: number; outputTokens: number };
export type PwVoiceCardLlm = (prompt: string) => Promise<LlmResult | string>;
export type PwVoiceCardOptions = {
  dataDir?: string; llm?: PwVoiceCardLlm; now?: () => string; modelLabel?: string;
};

type CardRow = {
  id: string; bvid: string; run_id: string; title: string; summary: string | null;
  status: PwVoiceCardStatus; decided_at: string | null; created_at: string;
};
type ItemRow = {
  card_id: string; rpid: number; message: string; uname: string | null;
  like_count: number | null; ctime: number | null; voice_id: string | null;
};

/** 单视频单次主题聚合预算。 */
export const PW_VOICE_CARD_BUDGET_CNY = 0.15;
const MAX_COMMENTS = 300;
const MAX_OUTPUT_TOKENS = 5_000;

export function ensurePwVoiceCardTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pw_voice_theme_cards (
      id TEXT PRIMARY KEY,
      bvid TEXT NOT NULL,
      run_id TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      status TEXT NOT NULL CHECK(status IN ('suggested','collected','rejected')),
      decided_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pw_voice_theme_card_items (
      card_id TEXT NOT NULL,
      rpid INTEGER NOT NULL,
      message TEXT NOT NULL,
      uname TEXT, like_count INTEGER, ctime INTEGER,
      voice_id TEXT,
      PRIMARY KEY (card_id, rpid)
    );
    CREATE TABLE IF NOT EXISTS pw_voice_card_runs (
      id TEXT PRIMARY KEY,
      bvid TEXT NOT NULL,
      started_at TEXT NOT NULL, finished_at TEXT,
      trigger_kind TEXT NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL,
      cards_count INTEGER NOT NULL DEFAULT 0,
      cost_cny REAL, raw_response TEXT, status TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pw_voice_theme_cards_bvid_status
      ON pw_voice_theme_cards(bvid,status,created_at);
  `);
}

export async function aggregatePwVoiceThemeCards(
  db: DatabaseSync,
  bvidRaw: string,
  options: PwVoiceCardOptions = {},
): Promise<Record<string, unknown>> {
  ensurePwVoiceCardTables(db);
  const bvid = required(bvidRaw, "bvid");
  const at = options.now ? options.now() : nowIso();
  const runId = randomUUID();
  const model = options.modelLabel ?? "deepseek-v4-flash";
  db.prepare(`INSERT INTO pw_voice_card_runs(
    id,bvid,started_at,trigger_kind,provider,model,status
  ) VALUES(?, ?, ?, 'manual', 'deepseek', ?, 'running')`).run(runId, bvid, at, model);
  try {
    const excluded = new Set((db.prepare(`
      SELECT i.rpid FROM pw_voice_theme_card_items i
      JOIN pw_voice_theme_cards c ON c.id=i.card_id
      WHERE c.bvid=? AND c.status IN ('collected','rejected')
    `).all(bvid) as Array<{ rpid: number }>).map((row) => row.rpid));
    const comments = readPwCorpusComments(db, bvid)
      .filter((row): row is PwCorpusCommentDetail & { rpid: number } => row.rpid !== null && !excluded.has(row.rpid))
      .sort((a, b) => (b.like ?? 0) - (a.like ?? 0) || (b.ctime ?? 0) - (a.ctime ?? 0))
      .slice(0, MAX_COMMENTS);
    const prompt = buildPrompt(comments);
    const llm = options.llm ?? defaultLlm(options.dataDir);
    const raw = await llm(prompt);
    const result = typeof raw === "string"
      ? { text: raw, inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(raw) }
      : raw;
    const costCny = calculateMinerCostCny(result.inputTokens, result.outputTokens);
    if (costCny > PW_VOICE_CARD_BUDGET_CNY) throw new Error(`单视频评论聚合成本超预算：¥${costCny}`);
    const byRpid = new Map(comments.map((row) => [row.rpid, row]));
    const claimed = new Set<number>();
    const cards = parseCards(result.text).flatMap((card) => {
      const items = card.rpids.flatMap((rpid) => {
        const item = byRpid.get(rpid);
        if (!item || claimed.has(rpid)) return [];
        claimed.add(rpid);
        return [item];
      });
      return items.length ? [{ ...card, items }] : [];
    });
    const unclaimed = comments.filter((row) => !claimed.has(row.rpid));
    if (unclaimed.length) cards.push({ title: "未归堆", summary: null, rpids: [], items: unclaimed });

    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`DELETE FROM pw_voice_theme_card_items WHERE card_id IN (
        SELECT id FROM pw_voice_theme_cards WHERE bvid=? AND status='suggested'
      )`).run(bvid);
      db.prepare(`DELETE FROM pw_voice_theme_cards WHERE bvid=? AND status='suggested'`).run(bvid);
      const insertCard = db.prepare(`INSERT INTO pw_voice_theme_cards(
        id,bvid,run_id,title,summary,status,created_at
      ) VALUES(?,?,?,?,?,'suggested',?)`);
      const insertItem = db.prepare(`INSERT INTO pw_voice_theme_card_items(
        card_id,rpid,message,uname,like_count,ctime,voice_id
      ) VALUES(?,?,?,?,?,?,NULL)`);
      for (const card of cards) {
        const cardId = randomUUID();
        insertCard.run(cardId, bvid, runId, truncate(card.title, 120), card.summary ? truncate(card.summary, 500) : null, at);
        for (const item of card.items) insertItem.run(cardId, item.rpid, item.message, item.uname, item.like, item.ctime);
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    db.prepare(`UPDATE pw_voice_card_runs SET finished_at=?,cards_count=?,cost_cny=?,raw_response=?,status='done' WHERE id=?`)
      .run(at, cards.length, costCny, truncate(result.text, 4_000), runId);
    return publicRun(db, runId);
  } catch (error) {
    db.prepare(`UPDATE pw_voice_card_runs SET finished_at=?,status=? WHERE id=?`).run(
      at, `failed:${error instanceof Error ? error.message : String(error)}`.slice(0, 500), runId,
    );
    throw error;
  }
}

export function listPwVoiceThemeCards(
  db: DatabaseSync,
  bvidRaw: string,
  status: PwVoiceCardStatus = "suggested",
): { cards: Array<Record<string, unknown>> } {
  ensurePwVoiceCardTables(db);
  const bvid = required(bvidRaw, "bvid");
  if (!["suggested", "collected", "rejected"].includes(status)) throw httpError(400, "status 非法");
  const cards = db.prepare(`SELECT * FROM pw_voice_theme_cards WHERE bvid=? AND status=? ORDER BY created_at DESC,id`)
    .all(bvid, status) as CardRow[];
  const getItems = db.prepare(`SELECT * FROM pw_voice_theme_card_items WHERE card_id=? ORDER BY like_count DESC,ctime DESC,rpid`);
  return { cards: cards.map((card) => ({
    id: card.id, bvid: card.bvid, title: card.title, summary: card.summary,
    status: card.status, decidedAt: card.decided_at, createdAt: card.created_at,
    items: (getItems.all(card.id) as ItemRow[]).map((item) => {
      const voiceId = findVoiceId(db, bvid, item.message);
      return { rpid: item.rpid, message: item.message, uname: item.uname, like: item.like_count,
        ctime: item.ctime, collected: Boolean(voiceId), voiceId: voiceId ?? item.voice_id };
    }),
  })) };
}

export function collectPwVoiceThemeCard(
  db: DatabaseSync,
  cardIdRaw: string,
  audit?: PwVoiceAudit,
): { card: Record<string, unknown>; collected: number; skipped: number } {
  const cardId = required(cardIdRaw, "cardId");
  const card = getCard(db, cardId);
  if (card.status !== "suggested") throw httpError(409, "卡已处理");
  const items = db.prepare(`SELECT * FROM pw_voice_theme_card_items WHERE card_id=? ORDER BY rpid`).all(cardId) as ItemRow[];
  let collected = 0;
  let skipped = 0;
  const at = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    const changed = db.prepare(`UPDATE pw_voice_theme_cards SET status='collected',decided_at=? WHERE id=? AND status='suggested'`).run(at, cardId);
    if (changed.changes !== 1) throw httpError(409, "卡已处理");
    for (const item of items) {
      let voiceId = findVoiceId(db, card.bvid, item.message);
      if (voiceId) skipped += 1;
      else {
        voiceId = addPwVoiceItem(db, {
          platform: `bilibili:${card.bvid}`,
          content: item.message,
          author: item.uname ?? "匿名",
          capturedAt: item.ctime === null ? at : new Date(item.ctime * 1_000).toISOString(),
        }, audit).id;
        collected += 1;
      }
      db.prepare(`UPDATE pw_voice_theme_card_items SET voice_id=? WHERE card_id=? AND rpid=?`).run(voiceId, cardId, item.rpid);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { card: listPwVoiceThemeCards(db, card.bvid, "collected").cards.find((row) => row.id === cardId)!, collected, skipped };
}

export function rejectPwVoiceThemeCard(db: DatabaseSync, cardIdRaw: string): CardRow {
  const cardId = required(cardIdRaw, "cardId");
  getCard(db, cardId);
  const changed = db.prepare(`UPDATE pw_voice_theme_cards SET status='rejected',decided_at=? WHERE id=? AND status='suggested'`)
    .run(nowIso(), cardId);
  if (changed.changes !== 1) throw httpError(409, "卡已处理");
  return getCard(db, cardId);
}

function buildPrompt(comments: Array<PwCorpusCommentDetail & { rpid: number }>): string {
  return [
    "按主题归堆以下观众评论，只输出 JSON 数组 [{title,summary,rpids[]}]。",
    "主题只描述观众在乎的事，不评价、不下结论；官方或广告引流评论单独成卡，title 必须标注「广告」。",
    ...comments.map((row) => `[${row.rpid}] ${truncate(row.message, 500)} | 赞 ${row.like ?? 0} | ${row.uname ?? "匿名"}`),
  ].join("\n");
}

function parseCards(raw: string): Array<{ title: string; summary: string | null; rpids: number[] }> {
  const match = raw.match(/\[[\s\S]*\]/u);
  if (!match) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(match[0]); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    if (typeof row.title !== "string" || !row.title.trim() || !Array.isArray(row.rpids)) return [];
    const rpids = [...new Set(row.rpids.filter((rpid): rpid is number => typeof rpid === "number" && Number.isInteger(rpid)))];
    return [{ title: row.title.trim(), summary: typeof row.summary === "string" ? row.summary : null, rpids }];
  });
}

function defaultLlm(dataDir?: string): PwVoiceCardLlm {
  if (!dataDir) throw new Error("dataDir 必填");
  const provider = createDeepSeekProvider(dataDir);
  return async (prompt) => {
    const response = await provider.models.completeSimple(provider.model, {
      systemPrompt: "你是镇纸评论主题归堆员，只摆逐字证据，不评价、不替人决定。只输出指定 JSON 数组。",
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    }, { maxTokens: MAX_OUTPUT_TOKENS, timeoutMs: 90_000, maxRetries: 0, maxRetryDelayMs: 0 });
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage || `评论聚合调用失败：${response.stopReason}`);
    }
    return { text: contentText(response.content, ""), inputTokens: Number(response.usage?.input ?? 0), outputTokens: Number(response.usage?.output ?? 0) };
  };
}

function findVoiceId(db: DatabaseSync, bvid: string, message: string): string | null {
  return (db.prepare(`SELECT id FROM pw_voice_items WHERE platform=? AND content=? AND dropped_reason IS NULL ORDER BY created_at LIMIT 1`)
    .get(`bilibili:${bvid}`, message) as { id: string } | undefined)?.id ?? null;
}

function getCard(db: DatabaseSync, id: string): CardRow {
  const row = db.prepare(`SELECT * FROM pw_voice_theme_cards WHERE id=?`).get(id) as CardRow | undefined;
  if (!row) throw httpError(404, "卡不存在");
  return row;
}

function publicRun(db: DatabaseSync, id: string): Record<string, unknown> {
  const row = db.prepare(`SELECT * FROM pw_voice_card_runs WHERE id=?`).get(id) as Record<string, unknown>;
  return { id: row.id, bvid: row.bvid, at: row.finished_at ?? row.started_at, cards: row.cards_count,
    costCny: row.cost_cny ?? 0, status: row.status };
}

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw httpError(400, `${field} 必填`);
  return value.trim();
}

function truncate(value: string, max: number): string {
  return [...value.trim()].slice(0, max).join("");
}

function estimateTokens(text: string): number {
  return Math.ceil([...text].length / 2);
}
