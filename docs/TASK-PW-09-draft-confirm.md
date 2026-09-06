# TASK-PW-09 转押注草稿与人审确认

- 主需求域：判断沉淀与复用
- 业务接口：草稿转正（信号候选·消费侧）
- 数据真值源：pw_bets 的 draft 态（表结构归 PW-01，本任务只做状态迁移，不建表不改表）；pw_draft_events（本任务创建的留痕表）
- 质量约束与验收终态：见文末验收命令全部通过

## 背景

PRD：`docs/PRD-Paperweight.md` v0.2。"AI 只起草不确认"在 P0 的落地：草稿（来自观众声音信号、或一次性 LLM 调用、或人手）以 draft 态存在，**人编辑后确认才转正为正式押注**；确认时记录 draft_hash 与确认人，驳回必填原因。P2 接 AI 副驾驶时草稿生产者换人，确认纪律与数据通道零改动。

## 并行约定（PW 后端批通用，必须遵守）

- 只能新建两个文件：`src/pw-drafts.ts`、`src/pw-drafts.test.ts`；不得修改 `src/main.ts`、`src/data.ts`、`src/verdicts.ts`、`package.json`、`frontend/**`、`public/**`。
- `pw_bets` 表结构归 PW-01；本任务测试里自建与 PRD 一致的最小 pw_bets 表，不 import `pw-bets.ts`。
- 表创建用模块内 `ensurePwDraftTables(db)`，不建共享迁移文件；不 import 任何其他 `pw-*.ts` 模块。
- HTTP 挂载不做；只导出纯函数，测试用内存库自包含。

## 范围

`src/pw-drafts.ts`：

- `ensurePwDraftTables(db)`：`pw_draft_events` 表：`id TEXT PRIMARY KEY, bet_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('confirm','reject')), draft_hash TEXT NOT NULL, actor TEXT NOT NULL DEFAULT 'human', reason TEXT, created_at TEXT NOT NULL`。
- `createPwBetDraft(db, input, source)`：以 `status='draft'` 创建押注草稿（字段同 PRD pw_bets），`created_from` 记录来源（如 `voice:<itemId>`、`manual`、`llm`）。
- `confirmPwBetDraft(db, draftId, edits, actor)`：转正事务——①草稿须为 draft 态；②对"草稿内容+edits 合并结果"取 SHA-256 得 draft_hash；③合并 edits 后校验三行赌注齐备（不齐报错，不允许带缺口转正）；④更新 pw_bets 为 `status='pending'`；⑤写 pw_draft_events（action='confirm', draft_hash, actor）。
- `rejectPwBetDraft(db, draftId, reason, actor)`：驳回——reason 必填；pw_bets.status 置 'void'；写 pw_draft_events（action='reject', reason）。
- `listPwBetDrafts(db)`：只列 draft 态（转正后不再出现）。

## 验收

- `node --test src/pw-drafts.test.ts` 全绿：草稿创建；转正后 status=pending 且 draft_hash 与"内容+edits"重算一致；赌注不齐转正被拒；驳回必填原因且 status=void；事件表两条留痕含 actor；非 draft 态草稿不可再转正/驳回。
- `npm run selfcheck` 不退化。
