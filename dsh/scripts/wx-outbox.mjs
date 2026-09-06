#!/usr/bin/env node
/**
 * wx-outbox — 微信 outbox 推送记账 CLI（简报 28 · WS3）
 * ------------------------------------------------------------
 * 本机 JSONL 账本 + 推送记账 + 查询/重试入口。纯 node（v24），零第三方依赖。
 *
 * 账本文件（默认）：$HOME/.dsh/wechat-outbox/outbox.jsonl
 *   每行一个 JSON 对象，字段固定顺序：
 *     id / created_at / target / content / status(pending|sent|failed)
 *     / attempts / last_error / sent_at
 *   id 形如 ob-20260815T111500-3f2a（UTC 时间戳 + 随机后缀）。
 *   可用环境变量 OUTBOX_PATH 覆盖账本路径（测试与正式分离）。
 *
 * 发送器抽象（发送通道未接好，通过命令模板注入）：
 *   环境变量 WX_OUTBOX_SENDER 指定发送命令模板，例如：
 *     WX_OUTBOX_SENDER="node /Users/qinshu/.dsh/wechat-outbox/tests/fake-sender.mjs"
 *   实际调用：<WX_OUTBOX_SENDER> --target <target> --content-file <临时文件>
 *   —— 内容写进临时文件传参（避免命令行 UTF-8/长度问题，参考 dsh-wechat-notify 既有结论）。
 *   退出码 0 = 成功；非 0 = 失败，stderr（空则 stdout）首行记为 last_error。
 *   WX_OUTBOX_SENDER 未设置时，fallback 尝试：
 *     openclaw message send --channel <WX_OUTBOX_OPENCLAW_CHANNEL|openclaw-weixin>
 *                           --target <target> -m <content>
 *     （已按本机 openclaw 2026.7.1-2 实际 CLI 适配：recipient 用 --target、消息体用 -m，
 *       该版本无 --content-file 选项、channel 列表亦无 weixin——发送通道未接好属预期；
 *       等真实通道就绪后应设置 WX_OUTBOX_SENDER 指向真实发送器。）
 *   fallback 命令找不到时记 failed，last_error 注明 "sender not configured"。
 *
 * 子命令：
 *   wx-outbox push --target <微信target 形如 xxx@im.wechat> --content <文本>
 *       先写 pending 行 → 调发送器 → 按结果改 sent（带 sent_at）/ failed（带 last_error，attempts 自增）。输出该行 JSON。
 *   wx-outbox list [--status pending|sent|failed] [--limit N]
 *       列出匹配行，JSON 数组输出（便于 agent 解析）。
 *   wx-outbox retry <id>
 *       把 failed/pending 行重发：attempts+1 → 先改 pending → 发送 → 按结果改 sent/failed。找不到 id 报错。
 *   wx-outbox stats
 *       按 status 计数，JSON 对象输出。
 *   所有子命令均输出稳定 JSON，显式传 --json 亦被接受（保证机器可解析）。
 *
 * 并发/原子性：
 *   新行用 append（'a' 模式 + 写后 fsync）。
 *   更新行：读全文件 → 替换目标行（其他行字节原样保留）→ 写临时文件 + rename 原子换入。
 *   不做文件锁：单机单进程足够（MVP 约定，注释即文档）。
 *
 * 退出码：0 成功；1 用法错误/找不到行；2 发送失败/记账失败（行已按结果记账）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const OUTBOX_DEFAULT = path.join(os.homedir(), '.dsh', 'wechat-outbox', 'outbox.jsonl');
const OUTBOX_PATH = process.env.OUTBOX_PATH || OUTBOX_DEFAULT;
const SENDER_TIMEOUT_MS = Number(process.env.WX_OUTBOX_SENDER_TIMEOUT_MS || 60000);

const STATUS_PENDING = 'pending';
const STATUS_SENT = 'sent';
const STATUS_FAILED = 'failed';
const VALID_STATUSES = [STATUS_PENDING, STATUS_SENT, STATUS_FAILED];

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const ts =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  const suffix = Math.random().toString(16).slice(2, 6).padEnd(4, '0');
  return `ob-${ts}-${suffix}`;
}

function failExit(msg) {
  process.stderr.write(`wx-outbox: ${msg}\n`);
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* 账本读写（append + 原子替换，无锁）                                   */
/* ------------------------------------------------------------------ */

function ensureOutboxParent() {
  fs.mkdirSync(path.dirname(OUTBOX_PATH), { recursive: true });
}

/** 追加一行（'a' 模式 + fsync flush）。 */
function appendRow(row) {
  ensureOutboxParent();
  const fd = fs.openSync(OUTBOX_PATH, 'a');
  try {
    fs.writeSync(fd, JSON.stringify(row) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** 读全部行；损坏行按原样保留并跳过解析。 */
function readRows() {
  if (!fs.existsSync(OUTBOX_PATH)) return [];
  const text = fs.readFileSync(OUTBOX_PATH, 'utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      rows.push(null); // 占位：写回时原样保留
    }
  }
  return rows;
}

/** 按 id 替换一行：仅替换目标行，其余字节原样；临时文件 + rename 原子写回。 */
function updateRowById(id, mutate) {
  if (!fs.existsSync(OUTBOX_PATH)) failExit(`row not found: ${id} (outbox does not exist)`);
  const text = fs.readFileSync(OUTBOX_PATH, 'utf8');
  const lines = text.split('\n');
  let found = false;
  const out = lines.map((line) => {
    if (line.trim() === '') return line;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return line; // 损坏行原样保留
    }
    if (row.id === id) {
      found = true;
      mutate(row);
      return JSON.stringify(row);
    }
    return line;
  });
  if (!found) failExit(`row not found: ${id}`);

  ensureOutboxParent();
  const tmp = path.join(
    path.dirname(OUTBOX_PATH),
    `.outbox.tmp.${process.pid}.${Math.random().toString(16).slice(2, 8)}`,
  );
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, out.join('\n'));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, OUTBOX_PATH);
}

/** 按固定字段顺序构造行对象（保证 JSON 输出稳定）。 */
function buildRow({ id, created_at, target, content, status, attempts, last_error, sent_at }) {
  return {
    id,
    created_at,
    target,
    content,
    status,
    attempts,
    last_error: last_error ?? null,
    sent_at: sent_at ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* 发送器                                                              */
/* ------------------------------------------------------------------ */

/** 把命令模板（如 "node /path/x.mjs"）按空白拆成 argv（不走 shell）。 */
function senderArgv(template) {
  return template.trim().split(/\s+/).filter(Boolean);
}

/**
 * 执行一次发送。返回 { ok: true } 或 { ok: false, error }。
 * error 取 stderr 首行；stderr 为空则取 stdout 首行。
 */
function runSender(target, content) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-outbox-'));
  const contentFile = path.join(tmpDir, 'content.txt');
  const mode = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC;
  const fd = fs.openSync(contentFile, mode, 0o600);
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  try {
    let argv = null;
    let configured = Boolean(process.env.WX_OUTBOX_SENDER);
    if (configured) {
      argv = [...senderArgv(process.env.WX_OUTBOX_SENDER), '--target', target, '--content-file', contentFile];
    } else {
      const channel = process.env.WX_OUTBOX_OPENCLAW_CHANNEL || 'openclaw-weixin';
      argv = ['openclaw', 'message', 'send', '--channel', channel, '--target', target, '-m', content];
    }

    const res = spawnSync(argv[0], argv.slice(1), {
      encoding: 'utf8',
      timeout: SENDER_TIMEOUT_MS,
    });

    if (res.error) {
      // ENOENT 等：命令本身找不到
      if (!configured) {
        return { ok: false, error: `sender not configured (fallback '${argv[0]}' not found: ${res.error.message})` };
      }
      return { ok: false, error: `sender invocation failed: ${res.error.message}` };
    }
    if (res.signal) {
      return { ok: false, error: `sender killed by signal ${res.signal}` };
    }
    if (res.status === 0) return { ok: true };
    const firstLine = (res.stderr || res.stdout || '').trim().split('\n')[0] || `sender exited with code ${res.status}`;
    return { ok: false, error: firstLine };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** 发送并按结果记账：成功 → sent+sent_at；失败 → failed+last_error。attempts 自增。 */
function sendAndRecord(row) {
  const res = runSender(row.target, row.content);
  if (res.ok) {
    row.status = STATUS_SENT;
    row.sent_at = nowIso();
    row.last_error = null;
  } else {
    row.status = STATUS_FAILED;
    row.last_error = res.error;
  }
  row.attempts += 1;
}

/* ------------------------------------------------------------------ */
/* 子命令实现                                                          */
/* ------------------------------------------------------------------ */

function cmdPush(args) {
  let target = null;
  let content = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--target') target = args[++i] ?? null;
    else if (a === '--content') content = args[++i] ?? null;
    else if (a === '--json') { /* 默认即 JSON，显式接受 */ }
    else failExit(`unknown option for push: ${a}`);
  }
  if (!target) failExit('push requires --target <微信target>');
  if (!content) failExit('push requires --content <文本>');

  const row = buildRow({
    id: newId(),
    created_at: nowIso(),
    target,
    content,
    status: STATUS_PENDING,
    attempts: 0,
    last_error: null,
    sent_at: null,
  });
  appendRow(row); // 先记 pending
  sendAndRecord(row); // 按结果改 sent/failed
  updateRowById(row.id, (r) => Object.assign(r, row));
  process.stdout.write(JSON.stringify(row) + '\n');
}

function cmdList(args) {
  let status = null;
  let limit = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--status') {
      status = args[++i] ?? null;
      if (!VALID_STATUSES.includes(status)) failExit(`invalid --status: ${status} (expected ${VALID_STATUSES.join('|')})`);
    } else if (a === '--limit') {
      const v = Number(args[++i]);
      if (!Number.isInteger(v) || v < 0) failExit(`invalid --limit: ${args[i]}`);
      limit = v;
    } else if (a === '--json') { /* 默认即 JSON */ }
    else failExit(`unknown option for list: ${a}`);
  }
  let rows = readRows().filter(Boolean);
  if (status) rows = rows.filter((r) => r.status === status);
  if (limit !== null) rows = rows.slice(0, limit);
  process.stdout.write(JSON.stringify(rows) + '\n');
}

function cmdRetry(args) {
  const id = args.find((a) => !a.startsWith('-'));
  if (!id) failExit('retry requires <id>');
  for (const a of args) {
    if (a === '--json') continue;
    if (a === id) continue;
    failExit(`unknown option for retry: ${a}`);
  }

  let row = null;
  updateRowById(id, (r) => {
    if (![STATUS_FAILED, STATUS_PENDING].includes(r.status)) {
      failExit(`row ${id} is ${r.status} — retry only applies to failed/pending rows`);
    }
    row = r;
  });
  if (!row) failExit(`row not found: ${id}`);

  row.status = STATUS_PENDING; // 先改 pending
  sendAndRecord(row); // attempts+1，按结果改 sent/failed
  updateRowById(row.id, (r) => Object.assign(r, row));
  process.stdout.write(JSON.stringify(row) + '\n');
}

function cmdStats() {
  const counts = { [STATUS_PENDING]: 0, [STATUS_SENT]: 0, [STATUS_FAILED]: 0 };
  for (const r of readRows()) {
    if (r && Object.prototype.hasOwnProperty.call(counts, r.status)) counts[r.status] += 1;
  }
  process.stdout.write(JSON.stringify(counts) + '\n');
}

function usage() {
  process.stderr.write(
    [
      'usage: wx-outbox <push|list|retry|stats> [options]',
      '',
      '  push --target <微信target 形如 xxx@im.wechat> --content <文本>',
      '       写 pending 行 → 调发送器 → 改 sent/failed；输出该行 JSON',
      '  list [--status pending|sent|failed] [--limit N]',
      '       列出匹配行，JSON 数组输出',
      '  retry <id>',
      '       重发 failed/pending 行（attempts+1）；输出该行 JSON',
      '  stats',
      '       按 status 计数，JSON 对象输出',
      '',
      '环境变量:',
      '  OUTBOX_PATH             账本路径覆盖（默认 ~/.dsh/wechat-outbox/outbox.jsonl）',
      '  WX_OUTBOX_SENDER        发送命令模板，如 "node /path/to/sender.mjs"',
      '  WX_OUTBOX_SENDER_TIMEOUT_MS  发送超时（默认 60000）',
      '  WX_OUTBOX_OPENCLAW_CHANNEL   fallback 用的 openclaw 频道（默认 openclaw-weixin）',
      '',
    ].join('\n'),
  );
}

/* ------------------------------------------------------------------ */
/* 入口                                                               */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const cmd = argv[0];

if (!cmd || cmd === '--help' || cmd === '-h') {
  usage();
  process.exit(cmd ? 0 : 1);
}

switch (cmd) {
  case 'push': cmdPush(argv.slice(1)); break;
  case 'list': cmdList(argv.slice(1)); break;
  case 'retry': cmdRetry(argv.slice(1)); break;
  case 'stats': cmdStats(argv.slice(1)); break;
  default: failExit(`unknown subcommand: ${cmd}`);
}
