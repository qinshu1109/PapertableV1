/**
 * TASK-PW-12（简报 12）：笔记召回事件账本（只读统计页）。
 * 回答一个问题：笔记被判/被捞之后到底谁用过——先分清「没叫货」（没召回机会）
 * 还是「叫了没人用」（召回断环）。数据全部来自 pw_recall_events，本页只读不写。
 *
 * 口径：摆出 = 系统把笔记摆到人面前（AI 只能记这档）；确认/拒绝/挂接/用上/结账
 * 全部来自人的动作。used 一期没有现成入口，恒 0，展示口径里保留位子。
 */
import { useState } from 'react';
import {
  pwApi,
  type PwRecallEventKind,
  type PwRecallSurface,
} from '../lib/api';
import { fmtTime, useAsync } from './hooks';

const KIND_LABELS: Array<[PwRecallEventKind, string]> = [
  ['surfaced', '摆出'],
  ['confirmed', '确认'],
  ['rejected', '拒绝'],
  ['attached', '挂接'],
  ['used', '用上'],
  ['settled', '结账'],
];

const SURFACE_LABELS: Array<[PwRecallSurface, string]> = [
  ['echo', '收工回响'],
  ['miner', '捞料候选'],
  ['note_tree', '笔记树'],
  ['verdict', '结账'],
];

const DAY_OPTIONS = [7, 30, 90] as const;

/** 漏斗只取「正向」五档：摆出→确认→挂接→用上→结账（拒绝是出口不进漏斗）。 */
const FUNNEL_KINDS: PwRecallEventKind[] = ['surfaced', 'confirmed', 'attached', 'used', 'settled'];

export function RecallLedgerTab({ epoch }: { epoch: number }) {
  const [days, setDays] = useState<number>(30);
  const summary = useAsync(() => pwApi.recallEventsSummary(days), [epoch, days]);
  const recent = useAsync(() => pwApi.recallEvents(50, 0), [epoch]);

  const s = summary.data;

  return (
    <section className="pw-rl" aria-label="召回账本">
      <div className="pw-rl-head">
        <p className="pw-rl-sub">
          笔记被摆出来几次、人认了几次、用进成品几次——分不清 0.2% 是「没叫货」还是「叫了没人用」，先看这本账。
        </p>
        <div className="pw-rl-days" role="tablist" aria-label="统计范围">
          {DAY_OPTIONS.map((d) => (
            <button
              key={d}
              type="button"
              role="tab"
              aria-selected={days === d}
              className={`pw-nb-tab${days === d ? ' on' : ''}`}
              onClick={() => setDays(d)}
            >
              近 {d} 天
            </button>
          ))}
        </div>
      </div>

      {summary.loading && <p className="pw-rl-empty">加载中…</p>}
      {summary.error && <p className="pw-rl-empty">账本接口出错：{summary.error}</p>}

      {s && (
        <>
          {/* 漏斗：摆出 → 确认 → 挂接 → 用上 → 结账 */}
          <div className="pw-rl-funnel">
            {FUNNEL_KINDS.map((kind, i) => {
              const n = s.totals[kind] ?? 0;
              const prev = i > 0 ? s.totals[FUNNEL_KINDS[i - 1]] ?? 0 : 0;
              const rate = i > 0 && prev > 0 ? Math.round((n / prev) * 100) : null;
              const label = KIND_LABELS.find(([k]) => k === kind)?.[1] ?? kind;
              return (
                <div key={kind} className="pw-rl-funnel-step">
                  {i > 0 && (
                    <span className="pw-rl-funnel-arrow">
                      →{rate !== null && <em>{rate}%</em>}
                    </span>
                  )}
                  <b>{n}</b>
                  <span>{label}</span>
                </div>
              );
            })}
          </div>

          <p className="pw-rl-distinct">
            近 {s.days} 天被摆出的不同笔记 <b>{s.distinctNotesSurfaced}</b> 条，人确认过 <b>{s.distinctNotesConfirmed}</b> 条。
          </p>

          {/* 分通道明细 */}
          <table className="pw-rl-table">
            <thead>
              <tr>
                <th>通道</th>
                {KIND_LABELS.map(([kind, label]) => (
                  <th key={kind}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SURFACE_LABELS.map(([surface, label]) => (
                <tr key={surface}>
                  <td>{label}</td>
                  {KIND_LABELS.map(([kind]) => (
                    <td key={kind} className="pw-rl-num">
                      {s.bySurface[surface]?.[kind] ?? 0}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>

          {/* 按天：摆出 vs 确认（纯 CSS 柱） */}
          {s.byDay.length > 0 && (
            <div className="pw-rl-days-chart" aria-label="按天摆出与确认">
              {s.byDay.map((d) => {
                const max = Math.max(1, ...s.byDay.map((x) => x.surfaced));
                return (
                  <div key={d.date} className="pw-rl-day" title={`${d.date}：摆出 ${d.surfaced}，确认 ${d.confirmed}`}>
                    <div className="pw-rl-day-bars">
                      <i className="pw-rl-bar surfaced" style={{ height: `${(d.surfaced / max) * 100}%` }} />
                      <i className="pw-rl-bar confirmed" style={{ height: `${(d.confirmed / max) * 100}%` }} />
                    </div>
                    <span>{d.date.slice(5)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* 最近事件流水 */}
      <h2 className="pw-rl-h2">最近事件</h2>
      {recent.loading && <p className="pw-rl-empty">加载中…</p>}
      {recent.data && recent.data.events.length === 0 && (
        <p className="pw-rl-empty">还没有事件——账从下一次摆出/确认开始记。</p>
      )}
      {recent.data && recent.data.events.length > 0 && (
        <table className="pw-rl-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>事件</th>
              <th>通道</th>
              <th>笔记</th>
              <th>押注</th>
              <th>角色</th>
            </tr>
          </thead>
          <tbody>
            {recent.data.events.map((ev) => (
              <tr key={ev.id}>
                <td className="pw-rl-num">{fmtTime(ev.createdAt)}</td>
                <td>{KIND_LABELS.find(([k]) => k === ev.eventKind)?.[1] ?? ev.eventKind}</td>
                <td>{SURFACE_LABELS.find(([sf]) => sf === ev.surface)?.[1] ?? ev.surface}</td>
                <td className="pw-rl-uid">{ev.noteUid ?? '—'}</td>
                <td className="pw-rl-uid">{ev.betId ?? '—'}</td>
                <td>{ev.role ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
