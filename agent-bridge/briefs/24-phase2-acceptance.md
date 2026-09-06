# 简报 24：第二期·浏览器+接口验收（codex 执行，只验不修）

- 主控：kimi（w1:p1）；执行：codex（w1:pJ）
- 日期：2026-08-14
- 依据：简报 23（后端，完工报告 `agent-bridge/out/23-backend-done.md`）+ 主控前端（结账晋级步骤、待转正区+先例处置弹层）。

## 约束

- 只验不修；不改代码与验收标准；守门文件不碰。
- 生产 4317 **真库只读**：不结账、不晋级、不转正、不处置真实数据。写操作全走隔离实例（`PAPERTABLE_DATA_DIR=/tmp/...`，端口 4399），验完即弃。
- 截图存 `agent-bridge/qa-evidence/`（前缀 24-）；结果写 `agent-bridge/out/24-acceptance.md`。

## 验收清单

1. **结账晋级（隔离实例 UI 或 curl）**：金子/墓碑结账成功后弹出「判决晋级」步；五档可选；选非「仅归档」时适用范围必填；落账后 `GET /api/pw/verdicts/:id/promotion` 能查到 active 记录、decided_by=human；再次晋级同一判决 → 旧的变 superseded。作废结账不出现晋级步。
2. **待转正区+先例处置（隔离实例）**：造一张草稿押注 + 一条会被匹配到的金子/墓碑（指标词/标题词重叠）→ 押注台总账顶部「待转正」出现草稿 → 点开弹层：预检三项展示 ✓/✗/⚠；先例列出；不处置完点「确认转正」被拦；覆盖不填理由被拦；逐条处置后转正成功、押注变 pending、`pw_precedent_dispositions` 有账。无相关先例的草稿：显示「没有匹配到的先例」，可直接转正（仍需过预检）。
3. **激活联动闸门**：有未处置先例的草稿直接 curl activate → 409 + 未处置清单；处置完 → 200。
4. **曝光账**：在隔离实例跑一轮协作台对话（含判决引用）或读生产只读 `GET /api/pw/verdicts/exposures`，验证注入点有记账（surface 区分 collab/sieve/miner/collab_tool，actor 正确）。
5. **先例召回口径**：`GET /api/pw/bets/:id/precedents` 返回按适用匹配（有 matchReason），不是"最近 10 条"；无相关时为空数组。
6. **红线**：生产无写；1808 视口无横向滚动；控制台无报错；既有屏无回归（押注台总账/大盘双账/协作台）。

## 失败项分类与修复回路

- 后端问题：**直投 dsh-cc**——`/Users/qinshu/.local/bin/herdr-cc-prompt w1:pH "<问题+简报路径>"`，修完你复测。
- 前端问题：只记录进报告，留主控 kimi 亲自修，修完你复测。
