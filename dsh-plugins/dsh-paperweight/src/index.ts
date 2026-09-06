/**
 * dsh-paperweight 插件入口（host 半）。
 * 包形态：main=lib/index.js（本文件编译产物），exports["./client"]=lib/client.js（Claude 补）。
 */
import { createHost } from "./host/index.js";
import type { PwHostDeps } from "./types.js";

/** Cordis 插件名。 */
export const name = "dsh-paperweight";

/**
 * host 半必需服务。
 * 注:此 cordis fork 的 inject 数组即"等待并注入",无 optional 语法——
 * 未列出的服务属性访问会直接 throw(boot 实证:commands 未列导致 web 起不来,
 * 兜底修复记录见 out/37-contract-changes.md #2)。web profile 四者齐备。
 */
export const inject = ["tools", "webServer", "commands", "systemPrompt"];

export function apply(ctx: any, config: Record<string, unknown> = {}): void {
  const deps: PwHostDeps = {
    baseUrl: typeof config.baseUrl === "string" && config.baseUrl.trim()
      ? config.baseUrl.trim()
      : undefined,
    dataDir: typeof config.dataDir === "string" && config.dataDir.trim()
      ? config.dataDir.trim()
      : undefined,
    dailyTime: typeof config.dailyTime === "string" && config.dailyTime.trim()
      ? config.dailyTime.trim()
      : undefined,
  };
  createHost(ctx, deps);
}

export { createHost } from "./host/index.js";
export * from "./types.js";
