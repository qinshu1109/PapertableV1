import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  Check,
  Cpu,
  Layers,
  Paperclip,
  Plus,
  Quote,
  Square,
  X,
  XCircle,
} from 'lucide-react';
import { useStore, useStreamingTurnId } from '../store';
import { EDGE_META } from '../types';
import { incomingEdge } from '../lib/graph';
import { api } from '../lib/api';

export function Composer({ onLocate }: { onLocate: (cardId: string, turnId?: string) => void }) {
  const {
    cards,
    edges,
    currentCardId,
    references,
    removeReference,
    clearReferences,
    send,
    stopStream,
    showToast,
  } = useStore();
  const streamingTurnId = useStreamingTurnId();
  const [text, setText] = useState('');
  const [ctxOpen, setCtxOpen] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const [modelId, setModelId] = useState<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);

  /* 模型 chip 展示设置里真实配置的模型 ID，不写死 */
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .providerSettings()
        .then((s) => alive && setModelId(s.model))
        .catch(() => {});
    load();
    window.addEventListener('focus', load);
    window.addEventListener('papertable-provider-changed', load);
    return () => {
      alive = false;
      window.removeEventListener('focus', load);
      window.removeEventListener('papertable-provider-changed', load);
    };
  }, []);

  const card = cards.find((c) => c.id === currentCardId);
  const inEdge = card ? incomingEdge(edges, card.id) : undefined;
  const sourceCard = inEdge ? cards.find((c) => c.id === inEdge.sourceCardId) : undefined;
  const meta = inEdge ? EDGE_META[inEdge.type] : null;

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    // 上限约 214px（对齐 ai.explore.poker：约 7 行后改为框内滚动）
    el.style.height = Math.min(el.scrollHeight, 214) + 'px';
  }, [text]);

  const branchIndex = useMemo(() => {
    if (!inEdge || inEdge.type !== 'branch' || !sourceCard) return null;
    return sourceCard.turns.filter((t) => t.role === 'ai').findIndex((t) => t.id === inEdge.sourceTurnId) + 1;
  }, [inEdge, sourceCard]);

  /** 仅向用户展示粗略体积，不冒充 provider 的真实 token 计数。 */
  const size = useMemo(() => {
    let n = card?.turns.reduce((s, t) => s + t.content.length, 0) ?? 0;
    n += references.reduce((s, r) => s + r.excerpt.length, 0);
    if (inEdge?.type === 'branch' && sourceCard && inEdge.sourceTurnId) {
      const idx = sourceCard.turns.findIndex((t) => t.id === inEdge.sourceTurnId);
      n += sourceCard.turns.slice(0, idx + 1).reduce((s, t) => s + t.content.length, 0);
    }
    if (sourceCard) n += sourceCard.title.length + (inEdge?.sourceBlockText?.length ?? 0);
    return n;
  }, [card, references, inEdge, sourceCard]);

  const tokens = Math.round(size / 1.6);

  const submit = () => {
    if (!text.trim() || streamingTurnId) return;
    send(text);
    setText('');
  };

  return (
    <div className="composer-wrap">
      <div className="composer">
        {references.length > 0 && (
          <div className="ref-strip">
            {references.map((r) => (
              <span className="ref-chip" key={r.id}>
                <Quote size={11} style={{ flexShrink: 0 }} />
                <span className="rc-src">{r.sourceTitle}</span>
                <span
                  className="rc-goto"
                  onClick={() => onLocate(r.anchor.cardId, r.anchor.turnId)}
                  role="button"
                  tabIndex={0}
                  title="定位回来源段落"
                  onKeyDown={(e) => e.key === 'Enter' && onLocate(r.anchor.cardId, r.anchor.turnId)}
                >
                  {r.excerpt.length > 34 ? r.excerpt.slice(0, 34) + '…' : r.excerpt}
                </span>
                <button onClick={() => removeReference(r.id)} aria-label="移除引用">
                  <X size={12} />
                </button>
              </span>
            ))}
            <button className="ref-chip" style={{ background: 'transparent' }} onClick={clearReferences}>
              <XCircle size={11} />
              清空
            </button>
          </div>
        )}

        {ctxOpen && (
          <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 35 }} onClick={() => setCtxOpen(false)} />
            <div className="ctx-panel" role="dialog" aria-label="本次上下文">
              <h4>本次上下文</h4>
              <p className="ctx-sub">
                下面是这条提问实际会带入模型的内容。关系类型决定继承策略，引用由你显式添加。
              </p>

              <div className="ctx-group">
                <div className="ctx-group-t">会带入</div>
                <div className="ctx-line">
                  <Layers size={13} color="var(--ctx)" />
                  <span>
                    当前卡片《{card?.title}》的全部 {card?.turns.length ?? 0} 条轮次
                  </span>
                </div>
                {sourceCard && meta && (
                  <div className="ctx-line">
                    <Check size={13} color="var(--ctx)" />
                    <span>
                      来源主题：{sourceCard.title}
                      <br />
                      <em>{meta.policyLabel}</em>
                    </span>
                  </div>
                )}
                {inEdge?.sourceText && (
                  <div className="ctx-line">
                    <Check size={13} color="var(--ctx)" />
                    <span>
                      来源片段：「{inEdge.sourceText}」<br />
                      <em>作为背景注入，不作为对话轮次</em>
                    </span>
                  </div>
                )}
                {branchIndex !== null && sourceCard && (
                  <div className="ctx-line">
                    <Check size={13} color="var(--branch)" />
                    <span>
                      继承《{sourceCard.title}》第 1–{branchIndex} 轮历史
                      <br />
                      <em>分支点：第 {branchIndex} 轮</em>
                    </span>
                  </div>
                )}
                {references.map((r) => (
                  <div className="ctx-line" key={r.id}>
                    <Quote size={13} color="var(--ctx)" />
                    <span>
                      引用 · {r.sourceTitle}
                      <br />
                      <em>{r.excerpt.slice(0, 46)}…</em>
                    </span>
                  </div>
                ))}
              </div>

              <div className="ctx-group">
                <div className="ctx-group-t">不会带入</div>
                {inEdge?.type === 'child' && sourceCard && (
                  <div className="ctx-line excluded">
                    <XCircle size={13} />
                    <span>
                      《{sourceCard.title}》的完整对话历史
                      <br />
                      <em>深挖只继承主题与选中片段</em>
                    </span>
                  </div>
                )}
                {inEdge?.type === 'divergent' && sourceCard && (
                  <div className="ctx-line excluded">
                    <XCircle size={13} />
                    <span>
                      《{sourceCard.title}》的任何对话内容
                      <br />
                      <em>发散只保留标题作为相关主题</em>
                    </span>
                  </div>
                )}
                {branchIndex !== null && sourceCard && (
                  <div className="ctx-line excluded">
                    <XCircle size={13} />
                    <span>
                      《{sourceCard.title}》第 {branchIndex} 轮之后的内容
                      <br />
                      <em>分支点之后属于另一条路径</em>
                    </span>
                  </div>
                )}
                <div className="ctx-line excluded">
                  <XCircle size={13} />
                  <span>项目中其他分支的卡片</span>
                </div>
              </div>

              <div className="ctx-foot">
                <span>约 {tokens.toLocaleString()} tokens（按字符粗略估算）</span>
              </div>
            </div>
          </>
        )}

        <div className="composer-box">
          {/* 「+」收纳按钮：附件、上下文等零散动作收进一张菜单（对标 ChatGPT 网页版） */}
          <div style={{ position: 'relative' }}>
            <button
              className={`plus-btn${plusOpen ? ' on' : ''}`}
              onClick={() => setPlusOpen((v) => !v)}
              title="更多功能"
              aria-label="更多功能"
            >
              <Plus size={17} />
            </button>
            {plusOpen && (
              <>
                <div style={{ position: 'fixed', inset: 0, zIndex: 45 }} onClick={() => setPlusOpen(false)} />
                <div className="menu plus-menu">
                  <button
                    className="menu-item"
                    onClick={() => {
                      setPlusOpen(false);
                      showToast({ text: '原型中附件只表现交互状态，不做真实解析' });
                    }}
                  >
                    <Paperclip size={14} />
                    添加附件
                  </button>
                  <button
                    className="menu-item"
                    onClick={() => {
                      setPlusOpen(false);
                      setCtxOpen(true);
                    }}
                  >
                    <Layers size={14} />
                    本次上下文
                    <span className="ctx-count">{1 + (sourceCard ? 1 : 0) + references.length}</span>
                  </button>
                </div>
              </>
            )}
          </div>

          <span className="chip-btn" title="模型 ID、URL 与密钥在设置中配置">
            <Cpu size={13} />
            {modelId ?? '未配置模型'}
          </span>

          <textarea
            ref={ta}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="探索一切…… (Enter = 换行) | (Ctrl+Enter = 发送)"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                submit();
              }
            }}
            aria-label="提问输入框"
          />

          {streamingTurnId ? (
            <button className="send-btn stop" onClick={stopStream} title="停止生成" aria-label="停止生成">
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button
              className="send-btn"
              onClick={submit}
              disabled={!text.trim()}
              title="发送 (Ctrl+Enter)"
              aria-label="发送"
            >
              <ArrowUp size={17} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
