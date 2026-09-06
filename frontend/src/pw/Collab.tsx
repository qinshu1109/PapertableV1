/**
 * 协作台（TASK-PW-36 决策层返工，线框稿 docs/WIREFRAME-decision-layer-mvp.md）：
 * 层1 决策面——B1 顶条（计数拆候选/草案两项 + 筛子小字 + 收工小结）+ 在途押注横滚 rail
 *   （📝×N 角标，点击内嵌展开草案区）+ B2 候选两列极简卡（hover 浮层/↗原文/挑改否）
 *   + 少数派虚线金框区 + B3 弹药架（只摆实际引用）+ B4 多源可视化（来源对比/产出榜两 tab，
 *   近 7 天/30 天）+ B5 全局对话条（抽屉 58%，PW-22 沿用）。
 * 层2 单卡钻取：左 60% 三行 + 右 40% SSE 对话深挖（沿用不动）。
 * 停线可视化：卡面无「推荐」字样、候选标「草稿」、hover 才出排序分明细；挑/改/否/定稿只能人做。
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { MarkdownView } from '../lib/MarkdownView';
import {
  pwApi,
  streamCollabMessage,
  type PwAmmoRow,
  type PwContentBet,
  type PwContentBetOverrides,
  type PwContentDraft,
  type PwDaySummary,
  type PwSieveCard,
  type PwSieveStatus,
} from '../lib/api';
import { useStore } from '../store';
import { daysText, fmtDay, fmtTime, useAsync } from './hooks';
import { PwModal } from './ui';
import { ProposalInbox } from './Proposals';

const TOOL_LABEL: Record<string, string> = {
  read_bet: '查看押注卡',
  read_data_docs: '检索数据文档',
  search_verdicts: '读取判决簿',
  search_corpus: '语料检索',
  read_voice: '观众声音',
  fetch_corpus: '自主抓取',
  draft_bet: '起草押注',
  draft_settle: '起草结账建议',
  list_corpus: '语料清单',
  read_corpus_doc: '读语料文档',
  read_corpus_comments: '读评论全文',
  read_doc_versions: '读版本链',
  read_verdict_evidence: '读判决证据',
  read_connections: '读连接状态',
  list_sieve_cards: '看候选卡',
  read_sieve_card: '读候选卡',
  list_content_bets: '看内容押注',
  confirm_bet_draft: '确认押注草稿',
  reject_bet_draft: '驳回押注草稿',
  create_bet: '建押注',
  edit_bet: '改押注',
  freeze_data_doc: '冻结数据文档',
  run_sieve: '触发补筛',
  add_voice: '录入观众声音',
  attach_artifact: '挂载产出物',
  detach_artifact: '摘除产出物',
  list_my_actions: '查代办账',
  settle_bet: '结账',
  pick_sieve_card: '挑卡',
  reject_sieve_card: '否卡',
  reject_all_and_resieve: '全否重筛',
  unpick_sieve_card: '撤销挑卡',
  void_settlement: '结账作废',
};

interface QuoteSource {
  bvid?: string;
  uname?: string;
  like?: number;
  rpid?: number;
}

function parseQuoteSource(json: string): QuoteSource {
  try {
    const obj = JSON.parse(json) as QuoteSource;
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function fmtStamp(iso: string | null): string {
  if (!iso) return '—';
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}

/** 素材草案骨架节点（PW-32 形状：text + gold_ref「§N」或 null）。 */
interface SkeletonNode {
  text?: string;
  gold_ref?: string | null;
}

function parseSkeleton(json: string): SkeletonNode[] {
  try {
    const arr = JSON.parse(json) as unknown;
    return Array.isArray(arr) ? (arr as SkeletonNode[]) : [];
  } catch {
    return [];
  }
}

/* ============================================================
   协作台（层路由）
   ============================================================ */
export function Collab({
  epoch,
  onChanged,
  onNav,
}: {
  epoch: number;
  onChanged: () => void;
  onNav: (s: 'workbench' | 'notes') => void;
}) {
  const { showToast } = useStore();
  const [layer, setLayer] = useState<'board' | 'bet'>('board');
  const [focusBetId, setFocusBetId] = useState<string | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);

  const statusState = useAsync(() => pwApi.sieveStatus(), [epoch]);
  const cardsState = useAsync(() => pwApi.listSieveCards('pending'), [epoch]);
  const contentBetsState = useAsync(() => pwApi.listContentBets(), [epoch]);

  const cards = useMemo(() => cardsState.data?.cards ?? [], [cardsState.data]);
  const normals = useMemo(
    () => cards.filter((c) => c.kind === 'normal').sort((a, b) => b.sort_score - a.sort_score),
    [cards],
  );
  const wildcards = useMemo(() => cards.filter((c) => c.kind === 'wildcard'), [cards]);
  const contentBets = useMemo(() => {
    const rows = contentBetsState.data?.bets ?? [];
    // TASK-PW-27：菜号牌「注 N」——与后端 sortContentBetsForDisplay 同一规则（改动须两边同步）
    return [...rows].sort((a, b) => {
      if ((a.status === 'pending') !== (b.status === 'pending')) return a.status === 'pending' ? -1 : 1;
      return (a.checkout_date ?? '9999').localeCompare(b.checkout_date ?? '9999')
        || a.created_at.localeCompare(b.created_at)
        || a.id.localeCompare(b.id);
    });
  }, [contentBetsState.data]);
  const focusBet = contentBets.find((b) => b.id === focusBetId) ?? null;

  const reloadAll = () => {
    statusState.reload();
    cardsState.reload();
    contentBetsState.reload();
    onChanged();
  };

  const enterBet = (betId: string, question?: string) => {
    setFocusBetId(betId);
    setPendingQuestion(question ?? null);
    setLayer('bet');
  };

  if (layer === 'bet' && focusBet) {
    return (
      <BetLayer
        key={focusBet.id}
        bet={focusBet}
        initialQuestion={pendingQuestion}
        onBack={() => {
          setLayer('board');
          setPendingQuestion(null);
          reloadAll();
        }}
        onChanged={onChanged}
      />
    );
  }

  return (
    <BoardLayer
      epoch={epoch}
      status={statusState.data ?? null}
      normals={normals}
      wildcards={wildcards}
      contentBets={contentBets}
      loading={cardsState.loading}
      onEnterBet={(id) => enterBet(id)}
      onChanged={reloadAll}
      showToast={showToast}
      onOpenNotes={() => onNav('notes')}
    />
  );
}

/* ============================================================
   层 1 · 决策面（B1 顶条 / rail / B2 / B3 / B4 / B5）
   ============================================================ */
function BoardLayer({
  epoch,
  status,
  normals,
  wildcards,
  contentBets,
  loading,
  onEnterBet,
  onChanged,
  showToast,
  onOpenNotes,
}: {
  epoch: number;
  status: PwSieveStatus | null;
  normals: PwSieveCard[];
  wildcards: PwSieveCard[];
  contentBets: PwContentBet[];
  loading: boolean;
  onEnterBet: (id: string) => void;
  onChanged: () => void;
  showToast: (t: { text: string }) => void;
  onOpenNotes: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editCard, setEditCard] = useState<PwSieveCard | null>(null);
  const [sieving, setSieving] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerQuestion, setDrawerQuestion] = useState<string | null>(null);
  const [drawerKey, setDrawerKey] = useState(0);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [dirOpen, setDirOpen] = useState(false);
  const [rejectAllOpen, setRejectAllOpen] = useState(false);
  const [rejectCardTarget, setRejectCardTarget] = useState<PwSieveCard | null>(null);
  const [expandedBetId, setExpandedBetId] = useState<string | null>(null);
  const [ammoVerdict, setAmmoVerdict] = useState<PwAmmoRow | null>(null);
  const [statsRange, setStatsRange] = useState<7 | 30>(7);
  const cardsAnchorRef = useRef<HTMLDivElement>(null);

  const ammoState = useAsync(() => pwApi.ammoShelf(), [epoch]);
  const statsState = useAsync(() => pwApi.sourceStats(statsRange), [epoch, statsRange]);
  const shelf = useMemo(() => ammoState.data?.shelf ?? [], [ammoState.data]);

  const candidateCount = normals.length + wildcards.length;
  const draftCount = contentBets.reduce((sum, bet) => sum + (bet.draft_count ?? 0), 0);

  const reload = () => {
    ammoState.reload();
    statsState.reload();
    onChanged();
  };

  const pick = async (card: PwSieveCard, overrides?: PwContentBetOverrides) => {
    setBusyId(card.id);
    try {
      const bet = await pwApi.pickSieveCard(card.id, overrides);
      showToast({ text: overrides ? '已按你的修改转成内容押注卡' : '已挑中，转成内容押注卡（起草自动发动）' });
      onChanged();
      setExpandedBetId(bet.id);
    } catch (error) {
      showToast({ text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyId(null);
    }
  };

  /* TASK-PW-49：单卡否决从 window.prompt 改自定义弹层（PW-36 禁原生对话框纪律补完） */
  const reject = async (card: PwSieveCard, reason?: string) => {
    setBusyId(card.id);
    try {
      await pwApi.rejectSieveCard(card.id, reason || undefined);
      setRejectCardTarget(null);
      onChanged();
    } catch (error) {
      showToast({ text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyId(null);
    }
  };

  /* TASK-PW-43：全否改自定义弹层（可顺手换方向），执行走 POST /api/pw/sieve/reject-all 一步到位；
     TASK-PW-48：弹层加「老料重筛」勾选（resieveAll） */
  const rejectAll = async (reason: string, direction: string, resieveAll: boolean) => {
    setSieving(true);
    try {
      const result = await pwApi.rejectAllSieveCards(reason || undefined, direction || undefined, resieveAll || undefined);
      showToast({
        text: result.runId
          ? `已全否 ${result.rejected} 张${direction ? `、方向换成「${direction}」` : ''}${resieveAll ? '、老料重筛一轮' : ''}，重筛跑完自动摆上新卡`
          : `已全否 ${result.rejected} 张${direction ? `、方向换成「${direction}」` : ''}（当前无待筛新料，新方向从下一轮生效）`,
      });
      setRejectAllOpen(false);
      onChanged();
    } catch (error) {
      showToast({ text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSieving(false);
    }
  };

  /* TASK-PW-43：改方向（空串 = 恢复默认） */
  const saveDirection = async (direction: string) => {
    try {
      const result = await pwApi.setSieveDirection(direction || null);
      showToast({ text: result.direction ? `筛子方向已换成「${result.direction}」，下一轮筛生效` : '已恢复默认方向（捞路人困惑）' });
      setDirOpen(false);
      onChanged();
    } catch (error) {
      showToast({ text: error instanceof Error ? error.message : String(error) });
    }
  };

  const flushSieve = async () => {
    setSieving(true);
    try {
      await pwApi.runSieve();
      showToast({ text: '已触发补筛，筛子跑完自动摆上新卡' });
      onChanged();
    } catch (error) {
      showToast({ text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSieving(false);
    }
  };

  const jumpToFirstDrafts = () => {
    const target = contentBets.find((bet) => (bet.draft_count ?? 0) > 0);
    if (target) setExpandedBetId(target.id);
  };

  return (
    <div className={`pw-cb${drawerOpen ? ' is-chat-open' : ''}`}>
      {/* B1 顶条 */}
      <div className="pw-cb-top">
        <span className="pw-cb-top-brand">协作台 · 决策层</span>
        <span className="pw-dl-counts">
          待你定：
          <button type="button" className="pw-dl-count" onClick={() => cardsAnchorRef.current?.scrollIntoView({ behavior: 'smooth' })}>
            候选 {candidateCount}
          </button>
          ·
          <button type="button" className="pw-dl-count" onClick={jumpToFirstDrafts}>
            草案 {draftCount}
          </button>
        </span>
        <span className="pw-cb-top-status">
          筛子：{status?.last_run_at ? `上次筛 ${fmtStamp(status.last_run_at)}` : '还没筛过'}
          {status ? ` · 待选 ${status.cards_pending} 张` : ''}
        </span>
        <button
          type="button"
          className="pw-cb-top-dir"
          title="筛子往哪捞由你定；点我改方向，下一轮筛生效"
          onClick={() => setDirOpen(true)}
        >
          方向：{status?.direction ?? '默认（捞路人困惑）'} ✏️
        </button>
        {(status?.pending_arrivals ?? 0) > 0 && (
          <button type="button" className="pw-btn primary" disabled={sieving} onClick={() => void flushSieve()}>
            {sieving ? '补筛中…' : `补筛 ${status?.pending_arrivals} 批新数据`}
          </button>
        )}
        <button type="button" className="pw-btn" onClick={() => setSummaryOpen(true)}>
          收工小结
        </button>
      </div>

      {/* 简报 14：模式与对账条（系统视角） */}
      <ModeStrip epoch={epoch} />

      {/* 在途押注 rail（横滚；📝×N 角标；点击内嵌展开草案区） */}
      <div className="pw-dl-rail">
        <span className="pw-dl-rail-label">在途押注</span>
        {contentBets.length === 0 && <span className="hint">还没有内容押注卡——从下面候选卡挑一张</span>}
        {contentBets.map((bet) => (
          <span key={bet.id} className={`pw-dl-bet${expandedBetId === bet.id ? ' is-open' : ''}`}>
            <button
              type="button"
              className="pw-dl-bet-main"
              onClick={() => setExpandedBetId(expandedBetId === bet.id ? null : bet.id)}
              title={bet.title}
            >
              <span className="pw-dl-bet-title">{bet.title}</span>
              {(bet.draft_count ?? 0) > 0 && <span className="pw-dl-bet-badge">📝×{bet.draft_count}</span>}
              <span className="pw-dl-bet-sub">
                {bet.checkout_date ? `${fmtDay(bet.checkout_date)} · ${daysText(bet.checkout_date)}` : '无看结果日'}
              </span>
            </button>
            <button type="button" className="pw-dl-bet-dive" onClick={() => onEnterBet(bet.id)}>
              去深挖 →
            </button>
          </span>
        ))}
      </div>

      {/* 简报 16：内容提案收件箱（外部 agent 的产出在这验收；询问此提案=AI 缩为提案检查器） */}
      <ProposalInbox
        lane="content"
        epoch={epoch}
        onChanged={reload}
        onAsk={(p) => {
          setDrawerQuestion(
            `关于提案「${p.title}」（${p.id.slice(0, 8)}，${p.proposedBy} 提交）：把它的支持证据、反证和自动检查摆出来，缺什么直说。`,
          );
          setDrawerKey((k) => k + 1);
          setDrawerOpen(true);
        }}
      />

      {/* 草案区（rail 点开内嵌展开） */}
      {expandedBetId && (
        <DraftsPanel
          bet={contentBets.find((b) => b.id === expandedBetId) ?? null}
          shelf={shelf}
          epoch={epoch}
          onEnterBet={onEnterBet}
          onChanged={reload}
          onOpenAmmo={setAmmoVerdict}
          showToast={showToast}
        />
      )}

      <div className="pw-dl-split" ref={cardsAnchorRef}>
        {/* B2 候选对比区（两列并排 · 极简三样 · hover 浮层） */}
        <main className="pw-dl-cards">
          <div className="pw-dl-sec-head">
            <h2>候选对比区</h2>
            <span className="hint">只有排序，没有「推荐」——hover 看依据，你复核</span>
            {candidateCount > 0 && (
              <button type="button" className="pw-btn" disabled={sieving} onClick={() => setRejectAllOpen(true)}>
                全否重筛
              </button>
            )}
          </div>

          {!loading && candidateCount === 0 && (
            <div className="pw-blank">
              队列空了——去 agent 窗口抓筛，或在对话条说一句方向。
            </div>
          )}

          <div className="pw-dl-grid">
            {normals.map((card) => (
              <SieveCardView
                key={card.id}
                card={card}
                busy={busyId === card.id}
                onPick={() => void pick(card)}
                onEdit={() => setEditCard(card)}
                onReject={() => setRejectCardTarget(card)}
              />
            ))}
          </div>

          {wildcards.length > 0 && (
            <div className="pw-dl-wild">
              <div className="pw-dl-wild-head">
                少数派区 · 不参与排序（机会藏在这里：归不进堆的、反常识的、少数人说但说得狠的）
              </div>
              {wildcards.map((card) => (
                <SieveCardView
                  key={card.id}
                  card={card}
                  wildcard
                  busy={busyId === card.id}
                  onPick={() => void pick(card)}
                  onEdit={() => setEditCard(card)}
                  onReject={() => setRejectCardTarget(card)}
                />
              ))}
            </div>
          )}
        </main>

        {/* B3 弹药架（严格引用层） */}
        <aside className="pw-dl-ammo">
          <div className="pw-dl-sec-head">
            <h2>弹药架</h2>
            <span className="hint">只摆 AI 实际引用过的金子/墓碑</span>
          </div>
          {shelf.length === 0 && !ammoState.loading && (
            <div className="pw-blank">
              AI 还没引用过任何金子——它要是说用了，就是穿帮现场。
            </div>
          )}
          {shelf.map((row) => (
            <button key={row.verdict_id} type="button" className="pw-dl-ammo-row" onClick={() => setAmmoVerdict(row)}>
              <span className="pw-dl-ammo-head">
                <b>{row.latest_marker ?? '§?'}</b>
                <span className={`pw-dl-ammo-kind is-${row.verdict_kind}`}>
                  {row.verdict_kind === 'gold' ? '金子' : '墓碑'}
                </span>
                <span className="pw-dl-ammo-count">
                  引用 {row.ref_count} 次 · 最近 {fmtStamp(row.last_used_at)}
                </span>
              </span>
              <span className="pw-dl-ammo-text">{row.text ?? '（原件不在本库）'}</span>
            </button>
          ))}
        </aside>
      </div>

      {/* B4 多源可视化块 */}
      <SourceStats stats={statsState.data ?? null} loading={statsState.loading} range={statsRange} onRange={setStatsRange} onOpenNotes={onOpenNotes} />

      {/* B5 底部对话条（全局证据对话抽屉，PW-22 沿用） */}
      <button type="button" className="pw-cb-chatbar is-opener" onClick={() => { setDrawerQuestion(null); setDrawerOpen(true); }}>
        <span className="pw-cb-chatbar-placeholder">💬 和 AI 说一句……（问证据 / 让它代办 / 它摆账）</span>
        <span className="pw-btn primary">问</span>
      </button>

      {drawerOpen && (
        <div className="pw-cb-drawer" role="dialog" aria-label="全局证据对话">
          <div className="pw-cb-drawer-head">
            <span>全局证据 · AI 能看到候选卡 / 押注卡 / 语料 / 判决簿</span>
            <button type="button" className="pw-btn" onClick={() => setDrawerOpen(false)}>
              收起
            </button>
          </div>
          <div className="pw-cb-drawer-body">
            <ChatPanel key={drawerKey} betId="global" initialQuestion={drawerQuestion} onChanged={reload} />
          </div>
        </div>
      )}

      {summaryOpen && <DaySummaryModal onClose={() => setSummaryOpen(false)} showToast={showToast} />}
      {dirOpen && (
        <DirectionModal current={status?.direction ?? null} busy={false} onClose={() => setDirOpen(false)} onDone={(v) => void saveDirection(v)} />
      )}
      {rejectAllOpen && (
        <RejectAllModal total={candidateCount} current={status?.direction ?? null} busy={sieving} onClose={() => setRejectAllOpen(false)} onDone={(reason, dir, resieveAll) => void rejectAll(reason, dir, resieveAll)} />
      )}
      {rejectCardTarget && (
        <RejectCardModal card={rejectCardTarget} busy={busyId === rejectCardTarget.id} onClose={() => setRejectCardTarget(null)} onDone={(reason) => void reject(rejectCardTarget, reason)} />
      )}
      {ammoVerdict && <AmmoModal row={ammoVerdict} onClose={() => setAmmoVerdict(null)} />}
      {editCard && (
        <PickEditModal
          card={editCard}
          busy={busyId === editCard.id}
          onClose={() => setEditCard(null)}
          onDone={(overrides) => {
            setEditCard(null);
            void pick(editCard, overrides);
          }}
        />
      )}
    </div>
  );
}

/* ---------- B2 候选卡（极简三样 + hover 浮层 + ↗原文） ---------- */
function SieveCardView({
  card,
  wildcard,
  busy,
  onPick,
  onEdit,
  onReject,
}: {
  card: PwSieveCard;
  wildcard?: boolean;
  busy: boolean;
  onPick: () => void;
  onEdit: () => void;
  onReject: () => void;
}) {
  const src = parseQuoteSource(card.quote_source_json);
  const originUrl = src.bvid && src.bvid !== 'voice'
    ? `https://www.bilibili.com/video/${src.bvid}${typeof src.rpid === 'number' ? `#comment${src.rpid}` : ''}`
    : null;
  return (
    <article className={`pw-dl-card${wildcard ? ' is-wild' : ''}`}>
      <div className="pw-dl-card-top">
        <span className="pw-dl-card-score">{card.sort_score.toFixed(1)}</span>
        <span className="pw-dl-card-draft">草稿</span>
        {wildcard && <span className="pw-dl-card-wildtag">少数派</span>}
      </div>
      <p className="pw-dl-card-quote">「{card.quote_text}」</p>
      <p className="pw-dl-card-src">
        {src.uname ? `@${src.uname}` : '匿名'}
        {typeof src.like === 'number' ? ` · ${src.like}赞` : ''}
        {src.bvid && src.bvid !== 'voice' ? ` · ${src.bvid}` : ''}
        {originUrl && (
          <a className="pw-dl-card-origin" href={originUrl} target="_blank" rel="noreferrer">
            ↗原文
          </a>
        )}
      </p>
      {/* TASK-PW-44：方向留痕——这张卡是哪个方向筛出来的，回头对照哪个方向出活 */}
      <p className="pw-dl-card-dir">方向：{card.run_direction ?? '默认'}</p>
      <div className="pw-dl-card-actions">
        <button type="button" className="pw-cl-btn-primary" disabled={busy} onClick={onPick}>
          挑
        </button>
        <button type="button" className="pw-cl-btn-ghost" disabled={busy} onClick={onEdit}>
          改
        </button>
        <button type="button" className="pw-cl-btn-ghost" disabled={busy} onClick={onReject}>
          否
        </button>
      </div>
      {/* hover 浮层：规模/挂钩/新鲜度/排序分明细 */}
      <div className="pw-dl-card-hover" aria-hidden="true">
        <p><b>规模</b>　{card.scale_note ?? `同类约 ${card.scale_value} 条`}</p>
        <p><b>挂钩</b>　{card.hook_note ?? '—'}</p>
        <p><b>新鲜度</b>　{card.freshness_note ?? '—'}</p>
        <p><b>排序分</b>　{card.sort_score.toFixed(2)}（赞数与规模加权，只排序不推荐）</p>
      </div>
    </article>
  );
}

/* ---------- 押注卡草案区（rail 点开内嵌展开） ---------- */
function DraftsPanel({
  bet,
  shelf,
  epoch,
  onEnterBet,
  onChanged,
  onOpenAmmo,
  showToast,
}: {
  bet: PwContentBet | null;
  shelf: PwAmmoRow[];
  epoch: number;
  onEnterBet: (id: string) => void;
  onChanged: () => void;
  onOpenAmmo: (row: PwAmmoRow) => void;
  showToast: (t: { text: string }) => void;
}) {
  const [openSkeletonId, setOpenSkeletonId] = useState<string | null>(null);
  const [rejectDraft, setRejectDraft] = useState<PwContentDraft | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);

  const draftsState = useAsync(
    () => (bet ? pwApi.listBetDrafts(bet.id, 'draft') : Promise.resolve({ drafts: [] as PwContentDraft[] })),
    [bet?.id, epoch],
  );
  const artifactsState = useAsync(
    () => (bet ? pwApi.listBetArtifacts(bet.id) : Promise.resolve({ artifacts: [] })),
    [bet?.id, epoch],
  );
  const drafts = useMemo(() => draftsState.data?.drafts ?? [], [draftsState.data]);
  const artifacts = useMemo(() => artifactsState.data?.artifacts ?? [], [artifactsState.data]);

  // 换一批：fire-and-forget，轮询等新草案落库（自动/手动起草约 1 分钟）
  useEffect(() => {
    if (!regenerating || !bet) return;
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      void draftsState.reload();
      if (tries >= 12) {
        setRegenerating(false);
        window.clearInterval(timer);
      }
    }, 8000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regenerating, bet?.id]);

  useEffect(() => {
    if (regenerating && drafts.length > 0) setRegenerating(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts.length]);

  if (!bet) return null;

  const finalize = async (draft: PwContentDraft) => {
    setBusyId(draft.id);
    try {
      await pwApi.finalizeContentDraft(draft.id);
      showToast({ text: '已定稿——产出物挂到押注卡，押注继续在途' });
      draftsState.reload();
      artifactsState.reload();
      onChanged();
    } catch (error) {
      showToast({ text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyId(null);
    }
  };

  const regenerate = async () => {
    try {
      await pwApi.runDraftBatch(bet.id);
      setRegenerating(true);
      showToast({ text: '起草中（约 1 分钟），出来自动摆上' });
    } catch (error) {
      showToast({ text: error instanceof Error ? error.message : String(error) });
    }
  };

  const openMarker = (marker: string) => {
    const row = shelf.find((item) => item.latest_marker === marker);
    if (row) onOpenAmmo(row);
    else showToast({ text: `${marker} 不在弹药架上（未被引用过或编号已变）` });
  };

  return (
    <section className="pw-dl-drafts">
      <div className="pw-dl-drafts-head">
        <b>押注「{bet.title}」</b>
        <span className="hint">素材草案 {drafts.length} 份对照（各露一行，判断秒级；引用已落库）</span>
        <button type="button" className="pw-dl-bet-dive" onClick={() => onEnterBet(bet.id)}>
          去深挖 →
        </button>
      </div>
      {drafts.length === 0 && !draftsState.loading && !regenerating && (
        <div className="pw-blank">
          这张押注还没有草案——若刚确认成立，起草正在后台进行（约 1 分钟）自动摆上；也可点「换一批」手动来一轮。
        </div>
      )}
      {regenerating && <p className="hint pw-dl-drafts-busy">起草中（约 1 分钟）…出来自动摆上</p>}
      {drafts.map((draft, i) => (
        <div key={draft.id} className="pw-dl-draft">
          <div className="pw-dl-draft-row">
            <span className="pw-dl-draft-route">{['①', '②', '③', '④', '⑤', '⑥'][i] ?? `${i + 1}.`} 路子：{draft.route}</span>
            <span className="pw-dl-draft-title">标题候选：「{draft.title_candidate}」</span>
            <button
              type="button"
              className="pw-btn"
              onClick={() => setOpenSkeletonId(openSkeletonId === draft.id ? null : draft.id)}
            >
              骨架 {openSkeletonId === draft.id ? '▴' : '▾'}
            </button>
            <button type="button" className="pw-cl-btn-primary" disabled={busyId === draft.id} onClick={() => void finalize(draft)}>
              定稿
            </button>
            <button type="button" className="pw-cl-btn-ghost" disabled={busyId === draft.id} onClick={() => setRejectDraft(draft)}>
              否掉
            </button>
          </div>
          {openSkeletonId === draft.id && (
            <ol className="pw-dl-skeleton">
              {parseSkeleton(draft.skeleton_json).map((node, j) => (
                <li key={j}>
                  <span>{node.text ?? '—'}</span>
                  {node.gold_ref && (
                    <button type="button" className="pw-dl-goldref" title="点验原件" onClick={() => openMarker(String(node.gold_ref))}>
                      {String(node.gold_ref)}
                    </button>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      ))}
      <div className="pw-dl-drafts-foot">
        <button type="button" className="pw-btn" disabled={regenerating} onClick={() => void regenerate()}>
          {regenerating ? '起草中…' : '换一批'}
        </button>
        {artifacts.length > 0 && (
          <span className="pw-dl-artifacts">
            已挂产出物：
            {artifacts.map((a) => (
              <span key={a.id} className="pw-dl-artifact" title={a.note ?? ''}>
                {a.title ?? a.url ?? a.type}
              </span>
            ))}
          </span>
        )}
      </div>
      {rejectDraft && (
        <RejectDraftModal
          draft={rejectDraft}
          busy={busyId === rejectDraft.id}
          onClose={() => setRejectDraft(null)}
          onDone={async (reason) => {
            setBusyId(rejectDraft.id);
            try {
              await pwApi.rejectContentDraft(rejectDraft.id, reason);
              showToast({ text: '已否掉，进 bad case 集（回流跑分用）' });
              setRejectDraft(null);
              draftsState.reload();
              onChanged();
            } catch (error) {
              showToast({ text: error instanceof Error ? error.message : String(error) });
            } finally {
              setBusyId(null);
            }
          }}
        />
      )}
    </section>
  );
}

/* ---------- TASK-PW-43：改筛子方向弹层；TASK-PW-51：弹层底部方向成绩单 ---------- */
function DirectionModal({
  current,
  busy,
  onClose,
  onDone,
}: {
  current: string | null;
  busy: boolean;
  onClose: () => void;
  onDone: (direction: string) => void;
}) {
  const [direction, setDirection] = useState(current ?? '');
  const statsState = useAsync(() => pwApi.sieveDirectionStats(), []);
  const statRows = statsState.data?.rows ?? [];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onDone(direction.trim());
  };
  return (
    <PwModal title="改筛子方向" sub="方向由你定，筛子只负责朝这个方向搬运摆盘；清空 = 恢复默认（捞路人困惑），下一轮筛生效" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="pw-field">
          <label>当前方向：{current ?? '默认（捞路人困惑）'}</label>
          <input value={direction} onChange={(e) => setDirection(e.target.value)} autoFocus placeholder="例：AI 办公提效 / 编程工具实测对比" />
        </div>
        <div className="pw-modal-foot">
          <button type="button" className="pw-btn" onClick={onClose}>
            再想想
          </button>
          <button type="submit" className="pw-btn primary" disabled={busy}>
            {busy ? '保存中…' : direction.trim() ? '确认换方向' : '清空恢复默认'}
          </button>
        </div>
      </form>
      {statRows.length > 0 && (
        <div className="pw-dir-stats">
          <p className="pw-dir-stats-head">方向成绩单 · 出活率 = 挑÷(挑+否)</p>
          <table>
            <thead>
              <tr><th>方向</th><th>轮数</th><th>出卡</th><th>挑</th><th>否</th><th>出活率</th></tr>
            </thead>
            <tbody>
              {statRows.map((row) => {
                const decided = row.picked + row.rejected;
                return (
                  <tr key={row.direction}>
                    <td>{row.direction}</td>
                    <td>{row.runs}</td>
                    <td>{row.cards}</td>
                    <td>{row.picked}</td>
                    <td>{row.rejected}</td>
                    <td>{decided > 0 ? `${Math.round((row.picked / decided) * 100)}%` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </PwModal>
  );
}

/* ---------- TASK-PW-43：全否重筛弹层（可顺手换方向）；TASK-PW-48：加老料重筛勾选 ---------- */
function RejectAllModal({
  total,
  current,
  busy,
  onClose,
  onDone,
}: {
  total: number;
  current: string | null;
  busy: boolean;
  onClose: () => void;
  onDone: (reason: string, direction: string, resieveAll: boolean) => void;
}) {
  const [reason, setReason] = useState('');
  const [direction, setDirection] = useState('');
  const [resieveAll, setResieveAll] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onDone(reason.trim(), direction.trim(), resieveAll);
  };
  return (
    <PwModal title={`全否当前 ${total} 张候选卡`} sub="否掉后触发重筛；候选卡只是草稿，否了进审计不心疼" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="pw-field">
          <label>否掉理由（可空）</label>
          <input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus placeholder="例：全是最大公约数，没一条扎手" />
        </div>
        <div className="pw-field">
          <label>换个方向？（留空 = 原方向「{current ?? '默认（捞路人困惑）'}」重筛）</label>
          <input value={direction} onChange={(e) => setDirection(e.target.value)} placeholder="例：AI 编程工具实测对比" />
        </div>
        <div className="pw-field">
          <label className="pw-check">
            <input type="checkbox" checked={resieveAll} onChange={(e) => setResieveAll(e.target.checked)} />
            把现有语料也重过一遍（老料重筛——可能把挑过的评论再筛出来，否掉即可）
          </label>
        </div>
        <div className="pw-modal-foot">
          <button type="button" className="pw-btn" onClick={onClose}>
            再想想
          </button>
          <button type="submit" className="pw-btn primary" disabled={busy}>
            {busy ? '处理中…' : direction.trim() ? '全否 + 换方向重筛' : '全否重筛'}
          </button>
        </div>
      </form>
    </PwModal>
  );
}

/* ---------- TASK-PW-49：单卡否决弹层（理由可空） ---------- */
function RejectCardModal({
  card,
  busy,
  onClose,
  onDone,
}: {
  card: PwSieveCard;
  busy: boolean;
  onClose: () => void;
  onDone: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onDone(reason.trim());
  };
  return (
    <PwModal title="否掉这张候选卡" sub={`「${card.quote_text.slice(0, 40)}${card.quote_text.length > 40 ? '…' : ''}」→ 进审计，不再出现`} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="pw-field">
          <label>否掉理由（可空）</label>
          <input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus placeholder="例：不对味 / 和方向无关" />
        </div>
        <div className="pw-modal-foot">
          <button type="button" className="pw-btn" onClick={onClose}>
            再想想
          </button>
          <button type="submit" className="pw-btn primary" disabled={busy}>
            {busy ? '处理中…' : '确认否掉'}
          </button>
        </div>
      </form>
    </PwModal>
  );
}

/* ---------- 否掉草案（填理由进 bad case 集） ---------- */
function RejectDraftModal({
  draft,
  busy,
  onClose,
  onDone,
}: {
  draft: PwContentDraft;
  busy: boolean;
  onClose: () => void;
  onDone: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onDone(reason.trim());
  };
  return (
    <PwModal title="否掉这份草案" sub={`「${draft.title_candidate}」（${draft.route}）→ 进 bad case 集，回流跑分用`} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="pw-field">
          <label>否掉理由（写一句，AI 下次起草会读到）</label>
          <input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus placeholder="例：标题太平 / 路子不对味" />
        </div>
        <div className="pw-modal-foot">
          <button type="button" className="pw-btn" onClick={onClose}>
            再想想
          </button>
          <button type="submit" className="pw-btn primary" disabled={busy}>
            {busy ? '处理中…' : '确认否掉'}
          </button>
        </div>
      </form>
    </PwModal>
  );
}

/* ---------- B4 多源可视化块 ---------- */
function SourceStats({
  stats,
  loading,
  range,
  onRange,
  onOpenNotes,
}: {
  stats: { comparison: import('../lib/api').PwSourceComparison; ranking: import('../lib/api').PwOutputRanking } | null;
  loading: boolean;
  range: 7 | 30;
  onRange: (r: 7 | 30) => void;
  onOpenNotes: () => void;
}) {
  const [tab, setTab] = useState<'comparison' | 'ranking'>('comparison');
  const maxCandidates = Math.max(1, ...(stats?.comparison.sources.map((s) => s.candidates) ?? [1]));
  const maxProduced = Math.max(1, ...(stats?.ranking.ranking.map((r) => r.produced) ?? [1]));
  return (
    <section className="pw-dl-stats">
      <div className="pw-dl-sec-head">
        <h2>多源可视化</h2>
        <span className="pw-dl-stats-tabs">
          <button type="button" className={tab === 'comparison' ? 'is-on' : ''} onClick={() => setTab('comparison')}>
            来源对比
          </button>
          <button type="button" className={tab === 'ranking' ? 'is-on' : ''} onClick={() => setTab('ranking')}>
            产出榜
          </button>
        </span>
        <select
          className="pw-dl-stats-range"
          value={range}
          onChange={(e) => onRange(Number(e.target.value) === 30 ? 30 : 7)}
          aria-label="统计时间范围"
        >
          <option value={7}>近 7 天</option>
          <option value={30}>近 30 天</option>
        </select>
      </div>
      {loading && <p className="hint">统计中…</p>}
      {!loading && stats && tab === 'comparison' && (
        <div className="pw-dl-stats-rows">
          {stats.comparison.sources.map((s) => (
            <div key={s.bvid} className="pw-dl-stats-row">
              <span className="pw-dl-stats-name" title={s.title ?? s.bvid}>
                {s.title ? `${s.title.slice(0, 14)}${s.title.length > 14 ? '…' : ''}` : s.bvid}
              </span>
              <span className="pw-dl-stats-bar">
                <i style={{ width: `${Math.round((s.candidates / maxCandidates) * 100)}%` }} />
              </span>
              <span className="pw-dl-stats-num">
                {s.comments}评论 · {s.candidates}候选 · {s.wildcards}少数派 · {s.golds}金子 · 入决策链{s.intoChain}
              </span>
            </div>
          ))}
          {stats.comparison.notesLane && (
            <div className="pw-dl-stats-row is-notes">
              <span className="pw-dl-stats-name">笔记</span>
              <span className="pw-dl-stats-bar">
                <i
                  style={{
                    width: `${Math.min(100, Math.round((stats.comparison.notesLane.addedInRange / maxCandidates) * 100))}%`,
                  }}
                />
              </span>
              <span className="pw-dl-stats-num">
                共{stats.comparison.notesLane.total}条 · 近{stats.comparison.rangeDays}天新增
                {stats.comparison.notesLane.addedInRange} · 不进归因链
              </span>
              <button type="button" className="pw-dl-stats-go" onClick={onOpenNotes}>
                去笔记屏 ↗
              </button>
            </div>
          )}
          {stats.comparison.pendingLanes.map((lane) => (
            <div key={lane} className="pw-dl-stats-row is-pending">
              <span className="pw-dl-stats-name">{lane}</span>
              <span className="pw-dl-stats-bar">
                <i style={{ width: '100%' }} />
              </span>
              <span className="pw-dl-stats-num">待来源通路</span>
            </div>
          ))}
        </div>
      )}
      {!loading && stats && tab === 'ranking' && (
        <div className="pw-dl-stats-rows">
          {stats.ranking.ranking.map((r) => (
            <div key={r.bvid} className="pw-dl-stats-row">
              <span className="pw-dl-stats-name" title={r.title ?? r.bvid}>
                {r.title ? `${r.title.slice(0, 14)}${r.title.length > 14 ? '…' : ''}` : r.bvid}
              </span>
              <span className="pw-dl-stats-bar">
                <i style={{ width: `${Math.round((r.produced / maxProduced) * 100)}%` }} />
              </span>
              <span className="pw-dl-stats-num">
                产出{r.produced} · 被挑{r.picked} · 被引用{r.refCount}
              </span>
            </div>
          ))}
          {stats.ranking.ranking.length === 0 && <div className="pw-blank">还没有来源产出。</div>}
        </div>
      )}
    </section>
  );
}

/* ---------- B3 弹药架详情（原件全文 + 引用记录） ---------- */
function AmmoModal({ row, onClose }: { row: PwAmmoRow; onClose: () => void }) {
  const refsState = useAsync(() => pwApi.ammoRefs(row.verdict_id), [row.verdict_id]);
  const refs = refsState.data?.refs ?? [];
  return (
    <PwModal
      title={`${row.latest_marker ?? ''} ${row.verdict_kind === 'gold' ? '金子' : '墓碑'}原件`}
      sub={`AI 引用 ${row.ref_count} 次 · 首次 ${fmtStamp(row.first_used_at)} · 最近 ${fmtStamp(row.last_used_at)}`}
      onClose={onClose}
    >
      <p className="pw-dl-ammo-full">{row.text ?? '（原件不在本库）'}</p>
      <h4 className="pw-dl-ammo-loghead">引用记录（何时 / 哪条消息 / 哪份草案）</h4>
      {refsState.loading && <p className="hint">读取中…</p>}
      <ul className="pw-dl-ammo-log">
        {refs.map((ref) => (
          <li key={ref.id}>
            <b>{fmtStamp(ref.created_at)}</b>　{ref.marker}　{ref.source_label}
          </li>
        ))}
      </ul>
    </PwModal>
  );
}

/* ---------- 收工小结弹层 ---------- */
function DaySummaryModal({
  onClose,
  showToast,
}: {
  onClose: () => void;
  showToast: (t: { text: string }) => void;
}) {
  const state = useAsync(() => pwApi.daySummary(), []);
  const summary = state.data?.summary ?? null;
  const text = state.data?.text ?? '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      showToast({ text: '已复制——直接粘到 agent 窗口存档' });
    } catch {
      showToast({ text: '复制失败，请手动全选文本框复制' });
    }
  };

  return (
    <PwModal title={`收工小结 · ${summary?.date ?? ''}`} sub="每个数字都能和今天的事件流水一笔一笔对平" onClose={onClose}>
      {state.loading && <p className="hint">对账中…</p>}
      {summary && <DaySummaryBody summary={summary} />}
      {summary && (
        <div className="pw-dl-summary-export">
          <label>导出文本（一键发 agent 窗口存档）</label>
          <textarea readOnly value={text} rows={8} onFocus={(e) => e.target.select()} />
          <div className="pw-modal-foot">
            <button type="button" className="pw-btn" onClick={onClose}>
              收工
            </button>
            <button type="button" className="pw-btn primary" onClick={() => void copy()}>
              复制文本
            </button>
          </div>
        </div>
      )}
    </PwModal>
  );
}

function DaySummaryBody({ summary: s }: { summary: PwDaySummary }) {
  const rejectCount = s.cardRejects.length + s.draftRejects.length;
  return (
    <div className="pw-dl-summary">
      <p className="pw-dl-summary-counts">
        挑 {s.picks.length} · 否 {rejectCount} · 押 {s.betConfirms.length} · 定稿 {s.finalizes.length} · 起草{' '}
        {s.draftRunBatches} 批（{s.draftsCreated} 份）· AI 代办 {s.execActions.length} 件 · 自主 {s.autoActions.length} 件
      </p>
      {s.picks.length > 0 && (
        <SummarySection title={`挑卡（${s.picks.length}）`}>
          {s.picks.map((p, i) => (
            <li key={i}>
              {p.time} 「{p.quote}」→ {p.betTitle ?? '—'}
              {p.edited ? '（挑改）' : ''}
              {p.actor === 'ai' ? '（AI 代办）' : ''}
            </li>
          ))}
        </SummarySection>
      )}
      {s.betConfirms.length > 0 && (
        <SummarySection title={`押注转正（${s.betConfirms.length}）`}>
          {s.betConfirms.map((b, i) => (
            <li key={i}>
              {b.time} 《{b.betTitle ?? '—'}》{b.actor === 'ai' ? '（AI 代办）' : ''}
            </li>
          ))}
        </SummarySection>
      )}
      {s.finalizes.length > 0 && (
        <SummarySection title={`定稿（${s.finalizes.length}）`}>
          {s.finalizes.map((f, i) => (
            <li key={i}>
              {f.time} {f.draftRoute}《{f.draftTitle}》→ {f.betTitle ?? '—'}
            </li>
          ))}
        </SummarySection>
      )}
      {s.cardRejects.length + s.draftRejects.length > 0 && (
        <SummarySection title={`否（${rejectCount}）`}>
          {s.cardRejects.map((r, i) => (
            <li key={`c${i}`}>
              {r.time} 否卡「{r.quote}」{r.reason ? `｜理由：${r.reason}` : ''}
            </li>
          ))}
          {s.draftRejects.map((r, i) => (
            <li key={`d${i}`}>
              {r.time} 否草案《{r.title}》（{r.route}）{r.reason ? `｜理由：${r.reason}` : ''}
            </li>
          ))}
        </SummarySection>
      )}
      {s.draftRuns.length > 0 && (
        <SummarySection title={`起草批次（${s.draftRunBatches}）`}>
          {s.draftRuns.map((d, i) => (
            <li key={i}>
              {d.time} 起草「{d.trigger}」→ {d.created} 份{d.error ? `｜失败：${d.error}` : ''}
            </li>
          ))}
        </SummarySection>
      )}
      {s.execActions.length + s.autoActions.length > 0 && (
        <SummarySection title={`AI 代办与自主（${s.execActions.length + s.autoActions.length}）· 查账逐笔摆依据`}>
          {s.execActions.map((a, i) => (
            <li key={`e${i}`}>
              {a.time} {a.eventType} {a.object}｜依据：{a.instruction ?? '无引用！'}
            </li>
          ))}
          {s.autoActions.map((a, i) => (
            <li key={`a${i}`}>
              {a.time} {a.eventType} {a.object}｜自主（无需指令）
            </li>
          ))}
        </SummarySection>
      )}
      {s.otherCount > 0 && (
        <p className="hint">
          另有其余系统事件 {s.otherCount} 笔（{s.otherDist.map((d) => `${d.label}×${d.count}`).join('、')}）。
        </p>
      )}
      {s.totalEvents === 0 && <p className="pw-blank">今天没有协作台事件。</p>}
    </div>
  );
}

function SummarySection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="pw-dl-summary-sec">
      <h4>{title}</h4>
      <ul>{children}</ul>
    </div>
  );
}

/* ---------- 改（轻编辑后挑中） ---------- */
function PickEditModal({
  card,
  busy,
  onClose,
  onDone,
}: {
  card: PwSieveCard;
  busy: boolean;
  onClose: () => void;
  onDone: (overrides: PwContentBetOverrides) => void;
}) {
  const [title, setTitle] = useState(card.quote_text.slice(0, 30));
  const [conversionSignal, setConversionSignal] = useState('');
  const [metricTarget, setMetricTarget] = useState('');
  const [reviewDate, setReviewDate] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const overrides: PwContentBetOverrides = {};
    if (title.trim()) overrides.title = title.trim();
    if (conversionSignal.trim()) overrides.conversionSignal = conversionSignal.trim();
    if (metricTarget.trim()) overrides.metricTarget = metricTarget.trim();
    if (reviewDate) overrides.reviewDate = reviewDate;
    onDone(overrides);
  };

  return (
    <PwModal title="改两个字再挑" sub="空着的字段按默认来；确认后转成内容押注卡" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="pw-field">
          <label>标题</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </div>
        <div className="pw-field">
          <label>转化信号（要什么算成，默认：私域加群/问工具人数）</label>
          <input value={conversionSignal} onChange={(e) => setConversionSignal(e.target.value)} />
        </div>
        <div className="pw-field">
          <label>信号目标（默认：10）</label>
          <input value={metricTarget} onChange={(e) => setMetricTarget(e.target.value)} inputMode="numeric" />
        </div>
        <div className="pw-field">
          <label>看结果日（默认：7 天后）</label>
          <input type="date" value={reviewDate} onChange={(e) => setReviewDate(e.target.value)} />
        </div>
        <div className="pw-modal-foot">
          <button type="button" className="pw-btn" onClick={onClose}>
            再想想
          </button>
          <button type="submit" className="pw-btn primary" disabled={busy}>
            {busy ? '转卡中…' : '确认挑中'}
          </button>
        </div>
      </form>
    </PwModal>
  );
}

/* ============================================================
   层 2 · 单卡钻取（沿用不动）
   ============================================================ */
function BetLayer({
  bet,
  initialQuestion,
  onBack,
  onChanged,
}: {
  bet: PwContentBet;
  initialQuestion: string | null;
  onBack: () => void;
  onChanged: () => void;
}) {
  return (
    <div className="pw-cb-detail">
      <div className="pw-cb-detail-top">
        <button type="button" className="pw-btn" onClick={onBack}>
          ← 返回大屏
        </button>
        <span className="pw-cb-top-brand">{bet.title}</span>
        <span className="pw-cb-top-status">内容押注卡 · {bet.status === 'pending' ? '验证中' : bet.status}</span>
      </div>
      <div className="pw-cb-detail-grid">
        <div className="pw-cb-detail-left">
          <dl className="pw-cb-betlines">
            <div className="pw-cb-betline">
              <dt>演示困惑</dt>
              <dd>
                {bet.thesis.split('\n').map((line, i) => (
                  <p key={i}>{line}</p>
                ))}
              </dd>
            </div>
            <div className="pw-cb-betline">
              <dt>转化信号</dt>
              <dd>
                {bet.metric ?? '—'}
                {bet.metric_target ? ` · 目标 ${bet.metric_target}` : ''}
              </dd>
            </div>
            <div className="pw-cb-betline">
              <dt>看结果日</dt>
              <dd>
                {bet.checkout_date ? `${fmtDay(bet.checkout_date)} · ${daysText(bet.checkout_date)}` : '—'}
              </dd>
            </div>
          </dl>
          <div className="pw-cb-placeholder">
            <h3>素材区</h3>
            <p>素材草案已上决策层（层1 押注卡下内嵌草案区：三份路子对照 + 骨架 §N + 定稿/否掉/换一批）。</p>
            <p className="hint">本层保留按卡深挖对话；素材制作在层1 草案区完成。</p>
          </div>
        </div>
        <div className="pw-cb-detail-right">
          <ChatPanel betId={bet.id} initialQuestion={initialQuestion} onChanged={onChanged} />
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   对话深挖（复用 PW-15 SSE；层1 抽屉 global / 层2 按卡隔离）
   ============================================================ */
interface LiveTurn {
  userText: string;
  aiText: string;
  chips: string[];
  error: string | null;
}

function ChatPanel({
  betId,
  initialQuestion,
  onChanged,
}: {
  betId: string;
  initialQuestion: string | null;
  onChanged: () => void;
}) {
  const msgsState = useAsync(() => pwApi.collabMessages(betId), [betId]);
  const ctxState = useAsync(() => pwApi.collabContext(betId), [betId]);
  const messages = useMemo(() => msgsState.data?.messages ?? [], [msgsState.data]);

  const refTitle = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of ctxState.data?.golds ?? []) map.set(g.ref, `金子 ${g.ref} · ${g.text}`);
    for (const t of ctxState.data?.tombs ?? []) map.set(t.ref, `墓碑 ${t.ref} · ${t.causeOfDeath}`);
    return map;
  }, [ctxState.data]);

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const askedRef = useRef(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, live]);

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setInput('');
    setSending(true);
    setLive({ userText: trimmed, aiText: '', chips: [], error: null });
    let failed: string | null = null;
    await streamCollabMessage(betId, trimmed, {
      onToolStart: (tool) => setLive((l) => (l ? { ...l, chips: [...l.chips, tool] } : l)),
      onDelta: (delta) => setLive((l) => (l ? { ...l, aiText: l.aiText + delta } : l)),
      onRunEnd: (reason, error) => {
        if (reason === 'error') failed = error ?? '协作台出错';
      },
      onError: (error) => {
        failed = error.message;
      },
    });
    setSending(false);
    if (failed) {
      const errText = failed;
      setLive((l) => (l ? { ...l, error: errText } : l));
      return;
    }
    setLive(null);
    msgsState.reload();
    onChanged();
  };

  // 层 1 对话条带来的问题：进层 2 自动发一次
  useEffect(() => {
    if (initialQuestion && !askedRef.current && !msgsState.loading) {
      askedRef.current = true;
      void send(initialQuestion);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuestion, msgsState.loading]);

  return (
    <section className="pw-cl-chat is-deepdive">
      <div className="pw-cb-chat-head">{betId === 'global' ? '全局证据对话 · 跨卡可问' : '对话深挖 · 按卡隔离'}</div>
      <div className="pw-cl-chat-scroll" ref={scrollRef}>
        {messages.length === 0 && !live && !msgsState.loading && (
          <div className="pw-blank">顺着疑点问。引用会带原文，结论你来下。</div>
        )}
        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="pw-cl-msg pw-cl-msg-user">
              <div className="pw-cl-msg-role">
                <span className="pw-cl-role-dot" aria-hidden="true" />
                你
              </div>
              <div className="pw-cl-msg-body">{m.text}</div>
            </div>
          ) : (
            <AiMessage key={m.id} text={m.text} toolCallsJson={m.tool_calls_json} refTitle={refTitle} />
          ),
        )}
        {live && (
          <>
            <div className="pw-cl-msg pw-cl-msg-user">
              <div className="pw-cl-msg-role">
                <span className="pw-cl-role-dot" aria-hidden="true" />
                你
              </div>
              <div className="pw-cl-msg-body">{live.userText}</div>
            </div>
            <div className="pw-cl-msg pw-cl-msg-ai">
              <div className="pw-cl-msg-role">
                <span className="pw-cl-role-dot" aria-hidden="true" />
                镇纸 AI · 副驾驶
              </div>
              <div className="pw-cl-msg-body">
                {live.chips.length > 0 && <ToolChips tools={live.chips} />}
                <div className="md">
                  <MarkdownView content={live.aiText} citeTitle={citeTitleOf(refTitle)} />
                </div>
                {live.error && <p style={{ color: '#a34a2a' }}>出错：{live.error}</p>}
              </div>
            </div>
          </>
        )}
      </div>
      <div className="pw-cl-composer">
        <div className="pw-cl-composer-row">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void send(input);
            }}
            placeholder={betId === 'global' ? '就今天的大屏追问……' : '就这张卡追问……'}
            aria-label={betId === 'global' ? '就今天的大屏追问' : '就这张卡追问'}
            disabled={sending}
          />
          <button
            type="button"
            className="pw-cl-btn-send"
            aria-label="发送"
            disabled={sending || !input.trim()}
            onClick={() => void send(input)}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M 2.5 8 L 13.5 8 M 13.5 8 L 9 3.5 M 13.5 8 L 9 12.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
        <div className="pw-cl-composer-note">云端旗舰模型 · 干净上下文 + 金子墓碑与候选卡注入</div>
      </div>
    </section>
  );
}

/* ---------- AI 消息（tool-chips + 段落 + gold-ref） ---------- */
function AiMessage({
  text,
  toolCallsJson,
  refTitle,
}: {
  text: string;
  toolCallsJson: string;
  refTitle: Map<string, string>;
}) {
  const tools = parseToolNames(toolCallsJson);
  return (
    <div className="pw-cl-msg pw-cl-msg-ai">
      <div className="pw-cl-msg-role">
        <span className="pw-cl-role-dot" aria-hidden="true" />
        镇纸 AI · 副驾驶
      </div>
      <div className="pw-cl-msg-body">
        {tools.length > 0 && <ToolChips tools={tools} />}
        <div className="md">
          <MarkdownView content={text} citeTitle={citeTitleOf(refTitle)} />
        </div>
      </div>
    </div>
  );
}

function ToolChips({ tools }: { tools: string[] }) {
  return (
    <div className="pw-cl-tool-chips" role="status" aria-label="AI 工具执行进度">
      {tools.map((tool, i) => (
        <span key={`${tool}-${i}`} className="pw-cl-chip">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path
              d="M 2 6.2 L 4.8 9 L 10 3"
              stroke="#3f6e5a"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {TOOL_LABEL[tool] ?? tool}
        </span>
      ))}
    </div>
  );
}

/* ---------- 纯函数助手 ---------- */

function parseToolNames(json: string): string[] {
  try {
    const arr = JSON.parse(json) as Array<{ name?: unknown }>;
    if (!Array.isArray(arr)) return [];
    return arr.map((c) => String(c?.name ?? '')).filter(Boolean);
  } catch {
    return [];
  }
}

/** §N 角标的悬停文案：从装配上下文的金子/墓碑清单取原文 */
function citeTitleOf(refTitle: Map<string, string>): (n: number) => string | undefined {
  return (n) => refTitle.get(`§${n}`);
}

/* ---------- 简报 14：模式与对账条（系统视角，只读） ---------- */

const RUN_KIND_LABEL: Record<string, string> = {
  manual_event: '手动记录',
  sieve: '筛子',
  ai_draft: 'AI 起草',
  ai_auto: '自动任务',
  pt_chain_export: '链导出',
  collab: '对话',
  exec: '执行',
};

function ModeStrip({ epoch }: { epoch: number }) {
  const state = useAsync(() => pwApi.modeBar(), [epoch]);
  const mb = state.data;

  // 最近动态按 kind 归并计数，取前 3 类
  const runSummary = useMemo(() => {
    if (!mb) return '';
    const counts = new Map<string, number>();
    for (const r of mb.recentRuns) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
    return [...counts.entries()]
      .slice(0, 3)
      .map(([kind, n]) => `${RUN_KIND_LABEL[kind] ?? kind}×${n}`)
      .join(' ');
  }, [mb]);

  // 明细收进悬停：条上只摆总数，防一行塞太满
  const tip = mb
    ? [
        `待你判断明细：押注草稿 ${mb.pendingReview.betDrafts} · 结账草案 ${mb.pendingReview.settleDrafts} · 语料 ${mb.pendingReview.corpusProposed}`,
        mb.writeDiscipline,
        '（系统视角：外部 agent 窗口的实时状态不在本系统内）',
      ].join('\n')
    : undefined;

  return (
    <div className="pw-modebar" title={tip}>
      <span className="pw-modebar-item">
        待你判断 <b>{mb?.pendingReview.total ?? '—'}</b>
      </span>
      <span className="pw-modebar-sep">·</span>
      <span className="pw-modebar-item">
        上次动态 {mb?.lastActivityAt ? fmtTime(mb.lastActivityAt) : '—'}
      </span>
      {runSummary && (
        <>
          <span className="pw-modebar-sep">·</span>
          <span className="pw-modebar-item pw-modebar-runs">最近：{runSummary}</span>
        </>
      )}
      <span className="pw-modebar-sep">·</span>
      <span className="pw-modebar-item pw-modebar-discipline">铸币权在人</span>
    </div>
  );
}
