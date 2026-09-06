# TASK-PW-62 卡组决策链一键总结入笔记库

- 主需求域：非线性知识探索
- 业务接口：回写笔记摘要（实践与数据回收 → 外部笔记库，v1.2 新增接口；本域产出摘要内容，回收域的受控写入纪律约束写路径）
- 数据真值源：读 pt_cards / pt_edges / pt_verdicts / pt_runs（只读）；写 Memos（外部库，官方 HTTP API，真值留 Memos）；本地只写审计行（复用 pw_runs 审计流水）
- 质量约束与验收终态：Memos 写入只走官方 HTTP API（参照 pw-feishu-relay.ts），不碰其 SQLite；摘要是 AI 草稿、人确认后才写库；幂等防重（同一卡组同一内容摘要不重复写）；写失败可重试

## 这刀是干什么的

纸桌一个项目卡组想到一定程度，里面的分叉、改道、金子墓碑就是一条完整决策链，但它只躺在图谱里，以后想不起来也用不上。

加完这个，卡组上有个"项目差不多了"按钮：AI 把这个卡组的决策链总结成一条笔记草稿（最初的问题→关键分叉/改道→确认的金子和墓碑→最后的结论），你过目确认后写进 Memos（带 #决策链 标签）。从此这段思考进了笔记库，定时捞料（PW-61）以后能把它捞回来接着用。

## 怎么算好

- 卡组页出现「项目差不多了」入口；点开后先看摘要草稿，可改可取消，确认才写。
- 写进 Memos 的笔记带 #决策链 标签，内容含：项目名、最初问题、关键分叉/改道、金子墓碑清单、结论、生成日期。
- 同一卡组重复点，若内容没变则提示已写过并不重复建笔记（幂等键）；内容变了可写新版。
- 写入成功后给出 Memos 原链；失败给出原因可重试。
- 全程不碰 Memos SQLite；Memos 不可用时按钮降级提示，不影响纸桌任何既有功能。

以下给干活的看，可以跳过。

## 数据与接口设计

### 新端点

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/pt/projects/:id/chain-summary` | GET | 生成（或取缓存的）决策链摘要草稿：遍历项目卡组（pt_cards+pt_edges 拓扑序，附 pt_verdicts 金子墓碑），经 DeepSeek 产出结构化草稿；不落正式表 |
| `/api/pt/projects/:id/chain-export` | POST | 人确认写库：`{ summary }` → 组 Markdown → POST Memos 官方 API（tag #决策链，visibility PRIVATE，idempotency key=项目id+摘要哈希）→ 审计行入 pw_runs → 返回 Memos 链接 |

纪律：模型调用固定 DeepSeek（同 PW-61 取法）；Memos token 读取复用 pw-feishu-relay 的配置文件（~/Library/Application Support/Papertable/feishu-relay.json 的 memosUrl/memosToken），读不到配置时端点返回明确错误。

## 分工

- 后端（src/pt-chain-export.ts + 测试 + main.ts 挂路由）：经 herdr 派 Codex，简报 `agent-bridge/briefs/07-chain-export-backend.md`。
- 前端（卡组页/项目栏加「项目差不多了」入口 + 摘要预览确认弹层；frontend/src 探索区组件 + lib/api.ts）：Kimi 直接改。
- 验收：真实项目卡组走一遍 生成→改→确认→Memos 可见带标签→链接可开。
