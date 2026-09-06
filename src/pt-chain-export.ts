/** PW-62：项目决策链草稿与人工确认后的 Memos 官方 API 导出。 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { contentText } from "@earendil-works/pi-ai";
import { httpError, requireProject, type DataStore } from "./data.ts";
import { recordPwEvent } from "./pw-runs.ts";
import { createDeepSeekProvider } from "./provider-settings.ts";

export type ChainSummary = { projectName: string; question: string; branches: Array<{ at: string; kind: string; label: string }>; golds: string[]; tombstones: string[]; conclusion: string; markdown: string };
type SummaryLlm = (prompt: string, retry: boolean) => Promise<string>;
type ExportOptions = { configPath?: string; fetchImpl?: typeof fetch; timeoutMs?: number };
const summaryCaches = new WeakMap<DatabaseSync, Map<string, { expiresAt: number; value: ChainSummary }>>();

export async function generateChainSummary(store: DataStore, projectId: string, options: { llm?: SummaryLlm; now?: Date } = {}): Promise<ChainSummary> {
  const project = requireProject(store.db, projectId);
  const summaryCache = summaryCaches.get(store.db) ?? new Map<string, { expiresAt: number; value: ChainSummary }>();
  summaryCaches.set(store.db, summaryCache);
  const cached = summaryCache.get(projectId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const cards = store.db.prepare("SELECT id,title,branch_kind,source_card_id,created_at FROM pt_cards WHERE project_id=? ORDER BY created_at,id").all(projectId);
  const edges = store.db.prepare("SELECT source_card_id,target_card_id,kind,snapshot_json,created_at FROM pt_edges WHERE project_id=? ORDER BY created_at,id").all(projectId);
  const verdicts = store.db.prepare("SELECT kind,text,created_at FROM pt_verdicts WHERE project_id=? AND status='confirmed' ORDER BY created_at,id").all(projectId);
  const runs = store.db.prepare("SELECT card_id,question,status,result,reason,answer,error,created_at,ended_at FROM pt_runs WHERE project_id=? ORDER BY created_at,id").all(projectId);
  const prompt = ["请把项目决策链整理成 JSON 草稿。只返回 JSON，不要代码围栏。", "字段必须为 question, branches:[{at,kind,label}], golds:string[], tombstones:string[], conclusion。", "忠于数据；缺失内容用空字符串或空数组，不能编造。", JSON.stringify({ projectName: project.name, cards, edges, verdicts, runs })].join("\n");
  const llm = options.llm ?? defaultSummaryLlm(store.dataDir);
  let parsed: ParsedSummary;
  try {
    parsed = parseSummary(await llm(prompt, false));
  } catch {
    parsed = parseSummary(await llm(prompt, true));
  }
  const day = (options.now ?? new Date()).toISOString().slice(0, 10);
  const value: ChainSummary = {
    projectName: project.name,
    ...parsed,
    markdown: parsed.markdown || renderMarkdown(project.name, parsed, day, projectId),
  };
  summaryCache.set(projectId, { expiresAt: Date.now() + 5 * 60_000, value });
  return value;
}

export async function exportChainToMemos(db: DatabaseSync, projectId: string, markdownRaw: unknown, options: ExportOptions = {}): Promise<{ memoUrl: string; memoUid: string; reused: boolean }> {
  requireProject(db, projectId);
  const markdown = typeof markdownRaw === "string" ? markdownRaw.trim() : "";
  if (!markdown) throw httpError(400, "markdown 不能为空");
  const key = `${projectId}:${createHash("sha1").update(markdown, "utf8").digest("hex")}`;
  const previous = findExport(db, key);
  if (previous) return { ...previous, reused: true };
  const config = readMemosConfig(options.configPath);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`${config.memosUrl}/api/v1/memos`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.memosToken}` }, body: JSON.stringify({ content: markdown, visibility: "PRIVATE" }), signal: AbortSignal.timeout(options.timeoutMs ?? 15_000) });
  } catch (error) {
    throw httpError(502, `Memos 不可达：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw httpError(502, `Memos 写入失败 ${response.status}：${(await response.text()).slice(0, 200)}`);
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  const memoUid = memoIdentity(body);
  if (!memoUid) throw httpError(502, "Memos 写入成功但响应缺少 memo id");
  const memoUrl = `${config.memosUrl}/m/${encodeURIComponent(memoUid)}`;
  recordPwEvent(db, { kind: "pt_chain_export", eventType: "confirm", actor: "system", payloadJson: JSON.stringify({ projectId, memoUid, memoUrl, idempotencyKey: key }), relatedIds: [projectId, memoUid] });
  return { memoUrl, memoUid, reused: false };
}

function defaultSummaryLlm(dataDir: string): SummaryLlm {
  return async (prompt, retry) => {
    const provider = createDeepSeekProvider(dataDir);
    const systemPrompt = [
      "你是忠实的决策链整理员，只输出 JSON。",
      retry ? "上一次输出无法解析，本次只输出 JSON 对象，禁止任何其他字符" : "",
    ].filter(Boolean).join("\n");
    const response = await provider.models.completeSimple(provider.model, { systemPrompt, messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] }, { maxTokens: 4_000, maxRetries: 0 });
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw httpError(502, response.errorMessage || `DeepSeek 决策链调用失败：${response.stopReason}`);
    }
    return contentText(response.content);
  };
}

type ParsedSummary = Omit<ChainSummary, "projectName">;

export function parseChainSummary(raw: string): ParsedSummary {
  return parseSummary(raw);
}

function parseSummary(raw: string): ParsedSummary {
  let value: unknown;
  const text = raw.trim();
  const fenced = text.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  const candidates = [text, fenced, firstBrace >= 0 && lastBrace > firstBrace ? text.slice(firstBrace, lastBrace + 1) : ""];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { value = JSON.parse(candidate); break; } catch { /* 按裸 JSON → 围栏 → 首尾对象顺序继续。 */ }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(502, `DeepSeek 返回的决策链不是合法 JSON：${[...text].slice(0, 120).join("")}`);
  }
  const row = value as Record<string, unknown>;
  return { question: stringValue(row.question), branches: Array.isArray(row.branches) ? row.branches.flatMap((item) => { if (!item || typeof item !== "object" || Array.isArray(item)) return []; const branch = item as Record<string, unknown>; return [{ at: stringValue(branch.at), kind: stringValue(branch.kind), label: stringValue(branch.label) }]; }) : [], golds: stringArray(row.golds), tombstones: stringArray(row.tombstones), conclusion: stringValue(row.conclusion), markdown: stringValue(row.markdown) };
}

function renderMarkdown(projectName: string, value: Omit<ChainSummary, "projectName" | "markdown">, day: string, projectId: string): string {
  const list = (items: string[]) => items.length ? items.map((item) => `- ${item}`).join("\n") : "- 无";
  const branches = value.branches.length ? value.branches.map((item) => `- ${item.at} · ${item.kind}：${item.label}`).join("\n") : "- 无";
  return `# ${projectName}\n\n#决策链\n生成日期：${day}\n回链：papertable://projects/${projectId}\n\n## 最初问题\n${value.question || "未记录"}\n\n## 关键分叉与改道\n${branches}\n\n## 金子\n${list(value.golds)}\n\n## 墓碑\n${list(value.tombstones)}\n\n## 结论\n${value.conclusion || "尚无结论"}`;
}

function readMemosConfig(path = join(homedir(), "Library", "Application Support", "Papertable", "feishu-relay.json")): { memosUrl: string; memosToken: string } {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch (error) { throw httpError(501, `Memos 写入配置不可用：${error instanceof Error ? error.message : String(error)}`); }
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const memosUrl = stringValue(row.memosUrl).replace(/\/+$/u, "");
  const memosToken = stringValue(row.memosToken);
  if (!memosUrl || !memosToken) throw httpError(501, "Memos 写入配置不可用：feishu-relay.json 缺 memosUrl 或 memosToken");
  return { memosUrl, memosToken };
}

function findExport(db: DatabaseSync, key: string): { memoUrl: string; memoUid: string } | null {
  const rows = db.prepare("SELECT payload_json FROM pw_runs WHERE kind='pt_chain_export' ORDER BY created_at DESC,rowid DESC").all() as Array<{ payload_json: string }>;
  for (const row of rows) { try { const payload = JSON.parse(row.payload_json) as Record<string, unknown>; if (payload.idempotencyKey === key && typeof payload.memoUrl === "string" && typeof payload.memoUid === "string") return { memoUrl: payload.memoUrl, memoUid: payload.memoUid }; } catch { /* 损坏审计不阻塞重试。 */ } }
  return null;
}

function memoIdentity(body: Record<string, unknown>): string { if (typeof body.uid === "string" && body.uid) return body.uid; if (typeof body.name === "string" && body.name) return body.name.split("/").at(-1) ?? ""; if (typeof body.id === "number" || typeof body.id === "string") return String(body.id); return ""; }
function stringValue(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.map(stringValue).filter(Boolean) : []; }
