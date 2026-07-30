import { randomUUID } from "node:crypto";
import {
  chmodSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { httpError } from "./data.ts";

export const PROVIDER_PROTOCOL = "anthropic-messages" as const;

export type PublicProviderSettings = {
  protocol: typeof PROVIDER_PROTOCOL;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
};

type StoredProviderSettings = {
  protocol: typeof PROVIDER_PROTOCOL;
  baseUrl: string;
  apiKey: string;
  model: string;
  updatedAt: string;
};

export function providerSettingsPath(dataDir: string): string {
  return join(dataDir, "provider.json");
}

export function loadProviderSettings(dataDir: string): PublicProviderSettings {
  const path = providerSettingsPath(dataDir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return publicProviderSettings();
    throw new Error(`云端模型配置无法读取：${error instanceof Error ? error.message : String(error)}`);
  }
  const settings = validateSettings(parsed);
  applySettings(settings);
  chmodSync(path, 0o600);
  return publicProviderSettings();
}

export function saveProviderSettings(
  dataDir: string,
  input: unknown,
): PublicProviderSettings {
  const settings = validateSettings(input, process.env.PAPERTABLE_API_KEY);
  const path = providerSettingsPath(dataDir);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const stored: StoredProviderSettings = {
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
  applySettings(settings);
  return publicProviderSettings();
}

export function publicProviderSettings(): PublicProviderSettings {
  return {
    protocol: PROVIDER_PROTOCOL,
    baseUrl: process.env.PAPERTABLE_BASE_URL?.trim() ?? "",
    model: process.env.PAPERTABLE_MODEL?.trim() ?? "",
    hasApiKey: Boolean(process.env.PAPERTABLE_API_KEY?.trim()),
  };
}

function validateSettings(input: unknown, currentApiKey?: string): Omit<StoredProviderSettings, "updatedAt"> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw httpError(400, "云端模型配置必须是 JSON 对象");
  }
  const record = input as Record<string, unknown>;
  if (record.protocol !== PROVIDER_PROTOCOL) {
    throw httpError(400, "当前只支持 Anthropic Messages 原生协议");
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
  if (/\/messages$/u.test(parsedUrl.pathname)) {
    throw httpError(400, "请填写 Base URL，不要包含 /messages");
  }

  const suppliedApiKey = typeof record.apiKey === "string" ? record.apiKey.trim() : "";
  const apiKey = suppliedApiKey || currentApiKey?.trim() || "";
  if (!apiKey) throw httpError(400, "密钥不能为空");
  if (apiKey.length > 20_000) throw httpError(400, "密钥过长");

  return {
    protocol: PROVIDER_PROTOCOL,
    baseUrl: rawBaseUrl,
    apiKey,
    model: requiredString(record.model, "模型", 200),
  };
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw httpError(400, `${label}不能为空`);
  const clean = value.trim();
  if (clean.length > maxLength) throw httpError(400, `${label}过长`);
  return clean;
}

function applySettings(settings: Omit<StoredProviderSettings, "updatedAt">): void {
  process.env.PAPERTABLE_BASE_URL = settings.baseUrl;
  process.env.PAPERTABLE_API_KEY = settings.apiKey;
  process.env.PAPERTABLE_MODEL = settings.model;
}

function isNodeError(error: unknown, code: string): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === code,
  );
}
