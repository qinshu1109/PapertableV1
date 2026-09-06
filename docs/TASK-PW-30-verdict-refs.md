# TASK-PW-30 引用落库与弹药架

- 主需求域：判断沉淀与复用
- 业务接口：提供引用记录（新接口，域修订 v0.5；供本批 PW-34 多源可视化 / PW-35 收工小结 / PW-36 屏消费）
- 数据真值源：新表 `pw_verdict_refs`（唯一归属：判断沉淀与复用）；只读消费 pw_verdicts / pw_gold_mirror / pw_collab_messages；不改写任何既有表结构
- 质量约束与验收终态：见文末「验收硬门」

## 这刀是干什么的（白话）

给"AI 到底用没用过你的金子"记账。现在 AI 回答里标了 §N 用完就散了，屏上弹药架没东西可摆。这刀把 AI 回答里的每个 §N 标注落成一笔账：引用了哪条金子/墓碑、引到哪条消息里、什么时候。

## 怎么算好（白话）

AI 标了 §1，数据库立刻多一笔；它瞎编一个 §99，直接丢弃不入账；同一条消息重复处理不会重复计数；弹药架读函数只摆"真引用过"的——空着就是空着，它要说用了就是穿帮现场。

---

以下给干活的看，可以跳过。

## 背景与现状（已核验，2026-08-08）

- **§N 装配**：`src/pw-context.ts` `buildCollabContext` 返回 `{ markdown, golds, tombs }`。golds 元素 `{ ref:'§N', id, source: 'paperweight'|'papertable', text }`；tombs 元素 `{ ref, id, causeOfDeath }`（墓碑 source 恒 `'paperweight'`）。§N 在同一 DB 状态下确定性重算、全轮稳定。
- **回合收口钩子点**：`src/pw-collab.ts` `runCollabTurn`（243 行起）：`context` 在 266 行装配；assistant 消息在 338-344 行 `appendPwCollabMessage` 落库（`assistantRow`）；346 行 `recordPwEvent(message/ai)`。**本刀钩子插在 assistantRow 落库之后**（recordPwEvent 之前或之后均可）。
- **只解析 role='assistant' 的消息文本**；user 消息不解析（用户打 §N 是点屏幕菜牌，不是 AI 引用）。
- 库开 PRAGMA 外键：`pw_verdict_refs` 一律弱引用，不建物理 FK。
- 纸桌 verdict_use 纪律对照：**伪造/未知标注不计入；绝不拿"提供过（provided）"冒充"用过（used）"**。

## 交付清单

1. **新文件 `src/pw-verdict-refs.ts`**：
   - `ensurePwVerdictRefTables(db)`：幂等建表（DDL 见下）
   - `parseSectionMarkers(text): string[]`——提取 `§(\d+)`，按出现序去重
   - `pwCollabRefTable(ctx: PwCollabContext): RefTableItem[]`——由 golds/tombs 合成编号表 `[{ ref, id, source, kind: 'gold'|'tomb' }]`（tombs 的 source 恒 `'paperweight'`）
   - `recordPwVerdictRefs(db, input: { sourceKind, sourceId, text, refTable }): { inserted: number, dropped: string[] }`——对 text 中每个 §N：命中 refTable → `INSERT OR IGNORE`；未命中 → 进 dropped（不入库）
   - `listPwAmmoShelf(db): AmmoRow[]`——只含**实际被引用过**的 verdict：`{ verdict_id, verdict_source, verdict_kind, text, ref_count, first_used_at, last_used_at }`；text 解析：own gold → pw_verdicts.lesson，tomb → cause_of_death，mirror → pw_gold_mirror.text；源行已删 → text=null 仍列出；按 last_used_at DESC
   - `listPwVerdictRefLog(db, verdictId)`——该 verdict 的全部引用记录（created_at 升序）
2. **改动 `src/pw-collab.ts`（唯一允许动的既有文件，≤10 行）**：`runCollabTurn` 的 assistantRow 落库后调用 `recordPwVerdictRefs`（`sourceKind: 'collab_message'`、`sourceId: assistantRow.id`、`text: finalText`、`refTable: pwCollabRefTable(context)`）；dropped 非空时 `console.warn` 留痕（**不进 pw_runs**——refs 表即流水）。
3. **新文件 `src/pw-verdict-refs.test.ts`**：内存库自包含（照 `src/pw-content-bets.test.ts` makeDb 先例）。

DDL：

```sql
CREATE TABLE IF NOT EXISTS pw_verdict_refs (
  id TEXT PRIMARY KEY,
  verdict_id TEXT NOT NULL,
  verdict_source TEXT NOT NULL CHECK(verdict_source IN ('paperweight','papertable')),
  verdict_kind TEXT NOT NULL CHECK(verdict_kind IN ('gold','tomb')),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('collab_message','content_draft')),
  source_id TEXT NOT NULL,
  marker TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS pw_verdict_refs_dedup
  ON pw_verdict_refs(source_kind, source_id, verdict_id);
CREATE INDEX IF NOT EXISTS pw_verdict_refs_by_verdict
  ON pw_verdict_refs(verdict_id, created_at);
```

## 测试清单（≥9）

1. ensure 幂等（两次调用）+ 列/索引结构断言
2. parseSectionMarkers：多标注按序去重；无标注空数组；§ 后非数字不命中
3. record 命中编号表 → 行字段全对（verdict_id/source/kind/marker/source_kind/source_id）
4. 伪造 §99（编号表外）→ dropped 收集、不入库
5. 幂等：同 source 重复 record → 唯一索引去重，计数不变
6. 混合编号表：§1=gold(own)、§2=gold(mirror)、§3=tomb → 各行 source/kind 各对
7. listPwAmmoShelf：两条被引 verdict 计数与时间正确；未引用的不出现；last_used_at 倒序
8. listPwVerdictRefLog 升序
9. collab 端到端（mock provider，照 `src/pw-collab.test.ts` SSE 先例）：模型回答带 §1 → assistant 落库后 pw_verdict_refs 恰一笔、marker='§1'
10. 端到端：用户消息带 §1 → 不落库（只解析 assistant）

## 纪律

- 只新建上述两文件 + 改 pw-collab.ts 一处；**禁碰 main.ts、frontend/、public/、package.json、docs/ 及其他任何文件**；不 git commit。
- 测试登记（package.json）与 ensure 挂载（main.ts）由主代理集成统一做，子代理不做。
- node 必须 `PATH="$HOME/.local/node/bin:$PATH"` 前缀（默认 node 是坏的 cua_node）。
- node 24 TS 剥离器不认跨行 `as` 断言写法，`as` 断言写在同行。
- 只跑：`node --test src/pw-verdict-refs.test.ts`（必须全绿）+ `node --test src/pw-collab.test.ts src/pw-deepdive-tools.test.ts src/pw-global-collab.test.ts`（回归确认既有行为不破）。**不跑 npm test / npm run verify / frontend build**（并行批防冲突）。

## 验收硬门（主代理执行）

登记 + 挂载后 `npm run verify` 全绿；真实模型冒烟：真实库对话让 AI 引用一条金子（要求用 §N 标注）→ pw_verdict_refs 恰落一笔 → 弹药架读函数能读出它。

---

## 验收记录（2026-08-08，主代理）

- **状态：验收通过。** DeepSeek 子代理实现，主代理集成与两道硬门亲跑。
- verify：173/173 全绿（151 + 新 12 + PW-31 新 10），selfcheck ok，前端 build 成功。登记（package.json）与挂载（main.ts 两行 ensure）由主代理完成；`pw-audit-foundation.test.ts` makeDb 补挂新表属必要连带（照 PW-21 补 sieve 表先例）。
- 真实模型冒烟（全局会话）：提问后模型如实答「无相关金子，最相关是墓碑 §4」——答案含 §4，钩子抓取落库恰一笔：`verdict_id=663a9496、source=paperweight、kind=tomb、source_kind=collab_message、marker=§4`；`listPwAmmoShelf` 读出该条（count=1、text=cause_of_death 正确解析）。
- 子代理申报的集成期序列红（pw-collab.test.ts SSE 在挂载前必红）经验证为序列依赖，挂载后全绿，非代码缺陷。
- 认可偏差：排序加稳定 tiebreaker、record 前置 400 校验、hook 落 recordPwEvent 之后。
