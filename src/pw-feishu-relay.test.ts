/**
 * TASK-PW-52：飞书速记输入口纯函数测试（SDK 接线部分不做单测，规格如此）。
 * 覆盖：buildMemoContent（挂标签/不挂/空标签/原文逐字）、SeenIds（去重命中、封顶淘汰最旧、
 * 坏文件兜底空集、落盘往返）、loadRelayConfig（四必填字段逐项缺失报错、合法通过、
 * defaultTag 缺省「速记」、0600 权限校验）。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildMemoContent, extractReceiveMessage, loadRelayConfig, SeenIds } from "./pw-feishu-relay.ts";

/** 合法配置（四必填 + defaultTag 缺省场景由用例覆盖）。 */
function validConfig(): Record<string, string> {
  return {
    appId: "cli_test",
    appSecret: "secret",
    memosUrl: "http://127.0.0.1:5230",
    memosToken: "memos-token",
  };
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pw-feishu-relay-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("buildMemoContent：挂标签 / 不挂 / 空标签 / 原文不动逐字", () => {
  // 挂标签：原文逐字 + 换行 + #标签
  assert.equal(buildMemoContent("试试：今天想到一个选题", "速记"), "试试：今天想到一个选题\n#速记");
  // 原文逐字：内部空格、首尾空白都不动（trim 在消息处理层，不在这里）
  assert.equal(buildMemoContent("  有空格  的原文  ", "速记"), "  有空格  的原文  \n#速记");
  // 空字符串 defaultTag = 不挂标签
  assert.equal(buildMemoContent("试试", ""), "试试");
  // 空白 defaultTag = 不挂标签
  assert.equal(buildMemoContent("试试", "   "), "试试");
  // 不挂标签时原文也逐字不动
  assert.equal(buildMemoContent(" 原文 不动 ", ""), " 原文 不动 ");
});

test("SeenIds：去重命中 / 封顶淘汰最旧 / 坏文件兜底空集 / 落盘往返", async () => {
  await withDir(async (dir) => {
    const seenPath = join(dir, "feishu-relay-seen.json");
    const seen = new SeenIds(seenPath);

    // 坏文件 / 缺文件 load 兜底空集
    await writeFile(seenPath, "{ not json", "utf8");
    seen.load();
    assert.equal(seen.size, 0, "坏文件 load 应兜底空集");
    assert.equal(seen.has("m-1"), false);

    // 去重命中：add 后 has 为真，重复 add 不涨
    seen.add("m-1");
    assert.equal(seen.has("m-1"), true);
    seen.add("m-1");
    assert.equal(seen.size, 1, "重复 add 应为 no-op");

    // 封顶淘汰最旧：cap=3 时第 4 条挤掉最旧的 m-1
    const tiny = new SeenIds(join(dir, "tiny.json"), 3);
    tiny.load();
    tiny.add("a");
    tiny.add("b");
    tiny.add("c");
    tiny.add("d");
    assert.deepEqual(tiny.all, ["b", "c", "d"], "超出封顶应淘汰最旧（数组头部）");
    assert.equal(tiny.has("a"), false);

    // 落盘往返：save 后新实例 load 能还原，且 seen 文件 0600
    seen.save();
    const reloaded = new SeenIds(seenPath);
    reloaded.load();
    assert.deepEqual(reloaded.all, ["m-1"]);
    assert.equal(reloaded.has("m-1"), true);
  });
});

test("loadRelayConfig：四必填字段逐项缺失报错 / 合法通过 / defaultTag 缺省「速记」/ 0600 校验", async () => {
  await withDir(async (dir) => {
    const configPath = join(dir, "feishu-relay.json");

    // 合法配置通过（0600）
    await writeFile(configPath, JSON.stringify(validConfig()), { encoding: "utf8", mode: 0o600 });
    const ok = loadRelayConfig(configPath);
    assert.deepEqual(ok, {
      appId: "cli_test",
      appSecret: "secret",
      memosUrl: "http://127.0.0.1:5230",
      memosToken: "memos-token",
      defaultTag: "速记",
    });

    // 四必填字段逐项缺失报错（人话带字段名）
    for (const field of ["appId", "appSecret", "memosUrl", "memosToken"]) {
      const broken = { ...validConfig() };
      delete broken[field];
      await writeFile(configPath, JSON.stringify(broken), { encoding: "utf8", mode: 0o600 });
      assert.throws(
        () => loadRelayConfig(configPath),
        new RegExp(`feishu-relay\\.json 缺 ${field}`),
        `缺 ${field} 应报错`,
      );
    }

    // 必填字段为空串同样报错
    await writeFile(
      configPath,
      JSON.stringify({ ...validConfig(), memosToken: "   " }),
      { encoding: "utf8", mode: 0o600 },
    );
    assert.throws(() => loadRelayConfig(configPath), /缺 memosToken/);

    // defaultTag 显式给值（含空字符串=不挂标签）生效
    await writeFile(
      configPath,
      JSON.stringify({ ...validConfig(), defaultTag: "" }),
      { encoding: "utf8", mode: 0o600 },
    );
    assert.equal(loadRelayConfig(configPath).defaultTag, "");
    await writeFile(
      configPath,
      JSON.stringify({ ...validConfig(), defaultTag: " 灵感 收集 " }),
      { encoding: "utf8", mode: 0o600 },
    );
    assert.equal(loadRelayConfig(configPath).defaultTag, "灵感 收集");

    // 非字符串 defaultTag 报错
    await writeFile(
      configPath,
      JSON.stringify({ ...validConfig(), defaultTag: 42 }),
      { encoding: "utf8", mode: 0o600 },
    );
    assert.throws(() => loadRelayConfig(configPath), /defaultTag 必须是字符串/);

    // 0600 读取校验：组/其他可读（0644）拒绝（先删旧文件，mode 只对新建生效）
    await rm(configPath, { force: true });
    await writeFile(configPath, JSON.stringify(validConfig()), { encoding: "utf8", mode: 0o644 });
    assert.throws(() => loadRelayConfig(configPath), /权限过宽/);

    // 文件不存在 → 人话报错带路径
    assert.throws(() => loadRelayConfig(join(dir, "no-such.json")), /feishu-relay\.json 不存在/);

    // 非 JSON 内容 → 人话报错
    await writeFile(configPath, "not json", { encoding: "utf8", mode: 0o600 });
    assert.throws(() => loadRelayConfig(configPath), /无法解析/);
  });
});

test("extractReceiveMessage：信封 / 直连 / msg_type 旧字段 / 空数据（2026-08-10 真实事件踩坑回归）", () => {
  const msg = { message_id: "om_1", chat_type: "p2p", message_type: "text", content: '{"text":"hi"}' };
  // 信封形状 {event:{message}}
  assert.equal(extractReceiveMessage({ event: { message: msg } })?.message_id, "om_1");
  // 直连形状 {message}（部分 SDK 版本剥信封）
  assert.equal(extractReceiveMessage({ message: msg })?.chat_type, "p2p");
  // 信封优先
  assert.equal(
    extractReceiveMessage({ event: { message: msg }, message: { message_id: "om_other" } })?.message_id,
    "om_1",
  );
  // 空数据不炸
  assert.equal(extractReceiveMessage({}), undefined);
  assert.equal(extractReceiveMessage(null), undefined);
});
