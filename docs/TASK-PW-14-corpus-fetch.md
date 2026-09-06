# TASK-PW-14 定向语料通路（关注视频数据与评论落本地）

- 状态：进行中
- 主需求域：实践与数据回收
- 业务接口：无（域内新增语料获取与索引；向「判断沉淀与复用」供检索走 PW-15 装配，不进本任务）
- 数据真值源：pw_corpus_docs（新表，索引与授权记录）；语料正文为本地文件 `data/corpus/{bvid}/`（meta.json + comments.jsonl）
- 质量约束与验收终态：人工授权制（界面或对话里人点一次「获取」，抓取只打已授权条目，无白名单表）；公开数据不哈希（作者昵称原样存）；低频（单次运行 ≤3 条、同 bvid 7 天内不重复抓、撞风控 needs_human 交人）；`npm run verify` 全绿；用真实 BV 端到端抓通一次（meta+评论落盘、FTS 可检索）

## 背景与三项决定（2026-08-04 用户拍板）

P2 协作台需要「定向获取我关注的视频数据和评论并下载到本地」。定：
1. **人工授权制**：不做白名单表。授权动作 = 人在界面/对话里对某个 BV 点一次「获取」；抓取器只处理授权队列。
2. **公开数据不哈希**：评论作者昵称、UP 主名原样存储（公开数据，不套 pw_voice_items 的哈希纪律）。
3. **function-calling**（PW-15 用，本任务只交付语料层）。

与原军规的关系：「仅自己账号」管后台数据通路（不变）；本任务是**公开数据通路**，纪律改为「人工授权 + 低频配额 + 风控交人」。

## 范围

### 后端（src/）

1. 迁移 `pw_corpus_docs`：id, bvid UNIQUE, title, up_name, kinds('video,comments'), status(pending/fetching/done/needs_human/failed), path, sha256, video_stat_json, comment_count INTEGER, authorized_by DEFAULT 'human', error, fetched_at, created_at。
2. FTS5 虚表 `pw_corpus_fts(bvid UNINDEXED, uname, message)`：done 时按 bvid 重建该条评论索引。
3. API：
   - `POST /api/pw/corpus` {bvid, kinds?, note?} → 登记授权（bvid 已存在则按状态返回：pending/done 直接返回既有；done 且 force=1 → 重置 pending 重抓）。
   - `GET /api/pw/corpus` → 全量列表（数据源屏用）。
   - `GET /api/pw/corpus/pending` → 抓取器取队列（status=pending，按 created_at 正序）。
   - `POST /api/pw/corpus/:id/fetching` / `:id/done` {title, upName, path, sha256, videoStat, commentCount} / `:id/fail` {status: needs_human|failed, error} → 抓取器回报；done 时事务内更新 FTS。
   - `GET /api/pw/corpus/search?q=` → FTS 命中 {bvid, uname, snippet, like} 上限 20 条。
4. 测试：授权幂等、状态机、done 写 FTS、search 命中、fail 留 error。

### 抓取器（scripts/pw-fetch-bili-corpus.js，ego-browser 运行）

1. `GET /api/pw/corpus/pending`，无则退出；单次最多处理 3 条。
2. 每条：打开 `https://www.bilibili.com/video/{bvid}`；登录墙/验证码/`code:-352/-412` → fail(needs_human) 并整体退出。
3. 浏览器上下文内 fetch：`x/web-interface/view?bvid=`（标题/UP主/stat：播放/弹幕/评论/收藏/硬币/分享/点赞）→ 写 meta.json；`x/v2/reply?type=1&oid={aid}&sort=2&ps=20` 翻页（页间 sleep ≥1.5s，上限 100 条）→ comments.jsonl（每行 {rpid, uname, message, like, ctime, replies}）。
4. 文件写 `data/corpus/{bvid}/`（数据目录约定跟 store 走），算 sha256，`POST done`。
5. 同 bvid 7 天内已 done 的跳过（FORCE=true 覆盖）。不内置循环；由会话 cron 每日顺带排空，或授权后手动跑一次。

### 数据源屏增量（frontend/src/pw/Sources.tsx 小改）

回流数据文档表上方加一个「定向语料」小节：已授权条目列表（bvid、标题、状态徽章 pending→排队中/done→已落盘 N 评论/needs_human→待人工、获取时间）+ 「登记获取」按钮（弹层填 BV 号/链接 → POST /api/pw/corpus → toast「已授权，下次同步时抓取；也可让我立刻跑」）。样式沿用 doc-list/platform 卡 token，不新造视觉语言。

## 不做

- 语料检索进协作台装配（PW-15）；自动同步关注列表；视频文件本体下载（只要数据与评论）；MediaCrawler 集成。

## 验收

1. `npm run verify` 全绿（含新增测试）。
2. 真实端到端：登记 BV1NprhBPEtR（用户关注的科普视频）→ 跑抓取器 → meta.json/comments.jsonl 落盘且内容正确（标题/UP主/统计数、评论 ≥50 条带昵称）→ `GET search?q=` 命中评论。
3. 数据源屏 1440×900 截图：定向语料区显示该条目「已落盘」。
4. 风控路径：fail(needs_human) 在数据源屏可见。

## 验收记录（2026-08-04）

1. ✅ 构建：`npm run verify` 全绿（61 个后端测试含 pw-corpus 7 例、selfcheck、tsc、vite build）。
2. ✅ 真实端到端：登记 BV1NprhBPEtR（洛唐科普全流程，用户关注）→ 抓取器跑通 → meta.json（播放 158,550 / 评论 417 / UP主 做视频的洛唐）+ comments.jsonl 100 条（上限封顶，昵称原样）落盘 `~/Library/Application Support/Papertable/corpus/BV1NprhBPEtR/` → `search?q=工作流`（FTS trigram）与 `q=分镜`（短词 LIKE 回退）均命中且高亮。
3. ✅ 数据源屏 1440×900 截图：「定向语料」区显示该条目「已落盘 · 100 评论」，「登记获取」弹层可用；B站连接卡不受影响。
4. ✅ 实现中修正两处：评论接口跨域不带凭证只回 3 条热评（browserFetch 加 `credentials:'include'` 后翻页正常）；FTS trigram 不覆盖 <3 字中文查询（加 LIKE 回退 + 测试，通配符按字面处理）。
5. 每日触发：会话 cron `784abedf`（06:47 本地）依次跑 B站同步 + 语料排空并简报；授权后想立刻抓可手动 `ego-browser nodejs < scripts/pw-fetch-bili-corpus.js`。
6. 遗留：评论上限 100 条/视频（低频纪律）；reply 接口在更高频或更大页数下是否触发风控未知，遇到即 needs_human 交人。
