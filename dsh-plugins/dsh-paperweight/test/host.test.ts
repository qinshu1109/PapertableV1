/**
 * dsh-paperweight host 半冒烟：起一个假 4317（随机端口）+ 假 Cordis ctx，
 * 验证 /pw/api/* 路由、工具面、命令、systemPrompt、推送收件箱。
 * 不占 3080/4317 生产端口。
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHost } from "../lib/index.js";
import { PW_GUIDE_TEXT } from "../lib/host/guide.js";
import {
  NOTICE_MAX_CHARS,
  buildDegradedNotice,
  buildSuccessNotice,
  trimNoticeText,
  type NoticeSnapshot,
} from "../lib/host/notice-format.js";
import { collectNoticeSnapshot } from "../lib/host/notice.js";
import { PushStore } from "../lib/host/push.js";

/* ------------------------------------------------------------------ */
/* 假 4317                                                             */
/* ------------------------------------------------------------------ */

const BETS = [
  {
    id: "bet-1",
    title: "AI 工作流短视频能成吗",
    thesis: "过程比结论更有留存",
    metric: "三期平均播放",
    metric_target: "≥ 5000",
    confidence: 70,
    data_source_plan: "B站后台人工录入",
    checkout_date: "2026-12-31",
    status: "pending",
    gold_refs_json: "[]",
    created_from: null,
    created_at: "2026-08-04T03:37:08.416Z",
    settled_verdict_id: null,
    kind: "verdict",
    source_card_id: null,
  },
  {
    id: "bet-2",
    title: "已结账旧注",
    thesis: "旧注",
    metric: "播放",
    metric_target: "≥ 1",
    confidence: 60,
    data_source_plan: "人工录入",
    checkout_date: "2020-01-01",
    status: "settled",
    gold_refs_json: "[]",
    created_from: null,
    created_at: "2026-08-04T05:00:46.509Z",
    settled_verdict_id: "verdict-1",
    kind: "verdict",
    source_card_id: null,
  },
];

const VERDICTS = [
  {
    id: "verdict-1",
    bet_id: "bet-2",
    outcome: "tomb",
    lesson: null,
    cause_of_death: "数据没到线",
    evidence_doc_ids_json: '["doc-1"]',
    confidence_snapshot: 60,
    decided_by: "human",
    decided_at: "2026-08-04T03:44:12.534Z",
    created_at: "2026-08-04T03:44:12.538Z",
  },
];

const DOCS = [
  {
    id: "doc-1",
    bet_id: "bet-1",
    artifact_id: null,
    platform: "B站",
    collected_at: "2026-08-04T03:42:38.789Z",
    method: "manual",
    metrics_json: '{"播放":2430,"点赞":96}',
    raw_ref: "截图 2026-08-04",
    source_hash: null,
    version: 1,
    frozen: 0,
    created_at: "2026-08-04T03:42:38.790Z",
    bet_title: "AI 工作流短视频能成吗",
    artifact_title: null,
  },
];

const CORPUS = [{ id: "corpus-1", bvid: "BV1DhpYzSENp", title: "Qoder vs Cursor", up_name: "UP", kinds: "video,comments", status: "done", path: "corpus/BV1DhpYzSENp", sha256: null, video_stat_json: null, comment_count: 79, authorized_by: "ai", error: null, fetched_at: "2026-08-08T20:57:41.589Z", created_at: "2026-08-08T20:57:28.188Z" }];

const VOICE_CARDS = [
  {
    id: "voice-card-1",
    bvid: "BV1DhpYzSENp",
    title: "积分消耗快",
    summary: "用户反馈积分消耗快",
    status: "suggested",
    createdAt: "2026-08-11T10:07:55.904Z",
    items: [
      { rpid: 1, message: "积分不经用", uname: "小明", like: 24, ctime: 1758262103, collected: false, voiceId: null },
    ],
  },
];

const NOTES = [{ uid: "note-1", content: "大盘笔记", createdAt: "2026-08-16T09:00:00+08:00", updatedAt: "2026-08-16T09:00:00+08:00", visibility: "PUBLIC", pinned: false, tags: [], url: "http://127.0.0.1:5230/memos/note-1" }];

const CONNECTIONS = [
  { id: "conn-1", platform: "B站", account_label: "主号", auth_ref: null, status: "active", last_sync_at: "2026-08-16T00:00:00Z", risk_events_json: "[]", created_at: "2026-08-01T00:00:00Z", docs_count: 1 },
  { id: "conn-2", platform: "小红书", account_label: "备用", auth_ref: null, status: "needs_human", last_sync_at: null, risk_events_json: '[{"at":"2026-08-16T00:00:00Z","reason":"验证码"}]', created_at: "2026-08-01T00:00:00Z", docs_count: 0 },
];

const SIEVE_CARDS = [{ id: "card-1", title: "候选卡A", quote_text: "候选卡A原文", quote_source_json: "{}", status: "pending", created_at: "2026-08-16T00:00:00Z" }];

const DRAFTS = [{ id: "draft-1", title: "草稿A", thesis: "假设", metric: "播放", metric_target: "100", confidence: 50, data_source_plan: "人工", checkout_date: "2026-12-01", status: "draft", gold_refs_json: "[]", created_from: "dsh-ai-draft", created_at: "2026-08-16T00:00:00Z", settled_verdict_id: null, kind: "verdict", source_card_id: null }];

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

async function startFake4317(opts?: {
  bets?: any[];
  dueBets?: any[];
  connections?: any[];
}): Promise<{ baseUrl: string; close: () => Promise<void>; created: Array<Record<string, unknown>> }> {
  const bets = opts?.bets ?? BETS;
  const dueBets = opts?.dueBets ?? (opts?.bets !== undefined ? [] : [BETS[0]]);
  const connections = opts?.connections ?? CONNECTIONS;
  const created: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const method = req.method ?? "GET";
    try {
      if (method === "GET" && path === "/api/status") {
        return json(res, 200, { ready: true, node: "v24", modelConfigured: true, protocol: "openai-completions", memory: { available: true }, verdicts: { available: true, pending: 0, failed: 0 } });
      }
      if (method === "GET" && path === "/api/pw/bets") return json(res, 200, { bets });
      if (method === "GET" && path === "/api/pw/bets/due") return json(res, 200, { bets: dueBets });
      const betMatch = path.match(/^\/api\/pw\/bets\/([^/]+)$/u);
      if (method === "GET" && betMatch) {
        const bet = bets.find((item) => item.id === betMatch[1]);
        if (!bet) return json(res, 404, { error: "押注不存在" });
        return json(res, 200, bet);
      }
      const dataDocsMatch = path.match(/^\/api\/pw\/bets\/([^/]+)\/data-docs$/u);
      if (method === "GET" && dataDocsMatch) return json(res, 200, { docs: DOCS });
      const precedentsMatch = path.match(/^\/api\/pw\/bets\/([^/]+)\/precedents$/u);
      if (method === "GET" && precedentsMatch) return json(res, 200, { items: [] });
      const contextMatch = path.match(/^\/api\/pw\/bets\/([^/]+)\/context$/u);
      if (method === "GET" && contextMatch) return json(res, 200, { markdown: "## 有效判断（金子，只读引用）\n- §1 [镇纸·verdict-1] 数据没到线\n", included: [], truncated: false, total: 0 });
      if (method === "GET" && path === "/api/pw/verdicts") return json(res, 200, { verdicts: VERDICTS });
      if (method === "GET" && path === "/api/pw/verdicts/search") return json(res, 200, { verdicts: VERDICTS });
      if (method === "GET" && path === "/api/pw/data-docs") return json(res, 200, { docs: DOCS });
      if (method === "GET" && path === "/api/pw/corpus") return json(res, 200, { items: CORPUS });
      if (method === "GET" && path === "/api/pw/voice/corpus-cards") return json(res, 200, { cards: VOICE_CARDS });
      if (method === "GET" && path === "/api/pw/notes") return json(res, 200, { notes: NOTES });
      if (method === "GET" && path === "/api/pw/notes/status") return json(res, 200, { ok: true, path: "/tmp/memos.db" });
      if (method === "GET" && path === "/api/pw/notes/tree") return json(res, 200, { direction: null, bets: [], unassigned: [] });
      if (method === "GET" && path === "/api/pw/notes/recall") return json(res, 200, { recall: { notes: [], hits: 0 } });
      if (method === "GET" && path === "/api/pw/connections") return json(res, 200, { connections });
      if (method === "GET" && path === "/api/pw/activity-daily") return json(res, 200, { days: [] });
      if (method === "GET" && path === "/api/pw/sieve/cards") return json(res, 200, { cards: SIEVE_CARDS });
      if (method === "GET" && path === "/api/pw/drafts") return json(res, 200, { drafts: DRAFTS });

      if (method === "POST" && path === "/api/pw/drafts") {
        const body = await readJson(req);
        const row = { id: "draft-new", title: String(body.title ?? ""), thesis: String(body.thesis ?? ""), metric: body.metric ?? null, metric_target: body.metric_target ?? null, confidence: body.confidence ?? null, data_source_plan: body.data_source_plan ?? null, checkout_date: body.checkout_date ?? null, status: "draft", gold_refs_json: "[]", created_from: String(body.source ?? "manual"), created_at: new Date().toISOString(), settled_verdict_id: null, kind: body.kind ?? "verdict", source_card_id: body.sourceCardId ?? null };
        created.push(row);
        return json(res, 201, row);
      }
      const pickMatch = path.match(/^\/api\/pw\/sieve\/cards\/([^/]+)\/pick$/u);
      if (method === "POST" && pickMatch) {
        const row = { id: "bet-picked", title: "挑中的押注", thesis: "假设", metric: "私域加群/问工具人数", metric_target: "10", confidence: null, data_source_plan: "私域群/评论区人工统计", checkout_date: "2026-08-23", status: "pending", gold_refs_json: "[]", created_from: null, created_at: new Date().toISOString(), settled_verdict_id: null, kind: "content", source_card_id: pickMatch[1] };
        created.push(row);
        return json(res, 201, row);
      }
      const rejectMatch = path.match(/^\/api\/pw\/sieve\/cards\/([^/]+)\/reject$/u);
      if (method === "POST" && rejectMatch) return json(res, 200, { ok: true });
      const confirmMatch = path.match(/^\/api\/pw\/drafts\/([^/]+)\/confirm$/u);
      if (method === "POST" && confirmMatch) {
        const row = { ...DRAFTS[0], id: confirmMatch[1], status: "pending", draft_hash: "abc123" };
        created.push(row);
        return json(res, 200, row);
      }
      return json(res, 404, { error: `fake 4317 no route: ${method} ${path}` });
    } catch (error) {
      return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake server address missing");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    created,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/* ------------------------------------------------------------------ */
/* 假 Cordis ctx                                                       */
/* ------------------------------------------------------------------ */

function createFakeCtx(): {
  ctx: any;
  routes: Array<{ kind: string; path: string; handler: (req: any, res: any) => Promise<void> }>;
  tools: any[];
  commands: any[];
  sections: any[];
  events: Map<string, Array<(payload: any) => unknown>>;
} {
  const routes: Array<{ kind: string; path: string; handler: (req: any, res: any) => Promise<void> }> = [];
  const tools: any[] = [];
  const commands: any[] = [];
  const sections: any[] = [];
  const events = new Map<string, Array<(payload: any) => unknown>>();
  const ctx = {
    effect: (fn: () => unknown) => { const cleanup = fn(); return typeof cleanup === "function" ? cleanup : undefined; },
    webServer: { register: (route: any) => { routes.push(route); return () => undefined; } },
    tools: { register: (def: any) => { tools.push(def); return () => undefined; } },
    commands: { register: (def: any) => { commands.push(def); return () => undefined; } },
    systemPrompt: { section: (section: any) => { sections.push(section); return () => undefined; } },
    on: (name: string, listener: (payload: any) => unknown) => {
      const list = events.get(name) ?? [];
      list.push(listener);
      events.set(name, list);
      return () => undefined;
    },
    get: () => undefined,
  };
  return { ctx, routes, tools, commands, sections, events };
}

async function callRoute(
  route: { handler: (req: any, res: any) => Promise<void> },
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; payload: any }> {
  let status = 0;
  let payload: any = null;
  const req: any = {
    method,
    url: path,
    [Symbol.asyncIterator]: body === undefined
      ? async function* () { /* empty */ }
      : async function* () { yield Buffer.from(JSON.stringify(body)); },
  };
  const res: any = {
    writeHead(code: number) { status = code; },
    end(data?: unknown) {
      if (data !== undefined && data !== null) payload = JSON.parse(String(data));
    },
  };
  await route.handler(req, res);
  return { status, payload };
}

/* ------------------------------------------------------------------ */
/* 测试                                                                */
/* ------------------------------------------------------------------ */

test("host 冒烟：/pw/api/* 路由 + 工具面 + 命令 + systemPrompt + 推送", async (t) => {
  const fake = await startFake4317();
  const tempDir = mkdtempSync(join(tmpdir(), "dsh-paperweight-smoke-"));
  const { ctx, routes, tools, commands, sections, events } = createFakeCtx();

  const host = createHost(ctx, { baseUrl: fake.baseUrl, dataDir: tempDir });
  await host.push.refresh();

  const apiRoute = routes.find((route) => route.path === "/pw/api");
  assert.ok(apiRoute, "/pw/api 前缀路由已注册");

  /* 押注列表/单卡 */
  let result = await callRoute(apiRoute, "GET", "/pw/api/bets");
  assert.equal(result.status, 200);
  assert.equal(result.payload.bets.length, 2);
  assert.ok(Number.isInteger(result.payload.bets[0].daysToCheckout));
  assert.ok(result.payload.bets[0].daysToCheckout > 0);

  result = await callRoute(apiRoute, "GET", "/pw/api/bets/bet-1");
  assert.equal(result.status, 200);
  assert.equal(result.payload.title, "AI 工作流短视频能成吗");
  assert.equal(result.payload.dataDocs.length, 1);
  assert.ok(result.payload.contextMarkdown.includes("只读引用"));

  /* 草稿列表 */
  result = await callRoute(apiRoute, "GET", "/pw/api/drafts");
  assert.equal(result.status, 200);
  assert.equal(result.payload.drafts.length, 1);
  assert.equal(result.payload.drafts[0].id, "draft-1");
  assert.equal(result.payload.drafts[0].status, "draft");
  assert.match(result.payload.drafts[0].draftHash, /^[0-9a-f]{64}$/u);

  /* 判决/证据 */
  result = await callRoute(apiRoute, "GET", "/pw/api/verdicts");
  assert.equal(result.payload.verdicts.length, 1);
  result = await callRoute(apiRoute, "GET", "/pw/api/verdicts/verdict-1/evidence");
  assert.equal(result.payload.verdict.id, "verdict-1");
  assert.equal(result.payload.evidence.length, 1);

  /* 观众声音 */
  result = await callRoute(apiRoute, "GET", "/pw/api/voice/themes");
  assert.equal(result.payload.themes.length, 1);
  result = await callRoute(apiRoute, "GET", "/pw/api/voice/items?theme=voice-card-1");
  assert.equal(result.payload.items[0].message, "积分不经用");

  /* 笔记/运维 */
  result = await callRoute(apiRoute, "GET", "/pw/api/notes/today");
  assert.equal(result.payload.notes[0].uid, "note-1");
  result = await callRoute(apiRoute, "GET", "/pw/api/ops/status");
  assert.equal(result.payload.counts.bets, 2);
  assert.equal(result.payload.connections[0].platform, "B站");

  /* 推送：TASK-PW-74 停产 daily；仍产出实体仍在的 due + needs_human */
  result = await callRoute(apiRoute, "GET", "/pw/api/push/feed");
  assert.equal(result.status, 200);
  assert.ok(result.payload.items.length >= 2, `推送条目应含 due/needs_human，实际 ${result.payload.items.length}`);
  const kinds = new Set(result.payload.items.map((item: any) => item.kind));
  assert.equal(kinds.has("daily"), false);
  assert.ok(kinds.has("due"));
  assert.ok(kinds.has("needs_human"));
  assert.ok(result.payload.unread >= 2);
  result = await callRoute(apiRoute, "POST", "/pw/api/push/mark-read", { all: true });
  assert.equal(result.payload.unread, 0);

  /* 写：AI 起草（落 draft + draft_hash） */
  result = await callRoute(apiRoute, "POST", "/pw/api/draft/bet", {
    title: "起草测试",
    thesis: "假设",
    metric: "播放",
    metricTarget: "100",
  });
  assert.equal(result.status, 201);
  assert.equal(result.payload.draft.status, "draft");
  assert.match(result.payload.draftHash, /^[0-9a-f]{64}$/u);

  /* 写：人点按钮（挑/否/确认） */
  result = await callRoute(apiRoute, "POST", "/pw/api/action", {
    action: "pick",
    targetId: "card-1",
  });
  assert.equal(result.payload.source, "human-click");
  assert.equal(result.payload.result.id, "bet-picked");

  result = await callRoute(apiRoute, "POST", "/pw/api/action", {
    action: "reject",
    targetId: "card-1",
    reason: "否",
  });
  assert.equal(result.payload.ok, true);

  result = await callRoute(apiRoute, "POST", "/pw/api/action", {
    action: "confirm",
    targetId: "draft-1",
  });
  assert.equal(result.payload.result.draft_hash, "abc123");

  /* 工具面：8 只读 + 1 起草；无 settle/confirm/verdict 写 schema */
  const names = tools.map((tool: any) => tool.name);
  assert.deepEqual(
    [...names].sort(),
    ["pw_draft_bet", "pw_list_bets", "pw_ops_status", "pw_query_voice", "pw_read_bet", "pw_read_data_docs", "pw_read_verdict_evidence", "pw_recall_notes", "pw_search_verdicts"].sort(),
  );
  for (const name of names) {
    assert.ok(!/settle|confirm|verdict_settle|settle_bet|confirm_bet/u.test(name), `禁止工具名：${name}`);
  }

  /* 工具真实 execute + 输出契约：对象 schema、lossless JSON、可渲染。 */
  for (const [name, args] of [
    ["pw_read_bet", { betId: "bet-1" }],
    ["pw_read_data_docs", { betId: "bet-1" }],
    ["pw_ops_status", {}],
  ] as const) {
    const definition = tools.find((item: any) => item.name === name);
    assert.ok(definition, `工具已注册：${name}`);
    assert.equal(definition.output.schema.type, "object");
    const value = await definition.execute(args);
    assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${name} 返回 lossless JSON`);
    const content = definition.output.render(args, value);
    assert.equal(content[0]?.type, "text");
    assert.ok(content[0]?.text.length > 0);
  }

  /* 命令 + 两个 systemPrompt 段；导览注册值逐字节等于定稿常量。 */
  assert.ok(commands.some((command: any) => command.name === "bets"));
  const guide = sections.find((section: any) => section.name === "papertable:workbench-guide");
  assert.ok(guide);
  assert.equal(guide.order, 110);
  assert.equal(guide.text, PW_GUIDE_TEXT);
  assert.ok(sections.some((section: any) => section.name === "papertable:write-boundary"));
  assert.ok(sections.some((section: any) => section.text.includes("没有 settle/confirm/verdict 写工具")));

  /* session-start：同步抢 maintenance，成功注入 identified plugin notice。 */
  const listeners = events.get("agent/session-start") ?? [];
  assert.equal(listeners.length, 1);
  const injected: any[] = [];
  let maintenance: Promise<void> | undefined;
  listeners[0]?.({
    agent: {
      inject: (message: unknown) => injected.push(message),
      runMaintenance: (task: (signal: AbortSignal) => Promise<void>) => {
        maintenance = task(new AbortController().signal);
        return maintenance;
      },
    },
  });
  assert.ok(maintenance, "listener 同步调用 runMaintenance");
  await maintenance;
  assert.equal(injected.length, 1);
  assert.equal(injected[0]?.source?.kind, "plugin");
  assert.equal(injected[0]?.source?.plugin, "dsh-paperweight");
  assert.equal(injected[0]?.source?.form, "notice");
  assert.match(injected[0]?.content?.[0]?.text ?? "", /镇纸开场快照/u);

  await fake.close();
});

test("PW-74：refresh 停产 daily；空押注与 404 押注不产 due；陈旧 daily/due 被清掉", async (t) => {
  const emptyFake = await startFake4317({ bets: [], dueBets: [], connections: [] });
  t.after(() => emptyFake.close());
  const emptyPush = new PushStore(emptyFake.baseUrl, mkdtempSync(join(tmpdir(), "dsh-paperweight-empty-")));
  await emptyPush.refresh();
  const emptyList = emptyPush.list();
  assert.equal(emptyList.items.filter((item) => item.kind === "daily").length, 0);
  assert.equal(emptyList.items.filter((item) => item.kind === "due").length, 0);
  assert.equal(emptyList.unread, emptyList.items.filter((item) => !item.read).length);

  const ghost = { ...BETS[0], id: "ghost-bet", title: "已消失的押注" };
  const ghostFake = await startFake4317({ bets: [], dueBets: [ghost], connections: [] });
  t.after(() => ghostFake.close());
  const ghostPush = new PushStore(ghostFake.baseUrl, mkdtempSync(join(tmpdir(), "dsh-paperweight-ghost-")));
  await ghostPush.refresh();
  const ghostList = ghostPush.list();
  assert.equal(ghostList.items.filter((item) => item.kind === "due").length, 0);
  assert.equal(ghostList.items.filter((item) => item.kind === "daily").length, 0);

  const staleFake = await startFake4317({ bets: [], dueBets: [], connections: [] });
  t.after(() => staleFake.close());
  const staleDir = mkdtempSync(join(tmpdir(), "dsh-paperweight-stale-"));
  const feedDir = join(staleDir, "papertable", "dsh-paperweight");
  mkdirSync(feedDir, { recursive: true });
  writeFileSync(join(feedDir, "push-feed.json"), JSON.stringify({
    lastDailyDate: "2026-08-25",
    items: [
      {
        id: "daily:2026-08-25:old",
        kind: "daily",
        title: "今日值得看",
        summary: "陈旧",
        sourceRefs: [],
        date: "2026-08-25",
        createdAt: "2026-08-25T00:00:00.000Z",
        read: false,
      },
      {
        id: "due:gone:2026-08-25",
        kind: "due",
        title: "押注到期待裁决：gone",
        summary: "陈旧",
        sourceRefs: [{ type: "bet", id: "gone", label: "gone" }],
        date: "2026-08-25",
        createdAt: "2026-08-25T00:00:00.000Z",
        read: false,
      },
    ],
  }));
  const stalePush = new PushStore(staleFake.baseUrl, staleDir);
  assert.ok(stalePush.list().items.some((item) => item.kind === "daily"));
  await stalePush.refresh();
  const staleList = stalePush.list();
  assert.equal(staleList.items.filter((item) => item.kind === "daily").length, 0);
  assert.equal(staleList.items.filter((item) => item.kind === "due").length, 0);
});

function emptyPush(): NoticeSnapshot["push"] {
  return { items: [], unread: 0 };
}

test("notice：成功、部分失败、降级与截断顺序", () => {
  const dueBet = {
    ...BETS[0],
    id: "due-1",
    title: "已经到期的真实押注",
    checkoutDate: "2026-08-16",
    checkout_date: "2026-08-16",
    daysToCheckout: 0,
    metricTarget: "≥ 5000",
    dataSourcePlan: "B站后台人工录入",
    sourceCardId: null,
    createdAt: "2026-08-04T03:37:08.416Z",
    settledVerdictId: null,
  } as any;
  const snapshot: NoticeSnapshot = {
    pending: [dueBet],
    due: [dueBet],
    drafts: { length: 1 },
    sievePending: { length: 2 },
    connections: [{ id: "conn-2", platform: "小红书", status: "needs_human" }],
    verdicts: [{
      id: "verdict-1",
      betId: "bet-2",
      outcome: "tomb",
      lesson: null,
      causeOfDeath: "数据没到线",
      decidedAt: "2026-08-04T03:44:12.534Z",
    }],
    push: emptyPush(),
  };
  const success = buildSuccessNotice(snapshot, new Date("2026-08-17T08:00:00+08:00"));
  assert.equal(success.degraded, false);
  assert.match(success.text, /到期待裁决 1 注/u);
  assert.match(success.text, /已过期/u);
  assert.match(success.text, /先处理到期待裁决/u);
  assert.ok([...success.text].length <= NOTICE_MAX_CHARS);

  const partial = buildSuccessNotice({ ...snapshot, verdicts: null });
  assert.equal(partial.degraded, false);
  assert.match(partial.text, /近金子：未取到/u);
  assert.match(partial.text, /近墓碑：未取到/u);

  const degraded = buildDegradedNotice("timeout 4s\nstack ignored");
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.summary, "镇纸快照不可用");
  assert.doesNotMatch(degraded.text, /\n/u);

  const skeleton = [
    "在途 1 注：",
    "1.《pending》id=pending-1 结账2026-09-01 置信50% 还剩15天",
    "到期待裁决 1 注：",
    "1.《due》id=due-1 结账2026-08-16 置信60% 已过期",
    "未读推送 0 条（今日值得看 0 / 到期提醒 0 / 等人工 0）",
  ].join("\n");
  const padding = "甲".repeat(NOTICE_MAX_CHARS - [...skeleton].length + 10);
  const trimmed = trimNoticeText(`${skeleton}\n${padding}`);
  assert.ok([...trimmed].length <= NOTICE_MAX_CHARS);
  assert.doesNotMatch(trimmed, /id=due-1/u, "超长时先砍 dueList");
  assert.match(trimmed, /id=pending-1/u, "pendingTail 在 dueList 之后才砍");
});

test("notice：外层 AbortSignal 能在预算内终止全部 4317 拉取", async (t) => {
  const server = createServer(() => { /* 故意不响应，等待 signal 中止 */ });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.closeAllConnections());
  t.after(() => server.close());
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("slow server address missing");
  const dataDir = mkdtempSync(join(tmpdir(), "dsh-paperweight-timeout-"));
  const push = new PushStore(`http://127.0.0.1:${address.port}`, dataDir);
  const started = Date.now();
  await assert.rejects(
    collectNoticeSnapshot(`http://127.0.0.1:${address.port}`, push, AbortSignal.timeout(60)),
    /timeout 4s/u,
  );
  assert.ok(Date.now() - started < 1_000, `外层预算未传到底层 fetch：${Date.now() - started}ms`);
});
