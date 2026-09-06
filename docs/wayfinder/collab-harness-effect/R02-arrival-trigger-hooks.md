# R02 「数据到达」扳机挂钩点调研

- Labels: wayfinder:research
- Status: closed（2026-08-04 research 子代理交付，主会话验收关闭）
- Assignee: research 子代理（agent-1）
- Blocked-by: 无

## Question

在现有代码里，「数据到达」事件能在哪些点被可靠捕获？候选点：每日 cron 784abedf（B站同步+语料排空）及其脚本 `scripts/pw-fetch-bili-corpus.js`、`createPwDataDoc` / `appendPwDataDocVersion`、`donePwCorpus`、观众声音抓取路径、人工录入数据入口（开干位「录入数据」）。每点评估：到达判定的可靠性、挂载后台筛子的可行性、时序（同步完成→可筛的边界）、失败/重试语义。产出挂钩点候选清单 + 推荐主挂钩点。

## Resolution

调研日期 2026-08-04。结论先行：**推荐主挂钩点 = 服务端（src/main.ts 进程）四个落库路由成功返回后的统一收口**，配 DB watermark 轮询做耐用底座；扳机绝不挂 cron / 脚本尾。理由与逐点评估如下。

### 事实底座：数据怎么进来

- 后端 `node src/main.ts` 由 launchd（`com.qinshu.papertable.backend.plist`，RunAtLoad + KeepAlive）常驻，监听 127.0.0.1:4317（main.ts:114-115）；SQLite 为 WAL（data.ts:70-73），单进程写。
- 两个取数脚本（`scripts/pw-sync-bilibili.js`、`scripts/pw-fetch-bili-corpus.js`）**不在 package.json、不在 launchd、不在系统 cron**，由「会话 cron」触发（TASK-PW-13 验收记录 7：`c84b0129`；TASK-PW-14 验收记录 5：`784abedf` 06:47 依次跑同步+排空），且「会话不在线时当天跳过，需手动 `ego-browser nodejs < ...`」。脚本只是 HTTP 客户端，**所有数据最终都收口进 main.ts 的 HTTP 路由落库**。
- 现有事件账 `pw_runs`（pw-runs.ts）已覆盖两路到达：人工录入经路由层 `emitPwEvent("data_doc", actor=human)`（main.ts:538），B站同步经 `syncPwBilibili` 内 `recordPwEvent(kind='sync', event_type='data_doc', actor='system')`（pw-connections.ts:213）。**语料 done 与观众声音目前不写 pw_runs。**

### 候选点评估清单（①到达判定可靠性 ②挂筛子可行性 ③时序边界 ④失败/重试）

**A. 每日会话 cron 784abedf / 脚本尾部**
- ① 不可靠：会话 cron 会话不在线即整天跳过；脚本可任意时刻手动重跑；同步脚本同日已同步直接退出不发任何请求（pw-sync-bilibili.js:107-109）；0 匹配也 POST 空 items 只刷新 last_sync_at（:173-181）；撞风控置 needs_human 后脚本 break 提前退出。「cron 跑了」≠「有数据到达」，「全部完成」时刻只存在于会话叙事（简报）里，代码里没有。
- ② 不可行：脚本跑在 ego-browser 的 nodejs 沙箱里，挂筛子等于让触发逻辑依赖一个会缺席的进程。
- ③④ 无意义（不作为扳机）。结论：**排除**；它至多是「到达通知」的一个普通来源。

**B. `createPwDataDoc` / `appendPwDataDocVersion`（pw-data-docs.ts）**
- ① 覆盖不全：`createPwDataDoc` 只服务人工录入（P0 硬编码 method='manual'，pw-data-docs.ts:57-59）；**`appendPwDataDocVersion` 生产零调用**（仅测试引用）——同步路径 `syncPwBilibili` 自己算 version=count+1 直接 INSERT（pw-connections.ts:201-211），绕过这两个函数。挂这里会漏掉全部同步到达。
- ③ 单条 INSERT 即原子，无半截窗口。结论：**排除作为扳机**（在路由层而非这两个函数上挂，见推荐方案）。

**C. `syncPwBilibili`（pw-connections.ts:155-226，POST /api/pw/sync/bilibili）——指标同步真实落点**
- ① 可靠（行级）：每条 item 独立 INSERT pw_data_docs + pw_runs 事件，落库即提交；但**循环无整体事务**，进程中途被杀会留下部分批次（每行自洽，无脏行）。「批次完整」的唯一信号是脚本拿到 HTTP 200 + `created` 计数。
- ② 高度可行：在路由 `syncPwBilibili(...)` 返回后（main.ts:708-712）判定 `created>0` 即发「到达通知」；created=0 是心跳不算到达。
- ③ 无未提交窗口：路由返回时所有行已提交，筛子立即可读。
- ④ **无幂等键**：脚本超时重跑会对同一稿件重复插行（version 只增），筛子必须按 doc UUID（pw_runs.related_ids / pw_data_docs.id）去重，不能按内容；needs_human 中断时 items 清空、本批不入库（pw-sync-bilibili.js:153-156），不误触发。

**D. `donePwCorpus`（pw-corpus.ts:261-308，POST /api/pw/corpus/:id/done）——语料真实落点**
- ① 可靠且原子：单事务（BEGIN IMMEDIATE）内更新 status='done' + 按 bvid 重建 FTS（pw-corpus.ts:287-302）；脚本**先把 meta.json/comments.jsonl 落盘、再 POST /done**（pw-fetch-bili-corpus.js:125-151），done 提交那一刻文件 + 行 + FTS 三者一致，是最干净的到达点。
- ② 可行：路由返回后（main.ts:746-755）即可触发；`sha256` + `fetched_at` 是天然去重键；也支持轮询判定（`status='done' AND fetched_at > watermark`）。
- ③ 无未提交窗口。注意脚本一次最多抓 3 条（MAX_PER_RUN=3），会连发 3 个 done → 触发端必须去抖合并。
- ④ 良好：重发同 payload 的 done 是幂等重建 FTS；force=1 重授权后重抓产生新 sha 的新 done，属合法新到达。唯一缺口：脚本死在「文件已落盘、done 未 POST」之间时行卡 fetching，文件在盘上但不触发（正确，半截不触发），需人工 force 解锁，无自动恢复。另：**done 目前不写 pw_runs**，若走事件账需补。

**E. 观众声音（pw-voice.ts，POST /api/pw/voice → `addPwVoiceItem`）**
- 现状：无抓取脚本、前端屏未开通（PaperweightApp.tsx:28「观众声音将在 P2 开通」），唯一入口是手动粘贴 POST（TASK-PW-08 定位即「P0 手动粘贴录入」），评论类信号的体量实际走路径 D（语料评论）。
- ①②③④：单条 INSERT 原子、路由层可挂（main.ts:599-607）；到达≠已分拣（classify 是另一个 POST，筛子不该等它）。结论：**低频 dormant，接入优先级最低，P2 开通后按同一路由收口模式挂上即可**。

**F. 人工录入数据入口（开干位「录入数据」→ POST /api/pw/bets/:betId/data-docs，main.ts:530-545）**
- ① 可靠：createPwDataDoc 成功 + 已发 pw_runs `data_doc` 事件。② 路由返回 201 后即可触发。③ 无窗口。④ 人工低频单条，无批量/重试问题。结论：**合格到达点，且已接入现有事件账**。

### 推荐主挂钩点（统一收口点）

**唯一扳机 = main.ts 路由层「落库成功返回后」的统一到达通知，四条接入线：**
1. `POST /api/pw/sync/bilibili` 返回且 `created>0`（指标到达；0 跳过）
2. `POST /api/pw/corpus/:id/done` 返回（语料到达）
3. `POST /api/pw/bets/:betId/data-docs` 返回 201（人工录入到达）
4. `POST /api/pw/voice` 返回 201（声音到达，P2 再接）

**挂法（按可行性排序）：**
- **进程内挂函数（主）**：路由成功后 push 一个「到达通知」进内存去抖队列（建议安静窗合并：一批 sync N 条、一次语料 ≤3 条 done、人连续录入，合并为一筛；如 10–15 分钟安静窗或「每日首达 + 其后限频」）。筛子本体与 runCollabTurn 同模式在服务端进程内跑（AgentHarness + createPapertableProvider 可直接复用，pw-collab.ts:198-244 已有先例），launchd KeepAlive 保证进程常驻。main.ts:161 的 60s `idleTimer` 是「服务端周期后台任务」的现成先例。
- **DB watermark 轮询（耐用底座，必须与主挂法共存）**：周期比对 `pw_data_docs.id/created_at`、`pw_corpus_docs(status='done', fetched_at)`、`pw_voice_items.created_at` 的水位差，崩溃重启后补筛——内存队列会丢，这是唯一的崩溃恢复保障，也正好承载 MAP 已决的「打开兜底补筛」之外的第三层兜底。WAL 下读取无锁冲突。
- **文件 Watcher：否决**。corpus done 已保证先落盘后提交，watcher 只会引入「文件写到一半」的早触发风险。
- **挂 pw_runs 轮询（备选简化）**：只轮询 `event_type='data_doc'` 新行可零改动覆盖 F+C 两路，但缺 D/E；可作为 watermark 底座的数据源之一，不建议当唯一扳机。

**时序边界总结**：四条线在「路由返回」时刻均无未提交/未落盘窗口（D 的文件先于事务落盘；C 行级提交；B/F 单语句）。唯一的批级不确定性在 C：批次完整性只能信脚本拿到的 HTTP 200，服务端视角「到达」应按行判定。

**失败与重试语义**：needs_human/failed 不产生到达、天然不触发；筛子自身崩溃由 watermark 轮询补；sync 无幂等键 → 去重一律按 doc UUID；若要把筛子运行写进 pw_runs 审计（MAP「Not yet specified」已列此问），注意 pw_runs 的 CHECK 约束（kind/event_type 固定枚举，pw-runs.ts:63-81）不含筛子类，需照 `migratePwRunsCheck` 的先例做重建表迁移。

### 最大风险点

1. **触发源头的频次不在代码掌控内**：会话 cron 会缺席，数据到达实际发生在「脚本被跑」的任意时刻——这正是否决 cron 挂钩、选择服务端收口的原因（收口对手动跑/补跑/未来换成系统 cron 全部免疫），但也意味着「每日大屏」在脚本未跑的日子里就是无新筛，规格层需接受。
2. **sync 批次的半截语义**：无整体事务 + 无幂等键，重试产生重复行；按行（UUID）判定与去重是硬要求，按批/按内容判定都会出错。
3. **语料卡 fetching 无自动恢复**：脚本死于落盘与 done 之间时，该 bvid 不触发且需人工 force 重授权——低频可接受，但规格里「失败重试」一章应写明这是人工路径。
