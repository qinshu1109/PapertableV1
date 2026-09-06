# 14 · 协作台「模式与对账条」后端接口

先读 `agent-bridge/GUARDRAILS.md`，红线默认生效（本任务不碰任何守门文件，纯加法）。

## 背景

协作台研究报告的落点之一：模式感知——「谁在干活 / 待你判断几件事 / 上次状态变化」必须
持续可见。一期先做系统视角的对账条：把系统自己已经知道的待办与动态聚合成一个只读接口，
前端（kimi 主代理负责）在协作台顶上加一条 slim 状态条。外部 agent（herdr 窗口）的实时
状态系统不知道，本接口不假装知道。

## 新接口 `GET /api/pw/mode-bar`

只读聚合，全部复用现有表/函数，不新建表、不改现有行为：

```json
{
  "generatedAt": "ISO",
  "pendingReview": {
    "betDrafts": 0,
    "settleDrafts": 0,
    "corpusProposed": 0,
    "total": 0
  },
  "recentRuns": [
    { "kind": "…", "eventType": "…", "betId": "…|null", "createdAt": "ISO" }
  ],
  "lastActivityAt": "ISO|null",
  "writeDiscipline": "AI 只摆证据与起草；挑/否/定稿/结账/守门文件改动，只有人能做。"
}
```

- `pendingReview`：`collabPendingQueue()` 三类各自的条数（betDrafts/settleDrafts/corpusProposed）
  + total。注意只数**待处理**状态的（pending/suggested），别把已批准已拒绝的数进去——读
  现有 list 函数的状态字段确认口径，口径写进模块注释。
- `recentRuns`：`listPwRuns` 取最近 8 条（不限 kind），字段就上面四个。
- `lastActivityAt`：pw_runs 里最新 created_at（没有则 null）。
- `writeDiscipline`：固定文案常量，放模块顶部，与 GUARDRAILS.md 语义一致。
- 新文件建议 `src/pw-mode-bar.ts`；路由注册照 main.ts 现有 `/api/pw/*` 写法。
- 不调 LLM、不加依赖、不动前端、不动 Memos/真库。

## 验收（自行跑完再回报）

- 新增 `pw-mode-bar.test.ts`：空库时全 0/null 正常；灌入 pending 草稿与若干 run 后计数与
  排序正确；只数待处理状态（已批准/已拒绝不计）。
- `npm test` 全绿无回归；`npm run selfcheck` ok。
- curl 真接口贴真实返回。
- 回报：改动文件、测试结果、curl 输出。浏览器验收由 codex 窗口负责。
