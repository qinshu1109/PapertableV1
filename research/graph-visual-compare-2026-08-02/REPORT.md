# 关系图第一阶段视觉对标：Explore vs Papertable

- 日期：2026-08-02 · 工具：Ego Lite（ego-browser）任务空间 #4
- Explore：https://ai.explore.poker/chat（登录态复用，隔离测试项目 `project_1785699848575`，未命名）
- Papertable：http://127.0.0.1:4317/（隔离测试项目「图谱对标A」id=87b51797）
- 窗口：两边同窗口 1694×926、缩放 1:1、暖色主题、左侧栏均收起为图标条、图栏均展开（225px @ x=1469）

## 总判断：结构接近但观感不同

布局骨架（图栏宽度、节点尺寸、间距、三向方向）逐项量化一致；观感差异集中在
路径节点渲染（黑实心 vs 米色圈+珊瑚环）、卡片区构图（1207px 宽+叠影 vs 880px 实底）、
关系入口（纯图标 vs 图标+中文标签）。

## 可比状态

两边拓扑（均为 5 节点）：

| 节点 | Explore | Papertable |
|---|---|---|
| 根卡 | 知识关系图工具生态系统横向对比（根） | 根卡 |
| 深挖 | 卡片关系决定上下文继承机制（parentId→根） | 深挖卡（deep_dive→根） |
| 改道 | 认知负荷视角下的…（branchingSourceId→根） | 改道卡（reroute→根） |
| 发散 | 关系图的替代形态（parallelSourceId→根） | 发散卡（diverge→根） |
| 额外同层 | 跨领域应用案例（parallelSourceId→根） | 发散二卡（diverge→根） |

已声明偏差：
1. Explore 根卡多了一轮问答（搭建时一条发散消息误入根卡，根标题随之改写）；拓扑不受影响。
2. Explore 根卡首轮回答失败（"AI 服务没有返回有效内容"）；Papertable 各卡内容完整。
3. Papertable 侧有 Explore 没有的元素：判决簿 FAB、改道墓碑提示条（已跳过）、卡片底部带中文标签的关系按钮。
4. 动态验证用的临时卡（Explore 发散3、Papertable 发散三）均已删除，拓扑恢复 5 节点。

## 对比表

| 编号 | 场景 | Explore 画面 | Papertable 画面 | 视觉差异 | 用户影响 | 优先级 | 截图 |
|---|---|---|---|---|---|---|---|
| 1 | 基准态（当前=改道） | s1-exp-current-branch | s1b-pt-current-branch | 卡片宽 1207 vs 880；EXP 卡片半透明透出底层标题，PT 实底 | 整体气质第一眼就不同 | 高 | shots/s1-* |
| 2 | 当前=根卡 | s2-exp-current-root | s2c-pt-current-root-settled | 构图骨架一致（居中卡+右图栏+底输入条），宽度与底部按钮不同 | 骨架"像"，细节"不像" | 高 | shots/s2-* |
| 3 | 当前=深挖（路径态） | s3-exp-current-deep | s3b-pt-current-deep-settled | **路径节点：EXP 黑色实心 #000；PT 米色+深棕描边 3px+珊瑚环**；EXP 仅深挖链染黑，PT 三类关系都染 | 看图找"我从哪来"的感受完全不同 | 高 | shots/s3-*，choice-a-* |
| 4 | 悬停节点 | s4-exp-hover | s4-pt-hover | EXP 悬停=亮珊瑚粗光圈，醒目；PT=淡桃色光晕，含蓄；两边都有底部标题提示 | 悬停反馈强度差一档 | 中 | shots/s4-* |
| 5 | 图栏折叠 | 无此能力（图栏无折叠控件） | s5-pt-graph-narrow（225→56px 窄条，节点成边缘细条） | PT 多一个折叠态；窄条下节点几乎不可读 | PT 功能更多但窄态信息量低 | 中 | shots/s5-* |
| 6 | 节点切换动态 | d1-exp-before/mid/after | d1-pt-before/mid/after | 两边都先切图后切卡、卡片交叉淡入淡出；EXP 约 350ms 且旧卡标题会短暂透出，PT 淡切更快 | 动态节奏接近 | 中 | shots/d1-* |
| 7 | 新节点出现 | d3-exp-create-* | d3-pt-create2-* | 两边新节点都瞬时出现在最终位置、无生长动画，旧树让位；**创建流程不同**：EXP 一键即建空卡，PT 先弹"发散到哪个方向"对话框再确认 | 观感一致、操作手感不同 | 中 | shots/d3-* |
| 8 | 拖拽/平移/归位 | d2-exp-dragged（cursor-grab 自由拖拽，4.5s 内未自动归位） | d2-pt-*（小树下画布刚好撑满，无法滚动平移） | EXP 随时可拖；PT 小图无可拖 | 大图浏览能力待大拓扑再验 | 中 | shots/d2-* |
| 9 | 关系入口按钮 | choice-c-exp（三个纯图标浮于卡片下方） | choice-c-pt（图标+中文标签+方向文案） | EXP 抽象图标；PT 三重编码（图标+文字+方向） | 可发现性 PT 更强，气质 EXP 更简 | 高 | shots/choice-c-* |
| 10 | 缩放 | 未见缩放能力 | 未见缩放能力 | 一致（都没有） | — | 低 | — |
| 11 | 未读态 | 有 isUnread 字段，未触发 | 有未读圆点设计（accent 色），未触发 | 未确认 | — | 低 | — |

## 已确认一致（量化）

- 图栏：225px 宽、x=1469、全高，两边一致；左栏均可收成图标条。
- 节点半径：普通 14、根 16.8（Explore 实测 r=16.8 与 Papertable `ROOT_R=16.8` 一致）。
- 间距：同层水平 36px、层级垂直 80px，两边实测一致。
- 方向语义：深挖向上、发散同层向右、改道同层向左，两边一致。
- 默认节点：米填充 #F2EADB、灰描边 rgb(160,150,145) 2px，逐色一致。
- 新节点：瞬时出现在最终位置、旧树整体让位，两边一致。
- 节点提示：悬停/切换都有底部标题+消息数提示。
- 连线避让：同层相隔节点时用向下圆弧绕行，两边一致（见 s4 裁剪）。

## 尚未确认

1. 未读态两边的实际视觉（未触发到）。
2. EXP 拖拽后是否有更长的归位定时（4.5s 内未归位；未等更久）。
3. 大拓扑（>10 节点）下的重排稳定性、PT 图栏滚动/3 秒归位（5 节点画布恰好撑满无法滚动）。
4. EXP 卡片切换的精确毫秒（录屏级精度未测；既往调研为 350ms）。
5. Papertable 会话中两次渲染线程卡死是否与 mermaid 渲染有关（影响操作，疑似性能问题，未定性）。

## 最影响观感的三个差异

1. **路径节点渲染**（场景 3）：EXP 把"你从哪来"染成一串黑实心圆，视觉重量极大；Papertable 是米色圈+深棕描边+珊瑚环，轻且层次多。这是"像不像 Explore"的第一眼差异。且规则不同：EXP 只在深挖祖先链染黑（改道/发散的当前路径不染），Papertable 三类关系的路径都染。
2. **卡片区构图**（场景 1/2）：EXP 卡片 1207px 宽、圆角更大、卡体半透明能透出底下卡标题（叠纸感强）；Papertable 880px、实底、无叠影。同一窗口下 EXP 更"满"，PT 更"收"。
3. **关系入口按钮**（场景 9）：EXP 三个无文字抽象图标浮在卡片下缘；Papertable 是图标+中文标签+方向文案（改道 向左分岔/深挖 沿路径向下/发散 向右展开）。

## 截图清单（research/graph-visual-compare-2026-08-02/shots/）

- 预检：precheck-explore.png / precheck-papertable.png
- 基准：s1-exp-current-branch.png / s1-pt-current-branch.png / s1b-pt-current-branch.png
- 根卡：s2-exp-current-root.png / s2-pt-current-root.png / s2b-pt-current-root.png（变化中帧）/ s2c-pt-current-root-settled.png
- 深挖：s3-exp-current-deep.png / s3-pt-current-deep.png（变化中帧）/ s3b-pt-current-deep-settled.png
- 悬停：s4-exp-hover.png / s4-pt-hover.png
- 窄条：s5-pt-graph-narrow.png
- 切换动态：d1-exp-before/mid/after.png、d1-pt-before/mid/after.png
- 拖拽：d2-exp-drag-before/dragged/after-wait.png、d2-pt-scroll-before.png、d2-pt-scrolled3.png、d2-pt-after-wait3.png、d2-pt-reloaded.png
- 新建动态：d3-exp-create-before/mid/after.png、d3-pt-create-before.png、d3-pt-create-mid.png、d3-pt-create-after.png、d3-pt-dialog-filled.png、d3-pt-create2-mid.png、d3-pt-create2-after.png
- 搭建过程：exp-*.png（exp-root-sent2、exp-subcard-created、exp-branch-from-root、exp-topology-final 等）、pt-*.png（pt-testproject、pt-card-menu2 等）
- 选择卡素材：choice-a-exp/pt.png、choice-b-exp/pt.png、choice-c-exp/pt.png

## 视觉选择卡（待用户决策）

### 卡 1：路径节点渲染
- Explore：shots/choice-a-exp.png（当前=深挖时，根节点黑色实心）
- Papertable：shots/choice-a-pt.png（根节点米色+深棕描边+珊瑚环）
- 差别一句话：EXP 用黑实心强调"来路"，PT 用圈环强调"来路"。
- 待选：A 采用 Explore / B 保留 Papertable / C 混合处理

### 卡 2：卡片区构图
- Explore：shots/choice-b-exp.png（1207px 宽、半透明叠影）
- Papertable：shots/choice-b-pt.png（880px、实底无叠影）
- 差别一句话：EXP 宽卡+透出底层标题的叠纸感，PT 窄卡实底更克制。
- 待选：A 采用 Explore / B 保留 Papertable / C 混合处理

### 卡 3：关系入口按钮
- Explore：shots/choice-c-exp.png（三个纯图标）
- Papertable：shots/choice-c-pt.png（图标+中文标签+方向文案）
- 差别一句话：EXP 极简抽象图标，PT 文字明说三种关系与方向。
- 待选：A 采用 Explore / B 保留 Papertable / C 混合处理
