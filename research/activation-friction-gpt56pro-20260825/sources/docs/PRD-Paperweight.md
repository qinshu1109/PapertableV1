# Paperweight（镇纸）产品需求文档 v0.2

- 日期：2026-08-03（v0.2 于 2026-08-04 并入深度调研结论）
- 状态：草案，未进入实现；实现前按本文件「P0 TASK 列表」拆正式 TASK
- 相关产品：PapertableV1（思考场，已存在）；Paperweight（判断闭环工作台，本文档）

## 一句话定位

Papertable 把纸摊开让你想，Paperweight 把纸压住让你定。

Papertable 负责「意图 → 想法 → 选题」的探索与求证；Paperweight 负责「押注 → 开干 → 数据回流 → 结账」的执行与裁决，让每一次"想清楚了"都有代价、有结果、有利息。

## 用户与问题

用户：琴疏（独立开发者 + 内容创作者，单人）。

现在的旅程是断的：

- 在 Papertable 里想清楚一个选题后，执行（做视频、直播、发布）发生在产品之外，假设无人看管；
- 发布后数据躺在各平台后台，不回流、不对账；赢了不知道为什么赢，输了没有尸检；
- 长期无法回答"我的选题判断力有没有变好"。

## 核心概念

### 创作决策闭环（六步）

```
起心动念 → 想清楚 → 押注 → 开干 → 数据回流 → 结账
   ↑                                              |
   └──────────── 金子/墓碑进入下一圈 ←─────────────┘
```

前两步在 Papertable，后四步是 Paperweight 的主场；两端通过「金子同步」焊接（见下）。

### 判决即实验

选题类判决不是观点，是实验。每条押注必须带三行赌注：

- 验证指标（看什么数据算成，如"三期平均播放 ≥ 5000"）
- 数据来源（哪个平台、哪个账号）
- 结账日（到期必须裁决）

外加一个可选字段：**主观置信度**（0–100%）。有了它，P0 就能按 Fatebook 同款算法出 Brier 分与校准曲线——判断力校准从远期愿景变成 P0 可交付。

纪律：没有载体的判决不许确认成金子——结账时必须引用真实数据文档。结账三态：**金子（达标）/ 墓碑（未达标）/ 作废（数据未回流或指标失效，不计入校准成绩）**——作废通道防止"为了成绩单好看而强行铸金立碑"的动机污染。

### 金子同步（Papertable → Paperweight）

- Papertable 中「已确认的金子」单向同步到 Paperweight，作为选题押注、内容创作的可复用判断资产，并可进一步深化（发起新押注）。
- 机制（v0.2 定）：pw_verdicts 与 pt_verdicts 结构对齐，Papertable 确认的金子经镜像同步出现在 Paperweight 金子库（PW-07），Paperweight 侧任何写路径不触达 pt_verdicts（单向纪律，集成测试断言）。MemOS 仅作同步通道，不作真值源。
- 方向当前单向。Paperweight 结账产生的新判决是否回流 Papertable，留作开放问题。

## 架构决定（v0.2 定，源自深度调研）

**同仓库、同进程、同 SQLite 库，pw_ 前缀新表，不建独立仓库、不引 agent 框架。** 理由：「判断沉淀与复用」域横跨两产品且共享判决真值源，拆仓库等于第一天就发明跨服务同步协议（预建抽象层）；PapertableV1 已有探索引擎、SSE 流式、FTS5、MemOS 通道、云端模型中转，基建 100% 重叠。

重估拆分的触发条件（写死，防"同仓库"变成不还的债）：①同步 worker 需要常驻浏览器进程与独立崩溃域（届时拆同仓库内独立进程，接口是 pw_connections/pw_data_docs 两张表）；②两产品发布节奏真实冲突；③出现第二个消费判决真值源的产品。禁止现在就抽"共享内核包"。

## 功能模块（五屏）

| 模块 | 大白话 | 备注 |
|---|---|---|
| 押注台 | 单张押注卡的驾驶舱：我赌了什么、干到哪了、圈转到哪了 | 业务主界面 |
| 协作台 | AI 副驾驶：数据解读、起草押注/结账建议；押注与结账只能人确认 | Harness 见下节 |
| 观众声音 | 评论区反馈蓄水池：AI 预分拣、聚类，一键转押注草稿 | 只收能进闭环的信号 |
| 数据源 | 平台连接管理 + 待人工处理队列 | 供血后台 |
| 大盘 | 目标进度 + 判断力校准曲线 | 周/月复盘用，非日常驾驶舱 |

反面清单（贯穿始终）：不做看板、日历、甘特图类项目管理功能。该纪律已翻译为 P0 TASK 的否定验收断言（无优先级字段、无看板视图）。

## 协作台 Harness（借模式、不引框架）

不引入 LangGraph/Mastra/Letta 等框架运行时；复用 Papertable 引擎与 SSE 通道，新写三个薄层：

1. **上下文装配**：确定性函数 `assembleJudgmentContext(betId)`——从 pw_verdicts/pt_verdicts 镜像按指标类型、平台、历史死因做相关性排序，按 token 预算截断，产出只读 Markdown 注入每轮对话（"干净但不失忆"）。不引入自主记忆系统（AI 自主编辑记忆违反"金子只能由人确认"）；个人量级（几十到几百条）不做向量检索。
2. **工具权限表**：工具注册表带 `policy: allow|ask|deny`（借 OpenCode 声明式权限语义）。结账类（铸金/立碑）对 AI 为 deny——schema 不可见；押注确认类为 ask——AI 起草、人确认后执行（三段式，借 LangGraph HITL 的 approve/edit/reject 裁决语义）；起草类为 allow。门禁按风险分级，防审批疲劳。
3. **可审计 Run**：pw_runs 事件日志（actor/payload_hash/parent_id，借 Pi 的 JSONL 树思想），AI 草稿提交确认前固化取 hash、确认引用该 hash（借 Mastra 固化-幂等纪律）；P0 先记手工闭环事件，P2 扩展 actor=ai，零迁移。SSE 工具进度事件直接复用为实时通道。

模型层：云端旗舰模型走中转（PAPERTABLE_BASE_URL 同款），模型可换、Harness 不变。重新评估框架的触发条件：AI 流程复杂到"多步、多工具、跨会话恢复"成为日常（预计 P2 之后）。

## 数据源与同步策略

**事实订正（v0.2）**：MediaCrawler 不是"逆向 API"路线，本质是"Playwright 保登录态 + 页面内 JS 取签名"的混合浏览器路线；它抓公开数据，拿不到只在创作者后台的完播率/留存；且许可证限非商业学习用途——借模式可以，集成代码谨慎。

**通路顺序（按风险升序，能用低风险就不用高风险）**：

1. **官方 API**：YouTube Analytics API 指标最全（含完播/CTR）；B站开放平台有"数据开放"能力但个人放行口径需 P1 启动时实测一周；抖音个人权限受限；小红书对个人基本无官方通路（第三方转售商文章互相矛盾，P1 前以官方控制台复核）。
2. **后台导出 + 定时脚本**：国内平台首选。参照 TzFilm-Douyin-Tool：真人浏览器登录创作者中心、点导出、解析入库，零 API key，几乎无风控面。
3. **半自动浏览器**（确定性脚本 + 局部 LLM 兜底）：覆盖导出按钮拿不到的字段（如评论详情）。
4. **全自动 browser agent**：仅 P2+ 探索性兜底。

**五条军规**（针对复用登录态的 AI 浏览器攻击面，BioShocking 类研究已证实风险真实存在）：AI 永远不接触 cookie 本体；域白名单只允许目标平台后台域；只读操作；验证码/2FA 一律暂停交人；登录态材料加密存储、单机使用。

底线：为保账号，宁可退回手动录入——手动数据文档（PW-04）永远是兜底通路，同步系统的目标是"省心"，不是"离不开"。

**P2 公开数据通路（v0.3，2026-08-04 用户拍板）**：在「仅自己账号」的后台通路之外，新增「定向公开数据」通路（关注的视频数据与评论，落本地 `data/corpus/`）。三项决定：①授权方式=人工逐条授权（无白名单表，抓取只打授权队列）；②公开数据不哈希（作者昵称原样存，pw_voice_items 的哈希纪律仅适用于自己评论区的最小化场景）；③协作台工具走 function-calling，权限表静态化（只读 allow、fetch ask、起草只产草稿、结账 deny 即 schema 不存在）。详见 TASK-PW-14/15/16。

## 数据模型（P0 五张主表 + 两张阶段表）

总原则：押注与裁决归「判断沉淀与复用」（verdict 的待决态与已决态），执行痕迹与外部数据归「实践与数据回收」；跨域引用只用外键 id；AI 草稿在人确认前不算业务数据。

| 表 | 归属域 | 核心字段 | 关键约束 |
|---|---|---|---|
| pw_bets 押注卡 | 判断沉淀与复用 | id, title, thesis, metric, metric_target, confidence(可选), data_source_plan, checkout_date, status(draft/pending/settled/void), gold_refs[], created_from, settled_verdict_id | 三行赌注 pending 前必填；draft 对押注台不可见；无"进行中管理"中间态 |
| pw_verdicts 结账记录 | 判断沉淀与复用 | id, bet_id, outcome(gold/tomb/void), lesson(gold 必填), cause_of_death(tomb 必填), evidence_doc_ids[], confidence_snapshot, decided_by, decided_at | decided_by=human 为 DB 层约束；void 不计校准；与 pt_verdicts 结构对齐 |
| pw_artifacts 产出物 | 实践与数据回收 | id, bet_id, platform, url, title, type, published_at, detached_at | bet_id 必填（无押注不许有产出，反向锁"先干再想"）；解挂留痕不删除 |
| pw_data_docs 数据文档 | 实践与数据回收 | id, bet_id, artifact_id(可空), platform, collected_at, method(manual/export/sync), metrics_json, raw_ref, source_hash, version | 只增不改（version 递增）；结账引用后冻结 |
| pw_voice_items 观众声音 | 实践与数据回收 | id, artifact_id, platform, author_hash, content, captured_at, signal_type, cluster_id, promoted_to_draft_id, dropped_reason | author 只存哈希（最小化他人数据） |
| pw_connections 数据源连接（P1） | 实践与数据回收 | id, platform, account_label, auth_ref(加密引用), status(active/needs_human/paused), last_sync_at, risk_events[] | 表内永不存 cookie 本体；needs_human 即人工接手队列 |
| pw_runs 审计事件（P0 起步） | 实践与数据回收 | id, kind(manual_event/ai_draft/sync), actor(human/ai/system), payload_json, payload_hash, parent_id, related_ids[], created_at | 只增不改；parent_id 成树；P2 增 ai_draft |

不进模型：标签系统、项目分组、截止日期之外的任何时间字段——每个"将来可能有用"的字段都是滑向项目管理工具的一级台阶。

## 阶段规划（带闸门）

- **P0 手工闭环**（本文件 TASK 列表）：押注三字段+置信度、手动挂载、手动数据文档、到期结账、金子注入下一圈。闸门=PW-12 端到端跑通两圈真实闭环（一金一碑），闸门不过不启动 P1。
- **P1 数据源低频同步**：连接管理、每天一次、人工接手队列、method 扩展 export/sync。闸门=连续 14 天每日同步成功且零风控挑战事件。
- **P2 实践 Run + AI 副驾驶完整化**：pw_runs 增 ai_draft、三段式确认流、权限表全量启用、校准完善。闸门=AI 起草全程留痕且结账写入 100% 经人确认。
- **P3 开源形态（可选）**：CreativeOps Run 标准 + 先验库，自用稳定后再谈。

## P0 TASK 列表（可直接拆正式 TASK）

| TASK | 名称 | 主需求域 | 数据真值源 | 质量约束与验收终态 |
|---|---|---|---|---|
| PW-01 | 押注卡建模与创建 | 判断沉淀与复用 | pw_bets | 三行赌注必填校验；可选置信度 0–100；创建即 pending；可引用≥0 条金子快照；无优先级/负责人/看板列字段（否定验收） |
| PW-02 | 押注台单卡驾驶舱 | 判断沉淀与复用 | pw_bets（只读聚合） | 按设计稿落地单卡视图；不存在看板/日历/甘特视图（否定验收） |
| PW-03 | 产出物手动登记挂载 | 实践与数据回收 | pw_artifacts | 平台+URL+类型+发布时间；强制挂 bet_id；解挂留痕不删除 |
| PW-04 | 手动数据文档 | 实践与数据回收 | pw_data_docs | 手动录入平台数据快照，method=manual；只增不改（改=新版本）；可关联卡或产出物 |
| PW-05 | 到期结账裁决 | 判断沉淀与复用 | pw_verdicts | 到期卡进待裁决；铸金必填"有效判断一句话"、立碑必填"死因"；允许作废；decided_by=human；结账引用 data_doc id 列表 |
| PW-06 | 金子墓碑库 | 判断沉淀与复用 | pw_verdicts（视图） | 可列表可全文检索（复用 FTS5）；墓碑按死因聚合计数；单条可追溯到押注与数据文档 |
| PW-07 | Papertable 金子单向同步 | 判断沉淀与复用 | pt_verdicts → pw 侧只读镜像 | Papertable 确认的金子 24h 内出现于 Paperweight；集成测试断言 pw 任何写路径不触达 pt_verdicts |
| PW-08 | 观众声音手动录入与分拣 | 实践与数据回收 | pw_voice_items | 手动粘贴评论挂产出物；一键 LLM 分拣（选题线索/内容质疑/形式建议/噪音）；丢弃留痕 |
| PW-09 | 转押注草稿与人审确认 | 判断沉淀与复用 | pw_bets（draft 态） | 草稿不进押注台正式区；人可编辑后确认转正（记 draft_hash 与确认人）；驳回必填原因；P0 草稿由人/一次性 LLM 调用产生，P2 换 AI 零改动 |
| PW-10 | 大盘 v0 | 判断沉淀与复用 | pw_verdicts（聚合只读） | 目标进度；整体命中率；置信度样本≥5 条自动出校准曲线（10 档分桶）；Brier 分可选 |
| PW-11 | 闭环事件日志 | 实践与数据回收 | pw_runs | 创建/挂载/回流/草稿/确认/驳回/结账七类事件入库（actor/payload_hash/parent_id）；单卡时间线可回放；事件不可改 |
| PW-12 | 端到端阶段闸门 | （跨域验收） | 全部 | 真实跑通两圈：押注（引用 1 条金子）→登记产出→录数据文档→到期结账（一金一碑）→第二次押注的装配函数输出可见第一次的金子；全程不手工改库 |

## 风险与保险丝

1. **滑成项目管理工具**（概率最高）：保险丝=PW-01/PW-02 否定验收 + 押注卡只有 pending/settled/void 三态（开干不是管理对象，产出物挂载才是）。
2. **同步危及账号**（单次代价最大）：保险丝=五条军规 + 通路顺序纪律 + P1 闸门（14 天零风控）+ pw_connections.risk_events 台账 + 手动录入兜底。
3. **AI 越权自动结账**（信任一击致命）：三层纵深——权限层（结账工具对 AI deny）、数据层（decided_by=human 为 DB 约束、草稿与正式分表）、审计层（结账必引 draft_hash 与 evidence_doc_ids，hash 校验确认内容一致）。候补风险：P0 范围蔓延（闸门不过不开 P1）；单向同步被破（PW-07 集成测试断言）。

## 设计资产（已产出）

- 概念图（image2）：`/Volumes/系统C盘/qinshu-data/UserFolders/Downloads/ChatGPT Image 2026年8月4日 00_58_50.png`
- DESIGN.md：`/tmp/papertable-design.md`（已定名镇纸 Paperweight）
- 六页可点击设计稿（Open Design，假数据，导航互通）：`papertable-index.html`（导航首页）、`papertable-workbench.html`（押注台）、`papertable-collab.html`（协作台）、`papertable-feedback.html`（观众声音）、`papertable-sources.html`（数据源）、`papertable-dashboard.html`（大盘）；目录 `/Users/qinshu/Documents/爬数据/open-design/.od/projects/437828aa-4737-4a3c-bfbf-44eb204ad278/`

## 调研依据

- 深度调研（2026-08-04，Kimi 深度研究，40 组查询、GitHub API 当天实测）：`"假设→执行→数据→裁决"闭环上半场零件都有万星级成熟实现，裁决/校准侧最大开源项目仅 59⭐（Fatebook）——裁决是无人区，且无人区不需要等技术齐备`。报告：`/tmp/kimi_deep_research/file0.md`（含附录 A 实测数据表）。
- 首轮调研（2026-08-03）：闭环无完整开源实现；理念最近似 viralens(⭐2)、Orbit(⭐57)。`/tmp/kimi_agent_report/report.md`
- B站赛道实查（2026-08-03，ego-browser）：「AI 自媒体工作流」内容密集但均为工具测评型；「直播做产品」形态稀缺；「自研产品 + 直播实践 + 判断沉淀」组合无对标。

## 开放问题

1. Paperweight 结账产生的新判决是否回流 Papertable？（当前设计为单向同步）
2. ~~「实践与数据回收」是否构成第四需求域~~ **已定（2026-08-03）**：构成第四需求域，见 `REQUIREMENT-DOMAINS.md` v0.2。
3. ~~金子同步机制~~ **已定（v0.2）**：pw_verdicts/pt_verdicts 结构对齐 + 单向镜像（PW-07）；MemOS 仅作通道。
4. ~~同仓库 vs 独立仓库~~ **已定（v0.2）**：同仓库同进程同库，pw_ 前缀表；重估条件见「架构决定」。
5. 首期真实实验对象候选：「直播用 Papertable/Paperweight 做 AI 内容实践」系列选题（自 dogfood）。
6. B站官方「数据开放」对个人开发者的实际放行口径：P1 启动时实测一周。
