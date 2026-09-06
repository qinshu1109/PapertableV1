# 简报 42：用 CLI 配出 Paperweight 可用的飞书应用凭证

## 派单人

kimi 主控（wG:p1）。执行人：grok（wG:p2）。性质：配置/调研，不碰任何仓库代码，不动前端。

## 背景（三句话）

1. 押注通知链路已定首选运输层 = 飞书应用机器人（ntfy 备胎）。架构：Paperweight(4317) 产候选卡 → 飞书机器人发消息卡片 → 用户手机点「查看证据」→ 跳 `dsh.cozai.net/n/<短时令牌>` 只读证据页 → 人工 POST 处置。
2. 用户已用 ZCode 配通「ZCode↔飞书」对话桥（应用名「琴疏的智能助手」，/bind B28A82 绑定成功）。但 ZCode 把该应用凭证加密存在 `~/.zcode/v2/credentials.json` 的 `bot:bot-6b424582-b9f4-47de-9494-d7bb978f2e09:credential` 键（`enc:v1` 密文），Paperweight 无法复用。
3. 通知语义不能混进 ZCode 闲聊窗，所以 Paperweight 需要**自己一组 App ID / App Secret** 直接调飞书 OpenAPI 发卡片。

## 你的目标

交付一组 Paperweight 可直接调飞书 API 发消息卡片的 App ID / App Secret，落到本地文件。

## 具体步骤

1. **先调研有没有可用的飞书 CLI / 命令行途径**完成自建应用配置（官方 CLI、开放平台 API、或社区工具都行，查清楚再动手）。
2. 在 open.feishu.cn 开发者后台确认 ZCode 那个应用（「琴疏的智能助手」）**是不是用户租户自有的自建应用**：
   - 是 → 直接取回它的 App ID / App Secret（同一租户下自建应用凭证在后台可见/可重置）。
   - 不是或查不到 → 新建专用应用「镇纸押注」，只开机器人能力 + 发消息权限（`im:message`），版本发布到可用状态。
3. 凭证写本地文件 `~/.paperweight/feishu-notify.json`，格式：
   ```json
   { "app_id": "cli_xxx", "app_secret": "...", "app_name": "...", "created_via": "...", "created_at": "..." }
   ```
   `chmod 600`。
4. **验证发送链路（最多 1 条测试）**：tenant_access_token → 给用户自己的会话发 1 张测试卡片（im/v1/messages，receive_id 用用户 open_id 或 chat_id，能拿到哪个用哪个）。发不出去就记录卡在哪个接口/权限。
5. 纯 CLI 走不通的部分，**明确列出「必须人在网页上点哪几步」**，写到产出文件里，不要硬闯。

## 红线

- **禁止把 App Secret 打进窗格、聊天记录、产出文件**。产出文件只写凭证文件路径和 App ID 前 8 位。
- **禁止动 ZCode 任何配置**（`~/.zcode/` 只读排查可以，写不行）。
- 测试消息**最多 1 条**，别刷屏。
- 不碰 `/Users/qinshu/Documents/papertableV1` 和 `kimi窗口` 仓库里任何代码。

## 已知平台事实（省得你重查）

- 发消息接口限速 5 QPS/用户；免费版自建应用 API 调用上限 1 万次/月——对个人通知场景够用。
- 飞书个人版可建自建应用；应用需发布版本后机器人能力才生效。
- 用户机器：macOS，有 node/npm，本机已有 Clash 代理（7897），**任何网络连接失败先怀疑 Clash，不要先下"飞书挂了"的结论**。

## 产出

写 `/Users/qinshu/Documents/papertableV1/agent-bridge/out/42-feishu-cli-config.md`，内容：

- 结论：拿到凭证没有？走的是「复用 ZCode 应用」还是「新建镇纸押注」？
- 凭证文件路径（不含 secret 本身）
- 测试卡片发送结果（发出去了/卡在哪）
- 剩余必须人工在网页上做的步骤（如有，逐条列）
- 有无阻塞

## 完工回报（必须做）

干完后执行：

```
herdr agent prompt wG:p1 "简报42 完工：一句话结论+产出路径+有无阻塞"
```

卡住超过 20 分钟也同样格式回报「简报42 阻塞：卡在哪」。
