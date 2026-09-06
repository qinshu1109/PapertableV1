# 23-backend-done：第二期·学习闭环编译层（后端）完工报告

- 简报：`agent-bridge/briefs/23-phase2-backend.md`（执行：dsh-cc 通道，主控 kimi；验收：codex）
- 日期：2026-08-14
- 性质：开发（后端，三张新表 + 五端点 + 曝光自动记账 + 激活联动闸门）；不 commit、不 push

## 什么能用了 / 什么还不行 / 有什么等拍板

- **什么能用了**：判决可以「晋级」了——人看过一条判决后给它定级（仅归档/先例/警告/硬约束/待办），同一判决反复看就形成晋级链；押注激活时，系统会从金子墓碑库（含纸桌镜像金子）里按「与这单押注相不相关」召回先例，没处置完先例的押注会被拦住并列出未处置清单，处置完才能转正；判决每次被塞进 AI 上下文（协作台、筛子、捞料）都会记一条曝光流水，随时能查「这条判决被摆到过哪些场合」。
- **什么还不行**：前端屏还没接（晋级面板、先例清单、曝光流水查询界面都归主控 kimi 亲自做）；协作台 AI 副驾驶的「确认转正」通路是否也要过先例闸门仍是用户挂起项（简报 23 明确本期不接）；`expired` 状态已预留但本期没有自动过期机制。
- **有什么等拍板**：①先例召回的「词面重叠」阈值（≥2 个双字 shingle 才算相关）是我定的口径，若验收嫌松/嫌紧可调；②`GET /api/pw/bets/:id/precedents` 只是读取展示，没有记曝光（只有激活闸门记 `activation` 曝光），若希望「人每次查看先例都留痕」需另行拍板。

## 这刀是干什么的

镇纸的闭环理想是「押注 → 开干 → 回流 → 结账 → 判决进入下一圈」，但之前判决结完账就躺进库，没有人必须回头消费它。这一刀给判决库装上「编译层」：人把重要判决**晋级**成有等级、有适用范围、有复核期限的规则（hard_constraint 就是要遵守的、warning 是要小心的、action_item 是要去做的、case_only 是看过但决定不升级的）；新押注开张前，系统自动把**相关的**老判决摆出来，人得逐条表态（采纳/区分/不适用/推翻）才能放行——「这坑我栽过」从此不是自觉，而是闸门。同时把「判决被 AI 用过的场合」全部记账，将来能回答「这条判决到底被消费过几次」。

## 怎么算好

- 打开某个判决的晋级接口（或将来前端按钮）：能给它定级、填适用范围/复核期限/理由；再晋一次级，旧的自动标为「已取代」并接上新链；选「仅归档」也会落一行，表示人看过、决定不升级。
- 打开某押注的先例清单：能看到与它相关的老判决（带「为什么相关」的说明、以及该判决当前晋级状态）；完全不相关的押注看到的是空清单，绝不拿「最近 10 条」凑数。
- 激活一笔有相关先例的押注：先例没逐条处置 → 被 409 拦下并列出未处置清单；逐条处置完（「推翻」必须填理由）→ 正常转正。
- 打开某判决的曝光流水：能看到它被塞进过哪些场合（协作台/筛子/捞料/激活）、谁塞的（系统还是 AI）、哪一轮。

---

## 以下给干活的看，可以跳过

## 改动文件清单

| 文件 | 改动 |
|---|---|
| `src/data.ts` | **新增**三张表（`pw_verdict_promotions` / `pw_precedent_dispositions` / `pw_verdict_exposures`，DDL 与简报逐字一致）+ 简报指定索引 + pt_schema v4→v5 迁移（`migratePhase2V5`，表已在顶部幂等建好，迁移只升版本号） |
| `src/pw-closed-loop.ts` | **新增**：晋级（promote 落行/接 superseded 链/GET active）、先例召回（按适用匹配）、先例处置落账（overridden 必填 reason）、未处置清单（闸门用）、曝光记账与查询；模块内自带幂等 `ensurePwClosedLoopTables`（DDL 与 data.ts 逐字一致，测试/夹具缺表时自愈，照 `recordPwRecallEvent` 内部 ensure 先例） |
| `src/pw-bet-gate.ts` | `activatePwBet` 在 preflight 通过后追加简报 23 联动闸门：相关先例非空且存在未处置项 → 409 带回未处置清单；存在相关先例时记 `surface='activation'` 曝光（preflight 保持只读零写不变） |
| `src/pw-collab.ts` | 协作台 §N 注入点：`runCollabTurn` 装配上下文后记一行曝光（surface=`collab`，actor=system，含 golds+tombs id） |
| `src/pw-sieve.ts` | 筛子每轮注入点：`runPwSieve` 把 input.verdicts 放进提示词「相关金子墓碑」段时记一行曝光（surface=`sieve`，带 run_id） |
| `src/pw-miner.ts` | 捞料来源池注入点：`runPwMiner` 把 gold/tombstone + 镜像金子放进「只读来源」时记一行曝光（surface=`miner`，带 run_id） |
| `src/pw-collab-tools.ts` | 协作台检索工具注入点：`search_verdicts` 把命中判决放进工具结果时记一行曝光（surface=`collab_tool`，actor=ai） |
| `src/main.ts` | 只加路由与 import：`POST /api/pw/verdicts/:id/promote`、`GET /api/pw/verdicts/:id/promotion`、`GET /api/pw/verdicts/exposures`、`GET /api/pw/bets/:id/precedents`、`POST /api/pw/bets/:id/precedents/dispose`（不改既有路由行为） |
| `src/pw-closed-loop.test.ts` | **新增**：19 条测试（晋级链/先例召回口径/处置校验/激活闸门/曝光流水/筛子与捞料注入点集成） |
| `package.json` | test 脚本登记 `src/pw-closed-loop.test.ts` |
| `src/selfcheck.ts`、`src/card-trash.test.ts` | pt_schema 版本断言 4→5（简报「版本号按现有迁移惯例 +1」的直接必然；断言仍在验证旧库升级路径无损） |

## 测试结果（官方 Node v24.18.0，`PATH="$HOME/.local/node/bin:$PATH"`）

- `npm test`：**419 tests，419 pass，0 fail**（基线 400 + 新增 19）
- `npm run selfcheck`：`selfcheck: ok`（旧库 v1→v5 无损升级断言通过）
- `npm run verify`（test + selfcheck + 前端 build）：**exit 0 全绿**

## 端点契约与真实 curl 样例

> 写演示全部走隔离实例：`/tmp/pw23-demo-data`（独立数据目录，`127.0.0.1:4398`，演示后已停并弃置）。生产后端 `127.0.0.1:4317` 已 `launchctl kickstart -k` 重启加载新代码，真库只做了只读 GET（三张新表已在真库建好且零数据，pt_schema v5）。以下响应为真实 HTTP 往返原文。

### 1. 判决晋级 `POST /api/pw/verdicts/:id/promote`（decided_by=human 写死，DB 约束兜底）

```bash
curl -s -X POST http://127.0.0.1:4398/api/pw/verdicts/v-gold/promote \
  -H 'content-type: application/json' \
  -d '{"level":"warning","scope":"直播切片类选题","reviewBy":"2026-09-01","reason":"影响后续切片选题取舍"}'
```

```json
{"id":"6c369a07-6a0d-489e-bb6a-6a646d1fb06c","verdict_id":"v-gold","level":"warning","scope":"直播切片类选题","review_by":"2026-09-01","reason":"影响后续切片选题取舍","status":"active","superseded_by":null,"decided_by":"human","created_at":"2026-08-13T23:29:35.784Z"}
```

再晋一次级 → 旧的置 superseded 并接链：

```bash
curl -s -X POST http://127.0.0.1:4398/api/pw/verdicts/v-gold/promote \
  -H 'content-type: application/json' -d '{"level":"hard_constraint","scope":"所有直播切片","reason":"升级为硬约束"}'
```

```json
{"id":"74bad460-a8a6-4ff1-b385-170e129d7e7b","verdict_id":"v-gold","level":"hard_constraint","scope":"所有直播切片","review_by":null,"reason":"升级为硬约束","status":"active","superseded_by":null,"decided_by":"human","created_at":"2026-08-13T23:29:35.802Z"}
```

`GET /api/pw/verdicts/:id/promotion` → 当前 active（此时为 hard_constraint）；无晋级返回 `null`。

### 2. 相关先例召回 `GET /api/pw/bets/:id/precedents`（按适用匹配，不按新近度）

```bash
curl -s http://127.0.0.1:4398/api/pw/bets/bet-draft/precedents
```

```json
{"items":[{"verdictId":"v-gold","outcome":"gold","text":"播放量是直播切片的核心指标，达标才算数","source":"own","promotion":{"level":"hard_constraint","scope":"所有直播切片"},"matchReason":"标题词词面重叠：直播切片试水（重叠：直播、播切、切片）；指标词词面重叠：三期平均播放量（重叠：播放、放量）；适用范围词面重叠：直播切片试水（重叠：直播、播切、切片）"},{"verdictId":"m-mirror","outcome":"gold","text":"播放量不达标的切片选题不该再做","source":"mirror","promotion":null,"matchReason":"指标词词面重叠：三期平均播放量（重叠：播放、放量）"},{"verdictId":"v-tomb","outcome":"tomb","text":"直播切片没人看，完整教程才有市场","source":"own","promotion":null,"matchReason":"标题词词面重叠：直播切片试水（重叠：直播、播切、切片）"}]}
```

### 3. 先例处置 `POST /api/pw/bets/:id/precedents/dispose`（overridden 无 reason → 400）

```bash
curl -s -X POST http://127.0.0.1:4398/api/pw/bets/bet-draft/precedents/dispose \
  -H 'content-type: application/json' \
  -d '{"dispositions":[{"verdictId":"v-gold","promotionId":"74bad460-a8a6-4ff1-b385-170e129d7e7b","disposition":"adopted","reason":"采纳为硬约束"},{"verdictId":"m-mirror","disposition":"distinguished","reason":"镜像金子与本地判例口径不同"},{"verdictId":"v-tomb","disposition":"overridden","reason":"旧判例已过时"}]}'
```

```json
{"dispositions":[{"id":"73568587-f9fe-4338-988b-bbd5912ab7b5","bet_id":"bet-draft","verdict_id":"v-gold","promotion_id":"74bad460-a8a6-4ff1-b385-170e129d7e7b","disposition":"adopted","reason":"采纳为硬约束","created_at":"2026-08-13T23:29:47.312Z"},{"id":"aac947bc-a824-4980-9d0a-f44269bbe28c","bet_id":"bet-draft","verdict_id":"m-mirror","promotion_id":null,"disposition":"distinguished","reason":"镜像金子与本地判例口径不同","created_at":"2026-08-13T23:29:47.313Z"},{"id":"c6bd8e91-346e-4885-aa52-fcd5a6778132","bet_id":"bet-draft","verdict_id":"v-tomb","promotion_id":null,"disposition":"overridden","reason":"旧判例已过时","created_at":"2026-08-13T23:29:47.313Z"}]}
```

```bash
curl -s -w '\nHTTP %{http_code}\n' -X POST http://127.0.0.1:4398/api/pw/bets/bet-draft/precedents/dispose \
  -H 'content-type: application/json' -d '{"dispositions":[{"verdictId":"v-gold","disposition":"overridden"}]}'
# → {"error":"overridden 处置必须带 reason"} HTTP 400
```

### 4. 激活联动闸门（先例未处置 → 409 + 清单；处置完 → 放行）

```bash
curl -s -w '\nHTTP %{http_code}\n' -X POST http://127.0.0.1:4398/api/pw/bets/bet-draft/activate \
  -H 'content-type: application/json' -d '{}'
```

```json
{"error":"存在未处置的先例判决，请先处置","details":{"undisposed":[{"verdictId":"v-gold","outcome":"gold","text":"播放量是直播切片的核心指标，达标才算数","source":"own","promotion":{"level":"hard_constraint","scope":"所有直播切片"},"matchReason":"…"},{"verdictId":"m-mirror","outcome":"gold","text":"播放量不达标的切片选题不该再做","source":"mirror","promotion":null,"matchReason":"…"},{"verdictId":"v-tomb","outcome":"tomb","text":"直播切片没人看，完整教程才有市场","source":"own","promotion":null,"matchReason":"…"}],"total":3}}
HTTP 409
```

处置全部三条后再激活 → `HTTP 200`，押注 `draft → pending`（响应带回 preflight 提示，`data_source=needs_human` 手动录入源不拦）。

### 5. 曝光流水 `GET /api/pw/verdicts/exposures?verdictId=...`（审计）

```bash
curl -s "http://127.0.0.1:4398/api/pw/verdicts/exposures?verdictId=v-gold"
```

```json
{"exposures":[{"id":"f176d702-8883-4067-b8a2-ae5376ed0995","surface":"activation","betId":"bet-draft","verdictIds":["v-gold","m-mirror","v-tomb"],"actor":"system","runId":null,"createdAt":"2026-08-13T23:29:41.459Z"},{"id":"718d3726-2f8c-4475-8ba4-d7e511eb785e","surface":"activation","betId":"bet-draft","verdictIds":["v-gold","m-mirror","v-tomb"],"actor":"system","runId":null,"createdAt":"2026-08-13T23:29:47.327Z"}]}
```

（两次 activation 曝光 = 第一次 409 拦下、第二次放行，各记一次；缺 `verdictId` → `{"error":"verdictId 必填"} HTTP 400`。）

### 生产 4317 只读验证（重启后，真库零写入）

```text
GET /api/pw/verdicts/663a9496-…/promotion    → null  HTTP 200
GET /api/pw/bets/cbd6791a-…/precedents       → {"items":[]}  HTTP 200（该押注无相关先例，宁缺毋滥返回空）
GET /api/pw/verdicts/exposures?verdictId=…   → {"exposures":[]}  HTTP 200
GET /api/pw/bets/ledger                      → 6 行，maturity 分布与重启前一致（阶段 1 无回归）
POST /api/pw/bets/…/activate/preflight       → 只读预检正常，草稿仍 draft
```

## 注入点清单（代码核实，报告列全）

简报要求「注入点清单先在代码里核实，报告里列全」。逐处核实结果（判决进 AI/人上下文的全部现有点）：

| # | 注入点 | 位置 | 打点 |
|---|---|---|---|
| 1 | 协作台 §N 注入（装配的 golds+tombs 进 system prompt） | `src/pw-collab.ts` `runCollabTurn` | ✅ surface=`collab`，actor=system |
| 2 | 筛子每轮注入（buildSieveInput 判决进「相关金子墓碑」段） | `src/pw-sieve.ts` `runPwSieve` | ✅ surface=`sieve`，actor=system，run_id |
| 3 | 捞料来源池（pw_verdicts gold/tomb + 纸桌镜像金子进「只读来源」） | `src/pw-miner.ts` `runPwMiner`（`collectSources`） | ✅ surface=`miner`，actor=system，run_id |
| 4 | 协作台检索工具 search_verdicts（模型主动检索命中判决进工具结果） | `src/pw-collab-tools.ts` | ✅ surface=`collab_tool`，actor=ai（schema actor 枚举 system/ai 的 ai 语义=模型触发） |
| 5 | 激活闸门先例摆出（激活时把相关先例摆到人面前） | `src/pw-bet-gate.ts` `activatePwBet` | ✅ surface=`activation`，actor=system |

复核后**不打点**的（说明原因，防验收误判漏打）：

- `src/pw-verdict-refs.ts`：是**引用落库**（模型 §N 标注出现后的事后记账，回答「用没用过」），不是注入点（回答「有没有被摆过」）；注入在 pw-collab.ts 已打点，二者职责分离。
- `GET /api/pw/collab/:id/context` 与 `GET /api/pw/bets/:id/context`（`buildCollabContext`/`assembleJudgmentContext` 直读）：只读预览/回显，不注入 AI 上下文，不打点（避免把「人翻看」误记为「AI 曝光」）。
- 纸桌侧 `src/engine.ts` `verdictInjectionBlock`：注入的是纸桌 `pt_verdicts` 判决（探索侧），非镇纸 `pw_verdicts`，不在本表口径内（镜像进 `pw_gold_mirror` 后由 #1/#3 覆盖）。

## 口径与边界（决策记录）

1. **晋级链语义**：任何新晋级（含 `case_only`）都会把同判决既有 active 置 superseded 并接链；`case_only` 行 status 仍为 `active`（语义=「当前状态：人看过、决定不晋级」），GET 返回它。`expired` 状态本期无自动过期机制（预留）。
2. **先例召回口径**（写死在模块注释）：金子墓碑库 = own（pw_verdicts gold/tomb）+ 纸桌镜像金子（pw_gold_mirror）；匹配依据 = 押注的标题词/指标词/来源词与判决正文或 active 晋级适用范围文本的重叠。匹配粒度：强命中=关键词整词逐字出现；词面重叠=中文短语在对方文本 ≥2 个连续双字 shingle 重叠（如「直播切片试水」vs「直播切片比教程更吸引人」重叠 直播/播切/切片）；纯字母数字词只认整词。至少 1 个关键词命中才召回，无相关返回空数组（宁缺毋滥）。排序按命中权重降序（强 2 分/弱 1 分，适用优先不按新近度），同分按 verdictId 稳定。
3. **激活闸门位置**：只在 `POST /api/pw/bets/:id/activate` 强制（preflight 通过后再查）；`POST /api/pw/drafts/:id/confirm` 与协作台 AI `confirm_bet_draft` 未动（简报明确「协作台 AI confirm_bet_draft 是否接入闸门仍是用户挂起项，本期不接」）。
4. **处置语义**：先例「已处置」= 该押注对该判决存在任意一条处置行（不限定 promotion_id）；允许多条处置行留历史。`overridden` 必填 reason，其余 disposition 的 reason 可选（自由备注）。
5. **曝光语义**：`actor=system`=系统自动注入（协作台/筛子/捞料/激活），`actor=ai`=模型工具触发（search_verdicts）；一次注入写一行，verdict_ids_json 存本次放进上下文的全部判决 id；空数组不落行。查询用 `json_each` 精确匹配 id（不做 LIKE 模糊）。
6. **自足建表**：三张表 DDL 按简报进 `src/data.ts`（正式表真值源）；模块内另带逐字相同的幂等 ensure（测试/夹具缺表自愈，照 `recordPwRecallEvent` 先例），生产 openDataStore 建表后为零成本 no-op。
7. **版本断言同步**：selfcheck/card-trash 的 pt_schema 断言 4→5 是「版本号按迁移惯例 +1」的直接必然（断言仍在验证旧库 v1/v3 → v5 无损升级路径），不是改检查放水。

## 守门自查

- **守门①（权限与状态机）**：未改 main.ts 路由权限段（只新增路由）；未改 pw-collab.ts 写工具纪律/铸币纪律（COLLAB_SYSTEM_PROMPT 店规段一字未动）；未改 settle_bet / confirm_bet_draft / 审批流函数本体；未改「人发话才执行」工具定义（search_verdicts 是 allow 只读工具，仅加曝光打点）。`activatePwBet` 属简报 21 新建模块，简报 23 明确授权在其上加联动闸门。
- **守门②（schema）**：授权范围=且仅三张新表（新增，未改任何旧表结构）；pt_schema v4→v5（简报明确 +1）。
- **守门③（部署/常驻）**：未改 launchd plist；仅按简报指示 `launchctl kickstart -k` 重启生效。
- **守门④（验收检查定义）**：未改任何验收判定标准；selfcheck 版本断言同步见「口径 7」。
- **其他纪律**：`frontend/` 未动（verify 的 build 重建 public/assets，与阶段 1 同源）；不 commit、不 push；**真库只读**——写演示全走 `/tmp/pw23-demo-data` 隔离实例（已停），生产 4317 只执行只读 GET；Memos 库未碰。

## 复验记录（dsh-cc 第二遍，2026-08-14 同日补跑）

执行方按简报要求独立复验一遍，全部通过：

- `npm test`（官方 Node v24.18.0）：**419 tests, 419 pass, 0 fail**（与首遍一致）。
- `npm run selfcheck`：`selfcheck: ok`（旧库 v1→v5 无损升级断言通过）。
- 隔离实例全端点重跑（`/tmp/pw23-demo-check` 独立数据目录、临时端口，跑完已停并弃置）：promote 两次接 superseded 链、GET promotion、precedents 三条召回、overridden 无 reason→400、激活 409+未处置清单、处置完激活 200（draft→pending）、曝光流水两行 activation、缺 verdictId→400、无关押注→空数组、404 路径——真实 HTTP 往返全部符合契约。
- 生产 4317 只读复验（真库零写入）：pt_schema v5、三新表在位且 0 行（promotions/dispositions/exposures 均 0）；`GET promotion` → `null`；`GET exposures` → 空；**修正首遍说法**：真库 14 笔押注中 3 笔带相关先例（`92ee0d45…`→2 条、`7a403c01…`→1 条、`1ba1711d…`→1 条，均为真实词面匹配，含 own 墓碑与镜像金子），11 笔空——召回在真库上真实生效，宁缺毋滥口径成立（无相关不凑数）。这 3 笔若被激活会先被闸门拦下（设计如此），本期不做任何写真库的写演示。

## 交接提示（给 codex 验收）

- 浏览器/接口验收：三张新表 + 五端点契约见上；激活闸门写态请在隔离实例验证（`PAPERTABLE_DATA_DIR=/tmp/... node src/main.ts` 换端口起），**不要在生产激活真实押注**（写真库）。
- 已确认真库（4317 重启后）：pt_schema v5、三新表存在且 0 行；召回在真库上真实生效（3 笔押注带相关先例，见复验记录）。
- 发现问题以简报形式回，我按问题回路修。
