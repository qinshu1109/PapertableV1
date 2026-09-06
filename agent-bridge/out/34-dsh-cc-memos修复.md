# 简报 34：dsh-cc MemOS MCP 注册修复（施工报告）

> 角色：dsh-cc 施工执行（依据 34-codex-memos注册排查.md + 34-fix-施工单）
> 范围：按施工单 A 级（preflight+原子启动）、临时缓解（toolWaitAttempts 20）、B1（late-registration）；**不做 B2/B3，不碰生产**。

## 结论一句话

**P0（super-injector 缺失整树失败）当前未在发生**；已完成 preflight+launchd wrapper 原子启动、toolWaitAttempts 10→20、memory-discipline 晚注册补拉（B1，测试 9/9 绿）；重启后新会话实证 **17 个 mcp__memos__\* 工具全部注册**（含施工单要求的 4 个核心）且**热记忆成功注入**，stderr 无 loader error。无阻塞。

## 以下给干活的看

### 1. P0 诊断结论（施工单第 1 项）

- 当前进程 PID 98140 启动于 2026-08-16 02:18:37；`~/Library/Logs/dsh-web.err.log` 的 mtime 停在 **2026-08-15 16:53**，全部 5 个 "plugin tree failed / Cannot find module dsh-super-injector" 错误块均为 8-15 历史遗留（KeepAlive 反复拉起失败）。
- 本次施工重启前的进程启动后 err.log **零新增**；`/health` 200；`node_modules/@dsh-external/dsh-super-injector/lib/index.js` 存在（8-15 16:54）。
- **结论：P0 当前未在发生**（磁盘状态已修复）；剩余 P1（memory-discipline 4.5s 等待预算与异步注册脱节）本次已用 B1 + 调大等待窗口处理。

### 2. A 级 · preflight + 原子启动（施工单第 2 项）

新增文件：
- `~/.dsh/scripts/dsh-web-preflight.mjs`：解析 web profile `cordis.patch.yml`（insert 内 name）+ `package.json` `dsh.profile.bundles`，逐个 `require.resolve`（从 profile 目录解析，与 Loader 同源）+ 入口文件存在性验证；super-injector 特检 `lib/index.js`。失败输出单一明确错误并 exit 1。
  - 说明：真实 `import()` 插件模块会执行顶层代码且依赖宿主解析环境，独立进程无法等价复现，故采用 resolve+存在性验证（覆盖 P0 根因：文件缺失/不可解析）。
- `~/.dsh/scripts/dsh-web-run.sh`：preflight 失败 → 拒绝启动（stderr 明确错误，exit 1）；通过 → `exec dsh web --trusted-host dsh.cozai.net`（保留简报 33 的 trusted-host）。

launchd 改动：
- `~/Library/LaunchAgents/com.deepseek-harness.web.plist`：ProgramArguments 改为 `/bin/sh ~/.dsh/scripts/dsh-web-run.sh`（备份 `com.deepseek-harness.web.plist.bak-34-20260816024358`）。
- 用 `launchctl bootout + bootstrap` 重载（kickstart 不重读 plist，简报 33 已踩过）。
- 验证：启动日志出现 `dsh-web preflight OK (11 loader entries verified: …)` 后接 `dsh web: http://127.0.0.1:3080`，新 PID 21116，loopback:3080 ✅

### 3. 临时缓解（施工单第 3 项）

- `~/.dsh/profiles/web/cordis.patch.yml` memory-discipline 段：`toolWaitAttempts: 10 → 20`（等待窗口 4.5s→约 10s），备份 `cordis.patch.yml.bak-34-20260816024341`。注意 id-targeted patch 整段覆盖，已保留 hotContextTool/autoFetch/toolRetry*/toolVocabulary 其余字段。

### 4. B1 · late-registration 补拉（施工单第 4 项）

`/Users/qinshu/Documents/papertableV1/dsh-plugins/dsh-memory-discipline/`：
- `discipline.js`：新增配置项 `lateRegistrationMaxWaitMs`（默认 120_000，校验 min≥1），KNOWN_KEYS/CONFIG_DEFAULTS/validateConfig/JSDoc 同步。
- `index.js`：
  - 抽出 `fetchHotContext(ctx, config, signal)`（原 retry 执行逻辑，返回 `{ok, notice}`）与 `injectNotice(agent, notice)`。
  - 新增 `armLateRegistration(ctx, config, agent, disposalSignal)`：启动等待预算超时后，**先查一次（覆盖 emit-vs-arm 竞态）**，未注册则监听 `tools/change`；工具出现后 `dispose` 监听器并**同一 session 补拉一次** `get_hot_context` 注入。
  - Guard：`fired` 闩锁防重复注入；`AbortSignal.any([disposal.signal, timeout(lateRegistrationMaxWaitMs)])` 保证随插件卸载/预算到期清理，无孤儿监听；agent 已 dispose 时注入失败仅日志。
  - `seedHotContext` 增加 `disposalSignal` 参数（不能用 maintenance signal——task 返回即结束）；未成功加载（`!ok`）时 arm。
- `tests/discipline.test.js`：新增 lateRegistrationMaxWaitMs 校验/取值用例。
- 测试：`pnpm test` **9/9 通过**；`node --check` index.js/discipline.js 通过。

### 5. 重启验收（施工单第 5 项）

重启（bootout/bootstrap，新 PID 21116）后新建会话 `acceptance34-1786819496`（cwd=/Users/qinshu/Documents/papertableV1，preset=router-standard），经 RPC `session.history` 实证：

| 验收项 | 证据 | 结果 |
|---|---|---|
| 4 个 mcp__memos__* 核心工具 | 放开后最后请求 request/header 含 `mcp__memos__get_hot_context / route_memory / search_memories / add_memory`（实际全量 **17 个** mcp__memos__\* 工具） | ✅ |
| 热记忆注入 | `source: {"kind":"plugin","plugin":"memory-discipline","form":"notice","summary":"Hot memory context loaded at session start."}`，正文含实际 MemOS 数据（active_topics/version 613 等） | ✅ |
| stderr 无 loader error | err.log 本次启动后零新增（mtime 仍 8-15 16:53） | ✅ |
| preflight 原子启动 | 启动日志 `preflight OK (11 entries)` → `dsh web: http://127.0.0.1:3080` | ✅ |
| web 正常 | /health 200、首页 200、RPC session.list 200 | ✅ |

备注：模型**首轮**只见核心工具集（bash/edit/read/write）是 router-standard preset 的 router-bootstrap **设计行为**（首个 tool/call 后放开完整目录）；MCP 工具在第一个工具调用后可见，非注册故障。热记忆注入不受该限制（插件直接 execute，不经模型选择）。

### 6. 改动清单

- 新增：`~/.dsh/scripts/dsh-web-preflight.mjs`、`~/.dsh/scripts/dsh-web-run.sh`
- 修改：`~/Library/LaunchAgents/com.deepseek-harness.web.plist`（wrapper）、`~/.dsh/profiles/web/cordis.patch.yml`（toolWaitAttempts 20）
- 修改：`dsh-plugins/dsh-memory-discipline/{discipline.js,index.js,tests/discipline.test.js}`
- 备份：plist `.bak-34-20260816024358`、patch `.bak-34-20260816024341`
- 未做：B2/B3；未碰生产服务器、未动 Clash；dsh 仍 loopback-only。

### 7. 阻塞

无。遗留观察：MCP 工具首轮不可见源于 router-bootstrap 设计（非本次范围）；若希望首轮即见 MemOS 工具，需另议 router-standard 的 core 工具集配置。
