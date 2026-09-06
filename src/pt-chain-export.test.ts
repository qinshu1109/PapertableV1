import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDataStore, type DataStore } from "./data.ts";
import { exportChainToMemos, generateChainSummary, parseChainSummary } from "./pt-chain-export.ts";
import { ensurePwRunTables } from "./pw-runs.ts";
import { ensureVerdictTables } from "./verdicts.ts";

async function fixture(): Promise<DataStore> {
  const store = openDataStore(await mkdtemp(join(tmpdir(), "pt-chain-")));
  ensureVerdictTables(store.db);
  ensurePwRunTables(store.db);
  store.db.prepare("INSERT INTO pt_projects VALUES('p1','选题实验','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z')").run();
  store.db.prepare("INSERT INTO pt_cards(id,project_id,session_id,title,branch_kind,source_card_id,branch_context_json,created_at,updated_at) VALUES('c1','p1','s1','根问题','root',NULL,NULL,'2026-08-01T00:00:00Z','2026-08-01T00:00:00Z')").run();
  store.db.prepare("INSERT INTO pt_runs(id,project_id,card_id,question,status,result,reason,scope_json,previous_leaf_id,answer,error,created_at,ended_at) VALUES('r1','p1','c1','怎样选题？','ended','ok',NULL,'{}',NULL,'先验证收藏',NULL,'2026-08-01T00:00:00Z','2026-08-01T00:01:00Z')").run();
  store.db.prepare("INSERT INTO pt_verdicts(id,project_id,card_id,run_id,kind,text,status,memos_status,created_at,updated_at) VALUES('v1','p1','c1','r1','gold','收藏是硬门槛','confirmed','pending','2026-08-01T00:02:00Z','2026-08-01T00:02:00Z')").run();
  return store;
}

test("chain summary：读全链并生成带标签、日期和回链的结构化草稿", async () => {
  const store = await fixture();
  let prompt = "";
  const value = await generateChainSummary(store, "p1", {
    now: new Date("2026-08-11T00:00:00Z"),
    llm: async (input) => {
      prompt = input;
      return JSON.stringify({ question: "怎样选题？", branches: [{ at: "第一轮", kind: "reroute", label: "改看收藏" }], golds: ["收藏是硬门槛"], tombstones: [], conclusion: "先验证收藏" });
    },
  });
  assert.match(prompt, /收藏是硬门槛/);
  assert.equal(value.projectName, "选题实验");
  assert.match(value.markdown, /#决策链/);
  assert.match(value.markdown, /生成日期：2026-08-11/);
  assert.match(value.markdown, /papertable:\/\/projects\/p1/);
  store.db.close();
});

test("chain summary 解析：围栏、散文前后缀与缺 markdown 兜底", async () => {
  const json = JSON.stringify({ question: "问题", branches: [], golds: [], tombstones: [], conclusion: "结论" });
  assert.equal(parseChainSummary(`\`\`\`json\n${json}\n\`\`\``).question, "问题");
  assert.equal(parseChainSummary(`下面是结果：\n${json}\n以上。`).conclusion, "结论");

  const store = await fixture();
  const value = await generateChainSummary(store, "p1", {
    now: new Date("2026-08-12T00:00:00Z"),
    llm: async () => json,
  });
  assert.match(value.markdown, /#决策链/);
  assert.match(value.markdown, /## 结论\n结论/);
  store.db.close();
});

test("chain summary：首次解析失败重试成功；两次仍败返回含 120 字摘要的 502", async () => {
  const firstStore = await fixture();
  let calls = 0;
  const recovered = await generateChainSummary(firstStore, "p1", {
    llm: async (_prompt, retry) => {
      calls += 1;
      assert.equal(retry, calls === 2);
      return retry ? JSON.stringify({ question: "重试成功", branches: [], golds: [], tombstones: [], conclusion: "好" }) : "不是 JSON";
    },
  });
  assert.equal(calls, 2);
  assert.equal(recovered.question, "重试成功");
  firstStore.db.close();

  const secondStore = await fixture();
  const bad = `诊断前缀${"坏".repeat(150)}`;
  await assert.rejects(
    generateChainSummary(secondStore, "p1", { llm: async () => bad }),
    (error: Error & { status?: number }) => error.status === 502
      && error.message.includes("诊断前缀")
      && [...error.message.split("：").at(-1)!].length === 120,
  );
  secondStore.db.close();
});

test("chain export：官方 API 成功写 PRIVATE；同项目同 Markdown 复用且只写一条审计", async () => {
  const store = await fixture();
  let calls = 0;
  const server = createServer((request, response) => {
    calls += 1;
    assert.equal(request.url, "/api/v1/memos");
    assert.equal(request.headers.authorization, "Bearer secret");
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      assert.deepEqual(JSON.parse(raw), { content: "# 人改后的成稿", visibility: "PRIVATE" });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ name: "memos/42" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const configPath = join(store.dataDir, "relay.json");
  await writeFile(configPath, JSON.stringify({ memosUrl: `http://127.0.0.1:${address.port}`, memosToken: "secret" }));
  const first = await exportChainToMemos(store.db, "p1", "# 人改后的成稿", { configPath });
  const second = await exportChainToMemos(store.db, "p1", "# 人改后的成稿", { configPath });
  assert.deepEqual(first, { memoUrl: `http://127.0.0.1:${address.port}/m/42`, memoUid: "42", reused: false });
  assert.equal(second.reused, true);
  assert.equal(calls, 1);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM pw_runs WHERE kind='pt_chain_export'").get() as { n: number }).n, 1);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.db.close();
});

test("chain export：无配置 501；Memos 不可达或错误响应统一 502", async () => {
  const store = await fixture();
  await assert.rejects(exportChainToMemos(store.db, "p1", "x", { configPath: join(store.dataDir, "missing.json") }), (error: Error & { status?: number }) => error.status === 501 && /配置不可用/.test(error.message));
  const configPath = join(store.dataDir, "relay.json");
  await writeFile(configPath, JSON.stringify({ memosUrl: "http://memos.invalid", memosToken: "secret" }));
  await assert.rejects(exportChainToMemos(store.db, "p1", "x", { configPath, fetchImpl: async () => new Response("down", { status: 503 }) }), (error: Error & { status?: number }) => error.status === 502 && /503/.test(error.message));
  await assert.rejects(exportChainToMemos(store.db, "p1", "y", { configPath, fetchImpl: async () => { throw new Error("timeout"); } }), (error: Error & { status?: number }) => error.status === 502 && /timeout/.test(error.message));
  store.db.close();
});
