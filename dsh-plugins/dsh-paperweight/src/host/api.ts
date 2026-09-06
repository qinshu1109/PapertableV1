/**
 * host 半 webServer 路由：统一前缀 /pw/api/*。
 * client 只准调 types.ts PW_ROUTE_TABLE 里的路由；全部经 4317 现拉现裁。
 */
import type {
  PwActionInput,
  PwDraftBetInput,
  PwHostDeps,
} from "../types.js";
import {
  createDraft,
  fetchActivityDaily,
  fetchAllDataDocs,
  fetchBet,
  fetchBetContext,
  fetchBetDataDocs,
  fetchBetPrecedents,
  fetchBets,
  fetchConnections,
  fetchDrafts,
  fetchNotes,
  fetchNotesStatus,
  fetchNotesTree,
  fetchServerStatus,
  fetchSieveCards,
  fetchVerdictEvidence,
  fetchVerdicts,
} from "./pw-client.js";
import { appendActionLog, handleAction } from "./action.js";
import { PushStore } from "./push.js";
import { collectVoiceThemeDetail, collectVoiceThemes } from "./voice.js";

type HttpReq = any;
type HttpRes = any;

function send(res: HttpRes, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.byteLength,
    "cache-control": "no-store",
  });
  res.end(body);
}

async function readBody(req: HttpReq): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("请求体必须是 JSON 对象");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`请求体 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

export function registerWebApi(ctx: any, deps: PwHostDeps, push?: PushStore): void {
  const baseUrl = deps.baseUrl || "http://127.0.0.1:4317";
  const pushStore = push ?? new PushStore(baseUrl, deps.dataDir);

  const handler = async (req: HttpReq, res: HttpRes): Promise<void> => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = String(req.method ?? "GET").toUpperCase();
      const path = url.pathname.replace(/^\/pw\/api/, "") || "/";
      const query = url.searchParams;

      /* ---------- 押注台 ---------- */
      if (method === "GET" && path === "/bets") {
        const status = query.get("status") ?? undefined;
        const bets = await fetchBets(baseUrl, status);
        return send(res, 200, { bets });
      }

      if (method === "GET" && path === "/drafts") {
        const drafts = await fetchDrafts(baseUrl);
        return send(res, 200, { drafts });
      }

      const betMatch = path.match(/^\/bets\/([^/]+)$/u);
      if (method === "GET" && betMatch) {
        const betId = decodeURIComponent(betMatch[1] ?? "");
        const [bet, dataDocs, precedents, contextMarkdown] = await Promise.all([
          fetchBet(baseUrl, betId),
          fetchBetDataDocs(baseUrl, betId),
          fetchBetPrecedents(baseUrl, betId),
          fetchBetContext(baseUrl, betId),
        ]);
        return send(res, 200, { ...bet, dataDocs, precedents, contextMarkdown });
      }

      /* ---------- 金子墓碑库 ---------- */
      if (method === "GET" && path === "/verdicts") {
        const outcome = query.get("outcome") ?? undefined;
        const q = query.get("q") ?? undefined;
        const verdicts = await fetchVerdicts(baseUrl, { outcome, q });
        return send(res, 200, { verdicts });
      }

      const evidenceMatch = path.match(/^\/verdicts\/([^/]+)\/evidence$/u);
      if (method === "GET" && evidenceMatch) {
        const evidence = await fetchVerdictEvidence(baseUrl, decodeURIComponent(evidenceMatch[1] ?? ""));
        return send(res, 200, evidence);
      }

      /* ---------- 观众声音 ---------- */
      if (method === "GET" && path === "/voice/themes") {
        const themes = await collectVoiceThemes(baseUrl);
        return send(res, 200, { themes });
      }

      if (method === "GET" && path === "/voice/items") {
        const themeId = query.get("theme") ?? "";
        if (!themeId) return send(res, 400, { ok: false, error: "theme 必填" });
        const detail = await collectVoiceThemeDetail(baseUrl, themeId);
        if (!detail) return send(res, 404, { ok: false, error: `主题不存在：${themeId}` });
        return send(res, 200, detail);
      }

      /* ---------- 大盘笔记 ---------- */
      if (method === "GET" && path === "/notes/today") {
        const [notes, status] = await Promise.all([
          fetchNotes(baseUrl, 50),
          fetchNotesStatus(baseUrl),
        ]);
        return send(res, 200, { notes, status });
      }

      if (method === "GET" && path === "/notes/tree") {
        const tree = await fetchNotesTree(baseUrl);
        return send(res, 200, tree);
      }

      /* ---------- 运维数据源 ---------- */
      if (method === "GET" && path === "/ops/status") {
        const [server, connections, bets, verdicts, docs, drafts, sieve, activity] = await Promise.all([
          fetchServerStatus(baseUrl),
          fetchConnections(baseUrl),
          fetchBets(baseUrl).catch(() => []),
          fetchVerdicts(baseUrl).catch(() => []),
          fetchAllDataDocs(baseUrl).catch(() => []),
          fetchDrafts(baseUrl).catch(() => []),
          fetchSieveCards(baseUrl, "pending").catch(() => []),
          fetchActivityDaily(baseUrl, 7).catch(() => ({})),
        ]);
        const ops = {
          server,
          connections: connections.map((conn: any) => ({
            id: String(conn.id),
            platform: String(conn.platform ?? ""),
            accountLabel: conn.account_label ?? conn.accountLabel ?? null,
            status: conn.status,
            lastSyncAt: conn.last_sync_at ?? conn.lastSyncAt ?? null,
            riskEvents: Array.isArray(conn.risk_events) ? conn.risk_events : [],
            docsCount: Number(conn.docs_count ?? 0),
          })),
          counts: {
            bets: bets.length,
            pendingBets: bets.filter((bet) => bet.status === "pending").length,
            verdicts: verdicts.length,
            dataDocs: docs.length,
            drafts: drafts.length,
            sievePending: sieve.length,
          },
          activity,
          fetchedAt: new Date().toISOString(),
        };
        return send(res, 200, ops);
      }

      /* ---------- 推送区 ---------- */
      if (method === "GET" && path === "/push/feed") {
        return send(res, 200, pushStore.list());
      }

      if (method === "POST" && path === "/push/mark-read") {
        const body = await readBody(req);
        const feed = pushStore.markRead({
          id: typeof body.id === "string" ? body.id : undefined,
          all: body.all === true,
        });
        return send(res, 200, feed);
      }

      /* ---------- 写：AI 起草 ---------- */
      if (method === "POST" && path === "/draft/bet") {
        const body = await readBody(req);
        const result = await createDraft(baseUrl, body as unknown as PwDraftBetInput);
        return send(res, 201, result);
      }

      /* ---------- 写：人点按钮 ---------- */
      if (method === "POST" && path === "/action") {
        const body = await readBody(req);
        const result = await handleAction(baseUrl, body as unknown as PwActionInput, (entry) => {
          appendActionLog(deps.dataDir, entry);
        });
        return send(res, 200, result);
      }

      return send(res, 404, { ok: false, error: `not found: ${method} ${path}` });
    } catch (error) {
      const status = typeof error === "object" && error !== null && "status" in error
        ? Number((error as { status: unknown }).status)
        : 500;
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        send(res, Number.isInteger(status) && status > 0 ? status : 500, { ok: false, error: message });
      } else {
        res.end();
      }
    }
  };

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: "/pw/api",
    handler,
  }), "dsh-paperweight: /pw/api");
}
