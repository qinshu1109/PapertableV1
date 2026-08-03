/**
 * 开发验收页：/dev-test.html（仅 dev server，不进生产构建）。
 * 渲染固定验收样例，覆盖：混行标题 + §N 引用角标、GFM 表格、
 * Mermaid 三种图、坏 Mermaid 回退、未闭合围栏（流式中间态）。
 */
import { createRoot } from 'react-dom/client';
import { MarkdownView } from './lib/MarkdownView';
import './styles/base.css';

const SAMPLES: { name: string; content: string }[] = [
  {
    name: '① 混行 ## 标题 + §N 引用',
    content:
      '首场默认忽略 GMV / 加购 / UV 转化这类电商口径 [[source:chunk-a1]]。出现真实问题、追问或明确反应即视为拿到反馈，不设数量门槛 [[source:chunk-b2]]。## 7.商业边界已经钉死：直播免费默认只做到本地能跑通，正式上线、支付、备案、投流、长期运维必须收费，不装公益全包 [[source:chunk-a1]]；观众点子可开源，用来攒开发者口碑。## 8.材料里明确列为未决、且比缺 SOP 更重要的方向包括：基建诚实度 vs 必须出门拿信号、收藏价值线 vs 关注涨粉线的主次。\n\n普通段落，含**粗体**、`行内代码` 与概念词标注测试。\n\n- 列表项一\n- 列表项二\n\n1. 有序一\n2. 有序二\n\n> 引用块：橙左竖条 callout 样式。',
  },
  {
    name: '② GFM 表格（5 列，卡片内横滑）',
    content:
      '下面是一张五列表格：\n\n| 直播类型 | 形式描述 | 优势 | 风险 | 适配阶段 |\n|---|---|---|---|---|\n| 帮你用AI解决问题 | 弹幕/连麦提需求，现场演示解决 | 极高互动，留存好 | 翻车概率高 | 冷启动 |\n| AI工具横评 | 同一任务喂给多个工具，当场对比 | 新奇感强，适合拉新 | 结论容易得罪人 | 增长期 |\n| 30分钟学会XX | 结构化教学某一个 AI 工具/Prompt 技巧 | 适合带货课程 | 同质化严重 | 变现期 |\n| AI+行业应用 | 针对特定职业演示 AI 如何提效 | 精准圈层，转化率高 | 准备成本高 | 增长期 |\n| 实时创作秀 | 用 AI 现场完成一个完整作品 | 视觉震撼，传播性强 | 依赖模型状态 | 冷启动 |',
  },
  {
    name: '③ Mermaid：flowchart / sequenceDiagram / erDiagram',
    content:
      '流程图：\n\n```mermaid\nflowchart TD\n  A[观众提需求] --> B{现场可行?}\n  B -->|能| C[直播现场做]\n  B -->|不能| D[记入待办]\n  C --> E[当场验收]\n```\n\n时序图：\n\n```mermaid\nsequenceDiagram\n  participant U as 观众\n  participant H as 主播\n  participant M as 模型\n  U->>H: 弹幕提需求\n  H->>M: 现场调用\n  M-->>H: 生成结果\n  H-->>U: 当场验收\n```\n\nER 图：\n\n```mermaid\nerDiagram\n  CARD ||--o{ TURN : contains\n  CARD ||--o| CARD_EDGE : \"source of\"\n  TURN ||--o{ CITATION : verifies\n```',
  },
  {
    name: '④ 坏 Mermaid 回退（应保留源码 + 错误提示）',
    content: '下面这个图语法是坏的：\n\n```mermaid\nflowchart TD\n  A[未闭合的节点 --> B\n  C ---\n```\n\n同一条回答的后续内容必须正常渲染。',
  },
  {
    name: '⑤ 未闭合围栏（流式中间态，应显示为普通代码块）',
    content: '回答输出到一半：\n\n```mermaid\nflowchart TD\n  A[正在生成] --> B[尚未闭合]',
  },
];

function App() {
  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '32px 20px' }} className="md">
      {SAMPLES.map((s) => (
        <section key={s.name} style={{ marginBottom: 48, borderBottom: '1px solid var(--line)', paddingBottom: 24 }}>
          <h2 className="md-h2">{s.name}</h2>
          <MarkdownView
            content={s.content}
            concepts={['概念词标注测试']}
            onConcept={() => {}}
            onCite={() => {}}
          />
        </section>
      ))}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
