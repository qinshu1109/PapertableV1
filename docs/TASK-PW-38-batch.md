# TASK-PW-38 笔记通路批说明

- 日期：2026-08-08
- 状态：**PW-38、PW-39、PW-40、PW-41 全部验收（2026-08-08），批次收口**；域修订 v0.6 已拍板并生效（`docs/REQUIREMENT-DOMAINS.md`）
- 依据：2026-08-08 笔记通路讨论（flomo 顺手但 codex 接入要 299/年且内置 AI 非旗舰；用户拍板三条写进规格——节奏热力图 + 笔记视图 + 按押注回顾）；开源调研结论（Memos 自托管为速记层底座）

## 这批是干什么的（白话）

你现在的速记痛点：flomo 用得顺手，但 AI 要读到它得交 299/年，它内置的 AI 也不是你要的旗舰模型。这批做完之后的日常长这样——

手机上想记什么，打开微信发一句（或打开 Memos 记一句），没了。镇纸这边多一个「笔记」屏：进去能翻能搜你记过的所有东西，顶上有一张"记录节奏热力图"，一眼看出你最近哪天记了哪天没记；还有一栏"和你在押的注相关的旧笔记"——你正在做"AI 工具对比"的内容，它就帮你把三个月前记的相关灵感捞出来，不用你自己翻。每天收工小结里也会多一段"旧笔记回响"，替你回想。

**不自研笔记软件。** 记的活交给自托管的 Memos（免费、数据在你自己机器上、开源），AI 的活归 HanaAgent/MemOS（比 flomo 的 AI 强），镇纸只管看、捞、回顾。微信入口走公众号中继小脚本，本批先不做，列为后续候选。

## 怎么算好（白话）

- Memos 在你机器上跑起来，记一条能读回，flomo 的老笔记想搬也能搬进去。
- 镇纸导航多一个「笔记」屏：列表能翻、关键词能搜、标签有结构图、顶上有节奏热力图。
- 屏上"相关旧笔记"栏和收工小结"旧笔记回响"段：押注卡换一张，捞上来的旧笔记跟着换。
- 每刀过三道门：测试全绿、真实库冒烟、屏刀再加 ego 截图核对。你只在批次拍板和每刀验收时出场。

---

以下给干活的看，可以跳过。

## 关键裁定：第七屏装什么（2026-08-08 与用户确认的方向）

「笔记」成为镇纸第七屏（探索 / 押注台 / 协作台 / 数据源 / 观众声音 / 大盘 / **笔记**）。三条需求的上屏方式：

| 需求 | 形态 | 落点 |
|---|---|---|
| 笔记视图（列表/搜索/标签结构图） | 屏 | 第七屏主体 |
| 节奏热力图 | 屏内组件（可复用设计，本批只挂第七屏，不动协作台大屏） | 第七屏顶部 |
| 按押注回顾 | **机制，不是屏** | 输出口两处：第七屏「相关旧笔记」区 + 协作台收工小结「旧笔记回响」段 |

裁定律：按押注回顾是"捞"的动作，不是"看"的场所；把它做成机制而不是屏，是为了让回顾结果同时能进收工小结，不被锁死在一个入口里。

## 域归属修订提案 v0.6（先拍板，再开工）

笔记通路的读取与回顾在现有五域无完整自然归属，按 `docs/REQUIREMENT-DOMAINS.md` 规则 2 提议：

- 「实践与数据回收」负责追加：**外部笔记库只读连接**（与 B 站语料抓取同源的"外部数据接入"职责；笔记库=本地 SQLite 文件路径即连接，无登录态、无同步任务，比平台连接更简）。**笔记真值源留在 Memos 库，镇纸不复制、不拥有、不改写**（单一真值源纪律）。
- 「内容生产」负责追加：**笔记回顾捞取与节奏呈现**（按当前在途押注捞相关旧笔记、笔记节奏统计，服务选题与素材的查找降负——与"筛子降低筛选成本"同一价值方向）。无新正式表（捞取与统计均为只读计算；收工小结事件沿用 pw_runs）。
- 跨域接口追加：**提供笔记读取**（实践与数据回收 → 内容生产：只读消费笔记条目全文/标签/创建时间，附回链；不改写笔记库）。

Fallback（若不修订）：笔记连接并入「内容生产」域内自接自读——不推荐，外部数据接入语义与 B 站语料同源，归回收域才一致。

## 批次范围（4 刀）

| TASK | 交付 | 主需求域 | 依赖 |
|---|---|---|---|
| PW-38 Memos 本地落座 | Memos 在 Mac mini 跑起来（Docker 优先，官方二进制兜底）+ 库文件路径固定 + API token + flomo 导出数据导入（可选子项） | —（运维票，无镇纸代码） | 无 |
| PW-39 笔记只读连接与读取函数 | 只读打开 Memos SQLite（immutable）+ 读函数四件（列表/搜索/节奏统计/按关键词捞）+ 回链（Memos web URL）+ 测试 | 实践与数据回收 | PW-38 |
| PW-40 按押注回顾捞取 + 收工小结「旧笔记回响」 | 按在途内容押注卡（标题/thesis 关键词）捞相关旧笔记的读函数（确定性关键词匹配起步，不用 LLM）+ day-summary 加「旧笔记回响」段 + 测试 | 内容生产 | PW-39 |
| PW-41 第七屏「笔记」 | 导航+路由+笔记列表/搜索/标签结构图（先标签树）+ 节奏热力图组件 + 「相关旧笔记」区（吃 PW-40 读函数）+ 集成路由 + ego 视觉验收 | 内容生产 | PW-39、PW-40 |

执行顺序：PW-38（主会话陪用户做，不派子代理）→ PW-39 → PW-40 与 PW-41 串行（PW-41 收口）。PW-39/40 派 DeepSeek 子代理，PW-41 屏刀按惯例主代理亲做前端与视觉验收。

## 逐刀四字段

### PW-38 Memos 本地落座（运维票）

- 主需求域：—（运维票，无代码变更）
- 业务接口：无
- 数据真值源：Memos 自身 SQLite 库（镇纸侧不建表）
- 质量约束与验收终态：Memos 本地可访问、记一条能读回；库文件绝对路径确认并记录（写入本票验收记录，供 PW-39 使用）；API token 签发于本机保存；可选：flomo 导出文件经 API 脚本导入，488 条全到、条数对账；不做公网暴露

### PW-39 笔记只读连接与读取函数

- 主需求域：实践与数据回收
- 业务接口：提供笔记读取（新接口，供 PW-40/41 消费）
- 数据真值源：Memos SQLite 库（只读，immutable 打开；镇纸不建镜像表、不落快照——Memos 库本身就是"本地文件原料层"）
- 质量约束与验收终态：读函数四件——列表（分页/按时间）、搜索（关键词 LIKE）、节奏统计（按日聚合格热力图直接可用）、按关键词捞（供回顾）；每条带回链 URL；**对 Memos 库零写入断言**；Memos 服务停机时读取优雅报错不崩；mock 库单测 + 真实 Memos 库冒烟；verify 全绿

### PW-40 按押注回顾捞取 + 收工小结「旧笔记回响」

- 主需求域：内容生产
- 业务接口：提供笔记读取（消费，PW-39 提供）
- 数据真值源：只读消费笔记读取结果与 pw_bets（在途内容押注卡）；无新正式表
- 质量约束与验收终态：捞取输入=当前在途内容押注卡的标题/thesis 关键词，输出=相关旧笔记 1~3 条（确定性匹配起步：关键词重叠度排序，不用 LLM——防平庸纪律：宁缺毋滥，捞不到就老实说没有）；无在途押注时输出为空态文案而非硬捞；day-summary 加「旧笔记回响」段（沿用九档分类纪律，不破坏既有对账锚点）；mock 单测 + 真实库冒烟（真实押注卡换来换去，捞取结果跟着变）；verify 全绿

### PW-41 第七屏「笔记」

- 主需求域：内容生产
- 业务接口：提供笔记读取（消费）
- 数据真值源：只读消费 PW-39/40 读函数；前端无本地存储
- 质量约束与验收终态：导航新增「笔记」入口与路由；列表分页可翻、关键词可搜、标签树可折叠展开；节奏热力图按日着色（近一年）；「相关旧笔记」区随当前选中押注卡联动刷新；空库/服务停机有空态；大屏与其余五屏零改动；ego 截图区块核对 + UI 数据流回归（搜索→点回链跳 Memos、切押注卡→相关区刷新）；verify 全绿

## 范围外（本批明确不做）

- 微信订阅号中继脚本（需注册订阅号 + 公网回调部署在 cozai 服务器；独立小脚本，与镇纸仓库无关，后续单独立票）
- 笔记进筛子（筛子输入仍是评论语料；速记是否进筛产选题，用一段时间再拍板）
- Obsidian 目录读取（同一套只读连接思路的第二来源，等 Memos 跑顺再接；届时若发现重复规则再整理，不预先抽象）
- 节奏热力图上协作台大屏（组件按可复用写，但本批只挂第七屏；用了觉得值再加格）
- 每日回顾推送（邮件/Telegram 定时推旧笔记；先看屏内回顾够不够用）
- AI 参与捞取排序（本批确定性关键词匹配起步；不准再升级，不预先上 LLM）

## 验收记录

### 笔记通路接线：协作台 B4「笔记 · 待来源通路」灰行变实 —— 验收通过（2026-08-09，主会话直接执行，屏刀惯例）

**白话**：协作台「多源可视化」里那条灰着的「笔记 · 待来源通路」变成真数据了：共多少条、近 7/30 天新增多少，跟着时间窗切换走；条形用灰调（示弱于视频来源的 accent 色）表明「笔记不进归因链」。书/文章还没通路，灰行继续留着。Memos 万一挂了，笔记行自动退回灰行，不装活。

**给干活的看**：

- `pw-notes.ts` 加 `countPwNotes`（NORMAL 总条数）；`pw-source-stats.ts` 加 `PwNotesLane`/`notesLane` 字段 + `collectNotesLane`（status 探活 → 总数 + dailyStats 窗口求和；任何异常回退 null），pendingLanes 动态化（notesLane 在则只剩书/文章）；口径注释：笔记新增按本地自然日聚合（同第七屏热力图），与 cutoff 滚动窗有口径差，仅作活跃度指示。
- 测试：`pw-source-stats.test.ts` 全文件 MEMOS_DB_PATH 指向不存在路径（确定性隔离，照 PW-40 先例）+ 测试 1 补 notesLane=null 断言 + 新测试 9（临时笔记库：7 天窗 {total:2, addedInRange:1}、30 天 {2,2}、归档不计、pendingLanes 单行）。
- 前端：api.ts `PwSourceComparison` + notesLane 类型；Collab.tsx B4 在来源行与灰行之间渲染笔记实行（条形宽 = 新增/maxCandidates 上限 100%，沿用块内「相对最热行」语义）；pw.css `.is-notes` 灰调条形。
- verify（亲跑）：**226/226 全绿**（225+1），selfcheck ok，前端 build 成功。
- 真实冒烟（亲跑）：重启后端后 `/api/pw/source-stats?range=7` → notesLane={total:490, addedInRange:30}、pendingLanes=["书/文章"]；range=30 → {total:490, addedInRange:59}。
- ego 视觉验收（亲做，1900×969 全图 + 区块原生分辨率裁剪）：DOM 五行结构正确（3 视频行 + 笔记 is-notes + 书/文章 is-pending），笔记行灰调实行、文案「共490条 · 近7天新增30 · 不进归因链」，书/文章条纹灰行「待来源通路」保留。
- 排障留痕：ego captureScreenshot 再次超时 → 重启 ego lite 恢复（老毛病）。
- 偏差与如实说明：①条形比例尺沿用块内「相对最热行」语义——笔记新增 30 对视频产卡 4，笔记条形满格是「本周笔记进料比视频产卡活跃」的真实表达，非比例失真；②notesLane 不含标签计数（flomo 无标签可展示）；③产出榜 tab 不含笔记（不进归因链，榜上无它是正确行为）；④未做「去笔记屏 ↗」跳转（导航回调需穿 PaperweightApp，超出本刀范围，需要再立）。
- 未 commit。

**「去笔记屏 ↗」跳转补记（2026-08-09，主会话直接执行）**：笔记行右端新增「去笔记屏 ↗」按钮，点击切到第七屏。实现：Collab 的 onNav 类型放宽（'workbench'→'workbench'|'notes'，原 `void onNav` 未用），经 BoardLayer 透传 `onOpenNotes` 到 SourceStats 笔记行按钮；pw.css 加 `.pw-dl-stats-go`（11px 描边小钮，hover 显 accent）。verify 226/226 全绿、前端 build 成功。ego 跳转回归（DOM 证据确凿）：点击后导航「笔记」is-on=true、热力图与笔记列表渲染在场。如实说明：回归当口 ego captureScreenshot 连续超时（重启 ego lite 未愈，老毛病），本刀按钮视觉以 DOM/类名核验为准，未留截图证据。

### PW-41 验收通过（2026-08-08；规格/实现/verify/真实库冒烟/ego 视觉验收=主代理亲做，屏刀惯例）——批次四刀全部收口

**白话**：镇纸导航最后多了「笔记」屏。进去顶上是近一年的记录节奏热力图（哪天记了哪天没记一眼看穿）；左边笔记列表能翻页能搜；右边上面是「相关旧笔记」——点一张在途押注卡，立刻捞出和它对得上词的旧笔记（捞不到就老实说"无命中"并列出捞了哪些词），每条带命中词和回链，点回链浏览器直接打开 Memos 原文；下面是标签树，点标签等于搜它。实测全过，对笔记库一个字都没写。

**给干活的看**：`pw-notes.ts` 追加 `getPwNotesTagCounts`（json_each 嵌套 CASE 防标量炸库）→ main.ts 六条只读 GET 路由 + `asNotesUnavailable`（503 口径）→ api.ts 类型端点 → `Notes.tsx`（约 340 行）+ PaperweightApp 三处 + pw.css 约 150 行。verify **225/225 全绿**。六路由真实库 curl 全过 + 错误路径 400/404 正确 + db+wal 哈希逐字节一致。ego 1440×900 区块核对 + UI 数据流回归（搜索/清除/押注 chip 联动/标签点击/回链开 Memos 新 tab）全过；协作台/首页抽查零改动。完整证据链与 4 处偏差留痕见 `docs/TASK-PW-41-notes-screen.md` 验收记录节。候选后续（用户拍板再做）：协作台多源可视化「笔记 · 待来源通路」接线、首页补「笔记」卡。

### PW-40 验收通过（2026-08-08；实现=DeepSeek 子代理，复核+verify+真实库冒烟=主代理亲做）

**白话**：收工小结现在多一段「旧笔记回响」——镇纸拿你在押的内容押注卡的词，去 Memos 里捞旧笔记。实测：造一条和押注《把亲人的死当华点博分数》对得上词的笔记，小结里立刻捞出来附回链；归档掉，就老实说"无命中"。捞不到绝不硬凑（确定性关键词匹配，至少两个词命中才算数，不用 AI 排序）。对笔记库一个字都没写（哈希对账两次通过）。

**给干活的看**：`src/pw-note-recall.ts`（174 行：extractPwRecallKeywords 确定性二字组算法 / recallPwNotesForBet 命中门槛 min(2,词数) / buildPwNoteEcho 三态 ok/no_bets/unavailable + 跨押注 uid 去重）+ `pw-day-summary.ts` +55 行（noteEcho 纯展示字段，双层兜底不崩，九档计数与对账锚点零改动；main.ts 未动——回响经 getPwDaySummary 内部装配自动进 /api/pw/day-summary 输出）+ 测试 7 组。verify **224/224 全绿**（217+7）。真实库冒烟四步全过（基线捞取→API 造笔记路由见命中→归档后如实无命中→纯读哈希对账×2 一致）。完整证据链见 `docs/TASK-PW-40-note-recall.md` 验收记录节。偏差 3 处（表述残留/夹具补表/查询上限放大），均已申报认可。

（完成后追加：交付摘要、verify 结果、真实库冒烟输出、与规格的偏差）

### PW-39 验收通过（2026-08-08；实现=DeepSeek 子代理，复核+verify+真实库冒烟=主代理亲做）

- 交付：`src/pw-notes.ts`（275 行，6 函数 3 类型）+ `src/pw-notes.test.ts`（9 组测试）+ package.json 登记。main.ts / frontend/ 零改动，未 commit。
- 只读打开实测结论：`new DatabaseSync(path, { readOnly: true })`（node v24.18.0）可用并选定；WAL 未 checkpoint 数据可读、写操作抛 readonly、库不存在抛错（status 兜底 ok:false）；immutable 禁用理由成立。连接策略=每次即开即关（防 Memos 重启后旧 inode 读陈旧数据，注释留痕）。
- verify（主代理跑）：**217/217 全绿**（208+9），selfcheck ok，前端 build 成功。
- 真实库冒烟（主代理跑，`MEMOS_DB_PATH` 缺省路径）：
  - `getPwNotesStatus` → `ok:true`
  - `readPwNotesList` → 含 PW-38 冒烟条「镇纸 PW-38 验收：Memos 落座冒烟 ✅ #镇纸」，tags=[镇纸]，url=`http://127.0.0.1:5230/memos/Qq3hG7nBVQ3izRv2yZo38w` ✓
  - `searchPwNotes("落座")` → 1 命中 ✓
  - `getPwNotesDailyStats({days:7})` → 连续 7 日缺日补 0，当天 1 条 ✓
  - `queryPwNotesByKeywords(["镇纸","不存在的词xyz"])` → 1 命中且 matchedKeywords 只含「镇纸」✓
  - **零写入对账：冒烟前后 memos_prod.db 与 -wal 的 sha256 逐字节一致**（注：只读连接会写瞬时 -shm 读标记，SQLite WAL 协议固有行为，主库与 -wal 不变——口径已写进模块注释）
- 与规格的偏差（子代理申报，主代理复核认可）：①search/queryByKeywords 的 limit 规格未定默认/上限，沿用 list 的默认 50 上限 200；②排序加 `id DESC` 次级键保证同秒确定性；③测试 7 项拆为 9 组（覆盖只增）；④tags 解析用 `json_valid` 兜底再 `json_extract`（比裸 extract 稳）。

### PW-38 Memos 本地落座 —— 验收通过（2026-08-08，主会话执行）

**白话**：Memos 已经在你电脑上跑起来了，开机自启，记一条能读回。打开 http://127.0.0.1:5230 就能用（仅本机可访问，没有暴露到公网）。账号密码和 API 令牌在 `~/Library/Application Support/memos/admin-credentials.txt`（仅本人可读），建议登录后自己改一遍密码。flomo 那 488 条还没搬——需要你从 flomo 网页端「设置 → 导出」拿出导出文件，给我文件我就导入。

**给干活的看**：

- 环境实况：本机无 Docker/OrbStack/colima/podman/brew/go → 按规格的官方二进制兜底执行。`memos_0.30.0_darwin_arm64.tar.gz` SHA256 `8156cb03…6d7d24` 与官方 checksums.txt 一致。
- 落点：二进制 `/Users/qinshu/Applications/memos/memos`（v0.30.0，commit 2036c1f）；数据目录 `/Users/qinshu/Library/Application Support/memos/`，**库文件绝对路径 `/Users/qinshu/Library/Application Support/memos/memos_prod.db`（SQLite，WAL）**——PW-39 只读连接用。
- 常驻：`launchd` 标签 `com.qinshu.memos`（`~/Library/LaunchAgents/com.qinshu.memos.plist`），RunAtLoad+KeepAlive，绑定 `127.0.0.1:5230`（不监听公网），日志 `memos.log`；`launchctl print` 确认 state=running。
- 账号：管理员 `qinshu`（role=ADMIN）经 `POST /api/v1/users` 首个用户建立；随机密码 600 权限落盘于上述 admin-credentials.txt。
- API 令牌：PAT `users/qinshu/personalAccessTokens/61247dd0-…`（描述「paperweight 镇纸只读连接」，expiresInDays=0 永不过期），令牌值同文件落盘（42 字符）。
- 冒烟（全过）：`GET /api/v1/instance/profile` 返回 v0.30.0；经 PAT 建 memo「镇纸 PW-38 验收：Memos 落座冒烟 ✅ #镇纸」→ 按 name 读回逐字一致、标签 `镇纸` 解析正确、creator=qinshu。
- 排障留痕（v0.30 API 事实，PW-39/中继脚本都要用）：①首用户建立走 `POST /api/v1/users`（`/api/v1/auth/signup` 在 v0.30 不存在）；②登录走 `POST /api/v1/auth/signin`，请求体必须嵌套 `{"passwordCredentials":{"username","password"}}`（平铺字段报 invalid credentials）；③长期令牌走 `POST /api/v1/users/{username}/personalAccessTokens`，token 值仅创建时可见。
- 与规格的偏差：规格写「Docker 优先」，本机无 Docker 环境，按规格内的官方二进制兜底执行，非新增偏差；可选子项 flomo 导入未做（缺导出文件，待用户提供）。
- 未 commit。

**flomo 导入补记（2026-08-09，主会话执行）**：用户交付导出包 `/Volumes/系统C盘/flomo@琴疏-20260809.zip`（21MB：HTML 正文 + 129 图）。实测两关键能力后全走 API 导入，未动 SQLite：①`POST /api/v1/memos` **支持 createTime 自定义**（原始时间保留，热力图按真实节奏点亮）；②`POST /api/v1/attachments` base64 上传 + `memo` 字段挂接。**489/489 全到**（库 NORMAL 490=489 flomo+1 PW-38 冒烟条；132 条带图 memo 附件全挂；空正文图片笔记 130 条用单空格占位）。一条 5557 字长笔记撞 `contentLengthLimit=8192`（字节口径），经 `PATCH /api/v1/instance/settings/MEMO_RELATED` 调到 65536 后补入（实例设置变更如实留痕）。如实发现：flomo 全文无 #标签（导出无标签可搬）。探针 memo 已归档。ego 验收：热力图按 3-8 月真实节奏点亮、相关旧笔记区对押注《这也太全能了吧…》捞出 3 条真命中（命中词 tv/AU/PS 等）。导入器与日志在 `/tmp/flomo-import/`（一次性脚本，幂等可重跑）。
