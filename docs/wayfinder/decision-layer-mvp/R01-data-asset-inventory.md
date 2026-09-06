# R01 决策层数据资产盘点

- Labels: wayfinder:research
- Status: closed（2026-08-08 explore 子代理回报，主会话转录）
- Assignee: explore 子代理（2026-08-08 派发）
- Blocked-by: （无）

## Question

决策层屏每块需要的数据字段 vs 仓库现状，出字段级清单：每字段 → 现成（表.列）/ 可算（怎么算）/ 缺口（没有）。盘点四块：

1. **候选对比区**：`pw_sieve_cards` 现有字段并排比证据够不够（引文/来源/点赞/少数派/排序分）；
2. **弹药架**：金子/墓碑/决策链在哪（`pw_verdicts` / verdict-memos / MemOS），链尾、§N 编号、"被引用次数"（verdict_use 复用记录）现成吗；
3. **多源可视化块三视图**：①来源对比（每来源评论数/候选数/少数派数/金子数/笔记数——书与文章的"来源"概念存在吗？Obsidian 笔记计数有现成读取吗？）②主题矩阵（"主题"维度存在吗——voice 的 cluster 字段是什么、能借吗）③产出榜（被引用次数在哪张表）；
4. **范围过滤**（近 30 天）：各表时间字段齐不齐。

## Resolution

—— 2026-08-08 explore 子代理回报（只读调查，未改任何文件），主会话转录 ——

**总览**：四块屏需要的数据约 2/3 现成或可算；三个结构性缺口集中在 ①镇纸金子被引用次数无记录 ②"主题"维度不存在 ③"书/文章/笔记"来源在镇纸侧无通路。所有时间字段统一 TEXT ISO 8601 UTC（`nowIso()`，src/data.ts:322-323），近 30 天过滤基本全齐。

### 1. 候选对比区

`pw_sieve_cards` 全字段（建表 SQL，src/pw-sieve.ts:88-102）：id / run_id（批次号，→ pw_sieve_runs）/ kind（normal|wildcard 少数派）/ quote_text（逐字引文）/ quote_source_json（{bvid, uname, like, rpid}，rpid 仅命中最优评论时落）/ scale_note / scale_value（同类命中计数，**代码统计**非模型数字）/ hook_note / freshness_note / sort_score（确定性公式）/ status（pending/picked/edited/rejected）/ created_at —— **全部现成**。批次头 `pw_sieve_runs`（trigger_source/input_ids_json/cards_count/dropped_count/status/error/model/created_at/finished_at）批次维度齐全（pw-sieve.ts:74-86）。

并排比证据的补充字段：评论原文回看链接【可算】bvid+rpid 拼 `https://www.bilibili.com/video/{bvid}/#reply{rpid}`（voice 卡 bvid='voice' 伪来源除外）；评论时间 ctime【缺口】DB 不存，只在磁盘 comments.jsonl（pw-corpus.ts:384-392）；来源视频标题/UP 主【可算】bvid → pw_corpus_docs.title/up_name 联查；卡全文上下文/楼中楼【可算】按 rpid 回读磁盘 comments.jsonl（无索引需全扫）；批次说明【现成】run_id join pw_sieve_runs；跨 run 各状态卡【现成】listPwSieveCardsByStatus（pw-sieve.ts:1027-1038）。

### 2. 弹药架

实体与角色：镇纸本地判决簿 `pw_verdicts`（**真值源=本地**；传统押注结账产物：outcome/lesson/cause_of_death/evidence_doc_ids_json→pw_data_docs；decided_by 恒 human；**无 supersede 概念**，作废走 voidPwSettlement 冲正重结）；纸桌判决本地表 `pt_verdicts`（只承担草稿/队列/缓存，"MemOS 是唯一真值"）；MemOS 远端 cube `papertable-verdicts`（纸桌判决唯一真值）；镇纸侧镜像 `pw_gold_mirror`（已确认金子**单向只读镜像**，**只镜金不镜墓碑**，kind CHECK 'gold'）；判决证据链 pw_verdicts.evidence_doc_ids_json → pw_data_docs【现成】。

链尾【可算】：纸桌侧现成两条过滤（本地：status='confirmed' 且未被 supersedes_local_id 指向，verdicts.ts:616-633；远端：未被 supersedesMemoryId 指向的 advertisedTails，verdicts.ts:579-614）；镇纸侧没有链（pw_verdicts 无 supersede 字段）。

§N 编号【现成但注意】：装配层生成、同次对话内稳定（collabGolds §1..、tombs 续接，pw-context.ts:360-377）；id→§N refs Map 传工具层（pw-collab.ts:267-269）；前端悬停反查（Collab.tsx:585-589）。⚠️ 编号是每轮装配的局部序，非持久身份（设计如此）。

被引用次数：纸桌金子【可算】——`extractVerdictUse` 提取 `[[verdict:id]]`，`verdict_use` 事件持久化进 `pt_run_events`（engine.ts:999-1019；data.ts:189-196），按 payload.used[].id 计数；**镇纸金子【缺口】没有任何表记录**——collab 的 §N→id refs 快照不落库（pw-collab.ts:267-269），事后无法从 pw_collab_messages.text 可靠反推；押注引用金子【可算】pw_bets.gold_refs_json（起草期引用语义）。

### 3. 多源可视化块三视图

**①来源对比**：来源现状——视频 ✅（pw_corpus_docs：bvid/title/up_name/comment_count/video_stat_json，语料唯一来源）；观众声音 ✅（pw_voice_items.platform 自由文本）；数据文档 ✅（pw_data_docs.platform）；**书/文章【缺口】不存在**（pw_artifacts.type='article' 是押注产出物非语料来源，无抓取/录入通路）；**Obsidian 笔记【部分】** 纸桌侧有通用 Markdown 目录索引（notes.ts:78-114 索引进 pt_documents(source_kind='library')+pt_chunks_fts），**镇纸 pw_* 侧零笔记代码**。每来源统计：评论数【现成】comment_count 或 pw_corpus_fts 按 bvid COUNT；候选卡数/少数派数【可算】pw_sieve_cards 按 json_extract(quote_source_json,'$.bvid') GROUP BY（+kind='wildcard'）；金子数【可算·不完整】content 押注可经 source_card_id 回源视频，传统 verdict 押注无来源链；笔记数【缺口】镇纸侧无笔记实体；声音数【现成】pw_voice_items 按 platform COUNT。

**②主题矩阵**：**主题维度【缺口】**——pw_* 表无任何 theme/tag/主题列；唯一近似 `pw_voice_items.cluster_id`（LLM 分拣写的自由文本簇标签，pw-voice.ts:153-156，非受控词表、只覆盖声音来源）；可借的纸桌侧源：pt_verdicts.concepts_json、pw_gold_mirror.handle、pt_runs.concept_term。结论：需新增主题归并（LLM 分拣或人工打标）才能建轴，cluster_id 是唯一现成近似。

**③产出榜**：被引用次数（纸桌金子）【可算】pt_run_events 的 verdict_use 计数；被引用次数（镇纸金子）【缺口】；产出候选数【可算】按 bvid GROUP BY + status IN ('picked','edited') 过滤"真产出"；播放/弹幕等佐证【现成】pw_corpus_docs.video_stat_json。

### 4. 范围过滤（近 30 天）

时间列基本全齐（全部 TEXT ISO UTC）：pw_sieve_runs/cards、c pw_corpus_docs（created_at/fetched_at）、pw_voice_items（captured_at）、pw_data_docs（collected_at）、pw_bets、pw_verdicts、pw_gold_mirror、pw_artifacts、pw_runs、pw_collab_messages、pw_settle_drafts、pt_verdicts、pt_run_events、pt_runs。两个例外：①评论级 ctime 只在磁盘（近 30 天只有语料级粒度）；②pt_documents.mtime_ms 是 epoch 毫秒整数非 ISO。

### 最重要的三个缺口

1. **镇纸金子（pw_verdicts）被引用次数没有记录**——产出榜核心指标落空。要补需在 pw_collab_messages 层加引用记录（引用 token→verdict id 持久化），或扩展 verdict_use 语义到镇纸侧。
2. **"主题"维度不存在**——主题矩阵无处可建。需新增主题归并机制（LLM 分拣/人工打标）；cluster_id 是唯一现成近似维度。
3. **"书/文章 + Obsidian 笔记"作为来源在镇纸侧没有通路**——语料只有视频；笔记读取只在纸桌侧 notes.ts（通用 Markdown 目录索引），镇纸侧零代码。

**次要提醒**：评论 ctime 未入 DB；rpid 只记命中最优评论（回看链接对少数派/声音卡不可用）；pw_gold_mirror 只镜金不镜墓碑，墓碑在镇纸侧只能读 pw_verdicts 本地。
