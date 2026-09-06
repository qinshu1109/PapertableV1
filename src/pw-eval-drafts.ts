/**
 * TASK-PW-32：起草器 bad case 回流脚本（npm run eval:drafts）。
 *
 * 读 pw_content_drafts 的 rejected 集（listPwDraftBadCases），对其押注逐条复用
 * buildDraftEvidence + buildDraftPrompt +（真实模型或 --mock）+ parseDraftJson +
 * postProcessDrafts，只打印不落库，输出 bad case 原文与新产出的并排 JSON。
 * prompt/模型改动前后各跑一次人工对比（沿 PW-29 评测纪律：prompt 版本 hash 打在头上）。
 *
 * 纪律：本脚本打开真实库但只用只读查询（复用既有读通路），不建表、不写任何业务数据；
 * 只有押注仍在途（kind=content、status=pending）的 bad case 可回流，否则跳过并注明原因。
 */
import { createHash } from "node:crypto";
import { contentText } from "@earendil-works/pi-ai";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { listPwDraftBadCases } from "./pw-content-drafts.ts";
import {
  buildDraftEvidence,
  buildDraftPrompt,
  DRAFT_SYSTEM_PROMPT,
  parseDraftJson,
  postProcessDrafts,
  type DraftLlm,
  type ParsedDraft,
} from "./pw-draft-pipeline.ts";
import { createPapertableProvider, loadProviderSettings } from "./provider-settings.ts";

const realDataDir = process.env.PAPERTABLE_DATA_DIR?.trim()
  || join(homedir(), "Library", "Application Support", "Papertable");
const useMock = process.argv.includes("--mock");

const promptHash = createHash("sha256").update(DRAFT_SYSTEM_PROMPT).digest("hex").slice(0, 8);

/** skeleton_json 容错解析：损坏原样保留（只用于打印，不影响判分）。 */
function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

async function main(): Promise<void> {
  let llm: DraftLlm | null = null;
  let modelLabel = "mock（--mock：不调模型）";
  if (!useMock) {
    try {
      // provider 配置来源与后端同一份：provider.json → loadProviderSettings → PAPERTABLE_* 环境变量
      loadProviderSettings(realDataDir);
      const provider = createPapertableProvider();
      modelLabel = provider.model.id;
      llm = async (inputText) => {
        const response = await provider.models.completeSimple(provider.model, {
          systemPrompt: DRAFT_SYSTEM_PROMPT,
          messages: [{ role: "user", content: inputText, timestamp: Date.now() }],
        }, {
          maxTokens: 6000,
          timeoutMs: 90_000,
          maxRetries: 0,
          maxRetryDelayMs: 0,
        });
        if (response.stopReason === "error" || response.stopReason === "aborted") {
          throw new Error(response.errorMessage || `起草器调用失败：${response.stopReason}`);
        }
        return contentText(response.content, "");
      };
    } catch (error) {
      console.error("模型未配置：评测需要与后端同一份云端模型配置。"
        + `读取目录：${realDataDir}。\n${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }

  const db = new DatabaseSync(join(realDataDir, "papertable.sqlite3"));
  try {
    const badCases = listPwDraftBadCases(db);
    console.log(`# 起草器 bad case 回流 ${new Date().toISOString()} ｜ 模型：${modelLabel} ｜ prompt 版本：${promptHash}`);
    if (badCases.length === 0) {
      console.log("\nbad case 集为空：无可回流样本。");
      return;
    }

    const byBet = new Map<string, typeof badCases>();
    for (const bad of badCases) {
      const list = byBet.get(bad.bet_id) ?? [];
      list.push(bad);
      byBet.set(bad.bet_id, list);
    }
    console.log(`bad case 集：${badCases.length} 条，涉及押注 ${byBet.size} 个。\n`);

    let rerunCount = 0;
    let skippedCount = 0;
    for (const [betId, cases] of byBet) {
      let evidence;
      try {
        evidence = buildDraftEvidence(db, betId);
      } catch (error) {
        skippedCount += 1;
        console.log(JSON.stringify({
          betId,
          skipped: true,
          note: error instanceof Error ? error.message : String(error),
          badCases: cases.map((bad) => ({
            route: bad.route,
            title_candidate: bad.title_candidate,
            skeleton: safeParse(bad.skeleton_json),
            reject_reason: bad.reject_reason,
          })),
        }, null, 2));
        continue;
      }
      rerunCount += 1;

      const prompt = buildDraftPrompt(evidence);
      let parsed: ParsedDraft[] = [];
      let error: string | null = null;
      if (llm) {
        try {
          parsed = parseDraftJson(await llm(prompt));
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
        }
      }
      const { kept, dropped } = postProcessDrafts(parsed, evidence.refTable);

      console.log(JSON.stringify({
        betId,
        betTitle: cases[0].bet_title,
        promptChars: prompt.length,
        badCases: cases.map((bad) => ({
          route: bad.route,
          title_candidate: bad.title_candidate,
          skeleton: safeParse(bad.skeleton_json),
          reject_reason: bad.reject_reason,
        })),
        rerun: error
          ? { error }
          : { kept, dropped },
      }, null, 2));
    }
    console.log(`\n回流完成：bad case ${badCases.length} 条 / 押注 ${byBet.size} 个，可回流 ${rerunCount}，跳过 ${skippedCount}（押注不在途）`);
  } finally {
    db.close();
  }
}

await main();
