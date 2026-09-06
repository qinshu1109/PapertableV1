# 简报 45 完工：TASK-PW-72 批次 A

## 一句话结论

批次 A 完成：`src/pw-notify.ts` + `src/pw-notify.test.ts` 新建，9 测全绿（覆盖 TASK 八条），`npm run selfcheck` ok，无阻塞。

## 实现要点

只新建两个文件，未改 `package.json` / `src/main.ts` / 任何现有文件。不 import 其他 `pw-*.ts`，不读凭证、不发网络请求。

- `ensurePwNotifyTables`：`pw_bet_signals` / `pw_notification_outbox` / `pw_disposition_tokens`，含 `UNIQUE(event_uuid)` 与 `UNIQUE(bet_id, kind, bet_version)`。
- `createBetSignal`：同一 `BEGIN IMMEDIATE` 事务写三表；冲突返回 `alreadyExists: true` 且不重复出 outbox/token；token 明文 128 bit，表内只存 sha256 hex；`bet_version` P1 恒 1。
- `computeDueSignals`：`status='pending'` 且 `checkout_date <= now+leadHours`（含已过期），默认 24h，逐个 `SETTLEMENT_NEAR`；幂等兜底。
- `listPendingOutbox` / `markOutboxSent` / `markOutboxFailed`：失败退避 1 分钟 × 2^(attempts-1)，上限 30 分钟。
- `verifyDispositionToken`：纯 SELECT，三态 `not_found` / `expired` / `ok`。
- `buildNotifyPayload`：标题「押注状态变化」，一行理由，按钮 `baseUrl/n/{token}`；不含押注标题/thesis/metric。

## 测试输出尾巴

```
✔ 建表幂等且列齐全
✔ createBetSignal 同事务写入三表
✔ 任一步失败则三表全回滚
✔ UNIQUE(bet_id, kind, bet_version) 幂等不重复出 outbox
✔ token 只存 sha256 hash，verify 三态正确
✔ verifyDispositionToken 读路径零写入
✔ 失败退避 1 分钟 × 2^(attempts-1)，上限 30 分钟
✔ payload 标题固定且不含押注全文
✔ computeDueSignals 只选窗口内 pending，重复跑幂等
ℹ tests 9
ℹ pass 9
ℹ fail 0
ℹ duration_ms 77.775292
```

命令：`PATH="$HOME/.local/node/bin:$PATH" node --test src/pw-notify.test.ts`

## selfcheck 结果

`npm run selfcheck` → `selfcheck: ok`（exit 0）。

## git status 证据

本批次新增（未跟踪）：

```
src/pw-notify.test.ts
src/pw-notify.ts
```

`git diff` 对这两个文件为空（纯新增）。仓库工作区另有既有脏文件（大量 `M`/`D`/`??`），不是本批次改的；未碰那些文件。

## 有无阻塞

无。批次 B（main.ts 挂载、前端按钮、CF `/n/*`、凭证发送、package.json test 脚本追加）按 TASK 归 kimi 主控。
