/**
 * 详情浮层(shell.overlay 常驻注册,detail=null 时不渲染)。
 * 三种路由:押注单卡 / 判决证据链 / 观众声音主题逐字。
 * 写操作仅两处人按钮:draft 确认转正(POST /pw/api/action);其余全部只读。
 */
import { useEffect, useState } from "react";
import { pwApi } from "./api.ts";
import { Blank, Err, fmtDay, Loading, useAsync, useUi } from "./hooks.tsx";
import { pwStore } from "./state.ts";

function OverlayShell({ title, children }: { title: string; children?: unknown }): React.ReactNode {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") pwStore.closeDetail();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="pwx pwx-ovl" role="dialog" aria-modal="true" aria-label={title}>
      <div className="pwx-ovl-mask" onClick={() => pwStore.closeDetail()} />
      <div className="pwx-ovl-panel">
        <div className="pwx-ovl-head">
          <h3>{title}</h3>
          <button type="button" className="pwx-x" aria-label="关闭" onClick={() => pwStore.closeDetail()}>
            ✕
          </button>
        </div>
        <div className="pwx-ovl-body">{children as React.ReactNode}</div>
      </div>
    </div>
  );
}

function BetDetailBody({ id }: { id: string }): React.ReactNode {
  const { epoch } = useUi();
  const det = useAsync(() => pwApi.readBet(id), [id, epoch]);
  const [busy, setBusy] = useState(false);
  const [actErr, setActErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (det.loading) return <Loading />;
  if (det.error) return <Err msg={det.error} />;
  const bet = det.data;
  if (!bet) return <Blank text="没有这张卡。" />;

  const confirmDraft = async (): Promise<void> => {
    setBusy(true);
    setActErr(null);
    try {
      await pwApi.action({ action: "confirm", targetType: "draft", targetId: bet.id });
      pwStore.bump();
    } catch (e) {
      setActErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const copyContext = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(bet.contextMarkdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板被拒不致命 */
    }
  };

  return (
    <div>
      <div className="pwx-meta" style={{ marginBottom: 6 }}>
        <span className={`pwx-badge ${bet.status === "pending" ? "green" : bet.status === "draft" ? "warn" : ""}`}>
          {bet.status === "pending" ? "押注中" : bet.status === "draft" ? "草稿 · 等你确认" : bet.status === "settled" ? "已结账" : "作废"}
        </span>
        {bet.daysToCheckout !== null && bet.status === "pending" && (
          <span className={`pwx-badge ${bet.daysToCheckout <= 3 ? "warn" : ""}`}>
            {bet.daysToCheckout < 0 ? `过期 ${-bet.daysToCheckout} 天` : `距结账 ${bet.daysToCheckout} 天`}
          </span>
        )}
        {bet.kind === "content" && <span className="pwx-badge">内容押注</span>}
      </div>
      <dl className="pwx-kv">
        <dt>假设</dt>
        <dd>{bet.thesis || "—"}</dd>
        <dt>验证指标</dt>
        <dd>
          {bet.metric ?? "—"}
          {bet.metricTarget ? ` → ${bet.metricTarget}` : ""}
        </dd>
        <dt>数据来源</dt>
        <dd>{bet.dataSourcePlan ?? "—"}</dd>
        <dt>结账日</dt>
        <dd>{bet.checkoutDate ? fmtDay(bet.checkoutDate) : "—"}</dd>
        <dt>置信度</dt>
        <dd>{bet.confidence !== null ? `${bet.confidence}%` : "—"}</dd>
        <dt>建卡</dt>
        <dd>{fmtDay(bet.createdAt)}</dd>
      </dl>

      {bet.status === "draft" && (
        <div className="pwx-row" style={{ margin: "10px 0" }}>
          <button type="button" className="pwx-btn primary" disabled={busy} onClick={() => void confirmDraft()}>
            确认转正(人)
          </button>
          <span className="pwx-meta">确认即从草稿转为正式押注;驳回请去镇纸大屏操作</span>
        </div>
      )}
      {actErr && <Err msg={actErr} />}

      <div className="pwx-sec-title">回流数据文档({bet.dataDocs.length})</div>
      {bet.dataDocs.length === 0 ? (
        <Blank text="还没有回流数据。" />
      ) : (
        bet.dataDocs.map((doc) => (
          <div key={doc.id} className="pwx-card static">
            <div className="pwx-meta">
              <span className="pwx-badge">{doc.platform}</span>
              <span>v{doc.version}</span>
              <span>{doc.method}</span>
              <span>{fmtDay(doc.collectedAt)} 采集</span>
              {doc.frozen && <span className="pwx-badge gold">已冻结(被判决引用)</span>}
            </div>
            <div style={{ fontSize: 12, marginTop: 3, wordBreak: "break-all" }}>
              {Object.entries(doc.metrics)
                .slice(0, 6)
                .map(([k, v]) => `${k}=${String(v)}`)
                .join(" · ") || "(无指标)"}
            </div>
          </div>
        ))
      )}

      <div className="pwx-sec-title">相关判例({bet.precedents.length})</div>
      {bet.precedents.length === 0 ? (
        <Blank text="没有对得上的旧判例。" />
      ) : (
        bet.precedents.map((p, i) => (
          <div
            key={p.verdictId}
            className="pwx-card"
            onClick={() => pwStore.openDetail({ kind: "verdict", id: p.verdictId })}
          >
            <div className="pwx-meta">
              <span className={`pwx-badge ${p.outcome === "gold" ? "gold" : "tomb"}`}>
                §{i + 1} {p.outcome === "gold" ? "金子" : "墓碑"}
              </span>
              {p.source === "mirror" && <span className="pwx-badge">纸桌镜像</span>}
            </div>
            <div style={{ fontSize: 12.5, marginTop: 3 }}>{p.text}</div>
            <div className="pwx-meta" style={{ marginTop: 3 }}>
              <span>依据:{p.matchReason}</span>
            </div>
          </div>
        ))
      )}

      <div className="pwx-sec-title">装配上下文(@引用时 AI 看到的原文)</div>
      <div className="pwx-md">{bet.contextMarkdown || "(空)"}</div>
      <div className="pwx-row" style={{ marginTop: 8 }}>
        <button type="button" className="pwx-btn" onClick={() => void copyContext()}>
          {copied ? "已复制 ✓" : "复制上下文"}
        </button>
        <span className="pwx-meta">会话输入框里打 @ 选这张卡,可直接注入</span>
      </div>
    </div>
  );
}

function VerdictDetailBody({ id }: { id: string }): React.ReactNode {
  const det = useAsync(() => pwApi.readVerdictEvidence(id), [id]);
  if (det.loading) return <Loading />;
  if (det.error) return <Err msg={det.error} />;
  const data = det.data;
  if (!data) return <Blank text="没有这条判决。" />;
  const v = data.verdict;
  return (
    <div>
      <div className="pwx-meta" style={{ marginBottom: 6 }}>
        <span className={`pwx-badge ${v.outcome === "gold" ? "gold" : "tomb"}`}>
          {v.outcome === "gold" ? "金子" : v.outcome === "tomb" ? "墓碑" : "作废"}
        </span>
        <span>裁于 {fmtDay(v.decidedAt)}</span>
        <span className="pwx-badge green">decided_by = human</span>
        {v.confidenceSnapshot !== null && <span>当时置信 {v.confidenceSnapshot}%</span>}
      </div>
      <div className="pwx-quote">{v.outcome === "gold" ? (v.lesson ?? "(无 lesson)") : (v.causeOfDeath ?? "(无死因)")}</div>
      {v.betTitle && (
        <div className="pwx-meta" style={{ margin: "6px 0" }}>
          来自押注:
          <button type="button" className="pwx-btn" onClick={() => pwStore.openDetail({ kind: "bet", id: v.betId })}>
            {v.betTitle}
          </button>
        </div>
      )}
      <div className="pwx-sec-title">证据链({data.evidence.length} 份数据文档)</div>
      {data.evidence.length === 0 ? (
        <Blank text="这条判决没有引用数据文档。" />
      ) : (
        data.evidence.map((doc) => (
          <div key={doc.id} className="pwx-card static">
            <div className="pwx-meta">
              <span className="pwx-badge">{doc.platform}</span>
              <span>v{doc.version}</span>
              <span>{fmtDay(doc.collectedAt)} 采集</span>
              {doc.frozen && <span className="pwx-badge gold">已冻结</span>}
            </div>
            <div style={{ fontSize: 12, marginTop: 3, wordBreak: "break-all" }}>
              {Object.entries(doc.metrics)
                .slice(0, 8)
                .map(([k, val]) => `${k}=${String(val)}`)
                .join(" · ") || "(无指标)"}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function VoiceThemeDetailBody({ id }: { id: string }): React.ReactNode {
  const det = useAsync(() => pwApi.readVoiceTheme(id), [id]);
  if (det.loading) return <Loading />;
  if (det.error) return <Err msg={det.error} />;
  const t = det.data;
  if (!t) return <Blank text="没有这张主题卡。" />;
  return (
    <div>
      <div className="pwx-meta" style={{ marginBottom: 6 }}>
        <span className="pwx-badge">{t.videoTitle ?? t.bvid}</span>
        <span className="pwx-badge">{t.itemCount} 条</span>
        <span className={`pwx-badge ${t.status === "collected" ? "green" : ""}`}>
          {t.status === "suggested" ? "待处理" : t.status === "collected" ? "已收" : "已否"}
        </span>
      </div>
      {t.summary && <div style={{ fontSize: 12.5, marginBottom: 8 }}>{t.summary}</div>}
      <div className="pwx-sec-title">逐字原文(按赞数)</div>
      {t.items.length === 0 ? (
        <Blank text="这张卡还没有关联原文。" />
      ) : (
        [...t.items]
          .sort((a, b) => (b.like ?? 0) - (a.like ?? 0))
          .map((item) => (
            <div key={item.rpid} className="pwx-card static">
              <div className="pwx-row" style={{ alignItems: "flex-start" }}>
                <div className="pwx-quote" style={{ flex: 1, margin: 0 }}>
                  {item.message}
                </div>
                <span className="pwx-like">👍 {item.like ?? 0}</span>
              </div>
              <div className="pwx-meta" style={{ marginTop: 3 }}>
                {item.uname && <span>{item.uname}</span>}
                {item.ctime && <span>{fmtDay(new Date(item.ctime * 1000).toISOString())}</span>}
                {item.collected && <span className="pwx-badge green">已入声音池</span>}
              </div>
            </div>
          ))
      )}
    </div>
  );
}

export function DetailOverlay(): React.ReactNode {
  const { detail } = useUi();
  if (!detail) return null;
  if (detail.kind === "bet") {
    return (
      <OverlayShell title="押注单卡">
        <BetDetailBody id={detail.id} />
      </OverlayShell>
    );
  }
  if (detail.kind === "verdict") {
    return (
      <OverlayShell title="判决与证据">
        <VerdictDetailBody id={detail.id} />
      </OverlayShell>
    );
  }
  return (
    <OverlayShell title="观众声音 · 主题">
      <VoiceThemeDetailBody id={detail.id} />
    </OverlayShell>
  );
}
