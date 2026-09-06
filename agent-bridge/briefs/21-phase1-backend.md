# 简报 21：第一期·运行闭环止血（后端三项，cc-tui 执行）

- 主控：kimi（w1:p1）；执行：cc-tui（w1:pH，dsh）；浏览器验收：codex（w1:pJ）
- 日期：2026-08-14
- 依据：GPT-5.6-Pro 闭环研究报告（用户已拍板**第一期全开**）。仓库 `/Users/qinshu/Documents/papertableV1`。

## 开工前必读（硬约束）

1. 先读 `agent-bridge/GUARDRAILS.md` 与 `agent-bridge/PROTOCOL.md`。
2. **守门①特别授权（本次唯一）**：用户明确批准为实現"激活前数据就绪闸门"改动押注激活流程代码。**授权范围仅限闸门本身**——不得顺手改其他状态机迁移、权限判断、结账/确认流程。守门②（数据库 schema）本期**不许碰**：三项全部用现有表算出来。守门③④同理不碰。
3. 只做后端：`src/` 与测试。`frontend/` 一个字不改（前端归主控亲自做）。不 commit、不 push。
4. 测试：项目现有测试必须全绿，新逻辑配新测试（后端测试命令以 package.json 为准）。

## 背景（研究报告的核心诊断）

当前系统"押注→数据→到期→结账"运行环没闭合：18 笔押注 7 笔作废仅 1 笔有效结账，自动数据回流产出为 0，押注台无到期提醒与异常队列。第一期三项后端全部围绕"让到期和数据状态可见、让不可结账的押注在激活前被拦"。

## 任务一：激活前数据就绪闸门

- 新增 `POST /api/pw/bets/:id/activate/preflight`：对草稿/待激活押注做只读预检，返回 `{checks: [{name, result: pass|fail|needs_human, detail}], pass: boolean}`。检查项至少：
  - 数据源绑定存在且可试读（自动源如 B站同步：真实试读/连通性检查；手动录入源：标 `needs_human` 而不是 fail，语义="已确认走手动录入"）
  - 验证指标可判定（指标字段非空、判定规则明确）
  - 结账日可达（不是过去、不是缺失）
- 修改激活端点：preflight 不过（有 fail）→ 409 返回失败清单；仅 needs_human → 允许激活但响应里带回提示。注意选题类内容押注的三行赌注是重释语义（演示困惑/转化信号/看结果日），检查逻辑按现有数据结构来，先读 `src/` 里押注与数据源的现状实现再设计。
- 幂等、只读 preflight 不产生任何写。

## 任务二：押注成熟度总账 API（前端 blotter 的数据源，契约由主控钉死）

`GET /api/pw/bets/ledger` → `{rows: [...]}`，每行字段名必须包含：
`betId, title, betType, activatedAt, dueAt, confidence, metricSummary, dataSource: {kind, status, lastDataAt}, maturity, revisionCount, nextForcedEvent`

- `maturity` 枚举：`not_due | due_ready | due_missing_data | metric_invalid | overdue`（到期未结且可结=overdue；到期缺数据=due_missing_data；指标失效=metric_invalid）。
- 排序：overdue → due_missing_data → metric_invalid → due_ready → not_due（到期近的先）。
- 全部从现有表只读聚合；字段缺数据时给 null 不要编造。

## 任务三：双账度量 API

`GET /api/pw/health-accounts` →
```json
{
  "epistemic": {"validSettlements": 0, "byCohort": []},
  "operational": {
    "dueReadyRate": 0, "validSettlementRate": 0, "avgSettleLatencyDays": 0,
    "settleDebtDays": 0, "avoidableVoidRate": 0, "autoFeedSuccessRate": 0,
    "recurringVoidCauses": []
  }
}
```
口径按研究报告第 6 节：认识论账只计有效结账；运行账计逾期/可避免作废/数据故障/自动供血。字段算不出就给 null 并注释原因，不许编数。

## 交付与验收

- 代码 + 测试绿 + 写 `agent-bridge/out/21-backend-done.md`：三个端点的真实 curl 请求/响应样例（镇纸后端 127.0.0.1:4317，重启服务用 `launchctl kickstart -k gui/$(id -u)/com.qinshu.papertable.backend`，重启后等几秒再 curl）。
- 写完不用找主控；codex 会来做浏览器+接口验收，发现问题会以简报形式回给你修。
