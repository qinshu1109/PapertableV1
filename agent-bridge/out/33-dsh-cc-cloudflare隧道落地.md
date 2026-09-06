# 简报 33：dsh-cc Cloudflare 隧道落地报告（收尾版）

> 角色：dsh-cc 执行；依据简报 33 拍板 + 蓝本 32（10 步清单）+ 全流程实测。
> 状态：**已完成并常驻化**。手机经 `https://dsh.cozai.net` 访问本机 dsh web，Cloudflare Access 精确邮箱 OTP 保护，用户已在手机会话里跑过多轮（实测可用）。

## 结论一句话

本机 dsh web（loopback:3080）经 Cloudflare 命名隧道 `dsh-cozai` 发布到 `https://dsh.cozai.net`，Access 仅放行 `zhouxiangrui1109@gmail.com` + One-time PIN；按"方案一"配置层修复使非特权 RPC 经隧道可用、特权方法（目录选择/设置/凭据）保持 loopback-only；隧道已转用户级 LaunchAgent `com.cloudflared.dsh-cozai` 常驻（无代理环境）。

## 最终访问方式（一句话）

手机浏览器打开 **https://dsh.cozai.net** → Cloudflare Access 登录（输入 `zhouxiangrui1109@gmail.com` → 邮箱收 6 位 OTP）→ 进入 dsh web；无需装 App；目录选择等管理功能仍限本机（预期）。

## 全流程记录

### 1. 现状摸底（只读）

- dsh web：PID（随重启变化，现 21116）loopback 监听 `127.0.0.1:3080`；launchd `com.deepseek-harness.web`（`dsh web`）；`--host 0.0.0.0` 被源码显式禁止（防 RCE）。
- **鉴权现状：无 token/密码/登录**。仅 loopback bind + `/api` trustedHosts DNS-rebinding fence（源码明示"不是鉴权"）+ 特权方法 loopback-only → 公网隧道必须靠 Access 兜鉴权，quick tunnel 全程禁用。
- 本机无 tailscale/cloudflared；Clash Verge 在跑（mihomo TUN）。
- `dsh.cozai.net`：DoH 实测 NXDOMAIN（可用）；cozai.net 托管 Cloudflare（cris/molly NS）。

### 2. Clash 排障链（证据驱动）

1. `dig` 全被 Clash fake-ip 劫持（连 @8.8.8.8 都回 198.18.0.x）→ 用 DoH 确认真实 DNS。
2. cloudflared tunnel login 回调 4 连败 → 逐步定位：
   - fake-ip 池覆盖 `*.argotunnel.com` / `*.cloudflareaccess.org`（region1=198.18.0.24、login=198.18.0.17 等实测）→ 用户加 fake-ip-filter（`*.argotunnel.com`、`+.cloudflareaccess.com`）→ region1/region2 真实 IP（198.41.192.x）。
   - login 回调域 `.org` 漏配 → 补 `+.cloudflareaccess.org` → login=198.41.215.x。
   - 仍 RST → **真因：Go cloudflared 读本机代理环境变量**（`http_proxy/https_proxy/all_proxy=127.0.0.1:7897`，NO_PROXY 不含 CF 域）→ 回调被劫持到 Clash 代理端口。`env -u` 清除后重跑，仍因带 token 路径在边缘被断（curl 对照：根路径 404 通、token 路径超时）→ **CLI login 5 连败，主控拍板弃 CLI 走 dashboard 远程隧道**。
3. 隧道运行端点 `region1/2.v2.argotunnel.com` 曾 TLS 失败（代理/规则），fake-ip-filter + DIRECT 修复后 TCP/QUIC 均通（canary 预检全 PASS，UDP 也 PASS）。

### 3. dashboard 远程隧道 + Access（codex/用户协作）

- codex 建命名隧道 `dsh-cozai`；Public Hostname `dsh.cozai.net → http://127.0.0.1:3080`（初始 httpHostHeader=127.0.0.1:3080）；ingress 兜底 http_status:404（config 实测确认）。
- 用户建 Access Self-hosted 应用：域 `dsh.cozai.net`，Allow 精确邮箱 `zhouxiangrui1109@gmail.com` + Require One-time PIN。
- 前台 canary：4 路边缘连接注册、`curl https://dsh.cozai.net/` 未登录 → **HTTP/2 302 跳 `qinshu1109.cloudflareaccess.com` Access 登录页**（www-authenticate: Cloudflare-Access）；手机蜂窝过 OTP 后进入 dsh web，WS 实时通道（events.mux/events.host/plugins/events）实测到达 origin。

### 4. 栅栏问题与方案一（trustedHosts + 清 Host Header）

- 现象：手机点文件夹报 `transport failure for /api/host.pickDirectory: HTTP 403`。
- 根因（源码复核）：403 来自 **Origin fence**（`api-request-trust.ts:116-122`：Origin.host 必须 === Host.host），非 Host fence；初始 httpHostHeader=127.0.0.1:3080 让 Host 变 loopback（Host fence 过），但浏览器 `Origin: https://dsh.cozai.net` ≠ Host → 拒。`trustedHosts` 只进 Host fence，**对 Origin fence 无效**；且 `host.pickDirectory` 在 PRIVILEGED_METHODS（`index.ts:108`）强制 loopback-only，trustedHosts 无条件无效。
- **主控拍板方案一（只改配置不改源码）**：
  1. launchd plist 加 `--trusted-host dsh.cozai.net`（备份 `.bak-33-20260816021734`；`bootout+bootstrap` 重载——kickstart 不重读 plist 已踩坑）。
  2. codex 撤掉 dashboard 的 HTTP Host Header（config version=2，`httpHostHeader: ""`）→ Host 原样透传 `dsh.cozai.net`。
- **四象限复验**（curl 本地构造头，全过）：

| 请求 | 预期 | 实测 |
|---|---|---|
| `POST /api/session.list` Host+Origin=`dsh.cozai.net` | 200（非特权通） | **200** ✅ |
| `POST /api/host.pickDirectory` Host+Origin=`dsh.cozai.net` | 403（特权 loopback-only） | **403** ✅ |
| loopback session.list | 200 | **200** ✅ |
| 经公网未登录 `GET /` / `POST /api/*` | 302 Access 拦截 | **302** ✅ |

- 手机重测：**用户在手机会话里跑过多轮，非特权 RPC 全通**；目录选择等特权方法 403 属拍板的分级限制（记录在案，不扩大 trustedHosts 绕过）。

### 5. 常驻化（LaunchAgent，无代理环境）

- 停前台 canary（双实例会抢连接）→ 确认进程清空。
- 安装 `~/Library/LaunchAgents/com.cloudflared.dsh-cozai.plist`（600）：`/bin/sh ~/.cloudflared/run-dsh-cozai.sh`，wrapper 内 `env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u no_proxy -u NO_PROXY` 后 `exec cloudflared tunnel run --token <token>`（token 经 plist EnvironmentVariables 注入，仅 DSH_COZAI_TOKEN）。
- `launchctl bootstrap` → state running（PID 28230），KeepAlive 崩溃自拉起。
- 验证：预检全 PASS（DNS/QUIC/HTTP2/API）、**4 路 Registered tunnel connection**、`curl -I https://dsh.cozai.net/` → **HTTP/2 302 跳 Access**；dsh web（PID 21116）仍 loopback 未动。

### 6. 当前架构

```text
手机浏览器 --https--> Cloudflare 边缘（Access: 邮箱+OTP）--> 命名隧道 dsh-cozai
   --> cloudflared (LaunchAgent, 无代理, 4 路 QUIC/HTTP2) --> http://127.0.0.1:3080 (dsh web)
```
- Host 原样透传 `dsh.cozai.net`；dsh 侧 `--trusted-host dsh.cozai.net`；特权方法（pickDirectory/openPath/settings/credentials/agentPreset 管理）loopback-only。
- 安全边界：公网入口=Access 精确邮箱+OTP；dsh 自身仍无鉴权（trustedHosts 是 fence 非鉴权）——**Access 是唯一公网闸门**，勿删。

## 回滚步骤（按序）

1. 停隧道：`launchctl bootout gui/$(id -u)/com.cloudflared.dsh-cozai && rm ~/Library/LaunchAgents/com.cloudflared.dsh-cozai.plist`
2. dashboard：删 Public Hostname `dsh.cozai.net`（或整隧道 `dsh-cozai`/凭据）。
3. 删 Access 应用（Zero Trust → Access → Applications → dsh.cozai.net）。
4. dsh 侧恢复（如不再需要远程）：launchd plist 去掉 `--trusted-host dsh.cozai.net`（备份 `.bak-33-20260816021734` 可还原）并 bootout/bootstrap。
5. dsh web 全程 loopback，无需其他回滚。

## 变更清单

- 新增：`~/Library/LaunchAgents/com.cloudflared.dsh-cozai.plist`（600）、`~/.cloudflared/run-dsh-cozai.sh`（700）、`~/.cloudflared/com.cloudflared.dsh-cozai.plist.template`。
- 修改：`~/Library/LaunchAgents/com.deepseek-harness.web.plist`（加 `--trusted-host dsh.cozai.net`，备份 `.bak-33-20260816021734`）。
- 用户/codex 侧：Cloudflare dashboard 隧道 `dsh-cozai`、Public Hostname（无 Host Header）、Access 应用（邮箱+OTP）。
- 本机：cloudflared 2026.8.2 装至 `~/.local/bin`；Clash fake-ip-filter/DIRECT（用户维护，未动 Clash 配置本体——仅用户按证据加规则）。
- 未动：dsh web 进程逻辑、profile 配置、生产服务器；无公网无鉴权暴露窗口（先 Access 后发布，全程无 quick tunnel）。

## 阻塞

无。遗留观察：特权方法（目录选择/设置/凭据）经隧道 403 为拍板的分级限制；若未来需要远程管理，需另行评估（改源码 fence 或 VPN 方案），本次不动。
