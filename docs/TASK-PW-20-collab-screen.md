# TASK-PW-20 协作台屏返工 + 集成路由（codex 执行规格）

- 状态：**已完成（2026-08-06 kimi 主会话执行 + 视觉/数据流验收通过）**
- 主需求域：内容生产
- 业务接口：提供选题候选（消费：候选卡列表/状态流转）；登记内容执行（消费：pick 路由触发 PW-19 函数）
- 数据真值源：无（纯视图 + 路由挂载；所有写操作复用 PW-18/19 已验收函数，不新写存储逻辑）
- 质量约束与验收终态：按 P01 线框稿双层布局（`docs/wayfinder/collab-harness-effect/P01-dashboard-wireframe.html`）；推主拉辅（打开即见大屏，对话贴边）；**大盘屏零改动**；`PATH="$HOME/.local/node/bin:$PATH" npm run verify` 全绿（含 frontend build）；1440×900 两层截图区块核对 + UI 数据流回归通过

## 执行环境约定（先读再写）

- 仓库根 `/Users/qinshu/Documents/papertableV1`。可改 `src/main.ts`（仅新增 4 条路由）、`frontend/src/pw/`（Collab.tsx 重写、PaperweightApp.tsx 顶栏、pw.css 增补）、`package.json`（如需登记）；**不改大盘屏组件**、不改其他 pw 模块；不 commit。
- 关键参照（动手前通读）：
  - `docs/wayfinder/collab-harness-effect/P01-dashboard-wireframe.html`：双层布局、区块、停线注记（唯一视觉依据）
  - `docs/SPEC-collab-harness-effect.md` §2/§4/§5
  - `frontend/src/pw/Collab.tsx`（PW-16 版，重写对象）、`Home.tsx`/`PaperweightApp.tsx`（顶栏协作台当前置灰 toast）、`pw.css`（--pw- token）
  - `docs/TASK-PW-FE-01-frontend-screens.md`：截图比对与 UI 回归方法（沿用）
  - `src/main.ts`：既有 sieve status/run 路由（PW-18）与 collab SSE 路由（PW-15）写法
  - `src/pw-content-bets.ts`：pick/reject/listContentBets 签名；`src/pw-sieve.ts`：listPwSieveCardsByStatus/sieveStatus

## 一、集成路由（main.ts 新增 4 条，照既有风格）

| 路由 | 执行 |
|---|---|
| GET /api/pw/sieve/cards?status=&kind= | listPwSieveCardsByStatus（默认 status=pending），按 sort_score 降序返回 |
| POST /api/pw/sieve/cards/:id/pick {overrides?} | pickPwSieveCard（409 照函数语义透传），返回新押注卡 |
| POST /api/pw/sieve/cards/:id/reject {reason?} | rejectPwSieveCard |
| GET /api/pw/content-bets | listContentBets（含联查 quote） |

（人工动作 pw_runs 留痕已在 PW-19 函数内完成，路由层不重复记。）

## 二、协作台屏（Collab.tsx 重写，两层）

### 层 1 · 今日值得看（默认落地层）

- **顶条**：品牌 + 筛子状态（`GET /api/pw/sieve/status`：last_run_at、pending_arrivals——显示「昨夜已筛 N 批 / 有新数据待筛」）；pending_arrivals>0 时显示「补筛」按钮（POST /api/pw/sieve/run）。
- **左 rail · 在途押注今日动态**：GET /api/pw/content-bets + 既有押注 API——每条显示标题 + 动态（临近看结果日/无新动静）；点击进层 2。
- **候选卡区**（正中央，grid）：pending 卡按 sort_score 降序，每卡四字段（困惑引文+来源/规模感/可演示 hook/新鲜度）+ 三按钮（挑/改/否）：
  - 挑 → pick 路由（无 overrides）→ 成功进层 2 该卡；
  - 改 → 弹出轻编辑（title/conversionSignal/reviewDate/metricTarget 四格）→ pick 带 overrides；
  - 否 → reject（可填 reason）→ 卡从列表消失；
  - 全否 → 二次确认后 POST /api/pw/sieve/run（重筛一轮）。
- **少数派区**（虚线框）：kind='wildcard' 卡单列，标注「少数派·长尾」。
- **底部对话条**：一行输入框（placeholder「就今天的大屏，问点什么……」）；提交后以**最近 pick 的内容押注卡**为上下文进层 2 右栏并发出该问题；无内容押注卡时 toast 引导先挑卡（对话按卡隔离纪律）。
- **停线可视化**：卡面不得出现「推荐」字样；卡标注「草稿」；排序依据（sort_score）卡脚可见。

### 层 2 · 单卡钻取

- **左 60%**：内容押注卡三行（演示困惑=thesis 含引文原文与来源 / 转化信号=metric+metric_target / 看结果日=checkout_date）+ 卡状态；
  - **素材区（占位）**：标注「素材草案与大纲 = 下一阶段（素材制作 run）」，本批不做存储与 AI 产出（SPEC §5.2 的候选结构/对照草案不在本批五刀内，诚实占位不造假）。
- **右 40%**：对话深挖（复用 PW-15 SSE 对话组件，POST /api/pw/collab/:betId/messages，tool 芯片、answer_delta 渲染照既有）。
- 顶部「← 返回大屏」。

### 导航

- PaperweightApp 顶栏「协作台」从置灰 toast 改为可用，落地层 1。**大盘屏与其组件零改动**。

## 三、验收

1. `PATH="$HOME/.local/node/bin:$PATH" npm run verify` 全绿（含 frontend build）。
2. 截图核对（沿用 PW-FE-01 方法）：1440×900 两层截图，逐区块对照 P01 线框稿（rail/候选卡区/少数派区/底部对话条；左三行+占位素材区/右 40% 对话）。
3. UI 数据流回归（真实库现有数据）：
   - 打开协作台**无对话即见** 2 张 pending 卡（推式成立）；
   - 挑 1 张 → 层 2 出现该内容押注卡三行、左 rail 同步；
   - 否 1 张 → 卡消失、DB status=rejected；
   - 层 2 右栏发问 → SSE 正常回话（tool 芯片出现）；
   - 回归后**把验收产生的数据还原**（新押注卡作废、卡状态还原或说明留痕）。
4. git status 确认：大盘屏组件、public/assets 手改、其他无关文件零改动。
5. 报告：文件清单、verify、截图、回归记录、与规格/P01 的偏差。

## 验收记录（2026-08-06，kimi 主会话执行）

1. ✅ 构建：`PATH="$HOME/.local/node/bin:$PATH" npm run verify` 全绿（100/100 测试 + selfcheck + tsc + vite build）。
2. ✅ 集成路由 4 条实测 200：/api/pw/sieve/cards?status=pending、/pick、/reject、/api/pw/content-bets。
3. ✅ 视觉（ego-browser 1440×900，两层截图区块核对 P01 线框稿）：
   - 层1：顶条（协作台·今日值得看 + 筛子状态）、左 rail（在途押注·今日动态）、候选卡区（证据 N badge + 草稿 tag + 四字段 + 证据强度 + 挑/改/否）、少数派·长尾虚线金框、底部对话条——无「推荐」字样；
   - 层2：返回大屏、左 60% 三行（演示困惑原文+来源/转化信号/看结果日）+ 素材区占位（标注下一阶段）、右 40% 对话深挖·按卡隔离。
4. ✅ UI 数据流回归（真实库）：打开协作台无对话即见 2 张 pending 卡（推式成立）；挑「一个人干了一个团队的活」→ 新内容押注卡并进层 2、rail 同步 2 张；否 wildcard（原因「验收回归」）→ DB rejected；层 2 发问「看结果日是哪天」→ SSE 正常回答 2026-08-13（工具芯片显示）。
5. ✅ 数据还原：回归押注卡「一个人干了一个团队的活」作废（status='void'），两卡还原 pending；pw_runs 的 pick/reject 事件保留作审计留痕。
6. ✅ 大盘屏零改动（git status 确认）。
7. 排障两则：ego-browser CDP 截图全面超时（about:blank 同挂）→ 重启 ego lite 恢复；window.prompt 在 CDP 环境卡死主帧 → reload 恢复（拒绝对话框在真实浏览器行为正常，属自动化环境时序问题）。
8. 偏差说明：改-modal 未走 UI（overrides 路径已由 PW-19 node 冒烟覆盖）；PW-21 报告的 uname 转录滑（冷→凛）在本次对话区旧消息中可见，未复现新案例，继续观察。
