# 25-time-context-done：dsh-time-context 插件完工报告

- 简报：`agent-bridge/briefs/25-time-context-plugin.md`（执行：dsh-cc，主控 kimi）
- 日期：2026-08-14
- 性质：开发（仓库外 bundle 插件：时间 runtime context 注入 + 相对时间规矩节）；不 commit、不 push

## 什么能用了

cc-tui profile 里现在有 `dsh-time-context`：每一轮模型请求都自动携带 `当前时间：2026-08-14 周五 08:15（Asia/Shanghai）`（systemPrompt runtime context，变化才追加、KV-cache 友好），system prompt 里多一条规矩——涉及"今天/昨天/到期/几天没动"等相对时间时以注入的当前时间为准现算、禁止凭训练数据猜日期。默认分钟级刷新、系统时区，装完零配置生效；与已装的工具型 `@deepseek-ai/dsh-tool-time` 互补（本插件管"主动感知"，工具管"按需精确计算"）。

## 交付物

| 路径 | 内容 |
|---|---|
| `dsh-plugins/dsh-time-context/package.json` | 零 npm 依赖；`dsh.bundle.patch` → `cordis.patch.yml`；`dshCompatibility.harnessCommit` pin **47f943859bef60e4160492346772ded9b24f765a**（2026-08-13, 0.1.0-rc.5），附 pre-release 无兼容承诺注记 |
| `dsh-plugins/dsh-time-context/cordis.patch.yml` | 默认层：`time-context` 行，`refreshSeconds: 60`（时区缺省=系统，注释说明覆盖方式） |
| `dsh-plugins/dsh-time-context/time-context.js` | 纯逻辑：配置校验（未知键 fail loud/正整数粒度/IANA 时区校验）+ 时间格式化（Intl，中文短星期，粒度→精度三档） |
| `dsh-plugins/dsh-time-context/index.js` | `apply(ctx, config)`：`ctx.systemPrompt.section()` 规矩节 + `ctx.systemPrompt.context()` 时间注入；两者均为 fiber 级 effect 注册（可逆，HMR/重载/关停自动释放），各自返回显式 disposer |
| `dsh-plugins/dsh-time-context/tests/time-context.test.js` | 13 条单测 |
| `dsh-plugins/dsh-time-context/README.md` | 安装/配置/行为/边界/测试与验收实录 |

## 行为口径（写进模块注释与 README）

- 注入文本：`当前时间：YYYY-MM-DD 周X HH:mm（时区）`；粒度决定精度——`refreshSeconds<60` 秒级、`60–3599` 分钟级、`≥3600` 小时级（`08 时`）。
- 刷新粒度=桶：显示瞬间被 floor 到 `refreshSeconds` 桶，桶内文本逐字不变、跨桶才变（KV-cache 友好）；代价是显示时间最多滞后一个桶。
- 规矩节文本（逐字）：`涉及“今天/昨天/到期/几天没动”等相对时间时，以注入的当前时间为准现算，禁止凭训练数据猜日期。`——中文、零业务词汇（测试断言无押注/判决/金子/墓碑等词）。
- 注册走 `ctx.systemPrompt.section()/context()`：二者即 fiber 级 Cordis effect 注册（`dsh:docs/subsystems/system-prompt.md` 签名 `section(section): () => void` / `context(context): () => void`），满足"注册走 ctx.effect()/disposer 可逆"硬约束。

## 测试结果

- `npm test`（插件目录，官方 Node v24.18.0）：**13 tests, 13 pass, 0 fail**
- 覆盖：配置校验（未知键/非法粒度/非法时区/非对象）、注入格式与简报样张逐字一致、中文短星期跨周映射、粒度→精度三档、时区换算（含跨日联动）、桶内稳定/跨桶变化、floor 滞后语义、规矩文本零业务词汇。

## keyless 验收实录（llm-mock-server 驱动真组合）

环境：`DSH_HOME=/tmp/dsh-tc-home` 独立沙盒（headless profile + `dsh plugin --profile headless add` 安装本插件）；`--patch` 挂 `refreshSeconds: 1`（秒级快照便于观察推进）与验收双轮驱动插件（首轮流式中注入第二条消息触发同会话第二轮）；`DEEPSEEK_BASE_URL`/`DEEPSEEK_API_KEY` 指向 mock（`packages/test-support/llm-mock-server` 库入口直启，捕获全部请求原文）。跑完沙盒已弃置、mock 已停。

**① 请求带着当前时间**（首轮请求 body 原文）：

```text
user: 请逐字复述你收到的当前时间。
user: Current runtime context. This snapshot supersedes earlier runtime-context snapshots.

      当前时间：2026-08-14 周五 08:15:48（Asia/Shanghai）
```

**② 同会话跨轮次时间戳前进**（第二轮请求 body 原文——旧快照留在历史、新快照因变化被追加）：

```text
user: 请再次确认当前时间（逐字复述）。
user: Current runtime context. This snapshot supersedes earlier runtime-context snapshots.

      当前时间：2026-08-14 周五 08:15:52（Asia/Shanghai）   ← 08:15:48 → 08:15:52
```

**③ 规矩节在 system prompt**（system 消息含逐字规矩文本）。

## cc-tui 安装验证

`dsh plugin --profile cc-tui add /Users/qinshu/Documents/papertableV1/dsh-plugins/dsh-time-context` 成功（link 依赖 + bundles 追加），`dsh --profile cc-tui --dump-config` 原文：

```yaml
# == dsh-time-context
- id: time-context
  name: dsh-time-context
  config:
    refreshSeconds: 60
```

web profile **未安装**（`grep dsh-time-context` 0 命中），按简报留给主控另行决定。

## 守门自查

- 未动 dsh 主仓（`/Users/qinshu/Documents/ChatGPT/MemOS/deepseek-harness/` 零写入，只读调研与 mock 库直启）；全部产出在 `dsh-plugins/dsh-time-context/` 与 `~/.dsh/profiles/cc-tui/`（用户已授权安装到 cc-tui profile）。
- 不 commit、不 push；`frontend/` 未动；真库/Memos 未碰。
- 插件为仓库外 bundle，不受 dsh 主仓覆盖率/门禁约束；兼容性按惯例 pin 声明。

## 给验收/主控的提示

- 复测路径：单测 `cd dsh-plugins/dsh-time-context && npm test`；行为验收按 README「测试与验收实录」一节重跑（mock 行为脚本是跨请求 FIFO，重跑前重启 mock）。
- 时区/粒度可按 profile patch 覆盖；默认配置即可用。
