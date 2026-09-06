/**
 * TASK-PW-76：搜证挂点测试。
 * 覆盖：loadEvidenceConfig（缺省关闭 / 缺模型关闭 / 缺表关闭 / 合法开启 / 根级密钥别名 / provider 小写）/
 * RunCounter 日上限与换日 / buildReceipt 文案 / EvidenceHook.onNote（关闭零调用 / 正常回执 / 跳过静默 /
 * 搜证抛错回「搜证失败」/ 落表失败附注 / 日上限）。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CollectorResult } from "./pw-evidence-collector.ts";
import { buildReceipt, EvidenceHook, loadEvidenceConfig, RunCounter } from "./pw-evidence-hook.ts";
import type { WriteBundleResult } from "./pw-feishu-bitable.ts";

const RELAY_BASE = { appId: "cli_test", appSecret: "secret", memosUrl: "http://127.0.0.1:5230", memosToken: "tok" };
const EVIDENCE_OK = {
  enabled: true,
  model: { baseUrl: "https://cozai.test/v1/", apiKey: "sk-m", model: "glm-5.3-flash", extraBody: { reasoning_effort: "low" } },
  bitable: { appToken: "app", baseUrl: "https://t.feishu.cn", tables: { notes: "n", evidence: "e", topics: "t" } },
};

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pw-evidence-hook-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeConfig(path: string, root: Record<string, unknown>): Promise<void> {
  await rm(path, { force: true });
  await writeFile(path, JSON.stringify({ ...RELAY_BASE, ...root }), { encoding: "utf8", mode: 0o600 });
}

function result(overrides: Partial<CollectorResult> = {}): CollectorResult {
  return {
    skipped: false,
    redactedNote: "gemini 429",
    hardRedactions: 0,
    topicKey: "gemini/429",
    queries: ["gemini 429"],
    evidence: [
      { key: "github:g/p#9", url: "https://github.com/g/p/issues/9", title: "429 RESOURCE_EXHAUSTED", source: "github", tier: "T1", publishedAt: "2026-09-01", quote: "q", quoteVerified: true, metrics: { comments: 17 }, heat: 72, why: "w" },
      { key: "status:x", url: "https://status.cloud.google.com/incidents/g1", title: "Vertex AI elevated errors", source: "status", tier: "T0", quote: "", quoteVerified: false, metrics: {}, heat: 65, why: "" },
    ],
    summary: "s",
    stats: { toolCalls: 2, toolErrors: 0, urlsSeen: 5, droppedUnknownUrl: 0, quotesCleared: 0, ms: 4200 },
    ...overrides,
  };
}

const WRITE_OK: WriteBundleResult = { topicId: "recT", noteId: "recN", evidenceIds: ["a", "b"], created: 1, updated: 1, tableUrl: "https://t.feishu.cn/base/app?table=e" };

test("loadEvidenceConfig：缺省关闭 / 缺模型 / 缺表 / 合法开启含根级密钥别名与 provider 小写", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "feishu-relay.json");

    await writeConfig(path, {});
    assert.match(loadEvidenceConfig(path).disabledReason ?? "", /evidence 段缺失/);

    await writeConfig(path, { evidence: { enabled: false } });
    assert.match(loadEvidenceConfig(path).disabledReason ?? "", /未开启/);

    await writeConfig(path, { evidence: { enabled: true, bitable: EVIDENCE_OK.bitable } });
    assert.match(loadEvidenceConfig(path).disabledReason ?? "", /evidence.model 缺/);

    await writeConfig(path, { evidence: { enabled: true, model: EVIDENCE_OK.model } });
    assert.match(loadEvidenceConfig(path).disabledReason ?? "", /bitable 配置必须是对象/);

    await writeConfig(path, {
      exaApiKey: "exa-root",
      twitterApiIoKey: "x-root",
      evidence: { ...EVIDENCE_OK, statusProviders: { OpenAI: "https://status.openai.com/api/v2/incidents.json" }, denyTerms: ["p1", ""], maxRunsPerDay: 5, receipt: { silentWhenEmpty: true } },
    });
    const c = loadEvidenceConfig(path);
    assert.equal(c.enabled, true);
    assert.equal(c.collector.model.baseUrl, "https://cozai.test/v1", "去尾斜杠");
    assert.deepEqual(c.collector.model.extraBody, { reasoning_effort: "low" });
    assert.equal(c.collector.exaApiKey, "exa-root", "根级别名");
    assert.equal(c.collector.xApiKey, "x-root");
    assert.deepEqual(Object.keys(c.collector.statusProviders), ["openai"]);
    assert.deepEqual(c.collector.denyTerms, ["p1"]);
    assert.equal(c.maxRunsPerDay, 5);
    assert.equal(c.silentWhenSkipped, true);
    assert.equal(c.silentWhenEmpty, true);
    assert.equal(c.bitable.tables.evidence, "e");

    await writeFile(path, "{ broken", "utf8");
    assert.match(loadEvidenceConfig(path).disabledReason ?? "", /配置读取失败/);
  });
});

test("RunCounter：日上限与换日归零；坏文件兜底", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "state.json");
    await writeFile(path, "{bad", "utf8");
    const counter = new RunCounter(path);
    counter.load();
    const d1 = new Date(2026, 8, 6, 9, 0);
    assert.equal(counter.take(d1, 2), true);
    assert.equal(counter.take(d1, 2), true);
    assert.equal(counter.take(d1, 2), false);
    assert.equal(counter.runsToday(d1), 2);
    const d2 = new Date(2026, 8, 7, 0, 1);
    assert.equal(counter.take(d2, 2), true);
    assert.equal(counter.runsToday(d2), 1);
    const reloaded = new RunCounter(path);
    reloaded.load();
    assert.equal(reloaded.runsToday(d2), 1, "落盘往返");
  });
});

test("buildReceipt：铁证计数分源 / 最热 / 脱敏 / 表计数与链接 / 主题；零证据形态", () => {
  const withWrite = buildReceipt(result({ hardRedactions: 2 }), WRITE_OK);
  assert.equal(
    withWrite,
    "铁证 2 · 状态页 1 · GitHub 1 · 最热：429 RESOURCE_EXHAUSTED（72）https://github.com/g/p/issues/9 · 脱敏 2 处 · 表 +1/~1 · https://t.feishu.cn/base/app?table=e · 主题 gemini/429",
  );
  assert.equal(buildReceipt(result({ evidence: [] })), "铁证 0 · 主题 gemini/429");
});

test("EvidenceHook.onNote：关闭零调用 / 正常回执 / 跳过静默 / 搜证抛错 / 落表失败附注 / 日上限", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "feishu-relay.json");
    const replies: Array<{ id: string; text: string }> = [];
    const calls = { collect: 0, write: 0 };
    let collectImpl: () => Promise<CollectorResult> = async () => result();
    let writeImpl: () => Promise<WriteBundleResult> = async () => WRITE_OK;
    const hook = new EvidenceHook(path, {
      fetch: async () => {
        throw new Error("网络不该被碰");
      },
      now: () => new Date(2026, 8, 6, 12, 0),
      log: () => undefined,
      appId: "cli_test",
      appSecret: "secret",
      reply: async (id, text) => {
        replies.push({ id, text });
      },
      collect: async () => {
        calls.collect += 1;
        return collectImpl();
      },
      write: async () => {
        calls.write += 1;
        return writeImpl();
      },
    });

    // 关闭：什么都不发生
    await writeConfig(path, { evidence: { ...EVIDENCE_OK, enabled: false } });
    assert.deepEqual(await hook.onNote({ text: "gemini 429", messageId: "m0", memo: "memos/0" }), { status: "disabled" });
    assert.deepEqual(calls, { collect: 0, write: 0 });
    assert.equal(hook.summary().enabled, false);

    // 开启：搜证 → 落表 → 回执
    await writeConfig(path, { evidence: { ...EVIDENCE_OK, maxRunsPerDay: 3 } });
    assert.equal(hook.summary().enabled, true);
    const ok = await hook.onNote({ text: "gemini 429", messageId: "m1", memo: "memos/1" });
    assert.equal(ok.status, "ok");
    assert.deepEqual(calls, { collect: 1, write: 1 });
    assert.equal(replies.length, 1);
    assert.equal(replies[0].id, "m1");
    assert.ok(replies[0].text.startsWith("铁证 2 · 状态页 1 · GitHub 1 · 最热："), replies[0].text);

    // 跳过：缺省静默
    collectImpl = async () => result({ skipped: true, reason: "个人待办", evidence: [] });
    assert.equal((await hook.onNote({ text: "买牛奶", messageId: "m2", memo: "memos/2" })).status, "skipped");
    assert.equal(replies.length, 1, "静默不回");
    assert.equal(calls.write, 1, "跳过不落表");

    // 搜证抛错 → 回「搜证失败」
    collectImpl = async () => {
      throw new Error("模型 502");
    };
    assert.equal((await hook.onNote({ text: "x 429", messageId: "m3", memo: "memos/3" })).status, "failed");
    assert.equal(replies.at(-1)?.text, "搜证失败：模型 502");

    // 日上限（maxRunsPerDay=3，已用 3 次）
    collectImpl = async () => result();
    assert.equal((await hook.onNote({ text: "x 429", messageId: "m4", memo: "memos/4" })).status, "daily_cap");
    assert.equal(calls.collect, 3);

    // 落表失败：仍回执，附注失败原因
    await writeConfig(path, { evidence: { ...EVIDENCE_OK, maxRunsPerDay: 100 } });
    writeImpl = async () => {
      throw new Error("FieldNameNotFound");
    };
    const wf = await hook.onNote({ text: "x 429", messageId: "m5", memo: "memos/5" });
    assert.equal(wf.status, "written_failed");
    assert.ok(replies.at(-1)?.text.endsWith("· 落表失败：FieldNameNotFound"), replies.at(-1)?.text);
    assert.equal(hook.inflightCount, 0);
  });
});
