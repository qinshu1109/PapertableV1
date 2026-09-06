# 简报 27：OpenClaw × 微信 ClawBot / iLink 官方渠道深挖

> 调研日期：2026-08-14  
> 范围：`@tencent-weixin/openclaw-weixin` 归属、微信 ClawBot 个人号扫码、iLink 官方子域、主动推送边界、账号风险，以及与企业微信线的取舍。  
> 性质：只调研，不改代码。

## 结论先行

### 一句话判断

**OpenClaw 个人号扫码接入现在确实有腾讯微信官方产品线：微信客户端里的 ClawBot 功能 + Tencent 发布的 `@tencent-weixin/openclaw-weixin` 插件 + `https://ilinkai.weixin.qq.com` 后端。它不再等同于 wechaty/itchat/gewechat 那种逆向个人协议。**

但要把“官方通道”与“无限制官方 Bot API”分开：官方支持的是用户在微信内开通 ClawBot、扫码连接自己部署/使用的第三方 AI 服务；腾讯仍保留客户端范围、连接条件、收发频率、风险识别、拦截/暂停/终止和变更服务的权利，没有发现公开的无限期 token、主动推送 SLA 或任意第三方直连承诺。

### 对简报 26 的修正

- “个号协议全部出局”需要修正为：**旧式个人客户端模拟/逆向协议出局；官方 ClawBot/iLink 是新出现的、受条款约束的例外。**
- “个人微信绝对不能主动推送”也不再准确：官方插件代码有 `sendMessage`、媒体上传、直接出站和 cron 投递路径，**技术上可以主动推送**。
- 但“可以发”不等于“适合无人值守告警”：官方仓库的公开问题记录显示，context token 会在用户长时间不互动后失效，主动消息还有会话额度/频率边界；观察到约 24–48 小时和约 10 条的限制差异，具体以服务端当前策略为准。

### 最终取舍

| 优先级 | 推荐 |
|---|---|
| 必须在个人微信私聊里直接对话、接受定时推送的 best-effort 性质 | **OpenClaw 官方 ClawBot/iLink**；它是当前个人微信体验最短的官方路线，但要把推送失效当可发生事件，不能承诺 SLA |
| 定时任务结果、告警和审计必须长期稳定送达 | **企业微信自建应用/官方机器人线**；入口换成企业微信，换来明确的官方消息 API、应用权限治理和更强的主动推送语义 |
| dsh 今天要最快接上 OpenClaw 微信，不再维护第二套微信协议 | `dsh-openclaw-acp` + Tencent 官方微信插件；适合先通链路，接受 ACP 当前“新会话优先、工具桥受限”的边界 |
| 想绕过 OpenClaw 直写 iLink | 只建议在读完 ClawBot 条款并接受无公开 SDK/SLA 后做隔离实验；不要把独立直连客户端宣传成“腾讯无限制官方 API” |

## 1. `@tencent-weixin` 到底是不是腾讯的

### 硬证据

1. **GitHub 组织归属。** [`Tencent/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) 位于 `Tencent` 组织下；GitHub 组织页显示 Tencent 已验证并控制 `opensource.tencent.com`，组织主页链接到该腾讯开源域名。仓库 README 明写“OpenClaw 的微信渠道插件，支持通过扫码完成登录授权”，并列出 2.x 为活跃线、1.x 为维护线。
2. **npm 包作者和维护者。** npm registry 当前的 [`@tencent-weixin/openclaw-weixin`](https://registry.npmjs.org/@tencent-weixin%2fopenclaw-weixin) 2.4.6 元数据写明 `author: Tencent`；维护者账号的邮箱均为 `@tencent.com`。CLI 包 [`@tencent-weixin/openclaw-weixin-cli`](https://registry.npmjs.org/@tencent-weixin%2fopenclaw-weixin-cli) 也写明作者 Tencent。
3. **官方仓库包元数据。** 仓库 `package.json` 当前为 2.4.6、`author: Tencent`、Node >=22，且包含 `ilink_appid: "bot"`。仓库最新 release commit 为 2026-06-25 的 v2.4.6；截至 2026-08-14 仓库仍在处理问题和维护兼容性。
4. **腾讯自己的云桌面文档。** [腾讯云 OpenClaw 云桌面通道配置](https://cloud.tencent.com/document/product/1291/129132)把微信列为可配置通道：弹出二维码、用微信扫一扫、扫码后开启微信机器人消息通道，并在微信 ClawBot 对话页直接聊天（文档“微信机器人集成”步骤）。这不是第三方博客的推测，而是腾讯云产品文档中的操作路径。

因此，`@tencent-weixin` 不是仅凭 scope 名称冒充官方；**包、仓库和腾讯云产品文档三条证据互相吻合。** OpenClaw 本身仍是独立的开源 AI Gateway，官方归属只覆盖微信 ClawBot 插件和 iLink 接入层，不表示 OpenClaw 由腾讯开发或运营。

## 2. iLink 子域是什么性质

### 2.1 它确实是官方 ClawBot 的后端

Tencent 官方仓库的默认配置在 [`src/auth/accounts.ts`](https://github.com/Tencent/openclaw-weixin/blob/main/src/auth/accounts.ts) 中明确写为：

```text
DEFAULT_BASE_URL = https://ilinkai.weixin.qq.com
CDN_BASE_URL     = https://novac2c.cdn.weixin.qq.com/c2c
```

同一仓库的 [`README.zh_CN.md`](https://github.com/Tencent/openclaw-weixin/blob/main/README.zh_CN.md) 和 [`src/api/api.ts`](https://github.com/Tencent/openclaw-weixin/blob/main/src/api/api.ts)列出完整接口族：

- `get_bot_qrcode` / `get_qrcode_status`：微信扫码授权；
- `getupdates`：HTTP 长轮询收消息；
- `sendmessage`：发文本、图片、视频、文件；
- `getuploadurl`：获取媒体上传参数；
- `getconfig`、`sendtyping`、`notifystart`、`notifystop`：会话/输入状态/在线状态。

域名本身不是授权证明；**这里的授权证据来自“微信 ClawBot 功能 + Tencent 官方仓库/包 + 官方客户端扫码流程”这条组合链。** `ilinkai.weixin.qq.com` 只是把这条产品链的后端 endpoint 暴露出来。

### 2.2 三档性质，不能混为一谈

| 档位 | 具体做法 | 本调研判断 |
|---|---|---|
| **官方支持** | 在微信客户端启用/使用 ClawBot，用 Tencent 的 `@tencent-weixin/openclaw-weixin` 插件完成 QR login，按插件的 API/版本边界运行 | **是**。这是有 Tencent 仓库、npm 包、腾讯云文档和微信客户端功能支撑的官方产品路径 |
| **官方通道内的条件性使用（未承诺）** | 用户已通过 ClawBot 授权后，独立程序复用同一 iLink endpoint 和 bot token，严格按 ClawBot 条款、频率、内容和单账号运行边界使用 | **可技术验证，但没有找到公开的通用开发者 SDK、配额表、SLA 或“任意客户端均受支持”的明示**。不能把“域名能访问”升级成“腾讯承诺” |
| **逆向/灰色** | Web/桌面 Hook、内存注入、伪造客户端、wechaty/itchat/gewechat 旧协议，或未经 ClawBot 授权声称可任意控制个人号 | **仍是灰色/高风险**。官方子域名不能给这些实现洗白 |

独立社区整理的 [`微信 ClawBot 功能使用条款`镜像](https://github.com/hao-ji-xing/openclaw-weixin/blob/main/protocol.md)（注意：这是社区仓库，不是腾讯官网原始 URL）与产品流程相符：条款把 ClawBot 定义为腾讯通过微信页面提供的、让用户连接自己部署/使用的第三方 AI 服务的工具；腾讯只提供信息收发，不提供 AI 服务；腾讯可按客户端类型、连接条件、信息收发规模/频率和风险采取提示、拦截、阻断、限制、暂停或终止措施，并不保证服务无中断或无缺陷。报告引用它只作条款文本的可读证据，正式法律依据仍应以微信客户端实际展示的条款和腾讯官网当前版本为准。

## 3. 个人号扫码与能力边界

### 3.1 扫码绑定的真实对象

扫码结果不是“接管微信客户端”：服务端返回 `bot_token`、`ilink_bot_id`、`ilink_user_id` 和可能的 `baseurl`，插件把这些凭据保存到本地账号状态，然后以 `AuthorizationType: ilink_bot_token` + Bearer token 调 iLink。换句话说：

```text
手机微信 ClawBot 授权
        ↓
腾讯 iLink bot token / user id
        ↓
本机 OpenClaw gateway 长轮询 + sendmessage
        ↓
微信私聊窗口
```

这和旧的个人号 Web 登录、iPad 协议、桌面 Hook 不是同一技术性质。OpenClaw 也不是腾讯产品；腾讯提供的是微信侧 ClawBot 通道。

### 3.2 当前插件可收发什么

官方仓库的 channel capability 声明是 `chatTypes: ["direct"]`、`media: true`、`blockStreaming: true`：

- **聊天形态：** 直接私聊；当前代码没有把它当普通微信群机器人。
- **入站：** `getupdates` 长轮询，消息结构含文本、图片、语音、文件、视频类型及 `context_token`。
- **出站：** `sendmessage` 文本；媒体通过 `getuploadurl` + CDN 加密上传，再发图片/视频/文件；输入状态有 `sendtyping`。
- **在线状态：** 2.3.x 起，gateway 启动/停止会调用 `notifystart` / `notifystop`，用于让上游对账在线状态；它不是“无限续期主动推送”的保证。
- **macOS：** iLink 是出站 HTTPS + 入站 HTTP 长轮询，不要求公网回调 URL；OpenClaw 和插件可在 Node >=22 的 macOS 上运行，Mac 只需能出网并保管扫码后的本地凭据。

## 4. 主动推送：能发，但不是无限可靠

### 4.1 官方实现确实有主动出站路径

这次不能再说“个人微信只有被动回复”：

1. `README.zh_CN.md` 明写 `sendMessage`，并列出文本/图片/视频/文件。
2. `src/channel.ts` 的 outbound 模式是 `direct`，同时实现 `sendText` 与 `sendMedia`。
3. 同一文件的 agent prompt 明确提醒：创建 cron 时必须指定当前微信用户的 `delivery.to`（`xxx@im.wechat`）和 `delivery.accountId`，否则会报缺少目标或从错误账号发送。
4. 官方仓库的 issue #191 也明确把“cron-triggered isolated session delivery”作为真实出站场景讨论；这反向证明 OpenClaw 设计上把定时投递纳入微信渠道，而不是只允许回复当前 inbound。

所以，**定时任务结果推到个人微信在 API/产品设计上是支持的。**

### 4.2 生产上必须按“有条件”验收

官方仓库的公开 issue 是最重要的现实证据（它们是用户报告/feature request，不等于腾讯正式规格，因此不能当硬配额公告）：

- [#202](https://github.com/Tencent/openclaw-weixin/issues/202)：报告用户 24 小时没有主动互动后 `context_token` 失效；有效会话内主动消息约 10 条后受限，并请求延长时效/提高额度。
- [#225](https://github.com/Tencent/openclaw-weixin/issues/225)：报告 agent-initiated outbound 在约 48 小时无 inbound 后返回 `ret=-2`，直到用户再次发消息才恢复；该 issue 仍把 token 刷新/续期列为待解决方案。
- [#185](https://github.com/Tencent/openclaw-weixin/issues/185)：报告“用户主动聊天后可以正常收到一天一次推送，但不互动两天后收不到”。该 issue 后来关闭，但现象仍是重要的运行边界信号。
- [#191](https://github.com/Tencent/openclaw-weixin/issues/191)：报告 cron 记录 `delivered=true` 但实际没有出站，用户入站重新唤醒 runtime 后才恢复；这说明“宿主记为 delivered”不能代替微信端到达确认。

这些报告的时间窗口不完全一致（约 24–48 小时、约 10 条），因此不能写成固定官方配额；能写成的可靠结论是：

> **iLink 主动推送是官方支持的能力，但会话 token、用户是否近期互动、消息额度、gateway runtime 和客户端/服务端版本都会影响投递；腾讯未公开无限期/无限量主动推送承诺。**

当前 2.4.6 已修复部分工程问题（例如解析 `sendMessage` 的业务 `ret`、Node 24 请求兼容、runtime 初始化），但 changelog 没有给出“token 永不过期”或“cron 可靠送达”的承诺。`notifystart` / `notifystop` 是在线状态通知，不应误当成 token 保活。

### 4.3 需要怎样验收主动推送

若主控仍选择 OpenClaw 线，MVP 不应只测“刚扫码后发一条消息”，应至少做：

1. inbound 对话后立刻 cron 推送；
2. 24 小时无用户互动后 cron 推送；
3. 48 小时无用户互动后 cron 推送；
4. 连续超过 10 条主动消息的投递与错误码；
5. gateway 重启后 cron 推送；
6. `delivered=true` 时对照微信端实际收件，而不是只看 OpenClaw 日志；
7. 过期/失败时把错误显式落入 outbox，并回退到企业微信或其他官方通知线。

## 5. 封号与账号风险：从“高风险灰色”改为“官方但可被治理”

### 5.1 为什么不能再把它和 itchat 一起判高风险

微信官方的[《微信个人账号使用规范》](https://weixin.qq.com/agreement/personal_account?lang=zh_CN)（页面当前显示 2026-04-29 更新/生效）禁止未经腾讯开发或授权的第三方软件、插件、外挂、系统登录、使用或进行自动化操作，并保留限制功能、封禁账号等处置权。这个条款仍然适用于个人号。

但 ClawBot 是微信客户端内的腾讯功能，Tencent 发布的插件/npm 包也是这条产品线的一部分。因此，在**官方 ClawBot 页面开通 + 官方插件扫码授权 + 合规内容/频率**的路径上，没有依据把它当作未经授权的个人号 Hook；这正是与 itchat/gewechat/wechaty Web puppet 的关键区别。

### 5.2 风险不是零，也不是“腾讯担保不封”

ClawBot 条款镜像的风险条款（应以客户端实际条款核验）明确给腾讯留下这些权利：

- 决定支持哪些微信客户端和可连接条件；
- 设置信息收发规模/频率；
- 识别输入、输出与技术连接；
- 进行风险提示、拦截、阻断；
- 对违规/危害微信产品安全的连接限制、暂停或终止；
- 按业务需要中断或终止功能，且不保证可用性。

因此风险分层应写成：

| 路线 | 风险判断 |
|---|---|
| 微信内 ClawBot + Tencent 官方插件 | **低于旧式个人协议，非零**；主要是内容/连接/频率治理、功能暂停和服务变更风险，不是“官方保证永不限制” |
| 复用 iLink 的独立客户端，严格沿用授权和条款 | **中、未承诺**；技术上可行，但超出 Tencent 插件的公开支持面，不能把 endpoint 当作公开 SDK/SLA |
| wechaty/itchat/gewechat、Hook/注入、伪造客户端 | **高**；仍属于旧式非官方自动化或逆向，继续适用个人账号规范的禁止条款 |

建议仍不要把支付主号、工作主号、承载重要资料的唯一微信号当实验账号；“官方”降低的是未经授权协议风险，不消除平台策略、内容违规、凭据泄露和服务中止风险。

## 6. 与企业微信线的取舍

### 6.1 同口径对比

| 维度 | OpenClaw 官方 ClawBot / iLink 个人号线 | 企业微信自建应用 / 官方机器人线 |
|---|---|---|
| 用户体验 | 个人微信里直接出现 ClawBot，扫码后私聊；入口最符合“手机上随时找 agent” | 企业微信应用/机器人会话；不是个人微信私聊，需企业成员/可见范围 |
| 官方性 | **官方产品线，但以 ClawBot 功能条款为边界**；不是无限制公共 Bot API | 官方企业应用/机器人 API，接口文档和权限模型更明确 |
| 收消息 | iLink `getupdates` 长轮询，无公网回调要求 | 应用回调或官方长连接/机器人能力，按企业微信文档配置 URL/Token/EncodingAESKey 或机器人凭据 |
| 主动发消息 | `sendmessage` 技术上支持；context token、互动时效和额度使长期静默推送不可靠 | 应用消息 API 可按用户/部门/标签主动发，配额和权限可审计；更适合定时结果/告警 |
| 内容 | 文本、图片、视频、文件；当前插件能力声明 direct chat，语音/媒体仍需按版本实测 | 企业微信应用消息支持文本、图片、视频、文件、图文等官方类型，具体受应用权限/可见范围 |
| Mac | 本机出站 HTTPS + 长轮询即可，无需公网回调；Node 版本需和插件兼容 | 出站 API 可在 Mac；入站回调若使用 webhook，需公网 HTTPS relay，或选择官方长连接机器人能力 |
| 账号风险 | 官方路径风险明显低于灰色个人协议，但腾讯可按条款限频、拦截、暂停/终止；不保证不限制 | 不依赖个人号外挂登录；主要是企业应用审核、权限、配额、内容与租户治理风险 |
| 成本/门槛 | 不必先注册企业；需 OpenClaw 主机、模型服务费用、微信版本/放量条件；插件本身 MIT | 需企业微信租户、自建应用/机器人配置、成员可见范围和回调/长连接运维；具体认证/增值费用按企业微信当前政策核对 |
| 最适合 | 个人手机入口、交互式任务、允许 best-effort 的提醒 | 稳定通知、可审计告警、多人/部门治理、业务生产入口 |

企业微信的官方入口可从[发送应用消息](https://developer.work.weixin.qq.com/document/path/90236)、[接收消息与事件概述](https://developer.work.weixin.qq.com/document/path/90238)、[消息格式](https://developer.work.weixin.qq.com/document/path/90239)和[获取 access_token](https://developer.work.weixin.qq.com/document/path/91039)核对；腾讯云自己的[OpenClaw 通道文档](https://cloud.tencent.com/document/product/1291/129132)也把微信 ClawBot和企业微信机器人作为两条不同配置路径列出。

### 6.2 明确建议

- **若“个人微信私聊”是硬需求：** 选 OpenClaw 官方 ClawBot；把它定义为交互入口，定时结果只做 best-effort，并实现发送失败可观测和备用通知。不要再退回 itchat/gewechat。
- **若“定时任务一定要到”是硬需求：** 选企业微信官方线，哪怕用户体验不是个人微信。它更适合 Paperweight/dsh 的任务结果、异常告警和长期运行。
- **不建议把两条线混成一个隐式 fallback：** 个人微信和企业微信的用户身份、会话 ID、隐私边界不同；如果双通道并存，应在产品上明确“个人对话入口”和“可靠通知出口”两个地址，并记录投递状态。

## 7. dsh 接入形态取舍

简报 26 角度 A 已确认 dsh 的官方扩展形态是 protocol driver；本简报只针对 OpenClaw 官方微信线做交叉判断。

### A. `BeAChanger/dsh-openclaw-acp`：今天最短的官方组合路径

仓库：[BeAChanger/dsh-openclaw-acp](https://github.com/BeAChanger/dsh-openclaw-acp)。它不实现微信 SDK，而是把 dsh 作为 ACP agent 挂到 OpenClaw；微信由 Tencent 的 `@tencent-weixin/openclaw-weixin` channel 负责：

```text
微信 ClawBot/iLink → OpenClaw channel → ACPX → dsh --profile openclaw
```

优点：不复制 iLink 协议、不重复扫码/媒体/长轮询代码，最接近官方责任边界；OpenClaw 与微信插件升级由各自项目负责。

硬边界：该仓库 2026-08-14 仍是新仓（约 1 star），README 要求 OpenClaw 2026.7.1-2+、dsh 0.1.0-rc.6；ACP 当前支持新会话，不宣称 load/resume/fork/session listing；也不把 OpenClaw plugin tools 注入 Harness。它是“最短通道组合”，不是“dsh 全能力已打平”。

**判断：** 如果目标是今天先让 dsh 在个人微信里聊天，优先此路线；验收必须把 ACP 新会话、重启恢复、审批、文件工具和 cron 单独列成能力矩阵。

### B. `gnulife/dsh-plugin-wechat`：最快 demo，不是生产基线

仓库：[gnulife/dsh-plugin-wechat](https://github.com/gnulife/dsh-plugin-wechat)。它用一条命令安装 DSH、OpenClaw、Tencent 微信插件，再起一个 OpenAI 兼容 HTTP bridge。当前仓库为新仓、无 release/版本承诺，README 自述目前只支持文字，整体要维护 DSH web、HTTP bridge 和 OpenClaw gateway 三个运行面。

**判断：** 适合验证“扫码 → 微信消息 → dsh HTTP bridge → 回复”这条 happy path；不建议作为长期依赖。额外进程和 HTTP 桥会放大日志、会话、鉴权和重启问题，且它的“官方通道”来自借用 Tencent 插件，不代表 bridge 本身得到腾讯背书。

### C. 自写 protocol driver 直连 iLink：运行面最少，但授权面最不确定

它的优点是单进程、可复用 dsh `ctx.agents`/session persistence、可以自行实现重试/outbox/cron fallback；缺点是需要自己维护扫码、token、`getupdates`、媒体 CDN、错误码和服务端策略，且独立客户端是否超出 Tencent 官方插件的支持面没有公开答案。

**判断：** 不作为本次 MVP 的第一步。若将来必须移除 OpenClaw 中介，应先用专用账号和 fake iLink server 验证，再确认客户端实际展示的 ClawBot 条款允许该部署形态；不要因为 `ilinkai.weixin.qq.com` 是官方域名就跳过授权边界。

## 8. 如果今天就要落地的最小路径

### 个人微信体验优先

1. 固定 OpenClaw 与 `@tencent-weixin/openclaw-weixin` 兼容版本；当前仓库 README 的 2.x 需要 OpenClaw >=2026.3.22，2.4.6 包的 peer dependency 已提高到 >=2026.5.12，不能只看旧教程。
2. 用微信客户端 ClawBot 入口扫码，凭据只存本机受限目录；不要把 bot token 写入 dsh patch 或报告。
3. dsh 用 `dsh-openclaw-acp` 接入，先验收单聊、模型调用、审批/工具边界，再验收 cron。
4. 所有 cron 显式写 `channel: openclaw-weixin`、`to` 和 `accountId`；记录消息 ID、sendMessage `ret`、最近 inbound 时间、context token 年龄、OpenClaw `delivered` 与微信端实际到达的差异。
5. 24h/48h 静默窗口、连续主动消息额度、gateway 重启分别做测试；失败进入 outbox，转企业微信或人工查看，不静默吞掉。

### 可靠通知优先

直接采用企业微信官方应用/机器人线：dsh 在 Mac 本地运行，出站调用官方 API；入站按企业微信文档配置回调或长连接。个人微信 ClawBot可保留作日常交互入口，但不要把它作为唯一的生产告警出口。

## 来源与证据边界

### 官方/一手

- [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)：官方仓库、扫码安装、iLink API、收发能力、兼容性。
- [Tencent GitHub 组织（已验证控制 opensource.tencent.com）](https://github.com/Tencent)。
- [npm `@tencent-weixin/openclaw-weixin` registry metadata](https://registry.npmjs.org/@tencent-weixin%2fopenclaw-weixin)；[CLI package metadata](https://registry.npmjs.org/@tencent-weixin/openclaw-weixin-cli)。
- [腾讯云 OpenClaw 云桌面通道配置](https://cloud.tencent.com/document/product/1291/129132)：微信 ClawBot QR 绑定与企业微信机器人配置并列展示。
- [微信个人账号使用规范（微信官方）](https://weixin.qq.com/agreement/personal_account?lang=zh_CN)：未经腾讯开发/授权的第三方软件登录、使用或自动化，以及账号处置边界。
- [企业微信发送应用消息](https://developer.work.weixin.qq.com/document/path/90236)；[接收消息概述](https://developer.work.weixin.qq.com/document/path/90238)；[消息格式](https://developer.work.weixin.qq.com/document/path/90239)；[获取 access_token](https://developer.work.weixin.qq.com/document/path/91039)。

### 条款/生态的二手或运行证据（已标注用途）

- [社区镜像的《微信 ClawBot 功能使用条款》](https://github.com/hao-ji-xing/openclaw-weixin/blob/main/protocol.md)：用于核对条款文本中的“连接自身部署的第三方 AI”“频率/范围控制”“风险处置”“不保证可用性”表述；不是腾讯官网原始链接，正式使用前应以微信客户端展示版本复核。
- [Tencent/openclaw-weixin issue #202](https://github.com/Tencent/openclaw-weixin/issues/202)、[#225](https://github.com/Tencent/openclaw-weixin/issues/225)、[#185](https://github.com/Tencent/openclaw-weixin/issues/185)、[#191](https://github.com/Tencent/openclaw-weixin/issues/191)：用户报告/feature request，用于说明主动推送运行边界，不当作官方配额公告。
- [dsh-openclaw-acp](https://github.com/BeAChanger/dsh-openclaw-acp)、[dsh-plugin-wechat](https://github.com/gnulife/dsh-plugin-wechat)：dsh 接入形态的当前仓库证据，不代表腾讯对这些第三方 dsh bundle 的背书。

### 证据边界

“官方”在本文中只表示：微信 ClawBot 功能、Tencent 维护的 npm/GitHub 插件和其 iLink 后端属于腾讯产品线。它不表示 OpenClaw 本身由腾讯开发，也不表示独立复刻 iLink 的第三方程序自动获得同等授权、配额或 SLA。主动推送的 24–48 小时/约 10 条是公开 issue 的观察值，不能写成固定规则；任何生产决策都应在目标微信版本、账号和插件版本上做长时间静默窗口复测。
