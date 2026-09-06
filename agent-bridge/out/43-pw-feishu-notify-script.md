# 简报 43 产出：Paperweight 飞书通知最小发送脚本

## 脚本路径 + 用法

路径：`/Users/qinshu/Documents/papertableV1/agent-bridge/scripts/pw-feishu-notify.mjs`

本机 node 需带 `PATH="$HOME/.local/node/bin:$PATH"`（或已在 PATH 里）。凭证读 `~/.paperweight/feishu-notify.json`，收件人只读 `~/.zcode/v2/bot-config.json` 飞书 bot 的 `providerUserId`。日志追加 `agent-bridge/out/43-send-log.jsonl`。

单发：

```bash
PATH="$HOME/.local/node/bin:$PATH"
node /Users/qinshu/Documents/papertableV1/agent-bridge/scripts/pw-feishu-notify.mjs --seq 1
```

矩阵连发（P0 真机在场时再跑；本次验证未跑）：

```bash
PATH="$HOME/.local/node/bin:$PATH"
node /Users/qinshu/Documents/papertableV1/agent-bridge/scripts/pw-feishu-notify.mjs --matrix 20 --interval 5
```

`--interval` 单位秒，默认 5，最小 1。零新增依赖，Node 内置 `fetch`。

## 验证结果

发了 **1 张**（`--seq 1`）。未跑 `--matrix 20`。

- `http_status`：200
- `api_code`：0
- `message_id` 前缀：`om_x100b`
- 日志：`/Users/qinshu/Documents/papertableV1/agent-bridge/out/43-send-log.jsonl` 1 行，字段 `seq, sent_at, http_status, api_code, message_id`，无 secret

## 卡片在飞书里长什么样

出现在「琴疏的智能助手」会话（与 ZCode 同一机器人）。

- 蓝标题：`[测试] 押注候选 #1`
- 一行：`为什么现在出现：到期窗口：B 站首场直播押注进入结账期`
- 一段原文证据占位：「第一场直播别再加功能了，先把能跑的演示挂出去。假红灯不挡出门。」
- 主按钮「查看证据」→ `https://dsh.cozai.net/n/test-1`（`/n/` 未建，404 可接受）

矩阵跑时标题与链接里的序号为 1..20（`test-<seq>`）。

## 有无阻塞

无阻塞。未改 `~/.zcode/`，未碰仓库源码。20 张到达率测试留给用户拿安卓机在场时执行上面的矩阵命令。
