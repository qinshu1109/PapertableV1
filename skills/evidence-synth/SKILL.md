---
name: evidence-synth
description: 镇纸「证据白名单」终局合成（TASK-PW-76 组件 B）。当用户在 IDE 里说"把 gemini/429 这个主题写成 B 站动态""按证据包出一条技术推文""给这个坑写个口播稿"时使用。从飞书多维表格按主题键拉「我的速记 + 外部证据」证据包，只用包内事实写稿，每句事实带 [E#]/[N#] 角标与真实 URL，通过 verify_draft 验真后回写「产出」表。不在飞书里跑；不联网补事实；不替用户决定发不发。
---

# evidence-synth：证据白名单终局合成

飞书中继负责把「速记 + 外部证据」留痕进多维表格；本 skill 负责在**用户主动要发内容的时刻**，把这些证据熔成一条可直接发布的稿。角色是裁缝：只裁剪、缝合、磨锋利，不添布料。

## 纪律（违反即返工）

- **只用包内事实。** 模型自己知道的任何数字、日期、版本、产品行为、人名，一律不得出现。不确定就不写。
- **句句有出处。** 每个事实性句子末尾带 `[E#]` 或 `[N#]`；引号里的字必须是该编号 `quote`/`title`/`text` 的逐字子串。
- **观点要标记。** 个人判断以「我的看法：」开头，数量不得多于事实句。
- **不联网。** 不调用搜索、不打开 URL 补内容。证据不够就回去让中继再搜，或者告诉用户"这个主题证据不足，不出稿"。
- **人定发不发。** 产出写回表里是"已写"，不是"已发"；只有用户给了发布链接才标"已发"。
- **不改表结构、不删记录、不碰中继配置。**

## 步骤

### 1. 拉证据包

```bash
node skills/evidence-synth/scripts/pull_pack.mjs gemini/429 --days 60 --max-evidence 12 --out /tmp/pack.json
```

- 主题键来自用户；不知道就问用户要，或让用户去多维表格「主题」表看一眼。
- `--days` 是外部证据的时效窗（T0 状态页事件不受此限）；`--max-evidence` 按热度分截断。
- 产出 `pack.json` 形状：

```json
{
  "topic": { "key": "gemini/429", "recordId": "rec…", "status": "观察" },
  "myNotes": [ { "id": "N1", "date": "2026-09-06", "text": "gemini 2.5 pro 429 配额页没超…【内部】…", "recordId": "rec…" } ],
  "evidence": [
    { "id": "E1", "tier": "T0", "source": "status", "title": "Vertex AI elevated errors", "url": "https://status.cloud.google.com/incidents/…", "publishedAt": "2026-09-05", "quote": "", "heat": 65, "why": "官方事件", "metrics": {}, "recordId": "rec…" },
    { "id": "E2", "tier": "T1", "source": "github", "title": "429 RESOURCE_EXHAUSTED despite quota headroom", "url": "https://github.com/…/issues/1234", "publishedAt": "2026-09-01", "quote": "Getting 429 with headroom", "heat": 72, "why": "同样报错", "metrics": { "comments": 41 }, "recordId": "rec…" }
  ],
  "rules": [ "…五条白名单规则…" ],
  "stats": { "notes": 2, "evidence": 5, "tiers": { "T0": 1, "T1": 3, "T2": 1 } }
}
```

**证据不足的判据**：`myNotes` 为空，或 `evidence` 里没有任何 T0/T1。满足其一 → 不出稿，告知用户"这个主题只有 X 条 T2 网页证据，没有一手事故或官方事件，建议等中继再搜或换主题"。

### 2. 写稿

先把 `pack.json` 完整读一遍。写作时遵守下面的协议与所选平台模板。写完保存为 `/tmp/draft.md`。

**证据白名单协议（写进你的工作记忆，不是给用户看的）**

1. 每句事实以 `[E#]` 或 `[N#]` 结尾；一句可带多个。
2. 引用原文用引号，且逐字来自该编号；宁可不引，不可改写。
3. 只允许三类句子：事实句（带角标）、观点句（「我的看法：」开头）、结构句（第一行标题/钩子，以及 ≤12 字且不含数字的分隔、行动号召）。标题免角标，但标题里的每个断言必须在正文里有带角标的句子支撑，且标题里的引号仍须逐字。
4. 时间只能写包内 `date`/`publishedAt` 的日期；不得推算"上周""三天前"之类相对时间，除非包里有今天的日期可算。
5. 正文末尾附脚注表：每个用到的编号一行 `[E#]: 标题 · 日期 · URL`。发布时脚注一起贴。

**平台模板**

| 平台 `--platform` | 长度 | 结构 | 风格 |
|---|---|---|---|
| `bilibili-dynamic` | ≤400 字 | 第一行一句钩子（现象 + 反常识点）；第二段我的现场（N#，引原句）；第三段外面的证据（E#，2~3 条，带日期）；第四段一句「我的看法：」；脚注表 | 第一人称、口语、直接；不用 emoji、不用 Markdown 加粗；不写"总结""希望有帮助" |
| `bilibili-article` | 800~1500 字 | 标题 ≤25 字；小标题 3~4 个（现象 / 排查 / 外面怎么说 / 我的看法）；每节 2~4 句；脚注表 | 可用 Markdown 小标题与代码块；报错原文放代码块并带 [E#]/[N#] |
| `x-thread` | 3~6 条，每条 ≤240 字符 | 第 1 条钩子 + 结论；中间每条一个证据（一条只引一个 E#，带短链原文）；最后一条「我的看法：」+ 反问 | 英文或中英混排按用户要求；每条独立可读；URL 放条末 |
| `video-script` | 60~90 秒口播（约 220~320 字） | 0~5s 钩子；5~25s 我踩的坑（N#）；25~60s 外面的证据（E#，说清来源与日期）；60~80s 我的看法；80~90s 一句行动号召 | 口语、短句；每段前标时间码；屏幕字卡建议单列一行「字卡：…」，字卡内容也必须带角标 |

一句好句子与坏句子：

```text
好：Google 状态页 2026-09-05 记了一次 Vertex AI 错误率升高 [E1]，同一周 GitHub 上有人报 "Getting 429 with headroom" [E2]。
坏：Google 最近出了不少问题，很多人都遇到了 429。            ← 无角标、"很多人""最近"是包外事实
坏：官方说是配额系统 bug 导致 [E1]。                           ← E1 原文没说 bug，属改写
```

### 3. 验真（必须跑，必须过）

```bash
node skills/evidence-synth/scripts/verify_draft.mjs --pack /tmp/pack.json --draft /tmp/draft.md
```

报告字段：`coverage`（事实句引用覆盖率，≥0.9）、`uncited`（无角标的句子）、`unknownRefs`（包里不存在的编号）、`misquotes`（引号内容不是逐字子串）、`deadUrls`（被引 URL 现在打不开）、`opinionRatioOk`。**`pass:false` 就改稿再跑**，最多改两轮；两轮仍不过 → 告知用户哪几句过不了、为什么，不要放宽标准出稿。离线环境可加 `--no-live` 跳过 URL 探活，但要告诉用户没探活。

### 4. 回写产出表

```bash
node skills/evidence-synth/scripts/write_back.mjs --pack /tmp/pack.json --draft /tmp/draft.md \
  --platform bilibili-dynamic --title "配额页说没超，429 照样来" --model "<你当前的模型名>"
# 用户发布后，再补一次发布链接：
node skills/evidence-synth/scripts/write_back.mjs --pack /tmp/pack.json --draft /tmp/draft.md \
  --platform bilibili-dynamic --title "…" --published-url https://t.bilibili.com/…
```

- 写入「产出」表一行：标题 / 正文 / 平台 / 主题键 / 引用证据（按正文里出现的 E# 自动关联）/ 引用速记 / 模型 / 时间 / 发布链接。
- 主题状态改「已写」；给了 `--published-url` 才改「已发」。
- 需要 `evidence.bitable.tables.outputs` 已配置；没配置脚本会明确报错，不要自己去建表。

### 5. 回报用户

三句话：什么写好了（平台、字数、用了几条证据）、验真结果（coverage 与是否全过）、等用户做什么（去平台贴、贴完把链接回给飞书机器人或这里）。不要复述正文。

## 配置来源

三个脚本都从 `~/Library/Application Support/Papertable/feishu-relay.json`（或环境变量 `FEISHU_RELAY_CONFIG` 指定的路径）读取 `appId / appSecret / evidence.bitable.*`。脚本不打印密钥；你也不要把这个文件的内容贴进对话。

## 明确不做

- 不在飞书会话里出稿；那是中继的事，中继只留痕。
- 不用多模型互锤、不做"发散—收敛"表演；证据在表里，写作是裁缝活。
- 不自动发布到任何平台；不抓播放数据。
- 不写 Memos、不写 MemOS；产出只进「产出」表。
