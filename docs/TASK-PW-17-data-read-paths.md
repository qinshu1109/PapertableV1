# TASK-PW-17 数据读取通路补课（codex 执行规格）

- 状态：待执行（2026-08-04 批次计划 TASK-PW-17-batch 已拍板）
- 主需求域：实践与数据回收
- 业务接口：无（域内读通路扩展；产出供 PW-18 筛子 run 与 PW-21 对话工具扩容消费）
- 数据真值源：无写入变更。本任务只新增读取入口——pw_corpus_docs（含 video_stat_json）、corpus 落盘文件、pw_data_docs 版本链、pw_verdicts 证据链、pw_connections、pw_runs；另修复 pw-collab-tools 的 read_voice 查询行为（dropped 过滤）
- 质量约束与验收终态：全部只读，不写任何业务表；R01 缺口清单逐项有读取入口并逐项测试断言；read_voice 默认过滤 dropped（测试断言）；PW-13/14/15 既有测试全绿；`npm run verify` 全绿

## 执行环境约定（先读再写）

- 仓库根 `/Users/qinshu/Documents/papertableV1`。只改 `src/` 与 `package.json`（登记新测试）；不改 `frontend/`、`public/`；不 commit。
- 关键参照文件（动手前通读）：
  - `src/pw-corpus.ts`：`PwCorpusDocRow`（含 video_stat_json、path、comment_count）、`donePwCorpus`（入库时丢弃 rpid/ctime/replies——全量只在落盘文件）
  - `src/pw-data-docs.ts`：`appendPwDataDocVersion`（版本链插新行）、`listPwDataDocs`（NOT EXISTS 过滤只回每组最新版）
  - `src/pw-verdicts.ts`：`evidence_doc_ids_json`、`confidence_snapshot`、`decided_at`、bet 关联
  - `src/pw-connections.ts`：pw_connections 字段（status/last_sync_at/risk_events_json）
  - `src/pw-runs.ts`：kind/event_type 枚举与记录方式
  - `src/pw-collab-tools.ts` L176-208：read_voice SQL（dropped_reason 未过滤处）
  - `src/main.ts`：路由风格（本任务**不加路由**，HTTP 挂载留集成阶段）
- 事实底座：R01 工单 `docs/wayfinder/collab-harness-effect/R01-data-asset-inventory.md`（字段级清单，逐项对照）。

## 读取清单（逐项对应 R01 缺口；函数加进各自既有模块，不新建抽象层）

### 1. 语料全文与视频 stat（pw-corpus.ts 扩展）

- `getPwCorpusDoc(db, idOrBvid)`：整行返回，video_stat_json 解析为对象（播放/弹幕/评论/收藏/投币/分享/点赞七项），附 path/status/comment_count/fetched_at。
- `readPwCorpusComments(db, bvid, { offset?, limit? })`：从落盘 `comments.jsonl` 分页读全量评论，**含 rpid/ctime/replies**（DB 层已丢，全量在磁盘 `pw_corpus_docs.path` 指向的目录）；文件缺失或条目非 done 时抛明确 httpError，不吞不降级。
- `readPwCorpusMeta(db, bvid)`：读落盘 `meta.json`（bvid/aid/title/up_name/pubdate/stat/fetched_at）。

### 2. 数据文档版本链（pw-data-docs.ts 扩展）

- `listPwDataDocVersions(db, { betId, platform?, artifactId? })`：返回全版本正序（不做 NOT EXISTS 过滤），每行带 method/frozen/raw_ref/version，join 产出物标题。

### 3. 判决证据链（pw-verdicts.ts 扩展）

- `getPwVerdictDetail(db, id)`：verdict 整行 + evidence_doc_ids 解析并联查 data_docs 摘要（平台/采集时间/metrics 紧凑 JSON）+ 来源押注标题。

### 4. 连接与同步状态（pw-connections.ts 扩展）

- `getPwConnectionStatus(db, platform?)`：status/last_sync_at/risk_events_json（解析为数组）。

### 5. 事件流读取（pw-runs.ts 扩展）

- `listPwRuns(db, { kind?, eventType?, betId?, limit?, before? })`：created_at 倒序分页。

### 6. read_voice dropped 修复（pw-collab-tools.ts）

- SQL 增加 `AND v.dropped_reason IS NULL`（默认过滤已丢弃条目，不加显式参数）。

## 测试（新文件 src/pw-read-paths.test.ts，登记进 package.json test）

1. 语料：造 done 条目 + 临时落盘目录（meta.json/comments.jsonl）——getPwCorpusDoc 返回 stat 对象；readPwCorpusComments 分页正确且含 rpid/ctime/replies；文件缺失/非 done 报错明确。
2. 版本链：append 两版后 listPwDataDocVersions 回 2 行正序、带 method/frozen/artifact 标题。
3. 证据链：getPwVerdictDetail 回 evidence 摘要与押注标题。
4. connections/runs：risk_events 解析正确；listPwRuns 过滤与分页正确。
5. read_voice：dropped 条目不再出现（修复前后对照各断言一次）。
6. 回归：既有 `npm test` 全绿；`npm run verify` 全绿（不涉及前端 build 之外的新东西）。

## 验收

1. `npm run verify` 全绿（含新测试）。
2. 报告：新增函数清单、测试数、与 R01 缺口逐项对照表（哪项已可读/函数名）。
3. 完成后由主代理复核，路由挂载与 PW-18/21 的对接在各自任务或集成阶段进行。
