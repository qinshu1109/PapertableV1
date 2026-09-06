# 简报34：dsh web 的 MemOS MCP 注册排查

## 结论先说

dsh 的 MemOS 工具不是因为 MemOS HTTP 服务响应慢而缺失。最强证据是 dsh web 曾在启动阶段因 `@dsh-external/dsh-super-injector/lib/index.js` 不存在而整棵 Cordis 插件树失败；该时段 `memory-memos` 和 `memory-discipline` 都不会进入可用状态，于是新会话只能看到“工具未在启动时限内注册”。当前文件已存在，dsh 进程自 2026-08-16 02:18:37 持续运行，health=200；旧 stderr 不能直接等同于当前仍失败。

仍有一个独立的设计风险：`memory-discipline` 在 `agent/session-start` 只轮询全局工具表 10 次、间隔 500ms，最坏约 4.5s。MCP 注册若因插件竞争、HMR 或重连晚到，4.5s 后会注入 unavailable notice，之后没有 late-registration 补拉机制。

## 1. 实际注册链路

源码仓库：`/Users/qinshu/Documents/ChatGPT/MemOS/deepseek-harness`

1. web profile 的 `cordis.patch.yml` 插入 `memory-memos`，包名 `@deepseek-ai/dsh-mcp-client`，`serverName: memos`，URL 由 `MEMOS_MCP_URL` 注入（[cordis.patch.yml](/Users/qinshu/.dsh/profiles/web/cordis.patch.yml:10)）。
2. `mcp-client.apply()` 创建连接并 `await connection.ready`；配置默认 `failOnStartupError: false`，所以首次失败会记录并进入重连，而不是让该 MCP 实例把失败抛出（[index.ts](/Users/qinshu/Documents/ChatGPT/MemOS/deepseek-harness/packages/mcp/mcp-client/src/index.ts:107)）。
3. `connectGeneration()` 依次执行 transport connect、`enqueueSync()`（[connection.ts](/Users/qinshu/Documents/ChatGPT/MemOS/deepseek-harness/packages/mcp/mcp-client/src/connection.ts:237)）。
4. `syncTools()` 调用 MCP `tools/list`，将服务端工具注册为 `mcp__memos__<tool>`，完整成功后才交换进全局 `ctx.tools`（[tools.ts](/Users/qinshu/Documents/ChatGPT/MemOS/deepseek-harness/packages/mcp/mcp-client/src/tools.ts:128)）。
5. 初次失败后按 500ms、1s、2s……退避重连，最多 10 次；没有额外的 MCP 专用启动硬超时（[connection.ts](/Users/qinshu/Documents/ChatGPT/MemOS/deepseek-harness/packages/mcp/mcp-client/src/connection.ts:192)）。
6. Cordis boot 等待插件树 settle；`FAIL_LOUD_RELEASE_TIMEOUT_MS=2000` 是失败清理释放预算，不是 MCP 注册预算（`packages/boot/app-boot/src/index.ts:578,592,635,729`）。

## 2. 用户看到的“启动时限”来自哪里

不是 dsh MCP client，而是 `/Users/qinshu/Documents/papertableV1/dsh-plugins/dsh-memory-discipline/index.js`：

- `waitForTool()` 每次先查 `ctx.tools`，默认 `toolWaitAttempts=10`、`toolWaitDelayMs=500`（[discipline.js](/Users/qinshu/Documents/papertableV1/dsh-plugins/dsh-memory-discipline/discipline.js:44)；[index.js](/Users/qinshu/Documents/papertableV1/dsh-plugins/dsh-memory-discipline/index.js:85)）。最后一次不再 sleep，所以约 `(10-1)*500ms = 4.5s`。
- 超时文案逐字为 `tool "..." was not registered within the startup wait budget`（[index.js](/Users/qinshu/Documents/papertableV1/dsh-plugins/dsh-memory-discipline/index.js:111)）。
- 该等待在 `agent/session-start` 中通过 `agent.runMaintenance()` 异步执行（[index.js](/Users/qinshu/Documents/papertableV1/dsh-plugins/dsh-memory-discipline/index.js:198)）。超时只注入“memory unavailable”通知，不会让会话崩溃。
- 当前 profile 仅把重试调用提高为 3 次，未改变 4.5s 注册等待（[cordis.patch.yml](/Users/qinshu/.dsh/profiles/web/cordis.patch.yml:45)）。

## 3. 配置与实测

### dsh web

`/Users/qinshu/Library/LaunchAgents/com.deepseek-harness.web.plist` 设置：

```text
MEMOS_MCP_URL=http://127.0.0.1:8002/mcp
```

transport 是 `streamable-http`，serverName 是 `memos`，所以期望工具名为：

```text
mcp__memos__get_hot_context
mcp__memos__route_memory
mcp__memos__search_memories
mcp__memos__add_memory
```

`memory-discipline` 已使用带前缀名称；此前 bundle 默认不带前缀，profile 的 id-targeted patch 已覆盖这一点。未发现显式连接、初始化或 `tools/list` timeout 配置。

### MemOS HTTP 实测（只读）

目标 `http://127.0.0.1:8002/mcp`，服务端报告版本 `2.13.0.2`。

| 操作 | 结果 | 观测耗时 |
|---|---|---:|
| 正确 Streamable HTTP `initialize` | 成功 | 约 8–27ms |
| `tools/list` | 成功，约 10,990 bytes，含 MemOS 工具 | 约 9–15ms |
| 连续 10 次握手/list | 全部成功 | 均远低于 4.5s |
| `/health`、`/` 普通 GET | 404 | 不是该 MCP 的健康接口 |
| `/mcp` 普通 GET | 406 | 要求 `Accept: text/event-stream`，符合 Streamable HTTP 行为 |

因此当前证据不支持“MemOS 服务慢/超时”作为根因。

## 4. 失败日志与时间线

`/Users/qinshu/Library/Logs/dsh-web.err.log` 反复出现：

```text
dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include):
failed to import loader entry dsh-super-injector (@dsh-external/dsh-super-injector):
Cannot find module '/Users/qinshu/.dsh/profiles/web/node_modules/@dsh-external/dsh-super-injector/lib/index.js'
```

这不是单个 MCP 调用失败，而是 loader 入口导入失败，导致整棵插件树启动失败。当前文件已于 `2026-08-15 16:54:28` 出现在该路径，目录内 `lib/index.js`、source map 和依赖均存在；super-injector reload debug 在 2026-08-15 13:01/13:03 记录过 `memory-memos` active 的 reload 观察。当前 launchd 状态为 running/active，PID 98140，启动于 2026-08-16 02:18:37，`http://127.0.0.1:3080/health` 返回 200。

最合理解释是 profile 安装/同步与 launchd 启动存在竞态，或某次安装产生 dangling 的 loader 入口；历史失败期间不会有可用 MCP 工具。当前进程是否已经为每个会话成功展示工具，单凭 web health 不能证明，仍应在新会话中核验工具表。

## 5. 根因分级

### P0 主根因：插件树启动失败（已在当前磁盘状态修复/缓解，但需验证安装流程）

缺少 super-injector 入口会让 Cordis include 直接失败，MCP 注册链路根本没有机会运行。它比 4.5s 等待更早、更致命。

### P1 次级风险：异步注册与 4.5s 等待预算脱节

MCP client 首次连接/list 是异步的，memory-discipline 只等待 4.5s；晚到的成功注册不会触发本会话再次拉取热记忆。即使插件树完整，这个竞态仍可产生用户看到的同一 notice。

### P2 可观测性缺口

当前 dsh 配置没有显式 MCP connect/list timeout，也没有把“插件树失败、首次连接失败、工具晚注册、工具调用失败”统一关联到 session。排障只能从 stderr 和 reload debug 拼时间线。

## 6. 分级修复方案

### A：配置/运维层（先做，零代码）

1. 把 web profile 的依赖安装/同步与 launchd 启动做成原子顺序：先确认 `@dsh-external/dsh-super-injector/lib/index.js`、其 package.json 和依赖全部存在，再启动/加载 dsh；不要让 launchd 观察到半安装目录。
2. 在启动前做只读 preflight：解析 `cordis.patch.yml` 中所有本地 loader 入口，逐个 `node import()`/文件存在检查；失败时阻止启动并留下单一明确错误。
3. 保持 `MEMOS_MCP_URL=http://127.0.0.1:8002/mcp` 与 `streamable-http` 配置；不要改成普通 GET 探活，也不需要为本机 MCP 加代理。
4. 临时缓解可把 `toolWaitAttempts` 或 `toolWaitDelayMs` 调大（例如 20×500ms），但这只扩大等待窗口，不能修复插件树缺模块；应在验证安装竞态后再评估。
5. 新建会话做验收：确认工具表出现四个 `mcp__memos__*` 名称，并同时检查 dsh stderr 无 loader error、MCP 首次连接/list 成功。

### B：改源码层（需要评审后实施）

1. `memory-discipline` 增加 late-registration 机制：4.5s 超时先保留 notice，但监听工具注册/`mcp-client` reconnect 事件，工具出现后在同一 session 补拉一次 `get_hot_context`；必须有 session/disposal guard，避免重复注入。
2. 或把 MCP readiness 作为 session-start 前置依赖。这种方案语义更干净，但会把网络/服务故障变成新会话阻塞，不建议默认启用。
3. 在 `dsh-mcp-client` 为 transport connect、initialize、每次 `tools/list` 增加明确 timeout 和结构化日志，至少输出 serverName、attempt、阶段、耗时和最终状态；这样可区分网络、MCP 服务、工具注册冲突和 loader 失败。
4. 保留现有“整代 tools/list 成功后原子交换”的注册语义，不要改成逐工具部分可见；这部分能避免半套 MemOS 工具暴露。

## 7. 验收与边界

- 本次仅做源码、配置、日志和本机 MCP 接口的只读检查。
- 没有改 dsh 源码、profile、plist 或 MemOS 服务；没有重启 dsh/MemOS；没有访问或改变 4G 生产服务器。
- 当前阻塞：无法仅凭 `/health` 证明当前每个新会话工具已注册，需在 dsh web 新建会话检查模型工具表；这属于验收缺口，不是本机 MCP 服务不可用。

## 最终摘要

**根因一句话：**历史启动竞态导致 super-injector 缺失，整棵 dsh 插件树失败；即使该问题消失，memory-discipline 的异步工具注册仍有 4.5s 等待窗口，晚注册会误报不可用。

**修复方案 A：**先把 profile 依赖安装与 launchd 启动串成原子流程并加 preflight，随后新会话核验四个 `mcp__memos__*` 工具；可临时延长等待但不是根治。

**修复方案 B：**源码增加 late-registration 补拉、明确 MCP 阶段 timeout/结构化日志；不建议默认把 MCP readiness 变成阻塞新会话。

**有无阻塞：**MemOS HTTP 本身无阻塞；当前仅缺“新会话工具表”最终验收证据。 
