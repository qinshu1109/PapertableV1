# TASK-PW-01 押注卡建模与创建

- 主需求域：判断沉淀与复用
- 业务接口：无（域内）；后续 PW-09 草稿转正、PW-05 结账读写本表，本任务只负责建表与创建/读取
- 数据真值源：pw_bets（本任务创建并独占表结构）
- 质量约束与验收终态：见文末验收命令全部通过

## 背景

PRD：`docs/PRD-Paperweight.md` v0.2（P0 手工闭环）。押注卡是 Paperweight 核心实体：选题假设 + 三行赌注（验证指标 / 数据来源 / 结账日）+ 可选主观置信度。

## 并行约定（PW 后端批通用，必须遵守）

- 只能新建两个文件：`src/pw-bets.ts`、`src/pw-bets.test.ts`；不得修改 `src/main.ts`、`src/data.ts`、`src/verdicts.ts`、`package.json`、`frontend/**`、`public/**`。
- 表创建用模块内 `ensurePwBetTables(db)`（`CREATE TABLE IF NOT EXISTS`），不建共享迁移文件。
- 不 import 任何其他 `pw-*.ts` 模块；跨模块引用只存 id 字符串，不加 `REFERENCES` 外键约束（集成阶段统一补）。
- HTTP 挂载不做（集成阶段统一接 `src/main.ts`）；本模块只导出纯函数，函数接收 `DatabaseSync`，测试用 `node:sqlite` 内存库自包含。

## 范围

`src/pw-bets.ts`：

- `ensurePwBetTables(db)`：建 `pw_bets` 表，字段：`id TEXT PRIMARY KEY, title TEXT NOT NULL, thesis TEXT NOT NULL, metric TEXT, metric_target TEXT, confidence INTEGER, data_source_plan TEXT, checkout_date TEXT, status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending','settled','void')), gold_refs_json TEXT NOT NULL DEFAULT '[]', created_from TEXT, created_at TEXT NOT NULL, settled_verdict_id TEXT`。
- `createPwBet(db, input)`：创建押注卡。三行赌注（metric / data_source_plan / checkout_date）在 `status='pending'` 前必填；以 pending 创建时缺任一项报 400 风格错误（用 `src/data.ts` 的 `httpError`）；confidence 可选，须为 0–100 整数，越界报错；gold_refs 为金子 id 数组快照（可为空数组）。
- `getPwBet(db, id)`、`listPwBets(db, { status? })`：读取；list 默认不含 draft 态（草稿对押注台不可见）。
- 否定验收：不得出现优先级、负责人、看板列、截止日期之外的任何时间管理字段。

## 验收

- `node --test src/pw-bets.test.ts` 全绿：建表幂等；draft 创建成功；pending 缺赌注字段报错；confidence 越界报错；gold_refs 快照存取一致；list 默认过滤 draft。
- `npm run selfcheck` 不退化。
