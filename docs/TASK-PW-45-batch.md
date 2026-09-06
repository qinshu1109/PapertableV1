# TASK-PW-45 批次：观众声音 P2（提升链 + 双通路 + 声音屏）

- 状态：已拍板（2026-08-08 用户「落实观众声音 P2」；此前方案两刀已认：先筛子 v2 后 P2，v2 已验收）
- 前置：PW-42/43/44（筛子 v2）已验收；语料库有 BV1DhpYzSENp（79 评论）等可狗食；真实库有手动录入声音若干
- 执行分工：PW-45/46 后端派 DeepSeek 子代理；PW-47 声音屏前端主代理亲做 + ego 视觉验收

## 白话段（这批到底干嘛）

观众声音屏现在只是个「P2 开通」的灰色占位——声音能录（对话里让 AI 录、API 能收），但你没地方看它们，看完了也没处去。这批把这条路打通：

1. **声音有了家（PW-47 新屏）**。顶部导航「观众声音」点亮。屏上两摊：左边是声音列表——每条原文、哪来的（赛道观众/手动录入两色）、AI 分拣的标签（选题线索/批评/形式建议/噪音）；右边是语料评论只读区——挑一条已抓的视频，它的评论按点赞排开给你翻。
2. **看上哪条，一键进候选（PW-45 提升链）**。声音行上一个「提请候选」按钮——点了就把这条原话**逐字**变成一张协作台候选卡（草稿），走你熟悉的挑/改/否。批评类的进少数派区（说得狠的话本来就该在那）。提请过的按钮置灰「已进候选」，不会重复产卡。对话里也能让 AI 干这事（人发话档，落账）。
3. **语料评论一键收录进声音（PW-46 双通路）**。翻评论时看到扎心的，点「收录」就进声音列表（原文逐字、带去向回链），AI 顺手自动分拣。之后它也能走提升链进候选。数据不搬家——评论真值还在语料库，声音表只是收了个「这条值得留着」的指针加原文。

一句话：以前声音是录进去就躺着，现在是「看到 → 收录/提请 → 进候选 → 你挑改否」的完整上坡路。

## PW-45 提升链·后端（派 DeepSeek 子代理）

- **主需求域**：实践与数据回收（声音侧：校验、回写提升链）→ 内容生产（候选卡侧：哨兵 run + 产卡）。跨域动作，两侧各管各的表
- **业务接口**：新增跨域接口「提请选题候选」（回收 → 生产）：观众声音原文逐字提升为候选卡草稿，回收侧回写 promoted_to_draft_id 防重；生产侧走既有挑/改/否，不另立状态机
- **数据真值源**：pw_voice_items（声音，回收域）；pw_sieve_runs / pw_sieve_cards（候选卡，生产域）
- **质量约束与验收终态**：
  1. `pw_sieve_runs.trigger_source` CHECK 迁移加 `'voice_promotion'`：SQLite 改 CHECK 只能重建表（先读 `migratePwRunsCheck` 先例照做；PRAGMA foreign_keys 先关后开；pw_sieve_cards 引用 runs(id) 不得丢行）；迁移幂等
  2. 新文件 `src/pw-voice-promote.ts`：
     - `promotePwVoiceToCard(db, voiceId, audit?)`：
       - 校验：条目存在；`dropped_reason IS NULL`（已丢弃 → 409）；`signal_type != 'noise'`（噪音 → 409「噪音不进候选」）；`promoted_to_draft_id IS NULL`（已提升 → 409 并在报错信息带既有卡 id）
       - kind 映射：`content_critique` → `wildcard`（批评=说得狠的异类信号，进少数派区）；`topic_lead`/`form_suggestion`/NULL（未分拣）→ `normal`
       - 哨兵 run：trigger_source='voice_promotion'、input_ids_json=`[voiceId]`、cards_count=1、dropped_count=0、status='done'、direction=getSieveDirection 当前快照、model=NULL、created_at=finished_at 同刻（照 pw-sieve.ts:640 INSERT 范式）
       - 产卡直写（照 :691 范式）：quote_text=声音 content **逐字**；quote_source_json=`{bvid:'voice', uname:'观众声音·{platform}', voice_id, signal_type, like:null, rpid:null}`；scale_note/hook_note/freshness_note=NULL、scale_value=0、sort_score=0（提请链不走排序公式——是人主动提的，0 分沉底可接受，候选区照常展示）；status='pending'
       - 回写 `pw_voice_items.promoted_to_draft_id = 新卡 id`
       - 账：audit 传入 → recordPwExecEvent（ai_exec，eventType 复用 `'voice'`，payload 含 voiceId/cardId/runId）；否则 recordPwEvent human `'voice'` 同 payload
     - 以上写操作包一个事务（哨兵 run + 卡 + 回写同生共死）
  3. `src/pw-collab-tools.ts`：新 exec 工具 `promote_voice_to_card`（description「人发话才执行：」开头、requireExecInstruction 守门、params `{voiceId}`；返回文本报卡 id 与进哪个区）；deny 名单不动
  4. `src/main.ts`（只加）：`POST /api/pw/voice/:id/promote` → promotePwVoiceToCard（human 账）
  5. 测试新文件 `src/pw-voice-promote.test.ts`：迁移幂等（二次 ensure 不炸、旧行保留、新 trigger 可写）；promote 成功（卡字段逐字/kind 映射两态/哨兵 run direction 快照/回写/两路账）；409 三连（重复提升带既有卡 id/noise/已丢弃）；工具无 instruction → 500；事务回滚（模拟产卡失败 → run 与回写都不留）
  6. 验收终态：verify 全绿（基线 234 + 新增）；真实冒烟（主代理）：对话「把声音 xxx 提请候选」→ ai_exec 账 + 协作台候选区可见该卡（引文与声音逐字一致）+ 重复提请 409

## PW-46 双通路·后端（同一子代理，PW-45 完成后接着做）

- **主需求域**：实践与数据回收（语料评论只读展出 + 一键收录进声音；评论真值留语料库，不复制到回收域表——声音行只存原文快照与出处，与手动录入同构）
- **业务接口**：复用「提供语料与回流数据」（回收 → 生产不变）；本刀是回收域内部展出与收录
- **数据真值源**：语料落盘 comments.jsonl（只读，经 PW-17 readPwCorpusComments）；pw_voice_items（收录落点）
  - **质量约束与验收终态**：
  1. `src/pw-voice-promote.ts`（或 pw-voice.ts，子代理择一并注明）加：
     - `listPwVoiceCorpusComments(db, bvid, offset?, limit?)`：readPwCorpusComments 分页取出，每条附 `collected: boolean`——联查 pw_voice_items 存在 `platform='bilibili:{bvid}' AND content=message逐字 AND dropped_reason IS NULL` 即 true
     - `collectPwCorpusComment(db, {bvid, rpid}, audit?)`：readPwCorpusComments 全量扫 rpid 匹配（量级百级，可接受）；找不到 → 404；已收录（同上匹配）→ 409 带既有声音 id；否则 addPwVoiceItem(platform=`bilibili:${bvid}`、content=message **逐字**、author=uname ?? '匿名'、capturedAt=ctime 转 ISO、null 则用当前刻)——PW-26 自动分拣挂钩自然触发，收录即分拣；dropped 旧条不参与防重（人丢过的允许再收）
  2. `src/main.ts`（只加）：
     - `GET /api/pw/voice/corpus-comments?bvid=&offset=&limit=` → meta（bvid/title/up_name）+ comments（含 collected）
     - `POST /api/pw/voice/collect` body `{bvid, rpid}` → collectPwCorpusComment（human 账经 addPwVoiceItem 既有路径）
  3. 测试 `src/pw-voice-collect.test.ts`：收录成功（platform 格式/逐字/author/capturedAt=ctime 转换/自动分拣 spy 触发）；409 带既有 id；404 rpid 不存在；collected 标记两态；dropped 后可再收录
  4. 验收终态：verify 全绿；真实冒烟（主代理）：UI 或 curl 收录 BV1DhpYzSENp 一条高赞评论 → 声音列表出现、自动分拣落标签、再收一次 409

## PW-47 观众声音屏·前端（主代理亲做）

- **主需求域**：实践与数据回收（屏展示与交互）；提请按钮消费 PW-45/46 接口
- **质量约束与验收终态**：
  1. 新 `frontend/src/pw/Voice.tsx`：
     - 左栏「声音列表」（listPwVoiceItems 全量，前端倒序）：每行原文 + 来源色（`platform` 以 `bilibili:` 开头 → 「赛道观众」蓝调；其余 → 「手动录入」绿调）+ signal_type 徽章（选题线索/内容批评/形式建议/噪音/未分拣）+ cluster 小字 + 「提请候选」按钮（`promoted_to_draft_id` 非空 → 置灰「已进候选」）+ dropped 行灰显
     - 右栏「语料评论（只读）」：视频下拉（list_corpus 数据）+ 评论列表（like 降序前 50，uname/like/ctime 小字）+ 每条「收录」按钮（collected → 置灰「已收录」）
     - 两栏操作后 epoch 重拉；错误 toast 沿用既有范式
  2. `PaperweightApp.tsx`：PwScreen 加 `'voice'`、NAV 在协作台后插「观众声音」、DISABLED_NAV 数组删除（Home.tsx:123 附近若还有 P2 占位提示一并点亮/移除）
  3. `api.ts`：PwVoiceItem 类型 + voiceApi 组（listVoice/addVoice?——本屏只读列表+promote+corpusComments+collect；add/drop 不进屏，不加）
  4. `pw.css` 追加（沿用灰调小字与徽章惯例）
  5. 验收终态：verify 全绿；ego 视觉验收：新屏两栏 1440×900 截图核对、提请/收录按钮两态（可点/置灰）、导航点亮；与 PW-43/44 同轮 ego 一并验收

## 防冲突约定

- 子代理只许动：`src/pw-voice-promote.ts`（新）、`src/pw-voice.ts`（仅 export 既有私有函数如需）、`src/pw-sieve.ts`（仅 trigger_source CHECK 迁移与必要的 export）、`src/pw-collab-tools.ts`、`src/main.ts`（只加路由）、`src/pw-voice-promote.test.ts` / `src/pw-voice-collect.test.ts`（新）、既有测试必要连带（工具计数）、`package.json`、`docs/REQUIREMENT-DOMAINS.md`（v0.8）
- **不许动**：`frontend/`、`public/`（PW-47 归主代理）；筛子纪律与方向注入零改动；声音分拣提示词零改动；不 commit
- REQUIREMENT-DOMAINS.md 升 v0.8：实践与数据回收负责列补「观众声音录入/分拣/语料评论收录」、唯一归属补「观众声音」；内容生产负责列补「声音提请候选卡（提升链）」；跨域接口加「提请选题候选」行；修订行写依据 TASK-PW-45
- node 24 TS 剥离器不认跨行 as 断言——断言写同行；真实库冒烟归主代理

## 不在本批

- 声音的自动分类聚簇屏（cluster 只展示小字，不做聚簇视图）
- 自家视频/直播评论的定向抓取（自家还没发内容；届时走语料抓取同源）
- 声音的冲正键（提请错了 → 候选卡走既有「否」动作即可，声音行保留留痕）
- 筛子消费声音的既有通路（PW-18 声音进筛子输入）零改动

## 验收记录

### 2026-08-08 PW-45/46 后端验收通过（主代理亲验；PW-47 前端验收与 PW-43/44 同轮补记）

**白话段**：声音的上坡路后端打通了。你在语料评论里看中那条 52 赞的「自从用过 trae 后，感觉这些兴起的 ide 都比 cursor 差远了」，点收录——它原文一字不动（连末尾表情都在）进了声音表，AI 顺手自动分拣。再点收录？直接弹回「已收录（id=xxx）」，不收双份。声音看中了想拍？「提请候选」一点，原话逐字变成协作台候选卡等你挑改否；再点一次弹回「已提升为候选卡（draft_id=xxx）」；被分成噪音的不让提请（「噪音不进候选」）。对话里也能办：跟 AI 说「把声音 xxx 提请候选」，它先查再办、落账。一个如实发现：第一轮对话冒烟时 AI 找不到游离声音（不挂押注的）——它没瞎编，老实说「我没法按 id 查」并停下来问。根因是只读工具 read_voice 只会按押注卡查，游离声音在对话层不可见，已补：全局对话里 read_voice 现在列出全部未丢弃声音（带完整 id、已提请标记）。另一个业务观察：那条 52 赞评论被自动分拣标成了「噪音·主观比较与情绪表达」——它其实贴合筛子方向，AI 自己在对话里也提出这个异议。分拣标准偏严是模型侧判断问题，长期要调，先留痕。

**给干活的看段**：
- verify 主代理亲跑：250/250 全绿（234 基线 + 子代理 14 + 补丁 2），selfcheck ok，前端 build 过
- 复核：migratePwSieveRunsCheck 照 migratePwRunsCheck 先例（FK 先关后开、全量拷贝、索引重建、幂等）；frontend src 零改动；筛子纪律/方向注入/分拣提示词零改动；未 commit
- 真实冒烟（全主代理亲做）：
  - PW-46：GET corpus-comments?bvid=BV1DhpYzSENp → meta 正确（御风大世界）+ collected 标记 False；POST collect rpid=274988868049 → 201，platform='bilibili:BV1DhpYzSENp'、content 逐字（含完整 [笑哭]）、captured_at=ctime 转换正确（2025-09-18T05:12:48Z）；重收 → 409 带既有 id；4 秒后自动分拣落 signal_type=noise / cluster='主观比较与情绪表达'（PW-26 挂钩自然触发）
  - PW-45 UI 通路：POST /api/pw/voice/d9abb234/promote → 卡 734e9bda：quote_text 与声音 content 逐字一致、kind=normal（topic_lead 映射）、quote_source_json 齐（bvid='voice'、uname='观众声音·bilibili'、voice_id、signal_type）、哨兵 run 9555f74b（trigger=voice_promotion）；重复 → 409 带 draft_id；noise（3155830b）→ 409「噪音不进候选」
  - 对话通路 Q1（补丁前）：模型调 4 次 read_voice 按 betId 查全部扑空，如实回答「没有按 id 检索声音的路由」并停下来要指认——不编造纪律起效，但暴露工具缺口
  - 补丁（主代理亲做）：read_voice 全局模式——betId 缺省或 'global' 时列出全部未丢弃声音（含游离，LIMIT 50，带完整 voiceId 与「已提请」标记）；description 同步；测试 2 组（全局列出含游离/按 betId JOIN 语义回归）；补丁后 Q3：模型空调 read_voice → 列出 2 条、正确识别「已提请」与 noise 不可提请、结论「无可提请对象」正确，并主动指出 trae 评论分拣偏严
  - 对话通路 Q2 另发现：全局会话历史锚定复现（PW-24 已知模型行为）——第一轮失败记录会把模型带偏不调工具，明确指令「先调工具」即恢复；记为持续观察项
- 偏差：子代理报 PW-46 两函数落 pw-voice-promote.ts（规格允许择一，且比约定更保守——pw-voice.ts 零改动）；promote 路由 200（沿用 drop 惯例）；补丁 read_voice 全局模式为规格外必要修复（对话通路是规格明确能力，缺口使其不可用）
- 模型侧观察留痕：自动分拣把 52 赞的「trae 比 cursor 差远了」标 noise（cluster 主观比较与情绪表达）——贴合方向的素材被降权，分拣标准长期调，本批不动

### 2026-08-09 PW-47 声音屏视觉验收通过（用户验收录屏逐帧核对）

**白话段**：新屏点亮了。导航「观众声音」在协作台右边，进去左栏是声音列表（两条狗食数据：手动录入那条显示「已进候选 ↗」——就是后端冒烟提请的那张卡；语料收录那条标着蓝色的「赛道观众」和「噪音」徽章），右栏语料评论区默认选中 Qoder vs Cursor（79 条），评论按点赞从高到低排开，已收录的那条显示「已收录」，其余都是可点的「收录」。你滚着翻了一整屏，78 条评论逐条带「收录」按钮，长的推荐码评论也完整显示。录屏你看了说没问题，我逐帧又核了一遍，确认无遮挡无错位。

**给干活的看段**：
- 验收载体：用户亲录屏 `/Users/qinshu/Desktop/录屏2026-08-09 06.09.06.mov`（9.2s，1896×916），主代理逐帧核对
- 核对项全过：导航点亮且当前页高亮；顶条「观众声音 · 声音的完整上坡路」；左栏 2 条——d9abb234（手动录入绿标 + 选题线索徽章 + cluster 成功实践案例 + 「已进候选 ↗（去协作台复核）」置灰态）、3155830b（赛道观众蓝标 + 噪音徽章 + cluster + ↗出处链接 + 提请候选按钮）；右栏下拉选中 BV1DhpYzSENp（79 条）+ UP主御风大世界 + 评论 like 降序（52/39/26/24/17…）+ rpid=274988868049 显示「已收录」置灰、其余「收录」可点；长评论（推荐码/链接）完整渲染无破版；滚动流畅
### 2026-08-09 PW-47 声音屏视觉验收通过（用户验收录屏逐帧核对 + Playwright DOM 补核）

- 留尾补核：noise 行「提请候选」按钮 DOM 核验 disabled=true、title「噪音不进候选（若要翻案先改分拣标记）」（Playwright 无头 Chrome，/tmp/pw-verify/voice-screen.png 同步截图）——PW-47 全部验收项关闭
