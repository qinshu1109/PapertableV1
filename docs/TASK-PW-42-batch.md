# TASK-PW-42 批次：筛子 v2（方向输入）

- 状态：已拍板（2026-08-08 用户认方向「先筛子 v2，后 P2」），待派工
- 前置：PW-17/18/19/20/21/22/24/25/26/27 已验收；协作台屏在跑；真实库有 2 张 pending 候选卡可狗食
- 执行分工：PW-42 后端派 DeepSeek 子代理；PW-43/44 前端屏刀主代理亲做 + ego 视觉验收（用户明确分工：整体审查/前端落实/视觉验收归主代理）

## 白话段（这批到底干嘛）

筛子现在只会按一个固定模子捞「路人困惑」。你看着不对味，只能点「全否重筛」——但重筛出来还是同一个模子，否了也白否。

v2 给筛子加一根「方向舵」：

1. **你能告诉筛子往哪捞**。顶条上多一行「当前方向：xxx ✏️」，点一下改一句话（比如「AI 办公提效」「编程工具对比」），之后每轮筛子都朝这个方向捞。对话里也能直接说「把方向换成 xxx」，AI 照做（人发话档，落账）。
2. **全否的时候可以顺手换方向**。现在「全否重筛」是否掉了事；v2 是全否弹层里多一句「换个方向？（留空 = 原方向重筛）」——否掉这堆废卡的同时把舵打了，重筛按新方向来。
3. **每张卡记得自己是哪个方向筛出来的**。卡脚上多一行小字「方向：xxx」，过几天回看能对照：哪个方向出活、哪个方向净出废卡。这是以后调方向的依据。

不设方向时，筛子行为和现在一模一样（默认捞路人困惑）——方向是加成，不是新门槛。

## PW-42 方向输入·后端（派 DeepSeek 子代理）

- **主需求域**：内容生产（第五域，选题候选筛选职责内；方向是筛子 run 的捞取取向参数，不立新数据归属——pw_sieve_state 本归筛子运行审计）
- **业务接口**：
  - 人 → 筛子：定方向/改方向（UI 通路落 human 事件；对话通路走 exec 工具落 ai_exec 账）
  - 筛子 → LLM：buildSievePrompt 注入方向段
  - 内容生产 → 协作台屏：sieveStatus 吐 direction、候选卡列表带 run 方向快照（供 PW-43/44 只读消费）
- **数据真值源**：pw_sieve_state（key='sieve_direction'，kv 表照 watermark 先例直接 SQL）；pw_sieve_runs.direction（每轮 run 落当时方向快照）
- **质量约束与验收终态**：
  1. `src/pw-sieve.ts`：
     - 新增 `getSieveDirection(db): string | null` / `setSieveDirection(db, direction: string | null): void`——照 :706/:722 watermark 直接 SQL 范式；空串/空白 trim 后视为 null（set null = 删行或写空均可，读回统一 null）
     - `pw_sieve_runs` 迁移加 `direction TEXT` 列：PRAGMA 查列、缺才 ALTER、幂等（照 migratePwBetContentColumns 先例），ensurePwSieveTables 尾部调用
     - `runPwSieve`（:589）落 run 行时写当前方向快照（无方向 = NULL）
     - `buildSievePrompt`（:362）sections 顶部注入方向段：`### 当前方向（人定的捞取取向，搬运摆盘时优先朝这个方向捞；其余纪律不变）\n${direction}`——**无方向时整段不出现，输出与现状逐字节一致**（测试硬断言）
     - `SIEVE_SYSTEM_PROMPT`（:116）**一字不动**——方向是用户消息侧输入，不进系统纪律
     - `sieveStatus`（:996）返回加 `direction: string | null`
     - 候选卡列表读函数（listPwSieveCardsByStatus / getPwSieveCard 或集成路由联查层）带 `run_direction: string | null`——联 pw_sieve_runs 取快照，供 PW-44 卡脚展示
  2. `src/pw-collab-tools.ts`：
     - 新 exec 工具 `set_sieve_direction`：description 以「人发话才执行：」开头，requireExecInstruction 守门，recordExecEvent 落 ai_exec 账（payload 含 direction 原文或 null=清除方向）；返回文本报新方向
     - `reject_all_and_resieve`（:1212）schema 加可选 `direction`：有值先 setSieveDirection 再 rejectAll + flushNow；返回文本带新方向；无 direction 行为与现状一致
     - deny 名单不动
  3. `src/main.ts`（本批放行，只加不改旧逻辑）：
     - `PUT /api/pw/sieve/direction` body `{direction: string|null}` → setSieveDirection + 落 pw_runs human 事件（照既有 UI 动作事件范式）
     - `POST /api/pw/sieve/reject-all` body `{reason?, direction?}` → 与 reject_all_and_resieve 工具共用内部函数（rejectAllPendingPwSieveCards + 可选换向 + flushNow），落 human 事件
  4. `docs/REQUIREMENT-DOMAINS.md` 升 v0.7：内容生产负责列「选题候选筛选」后补「、方向输入（筛子捞取取向，人定）」；修订行写依据 TASK-PW-42
  5. 测试（新文件 `src/pw-sieve-direction.test.ts` + 既有测试必要连带更新）：
     - state set/get 往返、空串归 null、未设过返回 null
     - 迁移幂等（二次调用不炸、旧行 direction 为 NULL）
     - **无方向时 buildSievePrompt 输出与现状逐字节一致**（防回归金线）
     - 有方向时 prompt 首段为方向段且含原文
     - run 落 direction 快照；sieveStatus 带 direction
     - set_sieve_direction 工具：无 instruction → 500；有 instruction → 落 ai_exec 账 + state 更新
     - reject_all_and_resieve 带 direction：state 更新 + 两笔账（reject + sieve_run）+ 返回文本含方向；不带 direction 回归
  6. 验收终态：`PATH="$HOME/.local/node/bin:$PATH" npm run verify` 全绿（基线 226 + 新增）；真实冒烟（主代理亲做）：对话说「把筛子方向换成 AI 办公提效」→ ai_exec 账 + state 可见；reject-all 带新方向 → 真实跑一筛 → runs 行 direction 落快照、候选卡引文逐字纪律不失

## PW-43 方向交互·前端屏（主代理亲做）

- **主需求域**：内容生产（协作台屏展示与交互）
- **业务接口**：消费 PW-42 的 sieveStatus.direction、PUT direction、POST reject-all
- **数据真值源**：同 PW-42（前端无本地副本，刷 epoch 重拉）
- **质量约束与验收终态**：
  1. B1 顶条（Collab.tsx:298-322）：筛子小字旁加「方向：{direction} ✏️」——未设方向显示「方向：默认（捞路人困惑）✏️」；点击开自定义弹层（沿用 PW-36 弹层范式，禁 window.prompt/confirm），输入新方向或清空恢复默认，确认调 PUT /api/pw/sieve/direction
  2. 全否重筛（Collab.tsx:258 rejectAll 现用 window.confirm + 逐个 reject）改为：自定义弹层——确认文案 + 「换个方向？（留空 = 原方向重筛）」可选输入框；确认调 POST /api/pw/sieve/reject-all（替代逐个调 rejectSieveCard）
  3. api.ts 类型同步（sieveStatus 带 direction、两个新端点）
  4. pw.css 追加样式（沿用现有灰调小字与弹层惯例）
  5. 验收终态：verify 全绿（前端 build 过）；ego 视觉验收：顶条方向行在 1440×900 不挤压既有元素、弹层两态（改方向/全否换向）截图核对、改完方向顶条即时刷新

## PW-44 方向留痕·卡脚对照（主代理亲做，与 PW-43 同棒验收）

- **主需求域**：内容生产
- **业务接口**：消费 PW-42 候选卡列表的 run_direction 字段
- **质量约束与验收终态**：
  1. 候选卡脚（候选对比区卡片区）加一行小字「方向：{run_direction}」；run_direction 为 null（v2 之前旧卡）显示「方向：默认」
  2. 样式沿用卡脚既有小字灰调，不抢眼
  3. 验收终态：verify 全绿；ego 截图核对新旧两批卡（旧卡「默认」、冒烟新卡带方向）同屏对照可读

## 防冲突约定

- 本子代理只许动：`src/pw-sieve.ts`、`src/pw-collab-tools.ts`、`src/main.ts`（只加路由不改旧逻辑）、`src/pw-sieve-direction.test.ts`（新）、既有测试必要连带（断言更新须最小）、`docs/REQUIREMENT-DOMAINS.md`（v0.7 三处小改）、`package.json`（登记新测试）
- **不许动**：`frontend/`、`public/`（PW-43/44 归主代理）；既有筛子纪律（逐字引文/wildcard/推荐语扫描/排序公式）一字不改；不 commit
- node 24 TS 剥离器不认跨行 as 断言——断言写同行
- 真实库在 `~/Library/Application Support/Papertable/papertable.sqlite3`，冒烟由主代理做，子代理只跑 verify

## 不在本批

- 观众声音 P2（提升链 promote_voice_to_card / 双通路语料评论只读分区）——下一批，本批不动 pw-voice.ts
- trigger_source 加 'voice_promotion' 枚举（P2 才需要，届时沿 migratePwRunsCheck 先例迁 CHECK）
- 方向的自动建议（AI 提议方向）——方向永远人定，AI 只能执行
- 按方向统计出活率的报表——留痕先行，报表以后再说

## 验收记录

### 2026-08-09 PW-43/44 前端视觉验收通过（Playwright 无头 Chrome 截图 + DOM 核验，主代理亲做）

**白话段**：方向舵在屏上了。协作台顶条最右边多了一行小字「方向：AI 编程工具实测对比 ✏️」，不挤不占；点它弹出「改筛子方向」——预填当前方向，清空就是恢复默认，确认按钮会跟着输入变（有方向显示「确认换方向」，空了显示「清空恢复默认」）。每张候选卡脚多一行灰小字「方向：AI 编程工具实测对比」——这批 6 张卡全是这个方向筛的，以后哪个方向出活、哪个方向净出废卡，翻卡脚就能对照。「全否重筛」换成了正经弹层：否掉理由（可空）+ 「换个方向？留空 = 原方向重筛」——否废卡和打方向舵一次完成。

**给干活的看段**：
- 验收通道说明：ego lite 与 Chrome 扩展（kimi-webbridge）当夜均故障（ego 双实例互抢——已修复根因；webbridge 扩展 MV3 service worker 反复断连——daemon 升级 1.11.3→1.11.5 未愈），最终用 Playwright 无头 Chrome（playwright-core 装 /tmp/pw-verify，不污染仓库）完成截图与 DOM 核验
- 核对项全过（截图在 /tmp/pw-verify/）：顶条方向行（右上灰调小字与收工小结并排无挤压，crop 核对）；卡脚方向行（6/6 卡带「方向：AI 编程工具实测对比」，DOM 断言 + crop 核对灰调小字不抢戏）；改方向弹层（预填当前值/说明文案/双按钮/动态确认文案）；全否弹层（标题带卡数「全否当前 6 张候选卡」、理由可空、换方向输入框带原方向提示、按钮动态文案）；两弹层点「再想想」关闭无残留，未误触发全否
- verify：250/250 全绿（前端 build 含本批改动）；api.ts 类型同步（PwSieveStatus.direction、PwSieveCard.run_direction、setSieveDirection、rejectAllSieveCards）
- 连带修复留痕：Collab.tsx BoardLayer props 的 status 从手写内联类型改用 PwSieveStatus（否则新字段编译不过）；rejectAll 从「window.confirm + 逐个 rejectSieveCard + runSieve」改为「自定义弹层 + POST /api/pw/sieve/reject-all 一步到位」（PW-36 禁 window.confirm 纪律在全否通路的漏网补上；单卡否决的 window.prompt 仍在，记入后续候选）

（以下为 PW-42 后端验收记录，2026-08-08）

**白话段**：方向舵装上了。你在对话里说「把筛子方向换成 AI 办公提效」，AI 照办、落账、报新方向；说「全否、换个方向重筛」，它一步到位（4 张旧卡否掉、方向换好、触发重筛）。抓了一条真视频（Qoder vs Cursor 实测对比，79 条评论），带方向真筛一轮出 5 张卡（2 普通 + 3 少数派），卡上内容全在 AI 编程工具语境里，run 行留着方向快照。不设方向时筛子和以前一模一样（有逐字节金线测试兜底）。一个如实发现：一张卡的引文末尾 `[笑哭][笑哭][笑哭]` 被模型截成一个 `[笑哭]`——引文主体逐字对，末尾重复表情被顺手精简，与 PW-21 发现的 uname 转录错同属「模型侧逐字纪律残余风险」，继续靠提示词契约 + 人工抽查兜底，不影响本次验收。另一个已知边界：换方向后立刻重筛不会重筛老料（watermark 只放行进新到数据，PW-18 既有语义，不是本批引入）——「换方向重筛老料」记为后续候选，本批不开 reset watermark 的口子。

**给干活的看段**：
- verify 主代理亲跑：234/234 全绿（226+8），selfcheck ok，前端 build 过
- 金线测试在 `src/pw-sieve-direction.test.ts:354-368`：无方向 buildSievePrompt 与现状逐字节一致；有方向 = 方向段 + 原内容逐字节
- 真实冒烟（全主代理亲做，SSE 路由）：
  - Q1「把筛子方向换成：AI 办公提效」→ tool_start set_sieve_direction；pw_sieve_state 落值；ai_exec/edit 账 payload `{"direction":"AI 办公提效"}` + instruction_text 原话 + messageId 齐
  - Q2「候选卡全部否掉，方向换成「AI 编程工具实测对比」，重筛一轮」→ reject_all_and_resieve 带 direction；4 卡 rejected；state 换向；两笔账（reject + sieve_run，runId:null 如实记录空跑——watermark 无新料）
  - Q3 fetch_corpus 抓 BV1DhpYzSENp（auto 档）：模型先误选已在库的 rickroll BV，自己认出并停手要真 BV（店规起效：撞墙停手不编造）；给真 BV 后抓取 done、79 评论
  - Q4 POST /api/pw/sieve/run 手动触筛：run fb1edd81 trigger=manual direction=「AI 编程工具实测对比」cards=5 dropped=0 done；3 wildcard；抽 2 卡对照 comments.jsonl——rpid=274988868049 逐字一致；rpid=276566225360 末尾 `[笑哭]×3`→`×1`（模型侧截断，见白话段）
- 复核：SIEVE_SYSTEM_PROMPT 一字未动；deny 名单未动；main.ts 只加两路由（PUT direction / POST reject-all，human edit 账）；frontend src 零改动（public/ 变动为 verify build 固有产物）；voice_promotion 零引用（P2 未偷跑）；未 commit
- 偏差：子代理报「无」；event_type 复用 edit（未扩枚举，pw-runs.ts 不在本批可动清单）；setSieveDirection 清除采删行（规格允许二选一）
- 留痕：单卡否决仍用 window.prompt（Collab.tsx:247，PW-36 禁 prompt 纪律的漏网点，本批规格未列，记入后续候选）
