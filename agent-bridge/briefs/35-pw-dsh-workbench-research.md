# 简报 35：镇纸 Paperweight 六屏内嵌 DeepSeek Harness —— 实现路径调研

日期：2026-08-16 ｜ 主控：kimi（herdr w4:p1）｜ 类型：调研（不写实现代码）

## 背景与目标（用户原话意图）

用户要把镇纸 Paperweight 的六个屏——**押注台、金子墓碑库、协作台、观众声音、运维数据源、大盘笔记**——做成插件**内嵌进 DeepSeek Harness（dsh）**。最终形态：

- **镇纸 Paperweight = 大屏展示层**（继续是现在的推式大屏，127.0.0.1:4317）
- **dsh = 协作层**：一个"自媒体工作台"，六个屏在 dsh web UI 里以插件面板形态出现，人可以在 dsh 会话里 @引用/斜杠命令把这些屏的数据带进上下文，让 agent 直接基于镇纸数据协作

**参考样板**（必须先看）：B 站 UP 主 oil欧呦 的 "Oil Creator" 自媒体工作台演示，视频在 `/Users/qinshu/Documents/40945321038-1-192.mp4`（3.5 分钟，960x720）。主控已看过，要点：

1. dsh web 左栏自定义两个 tab：「会话」+「内容」。「内容」tab 是插件面板：列表展示本地目录映射进来的内容条目（缩略图、状态：待发布/未开始/已发布）
2. 点条目开**中间栏详情面板**：概览/视频/脚本/字幕/文章 五个 tab；概览页有各平台（小红书/B站/抖音/视频号/公众号）发布状态与播放/赞/评论数据（走本机能力，非官方 API）
3. 会话输入框 **@引用内容条目**、斜杠命令 `/current-content` 把"当前打开的条目"注入上下文；agent 能新建条目、改脚本、调 skill 生成封面/字幕
4. 全套 = dsh 插件 + skills；模型用 DeepSeek-V4-Flash 就够，重活都在工具里
5. 品牌定制（logo/标题/slogan/主题色）也是插件做的（dsh-theme 类）

## 任务 A（派给 dsh 窗口 w4:p9）：dsh 插件技术机制调研

目标：搞清楚"Oil Creator 那种左栏 tab + 详情面板 + @引用 + 斜杠命令"在 dsh 插件体系里**具体怎么实现**，产出可落地的技术地图。

必查材料：
- dsh 源码：`/Users/qinshu/Documents/ChatGPT/MemOS/deepseek-harness`（client 插件机制、sidebar/panel 扩展点、slash command、上下文注入）
- 已有插件样板：`/Users/qinshu/Documents/papertableV1/dsh-plugins/`（dsh-wechat、dsh-scheduled-prompt 等 5 个自研插件）
- 社区参考：zhu1090093659/dsh-web-ui（npm `@linxin666/dsh-web-ui-all`，侧栏页面注册）和 mexiaosqwq/dsh-web-mobile（纯 client 插件，已装在 `~/.dsh-source/profiles/web`，node_modules 里可直接读源码）
- 镇纸数据源：papertableV1 的 SQLite（pt_cards/pt_edges/pt_verdicts/pw_gold_mirror 等表）与 Paperweight harness（127.0.0.1:4317）的 HTTP 接口

要回答的问题：
1. dsh web client 插件注册**左栏新 tab/页面**的 API 是什么（文件、导出名、注册点）？详情面板/中间栏怎么做？
2. @引用、斜杠命令、把面板状态注入会话上下文，各走什么扩展点？
3. 插件内读外部 SQLite / 调本机 HTTP 服务的可行路径（node 半插件 + client 半插件怎么分工，参照 dsh-wechat 的协议驱动形态）
4. 给六个屏逐一给出"插件形态建议"（纯 client / client+node / node 工具 + skill）
5. 已知坑：github: 安装与 pnpm isolated 布局、launchd web 用 `DSH_HOME=~/.dsh-source`（装插件必须带这个环境变量）

产出：`agent-bridge/out/35a-dsh-plugin-tech-map.md`——每个问题给结论 + 源码证据（文件:行）+ 最小代码骨架示意（示意即可，不实现）。

## 任务 B（派给 Claude 窗口 w4:pB）：产品映射与分期方案

目标：把六个屏映射成 dsh 插件体系下的产品方案。先看视频（路径如上，可用抽帧方式看）和镇纸现状。

必查材料：
- 视频 `/Users/qinshu/Documents/40945321038-1-192.mp4`
- 镇纸代码与设计：`/Users/qinshu/Documents/papertableV1`（六屏现状、PRD、pw.css 纸感设计规范）
- 镇纸硬约束：AI 摆证据不给结论、判断权永远在人；Memos 只读纪律；纸感浅色调性（不要深色数据板）

要回答的问题：
1. 六个屏各自在 dsh 里的**角色重定义**：哪些是"看"（大盘/运维数据源）、哪些是"判"（押注台/金子墓碑）、哪些是"协作"（协作台/观众声音/笔记）——在 dsh 会话协作场景下分别是什么交互？
2. 哪些数据面板上屏、哪些做成 agent 工具/skill（如"查押注中列表""查金子"做成工具比面板更有用？）
3. 镇纸大屏（4317）与 dsh 面板的分工：什么留在展示层、什么进协作层、数据怎么保持单一事实源
4. 分期方案：P0 先做哪一两个屏能最快验证闭环（建议押注台+金子墓碑，因为数据已持久化且协作价值最高），给出每期验收标准
5. 与 Oil Creator 的差异：他做的是"内容发布管理"，镇纸做的是"决策判断协作"——不能照抄，差异点列清楚

产出：`agent-bridge/out/35b-pw-dsh-product-mapping.md`——大白话开头（业务意图+验收标准），技术细节可跳过。

## 通用纪律（两窗口都要遵守）

- 这是调研单：**不写实现代码、不改任何 profile 配置、不动生产数据**。代码骨架只许出现在产出文档里。
- 进度写 `agent-bridge/out/35x-*-progress.md`（x=a/b），卡住先写进度文件再继续。
- **完工必须主动回报**：完成后立刻执行
  `herdr agent prompt w4:p1 "简报35 完工：<A或B>：一句话结论 + 产出路径 + 有无阻塞"`
  （w4:p1 是主控 kimi 窗格；若报 agent_not_found 就先 `herdr pane list` 核 kimi 窗格号再发）
- 禁止"写完不用找我"。
