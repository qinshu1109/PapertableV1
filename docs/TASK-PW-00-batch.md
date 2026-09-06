# TASK-PW-00 Paperweight P0 后端并行批说明

- 日期：2026-08-04
- 状态：已完成（8/8 验收通过 + 集成完成 + PW-12 闸门通过）
- 依据：`docs/PRD-Paperweight.md` v0.2

## 批次范围

8 个后端 TASK，无视觉验收，可全部并行：

| TASK | 交付 | 拥有 |
|---|---|---|
| PW-01 押注卡建模与创建 | `src/pw-bets.ts` + 测试 | pw_bets 表 |
| PW-03 产出物手动登记挂载 | `src/pw-artifacts.ts` + 测试 | pw_artifacts 表 |
| PW-04 手动数据文档 | `src/pw-data-docs.ts` + 测试 | pw_data_docs 表 |
| PW-05 到期结账裁决 | `src/pw-verdicts.ts` + 测试 | pw_verdicts 表（含 PW-06 只读查询） |
| PW-07 金子单向同步 | `src/pw-gold-sync.ts` + 测试 | pw_gold_mirror 表 |
| PW-08 观众声音录入分拣 | `src/pw-voice.ts` + 测试 | pw_voice_items 表 |
| PW-09 草稿与人审确认 | `src/pw-drafts.ts` + 测试 | pw_draft_events 表（读写 pw_bets 但不拥有） |
| PW-11 闭环事件日志 | `src/pw-runs.ts` + 测试 | pw_runs 表 |

## 防冲突约定（每个 TASK 文档内已自带）

1. 每个任务只新建自己名下的两个文件（模块 + 测试），文件集合互不相交。
2. 谁都不改 `src/main.ts`、`src/data.ts`、`src/verdicts.ts`、`package.json`、`frontend/**`、`public/**`——路由挂载、测试脚本登记、事件上报接线全部留给集成阶段。
3. 跨模块引用只存 id 字符串，不加外键；任务之间不互相 import；测试各自用 node:sqlite 内存库自包含。
4. 每任务独立验收：`node --test src/pw-<name>.test.ts` 全绿 + `npm run selfcheck` 不退化。

## 集成记录（2026-08-04，已完成）

- 8 个模块已接入 `src/main.ts`：启动幂等建表（`createApp` 内 8 个 `ensurePw*Tables`）、`/api/pw/` 路由约 20 个（bets/artifacts/data-docs/settle/verdicts/golds/voice/drafts/timeline/context）；事件上报在 route 层统一接线（`emitPwEvent`），pw 模块零改动。
- 新增 `src/pw-context.ts`（`assembleJudgmentContext`：确定性排序 + 字符预算截断，PW-12 装配载体）。
- `package.json` 的 `npm test` 已登记全部 pw 测试（8 模块 + pw-context + pw-gate-e2e），共 47 个测试全绿。
- PW-12 端到端闸门（`src/pw-gate-e2e.test.ts`）通过：全程 HTTP 跑两圈（一金一碑 + draft→confirm + reject），七类事件齐全，第一次的金子出现在后续押注的装配输出中；`npm run verify`（含 frontend build）通过。
- 环境注意：本机默认 `node`（~/.local/bin/node）是 ChatGPT 应用内置 cua_node，强化签名导致前端 rollup 原生模块加载失败；跑 `npm run verify` 需 `PATH="$HOME/.local/node/bin:$PATH"`（官方 Node v24.18.0）。

## 不在本批（后续）

- PW-02 押注台视图、PW-06 金子墓碑库界面、PW-10 大盘界面：视觉验收，归前端批。
- ~~PW-12 端到端阶段闸门~~：已通过（2026-08-04）。
- ~~集成任务~~：已完成（2026-08-04）；跨模块引用维持 id 弱引用（各模块自带存在性校验），未补物理外键（SQLite 外键默认关闭，无强制力）。
