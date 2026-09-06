# 镇纸外部 agent 协作守门红线（常驻，所有简报默认引用）

> 来源：2026-08-12 协作台研究报告第 10 条漏坑——"agent 能改守门人，铁律就只是文档不是控制"。
> 用户当日拍板生效。每份派活简报开头必须写：「先读 agent-bridge/GUARDRAILS.md，红线默认生效」。

## 一、守门文件：改动必须用户本人点头

以下四类文件/动作，任何 agent（claude / codex / kimi 子代理）**不得自行修改**；
确有需要时，在回报里提出改动建议，等用户本人明确批准后单独开简报执行：

1. **权限与状态机代码**：`src/main.ts` 的路由权限段、`src/pw-collab.ts` 的写工具纪律/铸币纪律
   （COLLAB_SYSTEM_PROMPT 店规段）、`settle_bet` / `confirm_bet_draft` / 审批流相关函数、
   各模块里以「人发话才执行」开头的工具定义。
2. **数据库 schema 变更**：CREATE TABLE IF NOT EXISTS 以外的一切结构动作（重建表、加列迁移、
   改约束、删表）。
3. **部署与常驻进程**：launchd plist、`com.qinshu.papertable.*` 服务的启停脚本、构建/发布脚本。
4. **验收检查定义**：selfcheck、CI 脚本、验收简报里写死的判定标准——agent 不得通过修改
   检查本身来让自己的产出"通过"。

例外：修 bug 时**读**这些文件不受限；限制的是**写**。

## 二、提案语义：外部 agent 的产出永远是"提案"

- 外部 agent 可以：读正式状态、生成草稿/diff/证据、跑测试、写 briefs/out 文档。
- 外部 agent 不可以：直接把任何业务对象标成正式/已验收/已结账状态来替用户下判断。
- "摆过 ≠ 用过"、"自报通过 ≠ 验收通过"——验收结论以 codex 浏览器验收 + 用户复看为准。

## 三、沿用的既有纪律（汇总引用，细则以原简报为准）

- 前端（frontend/ 一切实现、build、截图、验收）只能由 kimi 主代理亲自做，不派任何子代理/窗口。
- papertable 真库（~/Library/Application Support/Papertable/papertable.sqlite3）只读。
- Memos 笔记库只读。
- 不 commit、不 push，除非用户明确要求。
- AI 摆证据、人下判断；AI 对正式表无写权限（铸币权在人）。
