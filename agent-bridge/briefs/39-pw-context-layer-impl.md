# 简报 39：镇纸 AI 上下文层实现 + 镇纸专用 preset（用户已拍板路线 3）

## 已拍板的前提（不要再研究，直接按此施工）

- 用户在 2026-08-17 拍板：**定制一个镇纸专用 preset，现有 router-flash（complete persona）一个字不动**。
- 内容定稿：`agent-bridge/out/38a-context-content-design.md`（导览全文 §1.2、notice 模板 §2、验收 A1–A8/B1–B4）
- 通道核验：`agent-bridge/out/38b-dsh-capability-check.md`（systemPrompt.section 语义 §1、session-start/inject 签名 §2、重装处方 §4、风险清单 §5）
- 执行方变更（用户明令 2026-08-17，第二次）：**施工 + 验收都由你（Codex 窗口）独立完成**。此前曾短暂派给 Claude（w4:p9），已叫停。**注意：Claude 留了半成品**——已新增 `src/host/guide.ts`、`notice-format.ts`、`notice.ts`，并在 `pw-client.ts` 增补了 `fetchVerdictRows`（瘦身判决列表）；但 `index.ts` 未挂上新段和 session-start、测试未改、preset 未 fork、未构建安装重启。router-flash 原件未动。你的第一步是**审阅这批半成品**：符合 38a/38b 设计的就接手继续用，不符合的就改写或还原，不要假装从零开始。改动范围原始记录在 `agent-bridge/out/39-impl-progress.md`。

## 施工内容（三件事）

### 1. dsh-paperweight 插件加「上下文层」（`papertableV1/dsh-plugins/dsh-paperweight/`）

- 新增常量 `PW_GUIDE_TEXT`，内容= 38a §1.2 从 `## 镇纸工作台导览` 到文末的**整段原文**，一字不改。注册 `ctx.systemPrompt.section({name:'papertable:workbench-guide', order:110, text:PW_GUIDE_TEXT})`，与现有 write-boundary（order 120）并列，现有段不动。
- 新增 session-start 动态 notice，照 `dsh-memory-discipline/index.js:300-317` 样板：监听 `agent/session-start` → **同步栈内** `agent.runMaintenance(task)` → task 内拉数 → `agent.inject(createUserMessage({..., source:{kind:'plugin', plugin:'dsh-paperweight', form:'notice', summary}}))`。
  - 数据清单、字段、截断、cue 优先级、降级文本：严格照 38a §2.2–§2.5。总超时 `AbortSignal.timeout(4000)`。
  - **禁止**复用 `fetchVerdicts()` 取近金近碑（它会每行再 fetchBet 补标题，`pw-client.ts:248-259`）；按 38a §2.2 第 4 行用瘦身版。
  - 未读推送走 `PushStore.list()`（插件本地 feed），不要打 4317 要未读数。
  - 任何失败 → 38a §2.5 降级 notice，不抛、不闩死首轮。
- 因路线 3 用专用 preset（无 complete persona），导览和店规走 system 段生效；notice 只承担「今日快照」，**不需要**把导览全文塞进 notice（38a §6 方案 1 的拼接不采用）。
- 扩展 `test/host.test.ts`：覆盖新 section 注册（name/order/text 逐字节）、notice 成功/降级/部分失败/截断路径、不超时的预算断言。现有冒烟测试模式（假 4317 + 假 ctx）沿用。

### 2. 新建镇纸专用 preset（fork router-flash，不动原件）

- 位置：`/Users/qinshu/.dsh-source/.agent-presets/` 下新建目录（建议名 `pw-paperweight`，显示名用「镇纸 Paperweight」之类中文名）。
- 做法：整体复制 `router-flash/` 内容 → 改 persona 配置（`agent.cordis.yml` 里 `complete: true` 改为 false / 去掉 complete，让普通 sections 进入 request.system）；其余（首轮工具过滤、晋升逻辑等）保持原样。
- 改前先备份原目录到 `/Users/qinshu/.dsh-source/preset-backups/`（带日期后缀）。
- 若复制后发现 persona 文本本身假设了 complete 语义（比如「你是唯一系统提示」之类措辞），在产出文档里指出，不要顺手改写 persona 文本。

### 3. 构建、安装、重启、自检

照 38b §4 处方：

```bash
cd /Users/qinshu/Documents/papertableV1/dsh-plugins/dsh-paperweight
/Users/qinshu/.local/node/bin/pnpm run build
cd /Users/qinshu/Documents/ChatGPT/MemOS/deepseek-harness
DSH_HOME=/Users/qinshu/.dsh-source /Users/qinshu/.local/node/bin/pnpm dsh plugin --profile web add link:/Users/qinshu/Documents/papertableV1/dsh-plugins/dsh-paperweight
DSH_HOME=/Users/qinshu/.dsh-source /Users/qinshu/.local/node/bin/pnpm dsh --profile web --dump-config | rg -n 'dsh-paperweight'
launchctl kickstart -k gui/501/com.deepseek-harness.web
```

重启后自检（38b §4.1）：launchctl print 状态、curl 3080、`tail ~/Library/Logs/dsh-web.err.log | rg 'dsh-paperweight|plugin tree failed'`。

## 约束

- **不改 router-flash 的任何文件**；不碰 dsh-paperweight 的 client 前端（六屏已上线，保留）；不动 4317 服务端。
- 镇纸 web 服务只重启 dsh（com.deepseek-harness.web），4317 不归你重启。
- 真会话验收（新开 web 会话选新 preset、跑 A1–A8/B1–B4）**也由你做**：装好后开 dsh web 会话（用你 fork 出的 pw-paperweight preset），逐条对 38a §4 的 A1–A8 / B1–B4 打钩，结果写进 `out/39-impl-progress.md`。

## 产出

- 代码：插件改动 + 新 preset 目录
- 施工记录：`agent-bridge/out/39-impl-progress.md`（做了什么、改了哪些文件、自检输出、preset 复制时发现的问题）

## 完工回报（必须）

完工或卡住超 20 分钟，立刻执行：
`herdr agent prompt w4:p1 "简报39 完工/阻塞：一句话结论 + 产出路径 + 有无阻塞"`
