/**
 * session-start 动态 notice：同步抢 idle → 4s 总预算拉数 → inject plugin notice。
 * 失败降级，不抛、不闩死首轮。
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { PwHostDeps } from "../types.js";
import {
  fetchBets,
  fetchConnections,
  fetchDrafts,
  fetchDueBets,
  fetchSieveCards,
  fetchVerdictRows,
} from "./pw-client.js";
import { PushStore } from "./push.js";
import {
  NOTICE_BUDGET_MS,
  buildDegradedNotice,
  buildSuccessNotice,
  type NoticeResult,
  type NoticeSnapshot,
  type NoticeVerdictRow,
} from "./notice-format.js";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function warn(text: string): void {
  console.warn(`[dsh-paperweight] ${text}`);
}

export async function collectNoticeSnapshot(
  baseUrl: string,
  push: PushStore,
  signal?: AbortSignal,
): Promise<NoticeSnapshot> {
  if (signal?.aborted) throw new Error("timeout 4s");
  const throwIfAborted = (): void => {
    if (signal?.aborted) throw new Error("timeout 4s");
  };
  const results = await Promise.allSettled([
    fetchBets(baseUrl, "pending", signal),
    fetchDueBets(baseUrl, signal),
    Promise.resolve(push.list()),
    fetchVerdictRows(baseUrl, signal),
    fetchDrafts(baseUrl, signal),
    fetchSieveCards(baseUrl, "pending", signal),
    fetchConnections(baseUrl, signal),
  ]);
  throwIfAborted();
  const value = <T>(index: number): T | null => {
    const result = results[index];
    return result?.status === "fulfilled" ? result.value as T : null;
  };
  const pending = value<Awaited<ReturnType<typeof fetchBets>>>(0);
  const due = value<Awaited<ReturnType<typeof fetchDueBets>>>(1);
  const pushFeed = value<ReturnType<PushStore["list"]>>(2) ?? { items: [], unread: 0 };
  const verdicts = value<Awaited<ReturnType<typeof fetchVerdictRows>>>(3);
  const drafts = value<Awaited<ReturnType<typeof fetchDrafts>>>(4);
  const sieve = value<Awaited<ReturnType<typeof fetchSieveCards>>>(5);
  const connections = value<Awaited<ReturnType<typeof fetchConnections>>>(6);
  const anyOk = [pending, due, verdicts, drafts, sieve, connections].some((item) => item !== null);
  if (!anyOk) throw new Error("4317 全部未取到");
  return {
    pending,
    due,
    drafts: drafts ? { length: drafts.length } : null,
    sievePending: sieve ? { length: sieve.length } : null,
    connections: connections
      ? connections.map((conn: any) => ({
        id: String(conn.id),
        platform: String(conn.platform ?? conn.id),
        status: String(conn.status ?? ""),
      }))
      : null,
    verdicts: verdicts as NoticeVerdictRow[] | null,
    push: pushFeed,
  };
}

export function injectNotice(agent: { inject(message: unknown): void }, notice: NoticeResult): void {
  agent.inject(createUserMessage({
    content: [{ type: "text", text: notice.text }],
    source: {
      kind: "plugin",
      plugin: "dsh-paperweight",
      form: "notice",
      summary: notice.summary,
    },
  }));
}

async function seedNotice(
  baseUrl: string,
  push: PushStore,
  agent: { inject(message: unknown): void },
  signal: AbortSignal,
): Promise<void> {
  let notice: NoticeResult;
  try {
    const snapshot = await collectNoticeSnapshot(baseUrl, push, signal);
    notice = buildSuccessNotice(snapshot);
  } catch (error) {
    const reason = signal.aborted ? "timeout 4s" : messageOf(error);
    notice = buildDegradedNotice(reason);
  }
  try {
    injectNotice(agent, notice);
  } catch (error) {
    warn(`notice injection failed: ${messageOf(error)}`);
  }
}

export function registerSessionNotice(ctx: any, deps: PwHostDeps, push: PushStore): void {
  const baseUrl = deps.baseUrl || "http://127.0.0.1:4317";
  if (typeof ctx.on !== "function") return;

  ctx.effect(() => ctx.on("agent/session-start", ({ agent }: { agent: { runMaintenance?: (task: (signal: AbortSignal) => Promise<void>) => Promise<void>; inject(message: unknown): void } }) => {
    const task = (signal: AbortSignal) => seedNotice(
      baseUrl,
      push,
      agent,
      AbortSignal.any([signal, AbortSignal.timeout(NOTICE_BUDGET_MS)]),
    );
    let settledTask: Promise<void>;
    try {
      if (typeof agent.runMaintenance !== "function") throw new Error("runMaintenance missing");
      settledTask = agent.runMaintenance(task);
    } catch {
      settledTask = task(AbortSignal.timeout(NOTICE_BUDGET_MS));
    }
    settledTask.catch((error: unknown) => warn(`session-start notice failed: ${messageOf(error)}`));
  }), "dsh-paperweight: session-start notice");
}
