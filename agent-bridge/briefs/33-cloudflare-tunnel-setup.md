# 简报 33：Cloudflare 隧道落地——手机跨公网访问本机 dsh web

## 拍板与前提

用户已拍板走简报 32 推荐路线（Cloudflare 命名隧道 + Access 精确邮箱 OTP）。用户提供的参数：

- 域名：**cozai.net**（已托管 Cloudflare）
- 唯一允许登录邮箱：**zhouxiangrui1109@gmail.com**
- 建议 hostname：`dsh.cozai.net`（若被占用另选一个独立子域名，回报里注明）

调研依据与落地蓝本：`agent-bridge/out/32-codex-远程访问方案对比.md` 第 77–90 行的 10 步清单，本简报不重复，严格按它执行。

## 红线（比简报 32 更严，必须逐条遵守）

1. **cozai.net 是生产 Sub2API/CozAI 站在用的域名。** 只允许新增目标子域名（如 `dsh.cozai.net`）的 tunnel route；**禁止**修改/删除任何现有 DNS 记录、禁止碰根域与 `www`、禁止动 Cloudflare 上该 zone 的其他任何配置（SSL 模式、Page Rules、Workers 等一律不碰）。不登录、不操作 4G 生产服务器。
2. **先 Access 后发布**：Access 应用和"仅 Allow `zhouxiangrui1109@gmail.com` 精确邮箱 + One-time PIN"策略建好并验证后，才能把 hostname 挂上 tunnel。任何时刻都不许出现无鉴权可达窗口；Quick Tunnel 全程禁用。
3. origin 始终 `http://127.0.0.1:3080`，origin HTTP Host Header 设 `127.0.0.1:3080`；不改 dsh profile、不加 trusted-host、不重启 dsh web。连接协议固定 HTTP/2，最后一条 ingress 为 404。
4. **不动 dsh web 运行进程**；不装 system LaunchDaemon；常驻只用用户级 LaunchAgent，且必须在 canary 全过之后。
5. Clash 修复必须证据驱动：先固定 HTTP/2，仍失败才给 cloudflared 加最小 DIRECT 规则；不得关闭 Clash、不得扩大直连范围。
6. **需要用户本人操作的节点**（Cloudflare dashboard 登录授权、`cloudflared tunnel login` 的浏览器授权）——停下来，用 herdr 回报主控等用户操作，不得替用户找绕过方式。

## 执行顺序（对应报告 10 步）

1. 确认 hostname 可用；记录基线：本机 `127.0.0.1:3080` 首页/只读 RPC/`/api/events.host` WS、PID、launchd 参数、Clash 路由状态、确认 dsh 仍 loopback-only。
2. 建 Access Self-hosted Application：Allow 精确邮箱、Require One-time PIN、会话先 8 小时。
3. brew 安装 `cloudflared`（用户态）；`cloudflared tunnel login` 需要浏览器授权时停下来找用户。
4. 建命名隧道；hostname 指向 `http://127.0.0.1:3080`，配 `httpHostHeader: 127.0.0.1:3080`、`protocol: http2`、ingress 兜底 404。
5. **前台 canary**（不装常驻）：验证——未登录被 Access 拦截、错误邮箱被拒、正确邮箱 OTP 可进、首页/RPC/WS 全通、dsh 仍只监听 loopback。本机 curl 之外，请用户用手机蜂窝网络实测一轮。
6. 验证完整体验：preset/skills 加载、建会话、消息流、WS 重连、loopback-only 的管理 RPC；任何 403 记录在案，不许用扩大 trustedHosts 绕过。
7. canary 全过后装用户级 LaunchAgent，凭据文件限权限，开有限日志轮转。
8. 验收：Wi-Fi 与蜂窝各测一次（蜂窝请用户实测）；回滚步骤写进报告（停 LaunchAgent→删 hostname route→删 tunnel/凭据→删 Access app）。

## 产出

- 报告写 `/Users/qinshu/Documents/papertableV1/agent-bridge/out/33-dsh-cc-cloudflare隧道落地.md`：含实际用的 hostname、每步验证证据（curl 状态码/日志摘录）、最终手机访问方式一句话、回滚步骤。
- 完工用 `~/.local/bin/herdr-cc-prompt w4:p1 "..."` 回报主控一句摘要+最终访问地址；若 w4:p1 被拒（非 dsh-tui pane），改用 `herdr agent prompt w4:p1`。
- 中途任何需要用户操作的节点，先回报主控再等。
