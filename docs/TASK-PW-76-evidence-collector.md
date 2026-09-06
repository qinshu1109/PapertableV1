# TASK-PW-76 飞书搜证智能体 + IDE 终局合成 Skill

- 状态：代码与单测完成（分支 `feat/pw-75-relay-draft-offer`，45/45 绿）；待本机建表、填配置、真机终验
- 主需求域：内容生产（速记 → 留痕 → 联网搜证 → 情报大厅；出稿在 IDE）
- 业务接口：无（域内）。入口 = 飞书 p2p 文本（现有中继）；智能体模型 = 用户中转站 `glm-5.3-flash`（OpenAI-compatible tools）；外部源 = Exa / TwitterAPI.io / GitHub Issues / Hacker News / 厂商状态页；落盘 = 飞书多维表格四张表；出稿 = IDE 内旗舰模型加载 `skills/evidence-synth`
- 数据真值源：笔记原文 = Memos（不变）；脱敏副本与证据 = 多维表格 `速记 / 证据 / 主题 / 产出`；本机状态簿 `feishu-relay-evidence-state.json` 只存当日搜证次数（可删）。任何 AI 产物不写 Memos、不写 MemOS
- 质量约束与验收终态：`evidence.enabled` 缺省 false、每条消息重读、fail-closed；「已记」回执不受搜证影响（搜证异步）；原文只送模型端点，工具请求里不可能出现原文（结构性）；模型给的 URL 必须在本轮工具返回过，引言必须逐字可验；单 Base 写操作串行；`node --test` 五个文件全绿；真机三项终验（§6）

## 这刀是干什么的

你在飞书里随手记一句坑，机器人照旧秒回「已记」。几十秒后再来一行：

> 铁证 4 · 状态页 1 · GitHub 2 · X 1 · 最热：429 RESOURCE_EXHAUSTED despite quota headroom（72）https://github.com/… · 脱敏 1 处 · 表 +3/~1 · https://xxx.feishu.cn/base/… · 主题 gemini/429

这一行背后：`glm-5.3-flash` 先把你那句话里的内网 IP、密钥、内部代号换成占位符，提炼出公开可搜的实体与错误码；再拿着脱敏后的词去 Exa、X、GitHub、HN 和厂商状态页打捞真实世界正在发生的讨论；清洗成带 URL、日期、互动数、逐字引言、0~100 热度分的证据；串行写进多维表格的速记表、证据表、主题表。多维表格就是情报大厅——你在电脑前每周看一次仪表盘：外面在吵什么、跟我踩的坑有什么关系、哪条该我写。

想发内容的时候，不在飞书里发生。你在 Codex / ZCode / AGY 里说"把 gemini/429 写成 B 站动态"，IDE 里的旗舰模型加载 `skills/evidence-synth`，从表里拉证据包，只用包内事实写稿，每句带 `[E#]` 角标和真实 URL，跑一遍验真脚本，再把成稿写回「产出」表。

## 怎么算好

1. 发「明天买牛奶」→ 只回「已记」，日志里 `evidence_plan worth=false`，没有任何工具请求。
2. 发「gemini 2.5 pro 429 配额页没超，10.0.0.8 上的网关切 vertex 才好」→ 先「已记」，几十秒后来一行「铁证 N · …」；多维表格速记表里那条**没有** `10.0.0.8`，只有「【IP】」；证据表多了 N 行，每行 URL 点开是真的，摘录能在页面里原样找到。
3. 发一条含 `sk-…` 假密钥的速记 → 日志里 `hardRedactions ≥ 1`，回执里有「脱敏 1 处」，表里和任何外部请求里都没有那串字符。
4. 把 `evidence.enabled` 改成 `false`（不重启）→ 下一条速记只回「已记」，零外部请求。
5. 在 IDE 里跑 `pull_pack.mjs gemini/429` → 得到 JSON 证据包；写稿后 `verify_draft.mjs` 报 `pass:true`；`write_back.mjs` 后「产出」表多一行、主题状态变「已写」。
6. 把中转站 key 改错再发一条坑 → 回「搜证失败：模型 401：…」，「已记」不受影响。

---

## 以下给干活的看，可以跳过

### 1. 改动面

| 文件 | 性质 | 职责 |
|---|---|---|
| `src/pw-feishu-bitable.ts` | 新增 | Bitable 客户端：令牌缓存、按键查找、创建/更新、`upsertByKey`（关联字段合并）、**串行写链**、`writeEvidenceBundle`（主题→速记→证据） |
| `src/pw-evidence-collector.ts` | 新增 | 智能体：密钥硬替换（8 模式）→ 阶段一脱敏与规划（无工具）→ 阶段二 tools 循环（5 个工具）→ 最终 JSON → **URL 登记簿校验 + 引言子串校验 + 热度夹取 + 去重** |
| `src/pw-evidence-hook.ts` | 新增 | 配置读取（fail-closed）、日上限、编排、回执文案、失败可见 |
| `src/pw-feishu-relay.ts` | 改 5 处 | import；`handleMessage` 加 `evidence` 参数；「已记」之后 `void evidence.onNote()`；PW-75 的 followUp 改为 detach（修上一轮指出的阻塞坑）；启动日志带 `evidence` 摘要 |
| `src/pw-feishu-bitable.test.ts` / `pw-evidence-collector.test.ts` / `pw-evidence-hook.test.ts` | 新增 | 21 个用例，全部假 fetch，不碰网络 |
| `skills/evidence-synth/SKILL.md` + `scripts/{_bitable,pull_pack,verify_draft,write_back}.mjs` | 新增 | IDE 侧 Skill 与三个独立脚本（不依赖 `src/`） |
| `package.json` | 改 | test 脚本追加三个文件 |

`pw-feishu-draft.ts`（PW-75 出稿）未删：`draftOffer` 保持 false 即彻底不生效。两条路径互不依赖。

### 2. 智能体的两阶段与结构性防护

```text
速记原文
  │ hardRedactSecrets（8 个高精度密钥模式 + denyTerms 字面替换）—— 进模型前
  ▼
阶段一（json_object，无工具）：worthSearching / redactedNote / entities / queries{en,zh} / topicKey / statusProviders
  │ 不值得搜 → 结束（缺省静默）
  ▼
阶段二（tools，≤ maxToolRounds 轮）：user 消息只含阶段一产物；工具入参由模型从脱敏产物生成
  │ 每次工具返回的 URL+文本进 UrlRegistry
  ▼
最终 JSON → validateEvidence：URL 不在登记簿 → 丢；quote 不是登记文本子串 → 清空；heat 夹 0~100；按去重键去重；≤8 条
  ▼
writeEvidenceBundle（串行）→ 回执（计数由代码从校验后的列表算，不信模型的 receipt）
```

关于"拒绝硬编码正则"：本刀保留的正则只有 8 个密钥模式（`sk-/ghp_/AKIA/AIza/xox?-/JWT/Bearer/40+hex/URL 内嵌凭证`）。理由是泄露不可逆，而模型脱敏有概率漏——这 8 个是安全带，不是业务逻辑；IP、主机名、内部代号、账号这些语义脱敏全部交给阶段一模型。其余"判断"全在提示词里（`PHASE1_SYSTEM` / `AGENT_SYSTEM`，见源码顶部），需求变了改提示词。

### 3. 系统提示词与工具定义所在

- 阶段一提示词：`src/pw-evidence-collector.ts` 的 `PHASE1_SYSTEM`（`{{providers}}` 运行时替换为配置里的状态页键）。
- 阶段二提示词：同文件 `AGENT_SYSTEM`（策略、证据判断标准、热度评分口径、最终 JSON 形状）。
- 工具定义：同文件 `TOOLS_SCHEMA`（OpenAI function calling 形状）：`exa_search / x_search / github_search / hn_search / status_incidents`。
- 适配器只做字段映射：Exa `POST /search`；TwitterAPI.io `advanced_search`（URL 可配置 `evidence.xSearchUrl`）；GitHub `GET /search/issues`（有 token 30 次/分，无 token 10 次/分）；HN Algolia `search`；状态页同时识别 Statuspage `incidents.json` 与 Google Cloud `incidents.json` 两种格式。

### 4. 配置（`feishu-relay.json` 追加 `evidence` 段）

```json
"evidence": {
  "enabled": false,
  "model": {
    "baseUrl": "https://cozai.net/v1",
    "apiKey": "sk-…",
    "model": "glm-5.3-flash",
    "extraBody": { "reasoning_effort": "low" }
  },
  "exaApiKey": "…",
  "xApiKey": "…",
  "xSearchUrl": "https://api.twitterapi.io/twitter/tweet/advanced_search",
  "githubToken": "ghp_…",
  "statusProviders": {
    "openai": "https://status.openai.com/api/v2/incidents.json",
    "anthropic": "https://status.anthropic.com/api/v2/incidents.json",
    "google-cloud": "https://status.cloud.google.com/incidents.json",
    "cloudflare": "https://www.cloudflarestatus.com/api/v2/incidents.json"
  },
  "denyTerms": ["你的内部项目名", "客户代号"],
  "maxToolRounds": 6,
  "timeBudgetMs": 90000,
  "maxResultsPerTool": 8,
  "maxRunsPerDay": 40,
  "receipt": { "silentWhenSkipped": true, "silentWhenEmpty": false },
  "bitable": {
    "appToken": "AIyIb85mRap2FQsFLGsctofDnnb",
    "baseUrl": "https://ccnexza2e5l5.feishu.cn",
    "dateAs": "timestamp",
    "tables": { "notes": "tbl…", "evidence": "tbl…", "topics": "tbl…", "outputs": "tbl…" },
    "fieldMap": {}
  }
}
```

- `exaApiKey` / `xApiKey` 也可放根级（别名 `exaApiKey` / `twitterApiIoKey` / `EXA_API_KEY` / `TWITTERAPI_IO_KEY`），你已存的位置只要是其一即可；启动日志 `evidence.exa/x` 为 `true` 表示读到了。
- `extraBody` 原样并进请求体：glm-5.3-flash 思考不能关，`reasoning_effort` 缺省是 `max`，**务必显式给 `low`**（阶段一/二都不需要深思考），否则延迟与输出 token 翻倍。若 cozai 不透传该字段，改成中转站认的写法或删掉。
- `fieldMap` 留空即用缺省列名（§5）；改了列名只改这里。

### 5. 多维表格建表清单（一次性手建；列名可在 fieldMap 覆盖）

**速记表**（`tables.notes`）：`原文` 多行文本 · `时间` 日期 · `查询词` 文本 · `主题` 单向关联→主题表 · `主题键` 文本 · `Memos` 文本

**证据表**（`tables.evidence`）：`去重键` 文本（唯一）· `标题` 文本 · `URL` 文本（用文本列，不用超链接列）· `源` 单选：status/github/hn/x/exa · `层级` 单选：T0/T1/T2 · `发布时间` 日期 · `摘录` 多行文本 · `指标JSON` 多行文本 · `热度分` 数字 · `相关性` 文本 · `速记` 关联→速记表 · `主题` 关联→主题表 · `主题键` 文本 · `抓取时间` 日期

**主题表**（`tables.topics`）：`主题键` 文本（唯一）· `状态` 单选：观察/该写/已写/已发 · 建议加 rollup：`我的踩坑数`（count 速记）· `外部证据数`（count 证据）· `最高热度`（max 热度分）· `最近活跃`（max 发布时间）

**产出表**（`tables.outputs`，IDE Skill 写）：`标题` · `正文` 多行 · `平台` 单选 · `主题键` 文本 · `引用证据` 关联→证据表（多选）· `引用速记` 关联→速记表（多选）· `模型` 文本 · `时间` 日期 · `发布链接` 文本

仪表盘三张图（手配一次）：近 14 天证据按主题的热度 Top10 条形；主题散点（X 我的踩坑数 / Y 最高热度 / 大小 外部证据数）；主题表筛选视图 `状态≠已写 且 踩坑数≥1 且 证据数≥2` 按最高热度降序。

### 6. 部署与真机终验

```bash
cd /Users/qinshu/Documents/papertableV1 && git pull origin feat/pw-75-relay-draft-offer
PATH="$HOME/.local/node/bin:$PATH" node --test src/pw-feishu-relay.test.ts src/pw-feishu-draft.test.ts \
  src/pw-feishu-bitable.test.ts src/pw-evidence-collector.test.ts src/pw-evidence-hook.test.ts   # 45 passed
# 1) 建四张表，把表 ID 填进 evidence.bitable.tables；evidence.enabled 先留 false
launchctl kickstart -k gui/$(id -u)/com.qinshu.papertable.feishu-relay
tail -n 2 ~/Library/Logs/Papertable/feishu-relay.log     # started 行含 "evidence":{"enabled":false,...}
# 2) enabled 改 true（不重启），发三条：
#    a. 「明天买牛奶」            → 只「已记」；日志 evidence_plan worth=false
#    b. 「gemini 2.5 pro 429 配额页没超，10.0.0.8 上切 vertex 才好」 → 「已记」+ 几十秒后「铁证 N …」；表里无 10.0.0.8
#    c. 「测试 sk-AAAAAAAAAAAAAAAAAAAAAAAA 泄露 429」 → 回执含「脱敏 1 处」
# 3) IDE 侧：
node skills/evidence-synth/scripts/pull_pack.mjs gemini/429 --out /tmp/pack.json
#    写稿到 /tmp/draft.md 后
node skills/evidence-synth/scripts/verify_draft.mjs --pack /tmp/pack.json --draft /tmp/draft.md
node skills/evidence-synth/scripts/write_back.mjs --pack /tmp/pack.json --draft /tmp/draft.md --platform bilibili-dynamic --title "…"
```

**前置（沿用 PW-75 §4）**：relay 与 ZCode 同一 App ID 时，ZCode 飞书 bot 必须 `enabled:false`，否则消息被分发走一半、且 ZCode 也写 Memos。连发 3 条，日志 3 条 `written` 才算干净。

### 7. 日志事件

`evidence_plan`（worth/topic/queries/reason）· `evidence_tool`（tool/args/ok/hits/error）· `evidence_deadline` · `evidence_collected`（evidence 数 + stats：toolCalls/toolErrors/urlsSeen/droppedUnknownUrl/quotesCleared/ms）· `evidence_written`（topicId/noteId/created/updated）· `evidence_write_failed` · `evidence_skipped`（daily_cap）· `evidence_failed` · `evidence_hook_error`。

`droppedUnknownUrl` 与 `quotesCleared` 是模型"想编"的次数——每周看一眼，持续升高就该改 `AGENT_SYSTEM` 的措辞。

### 8. 成本估算

每条值得搜的速记：阶段一约 1.5k tokens、阶段二 3~6 次工具往返约 8~15k 输入 / 1~2k 输出。按 glm-5.3-flash 你给的价格（输入 $0.32/M、输出 $1.12/M）约 $0.006~0.01；Exa 每次 $0.007（月送 $10）；X 走 TwitterAPI.io 按其计费；GitHub/HN/状态页免费。`maxRunsPerDay: 40` 兜底后每月上限约 $20。

### 9. 已知边界

- **不值得搜的速记不回第二条**（`silentWhenSkipped` 缺省 true）；想看判定改成 false。
- **多维表格个人租户单表记录数有上限**（错误码 1254103 RecordExceedLimit）；证据表按 20 条/天 × 5 条增长约一年到两万级，到时在表内按 `抓取时间` 归档旧行即可，本刀不做自动清理。
- **状态页没有互动指标**，热度靠模型按"官方事件基线 60 + 时效"评；这是口径不是精确值。
- **X 适配器按 TwitterAPI.io 当前响应字段写**（`tweets[].likeCount/retweetCount/author.userName`），字段名兼容了官方 API 的 snake_case；若供应商改版，改 `runX` 一处。
- **知乎、B 站不在工具列表**——没有可用的对外检索 API；B 站是你的发布回流通道，不是证据源。
- **Bitable 同一 Base 一次只做一个写操作**：本客户端串行；PW-75 的 `syncDraftToBitable` 不走这条链，若两条路径同时开着有极小概率撞写——保持 `draftOffer:false` 即无此问题。
- 卡片按钮、回溯搜证、Reddit/V2EX/linux.do 适配器都不在本刀；等表里有 100 行真实证据再说。

### 10. 回滚

- 5 秒：`evidence.enabled` 改 `false`。
- 彻底：`git checkout 34a0cba`（本刀之前）+ `launchctl kickstart -k …feishu-relay`。表里已写的行留着无害。
