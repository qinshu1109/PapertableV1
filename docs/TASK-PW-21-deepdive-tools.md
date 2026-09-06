# TASK-PW-21 对话深挖工具扩容（codex 执行规格）

- 状态：待执行（批次计划 TASK-PW-17-batch；PW-17 读通路、PW-18 筛子均已验收；与 PW-19 无依赖，可并行）
- 主需求域：判断沉淀与复用
- 业务接口：提供有效判断（装配 v3：候选卡与语料清单注入）；提供选题候选（消费：对话 run 只读引用候选卡）
- 数据真值源：无新表、无写入；只读工具全部消费 PW-17 读函数与 PW-18 sieve 读函数
- 质量约束与验收终态：权限表静态化纪律延续——新工具全 allow 只读，deny 工具不进 schema（测试断言延续 PW-15）；工具循环上限沿用 4 轮；PW-15 既有测试全绿；`PATH="$HOME/.local/node/bin:$PATH" npm run verify` 全绿

## 执行环境约定（先读再写）

- 仓库根 `/Users/qinshu/Documents/papertableV1`。可改 `src/`、`package.json`（追加一行测试登记）；不改 `frontend/`、`public/`；**不改 main.ts**（新工具经既有 collab 路由生效，无需新路由）；不 commit。
- 关键参照（动手前通读）：
  - `src/pw-collab-tools.ts`：CollabTool 结构、policy 写法、TypeBox schema 范式、deny 名单断言
  - `src/pw-context.ts`：buildCollabContext（§N 编号、token 预算截断）
  - `src/pw-collab.ts`：system prompt 常量、runCollabTurn
  - PW-17 读函数：`getPwCorpusDoc`/`readPwCorpusComments`/`listPwCorpus`/`listPwDataDocVersions`/`getPwVerdictDetail`/`getPwConnectionStatus`
  - PW-18 读函数：`listPwSieveCards`、`sieveStatus`（src/pw-sieve.ts）

## 一、新只读工具（全 allow，中文描述带「只读」语义）

| 工具名 | 参数 | 执行 |
|---|---|---|
| list_corpus | {} | listPwCorpus：已抓 BV 清单（bvid/title/up/status/comment_count/fetched_at） |
| read_corpus_doc | {bvid} | getPwCorpusDoc：整 doc + video_stat 七项 |
| read_corpus_comments | {bvid, offset?, limit?} | readPwCorpusComments：评论全文分页（含 rpid/ctime/replies） |
| read_doc_versions | {} | listPwDataDocVersions(context.betId)：版本链全历史 |
| read_verdict_evidence | {id} | getPwVerdictDetail：判决 + 证据链 + 来源押注 |
| read_connections | {} | getPwConnectionStatus：连接状态/last_sync_at/risk_events |
| list_sieve_cards | {status?} | listPwSieveCards：候选卡列表（kind/quote/四字段/sort_score/status） |
| read_sieve_card | {id} | 单卡详情（quote_source_json 全量） |

## 二、装配 v3（pw-context.ts 扩展）

- buildCollabContext 注入新增两块（token 预算内、截断照既有风格）：
  1. **待选候选卡**：status='pending' 按 sort_score 降序 top 5（wildcard 单列标注「少数派」）；
  2. **语料库清单**：已抓 BV ≤10 条（bvid/title/comment_count/status）。
- §N 编号规则不变、全轮稳定。
- system prompt 常量补两条纪律：①引用评论/语料**必须逐字引用原文**（原文原则，禁止改写概括）；②候选卡是草稿——**挑/改/否只能人做，你没有这个工具**（防止它假装能转卡）。

## 三、纪律断言（延续）

- tools 数组仍无任何写正式表工具（PW-15 denied 断言原样保留 + 本任务新增工具全 allow 只读）；pick/reject 类工具不存在（与 PW-19 §三 同名单，两处断言各自独立写）。

## 四、测试（src/pw-deepdive-tools.test.ts，package.json 追加登记）

1. 八个新工具逐个执行断言（内存库造数据：done 语料+落盘文件、版本链、verdict、connections、pending 卡）。
2. schema 断言：无写工具、无 pick/reject 名单。
3. 装配 v3：注入 markdown 含「待选候选卡」块（wildcard 标注）与「语料库清单」块；§N 稳定。
4. 回归：PW-15 既有测试全绿 + `npm run verify`。

## 五、验收

1. `npm run verify` 全绿（含新测试）。
2. 真实模型对话冒烟（主代理做，经既有 POST /api/pw/collab/:betId/messages）：问「我们已抓了哪些视频？」→ 走 list_corpus 回答正确；问「待选候选卡第一条的引文出处」→ 走 list_sieve_cards/read_sieve_card 且**逐字**给出引文。
3. 报告：文件清单、测试数、冒烟对话摘录、与规格的偏差。
