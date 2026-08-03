import type { Card, CardEdge } from '../types';

export interface GraphNode {
  id: string;
  x: number;
  y: number;
  depth: number;
}

/** 找到指向某卡片的边（每张卡片最多一条来源边） */
export function incomingEdge(edges: CardEdge[], cardId: string) {
  return edges.find((e) => e.targetCardId === cardId);
}

export function outgoingEdges(edges: CardEdge[], cardId: string) {
  return edges.filter((e) => e.sourceCardId === cardId);
}

/** 从根到当前卡片的路径（含自身），首项为根 */
export function pathToRoot(edges: CardEdge[], cardId: string): string[] {
  const path: string[] = [cardId];
  const seen = new Set<string>([cardId]);
  let cursor = cardId;
  for (let i = 0; i < 64; i++) {
    const e = incomingEdge(edges, cursor);
    if (!e || seen.has(e.sourceCardId)) break;
    path.unshift(e.sourceCardId);
    seen.add(e.sourceCardId);
    cursor = e.sourceCardId;
  }
  return path;
}

/** 某卡片及其所有下游卡片 */
export function subtreeIds(edges: CardEdge[], cardId: string): string[] {
  const out: string[] = [];
  const walk = (id: string) => {
    out.push(id);
    outgoingEdges(edges, id).forEach((e) => {
      if (!out.includes(e.targetCardId)) walk(e.targetCardId);
    });
  };
  walk(cardId);
  return out;
}

/** 同层兄弟水平间距（px） */
export const H_GAP = 36;
/** 层级垂直间距（px） */
export const V_GAP = 80;
/** 普通节点半径 */
export const NODE_R = 14;
/** 根节点半径 */
export const ROOT_R = 16.8;

/**
 * 全局 tidy-tree 布局（对齐 ai.explore.poker 的实测行为）：
 * - 深挖/concept = 进入上一层（y 减少一层，向上长）；发散 = 同层向右；改道 = 同层向左；
 *   方向映射全局固定，不随子树位置翻转。
 * - 每层按子树宽度重新分配水平空间，父节点在子树上方居中；
 *   新增节点允许全树重平衡，已有节点可以移动。
 * - 返回的 SVG 坐标保持可读尺寸，由外层原生滚动容器导航。
 */
export function layoutGraph(
  cards: Card[],
  edges: CardEdge[],
  collapsed: Set<string>,
): { nodes: Map<string, GraphNode>; width: number; height: number; hidden: Set<string> } {
  const alive = cards.filter((c) => !c.trashed);
  const aliveIds = new Set(alive.map((c) => c.id));
  const createdAt = new Map(alive.map((c) => [c.id, c.createdAt]));
  const roots = alive.filter((c) => !incomingEdge(edges, c.id)).map((c) => c.id);

  const hidden = new Set<string>();
  const nodes = new Map<string, GraphNode>();

  const kidsOf = (id: string, type: CardEdge['type']) =>
    outgoingEdges(edges, id)
      .filter((e) => e.type === type && aliveIds.has(e.targetCardId))
      .sort((a, b) => (createdAt.get(a.targetCardId) ?? 0) - (createdAt.get(b.targetCardId) ?? 0))
      .map((e) => e.targetCardId);
  const verticalKidsOf = (id: string) =>
    [...kidsOf(id, 'child'), ...kidsOf(id, 'concept')]
      .sort((a, b) => (createdAt.get(a) ?? 0) - (createdAt.get(b) ?? 0));

  /** 子树占用的列宽（单位：个节点列）：同层行宽与子层行宽取大者 */
  const widthCache = new Map<string, number>();
  const W = (id: string): number => {
    if (widthCache.has(id)) return widthCache.get(id)!;
    let w = 1;
    if (!collapsed.has(id)) {
      const rowW =
        kidsOf(id, 'branch').reduce((s, k) => s + W(k), 0) +
        1 +
        kidsOf(id, 'divergent').reduce((s, k) => s + W(k), 0);
      const childW = verticalKidsOf(id).reduce((s, k) => s + W(k), 0);
      w = Math.max(rowW, childW, 1);
    }
    widthCache.set(id, w);
    return w;
  };

  /** 把以 left（列单位）为左缘、宽 W(id) 的子树放进 level 层（y 向上为负：深挖/concept 向上长） */
  const place = (id: string, left: number, level: number) => {
    if (collapsed.has(id)) {
      nodes.set(id, { id, depth: level, x: (left + 0.5) * H_GAP, y: -level * V_GAP });
      subtreeIds(edges, id)
        .slice(1)
        .forEach((d) => hidden.add(d));
      return;
    }

    const branches = kidsOf(id, 'branch');
    const divs = kidsOf(id, 'divergent');
    const childs = verticalKidsOf(id);

    // 同层：改道子树在左、自身居中、发散子树在右
    let c = left;
    for (const k of branches) {
      place(k, c, level);
      c += W(k);
    }
    const selfCol = c + 0.5;
    nodes.set(id, { id, depth: level, x: selfCol * H_GAP, y: -level * V_GAP });
    c += 1;
    for (const k of divs) {
      place(k, c, level);
      c += W(k);
    }

    // 上一层：深挖/concept 子节点整体在自身上方居中（对齐 ai.explore.poker：追问向上长）
    const childTotal = childs.reduce((s, k) => s + W(k), 0);
    let cc = selfCol - childTotal / 2;
    for (const k of childs) {
      place(k, cc, level + 1);
      cc += W(k);
    }
  };

  let cursor = 0;
  for (const r of roots) {
    place(r, cursor, 0);
    cursor += W(r) + 2;
  }

  const visible = [...nodes.values()].filter((node) => !hidden.has(node.id));
  const xs = visible.map((node) => node.x);
  const ys = visible.map((node) => node.y);
  const maxX = Math.max(0, ...xs);
  const maxY = Math.max(0, ...ys);
  const minY = Math.min(0, ...ys);
  return {
    nodes,
    width: maxX + H_GAP * 2,
    height: maxY - minY + V_GAP,
    hidden,
  };
}
