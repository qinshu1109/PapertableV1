# Kimi PPTX 视觉一致性：网页版 Deep Research 附件说明

## 上传顺序

1. 先上传 `Kimi-PPTX-deep-research-core-20260805.zip`，并把 `RESEARCH_PROMPT.md` 的全文粘贴到研究问题中。
2. 如果网页允许更大的附件或研究模型要求查看 OOXML 原件，再上传 `Kimi-PPTX-deep-research-full-20260805.zip`。完整包已经包含核心包内容，不必重复解压上传单个文件。
3. 若网页不接受 ZIP，解压核心包后优先上传：`RESEARCH_PROMPT.md`、`FINDINGS.md`、`source/`、两套 diff JSON/CSV、Deck 2 两张 contact sheet。

## 核心包包含什么

- 研究任务、验收标准、硬边界和强制输出格式。
- 当前 `pptd -> pptx` 转换器、Kimi driver、直接辅助文件和接口结论文档。
- Deck 1 的完整 PPTD 输入样本、最终逐页 diff、元素清单、热区图和 contact sheet。
- Deck 2 的失败逐页 diff、热区图和 contact sheet。
- 已验证的开源候选结论，以及 office-kit round-trip 指标。

## 完整包额外包含什么

- Deck 1：Kimi 官网 PPTX、自研 round-08 PPTX。
- Deck 2：Kimi 官网 PPTX、自研 round-01 PPTX。
- `@office-kit/pptx` 对 Deck 2 官网 PPTX 的无编辑 round-trip 文件。

## 重要解释边界

- office-kit 的结果只证明“读入现有官网 PPTX 后保存”能较好保留 OOXML，不证明它能从 PPTD 从零生成同等 PPTX。
- Deck 1 达标、Deck 2 跨主题失败，说明不能继续为单个 deck 做坐标或样式补丁；研究目标是寻找可泛化的整个导出层/OOXML 写入方案。
- Deck 2 本轮没有另存 `GetPPTDDetail` 原始响应；包内不伪造该证据。Deck 1 的完整响应用于说明 PPTD schema，Deck 2 的两份真实 PPTX 与逐页 diff 用于证明失败。

## 隐私与安全

包内未放入 `.env`、数据库、管理令牌、Cookie、Authorization、浏览器会话、手机号或原始字体目录。源代码中可能出现 `token`、`session` 等字段名，这是程序接口定义，不是实际凭据。

## 完整性

每个 ZIP 根目录中的 `SHA256SUMS.txt` 是包内文件校验值。外层 ZIP 的 SHA-256 在交付消息中提供。
