# 简报 38B：DSH 源码能力核验

核验日期：2026-08-17  
核验对象：`/Users/qinshu/Documents/ChatGPT/MemOS/deepseek-harness`  
本机 checkout：`47f943859bef60e4160492346772ded9b24f765a`（工作树无改动）  
Web 运行目录：`DSH_HOME=/Users/qinshu/.dsh-source`  
约束执行情况：只读源码、配置和现有日志；只新增本报告，未改插件代码、未安装插件、未重启服务。

## 一句话结论

`agent/session-start → agent.runMaintenance() → agent.inject()` 动态 notice 通道在当前 pin 完整可用；host/global 注册的 `pw_*` 工具也会进入 Web agent 的作用域工具视图。但 A 方案里的普通 `papertable:workbench-guide` systemPrompt 段在当前默认 `router-flash` **不会进入模型请求**：该 preset 注册了 `complete: true` persona，DSH 会在 assembly waterfall 后把它恢复为唯一 system 段。动态 plugin notice 不在当前首轮抑制名单里，可作为兼容通道。

## 1. `ctx.systemPrompt.section()` 的确切语义

### 1.1 注册输入与排序

- `PromptSection` 是 `{ name, order, text, complete? }`；`text` **不只接受静态 string**，也接受 `(context: AssembleContext) => string` provider。源码：`packages/core/system-prompt/src/index.ts:52-75`。
- `order` 必须是有限数，否则注册立即抛错；同一 layer 内同名 section 也会抛错。源码：`packages/core/system-prompt/src/index.ts:373-390`、`:315-324`。
- effective sections 按 `order` 升序排列。源码：`packages/core/system-prompt/src/index.ts:483-505`。
- 相同 `order` 的 tie-break 是注册顺序；官方 README 明确称其为 plugin-load artifact，因此不要让两个需要固定相对位置的段共用同一 order。证据：`packages/core/system-prompt/README.md:85-90`。
- agent-scoped 同名 section 会 shadow global section；作用域合并为 global → 远祖 → 近祖。源码：`packages/core/system-prompt/src/index.ts:483-485`、`packages/core/scope/src/store.ts:201-216`。

### 1.2 求值时机：每个 model step 都重新 assemble

- 每次 `assemble()` 都遍历 section definitions；函数型 `text` 在该次 assemble 时调用，静态 string 直接取值。源码：`packages/core/system-prompt/src/index.ts:467-518`。
- agent loop 在每个 `preStep()` 都调用 `systemPrompt.assemble(assembleContextFor(agent, signal))`，不是进程启动时只求值一次。源码：`packages/core/agent-loop/src/agent.ts:225-242`。
- 因而“KV-cache 友好”不是 DSH 对静态段做一次性缓存，而是插件保证每轮渲染出的前缀逐字节一致。函数 provider 也能用，但只要输出随轮次变化，就会从变化处破坏前缀缓存。官方说明：`packages/core/system-prompt/README.md:63-69`。

### 1.3 多段拼接格式

- assembly 先保留每段的 `{name,text}`，最终 `renderPrompt()` 做变量插值、丢弃空串、以两个换行 `\n\n` 拼接。源码：`packages/core/system-prompt/src/index.ts:204-217`。
- agent loop 将渲染结果作为 request 的 `system`，并将 assembly 的 tool schemas 一起放入 request/header。源码：`packages/core/agent-loop/src/agent.ts:332-342`、`:458-470`。
- 所以普通静态导览段建议继续使用配置的纯函数或常量 string；不要在 `text` provider 内拉 4317 数据，动态状态应走 notice。

### 1.4 当前 Web preset 的硬冲突：普通导览段会被吃掉

- `complete: true` 的语义是：waterfall 仍会运行以解析 tools/contexts/variables，但最后把这个 complete section 恢复为唯一 system section；多个 effective complete sections 会直接报错。源码：`packages/core/system-prompt/src/index.ts:68-74`、`:504-540`。
- 当前 `DSH_HOME` 默认 preset 是 `router-flash`：`/Users/qinshu/.dsh-source/settings.yaml:29-30`。
- 该 preset 的 persona 配置明确是 `complete: true` 且 `includeRuntimeContext: false`：`/Users/qinshu/.dsh-source/.agent-presets/router-flash/agent.cordis.yml:61-75`。
- 因此新增普通 `papertable:workbench-guide`（以及现有普通 `papertable:write-boundary`）可以注册成功、也会出现在 waterfall 之前的 assembly 中，但最终 request.system 只剩 router persona。`order:120` 不能绕过 complete 约束。

**给 A/主控的方案约束：** 若必须兼容当前默认 `router-flash`，不能把“普通 systemPrompt 段注册成功”当成上下文层完成。可选设计点应由主控拍板：

1. 把静态导览也作为 session-start plugin notice 注入（当前最小影响，且不改 preset persona）；或
2. 调整 `router-flash` 的 complete persona / 将导览并入它（会触碰 Flash 首轮锚定行为，风险最大）；或
3. 为镇纸场景使用不带 complete persona 的专用 preset。

本报告只核验能力，不替主控选择。

## 2. `session-start`、`runMaintenance()`、`inject()` 当前签名

结论：三者在当前 commit `47f9438` 原样存在，签名可直接沿用简报样板。

### 2.1 `agent/session-start`

签名：

```ts
'agent/session-start'(
  this: Scoped<Agent>,
  payload: { agent: Agent; source: SessionStartSource }
): void
```

源码：`packages/core/agent/src/runtime-types.ts:206-217`。

语义：session 生命周期开始时、第一 turn 之前发一次；官方注释直接指定用 `agent.inject()` seed model-facing context。事件由 AgentLoop 在 agent/session 已进入 registry、`agent/created` announce 完成后同步 emit，随后才允许 driver 启动。源码：`packages/core/agent-loop/src/index.ts:548-569`。

### 2.2 `agent.runMaintenance()`

签名：

```ts
runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
```

接口证据：`packages/core/agent/src/runtime-types.ts:95-104`。

实现语义：只能从 true idle 同步抢占 maintenance phase；非 idle 时同步 throw。maintenance 期间到达的 waking input 留在 inbox 并设置 wake latch；task settle 后恢复 idle，再自动放行 pending wake。源码：`packages/core/agent-loop/src/agent.ts:142-161`、`:172-180`。

因此 listener 必须在回调同步栈内先调用 `runMaintenance(task)`，不能先 `await fetch(...)` 再抢 maintenance。现有样板正是这样做：`dsh-plugins/dsh-memory-discipline/index.js:300-317`。

### 2.3 `agent.inject()`

签名：

```ts
inject(message: UserMessage): void
```

接口证据：`packages/core/agent/src/runtime-types.ts:135-143`。

实现是 `send(message, 'next-step', false)`：写 next-step inbox，但**不主动唤醒** idle agent。源码：`packages/core/agent-loop/src/agent.ts:113-132`。

当首轮 prompt 唤醒 driver 后，inbox 内容在 pre-step 被 claim；进入 step 的 message 逐条写为 durable `user/message`，所以模型可见内容可从 session log 重建。源码：`packages/core/agent-loop/src/agent.ts:225-242`、`:278-287`。这符合仓库的“model-visible ⇔ logged”约束。

### 2.4 对镇纸动态 notice 的具体判断

- 简报给出的 `session-start → runMaintenance → 拉 4317 → inject(plugin notice)` 路径成立。
- notice 应使用 `source: { kind:'plugin', plugin:'dsh-paperweight', form:'notice', ... }`。当前 `router-flash` 首轮只过滤 `source.kind` 为 `agent-instructions` 或 `skill-catalog` 的消息，普通 `plugin` 不会被过滤。当前配置证据：`/Users/qinshu/.dsh-source/.agent-presets/router-flash/agent.cordis.yml:39-56`；过滤实现：`anchored-bootstrap.mjs:334-353`。
- 4317 拉取必须有总超时并消费 maintenance signal；失败要注入短降级 notice，而不是让 listener promise 拒绝或把首轮无限闩住。
- `inject()` 不 wake；如果 maintenance 抢占失败，best-effort inject 可能错过已经 claim 的 request，只会在后续 step/turn 被看到。样板对此已有同步抢占失败 fallback：`dsh-memory-discipline/index.js:305-317`。

## 3. Web profile 下 out-of-tree tools 是否进模型上下文

### 3.1 框架能力：会

- `ToolRuntime` 在构造时把自己的 `wireSchemas(scope)` 注册为 systemPrompt tool provider。源码：`packages/core/tools/src/index.ts:783-835`。
- plain host context 调用 `ctx.tools.register()` 注册到 global layer；模型查看某 agent scope 时，global tools 先进入 inherited map，再叠加 preset/agent scope，并受 scope restrictions 过滤。源码：`packages/core/tools/src/index.ts:1031-1061`、`:1130-1192`。
- `dsh-paperweight` 确实遍历 9 个 definitions 调用 `ctx.tools.register(definition)`。源码：`dsh-plugins/dsh-paperweight/src/host/tools.ts:60-63`、`:174-198`。
- 它作为 Web profile bundle 安装在 dependencies 和 `dsh.profile.bundles` 中：`/Users/qinshu/.dsh-source/profiles/web/package.json:4-19`；bundle patch 在 host plane 插入插件行：`dsh-plugins/dsh-paperweight/cordis.patch.yml:1-7`。

因此：只要插件 boot 成功，9 个 `pw_*` definition 会成为 global/inherited capabilities，Web agent 能解析和执行；out-of-tree/link 安装本身不会把它们排除在模型上下文之外。

### 3.2 当前 preset 的实际过滤：首轮没有，晋升后有

`router-flash` 在 `system-prompt/assemble` waterfall 后过滤 `assembled.tools`：

- bootstrap 首轮 keep-set 是 `bash + str_replace_editor`；源码/配置：`anchored-bootstrap.mjs:264-308`、`agent.cordis.yml:39-56`。
- 第一条 durable `tool/call` 或 `assistant/message` 后晋升；当前 `promotedCatalog: full`，晋升态直接返回完整 assembled catalog。源码：`anchored-bootstrap.mjs:281-302`；当前配置：`agent.cordis.yml:51-59`。
- 所以首个 request/header 不应期待任何 `pw_*`；第二次及以后 request/header 应出现全部 9 个 `pw_*`（前提是插件 boot 成功、会话仍用 router-flash、配置未改）。

### 3.3 另一个独立事实：工具过滤不会自动删除普通指导段

DSH 的 sections 和 tool schemas 是分开的 assembly 输入；工具 restriction/filter 并不会自动删掉某工具的指导 section。官方说明：`packages/core/system-prompt/README.md:71-79`。当前真正删除导览段的是 complete persona，不是 bootstrap tools filter。

## 4. 改完插件后的正确重装/重启姿势（命令处方，本次未执行）

当前 profile 已是 link 安装；无需先 remove。插件 `main` 指向 `lib/index.js`，源码改完必须先 build。package 证据：`dsh-plugins/dsh-paperweight/package.json:7-19`、`:27-32`。

```bash
# 1) 构建插件产物
cd /Users/qinshu/Documents/papertableV1/dsh-plugins/dsh-paperweight
/Users/qinshu/.local/node/bin/pnpm run build

# 2) 让 web profile 重新对账同一个 link dependency/bundle
cd /Users/qinshu/Documents/ChatGPT/MemOS/deepseek-harness
DSH_HOME=/Users/qinshu/.dsh-source \
  /Users/qinshu/.local/node/bin/pnpm dsh plugin --profile web add \
  link:/Users/qinshu/Documents/papertableV1/dsh-plugins/dsh-paperweight

# 3) boot-free 检查装配树；应能搜到 dsh-paperweight 行
DSH_HOME=/Users/qinshu/.dsh-source \
  /Users/qinshu/.local/node/bin/pnpm dsh --profile web --dump-config \
  | rg -n 'dsh-paperweight|@papertable/dsh-paperweight'

# 4) 重启当前源码版 Web LaunchAgent
launchctl kickstart -k gui/501/com.deepseek-harness.web
```

为什么不能只等热更新：

- `dsh plugin` 只是以 profile dir 为 cwd 转发给 pnpm，成功后按实际 installed state 对账 `dsh.profile.bundles`。源码：`apps/cli/src/plugin.ts:1-9`、`:47-90`、`:114-157`。
- 当前长进程保证的是 **config-only HMR**：只 watch profile/home 的 `cordis.patch.yml`；Web bundle 明确禁用了未验证的 module-reload HMR。源码：`apps/cli/src/profile-boot.ts:227-245`、`:261-294`。
- 当前 LaunchAgent 的 runner 明确设置 `DSH_HOME=/Users/qinshu/.dsh-source`，从 checkout 执行 `pnpm dsh web`：`/Users/qinshu/.dsh-source/run-web.sh:1-9`。因此上面命令要用同一 checkout、同一 DSH_HOME。

### 4.1 重启后的观察点

先看进程与 boot：

```bash
launchctl print gui/501/com.deepseek-harness.web \
  | rg 'state =|pid =|stdout path|stderr path|DSH_HOME'
curl -fsS http://127.0.0.1:3080/ >/dev/null
tail -n 200 /Users/qinshu/Library/Logs/dsh-web.err.log \
  | rg 'dsh-paperweight|plugin tree failed|failed to apply loader entry'
```

验收必须新开 Web 会话（或明确 resume 后触发新的 session lifecycle），不能只看旧会话：

1. **静态段**：非-complete preset 中，首个 `request/header.header.system` 应含 `papertable:workbench-guide` 文本；router-flash 中按当前实现必不含，这是已知兼容性失败，不是观察工具失灵。
2. **动态 notice**：session log 应先有 `agent/inbox/spliced`，被首 step claim 后有 `user/message`，其 `source.kind=plugin`、`plugin=dsh-paperweight`、`form=notice`；Web 对话中应显示对应 notice，而不是普通用户输入。
3. **工具目录**：router-flash 首个 `request/header.header.tools` 只有 `bash/str_replace_editor`；产生第一条 assistant message 后再发一轮，新的 `request/header`（通常 reason=`change`）里应出现 9 个 `pw_*`。
4. **行为验收**：第二轮询问“现在镇纸里有哪些待裁决押注”时，模型应先选择合适 `pw_*` 读取证据，并明确把裁决留给人；不能仅凭提示词复述工具名。

request/header 是权威观察点，因为 agent loop 把当轮实际 system/tools canonicalize 后写入 session log，再组装真实 model request。源码：`packages/core/agent-loop/src/agent.ts:458-494`。

## 5. pre-release 风险清单

| 风险 | 当前影响 | 控制办法 |
|---|---|---|
| `complete` persona 吃掉普通 sections | **已发生于默认 router-flash**；导览段和现有 write-boundary 都不可见 | 实现前先选 notice / 专用 preset / 调整 complete 的路线；用 request/header 验收 |
| 首轮工具目录过滤 | 首轮模型看不到 `pw_*`，即便插件已注册 | 把开场 notice 写成不要求首轮立即调 `pw_*`；第二轮后验收完整目录 |
| `runMaintenance` 只允许 true idle | listener 若先 await，可能同步抢占失败 | 回调同步栈内先 `runMaintenance(task)`；catch 后 best-effort，但标记可能延迟到后续 step |
| 4317 慢/挂会闩住首轮 | 用户 prompt 已到但 maintenance 未释放 | 总超时、AbortSignal、并行拉取、短降级 notice，禁止无限重试 |
| `inject` 不唤醒且可能错过已 claim request | 非 session-start 或 late backfill 不能保证首轮可见 | 首轮只走 session-start maintenance；late backfill 明确接受“下一 step 可见” |
| resume/restart 重复 notice | 每次新 lifecycle 都可能再 seed | notice 带生成时间/状态版本；若产品要求严格去重，按 session 已有 source/message 做幂等 |
| link 包改了 `src` 未 build | Node 仍加载旧 `lib/index.js` | 固定 `pnpm run build → plugin add link:... → dump-config → kickstart` |
| 当前仅 config HMR | 改 JS/TS 后长进程仍持有旧 module generation | 不承诺源码热更新；重启 Web 服务 |
| section 名冲突/非有限 order | plugin boot 或注册直接失败 | 固定唯一名 `papertable:workbench-guide`、固定有限 order；启动日志 fail-loud |
| prompt/tool 两套可见性分离 | 工具被过滤但指导还在，或工具在而 guide 被 complete 吃掉 | 分别验收 `header.system` 与 `header.tools`，禁止只看其一 |
| pre-release API 无兼容承诺 | checkout 升级后签名/事件时序可能变 | package/报告 pin commit；每次升级重新核验 runtime-types、AgentLoop emit、ToolRuntime assembly |
| model-visible 必须可重建 | 绕过 inbox/log 的临时状态会违反仓库不变量 | 动态内容只走 identified `UserMessage` + `agent.inject()`，不要直接改 adapter request |

## 6. 给主控的验收判定

### 可以直接沿用

- `agent/session-start` 监听器签名。
- 同步 `agent.runMaintenance(task)` 抢 idle，异步拉 4317，最后 `agent.inject(createUserMessage(...plugin notice...))`。
- host/global `ctx.tools.register()` 的 9 个 `pw_*` 工具注册方式。
- link profile 的 build / add / dump-config / kickstart 流程。

### 不能按原设想直接判绿

- `papertable:workbench-guide` 作为普通 `ctx.systemPrompt.section()`：框架 API 本身支持，但当前默认 router-flash 的 complete persona 使它最终不可见。
- “新会话首轮能调用 pw_*”：当前 preset 明确不成立；首轮只暴露 Minimal 两工具，晋升后才全开。

### 无阻塞，但有一个必须先决策的兼容性门

动态 notice 可实施；静态导览的承载方式必须先决定是否继续兼容 router-flash 的 complete persona。未作该决策前，不应进入“普通静态段实现完成”的验收。
