# 第二期（判决晋级 / 先例处置 / 曝光账）验收

日期：2026-08-14  
验收人：Codex（主控 kimi 的浏览器+接口验收）  
总判定：**全绿（复测通过）。**

## 这刀是干什么的 / 怎么算好

第二期把“结账后的判断”编译成可复用规则，把已有金子/墓碑作为激活前的先例闸门，并留下判决被哪些界面/流程使用过的曝光流水。

通过标准：晋级档位与 scope 约束正确；有匹配先例时未处置不能激活、处置后才可激活；无关草稿不被误拦；曝光与匹配召回可追溯；生产 4317 只读；1808 宽度无横向滚动；无 NaN/undefined 与运行时错误；原有押注台/大盘/协作台不回归。

## 环境与证据纪律

- 生产：`http://127.0.0.1:4317` 真库，只执行 GET 读取；未在生产激活、结账或写入真实押注。
- 隔离：`http://127.0.0.1:4399`，数据目录 `/tmp/pw24-acceptance.qHNf4t`；所有创建、处置、激活、结账均在此实例。
- 浏览器视口：1808×1000；截图由浏览器页面导出，均为 `24-` 前缀。
- 主要截图：
  - [24-workbench.png](/Users/qinshu/Documents/papertableV1/agent-bridge/qa-evidence/24-workbench.png)
  - [24-activate-modal.png](/Users/qinshu/Documents/papertableV1/agent-bridge/qa-evidence/24-activate-modal.png)
  - [24-promotion-modal.png](/Users/qinshu/Documents/papertableV1/agent-bridge/qa-evidence/24-promotion-modal.png)
  - [24-void-modal.png](/Users/qinshu/Documents/papertableV1/agent-bridge/qa-evidence/24-void-modal.png)
  - [24-dashboard.png](/Users/qinshu/Documents/papertableV1/agent-bridge/qa-evidence/24-dashboard.png)
  - [24-collab.png](/Users/qinshu/Documents/papertableV1/agent-bridge/qa-evidence/24-collab.png)

## 验收结论总表

| 项目 | 结果 | 证据摘要 |
|---|---|---|
| 1. 结账晋级 | **通过（复测）** | 隔离浏览器已完成结账→判决晋级→选档→填写适用范围→落账；按钮可点，落账成功，GET promotion 返回 active 且 `decided_by=human`。 |
| 2. 待转正条 + 先例处置 | **通过** | 押注台显示“待转正”；激活弹层显示三项预检、匹配先例与四种处置；未处置确认被拦，采用后激活成功。 |
| 3. 激活关联闸门 | **通过** | 匹配先例未处置直激活 409；处置后 200、状态 `pending`；无关草稿先例为空且可直接激活。 |
| 4. 曝光账 | **通过** | 隔离激活产生 2 条 `surface=activation`、`actor=system` 流水；生产 GET 正常返回空账，不写生产。 |
| 5. 先例召回 | **通过** | `/precedents` 返回按标题/指标/来源匹配的 `matchReason`；真正无关草稿返回 `items:[]`，不是最近 10 条。 |
| 6. 生产与回归 | **通过** | 4317 只读 GET；押注台/大盘/协作台可用；1808 宽无横向滚动；浏览器运行时错误为空；无 NaN/undefined。 |

## 1. 结账晋级

### 接口（隔离实例）

- 金子结账后 verdict：`543d2fc9-bf73-4c2f-9e73-7cebf351ddff`。
- 已验证五档：`case_only`、`prior`、`warning`、`hard_constraint`、`action_item`；非 `case_only` 带 scope 时 HTTP 201，返回 `decided_by=human`；重复晋级旧 active 行变为 `superseded`，新行 active。
- 首次发现后端缺陷：`level=prior` 缺 scope 错误返回 HTTP 201、`scope:null`。
- 已按指定回路直投 dsh-cc：`/Users/qinshu/.local/bin/herdr-cc-prompt w1:pH`。修复记录：[24-scope-required-fix.md](/Users/qinshu/Documents/papertableV1/agent-bridge/out/24-scope-required-fix.md)。
- 修复后复测：
  - `{"level":"warning"}` → HTTP 400，`非 case_only 晋级必须填写适用范围 scope`；
  - `{"level":"hard_constraint","scope":"   "}` → HTTP 400；
  - `{"level":"case_only"}` → HTTP 201（允许无 scope）。
- dsh-cc 报告 `npm test`：420/420 通过；前端未由 dsh-cc 改动。

### 浏览器（初验记录，保留）

- 押注台对隔离 BET-03 执行结账，确实进入“判决晋级”弹层，五档全部可见，见 [24-promotion-modal.png](/Users/qinshu/Documents/papertableV1/agent-bridge/qa-evidence/24-promotion-modal.png)。
- **初验失败（前端，现已由主控修复）**：结账请求成功后 `Workbench.tsx` 的 `submit` 将 `busy` 设为 `true`，成功分支只 `setSettledVerdict(v)` 未恢复 `busy=false`（`frontend/src/pw/Workbench.tsx:1251-1261`）；晋级弹层沿用该状态，提交按钮在 `frontend/src/pw/Workbench.tsx:1337-1338` 显示“落账中…”且 disabled，无法从 UI 完成晋级。该记录保留，复测见下文。

### 作废不晋级

- 隔离 BET-04 补入隔离数据后，从浏览器选择“作废”；弹层明确显示“作废不进入金子墓碑库，也不消耗这次判断”，见 [24-void-modal.png](/Users/qinshu/Documents/papertableV1/agent-bridge/qa-evidence/24-void-modal.png)。确认后直接提示“已结账：作废”，未出现晋级弹层。

## 2. 待转正条与先例处置

- 押注台顶部显示“待转正 · 2（过闸门＋处置先例后转正）”，见 [24-workbench.png](/Users/qinshu/Documents/papertableV1/agent-bridge/qa-evidence/24-workbench.png)。
- 隔离草稿“直播切片试水·UI先例处置”打开激活弹层：`data_source` 为 ⚠（手动录入不拦）、`metric` 与 `checkout_date` 为 ✓；匹配金子“直播切片先验证曝光，再决定是否扩展”，展示硬约束与 `matchReason`，见 [24-activate-modal.png](/Users/qinshu/Documents/papertableV1/agent-bridge/qa-evidence/24-activate-modal.png)。
- 不选处置直接点“确认转正”被拦，页面提示“每条先例都要给个处置：采用 / 区分 / 不适用 / 覆盖”。选择“采用”后激活成功，状态进入 `pending`，DB 有对应 `pw_precedent_dispositions` 行。

## 3. 激活关联闸门（接口）

- 匹配草稿 `46668852-610e-4f1f-bdb9-a4adf38bd01c`：未处置激活 → HTTP 409，错误为“存在未处置的先例判决，请先处置”，`details.undisposed` 列出 1 条；处置后激活 → HTTP 200，状态 `pending`。
- 真正无关草稿 `81f21942-4246-43a2-8109-595ed73f6e30`：GET precedents → `{items:[]}`；直接激活 → HTTP 200，状态 `pending`。

## 4. 曝光账

- 隔离 verdict `543d2fc9-…` 的 GET `/api/pw/verdicts/exposures?verdictId=…` 返回 2 条激活流水，均为 `surface=activation`、`actor=system`，含对应 `betId`。
- 生产 verdict `663a9496-71a2-429b-9349-d6c4563cbfb1`：GET exposure HTTP 200、`exposures:[]`；未执行任何生产写操作。

## 5. 先例召回

- 生产只读：GET `/api/pw/bets/92ee0d45…/precedents` HTTP 200，返回自身墓碑（指标/来源命中）及镜像金子（标题命中），每项带 `matchReason`。
- 生产无关 bet `cbd6791a…`：GET precedents HTTP 200、`items:[]`。
- 隔离匹配草稿同样返回自身金子及 `matchReason`；实现口径为匹配召回，不是最近 10 条。

## 6. 生产浏览器与回归

- 4317 押注台：待转正条、先例入口与异常队列可见；宽度 `scrollWidth === clientWidth === 1808`。
- 4317 大盘：双账（判断成绩与运行健康）可见；无 NaN/undefined；`scrollWidth === clientWidth === 1808`，见 [24-dashboard.png](/Users/qinshu/Documents/papertableV1/agent-bridge/qa-evidence/24-dashboard.png)。
- 4317 协作台：页面可用；`scrollWidth === clientWidth === 1808`，见 [24-collab.png](/Users/qinshu/Documents/papertableV1/agent-bridge/qa-evidence/24-collab.png)。
- 生产浏览器探针收集的 `runtimeErrors=[]`、`appErrors=[]`；隔离浏览器复测 `runtimeErrors=[]`，页面无 NaN/undefined。

## 失败项分类

### 前端

1. **晋级提交按钮被错误禁用（初验记录，已关闭）**：结账成功后 `busy` 没有在进入晋级步骤前复位，导致按钮持续“落账中…”；路径 `frontend/src/pw/Workbench.tsx:1251-1261,1337-1338`。主控修复并重新 build 后，以下复测通过。

### 后端

- 本轮发现的 scope 校验缺陷已直投 dsh-cc 修复并复测通过；修复记录见 [24-scope-required-fix.md](/Users/qinshu/Documents/papertableV1/agent-bridge/out/24-scope-required-fix.md)。当前隔离接口不再允许非 `case_only` 缺 scope，未发现其他后端失败项。

## 复测小节（2026-08-14）

本小节追加在初验记录之后；初验失败描述与截图均保留。

- 环境：隔离实例 `http://127.0.0.1:4399`，数据目录 `/tmp/pw24-recheck.BR72Kx`；生产 4317 未执行写操作。
- 押注：`6988ec51-8b24-4281-ba98-94fe7964b1c9`（BET-01），先录入隔离数据文档 `290b8670-40f5-43ee-9d5f-bd71f3b0e476`。
- 浏览器完整链路：从押注台“去结账”进入结账弹层，选“铸金”、填写判断、勾选数据文档并确认；随后进入“判决晋级”弹层，五档可见。
- 选档与填写：选择“正向先验”，填写适用范围“人工录入的内容实验，播放量达到目标时适用”。DOM 复核提交按钮为 `text="落账"`、`disabled=false`；点击后弹层关闭，页面提示“已结账：铸金”，押注卡状态为“已结账 · 金子”，判决簿出现新金子记录。
- 接口复核：settled verdict `bd55a3b8-9690-484d-8515-2083193d0280`；GET `/api/pw/verdicts/bd55a3b8-9690-484d-8515-2083193d0280/promotion` 返回 HTTP 200：`level=prior`、`scope=人工录入的内容实验，播放量达到目标时适用`、`status=active`、`decided_by=human`。
- 红线探针：页面 `scrollWidth=clientWidth=1808`，无 NaN/undefined，浏览器运行时错误为空。
- 新截图：[24-promotion-recheck.png](/Users/qinshu/Documents/papertableV1/agent-bridge/qa-evidence/24-promotion-recheck.png)。

复测结论：简报 24 唯一前端失败项已关闭，结账→判决晋级→选档→适用范围→落账全链路通过；总判定更新为**全绿**。
