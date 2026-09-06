# TASK-PW-75 飞书速记「像个坑 → 出稿」（王冠链路同进程扩展，14 天冻结前唯一一刀）

- 状态：代码与单测已完成（分支 `feat/pw-75-relay-draft-offer`，22/22 绿）；待本机部署 + 真机三项终验
- 主需求域：内容生产（速记入口 → B 站图文草稿）
- 业务接口：无（域内）。入口 = 飞书 p2p 文本（现有 `pw-feishu-relay`）；笔记写 = Memos 官方 HTTP API（不变）；旧记录读 = MemOS MCP `search_memories` + Memos REST `content.contains`（只读）；草稿生成 = 用户自有中转站 OpenAI-compatible `chat/completions`；4317、镇纸库、PW-72、PW-73、dsh 零改动
- 数据真值源：笔记 = Memos（不变）；「发了几条」的真值 = Memos 中带 `#发布` 标签的速记；`feishu-relay-draft-state.json`（与配置同目录）只是派生状态簿（当日 offer 计数、唯一待出稿项、静音截止、周计数副本），可删可重建；草稿**不进 Memos**，只回到会话
- 质量约束与验收终态：`draftOffer` 缺省 false 且每条消息重读（改配置即生效、不重启）；关闭时中继行为与 PW-52 字节级一致；开启时任何分支失败都不得影响「已记」；每日 offer ≤2、`别问了` 静音 7 天、offer 12 小时有效、错过不重发不计数；`node --test src/pw-feishu-relay.test.ts src/pw-feishu-draft.test.ts` 全绿；真机三项终验通过（§5）

## 这刀是干什么的

你在飞书里给机器人发一句速记，它照旧回「已记」。多出来的只有一件事：如果这句话里有报错码、模型名、"限流""超时""踩坑"这类词，回执后面多一行——

> 已记 · 像个坑，回 1 出一条图文草稿

你回一个 `1`，它先说「收到，出稿中」，半分钟内把一条 B 站动态/专栏格式的草稿发回来：标题、现象、原因、解法、一句话、相关旧记录（从你过去的速记和 MemOS 里捞的同类记录，带日期）、配图建议、三个标签。原文没有的东西一律写成【补】，不编。发不发、改不改、贴到哪，你在 B 站 App 里手工做。

你发了之后，把 B 站链接当一条速记发回来，它回「已记 · 本周第 N 条」。这一行就是全部大盘。

你不回 1，什么都不会发生：不提醒、不计未读、下一条像坑的速记来了旧的 offer 就作废。每天最多问你两次。说一句「别问了」，七天不问。

## 怎么算好

1. 发一条普通速记（"今天想到一个选题"）→ 只回「已记」，和以前一模一样。
2. 发一条像坑的速记（"gemini 又 429 了，配额页显示没超，切 vertex 端点才好"）→ 回「已记 · 像个坑，回 1 出一条图文草稿」。Memos 里这条照常带 `#速记`。
3. 回 `1` → 先回「收到，出稿中（约半分钟）」，再回一条纯文本草稿，草稿里有「标题：」开头的行，有「相关旧记录」段，不该有的信息处写着【补】。
4. 再回一次 `1` → 回「没有待出稿的坑（offer 只在 12 小时内有效）」，不再出稿。
5. 发「别问了」→ 回「好，7 天内不再问」；此后像坑的速记只回「已记」。
6. 发一条含 B 站链接的速记 → 回「已记 · 本周第 1 条」；Memos 里这条带 `#速记` 和 `#发布` 两个标签。
7. 把 `feishu-relay.json` 里 `draftOffer` 改成 `false`（不重启）→ 下一条像坑的速记只回「已记」，`1` 被当成普通速记写进 Memos。这就是 5 秒回滚。
8. 把中转站的 key 改错再回 `1` → 回「草稿没出来：模型 401：…」，不装成功。

---

## 以下给干活的看，可以跳过

### 1. 改动面

| 文件 | 性质 | 说明 |
|---|---|---|
| `src/pw-feishu-draft.ts` | 新增 | 配置读取（fail-closed）、关键词判定、B 站链接识别、状态簿、提示词、两个来源的检索与解析、模型调用、`DraftHook` 两个挂点、MemOS MCP 调用（SDK 动态 import） |
| `src/pw-feishu-draft.test.ts` | 新增 | 18 个用例，全部用假 fetch / 假 MCP，不碰网络 |
| `src/pw-feishu-relay.ts` | 改 4 处 | import 一行；`handleMessage` 加可选参数 `draft`；去重之后插入 `intercept`；写入内容拼 `memoSuffix`；回执用 `afterWritten` 的返回覆盖「已记」；`main()` 构造 `DraftHook`；启动日志带 `draft` 摘要 |
| `package.json` | 改 1 处 | `test` 脚本追加 `src/pw-feishu-draft.test.ts` |

王冠文件 `pw-feishu-relay.ts` 的既有导出（`buildMemoContent` / `SeenIds` / `loadRelayConfig` / `extractReceiveMessage`）签名与行为不变，PW-52 的 4 个测试原样通过。

### 2. 消息处理顺序（改后）

```text
类型过滤(p2p+text) → 取文本 → message_id 去重(seen)
  → PW-75 intercept：
      draftOffer=false            → null，继续往下（"1"/「别问了」当普通速记）
      text == 「别问了」            → 静音 7 天，回「好，7 天内不再问」，不写 Memos，结束
      text ∈ {"1","出稿"} 且有待出稿 → 回 ACK；捞旧记录 → 调模型 → 回草稿 / 回「草稿没出来：…」；不写 Memos，结束
      text ∈ {"1","出稿"} 且无待出稿 → 回「没有待出稿的坑…」，不写 Memos，结束
  → 写 Memos（content = 原文 + \n#速记 [+ \n#发布 若含 B 站链接且开关开]）
      失败 → 回「没记上：…」，结束（不变）
  → PW-75 afterWritten：
      含 B 站链接                  → 周计数 +1，回「已记 · 本周第 N 条」
      命中关键词 且 未静音 且 当日<2  → 记 offer（覆盖旧的），回「已记 · 像个坑，回 1 出一条图文草稿」
      其他                        → null → 回「已记」
```

两个挂点内部全部 try/catch；任何异常 → 一行 JSON 日志 → 返回 null → 中继按「已记」走。状态簿写盘失败同样只降级不外抛（有测试）。

### 3. 配置（`~/Library/Application Support/Papertable/feishu-relay.json`，0600 不变）

在现有四字段之外追加。**只有 `draftOffer: true` 且 `draftModel` 三字段齐才开启**，其余任何情况一律关闭。

```json
{
  "appId": "cli_a946…",
  "appSecret": "…",
  "memosUrl": "http://127.0.0.1:5230",
  "memosToken": "…",
  "defaultTag": "速记",

  "draftOffer": false,
  "draftModel": {
    "baseUrl": "https://你的中转站/v1",
    "apiKey": "sk-…",
    "model": "你选的模型"
  },
  "memosMcpUrl": "http://127.0.0.1:8002/mcp",
  "draftMemosCubeIds": ["index"],
  "draftKeywords": ["429","500","502","503","504","超时","timeout","报错","限流","踩坑","翻车","挂了","error","exception","rate limit","不可用"],
  "draftMaxOffersPerDay": 2,
  "draftOfferTtlHours": 12,
  "draftMuteWord": "别问了",
  "draftMuteDays": 7,
  "draftTriggerWords": ["1", "出稿"]
}
```

- `draftOffer`：总开关。每条消息到来时重读文件，改完即生效。
- `draftModel`：OpenAI-compatible；`baseUrl` 末尾斜杠自动去掉；60 秒超时；非流式。
- `memosMcpUrl`：可省略。省略则不查 MemOS，只用 Memos REST 关键词检索；MemOS 不可用时草稿照出、尾注说明。
- `draftMemosCubeIds`：最多两个。缺省 `["index"]`（MemOS 路由规则允许的兜底库）。**建议改成速记实际所在的业务 Cube**（在 `http://127.0.0.1:8002/ui/` 知识库页看 id），否则语义召回可能只命中索引项。Memos REST 检索始终在，保证 595 条速记一定可被关键词命中。
- 其余字段都有缺省，非法值（0、负数、非整数、空数组）回落缺省，不报错。

### 4. 部署（本机，预计 15 分钟）

**前置检查 0——同一 App ID 只能有一个长连接消费者。** 你已确认 relay（`cli_a946`）与 ZCode 飞书 bot 是同一个 App。飞书 WS 长连接对同一应用的多个连接做分发，不是广播：ZCode 的 bot 若仍 `enabled`，会分走一部分消息（包括你回的 `1`），中继看不见，且 PW-73 让 ZCode 也写 Memos，存在双写。部署前把 `~/.zcode/v2/bot-config.json` 里飞书 bot 置 `enabled: false`（或迁到另一个 App），然后连发 3 条测试速记，`~/Library/Logs/Papertable/feishu-relay.log` 必须出现 3 条 `"event":"written"`。少一条就是还有第二个消费者。

```bash
cd /Users/qinshu/Documents/papertableV1
git fetch origin feat/pw-75-relay-draft-offer
git checkout feat/pw-75-relay-draft-offer          # 或合进你日常跑的分支
PATH="$HOME/.local/node/bin:$PATH" node --test src/pw-feishu-relay.test.ts src/pw-feishu-draft.test.ts   # 22 passed

# 1) 先改配置但保持 draftOffer=false，重启中继，确认王冠无感
vi "$HOME/Library/Application Support/Papertable/feishu-relay.json"    # 加 draft* 字段，draftOffer 留 false
launchctl kickstart -k gui/$(id -u)/com.qinshu.papertable.feishu-relay
tail -n 3 "$HOME/Library/Logs/Papertable/feishu-relay.log"               # started 行应含 "draft":{"draftOffer":false,...}
# 手机发一条速记 → 「已记」

# 2) 打开开关（不重启）
#    draftOffer: true → 保存
# 手机发「测试 429」→ 应回带 offer 的「已记」；回 1 → ACK + 草稿
```

**矿工定时器核对**（TASK-PW-74 已摘掉 `runMinerTick`，本刀不改 4317；只确认无残余唤醒）：

```bash
grep -n 'runMinerTick\|runPwMinerScheduledTick' src/main.ts          # 只应见注释行
sqlite3 "$HOME/Library/Application Support/Papertable/papertable.sqlite3" \
  "select max(created_at) from pw_miner_runs"                         # 应停在 2026-08-28，7 天后再查一次仍不变
```

### 5. 真机三项终验（过了才算 TASK 完成）

1. 像坑的速记 → 带 offer 的「已记」；Memos 出现该条 `#速记`。
2. 回 `1` → 两条回复（ACK、草稿）；草稿含「标题：」与「相关旧记录」；`feishu-relay.log` 依次出现 `draft_requested` → `draft_related` → `draft_sent`。
3. `draftOffer` 改 `false` 不重启 → 下一条像坑的速记只回「已记」；回 `1` 被写进 Memos 成一条内容为 `1` 的速记（这是正确的：关闭即完全透明）。删掉那条即可。

### 6. 日志事件（stdout 一行一 JSON，与 PW-52 同一日志文件）

`draft_offer`（keyword, offers_today）· `draft_offer_skipped`（reason: daily_cap | muted）· `draft_requested` · `draft_no_pending` · `draft_related`（count, unavailable[]）· `draft_sent`（chars）· `draft_failed`（error）· `draft_muted`（until）· `published_recorded`（url, week_count）· `draft_intercept_error` / `draft_after_written_error`（内部异常，均已吞掉）。

### 7. 回滚

- 5 秒回滚：`draftOffer` 改 `false`，保存。不重启。
- 彻底回滚：`git checkout <原分支>` + `launchctl kickstart -k …feishu-relay`。删除 `feishu-relay-draft-state.json` 可选。
- 配置里 `draft*` 字段留着无害：`draftOffer` 不为 `true` 时全部被忽略。

### 8. 14 天冷冻期规则（从真机终验通过当天起）

- 允许改：`feishu-relay.json` 里 `draft*` 字段（关键词表、每日上限、静音词）。
- 不允许：任何 `src/` 改动、任何新 TASK、任何 agent-bridge 简报、任何 4317/dsh/纸桌改动。
- 期间唯一记录动作：把 B 站链接发回机器人。
- 第 14 天对照：

| 观察 | 结论 | 下一步 |
|---|---|---|
| `#发布` ≥ 3 条 | 环活了 | 谈质量与节奏，不谈系统 |
| `draft_offer` 有、`draft_requested` ≈ 0 | offer 是噪音或关键词口径错 | 只调关键词表，或关 offer |
| `draft_sent` 有、`#发布` = 0 | 卡在发布 | 这是人的事，不再盖楼 |

### 9. 明确不做

- 不推送、不定时、不 digest、不做锁屏通知（PW-72 冻结）。
- 不写 Memos 除 `#发布` 标签；草稿不入库。
- 不做 B 站自动发布、不做数据回流、不看播放量。
- 不动 4317 任何路由与表；不动 dsh；不动纸桌。
- 不引入新依赖（`@modelcontextprotocol/sdk` 已是根依赖）；不新建进程、不新建长连接。
- 不在 MemOS 里新建 Cube、不 `add_memory`。
