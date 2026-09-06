# TASK-PW-52 批次：flomo 内化二期（飞书输入口 + 笔记定向洞察）

- 日期：2026-08-10
- 状态：已拍板（2026-08-10，用户「那就按三段思路来帮我执行」；第三段「语义向量找回」按约定押后，不在本批）
- 依据：笔记通路一期批次 TASK-PW-38（PW-38/39/40/41 已验收）；REQUIREMENT-DOMAINS v0.9（本批次配套修订）

## 这批次是干什么的（白话）

两件大事：

1. **手机上随手记，镇纸里看得见**（PW-52）。现在你记笔记要打开 Memos 网页，麻烦。这刀之后：在手机飞书里给一个机器人发一句话，这句话就自动变成一条笔记，镇纸「笔记」屏的列表和热力图里马上能看到。相当于 flomo 的"微信里随手记"，只是换成了飞书（飞书不要公网地址，微信订阅号那条路走不通、这条能走）。
2. **笔记屏上多一个「跑洞察」按钮**（PW-53）。现在「相关旧笔记」区帮你把和押注对得上词的旧笔记捞出来，这刀之后：点一下「跑洞察」，AI 就把捞出来的这几条旧笔记读一遍，按你定的规矩写一份短报告——分五段：哪些是笔记里白纸黑字的事实、哪些模式反复出现、当前主要矛盾、哪些还只是猜测、下一步最小验证动作。每条都标注出自哪条笔记、能点回去核对。报告存起来，以后能翻。

## 怎么算好（白话）

- 手机飞书发给机器人「试试：今天想到一个选题」→ 镇纸笔记屏列表第一条就是这句话，热力图今天那格亮起来，机器人回你一句「已记」。同一句发两次不会记成两条。
- 笔记屏右栏点一张押注卡 → 捞出相关旧笔记 → 点「跑洞察」→ 十几秒后出报告：五段齐全，事实段每条末尾有「[笔记1]」这种标注，点下方来源 chip 能跳到 Memos 原文。
- 没捞到笔记时按钮不白费模型：明确告诉你"没捞到（捞了哪些词），先记几条相关笔记再跑"。
- 报告存在镇纸里，刷新屏还能翻历史；Memos 库一个字不被镇纸后端改（对账验证）。

---

以下给干活的看，可以跳过。

## 已核验的集成点（2026-08-10 主代理核对）

- 一次性模型调用范式：`src/pw-sieve.ts:515` `defaultSieveLlm`——`provider.models.completeSimple(provider.model, { systemPrompt, messages }, { maxTokens, timeoutMs, ... })`，返回 `contentText(response.content, "")`，stopReason error/aborted 抛错；`options.llm` 注入 mock 的测试范式见 `runPwSieve`（pw-sieve.ts:678）。
- 捞取：`src/pw-note-recall.ts` `recallPwNotesForBet({id,title,thesis},{maxHits})` → `{ betId, betTitle, keywords, hits: PwNoteHit[] }`；PwNoteHit 含 `uid/content/createdAt/url/matchedKeywords`（见 `src/pw-notes.ts`）。
- 押注：`getPwBet(db, id)`（`src/pw-bets.ts`），不存在返回空 → httpError(404)。
- 路由段范式：main.ts「TASK-PW-41：笔记屏」段——`json(response, status, value)`、`httpError(status, msg)`、`asNotesUnavailable` 小助手（无 status 的"连不上笔记库"错误包 503）。
- 建表范式：`src/pw-bets.ts` ensure 内 `CREATE TABLE IF NOT EXISTS` + PRAGMA 查列幂等迁移；测试 makeDb 范式见 `src/pw-content-bets.test.ts`。
- launchd 进程范式：`~/Library/LaunchAgents/com.qinshu.papertable.backend.plist`——caffeinate -i + `/Users/qinshu/.local/node/bin/node` + 仓库内 .ts 入口，KeepAlive，日志到 `~/Library/Logs/Papertable/`。
- Memos 实例：v0.30.0，http://127.0.0.1:5230，`POST /api/v1/memos`（Bearer access token）写笔记。

---

# PW-52 飞书速记输入口

- 主需求域：实践与数据回收
- 业务接口：无（域内）——「提供笔记读取」消费侧（PW-39/40/41）零改动；本刀只是给 Memos 库多一条外部写入通路
- 数据真值源：Memos 库（经 Memos 官方 API 写入，真值仍留 Memos；中继不碰镇纸库、不碰语料落盘）
- 质量约束与验收终态：见末节

## 交付

### 1. 新独立进程：`src/pw-feishu-relay.ts`（新）

飞书长连接收消息 → 写 Memos 的中继。**与镇纸后端（main.ts）完全无关的独立脚本**，不 import main.ts 任何路由，不需要 PAPERTABLE_* 环境变量。

- **新依赖**：`@larksuiteoapi/node-sdk`（官方 SDK，长连接是其私有 WS 协议，绕不开；npm install 登记进 package.json + package-lock）。
- **配置文件**（gitignored，不进仓库）：`~/Library/Application Support/Papertable/feishu-relay.json`，0600：
  ```json
  {
    "appId": "cli_xxx",
    "appSecret": "xxx",
    "memosUrl": "http://127.0.0.1:5230",
    "memosToken": "xxx",
    "defaultTag": "速记"
  }
  ```
  加载时逐字段校验，缺/空给出人话错误（"feishu-relay.json 缺 memosToken"）。defaultTag 可空字符串（=不挂标签）。
- **行为**：
  1. WSClient 长连接启动，订阅 `im.message.receive_v1`；
  2. 只处理 `chat_type === "p2p"` 且 `message_type === "text"` 的消息；其余类型日志一行跳过（群消息 v1 不收）；
  3. `JSON.parse(message.content).text` 取原文、trim；空文本跳过；
  4. **去重**：message_id 落 `feishu-relay-seen.json`（与配置同目录，数组封顶 200 条），已见过直接跳过不重复写；
  5. 写 Memos：`POST {memosUrl}/api/v1/memos`，`Authorization: Bearer {memosToken}`，body `{ content, visibility: "PRIVATE" }`；content = 原文 +（defaultTag 非空时）`\n#{defaultTag}`；非 2xx 抛错带响应体摘要；
  6. **回执**（best-effort，失败只记日志不影响主流程）：用 REST Client 给该 chat 回一条文本——成功「已记」；失败「没记上：{原因摘要}」；
  7. 全程 stdout 单行日志（收到/去重跳过/写成功 memo name/写失败），launchd 日志落 `~/Library/Logs/Papertable/feishu-relay.log`；
  8. SIGTERM 优雅退出。
- **纯函数拆分**（供单测）：`buildMemoContent(text, defaultTag)`、`SeenIds`（load/save/has/add，封顶 200）、`loadRelayConfig(path)` 校验。SDK 接线部分不做单测。

### 2. 测试：`src/pw-feishu-relay.test.ts`（新）

buildMemoContent（挂标签/不挂/空标签/原文不动逐字）、SeenIds（去重命中、封顶淘汰最旧、坏文件兜底空集、落盘往返）、loadRelayConfig（五字段逐项缺失报错、合法通过、defaultTag 缺省默认「速记」）。

### 3. launchd 安装（主代理后续手动，非子代理）

plist 照 backend 同款：`com.qinshu.papertable.feishu-relay.plist`，ProgramArguments = caffeinate -i + node + `src/pw-feishu-relay.ts`，KeepAlive=true，日志 feishu-relay.log / feishu-relay.error.log。**凭据未到位前只装不启**（脚本启动时配置缺失会立即退出并留人话错误日志，符合预期）。

## 质量约束与验收终态（PW-52）

- verify 全绿（含新测试）。
- 中继对镇纸库、语料落盘零写入（代码层面就不 import 任何镇纸写函数；grep 核验）。
- 真实链路冒烟**依赖用户手动三件套**（飞书建应用拿 App ID/Secret、Memos 建 access token、填配置文件），凭据到位后由主代理补做：手机发消息 → Memos 出现该条 → 镇纸笔记屏可见 → 重复发同一条（或同 message_id 重投）不产生第二条。
- 不 commit；frontend/、public/ 零改动。

---

# PW-53 笔记定向洞察

- 主需求域：内容生产
- 业务接口：提供笔记读取（消费，PW-39/40 提供）
- 数据真值源：Memos 库（只读，经 PW-39/40 读函数）+ 镇纸库 `pw_bets`（只读）；新正式表 `pw_note_insights`（笔记洞察报告，唯一归属内容生产，REQUIREMENT-DOMAINS v0.9）
- 质量约束与验收终态：见末节

## 交付

### 1. 后端：`src/pw-note-insight.ts`（新）

- 建表（ensure 范式，幂等）：
  ```sql
  CREATE TABLE IF NOT EXISTS pw_note_insights(
    id TEXT PRIMARY KEY,
    bet_id TEXT NOT NULL,
    keywords_json TEXT NOT NULL,
    note_refs_json TEXT NOT NULL,
    model TEXT,
    report TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
  ```
  note_refs_json = `[{ uid, url, createdAt, matchedKeywords }]`（前端渲染来源 chips 用）。
- `runPwNoteInsight(db, betId, opts { llm?, now? })`：
  1. getPwBet 无 → httpError(404)；
  2. `recallPwNotesForBet(bet, { maxHits: 10 })`（洞察比展示多吃一点料）；
  3. hits 为空 → httpError(400, `没有捞到相关旧笔记（捞了：${keywords 前 10 个顿号连接}…），先记几条相关笔记再跑洞察`)，**不调模型不落行**；
  4. 装配用户消息：押注标题 + thesis、关键词清单、命中笔记逐条编号（`[笔记N]` + createdAt + 内容全文 + 命中词）；
  5. 一次性模型调用（范式照 defaultSieveLlm：completeSimple，systemPrompt 用下方《洞察纪律》，maxTokens 4000、timeoutMs 90_000、maxRetries 0）；异常或空文本重试 1 次，仍败抛 httpError(502, …)；
  6. 落行（model 记 provider.model.id；注入 mock 时记 opts.modelLabel 或 null）+ 返回行。
- 《洞察纪律》systemPrompt（逐字进代码常量，规格写死）：
  ```
  你是「镇纸 Paperweight」的笔记洞察器。只依据给定的笔记与押注上下文输出，固定五段、顺序固定：
  ## 可核对的事实与原文线索
  ## 反复出现的模式
  ## 当前主要矛盾
  ## 尚未证实的假设
  ## 一个最小验证动作
  纪律：
  1. 事实与推断必须分开：第一段只写笔记里能直接看到的；其余各段每条开头标【推断】。
  2. 每条事实或线索末尾标注来源，格式 [笔记N]，N 是输入笔记的编号；禁止笼统说"某条笔记"。
  3. 不要补全笔记里没有的信息；没有证据就写"未知"。
  4. 不做人格或动机诊断，不替用户做决策。
  5. 某段确实没内容可写时写"（无）"，禁止硬凑。
  ```
- `listPwNoteInsights(db, betId)`：WHERE bet_id=? ORDER BY created_at DESC, id DESC LIMIT 50。
- 纪律：本模块对 Memos 库只读；报告原文落库不改写；不改 PW-39/40 任何读函数。

### 2. 路由：`src/main.ts` 追加「TASK-PW-53：笔记洞察」段（PW-41 段后）

| 路由 | 处理 | 参数与错误 |
|---|---|---|
| `POST /api/pw/notes/insight` | runPwNoteInsight → `{ insight }` | body betId 缺/空 400；押注不存在 404；0 命中 400（消息带捞取词）；笔记库连不上 503（asNotesUnavailable）；模型失败 502 |
| `GET /api/pw/notes/insight?betId=` | `{ insights: listPwNoteInsights(db, betId) }` | betId 缺/空 400 |

### 3. 测试：`src/pw-note-insight.test.ts`（新）

1. 建表列断言（照 pw-bets.test.ts 期望列范式）；
2. mock llm 跑通：断言 prompt 含五段标题、押注标题、笔记全文、命中词；返回行字段正确（keywords/note_refs/model/report/created_at）；落库可查；
3. 0 命中：400、不调 llm（mock 计数为 0）、不落行；
4. llm 首次抛错 → 重试 1 次成功；两次都败 → 502、不落行；
5. list 排序与 betId 过滤。

### 4. 前端（主代理亲做，非子代理）

`frontend/src/pw/Notes.tsx` 相关旧笔记区：选中押注且有 hits 时出「跑洞察」按钮 → POST → 按钮 loading → 报告卡（五段文本 pre-wrap + 头部时间/模型 + 来源 chips 跳 Memos 原文）；下方「历史洞察」折叠列表（GET）。api.ts 加 `notesInsightRun(betId)` / `notesInsightList(betId)` 与类型 `PwNoteInsight`。pw.css 末尾追加（注释 TASK-PW-53）。

## 质量约束与验收终态（PW-53）

- verify 全绿（含新测试）。
- 真实库冒烟（主代理）：POST 真实 pending 押注 → 报告五段齐全、事实段带 [笔记N] 标注；GET 列表可见；**冒烟前后真实 Memos 库 db+wal sha256 逐字节一致**。
- 模型行为观察项：来源标注格式命中率（[笔记N] 是否逐条带）——验收记录如实写，不追求一次满分，防平庸纪律靠人读报告兜底。
- 本刀不改 SIEVE/COLLAB 任何 system prompt，eval:sieve 无需跑（新 prompt 不属 AGENTS.md 列举的既有 prompt 变更）。
- 不 commit；大屏与其余六屏零改动。

---

## 防冲突约定

- 子代理（后端两刀）只许碰：`src/pw-feishu-relay.ts`（新）、`src/pw-feishu-relay.test.ts`（新）、`src/pw-note-insight.ts`（新）、`src/pw-note-insight.test.ts`（新）、`src/main.ts`（仅追加 PW-53 段）、`package.json`（新依赖 + 新测试登记）、`package-lock.json`（npm install 产物）。
- 前端（Notes.tsx / api.ts / pw.css）与 REQUIREMENT-DOMAINS.md 归主代理，子代理不碰。
- 既有文件零改动（除 main.ts 追加与 package.json 登记）；不 commit。

## 不在本批

- 语义向量找回（三段思路第三段，押后）；飞书语音消息转写（先用文字验证入口频率）；群消息速记；洞察报告的回删/编辑；微信任何通路。

---

## 验收记录

**验收通过（2026-08-10）**；规格=主代理，PW-52/53 后端实现=DeepSeek 子代理，复核/契约修复/verify/真实冒烟/前端与视觉验收=主代理亲做。

**什么能用了**
- 手机飞书给机器人发一句话 → 自动变成 Memos 笔记（镇纸笔记屏可见）：中继已 launchd 常驻，凭据已就位；最后一环「真实消息→笔记」等用户发一条消息验证。
- 笔记屏「相关旧笔记」区下方点「跑洞察」→ AI 读捞中的旧笔记出五段报告（事实/模式/矛盾/假设/最小验证），逐条标 [笔记N]，来源 chip 跳 Memos 原文；报告落库，历史可翻。

**什么还不行**
- 飞书语音、群消息、微信：不收（押后）。捞取仍是关键词对词（PW-40），命中偏泛（本次 10 条命中多靠 AU/PR/PS 通用词）——语义向量找回是押后的第三段。

**等拍板/注意**
- ⚠️ 洞察会把笔记全文发给云端模型：本次冒烟一条含 Google 账号卡密（accessToken/refreshToken）的旧笔记被读进 prompt（模型未照抄密钥原文，但内容确已出本机）。flomo 导入笔记里有此类敏感记录，跑洞察前要有这根弦；敏感词预检列为候选，不擅自加。
- 中继「先记去重再写」：写 Memos 失败时 message_id 已占坑，重投不再写（防双写优先）；失败回执「没记上」，人重发一遍即可。

**证据**
- verify（主代理亲跑）：**272/272 全绿**（子代理新测试 9 个 + 主代理序列化器测试 1 个），selfcheck ok，前端 build 成功。
- PW-53 真实冒烟（主代理）：POST dcd60b6b → 报告 2302 字、五段齐全、[笔记N]×31、【推断】逐条标注；GET 列表返回正常；**Memos db+wal sha256 冒烟前后逐字节一致**。Playwright 真实指针点击「跑洞察」全链路复跑成功（按钮→loading→报告卡刷新，截图 pw53-before-run/pw53-after-run.png）。
- PW-52 链路：缺配置人话报错 exit 1（子代理验）；凭据就位后 launchd 常驻 started/ws ready（主代理）；Memos token 直写 curl → memos/QFq5mUqi6z77Uis8D3Ma2a 落库且笔记屏列表第一条可见。未验：真实飞书消息→笔记（等用户发一条）。

**主代理复核修复（子代理交付后）**：路由原返回裸行（snake_case + JSON 字符串列）与前端契约不符——补 `publicPwNoteInsight` 序列化器（坏 JSON 兜底空数组）+ 单测 1 条，两条路由改输出。

**子代理偏差摘录（均合理留痕）**：defaultTag 缺省与必填矛盾按自洽实现；prompt 末尾补五段标题行使测试可断言；asNotesUnavailable 不支持 async 改路由内联等价 catch；写 Memos 加 15s 超时；FEISHU_RELAY_CONFIG 可覆盖配置路径。

**文件清单（全仓未 commit）**
- 后端（子代理）：`src/pw-feishu-relay.ts` / `.test.ts`（新）、`src/pw-note-insight.ts` / `.test.ts`（新）、`src/main.ts`（PW-53 段）、`package.json` + `package-lock.json`（@larksuiteoapi/node-sdk ^1.72.0 + 测试登记）
- 复核修复（主代理）：`src/pw-note-insight.ts`（序列化器）、`src/main.ts`（两路由输出）、`src/pw-note-insight.test.ts`（+1 组）
- 前端（主代理）：`frontend/src/lib/api.ts`（两端点+两类型）、`frontend/src/pw/Notes.tsx`（InsightPanel/InsightCard）、`frontend/src/pw/pw.css`（PW-53 样式段）
- 文档：`docs/TASK-PW-52-batch.md`（新）、`docs/REQUIREMENT-DOMAINS.md`（v0.9）
- 运维：`~/Library/LaunchAgents/com.qinshu.papertable.feishu-relay.plist`（新，已 bootstrap 常驻）

**补记（2026-08-10）**：PW-52 最后一环验通——用户手机飞书发「你好」→ 中继 written → 笔记屏可见（#速记）。途中踩坑一处已修：飞书事件真实投递形状与假设信封结构不符致首条消息被误跳过，新增 `extractReceiveMessage` 防御解析（信封/直连通吃 + msg_type 旧字段兜底）+ 单测 4 条（绿），中继重启后正常。relay 测试总数 3→4，全仓 verify 基线 272（本轮仅 relay 文件内改动， targeted 4/4 绿）。
