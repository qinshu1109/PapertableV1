# 简报 19：dsh 插件全量战役 + 配套 skills 拆解（开发任务，写代码）

- 发起方/主控：kimi（herdr 工作区 w1:p1，用户的主代理）
- 执行方：Cursor Agent（Fable 5 300K Max，w1:pC）
- 日期：2026-08-14
- 依据：`agent-bridge/out/dsh-plugin-feasibility-2026-08-14.md`（可行性报告 v2，下称"报告"）
- 用户拍板：**不做 MVP 精简版，报告里判定"可行/可行但要抽象"的项一次全做完；除插件外还要拆出配套 skills**。主控是 kimi，任务和代码执行全给你，你可以开多个子代理并发提速。

## 开工前必读（硬约束）

1. 先读 `agent-bridge/GUARDRAILS.md`（34 行）。四类守门（权限与状态机代码 / 数据库 schema / 部署与常驻进程 / 验收检查定义）**任何人不得自行修改**；本战役原则上完全不碰它们，若某处看似绕不开，**停下来在进度文件里写明，等主控请示用户**，不得自行其是。
2. **只读区**：dsh 主仓（你的 cwd，master）、papertableV1 的 `src/`、`frontend/`、现有 `skills/voice-comment-sieve/`——全部只读参考，一个字都不改。
3. **可写区**（全部产出落这里）：
   - 插件代码：`papertableV1/dsh-plugins/`（新建子目录，每个插件一个子目录）
   - skills：`papertableV1/skills/`（每个 skill 一个子目录）
   - 进度与报告：`papertableV1/agent-bridge/out/`
4. dsh 处于 pre-release 无兼容承诺：每个插件 README 必须声明适配的 dsh 版本/commit，package.json 里 pin 住。
5. 每个插件都要是**仓库外 bundle**形态（package.json 声明 `dsh.bundle` + `cordis.patch.yml`），参照报告的 A2/A3 节与 `examples/` 模板；不进 dsh 主仓。
6. 模型可见文本里**不得出现 Papertable 业务词汇**（押注/结账/语料/金子墓碑等），插件必须零业务耦合、参数化（报告 C 节"共性剥离清单"逐条遵守）。

## 工作流（5 条 WS，含依赖与建议并行策略）

**建议起跑**：WS1 + WS5 先行（WS1 验证整条打包链路，WS5 是纯文档无依赖）；WS1 的安装验证通过后，WS2/3/4 全面并发。子代理分工你自行决定。

### WS1：`dsh-guardrails` 插件（报告候选 7，最高优先）

- 单 waterfall listener：`tools/pre-execute` 匹配 config 里的受保护 glob → 返回 `{kind:'ask', reason}`（不要用 `ctx.tools.guard()`，人要能翻案放行）；headless 下 fail-closed 是特性。
- Config（zod）：`protected: [{glob, reason}]`，预置示例含"验收/CI/测试定义路径永 ask"这条招牌规则。
- fs 写类工具目标路径提取；bash 命令保守策略（命令文本命中受保护路径即 ask），README 如实声明边界（进程级围栏归 dsh sandbox 轴，不重复造）。
- 验收：装进测试 profile 后 ①写受保护路径触发人审 ②headless 无 answerer 自动拒 ③审计日志有记录 ④非受保护路径畅通。核心 ~200 行，测试齐备。

### WS2：MemOS 集成两件套（报告候选 6）

- **L1 零代码 overlay**：照抄 `dsh:examples/mcp-memory` 的三文件形态，产出 `memos.cordis.yml`（一行 `dsh-mcp-client` 接 memos-local 的 stdio 命令，命令做成 config 注释示例）+ 验证步骤 README。
- **L2 `dsh-memory-discipline` 插件**：`ctx.systemPrompt.section()` 注入记忆规矩；`agent/session-start` 自动调 hot-context 工具并 `agent.inject()`（落日志合规）；热上下文用 `ctx.systemPrompt.context()` 变化才追加（KV-cache 友好）。**参数化**：`{hotContextTool, routeTool, searchTool, policyText}` 全走 config，对任意记忆 MCP（mem0/zep/自建）通用。规矩文本可参考 MemOS 路由纪律（问主控要原文，或先看 `~/.kimi-code/AGENTS.md` 的 MANAGED MEMOS ROUTING 段）。

### WS3：`dsh-proposal-gate` 插件（报告候选 1，最重，无 UI 版）

- 工具（模型可见）：`submit_proposal` / `withdraw_proposal` / `list_proposals`，schema 保留报告认证的"最小提案包"：`payload / evidence{for,against,unknowns} / checks / risk / base_version / requested_action`。
- 提案对象存 dsh `storage/` 域（跨会话）；状态机照搬镇纸版（submitted→in_review/accepted/rejected/changes_requested/expired，changes_requested→submitted，accepted→applied→verified/rolled_back），非法迁移拒绝，每次迁移落审计事件（actor 分 ai/human/system）。
- **人审通道**：review/apply 做成 `ctx.commands` 人命令——模型侧根本没有对应工具，身份分权靠通道隔离（这正是补镇纸 HTTP 零鉴权真空的要害）；apply 前重算 base_version 比对（不等→stale 拒），执行动作逐条走 `ctx.approval`。
- lane/target_kind/动作词汇表全部 config 化，不得写死镇纸枚举。
- **不做 Web UI**（Conversation Node 渲染留到以后）；验收用命令行演示完整状态机走一遍 + stale 409 + fail-closed。

### WS4：`scheduled-prompt` 插件（报告候选 4）

- 形态：config 声明 `[{schedule, prompt, preset?}]`，到点起 headless 会话跑 prompt（参照 extension-cookbook 的常驻 cron 模式：timer→idle 时 `followup(source:{kind:'cron'})`、busy 时 `inject()`）。
- **必须继承 pw-miner 沉淀的后台任务纪律**（读 `pt:src/pw-miner.ts` 提取，不写业务）：每轮预算护栏（超限即 fail 并记 run）、幂等去重（日界/键控 `INSERT OR IGNORE` 思路）、run 记录含 provider/model/cost/raw_response。做成插件的通用骨架层。
- 验收：配一个"每分钟 hello-world"的 demo schedule，验证到点触发、busy 时 inject、预算超限 fail 三条路径。

### WS5：skills 拆解（纯文档，零代码，可与 WS1 并行起跑）

每个 skill 一个目录 + SKILL.md，放 `papertableV1/skills/`；写通用方法论，不含 Papertable 业务词汇（示例可以提及作为出处）：

1. **`agent-bridge-protocol`**：把文件桥协作协议成文化（编号简报 → 执行回报 → 独立验收 → herdr 投递），**顺手补上缺失的 `agent-bridge/PROTOCOL.md`**（报告勘误一：该文件不存在，协议散在简报里）。
2. **`batch-llm-sieve`**：从观众声音 pipeline 抽象——固定桶 + 批间逐字相同 prompt + 切批 map-reduce + 覆盖对账（无重无漏）+ 产出先落文件、导入时强制对账的入库门。
3. **`memory-usage-discipline`**：记忆工具使用规矩的纯文本版（与 WS2 插件的 policyText 同源，给不能用插件的 harness/产品用）。
4. **`evidence-recall-ledger`**（轻量）：报告候选 8 的两个模式——"AI 只许写 surfaced，其余状态只能人触发"的召回漏斗记账法 + "全量提供 ≤N 条 + 模型显式 `[[id]]` 标注引用 + 系统解析审计"复用契约，写成规矩文本（零代码）。

## 进度回报（你不主动找我，我走拉取通道）

- 在 `agent-bridge/out/dsh-plugins-progress.md` 维护进度：每个 WS 状态（未开始/进行中/已完成/被卡 + 一句话），每完成一个 WS 或遇到阻塞就更新。我会定时来读这个文件 + 读你的窗格。
- 全部完成后写总结报告 `agent-bridge/out/dsh-plugins-final-2026-08-14.md`：每个插件/skill 的位置、验收证据（命令+输出摘录）、已知边界、后续建议。

## 完成定义（主控验收清单）

- [ ] WS1-WS4 四个插件目录齐备，各自能 `dsh plugin --profile <test> add` 安装成功，行为验收如各 WS 所列
- [ ] WS5 四个 skill 目录 + `agent-bridge/PROTOCOL.md` 成文
- [ ] 守门红线零触碰；dsh 主仓与镇纸现有代码零改动（我会 `git status` 双侧核对）
- [ ] 进度文件与总结报告齐
