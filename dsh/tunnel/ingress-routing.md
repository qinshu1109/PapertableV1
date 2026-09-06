# DeepSeek Harness (DSH) 远程访问与隧道路由架构

本文档记录与 PapertableV1 绑定的 DeepSeek Harness 远程访问（`dsh.cozai.net`）与通知处置路由规则。

---

## 1. 核心架构与域名分流

在生产环境中，用户通过公网域名 `https://dsh.cozai.net` 访问本机运行的 DeepSeek Harness Web 界面。同时，系统需要在手机闭屏或收到通知时，允许无密码直达押注处置/确认页面。

为此采用了 **Cloudflare Tunnel + Cloudflare Access 路径级分流**：

```
                              [用户公网请求]
                                     │
                                     ▼
                     Cloudflare Edge (dsh.cozai.net)
                                     │
           ┌─────────────────────────┴─────────────────────────┐
           │ 路径匹配                                          │ 路径匹配
           ▼ /n/* (带短时能力令牌)                            ▼ /* (DSH 根工作台)
    [Cloudflare Access: Bypass]                         [Cloudflare Access: 邮件 OTP 守门]
           │                                                   │
           └─────────────────────────┬─────────────────────────┘
                                     │ (同一条 cloudflared 隧道)
                                     ▼
                     [Mac 本机 cloudflared tunnel]
                                     │
           ┌─────────────────────────┴─────────────────────────┐
           ▼                                                   ▼
  http://127.0.0.1:4317/n/*                           http://127.0.0.1:3080/*
   (PapertableV1 镇纸服务)                             (DeepSeek Harness Web)
```

---

## 2. Cloudflare Tunnel Ingress 规则

在 Cloudflare Zero Trust 控制台针对 `dsh-cozai` 隧道的 Ingress 规则配置：

| 优先级 | 路径 (Path) | Service URL | 作用 |
|---|---|---|---|
| 1 (先匹配) | `dsh.cozai.net/n/*` | `http://127.0.0.1:4317` | 押注处置深链，直通 Papertable 4317 引擎 |
| 2 (兜底) | `dsh.cozai.net/*` | `http://127.0.0.1:3080` | DSH Web 工作台根入口 |

> **关键约束**：更具体的路径 `/n/*` 必须排在通配路径 `/*` 之前，否则会被 DSH 抢占。

---

## 3. Cloudflare Access 权限策略

在 Cloudflare Access Applications 中配置两层策略：

1. **`dsh.cozai.net/*` 根应用**：
   - 策略：Require Email OTP（仅允许预设邮箱接收一次性验证码登录）。
   - 保护完整的 DSH 工作台、会话历史、模型调用和侧边栏镇纸面板。

2. **`dsh-disposition` 专用应用 (`dsh.cozai.net/n/*`)**：
   - 策略：**Bypass**（免登录放行）。
   - 安全依据：通知中携带的 `/n/<token>` 为短时单次或限时能力令牌（Capability Token），由 Papertable 4317 后端通过密码学签名验证，无需在移动端弹出邮件验证码。

---

## 4. 本地启动脚本说明

`dsh/tunnel/run-dsh-cozai.sh` 包含了本机代理隔离逻辑：
- Go 编写的 `cloudflared` 会自动读取系统环境变量中的 `http_proxy` / `https_proxy` / `all_proxy`。
- 若本机运行了 Clash / TUN 本地代理（如 7897 端口），可能会拦截 Cloudflare 隧道的底层 TLS 握手。
- 启动脚本强制使用 `env -u ...` 清除全部代理变量，确保隧道直连 Cloudflare 边缘节点。
