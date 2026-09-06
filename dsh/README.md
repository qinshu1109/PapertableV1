# DeepSeek Harness (DSH) × PapertableV1 联动集成架构

本项目目录归档了本地与 **PapertableV1（思考场与决策层工作台）** 紧密结合改造的 **DeepSeek Harness (DSH)** 运行时配置、预设（Presets）、运行脚本（Scripts）、常驻服务编排（LaunchAgents）及远程隧道路由（Cloudflare Tunnel）。

---

## 1. 架构总览与核心设计原则

PapertableV1 采用 **"不自研 Agent Harness，将普适能力与工作台能力做成 DSH 扩展"** 的架构路线：

```
                ┌────────────────────────────────────────────────────────┐
                │          公网移动端 / 桌面端 (dsh.cozai.net)           │
                └───────────────────────────┬────────────────────────────┘
                                            │ Cloudflare Tunnel
                     ┌──────────────────────┴──────────────────────┐
                     │ 路径分流 Ingress                            │
                     ▼ /n/*                                        ▼ /* (OTP 认证)
      ┌──────────────────────────────┐              ┌──────────────────────────────┐
      │  Papertable 决策层 (Port 4317)│              │    DSH Web 宿主 (Port 3080)  │
      │  - 押注台/金碑/语料/观众声音 │              │  - DSH Web App               │
      │  - 状态机与权限边界真值源   │              │  - 左栏独立「镇纸」工作台     │
      │  - 短时能力令牌免密处置      │              │  - Flash 深度锚定预设        │
      └──────────────┬───────────────┘              └──────────────┬───────────────┘
                     │                                             │
                     │                 HTTP API 同源桥接            │
                     └─────────────────────────────────────────────┘
                                (/pw/api/* 代理直连 127.0.0.1:4317)
```

### 铁律与设计纪律

1. **上游 DSH 源码零改动**：
   - 上游 DeepSeek Harness 官方代码库保持 100% 干净，所有定制化通过外挂 Bundle、Cordis Patch、独立 Presets 与运行时脚本承载。
2. **数据真值源唯一**：
   - 业务数据只走 `http://127.0.0.1:4317` HTTP API，DSH 侧绝不建立第二份 SQLite 数据副本或镜像缓存。
3. **写路径严格受限**：
   - AI 唯一起草工具 `pw_draft_bet` 只能落草稿库（带 `draft_hash`）；
   - 人在 DSH 界面点击的"挑/改/否/确认"按钮直接打向 4317，`decided_by=human` 由后端强约束；
   - 严禁向模型暴露任何 `settle` / `confirm` / `verdict` 等正式结账工具 schema。
4. **AI 摆证据不给结论**：
   - 界面卡面与生成文本永不出"推荐"字样，排序与召回依据全透明印在卡上供人复核。

---

## 2. 目录结构说明

```
dsh/
├── README.md                           # 本架构与操作说明文档
├── config/                             # DSH 全局配置
│   ├── settings.production.yaml        # 生产环境运行配置 (OpenCode Zen / Flash 锚定)
│   ├── settings.full.yaml              # 包含 Qwen-Local MTP 与 Zen 的多 Provider 配置
│   └── settings.yaml                   # 默认干净配置模板 (无敏感密钥)
├── presets/                            # DSH 智能体预设 (Agent Presets)
│   ├── pw-paperweight/                 # 镇纸专属 Flash 锚定预设 (Companion 身份 + 店规注入)
│   │   ├── preset.yml                  # 预设元数据 (显示名: 镇纸 Paperweight)
│   │   ├── agent.cordis.yml            # Cordis Agent-plane 组合
│   │   ├── anchored-bootstrap.mjs      # 首轮 Minimal 工具对与 Token 预算锚定
│   │   └── dev-tool-search.mjs         # 按需工具解锁机制
│   └── router-flash/                   # Router Flash 官方标准锚定预设
│       ├── preset.yml
│       ├── agent.cordis.yml
│       ├── anchored-bootstrap.mjs
│       └── dev-tool-search.mjs
├── profiles/                           # DSH 运行时 Profile 编排
│   ├── web/                            # 生产运行使用的 Web Profile
│   │   ├── package.json                # 依赖声明 (挂载 @papertable/dsh-paperweight 等)
│   │   ├── cordis.patch.yml            # Loader Patch 层 (启用 host-level skill-filesystem)
│   │   ├── cordis.yml                  # Profile 根入口
│   │   └── pnpm-workspace.yaml         # Hoisted 依赖布局配置
│   └── full-plugins/                   # 包含全部 9 个插件的完整 Profiles 模版
│       ├── package.json
│       ├── cordis.patch.yml            # 注入 Memos MCP、Guardrails、微信入口
│       ├── cordis.yml
│       └── pnpm-workspace.yaml
├── scripts/                            # 启动、预检与 Sidecar 脚本
│   ├── run-web.sh                      # Web 启动入口 (环境变量隔离 + trusted-host)
│   ├── dsh-web-preflight.mjs           # 启动前只读预检 (验证所有 Loader Entry 与入口文件)
│   ├── dsh-web-run.sh                  # 原子启动 Wrapper (Preflight 失败立刻拒绝启动)
│   ├── zen-effort-sidecar.mjs          # DeepSeek 官方 Anthropic 思考强度代理 (Port 8790)
│   ├── wx-outbox.mjs                   # 微信 Outbox 推送账本 CLI
│   └── fake-sender.mjs                 # Outbox 模拟发送器 (测试用)
├── services/                           # 守护进程编排
│   ├── com.deepseek-harness.web.plist  # macOS LaunchAgent 守护配置
│   └── setup-launchagent.sh            # LaunchAgent 安装/启停/日志便捷脚本
└── tunnel/                             # 远程访问与隧道穿透
    ├── run-dsh-cozai.sh                # 隧道启动脚本 (去除代理变量干扰)
    ├── com.cloudflared.dsh-cozai.plist.template # Cloudflare Tunnel LaunchAgent 模板
    └── ingress-routing.md              # 域名 Ingress 与 /n/* 免密处置路由规范
```

---

## 3. 关联的核心插件集 (`papertableV1/dsh-plugins/`)

本仓库根目录下的 `dsh-plugins/` 包含了与 DSH 配合使用的 9 个独立 Bundle 插件：

| 插件目录 | 包名 | 功能描述 |
|---|---|---|
| `dsh-paperweight` | `@papertable/dsh-paperweight` | **镇纸工作台核心插件**：在 DSH 左栏注册独立工作台 Tab，呈现押注台、金碑库、观众声音、运维状态、大盘笔记与通知推送；注册 8 个只读数据工具与 1 个起草工具 `pw_draft_bet`；支持 `@押注卡` 聊天装配。 |
| `dsh-guardrails` | `dsh-guardrails` | 守门红线防护：拦截对 CI、测试定义、环境凭据与 `GUARDRAILS.md` 的修改。 |
| `dsh-memory-discipline` | `dsh-memory-discipline` | 长期记忆使用纪律：与 MemOS MCP 规范对接，KV-Cache 友好的热上下文注入。 |
| `dsh-proposal-gate` | `dsh-proposal-gate` | 提案契约闸门：无 UI 版提案状态机（submitted→accepted→applied），防 stale 并经人审。 |
| `dsh-routing-suite` | `dsh-routing-suite` | 模型路由基准与探针测试套件。 |
| `dsh-scheduled-prompt` | `dsh-scheduled-prompt` | 常驻 Cron 任务触发器，带每轮预算护栏与幂等去重。 |
| `dsh-time-context` | `dsh-time-context` | 动态真实时钟上下文注入，解决大模型时空感错位。 |
| `dsh-wechat` | `dsh-wechat` | 微信 iLink 接入网关，支持双向审批与会话转发。 |
| `memos-mcp-overlay` | `memos-mcp-overlay` | MemOS Local MCP stdio/streamable-http 零代码挂载层。 |

---

## 4. 关键技术突破

### 4.1 Zen Effort Sidecar (`zen-effort-sidecar.mjs`)
- **痛点**：DeepSeek 官方的思考强度控制参数为 `output_config: { effort: "max" }`（Anthropic 格式），而通用适配器仅支持 `budget_tokens` 或 clamp 到 `high`，实测导致推理深度下降 5.4 倍。
- **方案**：在 `127.0.0.1:8790` 建立轻量级零依赖 Sidecar，将 outbound JSON 的 `thinking` 字段替换为官方 `output_config: { effort: "max" }`，SSE 流式原样回传，完全释放 DeepSeek V4 Flash 的长链推理能力。

### 4.2 镇纸 Flash 锚定预设 (`pw-paperweight`)
- 继承官方 Minimal 预设的首轮严格约束：首轮只暴露持久 `bash` + `str_replace_editor` 工具对与 256,000 Token 预算，剥离外部注入干扰，牢牢锚定深度 `We need…` 推理轨迹。
- 剥离通用编程助理的刻板身份，注入 Paperweight 工作台协作者人设，并放行 `papertable:workbench-guide` 与 `papertable:write-boundary` 等店规片段。

### 4.3 启动前预检 (`dsh-web-preflight.mjs`)
- 防止加载损坏插件或缺少入口文件引发 LaunchAgent 的死循环拉起（Crashloop），在每次 `dsh web` 启动前遍历 `cordis.patch.yml` 与 `package.json` 中的所有 bundles/patch entries，确保模块存在且可解析。

---

## 5. 本地运行与部署步骤

### 1) 启动 Papertable 4317 引擎
```bash
cd /Users/qinshu/Documents/papertableV1
npm run build
npm start # 监听 127.0.0.1:4317
```

### 2) 配置环境变量与 Sidecar
在 `~/.dsh-zen.env` 或系统环境中提供模型凭证：
```bash
export OPENCODE_ZEN_API_KEY="your-api-key"
node dsh/scripts/zen-effort-sidecar.mjs &
```

### 3) 安装并启动 LaunchAgent 守护进程
```bash
./dsh/services/setup-launchagent.sh install
./dsh/services/setup-launchagent.sh start
./dsh/services/setup-launchagent.sh status
```

### 4) 启动远程访问隧道 (可选)
```bash
export DSH_COZAI_TOKEN="your-cloudflare-tunnel-token"
./dsh/tunnel/run-dsh-cozai.sh
```
访问 `https://dsh.cozai.net`，左侧侧边栏即可出现浅色纸感设计的「镇纸」六屏工作台。
