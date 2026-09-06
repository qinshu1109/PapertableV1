import {
  Activity as ActivityIcon,
  ArrowDownUp,
  Boxes,
  BrainCircuit,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Database,
  Gauge,
  HardDrive,
  Layers3,
  Network,
  Search,
  ServerCog,
  Sparkles,
  Timer,
  Waypoints,
  XCircle,
} from "lucide-react";
import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, queryString } from "./api";
import {
  Badge,
  Card,
  CardHeader,
  Drawer,
  EmptyState,
  ErrorState,
  KeyValue,
  Loading,
  Metric,
  Progress,
  ResultNotice,
  StatusBadge,
  TableLink,
  cn,
  formatBytes,
  formatDate,
  shortId,
} from "./components/ui";
import type {
  Activity,
  BrainStatus,
  CompactionSummary,
  Cube,
  HotCandidate,
  HotCube,
  HotItem,
  HotRoute,
  HotRun,
  HotStatus,
  MemoryItem,
  ModelStatus,
  SearchResponse,
  Trace,
} from "./types";

function PageTitle({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
      <div><h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1><p className="mt-1.5 max-w-3xl text-sm leading-6 text-muted">{description}</p></div>
      {actions && <div className="shrink-0">{actions}</div>}
    </div>
  );
}

function useRemote<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    api<T>(path)
      .then((value) => { if (active) setData(value); })
      .catch((reason: Error) => { if (active) setError(reason.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [path, revision]);
  return { data, error, loading, reload };
}

function ActivityList({ items }: { items: Activity[] }) {
  if (!items.length) return <EmptyState title="暂无活动" description="AI 开始检索或写入记忆后，事件会显示在这里。" />;
  const names: Record<string, string> = {
    search: "检索记忆",
    memory_added: "新增记忆",
    memory_updated: "更新记忆",
    memory_deleted: "删除记忆",
    cube_created: "创建知识库",
    cube_updated: "更新知识库",
    cube_compacted: "压缩知识库",
    brain_rebuilt: "整理 Brain Pages",
    brain_rebuild_failed: "Brain Pages 整理失败",
  };
  return (
    <div className="divide-y divide-slate-100">
      {items.map((item, index) => (
        <div key={`${item.timestamp}-${index}`} className="flex items-start gap-3 px-5 py-4">
          <div className="mt-0.5 rounded-lg bg-slate-100 p-2 text-slate-500"><ActivityIcon size={15} /></div>
          <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-medium text-ink">{names[item.event] || item.event}</p>{item.caller && <Badge tone="blue">{item.caller}</Badge>}{item.cube_id && <Badge>{item.cube_id}</Badge>}</div>{item.query && <p className="mt-1 truncate text-xs text-muted">“{item.query}”</p>}<p className="mt-1 text-[11px] text-slate-400">{formatDate(item.timestamp)}</p></div>
          {item.trace_id && <Link to={`/retrieval?trace=${item.trace_id}`} className="text-xs font-medium text-brand-600 hover:text-brand-700">查看轨迹</Link>}
        </div>
      ))}
    </div>
  );
}

interface OverviewData {
  service: { status: string; dashboard_url: string; last_upstream_probe: Record<string, unknown> };
  user_id: string;
  cube_count: number;
  memory_count: number;
  disk_bytes: number;
  near_capacity_count: number;
  brain: BrainStatus;
  recent_activity: Activity[];
}

export function OverviewPage() {
  const { data, error, loading, reload } = useRemote<OverviewData>("/overview");
  if (loading && !data) return <Loading label="正在汇总本地记忆" />;
  if (error && !data) return <ErrorState message={error} retry={reload} />;
  if (!data) return null;
  return (
    <>
      <PageTitle title="总览" description="一个进程管理全部本地 Cube；远程模型只负责向量、重排和容量压缩。" actions={<button onClick={reload} className="button-secondary">刷新数据</button>} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="业务知识库" value={data.cube_count} helper="每库独立 Qdrant" icon={<Boxes size={19} />} />
        <Metric label="记忆总数" value={data.memory_count.toLocaleString()} helper={`${data.brain.page_count} 个 Brain Pages`} icon={<Database size={19} />} />
        <Metric label="本地数据占用" value={formatBytes(data.disk_bytes)} helper="Qdrant 与审计档案" icon={<HardDrive size={19} />} />
        <Metric label="容量提醒" value={data.near_capacity_count} helper={data.near_capacity_count ? "存在接近阈值的库" : "全部容量正常"} icon={<Gauge size={19} />} />
      </div>
      <div className="mt-6 grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        <Card><CardHeader title="最近活动" description="来自 MCP 与管理台的真实调用记录" /><ActivityList items={data.recent_activity} /></Card>
        <Card>
          <CardHeader title="运行链路" description="当前固定的数据流和故障降级方向" />
          <div className="space-y-3 p-5">
            {[
              ["1", "Index 路由", "先读取知识库简介，选择 0–2 个相关库"],
              ["2", "定向向量检索", "只打开被选择的独立 Qdrant 集合"],
              ["3", "必要时全库", "显式调用后，候选才进入远程重排"],
              ["4", "容量压缩", "90% 触发 DeepSeek V4 Flash；失败绝不删原文"],
            ].map(([step, title, text]) => <div key={step} className="flex gap-3 rounded-lg border border-slate-100 p-3"><div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">{step}</div><div><p className="text-sm font-medium text-ink">{title}</p><p className="mt-0.5 text-xs leading-5 text-muted">{text}</p></div></div>)}
          </div>
        </Card>
      </div>
    </>
  );
}

interface CubesData { user_id: string; cubes: Cube[] }

export function CubesPage() {
  const { data, error, loading, reload } = useRemote<CubesData>("/cubes");
  const cubes = data?.cubes || [];
  return (
    <>
      <PageTitle title="知识库" description="查看 AI 当前可访问的全部 Cube、路由简介和容量。知识库仍由 AI 通过 MCP 自动创建和维护。" actions={<button onClick={reload} className="button-secondary">刷新</button>} />
      {loading && !data ? <Loading /> : error && !data ? <ErrorState message={error} retry={reload} /> : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {cubes.map((cube) => (
            <Card key={cube.cube_id} className={cn("p-5", cube.cube_id === "index" && "border-brand-200 bg-brand-50/20")}>
              <div className="flex items-start justify-between gap-3"><div className="flex items-center gap-3"><div className={cn("rounded-xl p-2.5", cube.cube_id === "index" ? "bg-brand-100 text-brand-700" : "bg-slate-100 text-slate-600")}>{cube.cube_id === "index" ? <Waypoints size={19} /> : <Database size={19} />}</div><div><h2 className="text-sm font-semibold text-ink">{cube.name}</h2><p className="mt-0.5 font-mono text-[11px] text-slate-400">{cube.cube_id}</p></div></div><StatusBadge status={cube.status} /></div>
              <p className="mt-4 min-h-10 text-xs leading-5 text-muted">{cube.description}</p>
              <div className="mt-5"><div className="mb-2 flex items-center justify-between text-xs"><span className="text-muted">容量</span><span className="font-medium text-ink">{cube.count.toLocaleString()} / {cube.max_memories.toLocaleString()}</span></div><Progress value={cube.usage_percent} /><div className="mt-2 flex justify-between text-[10px] text-slate-400"><span>90% 自动压缩</span><span>{cube.usage_percent.toFixed(1)}%</span></div></div>
              <div className="mt-5 flex items-center justify-between border-t border-slate-100 pt-4"><span className="text-xs text-muted">{formatBytes(cube.disk_bytes)}</span><Link to={`/memories?cube=${cube.cube_id}`} className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700">查看记忆 <ChevronRight size={14} /></Link></div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

interface MemoriesData { items: MemoryItem[]; total: number; next_cursor: string | null; cursor: string; limit: number }

function MemoryDetail({ item, close }: { item: MemoryItem | null; close: () => void }) {
  const info = item?.metadata.info || {};
  const sourceIds = Array.isArray(info.source_ids) ? info.source_ids as string[] : [];
  return (
    <Drawer open={Boolean(item)} onClose={close} title="记忆详情" subtitle={item ? `${item.cube_id} · ${item.memory_id}` : undefined}>
      {item && <><div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm leading-7 text-ink whitespace-pre-wrap">{item.memory}</div><dl className="mt-5"><KeyValue label="知识库"><Badge tone="indigo">{item.cube_id}</Badge></KeyValue><KeyValue label="记忆 ID"><code className="text-xs">{item.memory_id}</code></KeyValue><KeyValue label="类型"><StatusBadge status={String(info.managed_kind || "raw")} /></KeyValue><KeyValue label="来源">{String(item.metadata.source || info.source_label || "—")}</KeyValue><KeyValue label="更新时间">{formatDate(String(item.metadata.updated_at || ""))}</KeyValue><KeyValue label="标签"><div className="flex flex-wrap gap-1.5">{(item.metadata.tags || []).map((tag) => <Badge key={tag}>{tag}</Badge>)}</div></KeyValue>{sourceIds.length > 0 && <KeyValue label="压缩来源"><div className="space-y-1 font-mono text-xs text-muted">{sourceIds.map((id) => <div key={id}>{id}</div>)}</div></KeyValue>}</dl></>}
    </Drawer>
  );
}

export function MemoriesPage() {
  const [searchParams] = useSearchParams();
  const initialCube = searchParams.get("cube") || "all";
  const initialMemory = searchParams.get("memory");
  const cubesRemote = useRemote<CubesData>("/cubes");
  const [cube, setCube] = useState(initialCube);
  const [kind, setKind] = useState("");
  const [tag, setTag] = useState("");
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [cursor, setCursor] = useState("0");
  const [history, setHistory] = useState<string[]>([]);
  const [selected, setSelected] = useState<MemoryItem | null>(null);
  useEffect(() => {
    if (!initialMemory || initialCube === "all") return;
    let active = true;
    api<MemoryItem>(`/memories/${encodeURIComponent(initialCube)}/${encodeURIComponent(initialMemory)}`)
      .then((item) => { if (active) setSelected(item); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [initialCube, initialMemory]);
  const path = `/memories${queryString({ cube_id: cube, cursor, limit: 50, kind, tag, query: appliedQuery })}`;
  const remote = useRemote<MemoriesData>(path);
  const apply = (event: FormEvent) => { event.preventDefault(); setCursor("0"); setHistory([]); setAppliedQuery(query.trim()); };
  const changeFilter = (setter: (value: string) => void, value: string) => { setter(value); setCursor("0"); setHistory([]); };
  return (
    <>
      <PageTitle title="记忆列表" description="按库分页查看原始记忆与压缩摘要。此页面没有写入、编辑或删除能力。" />
      <Card className="mb-5 p-4"><form onSubmit={apply} className="grid gap-3 md:grid-cols-2 xl:grid-cols-[1.2fr_.8fr_.8fr_1.8fr_auto]"><select className="field" value={cube} onChange={(e) => changeFilter(setCube, e.target.value)}><option value="all">全部业务库</option>{cubesRemote.data?.cubes.map((item) => <option key={item.cube_id} value={item.cube_id}>{item.name} · {item.cube_id}</option>)}</select><select className="field" value={kind} onChange={(e) => changeFilter(setKind, e.target.value)}><option value="">全部类型</option><option value="raw">原始记忆</option><option value="compacted">压缩摘要</option><option value="cube_index">索引简介</option></select><input className="field" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="标签（精确）" /><div className="relative"><Search size={16} className="absolute left-3 top-3 text-slate-400" /><input className="field pl-9" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="正文包含…" /></div><button className="button-primary" type="submit">筛选</button></form></Card>
      {remote.loading && !remote.data ? <Loading /> : remote.error && !remote.data ? <ErrorState message={remote.error} retry={remote.reload} /> : remote.data && (
        <div className="table-shell"><div className="flex items-center justify-between border-b border-slate-100 px-5 py-3 text-xs text-muted"><span>共 {remote.data.total.toLocaleString()} 条</span><span>每页最多 50 条</span></div>{remote.data.items.length ? <div className="overflow-x-auto"><table className="w-full"><thead className="table-head"><tr><th className="px-5 py-3">内容</th><th className="px-4 py-3">知识库</th><th className="px-4 py-3">类型</th><th className="px-4 py-3">更新时间</th></tr></thead><tbody className="divide-y divide-slate-100">{remote.data.items.map((item) => { const info = item.metadata.info || {}; return <tr key={`${item.cube_id}-${item.memory_id}`} className="hover:bg-slate-50/70"><td className="max-w-2xl px-5 py-4"><TableLink onClick={() => setSelected(item)}><p className="line-clamp-2 text-sm leading-6 text-ink">{item.memory}</p><p className="mt-1 font-mono text-[10px] text-slate-400">{shortId(item.memory_id)}</p></TableLink></td><td className="px-4 py-4"><Badge tone="indigo">{item.cube_id}</Badge></td><td className="px-4 py-4"><Badge tone={info.managed_kind === "compacted" ? "amber" : "slate"}>{String(info.managed_kind || "raw")}</Badge></td><td className="whitespace-nowrap px-4 py-4 text-xs text-muted">{formatDate(String(item.metadata.updated_at || ""))}</td></tr>; })}</tbody></table></div> : <EmptyState title="没有匹配的记忆" description="调整知识库、类型、标签或正文筛选条件。" />}<div className="flex justify-between border-t border-slate-100 px-5 py-3"><button disabled={!history.length} onClick={() => { const previous = [...history]; setCursor(previous.pop() || "0"); setHistory(previous); }} className="button-secondary h-9"><ChevronLeft size={15} />上一页</button><button disabled={!remote.data.next_cursor} onClick={() => { setHistory((value) => [...value, cursor]); setCursor(remote.data!.next_cursor!); }} className="button-secondary h-9">下一页<ChevronRight size={15} /></button></div></div>
      )}
      <MemoryDetail item={selected} close={() => setSelected(null)} />
    </>
  );
}

function TraceDetail({ data }: { data: { trace: Trace; chain: Trace[]; children: Trace[] } }) {
  const trace = data.trace;
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-5">
        {[
          ["Embedding", trace.timings.embedding_ms],
          ["Qdrant", trace.timings.qdrant_ms],
          ["FTS", trace.timings.fts_ms || 0],
          ["RRF + Rerank", (trace.timings.rrf_ms || 0) + trace.timings.rerank_ms],
          ["Total", trace.timings.total_ms],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-lg bg-slate-50 p-3">
            <p className="text-[10px] uppercase text-slate-400">{label}</p>
            <p className="mt-1 text-sm font-semibold">{value} ms</p>
          </div>
        ))}
      </div>
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">路由链</h3>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {data.chain.map((item, index) => (
            <div key={item.trace_id} className="flex items-center gap-2">
              <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                <p className="text-[10px] uppercase text-slate-400">{item.scope}</p>
                <p className="mt-0.5 text-xs font-medium">{item.searched_cube_ids.join(", ") || "无业务库"}</p>
              </div>
              {index < data.chain.length - 1 && <ChevronRight size={15} className="text-slate-300" />}
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">候选排名</h3>
          <span className="text-xs text-muted">{trace.candidate_count} 个候选 · {trace.result_count} 个结果</span>
        </div>
        <div className="mt-3 max-h-[440px] divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-200">
          {trace.candidates.map((candidate) => (
            <div key={`${candidate.cube_id}-${candidate.memory_id}`} className={cn("grid grid-cols-[70px_1fr_auto] gap-3 p-3", candidate.selected && "bg-brand-50/40")}>
              <div className="text-center text-[10px] text-slate-400">
                <p>向量 {candidate.vector_rank ? `#${candidate.vector_rank}` : "—"}</p>
                <p>全文 {candidate.fts_rank ? `#${candidate.fts_rank}` : "—"}</p>
                <p className="mt-1 text-sm font-semibold text-ink">{candidate.final_rank ? `#${candidate.final_rank}` : "—"}</p>
              </div>
              <div className="min-w-0">
                <div className="flex gap-2"><Badge>{candidate.cube_id}</Badge>{candidate.retrieval_sources.map((source) => <Badge key={source}>{source}</Badge>)}</div>
                <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted">{candidate.preview}</p>
              </div>
              <div className="text-right text-[11px] text-slate-500">
                <p>向量 {candidate.vector_score == null ? "—" : candidate.vector_score.toFixed(4)}</p>
                <p>全文 {candidate.fts_score == null ? "—" : candidate.fts_score.toFixed(4)}</p>
                <p>RRF {candidate.hybrid_score.toFixed(5)}</p>
                <p>重排 {candidate.rerank_score == null ? "—" : candidate.rerank_score.toFixed(4)}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function RetrievalPage() {
  const [searchParams] = useSearchParams();
  const cubesRemote = useRemote<CubesData>("/cubes");
  const tracesRemote = useRemote<{ items: Trace[]; total: number }>("/traces?limit=40");
  const businessCubes = (cubesRemote.data?.cubes || []).filter((cube) => cube.cube_id !== "index");
  const [scope, setScope] = useState<"index" | "selected" | "all">("index");
  const [selectedCubes, setSelectedCubes] = useState<string[]>([]);
  const [rerank, setRerank] = useState<"auto" | "on" | "off">("auto");
  const [searchMode, setSearchMode] = useState<"hybrid" | "vector" | "fts">("hybrid");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [searchError, setSearchError] = useState("");
  const [traceDetail, setTraceDetail] = useState<{ trace: Trace; chain: Trace[]; children: Trace[] } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const loadTrace = useCallback(async (traceId: string) => { try { const data = await api<{ trace: Trace; chain: Trace[]; children: Trace[] }>(`/traces/${traceId}`); setTraceDetail(data); setDrawerOpen(true); } catch (reason) { setSearchError((reason as Error).message); } }, []);
  useEffect(() => { const trace = searchParams.get("trace"); if (trace) void loadTrace(trace); }, [searchParams, loadTrace]);
  const toggleCube = (cubeId: string) => setSelectedCubes((current) => current.includes(cubeId) ? current.filter((value) => value !== cubeId) : current.length < 2 ? [...current, cubeId] : current);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSearchError(""); setResult(null);
    if (!query.trim()) { setSearchError("请输入检索问题"); return; }
    if (scope === "selected" && !selectedCubes.length) { setSearchError("定向检索至少选择一个业务库"); return; }
    setSearching(true);
    try {
      const payload = { query: query.trim(), scope, cube_ids: scope === "index" ? ["index"] : scope === "selected" ? selectedCubes : undefined, top_k: 8, rerank, search_mode: searchMode };
      const response = await api<SearchResponse>("/search", { method: "POST", body: JSON.stringify(payload) });
      setResult(response); tracesRemote.reload();
      const detail = await api<{ trace: Trace; chain: Trace[]; children: Trace[] }>(`/traces/${response.trace_id}`);
      setTraceDetail(detail);
    } catch (reason) { setSearchError((reason as Error).message); } finally { setSearching(false); }
  };
  return (
    <>
      <PageTitle title="检索调试" description="透明比较向量、FTS 和混合召回；全库模式必须显式选择。" actions={<select className="field min-w-40" value={searchMode} onChange={(event) => setSearchMode(event.target.value as "hybrid" | "vector" | "fts")}><option value="hybrid">混合召回</option><option value="vector">仅向量</option><option value="fts">仅 FTS</option></select>} />
      <div className="grid gap-6 xl:grid-cols-[420px_1fr]">
        <Card className="h-fit"><CardHeader title="发起只读检索" description="检索会调用远程 Embedding；全库 auto 模式还会调用 Reranker" /><form onSubmit={submit} className="space-y-4 p-5"><div><label className="mb-1.5 block text-xs font-medium text-slate-600">查询内容</label><textarea value={query} onChange={(e) => setQuery(e.target.value)} rows={4} className="field h-auto resize-none py-3" placeholder="例如：星桥项目采用了什么架构？" /></div><div><label className="mb-1.5 block text-xs font-medium text-slate-600">检索范围</label><div className="grid grid-cols-3 gap-2">{(["index", "selected", "all"] as const).map((value) => <button key={value} type="button" onClick={() => setScope(value)} className={cn("rounded-lg border px-2 py-2.5 text-xs font-medium transition", scope === value ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-200 text-slate-600 hover:bg-slate-50")}>{value === "index" ? "索引" : value === "selected" ? "指定库" : "全库"}</button>)}</div></div>{scope === "selected" && <div><label className="mb-1.5 block text-xs font-medium text-slate-600">业务库（最多两个）</label><div className="max-h-48 space-y-2 overflow-y-auto rounded-lg border border-slate-200 p-2">{businessCubes.map((cube) => <label key={cube.cube_id} className={cn("flex cursor-pointer items-start gap-2 rounded-md p-2 text-xs", selectedCubes.includes(cube.cube_id) ? "bg-brand-50" : "hover:bg-slate-50")}><input type="checkbox" checked={selectedCubes.includes(cube.cube_id)} disabled={!selectedCubes.includes(cube.cube_id) && selectedCubes.length >= 2} onChange={() => toggleCube(cube.cube_id)} className="mt-0.5 accent-indigo-600" /><span><b className="font-medium text-ink">{cube.name}</b><span className="mt-0.5 block text-muted">{cube.description}</span></span></label>)}</div></div>}<div><label className="mb-1.5 block text-xs font-medium text-slate-600">重排策略</label><select className="field" value={rerank} onChange={(e) => setRerank(e.target.value as "auto" | "on" | "off")}><option value="auto">Auto · 全库自动重排</option><option value="on">On · 强制重排</option><option value="off">Off · 仅向量分数</option></select></div>{searchError && <ResultNotice ok={false}>{searchError}</ResultNotice>}<button type="submit" disabled={searching} className="button-primary w-full"><Search size={16} />{searching ? "正在检索…" : "开始检索"}</button></form></Card>
        <div className="space-y-6">
          <Card><CardHeader title="本次结果" description={result ? `轨迹 ${shortId(result.trace_id)} · ${result.searched_cube_ids.length} 个库` : "完成一次查询后显示结果和耗时"} action={result && <button onClick={() => setDrawerOpen(true)} className="text-xs font-medium text-brand-600">查看完整轨迹</button>} />{!result ? <EmptyState title="等待检索" description="推荐先查询 Index，再按照简介选择一至两个业务库。无法判断时再使用全库模式。" /> : <div className="p-5"><div className="mb-4 grid gap-3 sm:grid-cols-4"><div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] text-slate-400">范围</p><p className="mt-1 text-sm font-medium">{result.scope}</p></div><div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] text-slate-400">总耗时</p><p className="mt-1 text-sm font-medium">{result.timings.total_ms} ms</p></div><div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] text-slate-400">重排</p><p className="mt-1 text-sm font-medium">{result.reranker.status}</p></div><div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] text-slate-400">结果数</p><p className="mt-1 text-sm font-medium">{result.results.length}</p></div></div>{result.warning && <div className="mb-4"><ResultNotice ok={false}>{result.warning}</ResultNotice></div>}<div className="space-y-3">{result.results.map((item) => <div key={`${item.cube_id}-${item.memory_id}`} className="rounded-xl border border-slate-200 p-4"><div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">{item.final_rank}</span><Badge tone="indigo">{item.cube_id}</Badge></div><div className="text-[11px] text-slate-400">向量 {item.vector_score?.toFixed(4)} · 重排 {item.rerank_score == null ? "—" : item.rerank_score.toFixed(4)}</div></div><p className="mt-3 text-sm leading-6 text-ink">{item.memory}</p></div>)}</div></div>}</Card>
          <Card><CardHeader title="最近检索轨迹" description="MCP 与管理台的检索都保存在本机" />{tracesRemote.loading && !tracesRemote.data ? <Loading /> : tracesRemote.data?.items.length ? <div className="divide-y divide-slate-100">{tracesRemote.data.items.slice(0, 12).map((trace) => <button key={trace.trace_id} onClick={() => void loadTrace(trace.trace_id)} className="flex w-full items-center gap-3 px-5 py-3.5 text-left hover:bg-slate-50"><div className="rounded-lg bg-brand-50 p-2 text-brand-600">{trace.scope === "all" ? <Layers3 size={15} /> : <Network size={15} />}</div><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-ink">{trace.query}</p><p className="mt-1 text-[11px] text-muted">{trace.searched_cube_ids.join(", ") || "无业务库"} · {trace.timings.total_ms} ms · {formatDate(trace.timestamp)}</p></div><StatusBadge status={trace.rerank_status} /></button>)}</div> : <EmptyState title="暂无轨迹" description="新检索会自动记录完整候选与耗时。" />}</Card>
        </div>
      </div>
      <Drawer open={drawerOpen && Boolean(traceDetail)} onClose={() => setDrawerOpen(false)} title="检索轨迹" subtitle={traceDetail ? `${traceDetail.trace.query} · ${traceDetail.trace.trace_id}` : undefined}>{traceDetail && <TraceDetail data={traceDetail} />}</Drawer>
    </>
  );
}

export function ActivityPage() {
  const cubesRemote = useRemote<CubesData>("/cubes");
  const [event, setEvent] = useState("");
  const [cube, setCube] = useState("");
  const [caller, setCaller] = useState("");
  const path = `/activity${queryString({ limit: 200, event, cube_id: cube, caller })}`;
  const remote = useRemote<{ items: Activity[]; total: number }>(path);
  return <><PageTitle title="活动日志" description="查看 AI 建库、写入、检索和压缩事件；查询正文会保存在本机轨迹中，密钥不会进入日志。" /><Card className="mb-5 p-4"><div className="grid gap-3 sm:grid-cols-3"><select className="field" value={event} onChange={(e) => setEvent(e.target.value)}><option value="">全部事件</option><option value="search">检索</option><option value="memory_added">新增记忆</option><option value="cube_created">创建知识库</option><option value="cube_compacted">容量压缩</option></select><select className="field" value={cube} onChange={(e) => setCube(e.target.value)}><option value="">全部知识库</option>{cubesRemote.data?.cubes.map((item) => <option key={item.cube_id} value={item.cube_id}>{item.name}</option>)}</select><select className="field" value={caller} onChange={(e) => setCaller(e.target.value)}><option value="">全部来源</option><option value="mcp">MCP</option><option value="dashboard">管理台</option></select></div></Card><Card><CardHeader title="事件流" description={remote.data ? `共 ${remote.data.total} 条匹配记录` : "读取本地审计日志"} />{remote.loading && !remote.data ? <Loading /> : remote.error && !remote.data ? <ErrorState message={remote.error} retry={remote.reload} /> : <ActivityList items={remote.data?.items || []} />}</Card></>;
}

export function CompactionsPage() {
  const remote = useRemote<{ items: CompactionSummary[]; total: number }>("/compactions?limit=100");
  const [detail, setDetail] = useState<{ job_id: string; history: Record<string, unknown>[]; archive: Record<string, unknown>[] } | null>(null);
  const [open, setOpen] = useState(false);
  const load = async (jobId: string) => { const value = await api<typeof detail>(`/compactions/${jobId}`); if (value) { setDetail(value); setOpen(true); } };
  return <><PageTitle title="压缩记录" description="透明查看 90% 容量触发后的 DeepSeek 摘要、原文档案和事务状态。此页面不能手动压缩或恢复。" />{remote.loading && !remote.data ? <Loading /> : remote.error && !remote.data ? <ErrorState message={remote.error} retry={remote.reload} /> : <div className="table-shell">{remote.data?.items.length ? <div className="overflow-x-auto"><table className="w-full"><thead className="table-head"><tr><th className="px-5 py-3">任务</th><th className="px-4 py-3">知识库</th><th className="px-4 py-3">来源</th><th className="px-4 py-3">状态</th><th className="px-4 py-3">时间</th></tr></thead><tbody className="divide-y divide-slate-100">{remote.data.items.map((job) => <tr key={job.job_id} className="hover:bg-slate-50"><td className="px-5 py-4"><TableLink onClick={() => void load(job.job_id)}><div><p className="font-mono text-xs font-medium text-ink">{shortId(job.job_id)}</p>{job.summary && <p className="mt-1 max-w-xl truncate text-xs text-muted">{job.summary.memory}</p>}</div></TableLink></td><td className="px-4 py-4"><Badge tone="indigo">{job.cube_id}</Badge></td><td className="px-4 py-4 text-xs text-muted">{job.source_count ?? job.source_ids?.length ?? 0} 条</td><td className="px-4 py-4"><StatusBadge status={job.status} /></td><td className="px-4 py-4 whitespace-nowrap text-xs text-muted">{formatDate(job.timestamp)}</td></tr>)}</tbody></table></div> : <EmptyState title="暂无压缩任务" description="业务库达到 90% 容量时会自动调用 DeepSeek V4 Flash，并在这里显示完整事务链。" />}</div>}<Drawer open={open && Boolean(detail)} onClose={() => setOpen(false)} title="压缩任务详情" subtitle={detail?.job_id}>{detail && <div className="space-y-6"><div><h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">状态历史</h3><div className="mt-3 space-y-2">{detail.history.map((event, index) => <div key={index} className="flex items-center gap-3 rounded-lg border border-slate-100 p-3"><StatusBadge status={String(event.status || "unknown")} /><span className="text-xs text-muted">{formatDate(String(event.timestamp || ""))}</span></div>)}</div></div><div><h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">本地档案</h3><div className="mt-3 space-y-3">{detail.archive.length ? detail.archive.map((event, index) => { const sources = Array.isArray(event.sources) ? event.sources as MemoryItem[] : []; const summary = event.summary as MemoryItem | undefined; return <div key={index} className="rounded-xl border border-slate-200 p-4"><div className="flex items-center justify-between"><StatusBadge status={String(event.status || "unknown")} /><span className="text-[11px] text-muted">{formatDate(String(event.timestamp || ""))}</span></div>{sources.length > 0 && <div className="mt-4 space-y-2">{sources.map((source) => <div key={source.memory_id} className="rounded-lg bg-slate-50 p-3"><p className="text-xs leading-5 text-ink">{source.memory}</p><p className="mt-1 font-mono text-[10px] text-slate-400">{source.memory_id}</p></div>)}</div>}{summary && <div className="mt-4 rounded-lg border border-brand-100 bg-brand-50/50 p-3"><p className="text-xs leading-5 text-ink">{summary.memory}</p></div>}</div>; }) : <p className="text-xs text-muted">旧任务创建于档案功能启用前，只保留事务 ID。</p>}</div></div></div>}</Drawer></>;
}

function ModelCard({ title, icon, data }: { title: string; icon: ReactNode; data: Record<string, unknown> }) {
  return <Card className="p-5"><div className="flex items-start justify-between"><div className="rounded-xl bg-brand-50 p-2.5 text-brand-600">{icon}</div><StatusBadge status={String(data.status || "unknown")} /></div><h2 className="mt-4 text-sm font-semibold text-ink">{title}</h2><p className="mt-1 break-all text-xs text-muted">{String(data.model || "—")}</p><dl className="mt-4"><KeyValue label="远程地址">{String(data.base_url || "—")}</KeyValue>{data.dimension != null && <KeyValue label="实测维度">{String(data.dimension)}</KeyValue>}{data.protocol != null && <KeyValue label="协议">{String(data.protocol)}</KeyValue>}{data.error_type != null && <KeyValue label="最近错误"><Badge tone="amber">{String(data.error_type)}</Badge></KeyValue>}</dl><div className="mt-4 flex items-center gap-2 text-[11px] text-emerald-700"><CheckCircle2 size={14} />API Key 已隐藏</div></Card>;
}

export function ModelsPage() {
  const remote = useRemote<ModelStatus>("/models");
  return <><PageTitle title="模型状态" description="所有模型都在远程运行，本机只保存 Qdrant、Brain Pages、轨迹和压缩档案。配置在此只读展示。" />{remote.loading && !remote.data ? <Loading /> : remote.error && !remote.data ? <ErrorState message={remote.error} retry={remote.reload} /> : remote.data && <><div className="grid gap-5 lg:grid-cols-3"><ModelCard title="Embedding" icon={<Sparkles size={19} />} data={remote.data.embedding} /><ModelCard title="Reranker" icon={<ArrowDownUp size={19} />} data={remote.data.reranker} /><ModelCard title="整理与压缩模型" icon={<BrainCircuit size={19} />} data={remote.data.chat} /></div><Card className="mt-6"><CardHeader title="职责边界" description="避免模型混用造成额外成本或不可解释行为" /><div className="grid gap-4 p-5 md:grid-cols-3"><div className="rounded-xl border border-slate-100 p-4"><Network size={18} className="text-brand-600" /><p className="mt-3 text-sm font-medium">Embedding</p><p className="mt-1 text-xs leading-5 text-muted">写入和检索查询都通过同一远程模型生成 2560 维向量。</p></div><div className="rounded-xl border border-slate-100 p-4"><ArrowDownUp size={18} className="text-brand-600" /><p className="mt-3 text-sm font-medium">Reranker</p><p className="mt-1 text-xs leading-5 text-muted">仅重新排列检索候选；失败时保留向量顺序，不阻断查询。</p></div><div className="rounded-xl border border-slate-100 p-4"><BrainCircuit size={18} className="text-brand-600" /><p className="mt-3 text-sm font-medium">DeepSeek V4 Flash</p><p className="mt-1 text-xs leading-5 text-muted">通过 OpenAI-compatible Chat Completions 负责每日 Brain Pages 归并和容量压缩，不参与检索重排。</p></div></div></Card></>}</>;
}

export function HotMemoryPage() {
  const status = useRemote<HotStatus>("/hot/status");
  const context = useRemote<{ version: number; generated_at?: string; context: string; unchanged: boolean }>("/hot/context");
  const items = useRemote<{ items: HotItem[] }>("/hot/items?limit=200");
  const cubes = useRemote<{ items: HotCube[] }>("/hot/cubes");
  const candidates = useRemote<{ items: HotCandidate[] }>("/hot/candidates?limit=100");
  const routes = useRemote<{ items: HotRoute[] }>("/hot/routes?limit=100");
  const runs = useRemote<{ items: HotRun[] }>("/hot/runs?limit=100");
  const [routeQuery, setRouteQuery] = useState("");
  const [routeResult, setRouteResult] = useState<HotRoute | null>(null);
  const [routeError, setRouteError] = useState("");
  const debugRoute = async (event: FormEvent) => {
    event.preventDefault();
    setRouteError("");
    try {
      const result = await api<HotRoute>("/hot/route", { method: "POST", body: JSON.stringify({ query: routeQuery }) });
      setRouteResult(result);
      routes.reload();
    } catch (reason) {
      setRouteError((reason as Error).message);
    }
  };
  if (status.loading && !status.data) return <Loading label="正在读取热记忆快照" />;
  if (status.error && !status.data) return <ErrorState message={status.error} retry={status.reload} />;
  return (
    <>
      <PageTitle title="热记忆" description="查看会话自动注入的热事实、检索地图、路由判断和会话候选。所有内容都是可追溯、可重建的只读派生数据。" />
      {status.data && <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <Metric label="快照版本" value={`v${status.data.version}`} helper={formatDate(status.data.generated_at || "")} icon={<Sparkles size={19} />} />
        <Metric label="热事实" value={status.data.items} helper={`${status.data.char_count} 字符`} icon={<BrainCircuit size={19} />} />
        <Metric label="热地图" value={status.data.cubes} helper="最多 20 个活跃库" icon={<Waypoints size={19} />} />
        <Metric label="待审候选" value={status.data.candidates} helper="低置信不自动写入" icon={<Clock3 size={19} />} />
        <Metric label="FTS 文档" value={status.data.fts.documents} helper={`${status.data.fts.status} · trigram`} icon={<Search size={19} />} />
      </div>}
      <div className="mt-6 grid gap-6 xl:grid-cols-[1.15fr_.85fr]">
        <Card>
          <CardHeader title="当前注入上下文" description={`目标 ${status.data?.target_tokens || 2000} tokens，硬上限 ${status.data?.hard_limit_tokens || 2500}`} />
          <pre className="max-h-[560px] overflow-auto whitespace-pre-wrap p-5 text-xs leading-6 text-slate-700">{context.data?.context || "尚无成功快照"}</pre>
        </Card>
        <div className="space-y-6">
          <Card>
            <CardHeader title="本地路由调试" description="只读执行强信号和热地图判断，不搜索原始记忆" />
            <form onSubmit={debugRoute} className="space-y-3 p-5">
              <textarea className="field h-auto" rows={3} value={routeQuery} onChange={(event) => setRouteQuery(event.target.value)} placeholder="例如：继续上次的 MemOS 项目" />
              <button className="button-primary" disabled={!routeQuery.trim()}><Network size={15} />判断是否检索</button>
              {routeError && <ResultNotice ok={false}>{routeError}</ResultNotice>}
              {routeResult && <div className="rounded-xl bg-slate-50 p-4 text-xs"><p className="font-medium text-ink">{routeResult.need_memory ? "建议检索" : "无需检索"}</p><p className="mt-2 text-muted">{routeResult.reason}</p><div className="mt-3 flex gap-2">{routeResult.cube_ids.map((cube) => <Badge key={cube} tone="indigo">{cube}</Badge>)}</div></div>}
            </form>
          </Card>
          <Card>
            <CardHeader title="派生层状态" description="关闭开关不会删除任何数据" />
            <dl className="p-5"><KeyValue label="热快照"><StatusBadge status={status.data?.status || "unknown"} /></KeyValue><KeyValue label="FTS"><StatusBadge status={status.data?.fts.status || "unknown"} /></KeyValue><KeyValue label="会话 Hook"><StatusBadge status={status.data?.client_ingest_enabled ? "ok" : "disabled"} /></KeyValue><KeyValue label="待编译">{status.data?.dirty ? `是 · ${status.data.dirty_reason || "未注明"}` : "否"}</KeyValue></dl>
          </Card>
        </div>
      </div>
      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card><CardHeader title="热事实与来源" description="每项都保留 Memory 或 Brain Page 来源" /><div className="max-h-[520px] divide-y divide-slate-100 overflow-y-auto">{items.data?.items.length ? items.data.items.map((item) => <div key={item.item_id} className="p-4"><div className="flex flex-wrap items-center gap-2"><Badge tone="indigo">{item.kind}</Badge><StatusBadge status={item.status} />{item.hot_policy === "pin" && <Badge tone="amber">置顶</Badge>}<span className="text-[11px] text-muted">热度 {item.heat.toFixed(2)}</span></div><p className="mt-2 text-sm leading-6 text-ink">{item.content}</p><p className="mt-2 text-[11px] text-muted">{item.reason}</p><div className="mt-2 flex flex-wrap gap-2">{item.sources.map((source) => <Link key={`${source.cube_id}-${source.memory_id}`} to={`/memories?cube=${source.cube_id}&memory=${source.memory_id}`} className="text-[11px] text-brand-600">{source.cube_id}:{shortId(source.memory_id)}</Link>)}</div></div>) : <EmptyState title="暂无热事实" description="当前原始数据均被测试过滤规则排除，或 Brain Pages 尚未形成双来源证据。" />}</div></Card>
        <Card><CardHeader title="热地图" description="活跃库显示搜索时机，其余仅保留冷库清单" /><div className="max-h-[520px] divide-y divide-slate-100 overflow-y-auto">{cubes.data?.items.length ? cubes.data.items.map((cube) => <div key={cube.cube_id} className="p-4"><div className="flex items-center justify-between"><div><p className="text-sm font-medium text-ink">{cube.name}</p><p className="font-mono text-[11px] text-muted">{cube.cube_id}</p></div><Badge tone={cube.status === "active" ? "indigo" : "slate"}>{cube.status}</Badge></div><p className="mt-2 text-xs leading-5 text-muted">{cube.description}</p><p className="mt-2 text-xs text-brand-700">何时搜索：{cube.search_when}</p></div>) : <EmptyState title="暂无业务热地图" description="测试 Cube 不进入热地图。新建真实业务 Cube 后会立即出现。" />}</div></Card>
        <Card><CardHeader title="会话候选" description="未达到自动写入阈值的候选只在这里展示" /><div className="max-h-[420px] divide-y divide-slate-100 overflow-y-auto">{candidates.data?.items.length ? candidates.data.items.map((item) => <div key={item.candidate_id} className="p-4"><div className="flex gap-2"><Badge>{item.client}</Badge><Badge>{item.kind}</Badge><StatusBadge status={item.status} /></div><p className="mt-2 text-sm text-ink">{item.content}</p><p className="mt-2 text-[11px] text-muted">置信 {item.confidence.toFixed(2)} · 保存价值 {item.write_value.toFixed(2)} · 路由 {item.route_confidence?.toFixed(2) || "—"}</p><p className="mt-1 text-xs text-muted">{item.reason}</p></div>) : <EmptyState title="暂无会话候选" description="Hook 收到 10 轮增量或会话结束后才会提取。" />}</div></Card>
        <Card><CardHeader title="路由与编译历史" description="问题预览、建议范围、实际范围和快照编译均可追踪" /><div className="max-h-[420px] divide-y divide-slate-100 overflow-y-auto">{routes.data?.items.slice(0, 12).map((route) => <div key={route.routing_decision_id} className="p-4"><div className="flex items-center justify-between"><Badge tone={route.need_memory ? "indigo" : "slate"}>{route.need_memory ? "建议搜索" : "无需搜索"}</Badge><span className="text-[11px] text-muted">{formatDate(route.timestamp)}</span></div><p className="mt-2 truncate text-sm text-ink">{route.query_preview}</p><p className="mt-1 text-xs text-muted">建议 {route.cube_ids.join(", ") || "无"} · 实际 {route.actual_cube_ids?.join(", ") || "未搜索"}</p></div>)}{runs.data?.items.slice(0, 8).map((run) => <div key={run.run_id} className="p-4"><div className="flex items-center justify-between"><span className="text-xs font-medium">编译 · {run.trigger}</span><StatusBadge status={run.status} /></div><p className="mt-1 text-[11px] text-muted">v{run.version || "—"} · {run.item_count} 项 · {formatDate(run.started_at)}</p></div>)}</div></Card>
      </div>
    </>
  );
}
