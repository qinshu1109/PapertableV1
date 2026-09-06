/**
 * POST /pw/api/action —— 人点按钮转发层。
 *
 * 只处理两类写：候选卡 挑/改挑/否；草稿 确认转正。
 * host 侧先记 source=human-click（本地 action 日志），再转发 4317；
 * 4317 侧缺省 actor=human，decided_by=human 由 DB 约束兜底。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type PwActionInput,
  type PwActionSuccess,
} from "../types.js";
import { pwFetch } from "./pw-client.js";

export interface ActionLogEntry {
  at: string;
  action: string;
  targetType: string;
  targetId: string;
  source: "human-click";
  upstream: string;
  ok: boolean;
  error?: string;
}

export type ActionLogger = (entry: ActionLogEntry) => void;

export async function handleAction(
  baseUrl: string,
  input: PwActionInput,
  log: ActionLogger = () => undefined,
): Promise<PwActionSuccess> {
  const action = input.action;
  const targetId = String(input.targetId ?? "").trim();
  if (!targetId) throw new Error("targetId 必填");

  let upstream = "";
  let body: Record<string, unknown> = {};
  let result: unknown;

  if (action === "pick" || action === "edit") {
    if (input.targetType && input.targetType !== "sieve_card") {
      throw new Error("pick/edit 只支持 sieve_card");
    }
    upstream = `/api/pw/sieve/cards/${encodeURIComponent(targetId)}/pick`;
    body = input.overrides ? { overrides: input.overrides } : {};
    result = await pwFetch(baseUrl, "POST", upstream, body);
  } else if (action === "reject") {
    if (input.targetType && input.targetType !== "sieve_card") {
      throw new Error("reject 只支持 sieve_card（草稿否决不在此按钮范围）");
    }
    upstream = `/api/pw/sieve/cards/${encodeURIComponent(targetId)}/reject`;
    body = { reason: input.reason ?? "" };
    result = await pwFetch(baseUrl, "POST", upstream, body);
  } else if (action === "confirm") {
    if (input.targetType && input.targetType !== "draft") {
      throw new Error("confirm 只支持 draft");
    }
    upstream = `/api/pw/drafts/${encodeURIComponent(targetId)}/confirm`;
    body = input.edits ? { edits: input.edits } : {};
    result = await pwFetch(baseUrl, "POST", upstream, body);
  } else {
    throw new Error(`未知 action：${String(action)}`);
  }

  log({
    at: new Date().toISOString(),
    action,
    targetType: input.targetType ?? (action === "confirm" ? "draft" : "sieve_card"),
    targetId,
    source: "human-click",
    upstream,
    ok: true,
  });

  return { ok: true, action, source: "human-click", result };
}

export function appendActionLog(dataDir: string | undefined, entry: ActionLogEntry): void {
  try {
    const root = dataDir?.trim()
      || process.env.DSH_HOME?.trim()
      || join(homedir(), ".dsh");
    const dir = join(root, "papertable", "dsh-paperweight");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "actions.jsonl"), JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // 日志失败不阻断人按钮动作
  }
}
