import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Menu, PanelRightOpen } from 'lucide-react';
import { useStore } from './store';
import { ProjectSidebar } from './components/ProjectSidebar';
import { CardStage } from './components/CardStage';
import { GraphNavigator } from './components/GraphNavigator';
import { Composer } from './components/Composer';
import { ExportDialog, ImportDialog, SettingsDialog, TrashDialog } from './components/Dialogs';
import { VerdictPanel } from './components/VerdictPanel';
import { EDGE_META } from './types';
import { incomingEdge, layoutGraph, pathToRoot } from './lib/graph';

export function App() {
  const { cards, edges, currentCardId, setCurrentCard, collapsed, toast, dismissToast, showToast } = useStore();
  const [sbCollapsed, setSbCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [modal, setModal] = useState<null | 'import' | 'export' | 'settings' | 'trash'>(null);

  const path = useMemo(() => pathToRoot(edges, currentCardId), [edges, currentCardId]);
  const { nodes, hidden } = useMemo(() => layoutGraph(cards, edges, collapsed), [cards, edges, collapsed]);

  const locate = (cardId: string, turnId?: string) => {
    setCurrentCard(cardId);
    if (turnId) {
      window.setTimeout(() => {
        const el = document.getElementById(`turn-${turnId}`);
        el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el?.classList.add('flash');
        window.setTimeout(() => el?.classList.remove('flash'), 1800);
      }, 120);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDrawer(false);
        setModal(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const orderedNodes = useMemo(
    () =>
      [...nodes.values()]
        .filter((n) => !hidden.has(n.id))
        .sort((a, b) => a.depth - b.depth || a.x - b.x)
        .map((n) => cards.find((c) => c.id === n.id)!)
        .filter(Boolean),
    [nodes, hidden, cards],
  );

  return (
    <div className="app">
      {drawer && <div className="drawer-scrim" onClick={() => setDrawer(false)} />}
      <ProjectSidebar
        collapsed={sbCollapsed}
        onToggle={() => setSbCollapsed((v) => !v)}
        drawerOpen={drawer}
        onCloseDrawer={() => setDrawer(false)}
        onImport={() => setModal('import')}
        onExport={() => setModal('export')}
        onSettings={() => setModal('settings')}
        onTrash={() => setModal('trash')}
      />

      <main className="workspace">
        {/* 移动端顶部横向迷你关系导航 */}
        <div className="mini-nav">
          <button className="icon-btn" onClick={() => setDrawer(true)} aria-label="打开项目抽屉">
            <Menu size={17} />
          </button>
          <div className="mini-track">
            {orderedNodes.map((c) => {
              const e = incomingEdge(edges, c.id);
              const cur = c.id === currentCardId;
              const color = e ? EDGE_META[e.type].color : 'var(--ink)';
              return (
                <button
                  key={c.id}
                  className={`mini-node${cur ? ' cur' : ''}`}
                  onClick={() => setCurrentCard(c.id)}
                  style={path.includes(c.id) && !cur ? { borderColor: color } : undefined}
                >
                  <span
                    className="mn-dot"
                    style={{ background: cur ? '#f6f1e9' : color, opacity: c.unread ? 1 : 0.75 }}
                  />
                  {c.title.length > 9 ? c.title.slice(0, 9) + '…' : c.title}
                </button>
              );
            })}
          </div>
          <button
            className="icon-btn"
            onClick={() => showToast({ text: '移动端使用顶部横向迷你导航替代右侧关系图' })}
            aria-label="关系图说明"
          >
            <PanelRightOpen size={16} />
          </button>
        </div>

        <CardStage />
        <Composer onLocate={locate} />
        <VerdictPanel />
      </main>

      <GraphNavigator />

      {modal === 'import' && (
        <ImportDialog
          onClose={() => setModal(null)}
          onDone={(label) => showToast({ text: `已按「${label}」完成导入 · 新增 1 个项目、6 张卡片` })}
        />
      )}
      {modal === 'export' && (
        <ExportDialog
          onClose={() => setModal(null)}
          onDone={(label) => showToast({ text: `已导出为「${label}」· 6 张卡片、5 条关系` })}
        />
      )}
      {modal === 'settings' && <SettingsDialog onClose={() => setModal(null)} />}
      {modal === 'trash' && <TrashDialog onClose={() => setModal(null)} />}

      <AnimatePresence>
        {toast && (
          <motion.div
            className="toast"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.2, ease: [0.22, 0.8, 0.28, 1] }}
            role="status"
          >
            <span>{toast.text}</span>
            {toast.actionLabel && <button onClick={toast.onAction}>{toast.actionLabel}</button>}
            {!toast.actionLabel && (
              <button onClick={dismissToast} aria-label="关闭提示">
                知道了
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
