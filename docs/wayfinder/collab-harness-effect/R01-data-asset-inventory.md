# R01 数据资产清单：已获取数据的结构与 AI 可及性

- Labels: wayfinder:research
- Status: closed（2026-08-04 research 子代理交付，主会话验收关闭）
- Assignee: research 子代理（agent-0）
- Blocked-by: 无

## Question

盘点「数据源已获取」的全部数据资产：pw_data_docs（metrics_json 结构与版本链）、pw_corpus_docs + 落盘评论文件（`~/Library/Application Support/Papertable/corpus/`）、pw_corpus_fts、pw_voice_items、PW-13 B站同步产物、pw_verdicts（金子墓碑）。每项给出：数据结构（字段级）、典型体量、现有读取入口（API/SQL/文件）、AI 工具表现状能不能读到（对照 `src/pw-collab-tools.ts` 8 工具）、读不到的部分具体缺什么。产出一张字段级清单，作为场景走查（T01–T04）的事实底座。

## Resolution

调研日期 2026-08-04。实测库 `~/Library/Application Support/Papertable/papertable.sqlite3`（只读）：bets 2 / data_docs 2 / corpus_docs 1 / corpus_fts 100 / voice 0 / verdicts 2 / connections 1。「注入上下文」指 `buildCollabContext`（src/pw-context.ts:161）拼进 system prompt 的只读 Markdown，与 8 工具并列为 AI 读取通路。

### 总览：AI 可及性一行表

| 资产 | AI 可读？ | 缺什么（一句话） |
|---|---|---|
| pw_data_docs | ✅ 最新版可读（read_data_docs + 注入） | 版本链历史、method/frozen/raw_ref、跨押注视图 |
| pw_corpus_fts（评论） | ⚠️ 只有 40 字命中片段 | 评论全文、已抓 BV 清单、视频 stat、rpid/ctime/replies |
| corpus 落盘文件 | ❌ | meta.json / comments.jsonl 无任何工具或 API |
| pw_voice_items | ⚠️ 限本押注挂接 artifact（当前 0 行） | cluster/dropped 字段不回显且 dropped 不过滤；无全局检索 |
| PW-13 同步产物 | ❌ 状态层不可读（sync 出的 data_docs 本身可读） | pw_connections 状态/last_sync_at/risk_events、pw_runs 事件流无工具 |
| pw_verdicts | ⚠️ 文本可检索 | 证据链 evidence_doc_ids、bet 关联、时间、置信快照不返回；镜像金子搜不到 |

### 1. pw_data_docs（回流数据文档）

- 结构（src/pw-data-docs.ts:33）：`id, bet_id, artifact_id(可空=押注级), platform, collected_at, method(manual/export/sync), metrics_json, raw_ref, source_hash, version, frozen, created_at`。`metrics_json` 强制为 JSON object（不能是数组/标量）；实测键为中文指标名，如 `{"播放":2430,"点赞":96,"评论":23}`；PW-13 sync 通路七键：播放/点赞/评论/弹幕/收藏/投币/分享（scripts/pw-sync-bilibili.js extractMetrics）。
- 版本链：`createPwDataDoc` 只收 method=manual；`appendPwDataDocVersion`（pw-data-docs.ts:82）不更新原行，同事务插入 version+1 新行，复制 bet/artifact/platform/raw_ref/source_hash；`freezePwDataDoc` 按 (bet,platform,artifact) 组置 frozen=1，冻结后禁止再续版本。`listPwDataDocs` 用 NOT EXISTS newer 过滤，**只回每组最新版**。sync 通路（pw-connections.ts:155）version=该 artifact 已有文档数+1，只增不改。
- 典型体量：实测 2 行（均 manual）；设计上每产出物每天 ≤1 次 sync，量级几十~几百行。
- 读取入口：`GET /api/pw/data-docs`（全量，join artifact/bet 标题，滤 void 押注，供数据源屏）；SQL `listPwDataDocs(betId)` / `listAllPwDataDocs`。
- AI 现状：✅ `read_data_docs` + 注入上下文「## 数据文档（本押注）」均输出最新版 metrics 全文（compact JSON 单行）。
- 缺口：①旧版本行不可读，趋势只能靠多 artifact 最新版肉眼比；②输出不带 method（AI 分不清手动抄录还是同步）、frozen、raw_ref、artifact 标题；③工具锁 context.betId，无跨押注数据视图；④无聚合/排序，指标对比全交给 LLM 心算 JSON。

### 2. pw_corpus_docs + pw_corpus_fts + 落盘评论文件

- pw_corpus_docs（src/pw-corpus.ts:62）：`id, bvid UNIQUE, title, up_name, kinds(默认 video,comments), status(proposed/pending/fetching/done/needs_human/failed), path, sha256, video_stat_json, comment_count, authorized_by(human/ai), error, fetched_at, created_at`。`video_stat_json` 存 B站 view 接口 stat（实测 meta.json 同构：播放158550/弹幕126/评论417/收藏12910/投币4724/分享866/点赞8124）。
- pw_corpus_fts：fts5 trigram，列 `bvid(UNINDEXED), uname, message, likes(UNINDEXED 只存不索引)`；done 时按 bvid 删旧插新重建。检索上限 20 条，<3 字退化为 LIKE，多词查询 LIKE OR。
- 落盘文件（`~/Library/Application Support/Papertable/corpus/{bvid}/`）：`meta.json`（bvid/aid/title/up_name/pubdate/stat 七项/fetched_at/source）；`comments.jsonl` 每行 `{rpid, uname, message, like, ctime, replies}`。**rpid/ctime/replies 只存在于磁盘——donePwCorpus 入库时丢弃**（pw-corpus.ts:427 normalizeComments 只留 uname/message/like）。
- 典型体量：抓取纪律 ≤3 视频/次、≤100 评论/视频（scripts/pw-fetch-bili-corpus.js 头注释）；实测 1 个 done 条目（BV1NprhBPEtR）、100 条评论、FTS 100 行、磁盘 24K。
- 读取入口：`GET /api/pw/corpus`（全量授权条目）/ `/pending` / `/search?q=`；磁盘文件只能 fs 直接读。
- AI 现状：⚠️ `search_corpus` 返回 top20 的 **40 字 snippet**（带 `<b></b>` 高亮）；注入上下文另有「语料预检 top5」。`fetch_corpus` 是写工具（只产 proposed 提议）。
- 缺口：①**无工具列举语料库**——AI 不知道已抓哪些 BV、各自 status/comment_count；②`video_stat_json` 视频七项数据无任何 AI 通路（不进 FTS、不在 snippet）；③评论全文不可读，只有 40 字窗口；④rpid/ctime/replies 在 DB 层已丢失，按时间/楼中楼热度分析只能读磁盘 jsonl，而 AI 无文件工具；⑤snippet 里的 `<b>` 标签是给 UI 高亮的，对 LLM 是噪音格式。

### 3. pw_voice_items（观众声音）

- 结构（src/pw-voice.ts:50）：`id, artifact_id(可空), platform, author_hash(sha256，纪律：昵称本体不落库), content, captured_at, signal_type(topic_lead/content_critique/form_suggestion/noise, NULL=未分拣), cluster_id, promoted_to_draft_id, dropped_reason, created_at`。
- 典型体量：实测 **0 行**；录入仅靠 `POST /api/pw/voice` 手动单条提交。
- 读取入口：`GET /api/pw/voice?signalType=&unprocessed=1`；`POST /api/pw/voice/classify`（LLM 批量分拣回写 signal_type/cluster_id）；`POST /api/pw/voice/:id/drop`。
- AI 现状：⚠️ `read_voice` 可读，但 SQL 限定「本押注 → 未摘除 artifact」挂接的声音（pw-collab-tools.ts:182）；artifact_id 为 NULL 或未挂到当前 bet 的声音不可见。
- 缺口：①输出只有 signal_type + content，**cluster_id / promoted_to_draft_id / dropped_reason 不回显**；②**dropped 条目不过滤**——被人丢弃的声音照样列出且无任何标记；③无跨押注/全局声音检索；④与 corpus 评论是两套互不相通的通路：语料 100 条真实评论不会自动变成 voice。

### 4. PW-13 B站同步产物

- pw_connections（src/pw-connections.ts:66）：`id, platform UNIQUE, account_label, auth_ref(恒 NULL 军规), status(active/needs_human/paused), last_sync_at, risk_events_json([{at,reason}] 只增不清), created_at`。实测 1 行（B站，active）。
- 产物三类：① pw_connections 连接状态行；② `pw_data_docs method='sync'` 行（七键 metrics，结构同 §1）；③ `pw_runs kind='sync'` 事件（event_type='data_doc', actor='system'，每条落库留痕）。执行器 scripts/pw-sync-bilibili.js（ego-browser，每天 ≤1 次，会话 cron c84b0129；撞风控置 needs_human 交人）。
- 典型体量：当前 **0 个真实 sync 文档**（账号 0 稿件，2026-08-04 空跑跑通、事件留痕、last_sync_at 已刷新）；设计量级每 artifact 每天 1 行。
- 读取入口：`GET /api/pw/connections`（连接列表 + 每平台 sync 文档数）；`POST /api/pw/sync/bilibili`（写）。
- AI 现状：❌ 状态层无任何工具——连接状态、last_sync_at、risk_events（风控史）、pw_runs 同步事件流 AI 全读不到；sync 落库的 data_docs 本身可经 `read_data_docs` 读（但不标注 method=sync）。
- 缺口：缺「数据源状态」类工具；pw_runs 事件流整体无 AI 入口（含 ai_draft 事件也只落库不回显）。

### 5. pw_verdicts（金子墓碑）+ pw_gold_mirror

- pw_verdicts（src/pw-verdicts.ts:35）：`id, bet_id, outcome(gold/tomb/void), lesson(gold 必填), cause_of_death(tomb 必填), evidence_doc_ids_json(指向 pw_data_docs.id，结账时强校验存在且非 void 必填), confidence_snapshot, decided_by(恒 human), decided_at, created_at`；部分唯一索引：每 bet 至多一条非 void。
- pw_gold_mirror（src/pw-gold-sync.ts）：Papertable 侧金子镜像 `id, source_verdict_id UNIQUE, kind('gold'), text, handle, project_id, card_id, confirmed_at, mirrored_at`。
- 典型体量：实测 2 行；个人量级几十~几百条（pw-context.ts 注释明示不做向量检索）。
- 读取入口：`GET /api/pw/verdicts?outcome=` / `/api/pw/verdicts/search?q=` / `/api/pw/verdicts/tombstone-stats` / `/api/pw/golds`（镜像）；`POST /api/pw/gold-sync/mirror`（写）。
- AI 现状：⚠️ `search_verdicts` 对 lesson/cause_of_death 做 LIKE，滤 void，结果带 §N 编号；注入上下文含金子和全部墓碑（§N 与工具同一编号表，同对话内稳定）。
- 缺口：①搜索结果只有 lesson/cause_of_death 文本——**evidence_doc_ids 证据链、bet_id/押注标题、decided_at、confidence_snapshot 均不返回**，AI 答不了「这条金子来自哪次押注、依据哪些数据文档」；②`pw_gold_mirror` 镜像金子只在注入上下文（按相关度截断）出现，`search_verdicts` 搜不到；③tombstone-stats（死因分布）无 AI 通路。

### 6. 八工具逐一核对

| 工具 | 触及资产 | 判定 |
|---|---|---|
| read_bet | pw_bets 全文 + pw_artifacts 列表 | ✅ 完整 |
| read_data_docs | pw_data_docs 每组最新版 | ⚠️ 版本链历史/method/frozen/raw_ref/artifact 名不可见 |
| search_verdicts | pw_verdicts（不含 mirror） | ⚠️ 只回文本，证据链/时间/来源押注不可见 |
| search_corpus | pw_corpus_fts | ⚠️ 只有 40 字片段；docs 元数据/stat/全文/磁盘文件不可见 |
| read_voice | pw_voice_items（限本押注挂接） | ⚠️ cluster 等字段不回显，dropped 不过滤 |
| fetch_corpus | pw_corpus_docs（只写 proposed） | — 写工具，不产生任何读取 |
| draft_bet | pw_bets 草稿 | — 写工具 |
| draft_settle | pw_settle_drafts 草稿 | — 写工具 |

结论：8 工具中真正的「读」只有 5 个，且全部存在字段级裁剪；**完全无通路**的资产是：corpus 落盘文件、video_stat_json、pw_connections、pw_runs 事件流、data_docs 版本链历史、verdict 证据链。

### 附带发现（最意外）

1. **评论数据双通路互不相通**：corpus 里已躺着 100 条真实评论（可全文检索），而 pw_voice_items 为 0——「观众声音」要靠人手抄录进另一张表，AI 调 read_voice 永远看到空。
2. **入库即裁剪**：评论的 rpid/ctime/replies 在 donePwCorpus 时被丢弃，DB 层已不可能做时间序列/楼中楼分析；全量只在磁盘 jsonl，而 AI 没有文件读取工具。
3. **read_voice 不过滤 dropped_reason**：已丢弃的声音照常出现在结果里且无任何标记，AI 会把人否掉的信号当有效信号引用。
