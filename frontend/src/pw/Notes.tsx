/**
 * 第七屏「笔记」（TASK-PW-61 改造）：首屏 = 笔记大盘（定时/手动捞料看板 +
 * 候选确认流 + 单条流水账），顶部屏内标签切：大盘（默认）/ 树图（PW-60
 * 记忆钩子树原样保留）/ 全部笔记（更早的列表/热力图/标签/卷积，折叠区保持现状）。
 * 记的活在 Memos，挂枝派生数据在镇纸本地；AI 只建议、人确认才挂枝。
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  pwApi,
  type PwContentBet,
  type PwNote,
  type PwNoteDayStat,
  type PwNoteInsight,
  type PwNoteRollup,
  type PwNoteRollupKind,
  type PwNoteTagCount,
  type PwNoteTree,
} from '../lib/api';
import { MarkdownView } from '../lib/MarkdownView';
import { fmtTime, useAsync } from './hooks';
import { BoardTab } from './BoardTab';
import { RecallLedgerTab } from './RecallLedger';

const PAGE_SIZE = 20;
const TREE_PAGE = 200;

type NotesTab = 'board' | 'tree' | 'ledger' | 'legacy';

export function Notes({ epoch }: { epoch: number }) {
  const statusState = useAsync(() => pwApi.notesStatus(), [epoch]);
  const [tab, setTab] = useState<NotesTab>('board');

  const unavailable = statusState.data !== null && !statusState.data.ok;

  return (
    <div className="pw-page">
      <div className="pw-page-inner">
        <div className="pw-page-head">
          <h1>笔记</h1>
          <span className="sub">记的活在 Memos，镇纸只管看、捞、回顾 · <b>只读</b></span>
        </div>

        {unavailable && (
          <div className="pw-notes-banner" role="alert">
            连不上笔记库：{statusState.data?.error ?? '未知错误'}
          </div>
        )}

        {/* 屏内标签：大盘是默认首屏；树图（PW-60）与旧版式收进二级 */}
        <nav className="pw-nb-tabs" role="tablist" aria-label="笔记屏视图">
          {([
            ['board', '大盘'],
            ['tree', '树图'],
            ['ledger', '账本'],
            ['legacy', '全部笔记'],
          ] as Array<[NotesTab, string]>).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              className={`pw-nb-tab${tab === value ? ' on' : ''}`}
              onClick={() => setTab(value)}
            >
              {label}
            </button>
          ))}
        </nav>

        {tab === 'board' && <BoardTab epoch={epoch} />}
        {tab === 'tree' && <TreeTab epoch={epoch} />}
        {tab === 'ledger' && <RecallLedgerTab epoch={epoch} />}
        {tab === 'legacy' && <LegacyNotes epoch={epoch} defaultOpen />}
      </div>
    </div>
  );
}

/* ---------- TASK-PW-60：记忆钩子树（二级标签；原首屏内容原样保留） ---------- */

function TreeTab({ epoch }: { epoch: number }) {
  const treeState = useAsync(() => pwApi.notesTree(), [epoch]);

  // 全量笔记（分页拉完），供叶子抽屉取原文、无关键词时兜底取首句
  const allNotesState = useAsync(async () => {
    const all: PwNote[] = [];
    for (let offset = 0; ; offset += TREE_PAGE) {
      const res = await pwApi.notesList(TREE_PAGE, offset);
      all.push(...res.notes);
      if (res.notes.length < TREE_PAGE) break;
    }
    return all;
  }, [epoch]);

  const [drawerUid, setDrawerUid] = useState<string | null>(null);
  const [asked, setAsked] = useState('');
  const [hitUids, setHitUids] = useState<ReadonlySet<string> | null>(null);
  const [askBusy, setAskBusy] = useState(false);
  const [tickBusy, setTickBusy] = useState(false);

  const noteByUid = useMemo(() => {
    const map = new Map<string, PwNote>();
    for (const note of allNotesState.data ?? []) map.set(note.uid, note);
    return map;
  }, [allNotesState.data]);

  const tree = treeState.data ?? null;

  const ask = async (e: FormEvent) => {
    e.preventDefault();
    const q = asked.trim();
    if (!q) return;
    setAskBusy(true);
    try {
      const res = await pwApi.notesSearch(q);
      setHitUids(new Set(res.notes.map((n) => n.uid)));
    } catch {
      setHitUids(new Set());
    } finally {
      setAskBusy(false);
    }
  };
  const clearAsk = () => {
    setAsked('');
    setHitUids(null);
  };

  const runTick = async () => {
    setTickBusy(true);
    try {
      await pwApi.notesTreeTick();
      treeState.reload();
    } finally {
      setTickBusy(false);
    }
  };

  return (
    <>
      {treeState.error && <div className="pw-blank">树长不出来：{treeState.error}</div>}
      {!treeState.error && tree && (
        <NoteTree
          tree={tree}
          noteByUid={noteByUid}
          hitUids={hitUids}
          onOpenLeaf={setDrawerUid}
          onAttach={(uid, betId) => void pwApi.notesTreeAttach(uid, betId).then(treeState.reload)}
          onTick={() => void runTick()}
          tickBusy={tickBusy}
        />
      )}

      {/* 问笔记：命中高亮在树上，不给段落 */}
      <form className="pw-search pw-tree-ask" onSubmit={(e) => void ask(e)}>
        <input
          value={asked}
          onChange={(e) => setAsked(e.target.value)}
          placeholder="问笔记：命中的叶子会在树上亮起来"
        />
        <button type="submit" className="pw-btn sm" disabled={askBusy}>
          {askBusy ? '捞着…' : '问'}
        </button>
        {hitUids && (
          <button type="button" className="pw-btn sm" onClick={clearAsk}>
            清除高亮（{hitUids.size}）
          </button>
        )}
      </form>
      {hitUids && hitUids.size === 0 && (
        <div className="pw-blank">没捞到相关笔记。</div>
      )}

      {drawerUid && (
        <LeafDrawer
          uid={drawerUid}
          note={noteByUid.get(drawerUid) ?? null}
          tree={tree}
          onClose={() => setDrawerUid(null)}
          onChanged={() => treeState.reload()}
        />
      )}
    </>
  );
}

/* ---------- 记忆钩子树 ---------- */

/** 冷却档位：0=今天有动静，1=3 天内，2=一周内，3=更久/从没挂过叶。 */
function coldLevel(lastNoteAt: string | null): number {
  if (!lastNoteAt) return 3;
  const days = Math.floor((Date.now() - Date.parse(lastNoteAt)) / 86400000);
  if (days <= 0) return 0;
  if (days <= 3) return 1;
  if (days <= 7) return 2;
  return 3;
}

function leafLabel(
  leaf: { uid: string; keyword: string | null },
  noteByUid: Map<string, PwNote>,
): string {
  if (leaf.keyword) return leaf.keyword;
  const content = noteByUid.get(leaf.uid)?.content ?? '';
  const head = content.replace(/\s+/g, ' ').trim();
  return head ? Array.from(head).slice(0, 12).join('') : '（无内容）';
}

function NoteTree({
  tree,
  noteByUid,
  hitUids,
  onOpenLeaf,
  onAttach,
  onTick,
  tickBusy,
}: {
  tree: PwNoteTree;
  noteByUid: Map<string, PwNote>;
  hitUids: ReadonlySet<string> | null;
  onOpenLeaf: (uid: string) => void;
  onAttach: (uid: string, betId: string | null) => void;
  onTick: () => void;
  tickBusy: boolean;
}) {
  const betTitle = useMemo(() => {
    const map = new Map<string, string>();
    for (const bet of tree.bets) map.set(bet.betId, bet.title);
    return map;
  }, [tree.bets]);

  return (
    <section className="pw-tree" aria-label="记忆钩子树">
      <div className="pw-tree-root">
        <span className="pw-tree-root-label">当前方向</span>
        <span className="pw-tree-root-value">
          {tree.direction?.trim() ? tree.direction : '（没人定方向，树就先随便长长）'}
        </span>
      </div>

      {tree.unassigned.length > 0 && (
        <details className="pw-tree-loose">
          <summary className="pw-sec-title">
            待归位 · {tree.unassigned.length} 片散叶（点开归位）
            <button
              type="button"
              className="pw-btn sm"
              disabled={tickBusy}
              onClick={(e) => { e.preventDefault(); onTick(); }}
            >
              {tickBusy ? 'AI 跑腿中…' : 'AI 跑一拍（提炼+建议）'}
            </button>
          </summary>
          <div className="pw-tree-leaves">
            {tree.unassigned.map((leaf) => (
              <span
                key={leaf.uid}
                className={`pw-leaf loose${hitUids?.has(leaf.uid) ? ' hit' : ''}`}
              >
                <button type="button" className="pw-leaf-label" onClick={() => onOpenLeaf(leaf.uid)}>
                  {leafLabel(leaf, noteByUid)}
                </button>
                {leaf.suggestedBetId && (
                  <button
                    type="button"
                    className="pw-leaf-suggest"
                    title={`确认挂到：${betTitle.get(leaf.suggestedBetId) ?? leaf.suggestedBetId}`}
                    onClick={() => onAttach(leaf.uid, leaf.suggestedBetId)}
                  >
                    → {(betTitle.get(leaf.suggestedBetId) ?? '').slice(0, 10) || leaf.suggestedBetId} ✓
                  </button>
                )}
              </span>
            ))}
          </div>
        </details>
      )}

      <div className="pw-tree-branches">
        {tree.bets.length === 0 && (
          <div className="pw-blank">还没有押注卡。去押注台押一张，笔记就有枝可挂了。</div>
        )}
        {tree.bets.map((bet) => (
          <div key={bet.betId} className="pw-branch" data-cold={coldLevel(bet.lastNoteAt)}>
            <div className="pw-branch-head">
              <span className="pw-branch-dot" aria-hidden />
              <span className="pw-branch-title" title={bet.title}>{bet.title}</span>
              <span className="pw-branch-meta">
                ×{bet.notes.length}
                {bet.lastNoteAt ? ` · ${fmtTime(bet.lastNoteAt)}` : ' · 还没挂过叶'}
              </span>
            </div>
            {bet.notes.length > 0 && (
              <div className="pw-tree-leaves">
                {bet.notes.map((leaf) => (
                  <span
                    key={leaf.uid}
                    className={`pw-leaf${hitUids?.has(leaf.uid) ? ' hit' : ''}`}
                  >
                    <button type="button" className="pw-leaf-label" onClick={() => onOpenLeaf(leaf.uid)}>
                      {leafLabel(leaf, noteByUid)}
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/* ---------- 叶子抽屉：原文 + 挂枝 + 改关键词 ---------- */

function LeafDrawer({
  uid,
  note,
  tree,
  onClose,
  onChanged,
}: {
  uid: string;
  note: PwNote | null;
  tree: PwNoteTree | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const currentBetId = useMemo(() => {
    if (!tree) return '';
    for (const bet of tree.bets) {
      if (bet.notes.some((leaf) => leaf.uid === uid)) return bet.betId;
    }
    return '';
  }, [tree, uid]);
  const currentKeyword = useMemo(() => {
    if (!tree) return '';
    for (const bet of tree.bets) {
      const leaf = bet.notes.find((l) => l.uid === uid);
      if (leaf?.keyword) return leaf.keyword;
    }
    return tree.unassigned.find((l) => l.uid === uid)?.keyword ?? '';
  }, [tree, uid]);

  const [betId, setBetId] = useState(currentBetId);
  const [keyword, setKeyword] = useState(currentKeyword);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setBetId(currentBetId), [currentBetId]);
  useEffect(() => setKeyword(currentKeyword), [currentKeyword]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const trimmed = Array.from(keyword.trim()).slice(0, 12).join('');
      if (trimmed && trimmed !== currentKeyword) {
        await pwApi.notesTreeKeyword(uid, trimmed);
      }
      if (betId !== currentBetId) {
        await pwApi.notesTreeAttach(uid, betId || null);
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="pw-leaf-drawer" aria-label="笔记原文">
      <div className="pw-leaf-drawer-head">
        <span className="pw-sec-title">叶子原文</span>
        <button type="button" className="pw-btn sm" onClick={onClose}>收起</button>
      </div>
      {note ? (
        <>
          <p className="pw-note-content">{note.content}</p>
          <div className="pw-note-meta">
            <span className="n-time">{fmtTime(note.createdAt)}</span>
            {note.tags.map((tag) => (
              <span key={tag} className="pw-note-tag">#{tag}</span>
            ))}
            <a className="pw-note-link" href={note.url} target="_blank" rel="noreferrer">原文 ↗</a>
          </div>
        </>
      ) : (
        <div className="pw-blank">这条笔记的全文没拉到（可能分页还没翻到它）。</div>
      )}
      <div className="pw-leaf-drawer-edit">
        <label className="pw-leaf-field">
          关键词（≤12 字）
          <input value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        </label>
        <label className="pw-leaf-field">
          挂到
          <select value={betId} onChange={(e) => setBetId(e.target.value)}>
            <option value="">待归位</option>
            {(tree?.bets ?? []).map((bet) => (
              <option key={bet.betId} value={bet.betId}>{bet.title}</option>
            ))}
          </select>
        </label>
        <button type="button" className="pw-btn sm" disabled={busy} onClick={() => void save()}>
          {busy ? '落账中…' : '确认'}
        </button>
        {error && <div className="pw-blank">{error}</div>}
      </div>
    </aside>
  );
}

/* ---------- 旧版式（折叠保留：热力图/列表/标签/卷积/捞取） ---------- */

function LegacyNotes({ epoch, defaultOpen }: { epoch: number; defaultOpen?: boolean }) {
  const statsState = useAsync(() => pwApi.notesStats(365), [epoch]);
  const tagsState = useAsync(() => pwApi.notesTags(), [epoch]);

  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [page, setPage] = useState(0);

  const notesState = useAsync(
    () => (submitted ? pwApi.notesSearch(submitted) : pwApi.notesList(PAGE_SIZE, page * PAGE_SIZE)),
    [submitted, page, epoch],
  );

  const search = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(query.trim());
    setPage(0);
  };
  const clearSearch = () => {
    setQuery('');
    setSubmitted('');
    setPage(0);
  };
  const searchTag = (tag: string) => {
    setQuery(tag);
    setSubmitted(tag);
    setPage(0);
  };

  const notes = notesState.data?.notes ?? [];

  return (
    <details className="pw-notes-legacy" open={defaultOpen}>
      <summary>翻旧账 · 列表 / 热力图 / 标签 / 卷积（旧版式）</summary>

      <section className="pw-heat-wrap" aria-label="记录节奏热力图">
        <div className="pw-sec-title">记录节奏 · 近一年</div>
        {statsState.error && <div className="pw-blank">连不上笔记库，节奏画不出来。</div>}
        {!statsState.error && <Heatmap days={statsState.data?.days ?? []} />}
      </section>

      <div className="pw-notes-cols">
        <div className="pw-notes-main">
          <form className="pw-search" onSubmit={search}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="检索笔记，回车确认"
            />
            <button type="submit" className="pw-btn sm">检索</button>
            {submitted && (
              <button type="button" className="pw-btn sm" onClick={clearSearch}>清除</button>
            )}
          </form>

          {notesState.error && <div className="pw-blank">连不上笔记库，笔记翻不出来。</div>}
          {!notesState.error && !notesState.loading && notes.length === 0 && (
            <div className="pw-blank">
              {submitted
                ? `没有匹配「${submitted}」的笔记。`
                : '还没有笔记。打开 Memos（http://127.0.0.1:5230）记一条。'}
            </div>
          )}
          <div className="pw-note-list">
            {notes.map((note) => (
              <NoteCard key={note.uid} note={note} onSearchTag={searchTag} />
            ))}
          </div>

          {!submitted && notes.length > 0 && (
            <div className="pw-notes-pager">
              <button
                type="button"
                className="pw-btn sm"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                上一页
              </button>
              <span className="pg-no">第 {page + 1} 页</span>
              <button
                type="button"
                className="pw-btn sm"
                disabled={notes.length < PAGE_SIZE}
                onClick={() => setPage((p) => p + 1)}
              >
                下一页
              </button>
            </div>
          )}
        </div>

        <div className="pw-notes-side">
          <RollupPanel epoch={epoch} />
          <RecallPanel epoch={epoch} />
          <section className="pw-tagtree-wrap" aria-label="标签树">
            <div className="pw-sec-title">标签</div>
            {tagsState.error && <div className="pw-blank">连不上笔记库，标签出不来。</div>}
            {!tagsState.error && (tagsState.data?.tags ?? []).length === 0 && !tagsState.loading && (
              <div className="pw-blank">还没有标签。在 Memos 里记「#标签」就会长出来。</div>
            )}
            {!tagsState.error && (
              <TagTree tags={tagsState.data?.tags ?? []} onSearch={searchTag} />
            )}
          </section>
        </div>
      </div>
    </details>
  );
}

/** 热力图：GitHub 风格周列网格（7 行=周日~周六），四档着色 0 / 1-2 / 3-5 / 6+。 */
function Heatmap({ days }: { days: PwNoteDayStat[] }) {
  const cells = useMemo(() => {
    if (days.length === 0) return [] as Array<PwNoteDayStat | null>;
    const first = new Date(`${days[0].date}T00:00:00`);
    const lead = Number.isNaN(first.getTime()) ? 0 : first.getDay();
    return [...Array<null>(lead).fill(null), ...days];
  }, [days]);

  if (cells.length === 0) return <div className="pw-blank">还没有节奏可画。</div>;
  return (
    <div className="pw-heat" role="img" aria-label="近一年记录节奏热力图">
      {cells.map((day, i) =>
        day === null ? (
          <span key={`pad-${i}`} className="pw-heat-cell pad" />
        ) : (
          <span
            key={day.date}
            className="pw-heat-cell"
            data-level={heatLevel(day.count)}
            title={`${day.date} · ${day.count} 条`}
          />
        ),
      )}
    </div>
  );
}

function heatLevel(count: number): number {
  if (count <= 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  return 3;
}

function NoteCard({ note, onSearchTag }: { note: PwNote; onSearchTag: (tag: string) => void }) {
  return (
    <article className="pw-note-card">
      <p className="pw-note-content">{note.content}</p>
      <div className="pw-note-meta">
        <span className="n-time">{fmtTime(note.createdAt)}</span>
        {note.pinned && <span className="n-pin" title="置顶">📌</span>}
        {note.tags.map((tag) => (
          <button key={tag} type="button" className="pw-note-tag" onClick={() => onSearchTag(tag)}>
            #{tag}
          </button>
        ))}
        <a className="pw-note-link" href={note.url} target="_blank" rel="noreferrer">
          原文 ↗
        </a>
      </div>
    </article>
  );
}

/** TASK-PW-58：笔记自动卷积——日报/周报/月报三档切换；每行=期+摘要，点行展开全文+来源清单（交互照历史洞察 details 款）。 */
function RollupPanel({ epoch }: { epoch: number }) {
  const [kind, setKind] = useState<PwNoteRollupKind>('day');
  const state = useAsync(() => pwApi.notesRollups(kind), [kind, epoch]);
  const rollups = state.data?.rollups ?? [];

  return (
    <section className="pw-rollup" aria-label="笔记自动卷积">
      <div className="pw-sec-title">卷积 · 笔记自动汇总</div>
      <div className="pw-rollup-tabs" role="tablist">
        {([
          ['day', '日报'],
          ['week', '周报'],
          ['month', '月报'],
        ] as Array<[PwNoteRollupKind, string]>).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={kind === value}
            className={`pw-rollup-tab${kind === value ? ' on' : ''}`}
            onClick={() => setKind(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {state.error && <div className="pw-blank">卷积报告出不来：{state.error}</div>}
      {!state.error && rollups.length === 0 && (
        <div className="pw-blank">还没到卷积时点，记几条笔记，明天就有日报</div>
      )}
      {!state.error && rollups.length > 0 && (
        <div className="pw-rollup-list">
          {rollups.map((rollup) => (
            <details key={rollup.id} className="pw-rollup-item">
              <summary>
                <span className="pw-rollup-period">{rollup.period}</span>
                <span className="pw-rollup-summary">{rollupSummary(rollup.report)}</span>
              </summary>
              <RollupCard rollup={rollup} />
            </details>
          ))}
        </div>
      )}
    </section>
  );
}

/** report 第一段纯文本摘要（去 markdown 记号、压空白，截 80 字）。 */
function rollupSummary(report: string): string {
  const lines = report.split('\n');
  const start = lines.findIndex((line) => {
    const t = line.trim();
    return t.length > 0 && !t.startsWith('#') && t !== '---';
  });
  if (start < 0) return report.slice(0, 80);
  const parts: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (!t || t.startsWith('#')) break;
    parts.push(t.replace(/^[-*]\s*/, '').replace(/[*_`~>]/g, ''));
  }
  const plain = parts.join(' ').replace(/\s+/g, ' ').trim();
  return plain.length > 80 ? `${plain.slice(0, 80)}…` : plain;
}

/** 卷积报告卡：头部时间/模型 + MarkdownView 全文 + 来源清单（[笔记N]/[日报N]/[周报N] 对应输入编号）。 */
function RollupCard({ rollup }: { rollup: PwNoteRollup }) {
  const label = rollup.kind === 'day' ? '笔记' : rollup.kind === 'week' ? '日报' : '周报';
  return (
    <article className="pw-rollup-card">
      <div className="pw-rollup-head">
        <span className="n-time">{fmtTime(rollup.createdAt)}</span>
        {rollup.model && <span className="pw-insight-model">{rollup.model}</span>}
        <span className="pw-rollup-count">来源 ×{rollup.sourceCount}</span>
      </div>
      <div className="pw-rollup-report">
        <MarkdownView content={rollup.report} />
      </div>
      {rollup.sourceRefs.length > 0 && (
        <div className="pw-rollup-refs">
          {rollup.sourceRefs.map((ref, index) =>
            ref.uid ? (
              <a
                key={ref.uid}
                className="pw-rollup-ref"
                href={ref.url}
                target="_blank"
                rel="noreferrer"
                title={ref.createdAt ? fmtTime(ref.createdAt) : undefined}
              >
                {label}{index + 1} ↗
              </a>
            ) : (
              <span key={ref.id ?? index} className="pw-rollup-ref">
                {label}{index + 1}
              </span>
            ),
          )}
        </div>
      )}
    </article>
  );
}

/** 相关旧笔记：在途内容押注 chips + 选中联动捞取（PW-40 机制上屏）。 */
function RecallPanel({ epoch }: { epoch: number }) {
  const betsState = useAsync(() => pwApi.listContentBets(), [epoch]);
  const [selectedBetId, setSelectedBetId] = useState<string | null>(null);

  const pendingBets = useMemo(() => {
    const rows = (betsState.data?.bets ?? []).filter((b) => b.status === 'pending');
    // TASK-PW-27：菜号牌展示序——与后端 sortContentBetsForDisplay 同一规则（改动须两边同步）
    return [...rows].sort((a, b) =>
      (a.checkout_date ?? '9999').localeCompare(b.checkout_date ?? '9999')
      || a.created_at.localeCompare(b.created_at)
      || a.id.localeCompare(b.id),
    );
  }, [betsState.data]);

  useEffect(() => {
    if (pendingBets.length === 0) {
      setSelectedBetId(null);
    } else if (!selectedBetId || !pendingBets.some((b) => b.id === selectedBetId)) {
      setSelectedBetId(pendingBets[0].id);
    }
  }, [pendingBets, selectedBetId]);

  const recallState = useAsync(
    () => (selectedBetId ? pwApi.notesRecall(selectedBetId) : Promise.resolve(null)),
    [selectedBetId, epoch],
  );
  const recall = recallState.data?.recall ?? null;

  return (
    <section className="pw-recall" aria-label="相关旧笔记">
      <div className="pw-sec-title">相关旧笔记 · 跟着押注捞</div>
      {pendingBets.length === 0 && !betsState.loading && (
        <div className="pw-blank">没有在途内容押注，没东西可捞。</div>
      )}
      {pendingBets.length > 0 && (
        <div className="pw-recall-chips" role="tablist">
          {pendingBets.map((bet: PwContentBet) => (
            <button
              key={bet.id}
              type="button"
              className={`pw-recall-chip${bet.id === selectedBetId ? ' on' : ''}`}
              title={bet.title}
              onClick={() => setSelectedBetId(bet.id)}
            >
              {bet.title.length > 14 ? `${bet.title.slice(0, 14)}…` : bet.title}
            </button>
          ))}
        </div>
      )}
      {recallState.error && <div className="pw-blank">连不上笔记库，旧笔记捞不出来。</div>}
      {!recallState.error && recall && recall.keywords.length === 0 && (
        <div className="pw-blank">这张押注抽不出可捞的词，跳过。</div>
      )}
      {!recallState.error && recall && recall.keywords.length > 0 && recall.hits.length === 0 && (
        <div className="pw-blank">
          无命中（捞了：{recall.keywords.slice(0, 8).join('、')}{recall.keywords.length > 8 ? '…' : ''}）
        </div>
      )}
      {!recallState.error && recall && recall.hits.length > 0 && (
        <div className="pw-recall-hits">
          {recall.hits.map((hit) => (
            <article key={hit.uid} className="pw-recall-hit">
              <p>{hit.content.length > 120 ? `${hit.content.slice(0, 120)}…` : hit.content}</p>
              <div className="pw-note-meta">
                <span className="n-time">{fmtTime(hit.createdAt)}</span>
                {hit.matchedKeywords.map((kw) => (
                  <span key={kw} className="pw-recall-kw">{kw}</span>
                ))}
                <a className="pw-note-link" href={hit.url} target="_blank" rel="noreferrer">
                  原文 ↗
                </a>
              </div>
            </article>
          ))}
        </div>
      )}
      {!recallState.error && recall && recall.hits.length > 0 && selectedBetId && (
        <InsightPanel betId={selectedBetId} epoch={epoch} hitCount={recall.hits.length} />
      )}
    </section>
  );
}

/** TASK-PW-53：笔记定向洞察——人点「跑洞察」才调模型；报告五段 + 来源 chips，历史可翻。 */
function InsightPanel({ betId, epoch, hitCount }: { betId: string; epoch: number; hitCount: number }) {
  const historyState = useAsync(() => pwApi.notesInsightList(betId), [betId, epoch]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<PwNoteInsight | null>(null);

  // 换押注卡时清掉上一份新鲜报告与错误，不串卡
  useEffect(() => {
    setFresh(null);
    setError(null);
  }, [betId]);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await pwApi.notesInsightRun(betId);
      setFresh(res.insight);
      historyState.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const history = historyState.data?.insights ?? [];
  const shown = fresh ?? history[0] ?? null;

  return (
    <section className="pw-insight" aria-label="笔记定向洞察">
      <div className="pw-insight-actions">
        <button
          type="button"
          className="pw-btn sm"
          disabled={running}
          onClick={() => void run()}
        >
          {running ? '洞察中…' : '跑洞察'}
        </button>
        <span className="pw-insight-hint">
          把捞到的 {hitCount} 条旧笔记读一遍，出五段报告，每条标出处
        </span>
      </div>
      {error && <div className="pw-blank">{error}</div>}
      {shown && <InsightCard insight={shown} />}
      {history.length > 0 && (
        <details className="pw-insight-history">
          <summary>历史洞察 ×{history.length}</summary>
          {history.map((item) => (
            <details key={item.id} className="pw-insight-history-item">
              <summary>
                {fmtTime(item.createdAt)} · {item.report.slice(0, 40)}
                {item.report.length > 40 ? '…' : ''}
              </summary>
              <InsightCard insight={item} />
            </details>
          ))}
        </details>
      )}
    </section>
  );
}

/** 洞察报告卡：头部时间/模型 + 五段原文 + 来源 chips（[笔记N] 对应输入编号，点击跳 Memos 原文）。 */
function InsightCard({ insight }: { insight: PwNoteInsight }) {
  return (
    <article className="pw-insight-card">
      <div className="pw-insight-head">
        <span className="n-time">{fmtTime(insight.createdAt)}</span>
        {insight.model && <span className="pw-insight-model">{insight.model}</span>}
      </div>
      <div className="pw-insight-report">{insight.report}</div>
      {insight.noteRefs.length > 0 && (
        <div className="pw-insight-refs">
          {insight.noteRefs.map((ref, index) => (
            <a
              key={ref.uid}
              className="pw-insight-ref"
              href={ref.url}
              target="_blank"
              rel="noreferrer"
              title={`${fmtTime(ref.createdAt)} · 命中：${ref.matchedKeywords.join('、')}`}
            >
              笔记{index + 1} ↗
            </a>
          ))}
        </div>
      )}
    </article>
  );
}

type TagNode = { name: string; path: string; ownCount: number; total: number; children: TagNode[] };

/** 扁平标签计数 → 按 / 分层的树；节点 total = 自身计数 + 子孙合计。 */
function buildTagTree(tags: PwNoteTagCount[]): TagNode[] {
  const roots: TagNode[] = [];
  const byPath = new Map<string, TagNode>();
  for (const { tag, count } of tags) {
    const parts = tag.split('/').filter((p) => p.length > 0);
    let siblings = roots;
    let path = '';
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      let node = byPath.get(path);
      if (!node) {
        node = { name: part, path, ownCount: 0, total: 0, children: [] };
        byPath.set(path, node);
        siblings.push(node);
      }
      siblings = node.children;
    }
    const leaf = byPath.get(path);
    if (leaf) leaf.ownCount += count;
  }
  const sum = (node: TagNode): number => {
    node.total = node.ownCount + node.children.reduce((acc, child) => acc + sum(child), 0);
    return node.total;
  };
  roots.forEach(sum);
  return roots;
}

/** 标签树：▸/▾ 折叠（默认只展开第一层），点标签名 = 搜它。 */
function TagTree({ tags, onSearch }: { tags: PwNoteTagCount[]; onSearch: (tag: string) => void }) {
  const roots = useMemo(() => buildTagTree(tags), [tags]);
  // 默认折叠第二层及更深（路径含 / 的节点）
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => {
    const initial = new Set<string>();
    const walk = (nodes: TagNode[], depth: number) => {
      for (const node of nodes) {
        if (depth >= 2) initial.add(node.path);
        walk(node.children, depth + 1);
      }
    };
    walk(roots, 1);
    return initial;
  });
  const [everTouched, setEverTouched] = useState(false);

  // 标签数据变化（首载）且用户还没动过折叠 → 按新数据重置默认折叠
  useEffect(() => {
    if (everTouched) return;
    const initial = new Set<string>();
    const walk = (nodes: TagNode[], depth: number) => {
      for (const node of nodes) {
        if (depth >= 2) initial.add(node.path);
        walk(node.children, depth + 1);
      }
    };
    walk(roots, 1);
    setCollapsed(initial);
  }, [roots, everTouched]);

  const toggle = (path: string) => {
    setEverTouched(true);
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderNodes = (nodes: TagNode[], depth: number) => (
    <ul className={depth > 1 ? 'pw-tag-children' : 'pw-tagtree'}>
      {nodes.map((node) => {
        const isCollapsed = collapsed.has(node.path);
        return (
          <li key={node.path}>
            <span className="pw-tag-node">
              {node.children.length > 0 ? (
                <button
                  type="button"
                  className="pw-tag-fold"
                  aria-expanded={!isCollapsed}
                  onClick={() => toggle(node.path)}
                >
                  {isCollapsed ? '▸' : '▾'}
                </button>
              ) : (
                <span className="pw-tag-fold leaf" />
              )}
              <button type="button" className="pw-tag-name" onClick={() => onSearch(node.path)}>
                {node.name}
              </button>
              <span className="pw-tag-count">×{node.total}</span>
            </span>
            {node.children.length > 0 && !isCollapsed && renderNodes(node.children, depth + 1)}
          </li>
        );
      })}
    </ul>
  );
  return renderNodes(roots, 1);
}
