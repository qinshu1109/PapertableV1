import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useStore } from '../store';
import { EDGE_META } from '../types';
import { H_GAP, NODE_R, ROOT_R, incomingEdge, layoutGraph, pathToRoot } from '../lib/graph';

const EDGE_COLOR = '#a89e96';
const INK = '#342b26';
const ACCENT = '#e66a3a';
const NODE_FILL = 'rgb(242, 234, 219)';
const NODE_STROKE = 'rgb(160, 150, 145)';
/** 当前路径节点（对齐 Explore tree-path 实测 2026-08-02：黑实心 + 深棕 3px 描边） */
const PATH_FILL = '#000000';
const PATH_STROKE = '#3c2d28';
/** SVG 内容四周留白 */
const PAD = 64;

/**
 * 卡片导航器（对齐 ai.explore.poker 2026-08-01 代码复核版）：
 * 布局内两档宽度（225px 宽栏 ↔ 56px 窄条），卡片同步让位，不压卡片、无遮罩、无分界线；
 * 展开/收起 200ms 慢-快-慢、无回弹；节点严格网格对齐、正圆；
 * 连线：父子用竖切线曲线，同层相邻短直线，隔节点圆弧绕行（半径随距离）；
 * 当前路径节点黑实心填充+深棕 3px 描边（三类关系都染，根节点橙圈常驻）；悬停珊瑚色加粗圈+栏底提示条；
 * 手动滚动/拖拽停止 3 秒后平滑归位，跳卡后 500ms 内不抢镜。
 */
/** SVG 最小画布：树再小也留出拖拽平移的余地（对齐 Explore 可自由拖动，2026-08-02 现场实测） */
const MIN_SVG_W = 720;
const MIN_SVG_H = 1150;

export function GraphNavigator() {
  const { cards, edges, currentCardId, setCurrentCard, collapsed } = useStore();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  /** 用户手动滚动后的归位定时器与跳卡防抢镜窗口 */
  const recenterTimer = useRef<number | null>(null);
  const jumpGuardUntil = useRef(0);
  /** 拖拽平移状态：起点、起始滚动位、是否已构成拖动（区分点击） */
  const dragState = useRef<{ x: number; y: number; sl: number; st: number; moved: boolean } | null>(null);
  /** 拖拽刚结束时压住紧随其后的 click，避免误触发展开/收起 */
  const suppressClick = useRef(false);

  const { nodes, hidden } = useMemo(() => layoutGraph(cards, edges, collapsed), [cards, edges, collapsed]);
  const path = useMemo(() => pathToRoot(edges, currentCardId), [edges, currentCardId]);
  const pathSet = useMemo(() => new Set(path), [path]);

  /** 可见节点与坐标偏移（树在 SVG 内居中；画布不小于 MIN_SVG_*，保证随时可拖拽） */
  const geom = useMemo(() => {
    const visible = [...nodes.values()].filter((n) => !hidden.has(n.id));
    if (!visible.length) return { visible, offX: PAD, offY: PAD, w: PAD * 2, h: PAD * 2 };
    const minX = Math.min(...visible.map((n) => n.x));
    const maxX = Math.max(...visible.map((n) => n.x));
    const minY = Math.min(...visible.map((n) => n.y));
    const maxY = Math.max(...visible.map((n) => n.y));
    const treeW = maxX - minX;
    const treeH = maxY - minY;
    const w = Math.max(treeW + PAD * 2, MIN_SVG_W);
    const h = Math.max(treeH + PAD * 2, MIN_SVG_H);
    return {
      visible,
      offX: (w - treeW) / 2 - minX,
      offY: (h - treeH) / 2 - minY,
      w,
      h,
    };
  }, [nodes, hidden]);

  // 切换卡片/档位：把当前节点滚动到可视区域正中央（平滑，交浏览器原生滚动）
  useEffect(() => {
    const n = nodes.get(currentCardId);
    const box = wrapRef.current;
    if (!n || !box) return;
    jumpGuardUntil.current = Date.now() + 500;
    const center = (behavior: ScrollBehavior) =>
      box.scrollTo({
        left: n.x + geom.offX - box.clientWidth / 2,
        top: n.y + geom.offY - box.clientHeight / 2,
        behavior,
      });
    if (narrow) {
      // 等 56px 宽度动画落地后再瞬时居中，否则按过渡中的宽度算会偏到条外
      const t = window.setTimeout(() => center('auto'), 210);
      return () => window.clearTimeout(t);
    }
    center('smooth');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCardId, geom, narrow]);

  /** 手动滚动/拖动停止 3 秒后，平滑把当前节点拉回中心（对齐线上版自动归位） */
  const onCanvasScroll = () => {
    if (Date.now() < jumpGuardUntil.current) return;
    if (recenterTimer.current) window.clearTimeout(recenterTimer.current);
    recenterTimer.current = window.setTimeout(() => {
      const n = nodes.get(currentCardId);
      const box = wrapRef.current;
      if (!n || !box) return;
      box.scrollTo({
        left: n.x + geom.offX - box.clientWidth / 2,
        top: n.y + geom.offY - box.clientHeight / 2,
        behavior: 'smooth',
      });
    }, 3000);
  };
  useEffect(
    () => () => {
      if (recenterTimer.current) window.clearTimeout(recenterTimer.current);
    },
    [],
  );

  const cardTitle = (id: string) => cards.find((c) => c.id === id)?.title ?? '';
  const relLabel = (id: string) => {
    const e = incomingEdge(edges, id);
    return e ? EDGE_META[e.type].label : '根卡片';
  };

  const visibleEdges = edges.filter(
    (e) => nodes.has(e.sourceCardId) && nodes.has(e.targetCardId) && !hidden.has(e.targetCardId),
  );

  /** 同层两点之间是否隔着其他节点（决定短直线还是圆弧绕行） */
  const blocked = (y: number, x1: number, x2: number) => {
    const [lo, hi] = x1 < x2 ? [x1, x2] : [x2, x1];
    return geom.visible.some((n) => n.y === y && n.x > lo + NODE_R && n.x < hi - NODE_R);
  };

  return (
    <nav className={`graph${narrow ? ' narrow' : ''}`} aria-label="关系导航器">
      <div className="graph-head">
        {!narrow && <span className="graph-title">关系图</span>}
        <button
          className="icon-btn"
          onClick={() => setNarrow((v) => !v)}
          title={narrow ? '展开关系图' : '收起关系图'}
        >
          {narrow ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
        </button>
      </div>

      <div
        className={`graph-canvas${dragging ? ' dragging' : ''}`}
        ref={wrapRef}
        onClick={() => {
          // 拖拽平移刚结束的 click 不触发展开/收起
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          setNarrow((v) => !v);
        }}
        onScroll={onCanvasScroll}
        onPointerDown={(e) => {
          // 左键拖拽平移（对齐 Explore 自由拖动）；窗口级监听，不用 pointer capture，避免点击重定向
          if (e.button !== 0 || narrow) return;
          const box = wrapRef.current;
          if (!box) return;
          dragState.current = { x: e.clientX, y: e.clientY, sl: box.scrollLeft, st: box.scrollTop, moved: false };
          const move = (ev: PointerEvent) => {
            const d = dragState.current;
            if (!d) return;
            const dx = ev.clientX - d.x;
            const dy = ev.clientY - d.y;
            if (!d.moved && Math.hypot(dx, dy) > 4) {
              d.moved = true;
              setDragging(true);
            }
            if (d.moved) {
              box.scrollLeft = d.sl - dx;
              box.scrollTop = d.st - dy;
            }
          };
          const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            if (dragState.current?.moved) suppressClick.current = true;
            dragState.current = null;
            setDragging(false);
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        }}
      >
        <svg width={geom.w} height={geom.h} style={{ display: 'block' }}>
          <defs>
              <radialGradient id="ghalo">
                <stop offset="0%" stopColor={INK} stopOpacity="0.28" />
                <stop offset="100%" stopColor={INK} stopOpacity="0" />
              </radialGradient>
              {visibleEdges.map((e) => {
                const a = nodes.get(e.sourceCardId)!;
                const b = nodes.get(e.targetCardId)!;
                return (
                  <linearGradient
                    key={e.id}
                    id={`eg-${e.id}`}
                    gradientUnits="userSpaceOnUse"
                    x1={a.x + geom.offX}
                    y1={a.y + geom.offY}
                    x2={b.x + geom.offX}
                    y2={b.y + geom.offY}
                  >
                    <stop offset="0%" stopColor={EDGE_COLOR} stopOpacity="0.95" />
                    <stop offset="100%" stopColor={EDGE_COLOR} stopOpacity="0.15" />
                  </linearGradient>
                );
              })}
            </defs>

            {visibleEdges.map((e) => {
              const a = nodes.get(e.sourceCardId)!;
              const b = nodes.get(e.targetCardId)!;
              const ax = a.x + geom.offX;
              const ay = a.y + geom.offY;
              const bx = b.x + geom.offX;
              const by = b.y + geom.offY;
              // 当前深挖链（仅竖向主线）强调：加粗、深色、带淡影
              const onChain =
                (e.type === 'child' || e.type === 'concept') &&
                pathSet.has(e.sourceCardId) &&
                pathSet.has(e.targetCardId);

              let d: string;
              if (e.type === 'child' || e.type === 'concept') {
                // 子卡在父卡上方：竖切线三次贝塞尔，转折控制在两层正中（同列时自然呈直线）
                const mid = (ay + by) / 2;
                d = `M ${ax} ${ay - NODE_R} C ${ax} ${mid}, ${bx} ${mid}, ${bx} ${by + NODE_R}`;
              } else if (blocked(a.y, a.x, b.x)) {
                // 同层但中间隔着其他节点：圆弧向上绕行，半径随距离变大
                const r = Math.abs(bx - ax) / 2;
                d = `M ${ax} ${ay} A ${r} ${r} 0 0 ${bx > ax ? 0 : 1} ${bx} ${by}`;
              } else {
                // 同层相邻：水平切线三次贝塞尔（同高自然呈短直线，跨高度呈 S 弧）
                const dx = (bx - ax) / 2;
                d = `M ${ax} ${ay} C ${ax + dx} ${ay}, ${bx - dx} ${by}, ${bx} ${by}`;
              }

              return (
                <g key={e.id}>
                  {onChain && (
                    <path d={d} fill="none" stroke={INK} strokeOpacity={0.14} strokeWidth={6} strokeLinecap="round" />
                  )}
                  <path
                    d={d}
                    fill="none"
                    stroke={onChain ? INK : `url(#eg-${e.id})`}
                    strokeWidth={onChain ? 3 : 1.5}
                    strokeLinecap="round"
                  />
                </g>
              );
            })}

            {geom.visible.map((n) => {
              const card = cards.find((c) => c.id === n.id)!;
              if (!card || card.trashed) return null;
              const isCur = n.id === currentCardId;
              const onPath = !isCur && pathSet.has(n.id);
              const hovered = hover === n.id && !isCur;
              const isRoot = !incomingEdge(edges, n.id);
              const cx = n.x + geom.offX;
              const cy = n.y + geom.offY;
              const r = isRoot ? ROOT_R : NODE_R;

              return (
                <g
                  key={n.id}
                  style={{ cursor: 'pointer' }}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    // 拖拽平移刚结束时落在节点上的 click 不触发跳卡
                    if (suppressClick.current) {
                      suppressClick.current = false;
                      return;
                    }
                    setCurrentCard(n.id);
                  }}
                  onPointerEnter={() => setHover(n.id)}
                  onPointerLeave={() => setHover(null)}
                >
                  <title>{`${relLabel(n.id)}：${card.title}`}</title>
                  {/* 当前节点 5px 软光晕；当前路径节点也有同色淡光晕 */}
                  {isCur && <circle cx={cx} cy={cy} r={r + 12} fill="url(#ghalo)" />}
                  {onPath && <circle cx={cx} cy={cy} r={r + 7} fill="url(#ghalo)" />}
                  {/* 悬停光晕（珊瑚色，约 6px） */}
                  {hovered && <circle cx={cx} cy={cy} r={r + 6} fill="none" stroke={ACCENT} strokeOpacity={0.22} strokeWidth={5} />}
                  <circle
                    cx={cx}
                    cy={cy}
                    r={r}
                    fill={isCur ? INK : onPath ? PATH_FILL : NODE_FILL}
                    style={{
                      stroke: hovered ? ACCENT : isCur ? INK : onPath ? PATH_STROKE : NODE_STROKE,
                      strokeWidth: hovered ? 4 : isCur ? 2 : onPath ? 3 : 2,
                      transition: 'fill 0.2s, stroke 0.2s, stroke-width 0.2s',
                    }}
                  />
                  {/* 根节点珊瑚环常驻：即使根在当前路径上被黑实心染色，橙圈也不被吃掉 */}
                  {isRoot && (
                    <circle cx={cx} cy={cy} r={r + 5} fill="none" stroke={ACCENT} strokeOpacity={0.65} strokeWidth={3} />
                  )}
                  {card.unread && !isCur && <circle cx={cx} cy={cy} r={r * 0.3} fill={ACCENT} />}
                </g>
              );
            })}
          </svg>
        </div>

        {/* 栏底提示条：悬停节点的卡片标题与对话条数（对齐线上版 209×54 提示条）。
            挂在 nav 上而非滚动容器内——画布拖拽/滚动时提示条钉在栏底，不跟内容走位、不被卡片裁掉 */}
        {hover && (
          <div className="graph-tip" role="tooltip">
            <b>{cardTitle(hover)}</b>
            <i>
              {relLabel(hover)}
              {(cards.find((c) => c.id === hover)?.turns.length ?? 0) > 0 &&
                ` · ${cards.find((c) => c.id === hover)!.turns.length} 条对话`}
            </i>
          </div>
        )}
      </nav>
  );
}
