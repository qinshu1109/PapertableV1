# MemOS Local

这是 Mac mini M4 上的本地持久化 MemOS 2.0.24 服务。原始记忆、Brain Pages、热记忆、FTS 和检索轨迹持久化在本机；Embedding 与 Reranker 请求发送到 SiliconFlow，Brain、会话提取与容量压缩使用 OpenCode Go 的 DeepSeek V4 Flash，热记忆由本地确定性编译，不运行本地模型。

> DeepSeek V4 Flash 调用 `POST https://opencode.ai/zen/go/v1/chat/completions`，使用非流式 OpenAI-compatible 协议。当前模型能力按 1M 输入上下文、384K 单次最大输出建模；384K 只作为硬上限，不作为默认生成量。健康探针、会话抽取和容量压缩使用非思考模式，Brain 页面治理使用低思考模式；普通结构化输出预算 16K，复杂 Brain 合并/关系预算 32K。结构化任务启用 JSON mode，SDK 自动重试关闭，连接错误由共享调用层执行两次显式退避重试；Brain 小批候选遇到 `stop` 但无最终正文时也会有限退避重试，并在最终失败记录中保留批次序号和输入规模。

## 一键操作

- 首次双击 `bin/start.command` 会安装并启动用户级 LaunchAgent；以后登录 macOS 自动启动，进程异常时由 launchd 自动重启。
- 双击 `bin/stop.command` 会停止当前登录会话中的服务和看门狗；再次运行 `start.command` 即可恢复常驻。
- 终端运行 `bin/status.sh` 查看状态和磁盘占用。
- Brain 默认每 24 小时在后台整理一次；需要立即全量重建时，先停止服务，再运行 `bin/rebuild-brain.sh`，然后重新启动。
- 热记忆默认在重要写入后防抖 5 分钟编译、每 24 小时全量编译、每 168 小时清理过期项；编译固定为本地确定性选择，直接记忆、Brain Pages 与检索地图分别使用 55%/35%/10% 的上下文预算。
- 离线维护：`bin/rebuild-hot.sh`、`bin/rebuild-fts.sh`、`bin/validate-derived.sh`；执行前必须停止服务。
- 精选知识缓存可在服务运行时由 MCP 工具 `reconcile_curated_knowledge` 刷新；离线维护可先停服务再运行 `bin/reconcile-curated.sh`。
- 验收数据默认保留；先停止服务，再运行 `bin/cleanup-tests.sh --confirm` 才会删除四个固定测试 Cube 及其压缩档案和检索轨迹。
- MCP 地址：`http://127.0.0.1:8002/mcp`
- 健康检查：`http://127.0.0.1:8002/healthz`
- 只读管理台：`http://127.0.0.1:8002/ui/`
- 启动脚本会把当前程序同步到 `~/Library/Application Support/MemOSLocal/runtime-app`，安装 `~/Library/LaunchAgents/com.qinshu.memos-local*.plist` 并交给 launchd 常驻托管。
- 服务运行期间使用 `caffeinate -i -s` 阻止整机因空闲进入睡眠，但不阻止显示器熄灭；锁屏和息屏不影响 MCP。手动选择“睡眠”、注销、关机或断网时服务无法继续对外响应，重新登录后会自动恢复。
- 独立看门狗每 60 秒检查 `/healthz`；启动宽限期后连续 3 次失败会要求 launchd 重启主服务。

## 透明管理台

管理台提供总览、知识库、记忆列表、Brain Pages、热记忆、检索调试、活动日志、压缩记录和模型状态九个页面。它只能读取本地数据、派生轨迹和发起检索，不提供建库、置顶、编辑、删除、手动整理、手动压缩或恢复入口。

- 新会话由 Hook 注入不超过 2500 tokens 的热事实与热地图；历史回指等强信号先通过本地路由器选择最多两个 Cube，热地图不明确时才查询 Index。
- 常规检索使用 `search_memories` 并显式指定最多两个业务 Cube；默认执行 Qdrant 向量 Top 20 + SQLite FTS5 trigram Top 20 + RRF(k=60) 混合召回。
- 只有路由不明确、定向检索无结果或用户明确要求时，才显式调用 `search_all_memories`。
- 全库检索默认使用 SiliconFlow `Qwen/Qwen3-Reranker-8B`；本机实测 4B 对当前账号返回 `Model disabled`，8B 可用。失败时会保留向量排序并标记为降级。
- 每次检索记录父子轨迹、候选分数与分阶段耗时；压缩前原文会归档在本机。
- 记忆元数据使用兼容旧记录的 Schema v3：除语义类型、主体和生命周期外，还记录 `origin_kind / root_evidence_ids / evidence_group_ids / evidence_verified`；旧记录按安全默认值读取，不会批量改写 Qdrant 原文。
- `add_memory`、`get_memory`、`update_memory`、`search_memories` 和 `search_all_memories` 是统一的类型化接口。每条返回结果额外提供规范化 `memory_view`，调用方不必解析 MemOS 内部 metadata。
- 语义类型支持 `fact / preference / profile / event / decision / constraint / goal / todo / knowledge / procedure / opinion / skill / tool / other`。`profile` 可携带结构化 `attributes` 和 `locked_fields`；修改仍被锁定的属性会被拒绝。
- `event` 必须提供有依据的 `occurred_at`，并可附带 `ended_at / location / participants`。会话提取器只从用户本人明确表达且时间可确定的内容中生成事件，不猜测时间、地点或参与者。
- 主体归属通过 `subject_type / subject_id` 表示，被谁声明及从哪个工具和会话进入通过 `asserted_by / client_id / conversation_id` 表示。多个 AI 客户端默认仍共享同一个用户真相，不自动拆成各自的主观记忆。
- 检索可使用 `semantic_types / managed_kinds / subject_types / subject_ids / statuses / occurred_from / occurred_to / include_expired` 过滤。事件、画像和流程类问题会在原有向量 + FTS5 + RRF 之上获得小幅类型加权；显式过滤始终优先。
- `memos://hot/context`、`get_hot_context`、`route_memory` 和 `set_memory_policy` 提供热上下文、只读路由及可追溯的置顶/排除/纠错策略。
- `curated-knowledge` 是 `/Users/qinshu/主知识库_AI/10_活跃知识` 与 `20_项目` 的可重建只读缓存。只有带 `knowledge_id` 治理字段的正式笔记会进入；一篇笔记对应一张短检索卡，完整证据通过 `read_curated_note(knowledge_id)` 只读回查。
- 精选缓存禁止普通新增、修改、删除和远程模型压缩。笔记新增或变化时按 `knowledge_id` 幂等更新；笔记退役、被替代或消失时保留不可检索的墓碑记录，正式 Markdown 永远是事实来源。
- 会话 Hook 每 10 轮或会话结束异步提取候选。Codex 只接受 `event_msg/user_message`，Claude 只接受非 Meta 的字符串用户消息；平台注入、助手消息和工具结果在调用模型前即被剔除。模型必须返回匹配消息 ID 的逐字引文，本地校验通过后，高置信、高保存价值且路由明确的候选才自动写入；其余仅显示在只读候选页。
- Brain Pages 位于 `/ui/graph`。原始记忆、标签和向量近邻不会直接成为节点；远程模型按小批提出候选，本地按类型与标题合并来源并整理成 `note / concept / entity / workstream` 规范页面。
- 普通页面至少需要两个独立证据组、置信度不低于 0.75、重要度不低于 0.45；同一 Codex/Claude 会话产生的多条记忆只算一组。带 `brain:pin` 的记忆可以单来源晋升，带 `brain:ignore` 或未通过来源校验的旧 `session-extracted` 记忆永不进入 Brain。
- 当前重建不发起容易超时的全局归并与关系请求；关系为空，页面仍保留完整来源证据。
- 点击 Brain Page 可以查看结构化摘要、相关页面和来源记忆；压缩删除的直接来源仍可从事务归档解析，人工删除来源会立即把相关页面标为 stale 并同步移出热快照。
- 当前快照保存在本机 `brain.sqlite3`；完整重建通过 SQLite 事务替换，失败不会覆盖上一版，成功覆盖前会保留 `.bak` 备份。
- 前端源码位于 `ui/`，构建产物由同一个 Python 服务提供，运行时不需要 Node。
- 修改前端后运行 `bin/build-dashboard.sh` 可重新安装锁定依赖、执行安全审计并生成生产构建。

## 客户端

```sh
codex mcp add memos-local --url http://127.0.0.1:8002/mcp
claude mcp add --transport http --scope user memos-local http://127.0.0.1:8002/mcp
```

Hook 与 Cursor 示例位于 `client-configs/codex-hooks.json`、`claude-hooks.json`、`cursor-hot-memory.mdc` 和 `cursor-mcp.json`。若特定 Cursor 版本无法直接连接本机 HTTP MCP，可使用 `cursor-mcp-remote-fallback.json`，但需要系统可用的 `npx`。

- Codex：`~/.codex/hooks.json` 注入热上下文，`features.hooks=true`，原生 memories 已关闭但旧文件不删除。
- Claude Code：`~/.claude/settings.json` 配置四类 Hook 并设置 `autoMemoryEnabled:false`；需要先完成 Claude Code 登录才能做真实会话验收。
- Cursor：保持 HTTP MCP，并在规则中要求每个新会话首次调用 `get_hot_context`；本机未安装 Cursor，因此当前只验证配置结构和 HTTP 接口。

## 数据与安全

- 密钥：`~/Library/Application Support/MemOSLocal/secrets.env`（权限 600）
- 数据：`~/Library/Application Support/MemOSLocal/data/.memos`
- 热快照：`hot_memory.sqlite3` 与原子文件 `hot_context.md`（权限 600）
- 全文索引：`search.sqlite3`（FTS5 是可重建派生索引，Qdrant 仍是原始真值）
- 日志：`~/Library/Application Support/MemOSLocal/logs`
- 每个 Cube 有独立的 Qdrant 目录，不会由多个客户端直接打开。
- 更换 Embedding 模型或维度后，服务会拒绝复用旧 collection，避免向量维度损坏。

验收后请在两个上游服务后台撤销本次 PoC Key，填入新 Key 后重新启动并检查状态。
