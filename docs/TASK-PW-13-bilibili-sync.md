# TASK-PW-13 B站数据源低频同步（P1 首战）

- 状态：进行中
- 主需求域：实践与数据回收
- 业务接口：回流数据文档（实践与数据回收 → 判断沉淀与复用）
- 数据真值源：pw_connections（新表）、pw_data_docs（method 扩展 sync）、pw_runs（kind=sync 事件）
- 质量约束与验收终态：五条军规（AI 不碰 cookie 本体；只读操作；验证码/登录墙一律暂停交人；仅自己账号稿件；低频每天 1 次）；`npm run verify` 全绿；数据源屏 1440×900 对照 `papertable-sources.html` 一比一；真实执行一次同步脚本端到端跑通（连接状态、事件留痕、文档落库正确）；否定验收不变（无看板/日历/甘特）

## 范围

P1 只做 B站，其余四平台（小红书/抖音/YouTube/X）界面置灰「未开通」。

### 已知事实（2026-08-04 实测，ego-browser task space 19）

- 用户 B站登录态有效（创作中心可用，账号注册 2396 天）。
- 当前账号**全部稿件 0**——今日同步跑通的路径是「0 匹配」事件留痕；真实数字要等用户发布首期视频。
- 数据中心为 iframe：`https://member.bilibili.com/york/data-center-web`，含「数据概览 / 稿件分析 / 导出数据」；内容管理在 `https://member.bilibili.com/platform/upload-manager/article`。
- 演示产出物 URL（`https://b23.tv/ep1`）是占位假链接，不能用于抽取校验。

### 后端（src/，同进程同库纪律）

1. 迁移：`pw_connections`（PRD 已定义）：id, platform, account_label, auth_ref, status(active/needs_human/paused), last_sync_at, risk_events_json, created_at。表内永不存 cookie 本体（auth_ref 恒 null，迁移与代码注释写明纪律）。
2. API：
   - `GET /api/pw/connections` → 连接列表 + 每平台 sync 文档数。
   - `POST /api/pw/connections` {platform, accountLabel} → 登记连接（同 platform 幂等返回既有）。
   - `POST /api/pw/connections/:id/status` {status, reason?} → 人工恢复 active / 暂停；needs_human 转变写入 risk_events。
   - `POST /api/pw/sync/bilibili` {items: [{artifactId, metrics, rawRef?}]} → 逐条校验 artifact 存在且 platform=B站，落 pw_data_docs（method='sync'，bet_id 取 artifact.bet_id，version 按 artifact 递增，只增不改），每条写 pw_runs（kind='sync', event_type='data_doc', actor='system'）；更新 last_sync_at。返回 {created, errors}。
   - `GET /api/pw/data-docs` → 全量数据文档（join artifact 标题、bet 标题），collected_at 倒序，供数据源屏表格。
3. 测试：连接登记幂等、状态机与 risk_events 留痕、sync 落库（version 递增、错误 artifact 拒绝）、cookie 字段恒 null 断言。

### 同步执行器（scripts/pw-sync-bilibili.js）

ego-browser 脚本（`ego-browser nodejs < scripts/pw-sync-bilibili.js`，或加文件参数运行）：

1. 读 `GET /api/pw/connections` 与 B站已挂载产出物（platform=B站、url 可解析 BV、detached_at 为空）。
2. 打开创作中心内容管理；检测登录墙/验证页 → `POST status needs_human` 并退出（军规：交人）。
3. 读自己的稿件列表（BV、标题）；逐 artifact 按 BV 匹配；匹配不到记 skipped。
4. 对匹配稿件打开数据中心稿件分析视图，读 播放/点赞/评论/弹幕/收藏/投币/分享（选择器按当日 DOM 实测，0 稿件时走空路径）。
5. `POST /api/pw/sync/bilibili`；打印 created/skipped 摘要。
6. 频率纪律：每天最多 1 次，由会话 cron 或手动触发；脚本不内置循环。

### 前端（frontend/src/pw/，一比一 papertable-sources.html）

- `Sources.tsx` 新屏：左栏卡片树（与押注台同源，条目点击跳押注台）+ 数据源入口条（is-current，needs_human>0 时未读点与「N 条待人工处理」）；主区：page-head → 待人工处理纸签（仅 needs_human 时出现，按钮「打开浏览器接手」→ 恢复 active + toast 指引去 ego lite 完成验证）→ 平台连接五卡（B站三态真实：未连接/已连接·登录态有效/需人工验证，未连接给「连接账号」弹层；其余四平台 s-off 置灰「未开通 · 本期只做 B站」）→ 说明纸带（照抄同步方式纪律文案）→ 回流数据文档表（全量文档：平台 chip、内容=artifact/bet 标题、关键数据前三项加粗、时间、右列「已回流 · 可引用」/冻结标「已冻结」）。
- 导航解锁：PaperweightApp 数据源项启用；Home 数据源卡可点（状态：未连接/已连接/N 条待人工处理）；押注台侧栏数据源入口条改为跳数据源屏（不再 toast P1）。
- 新增样式进 pw.css（queue-slip/platform-card/doc-list/note-strip，token 沿用）。

### 触发与闸门

- 每日触发：本会话 cron（交付时创建，会话存活期间有效）或用户手动跑脚本；P1 闸门（连续 14 天每日成功且零风控挑战）自**用户发布首期视频、同步产生真实数据**起计。

## 不做

- 其余四平台接入、官方 API 实测（PRD 开放问题 6）、完播率/留存等创作中心独有字段的抽取校验（等首期真实视频）、web 端「立即同步」按钮（浏览器驱动在用户侧 CLI，web 不假装能触发）、后台导出 Excel 通路（DOM 抽取已够用，需要时再补）。

## 验收

1. `PATH="$HOME/.local/node/bin:$PATH" npm run verify` 全绿（含新增后端测试）。
2. 数据源屏 1440×900 截图对照设计稿：结构/配色/纸签/平台卡/文档表一致；Home 与押注台入口同步解锁。
3. 端到端：登记 B站连接 → 跑同步脚本（今日 0 稿件 → 0 created + 事件留痕 + last_sync_at 更新）→ 数据源屏可见连接状态与最近同步时间；手动把连接置 needs_human 验证纸签出现与恢复流。
4. 军规核对：脚本与后端无任何 cookie 读取/存储；遇验证只置状态不尝试破解。

## 验收记录（2026-08-04）

1. ✅ 构建：`npm run verify` 全绿（55 个后端测试含新增 4 组 pw-connections、selfcheck、tsc、vite build）。
2. ✅ 视觉：数据源屏 1440×900 截图对照设计稿——侧栏卡片树+数据源入口（is-current/未读点）、待人工处理黄色纸签、五平台卡（B站真实三态、其余置灰）、说明纸带、回流数据文档表全部一致；Home 数据源卡解锁显示「已连接」，押注台侧栏入口跳数据源屏（实测跳转成功）。
3. ✅ 端到端：UI「连接账号」登记 B站连接（琴疏的B站）→ 跑同步脚本：登录态检测过、archives 接口读自有稿件 0 个、演示产出物（假 b23 链接）正确 skipped、0 created + last_sync_at 刷新；同日重跑触发低频跳过；needs_human 模拟置位后纸签出现、点「打开浏览器接手」恢复 active 且 risk_events 留痕。
4. ✅ 军规核对：脚本与后端无 cookie 读写；连接登记弹层明示「登录态留在你的 ego lite 浏览器里，镇纸不碰 cookie 本体」；验证只置 needs_human 不破解。
5. 实现中修正：自有稿件列表从「全页面 BV 正则扫描」改为创作中心同源 JSON 接口 `x/web/archives`（DOM 扫描会把推荐视频误当自有稿件，违反「仅自己账号」）；回流文档表过滤作废押注的文档；`GET /api/pw/data-docs` 加 `WHERE status != 'void'`。
6. 待复核（写进脚本头注释）：用户发布首期真实视频后需复核 extractMetrics 选择器与 bvid 直达稿件分析的取数路径；P1 闸门（14 天连续成功且零风控）自真实数据产生起计。
7. 每日触发：会话 cron `c84b0129`（每天 06:47 本地）跑同步脚本并简报；会话不在线时当天跳过，需手动 `ego-browser nodejs < scripts/pw-sync-bilibili.js`。
