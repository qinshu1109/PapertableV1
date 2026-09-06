# TASK-PW-35 收工小结

- 日期：2026-08-08
- 批次：TASK-PW-30-batch（决策层 MVP 落地批）第六刀
- 依赖：PW-30/31/33/34——均已验收（本刀只读它们的留痕，不改任何既有文件）

## 这刀是干什么的（白话）

一天忙完点一下「收工小结」，它替你回答两句话：**今天我定了什么**——挑了几张候选卡（哪几张）、否了几张（理由）、转正了几张押注、定稿了几份草案、AI 自动起草了几批；**AI 替我办了几件事**——每笔代办几点几分、办了什么、依据你说的哪句话，缺指令的会老实标出来。

另给一个「导出文本」，一键复制就能发到 agent 窗口存档，不用你手写日报。

## 怎么算好（白话）

弹层里每个数字都能和当天的事件流水一笔一笔对上——多一笔不行，少一笔也不行；一件事在两个栏目里重复出现不行（同一动作只归一档）；今天啥也没干就老老实实显示零，不硬凑。屏是 PW-36 的事，这刀只出数据和文本。

---

以下给干活的看，可以跳过。

## 四字段

- 主需求域：内容生产
- 业务接口：提供引用记录（读，本刀不直接消费，经 pw_runs 留痕间接覆盖）；AI 代办账本（读，PW-23/24 既有）
- 数据真值源：**无新表**；只读聚合 `pw_runs`（全 kind）+ `pw_bets`（联查标题）+ `pw_sieve_cards`（联查引文）+ `pw_content_drafts`（联查 route/标题）
- 质量约束与验收终态：「今天定了什么 + AI 代办几件」与当日事件逐笔对得上（已知事件集断言）；导出纯文本；空日正确零态；verify 全绿

## 1. 背景与既有事实（已核验，勿重复调查）

- `pw_runs` 列：kind（manual_event/ai_draft/ai_exec/sync/sieve/ai_auto）、event_type（19 枚举含 create/confirm/reject/draft/settle/sync 相关等）、actor（human/ai/system）、payload_json、bet_id、created_at（TEXT ISO UTC）、instruction_text / instruction_message_id（ai_exec 两列）。
- **双记账陷阱（必须处理）**：REST 路由层 `emitPwEvent`（main.ts:1086）会再写一笔 actor=human 的 confirm（payload 形如 `{draftHash}` 或 `{title, source}`）——与本刀有关的只有 confirm：押注草稿 confirm 的内部留痕 payload 是 `{draftId, betId, edits}`，路由层再补一笔 `{draftHash}`。**分类规则靠 payload 键区分，天然去重**（见 §3）。
- 挑卡留痕（PW-19/24）：confirm 且 payload `{cardId, betId, overrides}`——overrides 非空对象 = 挑改。
- 定稿留痕（PW-33）：confirm 且 payload `{draftId, betId, artifactId}`。
- 否卡：reject 且 payload 含 `cardId`（+reason）；否草案（PW-31）：reject 且 payload 含 `draftId`（+reason）。
- 起草批次（PW-32/33）：kind='ai_draft' event_type='draft'，payload `{betId, batchId, routes, created, dropped, model, trigger, error?}`。
- AI 代办：kind='ai_exec'（instruction_text 可能 NULL——旧行/缺指令，list_my_actions 标「无引用！」）；自主档 kind='ai_auto'（标「自主」）。参照 pw-collab-tools.ts:1040-1066 的渲染口径（本刀窗口化自写 SQL，不改该文件）。
- node24 TS 剥离器不认跨行 `as` 断言——一律写同行。

## 2. 交付物

| 文件 | 改动 |
|---|---|
| `src/pw-day-summary.ts` | 新建：`getPwDaySummary` + `renderPwDaySummaryText` + 类型导出 |
| `src/pw-day-summary.test.ts` | 新建：8 组测试，内存库自包含 |

**禁碰**：其余一切既有文件、`src/main.ts`（路由留 PW-36）、`package.json`（登记主代理做）、`frontend/`。不 commit。

## 3. 口径定义（规格核心，逐项可测）

**日窗口**：`options.date`（YYYY-MM-DD）按**本机本地时区**解释（后端与用户同机）：startIso=当日 00:00 本地→ISO，endIso=次日 00:00 本地→ISO；缺省=options.now（缺省当前时刻）的本地日期。非法 date 抛 400。返回带 `{date, startIso, endIso, generatedAt}`。

**事件集**：`SELECT * FROM pw_runs WHERE created_at >= startIso AND created_at < endIso ORDER BY created_at ASC, rowid ASC`（全 kind，一次查出，内存分类）。payload_json 非法 JSON 的行：跳过分类但计入「其余事件」。

**分类规则**（一行只归一档，按下列优先级命中即止）：

| 栏目 | 命中规则 | 行内容 |
|---|---|---|
| `picks` 挑卡 | confirm 且 payload.cardId | 时间、卡片引文截断 40 字（联查 pw_sieve_cards.quote_text）、→ 押注标题（联查 pw_bets）、`edited: true`（overrides 非空对象时）、actor |
| `betConfirms` 押注转正 | confirm 且（**a**）payload.draftId===payload.betId（对话/工具面账：草稿 id 即押注 id）或（**b**）payload.draftHash 且 row.bet_id 非空（REST 面路由层账，confirmPwBetDraft 自身不留痕——标题经 row.bet_id 联查）；两路互斥无双账 | 时间、押注标题、actor |
| `finalizes` 定稿 | confirm 且 payload.draftId、betId 皆 string 且 **draftId !== betId**（素材草案账；artifactId 非必要——PW-33 前旧行无此键也归此档） | 时间、草案 route + 标题（联查 pw_content_drafts）、押注标题、actor |
| `cardRejects` 否卡 | reject 且 payload.cardId | 时间、引文截断 40、reason |
| `draftRejects` 否草案 | reject 且 payload.draftId 且**无** cardId | 时间、route + 标题、reason |
| `draftRuns` 起草批次 | kind='ai_draft' 且 event_type='draft' | 时间、trigger、created、error（失败批） |
| `execActions` AI 代办 | kind='ai_exec' | 时间、event_type、对象（payload.title/betId/draftId 等首个可用键，同 list_my_actions 口径）、instruction_text 截断 60（NULL 标「无引用！」） |
| `autoActions` AI 自主 | kind='ai_auto' | 时间、event_type、对象（标「自主」） |
| `otherCount` 其余事件 | 以上皆未命中（sync/mirror/settle/settleDraftId-confirm/`{draftHash}` 路由层confirm/非法 JSON 行等） | 只计数，配一行 kind/event_type 分布摘要 |

**计数头**：`{ picks, betConfirms, finalizes, cardRejects, draftRejects, draftRunBatches, draftsCreated（批 created 求和）, execActions, autoActions, otherCount, totalEvents }`。totalEvents = 窗口内全部行数（含非法 JSON 行）——对账锚点：各栏目数 + otherCount = totalEvents（断言）。

**联查兜底**：betId/cardId/draftId 联查不到行（被删）→ 显示 id 前 8 位，不炸。

## 4. 文本导出 renderPwDaySummaryText

纯文本（非 markdown 表格），形如：

```
收工小结 2026-08-08
挑 2 · 否 1 · 押 1 · 定稿 1 · 起草 1 批（3 份）· AI 代办 2 件 · 自主 1 件

■ 挑卡（2）
  14:02 「这也太全能了吧…」→ 押注《5年153期…》
  15:40 「一个人干了一个团队的活」→ 押注《…》（挑改）

■ 押注转正（1）
  16:01 《PW-33 冒烟：押注一确认就自动起草》（AI 代办）

…（各栏目空则整栏省略）

■ AI 代办（2）
  15:59 confirm 《…》｜依据「把草稿 66b954fa 确认转正」
  16:20 edit 《…》｜依据 无引用！

另有余系统事件 3 笔（sync×2、mirror×1）。
```

空日：只输出标题行 + `今天没有协作台事件。`。

## 5. 测试清单（8 组）

1. 空日零态：全零、各栏目空数组、otherCount=0、totalEvents=0、文本含「没有」。
2. 全口径一天：按 §3 每档各种 1-2 笔（含 overrides 挑改、ai_exec 缺指令行、ai_auto 行、sync 行、非法 payload_json 行）→ 逐栏目断言条目与计数；**对账断言：各栏目和 + otherCount = totalEvents**。
3. 窗口边界：startIso 前 1 秒排除、startIso 恰含、endIso 恰排除（落次日）。
4. 去重：`{draftHash}` 路由层 confirm 不进 betConfirms（落 otherCount）；同 betId 多源 confirm 各归各档不重复。
5. exec 清单行：instruction 超 60 截断带…、NULL 标「无引用！」、ai_auto 标「自主」。
6. 文本导出：含日期头、计数行、关键条目（押注标题/引文/reason）；空栏目整栏不出现。
7. date 非法（"昨天"/"2026-13-01"）→ 400；缺省 date 用注入 now 的本地日。
8. 联查兜底：payload 指向不存在的 bet/card/draft → 显示 id 前 8 位不炸。

## 6. 验收终态（主代理执行）

- `PATH="$HOME/.local/node/bin:$PATH" npm run verify` 全绿（新测试登记后）。
- 真实库对账（主代理亲做）：跑当日 summary，totalEvents 与 `SELECT COUNT(*)` 一致，各栏目与 SQL 抽数一致。

## 7. 明确不做

- 不出 REST 路由、不碰前端（PW-36 弹层消费）。
- 不统计筛子 run 轮次/来源对比（B4 块已覆盖）。
- 不做结账判决明细栏目（落 otherCount，一批后再议）。
- 不改 list_my_actions / pw-collab-tools.ts（渲染口径参照即可，窗口化自写）。

---

## 验收记录（2026-08-08，主代理亲验，通过）

**人话三句**：收工小结能算了——今天挑了几张卡、否了什么（理由）、转正了哪张押注、定稿了哪份草案、AI 起草了几批、替你办了几件事（依据哪句话），每个数字都和当天事件流水一笔一笔对平；导出文本一键复制就能发 agent 窗口存档。屏还没有，屏是 PW-36 的事。

- 实现：DeepSeek 子代理（仅新建 pw-day-summary.ts + 测试两文件）；package.json 登记：主代理。
- verify（主代理亲跑）：**208/208 全绿**，selfcheck ok，前端 build 成功。
- 真实库对账（主代理亲做）：当日 14 笔事件，分档和 + otherCount = totalEvents 对平 ✓；空日、窗口边界、去重、文本导出均由测试覆盖。
- **复核抓到并已修的真实缺口**（子代理补丁，我复核确认）：原口径漏了两条账——①REST 面押注转正只有 `{draftHash}` 路由层账（confirmPwBetDraft 自身不留痕，已读码核实），原规则把它扔进 otherCount；②PW-33 前的素材定稿账无 artifactId 键，原规则误吞进押注转正。补丁：betConfirms 改两路（draftId===betId 或 draftHash+bet_id 列），finalizes 改 draftId!==betId（artifactId 非必要）。修后真实库重跑：押注转正正确显示《PW-33 冒烟…》、legacy 定稿归位、对账仍平。规格 §3 已同步改。
- 子代理偏差申报（复核认可）：otherDist 标签取 `kind==='manual_event' ? event_type : kind`（与规格示例逐字吻合）；actor=system 渲染「（系统）」；栏目标题自拟部分合理。
