/**
 * 推送收件箱（host 半本地元数据）。
 *
 * 不是镇纸业务数据副本/镜像：只存“推送条目”（标题/摘要/来源引用/未读标记），
 * 不缓存 4317 表。写路径只有本插件自己的 feed 文件 + action 日志。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type PwPushFeed,
  type PwPushFeedItem,
} from "../types.js";
import {
  fetchBet,
  fetchConnections,
  fetchDueBets,
  PwApiError,
} from "./pw-client.js";

interface PushState {
  items: PwPushFeedItem[];
  lastDailyDate?: string;
}

const MAX_ITEMS = 500;

export class PushStore {
  private state: PushState = { items: [] };
  private readonly file: string;

  constructor(
    private readonly baseUrl: string,
    dataDir?: string,
  ) {
    const root = dataDir?.trim()
      || process.env.DSH_HOME?.trim()
      || join(homedir(), ".dsh");
    const dir = join(root, "papertable", "dsh-paperweight");
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "push-feed.json");
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, "utf8")) as PushState;
        if (parsed && Array.isArray(parsed.items)) this.state = parsed;
      }
    } catch (error) {
      // 损坏的本地 feed 不阻断插件；从空收件箱开始。
      console.warn(`[dsh-paperweight] push-feed 读取失败，重置：${error instanceof Error ? error.message : String(error)}`);
      this.state = { items: [] };
    }
  }

  private save(): void {
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf8");
      renameSync(tmp, this.file);
    } catch (error) {
      console.warn(`[dsh-paperweight] push-feed 保存失败（不影响内存收件箱）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  list(): PwPushFeed {
    const items = [...this.state.items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { items, unread: items.filter((item) => !item.read).length };
  }

  markRead(input: { id?: string; all?: boolean }): PwPushFeed {
    if (input.all) {
      this.state.items = this.state.items.map((item) => ({ ...item, read: true }));
    } else if (input.id) {
      this.state.items = this.state.items.map((item) =>
        item.id === input.id ? { ...item, read: true } : item,
      );
    }
    this.prune();
    this.save();
    return this.list();
  }

  private prune(): void {
    if (this.state.items.length > MAX_ITEMS) {
      this.state.items = this.state.items.slice(-MAX_ITEMS);
    }
  }

  private upsert(item: PwPushFeedItem): void {
    const idx = this.state.items.findIndex((existing) => existing.id === item.id);
    const existing = idx >= 0 ? this.state.items[idx] : undefined;
    if (existing) {
      this.state.items[idx] = { ...existing, ...item, read: existing.read };
    } else {
      this.state.items.push(item);
    }
  }

  /** 本地日期 YYYY-MM-DD。 */
  private today(): string {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  /**
   * 刷新收件箱：到期待裁决（实体仍在才产出）+ needs_human 数据源。
   * TASK-PW-74：停产 daily「今日值得看」；due 在 pw_bets 空或押注 404 时不产出，并清掉陈旧 daily/due。
   * 幂等：同一天同一来源只保留一条。
   */
  async refresh(): Promise<void> {
    const today = this.today();
    this.dropDailyItems();
    await this.refreshDue(today);
    await this.refreshNeedsHuman(today);
    this.prune();
    this.save();
  }

  private dropDailyItems(): void {
    this.state.items = this.state.items.filter((item) => item.kind !== "daily");
    delete this.state.lastDailyDate;
  }

  private async refreshDue(today: string): Promise<void> {
    let dueBets: Awaited<ReturnType<typeof fetchDueBets>> = [];
    try {
      dueBets = await fetchDueBets(this.baseUrl);
    } catch (error) {
      console.warn(`[dsh-paperweight] 到期提醒生成失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const validIds = new Set<string>();
    for (const bet of dueBets) {
      try {
        await fetchBet(this.baseUrl, bet.id);
        validIds.add(bet.id);
      } catch (error) {
        if (error instanceof PwApiError && error.status === 404) continue;
        console.warn(`[dsh-paperweight] 到期押注核验失败 ${bet.id}：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.state.items = this.state.items.filter((item) => {
      if (item.kind !== "due") return true;
      const betId = item.sourceRefs.find((ref) => ref.type === "bet")?.id;
      return Boolean(betId && validIds.has(betId));
    });
    for (const bet of dueBets) {
      if (!validIds.has(bet.id)) continue;
      const id = `due:${bet.id}:${today}`;
      this.upsert({
        id,
        kind: "due",
        title: `押注到期待裁决：${bet.title}`,
        summary: `结账日 ${bet.checkoutDate ?? "—"}，置信度 ${bet.confidence ?? "—"}%。请到镇纸或本面板人点确认/裁决。`,
        sourceRefs: [{ type: "bet", id: bet.id, label: bet.title }],
        date: today,
        createdAt: new Date().toISOString(),
        read: false,
      });
    }
  }

  private async refreshNeedsHuman(today: string): Promise<void> {
    let connections: Awaited<ReturnType<typeof fetchConnections>> = [];
    try {
      connections = await fetchConnections(this.baseUrl);
    } catch (error) {
      console.warn(`[dsh-paperweight] needs_human 提醒生成失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    for (const conn of connections) {
      if (conn.status !== "needs_human") continue;
      const id = `needs_human:${conn.id}:${today}`;
      const risk = Array.isArray(conn.risk_events) ? conn.risk_events : [];
      const lastReason = risk.length > 0 ? String(risk[risk.length - 1]?.reason ?? "") : "";
      this.upsert({
        id,
        kind: "needs_human",
        title: `数据源需人工处理：${String(conn.platform ?? conn.id)}`,
        summary: lastReason ? `原因：${lastReason}` : "状态 needs_human，请到镇纸运维/数据源处理。",
        sourceRefs: [{ type: "connection", id: String(conn.id), label: String(conn.platform ?? conn.id) }],
        date: today,
        createdAt: new Date().toISOString(),
        read: false,
      });
    }
  }
}

export { PwApiError };
