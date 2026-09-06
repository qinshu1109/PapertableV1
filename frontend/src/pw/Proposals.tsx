/**
 * 简报 16：提案收件箱（人侧审）。外部 agent 的产出以「提案」进入系统，
 * 本组件是人的验收面：列表 → 详情（证据/检查/风险/基准版本）→ 接受/退修/否决。
 * 纪律：提交是 agent 通道（POST /api/pw/proposals），本组件不提供创建入口；
 * 「询问此提案」（onAsk）只在内容车道由协作台注入——AI 仍是附属检查器，不是裁决者。
 */
import { useMemo, useState } from 'react';
import {
  pwApi,
  type PwProposal,
  type PwProposalLane,
  type PwProposalReviewAction,
} from '../lib/api';
import { useStore } from '../store';
import { fmtTime, useAsync } from './hooks';
import { PwModal } from './ui';

/** 待人处理的状态（changes_requested = 被打回过，重提后又回到 submitted） */
const PENDING_STATUSES = new Set(['submitted', 'in_review', 'changes_requested']);

const STATUS_LABEL: Record<string, string> = {
  submitted: '待审',
  in_review: '审阅中',
  changes_requested: '已退修',
  rejected: '已否决',
  accepted: '已接受',
  applied: '已应用',
  verified: '已验证',
  rolled_back: '已冲正',
  expired: '已过期',
};

export function ProposalInbox({
  lane,
  epoch,
  onChanged,
  onAsk,
}: {
  lane: PwProposalLane;
  epoch: number;
  onChanged: () => void;
  onAsk?: (p: PwProposal) => void;
}) {
  const state = useAsync(() => pwApi.proposalsList(lane), [epoch, lane]);
  const [openId, setOpenId] = useState<string | null>(null);

  const pending = useMemo(
    () => (state.data?.proposals ?? []).filter((p) => PENDING_STATUSES.has(p.status)),
    [state.data],
  );
  const open = pending.find((p) => p.id === openId) ?? null;

  if (state.loading) return null;
  if (state.error) {
    return <div className="pw-prop-error">提案接口出错：{state.error}</div>;
  }
  if (pending.length === 0) return null;

  return (
    <section className="pw-prop" aria-label={lane === 'content' ? '内容提案' : '运维提案'}>
      <div className="pw-prop-head">
        <span className="pw-prop-title">
          待验收提案 <b>{pending.length}</b>
        </span>
        <span className="pw-prop-sub">外部 agent 的产出从这进——证据摆这，接受/退修/否决是你点</span>
      </div>
      <div className="pw-prop-list">
        {pending.map((p) => (
          <button key={p.id} type="button" className="pw-prop-card" onClick={() => setOpenId(p.id)}>
            <span className="pw-prop-card-title">{p.title}</span>
            <span className="pw-prop-card-meta">
              {p.proposedBy} · {p.targetKind} · {fmtTime(p.createdAt)}
              {p.checks && p.checks.length > 0 && ` · 检查×${p.checks.length}`}
            </span>
            {p.status === 'changes_requested' && (
              <span className="pw-prop-card-flag">退修后重提{p.reviewNote ? `：${p.reviewNote}` : ''}</span>
            )}
          </button>
        ))}
      </div>
      {open && (
        <ProposalDetail
          proposal={open}
          onAsk={onAsk}
          onClose={() => setOpenId(null)}
          onDone={() => {
            setOpenId(null);
            state.reload();
            onChanged();
          }}
        />
      )}
    </section>
  );
}

function ProposalDetail({
  proposal: p,
  onAsk,
  onClose,
  onDone,
}: {
  proposal: PwProposal;
  onAsk?: (p: PwProposal) => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const { showToast } = useStore();
  const [noteAction, setNoteAction] = useState<Extract<PwProposalReviewAction, 'reject' | 'request_changes'> | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const act = async (action: PwProposalReviewAction, reviewNote?: string) => {
    setBusy(true);
    try {
      await pwApi.proposalReview(p.id, action, reviewNote);
      showToast({ text: action === 'accept' ? '已接受' : action === 'reject' ? '已否决' : '已退修' });
      onDone();
    } catch (e) {
      showToast({ text: e instanceof Error ? e.message : String(e) });
      setBusy(false);
    }
  };

  return (
    <PwModal
      title={p.title}
      sub={`${p.proposedBy} 提交 · ${STATUS_LABEL[p.status] ?? p.status} · ${fmtTime(p.createdAt)}`}
      onClose={onClose}
    >
      <div className="pw-prop-detail">
        {p.briefRef && <p className="pw-prop-row"><b>任务简报</b>{p.briefRef}</p>}
        {p.baseVersion && <p className="pw-prop-row"><b>基准版本</b>{p.baseVersion}（批准后基准变了要重审）</p>}
        {p.risk && <p className="pw-prop-row"><b>影响与可逆性</b>{p.risk}</p>}
        {p.requestedAction && <p className="pw-prop-row"><b>要求你决定</b>{p.requestedAction}</p>}

        {p.evidence && (
          <div className="pw-prop-ev">
            {p.evidence.for && p.evidence.for.length > 0 && (
              <p><b>支持证据</b>{p.evidence.for.join('；')}</p>
            )}
            {p.evidence.against && p.evidence.against.length > 0 && (
              <p><b>反证</b>{p.evidence.against.join('；')}</p>
            )}
            {p.evidence.unknowns && p.evidence.unknowns.length > 0 && (
              <p><b>未知</b>{p.evidence.unknowns.join('；')}</p>
            )}
          </div>
        )}

        {p.checks && p.checks.length > 0 && (
          <div className="pw-prop-checks">
            <b>自动检查</b>
            {p.checks.map((c, i) => (
              <p key={i}>
                {c.name}：{c.result ?? '—'}
                {c.source ? `（来源 ${c.source}）` : ''}
              </p>
            ))}
          </div>
        )}

        {p.payload && (
          <details className="pw-prop-payload">
            <summary>提案正文（payload）</summary>
            <pre>{JSON.stringify(p.payload, null, 2)}</pre>
          </details>
        )}

        <div className="pw-prop-actions">
          <button type="button" className="pw-btn primary" disabled={busy} onClick={() => void act('accept')}>
            接受
          </button>
          <button type="button" className="pw-btn" disabled={busy} onClick={() => setNoteAction('request_changes')}>
            退修
          </button>
          <button type="button" className="pw-btn" disabled={busy} onClick={() => setNoteAction('reject')}>
            否决
          </button>
          {onAsk && (
            <button type="button" className="pw-btn" onClick={() => onAsk(p)}>
              询问此提案
            </button>
          )}
        </div>

        {noteAction && (
          <div className="pw-prop-note">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={noteAction === 'reject' ? '否决理由（会留在提案上）' : '要改什么（提交方按这个修）'}
              rows={3}
            />
            <div className="pw-prop-note-actions">
              <button
                type="button"
                className="pw-btn primary"
                disabled={busy || !note.trim()}
                onClick={() => void act(noteAction, note.trim())}
              >
                确认{noteAction === 'reject' ? '否决' : '退修'}
              </button>
              <button type="button" className="pw-btn" onClick={() => setNoteAction(null)}>
                取消
              </button>
            </div>
          </div>
        )}
      </div>
    </PwModal>
  );
}
