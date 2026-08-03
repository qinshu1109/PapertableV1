import { useEffect, useRef, useState } from 'react';
import { GripHorizontal, Loader2, Maximize2, Quote, X } from 'lucide-react';
import { MarkdownView } from '../lib/MarkdownView';
import type { ConceptInsight } from '../types';

export interface ConceptState extends ConceptInsight {
  blockText: string;
  cardId: string;
  turnId: string;
  sourceRunId: string;
  x: number;
  y: number;
  /**
   * 临时卡内容按需生成：legacy = 旧数据自带预写正文；
   * loading/streaming/done/error = 点击后启动的按需概念会话。
   */
  previewRunId?: string;
  previewStatus: 'legacy' | 'loading' | 'streaming' | 'done' | 'error';
  previewText: string;
  previewError?: string;
}

interface Props {
  state: ConceptState;
  sourceTitle: string;
  layer: number;
  onClose: () => void;
  onActivate: () => void;
  onQuote: (text: string) => void;
  onPromote: () => void;
}

export function ConceptPreview({
  state,
  sourceTitle,
  layer,
  onClose,
  onActivate,
  onQuote,
  onPromote,
}: Props) {
  const [pos, setPos] = useState({ x: state.x, y: state.y });
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  useEffect(() => setPos({ x: state.x, y: state.y }), [state.x, state.y]);

  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    onActivate();
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setPos({
      x: Math.max(8, Math.min(window.innerWidth - 200, e.clientX - drag.current.dx)),
      y: Math.max(8, Math.min(window.innerHeight - 120, e.clientY - drag.current.dy)),
    });
  };

  const generating = state.previewStatus === 'loading' || state.previewStatus === 'streaming';
  const ready = state.previewStatus === 'legacy' || state.previewStatus === 'done';

  return (
    <div
      className="concept-pop"
      style={{ left: pos.x, top: pos.y, zIndex: 80 + layer }}
      role="dialog"
      aria-label={`概念解释：${state.term}`}
    >
      <div
        className="cp-head"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={() => (drag.current = null)}
      >
        <GripHorizontal size={14} color="var(--ink-3)" />
        <div className="cp-title">{state.term}</div>
        <span
          style={{
            fontSize: 10.5,
            color: 'var(--ink-3)',
            border: '1px solid var(--line)',
            borderRadius: 99,
            padding: '2px 7px',
          }}
        >
          AI 临时卡
        </span>
        <button className="icon-btn" onClick={onClose} aria-label="关闭概念预览">
          <X size={15} />
        </button>
      </div>

      <div className="cp-body scroll-y md">
        {state.previewStatus === 'loading' && (
          <div className="cp-generating">
            <Loader2 size={14} className="cp-spin" />
            AI 正在检索资料库，现场生成概念解释…
          </div>
        )}
        {state.previewStatus === 'error' && (
          <div className="cp-generating">
            这次概念解释生成失败{state.previewError ? `（${state.previewError}）` : ''}，关闭后重新点击该词可以重试。
          </div>
        )}
        {state.previewText && <MarkdownView content={state.previewText} />}
        {generating && state.previewText && (
          <div className="cp-generating">
            <Loader2 size={13} className="cp-spin" />
            正在继续生成…
          </div>
        )}
      </div>

      <div className="cp-source">
        来源句：{state.blockText.replace(/[#*`>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 92)}…
      </div>

      <div className="cp-foot">
        <button
          className="chip-btn"
          disabled={!state.previewText}
          onClick={() => onQuote(`${state.term}：${state.previewText.split('\n')[0]}`)}
        >
          <Quote size={13} />
          引用
        </button>
        <button
          className="chip-btn"
          style={{ marginLeft: 'auto' }}
          disabled={!ready}
          onClick={onPromote}
          title={
            ready
              ? `把这张临时卡升级为正式卡片，来源保留为「${sourceTitle}」`
              : '概念解释还在生成，完成后再展开'
          }
        >
          <Maximize2 size={13} />
          展开为正式卡片
        </button>
      </div>
    </div>
  );
}
