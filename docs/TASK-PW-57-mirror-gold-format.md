# TASK-PW-57 镜像金子格式统一

## 白话：这刀是干什么的

纸桌同步过来的金子是整篇 markdown 笔记（带 `#`、`##`、`**` 这些排版记号），金子墓碑库的镜像区把它当一行字硬塞进去，排版符号全裸在外面，三条行三种长相，没法看。

改完后：镜像金子的行内只露两样——**标题** + **一句人话摘要**（排版符号全部剥掉，超出一行就截断）；想看全文点这一行，展开后排版好的全文（标题是标题、加粗是加粗）。AI 侧读的全文一个字不少，检索行为不变。

## 怎么算好

- 镜像区每一行：handle 签条 + 标题（加粗）+ 一行摘要（纯文本、省略号截断）+ 镜像日期；行内看不到任何 `#`、`**`、反引号。
- 点行展开：全文用前端既有 MarkdownView 渲染；再点收起。
- `GET /api/pw/golds` 返回每行多带 `title`、`summary` 两字段，`text` 全文原样保留。
- 关键词检索仍按全文 + handle 命中，行为不变。
- 数据零迁移：`pw_gold_mirror` 表结构不动、行数与 text 内容前后一致。

## 必填字段

- 主需求域：判断沉淀与复用
- 业务接口：无（域内）——只动镜像金子的读取派生与展示，同步语义不变
- 数据真值源：`pw_gold_mirror`（只读消费；不迁移、不加列、不改写）
- 质量约束与验收终态：见「怎么算好」+ verify 全绿 + 真实库视觉验收通过

## 执行规格

### 后端

0. **背景修订（验收冒烟发现）**：真实同步过来的金子文本是**单行** markdown——`#`、`##`、`###` 标题记号全在行内（源头导出时换行被压平，三条真实数据均零换行）。所以派生前必须先归一化，否则行级正则全部失效、摘要会真空。
   - `normalizeHeadings(text: string): string`——把「空白 + 1~6 个 `#` + 空白」替换为「换行 + 这串 `#` + 单个空格」，让行内标题变成真行首标题。`#` 前无空白的情况（如 `C#`）不匹配，不得误伤。
   - `goldTitle` / `goldSummary` / `stripMd` 处理前先过 `normalizeHeadings`。
   - 新增导出 `goldBody(text: string): string` = 归一化后的 markdown 全文（供前端展开区渲染；`text` 原文仍原样返回，AI 装配与检索不受影响）。
1. 新模块 `src/pw-gold-format.ts`，纯函数、无依赖：
   - `stripMd(text: string): string`——剥掉 markdown 排版符号：ATX 标题前导 `#`、粗斜体标记（`**`、`__`、`*`、`_`）、行内代码反引号、代码围栏行、链接 `[文字](url)` 保留文字、图片语法剥掉留 alt、引用前导 `>`、列表前导（`- `、`* `、`1. `）；折叠连续空白为单个空格。
   - `goldTitle(text: string): string`——取第一个 ATX 标题的文本（剥 `#`）；**标题行内若标题短语与正文粘连（如 `## 什么是「最小需求单元」 资料中对它的定义是：…` 整条是一个标题行），在第一个位置 ≥4 的空白字符处切断，只留标题短语**（防太短误切，如英文 `How to` 第一个空格在 3 位不切）；没有标题就取第一个非空行；超过 40 字截断（不补省略号，直接切）。
   - `goldSummary(text: string): string`——剥掉第一个 ATX 标题的**标题短语部分**，标题行粘连的正文剩余部分保留并进摘要最前面，再与其余行一起 stripMd，取前 120 字；正文为空时返回空串。
2. `src/pw-gold-sync.ts` 的 `listMirroredGolds`：返回行每行追加 `title`、`summary`、`body` 三个派生字段（调 pw-gold-format），`text` 及其余字段原样。两条查询（无关键词/有关键词）都要带。`PwGoldMirrorRow` 类型同步加字段。
3. 不改 `mirrorConfirmedGolds`（同步语义、INSERT 列、事件记账全不动）；不改 `src/main.ts`（路由直接 json 序列化 listMirroredGolds 返回值，加字段零改动）；不改 `src/pw-context.ts`（装配仍读 text 全文）。

### 前端

4. `frontend/src/pw/Vault.tsx` 镜像金子的行（现 206–212 行）改为可点展开：
   - 行内：handle 签条（原有）+ `title` 加粗 + `summary`（单行、CSS 省略）+ 镜像日期；用 `<details>`/`<summary>` 或受控展开均可，与作废折叠带（PW-54）同款交互优先。
   - 展开区：用既有 `frontend/src/lib/MarkdownView.tsx` 渲染 `body` 字段（归一化后的全文，标题能成样式）；不要用原始 `text`（单行，标题渲染不出来）。
   - `frontend/src/lib/api.ts` 的镜像金子类型加 `title`、`summary`、`body` 字段。
   - 样式加在 `frontend/src/pw/pw.css`，类名限 `pw-gold-row` 作用域内，不外溢。
   - 空态、「同步金子」按钮、同步结果提示原样不动。

### 测试

5. 新 `src/pw-gold-format.test.ts`：
   - normalizeHeadings：行内 ` ## ` / ` ### ` 变行首标题；`C#` 不误伤。
   - stripMd：多标题、加粗/斜体、行内代码、代码围栏、链接留文字、引用、列表、连续空行折叠。
   - goldTitle：有标题取标题 / 无标题取首行 / 超 40 字截断。
   - goldSummary：跳过标题行不重复 / 符号剥净 / 超 120 字截断 / 正文为空时返回空串。
   - 回归锚点（必须用真实库三条单行文本做夹具，逐字抄自 pw_gold_mirror）：
     - `# 这个提示词踩了哪些坑 ## 一、与项目事实冲突的地方 ### 坑 1：…` → title=`这个提示词踩了哪些坑`，summary 以 `一、与项目事实冲突的地方` 开头，不含任何 `#`。
     - `## 什么是「最小需求单元」 资料中对它的定义是：**最小需求单元分为…** 。` → title=`什么是「最小需求单元」`（标题与正文粘连，在空白处切断），summary 以 `资料中对它的定义是：` 开头且不含 `**`。
     - 粘连切断边界：`How to 做某事` 类首空格位置 <4 不切（title 保 `How to …` 整体再受 40 字截断）。
     - `# 用《有效需求分析》复盘：这轮开发踩了哪些坑，怎么调 ## 坑一：…` → title=`用《有效需求分析》复盘：这轮开发踩了哪些坑，怎么调`。
     - goldBody：三条夹具归一化后 `#`/`##`/`###` 均在行首。
6. `src/pw-gold-sync.test.ts` 连带：`listMirroredGolds` 返回行带正确 title/summary/body 的断言（两条查询路径各一）。既有断言不删不改语义。
7. `package.json` 登记新测试文件。

## 防冲突约定

- 只许动：`src/pw-gold-format.ts`（新）、`src/pw-gold-format.test.ts`（新）、`src/pw-gold-sync.ts`、`src/pw-gold-sync.test.ts`、`frontend/src/pw/Vault.tsx`、`frontend/src/pw/pw.css`、`frontend/src/lib/api.ts`、`package.json`。
- 不许动：`src/main.ts`、`src/pw-context.ts`、`mirrorConfirmedGolds` 函数体、`pw_gold_mirror` 表结构、其余测试文件语义。
- 不 commit、不动 git。
- node 24 的 TS 类型剥离不认跨行 `as` 断言，`as` 断言行写同一行。

## 不在本批

- 纸桌（Papertable）侧金子文案的格式治理——源头怎么写是纸桌的事，本刀只管镜像区怎么展。
- 墓碑区、作废区的版式（墓碑死因是自由文本，无 markdown 裸露问题）。
- 协作台对话里 §N 引用金子的展示。

## 验收记录（验收后填）

- 什么能用了 / 什么还不行 / 有什么等拍板：
  - 能用了：镜像金子行内只露「签条 + 加粗标题 + 一句人话摘要 + 镜像日期」，零 markdown 符号；点行展开全文按 markdown 渲染（标题成样式、加粗成样式），再点收起；检索仍按全文+handle 命中；`GET /api/pw/golds` 新增 `title`/`summary`/`body` 派生字段，`text` 原文不动，AI 装配与同步语义零变化。
  - 不行/边界：标题与正文粘连的切断是启发式（第一个位置 ≥4 的空白），极端文案可能切得不好看，遇到再调。
  - 等拍板：无。
- 证据：verify 291/291 全绿（我亲跑）；真实库 API 三条派生字段逐条核对正确（我亲 curl）；行内/展开两态截图验收（/tmp/pw-verify/pw57-rows.png、pw57-expanded.png，我亲截亲看）；关键词「拖拽」检索命中 1 条正确；pw_gold_mirror 仍 3 行、text 未动（零迁移）。
- 文件清单：src/pw-gold-format.ts（新）、src/pw-gold-format.test.ts（新）、src/pw-gold-sync.ts、src/pw-gold-sync.test.ts、frontend/src/pw/Vault.tsx、frontend/src/pw/pw.css、frontend/src/lib/api.ts、package.json。未动 main.ts / pw-context.ts / mirrorConfirmedGolds / 表结构；未 commit。
- 过程中修掉的规格漏洞（如实记录）：①真实同步文本是单行 markdown（换行被源头压平），初版行级正则全失效——补 normalizeHeadings 归一化 + body 派生字段；②`## 标题 正文` 粘连行导致标题 40 字带正文、摘要真空——补「位置 ≥4 空白处切断」启发式。两处均以三条真实库文本逐字做回归夹具锚定。
