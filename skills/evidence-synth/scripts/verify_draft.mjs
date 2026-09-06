#!/usr/bin/env node
// 用法：node verify_draft.mjs --pack pack.json --draft draft.md [--min-coverage 0.9] [--no-live]
// 当场验真：句句有引用、引号逐字、编号存在、URL 活着。输出 JSON 报告；不通过 exit 1。
import { readFileSync } from "node:fs";
import { arg } from "./_bitable.mjs";

const packPath = arg("pack");
const draftPath = arg("draft");
if (typeof packPath !== "string" || typeof draftPath !== "string") {
  console.error("用法：node verify_draft.mjs --pack pack.json --draft draft.md [--min-coverage 0.9] [--no-live]");
  process.exit(2);
}
const minCoverage = Number(arg("min-coverage", 0.9));
const live = arg("no-live") !== true;

const pack = JSON.parse(readFileSync(packPath, "utf8"));
const draft = readFileSync(draftPath, "utf8");
const known = new Map();
for (const e of pack.evidence ?? []) known.set(e.id, { kind: "E", text: `${e.title}\n${e.quote}`, url: e.url });
for (const n of pack.myNotes ?? []) known.set(n.id, { kind: "N", text: n.text });

const norm = (s) => s.replace(/\s+/gu, " ").trim().toLowerCase();
const CITE = /\[(E|N)\d+\]/gu;

// 句子切分：按 。！？!? 与换行；忽略空行、标题行、脚注表行、标签行
const sentences = draft
  .split(/(?<=[。！？!?])|\n/u)
  .map((s) => s.trim())
  .filter((s) => s && !/^#{1,6}\s/u.test(s) && !/^\[(E|N)\d+\]\s*[:：]/u.test(s) && !/^#\S/u.test(s) && !/^(---|\*\*\*)$/u.test(s));

const report = { total: sentences.length, opinion: 0, structural: 0, cited: 0, uncited: [], unknownRefs: [], misquotes: [], deadUrls: [], usedRefs: [] };
const used = new Set();

// 第一行是标题/钩子：免角标，但引号仍须逐字（由正文承担支撑）
let titleSeen = false;
for (const s of sentences) {
  if (/^我的看法[:：]/u.test(s)) {
    report.opinion += 1;
    continue;
  }
  const refs = [...s.matchAll(CITE)].map((m) => m[0].slice(1, -1));
  // 标题判定：首行、≤25 字、不以句末标点结尾；一个带句号的长句不是标题，照常要角标
  const isTitle = !titleSeen && s.length <= 25 && !/[。！？!?]$/u.test(s);
  titleSeen = true;
  // 结构句：≤12 字且不含数字（分隔、行动号召）；标题也算结构句
  if (!refs.length && (isTitle || (s.length <= 12 && !/\d/u.test(s)))) {
    report.structural += 1;
    const quotes = [...s.matchAll(/[“"「]([^”"」]{4,})[”"」]/gu)].map((m) => m[1]);
    for (const q of quotes) {
      const hit = [...known.values()].some((item) => norm(item.text).includes(norm(q)));
      if (!hit) report.misquotes.push({ sentence: s, quote: q });
    }
    continue;
  }
  if (!refs.length) {
    report.uncited.push(s);
    continue;
  }
  let ok = true;
  for (const ref of refs) {
    if (!known.has(ref)) {
      report.unknownRefs.push({ sentence: s, ref });
      ok = false;
    } else used.add(ref);
  }
  if (ok) report.cited += 1;
  // 引号逐字校验：每段引文必须是所引编号文本的子串
  const quotes = [...s.matchAll(/[“"「]([^”"」]{4,})[”"」]/gu)].map((m) => m[1]);
  for (const q of quotes) {
    const hit = refs.some((ref) => known.has(ref) && norm(known.get(ref).text).includes(norm(q)));
    if (!hit) report.misquotes.push({ sentence: s, quote: q });
  }
}

const factual = report.total - report.opinion - report.structural;
report.coverage = factual ? Number((report.cited / factual).toFixed(3)) : 1;
report.opinionRatioOk = report.opinion <= Math.max(1, factual);
report.usedRefs = [...used].sort();

if (live) {
  for (const ref of used) {
    const item = known.get(ref);
    if (!item?.url) continue;
    try {
      let res = await fetch(item.url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(8000) });
      if (res.status === 405 || res.status === 403) res = await fetch(item.url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(8000) });
      if (res.status >= 400) report.deadUrls.push({ ref, url: item.url, status: res.status });
    } catch (error) {
      report.deadUrls.push({ ref, url: item.url, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

report.pass = report.coverage >= minCoverage
  && report.unknownRefs.length === 0
  && report.misquotes.length === 0
  && report.deadUrls.length === 0
  && report.opinionRatioOk;

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(report.pass ? 0 : 1);
