/**
 * 「项目差不多了」（TASK-PW-62）：AI 把当前项目卡组的决策链总结成一条笔记草稿，
 * 人过目/修改确认后写入 Memos（带 #决策链 标签）。摘要是 AI 草稿，写库前必须人确认；
 * 后端幂等防重，同一内容不重复建笔记。
 */
import { useEffect, useState } from 'react';
import { ScrollText } from 'lucide-react';
import { api, type PtChainSummary } from '../lib/api';
import { useStore } from '../store';
import { Shell } from './Dialogs';

type Phase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; summary: PtChainSummary }
  | { kind: 'done'; memoUrl: string; reused: boolean };

export function ChainExportDialog({ onClose }: { onClose: () => void }) {
  const { activeProjectId, showToast } = useStore();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [markdown, setMarkdown] = useState('');
  const [busy, setBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!activeProjectId) {
      setPhase({ kind: 'error', message: '先打开一个项目，再总结它的决策链。' });
      return;
    }
    api
      .chainSummary(activeProjectId)
      .then((summary) => {
        if (cancelled) return;
        setMarkdown(summary.markdown);
        setPhase({ kind: 'ready', summary });
      })
      .catch((err) => {
        if (cancelled) return;
        setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  const doExport = async () => {
    setBusy(true);
    setExportError(null);
    try {
      const res = await api.chainExport(activeProjectId, markdown);
      setPhase({ kind: 'done', memoUrl: res.memoUrl, reused: res.reused });
      showToast({ text: res.reused ? '这条决策链之前写过，没重复建' : '决策链已写进 Memos' });
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell
      title="项目差不多了 · 决策链总结"
      icon={<ScrollText size={16} color="var(--ink-2)" />}
      onClose={onClose}
      footer={
        phase.kind === 'ready' ? (
          <>
            <button className="btn" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button className="btn primary" onClick={() => void doExport()} disabled={busy || !markdown.trim()}>
              {busy ? '写入中…' : '确认写进 Memos'}
            </button>
          </>
        ) : (
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        )
      }
    >
      {phase.kind === 'loading' && <p className="modal-hint">AI 正在把这个卡组的问题、分叉和判决读一遍…</p>}
      {phase.kind === 'error' && <p className="modal-hint">{phase.message}</p>}
      {phase.kind === 'ready' && (
        <>
          <p className="modal-hint">
            「{phase.summary.projectName}」：金子 ×{phase.summary.golds.length} · 墓碑 ×
            {phase.summary.tombstones.length}。下面是 AI 起草的笔记，改完再确认——写进 Memos 后带
            #决策链 标签，以后能被捞回来用。
          </p>
          <textarea
            className="chain-export-md"
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            rows={16}
            spellCheck={false}
          />
          {exportError && <p className="modal-hint error">{exportError}</p>}
        </>
      )}
      {phase.kind === 'done' && (
        <p className="modal-hint">
          {phase.reused ? '同样内容的决策链之前写过，没有重复建。' : '写好了。'}{' '}
          <a href={phase.memoUrl} target="_blank" rel="noreferrer">
            在 Memos 里打开 ↗
          </a>
        </p>
      )}
    </Shell>
  );
}
