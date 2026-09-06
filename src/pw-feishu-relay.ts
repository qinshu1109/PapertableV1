/**
 * TASK-PW-52：飞书速记输入口（独立中继进程）。
 *
 * 职责：飞书长连接收 p2p 文本消息 → 去重 → 写 Memos 官方 API → 回执。
 * 手机飞书给机器人发一句话，自动变成一条 Memos 笔记（镇纸笔记屏立即可见）。
 *
 * 纪律：
 * - 与镇纸后端（main.ts）完全无关的独立脚本：不 import main.ts 任何路由，
 *   不需要任何 PAPERTABLE_* 环境变量；对镇纸库、语料落盘零写入。
 * - 只处理 chat_type==='p2p' 且 message_type==='text'；群消息 v1 不收。
 * - 去重：message_id 落 feishu-relay-seen.json（与配置同目录，数组封顶 200），
 *   已见过直接跳过不重复写。
 * - 回执 best-effort：失败只记日志不影响主流程。
 * - 全程 stdout 单行日志（JSON 一行一条），launchd 落 ~/Library/Logs/Papertable/。
 * - 纯函数（buildMemoContent / SeenIds / loadRelayConfig）可单测；SDK 长连接
 *   接线部分不做单测（动态 import，测试不加载 SDK）。
 * - 配置：~/Library/Application Support/Papertable/feishu-relay.json（0600）。
 *
 * TASK-PW-75 扩展（pw-feishu-draft.ts）：同一进程内的「像个坑 → 出稿」挂点。总开关是配置里的
 * draftOffer（缺省 false，每条消息重读，改配置即生效）。关闭时本文件行为与 PW-52 完全一致。
 */
import { chmodSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { callMemosMcp, defaultDraftStatePath, draftConfigSummary, DraftHook } from "./pw-feishu-draft.ts";
import { EvidenceHook } from "./pw-evidence-hook.ts";

export type RelayConfig = {
  appId: string;
  appSecret: string;
  memosUrl: string;
  memosToken: string;
  /** 可空字符串（=不挂标签）；配置缺省默认「速记」。 */
  defaultTag: string;
};

const DEFAULT_RELAY_TAG = "速记";
const SEEN_FILE_NAME = "feishu-relay-seen.json";
/** 去重数组封顶（规格写死 200），超出淘汰最旧。 */
const SEEN_CAP = 200;
/** 写 Memos 的本机调用超时（本地服务，15s 兜底防挂起拖住事件处理）。 */
const MEMOS_TIMEOUT_MS = 15_000;

/** 默认配置路径：~/Library/Application Support/Papertable/feishu-relay.json */
export function defaultRelayConfigPath(): string {
  return join(homedir(), "Library", "Application Support", "Papertable", "feishu-relay.json");
}

/**
 * 装配写入 Memos 的 content：原文 +（defaultTag 非空时）`\n#{defaultTag}`。
 * 原文逐字不动（trim 在消息处理层做，不在这里）；空标签不挂。
 */
export function buildMemoContent(text: string, defaultTag: string): string {
  const tag = typeof defaultTag === "string" ? defaultTag.trim() : "";
  return tag ? `${text}\n#${tag}` : text;
}

/**
 * message_id 去重簿：load / has / add / save，封顶 200 淘汰最旧。
 * 坏文件 / 缺文件 load 兜底空集；save 原子写（tmp + rename）且 0600。
 */
export class SeenIds {
  private readonly path: string;
  private readonly cap: number;
  private ids: string[];

  constructor(path: string, cap: number = SEEN_CAP) {
    this.path = path;
    this.cap = cap;
    this.ids = [];
  }

  /** 从磁盘读回；缺文件 / 坏 JSON / 非字符串数组一律空集兜底。 */
  load(): void {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      this.ids = Array.isArray(parsed)
        ? parsed
          .filter((item): item is string => typeof item === "string" && item.length > 0)
          .slice(-this.cap)
        : [];
    } catch {
      this.ids = [];
    }
  }

  has(id: string): boolean {
    return this.ids.includes(id);
  }

  /** 已见过为 no-op；新 id 追加到尾部，超出封顶淘汰最旧的（数组头部）。 */
  add(id: string): void {
    if (this.ids.includes(id)) return;
    this.ids.push(id);
    if (this.ids.length > this.cap) {
      this.ids.splice(0, this.ids.length - this.cap);
    }
  }

  /** 原子写盘（tmp + rename），0600；失败抛错由调用方兜底记日志。 */
  save(): void {
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(this.ids)}\n`, {
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

  get size(): number {
    return this.ids.length;
  }

  /** 当前全部 id（测试 / 排障用，不暴露内部引用）。 */
  get all(): string[] {
    return [...this.ids];
  }
}

/**
 * 读取并逐字段校验中继配置（0600 读取校验）：
 * - appId / appSecret / memosUrl / memosToken 缺或空 → 人话错误（"feishu-relay.json 缺 X"）；
 * - defaultTag 缺省默认「速记」，显式空字符串 = 不挂标签；
 * - 文件权限含组/其他可读 → 拒绝并要求 chmod 600。
 */
export function loadRelayConfig(path: string): RelayConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) throw new Error(`feishu-relay.json 不存在：${path}`);
    throw new Error(
      `feishu-relay.json 无法解析：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("feishu-relay.json 必须是 JSON 对象");
  }
  const record = parsed as Record<string, unknown>;
  const appId = requiredRelayField(record, "appId");
  const appSecret = requiredRelayField(record, "appSecret");
  const memosUrl = requiredRelayField(record, "memosUrl");
  const memosToken = requiredRelayField(record, "memosToken");

  let defaultTag = DEFAULT_RELAY_TAG;
  if (record.defaultTag !== undefined) {
    if (typeof record.defaultTag !== "string") {
      throw new Error("feishu-relay.json 的 defaultTag 必须是字符串");
    }
    defaultTag = record.defaultTag.trim();
  }

  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`feishu-relay.json 权限过宽（当前 ${mode.toString(8)}），请先 chmod 600`);
  }

  return { appId, appSecret, memosUrl, memosToken, defaultTag };
}

function requiredRelayField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`feishu-relay.json 缺 ${field}`);
  }
  return value.trim();
}

function isNodeError(error: unknown, code: string): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === code,
  );
}

// ---------------------------------------------------------------------------
// 主流程（SDK 接线，不做单测）
// ---------------------------------------------------------------------------

/** 日志：stdout 一行一个 JSON。 */
function log(fields: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(fields)}\n`);
}

function safeErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** im.message.receive_v1 事件载荷里用到的字段（其余忽略）。 */
type ReceiveMessage = {
  message_id?: string;
  chat_id?: string;
  chat_type?: string;
  message_type?: string;
  /** 兼容旧版字段名（1.0 schema）。 */
  msg_type?: string;
  content?: string;
};

type ReceiveV1Data = {
  event?: { message?: ReceiveMessage };
  /** 部分 SDK 版本投递时剥掉信封，直接给 { message }。 */
  message?: ReceiveMessage;
};

/** 取消息体：兼容 {event:{message}} 信封与直连 {message} 两种投递形状（2026-08-10 真实事件踩坑：
 *  按信封读导致 chat_type/message_type 全空、消息被误跳过）。 */
export function extractReceiveMessage(data: ReceiveV1Data | null | undefined): ReceiveMessage | undefined {
  return data?.event?.message ?? data?.message ?? undefined;
}

/** 单条消息处理：类型过滤 → 取文本 → 去重 →（PW-75 命令拦截）→ 写 Memos → 回执。 */
async function handleMessage(
  data: ReceiveV1Data,
  config: RelayConfig,
  client: FeishuClient,
  seen: SeenIds,
  draft?: DraftHook,
  evidence?: EvidenceHook,
): Promise<void> {
  const message = extractReceiveMessage(data);
  const chatType = message?.chat_type ?? "";
  const messageType = message?.message_type ?? message?.msg_type ?? "";
  if (chatType !== "p2p" || messageType !== "text") {
    log({ event: "skipped", chat_type: chatType, message_type: messageType });
    return;
  }
  const messageId = message?.message_id ?? "";
  if (!messageId) {
    log({ event: "skipped", reason: "no_message_id" });
    return;
  }
  const text = extractText(message?.content).trim();
  if (!text) {
    log({ event: "skipped", reason: "empty_text", message_id: messageId });
    return;
  }
  if (seen.has(messageId)) {
    log({ event: "duplicate_skipped", message_id: messageId });
    return;
  }
  // 先记去重再写 Memos：同 message_id 重投不会再写第二条
  seen.add(messageId);
  seen.save();

  // PW-75：draftOffer 关闭时 intercept 恒为 null，"1" /「别问了」按普通速记继续往下写
  const intercepted = draft ? await draft.intercept(text, messageId) : null;
  if (intercepted) {
    await replyBestEffort(client, messageId, intercepted.reply);
    if (intercepted.followUp) {
      // 出稿可能跑几十秒；不阻塞事件处理，完成后再回一条
      const followUp = intercepted.followUp;
      void followUp()
        .then((text) => replyBestEffort(client, messageId, text))
        .catch((error) => log({ event: "followup_error", message_id: messageId, error: safeErrorText(error) }));
    }
    return;
  }

  const content = buildMemoContent(text, config.defaultTag) + (draft ? draft.memoSuffix(text) : "");
  let memoName: string;
  try {
    memoName = await writeMemo(config, content);
  } catch (error) {
    const summary = safeErrorText(error);
    log({ event: "write_failed", message_id: messageId, error: summary });
    await replyBestEffort(client, messageId, `没记上：${summary}`);
    return;
  }
  log({ event: "written", message_id: messageId, memo: memoName });
  const reply = (draft ? await draft.afterWritten({ text, messageId, memo: memoName }) : null) ?? "已记";
  await replyBestEffort(client, messageId, reply);

  // PW-76：搜证在「已记」之后异步进行；evidence.enabled 关闭时 onNote 立即返回，零网络请求
  if (evidence) {
    void evidence.onNote({ text, messageId, memo: memoName })
      .catch((error) => log({ event: "evidence_hook_error", message_id: messageId, error: safeErrorText(error) }));
  }
}

/** 取消息文本：content 是 JSON 字符串（{"text":"..."}）；解析失败按空文本。 */
function extractText(contentJson: string | undefined): string {
  try {
    const parsed: unknown = JSON.parse(contentJson ?? "");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const value = (parsed as Record<string, unknown>).text;
      return typeof value === "string" ? value : "";
    }
  } catch {
    // 非 JSON content 按空文本
  }
  return "";
}

/** 写 Memos：POST {memosUrl}/api/v1/memos（Bearer）；非 2xx 抛错带响应体摘要。返回 memo name。 */
async function writeMemo(config: RelayConfig, content: string): Promise<string> {
  const baseUrl = config.memosUrl.replace(/\/+$/u, "");
  const response = await fetch(`${baseUrl}/api/v1/memos`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.memosToken}`,
    },
    body: JSON.stringify({ content, visibility: "PRIVATE" }),
    signal: AbortSignal.timeout(MEMOS_TIMEOUT_MS),
  });
  if (!response.ok) {
    const bodySummary = (await response.text()).slice(0, 200);
    throw new Error(`Memos 写入失败 ${response.status}：${bodySummary}`);
  }
  const parsed: unknown = await response.json().catch(() => ({}));
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    if (typeof record.name === "string" && record.name) return record.name;
    if (typeof record.uid === "string" && record.uid) return record.uid;
  }
  return "";
}

/** 回执 best-effort：失败只记日志。 */
async function replyBestEffort(client: FeishuClient, messageId: string, text: string): Promise<void> {
  try {
    const result = await client.im.v1.message.reply({
      path: { message_id: messageId },
      data: { content: JSON.stringify({ text }), msg_type: "text" },
    });
    if (result && typeof result === "object" && result.code !== 0) {
      log({
        event: "reply_failed",
        message_id: messageId,
        error: `${result.code}: ${result.msg ?? ""}`,
      });
    }
  } catch (error) {
    log({ event: "reply_failed", message_id: messageId, error: safeErrorText(error) });
  }
}

/** 中继进程用到的飞书 SDK 表面（动态 import，避免测试加载 SDK）。 */
type FeishuClient = {
  im: {
    v1: {
      message: {
        reply: (payload: {
          path: { message_id: string };
          data: { content: string; msg_type: string };
        }) => Promise<{ code?: number; msg?: string }>;
      };
    };
  };
};

async function main(): Promise<void> {
  const configPath = process.env.FEISHU_RELAY_CONFIG?.trim() || defaultRelayConfigPath();
  let config: RelayConfig;
  try {
    config = loadRelayConfig(configPath);
  } catch (error) {
    process.stderr.write(`[feishu-relay] 配置读取失败，退出：${safeErrorText(error)}\n`);
    process.exit(1);
  }

  const seen = new SeenIds(join(dirname(configPath), SEEN_FILE_NAME));
  seen.load();

  const draft = new DraftHook({
    configPath,
    statePath: defaultDraftStatePath(configPath),
    deps: {
      now: () => new Date(),
      fetch,
      log,
      memos: { url: config.memosUrl, token: config.memosToken },
      callMemosTool: callMemosMcp,
    },
  });

  const lark = await import("@larksuiteoapi/node-sdk");
  const client = new lark.Client({ appId: config.appId, appSecret: config.appSecret }) as FeishuClient;

  const evidence = new EvidenceHook(configPath, {
    now: () => new Date(),
    fetch,
    log,
    appId: config.appId,
    appSecret: config.appSecret,
    reply: (messageId, text) => replyBestEffort(client, messageId, text),
  });

  const wsClient = new lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: lark.Domain.Feishu,
    loggerLevel: lark.LoggerLevel.info,
    autoReconnect: true,
  });
  const dispatcher = new lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data: ReceiveV1Data) => {
      try {
        await handleMessage(data, config, client, seen, draft, evidence);
      } catch (error) {
        log({ event: "message_error", error: safeErrorText(error) });
      }
    },
  });

  await wsClient.start({ eventDispatcher: dispatcher });
  log({ event: "started", config: configPath, draft: draftConfigSummary(configPath), evidence: evidence.summary() });

  let closing = false;
  const shutdown = (code: number): void => {
    if (closing) return;
    closing = true;
    try {
      wsClient.close();
    } catch {
      // 关闭失败不阻碍退出
    }
    log({ event: "shutdown" });
    process.exit(code);
  };
  process.once("SIGTERM", () => shutdown(0));
  process.once("SIGINT", () => shutdown(0));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  void main().catch((error) => {
    process.stderr.write(`[feishu-relay] 启动失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
