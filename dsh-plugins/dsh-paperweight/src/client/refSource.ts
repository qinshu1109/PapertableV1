/**
 * @押注卡 引用源:输入框打 @ 出候选,选中后提交时把单卡装配上下文
 * (readBet().contextMarkdown,4317 /api/pw/bets/:id/context 的只读 Markdown)
 * 展开成模型可见文本(35a §3.4 方式2:ReferenceInsert + codec.serialize)。
 */
import type { PwBetView } from "../types.ts";
import { pwApi } from "./api.ts";

let cache: { at: number; bets: PwBetView[] } | null = null;

async function loadBets(): Promise<PwBetView[]> {
  if (cache && Date.now() - cache.at < 5_000) return cache.bets;
  const bets = await pwApi.listBets();
  cache = { at: Date.now(), bets };
  return bets;
}

function refLabel(bet: PwBetView): string {
  return `押注/${bet.title}`;
}

export const pwBetTriggerSource = {
  trigger: "@" as const,
  name: "pw-bet",
  order: 20,
  async candidates(_session: unknown, opts: { query?: string } | undefined) {
    const query = (opts?.query ?? "").trim().toLowerCase();
    let bets: PwBetView[];
    try {
      bets = await loadBets();
    } catch {
      return [];
    }
    const live = bets.filter((b) => b.status === "pending" || b.status === "draft");
    const hit = query
      ? live.filter((b) => b.title.toLowerCase().includes(query) || b.id.toLowerCase().includes(query))
      : live;
    return hit.slice(0, 12).map((b) => ({
      name: b.id,
      description: `${b.title}${b.status === "draft" ? "(草稿)" : ""}`,
    }));
  },
  lexicon(): string[] {
    return cache?.bets.map((b) => b.id) ?? [];
  },
  onPick({ candidate }: { candidate: { name: string; description?: string } }) {
    const bet = cache?.bets.find((b) => b.id === candidate.name);
    return {
      insert: {
        source: "pw-bet",
        ref: candidate.name,
        label: bet ? refLabel(bet) : `押注/${candidate.name}`,
        clipboardText: `[押注卡 ${candidate.name}]`,
      },
    };
  },
  codec: {
    clipboardText: (ref: string): string => `[押注卡 ${ref}]`,
    async serialize(ref: string): Promise<string> {
      try {
        const bet = await pwApi.readBet(ref);
        const header = `标题:${bet.title}\n状态:${bet.status}${
          bet.daysToCheckout !== null ? `(距结账 ${bet.daysToCheckout} 天)` : ""
        }`;
        return `<paperweight-bet id="${ref}">\n${header}\n\n${bet.contextMarkdown}\n</paperweight-bet>`;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return `<paperweight-bet id="${ref}" error="读取失败">${msg}</paperweight-bet>`;
      }
    },
  },
};
