# 简报 47 完工：TASK-PW-73 ZCode 速记嫁接试点

## 一句话结论

飞书「琴疏的智能助手」已接到速记嫁接人格：非斜杠 p2p 文本先经 Memos 官方 API 写成 `#速记` 笔记，再只读检索旧笔记 + MemOS 回发散卡或沉默回执。本机脚本自测写读通过；真机终验留给用户。无实施阻塞。

## 四字段对照（按 TASK 执行，未改仓库代码）

| 字段 | 落地 |
|---|---|
| 主需求域 | 内容生产（笔记通路/速记入口） |
| 业务接口 | 入口=飞书 cli_aa1a → ZCode；笔记写=Memos 官方 HTTP API；记忆=MemOS 只读；4317/本仓/PW-72/relay 零改动 |
| 数据真值源 | 笔记=Memos；记忆=MemOS 只读；入口配置=`~/.zcode/v2/`（改前已备份） |
| 质量约束 | 先写后发散 / 原文摘录卡 / 沉默权 / 真机三项终验待用户 |

## 勘察：人格和 MCP 在哪

- `~/.zcode/v2/bot-config.json`：飞书 bot `enabled`、`replyMode=streaming_card`、`allowedWorkspaces=['*']`。**没有** `systemPrompt` / 人格字段，不能把契约写进这个文件（未改此文件）。
- 人格实际入口：工作区 `AGENTS.md` + `~/.zcode/skills/` + 全局 `~/.zcode/AGENTS.md`。ZCode `/init` 也认 `.zcode/AGENTS.md`。
- 工具/MCP：`~/.zcode/cli/config.json` 已挂 `memos-local` → `http://127.0.0.1:8002/mcp`（HTTP）。今日 ZCode 日志多次 `mcp.server.connected`，`toolCount=17`，工作区含 `/Users/qinshu/orca`。本机探测 initialize 成功（MOS Memory System 2.13.0.2）。**未改 MCP 配置。**
- Memos 连接：`~/Library/Application Support/Papertable/feishu-relay.json`（0600）含 `memosUrl=http://127.0.0.1:5230`、`defaultTag=速记`。本文件未备份进仓库、token 不进本文。

## 改动（仅 ZCode 配置 / skill，不动 launchd）

备份目录：`~/.zcode/v2/backups/pw-73-20260828-034313/`（`bot-config.json`、`bot-state.v2.json`、全局 `AGENTS.md`、orca `.zcode/config.json`）。

| 路径 | 作用 |
|---|---|
| `~/.zcode/skills/suji-graft/SKILL.md` | 人格契约：先写后发散 / 卡格式 / 沉默权 |
| `~/.zcode/skills/suji-graft/scripts/write_memo.py` | POST `{memosUrl}/api/v1/memos`，标签沿用 relay `defaultTag` |
| `~/.zcode/skills/suji-graft/scripts/search_memos.py` | GET `/api/v1/memos` `content.contains`，返回原文 |
| `~/.zcode/workspace/suji-graft/AGENTS.md`（及 `.zcode/AGENTS.md`） | 飞书默认工作区人格 |
| `~/.zcode/v2/bot-state.v2.json` | 飞书 bot 默认工作区改为 `suji-graft`（去掉旧 task id，逼下次新开） |
| `~/.zcode/AGENTS.md` | 在托管 MemOS 块**之前**加 PW-73 例外：本通道 MemOS 只读，笔记走 Memos API |
| `/Users/qinshu/orca/.zcode/AGENTS.md` | 飞书会话走 skill；桌面编码不当速记 |

未改：`bot-config.json`、feishu-relay、PW-72、4317、本仓库 `src/`、任何 launchd 服务。relay pid 仍 4289，backend pid 仍 50576。

## 自测（本机，非真机终验）

- `write_memo.py` stdin `PW-73 嫁接试点自测，可删` → `OK memos/kpYiytYTTFWhXXK8aRhhSv`
- `search_memos.py --query "PW-73 嫁接试点自测"` → 命中同一条，content 为原文 + `#速记`
- 空文本 → `FAIL empty_text`（exit 1）
- MemOS MCP initialize HTTP 200

用户可在 Memos 里删掉 `memos/kpYiytYTTFWhXXK8aRhhSv`。

## 真机终验（留给用户）

手机飞书给「琴疏的智能助手」发一条测试速记，三项齐才算 TASK 过：

1. Memos 出现该条（`#速记`）
2. 同一聊天收到发散卡或「记下了，没捞到相关的」
3. 写失败时必须明说「没写成」，不能装已写

若下一条仍像编程助手：飞书发 `/新建`，或 `/项目` 切到 `~/.zcode/workspace/suji-graft`。未重启 ZCode.app（红线只禁 launchd）。

## 有无阻塞

实施无阻塞。终验待用户真机。
