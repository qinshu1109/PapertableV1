# TASK-PW-61 笔记屏改造：定时捞料 + 笔记大盘

- 主需求域：内容生产
- 业务接口：提供笔记读取（实践与数据回收 → 内容生产，v0.6，只读消费 Memos）；提供有效判断·生产侧（判断沉淀与复用 → 内容生产，金子墓碑与 MemOS 远端记忆只读消费）；提供引用记录（v0.5，身价链只读消费）
- 数据真值源：笔记真值在 Memos（只读不改写）；金子墓碑真值在 pt_verdicts / pw_gold_mirror（只读消费）；新增本地派生数据「捞料运行台账 + 捞料候选 + 身价日快照」落 papertable.sqlite3（`pw_miner_runs` / `pw_miner_candidates` / `pw_note_value_daily`，可整体重建）；`pw_note_attach` 扩 `role` 列（素材角色，人确认时定）
- 质量约束与验收终态：不破坏 Memos 只读纪律与八屏既有通路；候选 AI 只建议、人确认才生效（写权限规格 v1 不变）；身价为账本确定性计算，AI 不评分；单轮捞料成本 ≤ ¥0.10（DeepSeek），超支自动降载；PW-60 树图与更早的列表/热力图收进二级标签，仍可用

## 这刀是干什么的

现在笔记屏是把笔记摆出来给人看——看过的笔记人不会忘，只是想不起来，摆再多也勾不起来。真正的问题是：几千条存量笔记躺着，没人知道哪条值钱、哪条该拿出来用。

改完之后，笔记屏首屏变成一块"笔记大盘"：DeepSeek 每天早上（或手动触发）按你在途的押注和当前方向，从四个地方自动捞料——笔记库、金子墓碑库、MemOS 记忆——捞到的先当候选，你确认才挂上押注（确认时顺手标一下这条料当什么用：论点/案例/标题/反例）。你的每次确认和"弃"都会喂给下一轮，捞得越来越准。大盘同时摆四本账：今天从哪捞的、近 7 天捞出 vs 确认、最值钱的笔记（谁的料真进了视频还结了账）、缺料提醒（哪张押注真没料/有料没人用/只想没产出）、从没用过的笔记还剩多少。

## 怎么算好

- 每天 06:30 自动跑一轮（也可在笔记屏手动触发），跑完笔记屏顶部出现"今天捞出 N 条"；候选按押注分组，每条可 确认挂上 / 弃 / 看原文，原文跳 Memos 原链。
- 确认候选时必须能选素材角色；确认后该笔记进身价计算。
- 被你弃掉的候选，下轮同类少捞（台账里能看到弃的记录影响了捞取）。
- 大盘五个区（KPI / 今天从哪捞的 / 近 7 天捞出 vs 确认 / 最值钱的笔记 top5 / 缺料提醒 / 从没用过的笔记）每个数字都能点出明细，和台账对得上。
- 缺料提醒能区分三种：库里真没料（连捞数轮 0 条）、有料没人用（有相关笔记但 0 确认）、只想没产出（有确认但 0 进草案）。
- 单条笔记能看完整流水账：何时挂上押注→进草案→进成品→数据回流→结账，各带来什么身价变化。
- 一轮捞料成本 ≤ ¥0.10；台账记录每轮成本。

以下给干活的看，可以跳过。

## 方案依据

- 需求定位与调研：`agent-bridge/out/03-ai-notes-mining.md`（行业最强只到内容写回/调频，"使用反馈复利"是空白；镇纸握押注+结账真值，有资格做）。
- 视觉定稿：`agent-bridge/out/05-dashboard-mockup-v2.png`（纸感浅色、大白话文案，以此为准）。

## 数据与接口设计

### 新表（papertable.sqlite3，本地派生）

```sql
CREATE TABLE IF NOT EXISTS pw_miner_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL, finished_at TEXT,
  trigger_kind TEXT NOT NULL,          -- scheduled | manual
  provider TEXT NOT NULL, model TEXT NOT NULL,
  candidates_count INTEGER NOT NULL DEFAULT 0,
  by_source_json TEXT,                  -- {note:n,gold:n,tombstone:n,memos:n}
  cost_cny REAL, status TEXT NOT NULL   -- running|done|failed(+error)
);
CREATE TABLE IF NOT EXISTS pw_miner_candidates (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL,
  source TEXT NOT NULL,                 -- note|gold|tombstone|memos
  ref_uid TEXT NOT NULL,                -- 笔记 uid / 判决 id / 记忆 id
  snippet TEXT NOT NULL,                -- 列表展示用短摘（≤80字）
  suggested_bet_id TEXT, reason TEXT,   -- AI 建议归属与一句理由
  status TEXT NOT NULL,                 -- suggested|confirmed|rejected
  decided_at TEXT, created_at TEXT NOT NULL,
  UNIQUE(source, ref_uid, suggested_bet_id)  -- 幂等：同料同押注不重复建议
);
CREATE TABLE IF NOT EXISTS pw_note_value_daily (
  note_uid TEXT NOT NULL, day TEXT NOT NULL, score REAL NOT NULL,
  PRIMARY KEY (note_uid, day)
);
ALTER TABLE pw_note_attach ADD COLUMN role TEXT;  -- 论点|案例|标题|反例|其他（确认时人定）
```

身价公式（常量，写死在代码注释里）：`score = 确认挂接×1 + 进草案×3 + 进成品×5 + 结账胜+10 / 平+3 / 败+0（不扣分，只挂"待复核"标）`。趋势 = `pw_note_value_daily` 近 7 天。

### 新端点（挂 main.ts 既有 pw 路由区）

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/pw/miner/run` | POST | 手动触发一轮捞料（scheduled tick 复用同一函数） |
| `/api/pw/miner/candidates?status=suggested` | GET | 候选列表（按 suggested_bet_id 分组返回） |
| `/api/pw/miner/candidates/confirm` | POST | `{ id, betId, role }` → confirmed；source=note 时 upsert `pw_note_attach`(confirmed, role) |
| `/api/pw/miner/candidates/reject` | POST | `{ id }` → rejected（下轮捞取降权同类） |
| `/api/pw/notes/board` | GET | 大盘一区到五区全部数据（KPI/来源构成/7天对比/top5 身价+趋势/缺料三分类/未用过计数） |
| `/api/pw/notes/journey?uid=` | GET | 单条笔记流水账时间线（挂接→草案→成品→回流→结账） |

纪律：捞料固定走 DeepSeek（参照 provider-settings.ts 注册表单独构造，不动全局激活 provider）；tick 调度照 pw-note-rollup.ts 的模式（模块无定时器，main.ts setInterval + .unref()）；Memos 只读沿用 pw-notes.ts 纪律；MemOS 只读消费（http://127.0.0.1:8002，MCP search，参照 verdict-memos.ts 的客户端）；押注真值 listContentBets、方向 getSieveDirection。

## 分工

- 后端（src/pw-miner.ts + pw-note-board.ts + 测试 + main.ts 挂路由与 tick）：经 herdr 派 Codex，简报 `agent-bridge/briefs/06-miner-valueboard-backend.md`。
- 前端（frontend/src/pw/Notes.tsx 首屏换大盘 + 候选确认流 + 单条流水账；lib/api.ts；pw.css）：Kimi 直接改。
- 验收：联调后按「怎么算好」逐条在 http://127.0.0.1:4317 上过屏。
