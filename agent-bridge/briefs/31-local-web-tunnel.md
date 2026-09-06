# 简报 31：手机访问本机 dsh web 端（隧道方案）执行单

## 背景与拍板

主控已与用户拍板：**不部署服务器**（服务器 4G 内存且跑着生产项目），改走"本机 dsh web + 隧道"路线，让手机浏览器直接访问本机 web 端，获得完整 preset/skills 体验（绕开微信裸 agent 问题，见简报 30 报告 `agent-bridge/out/30-codex-通道能力盘点.md`）。

- 本机 dsh web：LaunchAgent `com.deepseek-harness.web` 管理，进程 PID 55421（`launchctl list` 可查），监听 3080。
- web profile：`~/.dsh/profiles/web/`。

## 任务

1. **摸现状（只读）**：
   - dsh web 实际 bind 地址（loopback 还是 0.0.0.0）：查 profile 配置与 `lsof -iTCP:3080 -sTCP:LISTEN`。
   - dsh web 的鉴权现状：有没有 token/密码/登录机制？查 `deepseek-harness` 源码里 web 服务/auth 相关实现与 profile 配置。这一项必须给出明确答案——带 Shell/文件权限的 agent 界面，无鉴权就不能走公网隧道。
   - 本机隧道工具现状：`which tailscale cloudflared`，tailscaled 是否在跑，有没有已登录的 tailnet；cloudflared 有没有已配置的 tunnel。
2. **选路并实施**（优先级从高到低）：
   - **Tailscale**：若已装已登录，直接 `tailscale serve` 或 funnel 之外的内网方式把 3080 暴露到 tailnet，手机装 Tailscale 即可访问。这是首选——私有网络，不公网暴露。
   - **cloudflared 命名隧道**：若已有 Cloudflare 账号配置，用命名隧道 + 必须配 Access/鉴权。
   - **cloudflared quick tunnel**（`cloudflared tunnel --url`）：仅限临时验证用，必须在报告里大字标注"公网无鉴权临时 URL，验证完即关"。
3. **验证**：隧道起来后，用 `curl` 经隧道地址访问 web 端首页与 `/health`（或等价端点），确认 200；确认 WebSocket/SSE 等实时通道在隧道下可用（dsh web 若有实时推送， quick tunnel/serve 对 WS 的支持要实测）。
4. **收尾**：给出"手机浏览器打开什么地址、要不要装 App、怎么关停隧道"的极简使用说明。

## 纪律红线

- **不动** dsh web 运行中进程，不重启 LaunchAgent，不改 web profile 配置（若确需改，先停下来回报主控）。
- **不装需要 sudo/系统级变更的软件**而不先请示；`brew install` 用户态安装可以自主做。
- 网络连通性问题先怀疑本机 Clash（TUN 会拦截所有 TCP），验证用真实 HTTP 请求，别信 `nc -z`。
- 若 dsh web 鉴权现状=无鉴权，则**禁止**落地任何公网隧道方案（含 quick tunnel 常驻），只走 Tailscale 私网或先回报主控。
- 完工报告写到 `/Users/qinshu/Documents/papertableV1/agent-bridge/out/31-dsh-cc-手机访问本机web.md`，并用 `~/.local/bin/herdr-cc-prompt w4:p1 "..."` 向主控回报一句完工摘要（含最终访问方式一句话）。
