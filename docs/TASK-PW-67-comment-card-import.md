# TASK-PW-67 筛子精选评论导入探索区卡片

- 主需求域：内容生产
- 业务接口：提供语料与回流数据（实践与数据回收 → 内容生产；筛子精选评论经本刀静态落成探索区 root 卡，只读消费判决/语料，不跑 AI、不改判、不写回收侧数据）
- 数据真值源：导入落 papertable.sqlite3（`pt_cards` 新行 + Pi session transcript 一条 user 消息）；评论原文逐字进 transcript，来源（platform/bvid/rpid/uname/like）落 `branch_context_json.source`
- 质量约束与验收终态：真库（~/Library/Application Support/Papertable/papertable.sqlite3）绝对只读，测试走 dev 数据目录；导入是静态落卡，绝不触发 AI run（不调 startRun/executeRun，pt_runs 无该卡记录）；同项目内已导入的相同 rpid 跳过并分报 skipped；cards 上限 50 张超出 400；字段缺失 400 带卡片序号；不动 frontend/；不 commit

## 这刀是干什么的

PW-65/PW-66 把筛子判决落库并按赛道聚合，但探索区（对话/卡片）还看不到这些精选评论。本刀在探索区加一个入口：把筛子精选的评论一次性落成 root 卡——每张卡自带独立 session 和一条 user 消息（评论原文 + 来源行），人进探索区能直接接着这条评论追问，不用重新粘原文。导入是纯落盘：不跑任何 AI，卡状态就是「有人把评论放进来了」，后续照常挑/改/否。

## 怎么算好

- 导入一批精选评论后，每张评论在探索区是一张 root 卡，标题、正文（评论原文 + 末尾来源行「—— B站 {bvid} @{uname} · {like}赞 · rpid:{rpid}」）都在，点开就能继续对话。
- 来源信息（平台/BV/rpid/昵称/赞数）落在卡的 `branch_context_json`，不污染标题和正文。
- 同一批或跨批重复导同一批 rpid：不产生重复卡，响应分报 `{imported:[cardId…], skipped:[rpid…]}`，前端能直接提示「2 张已导入、3 张已存在」。
- 全程零 AI 调用：导入这一下不花钱、不占 run、不触发闸门。

## 依据

- 卡与 session 建法：`src/engine.ts` `createRootCard`（142-164 行）——`this.sessions.create({cwd: sessionCwd(projectId), metadata:{projectId,kind:"root"}})` 拿 session_id，`INSERT INTO pt_cards`（branch_kind='root'、source_card_id=NULL、branch_context_json）；本刀照抄前半段但**不调 startRun**。
- transcript 写消息：`src/sessions.ts` `openSessionById`/`closeSession`/`activeConversation`；user 消息用 `session.appendMessage({role:"user", content, timestamp})`（engine 概念卡提升段同款写法）。
- 表结构：`src/data.ts` `pt_cards`（session_id TEXT NOT NULL UNIQUE、branch_kind CHECK('root'…)、source_card_id NULL、branch_context_json TEXT）、`pt_runs`（card_id 关联，导入不写它）。
- 路由模式：`src/main.ts` `POST /api/projects`（createProject 201）与 `POST /api/projects/:id/cards`（createRootCard）段。
- 需求域边界与组装纪律：`docs/REQUIREMENT-DOMAINS.md`（跨域接口「提供语料与回流数据」只读消费）、`docs/ASSEMBLY.md`。

## 设计

### 流程

`PapertableEngine.importCommentCards(projectId, cards)`（`src/engine.ts` 新方法，同模块不新建文件）：

1. 校验：`requireProject`（404）；cards 非数组/空 → 400；>50 张 → 400。
2. 去重集合：一次查项目内全部非空 `branch_context_json`，`sourceRpid` 解析出各卡来源 rpid，字符串化为 Set。
3. 逐卡（结构校验先过，非法字段抛 400 带「第 N 张卡片缺 …」）：
   a. rpid 已在集合 → `skipped` 收进 rpid，continue；
   b. `this.sessions.create({cwd: sessionCwd(projectId), metadata:{projectId,kind:"root"}})` 拿 session_id；
   c. `INSERT INTO pt_cards(id, project_id, session_id, title, branch_kind, source_card_id, branch_context_json, created_at, updated_at)`：branch_kind='root'、source_card_id=NULL、branch_context_json=`{"source":{platform,bvid,rpid,uname,like}}`（rpid/like 落 number，uname 缺省空串，platform 缺省 "bilibili"）；
   d. `session.appendMessage({role:"user", content: message + "\n\n" + 来源行, timestamp})`；
   e. `closeSession`；rpid 入集合；`imported` 收进 cardId。
4. 返回 `{imported:[cardId…], skipped:[rpid…]}`。同批内重复 rpid 也走 skipped（第 2 步集合在导入中实时更新）。

校验细节：title/message/source/source.bvid/source.rpid 必填，message 上限 20 000 字符，rpid 须为非负整数（number 或数字字符串，归一 number 存储），like 可选非负整数（缺省 0），title 经 `cleanTitle`（折叠空白、截 100、空则「未命名卡片」）。

### 端点

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/projects/{id}/cards/import` | POST | body `{cards:[{title,message,source:{platform,bvid,rpid,uname,like}}]}` → 201 `{imported:[cardId…],skipped:[rpid…]}`；项目不存在 404、无 cards/超 50/字段缺失 400 |

### 纪律

- 真库绝对只读：本刀所有写入只发生在 dev 数据目录；测试用 `openDataStore(临时目录)`。
- 导入不跑 AI：只建 session + 落 pt_cards + 写一条 user 消息，不调 startRun/executeRun，pt_runs 无新行。
- 幂等：同项目同 rpid 只落一张卡；重复导入分报 skipped，不产生重复卡、不覆盖已导入卡。
- 评论原文逐字进 transcript，不概括不润色；来源只进 branch_context_json 与来源行。

## 桶卡扩展（TASK-PW-67 修订）

一次筛子的一个桶整张卡：没有单一 rpid/bvid（一个桶横跨多个视频多条评论），source 加 `kind` 与 `bucket` 区分形态。

### body 契约

```json
{
  "cards": [
    { "title": "评论卡标题", "message": "评论原文", "source": { "platform": "bilibili", "bvid": "BV…", "rpid": 1001, "uname": "甲", "like": 50 } },
    { "title": "求助需求池", "message": "求个使用教程\n这个功能怎么开启", "count": 7, "source": { "kind": "bucket", "bucket": "求助" } }
  ]
}
```

- `source.kind`：`"comment"`（缺省）| `"bucket"`；`source.bucket`：桶名（仅 bucket 卡必填）。
- `count`（顶层，仅 bucket 卡可选）：桶条数，优先取它；缺省时从 `message` 非空行数推。
- 校验：comment 卡维持原样（bvid/rpid 必填，rpid 归一 number）；bucket 卡 bvid/rpid 可空、bucket 必填。
- 去重：comment 卡按项目内 rpid，bucket 卡按项目内标题（`cleanTitle` 归一后匹配）；重复的进 `skipped`——comment 卡 skipped 返回 rpid，bucket 卡 skipped 返回标题。
- transcript 来源行：comment 卡照旧；bucket 卡写 `—— 评论筛子桶卡 · {bucket} · 共 N 条`。
- `branch_context_json`：comment 卡照旧；bucket 卡写 `{"source":{"kind":"bucket","bucket":"求助"}}`。

## 分工

- 本次交付：`src/engine.ts`（`importCommentCards` + 校验/解析 helper）、`src/main.ts`（1 条路由）、`src/card-import.test.ts`（新建）、`package.json`（登记测试）、`docs/TASK-PW-67-comment-card-import.md`（本刀文档）。
- 前端（另立批次）：探索区入口消费 import 路由，把筛子精选评论一键导入并展示 imported/skipped。

## 验收记录（2026-08-12）

**什么能用了**：`POST /api/projects/{id}/cards/import` 可用。导入一批精选评论 → 每张落成 root 卡（branch_context_json 带来源），transcript 一条 user 消息（评论原文 + 来源行），pt_runs 无记录（零 AI）；同项目内同 rpid 重复导入分报 skipped 不产生重复卡；同批内重复 rpid 第二张跳过；>50 张/空/缺 cards/字段缺失 400 带卡片序号；项目不存在 404。桶卡形态（修订后）：`source.kind="bucket"` 整桶一张卡，bvid/rpid 可空、bucket 必填，来源行 `—— 评论筛子桶卡 · {bucket} · 共 N 条`（N 取 count 或 message 行数），按标题去重（skipped 返回标题）。

**什么还不行**：前端探索区入口（另立批次）；真实精选评论批量导入对账留给验收时执行，未在交付中代跑。

**有什么等拍板**：①去重用 rpid（B站全局唯一），若未来有平台级评论号冲突再考虑 (platform,rpid) 复合键；②导入状态码取 201，若前端想区分「全跳过 vs 有新增」可改 200 + 明细，当前 `imported`/`skipped` 已能表达。

测试证据：`PATH="$HOME/.local/node/bin:$PATH" node --test src/card-import.test.ts` 全绿（6 用例）；回归 `npm test` 全绿（见交付汇报）。

改动文件：`src/engine.ts`（importCommentCards + sourceRpid/normalizeImportCard/strValue/importLike）、`src/main.ts`（cards/import 路由）、`src/card-import.test.ts`（新）、`package.json`（登记测试）、`docs/TASK-PW-67-comment-card-import.md`（新）。未 commit、未 push、未动 frontend/。
