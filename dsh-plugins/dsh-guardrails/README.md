# dsh-guardrails

DeepSeek Harness 的**受保护路径人审闸门**插件:在 `tools/pre-execute` waterfall 上匹配配置的受保护 glob,命中即返回 `{kind: 'ask'}`,由 tools registry 走 `ctx.approval` 审批席——交互面弹人审,无 answerer 的组合(headless/CI)**fail-closed 自动拒绝**。这是特性不是缺陷。

刻意**不用 `ctx.tools.guard()`**:guard 的否决是单调的,而本插件的立意是"默认拦下,但人可以翻案放行"。放行走 approval 席的 `allowed-once`,一次一批。

招牌规则(默认配置自带):**验收/CI/测试定义路径永远 ask**——agent 不得自行修改用来检验自己产出的检查。

## 兼容性(重要)

deepseek-harness 处于 pre-release,**无兼容承诺**。本插件按以下版本开发并验收:

| 项 | 值 |
|---|---|
| harness commit | `47f943859bef60e4160492346772ded9b24f765a`(master, 2026-08-13) |
| harness 版本号 | 0.1.0-rc.5 |
| 依赖的稳定接口 | `tools/pre-execute` waterfall、`PreToolDecision` 的 `ask` 变体、approval 席 fail-closed 语义 |

升级 harness 后必须重跑下方验收。pin 信息同时写在 `package.json` 的 `dshCompatibility` 字段。

## 安装

```sh
# 装进某个 profile(会自动创建 profile 目录)
dsh plugin --profile <name> add /path/to/dsh-guardrails
# 验证组合
dsh --profile <name> --dump-config   # 应出现 "# == dsh-guardrails" 层与 guardrails 行
```

插件零 dsh 运行时依赖(纯对象字面量协议),唯一 npm 依赖是 `picomatch`。

## 配置

bundle 自带默认层(`cordis.patch.yml`)。在 profile 的 `cordis.patch.yml` 里用 id 定向 patch 覆盖(**整个 config 替换**,保留的规则要重新写全):

```yaml
- id: guardrails
  config:
    protected:                       # 必填,非空;命中即 ask
      - glob: 'db/migrations/**'
        reason: 'Schema migrations require human review.'   # 模型可见,写英文
      - glob: 'scripts/verify-*'
        reason: 'Verification scripts are protected: agents must not modify the checks that verify their own work.'
    pathTools:                       # 可选;省略用默认(write/edit/str_replace_editor)
      - tool: write
        argument: file_path
      - tool: str_replace_editor
        argument: path
        skipWhen: { argument: command, equals: [view] }   # 只读子命令放过
    commandTools:                    # 可选;省略用默认(bash/pwsh)
      - tool: bash
        argument: command
```

语义:

- 相对 glob 自动补任意深度前缀(`scripts/verify-*` 同时命中相对路径与任何绝对前缀下的该路径);`dot: true`(点文件参与匹配)。
- `pathTools`:按工具名取目标路径参数做精确 glob 匹配。
- `commandTools`:**保守启发式**——命令文本按空白/引号/分隔符切 token 逐个 glob 匹配(含 `--flag=path` 剥离),另对 glob 的静态前缀(≥3 字符且含 `/`)做子串命中。宁可误 ask 不可漏放(误 ask 人一键放行即可)。
- 配置错误在插件装载时抛错(fail-loud),不会静默降级。

## 边界(如实声明)

- **这不是进程级围栏。** 模型若用意料之外的工具或编码绕路写文件,本闸门管不到;硬保证归 dsh 的 sandbox 轴(`sandbox/mode`),两者叠加使用,职责正交。
- bash 命令匹配是文本启发式:变量展开、`$(...)`、重定向拼路径等可绕过;同上,硬保证归 sandbox。
- 工具参数畸形(非对象)时闸门不表态,由工具自身的 schema 校验报错。
- `approval policy: never` 的会话里,ask 会被确定性拒绝(等同永不放行),这是 approval 席的语义,不是本插件的分支。

## 测试与验收实录

单元测试(纯逻辑,无需 harness):

```sh
npm install && npm test   # node:test,10 项全过
```

行为验收(keyless,mock LLM 驱动真组合;`$DSH` 代表 harness 源码根,沙盒 `DSH_HOME`):

```sh
# mock LLM:脚本化"先调 write 工具再收尾"
node --import tsx packages/test-support/llm-mock-server/src/bin.ts --port 8123 --api-key mock-key \
  --sequence tool_call_success,success --repeat-last --tool-name write \
  --tool-arguments '{"file_path":"/tmp/guardtest-ws/scripts/verify-guard-demo.ts","content":"BAD"}' \
  --success-text "done after tool"
# 安装 + 组合验证
DSH_HOME=/tmp/dsh-guardtest-home dsh plugin --profile headless add <本目录>
DSH_HOME=/tmp/dsh-guardtest-home dsh --profile headless --dump-config | grep -A4 guardrails
# 触发
DSH_HOME=/tmp/dsh-guardtest-home DEEPSEEK_BASE_URL=http://127.0.0.1:8123/v1 DEEPSEEK_API_KEY=mock-key \
  dsh --profile headless "please write the demo file"
```

2026-08-14 在上述 pin 版本实测的四项验收(会话日志 `$DSH_HOME/sessions/**/session.jsonl.zstd`,多 zstd frame,按 frame 解压):

1. **受保护路径触发人审** — 日志出现 `approval/asked`,reason 为本插件文案:`"Verification scripts are protected: … [guardrails: \"/tmp/guardtest-ws/scripts/verify-guard-demo.ts\" matches protected pattern \"scripts/verify-*\"; human approval required]"`。
2. **headless 无 answerer 自动拒** — `approval/decided` `outcome:"unavailable"`;`tool/result` 为 `isError:true`,模型可见文案 `Error: tool "write" requires approval, but no approval channel is available`;目标文件未落盘。
3. **审计齐全** — `approval/asked`/`approval/decided`/`tool/call`/`tool/result` 成对入会话日志(durable)。
4. **非受保护路径畅通** — 同法把目标换成 `/tmp/guardtest-ws/notes/hello.txt`(配 `DSH_PERMISSION_MODE=danger-full-access` 免沙盒干扰),文件真实写入,内容一致。

加测**放行路径**:挂测试用自动放行 answerer(`tests/fixtures/auto-approve.js`,经 `--patch` overlay 插行),同一受保护写入变为 `approval/decided` `outcome:"allowed-once"`,文件落盘——证明 ask 可被人翻案,guard 做不到这一点。

> 源码启动(`node --import tsx/esm apps/cli/src/bin.ts`)解析 profile 里的裸包名需要 `--expose-internals` 或 loader 的可选原生助手 `node-addon-require-builtin`;产品安装态不受影响。

## 产出归属

Papertable 简报 19 战役 WS1(2026-08-14),对应可行性报告候选 7。零 Papertable 业务耦合,规则全部来自 config。
