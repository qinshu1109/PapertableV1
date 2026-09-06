# DeepSeek Harness「押注通知链路」落地 PRD

**研究截面：2026 年 8 月 25 日**

## 0. 决策摘要

最成立的链路不是“让某个 dsh 插件直接把会话事件推到手机”，而是：

```text
Paperweight 押注状态库
        │ 同一 SQLite 事务
        ▼
bet_signal + notification_outbox
        │
        ▼
本机自托管 ntfy
        │ 无 FCM；F-Droid 客户端常驻连接
        ▼
安卓锁屏系统通知
        │ click
        ▼
https://dsh.cozai.net/n/<短时能力令牌>
        │
        ▼
只读证据页 + 人工确认 POST
        │
        ├─ 确认 / 稍后提醒 / 进入结账
        └─ 打开完整 dsh：仍经过 CF Access OTP
```

其中：

* **Paperweight 是押注状态、信号与通知发件箱的唯一事实源。**
* **ntfy 只做无智能、无状态决策的运输层，不成为第二个工作流入口。**
* **完整 dsh 仍受 Cloudflare Access 保护。**
* **只给 `/n/*` 开一个极窄的、能力令牌保护的证据与处置面。**
* **MVP 不依赖任何 dsh 社区插件。**后续可选接入 `dsh-notifier`，但不能让它成为可靠性和状态一致性的核心。

dsh 本身确实适合通过 Cordis 服务、`session/event`、`agent/*` 和 WebSocket 下行做扩展与前台事件观察；但这些机制没有解决“浏览器关闭后唤醒国内安卓”的问题。Chrome 的标准 Web Push 会把消息路由到 FCM，因此纯 PWA 不符合你的前提；ntfy 的 F-Droid 客户端则可在自托管场景中不使用 FCM，通过前台服务维持连接。Cloudflare Access 又支持路径级应用和“更具体路径优先”，因此可以只放行 `/n/*`，而不拆掉整个 dsh 的 OTP。([GitHub][1])

---

# 1. 先纠正五个前提

## 1.1 “触达通道只有 dsh 一条”需要精确定义

如果它意味着：

> 手机上除了 dsh 网页，不允许安装任何运输层 App。

那么它与“无 FCM、浏览器关闭、锁屏即时弹起”不能同时成立。Chrome 把 Push API 的设备端推送服务硬编码为 FCM；自建 Web Push 服务端并不能替换 Chrome 设备端使用的推送服务。([Chrome for Developers][2])

建议把纪律具体化为：

> **唯一交互与处置面是 `dsh.cozai.net`；允许 ntfy/Gotify 作为无交互、无决策的系统通知运输层。**

这样，ntfy 里没有聊天、押注状态、结论和处置按钮；它只显示一句最小通知，并在点击后把人送回 dsh 域名。

若连这种运输层 App 也不接受，剩下的可行路线只有自研原生 dsh Android 壳，并自行实现前台服务、长连接、重连、开机恢复和通知渠道。那是候选架构 C，不适合先做。

## 1.2 “烂尾信号”不能凭空观察外部世界

你已经砍掉后台定时捞料，因此系统无法在无人检索时发现：

* 某外部指标变了；
* 某竞品发布了；
* 某平台政策改变了；
* 某个事实已经推翻押注。

没有观察者，就没有外部事件。

可成立的“烂尾信号”只能是：

1. **本地确定性规则**：结账日不足 72 小时但验证指标仍为空。
2. **停滞规则**：连续 N 天没有新增证据或人工触碰。
3. **前台研究结果**：dsh 本次主动检索产生了新的证据快照。
4. **人工录入**：你手动标记出现关键反证。

建议产品里不要把模型判断命名为“烂尾”；改成可解释的 `STALE_LOCAL`、`METRIC_MISSING`、`EVIDENCE_CHANGED`。模型可以提供证据，不应负责决定是否已经烂尾。

## 1.3 CF Service Token 解决不了普通通知深链

Cloudflare Service Token 要求请求带 `CF-Access-Client-Id` 和 `CF-Access-Client-Secret`，或者等价的自定义认证头。普通安卓通知点击产生的浏览器导航不能安全、透明地附加这些头，所以 Service Token 适合机器到机器，不适合作为通知深链的登录替代。([Cloudflare Docs][3])

因此这里应使用：

* Cloudflare 对 `/n/*` 做路径级 Bypass；
* Paperweight 原点自行校验短时能力令牌；
* 根路径继续用 Access OTP。

## 1.4 不要把押注状态写进 dsh 自定义会话事件

dsh 官方架构把 Session Event 定义为持久事实，也允许插件观察 `session/event`；但 rc.6 有一个已报告的缺口：第三方插件写入未知的自定义持久事件后，会话日志可能因无法识别事件类型而整体无法重开。([GitHub][1])

因此：

* dsh 会话只保存正常对话与工具轨迹；
* `dsh_session_id` 可以作为证据出处；
* 押注、信号、通知和处置状态继续放 Paperweight 的 SQLite；
* 不为押注新增自定义持久 Session Event。

## 1.5 `/api/v1/registry` 已不是全量快照

你给出的“`/api/v1/registry` 返回全量目录快照”已经过时。当前 API 文档说明它最多返回安装排序靠前的 500 项，`total` 才表示完整目录规模；需要全量时应分页读取 v2。搜索 API 匿名额度仍是每天 50 次、每分钟 10 次，结果结构包含 `installCount`。([GitHub][4])

---

# 2. 检索过程与命中/扑空

## 2.1 实际使用的资源

我检查了：

* DSH 1024Store 网站与插件详情页；
* 目录 GitHub 仓库及 API 文档；
* 各候选插件的 README、兼容性表和部分源代码；
* dsh 官方架构、GUI RPC 说明及 rc.6 相关讨论；
* Chrome Web Push 官方说明；
* ntfy、Gotify 官方 Android、发布、鉴权文档；
* Cloudflare Access 路径、Bypass、Service Token 与 Tunnel ingress 文档；
* B 站镜像页。

目录页面在本次检查时显示 **10,643 个插件、402 个“通知与集成”插件，数据更新于 2026 年 8 月 25 日**。B 站镜像页在当前抓取环境里只暴露空壳/嵌入页面，没有提供可独立交叉验证的数据。([DSH 1024Store][5])

### API 数据缺口

我实际尝试调用了搜索 API，但当前执行环境无法解析 `api.deepseek1024.com`，报 DNS 临时失败；网页工具也不允许直接打开带自定义查询参数的 API URL。因此：

* 目录身份、作者、星标、安装命令：已验证；
* `installCount` 字段存在：已由 API 文档验证；
* **下表中的具体 wrapper-CLI 安装量：未验证，不编造。**

你可在本机一次性补齐：

```bash
for q in \
  dsh-notifier \
  dsh-mobile \
  dsh-live \
  dsh-pocket \
  dsh-obvious-grid \
  dsh-notification \
  dsh-tool-notify \
  dsh-android
do
  curl -sG \
    --data-urlencode "q=$q" \
    'https://api.deepseek1024.com/v1/plugins/search' |
  jq --arg q "$q" '
    .results[] |
    select(.name == $q) |
    {
      name,
      owner,
      stars,
      installCount,
      install,
      pushedAt
    }'
done
```

API 文档确认搜索结果包含 `name`、`owner`、`stars`、`installCount` 和 `install` 等字段。([GitHub][4])

## 2.2 搜索词与判定

| 搜索词/方向                                        | 命中                                                  | 扑空或结论                                           |
| --------------------------------------------- | --------------------------------------------------- | ----------------------------------------------- |
| `ntfy`                                        | `dsh-notifier`、`dsh-tool-notify`、`dsh-obvious-grid` | 有发送适配器，但没有一个现成插件同时解决“押注状态、可靠 outbox、深链证据页、人工处置” |
| `gotify`                                      | `dsh-notifier` 内含 Gotify adapter                    | 本轮未发现高可信的独立 Gotify 专用 dsh 插件                    |
| `android`、`mobile`、`app`                      | `dsh-mobile`、`dsh-pocket`                           | `dsh-android` 是 ADB/模拟器开发工具，属于名称误命中             |
| `PWA`、`Web Push`、`FCM`                        | `dsh-live`                                          | `dsh-live` 明示没有后台 Push；Chrome Web Push 仍走 FCM   |
| `browser notification`、`desktop notification` | `dsh-notification`                                  | 只覆盖浏览器/桌面和 turn 完成，不是闭屏安卓运输层                    |
| `UnifiedPush`                                 | ntfy 官方支持相关概念                                       | 本轮目录检索未发现针对 dsh 押注链路的成熟 UnifiedPush 插件          |
| `Huawei`、`Xiaomi`、`OPPO`、`Vivo push`          | 无相关高置信目录命中                                          | 没有发现可直接组合的厂商推送 dsh 插件；此项是“本轮未命中”，不是数学意义上的不存在    |
| `webhook`                                     | 大量发送侧集成                                             | Webhook 只解决“从本机发出去”，不负责安卓系统通知和点击后的状态治理          |
| `Cloudflare Access path bypass`               | 官方支持路径级应用、具体路径优先和 Bypass                            | 可以只放行 `/n/*`                                    |
| `Cloudflare service token browser deep link`  | Service Token 要求自定义请求头                              | 不适用于普通通知点击导航                                    |
| `rc.6 custom session event`                   | 官方仓库讨论命中                                            | 不应把押注状态放进第三方持久 Session Event                    |

---

# 3. 目录插件实证

目录星标与 GitHub 仓库实时星标可能短暂不同。例如 `dsh-notifier` 目录显示 71★，仓库抓取时显示 67★；下表按你的要求统一采用**目录数字**。([DSH 1024Store][6])

| 插件                   | 目录数据                                                                                                 | 仓库/源码验证                                                                                                                                                                                                                        | 本方案判定                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| **dsh-notifier**     | 作者 `THEWOLFWALKER`；71★；安装量未验证；`dsh plugin --profile web add dsh-notifier` ([DSH 1024Store][6])       | 目录描述还停留在 8 通道，仓库当前称 27 通道，含 ntfy/Gotify。rc.6 消费其服务要静态声明 `inject=['notifier']`。但公共消息结构只有 title/content/level/group，ntfy adapter 只发送 topic/title/message/priority，Gotify adapter只发送 title/message/priority，均没有深链字段。([GitHub][7]) | **P3 可选，不进 MVP。**需补 URL 字段或绕过 adapter 直发     |
| **dsh-mobile**       | 作者 `saya-ch`；140★；安装量未验证；`dsh plugin --profile web add dsh-mobile` ([DSH 1024Store][8])              | Android WebView 薄壳、设备配对、Keystore、原生 Bridge；0.2.1 明确验证过 dsh rc.6。Bridge 有 `notification.show`，但这是已认证页面调用能力，未证明 App 关闭后仍有后台推送运输。([GitHub][9])                                                                                    | **原生路线的良好 fork 基座，不是现成后台推送解**                |
| **dsh-live**         | 作者 `zhoushuoshi-code`；1★；安装量未验证；`dsh plugin --profile web add dsh-live` ([DSH 1024Store][10])        | 提供 PWA、WebSocket relay、手机审批，但已知限制明确写着没有后台 Push Notification，rc.7 之后兼容性也不保证。([GitHub][11])                                                                                                                                      | **淘汰**                                       |
| **dsh-pocket**       | 作者 `shaobeichen`；629★；安装量未验证；`dsh plugin --profile web add dsh-pocket` ([DSH 1024Store][12])         | 手机同步访问、二维码、cloudflared、WebSocket 与密码；没有验证到闭屏后台系统推送。([GitHub][13])                                                                                                                                                              | 解决远程访问，不解决本题运输层；且与你现有 Tunnel 重叠              |
| **dsh-obvious-grid** | 作者 `ray062`；1★；安装量未验证；`dsh plugin --profile web add dsh-obvious-grid` ([DSH 1024Store][14])          | 能在 turn 结束、报错、待审批时向 ntfy 推送。([GitHub][15])                                                                                                                                                                                     | 可参考 rc.6 + ntfy 的代码骨架，但触发语义是 dsh 生命周期，不是单一押注 |
| **dsh-notification** | 作者 `omdsh-dev`；75★；安装量未验证；`dsh plugin --profile web add dsh-notification` ([DSH 1024Store][16])      | 目录定位为 turn 完成的桌面通知                                                                                                                                                                                                             | **淘汰**：不解决闭屏安卓、无 FCM                         |
| **dsh-tool-notify**  | 作者 `rizkirmdhnnn`；星标未提供；安装量未验证；未发布 npm，因此目录无安装命令 ([DSH 1024Store][17])                               | 模型可主动调用 ntfy/webhook                                                                                                                                                                                                           | **淘汰**：让模型掌握通知触发权，不符合正式状态由人/确定性规则发起的治理要求     |
| **dsh-android**      | 作者 `ZSeven-W`；115★；安装量未验证；`dsh plugin --profile web add @zseven-w/dsh-android` ([DSH 1024Store][18]) | 用 ADB 构建、运行和控制模拟器或 USB 设备                                                                                                                                                                                                      | 搜索误命中，与手机通知无关                                |

### 目录结论

目录中存在：

* 通用通知适配器；
* 手机访问/WebView 壳；
* turn 完成类通知；
* PWA/实时 WebSocket 手机界面。

目录中**没有验证到**一个可以直接完成以下闭环的插件：

```text
Paperweight 单一押注状态变化
→ 无 FCM 安卓锁屏
→ 带深链
→ 不撞 CF OTP
→ 展示证据出处
→ 人工、审计化处置
```

所以必然需要自研的部分不是“又造一个推送协议”，而是：

1. 押注信号与 transactional outbox；
2. 能力令牌证据页；
3. 人工处置命令与审计；
4. 运输适配层；
5. 可选的 dsh 桥接。

---

# 4. 产品定义

## 4.1 目标

当且仅当当前押注出现规定的状态变化时：

1. 安卓在锁屏/Doze 状态真正出现系统通知；
2. 点击通知不经过 Cloudflare 邮件 OTP；
3. 页面当场说明：

   * 什么发生了变化；
   * 哪条规则触发；
   * 有哪些证据；
   * 证据来自哪个 dsh 会话、人工输入或本地时间规则；
   * 数据生成时间与版本；
4. 用户明确发起处置；
5. 所有正式变更可审计、可防重、可拒绝过期操作。

## 4.2 非目标

本项目不做：

* 每日 digest；
* 后台定时检索外部信息；
* 模型自动判断“继续、放弃、结账”；
* 模型直接修改正式押注状态；
* 为通知深链取消整个 dsh 的 Access；
* 在 ntfy/Gotify 中发展第二套聊天与控制界面；
* 第一阶段自研 Android App。

## 4.3 四入口职责保持不变

| 入口          | 在本方案中的责任                            |
| ----------- | ----------------------------------- |
| 豆包          | 发散、检索个人笔记；不能直接改押注正式状态               |
| dsh         | 前台深挖、执行、验真，产出可引用的证据快照               |
| Papertable  | 开播前拆题、展开多个假设，避免对话过早收敛               |
| Paperweight | 押注状态机、指标、结账日、证据索引、信号、通知 outbox、处置审计 |

**把通知的事实源放在 Paperweight，而不是 dsh，是架构的核心。**

---

# 5. 状态与信号模型

## 5.1 允许通知的四类信号

| 信号                 | 触发方式                               | 是否需要外部检索 |
| ------------------ | ---------------------------------- | -------: |
| `SETTLEMENT_NEAR`  | `now >= settlement_at - lead_time` |        否 |
| `USER_TIMER_DUE`   | 到达用户明确设置的时刻                        |        否 |
| `EVIDENCE_CHANGED` | 前台 dsh 研究或人工输入产生新证据快照              |  由前台动作决定 |
| `STALE_LOCAL`      | 用户定义时间内无人工触碰/无证据更新，或结账将近但指标为空      |        否 |

没有后台观察时，不设计 `EXTERNAL_WORLD_CHANGED` 这类虚假能力。

本地到期检查可以使用进程内 timer；进程重启后再补算已经错过的到期点。这属于本地状态调度，不是后台捞料。

## 5.2 建议数据结构

```sql
bet(
  id,
  title,
  hypothesis,
  metric_spec_json,
  settlement_at,
  status,
  version,
  last_human_touch_at,
  last_evidence_at
);

evidence_snapshot(
  id,
  bet_id,
  created_at,
  source_kind,          -- dsh_session / human / local_rule
  dsh_session_id,
  items_json,
  content_hash
);

bet_signal(
  id,
  event_uuid,
  bet_id,
  kind,
  observed_at,
  bet_version,
  evidence_snapshot_id,
  reason_json,
  severity
);

notification_outbox(
  id,
  event_uuid,
  transport,            -- ntfy / gotify / native
  payload_json,
  attempts,
  next_attempt_at,
  sent_at,
  last_error
);

disposition_token(
  id,
  token_hash,
  event_uuid,
  expires_at,
  used_at
);

bet_command(
  id,
  command_uuid,
  bet_id,
  expected_version,
  kind,
  params_json,
  initiated_by,
  confirmed_at,
  result_json
);
```

## 5.3 事务边界

产生信号时，必须在**同一个 SQLite 事务**内写入：

```text
bet_signal
notification_outbox
```

事务提交后由同进程 sender 发送通知；进程重启时只重扫尚未成功的 outbox。这不是 digest，也不是检索任务，而是对已发生本地事件的可靠投递。

## 5.4 权限边界

不要只靠提示词维持“AI 不改状态”。应从接口上拆开：

```text
AI / dsh 桥接层
    只能：创建 evidence proposal 或提交证据快照
    不能：调用 bet_command

手机处置页
    GET：只读证据
    POST：显式人工命令 + expectedVersion + 一次性 nonce
```

正式状态变化只由 `bet_command` 执行。

---

# 6. 候选架构

## 架构比较

| 方案                                       | 运输层            | 目录插件                         |  自研量 |               符合度 | 主要死法                        |
| ---------------------------------------- | -------------- | ---------------------------- | ---: | ----------------: | --------------------------- |
| **A. Paperweight Outbox + ntfy F-Droid** | 自托管 ntfy 常驻连接  | MVP 无；后续可选 `dsh-notifier`    |    中 |            **最高** | 国产 ROM 杀前台服务；本机/Tunnel 离线   |
| **B. Paperweight Outbox + Gotify**       | 自托管 Gotify 长连接 | 可选 `dsh-notifier`，但需补 extras |    中 |                中高 | 电池优化直接杀掉 Gotify             |
| **C. 基于 dsh-mobile 自研原生壳**               | 自研前台服务/WSS     | `dsh-mobile`                 | 大至特大 | 严格“只有 dsh App”时最高 | Android/OEM、签名发布、dsh 版本维护成本 |

---

## 6.1 架构 A：ntfy F-Droid，推荐

### 插件清单

* **MVP 必需的目录插件：无。**
* P3 可选：`dsh-notifier`。
* 自研：Paperweight outbox、运输 adapter、证据页和处置 API。

### 数据流

```text
Paperweight 状态变化
  → 同事务写 signal + outbox
  → sender 直发自托管 ntfy
  → ntfy F-Droid 客户端前台服务接收
  → Android 系统通知
  → click 打开 /n/<token>
  → Paperweight 展示证据
  → 用户确认 POST
  → expectedVersion 校验
  → 写 bet_command + 更新 bet
```

ntfy 高优先级消息可以显示为弹出通知；即时投递依赖前台服务，在 Doze 下也能保持即时性。不启用即时投递可能延迟数分钟甚至数小时。F-Droid 版本不支持 FCM，在自托管场景中通过常驻连接工作。([ntfy][19])

### 为什么 MVP 绕开 `dsh-notifier`

当前 `dsh-notifier` 的 ntfy adapter 没有传 `click` 字段，公共 `push()` 契约也没有 URL。直接由 Paperweight 向 ntfy 发 JSON，反而更少一层、更能保证深链和 outbox 一致性。([GitHub][20])

后续接入时可以：

1. 给它的公共消息契约补可选 `url`；
2. ntfy adapter 映射为 `click`；
3. Gotify adapter 映射为 `extras.client::notification.click.url`；
4. 只允许 Paperweight 桥接源触发；
5. 关闭 turn/end、approval、error、模型 notify、入向聊天、长任务心跳、stall 和 digest。

`dsh-notifier` 当前仓库包含会话自动推送、模型工具、长任务心跳、stall、入向渠道及 daily digest 等能力，默认使用会违反你的“只为一个押注事件响”的纪律，因此不能开箱即用。([GitHub][7])

### 自研工作量

* Outbox 与幂等 sender：S–M；
* 短时能力令牌和只读证据页：M；
* 人工命令、审计、版本冲突：M；
* 可选 `dsh-notifier` URL 扩展：M。

### 死法与降级

**死法 1：国产 ROM 杀 ntfy 前台服务。**

降级顺序：

1. 关闭电池优化；
2. 允许自启动、后台运行和锁定任务；
3. 测试 F-Droid ntfy 的前台常驻；
4. 不达标则只替换运输 adapter 为 Gotify；
5. 两者都不达标才进入原生路线 C。

**死法 2：Mac mini、Paperweight、ntfy 或 Tunnel 离线。**

在“不放服务器”的纪律下，这是不可消除的单点。降级策略：

* outbox 保留未发事件；
* 恢复后补发；
* Paperweight 大屏持续显示红色未处理状态；
* 下一次打开 dsh 时显示待处理信号。

但离线期间无法保证按时弹手机通知，这是物理边界，不应在 PRD 中假装可用。

**死法 3：能力令牌泄露。**

缓解：

* 至少 128 bit 随机数；
* 数据库只存 token hash；
* 24–72 小时有效；
* 绑定 event、bet 和 bet version；
* 不把证据内容、ID 或敏感参数放在 URL；
* GET 只读；
* POST 使用一次性 action nonce；
* 页面无第三方脚本、图片和分析 SDK；
* `Cache-Control: no-store`；
* `Referrer-Policy: no-referrer`。

**死法 4：重复通知。**

使用稳定 `event_uuid`，建议唯一键：

```text
UNIQUE(bet_id, kind, bet_version)
```

或业务生成的唯一事件 UUID。

**死法 5：旧通知修改了新状态。**

每次 POST 携带 `expectedVersion`；版本不一致返回 HTTP 409，要求刷新证据。

---

## 6.2 架构 B：Gotify

### 插件清单

* MVP 可不装目录插件，Paperweight 直接调用 Gotify；
* 可选 `dsh-notifier`，但当前 Gotify adapter 没有发送通知点击 extras，需要补丁。([GitHub][21])

### 数据流

与架构 A 完全相同，仅替换：

```text
notification_outbox.transport = gotify
```

Gotify Android 支持通过：

```json
{
  "extras": {
    "client::notification": {
      "click": {
        "url": "https://dsh.cozai.net/n/<token>"
      }
    }
  }
}
```

设置通知点击 URL。([Gotify][22])

### 优点

* 自托管模型成熟；
* 推送接口简单；
* 原生支持通知点击 URL；
* transport adapter 易于编写。

### 死法

Gotify 官方 Android 文档直接说明：启用电池优化时，Android 可能杀掉 Gotify，之后收不到通知；需要手工关闭电池优化。([GitHub][23])

这和你的核心验收“锁屏真正弹起”正好重合，因此不能凭功能表选它，必须真机跑杀进程、Doze、重启、网络切换测试。

### 降级

Outbox 与证据页不变，只把 adapter 切回 ntfy。正因为如此，transport 不应侵入押注状态机。

---

## 6.3 架构 C：基于 `dsh-mobile` 自研原生 dsh App

### 插件清单

* `dsh-mobile`，目录 140★，rc.6 已验证；
* 自研 Android 前台通知服务。

### 要新增的能力

在现有 WebView、配对、Keystore 和 Bridge 基础上增加：

* Android Foreground Service；
* 面向 Paperweight 的专用 WSS/长轮询；
* 通知渠道和 Android 13+ 通知权限；
* 网络切换重连与指数退避；
* Boot Receiver；
* OEM 电池优化引导；
* App Link/deep link；
* 设备密钥与撤销；
* 签名 APK、升级与兼容性测试。

`dsh-mobile` 已经是 rc.6 兼容的 Android WebView 基座，并具备 Keystore 和受限原生 Bridge；但现有资料没有证明其在 App 关闭或页面未连接时提供后台通知运输。([GitHub][9])

### 自研量

L–XL，远大于前两种方案。

### 死法

* 前台服务仍可能被 OEM 杀；
* 需要长期维护 Android 构建、签名和发布；
* dsh Web/API 变化带来兼容性维护；
* App 丢失或设备密钥泄露时需要撤销流程；
* 你尚未证明“多装一个纯通知 App”真的影响日常体验。

### 适用条件

只有在架构 A 实测后，同时满足以下条件才启动：

* ntfy 在目标手机上可靠性不达标；
* Gotify 也不达标；
* 或者你实际使用后确认“必须只有一个 dsh App”，且愿意承担长期 Android 维护。

---

## 6.4 明确淘汰：PWA + Web Push

这条不进入候选实施：

* Chrome Web Push 最终走 FCM；
* `dsh-live` 明确没有后台 Push；
* `dsh-notification` 是桌面 turn 完成通知；
* WebSocket 只能服务仍连接的客户端；
* 即便收到通知，直接深链完整 dsh 仍会撞 Access OTP。([Chrome for Developers][2])

---

# 7. 推荐架构的详细设计

## 7.1 Cloudflare 路由

建议保留同一 Tunnel，增加一个 path route 和一个 ntfy 子域：

```yaml
ingress:
  # 必须在 dsh catch-all 之前
  - hostname: dsh.cozai.net
    path: ^/n/.+$
    service: http://127.0.0.1:4317

  - hostname: dsh.cozai.net
    service: http://127.0.0.1:3080

  - hostname: push.dsh.cozai.net
    service: http://127.0.0.1:8090

  - service: http_status:404
```

`cloudflared` 会自上而下匹配 ingress，最后必须有 catch-all；可用命令验证实际命中规则。([Cloudflare Docs][24])

```bash
cloudflared tunnel ingress validate

cloudflared tunnel ingress rule \
  https://dsh.cozai.net/n/test

cloudflared tunnel ingress rule \
  https://dsh.cozai.net/
```

## 7.2 Cloudflare Access 配置

创建两个 Access Application：

| Application       | 路径                  | 策略                |
| ----------------- | ------------------- | ----------------- |
| `dsh-full`        | `dsh.cozai.net/*`   | 当前邮件 OTP          |
| `dsh-disposition` | `dsh.cozai.net/n/*` | Bypass / Everyone |

Cloudflare 文档说明多个规则覆盖共同根路径时，更具体的路径优先；也明确支持只对特定公共 endpoint 配置 Bypass。([Cloudflare Docs][25])

**注意：Bypass 等于 Cloudflare 不再替你认证。**因此 `/n/*` 的安全性必须完全由能力令牌和 Paperweight origin 实现。

验收不能只看页面能打开，要同时验证：

```bash
# 仍应进入 Access
curl -I https://dsh.cozai.net/

# 不应进入 Access；无效 token 应由 Paperweight 返回 404
curl -I https://dsh.cozai.net/n/not-a-valid-token
```

## 7.3 ntfy 自托管配置

最低安全配置：

```yaml
base-url: "https://push.dsh.cozai.net"
listen-http: "127.0.0.1:8090"
behind-proxy: true

auth-file: "/path/to/ntfy-auth.db"
auth-default-access: "deny-all"
```

ntfy 默认访问并不是私有模式；官方建议私有实例把 `auth-default-access` 设置为 `deny-all`，再为发布者和订阅者配置明确权限。([ntfy][26])

建议创建：

* 一个 Paperweight 发布 token：只允许写 `bet-alert`；
* 一个手机订阅用户/token：只允许读 `bet-alert`；
* topic 名仍使用随机值，但不能把“难猜 topic”当成唯一认证。

## 7.4 通知格式

锁屏上只展示最低必要信息：

```text
标题：押注状态变化
正文：结账日临近 · 3 条证据待看
优先级：4
点击：/n/<token>
```

不要在锁屏暴露押注全文、反证内容或个人资料。

直接发送示例：

```bash
curl \
  -H "Authorization: Bearer $NTFY_PUBLISH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "bet-alert",
    "title": "押注状态变化",
    "message": "结账日临近 · 3 条证据待看",
    "priority": 4,
    "click": "https://dsh.cozai.net/n/<opaque-token>"
  }' \
  https://push.dsh.cozai.net
```

ntfy 官方支持为通知配置 click URL，点击后打开浏览器或相应 App。([ntfy][27])

## 7.5 不要用 ntfy HTTP Action 直接改状态

ntfy 支持通知按钮在点击时直接发 HTTP 请求，而且默认就是 POST。这个能力适合开车库门之类的操作，但不符合你的治理纪律：通知误触就可能直接形成正式状态变化。([ntfy][27])

正确流程是：

```text
点击通知
→ GET 证据页
→ 阅读证据
→ 点“处置”
→ 显示确认
→ POST 人工命令
```

## 7.6 证据页内容

`GET /n/<token>` 建议固定为一屏：

```text
押注：首场“玩 AI”直播是否按期完成

状态变化：
结账日距今 24 小时，验证指标“已完成首场直播”仍为空。

触发规则：
SETTLEMENT_NEAR
observed_at: 2026-xx-xx xx:xx
bet_version: 7

证据：
1. Paperweight 中没有直播完成记录
2. 最近一次大纲更新：……
3. 最近一次 dsh 验真会话：……
   session_id: …
   evidence_hash: …

可执行：
[已看到]
[提醒我 3 小时后]
[进入结账复盘]
[打开完整 dsh]
```

模型生成的文字要标为：

```text
AI 摘要，非结论
```

确定性触发规则与原始证据分开展示，避免把模型措辞伪装成状态事实。

## 7.7 处置安全

建议能力令牌分两层：

1. **view token**：通知 URL 使用，可重复读取，短时有效；
2. **action nonce**：页面加载时生成，单次 POST 后失效。

POST 请求至少携带：

```json
{
  "command_uuid": "uuid",
  "expected_version": 7,
  "action_nonce": "...",
  "kind": "snooze_until",
  "params": {
    "until": "..."
  }
}
```

服务端规则：

* token 过期：410；
* token 不存在：404；
* nonce 重放：409 或 410；
* `expected_version` 过期：409；
* 同一 `command_uuid` 重试：返回原执行结果；
* GET 不能写任何正式状态；
* 最终 `settle`、`cancel` 建议二次确认。

---

# 8. 观测指标

仅记录服务器接受发送还不够，因为那不能证明 Android 真正展示了通知。最低观测链路应为：

```text
signal_created_at
outbox_published_at
evidence_page_opened_at
command_confirmed_at
```

核心指标：

| 指标                                  | 用途                       |
| ----------------------------------- | ------------------------ |
| `publish_latency_p50/p95`           | Paperweight 到 ntfy 接受的延迟 |
| `page_open_rate`                    | 通知是否实际把人带回证据页            |
| `signal_to_open_latency`            | 从事件到人工注意到的时间             |
| `open_to_command_latency`           | 证据吸收与处置耗时                |
| `outbox_oldest_age`                 | 是否存在积压                   |
| `duplicate_notification_rate`       | 幂等性                      |
| `stale_command_conflict_rate`       | 是否经常点旧通知                 |
| `non_human_formal_transition_count` | 必须恒等于 0                  |
| 手机 12 小时增量耗电                        | 运输层是否可接受                 |

ntfy 文档中维护者给出的常驻连接耗电只是其个人设备上的估算，不能替代你的目标手机实测。([ntfy][28])

---

# 9. 分期落地规划

## P0：运输层生死测试

### 范围

* Mac mini 自托管 ntfy；
* `push.dsh.cozai.net` Tunnel；
* 鉴权与 deny-all ACL；
* 安卓安装 ntfy F-Droid；
* 用 curl 手动发送优先级 4 通知；
* 暂时不接 Paperweight、不改 CF Access。

### 真机矩阵

至少测试：

* 亮屏；
* 锁屏 5 分钟；
* 锁屏 30 分钟进入 Doze；
* ntfy 从最近任务划掉；
* Wi-Fi 切 4G；
* 4G 切 Wi-Fi；
* 短时断网后恢复；
* 手机重启；
* Mac 上 ntfy 重启；
* Tunnel 重启；
* 电池优化开启/关闭对照。

### 验收

* 20 次测试至少 19 次真正显示系统通知；
* 在线情况下 p95 小于 30 秒；
* 锁屏能够弹出；
* 点击能打开一个测试 URL；
* 确认使用的是 F-Droid/常驻连接路径，不依赖 FCM；
* 12 小时增量耗电在你可接受阈值内，建议先设为不高于对照组 3 个百分点。

### 证伪/砍线

在完成 OEM 白名单、自启动和电池优化设置后，仍低于 95%：

* **立即停止 ntfy 后续开发；**
* 用相同矩阵测试 Gotify；
* 两者都失败才评估原生方案。

不要在 P0 失败的运输层上继续建设漂亮的证据页。

---

## P1：纵向最小闭环

### 范围

* Paperweight 增加一个“手动产生测试信号”按钮；
* 写入 `bet_signal + notification_outbox`；
* sender 直发 ntfy；
* `/n/<token>` 返回静态/半静态只读证据；
* Cloudflare 只对 `/n/*` Bypass。

### 验收

1. 点击“产生信号”后手机锁屏弹通知；
2. 点击后不出现 Cloudflare OTP；
3. `https://dsh.cozai.net/` 仍然出现 Access 登录；
4. 无效 token 返回 404；
5. 过期 token 返回 410；
6. GET 证据页导致的正式数据库状态变化为 0；
7. 同一 `event_uuid` 重复提交只出现一条通知；
8. 通知正文不泄露完整押注内容。

---

## P2：可靠投递与人工处置

### 范围

* outbox 重试；
* 进程重启恢复；
* action nonce；
* `bet_command`；
* 乐观锁；
* 审计记录；
* `ack`、`snooze`、`enter_review`；
* 最终结账/取消的二次确认。

### 验收

* 停掉 ntfy，创建信号，再恢复：最终只送达一次；
* 停掉 Tunnel，创建信号，再恢复：outbox 不丢；
* 重放已用 nonce：被拒绝；
* 对旧 bet version 发命令：返回 409；
* 同一 `command_uuid` 重试不会重复变更；
* 每个正式状态变化都有人工确认时间、来源设备和前后版本；
* AI、dsh 模型工具或普通证据接口不能调用 command handler；
* 进程重启后能补算已经错过的本地到期点，但不执行外部检索。

---

## P3：dsh 生态集成——可长期推迟

### 范围

* 仅在 `web` profile 安装 `dsh-notifier`；
* 自研 Paperweight→notifier 桥接层；
* 根据当前版本补充深链 URL 支持；
* 把 dsh 前台研究完成事件关联到 `evidence_snapshot`；
* 不在 `cc-tui`、`dsh-tui` 重复安装，避免多 profile 重复触发。

dsh 官方允许通过 profile 组合插件，并可用 `dsh --profile web --dump-config` 检查实际启动的插件树。([GitHub][1])

### 必须关闭

* 自动 turn/end 通知；
* approval/error 泛通知；
* 模型 `notify` 工具；
* 入向对话；
* 长任务 heartbeat；
* stall 通知；
* daily digest。

### 验收

* 只有 Paperweight 押注桥接来源能生成押注通知；
* 普通 dsh turn 完成不响；
* 审批、报错和心跳不响；
* 直接 sender 路径和插件路径通过同一套 contract test；
* 卸掉 `dsh-notifier` 后，Paperweight→ntfy 主链仍然工作。

**P3 不是上线前置。**直接 Paperweight→ntfy 已经是完整产品。

---

## P4：原生 dsh Android 收敛——可以整个砍掉

### 启动条件

仅当真实使用证明：

* ntfy/Gotify 在目标 ROM 上不可用；
* 或额外运输 App 的体验确实不可接受；
* 且你愿意长期维护 Android App。

### 范围

基于 `dsh-mobile` fork 增加前台服务、专用事件流和系统通知。

### 验收

重复 P0 全部矩阵，另加：

* 冷启动；
* 手机重启；
* App 强杀；
* 系统升级；
* 签名版本升级；
* 设备撤销；
* dsh rc.6 回归；
* Tunnel 断线恢复；
* App Link 正确落到证据页。

### 砍线结论

**P4 可以永久删除。**

只要架构 A 达到可靠性与体验要求，自研 App 没有足够回报。

---

# 10. 只有周末两天的最小路径

## 周六上午：只证明手机能响

1. 安卓安装 ntfy F-Droid。
2. Mac mini 启动 ntfy，监听 `127.0.0.1:8090`。
3. 设置 `auth-default-access: deny-all`。
4. 创建发布 token 和订阅账号。
5. 增加 `push.dsh.cozai.net` Tunnel ingress。
6. 用 curl 发 priority 4 通知。
7. 完成锁屏、Doze、Wi-Fi/4G 和重启测试。

**上午退出条件：达不到 19/20，不继续做网页。**

## 周六下午：打穿 OTP，但只开一条缝

1. 增加 `/n/* → 4317` 的 ingress，放在 dsh catch-all 之前。
2. 创建更具体的 Access Application：

   * `/n/*` Bypass；
   * 根 dsh 保持 OTP。
3. 在 Paperweight 写一个最简 token 路由。
4. 返回一页固定证据。
5. 验证：

   * `/n/valid-token` 不撞 OTP；
   * `/n/bad-token` 返回 404；
   * `/` 仍撞 OTP。

## 周日上午：接出一条真实纵向链

1. 增加：

   * `bet_signal`；
   * `notification_outbox`；
   * `disposition_token`。
2. Paperweight 加一个“产生测试状态变化”按钮。
3. 同事务写 signal 和 outbox。
4. sender 直接向 ntfy 发 JSON，带 click URL。
5. 增加 `event_uuid` 幂等。

## 周日下午：只做一条规则和一次人工处置

只实现一个规则，例如：

```text
settlement_at - 24h
```

只实现两个动作：

```text
已看到
提醒我 3 小时后
```

然后跑完整 20 次测试矩阵并记录：

* 信号时间；
* ntfy 接受时间；
* 页面打开时间；
* 人工动作时间；
* 是否重复；
* 是否撞 OTP；
* 是否有非人工状态变化。

## 周末明确不做

* 不装 `dsh-notifier`；
* 不做 PWA；
* 不做 Web Push；
* 不做原生 App；
* 不做 Gotify，除非 ntfy P0 失败；
* 不做通知按钮直接 POST；
* 不做模型主动 notify；
* 不做 daily digest；
* 不做外部后台检索；
* 不做最终 settle/cancel。

## 周末完成定义

周日结束时，以下六项同时成立才算完成：

1. 手机锁屏真正弹通知；
2. 点击后直接看见证据，不经过 OTP；
3. 完整 dsh 根路径仍受 OTP 保护；
4. GET 页面不会修改正式状态；
5. 重复事件只产生一条通知；
6. sender/ntfy 短暂故障后，未发事件能够恢复投递。

---

# 最终推荐

**选架构 A。**

实施顺序是：

```text
先杀运输风险
→ 再打通窄深链
→ 再做可靠 outbox
→ 再做人工处置
→ 最后才考虑 dsh 插件整合
```

最重要的架构判断有三个：

1. **dsh 是证据生产和最终工作台，不应是押注通知状态的事实源。**
2. **ntfy 是可替换的哑运输层，不是第二个交互入口。**
3. **CF Access 不应整体拆除；只为短时能力令牌证据页开一条经过严格约束的窄路。**

因此，MVP 的插件清单为空不是缺陷，而是在避免把状态一致性、深链、安全和可靠性错误地捆绑到一个仍在快速变化的社区通知插件上。后续接入 `dsh-notifier` 应当是可拔掉的适配优化，而不是系统成立的前提。

[1]: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md "deepseek-harness/docs/architecture.md at master · deepseek-ai/deepseek-harness · GitHub"
[2]: https://developer.chrome.com/docs/extensions/how-to/integrate/web-push "Use Web Push  |  Chrome Extensions  |  Chrome for Developers"
[3]: https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/ "Service tokens · Cloudflare One docs"
[4]: https://github.com/imsai-sh/awesome-deepseek-harness-plugins/blob/main/docs/api.md "awesome-deepseek-harness-plugins/docs/api.md at main · imsai-sh/awesome-deepseek-harness-plugins · GitHub"
[5]: https://deepseek1024.com/plugins "DeepSeek Harness Plugin Marketplace | DSH 1024Store"
[6]: https://deepseek1024.com/plugins/THEWOLFWALKER/dsh-notifier "dsh-notifier — DeepSeek Harness Plugin by THEWOLFWALKER"
[7]: https://github.com/THEWOLFWALKER/dsh-notifier "GitHub - THEWOLFWALKER/dsh-notifier: Unified notification push plugin for DeepSeek Harness (DSH): one minimal notify() API, 8 channel adapters (telegram/dingtalk/feishu/wxpusher/pushplus/serverchan/bark/webhook), dual trigger (auto session events + agent tool). · GitHub"
[8]: https://deepseek1024.com/plugins/saya-ch/dsh-mobile "dsh-mobile — DeepSeek Harness Plugin by saya-ch"
[9]: https://github.com/saya-ch/dsh-mobile "GitHub - saya-ch/dsh-mobile: DeepSeek Harness 移动端适配与安全访问插件，支持局域网、远程连接、Android App 和手机浏览器。 · GitHub"
[10]: https://deepseek1024.com/plugins/zhoushuoshi-code/dsh-live "dsh-live — DeepSeek Harness Plugin by zhoushuoshi-code"
[11]: https://github.com/zhoushuoshi-code/dsh-live/blob/main/CHANGELOG.md "dsh-live/CHANGELOG.md at main · zhoushuoshi-code/dsh-live · GitHub"
[12]: https://deepseek1024.com/plugins/shaobeichen/dsh-pocket "dsh-pocket — DeepSeek Harness Plugin by shaobeichen"
[13]: https://github.com/shaobeichen/dsh-pocket "GitHub - shaobeichen/dsh-pocket: 把 DeepSeek Harness 装进你的口袋：电脑上跑 dsh web，手机扫码即同步访问（局域网 + 公网，实时同屏）Put DeepSeek Harness in your pocket: run dsh web on your computer and access it synchronously by scanning a QR code on your phone (LAN + public network, real‑time screen mirroring) · GitHub"
[14]: https://deepseek1024.com/plugins/ray062/dsh-obvious-grid "dsh-obvious-grid — DeepSeek Harness Plugin by ray062"
[15]: https://github.com/ray062/dsh-obvious-grid "GitHub - ray062/dsh-obvious-grid · GitHub"
[16]: https://deepseek1024.com/plugins/omdsh-dev/dsh-notification "dsh-notification — DeepSeek Harness Plugin by omdsh-dev"
[17]: https://deepseek1024.com/plugins/rizkirmdhnnn/dsh-tool-notify "dsh-tool-notify — DeepSeek Harness Plugin by rizkirmdhnnn"
[18]: https://deepseek1024.com/plugins/ZSeven-W/dsh-android "dsh-android — DeepSeek Harness Plugin by ZSeven-W"
[19]: https://docs.ntfy.sh/subscribe/phone/ "From your phone - ntfy"
[20]: https://github.com/THEWOLFWALKER/dsh-notifier/blob/main/PLUGINS.md "dsh-notifier/PLUGINS.md at main · THEWOLFWALKER/dsh-notifier · GitHub"
[21]: https://github.com/THEWOLFWALKER/dsh-notifier/blob/main/src/adapters/spec-channels.mjs "dsh-notifier/src/adapters/spec-channels.mjs at main · THEWOLFWALKER/dsh-notifier · GitHub"
[22]: https://gotify.net/docs/msgextras "Message Extras | Gotify"
[23]: https://github.com/gotify/android "GitHub - gotify/android: An app for creating push notifications for new messages posted to gotify/server. · GitHub"
[24]: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/ "Configuration file · Cloudflare One docs"
[25]: https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/ "Application paths · Cloudflare One docs"
[26]: https://docs.ntfy.sh/config/ "Configuration - ntfy"
[27]: https://docs.ntfy.sh/publish/ "Sending messages - ntfy"
[28]: https://docs.ntfy.sh/faq/ "FAQs - ntfy"
