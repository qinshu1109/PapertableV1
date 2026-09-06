# dsh-proposal-gate

DeepSeek Harness 的**提案人审通道**插件(无 UI 版):模型只有三个工具——`submit_proposal` / `withdraw_proposal` / `list_proposals`;review / apply / verify **只存在于 `/proposal` 人命令**。身份分权靠**通道隔离**而不是提示词纪律:模型侧根本没有能接受、应用或核实提案的工具(会话日志 `request/header` 的 tools 数组可直接验证)。

提案跨会话持久化在插件自有存储(`storePath` 下 `state.json` + 追加式 `events.jsonl` 审计账本);每次状态迁移都带 actor(`ai`=工具 / `human`=命令 / `system`=过期清扫)入账。

## 状态机

```
submitted          → in_review | accepted | rejected | changes_requested | expired   [human/system]
                   → withdrawn                                                       [ai]
in_review          → accepted | rejected | changes_requested | expired               [human/system]
                   → withdrawn                                                       [ai]
changes_requested  → submitted(重提交,revision+1)                                   [ai]
                   → withdrawn | expired
accepted           → applied                                                          [human]
                   → rejected | changes_requested(接受召回;stale 后的标准恢复路径)  [human]
applied            → verified | rolled_back                                           [human]
rejected / expired / withdrawn / verified / rolled_back 为终态
```

非法迁移与越权 actor 一律拒绝并给出原因。相比镇纸原版,新增 `withdrawn`(AI 主动撤回)与 accepted 的两条人工召回边(原版 accepted 只能 applied,stale 的提案会卡死——本插件验收时实测暴露后补上)。

## 版本一致性(stale 拒绝)

- 每个 `target_key` 在存储里有单调版本号(初始 0,每次 apply +1)。
- `submit_proposal` 记录 `base_version`(模型从 `list_proposals` 的 targets 里取);提交时已落后会在返回值里给 `stale_at_submit: true` 预警,但不拒(apply 才是真闸门)。
- `/proposal apply` 重新比对:`base_version != 当前版本` → 拒绝(审计 `kind:"apply-stale"`,状态留在 accepted),人可 `review <id> changes` 要求 rebase 或直接 reject。

## apply 的执行语义(扩展点)

apply 默认 **record-only**:只做状态迁移 + 审计 + 版本推进,不执行 payload 里的动作。要真执行,部署方挂一个监听 `proposal-gate/apply` waterfall 的执行器插件:入参 `{proposal, agent, signal}`,返回 `{kind: 'executed', detail?}`;执行器自己的动作可在其上下文里走 `ctx.approval` 逐条审批。设计理由:payload 动作是部署专属语义,硬编码任何执行器都会破坏零业务耦合;而"人命令通道"本身已经是 apply 的授权(dsh 的 `ctx.approval` ask 要求在开启 turn 内,为模型动作设计,人命令天然在 turn 外)。

## 兼容性(重要)

| 项 | 值 |
|---|---|
| harness commit | `47f943859bef60e4160492346772ded9b24f765a`(master, 2026-08-13,版本 0.1.0-rc.5)|
| 运行时 bare import | `@deepseek-ai/dsh-tools`(defineTool;在 base bundle 依赖里,profile fallback 可解析)|
| 依赖的接口 | `ctx.tools.register`/`defineTool`、`ctx.commands.register/execute`、cordis waterfall |

pre-release 无兼容承诺;升级 harness 后重跑验收。npm 依赖:零。

## 安装与配置

```sh
dsh plugin --profile <name> add /path/to/dsh-proposal-gate
dsh --profile <name> --dump-config   # 应出现 proposal-gate 行
```

默认层(profile patch 可整体覆盖;id-targeted patch 替换整个 config):

```yaml
- id: proposal-gate
  config:
    storePath: !!js dshHomePath('proposal-gate')   # 提案库位置
    lanes: [default]                                # 评审泳道词汇表(全 config 化)
    targetKinds: [document, config, code, data, other]
    requestedActions: [create, update, delete, custom]
    riskLevels: [low, medium, high]
    requireEvidence: true                           # evidence.for 至少一条
    # expireAfterDays: 14                           # 可选:闲置未决提案系统过期
```

`/proposal` 命令语法:`list [status]` | `show <id>` | `review <id> accept|reject|changes|in-review [note]` | `apply <id> [note]` | `verify <id> ok|rolled-back [note]` | `expire <id> [note]`。

## 边界(如实声明)

- **单写者**:一个 store 目录同时只支持一个 harness 进程(state.json 原子重写 + 账本追加,无跨进程锁)。
- apply 默认不执行动作(见上);record-only 时 verified 仍由人判断。
- 过期清扫是惰性的(工具/命令入口触发),不挂常驻定时器;只扫 pre-decision 状态(submitted/in_review/changes_requested)。
- 提案审计在插件账本,不写自定义 session 事件(避免触发 dsh 会话日志版本机制的 required-on-read 拒读);模型可见面(工具调用与结果)照常由 tools 管线落 session 日志,人命令由 commands 落 `command/run`/`command/done`。

## 测试与验收实录

单测(纯逻辑):`npm test` — 14 项全过(状态机边表/actor 分权/词汇表校验/命令语法/存储持久化与审计/过期清扫/损坏文件 fail-loud)。

行为验收(2026-08-14,keyless,mock LLM 脚本化 `submit_proposal` 调用 + `--patch` 挂 `tests/fixtures/demo-driver.js` 走真 `ctx.commands.execute`),一次运行覆盖:

1. **完整状态机**:模型提交 → list → in-review → accept → apply(record-only,target `doc:demo` 版本 0→1)→ verify ok。
2. **stale 拒绝(409 语义)**:第二个提案 base_version=0(提交时即返回 `stale_at_submit:true` 预警)→ accept → apply 拒:`stale: proposal base_version 0 != target "doc:demo" current version 1`,账本记 `kind:"apply-stale"`,状态留 accepted。
3. **召回与重提交**:`review changes` → changes_requested → AI 带 `proposal_id` 重提交(rev 2,base 1)→ accept → apply 成功(版本 1→2)。
4. **非法迁移拒绝**:changes_requested → verified 被拒并列出合法出边;accepted → submitted(AI 越权重提交)被拒。
5. **fail-closed 通道隔离**:会话日志 `request/header` 的 tools 数组仅含 `list_proposals`/`submit_proposal`/`withdraw_proposal`,不存在任何 review/apply 工具;22 条 `command/run`/`command/done` 审计入会话日志。
6. **账本**:`events.jsonl` 12 条迁移全带 actor/via/note;终态 `p-…13 verified`、`p-…f5 applied`,targets `doc:demo=2`。

> 源码启动解析 profile 裸包名需 `--expose-internals`(loader 可选原生助手未装时);产品安装态不受影响。mock 服务器的行为脚本是跨请求 FIFO,重跑验收前要重启 mock。

## 产出归属

Papertable 简报 19 战役 WS3(2026-08-14),对应可行性报告候选 1。词汇表全 config 化,零 Papertable 业务耦合。
