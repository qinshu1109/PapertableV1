import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  Check,
  ChevronDown,
  Cpu,
  Layers,
  Paperclip,
  Quote,
  Square,
  X,
  XCircle,
} from 'lucide-react';
import { useStore } from '../store';
import { EDGE_META } from '../types';
import { incomingEdge } from '../lib/graph';

const MODELS = [
  { id: 'local-a', name: '本地 · 长文推理', note: '适合长篇解释与推导' },
  { id: 'local-b', name: '本地 · 快速问答', note: '响应快，适合追问' },
  { id: 'func', name: '功能模型', note: '生成标题与概念标注' },
];

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
    streamingTurnId,
    showToast,
  } = useStore();
  const [text, setText] = useState('');
  const [model, setModel] = useState(MODELS[0]);
  const [modelOpen, setModelOpen] = useState(false);
  const [ctxOpen, setCtxOpen] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);

  const card = cards.find((c) => c.id === currentCardId);
  const inEdge = card ? incomingEdge(edges, card.id) : undefined;
  const sourceCard = inEdge ? cards.find((c) => c.id === inEdge.sourceCardId) : undefined;
  const meta = inEdge ? EDGE_META[inEdge.type] : null;

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 132) + 'px';
  }, [text]);

  const branchIndex = useMemo(() => {
    if (!inEdge || inEdge.type !== 'branch' || !sourceCard) return null;
    return sourceCard.turns.filter((t) => t.role === 'ai').findIndex((t) => t.id === inEdge.sourceTurnId) + 1;
  }, [inEdge, sourceCard]);

  /** 模拟上下文体积：粗略按字符估算 */
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
  const pct = Math.min(100, Math.round((tokens / 8000) * 100));

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
                <span>
                  约 {tokens.toLocaleString()} tokens · 预算 8,000
                </span>
                <span className="meter" aria-label={`上下文占用 ${pct}%`}>
                  <i style={{ width: `${Math.max(4, pct)}%` }} />
                </span>
              </div>
            </div>
          </>
        )}

        <div className="composer-box">
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <button className="chip-btn" onClick={() => setModelOpen((v) => !v)} title="选择模型">
              <Cpu size={13} />
              {model.name}
              <ChevronDown size={12} />
            </button>
            {modelOpen && (
              <>
                <div style={{ position: 'fixed', inset: 0, zIndex: 55 }} onClick={() => setModelOpen(false)} />
                <div className="menu" style={{ bottom: 38, left: 0, minWidth: 208 }}>
                  {MODELS.map((m) => (
                    <button
                      key={m.id}
                      className="menu-item"
                      onClick={() => {
                        setModel(m);
                        setModelOpen(false);
                      }}
                    >
                      {m.id === model.id ? <Check size={14} color="var(--accent)" /> : <span style={{ width: 14 }} />}
                      <span>
                        <span style={{ display: 'block', color: 'var(--ink)' }}>{m.name}</span>
                        <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>{m.note}</span>
                      </span>
                    </button>
                  ))}
                  <div className="menu-note">原型内为本地 mock，不会发起任何网络请求</div>
                </div>
              </>
            )}
          </div>

          <button
            className={`chip-btn${ctxOpen ? ' on' : ''}`}
            onClick={() => setCtxOpen((v) => !v)}
            title="查看本次提问会带入什么上下文"
          >
            <Layers size={13} />
            本次上下文
            <span className="ctx-count">{1 + (sourceCard ? 1 : 0) + references.length}</span>
          </button>

          <textarea
            ref={ta}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="继续追问，或选中上面的文字建立精确引用…"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            aria-label="提问输入框"
          />

          <button
            className="icon-btn"
            title="添加附件"
            onClick={() => showToast({ text: '原型中附件只表现交互状态，不做真实解析' })}
          >
            <Paperclip size={16} />
          </button>

          {streamingTurnId ? (
            <button className="send-btn stop" onClick={stopStream} title="停止生成" aria-label="停止生成">
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button
              className="send-btn"
              onClick={submit}
              disabled={!text.trim()}
              title="发送"
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
