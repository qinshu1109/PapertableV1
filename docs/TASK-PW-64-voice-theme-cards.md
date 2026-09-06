# TASK-PW-64 语料评论主题卡：观众声音右栏从逐条原文改为主题卡 + 逐字证据

- 主需求域：实践与数据回收
- 业务接口：提供语料与回流数据（语料库评论原文只读消费，内容生产 ← 实践与数据回收，既有接口不变）；提请选题候选（收录后的单条声音走 PW-45 既有提升链，不变）
- 数据真值源：评论真值留语料库（落盘 comments.jsonl，只读不改写）；主题卡为本地派生数据落 papertable.sqlite3（新表 `pw_voice_theme_cards` + `pw_voice_theme_card_items` + 台账 `pw_voice_card_runs`，可整体重建）；整卡收录仍写 `pw_voice_items`（人按卡才生效，PW-08 写权限规格不变）
- 质量约束与验收终态：不破坏语料库只读纪律与声音屏既有通路（左栏声音列表/分拣/提请零改动）；AI 只摆盘不结论——卡上每条评论逐字、作者/赞数/时间齐；单视频单次聚合成本 ≤ ¥0.15（DeepSeek），超支走 failed；已收录逐字防重（PW-46 语义）不变；左栏声音列表各区口径不变

## 这刀是干什么的

观众声音屏右边的"语料评论"现在是逐条原文，一个视频几十上百条、以后几千条，看不动。改成：AI 先按主题把一个视频的评论聚成几张"主题卡"——卡上一个主题名一句、一句"这些人在乎什么"，下面挂几条逐字评论原文（谁说的、几个赞、什么时候）。你判的是主题（这群观众的这个呼声值不值得收），不再是逐条刷评论。

判一张卡两种走法：整卡收录（卡里评论全部进左边声音列表，AI 顺手自动分拣，已收录过的自动跳过不重复）；弃（这个主题以后重聚不再浮出来）。卡里单条看上的也可以只收那一条。

没聚过的视频，右栏给"聚一下"按钮，点完出卡；评论抓多了再点一次重聚（已收录/已弃的卡不动）。

## 怎么算好

- 右栏选一个视频，摆的是几张主题卡而不是几十条原文；卡上证据逐字、带作者/赞数/时间、可展开。
- 整卡收录后：卡内评论逐条出现在左边声音列表（带自动分拣标签）；同一视频已收录过的评论不重复进；左栏能对上（哪张卡收了几条）。
- 弃一张卡后点重聚：这个主题不再出现；已收录的卡也不动。
- 单条收录按钮仍在（卡内每条一个），已收录的置灰。
- 一次聚合（一个视频）≤ ¥0.15，台账记帐。
- 现有 4 个已抓视频：各点一次"聚一下"出卡，右栏不再以逐条列表为主视图。

以下给干活的看，可以跳过。

## 依据

- wayfinder 地图：`docs/wayfinder/voice-theme-cards/`（Q00 三问关票）。
- 形式先例：TASK-PW-63 捞料概念卡（同日验收），卡面与聚合模式照搬。
- 现状证据：`pw_corpus_docs` 4 视频各 79-100 条评论；右栏 like 降序 top50 逐条（`frontend/src/pw/Voice.tsx:177-230`）。

## 设计

### 数据

```sql
CREATE TABLE IF NOT EXISTS pw_voice_theme_cards (
  id TEXT PRIMARY KEY,
  bvid TEXT NOT NULL,
  run_id TEXT NOT NULL,
  title TEXT NOT NULL,                -- 主题一句
  summary TEXT,                       -- 这些人在乎什么
  status TEXT NOT NULL CHECK(status IN ('suggested','collected','rejected')),
  decided_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pw_voice_theme_card_items (
  card_id TEXT NOT NULL,
  rpid INTEGER NOT NULL,
  message TEXT NOT NULL,              -- 逐字快照（真值仍在语料库）
  uname TEXT, like_count INTEGER, ctime INTEGER,
  voice_id TEXT,                      -- 收录后回写 pw_voice_items.id
  PRIMARY KEY (card_id, rpid)
);
CREATE TABLE IF NOT EXISTS pw_voice_card_runs (
  id TEXT PRIMARY KEY,
  bvid TEXT NOT NULL,
  started_at TEXT NOT NULL, finished_at TEXT,
  trigger_kind TEXT NOT NULL,         -- manual（v1 只有手动）
  provider TEXT NOT NULL, model TEXT NOT NULL,
  cards_count INTEGER NOT NULL DEFAULT 0,
  cost_cny REAL, raw_response TEXT, status TEXT NOT NULL
);
```

### 流程

1. 聚合 `aggregatePwVoiceThemeCards(db, bvid)`（手动触发）：读 `readPwCorpusComments` 全量，like 降序截断 ≤300 条（防成本爆炸）；排除已 collected/rejected 卡覆盖的 rpid；一次 DeepSeek 调用输出 `[{title,summary,rpids[]}]`；解析容错照 `parseCards` 模式（正则取数组、逐项校验、坏项丢弃、rpid 对不上丢弃）；未认领评论落「未归堆」兜底卡。重聚语义照 PW-63：suggested 卡整批删了重建，collected/rejected 卡与其 rpid 不进输入。
2. 整卡收录 `collectPwVoiceThemeCard(db, cardId)` → 事务：卡置 collected；卡内逐条复用 `addPwVoiceItem`（platform=`bilibili:{bvid}`、content 逐字、author、capturedAt=ctime 转 ISO——与 PW-46 同构），PW-26 自动分拣挂钩自然触发；已存在（platform+逐字 content+未丢弃）的跳过不报错，voice_id 回写卡项。卡非 suggested 409。
3. 弃 `rejectPwVoiceThemeCard(db, cardId)` → 卡 rejected（重聚排除其 rpid，卡项快照保留备查）。
4. 单条收录沿用既有 `/api/pw/voice/collect`（bvid+rpid），卡项 voice_id 由列表查询时按逐字防重规则现算（不写回）。
5. 成本：预算常量 `PW_VOICE_CARD_BUDGET_CNY = 0.15`，raw_response 落 `pw_voice_card_runs`（超 4000 字截断照既有模式），超支走 failed。

### 端点

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/pw/voice/corpus-cards?bvid=&status=` | GET | 卡列表（含卡内评论：rpid/message/uname/like/ctime/collected） |
| `/api/pw/voice/corpus-cards/aggregate` | POST | `{ bvid }` 聚/重聚一个视频 |
| `/api/pw/voice/corpus-cards/collect` | POST | `{ cardId }` 整卡收录 |
| `/api/pw/voice/corpus-cards/reject` | POST | `{ cardId }` 弃 |
| `/api/pw/voice/corpus-comments` | GET | 保留（对账用）；前端右栏不再消费 |
| `/api/pw/voice/collect` | POST | 沿用（卡内单条收录） |

### 纪律

聚合固定 DeepSeek（provider-settings.ts 单独构造纪律不变）；聚合 prompt 写进代码注释可审计；评论真值不动语料库；收录仍是人按卡/按条触发，AI 不自动收录；tick/定时器不引入（v1 纯手动）；左栏声音列表与提请链零改动。

## 分工

- 后端（新模块 `src/pw-voice-cards.ts` + 测试 + `main.ts` 挂路由）：经 herdr 派 Codex，简报 `agent-bridge/briefs/09-voice-theme-cards-backend.md`。
- 前端（`frontend/src/pw/Voice.tsx` 右栏换主题卡视图 + `lib/api.ts` + `pw.css` 复用概念卡样式）：Kimi 直接改（后端就位后）。
- 验收：联调后按「怎么算好」逐条在 http://127.0.0.1:4317 上过屏。

## 验收记录（2026-08-11，kimi 主会话执行）

**什么能用了**：观众声音屏右栏从几十条原文变成主题卡。实聚「Qoder vs Cursor」79 条评论 → 11 张卡（积分消耗、工具对比、模型选择、测试建议……官方引流评论单独成卡并标了「广告」），卡上每条评论逐字、带作者/赞数/时间。整卡收录、单条收录、弃卡、重聚按钮都在屏上可用；左栏声音列表没动。

**什么还不行**：卡的收录/弃最终动作留给用户本人——AI 只摆盘不替收，联调没替你按过。其余 3 个已抓视频还没聚，切过去点一次「聚一下」即出卡（一个视频一次几分钱）。

**有什么等拍板**：①去观众声音屏判这 11 张卡；②「整卡收录」会把卡里没收过的评论全部收进声音列表（已收过逐字防重自动跳过）——收录单位从单条变成主题，这是本刀的核心变化，用不顺手再说。

过屏证据（逐条对「怎么算好」）：

- 右栏选视频摆主题卡不摆原文：实测 79 条 → 11 张卡上屏，逐字证据 + 作者/赞数/时间齐（截图核对）。✅
- 整卡收录/单条收录/弃/重聚：后端 4 组专项测试全绿（含逐字防重跳过、自动分拣挂钩触发、voice_id 回写、重复收录 409、弃卡重聚不浮出、like 截断 300、成本护栏）；UI 按钮屏上核对存在。真机动作未代按。✅（机制层）
- 聚合成本 ¥0.017（79 条评论一次），≤ ¥0.15；台账 `pw_voice_card_runs` 落账含 raw_response。✅
- 没聚过的视频：卡列表为空时屏上给「聚一下」按钮 + 引导文案（空态代码路径 + 接口空返回已核对）。✅
- `PATH="$HOME/.local/node/bin:$PATH" npm run verify`：323/323 测试 + selfcheck + 前端 build 全绿（后端交付时与前端改造后各跑一遍）。✅
- 左栏声音列表/分拣/提请链零改动（截图核对 + diff 范围核对）。✅

改动文件：后端 `src/pw-voice-cards.ts`（新，272 行）、`src/pw-voice-cards.test.ts`（新，116 行）、`src/main.ts`（4 条新路由 + 启动建表）、`package.json`（登记测试）；前端 `frontend/src/pw/Voice.tsx`（右栏换主题卡）、`frontend/src/lib/api.ts`（卡类型 + 4 个端点）、`frontend/src/pw/pw.css`（主题卡样式）。未 commit、未 push。

## 修订（2026-08-11 晚，用户验收后拍板方向修正）

**白话**：主题卡屏上实聚后，用户判「还是太长太多」——而且让 AI 一次性分析全部评论，只会过拟合输出平庸桶（实锤：出现了「其他工具对比与推荐 17 条」这种桶）。改用思路一：**AI 做筛子，不做摘要**——AI 逐条只判「有没有信息量」（广告/玩梗/纯表情/灌水 → 噪音），筛出的信号条按轻量标签分组摆盘，人读逐字原文判断。**不做后台常驻 Harness，用 skill 驱动**（`skills/voice-comment-sieve/`），按需由 agent 跑。

**本刀范围随之调整**：上面交付的主题卡后端与前端右栏保留不拆（留作台账与对照）；skill 试跑（对 BV1DhpYzSENp 实跑一次，报告落 `agent-bridge/out/`）验证形式后，再定右栏数据源是否切换——切换算下一刀，另立 TASK。

决策全程见 `docs/wayfinder/voice-theme-cards/Q01-sieve-pivot.md`。
