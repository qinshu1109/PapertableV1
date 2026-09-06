/**
 * host 半斜杠命令：/bets 列在途押注。
 * client 半可再注册 commandUi 弹层；host 命令执行入口在这里。
 */
import type { PwHostDeps } from "../types.js";
import { fetchBets } from "./pw-client.js";

export function registerCommands(ctx: any, deps: PwHostDeps): void {
  const commands = ctx.commands ?? ctx.get?.("commands");
  if (!commands?.register) return;

  const baseUrl = deps.baseUrl || "http://127.0.0.1:4317";

  ctx.effect(() => commands.register({
    name: "bets",
    description: "列出镇纸在途押注（只读）",
    input: { hint: "[可选 status=pending]" },
    handler: async () => {
      try {
        const bets = await fetchBets(baseUrl, "pending");
        if (bets.length === 0) {
          return { kind: "success", text: "当前没有在途押注。" };
        }
        const lines = bets.map((bet, index) => {
          const days = bet.daysToCheckout === null ? "—" : `${bet.daysToCheckout} 天`;
          return `${index + 1}. ${bet.title}（${bet.status}，距结账 ${days}，置信度 ${bet.confidence ?? "—"}%）`;
        });
        return { kind: "success", text: `在途押注 ${bets.length} 注：\n${lines.join("\n")}` };
      } catch (error) {
        return { kind: "error", text: `读取押注失败：${error instanceof Error ? error.message : String(error)}` };
      }
    },
  }), "dsh-paperweight: /bets");
}
