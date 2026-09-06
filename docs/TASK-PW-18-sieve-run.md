# TASK-PW-18 筛子 run（codex 执行规格）

- 状态：待执行（批次计划 TASK-PW-17-batch；PW-17 读通路已就位并验收）
- 主需求域：内容生产
- 业务接口：提供语料与回流数据（消费，PW-17 读通路）；提供选题候选（产出，供 PW-20 协作台屏展示与 PW-21 对话深挖引用；卡片状态流转「挑/改/否」归 PW-19，不在本任务）
- 数据真值源：新表 `pw_sieve_runs`、`pw_sieve_cards`、`pw_sieve_state`（本任务拥有）；pw_runs CHECK 迁移加 sieve 事件类；只读消费 pw_corpus_docs / corpus 落盘文件 / pw_data_docs / pw_verdicts / pw_connections / pw_voice_items
- 质量约束与验收终态：**只产草稿不写正式表**（运行后断言 pw_bets/pw_verdicts/pw_data_docs/pw_corpus_docs 行数不变）；扳机四线收口 + 去抖合并 + watermark 崩溃兜底；到达按行 UUID 去重；原文原则确定性断言（引文=输入评论逐字子串）；异类区必出（wildcard ≥1）；排序√推荐×（排序分确定性公式算出 + 推荐措辞扫描丢弃）；mock 模型单测 + 真实模型冒烟；`PATH="$HOME/.local/node/bin:$PATH" npm run verify` 全绿

## 执行环境约定（先读再写）

- 仓库根 `/Users/qinshu/Documents/papertableV1`。可改 `src/`、`src/main.ts`（**仅**四处收口点 + sieve 新路由，最小 diff）、`package.json`（登记测试）；不改 `frontend/`、`public/`；不 commit。
- 关键参照（动手前通读）：
  - PW-17 新函数：`getPwCorpusDoc`（pw-corpus.ts:240）、`readPwCorpusComments`（:347，全量评论含 rpid/ctime/replies）、`readPwCorpusMeta`（:404）、`listPwDataDocVersions`、`getPwVerdictDetail`、`getPwConnectionStatus`、`listPwRuns`
  - R02 工单 `docs/wayfinder/collab-harness-effect/R02-arrival-trigger-hooks.md`：扳机收口设计与按行去重硬要求
  - `src/pw-collab.ts` runCollabTurn：AgentHarness/session/provider 造法；`src/provider-settings.ts` createPapertableProvider
  - `src/pw-runs.ts` `migratePwRunsCheck`：CHECK 重建迁移先例
  - `src/main.ts:161` 60s idleTimer：服务端周期任务先例
  - `scripts/mock-model.mjs`：mock provider

## 一、数据表（迁移进既有 ensure 风格）

1. `pw_sieve_runs`：id TEXT PK, trigger_source TEXT NOT NULL（'sync'|'corpus_done'|'manual_entry'|'voice'|'open_fallback'|'watermark'|'manual'）, input_ids_json TEXT NOT NULL（到达行 UUID 列表）, cards_count INTEGER NOT NULL DEFAULT 0, dropped_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL CHECK(status IN ('running','done','failed')), error TEXT, model TEXT, created_at TEXT NOT NULL, finished_at TEXT。
2. `pw_sieve_cards`：id TEXT PK, run_id TEXT NOT NULL REFERENCES pw_sieve_runs(id), kind TEXT NOT NULL CHECK(kind IN ('normal','wildcard')), quote_text TEXT NOT NULL（原文逐字）, quote_source_json TEXT NOT NULL（{bvid, uname, like?, rpid?}）, scale_note TEXT, scale_value INTEGER NOT NULL DEFAULT 0（代码统计，不取模型数）, hook_note TEXT（草稿字段，工具挂钩点）, freshness_note TEXT, sort_score REAL NOT NULL DEFAULT 0（确定性公式）, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','picked','edited','rejected')), created_at TEXT NOT NULL。
3. `pw_sieve_state`：key TEXT PK, value TEXT NOT NULL——存 `last_watermark_json`（各到达线的已筛水位：pw_data_docs.id/created_at、pw_corpus_docs.fetched_at、pw_voice_items.created_at）。
4. pw_runs CHECK 迁移：event_type 放行 `'sieve_run'`（照 migratePwRunsCheck 重建表先例）。

## 二、扳机（R02 收口 + 去抖 + watermark）

- `notifySieveArrival(source, ids)`：内存去抖队列。四处路由成功返回后调用（main.ts 最小 diff）：①`POST /api/pw/sync/bilibili` 返回且 created>0（ids=新 data_doc ids；=0 不调）②`POST /api/pw/corpus/:id/done` 返回（id；一次 ≤3 个 done 会连发，靠去抖合并）③`POST /api/pw/bets/:betId/data-docs` 201（id）④`POST /api/pw/voice` 201（id）。
- 去抖：10 分钟安静窗合并（一批 sync N 条/语料连发 done 合并为一筛）；窗口到→`runPwSieve(db, source, ids)`。**单飞**：同时至多一个 running，在途时新到达只入队。
- watermark 兜底：60s 周期（idleTimer 先例）比对四线新行水位 vs `pw_sieve_state.last_watermark_json`；有差且无在途 run→补筛（崩溃恢复，内存队列会丢）。
- 打开兜底/手动：新路由 `GET /api/pw/sieve/status` → { last_run_at, pending_arrivals, cards_pending }；`POST /api/pw/sieve/run` → 立即触发一筛（绕过安静窗；在途则 409）。
- needs_human/failed 不产生到达（R02 结论）；到达判定与去重一律按行 UUID（sync 无幂等键、批次无整体事务）。

## 三、筛选管线 `runPwSieve`

1. **装配** `buildSieveInput(db, ids)`：新到达语料的评论全文（readPwCorpusComments 分页拉全）+ meta/stat + 新 data_docs 版本（listPwDataDocVersions）+ 相关金子墓碑（getPwVerdictDetail 摘要）。字符预算（建议 60k）截断，超出按评论点赞/时间优先。
2. **单次 LLM 结构化产出**（createPapertableProvider，模型可换；**非工具循环**）：要求输出 JSON `{cards:[{quote_text, quote_source:{bvid,uname,like?,rpid?}, scale_note, hook_note, freshness_note, wildcard:boolean}]}`。system prompt（中文，写进代码常量）写死：
   - 你只搬运和摆盘，不掌勺：**引文必须逐字复制原文，禁止改写、概括、翻译**；
   - **必须输出 1~3 条 wildcard**：归不进堆的、反常识的、少数人说但说得狠的；
   - **禁止出现推荐性措辞**（「推荐」「建议你做」「应该」等）；只摆证据；
   - 规模感只描述现象不编数字（数字由代码统计）；不知道就输出空 cards。
3. **确定性后处理**（不信模型自报）：
   - 原文断言：`quote_text` 必须是输入评论集合中某条的逐字子串（规范化空白后比对）；不过→丢弃并计 `dropped_count`；
   - 规模值：`scale_value` 由代码按输入数据统计（同类命中计数），不取模型数；
   - 排序分：`sort_score = scale_value*2 + min(like,100)/50 + 新鲜度权重`（新鲜度权重按评论 ctime 距今天数分档，常数写进代码注释）；wildcard 不参与排序、另置一区；
   - 推荐语扫描：quote 外文本字段含「推荐/建议/应该」→整卡丢弃并计数（停线 1 的机器兜底）。
4. **落表**：pw_sieve_runs 置 done（cards_count/dropped_count/finished_at）+ cards 落 pending + pw_runs 事件（kind='sieve', event_type='sieve_run', actor='system', payload 含 run_id/input_ids/计数）。
5. **失败**：LLM 异常或 JSON 校验失败→重试 1 次→仍败置 failed（error 落表）不产卡；watermark 不前进，下轮可补筛。

## 四、测试（src/pw-sieve.test.ts，登记进 package.json）

1. 去抖：连续 3 次 notify（注入假时钟）→ 合并为 1 次 run；
2. watermark：清空内存队列后造新行水位差 → 兜底补筛触发；
3. 去重：同一 doc id 两次到达 → 不重复产卡；
4. 原文断言：mock 模型返回**篡改**引文 → 该卡丢弃+dropped_count；逐字引文 → 保留；
5. 推荐语扫描：hook_note 含「推荐」→ 整卡丢弃；
6. wildcard：mock 输出 0 条 wildcard → run 标记不合格（failed 或 dropped 计数断言，二选一写清）；≥1 → 通过；
7. 只产草稿：run 前后 pw_bets/pw_verdicts/pw_data_docs/pw_corpus_docs 行数不变；
8. mock 端到端：notify→run→cards 落表+sieve_run 事件+`GET /api/pw/sieve/status` 字段正确；
9. 回归：既有测试全绿（当前 75）+ `npm run verify`。

## 验收

1. `PATH="$HOME/.local/node/bin:$PATH" npm run verify` 全绿（含新测试）。
2. 真实模型冒烟（主代理做）：对现有语料（BV1NprhBPEtR，100 评论）`POST /api/pw/sieve/run`——产出卡含逐字引文、wildcard ≥1、无推荐字样、排序分存在。
3. 报告：文件清单、测试数、冒烟结果、与规格的偏差。
