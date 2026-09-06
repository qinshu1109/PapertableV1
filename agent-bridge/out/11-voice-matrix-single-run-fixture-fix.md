# 修复结果：11 · 观众声音「交叉」页恢复单版验收样本（claude 窗口）

- 日期：2026-08-12
- 简报：`agent-bridge/briefs/11-voice-matrix-single-run-fixture.md`
- 类型：**纯数据修复**（无任何 src 代码改动，不建表不改逻辑，聚合接口零特判）

## 根因（数据层）

`BV1dEuZ6mEii`（原单版验收样本，1180 条）在真库里有两条 run，信号集合逐字节相同（825 条一致、差异 0）：

| run_id | provider/model | created_at | reassigned |
|---|---|---|---|
| `53c8984d…` | `claude-code 子代理编组/deepseek` | 2026-08-11T15:33Z（08-11 原版） | 1 |
| `a58db6ba…` | `claude-code/sonnet-4.6` | 2026-08-12T09:18Z（**今天重复导入**） | 1 |

证据：08-11 主报告 `agent-bridge/out/voice-sieve-BV1dEuZ6mEii-2026-08-11.md` 署名「claude-code 子代理编组（Sonnet 4.6）·②千级 map-reduce·重派 1 批」，与 `53c8984d` 完全吻合；`a58db6ba` 是 08-12 的晚近导入，report_path 指向同一文件、判决逐条相同 → 属重复测试数据。

## 改动（仅真库数据）

删除 `a58db6ba-1033-4f3f-9b72-9b5244b16eee` 及其 1180 条 `pw_voice_sieve_items`（单事务），保留原版 `53c8984d`。删除严格按 run_id scoped（只属 `BV1dEuZ6mEii`），未触碰 `BV1DhpYzSENp` / `BV1Ncs1z2Ego` 的任何 run。

- 回滚备份：`/tmp/pw71-removed-a58db6ba.jsonl`（run 1 行 + items 1180 行）

## 接口自检（真库，读接口）

`GET /api/pw/voice/sieve-matrix?bvid=BV1dEuZ6mEii`（等价 getPwVoiceSieveMatrix）：

```
runCount         = 1            （目标 1）✓
runs             = claude-code 子代理编组/deepseek(sig825)
unionSignals     = 825          ✓
singletonSignals = 825          （单版独有 = 该版 signal 总数）✓
consensusSignals = 825
多版复现（signalRunCount≥2）= 0  ✓
bucketMatrix     = 8 桶，顶桶「评价」total 403
```

前端据此出现单版降级态：`只有一版筛子——再跑一版不同模型，才看得出哪些是复现、哪些是独有。`、多版复现 0、单版独有 825。

另两样本未受影响：
```
BV1DhpYzSENp runCount = 4 （Qoder 四版，不变）✓
BV1Ncs1z2Ego runCount = 2 （两版，不变）✓
```

## 测试

- `PATH="$HOME/.local/node/bin:$PATH" npm test` → **361/361 全绿**（未改代码，纯数据修复）
- `npm run selfcheck` → ok
- 前端未改；未运行前端 build（避免触碰 kimi 在途的 public/assets 产物）

## 请 Codex 复测

按简报 11 验收点浏览器复测「交叉」页 `BV1dEuZ6mEii`：runCount 显示 1、出现单版降级态文案、多版复现 0、单版独有 825；并抽查 `BV1DhpYzSENp`（四版）与 `BV1Ncs1z2Ego`（两版）不受影响。
