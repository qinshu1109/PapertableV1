# TASK-PW-74 清坏灯：停捞料 401 空转 + 清 dsh 陈旧提醒

- 主需求域：内容生产
- 业务接口：无（域内）
- 数据真值源：`pw_miner_runs`（papertable.sqlite3，台账只读核对不删行）；dsh-paperweight 插件本地 `push-feed.json`（派生收件箱，可重建，非真值）；`pw_bets`（只读核对，不改）
- 质量约束与验收终态：见 §4

## 1. 背景与授权

2026-08-29 用户授权「清坏灯」（依据研究报告结论：陈旧提醒比没有提醒更快摧毁信任；每日召回已由嫁接取代）。两盏坏灯，证据见 `agent-bridge/out/41-current-state.md`：

1. **捞料 401 空转**：`src/main.ts` 的 `runMinerTick`（TASK-PW-61）启动 1 分钟首跑、之后每 5 分钟检查是否过本地 06:30，每天 scheduled 跑一次。`pw_miner_runs` 现有 7 行全部 `trigger_kind=scheduled` 且 `status` 以 `failed:401` 开头（api key 尾号 33b1 invalid）。`pw_miner_candidates=0`、`pw_miner_cards=0`——天天空转，零产出。
2. **dsh 陈旧提醒**：`dsh-plugins/dsh-paperweight` 插件（host 侧 `src/host/index.ts` 启动 10s 后 `push.refresh()`、之后每小时刷）的本地收件箱 `~/.dsh-source/papertable/dsh-paperweight/push-feed.json` 有 31 条（kind: due 21 + daily 10）、unread=29。但 `pw_bets=0`，21 条 due 全是假信号；daily「今日值得看」属于已取消的每日召回（PRD 非目标：不做每日 digest）。

## 2. 范围

做：

1. 停掉 miner 的 scheduled 自动捞料：不再自动触发 `runPwMinerScheduledTick`。代码与手动触发能力保留，最小变更；不修车钥匙（那个 invalid api key 不用管，整条自动捞料路线取消）。
2. 清空 `push-feed.json` 存量 31 条（due + daily），并修 refresh 生成逻辑：
   - `pw_bets` 为空或引用的押注已不存在时，不得产出 due 项（实体失效核验）；
   - daily「今日值得看」停产。
3. 重启受影响进程使生效（4317 后端；dsh web 如需要）。

不做：

- 不动卷积定时器 `runRollupTick` 与 `idleTimer`；
- 不动 PW-72 飞书通知链路（`pw-feishu-notify.mjs`、`/n/:token` 路由、4317 通知相关接口）；
- 不动 PW-73 ZCode 嫁接（`~/.zcode/**`）与 feishu-relay（cli_a946）；
- 不删 `pw_miner_runs` 历史行（台账保留作审计）；
- 不动任何前端 / UI 文件（`frontend/src/**`、插件的 UI 侧）；若发现不动 UI 无法完成，停下来上报，不擅自碰；
- 不改 `pw_bets` 等业务表数据。

## 3. 依据文档

- `docs/REQUIREMENT-DOMAINS.md`（v1.1：捞料运行台账与候选归内容生产）
- `docs/ASSEMBLY.md`（4317 构建 / 重启纪律，动手前必读）
- `docs/# DeepSeek Harness「押注通知链路」落地 PRD.md`（非目标：不做每日 digest、不做后台检索）
- `agent-bridge/out/41-current-state.md`（现状证据）

## 4. 质量约束与验收终态

1. 代码层证明 miner 定时器不再注册或被确定性短路；4317 重启后日志不再出现 miner scheduled 触发记录。
2. `push-feed.json`：kind=due 与 kind=daily 均为 0；unread 与剩余合格项一致（当前应为 0）。
3. 手动触发一次插件 refresh（或等效验证）：`pw_bets=0` 下不产生 due，不产生 daily。
4. 回归：4317 `/api/status` ready=true；`GET /api/pw/notes/rollups` 正常；`agent-bridge/scripts/pw-feishu-notify.mjs --seq 1` 仍能发出（PW-72 不受波及）。
5. `npm run verify` 绿；`git diff` 只触及本 TASK 声明范围的文件。
