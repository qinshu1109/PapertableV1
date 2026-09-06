# 简报 23：第二期·学习闭环编译层（后端，dsh-cc 通道执行）

- 主控：kimi（w1:p1）；执行：dsh-cc 通道（w1:pK）；验收：codex（w1:pJ）
- 日期：2026-08-14
- 依据：GPT-5.6-Pro 闭环研究报告 + 用户已逐项批准的三张新表（2026-08-14「那就这么改」）。仓库 `/Users/qinshu/Documents/papertableV1`。

## 硬约束

1. 先读 `agent-bridge/GUARDRAILS.md`、`agent-bridge/PROTOCOL.md`。
2. **守门②授权范围=且仅是下面三张新表**（新增，不改任何旧表结构）；建表进 `src/data.ts`，pt_schema 版本号按现有迁移惯例 +1。守门①③④不碰；`frontend/` 不改；不 commit。
3. 项目测试 `npm test`（node --test）必须全绿，新逻辑配新测试文件并登记进 package.json。
4. 完工写 `agent-bridge/out/23-backend-done.md`（改动清单+真实 curl 样例+守门自查），生产后端用 `launchctl kickstart -k gui/$(id -u)/com.qinshu.papertable.backend` 重启生效，写操作演示走隔离实例（`PAPERTABLE_DATA_DIR=/tmp/...`），真库只读。

## 三张新表（用户已批，逐字建）

```sql
CREATE TABLE pw_verdict_promotions (
  id TEXT PRIMARY KEY,
  verdict_id TEXT NOT NULL REFERENCES pw_verdicts(id),
  level TEXT NOT NULL CHECK(level IN ('case_only','prior','warning','hard_constraint','action_item')),
  scope TEXT,                 -- 适用范围（人写）
  review_by TEXT,             -- 复核期限（日期）
  reason TEXT,                -- 晋级理由
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded','expired')),
  superseded_by TEXT REFERENCES pw_verdict_promotions(id),
  decided_by TEXT NOT NULL DEFAULT 'human' CHECK(decided_by='human'),
  created_at TEXT NOT NULL
);

CREATE TABLE pw_precedent_dispositions (
  id TEXT PRIMARY KEY,
  bet_id TEXT NOT NULL REFERENCES pw_bets(id),
  verdict_id TEXT NOT NULL,
  promotion_id TEXT REFERENCES pw_verdict_promotions(id),
  disposition TEXT NOT NULL CHECK(disposition IN ('adopted','distinguished','not_applicable','overridden')),
  reason TEXT,                -- overridden 必填（后端校验）
  created_at TEXT NOT NULL
);

CREATE TABLE pw_verdict_exposures (
  id TEXT PRIMARY KEY,
  surface TEXT NOT NULL,      -- collab / sieve / miner / activation / 其他注入点
  bet_id TEXT,
  verdict_ids_json TEXT NOT NULL,  -- 本次放进上下文的判决 id 数组
  actor TEXT NOT NULL,        -- system / ai
  run_id TEXT,
  created_at TEXT NOT NULL
);
```

索引按查询模式补（dispositions 按 bet_id、exposures 按 created_at / bet_id、promotions 按 verdict_id+status）。

## 端点（契约主控钉死，字段名不许改）

1. `POST /api/pw/verdicts/:id/promote` `{level, scope?, reviewBy?, reason?}` → 创建晋级（decided_by=human 写死；同 verdict 已有 active 晋级→旧的置 superseded、新的接上 superseded 链）。仅归档=`level:'case_only'` 也落一行（表示"人看过、决定不晋级"）。
   `GET /api/pw/verdicts/:id/promotion` → 当前 active 晋级或 null。
2. `GET /api/pw/bets/:id/precedents` → `{items:[{verdictId, outcome, text, source: 'own'|'mirror', promotion: {level, scope}|null, matchReason}]}`。**召回逻辑按适用匹配，不按新近度**：金子墓碑库（含纸桌镜像金子）里与当前押注相关的判决——匹配依据可用指标词/标题词/适用范围文本重叠，宁缺毋滥；无相关就返回空数组（不许拿"最近 10 条"凑数）。
3. `POST /api/pw/bets/:id/precedents/dispose` `{dispositions:[{verdictId, promotionId?, disposition, reason?}]}` → 落账；`overridden` 无 reason → 400。
   **联动闸门**：`POST /api/pw/bets/:id/activate` 在 preflight 通过后再查——precedents 非空且存在未处置项 → 409 带回未处置清单；全部处置完（或无相关先例）才放行。preflight 保持只读不变。
4. **曝光自动记账**：找到判决被注入上下文的现有点（协作台 §N 注入、筛子每轮注入、捞料来源池），每处注入时写一行 `pw_verdict_exposures`（actor=system）。注入点清单先在代码里核实（`src/pw-collab.ts`、`pw-verdict-refs.ts`、筛子/捞料相关），报告里列全。
5. `GET /api/pw/verdicts/exposures?verdictId=...` → 该判决的曝光流水（审计用）。

## 明确不做（本期边界）

- 不改 pw_recall_events 的枚举；不改结账/作废流程本体；不做 UI；不动 `confirmPwBetDraft` 之外的既有确认通路（协作台 AI confirm_bet_draft 是否接入闸门仍是用户挂起项，本期不接）。
