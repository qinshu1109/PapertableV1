# 简报 19 进度:dsh 插件全量战役

- 执行方:Cursor Agent(w1:pC)
- 最后更新:2026-08-14 04:25(+08)

## 真模型复验(2026-08-14 04:25)

主控转达用户凭证后(key 仅存环境变量与用户级 600 权限私密文件,未进任何仓库文件),按"抽关键路径"口径复验:

- **WS1 真模型复验通过**:`deepseek-v4-flash` 真模型真调 `write` 工具写受保护路径(`.github/workflows/**`)→ 会话日志 `approval/asked`(带 guardrails 命中文案)→ headless 无 answerer `outcome:"unavailable"` → 工具报错、文件未落盘(fail-closed);模型如实转述错误并停止。
- **WS3 真模型复验通过**:真模型真调 `submit_proposal`(首次漏 `evidence.against` 被 JSON 校验拒,模型自纠重试成功——schema 错误可恢复)→ 人命令 accept → apply(record-only,版本 0→1)→ verify 全绿。备注:模型将 target_key 写为 `demo` 而非提示中的 `doc:demo`,驱动器 stale 支线因此打在另一 target 上未复现 stale 拒绝(该支线 keyless 验收已覆盖;本次支线中每步拒绝文案均为正确行为)。
- **WS2 真模型复验通过**(子代理 keyless 验收完工后,主代理用真模型加跑 L1+L2 联动一发):`deepseek-v4-flash` + 真 MemOS(HTTP MCP),`request/header` 含 17 个 `mcp__memos__*` 工具与 Memory discipline 提示节;注入(`agent/inbox/spliced` seq3 next-step)先于提示词(seq4 next-turn),notice(seq9,活热上下文 v545)先于用户提示(seq10)进首 step;模型回答逐字引用了注入的热上下文片段。
- **WS4 真模型复验通过**(子代理 keyless 验收完工后,主代理用真模型加跑定时触发一发):everySeconds:5 + new-session,真模型主 turn(bash sleep 12 保活)期间 4 个 tick(补桶+三对齐桶)全 `status:"ok"`,一次性调度会话 `request/header` 为 `deepseek-v4-flash`,prompt 来源 `{kind:"plugin",plugin:"scheduled-prompt"}`,模型按 job prompt 回复 `scheduled ok`。

## WS 状态总览

| WS | 内容 | 状态 | 备注 |
|---|---|---|---|
| WS1 | dsh-guardrails 插件 | **已完成** | 简报四项验收全过 + 加测"人审放行后执行"路径;证据见 `dsh-plugins/dsh-guardrails/README.md` 验收实录节 |
| WS2 | MemOS 两件套(L1 overlay + L2 discipline 插件) | **已完成** | 子代理完成实现+keyless 验收(L1 双分支 17 工具桥接、L2 注入时序/拔 fixture 降级/安装态,单测 9/9),主代理真模型复验通过(见"真模型复验"节);产出 `dsh-plugins/{memos-mcp-overlay,dsh-memory-discipline}/` |
| WS3 | dsh-proposal-gate 插件 | **已完成** | 主代理亲自做;验收摘要见下节,细节见 `dsh-plugins/dsh-proposal-gate/README.md` |
| WS4 | scheduled-prompt 插件 | **已完成** | 子代理完成实现+keyless 三路径验收(到点触发+去重/busy inject/预算 blocked,单测 14/14),主代理真模型复验通过(见"真模型复验"节);产出 `dsh-plugins/dsh-scheduled-prompt/` |
| WS5 | 4 个 skills + PROTOCOL.md | **已完成** | 产出:`skills/{agent-bridge-protocol,batch-llm-sieve,evidence-recall-ledger,memory-usage-discipline}/SKILL.md` + `agent-bridge/PROTOCOL.md`;主代理已逐篇复核(方法论准确、占位符参数化、出处署名齐全) |

## WS3 验收摘要(2026-08-14 04:15)

- 单测:`npm test` 14/14(状态机/词汇表/命令解析/存储与审计/过期清扫,纯逻辑无需 harness)。
- 行为验收(keyless,mock LLM 脚本化 `submit_proposal` + `--patch` 挂 demo-driver 走真 `ctx.commands.execute`),一次运行覆盖:
  - ①完整生命周期:模型工具提交 → `/proposal` list → in-review → accept → apply(record-only,target 版本 0→1)→ verify ok;
  - ②stale 拒绝(镇纸 409 语义):base_version=0 的旧提案 apply 被拒,账本记 `kind:"apply-stale"`,状态留 accepted 可人工召回;
  - ③召回+重提交:review changes → AI 重提交 rev2(base=1)→ accept → apply 成功(版本 1→2);
  - ④非法迁移全拒(changes_requested→verified、AI 越权 accepted→submitted);
  - ⑤fail-closed 通道隔离铁证:会话日志 `request/header` tools 数组仅 `submit/withdraw/list_proposals`,review/apply 工具不存在;22 条 `command/run|done` 入会话日志;
  - ⑥插件账本 `events.jsonl` 12 条迁移带 actor(ai/human)/via(tool/command)/note。
- 设计调整(已写进 README):apply 默认 record-only,真执行经 `proposal-gate/apply` waterfall 扩展点归执行器插件;审计走插件自有账本而非自定义 session 事件;状态机较镇纸原版新增 withdrawn 与 accepted 的两条人工召回边(验收实测暴露"accepted+stale 卡死"缺口后补上)。

## WS1 验收摘要(2026-08-14 04:15)

- 单测:`npm test` 10/10(纯逻辑,无需 harness)。
- 安装链路:沙盒 `DSH_HOME` 下 `dsh plugin --profile headless add <dir>` 成功,`--dump-config` 出现 `# == dsh-guardrails` 层。
- 行为(keyless,`llm-mock-server` 脚本化 `tool_call_success` 驱动真组合):
  - ①受保护写 → `approval/asked`(reason 含 guardrails 文案与命中 glob);
  - ②headless 无 answerer → `approval/decided outcome:"unavailable"`,`tool/result isError:true`,文件未落盘(fail-closed);
  - ③审计事件成对入 `session.jsonl.zstd`;
  - ④非受保护路径真实写入成功;
  - 加测:挂自动放行 answerer(`--patch`)后同一受保护写 `outcome:"allowed-once"` 且文件落盘(证明 ask 可翻案,这正是不用 `tools.guard()` 的理由)。
- 环境备注(复用给后续 WS):Cursor 自带 node(Anysphere 签名 + hardened runtime)加载三方原生模块(koffi/sharp)会 dlopen 失败,统一改用用户自装官方 node(`/Users/qinshu/.local/node/bin`);源码启动解析 profile 裸包名需 `node --expose-internals`(loader 可选原生助手未装,产品安装态不受影响)。

## 环境事实(影响验收方式)

- dsh 主仓 HEAD = `47f943859bef60e4160492346772ded9b24f765a`(2026-08-13,master),node_modules 在位;所有插件按此 commit pin。
- **无 DEEPSEEK_API_KEY**(无根 .env、无环境变量)→ 行为验收走 keyless 路线:Loader 起真 cordis.yml 组合 + dsh 自带 `llm-mock-server`/`llm-replay` 测试件驱动模型回合;`dsh plugin add` 安装链路用独立 DSH_HOME 沙盒目录验证,不碰用户真实 dsh home。若主控希望补真模型验收,提供 key 后可直接重跑同一套驱动。
- papertableV1 在开工前已有**既有未提交改动**(`AGENTS.md`、`docs/REQUIREMENT-DOMAINS.md`、`frontend/src/App.tsx`、`frontend/src/components/Dialogs.tsx`、`frontend/src/components/ProjectSidebar.tsx`)——非本战役产物,本战役不触碰这些文件;最终 git status 核对时请按此基线甄别。

## 守门红线状态

零触碰。产出仅落 `dsh-plugins/`、`skills/`、`agent-bridge/out/`(及简报明示授权的 `agent-bridge/PROTOCOL.md`)。

## 阻塞/请示

(暂无)
