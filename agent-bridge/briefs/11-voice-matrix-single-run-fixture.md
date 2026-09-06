# 11 · 观众声音「交叉」页：恢复单版验收样本

## 现象

2026-08-12 浏览器验收时，简报指定的单版样本 `BV1dEuZ6mEii`（1180 条）已不再是单版：

```text
GET /api/pw/voice/sieve-matrix?bvid=BV1dEuZ6mEii
summary.runCount = 2
summary.unionSignals = 825
summary.consensusSignals = 825
summary.singletonSignals = 0
runs = claude-code/sonnet-4.6 + claude-code 子代理编组/deepseek
```

两版信号集合完全相同，导致前端显示“多版复现 825”，无法验收原清单要求的单版降级态。

## 目标

让 `BV1dEuZ6mEii` 再次成为稳定的单版验收样本，接口满足：

- `summary.runCount = 1`
- 页面出现：`只有一版筛子——再跑一版不同模型，才看得出哪些是复现、哪些是独有。`
- `多版复现 = 0`
- `单版独有 = 该版 signal 总数`

## 约束

- 这是数据/接口修复，不改前端表现。
- 不影响 Qoder 四版样本 `BV1DhpYzSENp` 和两版样本 `BV1Ncs1z2Ego`。
- 优先修正错误/重复测试数据或测试夹具，不要在聚合接口里为某个 bvid 写特判。
- 修完自行跑接口校验，并回报改动、命令与结果；由 Codex 再做浏览器复测。

