# deepseek-harness 插件化可行性报告(简报 18)

- 执行方:Cursor Agent(Fable 5,w1:pC)
- 日期:2026-08-14(v2,修订版:v1 中若干 Papertable 侧事实取自失真的中间摘要,已逐项对照仓库核实更正;判定结论不变)
- 方法:两个子代理并发只读调研(①harness 挂载点盘点;②Papertable 8 项候选摸底)+ 主代理自读 harness 关键文档、对冲突事实做仓库核实后汇总。两仓库均未做任何修改。
- 引用路径约定:`dsh:` 前缀 = `/Users/qinshu/Documents/ChatGPT/MemOS/deepseek-harness/`,`pt:` 前缀 = `/Users/qinshu/Documents/papertableV1/`。

## 结论速览

| # | 候选 | 判定 | 一句话理由 |
|---|---|---|---|
| 1 | 提案契约/人审闸门 | **可行但要抽象** | 状态机/证据包/版本守卫全通用且实现干净(~900 行),但现状鉴权真空,搬到 dsh 必须换成真实的"人命令+approval"身份机制;短期更优解是 MCP 桥接镇纸现有 API |
| 2 | agent-bridge 文件桥 | **不可行**(作为插件) | 零代码约定(PROTOCOL.md 并不存在,协议散在简报/GUARDRAILS/HANDOFF 里),价值恰在产品中立;dsh 已内建更强的跨产品委托(subagent-codex/claude-code)。可做成 skill 文档 |
| 3 | 模式条/对账条 | **不可行** | 79 行只读聚合,计数源全是镇纸业务表;dsh 自有 pending-approval/questions UI;抽掉业务后只剩无内核的 UI 模式 |
| 4 | 定时捞料 | **可行但要抽象** | 调度与"后台 LLM 任务纪律"(预算护栏/幂等/审计)骨架通用,捞料业务留在 prompt/skill;最低成本路线甚至不需要插件(外部 cron + headless) |
| 5 | 观众声音 pipeline | **不可行**(作为插件) | 业务管线;其可移植部分(固定桶+逐字 prompt+切批 map-reduce+覆盖对账)应做成 skill/workflow 配置,dsh 已有全部底座 |
| 6 | MemOS 记忆集成 | **可行** | 工具桥接零代码(dsh 已有 `examples/mcp-memory` overlay 范例);"记忆规矩"可做成小而通用的 prompt-section 插件 |
| 7 | GUARDRAILS 守门红线 | **可行(推荐 MVP)** | 34 行纯文档、零技术强制,且其来源研究报告自认"agent 能改守门人,铁律就只是文档";dsh 恰好有官方 permission-gate 模板补上强制,~200 行,普适性最高 |
| 8 | 证据缺口/召回契约 | **不可行(过早)** | 召回漏斗账本已有 ~580 行实现(比简报预想落地),但"反向召回"主动能力无实现、方向未经押注验证;将来自然落点在 dsh 记忆/session-query 生态 |

前置关键事实(影响所有判定):**dsh 的仓库外插件是一等公民**。`dsh plugin --profile <name> add <pkg>` 支持 npm/git/tarball/本地 link 安装(`dsh:docs/user/develop/basic/publish.md`),外部 bundle 不受主仓 100% 覆盖率/JSDoc/invariant 等门禁约束,已有真实外部范例(github:deepseek-harness/turtle-ui)。所以"做成 dsh 插件"≠"进 dsh 主仓",成本比预想低一个量级。

---

## A. 挂载点盘点

### A1. 扩展点清单(与候选相关的核心子集)

| 扩展点 | 所在包 / ctx key | 注册方式 | 证据 |
|---|---|---|---|
| 工具注册 | `core/tools` / `ctx.tools` | `ctx.tools.register(defineTool({...}))`,返回 disposer;原始 JSON-Schema 定义也可(MCP 工具即此) | `dsh:docs/cookbook/adding-a-tool.md` |
| 工具执行管线 | 同上 | `tools/pre-execute`(waterfall,返回 `allow`/`deny`/`ask` 决策)→ `tools/execute`(包裹派发,超时/重试)→ `tools/post-execute`(结果变换/附加上下文)→ `tools/result`(最终观察);`ctx.tools.guard()` 单调最终拒绝(不可翻案);`ctx.tools.restrict()` 作用域过滤 | `dsh:docs/cookbook/extension-cookbook.md`(permission-gate 示例) |
| 人审闸门 | `interaction/user-approval` / `ctx.approval` | 闸门插件在 `tools/pre-execute` 返回 `{kind:'ask', reason}` → 管线自动走 `ctx.approval.request()` → `approval/request` waterfall 由 UI/ACP answerer 应答 → 闭合结果 `allowed-once\|rejected\|cancelled\|unavailable`,**fail-closed**(无 answerer=拒);审计对 `approval/asked`/`approval/decided` 落日志(log-only,不进模型转写) | `dsh:docs/subsystems/approval.md` |
| 会话策略/预设 | 同上 + `interaction/permission-presets` | 每会话 `ask\|never` 策略经 `approval/policy` 事件持久化,`never` 在服务内强制不可绕;permission-presets 把 sandbox mode + approval policy 捆成用户可切预设 | 同上 |
| 模型问人 | `interaction/user-questions` + `tool-ask-user` | 与 approval(动作批准)分离的问答 seam;plan 审批复用此座 | `dsh:packages/interaction/README.md` |
| 人命令 | `interaction/commands` / `ctx.commands` | 人触发、不经模型 turn(`/plan`、`/compact` 即此),写 `command/run|done` 事件 | `dsh:docs/subsystems/commands.md` |
| system-prompt 片段 | `core/system-prompt` / `ctx.systemPrompt` | `section({name, order, text})` 有序拼接、agent 级 shadowing;`context()` 注入动态"runtime context"(user-role 快照,变化才追加,KV-cache 友好);`variable()`、`system-prompt/assemble` waterfall 终审 | `dsh:docs/subsystems/system-prompt.md` |
| 注入上下文 | `core/agent` | `agent.inject()` 随下一条被接纳的消息进请求,且落日志(满足 model-visible ⟺ logged) | `dsh:docs/architecture.md` |
| session 自定义事件 | `core/session` / `ctx.sessions` | declaration merging 扩展 `SessionEventMap`,默认 log-only;外部插件事件应带 `ignorable: true`,否则不装该插件的组合拒读该会话日志。先例:`plan/mode`、`schedule/change`、`hook/invoked`、`permission/preset` | `dsh:docs/subsystems/session.md` |
| agent 生命周期 | `core/agent`(-loop) | `agent/session-start`、`agent/pre-step`(waterfall,模型看什么的最后闸门)、`agent/request`、`agent/request-error`、`agent/turn-stopping`(可 steer 强续) | `dsh:docs/architecture.md` Turn flow |
| 会话内定时 | `schedule/` | `schedule/change` 事件为唯一持久态;timer 只在 Session 有 live root Agent 时等待;到点等完全 idle、占 maintenance phase 后 `followup()` 回同一会话。**无冷会话调度、无外部通知通道**;`every_seconds` ≥300 | `dsh:packages/schedule/README.md` |
| 后台任务 | `jobs/` / `ctx.jobs` | 通用后台任务运行时 + `job_*` 工具(`run_in_background` 型工具的底座) | `dsh:packages/README.md` |
| workflow | `workflow/` / `ctx.workflowEngine` | worker-thread 引擎 + `workflow`/`ralph` 工具,模型写脚本编排子 agent | `dsh:docs/subsystems/workflow.md` |
| skill | `skill/` / `ctx.skills` | 技能=目录+SKILL.md,目录注入首个 pre-step,按需 `inject()` 内容——把"规矩/流程文档"交付给模型的最轻路径 | `dsh:docs/subsystems/skills.md` |
| subagent | `subagent/` / `ctx.subagents` | 命名多 provider 并存:in-process、fork、ACP、**codex、claude-code**、dsh-sdk——跨产品委托已内建 | `dsh:docs/subsystems/subagent.md` |
| MCP 客户端 | `mcp/mcp-client` | 每 MCP server 一个插件实例(stdio / streamable-http),发现工具 → 注册为 `mcp__<server>__<raw>`;断线重连、list_changed 再同步、HMR 热换。**只桥 Tools**(Resources/Prompts 明确 deferred) | `dsh:packages/mcp/mcp-client/README.md` |
| hooks 桥 | `hooks/` | 把 Claude Code / Codex 的 hooks.json shell-hook 协议映射到原生拦截点(PreToolUse→tools/pre-execute 等);README 明言 native Cordis 插件能做得更强 | `dsh:packages/hooks/README.md` |
| plan 模式 | `plan/plan-mode` / `ctx.planMode` | `plan/mode` log-only 事件 + 纯 fold 恢复状态;`plan:policy` prompt section;`exit_plan_mode` 经 user-questions 座人审退出——"提交→人审→放行"的现成同构物 | `dsh:docs/subsystems/plan.md` |
| Web GUI 扩展 | `client/ui-slots` + Conversation Node | `ctx.slots.register(...)`;业务行进 Chat 用 `ConversationNodeDefinition` + keyed renderer | `dsh:packages/client/README.md` |
| LLM provider | `llm/` / `ctx.llm` | `LlmAdapter` 子类 `registerAdapter`;`llm/stream` waterfall 可拦截流 | `dsh:docs/cookbook/adding-an-llm-adapter.md` |
| settings / credentials | `settings/`、`credentials/` | 插件配置走 zod `Config`(cordis.yml 校验、fail loud);用户偏好走 `ctx.settings.register(ns, schema)`;密钥走 `ctx.credentials`(配置里只放 env 引用,每操作 resolve) | `dsh:docs/subsystems/settings.md` |
| 非会话存储 | `storage/` | 跨会话业务对象的现成落点(hub + backends + domain form) | `dsh:packages/README.md` |
| preset | `preset/agent-presets` / `ctx.agentPresets` | `agent.cordis.yml` 目录=一个 preset,按 agent scope 挂载,一进程多组合 | `dsh:packages/preset/README.md` |
| guard | `guard/` | repeat-tool-reminder(advisory 提醒,从不阻断)+ timeout-policy(`tools/execute` deadline)——"纯挂既有扩展点的自足消费者"范本 | `dsh:packages/guard/README.md` |

`dsh:docs/cookbook/extension-cookbook.md` 末尾的 feature→mechanism 映射表把 Claude Code 级产品特性(hook 系统、/goal、/loop、压缩、MCP、记忆、cron、UI、模型适配器、热重载)逐条映射到上述扩展点,是"微内核主张的可查验版"。

### A2. 打包 / 加载 / 配置

- **插件形态**:ESM(`"type":"module"`),`@deepseek-ai/cordis` 为 peerDependency。函数插件 named-export `name`/`inject`/`Config`/`apply` 且无 default export(混用会让 Loader 丢弃命名空间,postmortem 0001);service 包 default-export 服务类。`Config` 是 zod schema,cordis.yml 按 schema 校验,配错加载时 fail loud。
- **加载**:cordis.yml 每行 `{id, name, config?, disabled?, inject?}`;`!!js` 只允许在 `config` 和 `disabled`。overlay/patch 按 row id 插入或**整体替换**(不深合并)。
- **分发(仓库外)**:npm 包声明 `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}` 即成为可安装 bundle;`dsh plugin --profile <name> add <pkg>` 转发 pnpm,支持 npm / `github:you/repo#sha` / tarball / 本地目录。git 安装需自包含 `prepare` 构建脚本 + 用户 allowBuilds 允许(发 npm/tarball 则免)。层序:profile 的 bundles(列表序)→ profile 自己的 cordis.patch.yml → home 级 patch → `--patch` overlay,后层按 row id 覆盖。`dsh --profile <name> --dump-config` 可打印实际启动树。
- **每会话组合**:preset 目录给单个会话独立的工具/提示词组合;profile 决定进程组成,preset 决定单会话能力集。
- **主仓 vs 仓库外的成本差**:主仓内包受 per-file 100% coverage、README(Model Experience)、`./invariant`、JSDoc 门、keyless snapshot、REAL-composition 测试等门禁;**仓库外 bundle 全部豁免**,只需正确的插件导出形态 + ESM + cordis peer。给 Papertable 的结论:一律走仓库外 bundle。注意 dsh 处于 pre-release("foundation over blast radius"),无兼容承诺,外部插件要 pin 版本跟着断裂变更走。

### A3. examples 对比

- `headless-agent`:一次性任务跑完即退,最完整的"无 UI 全功能"参考;snapshot 测试主载体。
- `acp-agent`:ACP stdio 自动化服务器;权限/沙箱/hooks 全家桶参考(approval policy 用 `!!js` 按环境切换的范本)。
- `jsonrpc-agent`:SDK JSON-RPC 最小嵌入组合。
- `web-cordis`:自我修改演示(tool-cordis)。
- `web-schedule`:web 组合之上**两行 patch** 启用 schedule——"最小 overlay 加能力"的模板。
- **`mcp-memory`:接外部服务的最直接范例**——三个 overlay 文件(`memorix.cordis.yml`、`mcp-reference-memory.cordis.yml`、`engram.cordis.yml`),每个只 insert 一行 `@deepseek-ai/dsh-mcp-client`(stdio),README 给了"带自己的 MCP server"通用行模板与验证流程(写→新会话召回→使用)。外部记忆系统以 MCP tool 形态零代码进入。(v1 报告误称此示例不存在,系 glob 模式漏了 `*.cordis.yml` 命名,已更正;简报所述无误。)

### A4. 写插件的硬约束(与候选相关的)

- **Model-visible ⟺ logged**:任何进入模型请求的内容必须可从 session log 重建;新模型可见输入需要新 session 事件(`agent.inject()` 已合规)。
- **Registrations are effects**:所有注册经 `ctx.effect()`/`ctx.on()`,返回 disposer,HMR/卸载可逆。
- **waterfall 必须 `next()`** 委托,不调用即短路(单决策事件的短路是设计)。
- **approval fail-closed**:headless/无 answerer 环境下 `ask` = `unavailable` = 拒——守门类插件在无人值守场景下默认安全。
- 工具的 UI render intent 是设计的一部分,presenter 必须是 args 的纯函数(回放会调用)。

---

## B. 候选 × 挂载点映射(逐项判定)

### 1. 提案契约/人审闸门 — 可行但要抽象

**Papertable 现状**(`pt:src/pw-proposals.ts`,404 行 + 测试 ~300 行 + 前端 `frontend/src/pw/Proposals.tsx` 213 行):单表 `pw_proposals`(SQLite,21 字段:lane、target_kind、base_version、brief_ref、payload_json、evidence_json `{for/against/unknowns}`、checks_json、risk、requested_action、expires_at…)。状态机写死为出边集合、非法迁移 400:`submitted → in_review/accepted/rejected/changes_requested/expired`,`changes_requested → submitted`(退修重提),`accepted → applied → verified/rolled_back`。apply 仅当 accepted 且 base_version 比对通过(不等 → 409 stale);每次迁移落 `pw_runs` 审计(actor 分 ai/human/system)。**关键现实:HTTP 层无任何鉴权**——"review/apply 只供人触发"靠注释、GUARDRAILS 纪律和事件审计维持,不是技术强制(子代理②的横向观察称之为"最大不可直接移植点")。

**harness 同构物**:plan-mode 已实现"模型提交 → 人审(经 user-questions 座)→ 放行"的完整回路;approval seam 已实现 fail-closed 闸门 + 审计落日志;`storage/` 提供跨会话业务对象存储;`ctx.commands` 提供只有人能触发的命令通道(不经模型 turn)——这恰好补上镇纸缺的身份强制。

**插件方案**(如果做):独立 bundle `dsh-proposal-gate`:
- `submit_proposal` / `withdraw_proposal` / `list_proposals` 工具(`ctx.tools`),schema 保留 evidence/checks/risk/base_version 结构(这套"最小提案包"经过真实使用验证);
- 提案对象存 `storage/` 域(跨会话),状态迁移记审计事件;
- review/apply 做成 `ctx.commands` 人命令——**模型根本没有对应工具,身份分权从"纪律"变成"通道天然隔离"**;apply 前重算版本比对,执行动作前逐条走 `ctx.approval`;
- 可选:Web UI 用 Conversation Node 渲染提案卡。

**为什么"要抽象"**:(a) lane(content/ops)、target_kind 枚举、brief_ref、`pw_runs` 审计都要换成可配置/harness 原生等价物;(b) requested_action 的动作词汇表要与镇纸解耦;(c) 全套含 UI 是 8 项里最重的(估 1–2 周)。**短期更优解**:镇纸已有 5 条 HTTP 端点,包一层薄 MCP server(或给镇纸加 MCP 端点),用 `dsh-mcp-client` 一行配置接入——dsh 里的 agent 立即能 submit/list,人审留在镇纸 UI(ProposalInbox 已上线)。这条路不算"做成插件",但当天可用,不排斥以后再做通用插件。

**动 harness 核心吗**:不需要,全部落在文档化扩展点上。

### 2. agent-bridge 文件桥 — 不可行(作为插件)

**勘误**:简报所引 `agent-bridge/PROTOCOL.md` **不存在**(全仓 glob 零命中);协议实质散在各简报文本、`GUARDRAILS.md` 和 `HANDOFF-PW-63.md` 里,零代码、无任何程序读写 briefs/out。事实协议:编号简报(`briefs/NN-主题.md`,开头必须引 GUARDRAILS)→ 执行方在会话里回报、产物类报告才写 `out/` → 验收是独立简报(验收人只验不改,截图落 `qa-evidence/`)→ 投递靠 herdr(`herdr agent prompt <TARGET> "读 briefs/xx.md"`)而非文件通知。

**判定理由**:价值恰恰在于任何能读写文件的 agent 都能参与;做成 dsh 插件会把产品中立的协议绑死在一个 harness 上,且与 dsh 内建的 subagent providers(codex/claude-code/ACP,同步、结构化、带生命周期)重叠。**建议形态**:把协议整理成一份 SKILL.md(顺带补上现状缺失的成文 PROTOCOL),交付给任何产品的 agent;不写代码。

### 3. 模式条/对账条 — 不可行

`pt:src/pw-mode-bar.ts` 仅 79 行:单函数纯 SELECT 聚合四个"待人裁决"计数(押注草稿/结账草案/语料提议/待审提案)+ 最近 8 条 `pw_runs` 活动 + 固定的 writeDiscipline 纪律文案;前端 slim 条 + hover 明细,只读无按钮。每一个计数源都是镇纸业务表;dsh 侧已有自己的"待人裁决"呈现(`ui-permission`、`ui-user-questions`、`ui-jobs`)。若真要通用化,正确形态是设计"pending-review 计数源注册接口"让各插件自报计数——一个新造的小 seam,而非搬运这 79 行;需求端(dsh 用户)没有证据要它。不建议投入。

### 4. 定时捞料 — 可行但要抽象(且最低成本路线不需要插件)

**Papertable 现状**(`pt:src/pw-miner.ts` 782 行 + 测试 ~370 行 + 前端 BoardTab ~600 行;调度集中在 `pt:src/main.ts:335-368`):每 5 分钟 tick,过本地 06:30 且当天无 scheduled run 才跑(修过 UTC/本地日界 bug);一轮 = 四类只读来源采集(Memos 笔记库 SQLite 只读 + `pw_verdicts` 金子/墓碑 + gold 镜像 + MemOS MCP `search_memories`,合计 ≤120 条)→ 预算预检(超 ¥0.15/轮直接 fail)→ DeepSeek 两跳 LLM(挑候选 → 聚合成概念卡)→ `INSERT OR IGNORE` 幂等落库 → 人审三动作(confirm/reject/seed)+ 全程漏斗打点进召回账本(候选 8)。调度器不在模块里、只在 main.ts,是仓库纪律。

**dsh 侧对应**:`schedule/` 是会话本地定时(到点 followup 回同一会话,无冷会话调度);真正"无人值守定时跑任务"官方认可两条路:
1. **外部 cron + `dsh --profile headless "任务"`**——零插件。捞料 prompt 写成 skill,产出写文件或调镇纸 API。
2. **自写常驻 cron 插件**:extension-cookbook 明示该模式(timer 到点 → idle 时 `followup(source:{kind:'cron'})` / busy 时 `inject()`)。通用插件形态 = "scheduled-prompt":config 声明 `[{schedule, prompt, preset?}]`,到点起 headless 会话跑 prompt。

**真正可抽象的通用资产**不是捞料本身,而是 pw-miner 沉淀的"后台 LLM 任务纪律":预算护栏(超限即 fail 并记 run)、幂等日界去重、run 表记 provider/model/cost/raw_response、来源做成 provider 列表。这套骨架被真实调试过(幂等 bug、预算超限、被弃反例都踩过),做 scheduled-prompt 插件时应继承。**判定**:可行但要抽象;若只为眼前需求,选路线 1 不写插件。

### 5. 观众声音 pipeline — 不可行(作为插件)

**Papertable 现状**是三段式:①抓取——后端授权队列(`pw_corpus_docs` 状态机 proposed→authorized→fetching→done/failed/needs_human,授权在人)+ `pt:scripts/pw-fetch-bili-corpus.js`(在 ego-browser 环境跑,带 cookie、限速、撞风控即停交人);②筛子——`pt:skills/voice-comment-sieve/SKILL.md`(仓库内置 skill)驱动外部 agent 执行:固定 8 桶、逐字相同的批间 prompt、50 条/批切批 + 并发子代理 map-reduce、覆盖对账行(无重无漏、信号+噪音=总数);③落库——`POST /api/pw/voice/sieve-runs/import` **后端强制复核对账,不过就 400 不落库**。

**判定理由**:bvid/rpid/中文桶名/选题提升链全是业务;通用骨架("外部数据→逐条筛→分桶→报告")在 dsh 已有全套底座(web seam、workflow、subagent map-reduce)。值得移植的是**方法论**而非代码:固定桶+逐字 prompt+覆盖对账的批量 LLM 判定纪律,和"产出先落文件、导入时强制对账"的入库门——都应以 skill / workflow 配置形态交付。不做插件。

### 6. MemOS 记忆集成 — 可行

三层,成本递增:

**第一层:工具桥接(零代码,当天可用)**。dsh 已有现成范例:`dsh:examples/mcp-memory/` 的三个 overlay 每个只 insert 一行 `dsh-mcp-client`。接 memos-local 同理:

```yaml
- insert:
    - id: mcp-memos
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: memos
        transport: stdio        # memos-local 也支持 streamable-http 时可换 url
        command: <memos-local 启动命令>
```

模型立即看到 `mcp__memos__get_hot_context` 等全部工具。注意 mcp-client 只桥 Tools(对 MemOS 够用)。

**第二层:"记忆规矩"插件(小而通用)**。现状规矩在 `~/.cursor/rules/memos-routing.mdc`(每新会话先 get_hot_context;route 后只搜 1–2 个 Cube;只存持久事实;不绕容量控制),是 Cursor 专属交付,换 harness 就丢了;papertableV1 仓库内也确认没有这套纪律的代码实体(只有 HANDOFF 里一句口径)。做成 `dsh-memory-discipline` 插件:
- `ctx.systemPrompt.section()` 注入规矩文本(feature map 官方路径:"Memory = section provider + tool");
- 可选:`agent/session-start` 时自动调 get_hot_context 并 `agent.inject()` 结果(落日志,合规);热上下文若走"变化才追加"的形态,用 `ctx.systemPrompt.context()`(runtime context)更省 KV cache;
- **要剥离的耦合**:MemOS 具体工具名做成 config(`{hotContextTool, routeTool, searchTool, policyText}`),即对任何记忆 MCP(mem0、zep、自建)通用。

**第三层(镇纸侧资产,不影响 dsh 判定,备忘)**:papertableV1 里其实有约 1000 行产品级 MemOS 管道——`pt:src/memos.ts`(350 行,MemoryBridge:闲置会话自动打包 JSONL 转录、幂等登记、`POST /hooks/v1/events` 提交、失败重试)和 `pt:src/verdict-memos.ts`(判决簿与 cube 同步,只 supersede 不删除)。这些是镇纸→MemOS 的自动 staging,属产品自身管道,不需要也不适合搬进 dsh 插件;但"提供↔显式引用标注↔审计"的判决复用契约(TASK-KU-001 v2)值得在未来 dsh 记忆插件设计时参考。

普适性:高——"接了记忆 MCP 但模型不会用/乱用"是所有 harness 用户的共性问题。工作量:第一层半天(纯配置);第二层 2–3 天。

### 7. GUARDRAILS 守门红线 — 可行(推荐 MVP,见 D)

**Papertable 现状**(`pt:agent-bridge/GUARDRAILS.md`,34 行,零代码 enforcement):四类守门文件/动作,任何 agent 不得自行修改,确需改动 → 回报里提建议、等用户批准后单独开简报:①权限与状态机代码(main.ts 路由权限段、pw-collab 写工具纪律、settle/confirm/审批流函数);②数据库 schema 变更(`CREATE TABLE IF NOT EXISTS` 以外的一切结构动作);③部署与常驻进程(launchd plist、启停/构建/发布脚本);④**验收检查定义**(selfcheck、CI 脚本、简报写死的判定标准——agent 不得改检查本身让自己"通过")。例外:读不受限,限的是写。文档自己的来源注记就承认缺口:"agent 能改守门人,铁律就只是文档不是控制"(2026-08-12 研究报告第 10 条漏坑)。

**dsh 恰好补上强制这一块**,且官方文档就给了模板(extension-cookbook 的 permission-gate 示例改 deny 为 ask 即是):

```ts
export const name = 'guardrails'
export function apply(ctx: Context) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    const target = writeTargetOf(exec)          // fs 写类工具的目标路径
    const rule = matchProtected(target, config) // config 里的 glob 列表
    if (rule) return { kind: 'ask', reason: rule.reason }
    return next()
  })
}
```

`ask` 自动进 `ctx.approval`:交互环境弹人审,headless 无 answerer 时 fail-closed 直接拒,审计对落日志——正是"改动需人点头 + 全程留痕"的技术化。注意用 `tools/pre-execute` 而非 `ctx.tools.guard()`(后者单调 deny,人无法翻案放行)。

- **要剥离**:四类清单 → config(`protected: [{glob, reason}]`);GUARDRAILS.md 的①③④直接翻成 glob(②schema 变更是语义级,glob 只能近似为迁移目录/DDL 脚本路径,v1 如实声明边界)。第④类"agent 不得改验收定义"是很好的通用预设示例(保护 CI/测试脚本路径)。
- **边界要诚实**:v1 只拦 fs 写类工具(Write/StrReplace/Delete 等);bash 命令里的写路径静态识别不可靠,v1 对 bash 保守处理(命令文本命中受保护路径即 ask)或明确声明不覆盖,真正的进程级围栏交给 dsh 已有的 `sandbox/` 轴。与 permission presets 不冲突:定位是其上的声明式补充("这些 glob 永远 ask,不随 preset 放宽")。
- **动核心吗**:完全不动,单 waterfall listener。

### 8. 证据缺口/召回契约 — 不可行(过早)

**勘误与现状**:仓库里**没有**"当前工作反向召回库存证据"为题的研究报告(`pt:agent-bridge/out/未命名.md` 是 2026-08-12 的**协作台**研究报告——提案契约/模式条/GUARDRAILS 的共同设计源头;召回研究要么未入仓要么在 MemOS 记忆里,建议向用户确认)。但这个方向比简报预想**落地得多**:已有 `pt:src/pw-note-recall.ts`(192 行,确定性关键词抽取召回,无 LLM,命中门槛≥2 关键词"宁缺毋滥")和 `pt:src/pw-recall-events.ts`(211 行,召回漏斗账本:surfaced→confirmed/rejected/attached/used/settled 六种事件 × 四个出口,**红线:AI/系统只能写 surfaced,其余只来自人触发**;立意是"先拿分母再改功能")。

**判定理由**:作为 dsh 插件仍过早——"反向召回"主动能力无实现、方向未经用户押注验证;且其自然落点(记忆检索 + 使用审计)依赖 dsh 记忆生态成熟。**但两个模式值得记下**:①召回漏斗账本("AI 只许写 surfaced"的分母记账)对任何带记忆的 harness 都是缺失的观测层;②"全量提供 ≤N 条 + 模型显式 `[[id]]` 标注引用 + 系统解析审计"的复用契约(TASK-KU-001 v2,v1 字符串匹配被真实数据证伪后的改版)。若候选 6 的 discipline 插件落地,这两条可先作为规矩文本(零代码)进 policy 试验。

---

## C. 普适性评估

**对任意 harness 用户有价值(按普适性排序)**:

1. **候选 7 守门审批**:每个让 agent 碰真实文件系统的用户都有"这些路径动之前问我"的需求(.env、生产配置、CI/测试定义、CLAUDE.md 自身)。Claude Code 的 permission 规则是同类物,证明需求普遍;dsh 生态还没有现成的"声明式保护路径"bundle,是空位。"agent 不得改验收定义"这条预设尤其有辨识度。
2. **候选 6 记忆规矩**:记忆 MCP 生态在涨,"模型不会用记忆工具"是共性痛点;参数化后与 MemOS 解耦。
3. **候选 4 scheduled-prompt(含后台 LLM 任务纪律)**:定时让 agent 干活是通用需求;预算护栏/幂等/审计骨架有真实调试沉淀。但外部 cron + headless 已够用,插件版是体验优化,优先级次之。
4. **候选 1 提案契约**:理念(agent 只能提案、人裁决、版本守卫、全审计)对企业/高风险场景吸引力大,"最小提案包"schema(evidence for/against/unknowns + checks + risk + base_version)是 8 项里"思想输出"价值最高的;但完整插件重,先用 7 验证"人审闸门"有没有市场。
5. **候选 2/5**:作为 skill 文档/方法论有复用价值,作为插件无。
6. **候选 3/8**:无普适内核 / 过早。

**共性剥离清单**(所有"可行"项都要做的):
- **鉴权真空必须补齐**:镇纸所有"只供人触发"端点在 HTTP 层无鉴权,靠纪律+审计;dsh 侧对应物是通道天然分权——人走 `ctx.commands`/UI answerer,模型走工具,`ask` fail-closed。这是从 Papertable 搬任何"人审"语义时的第一改造点。
- 存储:镇纸 SQLite(`node:sqlite`,数据目录 `~/Library/Application Support/Papertable/`)→ dsh `storage/` 或插件自管。
- 业务词汇:押注/结账/语料/概念卡/金子墓碑不得进任何模型可见文本(dsh 有"model-facing contracts 只含任务相关概念"的硬规矩)。
- 绝对路径与部署常量 → 已校验 Config 字段(dsh "No hardcoded tunables" 规矩)。
- Cursor/Claude 专属交付通道(rules/skills)→ `ctx.systemPrompt.section()` 或 dsh skill。

---

## D. MVP 建议

**选候选 7:`dsh-guardrails`(受保护路径人审闸门)独立 bundle。**

选它的理由(对比其他候选):
- **最小可验证**:单函数插件 + zod Config,核心 ~150–250 行;候选 1 全套 1–2 周,候选 4 有常驻生命周期的防御成本,候选 6 第一层(MCP 桥)零代码不构成"插件验证"、第二层规模与 7 相当却依赖 MemOS 在位。
- **落在官方模板上**:extension-cookbook 的 permission-gate 示例就是这个形状,不碰核心、不留分叉风险。
- **一次验证完整链路**:out-of-tree bundle 打包(package.json `dsh.bundle` + cordis.patch.yml)→ `dsh plugin --profile <name> add` 安装 → Config schema 校验 → waterfall 闸门 → `ctx.approval` 人审 → 审计落日志。这条链正是以后所有 Papertable→dsh 插件要走的路。
- **与 Papertable 哲学同源且立即自用**:GUARDRAILS.md 的红线本来就自认"只是文档不是控制";把四类清单填进 config,守门从自律变强制。对外则是零业务词汇的通用能力。

**形态与分发**:独立仓库(或 papertableV1 内 `dsh-plugins/` 子目录起步),不进 dsh 主仓。发 tarball 或 `github:...#sha` 安装(git 路线记得自包含 `prepare` 构建,参照 turtle-ui)。

**工作量估计**(一人):
- 核心插件(pre-execute 匹配 + ask + config schema):0.5–1 天
- fs 写类工具目标路径提取 + bash 保守策略 + 测试:1 天
- bundle 打包、profile 试装、headless fail-closed 演练、README:0.5–1 天
- 合计 **2–3 天**出可安装可演示的 v0.1。

**第二步(如果 MVP 顺利)**:候选 6 第一层 memos 桥(半天,纯配置,照抄 `examples/mcp-memory` 的 overlay 形态)+ `dsh-memory-discipline` 插件(2–3 天),两者合成"papertable-flavored dsh profile"的雏形;候选 1 届时再决定走 MCP 桥(快)还是通用 proposal-gate 插件(重)。

## 附:简报勘误与风险备忘

- **简报勘误一**:`agent-bridge/PROTOCOL.md` 不存在(协议散在简报/GUARDRAILS/HANDOFF);整理成文可以作为候选 2 skill 化的顺手产出。
- **简报勘误二**:候选 4 的实现不是独立 cron 模块,而是 `main.ts` 集中调度 + `pw-miner.ts`;来源含 Memos 笔记库(SQLite 只读)与 MemOS MCP,不含 Obsidian。
- **本报告 v1 勘误**:v1 曾称 dsh 无 `examples/mcp-memory`,错误——它以三个 `*.cordis.yml` overlay 存在,且正是候选 6 的最佳模板。
- 简报未提但高度相关的 dsh 包:`schedule/`(会话内定时)、`jobs/`(后台任务)、`storage/`(非会话存储)、`session-query/`(跨会话检索)、`goal/`、`feedback/`——候选 1/4/8 的落点都在这些包附近。
- 风险:dsh 处于 pre-release,无兼容承诺,外部插件要 pin dsh 版本、在 README 声明适配范围;`tools/pre-execute` 类闸门必须记住 waterfall 语义(不 `next()` 即短路)与 fail-closed 含义(headless 下 ask=拒,是特性不是 bug);git 安装的 `prepare`/allowBuilds 摩擦对非技术用户不友好,优先 tarball/npm 分发。
