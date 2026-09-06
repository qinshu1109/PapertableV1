# TASK-PW-41 第七屏「笔记」

- 日期：2026-08-08
- 状态：已拍板（2026-08-08，用户「继续」；批次 `docs/TASK-PW-38-batch.md` 收口刀）
- 主需求域：内容生产
- 业务接口：提供笔记读取（消费，PW-39 提供）+ 按押注回顾捞取（消费，PW-40 提供）
- 数据真值源：Memos SQLite 库（只读，经 PW-39/40 读函数）+ 镇纸库 `pw_bets`（在途内容押注，只读）；前端无本地存储；无新正式表
- 质量约束与验收终态：见末节「质量约束与验收终态」
- 依赖：PW-39（读函数六件）、PW-40（recallPwNotesForBet / buildPwNoteEcho）

## 这刀是干什么的（白话）

镇纸导航多一个「笔记」屏，进去四样东西：

1. **节奏热力图**——顶上一条 GitHub 风格的格子图，近一年哪天记了哪天没记、记多记少，一眼看穿。
2. **笔记列表**——你记过的所有东西按时间倒序排开，能翻页；顶上搜索框输关键词回车就过滤。
3. **标签树**——右栏把你用过的标签按层级（`#镇纸/协作台` 这种斜杠分层）聚合成可折叠的树，点一下标签就等于搜它。
4. **相关旧笔记**——右栏一排在途押注卡，点哪张，下面立刻列出和它对得上词的旧笔记（PW-40 的捞取机制上屏）；每张命中都带「命中词」和回链，点回链直接跳到 Memos 原文。

Memos 没启动或库不在时，屏顶上出一条警示「连不上笔记库」，各区显示空态，**屏不白、不崩**。

## 怎么算好（白话）

- 打开「笔记」屏：热力图上有你今天记的那格；列表第一条是最近记的笔记；标签树里有「镇纸」。
- 搜「落座」能搜出那条验收笔记；点笔记上的回链，浏览器打开 Memos 对应页。
- 右栏点押注《把亲人的死当华点博分数》，相关旧笔记区立刻刷新（有命中就列出来，没有就老实说"无命中"并列出捞了哪些词）。
- 把 Memos 停掉再刷新屏：警示条出现，屏其余部分照常可用。
- ego 截图核对区块 + 真实点击回归，其余六屏零改动。

---

以下给干活的看，可以跳过。

## 已核验的集成点（2026-08-08 主代理核对）

- 壳：`frontend/src/pw/PaperweightApp.tsx`——`PwScreen` 联合类型 + `NAV` 数组（首页/押注台/金子墓碑库/协作台）+ `DISABLED_NAV`（观众声音置灰）+ 数据源/大盘两个独立按钮 + 底部按 `screen` 条件渲染。第七屏在「大盘」按钮后加「笔记」按钮，`PwScreen` 加 `'notes'`。
- 数据：`frontend/src/lib/api.ts` `pwApi` 对象 + `request<T>` 泛型助手；类型与端点同文件集中定义。
- hooks：`frontend/src/pw/hooks.ts` `useAsync(fn, deps)` → `{data, error, loading, reload}`；`fmtDay/fmtTime` 格式化助手。
- 屏范式：`Vault.tsx`——`pw-page > pw-page-inner > pw-page-head(h1+sub)` + 工具行 + 内容区；错误 `pw-err`、空态 `pw-blank`、按钮 `pw-btn sm`、搜索 `pw-search`、分段 `pw-seg`。
- 样式：`frontend/src/pw/pw.css`（3525 行，BEM 风格 `pw-` 前缀，新样式追加在文件末尾并注释 TASK 编号）。
- 路由：`src/main.ts` 收工小结段（PW-36，main.ts:788 附近）后追加「TASK-PW-41：笔记屏」段；`json(response, status, value)` 输出；`httpError(status, msg)` 抛错；`asBadRequest` 只把无 status 错包成 400——**笔记读函数的"连不上"错误（无 status 字段、消息含路径）必须包成 503**，新写一个 `asNotesUnavailable` 小助手（try/catch → 有 status 原样抛、无 status 包 `httpError(503, …)`）。
- 后端读函数全部现成：`readPwNotesList / searchPwNotes / getPwNotesDailyStats / getPwNotesStatus`（PW-39，`src/pw-notes.ts`）、`recallPwNotesForBet`（PW-40，`src/pw-note-recall.ts`）、`getPwBet`（`src/pw-bets.ts`）、`listContentBets` 前端已有 `pwApi.listContentBets()`（相关旧笔记区的押注 chips 用它，前端过滤 `status==='pending'`）。
- 押注展示序：相关旧笔记区 chips 排序与协作台 rail 同源——前端按 `sortContentBetsForDisplay` 同规则排（该函数在 `pw-content-bets.ts`，注释明示两处同步；前端 Collab.tsx 已有同款排序代码，抄同一规则，注释互指）。

## 交付清单

### 1. 后端补一个读函数：`src/pw-notes.ts` 追加

```ts
export type PwNoteTagCount = { tag: string; count: number };
/** 全量标签聚合计数（标签树原料）：payload $.tags 展开，按 count 降序、tag 升序。 */
export function getPwNotesTagCounts(): PwNoteTagCount[]
```

SQL 要点：`FROM memo, json_each(CASE WHEN json_valid(payload) THEN json_extract(payload,'$.tags') ELSE NULL END) AS tag WHERE row_status='NORMAL' GROUP BY tag.value`；层级不在后端拆（`镇纸/协作台` 原样返回，**树由前端按 `/` 拼**——后端保持扁平事实）。只读纪律同 PW-39（即开即关、禁 immutable）。

### 2. 集成路由：`src/main.ts` 追加一段（PW-36 段后）

| 路由 | 处理 | 参数 |
|---|---|---|
| `GET /api/pw/notes/status` | `getPwNotesStatus()` | — |
| `GET /api/pw/notes` | `{ notes: readPwNotesList({limit, offset}) }` | limit≤200、offset≥0，非法 400 |
| `GET /api/pw/notes/search` | `{ notes: searchPwNotes(q) }` | q 缺失/空 → `{ notes: [] }`（不查库不报错） |
| `GET /api/pw/notes/stats` | `{ days: getPwNotesDailyStats({days}) }` | days 默认 365 上限 370 |
| `GET /api/pw/notes/tags` | `{ tags: getPwNotesTagCounts() }` | — |
| `GET /api/pw/notes/recall` | `recallPwNotesForBet(bet)` → `{ recall: PwNoteEchoBet }` | betId 必填（400）；押注不存在（404）；只读不校验 kind/status——非内容押注也照捞（词照抽），注释说明 |

错误口径：读函数抛出的"连不上"错误一律 503 + 原消息（`asNotesUnavailable`）。**本段全是 GET 只读，不加任何写路由。**

### 3. 前端类型与端点：`frontend/src/lib/api.ts` 追加

`PwNote`（uid/content/createdAt/updatedAt/visibility/pinned/tags/url）、`PwNoteDayStat`、`PwNoteHit`（PwNote + matchedKeywords）、`PwNoteTagCount`、`PwNoteRecallBet`（betId/betTitle/keywords/hits）、`PwNotesStatus`（ok/path/error?）；`pwApi` 加 `notesStatus / notesList / notesSearch / notesStats / notesTags / notesRecall(betId)`，全部 GET。

### 4. 第七屏：`frontend/src/pw/Notes.tsx`（新）+ `PaperweightApp.tsx` 改两处 + `pw.css` 追加

布局（1440×900 一屏装下，不滚动出重点区）：

```
pw-page > pw-page-inner
├─ pw-page-head：h1「笔记」+ sub「记的活在 Memos，镇纸只管看、捞、回顾 · 只读」
├─ 警示条（仅 notesStatus.ok=false 显示）：「连不上笔记库：{error}」
├─ 节奏热力图区：标题行「记录节奏 · 近一年」+ GitHub 风格周列网格
│   （grid-auto-flow: column，7 行；data-level 0/1/2/3 四档着色：0 / 1-2 / 3-5 / 6+；
│     cell title="YYYY-MM-DD · N 条"；月份标签行可省——保持轻）
├─ 主区两栏（左 62% / 右 38%）
│   ├─ 左：搜索行（pw-search 范式，回车提交+清除钮）+ 笔记列表 + 分页行
│   │     笔记卡：内容全文（white-space: pre-wrap）、元信息行（fmtTime(createdAt)、
│   │     置顶标📌、标签 chips、回链 ↗ 新窗口开 url）
│   │     分页：每页 20 条，「上一页/下一页」+ 第 N 页；搜索态隐藏分页
│   └─ 右：
│       ├─ 相关旧笔记区：标题「相关旧笔记 · 跟着押注捞」+ 押注 chips 行
│       │   （listContentBets 过滤 pending、展示序同源排序；点击选中 → notesRecall(betId)）
│       │   命中卡：内容截断 120 字、命中词 chips、日期、回链
│       │   空态三态：无在途押注「没有在途内容押注，没东西可捞。」/
│       │   无命中「无命中（捞了：词1、词2…）」/ 库不可用跟警示条口径
│       └─ 标签树：标题「标签」+ 按 / 分层的可折叠树（▸/▾ 手风琴，默认展开第一层），
│           叶/节点右侧计数；点击标签 = 置搜索词并提交
```

空态与异常：status.ok=false 时列表/热力图/标签/相关区各自显示「连不上笔记库」空态（不白屏）；0 条笔记显示「还没有笔记。打开 Memos（http://127.0.0.1:5230）记一条。」；loading 沿用既有模式。

`PaperweightApp.tsx`：`PwScreen` 加 `'notes'`；「大盘」按钮后加「笔记」按钮；底部加 `{screen === 'notes' && <Notes epoch={epoch} />}`。**其余六屏与 DISABLED_NAV 一字不动。**

### 5. 测试（后端补测，前端走 ego 验收）

`src/pw-notes.test.ts` 追加 2 组：

1. `getPwNotesTagCounts`：mock 库造多标签/嵌套标签（`镇纸/协作台`）/无标签/坏 JSON payload/归档行——断言聚合计数正确、坏 payload 与归档行不进统计。
2. 零写入对账追加覆盖 tags 查询（沿既有对账组补一句即可）。

main.ts 新路由不做单测（沿 PW-20 先例：路由层靠 verify + 真实冒烟 + ego 回归验收）。

## 质量约束与验收终态

- `PATH="$HOME/.local/node/bin:$PATH" npm run verify` 全绿（含新增 2 组）。
- 真实库冒烟（主代理）：六条路由逐条 curl——status ok、list 含已知笔记、search("落座") 命中、stats 当天 ≥1、tags 含「镇纸」、recall?betId=1ba1711d… 返回 keywords 与 hits（PW-40 冒烟已归档对词笔记，此处如实无命中或另造一条再归档）；冒烟前后真实 Memos 库 db+wal sha256 逐字节一致。
- **ego 视觉验收（主代理亲做，1440×900）**：①整屏截图区块核对（警示条不在时四区齐：热力图/列表/相关旧笔记/标签树）；②UI 数据流回归——搜索「落座」出卡 → 点回链跳 Memos（target=_blank，ego 验证新 tab URL）；点押注 chip → 相关区刷新；点标签「镇纸」→ 列表变为搜索结果；翻页按钮工作；③其余六屏截图抽查零改动（首页/协作台各一张）。
- 大屏与其余五屏零改动；不 commit； Memos 库零写入。
- 已知约束留痕：ego CDP 截图间歇超时 → 重启 ego lite + reload 恢复（PW-20/22 先例）；浏览器缓存拿旧 bundle → 硬刷。

## 验收记录

**验收通过（2026-08-08）**；规格/实现/verify/真实库冒烟/ego 视觉验收=主代理亲做（屏刀惯例）。

- 交付：`src/pw-notes.ts` 追加 `getPwNotesTagCounts`（+类型 PwNoteTagCount）→ `src/main.ts` 追加 TASK-PW-41 段六条只读 GET 路由 + `asNotesUnavailable` 助手（503 口径）→ `frontend/src/lib/api.ts` 类型 5 件 + 端点 6 个 → `frontend/src/pw/Notes.tsx`（新，约 340 行：热力图/列表/分页/标签树/相关旧笔记）→ `PaperweightApp.tsx` 三处（PwScreen+'notes'、导航按钮、屏渲染）→ `pw.css` 追加约 150 行。测试：`pw-notes.test.ts` 新增 tagCounts 组 + 零写入组补 tags 查询。
- verify（主代理跑）：**225/225 全绿**（224+1），selfcheck ok，前端 build 成功。
- 真实库冒烟（主代理跑，后端重启后六路由逐条 curl）：status ok:true；list 含 PW-38 验收笔记且回链正确；search("落座") 1 命中、空 q 返回 [] 不查库；stats 7 日连续、当天 1 条；tags=[{镇纸,1}]；recall 正常返回（keywords=40，hits=0 如实——PW-40 对词笔记已归档）；错误路径 recall 缺 betId 400 / 不存在 404 / limit=0 400。**对账：六路由冒烟前后真实 Memos 库 db+wal sha256 逐字节一致**。
- ego 视觉验收（1440×900，task space 17）：整屏截图区块核对通过——导航八项「笔记」在末位 on 态、h1+sub、热力图（今天 2026-08-09 是周日，绿格在末列首行 ✓）、列表卡（内容/时间/标签 chip/原文↗）、分页行（单条时上下页均 disabled）、相关旧笔记（5 押注 chips + 无命中如实列关键词）、标签树（镇纸 ×1）。UI 数据流回归全过：搜索「落座」→ 1 命中且分页隐藏；清除 → 回列表态分页行复现；点押注 chip → 相关区即时刷新（关键词跟着换）；点标签「镇纸」→ 等于搜索它；回链 `target=_blank` 开新 tab 真实打开 Memos 页（标题 Memos、正文含「落座冒烟」）。协作台/首页截图抽查零改动。
- 与规格的偏差/留痕：
  1. tagCounts SQL 首版把 `tags:"oops"`（合法 JSON 标量）喂给 json_each 炸「malformed JSON」——自测抓到，修成嵌套 CASE 先 `json_type='array'` 判定再 extract（测试已锁）。
  2. 「连不上笔记库」警示条/503 路径未做真机视觉验收（要触发需挪走真实库，不值得动；该路径由单测 + asNotesUnavailable 代码复核兜底）。
  3. 第二张默认视图截图因 ego 重启丢 viewport 覆盖实为 1884×866（布局同 1440 结论一致）；ego CDP 截图超时复发一次，重启 ego lite 恢复（PW-20/22 先例）。
  4. 观察项（非本刀范围）：协作台「多源可视化」块的「笔记 · 待来源通路」占位行现已具备接线条件；首页六卡无「笔记」卡（规格只要求导航入口）——两项列为后续候选，不擅自加。
