# 简报 41：镇纸 / 纸桌现状只读摘要

- 快照时刻：2026-08-25 18:46–18:50 CST（接口时间戳 `2026-08-25T10:47:06Z`）
- 真值仓库：`/Users/qinshu/Documents/papertableV1`
- 性质：只读核对。不改代码、不重启服务、不写业务表、不做联网调研、不给建议。
- 查不到的标「未查到」。本文件只摆事实与出处。

---

## 1. 两产品现状

### 1.1 同一进程、两个区域

`frontend/src/App.tsx`：`area` 为 `'explore' | 'pw'`，右下角 tab「探索 / 镇纸」。

后端同一 Node 进程：`src/main.ts` `HOST=127.0.0.1` `PORT=4317`。库默认 `~/Library/Application Support/Papertable/papertable.sqlite3`（`src/data.ts` `openDataStore`）。

### 1.2 纸桌 Papertable（`area === 'explore'`）已挂载的界面

`frontend/src/App.tsx` 探索区一次性挂载：

| 部件 | 文件 |
|---|---|
| 项目侧栏 | `frontend/src/components/ProjectSidebar.tsx` |
| 卡片舞台 | `frontend/src/components/CardStage.tsx` |
| 对话条 | `frontend/src/components/Composer.tsx` |
| 右侧关系图 | `frontend/src/components/GraphNavigator.tsx` |
| 判决面板 | `frontend/src/components/VerdictPanel.tsx` |
| 导入 / 导出 / 设置 / 回收站弹层 | `frontend/src/components/Dialogs.tsx` |
| 移动端顶部横向迷你导航 | `App.tsx` `mini-nav` |

不是镇纸那种「多屏导航」；探索区是单工作区。`GET http://127.0.0.1:4317/` 返回 HTML，`<title>` 为「纸桌 Papertable · 图结构知识探索」。

### 1.3 镇纸 Paperweight 已挂载的屏

`frontend/src/pw/PaperweightApp.tsx`：`PwScreen` 九个 id，顶栏全部可点：

| id | 顶栏文案 | 组件 |
|---|---|---|
| `home` | 首页 | `Home.tsx`（闭环六节点文案：起心动念 / 想清楚 / 押注 / 开干 / 数据回流 / 结账；目标常量 `GOAL_TOTAL = 10`） |
| `workbench` | 押注台 | `Workbench.tsx` |
| `vault` | 金子墓碑库 | `Vault.tsx` |
| `collab` | 协作台 | `Collab.tsx` |
| `voice` | 观众声音 | `Voice.tsx` |
| `ops` | 运维 | `Ops.tsx` |
| `sources` | 数据源 | `Sources.tsx` |
| `dashboard` | 大盘 | `Dashboard.tsx` |
| `notes` | 笔记 | `Notes.tsx` |

文件头注释仍写「八屏」；类型与顶栏实际是九屏（含运维）。

### 1.4 4317 现在跑着

| 项 | 值 | 依据 |
|---|---|---|
| 监听 | `127.0.0.1:4317` LISTEN，PID **5071** | `lsof -nP -iTCP:4317 -sTCP:LISTEN` |
| launchd | `com.qinshu.papertable.backend` **running**，pid=5071 | `launchctl print gui/$(id -u)/com.qinshu.papertable.backend` |
| plist | `ProcessType=Interactive`；`caffeinate -i` + `node …/src/main.ts` | `~/Library/LaunchAgents/com.qinshu.papertable.backend.plist` |
| HTTP | `GET /api/status` **HTTP 200** | `curl -sS -m 8 -D - http://127.0.0.1:4317/api/status` |
| 正文 | `ready=true`；`node=v24.18.0`；`modelConfigured=true`；`protocol=openai-completions`；`memory.available=false` `error="fetch failed"`；`verdicts.available=true` `pending=0` `failed=0` `usingLocalCache=false` | 同上 JSON |

前端 launchd `com.qinshu.papertable.frontend` **running**，PID **5057**，参数 `--host 0.0.0.0 --port 5173`。`lsof` 显示 `*:5173` LISTEN。`curl http://127.0.0.1:5173/` 在 2s / 5s 内均 0 字节超时。本快照未再往下查原因。

### 1.5 数据库真实行数

库文件：`/Users/qinshu/Library/Application Support/Papertable/papertable.sqlite3`（`sqlite3` 只读查询，2026-08-25 18:47 CST）。

**纸桌 `pt_*`：**

| 表 | 行数 |
|---|---:|
| pt_projects | 39 |
| pt_cards | 105 |
| pt_edges | 65 |
| pt_runs | 130 |
| pt_verdicts | 8（gold/confirmed 3；tombstone/confirmed 3；tombstone/proposed 2） |
| pt_documents | 5011 |
| pt_chunks | 20284 |
| pt_run_events | 6446 |
| pt_run_sources | 17888 |
| pt_verdict_events | 3 |
| pt_stage_exports | 149 |
| pt_promotions | 0 |

**镇纸镜金：** `pw_gold_mirror` = **3**（与 `GET /api/pw/golds` → `golds.length=3` 一致）。

**镇纸 `pw_*` 业务表（FTS 内部表另列）：**

| 表 | 行数 | 表 | 行数 |
|---|---:|---|---:|
| pw_bets | 0 | pw_verdicts | 0 |
| pw_settle_drafts | 0 | pw_proposals | 0 |
| pw_collab_messages | 0 | pw_content_drafts | 0 |
| pw_content_draft_edits | 0 | pw_draft_events | 0 |
| pw_draft_blacklist | 0 | pw_artifacts | 0 |
| pw_data_docs | 0 | pw_corpus_docs | 0 |
| pw_connections | 1 | pw_runs | 1 |
| pw_gold_mirror | 3 | pw_verdict_exposures | 8 |
| pw_verdict_refs | 0 | pw_verdict_promotions | 0 |
| pw_recall_events | 0 | pw_precedent_dispositions | 0 |
| pw_sieve_cards | 0 | pw_sieve_runs | 0 |
| pw_sieve_state | 0 | pw_voice_items | 0 |
| pw_voice_sieve_items | 0 | pw_voice_sieve_runs | 0 |
| pw_voice_theme_cards | 0 | pw_voice_theme_card_items | 0 |
| pw_voice_card_runs | 0 | pw_voice_tracks | 0 |
| pw_voice_track_videos | 0 | pw_miner_runs | 7 |
| pw_miner_candidates | 0 | pw_miner_cards | 0 |
| pw_note_attach | 20 | pw_note_insights | 3 |
| pw_note_rollups | 145 | pw_note_value_daily | 2 |

`pw_corpus_fts*` 为 FTS 内部结构（config=1 / data=418 / idx=416 / content=0 / docsize=0），不是语料正文行。

`GET /api/pw/bets` → `{"bets":[]}`。`GET /api/pw/connections` → 1 条：`platform=B站` `account_label=琴疏的B站` `status=active` `created_at=2026-08-19T10:36:50.746Z` `last_sync_at=null` `docs_count=0`。

简报 40 清场记录（`agent-bridge/out/40-清场重录.md`，2026-08-19）：`pw_bets` 等测试数据已清；`pt_*`、`pw_gold_mirror`、Memos、笔记派生表保留。清场后当场 `pw_connections=0`；本快照该表已有 1 行（与 `pw_runs` 那条 `connection` 同时，见第 6 节）。

**笔记行数**见第 2 节（真值在 Memos，不在 `papertable.sqlite3`）。

---

## 2. 笔记链路

### 2.1 飞书 → Memos

代码：`src/pw-feishu-relay.ts`。职责写明：飞书长连接收 **p2p 文本** → message_id 去重 → 写 Memos 官方 API → 回执「已记」。不 import `main.ts`，不写镇纸库。群消息不收；`post` / `image` 会 skip。

本机状态：

| 项 | 值 | 依据 |
|---|---|---|
| 进程 | launchd `com.qinshu.papertable.feishu-relay` **running**，PID **5058** | `launchctl print` |
| Memos | `127.0.0.1:5230` LISTEN，PID **5048**；launchd `com.qinshu.memos` running | `lsof` + `launchctl` |
| 配置路径 | `~/Library/Application Support/Papertable/feishu-relay.json` | 中继日志 `{"event":"started","config":"…"}` |
| 末次成功写入 | `{"event":"written","memo":"memos/BchA7nre9FW4j2eVBvmx7w"}` | `~/Library/Logs/Papertable/feishu-relay.log` |
| 该条笔记 | `2026-08-23 11:29:11` 本地；内容「笔记项目应该后台自动化。然后DSH手机端应该要弹出通知给我」`#速记` | Memos SQLite + `GET /api/pw/notes?limit=1` |
| 当前日志尾 | 一次 `shutdown` 后再次 `started` / `ws client ready`，随后多条 `[ws] reconnect`；error log mtime 停在 2026-08-23 11:29；主 log mtime 2026-08-25 14:54 | 同上日志 |
| 本快照 | **未**向飞书机器人发测试消息 | — |

TASK-PW-52 文档（`docs/TASK-PW-52-batch.md`，2026-08-10）把飞书入口定义为：手机飞书 p2p 一句话 → Memos → 镇纸笔记屏可见。

### 2.2 Memos 条数与近 7 天

库：`~/Library/Application Support/memos/memos_prod.db`。`GET /api/pw/notes/status` → `{"ok":true,"path":"/Users/qinshu/Library/Application Support/memos/memos_prod.db"}`。

| 口径 | 数 | 依据 |
|---|---:|---|
| `row_status=NORMAL` | 541 | `SELECT row_status, count(*) FROM memo GROUP BY 1` |
| `row_status=ARCHIVED` | 2 | 同上 |
| 合计 | 543 | `SELECT count(*) FROM memo` |

近 7 天（产品接口，日历窗 2026-08-19…25）：

`GET /api/pw/notes/stats?days=7`：

| date | count |
|---|---:|
| 2026-08-19 | 2 |
| 2026-08-20 | 6 |
| 2026-08-21 | 1 |
| 2026-08-22 | 1 |
| 2026-08-23 | 1 |
| 2026-08-24 | 0 |
| 2026-08-25 | 0 |
| **合计** | **11** |

SQLite `created_ts >= now-7 days` 另含 **2026-08-18 = 2**（该窗比接口日历窗多一天）。2026-08-24、2026-08-25 两条口径都是 0。

### 2.3 镇纸读 Memos 的接口

读函数在 `src/pw-notes.ts`：只读打开 Memos SQLite（`DatabaseSync(..., { readOnly: true })`），归档不返回；每次调用即开即关。`readPwNotesByDay` 存在于该文件，**没有**对应 HTTP 路由。

`src/main.ts` 已挂笔记相关 HTTP：

**GET（读）：**

- `/api/pw/notes/status`
- `/api/pw/notes/search`
- `/api/pw/notes/stats`
- `/api/pw/notes/tags`
- `/api/pw/notes/recall`（query `betId` 必填）
- `/api/pw/notes`
- `/api/pw/notes/board`
- `/api/pw/notes/journey`
- `/api/pw/notes/tree`
- `/api/pw/notes/insight`
- `/api/pw/notes/rollups`
- `/api/pw/day-summary`（收工小结，不是 Memos 列表）

**POST（人触发/巡检，不是 Memos 写入）：**

- `/api/pw/notes/tree/attach`
- `/api/pw/notes/tree/keyword`
- `/api/pw/notes/tree/tick`
- `/api/pw/notes/insight`
- `/api/pw/notes/rollups/tick`

飞书写 Memos 走中继进程的 Memos HTTP API，不走上述 4317 路由。

---

## 3. 已有的自动 / 定时能力

均在 `src/main.ts` 服务启动后注册（调用处 try/catch，异常记日志）。

### 3.1 后端常驻

| 定时器 | 周期 | 做什么 | 产出落点 / 可见接口 |
|---|---|---|---|
| `idleTimer` | 60s | `memory.stageIdleCards` → `memory.retryPending` → `retryPendingVerdicts` → `promotions.retryPendingReconciles` → `sieve.tickWatermark` | 纸桌记忆/判决重试、筛子水位。本快照 `GET /api/status` 的 `memory.available=false`（`fetch failed`）；`verdicts.pending=0` `failed=0`。筛子表 `pw_sieve_*` 均为 0 |
| `runRollupTick` | 启动 1 分钟首跑，之后 **30 分钟** | `runPwNoteRollupTick`（TASK-PW-58；模块 `src/pw-note-rollup.ts` 不自带定时器） | 表 `pw_note_rollups`：day 119 / week 21 / month 5，合计 145。最新：week `2026-W34` `2026-08-23T16:20:14.778Z`；day `2026-08-23` `2026-08-23T16:18:44.902Z`。`GET /api/pw/notes/rollups` |
| `runMinerTick` | 启动 1 分钟首跑，之后 **5 分钟** 检查是否过本地 **06:30**；当天 scheduled 已跑则幂等跳过（TASK-PW-61） | `runPwMinerScheduledTick`；成功才 `snapshotPwNoteValues` | 表 `pw_miner_runs` 现 7 行，**全部** `trigger_kind=scheduled`，`status` 均以 `failed:401` 开头（正文含 `Authentication Fails, Your api key: ****33b1 is invalid`）。时间：2026-08-19 10:34Z、19 22:34Z、20–24 各约 22:3xZ。`pw_miner_candidates=0` `pw_miner_cards=0`。`GET /api/pw/miner/candidates` 返回含 `groups` 的 JSON |

SSE 路由里另有 15s `keepalive` 心跳（`src/main.ts`），不是业务巡检。

飞书中继是事件驱动长连接，不是 cron。

### 3.2 dsh 侧与「定时」相关、但不是 4317 后端

`dsh-plugins/dsh-paperweight/src/host/index.ts`：插件启动 10s 后 `push.refresh()`，之后 **每小时** 再刷。本地收件箱文件 `/Users/qinshu/.dsh-source/papertable/dsh-paperweight/push-feed.json`（mtime 2026-08-25 17:50）：`items=31`（kind：due 21 / daily 10），`unread=29`，`lastDailyDate=2026-08-25`；最新一条 `2026-08-24T16:42:51.372Z` kind=`daily` 标题「今日值得看」。这是插件本地 feed，不是镇纸表。

仓库有 `dsh-plugins/dsh-scheduled-prompt/`（依赖 croner）。**当前正在跑的** dsh web profile（`DSH_HOME=/Users/qinshu/.dsh-source`，`~/.dsh-source/profiles/web/package.json`）**未**列入该插件。它出现在 **未在跑** 的 `~/.dsh/profiles/web/package.json`。

---

## 4. dsh 插件计划状态

### 4.1 简报 36 原文分期

`agent-bridge/briefs/36-pw-dsh-plugin-plan-v1.md`（2026-08-16，文内状态栏写「待琴疏拍板」）：

- **P0**：押注台 + 金子墓碑库进 dsh；`@押注卡`；只读查数工具；无写操作
- **P1**（闸门：P0 真用起来）：独立「镇纸」区；定时推送不进会话列表；观众声音；AI 只许起草、人点确认
- **P2**（闸门：P1 连续 7 天推式成立）：到期提醒进左栏未读；旧笔记只读到场；纸感浅色；手机用域名打开 dsh，不再绕微信
- 地基：社区 `dsh-plugin-marketplace`（AwesomeHou）
- 闸门写在计划里：P0 过了才开 P1，P1 过了才开 P2

计划正文把六屏映射为「押注台、金子墓碑库、协作台、观众声音、运维数据源、大盘笔记」。

### 4.2 之后实际落地的简报产出

| 简报 | 日期 | 产出里写明的结果 |
|---|---|---|
| 37 | 2026-08-17 | `agent-bridge/out/37-acceptance.md`：**8 / 8 通过**。dsh 左栏镇纸六区读 4317；9 个工具（8 只读 + `pw_draft_bet`）；人按钮确认；推送区独立；纸感浅色；手机形态截图；插件市场可见 `@papertable/dsh-paperweight v0.1.0` |
| 38 | 设计 | `out/38a-context-content-design.md`、`out/38b-dsh-capability-check.md`（本快照未逐字复述） |
| 39 | 2026-08-17 | `out/39-impl-progress.md` + papertable Cube 记忆 `d6b8e266-…` / `62bc383b-…`：导览段 `papertable:workbench-guide` order 110、session-start notice、preset `pw-paperweight`（fork router-flash，原件未改）；记录称 A1–A8 / B1–B4 后来有真 Web 证据 |

36 的「P0→P1→P2 闸门分期」与 37「一次交六屏」在文档上并存：37 成绩单按六屏+推送+起草一次验收，不是按 36 的闸门分三次关闭。

### 4.3 仓库 `dsh-plugins/` 目录（代码在）

`/Users/qinshu/Documents/papertableV1/dsh-plugins/`：

- `dsh-paperweight/`
- `dsh-scheduled-prompt/`
- `dsh-wechat/`
- `dsh-guardrails/`
- `dsh-memory-discipline/`
- `dsh-proposal-gate/`
- `dsh-routing-suite/`
- `dsh-time-context/`
- `memos-mcp-overlay/`

### 4.4 正在跑的 dsh web 实际装了什么

进程：`127.0.0.1:3080` LISTEN，子 PID **6153**；父 launchd `com.deepseek-harness.web` PID **5046**。`DSH_HOME=/Users/qinshu/.dsh-source`；cwd=`/Users/qinshu/Documents/ChatGPT/MemOS/deepseek-harness`。`GET http://127.0.0.1:3080/` HTTP 200。命令行含 `--trusted-host dsh.cozai.net`。

`~/.dsh-source/profiles/web/package.json` `dsh.profile.bundles`：

1. `@deepseek-ai/dsh-base`
2. `@deepseek-ai/dsh-web-app`
3. `@dsh-external/dsh-mobile-nav`
4. `dsh-plugin-marketplace`
5. `@papertable/dsh-paperweight`（`link:/Users/qinshu/Documents/papertableV1/dsh-plugins/dsh-paperweight`）
6. `dsh-jspace-suite`

**未**出现在该运行 profile：`dsh-wechat`、`dsh-scheduled-prompt`、`dsh-guardrails`、`dsh-memory-discipline`、`dsh-proposal-gate`、`dsh-time-context`。这些名字在 `~/.dsh/profiles/web/package.json` 里，该目录 **不是** 当前 3080 进程的 `DSH_HOME`。

---

## 5. 手机 / 推送 / 微信 / 飞书 / 隧道既有零件

### 5.1 本仓库与本机已存在的零件

| 零件 | 现状（本快照） | 依据 |
|---|---|---|
| 飞书 → Memos 中继 | 独立 LaunchAgent，在跑；末次 written 2026-08-23 | 第 2 节 |
| dsh-paperweight 左栏推送收件箱 | 本地 `push-feed.json` 31 条，小时刷新；不是 iOS 系统通知 | `dsh-plugins/dsh-paperweight/src/host/push.ts` + 该 json |
| Cloudflare 隧道 | launchd `com.cloudflared.dsh-cozai` **running** PID **5066** | `launchctl print` |
| dsh-wechat（iLink） | 源码在 `dsh-plugins/dsh-wechat/`；**不在**当前 `.dsh-source` web bundles | 目录 + 运行 profile `package.json` |
| 本机 Bark / ntfy / PushPlus / Server酱 / Telegram 推送配置 | **未查到**（本快照未在仓库与 LaunchAgents 名称中看到这些服务） | `ls ~/Library/LaunchAgents` 与仓库检索未作为本任务专项穷尽第三方 App 目录 |

### 5.2 简报 26–33 结论（各一份既有产出，一句话）

| 简报 | 产出文件 | 文内结论一句话 |
|---|---|---|
| 26 | `out/26-wechat-search-codex.md`（2026-08-14） | 若做 MVP，文内推荐企业微信自建应用；个人号 wechaty/itchat/gewechat/文件传输助手不作为可承诺稳定通道 |
| 27 | `out/27-openclaw-official-research.md`（2026-08-14） | 微信 ClawBot + `@tencent-weixin/openclaw-weixin` + iLink 是官方产品线，可主动 `sendMessage`，但不是无限期 Bot API / 主动推送 SLA |
| 28 | `out/28-wechat-progress.md`（2026-08-15） | dsh-wechat（iLink）已移植装配进当时的 cc-tui profile，fake 链路通过；该文记录当时 w4:p4 进程尚未加载插件、真机收发待重启后再验 |
| 29 | `out/29-codex-cwd排查.md` | 微信 `/new` 会话 header 无 `cwd`，persona `{{cwd}}` 解析失败；网页/CLI 会话有 cwd |
| 30 | `out/30-codex-通道能力盘点.md`（2026-08-15） | 微信 `/new` 建的是未 mount preset 的裸 agent（skills 不可用，host 全局工具仍可继承）；仓库没有完整飞书 DSH agent 通道，`pw-feishu-relay` 只记笔记不建 agent |
| 31 | `out/31-dsh-cc-手机访问本机web.md` | 当时结论：dsh web 无鉴权，公网隧道禁止；本机尚未装 Tailscale/cloudflared；私密路径停在请示 |
| 32 | `out/32-codex-远程访问方案对比.md`（2026-08-15） | 文内唯一推荐：Cloudflare 命名隧道 + Access 精确邮箱 OTP；origin 保持 `127.0.0.1:3080` |
| 33 | `out/33-dsh-cc-cloudflare隧道落地.md` | **已完成并常驻**：`https://dsh.cozai.net` → Access（`zhouxiangrui1109@gmail.com` + OTP）→ 本机 3080；LaunchAgent `com.cloudflared.dsh-cozai` |

31 的「未装隧道」与 33 的「已常驻」按时间顺序后者覆盖前者；本快照进程与 33 一致（隧道 LaunchAgent running）。

本快照 **未** 从公网再打一次 `https://dsh.cozai.net`（简报禁止联网调研）。

---

## 6. 使用现状（近 7 天客观记录）

「近 7 天」按快照日 2026-08-25 往回看 2026-08-19…25。下列都是表或接口，不是屏幕观察。本快照 **未** 查看琴疏屏幕或键鼠。

### 6.1 镇纸协作台 / 动作流水

`GET /api/pw/activity-daily?days=7`：

| day | human | ai | system |
|---|---:|---:|---:|
| 2026-08-19 | 1 | 0 | 0 |
| 2026-08-20 | 0 | 0 | 0 |
| 2026-08-21 | 0 | 0 | 0 |
| 2026-08-22 | 0 | 0 | 0 |
| 2026-08-23 | 0 | 0 | 0 |
| 2026-08-24 | 0 | 0 | 0 |
| 2026-08-25 | 0 | 0 | 0 |

`GET /api/pw/mode-bar`：`lastActivityAt=2026-08-19T10:36:50.753Z`；`pendingReview` 全 0；`recentRuns` 仅 1 条 `kind=manual_event` `eventType=connection`。

`pw_runs` 全表 1 行：`2026-08-19T10:36:50.753Z` actor=`human` kind=`manual_event` event_type=`connection` payload 含 B站连接 id `626f85a0-…` status=`active`。

`GET /api/pw/day-summary`（date 默认当天）：`totalEvents=0`；导出文本含「今天没有协作台事件。」`noteEcho.status=no_bets`。

`GET /api/pw/collab/pending-queue`：三类队列皆 `[]`。`GET /api/pw/recall-events?limit=5`：`events=[]`。`pw_collab_messages=0` `pw_proposals=0` `pw_bets=0`。

### 6.2 纸桌探索运行

`pt_runs` 按 `created_at` 最近两条：

| created_at | status | question 前 80 字 |
|---|---|---|
| 2026-08-19T10:34:36.348Z | ended | 你是谁 |
| 2026-08-12T04:06:09.992Z | ended | （本条已出近 7 天窗） |

近 7 天 `pt_runs` 只有 2026-08-19 这 1 条。`pt_run_events` 在 2026-08-19 有 18 行；2026-08-20…25 为 0。

### 6.3 笔记（人经飞书/Memos 写入）

2026-08-19…23 有新增（接口合计 11 条）；2026-08-24、2026-08-25 为 0。最新一条仍是 2026-08-23 11:29 的 `#速记`。卷积日报最新 period 也停在 `2026-08-23`。

### 6.4 系统后台自己还在写的痕迹

- 矿工 scheduled：2026-08-19…24 每天一条 401 失败（第 3 节）
- dsh-paperweight daily feed：2026-08-20…24 各 1 条「今日值得看」（第 3.2 节）
- 飞书中继进程 2026-08-25 仍 running，日志有 reconnect

以上三条 **不能** 当作「人打开了镇纸大屏或探索区」的证据。

### 6.5 未查到的使用信号

- 未查到独立于 `pw_runs` / `activity-daily` / `day-summary` / `mode-bar` 的另一张「协作台事件」表有近 7 天人操作
- 未查到 2026-08-20 之后任何 `pt_runs` 或 `pw_runs` 人动作
- 未做屏幕侧「琴疏是否打开过 4317 页面」的观测

---

## 附录：本快照用过的命令

```text
date
lsof -nP -iTCP:4317,5230,3080,5173 -sTCP:LISTEN
launchctl print gui/$(id -u)/com.qinshu.papertable.backend
launchctl print gui/$(id -u)/com.qinshu.papertable.feishu-relay
launchctl print gui/$(id -u)/com.qinshu.papertable.frontend
launchctl print gui/$(id -u)/com.qinshu.memos
launchctl print gui/$(id -u)/com.deepseek-harness.web
launchctl print gui/$(id -u)/com.cloudflared.dsh-cozai
ps eww -p <3080-pid>
sqlite3 "$HOME/Library/Application Support/Papertable/papertable.sqlite3" …
sqlite3 "$HOME/Library/Application Support/memos/memos_prod.db" …
curl http://127.0.0.1:4317/api/status
curl http://127.0.0.1:4317/api/pw/notes/status
curl 'http://127.0.0.1:4317/api/pw/notes/stats?days=7'
curl http://127.0.0.1:4317/api/pw/day-summary
curl http://127.0.0.1:4317/api/pw/mode-bar
curl 'http://127.0.0.1:4317/api/pw/activity-daily?days=7'
curl http://127.0.0.1:4317/api/pw/golds
curl http://127.0.0.1:4317/api/pw/bets
curl http://127.0.0.1:4317/api/pw/connections
curl 'http://127.0.0.1:4317/api/pw/notes?limit=1'
curl http://127.0.0.1:4317/api/pw/notes/rollups?kind=day
```
