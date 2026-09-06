# TASK-PW-40 按押注回顾捞取 + 收工小结「旧笔记回响」

- 日期：2026-08-08
- 状态：已拍板（2026-08-08，用户「继续」；批次 `docs/TASK-PW-38-batch.md`）
- 主需求域：内容生产
- 业务接口：提供笔记读取（消费，PW-39 提供）
- 数据真值源：Memos SQLite 库（只读消费，PW-39 口径）+ 镇纸库 `pw_bets`（在途内容押注卡）；**无新正式表**
- 质量约束与验收终态：见末节「质量约束与验收终态」
- 批次：`docs/TASK-PW-38-batch.md`（PW-38/39 已验收，本刀为第三刀）

## 这刀是干什么的（白话）

让镇纸替你"回想"：你当前押着几张内容押注卡（比如《演示 AI 只读没意义这个困惑》），这刀做完后，镇纸会拿这些押注的标题和引文里的词，去你的 Memos 笔记库里捞——**三个月前记过的一条灵感，可能正好就是今天这张押注要的素材**。

捞的结果出现在两个地方：一是收工小结多一段「旧笔记回响」，每天收工时替你把"在押的注"和"旧笔记"对一遍；二是留个读函数给 PW-41 第七屏的「相关旧笔记」区用。

**捞不到就老实说没有，绝不硬凑。** 这刀只用确定性的关键词匹配，不用 AI 排序——宁缺毋滥，这是防平庸纪律。

## 怎么算好（白话）

- 拿你真实的库冒烟：造一条和在途押注"对得上词"的笔记，收工小结里就能看到它被捞出来；把笔记归档，再跑一次，就老实说"无命中"。
- 没有押注卡时，回响段说"今日不捞"，不硬捞。
- Memos 没启动/库不在时，收工小结照常出，回响段只说"连不上笔记库"，不崩。
- 对笔记库还是一个字都不写（哈希对账）；收工小结既有的对账锚点（各档和+其余=总数）一个都不能破。

---

以下给干活的看，可以跳过。

## 背景与已核验事实

- PW-39 已交付 `src/pw-notes.ts`：`queryPwNotesByKeywords(keywords, {limit})` 多关键词 LIKE OR、按命中词数降序+created_ts 倒序、返回 `PwNoteHit`（含 `matchedKeywords`、`url` 回链）。只读连接即开即关、禁止 immutable、归档不返回。
- 在途内容押注卡：`pw_bets` 中 `kind='content' AND status='pending'`（void/settled 不算在途）。复用 `listContentBets(db)`（PW-19，已排除 void）再过滤 `status==='pending'`，排序复用 `sortContentBetsForDisplay`（PW-27 菜号牌展示序）。
- 押注文本：`title`（≤30 字）+ `thesis`（格式固定为 `原文：{quote}\n来源：bvid=…，uname=…，like=…`，PW-19 buildThesis 产物）。**「来源：」行是噪声（bvid/点赞数），抽取关键词时必须剔除；「原文：」前缀同样剔除。**
- 收工小结：`src/pw-day-summary.ts` `getPwDaySummary(db, options)` + `renderPwDaySummaryText(summary)`；main.ts:789 路由 `/api/pw/day-summary` 返回 `{ summary, text }`。**本刀不改 main.ts**——回响段必须在 `getPwDaySummary` 内部装配，路由输出自动带上。
- 九档分类纪律与对账锚点（各档和 + otherCount = totalEvents）是 PW-35 的硬约定：**回响段是附加展示，不参与任何一档计数，totalEvents/otherCount 一个都不能变**。
- Memos 库只读纪律（PW-39）：零写入（db+wal 哈希对账）、归档不返回、连接失败优雅报错不崩。

## 关键词抽取算法（确定性，不用 LLM——写死，照做）

`extractPwRecallKeywords(title: string, thesis: string): string[]`

1. 文本 = title + "\n" + thesis 剔除「来源」信息后的部分：按行处理，丢弃以 `来源：` 开头的行，去掉行首 `原文：` 前缀。
2. 以 `[^\p{L}\p{N}]+`（unicode）切分成段，丢弃空段。
3. 段级过滤：丢弃纯数字段、单字符段、停用词段（停用词表写在代码里并注释：`的 了 是 我 你 他 她 它 我们 你们 也 就 都 和 与 或 及 一个 这个 那个 这些 那些 什么 怎么 为什么 如何 可以 应该 因为 所以 但是 如果 不是 没有 以及 或者 对于 关于 原文 来源`）。
4. 关键词生成：
   - **ASCII 词段**（如 `AU`、`C4D`、`cozai`）：整词保留为一个关键词（不拆）。
   - **其余段（含中文）**：生成全部**相邻二字组**（bigram，如「这也太全能了吧」→ 这也/也太/太全/全能/能了/了吧）；段长恰为 2 时即段本身。
5. 按出现顺序去重，总量封顶 **40** 个（title 的段先于 thesis 的段——title 权重天然靠前）。
6. 返回空数组 = 无可捞关键词（调用方按"无命中"处理，不调查询）。

**命中门槛**：`matchedKeywords.length >= min(2, 实际关键词数)`——只命中一个二字组不算数（如"全能"单独命中太弱），至少两个不同关键词命中才算相关。门槛写为命名常量并注释理由。

## 交付清单

### 1. 新文件 `src/pw-note-recall.ts`

```ts
export type PwNoteEchoBet = {
  betId: string;
  betTitle: string;
  /** 实际用于捞取的关键词（封顶 40，展示时可截断） */
  keywords: string[];
  /** 过门槛的命中，≤3 条，按 PW-39 排序 */
  hits: PwNoteHit[];
};

export type PwNoteEcho =
  | { status: "ok"; bets: PwNoteEchoBet[] }        // bets 可为空数组以外的任意命中组合
  | { status: "no_bets" }                           // 无在途内容押注
  | { status: "unavailable"; error: string };       // 笔记库连不上（含库不存在）
```

导出函数：

1. `extractPwRecallKeywords(title: string, thesis: string): string[]`——纯函数，按上节算法。
2. `recallPwNotesForBet(bet: { id: string; title: string; thesis: string }, opts?: { maxHits?: number }): PwNoteEchoBet`——抽词 → `queryPwNotesByKeywords`（limit 取 maxHits 上限放大一档再门槛过滤，实现自定并注释）→ 过门槛的命中按原排序截到 maxHits（默认 3，上限 10）。关键词为空 → `hits: []`，不查库。**库打开失败不吞错**（由上层汇总成 unavailable）。
3. `buildPwNoteEcho(db: DatabaseSync, opts?: { maxBets?: number; maxHitsPerBet?: number }): PwNoteEcho`——
   - 在途内容押注：`listContentBets(db)` 过滤 `status==='pending'`，`sortContentBetsForDisplay` 排序，取前 maxBets（默认 5，上限 20）张。
   - 0 张 → `{ status: "no_bets" }`。
   - 逐张调 `recallPwNotesForBet`；**跨押注去重**：同一 uid 只保留在展示序第一张命中它的押注下，后续押注下剔除（剔除后不补位）。
   - 笔记库打开/查询失败（pw-notes 抛错）→ 整体 `{ status: "unavailable", error }`，不让异常逃出。
4. `getPwNoteEcho(db)` 的装配被 `getPwDaySummary` 调用——见下节。

纪律：本模块对 Memos 库只读（只调 pw-notes 读函数）；对镇纸库只读（只 SELECT）；不写任何表；不加 HTTP 路由、不改 main.ts、不动 frontend/。

### 2. 改 `src/pw-day-summary.ts`（连带最小改动）

- `PwDaySummary` 增加字段 `noteEcho: PwNoteEcho`；`getPwDaySummary` 内部末尾调 `buildPwNoteEcho(db)` 装配（任何异常兜底成 `{ status: "unavailable", error }`，**绝不能让回响把收工小结搞崩**）。
- `renderPwDaySummaryText` 末尾追加「旧笔记回响」段（空事件日也要输出——回响与当日事件无关，早退分支同样追加）：
  - `no_bets`：`■ 旧笔记回响\n  当前无在途内容押注，今日不捞。`
  - `unavailable`：`■ 旧笔记回响\n  连不上笔记库：{error}`
  - `ok`：逐押注渲染——
    - 有命中：`押注《title》→ 命中 N 条：` + 每条 `「内容截断 50 字」（MM-DD，命中词：a、b）→ url`
    - 无命中：`押注《title》→ 无命中（捞了：词1、词2、词3…）（关键词截断展示，超 8 个补 …）`
    - 该押注 keywords 为空：`押注《title》→ 无可捞关键词，跳过。`
- 既有九档分类、countLine、otherDist、对账锚点**一律不动**；回响段不进任何计数。

### 3. 测试

新文件 `src/pw-note-recall.test.ts`（node:test，登记进 package.json；mock Memos 库沿用 pw-notes.test.ts 的 tmp 目录建库范式 + `MEMOS_DB_PATH` 环境变量覆盖）：

1. **抽词单测**：CJK bigram 生成正确；ASCII 词整词保留；停用词/纯数字/单字符被丢弃；「来源：」行与「原文：」前缀剔除；去重与 40 封顶；全停用词输入返回 []。
2. **捞取（mock 库）**：在途 pending 内容押注 + mock 笔记——命中 ≥2 词的笔记进 hits、只命中 1 词的被门槛挡掉；hits ≤3；matchedKeywords 如实。
3. **跨押注去重**：同一 uid 命中两张押注，只出现在展示序第一张开。
4. **空态**：无 pending 内容押注（含只有 void/settled/非 content 押注的情形）→ `no_bets`；有押注无命中 → hits 空、keywords 如实列出。
5. **库不可用**：`MEMOS_DB_PATH` 指向不存在路径 → `buildPwNoteEcho` 返回 `unavailable` 不抛错；`getPwDaySummary` 照常返回且 `noteEcho.status==='unavailable'`。
6. **day-summary 集成**：mock 镇纸库造 pw_runs 事件 + mock Memos 库造命中笔记 → 渲染文本含「旧笔记回响」段与命中行；**对账锚点回归**（各档和+otherCount=totalEvents 不变，回响不进计数）；空事件日渲染也含回响段。
7. **零写入对账**：捞取前后 mock Memos 库 db+wal sha256 逐字节一致。

`src/pw-day-summary.test.ts` 既有测试**必要连带**：每个用例补 `MEMOS_DB_PATH` 指向不存在路径（或 tmp mock 库），保证确定性、不碰真实 Memos 库；断言语义不变处不改断言。

## 质量约束与验收终态

- `PATH="$HOME/.local/node/bin:$PATH" npm run verify` 全绿（含新测试）。
- 真实库冒烟（主代理执行）：
  1. 经 Memos API 造一条与真实在途押注标题有 ≥2 个共同关键词的笔记 → 脚本调 `buildPwNoteEcho` 看到命中 + `curl /api/pw/day-summary` 文本含「旧笔记回响」与命中行。
  2. 经 API 归档该笔记 → 再跑 → 如实"无命中"。
  3. 冒烟前后真实 Memos 库 db+wal sha256 对账（镇纸侧零写入；经 API 的建/归档是 Memos 自己的行为，对账口径=镇纸读取动作不改变库字节，分两段对）。
  4. 冒烟用的临时笔记最后归档处置，不留垃圾。
- mock 测试全绿；main.ts、frontend/ 零改动；不 commit。
- node 须知：命令前缀 `PATH="$HOME/.local/node/bin:$PATH"`（默认 node 是坏的 cua_node）；node24 TS 剥离器不认跨行 `as` 断言，断言写同行。

## 验收记录

**验收通过（2026-08-08）**；实现=DeepSeek 子代理，复核/verify/真实库冒烟=主代理亲做。

- 交付：`src/pw-note-recall.ts`（174 行，3 函数 2 类型）+ `src/pw-note-recall.test.ts`（7 组）+ `src/pw-day-summary.ts` +55 行（noteEcho 字段、safeNoteEcho 双层兜底、renderNoteEcho 四态渲染，空事件日也输出回响段）+ `src/pw-day-summary.test.ts` 连带（全文件 MEMOS_DB_PATH 指向不存在路径）+ package.json 登记。main.ts / frontend/ 零改动，未 commit。
- verify（主代理跑）：**224/224 全绿**（217+7），selfcheck ok，前端 build 成功。
- 真实库冒烟（主代理跑）：
  1. 基线捞取：5 张在途内容押注按菜号牌序出列，抽词 17/20/40/7/32 个；真实命中 1 条——押注 82a52016《PW-33 冒烟…》命中 PW-38 验收笔记（命中词 PW、冒烟），其余 4 张如实无命中 ✓
  2. 经 Memos API 造与押注 1ba1711d 对词的笔记 → `GET /api/pw/day-summary`（后端重启后）回响段输出：该押注「命中 1 条」附 50 字截断、命中词 14 个、回链 `http://127.0.0.1:5230/memos/jeK6dqiGCsigPhgSzxnUek` ✓；三张无命中押注如实列出所捞关键词 ✓
  3. 归档该笔记 → 再捞：1ba1711d 如实 0 命中（归档不返回 ✓），82a52016 真实命中保留 ✓
  4. 零写入对账：纯读捞取前后真实 Memos 库 db+wal sha256 逐字节一致（两次纯读腿均一致；期间 -wal 变化仅为 Memos API 自身建/归档写入，与镇纸无关）✓
- 与规格的偏差：①规格 §1.4「getPwNoteEcho 的装配」为文档表述残留（导出清单只有 3 函数），按 §2 实现未导出该名，装配经 day-summary 内部 safeNoteEcho 调 buildPwNoteEcho（子代理申报，主代理认可）；②测试夹具补 pw_content_drafts 表（getPwDaySummary 既有联查语句需要，非实现问题）；③查询上限按 maxHits×3 放大以留门槛过滤余量（规格授权「实现自定并注释」）。
