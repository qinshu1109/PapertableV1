# TASK-PW-15 协作台 Harness（codex 执行规格）

- 状态：已完成（2026-08-04 codex 交付，验收通过）
- 主需求域：判断沉淀与复用
- 业务接口：提供有效判断（装配 v2 注入语料检索）；登记实践执行（起草押注走 PW-09 drafts 管线）；回流数据文档（装配只读消费）
- 数据真值源：pw_collab_messages（新表，会话状态）；pw_settle_drafts（新表，结账建议草稿）；pw_runs（actor=ai 审计）；工具只读消费 pw_bets/pw_data_docs/pw_verdicts/pw_voice_items/pw_corpus_docs/pw_corpus_fts
- 质量约束与验收终态：权限表静态化——只读工具 allow 自动执行；fetch_corpus 为 ask（AI 只能产 proposed，人批准才进 pending 被抓取）；draft_bet/draft_settle 只产草稿（draft_hash 固化，人确认转正）；结账/转 pending/金子同步**不出现在工具 schema**（deny 即不存在，测试断言）；`PATH="$HOME/.local/node/bin:$PATH" npm run verify` 全绿；mock 模型端到端 SSE 验收（scripts/mock-model.mjs 可辅助）

## 执行环境约定（先读再写）

- 本仓库根 `/Users/qinshu/Documents/papertableV1`。只改 `src/`（后端）与 `package.json`（登记新测试）；**不改前端 `frontend/`、不改 PW-13/14 既有行为、不 commit**。
- 关键参照文件（动手前通读）：
  - `src/engine.ts` ~L855-885 与 ~L1020-1080：`AgentHarness`（来自 `@earendil-works/pi-agent-core`）的构造与事件（`AgentHarnessEvent`）处理范式；`openSessionById`、`withSanitizedStorage`（src/sessions.ts）造 session 的方式。
  - `src/notes.ts` ~L432-470：工具定义范式 `AgentHarnessTool<Ctx, Schema, Details>`（name/description/parameters 用 TypeBox `Type.*`/execute(toolCallId, args, signal, onUpdate, context)）。
  - `src/provider-settings.ts` `createPapertableProvider()`：拿 `{ models, model, thinkingLevel }`（环境变量 PAPERTABLE_BASE_URL/MODEL/API_KEY；测试里可用 scripts/mock-model.mjs 的中转地址）。
  - `src/pw-context.ts`：现有装配（§N 编号已在 renderLine 里），本任务升级为 v2。
  - `src/pw-drafts.ts`：`createPwBetDraft(db, input, source)`（status='draft' 落 pw_bets）、`hashPwBetDraft`、`listPwBetDrafts`。
  - `src/pw-runs.ts`：`emitPwEvent`（main.ts 里有调用样例）；注意 PW-13 只放宽了 kind='sync'，本任务需把 kind='ai_draft' 放行（event_type 如受 CHECK/守卫限制，同步放宽 'fetch_propose'；若 DB 有 CHECK 约束需重建表迁移，参照既有迁移写法）。
  - `src/pw-corpus.ts`：`authorizePwCorpus`（proposed 状态需新增，见下）、`searchPwCorpus`、`listPwCorpusPending`。
  - `src/main.ts`：路由注册风格（PW-13/14 新增段）与 `json()`、`asBadRequest`。

## 一、数据表（迁移进既有 ensure 函数风格）

1. `pw_collab_messages`：id TEXT PK, bet_id TEXT NOT NULL REFERENCES pw_bets(id), role TEXT NOT NULL CHECK(role IN ('user','assistant')), text TEXT NOT NULL, tool_calls_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL。会话按押注一条连续流。
2. `pw_settle_drafts`：id TEXT PK, bet_id TEXT NOT NULL REFERENCES pw_bets(id), advice_json TEXT NOT NULL（{recommendation:'settle_gold'|'settle_tomb'|'wait', lesson?, cause_of_death?, note?}）, draft_hash TEXT NOT NULL（advice_json 规范化后 sha256）, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')), reject_reason TEXT, created_by TEXT NOT NULL DEFAULT 'ai', created_at TEXT NOT NULL。
3. `pw_corpus_docs`：status CHECK 增加 `'proposed'`（重建表迁移）；`authorized_by` 允许 'ai'（AI 提议）/'human'（人登记/批准）。**fetcher 脚本只取 pending，proposed 永远不被抓**（scripts/pw-fetch-bili-corpus.js 不用改，它只读 pending）。

## 二、工具注册表（新模块 src/pw-collab-tools.ts，权限静态写死）

| 工具名 | policy | 参数（TypeBox） | 执行 |
|---|---|---|---|
| read_bet | allow | {} | 当前押注卡全文（标题/thesis/metric/metric_target/confidence/data_source_plan/checkout_date/status + 产出物列表） |
| read_data_docs | allow | {} | 本押注数据文档按 collected_at 正序（平台/指标/版本/采集时间） |
| search_verdicts | allow | {q: string} | pw_verdicts 检索（复用 PW-06 search 逻辑），返回带 §N 的金/碑条目（§N 与装配编号一致，见三） |
| search_corpus | allow | {q: string} | `searchPwCorpus(db, q)`，返回 bvid/uname/like/snippet |
| read_voice | allow | {} | 本押注关联产出物的 pw_voice_items（含 signal_type） |
| fetch_corpus | **ask** | {bvid: string} | 只创建 pw_corpus_docs proposed 行（authorized_by='ai'），返回「已提交人工授权，批准后下次同步抓取」；BV 格式校验复用 PW-14 |
| draft_bet | 起草 | PW-09 draft 字段（title/thesis/metric/metricTarget?/confidence?/dataSourcePlan/checkoutDate/goldRefs?） | `createPwBetDraft(db, input, 'collab-ai')` + emitPwEvent(kind='ai_draft', event_type='draft', actor='ai', payload 含 draft.id 与 hashPwBetDraft) |
| draft_settle | 起草 | {recommendation, lesson?, cause_of_death?, note?} | 落 pw_settle_drafts（draft_hash=sha256(规范化 advice_json)）+ emitPwEvent(kind='ai_draft', event_type='draft', actor='ai') |
| ~~settle_bet / create_pending_bet / mirror_golds~~ | **deny** | — | 不存在于 tools 数组；测试断言 schema 中无任何写正式表的工具 |

工具描述（给模型看的）用中文，写清「只读」「只产草稿，人确认后生效」「提交人工授权」语义。

## 三、装配 v2（src/pw-context.ts 扩展，新增 buildCollabContext）

在现有 assembleJudgmentContext（金子 §N）之上加：
1. **墓碑也入装配**：pw_verdicts outcome='tomb'（cause_of_death），排在金子后，编号续接（金子 §1..§n、墓碑 §n+1..）；§N 全轮稳定（同一次对话内编号不变，搜索结果引用同一编号表）。
2. **数据文档序列**：本押注 docs 正序（平台/指标 JSON/采集时间），紧凑文本块。
3. **语料预检**：用押注 title+metric 关键词跑 searchPwCorpus 取 top 5（bvid/uname/snippet）。
4. **当前押注卡**：三行赌注+结账日+置信度。
输出 `{ markdown, golds: [{ref:'§1',id,source,text}], tombs: [...], charUsed }`，markdown 拼进 system prompt（见四）。

## 四、对话 API（src/pw-collab.ts + main.ts 路由）

- `GET /api/pw/collab/:betId/messages` → {messages}（created_at 正序）。
- `POST /api/pw/collab/:betId/messages` {text} → **直接 SSE 流**（不建 run 回放；headers 照 main.ts openSse 的写法：text/event-stream、no-cache、x-accel-buffering:no、flushHeaders、15s 心跳注释行）。流程：
  1. 存 user 消息行 → 发 `user_saved` {messageId}。
  2. buildCollabContext + system prompt（全文见下）+ 历史消息（转 pi 消息格式）→ AgentHarness（session 参照 engine.ts 造法，tools=二之注册表全量）。
  3.  harness 事件 → SSE 映射：tool 调用开始 `tool_start` {tool, argsSummary}、结束 `tool_end` {tool, summary}；assistant text_delta 累积成句发 `answer_delta` {delta}；draft_* 工具成功后发 `draft_created` {kind:'bet'|'settle', draftId}；fetch_corpus 成功后发 `fetch_proposed` {corpusId, bvid}；结束发 `run_end` {reason:'done'}；异常 `run_end` {reason:'error', error}。
  4. 存 assistant 消息行（text 全文 + tool_calls_json）。
  5. 工具循环上限 4 轮；单轮流超时 120s（streamOptions 照 engine）。
- system prompt（中文，写进代码常量）：
  > 你是「镇纸 Paperweight」的创作副驾驶，只和用户讨论当前这一张押注卡。数据只信两类来源：注入的上下文（§N 编号的金子/墓碑、数据文档、语料摘要）和你可用的工具；不知道就说不知道，不编造数字。引用金子/墓碑时用 §N 标注。你可以用 draft_bet / draft_settle 起草押注或结账建议——草稿永远只是草稿，落笔（确认、结账）只能人来。你可以用 fetch_corpus 提议抓取某条视频的公开数据与评论，但只能提交人工授权，人不批准就不会发生。回答风格：直接、具体、短段落。

## 五、待确认队列与批准 API

- `GET /api/pw/collab/pending-queue` → { betDrafts（PW-09 listPwBetDrafts）、settleDrafts（pw_settle_drafts status='pending'）、corpusProposed（pw_corpus_docs status='proposed'） }。
- `POST /api/pw/collab/settle-drafts/:id/approve` → status='approved'（**不写 pw_verdicts**，PW-16 拿它预填结账弹层）；`/reject` {reason} → status='rejected' 留因。
- `POST /api/pw/collab/corpus/:id/approve` → pw_corpus_docs proposed→pending（此后抓取器可见）；`/reject` → status='failed', error='人工驳回'。
- 以上人工动作各写 pw_runs（kind='manual_event'，actor='human'，event_type='confirm'/'reject'）。

## 六、测试（src/pw-collab.test.ts，登记进 package.json test）

1. 权限表：tools 数组无 settle/create_pending/mirror 字样工具；fetch_corpus 只产 proposed（且 listPwCorpusPending 不含它）；draft_bet 落 pw_bets draft 态 + ai_draft 事件 hash 一致。
2. 装配 v2：墓碑入列且 §N 续接、数据文档序列在 markdown、语料预检命中（先 done 一条语料）。
3. 批准流：corpus proposed→approve→pending→listPwCorpusPending 可见；reject→failed；settle draft approve 不写 pw_verdicts（表计数不变）。
4. 消息存取：POST 一条（用 mock provider 或跳过模型直接测存储函数）后 GET 正序返回。
5. SSE 端到端（可用 mock-model）：POST messages 后读到 user_saved→…→run_end 事件序列，assistant 行落库。

## 验收

1. `PATH="$HOME/.local/node/bin:$PATH" npm run verify` 全绿（含新测试）。
2. 报告：文件清单、API curl 冒烟（pending-queue 三态聚合、approve/reject）、verify 结果、与规格的偏差。
3. 完成后由主代理做真实模型对话验收与协作台屏（PW-16）对接。

## 验收记录（2026-08-04，codex 执行 + 主代理验收）

1. ✅ codex 按规格交付：src/pw-collab.ts（会话/结账草稿/对话轮）、pw-collab-tools.ts（8 工具注册表）、pw-context.ts buildCollabContext、5 组路由、pw-runs 放行 ai_draft + fetch_propose、pw-corpus proposed 状态机。`npm run verify` 65 测试全绿（主代理复跑确认）。
2. ✅ 代码审查：权限表静态化落实（deny 工具仅存在测试用名单、不在 schema）；fetch_corpus 只产 proposed + ai_draft 事件；draft 两工具 draft_hash 固化；工具循环 4 轮上限 + 死循环安全阀。
3. ✅ 真实模型对话（BET-01）：问数据 → read_data_docs/search_verdicts 芯片序列正确；起草结账建议 → settle_tomb 草稿进 pending-queue（死因引用 §4）；fetch_corpus 提议幂等正确（已 done 的 BV 不重复提议）；assistant 消息与 tool_calls 落库。
4. ✅ 修复一处验收中发现的真问题：模型惯用「干货/过程/步骤」多词查询导致 FTS 短语 0 命中（AI 据此误判「评论层是空的」）——searchPwCorpus 加多词 LIKE OR 分支（trigram 同样不覆盖两字词组）+ JS 片段高亮 + 测试；修复后同问命中真实评论。
