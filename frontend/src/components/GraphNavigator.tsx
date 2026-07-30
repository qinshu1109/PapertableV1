import { useEffect, useMemo, useRef, useState } from 'react';
import { Crosshair, Minus, Plus } from 'lucide-react';
import { useStore } from '../store';
import { EDGE_META } from '../types';
import { incomingEdge, layoutGraph, outgoingEdges, pathToRoot } from '../lib/graph';

const COLORS: Record<string, string> = {
  child: '#e66a3a',
  divergent: '#6f8c76',
  branch: '#6f7893',
};

/**
 * 边形状：同列直接直线；分岔时走"垂直 → 小圆角 → 水平 → 小圆角 → 垂直"。
 * 比全长三次贝塞尔干净，不会在窄面板里拖出蒙形 S 弯。
 */
function elbowPath(ax: number, ay: number, bx: number, by: number): string {
  if (Math.abs(bx - ax) < 0.5) return `M ${ax} ${ay} L ${bx} ${by}`;
  const r = Math.min(10, Math.abs(bx - ax) / 2, Math.abs(by - ay) / 2.2);
  const midY = ay + (by - ay) / 2;
  const dir = bx > ax ? 1 : -1;
  return [
    `M ${ax} ${ay}`,
    `L ${ax} ${midY - r}`,
    `Q ${ax} ${midY} ${ax + dir * r} ${midY}`,
    `L ${bx - dir * r} ${midY}`,
    `Q ${bx} ${midY} ${bx} ${midY + r}`,
    `L ${bx} ${by}`,
  ].join(' ');
}

export function GraphNavigator() {
  const { cards, edges, currentCardId, setCurrentCard, collapsed, toggleCollapse } = useStore();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const [centerX, setCenterX] = useState(107);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  const { nodes, height, hidden } = useMemo(
    () => layoutGraph(cards, edges, collapsed),
    [cards, edges, collapsed],
  );
  const path = useMemo(() => pathToRoot(edges, currentCardId), [edges, currentCardId]);
  // 语义布局（深挖向下/发散向右/改道向左）的 x 不以 0 为中心，这里按内容包围盒居中
  const { contentMidX, contentWidth } = useMemo(() => {
    const xs = [...nodes.values()].filter((n) => !hidden.has(n.id)).map((n) => n.x);
    if (!xs.length) return { contentMidX: 0, contentWidth: 0 };
    const min = Math.min(...xs);
    const max = Math.max(...xs);
    return { contentMidX: (min + max) / 2, contentWidth: max - min };
  }, [nodes, hidden]);

  // 自动缩放：内容比面板宽时缩到装得下（留出节点半径与标题的余量）
  const [autoFit, setAutoFit] = useState(true);
  useEffect(() => {
    if (!autoFit) return;
    const box = wrapRef.current?.getBoundingClientRect();
    if (!box) return;
    const usable = box.width - 76;
    const next = contentWidth > usable ? Math.max(0.45, usable / contentWidth) : 1;
    setZoom((z) => (Math.abs(z - next) < 0.02 ? z : next));
  }, [contentWidth, autoFit]);
  const pathSet = useMemo(() => new Set(path), [path]);

  const recenter = () => {
    setAutoFit(true);
    const n = nodes.get(currentCardId);
    const box = wrapRef.current?.getBoundingClientRect();
    if (!n || !box) return;
    setZoom(1);
    setPan({ x: -n.x, y: box.height / 2 - 40 - n.y });
  };

  useEffect(() => {
    const n = nodes.get(currentCardId);
    const box = wrapRef.current?.getBoundingClientRect();
    if (!n || !box) return;
    setPan((p) => {
      const screenY = n.y + p.y;
      if (screenY > 34 && screenY < box.height - 34) return p;
      return { x: p.x, y: box.height / 2 - 40 - n.y };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCardId, height]);

  useEffect(() => {
    const box = wrapRef.current?.getBoundingClientRect();
    if (box) {
      setCenterX(box.width / 2);
      setPan({ x: 0, y: Math.max(46, (box.height - height) / 2) });
    }
    // 面板宽度变化（折叠侧边条 / 缩放窗口）时重新居中
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) setCenterX(width / 2);
    });
    if (wrapRef.current) observer.observe(wrapRef.current);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setPan({
      x: drag.current.px + (e.clientX - drag.current.x),
      y: drag.current.py + (e.clientY - drag.current.y),
    });
  };
  const onUp = () => {
    drag.current = null;
  };

  const cardTitle = (id: string) => cards.find((c) => c.id === id)?.title ?? '';
  const relLabel = (id: string) => {
    const e = incomingEdge(edges, id);
    return e ? EDGE_META[e.type].label : '根卡片';
  };

  return (
    <nav className="graph" aria-label="关系导航器">
      <div className="graph-head">
        <span className="graph-title">关系图</span>
        <div style={{ display: 'flex', gap: 1 }}>
          <button className="icon-btn" onClick={() => { setAutoFit(false); setZoom((z) => Math.max(0.4, z - 0.15)); }} title="缩小">
            <Minus size={14} />
          </button>
          <button className="icon-btn" onClick={() => { setAutoFit(false); setZoom((z) => Math.min(1.6, z + 0.15)); }} title="放大">
            <Plus size={14} />
          </button>
          <button className="icon-btn" onClick={recenter} title="回到当前节点">
            <Crosshair size={14} />
          </button>
        </div>
      </div>

      <div
        className="graph-canvas"
        ref={wrapRef}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={() => {
          onUp();
          setHover(null);
        }}
      >
        <svg width="100%" height="100%" style={{ display: 'block' }}>
          <g transform={`translate(${centerX - contentMidX * zoom + pan.x * zoom} ${pan.y * zoom}) scale(${zoom})`}>
            {edges
              .filter((e) => nodes.has(e.sourceCardId) && nodes.has(e.targetCardId) && !hidden.has(e.targetCardId))
              .map((e) => {
                const a = nodes.get(e.sourceCardId)!;
                const b = nodes.get(e.targetCardId)!;
                const onPath = pathSet.has(e.sourceCardId) && pathSet.has(e.targetCardId);
                return (
                  <path
                    key={e.id}
                    d={elbowPath(a.x, a.y, b.x, b.y)}
                    fill="none"
                    stroke={COLORS[e.type]}
                    strokeWidth={onPath ? 1.9 : 1.2}
                    strokeOpacity={onPath ? 0.85 : 0.32}
                    strokeDasharray={e.type === 'branch' ? '4 3' : e.type === 'divergent' ? '1 4' : undefined}
                    strokeLinecap="round"
                  />
                );
              })}

            {[...nodes.values()]
              .filter((n) => !hidden.has(n.id))
              .map((n) => {
                const card = cards.find((c) => c.id === n.id)!;
                if (!card || card.trashed) return null;
                const isCur = n.id === currentCardId;
                const onPath = pathSet.has(n.id);
                const inEdge = incomingEdge(edges, n.id);
                const color = inEdge ? COLORS[inEdge.type] : '#342b26';
                const kids = outgoingEdges(edges, n.id).length > 0;
                return (
                  <g key={n.id} className="gnode-hit">
                    {isCur && (
                      <circle cx={n.x} cy={n.y} r={11.5} fill="none" stroke={color} strokeOpacity={0.3} strokeWidth={1.2} />
                    )}
                    <circle
                      cx={n.x}
                      cy={n.y}
                      r={isCur ? 7 : onPath ? 5.4 : 4.4}
                      fill={isCur ? '#342b26' : onPath ? color : '#fbf8f2'}
                      stroke={color}
                      strokeWidth={1.6}
                      strokeOpacity={isCur ? 1 : onPath ? 1 : 0.5}
                      onClick={() => setCurrentCard(n.id)}
                      onPointerEnter={(ev) => {
                        const box = wrapRef.current!.getBoundingClientRect();
                        setHover({ id: n.id, x: ev.clientX - box.left, y: ev.clientY - box.top });
                      }}
                      onPointerLeave={() => setHover(null)}
                      style={{ cursor: 'pointer' }}
                    />
                    {card.unread && !isCur && (
                      <circle cx={n.x + 6.5} cy={n.y - 6.5} r={2.6} fill="var(--accent)" />
                    )}
                    {isCur && (
                      <text className="gnode-label" x={n.x} y={n.y + 24} textAnchor="middle">
                        {card.title.length > 12 ? `${card.title.slice(0, 11)}…` : card.title}
                      </text>
                    )}
                    {kids && (
                      <g
                        onClick={(ev) => {
                          ev.stopPropagation();
                          toggleCollapse(n.id);
                        }}
                        style={{ cursor: 'pointer' }}
                      >
                        <circle
                          cx={n.x + 12}
                          cy={n.y + 10}
                          r={6}
                          fill="#fbf8f2"
                          stroke="var(--line)"
                          strokeWidth={1}
                        />
                        <path
                          d={
                            collapsed.has(n.id)
                              ? `M ${n.x + 9.4} ${n.y + 10} h 5.2 M ${n.x + 12} ${n.y + 7.4} v 5.2`
                              : `M ${n.x + 9.4} ${n.y + 10} h 5.2`
                          }
                          stroke="var(--ink-2)"
                          strokeWidth={1.3}
                          strokeLinecap="round"
                        />
                      </g>
                    )}
                  </g>
                );
              })}
          </g>
        </svg>

        {hover && (
          <div
            className="graph-tip"
            style={{ left: Math.min(hover.x + 12, 30), top: hover.y + 14 }}
            role="tooltip"
          >
            <b>{cardTitle(hover.id)}</b>
            <i>{relLabel(hover.id)}</i>
          </div>
        )}
      </div>

      <div className="graph-legend">
        {(['child', 'divergent', 'branch'] as const).map((t) => (
          <div className="legend-row" key={t}>
            <span
              className="legend-dash"
              style={{
                background:
                  t === 'child'
                    ? COLORS.child
                    : `repeating-linear-gradient(90deg, ${COLORS[t]} 0 ${t === 'branch' ? 4 : 1.5}px, transparent ${t === 'branch' ? 4 : 1.5}px ${t === 'branch' ? 7 : 4}px)`,
              }}
            />
            {EDGE_META[t].label}
            <span style={{ color: 'var(--ink-3)', fontSize: 10.5 }}>
              {t === 'child' ? '继承主题与片段' : t === 'divergent' ? '仅相关主题' : '继承到分支点'}
            </span>
          </div>
        ))}
      </div>
    </nav>
  );
}
