/**
 * 数据源屏（TASK-PW-13，一比一 papertable-sources.html）：
 * 左栏项目卡片树（与押注台同源，点击条目跳押注台）+ 数据源入口条（is-current）；
 * 主区：page-head → 待人工处理纸签（needs_human 时出现）→ 平台连接五卡
 * （B站三态真实，其余四平台置灰未开通）→ 说明纸带 → 定向语料（TASK-PW-14：
 * 授权登记的 BV 队列与状态徽章 + 登记获取弹层）→ 回流数据文档表。
 * 数据：/api/pw/connections、/api/pw/data-docs、/api/pw/bets、/api/pw/verdicts、/api/pw/corpus。
 */
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  pwApi,
  type PwConnection,
  type PwCorpusDoc,
  type PwDataDocRow,
  type PwOutcome,
} from '../lib/api';
import { useStore } from '../store';
import { fmtTime, parseMetrics, useAsync } from './hooks';
import { PwModal } from './ui';

const BILIBILI = 'B站';

/** 五张平台卡固定顺序（照设计稿）；P1 只接入 B站 */
const PLATFORM_CARDS: Array<{ name: string; icon: ReactNode }> = [
  {
    name: 'B站',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <rect x="1.5" y="4" width="15" height="11" rx="2.5" stroke="#2e2a24" strokeWidth="1.3" />
        <path d="M 6 1.5 L 8 4 M 12 1.5 L 10 4" stroke="#2e2a24" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    name: '小红书',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <path d="M 3 2.5 L 12.5 2.5 L 15 5 L 15 15.5 L 3 15.5 Z" stroke="#2e2a24" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M 12.5 2.5 L 12.5 5 L 15 5" stroke="#2e2a24" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M 6 8.5 L 12 8.5 M 6 11.5 L 11 11.5" stroke="#2e2a24" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    name: '抖音',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <path d="M 11.5 2.5 L 11.5 11.8" stroke="#2e2a24" strokeWidth="1.3" strokeLinecap="round" />
        <path d="M 11.5 3 C 12.6 4.8, 14.2 5.6, 16 5.8" stroke="#2e2a24" strokeWidth="1.3" strokeLinecap="round" />
        <ellipse cx="8" cy="12.6" rx="3.4" ry="2.8" stroke="#2e2a24" strokeWidth="1.3" />
      </svg>
    ),
  },
  {
    name: 'YouTube',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <rect x="1.5" y="3.5" width="15" height="11" rx="3" stroke="#2e2a24" strokeWidth="1.3" />
        <path d="M 7.5 6.8 L 11.8 9 L 7.5 11.2 Z" fill="#2e2a24" />
      </svg>
    ),
  },
  {
    name: 'X',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <path d="M 3 3 L 15 15 M 15 3 L 3 15" stroke="#2e2a24" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
];

export function Sources({
  epoch,
  onChanged,
  onNav,
}: {
  epoch: number;
  onChanged: () => void;
  onNav: (s: 'workbench') => void;
}) {
  const { showToast } = useStore();
  const betsState = useAsync(() => pwApi.listBets(), [epoch]);
  const verdictsState = useAsync(() => pwApi.listVerdicts(), [epoch]);
  const connectionsState = useAsync(() => pwApi.listConnections(), [epoch]);
  const docsState = useAsync(() => pwApi.listAllDataDocs(), [epoch]);
  const corpusState = useAsync(() => pwApi.listCorpus(), [epoch]);
  const [connectOpen, setConnectOpen] = useState(false);
  const [corpusOpen, setCorpusOpen] = useState(false);

  const bets = useMemo(() => betsState.data?.bets ?? [], [betsState.data]);
  // 卡片树与押注台同源：只列非 draft、非作废押注
  const liveBets = useMemo(() => bets.filter((b) => b.status !== 'draft' && b.status !== 'void'), [bets]);
  const verdictByBet = useMemo(() => {
    const map = new Map<string, PwOutcome>();
    for (const v of verdictsState.data?.verdicts ?? []) {
      if (v.outcome !== 'void') map.set(v.bet_id, v.outcome);
    }
    return map;
  }, [verdictsState.data]);

  const connections = useMemo(() => connectionsState.data?.connections ?? [], [connectionsState.data]);
  const docs = useMemo(() => docsState.data?.docs ?? [], [docsState.data]);
  const corpusDocs = useMemo(() => corpusState.data?.items ?? [], [corpusState.data]);
  const bilibili = connections.find((c) => c.platform === BILIBILI) ?? null;
  const needsHuman = connections.filter((c) => c.status === 'needs_human');
  const connectedCount = connections.length;

  const reloadLocal = () => {
    connectionsState.reload();
    docsState.reload();
  };

  const resume = async (conn: PwConnection) => {
    await pwApi.setConnectionStatus(conn.id, { status: 'active' });
    reloadLocal();
    onChanged();
    showToast({ text: '已恢复同步；若尚未完成验证，请先在 ego lite 浏览器里处理' });
  };

  return (
    <div className="pw-layout pw-sources-layout">
      {/* 左栏：项目卡片树（与押注台同源）+ 数据源入口（当前页） */}
      <aside className="pw-sidebar">
        <div className="pw-sidebar-title">项目卡片树</div>
        {betsState.error && <div className="pw-err">{betsState.error}</div>}
        <ul className="pw-tree">
          <li>
            <button type="button" className="pw-tree-item pw-tree-project" onClick={() => onNav('workbench')}>
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
                      className={`pw-tree-item${outcome === 'tomb' ? ' is-tomb' : ''}`}
                      onClick={() => onNav('workbench')}
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
          <button type="button" className="pw-sources-entry is-current" aria-current="page">
            <span>
              <span className="se-label">数据源</span>
              <span className="se-hint">
                {needsHuman.length > 0 ? `${needsHuman.length} 条待人工处理` : '低频同步中'}
              </span>
            </span>
            {needsHuman.length > 0 && (
              <span className="se-unread" aria-label={`${needsHuman.length} 条未处理`} />
            )}
          </button>
        </div>
      </aside>

      {/* 主内容 */}
      <main className="pw-sources-main">
        <div className="pw-sources-head">
          <h1>数据源</h1>
          <span className="hint">各平台数据低频回流，喂给「数据回流」节点</span>
        </div>

        {/* 待人工处理：黄色纸签（仅 needs_human 时渲染） */}
        {needsHuman.map((conn) => (
          <section className="pw-queue-slip" aria-label="待人工处理" key={conn.id}>
            <svg className="slip-icon" width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <circle cx="10" cy="10" r="8.2" stroke="#2e2a24" strokeWidth="1.4" />
              <path d="M 10 5.6 L 10 10.8" stroke="#2e2a24" strokeWidth="1.4" strokeLinecap="round" />
              <circle cx="10" cy="14" r="1" fill="#2e2a24" />
            </svg>
            <span className="slip-tag">待人工处理</span>
            <p className="slip-text">
              <strong>{conn.account_label ?? conn.platform}</strong>
              {' · 出现验证/登录环节，同步已暂停，需要你接手约 1 分钟'}
            </p>
            <button type="button" className="pw-btn primary" onClick={() => void resume(conn)}>
              打开浏览器接手
            </button>
          </section>
        ))}

        {/* 平台连接 */}
        <section>
          <div className="pw-sources-sec-head">
            <h2>平台连接</h2>
            <span className="hint">
              {`5 个平台 · ${connectedCount} 个已接入 · ${5 - connectedCount} 个未开通`}
            </span>
          </div>
          <div className="pw-platforms">
            {PLATFORM_CARDS.map(({ name, icon }) => {
              const conn = name === BILIBILI ? bilibili : null;
              return (
                <article className="pw-platform-card" key={name}>
                  <div className="pw-platform-head">
                    {icon}
                    <span className="p-name">{name}</span>
                  </div>
                  {name !== BILIBILI && (
                    <>
                      <span className="pw-status-badge s-off">
                        <span className="s-dot" aria-hidden="true" />
                        未开通
                      </span>
                      <p className="p-policy">后续接入 · 本期只做 B站</p>
                      <div className="p-foot">
                        <span className="p-sync">
                          <span className="p-label">最近同步</span>—
                        </span>
                        <span className="p-docs">
                          <span className="p-label">已回流</span>0 份数据文档
                        </span>
                      </div>
                    </>
                  )}
                  {name === BILIBILI && (
                    <>
                      {!conn && (
                        <span className="pw-status-badge s-off">
                          <span className="s-dot" aria-hidden="true" />
                          未连接
                        </span>
                      )}
                      {conn?.status === 'active' && (
                        <span className="pw-status-badge s-ok">
                          <span className="s-dot" aria-hidden="true" />
                          已连接 · 登录态有效
                        </span>
                      )}
                      {conn?.status === 'needs_human' && (
                        <span className="pw-status-badge s-warn">
                          <span className="s-dot" aria-hidden="true" />
                          需人工验证
                        </span>
                      )}
                      {conn?.status === 'paused' && (
                        <span className="pw-status-badge s-off">
                          <span className="s-dot" aria-hidden="true" />
                          已暂停
                        </span>
                      )}
                      <p className="p-policy">低频定向 · 每天 1 次 · 仅自己的账号</p>
                      <div className="p-foot">
                        <span className="p-sync">
                          <span className="p-label">最近同步</span>
                          {conn ? fmtTime(conn.last_sync_at) : '—'}
                        </span>
                        <span className="p-docs">
                          <span className="p-label">已回流</span>
                          {conn ? `${conn.docs_count} 份数据文档` : '0 份数据文档'}
                        </span>
                      </div>
                      {!conn && (
                        <button type="button" className="pw-btn-ghost" onClick={() => setConnectOpen(true)}>
                          连接账号
                        </button>
                      )}
                    </>
                  )}
                </article>
              );
            })}
          </div>
        </section>

        {/* 说明纸带 */}
        <aside className="pw-note-strip">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="5.8" stroke="#99948b" strokeWidth="1.2" />
            <path d="M 7 6.4 L 7 10" stroke="#99948b" strokeWidth="1.2" strokeLinecap="round" />
            <circle cx="7" cy="4.2" r="0.9" fill="#99948b" />
          </svg>
          <p>
            同步方式：云端大模型 + AI 浏览器模拟真人操作；遇到验证码等人工环节自动暂停并通知你；只做低频定向获取，避免触发平台风控。
          </p>
        </aside>

        {/* 定向语料（TASK-PW-14）：人工授权登记 → 抓取器低频落本地 */}
        <section>
          <div className="pw-sources-sec-head">
            <h2>定向语料</h2>
            <span className="hint">关注的视频数据与评论，授权后低频抓取落本地</span>
            <button type="button" className="pw-btn sm" onClick={() => setCorpusOpen(true)}>
              登记获取
            </button>
          </div>
          {corpusState.error && <div className="pw-err">{corpusState.error}</div>}
          {!corpusState.error && corpusDocs.length === 0 && !corpusState.loading && (
            <div className="pw-blank">还没有登记。把想研究的视频 BV 号放进来。</div>
          )}
          {corpusDocs.length > 0 && (
            <div className="pw-doc-list">
              {corpusDocs.map((doc) => (
                <CorpusRow
                  key={doc.id}
                  doc={doc}
                  onResolved={(bvid) => {
                    corpusState.reload();
                    onChanged();
                    showToast({ text: `已重新排队抓取 ${bvid}` });
                  }}
                />
              ))}
            </div>
          )}
        </section>

        {/* 回流数据文档 */}
        <section>
          <div className="pw-sources-sec-head">
            <h2>回流数据文档</h2>
            <span className="hint">进入索引后即可在押注卡与判决簿中引用</span>
          </div>
          {docsState.error && <div className="pw-err">{docsState.error}</div>}
          {!docsState.error && docs.length === 0 && !docsState.loading && (
            <div className="pw-blank">还没有回流数据文档。</div>
          )}
          {docs.length > 0 && (
            <div className="pw-doc-list">
              <div className="pw-doc-row doc-head" aria-hidden="true">
                <span className="doc-platform-h">平台</span>
                <span className="doc-title">内容</span>
                <span className="doc-metrics-h">关键数据</span>
                <span className="doc-time">同步时间</span>
                <span className="doc-indexed-h">索引</span>
              </div>
              {docs.map((doc) => (
                <DocRow key={doc.id} doc={doc} />
              ))}
            </div>
          )}
        </section>
      </main>

      {connectOpen && (
        <ConnectModal
          onClose={() => setConnectOpen(false)}
          onDone={(conn) => {
            setConnectOpen(false);
            reloadLocal();
            onChanged();
            showToast({ text: `B站账号已连接：${conn.account_label ?? conn.platform}` });
          }}
        />
      )}
      {corpusOpen && (
        <CorpusModal
          onClose={() => setCorpusOpen(false)}
          onDone={(bvid) => {
            setCorpusOpen(false);
            corpusState.reload();
            onChanged();
            showToast({ text: `已授权抓取 ${bvid}` });
          }}
        />
      )}
    </div>
  );
}

/* ---------- 定向语料行（TASK-PW-14） ---------- */
function CorpusRow({
  doc,
  onResolved,
}: {
  doc: PwCorpusDoc;
  onResolved: (bvid: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const resolve = async () => {
    setBusy(true);
    try {
      await pwApi.authorizeCorpus({ bvid: doc.bvid, force: 1 });
      onResolved(doc.bvid);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pw-doc-row">
      <span className="pw-doc-platform">B站</span>
      <span className="doc-title" title={doc.title ?? doc.bvid}>{doc.title ?? doc.bvid}</span>
      <span className="doc-status"><CorpusStatusPill doc={doc} /></span>
      <span className="doc-time">{fmtTime(doc.fetched_at ?? doc.created_at)}</span>
      <span className="doc-action">
        {doc.status === 'needs_human' && (
          <button
            type="button"
            className="pw-btn-ghost sm"
            disabled={busy}
            onClick={() => void resolve()}
          >
            已处理
          </button>
        )}
      </span>
    </div>
  );
}

function CorpusStatusPill({ doc }: { doc: PwCorpusDoc }) {
  if (doc.status === 'done') {
    return (
      <span className="doc-indexed">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <circle cx="6" cy="6" r="5.2" stroke="#3f6e5a" strokeWidth="1.2" />
          <path d="M 3.6 6.2 L 5.4 8 L 8.4 4.4" stroke="#3f6e5a" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {`已落盘 · ${doc.comment_count ?? 0} 评论`}
      </span>
    );
  }
  if (doc.status === 'fetching') {
    return (
      <span className="pw-st live">
        <i />
        抓取中
      </span>
    );
  }
  if (doc.status === 'needs_human') {
    return (
      <span className="pw-st due" title={doc.error ?? undefined}>
        <i />
        待人工
      </span>
    );
  }
  if (doc.status === 'failed') {
    return (
      <span className="pw-st tomb" title={doc.error ?? undefined}>
        <i />
        失败
      </span>
    );
  }
  return (
    <span className="pw-st">
      <i />
      排队中
    </span>
  );
}

/* ---------- 登记定向获取（接受 BV 号或含 BV 的链接） ---------- */
function CorpusModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (bvid: string) => void;
}) {
  const [input, setInput] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const match = input.match(/BV[0-9A-Za-z]{10}/);
    if (!match) {
      setErr('没认出 BV 号：请输入 BV 号（BV 开头的 12 位）或含 BV 号的视频链接');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await pwApi.authorizeCorpus({ bvid: match[0] });
      onDone(match[0]);
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  return (
    <PwModal
      title="登记定向获取"
      sub="输入 BV 号或视频链接；下次同步时抓取，也可让 Agent 立刻跑"
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="pw-field">
          <label>BV 号 / 视频链接</label>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            autoFocus
            placeholder="BV1xxxxxxxxxx 或 https://www.bilibili.com/video/BV…"
          />
        </div>
        {err && <div className="pw-form-err">{err}</div>}
        <div className="pw-modal-foot">
          <button type="button" className="pw-btn" onClick={onClose}>取消</button>
          <button type="submit" className="pw-btn primary" disabled={busy}>
            {busy ? '登记中…' : '登记获取'}
          </button>
        </div>
      </form>
    </PwModal>
  );
}

/* ---------- 回流数据文档行 ---------- */
function DocRow({ doc }: { doc: PwDataDocRow }) {
  const metrics = parseMetrics(doc.metrics_json).slice(0, 3);
  const title = doc.artifact_title ?? doc.bet_title ?? '未关联';
  return (
    <div className="pw-doc-row">
      <span className="pw-doc-platform">{doc.platform}</span>
      <span className="doc-title" title={title}>{title}</span>
      <span className="doc-metrics">
        {metrics.map(([k, v], i) => (
          <span key={k}>
            {i > 0 && <span className="m-sep">·</span>}
            <b>{v}</b> {k}
          </span>
        ))}
      </span>
      <span className="doc-time">{fmtTime(doc.collected_at)}</span>
      {doc.frozen === 1 ? (
        <span className="doc-indexed is-frozen">已冻结</span>
      ) : (
        <span className="doc-indexed">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <circle cx="6" cy="6" r="5.2" stroke="#3f6e5a" strokeWidth="1.2" />
            <path d="M 3.6 6.2 L 5.4 8 L 8.4 4.4" stroke="#3f6e5a" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {doc.method === 'sync' ? '已回流 · 可引用' : doc.method === 'manual' ? '手动录入 · 可引用' : '已进索引 · 可引用'}
        </span>
      )}
    </div>
  );
}

/* ---------- 连接 B站账号（只登记账号标签，不碰 cookie 本体） ---------- */
function ConnectModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (conn: PwConnection) => void;
}) {
  const [accountLabel, setAccountLabel] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const conn = await pwApi.createConnection({
        platform: BILIBILI,
        accountLabel: accountLabel.trim() || undefined,
      });
      onDone(conn);
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  return (
    <PwModal
      title="连接 B站账号"
      sub="只登记账号标签；登录态留在你的 ego lite 浏览器里，镇纸不碰 cookie 本体"
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="pw-field">
          <label>账号标签（可选）</label>
          <input
            value={accountLabel}
            onChange={(e) => setAccountLabel(e.target.value)}
            autoFocus
            placeholder="我的 B站账号"
          />
        </div>
        {err && <div className="pw-form-err">{err}</div>}
        <div className="pw-modal-foot">
          <button type="button" className="pw-btn" onClick={onClose}>取消</button>
          <button type="submit" className="pw-btn primary" disabled={busy}>
            {busy ? '连接中…' : '连接'}
          </button>
        </div>
      </form>
    </PwModal>
  );
}
