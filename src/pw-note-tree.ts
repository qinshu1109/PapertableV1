/** TASK-PW-60：笔记树本地派生数据；Memos 只经 pw-notes.ts 只读消费。 */
import type { DatabaseSync } from "node:sqlite";
import { contentText } from "@earendil-works/pi-ai";
import { httpError, nowIso } from "./data.ts";
import { listContentBets } from "./pw-content-bets.ts";
import { readPwNotesList, type PwNote } from "./pw-notes.ts";
import { recordPwRecallEvent } from "./pw-recall-events.ts";
import { getSieveDirection } from "./pw-sieve.ts";
import { createPapertableProvider, type PapertableProvider } from "./provider-settings.ts";

export type PwNoteAttachRow = {
  note_uid: string;
  bet_id: string | null;
  status: "suggested" | "confirmed";
  keyword: string | null;
  role: PwNoteRole | null;
  created_at: string;
  updated_at: string;
};

export const PW_NOTE_ROLES = ["论点", "案例", "标题", "反例", "其他"] as const;
export type PwNoteRole = typeof PW_NOTE_ROLES[number];

export type PwNoteTree = {
  direction: string | null;
  bets: Array<{
    betId: string;
    title: string;
    status: string;
    dueDate: string | null;
    lastNoteAt: string | null;
    notes: Array<{ uid: string; keyword: string | null; createdAt: string; attachStatus: "confirmed" }>;
  }>;
  unassigned: Array<{ uid: string; keyword: string | null; createdAt: string; suggestedBetId: string | null }>;
};

export function ensurePwNoteTreeTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pw_note_attach (
      note_uid TEXT PRIMARY KEY,
      bet_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('suggested','confirmed')),
      keyword TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  const columns = new Set(
    (db.prepare("PRAGMA table_info(pw_note_attach)").all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
  if (!columns.has("role")) db.exec("ALTER TABLE pw_note_attach ADD COLUMN role TEXT");
}

function readAllNotes(): PwNote[] {
  const notes: PwNote[] = [];
  for (let offset = 0;; offset += 200) {
    const page = readPwNotesList({ limit: 200, offset });
    notes.push(...page);
    if (page.length < 200) return notes;
  }
}

export function buildPwNoteTree(db: DatabaseSync): PwNoteTree {
  const notes = readAllNotes();
  const attaches = new Map(
    (db.prepare("SELECT * FROM pw_note_attach").all() as PwNoteAttachRow[])
      .map((row) => [row.note_uid, row]),
  );
  const bets = listContentBets(db).map((bet) => {
    const attached = notes
      .filter((note) => {
        const row = attaches.get(note.uid);
        return row?.status === "confirmed" && row.bet_id === bet.id;
      })
      .map((note) => ({
        uid: note.uid,
        keyword: attaches.get(note.uid)?.keyword ?? null,
        createdAt: note.createdAt,
        attachStatus: "confirmed" as const,
      }));
    return {
      betId: bet.id,
      title: bet.title,
      status: bet.status,
      dueDate: bet.checkout_date,
      lastNoteAt: attached[0]?.createdAt ?? null,
      notes: attached,
    };
  });
  const assigned = new Set(bets.flatMap((bet) => bet.notes.map((note) => note.uid)));
  return {
    direction: getSieveDirection(db),
    bets,
    unassigned: notes.filter((note) => !assigned.has(note.uid)).map((note) => {
      const row = attaches.get(note.uid);
      return {
        uid: note.uid,
        keyword: row?.keyword ?? null,
        createdAt: note.createdAt,
        suggestedBetId: row?.status === "suggested" ? row.bet_id : null,
      };
    }),
  };
}

export function confirmPwNoteAttach(
  db: DatabaseSync,
  noteUid: string,
  betId: string | null,
  role: PwNoteRole | null = null,
): void {
  const uid = requiredText(noteUid, "noteUid");
  const target = optionalText(betId);
  if (target && !listContentBets(db).some((bet) => bet.id === target)) {
    throw httpError(404, "押注不存在");
  }
  if (role !== null && !PW_NOTE_ROLES.includes(role)) throw httpError(400, "role 非法");
  const at = nowIso();
  db.prepare(`
    INSERT INTO pw_note_attach(note_uid, bet_id, status, keyword, role, created_at, updated_at)
    VALUES(?, ?, 'confirmed', NULL, ?, ?, ?)
    ON CONFLICT(note_uid) DO UPDATE SET
      bet_id = excluded.bet_id, status = 'confirmed', role = excluded.role,
      updated_at = excluded.updated_at
  `).run(uid, target, role, at, at);
  // TASK-PW-12：笔记被挂到押注/笔记树（人触发）→ 记 attached（surface=note_tree）。
  recordPwRecallEvent(db, {
    eventKind: "attached",
    surface: "note_tree",
    betId: target,
    noteUid: uid,
    role,
  });
}

export function setPwNoteKeyword(db: DatabaseSync, noteUid: string, keyword: string): void {
  const uid = requiredText(noteUid, "noteUid");
  const text = validateKeyword(keyword);
  const at = nowIso();
  db.prepare(`
    INSERT INTO pw_note_attach(note_uid, bet_id, status, keyword, created_at, updated_at)
    VALUES(?, NULL, 'suggested', ?, ?, ?)
    ON CONFLICT(note_uid) DO UPDATE SET keyword = excluded.keyword, updated_at = excluded.updated_at
  `).run(uid, text, at, at);
}

export type PwNoteTreeLlm = (prompt: string) => Promise<string>;
export type PwNoteTreeTickOptions = { llm?: PwNoteTreeLlm; now?: () => string };

const TREE_SYSTEM_PROMPT = [
  "你是镇纸笔记树整理器，只做归纳和归类建议，不替人确认。",
  "只输出 JSON：{\"keyword\":\"不超过12字\",\"betId\":\"候选押注ID或null\"}。",
  "keyword 必须来自笔记原意；betId 只能从给定候选中选择，没有合适项就填 null。",
].join("\n");

function defaultTreeLlm(provider: PapertableProvider): PwNoteTreeLlm {
  return async (prompt) => {
    const response = await provider.models.completeSimple(provider.model, {
      systemPrompt: TREE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    }, { maxTokens: 200, timeoutMs: 90_000, maxRetries: 0, maxRetryDelayMs: 0 });
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage || `笔记树模型调用失败：${response.stopReason}`);
    }
    return contentText(response.content, "");
  };
}

/** 每拍：缺关键词最多 10 条、缺 AI 挂接建议最多 10 条；模型失败留待下拍。 */
export async function runPwNoteTreeTick(
  db: DatabaseSync,
  options: PwNoteTreeTickOptions = {},
): Promise<{ keywords: number; suggestions: number }> {
  const notes = readAllNotes();
  const rows = new Map(
    (db.prepare("SELECT * FROM pw_note_attach").all() as PwNoteAttachRow[])
      .map((row) => [row.note_uid, row]),
  );
  const keywordUids = new Set(notes.filter((note) => !rows.get(note.uid)?.keyword).slice(0, 10).map((note) => note.uid));
  const suggestUids = new Set(notes.filter((note) => {
    const row = rows.get(note.uid);
    return !row || (row.status === "suggested" && !row.bet_id);
  }).slice(0, 10).map((note) => note.uid));
  const targets = notes.filter((note) => keywordUids.has(note.uid) || suggestUids.has(note.uid));
  if (targets.length === 0) return { keywords: 0, suggestions: 0 };

  const bets = listContentBets(db);
  const validBetIds = new Set(bets.map((bet) => bet.id));
  const llm = options.llm ?? defaultTreeLlm(createPapertableProvider());
  let keywords = 0;
  let suggestions = 0;
  for (const note of targets) {
    try {
      const result = parseModelResult(await llm([
        `笔记：${note.content}`,
        "候选押注：",
        ...bets.map((bet) => `${bet.id} | ${bet.title} | ${bet.thesis}`),
      ].join("\n")));
      const keyword = keywordUids.has(note.uid) && result.keyword
        ? truncateKeyword(result.keyword)
        : null;
      const betId = suggestUids.has(note.uid) && result.betId && validBetIds.has(result.betId)
        ? result.betId
        : null;
      if (!keyword && !betId) continue;
      const at = options.now ? options.now() : nowIso();
      const existing = rows.get(note.uid);
      db.prepare(`
        INSERT INTO pw_note_attach(note_uid, bet_id, status, keyword, created_at, updated_at)
        VALUES(?, ?, 'suggested', ?, ?, ?)
        ON CONFLICT(note_uid) DO UPDATE SET
          bet_id = CASE WHEN pw_note_attach.status = 'confirmed' THEN pw_note_attach.bet_id ELSE COALESCE(excluded.bet_id, pw_note_attach.bet_id) END,
          keyword = COALESCE(excluded.keyword, pw_note_attach.keyword),
          updated_at = excluded.updated_at
      `).run(note.uid, betId, keyword, existing?.created_at ?? at, at);
      if (keyword) keywords += 1;
      if (betId) suggestions += 1;
    } catch {
      // 单条失败不阻断本拍；该条仍缺字段，下拍自然重试。
    }
  }
  return { keywords, suggestions };
}

function parseModelResult(raw: string): { keyword: string | null; betId: string | null } {
  const match = raw.match(/\{[\s\S]*\}/u);
  if (!match) return { keyword: null, betId: null };
  const value: unknown = JSON.parse(match[0]);
  if (!value || typeof value !== "object" || Array.isArray(value)) return { keyword: null, betId: null };
  const record = value as Record<string, unknown>;
  return {
    keyword: typeof record.keyword === "string" ? record.keyword.trim() || null : null,
    betId: typeof record.betId === "string" ? record.betId.trim() || null : null,
  };
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw httpError(400, `${field} 必填`);
  return value.trim();
}

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw httpError(400, "betId 必须是字符串或 null");
  return value.trim() || null;
}

function validateKeyword(value: unknown): string {
  const text = requiredText(value, "keyword");
  if ([...text].length > 12) throw httpError(400, "keyword 不能超过 12 字");
  return text;
}

function truncateKeyword(value: string): string | null {
  const text = value.trim();
  return text ? [...text].slice(0, 12).join("") : null;
}
