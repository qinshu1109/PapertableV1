# 交接上下文：PW-63 捞料概念卡（给 herdr 里的新 kimi code 窗口）

> 用法：新 kimi 窗口里发一句「读 agent-bridge/HANDOFF-PW-63.md，按它接手 PW-63」即可。本文自包含，不用找上一个窗口。

## 0. 你是谁、现在局面在哪

你是 kimi code，在 herdr 里和隔壁 codex 并排。镇纸 Paperweight 笔记屏「捞料确认区」改造（TASK-PW-63）已经立项完毕、决策全部拍板，**你的活只剩两段：把后端简报派给 codex 并验收它的交付，然后前端确认区改造你全权做**。

真值源（先读这三个，都在仓库里）：

- `docs/TASK-PW-63-miner-concept-cards.md` —— 任务真值源（四必填字段 + 白话两段 + 设计）
- `docs/wayfinder/miner-concept-cards/` —— 决策依据（MAP + Q00 关票，含试金石 5 卡记录）
- `agent-bridge/briefs/08-miner-concept-cards-backend.md` —— codex 执行规格（你要派的就是它）

## 1. 用户已拍板，别再问

- 拍板单位 = 概念卡 + 逐字证据（AI 聚合，人对概念拍板，证据随时展开验真）
- 料出口 = 概念可进方向层（「标方向种子」只落标记，不自动改方向不自动建押注）
- 51 条存量积压 = 迁移轮一次性聚合成卡上屏（不要手动清、不要删）
- 卡型三档：concept / self_memory（自己的决策记忆回流）/ link_shell（收藏壳），AI 只标不藏
- 调度 bug 随本刀修：`runPwMinerScheduledTick` 去重拿 UTC 日期比本地日期，每天 06:30-08:00 连跑十几轮（51 条积压的放大器）
- 分工：后端 codex，前端你，联调后按 TASK「怎么算好」逐条过屏验收

## 2. 第一步：派单给 codex（经 herdr）

```bash
herdr agent list                 # 找到 codex 的 TARGET（名字或 id）
herdr agent prompt <TARGET> "读 agent-bridge/briefs/08-miner-concept-cards-backend.md 这份简报，严格按它执行 TASK-PW-63 后端部分；完成后按简报末尾的交付口径汇报。"
```

盯进度用 `herdr agent wait <TARGET> --timeout <ms>`（默认等到 idle/done/blocked），或 `herdr agent read <TARGET> --lines 80` 看输出。codex 反问问题就用 `herdr agent prompt` 回。别轮询刷屏，等状态翻转再看。

## 3. 第二步：验收 codex 交付（不达标就打回）

- 改动范围应只涉及 `src/pw-miner.ts`、`src/pw-miner.test.ts`、`src/main.ts`；动了别的要问为什么
- `PATH="$HOME/.local/node/bin:$PATH" npm run verify` 全绿（PATH 上默认 node 是坏的，必须加前缀）
- 对照简报 8 组测试逐一确认存在且通过
- 检查交付口径：改动文件与行数、测试数、verify 结论、迁移在 mock 库的演练结果
- 缺口写清楚，经 `herdr agent prompt` 打回返工；不验收不进前端

## 4. 第三步：前端（你全权）

新端点（后端交付后可用）：`GET /api/pw/miner/cards?status=`、`POST /api/pw/miner/cards/confirm`（cardId+betId+role）、`/reject`、`/seed`；旧的 `candidates/reject` 沿用（剔单条）。

改 `frontend/src/pw/BoardTab.tsx`（确认区从逐条列表换概念卡视图）+ `frontend/src/lib/api.ts` + `frontend/src/pw/pw.css`。卡面要素：概念标题 + "为什么现在浮出来"（summary）+ 卡型标（自己的记忆/收藏壳）+ 逐字证据列表（snippet 可展开全文、可跳 Memos 原链）+ 整卡动作条（确认挂押注=选押注+统一角色 / 弃 / 标方向种子）+ 单条剔除。视觉沿用 PW-61 大盘的纸感浅色体系。

构建验证：`PATH="$HOME/.local/node/bin:$PATH" npm run verify`。后端跑在 launchd（`com.qinshu.papertable.backend`），代码变更要重启生效。联调后按 TASK「怎么算好」逐条在 http://127.0.0.1:4317 过屏：迁移轮跑完后 51 条积压应已变成概念卡。

## 5. 纪律（继承，违反即返工）

- 真库 `$HOME/Library/Application Support/Papertable/papertable.sqlite3` 只许只读查询，绝不 INSERT/UPDATE/DELETE
- 不 commit、不 push（用户明说才动）；工作树里大量未跟踪/改动文件是用户既有状态，别碰
- 文档两层白话规矩：TASK/验收报告开头先写「这刀是干什么的」「怎么算好」
- 每个用户回合 MemOS 至少一读一写；PW-63 的进展记忆在 papertable cube（memory_id `7aa0a320-d79f-4e72-ad1c-d0fc0dc2caac`），进展用 update_memory 续写
- 捞料/聚合固定 DeepSeek；本刀不动 SIEVE/COLLAB prompt，不需要跑 eval:sieve

## 6. 已做过的（别重复劳动）

- 形式试金石：主会话已把 51 条积压用既有 snippet+reason 聚成 5 张卡给用户验过，形式获认可（记录在 wayfinder Q00）
- 派单通道排查：herdr 当时没起；computer-use/sky 管道与 osascript 注入都试过不通（osascript 后来拿到了辅助功能权限，但既然走 herdr 就不需要它了）；orca 私有 CODEX_HOME 下补过一个 computer-use 符号链接，无害可留
