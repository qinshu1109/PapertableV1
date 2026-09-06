# TASK-PW-63 捞料概念卡：确认区从逐条原文改为概念卡 + 逐字证据

- 主需求域：内容生产
- 业务接口：提供笔记读取（消费，实践与数据回收 → 内容生产，PW-39 只读消费 Memos）；提供有效判断·生产侧（消费，判断沉淀与复用 → 内容生产，金子墓碑只读消费）；概念归组落既有「捞料运行台账与候选」唯一归属（内容生产域内演化，需求域 v1.3）
- 数据真值源：笔记真值在 Memos（只读不改写）；金子墓碑真值在 pt_verdicts / pw_gold_mirror（只读消费）；概念卡为本地派生数据落 papertable.sqlite3（新表 `pw_miner_cards` + `pw_miner_candidates` 扩 `card_id` 列，可整体重建）；候选确认仍写 `pw_note_attach`（人确认才生效，写权限规格 v1 不变）
- 质量约束与验收终态：不破坏 Memos 只读纪律与八屏既有通路；AI 只摆盘不结论——卡上每个字可当场验真（证据逐字、可展开全文、可跳原链）；确认/弃的既有回流语义不变；单轮捞料+聚合总成本 ≤ ¥0.15（DeepSeek），超支自动降载；调度去重修复后同一本地日 scheduled 只跑一轮；PW-61 大盘各区数字口径不变

## 这刀是干什么的

笔记屏的"今天捞到的"现在是一堆原文摘要，每条都要读进去才能判，51 条攒在那没人判得动。改成：AI 先把同向的料聚成几张"概念卡"——卡上一个概念名一句、一句"为什么现在浮出来"、下面挂几条逐字原文证据。你判的是概念（这堆料说的这个事值不值得用），不再是逐条读原文。

判一张卡三种走法：整卡挂到某张押注（顺手选一个统一用途：论点/案例/标题/反例，挂之前卡里单条可以先剔掉）；标成"方向种子"（提醒你这堆料可能够格当下一个选题——采不采纳永远你定，系统不自动改方向不自动建押注）；弃（下轮这类少捞）。

两种特殊的料 AI 只标注、不藏不删：捞回来发现是你自己拍过的板（卡上标"自己的记忆"）；只有链接没你想法的收藏壳（标"收藏壳"）。怎么处置你说了算，弃掉就当教它。

## 怎么算好

- 每天一轮捞料（修完调度 bug 后一天真的只跑一轮），跑完确认区摆的是几张概念卡而不是几十条原文；卡上证据逐字、可展开全文、可跳 Memos 原链。
- 整卡确认后：卡里没被剔掉的笔记全部挂上选定押注并进身价计算；台账能对上（哪张卡、哪几条、什么角色）。
- 弃一张卡或剔一条料，下轮同类少捞（台账看得见影响）。
- "标方向种子"只落一个标记，不自动改方向、不自动建押注。
- 现有 51 条积压：迁移跑一次聚合，变成概念卡上屏，不再以逐条形式出现。
- 一轮总成本（捞 + 聚）≤ ¥0.15，台账记录两笔账。

以下给干活的看，可以跳过。

## 依据

- wayfinder 地图：`docs/wayfinder/miner-concept-cards/`（Q00 三问关票 + 试金石 5 卡全记录）。
- 调度 bug 证据：`pw_miner_runs` 台账 2026-08-10 23:48 ~ 2026-08-11 00:03 UTC 每 5 分钟一轮共 17 轮 scheduled——`runPwMinerScheduledTick` 拿 `substr(started_at,1,10)`（UTC 日期）比 `localDay`（本地日期），窗口期对不上就反复跑。

## 设计

### 数据

```sql
CREATE TABLE IF NOT EXISTS pw_miner_cards (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,               -- 聚合所属轮次；迁移轮用专门 run 记录
  kind TEXT NOT NULL,                 -- concept | self_memory | link_shell
  title TEXT NOT NULL,                -- 概念一句
  summary TEXT,                       -- 为什么现在浮出来（含与哪张押注同向）
  status TEXT NOT NULL,               -- suggested | confirmed | rejected | direction_seed
  decided_bet_id TEXT, decided_role TEXT,
  decided_at TEXT, created_at TEXT NOT NULL
);
ALTER TABLE pw_miner_candidates ADD COLUMN card_id TEXT;  -- 候选归卡；剔单条=该候选 rejected 但留在卡内记录
```

### 流程

1. 捞料照旧（候选落 `pw_miner_candidates`，现有逻辑不动）。
2. 同轮追加一次聚合调用（DeepSeek）：输入本轮新候选 + 现存全部 suggested 候选（按 source+ref_uid 去重），输出卡划分 JSON：`[{kind,title,summary,suggestedBetId?,candidateKeys[]}]`。既有 suggested 候选允许随重聚换卡；已 confirmed/rejected 的一律不动。聚合成本并入该轮台账（台账记捞/聚两笔）。
3. 卡动作：
   - 确认 `{ cardId, betId, role }` → 卡 confirmed；卡内仍 suggested 且 source=note 的候选逐条复用 `confirmPwNoteAttach`（PW-61 既有）挂押注+角色；非 note 源候选只置 confirmed。
   - 弃 `{ cardId }` → 卡 rejected + 卡内 suggested 候选 rejected（下轮降权由既有 rejected 回流机制自动吃下）。
   - 剔单条 `{ candidateId }` → 该候选 rejected，卡不变（沿用既有 `/api/pw/miner/candidates/reject`）。
   - 标方向种子 `{ cardId }` → 卡 status=direction_seed，只落标记，不触发任何自动流程。
4. 迁移：一次性把现存 51 条 suggested 聚合成卡（一次 manual run，幂等可重跑）。
5. 调度 bug 修复：`runPwMinerScheduledTick` 的"当天已跑"比对两端统一成本地日口径，加回归测试（构造 UTC/本地跨日边界）。

### 端点

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/pw/miner/cards?status=suggested` | GET | 卡列表（含卡内候选：snippet/reason/memosUrl/source） |
| `/api/pw/miner/cards/confirm` | POST | `{ cardId, betId, role }` 整卡确认 |
| `/api/pw/miner/cards/reject` | POST | `{ cardId }` 整卡弃 |
| `/api/pw/miner/cards/seed` | POST | `{ cardId }` 标方向种子 |
| `/api/pw/miner/candidates/reject` | POST | 沿用（剔单条） |
| `/api/pw/miner/candidates?status=` | GET | 保留（台账/对账用）；前端确认区不再消费 |

### 纪律

捞料 + 聚合固定 DeepSeek（provider-settings.ts 单独构造纪律不变，不动全局激活 provider）；聚合 prompt 写进代码注释可审计，raw_response 落 `pw_miner_runs` 可溯源；AI 不删料不藏料（self_memory / link_shell 只是卡型标注，照样上屏）；方向种子不触发任何自动流程；成本超预算自动降载沿用既有阈值模式；tick 调度照 pw-note-rollup 模式（模块无定时器，main.ts setInterval + .unref()）。

## 分工

- 后端（`src/pw-miner.ts` 聚合步骤 + 卡 CRUD + 迁移 + 调度修复 + 测试 + `main.ts` 挂路由）：经 herdr 派 Codex，简报 `agent-bridge/briefs/08-miner-concept-cards-backend.md`。
- 前端（`frontend/src/pw/Notes.tsx` / `BoardTab.tsx` 确认区换卡视图 + `lib/api.ts` + `pw.css`）：Kimi 直接改（后端就位后）。
- 验收：联调后按「怎么算好」逐条在 http://127.0.0.1:4317 上过屏。

## 验收记录（2026-08-11，kimi 主会话执行）

**什么能用了**：笔记屏大盘确认区从 51 条原文变成了 8 张概念卡。每张卡一个概念名 + 一句"为什么现在浮出来"，下面挂逐字原文证据，点证据展开捞它的理由、点"原文 ↗"跳 Memos。整卡挂押注（选押注+统一角色）、标方向种子、弃、单条剔都在屏上可用。「自己的记忆」「收藏壳」两种特殊料只标注不藏。调度 bug 已修（本地日口径，跨日边界有回归测试）。

**什么还不行**：卡的最终拍板（挂哪张押注、当什么用、弃不弃）留给用户本人——AI 只摆盘不拍板，联调没替你按过确认。调度修复的真实效果要等明天 06:30 后看台账（应只有 1 轮 scheduled）。

**有什么等拍板**：①8 张卡等你判；②聚合把跨押注重复料（20 条同 source+ref_uid 的重复候选行）合并进卡，重复行本身留在旧候选表里不再上屏——不影响判断，记账上知道有这回事即可；③迁移没有独立按钮，每轮捞料自动带聚合（含存量），这是设计如此。

过屏证据（逐条对「怎么算好」）：

- 手动捞一轮（2026-08-11 17:14）跑完：新捞 11 条 + 51 条积压聚成 8 张卡（6 概念 + 1 自己的记忆 + 1 收藏壳，含「未归堆」兜底卡），确认区不再逐条出现。✅
- 卡上证据逐字、可展开理由（屏上实测展开正常）、可跳 Memos 原链（链接 href 已核对）。✅
- 整卡确认/弃/标种子/剔单条：后端 7 组专项测试全绿（含挂押注进 pw_note_attach、弃回流降权、种子无副作用、迁移幂等、跨日调度、成本护栏）；UI 上押注选择器实测载入 5 张在途押注并预选建议押注。真机拍板动作未代按。✅（机制层）
- 一轮总成本 ¥0.032（捞+聚合计），≤ ¥0.15；台账 raw_response 含捞取与聚合两笔原文。✅
- `PATH="$HOME/.local/node/bin:$PATH" npm run verify`：319/319 测试 + selfcheck + 前端 build 全绿（后端交付时与前端改造后各跑一遍）。✅
- 大盘其余各区（KPI/来源/7 天/身价 top/缺料/未用）屏上核对数字口径不变。✅

改动文件：后端 `src/pw-miner.ts`（506→727 行）、`src/pw-miner.test.ts`（167→245 行）、`src/main.ts`（4 条新路由，1046-1070 行）；前端 `frontend/src/pw/BoardTab.tsx`（确认区换概念卡视图）、`frontend/src/lib/api.ts`（卡类型 + 4 个端点）、`frontend/src/pw/pw.css`（概念卡样式，沿用纸感体系）。未 commit、未 push。排障留痕：ego-browser 截图 CDP 超时，kill 旧 ego lite 进程后用 `cdp Page.captureScreenshot format=jpeg` 绕过（PNG 路径仍超时）。
