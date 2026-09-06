import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { openDataStore, requireCard, jsonObject } from "./data.ts";
import { createProject, purgeCards, renameCard, renameProject } from "./projects.ts";
import {
  bindLibrary,
  freezeProjectScope,
  readNotes,
  reindexLibrary,
  searchNotes,
} from "./notes.ts";
import {
  AnswerSentenceGate,
  ANSWER_SENTINEL,
  CONCEPTS_SENTINEL,
  gateAnswer,
  sanitizeAssistantMessage,
} from "./gate.ts";
import { PapertableEngine, buildBranchContext, conceptTermsFromBlock } from "./engine.ts";
import { stageIdentity } from "./memos.ts";
import { ensureVerdictTables } from "./verdicts.ts";
import {
  createPapertableProvider,
  loadProviderSettings,
  providerSettingsPath,
  saveProviderSettings,
} from "./provider-settings.ts";
import {
  activeConversation,
  closeSession,
  createSessionRepo,
  openSessionById,
  sessionCwd,
  withSanitizedStorage,
} from "./sessions.ts";
import {
  reduceThinkingActivity,
  reduceToolActivity,
} from "../frontend/src/lib/run-activity.ts";
import { layoutGraph } from "../frontend/src/lib/graph.ts";
import { bindRunsToTurns } from "../frontend/src/lib/bind-runs.ts";
import { normalizeModelMarkdown } from "../frontend/src/lib/normalize.ts";
import { bindAnswerEntries } from "./answer-binding.ts";
import type { Card, CardEdge } from "../frontend/src/types.ts";

const directory = await mkdtemp(join(tmpdir(), "papertable-selfcheck-"));
try {
  const dataDir = join(directory, "data");
  const libraryDir = join(directory, "library");
  await mkdir(libraryDir);
  await writeFile(join(libraryDir, "alpha.md"), "AlphaOnly proves that searched evidence may be read.");
  await writeFile(join(libraryDir, "hidden.txt"), "HiddenBetaOnly must never be readable before search.");

  const legacyDir = join(directory, "legacy");
  await mkdir(legacyDir);
  const legacyDb = new DatabaseSync(join(legacyDir, "papertable.sqlite3"));
  legacyDb.exec(`
    CREATE TABLE pt_schema(version INTEGER NOT NULL);
    INSERT INTO pt_schema(version) VALUES(1);
    CREATE TABLE pt_projects(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE pt_cards(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES pt_projects(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      branch_kind TEXT NOT NULL CHECK(branch_kind IN ('root', 'deep_dive', 'diverge', 'reroute')),
      source_card_id TEXT REFERENCES pt_cards(id) ON DELETE SET NULL,
      branch_context_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE pt_edges(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES pt_projects(id) ON DELETE CASCADE,
      source_card_id TEXT NOT NULL REFERENCES pt_cards(id) ON DELETE CASCADE,
      target_card_id TEXT NOT NULL REFERENCES pt_cards(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('deep_dive', 'diverge', 'reroute')),
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  legacyDb.close();
  const migrated = openDataStore(legacyDir);
  assert.equal(
    (migrated.db.prepare("SELECT version FROM pt_schema").get() as { version: number }).version,
    5,
    "旧数据库必须无损升级到 v5（v2 关系表重建 + v3 按需概念 + v4 trashed_at + v5 学习闭环三新表）",
  );
  migrated.db.prepare(
    "INSERT INTO pt_projects(id, name, created_at, updated_at) VALUES('p', 'p', 'n', 'n')",
  ).run();
  migrated.db.prepare(`
    INSERT INTO pt_cards(
      id, project_id, session_id, title, branch_kind, source_card_id,
      branch_context_json, created_at, updated_at
    ) VALUES('root', 'p', 's1', 'root', 'root', NULL, NULL, 'n', 'n')
  `).run();
  migrated.db.prepare(`
    INSERT INTO pt_cards(
      id, project_id, session_id, title, branch_kind, source_card_id,
      branch_context_json, created_at, updated_at
    ) VALUES('concept', 'p', 's2', 'concept', 'concept', 'root', '{}', 'n', 'n')
  `).run();
  migrated.db.prepare(`
    INSERT INTO pt_edges(
      id, project_id, source_card_id, target_card_id, kind, snapshot_json, created_at
    ) VALUES('edge', 'p', 'root', 'concept', 'concept', '{}', 'n')
  `).run();
  migrated.db.close();

  const store = openDataStore(dataDir);
  const toolActivity = [
    { id: 1, event: "tool_start", tool: "search_notes", toolCallId: "tool-1", queryLength: 6 },
    { id: 2, event: "tool_update", tool: "search_notes", toolCallId: "tool-1", hitCount: 8 },
    { id: 3, event: "tool_end", tool: "search_notes", toolCallId: "tool-1", hitCount: 8, isError: false },
  ].reduce(reduceToolActivity, []);
  assert.deepEqual(
    toolActivity,
    [{
      id: "tool-1",
      tool: "search_notes",
      status: "done",
      queryLength: 6,
      hitCount: 8,
    }],
    "工具进度必须按 toolCallId 合并为一条实时记录",
  );
  const thinkingActivity = [
    { id: 4, event: "thinking_start" },
    { id: 5, event: "thinking_end", content: "先检索，再回答。" },
  ].reduce(reduceThinkingActivity, []);
  assert.deepEqual(
    thinkingActivity,
    [{ id: "thinking-4", status: "done", content: "先检索，再回答。" }],
    "思考事件必须合并为一段可回看的内容",
  );
  const graphCards = ["root", "deep", "reroute", "diverge", "concept"].map((id, index) => ({
    id,
    trashed: false,
    createdAt: index,
  })) as Card[];
  const graphEdges = [
    { id: "e1", type: "child", sourceCardId: "root", targetCardId: "deep" },
    { id: "e2", type: "branch", sourceCardId: "deep", targetCardId: "reroute" },
    { id: "e3", type: "divergent", sourceCardId: "reroute", targetCardId: "diverge" },
    { id: "e4", type: "concept", sourceCardId: "deep", targetCardId: "concept" },
  ] as CardEdge[];
  const graphNodes = layoutGraph(graphCards, graphEdges, new Set()).nodes;
  assert.ok(graphNodes.get("deep")!.y < graphNodes.get("root")!.y, "深挖必须向上进入上一层");
  assert.ok(graphNodes.get("reroute")!.x < graphNodes.get("deep")!.x, "改道必须向左分岔");
  assert.ok(graphNodes.get("diverge")!.x > graphNodes.get("reroute")!.x, "发散必须向右展开");
  assert.ok(graphNodes.get("concept")!.y < graphNodes.get("deep")!.y, "概念展开必须成为正式上一层卡片");
  const originalProviderEnv = {
    protocol: process.env.PAPERTABLE_PROTOCOL,
    baseUrl: process.env.PAPERTABLE_BASE_URL,
    apiKey: process.env.PAPERTABLE_API_KEY,
    model: process.env.PAPERTABLE_MODEL,
  };
  try {
    await writeFile(providerSettingsPath(dataDir), JSON.stringify({
      protocol: "anthropic-messages",
      baseUrl: "https://example.test/v1/",
      apiKey: "selfcheck-secret",
      model: "claude-selfcheck",
      updatedAt: new Date().toISOString(),
    }), { mode: 0o600 });
    const publicSettings = loadProviderSettings(dataDir);
    assert.equal(publicSettings.activeProviderId, "claude");
    assert.equal(publicSettings.baseUrl, "https://example.test/v1");
    assert.equal(publicSettings.model, "claude-selfcheck");
    assert.equal(publicSettings.hasApiKey, true);
    assert.deepEqual(
      publicSettings.providers.map(({ id, baseUrl, model, hasApiKey }) => ({ id, baseUrl, model, hasApiKey })),
      [
        {
          id: "claude",
          baseUrl: "https://example.test/v1",
          model: "claude-selfcheck",
          hasApiKey: true,
        },
        {
          id: "deepseek",
          baseUrl: "https://api.deepseek.com/anthropic",
          model: "deepseek-v4-flash",
          hasApiKey: false,
        },
        {
          id: "opencode-go",
          baseUrl: "https://opencode.ai/zen/go/v1",
          model: "deepseek-v4-flash",
          hasApiKey: false,
        },
      ],
      "旧 Claude 配置必须迁移为三供应商且保留原密钥",
    );
    assert.equal("apiKey" in publicSettings, false, "设置接口绝不能回传密钥");
    assert.ok(publicSettings.providers.every((provider) => !("apiKey" in provider)));
    const migrated = JSON.parse(await readFile(providerSettingsPath(dataDir), "utf8")) as {
      version: number;
      providers: {
        claude: { apiKey: string };
        deepseek: { apiKey: string };
        "opencode-go": { apiKey: string };
      };
    };
    assert.equal(migrated.version, 2);
    assert.equal(migrated.providers.claude.apiKey, "selfcheck-secret");
    assert.equal(migrated.providers.deepseek.apiKey, "");
    assert.equal(migrated.providers["opencode-go"].apiKey, "");
    assert.equal(
      (await stat(providerSettingsPath(dataDir))).mode & 0o777,
      0o600,
      "模型配置文件权限必须是 0600",
    );
    delete process.env.PAPERTABLE_PROTOCOL;
    delete process.env.PAPERTABLE_BASE_URL;
    delete process.env.PAPERTABLE_API_KEY;
    delete process.env.PAPERTABLE_MODEL;
    assert.equal(loadProviderSettings(dataDir).model, "claude-selfcheck");
    assert.equal(process.env.PAPERTABLE_API_KEY, "selfcheck-secret");
    assert.equal(process.env.PAPERTABLE_PROTOCOL, "anthropic-messages");
    assert.throws(
      () => saveProviderSettings(dataDir, {
        providerId: "deepseek",
        protocol: "anthropic-messages",
        baseUrl: "https://api.deepseek.com/anthropic",
        model: "deepseek-v4-flash",
      }),
      /密钥不能为空/,
      "未填写 DeepSeek 密钥时不能切换",
    );
    const deepseek = saveProviderSettings(dataDir, {
      providerId: "deepseek",
      protocol: "anthropic-messages",
      baseUrl: "https://api.deepseek.com/anthropic",
      apiKey: "deepseek-selfcheck-secret",
      model: "deepseek-v4-flash",
    });
    assert.equal(deepseek.activeProviderId, "deepseek");
    assert.equal(process.env.PAPERTABLE_MODEL, "deepseek-v4-flash");
    const deepseekProvider = createPapertableProvider();
    assert.equal(deepseekProvider.model.reasoning, true);
    assert.equal(deepseekProvider.thinkingLevel, "high", "DeepSeek 必须保留 thinking");
    assert.equal(deepseekProvider.supportsToolChoice, false, "thinking 模式不得发送 tool_choice");
    const openCode = saveProviderSettings(dataDir, {
      providerId: "opencode-go",
      protocol: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiKey: "opencode-selfcheck-secret",
      model: "deepseek-v4-flash",
    });
    assert.equal(openCode.activeProviderId, "opencode-go");
    assert.equal(process.env.PAPERTABLE_PROTOCOL, "openai-completions");
    const openCodeProvider = createPapertableProvider();
    assert.equal(openCodeProvider.model.api, "openai-completions");
    assert.equal(openCodeProvider.model.baseUrl, "https://opencode.ai/zen/go/v1");
    assert.equal(openCodeProvider.thinkingLevel, "off", "OpenCode Flash 默认关闭额外推理");
    assert.equal(openCodeProvider.supportsToolChoice, true, "OpenCode Flash 必须支持强制首轮检索");
    const switchedBack = saveProviderSettings(dataDir, {
      providerId: "claude",
      protocol: "anthropic-messages",
      baseUrl: "https://example.test/v1",
      model: "claude-selfcheck",
    });
    assert.equal(switchedBack.activeProviderId, "claude");
    assert.equal(process.env.PAPERTABLE_API_KEY, "selfcheck-secret");
    assert.equal(switchedBack.providers.find((provider) => provider.id === "deepseek")?.hasApiKey, true);
    assert.equal(switchedBack.providers.find((provider) => provider.id === "opencode-go")?.hasApiKey, true);
    assert.throws(
      () => saveProviderSettings(dataDir, {
        providerId: "claude",
        protocol: "openai-completions",
        baseUrl: "https://example.test",
        apiKey: "wrong-protocol",
        model: "wrong-model",
      }),
      /Claude 只支持 Anthropic Messages/,
      "供应商必须拒绝不匹配的协议",
    );
  } finally {
    restoreEnv("PAPERTABLE_PROTOCOL", originalProviderEnv.protocol);
    restoreEnv("PAPERTABLE_BASE_URL", originalProviderEnv.baseUrl);
    restoreEnv("PAPERTABLE_API_KEY", originalProviderEnv.apiKey);
    restoreEnv("PAPERTABLE_MODEL", originalProviderEnv.model);
  }
  const project = createProject(store, "selfcheck") as { id: string };
  renameProject(store, project.id, "  自定义   项目名  ");
  assert.equal(
    (store.db.prepare("SELECT name FROM pt_projects WHERE id = ?").get(project.id) as { name: string }).name,
    "自定义 项目名",
    "项目改名必须持久化并收拢多余空格",
  );
  const renameCardId = "selfcheck-rename-card";
  const renameNow = new Date().toISOString();
  store.db.prepare(`
    INSERT INTO pt_cards(
      id, project_id, session_id, title, branch_kind, source_card_id,
      branch_context_json, created_at, updated_at
    ) VALUES(?, ?, ?, '旧卡片名', 'root', NULL, NULL, ?, ?)
  `).run(renameCardId, project.id, "selfcheck-rename-session", renameNow, renameNow);
  renameCard(store, renameCardId, "  自定义   卡片名  ");
  assert.equal(
    (store.db.prepare("SELECT title FROM pt_cards WHERE id = ?").get(renameCardId) as { title: string }).title,
    "自定义 卡片名",
    "卡片改名必须持久化并收拢多余空格",
  );
  store.db.prepare("DELETE FROM pt_cards WHERE id = ?").run(renameCardId);
  await bindLibrary(store, project.id, libraryDir);
  await reindexLibrary(store, project.id);
  const secondProject = createProject(store, "same-library") as { id: string };
  assert.equal(
    (store.db.prepare(
      "SELECT root_path FROM pt_project_libraries WHERE project_id = ?",
    ).get(secondProject.id) as { root_path: string }).root_path,
    libraryDir,
    "新项目必须自动继承最近一次成功索引的长期资料库",
  );
  assert.equal(
    Number((store.db.prepare(`
      SELECT COUNT(DISTINCT project_id) AS count FROM pt_chunks
      WHERE text LIKE '%AlphaOnly%'
    `).get() as { count: number }).count),
    2,
    "多个项目必须能绑定同一资料库而不发生 chunk ID 冲突",
  );
  const context = freezeProjectScope(store.db, project.id);

  const found = await searchNotes.execute(
    "check-search",
    { query: "AlphaOnly" },
    undefined,
    undefined,
    context,
  );
  const allowedId = (found.details as { readableIds: string[] }).readableIds[0];
  assert.ok(allowedId, "搜索返回的 ID 可以读取");
  const read = await readNotes.execute(
    "check-read",
    { chunkIds: [allowedId] },
    undefined,
    undefined,
    context,
  );
  assert.ok(
    read.content
      .map((block) => block.type === "text" ? block.text : "")
      .join("")
      .includes(`Citation token (copy exactly): [[source:${allowedId}]]`),
    "读取结果必须直接给模型可复制的受控引用令牌",
  );
  const conceptAnswer = `判决簿只保存用户确认的结论 [[source:${allowedId}]]。`;
  const conceptBlock = `${ANSWER_SENTINEL}${conceptAnswer}\n${CONCEPTS_SENTINEL}\n{"concepts":[{"term":"判决簿","question":"判决簿保存哪些结论？"},{"term":"不存在的词","question":"为什么？"}]}`;
  const blockConcepts = conceptTermsFromBlock(conceptBlock, conceptAnswer, "selfcheck-model");
  assert.deepEqual(
    blockConcepts.map((concept) => concept.term),
    ["判决簿"],
    "关键词必须来自主回答末尾的结构化块且逐字存在于回答",
  );
  assert.equal(
    blockConcepts[0].body,
    undefined,
    "选词阶段绝不生成临时卡正文（按需才生成）",
  );
  assert.equal(
    conceptTermsFromBlock(conceptBlock, conceptAnswer, "selfcheck-model")
      .filter((concept) => concept.term === "不存在的词").length,
    0,
    "宿主只验证 AI 选择，不得放行正文里不存在的词",
  );
  assert.equal(
    conceptTermsFromBlock(`${ANSWER_SENTINEL}${conceptAnswer}`, conceptAnswer, "selfcheck-model").length,
    0,
    "模型没给词表时不伪造高亮",
  );
  assert.equal(
    gateAnswer(conceptBlock, context).result,
    "completed",
    "概念块不得干扰引用闸门对正文的判定",
  );
  assert.equal(
    gateAnswer(conceptBlock, context).answer,
    conceptAnswer,
    "概念块不得进入落库正文",
  );

  const hiddenId = (store.db.prepare(
    "SELECT id FROM pt_chunks WHERE text LIKE '%HiddenBetaOnly%'",
  ).get() as { id: string }).id;
  await assert.rejects(
    readNotes.execute(
      "check-denied",
      { chunkIds: [hiddenId] },
      undefined,
      undefined,
      context,
    ),
    /not returned by search_notes/,
    "未搜索的 ID 不能读取",
  );

  const noEvidence = freezeProjectScope(store.db, project.id);
  assert.equal(
    gateAnswer(`${ANSWER_SENTINEL} 无证据正文 [[source:${allowedId}]]。`, noEvidence).result,
    "refused",
    "零实读不能释放正文",
  );

  const unreadCitation = gateAnswer(
    `${ANSWER_SENTINEL} 越权引用 [[source:${hiddenId}]]。`,
    context,
  );
  assert.deepEqual(
    { result: unreadCitation.result, reason: unreadCitation.reason },
    { result: "failed", reason: "citation_error" },
    "未读引用不能通过出口",
  );
  const citationOnly = gateAnswer(
    `${ANSWER_SENTINEL}原文引用：\n[[source:${allowedId}]]`,
    context,
  );
  assert.deepEqual(
    { result: citationOnly.result, reason: citationOnly.reason },
    { result: "failed", reason: "citation_error" },
    "只有标题和引用标记不能冒充完成回答",
  );
  const danglingHeading = gateAnswer(
    `${ANSWER_SENTINEL}正文事实 [[source:${allowedId}]]。\n### 小结`,
    context,
  );
  assert.deepEqual(
    { result: danglingHeading.result, reason: danglingHeading.reason },
    { result: "failed", reason: "incomplete_answer" },
    "回答不能以没有正文的 Markdown 标题冒充完成",
  );
  assert.equal(
    gateAnswer(
      `${ANSWER_SENTINEL}正文事实 [[source:${allowedId}]]。\n### 小结\n无引用结尾会被闸门丢弃。`,
      context,
    ).reason,
    "incomplete_answer",
    "完整性必须检查引用闸门清洗后的最终正文",
  );
  const streamed: string[] = [];
  const streamingGate = new AnswerSentenceGate(context, {
    onSentence: (_sentence, answer) => streamed.push(answer),
    onCitation: () => undefined,
  });
  const streamingRaw = `${ANSWER_SENTINEL}### 标题\n第一句事实 [[source:${allowedId}]]。第二句事实 [[source:${allowedId}]]。`;
  const structuralPrefix = `${ANSWER_SENTINEL}### 标题\n`;
  streamingGate.feed(structuralPrefix);
  assert.equal(streamed.length, 0, "首个有效引用事实句出现前不能单独释放标题空壳");
  for (let index = structuralPrefix.length; index < streamingRaw.length; index += 7) {
    streamingGate.feed(streamingRaw.slice(index, index + 7));
  }
  streamingGate.finish();
  assert.equal(
    streamingGate.answer,
    gateAnswer(streamingRaw, context).answer,
    "流式句闸门必须与最终落库闸门产生同一安全正文",
  );
  assert.ok(streamed.length > 0, "流式闸门应在终态前释放完整句");
  const diagnosticGate = new AnswerSentenceGate(context, {
    onSentence: () => undefined,
    onCitation: () => undefined,
  });
  diagnosticGate.feed(
    `${ANSWER_SENTINEL}无引用事实。错误引用 [[source:${hiddenId}]]。`,
  );
  diagnosticGate.finish();
  assert.deepEqual(
    diagnosticGate.citationDiagnostics,
    { uncitedClaimCount: 1, invalidCitationCount: 1 },
    "引用失败必须留下不含正文和 ID 的安全计数",
  );
  const duplicateRaw = `${ANSWER_SENTINEL}重复事实 [[source:${allowedId}]]。重复事实 [[source:${allowedId}]][[source:${allowedId}]]。`;
  assert.equal(
    gateAnswer(duplicateRaw, context).answer,
    `重复事实 [[source:${allowedId}]]。`,
    "同一事实不能因为重复追加引用而被释放两遍",
  );
  const duplicateStreamed: string[] = [];
  const duplicateStreamingGate = new AnswerSentenceGate(context, {
    onSentence: (sentence) => duplicateStreamed.push(sentence),
    onCitation: () => undefined,
  });
  for (let index = 0; index < duplicateRaw.length; index += 5) {
    duplicateStreamingGate.feed(duplicateRaw.slice(index, index + 5));
  }
  duplicateStreamingGate.finish();
  assert.deepEqual(
    duplicateStreamed,
    [`重复事实 [[source:${allowedId}]]。`],
    "流式解析状态变化不能把同一事实释放两遍",
  );

  const conversation = [
    { entryId: "u1", role: "user" as const, text: "旧问题" },
    { entryId: "a1", role: "assistant" as const, text: "完整回答里的精确选区" },
  ];
  const deep = buildBranchContext(
    { id: "source", title: "来源标题" },
    {
      kind: "deep_dive",
      question: "为什么",
      selection: { entryId: "a1", text: "精确选区", start: 6, end: 10 },
    },
    conversation,
  );
  assert.equal(deep.selectedText, "精确选区", "深挖只冻结精确选区");
  assert.equal(deep.sourceTurn, 1, "深挖必须冻结来源回答轮次");
  const deepFromUser = buildBranchContext(
    { id: "source", title: "来源标题" },
    {
      kind: "deep_dive",
      question: "为什么",
      selection: { entryId: "u1", text: "旧问题", start: 0, end: 3 },
    },
    conversation,
  );
  assert.equal(deepFromUser.kind, "deep_dive", "深挖可指向 user 轮（导入卡无 AI 回答）");
  assert.equal(deepFromUser.selectedText, "旧问题", "user 轮选区冻结全文");
  assert.equal(deepFromUser.sourceTurn, 0, "无 assistant 轮时 sourceTurn 为 0");
  const divergent = buildBranchContext(
    { id: "source", title: "来源标题" },
    { kind: "diverge", question: "发散什么", topic: "只继承主题" },
    conversation,
  );
  assert.deepEqual(
    Object.keys(divergent).sort(),
    ["kind", "sourceCardId", "sourceTitle", "topic"].sort(),
    "发散不携带父对话",
  );
  const reroute = buildBranchContext(
    { id: "source", title: "来源标题" },
    { kind: "reroute", question: "改写", sourceEntryId: "u1" },
    conversation,
  );
  assert.equal(reroute.sourceEntryId, "u1", "改道指向旧问题 entry");

  const unsafeAssistant = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "hidden", thinkingSignature: "sig" },
      {
        type: "text",
        text: `协议前缀${ANSWER_SENTINEL}<analysis>secret</analysis>第一段安全正文 [[source:${allowedId}]]。`,
      },
      { type: "text", text: `第二段安全正文 [[source:${allowedId}]]。` },
    ],
    api: "anthropic-messages",
    provider: "cozai",
    model: "selfcheck",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } as AssistantMessage;
  const sanitized = sanitizeAssistantMessage(unsafeAssistant, context);
  assert.equal(sanitized.content.some((block) => block.type === "thinking"), false);
  assert.match(JSON.stringify(sanitized), /第一段安全正文/);
  assert.match(JSON.stringify(sanitized), /第二段安全正文/);
  assert.doesNotMatch(JSON.stringify(sanitized), /hidden|secret|协议前缀/);

  const toolAssistant = {
    ...unsafeAssistant,
    content: [
      { type: "thinking", thinking: "replay me", thinkingSignature: "sig" },
      { type: "text", text: "工具前正文不得落库" },
      { type: "toolCall", id: "tool-1", name: "search_notes", arguments: { query: "测试" } },
    ],
    stopReason: "toolUse",
  } as AssistantMessage;
  const sanitizedTool = sanitizeAssistantMessage(toolAssistant, context);
  assert.deepEqual(sanitizedTool.content.map((block) => block.type), ["thinking", "toolCall"]);
  assert.doesNotMatch(JSON.stringify(sanitizedTool), /工具前正文不得落库/);

  const sessions = createSessionRepo(store);
  const rawSession = await sessions.create({ cwd: sessionCwd(project.id) });
  const sessionMetadata = await rawSession.getMetadata();
  const safeSession = withSanitizedStorage(rawSession, context);
  await safeSession.appendMessage(unsafeAssistant);
  await closeSession(rawSession);
  const reopenedSession = await openSessionById(sessions, sessionMetadata.id, project.id);
  const storedMessages = await activeConversation(reopenedSession);
  assert.equal(storedMessages.length, 1);
  assert.match(storedMessages[0].text, /第一段安全正文/);
  assert.match(storedMessages[0].text, /第二段安全正文/);
  assert.doesNotMatch(storedMessages[0].text, /hidden|secret|协议前缀/);
  await closeSession(reopenedSession);

  const sourceCardId = "concept-source-card";
  const sourceRunId = "concept-source-run";
  const conceptId = "concept-preview";
  const now = new Date().toISOString();
  store.db.prepare(`
    INSERT INTO pt_cards(
      id, project_id, session_id, title, branch_kind, source_card_id,
      branch_context_json, created_at, updated_at
    ) VALUES(?, ?, ?, '来源卡', 'root', NULL, NULL, ?, ?)
  `).run(sourceCardId, project.id, sessionMetadata.id, now, now);
  store.db.prepare(`
    INSERT INTO pt_runs(
      id, project_id, card_id, question, status, result, reason,
      scope_json, previous_leaf_id, answer, error, created_at, ended_at
    ) VALUES(?, ?, ?, '来源问题', 'ended', 'completed', 'none', ?, NULL, ?, NULL, ?, ?)
  `).run(
    sourceRunId,
    project.id,
    sourceCardId,
    JSON.stringify(context.documents),
    storedMessages[0].text,
    now,
    now,
  );
  store.db.prepare(`
    INSERT INTO pt_run_events(run_id, seq, event_type, payload_json, created_at)
    VALUES(?, 1, 'concepts_ready', ?, ?)
  `).run(
    sourceRunId,
    JSON.stringify({
      concepts: [{
        id: conceptId,
        term: "安全正文",
        body: storedMessages[0].text,
        question: "安全正文为什么值得保留？",
        model: "selfcheck",
      }],
    }),
    now,
  );
  const engine = new PapertableEngine(store, sessions);
  const promoted = await engine.createBranch(sourceCardId, {
    kind: "concept",
    question: "客户端内容不应成为事实来源",
    sourceRunId,
    conceptId,
  });
  const promotedCard = store.db.prepare(
    "SELECT branch_kind FROM pt_cards WHERE id = ?",
  ).get(promoted.cardId) as { branch_kind: string };
  assert.equal(promotedCard.branch_kind, "concept", "临时卡提升必须保存为独立的概念关系");
  const promotedDetail = await engine.cardDetail(promoted.cardId) as {
    messages: Array<{ role: string; text: string }>;
  };
  assert.equal(
    promotedDetail.messages.at(-1)?.text,
    storedMessages[0].text,
    "正式卡必须保留用户认可的 AI 临时卡正文，不能重新伪装成深挖回答",
  );

  // —— 按需概念会话 e2e（mock 模型）：正文完即结束，临时卡点击才生成 ——
  {
    await writeFile(
      join(libraryDir, "verdict.md"),
      "判决簿只持久化用户确认的金子与墓碑，其余探索痕迹默认蒸发。干净上下文不再失忆。",
    );
    await reindexLibrary(store, project.id);
    const mockPort = 9417;
    const mock = spawn(
      process.execPath,
      [new URL("../scripts/mock-model.mjs", import.meta.url).pathname],
      {
        env: { ...process.env, MOCK_PORT: String(mockPort), MOCK_LOG: join(directory, "mock.log") },
        stdio: "ignore",
      },
    );
    const originalBaseUrl = process.env.PAPERTABLE_BASE_URL;
    const originalModel = process.env.PAPERTABLE_MODEL;
    try {
      process.env.PAPERTABLE_BASE_URL = `http://127.0.0.1:${mockPort}`;
      process.env.PAPERTABLE_API_KEY = "selfcheck-secret";
      process.env.PAPERTABLE_MODEL = "mock-1";
      await new Promise((resolve) => setTimeout(resolve, 500));
      const liveEngine = new PapertableEngine(store, sessions);
      const { cardId: liveCardId, runId: liveRunId } = await liveEngine.createRootCard(
        project.id,
        "判决簿怎么工作？",
      );
      const liveRun = await waitRunEnded(store.db, liveRunId);
      assert.equal(liveRun.result, "completed", "mock 主回答必须完成");
      const eventTypes = (store.db.prepare(
        "SELECT event_type FROM pt_run_events WHERE run_id = ? ORDER BY seq",
      ).all(liveRunId) as Array<{ event_type: string }>).map((row) => row.event_type);
      const conceptsAt = eventTypes.lastIndexOf("concepts_ready");
      assert.ok(conceptsAt >= 0, "完成轮必须产出概念词表");
      assert.ok(
        conceptsAt < eventTypes.lastIndexOf("run_end"),
        "概念词表必须在 run_end 之前同步产出，正文结束不得再串行等待第二轮模型调用",
      );
      const liveConcepts = jsonObject((store.db.prepare(`
        SELECT payload_json FROM pt_run_events
        WHERE run_id = ? AND event_type = 'concepts_ready' ORDER BY seq DESC LIMIT 1
      `).get(liveRunId) as { payload_json: string }).payload_json).concepts as Array<{
        id: string; term: string; body?: string; question: string;
      }>;
      assert.deepEqual(liveConcepts.map((item) => item.term), ["判决簿"], "词表来自主回答末尾结构化块");
      assert.equal(liveConcepts[0].body, undefined, "选词阶段绝不预写临时卡正文");

      const preview = await liveEngine.startConceptPreview(liveCardId, {
        sourceRunId: liveRunId,
        conceptId: liveConcepts[0].id,
      });
      assert.equal(preview.status, "running", "点击才启动按需概念会话");
      const previewRun = await waitRunEnded(store.db, preview.runId);
      assert.equal(previewRun.result, "completed", "按需概念会话必须能调用工具检索并完成");
      assert.match(String(previewRun.answer), /判决簿/, "概念解释来自 AI 会话而非预写");
      assert.equal(previewRun.kind, "concept_preview", "预览 run 不得混进正式轮");

      const again = await liveEngine.startConceptPreview(liveCardId, {
        sourceRunId: liveRunId,
        conceptId: liveConcepts[0].id,
      });
      assert.equal(again.runId, preview.runId, "重复点击必须复用缓存，绝不重复生成");
      assert.equal(again.cached, true);
      assert.equal(again.answer, previewRun.answer);

      const mainDetail = await liveEngine.cardDetail(liveCardId) as {
        runs: Array<{ id: string }>;
        conceptPreviews: Array<{ id: string }>;
      };
      assert.ok(
        mainDetail.runs.every((run) => run.id !== preview.runId),
        "预览 run 不得出现在正式轮列表",
      );
      assert.equal(mainDetail.conceptPreviews.length, 1, "预览会话要随卡片详情返回");

      const promotedLive = await liveEngine.createBranch(liveCardId, {
        kind: "concept",
        question: "不应被采用的问题",
        previewRunId: preview.runId,
      });
      const promotedLiveCard = store.db.prepare(
        "SELECT branch_kind, session_id FROM pt_cards WHERE id = ?",
      ).get(promotedLive.cardId) as { branch_kind: string; session_id: string };
      assert.equal(promotedLiveCard.branch_kind, "concept", "按需会话提升必须是概念关系");
      const promotedRunRow = store.db.prepare(
        "SELECT kind, card_id FROM pt_runs WHERE id = ?",
      ).get(preview.runId) as { kind: string; card_id: string };
      assert.equal(promotedRunRow.kind, "answer", "提升后预览 run 转正为正式首轮");
      assert.equal(promotedRunRow.card_id, promotedLive.cardId);
      const promotedLiveDetail = await liveEngine.cardDetail(promotedLive.cardId) as {
        messages: Array<{ role: string; entryId: string; text: string }>;
        runs: Array<{ id: string; answerEntryId?: string | null }>;
      };
      assert.equal(promotedLiveDetail.messages.length, 2, "正式卡首轮就是点击时的概念对话");
      assert.equal(promotedLiveDetail.messages[1].text, previewRun.answer);
      assert.equal(
        promotedLiveDetail.runs[0]?.answerEntryId,
        promotedLiveDetail.messages[1].entryId,
        "转正 run 必须稳定绑定到概念对话的 assistant 条目",
      );
    } finally {
      mock.kill();
      restoreEnv("PAPERTABLE_BASE_URL", originalBaseUrl);
      restoreEnv("PAPERTABLE_MODEL", originalModel);
    }
  }

  assert.equal(stageIdentity("card", "leaf"), stageIdentity("card", "leaf"));
  assert.notEqual(stageIdentity("card", "leaf"), stageIdentity("card", "next"));

  const replacementLibrary = join(directory, "replacement-library");
  await mkdir(replacementLibrary);
  await writeFile(join(replacementLibrary, "replacement.md"), "ReplacementOnly belongs to the new binding.");
  await bindLibrary(store, project.id, replacementLibrary);
  assert.equal(
    Number((store.db.prepare(`
      SELECT COUNT(*) AS count FROM pt_documents
      WHERE project_id = ? AND source_kind = 'library'
    `).get(project.id) as { count: number }).count),
    0,
    "重新绑定长期资料库后，旧索引必须立即退出项目资料边界",
  );

  // —— 回收站物理删除：级联清理、判决引用与运行中保护、项目隔离 ——
  {
    ensureVerdictTables(store.db);
    const stamp = new Date().toISOString();
    const mkCard = (id: string, projectId: string) => {
      store.db.prepare(`
        INSERT INTO pt_cards(
          id, project_id, session_id, title, branch_kind, source_card_id,
          branch_context_json, created_at, updated_at
        ) VALUES(?, ?, ?, ?, 'root', NULL, NULL, ?, ?)
      `).run(id, projectId, `session-${id}`, `卡片-${id.slice(-2)}`, stamp, stamp);
    };
    mkCard("purge-a", project.id);
    mkCard("purge-b", project.id);
    mkCard("purge-c", project.id);
    mkCard("purge-d", project.id);
    mkCard("purge-e", secondProject.id);
    store.db.prepare(`
      INSERT INTO pt_runs(
        id, project_id, card_id, question, status, result, reason,
        scope_json, previous_leaf_id, answer, error, created_at, ended_at
      ) VALUES('purge-run-a', ?, 'purge-a', '问题', 'ended', 'completed', 'none', '[]', NULL, '答案', NULL, ?, ?)
    `).run(project.id, stamp, stamp);
    store.db.prepare(`
      INSERT INTO pt_run_events(run_id, seq, event_type, payload_json, created_at)
      VALUES('purge-run-a', 1, 'run_created', '{}', ?)
    `).run(stamp);
    store.db.prepare(`
      INSERT INTO pt_edges(
        id, project_id, source_card_id, target_card_id, kind, snapshot_json, created_at
      ) VALUES('purge-edge', ?, 'purge-a', 'purge-b', 'deep_dive', '{}', ?)
    `).run(project.id, stamp);
    store.db.prepare(`
      INSERT INTO pt_verdicts(
        id, project_id, card_id, run_id, kind, text, handle, status, memos_status,
        created_at, updated_at
      ) VALUES('purge-verdict', ?, 'purge-c', NULL, 'gold', '结论', '把手', 'confirmed', 'pending', ?, ?)
    `).run(project.id, stamp, stamp);
    store.db.prepare(`
      INSERT INTO pt_runs(
        id, project_id, card_id, question, status, result, reason,
        scope_json, previous_leaf_id, answer, error, created_at, ended_at
      ) VALUES('purge-run-d', ?, 'purge-d', '问题', 'running', NULL, NULL, '[]', NULL, NULL, NULL, ?, NULL)
    `).run(project.id, stamp);

    const result = purgeCards(store, project.id, ["purge-a", "purge-b", "purge-c", "purge-d", "purge-e"]);
    assert.deepEqual(result.purged.sort(), ["purge-a", "purge-b"]);
    assert.deepEqual(
      result.skipped.map((item) => item.cardId),
      ["purge-c", "purge-d", "purge-e"],
      "判决引用、运行中与他项目卡片只能跳过",
    );
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM pt_runs WHERE id = 'purge-run-a'").get()!.n,
      0,
      "运行必须随卡片级联删除",
    );
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM pt_run_events WHERE run_id = 'purge-run-a'").get()!.n,
      0,
      "运行事件必须随运行级联删除",
    );
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM pt_edges WHERE id = 'purge-edge'").get()!.n,
      0,
      "关系边必须随卡片级联删除",
    );
    assert.ok(requireCard(store.db, "purge-c"), "被判决引用的卡片必须保留");
    assert.ok(requireCard(store.db, "purge-d"), "运行中的卡片必须保留");
    assert.ok(requireCard(store.db, "purge-e"), "其他项目的卡片必须保留");
    // 清掉保护场景，避免影响后续统计断言
    store.db.prepare("DELETE FROM pt_verdicts WHERE id = 'purge-verdict'").run();
    store.db.prepare("UPDATE pt_runs SET status = 'ended' WHERE id = 'purge-run-d'").run();
    purgeCards(store, project.id, ["purge-c", "purge-d"]);
    purgeCards(store, secondProject.id, ["purge-e"]);
  }

  store.db.close();

  // —— run ↔ assistant 稳定绑定回归 ——
  // 事故场景：会话 assistant 正文比 run.answer 多出 `---`，严格相等失配导致
  // runId / citations / concepts 全部丢失、关键词不高亮。绑定必须只依赖
  // previous_leaf_id / answerEntryId，禁止正文文本匹配。
  {
    const branchEntries = [
      { id: "u1", type: "message", message: { role: "user" } },
      { id: "a1", type: "message", message: { role: "assistant" } },
      { id: "u2", type: "message", message: { role: "user" } },
      { id: "a2", type: "message", message: { role: "assistant" } },
    ];
    const backendBinding = bindAnswerEntries(branchEntries, [
      { id: "run-1", result: "completed", answer: "第一轮答案", previous_leaf_id: null },
      { id: "run-2", result: "completed", answer: "第二轮答案", previous_leaf_id: "a1" },
    ]);
    assert.equal(backendBinding.get("run-1"), "a1", "无锚点首轮必须顺序映射到第一条 assistant");
    assert.equal(backendBinding.get("run-2"), "a2", "previous_leaf_id 必须锚定到对应 assistant");

    const feTurns = [
      { entryId: "u1", role: "user" as const },
      { entryId: "a1", role: "ai" as const },
      { entryId: "u2", role: "user" as const },
      { entryId: "a2", role: "ai" as const },
    ];
    // 会话正文与 run.answer 不逐字相等（多出 ---）也必须完成绑定
    const feBinding = bindRunsToTurns(feTurns, [
      { id: "run-1", result: "completed", answer: "第一轮答案", answerEntryId: "a1" },
      { id: "run-2", result: "completed", answer: "第二轮答案---", answerEntryId: "a2" },
    ]);
    assert.equal(feBinding.get("run-1"), 1, "answerEntryId 稳定绑定第一轮");
    assert.equal(feBinding.get("run-2"), 3, "answerEntryId 稳定绑定第二轮，不串轮");

    const fallback = bindRunsToTurns(feTurns, [
      { id: "run-1", result: "completed", answer: "x" },
      { id: "run-2", result: "completed", answer: "y" },
    ]);
    assert.equal(fallback.get("run-1"), 1, "旧数据无 answerEntryId 时确定性顺序映射第一轮");
    assert.equal(fallback.get("run-2"), 3, "旧数据无 answerEntryId 时确定性顺序映射第二轮");

    // 改道继承历史的 AI 轮不属于任何 run，顺序映射不得吞掉它
    const inherited = bindRunsToTurns(
      [
        { entryId: "h-u", role: "user" as const },
        { entryId: "h-a", role: "ai" as const },
        ...feTurns,
      ],
      [
        { id: "run-1", result: "completed", answer: "x" },
        { id: "run-2", result: "completed", answer: "y", answerEntryId: "a2" },
      ],
    );
    assert.equal(inherited.get("run-1"), 3, "继承历史轮不得被 run 抢占");
    assert.equal(inherited.get("run-2"), 5, "稳定绑定不受继承历史影响");
  }

  // —— 装饰性分隔线清理回归 ——
  {
    const messy = "第一节正文。---\n---\n### 第二节\n内容 §1 。---";
    const cleaned = normalizeModelMarkdown(messy);
    assert.ok(!cleaned.includes("---"), "段尾与独立 --- 都必须清除");
    assert.ok(cleaned.includes("## 第二节"), "标题必须保留");

    const table = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    assert.equal(
      normalizeModelMarkdown(table),
      table,
      "表格分隔行必须原样保留",
    );

    const fenced = "```yaml\n---\nkey: value\n---\n```";
    assert.equal(
      normalizeModelMarkdown(fenced),
      fenced,
      "代码围栏内的 --- 必须原样保留",
    );

    const gluedMermaid = "正文 §1。```mermaid\nflowchart TD\nA --> B\n```";
    assert.equal(
      normalizeModelMarkdown(gluedMermaid),
      "正文 §1。\n\n```mermaid\nflowchart TD\nA --> B\n```",
      "黏在正文后的 Mermaid 围栏必须恢复到行首",
    );
  }


  const reopened = openDataStore(dataDir);
  assert.equal(
    Number((reopened.db.prepare("SELECT COUNT(*) AS count FROM pt_projects").get() as { count: number }).count),
    2,
    "项目与索引可在重启后恢复",
  );
  reopened.db.close();
  process.stdout.write("selfcheck: ok\n");
} finally {
  await rm(directory, { recursive: true, force: true });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function waitRunEnded(
  db: import("node:sqlite").DatabaseSync,
  runId: string,
  timeoutMs = 30_000,
): Promise<Record<string, string | null>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = db.prepare("SELECT * FROM pt_runs WHERE id = ?").get(runId) as
      | Record<string, string | null>
      | undefined;
    if (row?.status === "ended") return row;
    if (Date.now() > deadline) throw new Error(`run 超时未结束: ${runId}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
