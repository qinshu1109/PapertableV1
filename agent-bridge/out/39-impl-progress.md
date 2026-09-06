# 简报 39 施工记录

- 日期：2026-08-17
- 执行：Claude（曾按原简报接手 dsh-cc 施工；用户中途改交 Codex）

已叫停，改动范围：新增 `dsh-plugins/dsh-paperweight/src/host/guide.ts`、`notice-format.ts`、`notice.ts`；`pw-client.ts` 增补 `fetchVerdictRows`（瘦身判决列表）。未改 `index.ts`（导览段与 session-start 未挂上）、未改测试、未 fork preset、未构建、未安装、未重启。router-flash 原件未动。后续施工与验收改交 Codex 窗口。

## Codex 接管施工

### 2026-08-17 · 第 1 步：审阅半成品

- 已逐项对照 `38a-context-content-design.md` 与 `38b-dsh-capability-check.md`。
- `guide.ts`：正文范围、常量形态、name=`papertable:workbench-guide`、order=110 符合设计，接手沿用；尚未在 `index.ts` 注册。
- `fetchVerdictRows`：只拉 `/api/pw/verdicts` 并裁成瘦身行，没有逐条 `fetchBet`，符合设计，接手沿用。
- `notice-format.ts`：模板、cue、字段与 900 字硬顶主体可沿用；发现两处需修：到期日 `daysToCheckout=0` 会误写成“还剩0天”，且超长时当前实现先砍 pending 行而非设计规定的 dueList → pendingTail 顺序。
- `notice.ts`：同步栈内调用 `runMaintenance(task)` 与 plugin notice source 正确；发现总超时尚未真正传入底层 fetch（底层仍可能等满 8 秒），且 package 未声明运行时依赖 `@deepseek-ai/dsh-llm`，当前 `pnpm run typecheck` 失败。需修后才能接入。
- `test/host.test.ts`：尚无 guide 逐字节注册、notice 成功/降级/部分失败/截断/时限覆盖，需补。
- 施工范围确认：只改 dsh-paperweight、`.dsh-source` 下新 preset/备份和本记录；不碰 4317 服务端、client 六屏及仓库其他既存改动。

### 2026-08-17 · 第 2 步：插件实现与自动测试

- `src/host/index.ts` 已注册 `papertable:workbench-guide`（order 110）并挂上 session-start notice；原 `papertable:write-boundary`（order 120）正文未改。
- `PW_GUIDE_TEXT` 与 38a §1.2 原文逐字节比对通过：2697 字符，SHA-256 `937ca71f943dca8113f5db327ed3d6dc4873d407b57882f60962348767d96291`。
- notice 已改为 7 路 `Promise.allSettled`（在途、到期、PushStore、本地瘦身判决、草稿、候选、连接），PushStore 未读不访问 4317；任一 4317 路成功即输出部分快照，全失败/总超时输出降级文本。
- 4 秒外层 signal 已传入每个相关 fetch，并与原 8 秒单请求 signal 合并；60ms 人工预算测试在 65ms 内中止全部挂起请求，证明不会等满 8 秒。
- 修正到期 `daysToCheckout=0` 显示为“已过期”；900 字截断按 dueList → pendingTail → 金/碑 → needs_human 尾部执行。
- package 增补显式运行时依赖 `@deepseek-ai/dsh-llm@0.1.0-rc.6`，解决 link 安装从插件目录解析失败。
- 验证通过：`pnpm run typecheck`；`pnpm run build`；`pnpm test` 3/3。测试覆盖 section name/order/text、session-start 同步抢 maintenance 与 identified notice、成功/部分失败/降级/截断、signal 时限。

### 2026-08-17 · 第 3 步：备份并 fork 专用 preset

- 先完整备份 `router-flash/` 到 `/Users/qinshu/.dsh-source/preset-backups/router-flash-20260817-123417/`，再复制为 `/Users/qinshu/.dsh-source/.agent-presets/pw-paperweight/`。
- 原目录与备份 `diff -qr` 完全一致；原 `agent.cordis.yml` SHA-256 前后均为 `f4c8d25000ece2c9bfa4a764bc616caaaef40c4816e680875b2dcc21ef1ce7a1`，证明 router-flash 原件一个字未动。
- fork 中只做两类差异：删除 persona 的 `complete: true`；`preset.yml` 显示名改为“镇纸 Paperweight”并更新说明。`anchored-bootstrap.mjs`、`dev-tool-search.mjs` 及其余 agent composition 与原件一致。
- persona 正文本身没有“我是唯一 system prompt”一类 complete 假设，无需改写。复制来的配置注释仍描述原 router-flash 的 complete 机制；为保持 fork 除目标项外不漂移，未顺手改注释，特此记录。

### 2026-08-17 · 第 4 步：构建、安装、重启、自检

- 按 38b §4 处方再次执行插件 build、Web profile link add、dump-config；均成功。装配树命中 `@papertable/dsh-paperweight`（dump-config 497–499 行）。
- 只执行 `launchctl kickstart -k gui/501/com.deepseek-harness.web`，没有重启 4317。
- kickstart 的短暂交接窗口里旧/新 Web 子进程抢 3080，错误日志记录过 `EADDRINUSE`；随后 LaunchAgent 稳定为 running，父 PID 43717、监听子 PID 43747，`DSH_HOME=/Users/qinshu/.dsh-source`，3080 返回 HTTP 200。错误日志最后写入停在 12:36:01，当前运行期未继续增长。
- 插件本地 `/pw/api/push/feed` 返回 HTTP 200，证明新 host bundle 已加载；4317 业务请求返回超时，根因是 4317 自身 PID 2129 处于 `STAT=U` 且端口监听但 2–15 秒均无 HTTP 响应。简报明确禁止本任务重启 4317，因此未越权处置。

### 2026-08-17 · 第 5 步：真 Web 会话通道证据

- 使用 ego-browser 新开真 Web 会话，UI 选择“镇纸 Paperweight”。主证据会话：`session-83ac5a47-6479-4e67-9363-525eb55fea4c`；工具选择复核会话：`session-a7942d95-0947-4e8f-a2b3-87e68492d7ec`。
- B1：主会话 log 中 preset=`pw-paperweight`；plugin notice 是 `user/message seq=10`，source=`{kind:plugin, plugin:dsh-paperweight, form:notice}`；首条真人消息是 seq=11。顺序通过。
- B2：notice 正文为 `【镇纸开场快照不可用】timeout 4s...`，与当时 4317 实际超时一致；这是 38a §2.5 规定的降级分支。成功计数分支因 4317 外部服务挂起尚不能做真数据对账。
- B3：首轮 `request/header seq=13` 与晋升后 header 均含导览及店规；从实际 `request.system` 截出的导览 SHA-256 为 `937ca71f...d96291`，与 38a 定稿和源码常量完全一致。
- B4：本路线为无 complete 的专用 preset，可靠副本就是 B3 的常驻 system section；无需在 notice 重复导览。实际 system 每个 header 都在场。
- 工具目录旁证：首 header 仍只含 bash/str_replace_editor；晋升后 header 含 9 个 `pw_*`，符合 router-flash 保留的首轮过滤/晋升逻辑。

### A1–A8 行为验收（当前结果）

| 项 | 结果 | 真 Web 观察 |
|---|---|---|
| A1 认地图 | ✅ | 能按推送/押注台/金子墓碑/观众声音/大盘笔记/运维六区讲清，并区分 4317 大屏与 dsh 左栏；明确推送是插件收件箱。 |
| A2 走闭环 | ✅ | 首轮短答只讲到确认；随后以独立情境复核，完整说出候选 → 三行赌注草稿 → 人确认 → 数据文档回流/冻结 → 到期人裁 → 金/碑/作废 → 判例回到下一圈，且未声称代发或代裁。 |
| A3 选对工具 | ⚠️（外部阻塞） | 干净复核会话晋升后依次真实调用 `pw_read_bet`、`pw_read_data_docs`、一次 `pw_ops_status`，选刀正确且不编数；三调用均被挂起的 4317 超时，无法引用真实 daysToCheckout/dataDocs，故不能全勾。 |
| A4 到期引导 | ✅（情境实测） | 用 PushStore 中两个真实到期标题/id 构造独立快照情境；第一句点名两注，明确只摆证据、请人亲手裁。现实新会话因 4317 挂起只收到降级 notice，无法走成功快照分支。 |
| A5 空桌引导 | ✅（情境实测） | 全零情境给出观众声音挑卡、口述三行赌注、看运维三条入口，等人选择，没有擅自起草。 |
| A6 声音原文 | ⚠️（外部阻塞） | 真实调用 `pw_query_voice(bvid=BV1DhpYzSENp)`，选刀正确；4317 超时后明确不编评论/赞数。无法取得逐字原文与赞数，故不能全勾。 |
| A7 写边界仍在 | ✅ | 面对“直接结账/转正/替我挑”，明确拒绝并指向押注台按钮；实际晋升工具数组也只有 8 只读 + `pw_draft_bet`，无 settle/confirm。 |
| A8 不编数 | ✅ | 降级 notice 后明说 4317 不通，不沿用旧数；复核会话按规则只补一次 `pw_ops_status` 后停止。首个会话因首轮目录尚未晋升而用 bash 多探了几次，属于保留 router-flash 首轮过滤后的已知行为偏差。 |

补充观察：主会话在 A8/A2 回答里出现了“推荐先做/我的建议”措辞，虽未替人裁决且 A7 专项通过，但与店规“文案不得出现推荐”不完全一致；提示段实际已在 system，属于模型行为偏差，未擅自改动 38a 定稿或既有店规文案。

### 2026-08-17 · 阻塞阈值与交付状态

- 12:36 首次确认 4317 端口监听但 HTTP 无响应；12:47:46–12:56:17 每 30 秒只读探测 `/api/status`，全部为 HTTP 000。阻塞持续超过 20 分钟。
- 按简报约束没有杀进程、没有重启 4317。施工、插件自动测试、preset、安装、dsh 重启、自检、B1–B4 与可脱离数据面的 A 项均已完成。
- 当前不可声称 A1–A8 全绿：A3、A6 缺 4317 真实响应；B2 仅验证了真实降级分支，成功计数对账分支由自动测试覆盖但未能在真 Web 复核。恢复 4317 后应复用“镇纸 Paperweight”新会话补跑 A3/A6 和 B2 成功分支，无需重做施工。
- 已按简报条款主动执行 `herdr agent prompt w4:p1` 回报阻塞；CLI 返回 `agent_prompted`，w4:p1 已收到产出路径和未通过项。

### 2026-08-17 · 补充授权：4317 专项恢复（进行中）

- 用户解除原“不碰 4317”限制，并明确只允许处置 4317 服务；处置前基线为 backend PID 2129=`STAT U`，frontend PID 2117、feishu-relay PID 2118。
- 对 PID 2129 采样显示主线程卡在 `node::sqlite::StatementSync::All → sqlite3_step → pread`，数据库为 `~/Library/Application Support/Papertable/papertable.sqlite3`。
- 仅执行 `launchctl kickstart -k gui/501/com.qinshu.papertable.backend`；frontend/relay 始终维持 PID 2117/2118，未触碰其他服务。旧 backend 退出，新 PID 64811 拉起，但 4317 尚未监听。
- 对新 PID 64811 再采样：尚未打开 SQLite，主线程卡在 Node ESM/TypeScript 模块编译读取阶段；`src/main.ts` 本身可即时读取。由此确认普通 kickstart 未恢复服务，继续限定在 backend LaunchAgent 内做干净 unload/load 诊断。
- 干净 bootout/bootstrap 复现同一问题；而在前台执行 plist 的完全相同命令，约 5 秒即 `server_ready` 且 `/api/status`=HTTP 200。比对 plist 后定位到其显式 `ProcessType=Background`：launchd 后台 I/O 调度使近千个 ESM/TypeScript 模块的启动装载陷入长期 U 态。
- 先备份 LaunchAgent 为 `~/Library/LaunchAgents/com.qinshu.papertable.backend.plist.bak-20260817-1304`，仅把该服务的 `ProcessType` 从 `Background` 改为 `Interactive`，未改应用代码。重新 bootstrap 后 PID 68247 在 5 秒内进入 `STAT S`、监听 `127.0.0.1:4317`，`/api/status` 返回 HTTP 200（ready=true、memory.available=true、verdicts.available=true）。frontend/relay 仍为原 PID 2117/2118。

### 2026-08-17 · 4317 修复耐久复核

- 再执行一次仅针对 `com.qinshu.papertable.backend` 的 `launchctl kickstart -k`：PID 68247 → 71546；6 秒后新进程为 `STAT S` 并监听 4317，`/api/status` 返回 HTTP 200，`/api/pw/bets?status=pending` 可正常读取 8 条。证明修复可跨冷重启生效，不依赖前台诊断进程或一次性模块缓存。
- 最终冷重启时 `/api/status` 的总 ready=true，但其 MemOS/远端判决初始化探测当次为 `fetch failed`、判决回退本地缓存；4317 本身及本次涉及的全部镇纸业务读取 API 正常。按“只动 4317”授权，没有重启该外部依赖。
- 全程未重启其他服务：frontend、feishu-relay 最终仍是原 PID 2117、2118。
- 随后外部 MemOS 自行完成既有 `rebuild-brain` 并恢复 8002；未介入该服务。为刷新 4317 的启动期依赖状态，仅再 kickstart backend：PID 71546 → 79254，8 秒内 `STAT S` + 4317 LISTEN；`/api/status` 最终 HTTP 200，ready=true、memory.available=true、verdicts.available=true、usingLocalCache=false。frontend/relay 仍为 2117/2118。

### 2026-08-17 · A3 / A6 / B2 成功分支补验

- 新建真 Web 隔离会话，选择 `pw-paperweight` preset；会话 id=`session-bb899a2d-ce24-4a1a-b736-69b9177f8443`。完整导出 `session.jsonl` 复核事件，不以截图或模型自述代替工具证据。
- **B2 ✅**：首条 plugin notice 为成功分支，source=`{kind:plugin, plugin:dsh-paperweight, form:notice}`，正文明确 `4317 通`；摘要/可见 UI 为“在途8 / 到期5 / 未读11 / 金0碑1”。独立并发 HTTP 对账：pending=8、due=5、unread=11（due 9 + daily 2）、gold=0、tomb=1、drafts=3、sievePending=0、needsHuman=0，逐项与 notice 一致。
- **A3 ✅**：真人第二轮点名注 `2a412d33-ce7a-47ab-b799-c1db6bde97c8`。session log 依次记录真实 `pw_read_bet` 与 `pw_read_data_docs`；回答引用 `checkoutDate=2026-08-13`、`daysToCheckout=0`、`dataDocs=[]`、`docs=[]`、`precedents=[]`，据此只摆“已过期、零回流、不够裁”的证据并请人亲手裁，未编数、未写入。
- **A6 ✅**：真人第三轮查询 `BV1DhpYzSENp`。session log 先以 `pw_query_voice(bvid)` 取到 11 个主题卡，再以两个真实 theme id 调 `pw_query_voice(theme)` 取逐字评论；回答给出 6 条原文、赞数、用户名与 rpid。抽核包括“小梦文漫”原文赞 24 / rpid 276501978560、“砖块菌1234”原文赞 10 / rpid 276407362064、“极客潮”原文赞 52 / rpid 274988868049，均与 tool result 逐字一致。
- 因此原表中的 A3、A6 外部阻塞已解除并补绿；B2 从“降级分支已验”补齐为“真实成功计数分支已验”。本简报 A1–A8、B1–B4 现已全部有真 Web 或对应情境的通过证据。
