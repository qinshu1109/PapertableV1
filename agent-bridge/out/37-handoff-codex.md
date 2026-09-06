# 简报37 交接单:dsh-paperweight 前端收尾 + 端到端验收(交 codex 执行)

日期:2026-08-16 ｜ 交接方:Claude(w4:pB,client 半+兜底验收)｜ 接手方:codex ｜ 主控:kimi(herdr w4:p1)

## 这份交接单是干什么的

镇纸六屏 dsh 插件(`dsh-paperweight`)的 client 半**已写完、已构建、已装进生产 web、六屏界面已验证可用**。剩下的活:①修一个 @引用菜单卡「正在加载」的 bug;②补两条 UI 数据通路(草稿区);③跑完剩余端到端验收(会话问答/工具数组/手机/插件市场);④出验收成绩单并回报主控。本文自包含,按顺序执行即可,不需要之前会话的上下文。

**先读**(不读会踩坑):`agent-bridge/briefs/37-pw-dsh-plugin-build.md`(铁律9条+验收8条,一切以它为准)、`agent-bridge/out/37-contract-changes.md`(契约实际响应形状)、`agent-bridge/out/35a-dsh-plugin-tech-map.md` §3/§6(扩展点与三坑)。

## 现状:已完成并验证的(不要重做)

| 事项 | 状态 | 证据 |
|---|---|---|
| client 半源码 | 完成 | `papertableV1/dsh-plugins/dsh-paperweight/src/client/`(9 文件:index/api/state/hooks/styles/sections/PwPanel/DetailOverlay/refSource) |
| 构建链 | 完成 | `npm run build` = tsc(host,exclude src/client)+ tsdown(client bundle 60KB,`__ModuleLoader__.load` 包裹,react external)。产物 `lib/client.js` |
| 安装进 web profile | 完成(手动形态,见坑1) | `~/.dsh-source/profiles/web/node_modules/@papertable/dsh-paperweight` 是 **symlink** → 插件目录;profile `package.json` 的 dependencies + `dsh.profile.bundles` 已登记 |
| web 正常运行 | ✅ | `http://127.0.0.1:3080` 200;boot graph 含插件(curl 首页 grep paperweight) |
| 左栏「镇纸」入口+未读徽标 | ✅ | 截图 `/tmp/pw37-01-home.png` |
| 双 tab(会话⇄镇纸,shadowing dispose 恢复官方) | ✅ | `/tmp/pw37-02-panel-push.png`、`/tmp/pw37-03-back-to-sessions.png` |
| 六区渲染真实数据 | ✅ | `/tmp/pw37-10-bets.png` ~ `14-ops.png`、`20/21-bet-detail.png` |
| 验收3 数字对账 | ✅ | dsh 面板 counts(bets14/pending6/verdicts3/dataDocs1)= 4317 API 实查一致 |
| 验收4 推送区 | ✅ | 6 条未读带徽标(due×5+daily×1);对话列表无推送会话 |
| 验收6 纸感浅色/无"推荐" | ✅ | 全部截图可复核;样式 token 在 `src/client/styles.ts` |
| 验收5 数据链路 | ✅(UI 入口缺,见任务T3) | AI 起草:POST `/pw/api/draft/bet` → draftHash `d7d1b20d84eea236`、id `09f87dd8-a758-4150-a880-656afae0961e` 落 4317 drafts;4317 用「三行赌注必填」挡掉不完整草稿(纪律实证);带 `edits` 补 `data_source_plan` 后 confirm 成功转正 pending。两本账:pw_runs `confirm/human 12:35:49` + `~/.dsh-source/papertable/dsh-paperweight/actions.jsonl` 同秒同 id |
| host 半 boot bug 修复 | ✅(兜底修复已留痕) | `src/index.ts` inject 补了 `commands`/`systemPrompt`(此 cordis fork 无 optional 注入,未列服务的属性访问直接 throw,曾致 web crashloop) |

## 环境事实与坑(必读)

1. **pnpm store 指向已不存在的卷** `/Volumes/系统C盘/...`(全局 config),profile 里任何 `pnpm add/install` 都会炸或要求全量重装。**所以本插件是手动 symlink 安装**(见上表)。不要试图跑 `dsh plugin add` 或 `pnpm install` 修这个——超出本单范围,已报主控。
2. **重启 web**:`launchctl kickstart -k gui/$(id -u)/com.deepseek-harness.web`,之后 **等 10~15 秒** 才起来(crashloop 时看 `~/Library/Logs/dsh-web.err.log`)。web 由 `~/.dsh-source/run-web.sh` 拉起(`DSH_HOME=/Users/qinshu/.dsh-source`)。
3. **构建命令**(改 client 后):`cd /Users/qinshu/Documents/papertableV1/dsh-plugins/dsh-paperweight && PATH="$HOME/.local/node/bin:$PATH" npm run build:client` 然后重启 web(symlink 安装,rebuild 即生效,无需重装)。PATH 前缀必须带(默认 node 是 cua_node,有签名坑)。
4. **回滚安全网**:若改挂了 web——编辑 `~/.dsh-source/profiles/web/package.json`,从 `dsh.profile.bundles` 数组删掉 `"@papertable/dsh-paperweight"`,kickstart 重启,web 即恢复无插件状态。
5. **4317 的 bets 列表不含 draft**(draft 隔离在 API 层);草稿独立在 `GET /api/pw/drafts`(现有 5 条)。
6. 端到端浏览器测试用 **playwright-core + 系统 Chrome headless**,现成脚本在 `/tmp/pw37-pwright/`(shot.mjs/act.mjs/confirm.mjs/chat.mjs/stop.mjs),跑法:`cd /tmp/pw37-pwright && TMPDIR=/tmp PATH="$HOME/.local/node/bin:$PATH" node shot.mjs <step>`。**不要用 ego-browser**(空间控制权会死等)也不要用 kimi-webbridge(扩展未连)。
7. 契约纪律:`src/types.ts` 是前后端契约,**只许消费不许私改**;变更走 `out/37-contract-changes.md` 留痕。host 半(`src/host/`)是 dsh-cc(w4:p9,dsh TUI 窗格)的地盘——**通知它走简报37末尾「跨窗横向通知通道」一节的三步法**(herdr-cc-prompt → send-keys enter → pane read 回读确认),窗格号先 `herdr pane list` 按 label `dsh-tui` 核。仅当它长时间不响应且属 boot-blocking/验收阻断时,才援引"兜底验收"职责做最小修复并在 contract-changes 留痕(先例:inject 修复)。

## 待办任务(按序执行)

### T1(核心 bug):@引用候选菜单卡「正在加载…」

现象:输入框打 `@简报37`,菜单弹出(标题 `pw-bet`——源注册成功),但一直停在「正在加载…」,候选永不出现;此时按 Enter 会把 `@简报37` 当纯文本发送,agent 会误解为"去处理简报37"乱翻文件(已发生一次,会话「查看并处理简报37」已被用户手动停止)。现场截图:`/tmp/pw37-50-at-menu.png`。

排查线索(按可能性排序):
1. **candidates 签名/返回形状与 dsh 实际接口不符**。我方实现在 `src/client/refSource.ts`(candidates 返回 `[{name, description}]`,第二参假设 `{query}`)。**对照真源码**:`/Users/qinshu/Documents/ChatGPT/MemOS/deepseek-harness/packages/client/ui-input-trigger/src/types.ts:138-182`(InputTriggerSource 完整定义)与官方 @ 源参考 `packages/client/ui-subagent/src/client/index.ts`——逐字段核对 candidates 的参数、返回条目字段名、是否需要 signal/abort 处理、菜单"加载完成"靠什么信号。
2. fetch 相对路径 `/pw/api/bets` 在页面上下文是通的(curl 已验证路由本身 200),但若 candidates 抛错/挂起,菜单可能停在加载——浏览器 DevTools console(playwright `page.on('console')`)看 client 报错。
3. 修好后 rebuild(坑3)→ 重启 → 用 `/tmp/pw37-pwright/chat.mjs` 重测(脚本里 Enter 选候选的姿势可能也要按实际菜单交互调整:候选出现后 ArrowDown+Enter 或点击条目)。

验收口径:@ 菜单能列出在途押注(含「简报37验收测试注(可作废)」),选中后输入框出现引用 chip,提交后模型收到 `<paperweight-bet id="...">` 展开的装配上下文(serialize 在 refSource.ts 的 codec 里,拉 `/pw/api/bets/:id` 的 contextMarkdown)。

### T2(验收1+2):@押注卡 端到端会话问答 + 工具数组验证

T1 修好后:
1. 新会话,@选「简报37验收测试注(可作废)」(id `09f87dd8-…`,pending,结账日 2026-08-23),问:「这注离结账还有几天?回流数据够不够裁?请用工具核对后回答,不要编造。」等模型答完截图——合格线:AI 说出距结账天数(按当日算)、说明该注无回流数据文档、引用来自装配上下文/工具的真实数据,全程无手工投喂。
2. **验收2**:从会话日志找该轮 request 的 tools 数组,断言只含 `pw_list_bets/pw_read_bet/pw_read_data_docs/pw_search_verdicts/pw_read_verdict_evidence/pw_query_voice/pw_recall_notes/pw_ops_status/pw_draft_bet` 加 dsh 自带工具,**不含任何 settle/confirm/verdict 写 schema**(黑名单见 types.ts `PW_FORBIDDEN_TOOL_SUBSTRINGS`)。会话日志在 `~/.dsh-source/sessions/` 或 `~/.dsh-source/storages/`(实际结构自查,grep `"tools"` 或工具名)。把 grep 命令和输出片段贴进验收文档。

### T3(契约缺口):草稿区 UI 入口

现状:契约路由表没有读草稿的路由 → client 拿不到草稿列表 → 押注台「草稿区」永远空、详情页「确认转正」按钮无挂载对象(起草-确认闭环 UI 断链,数据链路已验通)。已在 `out/37-contract-changes.md` 留痕提议。

1. 先查 `out/37-progress-a.md` 和 contract-changes 是否已有 dsh-cc 回应(它可能已加 `GET /pw/api/drafts`——curl 测一下)。
2. 若无:按坑7 的通道通知 dsh-cc 加 `GET /pw/api/drafts`(裁剪 4317 `GET /api/pw/drafts` 为 PwBetView 形状 + draftHash 字段可选);不响应则援引兜底最小实现(照 `src/host/api.ts` 既有路由风格,留痕)。
3. host 路由就位后,client 侧改 `src/client/sections.tsx` 的 BetsSection:草稿分组数据源从 bets 过滤改为新路由(api.ts 加 `listDrafts()`,unwrap 容 `{drafts}` 与裸数组);draft 卡点开详情——注意 `readBet(draftId)` 会 404(draft 不在 bets/:id),草稿详情要么用列表数据就地渲染简版卡(推荐,少一条契约路由),要么再议契约。「确认转正(人)」按钮已在 DetailOverlay 写好(status==='draft' 分支),把它移到/复用于草稿简版卡即可。**确认按钮必须带 edits 兜底**:4317 会拒"三行赌注不齐"的草稿(metric/data_source_plan/checkout_date),UI 上把缺的字段做成可填输入(简单 prompt() 也行),否则确认必失败。
4. 重截验收5 的 UI 图:草稿列表可见 → 人点确认 → 转正,4317 pw_runs 记 `confirm/human`。

### T4(验收7):手机形态

脚本 `shot.mjs` 的 `mobile` 步曾超时:hero 页没有 `[data-mobile-nav="toggle"]`(dsh-mobile-nav 的 toggle 在会话 header,hero 页只有抽屉 footer 入口)。修脚本:390×844 视口打开 → 截 hero → 找开抽屉的实际入口(读 dsh-mobile-nav 源码 `~/.dsh-source/profiles/web/node_modules/@dsh-external/dsh-mobile-nav/lib/client.js`,或直接 js 给 `[data-mobile-nav="frame"]` 设打开属性)→ 抽屉内点 `.pwx-entry` → 镇纸面板全屏可用截图。域名侧:`https://dsh.cozai.net` 经 cloudflared(launchd `com.cloudflared.dsh-cozai` 在跑),headless 访问一次确认 200 与登录门正常即可(真手机测试留给用户)。

### T5(验收8):插件市场

`shot.mjs` 的 `market` 步未实调:打开设置(左栏底部「设置」)→ 插件市场页(dsh-plugin-marketplace 已装)→ 截图确认 `@papertable/dsh-paperweight` 在列、状态正常。selector 按实际 DOM 调。

### T6:验收文档 + 清尾 + 回报

1. 出 `agent-bridge/out/37-acceptance.md`:**成绩单格式,8 条逐项 过/不过 + 证据**(截图路径/命令输出/日志片段);开头两段大白话(什么能用了/什么还不行/有什么等拍板——项目文档两层规则);把本单「现状表」里已验的证据直接引用,不重跑。
2. 如实记录:①测试样本「简报37验收测试注(可作废)」(id `09f87dd8-…`)留库,结账日 2026-08-23 到期作废即可;②跑飞会话「查看并处理简报37」已被用户停止,只做了只读操作,建议删除(报主控定);③pnpm store 死卷环境债;④两处兜底修复(host inject、若 T3 做了 host 路由)。
3. 更新 `out/37-progress-b.md`(执行主体 codex,逐项勾)。
4. **完工回报**(纪律,禁止写完不找人):`herdr agent prompt w4:p1 "简报37 完工:前端+验收(codex 接手 Claude):一句话结论 + out/37-acceptance.md + 有无阻塞"`(agent_not_found 就先 `herdr pane list` 核 kimi 窗格)。

## 红线(违反即返工,全文见简报37)

- 数据只走 `http://127.0.0.1:4317`,禁止直连 SQLite;dsh 侧不建任何缓存/镜像。
- **永不给 AI 注册 settle/confirm/verdict 写 schema**;写路径只有 AI 起草落 draft + 人亲手点按钮。
- 卡面/文案永不出现「推荐」;排序依据印在卡上。
- Memos 只读;纸感浅色(pw token),禁深色数据板。
- 推送产物只进左栏「镇纸」区,禁止混进对话列表。
- 契约(types.ts)不私改;跨侧改动先通知、后兜底、必留痕。
