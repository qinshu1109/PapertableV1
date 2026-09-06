# TASK-PW-33 自动起草发动与定稿挂载

- 日期：2026-08-08
- 批次：TASK-PW-30-batch（决策层 MVP 落地批）第四刀
- 依赖：PW-31（素材草案体系）、PW-32（起草管线）——均已验收

## 这刀是干什么的（白话）

现在押注卡确认成立后，AI 起草三份对照草案要人额外发话才动；这刀让它**自己动起来**：你在对话里或屏上把押注一确认，后台就自动起草，drafts 落库后角标自然出现。你要是烦它给某张押注起草，可以把那张押注拉黑，它就不碰。

另外，草案你点「定稿」的那一刻，这份大纲自动挂到押注卡的产出物里（沿用最早 PW-03 的挂载通路），押注继续在途——定稿不是结束，是"这份大纲我拿去拍了"的登记。

## 怎么算好（白话）

押注确认后不用你催，几十秒内三份草案自己出现在库里；起草失败（模型挂了、停线）**不影响押注成立本身**，账上留一笔失败记录；拉黑的押注它碰都不碰；定稿的同时产出物挂好，押注状态不变。

---

以下给干活的看，可以跳过。

## 四字段

- 主需求域：内容生产
- 业务接口：登记内容执行（定稿产出物挂载沿用既有 PW-03 通路）
- 数据真值源：新表 `pw_draft_blacklist`（拉黑不起草）；`pw_content_drafts` 状态流转（PW-31 既有）；`pw_artifacts` 挂载沿用（PW-03 既有）；发动/定稿留痕 `pw_runs`（kind 枚举复用 ai_draft / manual_event / ai_exec，无 CHECK 迁移）
- 质量约束与验收终态：见 §5 测试清单与 §6 验收终态

## 1. 背景与既有事实（已核验，勿重复调查）

- 起草管线入口：`runPwDraftPipeline(db, betId, options)`（`src/pw-draft-pipeline.ts:422`），**async**，内部已留痕 `kind='ai_draft' event_type='draft'`（成功与失败两条路径都留，payload 含 betId/batchId/routes/created/dropped/model[/error]）。`options.llm` 可注入 mock；`options.batchId` 可指定。
- 押注成立两个入口（都是 sync 函数，各自两个调用面）：
  - `confirmPwBetDraft`（`src/pw-drafts.ts:241`）——调用面：`src/main.ts:759` REST 路由 + `src/pw-collab-tools.ts:784` 工具 `confirm_bet_draft`。
  - `pickPwSieveCard`（`src/pw-content-bets.ts:118`）——调用面：`src/main.ts:717` REST 路由 + `src/pw-collab-tools.ts:1165` 工具 `pick_sieve_card`。
  - 两者都返回 bet 行（含 `kind`、`status`）。只有 `kind='content'` 的押注才发动起草。
- 定稿：`finalizePwContentDraft(db, id, audit?)`（`src/pw-content-drafts.ts:316`），sync、事务内、状态机 draft→finalized 单向 409，已留 confirm 痕（payload 含 draftId/betId，audit 双路）。
- 产出物挂载：`attachPwArtifact(db, {betId, platform, type, url?, title?, publishedAt?, note?})`（`src/pw-artifacts.ts:47`），sync；type 枚举 `video/livestream/article/cover/link`；url 与 title 至少其一；bet 不存在抛 404。
- `pw_runs` kind 枚举含 `ai_auto`（PW-26 自主档账，无指令引用），本刀**不用**——发动留痕直接复用管线自身的 ai_draft/draft 事件（加 trigger 字段区分来源），避免双账。
- node24 TS 剥离器不认跨行 `as` 断言——一律写同行。

## 2. 交付物总览

| 文件 | 改动 |
|---|---|
| `src/pw-draft-autofire.ts` | 新建：黑名单表 + 发动函数 |
| `src/pw-draft-autofire.test.ts` | 新建：8 组测试 |
| `src/pw-draft-pipeline.ts` | `DraftRunOptions` 加 `trigger?: string`；两条 recordPwEvent 的 payload 加 `trigger` 字段（默认 `"manual"`） |
| `src/pw-content-drafts.ts` | `finalizePwContentDraft` 事务内加产出物挂载；confirm 事件 payload 加 `artifactId` |
| `src/pw-collab-tools.ts` | `confirm_bet_draft` 与 `pick_sieve_card` 工具处理器成功返回后接发动（fire-and-forget） |
| 其余既有测试 | 仅当发动副作用导致既有断言失败时做最小连带修改，必须在回报中逐条说明 |

**禁碰**：`src/main.ts`（REST 两个调用面与 ensure 挂载由主代理集成）、`package.json`（测试登记主代理做）、`frontend/`、`public/`。不 commit。

## 3. 新表 pw_draft_blacklist

```sql
CREATE TABLE IF NOT EXISTS pw_draft_blacklist (
  bet_id TEXT PRIMARY KEY,
  reason TEXT,
  created_at TEXT NOT NULL
);
```

- `ensurePwDraftBlacklistTables(db)`：幂等建表（CREATE TABLE IF NOT EXISTS，无迁移）。
- `addPwDraftBlacklist(db, betId, reason?)`：bet 不存在 → 404（沿 `getPwBet` 校验）；已存在 → 幂等不报错（INSERT OR IGNORE，reason 不覆盖）；写 `pw_runs` 账（manual_event/human，event_type 用既有枚举 `'edit'`，payload `{betId, reason, action:'draft_blacklist_add'}`）。
- `removePwDraftBlacklist(db, betId)`：不存在该行 → 404；删除并留账（同上枚举 `'edit'`，action `'draft_blacklist_remove'`）。
- `isPwDraftBlacklisted(db, betId)` / `listPwDraftBlacklist(db)`（联查押注标题，created_at 升序）。

## 4. 发动函数 maybeAutoFirePwDraft

```ts
export type PwDraftAutofireOptions = {
  trigger: "confirm_bet_draft" | "pick_sieve_card";
  llm?: DraftLlm;        // 测试注入用；缺省走真实 provider（管线内部创建）
  modelLabel?: string;
};
export type PwDraftAutofireResult =
  | { fired: true; batchId: Promise<string> }   // 见下，实际实现可只返 Promise
  | { fired: false; reason: string };
export function maybeAutoFirePwDraft(
  db: DatabaseSync,
  betId: string,
  options: PwDraftAutofireOptions,
): Promise<{ fired: boolean; reason?: string }>;
```

守卫（任一不过 → `{fired:false, reason}`，**不记 pw_runs**——安静跳过，黑名单行本身就是记录）：

1. bet 存在；
2. `bet.kind === 'content'` 且 `bet.status === 'pending'`；
3. 不在 `pw_draft_blacklist`；
4. 该 bet 在 `pw_content_drafts` **零行**（防重复发动；否掉全部草案后的"换一批"不在本刀，留 PW-36 手动通路）。

发动：`runPwDraftPipeline(db, betId, { llm: options.llm, modelLabel: options.modelLabel, trigger: options.trigger })`。

**可靠性不变式（测试断言）**：`maybeAutoFirePwDraft` 永不 reject——
- 守卫/管线同步抛错 → catch 后尝试补记一笔 `ai_draft/draft` 失败事件（payload 含 trigger 与 error）；补记本身再失败 → 仅 `console.warn`，不外抛。
- 管线自身失败路径已留痕（PW-32 既有），本层不重复记。

**fire-and-forget 约定**：工具处理器/REST 调用面一律 `void maybeAutoFirePwDraft(...)` 不 await——确认押注的响应不能被 30-60s 的 LLM 起草阻塞；草案落库后由屏侧轮询自然出现。

## 5. 定稿挂载（finalizePwContentDraft 改动）

同事务内、状态翻转成功之后：

```ts
const artifact = attachPwArtifact(db, {
  betId: draft.bet_id,
  platform: "paperweight",
  type: "article",
  title: draft.title_candidate,
  note: `素材草案定稿 ${draft.id}（${draft.route}）`,
});
```

- confirm 事件 payload 由 `{draftId, betId}` 扩为 `{draftId, betId, artifactId: artifact.id}`。
- 押注行**零改动**（继续在途）；attach 抛错（理论上只有 bet 消失 404）则整个定稿事务回滚——定稿与挂载同生共死，测试断言这一点。
- 模块顶部 import `attachPwArtifact`（`./pw-artifacts.ts`）；该文件 ensure 函数已在 main.ts 既有挂载（主代理集成时确认顺序即可）。

## 6. 工具接线（pw-collab-tools.ts）

- `confirm_bet_draft` 处理器：`confirmPwBetDraft` 成功后 `void maybeAutoFirePwDraft(context.db, bet.id, { trigger: "confirm_bet_draft" })`，工具返回文本不变。
- `pick_sieve_card` 处理器：`pickPwSieveCard` 成功后 `void maybeAutoFirePwDraft(context.db, bet.id, { trigger: "pick_sieve_card" })`，返回文本不变。
- 不传 llm（生产路径走真实 provider）；测试环境 provider 创建失败由 §4 不变式兜底，不得让工具调用本身失败。

## 7. 测试清单（src/pw-draft-autofire.test.ts，内存库自包含）

1. 黑名单表 ensure 幂等；add/is/list/remove 全走通；add 重复幂等不报错不覆盖 reason；remove 不存在 404；两笔黑名单账 action 字段正确。
2. 发动成功：content+pending 押注 + mock llm 出三份 → `{fired:true}`，三份草案落库，ai_draft/draft 事件 payload `trigger==='confirm_bet_draft'`。
3. 拉黑不发动：先 add 黑名单 → `{fired:false}`；零草案、零新 ai_draft 事件。
4. 非 content 押注（kind='verdict'）→ `{fired:false}` 零草案。
5. 已有草案的押注 → `{fired:false, reason 含 '已有草案'}` 不重复发动。
6. 管线失败兜底：mock llm 两次都抛 → resolve `{fired:true}`（已发动）或 fired:false 均可但**绝不 reject**；库里有 ai_draft/draft 失败痕（管线自留）；押注仍 pending（发动失败不影响押注成立）。
7. 定稿挂载：draft 定稿 → pw_artifacts 多一行（platform='paperweight'、type='article'、title=title_candidate、note 含 draft id 与 route）；confirm 事件 payload 含 artifactId；押注状态不变。
8. 定稿挂载原子性：mock attach 必败路径（如先把 bet 删了以外的手段不可行——允许改为：直接 SQL 删掉 pw_artifacts 表制造抛错）→ finalize 整体抛错且 draft 仍是 draft 态（回滚断言）。

回归：`node --test src/pw-draft-pipeline.test.ts src/pw-content-drafts.test.ts src/pw-exec-tools.test.ts src/pw-collab.test.ts src/pw-content-bets.test.ts src/pw-mint-undo.test.ts` 全绿；payload 加 trigger 字段是 additive，既有断言不应破；若破，最小修改并逐条上报。

## 8. 验收终态（主代理执行）

- `PATH="$HOME/.local/node/bin:$PATH" npm run verify` 全绿（含新测试登记后）。
- 真实冒烟（主代理亲做，真实库真实模型）：重启后端 → REST 确认一张真实押注草稿（trigger=REST 面）→ 90s 内该押注下出现 ≥2 份草案、ai_draft/draft 事件 trigger 字段正确 → 脚本定稿其中一份 → pw_artifacts 出现对应行、押注仍在途。
- main.ts 集成（主代理）：ensure 挂载 + 两个 REST 调用面 fire-and-forget 接线。

## 9. 明确不做

- 不做黑名单管理的对话工具/REST 路由（留后续，现阶段函数+测试即可）。
- 不做"换一批"（重新起草）通路——PW-36 屏刀再说。
- 不改动 PW-32 的装配/后处理/prompt 任何逻辑（trigger 字段是唯一授权改动）。

---

## 验收记录（2026-08-08，主代理亲验，通过）

**人话三句**：现在押注一确认，AI 几十秒内自己把三份对照草案写进库，不用你催；草案定稿的同时产出物自动挂到押注卡上，押注继续在途；某张押注不想让它碰，拉黑函数已就位（对话工具留后续）。冒烟产物：押注「PW-33 冒烟：押注一确认就自动起草」（82a52016）在途 pending，留着当狗食，不要就对话里说作废。

- 实现：DeepSeek 子代理；集成（main.ts ensure+两 REST 面 fire-and-forget、package.json 登记）：主代理。
- verify（主代理亲跑）：**200/200 全绿**（184+8+8 含 PW-34），selfcheck ok，前端 build 成功。
- 真实冒烟（主代理亲做，真实库真实模型）：重启后端 → REST 建 content 押注草稿并 confirm → **15s 内** pw_content_drafts 落 3 份（贴热点/少数派/反共识全路子，status=draft）；ai_draft/draft 事件 payload `trigger:"confirm_bet_draft"`、model=deepseek-v4-flash、created=3 → 脚本定稿贴热点份：draft→finalized、pw_artifacts 挂行（paperweight/article、标题一致、note 含 draft id 与 route）、confirm 事件 payload 含 artifactId、押注仍 pending。全部断言通过。
- 子代理偏差申报（复核认可）：①未导出规格草稿里的 PwDraftAutofireResult 类型（规格原文允许"实际实现可只返 Promise"）；②兜底补记 payload 补齐 betId/created/dropped/routes/model 与管线失败事件同构（合理）；③连带修改 pw-content-drafts.test.ts makeDb 补 ensurePwArtifactTables（不加必红，最小必要）。
- 如实记录：对话面（confirm_bet_draft/pick_sieve_card 工具）接线经单测兜底路径与代码复核验证，未走 SSE 真实冒烟——REST 面已实测，工具面风险低，留 PW-36 收口时一并观察。
