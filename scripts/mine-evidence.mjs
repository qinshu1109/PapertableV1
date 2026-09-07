import { readFileSync } from "node:fs";
import { defaultRelayConfigPath } from "../src/pw-feishu-relay.ts";
import { loadEvidenceConfig } from "../src/pw-evidence-hook.ts";
import { collectEvidence } from "../src/pw-evidence-collector.ts";
import { writeEvidenceBundle, BitableClient } from "../src/pw-feishu-bitable.ts";

const configPath = defaultRelayConfigPath();
const evConfig = loadEvidenceConfig(configPath);
const relayRaw = JSON.parse(readFileSync(configPath, "utf8"));

const bitableDeps = {
  fetch: globalThis.fetch,
  now: () => new Date(),
  log: (f) => console.log("[bitable]", JSON.stringify(f)),
  appId: relayRaw.appId,
  appSecret: relayRaw.appSecret
};

const bitableClient = new BitableClient(evConfig.bitable, bitableDeps);

const collectorDeps = {
  fetch: globalThis.fetch,
  now: () => new Date(),
  log: (f) => console.log("[collector]", JSON.stringify(f))
};

const targets = [
  { text: "测试 Gemini429 报错切端点才好", memo: "memos/gemini-429" },
  { text: "https://github.com/Jia-Ethan/grok-keysmith grok破限", memo: "memos/grok-keysmith" },
  { text: "飞书 CLI 才是个人工作台的最优解，需要把选题工作台结合到飞书多维表格", memo: "memos/feishu-cli-workbench" }
];

for (const target of targets) {
  console.log(`\n========================================`);
  console.log(`开始搜证: "${target.text}"`);
  console.log(`========================================`);
  try {
    const result = await collectEvidence(target.text, evConfig.collector, collectorDeps);
    console.log(`搜证完成: topicKey=${result.topicKey}, evidenceCount=${result.evidence.length}, skipped=${result.skipped}`);
    
    if (!result.skipped && result.evidence.length > 0) {
      const bundle = {
        topicKey: result.topicKey,
        note: {
          text: result.redactedNote,
          memo: target.memo,
          at: new Date().toISOString(),
          queries: result.queries
        },
        evidence: result.evidence.map((e) => ({
          key: e.key,
          title: e.title,
          url: e.url,
          source: e.source,
          tier: e.tier,
          publishedAt: e.publishedAt,
          quote: e.quote,
          metrics: e.metrics,
          heat: e.heat,
          why: e.why
        }))
      };
      console.log(`正在写入 Bitable...`);
      const writeRes = await writeEvidenceBundle(bitableClient, bundle);
      console.log(`写入完成:`, writeRes);
    }
  } catch (err) {
    console.error(`搜证或写入失败:`, err);
  }
}
console.log("\n=== 核心主题搜证全量完成 ===");
