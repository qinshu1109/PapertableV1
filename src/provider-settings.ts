import { randomUUID } from "node:crypto";
import {
  chmodSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Api,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { httpError } from "./data.ts";

const ANTHROPIC_PROTOCOL = "anthropic-messages" as const;
const OPENAI_PROTOCOL = "openai-completions" as const;
export type ProviderProtocol = typeof ANTHROPIC_PROTOCOL | typeof OPENAI_PROTOCOL;
export const PROVIDER_IDS = ["claude", "deepseek", "opencode-go"] as const;
export type ProviderId = typeof PROVIDER_IDS[number];

export type PublicProvider = {
  id: ProviderId;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
};

export type PublicProviderSettings = PublicProvider & {
  activeProviderId: ProviderId;
  providers: PublicProvider[];
};

export type PapertableProvider = {
  models: Models;
  model: Model<Api>;
  thinkingLevel: "off" | "high";
  supportsToolChoice: boolean;
};

const DEEPSEEK_BASE_URL = "https://api.deepseek.com/anthropic";
const OPENCODE_DEFAULT: ProviderConfig = {
  protocol: OPENAI_PROTOCOL,
  baseUrl: "https://opencode.ai/zen/go/v1",
  apiKey: "",
  model: "deepseek-v4-flash",
};

/** 主回答与判决草稿共用这一份 provider、鉴权和协议配置。 */
export function createPapertableProvider(): PapertableProvider {
  const rawBaseUrl = requiredEnv("PAPERTABLE_BASE_URL").replace(/\/+$/u, "");
  const protocol = providerProtocol(
    process.env.PAPERTABLE_PROTOCOL?.trim()
      || (rawBaseUrl === OPENCODE_DEFAULT.baseUrl ? OPENAI_PROTOCOL : ANTHROPIC_PROTOCOL),
  );
  const modelId = requiredEnv("PAPERTABLE_MODEL");
  if (protocol === OPENAI_PROTOCOL) {
    const cloud = opencodeGoProvider();
    const catalogModel = cloud.getModels().find(
      (model) => model.api === OPENAI_PROTOCOL && model.id === modelId,
    );
    if (!catalogModel) throw new Error(`OpenCode Go 不支持模型：${modelId}`);
    process.env.OPENCODE_API_KEY = requiredEnv("PAPERTABLE_API_KEY");
    const model: Model<Api> = { ...catalogModel, baseUrl: rawBaseUrl };
    const models = createModels();
    models.setProvider(cloud);
    return {
      models,
      model,
      thinkingLevel: "off",
      supportsToolChoice: true,
    };
  }

  const baseUrl = rawBaseUrl.replace(/\/v1\/?$/u, "");
  const deepseekThinking = baseUrl === DEEPSEEK_BASE_URL;
  const model: Model<"anthropic-messages"> = {
    id: modelId,
    name: "Papertable cloud model",
    api: "anthropic-messages",
    provider: "papertable-cloud",
    baseUrl,
    headers: { "user-agent": "Papertable/0.2" },
    reasoning: deepseekThinking,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000,
  };
  const models = createModels();
  models.setProvider(createProvider({
    id: "papertable-cloud",
    name: "Papertable cloud model",
    baseUrl: model.baseUrl,
    auth: { apiKey: envApiKeyAuth("Anthropic Messages API key", ["PAPERTABLE_API_KEY"]) },
    models: [model],
    api: anthropicMessagesApi(),
  }));
  return {
    models,
    model,
    thinkingLevel: deepseekThinking ? "high" : "off",
    supportsToolChoice: !deepseekThinking,
  };
}

/** TASK-PW-61：从注册表单独构造 DeepSeek，不改 activeProviderId 与 PAPERTABLE_*。 */
export function createDeepSeekProvider(dataDir: string): PapertableProvider {
  const config = readProviderSettings(dataDir).settings.providers.deepseek;
  if (!config.baseUrl || !config.apiKey || !config.model) {
    throw new Error("DeepSeek 官方未配置");
  }
  const baseUrl = config.baseUrl.replace(/\/+$/u, "").replace(/\/v1\/?$/u, "");
  const model: Model<"anthropic-messages"> = {
    id: config.model,
    name: "DeepSeek 官方",
    api: "anthropic-messages",
    provider: "papertable-deepseek",
    baseUrl,
    headers: { "user-agent": "Papertable/0.2" },
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000,
  };
  const models = createModels();
  models.setProvider(createProvider({
    id: "papertable-deepseek",
    name: "DeepSeek 官方",
    baseUrl,
    auth: {
      apiKey: {
        name: "DeepSeek API key",
        async resolve() {
          return { auth: { apiKey: config.apiKey }, source: "provider.json" };
        },
      },
    },
    models: [model],
    api: anthropicMessagesApi(),
  }));
  return { models, model, thinkingLevel: "high", supportsToolChoice: false };
}

type ProviderConfig = {
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
};

type ProviderRegistry = {
  activeProviderId: ProviderId;
  providers: Record<ProviderId, ProviderConfig>;
};

type StoredProviderSettings = ProviderRegistry & {
  version: 2;
  updatedAt: string;
};

const PROVIDER_NAMES: Record<ProviderId, string> = {
  claude: "Claude",
  deepseek: "DeepSeek 官方",
  "opencode-go": "OpenCode Go",
};
const DEEPSEEK_DEFAULT: ProviderConfig = {
  protocol: ANTHROPIC_PROTOCOL,
  baseUrl: DEEPSEEK_BASE_URL,
  apiKey: "",
  model: "deepseek-v4-flash",
};

export function providerSettingsPath(dataDir: string): string {
  return join(dataDir, "provider.json");
}

export function loadProviderSettings(dataDir: string): PublicProviderSettings {
  const loaded = readProviderSettings(dataDir);
  if (loaded.rewrite) writeSettings(dataDir, loaded.settings);
  else if (loaded.exists) chmodSync(providerSettingsPath(dataDir), 0o600);
  applySettings(loaded.settings.providers[loaded.settings.activeProviderId]);
  return publicSettings(loaded.settings);
}

export function saveProviderSettings(
  dataDir: string,
  input: unknown,
): PublicProviderSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw httpError(400, "云端模型配置必须是 JSON 对象");
  }
  const record = input as Record<string, unknown>;
  const current = readProviderSettings(dataDir).settings;
  const selectedId = record.providerId === undefined
    ? current.activeProviderId
    : providerId(record.providerId);
  const selected = validateProvider(
    record,
    current.providers[selectedId].apiKey,
    true,
    selectedId,
  );
  const settings: ProviderRegistry = {
    activeProviderId: selectedId,
    providers: { ...current.providers, [selectedId]: selected },
  };
  writeSettings(dataDir, settings);
  applySettings(selected);
  return publicSettings(settings);
}

function readProviderSettings(
  dataDir: string,
): { settings: ProviderRegistry; exists: boolean; rewrite: boolean } {
  const path = providerSettingsPath(dataDir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return { settings: environmentSettings(), exists: false, rewrite: false };
    }
    throw new Error(`云端模型配置无法读取：${error instanceof Error ? error.message : String(error)}`);
  }
  const record = object(parsed);
  if (record?.version === 2) {
    const providers = object(record.providers);
    if (!providers) throw httpError(400, "供应商列表格式不正确");
    const missingOpenCode = providers["opencode-go"] === undefined;
    return {
      settings: {
        activeProviderId: providerId(record.activeProviderId),
        providers: {
          claude: validateProvider(providers.claude, undefined, false, "claude"),
          deepseek: validateProvider(providers.deepseek, undefined, false, "deepseek"),
          "opencode-go": missingOpenCode
            ? { ...OPENCODE_DEFAULT }
            : validateProvider(providers["opencode-go"], undefined, false, "opencode-go"),
        },
      },
      exists: true,
      rewrite: missingOpenCode,
    };
  }
  return {
    settings: {
      activeProviderId: "claude",
      providers: {
        claude: validateProvider(parsed, undefined, true, "claude"),
        deepseek: { ...DEEPSEEK_DEFAULT },
        "opencode-go": { ...OPENCODE_DEFAULT },
      },
    },
    exists: true,
    rewrite: true,
  };
}

function validateProvider(
  input: unknown,
  currentApiKey?: string,
  requireApiKey = true,
  id: ProviderId = "claude",
): ProviderConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw httpError(400, "供应商配置必须是 JSON 对象");
  }
  const record = input as Record<string, unknown>;
  const protocol = providerProtocol(record.protocol);
  const expectedProtocol = id === "opencode-go" ? OPENAI_PROTOCOL : ANTHROPIC_PROTOCOL;
  if (protocol !== expectedProtocol) {
    const label = expectedProtocol === OPENAI_PROTOCOL
      ? "OpenAI Chat Completions"
      : "Anthropic Messages";
    throw httpError(400, `${PROVIDER_NAMES[id]} 只支持 ${label} 协议`);
  }

  const suppliedApiKey = typeof record.apiKey === "string" ? record.apiKey.trim() : "";
  const apiKey = suppliedApiKey || currentApiKey?.trim() || "";
  if (
    !requireApiKey
    && !String(record.baseUrl ?? "").trim()
    && !String(record.model ?? "").trim()
    && !apiKey
  ) {
    return { protocol: expectedProtocol, baseUrl: "", apiKey: "", model: "" };
  }

  const rawBaseUrl = requiredString(record.baseUrl, "URL", 2_048).replace(/\/+$/u, "");
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawBaseUrl);
  } catch {
    throw httpError(400, "URL 格式不正确");
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw httpError(400, "URL 只支持 http 或 https");
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw httpError(400, "URL 不能包含用户名或密码");
  }
  if (parsedUrl.search || parsedUrl.hash) {
    throw httpError(400, "URL 不能包含查询参数或片段");
  }
  if (protocol === ANTHROPIC_PROTOCOL && /\/messages$/u.test(parsedUrl.pathname)) {
    throw httpError(400, "请填写 Base URL，不要包含 /messages");
  }
  if (protocol === OPENAI_PROTOCOL && /\/chat\/completions$/u.test(parsedUrl.pathname)) {
    throw httpError(400, "请填写 Base URL，不要包含 /chat/completions");
  }

  if (requireApiKey && !apiKey) throw httpError(400, "密钥不能为空");
  if (apiKey.length > 20_000) throw httpError(400, "密钥过长");

  const model = requiredString(record.model, "模型", 200);
  if (id === "opencode-go" && model !== OPENCODE_DEFAULT.model) {
    throw httpError(400, `OpenCode Go 当前只接入 ${OPENCODE_DEFAULT.model}`);
  }

  return {
    protocol,
    baseUrl: rawBaseUrl,
    apiKey,
    model,
  };
}

function environmentSettings(): ProviderRegistry {
  const rawBaseUrl = process.env.PAPERTABLE_BASE_URL?.trim().replace(/\/+$/u, "") ?? "";
  const inferredProtocol = rawBaseUrl === OPENCODE_DEFAULT.baseUrl
    ? OPENAI_PROTOCOL
    : ANTHROPIC_PROTOCOL;
  const configured: ProviderConfig = {
    protocol: providerProtocol(process.env.PAPERTABLE_PROTOCOL?.trim() || inferredProtocol),
    baseUrl: rawBaseUrl,
    apiKey: process.env.PAPERTABLE_API_KEY?.trim() ?? "",
    model: process.env.PAPERTABLE_MODEL?.trim() ?? "",
  };
  const isOpenCode = configured.protocol === OPENAI_PROTOCOL;
  const isDeepSeek = !isOpenCode && configured.baseUrl === DEEPSEEK_DEFAULT.baseUrl;
  return {
    activeProviderId: isOpenCode ? "opencode-go" : isDeepSeek ? "deepseek" : "claude",
    providers: {
      claude: isDeepSeek || isOpenCode
        ? { protocol: ANTHROPIC_PROTOCOL, baseUrl: "", apiKey: "", model: "" }
        : configured,
      deepseek: isDeepSeek ? configured : { ...DEEPSEEK_DEFAULT },
      "opencode-go": isOpenCode ? configured : { ...OPENCODE_DEFAULT },
    },
  };
}

function publicSettings(settings: ProviderRegistry): PublicProviderSettings {
  const providers = PROVIDER_IDS.map((id): PublicProvider => ({
    id,
    name: PROVIDER_NAMES[id],
    protocol: settings.providers[id].protocol,
    baseUrl: settings.providers[id].baseUrl,
    model: settings.providers[id].model,
    hasApiKey: Boolean(settings.providers[id].apiKey),
  }));
  const active = providers.find((provider) => provider.id === settings.activeProviderId)!;
  return { ...active, activeProviderId: settings.activeProviderId, providers };
}

function writeSettings(dataDir: string, settings: ProviderRegistry): void {
  const path = providerSettingsPath(dataDir);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const stored: StoredProviderSettings = {
    version: 2,
    ...settings,
    updatedAt: new Date().toISOString(),
  };
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may already have been renamed.
    }
    throw error;
  }
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw httpError(400, `${label}不能为空`);
  const clean = value.trim();
  if (clean.length > maxLength) throw httpError(400, `${label}过长`);
  return clean;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function applySettings(settings: ProviderConfig): void {
  process.env.PAPERTABLE_PROTOCOL = settings.protocol;
  process.env.PAPERTABLE_BASE_URL = settings.baseUrl;
  process.env.PAPERTABLE_API_KEY = settings.apiKey;
  process.env.PAPERTABLE_MODEL = settings.model;
}

function providerId(value: unknown): ProviderId {
  if (value === "claude" || value === "deepseek" || value === "opencode-go") return value;
  throw httpError(400, "供应商不存在");
}

function providerProtocol(value: unknown): ProviderProtocol {
  if (value === ANTHROPIC_PROTOCOL || value === OPENAI_PROTOCOL) return value;
  throw httpError(400, "供应商协议不存在");
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isNodeError(error: unknown, code: string): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === code,
  );
}
