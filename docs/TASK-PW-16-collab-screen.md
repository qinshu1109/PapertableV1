# TASK-PW-16 协作台屏（一比一 papertable-collab.html）

- 状态：已完成（2026-08-04 验收通过）
- 主需求域：判断沉淀与复用
- 业务接口：无（域内界面；数据全经 PW-15 collab API 与既有 PW-09 drafts API 消费）
- 数据真值源：无新真值源（pw_collab_messages / pw_drafts / pw_bets / 装配上下文由后端 TASK-PW-15 提供）
- 质量约束与验收终态：一比一设计稿（60/40 布局、对话流、tool-chips、gold-ref、draft-card、右 rail 三块、loopbar node-draft）；全部真实数据无编造；`npm run verify` 全绿；1440×900 截图对照设计稿；真实对话一轮（提问→芯片→§引用→草稿卡→批准/改/否）

## 范围（frontend/src/pw/Collab.tsx）

- 布局：左 60% 对话流 + 右 40% rail + 底部 loopbar（复用押注台闭环带组件逻辑；06 结账节点在有待确认结账草稿时挂 node-draft「AI 已起草建议」）。
- 对话流：chat-eyebrow「协作台 · {BET 编号} · 数据解读」；msg-user / msg-ai（镇纸 AI · 副驾驶）；tool-chips 按 SSE tool_start/tool_end 实时出现（检索数据文档/读取判决簿/语料检索/对比上期指标等）；回答内 §N 渲染 gold-ref（title=金子原文）；draft-card 渲染 PW-09 待确认草稿（确认采纳/我来改 → PW-09 confirm/编辑流）。
- 输入区：composer（placeholder「和 AI 副驾驶讨论这一把……」）+ note「云端旗舰模型 · 每次对话干净上下文 + 金子墓碑注入」；Enter/按钮发送，SSE 流式渲染。
- 右 rail：本次上下文（装配注入条目：金子/墓碑/语料，§N；「有用/无关/该更新」三钮只记 pw_runs 事件 + toast）；待你确认（PW-09 drafts + PW-14 待批准 fetch 授权，批准/改/否）；当前押注卡（bs-rows：押注/验证指标/结账日）。
- 押注选择：默认第一 pending（到期优先），无押注时空态引导去押注台。
- 导航：协作台从 disabled 解锁；Home 协作台卡状态=待确认条数（无则「已开通」）。

## 不做

- 多会话管理/历史列表（每注一条流）；上下文反馈反哺装配权重；移动端特殊优化（照抄设计稿响应式即可）。

## 验收记录（2026-08-04）

1. ✅ 构建：`npm run verify` 全绿（68 后端测试 + selfcheck + tsc + vite build）。
2. ✅ 视觉：1440×900 截图对照设计稿——60/40 布局、对话流、tool-chips（中文标签）、gold-ref §N 角标、draft-card（确认采纳/我来改）、右 rail 三块（本次上下文 4 条注入/待你确认/当前押注卡）、loopbar 06 节点「AI 已起草建议」全部一致；Home 协作台卡「1 项待你确认」warn、导航解锁。
3. ✅ 真实对话一轮（UI 发送）：「语料里观众对洛唐那期视频最有感的点是什么」→ 语料检索芯片实时出现 → 命中两条真实评论 → AI 给出有据结论（观众有感的是 UP 主人设而非过程演示，并主动提醒参考视频不等于本注判据）；修复后同问命中，结论成立。
4. ✅ 补充修复：assistant 消息的 markdown（`**粗体**`/`` `代码` ``）渲染（原样显示星号问题）+ 行内 code 样式。
5. 状态：已完成。待确认队列里留有一条演示用结账建议草稿（BET-01，settle_tomb）供界面展示。
