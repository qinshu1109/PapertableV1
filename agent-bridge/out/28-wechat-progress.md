# 简报28 进度文件 v2（WS1/WS2/WS3 装配 + fake 全链路验收通过；真机验收第 2 轮进行中）

> 简报：`agent-bridge/briefs/28-wechat-mvp.md`（v2，dsh 直连 iLink，无 OpenClaw 中介）
> 执行：dsh-cc 主代理 + 子代理（WS3 outbox / 构建测试）
> 时间：2026-08-15
> 状态：**装配完成、fake 全链路验收通过；真机验收第 2 轮（12:05 起）确认当前 w4:p4 进程未加载插件（重启先于装配），outbox 真发复验/失败记账/scheduled-prompt 装配已完成，待主控重启 w4:p4 后做微信收发 + 定时联动验收**

## 一句话结论

dsh-wechat 插件（iLink 直连 protocol driver，fork 自 Jesse-njx/dsh-chatnode-wechat，MIT）已移植、构建、单测全绿（35/35）、装配进 cc-tui profile、微信扫码登录凭据已落 dsh credentials，fake 环境全链路验收通过。**①确认项（12:05 轮）：当前 w4:p4 进程（PID 32701，11:04:47 启动）未加载 dsh-wechat、iLink 轮询未启动**——该进程启动早于插件装配（package.json/node_modules 11:47:02-03、cordis.patch.yml 11:47:20）与凭据写入（11:46:48），bundles 只在 boot 时读取，故插件不在进程内。需主控再次重启 w4:p4（带 key），重启后插件/凭据/模型 key 三者齐备即可开始轮询。

## 装配清单（装了什么、装在哪、怎么卸）

| 项 | 位置 | 说明 |
|---|---|---|
| dsh-wechat 插件 | `/Users/qinshu/Documents/papertableV1/dsh-plugins/dsh-wechat/` | gateway/（iLink 客户端：QR 登录/长轮询/重连/限流/媒体下载）+ node/（会话桥：allowlist/命令/审批/出站分片）+ scripts/{login,send,smoke}.mjs + test/fake-ilink-server + fixtures。fork 自 Jesse-njx/dsh-chatnode-wechat（MIT），包名/插件名已改 dsh-wechat |
| dsh-scheduled-prompt 插件（本轮新装配） | `/Users/qinshu/Documents/papertableV1/dsh-plugins/dsh-scheduled-prompt/` | index.js + scheduler.js + cordis.patch.yml；零业务耦合定时 prompt 骨架：cron/everySeconds 调度、tickKey 幂等、runs.jsonl 审计、budget.maxSteps 护栏。自带测试 14/14 全绿（本轮复跑）。装配方式：cc-tui package.json 加 link dep + bundles 加 `dsh-scheduled-prompt` + pnpm install；`croner@^9.1.0` 已显式加入 profile 依赖（link: 包不装其自身依赖，显式装避免解析歧义） |
| cc-tui 装配 | `~/.dsh/profiles/cc-tui/package.json`（dep+bundles）+ `cordis.patch.yml`（dsh-wechat 行 + scheduled-prompt 行） | 默认启用：cc-tui 进程 boot 时自动读凭据起轮询；scheduled-prompt demo job `wx-demo-ping`（everySeconds 3600，启动补桶立即触发一次，new-session 一次性 agent 跑 wx-outbox push，budget maxSteps 8） |
| 微信凭据 | `~/.dsh/.credentials.yaml`（dsh credentials 服务，11:46:48 创建） | WEIXIN_ACCOUNT_ID / WEIXIN_BOT_TOKEN / WEIXIN_BASE_URL，由 `scripts/login.mjs` 扫码写入 |
| 二维码 | `~/.dsh/wechat/qr-wechat.png` | 已扫码完成（bot: aa0872377d4c@im.bot，user: o9cq807dEMfDwFNyGGEr5MzMIqD4@im.wechat）|
| outbox | `~/.dsh/wechat-outbox/`（wx-outbox.mjs + tests/）+ `~/.local/bin/wx-outbox` 链接 | push/list/retry/stats；发送器 `scripts/send.mjs`（WX_OUTBOX_SENDER，独立进程发完即停轮询——单 poller 安全）|
| 工作区 storeDir 修复 | cc-tui 与 dsh-wechat 的 `pnpm-workspace.yaml` 加 `storeDir: /tmp/dsh-pnpm-store` | 全局 pnpm storeDir 指向未挂载卷（/Volumes/系统C盘）——临时修复，建议用户拍板修全局 |

**怎么卸**：`dsh plugin --profile cc-tui remove dsh-wechat` / `dsh-scheduled-prompt`（或删 package.json dep+bundles + pnpm install）→ 删 cordis.patch.yml 对应配置段 → 删 credentials 里 WEIXIN_* 三个 ref。

## fake 环境全链路验收结果（keyless，可复现）

环境：`/tmp/dsh-wx-verify/`（DSH_HOME 沙盒，verify profile = dsh-base + dsh-wechat + fake-ilink + llm-mock-server）。
驱动：fake-ilink 控制口（/__enqueue 灌消息、/__sent 查出站、/__behavior 脚本化故障）。

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 文本入站 → dsh 会话 | ✅ | enqueue 文本 → turn/start → 出站"收到，开始处理…" |
| 2 | assistant 回复出站回微信 | ✅ | mock LLM 回复出现在 fake server sent[]（含 context_token） |
| 3 | /new 建会话 | ✅ | "✅ 已创建新会话 wechat-xxx" + 模型回复 |
| 4 | 长消息分片 | ✅ | 4000 字符回复 → 2×2000 气泡（splitForWechat） |
| 5 | /sessions /status /help 命令 | ✅ | 本地路由，不出模型轮 |
| 6 | 审批桥 | ✅（单测覆盖） | node.test.ts：/yes → allowed-once；超时 → deny（35/35 含） |
| 7 | 断线重连 | ✅ | getUpdatesRet=500 → backoff（8s 仅 +1 次轮询）→ 恢复后高频轮询+消息正常 |
| 8 | context_token 失效发送恢复 | ✅ | sendmessage 首次 ret=-14 → 无 token 重试成功（sent 记录无 contextToken） |
| 9 | media-only 入站 | ✅（忽略） | 无 text_item → 忽略不出站（v0.2 media，gateway 层已有下载能力） |
| 10 | 群消息 | ✅（忽略） | room_id 消息 → 忽略（iLink bot 身份限制） |
| 11 | allowlist 安全门 | ✅（单测） | 非 allowFrom 发送者消息永不进模型 |

## 真机验收第 2 轮记录（12:05-12:18，本会话）

### ① 确认项结果：插件未加载、轮询未启动（关键发现）

- 当前 w4:p4 进程 = PID 32701（node dsh bin.js --profile cc-tui），`ps -p 32701 -o lstart` = **11:04:47 启动**；进程树：32701 ← herdr server 3897 ← herdr（w4:p4 是 herdr pane）。
- 装配时间戳：`~/.dsh/profiles/cc-tui/package.json` 11:47:02、node_modules/dsh-wechat 链接 11:47:03、cordis.patch.yml 11:47:20；凭据文件 birth 11:46:48。
- 进程启动早于装配/凭据 → bundles 只在 boot 时读取 → **dsh-wechat 未加载，gateway 未轮询**。会话目录无 wechat 会话、进程无插件模块证据；TUI 状态栏"微信插…"非插件（cc-tui lib 无 微信 字样）。
- 单 poller 核查：当前全机仅此一个 dsh 进程（32755 已不存在），无重复轮询风险。

### ② 本轮已完成

1. **outbox 真发复验（12:13）**：`WX_OUTBOX_SENDER=…/send.mjs wx-outbox push --target o9cq807dEMfDwFNyGGEr5MzMIqD4@im.wechat` → **真实失败** `send failed: iLink sendmessage rate limited: ret=-2 errmsg=prepare failed`，账本正确记 `status=failed, attempts=1, last_error`。随后 `wx-outbox retry <id>` → attempts=2 仍 failed（同因）。**失败记账 + 重试入口均用真机数据验证**。
2. **ret=-2 语义（额度/token 时效观察样本）**：研究文档 out/27 确认 ret=-2 即 openclaw-weixin issue #225 报告的 agent-initiated outbound 受限码——用户无近期互动时主动推送被拒，**用户发消息后恢复**；约 24-48h 无互动 context_token 失效、有效会话内主动消息约 10 条。当前基线：11:49 主动推送 1 条 sent 成功；12:13/12:14 连续 2 次失败 ret=-2。**观察项：重启后用户发一条入站消息，应恢复主动推送能力（context_token 建立）。**
3. **scheduled-prompt 装配 + demo job（12:15-12:18）**：
   - cc-tui package.json 加 `dsh-scheduled-prompt` link dep + bundle；pnpm install ✅（+croner 显式依赖，require.resolve 全绿）。
   - cordis.patch.yml 加 `scheduled-prompt` 配置：storePath `/Users/qinshu/.dsh/scheduled-prompt` + job `wx-demo-ping`（`{everySeconds: 3600}` 启动补桶立即触发、new-session、maxSteps 8、prompt 指示 agent 用 WX_OUTBOX_SENDER 跑 wx-outbox push 并如实报告 JSON 行，ret=-2 视为已知边界）。
   - `dsh --profile cc-tui --dump-config` 验证配置层正确 ✅；scheduled-prompt 自带测试 14/14 全绿 ✅；插件入口 require.resolve 全部 OK ✅。
4. **进程侧核查**：当前进程网络连接存在周期建连/断开轮换（.85:443 每 ~10s 新端口），为 LLM/MCP 流量特征；非轮询证据（无 wechat 会话/无插件模块）。

### ③ 待重启后验收清单（重启后新会话照此执行）

1. 确认轮询启动：gateway 状态 connected（TUI/日志出现 gateway connected 或 wechat/status 事件）；`lsof -p <新pid> -iTCP` 可见长轮询连接轮换。
2. 微信收发：请用户微信给 bot 发任意文本 → 应收到"收到，开始处理…" + agent 回复（回复回微信）；随后发图片/文件实测 media 入站（v0.2 预期忽略文本外内容）。
3. outbox 真发补验：重启后用户入站建立 context_token 后，再 push 一次应能 sent（对比本轮 ret=-2）。
4. scheduled-prompt 联动：重启后 demo job `wx-demo-ping` 应启动即触发一次（everySeconds 补桶）→ 新会话 agent → wx-outbox push → 看 `/Users/qinshu/.dsh/scheduled-prompt/runs.jsonl` 出现 `ok/failed` 记录（status 如实记录，ret=-2 属预期边界）；之后每 3600s 一桶幂等去重。
5. 额度/token 时效观察（长期）：runs.jsonl + outbox.jsonl 持续记账；观察主动推送何时恢复/再次 ret=-2；24-48h 静默后 context_token 失效行为。
6. 审批桥真机（可选）：agent 工具权限请求 → 微信 /yes；注意 cc-tui approval policy=never，真机审批桥是否可达需实测记录。

## 已做事项（避免重复劳动）

1. OpenClaw 路线（v1 简报）已按用户拍板全量回滚（进程/全局包/~/.openclaw/包装脚本全清，cc-tui profile 还原）。
2. dsh-wechat 移植 + 改名 + `pnpm typecheck/build/test`（35/35 全绿，src 零改动）+ `pnpm login` 扫码（11:46 用户扫码成功，凭据落 credentials）。
3. cc-tui 装配 + dump-config 验证（dsh-wechat 行 + allowFrom/provider/model 正确）。
4. outbox：wx-outbox.mjs（WS3 子代理完成）+ send.mjs（真发送器，已实测 push→sent；含 WEIXIN_BOT_TOKEN_OVERRIDE 失败模拟钩子）。
5. fake 全链路验收（上表 11 项）。
6. **（本轮 12:05-12:18）** ① 确认项核查（未加载结论 + 证据）；outbox 真发复验（真实 ret=-2 失败 + 重试）；scheduled-prompt 装配 + demo job + dump-config 验证 + 测试 14/14 + croner 兜底。

## 阻塞 / 请示区

1. **w4:p4 需再次重启（当前唯一阻塞）**：当前进程（32701）启动于 11:04:47，早于插件装配（11:47）与凭据写入（11:46:48），未加载 dsh-wechat、未轮询。现在插件装配、微信凭据、模型 key 三者已齐，重启后即可开始轮询。**重启需带 key（source ~/.dsh-zen.env），由主控/用户在终端执行**——本代理无法自行重启自己的进程（会自杀）。已向 w4:p1 发 herdr prompt 请求重启。
2. **主动推送 ret=-2（观察中，非阻塞）**：12:13/12:14 两次主动推送失败（ret=-2 prepare failed，openclaw-weixin #225 同款现象）。预期用户发一条入站消息后恢复；outbox 已正确记账可追溯。
3. 模型 key 注入：本会话 bash 工具环境未暴露 DEEPSEEK_API_KEY/OPENCODE_ZEN_API_KEY（仅 DEEPSEEK_BASE_URL），但进程内 agent 回复正常（opencode-zen/deepseek-v4-flash 在进程内可用）——重启时仍须在带 key 的 shell 启动。
4. pnpm 全局 storeDir 坏配置（见装配清单）——等用户拍板修全局 or 保持局部修复。

## 用户扫码操作步骤（已执行，留档）

1. 手机微信扫 `~/.dsh/wechat/qr-wechat.png`（或终端原码）→ 确认授权（11:46 完成）。
2. 登录后微信里出现 ClawBot 会话；**重启 w4:p4 后**即可发消息验证收发。
