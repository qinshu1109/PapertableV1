# 简报 27：OpenClaw 官方渠道深挖（codex 执行，只调研）

- 主控：kimi（w1:p1）；执行：codex（w1:pJ）
- 日期：2026-08-14
- 起因：用户指出"官方有 OpenClaw 的个人号扫码接入接口支持个人号"，要求调研这条**微信官方渠道**路线。这可能推翻简报 26 角度 B"个号全出局"的结论，必须查实。
- 前置：读 `agent-bridge/out/26-wechat-search-dshcc.md`（角度 A，含 OpenClaw 借道路线）与 `26-wechat-search-codex.md`（角度 B）。

## 要查实的问题（按重要序）

1. **OpenClaw 是谁的**：`@tencent-weixin/openclaw-weixin` 这个 npm scope / GitHub 组织到底属不属于腾讯微信官方？找官网、官方文档、官方 GitHub、腾讯公告等硬证据（不是"看起来像"）。
2. **个人号扫码接入的性质**：OpenClaw 的微信通道（iLink，`ilinkai.weixin.qq.com`——注意这是 weixin.qq.com 官方子域）扫码登录个人微信号，是不是腾讯**官方支持**的能力？有没有明示的服务条款/文档依据？还是仍是逆向/灰色（官方域名 ≠ 官方授权）？
3. **能力边界**：收发消息类型、**主动推送**（定时任务结果推到个人微信）、在线稳定性、单号单轮询限制、会不会封号（有没有官方背书）。
4. **dsh 接入形态**：若 OpenClaw 官方为真——`BeAChanger/dsh-openclaw-acp`（ACP 中介）vs `gnulife/dsh-plugin-wechat`（HTTP 桥）vs 自写 protocol driver 直连 OpenClaw/iLink，哪条最短最稳。
5. **路线对比**：OpenClaw 个人号线 vs 企业微信自建应用线，各自的用户体验（个人微信里直接聊 vs 企业微信应用）与成本，给个明确取舍建议。

## 要求

- 全部用 2026-08-14 当日联网证据（exa/WebSearch/gh/curl 官方站点），每条结论标来源 URL；腾讯官方域名上的文档优先级最高。
- 明确区分三档：官方支持 / 官方默许 / 逆向灰色。
- 输出 `agent-bridge/out/27-openclaw-official-research.md`，中文，结论先行。
- **完工必须立刻** `herdr agent prompt w1:p1 "简报27 完工：一句话结论+产出路径+有无阻塞"` 推回主控（硬性条款）。
