#!/usr/bin/env node
// 用法：node write_back.mjs --pack pack.json --draft draft.md --platform bilibili-dynamic --title "…" [--model gpt-5.6] [--published-url URL]
// 把成稿写入「产出」表并把主题状态改为 已写（有发布链接则 已发）。引用证据/速记按正文里出现的 E#/N# 自动关联。
import { readFileSync } from "node:fs";
import { arg, createRecord, dateOut, loadConfig, tenantToken, updateRecord } from "./_bitable.mjs";

const packPath = arg("pack");
const draftPath = arg("draft");
const platform = arg("platform");
const title = arg("title");
if ([packPath, draftPath, platform, title].some((v) => typeof v !== "string")) {
  console.error("用法：node write_back.mjs --pack pack.json --draft draft.md --platform <平台> --title <标题> [--model 名] [--published-url URL]");
  process.exit(2);
}
const model = arg("model", "");
const publishedUrl = arg("published-url", "");

const cfg = loadConfig();
if (!cfg.tables.outputs) {
  console.error("evidence.bitable.tables.outputs 未配置：先建「产出」表并把表 ID 填进配置");
  process.exit(3);
}
const pack = JSON.parse(readFileSync(packPath, "utf8"));
const draft = readFileSync(draftPath, "utf8");
const refs = new Set([...draft.matchAll(/\[(E|N)\d+\]/gu)].map((m) => m[0].slice(1, -1)));
const evidenceIds = (pack.evidence ?? []).filter((e) => refs.has(e.id)).map((e) => e.recordId).filter(Boolean);
const noteIds = (pack.myNotes ?? []).filter((n) => refs.has(n.id)).map((n) => n.recordId).filter(Boolean);

const token = await tenantToken(cfg);
const F = cfg.fields.outputs;
const now = Date.now();
const recordId = await createRecord(cfg, token, cfg.tables.outputs, {
  [F.title]: title,
  [F.body]: draft,
  [F.platform]: platform,
  [F.topicKey]: pack.topic?.key,
  [F.evidence]: evidenceIds.length ? evidenceIds : undefined,
  [F.notes]: noteIds.length ? noteIds : undefined,
  [F.model]: typeof model === "string" && model ? model : undefined,
  [F.time]: dateOut(cfg, now),
  [F.url]: typeof publishedUrl === "string" && publishedUrl ? publishedUrl : undefined,
});

if (pack.topic?.recordId) {
  await updateRecord(cfg, token, cfg.tables.topics, pack.topic.recordId, {
    [cfg.fields.topics.status]: typeof publishedUrl === "string" && publishedUrl ? "已发" : "已写",
  });
}

console.log(JSON.stringify({ ok: true, outputRecordId: recordId, linkedEvidence: evidenceIds.length, linkedNotes: noteIds.length, topic: pack.topic?.key, status: publishedUrl ? "已发" : "已写" }));
