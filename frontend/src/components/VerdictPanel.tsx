/**
 * 判决簿 UI：
 * - TombstoneBar：改道后 AI 起草的墓碑（proposed），一键确认 / 改写 / 忽略；
 * - Ledger 抽屉：本项目全部金子与墓碑，重新进入时的默认参照。
 */
import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { BookMarked, Check, Gem, Landmark, X } from 'lucide-react';
import { useStore } from '../store';

export function VerdictPanel() {
  const {
    verdicts,
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

  useEffect(() => {
    setDraft(pendingTombstone?.text ?? '');
  }, [pendingTombstone?.id]);

  const gold = verdicts.filter((v) => v.kind === 'gold');
  const tombstones = verdicts.filter((v) => v.kind === 'tombstone');
  const confirmedCount = verdicts.filter((v) => v.status === 'confirmed').length;

  return (
    <>
      {/* 打开判决簿的常驻入口 */}
      <button className="ledger-fab" onClick={() => setLedgerOpen(true)} title="判决簿：金子与墓碑">
        <BookMarked size={14} />
        判决簿{confirmedCount > 0 ? ` · ${confirmedCount}` : ''}
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
              maxLength={200}
              aria-label="墓碑草稿"
            />
            <button
              className="btn primary"
              onClick={() => confirmTombstone(pendingTombstone.id, draft.trim() || undefined)}
            >
              <Check size={13} />
              确认入簿
            </button>
            <button className="btn" onClick={dismissTombstone} title="忽略即不入簿，随耗材蒸发">
              忽略
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
                <button className="icon-btn" onClick={() => setLedgerOpen(false)} aria-label="关闭">
                  <X size={15} />
                </button>
              </div>

              <div className="ledger-body scroll-y">
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
                        {v.status === 'superseded' ? '已 supersede' : 'confirmed · 注入中'}
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
                          <button className="ledger-link warn" onClick={() => supersedeVerdict(v.id)}>
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
                          <button className="ledger-link warn" onClick={() => supersedeVerdict(v.id)}>
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
                  confirmed 判决由宿主注入每个新的干净上下文（干净但不失忆）；只许 supersede，不许删除。
                </p>
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
