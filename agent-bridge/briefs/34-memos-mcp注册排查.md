# 简报 34：MemOS MCP 工具在 dsh web 会话启动时不注册 — 彻查根因

> 派单：主控（Kimi）→ codex（w4:pB），只读彻查。修复实施后续派 dsh-cc。
> 用户原话：「MemOS 记忆每次都不能自动注册，我要彻底解决」。

## 背景（已实证的事实）

- 用户手机经 Cloudflare 隧道（dsh.cozai.net → 127.0.0.1:3080）访问 dsh web，新建会话后发消息，agent 自述：

  > 「本次会话的热记忆上下文没加载成功（**记忆工具未在启动时限内注册**）」
  > 「`mcp__memos__get_hot_context` 这个记忆工具在本次会话里压根没有注册到我的可用工具列表中」

- **每次新会话都复现**，不是偶发。本机 127.0.0.1:3080 直接开的会话是否同样复现，需顺带验证。
- MemOS Local 是本机常驻 HTTP MCP 服务（Python），Kimi Code / Codex / Claude Code 连同一服务**全部正常**——问题在 dsh 侧的接入/注册链路，不在 MemOS 服务本身。
- dsh 源码仓：`/Users/qinshu/Documents/ChatGPT/MemOS/deepseek-harness`（简报 33 的 fence 排查也是这个仓，`packages/client/connection/src/api-request-trust.ts`）。
- dsh web 由 launchd 常驻（当前 PID 98140，plist 已加 `--trusted-host dsh.cozai.net`）。

## 彻查任务（只读，不改代码、不重启进程）

1. **注册流程与启动时限**：dsh 源码里 MCP server 连接与工具注册的完整链路。「启动时限」在哪个文件、哪个常量/配置定义，默认多少毫秒；超时后的行为是什么（放弃并继续开会话？有无重试？有无 late registration 把后到的工具补进会话？）。
2. **memos MCP 在 dsh 的配置**：dsh web 用的是哪个 profile 配置（`~/.dsh/profiles/web/` 一带），memos MCP 条目是 HTTP 直连还是 stdio spawn，地址/命令/超时字段各是什么。和其他正常客户端（如 Kimi Code 的 MCP 配置）对比接入方式差异。
3. **耗时实测**：MemOS 服务当前的冷/热响应耗时（health 接口、`initialize` 握手、`tools/list` 各花多少时间），对照 dsh 的启动时限，确认是「服务慢」还是「dsh 时限太短/串行注册被其他 server 拖累」。
4. **失败日志**：dsh web 运行日志（launchd stdout/stderr 或 `~/.dsh/` 下日志）里 memos MCP 注册失败/超时的原始报错，逐条引用。
5. **根因结论 + 修复建议分级**：
   - A 级：配置层可调（加大超时、改连接方式、调整注册顺序）——优先；
   - B 级：必须改源码（如加 late registration/重试）——给出最小改动点文件:行号。
   - 修复实施会派给 dsh-cc，你的报告要能直接当施工单用。

## 约束

- 只读排查：不改任何代码、不重启 dsh web（隧道和手机用户在线）、不碰生产服务器。
- 网络异常先怀疑 Clash（本机 Clash TUN，代理 127.0.0.1:7897）。

## 产出

报告写到 `/Users/qinshu/Documents/papertableV1/agent-bridge/out/34-codex-memos注册排查.md`，结尾附：根因一句话、修复方案 A/B、有无阻塞。完工后向主控回报简报 34 完成。
