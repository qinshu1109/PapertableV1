# 简报 46 完工：证据页路由兼容尾斜杠 / 十六进制大写

## 一句话结论

`GET /n/:token` 已兼容尾斜杠与十六进制大写；四种变形经隧道实测 title 均为「押注证据卡 · 镇纸」，无阻塞。

## 改动

文件：`/Users/qinshu/Documents/papertableV1/src/main.ts`（约 1826–1828 行）。无现成 HTTP 路由测试锚点，未新建测试文件。未改前端源码、未 commit/push、未动「回镇纸处置」链接。

```
-  const notifyPageMatch = path.match(/^\/n\/([0-9a-f]{32})$/u);
+  const notifyPageMatch = path.match(/^\/n\/([0-9a-fA-F]{32})\/?$/u);
   if (notifyPageMatch && method === "GET") {
-    renderPwDispositionPage(services.store.db, notifyPageMatch[1], response);
+    renderPwDispositionPage(services.store.db, notifyPageMatch[1].toLowerCase(), response);
```

`toLowerCase()` 保证大写 token 与表内 sha256 明文一致。

## verify 结果

`cd /Users/qinshu/Documents/papertableV1 && npm run verify` 全绿：

- `npm test`：429 pass / 0 fail
- `npm run selfcheck`：`selfcheck: ok`
- `npm --prefix frontend run build`：vite built in 4.52s

随后 `launchctl kickstart -k gui/501/com.qinshu.papertable.backend`，进程 state=running。

## 四条 curl title 实测

token `4aa3194660e02544f159e38d20a59026`。macOS bash 3.2 无 `${T^^}`，大写用 `tr 'a-f' 'A-F'`（整串十六进制大写，效果等同）。

经 `https://dsh.cozai.net`：

| URL | title |
|---|---|
| `/n/$T` | `<title>押注证据卡 · 镇纸</title>` |
| `/n/$T?from=feishu` | `<title>押注证据卡 · 镇纸</title>` |
| `/n/$T/` | `<title>押注证据卡 · 镇纸</title>` |
| `/n/$TU`（十六进制全大写） | `<title>押注证据卡 · 镇纸</title>` |

本机 `http://127.0.0.1:4317` 四条同样是「押注证据卡 · 镇纸」，不是 SPA「纸桌 Papertable · …」。

## 有无阻塞

无。手机飞书再点一次卡片即可验证锁屏打开不再白屏。
