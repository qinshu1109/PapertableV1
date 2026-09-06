# TASK-PW-25 铸币级执行工具与冲正键 · 执行规格

- 日期：2026-08-07
- 状态：**完成并验收（2026-08-07）**——DeepSeek 子代理实现，主代理复核+集成+验收。verify 138/138 全绿；真实冒烟六步全过：挑卡（锚定「就这张」）→撤销挑卡（卡回 pending）→改看结果日+起草铸金草案→「确认结账」两跳合一（草案缺省锚定当前卡，押注 settled、判决带证据、草案 approved、镜像自动同步 actor=system）→「结错了作废」（押注/判决 void、教材原文保留）→查账摆账（每笔带指令原话）。冒烟中主代理现场补三个洞：edit_bet/settle_bet 缺省锚定当前卡、装配注入当前卡 id 与状态、read_data_docs 出「证据 N」id、draft_settle 返回文本带草案 id
- 批次：`docs/TASK-PW-23-batch.md` 第三刀；依据规格 `docs/SPEC-harness-write-boundary.md` §4（铸币级）/§6（店规）/§7（指认）
- 主需求域：判断沉淀与复用
- 业务接口：登记实践执行（挑卡建押注沿用既有接口语义）
- 数据真值源：无新表；`pw-collab-tools.ts` 工具表 +6；`pw-content-bets.ts` 加 audit 参数与两个新函数；`pw-verdicts.ts` 加一个冲正函数
- 质量约束与验收终态：状态机断言（冲正前后行态、唯一索引不破）；落账带指令引用；既有测试全绿；`PATH="$HOME/.local/node/bin:$PATH" npm run verify` 全绿；**main.ts / frontend/ 零改动、不 commit**

## 〇、先读：既有事实（已核验，照此落笔）

- 工具表现状 27 个（`pwCollabTools`），本刀 +6 → **33**；`pw-collab.test.ts` 工具数断言连带更新（属必要连带）。
- `recordExecEvent(context, eventType, payload, relatedIds?, betId?)`（pw-collab-tools.ts）是 exec 统一落账口；`requireExecInstruction` 缺指令抛 500。
- 事件类型枚举已齐备，**不需要动 pw-runs.ts**：`settle`/`confirm`/`reject`/`undo`/`sieve_run` 均在 `PwEventType` 内。
- 单账原则（沿 PW-24 第〇节）：函数自记账的加**可选 audit 参数**合成一条 ai_exec；函数不自记账的由工具层调 `recordExecEvent` 记一条。
- `settlePwBet`（pw-verdicts.ts:53）自带事务，**不自记账**（记账在路由层）；内含 `canRetryAfterVoid` 通路（bet.status='void' 且无非 void 判决时可重结）——冲正后的重结语义直接复用，勿改。
- `pickPwSieveCard`/`rejectPwSieveCard`（pw-content-bets.ts:108/171）自记 manual_event/human 账——本刀加 audit 参数。
- 结账草案：`pw_settle_drafts`（pw-collab.ts），`approvePwSettleDraft`(:179) 仅改 status，不触发 settle（两跳原本分两跳，本刀合一）。

## 一、进表工具（6 exec，description 一律以「人发话才执行：」开头）

| 工具名 | policy | 实现 | 记账（event_type） |
|---|---|---|---|
| `settle_bet` {draftId, evidenceDocIds} | exec | 读 pending 结账草案→映射→`settlePwBet`→`approvePwSettleDraft`（顺序两步，见三.1） | `settle`，payload {draftId, betId, verdictId, outcome} |
| `pick_sieve_card` {cardId, overrides?} | exec | `pickPwSieveCard`（加 audit 参数，见二.1） | `confirm`，payload {cardId, betId, overrides} |
| `reject_sieve_card` {cardId, reason?} | exec | `rejectPwSieveCard`（加 audit 参数） | `reject`，payload {cardId, reason} |
| `reject_all_and_resieve` {reason?} | exec | 新函数 `rejectAllPendingPwSieveCards`（见二.2）+ `context.sieve.flushNow()` | `reject`（payload {cardIds, reason}）+ `sieve_run`（payload {runId}），两条同指令 |
| `unpick_sieve_card` {betId} | exec | 新函数 `unpickPwContentBet`（见二.3） | `undo`，payload {betId, cardId} |
| `void_settlement` {betId} | exec | 新函数 `voidPwSettlement`（见三.2，pw-verdicts.ts） | `undo`，payload {betId, verdictId} |

工具描述必须写死语义边界：
- `settle_bet`：「把已固化的结账草案一步结掉（两跳合一跳）——草案内容即结账内容；evidenceDocIds 必填（先用 read_data_docs 选定证据文档）；没有 pending 结账草案时报错并提示先用 draft_settle 起草」
- `unpick_sieve_card`：「冲正键——仅限撤销一次挑卡：生成的内容押注作废（status→void）+ 来源候选卡退回 pending，同一事务；不是通用回退」
- `void_settlement`：「冲正键——仅限作废一笔结账：判决 outcome→void（教材原文不涂改）+ 押注 settled→void，可再重结」

## 二、pw-content-bets.ts 改动

1. **audit 参数**（照 addPwVoiceItem 先例，pw-voice.ts:76）：`pickPwSieveCard(db, cardId, overrides?, audit?)` / `rejectPwSieveCard(db, cardId, reason?, audit?)`，`audit?: { actor: "ai"; instructionText: string; instructionMessageId: string }`。传入时改走 `recordPwExecEvent`（kind=ai_exec，event_type 分别为 confirm/reject，一条账）；缺省维持 PW-19 现状（manual_event/human，路由行为不破）。
2. **新函数 `rejectAllPendingPwSieveCards(db, reason?, audit?)`**：事务内把全部 pending 候选卡置 rejected（逐张 UPDATE ... WHERE status='pending'），返回被拒 cardId 数组；自记账一条（audit 走 exec/reject，缺省 manual_event/human）；0 张时正常返回空数组不报错。
3. **新函数 `unpickPwContentBet(db, betId, audit?)`**：事务内——押注必须 `kind='content'` 且 `status='pending'` 且 `source_card_id` 非空（否则 409）；押注 status→'void'；来源候选卡必须 picked/edited（否则 409）→ 'pending'；自记账一条（event_type='undo'）。**这是候选卡唯一回退口**（常规回退 revert_sieve_card 仍 deny）。

## 三、settle 与结账作废细节

1. `settle_bet` 流程：`requireExecInstruction` → 读草案（`getPwSettleDraft` 语义，不存在 404 / 非 pending 409）→ `recommendation='wait'` 抛 400「wait 草案不可结账」→ 映射 settle_gold→gold（lesson 取草案，缺则 400）/ settle_tomb→tomb（cause_of_death 同理）→ `settlePwBet(db, draft.bet_id, { outcome, lesson, causeOfDeath, evidenceDocIds })`（其自带事务；未到结账日/状态不对的既有报错原样抛出）→ `approvePwSettleDraft(db, draftId)` → `recordExecEvent('settle', ...)`（betId 用 draft.bet_id）。**顺序两步非单事务**（settlePwBet 内部已 BEGIN/COMMIT，不可嵌套）——已知偏差，落账在最后保证「成了才有账」。
2. `voidPwSettlement(db, betId, audit?)`（pw-verdicts.ts 新函数，**不改 settlePwBet**）：事务内——押注 status 必须 'settled'（否则 409）；其非 void 判决（唯一索引保证至多一条）outcome→'void'（lesson/cause_of_death 原文保留）；押注 status→'void'、settled_verdict_id 保留（历史指针不抹）；自记账一条（event_type='undo'）。重结走既有 `canRetryAfterVoid`，勿加新逻辑。

## 四、deny 名单与提示词

1. `pwCollabDeniedToolNames`：**移出** `settle_bet`、`pick_sieve_card`、`reject_sieve_card`、`create_content_bet`（挑卡带 overrides 即改挑，无独立工具）；**保留** `mirror_golds`（PW-26）与常驻 7 个（delete_bet/rewrite_verdict/revert_sieve_card/reset_sieve_watermark/delete_collab_message/force_mirror_refresh/clear_risk_events）。`revert_sieve_card` 注释补一句「常规回退仍 deny，unpick 冲正键是唯一回退口」。
2. `pw-collab.ts` system prompt 两处旧措辞替换（PW-24 特意留到本刀）：
   - 旧：「候选卡只是草稿——挑/改/否只能人做，你没有这个工具。」
   - 新：「候选卡的挑/改/否、全否重筛由人发话、你执行（pick_sieve_card / reject_sieve_card / reject_all_and_resieve）；人没发话你不主动挑否。」
   - 旧（GLOBAL_PROMPT_NOTE）：「挑/改/否仍然只能人做——全局对话里你同样没有这个工具。」
   - 新：「全局对话里同样可以按人指令执行挑/否/结账/冲正——先指认对象（哪张卡/哪笔结账），再执行。」
   - 追加一条：「铸币纪律：结账（settle_bet）按已固化的结账草案一步结掉，草案内容即结账内容，不临场改写；撤销挑卡（unpick_sieve_card）与结账作废（void_settlement）是仅有的两个冲正键，只在用户明确说撤销/作废时使用。」
   - `pw-collab.test.ts` 旧措辞断言同步替换（必要连带）。

## 五、测试（新文件 `src/pw-mint-undo.test.ts`，登记 package.json）

1. 6 工具逐个：mock context（含 instruction，sieve 用 mock notifier）调用 → 业务行正确 + pw_runs 恰一条 ai_exec（event_type/指令两列/payload 关键字段对）；缺 instruction 抛错（每工具一次）。
2. settle_bet 状态机：无草案 409 / wait 草案 400 / gold 缺 lesson 400 / 未到结账日错误透传 / 成功后草案 approved + 押注 settled + 判决行正确 + evidenceDocIds 进判决。
3. unpick 状态机：非 content 押注 409 / 非 pending 409 / 候选卡非 picked/edited 409 / 成功路径（押注 void、卡回 pending、undo 账）；**唯一索引不破**：撤销后可对同卡再 pick。
4. void_settlement：非 settled 409 / 成功路径（判决 outcome=void 且原文保留、押注 void）+ **可重结断言**（重结后新判决非 void、押注 settled）。
5. reject_all_and_resieve：3 张 pending 全拒 + flushNow 被调 + 两条 ai_exec（reject+sieve_run 同指令引用）；0 张 pending 时不报错、只落 sieve_run 账。
6. deny 名单新集逐字断言 + 工具表 33 计数 + prompt 新旧措辞断言（新三条包含、旧两句不存在）。
7. PW-19 既有测试（pw-content-bets.test.ts）缺省路径（无 audit）行为不破。

## 六、验收硬门（主代理亲自）

1. verify 全绿（含新测试）；`node --test src/pw-mint-undo.test.ts` 单绿。
2. 真实对话冒烟（重启后端，fresh 单卡会话）：「就这张，挑了」→ pick+落账；「刚才那张挑错了，撤销」→ unpick+落账+卡回 pending；「起草结账建议」→ draft_settle；「确认结账」→ settle_bet 一步结掉（押注 settled、草案 approved、判决+证据链正确）；「结错了，作废」→ void_settlement（押注 void、判决 void、原文还在）；「你最近代办了什么」→ 五笔账全带指令原话。
3. 对照：只读提问一轮，零 exec 调用。
4. main.ts / frontend/ 零改动确认（mtime + grep）。

## 七、明确不做

fetch_corpus 自主化、镜像/分拣自动（PW-26）；菜号牌对齐与监督断言（PW-27）；审计 UI；前端任何改动（如需新 SSE 事件或工具标签，只报需求，主代理处理）。
