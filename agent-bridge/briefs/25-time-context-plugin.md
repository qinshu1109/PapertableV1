# 简报 25：dsh-time-context 插件（时间概念注入，dsh-cc 执行）

- 主控：kimi（w1:p1）；执行：dsh-cc（w1:pH）
- 日期：2026-08-14
- 背景：已为你装好现成的 `@deepseek-ai/dsh-tool-time`（工具型：模型可调时间计算工具）。本简报补另一半——**主动时间感知**：把当前时间注入模型上下文，不用模型想起来去查。

## 任务

在 `/Users/qinshu/Documents/papertableV1/dsh-plugins/` 下新建 `dsh-time-context/` 插件（仓库外 bundle 形态，同 dsh-guardrails 等五个既有插件的目录结构：package.json 带 dsh.bundle.patch + dshCompatibility pin commit 47f9438、cordis.patch.yml 默认层、README、tests）：

1. **runtime context 注入**：用 `ctx.systemPrompt.context()`（runtime context，变化才追加，KV-cache 友好——见 `dsh:docs/subsystems/system-prompt.md`）向模型注入当前本地时间，内容形如 `当前时间：2026-08-14 周五 08:15（Asia/Shanghai）`。刷新粒度做成 config（默认分钟级；时区可配，默认系统时区）。
2. **配套提示词节**：`ctx.systemPrompt.section()` 注入一条短规矩——"涉及'今天/昨天/到期/几天没动'等相对时间时，以注入的当前时间为准现算，禁止凭训练数据猜日期"。文本中文、零业务词汇。
3. **硬约束**：注册走 `ctx.effect()`/disposer 可逆；不动 dsh 主仓；单测覆盖（注入内容格式、粒度配置、时区配置）。
4. **验收**：keyless 路线（llm-mock-server 驱动真组合，环境事实见 `dsh-plugins/dsh-proposal-gate/README.md` 环境节）——证明模型请求里确实带着当前时间、且跨轮次时间戳会前进。写进 README 验收实录。

## 交付

- 插件目录 + 测试绿 + README（含安装/配置/边界/验收实录）。
- 装到 cc-tui profile：`dsh plugin --profile cc-tui add <目录>` 并 `--dump-config` 验证（web profile 不装，主控另行决定）。
- 完工写 `agent-bridge/out/25-time-context-done.md`（含 dump 证据与验收实录），不用找主控，会有人来收。
