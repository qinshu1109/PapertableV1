import {
  BrainCircuit,
  ExternalLink,
  Focus,
  Globe2,
  Grid3X3,
  List,
  Orbit,
  RefreshCw,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph3D, { ForceGraphMethods } from "react-force-graph-3d";
import { Link } from "react-router-dom";
import * as THREE from "three";

import { api, queryString } from "./api";
import {
  Badge,
  Card,
  Drawer,
  EmptyState,
  ErrorState,
  Loading,
  cn,
  formatDate,
} from "./components/ui";
import type {
  BrainPageDetail,
  BrainPageSummary,
  BrainPagesResponse,
  Cube,
  GraphNodeKind,
  MemoryGraph,
  MemoryGraphLink,
  MemoryGraphNode,
} from "./types";

const COLORS: Record<GraphNodeKind, string> = {
  note: "#168454",
  concept: "#8250b5",
  entity: "#b78616",
  workstream: "#c54b32",
};

const LABELS: Record<GraphNodeKind, string> = {
  note: "笔记",
  concept: "概念",
  entity: "实体",
  workstream: "工作流",
};

const TYPE_ORDER: GraphNodeKind[] = ["concept", "entity", "workstream", "note"];

function nodeId(value: string | MemoryGraphNode): string {
  return typeof value === "string" ? value : value.id;
}

function GlobeGrid({ graph }: { graph: ForceGraphMethods }) {
  useEffect(() => {
    const scene = graph.scene();
    const group = new THREE.Group();
    group.name = "memos-brain-globe";
    const material = new THREE.LineBasicMaterial({ color: 0x94a3b8, opacity: 0.22, transparent: true, depthWrite: false });
    const radius = 205;
    for (const latitude of [-60, -30, 0, 30, 60]) {
      const radians = THREE.MathUtils.degToRad(latitude);
      const ringRadius = Math.cos(radians) * radius;
      const y = Math.sin(radians) * radius;
      const points = Array.from({ length: 97 }, (_, index) => {
        const angle = index / 96 * Math.PI * 2;
        return new THREE.Vector3(Math.cos(angle) * ringRadius, y, Math.sin(angle) * ringRadius);
      });
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material));
    }
    for (let index = 0; index < 12; index += 1) {
      const rotation = index / 12 * Math.PI;
      const points = Array.from({ length: 97 }, (_, pointIndex) => {
        const angle = pointIndex / 96 * Math.PI * 2;
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius;
        return new THREE.Vector3(x * Math.cos(rotation), y, x * Math.sin(rotation));
      });
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material));
    }
    scene.add(group);
    return () => {
      scene.remove(group);
      group.children.forEach((child) => (child as THREE.Line).geometry.dispose());
      material.dispose();
    };
  }, [graph]);
  return null;
}

function TypeBadge({ kind }: { kind: GraphNodeKind }) {
  const tone = kind === "note" ? "green" : kind === "concept" ? "indigo" : kind === "entity" ? "amber" : "red";
  return <Badge tone={tone}>{LABELS[kind]}</Badge>;
}

function BrainPageDrawer({
  page,
  loading,
  close,
  openPage,
}: {
  page: BrainPageDetail | null;
  loading: boolean;
  close: () => void;
  openPage: (pageId: string) => void;
}) {
  return (
    <Drawer
      open={loading || Boolean(page)}
      onClose={close}
      title={page?.title || "Brain Page"}
      subtitle={page ? `${LABELS[page.page_type]} · ${page.source_count} 条来源证据` : undefined}
    >
      {loading && !page ? <Loading label="正在读取整理页面" /> : page && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-2">
            <TypeBadge kind={page.page_type} />
            <Badge>{Math.round(page.confidence * 100)}% 置信度</Badge>
            <Badge>{formatDate(page.last_updated)}</Badge>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm leading-7 text-ink">
            {page.summary}
          </div>
          {page.sections.length > 0 && (
            <div className="space-y-4">
              {page.sections.map((section, index) => (
                <section key={`${section.heading}-${index}`}>
                  <h3 className="text-sm font-semibold text-ink">{section.heading}</h3>
                  <p className="mt-1.5 whitespace-pre-wrap text-sm leading-7 text-slate-600">{section.content}</p>
                </section>
              ))}
            </div>
          )}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">相关页面</h3>
            <div className="mt-3 space-y-2">
              {page.related_pages.length ? page.related_pages.map((related) => (
                <button
                  key={related.page_id}
                  onClick={() => openPage(related.page_id)}
                  className="w-full rounded-xl border border-slate-200 p-3 text-left transition hover:border-brand-200 hover:bg-brand-50/40"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2"><TypeBadge kind={related.page_type} /><span className="truncate text-sm font-medium text-ink">{related.title}</span></div>
                    <span className="text-[10px] uppercase tracking-wide text-slate-400">{related.relation.replaceAll("_", " ")}</span>
                  </div>
                  <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted">{related.summary}</p>
                </button>
              )) : <p className="rounded-xl border border-dashed border-slate-200 px-4 py-5 text-center text-xs text-muted">暂无高置信关联页面</p>}
            </div>
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">来源记忆</h3>
            <p className="mt-1 text-xs leading-5 text-muted">Brain Page 是派生内容；以下原始记忆仍保存在各自的 Qdrant Cube 中。</p>
            <div className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200">
              {page.sources.map((source) => (
                <Link
                  key={`${source.cube_id}-${source.memory_id}`}
                  to={`/memories?cube=${encodeURIComponent(source.cube_id)}&memory=${encodeURIComponent(source.memory_id)}`}
                  className="block px-4 py-3 hover:bg-slate-50"
                >
                  <div className="flex items-center justify-between gap-3"><Badge>{source.cube_id}</Badge><ExternalLink size={13} className="text-slate-400" /></div>
                  <p className="mt-2 line-clamp-3 text-xs leading-5 text-slate-600">{source.evidence_excerpt}</p>
                  {source.source_updated_at && <p className="mt-1 text-[10px] text-slate-400">{formatDate(source.source_updated_at)}</p>}
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}
    </Drawer>
  );
}

function PageCard({ page, open }: { page: BrainPageSummary; open: () => void }) {
  return (
    <button onClick={open} className="group rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-md">
      <div className="flex items-start justify-between gap-3"><TypeBadge kind={page.page_type} /><span className="text-[11px] text-slate-400">{formatDate(page.last_updated)}</span></div>
      <h3 className="mt-3 text-sm font-semibold text-ink group-hover:text-brand-700">{page.title}</h3>
      <p className="mt-2 line-clamp-4 text-xs leading-5 text-muted">{page.summary}</p>
      <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3 text-[11px] text-slate-400"><span>{page.source_count} 条来源</span><span>{Math.round(page.confidence * 100)}% 置信度</span></div>
    </button>
  );
}

export function MemoryGraphPage() {
  const graphRef = useRef<ForceGraphMethods>();
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 900, height: 680 });
  const [cubes, setCubes] = useState<Cube[]>([]);
  const [cube, setCube] = useState("all");
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"grid" | "list" | "globe">("grid");
  const [pages, setPages] = useState<BrainPagesResponse | null>(null);
  const [graph, setGraph] = useState<MemoryGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedPage, setSelectedPage] = useState<BrainPageDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [hovered, setHovered] = useState<MemoryGraphNode | null>(null);
  const [selectedNode, setSelectedNode] = useState<MemoryGraphNode | null>(null);
  const [autoRotate, setAutoRotate] = useState(true);
  const [graphReady, setGraphReady] = useState(false);
  const [visibleKinds, setVisibleKinds] = useState<Set<GraphNodeKind>>(new Set(TYPE_ORDER));

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setGraphReady(false);
    try {
      const suffix = queryString({ cube_id: cube, limit: 200 });
      const [pageResponse, graphResponse] = await Promise.all([
        api<BrainPagesResponse>(`/brain/pages${queryString({ cube_id: cube, limit: 200 })}`),
        api<MemoryGraph>(`/graph${suffix}`),
      ]);
      setPages(pageResponse);
      setGraph(graphResponse);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setLoading(false);
    }
  }, [cube]);

  useEffect(() => { void api<{ cubes: Cube[] }>("/cubes").then((response) => setCubes(response.cubes.filter((item) => item.cube_id !== "index"))); }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: Math.max(320, Math.floor(entry.contentRect.width)), height: window.innerWidth < 640 ? 540 : 680 }));
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [mode]);
  useEffect(() => {
    const controls = graphRef.current?.controls() as { autoRotate?: boolean; autoRotateSpeed?: number } | undefined;
    if (controls) { controls.autoRotate = autoRotate; controls.autoRotateSpeed = 0.35; }
  }, [autoRotate, graph, mode]);
  useEffect(() => {
    if (!selectedId) { setSelectedPage(null); return; }
    let active = true;
    setDetailLoading(true);
    api<BrainPageDetail>(`/brain/pages/${encodeURIComponent(selectedId)}`)
      .then((value) => { if (active) setSelectedPage(value); })
      .catch((reason: Error) => { if (active) setError(reason.message); })
      .finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; };
  }, [selectedId]);

  const filteredPages = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return pages?.items || [];
    return (pages?.items || []).filter((page) => `${page.title}\n${page.summary}`.toLocaleLowerCase().includes(needle));
  }, [pages, query]);
  const grouped = useMemo(() => Object.fromEntries(TYPE_ORDER.map((kind) => [kind, filteredPages.filter((page) => page.page_type === kind)])) as Record<GraphNodeKind, BrainPageSummary[]>, [filteredPages]);
  const activeNode = hovered || selectedNode;
  const neighborhood = useMemo(() => {
    const nodes = new Set<string>();
    const links = new Set<MemoryGraphLink>();
    if (!activeNode || !graph) return { nodes, links };
    nodes.add(activeNode.id);
    graph.links.forEach((link) => {
      const source = nodeId(link.source);
      const target = nodeId(link.target);
      if (source === activeNode.id || target === activeNode.id) { nodes.add(source); nodes.add(target); links.add(link); }
    });
    return { nodes, links };
  }, [activeNode, graph]);

  const openPage = (pageId: string) => setSelectedId(pageId);
  const focusNode = (node: MemoryGraphNode) => {
    setSelectedNode(node);
    setSelectedId(node.id);
    setAutoRotate(false);
    if (node.x == null || node.y == null || node.z == null) return;
    const distance = Math.hypot(node.x, node.y, node.z) || 1;
    const ratio = 1 + 115 / distance;
    graphRef.current?.cameraPosition({ x: node.x * ratio, y: node.y * ratio, z: node.z * ratio }, { x: node.x, y: node.y, z: node.z }, 850);
  };
  const resetCamera = () => {
    setSelectedNode(null);
    setHovered(null);
    graphRef.current?.cameraPosition({ x: 0, y: 0, z: 520 }, { x: 0, y: 0, z: 0 }, 700);
  };

  return (
    <>
      <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div><h1 className="text-xl font-semibold tracking-tight text-ink">Brain Pages</h1><p className="mt-1.5 max-w-3xl text-sm leading-6 text-muted">原始记忆不会直接进入图谱。后台每天把多条证据归并为概念、实体、工作流和聚合笔记，只显示高置信关系。</p></div>
        <button onClick={() => void load()} className="button-secondary"><RefreshCw size={15} />刷新</button>
      </div>
      <Card className="mb-5 p-4">
        <div className="grid gap-3 lg:grid-cols-[1fr_1fr_auto]">
          <div className="relative"><Search size={15} className="pointer-events-none absolute left-3 top-3 text-slate-400" /><input value={query} onChange={(event) => setQuery(event.target.value)} className="field pl-9" placeholder="搜索整理后的页面" /></div>
          <select className="field" value={cube} onChange={(event) => setCube(event.target.value)}><option value="all">全部业务库来源</option>{cubes.map((item) => <option key={item.cube_id} value={item.cube_id}>{item.name} · {item.cube_id}</option>)}</select>
          <div className="flex rounded-lg border border-slate-200 bg-slate-50 p-1">{(["grid", "list", "globe"] as const).map((value) => { const Icon = value === "grid" ? Grid3X3 : value === "list" ? List : Globe2; return <button key={value} onClick={() => setMode(value)} className={cn("rounded-md p-2 transition", mode === value ? "bg-white text-brand-700 shadow-sm" : "text-slate-400 hover:text-slate-700")} aria-label={value}><Icon size={16} /></button>; })}</div>
        </div>
      </Card>
      {error && !pages ? <Card><ErrorState message={error} retry={load} /></Card> : loading && !pages ? <Card><Loading label="正在读取 Brain Pages" /></Card> : pages && graph && (
        <div className="grid gap-5 xl:grid-cols-[230px_minmax(0,1fr)]">
          <Card className="h-fit p-4">
            <div className="flex items-center gap-2"><BrainCircuit size={16} className="text-brand-600" /><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Brain 浏览器</p></div>
            <button onClick={() => setVisibleKinds(new Set(TYPE_ORDER))} className="mt-3 flex w-full items-center justify-between rounded-lg bg-slate-100 px-3 py-2 text-sm font-medium text-ink"><span>全部</span><span className="text-xs text-muted">{graph.stats.pages}</span></button>
            <div className="mt-2 space-y-1">{TYPE_ORDER.map((kind) => (
              <button key={kind} onClick={() => setVisibleKinds((current) => { const next = new Set(current); if (next.has(kind)) next.delete(kind); else next.add(kind); return next; })} className={cn("flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition", visibleKinds.has(kind) ? "text-ink hover:bg-slate-50" : "text-slate-400")}><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: COLORS[kind], opacity: visibleKinds.has(kind) ? 1 : 0.25 }} /><span className="flex-1">{LABELS[kind]}</span><span className="text-xs text-muted">{graph.stats[kind]}</span></button>
            ))}</div>
            <div className="mt-5 border-t border-slate-100 pt-4 text-xs leading-5 text-muted"><p>{graph.stats.pages} 个规范页面</p><p>{graph.stats.relations} 条高置信关系</p><p>至少 {pages.status.minimum_sources} 条来源才可晋升</p>{pages.status.latest_run?.warning && <p className="mt-2 rounded-lg bg-amber-50 p-2 text-amber-700">{pages.status.latest_run.warning}</p>}</div>
          </Card>
          <div>
            {filteredPages.length === 0 ? <Card><EmptyState title="暂无可展示的 Brain Page" description="测试记忆、一次性内容和单次实体提及会留在原始记忆库，不会污染图谱。后台会在下一次整理时重新评估新增证据。" /></Card> : mode === "grid" ? (
              <div className="space-y-7">{TYPE_ORDER.filter((kind) => visibleKinds.has(kind) && grouped[kind].length > 0).map((kind) => <section key={kind}><div className="mb-3 flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: COLORS[kind] }} /><h2 className="text-sm font-semibold text-ink">{LABELS[kind]}</h2><span className="text-xs text-muted">{grouped[kind].length}</span></div><div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">{grouped[kind].map((page) => <PageCard key={page.page_id} page={page} open={() => openPage(page.page_id)} />)}</div></section>)}</div>
            ) : mode === "list" ? (
              <Card className="divide-y divide-slate-100">{filteredPages.filter((page) => visibleKinds.has(page.page_type)).map((page) => <button key={page.page_id} onClick={() => openPage(page.page_id)} className="flex w-full items-start gap-4 px-5 py-4 text-left hover:bg-slate-50"><span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: COLORS[page.page_type] }} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-semibold text-ink">{page.title}</p><TypeBadge kind={page.page_type} /></div><p className="mt-1 line-clamp-2 text-xs leading-5 text-muted">{page.summary}</p></div><span className="shrink-0 text-[11px] text-slate-400">{page.source_count} 条来源</span></button>)}</Card>
            ) : (
              <Card className="relative overflow-hidden bg-[#fbfaf7]"><div ref={containerRef} className="relative min-h-[540px] w-full sm:min-h-[680px]"><ForceGraph3D ref={graphRef} width={size.width} height={size.height} graphData={graph} backgroundColor="#fbfaf7" showNavInfo={false} nodeId="id" nodeVal={(node) => (node as MemoryGraphNode).value * (selectedNode?.id === (node as MemoryGraphNode).id ? 1.5 : 1)} nodeColor={(node) => { const item = node as MemoryGraphNode; if (!visibleKinds.has(item.kind)) return "#e2e8f0"; if (activeNode && !neighborhood.nodes.has(item.id)) return "#d8dce3"; return COLORS[item.kind]; }} nodeOpacity={0.92} nodeResolution={18} nodeLabel={() => ""} nodeVisibility={(node) => visibleKinds.has((node as MemoryGraphNode).kind)} linkVisibility={(link) => Boolean(activeNode) && neighborhood.links.has(link as MemoryGraphLink)} linkColor={() => "#273244"} linkWidth={(link) => neighborhood.links.has(link as MemoryGraphLink) ? 1.8 : 0} linkOpacity={0.72} enableNodeDrag onNodeHover={(node) => setHovered((node as MemoryGraphNode | null) || null)} onNodeClick={(node) => focusNode(node as MemoryGraphNode)} onBackgroundClick={() => { setHovered(null); setSelectedNode(null); }} onEngineStop={() => setGraphReady(true)} warmupTicks={70} cooldownTicks={160} d3VelocityDecay={0.34} />{graphReady && graphRef.current && <GlobeGrid graph={graphRef.current} />}{activeNode && <div className="pointer-events-none absolute left-4 top-4 max-w-xs rounded-lg bg-slate-950/90 px-3 py-2 text-xs leading-5 text-white shadow-xl"><p className="font-medium">{activeNode.label}</p><p className="mt-0.5 text-slate-300">{LABELS[activeNode.kind]} · {activeNode.source_count} 条来源 · {activeNode.degree} 条关系</p></div>}<div className="absolute bottom-3 left-3 flex gap-2"><button onClick={() => setAutoRotate((value) => !value)} className="button-secondary h-8 bg-white/90 px-3 text-xs"><Orbit size={14} />{autoRotate ? "停止旋转" : "自动旋转"}</button><button onClick={resetCamera} className="button-secondary h-8 bg-white/90 px-3 text-xs"><Focus size={14} />重置视角</button></div><div className="pointer-events-none absolute bottom-3 right-3 rounded-md bg-white/85 px-2.5 py-1.5 text-[11px] text-slate-500 shadow-sm backdrop-blur">默认不显示连线 · 悬停查看一跳邻域 · 点击打开页面</div></div></Card>
            )}
          </div>
        </div>
      )}
      <BrainPageDrawer page={selectedPage} loading={detailLoading} close={() => { setSelectedId(null); setSelectedPage(null); }} openPage={openPage} />
    </>
  );
}
