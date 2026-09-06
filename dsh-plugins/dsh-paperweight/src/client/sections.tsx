/**
 * 左栏镇纸区六个分区(推送/押注/金碑/声音/笔记/运维)。
 * 纪律:摆证据不给结论;排序依据印在卡上;永无「推荐」字样(铁律3)。
 */
import { useMemo, useState } from "react";
import type { PwBetView, PwDraftBetInput, PwDraftView, PwPushFeedItem, PwVerdictView } from "../types.ts";
import { pwApi } from "./api.ts";
import { Blank, Err, fmtDay, Loading, useAsync, useUi } from "./hooks.tsx";
import { pwStore } from "./state.ts";

/* ---------------- 推送区(铁律6:独立区+未读标记,不混对话列表) ---------------- */

const PUSH_KIND_LABEL: Record<PwPushFeedItem["kind"], string> = {
  daily: "今日值得看",
  due: "到期待裁决",
  needs_human: "等人工接手",
};

export function PushSection(): React.ReactNode {
  const { epoch } = useUi();
  const feed = useAsync(() => pwApi.pushFeed(), [epoch]);
  const [busy, setBusy] = useState(false);
  const [cardBusy, setCardBusy] = useState<string | null>(null);
  const [cardErr, setCardErr] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, "pick" | "reject">>({});

  const markAll = async (): Promise<void> => {
    setBusy(true);
    try {
      const unread = await pwApi.pushMarkRead({ all: true });
      pwStore.setUnread(unread);
      pwStore.bump();
    } finally {
      setBusy(false);
    }
  };

  /** 人亲手点的挑/否(铁律2):经 /pw/api/action 直连,host 记 source=human-click。 */
  const actOnCard = async (cardId: string, action: "pick" | "reject"): Promise<void> => {
    setCardBusy(cardId);
    setCardErr(null);
    try {
      await pwApi.action({ action, targetType: "sieve_card", targetId: cardId });
      setDone((d) => ({ ...d, [cardId]: action }));
      pwStore.bump();
    } catch (e) {
      setCardErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCardBusy(null);
    }
  };

  const openItem = async (item: PwPushFeedItem): Promise<void> => {
    if (!item.read) {
      try {
        const unread = await pwApi.pushMarkRead({ id: item.id });
        pwStore.setUnread(unread);
      } catch {
        /* 已读标记失败不拦跳转 */
      }
    }
    const betRef = item.sourceRefs.find((r) => r.type === "bet");
    if (betRef) {
      pwStore.openDetail({ kind: "bet", id: betRef.id });
    } else if (item.kind === "needs_human") {
      pwStore.setSection("ops");
    } else if (item.sourceRefs.some((r) => r.type === "sieve_card" || r.type === "draft")) {
      pwStore.setSection("bets");
    }
    pwStore.bump();
  };

  if (feed.loading) return <Loading />;
  if (feed.error) return <Err msg={feed.error} />;
  const items = feed.data?.items ?? [];
  if (items.length === 0) return <Blank text="推送收件箱是空的。每日「今日值得看」与到期提醒会出现在这里。" />;

  return (
    <div>
      <div className="pwx-row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <span className="pwx-meta">{feed.data?.unread ?? 0} 条未读</span>
        <button className="pwx-btn" disabled={busy || (feed.data?.unread ?? 0) === 0} onClick={() => void markAll()}>
          全部已读
        </button>
      </div>
      {items.map((item) => (
        <div
          key={item.id}
          className="pwx-card"
          style={item.read ? { opacity: 0.72 } : undefined}
          onClick={() => void openItem(item)}
        >
          <div className="pwx-row" style={{ justifyContent: "space-between" }}>
            <span className={`pwx-badge ${item.kind === "daily" ? "green" : "warn"}`}>{PUSH_KIND_LABEL[item.kind]}</span>
            {!item.read && <span className="pwx-dot" style={{ position: "static" }}>新</span>}
          </div>
          <h4 style={{ marginTop: 4 }}>{item.title}</h4>
          <div style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{item.summary}</div>
          <div className="pwx-meta" style={{ marginTop: 4 }}>
            <span>{item.date}</span>
            {item.sourceRefs
              .filter((r) => r.type !== "sieve_card")
              .map((r) => (
                <span key={`${r.type}:${r.id}`} className="pwx-badge">
                  {r.label}
                </span>
              ))}
          </div>
          {item.sourceRefs.some((r) => r.type === "sieve_card") && (
            <div style={{ marginTop: 6 }}>
              {item.sourceRefs
                .filter((r) => r.type === "sieve_card")
                .map((r) => (
                  <div key={r.id} className="pwx-row" style={{ marginTop: 4, alignItems: "flex-start" }}>
                    <span style={{ flex: 1, fontSize: 12 }}>{r.label}</span>
                    {done[r.id] ? (
                      <span className={`pwx-badge ${done[r.id] === "pick" ? "green" : ""}`}>
                        {done[r.id] === "pick" ? "已挑 ✓" : "已否"}
                      </span>
                    ) : (
                      <span className="pwx-row" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="pwx-btn primary"
                          disabled={cardBusy === r.id}
                          onClick={() => void actOnCard(r.id, "pick")}
                        >
                          挑
                        </button>
                        <button
                          type="button"
                          className="pwx-btn danger"
                          disabled={cardBusy === r.id}
                          onClick={() => void actOnCard(r.id, "reject")}
                        >
                          否
                        </button>
                      </span>
                    )}
                  </div>
                ))}
              {cardErr && <div className="pwx-err" style={{ marginTop: 4 }}>{cardErr}</div>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ---------------- 押注台 ---------------- */

function betBadge(bet: PwBetView): React.ReactNode {
  if (bet.status === "pending") {
    if (bet.daysToCheckout === null) return <span className="pwx-badge green">押注中</span>;
    if (bet.daysToCheckout < 0) return <span className="pwx-badge warn">过期 {-bet.daysToCheckout} 天待裁决</span>;
    if (bet.daysToCheckout <= 3) return <span className="pwx-badge warn">距结账 {bet.daysToCheckout} 天</span>;
    return <span className="pwx-badge green">距结账 {bet.daysToCheckout} 天</span>;
  }
  if (bet.status === "settled") return <span className="pwx-badge">已结账</span>;
  if (bet.status === "void") return <span className="pwx-badge">作废</span>;
  return <span className="pwx-badge">草稿</span>;
}

export function BetsSection(): React.ReactNode {
  const { epoch } = useUi();
  const bets = useAsync(() => pwApi.listBets(), [epoch]);
  const drafts = useAsync(() => pwApi.listDrafts(), [epoch]);
  const [draftBusy, setDraftBusy] = useState<string | null>(null);
  const [draftErr, setDraftErr] = useState<string | null>(null);
  const grouped = useMemo(() => {
    const all = bets.data ?? [];
    return {
      pending: all.filter((b) => b.status === "pending"),
      done: all.filter((b) => b.status === "settled" || b.status === "void"),
    };
  }, [bets.data]);

  if (bets.loading || drafts.loading) return <Loading />;
  if (bets.error) return <Err msg={bets.error} />;
  if (drafts.error) return <Err msg={drafts.error} />;
  if ((bets.data ?? []).length === 0 && (drafts.data ?? []).length === 0) return <Blank text="还没有押注。" />;

  const promptRequired = (label: string, current: string | null): string | null => {
    if (current?.trim()) return current.trim();
    const value = window.prompt(`这份草稿缺少「${label}」，补齐后才能确认转正：`, "");
    return value?.trim() || null;
  };

  const confirmDraft = async (draft: PwDraftView): Promise<void> => {
    const metric = promptRequired("验证指标", draft.metric);
    if (!metric) return;
    const dataSourcePlan = promptRequired("数据来源计划", draft.dataSourcePlan);
    if (!dataSourcePlan) return;
    const checkoutDate = promptRequired("结账日 YYYY-MM-DD", draft.checkoutDate);
    if (!checkoutDate) return;
    const edits: PwDraftBetInput = {
      title: draft.title,
      thesis: draft.thesis,
      metric,
      metricTarget: draft.metricTarget ?? undefined,
      confidence: draft.confidence ?? undefined,
      dataSourcePlan,
      checkoutDate,
      kind: draft.kind,
      sourceCardId: draft.sourceCardId ?? undefined,
    };
    setDraftBusy(draft.id);
    setDraftErr(null);
    try {
      await pwApi.action({ action: "confirm", targetType: "draft", targetId: draft.id, edits });
      pwStore.bump();
    } catch (e) {
      setDraftErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDraftBusy(null);
    }
  };

  const renderCard = (bet: PwBetView): React.ReactNode => (
    <div key={bet.id} className="pwx-card" onClick={() => pwStore.openDetail({ kind: "bet", id: bet.id })}>
      <h4>{bet.title}</h4>
      <div className="pwx-meta">
        {betBadge(bet)}
        {bet.kind === "content" && <span className="pwx-badge">内容</span>}
        {bet.confidence !== null && <span>置信 {bet.confidence}%</span>}
        {bet.checkoutDate && <span>结账 {fmtDay(bet.checkoutDate)}</span>}
        {typeof bet.draftCount === "number" && bet.draftCount > 0 && <span className="pwx-badge warn">草稿 {bet.draftCount}</span>}
      </div>
    </div>
  );

  const renderDraft = (draft: PwDraftView): React.ReactNode => {
    const missing = [
      !draft.metric && "验证指标",
      !draft.dataSourcePlan && "数据来源",
      !draft.checkoutDate && "结账日",
    ].filter(Boolean) as string[];
    return (
      <div key={draft.id} className="pwx-card static">
        <h4>{draft.title}</h4>
        <div className="pwx-meta">
          <span className="pwx-badge warn">草稿 · 等你确认</span>
          {draft.kind === "content" && <span className="pwx-badge">内容</span>}
          {draft.draftHash && <span title={draft.draftHash}>hash {draft.draftHash.slice(0, 8)}</span>}
        </div>
        {missing.length > 0 && <div className="pwx-meta" style={{ marginTop: 5 }}>确认时需补：{missing.join("、")}</div>}
        <div className="pwx-row" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="pwx-btn primary"
            disabled={draftBusy === draft.id}
            onClick={() => void confirmDraft(draft)}
          >
            {draftBusy === draft.id ? "确认中…" : "确认转正(人)"}
          </button>
          <span className="pwx-meta">只在人亲手点击后写入正式区</span>
        </div>
      </div>
    );
  };

  return (
    <div>
      {grouped.pending.length > 0 && <div className="pwx-sec-title">在途({grouped.pending.length})</div>}
      {grouped.pending.map(renderCard)}
      {(drafts.data ?? []).length > 0 && <div className="pwx-sec-title">草稿区 · 等你确认({(drafts.data ?? []).length})</div>}
      {(drafts.data ?? []).map(renderDraft)}
      {draftErr && <Err msg={draftErr} />}
      {grouped.done.length > 0 && <div className="pwx-sec-title">已了结({grouped.done.length})</div>}
      {grouped.done.map(renderCard)}
    </div>
  );
}

/* ---------------- 金子墓碑库 ---------------- */

export function VaultSection(): React.ReactNode {
  const { epoch } = useUi();
  const [q, setQ] = useState("");
  const [outcome, setOutcome] = useState<"" | "gold" | "tomb">("");
  const verdicts = useAsync(
    () => pwApi.listVerdicts({ outcome: outcome || undefined, q: q || undefined }),
    [epoch, outcome, q],
  );

  const renderRow = (v: PwVerdictView): React.ReactNode => (
    <div key={v.id} className="pwx-card" onClick={() => pwStore.openDetail({ kind: "verdict", id: v.id })}>
      <div className="pwx-row" style={{ justifyContent: "space-between" }}>
        <span className={`pwx-badge ${v.outcome === "gold" ? "gold" : "tomb"}`}>
          {v.outcome === "gold" ? "金子" : v.outcome === "tomb" ? "墓碑" : "作废"}
        </span>
        <span className="pwx-meta">{fmtDay(v.decidedAt)}</span>
      </div>
      <h4 style={{ marginTop: 4 }}>{v.outcome === "gold" ? (v.lesson ?? "(无 lesson)") : (v.causeOfDeath ?? "(无死因)")}</h4>
      {v.betTitle && <div className="pwx-meta">来自押注:{v.betTitle}</div>}
    </div>
  );

  return (
    <div>
      <input
        className="pwx-search"
        placeholder="搜金句 / 死因…"
        value={q}
        onChange={(e) => setQ(e.currentTarget.value)}
      />
      <div className="pwx-row" style={{ marginBottom: 8 }}>
        {([
          ["", "全部"],
          ["gold", "金子"],
          ["tomb", "墓碑"],
        ] as const).map(([val, label]) => (
          <button
            key={val || "all"}
            className={`pwx-btn${outcome === val ? " primary" : ""}`}
            onClick={() => setOutcome(val)}
          >
            {label}
          </button>
        ))}
      </div>
      {verdicts.loading ? (
        <Loading />
      ) : verdicts.error ? (
        <Err msg={verdicts.error} />
      ) : (verdicts.data ?? []).length === 0 ? (
        <Blank text="这本账还空着。铸金、立碑都会进来。" />
      ) : (
        (verdicts.data ?? []).map(renderRow)
      )}
    </div>
  );
}

/* ---------------- 观众声音 ---------------- */

export function VoiceSection(): React.ReactNode {
  const { epoch } = useUi();
  const themes = useAsync(() => pwApi.listVoiceThemes(), [epoch]);

  if (themes.loading) return <Loading />;
  if (themes.error) return <Err msg={themes.error} />;
  const list = themes.data ?? [];
  if (list.length === 0) return <Blank text="还没有筛出的主题卡。语料筛子跑完会在这里摆盘。" />;

  const byVideo = new Map<string, { title: string | null; themes: typeof list }>();
  for (const t of list) {
    const bucket = byVideo.get(t.bvid) ?? { title: t.videoTitle, themes: [] as typeof list };
    bucket.themes.push(t);
    if (!bucket.title && t.videoTitle) bucket.title = t.videoTitle;
    byVideo.set(t.bvid, bucket);
  }

  return (
    <div>
      {[...byVideo.entries()].map(([bvid, group]) => (
        <div key={bvid}>
          <div className="pwx-sec-title">{group.title ?? bvid}</div>
          {group.themes.map((t) => (
            <div key={t.id} className="pwx-card" onClick={() => pwStore.openDetail({ kind: "voiceTheme", id: t.id })}>
              <h4>{t.title}</h4>
              {t.summary && <div style={{ fontSize: 12 }}>{t.summary}</div>}
              <div className="pwx-meta">
                <span className="pwx-badge">{t.itemCount} 条原文</span>
                <span className={`pwx-badge ${t.status === "collected" ? "green" : ""}`}>
                  {t.status === "suggested" ? "待处理" : t.status === "collected" ? "已收" : "已否"}
                </span>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/* ---------------- 大盘笔记 ---------------- */

export function NotesSection(): React.ReactNode {
  const { epoch } = useUi();
  const today = useAsync(() => pwApi.notesToday(), [epoch]);
  const tree = useAsync(() => pwApi.notesTree(), [epoch]);

  return (
    <div>
      {today.data && !today.data.memosOk && <div className="pwx-err">连不上笔记库(Memos)。以下可能是旧数据。</div>}
      <div className="pwx-sec-title">最近笔记</div>
      {today.loading ? (
        <Loading />
      ) : today.error ? (
        <Err msg={today.error} />
      ) : (today.data?.notes ?? []).length === 0 ? (
        <Blank text="最近没有笔记。" />
      ) : (
        (today.data?.notes ?? []).map((n) => (
          <div key={n.uid} className="pwx-card" onClick={() => window.open(n.url, "_blank", "noopener")}>
            <div style={{ fontSize: 12.5, whiteSpace: "pre-wrap" }}>
              {n.content.length > 160 ? `${n.content.slice(0, 160)}…` : n.content}
            </div>
            <div className="pwx-meta" style={{ marginTop: 4 }}>
              <span>{fmtDay(n.createdAt)}</span>
              {n.pinned && <span className="pwx-badge warn">置顶</span>}
              {n.tags.slice(0, 3).map((t) => (
                <span key={t} className="pwx-badge">#{t}</span>
              ))}
              <span className="pwx-badge green">去 Memos ↗</span>
            </div>
          </div>
        ))
      )}
      <div className="pwx-sec-title">按押注回顾</div>
      {tree.loading ? (
        <Loading />
      ) : tree.error ? (
        <Err msg={tree.error} />
      ) : (tree.data?.bets ?? []).length === 0 ? (
        <Blank text="在途押注还没有挂上的笔记。" />
      ) : (
        (tree.data?.bets ?? []).map((b) => (
          <div key={b.betId} className="pwx-card static">
            <h4
              style={{ cursor: "pointer" }}
              onClick={() => pwStore.openDetail({ kind: "bet", id: b.betId })}
            >
              {b.title}
            </h4>
            <div className="pwx-meta">
              <span className="pwx-badge">{b.status}</span>
              {b.dueDate && <span>结账 {fmtDay(b.dueDate)}</span>}
              <span>{b.notes.length} 条笔记</span>
            </div>
            {b.notes.slice(0, 5).map((n) => (
              <div key={n.uid} className="pwx-meta" style={{ marginTop: 3 }}>
                <span>· {fmtDay(n.createdAt)}</span>
                {n.keyword && <span className="pwx-badge">命中:{n.keyword}</span>}
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

/* ---------------- 运维数据源 ---------------- */

export function OpsSection(): React.ReactNode {
  const { epoch } = useUi();
  const ops = useAsync(() => pwApi.opsStatus(), [epoch]);

  if (ops.loading) return <Loading />;
  if (ops.error) return <Err msg={ops.error} />;
  const d = ops.data;
  if (!d) return <Blank text="没有拿到运维状态。" />;

  const counts: Array<[string, number]> = [
    ["押注", d.counts.bets],
    ["在途", d.counts.pendingBets],
    ["判决", d.counts.verdicts],
    ["数据文档", d.counts.dataDocs],
    ["草稿", d.counts.drafts],
    ["候选卡待筛", d.counts.sievePending],
  ];

  return (
    <div>
      <div className="pwx-card static">
        <div className="pwx-row" style={{ justifyContent: "space-between" }}>
          <h4>镇纸服务(4317)</h4>
          <span className={`pwx-badge ${d.server.ready ? "green" : "warn"}`}>{d.server.ready ? "在跑" : "异常"}</span>
        </div>
        <div className="pwx-meta">
          <span>node {d.server.node}</span>
          <span>{d.server.modelConfigured ? "模型已配" : "模型未配"}</span>
          <span>{d.server.memory.available ? "Memos 可用" : "Memos 不可用"}</span>
        </div>
      </div>
      <div className="pwx-sec-title">对账数字(应与 4317 大屏一致)</div>
      <div className="pwx-card static">
        <div className="pwx-kv">
          {counts.flatMap(([label, n]) => [
            <dt key={`${label}-k`}>{label}</dt>,
            <dd key={`${label}-v`}>{n}</dd>,
          ])}
        </div>
        <div className="pwx-meta">取数时间 {d.fetchedAt}</div>
      </div>
      <div className="pwx-sec-title">数据源连接</div>
      {d.connections.length === 0 ? (
        <Blank text="还没有登记数据源连接。" />
      ) : (
        d.connections.map((c) => (
          <div key={c.id} className="pwx-card static">
            <div className="pwx-row" style={{ justifyContent: "space-between" }}>
              <h4>
                {c.platform}
                {c.accountLabel ? ` · ${c.accountLabel}` : ""}
              </h4>
              <span className={`pwx-badge ${c.status === "active" ? "green" : c.status === "needs_human" ? "warn" : ""}`}>
                {c.status === "active" ? "正常" : c.status === "needs_human" ? "等人工接手" : "暂停"}
              </span>
            </div>
            <div className="pwx-meta">
              <span>最近同步 {c.lastSyncAt ? fmtDay(c.lastSyncAt) : "从未"}</span>
              <span>{c.docsCount} 份文档</span>
              {c.riskEvents.length > 0 && <span className="pwx-badge warn">风控事件 {c.riskEvents.length}</span>}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
