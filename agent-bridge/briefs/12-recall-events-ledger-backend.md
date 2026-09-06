# 12 · 笔记召回事件账本（一期后端）

## 背景

用户拍板的新方向：笔记库存闭环的第一步不是改功能，是先记账——搞清楚旧笔记"被判/被捞之后到底谁用过、用在哪"。研究结论：现在分不清 0.2% 使用率是"没叫货"（没有召回机会）还是"叫了没人用"（召回断环），要先拿分母。

一期只做**纯加法**：新建一张事件表 + 在现有四个出口打点 + 一个只读统计接口。不改任何现有表结构、不改现有行为、不碰前端（前端统计页由 kimi 主代理另行负责，不在本任务内）。

## 新表 `pw_recall_events`

每次"系统把某条笔记摆到人面前"或"人对某条摆出的笔记做了动作"记一行：

| 字段 | 含义 |
|---|---|
| `id` | TEXT PRIMARY KEY，randomUUID |
| `created_at` | TEXT，nowIso() |
| `event_kind` | TEXT，枚举：`surfaced`（系统摆出）/ `confirmed`（人确认相关）/ `rejected`（人拒绝）/ `attached`（人挂到押注/笔记树）/ `used`（人确认实际用上）/ `settled`（结账归因） |
| `surface` | TEXT，摆出/动作发生的通道：`echo`（PW-40 收工小结回响/第七屏相关旧笔记）/ `miner`（PW-61 捞料候选）/ `note_tree`（PW 笔记树挂接）/ `verdict`（结账） |
| `bet_id` | TEXT NULL，关联押注（无则 NULL） |
| `note_uid` | TEXT NULL，Memos 笔记 uid 或候选引用的笔记标识 |
| `miner_candidate_id` | TEXT NULL， miner 候选行 id（surface=miner 时填） |
| `run_id` | TEXT NULL，来源运行批次（echo 无批次可 NULL；miner 填 run id） |
| `role` | TEXT NULL，挂接/确认时的证据角色（PW_NOTE_ROLES 之一，可 NULL） |
| `meta_json` | TEXT NULL，补充信息（如命中关键词、摘要截断），可 NULL |

索引：`(bet_id, created_at)`、`(note_uid, created_at)`、`(event_kind, created_at)`。
幂等建表（CREATE TABLE IF NOT EXISTS），跟项目现有建表风格一致（参考 `pw-miner.ts`）。

## 打点位置（四个出口）

1. **`pw-note-recall.ts`（echo 通道）**：`buildPwNoteEcho` 装配出过门槛命中、且状态为 `ok` 时，对每条命中记 `surfaced`（surface=`echo`，bet_id、note_uid、meta_json 带 matchedKeywords）。注意这个函数现有纪律是"不吞错/统一兜底"——打点是写操作，**写事件失败不得让回响装配失败**：打点包 try/catch，失败静默跳过（记 console.warn），不能改变 `buildPwNoteEcho` 的返回。
2. **`pw-miner.ts`（miner 通道）**：
   - miner run 落 `pw_miner_candidates` 时，每条候选记 `surfaced`（surface=`miner`，run_id、miner_candidate_id、note_uid 取候选引用的笔记标识，没有则 NULL）。
   - 候选状态被人改成 `confirmed` / `rejected` / `direction_seed` 的现有接口处，分别记 `confirmed` / `rejected`（`direction_seed` 记 `confirmed` + meta_json 注明 seed）。
3. **`pw-note-tree.ts`（note_tree 通道）**：`confirmPwNoteAttach` 成功时记 `attached`（bet_id、note_uid、role）。
4. **`verdicts.ts` / `pw-verdicts.ts`（verdict 通道）**：结账（verdict 创建）成功时，对该押注已 attached 的笔记每条记 `settled`（surface=`verdict`，bet_id、note_uid）；若现有结账流程已有证据引用（`pw_verdict_refs`），优先按 refs 记。

## 红线（必须遵守）

- **AI/系统只能写 `surfaced`**；`confirmed`/`rejected`/`attached`/`used`/`settled` 只能来自人触发的现有接口动作。本任务不新增任何"人确认"入口，只在现有入口打点。
- 不打点就不改变任何现有返回值/行为；除 echo 打点允许的 try/catch 兜底外，其余打点失败处理跟所在模块现有错误纪律一致。
- 不调 LLM、不加依赖、不动 Memos 库（保持只读）、不动前端。
- `used` 事件一期没有现成入口则不产生，表结构预留即可——不要为它发明新流程。

## 只读统计接口

新增 `GET /api/pw/recall-events/summary?days=30`，返回：

```json
{
  "days": 30,
  "bySurface": {
    "echo":  { "surfaced": 0, "confirmed": 0, "rejected": 0, "attached": 0, "used": 0, "settled": 0 },
    "miner": { "...": "同结构" }
  },
  "totals": { "surfaced": 0, "confirmed": 0, "rejected": 0, "attached": 0, "used": 0, "settled": 0 },
  "distinctNotesSurfaced": 0,
  "distinctNotesConfirmed": 0,
  "byDay": [ { "date": "2026-08-12", "surfaced": 0, "confirmed": 0 } ]
}
```

- `days` 默认 30，上限 365；按 `created_at` 过滤。
- `distinctNotes*` 按 note_uid 去重（NULL 不计）。
- 再补一个 `GET /api/pw/recall-events?limit=100&offset=0` 原始翻页（按 created_at 倒序），供调试与前端后续使用。
- 路由注册方式照 `main.ts` 里现有 `/api/pw/*` 的写法。

## 验收（claude 自行跑完再回报）

- `node --test`（或项目现有测试命令）全绿；新增 `pw-recall-events.test.ts` 覆盖：建表幂等、四类打点各记对字段、summary 聚合数字手算对得上、days 过滤生效、echo 打点失败不影响 buildPwNoteEcho 返回。
- 手动 curl 两个新接口贴出真实返回（真库只读纪律不变：本任务写的是镇纸自己的库，不是 papertable.sqlite3 真库）。
- 回报：改动文件清单、测试命令与结果、curl 输出。
- 浏览器端验收由 codex 窗口负责，发现问题会经简报回路给你修。
