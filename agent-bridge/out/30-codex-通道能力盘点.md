# 简报 30：微信 vs 飞书通道能力盘点

> 排查时间：2026-08-15（Asia/Shanghai）  
> 方式：只读源码、生效配置、运行进程、本地 API 与日志；未改配置，未重启进程。

## 执行摘要

1. **微信端“插件和技能都不能用”不完全属实。** `/new` 当前直接创建裸 agent，没有执行 preset mount，因此拿不到 preset 层的 Shell、文件工具、persona、`skill-filesystem` 和 `tool-skill`；但 host/global 层已注册的插件工具仍可被裸 agent 继承，不能笼统说“插件全不可用”。
2. **`dsh-super-injector` 在当前 web profile 是完整加载状态。** 运行进程启动晚于修复后的 `lib/index.js`，host API 返回 200，boot manifest 含 client bundle。`entries: []` 只表示当前没有运行时注入项，不是插件加载失败。
3. **仓库里没有一条完整的飞书 DSH agent 通道。** 现有 `pw-feishu-relay.ts` 仅接收飞书 P2P 文本、写入 Memos 并回复“已记”；它不创建 agent，不经 `composeAgent()` / preset，也没有 `/new`、skills、agent 工具、审批或定时任务联动。所以“飞书是当前体验最全的多通道入口”没有代码依据。

## 1. 微信通道：真实会话链路与能力边界

### 1.1 `/new` 创建的是裸 agent

`dsh-wechat/src/node/core.ts:115-132` 的 `createSession()` 直接调用：

```ts
this.ctx.agents.create({
  sessionId,
  meta,
  agentOptions: { /* provider / model */ },
})
```

`agentPreset` 若有配置，仅被写入 `meta.agentPreset`；创建参数没有 `setup`，也没有调用 `agentPresets.mount()`。因此它旁路了 API Proxy 的标准 `composeAgent()` 链路。

标准实现在 `deepseek-harness/packages/host/apiproxy/src/api-proxy.ts:1227-1247`：先 resolve preset，再在 `setup` 中 mount。`packages/preset/agent-presets/src/index.ts:154-173` 也明确把未 mount preset 的 agent 视为 bare agent。

### 1.2 “插件”要按注册层级区分

| 能力层 | 微信裸 agent 当前状态 | 边界 |
|---|---|---|
| host/global 工具 | 可继承 | 例如 `dsh-super-injector` 的 `dev_*` 工具在 global tools 层注册，不依赖 preset mount |
| preset 层工具 | 不可用 | 微信建会话没有 mount preset |
| persona / system prompt 组合 | 缺失 preset 部分 | 只有 agent factory 的底层默认，不会获得 standard preset 组合的 persona |
| skills | 当前不可用 | `skill-filesystem` / `tool-skill` 由 preset 提供，微信未 mount |
| host 守护插件 | 插件本身可运行，不等于 agent 命令 | `dsh-scheduled-prompt` 是 host 级调度器；当前 `jobs: []`，无任务可触发 |

结论：问题不是“微信插件无法挂其他插件”，而是**微信创建 agent 时没有执行 preset 组装**。

### 1.3 微信消息形态边界

- 支持：私聊文本；微信网关已给出的语音转写文本。
- 不支持：群聊，`inbound.ts:67-69` 直接忽略。
- 不支持：纯图片/纯附件，`inbound.ts:72-75` 直接忽略 media-only 消息。
- 当前网关虽有 CDN 下载/解密基础，但尚未接入 agent；双向图片/文件仍在 README v0.2 roadmap。

## 2. 让微信 agent 加载 `papertableV1/skills` 的最小改动点

这需要两层最小改动，只改其中一层不够。

### 2.1 先让微信建会话真正 mount preset

1. 在 `dsh-wechat/src/index.ts:51` 和 `src/node/index.ts:60` 的注入声明中增加 `agentPresets`。
2. 在 `createSession()` 的 `agents.create()` 参数中增加：

```ts
setup: async agentCtx => {
  await this.ctx.agentPresets.mount(agentCtx, this.config.agentPreset)
}
```

完整且仍然最小的做法是复用 `composeAgent()` 的现有模式：先 `resolve()` 得到真实 preset ID，将它写入 meta，然后在 `setup` 中 mount。当前 web profile 的默认 preset 是 `standard`，不是旧调查里的 `router-standard`；微信配置未显式设置 `agentPreset`。

### 2.2 再让 skill-filesystem 看到项目顶层 `skills/`

`packages/skill/skill-filesystem/src/index.ts:241-260` 的默认扫描根只有：

- `<project>/.dsh/skills`
- `<project>/.agents/skills`
- `~/.dsh/skills`
- `~/.agents/skills`
- bundled skill root

`/Users/qinshu/Documents/papertableV1/skills/` 是项目顶层目录，不在默认根中。因此即使挂上 `standard` preset，也不会自动发现这 5 个 skill。

可选的最小方案：

- 不移目录：在 standard/personal preset 的 `skill-filesystem` 配置中增加 `customSkillDirs: [/Users/qinshu/Documents/papertableV1/skills]`。
- 不改 preset 配置：将技能放到项目的 `.agents/skills/`。

对当前目录布局而言，第一种改动面更小；但本次仅排查，未实施。

## 3. `dsh-super-injector` 在 web profile 的真实状态

### 当前证据

- web 进程 PID `55421`，启动于 `2026-08-15 21:35:21`。
- 实际包内 `lib/index.js` mtime 为 `2026-08-15 16:54:28`，早于当前进程启动，所以当前进程不是修复前的残留进程。
- `GET /super-injector/api/list` 返回 HTTP 200：

```json
{"ok":true,"entries":[],"stats":{"reload":{"ok":2,"fail":0}},"clientDeclared":false}
```

- host API 已正常注册；web 首页 boot manifest 中有 super-injector client bundle。
- err 日志中 `ERR_MODULE_NOT_FOUND` 的最后时间为 `16:53:48`，早于 `lib/index.js` 修复和当前进程启动，属于历史错误。

### 容易误判的字段

- `entries: []`：表示当前没有通过 injector 挂入的运行时项，不表示 injector 本身未加载。
- `clientDeclared: false`：该 API 只检查 `DSH_WEB` 环境变量，不能推翻 boot manifest 已宣告 client bundle 的事实。

结论：**当前不是“加载失败被跳过”，也不是“半死不活”，而是 host/client 均已加载、目前无注入项的正常空状态。**

## 4. 飞书通道：仓库内实际只有 Memos 速记 relay

全仓库未找到 `dsh-feishu` 或等价的 DSH agent 通道插件，只有：

- `src/pw-feishu-relay.ts`
- `src/pw-feishu-relay.test.ts`

`pw-feishu-relay.ts:221-265` 的链路是：

```text
飞书 P2P 文本事件 -> 类型过滤 -> 去重 -> 写 Memos -> 回复“已记”
```

这条链路不依赖 DSH agent factory，没有 `agents.create()`，不调用 `composeAgent()`，也不 mount preset。当前 LaunchAgent 正在运行，日志能证明文本写入成功、图片消息被 skipped；这只证明“速记中继可用”，不是“飞书 agent 通道可用”。

## 5. 微信 vs 飞书能力矩阵

| 能力 | 微信 `dsh-wechat` | 飞书 `pw-feishu-relay` |
|---|---|---|
| 入站文本 | 支持私聊 | 支持 P2P 文本 |
| 出站回复 | 支持 agent 回复与本地命令回执 | 仅回复速记结果 |
| `/new` / 会话管理 | 支持，但创建裸 agent | 无 |
| DSH agent | 有 | 无 |
| `composeAgent()` / preset | 当前无 | 无，且根本不进 agent 链路 |
| skills | 当前无；按第 2 节改动后可接入 | 无 |
| host/global 插件工具 | 裸 agent 仍可继承 | 无 agent，不适用 |
| 定时任务联动 | host 插件可独立运行；当前 jobs 为空 | 无 |
| 图片/附件 | 网关有基础，但未接 agent，media-only 被忽略 | 非文本直接 skipped |
| 群聊 | 无 | 无（只收 p2p） |
| 审批/工具工作流 | preset 未挂，当前不完整 | 无 |
| 当前产品定位 | 不完整但真实的 DSH agent 通道 | 飞书到 Memos 的文本速记入口 |

## 6. 对主控两问的直接回答

### (a) 微信端“插件跟技能都不能用”是否属实？

**不属实，但 skills 当前确实不可用。**

- skills 不可用的直接原因：微信 `/new` 没有 mount preset，因此没有 `skill-filesystem` / `tool-skill`。
- 即使挂上 preset，项目顶层 `skills/` 也不在默认扫描根，还需 `customSkillDirs` 或移到 `.agents/skills/`。
- 插件不能一概而论：host/global 工具可用，preset 内工具不可用，host 守护插件是否运行又与 agent 工具是不同问题。

### (b) 若要多通道使用，飞书是否当前体验最好？

**不是。当前证据恰好相反。**

微信至少已经具备 agent 会话、`/new`、会话切换和模型回复，只是 preset/skills 组装缺失；飞书现有实现连 agent 通道都不是，它是功能单一、但已可用的 Memos 文本速记 relay。在当前仓库实现上，**微信的 agent 体验明显比飞书完整；飞书只在“随手记入 Memos”这一个场景更直接。**

## 证据索引

- 微信建会话：`dsh-plugins/dsh-wechat/src/node/core.ts:115-132`
- 微信媒体/群聊边界：`dsh-plugins/dsh-wechat/src/node/inbound.ts:55-75`
- 微信插件注入声明：`dsh-plugins/dsh-wechat/src/index.ts:51`、`src/node/index.ts:60`
- 标准 preset 组装：`deepseek-harness/packages/host/apiproxy/src/api-proxy.ts:1227-1247`
- bare agent 检测：`deepseek-harness/packages/preset/agent-presets/src/index.ts:154-173`
- skill 根目录：`deepseek-harness/packages/skill/skill-filesystem/src/index.ts:241-260`
- super-injector global tools：`dsh-routing-suite/injector/src/index.ts:2356` 附近
- 飞书 relay：`src/pw-feishu-relay.ts:221-265`

## 只读声明

本次未修改 DSH profile、preset、插件配置、LaunchAgent 或任何运行中进程，也未执行重启。唯一写入是按简报要求新增本报告文件。
