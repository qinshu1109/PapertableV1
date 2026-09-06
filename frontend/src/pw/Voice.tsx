/**
 * TASK-PW-47：观众声音屏——声音列表（提请候选）+ 右栏评论筛子结果（只读展出）。
 * 左栏：全部声音（倒序，dropped 灰显）；来源两色（platform 以 bilibili: 开头 = 赛道观众，
 * 其余 = 手动录入）；signal_type 徽章；「提请候选」按钮（已提请置灰，noise 不可提请）。
 * TASK-PW-65：右栏改为「评论筛子结果」三层密度——桶卡目录 → 折叠桶组（默认 top3，
 * 可展开全部）→ 噪音区（默认折叠、列全）；run 选择 + 对账行（输入/判出/重派）。
 * TASK-PW-71：右栏加第三个页签「交叉」——同一视频多版筛子摆在一起对账：桶矩阵
 * （各版每桶检出几条）+ 多版复现/单版独有两队列（没在某版出现=该版判噪音，不等于否决）。
 * 2026-08-12 图形化改版（用户拍板）：稳定度条 + 大数字 + 桶堆叠条（一版一色）+
 * 评论点阵（●信号 ○噪音），复核清单（单版独有）常开置顶，复现区默认折叠。
 * TASK-PW-64 主题卡代码保留未删（旧方案已否，右栏入口已替换，函数仍在文件里）。
 * 数据真值源都在后端；本屏只读展出 + 写动作（promote/collect），操作后重拉。
 */
import { useMemo, useState } from 'react';
import {
  api,
  pwApi,
  type PwCorpusDoc,
  type PwVoiceItem,
  type PwVoiceSieveBucket,
  type PwVoiceSieveItem,
  type PwVoiceSieveMatrix,
  type PwVoiceSieveMatrixItem,
  type PwVoiceSieveMatrixRun,
  type PwVoiceSieveRun,
  type PwVoiceSieveRunDetail,
  type PwVoiceSieveTrack,
  type PwVoiceSieveTrackAggregate,
  type PwVoiceThemeCard,
  type PwVoiceThemeCardItem,
} from '../lib/api';
import { useStore } from '../store';
import { useAsync } from './hooks';

const SIGNAL_LABEL: Record<string, string> = {
  topic_lead: '选题线索',
  content_critique: '内容批评',
  form_suggestion: '形式建议',
  noise: '噪音',
};

function fmtStamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function Voice({ epoch, onChanged }: { epoch: number; onChanged: () => void }) {
  const { showToast } = useStore();
  const voiceState = useAsync(() => pwApi.listVoice(), [epoch]);
  const corpusState = useAsync(() => pwApi.listCorpus(), []);
  const [bvid, setBvid] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const doneDocs = useMemo(
    () => (corpusState.data?.items ?? []).filter((doc: PwCorpusDoc) => doc.status === 'done'),
    [corpusState.data],
  );
  const activeBvid = bvid ?? doneDocs[0]?.bvid ?? null;
  const activeDoc = useMemo(
    () => doneDocs.find((doc) => doc.bvid === activeBvid) ?? null,
    [doneDocs, activeBvid],
  );
  const cardsState = useAsync(
    () => (activeBvid ? pwApi.voiceCorpusCards(activeBvid) : Promise.resolve(null)),
    [activeBvid, epoch],
  );
  const [aggBusy, setAggBusy] = useState(false);
  /* TASK-PW-65：评论筛子结果（run 列表 → 详情；右栏三层密度视图） */
  const [runId, setRunId] = useState<string | null>(null);
  const runsState = useAsync(
    () => (activeBvid ? pwApi.voiceSieveRuns(activeBvid) : Promise.resolve([])),
    [activeBvid],
  );
  /* 切视频的瞬间 runs 可能还悬着旧视频的数据，按 bvid 兜底过滤 */
  const runs = (runsState.data ?? []).filter((run) => run.bvid === activeBvid);
  const activeRun = runs.find((run) => run.id === runId) ?? runs[0] ?? null;
  const detailState = useAsync(
    () => (activeRun ? pwApi.voiceSieveRunDetail(activeRun.id) : Promise.resolve(null)),
    [activeRun?.id],
  );
  /* TASK-PW-66：赛道（跨视频桶聚合）视图；TASK-PW-71：matrix=多版本交叉检出 */
  const [rightView, setRightView] = useState<'video' | 'track' | 'matrix'>('video');
  const [trackId, setTrackId] = useState<string | null>(null);
  const [trackEpoch, setTrackEpoch] = useState(0);
  const tracksState = useAsync(() => pwApi.voiceSieveTracks(), [trackEpoch]);
  const tracks = tracksState.data ?? [];
  const activeTrack = tracks.find((t) => t.id === trackId) ?? tracks[0] ?? null;
  const trackAggState = useAsync(
    () => (rightView === 'track' && activeTrack ? pwApi.voiceSieveTrackAggregate(activeTrack.id) : Promise.resolve(null)),
    [rightView, activeTrack?.id, trackEpoch],
  );
  /* TASK-PW-71：交叉检出矩阵（多版对账；runId → 短标签，同模型多版补时间区分） */
  const matrixState = useAsync(
    () => (rightView === 'matrix' && activeBvid ? pwApi.voiceSieveMatrix(activeBvid) : Promise.resolve(null)),
    [rightView, activeBvid],
  );
  const matrixRunLabels = useMemo(() => {
    const labels = new Map<string, string>();
    const runs = matrixState.data?.runs ?? [];
    const modelCounts = new Map<string, number>();
    for (const run of runs) modelCounts.set(run.model, (modelCounts.get(run.model) ?? 0) + 1);
    for (const run of runs) {
      labels.set(run.id, (modelCounts.get(run.model) ?? 0) > 1 ? `${run.model}·${fmtStamp(run.createdAt)}` : run.model);
    }
    /* 同模型同分钟导入时标签仍撞车（如两个 deepseek 版）→ 补 provider 区分 */
    const seen = new Map<string, number>();
    for (const run of runs) {
      const label = labels.get(run.id) ?? run.model;
      const n = seen.get(label) ?? 0;
      seen.set(label, n + 1);
      if (n > 0 || runs.some((other) => other.id !== run.id && labels.get(other.id) === label)) {
        labels.set(run.id, `${run.provider}/${run.model}·${fmtStamp(run.createdAt)}`);
      }
    }
    return labels;
  }, [matrixState.data]);
  const [newTrackName, setNewTrackName] = useState('');
  const [trackBusy, setTrackBusy] = useState(false);
  /* TASK-PW-67b：一键桶卡导入——非空桶各一张卡（全部信号逐字），按上下文归项目 */
  const [bucketSending, setBucketSending] = useState(false);
  const sendBucketsToExplore = async (scope: {
    projectName: string;
    bvid?: string;
    /* TASK-PW-69：这些 run 的信号评论随卡落成项目语料材料 */
    runIds: string[];
    buckets: PwVoiceSieveBucket[];
    signals: Record<string, PwVoiceSieveItem[]>;
  }) => {
    if (bucketSending) return;
    setBucketSending(true);
    try {
      const { projects } = await api.listProjects();
      const proj = projects.find((p) => p.name === scope.projectName) ?? (await api.createProject(scope.projectName));
      const today = fmtMonthDay(Date.now() / 1000);
      const cards: Parameters<typeof pwApi.importCommentCards>[1] = scope.buckets
        .filter((b) => b.count > 0)
        .map((b) => {
          const rows = (scope.signals[b.bucket] ?? []).map((it) => {
            const src = (it as { bvid?: string }).bvid;
            return `${it.message}\n—— @${it.uname} · ${it.like}赞 · rpid:${it.rpid}${src ? ` · ${src}` : ''}`;
          });
          return {
            title: `${b.bucket}桶 · ${today} · ${b.count}条`,
            count: b.count,
            message: rows.join('\n\n'),
            source: {
              platform: 'bilibili',
              kind: 'bucket' as const,
              bucket: b.bucket,
              ...(scope.bvid ? { bvid: scope.bvid } : {}),
            },
          };
        });
      if (cards.length === 0) {
        showToast({ text: '没有非空桶，没什么可送' });
        return;
      }
      const r = await pwApi.importCommentCards(proj.id, cards, scope.runIds);
      const corpusWarn = r.corpus.skipped.filter((s) => !s.includes('已存在'));
      showToast({
        text:
          `已送进「${scope.projectName}」：新 ${r.imported.length} 张桶卡 · 跳过 ${r.skipped.length} 张` +
          (r.corpus.imported.length ? ` · 语料 +${r.corpus.imported.length}` : '') +
          (corpusWarn.length ? ` · ${corpusWarn.join('；')}` : ''),
      });
    } catch (e) {
      showToast({ text: `桶卡送进失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBucketSending(false);
    }
  };
  /* TASK-PW-67：单条精选评论送进探索区（补充通道；主通道是上面的桶卡一键导入）
     TASK-PW-71：item 放宽为结构子集（交叉矩阵的条目也走这条通道）；runIdHint 让语料跟着检出它的 run 走 */
  const sendToExplore = async (
    item: Pick<PwVoiceSieveItem, 'rpid' | 'uname' | 'message' | 'like'> & { bvid?: string },
    runIdHint?: string | null,
  ) => {
    try {
      const bvid = item.bvid ?? activeBvid ?? '';
      /* TASK-PW-69：解析这条评论所属的 run——单视频视图就是 activeRun；赛道视图按 bvid 查聚合里的 runId */
      const corpusRunId =
        runIdHint ??
        ((activeRun && activeRun.bvid === bvid ? activeRun.id : null) ??
          trackAggState.data?.videos.find((v) => v.bvid === bvid && v.hasRun)?.runId ??
          null);
      const { projects } = await api.listProjects();
      const proj = projects.find((p) => p.name === '评论精选') ?? (await api.createProject('评论精选'));
      const r = await pwApi.importCommentCards(
        proj.id,
        [
          {
            title: excerpt(item.message, 20),
            message: item.message,
            source: { platform: 'bilibili', bvid, rpid: item.rpid, uname: item.uname, like: item.like },
          },
        ],
        corpusRunId ? [corpusRunId] : [],
      );
      const corpusWarn = r.corpus.skipped.filter((s) => !s.includes('已存在'));
      showToast({
        text:
          (r.imported.length > 0 ? '已送进探索区「评论精选」' : '这条已在探索区，没重复送') +
          (r.corpus.imported.length ? ' · 语料已备' : '') +
          (corpusWarn.length ? ` · ${corpusWarn.join('；')}` : ''),
      });
    } catch (e) {
      showToast({ text: `送进探索区失败：${e instanceof Error ? e.message : String(e)}` });
      throw e;
    }
  };

  const items = useMemo(
    () => [...(voiceState.data?.items ?? [])].sort((a, b) => b.captured_at.localeCompare(a.captured_at)),
    [voiceState.data],
  );
  const cards = useMemo(() => cardsState.data?.cards ?? [], [cardsState.data]);

  /* TASK-PW-64：聚/重聚当前视频的主题卡 */
  const aggregate = async () => {
    if (!activeBvid) return;
    setAggBusy(true);
    try {
      const run = await pwApi.voiceCorpusCardsAggregate(activeBvid);
      showToast({ text: `聚成 ${run.cards} 张主题卡 · 花费 ¥${run.costCny.toFixed(3)}` });
      cardsState.reload();
    } catch (error) {
      showToast({ text: error instanceof Error ? error.message : String(error) });
    } finally {
      setAggBusy(false);
    }
  };

  const collectCard = async (card: PwVoiceThemeCard) => {
    setBusyId(card.id);
    try {
      const result = await pwApi.voiceCorpusCardCollect(card.id);
      showToast({
        text: `整卡收录 ${result.collected} 条进声音列表${result.skipped ? `，${result.skipped} 条已收过跳过` : ''}，AI 顺手自动分拣`,
      });
      cardsState.reload();
      onChanged();
    } catch (error) {
      showToast({ text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyId(null);
    }
  };

  const rejectCard = async (card: PwVoiceThemeCard) => {
    setBusyId(card.id);
    try {
      await pwApi.voiceCorpusCardReject(card.id);
      showToast({ text: '已弃掉这张主题卡，重聚不再浮出' });
      cardsState.reload();
    } catch (error) {
      showToast({ text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyId(null);
    }
  };

  /* 卡内单条收录（沿用 PW-46 逐字防重通路） */
  const collectOne = async (item: PwVoiceThemeCardItem) => {
    if (!activeBvid) return;
    setBusyId(`c-${item.rpid}`);
    try {
      await pwApi.collectVoiceComment(activeBvid, item.rpid);
      showToast({ text: '已收录进声音列表，AI 顺手自动分拣' });
      cardsState.reload();
      onChanged();
    } catch (error) {
      showToast({ text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyId(null);
    }
  };

  const promote = async (item: PwVoiceItem) => {
    setBusyId(item.id);
    try {
      const result = await pwApi.promoteVoice(item.id);
      showToast({ text: `已提请为候选卡（${result.card.kind === 'wildcard' ? '少数派区' : '候选对比区'}），去协作台挑/改/否` });
      onChanged();
    } catch (error) {
      showToast({ text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyId(null);
    }
  };

  /* TASK-PW-50：重分拣（标错翻案；noise 行文案「翻案重分拣」） */
  const reclassify = async (item: PwVoiceItem) => {
    setBusyId(`r-${item.id}`);
    try {
      await pwApi.classifyVoice([item.id]);
      showToast({ text: '已让 AI 重新分拣这条声音' });
      onChanged();
    } catch (error) {
      showToast({ text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="pw-vc">
      <div className="pw-cb-top">
        <span className="pw-cb-top-brand">观众声音</span>
        <span className="pw-cb-top-status">
          声音的完整上坡路：看到 → 收录/提请 → 进候选 → 你挑改否
        </span>
      </div>

      <div className="pw-vc-split">
        {/* 左栏：声音列表 */}
        <main className="pw-vc-list">
          <div className="pw-dl-sec-head">
            <h2>声音列表</h2>
            <span className="hint">{items.length} 条 · 赛道观众=语料收录，手动录入=对话/API 录入</span>
          </div>
          {!voiceState.loading && items.length === 0 && (
            <div className="pw-blank">还没有声音——右边语料评论挑几条收录，或对话里让 AI 录。</div>
          )}
          {items.map((item) => {
            const dropped = item.dropped_reason != null;
            const promoted = item.promoted_to_draft_id != null;
            const isTrack = item.platform.startsWith('bilibili:');
            const noNoise = item.signal_type === 'noise';
            return (
              <article key={item.id} className={`pw-vc-item${dropped ? ' is-dropped' : ''}`}>
                <p className="pw-vc-item-content">「{item.content}」</p>
                <p className="pw-vc-item-meta">
                  <span className={`pw-vc-src${isTrack ? ' is-track' : ' is-manual'}`}>
                    {isTrack ? '赛道观众' : '手动录入'}
                  </span>
                  <span className={`pw-vc-signal is-${item.signal_type ?? 'none'}`}>
                    {item.signal_type ? SIGNAL_LABEL[item.signal_type] : '未分拣'}
                  </span>
                  {item.cluster_id && <span className="pw-vc-cluster">{item.cluster_id}</span>}
                  <span className="pw-vc-time">{fmtStamp(item.captured_at)}</span>
                  {isTrack && (
                    <a
                      className="pw-dl-card-origin"
                      href={`https://www.bilibili.com/video/${item.platform.slice('bilibili:'.length)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      ↗出处
                    </a>
                  )}
                </p>
                {dropped ? (
                  <p className="pw-vc-item-foot">已丢弃：{item.dropped_reason}</p>
                ) : (
                  <div className="pw-vc-item-foot">
                    {promoted ? (
                      <span className="pw-vc-promoted">已进候选 ↗（去协作台复核）</span>
                    ) : (
                      <button
                        type="button"
                        className="pw-cl-btn-primary"
                        disabled={busyId === item.id || noNoise}
                        title={noNoise ? '噪音不进候选（若要翻案先改分拣标记）' : '原文逐字提请为协作台候选卡'}
                        onClick={() => void promote(item)}
                      >
                        {busyId === item.id ? '提请中…' : '提请候选'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="pw-cl-btn-ghost"
                      disabled={busyId === `r-${item.id}`}
                      title="让 AI 按新标准重新分拣这条声音"
                      onClick={() => void reclassify(item)}
                    >
                      {busyId === `r-${item.id}` ? '分拣中…' : noNoise ? '翻案重分拣' : '重分拣'}
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </main>

        {/* 右栏：评论筛子结果（PW-65 三层密度；PW-66 单视频/赛道两视图） */}
        <aside className="pw-vc-corpus">
          <div className="pw-dl-sec-head">
            <h2>评论筛子结果</h2>
            <div className="pw-sieve-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                className={rightView === 'video' ? 'on' : ''}
                onClick={() => setRightView('video')}
              >
                单视频
              </button>
              <button
                type="button"
                role="tab"
                className={rightView === 'track' ? 'on' : ''}
                onClick={() => setRightView('track')}
              >
                赛道
              </button>
              <button
                type="button"
                role="tab"
                className={rightView === 'matrix' ? 'on' : ''}
                title="同一视频多版筛子摆在一起对账：多版复现的浮上面，单版独有的整队可见"
                onClick={() => setRightView('matrix')}
              >
                交叉
              </button>
            </div>
          </div>
          {rightView === 'video' && (
          <>
          <select
            className="pw-vc-picker"
            value={activeBvid ?? ''}
            onChange={(e) => setBvid(e.target.value || null)}
          >
            {doneDocs.length === 0 && <option value="">语料库还没有抓完的视频</option>}
            {doneDocs.map((doc) => (
              <option key={doc.bvid} value={doc.bvid}>
                {doc.title ?? doc.bvid}（{doc.comment_count ?? 0} 条）
              </option>
            ))}
          </select>
          {activeBvid && runs.length > 0 && (
            <>
              <select
                className="pw-vc-picker"
                value={activeRun ? activeRun.id : ''}
                onChange={(e) => setRunId(e.target.value || null)}
              >
                {runs.map((run) => (
                  <option key={run.id} value={run.id}>
                    {fmtSieveRun(run)}
                  </option>
                ))}
              </select>
              {activeRun && (
                <div className="pw-sieve-balance-row">
                  <p className="pw-sieve-balance">
                    <span>输入 {activeRun.total} 条</span>
                    <span>判出 {activeRun.signal + activeRun.noise} 条</span>
                    <span>重派 {activeRun.reassigned} 批</span>
                  </p>
                  {detailState.data && (
                    <button
                      type="button"
                      className="pw-cl-btn-ghost pw-sieve-send-all"
                      disabled={bucketSending}
                      onClick={() =>
                        void sendBucketsToExplore({
                          projectName: `评论·${activeBvid}`,
                          bvid: activeBvid ?? undefined,
                          runIds: activeRun ? [activeRun.id] : [],
                          buckets: detailState.data!.buckets,
                          signals: detailState.data!.signals,
                        })
                      }
                    >
                      {bucketSending ? '送入中…' : '把这次筛子送进探索区'}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
          {runsState.loading && <div className="pw-blank">筛子轮次加载中…</div>}
          {!runsState.loading && activeBvid && runs.length === 0 && (
            <div className="pw-blank">
              这个视频还没跑过筛子 —— 去跑 voice-comment-sieve skill，先出一批信号/噪音。
            </div>
          )}
          {!runsState.loading && !activeBvid && (
            <div className="pw-blank">语料库还没有抓完的视频，先去语料区授权抓取。</div>
          )}
          {activeRun && detailState.loading && <div className="pw-blank">桶展开中…</div>}
          {activeRun && detailState.error && <div className="pw-blank">筛子结果出不来：{detailState.error}</div>}
          {!detailState.loading && !detailState.error && detailState.data && (
            <SieveDetail detail={detailState.data} onSend={sendToExplore} />
          )}
          </>
          )}
          {rightView === 'track' && (
            <TrackView
              tracks={tracks}
              activeTrack={activeTrack}
              onPickTrack={(id) => setTrackId(id)}
              doneDocs={doneDocs}
              activeBvid={activeBvid}
              busy={trackBusy}
              newTrackName={newTrackName}
              setNewTrackName={setNewTrackName}
              aggState={trackAggState}
              onCreate={async () => {
                const name = newTrackName.trim();
                if (!name) return;
                setTrackBusy(true);
                try {
                  const t = await pwApi.createVoiceSieveTrack(name);
                  setNewTrackName('');
                  setTrackEpoch((n) => n + 1);
                  setTrackId(t.id);
                  showToast({ text: `赛道「${name}」建好了` });
                } finally {
                  setTrackBusy(false);
                }
              }}
              onAttach={async (bvid) => {
                if (!activeTrack || !bvid) return;
                setTrackBusy(true);
                try {
                  await pwApi.attachVoiceSieveTrackVideo(activeTrack.id, bvid);
                  setTrackEpoch((n) => n + 1);
                  showToast({ text: `${bvid} 已挂进「${activeTrack.name}」` });
                } finally {
                  setTrackBusy(false);
                }
              }}
              onSend={sendToExplore}
              bucketSending={bucketSending}
              onSendBuckets={() => {
                if (!activeTrack || !trackAggState.data) return;
                void sendBucketsToExplore({
                  projectName: `评论·${activeTrack.name}`,
                  runIds: trackAggState.data.videos
                    .filter((v) => v.hasRun && v.runId)
                    .map((v) => v.runId as string),
                  buckets: trackAggState.data.buckets,
                  signals: trackAggState.data.signals,
                });
              }}
            />
          )}
          {rightView === 'matrix' && (
            <>
              <select
                className="pw-vc-picker"
                value={activeBvid ?? ''}
                onChange={(e) => setBvid(e.target.value || null)}
              >
                {doneDocs.length === 0 && <option value="">语料库还没有抓完的视频</option>}
                {doneDocs.map((doc) => (
                  <option key={doc.bvid} value={doc.bvid}>
                    {doc.title ?? doc.bvid}（{doc.comment_count ?? 0} 条）
                  </option>
                ))}
              </select>
              {matrixState.loading && <div className="pw-blank">多版对账中…</div>}
              {matrixState.error && <div className="pw-blank">交叉矩阵出不来：{matrixState.error}</div>}
              {!matrixState.loading && !matrixState.error && matrixState.data && matrixState.data.bvid === activeBvid && (
                matrixState.data.runs.length === 0 ? (
                  <div className="pw-blank">
                    这个视频还没跑过筛子 —— 去跑 voice-comment-sieve skill，先出一批信号/噪音。
                  </div>
                ) : (
                  <MatrixView
                    matrix={matrixState.data}
                    runLabels={matrixRunLabels}
                    onSend={(item) => sendToExplore(item, item.signalRuns[0]?.runId ?? null)}
                  />
                )
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

/* ============================================================
   TASK-PW-65：评论筛子结果——三层密度视图（桶卡目录 → 桶组 → 噪音区）
   ============================================================ */

/** run 选项文案：时间 · 模型 · 信号/噪音 */
function fmtSieveRun(run: PwVoiceSieveRun): string {
  return `${fmtStamp(run.createdAt)} · ${run.model} · ${run.signal}/${run.noise}`;
}

/** unix 秒 → 月/日 */
function fmtMonthDay(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

/** 前 n 字摘录（压空白），超了加 … */
function excerpt(text: string, n: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 120 字内截到第一个句末标点（。！？!?… 或换行）；没有就截 120 字。 */
function firstSentence(text: string): string {
  const seg = text.slice(0, 120);
  const m = seg.match(/[\s\S]*?[。！？!?…\n]/);
  return (m ? m[0] : seg).trim();
}

/** 筛子结果详情：桶卡目录（8 行，空桶灰显不可点）+ 折叠桶组 + 噪音区（默认折叠列全）。 */
/** PW-66：放宽结构让赛道聚合数据复用（showBvid 时条目 meta 行带来源 bvid 角标；noise 可缺省）。 */
function SieveDetail({
  detail,
  showBvid = false,
  onSend,
}: {
  detail: {
    buckets: PwVoiceSieveBucket[];
    signals: Record<string, PwVoiceSieveItem[]>;
    noise?: PwVoiceSieveItem[];
  };
  showBvid?: boolean;
  onSend?: (item: PwVoiceSieveItem) => Promise<void>;
}) {
  const jump = (i: number) => {
    // 只滚右栏容器：scrollIntoView 会把所有可滚祖先（含 .pw 壳）一起滚，把顶部导航顶飞
    const el = document.getElementById(`pw-sieve-bucket-${i}`);
    const scroller = el?.closest('.pw-vc-corpus');
    if (!el || !scroller) return;
    const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTo({ top, behavior: 'smooth' });
  };
  return (
    <div className="pw-sieve">
      <SieveMiniStats detail={detail} />
      <div className="pw-sieve-catalog">
        {detail.buckets.map((bucket, i) => {
          const empty = bucket.count === 0;
          return (
            <button
              key={bucket.bucket}
              type="button"
              className={`pw-sieve-cat${empty ? ' is-empty' : ''}`}
              disabled={empty}
              title={empty ? '空桶' : `滚到「${bucket.bucket}」桶组`}
              onClick={() => jump(i)}
            >
              <span className="pw-sieve-cat-name">{bucket.bucket}</span>
              <span className="pw-sieve-cat-count">{bucket.count} 条</span>
              <span className="pw-sieve-cat-likes">{bucket.totalLikes} 赞</span>
              <span className="pw-sieve-cat-ex">
                {empty ? '—' : excerpt(bucket.top[0]?.message ?? '', 40)}
              </span>
            </button>
          );
        })}
      </div>
      {detail.buckets.map((bucket, i) =>
        bucket.count > 0 ? (
          <BucketGroup
            key={bucket.bucket}
            anchor={`pw-sieve-bucket-${i}`}
            bucket={bucket}
            signals={detail.signals[bucket.bucket] ?? []}
            showBvid={showBvid}
            onSend={onSend}
          />
        ) : null,
      )}
      {(detail.noise ?? []).length > 0 && (
        <details className="pw-sieve-noise">
          <summary>噪音区（{(detail.noise ?? []).length} 条）</summary>
          {(detail.noise ?? []).map((item) => (
            <p key={item.rpid} className="pw-sieve-noise-item">
              [{item.rpid}] {excerpt(item.message, 40)} — @{item.uname} · {item.like} 赞
            </p>
          ))}
        </details>
      )}
    </div>
  );
}

/** 单个桶组：summary=桶名+条数+总赞；默认 top3，条数>3 可「展开全部 N 条」（从 signals 渲染剩余）。 */
function BucketGroup({
  bucket,
  signals,
  anchor,
  showBvid = false,
  onSend,
}: {
  bucket: PwVoiceSieveBucket;
  signals: PwVoiceSieveItem[];
  anchor: string;
  showBvid?: boolean;
  onSend?: (item: PwVoiceSieveItem) => Promise<void>;
}) {
  const [showAll, setShowAll] = useState(false);
  const all = signals.length > 0 ? signals : bucket.top;
  const shown = showAll ? all : all.slice(0, 3);
  const rest = all.length - 3;
  return (
    <details id={anchor} className="pw-rollup-item pw-sieve-bucket">
      <summary>
        <span className="pw-rollup-period">{bucket.bucket}</span>
        <span className="pw-sieve-bucket-count">{bucket.count} 条</span>
        <span className="pw-sieve-bucket-likes">总赞 {bucket.totalLikes}</span>
      </summary>
      <div className="pw-rollup-card pw-sieve-bucket-body">
        {shown.map((item) => (
          <SieveComment key={`${(item as { bvid?: string }).bvid ?? ''}-${item.rpid}`} item={item} showBvid={showBvid} onSend={onSend} />
        ))}
        {!showAll && rest > 0 && (
          <button type="button" className="pw-cl-btn-ghost pw-sieve-more" onClick={() => setShowAll(true)}>
            展开全部 {bucket.count} 条
          </button>
        )}
      </div>
    </details>
  );
}

/** 单条评论：message 超 120 字截为首句 + …[全文 N 字]，点击展开全文。showBvid 时 meta 行带来源视频角标。 */
/** PW-67：onSend 存在时渲染「送进探索区」按钮（原样落卡不跑 AI，成功后标 ✓）。 */
function SieveComment({
  item,
  showBvid = false,
  onSend,
}: {
  item: PwVoiceSieveItem;
  showBvid?: boolean;
  onSend?: (item: PwVoiceSieveItem) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const full = item.message.trim();
  const truncated = full.length > 120;
  const bvid = (item as { bvid?: string }).bvid;
  return (
    <div className="pw-sieve-item">
      <p className="pw-sieve-item-msg">
        {truncated && !open ? (
          <button type="button" className="pw-sieve-expand" title="点击展开全文" onClick={() => setOpen(true)}>
            「{firstSentence(full)}…[全文 {full.length} 字]」
          </button>
        ) : (
          <span>「{full}」</span>
        )}
      </p>
      <p className="pw-sieve-item-meta">
        {showBvid && bvid && <span className="pw-sieve-bvid">{bvid}</span>}
        <span>@{item.uname}</span>
        <span>{item.like} 赞</span>
        <span className="pw-vc-time">{fmtMonthDay(item.ctime)}</span>
        <span>rpid:{item.rpid}</span>
        {onSend && !sent && (
          <button
            type="button"
            className="pw-sieve-send"
            disabled={sending}
            onClick={async () => {
              setSending(true);
              try {
                await onSend(item);
                setSent(true);
              } catch {
                /* toast 已在外层 showToast */
              } finally {
                setSending(false);
              }
            }}
          >
            {sending ? '送入中…' : '送进探索区'}
          </button>
        )}
        {sent && <span className="pw-sieve-sent">已进探索区 ✓</span>}
      </p>
    </div>
  );
}

/* ============================================================
   TASK-PW-66：赛道视图（跨视频桶聚合）——赛道管理 + 聚合三层密度复用
   ============================================================ */

/** 赛道视图：赛道下拉 + 新建 + 挂视频 + 聚合结果（复用 SieveDetail，条目带 bvid 角标，无噪音区）。 */
function TrackView({
  tracks,
  activeTrack,
  onPickTrack,
  doneDocs,
  activeBvid,
  busy,
  newTrackName,
  setNewTrackName,
  aggState,
  onCreate,
  onAttach,
  onSend,
  bucketSending,
  onSendBuckets,
}: {
  tracks: PwVoiceSieveTrack[];
  activeTrack: PwVoiceSieveTrack | null;
  onPickTrack: (id: string) => void;
  doneDocs: PwCorpusDoc[];
  activeBvid: string | null;
  busy: boolean;
  newTrackName: string;
  setNewTrackName: (v: string) => void;
  aggState: { data: PwVoiceSieveTrackAggregate | null; loading: boolean; error: string | null };
  onCreate: () => void;
  onAttach: (bvid: string) => void;
  onSend: (item: PwVoiceSieveItem) => Promise<void>;
  bucketSending: boolean;
  onSendBuckets: () => void;
}) {
  const [attachBvid, setAttachBvid] = useState<string>('');
  const effAttachBvid = attachBvid || activeBvid || doneDocs[0]?.bvid || '';
  return (
    <div className="pw-sieve-track">
      <div className="pw-sieve-track-row">
        <select
          className="pw-vc-picker"
          value={activeTrack?.id ?? ''}
          onChange={(e) => onPickTrack(e.target.value)}
        >
          {tracks.length === 0 && <option value="">还没有赛道</option>}
          {tracks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}（{t.videos.length} 个视频）
            </option>
          ))}
        </select>
      </div>
      <div className="pw-sieve-track-row">
        <input
          className="pw-sieve-track-input"
          placeholder="新赛道名，如：国产 Agent 赛道"
          value={newTrackName}
          onChange={(e) => setNewTrackName(e.target.value)}
        />
        <button type="button" className="pw-cl-btn-ghost" disabled={busy || !newTrackName.trim()} onClick={onCreate}>
          建赛道
        </button>
      </div>
      {activeTrack && (
        <div className="pw-sieve-track-row">
          <select className="pw-vc-picker" value={effAttachBvid} onChange={(e) => setAttachBvid(e.target.value)}>
            {doneDocs.map((doc) => (
              <option key={doc.bvid} value={doc.bvid}>
                {doc.title ?? doc.bvid}（{doc.comment_count ?? 0} 条）
              </option>
            ))}
          </select>
          <button
            type="button"
            className="pw-cl-btn-ghost"
            disabled={busy || !effAttachBvid || activeTrack.videos.includes(effAttachBvid)}
            onClick={() => onAttach(effAttachBvid)}
          >
            挂进赛道
          </button>
        </div>
      )}
      {activeTrack && aggState.data && (
        <div className="pw-sieve-balance-row">
          <p className="pw-sieve-track-videos">
            {aggState.data.videos.length === 0
              ? '赛道里还没有视频，先挂一个。'
              : aggState.data.videos
                  .map((v) => (v.hasRun ? `${v.bvid}（信号 ${v.signal}）` : `${v.bvid}（未跑筛子）`))
                  .join(' · ')}
          </p>
          {aggState.data.videos.some((v) => v.hasRun) && (
            <button
              type="button"
              className="pw-cl-btn-ghost pw-sieve-send-all"
              disabled={bucketSending}
              onClick={onSendBuckets}
            >
              {bucketSending ? '送入中…' : '把这个赛道送进探索区'}
            </button>
          )}
        </div>
      )}
      {aggState.loading && <div className="pw-blank">赛道聚合中…</div>}
      {aggState.error && <div className="pw-blank">赛道聚合出不来：{aggState.error}</div>}
      {!aggState.loading && !aggState.error && aggState.data && aggState.data.videos.some((v) => v.hasRun) && (
        <SieveDetail detail={aggState.data} showBvid />
      )}
      {!aggState.loading && !aggState.error && aggState.data && !aggState.data.videos.some((v) => v.hasRun) && (
        <div className="pw-blank">赛道里的视频都还没跑过筛子 —— 先回单视频视图跑一轮。</div>
      )}
    </div>
  );
}

/* ============================================================
   TASK-PW-68：迷你分布图（赞数长尾 + 评论时间），纯 SVG 无依赖
   ============================================================ */

/** 两张迷你图：赞数长尾（越陡头部效应越强）+ 评论时间分布（按天）。数据来自 detail.signals 全量。 */
function SieveMiniStats({ detail }: { detail: { signals: Record<string, PwVoiceSieveItem[]> } }) {
  const items = useMemo(() => Object.values(detail.signals).flat(), [detail]);
  if (items.length < 5) return null;
  const W = 300;
  const H = 34;
  const P = 2;
  // 赞数长尾：按赞降序的折线
  const likes = items.map((i) => i.like).sort((a, b) => b - a);
  const maxLike = Math.max(likes[0] ?? 0, 1);
  const likePts = likes
    .map((l, i) => `${P + (i / Math.max(likes.length - 1, 1)) * (W - 2 * P)},${P + (1 - l / maxLike) * (H - 2 * P)}`)
    .join(' ');
  const totalLikes = likes.reduce((s, l) => s + l, 0);
  const headCount = Math.max(1, Math.floor(likes.length * 0.1));
  const headRatio = Math.round((likes.slice(0, headCount).reduce((s, l) => s + l, 0) / Math.max(totalLikes, 1)) * 100);
  // 评论时间：按天聚合，最多 14 格
  const DAY = 86400;
  const minT = Math.min(...items.map((i) => i.ctime));
  const maxT = Math.max(...items.map((i) => i.ctime));
  const spanDays = Math.max(1, Math.ceil((maxT - minT) / DAY) + 1);
  const bins = Math.min(spanDays, 14);
  const binSize = (maxT - minT + DAY) / bins;
  const counts = new Array<number>(bins).fill(0);
  for (const it of items) {
    const idx = Math.min(bins - 1, Math.floor((it.ctime - minT) / binSize));
    counts[idx] += 1;
  }
  const maxCount = Math.max(...counts, 1);
  const barW = (W - 2 * P) / bins;
  return (
    <div className="pw-sieve-stats">
      <figure>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label="赞数长尾">
          <polyline points={likePts} fill="none" stroke="var(--pw-accent)" strokeWidth="1.5" />
        </svg>
        <figcaption>
          赞数长尾 · 前 10% 评论占 {headRatio}% 赞{headRatio >= 70 ? '（头部效应强，看 top 就够）' : headRatio <= 40 ? '（分布平，值得翻附录）' : ''}
        </figcaption>
      </figure>
      <figure>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label="评论时间分布">
          {counts.map((c, i) => (
            <rect
              key={i}
              x={P + i * barW + 0.5}
              y={P + (1 - c / maxCount) * (H - 2 * P)}
              width={Math.max(barW - 1, 1)}
              height={(c / maxCount) * (H - 2 * P)}
              fill="var(--pw-accent)"
              opacity="0.7"
            />
          ))}
        </svg>
        <figcaption>
          评论时间 · {fmtMonthDay(minT)} ~ {fmtMonthDay(maxT)}
        </figcaption>
      </figure>
    </div>
  );
}

/* ============================================================
   TASK-PW-71：交叉检出矩阵——图形化改版（2026-08-12 用户拍板 ASCII 方案）
   口径稳定度条 + 四个大数字 + 桶矩阵堆叠条（一版一色）+ 评论点阵（●信号 ○噪音）。
   多版筛子是多个灵敏度不同的传感器，不是评委投票：
   没在某版出现 = 该版判了噪音（记录事实），不等于否决。
   ============================================================ */

/* 版本配色：按 runs 顺序取色，图例 / 桶条 / 点阵三处共用同一色 */
const MX_PALETTE = ['#6f63d8', '#2e9e6b', '#d9832b', '#c2547a', '#4a8fc7', '#94854a'];

/** 桶口径悬殊判定：最高检出 ≥3 且（有版本挂零 或 最高 ≥ 2.5×最低）→ 标 ⚠ */
function mxBucketDivergent(counts: number[]): boolean {
  if (counts.length === 0) return false;
  const max = Math.max(...counts);
  const min = Math.min(...counts);
  return max >= 3 && (min === 0 || max / min >= 2.5);
}

/** 交叉矩阵主视图：稳定度条 → 大数字 → 桶堆叠条 → 复核清单（常开）→ 复现区（默认折叠）。 */
function MatrixView({
  matrix,
  runLabels,
  onSend,
}: {
  matrix: PwVoiceSieveMatrix;
  runLabels: Map<string, string>;
  onSend: (item: PwVoiceSieveMatrixItem) => Promise<void>;
}) {
  const reproduced = matrix.items.filter((item) => item.signalRunCount >= 2);
  const singletons = matrix.items.filter((item) => item.signalRunCount === 1);
  const { consensusSignals: consensus, unionSignals: union } = matrix.summary;
  const total = matrix.runs[0]?.total ?? union;
  const allNoise = Math.max(total - union, 0);
  const stability = union > 0 ? Math.round((consensus / union) * 100) : 0;
  const colorOf = new Map(matrix.runs.map((run, i) => [run.id, MX_PALETTE[i % MX_PALETTE.length]]));
  const labelOf = (runId: string) => runLabels.get(runId) ?? '未知版本';
  const bucketMax = Math.max(...matrix.bucketMatrix.map((row) => row.total), 1);
  return (
    <div className="pw-sieve">
      {/* 口径稳定度 = 全版一致信号 ÷ 信号并集；低说明筛子口径飘，数据先别用 */}
      <div className="pw-mx-stab">
        <span className="pw-mx-stab-label">口径稳定度</span>
        <span className="pw-mx-stab-track">
          <span className="pw-mx-stab-fill" style={{ width: `${stability}%` }} />
        </span>
        <span className="pw-mx-stab-pct">{stability}%</span>
      </div>
      <div className="pw-mx-stats">
        <div className="pw-mx-stat">
          <strong>{consensus}</strong>
          <span>全版全中 · 免看</span>
        </div>
        <div className="pw-mx-stat">
          <strong>{reproduced.length}</strong>
          <span>多版复现 · 免看</span>
        </div>
        <div className="pw-mx-stat is-todo">
          <strong>{singletons.length}</strong>
          <span>单版独有 · 要你判</span>
        </div>
        <div className="pw-mx-stat">
          <strong>{allNoise}</strong>
          <span>全判噪音 · 免看</span>
        </div>
      </div>
      {/* 图例：一版一色，与桶条/点阵同色 */}
      <div className="pw-mx-legend">
        {matrix.runs.map((run) => (
          <span key={run.id} className="pw-mx-legend-item" title={`${run.family} · ${fmtStamp(run.createdAt)} · 信号 ${run.signal}`}>
            <i style={{ background: colorOf.get(run.id) }} />
            {labelOf(run.id)}
          </span>
        ))}
      </div>
      {matrix.summary.runCount === 1 && (
        <p className="pw-sieve-mx-summary">只有一版筛子——再跑一版不同模型，才看得出哪些是复现、哪些是独有。</p>
      )}
      {/* 桶矩阵：堆叠横条，一段=一版检出数；条长按桶总数占最大桶比例 */}
      <div className="pw-mx-bars">
        {matrix.bucketMatrix.map((row) => {
          const countByRun = new Map(row.perRun.map((cell) => [cell.runId, cell.count]));
          const counts = matrix.runs.map((run) => countByRun.get(run.id) ?? 0);
          const divergent = matrix.runs.length > 1 && mxBucketDivergent(counts);
          return (
            <div key={row.bucket} className="pw-mx-bar-row">
              <span className="pw-sieve-mx-bucket-name">{row.bucket}</span>
              <span
                className="pw-mx-bar-track"
                title={counts.map((count, i) => `${labelOf(matrix.runs[i].id)} ${count} 条`).join(' · ')}
              >
                {matrix.runs.map((run, i) =>
                  counts[i] > 0 ? (
                    <span
                      key={run.id}
                      className="pw-mx-bar-seg"
                      style={{ width: `${(counts[i] / bucketMax) * 100}%`, background: colorOf.get(run.id) }}
                    />
                  ) : null,
                )}
              </span>
              <span className="pw-sieve-mx-bucket-total">{row.total} 条</span>
              {divergent && (
                <span className="pw-mx-warn" title="各版检出悬殊：这个桶口径不稳，引用前先抽查">
                  ⚠
                </span>
              )}
            </div>
          );
        })}
      </div>
      {/* 复核清单：全页唯一要人判断的地方，永远展开 */}
      {singletons.length > 0 && (
        <div className="pw-mx-todo">
          <p className="pw-mx-todo-title">
            ⚑ 复核清单（{singletons.length} 条）
            <span className="pw-sieve-mx-group-hint">只有一版检出——不等于错，逐条过目再定</span>
          </p>
          {singletons.map((item) => (
            <MatrixItem key={item.rpid} item={item} runs={matrix.runs} runLabels={runLabels} colorOf={colorOf} onSend={onSend} />
          ))}
        </div>
      )}
      {/* 复现区：稳的信号，默认折叠，展开才看 */}
      {reproduced.length > 0 && (
        <details className="pw-sieve-mx-group">
          <summary>
            多版复现（{reproduced.length} 条）
            <span className="pw-sieve-mx-group-hint">≥2 版都检出，默认可不看</span>
          </summary>
          <MatrixGroupItems items={reproduced} runs={matrix.runs} runLabels={runLabels} colorOf={colorOf} onSend={onSend} />
        </details>
      )}
    </div>
  );
}

/** 复现区条目列表：默认前 10 条，可展开全部。 */
function MatrixGroupItems({
  items,
  runs,
  runLabels,
  colorOf,
  onSend,
}: {
  items: PwVoiceSieveMatrixItem[];
  runs: PwVoiceSieveMatrixRun[];
  runLabels: Map<string, string>;
  colorOf: Map<string, string>;
  onSend: (item: PwVoiceSieveMatrixItem) => Promise<void>;
}) {
  const [showAll, setShowAll] = useState(false);
  const PAGE = 10;
  const shown = showAll ? items : items.slice(0, PAGE);
  return (
    <div>
      {shown.map((item) => (
        <MatrixItem key={item.rpid} item={item} runs={runs} runLabels={runLabels} colorOf={colorOf} onSend={onSend} />
      ))}
      {!showAll && items.length > PAGE && (
        <button type="button" className="pw-cl-btn-ghost pw-sieve-more" onClick={() => setShowAll(true)}>
          展开全部 {items.length} 条
        </button>
      )}
    </div>
  );
}

/** 矩阵单条：点阵（每版一列 ●信号/○噪音，悬停看版本与桶）+ 原文 + 送进探索区。 */
function MatrixItem({
  item,
  runs,
  runLabels,
  colorOf,
  onSend,
}: {
  item: PwVoiceSieveMatrixItem;
  runs: PwVoiceSieveMatrixRun[];
  runLabels: Map<string, string>;
  colorOf: Map<string, string>;
  onSend: (item: PwVoiceSieveMatrixItem) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const full = (item.message ?? '').trim();
  const truncated = full.length > 120;
  const hitByRun = new Map(item.signalRuns.map((hit) => [hit.runId, hit]));
  const noiseSet = new Set(item.noiseRuns);
  return (
    <div className="pw-sieve-item">
      <p className="pw-sieve-item-msg">
        <span className="pw-mx-dots">
          {runs.map((run) => {
            const hit = hitByRun.get(run.id);
            const label = runLabels.get(run.id) ?? '未知版本';
            if (hit) {
              return (
                <span
                  key={run.id}
                  className="pw-mx-dot is-signal"
                  style={{ background: colorOf.get(run.id) }}
                  title={`${label}：信号${hit.bucket ? ` · ${hit.bucket}` : ''}`}
                />
              );
            }
            if (noiseSet.has(run.id)) {
              return (
                <span key={run.id} className="pw-mx-dot is-noise" title={`${label}：判了噪音——只是没检出，不等于否决`} />
              );
            }
            return null;
          })}
        </span>
        {truncated && !open ? (
          <button type="button" className="pw-sieve-expand" title="点击展开全文" onClick={() => setOpen(true)}>
            「{firstSentence(full)}…[全文 {full.length} 字]」
          </button>
        ) : (
          <span>「{full}」</span>
        )}
      </p>
      <p className="pw-sieve-item-meta">
        <span>@{item.uname}</span>
        <span>{item.like} 赞</span>
        <span className="pw-vc-time">{fmtMonthDay(item.ctime)}</span>
        <span>rpid:{item.rpid}</span>
        {item.familyCount >= 2 && <span className="pw-sieve-mx-fam">{item.familyCount} 家族复现</span>}
        {!sent ? (
          <button
            type="button"
            className="pw-sieve-send"
            disabled={sending}
            onClick={async () => {
              setSending(true);
              try {
                await onSend(item);
                setSent(true);
              } catch {
                /* toast 已在外层 showToast */
              } finally {
                setSending(false);
              }
            }}
          >
            {sending ? '送入中…' : '送进探索区'}
          </button>
        ) : (
          <span className="pw-sieve-sent">已进探索区 ✓</span>
        )}
      </p>
    </div>
  );
}
