# 简报 29：dsh-cc 源码侧根因排查 + 修复方案（`{{cwd}} has no value`）

> 角色：dsh-cc（源码侧根因 + 修复方案，已按简报允许改 dsh-wechat 插件代码，未动运行中的 web 进程、未重启任何服务）
> 产出时间：2026-08-15/16（与 29-codex-cwd排查.md 独立交叉验证，结论一致）

## 这刀是干什么的

微信里发 `/new xxx` 能建会话，但 agent 一开工就报 `prompt variable "{{cwd}}" has no value for this assembly (section "deployment:persona")`，任务根本跑不起来。本报告回答：这个 `cwd` 是谁提供的、web/wechat 建会话时为什么没给它、TUI 为什么没事，以及最小修在哪。

## 怎么算好

- 根因定位到具体代码行 + 运行时证据（故障会话确实无 cwd）。
- 最小修复方案给出「配置层一行」和「插件代码兜底」两层，并说明各自生效边界。
- 已实现的插件代码兜底通过全部测试（37/37），lib 已重建，运行中进程未受影响。

## 结论一句话

微信 `/new` 走的是 dsh-wechat 插件直连 agent 工厂的旁路：只有插件配置里写了 `cwd` 才会写进会话 header，而 web profile 的 `dsh-wechat` 配置没写 `cwd` → 新会话 header 无 cwd → 全局 persona 严格解析 `{{cwd}}` 时抛错。TUI / web 页面两条创建链都会显式带 cwd，所以只有微信这条旁路中招。

## 以下给干活的看，可以跳过

### 1. `cwd` 这个 prompt 变量的值由谁供给

- 抛错点确认：`deepseek-harness/packages/core/system-prompt/src/index.ts:289`（`interpolate()`：变量名已注册但值为 `undefined` 即抛）。
- 变量注册点（唯一来源）：`packages/core/agent-loop/src/index.ts:353`

  ```ts
  ctx.systemPrompt.variable('cwd', context => context.agent?.session.header.cwd)
  ```

- assemble 时 `context.agent` 由 `assembleContextFor(agent)` 注入（`packages/core/agent/src/dispatch.ts:174`：`{ agent, scope: agent }`），所以实际值 = **该 agent 的 session.header.cwd**。
- header.cwd 只来自会话创建时的 `meta.cwd`：`packages/core/session/src/index.ts:881`（`...meta?.cwd === undefined ? {} : { cwd: meta.cwd }`）。
- 结论：**provider 链是 `agent → session.header.cwd`，没有别的兜底**。谁建会话时没给 `meta.cwd`，谁的会话就必然无 cwd。

### 2. web profile 建会话在哪绑定 cwd；wechat 通道是否跳过

三条创建链对比：

| 创建链 | 入口 | cwd 来源 | 结果 |
|---|---|---|---|
| web 页面 | `packages/host/apiproxy/src/api-proxy.ts:2180` | `workspace.path ?? payload.cwd ?? defaults.cwd`（Host cwd=process.cwd()） | 有 cwd（证据：`~/.dsh/sessions/--Users-qinshu-*` 桶） |
| TUI / headless 一次性 | `packages/bundle/headless/src/index.ts:113` | `meta: { cwd: process.cwd() }` | 有 cwd |
| 微信 `/new` | `dsh-plugins/dsh-wechat/src/node/core.ts` `createSession()` | `if (this.config.cwd) meta.cwd = this.config.cwd` | **配置没给就无 cwd** |

微信插件配置现状 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- id: dsh-wechat
  config:
    allowFrom: ['o9cq807dEMfDwFNyGGEr5MzMIqD4@im.wechat']
    agentProvider: opencode-zen
    agentModel: deepseek-v4-flash
```

**没有 `cwd`，也没有 `agentPreset`**。schemastery 对缺必填字段不抛错、直接缺字段（已实测验证），所以插件正常加载，`config.cwd === undefined`，会话建出来没有 cwd。

运行时铁证：`~/.dsh/sessions/_no-cwd/` 下正好躺着简报里那个 `wechat-msty0hzu-btdy12`（另有 `wechat-mstxkkjn-12k4vw`、`wechat-msu5d4o9-0j29ec`）。jsonl 持久化明确规定 `cwd === undefined` 落 `_no-cwd` 桶：`packages/session/session-persistence-jsonl/src/format.ts:177`（`if (cwd === undefined) return join(root, '_no-cwd')`）。普通 web 会话落在 `--Users-qinshu-*`（主知识库_AI/80_AI暂存）桶，header 带 cwd。

补充：wechat 配置里即便写了 `agentPreset`，也只是把名字写进 session meta；该旁路不经过 apiproxy 的 `composeAgent()`，不会真正挂载 preset 的 setup，因此**补 agentPreset 救不了 cwd**（与 codex 复核一致）。

### 3. 为什么 TUI 会话正常

TUI/headless 建会话显式带 `meta: { cwd: process.cwd() }`（`packages/bundle/headless/src/index.ts:113`）；web 页面走 apiproxy，cwd 有 workspace/Host 兜底（`api-proxy.ts:2180`）。两条链都不会产生无 cwd 会话。微信旁路是唯一「配置缺省即无 cwd」的链。

「普通消息也撞同一个错」是同一根因的次生现象：`pickDefaultSession()` 选中最近的会话，正好是 cwd-less 的 `wechat-*` 会话，往它 followup 同样组装失败。

### 4. 根因链路（完整）

1. web bundle persona（`packages/bundle/web-app/cordis.patch.yml` system-prompt 行）含 `Your working directory is {{cwd}}`；标准 preset 的 persona 也含（`apps/cli/config/agent-presets/standard/agent.cordis.yml`）。两处都注册为 `deployment:persona` 段。
2. agent-loop 全局注册 `cwd` 变量 = `session.header.cwd`（agent-loop/src/index.ts:353）。
3. 微信 `/new` 建会话：`meta.cwd` 仅当 `config.cwd` 非空才写（dsh-wechat/src/node/core.ts，修复前）。
4. web profile 的 dsh-wechat 配置没写 `cwd` → header 无 cwd → 持久化落 `_no-cwd/`。
5. 首次组装 system prompt 时严格解析抛 `{{cwd}} has no value (section "deployment:persona")`。

契约测试佐证：`packages/core/agent-loop/tests/loop.spec.ts:259`「factory create with meta.cwd → {{cwd}} 解析成功」；`:275`「agentLoop.create 不带 cwd → 报错文案与线上逐字一致」。

### 5. 最小修复方案

#### 方案 A（配置层，一行，零代码）——立即解封

在 `~/.dsh/profiles/web/cordis.patch.yml` 的 `dsh-wechat` 配置补绝对路径：

```yaml
- id: dsh-wechat
  config:
    allowFrom: ['o9cq807dEMfDwFNyGGEr5MzMIqD4@im.wechat']
    agentProvider: opencode-zen
    agentModel: deepseek-v4-flash
    cwd: /Users/qinshu/Documents/papertableV1   # 或微信 agent 实际要服务的项目
```

- 生效边界：web profile 对 patch 有 config-only HMR（`apps/cli/src/profile-boot.ts:272` watchUserPatches），改配置会热生效；按简报「不改运行中的 web 进程」，**本次未动此文件**，留给主控/人拍板。
- 只影响之后 `/new` 的新会话；已有 3 个 cwd-less 会话是持久化创建事实，不原地补写。

#### 方案 B（插件代码层，已实现）——根治旁路，防止再踩

`dsh-wechat/src/node/core.ts` `createSession()` 改为无条件给 cwd，配置优先、缺省兜底宿主进程 cwd（与 headless runner / scheduled-prompt 的既有约定一致）：

```ts
const meta: Record<string, string> = { cwd: this.config.cwd ?? process.cwd() }
```

改动点：
- `src/node/core.ts`：`createSession()` cwd 兜底（上述一行语义）。
- `src/index.ts` / `src/node/index.ts`：Config 注释说明缺省行为（schema 维持原样，因为 schemastery 缺必填本就不抛）。
- `test/node.test.ts`：新增 2 个用例——缺省时 `header.cwd === process.cwd()`；配置 `cwd` 时用配置值。
- `README.md`：cwd 注释同步。
- `lib/` 已重建（tsc 全量），运行中 web 进程内存里还是旧 lib，**下次重启才生效**。

验证：`pnpm test` 37/37 通过（原 35 + 新 2）；`pnpm build` 成功。

不建议的修法：不要在 persona/模板里删掉 `{{cwd}}` 或改成可选——那会掩盖「会话没有 workspace」的配置错误，让文件工具作用域继续不明确；system-prompt 严格解析是故意的 fail-loud。也不要在 agent-loop 层给 `cwd` 变量加 process.cwd() 兜底——`_no-cwd` 是合法状态（部分无盘场景），改核心层波及面大，不是最小解。

### 6. scheduled-prompt 复核（与简报说法不一致）

当前安装的 `dsh-scheduled-prompt/index.js` 的 `new-session` 分支**显式传** `meta: { cwd: process.cwd() }`（index.js:269），`~/.dsh/scheduled-prompt/runs.jsonl` 里 `new-session` 记录全部 `status: ok`（最近 13:31，steps:2），outbox 侧同步 `sent`。当前 web profile patch 也不再声明 scheduled-prompt jobs（bundle 默认 jobs:[]）。

结论：**「定时任务（scheduled-prompt → new-session）也撞同一个错」与当前源码/运行时证据不符**，同 codex 判断；可能是旧版本现象或另有 target:self 投给 cwd-less 微信 agent 的场景，不据此改 new-session 分支。

### 7. 本次变更清单（dsh-cc）

- 新增：`agent-bridge/out/29-dsh-cc-cwd排查.md`（本报告）。
- 修改（dsh-wechat 插件，未纳入 git 的目录）：
  - `src/node/core.ts`、`src/node/index.ts`、`src/index.ts`、`test/node.test.ts`、`README.md`、`lib/`（重建产物）。
- 未动：web profile 配置、launchd、运行中进程、任何服务重启。
- 阻塞：无。待主控拍板：① 配置层一行 cwd 何时落地（HMR 会热生效，需知会）；② 已有 `wechat-*` 三个无 cwd 会话按「新建会话」处理。
