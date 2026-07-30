/**
 * 最小数据模型。
 * 三种卡片关系统一用 CardEdge 表达，UI 不硬编码关系语义。
 */

export type EdgeType = 'child' | 'divergent' | 'branch';

/** 上下文继承策略：决定 buildContext 未来如何拼装 */
export type ContextPolicy =
  | 'topic-and-selection' // 深挖：来源主题 + 选中片段
  | 'topic-only' // 发散：仅来源主题作为相关背景
  | 'history-through-turn'; // 改道：继承到指定轮次为止的完整历史

export type TurnRole = 'user' | 'ai';

/** 精确来源锚点：定位到卡片 / 轮次 / 文本片段 */
export interface SourceAnchor {
  cardId: string;
  turnId?: string;
  /** 选中的文本片段 */
  text?: string;
  /** 选区所在的整段文本，用于回溯定位 */
  blockText?: string;
}

export interface Turn {
  id: string;
  role: TurnRole;
  /** Markdown 正文 */
  content: string;
  createdAt: number;
  /** 生成中的临时状态 */
  streaming?: boolean;
  favorite?: boolean;
  /** 服务端会话条目 id（选区/改道锚点用） */
  entryId?: string;
  /** 产生这条回答的 run id（采纳/重试用） */
  runId?: string;
  /** 终局状态：completed / partial / refused / failed / aborted */
  status?: string;
  reason?: string;
  error?: string;
  /** 受控引用（由宿主验证，前端只展示） */
  citations?: Citation[];
}

export interface Citation {
  chunkId?: string;
  relativePath?: string;
  sourceKind?: string;
  excerpt?: string;
  [key: string]: unknown;
}

/** 判决簿条目：墓碑（否决方向）与金子（采纳的 1% 命中） */
export interface Verdict {
  id: string;
  projectId?: string;
  cardId: string | null;
  runId: string | null;
  kind: 'tombstone' | 'gold';
  text: string;
  handle: string | null;
  status: 'proposed' | 'confirmed' | 'superseded';
  memosStatus?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface Card {
  id: string;
  projectId: string;
  title: string;
  turns: Turn[];
  favorite: boolean;
  unread: boolean;
  /** 可点击概念词，来自功能模型的结构化区间（此处为 mock 常量） */
  concepts: string[];
  /** 软删除：进入回收站 */
  trashed?: boolean;
  createdAt: number;
}

export interface CardEdge {
  id: string;
  type: EdgeType;
  sourceCardId: string;
  targetCardId: string;
  /** branch / 从轮次创建时的精确锚点 */
  sourceTurnId?: string;
  sourceText?: string;
  sourceBlockText?: string;
  contextPolicy: ContextPolicy;
}

export interface Project {
  id: string;
  name: string;
  pinned: boolean;
  updatedAt: number;
  /** 是否已载入完整图（非当前项目为占位） */
  loaded: boolean;
}

export interface ReferenceChip {
  id: string;
  anchor: SourceAnchor;
  /** 展示用的来源卡片标题 */
  sourceTitle: string;
  /** 截断后的引用文本 */
  excerpt: string;
}

export interface TrashEntry {
  cards: Card[];
  edges: CardEdge[];
  label: string;
}

export const EDGE_META: Record<
  EdgeType,
  {
    label: string;
    verb: string;
    policy: ContextPolicy;
    policyLabel: string;
    color: string;
    /** 新卡片进入方向 */
    enterFrom: { x: number; y: number; rotate: number };
  }
> = {
  child: {
    label: '深挖',
    verb: '深挖自',
    policy: 'topic-and-selection',
    policyLabel: '继承来源主题与选中片段，不复制完整历史',
    color: 'var(--accent)',
    enterFrom: { x: 0, y: 56, rotate: 0 },
  },
  divergent: {
    label: '发散',
    verb: '发散自',
    policy: 'topic-only',
    policyLabel: '仅把来源标题当作相关主题，隔离度最高',
    color: 'var(--ctx)',
    enterFrom: { x: 120, y: 12, rotate: 2.5 },
  },
  branch: {
    label: '改道',
    verb: '改道自',
    policy: 'history-through-turn',
    policyLabel: '继承分支点之前的对话历史，分支点之后不带入',
    color: 'var(--branch)',
    enterFrom: { x: -120, y: 12, rotate: -2.5 },
  },
};
