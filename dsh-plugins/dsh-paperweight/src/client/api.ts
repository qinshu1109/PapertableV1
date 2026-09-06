/**
 * client → host 同源 API 封装。
 * 铁律1:client 只准调 types.ts PW_ROUTE_TABLE 列出的 /pw/api/* 路由。
 * 响应包装:契约未绑定 GET envelope(见 out/37-contract-changes.md #1),
 * unwrap 同时兼容 { ok:true, <key>: T } 包裹形与裸类型形,以 host 实现为准。
 */
import type {
  PwActionInput,
  PwActionSuccess,
  PwBetDetail,
  PwBetView,
  PwDraftView,
  PwNoteTreeView,
  PwNoteView,
  PwOpsStatus,
  PwPushFeed,
  PwVerdictEvidenceView,
  PwVerdictView,
  PwVoiceTheme,
  PwVoiceThemeDetail,
} from "../types.ts";

const PREFIX = "/pw/api";

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(PREFIX + path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      body !== null && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

/** 兼容 { ok:true, <key>: T } 包裹形与裸 T 形。 */
function unwrap<T>(body: unknown, ...keys: string[]): T {
  if (body !== null && typeof body === "object") {
    const rec = body as Record<string, unknown>;
    for (const k of keys) {
      if (rec[k] !== undefined) return rec[k] as T;
    }
  }
  return body as T;
}

export const pwApi = {
  async listBets(status?: string): Promise<PwBetView[]> {
    const q = status ? `?status=${encodeURIComponent(status)}` : "";
    return unwrap<PwBetView[]>(await request(`/bets${q}`), "bets", "items", "rows");
  },
  async readBet(id: string): Promise<PwBetDetail> {
    return unwrap<PwBetDetail>(await request(`/bets/${encodeURIComponent(id)}`), "bet", "detail");
  },
  async listDrafts(): Promise<PwDraftView[]> {
    return unwrap<PwDraftView[]>(await request("/drafts"), "drafts", "items", "rows");
  },
  async listVerdicts(opts?: { outcome?: string; q?: string }): Promise<PwVerdictView[]> {
    const p = new URLSearchParams();
    if (opts?.outcome) p.set("outcome", opts.outcome);
    if (opts?.q) p.set("q", opts.q);
    const qs = p.toString();
    return unwrap<PwVerdictView[]>(await request(`/verdicts${qs ? `?${qs}` : ""}`), "verdicts", "items", "rows");
  },
  async readVerdictEvidence(id: string): Promise<PwVerdictEvidenceView> {
    // host 实际返回裸 { verdict, evidence }(contract-changes #1 回填),不做键提取。
    return (await request(`/verdicts/${encodeURIComponent(id)}/evidence`)) as PwVerdictEvidenceView;
  },
  async listVoiceThemes(): Promise<PwVoiceTheme[]> {
    return unwrap<PwVoiceTheme[]>(await request(`/voice/themes`), "themes", "items", "rows");
  },
  async readVoiceTheme(themeId: string): Promise<PwVoiceThemeDetail> {
    return unwrap<PwVoiceThemeDetail>(await request(`/voice/items?theme=${encodeURIComponent(themeId)}`), "theme", "detail");
  },
  async notesToday(): Promise<{ notes: PwNoteView[]; memosOk: boolean }> {
    // host 实际返回 { notes, status }(status 为 4317 /api/pw/notes/status 原样对象,无 memosOk 字段)。
    const body = await request(`/notes/today`);
    const notes = unwrap<PwNoteView[]>(body, "notes", "items", "rows");
    let memosOk = true;
    if (body !== null && typeof body === "object" && "status" in body) {
      const st = (body as { status: unknown }).status;
      if (st !== null && typeof st === "object") {
        const rec = st as Record<string, unknown>;
        const flag = rec["memosOk"] ?? rec["ok"] ?? rec["available"] ?? rec["ready"];
        if (typeof flag === "boolean") memosOk = flag;
        else if (typeof rec["error"] === "string" && rec["error"]) memosOk = false;
      }
    }
    return { notes: Array.isArray(notes) ? notes : [], memosOk };
  },
  async notesTree(): Promise<PwNoteTreeView> {
    return unwrap<PwNoteTreeView>(await request(`/notes/tree`), "tree");
  },
  async opsStatus(): Promise<PwOpsStatus> {
    return unwrap<PwOpsStatus>(await request(`/ops/status`), "ops", "status");
  },
  async pushFeed(): Promise<PwPushFeed> {
    const body = await request(`/push/feed`);
    const feed = unwrap<PwPushFeed>(body, "feed");
    if (feed !== null && typeof feed === "object" && Array.isArray((feed as PwPushFeed).items)) return feed as PwPushFeed;
    return { items: [], unread: 0 };
  },
  async pushMarkRead(input: { id?: string; ids?: string[]; all?: boolean }): Promise<number> {
    const body = await request(`/push/mark-read`, { method: "POST", body: JSON.stringify(input) });
    const unread = unwrap<number>(body, "unread");
    return typeof unread === "number" ? unread : 0;
  },
  /** 人点按钮唯一通道(铁律2):挑/改/否/确认。 */
  async action(input: PwActionInput): Promise<PwActionSuccess> {
    return (await request(`/action`, { method: "POST", body: JSON.stringify(input) })) as PwActionSuccess;
  },
};
