# 简报 30：微信 vs 飞书通道能力盘点（插件 / 技能 / 体验）

## 背景

dsh web 端微信通道（dsh-wechat 插件）已修通 cwd 问题（简报 29），但主控排查发现：

1. **微信端 agent 零 skill**：`papertableV1/skills/` 下有 5 个技能目录（agent-bridge-protocol、batch-llm-sieve、evidence-recall-ledger、memory-usage-discipline、voice-comment-sieve），但 web profile（`~/.dsh/profiles/web/`）无任何 skill 注册；web bundle（`deepseek-harness/packages/bundle/web-app/cordis.patch.yml:330` 附近）禁用了 host 层 `skill-filesystem`/`tool-skill`，技能发现交给 agent preset；微信 `/new` 旁路不过 apiproxy 的 `composeAgent()`，`dsh-wechat` 的 `agentPreset` 配置未设、且据称设了也只写 meta 不真正组合 preset。
2. **dsh-super-injector 疑似坏**：在 web profile bundles（`~/.dsh/profiles/web/package.json`）里，但 `node_modules/@dsh-external/dsh-super-injector/` 缺 `lib/index.js`，err 日志有 `ERR_MODULE_NOT_FOUND`（16:53）。进程活着，加载状态未查清。

## 调查问题

1. **微信通道到底能用什么**：
   - dsh-wechat 插件本身是否支持注入/挂载其他 dsh 插件能力（如 super-injector）？查 `papertableV1/dsh-plugins/dsh-wechat/` 源码与 `~/.dsh/profiles/web/cordis.patch.yml` 实际生效配置。
   - 微信 /new 建会话的完整链路里，agent 的 system prompt / persona / skills 是怎么组装的？要让微信 agent 加载 `papertableV1/skills/` 的技能，最小改动点在哪（配置 or 代码）？
   - dsh-super-injector 在 web profile 下到底是加载失败被跳过，还是半死不活？它本来该提供什么？
2. **飞书通道对比**：仓库里是否有 dsh-feishu（或类似）插件/通道？它的会话创建链路是否过 `composeAgent()` / preset，即技能、插件能力是否开箱即用？对比微信 vs 飞书：消息收发、/new 会话、skill 加载、定时任务联动、附件/图片，哪边能力全？
3. **结论要求**：回答主控两问——(a) 微信端"插件跟技能都不能用"是否属实、边界在哪；(b) 若要多通道使用，飞书是否当前体验最好的通道，依据是什么。

## 关键路径

- dsh 源码：`/Users/qinshu/Documents/ChatGPT/MemOS/deepseek-harness/`
- 微信插件源码：`/Users/qinshu/Documents/papertableV1/dsh-plugins/dsh-wechat/`
- web profile：`~/.dsh/profiles/web/`（cordis.patch.yml、package.json）
- web bundle patch：`deepseek-harness/packages/bundle/web-app/cordis.patch.yml`
- 技能目录：`/Users/qinshu/Documents/papertableV1/skills/`
- 日志：`/Users/qinshu/Library/Logs/dsh-web.log` 及同目录 err 日志

## 纪律

- **只读排查**，不改任何运行中进程、不改配置、不重启。
- 完工后把报告写到 `/Users/qinshu/Documents/papertableV1/agent-bridge/out/30-codex-通道能力盘点.md`，并在 w4:p1（主控 kimi 窗口）回报一句完工摘要（用 `~/.local/bin/herdr-cc-prompt w4:p1 "..."` 投递）。
