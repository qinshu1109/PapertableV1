# TASK-PW-05 到期结账裁决（含金子墓碑只读查询）

- 主需求域：判断沉淀与复用
- 业务接口：回流数据文档·消费侧；提供有效判断（本任务产出的金子经 PW-07 的镜像/装配消费）
- 数据真值源：pw_verdicts（本任务创建并独占表结构）
- 质量约束与验收终态：见文末验收命令全部通过

## 背景

PRD：`docs/PRD-Paperweight.md` v0.2。结账是产品灵魂：到期押注看着数据文档裁决——铸金（必填"有效判断一句话"）、立碑（必填"死因"）、作废（不计成绩）。**decided_by 恒为 human，这是 DB 层约束不是应用层约定**（防 AI 越权结账的数据层保险丝）。本任务同时覆盖 PRD 中 PW-06 的只读部分：金子墓碑的列表与检索查询函数（视觉呈现属前端批，不在此列）。

## 并行约定（PW 后端批通用，必须遵守）

- 只能新建两个文件：`src/pw-verdicts.ts`、`src/pw-verdicts.test.ts`；不得修改 `src/main.ts`、`src/data.ts`、`src/verdicts.ts`、`package.json`、`frontend/**`、`public/**`。
- 表创建用模块内 `ensurePwVerdictTables(db)`，不建共享迁移文件。
- 不 import 任何其他 `pw-*.ts` 模块；bet_id / evidence_doc_ids 只存字符串，不加外键。校验押注状态时直接查 `pw_bets`（测试里自建最小表），校验数据文档直接查 `pw_data_docs`。
- HTTP 挂载不做；只导出纯函数，测试用内存库自包含。

## 范围

`src/pw-verdicts.ts`：

- `ensurePwVerdictTables(db)`：`pw_verdicts` 表：`id TEXT PRIMARY KEY, bet_id TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('gold','tomb','void')), lesson TEXT, cause_of_death TEXT, evidence_doc_ids_json TEXT NOT NULL DEFAULT '[]', confidence_snapshot INTEGER, decided_by TEXT NOT NULL DEFAULT 'human' CHECK(decided_by = 'human'), decided_at TEXT NOT NULL, created_at TEXT NOT NULL`。注意 `CHECK(decided_by = 'human')` 必须存在。
- `settlePwBet(db, betId, input)`：结账事务——①押注须为 pending 且已到 checkout_date（日期比较）；②outcome=gold 时 lesson 必填、tomb 时 cause_of_death 必填、void 时两者可空；③evidence_doc_ids 非空且每个 id 在 pw_data_docs 中存在（void 可为空）；④写 pw_verdicts（confidence_snapshot 取押注卡当前 confidence）；⑤回写 pw_bets.status（gold/tomb→'settled'，void→'void'）与 settled_verdict_id；⑥一张押注只允许一条非 void 结账记录，重复结账报错。
- `listDuePwBets(db, asOfDate)`：列出已到结账日且仍 pending 的押注。
- 只读查询（PW-06 后端部分）：`listPwVerdicts(db, { outcome? })`、`searchPwVerdicts(db, keyword)`（LIKE 即可，FTS 留给集成）、`tombstoneCauseStats(db)`（墓碑按死因聚合计数）。

## 验收

- `node --test src/pw-verdicts.test.ts` 全绿：三态结账各自必填校验；evidence 不存在报错；重复结账报错；作废后押注可重新结账（void 不占用"一次结账"名额）；decided_by 非 human 被 DB 约束拒绝；listDue 只出到期 pending；死因聚合正确。
- `npm run selfcheck` 不退化。
