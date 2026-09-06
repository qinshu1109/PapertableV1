# 简报 29：Codex 配置 / 运行时只读排查

## 这刀是干什么的

微信可以创建新会话，但新会话没有绑定工作目录，所以 AI 在准备开工说明时拿不到 `cwd`，模型请求尚未发出就失败。本报告只定位原因和给出最小修复方案，没有改代码、配置或正在运行的服务。

## 怎么算好

- 已确认三个 `wechat-*` 会话的持久化头都没有 `cwd`。
- 已确认网页普通会话和命令行会话会在创建时写入 `cwd`，微信插件绕过了这两条创建链。
- 已确定最小修复是给 web profile 的 `dsh-wechat` 配置补一个绝对路径 `cwd`；模板不应兜底，`agentPreset` 也不能替代 `cwd`。
- 已单独复核定时任务：当前 `new-session` 实现已经传入 `process.cwd()`，现有运行记录为成功，不属于当前同一故障。

## 以下给干活的看，可以跳过

### 结论

根因链路是：

1. web bundle 的全局 persona 包含 `{{cwd}}`。
2. `dsh-agent-loop` 只从 `context.agent.session.header.cwd` 提供 prompt 变量 `cwd`。
3. 微信插件 `/new` 直接调用 `ctx.agents.create()`；只有插件配置里存在 `cwd` 时才写 `meta.cwd`。
4. 当前 web profile 的 `dsh-wechat` 配置仅包含 `allowFrom`、`agentProvider`、`agentModel`，没有 `cwd`。
5. 因而新会话的不可变 header 没有 `cwd`，严格模板解析在 `deployment:persona` 抛出 `{{cwd}} has no value`。

这不是 workspace 注册表失效，也不是 persona 模板写错；是微信这条旁路创建会话时没有提供创建元数据。

### 运行时证据

运行中的服务：

- LaunchAgent：`com.deepseek-harness.web`
- PID：`55421`
- 启动命令：`/Users/qinshu/.local/bin/dsh web`
- 进程工作目录：`/Users/qinshu`
- `DSH_HOME`：`/Users/qinshu/.dsh`

当前配置 `/Users/qinshu/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- id: dsh-wechat
  config:
    allowFrom: ['<已配置>']
    agentProvider: opencode-zen
    agentModel: deepseek-v4-flash
```

这里没有 `cwd`。已安装的 `dsh-wechat` 是指向 PapertableV1 插件目录的链接，因此当前运行时使用的就是被检查的插件实现。

三个故障会话的首个持久化记录均没有 `cwd`：

```text
wechat-mstxkkjn-12k4vw  -> { id, createdAt, delegationDepth }，无 cwd
wechat-msty0hzu-btdy12  -> { id, createdAt, delegationDepth }，无 cwd
wechat-msu5d4o9-0j29ec  -> { id, createdAt, delegationDepth }，无 cwd
```

它们也都位于：

```text
~/.dsh/sessions/_no-cwd/<session-id>/session.jsonl.zstd
```

持久化实现明确规定 `cwd === undefined` 时使用 `_no-cwd` 目录。这不是按路径名猜测；我还只读解压了三个日志的首帧并直接检查了 header。

对照的普通 web 会话 `session-4095c6b7-81e4-4eb7-bcc5-06a2ac2792aa` 的 header 明确含有：

```json
{"cwd":"/Users/qinshu/Documents/papertableV1"}
```

### 变量由谁提供

`packages/core/agent-loop/src/index.ts:353` 注册：

```ts
ctx.systemPrompt.variable('cwd', context => context.agent?.session.header.cwd)
```

`packages/core/session/src/index.ts:881` 只在 `meta.cwd !== undefined` 时把它写入 session header。system-prompt 的严格解析只是把缺值暴露出来；不应把 persona 改成静默省略目录，否则会掩盖没有 workspace 的会话，并让文件工具的工作范围继续不明确。

### 为什么普通 web / 命令行正常

普通 web 页面不直接调用 agent factory。它经过 `packages/host/apiproxy/src/api-proxy.ts`：

```text
workspace.path -> request.payload.cwd -> defaults.cwd
```

三者至少取一个，然后把结果作为 `meta.cwd` 传给 `ctx.agents.create()`。`defaults.cwd` 来自 web 进程的 `process.cwd()`；当前 LaunchAgent 的工作目录是 `/Users/qinshu`。

命令行的一次性 agent 在 `packages/bundle/headless/src/index.ts` 也明确传：

```ts
meta: { cwd: process.cwd() }
```

微信 `/new` 则绕过 API proxy，在 `dsh-plugins/dsh-wechat/src/node/core.ts` 直接创建：

```ts
const meta: Record<string, string> = {}
if (this.config.cwd) meta.cwd = this.config.cwd
await this.ctx.agents.create({ sessionId, meta, ... })
```

因此只要部署配置没给 `cwd`，就必然创建无 cwd 会话。

### agent preset 复核

当前 web 设置的默认 preset 是 `router-standard`，但微信插件不经过 web API proxy 的 `composeAgent()`，也没有读取这个默认值。当前微信配置同样没写 `agentPreset`。

更重要的是，现有微信插件即使配置 `agentPreset`，也只是把名称写进 session meta，没有把 preset 的 `setup` 交给 `ctx.agents.create()`；它不能补出 `cwd`，也不能证明对应 preset 已真正挂载。因此不要用“只补 agentPreset”修这个报错。preset 是否应真正组合，是独立的源码侧完善项。

### 最小修复方案

在 web profile 的 `dsh-wechat` 配置里补一个明确、绝对、真实存在的工作目录。例如如果微信 agent 就是为 PapertableV1 服务：

```yaml
- id: dsh-wechat
  config:
    allowFrom: ['<保持现值>']
    agentProvider: opencode-zen
    agentModel: deepseek-v4-flash
    cwd: /Users/qinshu/Documents/papertableV1
```

改动层级：部署配置。无需改 persona，也无需为了这个错误改 system-prompt 或 agent-loop。

生效边界：

- 配置变更需按现有部署流程让 web profile 重新装载；本次遵守简报，没有执行。
- 只影响之后 `/new` 创建的新会话。
- 已有三个 cwd-less 会话的 header 是持久化创建事实，不应原地补写；配置生效后新建会话即可。
- 如果微信未来要按不同项目选择目录，再设计 `/new` 的 workspace 参数；当前只有一个明确项目时不要先扩协议。

### scheduled-prompt 不是当前同一故障

当前链接安装的 `dsh-scheduled-prompt/index.js` 在 `new-session` 分支明确调用：

```js
meta: { cwd: process.cwd() }
```

运行中 web 进程启动于该文件最后修改之后，所以当前进程加载的是这版逻辑。`~/.dsh/scheduled-prompt/runs.jsonl` 中现有 `new-session` 记录均为 `status: ok`，包括 21:31 的最新一条；日志中也没有检索到同一条 `{{cwd}}` 错误。

因此，简报里“scheduled-prompt → new-session 也全部撞同一个错”与当前配置 / 运行时不一致。可能是早于当前实现的旧现象，或另有 `target:self` 把任务投给 cwd-less 微信 agent；不能据此修改当前 `new-session` 分支。

## 本次变更

仅新增本报告。没有修改源码、profile 配置、LaunchAgent 或运行中进程，也没有重启服务。
