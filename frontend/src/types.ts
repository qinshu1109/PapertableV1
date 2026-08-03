/**
 * 最小数据模型。
 * 四种卡片关系统一用 CardEdge 表达，UI 不硬编码关系语义。
 */
import type { ThinkingActivity, ToolActivity } from './lib/run-activity';

export type EdgeType = 'child' | 'divergent' | 'branch' | 'concept';

/** 上下文继承策略：决定 buildContext 未来如何拼装 */
export type ContextPolicy =
  | 'topic-and-selection' // 深挖：来源主题 + 选中片段
  | 'topic-only' // 发散：仅来源主题作为相关背景
  | 'history-through-turn' // 改道：继承到指定轮次为止的完整历史
  | 'concept-expansion'; // 概念展开：用户认可的 AI 临时卡成为正式卡

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
  /** 生成中的临时状态 */
  streaming?: boolean;
  phase?: 'planning' | 'tools' | 'answering';
  turnCount?: number;
  activity?: ToolActivity[];
  thinking?: ThinkingActivity[];
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
  /** 模型从本轮正式回答中选出的可点击临时概念卡 */
  concepts?: ConceptInsight[];
  /** 本轮实际命中的判决及 MemOS 可用性；只用于审计，不是资料引用。 */
  verdictTrace?: VerdictTrace;
  /** 模型自选复用：回答中显式标注引用的判决（provided 是提供数，used 才是真复用）。 */
  verdictUse?: VerdictUse;
}

export interface VerdictUse {
  promptVersion: string;
  availability: 'available' | 'degraded' | 'unavailable';
  source: 'memos' | 'local-cache' | 'none';
  provided: number;
  providedTotal: number;
  truncated: boolean;
  used: Array<{
    id: string;
    verdictType: 'tombstone' | 'gold';
    snapshot: string;
  }>;
  unknownCount: number;
}

export interface VerdictTrace {
  promptVersion: string;
  injectionEnabled: boolean;
  query: string;
  availability: 'available' | 'degraded' | 'unavailable';
  source: 'memos' | 'local-cache' | 'none';
  verdicts: Array<{
    id: string;
    verdictType: 'tombstone' | 'gold';
    snapshot: string;
  }>;
  providedTotal?: number;
  truncated?: boolean;
  unavailableCode?: string;
}

export interface ConceptInsight {
  id: string;
  term: string;
  /** 旧数据才有 AI 预写正文；新链路为空，点击后按需生成 */
  body?: string;
  question: string;
}

export interface Citation {
  chunkId: string;
  documentId?: string;
  relativePath?: string;
  path?: string;
  sourceKind?: string;
  start?: number;
  end?: number;
  excerpt: string;
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
  status: 'proposed' | 'confirmed' | 'superseded' | 'abandoned';
  memosStatus?: string;
  memoryId?: string | null;
  syncError?: string | null;
  originalText?: string | null;
  editRatio?: number | null;
  supersedesMemoryId?: string | null;
  resumedRunId?: string | null;
  createdAt: string;
  updatedAt?: string;
}

export interface VerdictSyncStatus {
  available: boolean;
  pending: number;
  failed: number;
  usingLocalCache: boolean;
  error?: string;
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
  concept: {
    label: '概念展开',
    verb: '展开自',
    policy: 'concept-expansion',
    policyLabel: '把用户认可的 AI 临时概念卡原样提升为正式卡片',
    color: 'var(--accent)',
    enterFrom: { x: 0, y: 56, rotate: 0 },
  },
};
