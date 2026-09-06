# dsh-memory-discipline

DeepSeek Harness(dsh)的**记忆使用纪律**插件,把"怎么用记忆工具"做成可装组件,两件事:

1. **系统提示纪律节**:`ctx.systemPrompt.section()` 注册一段稳定的英文规矩文本(单一持久记忆源;先路由再定点搜;索引/全库搜索的降级顺序;只存持久事实;不虚报成功)。文本是 config 的纯函数,同一 config 下逐字节恒定——**KV-cache 友好**。
2. **会话开始自动拉热上下文**(`autoFetch: true` 时):监听 `agent/session-start`,用 `agent.runMaintenance()` 占住 agent 的 idle 相,在有界预算内等配置的热上下文工具注册(MCP 工具发现是异步的),`ctx.tools.execute()` 调一次,结果用 `createUserMessage` 包成 `source: {kind:'plugin', plugin:'memory-discipline', form:'notice'}` 经 `agent.inject()` 注入。注入走 inbox(落 `agent/inbox/spliced` 会话事件),**天然满足"模型可见 ⟺ 落日志"**。

**全参数化,零业务耦合**:对任意记忆工具组(MemOS/mem0/zep/自建 MCP/普通注册工具)通用,工具名全部来自 config(模型侧注册名,MCP 桥接的带 `mcp__<serverName>__` 前缀)。模型可见文本全英文。

## 兼容性(重要)

deepseek-harness 处于 pre-release,**无兼容承诺**。本插件按以下版本开发并验收:

| 项 | 值 |
|---|---|
| harness commit | `47f943859bef60e4160492346772ded9b24f765a`(master, 2026-08-13) |
| harness 版本号 | 0.1.0-rc.5 |
| 依赖的稳定接口 | `ctx.systemPrompt.section()`、`agent/session-start` 事件、`Agent.runMaintenance()/inject()`、`ctx.tools.get()/execute()`、`createUserMessage`(`@deepseek-ai/dsh-llm`)与 plugin 消息源的 `form:'notice'` |

升级 harness 后必须重跑下方验收。pin 信息同时写在 `package.json` 的 `dshCompatibility`。

**运行时 bare import 前提**:`index.js` 里 `import { createUserMessage } from '@deepseek-ai/dsh-llm'`(fixture 另用 `@deepseek-ai/dsh-tools`)按名导入 base bundle 依赖,靠 harness 的 profile fallback 解析;它们**刻意不写进** `package.json` 的 `dependencies`(未发布的 `@deepseek-ai/*` 会让 pnpm 去 npm 拉包直接失败)。源码启动需要 `node --expose-internals --import tsx/esm`。

## 安装

```sh
dsh plugin --profile <name> add /path/to/dsh-memory-discipline
dsh --profile <name> --dump-config   # 应出现 "# == dsh-memory-discipline" 层与 memory-discipline 行
```

或临时 `--patch` 一个含 insert 行的 overlay(验收实录用的就是这条路)。

## 配置

bundle 自带默认层(`cordis.patch.yml`)。id 定向 patch **整体替换 config**,保留的字段要重写全。除 booleans 外每个字段都有显式默认:

```yaml
- id: memory-discipline
  name: dsh-memory-discipline
  config:
    hotContextTool: mcp__memos__get_hot_context   # 会话开始自动调用的工具名;默认 get_hot_context
    autoFetch: true                # false 则只注入规矩文本,并把"自己调一次 {hot}"写进规矩
    policyLines:                   # 可选;省略用内置英文默认(见下);{key} 从 toolVocabulary 插值
      - 'When past context may matter, call {route} first.'
    toolVocabulary:                # 可选;整体替换默认 {route,search,add};{hot} 恒绑 hotContextTool
      route: mcp__memos__route_memory
      search: mcp__memos__search_memories
      add: mcp__memos__add_memory
    sectionOrder: 150              # 系统提示节排序;默认 150(工具指引带 100–199)
    toolWaitAttempts: 10           # 等工具注册的检查次数;默认 10
    toolWaitDelayMs: 500           # 相邻检查间隔;默认 500(最坏等待 ≈ (n-1)×间隔)
    callTimeoutMs: 30000           # 单次热上下文调用超时;默认 30000
    toolRetryAttempts: 2           # 调用失败后的重试次数;默认 2。MCP 桥接的记忆服务器重启后
                                   # 会话失效,首次调用会触发 dsh-mcp-client 重建连接,重试把这段
                                   # 恢复窗口变成成功加载,而不是误报"记忆不可用"。
    toolRetryDelayMs: 1500         # 重试间隔;默认 1500
```

校验 fail-loud(装载时抛错):未知键、空/非法工具名(`[A-Za-z0-9_-]{1,64}`)、policyLines 引用词表里没有的 `{placeholder}`、`toolVocabulary.hot` 与 `hotContextTool` 冲突,全都拒载。**默认 policyLines 引用 `{route}/{search}/{add}`,所以自定义 toolVocabulary 而不自定义 policyLines 时必须提供这三个键**(装载时就会报错,不会拖到第一次装配)。

内置默认规矩(`autoFetch: true` 版;false 时第二条换成"会话开始自己调一次 {hot}"):

```
Memory discipline:
- Treat the configured memory toolset as the single persistent source of memory across sessions.
- Hot memory context is loaded automatically once per session start and injected as a notice; do not fetch it again unless it is reported unavailable — then call {hot} once yourself.
- When past context may matter, call {route} first, then search only the one or two explicit memory stores it returns, using {search}.
- Consult a broad index or catalog only when the hot context leaves the target store unclear; full-library search is the last resort.
- Save only durable facts, preferences, decisions, constraints, goals, and reusable knowledge, using {add}; do not store transient task chatter.
- Never claim an unavailable or failed memory operation succeeded; report memory failures plainly.
```

## 语义与取舍

- **时序确定性**:`agent/session-start` 在任何提示词能启动 driver 之前同步发射(agent-loop 的 `publish()` 内),所以 `runMaintenance()` 对 idle 相的认领在正常路径必然成功;fetch 期间到达的提示词被 maintenance 闩住,释放后 driver 才开跑,首个 step **确定性地**同时认领注入的 notice 与提示词(验收里 notice 的 `user/message` seq 先于提示词)。认领被抢(极端并发)时降级为不占相的 best-effort 注入。
- **热上下文走 `agent.inject()` 而不是 `ctx.systemPrompt.context()`**:context() 是同步 provider、每次装配求值,而热上下文是**一次异步 fetch**——首回合装配大概率赶不上,单提示 headless 会话会整场错过;notice 语义("刚发生的一次性事实")也比"随装配刷新的快照"更诚实。代价:注入消息可被 compaction 折叠走,而 context() 快照会在 compaction 后重放——本插件的规矩节持续在系统提示里,热上下文按"开场定向"定位,接受这个代价。
- **fetch 直调不带 `agent`**:`ctx.tools.execute()` 不传 `agent`,走全局工具视图,不进 agent 侧审批/呈现路由;也避开 code-mode 下"模型直呼原生工具名被折叠成 UNKNOWN_TOOL"的陷阱。要求 `hotContextTool` 是**全局注册**的工具(MCP 桥接工具即是)。
- **失败面**:等注册超预算、工具报错、超时、执行异常——一律注入一条简短英文 "memory unavailable" notice(告诉模型别编造记忆、可稍后重试一次),**绝不 fail 会话**;注入本身失败(如 agent 已销毁)只打日志。

## 边界(如实声明)

- **每个 agent 会话都注入**,包括子代理会话与 resume/clear/compact 后的重新开始(`agent/session-start` 的全部来源)。子代理不需要用户记忆时,在子代理组合里不装本插件,或对该 profile `autoFetch: false`。
- 注入的是**工具返回的原文**(text block 拼接)。热上下文太大时请在记忆服务侧控制预算;本插件不截断、不摘要。
- `policyLines` 里的 `{key}` 无转义机制:字面 `{word}` 会被当占位符,词表没有就装载报错。另外文本经系统提示渲染管线,`{{var}}` 形态会触发 harness 的提示变量插值,别在规矩文本里写。
- 直调不进审批路由(见上),有 `tools/pre-execute` 策略插件(如 guardrails)按全局作用域照常生效——热上下文工具应是只读工具,正常不会被拦。
- 规矩文本只是提示词纪律,不是强制:模型可以违反。硬拦截归 guard/approval 类插件,职责正交。

## 测试与验收实录

单元测试(纯逻辑,无需 harness):

```sh
npm test   # node:test,9 项全过(config 校验/插值/渲染稳定性/notice 文案)
```

行为验收(2026-08-14,pin 版本,keyless,mock LLM 驱动真组合)。`dsh` 展开为在 dsh 仓库根执行 `node --expose-internals --import tsx/esm apps/cli/src/bin.ts`;每次先 `rm -rf /tmp/dsh-ws2-home`;mock LLM:`node --import tsx packages/test-support/llm-mock-server/src/bin.ts --port 8124 --api-key mock-key --sequence success --repeat-last --success-text "ok"`;会话日志按多 zstd frame 逐帧解压。

**① 规矩文本进系统提示** —— `--patch` overlay 插两行(fixture 假工具 `tests/fixtures/fake-memory-tool.js` 注册 `get_hot_context` 返回固定文本 + 本插件默认 config),跑 `dsh --profile headless --patch /tmp/ws2-l2-with.cordis.yml "Say ok and stop."`。日志 `request/header` 事件的 `system` 含:

```
Memory discipline:\n- Treat the configured memory toolset as the single persistent source of memory across sessions.\n- Hot memory context is loaded automatically once per session start and injected …
```

**② plugin 来源的注入消息 = 假工具返回值,且先于提示词进入首个 step** —— 同一日志:

```
"type":"agent/inbox/spliced","seq":3,…"target":"next-step","inserted":[{"content":[{"type":"text","text":"Hot …   ← 注入先入箱
"type":"agent/inbox/spliced","seq":4,…"target":"next-turn","inserted":[{"content":[{"type":"text","text":"Say …   ← 提示词后到
"type":"user/message","seq":9,…"text":"Hot memory context, loaded automatically at session start via get_hot_context:\n\nHOT-CONTEXT-FIXTURE: the user prefers concise …","source":{"kind":"plugin","plugin":"memory-discipline","form":"notice","summary":"Hot memory context loaded at session start."}
"type":"user/message","seq":10,…"text":"Say ok and stop."…"source":{"kind":"user"}
```

**③ 拔掉 fixture,注入 memory-unavailable 且会话不崩** —— 只插本插件(`toolWaitAttempts: 3, toolWaitDelayMs: 200` 加速),同法跑通(stdout `ok`,退出码 0,日志有 `turn/end`):

```
"type":"user/message","seq":9,…"text":"Memory notice: hot memory context is unavailable for this session (tool \"get_hot_context\" was not registered within the startup wait budget). Continue without stored memory, do…","source":{…"plugin":"memory-discipline","form":"notice","summary":"Memory unavailable at session start."}
```

**加测 A:与 memos-mcp-overlay 联动(真 MemOS)** —— overlay 挂 `@deepseek-ai/dsh-mcp-client`(streamable-http, `http://127.0.0.1:8002/mcp`)+ 本插件(`hotContextTool: mcp__memos__get_hot_context`,词表全 MCP 前缀)。有界等待覆盖了 MCP 异步发现,注入的是**真实 MemOS 热上下文**:

```
"text":"Hot memory context, loaded automatically at session start via mcp__memos__get_hot_context:\n\n{\"enabled\":true,\"version\":544,…
…call mcp__memos__route_memory first, then search only the one or two explicit memory stores it returns, using mcp__…
```

**加测 B:安装态** —— `DSH_HOME=/tmp/dsh-ws2-home dsh plugin --profile headless add <本目录>` 后 `--dump-config` 出现 `# == dsh-memory-discipline` 层与默认行;装好的 profile 叠 fixture-only overlay 跑同一会话,注入证据同 ②。

## 产出归属

Papertable 简报 19 战役 WS2-L2(2026-08-14)。规矩与工具名全部来自 config,零 Papertable 业务耦合。
