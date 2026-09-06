# TASK-PW-23 审计地基扩容 · 执行规格

- 日期：2026-08-06
- 状态：**完成并验收（2026-08-06）**——DeepSeek 子代理实现；主代理复跑 verify 113/113 全绿；真实库冒烟：mirror/connection/message(user+assistant) 四条新事件落账正确、旧行零变化
- 批次：`docs/TASK-PW-23-batch.md` 第一刀；依据规格 `docs/SPEC-harness-write-boundary.md` §4/§6
- 主需求域：判断沉淀与复用
- 业务接口：为各域全部写动作提供记账（跨域底座；本刀只扩机制，不改业务语义）
- 数据真值源：`pw_runs`（schema 扩容 + 盲区接线）
- 质量约束与验收终态：账本只增不改不破；盲区逐点落账断言；旧库迁移测试；既有测试全绿；`PATH="$HOME/.local/node/bin:$PATH" npm run verify` 全绿；**main.ts 零改动、frontend/ 零改动、不 commit**

## 一、schema 扩容（`src/pw-runs.ts`）

### 1. kind 与 actor 规则

- kind 枚举扩为：`manual_event / ai_draft / ai_exec / sync / sieve`（新增 `ai_exec` = AI 执行类写入）。
- 合法 (actor, kind) 对白名单：
  - human → `manual_event`
  - system → `manual_event / sync / sieve`
  - ai → `ai_draft / ai_exec`，**外加唯一例外**：(ai, `manual_event`) 仅允许 event_type='message'（协作台 assistant 消息落账）
- 旧规则 `actor=ai 只允许 kind=ai_draft`（pw-runs.ts:152）按上述白名单改写；非法组合照旧 badRequest。

### 2. event_type 枚举扩为 19 个

现有 9 个（create/attach/data_doc/draft/confirm/reject/settle/fetch_propose/sieve_run）+ 新增 10 个：

| 新 event_type | 记什么 | payload 约定 |
|---|---|---|
| `edit` | 押注编辑（PW-24 用，本刀只扩枚举） | {betId, fields} |
| `freeze` | 数据文档冻结（PW-24 用） | {docId, version} |
| `voice` | 观众声音录入 | {voiceId, artifactId, platform} |
| `classify` | 观众声音 LLM 分拣 | {classified, failed} |
| `drop` | 观众声音软丢弃 | {voiceId, reason} |
| `mirror` | 金子镜像同步 | {inserted, total} |
| `corpus` | 语料授权/抓取状态机 | {corpusId, bvid, status, error?}（status ∈ pending/fetching/done/needs_human/failed） |
| `connection` | 平台连接登记/状态变更 | {connectionId, platform, status, source?} |
| `message` | 协作台消息落账（指针式） | {betId, messageId, role, len} |
| `undo` | 冲正（PW-25 用，本刀只扩枚举） | {undoes, targetId} |

### 3. 指令引用两列

`pw_runs` 加列：`instruction_text TEXT`（人指令原话）、`instruction_message_id TEXT`（来源 pw_collab_messages 行 id）。默认 NULL，历史行 NULL。**ai_exec 行必须非空**（helper 层强制，本刀无 ai_exec 调用方，库级不加 CHECK）。

### 4. 迁移

照 `migratePwRunsCheck` 先例整体重建（本表无外键；PW-22 注意：该库 PRAGMA 外键开着，重建前后 OFF/ON 照原样）。检测条件改为：定义串含 `ai_exec` 且含 `instruction_text` → 跳过；否则重建（CREATE pw_runs_v2 带全新 schema → 旧行 SELECT 搬入（instruction 两列补 NULL）→ DROP → RENAME → 重建索引）。`ensurePwRunTables` 的 CREATE IF NOT EXISTS 同步成新 schema。

### 5. 新 helper

```ts
recordPwExecEvent(db, input: PwEventInput & { instructionText: string; instructionMessageId: string })
```

固定 actor='ai'、kind='ai_exec'；instructionText/instructionMessageId 缺一即抛 badRequest；其余走 recordPwEvent 同路（payload_hash 照算）。PW-24/25 的 exec 工具统一走它（本刀不实现工具）。

## 二、审计盲区接线（模块内记账，main.ts 零改动）

与 pick（pw-content-bets.ts:156）/sync（pw-connections.ts:261）/sieve（pw-sieve.ts:669）的模块内先例一致——**在下列模块的写函数尾部 recordPwEvent**，不改函数签名（actor 按调用语义定死）：

| 模块·函数 | event_type | actor | 备注 |
|---|---|---|---|
| pw-voice.ts addPwVoiceItem | voice | human | |
| pw-voice.ts classifyPwVoiceItems | classify | system | payload {classified, failed} |
| pw-voice.ts dropPwVoiceItem | drop | human | |
| pw-corpus.ts authorizePwCorpus | corpus | human | payload {corpusId, bvid, status:'pending', force} |
| pw-corpus.ts markPwCorpusFetching | corpus | system | status='fetching' |
| pw-corpus.ts donePwCorpus | corpus | system | status='done' + comment_count |
| pw-corpus.ts failPwCorpus | corpus | system | status + error |
| pw-connections.ts registerPwConnection | connection | human | |
| pw-connections.ts setPwConnectionStatus | connection | status='needs_human'→system，否则 human | |
| pw-gold-sync.ts mirrorConfirmedGolds | mirror | human | PW-26 改自动后改 actor=system，本刀 human |
| pw-collab.ts 用户消息落库点（:241 附近） | message | human | payload {betId, messageId, role:'user', len} |
| pw-collab.ts assistant 消息落库点（:309 附近） | message | ai（kind=manual_event，白名单唯一例外） | payload 同上 role:'assistant' |

`proposePwCorpus`（fetch_propose）保持既有记账不动。

## 三、测试（新文件 `src/pw-audit-foundation.test.ts`，登记进 package.json）

1. 迁移：构造旧 schema 库（旧枚举、无新列、带历史行）→ ensure → 新列在、ai_exec/新枚举可插、历史行保留且 instruction 两列为 NULL
2. (actor, kind) 白名单矩阵：human+ai_exec 拒、ai+sync 拒、ai+manual_event+非 message 拒、ai+manual_event+message 收、system+sieve 收等
3. recordPwExecEvent：缺 instructionText 或 instructionMessageId 各抛一次；齐备→落行且两列正确、kind=ai_exec、actor=ai
4. 盲区逐点：内存库调上表每个函数 → pw_runs 出现对应 (event_type, actor) 行、payload 关键字段正确（13 个函数逐个断言）
5. append-only：模块不暴露任何 update/delete pw_runs 的导出（断言模块导出名单）
6. 新 event_type 非法值仍拒

## 四、验收硬门（主代理亲自）

1. `PATH="$HOME/.local/node/bin:$PATH" npm run verify` 全绿（含新测试）
2. 真实库冒烟：重启 launchd 后端，触发一次 voice 录入/语料状态/mirror（视可行路径），`sqlite3` 查 pw_runs 出现新 event_type 行；旧行零变化
3. `git diff --stat src/main.ts frontend/` 为空

## 五、明确不做

- exec 工具、查账工具、店规提示词（PW-24）；冲正键（PW-25）；fetch_corpus 自主化（PW-26）
- 硬闸门 B；审计 UI
