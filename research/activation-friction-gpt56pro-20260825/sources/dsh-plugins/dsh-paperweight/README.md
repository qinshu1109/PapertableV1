# dsh-paperweight

镇纸六屏 dsh 插件（双半结构）。

- `src/types.ts` —— 前后端共享契约（dsh-cc 定稿；Claude 只消费，改须 `agent-bridge/out/37-contract-changes.md` 留痕）。
- `src/host/` —— host 半（dsh-cc）：4317 fetch、`/pw/api/*` webServer 路由、8 只读工具 + `pw_draft_bet`、`/pw/api/action` 人按钮转发、定时推送、`/bets` 命令、店规 systemPrompt。
- `src/client/` —— client 半（Claude 负责，本包尚未写）。

## 铁律落实

1. 数据只走 `http://127.0.0.1:4317` HTTP API；host 不直连 SQLite、不建缓存镜像表。
2. 写路径只有两类：AI 起草 `POST /pw/api/draft/bet`（落 draft）；人点按钮 `POST /pw/api/action`（host 记 `source=human-click` 再转发 4317）。
3. AI 工具面 = 8 只读 + `pw_draft_bet`，无任何 settle/confirm/verdict 写 schema。
4. Memos/笔记经 4317 只读；数据文档只增不改。
5. 纸感浅色由 client 用 pw.css token 实现（host 不输出样式）。
6. 推送进插件本地收件箱（未读标记），不创建会话。
7. 永不做 AI 裁决工具、第二份数据副本、深色板、看板/日历/甘特。
8. 店规以 systemPrompt 段携带（`papertable:write-boundary`），文本照 `docs/SPEC-harness-write-boundary.md` 不放松。
9. 通知不绕微信；推送走 dsh 面板。

## 构建 / 自测

```bash
# 本机 dsh-wechat 自带 tsc 可用
../dsh-wechat/node_modules/.bin/tsc -p tsconfig.json
node --test test/host.test.ts
```

冒烟测试会起一个假 4317（随机端口）和假 Cordis ctx，覆盖全部 `/pw/api/*` 路由、工具面黑名单、命令、systemPrompt、推送收件箱，不占 3080/4317。

## 待 Claude

- 写 `src/client/` 并产出 `lib/client.js`。
- 在 `package.json` 补 `dsh.client` 声明（platform web + inject 列表），再按 `agent-bridge/out/37-progress-b.md` 联调。
