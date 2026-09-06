/**
 * PapertableV1 后端 API 客户端（同源 /api，开发期由 Vite 代理到 4317）。
 */
import type { Citation, ConceptInsight, Verdict, VerdictSyncStatus, VerdictTrace, VerdictUse } from '../types';

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
  kind: 'root' | 'deep_dive' | 'diverge' | 'reroute' | 'concept';
  sourceCardId: string | null;
  /* TASK-PW-70：回收站服务端化——非 null 即已删（进回收站） */
  trashedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ServerEdge {
  id: string;
  sourceCardId: string;
  targetCardId: string;
  kind: 'deep_dive' | 'diverge' | 'reroute' | 'concept';
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
  /** 该 run 回答在会话分支中的 assistant 条目 id（稳定绑定标识） */
  answerEntryId?: string | null;
  citations: Citation[];
  concepts: ConceptInsight[];
  verdictTrace?: VerdictTrace;
  verdictUse?: VerdictUse;
  activity: RunEvent[];
}

export interface CardDetail extends ServerCard {
  branchContext: Record<string, unknown>;
  messages: ServerMessage[];
  runs: ServerRun[];
  /** 用户点击触发的按需概念会话（缓存复用） */
  conceptPreviews: Array<{
    id: string;
    source_run_id: string | null;
    concept_term: string | null;
    question: string;
    status: 'running' | 'ended';
    result: string | null;
    answer: string | null;
  }>;
}

export interface BranchPayload {
  kind: 'deep_dive' | 'diverge' | 'reroute' | 'concept';
  question: string;
  selection?: { entryId: string; text: string; start: number; end: number };
  topic?: string;
  sourceEntryId?: string;
  sourceRunId?: string;
  conceptId?: string;
  previewRunId?: string;
}

interface RunEventBase {
  id: number;
  createdAt: string;
}

export type RunEvent =
  | (RunEventBase & {
      event: 'run_created';
      runId: string;
      cardId: string;
      projectId: string;
    })
  | (RunEventBase & { event: 'turn_start' })
  | (RunEventBase & {
      event: 'tool_start' | 'tool_update' | 'tool_end';
      toolCallId?: string;
      tool?: string;
      isError?: boolean;
      queryLength?: number;
      requestedChunks?: number;
      hitCount?: number;
      readCount?: number;
    })
  | (RunEventBase & { event: 'thinking_start'; contentIndex: number })
  | (RunEventBase & { event: 'thinking_end'; contentIndex: number; content: string })
  | (RunEventBase & { event: 'answer_sentence'; sentence: string; answer: string })
  | (RunEventBase & { event: 'citation_resolved' } & Citation)
  | (RunEventBase & {
      event: 'run_end';
      result: string;
      reason?: string | null;
      answer?: string | null;
      citations?: Citation[];
      error?: string | null;
    });

export type ProviderId = 'claude' | 'deepseek' | 'opencode-go';
export type ProviderProtocol = 'anthropic-messages' | 'openai-completions';

export interface ProviderOption {
  id: ProviderId;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
}

export interface ProviderSettings extends ProviderOption {
  activeProviderId: ProviderId;
  providers: ProviderOption[];
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
  status: () =>
    request<{
      ready: boolean;
      modelConfigured: boolean;
      protocol: ProviderProtocol;
      memory: { available: boolean };
      verdicts: VerdictSyncStatus;
    }>('/api/status'),
  providerSettings: () => request<ProviderSettings>('/api/settings/provider'),
  saveProviderSettings: (settings: {
    providerId: ProviderId;
    protocol: ProviderProtocol;
    baseUrl: string;
    model: string;
    apiKey?: string;
  }) =>
    request<ProviderSettings>('/api/settings/provider', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),

  listProjects: () => request<{ projects: ServerProject[] }>('/api/projects'),
  createProject: (name: string) =>
    request<ServerProject>('/api/projects', { method: 'POST', body: JSON.stringify({ name }) }),
  renameProject: (id: string, name: string) =>
    request<Pick<ServerProject, 'id' | 'name' | 'updatedAt'>>(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ name }),
    }),
  projectDetail: (id: string) => request<ProjectDetail>(`/api/projects/${encodeURIComponent(id)}`),
  /* TASK-PW-62：卡组决策链总结（AI 草稿，人确认后才写 Memos） */
  chainSummary: (id: string) =>
    request<PtChainSummary>(`/api/pt/projects/${encodeURIComponent(id)}/chain-summary`),
  chainExport: (id: string, markdown: string) =>
    request<PtChainExportResult>(`/api/pt/projects/${encodeURIComponent(id)}/chain-export`, {
      method: 'POST',
      body: JSON.stringify({ markdown }),
    }),
  purgeCards: (id: string, cardIds: string[]) =>
    request<{ purged: string[]; skipped: Array<{ cardId: string; reason: string }> }>(
      `/api/projects/${encodeURIComponent(id)}/cards/purge`,
      { method: 'POST', body: JSON.stringify({ cardIds }) },
    ),
  /* TASK-PW-70：回收站服务端化——trash/restore 可逆标记，deleteProject 物理级联删除整个项目 */
  trashCards: (id: string, cardIds: string[]) =>
    request<{ trashed: string[] }>(`/api/projects/${encodeURIComponent(id)}/cards/trash`, {
      method: 'POST',
      body: JSON.stringify({ cardIds }),
    }),
  restoreCards: (id: string, cardIds: string[]) =>
    request<{ restored: string[] }>(`/api/projects/${encodeURIComponent(id)}/cards/restore`, {
      method: 'POST',
      body: JSON.stringify({ cardIds }),
    }),
  deleteProject: (id: string) =>
    request<{ deleted: true }>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
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
  renameCard: (id: string, title: string) =>
    request<ServerCard>(`/api/cards/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ title }),
    }),
  continueCard: (id: string, question: string) =>
    request<{ runId: string }>(`/api/cards/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ question }),
    }),
  createBranch: (id: string, payload: BranchPayload) =>
    request<{ cardId: string; runId: string | null; verdict?: Verdict }>(`/api/cards/${encodeURIComponent(id)}/branches`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  /** 用户点击高亮词：启动（或复用）按需概念会话 */
  openConceptPreview: (id: string, payload: { sourceRunId: string; conceptId: string }) =>
    request<{
      runId: string;
      status: 'running' | 'ended';
      result: string | null;
      answer: string | null;
      cached: boolean;
    }>(`/api/cards/${encodeURIComponent(id)}/concept-previews`, {
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
    request<{ verdicts: Verdict[]; status: VerdictSyncStatus }>(`/api/projects/${encodeURIComponent(projectId)}/verdicts`),
  confirmVerdict: (id: string, text?: string) =>
    request<{ verdict: Verdict; runId: string }>(`/api/verdicts/${encodeURIComponent(id)}/confirm`, {
      method: 'POST',
      body: JSON.stringify(text ? { text } : {}),
    }),
  abandonVerdict: (id: string) =>
    request<{ verdict: Verdict; runId: string }>(`/api/verdicts/${encodeURIComponent(id)}/abandon`, {
      method: 'POST',
      body: '{}',
    }),
  supersedeVerdict: (id: string, text: string, handle?: string) =>
    request<Verdict>(`/api/verdicts/${encodeURIComponent(id)}/supersede`, {
      method: 'POST',
      body: JSON.stringify(handle ? { text, handle } : { text }),
    }),
  adoptRun: (runId: string, handle: string, text?: string) =>
    request<Verdict>(`/api/runs/${encodeURIComponent(runId)}/adopt`, {
      method: 'POST',
      body: JSON.stringify(text ? { handle, text } : { handle }),
    }),
};

/* ============================================================
   Paperweight（镇纸）P0 API：/api/pw/*
   ============================================================ */

export type PwBetStatus = 'draft' | 'pending' | 'settled' | 'void';
export type PwOutcome = 'gold' | 'tomb' | 'void';
export type PwArtifactType = 'video' | 'livestream' | 'article' | 'cover' | 'link';

export interface PwBet {
  id: string;
  title: string;
  thesis: string;
  metric: string | null;
  metric_target: string | null;
  confidence: number | null;
  data_source_plan: string | null;
  checkout_date: string | null;
  status: PwBetStatus;
  gold_refs_json: string;
  created_from: string | null;
  created_at: string;
  settled_verdict_id: string | null;
}

/* TASK-PW-20：选题候选卡与内容押注卡 */
export interface PwSieveCard {
  id: string;
  run_id: string;
  kind: 'normal' | 'wildcard';
  quote_text: string;
  quote_source_json: string;
  scale_note: string | null;
  scale_value: number;
  hook_note: string | null;
  freshness_note: string | null;
  sort_score: number;
  status: 'pending' | 'picked' | 'edited' | 'rejected';
  created_at: string;
  /** TASK-PW-44：该卡出自哪轮 run 的方向快照（v2 前旧卡为 null，UI 显示「默认」）。 */
  run_direction?: string | null;
}

export interface PwSieveStatus {
  last_run_at: string | null;
  pending_arrivals: number;
  cards_pending: number;
  /** TASK-PW-42：当前筛子方向（null = 默认捞路人困惑）。 */
  direction: string | null;
}

/* TASK-PW-45/46：观众声音与语料评论只读分区 */
export interface PwVoiceItem {
  id: string;
  artifact_id: string | null;
  platform: string;
  author_hash: string;
  content: string;
  captured_at: string;
  signal_type: 'topic_lead' | 'content_critique' | 'form_suggestion' | 'noise' | null;
  cluster_id: string | null;
  promoted_to_draft_id: string | null;
  dropped_reason: string | null;
  created_at: string;
}

export interface PwVoiceCorpusComment {
  rpid: number | null;
  uname: string | null;
  message: string;
  like: number | null;
  ctime: number | null;
  replies: number | null;
  /** 已收录进声音表（未丢弃）则为 true，按钮置灰。 */
  collected: boolean;
}

/* TASK-PW-64：语料评论主题卡（与后端 src/pw-voice-cards.ts 契约对齐） */
export interface PwVoiceThemeCardItem {
  rpid: number;
  message: string;
  uname: string | null;
  like: number | null;
  ctime: number | null;
  collected: boolean;
  voiceId: string | null;
}

export interface PwVoiceThemeCard {
  id: string;
  bvid: string;
  title: string;
  summary: string | null;
  status: string;
  decidedAt: string | null;
  createdAt: string;
  items: PwVoiceThemeCardItem[];
}

export interface PwVoiceCardRun {
  id: string;
  bvid: string;
  at: string;
  cards: number;
  costCny: number;
  status: string;
}

/* TASK-PW-65：评论筛子结果（三层密度视图；与后端 src/pw-voice-sieve.ts 契约对齐） */
export interface PwVoiceSieveRun {
  id: string;
  bvid: string;
  provider: string;
  model: string;
  total: number;
  signal: number;
  noise: number;
  reassigned: number;
  reportPath: string | null;
  createdAt: string;
  status: string;
}

export interface PwVoiceSieveItem {
  rpid: string;
  verdict: 'signal' | 'noise';
  bucket: string | null;
  uname: string;
  message: string;
  like: number;
  /** unix 秒 */
  ctime: number;
}

export interface PwVoiceSieveBucket {
  bucket: string;
  count: number;
  totalLikes: number;
  /** 赞降序前 3（空桶为空数组） */
  top: PwVoiceSieveItem[];
}

export interface PwVoiceSieveRunDetail {
  run: PwVoiceSieveRun;
  /** 8 桶全有（空桶 count:0），按 totalLikes 降序 */
  buckets: PwVoiceSieveBucket[];
  /** 桶名 → 全部信号，赞降序 */
  signals: Record<string, PwVoiceSieveItem[]>;
  /** 全部噪音，赞降序 */
  noise: PwVoiceSieveItem[];
}

/* TASK-PW-66：评论筛子·赛道（跨视频桶聚合，条目多一个 bvid 标注来源） */
export interface PwVoiceSieveTrack {
  id: string;
  name: string;
  createdAt: string;
  videos: string[];
}
export interface PwVoiceSieveTrackItem extends PwVoiceSieveItem {
  bvid: string;
}
export interface PwVoiceSieveTrackAggregate {
  track: { id: string; name: string };
  videos: { bvid: string; runId: string | null; signal: number; noise: number; hasRun: boolean }[];
  buckets: { bucket: string; count: number; totalLikes: number; top: PwVoiceSieveTrackItem[] }[];
  signals: Record<string, PwVoiceSieveTrackItem[]>;
}

/* TASK-PW-71：筛子多版本交叉检出矩阵（与后端 src/pw-voice-sieve.ts getPwVoiceSieveMatrix 契约对齐） */
export interface PwVoiceSieveMatrixRun extends PwVoiceSieveRun {
  /** `${provider}/${model}`，同家族多版只算一个传感器 */
  family: string;
}
export interface PwVoiceSieveMatrixItem {
  rpid: string;
  uname: string;
  message: string;
  like: number;
  /** unix 秒 */
  ctime: number;
  signalRuns: { runId: string; bucket?: string; reason?: string }[];
  noiseRuns: string[];
  signalRunCount: number;
  familyCount: number;
}
export interface PwVoiceSieveMatrix {
  bvid: string;
  runs: PwVoiceSieveMatrixRun[];
  summary: {
    runCount: number;
    familyCount: number;
    unionSignals: number;
    consensusSignals: number;
    singletonSignals: number;
  };
  /** 8 桶恒在，按 total 降序 */
  bucketMatrix: { bucket: string; total: number; perRun: { runId: string; count: number }[] }[];
  /** 任一 run 判过 signal 的并集；signalRunCount 降序 → familyCount 降序 → like 降序 */
  items: PwVoiceSieveMatrixItem[];
}

/* TASK-PW-67：筛子精选评论导入探索区卡片（b：桶卡批量——kind='bucket' 时 bvid/rpid 可空、按 title 查重） */
export interface PwCommentCardImportInput {
  title: string;
  message: string;
  count?: number;
  source: {
    platform: string;
    bvid?: string;
    rpid?: string;
    uname?: string;
    like?: number;
    kind?: 'comment' | 'bucket';
    bucket?: string;
  };
}

/** TASK-PW-51：方向成绩单行（direction NULL 由后端归「默认」）。 */
export interface PwDirectionStatRow {
  direction: string;
  runs: number;
  cards: number;
  picked: number;
  rejected: number;
  pending: number;
}

export interface PwContentBet extends PwBet {
  kind: string;
  source_card_id: string | null;
  quote_text: string | null;
  /** TASK-PW-36：draft 态素材草案份数（rail 📝×N 角标语义）。 */
  draft_count?: number;
}

export interface PwContentBetOverrides {
  title?: string;
  conversionSignal?: string;
  metricTarget?: string;
  reviewDate?: string;
}

/* TASK-PW-36：决策层读模型（对应后端 PW-30/31/34/35 读函数形状） */
export interface PwAmmoRow {
  verdict_id: string;
  verdict_source: 'paperweight' | 'papertable';
  verdict_kind: 'gold' | 'tomb';
  text: string | null;
  ref_count: number;
  first_used_at: string;
  last_used_at: string;
  latest_marker: string | null;
}

export interface PwAmmoRef {
  id: string;
  verdict_id: string;
  verdict_source: 'paperweight' | 'papertable';
  verdict_kind: 'gold' | 'tomb';
  source_kind: 'collab_message' | 'content_draft';
  source_id: string;
  marker: string;
  created_at: string;
  source_label: string;
}

export interface PwSourceComparisonRow {
  bvid: string;
  title: string | null;
  upName: string | null;
  comments: number;
  candidates: number;
  wildcards: number;
  golds: number;
  picked: number;
  refs: number;
  finalized: number;
  intoChain: number;
}

export interface PwSourceComparison {
  rangeDays: number;
  generatedAt: string;
  pendingLanes: string[];
  sources: PwSourceComparisonRow[];
  /** 笔记通路实行计数（总条数 + 窗口内新增）；Memos 不可达为 null（屏层回退灰行）。 */
  notesLane: { total: number; addedInRange: number } | null;
}

export interface PwOutputRankingRow {
  bvid: string;
  title: string | null;
  upName: string | null;
  produced: number;
  picked: number;
  refCount: number;
}

export interface PwOutputRanking {
  rangeDays: number;
  generatedAt: string;
  ranking: PwOutputRankingRow[];
}

export interface PwDaySummary {
  date: string;
  startIso: string;
  endIso: string;
  generatedAt: string;
  totalEvents: number;
  otherCount: number;
  otherDist: Array<{ label: string; count: number }>;
  draftRunBatches: number;
  draftsCreated: number;
  picks: Array<{ time: string; quote: string; betTitle: string | null; edited: boolean; actor: string }>;
  betConfirms: Array<{ time: string; betTitle: string | null; actor: string }>;
  finalizes: Array<{ time: string; draftRoute: string; draftTitle: string; betTitle: string | null; actor: string }>;
  cardRejects: Array<{ time: string; quote: string; reason: string | null }>;
  draftRejects: Array<{ time: string; route: string; title: string; reason: string | null }>;
  draftRuns: Array<{ time: string; trigger: string; created: number; error: string | null }>;
  execActions: Array<{ time: string; eventType: string; object: string; instruction: string | null }>;
  autoActions: Array<{ time: string; eventType: string; object: string }>;
}

export interface PwContentDraft {
  id: string;
  bet_id: string;
  batch_id: string;
  route: string;
  title_candidate: string;
  skeleton_json: string;
  status: 'draft' | 'finalized' | 'rejected';
  reject_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface PwArtifact {
  id: string;
  bet_id: string;
  platform: string;
  url: string | null;
  title: string | null;
  type: PwArtifactType;
  published_at: string | null;
  note: string | null;
  created_at: string;
  detached_at: string | null;
}

export interface PwDataDoc {
  id: string;
  bet_id: string;
  artifact_id: string | null;
  platform: string;
  collected_at: string;
  method: 'manual' | 'export' | 'sync';
  metrics_json: string;
  raw_ref: string | null;
  source_hash: string | null;
  version: number;
  frozen: number;
  created_at: string;
}

export interface PwVerdict {
  id: string;
  bet_id: string;
  outcome: PwOutcome;
  lesson: string | null;
  cause_of_death: string | null;
  evidence_doc_ids_json: string;
  confidence_snapshot: number | null;
  decided_by: 'human';
  decided_at: string;
  created_at: string;
}

export interface PwRunEvent {
  id: string;
  kind: 'manual_event' | 'ai_draft' | 'sync';
  event_type: 'create' | 'attach' | 'data_doc' | 'draft' | 'confirm' | 'reject' | 'settle';
  actor: 'human' | 'ai' | 'system';
  payload_json: string;
  payload_hash: string;
  parent_id: string | null;
  related_ids_json: string;
  bet_id: string | null;
  created_at: string;
}

export interface PwContextItem {
  id: string;
  source: 'paperweight' | 'papertable';
  text: string;
  score: number;
  recency: string;
}

export interface PwJudgmentContext {
  markdown: string;
  included: PwContextItem[];
  truncated: boolean;
  total: number;
}

export interface PwGoldMirror {
  id: string;
  source_verdict_id: string;
  kind: 'gold';
  text: string;
  /** TASK-PW-57：行内标题（后端 stripMd 派生） */
  title: string;
  /** TASK-PW-57：行内摘要（后端 stripMd 派生） */
  summary: string;
  /** TASK-PW-57：归一化后的 markdown 全文（展开区渲染用） */
  body: string;
  handle: string | null;
  project_id: string;
  card_id: string | null;
  confirmed_at: string | null;
  mirrored_at: string;
}

/* TASK-PW-13：平台连接与 B站低频同步 */
export type PwConnectionStatus = 'active' | 'needs_human' | 'paused';

export interface PwConnection {
  id: string;
  platform: string;
  account_label: string | null;
  /** 恒为 null：cookie 本体永不落库（军规） */
  auth_ref: string | null;
  status: PwConnectionStatus;
  last_sync_at: string | null;
  risk_events_json: string;
  created_at: string;
  /** 该平台 method='sync' 的数据文档数（GET /api/pw/connections 算出） */
  docs_count: number;
}

/** 全量数据文档行（GET /api/pw/data-docs）：join 出押注 / 产出物标题 */
export interface PwDataDocRow extends PwDataDoc {
  bet_title: string | null;
  artifact_title: string | null;
}

/* TASK-PW-14：定向语料（人工授权 → 抓取器低频落本地） */
export type PwCorpusStatus = 'pending' | 'fetching' | 'done' | 'needs_human' | 'failed';

export interface PwCorpusDoc {
  id: string;
  bvid: string;
  title: string | null;
  up_name: string | null;
  kinds: string;
  status: PwCorpusStatus;
  path: string | null;
  sha256: string | null;
  video_stat_json: string | null;
  comment_count: number | null;
  authorized_by: string;
  error: string | null;
  fetched_at: string | null;
  created_at: string;
}

export interface PwCorpusHit {
  bvid: string;
  uname: string | null;
  /** 命中片段，命中词包 <b></b> */
  snippet: string;
  like: number | null;
}

/* TASK-PW-15/16：协作台（会话流 + 待确认队列 + 装配上下文） */
export interface PwCollabMessage {
  id: string;
  bet_id: string;
  role: 'user' | 'assistant';
  text: string;
  /** JSON 数组字符串：[{id, name, args}] */
  tool_calls_json: string;
  created_at: string;
}

export type PwSettleRecommendation = 'settle_gold' | 'settle_tomb' | 'wait';

export interface PwSettleAdvice {
  recommendation: PwSettleRecommendation;
  lesson?: string | null;
  cause_of_death?: string | null;
  note?: string | null;
}

export interface PwSettleDraft {
  id: string;
  bet_id: string;
  advice_json: string;
  draft_hash: string;
  status: 'pending' | 'approved' | 'rejected';
  reject_reason: string | null;
  created_by: string;
  created_at: string;
}

export interface PwCollabGoldItem {
  ref: string;
  id: string;
  source: 'paperweight' | 'papertable';
  text: string;
}

export interface PwCollabTombItem {
  ref: string;
  id: string;
  causeOfDeath: string;
}

export interface PwCollabContext {
  markdown: string;
  golds: PwCollabGoldItem[];
  tombs: PwCollabTombItem[];
  charUsed: number;
}

export interface PwPendingQueue {
  betDrafts: PwBet[];
  settleDrafts: PwSettleDraft[];
  corpusProposed: PwCorpusDoc[];
}

/** 押注草稿确认时可携带的编辑字段（与 confirmPwBetDraft 的 edits 对齐） */
export interface PwBetDraftEdits {
  title?: string;
  thesis?: string;
  metric?: string;
  metricTarget?: string;
  confidence?: number | null;
  dataSourcePlan?: string;
  checkoutDate?: string;
}

/* 简报21·第一期：押注成熟度总账（/api/pw/bets/ledger 契约，主控钉死） */
export type PwBetMaturity = 'not_due' | 'due_ready' | 'due_missing_data' | 'metric_invalid' | 'overdue';

/* 简报23·第二期：判决晋级 / 先例处置 / 曝光账（契约，主控钉死） */
export type PwPromotionLevel = 'case_only' | 'prior' | 'warning' | 'hard_constraint' | 'action_item';

export interface PwPromotion {
  id: string;
  verdict_id: string;
  level: PwPromotionLevel;
  scope: string | null;
  review_by: string | null;
  reason: string | null;
  status: 'active' | 'superseded' | 'expired';
  superseded_by: string | null;
  decided_by: string;
  created_at: string;
}

export interface PwPrecedentItem {
  verdictId: string;
  outcome: PwOutcome;
  text: string | null;
  source: 'own' | 'mirror';
  promotion: { level: PwPromotionLevel; scope: string | null } | null;
  matchReason: string | null;
}

export type PwDispositionKind = 'adopted' | 'distinguished' | 'not_applicable' | 'overridden';

export interface PwPreflightCheck {
  name: string;
  result: 'pass' | 'fail' | 'needs_human';
  detail: string;
}

export interface PwLedgerRow {
  betId: string;
  title: string;
  betType: string | null;
  activatedAt: string | null;
  dueAt: string | null;
  confidence: number | null;
  metricSummary: string | null;
  dataSource: { kind: string | null; status: string | null; lastDataAt: string | null };
  maturity: PwBetMaturity;
  revisionCount: number;
  nextForcedEvent: string | null;
}

/* 简报21·第一期：双账（/api/pw/health-accounts，算不出为 null） */
export interface PwHealthAccounts {
  epistemic: { validSettlements: number | null; byCohort: unknown[] };
  operational: {
    dueReadyRate: number | null;
    validSettlementRate: number | null;
    avgSettleLatencyDays: number | null;
    settleDebtDays: number | null;
    avoidableVoidRate: number | null;
    autoFeedSuccessRate: number | null;
    recurringVoidCauses: Array<{ cause: string; count: number }>;
  };
}

export const pwApi = {
  listBets: (status?: PwBetStatus) =>
    request<{ bets: PwBet[] }>(`/api/pw/bets${status ? `?status=${status}` : ''}`),
  dueBets: () => request<{ bets: PwBet[] }>('/api/pw/bets/due'),
  betsLedger: () => request<{ rows: PwLedgerRow[] }>('/api/pw/bets/ledger'),
  healthAccounts: () => request<PwHealthAccounts>('/api/pw/health-accounts'),

  /* 简报23·第二期 */
  preflightBet: (id: string, edits?: Record<string, unknown>) =>
    request<{ checks: PwPreflightCheck[]; pass: boolean }>(
      `/api/pw/bets/${encodeURIComponent(id)}/activate/preflight`,
      { method: 'POST', body: JSON.stringify(edits ? { edits } : {}) },
    ),
  activateBet: (id: string, edits?: Record<string, unknown>) =>
    request<{ bet: PwBet; preflight: { checks: PwPreflightCheck[]; pass: boolean } }>(
      `/api/pw/bets/${encodeURIComponent(id)}/activate`,
      { method: 'POST', body: JSON.stringify(edits ? { edits } : {}) },
    ),
  betPrecedents: (id: string) =>
    request<{ items: PwPrecedentItem[] }>(`/api/pw/bets/${encodeURIComponent(id)}/precedents`),
  disposePrecedents: (
    id: string,
    dispositions: Array<{
      verdictId: string;
      promotionId?: string;
      disposition: PwDispositionKind;
      reason?: string;
    }>,
  ) =>
    request<{ inserted: number }>(`/api/pw/bets/${encodeURIComponent(id)}/precedents/dispose`, {
      method: 'POST',
      body: JSON.stringify({ dispositions }),
    }),
  promoteVerdict: (
    id: string,
    input: { level: PwPromotionLevel; scope?: string; reviewBy?: string; reason?: string },
  ) =>
    request<PwPromotion>(`/api/pw/verdicts/${encodeURIComponent(id)}/promote`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  verdictPromotion: (id: string) =>
    request<{ promotion: PwPromotion | null }>(`/api/pw/verdicts/${encodeURIComponent(id)}/promotion`),
  getBet: (id: string) => request<PwBet>(`/api/pw/bets/${encodeURIComponent(id)}`),
  createBet: (input: {
    title: string;
    thesis: string;
    metric: string;
    metricTarget?: string;
    confidence?: number | null;
    dataSourcePlan: string;
    checkoutDate: string;
    status: 'draft' | 'pending';
  }) => request<PwBet>('/api/pw/bets', { method: 'POST', body: JSON.stringify(input) }),
  /* TASK-PW-72：押注通知链路 P1，手动产生一条 MANUAL_TEST 信号验证手机推送 */
  notifyTestSignal: (betId?: string) =>
    request<{
      alreadyExists: boolean;
      signal: { id: string; bet_id: string; kind: string; observed_at: string };
      testUrl: string | null;
    }>('/api/pw/notify/test-signal', {
      method: 'POST',
      body: JSON.stringify(betId ? { betId } : {}),
    }),
  betContext: (id: string) =>
    request<PwJudgmentContext>(`/api/pw/bets/${encodeURIComponent(id)}/context`),
  betTimeline: (id: string) =>
    request<{ events: PwRunEvent[] }>(`/api/pw/bets/${encodeURIComponent(id)}/timeline`),

  listArtifacts: (betId: string) =>
    request<{ artifacts: PwArtifact[] }>(`/api/pw/bets/${encodeURIComponent(betId)}/artifacts`),
  attachArtifact: (
    betId: string,
    input: {
      platform: string;
      type: PwArtifactType;
      url?: string;
      title?: string;
      publishedAt?: string;
      note?: string;
    },
  ) =>
    request<PwArtifact>(`/api/pw/bets/${encodeURIComponent(betId)}/artifacts`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  detachArtifact: (id: string) =>
    request<PwArtifact>(`/api/pw/artifacts/${encodeURIComponent(id)}/detach`, {
      method: 'POST',
      body: '{}',
    }),

  listDataDocs: (betId: string) =>
    request<{ docs: PwDataDoc[] }>(`/api/pw/bets/${encodeURIComponent(betId)}/data-docs`),
  createDataDoc: (
    betId: string,
    input: { platform: string; metricsJson: string; artifactId?: string | null; rawRef?: string },
  ) =>
    request<PwDataDoc>(`/api/pw/bets/${encodeURIComponent(betId)}/data-docs`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  settleBet: (
    betId: string,
    input: { outcome: PwOutcome; lesson?: string; causeOfDeath?: string; evidenceDocIds: string[] },
  ) =>
    request<PwVerdict>(`/api/pw/bets/${encodeURIComponent(betId)}/settle`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  listVerdicts: (outcome?: PwOutcome) =>
    request<{ verdicts: PwVerdict[] }>(`/api/pw/verdicts${outcome ? `?outcome=${outcome}` : ''}`),
  searchVerdicts: (q: string) =>
    request<{ verdicts: PwVerdict[] }>(`/api/pw/verdicts/search?q=${encodeURIComponent(q)}`),
  tombstoneStats: () => request<{ causes: Record<string, number> }>('/api/pw/verdicts/tombstone-stats'),

  mirrorGolds: () =>
    request<{ added: number; skipped: number }>('/api/pw/gold-sync/mirror', {
      method: 'POST',
      body: '{}',
    }),
  listGolds: (keyword?: string) =>
    request<{ golds: PwGoldMirror[] }>(
      `/api/pw/golds${keyword ? `?keyword=${encodeURIComponent(keyword)}` : ''}`,
    ),

  listConnections: () => request<{ connections: PwConnection[] }>('/api/pw/connections'),
  createConnection: (input: { platform: string; accountLabel?: string }) =>
    request<PwConnection>('/api/pw/connections', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  setConnectionStatus: (id: string, input: { status: PwConnectionStatus; reason?: string }) =>
    request<PwConnection>(`/api/pw/connections/${encodeURIComponent(id)}/status`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  syncBilibili: (items: Array<{ artifactId: string; metrics: Record<string, number>; rawRef?: string }>) =>
    request<{ created: number; errors: Array<{ artifactId: string | null; reason: string }> }>(
      '/api/pw/sync/bilibili',
      { method: 'POST', body: JSON.stringify({ items }) },
    ),
  listAllDataDocs: () => request<{ docs: PwDataDocRow[] }>('/api/pw/data-docs'),

  /* TASK-PW-14：定向语料（pending/fetching/done/fail 归抓取器，前端只用这三个） */
  authorizeCorpus: (input: { bvid: string; kinds?: string; note?: string; force?: 1 }) =>
    request<PwCorpusDoc & { existed: boolean }>('/api/pw/corpus', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  listCorpus: () => request<{ items: PwCorpusDoc[] }>('/api/pw/corpus'),
  searchCorpus: (q: string) =>
    request<{ hits: PwCorpusHit[] }>(`/api/pw/corpus/search?q=${encodeURIComponent(q)}`),

  /* TASK-PW-15/16：协作台 */
  collabMessages: (betId: string) =>
    request<{ messages: PwCollabMessage[] }>(
      `/api/pw/collab/${encodeURIComponent(betId)}/messages`,
    ),
  collabContext: (betId: string) =>
    request<PwCollabContext>(`/api/pw/collab/${encodeURIComponent(betId)}/context`),
  pendingQueue: () => request<PwPendingQueue>('/api/pw/collab/pending-queue'),
  approveSettleDraft: (id: string) =>
    request<PwSettleDraft>(`/api/pw/collab/settle-drafts/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      body: '{}',
    }),
  rejectSettleDraft: (id: string, reason: string) =>
    request<PwSettleDraft>(`/api/pw/collab/settle-drafts/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  approveCorpus: (id: string) =>
    request<PwCorpusDoc>(`/api/pw/collab/corpus/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      body: '{}',
    }),
  rejectCorpus: (id: string) =>
    request<PwCorpusDoc>(`/api/pw/collab/corpus/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      body: '{}',
    }),
  confirmBetDraft: (id: string, edits?: PwBetDraftEdits) =>
    request<PwBet & { draft_hash: string }>(`/api/pw/drafts/${encodeURIComponent(id)}/confirm`, {
      method: 'POST',
      body: JSON.stringify(edits ? { edits } : {}),
    }),
  rejectBetDraft: (id: string, reason: string) =>
    request<PwBet & { draft_hash: string; reason: string }>(
      `/api/pw/drafts/${encodeURIComponent(id)}/reject`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    ),

  /* TASK-PW-20：选题候选卡（挑/改/否）与内容押注卡 */
  sieveStatus: () => request<PwSieveStatus>('/api/pw/sieve/status'),
  runSieve: () =>
    request<{ runId: string | null }>('/api/pw/sieve/run', { method: 'POST', body: '{}' }),
  listSieveCards: (status?: string) =>
    request<{ cards: PwSieveCard[] }>(
      `/api/pw/sieve/cards${status ? `?status=${encodeURIComponent(status)}` : ''}`,
    ),
  pickSieveCard: (id: string, overrides?: PwContentBetOverrides) =>
    request<PwBet>(`/api/pw/sieve/cards/${encodeURIComponent(id)}/pick`, {
      method: 'POST',
      body: JSON.stringify(overrides ? { overrides } : {}),
    }),
  rejectSieveCard: (id: string, reason?: string) =>
    request<{ ok: boolean }>(`/api/pw/sieve/cards/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  /* TASK-PW-42/43：方向输入（人定）与全否换方向 */
  setSieveDirection: (direction: string | null) =>
    request<{ direction: string | null }>('/api/pw/sieve/direction', {
      method: 'PUT',
      body: JSON.stringify({ direction }),
    }),
  rejectAllSieveCards: (reason?: string, direction?: string, resieveAll?: boolean) =>
    request<{ rejected: number; runId: string | null; direction: string | null; note?: string }>(
      '/api/pw/sieve/reject-all',
      { method: 'POST', body: JSON.stringify({ reason, direction, resieveAll }) },
    ),
  /* TASK-PW-51：方向成绩单（只读聚合） */
  sieveDirectionStats: () =>
    request<{ rows: PwDirectionStatRow[] }>('/api/pw/sieve/direction-stats'),
  listContentBets: () => request<{ bets: PwContentBet[] }>('/api/pw/content-bets'),

  /* TASK-PW-45/46/47：观众声音（列表/提请候选/语料评论只读分区/一键收录） */
  listVoice: () => request<{ items: PwVoiceItem[] }>('/api/pw/voice'),
  promoteVoice: (id: string) =>
    request<{ runId: string; card: PwSieveCard }>(
      `/api/pw/voice/${encodeURIComponent(id)}/promote`,
      { method: 'POST', body: '{}' },
    ),
  voiceCorpusComments: (bvid: string, offset = 0, limit = 50) =>
    request<{ meta: { bvid: string; title?: string; up_name?: string }; comments: PwVoiceCorpusComment[] }>(
      `/api/pw/voice/corpus-comments?bvid=${encodeURIComponent(bvid)}&offset=${offset}&limit=${limit}`,
    ),
  collectVoiceComment: (bvid: string, rpid: number) =>
    request<PwVoiceItem>('/api/pw/voice/collect', {
      method: 'POST',
      body: JSON.stringify({ bvid, rpid }),
    }),
  /* TASK-PW-64：语料评论主题卡（右栏主视图；corpus-comments 旧端点留作台账对账） */
  voiceCorpusCards: (bvid: string, status = 'suggested') =>
    request<{ cards: PwVoiceThemeCard[] }>(
      `/api/pw/voice/corpus-cards?bvid=${encodeURIComponent(bvid)}&status=${encodeURIComponent(status)}`,
    ),
  voiceCorpusCardsAggregate: (bvid: string) =>
    request<PwVoiceCardRun>('/api/pw/voice/corpus-cards/aggregate', {
      method: 'POST',
      body: JSON.stringify({ bvid }),
    }),
  voiceCorpusCardCollect: (cardId: string) =>
    request<{ card: PwVoiceThemeCard; collected: number; skipped: number }>(
      '/api/pw/voice/corpus-cards/collect',
      { method: 'POST', body: JSON.stringify({ cardId }) },
    ),
  voiceCorpusCardReject: (cardId: string) =>
    request<{ ok: boolean }>('/api/pw/voice/corpus-cards/reject', {
      method: 'POST',
      body: JSON.stringify({ cardId }),
    }),
  /* TASK-PW-65：评论筛子结果（run 列表新在前 + 详情；后端并行开发，契约已定死） */
  voiceSieveRuns: (bvid: string) =>
    request<{ runs: PwVoiceSieveRun[] }>(`/api/pw/voice/sieve-runs?bvid=${encodeURIComponent(bvid)}`).then((r) => r.runs),
  voiceSieveRunDetail: (id: string) =>
    request<PwVoiceSieveRunDetail>(`/api/pw/voice/sieve-runs/${id}`),
  /* TASK-PW-66：评论筛子·赛道（跨视频桶聚合） */
  voiceSieveTracks: () =>
    request<{ tracks: PwVoiceSieveTrack[] }>('/api/pw/voice/sieve-tracks').then((r) => r.tracks),
  createVoiceSieveTrack: (name: string) =>
    request<PwVoiceSieveTrack>('/api/pw/voice/sieve-tracks', { method: 'POST', body: JSON.stringify({ name }) }),
  attachVoiceSieveTrackVideo: (trackId: string, bvid: string) =>
    request<unknown>(`/api/pw/voice/sieve-tracks/${trackId}/videos`, { method: 'POST', body: JSON.stringify({ bvid }) }),
  detachVoiceSieveTrackVideo: (trackId: string, bvid: string) =>
    request<unknown>(`/api/pw/voice/sieve-tracks/${trackId}/videos/${encodeURIComponent(bvid)}`, { method: 'DELETE' }),
  voiceSieveTrackAggregate: (trackId: string) =>
    request<PwVoiceSieveTrackAggregate>(`/api/pw/voice/sieve-tracks/${trackId}/aggregate`),
  /* TASK-PW-71：筛子多版本交叉检出矩阵（复现/异议并集，只读） */
  voiceSieveMatrix: (bvid: string) =>
    request<PwVoiceSieveMatrix>(`/api/pw/voice/sieve-matrix?bvid=${encodeURIComponent(bvid)}`),
  /* TASK-PW-67：筛子精选评论导入探索区卡片（原样落卡不跑 AI，rpid 幂等查重）
     TASK-PW-69：corpusRunIds 可选——给定时后端把每个筛子 run 的信号评论写成项目临时材料，供深挖检索 */
  importCommentCards: (projectId: string, cards: PwCommentCardImportInput[], corpusRunIds?: string[]) =>
    request<{
      imported: string[];
      skipped: string[];
      corpus: { imported: string[]; skipped: string[] };
    }>(`/api/projects/${encodeURIComponent(projectId)}/cards/import`, {
      method: 'POST',
      body: JSON.stringify({ cards, ...(corpusRunIds?.length ? { corpusRunIds } : {}) }),
    }),
  /* TASK-PW-50：重分拣（标错翻案；调既有 classify 端点） */
  classifyVoice: (ids: string[]) =>
    request<{ items: PwVoiceItem[] }>('/api/pw/voice/classify', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

  /* TASK-PW-36：决策层（弹药架/多源可视化/收工小结/素材草案区） */
  ammoShelf: () => request<{ shelf: PwAmmoRow[] }>('/api/pw/ammo-shelf'),
  ammoRefs: (verdictId: string) =>
    request<{ refs: PwAmmoRef[] }>(`/api/pw/ammo-shelf/${encodeURIComponent(verdictId)}/refs`),
  sourceStats: (range: 7 | 30) =>
    request<{ comparison: PwSourceComparison; ranking: PwOutputRanking }>(
      `/api/pw/source-stats?range=${range}`,
    ),
  daySummary: (date?: string) =>
    request<{ summary: PwDaySummary; text: string }>(
      `/api/pw/day-summary${date ? `?date=${encodeURIComponent(date)}` : ''}`,
    ),
  listBetDrafts: (betId: string, status?: string) =>
    request<{ drafts: PwContentDraft[] }>(
      `/api/pw/bets/${encodeURIComponent(betId)}/drafts${status ? `?status=${encodeURIComponent(status)}` : ''}`,
    ),
  finalizeContentDraft: (id: string) =>
    request<{ draft: PwContentDraft; artifacts: PwArtifact[] }>(
      `/api/pw/content-drafts/${encodeURIComponent(id)}/finalize`,
      { method: 'POST', body: '{}' },
    ),
  rejectContentDraft: (id: string, reason?: string) =>
    request<{ draft: PwContentDraft }>(`/api/pw/content-drafts/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  runDraftBatch: (betId: string) =>
    request<{ ok: boolean }>(`/api/pw/bets/${encodeURIComponent(betId)}/draft-run`, {
      method: 'POST',
      body: '{}',
    }),
  listBetArtifacts: (betId: string) =>
    request<{ artifacts: PwArtifact[] }>(`/api/pw/bets/${encodeURIComponent(betId)}/artifacts`),

  /* TASK-PW-41：笔记屏（Memos 库只读六端点） */
  notesStatus: () => request<PwNotesStatus>('/api/pw/notes/status'),
  notesList: (limit: number, offset: number) =>
    request<{ notes: PwNote[] }>(`/api/pw/notes?limit=${limit}&offset=${offset}`),
  notesSearch: (q: string) =>
    request<{ notes: PwNote[] }>(`/api/pw/notes/search?q=${encodeURIComponent(q)}`),
  notesStats: (days?: number) =>
    request<{ days: PwNoteDayStat[] }>(`/api/pw/notes/stats${days ? `?days=${days}` : ''}`),
  notesTags: () => request<{ tags: PwNoteTagCount[] }>('/api/pw/notes/tags'),
  notesRecall: (betId: string) =>
    request<{ recall: PwNoteRecallBet }>(`/api/pw/notes/recall?betId=${encodeURIComponent(betId)}`),

  /* TASK-PW-53：笔记定向洞察（人点按钮才跑模型） */
  notesInsightRun: (betId: string) =>
    request<{ insight: PwNoteInsight }>('/api/pw/notes/insight', {
      method: 'POST',
      body: JSON.stringify({ betId }),
    }),
  notesInsightList: (betId: string) =>
    request<{ insights: PwNoteInsight[] }>(`/api/pw/notes/insight?betId=${encodeURIComponent(betId)}`),

  /* TASK-PW-58：笔记自动卷积（常驻巡检自动出草稿；kind 缺省返回全部） */
  notesRollups: (kind?: PwNoteRollupKind) =>
    request<{ rollups: PwNoteRollup[] }>(
      `/api/pw/notes/rollups${kind ? `?kind=${kind}` : ''}`,
    ),
  notesRollupsTick: () =>
    request<{ generated: number }>('/api/pw/notes/rollups/tick', {
      method: 'POST',
      body: '{}',
    }),

  /* TASK-PW-60：笔记树（挂枝派生数据；AI 只建议，人确认才挂枝） */
  notesTree: () => request<PwNoteTree>('/api/pw/notes/tree'),
  notesTreeAttach: (noteUid: string, betId: string | null) =>
    request<{ ok: boolean }>('/api/pw/notes/tree/attach', {
      method: 'POST',
      body: JSON.stringify({ noteUid, betId }),
    }),
  notesTreeKeyword: (noteUid: string, keyword: string) =>
    request<{ ok: boolean }>('/api/pw/notes/tree/keyword', {
      method: 'POST',
      body: JSON.stringify({ noteUid, keyword }),
    }),
  notesTreeTick: () =>
    request<Record<string, unknown>>('/api/pw/notes/tree/tick', {
      method: 'POST',
      body: '{}',
    }),

  /* TASK-PW-61：笔记大盘（定时捞料 + 身价 + 缺料 + 未用）+ 捞料候选 + 单条流水账 */
  notesBoard: () => request<PwNotesBoard>('/api/pw/notes/board'),
  minerRun: () =>
    request<{ runId?: string | null }>('/api/pw/miner/run', { method: 'POST', body: '{}' }),
  minerCandidates: (status = 'suggested') =>
    request<PwMinerCandidates>(`/api/pw/miner/candidates?status=${encodeURIComponent(status)}`),
  minerConfirmCandidate: (id: string, betId: string, role: string) =>
    request<{ ok: boolean }>('/api/pw/miner/candidates/confirm', {
      method: 'POST',
      body: JSON.stringify({ id, betId, role }),
    }),
  minerRejectCandidate: (id: string) =>
    request<{ ok: boolean }>('/api/pw/miner/candidates/reject', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),

  /* TASK-PW-63：捞料概念卡（与后端 src/pw-miner.ts 契约对齐） */
  minerCards: (status = 'suggested') =>
    request<PwMinerCards>(`/api/pw/miner/cards?status=${encodeURIComponent(status)}`),
  minerConfirmCard: (cardId: string, betId: string, role: string) =>
    request<{ ok: boolean }>('/api/pw/miner/cards/confirm', {
      method: 'POST',
      body: JSON.stringify({ cardId, betId, role }),
    }),
  minerRejectCard: (cardId: string) =>
    request<{ ok: boolean }>('/api/pw/miner/cards/reject', {
      method: 'POST',
      body: JSON.stringify({ cardId }),
    }),
  minerSeedCard: (cardId: string) =>
    request<{ ok: boolean }>('/api/pw/miner/cards/seed', {
      method: 'POST',
      body: JSON.stringify({ cardId }),
    }),
  noteJourney: (uid: string) =>
    request<PwNoteJourney>(`/api/pw/notes/journey?uid=${encodeURIComponent(uid)}`),

  /* TASK-PW-12（简报 12）：笔记召回事件账本（只读两接口；区分「没叫货」与「叫了没人用」） */
  recallEventsSummary: (days = 30) =>
    request<PwRecallEventsSummary>(`/api/pw/recall-events/summary?days=${days}`),
  recallEvents: (limit = 50, offset = 0) =>
    request<PwRecallEventsPage>(`/api/pw/recall-events?limit=${limit}&offset=${offset}`),

  /* 简报 14：模式与对账条（系统视角：待你判断 / 最近动态 / 权限纪律；外部 agent 状态不假装知道） */
  modeBar: () => request<PwModeBar>('/api/pw/mode-bar'),

  /* 简报 16：提案契约（人侧只读列表 + 审；提交走 agent 通道 POST，UI 不提供） */
  proposalsList: (lane?: PwProposalLane, status?: string) => {
    const q = new URLSearchParams();
    if (lane) q.set('lane', lane);
    if (status) q.set('status', status);
    const qs = q.toString();
    return request<PwProposalsPage>(`/api/pw/proposals${qs ? `?${qs}` : ''}`);
  },
  proposalGet: (id: string) =>
    request<{ proposal: PwProposal }>(`/api/pw/proposals/${encodeURIComponent(id)}`),
  proposalReview: (id: string, action: PwProposalReviewAction, note?: string) =>
    request<{ proposal: PwProposal }>(`/api/pw/proposals/${encodeURIComponent(id)}/review`, {
      method: 'POST',
      body: JSON.stringify({ action, note }),
    }),
  proposalApply: (id: string) =>
    request<{ proposal: PwProposal }>(`/api/pw/proposals/${encodeURIComponent(id)}/apply`, {
      method: 'POST',
      body: '{}',
    }),

  /* TASK-PW-55：动作流水（pw_runs 按天按角色计数，大盘柱图用） */
  activityDaily: (days?: number) =>
    request<{ days: PwActivityDay[] }>(`/api/pw/activity-daily${days ? `?days=${days}` : ''}`),
};

/* TASK-PW-41：笔记屏类型（与 src/pw-notes.ts / pw-note-recall.ts 对齐） */
export interface PwNote {
  uid: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  visibility: 'PUBLIC' | 'PROTECTED' | 'PRIVATE';
  pinned: boolean;
  tags: string[];
  url: string;
}

/* TASK-PW-60：笔记树类型（与 src/pw-note-tree.ts 对齐） */
export interface PwNoteTreeLeaf {
  uid: string;
  keyword: string | null;
  createdAt: string;
  attachStatus: 'confirmed';
}

export interface PwNoteTreeBet {
  betId: string;
  title: string;
  status: string;
  dueDate: string | null;
  lastNoteAt: string | null;
  notes: PwNoteTreeLeaf[];
}

export interface PwNoteTreeUnassigned {
  uid: string;
  keyword: string | null;
  createdAt: string;
  suggestedBetId: string | null;
}

export interface PwNoteTree {
  direction: string | null;
  bets: PwNoteTreeBet[];
  unassigned: PwNoteTreeUnassigned[];
}

export type PwNoteDayStat = { date: string; count: number };
export type PwNoteHit = PwNote & { matchedKeywords: string[] };
export type PwNoteTagCount = { tag: string; count: number };

export interface PwNoteRecallBet {
  betId: string;
  betTitle: string;
  keywords: string[];
  hits: PwNoteHit[];
}

export interface PwNotesStatus {
  ok: boolean;
  path: string;
  error?: string;
}

/* TASK-PW-55：动作流水日行（与后端 getPwActivityDaily 对齐） */
export type PwActivityDay = { day: string; human: number; ai: number; system: number };

/* TASK-PW-53：笔记洞察报告（与 src/pw-note-insight.ts 对齐） */
export interface PwNoteInsightRef {
  uid: string;
  url: string;
  createdAt: string;
  matchedKeywords: string[];
}

export interface PwNoteInsight {
  id: string;
  betId: string;
  keywords: string[];
  noteRefs: PwNoteInsightRef[];
  model: string | null;
  report: string;
  createdAt: string;
}

/* TASK-PW-58：笔记自动卷积报告（与 src/pw-note-rollup.ts 对齐） */
export type PwNoteRollupKind = 'day' | 'week' | 'month';

export interface PwNoteRollupSourceRef {
  /** day 日报：来源笔记回链与时间 */
  uid?: string;
  url?: string;
  createdAt?: string;
  /** week/month 周报/月报：来源报告 */
  id?: string;
  period?: string;
}

export interface PwNoteRollup {
  id: string;
  kind: PwNoteRollupKind;
  /** day: 2026-08-09 / week: 2026-W32 / month: 2026-08 */
  period: string;
  sourceRefs: PwNoteRollupSourceRef[];
  sourceCount: number;
  model: string | null;
  report: string;
  createdAt: string;
}

/* TASK-PW-62：卡组决策链总结（与后端 src/pt-chain-export.ts 契约对齐） */
export interface PtChainSummary {
  projectName: string;
  question: string;
  branches: Array<{ at: string; kind: string; label: string }>;
  golds: unknown[];
  tombstones: unknown[];
  conclusion: string;
  /** 最终写入 Memos 的成稿（人可改，以人改的为准） */
  markdown: string;
}

export interface PtChainExportResult {
  memoUrl: string;
  memoUid: string;
  /** true = 同内容写过，没重复建 */
  reused: boolean;
}

/* TASK-PW-61：笔记大盘（与后端 src/pw-note-board.ts / pw-miner.ts 契约对齐） */
export type PwCheckoutKind = 'win' | 'draw' | 'loss' | 'pending' | 'none';

export interface PwBoardLastRun {
  at: string | null;
  triggerKind: 'scheduled' | 'manual' | string;
  candidates: number;
  confirmed: number;
  rejected: number;
  costCny: number;
}

export interface PwBoardKpis {
  totalNotes: number;
  usedNotes: number;
  intoDrafts: number;
  intoProducts: number;
  checkoutBack: number;
}

export interface PwBoardTodayBySource {
  note: number;
  gold: number;
  tombstone: number;
  memos: number;
}

export interface PwBoardWeekDay {
  day: string;
  fished: number;
  confirmed: number;
}

export interface PwBoardTopNote {
  uid: string;
  keyword: string;
  score: number;
  /** 近 7 天身价日快照 */
  trend: number[];
  citations: number;
  drafts: number;
  products: number;
  checkout: PwCheckoutKind;
  roles: Record<string, number>;
  lastUsedAt: string | null;
  memosUrl: string | null;
}

export interface PwBoardGap {
  betId: string;
  title: string;
  kind: 'no_material' | 'material_unused' | 'no_output';
  runsZero: number;
  relatedNotes: number;
  confirmedNotes: number;
  drafts: number;
}

export interface PwBoardUnused {
  count: number;
  pct: number;
  rejectedEver: number;
}

export interface PwNotesBoard {
  lastRun: PwBoardLastRun | null;
  kpis: PwBoardKpis;
  todayBySource: PwBoardTodayBySource;
  week: PwBoardWeekDay[];
  topNotes: PwBoardTopNote[];
  gaps: PwBoardGap[];
  unused: PwBoardUnused;
}

export type PwMinerCandidateSource = 'note' | 'gold' | 'tombstone' | 'memos';

export interface PwMinerCandidateItem {
  id: string;
  source: PwMinerCandidateSource;
  /** 列表展示用短摘（≤80 字） */
  snippet: string;
  reason: string;
  createdAt: string;
  memosUrl: string | null;
}

export interface PwMinerCandidateGroup {
  /** 空串 = 未分组 */
  betId: string;
  betTitle: string;
  items: PwMinerCandidateItem[];
}

export interface PwMinerCandidates {
  groups: PwMinerCandidateGroup[];
}

/* TASK-PW-63：捞料概念卡（确认区拍板单位 = 概念卡 + 逐字证据） */
export type PwMinerCardKind = 'concept' | 'self_memory' | 'link_shell';

export interface PwMinerCardItem {
  id: string;
  source: PwMinerCandidateSource;
  snippet: string;
  reason: string | null;
  status: string;
  memosUrl: string | null;
}

export interface PwMinerCard {
  id: string;
  kind: PwMinerCardKind;
  title: string;
  summary: string | null;
  status: string;
  suggestedBetId: string | null;
  betTitle: string | null;
  decidedRole: string | null;
  createdAt: string;
  items: PwMinerCardItem[];
}

export interface PwMinerCards {
  cards: PwMinerCard[];
}

export type PwNoteJourneyKind = 'attach' | 'draft' | 'product' | 'data' | 'checkout';

export interface PwNoteJourneyEvent {
  at: string;
  kind: PwNoteJourneyKind;
  label: string;
}

export interface PwNoteJourney {
  events: PwNoteJourneyEvent[];
}

/* TASK-PW-12（简报 12）：召回事件账本类型（与后端 src/pw-recall-events.ts 对齐） */
export type PwRecallEventKind =
  | 'surfaced'
  | 'confirmed'
  | 'rejected'
  | 'attached'
  | 'used'
  | 'settled';
export type PwRecallSurface = 'echo' | 'miner' | 'note_tree' | 'verdict';

export interface PwRecallEventsSummary {
  days: number;
  bySurface: Record<PwRecallSurface, Record<PwRecallEventKind, number>>;
  totals: Record<PwRecallEventKind, number>;
  distinctNotesSurfaced: number;
  distinctNotesConfirmed: number;
  byDay: Array<{ date: string; surfaced: number; confirmed: number }>;
}

export interface PwRecallEvent {
  id: string;
  createdAt: string;
  eventKind: PwRecallEventKind;
  surface: PwRecallSurface;
  betId: string | null;
  noteUid: string | null;
  minerCandidateId: string | null;
  runId: string | null;
  role: string | null;
  meta: Record<string, unknown> | null;
}

export interface PwRecallEventsPage {
  events: PwRecallEvent[];
  limit: number;
  offset: number;
}

/* 简报 14：模式与对账条（与后端 src/pw-mode-bar.ts 契约对齐） */
export interface PwModeBarRun {
  kind: string;
  eventType: string;
  betId: string | null;
  createdAt: string;
}

export interface PwModeBar {
  generatedAt: string;
  pendingReview: {
    betDrafts: number;
    settleDrafts: number;
    corpusProposed: number;
    proposals: number;
    total: number;
  };
  recentRuns: PwModeBarRun[];
  lastActivityAt: string | null;
  writeDiscipline: string;
}

/* 简报 16：提案契约（与后端 src/pw-proposals.ts 契约对齐；提交是 agent 通道，人侧只有审） */
export type PwProposalLane = 'content' | 'ops';
export type PwProposalStatus =
  | 'submitted'
  | 'in_review'
  | 'changes_requested'
  | 'rejected'
  | 'accepted'
  | 'applied'
  | 'verified'
  | 'rolled_back'
  | 'expired';
export type PwProposalReviewAction = 'accept' | 'reject' | 'request_changes';

export interface PwProposalCheck {
  name: string;
  source?: string;
  version?: string;
  result?: string;
  artifactRef?: string;
}

export interface PwProposal {
  id: string;
  lane: PwProposalLane;
  title: string;
  targetKind: string;
  targetId: string | null;
  baseVersion: string | null;
  briefRef: string | null;
  proposedBy: string;
  payload: Record<string, unknown> | null;
  evidence: { for?: string[]; against?: string[]; unknowns?: string[] } | null;
  checks: PwProposalCheck[] | null;
  risk: string | null;
  requestedAction: string | null;
  status: PwProposalStatus;
  reviewNote: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  appliedAt: string | null;
  appliedBy: string | null;
}

export interface PwProposalsPage {
  proposals: PwProposal[];
  limit: number;
  offset: number;
}

const RUN_EVENTS = [
  'turn_start',
  'tool_start',
  'tool_update',
  'tool_end',
  'answer_sentence',
  'citation_resolved',
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

/* ============================================================
   TASK-PW-16：协作台 SSE（POST + ReadableStream 手解 event:/data: 帧）
   ============================================================ */

export interface CollabStreamHandlers {
  onUserSaved?: (messageId: string) => void;
  onToolStart?: (tool: string, argsSummary: string) => void;
  onToolEnd?: (tool: string, summary: string) => void;
  onDelta?: (delta: string) => void;
  onDraftCreated?: (kind: 'bet' | 'settle', draftId: string) => void;
  /** TASK-PW-26：fetch_corpus 转自主档——事件从「提议待批」改为「已启动抓取」。 */
  onFetchStarted?: (corpusId: string, bvid: string) => void;
  onRunEnd?: (reason: 'done' | 'error', error?: string) => void;
  onError?: (error: Error) => void;
}

/**
 * 发一条协作台消息并消费 SSE 流（EventSource 不支持 POST，自己按帧解析）。
 * 正常以 run_end 收尾；网络/HTTP 错误走 onError。Promise 在流结束时 resolve。
 */
export async function streamCollabMessage(
  betId: string,
  text: string,
  handlers: CollabStreamHandlers,
): Promise<void> {
  const dispatch = (name: string, payload: Record<string, unknown>) => {
    switch (name) {
      case 'user_saved':
        handlers.onUserSaved?.(String(payload.messageId ?? ''));
        break;
      case 'tool_start':
        handlers.onToolStart?.(String(payload.tool ?? ''), String(payload.argsSummary ?? ''));
        break;
      case 'tool_end':
        handlers.onToolEnd?.(String(payload.tool ?? ''), String(payload.summary ?? ''));
        break;
      case 'answer_delta':
        handlers.onDelta?.(String(payload.delta ?? ''));
        break;
      case 'draft_created':
        handlers.onDraftCreated?.(payload.kind === 'bet' ? 'bet' : 'settle', String(payload.draftId ?? ''));
        break;
      case 'fetch_started':
        handlers.onFetchStarted?.(String(payload.corpusId ?? ''), String(payload.bvid ?? ''));
        break;
      case 'run_end':
        handlers.onRunEnd?.(payload.reason === 'error' ? 'error' : 'done',
          payload.error ? String(payload.error) : undefined);
        break;
      default:
        break;
    }
  };

  try {
    const response = await fetch(`/api/pw/collab/${encodeURIComponent(betId)}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!response.ok || !response.body) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error || `HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // 逐帧解析：帧以空行分隔；帧内 event: 行定名，data: 行（可多行）拼 JSON
    const pump = (chunk: string, flush: boolean) => {
      buffer += chunk;
      let cut = buffer.indexOf('\n\n');
      while (cut >= 0) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        let name = '';
        const dataLines: string[] = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith(':') || line === '') continue; // 心跳/注释
          if (line.startsWith('event:')) name = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        if (name && dataLines.length > 0) {
          try {
            dispatch(name, JSON.parse(dataLines.join('\n')) as Record<string, unknown>);
          } catch {
            /* 忽略无法解析的帧 */
          }
        }
        cut = buffer.indexOf('\n\n');
      }
      if (flush && buffer.trim()) pump('\n\n', false);
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pump(decoder.decode(value, { stream: true }), false);
    }
    pump('', true);
  } catch (error) {
    handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}
