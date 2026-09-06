/**
 * 笔记大盘（TASK-PW-61 首屏）：五区一账——KPI / 今天从哪捞的 / 近 7 天捞出 vs 确认 /
 * 最值钱的笔记 top5 / 缺料提醒 / 从没用过的笔记；候选确认流（确认选角色、弃回流降权）；
 * 单条笔记流水账抽屉。身价是账本确定性计算，AI 不评分；候选 AI 只建议、人确认才生效。
 * TASK-PW-63：确认区从逐条原文改为概念卡 + 逐字证据——判概念不判单条，
 * 整卡挂押注（统一角色）/ 标方向种子（只落标记）/ 弃（下轮少捞），卡内单条可剔。
 */
import { useMemo, useState } from 'react';
import {
  pwApi,
  type PwBoardGap,
  type PwBoardTopNote,
  type PwCheckoutKind,
  type PwContentBet,
  type PwMinerCandidateSource,
  type PwMinerCard,
  type PwMinerCardItem,
  type PwNoteJourney,
  type PwNoteJourneyKind,
  type PwNotesBoard,
} from '../lib/api';
import { fmtTime, useAsync } from './hooks';

const ROLES = ['论点', '案例', '标题', '反例', '其他'] as const;

const SOURCE_LABEL: Record<PwMinerCandidateSource, string> = {
  note: '笔记',
  gold: '金子',
  tombstone: '墓碑',
  memos: 'MemOS 记忆',
};

const KIND_LABEL: Record<PwMinerCard['kind'], string | null> = {
  concept: null,
  self_memory: '自己的记忆',
  link_shell: '收藏壳',
};

const JOURNEY_LABEL: Record<PwNoteJourneyKind, string> = {
  attach: '挂上押注',
  draft: '进草案',
  product: '进成品',
  data: '数据回流',
  checkout: '结账',
};

export function BoardTab({ epoch }: { epoch: number }) {
  const [refresh, setRefresh] = useState(0);
  const boardState = useAsync(() => pwApi.notesBoard(), [epoch, refresh]);
  const cardsState = useAsync(() => pwApi.minerCards('suggested'), [epoch, refresh]);
  const [runBusy, setRunBusy] = useState(false);
  const [journeyUid, setJourneyUid] = useState<string | null>(null);

  const board = boardState.data ?? null;
  const cards = cardsState.data?.cards ?? [];
  const pendingCount = cards.length;

  const reloadAll = () => {
    boardState.reload();
    cardsState.reload();
  };

  const runMiner = async () => {
    setRunBusy(true);
    try {
      await pwApi.minerRun();
      reloadAll();
    } finally {
      setRunBusy(false);
    }
  };

  return (
    <div className="pw-nb">
      {boardState.error && (
        <div className="pw-nb-empty">
          <p>大盘出不来：{boardState.error}</p>
          <p className="pw-nb-empty-sub">后端 PW-61 还没上线时这里会先这样，不耽误看树图和全部笔记。</p>
        </div>
      )}
      {!boardState.error && !board && !boardState.loading && (
        <div className="pw-nb-empty">
          <p>还没跑过捞料。</p>
          <button type="button" className="pw-btn sm" disabled={runBusy} onClick={() => void runMiner()}>
            {runBusy ? '捞料中…' : '手动捞一轮'}
          </button>
        </div>
      )}

      {board && (
        <>
          <BoardHead board={board} runBusy={runBusy} onRun={() => void runMiner()} />

          {pendingCount > 0 && (
            <CardsSection cards={cards} onChanged={reloadAll} />
          )}

          <div className="pw-nb-grid">
            <SourceCard board={board} />
            <WeekCard board={board} />
          </div>

          <TopNotesCard
            notes={board.topNotes}
            onOpenJourney={setJourneyUid}
          />

          <GapsCard gaps={board.gaps} />

          <UnusedCard board={board} />
        </>
      )}

      {journeyUid && <JourneyDrawer uid={journeyUid} onClose={() => setJourneyUid(null)} />}
    </div>
  );
}

/* ---------- 头部：上次跑况 + 手动触发 ---------- */

function BoardHead({
  board,
  runBusy,
  onRun,
}: {
  board: PwNotesBoard;
  runBusy: boolean;
  onRun: () => void;
}) {
  const { lastRun, kpis } = board;
  const usedPct = kpis.totalNotes > 0 ? ((kpis.usedNotes / kpis.totalNotes) * 100).toFixed(1) : '0.0';
  const confirmPct =
    lastRun && lastRun.candidates > 0
      ? Math.round((lastRun.confirmed / lastRun.candidates) * 100)
      : null;

  return (
    <section className="pw-nb-head" aria-label="总账">
      <div className="pw-nb-head-meta">
        {lastRun?.at ? (
          <span>
            今天 {fmtTime(lastRun.at)} {lastRun.triggerKind === 'manual' ? '手动' : '自动'}捞过 ·
            本次花费 ¥{lastRun.costCny.toFixed(2)}
          </span>
        ) : (
          <span>还没跑过捞料</span>
        )}
        <button type="button" className="pw-btn sm" disabled={runBusy} onClick={onRun}>
          {runBusy ? '捞料中…' : '手动捞一轮'}
        </button>
      </div>
      <div className="pw-nb-kpis">
        <Kpi label="笔记总数" value={String(kpis.totalNotes)} />
        <Kpi label="被用过" value={String(kpis.usedNotes)} sub={`${usedPct}%`} />
        <Kpi label="进过成品" value={String(kpis.intoProducts)} />
        <Kpi label="带回结账" value={String(kpis.checkoutBack)} />
        <Kpi label="今天捞出" value={String(lastRun?.candidates ?? 0)} />
        <Kpi
          label="你确认"
          value={String(lastRun?.confirmed ?? 0)}
          sub={confirmPct !== null ? `${confirmPct}%` : undefined}
        />
        <Kpi label="弃" value={String(lastRun?.rejected ?? 0)} />
      </div>
    </section>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="pw-nb-kpi">
      <div className="pw-nb-kpi-label">{label}</div>
      <div className="pw-nb-kpi-value">
        {value}
        {sub && <span className="pw-nb-kpi-sub"> ({sub})</span>}
      </div>
    </div>
  );
}

/* ---------- 概念卡确认流（PW-63：判概念不判单条） ---------- */

function CardsSection({
  cards,
  onChanged,
}: {
  cards: PwMinerCard[];
  onChanged: () => void;
}) {
  return (
    <section className="pw-nb-card" aria-label="待判概念卡">
      <div className="pw-sec-title">今天捞到的 · 等你判（{cards.length} 张卡）</div>
      {cards.map((card) => (
        <MinerCardView key={card.id} card={card} onChanged={onChanged} />
      ))}
    </section>
  );
}

function MinerCardView({
  card,
  onChanged,
}: {
  card: PwMinerCard;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [bets, setBets] = useState<PwContentBet[] | null>(null);
  const [betId, setBetId] = useState<string>(card.suggestedBetId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kindLabel = KIND_LABEL[card.kind];
  const liveItems = card.items.filter((item) => item.status === 'suggested');

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const startConfirm = async () => {
    setConfirming(true);
    if (bets === null) {
      try {
        const result = await pwApi.listContentBets();
        setBets(result.bets.filter((bet) => bet.status === 'pending'));
      } catch {
        setBets([]);
      }
    }
  };

  return (
    <div className="pw-nb-mcard" data-kind={card.kind}>
      <div className="pw-nb-mcard-head">
        <span className="pw-nb-mcard-title">{card.title}</span>
        {kindLabel && <span className="pw-nb-mcard-kind">{kindLabel}</span>}
      </div>
      {card.summary && <div className="pw-nb-mcard-summary">{card.summary}</div>}
      {card.betTitle && (
        <div className="pw-nb-mcard-bet">建议挂到：「{card.betTitle}」</div>
      )}
      <div className="pw-nb-mcard-items">
        {liveItems.map((item) => (
          <EvidenceRow key={item.id} item={item} onChanged={onChanged} />
        ))}
        {liveItems.length === 0 && <div className="pw-blank">卡里的料都剔完了。</div>}
      </div>
      <div className="pw-nb-mcard-actions">
        {!confirming ? (
          <>
            <button
              type="button"
              className="pw-btn sm primary"
              disabled={busy || liveItems.length === 0}
              onClick={() => void startConfirm()}
            >
              整卡挂押注
            </button>
            <button
              type="button"
              className="pw-btn sm"
              disabled={busy}
              onClick={() => void run(() => pwApi.minerSeedCard(card.id))}
              title="只落一个标记：这堆料可能够格当下一个选题。不自动改方向、不自动建押注。"
            >
              标方向种子
            </button>
            <button
              type="button"
              className="pw-btn sm"
              disabled={busy}
              onClick={() => void run(() => pwApi.minerRejectCard(card.id))}
            >
              弃（下轮这类少捞）
            </button>
          </>
        ) : (
          <span className="pw-nb-mcard-confirm">
            <select
              className="pw-nb-mcard-betpick"
              value={betId}
              disabled={busy || bets === null}
              onChange={(event) => setBetId(event.target.value)}
            >
              <option value="">{bets === null ? '载入押注中…' : '选一张押注'}</option>
              {(bets ?? []).map((bet) => (
                <option key={bet.id} value={bet.id}>{bet.title}</option>
              ))}
            </select>
            当什么用：
            {ROLES.map((role) => (
              <button
                key={role}
                type="button"
                className="pw-btn sm"
                disabled={busy || !betId}
                onClick={() => void run(() => pwApi.minerConfirmCard(card.id, betId, role))}
              >
                {role}
              </button>
            ))}
            <button type="button" className="pw-btn sm" disabled={busy} onClick={() => setConfirming(false)}>
              算了
            </button>
          </span>
        )}
      </div>
      {error && <div className="pw-nb-cand-error">{error}</div>}
    </div>
  );
}

function EvidenceRow({
  item,
  onChanged,
}: {
  item: PwMinerCardItem;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reject = async () => {
    setBusy(true);
    setError(null);
    try {
      await pwApi.minerRejectCandidate(item.id);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="pw-nb-evi">
      <div className="pw-nb-evi-row">
        <span className="pw-nb-cand-source">{SOURCE_LABEL[item.source]}</span>
        <button
          type="button"
          className="pw-nb-evi-snippet"
          onClick={() => setOpen((value) => !value)}
          title={open ? '收起' : '展开捞它的理由'}
        >
          {item.snippet}
        </button>
        <span className="pw-nb-evi-actions">
          {item.memosUrl && (
            <a className="pw-note-link" href={item.memosUrl} target="_blank" rel="noreferrer">
              原文 ↗
            </a>
          )}
          <button
            type="button"
            className="pw-btn-ghost sm"
            disabled={busy}
            onClick={() => void reject()}
            title="把这条从卡里剔掉（下轮这类少捞），卡本身保留"
          >
            剔
          </button>
        </span>
      </div>
      {open && item.reason && <div className="pw-nb-evi-reason">捞它的理由：{item.reason}</div>}
      {error && <div className="pw-nb-cand-error">{error}</div>}
    </div>
  );
}

/* ---------- 今天从哪捞的 + 近 7 天对比 ---------- */

function SourceCard({ board }: { board: PwNotesBoard }) {
  const rows = useMemo(() => {
    const s = board.todayBySource;
    return [
      { label: '笔记', count: s.note },
      { label: '金子·墓碑', count: s.gold + s.tombstone },
      { label: 'MemOS 记忆', count: s.memos },
    ];
  }, [board.todayBySource]);
  const max = Math.max(1, ...rows.map((r) => r.count));

  return (
    <section className="pw-nb-card" aria-label="今天从哪捞的">
      <div className="pw-sec-title">今天从哪捞的</div>
      {rows.every((r) => r.count === 0) && <div className="pw-blank">今天还没捞到东西。</div>}
      {rows.map((row) => (
        <div key={row.label} className="pw-nb-bar-row">
          <span className="pw-nb-bar-label">{row.label}</span>
          <span className="pw-nb-bar-track">
            <span className="pw-nb-bar-fill" style={{ width: `${(row.count / max) * 100}%` }} />
          </span>
          <span className="pw-nb-bar-count">{row.count}</span>
        </div>
      ))}
    </section>
  );
}

function WeekCard({ board }: { board: PwNotesBoard }) {
  const week = board.week;
  const firstRate = rate(week[0]);
  const lastRate = rate(week[week.length - 1]);
  return (
    <section className="pw-nb-card" aria-label="近 7 天捞出与确认">
      <div className="pw-sec-title">近 7 天：捞出 vs 确认</div>
      {week.length === 0 && <div className="pw-blank">还没攒够天数，跑几天就有了。</div>}
      {week.length > 0 && (
        <>
          <SparkRow label="捞出" values={week.map((d) => d.fished)} />
          <SparkRow label="确认" values={week.map((d) => d.confirmed)} />
          {firstRate !== null && lastRate !== null && (
            <div className="pw-nb-rate">
              确认率 {firstRate}% → {lastRate}%{' '}
              {lastRate > firstRate ? '↗' : lastRate < firstRate ? '↘' : '→'}
              <span className="pw-nb-rate-sub">你越确认，它捞得越准</span>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function rate(day: { fished: number; confirmed: number } | undefined): number | null {
  if (!day || day.fished <= 0) return null;
  return Math.round((day.confirmed / day.fished) * 100);
}

function SparkRow({ label, values }: { label: string; values: number[] }) {
  const max = Math.max(1, ...values);
  return (
    <div className="pw-nb-spark-row">
      <span className="pw-nb-bar-label">{label}</span>
      <span className="pw-nb-spark" role="img" aria-label={`${label}走势`}>
        {values.map((v, i) => (
          <span key={i} className="pw-nb-spark-bar" style={{ height: `${Math.max(8, (v / max) * 100)}%` }} title={String(v)} />
        ))}
      </span>
    </div>
  );
}

/* ---------- 最值钱的笔记 ---------- */

const CHECKOUT_LABEL: Record<PwCheckoutKind, string> = {
  win: '胜',
  draw: '平',
  loss: '败',
  pending: '待结账',
  none: '还没产出',
};

function trendArrow(trend: number[]): string {
  if (trend.length < 2) return '→';
  const last = trend[trend.length - 1];
  const prev = trend[trend.length - 2];
  if (last > prev) return '↗';
  if (last < prev) return '↘';
  return '→';
}

function TopNotesCard({
  notes,
  onOpenJourney,
}: {
  notes: PwBoardTopNote[];
  onOpenJourney: (uid: string) => void;
}) {
  return (
    <section className="pw-nb-card" aria-label="最值钱的笔记">
      <div className="pw-sec-title">最值钱的笔记 (top {notes.length})</div>
      {notes.length === 0 && (
        <div className="pw-blank">还没有笔记上过场。确认几条候选，身价就开始记账。</div>
      )}
      {notes.map((note) => (
        <button
          key={note.uid}
          type="button"
          className="pw-nb-top-row"
          onClick={() => onOpenJourney(note.uid)}
          title="点开看这条笔记的流水账"
        >
          <span className="pw-nb-top-score">
            {note.score} <span className="pw-nb-top-arrow">{trendArrow(note.trend)}</span>
          </span>
          <span className="pw-nb-top-keyword">{note.keyword}</span>
          <SparkRowInline values={note.trend} />
          <span className="pw-nb-top-chain">
            引用{note.citations} → 草案{note.drafts} → 视频{note.products} → {CHECKOUT_LABEL[note.checkout]}
          </span>
        </button>
      ))}
    </section>
  );
}

function SparkRowInline({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  return (
    <span className="pw-nb-spark inline" aria-hidden>
      {values.map((v, i) => (
        <span key={i} className="pw-nb-spark-bar" style={{ height: `${Math.max(8, (v / max) * 100)}%` }} />
      ))}
    </span>
  );
}

/* ---------- 缺料提醒 ---------- */

function gapCopy(gap: PwBoardGap): string {
  if (gap.kind === 'no_material') return `连捞 ${gap.runsZero} 轮 0 条 → 库里真没料，该去补研究了`;
  if (gap.kind === 'material_unused') return `${gap.relatedNotes} 条相关但 0 条被用 → 有料没人用`;
  return `${gap.confirmedNotes} 条笔记 ${gap.drafts} 条进草案 → 只想没产出`;
}

function GapsCard({ gaps }: { gaps: PwBoardGap[] }) {
  return (
    <section className="pw-nb-card" aria-label="缺料提醒">
      <div className="pw-sec-title">缺料提醒</div>
      {gaps.length === 0 && <div className="pw-blank">在途押注都有料供着，不缺。</div>}
      {gaps.map((gap) => (
        <div key={gap.betId} className="pw-nb-gap" data-kind={gap.kind}>
          <span className="pw-nb-gap-title">「{gap.title}」</span>
          <span className="pw-nb-gap-copy">{gapCopy(gap)}</span>
        </div>
      ))}
    </section>
  );
}

/* ---------- 从没用过的笔记 ---------- */

function UnusedCard({ board }: { board: PwNotesBoard }) {
  return (
    <section className="pw-nb-card" aria-label="从没用过的笔记">
      <div className="pw-sec-title">从没用过的笔记</div>
      <div className="pw-nb-unused">
        <span className="pw-nb-unused-count">{board.unused.count}</span>
        <span className="pw-nb-unused-unit">条</span>
        <span className="pw-nb-bar-track wide">
          <span className="pw-nb-bar-fill muted" style={{ width: `${board.unused.pct}%` }} />
        </span>
        <span className="pw-nb-unused-pct">{board.unused.pct}%</span>
      </div>
      {board.unused.rejectedEver > 0 && (
        <div className="pw-nb-unused-sub">
          其中捞到过但你都弃了的 {board.unused.rejectedEver} 条 → 这类下次少捞
        </div>
      )}
    </section>
  );
}

/* ---------- 单条笔记流水账抽屉 ---------- */

function JourneyDrawer({ uid, onClose }: { uid: string; onClose: () => void }) {
  const state = useAsync(() => pwApi.noteJourney(uid), [uid]);
  const journey: PwNoteJourney | null = state.data ?? null;

  return (
    <aside className="pw-leaf-drawer" aria-label="笔记流水账">
      <div className="pw-leaf-drawer-head">
        <span className="pw-sec-title">这条笔记的流水账</span>
        <button type="button" className="pw-btn sm" onClick={onClose}>收起</button>
      </div>
      {state.error && <div className="pw-blank">流水账出不来：{state.error}</div>}
      {!state.error && journey && journey.events.length === 0 && (
        <div className="pw-blank">这条笔记还没上过场，没有流水可记。</div>
      )}
      {!state.error && journey && journey.events.length > 0 && (
        <ol className="pw-nb-journey">
          {journey.events.map((event, i) => (
            <li key={i} className="pw-nb-journey-item" data-kind={event.kind}>
              <span className="pw-nb-journey-time">{fmtTime(event.at)}</span>
              <span className="pw-nb-journey-kind">{JOURNEY_LABEL[event.kind] ?? event.kind}</span>
              <span className="pw-nb-journey-label">{event.label}</span>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
