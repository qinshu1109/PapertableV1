# dsh-scheduled-prompt

DeepSeek Harness 的**定时跑 prompt 通用骨架**插件:config 声明多条 job(cron 表达式或固定秒数周期),到点把 prompt 驱动进 agent,自带**预算护栏**(每 run 步数上限)、**幂等去重**(tick 桶级,重启后不重跑)、**run 记录**(JSONL 审计账)。零业务耦合,一切行为来自 config。

两种目标模式(照 harness extension cookbook 的 cron 处方实现):

- `target: self` — 投递进**当前常驻 agent**:空闲则 `followup()`(独占一个 turn,可全程追踪步数/预算),忙则 `inject()`(排进下一个 step 的上下文,不打断当前 turn)。
- `target: new-session` — 每次 tick 通过 `ctx.agents.create()` 起一个**一次性 agent**(与 headless runner 同一条官方工厂路径),投 prompt、等 turn 结束、flush 会话、dispose 释放。

## 兼容性(重要)

deepseek-harness 处于 pre-release,**无兼容承诺**。本插件按以下版本开发并验收:

| 项 | 值 |
|---|---|
| harness commit | `47f943859bef60e4160492346772ded9b24f765a`(master, 2026-08-13) |
| harness 版本号 | 0.1.0-rc.5 |
| 依赖的稳定接口 | `ctx.agents`(roots/create/AgentHandle)、`Agent.followup/inject/status`、`agent/pre-step` waterfall 与 `PreStepDecision.reject`、`agent/inbox/claimed|discarded`、`session/event`(step/start、turn/end)、`agentDefaultModel.currentSelection()`、`ctx.sessions.flush`、消息 source `{kind:'plugin'}` |
| npm 依赖 | `@deepseek-ai/dsh-llm` 0.1.0-rc.6、`@deepseek-ai/dsh-session` 0.1.0-rc.6、croner ^9.0.0(实测 9.1.0) |

升级 harness 后必须重跑下方验收。pin 信息同时写在 `package.json` 的 `dshCompatibility` 字段。

## 安装

```sh
dsh plugin --profile <name> add /path/to/dsh-scheduled-prompt
dsh --profile <name> --dump-config   # 应出现 "# == dsh-scheduled-prompt" 层与 scheduled-prompt 行
```

`@deepseek-ai/dsh-llm` 与 `@deepseek-ai/dsh-session` 必须由插件自己固定依赖；link 安装若借 profile fallback 解析这两个运行时 import，会被 HMR 归到 profile 模块图并触发整棵 TUI 重载。第三方调度依赖是 `croner`。

## 配置

bundle 自带默认层(`cordis.patch.yml`):`storePath: !!js dshHomePath('scheduled-prompt')` + `jobs: []`(装上即静默待命,什么都不跑——与 base bundle `agent-loop.agents: []` 同一出厂惯例)。在 profile 的 `cordis.patch.yml` 里用 id 定向 patch 覆盖(**整个 config 替换**,保留 storePath 要重新写):

```yaml
- id: scheduled-prompt
  config:
    storePath: /abs/path/for/run-records     # 必填,绝对路径;<storePath>/runs.jsonl 追加 run 记录
    jobs:
      - id: hello                            # ^[A-Za-z0-9][A-Za-z0-9._-]*$,全局唯一
        schedule: '*/5 * * * *'              # cron 字符串(croner 解析,5/6 段均可,按进程本地时区)
        prompt: 'say hello world'            # 模型可见文本,原样投递(本插件不加任何包装;写英文)
        target: new-session                  # self | new-session
        budget: { maxSteps: 4 }              # 可选;缺省 = 不限步数
      - id: fast
        schedule: { everySeconds: 60 }       # 另一种形态:固定周期,按 floor(t/period) 对齐成桶
        prompt: 'report the current status'
        target: self
```

语义:

- **schedule 两形态二选一**:字符串 = cron(croner 校验,装载时非法即抛;按进程本地时区求下一次触发,无补跑——错过就等下一个对齐点);对象 `{everySeconds: N}` = 固定周期桶(`floor(now/N s)`对齐)。**everySeconds 有启动补桶**:进程启动(或插件装载)时当前桶若无记录会立即触发一次;停机跨越多个桶只补最近一个,绝不逐桶回放。
- **tickKey = `jobId@对齐时刻的 UTC ISO`**(如 `hello@2026-08-14T02:05:00.000Z`)。装载时重放 `runs.jsonl` 已有 tickKey 集合;同 key 再触发只记一行 `skipped-duplicate`,不跑——重启落在已跑过的桶内不会重复执行。无法解析的行按行号 warn 后跳过(崩溃期间被撕裂的尾行不会瘫痪调度,也不会被静默吞掉)。
- **预算护栏**:`budget.maxSteps` 在 `agent/pre-step` waterfall 上执行——第 maxSteps+1 步被 `{kind:'reject'}` 拒绝,agent-loop 以 `turn/end reason {kind:'blocked'}` 干净收 turn(不 abort 进行中的流,是 loop 自己的文档化收口路径),run 记 `budget-exceeded`。预算只约束**本插件发起并被 claim 的 turn**;`self` 模式 busy 时 `inject()` 的内容并入常驻 turn,归那个 turn 的预算管不到(如实见下方边界)。
- **run 记录**:每次被派发的 tick 恰好追加一行 JSON:`{jobId, tickKey, mode, delivery?, startedAt, endedAt, status, steps, sessionId?, error?}`;status ∈ `ok | failed | budget-exceeded | skipped-duplicate`,steps 按会话日志 `step/start` 计。装载时 mkdir + 试写,失败即抛(fail-loud);运行期追加失败则 error 级日志并**停摆全部后续 tick**(宁可不跑也不无账跑)。
- **self 的常驻对象**:取注册序最老的、非本插件所创的 root agent;没有则记 `failed`。busy(status `running`)→ `inject()`,记 `ok, delivery: inject, steps: 0`(送达即记账,消费归常驻 turn);idle → `followup()`,追踪到 turn/end 才定 status。
- 定时器在 **Loader settle 之后**才武装(与 headless runner 同因:agent 工厂由 agent-loop 行注册,兄弟行并发挂载,立刻触发的补桶 tick 可能撞上半组合的应用);全部 timer/listener 挂 `ctx.effect()`/`ctx.on()`,随 fiber 卸载;卸载时在飞的 run 收尾记 `failed`(scheduler disposed)。
- config 校验全部装载时抛错:storePath 绝对路径、jobs 数组、id charset+唯一、schedule 二选一且合法、prompt 非空、target 枚举、maxSteps 正整数、**未知键一律拒绝**(防拼写错默默失效)。

## 边界(如实声明)

- **`jobs: []` 合法**(装上待命);任务书要求"jobs 非空",此处刻意放宽——否则出厂默认层装上即炸 profile。有 job 时逐字段严格校验不变。
- **`source.kind: 'cron'` 不存在于 harness**:`MessageSourceMap` 实际是 `user | plugin | model | tool`(merge-extensible),本插件用 `{kind:'plugin', plugin:'scheduled-prompt'}`,cookbook 提到的 `'cron'` kind 在被 pin 的源码里没有定义。
- **prompt 原样投递**,不加任何插件生成的模型可见包装;需要提示语境请写进 prompt 本身(英文)。
- **self 模式在常驻 surface(web 等)才完整**:headless 是一次性 surface,主任务收官进程即退。busy→inject 路径在 headless 可真实验收(见下);idle→followup 路径与 new-session 共享同一套 claim/turn 追踪代码,由 new-session 验收覆盖。
- **inject 的消费不保证**:`inject()` 排的是下一个 pre-step 的上下文,若常驻 turn 在下一步之前结束,消息停留在 inbox 直到下一次唤醒;run 记录记的是"送达",不是"被模型读到"。
- **预算无法约束 inject 并入的常驻 turn**(见上);也没有墙钟超时——卡死的模型流由 harness 自身的 timeout 政策兜底,本插件不重复造。
- **at-most-once**:run 记录在 turn 结束时落盘;进程在 run 进行中被杀,该桶已在内存去重集合但没有记录……重启后该桶**会**重跑(replay 只认落盘行)。语义是"每桶至多成功记账一次",不是恰好一次。
- cron 按**进程本地时区**求值(croner 默认);tickKey 恒为 UTC ISO,跨时区迁移进程会改变 cron 的墙钟对齐,不改 key 格式。
- 模型选择取创建时 `agentDefaultModel.currentSelection()` 写进 agentOptions;不挂 `installModelSelection`(一次性 run 不需要中途切模型)。

## 测试与验收实录

单元测试(纯逻辑,无需 harness):

```sh
npm install && npm test   # node:test,14 项全过(config 校验/tickKey/去重重放/cron+everySeconds 下次触发/记录序列化/状态映射)
```

行为验收(keyless,mock LLM 驱动真组合;`$DSH` = harness 源码根,全程 `DSH_HOME=/tmp/dsh-ws4-home` 沙盒,mock 端口 8125,2026-08-14 于 pin 版本实测):

```sh
# 安装 + 组合验证
DSH_HOME=/tmp/dsh-ws4-home dsh plugin --profile headless add <本目录>
DSH_HOME=/tmp/dsh-ws4-home dsh --profile headless --dump-config   # 出现本插件层
# mock(路径 1/2;首个请求慢 19s 当作主任务保活,其余秒回)
node --import tsx packages/test-support/llm-mock-server/src/bin.ts --port 8125 --api-key mock-key \
  --sequence slow_success,success --repeat-last --chunk-delay-ms 1200 --chunk-size 1 --success-text "hello world done"
# 会话侧
DSH_HOME=/tmp/dsh-ws4-home DSH_PERMISSION_MODE=danger-full-access \
  DEEPSEEK_BASE_URL=http://127.0.0.1:8125/v1 DEEPSEEK_API_KEY=mock-key \
  dsh --profile headless "summarize your purpose in one sentence"
```

1. **到点触发(everySeconds 5 + new-session)** — 预先按"上个进程已跑完当前两个桶"写入两行记录模拟重启;实跑 22.4s:补桶 tick 记 `skipped-duplicate`(去重生效),随后 :30/:35/:40 三个对齐 tick 各产出一行 `status:"ok", steps:1, delivery:"followup"`,`$DSH_HOME/sessions/**/scheduled-hello-*/session.jsonl.zstd` 三份会话日志落盘,mock 侧 attempt 2-4 为对应请求。
2. **busy 时 inject(self + everySeconds 4)** — 主任务 turn 慢流 19s 构成 busy 窗口,五个 tick 全部落窗内:runs.jsonl 五行 `delivery:"inject", status:"ok"` 指向常驻会话;解压该会话日志,五条 `agent/inbox/spliced {target:"next-step"}`,inserted 消息 `source:{kind:"plugin",plugin:"scheduled-prompt"}`,慢流结束后一条 `removedCount:5` 的 claim 进入 step 2(1 turn、2 steps)。
3. **预算超限(maxSteps 1 + tool_call_success)** — mock 对调度请求恒回 `write` 工具调用:step 1 执行(目标文件真实写入 `/tmp/ws4-budget/out.txt`),step 2 被本插件拒绝,会话日志 `turn/start → step/start(1) → tool/call(write) → tool/result → step/end(1) → turn/end {kind:"blocked"}`(无 step 2),三个 tick 各记 `status:"budget-exceeded", steps:1`。

> 源码启动(`node --expose-internals --import tsx/esm apps/cli/src/bin.ts`)解析 profile 里的裸包名需要 `--expose-internals`;产品安装态不受影响。

## 产出归属

Papertable 简报 19 战役 WS4(2026-08-14)。零 Papertable 业务耦合,job 全部来自 config。
