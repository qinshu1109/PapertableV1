# TASK-PW-08 观众声音手动录入与分拣

- 主需求域：实践与数据回收
- 业务接口：信号候选·生产侧
- 数据真值源：pw_voice_items（本任务创建并独占表结构）
- 质量约束与验收终态：见文末验收命令全部通过

## 背景

PRD：`docs/PRD-Paperweight.md` v0.2。评论区反馈的蓄水池，"只收能进创作闭环的信号"。P0 手动粘贴录入 + 一键 LLM 分拣（个人量级几十到几百条，一次 LLM 调用优于搭建聚类管线）。隐私纪律：评论作者只存哈希，不存昵称原文。

## 并行约定（PW 后端批通用，必须遵守）

- 只能新建两个文件：`src/pw-voice.ts`、`src/pw-voice.test.ts`；不得修改 `src/main.ts`、`src/data.ts`、`src/verdicts.ts`、`package.json`、`frontend/**`、`public/**`。
- 表创建用模块内 `ensurePwVoiceTables(db)`，不建共享迁移文件。
- 不 import 任何其他 `pw-*.ts` 模块；artifact_id 只存字符串，不加外键。
- HTTP 挂载不做；只导出纯函数，测试用内存库自包含。LLM 调用必须可注入替身，测试全程不发起真实网络请求。

## 范围

`src/pw-voice.ts`：

- `ensurePwVoiceTables(db)`：`pw_voice_items` 表：`id TEXT PRIMARY KEY, artifact_id TEXT, platform TEXT NOT NULL, author_hash TEXT NOT NULL, content TEXT NOT NULL, captured_at TEXT NOT NULL, signal_type TEXT CHECK(signal_type IN ('topic_lead','content_critique','form_suggestion','noise') OR signal_type IS NULL), cluster_id TEXT, promoted_to_draft_id TEXT, dropped_reason TEXT, created_at TEXT NOT NULL`。
- `addPwVoiceItem(db, input)`：录入。platform、content、captured_at 必填；作者昵称经 SHA-256（`node:crypto`）哈希后存 author_hash，**模块内任何位置不得持久化昵称原文**。
- `classifyPwVoiceItems(db, ids, llmFn)`：分拣。`llmFn` 为注入的调用函数（签名 `(prompt: string) => Promise<string>`，集成阶段接 `src/provider-settings.ts` 的云端模型通道）；把评论内容与信号类型枚举一起组成 prompt，解析返回的 JSON（每条：signal_type ∈ topic_lead/content_critique/form_suggestion/noise、cluster 标签），回写同表；解析失败的条目标记 signal_type=NULL 不阻断整批。
- `dropPwVoiceItem(db, id, reason)`：丢弃留痕（reason 必填，不删行）。
- `listPwVoiceItems(db, { signalType?, unprocessed? })`：列出，支持按信号类型与"未分拣"过滤。

## 验收

- `node --test src/pw-voice.test.ts` 全绿：录入后 author_hash 为 64 位十六进制且库中无昵称原文；注入假 llmFn 返回合法 JSON 时回写正确；返回坏 JSON 时不阻断、对应条目 signal_type 为 NULL；丢弃必填原因；过滤查询正确。
- `npm run selfcheck` 不退化。
