# 简报 42 产出：Paperweight 飞书通知凭证

## 结论

拿到凭证。走的是 **复用 ZCode 应用**（企业自建应用「琴疏的智能助手」），不是新建「镇纸押注」。

依据：用户已登录 `https://open.feishu.cn/app`。应用列表可见「琴疏的智能助手」——所有者琴疏、角色所有者、已启用、已发布。其 App ID 与 `~/.zcode/v2/bot-config.json` 只读字段 `feishuAppId` 一致（完整 ID 不写入本文件，前 8 位 `cli_aa1a`）。ZCode 自己的 secret 仍是 `enc:v1` 密文，Paperweight 不能复用那份密文；本次从开放平台凭证页取回同一应用的 App Secret，写入 Paperweight 本地文件。

官方 CLI 已核实可用：`npx @larksuite/cli@latest`（v1.0.90），`lark-cli config init --new` 可一键建自建应用，但本机此前未配置，且 ZCode 应用已是租户自有，故未新建。

## 凭证文件

- 路径：`~/.paperweight/feishu-notify.json`
- 权限：`600`
- App ID 前 8 位：`cli_aa1a`
- `app_name`：琴疏的智能助手
- `created_via`：`reused-zcode-app:open.feishu.cn/app/<app>/baseinfo`
- 本文件不含 App Secret

## 测试卡片发送结果

发出去了。

1. `POST /open-apis/auth/v3/tenant_access_token/internal` → `code=0`
2. `GET /open-apis/bot/v3/info` → 机器人名「琴疏的智能助手」，`activate_status=2`
3. `POST /open-apis/im/v1/messages?receive_id_type=open_id`（interactive 卡片，文案「镇纸通知链路测试」，按钮「查看证据」）→ HTTP 200、`code=0`、`msg=success`，有 `message_id`（前缀 `om_x100b`）

`receive_id` 用的是 ZCode `bot-config.json` 里该应用的 `providerUserId`（用户 open_id）。只发了这一条。

副作用：测试卡会出现在「琴疏的智能助手」会话里（与 ZCode 闲聊同一机器人）。简报要求租户自有则复用该应用，因此未另建「镇纸押注」。

## 剩余必须人工在网页上做的步骤

无。凭证已落盘，发信链路已用 1 条卡片打通。

可选（非阻塞，仅当以后要把押注通知从 ZCode 闲聊窗拆出去）：

1. 打开 `https://open.feishu.cn/app` → 「创建企业自建应用」，名称「镇纸押注」
2. 只开机器人能力 + `im:message`，发一版并发布到可用
3. 把新 App ID / App Secret 写进 `~/.paperweight/feishu-notify.json`（仍 chmod 600）
4. 手机飞书里搜该机器人开一次会话，再测发信

## 有无阻塞

无阻塞。

未改 `~/.zcode/`，未改仓库代码。Safari 上打开过开发者后台标签，未关。
