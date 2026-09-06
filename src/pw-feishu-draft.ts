/**
 * TASK-PW-75：飞书速记「像个坑 → 出稿」扩展。
 *
 * 位置：与 pw-feishu-relay.ts 同一进程、同一长连接。本文件只提供纯函数、状态簿与两个
 * 挂点（intercept / afterWritten），由中继在「消息进入之前」和「写 Memos 成功之后」各调一次。
 *
 * 纪律：
 * - 总开关 = feishu-relay.json 的 draftOffer（缺省 false）。每条消息到来时重新读一次配置，
 *   改成 false 立即生效、不用重启；配置坏了按关闭处理（fail-closed）。
 * - 关闭时对中继行为零影响："1"、「别问了」、B 站链接全部按普通速记写入，回执仍是「已记」。
 * - 开启时也不得影响「已记」：两个挂点内部全部 try/catch，失败只改回执文案、只记日志。
 * - 不写 Memos：草稿只回到会话，不进笔记库。唯一例外是给含 B 站链接的速记追加 #发布 标签，
 *   让「发了几条」的真值留在 Memos 里；本文件的周计数只是派生副本。
 * - MemOS MCP / Memos 关键词检索 / 模型调用全部 best-effort + 超时；任一不可用，草稿照出，回执注明。
 * - 每天最多 maxOffersPerDay 次 offer；「别问了」静音 muteDays 天；offer 在 offerTtlHours 内有效，
 *   新 offer 覆盖旧 offer；错过的 offer 不重发、不计数、不提醒。
 */
import { chmodSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export type DraftModelConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type DraftConfig = {
  enabled: boolean;
  /** enabled=false 时的原因（缺省关闭 / 配置坏 / 缺模型），只用于日志。 */
  disabledReason?: string;
  keywords: string[];
  triggerWords: string[];
  muteWord: string;
  maxOffersPerDay: number;
  offerTtlHours: number;
  muteDays: number;
  model?: DraftModelConfig;
  memosMcpUrl?: string;
  memosCubeIds: string[];
  bitableAppToken?: string;
  bitableTableId?: string;
  appId?: string;
  appSecret?: string;
};

/** 缺省关键词：命中任一即视为「像个坑」。全部小写比较。数字类关键词要求前后不是数字。 */
export const DEFAULT_DRAFT_KEYWORDS: readonly string[] = [
  "429",
  "500",
  "502",
  "503",
  "504",
  "超时",
  "timeout",
  "报错",
  "限流",
  "踩坑",
  "翻车",
  "挂了",
  "error",
  "exception",
  "rate limit",
  "不可用",
];

export const DEFAULT_TRIGGER_WORDS: readonly string[] = ["1", "出稿"];
export const DEFAULT_MUTE_WORD = "别问了";
export const DEFAULT_MAX_OFFERS_PER_DAY = 2;
export const DEFAULT_OFFER_TTL_HOURS = 12;
export const DEFAULT_MUTE_DAYS = 7;
export const DEFAULT_MEMOS_CUBE_IDS: readonly string[] = ["index"];

const DISABLED_BASE: Omit<DraftConfig, "enabled" | "disabledReason"> = {
  keywords: [...DEFAULT_DRAFT_KEYWORDS],
  triggerWords: [...DEFAULT_TRIGGER_WORDS],
  muteWord: DEFAULT_MUTE_WORD,
  maxOffersPerDay: DEFAULT_MAX_OFFERS_PER_DAY,
  offerTtlHours: DEFAULT_OFFER_TTL_HOURS,
  muteDays: DEFAULT_MUTE_DAYS,
  memosCubeIds: [...DEFAULT_MEMOS_CUBE_IDS],
};

function disabled(reason: string): DraftConfig {
  return { ...DISABLED_BASE, enabled: false, disabledReason: reason };
}

/**
 * 从 feishu-relay.json 读取 draft 段。与 loadRelayConfig 读同一个文件，但：
 * - 任何异常都不抛，一律返回 enabled=false（fail-closed）；
 * - 只认 draftOffer === true；缺省 / false / 非布尔 一律关闭；
 * - draftOffer=true 但 draftModel 三字段不齐 → 关闭并给原因。
 * 每条消息到来时调用一次，因此改配置不需要重启中继。
 */
export function loadDraftConfig(path: string): DraftConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return disabled(`配置读取失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return disabled("配置不是 JSON 对象");
  }
  const record = parsed as Record<string, unknown>;
  if (record.draftOffer !== true) {
    return disabled("draftOffer 未开启");
  }

  const model = readModel(record.draftModel);
  if (!model) {
    return disabled("draftOffer 已开但 draftModel 缺 baseUrl / apiKey / model");
  }

  const keywords = readStringList(record.draftKeywords, DEFAULT_DRAFT_KEYWORDS).map((item) =>
    item.toLowerCase(),
  );
  const triggerWords = readStringList(record.draftTriggerWords, DEFAULT_TRIGGER_WORDS);
  const muteWord = readString(record.draftMuteWord, DEFAULT_MUTE_WORD);
  const memosCubeIds = readStringList(record.draftMemosCubeIds, DEFAULT_MEMOS_CUBE_IDS).slice(0, 2);
  const memosMcpUrl = typeof record.memosMcpUrl === "string" && record.memosMcpUrl.trim()
    ? record.memosMcpUrl.trim().replace(/\/+$/u, "")
    : undefined;
  const bitableAppToken = typeof record.bitableAppToken === "string" && record.bitableAppToken.trim()
    ? record.bitableAppToken.trim()
    : undefined;
  const bitableTableId = typeof record.bitableTableId === "string" && record.bitableTableId.trim()
    ? record.bitableTableId.trim()
    : undefined;
  const appId = typeof record.appId === "string" && record.appId.trim()
    ? record.appId.trim()
    : undefined;
  const appSecret = typeof record.appSecret === "string" && record.appSecret.trim()
    ? record.appSecret.trim()
    : undefined;

  return {
    enabled: true,
    keywords,
    triggerWords,
    muteWord,
    maxOffersPerDay: readPositiveInt(record.draftMaxOffersPerDay, DEFAULT_MAX_OFFERS_PER_DAY),
    offerTtlHours: readPositiveInt(record.draftOfferTtlHours, DEFAULT_OFFER_TTL_HOURS),
    muteDays: readPositiveInt(record.draftMuteDays, DEFAULT_MUTE_DAYS),
    model,
    memosMcpUrl,
    memosCubeIds: memosCubeIds.length ? memosCubeIds : [...DEFAULT_MEMOS_CUBE_IDS],
    bitableAppToken,
    bitableTableId,
    appId,
    appSecret,
  };
}

function readModel(value: unknown): DraftModelConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const baseUrl = typeof record.baseUrl === "string" ? record.baseUrl.trim().replace(/\/+$/u, "") : "";
  const apiKey = typeof record.apiKey === "string" ? record.apiKey.trim() : "";
  const model = typeof record.model === "string" ? record.model.trim() : "";
  if (!baseUrl || !apiKey || !model) return undefined;
  return { baseUrl, apiKey, model };
}

function readStringList(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : [...fallback];
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function readPositiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

// ---------------------------------------------------------------------------
// 纯判断
// ---------------------------------------------------------------------------

/** 命中「像个坑」关键词则返回命中的关键词，否则 null。纯数字关键词要求前后不紧邻数字。 */
export function detectPitfall(text: string, keywords: readonly string[]): string | null {
  const lower = text.toLowerCase();
  for (const keyword of keywords) {
    if (!keyword) continue;
    if (/^\d+$/u.test(keyword)) {
      const pattern = new RegExp(`(^|\\D)${keyword}(\\D|$)`, "u");
      if (pattern.test(lower)) return keyword;
      continue;
    }
    if (lower.includes(keyword)) return keyword;
  }
  return null;
}

const BILIBILI_URL = /https?:\/\/(?:www\.|m\.|t\.)?(?:bilibili\.com|b23\.tv)\/[^\s]*/iu;

/** 速记里第一个 B 站链接（bilibili.com / b23.tv / t.bilibili.com），没有则 null。 */
export function extractBilibiliUrl(text: string): string | null {
  const match = BILIBILI_URL.exec(text);
  return match ? match[0] : null;
}

/** 本地日历日 YYYY-MM-DD（进程所在时区，中继跑在本机 Mac 上）。 */
export function localDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 本地周键：以周一为一周开始，返回该周周一的 YYYY-MM-DD。 */
export function localWeekKey(date: Date): string {
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = monday.getDay(); // 0=周日
  const diff = day === 0 ? 6 : day - 1;
  monday.setDate(monday.getDate() - diff);
  return localDayKey(monday);
}

// ---------------------------------------------------------------------------
// 状态簿（与 seen 文件同目录，原子写 0600）
// ---------------------------------------------------------------------------

export type PendingOffer = {
  messageId: string;
  text: string;
  keyword: string;
  memo: string;
  at: string;
};

type DraftStateData = {
  day: string;
  offersToday: number;
  pending?: PendingOffer;
  muteUntil?: string;
  published: Array<{ at: string; url: string }>;
};

const PUBLISHED_CAP = 500;

export class DraftState {
  private readonly path: string;
  private data: DraftStateData;

  constructor(path: string) {
    this.path = path;
    this.data = { day: "", offersToday: 0, published: [] };
  }

  /** 缺文件 / 坏 JSON 一律从空状态开始，不抛。 */
  load(): void {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        this.data = {
          day: typeof record.day === "string" ? record.day : "",
          offersToday: typeof record.offersToday === "number" ? record.offersToday : 0,
          pending: isPending(record.pending) ? record.pending : undefined,
          muteUntil: typeof record.muteUntil === "string" ? record.muteUntil : undefined,
          published: Array.isArray(record.published)
            ? record.published.filter(
              (item): item is { at: string; url: string } =>
                Boolean(item) && typeof item === "object"
                && typeof (item as Record<string, unknown>).at === "string"
                && typeof (item as Record<string, unknown>).url === "string",
            )
            : [],
        };
        return;
      }
    } catch {
      // 缺文件或坏文件按空状态
    }
    this.data = { day: "", offersToday: 0, published: [] };
  }

  save(): void {
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(this.data)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temporaryPath, this.path);
      chmodSync(this.path, 0o600);
    } catch (error) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // tmp 可能已被改名或不存在
      }
      throw error;
    }
  }

  private rollDay(now: Date): void {
    const key = localDayKey(now);
    if (this.data.day !== key) {
      this.data.day = key;
      this.data.offersToday = 0;
    }
  }

  isMuted(now: Date): boolean {
    return Boolean(this.data.muteUntil && new Date(this.data.muteUntil).getTime() > now.getTime());
  }

  mute(now: Date, days: number): Date {
    const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    this.data.muteUntil = until.toISOString();
    return until;
  }

  offersToday(now: Date): number {
    this.rollDay(now);
    return this.data.offersToday;
  }

  canOffer(now: Date, maxPerDay: number): boolean {
    this.rollDay(now);
    return !this.isMuted(now) && this.data.offersToday < maxPerDay;
  }

  /** 记一次 offer：当日计数 +1，并把它设为唯一待出稿项（覆盖旧的）。 */
  recordOffer(offer: Omit<PendingOffer, "at">, now: Date): void {
    this.rollDay(now);
    this.data.offersToday += 1;
    this.data.pending = { ...offer, at: now.toISOString() };
  }

  /** 取走待出稿项（有效期内才算有），取走即清空。 */
  takePending(now: Date, ttlHours: number): PendingOffer | undefined {
    const pending = this.data.pending;
    this.data.pending = undefined;
    if (!pending) return undefined;
    const age = now.getTime() - new Date(pending.at).getTime();
    if (Number.isNaN(age) || age > ttlHours * 60 * 60 * 1000) return undefined;
    return pending;
  }

  /** 记一条已发布链接，返回本周（周一起）累计条数。 */
  recordPublished(url: string, now: Date): number {
    this.data.published.push({ at: now.toISOString(), url });
    if (this.data.published.length > PUBLISHED_CAP) {
      this.data.published.splice(0, this.data.published.length - PUBLISHED_CAP);
    }
    return this.weekCount(now);
  }

  weekCount(now: Date): number {
    const week = localWeekKey(now);
    return this.data.published.filter((item) => localWeekKey(new Date(item.at)) === week).length;
  }

  get pending(): PendingOffer | undefined {
    return this.data.pending;
  }
}

function isPending(value: unknown): value is PendingOffer {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.messageId === "string"
    && typeof record.text === "string"
    && typeof record.keyword === "string"
    && typeof record.memo === "string"
    && typeof record.at === "string";
}

// ---------------------------------------------------------------------------
// 文案与提示词（纯函数）
// ---------------------------------------------------------------------------

export const OFFER_REPLY = "已记 · 像个坑，回 1 出一条图文草稿";
export const ACK_REPLY = "收到，出稿中（约半分钟）";
export const NO_PENDING_REPLY = "没有待出稿的坑（offer 只在 12 小时内有效）";

export function buildMuteReply(days: number): string {
  return `好，${days} 天内不再问`;
}

export function buildPublishedReply(weekCount: number): string {
  return `已记 · 本周第 ${weekCount} 条`;
}

export type RelatedNote = {
  text: string;
  /** YYYY-MM-DD 或空串（来源没给时间）。 */
  date: string;
  source: "memos-mcp" | "memos";
};

export type DraftPrompt = { system: string; user: string };

/**
 * 出稿提示词。硬规则写死在 system：只用原文与相关旧记录里的事实，缺的写【补】，不编造；
 * 纯文本输出（飞书 text 消息不渲染 Markdown）。
 */
export function buildDraftPrompt(
  note: { text: string; keyword: string },
  related: readonly RelatedNote[],
): DraftPrompt {
  const system = [
    "你是一个只做整理、不做发挥的编辑。把用户的一条运维速记整理成一条 B 站动态/专栏短图文草稿。",
    "硬规则：",
    "1. 只能使用「速记原文」和「相关旧记录」里出现的事实。原文没有的信息（原因、数据、时间、结论）一律写成【补】占位，绝不编造、绝不猜。",
    "2. 报错原文、模型名、供应商名保持原始写法，不改写术语，不翻译。",
    "3. 结构固定，每段一行开头标签：标题（≤25 字）/ 现象 / 原因 / 解法 / 一句话 / 相关旧记录（有则逐条一行带日期，无则写「无」）/ 配图建议 / 标签（3 个，以 # 开头，空格分隔）。",
    "4. 总长 200～400 字。口语、直接。不用营销腔，不用 emoji，不写「总结」「希望对你有帮助」之类套话。",
    "5. 输出纯文本，不用任何 Markdown 语法。",
  ].join("\n");

  const relatedLines = related.length
    ? related.map((item) => `- [${item.date || "日期不明"}] ${item.text}`).join("\n")
    : "无";
  const user = [
    `速记原文：${note.text}`,
    `命中关键词：${note.keyword}`,
    "相关旧记录：",
    relatedLines,
  ].join("\n");
  return { system, user };
}

export function renderDraftReply(
  draft: string,
  meta: { relatedCount: number; unavailable: readonly string[]; bitableUrl?: string },
): string {
  const footer: string[] = [];
  if (meta.bitableUrl) footer.push(`📌 已同步飞书多维表格：${meta.bitableUrl}`);
  if (meta.unavailable.length) footer.push(`（旧记录检索不可用：${meta.unavailable.join("、")}）`);
  footer.push("发不发、改不改、贴到哪，你定。发了把链接回我一条。");
  return `${draft.trim()}\n\n${footer.join("\n")}`;
}

/** 异步将生成的草稿同步写入飞书多维表格（best-effort，失败不阻断）。 */
export async function syncDraftToBitable(
  appId: string,
  appSecret: string,
  appToken: string,
  tableId: string,
  title: string,
  draft: string,
  originalText: string,
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  try {
    const tokenRes = await fetchImpl("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenRes.ok) return undefined;
    const tokenData = (await tokenRes.json().catch(() => ({}))) as Record<string, unknown>;
    const token = typeof tokenData.tenant_access_token === "string" ? tokenData.tenant_access_token : "";
    if (!token) return undefined;

    const res = await fetchImpl(`https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        fields: {
          标题: title,
          草稿正文: draft,
          发布状态: "待发布",
          原始速记: originalText,
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      return `https://ccnexza2e5l5.feishu.cn/base/${appToken}`;
    }
  } catch {
    // 忽略异常，降级处理
  }
  return undefined;
}

export function buildDraftFailedReply(error: string): string {
  return `草稿没出来：${error}`;
}

// ---------------------------------------------------------------------------
// 外部依赖（可注入，测试用假件）
// ---------------------------------------------------------------------------

export type MemosToolCaller = (
  url: string,
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export type DraftDeps = {
  now: () => Date;
  fetch: typeof fetch;
  log: (fields: Record<string, unknown>) => void;
  /** MemOS MCP tools/call；缺省 undefined 或配置无 memosMcpUrl = 不查 MemOS。 */
  callMemosTool?: MemosToolCaller;
  /** Memos REST 关键词检索用的地址与令牌（与中继同一份）。 */
  memos: { url: string; token: string };
};

const RELATED_TIMEOUT_MS = 15_000;
const MODEL_TIMEOUT_MS = 60_000;
const RELATED_CAP = 5;

/**
 * 相关旧记录：MemOS MCP 混合检索 + Memos 关键词检索并行，各自 best-effort，合并去重封顶 5 条。
 * 排除刚写入的这条（memo name 相同或正文相同）。
 */
export async function fetchRelatedNotes(
  note: { text: string; keyword: string; memo: string },
  config: DraftConfig,
  deps: DraftDeps,
): Promise<{ items: RelatedNote[]; unavailable: string[] }> {
  type Outcome = { items: RelatedNote[]; error?: string };
  const settle = (promise: Promise<RelatedNote[]>): Promise<Outcome> =>
    promise.then((items) => ({ items }), (error: unknown) => ({ items: [], error: safeErrorText(error) }));

  const [mcp, rest] = await Promise.all([
    deps.callMemosTool && config.memosMcpUrl
      ? settle(searchMemosMcp(note.text, config, deps))
      : Promise.resolve<Outcome>({ items: [] }),
    settle(searchMemosRest(note, deps)),
  ]);
  // 固定顺序：MemOS 在前、Memos 在后，回执文案可预期
  const unavailable: string[] = [];
  if (mcp.error) unavailable.push(`MemOS（${mcp.error}）`);
  if (rest.error) unavailable.push(`Memos（${rest.error}）`);

  const seen = new Set<string>();
  const items: RelatedNote[] = [];
  for (const item of [...mcp.items, ...rest.items]) {
    const key = item.text.replace(/\s+/gu, " ").trim().slice(0, 80);
    if (!key || seen.has(key)) continue;
    if (key === note.text.replace(/\s+/gu, " ").trim().slice(0, 80)) continue;
    seen.add(key);
    items.push(item);
    if (items.length >= RELATED_CAP) break;
  }
  return { items, unavailable };
}

async function searchMemosMcp(query: string, config: DraftConfig, deps: DraftDeps): Promise<RelatedNote[]> {
  const call = deps.callMemosTool;
  if (!call || !config.memosMcpUrl) return [];
  const raw = await withTimeout(
    call(config.memosMcpUrl, "search_memories", {
      query,
      cube_ids: config.memosCubeIds,
      top_k: RELATED_CAP,
      search_mode: "hybrid",
    }),
    RELATED_TIMEOUT_MS,
    "MemOS 检索超时",
  );
  return parseMemosMcpResults(raw);
}

/** 解析 MCP tools/call 返回：优先 structuredContent，其次 content[0].text 的 JSON；取 results[].memory。 */
export function parseMemosMcpResults(raw: unknown): RelatedNote[] {
  let payload: unknown = raw;
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (record.structuredContent && typeof record.structuredContent === "object") {
      payload = record.structuredContent;
    } else if (Array.isArray(record.content)) {
      const first = record.content.find(
        (item) => item && typeof item === "object" && (item as Record<string, unknown>).type === "text",
      ) as Record<string, unknown> | undefined;
      if (first && typeof first.text === "string") {
        try {
          payload = JSON.parse(first.text);
        } catch {
          return [];
        }
      }
    }
  }
  if (!payload || typeof payload !== "object") return [];
  const results = (payload as Record<string, unknown>).results;
  if (!Array.isArray(results)) return [];
  const notes: RelatedNote[] = [];
  for (const item of results) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const text = typeof record.memory === "string" ? record.memory.trim() : "";
    if (!text) continue;
    const view = record.memory_view && typeof record.memory_view === "object"
      ? (record.memory_view as Record<string, unknown>)
      : {};
    const stamp = [view.occurred_at, view.created_at, record.created_at, record.updated_at]
      .find((value): value is string => typeof value === "string" && value.length >= 10);
    notes.push({ text, date: stamp ? stamp.slice(0, 10) : "", source: "memos-mcp" });
  }
  return notes;
}

async function searchMemosRest(
  note: { text: string; keyword: string; memo: string },
  deps: DraftDeps,
): Promise<RelatedNote[]> {
  const base = deps.memos.url.replace(/\/+$/u, "");
  const filter = `content.contains("${note.keyword.replace(/"/gu, '\\"')}")`;
  const url = `${base}/api/v1/memos?pageSize=${RELATED_CAP + 1}&filter=${encodeURIComponent(filter)}`;
  const response = await deps.fetch(url, {
    headers: { Authorization: `Bearer ${deps.memos.token}` },
    signal: AbortSignal.timeout(RELATED_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Memos 检索失败 ${response.status}`);
  }
  const parsed: unknown = await response.json().catch(() => ({}));
  return parseMemosRestResults(parsed, note.memo);
}

/** 解析 Memos /api/v1/memos 列表：取 content，排除刚写入的那条（按 name / uid）。 */
export function parseMemosRestResults(raw: unknown, excludeMemoName: string): RelatedNote[] {
  if (!raw || typeof raw !== "object") return [];
  const memos = (raw as Record<string, unknown>).memos;
  if (!Array.isArray(memos)) return [];
  const notes: RelatedNote[] = [];
  for (const item of memos) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "";
    const uid = typeof record.uid === "string" ? record.uid : "";
    if (excludeMemoName && (name === excludeMemoName || uid === excludeMemoName)) continue;
    const content = typeof record.content === "string" ? record.content.trim() : "";
    if (!content) continue;
    const stamp = [record.displayTime, record.createTime, record.updateTime]
      .find((value): value is string => typeof value === "string" && value.length >= 10);
    notes.push({ text: content, date: stamp ? stamp.slice(0, 10) : "", source: "memos" });
  }
  return notes;
}

/** OpenAI-compatible chat completions（非流式）。返回正文；空正文抛错。 */
export async function generateDraft(
  model: DraftModelConfig,
  prompt: DraftPrompt,
  fetchImpl: typeof fetch,
): Promise<string> {
  const response = await fetchImpl(`${model.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${model.apiKey}`,
    },
    body: JSON.stringify({
      model: model.model,
      temperature: 0.3,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
    }),
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`模型 ${response.status}：${body}`);
  }
  const parsed: unknown = await response.json().catch(() => ({}));
  const content = extractChatContent(parsed);
  if (!content) throw new Error("模型返回空正文");
  return content;
}

export function extractChatContent(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") return "";
  const choices = (parsed as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || !choices.length) return "";
  const first = choices[0] as Record<string, unknown>;
  const message = first.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" ? (part as Record<string, unknown>).text : ""))
      .filter((part): part is string => typeof part === "string")
      .join("")
      .trim();
  }
  return "";
}

// ---------------------------------------------------------------------------
// 两个挂点
// ---------------------------------------------------------------------------

export type DraftHookOptions = {
  configPath: string;
  statePath: string;
  deps: DraftDeps;
};

export type InterceptResult = {
  /** 立刻回给用户的第一句。 */
  reply: string;
  /** 可选的后续动作（出稿），中继 await 它并把结果再回一条。 */
  followUp?: () => Promise<string>;
};

/**
 * 挂点对象。中继在 main() 里建一个，每条消息调两次：
 *   intercept(text, messageId)  —— 写 Memos 之前：命中 "1"/「别问了」则接管，不写 Memos；
 *   afterWritten(...)           —— 写 Memos 成功之后：决定回执是「已记」还是带 offer / 周计数。
 * 两个方法都不抛：内部异常 → 记日志 → 返回 null（中继按原样「已记」）。
 */
export class DraftHook {
  private readonly configPath: string;
  private readonly state: DraftState;
  private readonly deps: DraftDeps;

  constructor(options: DraftHookOptions) {
    this.configPath = options.configPath;
    this.deps = options.deps;
    this.state = new DraftState(options.statePath);
    this.state.load();
  }

  /** 当前是否开启（每次重读配置）。 */
  config(): DraftConfig {
    return loadDraftConfig(this.configPath);
  }

  /** 给含 B 站链接的速记追加的标签；关闭时或无链接时为空串。 */
  memoSuffix(text: string): string {
    try {
      const config = this.config();
      if (!config.enabled) return "";
      return extractBilibiliUrl(text) ? "\n#发布" : "";
    } catch {
      return "";
    }
  }

  async intercept(text: string, messageId: string): Promise<InterceptResult | null> {
    try {
      const config = this.config();
      if (!config.enabled) return null;
      const now = this.deps.now();
      const trimmed = text.trim();

      if (trimmed === config.muteWord) {
        const until = this.state.mute(now, config.muteDays);
        this.state.save();
        this.deps.log({ event: "draft_muted", message_id: messageId, until: until.toISOString() });
        return { reply: buildMuteReply(config.muteDays) };
      }

      if (!config.triggerWords.includes(trimmed)) return null;

      const pending = this.state.takePending(now, config.offerTtlHours);
      this.state.save();
      if (!pending) {
        this.deps.log({ event: "draft_no_pending", message_id: messageId });
        return { reply: NO_PENDING_REPLY };
      }
      this.deps.log({ event: "draft_requested", message_id: messageId, offer_message_id: pending.messageId });
      return {
        reply: ACK_REPLY,
        followUp: () => this.produceDraft(pending, config, messageId),
      };
    } catch (error) {
      this.deps.log({ event: "draft_intercept_error", message_id: messageId, error: safeErrorText(error) });
      return null;
    }
  }

  /** 返回替代「已记」的回执；null = 用缺省「已记」。 */
  async afterWritten(input: { text: string; messageId: string; memo: string }): Promise<string | null> {
    try {
      const config = this.config();
      if (!config.enabled) return null;
      const now = this.deps.now();

      const url = extractBilibiliUrl(input.text);
      if (url) {
        const count = this.state.recordPublished(url, now);
        this.state.save();
        this.deps.log({ event: "published_recorded", message_id: input.messageId, url, week_count: count });
        return buildPublishedReply(count);
      }

      const keyword = detectPitfall(input.text, config.keywords);
      if (!keyword) return null;
      if (!this.state.canOffer(now, config.maxOffersPerDay)) {
        this.deps.log({
          event: "draft_offer_skipped",
          message_id: input.messageId,
          keyword,
          reason: this.state.isMuted(now) ? "muted" : "daily_cap",
        });
        return null;
      }
      this.state.recordOffer(
        { messageId: input.messageId, text: input.text, keyword, memo: input.memo },
        now,
      );
      this.state.save();
      this.deps.log({
        event: "draft_offer",
        message_id: input.messageId,
        keyword,
        offers_today: this.state.offersToday(now),
      });
      return OFFER_REPLY;
    } catch (error) {
      this.deps.log({ event: "draft_after_written_error", message_id: input.messageId, error: safeErrorText(error) });
      return null;
    }
  }

  private async produceDraft(pending: PendingOffer, config: DraftConfig, messageId: string): Promise<string> {
    try {
      const related = await fetchRelatedNotes(pending, config, this.deps);
      this.deps.log({
        event: "draft_related",
        message_id: messageId,
        count: related.items.length,
        unavailable: related.unavailable,
      });
      const prompt = buildDraftPrompt(pending, related.items);
      if (!config.model) throw new Error("draftModel 缺失");
      const draft = await generateDraft(config.model, prompt, this.deps.fetch);
      let bitableUrl: string | undefined;
      if (config.bitableAppToken && config.bitableTableId && config.appId && config.appSecret) {
        const titleMatch = draft.match(/【?标题】?[:：]?\s*([^\n\r]+)/u);
        const title = (titleMatch ? titleMatch[1] : pending.text).trim().slice(0, 80);
        bitableUrl = await syncDraftToBitable(
          config.appId,
          config.appSecret,
          config.bitableAppToken,
          config.bitableTableId,
          title,
          draft,
          pending.text,
          this.deps.fetch,
        );
        if (bitableUrl) {
          this.deps.log({ event: "bitable_synced", app_token: config.bitableAppToken, title });
        }
      }
      this.deps.log({ event: "draft_sent", message_id: messageId, chars: draft.length });
      return renderDraftReply(draft, {
        relatedCount: related.items.length,
        unavailable: related.unavailable,
        bitableUrl,
      });
    } catch (error) {
      const summary = safeErrorText(error);
      this.deps.log({ event: "draft_failed", message_id: messageId, error: summary });
      return buildDraftFailedReply(summary);
    }
  }
}

// ---------------------------------------------------------------------------
// MemOS MCP 客户端（SDK 动态 import，不做单测；测试注入假 caller）
// ---------------------------------------------------------------------------

/**
 * 每次调用新建一条 Streamable HTTP 会话：initialize → tools/call → close。
 * 出稿是低频动作，不值得维护长会话；任何一步失败都抛给上层按「MemOS 不可用」处理。
 */
export const callMemosMcp: MemosToolCaller = async (url, name, args) => {
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
  ]);
  const client = new Client({ name: "pw-feishu-relay", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close().catch(() => undefined);
  }
};

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function safeErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 状态簿路径：与配置同目录。 */
export function defaultDraftStatePath(configPath: string): string {
  const slash = configPath.lastIndexOf("/");
  const dir = slash >= 0 ? configPath.slice(0, slash) : ".";
  return `${dir}/feishu-relay-draft-state.json`;
}

/** 只读探测：配置文件是否存在且可读（供中继启动日志用）。 */
export function draftConfigSummary(configPath: string): Record<string, unknown> {
  try {
    statSync(configPath);
  } catch {
    return { draftOffer: false, reason: "配置不存在" };
  }
  const config = loadDraftConfig(configPath);
  return config.enabled
    ? {
      draftOffer: true,
      keywords: config.keywords.length,
      maxOffersPerDay: config.maxOffersPerDay,
      memosMcp: Boolean(config.memosMcpUrl),
      model: config.model?.model,
    }
    : { draftOffer: false, reason: config.disabledReason };
}
