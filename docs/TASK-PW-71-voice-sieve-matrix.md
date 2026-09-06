# TASK-PW-71 筛子多版本交叉检出矩阵

- 主需求域：内容生产
- 业务接口：提供语料与回流数据（实践与数据回收 → 内容生产；本刀只读消费筛子判决与语料评论，不改判、不落新表、不写回收侧数据）
- 数据真值源：只读 `pw_voice_sieve_runs` / `pw_voice_sieve_items` + 语料库 comments.jsonl；本刀无任何数据写入
- 质量约束与验收终态：真库（~/Library/Application Support/Papertable/papertable.sqlite3）绝对只读，测试走 dev 数据目录；纯 GET 聚合端点，无 AI 调用；不动 frontend/；不 commit

## 这刀是干什么的

同一个视频的评论，我们会用不同模型各筛一版（DeepSeek 一版、codex 一版、luna 一版……）。现在每版结果各看各的，哪条评论在几版里都被挑出、哪条只有一版挑出、哪个桶在这版有货那版空空，全靠自己脑内对账。本刀加一个「交叉验证」查询：把一个视频的全部筛子版本摆在一起对账——每条被挑出过的评论，标注它在哪些版本被挑出、进了什么桶、在哪些版本被判了噪音；每个桶标注各版本各检出多少条。多版都挑的（复现）天然浮在最上面，只有一版挑的（异议）也整队可见，不会被平均掉。

依据的思路：多版筛子是多个灵敏度不同的传感器，不是评委投票；没在某版出现 ≠ 被否定（只是该版判了噪音，记录事实不下结论）。

## 怎么算好

- 查一个视频的交叉矩阵：返回该视频全部已完成筛子版本列表（模型、时间、信号/噪音数）。
- 桶矩阵：8 桶每个桶在每个版本里检出几条信号，一眼看出「功能桶 A 版 49 条 B 版 3 条」这种灵敏度差。
- 评论并集：只要任一版本判过信号的评论都在列，每条带：原文、昵称、赞数、被哪些版本判信号（含各自桶名）、被哪些版本判噪音、判信号的版本数、判信号的模型家族数（同一 provider+model 的多个版本只算一个家族，伪复现不加分）。
- 排序：判信号的版本数多的在前，并列按赞数降序——复现队列在上、单版独有队列在下，一次返回不分页。
- 该视频还没有任何筛子版本时正常返回空结构（runs 空数组），不报错。
- 全程只读：不建表、不改行、不调模型。

## 依据

- 数据与 join 模式：`src/pw-voice-sieve.ts`——`getPwVoiceSieveRun`（243-308 行）的语料 join 与容错（语料被删时原文字段留空、不吞其他错误）、`displayItem`、`byLikesDesc`、`runToPublic` 直接复用。
- 路由模式：`src/main.ts` 936-956 行（`/api/pw/voice/sieve-runs` 段的 GET 带 query 写法）。
- 测试模式：`src/pw-voice-sieve.test.ts`（临时目录 openDataStore、importPwVoiceSieveRun 造数）。
- 需求域边界：`docs/REQUIREMENT-DOMAINS.md`（跨域接口「提供语料与回流数据」只读消费）。

## 以下给干活的看，可以跳过

### 端点

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/pw/voice/sieve-matrix?bvid={bvid}` | GET | 该 bvid 全部 done run 的交叉检出矩阵；bvid 缺失/非法 400 |

### 响应契约（camelCase，现有 json() 包裹）

```jsonc
{
  "bvid": "BV…",
  "runs": [ /* 全部 done run，created_at 新在前，字段同 runToPublic，另加 family */ 
    { "id": "…", "provider": "…", "model": "…", "family": "provider/model",
      "total": 1180, "signal": 825, "noise": 355, "createdAt": "…", "status": "done" }
  ],
  "summary": {
    "runCount": 3,
    "familyCount": 2,            // 去重后的 provider/model 家族数
    "unionSignals": 900,         // 任一 run 判过 signal 的 rpid 数
    "consensusSignals": 700,     // 全部 run 都判 signal 的 rpid 数（runCount=0 时为 0）
    "singletonSignals": 120      // 恰好只有 1 个 run 判 signal 的 rpid 数
  },
  "bucketMatrix": [              // 8 桶恒在，按 total 降序，并列按 PW_VOICE_SIEVE_BUCKETS 原序
    { "bucket": "功能", "total": 60, "perRun": [ { "runId": "…", "count": 49 }, … ] }
  ],
  "items": [                     // 任一 run 判过 signal 的 rpid 并集
    {
      "rpid": "…", "uname": "…", "message": "…", "like": 12, "ctime": 1723…,
      "signalRuns": [ { "runId": "…", "bucket": "功能", "reason": "…" } ],
      "noiseRuns": [ "runId…" ],
      "signalRunCount": 2,
      "familyCount": 1           // 判信号的 run 去重家族数
    }
  ]
  // items 排序：signalRunCount 降序 → familyCount 降序 → like 降序（like null 垫底）→ rpid 字典序
}
```

### 实现

- `src/pw-voice-sieve.ts` 追加 `getPwVoiceSieveMatrix(db, bvidRaw)`（同模块不新建实现文件）：
  1. bvid 必填校验（400），不校验存在性——无 run 返回空结构（runs: []、summary 全 0、bucketMatrix 8 桶 perRun 全空数组、items: []）。
  2. 取该 bvid 全部 `status='done'` run（created_at 新在前）；每个 run 的 items 一次查出。
  3. 语料 join 一次（comments Map），容错逻辑照抄 getPwVoiceSieveRun 的 try/catch。
  4. 聚合：rpid → { signalRuns:[{runId,bucket,reason}], noiseRuns:[runId] }（同一 rpid 在同一 run 只有一行，PK 保证）。
  5. family = `${provider}/${model}`；familyCount 用 Set 去重。
- `src/main.ts` 在 PW-65 段后追加 GET 路由（query 取 bvid，asBadRequest 不需要——GET 参数缺失直接 httpError(400) 由既有错误通道出去，参照同文件 GET 段惯例）。

### 测试 `src/pw-voice-sieve-matrix.test.ts`

1. 两个 run（不同家族）部分重合：重合 rpid signalRunCount=2/familyCount=2；独有 rpid 各 signalRunCount=1；一桶两版计数不同，bucketMatrix 体现。
2. 同家族两版（同 provider+model 不同 run）：重合 rpid signalRunCount=2 但 familyCount=1（伪复现不加分）。
3. 分歧 rpid：A 版 signal（带桶）B 版 noise → signalRuns 一条、noiseRuns 含 B。
4. 同 rpid 两版判不同桶：signalRuns 两条各自带桶。
5. 无 run 的 bvid：200 空结构；缺 bvid 参数：400。
6. 排序断言：signalRunCount 降序、并列 like 降序。

### 纪律

- 纯只读聚合：不开事务、不写行、不建表（表由 PW-65 ensure 保证，直接复用 ensurePwVoiceSieveTables）。
- 不改既有端点行为；不动 frontend/；不 commit、不 push。
- 验收命令：`PATH="$HOME/.local/node/bin:$PATH" npm test`（全量绿，含新测试文件）。
