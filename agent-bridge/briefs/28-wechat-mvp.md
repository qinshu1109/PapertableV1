# 简报 28 v2：微信 MVP — dsh 直连微信（protocol driver）+ outbox 推送记账

> v2 修订（用户拍板）：**不要 OpenClaw 中介层**。dsh 直接连微信，接入形态 = dsh 官方钉死的 protocol driver 插件。禁止安装/启动 OpenClaw 或任何 gateway 中介进程。

## 这刀是干什么的

1. **微信对话入口**：给 cc-tui profile 做一个 dsh 微信插件（protocol driver 形态），dsh 进程内直接走腾讯官方 iLink/ClawBot 通道收发微信——实现"微信里喊一声 dsh 就干活"，没有中间进程。
2. **推送 best-effort + outbox 记账**：定时任务/agent 主动推送微信时，先写 outbox 再发送——发没发出去要有账可查，失败能重试、能转人工兜底。

## 怎么算好

- 用户用手机微信给扫码接入的号发一条文本消息，dsh-cc 收到并回复（回复回到微信），全程只有 dsh 一个进程在跑这条链路。
- 模拟一次定时推送：outbox 先出现 pending 记录，成功变 sent；人为制造一次失败（断网/坏 token），记录变 failed 带错误原因，能用入口重试。
- 二维码出现时**停下来等用户扫码**——立即回报主控转达，不要空等超时。

## 以下给干活的看，可以跳过

### 架构（唯一许可形态）

```
微信 ←→ 腾讯 iLink/ClawBot 官方通道 ←→ dsh-wechat 插件（protocol driver，dsh 进程内）←→ dsh agent
```

- **禁止**：OpenClaw、`dsh-openclaw-acp`、任何独立 gateway/中介常驻进程。
- 已有调研（不要重复调研，直接用）：
  - `agent-bridge/out/26-wechat-search-dshcc.md`：通道层抄 **Jesse-njx/dsh-chatnode-wechat** 的 `wechat-gateway`（iLink 网关：扫码登录/鉴权长轮询/断线重连/发送重试+限流/正在输入/媒体下载，凭据走 dsh credentials，带 fake-ilink 测试 fixture）；骨架抄官方 **dsh-telegram**（protocol driver 人话版范本，dsh 本地源码仓）；推送发送思路参考 **wssfk12138/dsh-wechat-notify**（UTF-8 文件传中文）。
  - `agent-bridge/out/27-openclaw-official-research.md`：iLink/ClawBot 属腾讯官方产品线，个人号扫码接入合规；**主动推送约束**：用户 24-48h 不互动 context_token 失效、主动消息约 10 条额度——推送只能 best-effort，outbox 记账是硬需求。
  - dsh 本地源码仓（只读）：`/Users/qinshu/Documents/ChatGPT/MemOS/deepseek-harness/`，protocol driver 写法见 `docs/cookbook/extension-cookbook.md` 与 dsh-telegram 包。
- 模型凭证：`source ~/.dsh-zen.env`（DEEPSEEK_BASE_URL/DEEPSEEK_API_KEY，deepseek-v4-flash）。key 只许在环境变量和该文件（600），禁止写进任何仓库/报告。

### 工作拆分（可多子代理并发，WS3 与 WS1/WS2 弱依赖可先行）

**WS1 通道层**：把 chatnode-wechat 的 iLink 网关能力拿过来（可直接引用其代码/裁剪，注明出处），跑通到"出二维码"——二维码终端渲染或导出图片均可，记录用户扫码操作步骤。到这一步**立即回报主控**等用户手机扫码，不要空等。

**WS2 插件层**：按 dsh-telegram 骨架把通道包成 dsh protocol driver 插件（放 `papertableV1/dsh-plugins/dsh-wechat/`），装配进 cc-tui profile（`~/.dsh/profiles/cc-tui`）。验收：微信入站消息进 dsh 会话、dsh 回复出站回微信。实测能力边界矩阵：文本收/发、长消息截断、图片/文件入站、聊天内审批可行性、断线重连行为。单测照 dsh 惯例（fake iLink server，chatnode 有现成 fixture）。

**WS3 outbox 推送记账层**（不受路线修订影响，照原样）：
- 最简形态：本机 JSONL 或 SQLite（位置自定，说明理由），字段至少 `id / created_at / target / content / status(pending|sent|failed) / attempts / last_error / sent_at`。
- dsh 可调用的推送工具：写 outbox → 调插件发送 → 按结果更新状态；context_token 失效类错误必须可识别并标 failed。
- 查询入口（列出 pending/failed）+ 重试入口（对 failed 重发）。
- 与 `dsh-scheduled-prompt` 联动验收一次全链路；人为制造失败验证记账与重试。

**WS4 报告**：产出 `agent-bridge/out/28-wechat-mvp.md`——两段人话开头（什么能用了/什么还不行/有什么等拍板）+ 装配清单（装了什么、装在哪、怎么卸）+ 能力边界实测矩阵 + outbox 账本样例 + 用户扫码操作步骤 + 已知约束（token 时效、消息额度）。

### 红线

- 不动镇纸后端（4317）和 papertableV1 前端；不 commit 不 push。
- 只装 cc-tui profile，不动 web profile（3080 在跑，别重启它）。
- 需要用户扫码时**立即回报**，不要空等超时。
- 密钥/Token 不落报告、不落仓库。

### 回报条款（硬性）

- 完工或卡住，立刻执行：`herdr agent prompt w4:p1 "简报28 完工/卡住：一句话结论 + 产出路径 + 阻塞点"`。
- 主控是 kimi w4:p1，可被推回；**不允许干完不说话**。
