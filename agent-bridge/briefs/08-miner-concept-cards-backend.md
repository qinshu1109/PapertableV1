# 简报 08：捞料概念卡后端（TASK-PW-63）

> 给 Codex 的执行规格。仓库：`/Users/qinshu/Documents/papertableV1`。先读 `docs/TASK-PW-63-miner-concept-cards.md`（任务真值源）与 `docs/wayfinder/miner-concept-cards/`（决策依据），再动手。不 commit、不 push。

## 背景一句话

PW-61 的捞料确认区（逐条原文候选）被数据证伪：51 条积压只处理过 2 条。用户拍板改成「概念卡 + 逐字证据」——捞料逻辑不动，同轮追加一次聚合调用把候选归成卡，卡级动作替代逐条确认。顺修一个调度 bug。

## 环境纪律

- 本机 node 必须用 `PATH="$HOME/.local/node/bin:$PATH"` 前缀（PATH 上默认 node 是 ChatGPT 应用内置的坏 node，会断前端构建）。
- 验收命令：`PATH="$HOME/.local/node/bin:$PATH" npm run verify` 全绿。
- 真实库 `$HOME/Library/Application Support/Papertable/papertable.sqlite3` 只许只读查询对账，绝不手工 INSERT/UPDATE/DELETE。

## 改动清单

### 1. `src/pw-miner.ts`（主战场）

**a) 新表 + 扩列**（进 `ensurePwMinerTables`，幂等）：

```sql
CREATE TABLE IF NOT EXISTS pw_miner_cards (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('concept','self_memory','link_shell')),
  title TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL CHECK(status IN ('suggested','confirmed','rejected','direction_seed')),
  decided_bet_id TEXT, decided_role TEXT,
  decided_at TEXT, created_at TEXT NOT NULL
);
-- pw_miner_candidates 加 card_id TEXT（参照既有 PRAGMA table_info + ALTER 模式）
```

**b) 聚合步骤**：`runPwMiner` 落完候选后，同轮追加一次 DeepSeek 调用：

- 输入：本轮新候选 + 现存全部 `status='suggested'` 候选（按 `source+ref_uid` 去重；含 snippet、reason、suggested_bet_id、押注标题表）。
- 输出 JSON：`[{kind,title,summary,suggestedBetId?,candidateKeys[]}]`，`candidateKeys` 元素 = `{source,refUid}`。
- 解析纪律照 `parseCandidates` 的容错模式（正则取数组、逐项校验、坏项丢弃）。`candidateKeys` 对不上真实候选的丢弃；没被任何卡认领的候选落一张兜底卡（kind=concept，title=「未归堆」）。
- 重聚语义：suggested 候选允许换卡（更新 card_id）；confirmed/rejected 候选与其卡一律不动。
- 卡型判断写进 prompt：`self_memory` = 内容是人自己的决策/拍板记忆回流（memos 源为主）；`link_shell` = 只有链接/凭证、没有人的想法；其余 concept。AI 只标不藏。
- 成本：捞 + 聚两笔都记进 `pw_miner_runs`（cost 合并、raw_response 追加聚合原文，超 4000 字截断照既有模式）；合计 > ¥0.15 报错走既有 failed 路径。预算常量 `PW_MINER_BUDGET_CNY` 从 0.1 调到 0.15，注释写明含聚合。

**c) 调度 bug 修复**（`runPwMinerScheduledTick`）：现状拿 `substr(started_at,1,10)`（UTC 日期）比 `localDay(now)`（本地日期），每天 06:30-08:00（UTC+8）窗口内对不上 → 每 5 分钟补跑。台账证据：2026-08-10 23:48~2026-08-11 00:03 UTC 连跑 17 轮。修复：两端统一本地日口径（比较时把 started_at 转本地日，或 runs 表记本地日列），加跨日边界回归测试（注入 `now` 构造 UTC/本地差一天的场景）。

**d) 卡 CRUD**（新函数，HTTP 错误照 `httpError` 模式）：

- `listPwMinerCards(db, status='suggested')` → 卡数组，每卡含 `items`（卡内候选：id/source/snippet/reason/memosUrl/status）与 suggestedBetId 对应的押注标题。
- `confirmPwMinerCard(db, { cardId, betId, role })` → 事务：卡置 confirmed（记 decided_bet_id/role/decided_at）；卡内仍 suggested 且 source=note 的候选逐条复用 `confirmPwNoteAttach`；其余候选置 confirmed。押注不存在 404、卡非 suggested 409、role 非法 400（复用 `PW_NOTE_ROLES`）。
- `rejectPwMinerCard(db, cardId)` → 卡 rejected + 卡内 suggested 候选 rejected（同事务）。
- `seedPwMinerCard(db, cardId)` → 卡置 direction_seed（只落标记，无副作用）。

**e) 迁移函数**：把现存全部 suggested 候选跑一次聚合（复用 b 的同一段代码路径），作为一次 manual run 落台账。幂等：重跑不产生重复卡（已归卡候选跳过或换卡，不新增）。

### 2. `src/main.ts`

挂 4 条新路由（既有 pw 路由区，照 miner 既有写法）：

| 路由 | 方法 | 函数 |
|---|---|---|
| `/api/pw/miner/cards` | GET | `listPwMinerCards`（status 参数校验同 candidates） |
| `/api/pw/miner/cards/confirm` | POST | `confirmPwMinerCard` |
| `/api/pw/miner/cards/reject` | POST | `rejectPwMinerCard` |
| `/api/pw/miner/cards/seed` | POST | `seedPwMinerCard` |

既有 `/api/pw/miner/candidates*` 全部保留不动。

### 3. 测试（`src/pw-miner.test.ts` 追加，mock LLM 照既有注入模式）

1. 聚合解析：合法 JSON 归卡正确；坏 JSON/坏项丢弃；未认领候选落「未归堆」兜底卡。
2. 重聚换卡：suggested 候选换卡成功；confirmed/rejected 不动。
3. 整卡确认：note 源候选进 `pw_note_attach`（角色正确）、非 note 源只置 confirmed、卡状态/押注校验/幂等。
4. 整卡弃：卡 + 候选联动 rejected；下轮捞取读到 rejected 降权（既有机制回归）。
5. 方向种子：状态翻转、无任何副作用（不建押注不改方向）。
6. 调度回归：注入跨日边界的 `now`，同一本地日 scheduled 只跑一轮。
7. 成本护栏：捞 + 聚合计超 ¥0.15 走 failed。
8. 迁移幂等：对同一批 suggested 跑两次，卡数不翻倍。

## 明确不做

- 不动前端任何文件（前端 Kimi 另改）。
- 不动 SIEVE/COLLAB prompt，不动全局激活 provider。
- 不做语义向量、不做跨轮并卡（wayfinder MAP「Not yet specified」有账）。
- 不删 51 条存量候选、不手工改库。

## 交付口径

简报回复里写清：改动文件与行数、测试数（X/X 绿）、verify 输出结论、迁移在 mock 库的演练结果。主代理验收后联调前端。
