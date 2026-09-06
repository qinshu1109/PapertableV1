/**
 * 极简全局 store(useSyncExternalStore 外部源):
 * 面板开合、当前分区、详情浮层路由、推送未读数轮询。
 */
import { pwApi } from "./api.ts";

export type PwSection = "push" | "bets" | "vault" | "voice" | "notes" | "ops";

export type PwDetailRoute =
  | { kind: "bet"; id: string }
  | { kind: "verdict"; id: string }
  | { kind: "voiceTheme"; id: string }
  | null;

export interface PwUiState {
  panelOpen: boolean;
  section: PwSection;
  detail: PwDetailRoute;
  unread: number;
  /** 数据变更计数:人点按钮成功后 +1,各列表据此刷新。 */
  epoch: number;
}

let state: PwUiState = { panelOpen: false, section: "push", detail: null, unread: 0, epoch: 0 };
const listeners = new Set<() => void>();

function emit(next: Partial<PwUiState>): void {
  state = { ...state, ...next };
  for (const l of [...listeners]) l();
}

export const pwStore = {
  get: (): PwUiState => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  openPanel(section?: PwSection): void {
    emit({ panelOpen: true, ...(section ? { section } : {}) });
  },
  closePanel(): void {
    emit({ panelOpen: false });
  },
  setSection(section: PwSection): void {
    emit({ section });
  },
  openDetail(detail: PwDetailRoute): void {
    emit({ detail });
  },
  closeDetail(): void {
    emit({ detail: null });
  },
  setUnread(unread: number): void {
    if (unread !== state.unread) emit({ unread });
  },
  bump(): void {
    emit({ epoch: state.epoch + 1 });
  },
};

/** 未读徽标轮询(30s);面板关着也要更新入口徽标。失败静默,下轮再试。 */
export function startUnreadPolling(): () => void {
  let stopped = false;
  const tick = async (): Promise<void> => {
    try {
      const feed = await pwApi.pushFeed();
      if (!stopped) pwStore.setUnread(feed.unread);
    } catch {
      /* 静默:host 未起或 4317 未起,徽标保持旧值 */
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), 30_000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
