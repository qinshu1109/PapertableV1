import { useEffect, useRef, useState } from 'react';
import { GripHorizontal, Maximize2, Quote, X } from 'lucide-react';
import { Markdown } from '../lib/markdown';

export interface ConceptState {
  term: string;
  blockText: string;
  cardId: string;
  turnId?: string;
  x: number;
  y: number;
}

const EXPLAIN = (term: string) => `**${term}**是这一段里最容易卡住的概念，先给一个可以直接用的定义。

它描述的是系统在给定表述框架下的一个结构性属性：换一个表述方式，具体写法会变，但它刻画的对象不变。正因为如此，它才能作为跨章节复用的基础词汇。

在当前上下文中它扮演三个作用：

- 给后面的推导提供统一的记号；
- 把"可观测量"与"状态"分开，避免把两者混为一谈；
- 让不同实验条件下的结果可以放在同一个坐标系里比较。

如果要继续追问，比较有价值的方向是它与相邻概念的边界在哪里。`;

interface Props {
  state: ConceptState;
  sourceTitle: string;
  onClose: () => void;
  onQuote: (text: string) => void;
  onPromote: (term: string, body: string) => void;
}

export function ConceptPreview({ state, sourceTitle, onClose, onQuote, onPromote }: Props) {
  const [pos, setPos] = useState({ x: state.x, y: state.y });
  const [text, setText] = useState('');
  const [done, setDone] = useState(false);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const full = EXPLAIN(state.term);

  useEffect(() => {
    setText('');
    setDone(false);
    let i = 0;
    const id = window.setInterval(() => {
      i += 5;
      setText(full.slice(0, i));
      if (i >= full.length) {
        window.clearInterval(id);
        setDone(true);
      }
    }, 22);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.term, state.cardId]);

  useEffect(() => setPos({ x: state.x, y: state.y }), [state.x, state.y]);

  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
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

  return (
    <div
      className="concept-pop"
      style={{ left: pos.x, top: pos.y }}
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
          {done ? '生成完成' : '生成中'}
        </span>
        <button className="icon-btn" onClick={onClose} aria-label="关闭概念预览">
          <X size={15} />
        </button>
      </div>

      <div className="cp-body scroll-y md">
        <Markdown content={text} />
        {!done && <span className="caret" />}
      </div>

      <div className="cp-source">
        来源句：{state.blockText.replace(/[#*`>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 92)}…
      </div>

      <div className="cp-foot">
        <button className="chip-btn" onClick={() => onQuote(`${state.term}：${full.split('\n')[0]}`)}>
          <Quote size={13} />
          引用
        </button>
        <button
          className="chip-btn"
          style={{ marginLeft: 'auto' }}
          onClick={() => onPromote(state.term, full)}
          title={`把预览升级为正式卡片，来源保留为「${sourceTitle}」`}
        >
          <Maximize2 size={13} />
          展开为卡片
        </button>
      </div>
    </div>
  );
}
