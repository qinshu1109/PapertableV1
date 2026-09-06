#!/usr/bin/env node
/**
 * voice-comment-sieve（TASK-PW-64 修订方向，wayfinder voice-theme-cards/Q01）：
 * AI 做筛子不做摘要——逐条判评论有没有信息量，信号条按轻量标签分组，逐字摆盘成报告。
 * 只读语料库与 papertable.sqlite3；产出只有 Markdown 报告。
 *
 * 用法：node --experimental-strip-types skills/voice-comment-sieve/sieve.mjs <bvid> [--limit N] [--out PATH]
 * （须在仓库根目录跑；node 用官方版：PATH="$HOME/.local/node/bin:$PATH"）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { contentText } from "@earendil-works/pi-ai";
import { createDeepSeekProvider } from "../../src/provider-settings.ts";
import { readPwCorpusComments } from "../../src/pw-corpus.ts";

const DATA_DIR = process.env.PAPERTABLE_DATA_DIR?.trim()
  || join(homedir(), "Library", "Application Support", "Papertable");
// 成本费率与 src/pw-miner.ts 一致（DeepSeek：输入 ¥2/M、输出 ¥8/M）
const BUDGET_CNY = 0.15;
const BATCH_SIZE = 50;
const MAX_OUTPUT_TOKENS = 4_000;

function parseArgs(argv) {
  const args = { bvid: null, limit: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--limit") { args.limit = Number(argv[++i]); continue; }
    if (argv[i] === "--out") { args.out = argv[++i]; continue; }
    if (!args.bvid) { args.bvid = argv[i]; continue; }
    throw new Error(`未知参数：${argv[i]}`);
  }
  if (!args.bvid) throw new Error("用法：sieve.mjs <bvid> [--limit N] [--out PATH]");
  if (args.limit !== null && (!Number.isInteger(args.limit) || args.limit < 1)) throw new Error("--limit 必须是正整数");
  return args;
}

function truncate(value, max) {
  return [...String(value ?? "").trim()].slice(0, max).join("");
}

function estimateTokens(text) {
  return Math.ceil([...text].length / 2);
}

function costCny(inputTokens, outputTokens) {
  return (inputTokens * 2 + outputTokens * 8) / 1_000_000;
}

function parseJsonArray(raw) {
  const match = String(raw).match(/\[[\s\S]*\]/u);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const BUCKETS = new Set(["对比", "价格", "bug反馈", "功能", "求助", "场景", "建议", "评价"]);

async function callLlm(provider, prompt, systemPrompt) {
  const response = await provider.models.completeSimple(provider.model, {
    systemPrompt,
    messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
  }, { maxTokens: MAX_OUTPUT_TOKENS, timeoutMs: 90_000, maxRetries: 0, maxRetryDelayMs: 0 });
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(`DeepSeek 调用失败：${response.errorMessage || response.stopReason}`);
  }
  return {
    text: contentText(response.content, ""),
    inputTokens: Number(response.usage?.input ?? 0),
    outputTokens: Number(response.usage?.output ?? 0),
  };
}

const SIEVE_SYSTEM = [
  "你是镇纸评论筛子。逐条判断评论有没有信息量：只删减，不概括、不评价、不替人决定。",
  "只输出 JSON 数组，每条 {\"rpid\":数字,\"keep\":true|false,\"tag\":\"桶名\"}。",
  "判噪音（keep=false，不给 tag）：广告引流、玩梗无信息、纯表情/复读、与视频内容无关的灌水。",
  "判有信息（keep=true，tag 必填八桶之一）：对比（工具/模型/方案比较）/价格（计费额度订阅）/bug反馈/功能（评价建议咨询）/求助（使用求助、选型提问、网络兼容性）/场景（使用现状陈述）/建议（对 UP 主的评测与内容建议、评测质疑）/评价（确有所指的夸赞或吐槽）。",
  "拿不准的进「评价」桶，不许发明新桶。赞数不参与判断，只看内容。每条独立判断，不互相参照。",
].join("\n");

const MERGE_SYSTEM = [
  "你是标签归并员。输入是若干标签及条数，把同义标签归并到最短的那个名。",
  "只输出 JSON 对象 {\"原标签\":\"归并后标签\"}；不同义的标签不要出现在输出里。",
].join("\n");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = new DatabaseSync(join(DATA_DIR, "papertable.sqlite3"), { readOnly: true });
  const doc = db.prepare("SELECT bvid, title, up_name, comment_count FROM pw_corpus_docs WHERE bvid=? AND status='done'")
    .get(args.bvid);
  if (!doc) throw new Error(`语料库没有抓完的视频：${args.bvid}`);
  let comments = readPwCorpusComments(db, args.bvid)
    .filter((row) => row.rpid !== null)
    .sort((a, b) => (b.like ?? 0) - (a.like ?? 0) || (b.ctime ?? 0) - (a.ctime ?? 0));
  if (args.limit) comments = comments.slice(0, args.limit);
  if (comments.length === 0) throw new Error("没有可读评论");

  const provider = createDeepSeekProvider(DATA_DIR);
  let spent = 0;
  const verdicts = new Map(); // rpid -> { keep, tag }
  for (let start = 0; start < comments.length; start += BATCH_SIZE) {
    const batch = comments.slice(start, start + BATCH_SIZE);
    const prompt = batch.map((row) => `[${row.rpid}] ${truncate(row.message, 500)} | 赞 ${row.like ?? 0} | ${row.uname ?? "匿名"}`).join("\n");
    const result = await callLlm(provider, prompt, SIEVE_SYSTEM);
    spent += costCny(result.inputTokens, result.outputTokens);
    if (spent > BUDGET_CNY) throw new Error(`成本超预算：¥${spent.toFixed(4)} > ¥${BUDGET_CNY}`);
    for (const item of parseJsonArray(result.text)) {
      if (!item || typeof item !== "object") continue;
      const rpid = Number(item.rpid);
      if (!Number.isInteger(rpid) || !batch.some((row) => row.rpid === rpid)) continue;
      const keep = item.keep === true;
      const rawTag = keep && typeof item.tag === "string" ? item.tag.trim() : "";
      const tag = keep ? (BUCKETS.has(rawTag) ? rawTag : "评价") : null; // 桶外标签一律归「评价」，不发明新桶
      verdicts.set(rpid, { keep, tag });
    }
  }
  // 没拿到判决的按噪音处理（宁缺毋滥，报告里可见）
  let missingCount = 0;
  for (const row of comments) {
    if (!verdicts.has(row.rpid)) {
      missingCount += 1;
      verdicts.set(row.rpid, { keep: false, tag: null });
    }
  }

  const kept = comments.filter((row) => verdicts.get(row.rpid).keep);
  const noise = comments.filter((row) => !verdicts.get(row.rpid).keep);

  // 标签同义归并（独立小调用，输入只有标签名）
  const tagCounts = new Map();
  for (const row of kept) {
    const tag = verdicts.get(row.rpid).tag ?? "未标注";
    tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }
  if (tagCounts.size > 8) {
    const prompt = [...tagCounts.entries()].map(([tag, count]) => `${tag}（${count} 条）`).join("\n");
    const result = await callLlm(provider, prompt, MERGE_SYSTEM);
    spent += costCny(result.inputTokens, result.outputTokens);
    if (spent > BUDGET_CNY) throw new Error(`成本超预算：¥${spent.toFixed(4)} > ¥${BUDGET_CNY}`);
    const mappingRaw = parseJsonObject(result.text);
    for (const row of kept) {
      const tag = verdicts.get(row.rpid).tag ?? "未标注";
      const merged = typeof mappingRaw[tag] === "string" && mappingRaw[tag].trim() ? truncate(mappingRaw[tag], 12) : tag;
      verdicts.set(row.rpid, { keep: true, tag: merged });
    }
  }

  const groups = new Map(); // tag -> items[]
  for (const row of kept) {
    const tag = verdicts.get(row.rpid).tag ?? "未标注";
    if (!groups.has(tag)) groups.set(tag, []);
    groups.get(tag).push(row);
  }
  const sortedGroups = [...groups.entries()]
    .map(([tag, rows]) => ({ tag, rows, likes: rows.reduce((acc, row) => acc + (row.like ?? 0), 0) }))
    .sort((a, b) => b.likes - a.likes || b.rows.length - a.rows.length);

  const fmtTime = (ctime) => {
    if (ctime == null) return "";
    const d = new Date(ctime * 1000);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };
  const lines = [
    `# 语料评论筛子报告：${doc.title ?? doc.bvid}`,
    "",
    `- 视频：${doc.bvid} · UP主：${doc.up_name ?? "未知"} · 语料评论 ${doc.comment_count ?? "?"} 条`,
    `- 本次筛 ${comments.length} 条 → 信号 ${kept.length} 条（${sortedGroups.length} 组）/ 噪音 ${noise.length} 条`,
    `- 对账：判出 ${comments.length - missingCount}/${comments.length} 条，无判决按噪音 ${missingCount} 条`,
    `- 成本 ¥${spent.toFixed(4)}（DeepSeek，逐条判断 ${Math.ceil(comments.length / BATCH_SIZE)} 批）`,
    `- 生成：${new Date().toISOString()} · voice-comment-sieve（AI 只筛不摘要，原文逐字未改）`,
    "",
    `## 信号评论（${kept.length} 条）`,
    "",
  ];
  for (const group of sortedGroups) {
    lines.push(`### ${group.tag}（${group.rows.length} 条 · 赞计 ${group.likes}）`, "");
    for (const row of group.rows) {
      lines.push(`- 「${row.message}」 — @${row.uname ?? "匿名"} · ${row.like ?? 0} 赞 · ${fmtTime(row.ctime)} · rpid:${row.rpid}`);
    }
    lines.push("");
  }
  lines.push(`## 噪音区（${noise.length} 条，翻案用）`, "");
  for (const row of noise) {
    lines.push(`- [${row.rpid}] ${truncate(row.message, 40)} — @${row.uname ?? "匿名"} · ${row.like ?? 0} 赞`);
  }
  lines.push("");

  const stamp = new Date().toISOString().slice(0, 10);
  const out = args.out ?? join("agent-bridge", "out", `voice-sieve-${args.bvid}-${stamp}.md`);
  writeFileSync(out, lines.join("\n"), "utf8");
  console.log(JSON.stringify({
    report: out, bvid: args.bvid, total: comments.length,
    kept: kept.length, noise: noise.length, groups: sortedGroups.length,
    costCny: Number(spent.toFixed(6)),
  }));
}

function parseJsonObject(raw) {
  const match = String(raw).match(/\{[\s\S]*\}/u);
  if (!match) return {};
  try {
    const parsed = JSON.parse(match[0]);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

await main();
