# 已验证线索与待研究候选

以下是研究起点，不是要求研究模型接受的结论。请以仓库源码、issue、许可证和 PoC 复核。

## 已验证/实测

- 当前 PptxGenJS 转换器可以针对某个样本逐类修到 `<=0.5%`，但第二主题 10 页仍为 `5.49%–15.51%`，说明局部补丁没有跨主题泛化。
- `@office-kit/pptx@0.12.0` 对 Deck 2 官网文件做无编辑 round-trip，10 页差异 `0.0596%–0.1947%`；这只证明保留已有 OOXML 的能力。
- `office-open/pptx` 在 Deck 2 官网文件的 load/parse/generate 路径报错：`Unsupported chart type: undefined`。
- Kimi 官网 PPTX 包含 `kimiDesign` 相关扩展和命名空间 `https://kimi-design.msh.team/pptd/2026`。据此推断其为专用 OOXML writer；尚未发现可确认的公开源码。

## 公开项目入口

- PptxGenJS: https://github.com/gitbrent/PptxGenJS
- office-kit/pptx: https://github.com/office-kit/pptx
- office-open: https://github.com/DemoMacro/office-open
- PPTist: https://github.com/pipipi-pikachu/PPTist
- Presenton: https://github.com/presenton/presenton
- Presenton exporter: https://github.com/presenton/presenton-export
- dom-to-pptx: https://github.com/atharva9167j/dom-to-pptx
- PptxAutomizer: https://github.com/singerla/pptx-automizer
- ONLYOFFICE organization: https://github.com/ONLYOFFICE
- ONLYOFFICE DesktopEditors: https://github.com/ONLYOFFICE/DesktopEditors

## 候选初筛假设

| 候选 | 当前判断 | 必须继续验证的问题 |
|---|---|---|
| PptxGenJS | 当前基线，已暴露跨主题上限 | 是输入映射问题还是 writer/布局模型上限 |
| office-kit/pptx | round-trip 很强，authoring 待证 | 多 run、alpha、字体、chart、master/theme 的从零生成 |
| office-open | 真实复杂图表样本失败 | chart 类型覆盖、错误恢复、维护状态 |
| PPTist | 底层仍是 PptxGenJS | 是否有额外 OOXML 后处理可复用 |
| Presenton exporter | 源码/许可证可用性存疑 | exporter 真正源码、底层库、商业使用条件 |
| dom-to-pptx | DOM + PptxGenJS | 是否只是另一输入层，无法解决 writer 上限 |
| PptxAutomizer | 模板操作工具 | 能否作为保留 Kimi master/theme 的局部组件 |
| ONLYOFFICE/LibreOffice | 完整 office 引擎但集成重 | headless authoring API、部署体积、许可证、确定性 |

## 解释限制

- 不要把 round-trip 保真等同于 authoring 保真。
- 不要把“能打开/能导出”当作像素级一致。
- 不要建议整页图片替代，因为验收要求文本、表格、图表和形状可编辑。
- 不要把私有、无授权、随时变化的 kimi.com 内部接口当长期产品方案。
