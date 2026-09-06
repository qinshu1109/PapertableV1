/**
 * TASK-PW-33：自动起草发动（押注一确认就自己起草三份对照草案，可拉黑不起草）。
 *
 * 数据真值源：新表 `pw_draft_blacklist`（拉黑不起草）；`pw_content_drafts` 状态流转
 * （PW-31 既有）；发动留痕复用管线自身的 ai_draft/draft 事件（加 trigger 字段区分来源），
 * 不另开账——本模块自身只在"守卫/管线同步抛错"时兜底补记一笔失败事件，且补记再失败
 * 仅 console.warn 不外抛。
 *
 * 可靠性不变式：`maybeAutoFirePwDraft` 永不 reject——守卫未过安静跳过（{fired:false}，
 * 不记 pw_runs）；守卫/管线抛错 → 兜底补记 ai_draft/draft 失败事件（payload 含 trigger 与
 * error），补记本身再失败仅 console.warn。
 *
 * fire-and-forget 约定：工具处理器/REST 调用面一律 `void maybeAutoFirePwDraft(...)` 不
 * await——确认押注的响应不能被 30–60s 的 LLM 起草阻塞；草案落库后由屏侧轮询自然出现。
 */
import type { DatabaseSync } from "node:sqlite";
import { httpError, nowIso } from "./data.ts";
import { getPwBet } from "./pw-bets.ts";
import { DEFAULT_DRAFT_ROUTES, runPwDraftPipeline, type DraftLlm } from "./pw-draft-pipeline.ts";
import { recordPwEvent } from "./pw-runs.ts";

// ---------------------------------------------------------------------------
// 拉黑不起草：pw_draft_blacklist（bet_id 主键；拉黑行本身就是记录，守卫未过不另留账）
// ---------------------------------------------------------------------------

export type PwDraftBlacklistRow = {
  bet_id: string;
  reason: string | null;
  created_at: string;
};

/** 联查押注标题后的列表行（listPwDraftBlacklist 产物）。 */
export type PwDraftBlacklistViewRow = PwDraftBlacklistRow & { bet_title: string | null };

/** 幂等建表（CREATE TABLE IF NOT EXISTS，无迁移）。 */
export function ensurePwDraftBlacklistTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pw_draft_blacklist (
      bet_id TEXT PRIMARY KEY,
      reason TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

function getPwDraftBlacklistRow(db: DatabaseSync, betId: string): PwDraftBlacklistRow | undefined {
  return db.prepare("SELECT * FROM pw_draft_blacklist WHERE bet_id = ?").get(betId) as
    | PwDraftBlacklistRow
    | undefined;
}

/**
 * 拉黑：bet 不存在 → 404（沿 getPwBet 校验）；已存在 → 幂等不报错（INSERT OR IGNORE，
 * reason 不覆盖）。每次调用留一笔 manual_event/edit 账（action='draft_blacklist_add'）。
 */
export function addPwDraftBlacklist(
  db: DatabaseSync,
  betId: string,
  reason?: string,
): PwDraftBlacklistRow {
  if (!getPwBet(db, betId)) throw httpError(404, "押注不存在");
  const reasonText = typeof reason === "string" && reason.trim() ? reason.trim() : null;
  db.prepare(`
    INSERT OR IGNORE INTO pw_draft_blacklist(bet_id, reason, created_at) VALUES(?, ?, ?)
  `).run(betId, reasonText, nowIso());
  recordPwEvent(db, {
    kind: "manual_event",
    eventType: "edit",
    actor: "human",
    betId,
    payloadJson: JSON.stringify({ betId, reason: reasonText, action: "draft_blacklist_add" }),
  });
  return getPwDraftBlacklistRow(db, betId)!;
}

/**
 * 取消拉黑：不存在该行 → 404；删除并留一笔 manual_event/edit 账（action='draft_blacklist_remove'）。
 */
export function removePwDraftBlacklist(db: DatabaseSync, betId: string): PwDraftBlacklistRow {
  const existing = getPwDraftBlacklistRow(db, betId);
  if (!existing) throw httpError(404, "押注不在起草黑名单");
  db.prepare("DELETE FROM pw_draft_blacklist WHERE bet_id = ?").run(betId);
  recordPwEvent(db, {
    kind: "manual_event",
    eventType: "edit",
    actor: "human",
    betId,
    payloadJson: JSON.stringify({ betId, action: "draft_blacklist_remove" }),
  });
  return existing;
}

export function isPwDraftBlacklisted(db: DatabaseSync, betId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM pw_draft_blacklist WHERE bet_id = ?").get(betId));
}

/** 全量拉黑名单（联查押注标题，created_at 升序）。 */
export function listPwDraftBlacklist(db: DatabaseSync): PwDraftBlacklistViewRow[] {
  return db.prepare(`
    SELECT b.bet_id, b.reason, b.created_at, bt.title AS bet_title
    FROM pw_draft_blacklist b
    LEFT JOIN pw_bets bt ON bt.id = b.bet_id
    ORDER BY b.created_at ASC
  `).all() as PwDraftBlacklistViewRow[];
}

// ---------------------------------------------------------------------------
// 发动函数 maybeAutoFirePwDraft
// ---------------------------------------------------------------------------

export type PwDraftAutofireOptions = {
  /** 发动来源：工具名（confirm_bet_draft / pick_sieve_card），进留痕 payload.trigger。 */
  trigger: "confirm_bet_draft" | "pick_sieve_card";
  /** 测试注入用；缺省走真实 provider（管线内部创建）。 */
  llm?: DraftLlm;
  modelLabel?: string;
};

/**
 * 押注成立后自动起草。四守卫（任一不过 → {fired:false, reason}，不记 pw_runs——安静跳过，
 * 黑名单行本身就是记录）：
 * 1. bet 存在；
 * 2. bet.kind === 'content' 且 bet.status === 'pending'；
 * 3. 不在 pw_draft_blacklist；
 * 4. 该 bet 在 pw_content_drafts 零行（防重复发动；否掉全部草案后的"换一批"不在本刀）。
 *
 * 发动：runPwDraftPipeline(db, betId, { llm, modelLabel, trigger })。
 *
 * 可靠性不变式：永不 reject——守卫/管线同步抛错 → catch 后尝试补记一笔 ai_draft/draft
 * 失败事件（payload 含 trigger 与 error）；补记本身再失败 → 仅 console.warn，不外抛。
 * 管线自身失败路径已留痕（PW-32 既有），本层不重复记。
 */
export async function maybeAutoFirePwDraft(
  db: DatabaseSync,
  betId: string,
  options: PwDraftAutofireOptions,
): Promise<{ fired: boolean; reason?: string }> {
  try {
    const bet = getPwBet(db, betId);
    if (!bet) return { fired: false, reason: "押注不存在" };
    if (bet.kind !== "content" || bet.status !== "pending") {
      return { fired: false, reason: "非 content/pending 押注不自动起草" };
    }
    if (isPwDraftBlacklisted(db, betId)) return { fired: false, reason: "押注在起草黑名单" };
    const existing = db.prepare(
      "SELECT COUNT(*) AS n FROM pw_content_drafts WHERE bet_id = ?",
    ).get(betId) as { n: number };
    if (existing.n > 0) return { fired: false, reason: "该押注已有草案，不重复发动" };

    await runPwDraftPipeline(db, betId, {
      llm: options.llm,
      modelLabel: options.modelLabel,
      trigger: options.trigger,
    });
    return { fired: true };
  } catch (caught) {
    try {
      recordPwEvent(db, {
        kind: "ai_draft",
        eventType: "draft",
        actor: "ai",
        betId,
        payloadJson: JSON.stringify({
          betId,
          trigger: options.trigger,
          created: 0,
          dropped: [],
          routes: [...DEFAULT_DRAFT_ROUTES],
          model: options.modelLabel ?? null,
          error: safeErrorText(caught),
        }),
      });
    } catch {
      // 兜底补记本身再失败（如库已关闭/表缺失）：只警告，不外抛——绝不 reject
      console.warn(`maybeAutoFirePwDraft 兜底留痕失败：${safeErrorText(caught)}`);
    }
    return { fired: false, reason: safeErrorText(caught) };
  }
}

function safeErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
