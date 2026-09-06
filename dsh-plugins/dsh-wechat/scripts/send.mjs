#!/usr/bin/env node
/**
 * dsh-wechat outbox 发送器 — 供 wx-outbox 推送记账层调用。
 *
 * 独立进程：从 dsh credentials 服务读取 WEIXIN_ACCOUNT_ID / WEIXIN_BOT_TOKEN /
 * WEIXIN_BASE_URL（与 login.mjs 写入的是同一组 ref），经 WechatGateway.sendText
 * 向微信目标发一条文本气泡。
 *
 * 用法：
 *   node scripts/send.mjs --target <to> --content <text>
 *   node scripts/send.mjs --target <to> --content-file <path>   # UTF-8 文件传中文
 *
 * 契约（wx-outbox 的 WX_OUTBOX_SENDER 用）：
 *   - 退出码 0 = 发送成功；非 0 = 失败
 *   - stderr 首行 = 失败原因（last_error 记账来源）
 *   - stdout 输出一行 JSON：{"ok":true,"messageId":...} 或 {"ok":false,"error":...}
 *
 * 说明：iLink 主动推送受 context_token 时效/额度约束（24-48h 无互动失效、约 10 条
 * 额度），sendText 内置 session-expired 识别（ret=-14 / -2+unknown error），失败会
 * 在错误信息中注明，由 outbox 层标记 failed 并可重试。best-effort，不承诺 SLA。
 */

import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { WechatGateway } from '../lib/gateway/index.js'

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.stdout.write(JSON.stringify({ ok: false, error: message }) + '\n')
  process.exit(1)
}

async function main() {
  const args = process.argv.slice(2)
  const get = (flag) => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : undefined
  }
  const target = get('--target')
  const content = get('--content')
  const contentFile = get('--content-file')

  if (!target) fail('send.mjs: --target is required')
  let text = content
  if (contentFile) {
    const { readFileSync } = await import('node:fs')
    text = readFileSync(contentFile, 'utf8')
  }
  if (!text || !text.trim()) fail('send.mjs: empty content')

  const baseUrl = process.env.WEIXIN_BASE_URL?.trim() || undefined
  const ctx = new Context()
  await ctx.plugin(LocalCredentialProvider, { watch: false })
  await ctx.plugin(WechatGateway, {
    ...(baseUrl ? { baseUrl } : {}),
  })

  try {
    const token = await ctx.credentials.resolve(credentialRef('WEIXIN_BOT_TOKEN'))
    const accountId = await ctx.credentials.resolve(credentialRef('WEIXIN_ACCOUNT_ID'))
    const confirmedBaseUrl = await ctx.credentials.resolve(credentialRef('WEIXIN_BASE_URL'))
    if (!token?.value || !accountId?.value) {
      fail('send.mjs: no WEIXIN_BOT_TOKEN/WEIXIN_ACCOUNT_ID credentials — run scripts/login.mjs first')
    }
    // 测试钩子：WEIXIN_BOT_TOKEN_OVERRIDE 仅用于 outbox 失败模拟（注入坏 token），
    // 非测试环境不要设置。
    const effectiveToken = process.env.WEIXIN_BOT_TOKEN_OVERRIDE?.trim() || token.value
    ctx.wechat.setCredentials({
      token: effectiveToken,
      accountId: accountId.value,
      baseUrl: confirmedBaseUrl?.value || baseUrl || 'https://ilinkai.weixin.qq.com',
    })
    if (!ctx.wechat.configured) fail('send.mjs: gateway not configured after setCredentials')
    // setCredentials 会自动 restart 轮询；本脚本只发送，不参与轮询——
    // iLink 单 bot token 只允许一个 poller（常驻 dsh 进程持有），这里立即停掉。
    await ctx.wechat.stop()

    const result = await ctx.wechat.sendText(target, text)
    if (!result.success) fail(`send.mjs: send failed: ${result.error}`)
    process.stdout.write(JSON.stringify({ ok: true, messageId: result.messageId }) + '\n')
    await ctx.wechat.stop()
    process.exit(0)
  } catch (error) {
    fail(`send.mjs: ${error instanceof Error ? error.message : String(error)}`)
  }
}

main()
