/**
 * 押注台（PW-02，对应设计稿 papertable-workbench.html）：
 * 默认首页=承诺总账（成熟度 blotter）+ 异常队列（简报21 第一期）；
 * 选中某注进入单卡驾驶舱（押注卡—手绘连接线—分支卡 + 开干位槽）。
 * 左栏项目卡片树 + 右栏判决簿 + 底部创作决策闭环带保留。
 * 数据：/api/pw/bets、/bets/ledger、/due、/verdicts、/artifacts、/data-docs、/settle。
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  pwApi,
  type PwArtifact,
  type PwArtifactType,
  type PwBet,
  type PwBetMaturity,
  type PwDataDoc,
  type PwDispositionKind,
  type PwLedgerRow,
  type PwOutcome,
  type PwPromotionLevel,
  type PwVerdict,
} from '../lib/api';
import { useStore } from '../store';
import { betNoMap, daysText, fmtDay, parseMetrics, useAsync } from './hooks';
import { GoldSeal, OUTCOME_META, PwModal, StatusPill, TombFig } from './ui';

const ARTIFACT_TYPE_LABEL: Record<PwArtifactType, string> = {
  video: '成片',
  livestream: '直播',
  article: '图文',
  cover: '封面',
  link: '链接',
};

/** 开干位三槽：槽名 → 收纳的产出物类型 + 空槽「挂载」预设类型 */
const SLOT_DEFS: Array<{ name: string; types: PwArtifactType[]; preset: PwArtifactType }> = [
  { name: '成片', types: ['video', 'livestream', 'article'], preset: 'video' },
  { name: '封面', types: ['cover'], preset: 'cover' },
  { name: '发布链接', types: ['link'], preset: 'link' },
];

const LOOP_NODES = ['起心动念', '想清楚', '押注', '开干', '数据回流', '结账'];

export function Workbench({
  epoch,
  onChanged,
  onGoExplore,
  onNav,
}: {
  epoch: number;
  onChanged: () => void;
  onGoExplore: () => void;
  onNav: (s: 'sources') => void;
}) {
  const { showToast } = useStore();
  const betsState = useAsync(() => pwApi.listBets(), [epoch]);
  const dueState = useAsync(() => pwApi.dueBets(), [epoch]);
  const verdictsState = useAsync(() => pwApi.listVerdicts(), [epoch]);
  const connectionsState = useAsync(() => pwApi.listConnections(), [epoch]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modal, setModal] = useState<null | 'create' | 'attach' | 'doc' | 'settle'>(null);
  // 简报23：草稿转正（预检闸门 + 先例处置）
  const [activateDraft, setActivateDraft] = useState<PwBet | null>(null);
  const draftsState = useAsync(() => pwApi.listBets('draft'), [epoch]);
  const draftBets = useMemo(() => draftsState.data?.bets ?? [], [draftsState.data]);
  const [attachPreset, setAttachPreset] = useState<PwArtifactType | undefined>(undefined);
  const betCardRef = useRef<HTMLElement>(null);
  // TASK-PW-72：通知链路测试推送按钮的防连点
  const [notifyBusy, setNotifyBusy] = useState(false);

  const bets = useMemo(() => betsState.data?.bets ?? [], [betsState.data]);
  // 卡片树只列非 draft、非作废押注（作废不进判断账）；编号仍按全量（与后端列表一致）
  const liveBets = useMemo(() => bets.filter((b) => b.status !== 'draft' && b.status !== 'void'), [bets]);
  const noMap = useMemo(() => betNoMap(bets), [bets]);
  const dueIds = useMemo(() => new Set((dueState.data?.bets ?? []).map((b) => b.id)), [dueState.data]);
  const verdictByBet = useMemo(() => {
    const map = new Map<string, PwOutcome>();
    for (const v of verdictsState.data?.verdicts ?? []) {
      if (v.outcome !== 'void') map.set(v.bet_id, v.outcome);
    }
    return map;
  }, [verdictsState.data]);
  const needsHumanCount = useMemo(
    () => (connectionsState.data?.connections ?? []).filter((c) => c.status === 'needs_human').length,
    [connectionsState.data],
  );

  // 简报21：押注台首页=承诺总账（blotter）+异常队列；选中某注才进单卡驾驶舱
  const ledgerState = useAsync(() => pwApi.betsLedger(), [epoch]);
  const ledgerRows = useMemo(() => ledgerState.data?.rows ?? [], [ledgerState.data]);

  // 新建后待选中的注：等列表刷新出它再切，避免被下面的回落逻辑顶掉
  const wantSelectRef = useRef<string | null>(null);

  // 只在「新建后指定」时自动进驾驶舱；选中的注消失时回落总账；不再默认自动选中
  useEffect(() => {
    if (wantSelectRef.current) {
      if (liveBets.some((b) => b.id === wantSelectRef.current)) {
        setSelectedId(wantSelectRef.current);
        wantSelectRef.current = null;
      }
      return;
    }
    if (selectedId && !liveBets.some((b) => b.id === selectedId)) {
      setSelectedId(null);
    }
  }, [liveBets, selectedId]);

  const bet = liveBets.find((b) => b.id === selectedId) ?? null;

  const artifactsState = useAsync(
    () => (selectedId ? pwApi.listArtifacts(selectedId) : Promise.resolve(null)),
    [selectedId, epoch],
  );
  const docsState = useAsync(
    () => (selectedId ? pwApi.listDataDocs(selectedId) : Promise.resolve(null)),
    [selectedId, epoch],
  );

  const reloadDetail = () => {
    artifactsState.reload();
    docsState.reload();
  };

  const artifacts = artifactsState.data?.artifacts ?? [];
  const docs = docsState.data?.docs ?? [];

  // 判决簿：全部非作废 verdicts，结账时间倒序
  const verdicts = useMemo(() => {
    const list = (verdictsState.data?.verdicts ?? []).filter((v) => v.outcome !== 'void');
    return [...list].sort((a, b) => b.decided_at.localeCompare(a.decided_at));
  }, [verdictsState.data]);

  // 闭环当前节点（按选中押注）：settled/到期 → 06；pending 有数据文档 → 05；无 → 04
  let currentStep: number | null = null;
  if (bet) {
    if (bet.status === 'settled' || dueIds.has(bet.id)) currentStep = 6;
    else if (bet.status === 'pending') currentStep = docs.length > 0 ? 5 : 4;
  }

  const openAttach = (preset?: PwArtifactType) => {
    setAttachPreset(preset);
    setModal('attach');
  };

  // TASK-PW-72：产生一条 MANUAL_TEST 信号；选中注则挂到注上（同注幂等），空台走合成 betId 纯链路测试
  const onTestSignal = async () => {
    if (notifyBusy) return;
    setNotifyBusy(true);
    try {
      const r = await pwApi.notifyTestSignal(bet?.id);
      if (r.alreadyExists) {
        showToast({ text: '这注已有测试信号，幂等不重复推送' });
      } else {
        showToast({ text: '测试信号已产生，30 秒内推到手机' });
      }
    } catch (e) {
      showToast({ text: `测试信号失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setNotifyBusy(false);
    }
  };
  const goExplore = () => {
    onGoExplore();
    showToast({ text: '已切到探索区，继续想这一把' });
  };

  return (
    <>
      <div className="pw-layout">
        {/* 左栏：项目卡片树 */}
        <aside className="pw-sidebar">
          <div className="pw-sidebar-title">项目卡片树</div>
          {betsState.error && <div className="pw-err">{betsState.error}</div>}
          <ul className="pw-tree">
            <li>
              <button
                type="button"
                className="pw-tree-item pw-tree-project"
                onClick={() => {
                  const t = liveBets.find((b) => b.status === 'pending') ?? liveBets[0];
                  if (t) setSelectedId(t.id);
                }}
              >
                <span className="sel-dot" aria-hidden="true" />
                创作实验
              </button>
              <ul className="pw-tree-children">
                {liveBets.map((b) => {
                  const outcome = verdictByBet.get(b.id);
                  const kind = outcome === 'gold' ? '金子' : outcome === 'tomb' ? '墓碑' : '押注';
                  return (
                    <li key={b.id}>
                      <button
                        type="button"
                        className={`pw-tree-item${b.id === selectedId ? ' active' : ''}${
                          outcome === 'tomb' ? ' is-tomb' : ''
                        }`}
                        onClick={() => setSelectedId(b.id)}
                      >
                        <span className="kind">{kind}</span>
                        {b.title}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          </ul>
          <div className="pw-sidebar-foot">
            <button type="button" className="pw-btn-ghost" onClick={() => setModal('create')}>
              新建押注
            </button>
            <button
              type="button"
              className="pw-btn-ghost"
              disabled={notifyBusy}
              title="产生一条 MANUAL_TEST 信号，验证手机推送链路"
              onClick={onTestSignal}
            >
              {notifyBusy ? '推送中…' : '产生测试信号'}
            </button>
            <button
              type="button"
              className="pw-sources-entry"
              onClick={() => onNav('sources')}
            >
              <span>
                <span className="se-label">数据源</span>
                <span className="se-hint">
                  {needsHumanCount > 0 ? `${needsHumanCount} 条待人工处理` : '低频同步中'}
                </span>
              </span>
              {needsHumanCount > 0 && (
                <span className="se-unread" aria-label={`${needsHumanCount} 条未处理`} />
              )}
            </button>
          </div>
        </aside>

        {/* 中央舞台：未选中=承诺总账+异常队列；选中=单卡驾驶舱 */}
        <main className="pw-stage">
          {!bet && !betsState.loading && liveBets.length === 0 && draftBets.length === 0 && (
            <div className="pw-empty-stage">
              <div className="t">承诺总账还空着</div>
              先落一张押注卡：我赌什么、凭什么、什么时候结账。
              <div>
                <button type="button" className="pw-btn primary" onClick={() => setModal('create')}>
                  新建押注
                </button>
              </div>
            </div>
          )}
          {!bet && (liveBets.length > 0 || draftBets.length > 0) && (
            <LedgerView
              rows={ledgerRows}
              loading={ledgerState.loading}
              error={ledgerState.error}
              noMap={noMap}
              drafts={draftBets}
              onActivate={(b) => setActivateDraft(b)}
              onOpen={(id) => setSelectedId(id)}
              onSettle={(id) => {
                setSelectedId(id);
                setModal('settle');
              }}
              onDoc={(id) => {
                setSelectedId(id);
                setModal('doc');
              }}
            />
          )}
          {bet && (
            <>
              <div className="pw-cockpit-bar">
                <button type="button" className="pw-btn-ghost sm" onClick={() => setSelectedId(null)}>
                  ← 返回总账
                </button>
              </div>
              <div className="pw-stage-row">
                <BetCard
                  bet={bet}
                  betNo={noMap.get(bet.id) ?? ''}
                  due={dueIds.has(bet.id)}
                  verdictOutcome={verdictByBet.get(bet.id) ?? null}
                  onSettle={() => setModal('settle')}
                  cardRef={betCardRef}
                />
                <BranchLinks betCardRef={betCardRef}>
                  <button type="button" className="pw-branch-card" onClick={goExplore}>
                    <span className="pw-b-tag">深挖</span>
                    <p>围绕这注往深问一层</p>
                  </button>
                  <button type="button" className="pw-branch-card" onClick={goExplore}>
                    <span className="pw-b-tag">发散</span>
                    <p>换几个打法试试看</p>
                  </button>
                  <button type="button" className="pw-branch-card" onClick={goExplore}>
                    <span className="pw-b-tag">改道</span>
                    <p>调整验证路径</p>
                  </button>
                </BranchLinks>
              </div>

              {/* 开干位：产出物三槽 */}
              <section className="pw-workbench">
                <div className="pw-section-head">
                  <h2>开干位</h2>
                  <span className="hint">产出物挂载在这里，结账时按件核对</span>
                  <span className="grow" />
                  {bet.status === 'pending' && (
                    <>
                      <button type="button" className="pw-btn sm" onClick={() => openAttach()}>
                        挂载产出
                      </button>
                      <button type="button" className="pw-btn sm" onClick={() => setModal('doc')}>
                        录入数据
                      </button>
                    </>
                  )}
                </div>
                <div className="pw-slots">
                  {SLOT_DEFS.map((def) => {
                    const items = artifacts.filter((a) => def.types.includes(a.type));
                    if (items.length === 0) {
                      return (
                        <div key={def.name} className="pw-slot is-empty">
                          <span className="empty-title">{def.name}</span>
                          <span className="empty-desc">待挂载</span>
                          {bet.status === 'pending' && (
                            <button
                              type="button"
                              className="pw-btn-ghost"
                              onClick={() => openAttach(def.preset)}
                            >
                              挂载
                            </button>
                          )}
                        </div>
                      );
                    }
                    return items.map((a) => (
                      <ArtifactSlot
                        key={a.id}
                        artifact={a}
                        slotName={def.name}
                        betStatus={bet.status}
                        onDetached={() => {
                          reloadDetail();
                          onChanged();
                        }}
                      />
                    ));
                  })}
                </div>
              </section>
            </>
          )}
        </main>

        {/* 右栏：判决簿 */}
        <aside className="pw-verdict">
          <div className="pw-verdict-head">
            <h2>判决簿</h2>
            <span className="count">{verdicts.length} 条记录</span>
          </div>
          {verdicts.length === 0 && !verdictsState.loading && (
            <div className="pw-blank">
              判决簿还空着。第一张到期的押注结账后，金子或墓碑会进这里。
            </div>
          )}
          {verdicts.map((v) => (
            <VerdictEntry key={v.id} verdict={v} betNo={noMap.get(v.bet_id)} />
          ))}
        </aside>
      </div>

      {/* 底部创作决策闭环带 */}
      <footer className="pw-loopbar">
        <div className="pw-loopbar-head">
          <h2>创作决策闭环</h2>
          <span className="hint">判断被认真对待的六个动作，循环往复</span>
        </div>
        <div className="pw-loop-track">
          {LOOP_NODES.map((label, i) => {
            const step = i + 1;
            const cur = currentStep === step;
            return (
              <div
                key={label}
                className={`pw-loop-node${cur ? ' is-current' : ''}`}
                aria-current={cur ? 'step' : undefined}
              >
                <span className="pw-node-dot" aria-hidden="true" />
                <span className="pw-node-step">
                  {String(step).padStart(2, '0')}
                  {cur ? ' · 当前' : ''}
                </span>
                <span className="pw-node-label">{label}</span>
                {cur && step === 5 && bet && <NodeLive bet={bet} docs={docs} onRecord={() => setModal('doc')} />}
                {cur && step === 6 && bet && bet.status === 'pending' && dueIds.has(bet.id) && (
                  <button type="button" className="pw-btn gold sm" onClick={() => setModal('settle')}>
                    到期结账
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </footer>

      {/* 弹层 */}
      {modal === 'create' && (
        <CreateBetModal
          onClose={() => setModal(null)}
          onCreated={(b) => {
            setModal(null);
            wantSelectRef.current = b.id;
            onChanged();
            showToast({ text: `押注已落：${b.title}` });
          }}
        />
      )}
      {modal === 'attach' && bet && (
        <AttachModal
          bet={bet}
          initialType={attachPreset}
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            reloadDetail();
            onChanged();
            showToast({ text: '产出物已挂载' });
          }}
        />
      )}
      {modal === 'doc' && bet && (
        <DocModal
          bet={bet}
          artifacts={artifacts}
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            reloadDetail();
            onChanged();
            showToast({ text: '数据文档已录入' });
          }}
        />
      )}
      {modal === 'settle' && bet && (
        <SettleModal
          bet={bet}
          betNo={noMap.get(bet.id) ?? ''}
          docs={docs}
          onClose={() => setModal(null)}
          onDone={(outcome) => {
            setModal(null);
            onChanged();
            showToast({ text: `已结账：${OUTCOME_META[outcome].verb}` });
          }}
        />
      )}
      {activateDraft && (
        <ActivateModal
          bet={activateDraft}
          betNo={noMap.get(activateDraft.id) ?? ''}
          onClose={() => setActivateDraft(null)}
          onDone={() => {
            setActivateDraft(null);
            onChanged();
            showToast({ text: '已转正，进入在途' });
          }}
        />
      )}
    </>
  );
}

/* ---------- 承诺总账（blotter）+ 异常队列：押注台默认首页 ---------- */
const MATURITY_META: Record<PwBetMaturity, { label: string; cls: string }> = {
  overdue: { label: '逾期未结', cls: 'is-bad' },
  due_missing_data: { label: '到期缺数据', cls: 'is-warn' },
  metric_invalid: { label: '指标失效', cls: 'is-warn' },
  due_ready: { label: '到期可结', cls: 'is-good' },
  not_due: { label: '在途', cls: '' },
};

function LedgerView({
  rows,
  loading,
  error,
  noMap,
  drafts,
  onActivate,
  onOpen,
  onSettle,
  onDoc,
}: {
  rows: PwLedgerRow[];
  loading: boolean;
  error: string | null;
  noMap: Map<string, string>;
  drafts: PwBet[];
  onActivate: (bet: PwBet) => void;
  onOpen: (betId: string) => void;
  onSettle: (betId: string) => void;
  onDoc: (betId: string) => void;
}) {
  const exceptions = rows.filter(
    (r) => r.maturity === 'overdue' || r.maturity === 'due_missing_data' || r.maturity === 'metric_invalid',
  );
  return (
    <div className="pw-ledger">
      <div className="pw-ledger-head">
        <h2>承诺总账</h2>
        <span className="hint">每笔押注的到期与数据状态；先清异常，再看在途</span>
      </div>

      {drafts.length > 0 && (
        <section className="pw-drafts-strip">
          <div className="pw-drafts-strip-title">待转正 · {drafts.length}（过闸门＋处置先例后转正）</div>
          <div className="pw-drafts-strip-list">
            {drafts.map((d) => (
              <button
                key={d.id}
                type="button"
                className="pw-draft-chip"
                onClick={() => onActivate(d)}
                title="点开做转正预检与先例处置"
              >
                <span className="dc-no">{noMap.get(d.id) ?? '草稿'}</span>
                {d.title}
              </button>
            ))}
          </div>
        </section>
      )}

      {exceptions.length > 0 && (
        <section className="pw-exception">
          <div className="pw-exception-title">异常队列 · {exceptions.length}</div>
          {exceptions.map((r) => (
            <div key={r.betId} className={`pw-exception-row ${MATURITY_META[r.maturity].cls}`}>
              <span className="ex-no">{noMap.get(r.betId) ?? '—'}</span>
              <span className="ex-title" title={r.title}>
                {r.title}
              </span>
              <span className={`pw-mat ${MATURITY_META[r.maturity].cls}`}>
                {MATURITY_META[r.maturity].label}
              </span>
              <span className="ex-due">
                {r.dueAt ? `${fmtDay(r.dueAt)} · ${daysText(r.dueAt)}` : '无结账日'}
              </span>
              <span className="ex-act">
                {r.maturity === 'overdue' && (
                  <button type="button" className="pw-btn gold sm" onClick={() => onSettle(r.betId)}>
                    去结账
                  </button>
                )}
                {r.maturity === 'due_missing_data' && (
                  <button type="button" className="pw-btn sm" onClick={() => onDoc(r.betId)}>
                    补数据
                  </button>
                )}
                {r.maturity === 'metric_invalid' && (
                  <button type="button" className="pw-btn-ghost sm" onClick={() => onOpen(r.betId)}>
                    看详情
                  </button>
                )}
              </span>
            </div>
          ))}
        </section>
      )}

      {error && <div className="pw-err">{error}</div>}
      {!error && loading && rows.length === 0 && <div className="pw-blank">总账加载中…</div>}
      {!error && !loading && rows.length === 0 && (
        <div className="pw-blank">总账接口暂无数据。</div>
      )}
      {rows.length > 0 && (
        <table className="pw-blotter">
          <thead>
            <tr>
              <th>编号</th>
              <th>押注</th>
              <th>看结果日</th>
              <th>把握</th>
              <th>验证指标</th>
              <th>数据</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.betId} onClick={() => onOpen(r.betId)} title="点开进单卡驾驶舱">
                <td className="c-no">{noMap.get(r.betId) ?? '—'}</td>
                <td className="c-title">{r.title}</td>
                <td className="c-due">
                  {r.dueAt ? (
                    <>
                      {fmtDay(r.dueAt)}
                      <span className="sub">{daysText(r.dueAt)}</span>
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="c-conf">{r.confidence !== null ? `${r.confidence}%` : '—'}</td>
                <td className="c-metric">{r.metricSummary ?? '—'}</td>
                <td className="c-data">
                  {r.dataSource.status ?? '—'}
                  {r.dataSource.lastDataAt && (
                    <span className="sub">{fmtDay(r.dataSource.lastDataAt)} 到数</span>
                  )}
                </td>
                <td className="c-mat">
                  <span className={`pw-mat ${MATURITY_META[r.maturity].cls}`}>
                    {MATURITY_META[r.maturity].label}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* ---------- 押注卡 ---------- */
function BetCard({
  bet,
  betNo,
  due,
  verdictOutcome,
  onSettle,
  cardRef,
}: {
  bet: PwBet;
  betNo: string;
  due: boolean;
  verdictOutcome: PwOutcome | null;
  onSettle: () => void;
  cardRef: RefObject<HTMLElement>;
}) {
  return (
    <article className="pw-bet-card" ref={cardRef}>
      <div className="pw-bet-eyebrow">
        <span className="tag">押注卡 · {betNo}</span>
        <StatusPill status={bet.status} due={due} verdictOutcome={verdictOutcome} />
      </div>
      <h1 className="pw-bet-title">{bet.title}</h1>
      <dl className="pw-bet-rows">
        <div className="pw-bet-row">
          <dt>赌注</dt>
          <dd>{bet.thesis}</dd>
        </div>
        <div className="pw-bet-row">
          <dt>验证指标</dt>
          <dd>
            {bet.metric ?? '—'}
            {bet.metric_target ? ` · 目标 ${bet.metric_target}` : ''}
          </dd>
        </div>
        <div className="pw-bet-row">
          <dt>结账日</dt>
          <dd>
            {fmtDay(bet.checkout_date)}
            {bet.checkout_date ? ` · ${daysText(bet.checkout_date)}` : ''}
          </dd>
        </div>
        <div className="pw-bet-row">
          <dt>把握</dt>
          <dd>
            {bet.confidence !== null
              ? `${bet.confidence}% · 我说 ${Math.round(bet.confidence / 10)} 成把握`
              : '未标注'}
          </dd>
        </div>
      </dl>
      {due && bet.status === 'pending' && (
        <div className="pw-bet-actions">
          <button type="button" className="pw-btn gold" onClick={onSettle}>
            到期结账
          </button>
        </div>
      )}
    </article>
  );
}

/* ---------- 手绘连接线：按押注卡与分支卡的实际位置画三条微弯贝塞尔 ---------- */
function BranchLinks({
  betCardRef,
  children,
}: {
  betCardRef: RefObject<HTMLElement>;
  children: ReactNode;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const colRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const draw = () => {
      const svg = svgRef.current;
      const bet = betCardRef.current;
      const colEl = colRef.current;
      if (!svg || !bet || !colEl) return;
      const sr = svg.getBoundingClientRect();
      if (sr.width < 10 || sr.height < 10) return; // 移动端隐藏时跳过
      const br = bet.getBoundingClientRect();
      const y0 = br.top + br.height / 2 - sr.top;
      svg.setAttribute('viewBox', `0 0 ${sr.width} ${sr.height}`);
      const paths = svg.querySelectorAll('path');
      const cards = colEl.querySelectorAll('.pw-branch-card');
      cards.forEach((c, i) => {
        const cr = c.getBoundingClientRect();
        const y1 = cr.top + cr.height / 2 - sr.top;
        const mid = sr.width * 0.55;
        // 轻微的中段抖动，模拟手绘的不完美
        const wobble = i % 2 === 0 ? 3 : -3;
        paths[i]?.setAttribute(
          'd',
          `M 2 ${y0.toFixed(1)} C ${mid.toFixed(1)} ${(y0 + wobble).toFixed(1)}, ` +
            `${mid.toFixed(1)} ${(y1 - wobble).toFixed(1)}, ${(sr.width - 2).toFixed(1)} ${y1.toFixed(1)}`,
        );
      });
    };
    draw();
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  });

  return (
    <>
      <svg className="pw-branch-links" aria-hidden="true" ref={svgRef}>
        <path d="" />
        <path d="" />
        <path d="" />
      </svg>
      <div className="pw-branch-col" ref={colRef}>
        {children}
      </div>
    </>
  );
}

/* ---------- 判决簿条目（金子 / 墓碑） ---------- */
function VerdictEntry({ verdict, betNo }: { verdict: PwVerdict; betNo?: string }) {
  if (verdict.outcome === 'gold') {
    return (
      <article className="pw-entry gold">
        <span className="pw-entry-kind">金子</span>
        <GoldSeal />
        <p>{verdict.lesson}</p>
        <div className="entry-meta">
          源自 {betNo ?? '—'} · 已盖章入库 · 结账于 {fmtDay(verdict.decided_at)}
        </div>
      </article>
    );
  }
  return (
    <article className="pw-entry tomb">
      <span className="pw-entry-kind">墓碑</span>
      <TombFig />
      <p>{verdict.cause_of_death}</p>
      <div className="entry-meta">
        源自 {betNo ?? '—'} · 已立碑，不再重复 · 结账于 {fmtDay(verdict.decided_at)}
      </div>
    </article>
  );
}

/* ---------- 05 数据回流节点下挂的实况卡：播放 sparkline + 最新指标 ---------- */
function NodeLive({ bet, docs, onRecord }: { bet: PwBet; docs: PwDataDoc[]; onRecord: () => void }) {
  const sorted = useMemo(
    () => [...docs].sort((a, b) => a.collected_at.localeCompare(b.collected_at)),
    [docs],
  );
  const playValues = sorted
    .map((d) => metricNumber(d.metrics_json, '播放'))
    .filter((v): v is number => v !== null);
  const { line, area } = sparkPaths(playValues);
  const latest = sorted[sorted.length - 1];
  const metrics = latest ? parseMetrics(latest.metrics_json) : [];
  const metricsText =
    metrics.length > 0
      ? metrics.map(([k, v]) => `${k} ${v}`).join(' · ')
      : (latest?.metrics_json ?? '');

  return (
    <div className="pw-node-live">
      <svg className="spark" viewBox="0 0 184 36" preserveAspectRatio="none" aria-hidden="true">
        <path d={area} fill="#3f6e5a" fillOpacity={0.14} />
        <path
          d={line}
          fill="none"
          stroke="#3f6e5a"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <div className="metrics">{metricsText}</div>
      {bet.status === 'pending' && (
        <button type="button" className="pw-btn-ghost sm" onClick={onRecord}>
          录入数据
        </button>
      )}
    </div>
  );
}

/** metrics_json 中取某个数值指标（容错） */
function metricNumber(metricsJson: string, key: string): number | null {
  try {
    const obj = JSON.parse(metricsJson) as Record<string, unknown>;
    const v = obj[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** 播放值归一化画折线 + 面积填充；<2 个点画平线（184×36 画幅） */
function sparkPaths(values: number[]): { line: string; area: string } {
  if (values.length < 2) {
    return { line: 'M 0 18 L 184 18', area: 'M 0 18 L 184 18 L 184 36 L 0 36 Z' };
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map(
    (v, i) => [(i * 184) / (values.length - 1), 32 - ((v - min) / span) * 28] as const,
  );
  const line = pts
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(' ');
  return { line, area: `${line} L 184 36 L 0 36 Z` };
}

/* ---------- 产出物槽（已挂载） ---------- */
function ArtifactSlot({
  artifact,
  slotName,
  betStatus,
  onDetached,
}: {
  artifact: PwArtifact;
  slotName: string;
  betStatus: PwBet['status'];
  onDetached: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const detach = async () => {
    setBusy(true);
    try {
      await pwApi.detachArtifact(artifact.id);
      onDetached();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pw-slot">
      <div className="pw-slot-head">
        <span className="pw-slot-name">{slotName}</span>
        <span className="pw-slot-state">已挂载</span>
      </div>
      <div className="pw-slot-file">
        <SlotIcon type={artifact.type} />
        <span className="fname" title={artifact.url ?? undefined}>
          {artifact.title ?? artifact.url}
        </span>
      </div>
      <span className="pw-slot-meta">
        {artifact.platform}
        {artifact.published_at ? ` · 发布于 ${fmtDay(artifact.published_at)}` : ''}
        {` · ${fmtDay(artifact.created_at)} 挂载`}
      </span>
      {betStatus === 'pending' && (
        <button type="button" className="pw-btn sm pw-slot-act" disabled={busy} onClick={detach}>
          {busy ? '摘除中…' : '摘除'}
        </button>
      )}
    </div>
  );
}

/* 槽内文件图标：成片/封面照抄设计稿 SVG，图文/链接为同款补画 */
function SlotIcon({ type }: { type: PwArtifactType }) {
  if (type === 'cover') {
    return (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <rect x="1.5" y="2.5" width="15" height="13" rx="2" stroke="#2e2a24" strokeWidth="1.2" />
        <circle cx="6" cy="7" r="1.4" stroke="#2e2a24" strokeWidth="1.1" />
        <path
          d="M 3 13.5 L 7.5 9.5 L 10.5 12 L 13 10 L 15.5 12.5"
          stroke="#2e2a24"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (type === 'link') {
    return (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <path
          d="M 7.5 10.5 L 10.5 7.5 M 8.5 5.5 L 10.8 3.2 a 2.8 2.8 0 0 1 4 4 L 12.5 9.5 M 9.5 12.5 L 7.2 14.8 a 2.8 2.8 0 0 1 -4 -4 L 5.5 8.5"
          stroke="#2e2a24"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (type === 'article') {
    return (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <rect x="3" y="1.5" width="12" height="15" rx="2" stroke="#2e2a24" strokeWidth="1.2" />
        <path
          d="M 6 5.5 L 12 5.5 M 6 8.5 L 12 8.5 M 6 11.5 L 9.5 11.5"
          stroke="#2e2a24"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="1.5" y="3" width="15" height="12" rx="2" stroke="#2e2a24" strokeWidth="1.2" />
      <path d="M 7.2 6.6 L 11.6 9 L 7.2 11.4 Z" fill="#2e2a24" />
    </svg>
  );
}

/* ---------- 新建押注 ---------- */
function CreateBetModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (bet: PwBet) => void;
}) {
  const [title, setTitle] = useState('');
  const [thesis, setThesis] = useState('');
  const [metric, setMetric] = useState('');
  const [metricTarget, setMetricTarget] = useState('');
  const [confidence, setConfidence] = useState('70');
  const [dataSourcePlan, setDataSourcePlan] = useState('');
  const [checkoutDate, setCheckoutDate] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const conf = confidence.trim() === '' ? null : Number(confidence);
      if (conf !== null && (!Number.isInteger(conf) || conf < 0 || conf > 100)) {
        throw new Error('置信度必须是 0–100 的整数');
      }
      const bet = await pwApi.createBet({
        title: title.trim(),
        thesis: thesis.trim(),
        metric: metric.trim(),
        metricTarget: metricTarget.trim() || undefined,
        confidence: conf,
        dataSourcePlan: dataSourcePlan.trim(),
        checkoutDate,
        status: 'pending',
      });
      onCreated(bet);
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  return (
    <PwModal title="新建押注" sub="落注即进入验证：指标、数据来源、结账日缺一不可" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="pw-field">
          <label>这一注赌什么（标题）</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus
            placeholder="直播用 Papertable 做 AI 实践，能成吗？" />
        </div>
        <div className="pw-field">
          <label>赌注（判断与理由）</label>
          <textarea value={thesis} onChange={(e) => setThesis(e.target.value)} required
            placeholder="我赌……因为……" />
        </div>
        <div className="pw-field">
          <label>验证指标</label>
          <input value={metric} onChange={(e) => setMetric(e.target.value)} required
            placeholder="三期平均播放" />
        </div>
        <div className="pw-field">
          <label>指标目标（可选）</label>
          <input value={metricTarget} onChange={(e) => setMetricTarget(e.target.value)}
            placeholder="≥ 5000" />
        </div>
        <div className="pw-field">
          <label>置信度（0–100，可选）</label>
          <input value={confidence} onChange={(e) => setConfidence(e.target.value)}
            inputMode="numeric" placeholder="70" />
        </div>
        <div className="pw-field">
          <label>数据来源</label>
          <input value={dataSourcePlan} onChange={(e) => setDataSourcePlan(e.target.value)} required
            placeholder="B 站后台每期播放 / 3 秒留存，人工录入" />
        </div>
        <div className="pw-field">
          <label>结账日</label>
          <input type="date" value={checkoutDate} onChange={(e) => setCheckoutDate(e.target.value)} required />
        </div>
        {err && <div className="pw-form-err">{err}</div>}
        <div className="pw-modal-foot">
          <button type="button" className="pw-btn" onClick={onClose}>再想想</button>
          <button type="submit" className="pw-btn primary" disabled={busy}>
            {busy ? '落注中…' : '落注'}
          </button>
        </div>
      </form>
    </PwModal>
  );
}

/* ---------- 挂载产出（initialType 预设空槽点「挂载」时的类型） ---------- */
function AttachModal({
  bet,
  initialType,
  onClose,
  onDone,
}: {
  bet: PwBet;
  initialType?: PwArtifactType;
  onClose: () => void;
  onDone: () => void;
}) {
  const [type, setType] = useState<PwArtifactType>(initialType ?? 'video');
  const [platform, setPlatform] = useState('');
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [publishedAt, setPublishedAt] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await pwApi.attachArtifact(bet.id, {
        type,
        platform: platform.trim(),
        title: title.trim() || undefined,
        url: url.trim() || undefined,
        publishedAt: publishedAt || undefined,
        note: note.trim() || undefined,
      });
      onDone();
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  return (
    <PwModal title="挂载产出" sub="这一注干出来的东西：成片、封面、链接都算" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="pw-field">
          <label>类型</label>
          <select value={type} onChange={(e) => setType(e.target.value as PwArtifactType)}>
            {Object.entries(ARTIFACT_TYPE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>
        <div className="pw-field">
          <label>平台</label>
          <input value={platform} onChange={(e) => setPlatform(e.target.value)} required
            placeholder="B站 / 小红书 / 抖音" />
        </div>
        <div className="pw-field">
          <label>标题（与链接至少填一个）</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder="第3期-直播成片-final" />
        </div>
        <div className="pw-field">
          <label>链接</label>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
        </div>
        <div className="pw-field">
          <label>发布日期（可选）</label>
          <input type="date" value={publishedAt} onChange={(e) => setPublishedAt(e.target.value)} />
        </div>
        <div className="pw-field">
          <label>备注（可选）</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        {err && <div className="pw-form-err">{err}</div>}
        <div className="pw-modal-foot">
          <button type="button" className="pw-btn" onClick={onClose}>取消</button>
          <button type="submit" className="pw-btn primary" disabled={busy}>
            {busy ? '挂载中…' : '挂载'}
          </button>
        </div>
      </form>
    </PwModal>
  );
}

/* ---------- 录入数据文档 ---------- */
const METRIC_FIELDS: Array<{ key: string; label: string }> = [
  { key: '播放', label: '播放' },
  { key: '点赞', label: '点赞' },
  { key: '评论', label: '评论' },
  { key: '收藏', label: '收藏' },
  { key: '分享', label: '分享' },
];

function DocModal({
  bet,
  artifacts,
  onClose,
  onDone,
}: {
  bet: PwBet;
  artifacts: PwArtifact[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [platform, setPlatform] = useState('');
  const [artifactId, setArtifactId] = useState('');
  const [metrics, setMetrics] = useState<Record<string, string>>({});
  const [rawRef, setRawRef] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    const obj: Record<string, number> = {};
    for (const { key } of METRIC_FIELDS) {
      const raw = (metrics[key] ?? '').trim();
      if (!raw) continue;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        setErr(`「${key}」必须是非负数字`);
        return;
      }
      obj[key] = n;
    }
    if (Object.keys(obj).length === 0) {
      setErr('至少填一项指标');
      return;
    }
    setBusy(true);
    try {
      await pwApi.createDataDoc(bet.id, {
        platform: platform.trim(),
        metricsJson: JSON.stringify(obj),
        artifactId: artifactId || null,
        rawRef: rawRef.trim() || undefined,
      });
      onDone();
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  return (
    <PwModal title="录入数据文档" sub="人工抄一份平台数据进账本，结账时它就是证据" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="pw-field">
          <label>平台</label>
          <input value={platform} onChange={(e) => setPlatform(e.target.value)} required autoFocus
            placeholder="B站 / 小红书 / 抖音" />
        </div>
        {artifacts.length > 0 && (
          <div className="pw-field">
            <label>关联产出物（可选）</label>
            <select value={artifactId} onChange={(e) => setArtifactId(e.target.value)}>
              <option value="">不关联</option>
              {artifacts.map((a) => (
                <option key={a.id} value={a.id}>
                  {ARTIFACT_TYPE_LABEL[a.type]} · {a.title ?? a.url}
                </option>
              ))}
            </select>
          </div>
        )}
        {METRIC_FIELDS.map(({ key, label }) => (
          <div className="pw-field" key={key}>
            <label>{label}</label>
            <input
              inputMode="numeric"
              value={metrics[key] ?? ''}
              onChange={(e) => setMetrics((m) => ({ ...m, [key]: e.target.value }))}
              placeholder="留空则不记"
            />
          </div>
        ))}
        <div className="pw-field">
          <label>出处备注（可选）</label>
          <input value={rawRef} onChange={(e) => setRawRef(e.target.value)}
            placeholder="B站创作中心截图 2026-08-04" />
        </div>
        {err && <div className="pw-form-err">{err}</div>}
        <div className="pw-modal-foot">
          <button type="button" className="pw-btn" onClick={onClose}>取消</button>
          <button type="submit" className="pw-btn primary" disabled={busy}>
            {busy ? '录入中…' : '录入'}
          </button>
        </div>
      </form>
    </PwModal>
  );
}

/* ---------- 结账弹层（简报23：金子/墓碑结账后接「判决晋级」一步） ---------- */
const PROMOTION_LEVELS: Array<{ value: PwPromotionLevel; label: string; hint: string }> = [
  { value: 'case_only', label: '仅归档', hint: '一次性的个案结果，不进规则库' },
  { value: 'prior', label: '正向先验', hint: '类似情况下次默认优先考虑' },
  { value: 'warning', label: '负向警示', hint: '下次必须解释为什么这次不一样' },
  { value: 'hard_constraint', label: '硬约束', hint: '默认禁止，覆盖必须写理由' },
  { value: 'action_item', label: '待验证动作', hint: '需要再做一次测试或修复流程' },
];

function SettleModal({
  bet,
  betNo,
  docs,
  onClose,
  onDone,
}: {
  bet: PwBet;
  betNo: string;
  docs: PwDataDoc[];
  onClose: () => void;
  onDone: (outcome: PwOutcome) => void;
}) {
  const [outcome, setOutcome] = useState<PwOutcome>('gold');
  const [lesson, setLesson] = useState('');
  const [cause, setCause] = useState('');
  const [evidence, setEvidence] = useState<Set<string>>(new Set(docs.map((d) => d.id)));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 简报23：结账成功后进入晋级步骤（void 不晋级直接关）
  const [settledVerdict, setSettledVerdict] = useState<PwVerdict | null>(null);
  const [level, setLevel] = useState<PwPromotionLevel>('case_only');
  const [scope, setScope] = useState('');
  const [reviewBy, setReviewBy] = useState('');
  const [promoteReason, setPromoteReason] = useState('');

  const toggle = (id: string) =>
    setEvidence((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const v = await pwApi.settleBet(bet.id, {
        outcome,
        lesson: outcome === 'gold' ? lesson.trim() : undefined,
        causeOfDeath: outcome === 'tomb' ? cause.trim() : undefined,
        evidenceDocIds: outcome === 'void' ? [] : [...evidence],
      });
      if (outcome === 'void') {
        onDone(outcome);
      } else {
        setBusy(false); // 进入晋级步前必须复位，否则落账按钮被 busy 卡死（24 验收发现）
        setSettledVerdict(v);
      }
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  const submitPromotion = async (e: FormEvent) => {
    e.preventDefault();
    if (!settledVerdict) return;
    if (level !== 'case_only' && scope.trim() === '') {
      setErr('晋级为规则时必须写清适用范围');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await pwApi.promoteVerdict(settledVerdict.id, {
        level,
        scope: scope.trim() || undefined,
        reviewBy: reviewBy || undefined,
        reason: promoteReason.trim() || undefined,
      });
      onDone(settledVerdict.outcome);
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  if (settledVerdict) {
    return (
      <PwModal
        title={`判决晋级 · ${betNo}`}
        sub="这次结账只是个案，还是能晋级成下一轮的规矩？"
        onClose={onClose}
      >
        <form onSubmit={submitPromotion}>
          <div className="pw-field">
            <label>晋级判定</label>
            <div className="pw-promo-levels">
              {PROMOTION_LEVELS.map((l) => (
                <label key={l.value} className={`pw-promo-level${level === l.value ? ' on' : ''}`}>
                  <input
                    type="radio"
                    name="promotion-level"
                    checked={level === l.value}
                    onChange={() => setLevel(l.value)}
                  />
                  <span className="pl-label">{l.label}</span>
                  <span className="pl-hint">{l.hint}</span>
                </label>
              ))}
            </div>
          </div>
          {level !== 'case_only' && (
            <>
              <div className="pw-field">
                <label>适用范围（什么情况适用这条规则）</label>
                <textarea value={scope} onChange={(e) => setScope(e.target.value)} required autoFocus
                  placeholder="B站知识类直播切片，目标播放 ≥5000 的押注" />
              </div>
              <div className="pw-field">
                <label>复核期限（可选，到期系统提醒重新核验）</label>
                <input type="date" value={reviewBy} onChange={(e) => setReviewBy(e.target.value)} />
              </div>
            </>
          )}
          <div className="pw-field">
            <label>理由（可选）</label>
            <input value={promoteReason} onChange={(e) => setPromoteReason(e.target.value)}
              placeholder="为什么这样判" />
          </div>
          {err && <div className="pw-form-err">{err}</div>}
          <div className="pw-modal-foot">
            <button type="button" className="pw-btn" onClick={onClose}>先不落账</button>
            <button type="submit" className="pw-btn primary" disabled={busy}>
              {busy ? '落账中…' : '落账'}
            </button>
          </div>
        </form>
      </PwModal>
    );
  }

  return (
    <PwModal
      title={`结账 · ${betNo}`}
      sub={`「${bet.title}」· 验证指标：${bet.metric ?? '—'}`}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="pw-field">
          <label>判决</label>
          <div className="pw-seg">
            {(Object.keys(OUTCOME_META) as PwOutcome[]).map((o) => (
              <button
                key={o}
                type="button"
                className={outcome === o ? 'on' : ''}
                onClick={() => setOutcome(o)}
              >
                {OUTCOME_META[o].verb}
              </button>
            ))}
          </div>
        </div>
        {outcome === 'gold' && (
          <div className="pw-field">
            <label>铸金：写下可复用的判断</label>
            <textarea value={lesson} onChange={(e) => setLesson(e.target.value)} required autoFocus
              placeholder="痛点放在开头 30 秒，3 秒留存提升明显" />
          </div>
        )}
        {outcome === 'tomb' && (
          <div className="pw-field">
            <label>立碑：死因一句话</label>
            <textarea value={cause} onChange={(e) => setCause(e.target.value)} required autoFocus
              placeholder="无剪辑直播录屏，播放 757，证伪" />
          </div>
        )}
        {outcome === 'void' && (
          <p className="pw-field hint">作废不进入金子墓碑库，也不消耗这次判断。</p>
        )}
        {outcome !== 'void' && (
          <div className="pw-field">
            <label>证据（勾选本次结账依据的数据文档）</label>
            {docs.length === 0 && <span className="hint">还没有数据文档，先回去录一份。</span>}
            {docs.map((d) => {
              const metrics = parseMetrics(d.metrics_json)
                .map(([k, v]) => `${k} ${v}`)
                .join(' · ');
              return (
                <label key={d.id} className="pw-doc d-check" style={{ cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={evidence.has(d.id)}
                    onChange={() => toggle(d.id)}
                  />
                  <span className="d-plat">{d.platform}</span>
                  <span className="d-metrics">{metrics}</span>
                  <span className="d-meta">{fmtDay(d.collected_at)}</span>
                </label>
              );
            })}
          </div>
        )}
        {err && <div className="pw-form-err">{err}</div>}
        <div className="pw-modal-foot">
          <button type="button" className="pw-btn" onClick={onClose}>再想想</button>
          <button type="submit" className="pw-btn primary" disabled={busy}>
            {busy ? '结账中…' : `确认${OUTCOME_META[outcome].verb}`}
          </button>
        </div>
      </form>
    </PwModal>
  );
}

/* ---------- 简报23：草稿转正弹层（预检闸门 + 先例处置，缺一项不许转正） ---------- */
const DISPOSITION_LABEL: Record<PwDispositionKind, string> = {
  adopted: '采用',
  distinguished: '区分',
  not_applicable: '不适用',
  overridden: '覆盖',
};

function ActivateModal({
  bet,
  betNo,
  onClose,
  onDone,
}: {
  bet: PwBet;
  betNo: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const preflightState = useAsync(() => pwApi.preflightBet(bet.id), [bet.id]);
  const precedentsState = useAsync(() => pwApi.betPrecedents(bet.id), [bet.id]);
  const [choices, setChoices] = useState<Record<string, PwDispositionKind>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const checks = preflightState.data?.checks ?? [];
  const items = precedentsState.data?.items ?? [];
  const allDisposed = items.every((p) => choices[p.verdictId] !== undefined);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!allDisposed) {
      setErr('每条先例都要给个处置：采用 / 区分 / 不适用 / 覆盖');
      return;
    }
    for (const p of items) {
      if (choices[p.verdictId] === 'overridden' && !(reasons[p.verdictId] ?? '').trim()) {
        setErr('覆盖先例必须写理由');
        return;
      }
    }
    setBusy(true);
    setErr(null);
    try {
      if (items.length > 0) {
        await pwApi.disposePrecedents(
          bet.id,
          items.map((p) => ({
            verdictId: p.verdictId,
            disposition: choices[p.verdictId],
            reason: reasons[p.verdictId]?.trim() || undefined,
          })),
        );
      }
      await pwApi.activateBet(bet.id);
      onDone();
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  return (
    <PwModal
      title={`转正 · ${betNo || '草稿'}`}
      sub={`「${bet.title}」· 先过闸门，再处置先例，才进在途`}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="pw-field">
          <label>激活预检</label>
          {preflightState.loading && <span className="hint">体检中…</span>}
          {preflightState.error && <div className="pw-err">{preflightState.error}</div>}
          {checks.map((c) => (
            <div key={c.name} className={`pw-preflight-row is-${c.result}`}>
              <span className="pf-icon" aria-hidden="true">
                {c.result === 'pass' ? '✓' : c.result === 'fail' ? '✗' : '⚠'}
              </span>
              <span className="pf-name">{c.name}</span>
              <span className="pf-detail">{c.detail}</span>
            </div>
          ))}
        </div>

        <div className="pw-field">
          <label>相关先例（金子/墓碑，按适用匹配）</label>
          {precedentsState.loading && <span className="hint">召回中…</span>}
          {precedentsState.error && <div className="pw-err">{precedentsState.error}</div>}
          {!precedentsState.loading && items.length === 0 && !precedentsState.error && (
            <span className="hint">没有按适用范围匹配到的先例，直接转正。</span>
          )}
          {items.map((p) => (
            <div key={p.verdictId} className={`pw-precedent is-${p.outcome}`}>
              <div className="pc-text">
                <span className="pc-kind">{p.outcome === 'gold' ? '金子' : '墓碑'}</span>
                {p.text ?? '—'}
                {p.promotion && (
                  <span className="pc-promo">
                    {PROMOTION_LEVELS.find((l) => l.value === p.promotion?.level)?.label}
                    {p.promotion.scope ? ` · ${p.promotion.scope}` : ''}
                  </span>
                )}
                {p.matchReason && <span className="pc-why">匹配：{p.matchReason}</span>}
              </div>
              <div className="pc-choices">
                {(Object.keys(DISPOSITION_LABEL) as PwDispositionKind[]).map((d) => (
                  <label key={d} className={choices[p.verdictId] === d ? 'on' : ''}>
                    <input
                      type="radio"
                      name={`pc-${p.verdictId}`}
                      checked={choices[p.verdictId] === d}
                      onChange={() => setChoices((s) => ({ ...s, [p.verdictId]: d }))}
                    />
                    {DISPOSITION_LABEL[d]}
                  </label>
                ))}
              </div>
              {choices[p.verdictId] === 'overridden' && (
                <input
                  className="pc-reason"
                  value={reasons[p.verdictId] ?? ''}
                  onChange={(e) =>
                    setReasons((s) => ({ ...s, [p.verdictId]: e.target.value }))
                  }
                  placeholder="覆盖理由（必填）"
                />
              )}
            </div>
          ))}
        </div>

        {err && <div className="pw-form-err">{err}</div>}
        <div className="pw-modal-foot">
          <button type="button" className="pw-btn" onClick={onClose}>再想想</button>
          <button
            type="submit"
            className="pw-btn primary"
            disabled={busy || preflightState.loading || precedentsState.loading}
          >
            {busy ? '转正中…' : '确认转正'}
          </button>
        </div>
      </form>
    </PwModal>
  );
}
