# R01 写动作全量盘点

- Labels: wayfinder:research
- Status: closed（2026-08-06 research 子代理盘点完成，主会话复核收录）
- Assignee: kimi 主会话（2026-08-06 认领，派 research 子代理执行）
- Blocked-by: 无

## Question

把系统里全部「写动作」枚举成一张清单，作为「T01 逐案定档走查」的事实底座。每个写动作记录：动作名 / 现状通路（对话工具名 / UI 路由 method+path / 自动 run / 无通路只能手改库）/ 写哪张表 / 可逆性（能否撤销、改写、作废）/ 判断含量初判（劳动 or 判断）/ 现有审计（pw_runs 记不记、记的什么）。

覆盖范围至少包括：6 个 deny 工具对应的动作（结账/转 pending/金子同步/挑卡/否卡/建内容押注）、fetch_corpus 提议→批准链、draft_bet/draft_settle 草稿→确认链、筛子自动写卡、手动触发筛子 run、全否重筛、观众声音分拣（signal_type 谁在写）、语料授权（proposed→approved）、数据文档采集/冻结、产出物登记/摘挂、以及前端 UI 上所有人手点的写按钮。

## Resolution

—— 2026-08-06 research 子代理盘点（代码实读，行号已核对；主会话复核）——

审计底座：`pw_runs` 合法值 kind ∈ manual_event/ai_draft/sync/sieve，event_type ∈ create/attach/data_doc/draft/confirm/reject/settle/fetch_propose/sieve_run，actor ∈ human/ai/system（`src/pw-runs.ts:4-15`；`actor=ai` 强制 `kind=ai_draft`，`pw-runs.ts:152`）。路由层统一由 `emitPwEvent` 以 manual_event/human 上报（`src/main.ts:1051-1066`）。

### 全量清单（36 个写动作）

| # | 动作名 | 现状通路 | 写哪张表 | 可逆性 | 现有审计 | 判断含量初判 |
|---|--------|----------|----------|--------|----------|--------------|
| 1 | AI 提议抓语料 fetch_corpus（ask） | 对话工具 → proposePwCorpus（pw-corpus.ts:203） | pw_corpus_docs（proposed，authorized_by='ai'） | 可逆：人批准/驳回；同 bvid 幂等 | ai_draft/fetch_propose/ai | 含判断，但只产提议 |
| 2 | AI 起草押注 draft_bet（draft） | 对话工具 → createPwBetDraft（pw-drafts.ts:194） | pw_bets（draft，created_from='collab-ai'） | 可逆：人 confirm 可 edits 或 reject | ai_draft/draft/ai | 含判断，转正权在人 |
| 3 | AI 起草结账建议 draft_settle（draft） | 对话工具 → createPwSettleDraft（pw-collab.ts:143） | pw_settle_drafts（pending，created_by='ai'） | 可逆：人 approve/reject；批准≠结账 | ai_draft/draft/ai | 含判断，落笔权在人 |
| 4 | 协作台发消息 | UI 对话条 → POST /api/pw/collab/:betId/messages（main.ts:916） | pw_collab_messages | 不可逆：无删除/编辑 | 无 pw_runs 事件 | 纯记录；AI 一切草稿的扳机 |
| 5 | 结账铸金/立碑/作废（deny: settle_bet） | UI 到期结账 → POST /api/pw/bets/:id/settle（main.ts:582）→ settlePwBet（pw-verdicts.ts:53） | pw_verdicts + pw_bets（settled/void） | 基本不可逆：一注一条非 void 唯一索引；无撤销路由；void 后可重结；须到结账日 | manual_event/settle/human | 含判断（最高量级：入库即真理） |
| 6 | 直接建 pending 押注（deny: create_pending_bet 路1） | UI 新建押注落注 → POST /api/pw/bets（main.ts:486） | pw_bets | 不可逆：无 PUT/DELETE；只能到期 settle void | manual_event/create/human | 含判断（立注即承诺） |
| 7 | 草稿确认转 pending（deny: create_pending_bet 路2） | POST /api/pw/drafts/:id/confirm（main.ts:731）→ confirmPwBetDraft（pw-drafts.ts:224） | pw_bets（draft→pending）+ pw_draft_events | 不可逆：draft 只有 confirm/reject 两出口 | manual_event/confirm/human | 含判断；**UI 无按钮** |
| 8 | 金子镜像同步（deny: mirror_golds） | UI 同步金子 → POST /api/pw/gold-sync/mirror（main.ts:618） | pw_gold_mirror（INSERT OR IGNORE） | 幂等可重跑；无删除/刷新通路 | **无 pw_runs 事件** | 纯劳动（机械搬运） |
| 9 | 挑候选卡转内容押注（deny: pick_sieve_card/create_content_bet） | UI 挑/改 → POST /api/pw/sieve/cards/:id/pick（main.ts:690）→ pickPwSieveCard（pw-content-bets.ts:108） | pw_bets（kind='content'）+ pw_sieve_cards（→picked/edited，同事务） | 不可逆：单向状态机 + 竞态 409 | manual_event/confirm/human | 含判断（选题落注） |
| 10 | 否候选卡（deny: reject_sieve_card） | UI 否 → POST /api/pw/sieve/cards/:id/reject（main.ts:700） | pw_sieve_cards（→rejected） | 不可逆：单向状态机 | manual_event/reject/human | 含判断（否决即方向信号） |
| 11 | 手工建押注草稿 | POST /api/pw/drafts（main.ts:713） | pw_bets（draft） | 同 #2 | manual_event/draft/human | **路由在 UI 无入口** |
| 12 | 驳回押注草稿 | POST /api/pw/drafts/:id/reject（main.ts:746） | pw_bets（draft→void）+ pw_draft_events | 不可逆 | manual_event/reject/human | **UI 无按钮** |
| 13 | 批准结账草稿 | POST /api/pw/collab/settle-drafts/:id/approve（main.ts:855） | pw_settle_drafts（→approved） | 无回退；**批准不触发结账**，仍须走 #5 | manual_event/confirm/human | **UI 无按钮** |
| 14 | 驳回结账草稿 | POST …/settle-drafts/:id/reject（main.ts:866） | pw_settle_drafts（→rejected + reason） | 无回退 | manual_event/reject/human | **UI 无按钮** |
| 15 | 批准语料提议 | POST /api/pw/collab/corpus/:id/approve（main.ts:882） | pw_corpus_docs（→pending，authorized_by=human） | 间接可逆：failed 可 force=1 重置 | manual_event/confirm/human | **UI 无按钮** |
| 16 | 驳回语料提议 | POST …/corpus/:id/reject（main.ts:893） | pw_corpus_docs（→failed，error='人工驳回'） | 可救回：force=1 重置 | manual_event/reject/human | **UI 无按钮** |
| 17 | 筛子自动 run（到达去抖） | 四到达线收口 notifyArrival（pw-sieve.ts:969）：sync created>0 / corpus done / 人工录 data-doc / voice 录入；10 分钟安静窗+单飞 | pw_sieve_runs + pw_sieve_cards + pw_sieve_state | 部分可逆：失败不产卡水位不进；已产卡只能挑/否 | sieve/sieve_run/system | 含判断（LLM 选引文），但确定性后处理兜底——搬运摆盘不掌勺 |
| 18 | 筛子 watermark 兜底 run | idleTimer 60s（main.ts:190）→ tickWatermark（pw-sieve.ts:950） | 同 #17（trigger_source='watermark'） | 同 #17 | 同 #17 | 纯机制兜底 |
| 19 | 手动补筛 | UI 补筛 → POST /api/pw/sieve/run（main.ts:674）→ flushNow（pw-sieve.ts:927） | 同 #17（trigger_source='manual'） | 同 #17 | 同 #17 | 纯劳动（提前扳机） |
| 20 | 全否重筛（复合） | UI 全否重筛（Collab.tsx:203-220,276）：二次确认→逐张调 #10→再调 #19 | pw_sieve_cards×N + 同 #17 | 否卡不可逆 | N 条 reject + 1 条 sieve_run | 含判断（全否=换方向）；纯前端编排无独立后端动作 |
| 21 | 录入观众声音 | POST /api/pw/voice（main.ts:629）→ addPwVoiceItem（pw-voice.ts:68） | pw_voice_items | 无删除；只能 #23 软丢弃 | **无 pw_runs 事件** | 纯劳动；无 UI 只能 curl |
| 22 | LLM 分拣 signal_type | POST /api/pw/voice/classify（main.ts:651）→ classifyPwVoiceItems（pw-voice.ts:91） | pw_voice_items.signal_type + cluster_id | 可逆：可重跑覆盖；失败不阻断 | **无 pw_runs 事件** | 含判断（LLM 四类）；signal_type 唯一写入方 |
| 23 | 丢弃声音 | POST /api/pw/voice/:id/drop（main.ts:659） | pw_voice_items.dropped_reason | 软丢弃；无 undrop，撤销只能手改库 | **无 pw_runs 事件** | 含判断（人定噪声） |
| 24 | 人工授权登记 BV | UI 登记获取 → POST /api/pw/corpus（main.ts:799）→ authorizePwCorpus（pw-corpus.ts:150） | pw_corpus_docs（pending，authorized_by='human'） | 幂等；done/needs_human/failed 需 force=1 | **无 pw_runs 事件** | 含轻判断（授权语义）；抓取器唯一取件口 |
| 25 | 授权重置/重抓（force=1） | UI 已处理 → 同 #24 带 force=1 | pw_corpus_docs（重置 pending） | 本身就是恢复通路 | 无 | 纯劳动 |
| 26 | 抓取器开工 | 脚本 → POST /api/pw/corpus/:id/fetching（main.ts:817） | pw_corpus_docs（→fetching） | 中间态 | 无 | 纯劳动 |
| 27 | 抓取回报成功 | 脚本 → POST …/done（main.ts:825）→ donePwCorpus（pw-corpus.ts:283） | pw_corpus_docs（done+meta+sha256）+ pw_corpus_fts 重建（同事务）+ 触发 #17 | 可逆：force=1 重抓覆盖 | **无 pw_runs 事件** | 纯劳动 |
| 28 | 抓取回报失败 | 脚本 → POST …/fail（main.ts:838） | pw_corpus_docs（needs_human/failed+error） | 可逆：force=1 重排 | 无 | 纯劳动；needs_human=交人信号 |
| 29 | 人工录入数据文档 | UI 录入数据 → POST /api/pw/bets/:id/data-docs（main.ts:558）→ createPwDataDoc（pw-data-docs.ts:50） | pw_data_docs（version=1） | 不可逆：无删除/编辑路由 | manual_event/data_doc/human + sieve 通知 | 纯劳动（抄数），但是结账证据源头 |
| 30 | B站低频同步落库 | 脚本 → POST /api/pw/sync/bilibili（main.ts:784）→ syncPwBilibili（pw-connections.ts:203） | pw_data_docs（method='sync'，版本只增）+ pw_connections.last_sync_at | 无删除；版本只增 | sync/data_doc/system；created>0 触发 #17 | 纯劳动 |
| 31 | 登记平台连接 | UI 连接账号 → POST /api/pw/connections（main.ts:768） | pw_connections（同平台幂等；auth_ref 恒 NULL 军规） | 幂等；无删除路由 | 无 | 纯劳动 |
| 32 | 连接状态机变更 | UI 恢复 active / 脚本置 needs_human → POST /api/pw/connections/:id/status（main.ts:773） | pw_connections.status；needs_human 时 risk_events_json 追加 | status 可来回；risk_events 只增不清（军规） | 无 | 置 needs_human 含判断；恢复是纯劳动 |
| 33 | 挂载产出物 | UI 挂载产出 → POST /api/pw/bets/:id/artifacts（main.ts:525） | pw_artifacts | 无编辑；只能 #34 软摘 | manual_event/attach/human | 纯劳动（登记事实） |
| 34 | 摘除产出物 | UI 摘除 → POST /api/pw/artifacts/:id/detach（main.ts:548） | pw_artifacts.detached_at | 半可逆：软摘可读回；无 re-attach 路由 | manual_event/attach/human（payload detached:true） | 含轻判断（摘除后同步不再收） |
| 35 | 审计事件落库 | recordPwEvent（pw-runs.ts:142），由 #1-3,5-7,9-20,29,30,33,34 连带 | pw_runs（payload sha256 落 payload_hash） | 只增不改（append-only） | 自身即审计 | 纯机制 |
| 36 | 筛子水位推进 | advanceWatermarkFromInput（pw-sieve.ts:743），run 成功后按实际消费行推进 | pw_sieve_state | 无重置通路 | 无独立事件（挂 sieve_run 内） | 纯机制 |

### 无通路 / 半通路动作（只能手改库或 curl）

- 数据文档版本追加 appendPwDataDocVersion（pw-data-docs.ts:82）与冻结 freezePwDataDoc（:121）：有函数有测试，**无路由无 UI**。
- 待确认队列四个批准/驳回（#7、#12-16）：路由和 pwApi 封装都在，**PW-20 返工后前端零按钮**——pendingQueue 只在首页显示计数（Home.tsx:66-71）。AI 的 draft_bet/draft_settle/fetch_corpus 产物目前在 UI 上无法转正也无法驳回，全堵在队列里（截图断点的代码级病根）。
- 手工建押注草稿（#11）：路由在，pwApi 无封装，UI 无入口。
- 观众声音三个写（#21-23）：路由在，前端零封装零按钮（导航置灰「P2 开通」），只能 curl。
- B站同步与语料抓取状态机（#26-28、#30）：UI 无按钮，通路是两个外部脚本（手跑/cron）。
- 押注卡编辑/删除：pw_bets 无 PUT/DELETE 路由；draft 态也仅 confirm/reject 两出口。
- 判决撤销/改写：唯一「反悔」是 settle 选 void 且之后重结（pw-verdicts.ts:89）。
- 候选卡状态回退、筛子水位重置：无通路。
- pw_voice_items.promoted_to_draft_id：schema 在但全仓无代码写入——死列（声音→草稿提升链未实现）。
- 协作台消息删除、金子镜像删除/强制刷新、risk_events 清空：均无通路。
- open_fallback 筛子触发源：CHECK 允许（pw-sieve.ts:76）但无代码发出——保留未接线。

### 给权限决策的三个要点

1. **AI 现有写面恰好三层**：只读 14 + ask 1 + draft 2，全部落在「proposed/draft 态 + 人确认转正」的缓冲表上；正式表（pw_verdicts、pending 态 pw_bets、pw_gold_mirror、pw_sieve_cards 状态机）AI 零通路，由 deny 名单 + 测试断言锁死。
2. **审计盲区**：voice 三写、语料授权/抓取四写、连接两写、金子镜像、协作消息落库均无 pw_runs 事件——若放开给 AI，现有审计体系记不到（actor=ai 强制 kind=ai_draft，event_type 仅 9 种，放开须先扩 schema）。
3. **纯劳动候选**：镜子同步（幂等搬运）、数据文档录入（抄数但系结账证据源头，污染成本高）、声音录入/分拣（分拣含 LLM 判断但可重跑覆盖）；不可逆且高判断的结账、pick/reject、草稿确认已有「人落笔」结构，void/唯一索引/单向状态机提供实现级兜底。
