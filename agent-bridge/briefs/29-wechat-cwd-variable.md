# 简报 29：web 端微信会话报错 `{{cwd}} has no value` 排查

## 这刀是干什么的

微信里发 `/new xxx` 能创建会话（如 `wechat-msty0hzu-btdy12`），但 agent 一开工就报错：
`prompt variable "{{cwd}}" has no value for this assembly (section "deployment:persona")`。
普通消息和定时任务（scheduled-prompt → new-session agent → wx-outbox）也全部撞同一个错。
链路「微信 ↔ dsh-wechat 插件 ↔ dsh web」本身是通的，死在 system prompt 组装环节。

## 怎么算好

- 定位根因：为什么 web/wechat 创建的会话在组装 `deployment:persona` 时 `{{cwd}}` 没有值，而 TUI 会话正常。
- 给出最小修复方案（哪一层该供 cwd：会话创建时的 workspace 绑定？preset 模板？还是 wechat 插件建会话的参数），并说明改动点。
- 只排查和给方案，**不改正在运行的 web 进程、不重启任何服务**。

## 以下给干活的看，可以跳过

已核实的证据（kimi 主控已查）：

- 抛错点：`/Users/qinshu/Documents/ChatGPT/MemOS/deepseek-harness/packages/core/system-prompt/src/index.ts:289`，变量严格解析，无值即抛。
- `{{cwd}}` 出现在 persona 模板：`apps/cli/config/agent-presets/{cordis,standard,code}/agent.cordis.yml`（"Your working directory is {{cwd}}"）。
- wechat 插件：`/Users/qinshu/Documents/papertableV1/dsh-plugins/dsh-wechat/`（简报 28 的产出，protocol driver 形态）。
- web 自启动配置：`/Users/qinshu/主知识库_AI/80_AI暂存/dsh-web-autostart/`。

需要回答的问题：

1. `cwd` 这个 prompt 变量的值由谁供给？（找 system-prompt 变量解析的 provider 链）
2. web profile 创建会话时 workspace/cwd 在哪一步绑定？wechat 通道建会话（session id 形如 `wechat-*`）是否跳过了这步？
3. 为什么报错只在 wechat/web 会话出现——TUI 会话的 cwd 是从哪来的？
4. 最小修复点在哪一层，改什么。

## 分工

- **dsh-cc**：负责源码侧根因 + 修复方案（可改代码，但改完先别动运行中的 web 进程；改 dsh 仓库代码需遵守该仓库 AGENTS.md，非平凡改动带 Agent Note）。
- **codex**：独立排查（只读，不改代码），从配置/运行时角度复核，重点看 web 会话创建链路和 agent-preset 选择，给出自己的结论。

## 完工主动回报（必做）

完工后立刻执行：

```
herdr agent prompt w4:p1 "简报29 完工：一句话结论 + 产出路径 + 有无阻塞"
```

产出写 `/Users/qinshu/Documents/papertableV1/agent-bridge/out/29-<角色>-cwd排查.md`。
写完不回报等于没做完。
