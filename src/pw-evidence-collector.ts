/**
 * TASK-PW-76：飞书端搜证智能体（glm-5.3-flash 驱动，工具调用）。
 *
 * 一句速记进来，两阶段：
 *   阶段一「脱敏与规划」：模型只看速记，输出脱敏后的文本、公开可搜实体、查询计划、是否值得搜。无工具。
 *   阶段二「搜证」：模型只拿到阶段一的脱敏产物（原文不再出现），用 5 个工具打捞外部证据，最终输出 JSON。
 *
 * 结构性保证（不靠 Prompt 措辞）：
 * - 原文只送到你自己的模型端点；所有工具调用的入参来自阶段一的脱敏产物，代码层面原文不可能进入搜索请求。
 * - 密钥类字符串在进模型之前先做一次高精度硬替换（8 个模式）——这是唯一保留的正则，理由是泄露不可逆。
 * - 模型给的每条证据 URL 必须在本轮工具返回过（URL 登记簿），否则丢弃；引言必须是该 URL 文本的逐字子串，否则清空。
 *   模型负责判断相关性、清洗、打热度分；代码负责记账，不让它凭空造 URL 和引言。
 * - 不做多模型互锤，不做出稿。到「结构化证据」为止。
 */

// ---------------------------------------------------------------------------
// 配置与依赖
// ---------------------------------------------------------------------------

export type CollectorModel = {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 透传到请求体的额外字段（如 reasoning_effort / thinking）；缺省 {}。 */
  extraBody?: Record<string, unknown>;
};

export type CollectorConfig = {
  model: CollectorModel;
  exaApiKey?: string;
  xApiKey?: string;
  xSearchUrl: string;
  githubToken?: string;
  statusProviders: Record<string, string>;
  denyTerms: string[];
  maxToolRounds: number;
  timeBudgetMs: number;
  /** 每个工具单次最多返回多少条给模型。 */
  maxResultsPerTool: number;
};

export type CollectorDeps = {
  fetch: typeof fetch;
  now: () => Date;
  log: (fields: Record<string, unknown>) => void;
};

export const DEFAULT_STATUS_PROVIDERS: Record<string, string> = {
  openai: "https://status.openai.com/api/v2/incidents.json",
  anthropic: "https://status.anthropic.com/api/v2/incidents.json",
  "google-cloud": "https://status.cloud.google.com/incidents.json",
  cloudflare: "https://www.cloudflarestatus.com/api/v2/incidents.json",
};

export const DEFAULT_X_SEARCH_URL = "https://api.twitterapi.io/twitter/tweet/advanced_search";

const MODEL_TIMEOUT_MS = 45_000;
const TOOL_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// 密钥硬替换（进模型之前；仅密钥，不做语义脱敏——语义脱敏归模型）
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:sk|pk|rk|gsk|ghp|gho|ghu|ghs|glpat)[-_][A-Za-z0-9_-]{16,}\b/gu, "【KEY】"],
  [/\bAKIA[0-9A-Z]{16}\b/gu, "【KEY】"],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/gu, "【KEY】"],
  [/\bxox[bapors]-[A-Za-z0-9-]{10,}\b/gu, "【KEY】"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, "【JWT】"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gu, "Bearer 【KEY】"],
  [/\b[0-9a-f]{40,}\b/giu, "【HEX】"],
  [/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/giu, "$1【CRED】@"],
];

export function hardRedactSecrets(text: string, denyTerms: readonly string[] = []): { text: string; hits: number } {
  let out = text;
  let hits = 0;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, (...match: unknown[]) => {
      hits += 1;
      const group = typeof match[1] === "string" ? match[1] : "";
      return replacement.replace("$1", group);
    });
  }
  for (const term of denyTerms) {
    const needle = term.trim();
    if (!needle) continue;
    let index = out.indexOf(needle);
    while (index !== -1) {
      out = `${out.slice(0, index)}【内部】${out.slice(index + needle.length)}`;
      hits += 1;
      index = out.indexOf(needle);
    }
  }
  return { text: out, hits };
}

// ---------------------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------------------

export const PHASE1_SYSTEM = `你是一名运维情报分析员的前置处理器。用户会给你一条随手记的运维速记（中文为主，可能夹英文、报错、内部信息）。你要做两件事，只输出 JSON。

一、脱敏（redactedNote）：把速记里任何不该出公网的东西替换成占位符，其余逐字保留：
- 私有/内网 IP、内网主机名、端口 → 【IP】【HOST】【PORT】
- 密钥、令牌、账号、邮箱、手机号 → 【KEY】【账号】
- 未公开的内部项目名、客户名、代号（凡不是公开产品/厂商名的专有名词，一律视为内部）→ 【内部】
- 已经是占位符的（【KEY】【内部】等）原样保留
公开产品名、厂商名、模型名、错误码、公开 API 名称不是敏感信息，必须保留，它们是搜索的锚点。

二、规划：
- worthSearching：这条速记是否描述了一个可以在公网找到旁证的技术现象（报错、限流、故障、行为变化、价格/配额变化、版本问题）。纯个人待办、灵感、情绪、非技术内容 → false。
- entities：{ vendors[], products[], errorCodes[], symptoms[] }，只放公开词。
- queries：{ en[], zh[] }，各 1~3 条，短、可直接投搜索引擎；英文查询优先用官方术语（如 "RESOURCE_EXHAUSTED"），中文查询用国内社区常用说法。
- topicKey：形如 "厂商或产品/现象" 的小写短键，如 "gemini/429"、"claude/timeout"、"openai/quota"；用英文，斜杠分隔，不超过 40 字符。
- statusProviders：与速记相关的状态页提供方，只能从这个列表选：{{providers}}。无关则空数组。

输出格式（严格 JSON，无多余文字）：
{"worthSearching":true,"reason":"一句话","redactedNote":"…","entities":{"vendors":[],"products":[],"errorCodes":[],"symptoms":[]},"queries":{"en":[],"zh":[]},"topicKey":"…","statusProviders":[]}`;

export const AGENT_SYSTEM = `你是一名无情的情报侦探。任务：为一条已脱敏的运维速记，从真实互联网打捞"外面正在发生什么"的一手证据，清洗成结构化列表。你不写文案、不下结论、不推演，只找证据、只留痕。

工具：exa_search（通用网页，优先官方文档/博客/changelog/GitHub/技术社区）、x_search（X 近 7 天）、github_search（Issues）、hn_search（Hacker News）、status_incidents（厂商官方状态页）。
策略：
1. 先打 status_incidents（若规划里给了 provider）和 github_search，这两类最硬；再 hn_search / x_search 看讨论热度；exa_search 用来补官方页面或国内社区。
2. 每个工具最多调 2 次；总共不超过 6 次。同一查询不要换工具反复打。
3. 结果空了就换更短、更官方的词重试一次；仍空就放弃该方向，不要编。

证据判断（这是你的核心价值）：
- 只收「一手现场发声」：官方状态页事件、官方公告、GitHub 上带具体报错/版本的 issue、社区里带具体细节的帖子。
- 丢弃：SEO 农场、AI 生成的泛泛教程、标题党聚合、无具体报错/版本/日期的复述、明显营销。
- 判断真实度看：是否有具体错误文本、是否有时间戳、是否有他人回应（评论/点赞/回复）、账号是否像真人开发者。
- 热度分 heat（0~100）自己评，标准：官方状态页事件基线 60；GitHub issue 按评论与反应，10 条评论约 50 分、40 条约 75 分；HN 100 分以上 points 约 80 分；X 按点赞与转发，100 赞约 60 分；发布超过 7 天每周衰减约 20 分；官方来源不衰减那么快。评分只求相对可比，不求精确。
- quote 必须是该页面/帖子/推文里**逐字**出现的一句（≤200 字），最能证明"确实发生了这件事"的那句。不许改写、不许翻译、不许拼接。找不到合适原句就留空字符串。

最终输出（严格 JSON，无多余文字，只在不再需要调用工具时输出）：
{"topicKey":"沿用规划给的键，除非证据表明该改","evidence":[{"url":"必须是工具返回过的 URL，逐字","title":"…","source":"status|github|hn|x|exa","publishedAt":"YYYY-MM-DD 或空","quote":"逐字原句或空","metrics":{"likes":0,"comments":0,"reposts":0,"points":0,"reactions":0},"heat":0,"why":"一句话：它证明了什么"}],"summary":"一句话：外面在吵什么、和这条速记什么关系"}
最多 8 条，按 heat 降序。宁缺毋滥：0 条也是合法输出。`;

export const TOOLS_SCHEMA = [
  {
    type: "function",
    function: {
      name: "exa_search",
      description: "通用网页神经搜索（Exa）。适合官方文档、博客、changelog、GitHub、技术社区。返回标题、URL、发布日期、正文片段。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "自然语言或关键词查询" },
          sinceDays: { type: "integer", description: "只看最近 N 天，默认 30" },
          includeDomains: { type: "array", items: { type: "string" }, description: "可选，限定域名，如 [\"github.com\",\"cloud.google.com\"]" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "x_search",
      description: "X（Twitter）近 7 天高级搜索。返回推文文本、时间、点赞/转发/回复、作者粉丝数与注册时间。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "X 高级搜索语法，如 \"gemini 429 -is:retweet lang:en\"" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "github_search",
      description: "GitHub Issues 搜索。返回标题、URL、正文片段、评论数、反应数、创建时间。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "GitHub 搜索词，可带限定符，如 \"429 RESOURCE_EXHAUSTED repo:googleapis/python-genai\"" },
          sinceDays: { type: "integer", description: "只看最近 N 天创建的，默认 30" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "hn_search",
      description: "Hacker News 搜索（故事与评论）。返回标题/正文、URL、points、评论数、作者、时间。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          sinceDays: { type: "integer", description: "默认 30" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "status_incidents",
      description: "厂商官方状态页最近事件（Statuspage/Google Cloud 格式）。这是最硬的一手证据。",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", description: "提供方键，如 openai / anthropic / google-cloud / cloudflare" },
          sinceDays: { type: "integer", description: "默认 30" },
        },
        required: ["provider"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// 工具结果的统一形状 + URL 登记簿（防造假）
// ---------------------------------------------------------------------------

export type ToolHit = {
  source: "exa" | "x" | "github" | "hn" | "status";
  url: string;
  title: string;
  publishedAt?: string;
  text: string;
  metrics: Record<string, number>;
  author?: Record<string, unknown>;
};

/** 规范化 URL：小写主机、去追踪参数、去 fragment、去尾斜杠。 */
export function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw.trim());
    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./u, "");
    const drop = [...url.searchParams.keys()].filter((key) =>
      /^(utm_|fbclid|gclid|ref$|ref_|spm$|from$|source$|share_|s$|t$)/iu.test(key));
    for (const key of drop) url.searchParams.delete(key);
    let out = url.toString();
    if (url.pathname !== "/" && out.endsWith("/")) out = out.slice(0, -1);
    return out;
  } catch {
    return raw.trim();
  }
}

/** 去重键：平台 ID 优先，其余用规范化 URL。 */
export function dedupKey(url: string, source: string): string {
  const canonical = canonicalUrl(url);
  const gh = /github\.com\/([^/]+)\/([^/]+)\/(?:issues|discussions|pull)\/(\d+)/iu.exec(canonical);
  if (gh) return `github:${gh[1]}/${gh[2]}#${gh[3]}`.toLowerCase();
  const hn = /news\.ycombinator\.com\/item\?id=(\d+)/iu.exec(canonical);
  if (hn) return `hn:${hn[1]}`;
  const x = /(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/iu.exec(canonical);
  if (x) return `x:${x[1]}`;
  if (source === "status") return `status:${canonical.replace(/^https?:\/\//u, "")}`;
  return `url:${canonical.replace(/^https?:\/\//u, "")}`;
}

export class UrlRegistry {
  private readonly map = new Map<string, ToolHit>();

  add(hit: ToolHit): void {
    const key = canonicalUrl(hit.url);
    if (!this.map.has(key)) this.map.set(key, hit);
  }

  get(url: string): ToolHit | undefined {
    return this.map.get(canonicalUrl(url));
  }

  get size(): number {
    return this.map.size;
  }
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim().toLowerCase();
}

/** 引言校验：归一化空白与大小写后必须是登记文本的子串。 */
export function quoteVerified(quote: string, hit: ToolHit): boolean {
  const needle = normalizeWhitespace(quote);
  if (!needle) return false;
  return normalizeWhitespace(`${hit.title}\n${hit.text}`).includes(needle);
}

// ---------------------------------------------------------------------------
// 工具执行器（API 响应 → ToolHit[]；只做字段映射，不做判断）
// ---------------------------------------------------------------------------

type ToolArgs = Record<string, unknown>;

function sinceIso(deps: CollectorDeps, days: unknown, fallback: number): string {
  const n = typeof days === "number" && days > 0 ? Math.min(days, 365) : fallback;
  return new Date(deps.now().getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}

function clip(text: unknown, max: number): string {
  return typeof text === "string" ? text.replace(/\s+/gu, " ").trim().slice(0, max) : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function fetchJson(deps: CollectorDeps, url: string, init: RequestInit = {}): Promise<unknown> {
  const response = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(TOOL_TIMEOUT_MS) });
  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 160);
    throw new Error(`HTTP ${response.status} ${body}`);
  }
  return response.json();
}

async function runExa(args: ToolArgs, config: CollectorConfig, deps: CollectorDeps): Promise<ToolHit[]> {
  if (!config.exaApiKey) throw new Error("exaApiKey 未配置");
  const body: Record<string, unknown> = {
    query: String(args.query ?? ""),
    numResults: config.maxResultsPerTool,
    type: "auto",
    startPublishedDate: sinceIso(deps, args.sinceDays, 30),
    contents: { text: { maxCharacters: 600 } },
  };
  if (Array.isArray(args.includeDomains) && args.includeDomains.length) body.includeDomains = args.includeDomains;
  const parsed = (await fetchJson(deps, "https://api.exa.ai/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": config.exaApiKey },
    body: JSON.stringify(body),
  })) as Record<string, unknown>;
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  return results.slice(0, config.maxResultsPerTool).flatMap((item) => {
    const r = item as Record<string, unknown>;
    if (typeof r.url !== "string") return [];
    return [{
      source: "exa" as const,
      url: r.url,
      title: clip(r.title, 200),
      publishedAt: typeof r.publishedDate === "string" ? r.publishedDate.slice(0, 10) : undefined,
      text: clip(r.text ?? (Array.isArray(r.highlights) ? r.highlights.join(" ") : ""), 600),
      metrics: {},
      author: typeof r.author === "string" ? { name: r.author } : undefined,
    }];
  });
}

async function runX(args: ToolArgs, config: CollectorConfig, deps: CollectorDeps): Promise<ToolHit[]> {
  if (!config.xApiKey) throw new Error("xApiKey 未配置");
  const url = new URL(config.xSearchUrl);
  url.searchParams.set("query", String(args.query ?? ""));
  url.searchParams.set("queryType", "Latest");
  const parsed = (await fetchJson(deps, url.toString(), { headers: { "X-API-Key": config.xApiKey } })) as Record<string, unknown>;
  const tweets = Array.isArray(parsed.tweets) ? parsed.tweets : Array.isArray(parsed.data) ? parsed.data : [];
  return tweets.slice(0, config.maxResultsPerTool).flatMap((item) => {
    const t = item as Record<string, unknown>;
    const author = (t.author && typeof t.author === "object" ? t.author : {}) as Record<string, unknown>;
    const id = typeof t.id === "string" ? t.id : typeof t.id_str === "string" ? t.id_str : "";
    const link = typeof t.url === "string" ? t.url
      : typeof t.twitterUrl === "string" ? t.twitterUrl
      : id && typeof author.userName === "string" ? `https://x.com/${author.userName}/status/${id}` : "";
    if (!link) return [];
    const created = typeof t.createdAt === "string" ? t.createdAt : typeof t.created_at === "string" ? t.created_at : "";
    const ms = Date.parse(created);
    return [{
      source: "x" as const,
      url: link,
      title: clip(t.text, 120),
      publishedAt: Number.isNaN(ms) ? undefined : new Date(ms).toISOString().slice(0, 10),
      text: clip(t.text, 600),
      metrics: {
        likes: num(t.likeCount ?? t.favorite_count),
        reposts: num(t.retweetCount ?? t.retweet_count),
        replies: num(t.replyCount ?? t.reply_count),
        views: num(t.viewCount),
      },
      author: {
        userName: author.userName ?? author.screen_name,
        followers: num(author.followers ?? author.followers_count),
        createdAt: author.createdAt ?? author.created_at,
        verified: author.isBlueVerified ?? author.verified,
      },
    }];
  });
}

async function runGithub(args: ToolArgs, config: CollectorConfig, deps: CollectorDeps): Promise<ToolHit[]> {
  const since = sinceIso(deps, args.sinceDays, 30).slice(0, 10);
  const q = `${String(args.query ?? "")} is:issue created:>=${since}`;
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&sort=comments&order=desc&per_page=${config.maxResultsPerTool}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "pw-feishu-relay",
  };
  if (config.githubToken) headers.Authorization = `Bearer ${config.githubToken}`;
  const parsed = (await fetchJson(deps, url, { headers })) as Record<string, unknown>;
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  return items.flatMap((item) => {
    const r = item as Record<string, unknown>;
    if (typeof r.html_url !== "string") return [];
    const reactions = (r.reactions && typeof r.reactions === "object" ? r.reactions : {}) as Record<string, unknown>;
    const user = (r.user && typeof r.user === "object" ? r.user : {}) as Record<string, unknown>;
    return [{
      source: "github" as const,
      url: r.html_url,
      title: clip(r.title, 200),
      publishedAt: typeof r.created_at === "string" ? r.created_at.slice(0, 10) : undefined,
      text: clip(r.body, 800),
      metrics: { comments: num(r.comments), reactions: num(reactions.total_count) },
      author: { login: user.login, repo: typeof r.repository_url === "string" ? r.repository_url.replace("https://api.github.com/repos/", "") : undefined },
    }];
  });
}

async function runHn(args: ToolArgs, config: CollectorConfig, deps: CollectorDeps): Promise<ToolHit[]> {
  const sinceUnix = Math.floor(Date.parse(sinceIso(deps, args.sinceDays, 30)) / 1000);
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(String(args.query ?? ""))}&tags=(story,comment)&numericFilters=created_at_i>${sinceUnix}&hitsPerPage=${config.maxResultsPerTool}`;
  const parsed = (await fetchJson(deps, url)) as Record<string, unknown>;
  const hits = Array.isArray(parsed.hits) ? parsed.hits : [];
  return hits.flatMap((item) => {
    const h = item as Record<string, unknown>;
    const id = typeof h.objectID === "string" ? h.objectID : "";
    if (!id) return [];
    const title = clip(h.title ?? h.story_title, 200);
    const text = clip(h.story_text ?? h.comment_text ?? "", 800);
    return [{
      source: "hn" as const,
      url: `https://news.ycombinator.com/item?id=${id}`,
      title: title || clip(text, 120),
      publishedAt: typeof h.created_at === "string" ? h.created_at.slice(0, 10) : undefined,
      text: [text, typeof h.url === "string" ? `link: ${h.url}` : ""].filter(Boolean).join("\n"),
      metrics: { points: num(h.points), comments: num(h.num_comments) },
      author: { name: h.author },
    }];
  });
}

async function runStatus(args: ToolArgs, config: CollectorConfig, deps: CollectorDeps): Promise<ToolHit[]> {
  const provider = String(args.provider ?? "").toLowerCase();
  const endpoint = config.statusProviders[provider];
  if (!endpoint) throw new Error(`未知 provider：${provider}；可用：${Object.keys(config.statusProviders).join(", ")}`);
  const sinceMs = Date.parse(sinceIso(deps, args.sinceDays, 30));
  const parsed = await fetchJson(deps, endpoint);
  const hits: ToolHit[] = [];
  // Statuspage：{ incidents: [...] }
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).incidents)) {
    for (const item of (parsed as Record<string, unknown>).incidents as unknown[]) {
      const r = item as Record<string, unknown>;
      const created = typeof r.created_at === "string" ? r.created_at : "";
      if (created && Date.parse(created) < sinceMs) continue;
      const updates = Array.isArray(r.incident_updates) ? r.incident_updates : [];
      const latest = updates[0] as Record<string, unknown> | undefined;
      const link = typeof r.shortlink === "string" ? r.shortlink : `${endpoint.replace(/\/api\/v2\/.*$/u, "")}/incidents/${String(r.id ?? "")}`;
      hits.push({
        source: "status",
        url: link,
        title: clip(r.name, 200),
        publishedAt: created ? created.slice(0, 10) : undefined,
        text: clip(`${String(r.status ?? "")} · ${String(r.impact ?? "")} · ${String(latest?.body ?? "")}`, 800),
        metrics: {},
        author: { provider },
      });
    }
    return hits.slice(0, config.maxResultsPerTool);
  }
  // Google Cloud：[ { begin, external_desc, uri, severity, service_name, ... } ]
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const r = item as Record<string, unknown>;
      const begin = typeof r.begin === "string" ? r.begin : "";
      if (begin && Date.parse(begin) < sinceMs) continue;
      const uri = typeof r.uri === "string" ? r.uri : "";
      const products = Array.isArray(r.affected_products)
        ? (r.affected_products as Array<Record<string, unknown>>).map((p) => String(p.title ?? "")).filter(Boolean).join(", ")
        : String(r.service_name ?? "");
      const recent = (r.most_recent_update && typeof r.most_recent_update === "object" ? r.most_recent_update : {}) as Record<string, unknown>;
      hits.push({
        source: "status",
        url: uri.startsWith("http") ? uri : `https://status.cloud.google.com/${uri.replace(/^\/+/u, "")}`,
        title: clip(r.external_desc, 200),
        publishedAt: begin ? begin.slice(0, 10) : undefined,
        text: clip(`${String(r.severity ?? "")} · ${products} · ${String(recent.text ?? "")}`, 800),
        metrics: {},
        author: { provider },
      });
    }
    return hits.slice(0, config.maxResultsPerTool);
  }
  throw new Error("状态页响应格式未识别");
}

const TOOL_RUNNERS: Record<string, (args: ToolArgs, config: CollectorConfig, deps: CollectorDeps) => Promise<ToolHit[]>> = {
  exa_search: runExa,
  x_search: runX,
  github_search: runGithub,
  hn_search: runHn,
  status_incidents: runStatus,
};

/** 执行一个工具调用；异常转成 {error} 让模型知道，而不是让整轮失败。 */
export async function executeTool(
  name: string,
  args: ToolArgs,
  config: CollectorConfig,
  deps: CollectorDeps,
  registry: UrlRegistry,
): Promise<{ ok: boolean; hits: ToolHit[]; error?: string }> {
  const runner = TOOL_RUNNERS[name];
  if (!runner) return { ok: false, hits: [], error: `未知工具 ${name}` };
  try {
    const hits = await runner(args, config, deps);
    for (const hit of hits) registry.add(hit);
    return { ok: true, hits };
  } catch (error) {
    return { ok: false, hits: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/** 给模型看的工具结果：去掉 author 里可能很长的字段，控制体积。 */
function toolResultForModel(result: { ok: boolean; hits: ToolHit[]; error?: string }): string {
  if (!result.ok) return JSON.stringify({ error: result.error, results: [] });
  return JSON.stringify({
    results: result.hits.map((h) => ({
      url: h.url,
      title: h.title,
      publishedAt: h.publishedAt ?? "",
      text: h.text,
      metrics: h.metrics,
      author: h.author,
    })),
  });
}

// ---------------------------------------------------------------------------
// 模型调用（OpenAI-compatible，tools）
// ---------------------------------------------------------------------------

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

async function chat(
  messages: ChatMessage[],
  config: CollectorConfig,
  deps: CollectorDeps,
  options: { tools?: unknown[]; json?: boolean },
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const body: Record<string, unknown> = {
    model: config.model.model,
    messages,
    temperature: 0.2,
    ...(config.model.extraBody ?? {}),
  };
  if (options.tools) {
    body.tools = options.tools;
    body.tool_choice = "auto";
  }
  if (options.json) body.response_format = { type: "json_object" };
  const response = await deps.fetch(`${config.model.baseUrl.replace(/\/+$/u, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.model.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`模型 ${response.status}：${text}`);
  }
  const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  const message = ((choices[0] as Record<string, unknown> | undefined)?.message ?? {}) as Record<string, unknown>;
  const content = typeof message.content === "string" ? message.content : "";
  const toolCalls = Array.isArray(message.tool_calls)
    ? (message.tool_calls as ToolCall[]).filter((c) => c && c.function && typeof c.function.name === "string")
    : [];
  return { content, toolCalls };
}

/** 从可能带 ```json 围栏或前后废话的文本里取出第一个 JSON 对象。 */
export function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(text);
  const candidates = [fenced?.[1], text];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    try {
      const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // 继续尝试下一个候选
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export type Phase1Plan = {
  worthSearching: boolean;
  reason: string;
  redactedNote: string;
  entities: { vendors: string[]; products: string[]; errorCodes: string[]; symptoms: string[] };
  queries: { en: string[]; zh: string[] };
  topicKey: string;
  statusProviders: string[];
};

export type EvidenceItem = {
  key: string;
  url: string;
  title: string;
  source: ToolHit["source"];
  tier: "T0" | "T1" | "T2";
  publishedAt?: string;
  quote: string;
  quoteVerified: boolean;
  metrics: Record<string, number>;
  heat: number;
  why: string;
};

export type CollectorResult = {
  skipped: boolean;
  reason?: string;
  redactedNote: string;
  hardRedactions: number;
  topicKey: string;
  queries: string[];
  evidence: EvidenceItem[];
  summary: string;
  stats: {
    toolCalls: number;
    toolErrors: number;
    urlsSeen: number;
    droppedUnknownUrl: number;
    quotesCleared: number;
    ms: number;
  };
};

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim()) : [];
}

export function normalizeTopicKey(value: unknown, fallback = "misc/uncategorized"): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  const cleaned = raw.replace(/[^a-z0-9./_-]+/gu, "-").replace(/-+/gu, "-").replace(/^-|-$/gu, "").slice(0, 40);
  return cleaned.includes("/") && cleaned.length >= 3 ? cleaned : fallback;
}

export function parsePhase1(raw: Record<string, unknown>, fallbackNote: string): Phase1Plan {
  const entities = (raw.entities && typeof raw.entities === "object" ? raw.entities : {}) as Record<string, unknown>;
  const queries = (raw.queries && typeof raw.queries === "object" ? raw.queries : {}) as Record<string, unknown>;
  return {
    worthSearching: raw.worthSearching === true,
    reason: typeof raw.reason === "string" ? raw.reason : "",
    redactedNote: typeof raw.redactedNote === "string" && raw.redactedNote.trim() ? raw.redactedNote.trim() : fallbackNote,
    entities: {
      vendors: strList(entities.vendors),
      products: strList(entities.products),
      errorCodes: strList(entities.errorCodes),
      symptoms: strList(entities.symptoms),
    },
    queries: { en: strList(queries.en).slice(0, 3), zh: strList(queries.zh).slice(0, 3) },
    topicKey: normalizeTopicKey(raw.topicKey),
    statusProviders: strList(raw.statusProviders).map((p) => p.toLowerCase()),
  };
}

const TIER_BY_SOURCE: Record<ToolHit["source"], EvidenceItem["tier"]> = {
  status: "T0",
  github: "T1",
  hn: "T1",
  x: "T1",
  exa: "T2",
};

/** 最终 JSON → 证据列表：URL 必须在登记簿；引言必须可验证；热度夹到 0~100；按去重键去重。 */
export function validateEvidence(
  raw: Record<string, unknown>,
  registry: UrlRegistry,
): { items: EvidenceItem[]; droppedUnknownUrl: number; quotesCleared: number } {
  const list = Array.isArray(raw.evidence) ? raw.evidence : [];
  const seen = new Set<string>();
  const items: EvidenceItem[] = [];
  let droppedUnknownUrl = 0;
  let quotesCleared = 0;
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const url = typeof e.url === "string" ? e.url.trim() : "";
    const hit = url ? registry.get(url) : undefined;
    if (!hit) {
      droppedUnknownUrl += 1;
      continue;
    }
    const key = dedupKey(hit.url, hit.source);
    if (seen.has(key)) continue;
    seen.add(key);
    let quote = typeof e.quote === "string" ? e.quote.trim().slice(0, 200) : "";
    let verified = false;
    if (quote) {
      verified = quoteVerified(quote, hit);
      if (!verified) {
        quote = "";
        quotesCleared += 1;
      }
    }
    const heatRaw = typeof e.heat === "number" ? e.heat : Number(e.heat);
    const heat = Number.isFinite(heatRaw) ? Math.max(0, Math.min(100, Math.round(heatRaw))) : hit.source === "status" ? 60 : 40;
    const metrics: Record<string, number> = { ...hit.metrics };
    items.push({
      key,
      url: hit.url,
      title: typeof e.title === "string" && e.title.trim() ? e.title.trim().slice(0, 200) : hit.title,
      source: hit.source,
      tier: TIER_BY_SOURCE[hit.source],
      publishedAt: hit.publishedAt ?? (typeof e.publishedAt === "string" && e.publishedAt ? e.publishedAt.slice(0, 10) : undefined),
      quote,
      quoteVerified: verified,
      metrics,
      heat,
      why: typeof e.why === "string" ? e.why.trim().slice(0, 200) : "",
    });
  }
  items.sort((a, b) => b.heat - a.heat);
  return { items: items.slice(0, 8), droppedUnknownUrl, quotesCleared };
}

export async function collectEvidence(rawNote: string, config: CollectorConfig, deps: CollectorDeps): Promise<CollectorResult> {
  const started = deps.now().getTime();
  const deadline = started + config.timeBudgetMs;
  const hard = hardRedactSecrets(rawNote, config.denyTerms);
  const stats = { toolCalls: 0, toolErrors: 0, urlsSeen: 0, droppedUnknownUrl: 0, quotesCleared: 0, ms: 0 };

  // 阶段一：脱敏与规划（无工具）
  const phase1System = PHASE1_SYSTEM.replace("{{providers}}", Object.keys(config.statusProviders).join(", ") || "无");
  const phase1 = await chat(
    [{ role: "system", content: phase1System }, { role: "user", content: hard.text }],
    config,
    deps,
    { json: true },
  );
  const planRaw = extractJsonObject(phase1.content);
  if (!planRaw) throw new Error("阶段一输出不是 JSON");
  const plan = parsePhase1(planRaw, hard.text);
  deps.log({ event: "evidence_plan", worth: plan.worthSearching, topic: plan.topicKey, queries: plan.queries, reason: plan.reason });

  const allQueries = [...plan.queries.en, ...plan.queries.zh];
  if (!plan.worthSearching) {
    stats.ms = deps.now().getTime() - started;
    return {
      skipped: true,
      reason: plan.reason,
      redactedNote: plan.redactedNote,
      hardRedactions: hard.hits,
      topicKey: plan.topicKey,
      queries: allQueries,
      evidence: [],
      summary: "",
      stats,
    };
  }

  // 阶段二：搜证（只带脱敏产物）
  const registry = new UrlRegistry();
  const messages: ChatMessage[] = [
    { role: "system", content: AGENT_SYSTEM },
    {
      role: "user",
      content: JSON.stringify({
        redactedNote: plan.redactedNote,
        entities: plan.entities,
        suggestedQueries: plan.queries,
        topicKey: plan.topicKey,
        statusProviders: plan.statusProviders,
        today: deps.now().toISOString().slice(0, 10),
      }),
    },
  ];

  let finalRaw: Record<string, unknown> | undefined;
  let answered = false;
  for (let round = 0; round < config.maxToolRounds; round += 1) {
    if (deps.now().getTime() > deadline) {
      deps.log({ event: "evidence_deadline", round });
      break;
    }
    const step = await chat(messages, config, deps, { tools: TOOLS_SCHEMA });
    if (!step.toolCalls.length) {
      answered = true;
      finalRaw = extractJsonObject(step.content);
      if (!finalRaw) {
        // 只修一次：模型给了"最终回答"却不是 JSON
        messages.push({ role: "assistant", content: step.content });
        messages.push({ role: "user", content: "你的输出不是合法 JSON。只输出最终 JSON 对象，不要任何其他文字。" });
        const repair = await chat(messages, config, deps, { json: true });
        finalRaw = extractJsonObject(repair.content);
      }
      break;
    }
    messages.push({ role: "assistant", content: step.content || null, tool_calls: step.toolCalls });
    for (const call of step.toolCalls) {
      let args: ToolArgs = {};
      try {
        args = JSON.parse(call.function.arguments || "{}") as ToolArgs;
      } catch {
        args = {};
      }
      stats.toolCalls += 1;
      const result = await executeTool(call.function.name, args, config, deps, registry);
      if (!result.ok) stats.toolErrors += 1;
      deps.log({ event: "evidence_tool", tool: call.function.name, args, ok: result.ok, hits: result.hits.length, error: result.error });
      messages.push({ role: "tool", tool_call_id: call.id, content: toolResultForModel(result) });
    }
  }

  // 工具轮次用尽（或超时）仍没给过最终答案：强制收口一次；修复失败的不再重试
  if (!finalRaw && !answered) {
    messages.push({ role: "user", content: "工具调用次数已用完。基于已有结果立即输出最终 JSON，不要再调用工具。" });
    const closing = await chat(messages, config, deps, { json: true });
    finalRaw = extractJsonObject(closing.content);
  }
  if (!finalRaw) throw new Error("搜证阶段未能产出合法 JSON");

  const validated = validateEvidence(finalRaw, registry);
  stats.urlsSeen = registry.size;
  stats.droppedUnknownUrl = validated.droppedUnknownUrl;
  stats.quotesCleared = validated.quotesCleared;
  stats.ms = deps.now().getTime() - started;

  return {
    skipped: false,
    redactedNote: plan.redactedNote,
    hardRedactions: hard.hits,
    topicKey: normalizeTopicKey(finalRaw.topicKey, plan.topicKey),
    queries: allQueries,
    evidence: validated.items,
    summary: typeof finalRaw.summary === "string" ? finalRaw.summary.trim().slice(0, 300) : "",
    stats,
  };
}
