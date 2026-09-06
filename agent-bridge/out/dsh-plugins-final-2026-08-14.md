# 简报 19 最终报告:dsh 插件全量战役(2026-08-14)

- 执行方:Cursor Agent(w1:pC,dsh 仓工作区)
- 结论:**五个工作流全部完成并验收通过**,含 keyless 全量验收与真模型抽样复验(用户中途提供凭证后升级)。
- 产出根:`papertableV1/dsh-plugins/`(5 个插件目录)、`papertableV1/skills/`(4 个新 skill)、`agent-bridge/PROTOCOL.md`。
- 两个代码仓零触碰:dsh 主仓 `git status` 干净(HEAD 即 pin 的 `47f9438`);papertableV1 现有代码未动,产出全部是授权路径下的新文件。

## 一、交付物总表

| WS | 交付物 | 测试 | keyless 验收 | 真模型复验 |
|---|---|---|---|---|
| WS1 | `dsh-plugins/dsh-guardrails/` 受保护路径人审闸 | 单测 10/10 | 四项全过+人审放行加测 | **通过**(受保护写→ask→fail-closed) |
| WS2 | `dsh-plugins/memos-mcp-overlay/`(L1)+ `dsh-plugins/dsh-memory-discipline/`(L2) | 单测 9/9 | L1 双分支 17 工具桥接;L2 注入时序/降级/安装态 | **通过**(L1+L2 联动真 MemOS,模型引用注入原文) |
| WS3 | `dsh-plugins/dsh-proposal-gate/` 提案人审通道 | 单测 14/14 | 全生命周期/stale 409/召回重提交/非法迁移/通道隔离 | **通过**(真模型提交→accept→apply) |
| WS4 | `dsh-plugins/dsh-scheduled-prompt/` 定时 prompt 骨架 | 单测 14/14 | 到点触发+去重/busy inject/预算 blocked | **通过**(4 tick 全 ok,调度会话真模型回复) |
| WS5 | `skills/{agent-bridge-protocol,batch-llm-sieve,memory-usage-discipline,evidence-recall-ledger}/SKILL.md` + `agent-bridge/PROTOCOL.md` | — 纯文档 | 主代理逐篇复核 | —(不涉模型) |

每个插件目录自带:README(中文,含兼容 pin、安装、配置、边界、验收实录)、`package.json`(`dsh.bundle.patch` + `dshCompatibility`)、`cordis.patch.yml` 默认层、`tests/` 单测。全部 pin 在 harness commit `47f943859bef60e4160492346772ded9b24f765a`(2026-08-13 master,0.1.0-rc.5,pre-release 无兼容承诺,升级需重跑验收)。

## 二、真模型复验实录(2026-08-14 04:15–04:35)

用户中途提供 OpenAI 兼容网关凭证(模型 `deepseek-v4-flash`)。凭证仅存环境变量与用户级 600 权限私密文件(`~/.dsh-zen.env`,双仓之外);报告与仓库文件零出现(收官时 rg 全仓扫描零命中)。按主控口径:WS1/WS3 抽关键路径、WS2/WS4 验收补真模型,不全量重跑。

1. **WS1 guardrails**:真模型真调 `write` 工具写 `/tmp` 沙盒工作区的 `.github/workflows/zen-ci.yml` → 会话日志 `approval/asked`(reason 含 guardrails 文案与命中 glob `.github/workflows/**`)→ headless 无 answerer,`approval/decided outcome:"unavailable"` → 工具报错、文件未落盘;模型如实转述错误并停手。fail-closed 与审计链在真模型下成立。
2. **WS3 proposal-gate**:真模型真调 `submit_proposal` → 人命令 accept → apply(record-only,target 版本 0→1)→ verify 全绿。加分观察:模型首次调用漏了必填 `evidence.against`,被工具 JSON 校验拒绝后自行补参重试成功——schema 错误对真模型可恢复。诚实备注:模型把 target_key 写成 `demo`(提示里是 `doc:demo`),demo 驱动器的 stale 支线因此打在另一 target 上未复现 stale 拒绝;该支线已由 keyless 验收覆盖,且本次支线中每步拒绝文案(applied 不可退回 changes、terminal 不可重提交)均为正确行为。
3. **WS2 MemOS 两件套**:L1+L2 联动一发——真模型 + 本机活 MemOS(streamable-http MCP)。铁证:`request/header` 含 17 个 `mcp__memos__*` 工具与 Memory discipline 系统提示节;`agent/inbox/spliced` seq3(注入,next-step)先于 seq4(提示词,next-turn);notice(seq9,活热上下文 v545)先于用户提示(seq10)进首 step;模型回答逐字引用注入片段(v545 比子代理验收时的 v544 又长一版,恰证活数据)。
4. **WS4 scheduled-prompt**:job `{everySeconds:5, target:new-session}`,真模型主 turn(bash sleep 12 保活)期间 4 个 tick(启动补桶+三个对齐桶)全 `status:"ok", steps:1`;抽查调度会话:prompt 来源 `{kind:"plugin",plugin:"scheduled-prompt"}`,`request/header` 模型 `deepseek-v4-flash`,回复按 job prompt 输出 `scheduled ok`。

## 三、五个交付物一句话定位

1. **dsh-guardrails**:配置 glob 声明受保护路径/命令;任何写能力工具触碰前必须人审,headless 无人可问即拒(fail-closed);审计成对入会话日志。镇纸 GUARDRAILS.md 的"四类守门文件"由此从纪律文本变成机器强制。
2. **memos-mcp-overlay(L1)**:一行 cordis overlay 把任意 MCP 记忆服务(默认参数化 MemOS,HTTP/stdio 双分支)桥进 harness,17 个工具以 `mcp__memos__*` 进模型工具清单。
3. **dsh-memory-discipline(L2)**:记忆使用纪律进系统提示 + 会话开始自动拉热上下文注入(占 maintenance 相保证确定性先于首个提示词);工具名全 config 化,不绑 MemOS。
4. **dsh-proposal-gate**:模型只有提交/撤回/列表三个工具,review/apply/verify 只存在于 `/proposal` 人命令——身份分权靠通道隔离而非提示词;版本一致性 stale 拒绝(镇纸 409 语义);append-only 审计账本。
5. **dsh-scheduled-prompt**:config 声明 cron/固定周期 job,到点投 prompt(常驻 agent followup/inject 或一次性会话);tick 桶级幂等去重、每 run 步数预算(pre-step reject,turn 以 blocked 干净收口)、JSONL run 记账。镇纸"定时抓语料生成概念卡"的通用化骨架。

## 四、关键设计决策(细节见各 README)

- **审批走 `approval/request` waterfall 而非 `tools.guard()`**(WS1):guard 是硬拒,approval 保留"人可翻案"通道;headless 下自动 fail-closed。
- **apply 默认 record-only + `proposal-gate/apply` waterfall 扩展点**(WS3):payload 动作是部署专属语义,硬编码执行器会破坏零业务耦合;人命令通道本身即 apply 授权(dsh 的 `ctx.approval` ask 只在开启 turn 内可用,为模型动作设计)。
- **审计走插件自有 JSONL 账本而非自定义 session 事件**(WS1 例外——它只发既有 `approval/*` 事件):自定义 SessionEventMap 成员默认 required-on-read,会让不认识该事件的构建拒读整本日志。
- **注入占 maintenance 相**(WS2):`inject()` 不唤醒 driver,异步 fetch 期间首 step 已开跑会整场错过;占相让首个 step 确定性同时认领 notice 与提示词。
- **`source.kind:'cron'` 不存在于 pin 版本**(WS4):cookbook 该处是愿景,实际 `MessageSourceMap` 为 `user|plugin|model|tool`,统一用 `{kind:'plugin', plugin:<名>}`。
- **词汇表/工具名/globs/jobs 全部 config 化**:五个交付物零 Papertable 业务耦合,任何 harness 用户可用。

## 五、环境事实(复现验收所需)

- 源码启动:dsh 仓根 `node --expose-internals --import tsx/esm apps/cli/src/bin.ts --profile headless`;`--expose-internals` 用于 profile 裸包名解析(loader 可选原生助手未装时),产品安装态不需要。
- Cursor 自带 node(Anysphere 签名+hardened runtime)加载三方原生模块(koffi/sharp)会 dlopen 失败;统一用用户自装官方 node(`/Users/qinshu/.local/node/bin`)。
- keyless 验收用 `packages/test-support/llm-mock-server`;注意其行为脚本是跨请求 FIFO,重跑前必须重启 mock。
- 验收沙盒:独立 `DSH_HOME=/tmp/dsh-*-home`,`dsh plugin --profile headless add <插件目录>` 安装,会话日志按多 zstd frame 逐帧解压审计。
- 真模型:`DEEPSEEK_BASE_URL`/`DEEPSEEK_API_KEY` 环境变量即可(adapter 拼 `{base}/chat/completions`,本网关需带 `/v1` 后缀的 base);默认模型选择就是 `deepseek-v4-flash`,零改动。

## 六、守门红线与双仓状态(收官自检)

- dsh 主仓:`git status --porcelain` 空,HEAD `47f9438`(即 pin commit),全程只读达成。
- papertableV1:M/D 条目(frontend/、public/assets/、package*.json 等)全部为主控 kimi 的并行前端工作与开工前既有改动,不属本战役;本战役产出仅为授权路径新文件:`dsh-plugins/`(5 目录)、`skills/` 新增 4 目录、`agent-bridge/PROTOCOL.md` 与 `agent-bridge/out/dsh-plugins-{progress,final-2026-08-14}.md`。
- 无 commit、无 push;papertable 真库/Memos 笔记库未触碰;API key 全仓扫描零命中。
- 遗留临时物(可随时清理,不影响交付):`/tmp/dsh-*-home` 验收沙盒、`/tmp/ws*-*.{yml,jsonl}` 驱动文件、`~/.dsh-zen.env` 凭证文件(**用后由用户决定保留或删除**)。

## 七、后续建议(不阻塞验收)

1. 若 harness 升级 commit:各插件 README 的"兼容性"节即重验清单,先跑单测再跑各自验收实录命令。
2. dsh-proposal-gate 的 apply 执行器、dsh-scheduled-prompt 的 self 模式常驻验收,在镇纸真接入(web surface)时补一轮实景验收。
3. 四个 skill 可直接投给任何 agent 使用;`agent-bridge/PROTOCOL.md` 已把文件桥协议成文,新窗口冷启动可引用。
