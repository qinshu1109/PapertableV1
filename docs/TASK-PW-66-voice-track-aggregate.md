# TASK-PW-66 评论筛子·跨视频桶聚合（赛道轴）

- 主需求域：内容生产
- 业务接口：提供语料与回流数据（实践与数据回收 → 内容生产；筛子判决只读消费——跨视频桶聚合只是把既有 `pw_voice_sieve_runs/items` 按赛道轴重排展示，不写回、不改判）
- 数据真值源：赛道挂载关系落 papertable.sqlite3（新表 `pw_voice_tracks` + `pw_voice_track_videos`）；桶聚合数据真值仍留 `pw_voice_sieve_runs/items` + 语料 comments.jsonl，赛道只是索引（可重建、不复制判决）
- 质量约束与验收终态：真库（~/Library/Application Support/Papertable/papertable.sqlite3）绝对只读，导入/测试走 dev 数据目录；聚合只取每视频最新一条 done run（无 run 视频跳过并在 videos 里标 hasRun:false）；8 桶口径与 skill 固定桶一致，空桶也返回（count:0）；条目带 bvid 标注来源视频；挂视频幂等、摘视频幂等

## 这刀是干什么的

一个选题赛道会盯多个视频。PW-65 的单视频筛子结果（8 桶判决）只按 bvid 分开摆盘，赛道要横向看「所有视频的同一个桶」——比如把某赛道下所有视频的「求助」桶并成一池，就是它的需求池。本刀在筛子模块上加一条赛道轴：建赛道、往赛道里挂/摘视频，以及跨视频按桶聚合（桶 count 合并、每桶 top3 按赞、全量信号条目带来源 bvid）。

## 怎么算好

- 一个赛道下每个视频都筛过：聚合按桶把跨视频的信号合并，桶 count 是各视频该桶信号之和；每桶展示赞最多的前 3 条原文，条目上标着它来自哪个 bvid。
- 某视频还没筛过（无 done run）：聚合不猜、不补，该视频在 `videos` 里以 `hasRun:false` 列出，桶里没有它的条目。
- 往赛道挂视频重复挂不报错、摘不存在的视频不报错——赛道操作幂等，前端随便点。
- 一个视频在赛道里只有一份（`PRIMARY KEY(track_id,bvid)`），重复挂不产生重复行。

## 依据

- 前置刀 TASK-PW-65（`docs/TASK-PW-65-voice-sieve-frontend.md`）：`pw_voice_sieve_runs/items` 建表、`importPwVoiceSieveRun` 导入、`getPwVoiceSieveRun` 单视频查询（8 桶结构、按 totalLikes 降序、top3、signals 按桶展开、条目字段 = rpid/uname/message/like/ctime + bucket/reason）。
- 既有模式：建表/startup 挂接照 `src/pw-voice-cards.ts`（ensureXxxTables + main.ts createApp）；路由分发照 `src/main.ts` `/api/pw/voice/sieve-runs` 段（`match = path.match(...)` + `json(response, status, asBadRequest(...))`）；错误带 status 原样透传，普通 Error 经 `asBadRequest` 归 400。
- 需求域边界：`docs/REQUIREMENT-DOMAINS.md`（跨域接口「提供语料与回流数据」只读消费语料与判决）；`docs/ASSEMBLY.md` 组装纪律。

## 设计

### 数据（新表，幂等建表，同模块 ensure 函数）

```sql
CREATE TABLE IF NOT EXISTS pw_voice_tracks (
  id TEXT PRIMARY KEY,          -- uuid
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pw_voice_track_videos (
  track_id TEXT NOT NULL,
  bvid TEXT NOT NULL,
  PRIMARY KEY (track_id, bvid)  -- 幂等挂载：重复挂不产生重复行
);
```

`ensurePwVoiceTrackTables` 挂在 `src/main.ts` createApp 启动，与 `ensurePwVoiceSieveTables` 并列。

### 流程

模块 `src/pw-voice-sieve.ts` 内新增（不新建文件）：

1. `createPwVoiceTrack(db, name)` → uuid + createdAt，返回 `{id,name,createdAt}`；name 必填，坏输入 400。
2. `listPwVoiceTracks(db)` → `[{id,name,createdAt,videos:[bvid…]}]`，按建赛道先后，每赛道 videos 按挂载先后（rowid 序）。
3. `addPwVoiceTrackVideo(db, trackId, bvid)` → `INSERT OR IGNORE`（幂等），校验 BV 号（400）与赛道存在（404），返回挂载后的赛道。
4. `removePwVoiceTrackVideo(db, trackId, bvid)` → DELETE（摘不存在的视频幂等），返回摘下后的赛道。
5. `aggregatePwVoiceTrack(db, trackId)` → `{track, videos, buckets, signals}`：
   - 对赛道下每个 bvid 取最新一条 done run（`WHERE bvid=? AND status='done' ORDER BY created_at DESC, id DESC LIMIT 1`）；
   - videos：`[{bvid, runId, signal, noise, hasRun}]`（signal/noise 取该 run 计数；无 run 的视频 `hasRun:false` 且 runId/signal/noise 为 null，不出桶）；
   - buckets：8 桶全返（空桶 count:0,totalLikes:0,top:[]），按 totalLikes 降序（并列按固定桶序），每桶 `{bucket,count,totalLikes,top:赞降序前 3 条}`；
   - signals：`{桶名:[该桶全部信号条目（赞降序）]}`，8 桶恒在，桶为 null 的信号归 "null" 键；
   - 条目 = 原 PwVoiceSieveItem 字段（rpid/uname/message/like/ctime + bucket/reason）多一个 `bvid` 标注来源视频；语料按 rpid join（拉平 replies），语料文件被删时原文字段留空并 console.warn，不吞其他错误。

`displayItem` 增加可选第三参 bvid：单视频查询不传（PW-65 契约不变，条目无 bvid 字段），聚合查询传入（条目带 bvid）。

### 端点

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/pw/voice/sieve-tracks` | GET | `{tracks:[{id,name,createdAt,videos:[bvid…]}]}` |
| `/api/pw/voice/sieve-tracks` | POST | `{name}` → 新建，201 |
| `/api/pw/voice/sieve-tracks/{id}/videos` | POST | `{bvid}` → 挂视频（幂等） |
| `/api/pw/voice/sieve-tracks/{id}/videos/{bvid}` | DELETE | 摘视频（幂等） |
| `/api/pw/voice/sieve-tracks/{id}/aggregate` | GET | `{track, videos, buckets, signals}`（跨视频桶聚合） |

### 纪律

- 真库绝对只读：本刀所有写入只发生在 dev 数据目录；测试用 `:memory:` + 临时目录。
- 赛道是纯索引：只存 track_id/bvid 挂载关系，不复制判决、不写回筛子表；聚合全部从 `pw_voice_sieve_runs/items` + 语料 join 现算。
- 8 桶口径与 skill 固定桶逐字一致；不发明新桶。
- 幂等：挂视频 INSERT OR IGNORE、摘视频 DELETE 不存在即无操作，不报错。
- 无 run 视频不猜不补：hasRun:false 明确标记，桶里无其条目。

## 分工

- 本次交付：`src/pw-voice-sieve.ts`（同模块加 ensure + 赛道 CRUD + 聚合）、`src/pw-voice-sieve-track.test.ts`（新建）、`src/main.ts`（5 条路由 + startup 建表 + 导入）、`package.json`（登记测试）、`docs/TASK-PW-66-voice-track-aggregate.md`（本刀文档）。
- 前端（另立批次）：消费 sieve-tracks 五端点摆盘赛道轴。

## 验收记录（2026-08-12）

**什么能用了**：赛道五端点可用。建赛道/列赛道（含各自 videos）、挂视频幂等、摘视频幂等、跨视频桶聚合（桶 count 合并、top3 跨视频按赞、全量信号条目带 bvid、无 run 视频 hasRun:false 不出桶、8 桶全返）。聚合为只读现算，不写回筛子表。

**什么还不行**：前端还没有赛道轴视图（另立批次）；真实赛道数据（多视频挂载 + 聚合对账）留给验收时执行，未在交付中代跑。

**有什么等拍板**：①赛道聚合的 videos 排序取挂载先后（rowid 序），若前端更想要 BV 字典序可改；②无 run 视频的 signal/noise 取 null（无 run 无从计数），前端展示时按 hasRun 判断即可。

测试证据：`PATH="$HOME/.local/node/bin:$PATH" node --test src/pw-voice-sieve-track.test.ts` 全绿（4 用例）；`src/pw-voice-sieve.test.ts` 回归全绿。

改动文件：`src/pw-voice-sieve.ts`（ensurePwVoiceTrackTables + create/list/add/remove/aggregate + displayItem bvid 参）、`src/pw-voice-sieve-track.test.ts`（新）、`src/main.ts`（5 条路由 + startup + 导入）、`package.json`（登记测试）、`docs/TASK-PW-66-voice-track-aggregate.md`（新）。未 commit、未 push、未动 frontend/。
