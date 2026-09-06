/**
 * 共享 hooks 与小部件。
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { pwStore, type PwUiState } from "./state.ts";

export function useUi(): PwUiState {
  return useSyncExternalStore(pwStore.subscribe, pwStore.get, pwStore.get);
}

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

export function useAsync<T>(fn: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fn().then(
      (d) => {
        if (alive) {
          setData(d);
          setLoading(false);
        }
      },
      (e: unknown) => {
        if (alive) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, loading, reload };
}

export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function Err({ msg }: { msg: string }): React.ReactNode {
  return <div className="pwx-err">连不上镇纸:{msg}(确认 4317 与插件 host 都在跑)</div>;
}

export function Blank({ text }: { text: string }): React.ReactNode {
  return <div className="pwx-blank">{text}</div>;
}

export function Loading(): React.ReactNode {
  return <div className="pwx-blank">读取中…</div>;
}
