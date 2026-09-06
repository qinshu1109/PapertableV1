# 简报 37：镇纸六屏 dsh 插件 —— 一次性全量施工

日期：2026-08-16 ｜ 主控：kimi（herdr w4:p1）｜ 类型：施工（前后端并行 + 验收）

## 这件事是干什么的

把镇纸 Paperweight 的六个屏——押注台、金子墓碑库、协作台、观众声音、运维数据源、大盘笔记——做成**一个 dsh 插件包** `dsh-paperweight`，一次性全部实现，不分期。做完后：人在 dsh（含手机域名访问）一个窗口里，左栏有独立「镇纸」区，能看在途押注、查金子墓碑、翻观众声音、读运维状态、收每日推送和到期提醒，聊天里 @押注卡 就能让 AI 看着镇纸真数据协作。业务全貌见 `briefs/36-pw-dsh-plugin-plan-v1.md`（先读它），技术依据见 `out/35a-dsh-plugin-tech-map.md`（含全部扩展点源码证据，必读）和 `out/35b-pw-dsh-product-mapping.md`。

## 铁律（违反即返工）

1. **数据只走 `http://127.0.0.1:4317` HTTP API**，禁止直连 SQLite 文件。4317 路由面（约 68 条）以 `papertableV1/src/main.ts` 为准。
2. **写路径只有两类**：①AI 起草类落 draft（走 4317 既有 draft API）；②界面上**人亲手点的**按钮直连 4317（挑/改/否、确认转正——这是"人在 dsh 界面操作镇纸"，decided_by=human 由 4317/DB 约束兜底）。**禁止给 AI 注册任何 settle/confirm/verdict 类工具 schema**——验收要查工具数组。
3. **AI 摆证据不给结论**：卡面/文案永不出"推荐"字样；排序依据印在卡上可复核。
4. **Memos 只读**；数据文档只增不改。
5. **纸感浅色**：pw.css token（纸底 #f1ebdf、卡片 #fbf7ec、墨 #2e2a24、墨绿 #3f6e5a、圆角 10px、Noto Sans SC），禁深色数据板。参考 `papertableV1` 的 pw.css。
6. **推送产物（每日值得看/分析结果/到期提醒）进左栏独立「镇纸」区，带未读标记，禁止以新会话形式混进对话列表**（用户明令，参照 Oil Creator 会话/内容双 tab）。
7. **永不做**：AI 裁决工具、dsh 侧第二份数据副本/缓存镜像表、深色板、看板/日历/甘特。
8. 角色/店规"卡定义"机制**不做**（用户后置）。店规纪律以插件内普通 systemPrompt/skill 文本携带，文本以镇纸 SPEC-harness-write-boundary 为准，不许变松。
9. 通知不绕微信（手机已能域名直连 dsh）。

## 包形态与分工界面

**一个包**：`papertableV1/dsh-plugins/dsh-paperweight/`，双半结构（参照 `dsh-plugins/dsh-wechat` 的 host 半 + `~/.dsh-source/profiles/web/node_modules/@dsh-external/dsh-mobile-nav` 的 client 声明方式）：

```
dsh-paperweight/
  package.json          # main=lib/index.js(host半) exports["./client"]=lib/client.js  dsh.client 声明
  cordis.patch.yml
  src/
    types.ts            # 【契约】共享类型 + API 路由表 —— dsh-cc 先写，Claude 只消费
    host/               # dsh-cc 负责：node 半（工具、webServer 路由、定时推送）
    client/             # Claude 负责：browser 半（slots、面板、样式）
```

**前后端契约（都写进 types.ts，双方不得私改；要改在 out/37-contract-changes.md 留痕并回报）**：

- host 半经 `ctx.webServer.register` 开同源 API，统一前缀 `/pw/api/*`：内部只 fetch `127.0.0.1:4317` 对应路由，做轻量裁剪，不建缓存。
- 最小路由集（Claude 的 client 只准调这些）：
  - `GET /pw/api/bets` / `GET /pw/api/bets/:id`（押注列表/单卡装配：赌注、置信度、距结账天数、数据文档摘要、相关判例）
  - `GET /pw/api/verdicts` / `GET /pw/api/verdicts/:id/evidence`（金/碑+证据）
  - `GET /pw/api/voice/themes` / `GET /pw/api/voice/items?theme=`（观众声音分桶+逐字）
  - `GET /pw/api/notes/today` / `GET /pw/api/notes/tree`（大盘笔记）
  - `GET /pw/api/ops/status`（运维数据源）
  - `GET /pw/api/push/feed` + `POST /pw/api/push/mark-read`（推送区：每日值得看+提醒，未读标记）
  - 写（仅两类）：`POST /pw/api/draft/bet`（AI 起草，落 draft）；`POST /pw/api/action`（人点按钮：挑/改/否/确认，host 侧记录操作来源=human-click 再转发 4317）
- agent 工具（host 半 `ctx.tools.register`，**全部只读**）：`pw_list_bets` / `pw_read_bet` / `pw_read_data_docs` / `pw_search_verdicts` / `pw_read_verdict_evidence` / `pw_query_voice` / `pw_recall_notes` / `pw_ops_status` + 唯一起草工具 `pw_draft_bet`（落 draft，返回 draft_hash）。
- `@押注卡` 引用：`ctx.inputTriggers.registerSource`，返回装配 Markdown（ codec.serialize 路径见 35a §3.4）；`/bets` 斜杠命令列在途。
- 定时推送：host 半 setInterval（照 main.ts note-rollup 模式）每日生成「今日值得看」写入 push feed（4317 既有数据源组装），到期待裁决/needs_human 生成提醒条目。

## 分工

### dsh-cc（w4:p9）—— 后端（host 半）

1. `src/types.ts` 契约（先写，写完立刻在 out/37-progress-a.md 喊一声"契约已定"，Claude 据此开工，不用等）
2. `src/host/`：4317 fetch 层 + `/pw/api/*` webServer 路由 + 八只读工具 + `pw_draft_bet` + `/pw/api/action` 人按钮转发 + 定时推送生成器
3. `package.json`/`cordis.patch.yml` 骨架（dsh.client 声明留给 Claude 补 client 入口也行，协商好写进契约）
4. 产出：可独立 `node --test` 或最小脚本验证的路由冒烟（起在别的端口自测，不占 3080）

### Claude（w4:pB）—— 前端（client 半）+ 兜底验收审查

1. 等 types.ts 契约后写 `src/client/`：
   - 左栏「镇纸」tab（`ctx.slots.register` → `sidebar.workspaces`；**inject 声明、dsh.client 声明、勿注册 root**——35a §6.3 三坑必读）
   - 押注列表/单卡详情、金碑页（可降级为检索列表）、观众声音摆盘（分桶+逐字展开）、大盘笔记树、运维状态卡、推送区（未读标记）
   - 人点按钮（挑/改/否/确认）→ `POST /pw/api/action`
   - 纸感浅色样式（pw.css token）
2. 联调：插件 `link:` 装进 `~/.dsh-source/profiles/web`（**必须带 `DSH_HOME=/Users/qinshu/.dsh-source`**），`launchctl kickstart -k gui/$(id -u)/com.deepseek-harness.web` 重启，页面验证。**注意 launchd 重启后 web 需约 10 秒才起来，curl 000 等几秒再试**
3. 兜底验收审查（自验 + 复核 dsh-cc 后端）：按下节验收标准逐项过，出 `out/37-acceptance.md`（成绩单格式：每项 过/不过 + 证据）

## 验收标准（全过才算完）

1. dsh 会话 @真实押注卡，问"这注离结账几天、回流数据够不够裁"，AI 引用真实数据文档与判例答出，判例可点开复核，全程未手工投喂
2. 会话请求日志里 AI 工具数组**不含任何 settle/confirm/verdict 写 schema**（dsh-proposal-gate 同款验证法）
3. 六屏内容在 dsh 左栏「镇纸」区全部可见可读，数字与 4317 大屏一致（押注数、判决数、最新数据文档三处对得上）
4. 推送区有「今日值得看」且带未读标记；对话列表里**没有**推送产生的会话
5. 人点一次"挑"或"否"，4317 侧状态变更且 decided_by=human；`pw_draft_bet` 起草一笔，draft 落库带 draft_hash，正式区不可见
6. 全部界面纸感浅色，无深色数据板，无"推荐"字样
7. 手机浏览器（dsh.cozai.net）打开「镇纸」区可用（dsh-mobile-nav 已装，抽屉形态正常）
8. 插件在设置 → 插件市场（plugin-market）里可见、状态正常

## 通用纪律

- 进度写 `out/37-progress-a.md`（dsh-cc）/ `out/37-progress-b.md`（Claude），卡住先写进度再继续
- 前后端冲突只许改自己侧；契约变更写 `out/37-contract-changes.md` 并回报
- **完工必须主动回报**：`herdr agent prompt w4:p1 "简报37 完工：<后端/前端+验收>：一句话结论 + 产出路径 + 有无阻塞"`（agent_not_found 就先 `herdr pane list` 核 kimi 窗格号）
- 禁止"写完不用找我"

## 附：跨窗横向通知通道（2026-08-16 主控补）

dsh-cc（w4:p9）是 dsh TUI 终端，**不是 herdr 管理的 agent**，`herdr agent prompt w4:p9` 必报 `agent_not_found`，别用。Claude 要通知 dsh-cc（催契约、对齐 types.ts、喊联调）走这条：

```sh
~/.local/bin/herdr-cc-prompt w4:p9 "你的消息"   # 文本进它的聊天输入框
herdr pane send-keys w4:p9 enter                # 补回车提交（pane run 可能只进输入框不发送）
herdr pane read w4:p9 --source recent-unwrapped --lines 40   # 回读确认消息被消费才算送达
```

注意：①窗格号会变，投递前 `herdr pane list` 按 label `dsh-tui` 核；②若 dsh-cc 正在跑长回合，先 `herdr pane send-keys w4:p9 escape` 打断再投，排队消息会立即送达；③禁止 TIOCSTI 注入和 AppleScript 击键旁路。反向（dsh-cc→Claude w4:pB）用 `herdr agent prompt w4:pB "..."`，Claude 是 herdr 识别的 agent。
