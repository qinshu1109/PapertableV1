# 简报 31：dsh-cc 手机访问本机 web（隧道方案）执行报告

> 角色：dsh-cc 执行单
> 结论一句话：**dsh web 无鉴权，公网隧道一律禁止；本机也没装 Tailscale/cloudflared。两条可行私密路径（Tailscale 私网 / SSH 端口转发）都撞"系统级变更/重启 web"红线，已停在请示点等主控拍板，未落地任何隧道、未动运行进程。**

## 这刀是干什么的

用户想在手机浏览器里用上本机 dsh web 的完整体验（preset/skills），已拍板不部署服务器，走"本机 web + 隧道"。本报告回答三件事：web 现在监听在哪、有没有鉴权（没鉴权就不许暴露公网）、本机有什么隧道工具可用，以及两条可落地的私密方案各需要什么拍板。

## 怎么算好

- bind 地址、鉴权现状给出**明确答案**（实测 + 源码证据）。
- 隧道工具现状查清（未安装任何隧道工具）。
- 本地通道用真实 HTTP 验证（首页 / RPC / WebSocket 全通），隧道可行性前置条件实测（非 loopback Host 会被 /api 拒绝）。
- 遵守红线：未装软件、未重启 web、未改 profile、未起公网隧道；系统级变更停在请示点。

## 以下给干活的看，可以跳过

### 1. bind 地址（明确答案）

**`127.0.0.1:3080`（loopback），不是 0.0.0.0。**

- 实测：`lsof -iTCP:3080 -sTCP:LISTEN` → `node 55421 qinshu ... TCP localhost:3080 (LISTEN)`（stm_pproc 即 3080 的 services 名）。
- 进程：launchd `com.deepseek-harness.web`（`launchctl print gui/501/...` state=running，program `/Users/qinshu/.local/bin/dsh web`，工作目录 /Users/qinshu）。
- 配置：web bundle webserver 行 `host: !!js ctx.webStartup.host ?? '127.0.0.1'`，profile patch 无覆盖 → 默认 127.0.0.1。
- 源码硬限制：`packages/bundle/web-app/lib/startup.js`：`--host 0.0.0.0` 被显式拒绝（"intentionally not supported yet for safety: it would expose remote code execution to the network"）。**设计上就不允许直接绑全网卡。**

### 2. 鉴权现状（明确答案）

**无鉴权。没有 token、没有密码、没有登录机制。**

- `packages/host/webserver/src/index.ts`：纯 node:http 服务器，路由直接转发，全文无 auth/token/password 逻辑。
- `packages/host/apiproxy/src/fetch/handler.ts`：`/api/*` 直接进 RPC 路由，无鉴权中间件。
- 仅有的三道防线（都不是"登录"）：
  1. **bind loopback**（网络层，见上）。
  2. **`/api` trustedHosts DNS-rebinding fence**（`packages/client/connection/src/api-request-trust.ts`）：请求 Host 必须 loopback 或在 `--trusted-host` 列表里，否则 403。源码注释白纸黑字：**"this fence is not an auth layer"**（防 DNS rebinding / 跨站，不是鉴权）。
  3. **特权方法强制 loopback-only**（`packages/client/connection/src/index.ts` PRIVILEGED_METHODS：settings 读写、credentials 读写、agentPreset 管理、host 打开目录等），即使配了 trustedHosts，非 loopback 请求也 403。
- 实测（真实 HTTP）：
  - `GET /` loopback → 200（SPA 首页；静态页无 Host fence）
  - `POST /api/llm.models` loopback → 200 完整模型目录 JSON
  - 同请求伪装 `Host: 100.64.0.1:3080`（模拟隧道地址）→ **403 forbidden**（fence 生效）
  - `GET /api/events.host` loopback → **426 upgrade required**（实时通道强制 WebSocket）

**红线结论：无鉴权 → 任何公网隧道（含 cloudflared quick tunnel、命名隧道不配 Access）一律禁止落地。**

### 3. 隧道工具现状

- **tailscale：未安装**（PATH、/usr/local、/opt/homebrew、~/.local、/Applications 全查无）。
- **cloudflared：未安装**。
- Clash Verge 在跑（mihomo 内核 PID 1844，`-ext-ctl-unix /tmp/verge/...`）；实测 localhost 请求正常，未受 TUN 影响（简报要求的"用真实 HTTP 验证"已做）。
- sshd：未运行（`launchctl print system/com.openssh.sshd` 不存在，22 无监听）——SSH 转发路径需要先开"远程登录"。

### 4. 实时通道（隧道兼容性前置）

- 通道形态：**WebSocket**（`/api/events.mux`、`/api/events.host` 走 HTTP upgrade；GET 直接返回 426 `upgrade: websocket`）。WS downlink 为纯下行推送，空闲无帧是设计（源码注释），连接建立即通道可用。
- 实测：Node 全局 WebSocket 连 `ws://127.0.0.1:3080/api/events.host` → **upgrade 成功（open 触发）**。
- 隧道兼容性：Tailscale 是 L3 网络，WS 天然穿透；cloudflared quick tunnel 支持 WS，但被"无鉴权禁公网"红线排除。

### 5. 落地路径与硬约束（卡在请示点）

**任何隧道方案（Tailscale/cloudflared）访问 web 时，手机浏览器发出的 Host 是隧道地址（非 loopback）→ `/api` 一律 403 → UI 白屏。** 因此隧道要能用，必须先让 web 认识该地址：

- 需要给 web 进程加 `--trusted-host <精确地址>`（CLI 参数；**不支持通配符域名**，要列具体 host/IP；tailnet 域名如 `mac.tailXXXX.ts.net` 或 100.x IP 均可）→ 改 launchd 参数 = **重启 web 进程（红线）**。
- 或 profile 配置 trustedHosts → **改 profile（红线）**。
- 且 settings/credentials/agentPreset 管理等特权方法在隧道下仍 403（设计使然；核心对话/会话/模型目录不受影响）。

候选方案（按推荐序）：

| 方案 | 需要什么 | 撞红线点 | 手机访问方式 |
|---|---|---|---|
| **A. SSH 端口转发（最轻）** | Mac 开"远程登录"（sshd，系统设置，需用户批准）+ 手机装 SSH 客户端 App（Termius/Blink，用户态） | 开远程登录=系统级设置变更 | 手机 `ssh -L 3080:127.0.0.1:3080 <mac用户名>@<mac局域网IP>` 后浏览器开 `http://localhost:3080`。**Host=localhost → fence 全通过，连 settings/credentials 都能用**；加密私密、不走公网、不装系统软件、不重启 web |
| **B. Tailscale 私网（简报首选）** | `brew install --cask tailscale`（系统级 VPN 扩展）+ 用户 GUI 登录授权 + 手机装 Tailscale 进同一 tailnet；再加 web `--trusted-host <tailnet地址>` 并重启 web | 装系统级软件 + 重启 web | 手机开 Tailscale 后浏览器开 `http://<mac的tailnet域名>:3080`（/api 可用，settings/credentials 仍 403） |
| C. cloudflared 命名隧道 + Access | 装 cloudflared（用户态可装）、配 Cloudflare 账号 Access、加 trustedHosts + 重启 web | 公网暴露面 + 重启 web；Access 只是入口鉴权，dsh 自身仍无鉴权 | 不推荐，仅列档 |

**现状下未落地任何隧道**：A/B 都停在"需系统级变更/重启 web"的请示点，按简报红线停下等主控拍板。

### 6. 待主控/用户拍板

1. 选 **A（SSH 转发）** 还是 **B（Tailscale）**？
   - A 零新软件、零 web 改动、全功能，但要求 Mac 开远程登录（安全面是 Mac 账号密码/密钥）；
   - B 是简报首选私网方案，但要多装软件 + 重启 web 一次（`--trusted-host`），且特权方法仍受限。
2. 批准后我可以继续执行：A→确认远程登录开启方式/替代（或用户手动开）+ 手机侧指引；B→`brew install --cask tailscale`（用户需在 GUI 登录）+ 拟改的 launchd 参数（`dsh web --trusted-host <地址>`）报主控批准后由主控/用户重启。

## 本次变更

- 新增本报告；其余零改动（未装软件、未动 web 进程/profile/launchd、未起任何隧道）。
- 验证产物（均只读）：本地 curl 首页/RPC/WS 实测、Host 伪装 403 实测，见上文。
