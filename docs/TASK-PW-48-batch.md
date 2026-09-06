# TASK-PW-48 批次：四件后续候选（重筛老料 / 单卡否决弹层 / 分拣调优 / 方向成绩单）

- 状态：已拍板（2026-08-09 用户点名四件后续候选一次做）
- 前置：PW-42~47 全部验收（筛子 v2 + 观众声音 P2）；verify 基线 250/250
- 执行分工：PW-48/50/51 后端派 DeepSeek 子代理；全部前端点（48 勾选 / 49 弹层 / 50 按钮 / 51 小表）主代理亲做 + Playwright 截图验收

## 白话段（这批到底干嘛）

四件都是上一批留的小尾巴，一次清掉：

1. **换方向能重筛老料了（PW-48）**。现在换了方向点重筛，老评论不会重过一遍（系统记着「这批料筛过了」）。这批在全否弹层里加个勾选：「把现有语料也按新方向重过一遍」——勾上，全否 + 换方向 + 老料全部重筛，一次完成。不勾就还是老样子（只筛新到的）。
2. **单张卡的「否」不再弹浏览器土对话框（PW-49）**。现在点单卡的「否」弹的是浏览器原生 prompt（丑、还会卡死自动化）。换成和「全否」一样的正经弹层，理由可空。
3. **分拣不再乱标噪音（PW-50）**。那条 52 赞的「trae 比 cursor 差远了」被 AI 标成了噪音——因为它拿不准「使用体验对比」算哪类。这批给分拣的提示词补上判定标准：使用体验对比/踩坑/价格选型讨论都算选题线索，只有纯灌水/广告/无信息才算噪音；拿不准允许不标（留未分拣），不许硬标。声音行再加个「重分拣」小按钮——标错了点一下让 AI 重分，那条 52 赞的就能翻案。
4. **换方向时能看见每个方向的成绩单（PW-51）**。改方向弹层底部加一张小表：每个方向筛了几轮、出了几张卡、被挑中几张、被否几张、出活率多少。你以后打方向舵不再凭感觉——哪个方向出活、哪个方向净出废卡，数字摆着。

## PW-48 换方向重筛老料（后端派 DeepSeek；前端勾选主代理）

- **主需求域**：内容生产（筛子运行审计职责内）
- **业务接口**：复用「提请/重筛」既有通路；reject-all 端点与 reject_all_and_resieve 工具各加一个可选参数
- **数据真值源**：pw_sieve_runs / pw_sieve_cards / pw_sieve_state（不动结构）
- **关键实现约束（子代理先读再动手）**：
  - `filterUnsieved`（pw-sieve.ts:945）按**所有 done 态 run 的 input_ids_json** 去重——清水位不影响它，所以「重筛老料」**不需要动 watermark**，只需要一条绕过 notifier 层的直通通路
  - 新 export `resieveAllPwSieve(db, options?)`：收集全量输入 ids（三线：pw_corpus_docs status='done' 行 + pw_voice_items 未丢弃行 + pw_data_docs 行——照 collectWatermarkGap :892 的三表口径）→ 直接 `runPwSieve(db, "manual", ids, ...)`（runPwSieve 本体不过滤，过滤只在 notifier 层）；在途 409 与 flushNow 一致；输入全空时直接返回 runId null 不调 LLM；run 成功后 advanceWatermarkFromInput 自然把水位推齐（既有行为，不特判）
  - `POST /api/pw/sieve/reject-all` body 加可选 `resieveAll: boolean`：true 时全否后调 resieveAllPwSieve 替代 flushNow；false/缺省行为与现状逐字一致
  - exec 工具 `reject_all_and_resieve` schema 加可选 `resieveAll`（description 补一句「resieveAll=true 时把现有语料也重过一遍」）；人发话档不变
  - 重复出卡说明写进返回文本：老料重筛可能把挑过的评论再筛出来，候选卡是草稿，人否掉即可
  - 测试：resieveAllPwSieve 能把「已进过 done run 的行」重新筛出卡（mock llm）；空输入不调 LLM；端点/工具 resieveAll 缺省回归（行为逐字一致）；在途 409
  - **前端（主代理）**：全否弹层加勾选项「把现有语料也按新方向重过一遍」，勾选才传 resieveAll:true
- **验收终态**：verify 全绿；真实冒烟（主代理）：全否 6 张卡 + 换方向「AI 办公提效」+ 勾老料重筛 → 真实跑一轮 → runs 行新 direction、新卡 pending、卡脚方向小字更新

## PW-49 单卡否决弹层（纯前端，主代理亲做）

- **主需求域**：内容生产（协作台屏交互）
- **质量约束与验收终态**：
  1. Collab.tsx:247 `reject` 的 `window.prompt` 改为自定义弹层（照 RejectAllModal 范式：理由输入可空、确认/再想想）；PW-36 禁原生对话框纪律补完
  2. 验收：verify 全绿；Playwright 截图核对弹层开/关两态；全仓 grep `window.prompt\|window.confirm` 在 frontend/src 下零命中

## PW-50 分拣标准调优（后端 prompt 派 DeepSeek；前端重分拣按钮主代理）

- **主需求域**：实践与数据回收（声音分拣职责）
- **质量约束与验收终态**：
  1. `classifyPwVoiceItems`（pw-voice.ts:152-157）prompt 调优（只改 prompt 文案，不动流程）：
     - 补四类判定标准：topic_lead=可拍的选题线索（含使用体验对比、踩坑、价格/选型讨论、求测求更）；content_critique=对内容的批评；form_suggestion=对形式/节奏/封面的建议；noise=纯灌水/广告/无信息/表情包
     - 补一条：拿不准的 signal_type 返回 null（留未分拣），禁止硬标
     - prompt 里给一个对照示例（「自从用过 trae 后，感觉这些兴起的 ide 都比 cursor 差远了[笑哭]」→ topic_lead，理由：使用体验对比是选题素材）
  2. 测试（mock llm）：prompt 文本含新纪律关键点（判定标准/null 允许/示例）；解析逻辑回归（合法四类 + null 照常落库）
  3. **前端（主代理）**：声音行加「重分拣」小按钮（ghost 样式，已分拣/未分拣都可点；调既有 POST /api/pw/voice/classify 带该 id；noise 行按钮文案「翻案重分拣」）；api.ts 加 classifyVoice
  4. 验收：verify 全绿；真实观察（主代理）：重分拣真实库那条 52 赞 trae 评论 → 新标签如实记录（预期不再是 noise，但不硬断言——模型行为观察项）；noise 行翻案后可正常提请候选

## PW-51 方向成绩单（后端查询派 DeepSeek；前端小表主代理）

- **主需求域**：内容生产（筛子运行审计的只读聚合）
- **质量约束与验收终态**：
  1. 后端新只读端点 `GET /api/pw/sieve/direction-stats`：按 direction 聚合 pw_sieve_runs JOIN pw_sieve_cards——每行 {direction（NULL 归「默认」）、runs、cards、picked、rejected、pending}；按 runs 降序
  2. 测试：空库返回空数组；两方向各跑过 run 带卡 → 聚合正确；voice_promotion 哨兵 run 计入其 direction 分组
  3. **前端（主代理）**：改方向弹层底部加「方向成绩单」小表（方向/轮数/出卡/挑/否/出活率=挑÷(挑+否)，无挑否记录的显「—」）；弹层打开时拉取；样式沿用弹层灰调小字
  4. 验收：verify 全绿；Playwright 截图核对小表在弹层内不挤压（真实库有「AI 编程工具实测对比」等数据行）

## 防冲突约定

- 子代理只许动：`src/pw-sieve.ts`（加 resieveAllPwSieve + export）、`src/pw-voice.ts`（仅 classify prompt 文案）、`src/pw-collab-tools.ts`（reject_all_and_resieve 加参数）、`src/main.ts`（只加/只扩 reject-all 与新增 direction-stats 路由）、新测试文件、`package.json`、既有测试必要连带
- **不许动**：`frontend/`、`public/`（前端全归主代理）；筛子纪律/方向注入/金线测试零改动；不 commit
- node 24 TS 剥离器不认跨行 as 断言；真实库冒烟归主代理

## 不在本批

- 方向成绩单的进一步可视化（图表/趋势）——先小表，够用
- 分拣的批量重跑（只给单条重分拣按钮；批量真要时再说）
- 老料重筛的去重策略（同评论重复出卡靠人否，不做机器去重）

## 验收记录

### 2026-08-09 PW-48/49/50/51 全批验收通过（DeepSeek 做后端，主代理复核+前端+亲验）

**白话段**：四条尾巴一次清完。①换方向重筛老料：全否弹层多一个勾选「把现有语料也重过一遍」——勾上就是全否 + 换方向 + 老评论全部重筛一次完成（真实跑了一轮：6 张否掉、方向换「AI 办公提效」、179 条老评论重筛出 3 张新卡）。②单卡的「否」换成正经弹层了，不再弹浏览器土对话框。③分拣学乖了：给 AI 的分拣规矩补上「使用体验对比/踩坑/价格选型都算选题线索，只有纯灌水广告才算噪音，拿不准可以不标」——那条被冤枉成噪音的 52 赞 trae 评论，点「重分拣」后翻案成「选题线索·IDE 使用体验对比」，提请按钮随之解禁。声音行都有「重分拣」按钮，标错了随时翻案。④改方向弹层底部多了「方向成绩单」：每个方向筛几轮、出几卡、挑几否几、出活率——「默认」方向 8 卡挑 3 否 5（38%），两个新方向暂无挑否记录。

**验收中抓到并修掉一个既有真 bug**：候选卡的 hover 浮层（看依据的那层）会整卡盖住挑/改/否按钮，真实鼠标根本点不到——之前验收走 DOM 合成点击绕过了命中测试所以一直没暴露，这轮 Playwright 真实指针踩出来了。修复：按钮行抬到浮层之上（z-index），hover 看依据和点按钮两不相碍。这正是「真实指针验收」的价值，留档。

**给干活的看段**：
- verify 主代理亲跑：262/262 全绿（250 基线 + 新增 12），selfcheck ok，前端 build 过
- 真实冒烟（全主代理亲做）：
  - PW-48：POST reject-all {direction:'AI 办公提效', resieveAll:true} → 6 卡否 + run 76bc4c61（manual/AI 办公提效/3 卡/done）+ note 提示；老料重筛实证——新卡含旧语料评论（「太全能了吧…」出自 BV1NprhBPEtR 已 done 的输入，filterUnsieved 确被绕过）；响应含 direction 快照
  - PW-50：POST classify ids=[3155830b] → noise 翻案 topic_lead·IDE使用体验对比；新 prompt 含判定标准/null 允许/对照示例（mock 断言锁定）
  - PW-51：GET direction-stats → 默认（2/8/3/5/0）、AI 编程工具实测对比（2/6/0/0/6，voice_promotion 哨兵计入）；picked 口径含 edited（子代理偏差 1，合理——挑÷(挑+否) 才完整）
  - 模型侧观察留痕：重筛新卡「太全能了吧…」引文开头「这也」二字被吃（语料原文「这也太全能了吧」）——逐字纪律残余风险第 3 例（前两例：PW-42 [笑哭]×3→×1、PW-21 uname 转录错），草稿制兜底，继续观察
- 视觉验收（Playwright 无头 Chrome，/tmp/pw-verify/）：全否弹层勾选态截图、单卡否决弹层截图（hover 后真实点击开出）、改方向弹层成绩单 3 行截图、声音屏重分拣按钮截图（翻案后新徽章+提请解禁）；前端 grep 确认镇纸侧 window.prompt/confirm 真实调用零命中
- 规格口径修正：PW-49 验收项原写「frontend/src 零命中」过苛——探索侧（store.tsx/VerdictPanel/CardStage/ProjectSidebar）4 处 window.prompt 是 Papertable 探索侧既有遗留，不属镇纸 Harness 纪律范围（协作台自动化不触达），记入后续候选另行清理
- 子代理偏差（均接受）：picked 含 edited 口径；resieveAll 在途 409 用 DB running 行判定（独立 export 无 notifier 闭包）；重复出卡提示落响应 note 字段；连带修 pw-verdict-refs.test.ts 偶发硬化（find 按 id 断言替代顺序断言，用例本意不变——全仓未 commit 无法 git diff 核对，已读码确认）
- 主代理亲做部分：前端四点（勾选/单卡弹层/重分拣按钮/成绩单表）+ hover 浮层拦截修复 + 复核 + verify + 全部冒烟与截图验收；未 commit
