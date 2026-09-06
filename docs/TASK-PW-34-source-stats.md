# TASK-PW-34 多源可视化数据

- 日期：2026-08-08
- 批次：TASK-PW-30-batch（决策层 MVP 落地批）第五刀
- 依赖：PW-30（引用落库，已验收）

## 这刀是干什么的（白话）

协作台大屏底部有一条「多源可视化块」，回答两个问题：**我从各个来源抓的东西，哪个真出活？**（来源对比：这个视频抓了多少评论、筛出几张候选、几张少数派、长出几条金子、有多少真的进了你的决策）和**哪个来源该加码、哪个该清**（产出榜：产了多少候选、被挑中几次、被 AI 引用了几回）。

这刀只做**数据口径和统计函数**，不上屏（屏是 PW-36 的事）。书/文章/笔记这三类来源现在还没有抓取通路——不藏，照样返回占位行，屏上灰显"待来源通路"。

## 怎么算好（白话）

随便造几条数据，每个数字都能一笔一笔对回库里的原始记录；空库、零除、时间窗口边界都不崩；默认看近 7 天，可以切 30 天。

---

以下给干活的看，可以跳过。

## 四字段

- 主需求域：内容生产
- 业务接口：提供语料与回流数据（读）、提供选题候选（读）、提供引用记录（读，PW-30）
- 数据真值源：**无新表**；只读统计 `pw_corpus_docs` / `pw_sieve_cards` / `pw_bets` / `pw_verdicts` / `pw_verdict_refs` / `pw_content_drafts` / `pw_collab_messages` / `pw_runs`
- 质量约束与验收终态：口径逐项测试断言（含空来源、零除、窗口边界）；书/文章/笔记占位行不藏；verify 全绿

## 1. 背景与既有事实（已核验，勿重复调查）

- `pw_corpus_docs`：bvid UNIQUE、title、up_name、status（done 等）、comment_count INTEGER、fetched_at、created_at。
- `pw_sieve_cards`：kind（normal/wildcard）、quote_source_json（含 `.bvid`）、status（pending/picked/edited/rejected）、created_at。取 bvid 用 `json_extract(quote_source_json, '$.bvid')`。
- `pw_bets`：content 押注有 `source_card_id`（PW-19 加的列）回指 pw_sieve_cards.id。
- `pw_verdicts`：bet_id、outcome（gold/tomb/void）、decided_at、created_at。
- `pw_verdict_refs`（PW-30）：verdict_id、source_kind（collab_message/content_draft）、source_id、created_at。
- `pw_content_drafts`（PW-31）：bet_id、status（draft/finalized/rejected）、created_at、updated_at（finalize 时翻动）。
- `pw_collab_messages`：bet_id（普通押注 id 或哨兵 `'global'`）。
- 挑卡留痕（PW-19）：`pw_runs` event_type='confirm'，payload_json 含 `{cardId, betId, ...}`，kind='manual_event'（人工）或 ai_exec（对话代办，PW-24）。两种都算"被挑"。
- 全表时间为 TEXT ISO（UTC），窗口比较用 ISO 串字典序即可。
- node24 TS 剥离器不认跨行 `as` 断言——一律写同行。

## 2. 口径定义（规格核心，逐项可测）

**来源行集合** = `pw_corpus_docs` 全部行（不因时间窗隐藏行；窗口只过滤计数）。另返回固定占位 `pendingLanes: ["书/文章", "笔记"]`（对应线框稿两条灰行「待来源通路」）。

**时间窗**：`rangeDays` 仅允许 7 或 30，默认 7；非法值回退 7。`now` 可注入（测试用），缺省当前时刻；窗口下界 `cutoff = now - rangeDays` 天（ISO 串）。**评论数是存量口径不随窗口**（见下），其余计数均为窗口内发生。

`getPwSourceComparison(db, options?)` 每来源一行：

| 字段 | 口径 |
|---|---|
| `comments` | `pw_corpus_docs.comment_count ?? 0`——**存量，不随时间窗过滤**（抓来的评论就是库存，窗口只问"这期间发生了什么"，不问库存） |
| `candidates` | 窗口内创建的 pw_sieve_cards（按 bvid 归属）数 |
| `wildcards` | 其中 kind='wildcard' 数 |
| `golds` | 窗口内 decided_at 的 pw_verdicts（outcome='gold'）数，归因链：verdict.bet_id → pw_bets.source_card_id → 卡片的 bvid |
| `picked` | 窗口内 pw_runs 挑卡事件数：event_type='confirm' 且 payload 能 json_extract 出 cardId 且该卡归属本 bvid（跨 kind：manual_event 与 ai_exec 都算；join 卡片表取 bvid） |
| `refs` | 窗口内 pw_verdict_refs 笔数，归因规则：source_kind='content_draft' → draft.bet_id → bet.source_card_id → bvid；source_kind='collab_message' → message.bet_id（='global' 时**不归因任何来源**）→ bet.source_card_id → bvid |
| `finalized` | 窗口内定稿数：pw_content_drafts.status='finalized' 且 updated_at 在窗口内，归因同上经 bet 链 |
| `intoChain` | `picked + refs + finalized`（入决策链数 = 三类合计） |

`getPwOutputRanking(db, options?)` 产出榜每来源一行：`produced`（=candidates 同口径）、`picked`（同口径）、`refCount`（=refs 同口径）；排序 produced desc → picked desc → bvid asc；**零产出来源保留在榜**（垫底又不出活=该清，藏了就看不见）。

两函数返回均带 `{ rangeDays, generatedAt, ... }`。来源行字段命名以上表为准；附 title/upName 便屏显。

## 3. 交付物

| 文件 | 改动 |
|---|---|
| `src/pw-source-stats.ts` | 新建：上述两函数 + 类型导出 |
| `src/pw-source-stats.test.ts` | 新建：8 组测试 |

**禁碰**：`src/main.ts`（路由留 PW-36）、`package.json`（登记主代理做）、`frontend/`、其余一切既有文件。不 commit。

## 4. 测试清单（内存库自包含，种子数据手写 SQL 或复用既有 ensure/insert 函数）

1. 空库：sources 空数组；pendingLanes 恰为 `["书/文章", "笔记"]`；产出榜空。
2. 单来源全口径：corpus doc（comment_count=100）+ 窗口内 4 卡（1 wildcard）+ 1 挑卡 confirm 事件 + 该链上 bet 的 gold verdict + refs 3 笔（content_draft 1 + bet 域 collab_message 1 + global 1）+ 1 定稿 → 逐项断言 comments=100 / candidates=4 / wildcards=1 / golds=1 / picked=1 / refs=2（global 那笔**不归因**）/ finalized=1 / intoChain=4。
3. 窗口过滤：8 天前创建的卡 → 近 7 天 candidates=0、30 天 candidates=1。
4. 评论数存量口径：doc fetched 8 天前，近 7 天行 comments 仍 =100。
5. 零来源计数：doc 无任何卡 → 各计数 0，行仍在（不藏）。
6. 产出榜排序：两来源 produced 3 vs 5 → 5 在前；并列按 picked desc；再并列 bvid asc。
7. rangeDays 非法（如 13）→ 按 7 算且返回 rangeDays=7。
8. 坏数据韧性：pw_runs 里 payload_json 非法 JSON 的 confirm 行不炸、不计数；quote_source_json 缺 bvid 的卡不炸、归入无（不计任何来源）。

## 5. 验收终态（主代理执行）

- `PATH="$HOME/.local/node/bin:$PATH" npm run verify` 全绿（新测试登记后）。
- 对真实库跑一次两函数，输出与 sqlite 手工抽 count 对账一致（主代理亲做）。

## 6. 明确不做

- 不出 REST 路由、不碰前端（PW-36 集成）。
- 不做主题矩阵/标签统计（线框稿明确留雾）。
- 不统计 sieve_run 维度的出卡率分母（评论→候选转化在屏层由 comments/candidates 自算即可）。

---

## 验收记录（2026-08-08，主代理亲验，通过）

**人话三句**：来源对比和产出榜两本账算好了——每个来源抓了多少评论、筛出几张候选、几张少数派、被挑几次、被引用几回、定稿几份，每个数字都能一笔一笔对回原始记录；书/文章/笔记没通路不藏，固定返回占位行。屏还没有，屏是 PW-36 的事。

- 实现：DeepSeek 子代理（仅新建 pw-source-stats.ts + 测试两文件，零触碰既有文件）；package.json 登记：主代理。
- verify（主代理亲跑）：200/200 全绿。
- 真实库对账（主代理亲做）：两函数跑真实库，与 SQL 手工抽数逐格一致——三来源 candidates/wildcards 全对（4/1、2/1、2/2）；picked 事件口径正确（settleDraftId 类 confirm 不误计、同一卡被挑两次计两笔）；4 笔草案引用与 1 笔定稿因冒烟押注无 source_card_id 正确不归因任何来源；global 会话引用不归因 ✓；pendingLanes=["书/文章","笔记"] ✓。
- 子代理判断点（复核认可）：picked 不限 kind（manual_event/ai_exec 同计，规格本意）；pendingLanes 只挂来源对比返回；now 注入 ISO 串原样透出。
