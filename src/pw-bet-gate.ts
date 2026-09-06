/**
 * 简报 21 · 任务一：激活前数据就绪闸门。
 *
 * 在押注激活（draft → pending）前做只读预检，把「不可结账的押注」拦在激活前：
 * - data_source   数据源绑定存在且可试读（自动源如 B站同步：连接存在且连通；
 *                 手动录入源：needs_human，语义＝已确认走手动录入，不拦）
 * - metric        验证指标可判定（指标字段 metric 非空、判定规则 metric_target 明确）
 * - checkout_date 结账日可达（非缺失、非过去）
 *
 * 预检三态：
 * - pass        该检查就绪
 * - needs_human 需要人工接手（不算 fail，不拦激活，但响应带回提示）
 * - fail        阻断激活（激活端点返回 409 + 失败清单）
 *
 * 纪律：
 * - preflight 只读、幂等、不产生任何写（edits 仅参与判定投影，不落库）；
 * - 激活端点复用既有 confirmPwBetDraft 做 draft→pending 迁移（状态机唯一真值源，
 *   不新造迁移）；闸门只在激活端点强制，不改 collab 工具/结账/审批等确认流程；
 * - 守门②：不碰任何 schema（全部用现有表只读聚合）。
 */
import type { DatabaseSync } from "node:sqlite";
import { httpError } from "./data.ts";
import { getPwBet, type PwBetRow } from "./pw-bets.ts";
import {
  confirmPwBetDraft,
  type PwBetDraftEdits,
} from "./pw-drafts.ts";
import { BILIBILI_PLATFORM } from "./pw-connections.ts";
// 简报 23 · 联动闸门：激活前查相关先例是否已全部处置（未处置 → 409 带回清单）
import {
  listPwBetPrecedents,
  listUndisposedPrecedents,
  recordPwVerdictExposure,
} from "./pw-closed-loop.ts";

export type PreflightResult = "pass" | "fail" | "needs_human";

export type PwPreflightCheck = {
  name: string;
  result: PreflightResult;
  detail: string;
};

export type PwPreflight = {
  checks: PwPreflightCheck[];
  pass: boolean;
};

export type DataSourceKind = "auto" | "manual";

export type PwDataSourceStatus = {
  kind: DataSourceKind;
  status: "active" | "needs_human" | "paused" | "unbound" | "manual";
  lastSyncAt: string | null;
  detail: string;
};

export type PwPreflightOptions = {
  /** 激活时可携带的编辑字段：预检按「草稿当前值 + edits 合并后」判定（与激活落库口径一致）。 */
  edits?: PwBetDraftEdits;
  /** 基准时刻（测试注入）：ISO 串或 Date；缺省当前时刻。 */
  now?: string | Date;
};

/** 预检后合并用的字段投影（与 pw-drafts 的 optionalText 语义一致：trim、空串→null）。 */
type GateFields = {
  metric: string | null;
  metric_target: string | null;
  checkout_date: string | null;
  data_source_plan: string | null;
};

const AUTO_SOURCE_KEYWORDS = ["B站", "bilibili", "bili"];

/**
 * 数据来源计划分类：含 B站/bilibili/bili 视为自动源（唯一已接入的连接平台），
 * 其余一律视为手动录入源。确定性关键字匹配，注释即口径。
 */
export function classifyDataSourcePlan(plan: string | null): { kind: DataSourceKind; platform: string | null } {
  const text = plan?.trim() ?? "";
  if (!text) return { kind: "manual", platform: null };
  const isAuto = AUTO_SOURCE_KEYWORDS.some((keyword) => text.toLowerCase().includes(keyword.toLowerCase()));
  return isAuto ? { kind: "auto", platform: BILIBILI_PLATFORM } : { kind: "manual", platform: null };
}

/**
 * 数据源当前状态（只读）：
 * - plan 为空/缺失 → unbound（缺数据来源计划，fail）；
 * - manual → { status: 'manual' }，语义＝已确认走手动录入；
 * - auto   → 按 pw_connections 平台连接状态：active / needs_human / paused / unbound（未绑定）。
 */
export function getPwDataSourceStatus(db: DatabaseSync, plan: string | null): PwDataSourceStatus {
  const { kind, platform } = classifyDataSourcePlan(plan);
  if (!plan?.trim()) {
    return { kind, status: "unbound", lastSyncAt: null, detail: "缺少数据来源（data_source_plan 为空）" };
  }
  if (kind === "manual") {
    return {
      kind,
      status: "manual",
      lastSyncAt: null,
      detail: "已确认走手动录入（不拦激活）",
    };
  }
  const conn = db.prepare("SELECT status, last_sync_at FROM pw_connections WHERE platform = ?")
    .get(platform) as { status: string; last_sync_at: string | null } | undefined;
  if (!conn) {
    return { kind, status: "unbound", lastSyncAt: null, detail: `未绑定 ${platform} 数据源连接` };
  }
  if (conn.status === "needs_human") {
    return {
      kind,
      status: "needs_human",
      lastSyncAt: conn.last_sync_at,
      detail: `${platform} 数据源需人工处理（验证码/登录墙）`,
    };
  }
  if (conn.status === "paused") {
    return { kind, status: "paused", lastSyncAt: conn.last_sync_at, detail: `${platform} 数据源连接已暂停` };
  }
  const syncNote = conn.last_sync_at ? `最近同步 ${conn.last_sync_at}` : "尚未同步过（发布后同步即到）";
  return { kind, status: "active", lastSyncAt: conn.last_sync_at, detail: `${platform} 连接 active，可试读（${syncNote}）` };
}

/** 自动源的「真实试读」：查该押注最近一次回流数据文档（任何 method），只读不写。 */
function tryReadLatestData(db: DatabaseSync, betId: string): { lastDataAt: string | null; note: string } {
  const latest = db.prepare(`
    SELECT collected_at, method, platform FROM pw_data_docs
    WHERE bet_id = ?
    ORDER BY collected_at DESC, rowid DESC
    LIMIT 1
  `).get(betId) as { collected_at: string; method: string; platform: string } | undefined;
  if (!latest) return { lastDataAt: null, note: "尚无该押注回流数据（发布后同步即到）" };
  return { lastDataAt: latest.collected_at, note: `试读到回流数据：${latest.platform}@${latest.collected_at}（${latest.method}）` };
}

/**
 * 只读预检（幂等、零写）。草稿不存在 → 404；非 draft 态 → 409。
 * 检查项按 name 稳定排序，pass = 无 fail（needs_human 不拦）。
 */
export function preflightPwBetActivation(
  db: DatabaseSync,
  betId: string,
  options: PwPreflightOptions = {},
): PwPreflight {
  const bet = getPwBet(db, betId);
  if (!bet) throw httpError(404, "押注不存在");
  if (bet.status !== "draft") {
    throw httpError(409, `仅草稿押注可预检，当前状态 ${bet.status}`);
  }
  const fields = projectGateFields(bet, options.edits);
  const today = dayOf(options.now);

  const checks: PwPreflightCheck[] = [];

  // 检查 1：数据源绑定存在且可试读
  {
    const source = getPwDataSourceStatus(db, fields.data_source_plan);
    if (source.status === "unbound") {
      checks.push({ name: "data_source", result: "fail", detail: source.detail });
    } else if (source.status === "paused") {
      checks.push({ name: "data_source", result: "fail", detail: source.detail });
    } else if (source.status === "needs_human") {
      checks.push({ name: "data_source", result: "needs_human", detail: source.detail });
    } else if (source.status === "manual") {
      checks.push({ name: "data_source", result: "needs_human", detail: source.detail });
    } else {
      const read = tryReadLatestData(db, betId);
      checks.push({
        name: "data_source",
        result: "pass",
        detail: `${source.detail}；${read.note}`,
      });
    }
  }

  // 检查 2：验证指标可判定（指标字段非空、判定规则明确）
  {
    const missing: string[] = [];
    if (!fields.metric) missing.push("验证指标（metric）");
    if (!fields.metric_target) missing.push("判定规则/指标目标（metric_target）");
    checks.push(
      missing.length === 0
        ? { name: "metric", result: "pass", detail: "验证指标与判定规则齐备" }
        : { name: "metric", result: "fail", detail: `缺少：${missing.join("、")}` },
    );
  }

  // 检查 3：结账日可达（不是过去、不是缺失）
  {
    if (!fields.checkout_date) {
      checks.push({ name: "checkout_date", result: "fail", detail: "缺少结账日（checkout_date）" });
    } else if (fields.checkout_date < today) {
      checks.push({ name: "checkout_date", result: "fail", detail: `结账日已是过去（${fields.checkout_date} < ${today}）` });
    } else {
      checks.push({ name: "checkout_date", result: "pass", detail: `结账日 ${fields.checkout_date} 可达` });
    }
  }

  return { checks, pass: checks.every((check) => check.result !== "fail") };
}

export type PwActivationResult = {
  bet: PwBetRow & { draft_hash: string };
  preflight: PwPreflight;
};

/**
 * 激活（draft → pending）并强制预检闸门：
 * - 预检有 fail → 409，details 带回失败清单（不写任何东西）；
 * - 简报 23 · 联动闸门：preflight 通过后再查——相关先例非空且存在未处置项 → 409
 *   带回未处置清单（全部处置完或无相关先例才放行）；存在相关先例时记一行
 *   surface='activation' 的曝光流水；
 * - 仅 needs_human 或全 pass 且先例已处置 → 走既有 confirmPwBetDraft 转正，
 *   响应带回预检提示。
 * 与 preflight 同口径：edits 先投影进预检，再交给 confirmPwBetDraft 落库。
 */
export function activatePwBet(
  db: DatabaseSync,
  betId: string,
  edits: PwBetDraftEdits = {},
  options: PwPreflightOptions = {},
): PwActivationResult {
  const preflight = preflightPwBetActivation(db, betId, { ...options, edits });
  const failures = preflight.checks.filter((check) => check.result === "fail");
  if (failures.length > 0) {
    throw httpError(409, "激活预检未通过，请先处理失败项", { checks: preflight.checks, pass: false });
  }
  // 简报 23 · 联动闸门：preflight 通过后再查先例处置
  const precedents = listPwBetPrecedents(db, betId);
  if (precedents.length > 0) {
    recordPwVerdictExposure(db, {
      surface: "activation",
      betId,
      verdictIds: precedents.map((item) => item.verdictId),
      actor: "system",
    });
    const undisposed = listUndisposedPrecedents(db, betId);
    if (undisposed.length > 0) {
      throw httpError(409, "存在未处置的先例判决，请先处置", {
        undisposed,
        total: undisposed.length,
      });
    }
  }
  const bet = confirmPwBetDraft(db, betId, edits);
  return { bet, preflight };
}

/** 预检判定用的字段投影：draft 当前值 + edits 覆盖（与 pw-drafts 落库口径一致的文本归一）。 */
function projectGateFields(bet: PwBetRow, edits: PwBetDraftEdits = {}): GateFields {
  return {
    metric: overlayText(bet.metric, edits.metric),
    metric_target: overlayText(
      bet.metric_target,
      edits.metric_target !== undefined ? edits.metric_target : edits.metricTarget,
    ),
    checkout_date: overlayText(
      bet.checkout_date,
      edits.checkout_date !== undefined ? edits.checkout_date : edits.checkoutDate,
    ),
    data_source_plan: overlayText(
      bet.data_source_plan,
      edits.data_source_plan !== undefined ? edits.data_source_plan : edits.dataSourcePlan,
    ),
  };
}

/** 与 pw-drafts.optionalText 同语义：undefined 保持原值；null→null；字符串 trim、空→null；非字符串报错。 */
function overlayText(current: string | null, edit: string | null | undefined): string | null {
  if (edit === undefined) return current;
  if (edit === null) return null;
  if (typeof edit !== "string") throw httpError(400, "编辑字段格式非法");
  const text = edit.trim();
  return text || null;
}

/** yyyy-mm-dd（UTC，与结账日字符串风格一致）。 */
function dayOf(value: string | Date | undefined): string {
  if (value === undefined) return new Date().toISOString().slice(0, 10);
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}
