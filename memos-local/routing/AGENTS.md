# MemOS 本地共享记忆路由规则

<!-- BEGIN MANAGED MEMOS ROUTING -->

仅把 `memos-local` MCP 当作持久化个性化记忆来源。遵守以下顺序：

1. 新会话先读取 `memos://hot/context` 或调用 `get_hot_context`；若 Hook 已注入同一版本，则直接复用。
2. 当前上下文不足、存在历史回指、个人偏好、项目名或冲突检查时，调用 `route_memory`。根据热地图选择零至两个业务 Cube。
3. 需要业务记忆时调用 `search_memories`，只传所选的一至两个 `cube_ids` 和 `routing_decision_id`；不得省略 `cube_ids`。默认使用 `search_mode: "hybrid"`。
4. 热地图无法明确选库时，才用 `search_memories` 查询 `cube_ids: ["index"]`，并把返回的 `trace_id` 传给后续定向查询。
5. 只有 Index 仍无法明确选库、定向检索无结果，或用户明确要求跨库检索时，才调用 `search_all_memories`。全库搜索必须显式调用，默认使用 `rerank: "auto"`，不得用空 `cube_ids` 模拟全库。
6. 只写入稳定事实、长期偏好、明确决策和可复用的工作知识。业务 Cube 保留为 AI 工作记忆层；先按热地图判断归属，不明确时再查询 Index。
7. 有匹配业务 Cube 时显式传该 `cube_id` 调用 `add_memory`。新主题没有匹配库时，先用一句话简介调用 `create_cube`，再写入新 Cube。
8. `curated-knowledge` 只是人类正式 Markdown 的可重建只读缓存，不得对它调用普通新增、修改、删除或压缩工具。Knowledge Coach 发布并验证后调用 `reconcile_curated_knowledge`。
9. 精选检索结果只是短卡片；需要原始证据或准确措辞时，按结果中的 `knowledge_id` 调用 `read_curated_note`，以正式笔记为准。
10. 用 `hot_policy`、`importance`、`valid_until` 和 `supersedes_memory_id` 表达置顶、有效期与明确纠错；可能冲突但新旧关系不明确时，不得擅自覆盖旧事实。
11. 标签只作为离线 Brain 整理的参考信号，不会直接创建页面或连线。不要为了可视化给每条记忆抽取实体；只有明确要求单来源晋升时使用 `brain:pin`，明确禁止进入 Brain 与热记忆时使用 `brain:ignore`。
12. 不直接向 `index` 写普通记忆，不绕过容量限制。容量或压缩失败时向用户说明，不改写到其他库。
13. MCP 不可用时明确说明“本地记忆不可用”，继续完成当前工作，但不得声称已经读取、保存或完成精选同步。

<!-- END MANAGED MEMOS ROUTING -->
