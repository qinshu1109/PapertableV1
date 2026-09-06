/**
 * TASK-PW-76：搜证挂点——把 collectEvidence（智能体）与 writeEvidenceBundle（落盘）接到中继上。
 *
 * 中继在「写 Memos 成功、已回『已记』」之后调用 onNote()，**不 await**。本模块：
 *   读配置（每条消息重读，fail-closed）→ 日上限 → 搜证 → 写三张表 → 回一行回执。
 * 任何异常只记日志 + 回一行「搜证失败：…」；绝不影响「已记」。
 *
 * 配置全部在 feishu-relay.json 的 evidence 段；enabled 缺省 false。
 */
import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  BitableClient,
  readBitableConfig,
  writeEvidenceBundle,
  type BitableConfig,
  type EvidenceBundle,
  type WriteBundleResult,
} from "./pw-feishu-bitable.ts";
import {
  collectEvidence,
  DEFAULT_STATUS_PROVIDERS,
  DEFAULT_X_SEARCH_URL,
  type CollectorConfig,
  type CollectorDeps,
  type CollectorResult,
} from "./pw-evidence-collector.ts";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export type EvidenceHookConfig = {
  enabled: boolean;
  disabledReason?: string;
  collector: CollectorConfig;
  bitable: BitableConfig;
  maxRunsPerDay: number;
  silentWhenSkipped: boolean;
  silentWhenEmpty: boolean;
};

function s(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = s(value);
    if (text) return text;
  }
  return "";
}

function posInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function disabled(reason: string): EvidenceHookConfig {
  return {
    enabled: false,
    disabledReason: reason,
    collector: {
      model: { baseUrl: "", apiKey: "", model: "" },
      xSearchUrl: DEFAULT_X_SEARCH_URL,
      statusProviders: { ...DEFAULT_STATUS_PROVIDERS },
      denyTerms: [],
      maxToolRounds: 6,
      timeBudgetMs: 90_000,
      maxResultsPerTool: 8,
    },
    bitable: { appToken: "", tables: { notes: "", evidence: "", topics: "" }, dateAs: "timestamp", fieldMap: readBitableConfigSafeDefault() },
    maxRunsPerDay: 40,
    silentWhenSkipped: true,
    silentWhenEmpty: false,
  };
}

function readBitableConfigSafeDefault(): BitableConfig["fieldMap"] {
  return readBitableConfig({ appToken: "x", tables: { notes: "a", evidence: "b", topics: "c" } }).fieldMap;
}

/**
 * 读 feishu-relay.json 的 evidence 段。任何异常返回 enabled=false。
 * 密钥别名：exaApiKey 可放 evidence 段或根级（exaApiKey / EXA_API_KEY）；X 同理（xApiKey / twitterApiIoKey / TWITTERAPI_IO_KEY）。
 */
export function loadEvidenceConfig(configPath: string): EvidenceHookConfig {
  let root: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return disabled("配置不是 JSON 对象");
    root = parsed as Record<string, unknown>;
  } catch (error) {
    return disabled(`配置读取失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const section = root.evidence;
  if (!section || typeof section !== "object" || Array.isArray(section)) return disabled("evidence 段缺失");
  const ev = section as Record<string, unknown>;
  if (ev.enabled !== true) return disabled("evidence.enabled 未开启");

  const modelRaw = (ev.model && typeof ev.model === "object" ? ev.model : {}) as Record<string, unknown>;
  const model = {
    baseUrl: s(modelRaw.baseUrl).replace(/\/+$/u, ""),
    apiKey: s(modelRaw.apiKey),
    model: s(modelRaw.model),
    extraBody: modelRaw.extraBody && typeof modelRaw.extraBody === "object" ? (modelRaw.extraBody as Record<string, unknown>) : undefined,
  };
  if (!model.baseUrl || !model.apiKey || !model.model) return disabled("evidence.model 缺 baseUrl / apiKey / model");

  let bitable: BitableConfig;
  try {
    bitable = readBitableConfig(ev.bitable);
  } catch (error) {
    return disabled(error instanceof Error ? error.message : String(error));
  }

  const providers = ev.statusProviders && typeof ev.statusProviders === "object"
    ? Object.fromEntries(Object.entries(ev.statusProviders as Record<string, unknown>).filter(([, v]) => typeof v === "string" && v).map(([k, v]) => [k.toLowerCase(), String(v)]))
    : { ...DEFAULT_STATUS_PROVIDERS };

  const receipt = (ev.receipt && typeof ev.receipt === "object" ? ev.receipt : {}) as Record<string, unknown>;

  return {
    enabled: true,
    collector: {
      model,
      exaApiKey: firstString(ev.exaApiKey, root.exaApiKey, root.EXA_API_KEY) || undefined,
      xApiKey: firstString(ev.xApiKey, root.xApiKey, root.twitterApiIoKey, root.TWITTERAPI_IO_KEY) || undefined,
      xSearchUrl: firstString(ev.xSearchUrl) || DEFAULT_X_SEARCH_URL,
      githubToken: firstString(ev.githubToken, root.githubToken, root.GITHUB_TOKEN) || undefined,
      statusProviders: Object.keys(providers).length ? providers : { ...DEFAULT_STATUS_PROVIDERS },
      denyTerms: Array.isArray(ev.denyTerms) ? ev.denyTerms.filter((t): t is string => typeof t === "string" && t.trim().length > 0) : [],
      maxToolRounds: posInt(ev.maxToolRounds, 6),
      timeBudgetMs: posInt(ev.timeBudgetMs, 90_000),
      maxResultsPerTool: Math.min(posInt(ev.maxResultsPerTool, 8), 10),
    },
    bitable,
    maxRunsPerDay: posInt(ev.maxRunsPerDay, 40),
    silentWhenSkipped: receipt.silentWhenSkipped !== false,
    silentWhenEmpty: receipt.silentWhenEmpty === true,
  };
}

// ---------------------------------------------------------------------------
// 状态：日计数（防失控），原子写 0600
// ---------------------------------------------------------------------------

export class RunCounter {
  private readonly path: string;
  private data: { day: string; runs: number };

  constructor(path: string) {
    this.path = path;
    this.data = { day: "", runs: 0 };
  }

  load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, unknown>;
      this.data = {
        day: typeof parsed.day === "string" ? parsed.day : "",
        runs: typeof parsed.runs === "number" ? parsed.runs : 0,
      };
    } catch {
      this.data = { day: "", runs: 0 };
    }
  }

  private roll(now: Date): void {
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    if (this.data.day !== key) this.data = { day: key, runs: 0 };
  }

  runsToday(now: Date): number {
    this.roll(now);
    return this.data.runs;
  }

  /** 尝试占一个名额；超限返回 false。 */
  take(now: Date, max: number): boolean {
    this.roll(now);
    if (this.data.runs >= max) return false;
    this.data.runs += 1;
    this.save();
    return true;
  }

  private save(): void {
    const tmp = `${this.path}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(this.data)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      renameSync(tmp, this.path);
      chmodSync(this.path, 0o600);
    } catch {
      try {
        unlinkSync(tmp);
      } catch {
        // ignore
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 回执
// ---------------------------------------------------------------------------

const SOURCE_LABEL: Record<string, string> = { status: "状态页", github: "GitHub", hn: "HN", x: "X", exa: "Web" };

export function buildReceipt(result: CollectorResult, write?: WriteBundleResult): string {
  const n = result.evidence.length;
  const parts: string[] = [`铁证 ${n}`];
  if (n) {
    const counts = new Map<string, number>();
    for (const e of result.evidence) counts.set(e.source, (counts.get(e.source) ?? 0) + 1);
    for (const source of ["status", "github", "hn", "x", "exa"]) {
      const c = counts.get(source);
      if (c) parts.push(`${SOURCE_LABEL[source]} ${c}`);
    }
    const top = result.evidence[0];
    parts.push(`最热：${top.title}（${top.heat}）${top.url}`);
  }
  if (result.hardRedactions) parts.push(`脱敏 ${result.hardRedactions} 处`);
  if (write) {
    parts.push(`表 +${write.created}/~${write.updated}`);
    if (write.tableUrl) parts.push(write.tableUrl);
  }
  parts.push(`主题 ${result.topicKey}`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// 挂点
// ---------------------------------------------------------------------------

export type EvidenceHookDeps = CollectorDeps & {
  appId: string;
  appSecret: string;
  /** 把一行文字回到触发这条速记的会话。 */
  reply: (messageId: string, text: string) => Promise<void>;
  /** 可注入的搜证与落盘实现（测试用）；缺省用真实实现。 */
  collect?: typeof collectEvidence;
  write?: typeof writeEvidenceBundle;
};

export class EvidenceHook {
  private readonly configPath: string;
  private readonly deps: EvidenceHookDeps;
  private readonly counter: RunCounter;
  private client: { key: string; instance: BitableClient } | undefined;
  private inflight = 0;

  constructor(configPath: string, deps: EvidenceHookDeps) {
    this.configPath = configPath;
    this.deps = deps;
    this.counter = new RunCounter(join(dirname(configPath), "feishu-relay-evidence-state.json"));
    this.counter.load();
  }

  config(): EvidenceHookConfig {
    return loadEvidenceConfig(this.configPath);
  }

  /** 启动日志摘要（不含任何密钥）。 */
  summary(): Record<string, unknown> {
    const c = this.config();
    return c.enabled
      ? {
        enabled: true,
        model: c.collector.model.model,
        exa: Boolean(c.collector.exaApiKey),
        x: Boolean(c.collector.xApiKey),
        github: Boolean(c.collector.githubToken),
        statusProviders: Object.keys(c.collector.statusProviders),
        maxRunsPerDay: c.maxRunsPerDay,
      }
      : { enabled: false, reason: c.disabledReason };
  }

  private bitable(config: BitableConfig): BitableClient {
    const key = `${config.appToken}|${config.tables.notes}|${config.tables.evidence}|${config.tables.topics}`;
    if (!this.client || this.client.key !== key) {
      this.client = {
        key,
        instance: new BitableClient(config, {
          fetch: this.deps.fetch,
          now: this.deps.now,
          log: this.deps.log,
          appId: this.deps.appId,
          appSecret: this.deps.appSecret,
        }),
      };
    }
    return this.client.instance;
  }

  /**
   * 一条速记已写入 Memos 之后调用。返回 Promise 但调用方应 `void` 它。
   * 返回值仅供测试断言：{ status, receipt? }。
   */
  async onNote(input: { text: string; messageId: string; memo: string }): Promise<{ status: string; receipt?: string }> {
    let config: EvidenceHookConfig;
    try {
      config = this.config();
    } catch (error) {
      this.deps.log({ event: "evidence_config_error", error: String(error) });
      return { status: "config_error" };
    }
    if (!config.enabled) return { status: "disabled" };

    const now = this.deps.now();
    if (!this.counter.take(now, config.maxRunsPerDay)) {
      this.deps.log({ event: "evidence_skipped", reason: "daily_cap", message_id: input.messageId });
      return { status: "daily_cap" };
    }

    this.inflight += 1;
    try {
      const collect = this.deps.collect ?? collectEvidence;
      const result = await collect(input.text, config.collector, this.deps);
      this.deps.log({
        event: "evidence_collected",
        message_id: input.messageId,
        skipped: result.skipped,
        topic: result.topicKey,
        evidence: result.evidence.length,
        stats: result.stats,
      });

      if (result.skipped) {
        if (!config.silentWhenSkipped) await this.deps.reply(input.messageId, `不像可搜的技术现象，未搜证（${result.reason}）`);
        return { status: "skipped" };
      }

      const bundle: EvidenceBundle = {
        topicKey: result.topicKey,
        note: { text: result.redactedNote, memo: input.memo, at: now.toISOString(), queries: result.queries },
        evidence: result.evidence.map((e) => ({
          key: e.key,
          title: e.title,
          url: e.url,
          source: e.source,
          tier: e.tier,
          publishedAt: e.publishedAt,
          quote: e.quote,
          metrics: e.metrics,
          heat: e.heat,
          why: e.why,
        })),
      };

      let write: WriteBundleResult | undefined;
      let writeError: string | undefined;
      try {
        const writer = this.deps.write ?? writeEvidenceBundle;
        write = await writer(this.bitable(config.bitable), bundle);
        this.deps.log({ event: "evidence_written", message_id: input.messageId, ...write });
      } catch (error) {
        writeError = error instanceof Error ? error.message : String(error);
        this.deps.log({ event: "evidence_write_failed", message_id: input.messageId, error: writeError });
      }

      if (!result.evidence.length && config.silentWhenEmpty && !writeError) return { status: "empty_silent" };

      let receipt = buildReceipt(result, write);
      if (writeError) receipt = `${receipt} · 落表失败：${writeError}`;
      await this.deps.reply(input.messageId, receipt);
      return { status: writeError ? "written_failed" : "ok", receipt };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log({ event: "evidence_failed", message_id: input.messageId, error: message });
      try {
        await this.deps.reply(input.messageId, `搜证失败：${message}`);
      } catch {
        // 回执失败只记日志
      }
      return { status: "failed" };
    } finally {
      this.inflight -= 1;
    }
  }

  get inflightCount(): number {
    return this.inflight;
  }
}
