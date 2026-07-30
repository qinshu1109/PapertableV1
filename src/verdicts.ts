/**
 * 判决簿（Verdict Ledger）——ADR: 耐久层只持久化用户判决。
 *
 * - 墓碑（tombstone）：改道时由 AI 起草一行"用户否决了 X，因为 Y"，
 *   proposed 状态等待用户确认；用户确认/改写后 confirmed 入簿。
 * - 金子（gold）：用户对某次已完成回答显式"采纳"，亲手铸概念把手，直接 confirmed。
 *
 * 只有 confirmed 判决会被注入新卡片的干净上下文（"干净但不失忆"）。
 * 本地 pt_verdicts 表是运行时权威；MemOS `papertable-verdicts` Cube 为
 * 治理与召回层，同步为 best-effort，不阻塞任何用户操作。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { httpError, nowIso, jsonObject, requireCard, requireRun, type DataStore } from "./data.ts";
import { activeConversation, closeSession, openSessionById, type SessionRepo } from "./sessions.ts";
import { callMemos } from "./memos.ts";

export const VERDICTS_CUBE = "papertable-verdicts";
const INJECTION_LIMIT = 24;
const LINE_LIMIT = 200;

export type VerdictRow = {
  id: string;
  project_id: string;
  card_id: string | null;
  run_id: string | null;
  kind: "tombstone" | "gold";
  text: string;
  handle: string | null;
  status: "proposed" | "confirmed" | "superseded";
  memos_status: string;
  created_at: string;
  updated_at: string;
};

export function ensureVerdictTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pt_verdicts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES pt_projects(id) ON DELETE CASCADE,
      card_id TEXT,
      run_id TEXT,
      kind TEXT NOT NULL CHECK(kind IN ('tombstone', 'gold')),
      text TEXT NOT NULL,
      handle TEXT,
      status TEXT NOT NULL CHECK(status IN ('proposed', 'confirmed', 'superseded')),
      memos_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pt_verdicts_project
      ON pt_verdicts(project_id, status, created_at);
  `);
}

export function listVerdicts(db: DatabaseSync, projectId: string): Array<Record<string, unknown>> {
  const rows = db.prepare(`
    SELECT * FROM pt_verdicts WHERE project_id = ? ORDER BY created_at DESC
  `).all(projectId) as VerdictRow[];
  return rows.map(publicVerdict);
}

export function publicVerdict(row: VerdictRow): Record<string, unknown> {
  return {
    id: row.id,
    projectId: row.project_id,
    cardId: row.card_id,
    runId: row.run_id,
    kind: row.kind,
    text: row.text,
    handle: row.handle,
    status: row.status,
    memosStatus: row.memos_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireVerdict(db: DatabaseSync, id: string): VerdictRow {
  const row = db.prepare("SELECT * FROM pt_verdicts WHERE id = ?").get(id) as VerdictRow | undefined;
  if (!row) throw httpError(404, "判决不存在");
  return row;
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, LINE_LIMIT);
}

/**
 * 改道钩子：立即用模板落一条 proposed 墓碑（同步、零模型依赖），
 * 然后后台用功能模型基于被砍历史润色草稿（best-effort）。
 */
export async function createTombstoneDraft(
  store: DataStore,
  sessions: SessionRepo,
  targetCardId: string,
): Promise<Record<string, unknown> | null> {
  const card = requireCard(store.db, targetCardId);
  if (card.branch_kind !== "reroute" || !card.source_card_id) return null;
  const context = jsonObject(card.branch_context_json);
  const replaced = oneLine(String(context.replacedQuestion || ""));
  const sourceTitle = oneLine(String(context.sourceTitle || ""));
  const id = randomUUID();
  const now = nowIso();
  const draft = oneLine(
    `用户否决了「${replaced || sourceTitle}」这条推进方向（于《${sourceTitle}》改道重来）`,
  );
  store.db.prepare(`
    INSERT INTO pt_verdicts(
      id, project_id, card_id, run_id, kind, text, handle, status, memos_status, created_at, updated_at
    ) VALUES(?, ?, ?, NULL, 'tombstone', ?, NULL, 'proposed', 'pending', ?, ?)
  `).run(id, card.project_id, targetCardId, draft, now, now);

  void polishTombstoneDraft(store, sessions, id, card.source_card_id, String(context.sourceEntryId || ""))
    .catch(() => undefined);

  const row = requireVerdict(store.db, id);
  return publicVerdict(row);
}

/** 后台润色：读取被砍掉的历史，请功能模型压缩成一行否决理由。 */
async function polishTombstoneDraft(
  store: DataStore,
  sessions: SessionRepo,
  verdictId: string,
  sourceCardId: string,
  sourceEntryId: string,
): Promise<void> {
  const baseUrl = process.env.PAPERTABLE_BASE_URL?.trim().replace(/\/v1\/?$/, "");
  const apiKey = process.env.PAPERTABLE_API_KEY?.trim();
  const model = process.env.PAPERTABLE_MODEL?.trim();
  if (!baseUrl || !apiKey || !model) return;

  const sourceCard = requireCard(store.db, sourceCardId);
  const session = await openSessionById(sessions, sourceCard.session_id, sourceCard.project_id);
  let cutHistory = "";
  try {
    const conversation = await activeConversation(session);
    const index = conversation.findIndex((entry) => entry.entryId === sourceEntryId);
    if (index >= 0) {
      cutHistory = conversation.slice(index)
        .map((entry) => `${entry.role === "user" ? "用户" : "AI"}: ${entry.text}`)
        .join("\n")
        .slice(0, 6_000);
    }
  } finally {
    await closeSession(session).catch(() => undefined);
  }
  if (!cutHistory) return;

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "user-agent": "Papertable/0.2",
    },
    body: JSON.stringify({
      model,
      max_tokens: 200,
      system: "用户刚刚在一段人机对话里执行了改道：砍掉后面这段历史、换方向重来。"
        + "请把被否决的方向压缩成一行中文墓碑，格式严格为：用户否决了<方向X>，因为<理由Y>。"
        + "不超过80字，只输出这一行，不要引号和解释。",
      messages: [{ role: "user", content: `被砍掉的历史：\n${cutHistory}` }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) return;
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  const content = Array.isArray(body.content) ? body.content : [];
  const text = oneLine(content
    .filter((block) => (block as Record<string, unknown>).type === "text")
    .map((block) => String((block as Record<string, unknown>).text || ""))
    .join(""));
  if (!text.startsWith("用户否决了")) return;
  // 只在用户尚未处理时更新草稿
  store.db.prepare(`
    UPDATE pt_verdicts SET text = ?, updated_at = ? WHERE id = ? AND status = 'proposed'
  `).run(text, nowIso(), verdictId);
}

export function confirmVerdict(
  store: DataStore,
  id: string,
  textOverride?: string,
): Record<string, unknown> {
  const row = requireVerdict(store.db, id);
  if (row.status === "superseded") throw httpError(409, "判决已被 supersede，不能再确认");
  const text = oneLine(textOverride || row.text);
  if (!text) throw httpError(400, "判决内容不能为空");
  store.db.prepare(`
    UPDATE pt_verdicts SET text = ?, status = 'confirmed', updated_at = ? WHERE id = ?
  `).run(text, nowIso(), id);
  void syncVerdictToMemos(store, id).catch(() => undefined);
  return publicVerdict(requireVerdict(store.db, id));
}

export function supersedeVerdict(store: DataStore, id: string): Record<string, unknown> {
  requireVerdict(store.db, id);
  // ADR 红线：只许 supersede 降级标记，不许删除——墓碑的失效本身是信息。
  store.db.prepare(`
    UPDATE pt_verdicts SET status = 'superseded', updated_at = ? WHERE id = ?
  `).run(nowIso(), id);
  return publicVerdict(requireVerdict(store.db, id));
}

/** 采纳金子：run 必须已完成；把手必须出自用户之手。 */
export function adoptRun(
  store: DataStore,
  runId: string,
  handleInput: string,
  textInput?: string,
): Record<string, unknown> {
  const run = requireRun(store.db, runId);
  if (run.result !== "completed" || !run.answer) {
    throw httpError(409, "只有已完成的回答才能被采纳为金子");
  }
  const handle = oneLine(handleInput);
  if (!handle) throw httpError(400, "必须亲手为这条金子铸一个概念把手");
  const fallback = firstSentence(run.answer);
  const text = oneLine(textInput || fallback);
  if (!text) throw httpError(400, "金子内容不能为空");
  const id = randomUUID();
  const now = nowIso();
  store.db.prepare(`
    INSERT INTO pt_verdicts(
      id, project_id, card_id, run_id, kind, text, handle, status, memos_status, created_at, updated_at
    ) VALUES(?, ?, ?, ?, 'gold', ?, ?, 'confirmed', 'pending', ?, ?)
  `).run(id, run.project_id, run.card_id, runId, text, handle, now, now);
  void syncVerdictToMemos(store, id).catch(() => undefined);
  return publicVerdict(requireVerdict(store.db, id));
}

function firstSentence(answer: string): string {
  const plain = answer.replace(/\[\[source:[^\]]+\]\]/g, "").replace(/\s+/gu, " ").trim();
  const match = plain.match(/^.{10,}?[。！？.!?]/u);
  return (match ? match[0] : plain).slice(0, LINE_LIMIT);
}

/**
 * 注入块：宿主拼装、模型无写入权。只取 confirmed，最多 INJECTION_LIMIT 条。
 */
export function verdictInjectionBlock(db: DatabaseSync, projectId: string): string {
  let rows: VerdictRow[] = [];
  try {
    rows = db.prepare(`
      SELECT * FROM pt_verdicts
      WHERE project_id = ? AND status = 'confirmed'
      ORDER BY created_at DESC LIMIT ${INJECTION_LIMIT}
    `).all(projectId) as VerdictRow[];
  } catch {
    return "";
  }
  if (rows.length === 0) return "";
  const gold = rows.filter((row) => row.kind === "gold");
  const tombstones = rows.filter((row) => row.kind === "tombstone");
  const lines: string[] = ["", "<verdict_ledger>", "以下是用户在本项目里已确认的判决，由宿主注入，模型不得修改或伪造："];
  if (gold.length > 0) {
    lines.push("已确认结论（金子）——可以直接作为已知锚点使用：");
    for (const row of gold) lines.push(`- [${row.handle}] ${row.text}`);
  }
  if (tombstones.length > 0) {
    lines.push("已否决方向（墓碑）——不要重新收敛到这些方向，除非用户明确要求重启：");
    for (const row of tombstones) lines.push(`- ${row.text}`);
  }
  lines.push("</verdict_ledger>");
  return lines.join("\n");
}

/** best-effort 同步到 MemOS 判决 Cube；失败只记录，不影响本地权威。 */
async function syncVerdictToMemos(store: DataStore, id: string): Promise<void> {
  const row = requireVerdict(store.db, id);
  const mark = (status: string) => {
    store.db.prepare("UPDATE pt_verdicts SET memos_status = ? WHERE id = ?").run(status.slice(0, 300), id);
  };
  try {
    const listed = await callMemos("list_cubes", {}, 2_500);
    const cubes = Array.isArray(listed.cubes) ? listed.cubes : [];
    if (!cubes.some((cube) => (cube as Record<string, unknown>).cube_id === VERDICTS_CUBE)) {
      await callMemos("create_cube", {
        cube_id: VERDICTS_CUBE,
        description: "Papertable 判决簿：用户确认的金子与墓碑，只许 supersede 不许删除",
      }, 5_000);
    }
    await callMemos("add_memory", {
      cube_id: VERDICTS_CUBE,
      memory: `[${row.kind === "gold" ? `金子:${row.handle}` : "墓碑"}] ${row.text}`,
      metadata: {
        client: "papertable",
        verdict_id: row.id,
        project_id: row.project_id,
        kind: row.kind,
        status: row.status,
      },
    }, 8_000);
    mark("submitted");
  } catch (error) {
    mark(`failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
