# 简报 18：deepseek-harness 插件化可行性探索（探索任务，只读，不写代码）

- 发起方：kimi（herdr 工作区 w1:p1，用户的主代理）
- 执行方：Cursor Agent（Fable 5 300K Max，w1:pC）
- 日期：2026-08-14
- 性质：**可行性探索**，输出报告。对两个仓库都**只读**，不改任何代码、不安装依赖、不跑构建。

## 背景（你没有任何上下文，从这里读起）

1. **deepseek-harness** 刚开源发布，热度很高，自定义程度非常高。仓库就在你的 cwd：`/Users/qinshu/Documents/ChatGPT/MemOS/deepseek-harness`（master）。底层插件框架是 vendor 引入的 **Cordis**：插件即 Service（`inject` 声明依赖 + `apply(ctx)`），类型化事件（emit/waterfall/parallel/serial），注册可逆（`ctx.effect()` 返回 disposer）。入门看 `docs/cordis-primer.zh.md`，挂载点目录看 `docs/subsystems/` 与 `docs/cordis-api/`，教程在 `docs/cordis-tutorial/`，示例在 `examples/`（acp-agent、headless-agent、jsonrpc-agent、mcp-memory、web-cordis、web-schedule）。

2. **Papertable V1** 是用户的产品（纸桌=思考场 / 镇纸=决策层工作台），在 `/Users/qinshu/Documents/papertableV1`。后端是 Node 服务（镇纸，127.0.0.1:4317），前端在 `frontend/`。多 agent 协作走文件桥 `agent-bridge/`（briefs/ 派单、out/ 产出，协议见 `agent-bridge/PROTOCOL.md`）。

3. **关键历史**：Papertable 之前规划过"项目内置 harness"（自己做 agent 运行时），后来被毙掉了——理由是 harness 是长期调优过程，不如用成熟 agent 产品（codex / claude code）+ skills 通道。现在 deepseek-harness 开源且插件化程度高，用户想探索一个新思路：**不做自己的 harness，而是把 Papertable 里"能做成插件且有普适性"的部分，做成 deepseek-harness 的插件**。

## 任务

评估 Papertable 的下列候选能力，哪些适合抽成 deepseek-harness 插件、有普适性、以及怎么落地。

### 候选能力清单（都在 papertableV1 里有实现或设计）

1. **提案契约 / 人审闸门**：agent 只能提交"提案"（带证据、自检、风险、请求动作），状态机 submitted→in_review→accepted→applied→verified，review/apply 只能人触发，apply 带版本比对防 stale，全程审计。实现：`src/pw-proposals.ts`。
2. **agent-bridge 文件桥协议**：跨 agent、跨产品的派单/回报约定（briefs/out 目录 + 编号简报 + PROTOCOL.md）。
3. **模式条 / 对账条**：决策层顶部的"待你判断 N（押注草稿 x · 结账草案 y · 语料 z · 提案 w）"计数条，hover 出明细。实现：`src/pw-mode-bar.ts`。
4. **定时捞料**：后台定时任务从笔记库捞材料、生成概念卡（DeepSeek API 自动执行）。
5. **观众声音 pipeline**：B 站评论 → 筛子评测 → 点阵报告（`agent-bridge/out/voice-*.md`）。业务性强，但"外部数据→筛选→报告"的模式可能通用。
6. **MemOS 记忆集成**：agent 长期记忆的读写规矩（每回合必读必写、路由、热策略）。注意 harness 已有 `examples/mcp-memory`，要对比差异。
7. **GUARDRAILS 守门红线**：`agent-bridge/GUARDRAILS.md`，四类守门文件改动必须人点头，agent 自律 + 流程约束。
8. **证据缺口 / 召回契约**：最新的研究方向（当前工作反向召回库存证据），设计在 `agent-bridge/out/未命名.md` 相关的研究报告里，可能太早期，评估一下即可。

### 要回答的四个问题

- **A. 挂载点盘点**：Cordis/deepseek-harness 有哪些现成扩展点（tools、llm、agents、prompt 片段、adapter、provider、各类事件）？插件怎么打包、加载、配置（loader、overlay、disabled）？examples 里哪个最接近"把外部服务接进来"？
- **B. 候选×挂载点映射**：8 个候选各自适不适合做插件？适合的话挂在哪（新 service？事件监听？tool？prompt 注入？）？哪些需要动 harness 核心（=不适合）？
- **C. 普适性评估**：哪些对任意 harness 用户（不用 Papertable 的人）也有价值？要抽掉哪些 Papertable 耦合（镇纸后端依赖、业务词汇、文件路径）？
- **D. MVP 建议**：如果只做 1 个插件验证路线，选哪个？给出大概工作量、形态（独立包 / examples / overlay 配置）、分发方式。

## 方式

- 用户明确授权：**你可以开多个子代理并发探索**。建议分工：①cordis 文档+examples+subsystems 目录；②Papertable 侧实现（pw-proposals.ts、pw-mode-bar.ts、agent-bridge、捞料任务）；③汇总做映射与普适性分析。
- 两个仓库都**只读**。不要改代码、不要 git 操作、不要起服务。

## 产出

把报告写到：`/Users/qinshu/Documents/papertableV1/agent-bridge/out/dsh-plugin-feasibility-2026-08-14.md`

要求：中文；每个候选给出明确的 **可行 / 可行但要抽象 / 不可行** 判定；最后给 MVP 建议和工作量估计。写完后不用找我，我会定时来收报告。
