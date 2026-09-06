# 简报 34 施工单：MemOS MCP 注册修复（派 dsh-cc / w4:p9）

> 依据：codex 排查报告 `/Users/qinshu/Documents/papertableV1/agent-bridge/out/34-codex-memos注册排查.md`（先通读）。
> 主控拍板的施工范围如下，超出范围不做。

## 施工范围

1. **先诊断当前进程**：查 `~/Library/Logs/dsh-web.err.log` 自 2026-08-16 02:18:37（当前 dsh web PID 98140 启动）以来有无新的 loader / plugin tree 错误——确认 P0（super-injector 缺失整树失败）此刻是否仍在发生，还是只剩 P1（4.5s 等待竞态）。结论写进报告。
2. **A 级 · preflight + 原子启动**：写一个 preflight 脚本——解析 `~/.dsh/profiles/web/cordis.patch.yml` 中所有本地 loader 入口，逐个验证文件存在且可 import；把 `~/Library/LaunchAgents/com.deepseek-harness.web.plist` 包成 wrapper：preflight 失败则拒绝启动并留下单一明确错误。plist 改动先备份（`.bak-34-<时间戳>`），用 bootout/bootstrap 重载（kickstart 不重读 plist）。
3. **临时缓解**：`cordis.patch.yml` 把 memory-discipline 的 `toolWaitAttempts` 从 10 调到 20（等待窗口 4.5s→约 10s）。
4. **B1 · late-registration**：`/Users/qinshu/Documents/papertableV1/dsh-plugins/dsh-memory-discipline/` 增加晚注册补拉——等待超时后不放弃，继续监听工具表，`mcp__memos__get_hot_context` 出现后在同一 session 补拉一次热记忆注入；必须带 session/disposal guard 防重复注入。改完跑该插件测试。
5. **验收**：重启 dsh web 后新建会话，实证工具表含 4 个 `mcp__memos__*`（get_hot_context / route_memory / search_memories / add_memory）且热记忆成功注入；stderr 无 loader error。

## 明确不做

- B2（把 MCP readiness 变成新会话阻塞前置）——语义风险，不做。
- B3（改 dsh 核心仓 dsh-mcp-client 加 timeout/结构化日志）——留主控拍板。
- 不碰生产服务器、不动 Clash。

## 已知影响（主控已确认可接受）

重启 dsh web 会让手机隧道用户短暂断连；微信插件 activeSessionId 内存态重置（磁盘会话可 cold resume，简报 33 已验证过同类重启）。

## 产出

报告写 `/Users/qinshu/Documents/papertableV1/agent-bridge/out/34-dsh-cc-memos修复.md`，结尾附：P0 是否仍在发生的诊断结论、改动清单、验收证据、有无阻塞。完工向主控回报。
