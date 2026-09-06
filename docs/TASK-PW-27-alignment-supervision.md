# TASK-PW-27 指认对齐与监督收口 · 执行规格

- 日期：2026-08-07
- 状态：**完成并验收（2026-08-07）**——监督侧 DeepSeek 子代理交付（pw-supervision.ts 擅自发动/自主白名单断言 + scripts/pw-harness-audit.mjs 可重复脚本 + docs/TASK-PW-27-crosswalk.md 八节 17 行回勾，16 落地 1 明确不做）；菜号牌主会话落地（证据 N/少数派 N/注 N/文档 N 对话↔屏幕同源，prompt 指认规矩改写+「多张同名必反问」强化）。verify 144/144 全绿；audit:harness 真实库 0 违规；指认冒烟：「证据 1」锚定正确并挑卡、歧义「少数派那张」先猜后被店规强化纠正为反问、冲正撤销复原；ego 截图视觉验收通过（证据 1、少数派 1/2/3、注 1/2/3 徽标同源）。至此批次五刀全部完成
- 批次：`docs/TASK-PW-23-batch.md` 第五刀（收口）；依据规格 `docs/SPEC-harness-write-boundary.md` §6/§7
- 主需求域：内容生产
- 业务接口：提供选题候选（菜号牌对齐：装配注入短标签与页面标签同源）
- 质量约束与验收终态：断言与冒烟可重复跑；verify 全绿；不 commit

## 文件分界（并行不打架）

- **子代理**：`src/pw-supervision.ts`（新）、`src/pw-supervision.test.ts`（新）、`scripts/pw-harness-audit.mjs`（新）、`package.json`（加 `audit:harness` 脚本）、`docs/TASK-PW-27-crosswalk.md`（新）
- **主会话**：`src/pw-context.ts`、`src/pw-collab-tools.ts`、`src/pw-collab.ts`、`frontend/src/pw/Collab.tsx`、`frontend/src/pw/pw.css`（如需）、连带测试更新

## 一、监督模块 `src/pw-supervision.ts`（子代理）

```ts
export type PwAuditViolation = { id: string; kind: string; event_type: string; created_at: string; reason: string };
export function auditPwExecInstructions(db: DatabaseSync): PwAuditViolation[];
export function auditPwAutoWhitelist(db: DatabaseSync): PwAuditViolation[];
export function runPwHarnessAudit(db: DatabaseSync): { ok: boolean; violations: PwAuditViolation[] };
```

- **擅自发动断言**：`kind='ai_exec'` 且（`instruction_text` 空或 `instruction_message_id` 空）→ 违规（exec=人发话，无引用即擅自发动）。
- **自主档白名单**：`kind='ai_auto'` 且 `event_type NOT IN ('corpus')` → 违规（自主档扩张必须显式加白名单，防默许漂移）。
- ai_draft 不查指令（draft 档无指令列属设计）；human/system/manual_event/sync/sieve 不在本断言范围。

## 二、测试 + 可重复脚本（子代理）

1. `src/pw-supervision.test.ts`（登记 package.json test）：内存库夹具——合规 ai_exec（带指令）过；缺指令 ai_exec 被抓；ai_auto corpus 过；ai_auto 非白名单 event_type 被抓；空库 ok。
2. `scripts/pw-harness-audit.mjs`：对真实库跑 `runPwHarnessAudit`（库路径=PAPERTABLE_DATA_DIR 缺省 `~/Library/Application Support/Papertable/papertable.sqlite3`，只读打开），打印违规清单，有违规 exit 1。package.json 加 `"audit:harness": "node scripts/pw-harness-audit.mjs"`——**不进 verify**（真实库内容环境相关）。

## 三、规格对照回勾表 `docs/TASK-PW-27-crosswalk.md`（子代理）

读 `docs/SPEC-harness-write-boundary.md` 全部小节，逐节给实现落点证据（文件:行 / 测试名 / 冒烟记录），格式：| 规格小节 | 要旨 | 落点 | 证据 |。覆盖不了的节如实标「未落地+去向」（如硬闸门 B 属明确不做）。同时把 PW-24/25/26 冒烟里「模型把 ai_draft 无指令误读为缺陷」记为已知观察项。

## 四、菜号牌统一方案（主会话）

对话标签 ↔ 屏幕徽标同源（序号同源=同一排序函数/同一排序规则）：

| 对象 | 标签 | 序号来源 | 装配/工具落点 | 屏幕落点 |
|---|---|---|---|---|
| 候选卡（普通） | `证据 N` | listPwSieveCardsByStatus 序内 normal 相对序 | pw-context 两处 + list_sieve_cards | Collab.tsx 已有 证据 N 徽标（核对） |
| 候选卡（少数派） | `少数派 N` | 同上 wildcard 相对序 | 同上 | 少数派区加徽标 |
| 在途内容押注 | `注 N` | pending 优先→checkout 日升序（与 rail 排序同规则，两边注释互指） | 全局装配 + list_content_bets | rail 加 注 N 徽标 |
| 数据文档 | `文档 N` | collected_at, created_at 序 | 单卡装配 + read_data_docs（改掉我 PW-25 误加的「证据 id」标签，避免与候选卡撞名） | 无（对话内对象） |
| 草稿 | `草稿 <id8>` | 无序号（id 前 8 位） | draft_bet/draft_settle 返回文本 | 无 |
| 语料 | BV 号 | — | 已同源 | 已同源 |
| 金子/墓碑 | `§N` | 装配编号 | 已同源 | 对话外不强求 |

prompt「指认规矩」一条同步改写为新标签集。list_my_actions：ai_draft 行缺指令显示「起草（无需指令）」（修 PW-25 冒烟观察项：模型误读「无引用！」为缺陷）。

## 五、连带测试（主会话）

- pw-context 装配断言更新（证据 N/少数派 N/注 N/文档 N 标签）；pw-collab prompt 指认规矩包含断言更新；list_my_actions 措辞断言。
- read_data_docs 标签改动连带 pw-exec-tools/pw-deepdive 断言。

## 六、验收硬门（主代理亲自）

1. verify 全绿；`node scripts/pw-harness-audit.mjs` 对真实库 exit 0。
2. 指认冒烟（fresh 会话）：「证据 1 挑了」→ AI 锚定正确候选卡（排序首位）；「把注 1 的看结果日改一周」类歧义句 → 反问或正确锚定；全局会话「少数派那张怎么说」→ 正确读卡。
3. ego 截图视觉验收：候选卡证据 N、少数派 N、rail 注 N 徽标与对话标签同源。
