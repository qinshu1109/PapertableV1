/**
 * 简报 16：第九屏「运维」（agent 运行与系统维护线，与内容决策分开）：
 * 系统视角对账（mode-bar 明细）+ 运维提案收件箱 + 最近动态。
 * 纪律：本屏只有「审提案」这一个写动作（人点）；其余全只读。
 * 外部 agent 窗口的实时状态不在本系统内，本屏不假装知道。
 */
import { pwApi } from '../lib/api';
import { fmtTime, useAsync } from './hooks';
import { ProposalInbox } from './Proposals';

const RUN_KIND_LABEL: Record<string, string> = {
  manual_event: '手动记录',
  sieve: '筛子',
  ai_draft: 'AI 起草',
  ai_auto: '自动任务',
  pt_chain_export: '链导出',
  collab: '对话',
  exec: '执行',
};

export function Ops({ epoch, onChanged }: { epoch: number; onChanged: () => void }) {
  const mb = useAsync(() => pwApi.modeBar(), [epoch]);

  return (
    <div className="pw-page">
      <div className="pw-page-inner">
        <div className="pw-page-head">
          <h1>运维</h1>
          <span className="sub">系统维护线：agent 干了什么、有什么等你验收 · 与内容决策分开</span>
        </div>

        {mb.data && (
          <div className="pw-ops-mode">
            <span>
              待你判断 <b>{mb.data.pendingReview.total}</b>
              （押注草稿 {mb.data.pendingReview.betDrafts} · 结账草案 {mb.data.pendingReview.settleDrafts}
              · 语料 {mb.data.pendingReview.corpusProposed} · 提案 {mb.data.pendingReview.proposals}）
            </span>
            <span>上次动态 {mb.data.lastActivityAt ? fmtTime(mb.data.lastActivityAt) : '—'}</span>
            <span className="pw-ops-discipline">{mb.data.writeDiscipline}</span>
          </div>
        )}

        <ProposalInbox lane="ops" epoch={epoch} onChanged={onChanged} />

        <h2 className="pw-ops-h2">最近动态</h2>
        {mb.data && mb.data.recentRuns.length === 0 && (
          <p className="pw-ops-empty">还没有动态记录。</p>
        )}
        {mb.data && mb.data.recentRuns.length > 0 && (
          <table className="pw-rl-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>类型</th>
                <th>事件</th>
                <th>押注</th>
              </tr>
            </thead>
            <tbody>
              {mb.data.recentRuns.map((r, i) => (
                <tr key={i}>
                  <td className="pw-rl-num">{fmtTime(r.createdAt)}</td>
                  <td>{RUN_KIND_LABEL[r.kind] ?? r.kind}</td>
                  <td>{r.eventType}</td>
                  <td className="pw-rl-uid">{r.betId ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
