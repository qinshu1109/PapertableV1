#!/usr/bin/env node
/**
 * Paperweight 飞书通知最小发送脚本（P0 到达率矩阵用）。
 *
 * 单发：  node pw-feishu-notify.mjs --seq 1
 * 矩阵：  node pw-feishu-notify.mjs --matrix 20 --interval 5
 *
 * 凭证：~/.paperweight/feishu-notify.json
 * 收件人：~/.zcode/v2/bot-config.json 飞书 bot 的 providerUserId（只读）
 * 日志：agent-bridge/out/43-send-log.jsonl
 *
 * 不打印 App Secret。
 * 卡片格式对齐 PW-72 纯文案决定。
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CRED_PATH = join(homedir(), ".paperweight", "feishu-notify.json");
const BOT_CONFIG_PATH = join(homedir(), ".zcode", "v2", "bot-config.json");
const LOG_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "out", "43-send-log.jsonl");

const TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
const MSG_URL = "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id";

function usage() {
  return `用法:
  node pw-feishu-notify.mjs --seq 1
  node pw-feishu-notify.mjs --matrix 20 --interval 5

--interval 仅矩阵模式有效，单位秒，默认 5，最小 1。`;
}

function parsePositiveInt(name, raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${name} 必须是 ≥1 的整数，收到 ${JSON.stringify(raw)}`);
  }
  return n;
}

function parseArgs(argv) {
  const out = { seq: null, matrix: null, interval: 5, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
    const take = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 需要一个值`);
      return v;
    };
    if (a === "--seq") out.seq = parsePositiveInt("--seq", take());
    else if (a === "--matrix") out.matrix = parsePositiveInt("--matrix", take());
    else if (a === "--interval") out.interval = parsePositiveInt("--interval", take());
    else throw new Error(`未知参数 ${a}`);
  }
  if (out.help) return out;
  if (out.seq && out.matrix) throw new Error("不要同时传 --seq 和 --matrix");
  if (!out.seq && !out.matrix) throw new Error("需要 --seq 或 --matrix\n" + usage());
  if (out.interval < 1) out.interval = 1;
  return out;
}

function buildCard(seq) {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: `[测试] 押注候选 #${seq}` },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "plain_text",
          content: "为什么现在出现：到期窗口：B 站首场直播押注进入结账期",
        },
      },
      {
        tag: "div",
        text: {
          tag: "plain_text",
          content:
            "原文证据：「第一场直播别再加功能了，先把能跑的演示挂出去。假红灯不挡出门。」",
        },
      },
      {
        tag: "div",
        text: {
          tag: "plain_text",
          content: "回电脑端镇纸押注台处置",
        },
      },
    ],
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function feishuOpenId(botConfig) {
  const bots = Array.isArray(botConfig.bots) ? botConfig.bots : [];
  const hit = bots.find((b) => b && b.provider === "feishu" && b.providerUserId);
  if (!hit) throw new Error(`${BOT_CONFIG_PATH} 没有飞书 providerUserId（只读排查，未写入）`);
  return hit.providerUserId;
}

async function postJson(url, payload, headers) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { msg: text.slice(0, 200) };
  }
  return { httpStatus: res.status, body };
}

async function tenantToken(appId, appSecret) {
  const { httpStatus, body } = await postJson(TOKEN_URL, {
    app_id: appId,
    app_secret: appSecret,
  });
  if (httpStatus !== 200 || body.code !== 0 || !body.tenant_access_token) {
    throw new Error(`tenant_access_token 失败 http=${httpStatus} code=${body.code} msg=${body.msg}`);
  }
  return body.tenant_access_token;
}

async function sendOne({ token, openId, seq }) {
  const { httpStatus, body } = await postJson(
    MSG_URL,
    {
      receive_id: openId,
      msg_type: "interactive",
      content: JSON.stringify(buildCard(seq)),
    },
    { Authorization: `Bearer ${token}` },
  );
  return {
    seq,
    sent_at: new Date().toISOString(),
    http_status: httpStatus,
    api_code: body.code ?? null,
    message_id: body.data?.message_id ?? null,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const cred = await readJson(CRED_PATH);
  if (!cred.app_id || !cred.app_secret) {
    throw new Error(`${CRED_PATH} 缺 app_id 或 app_secret`);
  }
  const openId = feishuOpenId(await readJson(BOT_CONFIG_PATH));
  const token = await tenantToken(cred.app_id, cred.app_secret);

  const seqs = args.matrix
    ? Array.from({ length: args.matrix }, (_, i) => i + 1)
    : [args.seq];
  const intervalMs = args.interval * 1000;

  await mkdir(dirname(LOG_PATH), { recursive: true });

  let failed = 0;
  for (let i = 0; i < seqs.length; i++) {
    const row = await sendOne({ token, openId, seq: seqs[i] });
    await appendFile(LOG_PATH, `${JSON.stringify(row)}\n`, "utf8");
    console.log(JSON.stringify(row));
    if (row.http_status !== 200 || row.api_code !== 0) failed += 1;
    if (i < seqs.length - 1) await sleep(intervalMs);
  }
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
