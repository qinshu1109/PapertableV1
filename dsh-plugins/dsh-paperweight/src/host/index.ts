/**
 * host 半装配入口。
 */
import type { PwHostDeps } from "../types.js";
import { registerWebApi } from "./api.js";
import { registerCommands } from "./commands.js";
import { PW_GUIDE_NAME, PW_GUIDE_ORDER, PW_GUIDE_TEXT } from "./guide.js";
import { registerSessionNotice } from "./notice.js";
import { registerTools } from "./tools.js";
import { PushStore } from "./push.js";

const PW_BOUNDARY_TEXT = [
  "## 镇纸店规（SPEC-harness-write-boundary v1，搬运不许变松）",
  "- 你只有只读查数工具和 pw_draft_bet 一个起草工具；你的工具面里没有 settle/confirm/verdict 写工具。",
  "- 你只摆证据、不给结论；卡面/文案不得出现“推荐”字样。",
  "- 裁决、确认、挑/改/否只能由人亲手点按钮；你不得代替人执行。",
  "- Memos 只读；数据文档只增不改。",
  "- 排序依据必须随证据一起给出，可复核。",
].join("\n");

export function createHost(ctx: any, deps: PwHostDeps = {}): { push: PushStore } {
  const baseUrl = deps.baseUrl || "http://127.0.0.1:4317";
  const push = new PushStore(baseUrl, deps.dataDir);

  registerWebApi(ctx, deps, push);
  registerTools(ctx, deps);
  registerCommands(ctx, deps);
  registerSessionNotice(ctx, deps, push);

  // 铁律 8：店规以普通 systemPrompt 段携带（dsh 无卡定义机制，文本照 SPEC 不放松）。
  const systemPrompt = ctx.systemPrompt ?? ctx.get?.("systemPrompt");
  if (systemPrompt?.section) {
    ctx.effect(() => systemPrompt.section({
      name: PW_GUIDE_NAME,
      order: PW_GUIDE_ORDER,
      text: PW_GUIDE_TEXT,
    }), "dsh-paperweight: systemPrompt workbench-guide");
    ctx.effect(() => systemPrompt.section({
      name: "papertable:write-boundary",
      order: 120,
      text: PW_BOUNDARY_TEXT,
    }), "dsh-paperweight: systemPrompt write-boundary");
  }

  // 定时推送：照 main.ts note-rollup 模式，启动后先跑一次，之后每小时刷新；
  // TASK-PW-74：停产 daily「今日值得看」；due 仅在押注实体仍存在时产出。
  const first = setTimeout(() => {
    void push.refresh().catch((error: unknown) => {
      console.warn(`[dsh-paperweight] 推送首次刷新失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }, 10_000);
  if (typeof first.unref === "function") first.unref();

  const timer = setInterval(() => {
    void push.refresh().catch((error: unknown) => {
      console.warn(`[dsh-paperweight] 推送定时刷新失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }, 60 * 60 * 1000);
  if (typeof timer.unref === "function") timer.unref();

  ctx.effect(() => () => {
    clearTimeout(first);
    clearInterval(timer);
  });

  return { push };
}
