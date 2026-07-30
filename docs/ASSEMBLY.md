# 前后端组装说明（feat/frontend-assembly）

设计稿前端（纸桌 Papertable 原型）+ PapertableV1 引擎 + 判决簿 ADR 的完整组装。

## 运行

```bash
# Node >= 24（v24 已原生剥离类型，start 脚本不再带 --experimental-strip-types）
PAPERTABLE_BASE_URL=https://你的中转/v1 \
PAPERTABLE_API_KEY=sk-xxx \
PAPERTABLE_MODEL=你的模型 \
npm start
# 浏览器打开 http://127.0.0.1:4317 即完整应用
```

前端开发模式（热更新，代理到 4317）：

```bash
cd frontend && npm install && npm run dev   # http://localhost:5173
```

改完前端后 `cd frontend && npm run build`，产物自动写入 `public/`。

## 本次新增

### 后端

| 文件 | 内容 |
|---|---|
| `src/verdicts.ts` | 判决簿：`pt_verdicts` 表、墓碑起草（改道同步落模板草稿 + 后台功能模型润色）、confirm / supersede / adopt、注入块生成、MemOS `papertable-verdicts` Cube best-effort 同步（只许 supersede 不许删除；本地表为运行时权威） |
| `src/engine.ts` | `buildSystemPrompt` 之后追加 `verdictInjectionBlock`——confirmed 判决注入每个新干净上下文（"干净但不失忆"） |
| `src/main.ts` | 新端点：`GET /api/projects/:id/verdicts`、`POST /api/verdicts/:id/confirm`、`POST /api/verdicts/:id/supersede`、`POST /api/runs/:id/adopt`；改道分支响应附带墓碑草稿；serveStatic 改为 SPA 静态托管（含 assets、回退 index.html、路径穿越防护） |
| `scripts/mock-model.mjs` | e2e 冒烟用假模型（anthropic-messages，含 SSE、tool_use 两跳、哨兵与受控引用），仅开发验证用 |

### 前端（frontend/，构建产物在 public/）

- `src/lib/api.ts`：REST + SSE 客户端（逐句 answer_sentence、citation_resolved、run_end）；
- `src/store.tsx`：mock store 全量替换为服务端数据层；收藏/置顶/回收站/折叠保留为本地覆盖层（localStorage）；
- 三种关系接通：深挖（精确选区偏移，失配退化为整段）、发散（topic）、改道（自动回溯至最近的用户轮 entryId）；
- `VerdictPanel.tsx`：改道后的墓碑确认条（确认/改写/忽略）+ 判决簿抽屉（金子/墓碑、supersede、跳转来源卡片）；
- TurnBlock 增加 RunFooter：受控引用芯片、终局态（refused/insufficient_evidence 显示"资料不足…拒答而非编造"）、重试、"采纳为金子"（亲手铸把手）；
- 设置弹层新增只读资料库绑定与重建索引。

## 已验证（沙箱 e2e，mock 模型）

1. 建项目 → 绑库 → 重建索引（FTS5）；
2. 根卡片提问 → search_notes → read_notes → 带 `[[source:chunk-…]]` 的完整回答（completed）；
3. 无证据时正确 refused/insufficient_evidence 并在 UI 呈现；
4. 采纳金子（把手入簿，confirmed）；
5. 改道 → 202 响应即含模板墓碑（proposed）→ 后台模型润色生效 → 确认入簿；
6. 下一个干净上下文的 system 中出现完整 `<verdict_ledger>` 块（金子+墓碑）——注入闭环成立。

## 已知边界（留给下一轮）

- MemOS 同步的 `add_memory` 工具名按通用约定书写，若 MemOSjyi 实际工具名不同，改 `src/verdicts.ts` 里一处常量即可（失败会记录在 `memosStatus`，不影响本地闭环）；
- 深挖选区在 markdown 渲染文本与原文偏移失配时退化为整段选区；
- 原型的导入/导出/项目删除仍为占位；回收站是本地隐藏而非服务端删除；
- 注入 A/B 复发率实验（ADR 判据 1）需真实模型与真实项目数据，在你机器上跑。

## 补充（流式与工具进度修复）

- 前端现在消费全部 run 事件：tool_start/tool_update/tool_end 渲染为实时工具进度芯片（检索命中数、读取段数），turn_start 起显示阶段占位（思考/检索/阅读/组织回答）；
- 完成后的轮次保留"检索过程 · n 步"可折叠回看（数据来自 run.activity）；
- 正文中的 [[source:chunkId]] 由前端转为行内 §n 角标，与底部引用芯片编号对应；
- 失败/拒答轮按 run 时序插入时间线（会话只保留成功轮正文，失败轮由前端合成补位）；
- 已用真实模型（cozai.net · claude-opus-5）从界面端到端验证：工具进度、逐句流式、引用、终局态、采纳按钮全部正常。

## 补充（正文塌块与关系图观感修复）

**根因（后端 `gate.ts`）**：句子边界会把换行单独切成一片，而 `safePieces` 用
`if (!cleaned.text.trim()) continue` 把这些空白片段当垃圾丢掉 —— 于是**所有换行与空行都被吃掉**，
Markdown 结构塌成一整块，`##`/`###`/列表全部焊在正文中间。同时 `#sync` 按文本内容去重
（`structure:${text}`），重复空行与相同标题会被误删，进一步破坏段落。

- 空白片段原样保留；发射改为按下标推进（论据去重仍由 `safePieces` 的 `seenClaims` 负责）；
- 前端 `normalizeStructure` 兜底：把行内标题/列表拆回独立行、补齐模型漏写的列表空格、
  跳过孤立 `#`，让**已入库的旧回答**也能正常排版；
- `[[source:x]]` 渲染为上标角标，与底部引用芯片编号对应；引用芯片改自适应网格；
- 关系图（保留"深挖向下/发散向右/改道向左"的语义布局）：
  连线由全长三次贝塞尔改为"垂直→小圆角→水平→小圆角→垂直"直角折线；
  按内容包围盒水平居中；超宽时自动缩放到装得下（手动缩放后停用，点回中恢复）；
  面板加宽到 248px；当前节点显示标题。
