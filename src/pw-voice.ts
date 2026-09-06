import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { recordPwEvent, recordPwExecEvent } from "./pw-runs.ts";

export type PwVoiceSignalType =
  | "topic_lead"
  | "content_critique"
  | "form_suggestion"
  | "noise";

export type PwVoiceInput = {
  platform: string;
  content: string;
  capturedAt?: string;
  captured_at?: string;
  author?: string;
  authorNickname?: string;
  author_nickname?: string;
  authorName?: string;
  author_name?: string;
  artifactId?: string | null;
  artifact_id?: string | null;
  [key: string]: unknown;
};

export type PwVoiceRow = {
  id: string;
  artifact_id: string | null;
  platform: string;
  author_hash: string;
  content: string;
  captured_at: string;
  signal_type: PwVoiceSignalType | null;
  cluster_id: string | null;
  promoted_to_draft_id: string | null;
  dropped_reason: string | null;
  created_at: string;
};

export type PwVoiceLlm = (prompt: string) => Promise<string>;

// TASK-PW-26：声音分拣自动挂钩——录入后同步触发（不 await），后台事，失败绝不拖垮录入。
// 接线（哪个分类器、LLM 从哪来）由主代理在 main.ts 注册；分拣本体仍是 classifyPwVoiceItems。
let autoClassifier: ((db: DatabaseSync, ids: string[]) => void) | null = null;

export function setPwVoiceAutoClassifier(
  fn: ((db: DatabaseSync, ids: string[]) => void) | null,
): void {
  autoClassifier = fn;
}

const SIGNAL_TYPES: readonly PwVoiceSignalType[] = [
  "topic_lead",
  "content_critique",
  "form_suggestion",
  "noise",
];

export function ensurePwVoiceTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pw_voice_items (
      id TEXT PRIMARY KEY,
      artifact_id TEXT,
      platform TEXT NOT NULL,
      author_hash TEXT NOT NULL,
      content TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      signal_type TEXT CHECK(signal_type IN (
        'topic_lead', 'content_critique', 'form_suggestion', 'noise'
      ) OR signal_type IS NULL),
      cluster_id TEXT,
      promoted_to_draft_id TEXT,
      dropped_reason TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

/** TASK-PW-24：AI 执行审计——传入后本函数改走 recordPwExecEvent 合成一条 ai_exec(voice) 账。 */
export type PwVoiceAudit = {
  actor: "ai";
  instructionText: string;
  instructionMessageId: string;
};

export function addPwVoiceItem(
  db: DatabaseSync,
  input: PwVoiceInput,
  audit?: PwVoiceAudit,
): PwVoiceRow {
  const platform = requiredText(input.platform, "platform");
  const content = requiredText(input.content, "content");
  const capturedAt = requiredText(input.capturedAt ?? input.captured_at, "captured_at");
  const author = requiredText(
    input.author ?? input.authorNickname ?? input.author_nickname
      ?? input.authorName ?? input.author_name,
    "author",
  );
  const artifactId = optionalText(input.artifactId ?? input.artifact_id);
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const authorHash = createHash("sha256").update(author, "utf8").digest("hex");

  db.prepare(`
    INSERT INTO pw_voice_items(
      id, artifact_id, platform, author_hash, content, captured_at,
      signal_type, cluster_id, promoted_to_draft_id, dropped_reason, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)
  `).run(id, artifactId, platform, authorHash, content, capturedAt, createdAt);
  if (audit) {
    // TASK-PW-24：AI 经 exec 工具录入——合成一条 ai_exec(voice) 账，不记 manual_event
    recordPwExecEvent(db, {
      eventType: "voice",
      instructionText: audit.instructionText,
      instructionMessageId: audit.instructionMessageId,
      payloadJson: JSON.stringify({ voiceId: id, artifactId, platform }),
    });
  } else {
    // TASK-PW-23：观众声音录入记账（actor=human）
    recordPwEvent(db, {
      eventType: "voice",
      actor: "human",
      payloadJson: JSON.stringify({ voiceId: id, artifactId, platform }),
    });
  }
  // TASK-PW-26：声音分拣自动挂钩——同步触发、不 await；spy 抛错/分拣失败只让条目保持未分拣。
  if (autoClassifier) {
    try {
      autoClassifier(db, [id]);
    } catch {
      // 分拣是后台事，绝不拖垮录入；审后不设自动废弃，drop 仍只能人做。
    }
  }
  return requirePwVoiceItem(db, id);
}

export async function classifyPwVoiceItems(
  db: DatabaseSync,
  ids: readonly string[],
  llmFn: PwVoiceLlm,
): Promise<PwVoiceRow[]> {
  const requestedIds = [...new Set(ids)];
  if (requestedIds.length === 0) return [];

  const rows = db.prepare(`
    SELECT * FROM pw_voice_items
    WHERE id IN (${requestedIds.map(() => "?").join(", ")})
    ORDER BY created_at, id
  `).all(...requestedIds) as PwVoiceRow[];
  if (rows.length === 0) return [];

  const prompt = [
    "请将以下观众评论分拣为一个信号类型，并给出简短 cluster 标签。",
    `signal_type 只能是: ${SIGNAL_TYPES.join(", ")}；拿不准时返回 null（留未分拣），禁止硬标。`,
    "判定标准：",
    "  - topic_lead=可拍的选题线索（含使用体验对比、踩坑、价格/选型讨论、求测求更）；",
    "  - content_critique=对内容的批评；",
    "  - form_suggestion=对形式/节奏/封面的建议；",
    "  - noise=纯灌水/广告/无信息/表情包。",
    "对照示例：「自从用过 trae 后，感觉这些兴起的 ide 都比 cursor 差远了[笑哭]」→ topic_lead（使用体验对比是选题素材，不算噪音）。",
    "只返回 JSON 数组，每项必须包含 id、signal_type、cluster；不要输出 Markdown。",
    JSON.stringify(rows.map((row) => ({ id: row.id, content: row.content }))),
  ].join("\n");

  const updates = new Map<string, { signalType: PwVoiceSignalType | null; clusterId: string | null }>(
    rows.map((row) => [row.id, { signalType: null, clusterId: null }]),
  );
  try {
    const result = parseClassifications(await llmFn(prompt));
    const knownIds = new Set(updates.keys());
    for (const item of result) {
      if (!isRecord(item) || typeof item.id !== "string" || !knownIds.has(item.id)) continue;
      const signalType = item.signal_type ?? item.signalType;
      if (!isSignalType(signalType)) continue;
      const cluster = item.cluster ?? item.cluster_id ?? item.clusterId;
      updates.set(item.id, {
        signalType,
        clusterId: typeof cluster === "string" && cluster.trim() ? cluster : null,
      });
    }
  } catch {
    // 解析失败只让本批保持未分拣，不阻断手动录入或其他条目。
  }

  const update = db.prepare(`
    UPDATE pw_voice_items SET signal_type = ?, cluster_id = ? WHERE id = ?
  `);
  let classified = 0;
  let failed = 0;
  for (const [id, value] of updates) {
    update.run(value.signalType, value.clusterId, id);
    if (value.signalType) classified += 1;
    else failed += 1;
  }
  // TASK-PW-23：观众声音 LLM 分拣记账（actor=system；classified=分拣成功数，failed=未分拣数）
  recordPwEvent(db, {
    eventType: "classify",
    actor: "system",
    payloadJson: JSON.stringify({ classified, failed }),
  });
  return rows.map((row) => requirePwVoiceItem(db, row.id));
}

export function dropPwVoiceItem(db: DatabaseSync, id: string, reason: string): PwVoiceRow {
  const droppedReason = requiredText(reason, "reason");
  const result = db.prepare(`
    UPDATE pw_voice_items SET dropped_reason = ? WHERE id = ?
  `).run(droppedReason, id);
  if (Number(result.changes) !== 1) throw new Error(`观众声音不存在: ${id}`);
  // TASK-PW-23：观众声音软丢弃记账（actor=human）
  recordPwEvent(db, {
    eventType: "drop",
    actor: "human",
    payloadJson: JSON.stringify({ voiceId: id, reason: droppedReason }),
  });
  return requirePwVoiceItem(db, id);
}

export function listPwVoiceItems(
  db: DatabaseSync,
  options: { signalType?: PwVoiceSignalType; unprocessed?: boolean } = {},
): PwVoiceRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.signalType !== undefined) {
    if (!isSignalType(options.signalType)) throw new Error("无效的 signalType");
    clauses.push("signal_type = ?");
    params.push(options.signalType);
  }
  if (options.unprocessed) clauses.push("signal_type IS NULL");
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`
    SELECT * FROM pw_voice_items
    ${where}
    ORDER BY created_at, id
  `).all(...params) as PwVoiceRow[];
}

function parseClassifications(raw: string): unknown[] {
  const unwrapped = raw.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const parsed: unknown = JSON.parse(unwrapped);
  if (Array.isArray(parsed)) return parsed;
  if (isRecord(parsed) && Array.isArray(parsed.items)) return parsed.items;
  throw new Error("分拣结果不是数组");
}

function requirePwVoiceItem(db: DatabaseSync, id: string): PwVoiceRow {
  const row = db.prepare("SELECT * FROM pw_voice_items WHERE id = ?").get(id) as PwVoiceRow | undefined;
  if (!row) throw new Error(`观众声音不存在: ${id}`);
  return row;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 必填`);
  return value;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isSignalType(value: unknown): value is PwVoiceSignalType {
  return typeof value === "string" && SIGNAL_TYPES.includes(value as PwVoiceSignalType);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
