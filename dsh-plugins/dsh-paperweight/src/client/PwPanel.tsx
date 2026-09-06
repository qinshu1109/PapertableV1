/**
 * 左栏「镇纸」面板:占据 sidebar.workspaces(shadowing,priority -10)。
 * 顶部「会话 | 镇纸」双 tab(参照 Oil Creator 形态,铁律6):
 * 点「会话」= 卸载本面板,官方 WorkspaceBrowser 原样回来(零功能损失)。
 */
import { BetsSection, NotesSection, OpsSection, PushSection, VaultSection, VoiceSection } from "./sections.tsx";
import { useUi } from "./hooks.tsx";
import { pwStore, type PwSection } from "./state.ts";

const NAV: Array<{ id: PwSection; label: string }> = [
  { id: "push", label: "推送" },
  { id: "bets", label: "押注台" },
  { id: "vault", label: "金子墓碑" },
  { id: "voice", label: "观众声音" },
  { id: "notes", label: "大盘笔记" },
  { id: "ops", label: "运维" },
];

export function PwPanel(): React.ReactNode {
  const { section, unread } = useUi();
  return (
    <div className="pwx pwx-panel">
      <div className="pwx-tabs">
        <button type="button" className="pwx-tab" onClick={() => pwStore.closePanel()}>
          会话
        </button>
        <button type="button" className="pwx-tab on">
          镇纸
        </button>
      </div>
      <div className="pwx-nav" aria-label="镇纸分区">
        {NAV.map((n) => (
          <button
            key={n.id}
            type="button"
            className={section === n.id ? "on" : ""}
            onClick={() => pwStore.setSection(n.id)}
          >
            {n.label}
            {n.id === "push" && unread > 0 && <span className="pwx-dot">{unread > 99 ? "99+" : unread}</span>}
          </button>
        ))}
      </div>
      <div className="pwx-body">
        {section === "push" && <PushSection />}
        {section === "bets" && <BetsSection />}
        {section === "vault" && <VaultSection />}
        {section === "voice" && <VoiceSection />}
        {section === "notes" && <NotesSection />}
        {section === "ops" && <OpsSection />}
      </div>
    </div>
  );
}

/** 左栏底部常驻入口(sidebar.footer.action,带未读徽标)。 */
export function PwEntryButton(): React.ReactNode {
  const { unread, panelOpen } = useUi();
  return (
    <button
      type="button"
      className="pwx pwx-entry"
      onClick={() => (panelOpen ? pwStore.closePanel() : pwStore.openPanel())}
      title={panelOpen ? "回到会话列表" : "打开镇纸区"}
    >
      <span className="pwx-seal">镇</span>
      <span>镇纸</span>
      {unread > 0 && <span className="pwx-dot">{unread > 99 ? "99+" : unread}</span>}
    </button>
  );
}
