/**
 * TASK-PW-76：Bitable 客户端测试（假 fetch）。
 * 覆盖：配置读取与字段名覆盖 / 关联字段现值合并 / 令牌缓存 / 按键查找请求体 / upsert 新建与更新（关联合并）/
 * 串行写链顺序 / 日期字段两种写法 / writeEvidenceBundle 的调用序列、字段映射与计数 / 失败不吞。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  BitableClient,
  DEFAULT_FIELD_MAP,
  mergeLinkIds,
  readBitableConfig,
  writeEvidenceBundle,
  type BitableDeps,
  type EvidenceBundle,
} from "./pw-feishu-bitable.ts";

type Call = { method: string; url: string; body: Record<string, unknown> | undefined; auth?: string };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** 假开放平台：记录所有调用；search 按 keyValue 命中表返回；create 递增 record_id。 */
function makeFeishu(options: { existingKeys?: Record<string, string>; failCreate?: boolean } = {}) {
  const calls: Call[] = [];
  let tokenCalls = 0;
  let seq = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    calls.push({ method, url, body, auth });
    if (url.endsWith("/tenant_access_token/internal")) {
      tokenCalls += 1;
      return json({ code: 0, tenant_access_token: `t-${tokenCalls}`, expire: 7200 });
    }
    if (url.endsWith("/records/search")) {
      const filter = body?.filter as { conditions: Array<{ value: string[] }> };
      const key = filter.conditions[0].value[0];
      const hit = options.existingKeys?.[key];
      return json({ code: 0, data: { items: hit ? [{ record_id: hit, fields: { 速记: ["recOld"], 主题: [{ record_ids: ["recTopicOld"] }] } }] : [] } });
    }
    if (method === "POST" && url.endsWith("/records")) {
      if (options.failCreate) return json({ code: 1254045, msg: "FieldNameNotFound" }, 400);
      seq += 1;
      return json({ code: 0, data: { record: { record_id: `rec${seq}` } } });
    }
    if (method === "PUT") return json({ code: 0, data: { record: { record_id: url.split("/").pop() } } });
    return json({ code: 99, msg: "unrouted" }, 404);
  };
  return { fetchImpl, calls, tokenCalls: () => tokenCalls };
}

function deps(fetchImpl: typeof fetch, now = new Date(2026, 8, 6, 12, 0)): BitableDeps {
  return { fetch: fetchImpl, now: () => now, log: () => undefined, appId: "cli_x", appSecret: "sec" };
}

const BASE_CONFIG = { appToken: "appTok", baseUrl: "https://t.feishu.cn/", tables: { notes: "tblN", evidence: "tblE", topics: "tblT" } };

test("readBitableConfig：缺表报错 / 字段名覆盖只认已知键 / dateAs / baseUrl 去尾斜杠", () => {
  assert.throws(() => readBitableConfig({ appToken: "a" }), /需要 notes \/ evidence \/ topics/);
  assert.throws(() => readBitableConfig({ tables: BASE_CONFIG.tables }), /appToken 缺失/);
  const c = readBitableConfig({ ...BASE_CONFIG, dateAs: "text", fieldMap: { evidence: { heat: "热度", bogus: "x" }, topics: { key: "键" } } });
  assert.equal(c.fieldMap.evidence.heat, "热度");
  assert.equal(c.fieldMap.evidence.title, DEFAULT_FIELD_MAP.evidence.title);
  assert.equal(c.fieldMap.topics.key, "键");
  assert.equal((c.fieldMap.evidence as Record<string, string>).bogus, undefined);
  assert.equal(c.dateAs, "text");
  assert.equal(c.baseUrl, "https://t.feishu.cn");
  assert.equal(readBitableConfig(BASE_CONFIG).dateAs, "timestamp");
});

test("mergeLinkIds：字符串数组 / 对象数组 / record_ids / link_record_ids / 去重", () => {
  assert.deepEqual(mergeLinkIds(["a", "b"], ["b", "c"]), ["a", "b", "c"]);
  assert.deepEqual(mergeLinkIds([{ record_id: "a" }, { id: "b" }], ["c"]), ["a", "b", "c"]);
  assert.deepEqual(mergeLinkIds([{ record_ids: ["a", "b"] }], ["a"]), ["a", "b"]);
  assert.deepEqual(mergeLinkIds({ link_record_ids: ["z"] }, ["y"]), ["z", "y"]);
  assert.deepEqual(mergeLinkIds(undefined, ["q", ""]), ["q"]);
});

test("BitableClient：令牌缓存 / 查找请求体 / dateValue / tableUrl", async () => {
  const feishu = makeFeishu({ existingKeys: { K1: "recK1" } });
  const client = new BitableClient(readBitableConfig(BASE_CONFIG), deps(feishu.fetchImpl));

  const found = await client.findByField("tblE", "去重键", "K1");
  assert.equal(found?.record_id, "recK1");
  const notFound = await client.findByField("tblE", "去重键", "K2");
  assert.equal(notFound, undefined);
  assert.equal(feishu.tokenCalls(), 1, "两次调用只取一次令牌");
  const search = feishu.calls.find((c) => c.url.endsWith("/records/search"))!;
  assert.equal(search.url, "https://open.feishu.cn/open-apis/bitable/v1/apps/appTok/tables/tblE/records/search");
  assert.deepEqual(search.body, { filter: { conjunction: "and", conditions: [{ field_name: "去重键", operator: "is", value: ["K1"] }] }, page_size: 1 });
  assert.equal(search.auth, "Bearer t-1");

  assert.equal(client.dateValue("2026-09-01T00:00:00Z"), Date.parse("2026-09-01T00:00:00Z"));
  assert.equal(client.dateValue("2026-09-01"), Date.parse("2026-09-01"));
  assert.equal(client.dateValue("not a date"), undefined);
  assert.equal(client.dateValue(undefined), undefined);
  const textClient = new BitableClient(readBitableConfig({ ...BASE_CONFIG, dateAs: "text" }), deps(feishu.fetchImpl));
  assert.equal(textClient.dateValue("2026-09-01T00:00:00Z"), "2026-09-01T00:00:00.000Z");
  assert.equal(client.tableUrl("tblE"), "https://t.feishu.cn/base/appTok?table=tblE");
});

test("BitableClient.upsertByKey：新建带键与关联 / 更新时合并关联现值", async () => {
  const feishu = makeFeishu({ existingKeys: { K1: "recK1" } });
  const client = new BitableClient(readBitableConfig(BASE_CONFIG), deps(feishu.fetchImpl));

  const created = await client.upsertByKey("tblE", "去重键", "K9", { 标题: "t" }, { 速记: ["recN"], 主题: ["recT"] });
  assert.deepEqual(created, { recordId: "rec1", created: true });
  const post = feishu.calls.find((c) => c.method === "POST" && c.url.endsWith("/tblE/records"))!;
  assert.deepEqual(post.body, { fields: { 标题: "t", 去重键: "K9", 速记: ["recN"], 主题: ["recT"] } });

  const updated = await client.upsertByKey("tblE", "去重键", "K1", { 热度分: 70, 摘录: undefined }, { 速记: ["recN2"], 主题: ["recT"] });
  assert.deepEqual(updated, { recordId: "recK1", created: false });
  const put = feishu.calls.find((c) => c.method === "PUT")!;
  assert.ok(put.url.endsWith("/tblE/records/recK1"));
  assert.deepEqual(put.body, { fields: { 热度分: 70, 速记: ["recOld", "recN2"], 主题: ["recTopicOld", "recT"] } }, "undefined 字段被剔除，关联合并去重");
});

test("BitableClient.serial：并发写严格按提交顺序执行，失败不阻断后续", async () => {
  const feishu = makeFeishu();
  const client = new BitableClient(readBitableConfig(BASE_CONFIG), deps(feishu.fetchImpl));
  const order: string[] = [];
  const slow = client.serial(async () => {
    await new Promise((r) => setTimeout(r, 30));
    order.push("slow");
    return "slow";
  });
  const failing = client.serial(async () => {
    order.push("fail");
    throw new Error("boom");
  });
  const fast = client.serial(async () => {
    order.push("fast");
    return "fast";
  });
  await assert.rejects(failing, /boom/);
  assert.equal(await slow, "slow");
  assert.equal(await fast, "fast");
  assert.deepEqual(order, ["slow", "fail", "fast"]);
});

test("writeEvidenceBundle：主题 upsert → 速记 create → 证据逐条 upsert；字段映射与计数；失败抛出", async () => {
  const feishu = makeFeishu({ existingKeys: { "gemini/429": "recTopic", "github:g/p#9": "recEvOld" } });
  const client = new BitableClient(readBitableConfig(BASE_CONFIG), deps(feishu.fetchImpl));
  const bundle: EvidenceBundle = {
    topicKey: "gemini/429",
    note: { text: "gemini 429 【内部】", memo: "memos/abc", at: "2026-09-06T04:00:00Z", queries: ["gemini 429", "配额未超"] },
    evidence: [
      { key: "github:g/p#9", title: "429 RESOURCE_EXHAUSTED", url: "https://github.com/g/p/issues/9", source: "github", tier: "T1", publishedAt: "2026-09-01", quote: "Getting 429", metrics: { comments: 17 }, heat: 72, why: "同样报错" },
      { key: "status:status.cloud.google.com/incidents/g1", title: "Vertex AI elevated errors", url: "https://status.cloud.google.com/incidents/g1", source: "status", tier: "T0", publishedAt: "2026-09-05", quote: "", metrics: {}, heat: 65, why: "" },
    ],
  };
  const result = await writeEvidenceBundle(client, bundle);
  assert.equal(result.topicId, "recTopic", "主题已存在 → 复用");
  assert.equal(result.noteId, "rec1");
  assert.deepEqual(result.evidenceIds, ["recEvOld", "rec2"]);
  assert.equal(result.created, 1);
  assert.equal(result.updated, 1);
  assert.equal(result.tableUrl, "https://t.feishu.cn/base/appTok?table=tblE");

  const writes = feishu.calls.filter((c) => c.method === "POST" && c.url.endsWith("/records") || c.method === "PUT");
  assert.deepEqual(writes.map((c) => `${c.method} ${c.url.split("/tables/")[1]}`), [
    "POST tblN/records",
    "PUT tblE/records/recEvOld",
    "POST tblE/records",
  ]);
  const noteFields = writes[0].body!.fields as Record<string, unknown>;
  assert.equal(noteFields["原文"], "gemini 429 【内部】");
  assert.equal(noteFields["时间"], Date.parse("2026-09-06T04:00:00Z"));
  assert.equal(noteFields["查询词"], "gemini 429, 配额未超");
  assert.equal(noteFields["Memos"], "memos/abc");
  assert.deepEqual(noteFields["主题"], ["recTopic"]);
  assert.equal(noteFields["主题键"], "gemini/429", "速记表冗余主题键文本列");
  const evFields = writes[2].body!.fields as Record<string, unknown>;
  assert.equal(evFields["去重键"], "status:status.cloud.google.com/incidents/g1");
  assert.equal(evFields["层级"], "T0");
  assert.equal(evFields["热度分"], 65);
  assert.equal(evFields["指标JSON"], "{}");
  assert.equal(evFields["摘录"], undefined, "空引言不写");
  assert.deepEqual(evFields["速记"], ["rec1"]);
  assert.deepEqual(evFields["主题"], ["recTopic"]);
  assert.equal(evFields["主题键"], "gemini/429", "证据表冗余主题键文本列");
  const putFields = writes[1].body!.fields as Record<string, unknown>;
  assert.deepEqual(putFields["速记"], ["recOld", "rec1"], "旧证据并入新速记");

  const broken = makeFeishu({ failCreate: true });
  const brokenClient = new BitableClient(readBitableConfig(BASE_CONFIG), deps(broken.fetchImpl));
  await assert.rejects(writeEvidenceBundle(brokenClient, bundle), /FieldNameNotFound/);
});
