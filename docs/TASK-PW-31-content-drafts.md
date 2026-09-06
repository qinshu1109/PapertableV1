# TASK-PW-31 素材草案体系

- 主需求域：内容生产
- 业务接口：无（域内新数据；供本批 PW-32 起草管线 / PW-33 发动与定稿 / PW-36 屏消费）
- 数据真值源：新表 `pw_content_drafts` + `pw_content_draft_edits`（唯一归属：内容生产）；弱引用 pw_bets（写入前存在性校验）；pw_runs 留痕（复用既有 event_type 枚举，无 CHECK 迁移）
- 质量约束与验收终态：见文末「验收硬门」

## 这刀是干什么的（白话）

给 AI 写的素材草案一个正式户口。每份草案挂在一张押注卡下，有路子（贴热点/少数派/反共识）、标题候选、骨架，状态只有三档：草稿 / 定稿 / 否掉。你改过的每一稿都留改前改后；否掉的带理由进 bad case 集，以后拿来回流调教起草质量。

## 怎么算好（白话）

草案不能凭空存在（必须挂押注卡）；状态只前进不后退（draft→finalized/rejected，反悔就是 409）；否掉的随时能连押注标题一起查出来；测试全绿。

---

以下给干活的看，可以跳过。

## 背景与现状（已核验，2026-08-08）

- **命名避让**：`src/pw-drafts.ts` 是「押注草稿」（PW-09/28，settle/bet 草稿）。本刀素材草案一律用 `pw_content_drafts` / `pw-content-drafts.ts`，不复用旧名。
- 库开 PRAGMA 外键：`bet_id` 弱引用不建物理 FK（沿 PW-22 先例）；无孤儿 = 写入前校验 + 测试断言兜底。
- 状态机/事务/竞态兜底照 `src/pw-content-bets.ts` 先例（`UPDATE ... WHERE status='draft'`，`changes !== 1` → `httpError(409)`）。
- 审计照 `PwContentBetAudit` 先例：`audit?: { actor: 'ai', instructionText, instructionMessageId }` 传入走 `recordPwExecEvent`，缺省走 `recordPwEvent`（manual_event/human）。event_type 复用枚举：**create / edit / confirm / reject**（均在 CHECK 内，无迁移）。
- 当前无路由无工具：草案只能经本模块函数写入；PW-19 同款「AI 无通路」断言。

## 交付清单

1. **新文件 `src/pw-content-drafts.ts`**：
   - `ensurePwContentDraftTables(db)`：幂等建表（DDL 见下）
   - `createPwContentDrafts(db, betId, drafts: NewDraft[], options?: { batchId? }): PwContentDraftRow[]`——批量 1..N 份；bet 不存在 → 404；route/titleCandidate 非空、skeletonJson 必须是合法 JSON 数组（元素至少含 text 字段，节点数 1..10），否则 400；未给 batchId 自动生成一批共用 id
   - `listPwContentDraftsByBet(db, betId, options?: { status? })`——created_at、route 升序
   - `countPwContentDraftsByBet(db, betId): { total, draft, finalized, rejected }`——**角标语义 = draft 态计数**
   - `getPwContentDraft(db, id)`——不存在 404
   - `updatePwContentDraft(db, id, changes: { titleCandidate?, skeletonJson? }, audit?)`——仅 draft 态可改；事务内先写 `pw_content_draft_edits`（before/after 全文 JSON）再更新主表 + updated_at；竞态 409
   - `finalizePwContentDraft(db, id, audit?)`——draft→finalized 单向；pw_runs confirm 痕（payload 含 draftId/betId）
   - `rejectPwContentDraft(db, id, reason?, audit?)`——draft→rejected + reject_reason（可空）；pw_runs reject 痕
   - `listPwDraftBadCases(db)`——rejected 全部（含 reject_reason）联查 pw_bets.title，created_at 升序（bad case 集，供 PW-32 回流）
2. **新文件 `src/pw-content-drafts.test.ts`**：内存库自包含（照 `src/pw-content-bets.test.ts` makeDb 先例）。
3. **不改任何既有文件。**

DDL：

```sql
CREATE TABLE IF NOT EXISTS pw_content_drafts (
  id TEXT PRIMARY KEY,
  bet_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  route TEXT NOT NULL,
  title_candidate TEXT NOT NULL,
  skeleton_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','finalized','rejected')),
  reject_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pw_content_drafts_by_bet
  ON pw_content_drafts(bet_id, status);

CREATE TABLE IF NOT EXISTS pw_content_draft_edits (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  actor TEXT NOT NULL CHECK(actor IN ('human','ai')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pw_content_draft_edits_by_draft
  ON pw_content_draft_edits(draft_id, created_at);
```

## 测试清单（≥9）

1. ensure 幂等 + 表结构/索引断言
2. create 三份同 batch_id 字段正确；bet 不存在 → 404（无孤儿断言）
3. skeleton_json 非法（非数组 / 空数组 / 节点缺 text / 超 10 节点）→ 400
4. list/count：角标语义（draft 态计数）与 status 过滤
5. update：edits 行 before/after 正确 + updated_at 前进；非 draft → 409
6. finalize：draft→finalized + pw_runs confirm 痕（payload 含 draftId/betId）；重复 finalize → 409
7. reject + reason：bad case 集联查 bet title 查得出；无 reason → null 也可
8. 状态机单向：finalized 不可 reject/update；rejected 不可 update/finalize（各 409）
9. audit 双路：传 audit → ai_exec 账（instruction 两列齐）；不传 → manual_event/human
10. AI 无通路断言：pw-collab-tools.ts 不含 content_draft 相关工具名（照 PW-19 同款断言先例）

## 纪律

- 只新建上述两文件；**禁碰 main.ts、frontend/、public/、package.json、docs/、pw-drafts.ts 及任何既有文件**；不 git commit。
- 测试登记（package.json）与 ensure 挂载（main.ts）由主代理集成统一做，子代理不做。
- node 必须 `PATH="$HOME/.local/node/bin:$PATH"` 前缀（默认 node 是坏的 cua_node）。
- node 24 TS 剥离器不认跨行 `as` 断言写法，`as` 断言写在同行。
- 只跑：`node --test src/pw-content-drafts.test.ts`（必须全绿）+ `node --test src/pw-bets.test.ts src/pw-content-bets.test.ts`（回归确认）。**不跑 npm test / npm run verify / frontend build**（并行批防冲突）。

## 验收硬门（主代理执行）

登记 + 挂载后 `npm run verify` 全绿；真实库冒烟：对在途押注建三份草案 → 改一份 → 定一份 → 否一份 → bad case 集查出否掉那条（冒烟产物随后清理，pw_runs 留审计）。

---

## 验收记录（2026-08-08，主代理）

- **状态：验收通过。** DeepSeek 子代理实现，主代理集成与两道硬门亲跑。
- verify：173/173 全绿（含新 10），selfcheck ok，前端 build 成功。
- 真实库冒烟（押注 dcd60b6b）：建 3 份草案（同 batch_id）→ count draft=3（角标语义正确）→ 改 A 稿标题（edits 行 before/after 全文正确、actor=human）→ 定 A（confirm 痕）→ 否 B 带理由（bad case 集联查押注标题正确）→ pw_runs 事件 create/edit/confirm 齐全 → 产物清理，审计保留。
- 认可子代理两个实现决策：create/update 同步落 pw_runs 痕（规格审计节枚举了 create/edit 两类）；updated_at 同毫秒 +1ms 守卫（保证「前进」严格成立）。
