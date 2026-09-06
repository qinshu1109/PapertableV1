# TASK-PW-58 笔记自动卷积（日报/周报/月报）

## 白话：这刀是干什么的

现在的笔记洞察（PW-53）要你手动点「跑洞察」才出报告。这刀之后不用点了：**每天的笔记自动卷成一份日报草稿，每周由日报卷成周报，每月由周报卷成月报**——一层卷一层，你到笔记屏直接看成品。

学的是 SpringNote 的「自动卷积」机制，但按咱们的规矩落地：AI 只出草稿，报告只是给你看的汇总，不做任何决定；没记笔记的日子不硬凑；生成失败下个周期自己重试；你什么都不用管。

模型走全局激活的那一份（现在是 DeepSeek），已拍板，不新接配置。

## 怎么算好

- 后端常驻巡检：启动 1 分钟后首跑，之后每 30 分钟一轮；每轮找「已结束、有料、还没报告」的期，最多生成 5 条（最近的期优先），慢慢把历史补齐。
- 日报：昨天及之前、当天有笔记的日子，按当天笔记逐条卷一份。
- 周报：上周及之前、本周内有笔记的日子都已有日报（不缺）的周，由本周日报卷一份。
- 月报：上月及之前、本月内有日报的周都已有周报（不缺）的月，由本月周报卷一份。
- 今天/本周/本月还在累积，不卷；没料的期跳过；同一期重复巡检不重复生成（幂等）。
- 报告统一五段（事实/模式/矛盾/假设/最小验证），事实段每条带来源标注（日报标 [笔记N]、周报标 [日报N]、月报标 [周报N]），推断标【推断】。
- 笔记屏新增「卷积」区：日报/周报/月报三档，行内为期+摘要，点开展开全文。
- 手记笔记经飞书速记也好、Memos 直接写也好，第二天都能在日报里看到。

## 必填字段

- 主需求域：内容生产
- 业务接口：提供笔记读取（回收域 → 生产域，只读消费 Memos 库，复用既有接口）
- 数据真值源：`pw_note_rollups`（新正式表，内容生产唯一归属：笔记卷积报告）；Memos 库只读不改写
- 质量约束与验收终态：见「怎么算好」+ verify 全绿 + 真实库冒烟（手动 tick 生成真实日报）+ 视觉验收

## 执行规格

### 后端（新模块 `src/pw-note-rollup.ts`）

1. 新表：
   ```sql
   CREATE TABLE IF NOT EXISTS pw_note_rollups(
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL CHECK(kind IN ('day','week','month')),
     period TEXT NOT NULL,              -- day: 2026-08-09 / week: 2026-W32（周一起）/ month: 2026-08
     source_refs_json TEXT NOT NULL,    -- 日报: [{uid,url,createdAt}]；周报/月报: [{id,period}]
     source_count INTEGER NOT NULL,
     model TEXT,
     report TEXT NOT NULL,
     created_at TEXT NOT NULL,
     UNIQUE(kind, period)
   )
   ```
2. 期计算工具（本地时区，笔记 createdAt 是带偏移的本地 ISO，日期直接取前 10 位）：
   - 日的期 = 日期本身；周的期 = ISO 周（周一起，格式 `YYYY-Www`）；月的期 = `YYYY-MM`。
   - 「已结束」判定：期结束时刻早于当前本地时间。今天/本周/本月一律不算已结束。
3. 读函数：`src/pw-notes.ts` **新增** `readPwNotesByDay(date: string): PwNote[]`（按 createdAt 前 10 位过滤，createdAt ASC）。既有读函数一个不改。
4. 巡检 `runPwNoteRollupTick(db, opts)`（llm/时钟可注入，测试照 pw-note-insight.test.ts 范式）：
   - 顺序：先补日报 → 再补周报 → 再补月报；**每轮预算分层：日报 ≤3、周报 ≤1、月报 ≤1（合计 ≤5）**——防历史回补期间日报候选长期占满预算、周报/月报永远轮不到；期按最近优先。
   - 日报候选：有笔记的、已结束的、pw_note_rollups 里还没有的日子（界：最早一条笔记的日期起）。
   - 周报候选：已结束的周，本周内有笔记的日子全部已有日报且 ≥1 条，周报告还没有。
   - 月报候选：同理（本月内有日报的周全部已有周报且 ≥1 条）。
   - 生成：装配 prompt（来源逐条编号）→ 一次性模型调用（completeSimple + maxRetries 0，照 defaultInsightLlm 范式；异常/空文本重试 1 次，仍败**跳过该期不落行**，下轮再试）→ INSERT（UNIQUE 幂等，INSERT OR IGNORE）。
   - system prompt《卷积纪律》逐字进常量：固定五段、事实与推断分开、每条事实带来源标注（[笔记N]/[日报N]/[周报N] 对应输入编号）、没内容写（无）、不做人格动机诊断、不替用户做决策。
5. 模型：复用 `createPapertableProvider()` 全局激活 provider，model id 记进行。

### 路由与调度（`src/main.ts` 只许两处加法）

6. `GET /api/pw/notes/rollups?kind=day|week|month`：列表（kind 缺省返回全部），period DESC 封顶 200，camelCase 输出（sourceRefs 解析成数组）。
7. `POST /api/pw/notes/rollups/tick`：手动触发一轮巡检（验收和调试用，返回本轮生成条数）。
8. 调度：main.ts 启动处 `setInterval` 每 30 分钟 + 启动 1 分钟后首跑，调 `runPwNoteRollupTick`（调用处 try/catch 包住，异常只记日志不炸服务）。setInterval 只许出现在 main.ts，模块本体不自带定时器。

### 前端（`frontend/src/pw/Notes.tsx` + `pw.css` + `api.ts`）

9. 笔记屏新增「卷积」区（放洞察区上方）：日报/周报/月报三档切换；每行=期（如 2026-08-09 / 2026-W32 / 2026-08）+ report 第一段纯文本摘要（截 80 字）；点行展开 MarkdownView 全文 + 来源清单。交互照抄历史洞察的 details 款；空态文案「还没到卷积时点，记几条笔记，明天就有日报」。

### 测试（新 `src/pw-note-rollup.test.ts`，llm/时钟注入）

10. 日报：当天 2 条笔记 → kind=day、period 对、source_refs 2 条、report 落库；同期重复 tick 不重复生成。
11. 无笔记的日子跳过；今天不生成。
12. 周报：本周有笔记的日子都有日报 → 卷出 kind=week；缺一天日报的周不卷；本周不生成。
13. 月报同理（缺一周周报不卷）。
14. 每轮预算分层生效：日报 ≤3、周报 ≤1、月报 ≤1（日报候选 5+ 且有一层可卷时，一轮出 3 日报 + 1 上层报告）；期按最近优先。
15. llm 连续失败：不落行、下轮 tick 重试成功。
16. readPwNotesByDay：跨日边界、按 createdAt 升序。
17. package.json 登记新测试。

## 防冲突约定

- 只许动：`src/pw-note-rollup.ts`（新）、`src/pw-note-rollup.test.ts`（新）、`src/pw-notes.ts`（只加一个新读函数）、`src/main.ts`（只许两条路由 + 调度启动一处）、`frontend/src/pw/Notes.tsx`、`frontend/src/pw/pw.css`、`frontend/src/lib/api.ts`、`package.json`。
- 不许动：`pw-note-insight.ts`、`pw-note-recall.ts`、`provider-settings.ts`、`pw_note_insights` 表、Memos 库（只读）、其余测试语义。
- 不 commit、不动 git。`as` 断言写同一行（node 24 TS 剥离器不认跨行）。

## 不在本批

- 报告重跑/删除/编辑（报告是快照；笔记补记到旧日子不会自动重卷，日后有真实需要再说）。
- 敏感词预检（笔记全文会发给云端模型，与 PW-53 洞察同口径；预检是既有待拍板候选，不在本刀）。
- 语义向量找回（flomo 三段思路第三段，继续押后）。
- 卷积报告进协作台上下文/押注关联（先看笔记屏好不好用）。

## 验收记录（验收后填）

- 什么能用了 / 什么还不行 / 有什么等拍板：
  - 能用了：后端常驻巡检（启动 1 分钟首跑、之后每 30 分钟一轮；每轮日报 ≤3、周报 ≤1、月报 ≤1，最近优先，只卷已结束且有料的期，失败下轮重试，幂等不重卷）；`POST /api/pw/notes/rollups/tick` 手动触发；`GET /api/pw/notes/rollups?kind=` 列表；笔记屏「卷积」区三档切换、行内期+摘要、展开全文五段+来源清单。真实库已卷出 38 条日报 + W32 周报（7 日报 26 条笔记，来源标注到 [日报N/笔记N]），模型 deepseek-v4-flash。
  - 还不行/边界：①历史回补约百余天，按配额每天自然收敛（调度器自己跑，不用管）；②报告是快照——补记到旧日子的笔记不会重卷（不在本批，定过的）；③笔记全文会发给云端模型（与 PW-53 洞察同口径，敏感词预检仍是待拍板候选）。
  - 等拍板：无。
- 证据：verify 302/302 全绿（我亲跑）；真实库手动 tick 七次：首轮 5 日报（08-09～08-05），逐轮补齐无重复（幂等实证）；预算分层修复后一轮出 3 日报 + 1 周报（W32 周报全文核对：来源标注 [日报N/笔记N]、空笔记如实标注、【推断】前缀、矛盾段写（无））；行内/展开两态截图验收（/tmp/pw-verify/pw58-notes.png、pw58-expanded.png，我亲截亲看）。
- 文件清单：src/pw-note-rollup.ts（新）、src/pw-note-rollup.test.ts（新）、src/pw-notes.ts（只加 readPwNotesByDay）、src/main.ts（两条路由 + ensure 挂载 + 调度启动/清理）、frontend/src/pw/Notes.tsx、frontend/src/pw/pw.css、frontend/src/lib/api.ts、package.json。未动洞察/回收/provider 文件与 Memos 库；未 commit。
- 过程中修掉的规格漏洞（如实记录）：初版「每轮合计 5 条」在历史回补期间会让日报永远占满预算、齐备的周报轮不到卷——冒烟现形后改为分层预算（日 3/周 1/月 1、层间不挪用），测试改写锁定。
