# 简报 46：证据页路由兼容尾斜杠/大写（修手机白屏）

## 一句话任务

真值仓库 `/Users/qinshu/Documents/papertableV1`（不是 kimi窗口 worktree）的 `src/main.ts:1826`，`/n/<token>` 路由正则太严，飞书客户端把链接变形（尾斜杠或十六进制大写）后落到 SPA 回退，手机端白屏。改成兼容两种变形。

## 已查实的根因（curl 经隧道实测，勿再猜）

token `4aa3194660e02544f159e38d20a59026` 四种变形经 `https://dsh.cozai.net`：

- `/n/$T` → 押注证据卡 ✓
- `/n/$T?from=feishu` → 押注证据卡 ✓
- `/n/$T/`（尾斜杠）→ 返回 SPA index.html ✗（白屏根因）
- `/n/$TU`（末位大写）→ 返回 SPA index.html ✗（白屏根因）

落到 SPA 回退后，SPA 引用的 `/assets/*.js` 经隧道 `*` 规则打到 3080（dsh），拿到 HTML 而非 JS，所以白屏。

## 要做的改动（就这两行，别扩散）

`src/main.ts:1826-1828` 当前：

```ts
  const notifyPageMatch = path.match(/^\/n\/([0-9a-f]{32})$/u);
  if (notifyPageMatch && method === "GET") {
    renderPwDispositionPage(services.store.db, notifyPageMatch[1], response);
```

改为：

```ts
  const notifyPageMatch = path.match(/^\/n\/([0-9a-fA-F]{32})\/?$/u);
  if (notifyPageMatch && method === "GET") {
    renderPwDispositionPage(services.store.db, notifyPageMatch[1].toLowerCase(), response);
```

必须 `toLowerCase()`：`verifyDispositionToken`（`src/pw-notify.ts:317`）对明文 token 做 sha256 查表，大写 token 不转小写会哈希不匹配、查不到记录。

若已有覆盖该路由的测试文件，补尾斜杠和大写两个用例；没有现成测试锚点就不新建文件。

## 验收步骤（全绿才算完）

1. `cd /Users/qinshu/Documents/papertableV1 && npm run verify` 全绿。
2. `launchctl kickstart -k gui/501/com.qinshu.papertable.backend` 重启 4317。
3. curl 复测四种变形，响应 title 都应是「押注证据卡 · 镇纸」，不是「纸桌 Papertable · 图结构知…」：

```bash
T=4aa3194660e02544f159e38d20a59026
for u in "/n/$T" "/n/$T?from=feishu" "/n/$T/" "/n/${T^^}"; do
  curl -s "https://dsh.cozai.net$u" | grep -o '<title>[^<]*</title>'
done
```

## 红线

- 不动前端、不动 git commit/push、不动证据页里「回镇纸处置」链接（那是另一件事，主控另行决策）。
- 网络连接失败先怀疑本机 Clash（7897/TUN），别下对端故障结论。
- 完工后立刻执行（把结果推回主控）：
  `herdr agent prompt wG:p1 "简报46 完工：一句话结论 + 产出路径 + 有无阻塞"`

## 产出

写 `/Users/qinshu/Documents/papertableV1/agent-bridge/out/46-notify-route-compat.md`：改动 diff、verify 结果、四条 curl 的 title 实测、有无阻塞。
