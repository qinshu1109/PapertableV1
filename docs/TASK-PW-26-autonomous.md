# TASK-PW-26 AI 自主档落地（模块侧）· 执行规格

- 日期：2026-08-07
- 状态：**完成并验收（2026-08-07）**——DeepSeek 子代理实现模块侧，主代理复核+集成+验收。verify 138/138 全绿。真实冒烟：自主抓取全链路（AI 先 read_connections 看风控再抓→ai_auto 账无指令引用→runner 真起→BV1GJ411x7h7/BV115un6dE9a 各 100 评论落盘 done）；声音录入后自动分拣（signal_type=topic_lead，classify 账 actor=system）；结账后镜像自动同步（actor=system 账）。冒烟抓到并修复：launchd PATH 无 ~/.local/bin 导致裸 ego-browser 假启动（spawn 成功 sh 内 127），runner 改绝对路径解析（EGO_BROWSER_BIN > ~/.local/bin > 裸名）。金子确认挂钩（onVerdictConfirmed）单测+代码复核覆盖，真火留首次自然确认观察
- 批次：`docs/TASK-PW-23-batch.md` 第四刀；依据规格 `docs/SPEC-harness-write-boundary.md` §2（AI 自主档）/§6（店规·行为限速）
- 主需求域：实践与数据回收
- 业务接口：提供语料与回流数据（语料抓取改 AI 自主直抓，供给关系不变）
- 数据真值源：`pw_runs` kind 扩 `ai_auto`（CHECK 迁移）；新建 `src/pw-corpus-fetch-runner.ts`；`pw-gold-sync.ts` / `pw-voice.ts` / `verdicts.ts` 各加一个挂钩
- 质量约束与验收终态：自主动作落账走 ai_auto（无指令引用，属设计——PW-27 擅自发动断言只扫 ai_exec）；既有测试全绿；`PATH="$HOME/.local/node/bin:$PATH" npm run verify` 全绿
- **文件纪律（与 PW-25 并行关键）**：本刀**不许碰** `pw-collab-tools.ts`、`pw-collab.ts`、`main.ts`、`frontend/`——fetch_corpus 工具改写与 prompt 店规由主代理集成时做；不 commit

## 〇、先读：既有事实（已核验）

- `pw-runs.ts`：`PwRunKind = manual_event | ai_draft | ai_exec | sync | sieve`；kind/event_type 都有 CHECK（:106/:150 两处：建表 + `migratePwRunsCheck` 重建迁移，PW-23 先例）。`recordPwExecEvent` 强制指令两列；`recordPwEvent` 不强制。**该库 SQLite 开着外键**——重建迁移必须 PRAGMA foreign_keys OFF/ON（照 PW-22 collab_messages 重建先例，pw-collab.ts:69）。
- 事件类型 `corpus`/`mirror`/`classify` 已在枚举内（PW-23），本刀不扩事件类型。
- 抓取链路现状：`fetch_corpus` 工具（ask）→ proposed → 人批准 → `scripts/pw-fetch-bili-corpus.js`（**ego-browser nodejs 运行时**，`ego-browser nodejs < scripts/pw-fetch-bili-corpus.js`）轮询 `/api/pw/corpus/pending` 抓取；脚本自带限速（单次 ≤3 条、评论 ≤100、翻页 ≥1.5s）与撞墙处理（风控码 -352/-412/-101 → needs_human 退出）。
- `authorizePwCorpus`（pw-corpus.ts:151）直接进 pending 授权队列（人工后路既有通路）。
- `mirrorConfirmedGolds`（pw-gold-sync.ts:42）自记 manual_event/human 账，代码注释已预告「PW-26 改自动后改 actor=system」；镜像源是 `pt_verdicts`（kind='gold' AND status='confirmed'），INSERT OR IGNORE 幂等。
- 金子确认动作在 `verdicts.ts` 的 `confirmVerdict`（async，路由 main.ts:400 `/api/verdicts/:id/confirm`）。
- `addPwVoiceItem`（pw-voice.ts:76）同步插入；`classifyPwVoiceItems`（:119，async，LLM）自记 classify/system 账；手工分拣路由（main.ts:655）保留作后路。

## 一、pw_runs kind 扩 `ai_auto`

- `PwRunKind` 增加 `"ai_auto"`；两处 CHECK（建表 + `migratePwRunsCheck` 重建目标）同步加；旧库重建迁移照 PW-23 先例（检测 CHECK 文本不含 ai_auto 即重建，PRAGMA foreign_keys OFF→重建→ON，数据全量拷贝）。
- 语义注释：**AI 自主档账**——机制允许的 AI 自行动作（本批：自主抓取触发），无指令引用（instruction 两列恒 NULL），actor='ai'。
- `recordPwEvent` 无需改造（kind 透传）；不加新 helper，调用方直接 `recordPwEvent(db, { kind: "ai_auto", eventType: "corpus", actor: "ai", ... })`。

## 二、新建 `src/pw-corpus-fetch-runner.ts`（抓取触发器）

```ts
export type PwCorpusFetchTrigger = { started: boolean; reason?: string };
export function triggerPwCorpusFetch(options?: {
  spawnFn?: ...;        // 缺省 node:child_process spawn
  scriptPath?: string;  // 缺省 <repo>/scripts/pw-fetch-bili-corpus.js
  nowMs?: number;
}): PwCorpusFetchTrigger
```

- 行为：`spawnFn("sh", ["-c", "ego-browser nodejs < <scriptPath>"], { detached: true, stdio: "ignore" })` → `child.unref()`；**单飞**：模块级 running 标记，子进程 exit/error 时复位；已在跑返回 `{ started: false, reason: "already_running" }`。
- **降级**：spawn 抛错（ego CLI 不在/未运行）→ 捕获返回 `{ started: false, reason: "spawn_failed: <msg>" }`，绝不向上抛——语料行已在 pending 队列，人工可补跑脚本（后路）。
- 导出 `_resetPwCorpusFetchRunnerForTest()` 供测试复位单飞标记。
- 本模块**不碰 db、不记账**——记账在调用方（主代理集成的 fetch_corpus 工具）。

## 三、金子镜像自动（挂钩 + actor 参数）

1. `pw-gold-sync.ts`：`mirrorConfirmedGolds(db, options?: { actor?: "human" | "system" })`——缺省 'human'（路由行为不破），传 'system' 时记账 actor=system。
2. `verdicts.ts`：加模块级订阅 `export function onVerdictConfirmed(fn: (db: DatabaseSync, verdictId: string) => void): void`；`confirmVerdict` 成功完成后逐个调监听（每个 try/catch 吞错——镜像失败不拖垮确认）。
3. **不挂钩 settlePwBet**（避免与 PW-25 撞 pw-verdicts.ts）；结账后镜像由主代理在 settle_bet 工具侧挂（工具成功→调 mirror actor=system），本刀不管。
4. UI 手动镜像按钮/路由保留（后路），记账仍 actor=human。

## 四、声音分拣自动（挂钩）

1. `pw-voice.ts`：模块级 `let autoClassifier: ((db: DatabaseSync, ids: string[]) => void) | null = null`；`export function setPwVoiceAutoClassifier(fn | null)`；`addPwVoiceItem` 插入并记账后调用 `autoClassifier?.(db, [id])`——**同步触发、不 await**，调用包 try/catch（分拣是后台事，绝不拖垮录入）。
2. 分拣本体仍是 `classifyPwVoiceItems`（不改）；classify 失败/解析不出 → 条目保持未分拣（既有行为），**不设自动废弃**（审后不设废弃，drop 仍只能人做）。
3. 手工分拣路由保留（后路）。
4. 接线（哪个分类器、LLM 从哪来）由主代理在 main.ts 注册，本刀只提供挂钩与测试。

## 五、测试（新文件 `src/pw-autonomous.test.ts`，登记 package.json）

1. **kind 迁移**：构造 PW-23 时代 CHECK（无 ai_auto）的旧库 → ensure/migrate → ai_auto 可写入、既有行全保留、foreign_keys 复原为 ON；新库直接建表含 ai_auto。
2. **ai_auto 账**：recordPwEvent kind=ai_auto + event_type=corpus + actor=ai + instruction NULL 写入成功且读出字段正确。
3. **runner**：mock spawnFn——正常触发 {started:true} 且参数含 ego-browser/nodejs/脚本路径；二次触发 {started:false, already_running}；子进程 exit 后复位可再触发；spawnFn 抛错 → {started:false, spawn_failed} 不抛出。
4. **镜像 actor**：缺省 human（既有测试不破）；传 system → mirror 账 actor=system。
5. **确认挂钩**：注册监听 → confirmVerdict 成功路径触发一次且参数对；监听抛错不影响确认返回；未确认不触发。
6. **声音挂钩**：setPwVoiceAutoClassifier(spy) → addPwVoiceItem（含 audit 与缺省两种）后 spy 被调且 ids 正确；spy 抛错录入仍成功；置 null 后不再调。
7. 既有 pw-gold-sync / pw-voice / pw-runs / verdict-memos 测试全绿（挂钩缺省无行为变化）。

## 六、验收硬门（主代理亲自）

1. verify 全绿（含新测试）；`node --test src/pw-autonomous.test.ts` 单绿。
2. 主代理集成后真实冒烟（集成内容见批次文档，不属本刀交付）：fresh 会话让 AI 自主抓一个小评论量 BV → ai_auto 账（无指令引用）+ runner 真起 + 语料 done 落库；确认一条金子 → 镜像自动多一行；录一条声音 → 自动分拣出 signal_type。
3. main.ts / pw-collab-tools.ts / pw-collab.ts / frontend/ 零改动确认（本刀子代理范围内）。

## 七、明确不做

fetch_corpus 工具改写（ask→auto、authorize 直抓、runner 接线、ai_auto 落账）、prompt 限速店规、settle 后镜像接线、main.ts 全部接线——**均为主代理集成活**；PW-25 的任何文件；PW-27 的监督断言；前端。
