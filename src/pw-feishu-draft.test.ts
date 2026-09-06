/**
 * TASK-PW-75：飞书速记「像个坑 → 出稿」扩展测试。
 * 覆盖：loadDraftConfig（缺省关闭 / false 关闭 / 配置坏 fail-closed / 开但缺模型关闭 / 合法开启与缺省值 /
 * 自定义覆盖）、detectPitfall（命中/不命中/大小写/纯数字边界）、extractBilibiliUrl、DraftState（日计数换日归零 /
 * 静音 / 待出稿 TTL / 取走即清 / 周计数 / 落盘往返 / 坏文件兜底）、buildDraftPrompt、parse 两个来源、
 * DraftHook 端到端（关闭零影响 / offer 与封顶 / "1" 出稿 / 无待出稿 / 静音 / 模型失败 / MemOS 失败降级 /
 * B 站链接周计数与 #发布 后缀 / 内部异常不外抛）。
 * SDK 接线（callMemosMcp、飞书回执）不做单测，与 PW-52 同一规格。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ACK_REPLY,
  buildDraftPrompt,
  buildPublishedReply,
  DEFAULT_DRAFT_KEYWORDS,
  DEFAULT_MAX_OFFERS_PER_DAY,
  detectPitfall,
  DraftHook,
  DraftState,
  extractBilibiliUrl,
  extractChatContent,
  loadDraftConfig,
  localDayKey,
  localWeekKey,
  NO_PENDING_REPLY,
  OFFER_REPLY,
  parseMemosMcpResults,
  parseMemosRestResults,
  type DraftDeps,
} from "./pw-feishu-draft.ts";

const RELAY_BASE = {
  appId: "cli_test",
  appSecret: "secret",
  memosUrl: "http://127.0.0.1:5230",
  memosToken: "memos-token",
};

const MODEL = { baseUrl: "http://relay.local/v1", apiKey: "sk-test", model: "test-model" };

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pw-feishu-draft-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeConfig(path: string, extra: Record<string, unknown>): Promise<void> {
  await rm(path, { force: true });
  await writeFile(path, JSON.stringify({ ...RELAY_BASE, ...extra }), { encoding: "utf8", mode: 0o600 });
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

test("loadDraftConfig：缺省关闭 / false 关闭 / 配置坏 fail-closed / 开但缺模型关闭", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "feishu-relay.json");

    await writeConfig(path, {});
    let config = loadDraftConfig(path);
    assert.equal(config.enabled, false);
    assert.match(config.disabledReason ?? "", /draftOffer 未开启/);

    await writeConfig(path, { draftOffer: false, draftModel: MODEL });
    assert.equal(loadDraftConfig(path).enabled, false, "显式 false 必须关闭");

    await writeConfig(path, { draftOffer: "true", draftModel: MODEL });
    assert.equal(loadDraftConfig(path).enabled, false, "字符串 true 不算开启");

    await writeFile(path, "{ not json", "utf8");
    config = loadDraftConfig(path);
    assert.equal(config.enabled, false, "配置坏了必须关闭");
    assert.match(config.disabledReason ?? "", /配置读取失败/);

    assert.equal(loadDraftConfig(join(dir, "no-such.json")).enabled, false, "文件不存在必须关闭");

    await writeConfig(path, { draftOffer: true });
    config = loadDraftConfig(path);
    assert.equal(config.enabled, false);
    assert.match(config.disabledReason ?? "", /缺 baseUrl \/ apiKey \/ model/);

    await writeConfig(path, { draftOffer: true, draftModel: { ...MODEL, apiKey: "  " } });
    assert.equal(loadDraftConfig(path).enabled, false, "apiKey 空白等于缺");
  });
});

test("loadDraftConfig：合法开启带缺省值 / 自定义覆盖 / 非法值回落缺省 / cube 最多两个", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "feishu-relay.json");

    await writeConfig(path, { draftOffer: true, draftModel: { ...MODEL, baseUrl: "http://relay.local/v1/" } });
    const config = loadDraftConfig(path);
    assert.equal(config.enabled, true);
    assert.equal(config.disabledReason, undefined);
    assert.deepEqual(config.keywords, [...DEFAULT_DRAFT_KEYWORDS]);
    assert.deepEqual(config.triggerWords, ["1", "出稿"]);
    assert.equal(config.muteWord, "别问了");
    assert.equal(config.maxOffersPerDay, DEFAULT_MAX_OFFERS_PER_DAY);
    assert.equal(config.offerTtlHours, 12);
    assert.equal(config.muteDays, 7);
    assert.equal(config.model?.baseUrl, "http://relay.local/v1", "baseUrl 末尾斜杠应去掉");
    assert.equal(config.memosMcpUrl, undefined);
    assert.deepEqual(config.memosCubeIds, ["index"]);

    await writeConfig(path, {
      draftOffer: true,
      draftModel: MODEL,
      draftKeywords: ["  Gemini ", "429"],
      draftTriggerWords: ["go"],
      draftMuteWord: "闭嘴",
      draftMaxOffersPerDay: 5,
      draftOfferTtlHours: 1,
      draftMuteDays: 3,
      memosMcpUrl: "http://127.0.0.1:8002/mcp/",
      draftMemosCubeIds: ["a", "b", "c"],
    });
    const custom = loadDraftConfig(path);
    assert.deepEqual(custom.keywords, ["gemini", "429"], "关键词去空白并小写");
    assert.deepEqual(custom.triggerWords, ["go"]);
    assert.equal(custom.muteWord, "闭嘴");
    assert.equal(custom.maxOffersPerDay, 5);
    assert.equal(custom.offerTtlHours, 1);
    assert.equal(custom.muteDays, 3);
    assert.equal(custom.memosMcpUrl, "http://127.0.0.1:8002/mcp");
    assert.deepEqual(custom.memosCubeIds, ["a", "b"], "cube 最多两个");

    await writeConfig(path, {
      draftOffer: true,
      draftModel: MODEL,
      draftKeywords: [],
      draftMaxOffersPerDay: 0,
      draftOfferTtlHours: -1,
      draftMuteDays: 2.5,
    });
    const fallback = loadDraftConfig(path);
    assert.deepEqual(fallback.keywords, [...DEFAULT_DRAFT_KEYWORDS], "空数组回落缺省");
    assert.equal(fallback.maxOffersPerDay, DEFAULT_MAX_OFFERS_PER_DAY, "0 回落缺省");
    assert.equal(fallback.offerTtlHours, 12, "负数回落缺省");
    assert.equal(fallback.muteDays, 7, "非整数回落缺省");
  });
});

// ---------------------------------------------------------------------------
// 纯判断
// ---------------------------------------------------------------------------

test("detectPitfall：命中 / 不命中 / 大小写 / 纯数字前后不能紧邻数字", () => {
  const kw = [...DEFAULT_DRAFT_KEYWORDS];
  assert.equal(detectPitfall("gemini 2.5 pro 又 429 了，配额页显示没超", kw), "429");
  assert.equal(detectPitfall("上游 Timeout 三次", kw), "timeout", "大小写不敏感");
  assert.equal(detectPitfall("这个模型的 Rate Limit 太低", kw), "rate limit");
  assert.equal(detectPitfall("今天想到一个选题：讲讲路由策略", kw), null, "普通灵感不命中");
  assert.equal(detectPitfall("笔记项目应该后台自动化", kw), null, "系统愿望不命中");
  assert.equal(detectPitfall("今天处理了 15000 条请求", kw), null, "500 夹在数字里不算命中");
  assert.equal(detectPitfall("返回 500 了", kw), "500");
  assert.equal(detectPitfall("上游 500", kw), "500", "行尾也算");
  assert.equal(detectPitfall("", kw), null);
  assert.equal(detectPitfall("随便", []), null, "空关键词表不命中");
});

test("extractBilibiliUrl：bilibili.com / b23.tv / t.bilibili.com / 非 B 站链接", () => {
  assert.equal(
    extractBilibiliUrl("发了 https://www.bilibili.com/video/BV1xx411c7mD 第一条"),
    "https://www.bilibili.com/video/BV1xx411c7mD",
  );
  assert.equal(extractBilibiliUrl("https://b23.tv/abc123"), "https://b23.tv/abc123");
  assert.equal(extractBilibiliUrl("动态 https://t.bilibili.com/9876543210"), "https://t.bilibili.com/9876543210");
  assert.equal(extractBilibiliUrl("专栏 http://m.bilibili.com/read/cv123"), "http://m.bilibili.com/read/cv123");
  assert.equal(extractBilibiliUrl("看看 https://github.com/x/y"), null);
  assert.equal(extractBilibiliUrl("bilibili.com/video/BV1 没有协议头"), null);
  assert.equal(extractBilibiliUrl("普通速记"), null);
});

test("localDayKey / localWeekKey：本地日与周一起算的周键", () => {
  // 2026-09-06 是周日 → 该周周一 2026-08-31
  const sunday = new Date(2026, 8, 6, 23, 30);
  assert.equal(localDayKey(sunday), "2026-09-06");
  assert.equal(localWeekKey(sunday), "2026-08-31");
  const monday = new Date(2026, 8, 7, 0, 5);
  assert.equal(localWeekKey(monday), "2026-09-07", "周一自成新周");
  assert.equal(localWeekKey(new Date(2026, 8, 9)), "2026-09-07");
});

// ---------------------------------------------------------------------------
// 状态簿
// ---------------------------------------------------------------------------

test("DraftState：日计数换日归零 / 封顶 / 静音 / 待出稿 TTL 与取走即清 / 周计数 / 落盘往返 / 坏文件兜底", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "feishu-relay-draft-state.json");
    await writeFile(path, "{ broken", "utf8");
    const state = new DraftState(path);
    state.load();
    assert.equal(state.pending, undefined, "坏文件按空状态");

    const day1 = new Date(2026, 8, 6, 10, 0);
    assert.equal(state.canOffer(day1, 2), true);
    state.recordOffer({ messageId: "om_1", text: "429 了", keyword: "429", memo: "memos/a" }, day1);
    assert.equal(state.offersToday(day1), 1);
    assert.equal(state.canOffer(day1, 2), true);
    state.recordOffer({ messageId: "om_2", text: "又 502", keyword: "502", memo: "memos/b" }, day1);
    assert.equal(state.canOffer(day1, 2), false, "第三次当日封顶");
    assert.equal(state.pending?.messageId, "om_2", "新 offer 覆盖旧 offer");

    const day2 = new Date(2026, 8, 7, 0, 1);
    assert.equal(state.canOffer(day2, 2), true, "换日归零");
    assert.equal(state.offersToday(day2), 0);

    // 待出稿：TTL 内取走并清空；再取为空
    const pending = state.takePending(new Date(day1.getTime() + 60 * 60 * 1000), 12);
    assert.equal(pending?.messageId, "om_2");
    assert.equal(state.takePending(day1, 12), undefined, "取走即清");

    // TTL 过期：取不到
    state.recordOffer({ messageId: "om_3", text: "超时", keyword: "超时", memo: "memos/c" }, day1);
    assert.equal(state.takePending(new Date(day1.getTime() + 13 * 60 * 60 * 1000), 12), undefined);

    // 静音
    assert.equal(state.isMuted(day1), false);
    const until = state.mute(day1, 7);
    assert.equal(until.getTime(), day1.getTime() + 7 * 24 * 60 * 60 * 1000);
    assert.equal(state.isMuted(new Date(day1.getTime() + 6 * 24 * 60 * 60 * 1000)), true);
    assert.equal(state.canOffer(new Date(day1.getTime() + 6 * 24 * 60 * 60 * 1000), 2), false, "静音期内不 offer");
    assert.equal(state.isMuted(new Date(day1.getTime() + 8 * 24 * 60 * 60 * 1000)), false);

    // 周计数：同周累加，跨周归零
    assert.equal(state.recordPublished("https://b23.tv/1", new Date(2026, 8, 1)), 1);
    assert.equal(state.recordPublished("https://b23.tv/2", new Date(2026, 8, 3)), 2);
    assert.equal(state.weekCount(new Date(2026, 8, 6)), 2, "周日仍算同一周");
    assert.equal(state.recordPublished("https://b23.tv/3", new Date(2026, 8, 7)), 1, "周一起新周");

    // 落盘往返
    state.save();
    const raw = await readFile(path, "utf8");
    assert.ok(raw.includes("b23.tv/3"));
    const reloaded = new DraftState(path);
    reloaded.load();
    assert.equal(reloaded.weekCount(new Date(2026, 8, 7)), 1);
    assert.equal(reloaded.isMuted(new Date(day1.getTime() + 1000)), true);
  });
});

// ---------------------------------------------------------------------------
// 提示词与解析
// ---------------------------------------------------------------------------

test("buildDraftPrompt：原文 / 关键词 / 相关旧记录逐条带日期 / 无则「无」/ 硬规则含【补】与纯文本", () => {
  const withRelated = buildDraftPrompt(
    { text: "gemini 又 429", keyword: "429" },
    [
      { text: "gemini 限流和配额页对不上", date: "2026-08-12", source: "memos" },
      { text: "vertex 端点没这个问题", date: "", source: "memos-mcp" },
    ],
  );
  assert.ok(withRelated.user.includes("速记原文：gemini 又 429"));
  assert.ok(withRelated.user.includes("命中关键词：429"));
  assert.ok(withRelated.user.includes("- [2026-08-12] gemini 限流和配额页对不上"));
  assert.ok(withRelated.user.includes("- [日期不明] vertex 端点没这个问题"));
  assert.ok(withRelated.system.includes("【补】"));
  assert.ok(withRelated.system.includes("纯文本"));
  assert.ok(withRelated.system.includes("B 站"));

  const none = buildDraftPrompt({ text: "x 报错", keyword: "报错" }, []);
  assert.ok(/相关旧记录：\n无/u.test(none.user));
});

test("parseMemosMcpResults：structuredContent / content[0].text JSON / 坏 JSON / 非法形状", () => {
  const structured = {
    structuredContent: {
      results: [
        { memory: "gemini 限流", cube_id: "c", memory_id: "m1", memory_view: { occurred_at: "2026-08-12T03:00:00Z" } },
        { memory: "   ", memory_view: {} },
        { memory: "无日期的记忆", memory_view: {} },
      ],
    },
  };
  assert.deepEqual(parseMemosMcpResults(structured), [
    { text: "gemini 限流", date: "2026-08-12", source: "memos-mcp" },
    { text: "无日期的记忆", date: "", source: "memos-mcp" },
  ]);

  const textual = {
    content: [{ type: "text", text: JSON.stringify({ results: [{ memory: "来自文本", created_at: "2026-08-20T00:00:00Z" }] }) }],
  };
  assert.deepEqual(parseMemosMcpResults(textual), [{ text: "来自文本", date: "2026-08-20", source: "memos-mcp" }]);

  assert.deepEqual(parseMemosMcpResults({ content: [{ type: "text", text: "not json" }] }), []);
  assert.deepEqual(parseMemosMcpResults({ results: "nope" }), []);
  assert.deepEqual(parseMemosMcpResults(null), []);
});

test("parseMemosRestResults：取 content 与日期 / 排除刚写入那条 / 非法形状", () => {
  const raw = {
    memos: [
      { name: "memos/new", content: "刚写的这条\n#速记", displayTime: "2026-09-06T05:00:00Z" },
      { name: "memos/old", content: "上次 429 的记录\n#速记", displayTime: "2026-08-12T05:00:00Z" },
      { name: "memos/empty", content: "   " },
    ],
  };
  assert.deepEqual(parseMemosRestResults(raw, "memos/new"), [
    { text: "上次 429 的记录\n#速记", date: "2026-08-12", source: "memos" },
  ]);
  assert.deepEqual(parseMemosRestResults({}, "x"), []);
  assert.deepEqual(parseMemosRestResults(null, "x"), []);
});

test("extractChatContent：字符串 content / 分段 content / 空", () => {
  assert.equal(extractChatContent({ choices: [{ message: { content: "  正文  " } }] }), "正文");
  assert.equal(
    extractChatContent({ choices: [{ message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }] }),
    "ab",
  );
  assert.equal(extractChatContent({ choices: [] }), "");
  assert.equal(extractChatContent(undefined), "");
});

// ---------------------------------------------------------------------------
// DraftHook 端到端（假件）
// ---------------------------------------------------------------------------

type FakeWorld = {
  hook: DraftHook;
  logs: Array<Record<string, unknown>>;
  calls: { model: number; memosRest: number; memosMcp: number };
  clock: { now: Date };
  setModelResponse: (fn: () => Promise<Response>) => void;
  setMemosRestResponse: (fn: () => Promise<Response>) => void;
  setMemosMcp: (fn: DraftDeps["callMemosTool"]) => void;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeWorld(dir: string, configPath: string): FakeWorld {
  const logs: Array<Record<string, unknown>> = [];
  const calls = { model: 0, memosRest: 0, memosMcp: 0 };
  const clock = { now: new Date(2026, 8, 6, 10, 0) };
  let modelResponse: () => Promise<Response> = async () =>
    jsonResponse({ choices: [{ message: { content: "标题：假草稿\n现象：429" } }] });
  let memosRestResponse: () => Promise<Response> = async () => jsonResponse({ memos: [] });
  let memosMcp: DraftDeps["callMemosTool"] = undefined;

  const fakeFetch: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/chat/completions")) {
      calls.model += 1;
      return modelResponse();
    }
    if (url.includes("/api/v1/memos")) {
      calls.memosRest += 1;
      return memosRestResponse();
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const hook = new DraftHook({
    configPath,
    statePath: join(dir, "feishu-relay-draft-state.json"),
    deps: {
      now: () => clock.now,
      fetch: fakeFetch,
      log: (fields) => logs.push(fields),
      memos: { url: RELAY_BASE.memosUrl, token: RELAY_BASE.memosToken },
      callMemosTool: async (url, name, args) => {
        calls.memosMcp += 1;
        if (!memosMcp) throw new Error("no mcp");
        return memosMcp(url, name, args);
      },
    },
  });

  return {
    hook,
    logs,
    calls,
    clock,
    setModelResponse: (fn) => {
      modelResponse = fn;
    },
    setMemosRestResponse: (fn) => {
      memosRestResponse = fn;
    },
    setMemosMcp: (fn) => {
      memosMcp = fn;
    },
  };
}

test("DraftHook 关闭时零影响：intercept 恒 null / afterWritten 恒 null / memoSuffix 空 / 不发任何请求", async () => {
  await withDir(async (dir) => {
    const configPath = join(dir, "feishu-relay.json");
    await writeConfig(configPath, { draftOffer: false, draftModel: MODEL });
    const world = makeWorld(dir, configPath);

    assert.equal(await world.hook.intercept("1", "om_a"), null, "关闭时 1 是普通速记");
    assert.equal(await world.hook.intercept("别问了", "om_b"), null, "关闭时「别问了」是普通速记");
    assert.equal(await world.hook.afterWritten({ text: "gemini 429 了", messageId: "om_c", memo: "memos/1" }), null);
    assert.equal(
      await world.hook.afterWritten({ text: "发了 https://b23.tv/x", messageId: "om_d", memo: "memos/2" }),
      null,
    );
    assert.equal(world.hook.memoSuffix("发了 https://b23.tv/x"), "");
    assert.deepEqual(world.calls, { model: 0, memosRest: 0, memosMcp: 0 });
  });
});

test("DraftHook：像个坑 → offer；当日两次封顶；普通速记不 offer；改配置为 false 立即生效不用重启", async () => {
  await withDir(async (dir) => {
    const configPath = join(dir, "feishu-relay.json");
    await writeConfig(configPath, { draftOffer: true, draftModel: MODEL });
    const world = makeWorld(dir, configPath);

    assert.equal(
      await world.hook.afterWritten({ text: "今天想到一个选题", messageId: "om_0", memo: "memos/0" }),
      null,
      "普通速记回缺省「已记」",
    );
    assert.equal(
      await world.hook.afterWritten({ text: "gemini 又 429 了", messageId: "om_1", memo: "memos/1" }),
      OFFER_REPLY,
    );
    assert.equal(
      await world.hook.afterWritten({ text: "上游 502", messageId: "om_2", memo: "memos/2" }),
      OFFER_REPLY,
    );
    assert.equal(
      await world.hook.afterWritten({ text: "又超时", messageId: "om_3", memo: "memos/3" }),
      null,
      "第三次封顶，回缺省「已记」",
    );
    const skipped = world.logs.find((entry) => entry.event === "draft_offer_skipped");
    assert.equal(skipped?.reason, "daily_cap");

    // 不重启：把 draftOffer 改成 false，下一条消息立即按关闭处理
    await writeConfig(configPath, { draftOffer: false, draftModel: MODEL });
    world.clock.now = new Date(2026, 8, 7, 9, 0);
    assert.equal(
      await world.hook.afterWritten({ text: "换日了还是 429", messageId: "om_4", memo: "memos/4" }),
      null,
    );
    assert.equal(await world.hook.intercept("1", "om_5"), null);
  });
});

test("DraftHook：回 1 → 先 ACK 再出稿；草稿含模型正文与尾注；待出稿取走后再回 1 提示无待出稿", async () => {
  await withDir(async (dir) => {
    const configPath = join(dir, "feishu-relay.json");
    await writeConfig(configPath, {
      draftOffer: true,
      draftModel: MODEL,
      memosMcpUrl: "http://127.0.0.1:8002/mcp",
      draftMemosCubeIds: ["notes"],
    });
    const world = makeWorld(dir, configPath);
    world.setMemosRestResponse(async () =>
      jsonResponse({
        memos: [
          { name: "memos/new", content: "gemini 又 429 了\n#速记", displayTime: "2026-09-06T02:00:00Z" },
          { name: "memos/old", content: "gemini 限流和配额页对不上\n#速记", displayTime: "2026-08-12T02:00:00Z" },
        ],
      }));
    let mcpArgs: Record<string, unknown> | undefined;
    world.setMemosMcp(async (url, name, args) => {
      assert.equal(url, "http://127.0.0.1:8002/mcp");
      assert.equal(name, "search_memories");
      mcpArgs = args;
      return {
        structuredContent: {
          results: [{ memory: "vertex 端点没这个问题", memory_view: { occurred_at: "2026-08-20T00:00:00Z" } }],
        },
      };
    });
    let promptSeen = "";
    world.setModelResponse(async () => jsonResponse({ choices: [{ message: { content: "标题：Gemini 429 但配额没超\n现象：429" } }] }));

    assert.equal(
      await world.hook.afterWritten({ text: "gemini 又 429 了", messageId: "om_1", memo: "memos/new" }),
      OFFER_REPLY,
    );

    const result = await world.hook.intercept("1", "om_2");
    assert.ok(result, "1 必须被接管");
    assert.equal(result?.reply, ACK_REPLY);
    assert.ok(result?.followUp, "必须带出稿后续");
    const draft = await result!.followUp!();
    assert.ok(draft.startsWith("标题：Gemini 429 但配额没超"), draft);
    assert.ok(draft.includes("发不发、改不改、贴到哪，你定。"));
    assert.ok(!draft.includes("旧记录检索不可用"), "两个来源都正常时不出降级注");
    assert.deepEqual(world.calls, { model: 1, memosRest: 1, memosMcp: 1 });
    assert.deepEqual(mcpArgs?.cube_ids, ["notes"]);
    assert.equal(mcpArgs?.search_mode, "hybrid");
    promptSeen = String(world.logs.find((entry) => entry.event === "draft_related")?.count);
    assert.equal(promptSeen, "2", "MemOS 1 条 + Memos 1 条（刚写的那条被排除）");
    assert.equal(world.logs.some((entry) => entry.event === "draft_sent"), true);

    // 待出稿已取走：再回 1 → 无待出稿，不出稿
    const again = await world.hook.intercept("1", "om_3");
    assert.equal(again?.reply, NO_PENDING_REPLY);
    assert.equal(again?.followUp, undefined);
    assert.equal(world.calls.model, 1, "不再调模型");
  });
});

test("DraftHook：offer 超过 TTL 后回 1 提示无待出稿；「出稿」也是触发词", async () => {
  await withDir(async (dir) => {
    const configPath = join(dir, "feishu-relay.json");
    await writeConfig(configPath, { draftOffer: true, draftModel: MODEL, draftOfferTtlHours: 1 });
    const world = makeWorld(dir, configPath);

    await world.hook.afterWritten({ text: "报错了", messageId: "om_1", memo: "memos/1" });
    world.clock.now = new Date(world.clock.now.getTime() + 2 * 60 * 60 * 1000);
    const late = await world.hook.intercept("出稿", "om_2");
    assert.equal(late?.reply, NO_PENDING_REPLY);
    assert.equal(world.calls.model, 0);
  });
});

test("DraftHook：「别问了」静音 7 天，期间像坑也不 offer；静音词不写 Memos（被接管）", async () => {
  await withDir(async (dir) => {
    const configPath = join(dir, "feishu-relay.json");
    await writeConfig(configPath, { draftOffer: true, draftModel: MODEL });
    const world = makeWorld(dir, configPath);

    const muted = await world.hook.intercept("别问了", "om_1");
    assert.equal(muted?.reply, "好，7 天内不再问");
    assert.equal(muted?.followUp, undefined);

    world.clock.now = new Date(world.clock.now.getTime() + 3 * 24 * 60 * 60 * 1000);
    assert.equal(await world.hook.afterWritten({ text: "又 429", messageId: "om_2", memo: "memos/2" }), null);
    assert.equal(world.logs.find((entry) => entry.event === "draft_offer_skipped")?.reason, "muted");

    world.clock.now = new Date(world.clock.now.getTime() + 5 * 24 * 60 * 60 * 1000);
    assert.equal(await world.hook.afterWritten({ text: "又 429", messageId: "om_3", memo: "memos/3" }), OFFER_REPLY);
  });
});

test("DraftHook：模型失败 → 「草稿没出来：…」；MemOS 失败 → 草稿照出并注明不可用；Memos 检索失败同理", async () => {
  await withDir(async (dir) => {
    const configPath = join(dir, "feishu-relay.json");
    await writeConfig(configPath, { draftOffer: true, draftModel: MODEL, memosMcpUrl: "http://127.0.0.1:8002/mcp" });
    const world = makeWorld(dir, configPath);

    // 模型 502
    world.setModelResponse(async () => new Response("upstream down", { status: 502 }));
    await world.hook.afterWritten({ text: "429", messageId: "om_1", memo: "memos/1" });
    const failed = await (await world.hook.intercept("1", "om_2"))!.followUp!();
    assert.match(failed, /^草稿没出来：模型 502/u);
    assert.equal(world.logs.some((entry) => entry.event === "draft_failed"), true);

    // MemOS 抛错 + Memos 500：草稿照出，尾注两个不可用
    world.setModelResponse(async () => jsonResponse({ choices: [{ message: { content: "标题：照出" } }] }));
    world.setMemosMcp(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    world.setMemosRestResponse(async () => new Response("boom", { status: 500 }));
    await world.hook.afterWritten({ text: "又 502", messageId: "om_3", memo: "memos/3" });
    const degraded = await (await world.hook.intercept("1", "om_4"))!.followUp!();
    assert.ok(degraded.startsWith("标题：照出"));
    assert.ok(degraded.includes("旧记录检索不可用：MemOS（connect ECONNREFUSED）、Memos（Memos 检索失败 500）"), degraded);

    // 模型返回空正文也算失败
    world.setModelResponse(async () => jsonResponse({ choices: [{ message: { content: "" } }] }));
    world.clock.now = new Date(2026, 8, 7, 10, 0);
    await world.hook.afterWritten({ text: "超时", messageId: "om_5", memo: "memos/5" });
    const empty = await (await world.hook.intercept("1", "om_6"))!.followUp!();
    assert.equal(empty, "草稿没出来：模型返回空正文");
  });
});

test("DraftHook：B 站链接 → 回「已记 · 本周第 N 条」，memoSuffix 追加 #发布，链接优先于关键词", async () => {
  await withDir(async (dir) => {
    const configPath = join(dir, "feishu-relay.json");
    await writeConfig(configPath, { draftOffer: true, draftModel: MODEL });
    const world = makeWorld(dir, configPath);

    assert.equal(world.hook.memoSuffix("发了 https://b23.tv/abc"), "\n#发布");
    assert.equal(world.hook.memoSuffix("普通速记"), "");

    assert.equal(
      await world.hook.afterWritten({ text: "发了 https://b23.tv/abc", messageId: "om_1", memo: "memos/1" }),
      buildPublishedReply(1),
    );
    assert.equal(
      await world.hook.afterWritten({
        text: "发了第二条 https://www.bilibili.com/video/BV1 讲 429 的",
        messageId: "om_2",
        memo: "memos/2",
      }),
      "已记 · 本周第 2 条",
      "含 429 但链接优先，不出 offer",
    );
    assert.equal(world.logs.filter((entry) => entry.event === "draft_offer").length, 0);
    assert.equal(world.logs.filter((entry) => entry.event === "published_recorded").length, 2);
  });
});

test("DraftHook：状态簿目录不可写时内部异常不外抛，回退缺省「已记」", async () => {
  await withDir(async (dir) => {
    const configPath = join(dir, "feishu-relay.json");
    await writeConfig(configPath, { draftOffer: true, draftModel: MODEL });
    const hook = new DraftHook({
      configPath,
      statePath: join(dir, "no-such-dir", "state.json"),
      deps: {
        now: () => new Date(2026, 8, 6),
        fetch,
        log: () => undefined,
        memos: { url: RELAY_BASE.memosUrl, token: RELAY_BASE.memosToken },
      },
    });
    const reply = await hook.afterWritten({ text: "429", messageId: "om_1", memo: "memos/1" });
    assert.equal(reply, null, "save 失败 → 记日志 → 回 null，中继照常「已记」");
    assert.equal(await hook.intercept("别问了", "om_2"), null);
  });
});
