# 简报 09：语料评论主题卡后端（TASK-PW-64）

> 给 Codex 的执行规格。仓库：`/Users/qinshu/Documents/papertableV1`。先读 `docs/TASK-PW-64-voice-theme-cards.md`（任务真值源）与 `docs/wayfinder/voice-theme-cards/`（决策依据），再动手。不 commit、不 push。

## 背景一句话

观众声音屏右栏语料评论是逐条原文列表（like 降序 top50），量级判不动。用户拍板照 PW-63 概念卡模式改成「主题卡 + 逐字证据（带赞数）」：手动按视频聚合，整卡收录进声音列表（走既有逐字防重与自动分拣），弃卡重聚不再浮出。

## 环境纪律

- 本机 node 必须用 `PATH="$HOME/.local/node/bin:$PATH"` 前缀（PATH 上默认 node 是 ChatGPT 应用内置的坏 node，会断前端构建）。
- 验收命令：`PATH="$HOME/.local/node/bin:$PATH" npm run verify` 全绿。
- 真实库 `$HOME/Library/Application Support/Papertable/papertable.sqlite3` 只许只读查询对账，绝不手工 INSERT/UPDATE/DELETE。

## 改动清单

### 1. 新模块 `src/pw-voice-cards.ts`（+ `src/pw-voice-cards.test.ts`）

参照 `src/pw-miner.ts` 的既有模式（ensure 幂等建表、httpError、parseCards 容错、事务、成本护栏、DeepSeek 单独构造）。

**a) 新表**（`ensurePwVoiceCardTables`，幂等；DDL 照 TASK 文档「设计/数据」节三表：`pw_voice_theme_cards` / `pw_voice_theme_card_items` / `pw_voice_card_runs`）。

**b) 聚合** `aggregatePwVoiceThemeCards(db, bvid, options?: { dataDir?, llm?, now?, modelLabel? })`：

- 台账：先插 `pw_voice_card_runs`（trigger_kind='manual'、provider='deepseek'、status='running'），结束回写（done/failed 照 pw-miner 模式）。
- 输入：`readPwCorpusComments(db, bvid)`（`src/pw-corpus.ts`，只读）全量 → 按 `like` 降序截断 ≤300 条（`like` 为 null 当 0，并列按 ctime 新优先）→ 排除 rpid 已属 collected/rejected 卡的评论 → 排除 rpid 为 null 的（无法定址）。
- prompt：主题归堆，只输出 JSON 数组 `[{title,summary,rpids[]}]`；候选行带 `[rpid] message(截断) | 赞 like | uname`。prompt 里写明：主题是观众在乎的事，不评价不结论；官方/广告引流评论单独成卡并在 title 标注「广告」。
- 解析：照 `parseCards` 容错模式（正则取数组、JSON.parse 失败丢弃、逐项校验、rpid 不在输入集丢弃）；未认领评论落兜底卡（title=「未归堆」）。
- 重聚语义（照 PW-63）：事务内 `DELETE FROM pw_voice_theme_cards WHERE bvid=? AND status='suggested'`（卡项级联删——用外键 ON DELETE CASCADE 或显式删），再插新卡新项；collected/rejected 卡与其 rpid 不进输入不动表。
- 成本：`PW_VOICE_CARD_BUDGET_CNY = 0.15`（注释写明单视频单次聚合预算）；`calculateMinerCostCny` 可直接 import 复用；超支抛错走 failed 路径；raw_response 截断 4000 落台账。
- llm 缺省 = `createDeepSeekProvider(dataDir)` 的 completeSimple 封装（照 pw-miner `defaultMinerLlm`，systemPrompt 换评论聚合文案）。

**c) 卡查询** `listPwVoiceThemeCards(db, bvid, status='suggested')`：卡数组 + 每卡 items（rpid/message/uname/like/ctime + `collected` 标记——按 PW-46 逐字防重规则现算：`pw_voice_items` 存在 `platform='bilibili:{bvid}' AND content=message AND dropped_reason IS NULL`）。status 校验 400。bvid 必填 400。

**d) 整卡收录** `collectPwVoiceThemeCard(db, cardId, audit?)`：

- 校验：卡存在 404、status 非 suggested 409。
- 事务：卡置 collected（decided_at）；卡项逐条——先查逐字防重（同上规则），已存在 → 只回写卡项 `voice_id`；不存在 → `addPwVoiceItem(db, { platform: 'bilibili:{bvid}', content: message, author: uname ?? '匿名', capturedAt: ctime 转 ISO（空则当前刻） }, audit)`（PW-26 自动分拣挂钩自然触发），回写 voice_id。
- 返回卡 + 收录/跳过计数。

**e) 弃卡** `rejectPwVoiceThemeCard(db, cardId)`：卡 404/409 同收录；置 rejected + decided_at（卡项快照保留备查）。

### 2. `src/main.ts`（既有 voice 路由区，照既有写法挂 4 条）

| 路由 | 方法 | 函数 |
|---|---|---|
| `/api/pw/voice/corpus-cards` | GET | `listPwVoiceThemeCards`（query: bvid 必填、status 缺省 suggested） |
| `/api/pw/voice/corpus-cards/aggregate` | POST | `aggregatePwVoiceThemeCards`（body.bvid；LLM 错误照 miner/run 包 503） |
| `/api/pw/voice/corpus-cards/collect` | POST | `collectPwVoiceThemeCard`（body.cardId，asBadRequest） |
| `/api/pw/voice/corpus-cards/reject` | POST | `rejectPwVoiceThemeCard`（body.cardId，asBadRequest） |

启动建表：main.ts 启动序列加 `ensurePwVoiceCardTables`（照既有 ensure 挂载模式）。
既有 `/api/pw/voice/corpus-comments`、`/api/pw/voice/collect` 等全部保留不动。

### 3. 测试（`src/pw-voice-cards.test.ts`，内存库 + mock llm 注入照 pw-miner.test.ts 模式；语料评论用临时目录落 comments.jsonl 或 mock——看 `readPwCorpusComments` 依赖啥就照 pw-corpus.test.ts 既有夹具）

1. 聚合解析：合法 JSON 归卡正确（like 降序截断生效）；坏 JSON/坏项/外 rpid 丢弃；未认领落「未归堆」。
2. 重聚：suggested 卡重建不翻倍（同视频连聚两次卡数相同）；collected/rejected 卡与其 rpid 不进输入、行不动。
3. 整卡收录：卡项逐条进 `pw_voice_items`（platform/content/author/capturedAt 正确）、自动分拣挂钩被触发（照 PW-26 测试注入替身断言）、已存在逐字跳过不报错、voice_id 回写、重复收录 409。
4. 弃卡：状态翻转；重聚后该主题 rpid 不再出现。
5. 成本护栏：mock 高 token 使成本超 ¥0.15 走 failed，台账状态可查。
6. like 截断：构造 >300 条评论，入 prompt 的恰 300 条且按赞降序。

## 明确不做

- 不动前端任何文件（前端 Kimi 另改）。
- 不动 `pw_voice_items`/`pw_corpus*` 既有表结构与读函数；不动分拣与提请链。
- 不做自动触发（无定时器）、不做主题卡提请候选、不立特殊卡型。
- 不删语料文件、不手工改库。

## 交付口径

简报回复里写清：改动文件与行数、测试数（X/X 绿）、verify 输出结论、聚合在 mock 库的演练结果（含重聚两次不翻倍证据）。主代理验收后联调前端。
