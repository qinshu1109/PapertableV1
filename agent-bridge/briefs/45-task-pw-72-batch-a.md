# 简报 45 · TASK-PW-72 批次 A：押注信号后端模块

## 任务来源

TASK 文件：`/Users/qinshu/Documents/papertableV1/docs/TASK-PW-72-bet-notify-p1.md`（**先完整读完再动手**）。

工作仓库：`/Users/qinshu/Documents/papertableV1`（不是当前 cwd 的 kimi窗口 克隆）。

## 范围

只做 TASK 里的**批次 A**：新建 `src/pw-notify.ts` + `src/pw-notify.test.ts` 两个文件，实现三表（`pw_bet_signals` / `pw_notification_outbox` / `pw_disposition_tokens`）和六个导出函数（`ensurePwNotifyTables` / `createBetSignal` / `computeDueSignals` / `listPendingOutbox` / `markOutboxSent` / `markOutboxFailed` / `verifyDispositionToken` / `buildNotifyPayload`），表结构与函数语义严格按 TASK 文档。

批次 B（main.ts 挂载、前端、CF 配置、凭证）**不归你**，kimi 主控亲手做。

## 红线

1. 只能新建上述两个文件；不得修改任何现有文件（含 `package.json`——test 脚本由批次 B 追加）。
2. **禁止读取 `~/.paperweight/feishu-notify.json` 或任何凭证文件；禁止发起真实网络请求**（飞书发送在批次 B）。
3. 不 import 其他 `pw-*.ts`；测试用 `node:sqlite` 内存库自包含。
4. 代码与注释不得出现 digest/日报/定时推送逻辑。
5. 遵守四字段与「并行约定」，不得扩大范围。

## 验收（你自己必须跑绿再回报）

```bash
cd /Users/qinshu/Documents/papertableV1
PATH="$HOME/.local/node/bin:$PATH" node --test src/pw-notify.test.ts
PATH="$HOME/.local/node/bin:$PATH" npm run selfcheck
git status --short   # 改动面只能有两个新文件
```

覆盖点见 TASK「批次 A 验收」八条（同事务回滚、UNIQUE 幂等、token 只存 hash、verify 三态、读路径零写入、退避、payload 不含全文、computeDueSignals 幂等）。

## 产出

完工报告写 `/Users/qinshu/Documents/papertableV1/agent-bridge/out/45-pw-notify-batch-a.md`：实现要点、测试输出尾巴、selfcheck 结果、git status 证据、有无阻塞。

## 完工主动回报（必须执行）

完工后立刻执行：

```bash
herdr agent prompt wG:p1 "简报45 完工：一句话结论 + 产出路径 + 有无阻塞"
```

写完不回报 = 没完工。
