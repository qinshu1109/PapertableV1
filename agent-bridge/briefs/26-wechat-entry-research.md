# 简报 26：微信入口打通调研（双窗口并行搜索，只调研不写代码）

- 主控：kimi（w1:p1）；执行：dsh-cc（w1:pH，角度 A）+ codex（w1:pJ，角度 B）
- 日期：2026-08-14
- 性质：技术调研，输出报告，不改任何代码。

## 用户需求（原话压缩）

让 deepseek-harness（dsh-cc）打通微信：微信是**常驻对话入口**（手机上随时跟 agent 说话），Mac 上跑完整的 dsh；后续的**定时任务结果也要推送到微信**。微信只是入口，不是运行地。

## 角度 A（dsh-cc）：dsh 生态侧

1. 搜 dsh 插件生态有没有现成的微信/Telegram/IM 接入插件：GitHub `dsh-plugin` topic、awesome-dsh-plugin / awesome-deepseek-harness 清单（已知有 `ben7am1n/dsh-telegram` Telegram runtime adapter——读它的架构，它怎么把 IM 消息接成 dsh 会话的，就是微信版的参照物）。
2. dsh 侧接入点到底长什么样：runtime adapter？channel 插件？外部进程桥（IM ↔ 本地 HTTP/stdio ↔ dsh profile）？把可行接入方式钉到具体扩展点（读 dsh 仓 docs/subsystems/ 与 packages/ 里相关座）。
3. 输出：`agent-bridge/out/26-wechat-search-dshcc.md`——现成插件清单（有/无、成熟度）、dsh 接入点分析、推荐接入形态。

## 角度 B（codex）：微信侧通道

1. macOS 上微信机器人/消息通道的现实选项逐个过：wechaty（各 puppet 现状）、gewechat、itchat（系）及其存活状态、企业微信 API（合规但场景不同）、公众号/客服消息、以及"发文件传输助手"类土办法。每个给出：维护状态、个号封号风险、收发能力（文本/图片/文件/主动推送）、macOS 可行性。
2. 重点回答：**主动推送**（定时任务结果发到微信）在各通道上是否可行、稳不稳。
3. 风险与合规底线要如实写（个号协议风险）。
4. 输出：`agent-bridge/out/26-wechat-search-codex.md`——通道对比表 + 推荐通道 + 理由。

## 共同要求

- 用 exa/WebSearch 等联网搜索拿 2026 年 8 月的现状，不凭旧印象（这个领域项目死伤快）。
- 中文报告；结论先行；给"如果今天就要 MVP"的最小路径。
- **完工必须主动回报**：写完报告立刻执行 `herdr agent prompt w1:p1 "简报26（你的角度）完工：一句话结论+产出路径+有无阻塞"` 把结果推回主控窗口；这是硬性条款，不是可选项。
