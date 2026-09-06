# 简报 32：跨公网远程访问本机 dsh web 方案对比（只读调研）

## 背景

- 目标：手机在**几公里外（蜂窝网络/外网）**用浏览器访问本机（Mac mini，家庭 NAT 后，无公网 IP）的 dsh web（127.0.0.1:3080），拿到完整 preset/skills 体验。
- 简报 31 已实证（报告 `agent-bridge/out/31-dsh-cc-手机访问本机web.md`）：
  - dsh web **无鉴权**（无 token/密码/登录），仅 loopback bind + `/api` trustedHosts fence（非 loopback Host 403）。**任何公网可达方案必须自带鉴权层，否则禁止落地。**
  - 同 Wi-Fi 的 SSH 转发（方案 A）已被用户否掉：必须跨公网可用。
  - 本机未装 tailscale/cloudflared；Clash Verge 在跑（TUN/增强模式，会接管流量）。
  - 实时通道为 WebSocket（`/api/events.host`）。
- 用户另有一台 4G 内存云服务器，但跑着生产项目（Sub2API），**生产红线：禁止在生产机上构建/装重型服务**；只能跑极轻量中继。

## 调研任务（只读，不落地）

对比以下候选路线，给出推荐：

1. **Tailscale 私网**：Mac + 手机装 App，mesh 私网直连（NAT 穿透，打不通走 DERP 中继）。需 dsh web 加 `--trusted-host` 并重启一次。评估：鉴权模型（tailnet 即鉴权）、Clash TUN 共存冲突风险、免费额度、手机端体验。
2. **Cloudflare 命名隧道 + Access**：cloudflared 常驻 Mac，公网域名 + Cloudflare Access（邮箱 OTP/一次性 PIN）做鉴权层。评估：免费额度、WS 支持、无 App 纯浏览器体验、Clash 共存。
3. **自有服务器轻量中继**：
   - a. `ssh -R` 反向隧道：Mac 常驻 `ssh -R` 到服务器 loopback，手机用 SSH 客户端经服务器 `-L` 跳转。零新软件，但手机端要 SSH App 且链路双层。
   - b. frp / WireGuard 装服务器：评估 4G 内存+生产共存的风险（红线：不许影响生产，不允许构建，frp 只有单二进制可接受）。
4. **ZeroTier / 其他**：如有明显更优者可提，但不要铺开超过这 4 类。

## 对比维度（逐项给结论，不要泛泛）

- 鉴权是否满足"dsh web 无鉴权"的硬约束，怎么满足的
- 要不要重启 dsh web / 改 profile（重启会顺带加载 cwd 兜底修复，算加分不算阻碍）
- Clash TUN 共存风险（本机红线：网络问题先怀疑 Clash；Tailscale/Cloudflare 与 Clash 增强模式共存有已知坑的要写明规避法）
- 手机端体验：纯浏览器直达 vs 必须装 App
- 服务器方案对生产的影响面
- 长期维护成本与免费额度

## 产出

- 报告写 `/Users/qinshu/Documents/papertableV1/agent-bridge/out/32-codex-远程访问方案对比.md`，结尾给**唯一推荐 + 一句话理由 + 落地步骤清单**（供主控转 dsh-cc 执行）。
- 完工用 `herdr agent prompt w4:p1 "..."` 向主控回报一句摘要（注意：herdr-cc-prompt 只认 dsh-tui pane，w4:p1 是 kimi，要用 herdr agent prompt）。

## 纪律

只读调研，可联网查官方文档，不改本机任何配置、不装软件、不动服务器。
