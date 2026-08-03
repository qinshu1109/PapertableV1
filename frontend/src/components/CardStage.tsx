import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowDownRight,
  ArrowUpLeft,
  Check,
  Copy,
  CornerDownRight,
  GitBranch,
  MoreHorizontal,
  Pencil,
  Quote,
  Split,
  Star,
  Trash2,
} from 'lucide-react';
import { useLiveRun, useStore, useStreamingTurnId } from '../store';
import { EDGE_META } from '../types';
import type { Card, ConceptInsight, EdgeType, Turn } from '../types';
import { incomingEdge, pathToRoot } from '../lib/graph';
import { api, subscribeRun } from '../lib/api';
import { MarkdownView } from '../lib/MarkdownView';
import { extractCitations } from '../lib/normalize';
import { ConceptPreview, type ConceptState } from './ConceptPreview';

interface SelState {
  x: number;
  y: number;
  text: string;
  blockText: string;
  turnId: string;
}

export function CardStage() {
  const {
    cards: storedCards,
    edges,
    currentCardId,
    setCurrentCard,
    renameCard,
    createCard,
    deleteCard,
    toggleFavoriteCard,
    addReference,
    lastCreated,
    showToast,
  } = useStore();
  const live = useLiveRun();
  const streamingTurnId = useStreamingTurnId();
  const cards = useMemo<Card[]>(() => {
    if (!live) return storedCards;
    return storedCards.map((stored) => live.cardId === stored.id
      ? {
          ...stored,
          turns: [
            ...stored.turns,
            {
              id: live.turnId,
              role: 'ai',
              content: live.content,
              streaming: true,
              citations: live.citations,
              activity: live.activity,
              thinking: live.thinking,
              phase: live.phase,
              turnCount: live.turnCount,
            },
          ],
        }
      : stored);
  }, [storedCards, live]);

  const card = cards.find((c) => c.id === currentCardId);
  const path = useMemo(() => pathToRoot(edges, currentCardId), [edges, currentCardId]);
  const ancestors = path.slice(0, -1).slice(-3).reverse();

  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollMem = useRef<Record<string, number>>({});
  const [sel, setSel] = useState<SelState | null>(null);
  const [concepts, setConcepts] = useState<ConceptState[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [spawn, setSpawn] = useState<null | { kind: 'divergent' } | { kind: 'branch' }>(null);
  const [spawnText, setSpawnText] = useState('');
  const [flashTurn, setFlashTurn] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const prevCard = useRef(currentCardId);
  /** 按需概念会话的 SSE 关闭函数（按临时卡 id） */
  const previewClosers = useRef(new Map<string, () => void>());

  const askRenameCard = () => {
    if (!card) return;
    const next = window.prompt('卡片名称', card.title)?.trim();
    if (next && next !== card.title) renameCard(card.id, next);
  };

  const closeConcept = useCallback((id: string) => {
    previewClosers.current.get(id)?.();
    previewClosers.current.delete(id);
    setConcepts((open) => open.filter((item) => item.id !== id));
  }, []);

  /** 用户点击高亮词：临时卡内容按需生成（可复用后端缓存，支持 SSE 流式） */
  const startConceptPreview = useCallback((state: ConceptState) => {
    const patch = (partial: Partial<ConceptState>) =>
      setConcepts((open) => open.map((item) => (item.id === state.id ? { ...item, ...partial } : item)));
    void (async () => {
      try {
        const res = await api.openConceptPreview(state.cardId, {
          sourceRunId: state.sourceRunId,
          conceptId: state.id,
        });
        patch({ previewRunId: res.runId });
        if (res.status === 'ended') {
          patch(
            res.result === 'completed' && res.answer
              ? { previewStatus: 'done', previewText: res.answer }
              : { previewStatus: 'error', previewError: res.result ?? 'failed' },
          );
          return;
        }
        const close = subscribeRun(res.runId, (event) => {
          if (event.event === 'answer_sentence') {
            patch({ previewStatus: 'streaming', previewText: String(event.answer ?? '') });
          }
          if (event.event === 'run_end') {
            patch(
              event.result === 'completed'
                ? { previewStatus: 'done', previewText: String(event.answer ?? '') }
                : { previewStatus: 'error', previewError: String(event.reason ?? 'failed') },
            );
          }
        });
        previewClosers.current.set(state.id, close);
      } catch (error) {
        patch({
          previewStatus: 'error',
          previewError: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }, []);

  /* ---------- 每张卡片独立滚动位置 ---------- */
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (prevCard.current !== currentCardId) prevCard.current = currentCardId;
    el.scrollTop = scrollMem.current[currentCardId] ?? 0;
  }, [currentCardId]);

  const rememberScroll = () => {
    if (bodyRef.current) scrollMem.current[currentCardId] = bodyRef.current.scrollTop;
  };

  const goCard = useCallback(
    (id: string) => {
      rememberScroll();
      setSel(null);
      setConcepts([]);
      setCurrentCard(id);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentCardId, setCurrentCard],
  );

  useEffect(() => setConcepts([]), [currentCardId]);

  /* 切卡/卸载时关闭所有按需概念会话的 SSE */
  useEffect(() => {
    const closers = previewClosers.current;
    return () => {
      closers.forEach((close) => close());
      closers.clear();
    };
  }, [currentCardId]);

  /* ---------- 流式时自动滚到底 ---------- */
  useEffect(() => {
    if (!streamingTurnId || !bodyRef.current) return;
    bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [streamingTurnId, cards]);

  /* ---------- 真实浏览器文本选择 ---------- */
  useEffect(() => {
    const handler = () => {
      const s = window.getSelection();
      if (!s || s.isCollapsed) {
        setSel(null);
        return;
      }
      const text = s.toString().trim();
      if (text.length < 2) {
        setSel(null);
        return;
      }
      const anchorNode = s.anchorNode;
      const host = (anchorNode instanceof Element ? anchorNode : anchorNode?.parentElement)?.closest(
        '[data-turn-ai]',
      ) as HTMLElement | null;
      if (!host) {
        setSel(null);
        return;
      }
      const rect = s.getRangeAt(0).getBoundingClientRect();
      setSel({
        x: Math.max(10, Math.min(rect.left + rect.width / 2 - 96, window.innerWidth - 210)),
        y: Math.max(56, rect.top - 46),
        text,
        blockText: host.innerText.slice(0, 260),
        turnId: host.dataset.turnAi!,
      });
    };
    document.addEventListener('mouseup', handler);
    document.addEventListener('selectionchange', () => {
      const s = window.getSelection();
      if (!s || s.isCollapsed) setSel(null);
    });
    return () => document.removeEventListener('mouseup', handler);
  }, []);

  if (!card)
    return (
      <div className="stage">
        <div className="stage-empty">
          <p className="fmt-name">空项目</p>
          <p className="fmt-desc">在下方输入第一个问题，就会以它创建根卡片并开始检索回答。</p>
        </div>
      </div>
    );

  const inEdge = incomingEdge(edges, card.id);
  const sourceCard = inEdge ? cards.find((c) => c.id === inEdge.sourceCardId) : undefined;
  const meta = inEdge ? EDGE_META[inEdge.type] : null;

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* 原型中忽略剪贴板权限失败 */
    }
    setCopied(key);
    window.setTimeout(() => setCopied(null), 1400);
    showToast({ text: '已复制到剪贴板' });
  };

  /* ---------- 创建关系卡片 ---------- */
  const spawnChild = (opts?: { turnId?: string; text?: string; blockText?: string }) => {
    rememberScroll();
    const title = opts?.text ? opts.text.slice(0, 22) : `${card.title} · 继续深挖`;
    const id = createCard({
      type: 'child',
      sourceCardId: card.id,
      sourceTurnId: opts?.turnId,
      sourceText: opts?.text,
      sourceBlockText: opts?.blockText,
      title,
      seedTurns: [
        {
          id: `t-${Date.now()}`,
          role: 'user',
          content: opts?.text ? `深挖：${opts.text}` : `深挖：请把「${card.title}」再往下讲一层。`,
        },
      ],
    });
    setSel(null);
    window.getSelection()?.removeAllRanges();
    return id;
  };

  const spawnDivergent = (topic: string) => {
    rememberScroll();
    createCard({
      type: 'divergent',
      sourceCardId: card.id,
      title: topic.slice(0, 26),
      seedTurns: [
        { id: `t-${Date.now()}`, role: 'user', content: `发散：${topic}` },
      ],
    });
  };

  const spawnBranch = (turnId: string, index: number) => {
    rememberScroll();
    createCard({
      type: 'branch',
      sourceCardId: card.id,
      sourceTurnId: turnId,
      title: `${card.title} · 另一条路径`,
      seedTurns: [
        {
          id: `t-${Date.now()}`,
          role: 'user',
          content: `从第 ${index} 轮改道：换一个前提重新往下推。`,
        },
      ],
    });
  };

  const backToSource = () => {
    if (!inEdge || !sourceCard) return;
    goCard(sourceCard.id);
    if (inEdge.sourceTurnId) {
      setFlashTurn(inEdge.sourceTurnId);
      window.setTimeout(() => {
        document.getElementById(`turn-${inEdge.sourceTurnId}`)?.scrollIntoView({ block: 'center' });
      }, 60);
      window.setTimeout(() => setFlashTurn(null), 2200);
    }
  };

  /* 卡片进入方向（对齐 2026-08-01 代码复核：统一 350ms 慢-快-慢，按关系分方向） */
  const enter = (() => {
    // 新建卡：从上方以 120%、全透明落入
    if (lastCreated?.cardId === card.id) return { x: 0, y: -60, rotate: 0, scale: 1.2 };
    // 进入已有子卡/concept：从中心略偏右上，120%、顺 5°
    if (inEdge?.type === 'child' || inEdge?.type === 'concept') return { x: 24, y: -24, rotate: 5, scale: 1.2 };
    // 去发散卡：从右边进入
    if (inEdge?.type === 'divergent') return { x: 80, y: 0, rotate: 0, scale: 1 };
    // 去分支卡：从下方进入
    if (inEdge?.type === 'branch') return { x: 0, y: 80, rotate: 0, scale: 1 };
    // 根卡/无关卡：95% 淡入
    return { x: 0, y: 0, rotate: 0, scale: 0.95 };
  })();
  const aiTurns = card.turns.filter((t) => t.role === 'ai');

  return (
    <div className="stage">
      <div className="stack">
        {/* 后方祖先卡片：逐层缩小 4%、左歪 5°、向左上错位，露出可点纸边（对齐 ai.explore.poker 实测） */}
        {ancestors.map((id, i) => {
          const c = cards.find((x) => x.id === id);
          if (!c) return null;
          const depth = i + 1;
          const e = incomingEdge(edges, c.id);
          return (
            <div
              key={id}
              className="back-card"
              onClick={() => goCard(id)}
              role="button"
              tabIndex={0}
              onKeyDown={(ev) => ev.key === 'Enter' && goCard(id)}
              title={`返回「${c.title}」`}
              style={{
                /* 对齐 2026-08-01 代码复核：每层左错 16px、下错 0.7·d² px、-5°、96%、
                   模糊 0.5px、亮度 -5%、透明 -10%；露边保留可点（琴疏拍板） */
                transform: `translate(${-16 * depth}px, ${0.7 * depth * depth}px) rotate(${-5 * depth}deg) scale(${
                  1 - depth * 0.04
                })`,
                transformOrigin: 'center center',
                zIndex: 10 - depth,
                opacity: 1 - depth * 0.1,
                filter: `blur(${depth * 0.5}px) brightness(${1 - depth * 0.05})`,
              }}
            >
              <div className="back-card-label">
                <ArrowUpLeft size={12} />
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: 300,
                  }}
                >
                  {c.title}
                </span>
                <span style={{ color: 'var(--ink-3)', fontSize: 11 }}>
                  · {e ? EDGE_META[e.type].label : '根卡片'}
                </span>
              </div>
            </div>
          );
        })}

        {/* 当前卡片 */}
        <AnimatePresence initial={false}>
          <motion.article
            key={card.id}
            className="card"
            style={{ zIndex: 20 }}
            initial={{ opacity: 0, x: enter.x, y: enter.y, rotate: enter.rotate, scale: enter.scale }}
            animate={{ opacity: 1, x: 0, y: 0, rotate: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.985, transition: { duration: 0.2 } }}
            transition={{ duration: 0.35, ease: [0.4, 0, 0.2, 1] }}
          >
            <header className="card-head">
              <div style={{ flex: 1, minWidth: 0 }}>
                <h1 className="card-title" title="双击重命名卡片" onDoubleClick={askRenameCard}>
                  {card.title}
                </h1>
                <div className="card-meta">
                  <span className={`rel-pill ${inEdge ? inEdge.type : 'root'}`}>
                    {inEdge ? (
                      inEdge.type === 'child' ? (
                        <ArrowDownRight size={12} />
                      ) : inEdge.type === 'divergent' ? (
                        <Split size={12} />
                      ) : (
                        <GitBranch size={12} />
                      )
                    ) : (
                      <CornerDownRight size={12} />
                    )}
                    {meta ? meta.label : '根卡片'}
                  </span>
                  {sourceCard && meta && (
                    <button className="source-pill" onClick={backToSource} title="返回来源卡片并高亮来源位置">
                      <ArrowUpLeft size={11} />
                      <span>
                        {inEdge?.type === 'branch' && inEdge.sourceTurnId
                          ? `从第 ${
                              cards
                                .find((c) => c.id === inEdge.sourceCardId)!
                                .turns.filter((t) => t.role === 'ai')
                                .findIndex((t) => t.id === inEdge.sourceTurnId) + 1
                            } 轮改道：${sourceCard.title}`
                          : `${meta.verb}：${sourceCard.title}`}
                      </span>
                    </button>
                  )}
                  {inEdge?.sourceText && (
                    <span className="rel-pill root" title={inEdge.sourceBlockText}>
                      <Quote size={11} />
                      {inEdge.sourceText.slice(0, 14)}
                    </span>
                  )}
                </div>
              </div>

              <div className="card-head-actions">
                <button
                  className={`icon-btn${card.favorite ? ' active' : ''}`}
                  onClick={() => toggleFavoriteCard(card.id)}
                  title={card.favorite ? '取消收藏' : '收藏卡片'}
                >
                  <Star size={15} fill={card.favorite ? 'currentColor' : 'none'} />
                </button>
                <div style={{ position: 'relative' }}>
                  <button className="icon-btn" onClick={() => setMenuOpen((v) => !v)} title="卡片菜单">
                    <MoreHorizontal size={16} />
                  </button>
                  {menuOpen && (
                    <>
                      <div style={{ position: 'fixed', inset: 0, zIndex: 55 }} onClick={() => setMenuOpen(false)} />
                      <div className="menu" style={{ top: 34, right: 0 }}>
                        <button
                          className="menu-item"
                          onClick={() => {
                            setMenuOpen(false);
                            askRenameCard();
                          }}
                        >
                          <Pencil size={14} />
                          重命名卡片
                        </button>
                        <button
                          className="menu-item"
                          onClick={() => {
                            copy(card.turns.map((t) => t.content).join('\n\n'), 'card');
                            setMenuOpen(false);
                          }}
                        >
                          <Copy size={14} />
                          复制整张卡片
                        </button>
                        <button
                          className="menu-item"
                          onClick={() => {
                            toggleFavoriteCard(card.id);
                            setMenuOpen(false);
                          }}
                        >
                          <Star size={14} />
                          {card.favorite ? '取消收藏' : '收藏卡片'}
                        </button>
                        <div className="menu-sep" />
                        <button
                          className="menu-item danger"
                          onClick={() => {
                            setMenuOpen(false);
                            deleteCard(card.id);
                          }}
                        >
                          <Trash2 size={14} />
                          删除卡片及下游
                        </button>
                        <div className="menu-note">进入回收站，6 秒内可撤销</div>
                      </div>
                    </>
                  )}
                </div>
                <button className="deep-btn" onClick={() => spawnChild()} title="以当前卡片为来源创建深挖卡片">
                  <ArrowDownRight size={14} />
                  深挖
                </button>
              </div>
            </header>

            <div className="card-body scroll-y" ref={bodyRef} onScroll={rememberScroll}>
              <div className="card-body-inner">
                {card.turns.length === 0 && (
                  <div style={{ padding: '40px 0', color: 'var(--ink-3)', fontSize: 14, lineHeight: 1.9 }}>
                    这是一张空白卡片。
                    <br />
                    在下方输入器提问开始，或用底部的三种关系从别处带入上下文。
                  </div>
                )}
                {card.turns.map((turn, idx) => (
                  <TurnBlock
                    key={turn.id}
                    turn={turn}
                    cardTitle={card.title}
                    conceptState={concepts}
                    index={aiTurns.findIndex((t) => t.id === turn.id) + 1}
                    isBranchPoint={flashTurn === turn.id}
                    streaming={streamingTurnId === turn.id}
                    openConceptTerms={concepts
                      .filter((item) => item.cardId === card.id && item.turnId === turn.id)
                      .map((item) => item.term)}
                    onConcept={(concept, blockText, el) => {
                      const r = el.getBoundingClientRect();
                      const existing = concepts.find((item) => item.id === concept.id);
                      if (existing) {
                        setConcepts((open) => [...open.filter((item) => item.id !== concept.id), existing]);
                        return;
                      }
                      const stagger = Math.min(concepts.length, 6) * 22;
                      const state: ConceptState = {
                        ...concept,
                        blockText,
                        cardId: card.id,
                        turnId: turn.id,
                        sourceRunId: turn.runId!,
                        x: Math.max(8, Math.min(r.left + stagger, window.innerWidth - 440)),
                        y: Math.max(8, Math.min(r.bottom + 10 + stagger, window.innerHeight - 340)),
                        previewStatus: concept.body ? 'legacy' : 'loading',
                        previewText: concept.body ?? '',
                      };
                      setConcepts((open) => [...open, state]);
                      // 旧数据自带正文直接展示；新链路点击后才启动按需概念会话
                      if (!concept.body) startConceptPreview(state);
                    }}
                    onChild={() => spawnChild({ turnId: turn.id, blockText: turn.content.slice(0, 200) })}
                    onDivergent={() => setSpawn({ kind: 'divergent' })}
                    onBranch={() => spawnBranch(turn.id, aiTurns.findIndex((t) => t.id === turn.id) + 1)}
                    onQuote={() =>
                      addReference(
                        {
                          cardId: card.id,
                          turnId: turn.id,
                          text: turn.content.replace(/[#*`>|-]/g, '').trim().slice(0, 70),
                          blockText: turn.content.slice(0, 200),
                        },
                        card.title,
                      )
                    }
                    onCopy={() => copy(turn.content, turn.id)}
                    copied={copied === turn.id}
                  />
                ))}
                <div style={{ height: 8 }} />
              </div>
            </div>

            {/* 三种关系：位置 + 图标 + 中文标签 */}
            <div className="relation-bar">
              <div style={{ position: 'relative' }}>
                <button
                  className="rel-btn k-branch"
                  onClick={() => setSpawn({ kind: 'branch' })}
                  title="从某一轮之前的历史另开一条路径"
                >
                  <span className="rel-dir">
                    <GitBranch size={13} />
                  </span>
                  改道
                </button>
                {spawn?.kind === 'branch' && (
                  <>
                    <div style={{ position: 'fixed', inset: 0, zIndex: 45 }} onClick={() => setSpawn(null)} />
                    <div className="spawn-pop" style={{ left: 0, transform: 'none' }}>
                      <h5>选择分支点</h5>
                      <p>新卡片继承分支点之前的历史；之后的内容不会带入。</p>
                      {aiTurns.length === 0 && (
                        <p style={{ marginBottom: 0 }}>当前卡片还没有 AI 回复，先提一个问题再改道。</p>
                      )}
                      {aiTurns.map((t, i) => (
                        <button
                          key={t.id}
                          className="fmt-option"
                          onClick={() => {
                            spawnBranch(t.id, i + 1);
                            setSpawn(null);
                          }}
                        >
                          <span className="fmt-icon">
                            <GitBranch size={14} />
                          </span>
                          <span style={{ minWidth: 0 }}>
                            <span className="fmt-name">第 {i + 1} 轮</span>
                            <span className="fmt-desc">
                              {t.content.replace(/[#*`>|\n-]/g, ' ').trim().slice(0, 42)}…
                            </span>
                          </span>
                        </button>
                      ))}
                      <div className="spawn-row">
                        <button className="btn" onClick={() => setSpawn(null)}>
                          取消
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>

              <button className="rel-btn k-child" onClick={() => spawnChild()} title="沿当前路径继续向下">
                <span className="rel-dir">
                  <ArrowDownRight size={13} />
                </span>
                深挖
              </button>

              <div style={{ position: 'relative' }}>
                <button
                  className="rel-btn k-div"
                  onClick={() => {
                    setSpawnText('');
                    setSpawn({ kind: 'divergent' });
                  }}
                  title="保留主题相关性，但不继承历史"
                >
                  <span className="rel-dir">
                    <Split size={13} />
                  </span>
                  发散
                </button>
                {spawn?.kind === 'divergent' && (
                  <>
                    <div style={{ position: 'fixed', inset: 0, zIndex: 45 }} onClick={() => setSpawn(null)} />
                    <div className="spawn-pop" style={{ right: 0, left: 'auto', transform: 'none' }}>
                      <h5>发散到哪个相关方向？</h5>
                      <p>新卡片只把「{card.title}」当作相关主题，不带入本卡对话历史。</p>
                      <input
                        autoFocus
                        value={spawnText}
                        onChange={(e) => setSpawnText(e.target.value)}
                        placeholder="例如：这个原理在其他领域怎么用？"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && spawnText.trim()) {
                            spawnDivergent(spawnText.trim());
                            setSpawn(null);
                          }
                        }}
                      />
                      <div className="spawn-row">
                        <button className="btn" onClick={() => setSpawn(null)}>
                          取消
                        </button>
                        <button
                          className="btn primary"
                          disabled={!spawnText.trim()}
                          onClick={() => {
                            spawnDivergent(spawnText.trim());
                            setSpawn(null);
                          }}
                        >
                          创建发散卡片
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </motion.article>
        </AnimatePresence>
      </div>

      {/* 文本选择工具栏 */}
      {sel && (
        <div className="sel-toolbar" style={{ left: sel.x, top: sel.y }} role="toolbar" aria-label="选区操作">
          <button
            className="tt-btn c-child"
            onClick={() => spawnChild({ turnId: sel.turnId, text: sel.text, blockText: sel.blockText })}
          >
            <ArrowDownRight size={13} />
            深挖
          </button>
          <button
            className="tt-btn"
            onClick={() => {
              addReference(
                { cardId: card.id, turnId: sel.turnId, text: sel.text, blockText: sel.blockText },
                card.title,
              );
              setSel(null);
              window.getSelection()?.removeAllRanges();
            }}
          >
            <Quote size={13} />
            引用
          </button>
          <button
            className="tt-btn"
            onClick={() => {
              copy(sel.text, 'sel');
              setSel(null);
            }}
          >
            <Copy size={13} />
            复制
          </button>
        </div>
      )}

      {/* AI 概念临时卡：只存在于当前页面，可同时打开多张 */}
      {concepts.map((concept, layer) => (
        <ConceptPreview
          key={concept.id}
          state={concept}
          sourceTitle={card.title}
          layer={layer}
          onActivate={() =>
            setConcepts((open) => {
              const active = open.find((item) => item.id === concept.id);
              return active ? [...open.filter((item) => item.id !== concept.id), active] : open;
            })
          }
          onClose={() => closeConcept(concept.id)}
          onQuote={(text) => {
            addReference(
              {
                cardId: concept.cardId,
                turnId: concept.turnId,
                text,
                blockText: concept.blockText,
              },
              card.title,
            );
            closeConcept(concept.id);
          }}
          onPromote={() => {
            rememberScroll();
            createCard({
              type: 'concept',
              sourceCardId: concept.cardId,
              sourceTurnId: concept.turnId,
              sourceText: concept.term,
              sourceBlockText: concept.blockText,
              sourceRunId: concept.sourceRunId,
              conceptId: concept.id,
              previewRunId: concept.previewRunId,
              title: concept.term,
              seedTurns: [
                {
                  id: `t-${Date.now()}-u`,
                  role: 'user',
                  content: concept.question,
                },
              ],
            });
            setConcepts([]);
          }}
        />
      ))}
    </div>
  );
}

/* ---------------------------------------------------------- */

interface TurnBlockProps {
  turn: Turn;
  cardTitle: string;
  conceptState: readonly ConceptState[];
  index: number;
  isBranchPoint: boolean;
  streaming: boolean;
  openConceptTerms: string[];
  onConcept: (concept: ConceptInsight, blockText: string, el: HTMLElement) => void;
  onChild: () => void;
  onDivergent: () => void;
  onBranch: () => void;
  onQuote: () => void;
  onCopy: () => void;
  copied: boolean;
}

const TurnBlock = memo(function TurnBlock({
  turn,
  index,
  isBranchPoint,
  streaming,
  openConceptTerms,
  onConcept,
  onChild,
  onDivergent,
  onBranch,
  onQuote,
  onCopy,
  copied,
}: TurnBlockProps) {
  const [more, setMore] = useState(false);
  const cited = useMemo(() => extractCitations(turn.content), [turn.content]);

  if (turn.role === 'user') {
    return (
      <div className="turn-user" id={`turn-${turn.id}`}>
        <div className="bubble">{turn.content}</div>
      </div>
    );
  }

  return (
    <div className={`turn turn-ai${isBranchPoint ? ' flash' : ''}`} id={`turn-${turn.id}`}>
      <div className="turn-toolbar" role="toolbar" aria-label={`第 ${index} 轮操作`}>
        <button className="tt-btn c-child" onClick={onChild} title="从此轮创建深挖卡片">
          <ArrowDownRight size={13} />
          深挖
        </button>
        <button className="tt-btn c-div" onClick={onDivergent} title="从此轮创建发散卡片">
          <Split size={13} />
          发散
        </button>
        <button className="tt-btn c-branch" onClick={onBranch} title={`从第 ${index} 轮改道，另开一条路径`}>
          <GitBranch size={13} />
          从此改道
        </button>
        <span className="tt-sep" />
        <button className="tt-btn" onClick={onQuote} title="把本轮加入引用">
          <Quote size={13} />
          引用
        </button>
        <button className="tt-btn" onClick={onCopy} title="复制本轮 Markdown">
          {copied ? <Check size={13} /> : <Copy size={13} />}
          复制
        </button>
        <div style={{ position: 'relative' }}>
          <button className="tt-btn" onClick={() => setMore((v) => !v)} title="更多">
            <MoreHorizontal size={13} />
          </button>
          {more && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 55 }} onClick={() => setMore(false)} />
              <div className="menu" style={{ top: 30, right: 0 }}>
                <button className="menu-item" onClick={() => setMore(false)}>
                  <Star size={14} />
                  收藏本轮
                </button>
                <button
                  className="menu-item"
                  onClick={() => {
                    onCopy();
                    setMore(false);
                  }}
                >
                  <Copy size={14} />
                  复制为纯文本
                </button>
                <div className="menu-note">第 {index} 轮 · 由本地引擎检索生成</div>
              </div>
            </>
          )}
        </div>
      </div>

      <ActivityStrip turn={turn} streaming={streaming} />

      <ThinkingBlock turn={turn} streaming={streaming} />

      {streaming && turn.content.length === 0 && !turn.thinking?.length && (
        <div className="thinking">
          <span className="dot-pulse" />
          {turn.phase === 'tools' ? '正在检索和读取资料…' : '正在规划下一步…'}
        </div>
      )}

      <div className="md" data-turn-ai={turn.id}>
        <MarkdownView
          content={turn.content}
          concepts={turn.concepts?.map((concept) => concept.term)}
          activeConcepts={openConceptTerms}
          onConcept={(term, blockText, el) => {
            const concept = turn.concepts?.find((item) => item.term === term);
            if (concept) onConcept(concept, blockText, el);
          }}
          onCite={(n) => {
            const source = document.querySelector<HTMLDetailsElement>(
              `#turn-${turn.id} [data-cite-order="${n}"]`,
            );
            if (source) {
              source.open = true;
              source.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          }}
        />
        {streaming && turn.content.length > 0 && <span className="caret" />}
      </div>

      <RunFooter turn={turn} streaming={streaming} citeOrder={cited.ids} />
    </div>
  );
}, (previous, next) =>
  previous.turn === next.turn
  && previous.cardTitle === next.cardTitle
  && previous.conceptState === next.conceptState
  && previous.index === next.index
  && previous.isBranchPoint === next.isBranchPoint
  && previous.streaming === next.streaming
  && previous.copied === next.copied
  && previous.openConceptTerms.length === next.openConceptTerms.length
  && previous.openConceptTerms.every((term, index) => term === next.openConceptTerms[index]));

const TOOL_LABEL: Record<string, string> = {
  search_notes: '检索笔记',
  read_notes: '读取原文',
};

/** 工具调用进度：流式时实时展开，完成后折叠为可回看的过程条 */
function ActivityStrip({ turn, streaming }: { turn: Turn; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  const items = turn.activity ?? [];
  if (items.length === 0) return null;

  const line = (item: (typeof items)[number]) => {
    const label = TOOL_LABEL[item.tool] ?? item.tool;
    const detail =
      item.tool === 'search_notes'
        ? item.hitCount !== undefined
          ? ` · 命中 ${item.hitCount} 条`
          : ''
        : item.readCount !== undefined || item.requestedChunks !== undefined
          ? ` · 读取 ${item.readCount ?? item.requestedChunks} 段`
          : '';
    return `${label}${detail}`;
  };

  if (streaming) {
    return (
      <div className="activity-strip live">
        {items.map((item) => (
          <span key={item.id} className={`activity-item ${item.status}`}>
            {item.status === 'running' ? <span className="dot-pulse small" /> : item.status === 'error' ? '⚠' : '✓'}
            {line(item)}
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className="activity-strip">
      <button className="activity-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? '收起过程' : `检索过程 · ${items.length} 步`}
      </button>
      {open &&
        items.map((item) => (
          <span key={item.id} className={`activity-item ${item.status}`}>
            {item.status === 'error' ? '⚠' : '✓'}
            {line(item)}
          </span>
        ))}
    </div>
  );
}

function ThinkingBlock({ turn, streaming }: { turn: Turn; streaming: boolean }) {
  const items = turn.thinking ?? [];
  if (items.length === 0) return null;
  const running = items.some((item) => item.status === 'running');
  return (
    <details className="thinking-block" open={streaming && running}>
      <summary>
        {running && <span className="dot-pulse small" />}
        {running ? '思考中…' : `思考过程 · ${items.length} 段`}
      </summary>
      <div className="thinking-content">
        {items.map((item) => (
          <div key={item.id}>{item.content || '正在组织思路…'}</div>
        ))}
      </div>
    </details>
  );
}

/** 引用芯片 + 终局态 + 采纳（金子） */
function RunFooter({
  turn,
  streaming,
  citeOrder = [],
}: {
  turn: Turn;
  streaming: boolean;
  citeOrder?: string[];
}) {
  const { adoptRun, retryRun } = useStore();
  const [adopting, setAdopting] = useState(false);
  const [handle, setHandle] = useState('');
  const [conclusion, setConclusion] = useState('');
  if (streaming) return null;

  const citations = turn.citations ?? [];
  const verdictUsed = turn.verdictUse?.used ?? [];
  const failedish = turn.status && turn.status !== 'completed';

  return (
    <div className="run-footer">
      {citations.length > 0 && (
        <div className="cite-row">
          {citations.map((c, i) => {
            const order = c.chunkId ? citeOrder.indexOf(String(c.chunkId)) : -1;
            return (
              <details
                key={`${c.chunkId ?? i}`}
                className="cite-chip"
                data-cite-order={order >= 0 ? order + 1 : undefined}
              >
                <summary>
                  §{order >= 0 ? order + 1 : ''} {String(c.path ?? c.relativePath ?? c.chunkId)}
                </summary>
                <div className="cite-excerpt">{String(c.excerpt ?? '未返回引用内容')}</div>
              </details>
            );
          })}
        </div>
      )}

      {verdictUsed.length > 0 && (
        <div className="cite-row verdict-use-row">
          <span className="verdict-use-label">本回答参考了你确认过的判断：</span>
          {verdictUsed.map((v, i) => (
            <details key={v.id ?? i} className="cite-chip verdict-chip">
              <summary>
                ✦ {String(v.snapshot).length > 24 ? `${String(v.snapshot).slice(0, 24)}…` : String(v.snapshot)}
              </summary>
              <div className="cite-excerpt">
                {v.verdictType === 'gold' ? '金子' : '墓碑'} · {String(v.snapshot)}
              </div>
            </details>
          ))}
        </div>
      )}

      {failedish && (
        <div className="run-status">
          {turn.status === 'refused' && turn.reason === 'insufficient_evidence'
            ? '资料不足：已绑定资料库中没有足够证据，本轮拒答而非编造'
            : `本轮未完成 · ${turn.status}${turn.reason && turn.reason !== 'none' ? ` (${turn.reason})` : ''}`}
          {turn.error && <span className="run-error">{turn.error}</span>}
          {turn.runId && (
            <button className="ledger-link" onClick={() => retryRun(turn.runId!)}>
              重试
            </button>
          )}
        </div>
      )}

      {turn.runId && turn.status === 'completed' && !adopting && (
        <button
          className="adopt-btn"
          onClick={() => {
            setConclusion(defaultGoldConclusion(turn.content));
            setAdopting(true);
          }}
          title="把这轮回答采纳为金子，入判决簿"
        >
          ✦ 采纳为金子
        </button>
      )}
      {turn.runId && adopting && (
        <div className="adopt-row">
          <input
            className="tombstone-input"
            placeholder="确认或改写这条一行结论"
            value={conclusion}
            maxLength={500}
            onChange={(e) => setConclusion(e.target.value)}
          />
          <input
            className="tombstone-input"
            placeholder="用你自己的话铸一个概念把手，如：火车—隧道"
            value={handle}
            maxLength={60}
            onChange={(e) => setHandle(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === 'Enter' && handle.trim() && conclusion.trim()) {
                const ok = await adoptRun(turn.runId!, handle.trim(), conclusion.trim());
                if (ok) {
                  setAdopting(false);
                  setHandle('');
                  setConclusion('');
                }
              }
              if (e.key === 'Escape') setAdopting(false);
            }}
          />
          <button
            className="btn primary"
            disabled={!handle.trim() || !conclusion.trim()}
            onClick={async () => {
              const ok = await adoptRun(turn.runId!, handle.trim(), conclusion.trim());
              if (ok) {
                setAdopting(false);
                setHandle('');
                setConclusion('');
              }
            }}
          >
            入簿
          </button>
          <button className="btn" onClick={() => setAdopting(false)}>
            取消
          </button>
        </div>
      )}
    </div>
  );
}

function defaultGoldConclusion(content: string): string {
  const plain = content.replace(/\[\[source:[^\]]+\]\]/g, '').replace(/\s+/g, ' ').trim();
  return (plain.match(/^.{10,}?[。！？.!?]/)?.[0] ?? plain).slice(0, 500);
}
