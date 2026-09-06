# 简报 32：跨公网远程访问本机 dsh web 方案对比

> 调研日期：2026-08-15  
> 范围：只读调研；未安装软件、未修改本机配置、未重启 dsh web、未连接或修改生产服务器。  
> 前提：dsh web 仅监听 `127.0.0.1:3080`，自身无鉴权；`trustedHosts` 只是 DNS-rebinding fence，不是鉴权层；实时通道使用 WebSocket。

## 结论先行

**唯一推荐：Cloudflare 命名隧道 + Cloudflare Access（精确邮箱 OTP）。**

一句话理由：它是四类方案中唯一同时做到**手机纯浏览器直达、入口有独立身份验证、WebSocket 官方支持、不占用生产服务器、且不与 Clash 争抢系统 VPN 接口**的路线。

安全边界必须同时满足：

1. 只用**命名隧道**，不使用无 Access 的 Quick Tunnel。
2. 先创建 Access 自托管应用和“仅精确邮箱”Allow 策略，再发布 Tunnel hostname，避免无鉴权暴露窗口。
3. Tunnel origin 始终为 `http://127.0.0.1:3080`，不改变 dsh loopback bind。
4. 将 Cloudflare Tunnel 的 origin `HTTP Host Header` 设为 `127.0.0.1:3080`，让 dsh 看到 loopback Host；无需改 profile、无需加 `--trusted-host`、无需为隧道重启 dsh。

## 六维总表

| 方案 | 鉴权是否满足硬约束 | dsh 重启 / profile | Clash TUN 共存 | 手机端体验 | 对生产服务器影响 | 维护与免费额度 | 结论 |
|---|---|---|---|---|---|---|---|
| **Tailscale 私网** | **满足**。登录身份 + 已批准 tailnet 设备 + ACL 构成网络层授权，链路端到端加密；应只允许手机访问 Mac 的 3080/TCP | **需要重启一次**。手机以 `100.x` 或 MagicDNS Host 访问，须给 dsh 加精确 `--trusted-host`；无需改 profile。简报 31 已证实非 loopback 的特权 RPC 仍会 403 | **中高风险**。Tailscale 与 Clash TUN 都建立虚拟网络接口并改路由/DNS；常见失败是 100.64/10 被 Clash 接管、默认路由或 DNS 优先级互抢。规避：不启用 exit node；Clash 对 `100.64.0.0/10` 直连/排除；再检查 `route get`，必要时让 Tailscale 控制域名与 DERP 直连 | Mac、手机均须装 App；手机先开 Tailscale，再开浏览器。不是纯浏览器 | **零影响**，不经过自有服务器；直连失败走 Tailscale DERP | 个人版当前 $0，最多 6 用户、用户设备不限、50 个 tagged resources；维护量低到中，主要是客户端登录、升级和 Clash 回归 | **次选**。安全且私密，但 App 和双 TUN 冲突正好撞本机现状 |
| **Cloudflare Tunnel + Access** | **满足，且边界最清楚**。Access 在到达 origin 前按身份拦截；OTP 必须只 Allow 用户的精确邮箱，不能只写“登录方式=OTP”，否则任何有效邮箱都可能进入 | **不需要**。用 origin `httpHostHeader: 127.0.0.1:3080` 通过 dsh Host fence；不改 profile。若主控另想顺带加载 cwd 兜底修复，可另行批准一次 dsh 重启，但不是隧道前置条件 | **低到中风险**。`cloudflared` 是普通出站进程，不创建第二个本机 VPN 接口。Clash 仍可能代理/阻断其外连；先固定 `protocol: http2` 避开 QUIC/UDP，再仅在实测失败时给 `cloudflared` 进程或 Cloudflare Tunnel 端点加 DIRECT，禁止先大改 Clash | **最佳**。手机无需 App，蜂窝网络直接打开 HTTPS 域名，首次用邮箱 PIN 登录，后续按 Access session 复用 | **零影响**。隧道守护进程只跑在 Mac；不登录、不安装、不改动 4G 生产服务器 | Tunnel 可用于所有计划；Cloudflare Zero Trust Free 面向 50 用户以内。维护量中：域名、Access 策略、Tunnel token、`cloudflared` launchd 和日志 | **唯一推荐**。完整覆盖需求，生产隔离最好 |
| **服务器 `ssh -R` + 手机 `ssh -L`** | **满足，但依赖正确拓扑**。Mac 反向端口必须只绑定服务器 `127.0.0.1`；手机再用独立 SSH 密钥登录并本地转发。两段 SSH 鉴权后，浏览器访问手机 `localhost`，dsh 不暴露公网 | **不需要**。最终 Host 为 `localhost`，dsh fence 与 loopback-only RPC 均可保持原样；不改 profile | **低风险**。只有普通 SSH 出站；该服务器 IP 的 Clash DIRECT 路由此前已实证可用。需 `ServerAliveInterval`/自动重连防蜂窝切换和长连接断线 | 必须装支持本地端口转发和后台保活的 SSH App；先保持 SSH 会话，再用浏览器。链路最绕，iOS/Android 后台可能杀会话 | **低但非零**。不装新服务、不开放反向端口公网，只增加两个 sshd 会话、少量带宽和日志；仍把个人入口可用性与生产机绑定 | 软件成本为零；密钥、保活、端口占用、手机后台限制和服务器故障均要自己维护 | **可用的应急备选，不推荐长期使用** |
| **frp / WireGuard 经生产服务器** | **frp 默认不满足**：frpc↔frps token 只认证隧道客户端，不认证浏览器用户；若公网发布 web，至少还要 TLS + HTTP Basic Auth 或额外身份代理。WireGuard 的设备密钥可满足网络层鉴权 | frp 可重写 Host 为 loopback，理论上不重启 dsh；WireGuard 直接以虚拟 IP 访问则仍要 `--trusted-host` + 重启 | frpc 是普通出站，风险低；WireGuard 又增加一个 TUN/路由面，风险中高 | frp + Basic Auth 可浏览器直达但体验和安全均弱于 Access；WireGuard 手机必须装 App | **frp：中等影响面**，虽是单二进制，仍新增常驻进程、监听端口、防火墙、证书、日志和升级。**WireGuard：高影响面**，会改生产机网络栈、转发和防火墙，违反红线 | frp/WireGuard 软件免费，但全部运维、安全更新、证书和故障责任自担 | **排除**。frp 没有优势足以补偿生产耦合；WireGuard 不应进入生产机 |
| **ZeroTier 私网** | **满足**。私有网络必须由控制台逐设备授权，流量端到端加密；建议只授权 Mac 与手机 | **需要重启一次**。以 ZeroTier 虚拟 IP 为 Host，须加入精确 `--trusted-host`；无需改 profile；非 loopback 特权 RPC 仍受限 | **中高风险**。与 Tailscale 同类：ZeroTier 和 Clash TUN 同时改虚拟接口、路由；需为 ZeroTier managed subnet 做 Clash DIRECT/route-exclude，并避免下发默认路由 | Mac、手机均装 App、加入 Network、人工授权设备，然后浏览器访问虚拟 IP | **零影响**；通常点对点，打洞失败使用 ZeroTier 免费但较慢的 relay | Central 免费用于个人/小团队，当前最多 25 台设备；维护量中，设备授权和虚拟网段管理比本需求所需更重 | **不选**。没有比 Tailscale 更适合本场景的优势 |

## 逐项判断与关键证据

### 1. Tailscale 私网

- **鉴权**：tailnet 不是“知道 IP 就能进”；设备先通过身份提供方登录并加入 tailnet，再由 ACL 决定谁能访问哪个设备/端口。最小策略应只放行“用户手机 → Mac:3080/TCP”，不能沿用宽松默认策略。Tailscale 官方同时说明 tailnet 连接端到端加密，并提供 ACL 与设备批准能力。
- **dsh 改动**：这里不能把 Tailscale 当 HTTP 反向代理。浏览器会把 `100.x:3080` 或 MagicDNS 名称作为 Host 发给 dsh，因此必须加精确 trusted host 并重启。这个 fence 解决 Host 校验，真正的鉴权仍由 tailnet 承担。
- **Clash**：两者都有 TUN/虚拟接口，冲突风险明显高于 Cloudflare。落地时先做只读路由基线，再只增加最窄的 `100.64.0.0/10` 直连/排除；不得关闭 Clash 验证，也不得把 Tailscale 配成 exit node。
- **体验与额度**：安全、低维护，但手机必须常驻 Tailscale App。官方当前 Personal 为免费永久、最多 6 用户、用户设备不限，足够本场景。

### 2. Cloudflare 命名隧道 + Access

- **鉴权**：Cloudflare 官方的“Private web application”路径就是把 Access 放在自托管 Web 应用前，浏览器用 OTP 或 IdP 登录后才转发到 origin。OTP 策略必须 Include **单个精确邮箱**；Cloudflare 文档明确警告，只限制登录方式而不限制邮箱会放行所有能用 OTP 的邮箱。
- **dsh 改动**：Cloudflare `httpHostHeader` 能设置发往本地服务的 HTTP Host。设为 `127.0.0.1:3080` 后，dsh 继续只监听 loopback，也不需要信任公网域名。该结论需在落地时用真实 RPC 和 WebSocket 验证；若当前 dsh 版本对 WebSocket upgrade 未应用 Host override，才退回“加精确 public hostname + 重启”，不预先改 profile。
- **WebSocket**：Cloudflare Tunnel 官方 FAQ 明确写明完整支持 WebSocket；`/api/events.host` 属于标准 HTTP Upgrade，同域 Access cookie 会随浏览器会话参与入口授权。
- **Clash**：Tunnel 只从 Mac 向 Cloudflare 建立出站连接，不开入站端口。为减少 Clash TUN 对 UDP/QUIC 的不确定性，首版固定 HTTP/2；若仍失败，再针对 `cloudflared` 做最小 DIRECT 规则，并用日志证明是 Clash 后才改。
- **维护与额度**：macOS 官方支持把 `cloudflared` 安装为登录启动的 LaunchAgent 或开机启动的 LaunchDaemon。本机单用户入口选择 LaunchAgent 即可，权限面更小。Cloudflare Tunnel 可用于所有计划；Zero Trust Free 当前面向 50 用户以内，远超本需求。

### 3. 自有服务器轻量中继

#### 3a. `ssh -R` 可行，但只适合应急

安全拓扑必须是：

```text
Mac dsh:127.0.0.1:3080
  <- Mac 常驻 ssh -R 127.0.0.1:43080:127.0.0.1:3080
生产服务器:127.0.0.1:43080
  <- 手机 SSH App -L 3080:127.0.0.1:43080
手机浏览器:http://127.0.0.1:3080
```

- 服务器反向端口严禁绑定 `0.0.0.0`，也不需要改 `GatewayPorts` 或开防火墙端口。
- Mac 和手机使用两把独立 SSH 密钥；禁用密码、限制 key 权限。若要用 `autossh` 会新增本机软件，不是“零新软件”；首版可用 launchd + OpenSSH `ServerAliveInterval`，但仍需处理断线重连。
- 它不安装服务器组件，但长期占用生产机 sshd、带宽和日志，并把个人入口与生产服务器故障域绑在一起。用户已明确生产红线，因此仅保留为 Cloudflare 故障时的短期应急路线。

#### 3b. frp / WireGuard 排除

- frp 的 token/OIDC 默认认证的是 **frpc 到 frps**，不是手机浏览器用户。要公开 Web 服务还要补 TLS 和用户鉴权；frp 虽支持 Web 服务 Basic Auth，但仍要管理证书、密码、防爆破、监听端口、日志与升级。
- frps 虽可用发行版单二进制、不需构建，但仍会新增生产常驻进程和公网攻击面。既然 Cloudflare 能完全绕开生产机，frp 没有必要。
- WireGuard 会触碰生产机网络接口、IP forwarding、防火墙和路由。即使资源占用很小，爆炸半径也不符合“禁止影响生产”，直接排除。

### 4. ZeroTier

- 私有 Network 要逐设备 Authorize；网络 ID 本身不是访问凭据。官方说明流量端到端加密，通常 P2P，无法直连时可用免费但较慢的 relay。
- 免费额度为跨所有网络最多 25 台设备，当前足够。
- 它同样要求手机 App、Mac 网络扩展、dsh trusted host 和一次重启，也同样与 Clash TUN 争路由；在本需求中没有比 Tailscale 更低的实施或维护成本，因此不进入推荐序列。

## 唯一推荐的落地步骤清单

供主控转 dsh-cc 执行；以下步骤需要用户批准后才能实际安装和改 Cloudflare 配置。

1. **确认前提**：选一个独立、未占用的 Cloudflare hostname；确认唯一允许登录的精确邮箱。不得复用生产应用 hostname，不接触 4G 生产服务器。
2. **记录基线**：保存当前 `127.0.0.1:3080` 首页、一个只读 RPC、`/api/events.host` WebSocket、dsh PID/launchd 参数和 Clash 路由状态。确认 dsh 仍只绑定 loopback。
3. **先建 Access，后建 Tunnel**：在 Zero Trust 创建 Self-hosted Application；策略只 Allow 该精确邮箱，认证方法 Require One-time PIN；短会话先取 8 小时。用错误邮箱验证不会获得访问权限。
4. **创建命名隧道**：在 Mac 安装官方 `cloudflared` 发行包；创建 named tunnel。不要用 Quick Tunnel，不在服务器安装任何东西。
5. **配置 origin**：hostname 指向 `http://127.0.0.1:3080`；origin HTTP Host Header 设为 `127.0.0.1:3080`；连接协议首版固定 HTTP/2；最后一条 ingress 为 404。
6. **前台 canary**：先以前台方式启动，不装常驻服务；在蜂窝网络验证未登录被 Access 拦截、错误邮箱被拒、正确 OTP 可进入、首页/RPC/WebSocket 均正常，且 dsh 仍只监听 `127.0.0.1`。
7. **验证完整体验**：实测 preset/skills 加载、创建会话、消息流与 WebSocket 重连。特别验证原本 loopback-only 的 settings/credentials/preset 管理 RPC；若任何一项失败，记录具体 403，不通过扩大 trustedHosts 绕过鉴权。
8. **再做常驻**：canary 全过后才安装用户级 LaunchAgent；限制凭据文件权限，开启有限日志轮转。不要装 system LaunchDaemon，除非明确需要用户未登录时也启动。
9. **Clash 只做证据驱动修复**：若 Tunnel 不稳，先看 `cloudflared` 日志和当前路由；先固定 HTTP/2，仍失败才给 `cloudflared` 进程/Cloudflare Tunnel 端点加最小 DIRECT。不得关闭 Clash，不得扩大整段公网直连。
10. **验收与回滚**：从 Wi-Fi 和蜂窝各测一次；重启 Mac 后复测。回滚顺序为停 LaunchAgent、删除 hostname route、删除 tunnel/credentials、删除 Access app；dsh 全程保持 loopback，无需回滚 profile。

## 资料来源

- 本地实证：[简报 31 报告](./31-dsh-cc-手机访问本机web.md)
- Tailscale：[Pricing](https://tailscale.com/pricing)、[Secure the network](https://tailscale.com/kb/1429/secure)
- Cloudflare：[Tunnel WebSocket FAQ](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/)、[Private web application](https://developers.cloudflare.com/cloudflare-one/setup/secure-private-apps/private-web-app/)、[One-time PIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)、[Origin `httpHostHeader`](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/)、[macOS service](https://developers.cloudflare.com/tunnel/advanced/local-management/as-a-service/macos/)、[Zero Trust pricing](https://www.cloudflare.com/plans/zero-trust-services/)
- frp：[官方仓库与配置说明](https://github.com/fatedier/frp)
- ZeroTier：[Create a Network / free limit](https://docs.zerotier.com/start/)、[Protocol / encryption and relay](https://docs.zerotier.com/protocol/)

> 额度与产品规则均按 2026-08-15 官方页面核对；落地当天应再次确认。
