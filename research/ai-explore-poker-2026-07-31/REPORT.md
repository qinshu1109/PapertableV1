# Explore 卡片交互实测报告

实测时间：2026 年 7 月 31 日  
实测页面：https://ai.explore.poker/chat  
实测环境：内置浏览器，1152 × 788，中文界面，Warm（温暖）主题  
实测现场：新建了一个本地“未命名”项目，共造出 6 张正式卡；没有擅自删除

先说最重要的结论：它的“叠”是真正的卡片导航。当前卡是一整张正着的纸，父卡和更早的祖先卡留在后面，逐层缩小、向左歪、露出纸边。露出的纸边本身能点，点哪一层就回哪一层，不只是做装饰。

## 一、卡片的“叠”

### 用户看到的是什么样

- 只有一张卡时，卡在页面偏左中间，实测约 740 × 590，圆角约 24。
- 开出新卡后，新卡整张压在最前面；父卡不是消失，而是在后面露出上边、左边和一小段下边。
- 它不是两个浏览器窗口，也不是两张卡并排，而是同一页面里的一沓纸。
- 紧挨着的父卡比当前卡约缩小 4%，向左歪约 5 度，透明一点；从画面上看，当前卡相对父卡向右下压了约 15～25 像素，差不多一指宽。
- 再深入一层，上一辈卡再多歪约 5 度、再缩一点。四层时能清楚看到一沓向左上散开的纸，不是只画两条假纸边。【图 30、31】

![四层卡片叠放](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/031-four-card-stack.png)

### 点哪里会发生什么

- 点最靠近当前卡的那层露边，会退回上一张；我连续点了三次，第四层 → 第三层 → 第二层 → 第一层，一次退一张。【图 36～38】
- 上边、左边、下边都能点，但必须点到真的露出来的纸；点在纸外的空白处不会返回。【图 26、27、28】
- 露得更外面的祖先卡也能直接点。我从四层状态点最外面那张纸，画面连续翻过中间卡，最后直接回到第一张。【图 32～34】
- 右侧关系图里的任意节点也能直接跳；点第四层节点，会直接展开四层卡堆。【图 35、35b】
- 单层切换大约半秒到一秒，会看到旧卡转动、缩小、淡下去，新卡滑到正面；跨多层时，中间几张会连续翻过去，大约一到一点五秒，不是瞬间硬切。【图 24、32、33】

![点关系图时的翻卡过程](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/024-graph-node-click-immediate.png)

### 没测出来

- 实测到四层；第五层以后是否继续按同样幅度散开，没有继续造卡测试。
- 不同窗口尺寸下，露边会不会自动缩小，没测出来。

## 二、临时卡片到正式卡片

### 临时卡长什么样

- AI 回答里的可展开词，是细点状下划线，不是按钮块；鼠标点词才开临时卡。【图 11、12】
- 临时卡第一次出现时在主卡右下区域，实测约 370 × 295，约半张正式卡大小。
- 临时卡有 16 左右的圆角、暖灰纸色、细边和明显的软阴影；它浮在主卡上，主卡没有被推走。
- 生成解释时，卡片中间是跳动的小圆点；内容出来后，卡内自己滚动。【图 13、14】
- 临时卡右上只有两个关键动作：橙色“双卡”图标把它变成正式卡，× 关闭。

![临时卡内容出来后的样子](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/014-temp-card-loaded.png)

### 能不能拖、能不能多开

- 能拖。我从临时卡顶部空白处按住，往左上拖了约 155 像素、110 像素，卡片完整跟过去并停在新位置。【图 15】
- 临时卡浮着时，后面的主卡仍能单独滚动；临时卡不跟着主卡正文跑。【图 17】
- 不能同时开好几张。我保留第一张临时卡，再点第二个下划线词，屏幕上仍然只有一个临时卡窗口；原内容被换掉，重新显示加载点，再装入第二个词的解释。【图 18、19】
- 点 ×，临时卡立即消失，主卡原位不动。【图 50、51】

![临时卡被拖到左上](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/015-temp-drag-test.png)

### 从临时卡变成正式卡

- 点右上橙色“双卡”图标。
- 临时小窗先消失，正面立刻出现一张空白的大卡；约 0.7 秒后，临时卡里的内容和自动生成的标题落进这张正式卡。【图 20、21、22】
- 新正式卡成为最前面的当前卡，原主卡退到后面、缩小、左歪、露边。
- 关系图同时增加一个正式节点；临时卡还没提升前，图上不增加节点。

![临时卡提升后的正式卡叠放](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/022-formal-card-stacked.png)

### 没测出来

- 临时卡能拖到页面多远、会不会被页面边缘拦住，没有把它拖到极限。
- 关闭后再次打开同一个词，是否永远复用旧解释，没有稳定测出来；本次重新点时重新出现了加载状态。

## 三、关系图

### 图在哪里、默认多大

- 本次登录打开项目后，关系图默认是一条贴右边、贯穿全高的宽栏，实测可见宽约 225 像素，约占屏幕五分之一。
- 点关系图空白处，宽栏会收成约 56 像素的窄条；再点一次恢复到约 225 像素。【图 42、43、44】
- 图没有单独的白底面板，后面一直是整页的暖米色纸面。
- 抓住图的空白处可以拖着看大图；我向左下拖后，整棵图跟着移动。【图 52】

![关系图宽栏状态](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/044-graph-reexpanded.png)

### 节点和线长什么样

- 普通节点是约 28 像素的空心圆：里面是页面同款米白，外圈是灰褐色。
- 当前卡是深棕色实心圆；根卡会多一圈淡橙色外圈；未读卡会在圆心出现橙色小点。
- 根卡或当前根卡会稍大，约 34 像素。
- 线很细，约 1.5 像素，暖棕色，从一头清楚、到另一头渐淡；没有箭头，没有虚线。
- 颜色不是按“继续追问、发散、分支”分的，而是按“普通、当前、根、未读”这些状态分的。

### 三种关系往哪长

这次从同一个根卡实造了三种关系，方向非常明确：

- 继续追问、普通子卡、由概念临时卡提升出来的正式卡：往上长，每层约隔 80 像素。
- 发散卡：从根卡向右长，约隔 36 像素。【图 39】
- 分支卡：从根卡向左长，约隔 36 像素。【图 41】

图会随着当前卡移动，让当前节点留在容易看到的位置，所以节点在屏幕上的绝对位置会动；但“追问在上、发散在右、分支在左”的相对方向不变。

![三种关系同时出现：上、右、左](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/041-branch-card-created.png)

### 点开时背景会不会变白

- 不会。
- 宽栏 225 像素和窄条 56 像素之间来回切换时，整页始终是同一个偏黄的暖米白；卡片外的淡纸面感觉没有断，也没有闪一下纯白。【图 42～44】
- 参考站没有把放大的图塞进一块白色大面板，这是你现在产品“放大就变白”最该对齐的地方。

### 没测出来

- 没找到独立的“全屏关系图”按钮；本次能确认的是 56 像素窄条和 225 像素宽栏两档。
- 滚轮能不能缩放节点大小，没有测出来；只确认了能抓住空白处拖动。
- 其他颜色主题下节点颜色是否改变，没有测；上面结论只针对 Warm 主题。

## 四、对话输入框

### 用户看到的是什么样

- 输入框不是贴死页面底边，而是悬在底部上方约 16 像素，是一整条有阴影的圆角纸条。
- 空白时约 62 像素高，圆角约 28；底色比正式卡再灰一点，边框和阴影与卡片同一家族。
- 宽度会跟可用空间走：左侧项目栏展开时实测约 670 像素；项目栏收起后约 839 像素。
- 从左到右依次是：当前模型下拉、联网地球、输入文字的主区域、回形针、发送箭头。
- 默认提示原文是：`探索一切...... (Enter = 换行) | (Ctrl+Enter = 发送)`

### 输入和发送

- 空白时发送箭头是灰的；只输入空格也仍然是灰的，不能发送。【图 4、45】
- 只要有正常文字，发送箭头就变成橙色可点。【图 5】
- Enter 只换行，不发送；我按完后文字变成两行，卡片没有建立。【图 6】
- Windows 键盘上的 Ctrl+Enter 才发送；按下后立即建立主卡并开始回答。【图 10】
- 五行时输入框向上长；十二行、二十行继续长并出现内部滚动条。【图 7～9】
- 八十行稳定后，整条输入框最高约 214 像素，能看到约 7 行，其余内容在框内滚动，不会继续把卡片顶没。【图 48】

![八十行时的输入框上限](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/048-eighty-line-settled.png)

## 五、整体观感

- 页面不是白色，是偏黄的奶油米白；正式卡比页面更灰、更像一张压在桌面上的纸，输入框再灰一点。
- 肉眼能看到很淡的暖纸雾感，但不是明显颗粒花纹；远看接近干净纸面，不像纯色白板。
- 正式卡的圆角约 24，边框是很淡的暖灰，阴影宽而软，主要落在左下和下方。
- 临时卡更小、圆角约 16；输入框更像胶囊，圆角约 28。
- 标题和正文是深棕色，不是纯黑；橙色只拿来点亮可操作按钮、根节点外圈和未读点，没有满屏铺色。
- 页面没有用粗直线把左栏、卡片区、关系图区硬切开。区域靠留白、卡片阴影、浮动按钮和宽度变化分开。
- 卡片正文里偶尔有很淡的细横线，但那只是内容内部的节奏，不是把整页切成格子。
- 普通用户的感觉是“在一张暖色桌面上翻一沓纸”，不是“在一个软件里开很多窗口”。

![整体暖纸观感](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/011-root-card-answer.png)

## 六、照抄清单

- 当前正式卡在 1152 × 788 画面里做成约 740 × 590，固定正着放在最前面。
- 每多一层祖先卡，就约缩小 4%、向左歪 5 度、透明到约九成，露出 15～25 像素纸边。
- 新卡视觉上要压在父卡右下方，让父卡同时露出上边、左边和一小段下边。
- 每一层真的露出来的纸都要能点，点最近一层退一步，点更外一层直接跳到那张。
- 透明空白处不能冒充纸边，只有实际看得见的纸面才响应返回。
- 单层翻卡做成约半秒到一秒的转动、缩小、淡出和滑入，跨多层时把中间卡连续翻过去。
- 关系图每个节点都能直达对应卡，并在跳转后把当前节点带回容易看到的位置。
- 临时卡做成约 370 × 295，默认浮在主卡右下，圆角约 16，带细边和软阴影。
- 临时卡顶部空白处能拖，右上只留“变正式卡”和“关闭”两个主动作。
- 同一时刻只保留一个临时卡；再点别的词，就在这张临时卡里换内容，不叠一桌小窗。
- 临时卡提升后，保留原解释，变成一整张正式卡压到父卡前面，同时在关系图加节点。
- 临时卡未提升前不进关系图，关闭也不留下空节点。
- 关系图宽栏做成约 225 像素、窄条约 56 像素，点空白在两档之间切换。
- 关系图背景始终透明地压在同一张暖米色纸面上，展开时绝不能换成纯白。
- 继续追问和概念展开往上长，发散往右长，分支往左长。
- 节点颜色按状态分，不按关系分：普通米白灰圈、当前深棕实心、根卡淡橙外圈、未读橙点。
- 连线用细暖棕线，从清楚渐淡，不加箭头，不加虚线。
- 关系图空白处允许抓住拖动，节点本身负责跳卡。
- 输入框悬在底部上方约 16 像素，空白高约 62，圆角约 28，跟随可用宽度伸缩。
- 输入框左边放模型和联网，中间放文字，右边放回形针和发送箭头。
- 提示文字直接写清 `Enter = 换行`、`Ctrl+Enter = 发送`，Windows 键盘就按 Ctrl+Enter。
- 空白和纯空格时发送键灰掉，有正常文字时发送箭头变橙。
- 多行输入向上长，最高约 214 像素、显示约 7 行，更多内容改为框内滚动。
- 页面用暖米白、灰米白和深棕三层明暗拉开区域，靠留白和阴影分区，不加生硬竖线。

## 完整截图取证索引

下面每一条都是“我点了什么 → 屏幕发生了什么”。失败点击也保留。

- [图 01：登录完成后的空项目页](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/001-login-complete.png)：接回登录后的页面 → 暖米色空页，没有现成项目。
- [图 02：展开左侧项目栏](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/002-sidebar-open.png)：点左上展开按钮 → 新建项目、本地项目、设置等文字全部展开。
- [图 03：新建本地项目](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/003-new-project-created.png)：点“新建项目” → 没有弹表单，直接创建“未命名”项目。
- [图 04：空输入框](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/004-empty-composer.png)：进入新项目 → 底部出现浮动输入条，发送箭头灰掉。
- [图 05：输入一行](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/005-one-line-send-active.png)：打一行正常文字 → 发送箭头变橙。
- [图 06：按 Enter](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/006-enter-newline.png)：按 Enter → 只换行，没有发送。
- [图 07：输入五行](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/007-five-line-composer.png)：填到五行 → 输入条向上长。
- [图 08：输入十二行](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/008-twelve-line-scroll.png)：填到十二行 → 继续变高，右侧出现内部滚动条。
- [图 09：输入二十行](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/009-twenty-line-max.png)：填到二十行 → 画面只显示前几行，其余在框内。
- [图 10：按 Ctrl+Enter](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/010-ctrl-enter-sent.png)：按 Windows 键盘 Ctrl+Enter → 建立主卡并开始回答。
- [图 11：主卡回答完成](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/011-root-card-answer.png)：等待回答完成 → 正式卡出现标题、正文、下划线概念和右侧关系点。
- [图 12：点“知识盲区”后的第一帧](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/012-term-click-immediate.png)：点下划线词 → 临时卡从右下浮出来。
- [图 13：临时卡加载](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/013-temp-card-open.png)：等待约半秒 → 小卡中间显示加载圆点。
- [图 14：临时卡内容完成](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/014-temp-card-loaded.png)：等待解释完成 → 小卡内部出现可滚动内容。
- [图 15：拖动临时卡](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/015-temp-drag-test.png)：按住临时卡顶部往左上拖 → 小卡完整移动并停住。
- [图 16：第一次尝试滚动父卡](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/016-parent-scrolled-temp-stays.png)：在最右薄条滚动 → 没滚到正文，临时卡不动。
- [图 17：在正文区滚动父卡](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/017-parent-scroll-behind-temp.png)：在主卡正文右侧滚动 → 后面的正文移动，临时卡仍停在原位。
- [图 18：点第二个概念](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/018-second-term-reuses-one-temp.png)：保留临时卡再点“主动回忆” → 仍只有一张小卡，内容清空重新加载。
- [图 19：第二个概念装入同一小卡](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/019-second-temp-replaces-first.png)：等待 → 同一张小卡里换成“主动回忆”的解释。
- [图 20：可提升状态](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/020-preview-ready-to-promote.png)：解释完成 → 右上橙色“双卡”按钮可点。
- [图 21：点提升按钮后的第一帧](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/021-promote-immediate.png)：点“双卡” → 临时卡消失，正面出现空白大卡，关系图加节点。
- [图 22：正式卡叠好](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/022-formal-card-stacked.png)：等待约 0.7 秒 → 标题和原解释进入正式卡，父卡露在后面。
- [图 23：点顶部露出的父卡](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/023-click-exposed-parent-edge.png)：点父卡上边 → 返回主卡。
- [图 24：点关系图子节点的第一帧](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/024-graph-node-click-immediate.png)：点子节点 → 多张卡出现转动、淡入淡出的过渡。
- [图 25：关系图跳到子卡](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/025-graph-jump-to-child.png)：等待 → 子卡回到正面，父卡在后。
- [图 26：点在左侧纸外](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/026-left-edge-outside-paper-no-effect.png)：点得太靠外 → 没碰到纸，页面不返回。
- [图 27：点左侧真正露出的纸](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/027-left-exposed-strip-returns.png)：向右挪到露出的父卡纸面 → 返回主卡。
- [图 28：点底部露出的纸](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/028-bottom-exposed-strip-returns.png)：点父卡下边 → 返回主卡。
- [图 29：创建第三层第一帧](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/029-third-card-immediate.png)：在子卡点新卡按钮 → 新卡滑到正面。
- [图 30：三层卡堆](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/030-three-card-stack.png)：等待 → 两层祖先纸边依次露出，关系图变三点。
- [图 31：四层卡堆](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/031-four-card-stack.png)：再点新卡 → 四张纸形成明显扇形卡堆。
- [图 32：点最外层祖先的第一帧](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/032-click-outermost-edge-immediate.png)：在四层时点最外纸边 → 开始跨层翻卡。
- [图 33：跨层返回的中间帧](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/033-direct-jump-intermediate.png)：过渡中 → 中间卡短暂成为正面。
- [图 34：直接回到第一张](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/034-direct-jump-root-settled.png)：过渡结束 → 第一张主卡到正面。
- [图 35：点关系图第四层的过渡](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/035-deepest-graph-jump-transition.png)：点最深节点 → 四层卡连续展开。
- [图 35b：第四层稳定](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/035b-deepest-card-settled.png)：等待 → 第四层稳定在最前。
- [图 36：退回第三层](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/036-step-back-to-third.png)：点最近露边一次 → 退一层。
- [图 37：退回第二层](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/037-step-back-to-child.png)：再点一次 → 再退一层。
- [图 38：退回第一层](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/038-step-back-to-root.png)：第三次点 → 回到主卡。
- [图 39：创建发散卡](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/039-divergent-card-created.png)：点发散按钮 → 新卡在前，关系图在根卡右边加点。
- [图 40：一次没有点中的露边](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/040-top-edge-miss-on-divergent.png)：点顶部一个看似露边的位置 → 仍在发散卡，说明要点到真实纸面。
- [图 40b：从关系图回根卡](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/040b-root-via-graph.png)：点根节点 → 直接回主卡。
- [图 41：创建分支卡](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/041-branch-card-created.png)：点分支按钮 → 新卡在前，关系图在根卡左边加点。
- [图 42：关系图开始收窄](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/042-graph-collapse-immediate.png)：点关系图空白 → 图栏开始向右收，卡片变宽。
- [图 43：关系图窄条](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/043-graph-collapsed.png)：等待 → 图栏只剩约 56 像素，背景仍是暖米色。
- [图 44：关系图恢复宽栏](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/044-graph-reexpanded.png)：再点窄条 → 恢复约 225 像素，背景没有变白。
- [图 45：只输入空格](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/045-whitespace-send-disabled.png)：输入三个空格 → 发送箭头仍然是灰的。
- [图 47：八十行还在长高](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/047-eighty-line-growing.png)：刚填入八十行 → 输入框正在向上展开。
- [图 48：八十行稳定后的上限](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/048-eighty-line-settled.png)：等待约 0.7 秒 → 高度停在约 214 像素，内部滚动。
- [图 49：输入框太高时点到被遮住的词](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/049-hidden-term-click-missed.png)：没先清空长文本就点词 → 词实际被输入框挡住，没有开临时卡。
- [图 50：清空后重新打开临时卡](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/050-preview-open-for-close-test.png)：清空输入框再点词 → 临时卡正常出现。
- [图 51：关闭临时卡](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/051-preview-closed.png)：点右上 × → 临时卡立即消失。
- [图 52：拖动关系图](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/052-graph-drag-pan.png)：抓住关系图空白往左下拖 → 整棵图跟着移动。
- [图 53：尝试点当前节点归位](/Users/qinshu/Documents/papertableV1/research/ai-explore-poker-2026-07-31/screenshots/053-current-node-click-collapses-graph.png)：点当前节点附近 → 图栏收窄；这一点没有重复验证，不作为正式交互结论。
