# TASK-PW-60 笔记屏改造：记忆钩子树

- 主需求域：内容生产
- 业务接口：提供笔记读取（实践与数据回收 → 内容生产，只读消费外部笔记库，沿用 v0.6 既有接口）
- 数据真值源：笔记真值仍在 Memos 库（只读，不改写）；新增本地派生数据「笔记挂枝 + 关键词」落 papertable.sqlite3 的 `pw_note_attach` 表（镇纸本地派生数据，可整体重建，不回写 Memos）
- 质量约束与验收终态：不破坏现有笔记只读纪律与七屏既有通路；首屏 3 秒内可指出哪张押注在动、哪张冷了；任意叶节点 ≤2 次点击看到原文；挂枝 AI 只建议、人确认才生效（写权限规格 v1 纪律不变）

## 这刀是干什么的

现在第七屏「笔记」是把笔记原文一条条平铺出来，再加一栏日报/周报/月报式的文字汇总。做过的笔记人不会忘记，只是想不起来——密密麻麻的文字既看不进去，也勾不起回忆。

改完之后，打开笔记屏看到的是一棵"思考树"：当前方向是根，在途押注是枝干，每张押注下面挂着短关键词叶子（每条笔记一片叶子，不超过 12 个字）。叶子的颜色深浅表示这条枝多久没动静，一眼扫过去就知道哪张押注最近在想、哪张冷了。点一片叶子，旁边滑出那条笔记的原文；没挂到任何押注上的笔记躺在顶部"待归位"区，可以一键确认归位。底部还能"问笔记"——回答不是一段话，而是树上高亮的一片相关叶子。

## 怎么算好

- 打开笔记屏，3 秒内能指出"哪张押注最近在想、哪张一周以上没动"（看颜色就知道）。
- 点任意叶子，最多再点一次就能看到那条笔记的原文，并能跳到 Memos 原链。
- 出现一条新笔记时，它会先躺在"待归位"区并带一个 AI 建议的归属；人点"确认"后才挂到枝上；人也能直接改挂到别的押注。
- 在底部问"XX 押注最近攒了什么"，树上高亮相关叶子，而不是返回一段文字。
- 原来的热力图、标签树、列表检索收进二级入口，仍可用。

以下给干活的看，可以跳过。

## 方案依据

- 产品判断与灵感来源：`/Users/qinshu/主知识库_AI/80_AI暂存/镇纸笔记屏改造方案.md`（信息架构/交互/数据流/验收以此为准，本 TASK 按其落地，唯一偏差：方向在数据模型里不是实体列表而是筛子当前取向文本，故树的骨架为"根=当前方向标注，枝干=押注卡"）。
- SpringNote 作者视频（BV1q8GN63Ewa）：AI 大段文字读三句就想关掉；压成一句话信息太少；有效形态是"每个词挂在自己位置上"的结构图。

## 数据与接口设计

### 新表（papertable.sqlite3，本地派生）

```sql
CREATE TABLE IF NOT EXISTS pw_note_attach (
  note_uid   TEXT PRIMARY KEY,        -- Memos 笔记 uid
  bet_id     TEXT,                    -- 挂到的内容押注；NULL = 待归位
  status     TEXT NOT NULL,           -- suggested | confirmed
  keyword    TEXT,                    -- ≤12 字关键词（AI 提炼，人可改）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 新端点（挂在 main.ts 既有 pw 路由区）

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/pw/notes/tree` | GET | 返回 `{ direction, bets: [{ betId, title, status, dueDate, lastNoteAt, notes: [{ uid, keyword, createdAt, attachStatus }] }], unassigned: [{ uid, keyword, createdAt, suggestedBetId }] }` |
| `/api/pw/notes/tree/attach` | POST | 人确认/改挂：`{ noteUid, betId （可空=待归位） }` → status=confirmed |
| `/api/pw/notes/tree/keyword` | POST | 人改关键词：`{ noteUid, keyword }` |
| `/api/pw/notes/tree/tick` | POST | 后台批处理一拍：为缺关键词/缺挂接建议的笔记各处理 ≤10 条（AI 提炼关键词 + 建议 betId，落 suggested） |

纪律：Memos 库只读（沿用 pw-notes.ts 的只读连接纪律）；关键词/建议复用全局激活 provider（参照 pw-note-insight.ts 的取法）；押注真值来自 pw-content-bets.ts 的 `listContentBets`；当前方向取 `getSieveDirection`。

## 分工

- 后端（src/pw-note-tree.ts + 测试 + main.ts 挂路由）：经 herdr 派给 Codex，简报 `agent-bridge/briefs/01-note-tree-backend.md`。
- 前端（frontend/src/pw/Notes.tsx 重做首屏树图 + lib/api.ts 加客户端 + pw.css）：Kimi 直接改。
- 验收：联调后按「怎么算好」逐条在 http://127.0.0.1:4317 上过屏。
