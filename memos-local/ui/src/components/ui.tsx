import { ReactNode } from "react";
import { AlertCircle, CheckCircle2, ChevronRight, Database, LoaderCircle, X } from "lucide-react";

export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={cn("rounded-xl border border-slate-200 bg-white shadow-panel", className)}>{children}</section>;
}

export function CardHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
      <div>
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {description && <p className="mt-1 text-xs leading-5 text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function Badge({ children, tone = "slate" }: { children: ReactNode; tone?: "slate" | "green" | "amber" | "red" | "indigo" | "blue" }) {
  const tones = {
    slate: "bg-slate-100 text-slate-700",
    green: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
    amber: "bg-amber-50 text-amber-700 ring-amber-600/20",
    red: "bg-rose-50 text-rose-700 ring-rose-600/20",
    indigo: "bg-brand-50 text-brand-700 ring-brand-600/20",
    blue: "bg-sky-50 text-sky-700 ring-sky-600/20",
  };
  return <span className={cn("inline-flex items-center rounded-md px-2 py-1 text-[11px] font-medium ring-1 ring-inset", tones[tone])}>{children}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  const mapping: Record<string, { label: string; tone: "green" | "amber" | "red" | "slate" | "indigo" }> = {
    ok: { label: "正常", tone: "green" },
    near_capacity: { label: "接近容量", tone: "amber" },
    compaction_due: { label: "待压缩", tone: "amber" },
    full: { label: "已满", tone: "red" },
    degraded: { label: "降级", tone: "amber" },
    not_probed: { label: "未探测", tone: "slate" },
    started: { label: "已开始", tone: "indigo" },
    summaries_written: { label: "摘要已写入", tone: "indigo" },
    originals_deleted: { label: "已完成", tone: "green" },
    aborted: { label: "已中止", tone: "red" },
  };
  const config = mapping[status] || { label: status || "未知", tone: "slate" as const };
  return <Badge tone={config.tone}>{config.label}</Badge>;
}

export function Metric({ label, value, helper, icon }: { label: string; value: ReactNode; helper?: ReactNode; icon?: ReactNode }) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-muted">{label}</p>
          <div className="mt-2 text-2xl font-semibold tracking-tight text-ink">{value}</div>
          {helper && <div className="mt-2 text-xs text-muted">{helper}</div>}
        </div>
        {icon && <div className="rounded-lg bg-brand-50 p-2.5 text-brand-600">{icon}</div>}
      </div>
    </Card>
  );
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex min-h-52 flex-col items-center justify-center px-6 py-12 text-center">
      <div className="rounded-full bg-slate-100 p-3 text-slate-500"><Database size={22} /></div>
      <p className="mt-4 text-sm font-medium text-ink">{title}</p>
      <p className="mt-1 max-w-md text-xs leading-5 text-muted">{description}</p>
    </div>
  );
}

export function Loading({ label = "正在加载" }: { label?: string }) {
  return <div className="flex min-h-52 items-center justify-center gap-2 text-sm text-muted"><LoaderCircle className="animate-spin" size={18} />{label}</div>;
}

export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="m-5 flex items-start gap-3 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
      <AlertCircle size={18} className="mt-0.5 shrink-0" />
      <div className="flex-1"><p className="font-medium">读取失败</p><p className="mt-1 text-xs">{message}</p></div>
      {retry && <button onClick={retry} className="text-xs font-medium underline">重试</button>}
    </div>
  );
}

export function Drawer({ title, subtitle, open, onClose, children }: { title: string; subtitle?: string; open: boolean; onClose: () => void; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/25 backdrop-blur-[1px]" onMouseDown={onClose}>
      <aside className="h-full w-full max-w-2xl overflow-y-auto border-l border-slate-200 bg-white shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-start justify-between border-b border-slate-200 bg-white/95 px-6 py-5 backdrop-blur">
          <div className="min-w-0"><h2 className="truncate text-base font-semibold text-ink">{title}</h2>{subtitle && <p className="mt-1 truncate text-xs text-muted">{subtitle}</p>}</div>
          <button aria-label="关闭详情" onClick={onClose} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-ink"><X size={18} /></button>
        </div>
        <div className="p-6">{children}</div>
      </aside>
    </div>
  );
}

export function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid gap-1 border-b border-slate-100 py-3 sm:grid-cols-[150px_1fr]"><dt className="text-xs font-medium text-muted">{label}</dt><dd className="break-words text-sm text-ink">{children}</dd></div>;
}

export function Progress({ value }: { value: number }) {
  const tone = value >= 90 ? "bg-rose-500" : value >= 80 ? "bg-amber-500" : "bg-brand-500";
  return <div className="h-1.5 overflow-hidden rounded-full bg-slate-100"><div className={cn("h-full rounded-full transition-all", tone)} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></div>;
}

export function TableLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return <button onClick={onClick} className="group flex w-full items-center justify-between gap-2 text-left"><span className="min-w-0 flex-1">{children}</span><ChevronRight size={15} className="shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-brand-600" /></button>;
}

export function ResultNotice({ ok, children }: { ok: boolean; children: ReactNode }) {
  return <div className={cn("flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs", ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800")}>{ok ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}<span>{children}</span></div>;
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const power = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / Math.pow(1024, power)).toFixed(power === 0 ? 0 : 1)} ${units[power]}`;
}

export function formatDate(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
}

export function shortId(value?: string | null): string {
  return value ? `${value.slice(0, 8)}…${value.slice(-4)}` : "—";
}
