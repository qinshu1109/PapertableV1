/** TASK-PW-61：按在途押注与当前方向，从四类只读来源捞候选；AI 只建议。 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { contentText } from "@earendil-works/pi-ai";
import { httpError, nowIso } from "./data.ts";
import { callMemos } from "./memos.ts";
import { listContentBets } from "./pw-content-bets.ts";
import { confirmPwNoteAttach, PW_NOTE_ROLES, type PwNoteRole } from "./pw-note-tree.ts";
import { extractPwRecallKeywords } from "./pw-note-recall.ts";
import { queryPwNotesByKeywords, readPwNotesList } from "./pw-notes.ts";
import { recordPwRecallEvent } from "./pw-recall-events.ts";
import { getSieveDirection } from "./pw-sieve.ts";
// 简报 23 · 曝光自动记账：捞料来源池（金子墓碑/镜像金子进捞料提示词时记一行）
import { recordPwVerdictExposure } from "./pw-closed-loop.ts";
import { createDeepSeekProvider } from "./provider-settings.ts";

export type PwMinerSource = "note" | "gold" | "tombstone" | "memos";
export type PwMinerStatus = "suggested" | "confirmed" | "rejected";
export type PwMinerCardStatus = PwMinerStatus | "direction_seed";
export type PwMinerCardKind = "concept" | "self_memory" | "link_shell";

export type PwMinerRunRow = {
  id: string;
  started_at: string;
  finished_at: string | null;
  trigger_kind: "scheduled" | "manual";
  provider: string;
  model: string;
  candidates_count: number;
  by_source_json: string | null;
  cost_cny: number | null;
  raw_response: string | null;
  source_pool_json: string | null;
  status: string;
};

export type PwMinerCandidateRow = {
  id: string;
  run_id: string;
  source: PwMinerSource;
  ref_uid: string;
  snippet: string;
  suggested_bet_id: string | null;
  reason: string | null;
  status: PwMinerStatus;
  decided_at: string | null;
  created_at: string;
  card_id: string | null;
};

export type PwMinerCardRow = {
  id: string; run_id: string; kind: PwMinerCardKind; title: string;
  summary: string | null; status: PwMinerCardStatus;
  decided_bet_id: string | null; decided_role: string | null;
  decided_at: string | null; created_at: string;
};

type SourceItem = { source: PwMinerSource; refUid: string; text: string; memosUrl?: string };
type MinerLlmResult = { text: string; inputTokens: number; outputTokens: number };
export type PwMinerLlm = (prompt: string) => Promise<MinerLlmResult | string>;

export type PwMinerOptions = {
  triggerKind?: "scheduled" | "manual";
  dataDir?: string;
  llm?: PwMinerLlm;
  searchMemos?: (query: string) => Promise<Array<{ id: string; text: string }>>;
  now?: () => string;
  modelLabel?: string;
};

/** TASK-PW-63：单轮捞料 + 概念聚合的合计预算。 */
export const PW_MINER_BUDGET_CNY = 0.15;
const INPUT_CNY_PER_MILLION = 2;
const OUTPUT_CNY_PER_MILLION = 8;
const MAX_SOURCE_ITEMS = 120;
const MAX_OUTPUT_TOKENS = 5_000;

export function ensurePwMinerTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pw_miner_runs (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('scheduled','manual')),
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      candidates_count INTEGER NOT NULL DEFAULT 0,
      by_source_json TEXT,
      cost_cny REAL,
      raw_response TEXT,
      source_pool_json TEXT,
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pw_miner_candidates (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('note','gold','tombstone','memos')),
      ref_uid TEXT NOT NULL,
      snippet TEXT NOT NULL,
      suggested_bet_id TEXT,
      reason TEXT,
      status TEXT NOT NULL CHECK(status IN ('suggested','confirmed','rejected')),
      decided_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pw_miner_cards (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('concept','self_memory','link_shell')),
      title TEXT NOT NULL,
      summary TEXT,
      status TEXT NOT NULL CHECK(status IN ('suggested','confirmed','rejected','direction_seed')),
      decided_bet_id TEXT, decided_role TEXT,
      decided_at TEXT, created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS pw_miner_candidate_once
      ON pw_miner_candidates(source, ref_uid, COALESCE(suggested_bet_id, ''));
    CREATE INDEX IF NOT EXISTS pw_miner_candidates_run
      ON pw_miner_candidates(run_id, status, suggested_bet_id);
  `);
  const columns = new Set(
    (db.prepare("PRAGMA table_info(pw_miner_runs)").all() as Array<{ name: string }>).map((row) => row.name),
  );
  if (!columns.has("raw_response")) db.exec("ALTER TABLE pw_miner_runs ADD COLUMN raw_response TEXT");
  if (!columns.has("source_pool_json")) db.exec("ALTER TABLE pw_miner_runs ADD COLUMN source_pool_json TEXT");
  const candidateColumns = new Set(
    (db.prepare("PRAGMA table_info(pw_miner_candidates)").all() as Array<{ name: string }>).map((row) => row.name),
  );
  if (!candidateColumns.has("card_id")) db.exec("ALTER TABLE pw_miner_candidates ADD COLUMN card_id TEXT");
}

export function calculateMinerCostCny(inputTokens: number, outputTokens: number): number {
  return Number((inputTokens * INPUT_CNY_PER_MILLION / 1_000_000
    + outputTokens * OUTPUT_CNY_PER_MILLION / 1_000_000).toFixed(6));
}

export async function runPwMiner(
  db: DatabaseSync,
  options: PwMinerOptions = {},
): Promise<ReturnType<typeof publicMinerRun>> {
  ensurePwMinerTables(db);
  const at = options.now ? options.now() : nowIso();
  const triggerKind = options.triggerKind ?? "manual";
  const runId = randomUUID();
  const bets = listContentBets(db).filter((bet) => bet.status === "pending");
  const direction = getSieveDirection(db);
  const model = options.modelLabel ?? "deepseek-v4-flash";
  db.prepare(`
    INSERT INTO pw_miner_runs(
      id, started_at, trigger_kind, provider, model, candidates_count, status
    ) VALUES(?, ?, ?, 'deepseek', ?, 0, 'running')
  `).run(runId, at, triggerKind, model);

  try {
    const keywords = keywordSeeds(direction, bets.flatMap((bet) => [bet.title, bet.thesis]));
    const sourceItems = await collectSources(db, keywords, options.searchMemos);
    // 简报 23 · 曝光自动记账：本次放进捞料提示词「只读来源」的判决 = gold/tombstone 来源项
    recordPwVerdictExposure(db, {
      surface: "miner",
      verdictIds: sourceItems
        .filter((item) => item.source === "gold" || item.source === "tombstone")
        .map((item) => item.refUid),
      actor: "system",
      runId,
    });
    const sourcePool = { note: 0, gold: 0, tombstone: 0, memos: 0 };
    for (const item of sourceItems) sourcePool[item.source] += 1;
    const rejected = db.prepare(`
      SELECT DISTINCT ref_uid FROM pw_miner_candidates
      WHERE status = 'rejected' AND datetime(decided_at) >= datetime(?, '-30 days')
      ORDER BY ref_uid
    `).all(at) as Array<{ ref_uid: string }>;
    const prompt = buildPrompt(
      direction,
      bets.map((bet) => ({ id: bet.id, title: bet.title, thesis: bet.thesis })),
      sourceItems,
      rejected.map((row) => row.ref_uid),
    );
    const llm = options.llm ?? defaultMinerLlm(options.dataDir);
    const raw = await llm(prompt);
    const result = typeof raw === "string"
      ? { text: raw, inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(raw) }
      : raw;
    let costCny = calculateMinerCostCny(result.inputTokens, result.outputTokens);

    const itemIndex = new Map(sourceItems.map((item) => [`${item.source}:${item.refUid}`, item]));
    const validBetIds = new Set(bets.map((bet) => bet.id));
    const bySource = { note: 0, gold: 0, tombstone: 0, memos: 0 };
    const insert = db.prepare(`
      INSERT OR IGNORE INTO pw_miner_candidates(
        id, run_id, source, ref_uid, snippet, suggested_bet_id, reason,
        status, decided_at, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, 'suggested', NULL, ?)
    `);
    let count = 0;
    for (const candidate of parseCandidates(result.text)) {
      const item = itemIndex.get(`${candidate.source}:${candidate.refUid}`);
      if (!item || (candidate.betId && !validBetIds.has(candidate.betId))) continue;
      const candidateId = randomUUID();
      const inserted = insert.run(
        candidateId,
        runId,
        item.source,
        item.refUid,
        truncate(item.text, 80),
        candidate.betId,
        truncate(candidate.reason, 120),
        at,
      );
      if (inserted.changes === 1) {
        count += 1;
        bySource[item.source] += 1;
        // TASK-PW-12：候选落库 = 系统把笔记摆到人面前 → 记 surfaced（surface=miner）。
        recordPwRecallEvent(db, {
          eventKind: "surfaced",
          surface: "miner",
          betId: candidate.betId,
          noteUid: item.refUid,
          minerCandidateId: candidateId,
          runId,
        });
      }
    }
    const aggregate = await aggregateSuggestedCandidates(db, runId, at, llm, bets.map((bet) => ({
      id: bet.id, title: bet.title,
    })));
    costCny = Number((costCny + aggregate.costCny).toFixed(6));
    if (costCny > PW_MINER_BUDGET_CNY) throw new Error(`单轮捞料成本超预算：¥${costCny}`);
    db.prepare(`
      UPDATE pw_miner_runs SET finished_at=?, candidates_count=?, by_source_json=?,
        cost_cny=?, raw_response=?, source_pool_json=?, status='done' WHERE id=?
    `).run(at, count, JSON.stringify(bySource), costCny,
      truncate(`${result.text}\n\n--- aggregate ---\n${aggregate.raw}`, 4_000), JSON.stringify(sourcePool), runId);
    return publicMinerRun(db, getRun(db, runId));
  } catch (error) {
    db.prepare(`UPDATE pw_miner_runs SET finished_at=?, status=? WHERE id=?`).run(
      at,
      `failed:${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
      runId,
    );
    throw error;
  }
}

export async function runPwMinerScheduledTick(
  db: DatabaseSync,
  options: Omit<PwMinerOptions, "triggerKind"> = {},
): Promise<ReturnType<typeof publicMinerRun> | null> {
  ensurePwMinerTables(db);
  const at = options.now ? options.now() : nowIso();
  const now = new Date(at);
  if (now.getHours() < 6 || (now.getHours() === 6 && now.getMinutes() < 30)) return null;
  const day = localDay(now);
  const scheduledRuns = db.prepare(`SELECT started_at FROM pw_miner_runs WHERE trigger_kind='scheduled'`).all() as Array<{ started_at: string }>;
  const ran = scheduledRuns.some((row) => localDay(new Date(row.started_at)) === day);
  return ran ? null : runPwMiner(db, { ...options, triggerKind: "scheduled" });
}

export function listPwMinerCards(
  db: DatabaseSync,
  status: PwMinerCardStatus = "suggested",
): { cards: Array<Record<string, unknown>> } {
  if (!["suggested", "confirmed", "rejected", "direction_seed"].includes(status)) throw httpError(400, "status 非法");
  const cards = db.prepare(`
    SELECT c.*, b.title AS bet_title FROM pw_miner_cards c
    LEFT JOIN pw_bets b ON b.id=COALESCE(c.decided_bet_id, (
      SELECT suggested_bet_id FROM pw_miner_candidates WHERE card_id=c.id AND suggested_bet_id IS NOT NULL LIMIT 1
    )) WHERE c.status=? ORDER BY c.created_at DESC, c.id
  `).all(status) as Array<PwMinerCardRow & { bet_title: string | null }>;
  const items = db.prepare(`SELECT * FROM pw_miner_candidates WHERE card_id=? ORDER BY created_at DESC,id`);
  return { cards: cards.map((card) => ({
    id: card.id, kind: card.kind, title: card.title, summary: card.summary, status: card.status,
    suggestedBetId: card.decided_bet_id ?? ((items.get(card.id) as PwMinerCandidateRow | undefined)?.suggested_bet_id ?? null),
    betTitle: card.bet_title, decidedRole: card.decided_role, createdAt: card.created_at,
    items: (items.all(card.id) as PwMinerCandidateRow[]).map((row) => ({
      id: row.id, source: row.source, snippet: row.snippet, reason: row.reason, status: row.status,
      memosUrl: row.source === "note" ? memosUrl(row.ref_uid) : null,
    })),
  })) };
}

export function confirmPwMinerCard(
  db: DatabaseSync,
  input: { cardId: string; betId: string; role: PwNoteRole },
): PwMinerCardRow {
  const cardId = required(input.cardId, "cardId");
  const betId = required(input.betId, "betId");
  if (!PW_NOTE_ROLES.includes(input.role)) throw httpError(400, "role 非法");
  const card = getCard(db, cardId);
  if (card.status !== "suggested") throw httpError(409, "卡已处理");
  if (!listContentBets(db).some((bet) => bet.id === betId)) throw httpError(404, "押注不存在");
  const at = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    const changed = db.prepare(`UPDATE pw_miner_cards SET status='confirmed',decided_bet_id=?,decided_role=?,decided_at=? WHERE id=? AND status='suggested'`)
      .run(betId, input.role, at, cardId);
    if (changed.changes !== 1) throw httpError(409, "卡已处理");
    const candidates = db.prepare(`SELECT * FROM pw_miner_candidates WHERE card_id=? AND status='suggested'`).all(cardId) as PwMinerCandidateRow[];
    for (const candidate of candidates) {
      db.prepare(`UPDATE pw_miner_candidates SET status='confirmed',suggested_bet_id=?,decided_at=? WHERE id=?`)
        .run(betId, at, candidate.id);
      // TASK-PW-12：候选被确认 = 人认可相关 → 记 confirmed（surface=miner）。
      recordPwRecallEvent(db, {
        eventKind: "confirmed",
        surface: "miner",
        betId,
        noteUid: candidate.ref_uid,
        minerCandidateId: candidate.id,
        role: input.role,
      });
      if (candidate.source === "note") confirmPwNoteAttach(db, candidate.ref_uid, betId, input.role);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return getCard(db, cardId);
}

export function rejectPwMinerCard(db: DatabaseSync, cardIdRaw: string): PwMinerCardRow {
  return decideCard(db, cardIdRaw, "rejected", true);
}

export function seedPwMinerCard(db: DatabaseSync, cardIdRaw: string): PwMinerCardRow {
  return decideCard(db, cardIdRaw, "direction_seed", false);
}

export async function migratePwMinerCards(
  db: DatabaseSync,
  options: Pick<PwMinerOptions, "dataDir" | "llm" | "now" | "modelLabel"> = {},
): Promise<ReturnType<typeof publicMinerRun>> {
  ensurePwMinerTables(db);
  const at = options.now ? options.now() : nowIso();
  const runId = randomUUID();
  const model = options.modelLabel ?? "deepseek-v4-flash";
  db.prepare(`INSERT INTO pw_miner_runs(id,started_at,trigger_kind,provider,model,status) VALUES(?,?,'manual','deepseek',?,'running')`)
    .run(runId, at, model);
  try {
    const bets = listContentBets(db).map((bet) => ({ id: bet.id, title: bet.title }));
    const result = await aggregateSuggestedCandidates(db, runId, at, options.llm ?? defaultMinerLlm(options.dataDir), bets);
    if (result.costCny > PW_MINER_BUDGET_CNY) throw new Error(`单轮捞料成本超预算：¥${result.costCny}`);
    db.prepare(`UPDATE pw_miner_runs SET finished_at=?,cost_cny=?,raw_response=?,status='done' WHERE id=?`)
      .run(at, result.costCny, truncate(result.raw, 4_000), runId);
    return publicMinerRun(db, getRun(db, runId));
  } catch (error) {
    db.prepare(`UPDATE pw_miner_runs SET finished_at=?,status=? WHERE id=?`).run(at, `failed:${error instanceof Error ? error.message : String(error)}`.slice(0, 500), runId);
    throw error;
  }
}

export function listPwMinerCandidates(
  db: DatabaseSync,
  status: PwMinerStatus = "suggested",
): { groups: Array<{ betId: string | null; betTitle: string | null; items: Array<Record<string, unknown>> }> } {
  if (!["suggested", "confirmed", "rejected"].includes(status)) throw httpError(400, "status 非法");
  const rows = db.prepare(`
    SELECT c.*, b.title AS bet_title
    FROM pw_miner_candidates c
    LEFT JOIN pw_bets b ON b.id=c.suggested_bet_id
    WHERE c.status=? ORDER BY c.created_at DESC, c.id
  `).all(status) as Array<PwMinerCandidateRow & { bet_title: string | null }>;
  const groups = new Map<string, { betId: string | null; betTitle: string | null; items: Array<Record<string, unknown>> }>();
  for (const row of rows) {
    const key = row.suggested_bet_id ?? "";
    const group = groups.get(key) ?? {
      betId: row.suggested_bet_id,
      betTitle: row.bet_title,
      items: [],
    };
    group.items.push({
      id: row.id,
      source: row.source,
      snippet: row.snippet,
      reason: row.reason,
      createdAt: row.created_at,
      memosUrl: row.source === "note"
        ? `${(process.env.MEMOS_BASE_URL?.trim() || "http://127.0.0.1:5230").replace(/\/+$/u, "")}/memos/${row.ref_uid}`
        : null,
    });
    groups.set(key, group);
  }
  return { groups: [...groups.values()] };
}

export function confirmPwMinerCandidate(
  db: DatabaseSync,
  input: { id: string; betId: string; role: PwNoteRole },
): PwMinerCandidateRow {
  const id = required(input.id, "id");
  const betId = required(input.betId, "betId");
  if (!PW_NOTE_ROLES.includes(input.role)) throw httpError(400, "role 非法");
  const candidate = getCandidate(db, id);
  if (candidate.status !== "suggested") throw httpError(409, "候选已处理");
  if (!listContentBets(db).some((bet) => bet.id === betId)) throw httpError(404, "押注不存在");
  const at = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    const changed = db.prepare(`
      UPDATE pw_miner_candidates
      SET status='confirmed', suggested_bet_id=?, decided_at=?
      WHERE id=? AND status='suggested'
    `).run(betId, at, id);
    if (changed.changes !== 1) throw httpError(409, "候选已处理");
    if (candidate.source === "note") confirmPwNoteAttach(db, candidate.ref_uid, betId, input.role);
    // TASK-PW-12：候选被确认 = 人认可相关 → 记 confirmed（surface=miner）。
    recordPwRecallEvent(db, {
      eventKind: "confirmed",
      surface: "miner",
      betId,
      noteUid: candidate.ref_uid,
      minerCandidateId: candidate.id,
      role: input.role,
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getCandidate(db, id);
}

export function rejectPwMinerCandidate(db: DatabaseSync, idRaw: string): PwMinerCandidateRow {
  const id = required(idRaw, "id");
  const changed = db.prepare(`
    UPDATE pw_miner_candidates SET status='rejected', decided_at=?
    WHERE id=? AND status='suggested'
  `).run(nowIso(), id);
  if (changed.changes !== 1) throw httpError(409, "候选不存在或已处理");
  const updated = getCandidate(db, id);
  // TASK-PW-12：候选被拒 = 人明确拒绝 → 记 rejected（surface=miner）。
  recordPwRecallEvent(db, {
    eventKind: "rejected",
    surface: "miner",
    noteUid: updated.ref_uid,
    minerCandidateId: id,
  });
  return updated;
}

async function aggregateSuggestedCandidates(
  db: DatabaseSync,
  runId: string,
  at: string,
  llm: PwMinerLlm,
  bets: Array<{ id: string; title: string }>,
): Promise<{ raw: string; costCny: number }> {
  const candidates = db.prepare(`
    SELECT * FROM pw_miner_candidates WHERE status='suggested'
    ORDER BY created_at,id
  `).all() as PwMinerCandidateRow[];
  if (!candidates.length) return { raw: "[]", costCny: 0 };
  const unique = [...new Map(candidates.map((row) => [`${row.source}:${row.ref_uid}`, row])).values()];
  const prompt = [
    "把候选按概念归成少量卡，只输出 JSON 数组。",
    "每项={kind,title,summary,suggestedBetId,candidateKeys:[{source,refUid}]}。",
    "kind 只能是 concept/self_memory/link_shell：self_memory=人的决策或拍板记忆回流（以 memos 为主）；link_shell=只有链接或凭证没有人的想法；其余 concept。特殊类型只标注，不隐藏。",
    `押注：${bets.map((bet) => `${bet.id}|${bet.title}`).join("；") || "（无）"}`,
    "候选：",
    ...unique.map((row) => `[${row.source}:${row.ref_uid}] snippet=${row.snippet} reason=${row.reason ?? ""} suggestedBetId=${row.suggested_bet_id ?? "null"}`),
  ].join("\n");
  const rawResult = await llm(prompt);
  const result = typeof rawResult === "string"
    ? { text: rawResult, inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(rawResult) }
    : rawResult;
  const costCny = calculateMinerCostCny(result.inputTokens, result.outputTokens);
  const valid = new Map(unique.map((row) => [`${row.source}:${row.ref_uid}`, row]));
  const claimed = new Set<string>();
  const cards = parseCards(result.text).flatMap((card) => {
    const rows = card.candidateKeys.flatMap((key) => {
      const id = `${key.source}:${key.refUid}`;
      const row = valid.get(id);
      if (!row || claimed.has(id)) return [];
      claimed.add(id);
      return [row];
    });
    return rows.length ? [{ ...card, rows }] : [];
  });
  const unclaimed = unique.filter((row) => !claimed.has(`${row.source}:${row.ref_uid}`));
  if (unclaimed.length) cards.push({ kind: "concept", title: "未归堆", summary: null, suggestedBetId: null, candidateKeys: [], rows: unclaimed });

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`DELETE FROM pw_miner_cards WHERE status='suggested'`);
    db.prepare(`UPDATE pw_miner_candidates SET card_id=NULL WHERE status='suggested'`).run();
    const insertCard = db.prepare(`INSERT INTO pw_miner_cards(id,run_id,kind,title,summary,status,created_at) VALUES(?,?,?,?,?,'suggested',?)`);
    const assign = db.prepare(`UPDATE pw_miner_candidates SET card_id=?,suggested_bet_id=COALESCE(?,suggested_bet_id) WHERE id=? AND status='suggested'`);
    for (const card of cards) {
      const id = randomUUID();
      insertCard.run(id, runId, card.kind, truncate(card.title, 120), card.summary ? truncate(card.summary, 500) : null, at);
      for (const row of card.rows) assign.run(id, card.suggestedBetId, row.id);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { raw: result.text, costCny };
}

function parseCards(raw: string): Array<{
  kind: PwMinerCardKind; title: string; summary: string | null; suggestedBetId: string | null;
  candidateKeys: Array<{ source: PwMinerSource; refUid: string }>;
}> {
  const match = raw.match(/\[[\s\S]*\]/u);
  if (!match) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(match[0]); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    if (!isCardKind(row.kind) || typeof row.title !== "string" || !row.title.trim() || !Array.isArray(row.candidateKeys)) return [];
    const candidateKeys = row.candidateKeys.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const key = value as Record<string, unknown>;
      return isSource(key.source) && typeof key.refUid === "string" && key.refUid.trim()
        ? [{ source: key.source, refUid: key.refUid.trim() }] : [];
    });
    return [{
      kind: row.kind, title: row.title.trim(), summary: typeof row.summary === "string" ? row.summary : null,
      suggestedBetId: typeof row.suggestedBetId === "string" && row.suggestedBetId.trim() ? row.suggestedBetId.trim() : null,
      candidateKeys,
    }];
  });
}

function decideCard(db: DatabaseSync, cardIdRaw: string, status: "rejected" | "direction_seed", rejectItems: boolean): PwMinerCardRow {
  const cardId = required(cardIdRaw, "cardId");
  getCard(db, cardId);
  const at = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    const changed = db.prepare(`UPDATE pw_miner_cards SET status=?,decided_at=? WHERE id=? AND status='suggested'`).run(status, at, cardId);
    if (changed.changes !== 1) throw httpError(409, "卡已处理");
    const candidates = db.prepare(`SELECT * FROM pw_miner_candidates WHERE card_id=? AND status='suggested'`).all(cardId) as PwMinerCandidateRow[];
    if (rejectItems) db.prepare(`UPDATE pw_miner_candidates SET status='rejected',decided_at=? WHERE card_id=? AND status='suggested'`).run(at, cardId);
    // TASK-PW-12：卡被否 → 候选记 rejected；卡被标方向种子 → 候选记 confirmed + meta 注明 seed。
    for (const candidate of candidates) {
      recordPwRecallEvent(db, status === "direction_seed"
        ? {
          eventKind: "confirmed",
          surface: "miner",
          noteUid: candidate.ref_uid,
          minerCandidateId: candidate.id,
          meta: { seed: true },
        }
        : {
          eventKind: "rejected",
          surface: "miner",
          noteUid: candidate.ref_uid,
          minerCandidateId: candidate.id,
        });
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return getCard(db, cardId);
}

function defaultMinerLlm(dataDir?: string): PwMinerLlm {
  if (!dataDir) throw new Error("dataDir 必填");
  const provider = createDeepSeekProvider(dataDir);
  return async (prompt) => {
    const response = await provider.models.completeSimple(provider.model, {
      systemPrompt: [
        "你是镇纸捞料员，只从给定来源挑与在途押注相关的旧料，不补写来源。",
        "只输出 JSON 数组，每项={source,refUid,betId,reason}；betId 可为 null。",
        "示例：{\"source\":\"note\",\"refUid\":\"abc123\",\"betId\":\"...或null\",\"reason\":\"...\"}。source 只能是 note/gold/tombstone/memos 之一，不要带 :uid 前缀。",
        "近30天被弃 refUid 是反面例子，同类少选；宁缺毋滥。",
      ].join("\n"),
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    }, {
      maxTokens: MAX_OUTPUT_TOKENS,
      timeoutMs: 90_000,
      maxRetries: 0,
      maxRetryDelayMs: 0,
    });
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage || `捞料调用失败：${response.stopReason}`);
    }
    return {
      text: contentText(response.content, ""),
      inputTokens: Number(response.usage?.input ?? 0),
      outputTokens: Number(response.usage?.output ?? 0),
    };
  };
}

async function collectSources(
  db: DatabaseSync,
  keywords: string[],
  searchMemos: PwMinerOptions["searchMemos"],
): Promise<SourceItem[]> {
  const notes = keywords.length
    ? queryPwNotesByKeywords(keywords, { limit: 80 })
    : readPwNotesList({ limit: 80 });
  if (notes.length < 20) {
    const seen = new Set(notes.map((note) => note.uid));
    for (const note of readPwNotesList({ limit: 40 })) {
      if (seen.has(note.uid)) continue;
      notes.push(note);
      seen.add(note.uid);
      if (notes.length >= 40) break;
    }
  }
  const items: SourceItem[] = notes.map((note) => ({
    source: "note",
    refUid: note.uid,
    text: note.content,
    memosUrl: note.url,
  }));
  const verdicts = db.prepare(`
    SELECT id, outcome, COALESCE(lesson, cause_of_death, '') AS text
    FROM pw_verdicts WHERE outcome IN ('gold','tomb') ORDER BY decided_at DESC LIMIT 30
  `).all() as Array<{ id: string; outcome: "gold" | "tomb"; text: string }>;
  items.push(...verdicts.map((row) => ({
    source: row.outcome === "gold" ? "gold" as const : "tombstone" as const,
    refUid: row.id,
    text: row.text,
  })));
  const mirrors = db.prepare(`
    SELECT id, text FROM pw_gold_mirror ORDER BY mirrored_at DESC LIMIT 30
  `).all() as Array<{ id: string; text: string }>;
  items.push(...mirrors.map((row) => ({ source: "gold" as const, refUid: row.id, text: row.text })));
  const query = keywords.join(" ").slice(0, 500) || "Papertable 镇纸";
  const memories = searchMemos ? await searchMemos(query) : await searchMemOs(query);
  items.push(...memories.map((row) => ({ source: "memos" as const, refUid: row.id, text: row.text })));
  return items.slice(0, MAX_SOURCE_ITEMS);
}

async function searchMemOs(query: string): Promise<Array<{ id: string; text: string }>> {
  const result = await callMemos("search_memories", {
    query,
    cube_ids: ["papertable"],
    search_mode: "hybrid",
    rerank: "on",
    top_k: 30,
  }, 20_000);
  return (Array.isArray(result.results) ? result.results : []).flatMap((raw) => {
    const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const id = typeof row.memory_id === "string" ? row.memory_id : typeof row.id === "string" ? row.id : "";
    const text = typeof row.memory === "string" ? row.memory : typeof row.content === "string" ? row.content : "";
    return id && text ? [{ id, text }] : [];
  });
}

function buildPrompt(
  direction: string | null,
  bets: Array<{ id: string; title: string; thesis: string }>,
  items: SourceItem[],
  rejected: string[],
): string {
  const prompt = [
    `当前方向：${direction ?? "（未设置）"}`,
    `在途押注：\n${bets.map((bet) => `${bet.id} | ${bet.title} | ${bet.thesis}`).join("\n") || "（无）"}`,
    `近30天被弃 ref_uid：${rejected.join(", ") || "（无）"}`,
    "只读来源：",
    ...items.map((item) => `[${item.source}:${item.refUid}] ${truncate(item.text, 500)}`),
  ].join("\n\n");
  if (calculateMinerCostCny(estimateTokens(prompt), MAX_OUTPUT_TOKENS) > PW_MINER_BUDGET_CNY) {
    throw new Error("输入材料已超过单轮预算，提前收尾");
  }
  return prompt;
}

function parseCandidates(raw: string): Array<{
  source: PwMinerSource;
  refUid: string;
  betId: string | null;
  reason: string;
}> {
  const match = raw.match(/\[[\s\S]*\]/u);
  if (!match) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    let source = row.source;
    let prefixedUid = "";
    if (!isSource(source) && typeof source === "string") {
      const prefixed = source.match(/^(note|gold|tombstone|memos):(.+)$/u);
      if (prefixed) [, source, prefixedUid] = prefixed;
    }
    if (!isSource(source)) return [];
    const refUid = typeof row.refUid === "string" && row.refUid.trim()
      ? row.refUid.trim()
      : prefixedUid.trim();
    if (!refUid) return [];
    const betId = row.betId === null || row.betId === undefined
      ? null
      : typeof row.betId === "string" ? row.betId.trim() || null : null;
    return [{
      source,
      refUid,
      betId,
      reason: typeof row.reason === "string" ? row.reason : "",
    }];
  });
}

function publicMinerRun(db: DatabaseSync, row: PwMinerRunRow) {
  const bySource = parseObject(row.by_source_json);
  const confirmed = countRunStatus(db, row.id, "confirmed");
  const rejected = countRunStatus(db, row.id, "rejected");
  return {
    id: row.id,
    at: row.finished_at ?? row.started_at,
    triggerKind: row.trigger_kind,
    candidates: row.candidates_count,
    confirmed,
    rejected,
    bySource,
    sourcePool: parseObject(row.source_pool_json),
    costCny: row.cost_cny ?? 0,
    status: row.status,
  };
}

function getRun(db: DatabaseSync, id: string): PwMinerRunRow {
  return db.prepare("SELECT * FROM pw_miner_runs WHERE id=?").get(id) as PwMinerRunRow;
}

function countRunStatus(db: DatabaseSync, runId: string, status: PwMinerStatus): number {
  return Number((db.prepare(`SELECT count(*) AS n FROM pw_miner_candidates WHERE run_id=? AND status=?`)
    .get(runId, status) as { n: number }).n);
}

function getCandidate(db: DatabaseSync, id: string): PwMinerCandidateRow {
  const row = db.prepare("SELECT * FROM pw_miner_candidates WHERE id=?").get(id) as PwMinerCandidateRow | undefined;
  if (!row) throw httpError(404, "候选不存在");
  return row;
}

function getCard(db: DatabaseSync, id: string): PwMinerCardRow {
  const row = db.prepare("SELECT * FROM pw_miner_cards WHERE id=?").get(id) as PwMinerCardRow | undefined;
  if (!row) throw httpError(404, "卡不存在");
  return row;
}

function memosUrl(uid: string): string {
  return `${(process.env.MEMOS_BASE_URL?.trim() || "http://127.0.0.1:5230").replace(/\/+$/u, "")}/memos/${uid}`;
}

function keywordSeeds(direction: string | null, texts: string[]): string[] {
  const extracted = [direction ?? "", ...texts].flatMap((text) => extractPwRecallKeywords(text, ""));
  if (extracted.length) return [...new Set(extracted)].slice(0, 12);
  return fallbackKeywordSeeds(direction, texts);
}

function fallbackKeywordSeeds(direction: string | null, texts: string[]): string[] {
  return [...new Set([direction ?? "", ...texts]
    .flatMap((text) => text.split(/[\s，。！？、：；|/]+/u))
    .map((text) => text.trim())
    .filter((text) => [...text].length >= 2))].slice(0, 12);
}

function estimateTokens(text: string): number {
  return Math.ceil([...text].length / 2);
}

function truncate(value: string, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  return [...text].slice(0, max).join("");
}

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw httpError(400, `${field} 必填`);
  return value.trim();
}

function isSource(value: unknown): value is PwMinerSource {
  return value === "note" || value === "gold" || value === "tombstone" || value === "memos";
}

function isCardKind(value: unknown): value is PwMinerCardKind {
  return value === "concept" || value === "self_memory" || value === "link_shell";
}

function parseObject(raw: string | null): Record<string, number> {
  try {
    const value: unknown = JSON.parse(raw ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, number>
      : {};
  } catch {
    return {};
  }
}

function localDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
