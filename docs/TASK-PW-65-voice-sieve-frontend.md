# TASK-PW-65 观众声音·筛子结果进前端（判决落库 + 查询 + 右栏摆盘）

- 主需求域：实践与数据回收
- 业务接口：提供语料与回流数据（筛子判决只读消费——外部 skill 产出的逐条判决经本刀导入本库并供前端摆盘，内容生产 ← 实践与数据回收，接口语义不变）
- 数据真值源：判决结果落 papertable.sqlite3（新表 `pw_voice_sieve_runs` + `pw_voice_sieve_items`，由 skill 产物导入、可整体重建）；评论原文真值仍留语料库（data/corpus/{bvid}/comments.jsonl），不落库重复存，查询按 rpid join
- 质量约束与验收终态：语料库只读纪律（导入仅在语料缺失时补录 `pw_corpus_docs`，既有 done 语料一字不动）；对账不过不落库（rpid 无重无漏、signal+noise=total，失败 400 + missing/extra/dup 列表）；真库（~/Library/Application Support/Papertable/papertable.sqlite3）绝对只读，导入/测试走 dev 数据目录；8 桶口径与 skill 固定桶一致，空桶也返回（count:0）

## 这刀是干什么的

观众声音屏右栏的语料评论，现在由外部跑一遍「评论筛子」（AI 逐条判有没有信息量：广告/玩梗/纯表情/灌水是噪音，其余按 8 个固定桶分组）。筛子跑完留下的是每个视频一份的判决文件（逐条：这条是信号还是噪音、进哪个桶、为什么）。本刀把这些判决**存进镇纸的库**，并给屏上摆盘提供查询：选一个视频能看到它筛过几次、每次的信号/噪音数、8 个桶各有多少条、每桶赞最多的几条原文、以及全部噪音——人看的还是逐字原文，不替人下结论。

刀一（本次交付）= 后端：判决导入落库 + 三条查询路由 + 测试。刀二 = 前端右栏三层密度视图（另立批次）。

## 怎么算好

- 把一份判决目录（一个视频的 batch-*.jsonl）导入后，这个视频在库里有了一条 run：总条数 = 信号 + 噪音，两边都对得上语料评论数，一条不多一条不少。
- 判决对不上语料（少了条、多出条、或同一条判了两遍）时：**什么都不落**，并明确告诉差在哪（缺了哪些 rpid、多了哪些、哪几个重复）。
- 视频评论还没进语料库时，导入会顺手把评论补进语料库（评论区真值照原样抄一份，标题/UP 主有就带、没有留空）；已进过的视频一字不动。
- 查一个 run：8 个桶全在（空桶写 0），按桶内总赞从高到低排；每桶展示赞最多前 3 条原文（作者/赞数/时间齐）；全部信号按桶展开、全部噪音按赞从高到低——都是逐字原文，不概括。
- 现有 2 个真实判决（BV1dEuZ6mEii 1180 条、BV1Ncs1z2Ego 392 条）能导入并能查到对得上数的结构。

以下给干活的看，可以跳过。

## 依据

- wayfinder 地图：`docs/wayfinder/voice-theme-cards/`（Q01 筛子转向，PW-64 修订）。
- 判决格式（skill 产物，实测真实数据）：`results/{bvid}/batch-*.jsonl`，每行 `{"rpid":"字符串","verdict":"signal|noise","bucket":"对比|价格|bug反馈|功能|求助|场景|建议|评价|null","reason":"..."}`；实测数据里存在 `"bucket":"null"` 字符串，导入归一为 NULL。
- 语料真值：`pw_corpus_docs`（bvid/title/up_name/status/path/comment_count），正文在 `PAPERTABLE_DATA_DIR/corpus/{bvid}/comments.jsonl`，单条 `PwCorpusCommentDetail{rpid,uname,message,like,ctime,replies}`；`readPwCorpusComments` 按行读、rpid 为 number。
- 爬虫原始 json（实测）：`{fetched_at,source_url,reported_comment_count,visible_comment_count,root_comment_count,reply_count,comments:[{rpid,author:{name,…},text,likes,created_at,replies:[递归]}]}`（无 data 包裹）；任务简报里描述的 `{data:{comments:[…]}}` 形态（B站 view API 常见）也要兼容，title/owner.name 从 data 里取，取不到留空。
- 既有模式：建表/startup 挂接照 `src/pw-voice-cards.ts`（ensureXxxTables + main.ts createApp），路由分发照 `src/main.ts` `/api/pw/voice/corpus-cards` 段；错误带 status 原样透传，普通 Error 经 `asBadRequest` 归 400。

## 设计

### 数据（新表，幂等建表）

```sql
CREATE TABLE IF NOT EXISTS pw_voice_sieve_runs (
  id TEXT PRIMARY KEY,
  bvid TEXT NOT NULL,
  provider TEXT NOT NULL, model TEXT NOT NULL,
  total INTEGER NOT NULL, signal INTEGER NOT NULL, noise INTEGER NOT NULL,
  reassigned INTEGER NOT NULL DEFAULT 0,   -- 重派批数
  report_path TEXT,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'done'
);
CREATE TABLE IF NOT EXISTS pw_voice_sieve_items (
  run_id TEXT NOT NULL,
  rpid TEXT NOT NULL,                       -- 判决原文的 rpid（字符串），语料 join 时 String() 对齐
  verdict TEXT NOT NULL CHECK(verdict IN ('signal','noise')),
  bucket TEXT,                              -- NULLable；"null"/空串归一 NULL
  reason TEXT,                              -- 判决理由（skill 产物自带，落库备查，查询一并返回）
  PRIMARY KEY (run_id, rpid)
);
CREATE INDEX IF NOT EXISTS pw_voice_sieve_runs_bvid ON pw_voice_sieve_runs(bvid, created_at);
```

### 流程

1. **导入 `importPwVoiceSieveRun(db, input, {dataDir})`**（同步，文件 I/O 照 pw-corpus 用 read/writeFileSync）：
   a) 语料补录：`pw_corpus_docs` 无此 bvid → 从 commentsPath 读评论（`.jsonl` 已是 PwCorpusCommentDetail 每行一条，逐行归一；`.json` 为爬虫原始格式，递归拉平 replies 成行，`created_at` ISO → ctime 秒、`likes`→like、`author.name`→uname、`replies` 数组长度→replies 数），写 `dataDir/corpus/{bvid}/comments.jsonl`，`authorizePwCorpus`+`donePwCorpus` 注册（status done、comment_count=拉平总数、title/up_name 有则带）；既有 done 语料直接复用不重写；pending/fetching 409；failed/needs_human/proposed force 重置补录。
   b) 读 resultsPath 目录下全部 `batch-*.jsonl`（按文件名排序），逐行校验（rpid 非空、verdict ∈ {signal,noise}、bucket ∈ 8 桶或归一 NULL），坏行 400 带文件/行号。
   c) 对账：语料 rpid 全集（String 化）对比判决——缺漏 missing / 多余 extra / 重复 dup 任一非空或 signal+noise≠total → `httpError(400, "对账失败：…", {reconcile:{ok:false,missing,extra,dup,signal,noise,total}})`，不落库。
   d) 通过：事务内 insert run + items，返回 `{runId,total,signal,noise,buckets:{桶:数},reconcile:{ok:true}}`（8 桶恒在，信号桶为 null 时按 "null" 计数）。
2. **查询 `getPwVoiceSieveRun(db, runId)`**：读 items + `readPwCorpusComments(db, run.bvid)` 按 rpid join（拉平 replies 后的逐条）；条目字段 = rpid/uname/message/like/ctime（+reason，信号条带 bucket）；返回 `{run, buckets, signals, noise}`：
   - buckets：8 桶全返回（空桶 count:0,totalLikes:0,top:[]），按 totalLikes 降序（并列按桶序），每桶 `{bucket,count,totalLikes,top:赞降序前 3 条}`；
   - signals：`{桶名:[该桶全部信号条目（赞降序）]}`，8 桶恒在，桶为 null 的信号归 "null" 键；
   - noise：全部噪音条目（赞降序）。
   - 语料文件被删时条目原文字段留空并 console.warn，不吞其他错误。
3. **列表 `listPwVoiceSieveRuns(db, bvid)`**：该 bvid 全部 run，created_at 新在前。

### 端点

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/pw/voice/sieve-runs/import` | POST | `{bvid, resultsPath, commentsPath, reportPath?, provider, model, reassigned?}`；对账不过 400 + reconcile 详情；成功 201 |
| `/api/pw/voice/sieve-runs?bvid=` | GET | run 列表（新在前） |
| `/api/pw/voice/sieve-runs/{id}` | GET | `{run, buckets, signals, noise}` |

`httpError` 扩展第三个可选参数 details（向后兼容），服务端错误响应在带 details 时附加 `details` 字段——供 400 对账详情结构化返回。

### 纪律

- 真库绝对只读：本刀所有写入只发生在 dev 数据目录（`PAPERTABLE_DATA_DIR` 指向的库与 corpus）。
- 评论原文不落库重复存：sieve 表只存 run 元数据 + 判决（rpid/verdict/bucket/reason），原文永远从语料文件 join。
- 对账不过不落库；导入是事务性的一次成功/失败，无半截 run。
- 8 桶口径与 skill 固定桶逐字一致；不发明新桶。

## 分工

- 刀一·后端（本次交付）：新模块 `src/pw-voice-sieve.ts` + 测试 `src/pw-voice-sieve.test.ts` + `main.ts` 挂路由/startup + `data.ts` httpError 扩展 + 本 TASK 文档。
- 刀二·前端（另立批次）：`frontend/src/pw/Voice.tsx` 右栏消费 sieve-runs 三端点（桶卡目录 / 桶内 top3 / 附录与噪音区），依赖刀一就位。

## 验收记录（刀一，2026-08-11，后端交付）

**什么能用了**：判决导入落库 + 查询三路由可用。导入自动补语料（缺失时）或复用既有语料；对账不过返回 400 且带 missing/extra/dup 明细，什么都不落；查询返回 8 桶全量结构（空桶 0）、每桶 top3、全量信号/噪音，条目字段从语料 comments.jsonl 按 rpid join。

**什么还不行**：前端右栏还没有消费这三条路由（刀二未开始）；真实数据（BV1dEuZ6mEii 1180 条 / BV1Ncs1z2Ego 392 条）的导入留给验收时执行，未在交付中代跑。

**有什么等拍板**：①导入 body 直接给本机路径（resultsPath/commentsPath），是否要加允许路径白名单；②reason 字段随判决落库并随查询返回（任务表结构只列了 rpid/verdict/bucket，reason 为补充列，前端摆盘大概率要用）。

测试证据：`PATH="$HOME/.local/node/bin:$PATH" node --test src/pw-voice-sieve.test.ts` 全绿；回归 `npm run verify` 全绿（见交付汇报）。

改动文件（刀一）：`docs/TASK-PW-65-voice-sieve-frontend.md`（新）、`src/pw-voice-sieve.ts`（新）、`src/pw-voice-sieve.test.ts`（新）、`src/data.ts`（httpError 详情参数）、`src/main.ts`（3 条路由 + startup 建表）、`package.json`（登记测试）。未 commit、未 push。
