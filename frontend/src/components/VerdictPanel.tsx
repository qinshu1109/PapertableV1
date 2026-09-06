/**
 * 判决簿 UI：
 * - TombstoneBar：改道后 AI 起草的墓碑（proposed），一键确认 / 改写 / 忽略；
 * - Ledger 抽屉：本项目全部金子与墓碑，重新进入时的默认参照。
 */
import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { BookMarked, Check, Gem, Landmark, ScrollText, X } from 'lucide-react';
import { useStore } from '../store';
import { ChainExportDialog } from './ChainExportDialog';

export function VerdictPanel() {
  const {
    verdicts,
    verdictStatus,
    pendingTombstone,
    confirmTombstone,
    dismissTombstone,
    supersedeVerdict,
    ledgerOpen,
    setLedgerOpen,
    cardById,
    setCurrentCard,
  } = useStore();
  const [draft, setDraft] = useState('');
  const [chainExportOpen, setChainExportOpen] = useState(false);

  useEffect(() => {
    setDraft(pendingTombstone?.text ?? '');
  }, [pendingTombstone?.id]);

  const gold = verdicts.filter((v) => v.kind === 'gold');
  const tombstones = verdicts.filter((v) => v.kind === 'tombstone');
  const confirmedCount = verdicts.filter((v) => v.status === 'confirmed').length;
  const revise = (verdict: (typeof verdicts)[number]) => {
    const text = window.prompt('写下替代后的新判决；旧版本会保留，不会删除。', verdict.text);
    if (!text?.trim()) return;
    supersedeVerdict(verdict.id, text.trim(), verdict.handle ?? undefined);
  };

  return (
    <>
      {/* 打开判决簿的常驻入口 */}
      <button
        className="ledger-fab"
        onClick={() => setLedgerOpen(true)}
        title={verdictStatus.available ? 'MemOS 可用' : 'MemOS 不可用，当前使用本机缓存'}
      >
        <BookMarked size={14} />
        判决簿{confirmedCount > 0 ? ` · ${confirmedCount}` : ''}
        {verdictStatus.pending > 0 ? ` · 待重试 ${verdictStatus.pending}` : ''}
      </button>

      {/* 改道后的墓碑确认条 */}
      <AnimatePresence>
        {pendingTombstone && (
          <motion.div
            className="tombstone-bar"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.22 }}
          >
            <Landmark size={14} style={{ flexShrink: 0, color: 'var(--branch)' }} />
            <input
              className="tombstone-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={500}
              aria-label="墓碑草稿"
            />
            <button
              className="btn primary"
              onClick={() => confirmTombstone(pendingTombstone.id, draft.trim() || undefined)}
            >
              <Check size={13} />
              确认入簿
            </button>
            <button className="btn" onClick={dismissTombstone} title="明确跳过：记录 abandoned，但不写入 MemOS">
              跳过
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 判决簿抽屉 */}
      <AnimatePresence>
        {ledgerOpen && (
          <>
            <div className="overlay" onClick={() => setLedgerOpen(false)} role="presentation" />
            <motion.aside
              className="ledger-drawer"
              initial={{ x: 360, opacity: 0.4 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 360, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 300, damping: 32 }}
              aria-label="判决簿"
            >
              <div className="ledger-head">
                <BookMarked size={15} />
                <h3>判决簿</h3>
                <span className="ledger-sub">只存判决，其余皆耗材</span>
                <button
                  type="button"
                  className="btn chain-export-entry"
                  title="AI 总结这个项目卡组的决策链，确认后写进 Memos"
                  onClick={() => setChainExportOpen(true)}
                >
                  <ScrollText size={13} />
                  项目差不多了
                </button>
                <button className="icon-btn" onClick={() => setLedgerOpen(false)} aria-label="关闭">
                  <X size={15} />
                </button>
              </div>

              <div className="ledger-body scroll-y">
                {(!verdictStatus.available || verdictStatus.pending > 0) && (
                  <p className="ledger-empty" role="status">
                    {verdictStatus.available
                      ? `MemOS 已恢复，还有 ${verdictStatus.pending} 条判决等待自动补写。`
                      : `MemOS 当前不可用；判决安全留在本机，待重试 ${verdictStatus.pending} 条。`}
                    {verdictStatus.failed > 0 ? ` 最近失败 ${verdictStatus.failed} 条。` : ''}
                  </p>
                )}
                <div className="ledger-section">
                  <div className="ledger-title">
                    <Gem size={13} style={{ color: 'var(--accent)' }} />
                    金子 · 已确认结论（{gold.length}）
                  </div>
                  {gold.length === 0 && (
                    <p className="ledger-empty">
                      还没有金子。当某轮回答真正解决了你的问题（那 1%），在该轮点「采纳」并亲手铸一个概念把手。
                    </p>
                  )}
                  {gold.map((v) => (
                    <div key={v.id} className={`ledger-item${v.status === 'superseded' ? ' dead' : ''}`}>
                      <div className="ledger-handle">[{v.handle}]</div>
                      <div className="ledger-text">{v.text}</div>
                      <div className="ledger-meta">
                        {v.status === 'superseded' ? '已 supersede' : 'confirmed · 可提供'}
                        {v.cardId && cardById(v.cardId) && (
                          <button
                            className="ledger-link"
                            onClick={() => {
                              setCurrentCard(v.cardId!);
                              setLedgerOpen(false);
                            }}
                          >
                            来源卡片
                          </button>
                        )}
                        {v.status === 'confirmed' && (
                          <button className="ledger-link warn" onClick={() => revise(v)}>
                            supersede
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="ledger-section">
                  <div className="ledger-title">
                    <Landmark size={13} style={{ color: 'var(--branch)' }} />
                    墓碑 · 已否决方向（{tombstones.length}）
                  </div>
                  {tombstones.length === 0 && (
                    <p className="ledger-empty">
                      还没有墓碑。每次改道后 AI 会起草一行「用户否决了 X，因为 Y」，确认后它会阻止后续窗口重新收敛到该方向。
                    </p>
                  )}
                  {tombstones.map((v) => (
                    <div key={v.id} className={`ledger-item${v.status !== 'confirmed' ? ' dead' : ''}`}>
                      <div className="ledger-text">{v.text}</div>
                      <div className="ledger-meta">
                        {v.status}
                        {v.status === 'proposed' && (
                          <button className="ledger-link" onClick={() => confirmTombstone(v.id)}>
                            确认入簿
                          </button>
                        )}
                        {v.status === 'confirmed' && (
                          <button className="ledger-link warn" onClick={() => revise(v)}>
                            supersede
                          </button>
                        )}
                        {v.cardId && cardById(v.cardId) && (
                          <button
                            className="ledger-link"
                            onClick={() => {
                              setCurrentCard(v.cardId!);
                              setLedgerOpen(false);
                            }}
                          >
                            改道卡片
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                <p className="ledger-foot">
                  confirmed 判决只在当前问题相关时注入；召回为空就不注入。只许 supersede，不许删除。
                </p>
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {chainExportOpen && <ChainExportDialog onClose={() => setChainExportOpen(false)} />}
    </>
  );
}
