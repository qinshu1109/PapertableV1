# TASK-PW-11 闭环事件日志

- 主需求域：实践与数据回收
- 业务接口：起草留痕
- 数据真值源：pw_runs（本任务创建并独占表结构）
- 质量约束与验收终态：见文末验收命令全部通过

## 背景

PRD：`docs/PRD-Paperweight.md` v0.2。可审计 Run 的 P0 形态：创建/挂载/回流/草稿/确认/驳回/结账七类手工闭环事件入库，只增不改，parent_id 成树（借 Pi 的 JSONL 树思想），单卡时间线可回放。P2 扩展 actor=ai 事件类型，零迁移。其他模块何时接入事件上报属集成阶段工作，本任务只交付表与记录/回放函数。

## 并行约定（PW 后端批通用，必须遵守）

- 只能新建两个文件：`src/pw-runs.ts`、`src/pw-runs.test.ts`；不得修改 `src/main.ts`、`src/data.ts`、`src/verdicts.ts`、`package.json`、`frontend/**`、`public/**`。
- 表创建用模块内 `ensurePwRunTables(db)`，不建共享迁移文件。
- 不 import 任何其他 `pw-*.ts` 模块；related_ids 只存字符串数组 JSON，不加外键。
- HTTP 挂载不做；只导出纯函数，测试用内存库自包含。

## 范围

`src/pw-runs.ts`：

- `ensurePwRunTables(db)`：`pw_runs` 表：`id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('manual_event','ai_draft','sync')), event_type TEXT NOT NULL CHECK(event_type IN ('create','attach','data_doc','draft','confirm','reject','settle')), actor TEXT NOT NULL CHECK(actor IN ('human','ai','system')), payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL, parent_id TEXT, related_ids_json TEXT NOT NULL DEFAULT '[]', bet_id TEXT, created_at TEXT NOT NULL`。
- `recordPwEvent(db, input)`：记录事件。payload_json 须为合法 JSON（解析校验后存原文）；payload_hash 由模块对 payload 原文取 SHA-256 自动计算，调用方传入的 hash 若不一致以模块计算为准；parent_id 可空（有则形成事件树）；P0 阶段 kind 只允许 'manual_event'、actor 只允许 'human'/'system'（'ai' 留给 P2，传入即报错）。
- `getPwBetTimeline(db, betId)`：按 bet_id 取事件，按 created_at 升序，含 parent_id 树结构所需的全部字段，供时间线回放。
- 不可变纪律：模块不提供任何 update/delete 函数；测试断言表上直接执行 UPDATE 不影响模块行为（即模块从不读回改写）。

## 验收

- `node --test src/pw-runs.test.ts` 全绿：七类事件均可记录；非法 payload_json 报错；payload_hash 自动计算且与原文一致；actor='ai' 在 P0 被拒；parent_id 成树可取；时间线按序返回且含全部七类事件。
- `npm run selfcheck` 不退化。
