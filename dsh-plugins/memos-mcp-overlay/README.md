# memos-mcp-overlay

DeepSeek Harness(dsh)的**零代码记忆 MCP overlay**:一个 `memos.cordis.yml`,单条 insert 行挂官方 `@deepseek-ai/dsh-mcp-client`,把任意记忆 MCP 服务器(MemOS/mem0/zep/自建)接进 dsh,工具以 `mcp__memos__<原名>` 注册给模型。形态与 dsh 自家 `examples/mcp-memory/*.cordis.yml` 完全同构;本目录只是把命令/端点**全参数化**并预填了本机 MemOS 的真实示例。

## 兼容性(重要)

deepseek-harness 处于 pre-release,**无兼容承诺**。本 overlay 按以下版本开发并验收:

| 项 | 值 |
|---|---|
| harness commit | `47f943859bef60e4160492346772ded9b24f765a`(master, 2026-08-13) |
| harness 版本号 | 0.1.0-rc.5 |
| 依赖的稳定接口 | `@deepseek-ai/dsh-mcp-client` 的 Config 联合(stdio / streamable-http 两分支)、loader 对 `config` 整值 `!!js` 表达式的插值 |

升级 harness 后必须重跑下方验收。

## 形态边界(如实声明)

- `@deepseek-ai/dsh-mcp-client` **不在任何 bundle 的依赖清单里**(dsh 自家的 memory 示例也是同样处境),所以本 overlay 是**源码启动 `--patch` 形态**,不是 `dsh plugin add` 的 profile 安装形态——没有 package.json、没有 `dsh.bundle.patch`,这不是遗漏。要长期生效,把 insert 段合并进 `$DSH_HOME/profiles/<name>/cordis.patch.yml`(别整文件覆盖,那里可能已有你自己的 patch)。
- dsh 只负责:解析 overlay、拉起 stdio 子进程或连接 HTTP 端点、发现工具、以 `mcp__memos__*` 注册。**不负责**安装/初始化记忆服务器本体;HTTP 形态要求上游服务已在运行。
- stdio 桥会先剥掉环境里疑似凭据的变量与所有 `DSH_*` 变量再拉子进程(dsh 的安全设计);需要额外密钥时把变量加进本行 `config.env`,不要写死在 YAML。
- MCP 初次发现是异步的:会话刚起时工具可能尚未注册完;`failOnStartupError` 默认 false,连不上只在日志报错、组合照常启动(这正是零干扰的取舍)。崩溃后由 mcp-client 自带的 reconnect 策略接管。

## 参数化(单行三个环境变量)

| 变量 | 作用 |
|---|---|
| `MEMOS_MCP_URL` | 设了(非空)即走 **streamable-http** 分支,连该 MCP 端点 |
| `MEMOS_MCP_COMMAND` | 未设 URL 时的 **stdio** 可执行命令;缺省是占位符 `<your-memory-mcp-command>`(启动时在日志里响亮失败,提醒你填) |
| `MEMOS_MCP_ARGS` | stdio 参数,JSON 数组字符串,如 `'["serve"]'` |

`serverName` 固定为 `memos`(决定模型可见的工具前缀 `mcp__memos__*`);要并挂多个记忆服务器时复制 insert 行并改 `id`/`serverName`。

**本机 MemOS 真实示例**(读自 `~/.cursor/mcp.json` 的 `memos-local` 条目——注意它是 **HTTP 型** MCP,`http://127.0.0.1:8002/mcp`,不是 stdio 命令,所以走 URL 分支):

```sh
MEMOS_MCP_URL=http://127.0.0.1:8002/mcp dsh --profile headless --patch "$PWD/memos.cordis.yml" "task"
```

其他 stdio 记忆服务器(以 dsh 示例里的 Memorix 为例):

```sh
MEMOS_MCP_COMMAND=memorix MEMOS_MCP_ARGS='["serve"]' dsh --patch "$PWD/memos.cordis.yml" ...
```

## 验证

```sh
# 组合验证:应出现 "# == …/memos.cordis.yml" 层与 memory-memos 行
dsh --profile headless --patch "$PWD/memos.cordis.yml" --dump-config
```

## 验收实录(2026-08-14,pin 版本,源码启动)

源码启动的 `dsh` 展开为:在 dsh 仓库根执行 `node --expose-internals --import tsx/esm apps/cli/src/bin.ts`;每次验收用独立沙盒 `DSH_HOME=/tmp/dsh-ws2-home`(先 rm -rf)。

1. **dump-config 显示该行**(默认 stdio 分支,未设任何环境变量):

   ```
   DSH_HOME=/tmp/dsh-ws2-home dsh --profile headless --patch …/memos.cordis.yml --dump-config
   # == /Users/qinshu/Documents/papertableV1/dsh-plugins/memos-mcp-overlay/memos.cordis.yml
   - id: memory-memos
     name: '@deepseek-ai/dsh-mcp-client'
     config: !!js |-
       (process.env.MEMOS_MCP_URL?.trim() ? { transport: 'streamable-http', …
   ```

2. **真启动连本机 MemOS,MCP 工具注册证据**。本机 `memos-local` 服务在线(POST `http://127.0.0.1:8002/mcp` initialize 返回 200)。keyless 用 mock LLM(`packages/test-support/llm-mock-server`,端口 8124,`--sequence success --repeat-last --success-text "ok"`)驱动真组合:

   ```
   MEMOS_MCP_URL=http://127.0.0.1:8002/mcp DSH_HOME=/tmp/dsh-ws2-home \
     DEEPSEEK_BASE_URL=http://127.0.0.1:8124/v1 DEEPSEEK_API_KEY=mock-key \
     dsh --profile headless --patch …/memos.cordis.yml "Say ok and stop."
   ```

   会话正常退出(输出 `ok`)。解压会话日志 `$DSH_HOME/sessions/**/session.jsonl.zstd`(多 zstd frame 逐帧解压),`request/header` 事件的工具清单里出现全部 17 个 MemOS 工具,包括:

   ```
   mcp__memos__get_hot_context  ("Return the versioned hot facts and hot Cube map; …")
   mcp__memos__route_memory  mcp__memos__search_memories  mcp__memos__add_memory  …(共 17 个)
   ```

   即模型在真组合里确实看到了以 `mcp__memos__` 为前缀的记忆工具。

## 产出归属

Papertable 简报 19 战役 WS2-L1(2026-08-14)。overlay 主体通用,零业务耦合;MemOS 仅出现在注释与示例值里。
