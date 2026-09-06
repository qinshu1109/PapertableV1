# TASK-PW-24 人发话写工具进表（非铸币批）· 执行规格

- 日期：2026-08-06
- 状态：**完成并验收（2026-08-07）**——DeepSeek 子代理实现；主代理复跑 verify 120/120 全绿；真实对话冒烟六步：起草→（全局会话历史锚定拒绝，已记录）→ fresh 会话明确指令 confirm_bet_draft 一发即中（draft→pending）→ ai_exec 账带指令原话+消息 id → list_my_actions 摆账（含「无引用！」标记）→ 对照组只读零 exec。主代理集成：main.ts 一行 sieve 注入、Collab.tsx 工具标签 10 个、旧话术清障 5 处（draft_bet/draft_settle 描述与返回「只能由人完成」与新模型冲突，冒烟暴露后修正）
- 批次：`docs/TASK-PW-23-batch.md` 第二刀；依据规格 `docs/SPEC-harness-write-boundary.md` §3（人发话 AI 干档）/§6（店规）/§7（指认）
- 主需求域：判断沉淀与复用
- 业务接口：无（域内工具表扩展；供协作台单卡对话与全局对话消费）
- 数据真值源：无新表；`pw-collab-tools.ts` 工具表扩容；`pw-bets.ts` 新增编辑函数
- 质量约束与验收终态：exec 工具落账必带指令引用（断言）；deny 新集断言；店规 prompt 断言；既有测试全绿；`PATH="$HOME/.local/node/bin:$PATH" npm run verify` 全绿；**main.ts / frontend/ 零改动、不 commit**

## 〇、单账原则（先读这条，避免双记账）

PW-23 给一批函数做了模块内记账（manual_event，actor 定死 human/system）。exec 工具调用这些函数时**不许双账**：

- 函数自记机制账且会被 exec 调用 → 给函数加**可选 audit 参数**（见第三节），AI 触发时合成**一条** ai_exec 账（kind=ai_exec、带指令引用），不再记 manual_event
- 函数不自记账（记账在路由层，如 confirm/attach）→ exec 工具直接调 recordPwExecEvent 记一条
- 函数记的是机制账且语义独立（runPwSieve 的 sieve_run/system）→ 机制账照记，exec 工具**另记一条指令账**（两条不同 kind，语义不同：「筛子跑了」vs「AI 按哪句话让筛子跑」）

## 一、exec 政策档（`src/pw-collab-tools.ts`）

- `CollabToolPolicy` 新增 `"exec"`。语义：写动作，**仅在用户当轮明确指令后调用**；每个 exec 工具的 description 必须以「人发话才执行：」开头写明动作与后果。
- `CollabToolContext` 扩展：`instruction?: { text: string; messageId: string }`。`runCollabTurn`（pw-collab.ts）把**当轮用户消息**（落库后的 id 与原文）注入；exec 工具执行时缺 instruction 即抛 500（不该发生，发生了说明装配漏了）。
- 工具表计数变化：17 → **27**（+9 exec +1 只读查账）。`pw-collab.test.ts` 工具数断言连带更新（属必要连带）。

## 二、进表工具（9 exec + 1 allow）

| 工具名 | policy | 实现 | 记账 |
|---|---|---|---|
| `confirm_bet_draft` {draftId, edits?} | exec | confirmPwBetDraft（pw-drafts.ts:224） | exec(confirm)，payload {draftId, betId, edits} |
| `reject_bet_draft` {draftId, reason?} | exec | rejectPwBetDraft（pw-drafts.ts:262） | exec(reject) |
| `create_bet` {title, thesis, metric?, metricTarget?, confidence?, dataSourcePlan?, checkoutDate?} | exec | createPwBet（pw-bets.ts:88；三行不齐落 draft 属既有语义，工具描述写明） | exec(create) |
| `edit_bet` {betId, fields:{title?, thesis?, metric?, metricTarget?, confidence?, checkoutDate?}} | exec | **新函数** updatePwBetFields（pw-bets.ts）：仅 draft/pending 态可编辑，settled/void → 409；只更新传入字段 | exec(edit)，payload 带改动字段名 |
| `freeze_data_doc` {docId} | exec | freezePwDataDoc（pw-data-docs.ts:121，既有无通路函数） | exec(freeze) |
| `run_sieve` {} | exec | flushNow（pw-sieve.ts:927；队列空返回 runId:null 属既有语义） | exec(sieve_run)，payload 带 flush 结果；机制账另记属设计 |
| `add_voice` {artifactId, content, platform} | exec | addPwVoiceItem（pw-voice.ts:68，**加 audit 参数**，见三节） | 合成一条 exec(voice) |
| `attach_artifact` {betId, type, platform, url?, title?} | exec | attachPwArtifact（pw-artifacts.ts:47） | exec(attach) |
| `detach_artifact` {artifactId} | exec | detachPwArtifact（pw-artifacts.ts:80） | exec(attach)，payload {detached:true}（沿用路由层语义） |
| `list_my_actions` {limit?} | **allow 只读** | listPwRuns（kind=ai_exec/ai_draft，倒序，默认 20）——回答「你最近代办了什么」：每行 时间/动作/对象/依据指令（instruction_text 截 60 字，缺指令标「无引用！」） | 不记（只读） |

## 三、audit 参数改造（仅 addPwVoiceItem 本刀需要）

```ts
addPwVoiceItem(db, input, audit?: { actor: "ai"; instructionText: string; instructionMessageId: string })
```

- 缺省：PW-23 现状（manual_event/human）
- 传入：改走 recordPwExecEvent（kind=ai_exec，event_type='voice'，一条账）
- PW-26 会给 corpus/mirror/classify 加同款参数，本刀不动它们

## 四、deny 名单缩减（`pwCollabDeniedToolNames`）

- **移出**：`create_pending_bet`（本刀 create_bet/confirm_bet_draft 进表）
- **保留到后续刀**：`settle_bet`、`pick_sieve_card`、`reject_sieve_card`、`create_content_bet`（PW-25）；`mirror_golds`（PW-26 自主化，不做工具）
- **新增常驻 deny**（「AI 默认不开·人留后门」集）：`delete_bet`、`rewrite_verdict`、`revert_sieve_card`、`reset_sieve_watermark`、`delete_collab_message`、`force_mirror_refresh`、`clear_risk_events`
- 测试断言同步：新名单逐字断言不存在于工具表

## 五、店规提示词 v1（`pw-collab.ts` system prompt 追加）

原文照录（测试做包含断言）：

```
写工具纪律：凡 description 以「人发话才执行」开头的工具，只有在用户当轮消息明确提出该动作时才允许调用；用户没说的写入一律不做，宁可反问。
指认规矩：摆对象时给短标签（证据 N / 注 N / 草稿 A / BV 号）；用户说「就这张」时锚定当前话题对象；指认明确就直接执行，不复述不二次确认；指认含糊必须反问，绝不猜。
查账：用户问「你最近代办了什么」时用 list_my_actions 如实摆出，包括依据的是哪句话。
```

既有纪律（逐字引用、候选卡只读引用、无转卡工具）原样保留——注意：「无转卡工具」措辞在 PW-25 才改（挑否卡进表），本刀不动该条。

## 六、测试（新文件 `src/pw-exec-tools.test.ts`，登记 package.json）

1. 9 个 exec 工具逐个：mock context（含 instruction）调用 → 业务行正确 + pw_runs 恰一条 ai_exec（event_type 对、instruction 两列对、payload 关键字段对）
2. exec 工具缺 instruction → 抛错（每工具断言一次）
3. edit_bet 状态机：draft/pending 可改、settled/void 409、只改传入字段
4. add_voice audit 参数：传 ai → 单条 exec(voice) 账且无 manual_event 双账；缺省 → 维持 human 账（PW-23 行为不破）
5. deny 名单新集断言 + 工具表 27 计数 + 9 exec policy 断言
6. 店规 prompt 三段包含断言；「无转卡工具」措辞仍在
7. list_my_actions：含 instruction 截断与「无引用！」标记

## 七、验收硬门（主代理亲自）

1. verify 全绿（含新测试）；`node --test src/pw-exec-tools.test.ts` 单绿
2. 真实对话冒烟（重启后端后 SSE）：对全局会话说「把证据 1 挑了」**不响应本刀**（PW-25）；本刀冒烟：让 AI 起草押注→我说「确认这份草稿」→ AI 调 confirm_bet_draft 转正+落账；再问「你最近代办了什么」→ list_my_actions 摆出依据指令
3. 未发话对照：只打招呼，断言本轮零 exec 工具调用
4. main.ts / frontend/ 零改动确认（mtime + grep）

## 八、明确不做

铸币级工具与冲正键（PW-25）；fetch_corpus 自主化、镜像/分拣自动（PW-26）；菜号牌前端对齐与监督断言脚本（PW-27）；前端任何改动（若 exec 工具事件流需前端兼容，只报需求不改代码，主代理处理）。
