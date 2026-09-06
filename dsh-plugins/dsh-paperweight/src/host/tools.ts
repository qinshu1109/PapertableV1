/**
 * agent 工具面（host 半）。
 *
 * 铁律：8 只读 + 唯一起草 pw_draft_bet；任何 settle/confirm/verdict 写 schema 都不注册。
 * 所有工具返回 JSON 文本；渲染统一 text block。
 */
import type { PwDraftBetInput, PwHostDeps } from "../types.js";
import {
  createDraft,
  fetchBet,
  fetchBetContext,
  fetchBetDataDocs,
  fetchBetPrecedents,
  fetchBets,
  fetchConnections,
  fetchNotesRecall,
  fetchNotesTree,
  fetchServerStatus,
  fetchVerdictEvidence,
  fetchVerdicts,
} from "./pw-client.js";
import { collectVoiceThemeDetail, collectVoiceThemes } from "./voice.js";

type ToolDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render: (args: unknown, value: unknown) => Array<{ type: "text"; text: string }>;
  };
  execute: (args: any) => Promise<unknown>;
};

function tool(def: ToolDef): ToolDef {
  return def;
}

function textRender(_args: unknown, value: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }];
}

/** 所有镇纸工具都返回 JSON 对象；允许各只读端点保留自己的嵌套字段。 */
const objectOutputSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: true,
};

const stringParam = (description: string): Record<string, unknown> => ({
  type: "string",
  description,
});

const stringSchema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
});

export function registerTools(ctx: any, deps: PwHostDeps): void {
  const baseUrl = deps.baseUrl || "http://127.0.0.1:4317";

  const definitions: ToolDef[] = [
    tool({
      name: "pw_list_bets",
      description: "列出镇纸押注（只读）。status 可选 pending|settled|void|all；缺省全部非草稿。",
      parameters: stringSchema({
        status: stringParam("押注状态过滤：pending/settled/void/all"),
      }),
      output: { schema: objectOutputSchema, render: textRender },
      async execute(args: { status?: string }) {
        const bets = await fetchBets(baseUrl, args.status);
        return { bets };
      },
    }),
    tool({
      name: "pw_read_bet",
      description: "读单张押注卡：赌注/置信度/距结账天数/最新回流数据文档/相关判例（只读）。",
      parameters: stringSchema({ betId: stringParam("押注 id") }, ["betId"]),
      output: { schema: objectOutputSchema, render: textRender },
      async execute(args: { betId: string }) {
        const [bet, dataDocs, precedents, contextMarkdown] = await Promise.all([
          fetchBet(baseUrl, args.betId),
          fetchBetDataDocs(baseUrl, args.betId),
          fetchBetPrecedents(baseUrl, args.betId),
          fetchBetContext(baseUrl, args.betId),
        ]);
        return { bet: { ...bet, dataDocs, precedents, contextMarkdown } };
      },
    }),
    tool({
      name: "pw_read_data_docs",
      description: "读某押注的最新回流数据文档（只读，版本摘要含平台/采集时间/metrics/冻结态）。",
      parameters: stringSchema({ betId: stringParam("押注 id") }, ["betId"]),
      output: { schema: objectOutputSchema, render: textRender },
      async execute(args: { betId: string }) {
        const docs = await fetchBetDataDocs(baseUrl, args.betId);
        return { betId: args.betId, docs };
      },
    }),
    tool({
      name: "pw_search_verdicts",
      description: "按关键词搜金子/墓碑判决（只读）。返回判决 id/结果/教训/死因/证据 id。",
      parameters: stringSchema({ q: stringParam("搜索关键词") }, ["q"]),
      output: { schema: objectOutputSchema, render: textRender },
      async execute(args: { q: string }) {
        const verdicts = await fetchVerdicts(baseUrl, { q: args.q });
        return { verdicts };
      },
    }),
    tool({
      name: "pw_read_verdict_evidence",
      description: "读某判决及其证据链（只读）。证据文档按原顺序排列，可点回镇纸复核。",
      parameters: stringSchema({ verdictId: stringParam("判决 id") }, ["verdictId"]),
      output: { schema: objectOutputSchema, render: textRender },
      async execute(args: { verdictId: string }) {
        return fetchVerdictEvidence(baseUrl, args.verdictId);
      },
    }),
    tool({
      name: "pw_query_voice",
      description: "查观众声音（只读）。给 theme 返回该主题逐字原文；给 bvid 返回该视频主题卡；都不给返回全部主题。",
      parameters: stringSchema({
        theme: stringParam("主题卡 id（可空）"),
        bvid: stringParam("视频 BV 号（可空）"),
      }),
      output: { schema: objectOutputSchema, render: textRender },
      async execute(args: { theme?: string; bvid?: string }) {
        if (args.theme) {
          const detail = await collectVoiceThemeDetail(baseUrl, args.theme);
          if (!detail) throw new Error(`主题不存在：${args.theme}`);
          return detail;
        }
        const themes = await collectVoiceThemes(baseUrl);
        if (args.bvid) return { themes: themes.filter((theme) => theme.bvid === args.bvid) };
        return { themes };
      },
    }),
    tool({
      name: "pw_recall_notes",
      description: "按押注回捞相关旧笔记（Memos 只读，命中词+回链）。",
      parameters: stringSchema({ betId: stringParam("押注 id") }, ["betId"]),
      output: { schema: objectOutputSchema, render: textRender },
      async execute(args: { betId: string }) {
        const recall = await fetchNotesRecall(baseUrl, args.betId);
        return recall;
      },
    }),
    tool({
      name: "pw_ops_status",
      description: "读镇纸运维与数据源状态（只读）：服务健康、连接状态、押注/判决/数据文档/草稿/候选卡计数。",
      parameters: stringSchema({}),
      output: { schema: objectOutputSchema, render: textRender },
      async execute() {
        const [server, connections, bets, verdicts, notesTree] = await Promise.all([
          fetchServerStatus(baseUrl),
          fetchConnections(baseUrl),
          fetchBets(baseUrl),
          fetchVerdicts(baseUrl),
          fetchNotesTree(baseUrl).catch(() => null),
        ]);
        return {
          server,
          connections,
          counts: {
            bets: bets.length,
            pendingBets: bets.filter((bet) => bet.status === "pending").length,
            verdicts: verdicts.length,
          },
          notesTreeAvailable: notesTree !== null,
        };
      },
    }),
    tool({
      name: "pw_draft_bet",
      description: "起草一张押注（唯一写工具）：落 draft 区，不进入正式区；返回 draft_hash 供人确认时勾稽。",
      parameters: stringSchema({
        title: stringParam("标题"),
        thesis: stringParam("押注假设"),
        metric: stringParam("验证指标"),
        metricTarget: stringParam("指标目标"),
        confidence: { type: "integer", description: "置信度 0-100", minimum: 0, maximum: 100 },
        dataSourcePlan: stringParam("数据来源计划"),
        checkoutDate: stringParam("结账日 YYYY-MM-DD"),
        kind: { type: "string", enum: ["verdict", "content"], description: "户口：verdict（默认）| content" },
        sourceCardId: stringParam("content 押注来源候选卡 id"),
      }, ["title", "thesis"]),
      output: { schema: objectOutputSchema, render: textRender },
      async execute(args: PwDraftBetInput) {
        const result = await createDraft(baseUrl, args);
        return result;
      },
    }),
  ];

  for (const definition of definitions) {
    ctx.effect(() => ctx.tools.register(definition), `dsh-paperweight: tool ${definition.name}`);
  }
}
