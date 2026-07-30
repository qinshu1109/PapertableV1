import { createHash } from "node:crypto";
import { appendFile, stat } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { DataStore } from "./data.ts";
import { jsonObject, nowIso, requireCard } from "./data.ts";
import type { PapertableEngine } from "./engine.ts";
import {
  activeConversation,
  closeSession,
  openSessionById,
  type SessionRepo,
} from "./sessions.ts";

const MEMOS_BASE_URL = "http://127.0.0.1:8002";
const KNOWLEDGE_CUBE = "knowledge-universe";

export class MemoryBridge {
  #store: DataStore;
  #sessions: SessionRepo;
  #engine: PapertableEngine;

  constructor(store: DataStore, sessions: SessionRepo, engine: PapertableEngine) {
    this.#store = store;
    this.#sessions = sessions;
    this.#engine = engine;
  }

  async initialize(): Promise<{ available: boolean; error?: string }> {
    try {
      const listed = await callMemos("list_cubes", {}, 2_500);
      const cubes = Array.isArray(listed.cubes) ? listed.cubes : [];
      if (!cubes.some((cube) => asRecord(cube).cube_id === KNOWLEDGE_CUBE)) {
        await callMemos("create_cube", {
          cube_id: KNOWLEDGE_CUBE,
          name: "Papertable 知识宇宙",
          description: "从 Papertable 的完整追问链和深挖、发散、改道行为中提取的概念与关联；一次性浅问默认不写入。",
          max_memories: 4000,
        }, 2_500);
      }
      void this.retryPending().catch(() => undefined);
      return { available: true };
    } catch (error) {
      return { available: false, error: safeMessage(error) };
    }
  }

  async stageCard(cardId: string, reason: string): Promise<{
    status: "submitted" | "pending" | "unchanged";
    stageKey: string;
    error?: string;
  }> {
    const card = requireCard(this.#store.db, cardId);
    const running = this.#store.db.prepare(`
      SELECT id FROM pt_runs
      WHERE card_id = ? AND status = 'running'
      LIMIT 1
    `).get(cardId) as { id: string } | undefined;
    if (running) {
      return {
        status: "unchanged",
        stageKey: stageIdentity(card.id, running.id, "running_deferred"),
      };
    }
    const session = await openSessionById(this.#sessions, card.session_id, card.project_id);
    try {
      const leafId = await session.getLeafId();
      const messages = await activeConversation(session);
      const edgeCount = Number((this.#store.db.prepare(`
        SELECT COUNT(*) AS count FROM pt_edges
        WHERE source_card_id = ? OR target_card_id = ?
      `).get(cardId, cardId) as { count: number }).count);
      const followUpDepth = Math.max(0, messages.filter((message) => message.role === "user").length - 1);
      const stageKey = stageIdentity(card.id, leafId, `${followUpDepth}:${edgeCount}`);
      const existing = this.#store.db.prepare(
        "SELECT status, error FROM pt_stage_exports WHERE stage_key = ?",
      ).get(stageKey) as { status: "pending" | "submitted"; error: string | null } | undefined;
      if (existing?.status === "submitted") return { status: "unchanged", stageKey };
      if (!existing) {
        const edgeRows = this.#store.db.prepare(`
          SELECT kind, snapshot_json, created_at
          FROM pt_edges
          WHERE source_card_id = ? OR target_card_id = ?
          ORDER BY created_at
        `).all(cardId, cardId) as Array<{
          kind: string;
          snapshot_json: string;
          created_at: string;
        }>;
        const citations = this.#store.db.prepare(`
          SELECT e.payload_json
          FROM pt_run_events e
          JOIN pt_runs r ON r.id = e.run_id
          WHERE r.card_id = ? AND r.result = 'completed' AND e.event_type = 'citation_resolved'
          ORDER BY e.created_at
        `).all(cardId) as Array<{ payload_json: string }>;
        const completedTurns = this.#store.db.prepare(`
          SELECT COUNT(*) AS count FROM pt_runs
          WHERE card_id = ? AND result = 'completed'
        `).get(cardId) as { count: number };
        const packageValue = {
          schemaVersion: 1,
          client: "papertable",
          memoryMode: process.env.PAPERTABLE_MEMORY_MODE === "acceptance"
            ? "acceptance"
            : "production",
          projectId: card.project_id,
          card: {
            id: card.id,
            title: card.title,
            kind: card.branch_kind,
            sourceCardId: card.source_card_id,
            branchContext: jsonObject(card.branch_context_json),
          },
          phase: {
            reason,
            completedTurns: Number(completedTurns.count),
            followUpDepth,
            branchCount: edgeRows.length,
          },
          messages,
          relations: edgeRows.map((row) => ({
            kind: row.kind,
            snapshot: jsonObject(row.snapshot_json),
            createdAt: row.created_at,
          })),
          citations: citations.map((row) => jsonObject(row.payload_json)),
          stagedAt: nowIso(),
        };
        const transcriptPath = `${this.#store.stagesDir}/${card.id}.jsonl`;
        await appendFile(transcriptPath, `${JSON.stringify(packageValue)}\n`, { encoding: "utf8", mode: 0o600 });
        const transcriptOffset = (await stat(transcriptPath)).size;
        this.#store.db.prepare(`
          INSERT INTO pt_stage_exports(
            stage_key, project_id, card_id, transcript_path, transcript_offset,
            status, reason, error, created_at, submitted_at
          ) VALUES(?, ?, ?, ?, ?, 'pending', ?, NULL, ?, NULL)
        `).run(
          stageKey,
          card.project_id,
          card.id,
          transcriptPath,
          transcriptOffset,
          reason,
          nowIso(),
        );
      }
      return await this.submitStage(stageKey);
    } finally {
      await closeSession(session);
    }
  }

  async retryPending(): Promise<number> {
    const rows = this.#store.db.prepare(`
      SELECT stage_key FROM pt_stage_exports
      WHERE status = 'pending'
      ORDER BY created_at
      LIMIT 100
    `).all() as Array<{ stage_key: string }>;
    for (const row of rows) await this.submitStage(row.stage_key);
    return rows.length;
  }

  async stageIdleCards(): Promise<number> {
    const rows = this.#store.db.prepare(`
      SELECT id FROM pt_cards
      WHERE julianday(updated_at) <= julianday('now', '-30 minutes')
      ORDER BY updated_at
    `).all() as Array<{ id: string }>;
    let staged = 0;
    for (const row of rows) {
      const result = await this.stageCard(row.id, "idle_30_minutes").catch(() => undefined);
      if (result && result.status !== "unchanged") staged += 1;
    }
    return staged;
  }

  async knowledgeUniverse(): Promise<Record<string, unknown>> {
    const pending = this.#store.db.prepare(
      "SELECT COUNT(*) AS count FROM pt_stage_exports WHERE status = 'pending'",
    ).get() as { count: number };
    try {
      const [graphResponse, statusResponse, candidatesResponse, cubeStats] = await Promise.all([
        fetch(`${MEMOS_BASE_URL}/ui/api/graph?cube_id=${KNOWLEDGE_CUBE}&limit=200`, {
          signal: AbortSignal.timeout(5_000),
        }),
        fetch(`${MEMOS_BASE_URL}/ui/api/brain/status`, {
          signal: AbortSignal.timeout(5_000),
        }),
        fetch(`${MEMOS_BASE_URL}/ui/api/hot/candidates?limit=500`, {
          signal: AbortSignal.timeout(5_000),
        }),
        callMemos("get_cube_stats", { cube_id: KNOWLEDGE_CUBE }, 5_000),
      ]);
      if (!graphResponse.ok || !statusResponse.ok || !candidatesResponse.ok) {
        throw new Error("MemOS knowledge-universe endpoints are unavailable");
      }
      const candidatesBody = asRecord(await candidatesResponse.json());
      const pendingCandidates = Array.isArray(candidatesBody.items)
        ? candidatesBody.items.filter((item) => {
          const candidate = asRecord(item);
          return candidate.client === "papertable"
            && candidate.cube_id === KNOWLEDGE_CUBE
            && candidate.status === "pending";
        }).length
        : 0;
      const stats = Array.isArray(cubeStats.stats)
        ? asRecord(cubeStats.stats[0])
        : {};
      return {
        available: true,
        cubeId: KNOWLEDGE_CUBE,
        pendingStages: Number(pending.count),
        pendingCandidates,
        memoryCount: Number(stats.count || 0),
        graph: await graphResponse.json(),
        brain: await statusResponse.json(),
      };
    } catch (error) {
      return {
        available: false,
        cubeId: KNOWLEDGE_CUBE,
        pendingStages: Number(pending.count),
        pendingCandidates: 0,
        memoryCount: 0,
        error: safeMessage(error),
      };
    }
  }

  async reconcileCuratedKnowledge(): Promise<Record<string, unknown>> {
    return callMemos("reconcile_curated_knowledge", {}, 60_000);
  }

  private async submitStage(stageKey: string): Promise<{
    status: "submitted" | "pending";
    stageKey: string;
    error?: string;
  }> {
    const row = this.#store.db.prepare(`
      SELECT s.*, c.session_id
      FROM pt_stage_exports s
      JOIN pt_cards c ON c.id = s.card_id
      WHERE s.stage_key = ?
    `).get(stageKey) as {
      project_id: string;
      card_id: string;
      transcript_path: string;
      transcript_offset: number;
      session_id: string;
    } | undefined;
    if (!row) throw new Error("Stage export not found");
    try {
      const response = await fetch(`${MEMOS_BASE_URL}/hooks/v1/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client: "papertable",
          session_id: `papertable:${row.session_id}`,
          event_type: "SessionEnd",
          transcript_path: row.transcript_path,
          transcript_offset: row.transcript_offset,
          fingerprint: stageKey,
        }),
        signal: AbortSignal.timeout(2_500),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || asRecord(body).accepted !== true) {
        throw new Error(String(asRecord(body).message || `MemOS hook returned HTTP ${response.status}`));
      }
      this.#store.db.prepare(`
        UPDATE pt_stage_exports
        SET status = 'submitted', error = NULL, submitted_at = ?
        WHERE stage_key = ?
      `).run(nowIso(), stageKey);
      this.emitStageStatus(row.card_id, { status: "submitted", stageKey });
      return { status: "submitted", stageKey };
    } catch (error) {
      const message = safeMessage(error);
      this.#store.db.prepare(`
        UPDATE pt_stage_exports SET status = 'pending', error = ? WHERE stage_key = ?
      `).run(message, stageKey);
      this.emitStageStatus(row.card_id, { status: "pending", stageKey, error: message });
      return { status: "pending", stageKey, error: message };
    }
  }

  private emitStageStatus(cardId: string, payload: Record<string, unknown>): void {
    const run = this.#store.db.prepare(`
      SELECT id FROM pt_runs WHERE card_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(cardId) as { id: string } | undefined;
    if (run) this.#engine.emitProductEvent(run.id, "memory_stage_status", payload);
  }
}

export function stageIdentity(cardId: string, leafId: string | null, behavior = ""): string {
  return createHash("sha256")
    .update(`${cardId}\0${leafId ?? "empty"}\0${behavior}`)
    .digest("hex");
}

export async function callMemos(
  name: string,
  args: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const client = new Client({ name: "papertable", version: "0.2.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${MEMOS_BASE_URL}/mcp`),
    { requestInit: { signal: AbortSignal.timeout(timeoutMs) } },
  );
  try {
    await client.connect(transport);
    const result = await client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: timeoutMs },
    );
    if (result.isError) throw new Error(mcpText(result.content) || `${name} failed`);
    const text = mcpText(result.content);
    const parsed: unknown = text ? JSON.parse(text) : {};
    return asRecord(parsed);
  } finally {
    await transport.close().catch(() => undefined);
  }
}

function mcpText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => asRecord(item).type === "text")
    .map((item) => String(asRecord(item).text || ""))
    .join("");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 600);
}
