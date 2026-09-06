# TASK-PW-03 产出物手动登记与挂载

- 主需求域：实践与数据回收
- 业务接口：登记实践执行（按押注归集产出）
- 数据真值源：pw_artifacts（本任务创建并独占表结构）
- 质量约束与验收终态：见文末验收命令全部通过

## 背景

PRD：`docs/PRD-Paperweight.md` v0.2。开干位的数据层：每期内容（成片、封面、发布链接）登记到押注卡名下，结账时按件核对。约束核心：**没有归属押注的产出物不允许存在**（反向锁住"先干再想"）。

## 并行约定（PW 后端批通用，必须遵守）

- 只能新建两个文件：`src/pw-artifacts.ts`、`src/pw-artifacts.test.ts`；不得修改 `src/main.ts`、`src/data.ts`、`src/verdicts.ts`、`package.json`、`frontend/**`、`public/**`。
- 表创建用模块内 `ensurePwArtifactTables(db)`，不建共享迁移文件。
- 不 import 任何其他 `pw-*.ts` 模块；bet_id 只存字符串，不加 `REFERENCES` 外键（集成阶段统一补）。校验 bet 存在性时直接 `SELECT id FROM pw_bets WHERE id = ?`，查不到即报错——不依赖 pw-bets 模块的函数。
- HTTP 挂载不做；只导出纯函数，测试用内存库自包含（测试里自行建 `pw_bets` 最小表插入假 bet）。

## 范围

`src/pw-artifacts.ts`：

- `ensurePwArtifactTables(db)`：`pw_artifacts` 表：`id TEXT PRIMARY KEY, bet_id TEXT NOT NULL, platform TEXT NOT NULL, url TEXT, title TEXT, type TEXT NOT NULL CHECK(type IN ('video','livestream','article','cover','link')), published_at TEXT, note TEXT, created_at TEXT NOT NULL, detached_at TEXT`。
- `attachPwArtifact(db, input)`：登记产出物。bet_id 必填且必须存在；platform、type 必填；url/title 至少其一。
- `detachPwArtifact(db, id)`：解挂——只写 `detached_at`，不删除行（留痕）。
- `listPwArtifacts(db, betId, { includeDetached? })`：按押注归集列出，默认不含已解挂。

## 验收

- `node --test src/pw-artifacts.test.ts` 全绿：正常挂载；bet 不存在时报错；type 非法报错；解挂后默认列表不可见但行仍在（detached_at 非空）。
- `npm run selfcheck` 不退化。
