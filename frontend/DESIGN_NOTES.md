# 设计说明 · Warm Knowledge Desk

## 1. 视觉语言

### 一句话

把界面当成一张铺着纸的书桌：当前卡片是摊开的那张纸，祖先卡片是压在下面的稿纸，右侧关系图是桌角的索引卡。

### 关键词

安静、温暖、纸张感、编辑感、有空间层级、适合连续阅读数小时、像开源桌面工具而不像营销站点。

### 与参考产品的刻意区分

| 维度 | 参考产品 | 本原型 |
|---|---|---|
| 边框 | 2 px 重描边 | 1 px 细边框，靠明度差分层 |
| 阴影 | `-4px 8px 24px rgba(0,0,0,.30)` 硬阴影 | 宽扩散低透明度双层柔影 |
| 卡片底色 | 与页面背景接近的灰米 | 卡片明显亮于背景，形成纸面浮起感 |
| 关系入口 | 只有抽象图标 | 图标 + 中文短标签 + 语义色（TASK-022 起去掉方向文案，方向由关系图承担） |
| 关系图 | 单色节点 | 三色语义连线，线型区分继承策略 |
| 正文 | 16/24 聊天式 | 15/1.78 编辑式排版，标题带细分隔线 |
| 用户消息 | 深色重阴影气泡 | 低对比暖气泡，不与正文抢注意力 |

不使用原产品的名称、Logo、色值、坐标、图标组合与文案。

---

## 2. 令牌

### 颜色

```css
--bg:         #F3EEE5;  /* 应用背景，叠加极轻纸张颗粒 */
--card:       #FBF8F2;  /* 当前卡片 */
--card-back:  #EAE3D9;  /* 后方祖先卡片 */
--composer:   #EEE8DF;  /* 输入器 */
--raised:     #F7F3EC;  /* 次级浮起面：小按钮、菜单项底 */
--sunken:     #ECE5DA;  /* 下陷面：代码块、表头、输入框 */

--ink:        #342B26;  /* 主文字 */
--ink-2:      #746A62;  /* 次级文字 */
--ink-3:      #9A9087;  /* 弱文字、占位符、图例说明 */

--line:       #D8D0C6;  /* 主边框 */
--line-soft:  #E4DDD3;  /* 内部分隔线 */

--accent:     #E66A3A;  /* 主强调 / 深挖 */
--ctx:        #6F8C76;  /* 引用与上下文 / 发散 */
--branch:     #6F7893;  /* 分支辅助 / 改道 */
--danger:     #B65D56;  /* 危险 */
```

三种关系各自绑定一个语义色，并在关系胶囊、底部按钮、轮次工具条 hover 态、关系图连线四处保持一致。这是让用户形成关系记忆的核心手段。

### 圆角

| 元素 | 值 |
|---|---|
| 当前卡片 / 后方卡片 | 23 px |
| 输入器 | 26 px（移动端 20 px） |
| 浮层、模态、格式选项 | 13–18 px |
| 胶囊、圆形按钮 | 999 px |
| 小按钮、菜单项 | 8–11 px |

### 间距

基础步长 4 px。常用：卡片内边距 18/22/30 px，正文最大宽度 720 px，段落间距 15 px，标题上间距 30 px（h2）/ 24 px（h3）。

侧栏 232 px（折叠 56 px），关系图 214 px，卡片舞台最大宽度 1207 px（TASK-022 起，对齐 Explore 实测卡宽）。

### 阴影

```css
--sh-card:  0 1px 2px rgba(52,43,38,.04), 0 18px 44px -18px rgba(52,43,38,.28);
--sh-back:  0 12px 32px -20px rgba(52,43,38,.30);
--sh-pop:   0 2px 6px rgba(52,43,38,.06), 0 16px 40px -12px rgba(52,43,38,.24);
--sh-float: 0 1px 3px rgba(52,43,38,.08), 0 8px 24px -8px rgba(52,43,38,.22);
```

统一使用暖黑（`#342B26` 的低透明度），不使用纯黑。所有阴影都是「近距离细阴影 + 远距离宽扩散」两层，避免脏。

### 字体

系统无衬线栈，中文优先 PingFang SC / Microsoft YaHei / Noto Sans SC。

| 用途 | 尺寸 / 行高 | 字重 |
|---|---|---|
| 卡片标题 | 19 / 1.35 | 640 |
| 正文 | 15 / 1.78 | 400 |
| Markdown h2 | 19 / 1.45 | 660，带下边框 |
| Markdown h3 | 15.5 / 1.5 | 640 |
| 用户气泡 | 14.5 / 1.7 | 400 |
| 胶囊、工具条 | 11.5–12.5 | 550–600 |
| 分区标签 | 10.5，字距 0.1em | 600，大写 |

中文正文行高 1.78，保证长时间阅读舒适。标题只通过字重、字距与细分隔线获得编辑感，不引入展示字体。

---

## 3. 卡片层级规则

```text
stage (padding 14/26)
└── stack (max-width 1207)
    ├── back-card  depth 3   translateY(-3×peek) scaleX(.904) rotate(-0.4°)  z 7
    ├── back-card  depth 2   translateY(-2×peek) scaleX(.936) rotate( 0.45°) z 8
    ├── back-card  depth 1   translateY(-1×peek) scaleX(.968) rotate(-0.4°)  z 9
    └── card       current   translateY(0)       scaleX(1)                   z 20
```

- `--stack-top: 66px`（移动端 46 px）为堆叠预留的顶部空间；
- `--peek: 21px`（移动端 20 px）为每层露出的高度，正好容纳一行来源标签；
- 只做水平缩放不做垂直缩放，保证露出的高度严格等于 `peek`，标签不会被当前卡片切掉；
- 最多展示 3 层祖先，超出部分只在关系图中体现；
- 亮度每深一层降低 2%，配合 `--card-back` 与当前卡片形成三级明度差；
- 旋转角度交替 ±0.4–0.45°，只做暗示不做装饰。

祖先链由 `pathToRoot()` 沿 `CardEdge` 反向回溯得到，与关系类型无关 —— 发散和改道卡片同样有自己的路径。

---

## 4. 动效规则

| 动效 | 时长 / 曲线 |
|---|---|
| 侧栏展开收起 | 200 ms `cubic-bezier(.22,.8,.28,1)` |
| 工具条、菜单出现 | 140 ms ease-out |
| 概念预览出现 | 160–220 ms |
| 卡片切换 | spring（stiffness 260 / damping 30 / mass .9），落在 320–420 ms 区间 |
| 新卡片进入 | 由关系类型决定方向：深挖 `y+56`、发散 `x+120 rotate 2.5°`、改道 `x−120 rotate −2.5°` |
| 关系图节点更新 | 随 React 重渲染，无额外补间 |
| Toast | 200 ms 上浮淡入 |
| 流式光标 | 1 s steps(2) 闪烁 |

原则：

- 动效只用于表达结构关系与状态变化，不做装饰性循环动画；
- 卡片切换允许轻微旋转与层级缩放，幅度控制在 3° 与 5% 以内；
- 不使用大幅弹跳、持续漂浮、视差；
- 全局遵循 `prefers-reduced-motion: reduce`，命中时所有过渡与动画降级为 0.01 ms。

---

## 5. 组件边界 —— 接真实数据时改哪里

当前所有状态集中在 `src/store.tsx`，组件只消费状态与动作。接入真实实现时，改动应被限制在下面这些位置。

### 5.1 持久化

`StoreProvider` 内的 `useState` 替换为 Dexie / SQLite 封装。组件侧不需要改动，因为它们只通过 `useStore()` 读写。

建议边界：新增 `src/lib/persistence.ts`，导出 `loadProject / saveCard / saveEdge / trashCard`，由 store 调用，组件不直接接触。

### 5.2 上下文拼装

现在 `Composer` 里的「本次上下文」面板是按 `edge.type` 静态推导展示的。真实实现应新增独立、可单测的模块：

```ts
// src/lib/buildContext.ts
export function buildContext(cardId: string, g: Graph): LlmContext
```

面板改为直接渲染 `buildContext()` 的返回值，这样界面显示的就是真正会发出去的内容，而不是两套逻辑。`ContextPolicy` 已经在 `types.ts` 中定义，`CardEdge.contextPolicy` 是唯一事实来源。

### 5.3 模型调用与流式

`store.tsx` 中的 `streamAnswer(cardId)` 是唯一的流式入口，内部用 `setInterval` 逐字追加。替换为 `fetch()` + `ReadableStream` 或 SSE 时：

- 保持函数签名不变；
- 保持 `streamingTurnId` 语义（非 null 即为生成中，驱动发送/停止按钮切换）；
- `stopStream()` 保持「保留已生成内容」的行为；
- 建议每 250–500 ms 批量落库一次，不要每 token 写一次。

### 5.4 概念标注

现在是 `Card.concepts: string[]`，渲染时按字符串匹配。真实实现应改为功能模型返回的结构化区间：

```ts
type ConceptTerm = { text: string; start: number; end: number; reason?: string };
```

改动点只有 `lib/markdown.tsx` 的 `withConcepts()`：从「按词表切分」改为「按偏移切分」。`ConceptPreview` 组件的 props 不变。

### 5.5 Markdown 渲染

`lib/markdown.tsx` 是自写的极简渲染器，只为原型服务。替换为 `react-markdown + remark-gfm + rehype-katex` 时，需要保留两件事：

- AI 正文容器上的 `data-turn-ai={turnId}` 属性 —— 选区工具栏靠它判断选区归属；
- 概念词渲染为 `<button class="concept-term">` —— 概念预览靠它定位锚点。

注意：现有解析器对流式中间态做了「每轮至少消费一行」的保护，换用第三方库时这个问题自动消失。

### 5.6 关系图布局

`lib/graph.ts` 的 `layoutGraph()` 是固定分层布局（深度决定 y，同层顺序决定 x）。节点数量变多后可替换为 d3-hierarchy 或力导向，`GraphNavigator` 只依赖返回的 `Map<id, {x, y, depth}>`，不需要改动渲染代码。

交互补充（TASK-022）：图栏支持左键拖拽平移（窗口级 pointer 监听，>4px 才算拖动；拖完当次 click 不触发展开/收起与跳卡）；SVG 最小画布 720×1150，小树下也可拖；手动滚动/拖拽 3 秒后平滑归位到当前节点。

### 5.7 导入导出

`Dialogs.tsx` 只负责格式选择与状态反馈，业务逻辑完全没有耦合。真实实现时把 `onDone(label)` 换成实际的适配器调用即可：

```ts
// src/lib/io/{markdownDir,jsonCanvas,bundle}.ts
export function exportProject(p: Project, g: Graph): Promise<Blob>
export function importProject(input: FileList): Promise<{ project: Project; graph: Graph }>
```

### 5.8 不应被改动的约定

- 三种关系必须继续统一走 `CardEdge`，不要为发散和改道新增独立字段；
- `SourceAnchor` 是引用、概念预览、分支点三者共用的定位结构，不要各自另起一套；
- 删除必须继续走软删除 + 撤销，不要引入不可逆删除；
- 所有右键或悬停能力必须同时存在可见入口（`…` 菜单或常驻按钮）。
