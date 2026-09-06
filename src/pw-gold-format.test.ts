import assert from "node:assert/strict";
import test from "node:test";
import {
  goldBody,
  goldSummary,
  goldTitle,
  normalizeHeadings,
  stripMd,
} from "./pw-gold-format.ts";

/** TASK-PW-57 验收冒烟回归锚点：真实库 pw_gold_mirror 三条文本逐字抄录（均为单行）。 */
const F1 = `# 这个提示词踩了哪些坑 ## 一、与项目事实冲突的地方 ### 坑 1：要求"不做拖拽平移、缩放"，与 Papertable 现有能力直接冲突 项目介绍明确记载，Papertable 的右侧关系图（自绘 SVG）"支持拖拽平移、缩放、折叠子树" 。`;
const F2 = `## 什么是「最小需求单元」 资料中对它的定义是：**最小需求单元分为业务功能、业务报表、业务数据、质量场景、业务接口五类需求单元** 。`;
const F3 = `# 用《有效需求分析》复盘：这轮开发踩了哪些坑，怎么调 ## 坑一：把"叠纸风"当需求本身，而不是当线索 书中说，方案级需求是用户想要的功能，从技术实现角度描述，通常不够可靠。`;

test("normalizeHeadings 把行内标题归一化为行首标题，C# 不误伤", () => {
  assert.equal(normalizeHeadings("# 甲 ## 乙 ### 丙"), "\n# 甲\n## 乙\n### 丙");
  assert.equal(normalizeHeadings("正文 C# 不误伤 ## 小节"), "正文 C# 不误伤\n## 小节");
  assert.equal(normalizeHeadings("C# 语言"), "C# 语言");
});

test("stripMd 剥掉各种 markdown 排版符号", () => {
  // 多标题：ATX 前导 # 全部剥掉
  assert.equal(stripMd("# 甲\n\n## 乙\n### 丙"), "甲 乙 丙");
  // 加粗 / 斜体（双标记先剥，避免 `**` 残半）
  assert.equal(stripMd("**粗** 与 __粗2__，还有 *斜* 和 _斜2_"), "粗 与 粗2，还有 斜 和 斜2");
  // 行内代码反引号
  assert.equal(stripMd("调用 `foo(1)` 即可"), "调用 foo(1) 即可");
  // 代码围栏：围栏行剥掉，内容作为正文保留
  assert.equal(stripMd("```ts\nconst x = 1;\n```"), "const x = 1;");
  // 链接留文字、图片留 alt
  assert.equal(stripMd("[看链接](https://x.com) 配 ![示意图](img.png)"), "看链接 配 示意图");
  // 引用前导 >
  assert.equal(stripMd("> 引用一句"), "引用一句");
  // 列表前导（- / * / 数字）
  assert.equal(stripMd("- 第一项\n* 第二项\n1. 第三项"), "第一项 第二项 第三项");
  // 连续空行折叠为单个空格
  assert.equal(stripMd("行一\n\n\n\n行二"), "行一 行二");
});

test("goldTitle 取第一个 ATX 标题，无标题取首行，超 40 字截断", () => {
  assert.equal(goldTitle("# 我是标题\n正文内容"), "我是标题");
  assert.equal(goldTitle("第一行就是正文\n第二行"), "第一行就是正文");
  // 标题里的行内排版也剥净
  assert.equal(goldTitle("# 用 **极低温** 做判断"), "用 极低温 做判断");
  const long = "# " + "很".repeat(45);
  assert.equal(goldTitle(long).length, 40);
  assert.equal(goldTitle(long), "很".repeat(40));
});

test("goldSummary 跳过标题行、剥净符号、超 120 字截断、空正文返回空串", () => {
  assert.equal(goldSummary("# 标题\n这是正文"), "这是正文");
  assert.equal(goldSummary("# 标题\n正文里有 **粗** 和 `code`"), "正文里有 粗 和 code");
  const body = "正".repeat(150);
  assert.equal(goldSummary("# 标题\n" + body).length, 120);
  assert.equal(goldSummary("# 只有标题"), "");
});

test("goldBody 归一化后标题记号均在行首（三条真实夹具）", () => {
  for (const fixture of [F1, F2, F3]) {
    const lines = goldBody(fixture).split("\n");
    for (const line of lines) {
      if (line.includes("#")) {
        assert.match(line, /^#{1,6}\s/);
      }
    }
  }
});

test("回归锚点：三条真实单行文本", () => {
  // 夹具 1：三个行内标题（#/##/###）归一化拆开，title/summary 都干净
  assert.equal(goldTitle(F1), "这个提示词踩了哪些坑");
  const s1 = goldSummary(F1);
  assert.ok(s1.startsWith("一、与项目事实冲突的地方"));
  assert.ok(!s1.includes("#"));
  assert.ok(!s1.includes("**"));

  // 夹具 2：真实文本整行只有一个行首 `## `，标题短语与正文粘连在同一标题行；
  // 在第一个位置 ≥4 的空白处切断：title 只留标题短语，粘连正文进摘要最前面
  assert.equal(goldTitle(F2), "什么是「最小需求单元」");
  const s2 = goldSummary(F2);
  assert.ok(s2.startsWith("资料中对它的定义是："));
  assert.ok(!s2.includes("#"));
  assert.ok(!s2.includes("**"));

  // 粘连切断边界：首空格位置 <4 不切（英文 `How to` 第一个空格在 3 位），整体保 40 字截断
  assert.equal(goldTitle("# How to 做某事 更多正文内容"), "How to 做某事 更多正文内容");
  const howToLong = goldTitle("# How to 做某事 " + "很".repeat(40));
  assert.ok(howToLong.startsWith("How to"));
  assert.equal(howToLong.length, 40);

  // 夹具 3：` ## ` 行内标题拆开，title 取首标题、摘要从坑一开始
  assert.equal(goldTitle(F3), "用《有效需求分析》复盘：这轮开发踩了哪些坑，怎么调");
  const s3 = goldSummary(F3);
  assert.ok(s3.startsWith("坑一："));
  assert.ok(!s3.includes("#"));
});
