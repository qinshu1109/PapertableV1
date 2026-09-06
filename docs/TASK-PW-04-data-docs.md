# TASK-PW-04 手动数据文档

- 主需求域：实践与数据回收
- 业务接口：回流数据文档·生产侧
- 数据真值源：pw_data_docs（本任务创建并独占表结构）
- 质量约束与验收终态：见文末验收命令全部通过

## 背景

PRD：`docs/PRD-Paperweight.md` v0.2。数据回流的手工兜底通路（永远是兜底，同步系统的目标是"省心"不是"离不开"）：手动把平台数据（播放/转评赞/完播等）录入为可引用数据文档，供到期结账裁决引用。**只增不改**：写错不更新，追加新版本。

## 并行约定（PW 后端批通用，必须遵守）

- 只能新建两个文件：`src/pw-data-docs.ts`、`src/pw-data-docs.test.ts`；不得修改 `src/main.ts`、`src/data.ts`、`src/verdicts.ts`、`package.json`、`frontend/**`、`public/**`。
- 表创建用模块内 `ensurePwDataDocTables(db)`，不建共享迁移文件。
- 不 import 任何其他 `pw-*.ts` 模块；bet_id / artifact_id 只存字符串，不加外键。
- HTTP 挂载不做；只导出纯函数，测试用内存库自包含。

## 范围

`src/pw-data-docs.ts`：

- `ensurePwDataDocTables(db)`：`pw_data_docs` 表：`id TEXT PRIMARY KEY, bet_id TEXT NOT NULL, artifact_id TEXT, platform TEXT NOT NULL, collected_at TEXT NOT NULL, method TEXT NOT NULL DEFAULT 'manual' CHECK(method IN ('manual','export','sync')), metrics_json TEXT NOT NULL, raw_ref TEXT, source_hash TEXT, version INTEGER NOT NULL DEFAULT 1, frozen INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL`。
- `createPwDataDoc(db, input)`：录入。P0 只允许 `method='manual'`；metrics_json 必须是合法 JSON 对象（解析校验，存原文）；bet_id 必填；artifact_id 可空；collected_at 必填（用 `src/data.ts` 的 `nowIso` 或调用方传入）。
- `appendPwDataDocVersion(db, docId, metricsJson)`：对同一文档追加新版本——原行不改，新行 version+1，共享同一 bet_id/artifact_id/platform，返回新 id。
- `freezePwDataDoc(db, id)`：结账引用后冻结（frozen=1）；冻结后 `appendPwDataDocVersion` 拒绝。
- `getPwDataDoc(db, id)`、`listPwDataDocs(db, betId)`：读取，list 只返回各文档最新 version。

## 验收

- `node --test src/pw-data-docs.test.ts` 全绿：录入成功；metrics_json 非法时报错；追加版本原行不变、新版 version=2；冻结后追加被拒；list 只出最新版本。
- `npm run selfcheck` 不退化。
