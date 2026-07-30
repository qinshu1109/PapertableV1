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

const H_GAP = 54;
const V_GAP = 66;
const EDGE_X: Record<CardEdge['type'], number> = {
  child: 0,
  divergent: 1,
  branch: -1,
};

/**
 * 简易语义树布局：深挖向下、发散向右、改道向左。
 * 折叠的子树不参与布局。
 */
export function layoutGraph(
  cards: Card[],
  edges: CardEdge[],
  collapsed: Set<string>,
): { nodes: Map<string, GraphNode>; width: number; height: number; hidden: Set<string> } {
  const alive = cards.filter((c) => !c.trashed);
  const aliveIds = new Set(alive.map((c) => c.id));
  const roots = alive.filter((c) => !incomingEdge(edges, c.id)).map((c) => c.id);

  const hidden = new Set<string>();
  const nodes = new Map<string, GraphNode>();
  const occupied = new Map<number, Set<number>>();

  const claimSlot = (depth: number, preferred: number, direction: number) => {
    const used = occupied.get(depth) ?? new Set<number>();
    occupied.set(depth, used);
    let slot = preferred;
    for (let distance = 1; used.has(slot); distance += 1) {
      slot = direction < 0
        ? preferred - distance
        : direction > 0
          ? preferred + distance
          : preferred + (distance % 2 ? -Math.ceil(distance / 2) : distance / 2);
    }
    used.add(slot);
    return slot;
  };

  const visit = (id: string, depth: number, preferredSlot: number, direction = 0) => {
    const slot = claimSlot(depth, preferredSlot, direction);
    nodes.set(id, { id, depth, x: slot * H_GAP, y: depth * V_GAP });
    if (collapsed.has(id)) {
      subtreeIds(edges, id)
        .slice(1)
        .forEach((d) => hidden.add(d));
      return;
    }
    outgoingEdges(edges, id)
      .filter((e) => aliveIds.has(e.targetCardId))
      .forEach((e) => {
        const childDirection = EDGE_X[e.type];
        visit(e.targetCardId, depth + 1, slot + childDirection, childDirection);
      });
  };
  roots.forEach((r, index) => visit(r, 0, index * 2));

  const visible = [...nodes.values()].filter((node) => !hidden.has(node.id));
  const xs = visible.map((node) => node.x);
  const height = (Math.max(0, ...visible.map((node) => node.depth)) + 1) * V_GAP;
  return {
    nodes,
    width: Math.max(H_GAP * 2, Math.max(0, ...xs) - Math.min(0, ...xs) + H_GAP * 2),
    height,
    hidden,
  };
}
