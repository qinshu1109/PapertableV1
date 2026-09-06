import {
  Activity,
  Boxes,
  BrainCircuit,
  ChevronRight,
  Database,
  Gauge,
  Flame,
  Menu,
  Network,
  RefreshCw,
  Search,
  ServerCog,
  Share2,
  X,
} from "lucide-react";
import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import {
  ActivityPage,
  CompactionsPage,
  CubesPage,
  MemoriesPage,
  ModelsPage,
  HotMemoryPage,
  OverviewPage,
  RetrievalPage,
} from "./pages";
import { Loading, cn } from "./components/ui";

const MemoryGraphPage = lazy(() => import("./memory-graph").then((module) => ({ default: module.MemoryGraphPage })));

const navigation = [
  { to: "/overview", label: "总览", icon: Gauge },
  { to: "/cubes", label: "知识库", icon: Boxes },
  { to: "/memories", label: "记忆列表", icon: Database },
  { to: "/graph", label: "Brain Pages", icon: Share2 },
  { to: "/hot", label: "热记忆", icon: Flame },
  { to: "/retrieval", label: "检索调试", icon: Network },
  { to: "/activity", label: "活动日志", icon: Activity },
  { to: "/compactions", label: "压缩记录", icon: BrainCircuit },
  { to: "/models", label: "模型状态", icon: ServerCog },
];

function Sidebar({ open, close }: { open: boolean; close: () => void }) {
  return (
    <>
      {open && <button aria-label="关闭导航" onClick={close} className="fixed inset-0 z-30 bg-slate-900/30 lg:hidden" />}
      <aside className={cn("fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-slate-200 bg-white transition-transform lg:translate-x-0", open ? "translate-x-0" : "-translate-x-full")}>
        <div className="flex h-16 items-center justify-between border-b border-slate-100 px-5">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 text-white shadow-sm"><BrainCircuit size={20} /></div>
            <div><p className="text-sm font-semibold tracking-tight text-ink">MemOS Local</p><p className="text-[10px] font-medium uppercase tracking-[0.16em] text-slate-400">Memory Console</p></div>
          </div>
          <button onClick={close} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 lg:hidden"><X size={17} /></button>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto p-3">
          <p className="px-3 pb-2 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">本地记忆系统</p>
          {navigation.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} onClick={close} className={({ isActive }) => cn("flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition", isActive ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-50 hover:text-ink")}>
              <Icon size={17} /><span className="flex-1">{label}</span><ChevronRight size={14} className="opacity-40" />
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-slate-100 p-4">
          <div className="rounded-xl border border-emerald-100 bg-emerald-50/70 p-3">
            <div className="flex items-center gap-2 text-xs font-medium text-emerald-800"><span className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,.12)]" />仅本机访问</div>
            <p className="mt-1.5 text-[11px] leading-4 text-emerald-700/80">127.0.0.1 · 单用户 qinshu</p>
          </div>
        </div>
      </aside>
    </>
  );
}

function Header({ openNav }: { openNav: () => void }) {
  const location = useLocation();
  const current = navigation.find((item) => location.pathname.startsWith(item.to));
  return (
    <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-slate-200 bg-white/90 px-4 backdrop-blur sm:px-6 lg:px-8">
      <div className="flex items-center gap-3">
        <button onClick={openNav} className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden"><Menu size={19} /></button>
        <div className="flex items-center gap-2 text-sm"><span className="text-slate-400">记忆管理台</span><ChevronRight size={14} className="text-slate-300" /><span className="font-medium text-ink">{current?.label || "总览"}</span></div>
      </div>
      <div className="flex items-center gap-3">
        <a href="/mcp" className="hidden items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 sm:flex"><Search size={14} />MCP Endpoint</a>
        <button aria-label="刷新页面" onClick={() => window.location.reload()} className="rounded-lg border border-slate-200 bg-white p-2 text-slate-600 shadow-sm hover:bg-slate-50"><RefreshCw size={16} /></button>
      </div>
    </header>
  );
}

export default function App() {
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setNavOpen(false), [location.pathname]);
  const title = useMemo(() => navigation.find((item) => location.pathname.startsWith(item.to))?.label || "总览", [location.pathname]);
  useEffect(() => { document.title = `${title} · MemOS Local`; }, [title]);
  return (
    <div className="min-h-screen bg-canvas">
      <Sidebar open={navOpen} close={() => setNavOpen(false)} />
      <div className="lg:pl-64">
        <Header openNav={() => setNavOpen(true)} />
        <main className="mx-auto max-w-[1600px] p-4 sm:p-6 lg:p-8">
          <Routes>
            <Route path="/overview" element={<OverviewPage />} />
            <Route path="/cubes" element={<CubesPage />} />
            <Route path="/memories" element={<MemoriesPage />} />
            <Route path="/graph" element={<Suspense fallback={<Loading label="正在加载 3D 记忆网络" />}><MemoryGraphPage /></Suspense>} />
            <Route path="/hot" element={<HotMemoryPage />} />
            <Route path="/retrieval" element={<RetrievalPage />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/compactions" element={<CompactionsPage />} />
            <Route path="/models" element={<ModelsPage />} />
            <Route path="*" element={<Navigate to="/overview" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
