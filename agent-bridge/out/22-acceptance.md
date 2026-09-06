# 22-acceptance：第一期·浏览器 + 接口验收

## 这刀是干什么的

- **什么能用了**：押注台默认总账、异常队列、单卡驾驶舱、补数据入口、双账主体、两支只读接口和隔离激活闸门都能跑通；生产 4317 全程只读。
- **什么还不行**：初验唯一失败项曾把「同因作废复发」显示成 `[object Object]`；主控修复上线后已复测通过，当前没有未通过项。
- **有什么等拍板**：本轮没有新增拍板项。

## 怎么算好

打开押注台应先看到 6 笔承诺总账和 3 笔异常；点表行能进驾驶舱并返回，点「补数据」能打开录入弹层。大盘双账应显示有效结账 1，运行账七项不能出现假值或对象占位。两支生产接口只读复核；激活相关写态只在 4399 隔离库验证 409、200、人工提示和幂等零写。

---

## 以下给干活的看，可以跳过

## 总结

| 项目 | 结果 | 说明 |
|---|---|---|
| 1. 押注台默认首页 = 承诺总账 | 通过 | 6 笔在途；3 笔到期缺数据；字段齐；驾驶舱、返回、补数据弹层均实点通过 |
| 2. 大盘双账 | 通过（复测） | 初验第七项显示 `[object Object]`；主控修复后复测为人读文本「其他×2」 |
| 3. 两支接口契约 | 通过 | HTTP 200；字段名、嵌套结构、成熟度枚举均符合简报 21 |
| 4. 激活闸门（隔离实例） | 通过 | fail→409 零写；全 pass→200/pending；needs_human→200/pending 且带提示；preflight 两次零写 |
| 5. 红线 | 通过 | 1808 视口无横向滚动；应用自身无控制台报错；生产未执行激活/结账/其他写操作 |

**总判定：全绿。初验唯一前端失败项已修复并复测关闭。**

## 1. 押注台默认首页 = 承诺总账 — 通过

生产页面 `http://127.0.0.1:4317/`，浏览器视口 `1808 × 1000`：

- 默认进入押注台后是「承诺总账」，不是单卡。
- 总账共 6 行：3 行「到期缺数据」、3 行「在途」。
- 顶部「异常队列 · 3」列出同三笔到期缺数据押注，均有「补数据」。
- 表头齐全：编号 / 押注 / 看结果日 / 把握 / 验证指标 / 数据 / 状态。
- 点击首行进入单卡驾驶舱：押注卡、深挖/发散/改道三张分支卡、开干位、判决簿、创作决策闭环均在。
- 点击「← 返回总账」能返回。
- 点击异常队列首个「补数据」打开「录入数据文档」弹层；只打开并取消，未提交生产写操作。
- `document.documentElement.scrollWidth === clientWidth === 1808`。

证据：

- `agent-bridge/qa-evidence/22-workbench-ledger.png`
- `agent-bridge/qa-evidence/22-workbench-cockpit.png`
- `agent-bridge/qa-evidence/22-data-entry-modal.png`

## 2. 大盘双账 — 初验失败记录（前端，已复测关闭）

通过部分：

- 目标横幅下出现「双账 · 判断成绩与运行健康」。
- 认识论账显示有效结账 `1`。
- 运行账前六项正常：到期可结率 `0%`、有效结账率 `33%`、平均结账延迟 `2407 天`、结账债务 `0 天`、可避免作废率 `0%`、自动供血成功率 `100%`。
- 页面无 `NaN` 或 `undefined`；`scrollWidth === clientWidth === 1808`。

失败项：

- 「同因作废复发」显示 `[object Object]`，没有把接口返回的 `{cause:"其他", count:2}` 展示成人能读的内容。
- 分类：**前端问题**。只记录，不派代理；留主控 kimi 亲自修。
- 只读定位：`frontend/src/pw/Dashboard.tsx` 当前对 `recurringVoidCauses` 使用 `String(c)` 拼接对象。

证据：`agent-bridge/qa-evidence/22-dashboard-health.png`。

## 2A. 大盘双账复测 — 通过

2026-08-14 只复测初验唯一失败项；强制禁用浏览器缓存后重新打开生产 `4317` 大盘：

- 「同因作废复发」显示人读文本 `其他×2`。
- 旧文本 `[object Object]` 已消失。
- 页面无 `NaN` 或 `undefined`。
- `document.documentElement.scrollWidth === clientWidth === 1808`，无横向滚动。
- 页面运行时 `window error` / `unhandledrejection` 为 `[]`；应用来源控制台错误为 `[]`。

复测证据：`agent-bridge/qa-evidence/22-dashboard-health-recheck.png`。

## 3. 接口复核 — 通过

生产 4317 仅执行 GET：

```text
GET /api/pw/bets/ledger → HTTP 200
rows = 6
maturity = [due_missing_data, due_missing_data, due_missing_data, not_due, not_due, not_due]
```

逐行包含：

```text
betId, title, betType, activatedAt, dueAt, confidence, metricSummary,
dataSource { kind, status, lastDataAt }, maturity, revisionCount, nextForcedEvent
```

所有 `maturity` 均落在简报 21 枚举：

```text
not_due | due_ready | due_missing_data | metric_invalid | overdue
```

```text
GET /api/pw/health-accounts → HTTP 200
epistemic.validSettlements = 1
operational = {
  dueReadyRate: 0,
  validSettlementRate: 0.33,
  avgSettleLatencyDays: 2407,
  settleDebtDays: 0,
  avoidableVoidRate: 0,
  autoFeedSuccessRate: 1,
  recurringVoidCauses: [{cause: "其他", count: 2}]
}
```

接口结构和简报 21 契约一致。`[object Object]` 只发生在前端展示层，不是接口结构错误。

## 4. 激活闸门（4399 隔离实例）— 通过

隔离数据目录：`/tmp/pw-acc-data.HCulsW`；服务由同一份 `createApp` 在 `127.0.0.1:4399` 启动。验收后已停服务并丢弃隔离目录。

### 4.1 fail 草稿

```json
{
  "http": 409,
  "error": "激活预检未通过，请先处理失败项",
  "failedCheck": {"name":"data_source","result":"fail","detail":"缺少数据来源（data_source_plan 为空）"},
  "statusAfter": "draft",
  "databaseUnchanged": true
}
```

### 4.2 全 pass 草稿

```json
{
  "http": 200,
  "checks": ["data_source:pass", "metric:pass", "checkout_date:pass"],
  "pass": true,
  "statusAfter": "pending"
}
```

### 4.3 仅 needs_human 草稿

```json
{
  "http": 200,
  "dataSourceCheck": {"result":"needs_human","detail":"已确认走手动录入（不拦激活）"},
  "pass": true,
  "statusAfter": "pending"
}
```

### 4.4 preflight 幂等零写

同一全 pass 草稿连续调用两次 preflight。调用前、第一次后、第二次后逐行比较 `pw_bets`、`pw_draft_events`、`pw_runs`、`pw_data_docs`：完全一致，`preflightIdempotent = true`。

## 5. 红线 — 通过

- 生产 4317：只执行页面读取和两支 GET；补数据弹层只打开后取消。未激活、未结账、未提交任何真实押注写操作。
- 隔离 4399：仅用于创建验收草稿和验证激活闸门。
- 押注台、驾驶舱、大盘均实测 `scrollWidth = clientWidth = 1808`，无横向滚动条。
- 页面运行时 `window error` / `unhandledrejection` 为 `[]`；应用来源控制台错误为 `[]`。
- 浏览器扩展「沉浸式翻译」产生两条 `chrome-extension://... dynamic-i18n version mismatch`，来源不是 Papertable，作为环境噪声排除。

## 失败项分类与修复回路

### 前端问题（初验记录，已关闭）

1. 大盘「同因作废复发」显示 `[object Object]`。证据：`agent-bridge/qa-evidence/22-dashboard-health.png`。

按用户改令：前端问题未派代理，由主控 kimi 亲自修复；2026-08-14 复测通过，问题关闭。

### 后端问题

无。未触发 `herdr agent prompt w1:pK` 直投回路。

## 验收边界

- 只验不修；未修改产品代码、验收标准或守门文件。
- 未 commit、未 push。
