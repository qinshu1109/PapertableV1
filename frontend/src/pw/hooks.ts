/**
 * 镇纸区轻量数据 hooks 与格式化助手（不碰探索区 store）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PwBet } from '../lib/api';

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** 拉取一次远端数据；deps 变化或 reload 时重取。 */
export function useAsync<T>(fn: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fnRef.current().then(
      (d) => {
        if (!alive) return;
        setData(d);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);
  return { data, error, loading, reload };
}

/** ISO 时间 → YYYY-MM-DD */
export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.slice(0, 10);
}

/** ISO 时间 → MM-DD HH:mm */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace('T', ' ');
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 距某日（YYYY-MM-DD）的天数：正数未来，0 今天，负数已过期。 */
export function daysUntil(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(`${dateStr.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

export function daysText(dateStr: string | null | undefined): string {
  const d = daysUntil(dateStr);
  if (d === null) return '';
  if (d > 0) return `还有 ${d} 天`;
  if (d === 0) return '今天结账';
  return `已超期 ${-d} 天`;
}

/** 押注台编号：按创建时间排序（与后端列表一致）从 1 编号 → BET-01。 */
export function betNoMap(bets: readonly PwBet[]): Map<string, string> {
  const map = new Map<string, string>();
  bets.forEach((b, i) => map.set(b.id, `BET-${String(i + 1).padStart(2, '0')}`));
  return map;
}

/** 解析 metrics_json（容错），返回 [键, 值] 对。 */
export function parseMetrics(metricsJson: string): Array<[string, string]> {
  try {
    const obj = JSON.parse(metricsJson) as Record<string, unknown>;
    return Object.entries(obj).map(([k, v]) => [k, typeof v === 'number' ? v.toLocaleString() : String(v)]);
  } catch {
    return [];
  }
}
