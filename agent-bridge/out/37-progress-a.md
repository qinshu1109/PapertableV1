# 简报37 进度 A（dsh-cc · 后端 host 半）

- 2026-08-16 开工。窗口 w4:p9。
- 计划：① 写 `dsh-plugins/dsh-paperweight/src/types.ts` 契约 → ② 在本文喊「契约已定」→ ③ 实现 host 半（4317 fetch、/pw/api/* 路由、8 只读工具 + pw_draft_bet、/pw/api/action、定时推送、package.json/cordis.patch.yml 骨架）→ ④ 独立冒烟自测 → ⑤ 按 9 条铁律 + 8 条验收逐条对照 → ⑥ 回报 w4:p1。

## 契约已定 ✅

- 时间：2026-08-16
- 契约文件：`papertableV1/dsh-plugins/dsh-paperweight/src/types.ts`
- Claude 可据此开工 `src/client/`，不用等 host 完成。
- 契约要点：
  - 统一前缀 `/pw/api/*`；client 只准调 `PW_ROUTE_TABLE` 里列出的路由。
  - host 只经 `http://127.0.0.1:4317` 取数，不直连 SQLite、不建缓存镜像表。
  - AI 工具面：8 只读 + `pw_draft_bet`（落 draft，返回 draft_hash）；黑名单 `settle/confirm/verdict 写`。
  - 人点按钮统一 `POST /pw/api/action`，host 记录 `source=human-click` 再转发 4317。
  - 推送区为插件本地收件箱（未读标记），不是业务数据副本。
  - 包骨架约定：host 已出 `main=lib/index.js`、`exports["./client"]` 预留；`dsh.client` 声明由 Claude 补 client 入口时再加。
- 契约变更须写 `out/37-contract-changes.md` 并回报；双方不得私改。

## 状态（host 半已完成 ✅）

- [x] 契约已定（`src/types.ts`）
- [x] host：4317 fetch 层（`src/host/pw-client.ts`）
- [x] host：/pw/api/* webServer 路由（`src/host/api.ts` + `voice.ts`）
- [x] host：8 只读工具 + pw_draft_bet（`src/host/tools.ts`）
- [x] host：/pw/api/action 人按钮转发 + 本地 action 日志（`src/host/action.ts`）
- [x] host：定时推送生成器（`src/host/push.ts`）
- [x] package.json / cordis.patch.yml / tsconfig / README 骨架
- [x] 独立冒烟自测：`node --test test/host.test.ts`（假 4317 随机端口 + 假 ctx，不占 3080）
- [x] 真实 4317 只读冒烟：bets 14 / verdicts 3 / voice themes 11 / notes 50 / ops counts 正常
- [x] 铁律 9 条 + 验收 8 条逐条对照（见下）
- [x] 回报 w4:p1（herdr agent prompt 已投递）

## 产出路径

- 契约：`papertableV1/dsh-plugins/dsh-paperweight/src/types.ts`
- host 源码：`papertableV1/dsh-plugins/dsh-paperweight/src/host/*.ts`
- 入口/骨架：`src/index.ts`、`package.json`、`cordis.patch.yml`、`tsconfig.json`
- 编译产物：`papertableV1/dsh-plugins/dsh-paperweight/lib/`
- 冒烟测试：`test/host.test.ts`

## 铁律 9 条逐条对照（后端自证）

1. **数据只走 4317 HTTP API** —— `pw-client.ts` 全部 `fetch(baseUrl + /api/...)`；无 SQLite 直连、无本地缓存镜像。✅
2. **写路径只有两类** —— `POST /pw/api/draft/bet` 只落 draft；`POST /pw/api/action` 只收人点按钮（source=human-click 落 actions.jsonl 再转发 4317）；工具面无 settle/confirm/verdict 写 schema。✅
3. **AI 摆证据不给结论** —— 工具只读返回数据/证据；店规 systemPrompt 明令不给结论、不出现“推荐”；排序字段原样带出。✅
4. **Memos 只读** —— notes/recall/tree 全经 4317 只读路由；host 无任何写 Memos 的代码。✅
5. **纸感浅色** —— 样式归 client；host 不输出深色板。✅（待 Claude 侧最终验收）
6. **推送产物进左栏独立区** —— push feed 是插件本地收件箱（未读标记），不建会话。✅
7. **永不做** —— 无 AI 裁决工具、无第二份数据副本/镜像表、无深色板、无看板/日历/甘特。✅
8. **角色/店规卡定义不做** —— 店规以 systemPrompt 段 `papertable:write-boundary` 携带，文本照 SPEC-harness-write-boundary 不放松。✅
9. **通知不绕微信** —— 推送走 dsh 面板 feed，不接微信。✅

## 验收 8 条（后端可自证部分；浏览器/手机/插件市场留 Claude+验收）

1. **@真实押注卡问答** —— host 已提供 `pw_read_bet`/`pw_read_data_docs`/`pw_search_verdicts`/`pw_read_verdict_evidence`/`pw_recall_notes` 与 `/pw/api/bets/:id` 装配；真实 4317 冒烟读出 14 注/3 判决/11 主题。端到端 @ 引用待 client 联调。⚠️ host 侧就绪，整体待验收。
2. **工具数组无写 schema** —— `test/host.test.ts` 断言 9 工具名黑名单通过；无 settle/confirm/verdict 写。✅（后端可自证）
3. **六屏内容可见可读、数字一致** —— `/pw/api/bets` `/verdicts` `/voice/themes` `/notes/today` `/ops/status` 全部从 4317 现拉；ops counts 对账 bets/verdicts/dataDocs。✅（后端可自证，UI 待 Claude）
4. **推送区有今日值得看且未读、对话列表无推送会话** —— PushStore 生成 daily/due/needs_human feed，mark-read 可用；不创建会话。✅（后端可自证）
5. **人点一次挑/否 + pw_draft_bet 落 draft** —— `action.ts` 转发 4317 pick/reject/confirm，`pw_draft_bet` 走 `/api/pw/drafts` 返回 draft_hash。冒烟覆盖。✅（端到端真库按钮待 Claude 联调）
6. **纸感浅色、无深色、无“推荐”** —— host 无样式/文案“推荐”；client 负责 token。⚠️ 待 Claude/验收。
7. **手机浏览器可用** —— 取决于 client + dsh-mobile-nav；host 同源 API 无设备限制。⚠️ 待联调。
8. **插件市场可见** —— 包骨架/`cordis.patch.yml` 就绪；安装到 profile 待联调。⚠️ 待联调。

## 环境事实

- 4317 当前在跑（`/api/status` 200），镇纸真库经 4317 只读访问。
- dsh 源码 checkout：`/Users/qinshu/Documents/ChatGPT/MemOS/deepseek-harness`。
- dsh web profile：`~/.dsh-source/profiles/web`；安装/重启须带 `DSH_HOME=/Users/qinshu/.dsh-source`。

## 阻塞/请示

无。
