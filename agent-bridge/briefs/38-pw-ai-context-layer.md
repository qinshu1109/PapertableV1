# 简报 38：镇纸插件的「AI 上下文层」研究（不动手实现，只出方案与核验）

## 背景（已核实事实，不要重复调研）

镇纸 dsh 插件已存在：`papertableV1/dsh-plugins/dsh-paperweight/`

- host 半（`src/host/`）：
  - `tools.ts`——8 只读工具（pw_list_bets / pw_read_bet / pw_read_data_docs / pw_search_verdicts / pw_read_verdict_evidence / pw_query_voice / pw_recall_notes / pw_ops_status）+ 唯一写工具 pw_draft_bet（落 draft 区）
  - `index.ts`——已注册一个 systemPrompt 段 `papertable:write-boundary`（order 120，只有写边界店规 5 条）
  - `api.ts` / `push.ts` / `commands.ts`——/pw/api/* 路由、定时推送收件箱、/bets 命令
  - 数据只走 `http://127.0.0.1:4317` HTTP API，不直连 SQLite
- client 半：web 前端六屏 tab（推送/押注台/金子墓碑/观众声音/大盘笔记/运维）已上线，**保留不动**

**用户的判断**：目前只嵌入了网页版前端（人看数据用）；DeepSeek agent 的上下文里并没有「镇纸是什么、我在其中怎么引导人」这层认知。本简报研究的就是补上这层「AI 上下文层」，让 dsh 里的 DeepSeek 了解整个个人工作台系统，能引导用户熟悉系统并引导创作。

**参照样板**：`papertableV1/dsh-plugins/dsh-memory-discipline/index.js` 已示范两条注入通道：
1. 静态 systemPrompt 段：`ctx.systemPrompt.section({name, order, text})`，text 必须是配置的纯函数（逐字节一致，KV-cache 友好）
2. 动态状态注入：监听 `agent/session-start` → `agent.runMaintenance()` 领 idle 相位 → 拉数据 → `agent.inject(createUserMessage({..., source:{kind:'plugin', form:'notice'}}))` 注入会话收件箱；失败降级为短提示，不炸会话

dsh 源码 checkout：`/Users/qinshu/Documents/ChatGPT/MemOS/deepseek-harness`

## 分工

### A. Claude（w4:p9）——上下文层内容设计

产出：`agent-bridge/out/38a-context-content-design.md`

1. 设计静态导览段 `papertable:workbench-guide` 的完整提示词文本（中文），内容覆盖：
   - 镇纸系统全貌：押注台/金子墓碑/观众声音/大盘笔记/运维五屏各自是什么、数据在哪
   - 决策闭环工作流：候选→押注→数据回流→到期待裁决→金子/墓碑→校准复利
   - 工具使用手册：什么场景调哪个 pw_* 工具（对照 tools.ts 里 9 个工具逐一给触发场景）
   - 引导原则：AI 摆证据不给结论、裁决只能人点按钮、引导新用户先做什么（与 write-boundary 店规不重复、不冲突）
2. 设计 session-start 动态 notice 的内容模板与数据清单：从 4317 拉哪些字段（押注中数量/到期待裁决列表/未读推送数/最近金子墓碑），notice 文本怎么写让 AI 开场就能引导
3. 文本长度预算：静态段建议 token 量级、动态 notice 上限，KV-cache 友好性说明
4. 给出验收标准：什么现象算「AI 真的理解了工作台」（可观察的对话行为）

### B. Codex（w4:pB）——dsh 源码能力核验

产出：`agent-bridge/out/38b-dsh-capability-check.md`

对照 dsh 源码（`/Users/qinshu/Documents/ChatGPT/MemOS/deepseek-harness`）逐条核验，每条给源码文件:行号证据：

1. `ctx.systemPrompt.section()` 的确切语义：order 排序规则、是否只接受静态 string、求值时机（每轮重建还是启动一次）、多段拼接格式
2. `agent/session-start` 事件、`agent.runMaintenance()`、`agent.inject()` 在当前 pin 版本（harness commit 47f9438 之后可能有变，以本机 checkout 为准）是否原样存在，签名有无变化
3. web profile（DSH_HOME=/Users/qinshu/.dsh-source）下，out-of-tree 插件注册的 tools 是否进入 web 会话模型上下文；有没有 profile/预设层会过滤工具的机制
4. 插件热更新/重装的正确姿势：改完 dsh-paperweight 后重装到 web profile 的确切命令序列（含 launchctl kickstart 重启），以及验证注入生效的观察点（日志关键字/web 会话里怎么看）
5. 风险清单：这套注入在 dsh pre-release 阶段最可能踩的坑

## 约束

- 两个窗口都只研究、只写产出文档，**不改任何插件代码、不装任何插件、不重启任何服务**
- 引用代码事实必须带 文件:行号
- 完工后立刻主动回报主控：
  `herdr agent prompt w4:p1 "简报38 完工：<A或B> 一句话结论 + 产出路径 + 有无阻塞"`
- 卡住超过 20 分钟也要回报阻塞原因，不要沉默
