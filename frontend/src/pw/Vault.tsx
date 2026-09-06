/**
 * 金子墓碑库（PW-06 界面）：verdicts 列表（金/碑筛选）+ 关键词检索 +
 * 死因聚合计数 + 镜像金子区（POST mirror + GET golds）。
 */
import { useMemo, useState, type FormEvent } from 'react';
import { pwApi, type PwOutcome, type PwVerdict } from '../lib/api';
import { MarkdownView } from '../lib/MarkdownView';
import { useStore } from '../store';
import { betNoMap, fmtDay, useAsync } from './hooks';
import { OUTCOME_META, TombFig } from './ui';

type Filter = 'all' | 'gold' | 'tomb';

export function Vault({ epoch, onChanged }: { epoch: number; onChanged: () => void }) {
  const { showToast } = useStore();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');

  const verdictsState = useAsync(
    () =>
      submitted
        ? pwApi.searchVerdicts(submitted)
        : pwApi.listVerdicts(filter === 'all' ? undefined : filter),
    [filter, submitted, epoch],
  );
  const statsState = useAsync(() => pwApi.tombstoneStats(), [epoch]);
  const betsState = useAsync(() => pwApi.listBets(), [epoch]);
  const goldsState = useAsync(() => pwApi.listGolds(), [epoch]);
  const [mirrorBusy, setMirrorBusy] = useState(false);
  const [mirrorResult, setMirrorResult] = useState<string | null>(null);

  const bets = betsState.data?.bets ?? [];
  const betTitle = useMemo(() => new Map(bets.map((b) => [b.id, b.title])), [bets]);
  const noMap = useMemo(() => betNoMap(bets), [bets]);

  const verdicts = useMemo(() => {
    const list = verdictsState.data?.verdicts ?? [];
    return [...list].sort((a, b) => b.decided_at.localeCompare(a.decided_at));
  }, [verdictsState.data]);

  // TASK-PW-54：全部视图按结局分三桶（金/碑/作废）——双栏对照 + 作废折叠带
  const { goldList, tombList, voidList } = useMemo(() => {
    const goldList: PwVerdict[] = [];
    const tombList: PwVerdict[] = [];
    const voidList: PwVerdict[] = [];
    for (const v of verdicts) {
      if (v.outcome === 'gold') goldList.push(v);
      else if (v.outcome === 'tomb') tombList.push(v);
      else voidList.push(v);
    }
    return { goldList, tombList, voidList };
  }, [verdicts]);

  const causes = Object.entries(statsState.data?.causes ?? {}).filter(([cause]) => cause.trim());

  const search = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(query.trim());
  };

  const syncGolds = async () => {
    setMirrorBusy(true);
    setMirrorResult(null);
    try {
      const r = await pwApi.mirrorGolds();
      setMirrorResult(`本次新镜像 ${r.added} 条，跳过 ${r.skipped} 条已同步`);
      goldsState.reload();
      onChanged();
    } catch (error) {
      showToast({ text: error instanceof Error ? error.message : String(error) });
    } finally {
      setMirrorBusy(false);
    }
  };

  return (
    <div className="pw-page">
      <div className="pw-page-inner vault">
        <div className="pw-page-head">
          <h1>金子墓碑库</h1>
          <span className="sub">铸下的金子、立过的碑，都进这本账 · <b>不再重复踩同一个坑</b></span>
        </div>

        <div className="pw-vault-tools">
          <div className="pw-seg">
            {(
              [
                ['all', '全部'],
                ['gold', '金子'],
                ['tomb', '墓碑'],
              ] as Array<[Filter, string]>
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                className={filter === k && !submitted ? 'on' : ''}
                onClick={() => {
                  setFilter(k);
                  setSubmitted('');
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <form className="pw-search" onSubmit={search}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="检索金子与死因，回车确认"
            />
            <button type="submit" className="pw-btn sm">检索</button>
            {submitted && (
              <button
                type="button"
                className="pw-btn sm"
                onClick={() => {
                  setQuery('');
                  setSubmitted('');
                }}
              >
                清除
              </button>
            )}
          </form>
        </div>

        {causes.length > 0 && (
          <div className="pw-cause-chips">
            <span className="cc-label">死因统计</span>
            {causes.map(([cause, count]) => (
              <span key={cause} className="pw-cause-chip">
                {cause}
                <b>×{count}</b>
              </span>
            ))}
          </div>
        )}

        {verdictsState.error && <div className="pw-err">{verdictsState.error}</div>}
        {!verdictsState.loading && verdicts.length === 0 && (
          <div className="pw-blank">
            {submitted ? `没有匹配「${submitted}」的判决。` : '判决簿还空着。第一张到期的押注结账后，金子或墓碑会进这里。'}
          </div>
        )}
        {filter === 'all' && !submitted ? (
          <>
            <div className="pw-vault-cols">
              <VaultColumn
                outcome="gold"
                title={`金子 ×${goldList.length}`}
                list={goldList}
                betTitle={betTitle}
                noMap={noMap}
              />
              <VaultColumn
                outcome="tomb"
                title={`墓碑 ×${tombList.length}`}
                list={tombList}
                betTitle={betTitle}
                noMap={noMap}
              />
            </div>
            {voidList.length > 0 && (
              <details className="pw-void-strip">
                <summary>作废 ×{voidList.length}（不进入判断账）</summary>
                <ul>
                  {voidList.map((v) => (
                    <li key={v.id}>
                      {[
                        `结账于 ${fmtDay(v.decided_at)}`,
                        betTitle.get(v.bet_id)
                          ? `源自 ${noMap.get(v.bet_id) ?? ''}「${betTitle.get(v.bet_id)}」`
                          : null,
                        v.confidence_snapshot !== null ? `当时把握 ${v.confidence_snapshot}%` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        ) : (
          <div className="pw-vault-grid">
            {verdicts.map((v) => (
              <VerdictEntry key={v.id} verdict={v} betTitle={betTitle.get(v.bet_id)} betNo={noMap.get(v.bet_id)} />
            ))}
          </div>
        )}

        <div className="pw-sec-title">
          镜像金子 · 从纸桌同步来的已确认判断
          <span className="act">
            <button type="button" className="pw-btn sm" disabled={mirrorBusy} onClick={syncGolds}>
              {mirrorBusy ? '同步中…' : '同步金子'}
            </button>
          </span>
        </div>
        {mirrorResult && <p className="pw-mirror-result">{mirrorResult}</p>}
        <div className="pw-golds">
          {(goldsState.data?.golds ?? []).length === 0 && !goldsState.loading && (
            <div className="pw-blank">镜像区还空着。点「同步金子」，把纸桌里确认过的金子搬过来。</div>
          )}
          {(goldsState.data?.golds ?? []).map((g) => (
            <details key={g.id} className="pw-gold-row">
              <summary>
                {g.handle && <span className="g-handle">{g.handle}</span>}
                <span className="g-title">{g.title}</span>
                <span className="g-summary">{g.summary}</span>
                <span className="g-meta">镜像于 {fmtDay(g.mirrored_at)}</span>
              </summary>
              <div className="g-body">
                <MarkdownView content={g.body} />
              </div>
            </details>
          ))}
        </div>
      </div>
    </div>
  );
}

function VerdictEntry({
  verdict,
  betTitle,
  betNo,
}: {
  verdict: PwVerdict;
  betTitle?: string;
  betNo?: string;
}) {
  const outcome: PwOutcome = verdict.outcome;
  const text =
    outcome === 'gold'
      ? verdict.lesson ?? ''
      : outcome === 'tomb'
        ? verdict.cause_of_death ?? ''
        : '这张押注被作废，不进入判断账。';
  const meta = [
    `${OUTCOME_META[outcome].label}`,
    `结账于 ${fmtDay(verdict.decided_at)}`,
    betTitle ? `源自 ${betNo ?? ''}「${betTitle}」` : null,
    verdict.confidence_snapshot !== null ? `当时把握 ${verdict.confidence_snapshot}%` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <article className={`pw-entry ${outcome}`}>
      <span className="pw-entry-kind">
        {OUTCOME_META[outcome].label}
        {outcome === 'tomb' && <TombFig size={16} />}
      </span>
      <p>{text}</p>
      <div className="entry-meta">{meta}</div>
    </article>
  );
}

/** TASK-PW-54：金/碑单栏（栏头计数 + 卡列 + 空态）。 */
function VaultColumn({
  outcome,
  title,
  list,
  betTitle,
  noMap,
}: {
  outcome: PwOutcome;
  title: string;
  list: PwVerdict[];
  betTitle: Map<string, string>;
  noMap: Map<string, string>;
}) {
  return (
    <section className={`pw-vault-col ${outcome}`}>
      <div className="pw-vault-col-head">{title}</div>
      {list.length === 0 && (
        <div className="pw-blank">{outcome === 'gold' ? '还没有金子。' : '还没有墓碑。'}</div>
      )}
      {list.map((v) => (
        <VerdictEntry key={v.id} verdict={v} betTitle={betTitle.get(v.bet_id)} betNo={noMap.get(v.bet_id)} />
      ))}
    </section>
  );
}
