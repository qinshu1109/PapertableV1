# 简报37 契约变更/补充留痕

## #1 GET 路由响应包装形状(Claude 提议,2026-08-16)

契约 types.ts 已绑定各实体类型,但未绑定 GET 路由的响应包装(envelope)。为联调不互猜,提议如下(与既有 PwDraftBetResult/PwActionSuccess 的 `ok:true` 风格一致):

| 路由 | 响应 |
|---|---|
| GET /pw/api/bets | `{ ok:true, bets: PwBetView[] }` |
| GET /pw/api/bets/:id | `{ ok:true, bet: PwBetDetail }` |
| GET /pw/api/verdicts | `{ ok:true, verdicts: PwVerdictView[] }` |
| GET /pw/api/verdicts/:id/evidence | `{ ok:true, evidence: PwVerdictEvidenceView }` |
| GET /pw/api/voice/themes | `{ ok:true, themes: PwVoiceTheme[] }` |
| GET /pw/api/voice/items?theme= | `{ ok:true, theme: PwVoiceThemeDetail }` |
| GET /pw/api/notes/today | `{ ok:true, notes: PwNoteView[], memosOk: boolean }` |
| GET /pw/api/notes/tree | `{ ok:true, tree: PwNoteTreeView }` |
| GET /pw/api/ops/status | `{ ok:true, ops: PwOpsStatus }` |
| GET /pw/api/push/feed | `{ ok:true, feed: PwPushFeed }` |
| POST /pw/api/push/mark-read | `{ ok:true, unread: number }` |
| 任何失败 | 非 200 + `{ ok:false, error: string }` |

client 侧(api.ts 的 unwrap)同时兼容"裸类型直接返回"形态(如 GET feed 直接返回 PwPushFeed),host 按上表或裸形实现均可联通;**最终以 host 实现为准,联调时在本文件回填实际形状**。

## #1 实际回填(dsh-cc,2026-08-16,以 host 实现为准)

host 实际实现(`src/host/api.ts`)如下。成功 GET 不包 `ok:true`,直接返回裸字段/实体;POST 写路由保留 `ok:true` 风格;失败统一非 200 + `{ ok:false, error: string }`。

| 路由 | host 实际响应 |
|---|---|
| GET /pw/api/bets | `{ bets: PwBetView[] }` |
| GET /pw/api/bets/:id | `PwBetDetail` 直接返回(`{ ...bet, dataDocs, precedents, contextMarkdown }`) |
| GET /pw/api/verdicts | `{ verdicts: PwVerdictView[] }` |
| GET /pw/api/verdicts/:id/evidence | `PwVerdictEvidenceView` 直接返回(`{ verdict, evidence }`) |
| GET /pw/api/voice/themes | `{ themes: PwVoiceTheme[] }` |
| GET /pw/api/voice/items?theme= | `PwVoiceThemeDetail` 直接返回(`{ ...theme, items }`) |
| GET /pw/api/notes/today | `{ notes: PwNoteView[], status: 4317 /api/pw/notes/status 原样对象 }`(无 `memosOk` 字段) |
| GET /pw/api/notes/tree | `PwNoteTreeView` 直接返回 |
| GET /pw/api/ops/status | `PwOpsStatus` 直接返回 |
| GET /pw/api/push/feed | `PwPushFeed` 直接返回(`{ items, unread }`) |
| POST /pw/api/push/mark-read | `PwPushFeed` 直接返回(`{ items, unread }`,不是仅 `{ unread }`) |
| POST /pw/api/draft/bet | `PwDraftBetResult`(`{ ok:true, draft, draftHash }`) |
| POST /pw/api/action | `PwActionSuccess`(`{ ok:true, action, source:"human-click", result }`) |
| 任何失败 | 非 200 + `{ ok:false, error: string }` |

- 状态:已确认(dsh-cc 按 host 实现回填,Claude 按此表 unwrap 即可)。

## #2 新增 GET /pw/api/drafts(T3 契约缺口,2026-08-17)

背景:client 押注台「草稿区」需要读草稿列表;原契约路由表没有读草稿路由,`GET /pw/api/drafts` 在 dsh host 上 404。

契约变更(types.ts 同步更新):

- 路由表新增:`GET /pw/api/drafts` → upstream `GET /api/pw/drafts`(仅此一条,现拉现裁,不缓存)。
- 新增共享类型 `PwDraftView extends PwBetView { draftHash?: string }`;列表项与 `PwBetView[]` 兼容,`draftHash` 可选(host 按 4317 草稿字段同口径补算,4317 列表不直接给出时可为 undefined)。
- host 实际响应形状:`{ drafts: PwDraftView[] }`(与 GET /bets 的 `{ bets }` 风格一致;失败仍非 200 + `{ ok:false, error }`)。
- client 侧可按 `{ drafts }` 或裸数组 unwrap;确认转正仍走既有 `POST /pw/api/action`(`targetType:"draft"`),不新增写路由。

## #3 host 工具输出契约修正（codex 兜底，2026-08-17）

真实会话验收发现 9 个 `pw_*` 工具的 `execute` 均返回 JSON 对象，但原 `output.schema` 错写为 `{ type:"string" }`，导致 dsh registry 拒绝结果：`pw_read_data_docs/pw_ops_status` 报 `value must be a string`；`pw_read_bet/pw_list_bets` 还因 `normalizeBet` 显式保留 `draftCount: undefined` 报 `value is not lossless JSON`。

兜底修正：

- 9 个工具统一声明开放对象 schema：`{ type:"object", additionalProperties:true }`，与现有对象返回值一致。
- `normalizeBet` 在上游没有 `draft_count` 时直接省略可选字段，不再把 `undefined` 放入工具结果。
- 最终验收以重启后的真实 dsh registry 会话调用为准；该路径同时覆盖 schema 校验、lossless JSON 校验和模型可见渲染。
