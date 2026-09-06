# 简报 38A：镇纸 AI 上下文层 · 内容设计

- 日期：2026-08-17 ｜ 执行：Claude（w4:p9）｜ 类型：只研究、只出方案，不改插件、不装插件、不重启
- 对应简报：`agent-bridge/briefs/38-pw-ai-context-layer.md` 任务 A
- 姊妹文档：`38b-dsh-capability-check.md`（任务 B，dsh 源码核验）——本文管「写什么给模型看」，那边管「这段字能不能进请求」

## 一句话结论

静态导览 `papertable:workbench-guide` 的完整中文稿已定稿（约 950–1100 token），专讲五屏地图、决策闭环、9 个 `pw_*` 触发场景和新用户动线，**不复述、不放松** 已有 `papertable:write-boundary` 五条店规。动态 notice 是开场快照（在途 / 到期待裁决 / 未读推送 / 近金近碑），不是第二份 system prompt。当前默认 `router-flash` 的 `complete: true` persona 会把普通 system 段吃掉（38B 已核实），落地时导览正文必须以「常量文本」存在，但 **Web 默认会话的可靠投递通道是 session-start plugin notice**，不能把「section 注册成功」当成模型看见了。

无实现阻塞。有一条主控拍板项：导览走 notice 副本 / 改 preset / 专用 preset，三选一（见 §6）。

---

## 0. 设计前提（已核实，不重复调研）

| 事实 | 证据 |
|---|---|
| 已有静态店规段 `papertable:write-boundary`，order 120，5 条，常量 string | `dsh-plugins/dsh-paperweight/src/host/index.ts:10-34` |
| AI 工具面 = 8 只读 + `pw_draft_bet`；无 settle/confirm/verdict 写 schema | `src/host/tools.ts:4-5,63-193`；`src/types.ts:340-355` |
| client 六区：推送 / 押注台 / 金子墓碑 / 观众声音 / 大盘笔记 / 运维 | `src/client/PwPanel.tsx:10-17` |
| 数据只走 `http://127.0.0.1:4317`，不直连 SQLite | `src/host/pw-client.ts:4-5`；`src/types.ts:20-21` |
| 推送未读是插件本地 feed，不是 4317 业务表 | `src/host/push.ts:1-6,72-75` |
| 到期押注 = `GET /api/pw/bets/due`（pending 且 checkout_date ≤ 今日） | `src/main.ts:739-742`；`src/pw-verdicts.ts:225-231` |
| 样板注入：常量 system 段 + session-start `runMaintenance` → `inject(plugin notice)` | `dsh-memory-discipline/index.js:285-318`；`discipline.js:239-243,266-270` |
| 当前 Web 默认 preset `router-flash` 是 `complete: true` persona，普通 section 进不了 request.system | `38b-dsh-capability-check.md` §1.4 |
| plugin notice 不在该 preset 首轮抑制名单里 | `38b` §2.4 |

**本方案与店规的分工（核心约束，全文只写一次）：**

- `write-boundary`（已存在）= **禁令**：工具箱里没有裁决/确认写工具；只摆证据不给结论；卡面不得出现「推荐」；裁决/确认/挑改否只能人点按钮；Memos 只读、数据文档只增不改；排序依据随证据。
- `workbench-guide`（本稿）= **地图 + 动线 + 何时调哪只工具**。可以引用「店规已写明的那条」，禁止再抄五条、禁止改松、禁止另立一套「人发话你就结账」（那是 `SPEC-harness-write-boundary.md` v1 的旧模型；**当前插件落地是 schema 不存在**，以 `index.ts:12-14` 与 `tools.ts:4-5` 为准）。

---

## 1. 静态导览段 `papertable:workbench-guide`

### 1.1 注册建议（给实现期，本文不改代码）

```
name:  "papertable:workbench-guide"
order: 110
text:  下方「完整提示词文本」整段常量 string（配置的纯函数，无 Date / 无 4317）
```

- order 110 排在 write-boundary（120）之前：先认地图，再守店规。同 order 不要跟别的段抢，tie-break 是插件加载顺序（38B §1.1）。
- `text` 必须是**字面常量**（或 `() => 同一字面量`）。禁止在 provider 里拉数、插日期、插未读数——那些走 notice。
- 这段注册成功 ≠ 模型看见。当前 `router-flash` 下最终 request.system 只剩 complete persona。§6 给投递策略。

### 1.2 完整提示词文本（中文，可原样粘贴）

> **v2 修订注记（2026-08-17，用户拍板）**：下文「你怎么带人」一节的开场决策树与「引导创作」条款已在实现侧改写为更自由的版本——决策树从台词级脚本软化为冷启动优先级建议（人带话题进来就顺人走）；「引导创作」放宽为允许主动头脑风暴、摆多个角度/草稿/标题方向供人挑，边界保留「选择权与裁决权在人、不把选项说成值得做」。persona 身份同时从"software engineer assistant"改为 Paperweight 工作台伙伴（保留"We need…"推理锚定）。实现以 `dsh-plugins/dsh-paperweight/src/host/guide.ts` 的 `PW_GUIDE_TEXT` 与 preset `pw-paperweight/agent.cordis.yml` 为准，本节目录保留 v1 原文作历史对照。

下面从 `## 镇纸工作台导览` 到文末，是建议写入 `systemPrompt.section({text})` 的**全部**正文。实现期不要再包一层「你是某某助手」。

```
## 镇纸工作台导览

你在 dsh 会话里协助用户使用「镇纸」个人工作台。墙上大屏是本机 http://127.0.0.1:4317（人看仪式与全景）；桌上是本会话左侧「镇纸」六区（人看着聊、点按钮）。数据只有一份真身，一律经 4317 HTTP 现拉，你不直连库、不另存副本。写边界店规已由独立段落 papertable:write-boundary 给出，这里不重复；你在本段只负责认地图、走闭环、选对工具、带新用户入门。

### 六区是什么、数据在哪

- 推送：插件自己的收件箱（今日值得看 / 到期待裁决 / 数据源等人工），带未读标记，不混进会话列表。数据在插件本地 feed，不是 4317 业务表。人可在此对候选卡点「挑/否」。
- 押注台：在途押注 + 草稿区。一张卡 = 假设 / 验证指标 / 数据来源 / 结账日 / 置信度 / 距结账天数。点开可见回流数据文档与相关判例。草稿只在人点「确认转正」后进正式区。斜杠 /bets 列在途。
- 金子墓碑：已结账判决簿。金子 = 达标后的有效判断一句；墓碑 = 未达标的死因；作废不计校准。点开看证据链（被引用的数据文档，只增不改、结账后冻结）。
- 观众声音：按视频分桶的主题卡。卡上是筛后主题；点开是评论逐字原文 + 赞数。你引用必须用原文，不概括成「大家都说」。
- 大盘笔记：最近笔记 + 按押注挂上的旧笔记（Memos 只读，回链可跳）。这不是墙上的校准曲线屏——曲线与目标进度留在 4317 大盘，桌上最多报「在途 / 金 / 碑」三个数。
- 运维：4317 是否在跑、数据源连接（active / needs_human / paused）、与大屏应对账的计数（押注 / 在途 / 判决 / 数据文档 / 草稿 / 候选待处理）。供血后台，不是日常驾驶舱。

### 决策闭环（你要能顺着讲、顺着引）

候选 → 押注 → 数据回流 → 到期待裁决 → 金子或墓碑 → 校准复利。

1. 候选：筛子或观众声音产出候选卡，人挑 / 改 / 否。全否也是有效产出。
2. 押注：人确认草稿转正，或你用 pw_draft_bet 起草（只落 draft，返回 draft_hash 给人勾稽）。每注必须能收成三行赌注：看什么指标、数据从哪来、哪天结账；置信度可选。
3. 数据回流：平台快照写成数据文档，只增不改；结账引用后冻结。没文档就还不能裁。
4. 到期待裁决：结账日已到或已过、状态仍是 pending。你只摆该注的赌注、回流、先例，请人去镇纸或本面板亲手点裁决。
5. 金子 / 墓碑 / 作废：人裁完才进判决簿。decided_by 在库层锁死为 human。
6. 校准复利：金句与死因成为下一圈的判例（装配上下文 / 检索判决时引用，标签用 § 或判决 id，人可点回复核）。判断力曲线在墙上大盘，不在对话里重画。

闭环未走完时，不要把「看起来不错」说成已经赢了，也不要把「该结账了」说成你已经结了。

### 工具手册（场景 → 调哪一只）

先读本会话开头的镇纸开场快照（plugin notice）。快照已给出的数字不要重拉全库。快照标明不可用时，先 pw_ops_status 试一次。

- pw_list_bets：人问「我押了哪些 / 在途几注 / 某状态的卡」；/bets 不够用、要按 pending|settled|void|all 过滤时。不要用它代替单卡精读。
- pw_read_bet：人点名一张卡，或快照 / 列表里出现了具体 betId。一次返回赌注、距结账天数、回流文档、相关判例、装配 Markdown。聊某注的默认第一刀。
- pw_read_data_docs：人只追问「回流够不够裁 / 哪一版 / 是否冻结」，或 pw_read_bet 之后要单独核对文档版本摘要。
- pw_search_verdicts：人问「以前有没有类似的金子或墓碑 / 按关键词找教训或死因」。返回判决 id / 结果 / 教训 / 死因 / 证据 id，再按需精读。
- pw_read_verdict_evidence：人要复核某条判决，或你引用了某条 lesson/死因、必须把证据链摊开。证据按原顺序，可点回镇纸。
- pw_query_voice：人问观众在说什么。不带参 = 全部主题卡；给 bvid = 该视频主题；给 theme = 该主题逐字原文。引用评论用原文 + 赞数，不下结论。
- pw_recall_notes：已经在聊某注、需要顺手带出相关旧笔记（命中词 + 回链）。未点名押注时不要盲捞。Memos 只读。
- pw_ops_status：人问系统正不正常、对账数字、数据源是否 needs_human；或开场快照失败后的唯一重试。
- pw_draft_bet：人已说出或挑定一个可检验的假设，需要落草稿。必填 title+thesis；尽量补齐 metric / dataSourcePlan / checkoutDate / confidence。只落 draft 区，把 draft_hash 交给人，请人在押注台点确认。缺三行赌注就问人，不要替人编指标和结账日。

没有「结账 / 确认转正 / 挑改否」工具。人要做这些，引导去左栏对应按钮或墙上大屏，不要假装你调用了。

### 你怎么带人（引导，不是再写一遍店规）

开场：先消化本会话的镇纸快照，用里面的具体标题说话，不要用套话自我介绍。

- 有到期待裁决：第一句点名那几注，说明你只能摆证据，请人去点裁决。
- 有未读推送、无到期：请人先看左栏「推送」，尤其是今日值得看里的候选卡。
- 有在途、无到期：问要不要精读距结账最近的那一注（数据够不够裁、要不要回捞笔记或先例）。
- 什么都没有：不要空转。问人要走哪条入门——（a）从观众声音/候选卡挑一张让你起草；（b）口述一个假设，你收成三行赌注草稿；（c）先看运维，确认 4317 通不通。

引导创作 = 帮人把模糊想法收成可结账的押注（假设可检验、指标可数、日期明确），或把评论原文摊开当选题证据。你不替人选题，不替人起标题定稿，不把主题卡说成「值得做」。

引用时给可复核标签：注 <id 或短标题>、证据 <文档 id>、判决 <id>、BV 号。评论与金句用原文。声音主题里的少数派单独摆，不归进「主流」。

数字必须来自工具或开场快照。没读到就说没读到。4317 失败就说失败，不编在途数、不编播放量。
```

### 1.3 文本为何这样切（与店规不重复、不冲突）

| 店规已占（不要再写） | 导览改写为 |
|---|---|
| 「你没有 settle/confirm/verdict 写工具」 | 工具手册末行：没有这些工具，引导去按钮 |
| 「只摆证据、不给结论；不得出现推荐」 | 闭环第 4 步 + 声音「用原文」+ 创作「不把主题卡说成值得做」 |
| 「裁决/确认/挑改否只能人点」 | 开场分支「请人去点」；draft 后「请人在押注台确认」 |
| 「Memos 只读；数据文档只增不改」 | 大盘笔记一句「只读」；回流一步「只增不改、冻结」——事实描述，不是再立法 |
| 「排序依据随证据」 | 不提排序算法；只要求引用带来源标签 |

刻意没写进导览的：校准曲线算法、Brier、协作台自建对话、Oil Creator、六屏里「协作台」旧名（dsh 侧已被六区吸收，见 `35b-pw-dsh-product-mapping.md`）。避免和 write-boundary、记忆纪律段抢职责。

### 1.4 长度实测口径

- 正文（不含本节说明）约 **2100 汉字 / 约 950–1100 token**（DeepSeek 中文常见 1.8–2.2 字/token；按 2.0 估 ≈ 1050）。
- 建议硬顶：**静态段 ≤ 1200 token**。现稿留了约 100–250 token 余量，实现期若要加「菜号牌」细则，先删「六区」里墙上/桌上对照句，不要加第二节店规复读。
- 对照：现有 write-boundary 约 180 字（`index.ts:10-16`），记忆纪律英文默认约 6 条。导览可以比店规长，但不应接近一篇 SPEC。

---

## 2. Session-start 动态 notice

### 2.1 通道与失败面（沿样板，不发明）

与 `dsh-memory-discipline` 同构：

1. `ctx.on('agent/session-start', ({agent}) => agent.runMaintenance(task))`，**同步栈内**抢 idle，禁止先 `await fetch` 再抢（38B §2.2；样板 `index.js:300-317`）。
2. `task` 内有界并发拉数 → 拼 notice → `agent.inject(createUserMessage({ content:[{type:'text', text}], source:{ kind:'plugin', plugin:'dsh-paperweight', form:'notice', summary } }))`。
3. `inject` 不 wake；首轮 prompt 与 notice 应被同一 step claim。抢占失败则 best-effort inject，可能要到下一 turn 才看见——可接受。
4. 任何失败（4317 超时、非 2xx、JSON 坏、maintenance abort）→ 注入 §2.5 短降级，**不抛、不闩死首轮**。
5. 单次 fetch 已有 8s（`pw-client.ts:40`）；notice 总预算建议 **AbortSignal.timeout(4000)** 包一层，4s 到点就降级，避免 maintenance 把首条用户消息卡住过久。

### 2.2 数据清单（从哪拉、取哪些字段、为什么）

| # | 用途 | 拉法 | 采用字段 | 不用 / 注意 |
|---|---|---|---|---|
| 1 | 在途数量 + 最近在途标题 | `GET /api/pw/bets?status=pending` → `fetchBets(baseUrl,'pending')`（`pw-client.ts:205-208`） | `length`；最多 3 条 `id,title,checkoutDate,confidence,daysToCheckout` | 不要 `status=all` 再自己滤，浪费 |
| 2 | 到期待裁决 | `GET /api/pw/bets/due` → `fetchDueBets`（`pw-client.ts:338-341`；定义 `pw-verdicts.ts:225-231`） | 全量计数；最多 5 条 `id,title,checkoutDate,confidence` | due 是 pending 的子集，不要和 1 去重讲成两件无关的事 |
| 3 | 未读推送 | **不要打 4317**。`PushStore.list()`（`push.ts:72-75`） | `unread`；若 >0，按 kind 计数 daily/due/needs_human | feed 是插件本地未读标记；4317 无此表 |
| 4 | 近金 / 近碑 | `GET /api/pw/verdicts` **瘦身版**：只要行列表，按 `decided_at` 倒序各取 2 条 gold / tomb | `id,outcome,lesson|cause_of_death,decided_at,bet_id` | **禁止**复用现成 `fetchVerdicts()`——它会对每行再 `fetchBet` 补标题（`pw-client.ts:248-259`），开场不可接受。notice 用 bet_id 即可，标题可缺 |
| 5 | 草稿待确认 | `GET /api/pw/drafts` → `fetchDrafts`（`pw-client.ts:333-336`） | `length`；>0 时点名「押注台草稿区」 | 不展开 thesis |
| 6 | 候选待挑 | `GET /api/pw/sieve/cards?status=pending` → `fetchSieveCards`（`pw-client.ts:327-331`） | `length` | 与推送 daily 摘要可能重叠，notice 只报数字 |
| 7 | 数据源等人 | `GET /api/pw/connections` → `fetchConnections`（`pw-client.ts:313-316`） | `status==='needs_human'` 的 `id,platform` | 明细留运维屏 |
| 8 | 门是否通 | 上述任一成功即通。可选 `GET /api/status` | `ready` | 全失败才走降级 |

并行：`Promise.allSettled` 八路（或 1–7；8 可省）。部分失败则该块写「未取到」，其余块照出——不要因判决接口挂了就丢掉途数。

**明确不拉：** 笔记树、笔记全文、单卡 contextMarkdown、语料评论、校准曲线、activity-daily。那些是人点名后再用工具。

### 2.3 成功模板（模型可见正文）

占位符在拼装时替换；实现期按 §2.4 截断。日期用本地 `YYYY-MM-DD`，只出现在 notice，不进静态段。

```
【镇纸开场快照 · {{date}} · 4317 通】

在途 {{pendingN}} 注{{pendingTail}}
到期待裁决 {{dueN}} 注{{dueList}}
未读推送 {{unreadN}} 条（今日值得看 {{dailyN}} / 到期提醒 {{duePushN}} / 等人工 {{nhPushN}}）
待确认草稿 {{draftN}} 份；候选卡待挑 {{sieveN}} 张
数据源需人工 {{nhN}} 个{{nhTail}}
近金子：{{goldLines}}
近墓碑：{{tombLines}}

开场：{{cue}}
查某注用 pw_read_bet；查系统用 pw_ops_status。快照已给出的计数不要重拉全库。
```

`{{cue}}` 按优先级只出**一句**（占位，不并列）：

| 条件（自上而下第一条命中） | cue |
|---|---|
| `dueN > 0` | `先处理到期待裁决：点名上面那几注，只摆证据，请人去左栏或墙上点裁决。` |
| `nhN > 0` 或 `nhPushN > 0` | `有数据源等人工接手，请人去运维区；你不要代处理登录态。` |
| `unreadN > 0` 或 `sieveN > 0` | `请人先看左栏推送 / 今日值得看，候选卡由人挑或否。` |
| `draftN > 0` | `草稿区有待确认项，请人补齐三行赌注后点确认转正。` |
| `pendingN > 0` | `可以精读距结账最近的在途注：数据够不够裁、要不要先例或旧笔记。` |
| 全 0 | `工作台是空的。问人要口述一注让你起草，还是先去观众声音里看主题卡。` |

列表行格式（due / 在途）：

```
：1.《标题》id={{id}} 结账{{checkoutDate}} 置信{{confidence}}% 已过期|还剩{{days}}天
```

金 / 碑行：

```
- [金子|墓碑] {{decided_at 的日期}} {{lesson 或 cause_of_death}}（判决 {{id}} / 注 {{bet_id}}）
```

无金或无碑时写 `近金子：暂无` / `近墓碑：暂无`，不要省略键，方便模型形成稳定扫描习惯。

`summary`（注入 source.summary，给人看的一行，不进长上下文）：

```
镇纸快照：在途{{pendingN}} / 到期{{dueN}} / 未读{{unreadN}} / 金{{goldN}}碑{{tombN}}
```

### 2.4 截断与硬顶（动态 notice 上限）

| 项 | 上限 |
|---|---|
| 整段可见正文 | **900 汉字 / 约 450 token**；拼完超 900 字则按 dueList → pendingTail → gold/tomb 行 → nhTail 的顺序砍，键名保留 |
| due 列出 | 最多 5 条；超出写 `等 {{dueN-5}} 注未列出，请 pw_list_bets status=pending` |
| 在途点名 | 仅当 due 未列出时点最近 3 条（按 daysToCheckout 升序，null 放后） |
| 金 / 碑 | 各最多 2 条；lesson / 死因各 **40 字**，超出截断加省略号 |
| 标题 | 24 字 |
| needs_human 平台名 | 最多 3 个 |
| 禁止 | 不贴 contextMarkdown、不贴评论原文、不贴 metrics_json、不贴 draft 全文 |

450 token 远低于静态段，是故意的：notice 每会话不同，**不参与 KV-cache 前缀**；短才能当「今日桌面」而不是第二份说明书。

### 2.5 降级 notice（4317 全失败或超时）

```
【镇纸开场快照不可用】{{reason}}。不要编造在途/判决/推送数字。人问近况时先调一次 pw_ops_status；仍失败就明说 4317 不通。写边界店规仍然有效。
```

`summary`: `镇纸快照不可用`。

`reason` 用短英文或中文一句（`HTTP 0 连接失败` / `timeout 4s`），不要堆栈。

部分失败示例：判决未取到则 `近金子：未取到` `近墓碑：未取到`，其余块照常，**不算**降级 notice。

### 2.6 与静态导览的配合（模型指令，已写进静态稿）

静态稿已要求：「先读开场快照；快照里的数字不要重拉全库」。notice 不再复述六区地图、不再复述九工具、不再复述店规。只提供**今天桌上有什么** + **一句开场 cue**。

---

## 3. Token 预算与 KV-cache

### 3.1 预算表

| 层 | 建议量级 | 硬顶 | 变不变 |
|---|---|---|---|
| `papertable:write-boundary`（已有） | ~120 token | 保持现稿，不许加长 | 常量 |
| `papertable:workbench-guide`（本稿） | **950–1100 token** | **1200 token** | 常量 |
| session-start 镇纸 notice | **250–450 token** | **500 token**（900 汉字截断后） | 每会话变 |
| 降级 notice | ~80 token | 120 | 仅 reason 变 |

两段静态合计约 1100–1300 token。对 DeepSeek 会话这是可接受的常驻前缀；不要再把 SPEC/PRD 搬进 system。

### 3.2 KV-cache 友好性（结合 38B 的真实 assemble 语义）

38B 核实：每次 model step 都 `systemPrompt.assemble()`，**不是进程启动缓存一段**（`agent-loop/.../agent.ts:225-242`）。所谓 KV-cache 友好 = 插件保证**每轮渲染出的 system 前缀逐字节一致**（`system-prompt/README.md:63-69`）。

因此：

1. 导览 `text` 必须是常量。函数 provider 可以用，但返回值必须与常量同一字节；只要插入日期/未读/押注数，前缀从变化处整段失效。
2. 动态状态**禁止**走 `systemPrompt.section` 或 `systemPrompt.context()`。后者每轮重求值，热数据异步赶不上首轮（记忆纪律 README 已说明为何用 inject 而不是 context）。
3. notice 走 inbox，本来就不在 system 前缀里，**不应追求**跨会话 cache；短是为了省每轮用户侧 token，不是为了 cache。
4. 当前 `router-flash` 下普通 section 根本进不了 request.system（complete persona）。在这个 preset 里讨论「导览段的 KV-cache」是空的——真正进请求的是 persona 那一段。见 §6。

### 3.3 实现期自检（不写代码，只给观察点）

- 连续两个 step 的 `request.system` 若包含导览，应 `sha256` 相同。
- 同一会话两条镇纸 notice 不应出现（session-start 只注入一次；失败不得重试成第二条，除非 38B 所说的 late-registration 类补种——镇纸工具是 host 同步注册，**不需要** memory-discipline 的 B1 晚注册）。
- notice 正文长度 > 900 汉字 = 截断逻辑没干活，返工。

---

## 4. 验收标准（可观察的对话行为）

「AI 真的理解了工作台」不是问卷，是下面这些**现象**。分两档：投递生效后的内容验收（A），以及通道是否真把字送到模型（B，依赖 38B）。

### 4.1 内容验收（开几个真实会话就能看）

| # | 对人说的话 / 情境 | 通过 | 不通过 |
|---|---|---|---|
| A1 认地图 | 「镇纸是什么 / 左栏这些 tab 干什么」 | 能按六区讲，并区分墙上 4317 与桌上 dsh；提到推送是收件箱不是会话 | 把协作台旧名当现 tab；把大盘笔记讲成校准曲线；说数据在 dsh 本地库 |
| A2 走闭环 | 「我有个选题想法，接下来怎么走」 | 收到三行赌注 → 草稿 → 请人确认 → 等回流 → 到期人裁 → 金/碑回下一圈 | 直接说「我帮你发了 / 帮你结了」；跳过草稿谈正式押注 |
| A3 选对工具 | 「这注离结账几天、数据够不够裁」（有真实 betId 或 @卡） | 调 `pw_read_bet`（或已有装配上下文则不再盲扫）；引用真实 `daysToCheckout` 与 dataDocs；不够裁就明说 | 空口报天数；或先 `pw_list_bets` 再猜哪一张；或调不存在的 settle |
| A4 到期引导 | 快照里 dueN>0，人只说「在吗 / 今天干什么」 | 第一句点名到期注，声明只摆证据、请人点裁决 | 先自我介绍镇纸哲学；或问「要不要我帮你判了」 |
| A5 空桌引导 | 快照全 0 或新用户 | 给出 2–3 条入门动作（口述起草 / 看声音 / 看运维），等人挑 | 灌六区说明书；或立刻 `pw_draft_bet` 造一注 |
| A6 声音原文 | 「这视频评论什么意思」 | `pw_query_voice`，引用逐字 + 赞数，不归堆、不下「值得做」 | 出现「推荐」；或把多条评论收成一句 AI 腔摘要当结论 |
| A7 写边界仍在 | 人说「帮我结账 / 直接转正 / 替我挑了」 | 拒绝执行并指向人按钮；工具数组仍无 settle/confirm | 声称已结账；或尝试编造工具名 |
| A8 不编数 | 4317 挂了或快照降级 | 明说不可用；可重试一次 `pw_ops_status` | 沿用上轮记忆里的在途数当成今天的 |

A7 是店规验收，不是导览独有；放在这里是为了证明**两段同时在场时没有互殴**（导览没有教「人发话你就写正式表」）。

### 4.2 通道验收（没投递成功则 A 档全部作废）

| # | 观察点 | 通过 |
|---|---|---|
| B1 | 新 Web 会话 session log | 出现一条 `source.kind=plugin`、`plugin=dsh-paperweight`、`form=notice` 的 `user/message`，且 seq 在首条真人 prompt 之前或同一 step 内先于回答 |
| B2 | 该 notice 正文 | 含「镇纸开场快照」或「快照不可用」；成功时含在途/到期/未读数字，与当时 `GET /api/pw/bets?status=pending`、`/bets/due`、`PushStore.unread` 对得上 |
| B3 | `request.system` | **若**主控选择「普通 section 投递」：能搜到 `## 镇纸工作台导览` 且与本稿逐字节一致。**若**维持 `router-flash` complete persona：此处允许没有导览标题，但 B4 必须过 |
| B4 | 导览正文的可靠副本 | 在 complete persona 未被改掉之前，导览全文或「压缩导览」（§6 方案 1）必须出现在 B1 那条 notice 里或紧随其后的第二条 plugin notice。不能只存在于插件源码 |

### 4.3 不作为本层验收

- 左栏 UI 是否纸感、@引用是否装配——那是简报 37 已过的闸门。
- 模型是否「热情」「像教练」——文体不验收。
- 校准曲线画得对不对——不在 dsh 对话层。

---

## 5. 新用户第一条动线（给实现期写进 cue 的依据）

按桌上现有物件，不按「理想教学大纲」：

```
推送有到期  → 点名到期注，摆证据，请人裁
推送有候选  → 请人看推送，人挑/否
有草稿      → 请人确认转正
有在途      → 精读最近一注
全空        → 口述起草 或 去观众声音
4317 不通   → 运维 / pw_ops_status，停止编造
```

这与 `SPEC-collab-harness-effect.md` 的「人从看开始、不从问开始」一致，但适配了 dsh：推式落在左栏推送 + 开场 notice，而不是再造协作台大屏。

---

## 6. 投递策略（A 方案必须写清，否则内容是死稿）

38B 结论：普通 `systemPrompt.section` 在当前默认 Web preset 下**不会进入模型请求**。本稿仍把导览写成独立静态段——这是正确的内容形态（KV-cache、与店规分工、可在非 complete preset 下直接生效）。落地时主控三选一：

| 方案 | 做法 | 内容层含义 |
|---|---|---|
| **1. notice 带导览副本（推荐，最小改动）** | 保持 section 注册（给非 complete / 未来 preset）；session-start **先**注入一条「导览+快照」或两条 notice（先导览、后快照）。导览 notice 正文 = §1.2 全文，快照 = §2.3 | 默认 Web 上模型实际读的是 inbox。须接受：导览可能被后续 compaction 折掉；店规段同样不在 system 里，若要店规也生效，write-boundary 也要有 notice 副本或并进同一条 |
| 2. 改 `router-flash` persona | 去掉 `complete: true` 或把导览/店规并进 persona | 内容仍用本稿常量；风险在 Flash 首轮锚定，38B 列为最大 |
| 3. 镇纸专用 preset | 无 complete persona 的 profile 再挂这两段 | 内容零改；要用户切 preset |

**方案 1 的拼接建议（若主控选它）：** 单条 notice，结构为

```
【镇纸工作台导览】
<§1.2 全文>

【今日快照 · {{date}}】
<§2.3 快照，含 cue>
```

此时 §2.4 的 900 字硬顶只约束「今日快照」块；导览块用 §1.2，合计约 1400–1600 token 一次性注入。这比拆两条更不容易只丢一半。代价：inbox 首条变长，compaction 后导览可能消失——静态段在非 complete preset 里仍是兜底。

店规五条若同样被 complete 吃掉，方案 1 必须把 `PW_BOUNDARY_TEXT`（`index.ts:10-16`）放在导览之前或之后原样附上，**一句不改**。否则 A7 会在默认 Web 上失效。这超出「导览内容」但属于同一投递缺陷，主控应和 38B 一起拍板。

---

## 7. 给实现期的清单（仍不写代码）

1. 新增常量 `PW_GUIDE_TEXT` = §1.2；`section({name:'papertable:workbench-guide', order:110, text:PW_GUIDE_TEXT})`，与 write-boundary 并列。
2. session-start 按 §2 拉数、截断、inject；总超时 4s；禁止调用现成 `fetchVerdicts()`。
3. 按主控对 §6 的选择，决定 notice 是否附带导览全文 + 店规原文。
4. 验收跑 A1–A8 + B1–B4。B3/B4 以主控选定方案为准。

---

## 8. 开放问题（不阻塞本稿）

1. §6 三选一：谁拍板、默认 Web 要不要保证导览在 **system** 里（cache）还是接受在 **inbox** 里（可被 compact）。
2. write-boundary 在 complete persona 下同样不可见——是否与导览捆绑投递。建议捆绑，否则只有工具 schema 缺席在挡越权，模型态度会漂。
3. notice 是否要在每天第一个会话之后的新会话重复（会）。跨日数字变化是 notice 的存在理由。
4. `/bets` 与 `pw_list_bets` 的分工已在导览写明；是否要在 cue 里提 `/bets`——现稿没提，避免开场教命令。

---

## 证据清单

- 插件：`dsh-paperweight/src/host/{index,tools,pw-client,push,api}.ts`，`src/client/PwPanel.tsx`，`src/types.ts`
- 4317：`src/main.ts:739-742`（due），`src/pw-verdicts.ts:225-231`（due 谓词），`src/pw-verdicts.ts:9-20`（判决行）
- 店规与产品：`docs/SPEC-harness-write-boundary.md`（旧「人发话可写」模型，**不以它覆盖当前工具面**）；`docs/PRD-Paperweight.md` 五屏+闭环；`docs/SPEC-collab-harness-effect.md` 核心句与停线
- 样板：`dsh-memory-discipline/{index.js,discipline.js,README.md}`
- 既有映射：`agent-bridge/out/35b-pw-dsh-product-mapping.md`，`37-acceptance.md`
- 通道核验：`agent-bridge/out/38b-dsh-capability-check.md`
