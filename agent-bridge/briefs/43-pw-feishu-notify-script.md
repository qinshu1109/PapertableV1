# 简报 43：写 Paperweight 飞书通知最小发送脚本（供 P0 真机矩阵用）

## 派单人

kimi 主控（wG:p1）。执行人：grok（wG:p2）。性质：后端脚本，不碰前端、不碰仓库代码。

## 前置事实（你简报 42 已交付，直接复用）

- 凭证在 `~/.paperweight/feishu-notify.json`（chmod 600），字段：`app_id` / `app_secret` / `app_name` / `created_at` / `created_via`。
- 发信链路已验证：tenant_access_token → `im/v1/messages?receive_id_type=open_id` 发 interactive 卡片成功；用户的 open_id 在 `~/.zcode/v2/bot-config.json` 的 `providerUserId` 字段（只读取用，不写）。
- 你的产出 `agent-bridge/out/42-feishu-cli-config.md` 有完整细节，先读它。

## 目标

交付一个命令行最小脚本 `pw-feishu-notify.mjs`，放进 `/Users/qinshu/Documents/papertableV1/agent-bridge/scripts/`（新建目录，这是协作桥区域、不是仓库源码）。作用：**给定一张候选卡内容，调飞书 API 发出 interactive 消息卡片**，供后续 P0 安卓真机折磨测试（20 次发送数到达，19/20 达标线）。

## 功能要求

1. **两种跑法**：
   - 单发：`node pw-feishu-notify.mjs --seq 1` 发 1 张编号 1 的卡；
   - 矩阵连发：`node pw-feishu-notify.mjs --matrix 20 --interval 5` 发 20 张、每张间隔 5 秒、序号 1..20（用户在手机锁屏上数到达数）。
2. **卡片内容贴近最终形态**（让 P0 测的是真东西，不是 hello world）：
   - 标题：`[测试] 押注候选 #<seq>`；
   - 一行「为什么现在出现」：如「到期窗口：B 站首场直播押注进入结账期」；
   - 一段原文证据占位：一两句中文即可；
   - 一个按钮「查看证据」→ 跳转 `https://dsh.cozai.net/n/test-<seq>`（/n/ 端点还没建，链接 404 无所谓，P0 测的是通知到达和点击拉起浏览器）。
3. **发送结果落日志**：每张卡追加一行到 `/Users/qinshu/Documents/papertableV1/agent-bridge/out/43-send-log.jsonl`，字段 `{seq, sent_at, http_status, api_code, message_id}`。P0 要拿这份日志和手机实际到达数对账。
4. **限速**：飞书发消息 5 QPS/用户，连发间隔 ≥1 秒（默认 5 秒够保守）。
5. **技术约束**：Node 18+ 内置 fetch，零新增依赖；读凭证文件拿 app_id/app_secret，先取 tenant_access_token 再发卡片。

## 红线（同简报 42）

- **禁止把 App Secret 打进窗格、日志、聊天记录、产出文件**。日志只记 message_id 不记 secret。
- **禁止动 `~/.zcode/` 任何文件**（providerUserId 只读）。
- 不碰 `/Users/qinshu/Documents/papertableV1` 和 `kimi窗口` 仓库源码；脚本只放 `agent-bridge/scripts/`。
- 验证脚本时**最多发 2 张测试卡**（单发模式 1-2 次即可）。20 张矩阵留着用户拿着手机在场时再跑。
- 本机有 Clash 代理（7897），网络失败先查代理，别下"飞书挂了"的结论。

## 产出

写 `/Users/qinshu/Documents/papertableV1/agent-bridge/out/43-pw-feishu-notify-script.md`：

- 脚本路径 + 用法（单发/矩阵两条命令）
- 验证结果：发了几张、api_code、message_id 前缀
- 卡片在飞书里长什么样（文字描述即可）
- 有无阻塞

## 完工回报（必须做）

```
herdr agent prompt wG:p1 "简报43 完工：一句话结论+产出路径+有无阻塞"
```

卡住超过 20 分钟同样格式回报「简报43 阻塞：卡在哪」。
