/**
 * TASK-PW-76：搜证智能体测试（假模型 + 假工具端点，不碰网络）。
 * 覆盖：密钥硬替换 / URL 规范化与去重键 / 引言校验 / JSON 提取 / 阶段一解析 / 证据校验（未知 URL 丢弃、
 * 引言不符清空、热度夹取、去重排序）/ 五个工具适配器字段映射与异常 / 端到端：原文密钥绝不进工具请求、
 * 工具入参来自脱敏产物、最终校验 / 跳过路径 / JSON 修复路径 / 双失败抛错。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalUrl,
  collectEvidence,
  dedupKey,
  DEFAULT_STATUS_PROVIDERS,
  DEFAULT_X_SEARCH_URL,
  executeTool,
  extractJsonObject,
  hardRedactSecrets,
  normalizeTopicKey,
  parsePhase1,
  quoteVerified,
  UrlRegistry,
  validateEvidence,
  type CollectorConfig,
  type CollectorDeps,
  type ToolHit,
} from "./pw-evidence-collector.ts";

function config(overrides: Partial<CollectorConfig> = {}): CollectorConfig {
  return {
    model: { baseUrl: "https://cozai.test/v1", apiKey: "sk-model", model: "glm-5.3-flash" },
    exaApiKey: "exa-key",
    xApiKey: "x-key",
    xSearchUrl: DEFAULT_X_SEARCH_URL,
    githubToken: "gh-token",
    statusProviders: { ...DEFAULT_STATUS_PROVIDERS },
    denyTerms: ["sub2api-prod"],
    maxToolRounds: 4,
    timeBudgetMs: 60_000,
    maxResultsPerTool: 5,
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

type Captured = { url: string; body: string; headers: Record<string, string> };

/** 路由式假 fetch：按 URL 前缀分发；模型端点按队列依次返回。 */
function makeFetch(routes: Record<string, (req: Captured) => Response | Promise<Response>>, captured: Captured[]) {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers as Record<string, string> | undefined;
    if (rawHeaders) for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = v;
    const req: Captured = { url, body: typeof init?.body === "string" ? init.body : "", headers };
    captured.push(req);
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return handler(req);
    }
    return new Response("no route", { status: 599 });
  };
  return fetchImpl;
}

function deps(fetchImpl: typeof fetch, logs: Array<Record<string, unknown>> = []): CollectorDeps {
  return { fetch: fetchImpl, now: () => new Date(2026, 8, 6, 12, 0), log: (f) => logs.push(f) };
}

function assistantJson(obj: unknown): Response {
  return json({ choices: [{ message: { role: "assistant", content: JSON.stringify(obj) } }] });
}

function assistantToolCalls(calls: Array<{ id: string; name: string; args: unknown }>): Response {
  return json({
    choices: [{
      message: {
        role: "assistant",
        content: null,
        tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })),
      },
    }],
  });
}

// ---------------------------------------------------------------------------

test("hardRedactSecrets：8 类密钥模式 + 字面内部词；普通文本不动", () => {
  const raw = "sk-abcdefghijklmnopqrstuvwxyz012345 leaked; AKIAABCDEFGHIJKLMNOP; token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop; Bearer 0123456789abcdefghij; https://u:p@host/x; sub2api-prod 挂了 gemini 429";
  const out = hardRedactSecrets(raw, ["sub2api-prod"]);
  assert.ok(!out.text.includes("sk-abcdefghijklmnop"), out.text);
  assert.ok(!out.text.includes("AKIAABCDEFGHIJKLMNOP"));
  assert.ok(!out.text.includes("eyJhbGciOiJIUzI1NiJ9"));
  assert.ok(out.text.includes("Bearer 【KEY】"));
  assert.ok(out.text.includes("https://【CRED】@host/x"));
  assert.ok(out.text.includes("【内部】 挂了 gemini 429"));
  assert.equal(out.hits, 6);
  assert.deepEqual(hardRedactSecrets("gemini 2.5 pro 429 配额页没超"), { text: "gemini 2.5 pro 429 配额页没超", hits: 0 });
});

test("canonicalUrl / dedupKey：去追踪参数与 fragment、平台 ID 优先", () => {
  assert.equal(canonicalUrl("https://WWW.Example.com/a/b/?utm_source=x&id=1#frag"), "https://example.com/a/b/?id=1");
  assert.equal(dedupKey("https://github.com/googleapis/python-genai/issues/1234?x=1", "github"), "github:googleapis/python-genai#1234");
  assert.equal(dedupKey("https://news.ycombinator.com/item?id=987", "hn"), "hn:987");
  assert.equal(dedupKey("https://x.com/someone/status/1234567890", "x"), "x:1234567890");
  assert.equal(dedupKey("https://twitter.com/someone/status/1234567890", "x"), "x:1234567890");
  assert.equal(dedupKey("https://status.openai.com/incidents/abc", "status"), "status:status.openai.com/incidents/abc");
  assert.equal(dedupKey("https://blog.example.com/post/", "exa"), "url:blog.example.com/post");
});

test("quoteVerified：归一化空白与大小写后必须是登记文本子串", () => {
  const hit: ToolHit = { source: "github", url: "https://github.com/a/b/issues/1", title: "429 despite quota", text: "We keep getting  429 RESOURCE_EXHAUSTED\neven with headroom.", metrics: {} };
  assert.equal(quoteVerified("429 resource_exhausted even with headroom", hit), true);
  assert.equal(quoteVerified("429 despite QUOTA", hit), true, "标题也算");
  assert.equal(quoteVerified("完全不存在的句子", hit), false);
  assert.equal(quoteVerified("", hit), false);
});

test("extractJsonObject：围栏 / 裸对象 / 前后废话 / 垃圾", () => {
  assert.deepEqual(extractJsonObject("```json\n{\"a\":1}\n```"), { a: 1 });
  assert.deepEqual(extractJsonObject("好的，结果是 {\"a\":{\"b\":2}} 以上"), { a: { b: 2 } });
  assert.equal(extractJsonObject("no json here"), undefined);
  assert.equal(extractJsonObject("[1,2,3]"), undefined, "数组不算对象");
});

test("normalizeTopicKey / parsePhase1：键归一化与字段兜底", () => {
  assert.equal(normalizeTopicKey("Gemini / 429 Quota!"), "gemini-/-429-quota");
  assert.equal(normalizeTopicKey("gemini/429"), "gemini/429");
  assert.equal(normalizeTopicKey("nokey"), "misc/uncategorized", "没有斜杠回落");
  assert.equal(normalizeTopicKey(42, "x/y"), "x/y");
  const plan = parsePhase1({ worthSearching: true, redactedNote: " r ", entities: { vendors: ["Google"] }, queries: { en: ["a", "b", "c", "d"] }, topicKey: "gemini/429", statusProviders: ["Google-Cloud"] }, "fallback");
  assert.equal(plan.redactedNote, "r");
  assert.deepEqual(plan.entities.vendors, ["Google"]);
  assert.deepEqual(plan.entities.symptoms, []);
  assert.deepEqual(plan.queries.en, ["a", "b", "c"], "最多 3 条");
  assert.deepEqual(plan.statusProviders, ["google-cloud"]);
  const empty = parsePhase1({}, "fb");
  assert.equal(empty.worthSearching, false);
  assert.equal(empty.redactedNote, "fb");
  assert.equal(empty.topicKey, "misc/uncategorized");
});

test("validateEvidence：未知 URL 丢弃 / 引言不符清空 / 热度夹取与缺省 / 去重 / 按热度排序 / 最多 8 条", () => {
  const registry = new UrlRegistry();
  registry.add({ source: "github", url: "https://github.com/a/b/issues/1", title: "Issue one", text: "body one with 429", metrics: { comments: 12 }, publishedAt: "2026-09-01" });
  registry.add({ source: "status", url: "https://status.openai.com/incidents/x1", title: "Elevated errors", text: "investigating", metrics: {} });
  for (let i = 0; i < 10; i += 1) {
    registry.add({ source: "exa", url: `https://blog.test/p${i}`, title: `p${i}`, text: "t", metrics: {} });
  }
  const raw = {
    evidence: [
      { url: "https://github.com/a/b/issues/1?utm_source=z", title: "Issue one", source: "github", quote: "body one WITH 429", heat: 150, why: "w" },
      { url: "https://github.com/a/b/issues/1", title: "dup", heat: 10 },
      { url: "https://status.openai.com/incidents/x1", quote: "这句不存在", heat: "not a number" },
      { url: "https://made-up.test/nowhere", title: "hallucinated", heat: 99 },
      ...Array.from({ length: 10 }, (_, i) => ({ url: `https://blog.test/p${i}`, heat: i })),
    ],
  };
  const out = validateEvidence(raw, registry);
  assert.equal(out.droppedUnknownUrl, 1);
  assert.equal(out.quotesCleared, 1);
  assert.equal(out.items.length, 8, "封顶 8");
  assert.equal(out.items[0].key, "github:a/b#1");
  assert.equal(out.items[0].heat, 100, "夹到 100");
  assert.equal(out.items[0].quoteVerified, true);
  assert.equal(out.items[0].tier, "T1");
  const status = out.items.find((i) => i.source === "status");
  assert.ok(status);
  assert.equal(status.heat, 60, "状态页热度缺省 60");
  assert.equal(status.quote, "");
  assert.equal(status.tier, "T0");
  assert.equal(out.items.filter((i) => i.key === "github:a/b#1").length, 1, "去重");
  for (let i = 1; i < out.items.length; i += 1) assert.ok(out.items[i - 1].heat >= out.items[i].heat, "按热度降序");
});

test("executeTool：五个适配器的字段映射；未知工具与 HTTP 错误转 ok=false", async () => {
  const captured: Captured[] = [];
  const fetchImpl = makeFetch({
    "https://api.exa.ai/search": () => json({ results: [{ url: "https://cloud.google.com/blog/x", title: "Gemini quota update", publishedDate: "2026-09-02T00:00:00Z", text: "We changed quota handling.", author: "Google" }] }),
    "https://api.twitterapi.io/": () => json({ tweets: [{ id: "111", url: "https://x.com/dev/status/111", text: "Gemini 429 again", createdAt: "Sat Sep 05 10:00:00 +0000 2026", likeCount: 42, retweetCount: 5, replyCount: 3, author: { userName: "dev", followers: 1200, createdAt: "2019-01-01" } }] }),
    "https://api.github.com/search/issues": () => json({ items: [{ html_url: "https://github.com/g/p/issues/9", title: "429 RESOURCE_EXHAUSTED", body: "Getting 429 with headroom", created_at: "2026-09-01T00:00:00Z", comments: 17, reactions: { total_count: 20 }, user: { login: "u" }, repository_url: "https://api.github.com/repos/g/p" }] }),
    "https://hn.algolia.com/": () => json({ hits: [{ objectID: "555", title: "Gemini API rate limits", url: "https://example.com/a", points: 120, num_comments: 44, author: "pg", created_at: "2026-09-03T00:00:00Z" }] }),
    "https://status.openai.com/": () => json({ incidents: [{ id: "inc1", name: "Elevated 429s", status: "resolved", impact: "minor", created_at: "2026-09-04T00:00:00Z", shortlink: "https://stspg.io/abc", incident_updates: [{ body: "Resolved." }] }, { id: "old", name: "Ancient", created_at: "2020-01-01T00:00:00Z", incident_updates: [] }] }),
    "https://status.cloud.google.com/": () => json([{ id: "g1", begin: "2026-09-05T00:00:00Z", external_desc: "Vertex AI elevated errors", uri: "incidents/g1", severity: "medium", affected_products: [{ title: "Vertex AI" }], most_recent_update: { text: "Mitigated" } }]),
  }, captured);
  const d = deps(fetchImpl);
  const cfg = config();
  const registry = new UrlRegistry();

  const exa = await executeTool("exa_search", { query: "gemini quota", sinceDays: 14, includeDomains: ["cloud.google.com"] }, cfg, d, registry);
  assert.equal(exa.ok, true);
  assert.equal(exa.hits[0].source, "exa");
  assert.equal(exa.hits[0].publishedAt, "2026-09-02");
  const exaReq = captured.find((c) => c.url.startsWith("https://api.exa.ai"))!;
  assert.equal(exaReq.headers["x-api-key"], "exa-key");
  assert.ok(exaReq.body.includes("\"includeDomains\":[\"cloud.google.com\"]"));
  assert.ok(exaReq.body.includes("startPublishedDate"));

  const x = await executeTool("x_search", { query: "gemini 429" }, cfg, d, registry);
  assert.equal(x.ok, true);
  assert.equal(x.hits[0].url, "https://x.com/dev/status/111");
  assert.equal(x.hits[0].metrics.likes, 42);
  assert.equal(x.hits[0].publishedAt, "2026-09-05");
  assert.equal(captured.find((c) => c.url.startsWith("https://api.twitterapi.io"))!.headers["x-api-key"], "x-key");

  const gh = await executeTool("github_search", { query: "429 RESOURCE_EXHAUSTED" }, cfg, d, registry);
  assert.equal(gh.ok, true);
  assert.equal(gh.hits[0].metrics.comments, 17);
  assert.equal(gh.hits[0].metrics.reactions, 20);
  assert.equal(gh.hits[0].author?.repo, "g/p");
  const ghReq = captured.find((c) => c.url.startsWith("https://api.github.com"))!;
  assert.ok(decodeURIComponent(ghReq.url).includes("is:issue created:>=2026-08-07"), ghReq.url);
  assert.equal(ghReq.headers.authorization, "Bearer gh-token");

  const hn = await executeTool("hn_search", { query: "gemini" }, cfg, d, registry);
  assert.equal(hn.ok, true);
  assert.equal(hn.hits[0].url, "https://news.ycombinator.com/item?id=555");
  assert.equal(hn.hits[0].metrics.points, 120);

  const st = await executeTool("status_incidents", { provider: "OpenAI" }, cfg, d, registry);
  assert.equal(st.ok, true);
  assert.equal(st.hits.length, 1, "2020 年的事件被时间窗过滤");
  assert.equal(st.hits[0].url, "https://stspg.io/abc");
  assert.equal(st.hits[0].source, "status");

  const gc = await executeTool("status_incidents", { provider: "google-cloud" }, cfg, d, registry);
  assert.equal(gc.ok, true);
  assert.equal(gc.hits[0].url, "https://status.cloud.google.com/incidents/g1");
  assert.ok(gc.hits[0].text.includes("Vertex AI"));

  assert.equal(registry.size, 6, "六条 URL 全部登记");

  const unknown = await executeTool("nope", {}, cfg, d, registry);
  assert.equal(unknown.ok, false);
  const badProvider = await executeTool("status_incidents", { provider: "aws" }, cfg, d, registry);
  assert.equal(badProvider.ok, false);
  assert.match(badProvider.error ?? "", /未知 provider/);
  const noKey = await executeTool("exa_search", { query: "q" }, config({ exaApiKey: undefined }), d, registry);
  assert.equal(noKey.ok, false);
  assert.match(noKey.error ?? "", /exaApiKey 未配置/);

  const failing = makeFetch({ "https://api.github.com/": () => new Response("rate limited", { status: 403 }) }, []);
  const err = await executeTool("github_search", { query: "q" }, cfg, deps(failing), registry);
  assert.equal(err.ok, false);
  assert.match(err.error ?? "", /HTTP 403/);
});

test("collectEvidence 端到端：原文密钥不进任何工具请求；工具入参来自脱敏产物；最终校验与统计", async () => {
  const captured: Captured[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const modelQueue: Array<() => Response> = [
    () => assistantJson({
      worthSearching: true,
      reason: "限流现象",
      redactedNote: "gemini 2.5 pro 429 配额页没超，【内部】网关在 【IP】 上切 vertex 才好",
      entities: { vendors: ["Google"], products: ["Gemini 2.5 Pro", "Vertex AI"], errorCodes: ["429", "RESOURCE_EXHAUSTED"], symptoms: ["quota headroom"] },
      queries: { en: ["gemini 429 RESOURCE_EXHAUSTED quota not exceeded"], zh: ["gemini 429 配额未超"] },
      topicKey: "gemini/429",
      statusProviders: ["google-cloud"],
    }),
    () => assistantToolCalls([
      { id: "c1", name: "status_incidents", args: { provider: "google-cloud", sinceDays: 30 } },
      { id: "c2", name: "github_search", args: { query: "gemini 429 RESOURCE_EXHAUSTED quota not exceeded", sinceDays: 30 } },
    ]),
    () => assistantJson({
      topicKey: "gemini/429",
      evidence: [
        { url: "https://github.com/g/p/issues/9", title: "429 RESOURCE_EXHAUSTED", source: "github", publishedAt: "2026-09-01", quote: "Getting 429 with headroom", metrics: { comments: 17 }, heat: 72, why: "同样报错" },
        { url: "https://status.cloud.google.com/incidents/g1", title: "Vertex AI elevated errors", source: "status", quote: "编造的引言", heat: 65, why: "官方事件" },
        { url: "https://nowhere.test/fake", title: "fake", source: "exa", heat: 90 },
      ],
      summary: "Gemini 429 与官方事件时间吻合",
    }),
  ];
  const fetchImpl = makeFetch({
    "https://cozai.test/v1/chat/completions": () => {
      const next = modelQueue.shift();
      if (!next) throw new Error("模型队列耗尽");
      return next();
    },
    "https://status.cloud.google.com/": () => json([{ id: "g1", begin: "2026-09-05T00:00:00Z", external_desc: "Vertex AI elevated errors", uri: "incidents/g1", severity: "medium", affected_products: [{ title: "Vertex AI" }] }]),
    "https://api.github.com/search/issues": () => json({ items: [{ html_url: "https://github.com/g/p/issues/9", title: "429 RESOURCE_EXHAUSTED", body: "Getting 429 with headroom", created_at: "2026-09-01T00:00:00Z", comments: 17, reactions: { total_count: 2 }, user: { login: "u" } }] }),
  }, captured);

  const secret = "sk-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
  const raw = `gemini 2.5 pro 429 配额页没超，sub2api-prod 网关在 10.0.0.8 上用 ${secret} 切 vertex 才好`;
  const result = await collectEvidence(raw, config(), deps(fetchImpl, logs));

  // 密钥在进模型前就被硬替换；内部词被字面替换
  const phase1Req = captured[0];
  assert.ok(phase1Req.url.includes("/chat/completions"));
  assert.ok(!phase1Req.body.includes(secret), "密钥不得进模型");
  assert.ok(phase1Req.body.includes("【KEY】"));
  assert.ok(phase1Req.body.includes("【内部】"));
  assert.ok(phase1Req.body.includes("\"response_format\""), "阶段一走 json_object");

  // 所有工具请求都不含原文中的 IP、密钥、内部词
  const toolReqs = captured.filter((c) => !c.url.includes("/chat/completions"));
  assert.equal(toolReqs.length, 2);
  for (const req of toolReqs) {
    const blob = `${req.url} ${req.body}`;
    assert.ok(!blob.includes("10.0.0.8"), "IP 不得进工具");
    assert.ok(!blob.includes(secret));
    assert.ok(!blob.includes("sub2api-prod"));
  }
  // 阶段二 user 消息里也没有原文
  const phase2Req = captured.find((c, i) => i > 0 && c.url.includes("/chat/completions"))!;
  assert.ok(!phase2Req.body.includes("10.0.0.8"));
  assert.ok(phase2Req.body.includes("\"tools\""));

  assert.equal(result.skipped, false);
  assert.equal(result.topicKey, "gemini/429");
  assert.equal(result.hardRedactions, 2);
  assert.equal(result.evidence.length, 2, "编造 URL 被丢");
  assert.equal(result.stats.droppedUnknownUrl, 1);
  assert.equal(result.stats.quotesCleared, 1, "状态页那条编造引言被清空");
  assert.equal(result.stats.toolCalls, 2);
  assert.equal(result.stats.toolErrors, 0);
  const gh = result.evidence.find((e) => e.source === "github")!;
  assert.equal(gh.quoteVerified, true);
  assert.equal(gh.metrics.comments, 17, "指标来自工具返回，不来自模型");
  assert.equal(gh.heat, 72);
  assert.equal(result.summary, "Gemini 429 与官方事件时间吻合");
  assert.ok(logs.some((l) => l.event === "evidence_plan"));
  assert.equal(logs.filter((l) => l.event === "evidence_tool").length, 2);
});

test("collectEvidence：阶段一判定不值得搜 → 零工具调用、skipped=true", async () => {
  const captured: Captured[] = [];
  const fetchImpl = makeFetch({
    "https://cozai.test/v1/chat/completions": () => assistantJson({ worthSearching: false, reason: "个人待办", redactedNote: "明天买牛奶", entities: {}, queries: {}, topicKey: "" }),
  }, captured);
  const result = await collectEvidence("明天买牛奶", config(), deps(fetchImpl));
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "个人待办");
  assert.equal(result.topicKey, "misc/uncategorized");
  assert.equal(captured.length, 1, "只有阶段一一次调用");
});

test("collectEvidence：最终输出不是 JSON → 一次修复；修复也失败 → 抛错", async () => {
  let queue: Array<() => Response> = [
    () => assistantJson({ worthSearching: true, redactedNote: "x 429", entities: {}, queries: { en: ["x"] }, topicKey: "x/429" }),
    () => json({ choices: [{ message: { role: "assistant", content: "这是我的总结，没有 JSON" } }] }),
    () => assistantJson({ topicKey: "x/429", evidence: [], summary: "repaired" }),
  ];
  const fetchImpl = makeFetch({ "https://cozai.test/v1/chat/completions": () => queue.shift()!() }, []);
  const ok = await collectEvidence("x 429", config(), deps(fetchImpl));
  assert.equal(ok.summary, "repaired");
  assert.equal(ok.evidence.length, 0);

  queue = [
    () => assistantJson({ worthSearching: true, redactedNote: "x 429", entities: {}, queries: {}, topicKey: "x/429" }),
    () => json({ choices: [{ message: { role: "assistant", content: "no json" } }] }),
    () => json({ choices: [{ message: { role: "assistant", content: "still no json" } }] }),
  ];
  await assert.rejects(collectEvidence("x 429", config(), deps(fetchImpl)), /未能产出合法 JSON/);
});

test("collectEvidence：工具轮次用尽仍在调工具 → 强制收口一次", async () => {
  const queue: Array<() => Response> = [
    () => assistantJson({ worthSearching: true, redactedNote: "x 429", entities: {}, queries: { en: ["x"] }, topicKey: "x/429" }),
    () => assistantToolCalls([{ id: "a", name: "hn_search", args: { query: "x" } }]),
    () => assistantToolCalls([{ id: "b", name: "hn_search", args: { query: "x again" } }]),
    () => assistantJson({ topicKey: "x/429", evidence: [], summary: "closed" }),
  ];
  const fetchImpl = makeFetch({
    "https://cozai.test/v1/chat/completions": () => queue.shift()!(),
    "https://hn.algolia.com/": () => json({ hits: [] }),
  }, []);
  const result = await collectEvidence("x 429", config({ maxToolRounds: 2 }), deps(fetchImpl));
  assert.equal(result.summary, "closed");
  assert.equal(result.stats.toolCalls, 2);
});
