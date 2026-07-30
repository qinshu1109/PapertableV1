import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { openDataStore } from "./data.ts";
import { createProject } from "./projects.ts";
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
  gateAnswer,
  sanitizeAssistantMessage,
} from "./gate.ts";
import { buildBranchContext } from "./engine.ts";
import { stageIdentity } from "./memos.ts";
import {
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
import { reduceToolActivity } from "../frontend/src/lib/run-activity.ts";

const directory = await mkdtemp(join(tmpdir(), "papertable-selfcheck-"));
try {
  const dataDir = join(directory, "data");
  const libraryDir = join(directory, "library");
  await mkdir(libraryDir);
  await writeFile(join(libraryDir, "alpha.md"), "AlphaOnly proves that searched evidence may be read.");
  await writeFile(join(libraryDir, "hidden.txt"), "HiddenBetaOnly must never be readable before search.");

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
  const originalProviderEnv = {
    baseUrl: process.env.PAPERTABLE_BASE_URL,
    apiKey: process.env.PAPERTABLE_API_KEY,
    model: process.env.PAPERTABLE_MODEL,
  };
  try {
    const publicSettings = saveProviderSettings(dataDir, {
      protocol: "anthropic-messages",
      baseUrl: "https://example.test/v1/",
      apiKey: "selfcheck-secret",
      model: "claude-selfcheck",
    });
    assert.deepEqual(publicSettings, {
      protocol: "anthropic-messages",
      baseUrl: "https://example.test/v1",
      model: "claude-selfcheck",
      hasApiKey: true,
    });
    assert.equal("apiKey" in publicSettings, false, "设置接口绝不能回传密钥");
    assert.equal(
      (await stat(providerSettingsPath(dataDir))).mode & 0o777,
      0o600,
      "模型配置文件权限必须是 0600",
    );
    delete process.env.PAPERTABLE_BASE_URL;
    delete process.env.PAPERTABLE_API_KEY;
    delete process.env.PAPERTABLE_MODEL;
    assert.equal(loadProviderSettings(dataDir).model, "claude-selfcheck");
    assert.equal(process.env.PAPERTABLE_API_KEY, "selfcheck-secret");
    assert.throws(
      () => saveProviderSettings(dataDir, {
        protocol: "openai-completions",
        baseUrl: "https://example.test",
        apiKey: "wrong-protocol",
        model: "wrong-model",
      }),
      /只支持 Anthropic Messages/,
      "后端必须拒绝 OpenAI 协议",
    );
  } finally {
    restoreEnv("PAPERTABLE_BASE_URL", originalProviderEnv.baseUrl);
    restoreEnv("PAPERTABLE_API_KEY", originalProviderEnv.apiKey);
    restoreEnv("PAPERTABLE_MODEL", originalProviderEnv.model);
  }
  const project = createProject(store, "selfcheck") as { id: string };
  await bindLibrary(store, project.id, libraryDir);
  await reindexLibrary(store, project.id);
  const secondProject = createProject(store, "same-library") as { id: string };
  await bindLibrary(store, secondProject.id, libraryDir);
  await reindexLibrary(store, secondProject.id);
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

  store.db.close();
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
