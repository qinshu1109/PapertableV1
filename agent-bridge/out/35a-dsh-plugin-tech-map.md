# 简报 35 任务 A：dsh 插件技术机制调研 —— 可落地的插件技术地图

- 执行方：dsh 窗口 w4:p9（本调研）
- 日期：2026-08-16
- 类型：调研（不写实现代码；本文件只含源码证据与最小代码骨架示意）
- 产出：`agent-bridge/out/35a-dsh-plugin-tech-map.md`
- 遵守：`agent-bridge/GUARDRAILS.md` 红线默认生效；全程只读，未改任何 profile 配置、未动生产数据、未写实现代码

---

## 0. 一句话结论

dsh 的插件 = **Cordis 插件**，面向 Web 时采用**双半形态**：同一包内 `main` 是 Node/host 半（跑在 dsh 进程里，可读 SQLite、可 fetch 本机 HTTP、可注册 `webServer` 路由和 host 命令），`exports["./client"]` 是 browser/client 半（跑在浏览器里，通过 `dsh.client` 声明被 `window.__DSH_BOOT__` 发现，用 `ctx.slots.register` 往左栏/中栏/右栏的 slot 挂 UI）。Oil Creator 那种“左栏 tab + 内容列表 + 中间详情 + @引用/斜杠注入”全部有原生扩展点，最省事的组合是：

- 左栏 tab/内容列表：注册进 `sidebar.workspaces`（或整体替换 `sidebar`）；
- 中间详情：注册进 `conversation.view`（会话内 tab）或整体替换 `conversation`（无会话工作台）；
- @引用/斜杠：`ctx.inputTriggers.registerSource` + `ctx.commandUi` / `ctx.commands`；
- 面板状态注入模型：`@` 源返回 `ReferenceInsert` + `codec.serialize()`，提交时把面板状态展开成模型可见文本；或 host 命令 + `agent.inbox`/`agent/pre-step` 追加上下文；
- 读 SQLite / 调本机 HTTP：host 半直接用 `node:sqlite` 和 `fetch`，通过 `ctx.webServer.register` 开同源 API，client 半 fetch；重型类型化 RPC 用 `TypertRemoteService` + `ctx.remote.$mount`。

---

## 1. 真值源与已读材料

| 材料 | 路径 | 用途 |
|---|---|---|
| dsh 源码（web client 插件机制） | `/Users/qinshu/Documents/ChatGPT/MemOS/deepseek-harness` | slot/input-trigger/commands/modules/remote 的全部扩展点 |
| 已有自研插件样板 | `/Users/qinshu/Documents/papertableV1/dsh-plugins/` | dsh-wechat（host 协议驱动）、dsh-routing-suite/injector（host 工具 + webServer API + client panel 的现成 hybrid）、memos-mcp-overlay（HTTP MCP 接入） |
| 社区插件 | `~/.dsh-source/profiles/web/node_modules/@dsh-external/dsh-mobile-nav` | 纯 client 插件：`dsh.client`、`slots.inject`、`slots.register` 的完整实装 |
| 镇纸数据源 | `papertableV1/src/main.ts`、`src/pw-*.ts`、`docs/*` | 4317 HTTP API、SQLite 表、只读/写权限纪律 |
| 本机 web profile | `~/.dsh-source/profiles/web` | 安装形态、pnpm workspace、bundle 列表 |
| 本机 web 启动脚本 | `~/.dsh-source/run-web.sh` | launchd/常驻 web 的 `DSH_HOME` 事实 |

---

## 2. 问题 1：dsh web client 注册“左栏新 tab/页面”和“详情面板”的 API

### 2.1 结论

**没有独立的“tab 注册 API”**。dsh 的 UI 扩展点是 **slot 注册表**：`ctx.slots.inject(<已声明 slot>, () => ctx.slots.register({...}, Component))`。左右中三栏都是 slot，插件通过“占据某个 slot / 向某个 list slot 加条目”实现页面与 tab。

关键 slot（源码声明）：

| Slot 名 | 类型 | 作用域 | 谁声明 | 出处 |
|---|---|---|---|---|
| `sidebar` | single | root | ui-layout | `packages/client/ui-layout/src/client/index.ts:49,123` |
| `sidebar.workspaces` | single | root | ui-sidebar | `packages/client/ui-sidebar/src/client/contract/slots.ts:24`、`src/client/index.ts:48` |
| `sidebar.settings` | single | root | ui-sidebar | `packages/client/ui-sidebar/src/client/contract/slots.ts:30` |
| `sidebar.footer.action` | list | root | ui-sidebar | `packages/client/ui-sidebar/src/client/contract/slots.ts:35` |
| `conversation` | single | session-maybe | ui-layout | `packages/client/ui-layout/src/client/index.ts:62,124` |
| `conversation.session` | single | session | ui-conversation | `packages/client/ui-conversation/src/client/contract/slots.ts:44` |
| `conversation.view` | list | session | ui-conversation | `packages/client/ui-conversation/src/client/contract/slots.ts:76`、`apply.ts:242,376` |
| `conversation.session.header.actions` | list | session | ui-conversation | `packages/client/ui-conversation/src/client/contract/slots.ts:52` |
| `conversation.details.tool` | single | session | ui-conversation | `packages/client/ui-conversation/src/client/contract/slots.ts:124`、`apply.ts:448` |
| `details` | single | session | ui-layout | `packages/client/ui-layout/src/client/index.ts:72,125` |
| `shell.overlay` | list | root | ui-layout | `packages/client/ui-layout/src/client/index.ts:83,126` |

### 2.2 左栏“内容 tab”怎么做

官方**没有**给 sidebar shell 提供“会话/内容”两个 tab 的内置座位。要做出 Oil Creator 那种左栏 tab，只能二选一：

1. **占据 `sidebar.workspaces`（推荐）**：把整个“浏览区”换成你自己的组件，组件内部画两个 tab（“会话 / 内容”），内容 tab 显示本地内容条目列表。代价：`sidebar.workspaces` 是 single slot，占掉后官方 WorkspaceBrowser 不再渲染；若还要官方会话树，需要在“会话”tab 里自己实现一个简化版（或接受用官方 `sidebar` 整体替换并保留更多）。
2. **整体替换 `sidebar`**：把整个左栏（含品牌、New Session、折叠、设置入口）都换掉，自由度最大、工程量最大，且 `sidebar` 的 child slots 会随旧 occupant 一起消失，需要自己重新声明 `sidebar.workspaces/settings/footer.action` 或自绘。

注册骨架（纯 client 半）：

```ts
// src/client/index.ts
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { ContentSidebar } from './ContentSidebar.tsx'

export const inject = ['slots', 'sessions', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.workspaces', () =>
    ctx.slots.register({
      name: 'sidebar.workspaces',   // 必须是已声明 slot 名
      id: 'pw-content-sidebar',
      order: 0,
      // inject: () => ({ openContent: ... }),   // 可选业务面
    }, ContentSidebar),
  )
}
```

`ContentSidebar` 内部就是一个带 `useState<'sessions' | 'content'>` 的 tab 组件；内容列表数据从 host API 拉（见问题 3）。

### 2.3 中间详情面板怎么做

两条路线，按“要不要无会话可用”选：

- **路线 A：`conversation.view` 加一个 tab（推荐，保留聊天/输入框）**
  `conversation.view` 是 list slot，ui-conversation 已把它渲染成会话头部 tab 环（`ConversationSession.tsx` 的 `tabs.length > 1` 即显示 tab）。插件注册一条 `conversation.view`，就会在中间栏头部多一个 tab，内容显示在中间栏正文区。官方 chat 也是这么注册的（`packages/client/ui-conversation/src/client/apply.ts:376-428`）。
  语义：**会话内视图**。适合“打开某内容条目的详情/脚本/字幕/文章”这类依附于 dsh 会话协作的面板。
- **路线 B：整体替换 `conversation`（适合无会话工作台）**
  `conversation` 是 single slot，占据后整个中间栏（hero + 会话 + 输入框）都换成你的 `ContentWorkbench`。适合“内容管理本身不需要聊天框”的产品；代价是聊天/输入框需要自己重建或做“返回会话”切换。对 Oil Creator 那种“点内容条目开中间详情”最接近，但工程量大。

骨架（路线 A）：

```ts
ctx.slots.inject('conversation.view', () =>
  ctx.slots.register({
    name: 'conversation.view',
    id: 'pw-content-detail',
    order: 10,
    label: () => '内容',
    // store / inject 可选
  }, ContentDetailPanel),
)
```

骨架（路线 B）：

```ts
ctx.slots.register({
  name: 'conversation',          // 直接 register，不 inject：conversation 由 ui-layout 声明
  id: 'pw-content-workbench',
  // children 可再声明自己的子 slot
}, ContentWorkbench)
```

### 2.4 右栏

`details` 是右栏单槽，`conversation.details.tool` 是它的子槽，当前官方语义是“工具调用详情”。Oil 的中间详情不是右栏；右栏只作为可选的补充（如把某条数据的 tool 详情放右栏）。

### 2.5 官方实装参考

社区 `dsh-mobile-nav` 就是最简 client 插件：`inject=['slots','layout','locale',...]`，然后 `ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register(...))`、`ctx.slots.inject('shell.overlay', ...)`、`ctx.slots.inject('sidebar.footer.action', ...)`，见 `~/.dsh-source/profiles/web/node_modules/@dsh-external/dsh-mobile-nav/lib/client.js:1171,1398,1407,1420`。

---

## 3. 问题 2：@引用、斜杠命令、把面板状态注入会话上下文

### 3.1 总览

| 能力 | 扩展点 | 谁实现 |
|---|---|---|
| `/` 候选菜单 | `ctx.inputTriggers.registerSource({ trigger: '/', ... })` | client |
| `@` 候选菜单 | `ctx.inputTriggers.registerSource({ trigger: '@', ... })` | client |
| `/` 命令真正执行 | host `ctx.commands.register({ name, description, handler })` | host |
| `/` 弹窗选择（popupSelect） | client `ctx.commandUi.register({ name, ui: { kind:'popupSelect', ... } })` | client |
| 面板状态进模型上下文 | `@` 源 `codec.serialize(ref)`；或 host 命令 + `agent.inbox`/`agent/pre-step` | client+host |

### 3.2 `/` 斜杠命令

host 命令注册（`packages/interaction/commands/src/index.ts:40-54,245`）：

```ts
export const inject = ['commands']

export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'current-content',
    description: '把当前打开的内容条目摘要注入本会话上下文',
    input: { hint: '[无参数]' },
    handler: async (invocation) => {
      // host 侧可读插件自己的状态存储 / 4317 API
      return { kind: 'success', text: '已注入当前内容条目' }
    },
  })
}
```

client 侧 `/` 菜单来源与 popupSelect（`packages/client/ui-commands/src/client/contract.ts:46-86`，`src/client/index.ts`）：

```ts
ctx.commandUi.register({
  name: 'current-content',
  description: '把当前打开的内容条目注入上下文',
  available: () => true,
  ui: {
    kind: 'popupSelect',
    options: async () => [{ id: 'current', label: '当前条目' }],
    onSelect: async (option, session) => { /* 执行或回填 */ },
  },
})
```

### 3.3 `@` 引用

`@` 源注册接口在 `packages/client/ui-input-trigger/src/types.ts:138-182`。官方 `ui-subagent` 就是 `@` 参考实现（`packages/client/ui-subagent/src/client/index.ts`）。

### 3.4 面板状态注入模型上下文 —— 三种深度

**方式 1：纯文本回填（最浅）**
`onPick` 返回 `{ text: '@内容条目 ' }`，模型看到的就是字面 `@内容条目`。若要模型“理解”面板状态，还需要 host 侧 pre-step 识别并展开（官方 skill 就是这条路：`packages/client/ui-skill/src/client/index.ts` 返回 `/name `，由 host 的 `dsh-tool-skill` pre-step 展开）。

**方式 2：`ReferenceInsert` + `codec.serialize()`（推荐，面板状态直达本轮 prompt）**
`onPick` 返回 `{ insert: { source:'pw-content', ref:'card-123', label:'押注台/某押注', clipboardText:'/content card-123' } }`，并实现 `codec.serialize(ref, signal)`。提交时 input machine 会把占位符替换成 `serialize()` 的返回值（`packages/client/ui-conversation/src/client/input/facade.ts:412-440`；`packages/client/ui-input-trigger/src/client/controller.ts:229-243`）。这样模型收到的就是：

```
<papertable-content id="card-123">
  标题：……
  状态：……
  证据：……
</papertable-content>
```

骨架：

```ts
const source: InputTriggerSource = {
  trigger: '@',
  name: 'pw-content',
  order: 1,
  async candidates(session, { query }) {
    const items = await fetch('/pw-workbench/api/contents?q=' + encodeURIComponent(query))
      .then(r => r.json())
    return items.map((x: any) => ({ name: x.id, description: x.title }))
  },
  lexicon(session) {
    // 返回已加载 id 列表，用于草稿里的 chip 高亮
    return loadedIds
  },
  onPick({ candidate }) {
    return {
      insert: {
        source: 'pw-content',
        ref: candidate.name,
        label: candidate.description ?? candidate.name,
        clipboardText: '/content ' + candidate.name,
      },
    }
  },
  codec: {
    clipboardText: ref => '/content ' + ref,
    async serialize(ref) {
      const detail = await fetch(`/pw-workbench/api/contents/${ref}`).then(r => r.json())
      return `<papertable-content id="${ref}">\n${detail.text}\n</papertable-content>`
    },
  },
}
ctx.effect(() => ctx.inputTriggers.registerSource(source), 'pw-content: @ source')
```

**方式 3：host 命令 / host pre-step 追加上下文（最重，适合“整段状态自动进下一轮”）**
参考 `packages/context/time-context/src/index.ts` 和 `packages/context/session-reference/src/index.ts:169-216`：host 侧可以在 `agent/pre-step` 事件里 `{ kind:'accept', additionalContexts:[createUserMessage(...)] }`，或直接 `agent.inbox.append('next-step', ...)`。适合 `/current-content` 这类“把当前打开条目作为背景材料”的语义；但注意当前选中状态在 client 侧，需要先同步到 host（webServer API / Remote / 插件自己的 store）。

### 3.5 关键源码证据

- input-trigger 服务契约：`packages/client/ui-input-trigger/src/client/contract.ts:18`
- `InputTriggerSource` 完整定义：`packages/client/ui-input-trigger/src/types.ts:138-182`
- 引用 codec：`packages/client/ui-input-trigger/src/types.ts:114-133`
- 提交时展开引用：`packages/client/ui-conversation/src/client/input/facade.ts:412-440`
- `serializeReference`：`packages/client/ui-input-trigger/src/client/controller.ts:229-243`
- host 命令注册：`packages/interaction/commands/src/index.ts:40-54,245`
- client popupSelect 契约：`packages/client/ui-commands/src/client/contract.ts:29-86`
- 官方 `@` 参考：`packages/client/ui-subagent/src/client/index.ts`
- 官方 `/` skill 参考：`packages/client/ui-skill/src/client/index.ts`

---

## 4. 问题 3：插件内读外部 SQLite / 调本机 HTTP 的可行路径与分工

### 4.1 结论

- **SQLite 只能在 host 半读**：浏览器没有 Node `node:sqlite`。host 半可直接 `import { DatabaseSync } from 'node:sqlite'` 打开只读连接（dsh 自己的存储层就这么做：`packages/storage/storage-sqlite/src/schema.ts:9,61-77`）。
- **本机 HTTP 两条路**：
  1. host 半 `fetch('http://127.0.0.1:4317/api/...')`（dsh-wechat 的 iLink client 就是 host 半直接 fetch 外部 HTTP：`dsh-wechat/src/gateway/ilink-client.ts:94-114`）；
  2. host 半用 `ctx.webServer.register({ kind:'prefix', path:'/pw-workbench/api', handler })` 开同源路由，client 半 `fetch('/pw-workbench/api/...')`。官方 webserver 路由 API 在 `packages/host/webserver/src/index.ts:28-35,94`；社区 `dsh-routing-suite/injector` 已实装同款 hybrid（`dsh-routing-suite/injector/src/index.ts:3236-3246`）。
- **类型化 RPC（可选，更重）**：host 服务继承 `TypertRemoteService` + `@Remote`（`packages/feedback/message-feedback/src/index.ts:150,189,205,271`），client 通过 `ctx.remote.$mount(contribution)` 安装后 `ctx.remote.<namespace>.<method>()`（`packages/api/gateway/src/client/index.ts:100-105`）。对第三方 out-of-tree 插件，**优先 webServer 路由**，避免动 api-remotes 装配和 Typert 生成。

### 4.2 host + client 分工（参照 dsh-wechat / dsh-routing-suite）

| 层 | 职责 | 禁做 |
|---|---|---|
| host 半 | 开 SQLite（只读真库）、fetch 4317、开 `/pw-workbench/api` 路由、注册 host 命令、处理凭据 | 不把 DB 连接/密钥发到浏览器 |
| client 半 | 渲染左栏/中栏/右栏 slot、调 `fetch('/pw-workbench/api')`、注册 `/` `@` 源 | 不 import Node 模块、不直连 SQLite |

社区 hybrid 样板（`dsh-routing-suite/injector/src/index.ts`）：
- host：`export const inject = ['tools', 'webServer']`，`ctx.webServer.register({ kind:'prefix', path:'/super-injector/api', handler })`（3236-3246），同时 `ctx.tools.register(defineTool(...))`（337-347）；
- client：`export const inject = ['slots']`，`ctx.slots.inject('conversation.view', () => ctx.slots.register({ name:'conversation.view', ... }))`（376-381）；
- client 直接 `fetch('/super-injector/api')`（`src/client/index.ts:48`）。

### 4.3 host 半读 SQLite 骨架

```ts
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DB_PATH = join(homedir(), 'Library/Application Support/Papertable/papertable.sqlite3')

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/pw-workbench/api',
    handler: async (req, res) => {
      const db = new DatabaseSync(DB_PATH, { readOnly: true }) // 只读打开
      try {
        const rows = db.prepare('SELECT id,title,status FROM pw_bets ORDER BY created_at DESC LIMIT 50').all()
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, rows }))
      } finally {
        db.close()
      }
    },
  }), 'pw-workbench: api')
}
```

### 4.4 镇纸硬约束对应实现策略

- 真库 `~/Library/Application Support/Papertable/papertable.sqlite3` **只读**：host 打开 `readOnly: true`；所有写走 4317 已提供的 draft/proposed 接口。
- Memos 只读：不直连 Memos 库；走镇纸 4317 `/api/pw/notes*`。
- 判断权在人：插件 UI/工具只摆证据、生成草案，不替人把 `pw_verdicts` 等正式表标成正式。

---

## 5. 问题 4：六个屏逐一插件形态建议

判断口径：**“看”= 面板（client，数据经 host 路由）**；**“判/协作”= client+node hybrid + `/` `@` 注入**；**“让 agent 直接查”= node tool + skill**。

| 镇纸屏 | 数据真值/接口 | 建议插件形态 | 理由 |
|---|---|---|---|
| 押注台 | `pw_bets`、`/api/pw/bets`、`/api/pw/bets/due`、`/api/pw/bets/ledger` | **client+node hybrid**：左栏“内容”列表 + 中间详情 + `@` 注入在途押注；host 提供 `/pw-bets/api` 只读查询 | 协作价值最高、数据已持久化；判断/结账仍回镇纸大屏，dsh 只带上下文 |
| 金子墓碑库 | `pw_gold_mirror`、`pw_verdicts`、`/api/pw/golds`、`/api/pw/verdicts*` | **client+node hybrid（偏只读展示）** + `@` 引用金句/墓碑；可选 node tool `query_gold` | 典型“引用沉淀”场景，`@` 源 + codec 直接把金句带进模型最顺 |
| 协作台 | `pw_collab_messages`、`pw_settle_drafts`、`/api/pw/collab/pending-queue` | **client+node hybrid**：面板看队列 + host 命令/工具处理提案；写只落 draft 表 | 涉及写/审批，必须 host 半 + 人确认；参照 dsh-wechat 的协议驱动形态 |
| 观众声音 | `pw_voice_*`、`pw_voice_sieve_*`、`/api/pw/voice*`、`/api/pw/sieve/*` | **client+node hybrid + node tool**：面板做矩阵/主题浏览；node tool 让 agent 按固定桶查评论证据 | 数据量大、要逐字证据，工具查询比面板更有用；只读语料库 |
| 运维数据源 | `/api/status`、`/api/pw/activity-daily`、`/api/pw/source-stats`、`pw_runs` | **纯 client（经 host 路由）+ 少量 node tool**：只读监控面板；可加 node tool `ops_status` | “看”为主，无写；不需要复杂状态机 |
| 大盘笔记 | `/api/pw/notes*`、`/api/pw/notes/tree`、`/api/pw/notes/rollups` | **client+node hybrid**：笔记树/大盘面板 + `@` 引用笔记；node tool 读 Memos 只读接口 | 笔记是“素材引用”，`@` 注入最自然 |

通用建议：

1. **P0 只做押注台 + 金子墓碑**，都是纯只读 + `@` 引用，风险最低、闭环最快。
2. 六个屏共用一个 host 路由前缀（如 `/pw/api/*`），避免每屏各开一套 RPC。
3. 面板状态（当前选中条目）放一个 client 全局 store；`@` 源和中间详情面板读同一个 store。
4. 需要 agent 主动查数据时，把“查询”做成 node tool + skill，而不是让模型去读 UI。

---

## 6. 问题 5：已知坑与落地注意

### 6.1 GitHub 安装 / pnpm isolated 布局 / allowBuilds

- `dsh plugin --profile <name> <args...>` 本质是在 profile 目录里转发 `pnpm`；相对路径 `add .` 锚定到调用目录，所以要在插件 checkout 里执行（`apps/cli/reference/README.md:43`）。
- GitHub 插件如果带源码和 `prepare` 脚本，pnpm ≥10 默认拦构建：第一次 `add` 会失败并给出 `allowBuilds` 键，把键复制到 profile 的 `pnpm-workspace.yaml` 再重跑（`apps/cli/reference/README.md:51`）。本机 web profile 的 `pnpm-workspace.yaml` 是 `packages: ["."]` + `nodeLinker: hoisted` + `autoInstallPeers: false`（`~/.dsh-source/profiles/web/pnpm-workspace.yaml`）。
- profile 的依赖装在 profile 自己的 `node_modules`，`dsh.profile.bundles` 会在每次 pnpm 成功后按 `dsh.bundle.patch` 声明自动对账（`apps/cli/reference/README.md:43,11`）。

### 6.2 DSH_HOME 与 launchd web

- profile 路径是 `$DSH_HOME/profiles/<name>`（`apps/cli/reference/README.md:9`）。本机 web 实际由 `~/.dsh-source/run-web.sh` 启动：脚本里 `export DSH_HOME=/Users/qinshu/.dsh-source`，再 `pnpm dsh web --trusted-host dsh.cozai.net`。
- **装插件必须带同一个 `DSH_HOME`**：否则 `dsh plugin --profile web add ...` 会写到另一个 home 的 profile，`dsh web` 看不到。
- 另有一份 launchd plist `/Users/qinshu/主知识库_AI/80_AI暂存/dsh-web-autostart/com.deepseek-harness.web.plist` 指向 `DSH_HOME=/Users/qinshu/.dsh`（与 `.dsh-source` 不同）。改动/排障前先确认当前 web 到底由哪份拉起，避免装错 home。

### 6.3 client 插件必踩的三个坑

1. **必须声明 `dsh.client` + 导出 `./client`**：`package.json` 里 `"dsh": { "client": { "platform": "web", "inject": [...] } }`，并且 `exports["./client"]` 指向构建好的 bundle（`docs/subsystems/client-modules.md:49`）。bundle 用 `window.__ModuleLoader__.load({ id, factory })` 注册（`packages/client/modules/src/client/system.ts:87-106`）。
2. **apply 用 `ctx.slots` 必须 `export const inject = ['slots', ...]`**；`ctx.slots.register` 必须带 `name`（slot 名），否则报 “slot undefined is not declared”。这是 `dsh-routing-suite/injector` 自己踩过并写进生成模板的坑（`dsh-routing-suite/injector/src/index.ts:364-381,2104-2105,2841-2845`）。
3. **不要注册到 `root`**：`root` 是 single slot，第二个 occupant 会整体替换整个 AppFrame（`packages/client/runtime/src/client/slots.ts:22-32`）。要加全局浮层用 `shell.overlay`。

### 6.4 加载顺序与依赖

- `dsh.client.inject` 只是元数据/预取提示，不保证 apply 顺序；依赖别的 slot 声明时用 `ctx.slots.inject(...)` 等待（`packages/client/ui-workspace/src/client/index.ts` 注释）。
- host 半和 client 半是同一个包的两种构建产物；client 半不能 import Node 模块。双半共享类型可以放公共 `types.ts`。

---

## 7. 最小包形态（汇总骨架）

```jsonc
// package.json（示意，不落盘）
{
  "name": "@papertable/dsh-pw-workbench",
  "type": "module",
  "main": "./lib/index.js",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-ui-slots",
        "@deepseek-ai/dsh-client-ui-input-trigger",
        "@deepseek-ai/dsh-client-ui-commands",
        "@deepseek-ai/dsh-client-locale"
      ]
    }
  }
}
```

```yaml
# cordis.patch.yml（示意）
- insert:
    - id: pw-workbench
      name: '@papertable/dsh-pw-workbench'
      config:
        apiPrefix: /pw-workbench/api
```

安装/验证命令（示意，需带 `DSH_HOME`）：

```sh
cd /path/to/dsh-pw-workbench
DSH_HOME=/Users/qinshu/.dsh-source dsh plugin --profile web add .
DSH_HOME=/Users/qinshu/.dsh-source dsh --profile web --dump-config   # 应出现 pw-workbench 层
```

---

## 8. 本调研自验记录

- 只读检查：未修改 `briefs/`、未改 profile、未写实现代码；本文件是唯一新增。
- 证据核对方式：对 dsh 源码/社区插件用 `grep -n` 定位导出名、slot 名、行号；对镇纸 API/表名用 `papertableV1` 仓库只读检索。
- 关键源码行号均以上方表格/正文标注，可直接回溯。
- 未做端到端安装验证（本任务是机制调研，不装插件、不改 profile）；安装/验收留给后续实现简报与独立验收简报。

## 9. 待确认/交接给产品映射（任务 B）的要点

- 六个屏中 P0 建议押注台 + 金子墓碑；任务 B 需要拍板“左栏 tab 是替换 `sidebar.workspaces` 还是整体替换 `sidebar`”“中间详情用 `conversation.view` 还是替换 `conversation`”。
- `@` 注入用 `codec.serialize` 展开成 `<papertable-content>` 还是走 host pre-step 展开，取决于模型要看到“结构化块”还是“纯文本”。
- 写路径（协作台/押注）必须继续遵守“AI 只摆证据、人确认转正”，dsh 插件只访问 draft/proposed 接口。
