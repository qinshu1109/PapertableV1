# 24-scope-required-fix：非 case_only 晋级必须带适用范围（简报 24 验收问题修复）

- 简报 24 验收发现（codex → 直投 dsh-cc 修复）；修复：dsh-cc（w1:pH）
- 日期：2026-08-14
- 性质：后端缺陷修复（简报 23 产物的验收回路）

## 缺陷现象

隔离实例 4399 上，`POST /api/pw/verdicts/543d2fc9-bf73-4c2f-9e73-7cebf351ddff/promote` body `{"level":"prior"}` 错误返回 **HTTP 201 且 scope:null**。简报 24 验收清单第 1 条：「选非『仅归档』时适用范围必填」，应返回 400。

## 根因

`src/pw-closed-loop.ts` `promotePwVerdict` 只校验了 `level` 枚举，未按简报 24 口径校验 scope：非 `case_only` 档位（prior/warning/hard_constraint/action_item）缺 scope 也照落行。

## 修复

`src/pw-closed-loop.ts` `promotePwVerdict`：level 校验通过后、落库前新增——

```ts
const scope = optionalText(input?.scope);
if (level !== "case_only" && !scope) {
  throw httpError(400, "非 case_only 晋级必须填写适用范围 scope");
}
```

语义：`case_only`（仅归档）是唯一允许 scope 为空的档位；其余四档 scope 缺失或空白 → 400。模块注释同步写明该口径。

## 测试

- `src/pw-closed-loop.test.ts`：新增 1 条「非 case_only 必须带 scope（缺失/空 → 400）；case_only 允许无 scope」；既有「同 verdict 再晋级」用例的 `prior` 补上 scope 以符合新口径。
- `npm test`：**420 tests, 420 pass, 0 fail**（原 419 + 新增 1）。

## 真实 curl 复现（隔离实例，写演示，真库零接触；跑完已停）

```text
POST /api/pw/verdicts/543d2fc9-…/promote  {"level":"prior"}
→ {"error":"非 case_only 晋级必须填写适用范围 scope"} HTTP 400   ← 验收现场复现，已修复

POST …/promote  {"level":"warning","scope":"  "}
→ HTTP 400（空白 scope 同样拦下）

POST …/promote  {"level":"prior","scope":"切片类选题"}
→ HTTP 201，scope=切片类选题，decided_by=human

POST …/promote  {"level":"case_only","reason":"本轮不晋级"}
→ HTTP 201，scope:null（仅归档档允许无 scope）
```

## 守门自查

- 守门①：未改路由权限段/写工具纪律/状态机函数；只给简报 23 授权的 `promotePwVerdict` 加参数校验。
- 守门②：无 schema 变更。
- 守门③：**未碰生产 4317**（未重启、未读写）；修复仅在代码与测试，待下次部署生效。
- 守门④：未改验收判定标准。
- 其他：不 commit、不 push；frontend/ 未动。

## 待 codex 复测

复测即验收现场同款：隔离实例起服务 → 对任一判决 `POST promote {"level":"prior"}`（不带 scope）→ 期望 HTTP 400；带 scope → 201；case_only 不带 scope → 201。
