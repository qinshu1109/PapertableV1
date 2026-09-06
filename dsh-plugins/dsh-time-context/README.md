# dsh-time-context

DeepSeek Harness 的**主动时间感知**插件：把当前本地时间经 systemPrompt runtime context 注入模型上下文（变化才追加，KV-cache 友好），并配一条相对时间计算规矩。模型不用想起来去查时间工具——每一轮请求都带着"现在几点"。

## 它解决什么

工具型时间插件（如 `@deepseek-ai/dsh-tool-time`）要求模型**主动**想起来调工具；本插件是另一半——**被动但必达**：时间以 runtime context（user-role 快照）进请求，模型看到"今天/昨天/到期/几天没动"这类相对时间时，以注入的当前时间为准现算，而不是凭训练数据猜日期。

## 安装

```sh
dsh plugin --profile <name> add /path/to/dsh-time-context
dsh --profile <name> --dump-config   # 应出现 time-context 行
```

装进 profile 后默认分钟级刷新、系统时区，无需任何配置即可用。示例（cc-tui）：

```sh
dsh plugin --profile cc-tui add /Users/qinshu/Documents/papertableV1/dsh-plugins/dsh-time-context
dsh --profile cc-tui --dump-config
```

## 配置

默认层（`cordis.patch.yml`）；profile patch 按 row id 整体覆盖 config：

```yaml
- id: time-context
  config:
    refreshSeconds: 60      # 注入文本最多每 60 秒变一次（默认分钟级）
    # timezone: Asia/Shanghai  # IANA 时区名；缺省 = 系统时区
    # sectionOrder: 160      # 规矩节顺序（工具引导带 100–199）
    # contextOrder: 10       # runtime context 顺序（升序拼接）
```

| 键 | 默认 | 说明 |
|---|---|---|
| `refreshSeconds` | `60` | 刷新粒度（正整数）。`<60` 秒级精度（`08:15:30`）；`60–3599` 分钟级（`08:15`）；`≥3600` 小时级（`08 时`） |
| `timezone` | 系统时区 | IANA 名（如 `Asia/Shanghai`、`UTC`）；非法时区加载时 fail loud |
| `sectionOrder` | `160` | 相对时间规矩节的 system-prompt 顺序 |
| `contextOrder` | `10` | 时间 runtime context 的顺序 |

未知配置键（拼写错误）加载时 fail loud，不会静默回落默认值。

## 行为

- **注入内容**：`当前时间：2026-08-14 周五 08:15（Asia/Shanghai）`（中文短星期周一..周日；格式随粒度变化）。
- **刷新粒度语义**：显示的瞬间被 floor 到 `refreshSeconds` 桶，同一桶内文本逐字不变，跨桶才变——粒度越粗，快照追加越少，越省 KV cache；代价是显示时间最多滞后一个桶。
- **变化才追加**：harness 的 runtime context 投影只在新快照与已保留快照不同时才追加一条 user 消息；同一分钟内长会话只追加一次。
- **规矩节**（system prompt section，逐字）：`涉及“今天/昨天/到期/几天没动”等相对时间时，以注入的当前时间为准现算，禁止凭训练数据猜日期。`——中文、零业务词汇。
- **注册可逆**：`ctx.systemPrompt.section()/context()` 均为 fiber 级 Cordis effect 注册（见 `dsh:docs/subsystems/system-prompt.md`），随插件 fiber 卸载（HMR / profile 重载 / 关停）自动释放，也各自返回显式 disposer。
- **零依赖**：无 npm 依赖，纯 `Intl` 格式化。

## 边界（如实声明）

- 时间注入是**每会话**的：新会话第一轮请求即携带当前时间；同一会话内跨轮次推进靠"变化才追加"。
- 粒度与精度绑定：`refreshSeconds` 决定文本精度档位（秒/分/时），不能"细粒度刷新但粗精度显示"（反之亦然）。
- 不干预模型行为：插件只注入事实与一条计算规矩，不拦截、不改写任何请求；相对时间的正确与否最终由模型执行。
- pre-release 兼容：harness 无兼容承诺，pin 见 `package.json` `dshCompatibility.harnessCommit`；升级 harness 后重跑验收。

## 测试与验收实录

### 单测（纯逻辑，无 harness）

`npm test` — 13 项全过：配置校验（未知键/非法粒度/非法时区/非对象）、注入内容格式（与简报样张逐字一致）、中文短星期跨周映射、粒度→精度三档、时区换算（含跨日联动）、桶内稳定/跨桶变化、floor 滞后语义、规矩文本零业务词汇。

### 行为验收（2026-08-14，keyless，llm-mock-server 驱动真组合）

环境：`DSH_HOME=/tmp/dsh-tc-home` 独立沙盒 + headless profile + 本插件 `dsh plugin --profile headless add` 安装；`--patch` 挂 `refreshSeconds: 1`（秒级快照便于观察推进）与验收专用双轮驱动插件（首轮流式中注入第二条消息，触发同会话第二轮）；LLM 指向 mock（`DEEPSEEK_BASE_URL` + `DEEPSEEK_API_KEY=mock-key`）。mock 服务器捕获全部模型请求原文。

**证据 1：模型请求确实带着当前时间**（首轮请求 body 原文节选）：

```text
user: 请逐字复述你收到的当前时间。
user: Current runtime context. This snapshot supersedes earlier runtime-context snapshots.

      当前时间：2026-08-14 周五 08:15:48（Asia/Shanghai）
```

**证据 2：同一会话跨轮次时间戳前进**（第二轮请求 body 原文节选——旧快照留在历史里，新快照因时间变化被追加）：

```text
user: 请再次确认当前时间（逐字复述）。
user: Current runtime context. This snapshot supersedes earlier runtime-context snapshots.

      当前时间：2026-08-14 周五 08:15:52（Asia/Shanghai）   ← 08:15:48 → 08:15:52，变化才追加
```

**证据 3：规矩节在 system prompt 中**（system 消息含）：

```text
涉及“今天/昨天/到期/几天没动”等相对时间时，以注入的当前时间为准现算，禁止凭训练数据猜日期。
```

> mock 服务器的行为脚本是跨请求 FIFO，重跑验收前要重启 mock。

## 产出归属

Papertable 简报 25（2026-08-14，dsh-cc 执行）。零 Papertable 业务耦合；时间格式与规矩文本全中文、零业务词汇。
