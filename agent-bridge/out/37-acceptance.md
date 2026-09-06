# 简报37 验收成绩单：dsh-paperweight 镇纸六屏插件

日期：2026-08-17 ｜ 执行主体：codex（接手 Claude 前端收尾与验收）｜ 结论：**8 / 8 通过**

现在能用了：dsh 左栏「镇纸」六区能读 4317 真数据，@押注卡会把装配上下文送进会话，AI 的镇纸工具能真实查数；草稿区能列出独立草稿，人亲手点击时会补齐三行赌注并确认转正；手机抽屉和插件市场也都可用。

目前没有产品阻塞。尚存两项环境/清理债：profile 的 pnpm store 仍指向已不存在的 `/Volumes/系统C盘/...`，所以插件维持手动 symlink 安装；验收产生的一次失败会话和此前跑飞会话建议由主控决定是否删除。公网真手机登录后的手势复核仍留给用户，自动验收已确认域名能到 Cloudflare Access 登录门。

## 成绩单

| # | 验收项 | 成绩 | 证据 |
|---|---|---|---|
| 1 | @真实押注卡问答 | **通过** | 选中「简报37验收测试注(可作废)」后生成引用 chip；session log 的 `user/message` 含完整 `<paperweight-bet id="09f87dd8-…">` 装配上下文。真实回答调用 `pw_ops_status`、`pw_read_bet`、`pw_read_data_docs`，答出距结账 6 天、`docs: []`、不具备裁决条件。截图：`/tmp/pw37-52-answer.png`；日志：`~/.dsh-source/sessions/--Users-qinshu-.dsh-source-marketplace-install--/session-6286a2bf-7d30-440f-b3d2-04701bf5ee96/session.jsonl.zstd`。 |
| 2 | 工具数组无裁决/确认写 schema | **通过** | 同一会话 `request/header` 的镇纸工具正好是 `pw_draft_bet,pw_list_bets,pw_ops_status,pw_query_voice,pw_read_bet,pw_read_data_docs,pw_read_verdict_evidence,pw_recall_notes,pw_search_verdicts`；黑名单结果 `forbidden=[]`。三个实际调用均 `isError=false`。 |
| 3 | 六屏可见、数字与 4317 一致 | **通过** | 交接已验截图 `/tmp/pw37-10-bets.png`～`/tmp/pw37-14-ops.png`、`/tmp/pw37-20-bet-detail.png`；当时面板与 4317 对账：bets=14、pending=6、verdicts=3、dataDocs=1。此次新增草稿区截图 `/tmp/pw37-62-drafts-visible.png`。 |
| 4 | 推送区独立、有未读、不造会话 | **通过** | `/tmp/pw37-02-panel-push.png` 显示 daily/due 推送与未读徽标；`/tmp/pw37-03-back-to-sessions.png` 证明会话列表未混入推送会话。 |
| 5 | 人按钮写链路 + AI 只落草稿 | **通过** | 既有链路：AI 起草 `09f87dd8-…` 返回 draftHash `d7d1b20d84eea236…`，正式区不可见，后由 human-click 确认转正，pw_runs 与 actions.jsonl 同秒勾稽。新增 UI 链路：草稿 `d91e1508-5774-47c8-a0b6-c5950cd6b012` 缺三行赌注，界面依次补「验证指标/数据来源/结账日」后确认；4317 单卡返回 `status=pending`、结账日 `2026-08-24`，actions.jsonl 记录 `2026-08-17T01:22:48.035Z confirm/human-click`。截图：`/tmp/pw37-60-drafts-list.png`、`/tmp/pw37-61-draft-confirmed.png`。 |
| 6 | 纸感浅色、无“推荐” | **通过** | 六屏、草稿和手机截图均为 pw 米纸色 token；client 可见文案检索无“推荐”（仅源码纪律注释出现该词）。 |
| 7 | 手机形态可用 | **通过** | 390×844：`/tmp/pw37-70-mobile-home.png` → `/tmp/pw37-71-mobile-drawer.png` → `/tmp/pw37-72-mobile-pw-panel.png`，抽屉内镇纸导航、推送卡和底部入口可操作。公网 `curl -L https://dsh.cozai.net` 返回 HTTP 200，最终落到 Cloudflare Access 登录页。 |
| 8 | 插件市场可见、状态正常 | **通过** | 设置 → 插件 → 已安装页显示 `@papertable/dsh-paperweight v0.1.0 · 最新 v0.1.0`，截图 `/tmp/pw37-81-plugin-installed.png`。 |

## 关键命令证据

### 工具数组与真实调用

```text
pw_tools=pw_draft_bet,pw_list_bets,pw_ops_status,pw_query_voice,pw_read_bet,pw_read_data_docs,pw_read_verdict_evidence,pw_recall_notes,pw_search_verdicts
forbidden=[]
pw_ops_status: isError=false
pw_read_bet: isError=false
pw_read_data_docs: isError=false
```

提取来源：先把 session zstd 的拼接帧逐帧解压到 `/tmp/pw37-session-pass.jsonl`，再从 `request/header` 与 `tool/result` 解析工具名和结果。

### 构建与 host 冒烟

```text
> npm run build
> tsc -p tsconfig.json && tsdown
✔ Build complete

✔ host 冒烟：/pw/api/* 路由 + 工具面 + 命令 + systemPrompt + 推送
tests 1 · pass 1 · fail 0 · duration_ms 155.129834
```

### 草稿确认双证据

```text
GET 4317 /api/pw/bets/d91e1508-5774-47c8-a0b6-c5950cd6b012
status=pending
metric=简报37 UI 确认链路通过
data_source_plan=dsh 人点确认验收截图与 action/pw_runs 双账
checkout_date=2026-08-24

actions.jsonl
{"at":"2026-08-17T01:22:48.035Z","action":"confirm","targetType":"draft","targetId":"d91e1508-5774-47c8-a0b6-c5950cd6b012","source":"human-click","upstream":"/api/pw/drafts/d91e1508-5774-47c8-a0b6-c5950cd6b012/confirm","ok":true}
```

## 本次修复与留痕

1. T1 @菜单“正在加载”在当前生产构建未复现；真实候选、chip、serialize 装配上下文均通过。原实现签名与 dsh 当前 `CandidateRequest` 契约一致。
2. 新增 `GET /pw/api/drafts` 契约与 host 路由；client 押注台改为独立读取草稿。
3. 草稿卡提供「确认转正(人)」；三行赌注不齐时用 prompt 补齐并通过 `edits` 送 `POST /pw/api/action`。
4. 兜底修复 host 工具输出：9 个工具从错误的 string schema 改为开放 object schema；`normalizeBet` 不再显式输出 `undefined`。详情见 `out/37-contract-changes.md` #3。
5. 既有兜底修复仍保留：host `src/index.ts` inject 补 `commands/systemPrompt`。

## 例外与建议清理

- 测试样本「简报37验收测试注(可作废)」`09f87dd8-a758-4150-a880-656afae0961e` 继续留库，结账日 2026-08-23，到期可作废。
- 此次首次验收因 host 输出 schema 错误产生会话「核对结账天数与回流数据」，已停止；只读但一度翻本机文件，建议删除。
- 交接前跑飞会话「查看并处理简报37」已被用户停止，只做过只读操作，也建议删除。
- UI 验收把旧草稿「PW-27 指认冒烟临时卡」转为 pending（id `d91e1508-…`，结账 2026-08-24），这是验收写入，保留供审计或到期作废。
- pnpm store 死卷仍是环境债；本单未改全局 pnpm 配置，插件继续使用 symlink + profile bundles 登记。
