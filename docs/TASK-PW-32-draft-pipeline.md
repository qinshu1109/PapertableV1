# TASK-PW-32 起草管线

- 主需求域：内容生产
- 业务接口：提供有效判断·生产侧（金子墓碑装配 + §N 标注，消费 PW-30 引用落库）；提供选题候选（读否过的候选卡）
- 数据真值源：写 pw_content_drafts（PW-31）与 pw_verdict_refs（PW-30，source_kind='content_draft'）；读 pw_bets / pw_sieve_cards / pw_content_draft_edits / pw_verdicts / pw_gold_mirror；pw_runs 留痕（kind='ai_draft'、event_type='draft'，均在既有枚举内，无迁移）；**无新表**
- 质量约束与验收终态：见文末「验收硬门」

## 这刀是干什么的（白话）

让 AI 给一张押注卡自动写素材草案：一次出三份、每份走不同路子（贴热点/少数派/反共识），只写大纲不写成稿，标题只给候选。关键是防平庸——起草时把你以前否过的卡、否过的草案、改稿痕迹、确认过的金子墓碑都喂给它当对照，它还嘴硬瞎编金子编号就当场清掉。

## 怎么算好（白话）

对一张在途押注跑一遍，三份草案挂到卡下：每份 5-7 行大纲节点、段旁标了真金子的 §N；含"推荐选这份""已避开墓碑"这种嘴脸的直接丢弃；只剩一份对照不出来就算失败不硬产。你否掉的草案沉进 bad case 集，以后改了 prompt 能拿它们重跑对比（eval:drafts）。

---

以下给干活的看，可以跳过。

## 背景与现状（已核验，2026-08-08）

- **照 `runPwSieve` 管线范式**（`src/pw-sieve.ts:589`）：装配 → 单次 LLM 结构化产出（非工具循环）→ 确定性后处理 → 落表 + 审计。LLM 注入点照 `SieveLlm`（`pw-sieve.ts:424`）：`options.llm` 注入 mock（测试），缺省 `createPapertableProvider()` 真实模型（`src/provider-settings.ts:58`）。LLM 异常/JSON 失败重试 1 次。
- **草案落表走 PW-31** `createPwContentDrafts`（`src/pw-content-drafts.ts`）：batch_id/route/title_candidate/skeleton_json/状态机已就绪；bad case 集 `listPwDraftBadCases` 已就绪。
- **§N 落库走 PW-30** `recordPwVerdictRefs` + `pwCollabRefTable`（`src/pw-verdict-refs.ts`）；编号表来自 `buildCollabContext`（`src/pw-context.ts`）的 golds/tombs——管线直接复用该装配拿金子墓碑区块与编号表，**不自建第二套编号**。
- 押注三行来源：PW-19 `pickPwSieveCard` 生成的 thesis 已含逐字引文+来源（演示困惑）。

## 交付清单

1. **新文件 `src/pw-draft-pipeline.ts`**：
   - `export const DEFAULT_DRAFT_ROUTES = ["贴热点", "少数派", "反共识"]`
   - `export const DRAFT_SYSTEM_PROMPT`（字符串，集中导出供评测回流）
   - `export type DraftLlm = (inputText: string) => Promise<string>`
   - `buildDraftEvidence(db, betId): DraftEvidence`——确定性装配（导出供测试与评测）：
     - 押注三行：getPwBet；**非 content 或非 pending → httpError(409)**
     - 否过的候选卡：pw_sieve_cards status='rejected' 近 5 张（quote_text + 从 pw_runs reject 事件 payload 解析 reason，找不到则 null）
     - 否过的草案：listPwDraftBadCases 近 5 条（route/title_candidate/reject_reason/bet_title）
     - 改稿痕迹：pw_content_draft_edits 近 3 条（before/after）
     - 金子/墓碑：buildCollabContext(db, betId) 的 golds/tombs 区块 markdown + pwCollabRefTable(context) 编号表
   - `buildDraftPrompt(evidence): string`——DRAFT_SYSTEM_PROMPT + 证据区块拼装（导出供评测）
   - `parseDraftJson(raw): ParsedDraft[]`——JSON 数组校验（route 非空、title_candidate 非空、skeleton 为数组、节点至少含 text 非空、gold_ref 为 '§N' 或 null）；不合格抛错
   - `postProcessDrafts(parsed, refTable): { kept, dropped: {route, reason}[] }`——确定性后处理：
     - skeleton 节点数 **5-7**，越界 → 该份 drop
     - 同一路子多份 → 只留第一份，其余 drop
     - **宣告扫描**：title+skeleton 文本命中 `["墓碑", "已避开", "避开了", "绕开", "推荐选", "建议选"]` → 该份 drop（成稿不宣告、不给结论）
     - gold_ref 在编号表外 → **置 null** 并记一条 dropped（不清退整份）
   - `runPwDraftPipeline(db, betId, options?): Promise<DraftRunResult>`：
     - `options: { llm?: DraftLlm; routes?: string[]（缺省三路）；batchId?: string; modelLabel?: string | null }`
     - 流程：buildDraftEvidence →（LLM 调 buildDraftPrompt，重试 1 次）→ parseDraftJson → postProcessDrafts → **kept<2 → run failed 不产草案**（对照至少两份才有意义）→ createPwContentDrafts 落 kept → 每份草案把所有节点 gold_ref 拼文本（如 `"§1 §3"`）调 recordPwVerdictRefs（source_kind='content_draft'，source_id=草案 id）
     - 留痕：pw_runs `kind='ai_draft'`、`event_type='draft'`、`actor='ai'`，payload `{ betId, batchId, routes, created, dropped, model }`；失败同样落一条（payload 含 error）
     - 返回 `{ batchId, created: PwContentDraftRow[], dropped, droppedReasons, refStats: { inserted, dropped } }`
2. **新文件 `src/pw-draft-pipeline.test.ts`**：内存库自包含 + mock llm（照 pw-sieve.test.ts / pw-content-bets.test.ts 先例）。
3. **新文件 `src/pw-eval-drafts.ts`**：bad case 回流脚本——读 listPwDraftBadCases，对其押注逐条复用 buildDraftEvidence + buildDraftPrompt +（真实模型或 `--mock`）+ parseDraftJson + postProcessDrafts，**只打印不落库**，输出 bad case 原文与新产出的并排 JSON；prompt/模型改动前后各跑一次人工对比（沿 PW-29 评测纪律）。
4. **改 `package.json`**：test 串登记 `src/pw-draft-pipeline.test.ts`；scripts 加 `"eval:drafts": "node src/pw-eval-drafts.ts"`。
5. **不改 main.ts、不改 frontend/、不改其他任何既有文件。**

## 测试清单（≥9）

1. buildDraftEvidence：押注三行/否过候选卡（含 reason）/否过草案/改稿 diff/金子墓碑 §N 各区块齐
2. 非 content 或非 pending 押注 → 409
3. mock llm 正常三份 → 三份落库（同 batch、route 齐、status=draft）+ pw_runs ai_draft/draft 痕（payload created=3）
4. 节点数越界（4 节点）那份被 drop、其余存活 → run done
5. 存活 <2 份 → run failed、零草案落库、失败痕 payload 含原因
6. 宣告扫描：含"已避开墓碑"/"推荐选这份"的份被 drop
7. gold_ref 编号表外 → 置 null + dropped 计数；编号表内 → 保留
8. refs 落库：kept 草案 gold_ref → pw_verdict_refs（source_kind='content_draft'、source_id=草案 id、marker 正确）；重放幂等不重复
9. LLM 首炸次好 → 重试成功；两炸 → failed 零草案
10. 重复路子只留一份；缺一路子但另两路存活 → done 两份
11. eval 复用：buildDraftEvidence/buildDraftPrompt/parseDraftJson/postProcessDrafts 独立调用不落库（dry-run 路径通畅）

## 纪律

- 只新建上述三文件 + 改 package.json；**禁碰 main.ts、frontend/、public/、docs/ 及任何其他既有文件**；不 git commit。
- node 必须 `PATH="$HOME/.local/node/bin:$PATH"` 前缀；node 24 TS 剥离器不认跨行 `as` 断言（写同行）。
- 只跑：`node --test src/pw-draft-pipeline.test.ts`（必须全绿）+ `node --test src/pw-content-drafts.test.ts src/pw-verdict-refs.test.ts src/pw-collab.test.ts`（回归）。**不跑 npm test / npm run verify / frontend build**（主代理统一做）。
- 完成后回报：改动文件清单（含行数）、测试结果、与规格的偏差（逐条）。

## 验收硬门（主代理执行）

`npm run verify` 全绿（含新测试）；真实模型冒烟：对真实在途押注（dcd60b6b）跑管线 → ≥2 份草案落库（5-7 节点、gold_ref 真实命中编号表、无宣告字样）→ pw_verdict_refs 有 content_draft 来源的账 → `npm run eval:drafts` 可跑通 → 冒烟产物清理（草案、refs 行），pw_runs 留审计。

---

## 验收记录（2026-08-08，主代理）

- **状态：验收通过。** DeepSeek 子代理实现，主代理两道硬门亲跑。
- verify：184/184 全绿（173 + 新 11），selfcheck ok，前端 build 成功。
- 真实模型冒烟（押注 dcd60b6b，走 createPapertableProvider 真实模型）：
  - 3 份草案全路子落库（贴热点/少数派/反共识），每份 5 节点（5-7 区间），宣告扫描命中 0；
  - gold_ref 全部命中编号表：§2/§3=镜像金子、§4=墓碑；pw_verdict_refs 落 6 笔（source_kind='content_draft'，指向各草案 id）；
  - 人工读稿：三份路子各行其是（贴热点=全能叙事蹭热评、少数派=高播放题无聊化、反共识=全能伪命题建在墓碑对照上），非换皮；
  - 否一份进 bad case → `npm run eval:drafts` 跑通：bad case 原文与新产出并排 JSON，头部带模型 + prompt sha256 版本（84782d9c）——回流链路可用；
  - 产物清理：草案与 content_draft refs 已删（collab_message 来源 1 笔真实流水保留），pw_runs 留审计。
- 认可子代理偏差：buildDraftPrompt 增 routes 二参（单参兼容）、押注不存在同 409、留痕 payload dropped 用原因文本数组、eval 脚本读写连接只读查询（WAL 限制）。
- **观察项（冒烟抓到的规格措辞冲突，行为保留待拍板）**：SPEC §3 写「只标金子引用」，而编号表含墓碑——真实模型把 §4 墓碑作证据标注并落库。主代理判断**保留**：墓碑引用与金子一样可点开验真，且正是「这坑我栽过没有」的对照证据（反共识草案就建在墓碑对照上）；要禁的只是「已避开」这类无法自证的避让宣告——宣告扫描已在管。建议把 SPEC 措辞修为「只标真实编号表引用（金子/墓碑；点开验原件），墓碑不作避让宣告」。
