# TASK-PW-19 内容押注卡与挑/改/否（codex 执行规格）

- 状态：待执行（批次计划 TASK-PW-17-batch；PW-18 筛子已验收，现有 pending 候选卡可冒烟）
- 主需求域：内容生产
- 业务接口：登记内容执行（产出：内容押注卡确认后交执行侧跟踪）；提供选题候选（消费：候选卡状态流转规则归本域）
- 数据真值源：pw_bets（加 kind/source_card_id 两列，迁移）；pw_sieve_cards 状态流转（pending→picked/edited/rejected，单向不可逆）；pw_runs 留痕（复用 kind='manual_event'、event_type='confirm'/'reject'，**无 CHECK 迁移**，动作细节进 payload）
- 质量约束与验收终态：转卡（押注卡创建）只能人触发——AI 工具表永不含 pick/reject 类工具（测试断言）；PW-01 既有行为不破（kind 默认 'verdict'，既有测试与 draft 管线全绿）；`PATH="$HOME/.local/node/bin:$PATH" npm run verify` 全绿

## 执行环境约定（先读再写）

- 仓库根 `/Users/qinshu/Documents/papertableV1`。可改 `src/`、`package.json`（追加一行测试登记）；**不改 main.ts**（路由挂载留集成阶段）、不改 `frontend/`、`public/`；不 commit。
- 关键参照（动手前通读）：
  - `src/pw-bets.ts`：PwBetRow 字段与 ensure/迁移风格（本任务在其上 ALTER TABLE）
  - `src/pw-sieve.ts`：`listPwSieveCards` / pw_sieve_cards 状态机（pending/picked/edited/rejected）
  - `src/pw-drafts.ts`：createPwBetDraft（既有 draft 管线，kind 默认语义不能破）
  - `src/pw-runs.ts`：recordPwEvent 与 kind='manual_event'（PW-15 人工动作留痕先例）
  - `src/pw-collab-tools.ts` 尾部 `pwCollabDeniedToolNames`：deny 纪律断言风格
  - 效果规格 `docs/SPEC-collab-harness-effect.md` §5.1：内容押注卡三行（演示困惑/转化信号/看结果日）

## 一、pw_bets 扩展（迁移）

- `ALTER TABLE pw_bets ADD COLUMN kind TEXT NOT NULL DEFAULT 'verdict'`（'verdict'|'content'）、`ADD COLUMN source_card_id TEXT`（可空，弱引用 pw_sieve_cards.id，不加外键）。ensure/迁移照既有风格；旧行全部 kind='verdict'。

## 二、新模块 src/pw-content-bets.ts（挑/改/否函数）

1. `pickPwSieveCard(db, cardId, overrides?)`：
   - 卡必须 status='pending'，否则 httpError 409。
   - 创建 pw_bets(kind='content')，字段映射（生产版三行）：
     - title：overrides.title 或 quote_text 截断（≤30 字）
     - thesis（演示困惑）：quote_text 原文 + 来源（bvid/uname/like，从 quote_source_json）
     - metric（转化信号）：overrides.conversionSignal 或 '私域加群/问工具人数'
     - metric_target：overrides 或 '10'
     - checkout_date（看结果日）：overrides.reviewDate 或 +7 天
     - data_source_plan：'私域群/评论区人工统计'
     - source_card_id=cardId；status 沿用 pw_bets 默认（pending 等价物，照 PW-01 语义）
   - 卡状态：无 overrides→'picked'；有 overrides→'edited'。
   - pw_runs：kind='manual_event', event_type='confirm', actor='human', payload {cardId, betId, overrides}。
2. `rejectPwSieveCard(db, cardId, reason?)`：卡必须 pending（否则 409）→'rejected' + pw_runs（event_type='reject', payload {cardId, reason}）。
3. `listContentBets(db)`：kind='content' 押注列表（含 source_card_id 联查候选卡 quote）。
4. 状态机纪律：picked/edited/rejected 只允许从 pending 流转，不可逆（函数级断言）。

## 三、AI 无通路断言

- collab 工具表（pwCollabTools）与任何 AI 可调 schema 中**不得出现** pick/reject/转卡类工具——测试断言（照 PW-15 denied 名单风格，把 'pick_sieve_card','reject_sieve_card','create_content_bet' 列入断言名单）。

## 四、测试（src/pw-content-bets.test.ts，package.json 追加登记）

1. 迁移：旧库（无 kind 列）升级后旧行 kind='verdict'，新列存在。
2. pick 无 overrides：卡→picked；pw_bets 新行 kind='content'、thesis 含引文原文与 bvid、metric/checkout_date 默认值正确；manual_event 留痕 payload 含 cardId/betId。
3. pick 有 overrides：卡→edited；覆盖字段生效。
4. reject：pending→rejected + 留痕；非 pending 卡 pick/reject→409。
5. draft 管线回归：createPwBetDraft 产物 kind='verdict'。
6. AI 无通路：工具 schema 无 §三 名单。
7. 回归：既有测试全绿（当前 84）+ `npm run verify`。

## 五、验收

1. `npm run verify` 全绿（含新测试）。
2. 冒烟（node 脚本调函数，无需路由）：对现有 pending 候选卡 pick 一张 → listContentBets 出现该行、卡状态 picked、pw_runs 事件齐；再 reject 一张 → rejected。
3. 报告：文件清单、测试数、冒烟输出、与规格的偏差。
