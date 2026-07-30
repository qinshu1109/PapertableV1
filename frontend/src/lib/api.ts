/**
 * PapertableV1 后端 API 客户端（同源 /api，开发期由 Vite 代理到 4317）。
 */
import type { Verdict } from '../types';

export interface ServerProject {
  id: string;
  name: string;
  cardCount: number;
  materialCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ServerCard {
  id: string;
  projectId: string;
  title: string;
  kind: 'root' | 'deep_dive' | 'diverge' | 'reroute';
  sourceCardId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ServerEdge {
  id: string;
  sourceCardId: string;
  targetCardId: string;
  kind: 'deep_dive' | 'diverge' | 'reroute';
  snapshot: Record<string, unknown>;
  createdAt: string;
}

export interface ServerLibrary {
  path: string;
  indexedAt: string | null;
  documents: number;
  chunks: number;
}

export interface ProjectDetail {
  id: string;
  name: string;
  library: ServerLibrary | null;
  materials: Array<Record<string, unknown>>;
  cards: ServerCard[];
  edges: ServerEdge[];
}

export interface ServerMessage {
  entryId: string;
  role: 'user' | 'assistant';
  text: string;
}

export interface ServerRun {
  id: string;
  question: string;
  status: 'running' | 'ended';
  result: string | null;
  reason: string | null;
  answer: string | null;
  error: string | null;
  created_at: string;
  citations: Array<Record<string, unknown>>;
  activity: Array<Record<string, unknown>>;
}

export interface CardDetail extends ServerCard {
  branchContext: Record<string, unknown>;
  messages: ServerMessage[];
  runs: ServerRun[];
}

export interface BranchPayload {
  kind: 'deep_dive' | 'diverge' | 'reroute';
  question: string;
  selection?: { entryId: string; text: string; start: number; end: number };
  topic?: string;
  sourceEntryId?: string;
}

export interface RunEvent {
  id: number;
  event: string;
  createdAt: string;
  [key: string]: unknown;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String((body as { error?: string }).error || `HTTP ${response.status}`));
  }
  return body as T;
}

export const api = {
  status: () => request<{ ready: boolean; modelConfigured: boolean; memory: { available: boolean } }>('/api/status'),

  listProjects: () => request<{ projects: ServerProject[] }>('/api/projects'),
  createProject: (name: string) =>
    request<ServerProject>('/api/projects', { method: 'POST', body: JSON.stringify({ name }) }),
  projectDetail: (id: string) => request<ProjectDetail>(`/api/projects/${encodeURIComponent(id)}`),
  bindLibrary: (id: string, path: string) =>
    request<{ ok: boolean }>(`/api/projects/${encodeURIComponent(id)}/library`, {
      method: 'PUT',
      body: JSON.stringify({ path }),
    }),
  reindexLibrary: (id: string) =>
    request<Record<string, unknown>>(`/api/projects/${encodeURIComponent(id)}/library/reindex`, { method: 'POST' }),

  createRootCard: (projectId: string, question: string) =>
    request<{ cardId: string; runId: string }>(`/api/projects/${encodeURIComponent(projectId)}/cards`, {
      method: 'POST',
      body: JSON.stringify({ question }),
    }),
  cardDetail: (id: string) => request<CardDetail>(`/api/cards/${encodeURIComponent(id)}`),
  continueCard: (id: string, question: string) =>
    request<{ runId: string }>(`/api/cards/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ question }),
    }),
  createBranch: (id: string, payload: BranchPayload) =>
    request<{ cardId: string; runId: string; verdict?: Verdict }>(`/api/cards/${encodeURIComponent(id)}/branches`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  stageCard: (id: string, reason: string) =>
    request<Record<string, unknown>>(`/api/cards/${encodeURIComponent(id)}/stage`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }).catch(() => undefined),

  abortRun: (id: string) => request<{ ok: boolean }>(`/api/runs/${encodeURIComponent(id)}/abort`, { method: 'POST' }),
  retryRun: (id: string) => request<{ runId: string }>(`/api/runs/${encodeURIComponent(id)}/retry`, { method: 'POST' }),

  listVerdicts: (projectId: string) =>
    request<{ verdicts: Verdict[] }>(`/api/projects/${encodeURIComponent(projectId)}/verdicts`),
  confirmVerdict: (id: string, text?: string) =>
    request<Verdict>(`/api/verdicts/${encodeURIComponent(id)}/confirm`, {
      method: 'POST',
      body: JSON.stringify(text ? { text } : {}),
    }),
  supersedeVerdict: (id: string) =>
    request<Verdict>(`/api/verdicts/${encodeURIComponent(id)}/supersede`, { method: 'POST' }),
  adoptRun: (runId: string, handle: string, text?: string) =>
    request<Verdict>(`/api/runs/${encodeURIComponent(runId)}/adopt`, {
      method: 'POST',
      body: JSON.stringify(text ? { handle, text } : { handle }),
    }),
};

const RUN_EVENTS = [
  'run_created',
  'turn_start',
  'tool_start',
  'tool_update',
  'tool_end',
  'answer_sentence',
  'citation_resolved',
  'memory_stage_status',
  'run_end',
];

/** 订阅一次 run 的 SSE 事件流；返回关闭函数。服务端在 run_end 后主动断开。 */
export function subscribeRun(
  runId: string,
  onEvent: (event: RunEvent) => void,
  onError?: () => void,
): () => void {
  const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
  const handler = (raw: MessageEvent) => {
    try {
      onEvent(JSON.parse(raw.data) as RunEvent);
    } catch {
      /* 忽略无法解析的帧 */
    }
  };
  for (const name of RUN_EVENTS) source.addEventListener(name, handler);
  source.onerror = () => {
    // run 结束时服务端会关闭连接，EventSource 触发 error 属正常路径
    if (source.readyState === EventSource.CLOSED) return;
    source.close();
    onError?.();
  };
  return () => source.close();
}
