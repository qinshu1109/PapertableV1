# 26-wechat-search-dshcc：微信入口打通调研（角度 A：dsh 生态侧）

- 简报：`agent-bridge/briefs/26-wechat-entry-research.md`（执行：dsh-cc 角度 A；codex 角度 B：微信侧通道）
- 日期：2026-08-14
- 性质：技术调研，只读不改代码（未写任何仓库文件，除本报告）；联网证据用 GitHub API/gh（web_search 鉴权不可用，已改用 gh + api.github.com，均为 2026-08-14 当日实时数据）

## 结论先行

1. **dsh 生态已有 5+ 个微信接入插件，但没有"官方"或"成熟"的**：全部是 2026-08-13/14 冒出来的新仓库（★0–3），清一色走**腾讯非官方 iLink/ClawBot 通道**（与 hermes-agent、OpenClaw 的微信通道同机制），或**借道 OpenClaw** 中介。没有"官方微信适配器"这种东西，也不存在可无脑装的现成方案——但**参照物非常完整**。
2. **dsh 侧接入点形态已被官方文档钉死：protocol driver**（`docs/cookbook/extension-cookbook.md` §"An external protocol driver"）——把外部 wire peer 适配到 `ctx.agents`；`dsh-telegram` 就是它的最小活教材。微信版照抄这个形态即可，不碰 dsh 主仓。
3. **推荐 MVP 形态：protocol driver 插件 + iLink/ClawBot 微信通道**（通道层可参考 dsh-chatnode-wechat 的 gateway 或 dsh2wechat 的通道实现），会话/审批/命令/持久化全部落在 dsh 官方座（`ctx.agents`、`approval/request`、`ctx.commands`、`ctx.sessionPersistence`）。主动推送（定时任务结果）另加一个 `wechat_notify` 工具（dsh-wechat-notify 已验证此形态）。
4. **风险底线**：微信侧没有官方机器人协议——iLink 是从 hermes-agent 源码逆向的非官方协议（chatnode README 自述），个号有封号/限制风险，单 bot token 单轮询者，建议专用微信账号；合规替代（企业微信/公众号）场景不同，是角度 B 的题。dsh 侧零风险（纯扩展点）。

---

## 一、现成插件清单（2026-08-14 实时，按微信相关度排序）

### A. 微信直接接入（5 个）

| 仓库 | ★/日期 | 架构一句话 | 成熟度判断 |
|---|---|---|---|
| **Jesse-njx/dsh-chatnode-wechat** | ★1, 08-13 | **最完整**：iLink bot 网关（`ilinkai.weixin.qq.com`，从 hermes-agent 逆向）+ 两个可分离 Cordis 插件——`wechat-gateway`（扫码登录/鉴权长轮询/断线重连/发送重试+限流/正在输入/媒体下载）、`wechat-conversation-node`（白名单/会话路由/命令/**聊天内审批 /yes /no**/摘要式出站）。凭据走 dsh credentials。有 fake-ilink 测试与 CI。 | 架构最接近"可上生产"；仍 ★1 新仓、非官方协议、单账号单轮询者（README 明示） |
| **wuyuanjiang1/dsh2wechat** | ★0, 08-13 | ClawBot/iLink 消息桥：`getupdates` 长轮询 + `sendmessage`（带 `context_token`）、每用户持久会话（`im-wechat-*`）、会话自愈/崩溃免疫/`127.0.0.1:3901/health`、微信官方限速排队退避。带 `wechat-login.mjs` 扫码工具。 | 功能完整度次之；★0 新仓、无版本承诺 |
| **wssfk12138/dsh-wechat-notify** | ★3, 08-14 | **只发不收**：注册 `wechat_notify` 工具，agent 通过本机 ClawBot 通道（`node <clawbot>/dist/index.js send --file`，UTF-8 文件传中文）主动推微信通知；附扫码登录工具。**正对"定时任务结果推送"需求**，README 有实机截图。 | 单向通知已可用；双向（收到微信→触发 agent）在其 roadmap 未做 |
| **gnulife/dsh-plugin-wechat** | ★0, 08-14 | 一键脚本：自动装 DSH + OpenClaw + 微信通道（OpenClaw `@tencent-weixin/openclaw-weixin`）；本插件起 OpenAI 兼容 HTTP 桥（`/v1/chat/completions` → DSH agent 调用）喂给 OpenClaw 当模型 Provider。 | 借道 OpenClaw 的组装件；★0 新仓 |
| **BeAChanger/dsh-openclaw-acp** | ★1 | OpenClaw 中介：挂官方 `@deepseek-ai/dsh-acp`（ACP server），OpenClaw 渠道插件负责微信收发，dsh 只出 agent。三层职责分离（harness/调度/渠道）。 | 架构干净但多一个中介进程；★1 |

### B. Telegram/飞书参照（协议驱动形态的直接范本）

| 仓库 | ★/日期 | 要点 |
|---|---|---|
| **ben7am1n/dsh-telegram**（简报指定参照物） | ★1, 08-13 | **protocol driver 最小实现（~260 行）**：长轮询 Telegram Bot API（`getUpdates`，无 server/webhook/框架）、每 chat 一 agent 会话（`ctx.agents.create`）、入站 `agent.followup()`、出站监听 `session/event` assistant/message 流式回发、超长分片、allowlist 鉴权、`ctx.effect` 可逆。零 npm 运行时依赖。**微信版照抄这个骨架，把 Telegram 客户端换成 iLink 客户端即可**。 |
| congchuanling-dot/DSH-Telegram-Relay | ★3, 08-13 | 长轮询 + `chat_id` 即 SessionId（重启恢复靠 dsh session persistence）+ offset 原子持久化去重 + Unicode 安全分片。 |
| LoserFox/telegram（dsh-external） | ★6 | 长轮询、per-chat 会话、HTML 格式化。 |
| **Roy-oss1/dsh-lark** | ★2 | **飞书渠道**（合规参照）：`@larksuite/channel` WebSocket 长连（无需公网回调）、每会话一 Agent、**审批变交互卡片**、思考过程原生呈现、图片上传、`/` 行走宿主命令（`ctx.commands`）。 |
| dbydd/dsh-onlyne | ★2 | 独立 IM 通道守护进程（Onlyne 单二进制）+ dsh 插件：模型侧工具 + watch loop（入站消息 `followup` 注入），支持微信/Telegram/飞书/QQ Bot。 |

### C. 清单与索引（信源）

- `awesome-dsh-plugin/awesome-dsh-plugin`（129★）、`0xsline/awesome-deepseek-harness`（156★）、`AdamPlatin123/awesome-dsh-plugins`（328★，"雷达"自动索引 286+ 插件，含「消息通讯（19）」分类）。
- **信源可信度提醒**：`AdamPlatin123/awesome-dsh-plugins` 里的 `dsh-external/*` 渠道条目（tg-bot / dsh-feishu-bot / dsh-wecom-bot / qqbot / dsh-ica / dsh-weixin-bot）**实测全部 404**——该清单是"候选雷达"，含占位条目，引用前必须逐个验真（本报告已验）。

### 结论：有现成参照、无现成答案

- "微信双向常驻入口"没有可一键安装的成熟插件；但 **dsh-chatnode-wechat 已把最难的部分（iLink 网关 + 聊天内审批）做出来了**，dsh-telegram 把协议驱动骨架做出来了，dsh-wechat-notify 把主动推送做出来了——三者合起来就是需求全景。
- 生态全部是 48 小时内新仓库（★0–3），按 dsh pre-release 惯例都要 pin 版本自验，不能当稳定依赖。

---

## 二、dsh 侧接入点分析（钉死形态）

### 官方形态：protocol driver（扩展点唯一正解）

`deepseek-harness/docs/cookbook/extension-cookbook.md` §"An external protocol driver"：

> A *protocol driver* adapts a wire peer to `ctx.agents`; it may serve a UI or an automation client. A stdio driver owns stdout, creates or resumes agents through the factory, and maps protocol requests to `followup()` or `cancel()`. … Tear agents down with `AgentHandle.dispose()`.

官方 worked example 就是 `packages/acp/acp`（ACP JSON-RPC stdio，automation-only）；**dsh-telegram 是同一形态的人话版**（面向人类聊天而非自动化）。微信接入 = 写一个 protocol driver 插件，把"微信消息"当 wire peer。

### 用到的 dsh 座（全部文档化扩展点，不碰主仓）

| 座 | 包/文档 | 微信插件里的用途 |
|---|---|---|
| `ctx.agents`（create/resume + `followup()`/`inject()`/`cancel()`） | `core/agent` | 每微信会话建/续一个 agent；入站消息 `followup()` 进会话（dsh-telegram/dsh2wechat/chatnode 全部如此） |
| `session/event`（assistant/message、assistant/chunk） | `core/session` | 出站：把 agent 的已提交文本流式回发微信（dsh-telegram 监听 `assistant/message`） |
| `approval/request` waterfall（`ctx.approval`） | `@deepseek-ai/dsh-user-approval` | **聊天内审批**：权限请求变成微信文本提示 + `/yes` `/no` 回答，超时默认拒绝（chatnode `node/approvals.ts` 的实现就是范本；lark 用卡片按钮） |
| `ctx.commands` | `@deepseek-ai/dsh-commands` | 聊天里 `/new` `/sessions` `/stop` `/help` 等宿主命令（不开模型轮次；lark 的 `/` 行、chatnode 的命令表） |
| `ctx.sessionPersistence` | `dsh-session-persistence`（sqlite/jsonl backend） | 跨重启会话恢复：`chat_id` ↔ SessionId 映射落持久化（DSH-Telegram-Relay 用它；chatnode 依赖同名机制） |
| `ctx.credentials` | `dsh-credentials` + `dsh-credentials-local` | 微信 token/账号凭据不进 patch 文件（chatnode 的登录脚本写 `$DSH_HOME/.credentials.yaml`） |
| `ctx.tools.register` + `defineTool` | `@deepseek-ai/dsh-tools` | 主动推送：`wechat_notify` 工具形态（dsh-wechat-notify） |
| `ctx.effect`（fiber 级可逆） | cordis | 轮询循环/agent 生命周期挂在 effect 上，卸载收敛（dsh-telegram `ctx.effect(() => { pollLoop(); return stop })`） |
| 官方 ACP 传输 | `@deepseek-ai/dsh-acp`（`packages/acp/acp`） | 备选：走 OpenClaw 中介时挂这个（openclaw-acp 的用法） |

### 接入形态谱系（从近到远）

1. **协议驱动插件（直连）**：插件内自持微信通道客户端（长轮询 iLink/ClawBot API）→ `ctx.agents`。优点：单进程、无中介、可完全掌控；缺点：微信侧协议要自己维护（非官方）。
2. **OpenClaw 中介**：dsh 出 ACP（官方座）→ OpenClaw 管渠道与调度 → OpenClaw 微信渠道插件收发。优点：微信侧脏活外包、OpenClaw 渠道生态现成；缺点：多一个进程/依赖/故障点，消息链路长。
3. **外部守护进程 + 工具/监听**（Onlyne 形态）：独立 daemon 管所有 IM 通道，dsh 侧只挂工具 + watch loop。优点：通道与 harness 解耦、多 IM 复用；缺点：多一层进程与配置。
4. **纯通知工具**（wechat-notify 形态）：只做主动推送，不做双向入口。对"定时任务结果推送"单独够用。

### 微信侧通道现实（角度 A 能确认的 dsh 侧事实）

- **没有官方微信 Bot API**。所有微信插件共用**腾讯 iLink 非官方网关**（`ilinkai.weixin.qq.com`，与 hermes-agent/OpenClaw 的 `weixin` 通道同协议）；chatnode 自述"iLink 细节从 hermes-agent 源码逆向，而非腾讯文档"。
- **单 bot token = 单轮询者**：同一微信账号同时跑 hermes-agent/OpenClaw 与本插件会互相 403 丢消息，必须专用账号（chatnode README 明示）。
- **个号协议风险**：腾讯可能限制该账号——这正是角度 B（codex）要逐通道评估的题；dsh 侧能做的只是把它如实写进 README 边界。

---

## 三、推荐接入形态（如果今天就要 MVP）

**推荐：方案 1——protocol driver 直连插件，通道层抄 chatnode 的 iLink gateway，骨架抄 dsh-telegram。**

```
微信（手机） ⇄ iLink/ClawBot 非官方网关 ⇄ [dsh-time-context 式 bundle 插件]
   ⇄ wechat-gateway（扫码登录/长轮询/重连/限流）
   ⇄ wechat-conversation-node（白名单/会话路由/命令/审批桥）
   ⇄ ctx.agents（每会话一 agent，followup 入站、session/event 出站）
   ⇄（主动推送）wechat_notify 工具 → 同通道回发
```

理由：
- 不引入 OpenClaw/Onlyne 中介，单进程、链路最短、dsh 全能力（工具/审批/持久化/时间上下文插件）直接继承；
- 每个零件都有现成参照：gateway 层 = chatnode `src/gateway/`（iLink 客户端已按 hermes-agent 逐字移植并带 fake-server 测试），骨架 = dsh-telegram `src/index.ts`（260 行），审批桥 = chatnode `src/node/approvals.ts`，推送工具 = dsh-wechat-notify；
- 零 dsh 主仓改动，纯仓库外 bundle（同 dsh-guardrails/dsh-time-context 既有流程：`dsh plugin --profile cc-tui add`）。

**MVP 最小路径（建议落点）**：
1. 克隆/复刻 `Jesse-njx/dsh-chatnode-wechat` 的 gateway（iLink 客户端 + 登录 + 轮询 + 限流），换成自己的 bundle 名与凭据落位（dsh credentials）；
2. conversation-node 按需裁剪：白名单 + 会话路由 + `/new /sessions /stop /status` + 审批桥（/yes /no）先上，媒体/心跳摘要后置；
3. 主动推送：并入 `wechat_notify` 工具（复用本机 ClawBot 通道或直接走自家 gateway 的 send）；
4. 微信侧通道选型与风险结论等角度 B（codex）报告交叉后再拍板（iLink vs gewechat vs 企业微信合规线）；
5. 验收按 dsh 惯例：单测 + keyless（fake iLink server，chatnode 已有 fixture）+ 真实小号扫码端到端（角度 B 或用户提供）。

**备选**：若接受多一个进程，`dsh-openclaw-acp` 路线当日可通（OpenClaw 渠道现成），适合"先通起来"；若只推不聊，`dsh-wechat-notify` 单插件即可满足定时任务推送。

## 附：调研方法注记

- web_search 工具本次鉴权不可用（api key 无效），联网证据全部改走 `gh search` + GitHub REST API（`api.github.com`），2026-08-14 当日实时；三个 awesome 清单与 9 个插件仓库已浅克隆到 /tmp 逐一读源码/README（dsh-telegram 全文、chatnode gateway+approvals+core、wechat-notify 全文、dsh2wechat/openclaw-acp/lark/onlyne/gnulife 头部）。
- dsh 官方文档引用：`docs/cookbook/extension-cookbook.md`（protocol driver）、`docs/subsystems/system-prompt.md`、`packages/{acp,interaction/user-approval,interaction/commands,session/session-persistence,credentials}` README——均来自本地 dsh 源码仓 `/Users/qinshu/Documents/ChatGPT/MemOS/deepseek-harness/`（只读）。
- 临时克隆（/tmp/dsh-*、/tmp/x-*、/tmp/awesome*）调研完已清理。
