/**
 * 首页（对应设计稿 papertable-index.html）：hero + 导航大卡 + 创作闭环六节点。
 * 卡状态文案来自真实数据：/api/pw/bets、/due、/verdicts；
 * 闭环当前节点规则同押注台（以第一个 pending 押注计，无则回落第一注）。
 */
import { useMemo } from 'react';
import { pwApi } from '../lib/api';
import { betNoMap, useAsync } from './hooks';

/** 与大盘一致的写死目标：跑通 10 期实验 */
const GOAL_TOTAL = 10;

const LOOP_NODES = ['起心动念', '想清楚', '押注', '开干', '数据回流', '结账'];

export function Home({
  epoch,
  onNav,
}: {
  epoch: number;
  onNav: (s: 'workbench' | 'vault' | 'collab' | 'voice' | 'sources' | 'dashboard') => void;
}) {
  const betsState = useAsync(() => pwApi.listBets(), [epoch]);
  const dueState = useAsync(() => pwApi.dueBets(), [epoch]);
  const verdictsState = useAsync(() => pwApi.listVerdicts(), [epoch]);
  const connectionsState = useAsync(() => pwApi.listConnections(), [epoch]);
  const queueState = useAsync(() => pwApi.pendingQueue(), [epoch]);

  const bets = useMemo(() => betsState.data?.bets ?? [], [betsState.data]);
  const liveBets = useMemo(() => bets.filter((b) => b.status !== 'draft'), [bets]);
  const noMap = useMemo(() => betNoMap(bets), [bets]);
  const dueIds = useMemo(() => new Set((dueState.data?.bets ?? []).map((b) => b.id)), [dueState.data]);
  const verdicts = useMemo(() => verdictsState.data?.verdicts ?? [], [verdictsState.data]);
  const connections = useMemo(() => connectionsState.data?.connections ?? [], [connectionsState.data]);

  const firstPending = liveBets.find((b) => b.status === 'pending') ?? null;
  // 闭环当前节点推导与押注台同一口径：第一个 pending，无则回落第一注
  const focus = firstPending ?? liveBets[0] ?? null;
  const focusDocsState = useAsync(
    () =>
      focus && focus.status === 'pending'
        ? pwApi.listDataDocs(focus.id)
        : Promise.resolve(null),
    [focus?.id, focus?.status, epoch],
  );

  // 大卡状态文案
  const wbStatus = firstPending
    ? `${noMap.get(firstPending.id)} · ${dueIds.has(firstPending.id) ? '到期未结账' : '验证中'}`
    : '暂无押注';
  const goldCount = verdicts.filter((v) => v.outcome === 'gold').length;
  const tombCount = verdicts.filter((v) => v.outcome === 'tomb').length;
  const vaultStatus = `${goldCount} 金 · ${tombCount} 碑`;
  const doneCount = verdicts.filter((v) => v.outcome !== 'void').length;
  const pct = Math.min(100, Math.round((doneCount / GOAL_TOTAL) * 100));
  const dashStatus = `目标进度 ${pct}%`;
  // 数据源卡状态：无连接「未连接」/ active「已连接」/ needs_human「N 条待人工处理」
  const needsHumanCount = connections.filter((c) => c.status === 'needs_human').length;
  const srcStatus =
    needsHumanCount > 0 ? `${needsHumanCount} 条待人工处理`
    : connections.length === 0 ? '未连接'
    : '已连接';
  const srcStatusClass = needsHumanCount > 0 ? ' warn' : connections.length > 0 ? ' ok' : '';
  // 协作台卡状态：待确认队列总数（>0 警示，=0 已开通）
  const queue = queueState.data;
  const pendingTotal = queue
    ? queue.betDrafts.length + queue.settleDrafts.length + queue.corpusProposed.length
    : 0;
  const collabStatus = pendingTotal > 0 ? `${pendingTotal} 项待你确认` : '已开通';
  const collabStatusClass = pendingTotal > 0 ? ' warn' : ' ok';

  // 闭环当前节点：settled/到期 → 06；pending 有数据文档 → 05；pending 无 → 04
  let current: number | null = null;
  if (focus) {
    if (focus.status === 'settled' || dueIds.has(focus.id)) current = 6;
    else if (focus.status === 'pending') {
      current = (focusDocsState.data?.docs.length ?? 0) > 0 ? 5 : 4;
    }
  }

  return (
    <div className="pw-home">
      <div className="pw-home-inner">
        <div className="pw-hero">
          <h1>镇纸 Paperweight</h1>
          <p>Papertable 把纸摊开让你想，镇纸把纸压住让你定。</p>
        </div>
        <div className="pw-cards">
          <button type="button" className="pw-nav-card" onClick={() => onNav('workbench')}>
            <div className="pw-nc-head">
              <h2>
                <span className="pw-nc-icon">🎯</span>押注台
              </h2>
              <span className={`pw-nc-status${firstPending ? ' ok' : ''}`}>{wbStatus}</span>
            </div>
            <p>一张押注卡的驾驶舱：我赌了什么、干到哪了、圈转到哪了。</p>
          </button>
          <button type="button" className="pw-nav-card" onClick={() => onNav('vault')}>
            <div className="pw-nc-head">
              <h2>
                <span className="pw-nc-icon">🏺</span>金子墓碑库
              </h2>
              <span className="pw-nc-status">{vaultStatus}</span>
            </div>
            <p>铸下的金子、立过的碑，都进这本账：不再重复踩同一个坑。</p>
          </button>
          <button type="button" className="pw-nav-card" onClick={() => onNav('collab')}>
            <div className="pw-nc-head">
              <h2>
                <span className="pw-nc-icon">🤝</span>协作台
              </h2>
              <span className={`pw-nc-status${collabStatusClass}`}>{collabStatus}</span>
            </div>
            <p>和 AI 副驾驶讨论这一把：数据解读、起草建议，押注与结账始终由人落笔。</p>
          </button>
          <button type="button" className="pw-nav-card" onClick={() => onNav('voice')}>
            <div className="pw-nc-head">
              <h2>
                <span className="pw-nc-icon">📣</span>观众声音
              </h2>
              <span className="pw-nc-status">已开通</span>
            </div>
            <p>评论区反馈与需求的蓄水池：看上的声音一键提请进候选，语料评论一键收录。</p>
          </button>
          <button type="button" className="pw-nav-card" onClick={() => onNav('sources')}>
            <div className="pw-nc-head">
              <h2>
                <span className="pw-nc-icon">🔌</span>数据源
              </h2>
              <span className={`pw-nc-status${srcStatusClass}`}>{srcStatus}</span>
            </div>
            <p>平台连接与数据回流：低频定向同步，遇到人工环节喊你接手。</p>
          </button>
          <button type="button" className="pw-nav-card" onClick={() => onNav('dashboard')}>
            <div className="pw-nc-head">
              <h2>
                <span className="pw-nc-icon">📒</span>大盘
              </h2>
              <span className="pw-nc-status">{dashStatus}</span>
            </div>
            <p>判断力与目标的账本：周/月复盘时看，不是日常驾驶舱。</p>
          </button>
        </div>
        <div className="pw-loop-foot">
          {LOOP_NODES.map((label, i) => (
            <span key={label} style={{ display: 'contents' }}>
              <span className={`pw-lf-node${current === i + 1 ? ' pw-lf-now' : ''}`}>{label}</span>
              <span className="pw-lf-arrow" aria-hidden="true">
                {i === LOOP_NODES.length - 1 ? '↺' : '→'}
              </span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
