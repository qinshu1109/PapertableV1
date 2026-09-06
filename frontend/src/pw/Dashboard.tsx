/**
 * 大盘（PW-10，对应设计稿 papertable-dashboard.html）：
 * 目标横幅 + 数据趋势/判断力账本 + 押注组合 + 近期判决。
 * 数据：/api/pw/bets、/verdicts，以及全部押注的 /data-docs（Promise.all 合并）。
 */
import { useMemo, type ReactNode } from 'react';
import { pwApi, type PwActivityDay, type PwBet, type PwVerdict } from '../lib/api';
import { betNoMap, daysText, daysUntil, fmtDay, useAsync } from './hooks';

/** 示例目标（写死）：跑通 10 期实验 */
const GOAL_TOTAL = 10;
/** 校准曲线最少样本数 */
const CALIB_MIN = 5;

/** metrics_json 解析为数值表（容错，非数值项丢弃） */
/* 简报21：双账格式化——null 显示 —，比率按百分比 */
function pctText(v: number | null): string {
  return v === null ? '—' : `${Math.round(v * 100)}%`;
}
function numText(v: number | null, suffix: string): string {
  return v === null ? '—' : `${v}${suffix}`;
}

function metricsMap(metricsJson: string): Record<string, number> {
  try {
    const obj = JSON.parse(metricsJson) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function Dashboard({ epoch }: { epoch: number }) {
  const betsState = useAsync(() => pwApi.listBets(), [epoch]);
  const verdictsState = useAsync(() => pwApi.listVerdicts(), [epoch]);

  const bets = useMemo(() => betsState.data?.bets ?? [], [betsState.data]);
  // 押注组合只列非 draft、非作废押注（作废不进判断账）
  const liveBets = useMemo(() => bets.filter((b) => b.status !== 'draft' && b.status !== 'void'), [bets]);
  const verdicts = useMemo(() => verdictsState.data?.verdicts ?? [], [verdictsState.data]);
  const noMap = useMemo(() => betNoMap(bets), [bets]);
  const dueState = useAsync(() => pwApi.dueBets(), [epoch]);
  const dueIds = useMemo(() => new Set((dueState.data?.bets ?? []).map((b) => b.id)), [dueState.data]);
  // TASK-PW-55：动作流水（校准样本不足时的顶替图数据）
  const activityState = useAsync(() => pwApi.activityDaily(7), [epoch]);

  // 全部押注的数据文档：逐个 listDataDocs 合并（趋势图与平台小卡共用）
  const docsState = useAsync(
    () =>
      liveBets.length === 0
        ? Promise.resolve([])
        : Promise.all(liveBets.map((b) => pwApi.listDataDocs(b.id))).then((rs) =>
            rs.flatMap((r, i) =>
              r.docs.map((d) => ({ betId: liveBets[i].id, doc: d, m: metricsMap(d.metrics_json) })),
            ),
          ),
    [liveBets, epoch],
  );
  const allDocs = useMemo(() => docsState.data ?? [], [docsState.data]);

  const nonVoid = verdicts.filter((v) => v.outcome !== 'void');
  const goldCount = verdicts.filter((v) => v.outcome === 'gold').length;
  const tombCount = verdicts.filter((v) => v.outcome === 'tomb').length;
  const liveCount = liveBets.filter((b) => b.status === 'pending').length;
  const doneCount = nonVoid.length;
  const pct = Math.min(100, Math.round((doneCount / GOAL_TOTAL) * 100));

  // 最早一个 pending 的结账日
  const nextCheckout = liveBets
    .filter((b) => b.status === 'pending' && b.checkout_date)
    .map((b) => b.checkout_date as string)
    .sort()[0];
  const checkoutDays = daysUntil(nextCheckout);
  const checkoutText =
    nextCheckout && checkoutDays !== null
      ? checkoutDays > 0
        ? ` · 距离结账日（${fmtDay(nextCheckout)}）还有 ${checkoutDays} 天`
        : checkoutDays === 0
          ? ` · 距离结账日（${fmtDay(nextCheckout)}）今天结账`
          : ` · 距离结账日（${fmtDay(nextCheckout)}）已超期 ${-checkoutDays} 天`
      : '';

  // TASK-PW-55：趋势按押注分组——同一押注 ≥2 期「播放」数据文档才成一条线（跨押注连线无业务意义）
  const trendSeries = useMemo(() => {
    const byBet = new Map<string, Array<{ collected_at: string; play: number; like?: number }>>();
    for (const x of allDocs) {
      if (typeof x.m['播放'] !== 'number') continue;
      const arr = byBet.get(x.betId) ?? [];
      arr.push({
        collected_at: x.doc.collected_at,
        play: x.m['播放'],
        like: typeof x.m['点赞'] === 'number' ? x.m['点赞'] : undefined,
      });
      byBet.set(x.betId, arr);
    }
    const out = [...byBet.entries()]
      .map(([betId, pts]) => ({
        betId,
        label: noMap.get(betId) ?? '—',
        points: pts.sort((a, b) => a.collected_at.localeCompare(b.collected_at)),
      }))
      .filter((s) => s.points.length >= 2)
      .sort((a, b) =>
        b.points[b.points.length - 1].collected_at.localeCompare(
          a.points[a.points.length - 1].collected_at,
        ),
      );
    return { shown: out.slice(0, 4), overflow: Math.max(0, out.length - 4) };
  }, [allDocs, noMap]);

  // TASK-PW-55：无分组趋势可画时的顶替图——在途押注结账倒计时（checkout 升序）
  const countdown = useMemo(
    () =>
      liveBets
        .filter((b) => b.status === 'pending' && b.checkout_date)
        .sort((a, b) => (a.checkout_date as string).localeCompare(b.checkout_date as string)),
    [liveBets],
  );
  // 各押注是否有数据文档（押注组合卡「数据回流中」判定）
  const betHasDocs = useMemo(() => new Set(allDocs.map((x) => x.betId)), [allDocs]);

  // 简报21·第一期：双账（认识论成绩 / 运行可靠性）
  const healthState = useAsync(() => pwApi.healthAccounts(), [epoch]);
  const health = healthState.data ?? null;

  const recent = useMemo(
    () => nonVoid.sort((a, b) => b.decided_at.localeCompare(a.decided_at)).slice(0, 8),
    [nonVoid],
  );

  // 校准样本：非作废且当时标了置信度的结账
  const samples = nonVoid.filter((v) => v.confidence_snapshot !== null);

  return (
    <div className="pw-page">
      <div className="pw-page-inner">
        <div className="pw-page-head">
          <h1>大盘</h1>
          <span className="sub">判断力与目标的账本 · <b>周/月复盘时看</b>，不是日常驾驶舱</span>
        </div>

        {/* 第一行：当前目标横幅 */}
        <section className="pw-goal-banner">
          <div className="pw-goal-text">
            <div className="pw-goal-kicker">当前目标 · Q3</div>
            <h2>跑通 10 期实验，形成可复用的选题方法</h2>
            <p>
              已完成 <b>{doneCount} 期</b> · 押注中 <b>{liveCount} 期</b>
              {checkoutText}
            </p>
          </div>
          <div className="pw-goal-progress">
            <div className="pw-gp-label">
              <span>整体进度</span>
              <b>{pct}%</b>
            </div>
            <div className="pw-gp-track">
              <div className="pw-gp-fill" style={{ width: `${pct}%` }} />
            </div>
          </div>
        </section>

        {/* 简报21：双账——认识论成绩只计有效结账；运行可靠性单独记账，互不污染 */}
        <section className="pw-panel pw-health">
          <div className="pw-panel-head">
            <h2>双账 · 判断成绩与运行健康</h2>
            <span className="hint">作废不污染判断力，但也不从运行账上消失</span>
          </div>
          {healthState.error && <div className="pw-err">{healthState.error}</div>}
          {!healthState.error && !health && <div className="pw-blank">双账加载中…</div>}
          {health && (
            <div className="pw-health-grid">
              <div className="pw-health-col">
                <div className="pw-health-kicker">认识论账（只计有效结账）</div>
                <div className="pw-health-big">{health.epistemic.validSettlements ?? '—'}</div>
                <div className="pw-health-sub">有效结账（金子+墓碑）</div>
              </div>
              <div className="pw-health-col">
                <div className="pw-health-kicker">运行账（闭环可不可靠）</div>
                <dl className="pw-health-rows">
                  <div><dt>到期可结率</dt><dd>{pctText(health.operational.dueReadyRate)}</dd></div>
                  <div><dt>有效结账率</dt><dd>{pctText(health.operational.validSettlementRate)}</dd></div>
                  <div><dt>平均结账延迟</dt><dd>{numText(health.operational.avgSettleLatencyDays, ' 天')}</dd></div>
                  <div><dt>结账债务</dt><dd>{numText(health.operational.settleDebtDays, ' 天')}</dd></div>
                  <div><dt>可避免作废率</dt><dd>{pctText(health.operational.avoidableVoidRate)}</dd></div>
                  <div><dt>自动供血成功率</dt><dd>{pctText(health.operational.autoFeedSuccessRate)}</dd></div>
                  <div>
                    <dt>同因作废复发</dt>
                    <dd>{health.operational.recurringVoidCauses.length > 0
                      ? health.operational.recurringVoidCauses
                          .map((c) => `${c.cause}×${c.count}`)
                          .join('；')
                      : '无'}</dd>
                  </div>
                </dl>
              </div>
            </div>
          )}
        </section>

        {/* 第二行：数据趋势 + 判断力账本 */}
        <div className="pw-row">
          <section className="pw-col-trend pw-panel">
            <div className="pw-panel-head">
              <h3>{trendSeries.shown.length > 0 ? '数据趋势' : '结账倒计时'}</h3>
              <span className="note">
                {trendSeries.shown.length > 0
                  ? '同一押注一条线 · 两期起画'
                  : '在途押注的结账日横杠 · 同一押注回流两期数据后换成播放趋势'}
              </span>
            </div>
            {trendSeries.shown.length > 0 ? (
              <>
                <GroupedTrendChart series={trendSeries.shown} />
                <div className="pw-legend">
                  {trendSeries.shown.map((s, i) => (
                    <span key={s.betId}>
                      <i className="pw-sw" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
                      {s.label}（播放{seriesNote(s)}）
                    </span>
                  ))}
                  {trendSeries.overflow > 0 && (
                    <span style={{ marginLeft: 'auto' }}>另有 {trendSeries.overflow} 组未画</span>
                  )}
                </div>
              </>
            ) : countdown.length > 0 ? (
              <CountdownChart bets={countdown} noMap={noMap} />
            ) : (
              <div className="pw-blank">没有在途押注，没账可倒。</div>
            )}
            <div className="pw-plat-row">
              <PlatMini name="B站" unit="播放" docs={allDocs} icon={<PlatIconBili />} />
              <PlatMini name="小红书" unit="阅读" docs={allDocs} icon={<PlatIconRed />} />
              <PlatMini name="抖音" unit="播放" docs={allDocs} icon={<PlatIconDouyin />} />
            </div>
          </section>

          <section className="pw-col-ledger pw-panel">
            <div className="pw-panel-head">
              <h3>判断力账本</h3>
              <span className="note">我说的，和实际发生的</span>
            </div>
            <div className="pw-ledger-nums">
              <div className="pw-ln gold"><b>{goldCount}</b><span>金子</span></div>
              <div className="pw-ln"><b>{tombCount}</b><span>墓碑</span></div>
              <div className="pw-ln"><b>{liveCount}</b><span>押注中</span></div>
            </div>
            <div className="pw-calib">
              {samples.length >= CALIB_MIN ? (
                <>
                  <CalibrationChart samples={samples} />
                  <div className="pw-calib-cap">
                    <em>{samples.length} 次结账</em> · 10 档分桶：宣称把握 vs 实际命中率
                  </div>
                </>
              ) : (
                <>
                  <ActivityChart days={activityState.data?.days ?? []} />
                  <div className="pw-calib-cap">
                    你/AI/系统最近 7 天动作流水 · 再 <em>{CALIB_MIN - samples.length} 次带把握的结账</em>后，这里换成校准线
                  </div>
                </>
              )}
            </div>
          </section>
        </div>

        {/* 第三行：押注组合 */}
        <div className="pw-sec-title">押注组合 · 全部 {liveBets.length} 注</div>
        <section className="pw-bets">
          {liveBets.map((b) => {
            const v = nonVoid.find((x) => x.bet_id === b.id);
            const outcome = v?.outcome === 'gold' || v?.outcome === 'tomb' ? v.outcome : null;
            const { cls, text } = betStatusOf(b, outcome, dueIds.has(b.id), betHasDocs.has(b.id));
            return (
              <article key={b.id} className="pw-bet-card">
                <div className="pw-bc-id">{noMap.get(b.id)}</div>
                <span className={`pw-bet-status ${cls}`}><i />{text}</span>
                <h4>{b.title}</h4>
                <div className="pw-bc-metric">
                  验证指标：{b.metric ?? '—'}
                  {b.metric_target ? ` · 目标 ${b.metric_target}` : ''}
                  {b.checkout_date ? ` · ${daysText(b.checkout_date)}` : ''}
                </div>
              </article>
            );
          })}
        </section>

        {/* 第四行：近期判决 */}
        <div className="pw-sec-title">近期判决 · 进判决簿的判断</div>
        <section className="pw-panel" style={{ padding: '8px 22px' }}>
          {recent.length === 0 && !verdictsState.loading && (
            <div className="pw-blank">还没有判决。押注到期结账后，金子和墓碑进这里。</div>
          )}
          <div className="pw-judges">
            {recent.map((v) => (
              <div key={v.id} className="pw-judge-row">
                <span
                  className={`pw-judge-ico ${v.outcome === 'gold' ? 'pw-ji-gold' : 'pw-ji-tomb'}`}
                  aria-hidden="true"
                >
                  {v.outcome === 'gold' ? <GoldIcon /> : <TombIcon />}
                </span>
                <div className="pw-judge-main">
                  <p>{v.outcome === 'gold' ? v.lesson : v.cause_of_death}</p>
                  <div className="pw-jm-sub">
                    {v.outcome === 'gold' ? '金子' : '墓碑'} · 结账于 {fmtDay(v.decided_at)} · 源自{' '}
                    {noMap.get(v.bet_id) ?? '—'}
                  </div>
                </div>
                {v.confidence_snapshot !== null && (
                  <span className="pw-judge-cite">当时把握 <b>{v.confidence_snapshot}%</b></span>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

/* ---------- 押注组合卡的状态徽章 ---------- */
function betStatusOf(
  bet: PwBet,
  outcome: 'gold' | 'tomb' | null,
  due: boolean,
  hasDocs: boolean,
): { cls: string; text: string } {
  if (bet.status === 'settled' && outcome === 'gold') return { cls: 'pw-bs-gold', text: '已结账 · 金子' };
  if (bet.status === 'settled' && outcome === 'tomb') return { cls: 'pw-bs-tomb', text: '已结账 · 墓碑' };
  if (bet.status === 'void') return { cls: 'pw-bs-tomb', text: '已作废' };
  if (bet.status === 'settled') return { cls: 'pw-bs-tomb', text: '已结账' };
  if (due) return { cls: 'pw-bs-due', text: '到期未结账' };
  return { cls: 'pw-bs-live', text: hasDocs ? '数据回流中' : '验证中' };
}

/* ---------- TASK-PW-55：分组趋势调色板与注记 ---------- */
const SERIES_COLORS = ['#2e2a24', '#3f6e5a', '#b5853c', '#7a6f5d'];

function seriesNote(s: { points: Array<{ play: number }> }): string {
  const first = s.points[0].play;
  const last = s.points[s.points.length - 1].play;
  if (last > first) return '在涨';
  if (last < first) return '在跌';
  return '持平';
}

/* ---------- TASK-PW-55：数据趋势（按押注分组，同一押注一条线，两期起画；点赞虚线只画第一组防乱） ---------- */
function GroupedTrendChart({
  series,
}: {
  series: Array<{
    betId: string;
    label: string;
    points: Array<{ collected_at: string; play: number; like?: number }>;
  }>;
}) {
  const maxLen = Math.max(...series.map((s) => s.points.length), 2);
  const maxPlay = Math.max(...series.flatMap((s) => s.points.map((p) => p.play)), 1);
  const X = (i: number) => 110 + (i * 440) / Math.max(1, maxLen - 1);
  const Y = (v: number) => 220 - (v / maxPlay) * 180;
  const polyline = (pts: Array<{ x: number; y: number }>) =>
    pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const firstLikes = series[0].points
    .map((p, i) => ({ x: X(i), v: p.like }))
    .filter((p): p is { x: number; v: number } => typeof p.v === 'number');
  const maxLike = Math.max(...firstLikes.map((p) => p.v), 1);
  return (
    <div className="pw-chart-wrap">
      <svg viewBox="0 0 640 280" role="img" aria-label="各押注播放量趋势（同一押注一条线）">
        {/* 网格线 */}
        <g stroke="#d8cdb8" strokeWidth="1" strokeDasharray="2 5">
          <line x1="70" y1="40" x2="590" y2="40" />
          <line x1="70" y1="100" x2="590" y2="100" />
          <line x1="70" y1="160" x2="590" y2="160" />
          <line x1="70" y1="220" x2="590" y2="220" />
        </g>
        {/* 第一组点赞虚线 */}
        {firstLikes.length >= 2 && (
          <polyline
            points={polyline(firstLikes.map((p) => ({ x: p.x, y: 220 - (p.v / maxLike) * 180 })))}
            fill="none"
            stroke="#99948b"
            strokeWidth="2"
            strokeDasharray="6 5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {series.map((s, si) => {
          const color = SERIES_COLORS[si % SERIES_COLORS.length];
          const pts = s.points.map((p, i) => ({ x: X(i), y: Y(p.play), v: p.play }));
          const last = pts[pts.length - 1];
          return (
            <g key={s.betId}>
              <polyline
                points={polyline(pts)}
                fill="none"
                stroke={color}
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {pts.map((p, i) => (
                <circle key={i} cx={p.x} cy={p.y} r="4.5" fill={color} />
              ))}
              <text
                x={last.x}
                y={last.y - 10}
                fontSize="12"
                fontWeight="700"
                fill={color}
                textAnchor="middle"
              >
                {s.label} · {last.v.toLocaleString()}
              </text>
            </g>
          );
        })}
        {/* 横轴：组内期序号 */}
        <g fontFamily="Noto Sans SC,system-ui,sans-serif" fontSize="13" fill="#99948b" textAnchor="middle">
          {Array.from({ length: maxLen }, (_, i) => (
            <text key={i} x={X(i)} y="252">
              第 {i + 1} 期
            </text>
          ))}
        </g>
        <line x1="70" y1="220" x2="590" y2="220" stroke="#d8cdb8" strokeWidth="1.5" />
      </svg>
    </div>
  );
}

/* ---------- TASK-PW-55：结账倒计时（7 天窗口横杠） ---------- */
function CountdownChart({ bets, noMap }: { bets: PwBet[]; noMap: Map<string, string> }) {
  const DAY = 24 * 3600 * 1000;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  return (
    <div className="pw-countdown" role="img" aria-label="在途押注结账倒计时横杠">
      {bets.map((b) => {
        const checkout = new Date(`${b.checkout_date}T00:00:00`);
        const start = checkout.getTime() - 6 * DAY;
        const elapsed = Math.min(Math.max((todayStart.getTime() - start) / (7 * DAY), 0), 1);
        const days = Math.ceil((checkout.getTime() - todayStart.getTime()) / DAY);
        const text = days > 0 ? `还有 ${days} 天` : days === 0 ? '今天结账' : `已超期 ${-days} 天`;
        return (
          <div key={b.id} className={`pw-cd-row${days < 0 ? ' over' : ''}`}>
            <span className="pw-cd-id">{noMap.get(b.id) ?? '—'}</span>
            <span className="pw-cd-title" title={b.title}>
              {b.title.length > 20 ? `${b.title.slice(0, 20)}…` : b.title}
            </span>
            <span className="pw-cd-track">
              <span className="pw-cd-fill" style={{ width: `${(elapsed * 100).toFixed(1)}%` }} />
            </span>
            <span className="pw-cd-days">{text}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ---------- TASK-PW-55：本周动作流水（7 天 × 你/AI/系统 分组迷你柱） ---------- */
function ActivityChart({ days }: { days: PwActivityDay[] }) {
  if (days.length === 0) return <div className="pw-blank">还没有动作流水。</div>;
  const max = Math.max(...days.flatMap((d) => [d.human, d.ai, d.system]), 1);
  const slotW = 235 / days.length;
  const barW = Math.min(9, slotW / 4);
  const H = (v: number) => (v / max) * 150;
  const roles = [
    { key: 'human', color: '#2e2a24', label: '你' },
    { key: 'ai', color: '#b5853c', label: 'AI' },
    { key: 'system', color: '#99948b', label: '系统' },
  ] as const;
  return (
    <svg viewBox="0 0 300 210" role="img" aria-label="最近 7 天你、AI、系统动作流水柱图">
      <line x1="45" y1="180" x2="280" y2="180" stroke="#d8cdb8" strokeWidth="1.5" />
      {days.map((d, gi) => {
        const x0 = 45 + gi * slotW + slotW / 2 - (barW * 3) / 2 - 2;
        return (
          <g key={d.day}>
            {roles.map((r, ri) => {
              const v = d[r.key];
              const h = H(v);
              const x = x0 + ri * (barW + 2);
              return (
                <g key={r.key}>
                  {v > 0 && (
                    <rect x={x} y={180 - h} width={barW} height={Math.max(h, 2)} fill={r.color} rx="1.5" />
                  )}
                  {v > 0 && (
                    <text x={x + barW / 2} y={176 - h} fontSize="8" fill="#6b6154" textAnchor="middle">
                      {v}
                    </text>
                  )}
                </g>
              );
            })}
            <text x={45 + gi * slotW + slotW / 2} y="196" fontSize="9" fill="#99948b" textAnchor="middle">
              {d.day.slice(5)}
            </text>
          </g>
        );
      })}
      {roles.map((r, i) => (
        <g key={r.key}>
          <rect x={50 + i * 46} y={6} width={8} height={8} fill={r.color} rx="1.5" />
          <text x={61 + i * 46} y={13} fontSize="9" fill="#6b6154">
            {r.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

/* ---------- 平台小卡：该平台最新一份数据文档的「播放」 ---------- */
function PlatMini({
  name,
  unit,
  docs,
  icon,
}: {
  name: string;
  unit: string;
  docs: Array<{ doc: { platform: string; collected_at: string }; m: Record<string, number> }>;
  icon: ReactNode;
}) {
  const latest = docs
    .filter((x) => x.doc.platform === name)
    .sort((a, b) => b.doc.collected_at.localeCompare(a.doc.collected_at))[0];
  const value = latest?.m['播放'];
  return (
    <div className="pw-plat-mini">
      <div className="pw-pm-top">
        {icon}
        {name}
      </div>
      <div className="pw-pm-num">
        {typeof value === 'number' ? value.toLocaleString() : '—'}
        <small>{unit}</small>
      </div>
    </div>
  );
}

/* 平台图标（照抄设计稿 SVG） */
function PlatIconBili() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="3" width="13" height="10" rx="2" stroke="#2e2a24" strokeWidth="1.2" />
      <path d="M6.5 6.2v3.6l3.2-1.8z" fill="#2e2a24" />
    </svg>
  );
}
function PlatIconRed() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.5" y="1.5" width="11" height="13" rx="2" stroke="#2e2a24" strokeWidth="1.2" />
      <path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" stroke="#2e2a24" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}
function PlatIconDouyin() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" stroke="#2e2a24" strokeWidth="1.2" />
      <path d="M6.5 5.8v4.4l3.8-2.2z" fill="#2e2a24" />
    </svg>
  );
}

/* ---------- 校准曲线（SVG 手绘风，10 档分桶） ---------- */
function CalibrationChart({ samples }: { samples: PwVerdict[] }) {
  // 10 档：0–9%、10–19% … 90–100%
  const buckets = Array.from({ length: 10 }, () => ({ confSum: 0, n: 0, gold: 0 }));
  for (const v of samples) {
    const conf = v.confidence_snapshot ?? 0;
    const idx = Math.min(9, Math.max(0, Math.floor(conf / 10)));
    buckets[idx].confSum += conf;
    buckets[idx].n += 1;
    if (v.outcome === 'gold') buckets[idx].gold += 1;
  }
  const points = buckets
    .map((b, i) => ({ i, ...b }))
    .filter((b) => b.n > 0)
    .map((b) => ({
      x: b.confSum / b.n / 100,
      y: b.gold / b.n,
      n: b.n,
    }));

  // 坐标映射（对齐设计稿 300×210 画幅）
  const X = (f: number) => 45 + f * 235;
  const Y = (f: number) => 180 - f * 158;
  const polyline = points.map((p) => `${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');

  return (
    <svg viewBox="0 0 300 210" role="img" aria-label="校准曲线：宣称把握对比实际命中率">
      {/* 坐标轴 */}
      <line x1="45" y1="180" x2="280" y2="180" stroke="#d8cdb8" strokeWidth="1.5" />
      <line x1="45" y1="180" x2="45" y2="20" stroke="#d8cdb8" strokeWidth="1.5" />
      {/* 完全校准对角线 */}
      <line x1="45" y1="180" x2="280" y2="22" stroke="#99948b" strokeWidth="1.5" strokeDasharray="5 5" />
      <text x="150" y="132" fontSize="10" fill="#99948b" textAnchor="middle">
        — 对角线 = 完全校准
      </text>
      {/* 实际折线 */}
      {points.length > 1 && (
        <polyline
          points={polyline}
          fill="none"
          stroke="#2e2a24"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {points.map((p, i) => (
        <g key={i}>
          <circle cx={X(p.x)} cy={Y(p.y)} r="5.5" fill="#fbf7ec" stroke="#2e2a24" strokeWidth="2" />
          <text
            x={X(p.x)}
            y={Y(p.y) - 10}
            fontSize="10"
            fill="#6b6154"
            textAnchor="middle"
          >
            {Math.round(p.x * 100)}%·{Math.round(p.y * 100)}%
          </text>
        </g>
      ))}
      {/* 轴标签 */}
      <text x="162" y="202" fontSize="11" fill="#99948b" textAnchor="middle">
        我说几成把握 →
      </text>
      <text x="16" y="100" fontSize="11" fill="#99948b" textAnchor="middle" transform="rotate(-90 16 100)">
        实际命中率 →
      </text>
    </svg>
  );
}

/* ---------- 判决小图标（照抄设计稿，金色用 --pw-seal-gold） ---------- */
function GoldIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" width="20" height="20">
      <circle cx="10" cy="10" r="7" style={{ stroke: 'var(--pw-seal-gold)' }} strokeWidth="1.6" />
      <circle cx="10" cy="10" r="4" style={{ stroke: 'var(--pw-seal-gold)' }} strokeWidth="1" strokeDasharray="2 2" />
      <path
        d="M10 7.2l.85 1.75 1.9.27-1.38 1.33.33 1.9L10 11.52l-1.7.93.33-1.9-1.38-1.33 1.9-.27z"
        style={{ fill: 'var(--pw-seal-gold)' }}
      />
    </svg>
  );
}

function TombIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" width="20" height="20">
      <path d="M5.5 16.5v-6a4.5 4.5 0 0 1 9 0v6z" stroke="#99948b" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M8 10.5h4" stroke="#99948b" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M3.5 16.5h13" stroke="#99948b" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
