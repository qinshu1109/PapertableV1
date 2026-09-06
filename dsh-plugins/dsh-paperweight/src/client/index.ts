/**
 * dsh-paperweight client 半入口。
 *
 * 挂点(35a §6.3 三坑已核):
 * - 左栏入口:sidebar.footer.action(list)常驻「镇纸」按钮 + 未读徽标;
 * - 镇纸面板:sidebar.workspaces(single)shadowing 注册(priority -10,lowest renders)——
 *   打开时压过官方 WorkspaceBrowser,点「会话」tab 即 dispose 原样恢复,不碰 root;
 * - 详情浮层:shell.overlay(list)常驻,detail=null 不渲染;
 * - @押注卡:ctx.inputTriggers.registerSource(codec.serialize 展开装配上下文)。
 *
 * 样式:factory 副作用注入 <style>,client-modules 的 claimStyles 自动认领(HMR 安全)。
 */
import { DetailOverlay } from "./DetailOverlay.tsx";
import { PwEntryButton, PwPanel } from "./PwPanel.tsx";
import { pwBetTriggerSource } from "./refSource.ts";
import { pwStore, startUnreadPolling } from "./state.ts";
import { PW_STYLES } from "./styles.ts";

type Disposer = () => void;

interface SlotsService {
  register: (options: Record<string, unknown>, component: unknown) => Disposer;
  inject: (name: string, cb: () => Disposer) => Disposer;
}

interface ClientContext {
  slots: SlotsService;
  inputTriggers: { registerSource: (source: unknown) => Disposer };
  effect: (cb: () => Disposer | void, label?: string) => void;
}

export const inject = ["slots", "inputTriggers"];

const STYLE_MARK = "dsh-paperweight";

function ensureStyles(): void {
  if (typeof document === "undefined") return;
  if (document.querySelector(`style[data-pwx="${STYLE_MARK}"]`)) return;
  const el = document.createElement("style");
  el.setAttribute("data-pwx", STYLE_MARK);
  el.textContent = PW_STYLES;
  document.head.appendChild(el);
}

ensureStyles();

export function apply(ctx: ClientContext): void {
  ensureStyles();

  // 左栏底部常驻入口(带未读徽标)。
  ctx.effect(
    () =>
      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register({ name: "sidebar.footer.action", id: "pw-entry", order: 5 }, PwEntryButton),
      ),
    "dsh-paperweight: sidebar entry",
  );

  // 详情浮层常驻(自己管显隐)。
  ctx.effect(
    () =>
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register({ name: "shell.overlay", id: "pw-detail-overlay", order: 20 }, DetailOverlay),
      ),
    "dsh-paperweight: detail overlay",
  );

  // 镇纸面板:panelOpen 时 shadowing 占据 sidebar.workspaces,关闭即恢复官方。
  ctx.effect(() => {
    let panelDispose: Disposer | null = null;
    const sync = (): void => {
      const { panelOpen } = pwStore.get();
      if (panelOpen && panelDispose === null) {
        try {
          panelDispose = ctx.slots.register(
            { name: "sidebar.workspaces", id: "pw-panel", priority: -10 },
            PwPanel,
          );
        } catch (e) {
          // slot 未声明或优先级冲突:面板开不了,回退关闭态,不拖垮宿主。
          console.warn("[dsh-paperweight] 占据 sidebar.workspaces 失败:", e);
          pwStore.closePanel();
        }
      } else if (!panelOpen && panelDispose !== null) {
        panelDispose();
        panelDispose = null;
      }
    };
    const unsub = pwStore.subscribe(sync);
    sync();
    return () => {
      unsub();
      if (panelDispose !== null) {
        panelDispose();
        panelDispose = null;
      }
    };
  }, "dsh-paperweight: workspaces shadowing");

  // @押注卡 引用源。
  ctx.effect(() => ctx.inputTriggers.registerSource(pwBetTriggerSource), "dsh-paperweight: @bet source");

  // 未读徽标轮询(30s)。
  ctx.effect(() => startUnreadPolling(), "dsh-paperweight: unread polling");
}
