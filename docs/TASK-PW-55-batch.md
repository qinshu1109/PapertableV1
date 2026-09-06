# TASK-PW-55 批次：大盘可视化开张 + 回流自动记账

- 日期：2026-08-10
- 状态：已拍板（2026-08-10，用户「那就A 为主、顺带做 B」）
- 依据：大盘占位区根因排查（趋势有效数据点仅 1 个：3 条数据文档 2 条属作废押注被过滤；校准线需 5 次带把握结账现仅 1 次；趋势折线跨押注连线无业务意义）

## 这批次是干什么的（白话）

大盘两块"等数据"的占位区，今天换成现在就有用的图；顺手把数据源的根也养上。

1. **数据趋势区**（PW-55A 前端）：趋势折线改成**按押注分组**——同一张押注回流两期数据才画一条线（BET-01 一条、BET-03 一条，各走各的，不再把不同视频硬连成一条）。现在没有押注够两期，所以该区先换成「**结账倒计时**」：每张在途押注一条横杠，还剩几天到期一眼看清（你 3 天后有 3 张到期）。
2. **判断力账本区**（PW-55A 前端）：校准线继续等样本（它需要 5 次结账，急不来），等待期间占位换成「**本周动作流水**」：最近 7 天，你、AI、系统每天各干了多少事，迷你柱图一眼对照。样本够了自动换回校准线，不用你管。
3. **回流自动记账**（PW-55B 后端）：以后挂到押注上的 B站视频，做 B站抓取/同步时**自动**把最新播放/点赞/评论记成一条数据文档——不用你手工录。数值没变就不记（不灌水）。趋势折线的数据就是这么一天天养出来的。

## 怎么算好（白话）

- 打开大盘：数据趋势区显示「结账倒计时」，5 张在途押注 5 条横杠，写着"还有 3 天/4 天/5 天"；判断力账本区显示最近 7 天动作流水柱图（今天那格能看到你刚干的事）。
- 同一个押注回流两期数据后，趋势区自动变成播放折线（本次不造数据演示，代码就位即可）。
- 挂 B站视频的押注做一次抓取后，数据文档里自动多出一条带播放/点赞/评论的记录；数值没变再抓不会产生重复。
- 其余六屏零改动。

---

以下给干活的看，可以跳过。

## 已核验的集成点（2026-08-10 主代理核对）

- 大盘：`frontend/src/pw/Dashboard.tsx`——trend = 全部 liveBets（非 draft/void）的数据文档按 collected_at 排序，`trend.length>=2` 才画 TrendChart（**跨押注连线，本批改按押注分组**）；校准 `samples.length>=5`（CALIB_MIN）才画 CalibrationChart；PlatMini 读最新 B站 doc。
- 数据文档：`src/pw-data-docs.ts` `createPwDataDoc(db, {betId, platform, metricsJson})`；真实库现状：3 条 doc，2 条属 void 押注（被前端 liveBets 过滤）——趋势有效点仅 1。
- 账本：`src/pw-runs.ts` pw_runs（actor human/ai/system + created_at）——动作流水聚合源。
- 产出物：pw_artifacts（detached_at IS NULL 为在挂；platform='B站'、type='video'、url 含 b23.tv/BV）；真实库现状：仅已结账的 BET-01 挂 B站视频，在途内容押注暂无 B站 artifact。
- 语料 stat：pw_corpus_docs.video_stat_json（B站 view 接口：播放/弹幕/评论/收藏/投币/分享/点赞），抓取通路 PW-13/14（src/pw-corpus.ts）。

---

# PW-55A 大盘可视化开张（前端，主代理亲做）

- 主需求域：判断沉淀与复用
- 业务接口：无（域内，只读消费既有账本 pw_runs 与数据文档）
- 数据真值源：pw_bets / pw_data_docs / pw_runs（只读）；无新正式表
- 质量约束与验收终态：见末节

## 交付

### 1. 后端补一个读端点（子代理做，见 PW-55B 同一批）

`GET /api/pw/activity-daily?days=7` → `{ days: [{ day: "2026-08-10", human: n, ai: n, system: n }] }`
——pw_runs 按本地日期 GROUP BY day, actor；近 N 天（默认 7 上限 30，非法 400），缺日补零。

### 2. `frontend/src/pw/Dashboard.tsx` 改造

- **趋势按押注分组**：docs 按 betId 分组，每组 ≥2 份含「播放」的 doc 才成一条线（组内按 collected_at 升序）；多线同图（调色板 ≤4 色，超出取最近 4 组并在图注说明）；横轴 = 组内期序号；图例行标 BET-N（沿用 betNoMap）与「播放涨/跌/平」；点赞虚线只画第一组（避免乱）。
- **无任何组够两期 → 显示 CountdownChart**（顶替趋势区）：
  - 数据：status='pending' 且 checkout_date 非空的 liveBets，按 checkout 升序；
  - 每行：BET-N + 标题（截 20 字）+ 7 天窗口横杠（窗口=checkout-6 天…checkout；填充=今天已流逝比例；今天位置刻度线）+ 右侧文字「还有 N 天 / 今天结账 / 已超期 N 天」（超期填充 100% 且走墓碑灰）；
  - 底部说明行：「同一押注回流两期数据后，这里换成播放趋势」；
  - 无在途押注 → pw-blank「没有在途押注，没账可倒。」
- **校准区**：samples ≥ CALIB_MIN 照旧 CalibrationChart；否则显示 **ActivityChart**：
  - 数据：activityDaily(7)；SVG 迷你柱图——7 天 × 3 角色分组柱（human=--pw-ink、ai=--pw-seal-gold、system=--pw-muted 描边），柱顶数值标签（>0 才标），横轴 M-D；
  - 底部说明行：「样本够 5 次带把握的结账后，这里换成校准线」。
- `frontend/src/lib/api.ts`：`activityDaily(days)` + 类型 `PwActivityDay`。
- `frontend/src/pw/pw.css` 末尾 TASK-PW-55 段（倒计时行/横杠/刻度、动作柱图容器，全部 scoped 在大盘本屏类下或新增类名，不碰既有选择器）。

## 质量约束与验收终态（PW-55A）

- verify 全绿（含 PW-55B 新测试）。
- Playwright 截图验收（主代理亲做，1896×916）：倒计时区 5 行横杠与文案、动作流水柱图（当天柱>0）、首页/协作台抽查零改动。分组折线分支无真实数据不强行演示（代码复核 + 后续自然养出，照 PW-41 警示条先例留痕）。
- 其余屏零改动；不 commit。

---

# PW-55B 回流自动记账（后端，DeepSeek 子代理）

- 主需求域：实践与数据回收
- 业务接口：回流数据文档（既有接口——本刀让回收侧自动产出，不再只靠人工录入）
- 数据真值源：pw_artifacts（只读）、B站视频 stat（外部，经既有抓取通路）、pw_data_docs（写，回收域唯一归属）
- 质量约束与验收终态：见末节

## 交付

### 1. 新读函数+端点：`getPwActivityDaily`

- 位置：`src/pw-runs.ts` 追加（账本同源）或新 `src/pw-activity.ts`（子代理按仓库惯例择一，注释说明）。
- 行为：pw_runs 按 `date(created_at,'localtime')` 分组计数，actor 三列；近 N 天（默认 7，上限 30，非正整数 400）；**缺日补零**（含今天）；按日升序返回。
- 路由：main.ts 追加 `GET /api/pw/activity-daily`（PW-53 段后）。

### 2. 自动快照：`snapshotPwBetVideoStats`

- 新文件 `src/pw-bet-video-snapshot.ts`：
  - 找 pw_artifacts（detached_at IS NULL、platform='B站'、type='video'、url 非空）；url 解 BV 号——直接含 BV 号直接取；b23.tv 短链**先查 src/pw-corpus.ts / PW-13-14 是否有现成短链解析可复用**，有才解、没有就跳过该行并日志留痕（不新上依赖）。
  - 取最新 stat（复用既有 B站 stat 抓取通路/客户端，禁止新起一套）；opts 注入 `fetchStat` mock。
  - **同值跳过**：该 bet 最新一条数据文档的 metrics_json 与本次 {播放,点赞,评论} 三项全同 → 不写；否则 `createPwDataDoc(platform='B站', metricsJson)`（collected_at=now 注入）。
  - 每写一条落 pw_runs 账（actor='system'，kind 照 createPwDataDoc 既有口径；若 createPwDataDoc 内部已落账则不重复）。
  - 返回 `{ written: n, skipped: n, errors: [...] }`，单条失败不阻断其余。
- 触发点（子代理核对 PW-13/14 实际结构后择一，注释说明选择依据）：
  a. 语料抓取完成（某 bvid 落盘为 done）时，若该 bvid 有在挂 artifact 的押注 → 顺带 snapshot 该押注；
  b. 既有 B站同步/低频入口的收工处 → 全量 snapshot 一遍。
  两处都便宜就都挂，事件留痕。
- 测试：`src/pw-bet-video-snapshot.test.ts`（新）——mock fetchStat：写 doc/同值跳过/已摘除跳过/无 BV 跳过+留痕/多 artifact 逐 bet/activity-daily 聚合（多天多 actor、缺日补零、days 钳制）。activity-daily 测试可同文件或 pw-runs 测试追加（子代理按惯例）。

## 质量约束与验收终态（PW-55B）

- `PATH="$HOME/.local/node/bin:$PATH" npm run verify` 全绿（含新测试）。
- 真实库冒烟（主代理）：GET /api/pw/activity-daily?days=7 返回 7 天含今天且计数非全零；snapshot 真实跑一次——BET-01（已结账但 artifact 在挂）若 stat 可抓且与最新 doc 不同值则自动落一条 doc，同值则如实 skipped。
- 不碰 frontend/、public/；既有文件仅 main.ts 追加与 pw-runs.ts/pw-corpus.ts 必要最小追加；不 commit。

---

## 防冲突约定

- 子代理只碰：`src/pw-bet-video-snapshot.ts`（新）+ 其测试（新）、`src/pw-runs.ts` 或 `src/pw-activity.ts`（activity-daily）、`src/main.ts`（仅追加 PW-55 段）、`src/pw-corpus.ts`（仅必要时最小追加触发钩子）、`package.json`（测试登记）。
- Dashboard.tsx / api.ts / pw.css 归主代理，子代理不碰。
- 不 commit。

## 不在本批

- 小红书/抖音数据源；语料 stat 对比条形图；趋势图按日历轴对齐；分组折线的真实数据演示（等自然养出）；作废押注数据进趋势的口径变更（维持过滤）。

---

## 验收记录

**验收通过（2026-08-10）**；规格/前端/复核/verify/真实冒烟/截图=主代理亲做，PW-55B 后端实现=DeepSeek 子代理。

**什么能用了**
- 大盘「数据趋势区」无分组趋势时换成「结账倒计时」：5 张在途押注横杠（BET-03/05/10 还有 3 天、BET-08 4 天、BET-13 5 天），填充=7 天窗口已流逝比例，超期走灰色加粗；趋势折线已改为按押注分组（同一押注两期起画，多线+图例，点赞虚线只画第一组）——无真实数据不强行演示，代码就位留痕（照 PW-41 先例）。
- 「判断力账本」校准样本不足时换成「本周动作流水」：7 天 × 你/AI/系统分组柱（真实数据：08-07 高峰 你42/AI53/系统7），样本够 5 次自动换回校准线。
- 回流自动记账：语料抓取 done 时，若该 bvid 有在挂 B站视频产出物的押注 → 自动把刚抓到的 stat 落成数据文档（播放/点赞/评论，同值跳过、不灌水、单条失败不阻断、落 pw_runs sync/system 账）。

**什么还不行 / 注意**
- ⚠️ **b23.tv 短链不解析**：Node 进程内没有短链解析（只在 ego-browser 脚本里），产出物 url 是短链（如 BET-01 的 https://b23.tv/ep1）会被跳过并 warn 留痕——真实库冒烟如实跳过（skipped=1）。**挂 B站视频产出物时请用带 BV 号的链接**（如 https://www.bilibili.com/video/BV…），自动记账才接得上。短链解析列为候选，不擅自加。
- 动作流水只统计 pw_runs 账本事件：PW-53 洞察运行不落账（规格未要求），今天零点起的柱暂时为空属正常。

**证据**
- verify（主代理亲跑）：**282/282 全绿**（273+9 新），selfcheck ok，前端 build 成功。
- 真实冒烟（主代理）：GET /api/pw/activity-daily?days=7 → 7 天齐全、缺日补零、计数与库一致；snapshot 真实库跑一次 → written=0、skipped=1（b23.tv 留痕 warn）、errors=0，零污染。
- Playwright 截图（pw55-dashboard.png）：倒计时五行横杠比例正确（3 天≈57%、4 天≈43%、5 天≈29%）、动作柱图与 API 数据逐项一致、PlatMini 行原样；金子墓碑库抽查零改动（pw55-vault-check.png）。

**子代理偏差（复核认可）**：①既有 append-only 测试精确断言 pw-runs 导出白名单，新只读导出 getPwActivityDaily 必须登记（不变量未破坏）；②fetchStat 同步闭包（语料 done 的 stat 已在内存，避免 donePwCorpus 改异步）；③触发点只挂规格 a——核对后发现规格 b 不可挂：syncPwBilibili 已自行落数据文档（metrics 来自创作中心而非 view 接口），再挂会重复记账。此发现修正了规格假设：B站同步本就在写数据文档，趋势数据会随 sync 自然增长。

**文件清单（全仓未 commit）**
- 后端（子代理）：`src/pw-runs.ts`（getPwActivityDaily）、`src/pw-bet-video-snapshot.ts`（新）、`src/pw-bet-video-snapshot.test.ts`（新，9 例）、`src/pw-corpus.ts`（donePwCorpus 触发钩子+normalizeVideoStat）、`src/main.ts`（activity-daily 端点）、`src/pw-audit-foundation.test.ts`（导出白名单登记）、`package.json`（测试登记）
- 前端（主代理）：`frontend/src/pw/Dashboard.tsx`（trendSeries 分组/countdown/GroupedTrendChart/CountdownChart/ActivityChart，删 TrendChart/trendNote）、`frontend/src/lib/api.ts`（activityDaily+PwActivityDay）、`frontend/src/pw/pw.css`（PW-55 倒计时样式段）
- 文档：`docs/TASK-PW-55-batch.md`（新）
