# TASK-PW-54 金子墓碑库·空间利用率（宽屏双栏）

- 日期：2026-08-10
- 状态：已拍板（2026-08-10，用户从 A/B/C 三思路中选 A）
- 主需求域：判断沉淀与复用
- 业务接口：无（域内）——纯前端展示优化，数据读取端点零改动
- 数据真值源：无数据变更（verdicts/golds 只读消费，同 PW-06 既有端点）
- 质量约束与验收终态：见末节

## 这刀是干什么的（白话）

金子墓碑库现在页面两边大片空白（内容区被限制在 1280px 居中），作废的押注一人占一张大卡片却只有一句话，镜像金子行距也松。这刀之后：

1. **页面拉宽**——本屏内容区从 1280px 放宽到约 1600px，两边空白吃回来（只改这一屏，别的屏不动）。
2. **金子/墓碑左右分栏对照**——左边一栏全是金子，右边一栏全是墓碑，成了什么、死了什么一眼对照；每栏顶部带计数。
3. **作废收成一条折叠带**——「作废 ×2（不进入判断账）」一行，点开才看明细，明细一行一条。
4. **卡片瘦身**——金印/墓碑大图标改成标题行小图标，卡片内边距收紧；镜像金子行距收紧、长标签限宽截断。

筛选「金子/墓碑」或搜索时，回到原来的平铺卡片流（不分栏）。

## 怎么算好（白话）

- 打开金子墓碑库：页面明显变宽；左金右碑两栏，栏头各带 ×N；作废一行折叠带，点开两行明细各一行。
- 点筛选「金子」：只剩金子卡片平铺；搜索「踩坑」：结果平铺。回「全部」恢复双栏。
- 其余六屏（首页/押注台/协作台/观众声音/数据源/大盘/笔记）抽查零改动。

---

以下给干活的看，可以跳过。

## 交付（纯前端，主代理亲做）

- `frontend/src/pw/Vault.tsx`：
  - `pw-page-inner` 加 `vault` 修饰类（CSS 放宽至 1600px，仅本屏）；
  - verdicts 按 outcome 分 gold/tomb/void 三桶（均保持 decided_at 倒序）；
  - `filter==='all' && !submitted` → `.pw-vault-cols` 双栏（栏头 `金子 ×N` / `墓碑 ×N` + 空栏空态行）+ `.pw-void-strip` 折叠带（`<details>`，明细一行一条 meta）；
  - 筛选或搜索 → 既有 `.pw-vault-grid` 平铺（行为不变）；
  - VerdictEntry 紧凑化：移除绝对定位大图标（GoldSeal 不再用于本屏），TombFig size=16 内联进 kind 行（其余屏 pw-entry 不受影响，CSS 全部 scoped 到本屏修饰类下）。
- `frontend/src/pw/pw.css` 末尾追加 TASK-PW-54 段：`.pw-page-inner.vault` 放宽；`.pw-vault-cols`（2 列 grid、栏间距）；`.pw-vault-col-head`（计数栏头，金/碑配色）；`.pw-void-strip`（折叠带与单行明细）；本屏 `.pw-entry` 紧凑覆盖（padding 12、margin 10、正文 padding-right 归零、`.pw-tomb-fig` static 内联）；镜像金子收紧（row padding 8×12、g-handle 限宽 220px 截断、g-text 12.5px、gap 6）。

## 质量约束与验收终态

- `PATH="$HOME/.local/node/bin:$PATH" npm run verify` 全绿（无新测试，前端 build 必过）。
- Playwright 真实指针截图验收（1896×916，主代理亲做）：全部视图双栏+折叠带、折叠带展开、筛选金子、搜索态；首页/协作台各一张抽查零改动。
- 后端零改动、端点零改动；不 commit；既有未提交改动原样保留。

---

## 验收记录

**验收通过（2026-08-10）**；规格/实现/verify/截图验收=主代理亲做（纯前端屏刀）。

- 交付：`frontend/src/pw/Vault.tsx`（verdicts 分三桶、全部视图金/碑双栏 + 作废 details 折叠带、筛选/搜索回平铺、VerdictEntry 紧凑化移除绝对定位大图标改 TombFig size=16 内联、新增 VaultColumn）+ `frontend/src/pw/pw.css` 末尾 TASK-PW-54 段（全部覆盖 scoped 在 `.pw-page-inner.vault` 下：放宽 1600px、双栏 grid、栏头计数配色、卡片瘦身、作废折叠带、镜像金子收紧与 handle 220px 截断）。
- verify（主代理跑）：**273/273 全绿**（272+1，那 1 是 PW-52 中继 extractReceiveMessage 回归测试），selfcheck ok，前端 build 成功。后端零改动。
- Playwright 真实指针截图（1896×916，/tmp/pw-verify/pw54-*.png）五张全过：①全部视图——宽屏生效、左金 ×0（空态）右碑 ×1（紧凑卡）、作废折叠带、镜像金子收紧；②折叠带展开两行各一行；③筛选「金子」回平铺空态；④搜索「踩坑」回平铺「没有匹配」（镜像金子区不受搜索影响，既有行为未变）；⑤首页抽查零改动。
- 留痕：筛选「金子」空态文案是通用「判决簿还空着」（PW-06 既有行为，非本刀范围）；GoldSeal 组件保留在 ui.tsx（本屏不再使用，未删）。
- 不 commit；其余六屏样式零触碰（CSS 覆盖全部 scoped）。
