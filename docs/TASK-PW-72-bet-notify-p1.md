# TASK-PW-72 押注信号与飞书通知链路（P1 纵向最小闭环）

- 主需求域：判断沉淀与复用
- 业务接口：无（域内）。只读 `pw_bets`（TASK-PW-01 建表，同域）。`SETTLEMENT_NEAR` 的 P1 口径为**纯时间规则**，不消费回流数据——「指标是否为空/有无回流」的语义归实践与数据回收域（`pw-bet-health.ts` 的 maturity 口径是唯一权威），本任务不重新解释；后续需要「指标为空才响」的增强时再经跨域接口消费。
- 数据真值源：新建 `pw_bet_signals`、`pw_notification_outbox`、`pw_disposition_tokens` 三表（本任务创建并独占表结构）；只读 `pw_bets`
- 质量约束与验收终态：批次 A 单测全绿 + `npm run selfcheck` 不退化 + 改动面只有两个新文件；批次 B 真机八条全过。见文末验收。

## 白话说明

押注要到期时，系统主动把一张卡片弹到你手机锁屏上；点卡片打开一个只读证据页（不再经过 Cloudflare 邮箱验证码），看完回镇纸处置。本 TASK 建这条链路的骨架：信号表、发件箱、短时令牌、证据页。运输能力已在 2026-08-28 用 20 张测试卡片实测通过（飞书机器人 20/20 弹到锁屏）。

**运输层偏差记录**：PRD（`docs/# DeepSeek Harness「押注通知链路」落地 PRD.md`）原计划自托管 ntfy 做运输层；P0 实测后改用飞书租户自建应用「琴疏的智能助手」（凭证 `~/.paperweight/feishu-notify.json`，mode 600，简报 42/43/44）。PRD 的其余设计——四类信号、同事务 outbox、能力令牌、CF 只对 `/n/*` 开缝、处置安全、观测指标——不变，P2/P3 仍按 PRD 推进。通知纪律：事件驱动、有合格对象才响；不做每日 digest，不做后台检索。

## 批次 A：后端模块（派 grok）

### 并行约定（PW 后端批通用，必须遵守）

- 只能新建两个文件：`src/pw-notify.ts`、`src/pw-notify.test.ts`；不得修改 `src/main.ts`、`src/data.ts`、`package.json`、`frontend/**`、`public/**` 及任何其他现有文件。
- 表创建用模块内 `ensurePwNotifyTables(db)`（`CREATE TABLE IF NOT EXISTS`），不建共享迁移文件。
- 不 import 任何其他 `pw-*.ts` 模块；跨模块引用只存 id 字符串，不加 `REFERENCES` 外键约束（集成阶段统一补）。
- HTTP 挂载不做（批次 B 统一接 `src/main.ts`）；本模块只导出纯函数，函数接收 `DatabaseSync`，测试用 `node:sqlite` 内存库自包含。
- **禁止读取 `~/.paperweight/feishu-notify.json` 或任何凭证文件；禁止发起真实网络请求。** 发送凭证与飞书 API 调用由批次 B 集成层负责，模块函数只收参数、组 payload。

### 范围：`src/pw-notify.ts`

`ensurePwNotifyTables(db)` 建三表：

```sql
pw_bet_signals(
  id TEXT PRIMARY KEY,
  event_uuid TEXT NOT NULL UNIQUE,
  bet_id TEXT NOT NULL,            -- pw_bets.id，不加外键
  kind TEXT NOT NULL CHECK(kind IN ('SETTLEMENT_NEAR','USER_TIMER_DUE','EVIDENCE_CHANGED','STALE_LOCAL','MANUAL_TEST')),
  observed_at TEXT NOT NULL,
  bet_version INTEGER NOT NULL DEFAULT 1,
  evidence_snapshot_id TEXT,       -- P1 恒 NULL，P2 预留
  reason_json TEXT NOT NULL DEFAULT '{}',
  severity TEXT NOT NULL DEFAULT 'normal' CHECK(severity IN ('low','normal','high')),
  created_at TEXT NOT NULL
);
-- 幂等键（PRD 死法4）：UNIQUE(bet_id, kind, bet_version)

pw_notification_outbox(
  id TEXT PRIMARY KEY,
  event_uuid TEXT NOT NULL UNIQUE, -- 对应 pw_bet_signals.event_uuid
  transport TEXT NOT NULL DEFAULT 'feishu',
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  sent_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);

pw_disposition_tokens(
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE, -- sha256 hex，绝不存明文
  event_uuid TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
```

导出函数（全部纯函数风格，`db` 由调用方传入）：

- `createBetSignal(db, input, opts)`：在**同一 SQLite 事务**内写 `pw_bet_signals` + `pw_notification_outbox` + `pw_disposition_tokens`（PRD §5.3）。幂等：`UNIQUE(bet_id, kind, bet_version)` 冲突时返回已有信号并带 `alreadyExists: true`，不重复插行、不重复生成 outbox 与 token。token 用 `crypto.randomBytes(16).toString('hex')`（128 bit）生成明文，只把 sha256 hex 存表。`input: { betId, kind, severity?, reason? }`；`opts: { now, tokenTtlHours?, baseUrl? }`（token 默认 48 小时有效）。`bet_version` P1 恒 1（`pw_bets` 无版本列；同一押注同一信号类型只响一次，再提醒/snooze 由 P2 处置流解决）。
- `computeDueSignals(db, opts)`：P1 唯一真实规则——`status='pending'` 且 `checkout_date` 落在 `now` 至 `now+leadHours`（含已过期）窗口内的押注，逐个调 `createBetSignal` 生成 `SETTLEMENT_NEAR`；默认 `leadHours=24`。重复跑不得产生重复信号（幂等兜底）。
- `listPendingOutbox(db, now)`：`sent_at IS NULL AND next_attempt_at <= now`，按 `created_at` 升序。
- `markOutboxSent(db, id, sentAt)` / `markOutboxFailed(db, id, error, opts)`：失败 `attempts++`，`next_attempt_at` 指数退避（1 分钟 × 2^attempts，上限 30 分钟）。
- `verifyDispositionToken(db, tokenPlaintext, now)`：**纯读**。不存在 → `{status:'not_found'}`；`expires_at` 已过 → `{status:'expired'}`；有效 → `{status:'ok', eventUuid, signal 摘要}`。不得写任何表。
- `buildNotifyPayload(signal, bet, tokenPlaintext, baseUrl)`：纯函数，组飞书卡片 payload（批次 B 只负责把它发出去）。格式纪律（PRD §7.4）：标题固定「押注状态变化」；正文只有一行理由（`SETTLEMENT_NEAR`→「结账日临近」，`MANUAL_TEST`→「测试信号」）；**不含押注标题、thesis、metric 等任何长文本**；一个「查看证据」按钮指向 `${baseUrl}/n/${tokenPlaintext}`。

### 否定验收（批次 A）

- 代码与注释中不得出现 digest / 日报 / 定时推送任何字样与逻辑（事件驱动，非日历驱动）；
- 不得读凭证文件、不得发网络请求；
- `verifyDispositionToken` 等读路径零写入；
- payload 不含押注全文字段。

## 批次 B：集成（kimi 主控亲手做，不派单；含前端与凭证，死约束）

- `src/main.ts`：`POST /api/pw/notify/test-signal`（手动产生 `MANUAL_TEST` 信号）、`POST /api/pw/notify/compute-due`（手动触发 `computeDueSignals`，P1 不接定时器）、`GET /n/:token`（只读证据页半静态 HTML：押注标题、触发规则、observed_at、证据占位；404/410 语义按 `verifyDispositionToken` 三态）、sender 循环（`setInterval` 30s 扫 `listPendingOutbox`，用飞书 tenant token 发送；**凭证只有这里读**，从 `~/.paperweight/feishu-notify.json`）。
- `package.json` 的 `test` 脚本追加 `src/pw-notify.test.ts`。
- 前端押注台加「产生测试信号」按钮（前端死约束：kimi 亲手）。
- Cloudflare：tunnel ingress 加 `dsh.cozai.net` 的 `/n/*` → `127.0.0.1:4317`（必须放在 dsh catch-all 之前）；CF Access 新建 `dsh-disposition` 应用覆盖 `/n/*` 设 Bypass，`dsh.cozai.net/*` 根路径保持现有邮件 OTP。

## 验收

### 批次 A（grok 完成标准）

- `node --test src/pw-notify.test.ts` 全绿：建表幂等；同事务（任一步失败全回滚）；`UNIQUE(bet_id,kind,bet_version)` 幂等不重复出 outbox；token 只存 hash 且 verify 三态正确；读路径零写入；退避节奏正确；payload 不含押注全文；`computeDueSignals` 重复跑幂等。
- `npm run selfcheck` 不退化。
- `git status` 改动面只有 `src/pw-notify.ts`、`src/pw-notify.test.ts` 两个新文件。

### 批次 B（真机八条，P1 验收终态）

1. 点「产生测试信号」后手机锁屏弹通知；
2. 点通知打开证据页，不出现 Cloudflare OTP；
3. `https://dsh.cozai.net/` 根路径仍要求 OTP；
4. 无效 token → 404；
5. 过期 token → 410；
6. GET 证据页对正式表零写入（请求前后 `pw_*` 表行数不变）；
7. 同一 `event_uuid` 重复提交只产生一条通知；
8. 通知正文不含押注全文。

## 明确不做（P1 范围外）

- `USER_TIMER_DUE` / `EVIDENCE_CHANGED` / `STALE_LOCAL` 的自动触发；
- 处置动作（ack / snooze / enter_review）与 `bet_command`（P2）；
- `evidence_snapshot` 表（P2）；
- 进程内定时器自动跑 `computeDueSignals`（P2，PRD §5.1：本地到期检查可用 timer，重启后补算，不算后台捞料）；
- dsh 插件桥接（P3）。
