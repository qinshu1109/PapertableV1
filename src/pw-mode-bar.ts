/**
 * TASK-PW-14（简报 14）：协作台「模式与对账条」只读聚合接口。
 * 系统视角的对账条：把系统自己已经知道的待办与动态聚合成一个只读 GET，供协作台顶部
 * slim 状态条消费。外部 agent（herdr 窗口）的实时状态系统不知道，本接口不假装知道。
 *
 * 口径（简报 14 验收注明，写进模块注释）：
 * - pendingReview 三类只数「待处理」状态：押注草稿 = pw_bets.status='draft'
 *   （listPwBetDrafts）、结账草稿 = pw_settle_drafts.status='pending'
 *   （listPwSettleDrafts）、语料提议 = pw_corpus_docs.status='proposed'
 *   （listPwCorpusProposed）。collabPendingQueue() 聚合的三个 list 函数已天然只筛这三态，
 *   已批准（approved）/已拒绝（rejected）/已结（settled）/已完成（done）等不进计数。
 * - pendingReview.proposals = pw_proposals 状态为 submitted/in_review/changes_requested
 *   的计数（TASK-PW-16，countPendingPwProposals）。
 * - recentRuns 取 pw_runs 最近 8 条（不限 kind），只挑 kind/eventType/betId/createdAt 四字段。
 * - lastActivityAt = pw_runs 最新 created_at，无则 null。
 *
 * 纪律：纯只读（只 SELECT）、不新建表、不调 LLM、不动 Memos/真库。writeDiscipline 与
 * GUARDRAILS.md 语义一致——AI 只摆证据与起草，人握挑/否/定稿/结账/守门文件改动。
 */
import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "./data.ts";
import { ensurePwBetTables } from "./pw-bets.ts";
import { collabPendingQueue, ensurePwCollabTables } from "./pw-collab.ts";
import { ensurePwCorpusTables } from "./pw-corpus.ts";
import { countPendingPwProposals } from "./pw-proposals.ts";
import { ensurePwRunTables, listPwRuns } from "./pw-runs.ts";

/** 固定文案：与 GUARDRAILS.md 语义一致（AI 只摆证据与起草，人握守门动作）。 */
export const PW_MODE_BAR_WRITE_DISCIPLINE =
  "AI 只摆证据与起草；挑/否/定稿/结账/守门文件改动，只有人能做。";

export type PwModeBar = {
  generatedAt: string;
  pendingReview: {
    betDrafts: number;
    settleDrafts: number;
    corpusProposed: number;
    proposals: number;
    total: number;
  };
  recentRuns: Array<{ kind: string; eventType: string; betId: string | null; createdAt: string }>;
  lastActivityAt: string | null;
  writeDiscipline: string;
};

export function getPwModeBar(db: DatabaseSync, now: () => string = nowIso): PwModeBar {
  ensurePwBetTables(db);
  ensurePwCollabTables(db);
  ensurePwCorpusTables(db);
  ensurePwRunTables(db);

  const queue = collabPendingQueue(db);
  const betDrafts = queue.betDrafts.length;
  const settleDrafts = queue.settleDrafts.length;
  const corpusProposed = queue.corpusProposed.length;
  const proposals = countPendingPwProposals(db);

  const recentRuns = listPwRuns(db, { limit: 8 }).map((run) => ({
    kind: run.kind,
    eventType: run.event_type,
    betId: run.bet_id,
    createdAt: run.created_at,
  }));
  const latest = listPwRuns(db, { limit: 1 })[0];

  return {
    generatedAt: now(),
    pendingReview: {
      betDrafts,
      settleDrafts,
      corpusProposed,
      proposals,
      total: betDrafts + settleDrafts + corpusProposed + proposals,
    },
    recentRuns,
    lastActivityAt: latest?.created_at ?? null,
    writeDiscipline: PW_MODE_BAR_WRITE_DISCIPLINE,
  };
}
