export type ProbeStatus = "ok" | "degraded" | "not_probed" | "unknown";

export interface Cube {
  cube_id: string;
  name: string;
  description: string;
  count: number;
  max_memories: number;
  usage_percent: number;
  threshold: number;
  target_after_compaction: number;
  disk_bytes: number;
  status: "ok" | "near_capacity" | "compaction_due" | "full";
}

export interface MemoryMetadata {
  user_id?: string;
  source?: string;
  tags?: string[];
  updated_at?: string;
  info?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface MemoryItem {
  cube_id: string;
  memory_id: string;
  memory: string;
  metadata: MemoryMetadata;
  vector_score?: number;
  vector_rank?: number;
  fts_score?: number | null;
  fts_rank?: number | null;
  hybrid_score?: number;
  retrieval_sources?: string[];
  rerank_score?: number | null;
  final_rank?: number;
  score?: number;
}

export interface Activity {
  timestamp: string;
  event: string;
  cube_id?: string;
  cube_ids?: string[];
  caller?: string;
  query?: string;
  trace_id?: string;
  [key: string]: unknown;
}

export interface SearchCandidate {
  cube_id: string;
  memory_id: string;
  preview: string;
  vector_score: number | null;
  vector_rank: number | null;
  fts_score: number | null;
  fts_rank: number | null;
  hybrid_score: number;
  retrieval_sources: string[];
  rerank_score: number | null;
  final_rank: number | null;
  selected: boolean;
}

export interface Trace {
  timestamp: string;
  trace_id: string;
  parent_trace_id: string | null;
  caller: string;
  query: string;
  scope: "index" | "selected" | "all";
  searched_cube_ids: string[];
  top_k: number;
  rerank_mode: "auto" | "on" | "off";
  rerank_status: string;
  embedding_model: string;
  rerank_model: string | null;
  warning: string | null;
  timings: {
    embedding_ms: number;
    qdrant_ms: number;
    fts_ms: number;
    rrf_ms: number;
    rerank_ms: number;
    total_ms: number;
  };
  candidate_count: number;
  result_count: number;
  candidates: SearchCandidate[];
}

export interface HotStatus {
  enabled: boolean;
  status: string;
  version: number;
  generated_at: string | null;
  char_count: number;
  target_tokens: number;
  hard_limit_tokens: number;
  dirty: boolean;
  dirty_reason?: string | null;
  items: number;
  cubes: number;
  candidates: number;
  routes: number;
  sessions: number;
  client_ingest_enabled: boolean;
  fts: { enabled: boolean; status: string; documents: number; tokenizer?: string };
}

export interface HotItem {
  item_id: string;
  kind: string;
  content: string;
  heat: number;
  status: string;
  hot_policy: string;
  valid_until?: string | null;
  cube_id?: string | null;
  memory_id?: string | null;
  brain_page_id?: string | null;
  reason?: string | null;
  sources: Array<{ cube_id: string; memory_id: string }>;
}

export interface HotCube {
  cube_id: string;
  name: string;
  description: string;
  search_when: string;
  activity_score: number;
  status: string;
  updated_at: string;
}

export interface HotCandidate {
  candidate_id: string;
  client: string;
  session_id: string;
  kind: string;
  content: string;
  confidence: number;
  write_value: number;
  cube_id?: string | null;
  route_confidence?: number | null;
  reason: string;
  status: string;
  created_at: string;
}

export interface HotRoute {
  routing_decision_id: string;
  timestamp: string;
  client?: string;
  query_preview: string;
  hot_version: number;
  context_sufficient: boolean;
  need_memory: boolean;
  signals: string[];
  cube_ids: string[];
  actual_cube_ids?: string[] | null;
  reason: string;
}

export interface HotRun {
  run_id: string;
  trigger: string;
  started_at: string;
  completed_at?: string | null;
  status: string;
  model?: string | null;
  source_count: number;
  item_count: number;
  version?: number | null;
  warning?: string | null;
  error_type?: string | null;
}

export interface SearchResponse {
  trace_id: string;
  parent_trace_id: string | null;
  scope: string;
  searched_cube_ids: string[];
  reranker: { mode: string; status: string; model: string | null };
  timings: Trace["timings"];
  warning: string | null;
  results: MemoryItem[];
}

export interface CompactionSummary {
  job_id: string;
  timestamp: string;
  cube_id: string;
  status: string;
  source_ids: string[];
  summary_ids: string[];
  source_count?: number;
  summary?: MemoryItem;
}

export interface ModelStatus {
  embedding: { base_url: string; model: string; dimension: number; status: ProbeStatus };
  reranker: { base_url: string; model: string; status: ProbeStatus; error_type?: string };
  chat: { base_url: string; model: string; protocol: string; status: ProbeStatus; error_type?: string };
  checked_at: string | null;
}

export type GraphNodeKind = "note" | "concept" | "entity" | "workstream";

export interface BrainRun {
  run_id: string;
  trigger: string;
  status: string;
  started_at: string;
  completed_at?: string | null;
  source_count: number;
  eligible_count: number;
  page_count: number;
  relation_count: number;
  warning?: string | null;
  error_type?: string | null;
}

export interface BrainStatus {
  enabled: boolean;
  schedule_hours: number;
  due: boolean;
  page_count: number;
  relation_count: number;
  latest_run: BrainRun | null;
  latest_successful_run: BrainRun | null;
  model: string;
  minimum_sources: number;
  relation_confidence_threshold: number;
  max_relations_per_page: number;
}

export interface BrainPageSummary {
  page_id: string;
  page_type: GraphNodeKind;
  title: string;
  summary: string;
  sections: Array<{ heading: string; content: string }>;
  confidence: number;
  importance: number;
  mention_count: number;
  source_count: number;
  status: string;
  first_seen: string;
  last_updated: string;
}

export interface BrainPageDetail extends BrainPageSummary {
  sources: Array<{
    cube_id: string;
    memory_id: string;
    evidence_excerpt: string;
    source_updated_at?: string | null;
  }>;
  related_pages: Array<{
    page_id: string;
    page_type: GraphNodeKind;
    title: string;
    summary: string;
    relation: string;
    confidence: number;
    evidence_memory_ids: string[];
  }>;
}

export interface BrainPagesResponse {
  items: BrainPageSummary[];
  total: number;
  status: BrainStatus;
}

export interface MemoryGraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  summary?: string;
  preview?: string;
  source_count: number;
  confidence: number;
  importance: number;
  updated_at?: string;
  value: number;
  degree: number;
  x?: number;
  y?: number;
  z?: number;
}

export interface MemoryGraphLink {
  source: string | MemoryGraphNode;
  target: string | MemoryGraphNode;
  kind: string;
  weight: number;
  confidence: number;
  evidence_memory_ids: string[];
}

export interface MemoryGraph {
  generated_at: string;
  scope: string;
  nodes: MemoryGraphNode[];
  links: MemoryGraphLink[];
  brain_status: BrainStatus;
  stats: {
    note: number;
    concept: number;
    entity: number;
    workstream: number;
    pages: number;
    relations: number;
    available_pages: number;
    truncated: boolean;
  };
  limits: {
    max_pages: number;
    requested_pages: number;
  };
}
