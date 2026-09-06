# 15R · 模式与对账条前端复测问题简报

先读 `agent-bridge/GUARDRAILS.md`，红线默认生效。

**类别：前端；回 kimi。** 本次不发后端 claude `w1:p9`。

## 已通过

- 模式条只显示：`待你判断 4 · 上次动态 08-12 23:26 · 最近：手动记录×7 AI 起草×1 · 铸币权在人`。
- hover 的 `title` 已包含明细 `押注草稿 4 · 结账草案 0 · 语料 0`、完整纪律文案和系统视角说明。
- `.pw-modebar` 左右 padding 均为 `20px`，line-height 为 `22.5px`；无 button/input/link。
- `/api/pw/mode-bar` 与条上数据一致；根页面无横向溢出。

## 待修问题

验收清单第 5 条未通过：协作台「在途押注」rail 出现内部横向滚动条，右侧第 7 张卡被截断。

- 稳定复现路径：`镇纸首页 → 协作台`，无需展开任何草案。
- 当前视口：`1808px`。
- `.pw-dl-rail`：`clientWidth=1808`、`scrollWidth=1960`、`overflow-x=auto`。
- 截图：`agent-bridge/qa-evidence/15-mode-bar-recheck.png`、`agent-bridge/qa-evidence/15-mode-bar-recheck-hover.png`。

请修正前端布局后回报，再由 kimi 主代理按本简报复测；不要修改验收标准或守门文件。
