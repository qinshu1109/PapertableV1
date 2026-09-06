# TASK-PW-22 全局证据对话 + PW-20 修复（执行规格）

- 状态：**已完成（2026-08-06 kimi 主会话执行 + 验收通过）**
- 主需求域：判断沉淀与复用（全局对话 Harness；修复项属内容生产视图层）
- 业务接口：提供选题候选 / 提供语料与回流数据 / 提供有效判断·生产侧（均为消费，全局装配用）
- 数据真值源：pw_collab_messages（新增 'global' 哨兵会话行，本任务拥有该哨兵约定）；listContentBets 过滤规则修正（不改表结构）
- 质量约束与验收终态：全局对话工具全部只读；挑/改/否仍无 AI 通路（断言延续）；`npm run verify` 全绿（含新测试）；真实模型冒烟（全局问证据）；ego 截图确认两修复（底栏不叠加、rail 无 void）

## 背景（用户反馈，2026-08-06）

1. 右下角「探索/镇纸」区域切换与协作台底部对话条视觉叠加。
2. rail 出现已作废（void）押注卡——listContentBets 未过滤。
3. **AI 应该能看到全局证据；点进卡片才能对话太低效**——层 1 需要真正的全局证据对话（此前"对话按卡隔离"在真实使用中证明对全局问题低效）。调整：层 1 底条升级为可展开的全局对话抽屉（AI 可见全部候选卡/内容押注卡/语料/判决）；层 2 单卡深挖保留（按卡隔离纪律仅适用于深挖）。

## 范围

### 后端

1. **'global' 哨兵会话**：`pw-collab.ts` 导出 `PW_COLLAB_GLOBAL_BET_ID='global'`；appendPwCollabMessage/runCollabTurn 对 'global' 跳过 getPwBet 存在性校验；会话/session 按 'global' 持久（复用 openCollabSession）。
2. **全局装配**（pw-context.ts buildCollabContext）：betId='global' 时不查 pw_bets、不 404，装配块 = 在途内容押注卡（pending：标题/转化信号/看结果日）+ 待选候选卡 top5 + 语料库清单 + 金子墓碑 §N（无关键词预筛，按基础序）；system prompt 追加全局说明（可见全局证据、细节用工具、挑改否无工具）。
3. **工具**（pw-collab-tools.ts）：
   - read_bet / read_doc_versions / read_voice 增加可选参数 {betId?}：缺省用 context.betId；全局会话未指定时返回引导语（先用 list_content_bets / list_sieve_cards 选卡）；
   - 新增 allow 只读工具 `list_content_bets`（{}）：在途内容押注卡摘要（标题/状态/转化信号/看结果日）。
4. **listContentBets 过滤 void**（pw-content-bets.ts）：SQL 加 `status != 'void'`。

### 前端（Collab.tsx / pw.css）

5. 层 1 底条：获得焦点或提交时展开**全局对话抽屉**（底部约 55% 高，ChatPanel betId='global'，头部标注「全局证据 · AI 能看到候选卡/押注卡/语料/判决簿」，可收起）；TOOL_LABEL 补 list_content_bets。
6. `.pw-cb-chatbar` 右边距让开区域切换（约 150px）。

## 测试（src/pw-global-collab.test.ts）

1. 'global' 会话 append/list 不需要 pw_bets 行；buildCollabContext('global') 不 404 且含在途押注/候选卡/语料清单块。
2. read_bet：全局未指定 → 引导语；带 betId 参数 → 返回卡。
3. list_content_bets 工具执行正确且 policy=allow。
4. listContentBets 不含 void。
5. 权限断言延续（无写工具/无 pick/reject）。

## 验收

1. verify 全绿。
2. 真实模型冒烟：全局抽屉问「现在大盘上有哪些证据？」→ 走 list_sieve_cards/list_content_bets 类工具回答。
3. ego 截图：底栏与区域切换不叠加；rail 无 void 条目；抽屉展开可用。

## 验收记录（2026-08-06，kimi 主会话执行）

1. ✅ 构建：verify 106/106 全绿（含新测试 pw-global-collab.test.ts 6 组 + pw-collab.test.ts 工具数断言 16→17 连带更新）。
2. ✅ 全局证据对话：'global' 哨兵会话（pw_collab_messages 改 id 弱引用，旧库含 FK 自动重建迁移——与仓库弱引用约定一致）；全局装配（在途押注/候选卡/语料清单/金子墓碑 §N）；COLLAB_GLOBAL_PROMPT_NOTE 注入。
3. ✅ 工具：read_bet/read_voice/read_doc_versions 支持可选 betId（全局未指定回引导语）；新增 allow 只读 list_content_bets；权限断言延续。
4. ✅ 真实模型冒烟（全局抽屉问「现在大屏上有哪些证据？」）：AI 调用语料清单/读连接状态/看内容押注/看候选卡四个工具，按全局证据回答（在途押注卡/候选卡/语料库/连接状态/§N 判决），未进单卡即完成全局问答。
5. ✅ 修复①：底栏 margin-right 150px，截图确认与「探索/镇纸」区域切换不再叠加；修复②：listContentBets 过滤 void，rail 不再显示作废押注。
6. ✅ ego 截图：层1 底栏让开 + 抽屉展开（/tmp/pw22-board.jpg、/tmp/pw22-drawer.jpg）。
7. 排障：浏览器缓存致旧 bundle（硬刷解决）；ego CDP 截图间歇性超时（重启 ego lite + 页面重载恢复）。
8. 偏差：层 1 底条从「可输入」改为「点击展开抽屉」（输入在抽屉内进行）；全局抽屉头部标识后补（全局证据对话 · 跨卡可问）。
