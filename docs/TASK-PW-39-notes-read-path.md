# TASK-PW-39 笔记只读连接与读取函数

- 日期：2026-08-08
- 状态：已拍板（2026-08-08，用户「继续」；域修订 v0.6 同步生效，见 `docs/REQUIREMENT-DOMAINS.md`）
- 主需求域：实践与数据回收
- 业务接口：提供笔记读取（新接口，供 PW-40 回顾捞取 / PW-41 第七屏消费）
- 数据真值源：Memos SQLite 库（默认 `~/Library/Application Support/memos/memos_prod.db`）——**只读消费，镇纸不建表、不复制、不改写**
- 质量约束与验收终态：见末节「质量约束与验收终态」
- 批次：`docs/TASK-PW-38-batch.md`（PW-38 已验收，本刀为其后续）

## 这刀是干什么的（白话）

让镇纸能"看见"你 Memos 里的笔记：能按时间翻、能用关键词搜、能算出你每天记了几条（画热力图用）、能给你几个词让它捞相关旧笔记（回顾用）。**镇纸对 Memos 库永远只读，一个字都不会改。** 这刀只做地基不出界面——界面是 PW-41 第七屏的事。

## 怎么算好（白话）

- 拿你真实的 Memos 库问："最近记了什么"「落座」能搜到那条验收笔记、今天的记录数 ≥1、给"镇纸"这个词能捞出它。
- Memos 没启动或库文件不在时，读取方只说实话（"连不上笔记库"），不崩、不编造。
- 读取前后对 Memos 库文件做哈希对账，逐字节一致。

---

以下给干活的看，可以跳过。

## 已核验的库事实（2026-08-08 对真实 v0.30.0 库实测）

- 表 `memo`：`id INTEGER PK AUTOINCREMENT`、`uid TEXT UNIQUE NOT NULL`、`creator_id`、`created_ts/updated_ts BIGINT`（Unix 秒）、`row_status TEXT CHECK IN ('NORMAL','ARCHIVED') DEFAULT 'NORMAL'`、`content TEXT`、`visibility TEXT CHECK IN ('PUBLIC','PROTECTED','PRIVATE')`、`pinned INTEGER 0|1`、`payload TEXT JSON`。
- **标签在 `payload` JSON 的 `$.tags` 数组**（建 memo 时从 content 的 `#标签` 解析），无独立 tags 列。
- 库为 **WAL 模式**：`immutable=1` 打开看不见 WAL 里的新数据（实测 `.schema` 都查不到表）——**只读连接必须 `mode=ro`/SQLITE_OPEN_READONLY，禁止 immutable**。
- 回链格式：`{base}/memos/{uid}`（v0.30 web 路由 `memos/:uid`，源码核验）；base 默认 `http://127.0.0.1:5230`。
- 归档（`row_status='ARCHIVED'`）默认不返回；只读方不需要归档开关。

## 交付清单

新文件 `src/pw-notes.ts`，导出：

1. `resolvePwNotesDbPath(): string`——`process.env.MEMOS_DB_PATH?.trim()` 优先，缺省 `~/Library/Application Support/memos/memos_prod.db`（`~` 展开到 homedir）。
2. `readPwNotesList(opts?: { limit?: number; offset?: number }): PwNote[]`——`row_status='NORMAL'`、`created_ts` 倒序；limit 默认 50 上限 200。
3. `searchPwNotes(query: string, opts?: { limit?: number }): PwNote[]`——`content LIKE '%?%'` 参数化绑定（用户输入里的 `%`/`_` 需 ESCAPE 转义）；空串返回空数组不查库。
4. `getPwNotesDailyStats(opts?: { days?: number }): PwNoteDayStat[]`——按**本地时区**按日聚合（`date(created_ts,'unixepoch','localtime')`），返回连续日期段（缺日补 `count:0`，热力图直接可画）；days 默认 365 上限 370。
5. `queryPwNotesByKeywords(keywords: string[], opts?: { limit?: number }): PwNoteHit[]`——多关键词 LIKE OR，按命中关键词数降序、同数按 created_ts 倒序；空关键词数组返回空数组。供 PW-40 回顾捞取。
6. `getPwNotesStatus(): { ok: boolean; path: string; error?: string }`——库文件是否存在、只读打开是否成功；供 PW-41 空态与排障。

类型：

```ts
type PwNote = {
  uid: string;
  content: string;
  createdAt: string;   // ISO 本地时间
  updatedAt: string;
  visibility: "PUBLIC" | "PROTECTED" | "PRIVATE";
  pinned: boolean;
  tags: string[];      // json_extract(payload,'$.tags')，解析失败按 []
  url: string;         // {MEMOS_BASE_URL 默认 http://127.0.0.1:5230}/memos/{uid}
};
type PwNoteDayStat = { date: string; count: number }; // date=YYYY-MM-DD 本地
type PwNoteHit = PwNote & { matchedKeywords: string[] };
```

## 纪律与边界

- **零写入**：只读打开（node:sqlite `DatabaseSync` 的 readOnly 能力；先核实本机 node24 的 `readOnly` 选项可用性，不可用则用 `file:...?mode=ro` URI 方式——以实测为准并在代码注释留痕）。每次调用即开即关（或进程级单例只读连接，二选一，注释说明理由）。
- **禁止 immutable**（WAL 新数据不可见，见上）。
- **不加 HTTP 路由、不改 main.ts、不动 frontend/**：读函数库留 PW-40/41 集成挂载（沿 PW-19 先例）。
- 调用方错误处理：库文件不存在/打开失败 → 函数抛出带路径信息的 Error；`getPwNotesStatus` 兜底返回 `ok:false`，其余函数不吞错。
- 不改写 Memos 库任何字节；不引入新依赖；不 commit。

## 测试

新文件 `src/pw-notes.test.ts`（node:test，登记进 package.json）：

1. tmp 目录建模拟库（memo 表，schema 照抄上节实测）→ 五函数逐个断言（含分页/倒序/标签解析/pinned 布尔化/回链格式）。
2. **WAL 可见性回归**：用可写连接向模拟库插入一行（不 checkpoint），随后只读连接必须能读到——钉死 immutable 陷阱。
3. **零写入断言**：测试前后对模拟库文件（含 -wal）做 sha256 对账一致；再用只读连接尝试 `CREATE TABLE` 必须抛错。
4. 搜索转义：query 含 `100%` 不炸且语义正确；空 query 返回 []。
5. 按日统计：跨本地午夜的两条记录落在不同日期；缺日补 0。
6. `getPwNotesStatus`：路径不存在 → `ok:false` 且 error 含路径。
7. `MEMOS_DB_PATH` 环境变量覆盖生效。

## 质量约束与验收终态

- `PATH="$HOME/.local/node/bin:$PATH" npm run verify` 全绿（含新测试）。
- 真实库冒烟（主代理执行）：对真实 Memos 库跑脚本——list 含 PW-38 冒烟条、search("落座") 命中、dailyStats 今天 ≥1、queryByKeywords(["镇纸"]) 命中、url 形如 `http://127.0.0.1:5230/memos/{uid}`；冒烟前后真实库文件（含 -wal/-shm）sha256 逐字节一致。
- 模拟库测试全绿；main.ts、frontend/ 零改动。

## 验收记录

**验收通过（2026-08-08）**；实现=DeepSeek 子代理，复核/verify/真实库冒烟=主代理亲做。完整证据链（改动清单、217/217 verify、真实库五项冒烟输出、零写入对账——db+wal 逐字节一致、四处小偏差申报）见批次文档 `docs/TASK-PW-38-batch.md` 验收记录节，不重复抄录。补注：只读连接会写瞬时 -shm 读标记（SQLite WAL 协议固有行为），零写入对账口径=db+wal，已写进模块注释。
