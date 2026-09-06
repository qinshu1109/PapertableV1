/**
 * 镇纸纸感样式(pw.css token 移植版,作用域 .pwx- 前缀)。
 * 铁律5:纸底 #f1ebdf / 卡片 #fbf7ec / 墨 #2e2a24 / 墨绿 #3f6e5a / 圆角 10px / Noto Sans SC。
 * 面板即使宿主是深色主题也强制浅色纸感(硬约束:禁深色数据板)。
 */
export const PW_STYLES = `
.pwx {
  --pw-paper: #f1ebdf;
  --pw-card: #fbf7ec;
  --pw-ink: #2e2a24;
  --pw-muted: #99948b;
  --pw-line: #d8cdb8;
  --pw-accent: #3f6e5a;
  --pw-seal-gold: oklch(0.66 0.105 78);
  --pw-warn: oklch(0.68 0.13 75);
  --pw-warn-bg: oklch(0.92 0.055 88);
  --pw-radius: 10px;
  font-family: "Noto Sans SC", system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  color: var(--pw-ink);
  font-size: 13px;
  line-height: 1.6;
}
/* ---------- 左栏面板 ---------- */
.pwx-panel { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--pw-paper); }
.pwx-tabs { display:flex; gap:4px; padding:10px 12px 8px; border-bottom:1px solid var(--pw-line); background:var(--pw-paper); }
.pwx-tab { flex:1; text-align:center; padding:5px 10px; border-radius:999px; border:1px solid transparent; cursor:pointer; font-size:12.5px; color:var(--pw-muted); background:transparent; }
.pwx-tab.on { background:var(--pw-card); border-color:var(--pw-line); color:var(--pw-ink); font-weight:600; }
.pwx-tab:hover:not(.on) { color:var(--pw-ink); }
.pwx-nav { display:flex; flex-wrap:wrap; gap:4px; padding:8px 12px; border-bottom:1px solid var(--pw-line); }
.pwx-nav button { border:1px solid var(--pw-line); background:var(--pw-card); color:var(--pw-ink); border-radius:999px; padding:3px 10px; font-size:11.5px; cursor:pointer; position:relative; }
.pwx-nav button.on { background:var(--pw-accent); border-color:var(--pw-accent); color:#fff; }
.pwx-body { flex:1; overflow-y:auto; padding:10px 12px 16px; min-height:0; }
.pwx-dot { position:absolute; top:-3px; right:-3px; min-width:14px; height:14px; padding:0 3px; border-radius:999px; background:var(--pw-warn); color:#fff; font-size:9.5px; line-height:14px; text-align:center; font-weight:700; }
/* ---------- 通用卡片/条目 ---------- */
.pwx-card { background:var(--pw-card); border:1px solid var(--pw-line); border-radius:var(--pw-radius); padding:9px 11px; margin-bottom:8px; cursor:pointer; }
.pwx-card:hover { border-color:var(--pw-accent); }
.pwx-card.static { cursor:default; }
.pwx-card.static:hover { border-color:var(--pw-line); }
.pwx-card h4 { margin:0 0 3px; font-size:13px; font-weight:650; line-height:1.45; }
.pwx-meta { color:var(--pw-muted); font-size:11px; display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.pwx-badge { display:inline-block; border:1px solid var(--pw-line); border-radius:999px; padding:0 7px; font-size:10.5px; line-height:17px; color:var(--pw-muted); background:var(--pw-paper); }
.pwx-badge.gold { color:#8a6d1f; border-color:var(--pw-seal-gold); background:oklch(0.95 0.04 88); }
.pwx-badge.tomb { color:#6b6154; }
.pwx-badge.warn { color:#8a6d1f; border-color:var(--pw-warn); background:var(--pw-warn-bg); }
.pwx-badge.green { color:var(--pw-accent); border-color:var(--pw-accent); }
.pwx-blank { color:var(--pw-muted); text-align:center; padding:26px 8px; font-size:12px; }
.pwx-err { color:#b65d56; background:#f7ece9; border:1px solid #e0c4bf; border-radius:8px; padding:8px 10px; font-size:12px; margin-bottom:8px; }
.pwx-sec-title { font-size:10.5px; letter-spacing:.08em; color:var(--pw-muted); text-transform:uppercase; margin:12px 0 6px; font-weight:700; }
.pwx-search { width:100%; box-sizing:border-box; border:1px solid var(--pw-line); background:var(--pw-card); color:var(--pw-ink); border-radius:8px; padding:5px 9px; font-size:12px; margin-bottom:8px; }
.pwx-search:focus { outline:none; border-color:var(--pw-accent); }
.pwx-btn { border:1px solid var(--pw-line); background:var(--pw-card); color:var(--pw-ink); border-radius:8px; padding:4px 10px; font-size:12px; cursor:pointer; }
.pwx-btn:hover { border-color:var(--pw-accent); color:var(--pw-accent); }
.pwx-btn.primary { background:var(--pw-accent); border-color:var(--pw-accent); color:#fff; }
.pwx-btn.primary:hover { opacity:.9; color:#fff; }
.pwx-btn.danger:hover { border-color:#b65d56; color:#b65d56; }
.pwx-btn:disabled { opacity:.45; cursor:not-allowed; }
.pwx-row { display:flex; gap:6px; align-items:center; }
/* ---------- footer 入口按钮 ---------- */
.pwx-entry { position:relative; display:flex; align-items:center; gap:8px; width:100%; border:none; background:transparent; color:inherit; padding:7px 10px; border-radius:8px; cursor:pointer; font-size:13px; text-align:left; }
.pwx-entry:hover { background:rgba(63,110,90,.12); }
.pwx-entry .pwx-dot { position:static; margin-left:auto; }
.pwx-seal { display:inline-flex; width:18px; height:18px; border-radius:5px; background:var(--pw-accent, #3f6e5a); color:#fff; font-size:11px; align-items:center; justify-content:center; font-weight:700; }
/* ---------- 详情浮层 ---------- */
.pwx-ovl { position:fixed; inset:0; z-index:1200; display:flex; align-items:center; justify-content:center; }
.pwx-ovl-mask { position:absolute; inset:0; background:rgba(46,42,36,.32); }
.pwx-ovl-panel { position:relative; width:min(760px, calc(100vw - 48px)); max-height:min(82vh, 900px); display:flex; flex-direction:column; background:var(--pw-paper); border:1px solid var(--pw-line); border-radius:14px; box-shadow:0 2px 6px rgba(46,42,36,.08), 0 18px 44px -12px rgba(46,42,36,.35); overflow:hidden; }
.pwx-ovl-head { display:flex; align-items:center; gap:10px; padding:12px 16px; border-bottom:1px solid var(--pw-line); background:var(--pw-card); }
.pwx-ovl-head h3 { margin:0; font-size:15px; font-weight:700; flex:1; line-height:1.4; }
.pwx-ovl-body { flex:1; overflow-y:auto; padding:14px 16px; }
.pwx-x { border:none; background:transparent; color:var(--pw-muted); font-size:16px; cursor:pointer; padding:2px 6px; border-radius:6px; }
.pwx-x:hover { color:var(--pw-ink); background:var(--pw-paper); }
.pwx-kv { display:grid; grid-template-columns:auto 1fr; gap:3px 12px; font-size:12.5px; margin:8px 0; }
.pwx-kv dt { color:var(--pw-muted); white-space:nowrap; }
.pwx-kv dd { margin:0; }
.pwx-md { background:var(--pw-card); border:1px solid var(--pw-line); border-radius:var(--pw-radius); padding:10px 12px; white-space:pre-wrap; font-size:12.5px; max-height:300px; overflow-y:auto; }
.pwx-quote { border-left:3px solid var(--pw-line); padding:2px 0 2px 10px; margin:6px 0; font-size:12.5px; white-space:pre-wrap; }
.pwx-like { color:var(--pw-muted); font-size:11px; white-space:nowrap; }
@media (max-width: 768px) {
  .pwx-ovl { align-items:stretch; }
  .pwx-ovl-panel { width:100vw; max-height:none; height:100%; border-radius:0; border:none; }
}
`;
