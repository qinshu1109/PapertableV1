# TASK-PW-28：起草内容押注通路（draft_bet 补户口）

状态：已拍板（用户选 C：A 人工校正已完成，本任务为 B 补通路）
执行：DeepSeek 子代理实现；主代理复跑 verify + 真实冒烟验收

## 背景与根因

2026-08-07 真实事故：用户在协作台对话确认草稿 1ba1711d 转正，大屏「在途押注」rail 不可见。
根因：draft 管线（createPwBetDraft）只产 `kind='verdict'`（PW-19 定的回归语义），而协作台 rail
取数 `listContentBets`（src/pw-content-bets.ts:321）只收 `kind='content'`；内容押注此前唯一入口是
pick_sieve_card 挑卡（无草稿态）。「从候选卡聊出来、想先起草再确认」的内容押注没有工具通路，
AI 只能借 draft_bet，户口落错。

事故两张卡（1ba1711d pending / 3646d2b8 draft）已人工 SQL 校正为 content，pw_runs 有两条
manual_event/edit 审计行。本任务补正式通路，让对话起草内容押注草稿成为一等公民。

## 改动范围（只允许这些文件）

### 1. src/pw-drafts.ts

- `PwBetDraftInput` 增两个可选字段：
  - `kind?: "verdict" | "content"`（缺省 = 'verdict'，回归不变）
  - `sourceCardId?: string | null`
- `createPwBetDraft`：
  - INSERT 列清单加 `kind, source_card_id` 两列（pw_bets 表此两列已存在，PW-19 迁移）。
  - 校验（用本文件既有的 `error` 助手风格，400 语义）：
    - `kind='verdict'` 且带 sourceCardId → 抛错「verdict 押注不允许挂候选卡」。
    - `kind='content'` 且带 sourceCardId → 该行必须存在于 pw_sieve_cards，否则抛错「候选卡不存在」。
    - `kind='content'` 不带 sourceCardId → 允许（source_card_id 落 NULL）。
  - 非法 kind 值 → 抛错。
- `confirmPwBetDraft` 不改：kind 随行走，转正天然带户口。

### 2. src/pw-collab-tools.ts

- `draftBetSchema` 增：
  - `kind: Type.Optional(Type.Union([Type.Literal("verdict"), Type.Literal("content")]))`，
    description 写明「内容向押注（选题/视频/直播）用 content；判断/生活向缺省 verdict」。
  - `sourceCardId: Type.Optional(Type.String())`，description 写明「仅 kind='content' 时可用，
    取值 pw_sieve_cards 行 id；从候选卡聊出的草稿必须带上」。
- `draft_bet` execute：
  - 透传 kind / sourceCardId 给 createPwBetDraft。
  - ai_draft 审计 payloadJson 增 `kind`、`sourceCardId` 两字段。
  - 返回文本：kind='content' 时说明「内容押注草稿——确认转正后会上协作台在途 rail」。
- `draft_bet` description 更新：补「起草内容向押注（选题、视频、直播选题）必须传 kind='content'，
  否则确认后不会出现在协作台在途押注 rail」。

### 3. src/pw-collab.ts

- system prompt 纪律区补一条（措辞可微调，语义不变）：
  「起草押注先分户口：选题/内容向 → draft_bet 传 kind='content'（从候选卡聊出的带 sourceCardId）；
  判断/生活向 → 缺省不传。只有 kind='content' 的押注才会出现在协作台在途押注 rail。」

### 4. src/pw-draft-content-bet.test.ts（新建）

复用既有测试范式（参考 pw-content-bets.test.ts 的 makeDb/建库方式）：
1. 默认回归：不传 kind → 行 kind='verdict'。
2. kind='content' 无 sourceCardId → 行 kind='content'、status='draft'、source_card_id 为 NULL。
3. kind='content' + 合法 sourceCardId → source_card_id 落列。
4. kind='verdict' + sourceCardId → 抛错。
5. kind='content' + 不存在的 sourceCardId → 抛错。
6. content 草稿 confirmPwBetDraft 转正 → 出现在 listContentBets 结果中（verdict 草稿不出现在内）。
7. draft_bet 工具层（带 kind/sourceCardId 调用）→ ai_draft 审计事件 payload 含 kind 与 sourceCardId。

### 5. package.json

- 登记新测试文件（照既有 test 条目格式）。

## 纪律

- 不改 src/main.ts（无新路由）；不改 frontend/、public/；不 git commit。
- 既有测试不许改语义；如确需连带修改，回报中逐项说明理由。
- 风格与既有代码一致（requiredText/optionalText、error 助手、recordPwEvent 审计风格）。

## 明确不做

- create_bet 直接建内容押注：不加（留后续，有需要再立任务）。
- 草稿引用候选卡不改变卡状态（只有 pick 才变 picked）。
- SPEC-harness-write-boundary.md 不变（draft 档位不变，只是草稿多一个户口字段）。
- REQUIREMENT-DOMAINS.md 不变（内容生产域职责已覆盖候选卡/内容押注卡）。
- 已知并接受：listContentBets 只滤 void，content 草稿会以 draft 态出现在 rail（大屏顺带摆出
  待确认草稿，符合推式意图），本任务不改此行为。

## 验收硬门（主代理亲自跑）

1. `PATH="$HOME/.local/node/bin:$PATH" npm run verify` 全绿（含新 7 测）。
2. 真实模型对话冒烟：起草一张 kind='content' 押注草稿 → confirm_bet_draft 转正 →
   GET /api/pw/content-bets 出现该卡。

## 先读文件

1. AGENTS.md
2. 本规格
3. src/pw-drafts.ts（createPwBetDraft / PwBetDraftInput）
4. src/pw-collab-tools.ts（draft_bet 段，约 640-674 行）
5. src/pw-content-bets.ts（listContentBets）与 src/pw-content-bets.test.ts（测试范式）
6. src/pw-collab.ts（system prompt 纪律区）
7. package.json（test 登记格式）
