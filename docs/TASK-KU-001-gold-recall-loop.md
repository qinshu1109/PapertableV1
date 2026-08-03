# TASK-KU-001 金子的模型自选复用与可见闭环

- 状态：in_progress（机制已实现并验证；模型标注合规性待 claude 复测，见第 8 节）
- 主需求域：判断沉淀与复用
- 业务接口：提供有效判断（判断沉淀与复用 → 可信资料求证）
- 数据真值源：MemOS `papertable-verdicts` 中已确认、未被替代的判决；`pt_verdicts` 只作本地缓存、写队列和 MemOS 不可用时的降级副本；`pt_run_events.verdict_trace`（本轮提供）与 `verdict_use`（模型实际引用）是审计记录
- 质量约束与验收终态：每个干净上下文提供本项目全部有效链尾判决（≤10 条，确定性排序）；模型引用金子必须显式插入 `[[verdict:id]]` 标注；伪造/未知 id 不计入复用；回答底部只显示真实 used，不拿 provided 冒充；项目隔离、confirmed 门禁、supersede 链尾和降级语义不变；`npm run verify` 通过；真实模型人工验收通过

## 0. 执行结论

v1（系统侧字符串匹配召回）已作废：真实数据显示 25 次运行中金子命中 0 次，证明在当前规模下系统侧匹配既不可靠也不必要——3 条金子 1 条墓碑的项目不存在检索问题，只存在"提供"问题。

v2 改为模型自选：每个干净上下文提供本项目全部有效判决，模型按本轮问题自行决定是否引用，引用必须显式标注，系统解析标注生成用户可核对的复用记录。原两个根因（长查询逐字拆空格、整串互相包含）随 `buildVerdictQuery` 删除消失，不再修复。

## 1. 问题级需求

用户确认金子的目的不是收藏 AI 输出，而是让已经验证过的判断在相关后续问题中成为默认参照，减少重复探索和前后矛盾。

如果没有本任务：判决簿会继续显示「已确认」，但后续回答实际用不到这些结论；所谓知识宇宙只会成为一份可浏览库存，不能产生复用价值。

## 2. 真实基线（2026-08-03）

运行中的 V1 数据库：

`/Users/qinshu/Library/Application Support/Papertable/papertable.sqlite3`

真实最近活跃项目：

- 项目：`有效需求分析`
- project id：`6aaffa96-622a-4e61-a083-6788bf0cba28`
- 17 张卡、16 条边、25 次运行
- 3 条 confirmed gold、1 条 confirmed tombstone
- 四条判决均已成功同步 MemOS，pending = 0，failed = 0
- v1 机制下 25 条 `verdict_trace`：命中 gold 0 次、只命中 tombstone 3 次、无命中 22 次

## 3. 本任务使用的三条真实金子

| 用户亲手填写的概念把手 | 本地 verdict id | MemOS memory id | 来源 run | 相关验收问题 |
|---|---|---|---|---|
| 开发先开五类最小需求单元 | `82d8930e-3513-4029-b6dd-b17818890e80` | `df799513-4f44-41e9-be3d-2c68c74c033f` | `d33458c9-ca26-4b6f-b0dc-97327f61cc47` | 开发一个新功能前应该检查哪些最小需求单元？ |
| 用场景的进度跟AI协作 | `d6f78545-d556-48fa-abe1-345a1055eb8c` | `0ceca7fd-e549-47c5-b24c-53c39fe9fe41` | `a5ea539e-8482-43fe-b2bc-06270cc80880` | 我提出叠纸风后，怎样先还原真实使用场景？ |
| AI往往对另一个AI不够了解……前端视觉需求应让AI用已有实现跟参照物反复对照先写计划 | `161b0799-a1df-4ce2-8f95-810d0c801854` | `7da6bffd-fab9-4a04-b000-bbf445434451` | `c75eebe1-7b7e-4941-865f-97bb19c3b9c8` | 让另一个 AI 调整前端前，怎样核对当前实现和参考站？ |

这些 ID 只用于核验当前数据，不得硬编码进产品代码或测试实现。自动化测试应建立自己的最小 fixture。

## 4. 机制（v2）

1. **提供**：`loadVerdictContext` 列出当前项目全部 confirmed、未放弃、非 supersede 链中的判决（MemOS 正常与本地缓存降级同一集合），按 id 确定性排序，最多提供 10 条，trace 记录 `providedTotal` 与 `truncated`。
2. **契约**：`verdictInjectionBlock`（`verdict-v2`）告知模型：金子与本轮问题真正相关时才参考；实际参考必须在对应句末插入 `[[verdict:id]]`；没参考一个不插；墓碑必须避开、无需标注；不得修改或伪造判决。
3. **记录**：运行完成后从最终答案提取标注（`extractVerdictUse`），只承认本轮提供集合内的 id，按首次出现去重，写入 append-only 事件 `verdict_use`（provided / used / unknownCount / availability / source）。
4. **可见**：完成回答底部显示「本回答参考了你确认过的判断：…」（只读 `verdict_use.used`）；正文标注渲染为行内 ✦；判决簿状态文案为「confirmed · 可提供」。

## 5. 五类最小需求单元

### 5.1 业务功能

1. 每次求证前，取得当前项目全部有效链尾判决并提供给模型（≤10）。
2. 模型按契约自行决定引用并显式标注。
3. 系统解析标注生成 `verdict_use`，伪造/未知 id 计入 `unknownCount` 而不计入 used。
4. 完成回答底部显示本轮真实复用（used），无复用则不显示。

### 5.2 业务数据

| 数据 | 唯一归属/用途 |
|---|---|
| confirmed 判决、概念把手、替代关系、远端 identity | MemOS `papertable-verdicts` |
| `pt_verdicts` | 本地缓存、写队列、降级副本；不得升级成第二真值源 |
| `verdict_trace` | 本轮提供了哪些判决、来源与降级状态 |
| `verdict_use` | 模型本轮实际标注引用了哪些判决 |
| 自动 stage 的 `knowledge-universe` Cube | 候选/会话提取数据；不得作为本任务的正式金子来源 |

### 5.3 质量场景

1. **提供完整**：相关问题与无关问题都提供同一有效集合；accepted 语义是"模型可见"。
2. **标注忠实**：used 只能来自本轮提供集合；伪造 id 不进 used。
3. **无关克制**：真实模型回答无关问题时不得硬插 `[[verdict:]]`（人工验收观察项）。
4. **远端/降级一致**：MemOS 正常和本地降级提供同一集合；降级来源明确显示。
5. **版本安全**：被 supersede 的旧判决、其他项目判决、proposed/abandoned 判决不得提供。
6. **可审计**：UI 复用行必须来自该轮 `verdict_use.used`，不得用 provided 或项目金子总数冒充。
7. **复杂度上限**：不引入新模型调用、Embedding、向量库、分词依赖或新服务；提供 ≤10 条，排序确定。

### 5.4 业务接口

`提供有效判断`：

- 提供者：判断沉淀与复用
- 使用者：可信资料求证
- 输入：project id、当前问题（仅审计记录）
- 输出：本项目全部有效链尾判决（≤10）；availability/source 审计信息
- 约束：项目隔离；MemOS 不可用时显式降级本地副本；相关性判断由模型完成并强制显式标注

### 5.5 业务报表

本阶段不新建统计页或知识宇宙大屏。`verdict_trace` + `verdict_use` + 回答底部复用行已足够回答「这轮是否复用了哪条判断」。

## 6. 实现清单（本会话已完成）

- `src/verdicts.ts`：`VERDICT_PROMPT_VERSION = "verdict-v2"`；删除 `buildVerdictQuery`；`loadVerdictContext` 全量提供 + `PROVIDE_LIMIT = 10`；降级路径 `localVerdictContextItems` 同集合；注入块契约改写；新增 `extractVerdictUse`。
- `src/engine.ts`：完成分支解析标注并发射 `verdict_use`；cardDetail 绑定 `verdictUse`。
- 前端：`Turn.verdictUse` 管道（types/api/store）；`normalize.ts` 的 `extractVerdictMarks` 把标注渲染为 ✦；`RunFooter` 复用行；判决簿文案「confirmed · 可提供」。
- `src/verdicts.test.ts`：全量提供/降级同集合/项目隔离/supersede 链尾/截断/标注提取测试。

## 7. 自动化验收

`npm run verify`（node:test 14 项 + selfcheck + 前端 build）已通过。

注意：本机 shell 的 `node` 被 ChatGPT 应用 cua_node 抢占（库校验阻挡 rollup 原生模块），构建需用官方 Node：

```bash
PATH="/Users/qinshu/.local/node/bin:$PATH" npm run verify
```

## 8. 真实模型人工验收（2026-08-03 已执行）

不用 mock 模型。在运行中的实例（launchd 托管，真实项目「有效需求分析」）实测结果：

**机制（全部通过）**

- 每个干净上下文提供全部 4 条有效判决（3 金 1 碑）：`verdict_trace.providedTotal = 4`、`truncated = false`、`source = memos`，SQL 已核。
- `verdict_use` 事件在 completed 轮正常生成并绑定到 `Turn.verdictUse`；前端类型/管道/构建通过。
- 无关问题（「问题级需求和方案级需求有什么区别？」）completed 且 used = 0，无误标。
- 降级/项目隔离/supersede 链尾由自动化测试覆盖（14 项 node:test + selfcheck + 前端 build 全绿）。

**模型标注合规性（未通过，待复测）**

- 相关问题（金子的验收问题原句）干净完成 4 轮、跨 3 版提示词契约（块内规则 → 标注令牌 → 主提示词同级强制规则），deepseek-v4-flash 全部 used = 0：模型严格遵循 `[[source:]]` 引用协议，但完全不理会 `[[verdict:]]` 协议。漏标率 100%。
- claude（cozai claude-opus-5）验收期间持续 502 upstream unavailable，未能对照；恢复后需用同一问题复测标注合规性。
- 后续方向（需用户拍板，不在本任务内）：换更强模型复测；要求回答末尾输出逐条判决核对行；或接受模型自选不可靠、回到显式携带路径。

**验收期事故与排障记录**

- launchd `com.qinshu.papertable.backend`（KeepAlive=5s）与手工实例抢 4317：每个新实例启动时 `recoverInterruptedRuns` 把在途 run 标成 `process_interrupted`，表现为 provider_error。已定位并恢复为 launchd 单实例托管。
- cozai 502 与代理 env 均与此无关；探针确认 opencode-go（deepseek-v4-flash）简单/工具/流式调用均正常。
- 本机 shell 的 `node` 被 ChatGPT 应用 cua_node 抢占（库校验阻挡 rollup 原生模块），构建需 `PATH="/Users/qinshu/.local/node/bin:$PATH"`。
- 测试遗留：真实项目新增 2 张验收卡片；临时项目「验收隔离-可删除」待删（产品暂无删除接口）。

只读核验 SQL：

```sql
SELECT
  r.id,
  r.question,
  json_extract(t.payload_json, '$.providedTotal') AS provided,
  json_extract(u.payload_json, '$.used') AS used,
  json_extract(u.payload_json, '$.unknownCount') AS unknown
FROM pt_runs r
LEFT JOIN pt_run_events t
  ON t.run_id = r.id AND t.event_type = 'verdict_trace'
LEFT JOIN pt_run_events u
  ON u.run_id = r.id AND u.event_type = 'verdict_use'
WHERE r.project_id = '6aaffa96-622a-4e61-a083-6788bf0cba28'
ORDER BY r.created_at DESC;
```

## 9. 明确不做

- 不用、不扩展 `scripts/mock-model.mjs`（selfcheck 既有 mock e2e 是概念卡存量设施，与本任务无关）。
- 不做知识宇宙大屏、关系图、跨项目复用或自动关系生成。
- 不做「带入下一问」按钮、相关金子建议条、有用/无关反馈按钮（后续 TASK）。
- 不做漏标/虚标的启发式检测（验收期人工观察）。
- 不新建判决表、知识节点表、MemOS Cube、确认接口或替代接口；不改 `pt_verdicts` 表结构。
- 不把自动 stage 的记忆升级为正式知识；不扩展 `promotion.ts`。
- 不假设存在"三模型知识宇宙"，也不新增任何模型分类。
- 单项目有效判决超过 10 条时的预筛另立 TASK，不在本任务做。
- 不搬目录、不拆服务、不增加工厂或抽象层；不提交、不推送。

## 10. 完成报告格式

1. 修改文件与每处职责。
2. 自动化验收结果。
3. 真实模型人工验收：相关问题、无关问题、追问观察的实际表现与 SQL 核验结果。
4. 剩余风险；没有则写「无」。
