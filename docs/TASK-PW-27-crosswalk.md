# TASK-PW-27 规格对照回勾表（监督侧 · 第一~三节）

- 日期：2026-08-07
- 依据规格：`docs/SPEC-harness-write-boundary.md`（2026-08-06 用户验收通过）全部小节
- 范围：本回勾表由 DeepSeek 子代理产出，覆盖 TASK-PW-27 执行规格第一~三节（监督模块 / 测试与脚本 / 回勾表）。
  第四节菜号牌统一、第五节连带测试、第六节验收为**主会话**范围，涉及处标注「去向：主会话第四节」。
- 证据约定：行号以本回勾表成稿时工作区代码为准；测试证据给测试名（package.json test 全量登记，`npm test` 全绿）。

## 逐节回勾表

| 规格小节 | 要旨 | 落点 | 证据 |
|---|---|---|---|
| §1 核心模型（:7-12） | 对话即控制台：AI 工具全开、决策权在人；铸币权从「能力级 deny」升级为「发动权在人」 | `src/pw-collab-tools.ts` exec 档写工具（description 以「人发话才执行：」开头，15 个）+ `src/pw-runs.ts` ai_exec 指令两列 + `src/pw-collab.ts` 店规提示词 | `pw-collab.ts:220` 店规段①「写工具纪律」；`pw-collab-tools.ts:754/1134/1216/1241` 等工具 description；`pw-runs.ts:273` recordPwExecEvent 强制指令两列；`pw-supervision.ts:41` 擅自发动断言兜底 |
| §2 长期调试原则（:14-17） | 分档表为 v1 默认值，修订权在人；「不开放给 AI」保留人工干预空间 | 分档表固化在规格 §3 与工具 description；人工后路路由保留在 `src/main.ts` | `pw-collab-tools.ts:757-1244` 各 exec 工具；`main.ts:638` 手动金子镜像、`:675` 手工分拣、`:819` 人工授权语料（后路全保留）；修订权在人 = 无自动修订机制（条款本身承载） |
| §3 写动作分档表 · AI 自主 5 项（:21-29） | 起草押注/结账、筛子 run、金子镜像同步、LLM 声音分拣、语料抓取（先抓后审 + 行为限速） | 各模块既有/新增机制 + `pw-collab.ts` 限速店规 | `pw-collab-tools.ts:641` draft_bet、`:686` draft_settle；`:587` fetch_corpus（自主直抓）；`src/pw-corpus-fetch-runner.ts:32` triggerPwCorpusFetch（单飞/降级）；`src/pw-collab-tools.ts:604` 自主抓取落 ai_auto 账；`pw-collab.ts:218` 限速店规（read_connections 看风控、撞墙 needs_human 交人）；`main.ts:164` 金子镜像 actor=system；`src/pw-voice.ts:127` 自动分拣挂钩；`main.ts:171` 接线 |
| §3 · 人发话 AI 干（:31-33） | 确认/驳回草稿、结账（两跳合一跳）、直接建押注、挑/改/否卡、全否重筛、录声音、挂摘产出物、补筛、冻结、编辑押注 | `src/pw-collab-tools.ts` 15 个 exec 工具统一守门 + 落 ai_exec 账 | `pw-collab-tools.ts:134` requireExecInstruction（缺指令 500）、`:152` recordExecEvent 统一落账；工具：`:754` confirm_bet_draft、`:1055` settle_bet（两跳合一跳）、`:817` 直接建押注、`:1134` pick、`:1162` reject、`:1184` reject_all_and_resieve、`:925` 录声音、`:959` 挂产出物、`:992` 摘产出物、`:897` 手动补筛、`:878` 冻结、`:853` 编辑 |
| §3 · 不进对话（:35-37） | 抓取器与同步状态回报、协作消息记录、审计落账、筛子水位推进、平台连接登记与状态变更 | `src/pw-runs.ts` system 账 + 各模块内自记 | `pw-runs.ts:198` recordPwEvent（actor=system 组合白名单 `:294`）；`src/pw-collab.ts:252` 用户消息落账；测试：`pw-audit-foundation.test.ts`「盲区逐点：voice/corpus/connection/mirror 模块内落账（12 函数 → 13 条审计事件）」 |
| §3 · AI 默认不开 · 人留后门（:39-41） | 删押注/改判决/卡回退/水位重置/消息删除/镜像强刷/风控清空/声音→草稿提升链 默认不给 AI | 能力级 deny（工具表无对应项）；作废/重铸语义替代 | `pw-collab-tools.ts:1216` unpick_sieve_card（仅撤销场景冲正键，非通用回退）、`:1241` void_settlement（作废重结）；`pw-mint-undo.test.ts:681`「第6组：deny 名单新集逐字断言 + 工具表 33 计数」；声音→草稿提升链留 P2（规格原文，无落点） |
| §4 审计规格（:43-52） | 每笔 AI 代办记四样（谁/干什么/听谁的话/什么时候）；账本 append-only；盲区全补 | `src/pw-runs.ts` schema + `src/pw-collab-tools.ts` 记账 + 测试 | `pw-runs.ts:34` PwRunRow（含 instruction_text/instruction_message_id 两列）、`:273` recordPwExecEvent（「听谁的话」强制两列）；测试「append-only：pw-runs 模块不暴露任何 update/delete 导出」`pw-audit-foundation.test.ts:457`；盲区逐点测试 `:232`；协作台消息落账测试 `:367` |
| §5 撤销规格（:54-66） | 六个办错场景对应撤法；新造冲正键仅「撤销挑卡」「结账作废」两个 | `src/pw-collab-tools.ts` 两冲正键 + `src/pw-collab.ts` 铸币纪律提示词 + `src/pw-mint-undo.test.ts` 状态机 | `pw-collab.ts:224` 铸币纪律（仅有两个冲正键，只在用户明确说撤销/作废时用）；`pw-collab-tools.ts:1216` unpick_sieve_card（押注 void + 候选卡回 pending 同一事务）；`:1241` void_settlement（判决 void 原文保留 + 可重结）；误录声音软丢弃 `src/pw-voice.ts` dropPwVoiceItem；测试 `pw-mint-undo.test.ts:494`「第3组：unpick 状态机」、`:569`「第4组：void_settlement」 |
| §6 监督规格 · 纪律（:68-70） | 无人明确指令禁止调用写工具（提示词措辞） | `src/pw-collab.ts` 店规段① + `src/pw-collab-tools.ts` 守门 | `pw-collab.ts:220` 店规段①原文；`pw-collab-tools.ts:134` requireExecInstruction（缺指令 500）；`pw-exec-tools.test.ts:641`「第6组：店规提示词三段包含断言」 |
| §6 · 擅自发动判定（:71） | 执行类账目缺人指令引用 = 擅自发动，无灰色地带；实现为自动断言，测试/冒烟专盯 | **本刀新增** `src/pw-supervision.ts` + `src/pw-supervision.test.ts` + `scripts/pw-harness-audit.mjs` | `pw-supervision.ts:41` auditPwExecInstructions（ai_exec 缺 instruction_text/instruction_message_id 任一即违规）；`:92` runPwHarnessAudit 合并、ok=零违规；测试「缺指令 ai_exec 被抓」「合规 ai_exec（带指令）过」「合并：两类违规汇总」`src/pw-supervision.test.ts`；可重复脚本 `scripts/pw-harness-audit.mjs:31-44`（只读真实库、违规 exit 1） |
| §6 · 自主档白名单（TASK-PW-27 派生） | 自主档扩张必须显式加白名单，防默许漂移 | **本刀新增** `src/pw-supervision.ts` | `pw-supervision.ts:26` PW_AUTO_WHITELIST（当前仅 'corpus'）；`:73` auditPwAutoWhitelist；测试「ai_auto corpus 过」「ai_auto 非白名单被抓」 |
| §6 · 审查入口（:72） | 对话内问「你最近代办了什么」→ AI 查账摆出（时间/动作/依据哪句话）；不做专门审计页面 | `src/pw-collab-tools.ts` list_my_actions + `src/pw-collab.ts` 查账店规 | `pw-collab.ts:222` 店规段③查账；`pw-collab-tools.ts:1011` list_my_actions（allow 只读，倒序，含依据指令原话截断）；测试 `pw-exec-tools.test.ts:665`「第7组：list_my_actions」 |
| §6 · 失效升级（:73） | 抓到无引用账 → 铸金级操作升硬闸门 B（写工具须引用人原话 + 后端校验），平时不装 | **未落地：明确不做**。去向：硬闸门 B 为「出事再装」的升级项，批次收口仅到自动断言（本刀），不在本批——见 `docs/TASK-PW-23-batch.md` 第五刀（收口）与 TASK-PW-27 执行规格第一节范围；当前以 `audit:harness` 脚本（package.json，不进 verify）提供可重复的店规突破探测，真抓到再议升硬闸门 B |
| §7 指认规格 · 菜号牌（:77） | AI 摆对象必贴短标签（证据 N / 注 N / 草稿 A / BV 号），对话与页面同一标签 | 标签来源已进 prompt 与装配；**序号同源统一 = 主会话第四节** | prompt 现状 `pw-collab.ts:221`（证据 N / 注 N / 草稿 A / BV 号）；装配现状：候选卡 `pw-context.ts:254`、全局 `:328`（「少数派」标注）、`pw-collab-tools.ts:537`；在途押注 `pw-context.ts:302`（注·id）；语料 BV 号 `pw-context.ts:263-267`；**去向**：证据 N/少数派 N/注 N/文档 N/草稿 `<id8>` 同源统一、read_data_docs 改标签 = 主会话第四节，本刀不碰（见 TASK-PW-27 执行规格第四节） |
| §7 · 就近锚定 / 清楚就干（:78-79） | 「就这张」= 当前话题卡或唯一候选；指认明确宣告即执行，含糊必反问 | `src/pw-collab.ts` prompt + `src/pw-collab-tools.ts` 全局显式指认强制 | `pw-collab.ts:221` 店规段②指认规矩原文；`pw-collab-tools.ts:858` 全局 edit 需显式 betId、`:1071` 全局 settle 需显式 draftId、`:1078` 多草案要求指认 |
| §7 · 单卡 vs 全局（:80） | 单卡对话默认锚定当前卡；全局对话必须先列候选再指认 | `src/pw-collab.ts` 全局说明 + `src/pw-context.ts` 全局装配 | `pw-collab.ts:229` COLLAB_GLOBAL_PROMPT_NOTE、`:232` 全局指认规矩；`pw-context.ts:278` buildGlobalCollabContext（全局装配注入在途押注/候选卡/语料/金子墓碑）；测试 `pw-global-collab.test.ts` |
| §8 验收后行动（:82-83） | ①扩 schema ②写工具进表+店规 ③两冲正键 ④擅自发动断言与冒烟 ⑤派新窗口执行 | 逐项分解为 PW-23/24/25/26/27 批次 | ①`docs/TASK-PW-23-audit-foundation.md`；②`docs/TASK-PW-24-exec-tools.md`；③`docs/TASK-PW-25-mint-and-undo.md`；④本刀（监督侧一~三节）+ 主会话集成冒烟；⑤批次 `docs/TASK-PW-23-batch.md` 第五刀（收口） |

## 已知观察项

- **PW-25 冒烟：模型把 ai_draft 无指令引用误读为缺陷**。冒烟中模型看到 `list_my_actions` 里 ai_draft 行（起草押注/结账，draft 档本无指令列，属设计）的「无引用！」标记后误判为「擅自动作缺陷」。成因：`pw-collab-tools.ts:1032-1036` 对缺指令行的三态判断把 ai_draft 与「真正缺引用的 ai_exec」都渲染成「无引用！」。**去向**：主会话在 PW-27 第四节把 ai_draft 行措辞改为「起草（无需指令）」、ai_auto 保持「自主（无需指令）」、仅 ai_exec 缺引用保留「无引用！」。监督侧本刀不受影响——`auditPwExecInstructions` 只扫 `kind='ai_exec'`（`pw-supervision.ts:41`），ai_draft/ai_auto 明确不查指令，与设计一致。
- **PW-26 冒烟补充**：ai_auto 账行 instruction 两列恒 NULL（自主档设计），`pw-supervision.ts:73` 白名单断言只查 event_type、不查指令列，二者不冲突。

## 统计

- 规格小节：§1~§8 共 8 节，拆出回勾行 17 行（含 §3/§6/§7 细分）。
- 已落地：16 行；未落地：1 行（§6 失效升级·硬闸门 B = 明确不做，去向已注明）。
- 本刀新增落点：`src/pw-supervision.ts`、`src/pw-supervision.test.ts`、`scripts/pw-harness-audit.mjs`、`package.json`（test 登记 + `audit:harness`，不进 verify）、本文件。
