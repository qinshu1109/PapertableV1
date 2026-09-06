#!/usr/bin/env node
/**
 * fake-sender.mjs — wx-outbox 的假发送器（回归测试用）
 * ------------------------------------------------------------
 * 用法与真实发送器一致：
 *   fake-sender.mjs --target <target> --content-file <file>
 *
 * 行为由环境变量 FAKE_SENDER_MODE 控制：
 *   ok            → 始终退出码 0（模拟成功）。stdout 打印一行摘要便于核对。
 *   always-fail   → 始终退出码 1，stderr 输出 "simulated network error"。
 *   fail-once     → 第 1 次调用失败（同上错误），之后全部成功。
 *                   次数记在状态文件里（跨进程持久），默认
 *                   /tmp/wx-fake-sender-state.json，可用 FAKE_SENDER_STATE 覆盖；
 *                   删除状态文件即可重置为"第一次失败"。
 *   （未设置 FAKE_SENDER_MODE → 等同 ok）
 *
 * 退出码：0 = 成功；1 = 模拟失败。stderr 首行会作为 wx-outbox 的 last_error 记录。
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';

const STATE_DEFAULT = '/tmp/wx-fake-sender-state.json'; // 固定路径，便于测试重置（rm -f 即可）
const STATE_FILE = process.env.FAKE_SENDER_STATE || STATE_DEFAULT;
const MODE = process.env.FAKE_SENDER_MODE || 'ok';

function readCount() {
  try {
    return Number(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).count) || 0;
  } catch {
    return 0;
  }
}

function writeCount(n) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ count: n }) + '\n');
  fs.renameSync(tmp, STATE_FILE);
}

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

const args = process.argv.slice(2);
const target = argValue(args, '--target') || '<none>';
const contentFile = argValue(args, '--content-file') || '';
let contentLen = 0;
if (contentFile && fs.existsSync(contentFile)) {
  contentLen = fs.readFileSync(contentFile, 'utf8').length;
}

if (MODE === 'always-fail') {
  process.stderr.write('simulated network error\n');
  process.exit(1);
}

if (MODE === 'fail-once') {
  const n = readCount();
  writeCount(n + 1);
  if (n === 0) {
    process.stderr.write('simulated network error\n');
    process.exit(1);
  }
}

process.stdout.write(`fake-sender ok target=${target} content_len=${contentLen}\n`);
process.exit(0);
