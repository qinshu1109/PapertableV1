# 21-backend-done：第一期·运行闭环止血（后端三项）完工报告

- 简报：`agent-bridge/briefs/21-phase1-backend.md`（执行方：cc-tui / dsh headless，主控 kimi）
- 日期：2026-08-13
- 性质：开发（后端三项，代码 + 测试 + 真实 curl 证据）；不 commit、不 push

## 什么能用了 / 什么还不行 / 有什么等拍板

- **什么能用了**：押注在转正（激活）之前会被一道只读检查闸门拦住——数据源没绑、指标没写、结账日已过或缺失的押注，激活时会收到 409 和具体失败清单；押注台多了一张「在途押注成熟度总账」（谁到期了、谁缺数据、谁指标失效、谁逾期未结）；大盘多了一张「双账度量」（认识论账只数有效结账，运行账数逾期/可避免作废/数据故障/自动供血）。
- **什么还不行**：前端屏（押注台 blotter、大盘双账卡片）还没接——那归主控 kimi 亲自做；闸门目前只在新的「激活」入口强制，协作台 AI 副驾驶的既有「确认转正」通路未动（守门①授权范围只到闸门本身）。
- **有什么等拍板**：①「激活」是否也应由协作台 AI 通路统一走闸门（本次没碰，等拍板）；②双账里「可避免作废」的口径（见下「口径与边界」），以及自动供血成功率只覆盖语料抓取通路（B站同步失败不落库，算不出来）。

## 这刀是干什么的

镇纸的核心循环是「押注 → 开干 → 数据回流 → 到期结账」。之前这个环是漏的：押注台看不到谁到期了、谁该结账了、谁数据没回来，而且一笔押注就算指标没写、数据源没绑也能直接转正——转正后大概率永远结不了账，只能作废。这一刀做三件事：

1. **激活前先体检**：押注转正（草稿变正式）之前，先做一次只读体检（数据源通不通、指标能不能判、结账日合不合理），不合格就拦住并告诉你是哪几项不行；「手动录入数据」不算不合格，只是提醒。
2. **押注台总账**：把所有在途押注聚合成一张表，每行标明「未到期 / 今天到期可结 / 到期缺数据 / 指标失效 / 逾期未结」，逾期和出问题的排最前面，到期近的排前面。
3. **双账大盘**：一张认识论账（只数真正结出金子/墓碑的有效结账，按月份分队列）+ 一张运行账（到期就绪率、有效结账率、平均结账延迟、累计欠账天数、可避免作废率、自动供血成功率、作废根因排行）。算不出来的字段给 null，绝不编数。

## 怎么算好

- 在押注台（或直接 curl）点「激活」：三行赌注齐、数据源已绑定的押注顺利转正；缺指标/缺结账日/数据源没绑的押注被 409 拦下并列出失败项；手动录入源押注能激活但带回提示。
- 打开押注台总账：能看到每笔在途押注的成熟度，逾期/缺数据/指标失效排在最前面。
- 打开大盘双账：能看到有效结账数、各运行指标；没有数据可算的指标显示为空而不是编造的数字。

---

## 以下给干活的看，可以跳过

## 改动文件清单

| 文件 | 改动 |
|---|---|
| `src/pw-bet-gate.ts` | **新增**：任务一闸门。`preflightPwBetActivation`（只读预检，幂等零写）、`activatePwBet`（强制闸门的激活）、`classifyDataSourcePlan`/`getPwDataSourceStatus`（数据源分类与状态，供任务二三共用） |
| `src/pw-bet-health.ts` | **新增**：任务二/三。`getPwBetLedger`（成熟度总账）、`getPwHealthAccounts`（双账度量） |
| `src/pw-bet-gate.test.ts` | **新增**：12 条测试（预检三态、只读幂等、激活 200/409/edits 合并） |
| `src/pw-bet-health.test.ts` | **新增**：6 条测试（ledger 排序与字段、双账口径、null 不编数） |
| `src/main.ts` | 只加路由与 import：`GET /api/pw/bets/ledger`、`GET /api/pw/health-accounts`、`POST /api/pw/bets/:id/activate/preflight`、`POST /api/pw/bets/:id/activate`（均不改既有路由行为） |
| `package.json` | test 脚本追加两行新测试登记 |

守门核查：**未碰** schema（无任何建表/迁移/加列）、未碰 frontend/、未碰 src/pw-drafts.ts 的 confirmPwBetDraft 本体（激活复用其 draft→pending 迁移，只在新的激活端点强制闸门）、未碰结账/审批/权限代码、未 commit。

## 测试结果（官方 Node v24.18.0，`PATH="$HOME/.local/node/bin:$PATH"`）

- `npm test`：**399 tests，399 pass，0 fail**（基线 381 + 新增 18）
- `npm run selfcheck`：`selfcheck: ok`
- `npm run verify`（test + selfcheck + 前端 build）：**exit 0 全绿**（前端 build 由 verify 正常重建，非手工改动 frontend/）

## 三个端点契约

### 任务一：`POST /api/pw/bets/:id/activate/preflight`（只读、幂等、零写）

请求体可选 `{"edits":{...}}`（预检按「草稿当前值 + edits 合并后」判定，与激活落库同口径）。响应：

```json
{ "checks": [{ "name": "data_source|metric|checkout_date", "result": "pass|fail|needs_human", "detail": "…" }], "pass": true }
```

- `pass = 无 fail`；`needs_human` 不拦（手动录入源 / 数据源需人工处理）。
- 检查项：`data_source`（自动源如 B站：连接存在且 active 视为可试读，needs_human/paused/unbound 分别处理；手动录入源标 needs_human）、`metric`（metric 与 metric_target 都非空）、`checkout_date`（非缺失、非过去）。
- 非草稿态 → 409；押注不存在 → 404。

### 任务一：`POST /api/pw/bets/:id/activate`（激活 = draft → pending，强制闸门）

- 预检有 fail → **409**，`details` 带回失败清单，不写任何库：
  `{"error":"激活预检未通过，请先处理失败项","details":{"checks":[…],"pass":false}}`
- 仅 needs_human 或全 pass → **200**，走既有 `confirmPwBetDraft` 转正（pw_draft_events 留痕 + route 层 pw_runs confirm 事件），响应带回预检提示：
  `{"bet":{…,"status":"pending","draft_hash":"…"},"preflight":{"checks":[…],"pass":true}}`
- 支持 `{"edits":{…}}`：先按合并后状态过闸，再落库（例如草稿缺指标、激活时用 edits 补齐）。

### 任务二：`GET /api/pw/bets/ledger`（只读聚合，只列在途 pending）

```json
{ "rows": [ { "betId": "…", "title": "…", "betType": "verdict|content", "activatedAt": "ISO|null",
  "dueAt": "…|null", "confidence": 0|null, "metricSummary": "…|null",
  "dataSource": { "kind": "auto|manual", "status": "active|needs_human|paused|unbound|manual", "lastDataAt": "ISO|null" },
  "maturity": "not_due|due_ready|due_missing_data|metric_invalid|overdue",
  "revisionCount": 0, "nextForcedEvent": "…|null" } ] }
```

- `maturity` 口径：未到期 `not_due`；已到期且指标可判且无回流数据 `due_missing_data`；已到期但指标失效（metric 或 metric_target 缺失）`metric_invalid`；已到期（早于今天）且可结 `overdue`；今天到期可结 `due_ready`。
- 排序：overdue → due_missing_data → metric_invalid → due_ready → not_due；同成熟度内结账日近的先（缺失殿后）。
- `activatedAt`：草稿转正押注取 `pw_draft_events(confirm)` 时间；直落 pending 取 `created_at`。`revisionCount` = 该押注回流数据文档数。`nextForcedEvent` = 尚未过去的结账日（已逾期为 null）。缺数据一律 null，不编造。

### 任务三：`GET /api/pw/health-accounts`（只读聚合）

```json
{ "epistemic": { "validSettlements": 0, "byCohort": [{ "cohort": "2026-08", "validSettlements": 0, "withConfidence": 0 }] },
  "operational": { "dueReadyRate": 0|null, "validSettlementRate": 0|null, "avgSettleLatencyDays": 0|null,
    "settleDebtDays": 0, "avoidableVoidRate": 0|null, "autoFeedSuccessRate": 0|null,
    "recurringVoidCauses": [{ "cause": "…", "count": 0 }] } }
```

## 真实 curl 样例

> 冒烟实例：隔离数据目录（`/tmp/pw-phase1-data`，**绝不碰真库**）起的同一份代码，`127.0.0.1:4399`；生产后端 `127.0.0.1:4317` 只做了只读 GET 与只读 preflight。所有响应为真实 HTTP 往返原文。

### 1a. 预检 pass（B站自动源 · 三行齐备）

```bash
curl -s -X POST http://127.0.0.1:4399/api/pw/bets/db041ef8-72de-4a64-97d1-4ed281dab654/activate/preflight \
  -H 'content-type: application/json' -d '{}'
```

```json
{"checks":[{"name":"data_source","result":"pass","detail":"B站 连接 active，可试读（尚未同步过（发布后同步即到））；尚无该押注回流数据（发布后同步即到）"},{"name":"metric","result":"pass","detail":"验证指标与判定规则齐备"},{"name":"checkout_date","result":"pass","detail":"结账日 2026-08-20 可达"}],"pass":true}
```

### 1b. 预检 needs_human（手动录入源 → 不拦，pass=true）

```bash
curl -s -X POST http://127.0.0.1:4399/api/pw/bets/bcfe7bef-cd3b-4035-997b-773e03ee9573/activate/preflight \
  -H 'content-type: application/json' -d '{}'
```

```json
{"checks":[{"name":"data_source","result":"needs_human","detail":"已确认走手动录入（不拦激活）"},{"name":"metric","result":"pass","detail":"验证指标与判定规则齐备"},{"name":"checkout_date","result":"pass","detail":"结账日 2026-08-22 可达"}],"pass":true}
```

### 1c. 预检 fail（缺指标）

```bash
curl -s -X POST http://127.0.0.1:4399/api/pw/bets/c760ffec-888d-44bd-a458-238056424a47/activate/preflight \
  -H 'content-type: application/json' -d '{}'
```

```json
{"checks":[{"name":"data_source","result":"pass","detail":"B站 连接 active，可试读（尚未同步过（发布后同步即到））；尚无该押注回流数据（发布后同步即到）"},{"name":"metric","result":"fail","detail":"缺少：验证指标（metric）、判定规则/指标目标（metric_target）"},{"name":"checkout_date","result":"pass","detail":"结账日 2026-08-25 可达"}],"pass":false}
```

### 2a. 激活成功（HTTP 200，draft→pending，响应带回预检）

```bash
curl -s -X POST http://127.0.0.1:4399/api/pw/bets/9c8d1b6c-d58b-45ac-8ffe-7efd00038092/activate \
  -H 'content-type: application/json' -d '{}'
```

```json
{"bet":{"id":"9c8d1b6c-d58b-45ac-8ffe-7efd00038092","title":"干净草稿-自动源","thesis":"假设","metric":"播放量","metric_target":">1000","confidence":null,"data_source_plan":"B站创作中心","checkout_date":"2026-08-25","status":"pending","gold_refs_json":"[]","created_from":null,"created_at":"2026-08-13T22:45:20.478Z","settled_verdict_id":null,"kind":"verdict","source_card_id":null,"draft_hash":"55326f1c594de732aa489616131601a6bf02baf22af9520de1cea129f98c1c11"},"preflight":{"checks":[{"name":"data_source","result":"pass","detail":"B站 连接 active，可试读（尚未同步过（发布后同步即到））；尚无该押注回流数据（发布后同步即到）"},{"name":"metric","result":"pass","detail":"验证指标与判定规则齐备"},{"name":"checkout_date","result":"pass","detail":"结账日 2026-08-25 可达"}],"pass":true}}
```

### 2b. 激活被闸门拦下（HTTP 409 + 失败清单，零写入）

```bash
curl -s -w '\nHTTP %{http_code}\n' -X POST http://127.0.0.1:4399/api/pw/bets/cb82ebb7-9631-432f-8006-33ac0df5469b/activate \
  -H 'content-type: application/json' -d '{}'
```

```json
{"error":"激活预检未通过，请先处理失败项","details":{"checks":[{"name":"data_source","result":"pass","detail":"B站 连接 active，可试读（尚未同步过（发布后同步即到））；尚无该押注回流数据（发布后同步即到）"},{"name":"metric","result":"pass","detail":"验证指标与判定规则齐备"},{"name":"checkout_date","result":"fail","detail":"结账日已是过去（2026-08-10 < 2026-08-13）"}],"pass":false}}
HTTP 409
```

### 2c. 激活时用 edits 补齐缺口 → 按合并后状态过闸（HTTP 200）

```bash
curl -s -X POST http://127.0.0.1:4399/api/pw/bets/e3d11d45-3bbd-41c5-8ba2-12f72c1e1c6b/activate \
  -H 'content-type: application/json' -d '{"edits":{"metric":"播放量","metricTarget":"> 1000"}}'
```

```json
{"bet":{"id":"e3d11d45-3bbd-41c5-8ba2-12f72c1e1c6b","title":"edits补齐样例","thesis":"假设","metric":"播放量","metric_target":"> 1000","confidence":null,"data_source_plan":"B站创作中心","checkout_date":"2026-08-26","status":"pending","gold_refs_json":"[]","created_from":null,"created_at":"2026-08-13T22:46:13.244Z","settled_verdict_id":null,"kind":"verdict","source_card_id":null,"draft_hash":"f9dd058b5f13329034dbbb67ade4c14bd3ec701e4243161a480f1808814a5bbe"},"preflight":{"checks":[{"name":"data_source","result":"pass","detail":"B站 连接 active，可试读（尚未同步过（发布后同步即到））；尚无该押注回流数据（发布后同步即到）"},{"name":"metric","result":"pass","detail":"验证指标与判定规则齐备"},{"name":"checkout_date","result":"pass","detail":"结账日 2026-08-26 可达"}],"pass":true}}
```

### 3. 成熟度总账（隔离实例，真实数据）

```bash
curl -s http://127.0.0.1:4399/api/pw/bets/ledger
```

```json
{"rows":[{"betId":"bet-overdue","title":"到期未结可结押注","betType":"verdict","activatedAt":"2026-07-20T00:00:00.000Z","dueAt":"2026-08-10","confidence":65,"metricSummary":"三期平均播放量（目标 不低于 5000）","dataSource":{"kind":"auto","status":"active","lastDataAt":"2026-08-11T00:00:00.000Z"},"maturity":"overdue","revisionCount":1,"nextForcedEvent":null},{"betId":"d88ed563-ed22-4752-97b6-f7519091e657","title":"到期缺数据押注","betType":"verdict","activatedAt":"2026-08-13T22:42:54.145Z","dueAt":"2026-08-11","confidence":null,"metricSummary":"收藏数（目标 >100）","dataSource":{"kind":"auto","status":"active","lastDataAt":null},"maturity":"due_missing_data","revisionCount":0,"nextForcedEvent":null},{"betId":"bet-metric-invalid","title":"指标失效押注（直插演示）","betType":"verdict","activatedAt":"2026-08-01T00:00:00.000Z","dueAt":"2026-08-10","confidence":null,"metricSummary":null,"dataSource":{"kind":"auto","status":"active","lastDataAt":null},"maturity":"metric_invalid","revisionCount":0,"nextForcedEvent":null},{"betId":"db041ef8-72de-4a64-97d1-4ed281dab654","title":"直播切片试水","betType":"verdict","activatedAt":"2026-08-13T22:42:43.908Z","dueAt":"2026-08-20","confidence":70,"metricSummary":"三期平均播放量（目标 不低于 5000）","dataSource":{"kind":"auto","status":"active","lastDataAt":"2026-08-13T22:43:25.445Z"},"maturity":"not_due","revisionCount":1,"nextForcedEvent":"2026-08-20"},{"betId":"9c8d1b6c-d58b-45ac-8ffe-7efd00038092","title":"干净草稿-自动源","betType":"verdict","activatedAt":"2026-08-13T22:45:20.487Z","dueAt":"2026-08-25","confidence":null,"metricSummary":"播放量（目标 >1000）","dataSource":{"kind":"auto","status":"active","lastDataAt":null},"maturity":"not_due","revisionCount":0,"nextForcedEvent":"2026-08-25"},{"betId":"c760ffec-888d-44bd-a458-238056424a47","title":"缺指标草稿","betType":"verdict","activatedAt":"2026-08-13T22:42:43.931Z","dueAt":"2026-08-25","confidence":null,"metricSummary":"播放量（目标 > 1000）","dataSource":{"kind":"auto","status":"active","lastDataAt":null},"maturity":"not_due","revisionCount":0,"nextForcedEvent":"2026-08-25"},{"betId":"f47607a6-9d48-4919-bf96-f78d59df5280","title":"下周选题：AI办公","betType":"verdict","activatedAt":"2026-08-13T22:42:54.131Z","dueAt":"2026-08-25","confidence":null,"metricSummary":"私域加群/问工具人数（目标 10）","dataSource":{"kind":"manual","status":"manual","lastDataAt":"2026-08-13T22:43:25.455Z"},"maturity":"not_due","revisionCount":1,"nextForcedEvent":"2026-08-25"},{"betId":"e3d11d45-3bbd-41c5-8ba2-12f72c1e1c6b","title":"edits补齐样例","betType":"verdict","activatedAt":"2026-08-13T22:46:13.252Z","dueAt":"2026-08-26","confidence":null,"metricSummary":"播放量（目标 > 1000）","dataSource":{"kind":"auto","status":"active","lastDataAt":null},"maturity":"not_due","revisionCount":0,"nextForcedEvent":"2026-08-26"}]}
```

### 4. 双账度量（隔离实例）

```bash
curl -s http://127.0.0.1:4399/api/pw/health-accounts
```

```json
{"epistemic":{"validSettlements":1,"byCohort":[{"cohort":"2026-08","validSettlements":1,"withConfidence":1}]},"operational":{"dueReadyRate":0.33,"validSettlementRate":0.33,"avgSettleLatencyDays":3,"settleDebtDays":8,"avoidableVoidRate":0.5,"autoFeedSuccessRate":0.5,"recurringVoidCauses":[{"cause":"其他","count":1},{"cause":"无回流数据","count":1}]}}
```

### 5. 生产库只读验证（`127.0.0.1:4317`，重启后真实数据，不写库）

```bash
launchctl kickstart -k gui/$(id -u)/com.qinshu.papertable.backend   # 重启加载新代码
curl -s http://127.0.0.1:4317/api/pw/bets/ledger
curl -s http://127.0.0.1:4317/api/pw/health-accounts
curl -s -X POST http://127.0.0.1:4317/api/pw/bets/3c58f1cb-96cd-4f09-8e9e-9882dd4f8758/activate/preflight -H 'content-type: application/json' -d '{}'
```

生产 ledger（摘录）：6 笔在途 content 押注全部手动录入源，3 笔 `due_missing_data`（8-13 到期无回流数据）、3 笔 `not_due` —— 与研究报告「内容押注 0 笔结过账、自动回流 0 份」互相印证。生产 health-accounts：`validSettlements:1`、`validSettlementRate:0.33`、`avgSettleLatencyDays:2407`（真库唯一有效结账的 checkout_date 距今很远，如实计算未截断）。生产草稿 preflight 返回 `needs_human`（手动录入源）且 **preflight 后草稿仍为 draft**（只读铁证）。

## 口径与边界（决策记录）

1. **激活端点 = 新增 `POST /api/pw/bets/:id/activate`**，复用既有 `confirmPwBetDraft` 做 draft→pending（状态机唯一真值源不新造）。既有 `/api/pw/drafts/:id/confirm` 与协作台 AI 工具 `confirm_bet_draft` 未动——守门①授权只到闸门本身，没顺手改其他确认流程；AI 通路是否也要过闸，已列等拍板项。
2. **`due_ready` vs `overdue`**：今天到期可结 = `due_ready`；已过结账日仍未结 = `overdue`（唯一能区分两枚举的口径，注释已写进模块）。
3. **`revisionCount`** = 该押注重回数据文档数（每次追加/同步一个版本行 +1）。
4. **`activatedAt`**：转正押注取确认事件时间，直落 pending 取 created_at；无更精确记录的给 null。
5. **`avoidableVoidRate`**：只统计结账动作产生的 void 判决（`pw_verdicts` outcome='void'），「可避免」= 该押注无回流数据 / 指标缺失 / 自动源未绑定或停用（即闸门本应拦下的）；unpick 冲正作废不产生判决行，不在口径内。分母 = 全部 void 判决，无 void 给 null。
6. **`autoFeedSuccessRate`**：只覆盖有持久化终态的语料抓取通路（done/(done+failed+needs_human)）；**B站同步失败不落库**（`syncPwBilibili` 的 errors 只回响应），无法纳入分母——算不出的部分如实 null，不编数。
7. **`avgSettleLatencyDays`** = 有效结账（gold/tomb）的 `decided_at − checkout_date` 平均天数，如实计算不截断异常值。
8. 全部聚合只读现有表：pw_bets / pw_draft_events / pw_data_docs / pw_connections / pw_verdicts / pw_corpus_docs；零建表零迁移（守门②）。

## 交接提示（给 codex 验收）

- 浏览器验收可先看生产 `127.0.0.1:4317` 的只读两接口；激活/预检建议在隔离实例（`PAPERTABLE_DATA_DIR=/tmp/...` 起服务）或先用现有生产草稿跑只读 preflight，**不要在生产激活真实押注**（会写真库）。
- 发现问题以简报形式回，我按问题回路修。
