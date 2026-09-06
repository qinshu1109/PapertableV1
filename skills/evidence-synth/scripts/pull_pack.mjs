#!/usr/bin/env node
// 用法：node pull_pack.mjs <主题键> [--days 60] [--max-evidence 12] [--out pack.json]
// 从多维表格拉「我的速记 + 外部证据」，编号 N#/E#，输出证据包 JSON（stdout 或 --out）。
// 只读；不调用任何模型；不含密钥。
import { writeFileSync } from "node:fs";
import { arg, dateIn, loadConfig, plain, searchAll, tenantToken } from "./_bitable.mjs";

const topicKey = process.argv[2];
if (!topicKey || topicKey.startsWith("--")) {
  console.error("用法：node pull_pack.mjs <主题键> [--days 60] [--max-evidence 12] [--out pack.json]");
  process.exit(2);
}
const days = Number(arg("days", 60));
const maxEvidence = Number(arg("max-evidence", 12));
const out = arg("out");

const cfg = loadConfig();
const token = await tenantToken(cfg);
const F = cfg.fields;
const sinceMs = Date.now() - days * 86_400_000;

const topics = await searchAll(cfg, token, cfg.tables.topics, F.topics.key, topicKey);
const topic = topics[0];
if (!topic) {
  console.error(`主题不存在：${topicKey}（主题表里没有这条「${F.topics.key}」）`);
  process.exit(3);
}

const noteRows = await searchAll(cfg, token, cfg.tables.notes, F.notes.topicKey, topicKey);
const evidenceRows = await searchAll(cfg, token, cfg.tables.evidence, F.evidence.topicKey, topicKey);

const myNotes = noteRows
  .map((r) => ({ recordId: r.record_id, date: dateIn(plain(r.fields[F.notes.time])), text: String(plain(r.fields[F.notes.text]) ?? "").trim(), memo: plain(r.fields[F.notes.memo]) }))
  .filter((n) => n.text)
  .sort((a, b) => (a.date < b.date ? 1 : -1))
  .map((n, i) => ({ id: `N${i + 1}`, ...n }));

const evidence = evidenceRows
  .map((r) => {
    const f = r.fields;
    let metrics = {};
    try { metrics = JSON.parse(String(plain(f[F.evidence.metrics]) ?? "{}")); } catch { metrics = {}; }
    return {
      recordId: r.record_id,
      title: String(plain(f[F.evidence.title]) ?? "").trim(),
      url: String(plain(f[F.evidence.url]) ?? "").trim(),
      source: String(plain(f[F.evidence.source]) ?? ""),
      tier: String(plain(f[F.evidence.tier]) ?? ""),
      publishedAt: dateIn(plain(f[F.evidence.publishedAt])),
      fetchedAt: dateIn(plain(f[F.evidence.fetchedAt])),
      quote: String(plain(f[F.evidence.quote]) ?? "").trim(),
      heat: Number(plain(f[F.evidence.heat]) ?? 0) || 0,
      why: String(plain(f[F.evidence.why]) ?? "").trim(),
      metrics,
    };
  })
  .filter((e) => e.url)
  .filter((e) => {
    const stamp = e.publishedAt || e.fetchedAt;
    return !stamp || Date.parse(stamp) >= sinceMs || e.tier === "T0";
  })
  .sort((a, b) => b.heat - a.heat)
  .slice(0, maxEvidence)
  .map((e, i) => ({ id: `E${i + 1}`, ...e }));

const pack = {
  topic: { key: topicKey, recordId: topic.record_id, status: plain(topic.fields[F.topics.status]) ?? "" },
  pulledAt: new Date().toISOString(),
  window: { days, since: new Date(sinceMs).toISOString().slice(0, 10) },
  myNotes,
  evidence,
  rules: [
    "每一个事实性句子末尾必须带 [E#] 或 [N#]，编号必须存在于本包。",
    "引号内的文字必须是对应 E# 的 quote/title 或 N# 的 text 的逐字子串；不许改写、翻译、拼接。",
    "包外的任何数字、日期、版本号、人名、产品行为一律不得出现；不确定就不写。",
    "个人判断以「我的看法：」开头，且不得多于事实句数量。",
    "你的工作是叙事编排与观点锋利化，不是补充事实。",
  ],
  stats: { notes: myNotes.length, evidence: evidence.length, tiers: evidence.reduce((m, e) => ({ ...m, [e.tier || "?"]: (m[e.tier || "?"] ?? 0) + 1 }), {}) },
  table: cfg.baseUrl ? `${cfg.baseUrl}/base/${cfg.appToken}?table=${cfg.tables.evidence}` : undefined,
};

const text = JSON.stringify(pack, null, 2);
if (typeof out === "string") {
  writeFileSync(out, `${text}\n`, "utf8");
  console.error(`证据包已写入 ${out}：速记 ${myNotes.length} 条，证据 ${evidence.length} 条`);
} else {
  process.stdout.write(`${text}\n`);
}
