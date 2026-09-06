/**
 * session-start 开场快照：拼装与截断是纯函数，拉数在 notice.ts。
 * 模板、cue 优先级、截断顺序严格照 38a §2.3–§2.5。
 */
import type { PwBetView, PwPushFeed, PwPushKind } from "../types.js";

export const NOTICE_BUDGET_MS = 4_000;
export const NOTICE_MAX_CHARS = 900;

export interface NoticeVerdictRow {
  id: string;
  betId: string;
  outcome: "gold" | "tomb" | "void" | string;
  lesson: string | null;
  causeOfDeath: string | null;
  decidedAt: string;
}

export interface NoticeSnapshot {
  pending: PwBetView[] | null;
  due: PwBetView[] | null;
  drafts: { length: number } | null;
  sievePending: { length: number } | null;
  connections: Array<{ id: string; platform: string; status: string }> | null;
  verdicts: NoticeVerdictRow[] | null;
  push: PwPushFeed;
}

export interface NoticeResult {
  text: string;
  summary: string;
  degraded: boolean;
}

function clip(text: string, max: number): string {
  const value = text.trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

function localDate(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function decidedDate(value: string): string {
  const match = String(value ?? "").match(/^(\d{4}-\d{2}-\d{2})/u);
  return match?.[1] ?? "—";
}

function betLine(bet: PwBetView, index: number): string {
  const title = clip(bet.title || "未命名", 24);
  const days = bet.daysToCheckout;
  const daysText = days === null || days === undefined
    ? "还剩—天"
    : days <= 0
      ? "已过期"
      : `还剩${days}天`;
  return `${index + 1}.《${title}》id=${bet.id} 结账${bet.checkoutDate ?? "—"} 置信${bet.confidence ?? "—"}% ${daysText}`;
}

function pickCue(input: {
  dueN: number;
  nhN: number;
  nhPushN: number;
  unreadN: number;
  sieveN: number;
  draftN: number;
  pendingN: number;
}): string {
  if (input.dueN > 0) return "先处理到期待裁决：点名上面那几注，只摆证据，请人去左栏或墙上点裁决。";
  if (input.nhN > 0 || input.nhPushN > 0) return "有数据源等人工接手，请人去运维区；你不要代处理登录态。";
  if (input.unreadN > 0 || input.sieveN > 0) return "请人先看左栏推送 / 今日值得看，候选卡由人挑或否。";
  if (input.draftN > 0) return "草稿区有待确认项，请人补齐三行赌注后点确认转正。";
  if (input.pendingN > 0) return "可以精读距结账最近的在途注：数据够不够裁、要不要先例或旧笔记。";
  return "工作台是空的。问人要口述一注让你起草，还是先去观众声音里看主题卡。";
}

function countPush(push: PwPushFeed, kind: PwPushKind): number {
  return push.items.filter((item) => !item.read && item.kind === kind).length;
}

function recentByOutcome(rows: NoticeVerdictRow[], outcome: "gold" | "tomb"): NoticeVerdictRow[] {
  return [...rows]
    .filter((row) => row.outcome === outcome)
    .sort((a, b) => String(b.decidedAt).localeCompare(String(a.decidedAt)))
    .slice(0, 2);
}

function verdictLine(row: NoticeVerdictRow, label: "金子" | "墓碑"): string {
  const body = clip(label === "金子" ? (row.lesson ?? "(无 lesson)") : (row.causeOfDeath ?? "(无死因)"), 40);
  return `- [${label}] ${decidedDate(row.decidedAt)} ${body}（判决 ${row.id} / 注 ${row.betId}）`;
}

function formatBlock(label: string, missing: boolean, present: string): string {
  return missing ? `${label}未取到` : present;
}

/**
 * 超 900 字按 dueList → pendingTail → gold/tomb 行 → nhTail 砍，键名保留。
 */
export function trimNoticeText(text: string): string {
  if ([...text].length <= NOTICE_MAX_CHARS) return text;
  const lines = text.split("\n");
  const dropBlockDetails = (start: string, end: string): boolean => {
    const from = lines.findIndex((line) => line.startsWith(start));
    if (from < 0) return false;
    const to = lines.findIndex((line, index) => index > from && line.startsWith(end));
    const stop = to < 0 ? lines.length : to;
    const detail = lines.findIndex((line, index) =>
      index > from
      && index < stop
      && (/^\d+\.《/u.test(line) || /^等 \d+ 注未列出/u.test(line))
    );
    if (detail < 0) return false;
    lines.splice(detail, 1);
    return true;
  };
  const dropIf = (predicate: (line: string) => boolean): boolean => {
    const index = lines.findIndex(predicate);
    if (index < 0) return false;
    lines.splice(index, 1);
    return true;
  };
  const over = (): boolean => [...lines.join("\n")].length > NOTICE_MAX_CHARS;
  while (over() && dropBlockDetails("到期待裁决", "未读推送")) { /* dueList */ }
  while (over() && dropBlockDetails("在途", "到期待裁决")) { /* pendingTail */ }
  while (over() && dropIf((line) => line.startsWith("- [金子]") || line.startsWith("- [墓碑]"))) { /* */ }
  if (over()) {
    const idx = lines.findIndex((line) => line.startsWith("数据源需人工"));
    if (idx >= 0) {
      const match = lines[idx]?.match(/^(数据源需人工 \d+ 个)/u);
      if (match) lines[idx] = match[1] ?? lines[idx]!;
    }
  }
  let out = lines.join("\n");
  if ([...out].length > NOTICE_MAX_CHARS) out = `${[...out].slice(0, NOTICE_MAX_CHARS - 1).join("")}…`;
  return out;
}

export function buildDegradedNotice(reason: string): NoticeResult {
  const short = clip(reason.replace(/\s+/g, " "), 80);
  return {
    degraded: true,
    summary: "镇纸快照不可用",
    text: `【镇纸开场快照不可用】${short}。不要编造在途/判决/推送数字。人问近况时先调一次 pw_ops_status；仍失败就明说 4317 不通。写边界店规仍然有效。`,
  };
}

export function buildSuccessNotice(snapshot: NoticeSnapshot, now = new Date()): NoticeResult {
  const pendingMissing = snapshot.pending === null;
  const dueMissing = snapshot.due === null;
  const draftsMissing = snapshot.drafts === null;
  const sieveMissing = snapshot.sievePending === null;
  const connMissing = snapshot.connections === null;
  const verdictsMissing = snapshot.verdicts === null;

  const pending = snapshot.pending ?? [];
  const due = snapshot.due ?? [];
  const draftN = snapshot.drafts?.length ?? 0;
  const sieveN = snapshot.sievePending?.length ?? 0;
  const needsHuman = (snapshot.connections ?? []).filter((conn) => conn.status === "needs_human");
  const unreadN = snapshot.push.unread;
  const dailyN = countPush(snapshot.push, "daily");
  const duePushN = countPush(snapshot.push, "due");
  const nhPushN = countPush(snapshot.push, "needs_human");

  const pendingSorted = [...pending].sort((a, b) => {
    const da = a.daysToCheckout;
    const db = b.daysToCheckout;
    if (da === null && db === null) return 0;
    if (da === null) return 1;
    if (db === null) return -1;
    return da - db;
  });

  const dueShown = due.slice(0, 5);
  const dueExtra = due.length > 5 ? `\n等 ${due.length - 5} 注未列出，请 pw_list_bets status=pending` : "";
  const dueList = dueMissing
    ? ""
    : due.length === 0
      ? ""
      : `：\n${dueShown.map((bet, index) => betLine(bet, index)).join("\n")}${dueExtra}`;

  const pendingTail = pendingMissing
    ? ""
    : due.length > 0 || pending.length === 0
      ? ""
      : `：\n${pendingSorted.slice(0, 3).map((bet, index) => betLine(bet, index)).join("\n")}`;

  const nhNames = needsHuman.slice(0, 3).map((conn) => conn.platform || conn.id).filter(Boolean);
  const nhTail = connMissing || needsHuman.length === 0
    ? ""
    : `：${nhNames.join("、")}${needsHuman.length > 3 ? "…" : ""}`;

  const goldRows = verdictsMissing ? [] : recentByOutcome(snapshot.verdicts ?? [], "gold");
  const tombRows = verdictsMissing ? [] : recentByOutcome(snapshot.verdicts ?? [], "tomb");
  const goldLines = verdictsMissing ? "未取到" : goldRows.length === 0 ? "暂无" : `\n${goldRows.map((row) => verdictLine(row, "金子")).join("\n")}`;
  const tombLines = verdictsMissing ? "未取到" : tombRows.length === 0 ? "暂无" : `\n${tombRows.map((row) => verdictLine(row, "墓碑")).join("\n")}`;

  const cue = pickCue({
    dueN: dueMissing ? 0 : due.length,
    nhN: connMissing ? 0 : needsHuman.length,
    nhPushN,
    unreadN,
    sieveN: sieveMissing ? 0 : sieveN,
    draftN: draftsMissing ? 0 : draftN,
    pendingN: pendingMissing ? 0 : pending.length,
  });

  const pendingHead = formatBlock("在途", pendingMissing, `在途 ${pending.length} 注${pendingTail}`);
  const dueHead = formatBlock("到期待裁决", dueMissing, `到期待裁决 ${due.length} 注${dueList}`);
  const draftHead = draftsMissing ? "待确认草稿未取到" : `待确认草稿 ${draftN} 份`;
  const sieveHead = sieveMissing ? "候选卡待挑未取到" : `候选卡待挑 ${sieveN} 张`;
  const nhHead = formatBlock("数据源需人工", connMissing, `数据源需人工 ${needsHuman.length} 个${nhTail}`);

  const raw = [
    `【镇纸开场快照 · ${localDate(now)} · 4317 通】`,
    "",
    pendingHead,
    dueHead,
    `未读推送 ${unreadN} 条（今日值得看 ${dailyN} / 到期提醒 ${duePushN} / 等人工 ${nhPushN}）`,
    `${draftHead}；${sieveHead}`,
    nhHead,
    `近金子：${goldLines}`,
    `近墓碑：${tombLines}`,
    "",
    `开场：${cue}`,
    "查某注用 pw_read_bet；查系统用 pw_ops_status。快照已给出的计数不要重拉全库。",
  ].join("\n");

  return {
    degraded: false,
    text: trimNoticeText(raw),
    summary: `镇纸快照：在途${pendingMissing ? "?" : pending.length} / 到期${dueMissing ? "?" : due.length} / 未读${unreadN} / 金${verdictsMissing ? "?" : goldRows.length}碑${verdictsMissing ? "?" : tombRows.length}`,
  };
}
