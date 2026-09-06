# 16 · 提案契约 + 状态机（后端）

先读 `agent-bridge/GUARDRAILS.md`，红线默认生效。本任务纯加法：新表 + 新文件 + 新路由，
不改任何现有业务行为；唯一允许的现有文件改动：main.ts 注册路由、pw-mode-bar.ts 加一个
计数字段（见下）。

## 背景

协作台研究报告主答案：协作台 = 外部智能的入境口岸。外部 agent（claude/codex/脚本）的产出
统一走「提案」进入系统：固定版本 + 证据包 + 自动检查 + 人类状态迁移。铸币权在人——但只有
人能做的状态迁移由人来点，批准后由可信服务机械记账。

## 新表 `pw_proposals`

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | randomUUID |
| schema_version | INTEGER | 常量 1 |
| lane | TEXT | `content`（内容决策：选题/草案/押注类）/ `ops`（系统维护：代码/测试/验收类） |
| title | TEXT | 一句话标题 |
| target_kind | TEXT | 如 `code_change`/`content_draft`/`bet`/`doc`/`report` |
| target_id | TEXT NULL | 目标对象 id（可无） |
| base_version | TEXT NULL | 基准版本（commit hash / 文档版本）；apply 时校验用 |
| brief_ref | TEXT NULL | 任务简报路径（agent-bridge/briefs/xx.md） |
| proposed_by | TEXT | `claude`/`codex`/`kimi`/`script` 等 |
| payload_json | TEXT | 提案正文（草稿/diff 摘要/报告指针） |
| evidence_json | TEXT NULL | `{for:[], against:[], unknowns:[]}` 证据引用 |
| checks_json | TEXT NULL | `[{name, source, version, result, artifactRef}]` 自动检查 |
| risk | TEXT NULL | 影响面/可逆性说明 |
| requested_action | TEXT NULL | 要求人做什么（接受/退修/否决以外的说明） |
| status | TEXT | 状态机，见下 |
| review_note | TEXT NULL | 人退修/否决时填的理由 |
| created_at / updated_at | TEXT | nowIso |
| expires_at | TEXT NULL | 过期即失效（只读查询时不自动翻状态，accept/apply 时校验） |
| applied_at / applied_by | TEXT NULL | apply 记账 |

索引：`(lane, status)`、`(status, created_at)`。幂等建表，风格照 pw-miner.ts。

## 状态机（写死，越迁 400）

```text
submitted → in_review → accepted → applied → verified
    ↑          ├→ changes_requested ─┘（退回后可由提交方重提，重提=新提案或重新 submit）
    │          └→ rejected（终态）
    └→ rejected（终态）
applied → rolled_back（冲正，记 review_note）
任何状态（非终态）→ expired（仅系统/人显式触发或过期校验时）
```

- **agent 通道**（`POST /api/pw/proposals`）只能创建为 `submitted`。
- **人通道**（UI）：`POST /api/pw/proposals/:id/review`，body `{action: "accept"|"reject"|"request_changes", note?}`，
  迁移：submitted/in_review → accepted / rejected / changes_requested。accept 时若
  `expires_at` 已过 → 409。in_review 不需要单独入口：review 动作天然表示人在看，
  submitted 可直接 accept。
- **可信服务**：`POST /api/pw/proposals/:id/apply`——仅当 status=accepted；若 base_version
  非空，校验目标当前版本仍等于 base_version，不等 → 409（stale base，需人重新 accept）。
  v1 的 apply 只做状态记账（applied_at/applied_by）+ 事件落账，不替任何业务表写数据——
  业务效果仍走现有流程（代码在 git、内容在现有草案流）。
- 每次状态迁移 `recordPwEvent` 落 pw_runs（audit）。
- 红线落实：review/apply 两个端点在代码注释里写明「只供人触发；agent 调用即违反
  GUARDRAILS.md」。本地单用户不加鉴权，靠纪律 + 事件审计。

## 路由

- `POST /api/pw/proposals`（创建：title/lane/target_kind 必填；proposed_by 必填）
- `GET /api/pw/proposals?lane=&status=&limit=&offset=`（created_at 倒序，limit 默认 50 上限 200）
- `GET /api/pw/proposals/:id`
- `POST /api/pw/proposals/:id/review`
- `POST /api/pw/proposals/:id/apply`

## mode-bar 增量

`GET /api/pw/mode-bar` 的 `pendingReview` 增加 `proposals`（status 为 submitted/in_review/
changes_requested 的计数）并计入 `total`。同步更新 pw-mode-bar 测试。

## 验收（自行跑完再回报）

- 新文件建议 `src/pw-proposals.ts` + `pw-proposals.test.ts`：建表幂等；状态机合法/非法迁移；
  agent 只能 submitted；过期 accept 409；base_version stale apply 409；review_note 留存；
  事件落账；mode-bar 新计数。
- `npm test` 全绿无回归；`npm run selfcheck` ok。
- curl 走一遍完整生命周期（submit → accept → apply）贴真实返回。
- 回报：改动文件、测试结果、curl 输出。前端与浏览器验收不归你。
