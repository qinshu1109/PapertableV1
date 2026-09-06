# TASK-PW-56 b23.tv 短链解析（回流自动记账补全）

- 日期：2026-08-10
- 状态：已拍板（2026-08-10，用户「把短链解析也做了」；PW-55 验收留痕的候选）
- 主需求域：实践与数据回收
- 业务接口：无（域内）——PW-55B 回流自动记账的实现补全，接口口径不变
- 数据真值源：pw_artifacts（只读）、b23.tv 短链跳转（外部，一次性 HTTP）、pw_data_docs（写，回收域唯一归属）
- 质量约束与验收终态：见末节

## 这刀是干什么的（白话）

上一刀留了个口子：挂 B站视频产出物时用 b23.tv 短链（比如 https://b23.tv/ep1）解不出 BV 号，自动记账会跳过。这刀之后：短链也能认了——程序自己去问一下短链跳到哪（一次网络请求），拿到 BV 号照常记账。你在 B站 App 里点"分享→复制链接"拿到的就是短链，以后直接挂，不用手改。

## 怎么算好（白话）

- 拿 BET-01 挂的那条 https://b23.tv/ep1 真跑一次：BV 号能解出来（不再跳过、不再报警）。
- 解过一次就记住（这次开机内不再重复问网络）。
- 链接里本来就有 BV 号的，一次网络请求都不发。

---

以下给干活的看，可以跳过。

## 交付（后端，DeepSeek 子代理）

### `src/pw-bet-video-snapshot.ts` 改造

- 新增 `defaultResolveShortLink(url)`：fetch 跟随跳转（`redirect: 'follow'`、10s 超时、UA 头）→ 先看 `response.url` 是否含 `BV[0-9A-Za-z]{10}` → 没有再读 body 前 5000 字符找 BV → 都没有返回 null。**只对 `https?://b23.tv/` 前缀的 url 发起请求**（其余短链/杂链不碰网络，直接 null）。
- `resolveBvid` 升级：直接含 BV 照旧零网络；b23.tv 短链走解析；进程内 Map 缓存（shortUrl → bvid|null，本次进程生命周期内不重复请求）。
- `snapshotPwBetVideoStats` 改 **async**（解析要发网络请求）；opts 追加 `resolveShortLink?` 注入（测试 mock，缺省 defaultResolveShortLink）；`fetchStat` 同步闭包口径不变。
- `src/pw-corpus.ts` 触发钩子改 fire-and-forget：`void snapshotPwBetVideoStats(...).catch(err => console.warn(...))`，注释写明「done 路由不等快照写完，回流记账最终一致」。
- 测试（`src/pw-bet-video-snapshot.test.ts` 改造+新增）：既有断言改 await；新增——①b23.tv 短链经 mock resolver 解出 BV → 正常写 doc；②resolver 返回 null → 跳过+warn；③直接含 BV 的 url 断言 resolver **未被调用**（零网络）；④同一短链第二次走缓存（mock 计数不增）。

## 质量约束与验收终态

- `PATH="$HOME/.local/node/bin:$PATH" npm run verify` 全绿（含新测试）。
- 真实冒烟（主代理）：Node 侧对 BET-01 真实短链 https://b23.tv/ep1 调一次 defaultResolveShortLink → 返回合法 BV 号（真实网络，不写库）；真实库 snapshot 跑一次（fetchStat 返回 null 口径）→ 短链不再报「无法解析」。
- 不碰 frontend/、public/；不 commit。

---

## 验收记录

**验收通过（2026-08-10）**；实现=DeepSeek 子代理，复核/verify/真实冒烟=主代理亲做。

- verify（主代理亲跑）：**285/285 全绿**（282+3 新），selfcheck ok，前端 build 成功。
- 真实网络冒烟（主代理亲跑，只读不写库）：真实分享短链 `https://b23.tv/fXKXJjF` → **BV1K2Gq6SEan**（跟随跳转命中）；杂链 → null（零网络）；BET-01 的 `https://b23.tv/ep1` → null——**该链接是死链**（跳到 bangumi 错误页，疑似早期狗食手工占位），返回 null 是正确行为不是缺陷。
- 真实库 snapshot（fetchStat=null 口径）：written=0、skipped=1（ep1 经真实解析尝试后如实跳过）、errors=0，零污染。
- 复核要点：async 改造 + 进程内缓存 + 只对 b23.tv 前缀发请求 + resolveShortLink 可注入，全部与规格一致；corpus 钩子 fire-and-forget（done 路由不等快照，最终一致）注释到位；测试 12 例（新增 mock resolver 写路径/零网络/缓存命中）。
- 留痕：用户挂真实 B站分享短链（App「分享→复制链接」产物）即可自动记账；ep1 死链若要清理属数据卫生，另行决定。
- 不 commit；frontend/、public/ 零手工改动（verify 构建产物除外）。
