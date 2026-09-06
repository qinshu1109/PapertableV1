# TASK-PW-07 Papertable 金子单向同步（只读镜像）

- 主需求域：判断沉淀与复用
- 业务接口：提供有效判断（跨产品）
- 数据真值源：pt_verdicts（Papertable 侧，只读）；pw_gold_mirror（本任务创建的 Paperweight 侧只读镜像表）
- 质量约束与验收终态：见文末验收命令全部通过，含单向纪律断言

## 背景

PRD：`docs/PRD-Paperweight.md` v0.2。Papertable 中已确认的金子单向同步到 Paperweight，供押注引用与协作台上下文装配。注意 Papertable 侧现状：`src/verdicts.ts` 的注释明确「MemOS 是唯一真值；本地表只承担草稿、写队列、缓存」——本任务以 **pt_verdicts 中 status='confirmed' 的行**为读取面（这是 Papertable 本地的已确认判决视图），不发明第二条同步通道，更不触碰 MemOS。

## 并行约定（PW 后端批通用，必须遵守）

- 只能新建两个文件：`src/pw-gold-sync.ts`、`src/pw-gold-sync.test.ts`；不得修改 `src/main.ts`、`src/data.ts`、`src/verdicts.ts`、`package.json`、`frontend/**`、`public/**`。
- 表创建用模块内 `ensurePwGoldMirrorTables(db)`，不建共享迁移文件。
- 不 import 任何其他 `pw-*.ts` 模块；可读 `src/verdicts.ts` 的类型定义但**严禁**对 pt_verdicts 做任何写入。
- HTTP 挂载不做；只导出纯函数，测试用内存库自包含（测试里自建最小 pt_verdicts 表）。

## 范围

`src/pw-gold-sync.ts`：

- `ensurePwGoldMirrorTables(db)`：`pw_gold_mirror` 表：`id TEXT PRIMARY KEY, source_verdict_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('gold')), text TEXT NOT NULL, handle TEXT, project_id TEXT, card_id TEXT, confirmed_at TEXT, mirrored_at TEXT NOT NULL`。
- `mirrorConfirmedGolds(db)`：增量镜像——读取 pt_verdicts 中 `kind='gold' AND status='confirmed'` 且尚未镜像的行，插入 pw_gold_mirror；返回 `{ added, skipped }`。幂等：重复执行不产生重复行（source_verdict_id UNIQUE）。
- `listMirroredGolds(db, { keyword? })`：读取镜像库，供押注引用与装配函数消费。
- **单向纪律**：模块内不得出现任何对 `pt_verdicts` 的 INSERT/UPDATE/DELETE；不得 import `src/memos.ts`（不经 MemOS 通道，纯本地镜像）。

## 验收

- `node --test src/pw-gold-sync.test.ts` 全绿：confirmed 金子被镜像；proposed/superseded 不镜像；重复执行幂等；镜像内容（text/handle）与源一致；源码静态断言——测试读取 `src/pw-gold-sync.ts` 文件内容，断言不含对 pt_verdicts 的写操作与 `memos.ts` import。
- `npm run selfcheck` 不退化。
