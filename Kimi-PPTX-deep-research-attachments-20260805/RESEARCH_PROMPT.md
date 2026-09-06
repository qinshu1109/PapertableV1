# 深度研究任务：寻找 Kimi PPTD 到高保真、可编辑 PPTX 的开源整体方案

你是一名熟悉 ECMA-376 / Office Open XML、PowerPoint 渲染差异、字体与图表打包、TypeScript/Node.js 文档生成生态的资深研究工程师。请基于证据仓库中的源码和实测材料做深度研究，不要只给库名列表，也不要建议继续为每个 deck 手工修坐标、颜色或 XML。

## 1. 目标

对同一个已经生成的 Kimi Slides 产物，把 Kimi 的 PPTD（deck 配置 + 10 个 page YAML）转换为 PPTX，使自研导出与 kimi.com 官网“去编辑 -> 导出 -> 下载”的原生 PPTX 逐页视觉一致：

- 每页同尺寸 PNG 的像素差异率 `<= 0.5%`；
- 文本、图片、图表、表格、图标、任意形状、线条全部存在，位置和样式正确；
- 元素仍是可编辑的 PowerPoint 语义对象，不能把整页或大块内容栅格化成图片来绕过验收；
- 连续 3 个不同主题、每个固定 10 页的 deck 必须串行通过。不得并发生成多个 PPT；Deck 2 未通过前不得开始 Deck 3。

研究问题不是“怎样让当前样本再低几个百分点”，而是：是否已有开源项目、现成 OOXML 引擎或可组合架构，可以从 Kimi PPTD 泛化生成接近 Kimi 官方导出器的 PPTX；若没有，最小可行的替代路径是什么。

## 2. 当前实现与证据

本任务唯一的项目证据仓库是：

**https://github.com/qinshu1109/zjubao**

开始分析前，先访问仓库的 [`packages/`](https://github.com/qinshu1109/zjubao/tree/main/packages) 目录并下载 `Kimi-PPTX-deep-research-core-20260805.zip`。需要检查真实 PPTX、OOXML package 或 office-kit round-trip 文件时，再下载 `Kimi-PPTX-deep-research-full-20260805.zip`。报告中引用项目现状、指标或样本时，必须注明该证据仓库中的具体文件路径；开源项目自身能力仍必须回到其官方仓库、源码、issue 和许可证复核，不能把本证据仓库的初筛结论当成第三方项目的权威证明。

证据包中的关键文件：

- `source/docs/kimi-web-api.md`：已验证接口结论。
- `source/api/services/pptd2pptx.ts`：当前基于 PptxGenJS 的 PPTD 转换器。
- `source/api/kimiDriver/real.ts`：`GetPPTDDetail` 获取 PPTD/pages；`OKCService/BatchGetOutputImages` 获取图片 URL。
- `source/api/services/pptdElements/*`：渐变、富文本、Font Awesome 6 solid 图标等直接辅助实现。
- `evidence/deck1/pptd/get-pptd-detail.json`：真实 10 页 PPTD 输入样本。
- `evidence/deck1/diff/*`、`evidence/deck2/diff/*`：逐页指标、热区图、contact sheet 和元素清单。
- 完整证据包另含两套官网/自研 PPTX 及 office-kit round-trip PPTX，可直接解压检查 OOXML。若研究环境无法下载或解压仓库中的证据包，必须明确报告这一限制，不能假装已经检查附件。

已知优先差距类型曾包括：table、非 rect 形状（如 rightArrow）、line、渐变 fill、`fas:*` 图标、富文本 run 级样式（加粗/超链接）、字体嵌入。针对这些逐类补过以后：

- Deck 1（数据中心液冷与能耗优化，10 页）最终逐页差异率：
  `0.3342%, 0.0000%, 0.0408%, 0.0000%, 0.1145%, 0.0000%, 0.0865%, 0.2519%, 0.2056%, 0.1962%`，全页达标。
- Deck 2（城市轨道交通站点客流与节能改造，10 页）首轮逐页差异率：
  `15.5126%, 6.4349%, 14.7651%, 12.6639%, 12.9606%, 12.4602%, 8.1432%, 5.4933%, 11.2440%, 9.0308%`，全页远未达标。

Deck 1 达标而 Deck 2 全面失败，说明问题在导出器表达模型、布局/文本测量、主题/字体、OOXML 语义或官方专用元数据这一层，不应继续做逐 deck 硬编码补丁。

## 3. 已做的候选验证（请复核，不要直接照抄）

1. `@office-kit/pptx@0.12.0`：将 Deck 2 官网 PPTX 读入后不编辑直接保存，逐页渲染差异约 `0.0596%–0.1947%`，说明现有 OOXML 的 round-trip 保真较好；但目前观察到从零 authoring 的关键缺口，包括新文本框缺少便利的多 run 写入、solid fill alpha API 不完整、真实字体 blob authoring 能力不明确。它不能仅凭 round-trip 就被判定为 PPTD authoring 方案。
2. `office-open/pptx`：对 Deck 2 官网文件执行 load/parse/generate 时因 `Unsupported chart type: undefined` 失败。
3. PPTist：公开导出链仍使用 PptxGenJS，不能自然跨越当前引擎上限。
4. Presenton：公开 exporter 仓库疑似只有 release/二进制，需核验源代码与许可证是否真实可用。
5. dom-to-pptx：依赖 DOM/浏览器并以 PptxGenJS 为底层。
6. PptxAutomizer：偏模板修改/合并，不是从 PPTD 从零 authoring 的完整引擎。
7. 从官网 PPTX OOXML 与前端行为推断，Kimi 原生导出器是专用 `kimiDesign` OOXML writer，使用自定义命名空间 `https://kimi-design.msh.team/pptd/2026`，不是公开 PptxGenJS。请把这一点当待验证推断，不要声称已找到其开源源码。

## 4. 必须重点研究的方向

请对下列路线做源码级、许可证级和 PoC 级判断：

### A. 可从零 authoring 的开源 OOXML/PPTX 引擎

调查 `office-kit/pptx`、ONLYOFFICE DesktopEditors/core、LibreOffice UNO/ODF/PPTX export、Apache POI/XSLF、Open XML SDK、docx4j/pptx4j、Aspose 的开源替代物，以及其他仍维护的项目。重点不是“能生成 pptx”，而是是否能表达并稳定输出：

- 文本 run、段落、行距、baseline、字符间距、超链接、自动适应；
- 任意 preset/freeform shape、连接线、端点/箭头、旋转、flip；
- solid/gradient fill、透明度、阴影；
- 原生表格与合并单元格；
- 原生 chart、embedded workbook、数据标签、主题颜色；
- SVG/图标；
- 字体嵌入、fallback 与 PowerPoint/LibreOffice 一致的文本测量；
- slide master/layout/theme、关系文件、扩展命名空间；
- 在 Node/TypeScript 后端中可部署，或能作为边车/CLI 安全调用。

### B. 模板/骨架驱动的 OOXML 克隆

研究能否以一份 Kimi 官网 PPTX 作为结构骨架，保留 master/theme/font/extension/relationship，只替换每页内容；或者把官方 PPTX 的对象级 OOXML 与 PPTD 建立可泛化映射。必须说明：

- 首份模板从哪里合法获得；
- 不同主题、不同布局、不同图表时是否仍泛化；
- 是否会依赖每个新 deck 的官网 PPTX（若依赖，则不能成为自研导出方案）；
- 对新增/删除元素和关系 ID 的正确处理；
- 是否属于合理工程方案而非逐 deck XML 补丁。

### C. 直接构建 Kimi 风格 OOXML writer

如果没有成熟引擎，请给出最小闭环设计：PPTD AST -> 规范化中间表示 -> OOXML package writer。指出应复用哪些开源组件，哪些部分必须自研，并估算到“连续 3 个不同 10 页 deck 每页 <=0.5%”的工作量与主要不确定性。优先解释文本测量、字体嵌入、图表、主题/master、渐变/alpha 和 Kimi 扩展元数据。

### D. 从官方链路获得原生 PPTX

在不修改 kimi.com、不绕过 UI 提交/导出、不破坏现有公共 API 的前提下，研究是否存在合法、稳定、已验证的官方导出复用路径。区分“研究/对照下载”与“产品自研导出”；不要建议依赖私有未授权接口作为长期架构。

## 5. 研究证据标准

- 优先项目官方仓库、官方文档、源代码、issue/PR、发布记录和许可证原文；技术结论要附可点击的精确链接，尽量链接到文件/行、issue 或文档段落。
- 只看 README 不足以认定能力。对最有希望的 2–3 个项目，要定位具体 writer/serializer/font/chart/text-layout 实现。
- 核验最近维护状态、许可证、Node 兼容性、是否需要新增依赖/外部进程、部署体积和 macOS/Linux 可用性。
- 明确区分：已验证事实、源码推断、尚待 PoC。
- 不允许把“读取并保存已有 PPTX 的保真”偷换成“从 PPTD 从零生成的保真”。
- 不允许以整页截图、SVG 全页、PDF 转图等方式满足像素指标，因为元素必须可编辑。

## 6. 要求执行的最小 PoC

对评分最高的 1–2 个开源路线，尽可能使用附件中的真实 Deck 1 PPTD 或 Deck 2 官网 PPTX 做最小 PoC。PoC 至少覆盖：

- 一个多 run 富文本框；
- 一个透明或渐变填充；
- 一条带箭头/端点样式的线；
- 一个非矩形 shape；
- 一个表格；
- 一个 chart 或明确证明 chart authoring 不支持；
- 字体/主题/master 的保存或生成证据。

若只能做 round-trip，请明确标注，不能算 authoring PoC。给出可复现命令、代码片段、输出文件结构/渲染结果和失败日志。若研究环境不能执行附件，至少给出一套本地可运行的 PoC 脚本设计及判定方法。

## 7. 工程硬边界

- 最终落地只允许修改 `api/services/pptd2pptx.ts`、`api/kimiDriver/real.ts` 及其新建直接辅助文件，例如 `api/services/pptdElements/*`。
- 不改前端、不改数据库结构、不改公共 API 签名、不改 kimi.com。
- 除非确有必要，不新增 npm 依赖；若建议新增，必须说明许可证、大小、原生依赖/进程和不可替代原因。
- TypeScript 构建必须通过：`PATH="$HOME/.local/node/bin:$PATH" npx tsc -b`。
- 任务提交与官网导出必须经 ego-lite 浏览器真实 UI，不能直接调用接口绕过 UI。
- 不做 git commit/push。
- 同一类路线连续 3 轮无实质量化进展，或确认表达能力不足时应停止，报告失败，不得伪造通过。

## 8. 评分与决策表（必须给出）

请为每个认真调查的候选给出 0–5 分和证据：

| 维度 | 权重 |
|---|---:|
| 从 PPTD 从零 authoring 能力 | 20% |
| 文本布局/字体/富文本保真 | 20% |
| shape/line/fill/table/chart 完整性 | 20% |
| 跨主题泛化潜力 | 15% |
| 可编辑语义与 OOXML 合规性 | 10% |
| Node/后端集成和部署成本 | 5% |
| 维护活跃度、文档、测试 | 5% |
| 许可证/商业使用风险 | 5% |

给出明确淘汰门槛：如果缺失核心 authoring 能力、只能栅格化、许可证不允许、源码不可得，直接淘汰，不要靠其他分数补偿。

## 9. 最终报告格式

按以下结构输出：

1. **执行摘要**：一句话首选路线、一句备选路线、一句是否存在可直接替换的现成项目。
2. **根因判断**：为什么 Deck 1 能过而 Deck 2 全面失败；结合附件 OOXML/PPTD/diff 给出证据。
3. **候选矩阵**：项目、许可证、维护状态、authoring/round-trip、关键能力、缺口、评分、精确来源链接。
4. **Top 1–2 源码深挖**：定位核心 writer、text layout、font、chart、theme/master 实现。
5. **PoC 结果**：命令、代码、量化指标、失败信息；明确是 authoring 还是 round-trip。
6. **推荐架构**：输入、IR、writer、字体/资源、渲染验证、缓存/隔离边界；说明哪些现有文件需要改。
7. **两周以内最小验证计划**：每一步有退出条件和量化门槛，先用 Deck 2，达标后才串行做 Deck 3。
8. **风险与停止条件**：明确何时承认现有开源路线无法达到 0.5%，以及替代路径（如更换引擎/边车或调整产品目标）。
9. **最终结论分级**：`可直接采用 / 需少量适配 / 需重大自研 / 目标在当前硬边界下不可行`，只能选一个主结论并给出置信度。

请直面“<=0.5% 像素差异”这一极严指标：它可能受到 PowerPoint/LibreOffice 渲染器、操作系统字体栅格、PDF 转 PNG 的 1px rounding 影响。不要因此擅自放宽指标；应提出如何固定渲染环境、剥离工具噪声并验证真正的内容差异。
