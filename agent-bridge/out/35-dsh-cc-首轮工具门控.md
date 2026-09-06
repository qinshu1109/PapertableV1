# 简报 35：dsh-cc 首轮工具门控——实证 + 第二轮主动发现（已实施，验收通过）

> 角色：dsh-cc；依据用户范围修订（改门控策略本身：首轮保轻量核心集，第二轮起主动放开全量工具表）。
> 状态：**已实施并验收通过**（主控批准后动手；改自家 router-standard preset，未碰 dsh 核心仓/super-injector/生产）。

## 结论一句话

门控实现在 `router-standard` 预设的 `router-bootstrap.mjs`（自家用户级预设插件）；已按最小方案实施——**首轮 = 核心集 ∪ 4 个 memos 工具**（记忆纪律硬要求），**第 2 个真实 user turn 起放开全量工具表**（67 个工具）；两条验收全部实证通过：a) 首轮成功调用 `mcp__memos__add_memory`（`added:true`）；b) 第二轮模型自述全量清单（67 个）并实际调用非核心工具（`time`）成功。

## 以下给干活的看

### ① 门控实现位置 + 首轮核心清单（实证，文件:行号）

**门控位置**：`/Users/qinshu/.dsh/.agent-presets/router-standard/router-bootstrap.mjs:66-83`
`system-prompt/assemble` waterfall 内：

```js
// 66-68: 已有 tool/call → 直接放开全量
if (session.events.some((event) => event.type === 'tool/call')) {
  return { ...assembled, sections, contexts: [] } // promoted: full catalog
}
// 70-83: 否则过滤成首轮核心集
const core = new Set(coreFor(mode))
const available = new Set(assembled.tools.map((tool) => tool.name))
const shell = ... // 动态取 pwsh/bash
core.add(shell)
return { ...assembled, sections, contexts: [], tools: assembled.tools.filter((tool) => core.has(tool.name)) }
```

**首轮核心清单**：`/Users/qinshu/.dsh/.agent-presets/router-standard/router-core.mjs:97-104` `coreFor(mode)`：

| 模式 | 首轮核心工具 |
|---|---|
| spec（plan-first） | `read, edit, glob, grep` |
| transition/mixed | `read, edit, write, glob, grep` |
| react / weak（默认） | `read, write, edit` |
| （动态追加） | shell：`bash`（或 `pwsh`） |

实证（简报 34 验收会话，weak 分类）：首轮模型 tools = `bash, edit, read, write`，与默认核心集+shell 一致 ✅。MCP 工具（含 memos）首轮被过滤、第一个 `tool/call` 后放开（34 已实证放开后 17 个 `mcp__memos__*` 可见）。

### ② 最小方案（已实施，主控批准）

**改动范围**：仅 `~/.dsh/.agent-presets/router-standard/` 下两个文件（自家 preset 插件）；备份 `router-bootstrap.mjs.bak-35-20260816030859`、`agent.cordis.yml.bak-35-20260816030859`。

- `router-bootstrap.mjs`：
  - 新增 `resolveRouterConfig(raw)`（fail-loud 配置解析：未知 key / 类型错 / `fullCatalogAfterTurns<1` 均 throw）。
  - 新增默认常量：`DEFAULT_FULL_CATALOG_AFTER_TURNS=2`、`DEFAULT_FIRST_TURN_EXTRA=[4 个 mcp__memos__*]`。
  - `system-prompt/assemble` hook 新逻辑：
    1. session 有 `tool/call` → 全量（保留原行为）；
    2. **真实 user turn 数（`user/message` 且 `source.kind==='user'`）≥ `fullCatalogAfterTurns` → 全量**（第二轮主动发现，不依赖是否已调工具）；
    3. 否则首轮：`tools = assembled.tools.filter(t => core.has(t.name) || extra.has(t.name))`，extra 仅对已注册工具生效（未注册名字自动忽略）。
- `agent.cordis.yml`：router-bootstrap config 显式声明 `fullCatalogAfterTurns: 2` + `firstTurnExtraTools`（4 个 memos 工具）。

**配置项说明**：

| 配置 | 默认 | 语义 |
|---|---|---|
| `fullCatalogAfterTurns` | `2` | 第 N 个真实 user turn 起放开全量工具表（`1`=首轮即全量=关掉门控） |
| `firstTurnExtraTools` | 4 个 `mcp__memos__*` | 首轮在核心集之外额外可见的工具（可配空数组退回纯核心集） |

生效方式：改动 preset 文件后**重启 dsh web**（bootout/bootstrap，wrapper 先跑 preflight；新 PID 43300；手机隧道短暂断连、微信插件内存态重置可 cold resume——简报 35 已知影响，已执行）。

### ③ 记忆纪律硬要求（已满足）

首轮白名单默认已含 4 个 `mcp__memos__*`（`firstTurnExtraTools` 默认值），即记忆纪律硬要求与②一体落地，不依赖第二轮放开。

### ④ 验收（实施后实测，两条均通过）

验收会话：`acc35-1786821002`（preset=router-standard，cwd=/Users/qinshu/Documents/papertableV1），RPC `session.history` 证据：

- **a) 新会话首轮成功调用 `mcp__memos__add_memory`** ✅
  - 首轮请求工具表 = `bash, edit, read, write`（核心）+ `mcp__memos__get_hot_context/route_memory/search_memories/add_memory`（白名单）共 8 个（request/header 实测）。
  - 首轮模型调用 `mcp__memos__add_memory`；首次因参数缺 `occurred_at`（`semantic_type: event`）返回 schema 错误，模型修正参数后重试 → **`{"added":true,"cube_id":"turn-ledger","memory_id":"e50b73c3-ae1e-4a7e-9b24-3cd4f59ffa78","count":459,...}`**（tool/result isError:false）。
- **b) 第二轮起模型自述全量工具清单并实际调用一个非核心工具** ✅
  - 第二轮（第 2 个 user turn）请求工具表 = **67 个**（含 17 个 `mcp__memos__*` 及 ask_user_question/create_goal/dev_* 等全部非核心工具）。
  - 模型回复 **"## 完整工具清单（共 67 个）"**，结构化列出核心文件/目标与规划/子代理与协作/记忆 等分组（含 `mcp__memos__*`）。
  - 模型实际调用非核心工具 **`time`**（`{"action":"now"}`）→ tool/result **isError:false**。
- 回归：首轮工具数 8（核心+memos），未退化为全量（首 token 轻量意图保留）；未动 dsh web 逻辑/隧道/生产。

### 风险与边界（实施后确认）

- 第二轮起全量会增大 tools 序列化，但与"tool/call 后全量"一致且固定（KV-cache 稳定）。
- 首轮追加 4 个 memos 工具 schema 增加少量首轮 token；如需极致轻量可配 `firstTurnExtraTools: []`（不推荐，违反记忆纪律③）。
- 不改 dsh 核心仓 → 不触发仓库 AGENTS.md 流程；改的是用户级 preset（已备份、语法/配置自测 + RPC 实测验收）。

## 变更清单（本次实施）

- 修改：`~/.dsh/.agent-presets/router-standard/router-bootstrap.mjs`（resolveRouterConfig + hook 新规则）
- 修改：`~/.dsh/.agent-presets/router-standard/agent.cordis.yml`（显式配置项）
- 备份：`router-bootstrap.mjs.bak-35-20260816030859`、`agent.cordis.yml.bak-35-20260816030859`
- 重启：dsh web（bootout/bootstrap，PID 43300，preflight OK）
- 未动：dsh 核心仓、super-injector、Clash、生产、隧道（独立 LaunchAgent 运行中）

## 阻塞

无。
