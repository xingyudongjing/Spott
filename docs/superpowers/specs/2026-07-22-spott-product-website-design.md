# Spott 产品下载官网与用户端视觉升级设计

日期：2026-07-22  
状态：方向已由产品所有者确认，三轮独立复核已完成，书面规格待产品所有者确认  
第一交付范围：产品下载官网首页、App Store 入口、真实 App 展示、三语与网页版入口  
后续连续范围：公开 Web、登录用户 Web、主办方 Web、iOS 用户端与跨端一致性

## 1. 目标

Spott 需要一个真正的产品官网，而不是把用户直接重定向到活动发现页。访问 `/` 的用户应在五秒内理解：

1. Spott 是面向日本城市生活的活动与持续社群产品；
2. 它提供 iPhone App，也能从 Web 浏览公开活动；
3. 用户能在参加前看清时间、地点、费用、语言、名额、主办方和安全边界；
4. 一次活动可以继续沉淀为长期社群关系；
5. 官方 App Store 下载入口在哪里。

官网必须高级、精致、美观，但不能以装饰代替产品事实。页面使用真实 App 界面、真实功能和真实状态；不得虚构评分、下载量、媒体报道、用户评价、活动库存或“已上架”状态。

这不是总目标的缩减。官网完成后，继续依次收口全部用户端代码：

1. 公开发现、城市、分类、活动、群组与主办方页面；
2. 登录、报名、候补、行程、通知、收藏、账户与钱包；
3. 创建活动、Host Studio、群组管理与洞察；
4. iOS 对应旅程、视觉、交互、三语、Dynamic Type 与 VoiceOver；
5. 跨端真实数据、恢复、安全、性能和最终验收。

## 2. 可证明的领先标准

Luma 和 Meetup 只作为能力及结果基线，不复制其视觉或受版权保护的表达。

- Luma 的基线是简洁活动页、快速报名、视觉主题、日历和移动端体验。
- Meetup 的基线是城市/兴趣发现、群组关系、附近活动和组织者入口。
- Spott 的差异是日本城市语义、三语同一产品、参加前决策信息、地址隐私、可信履约、活动后社群和 iPhone/Web 可恢复旅程。

本地视觉验收必须证明：

- 首屏只有一个主叙事和一个主下载动作，不出现模板化的徽章、假指标或卡片堆砌；
- App Store 下载和网页版体验在桌面与手机首屏都可达；
- 产品截图来自当前可运行 App，不是生成式 UI 或竞品截图；
- 简体中文、日语和英语保持同一层级、密度与信息完整度；
- 320、390、768、1024、1440 像素宽度无溢出、遮挡或不专业折叠；
- 键盘、屏幕阅读器、减少动态、200% 页面缩放和高对比度仍可使用；
- 首页关键内容以服务端渲染为主，避免为了装饰引入大体积客户端脚本；
- 在相同语言、相同浏览器、相同 `1440×900` 与 `390×844` 视口下，分别与 Luma、Meetup 当前公开首页并排复核；不混用桌面与手机截图，也不以不同语言密度制造优势；
- 三名未参与实现的复核者逐项检查品牌辨识、首屏理解、下载动作可发现性、视觉层级、产品事实和响应式折叠，六项均为零阻断；意见必须写入 fidelity ledger，不以作者自评代替；
- 五秒静态首屏理解测试中，复核者能够复述“日本本地活动”“iPhone 与 Web”“参加前事实”三项；任一项在任一语言连续两次遗漏即返回概念阶段；
- 三秒动作发现测试中，复核者能指出当前真实主动作：未上架时为“浏览网页版”，预订/上架后为 Apple 官方徽章；不能依赖滚动、悬停或讲解；
- 最终实现与已接受概念在章节顺序、首屏几何、字号层级、色彩、产品截图、动作状态和响应式折叠七项逐项对照，所有偏差都有修复或产品所有者书面接受记录。

“比竞品更美”最终仍需真实三语目标用户研究证明；在研究完成前，只能声称本地设计与可用性门已通过，不能把主观目标写成生产事实。

## 3. 路径选择

评估三种方向：

1. **App-first 东京编辑感产品官网**：以品牌主张、真实产品画面和下载为主，网页版为第二入口；采用。
2. **发现页直接承担官网**：功能密度高，但新用户无法快速理解完整产品与 App 下载；不采用。
3. **极简下载页**：制作快，但不足以表达安全、社群、主办和跨端价值；不采用。

采用方向的视觉名称为 **Tokyo Afterglow / Quiet Confidence**。它保留 Spott 暮紫和一点东京朱红，以温和纸白、石墨文字、经批准的东京编辑插画与真实产品画面形成克制的高级感，不使用廉价霓虹、玻璃堆叠、模板化渐变或生成式仪表盘观感。

## 4. 信息架构

### 4.1 路由

- `/`：简体中文产品下载官网，也是 `x-default`。
- `/ja`：日文产品下载官网。
- `/en`：英文产品下载官网。
- `/discover`：真实 Web 活动发现产品。
- `/tokyo`、`/categories/{slug}`、`/e/{slug}`、`/g/{slug}`、`/u/{handle}`：公开可索引产品页。
- `/privacy`、`/terms`、`/safety`：法律与安全页。

根页面不再重定向。现有产品路由、查询参数和深链保持稳定。

### 4.2 官网导航

桌面导航最多四个文本目的地：

- Spott 品牌；
- 参加前须知 / 参加する前に / Before you go；
- 社群；
- 主办方；
- 安全；
- 语言；
- 一个随商店状态变化的主动作。

官网章节锚点固定为 `#before-you-go`、`#discover`、`#community`、`#host`、`#safety`。品牌返回当前语言首页；“浏览网页版”才进入 `/discover`。章节锚点不使用 `aria-current="page"`。

Header 与 Hero 动作采用同一状态矩阵：

| 商店状态 | 文本导航 | Header 主动作 | Hero 主动作 |
| --- | --- | --- | --- |
| `unavailable` | 参加前须知、社群、主办方、安全 | 浏览网页版 → `/discover` | 浏览网页版；“App Store 即将上线”仅为静态辅助文字 |
| `preorder` | 发现活动 → `/discover`、社群、主办方、安全 | 下载 Spott → `#download` | Apple 官方“预订”徽章；网页版为次动作 |
| `available` | 发现活动 → `/discover`、社群、主办方、安全 | 下载 Spott → `#download` | Apple 官方“下载”徽章；网页版为次动作 |

一个页面只出现一个 Apple 官方徽章，并且只位于 Hero 的 `#download` 区域；Header 不复制徽章，最终区也不再渲染第二个徽章。

手机导航：

- 品牌、语言和下载动作始终可见；
- 其余锚点进入可键盘操作的菜单；
- 菜单打开时锁定背景滚动并正确管理焦点；
- 不复用登录用户的五项产品 Dock，避免官网与 Web App 导航语义混淆。

## 5. 首页内容与节奏

### 5.1 首屏：可用动作先于解释

首屏采用左右非对称布局，手机改为纵向：

- 主标题：表达“发现真实活动，遇见可以继续同行的人”，不放标题上方装饰性 eyebrow、pill 或假奖项；
- 一段短说明：东京与日本本地活动、参加前事实、三语与跨端；
- `available` / `preorder` 的主动作是对应语言的 Apple 官方徽章，次动作“浏览网页版”进入 `/discover`；
- `unavailable` 的唯一主动作是“浏览网页版”；Spott 自有“App Store 即将上线”只是静态辅助文字，不伪装成按钮、不收集邮箱；
- 产品舞台：一张主产品画面展示真实发现/活动界面，后方最多两张真实界面作为空间层次；只有在满足 Apple 营销素材许可并使用官方产品图时才把它呈现为具体 iPhone；
- 首屏底部露出下一章节的开头，建立滚动方向。

产品画面只承载真实 App UI。装饰性东京背景可以使用经批准的生成或授权图像，但不得生成假的产品操作、活动库存或评价。

首屏空间预算：

- 1440×900：Header 高度不超过 72px；Hero H1 最多三行；动作组最多两种视觉样式；主产品画面至少 40% 在首屏可见；下一章节露出至少 48px。
- 1024×768：在文字与产品画面开始拥挤前收为紧凑双栏；Header 不允许换成两行。
- 768px：进入单栏或窄双栏中间态，产品画面不得压到文案或动作之下造成遮挡。
- 390×844：Header 不超过 64px；H1 最多三行；真实主动作和商店状态在 `y≤430px`；产品画面从 `y≤520px` 开始；不强制露出下一章节。
- 320px：除品牌、语言和菜单外的导航全部收起；首屏允许继续滚动，但主动作不能被产品画面推出首屏。
- 菜单断点最晚为 1120px，并以实际三语导航是否拥挤为提前触发条件。

### 5.2 参加前就看清楚

以一条开放式编辑排版展示六类真实决策信息：时间、公开地区、费用、名额、语言、主办方。画面来自真实活动详情；不把六项做成六张重复卡片。

文案重点：先看清，再决定出发。精确地址仍遵守报名后的授权披露规则。

容器锁：一条全宽“六项参加前事实”编辑排版加一个真实详情截图裁片；禁止六卡、图标宫格和横向自动轮播。

### 5.3 一次见面，可以有很长的以后

展示活动如何延伸到群组、关注、讨论和下一次活动。使用真实社群页面截图和连续关系叙事，不虚构聊天、好友头像或参与人数。

容器锁：使用一条从活动到社群的连续叙事轨迹与一个真实社群画面；禁止头像墙、伪聊天气泡和“大家都在参加”的社会证明。

### 5.4 主办活动，不必独自处理所有细节

以创建、报名/候补、签到、通知和复盘的连续工作流展示主办方价值。当前未闭环的 AI、付费票务、周期活动或团队能力不得画成已可用主操作。

容器锁：线性 Host workflow rail，最多一个真实 App 画面和一个真实 Web 画面；步骤使用排版和连线，不做五张步骤卡。

### 5.5 iPhone 与 Web，继续同一段体验

并排展示 App 与 Web 对应的真实活动/社群界面，说明用户可以在两个入口继续产品旅程，而不承诺尚未由同 HEAD 跨端 E2E 证明的“始终同步”或“完全一致”。网页版入口必须真实可点击；没有数据时使用诚实的加载/空/错误状态。

容器锁：只使用一组同一真实状态的 App/Web 对照作为 proof band，不再叠加功能卡、徽章或第二组设备。

### 5.6 为日本城市里的真实见面而设计

以克制的文字和一个事实面板展示当前可由代码和运行证据证明的能力，并提供“查看安全与隐私说明”入口。候补、签到、举报、拉黑等能力只有在对应端当前证据完整时才可写成可用事实，不能把规划中的治理能力写成完整保障。可证明范围包括：

- 简体中文、日语、英语；
- 精确地点渐进披露；
- 费用与平台积分边界；
- 候补、签到和重要变更；
- 举报、拉黑与安全入口。

只描述当前已实现或明确标注为准备中的能力。

容器锁：全宽、低密度的 Japan/trust 收束带，以文字和真实状态词为主；禁止安全图标宫格、盾牌插画和无法证明的“平台认证”徽章。

### 5.7 最终下载与页脚

最后一屏回到单一动作：使用普通文本链接返回 Hero 的 `#download`。它不得复制 Apple 官方徽章；`unavailable` 状态下直接使用“浏览网页版”作为动作。页脚保留网页版、隐私、条款、安全、支持和语言入口，不得以订阅邮件弹窗打断下载路径。

### 5.8 三语首屏与章节 copy lock

| 区域 | 简体中文 | 日本語 | English |
| --- | --- | --- | --- |
| Hero H1 | 发现想参加的活动，遇见愿意再见的人。 | 行ってみたいイベントに出会い、また会いたい人とつながる。 | Find events worth showing up for. Meet people you’ll want to see again. |
| Hero 正文 | 在东京与日本各地，先看清时间、公开地区、费用、语言和名额，再决定是否参加。支持简体中文、日语和英语，也可从 Web 开始浏览。 | 東京と日本各地のローカルイベントを、日時・公開エリア・料金・言語・空席まで確かめてから選べます。日本語・簡体字中国語・英語に対応。Webからも閲覧できます。 | Explore local events across Tokyo and Japan with the time, public area, fee, language, and availability clear before you decide. Available in Simplified Chinese, Japanese, and English. You can also start on the web. |
| Web CTA | 浏览网页版 | Webで見る | Explore on the web |
| 未上架状态 | iPhone 版即将在 App Store 上线 | iPhone版はApp Storeに近日登場 | Coming soon to the App Store |
| 决策信息 | 参加之前，先看清楚 | 参加する前に、知っておきたいこと。 | Know before you go. |
| 决策信息正文 | 时间、公开地区、费用、语言和名额都放在决定之前。精确集合点只向获得权限的参加者显示。 | 日時、公開エリア、料金、言語、空席を、参加を決める前に確認できます。正確な集合場所は、権限のある参加者にだけ表示されます。 | See the time, public area, fee, language, and availability before you commit. Exact meeting points are shown only to participants with access. |
| 社群 | 一次相遇，继续有话可聊 | 一度の出会いを、その先へ。 | One meet-up can lead somewhere. |
| 社群正文 | 公开社群把同一兴趣下的活动放在一起，让下一次见面不必重新开始。 | 公開コミュニティなら、同じ興味から次のイベントへ。一度の出会いを、また会えるきっかけにできます。 | Public communities bring related events together, so the next meeting does not have to start from zero. |
| 主办方 | 主办活动，把细节交给清晰的流程 | イベント運営を、迷いなく。 | Host with the details in hand. |
| 主办方正文 | 用清晰的创建与管理界面安排活动信息、查看报名状态，并处理活动前后的下一步。 | 作成から申込状況の確認、開催前後の対応まで。必要な情報を、わかりやすい流れで管理できます。 | Create the event, understand registration status, and handle what comes next through one clear flow. |
| 跨端 | iPhone 与 Web，继续同一段体验 | iPhoneでもWebでも、その続きを。 | Continue on iPhone and the web. |
| 跨端正文 | 在 iPhone 与 Web 查看对应的活动和社群界面，从适合当下的入口继续。 | iPhoneとWebで、対応するイベントやコミュニティを確認。今いる場所に合う入口から続けられます。 | View the corresponding event and community experiences on iPhone and the web, then continue from the surface that suits you. |
| 日本与安全 | 为日本城市里的真实相遇而设计 | 日本の街で、安心して会うために。 | For real-world meetings in Japan’s cities. |
| 日本与安全正文 | 三语信息、地点渐进披露和清楚的费用边界，帮助每个人在见面前做出更明白的决定。 | 3言語の案内、場所の段階的な開示、明確な料金区分。会う前に、納得して選べるための情報を整えます。 | Three-language information, progressive location disclosure, and clear fee boundaries help people make informed choices before meeting. |
| 最终区 | 下一次相遇，从这里开始。 | 次の出会いは、ここから。 | Your next meet-up starts here. |
| 最终区正文 | 先浏览网页版；iPhone 版公开后，可从 App Store 继续。 | まずはWebでイベントを見つけてください。iPhone版の公開後は、App Storeから続けられます。 | Start by exploring on the web. Once the iPhone app is available, continue from the App Store. |

上述文案是实现允许清单。概念接受后不得在首屏新增 badge、eyebrow、假指标、评价、背书或未经批准的解释句。

## 6. 视觉系统

### 6.1 精确色彩令牌

官网选择与现有产品一致的温和纸白，不再声明“冷白”。令牌只在官网根 class 下定义营销语义别名，不修改共享产品令牌：

| 语义 | 精确值 | 用途 |
| --- | --- | --- |
| `--marketing-canvas` | `#F7F5F0` | 全页纸白画布，对应现有 `--spott-canvas` |
| `--marketing-surface` | `#FFFFFF` | 产品画布、导航和少量事实面 |
| `--marketing-ink` | `#17181C` | 标题与正文 |
| `--marketing-muted` | `#626772` | 辅助文字，最终需通过 AA 对比 |
| `--marketing-violet` | `#6E5BE7` | 品牌标识和大字号装饰性强调 |
| `--marketing-action` | `#5747D7` | 白底链接、焦点和主操作 |
| `--marketing-action-hover` | `#4638B8` | 交互悬停/按下 |
| `--marketing-vermilion` | `#D65343` | 极少量东京朱红节奏点 |
| `--marketing-line` | `#DEDAD2` | 分隔与产品画布边界 |
| `--marketing-mist` | `#EFECFF` | 紫色低对比背景带 |
| `--marketing-night` | `#17152B` | 页尾深色收束带 |

成功、候补、危险继续使用现有语义色，不用品牌紫替代状态。实现不得在每个区块散落近似色，也不得把当前暖色 `og.jpg` 当成“冷白”依据。

### 6.2 字体与排版

- 拉丁字符使用现有 Inter 字族；中文和日文使用系统内高质量 CJK 字族回退，并在 macOS 与 Windows 分别验收，不临时引入网络字体。
- Hero H1：桌面 `clamp(56px, 6vw, 76px)`、行高 `1.02`、字重 `780`；手机 `clamp(42px, 12vw, 52px)`、行高 `1.08`。拉丁 tracking 最多 `-0.045em`，CJK 最多 `-0.025em`。
- 章节标题：桌面 42–56px、行高 1.08、字重 740；手机 32–40px、行高 1.14。
- Hero 正文：18–20px、行高 1.6、最大 38em；普通正文 16–18px、行高 1.65、最大 40em。
- 导航与控件：14–15px、行高 20px、字重 650–720；页脚法律文字不低于 12px/18px。
- 中日英使用同一语义级别，不通过缩小某一语言解决换行；概念图必须记录三语实际断行。

### 6.3 构图

- 采用开放空间、跨栏图像和编辑式错位，不用默认三列功能卡网格。
- 上架前使用不含 Apple 独有硬件特征的中性产品画布；上架或预订后如使用 iPhone 产品图，只采用 Apple 官方提供的当前产品图并保持原样。
- 每个章节只有一个主要视觉焦点；相邻章节在左右节奏、底色和密度上交替。
- 视觉主线固定为“真实产品画面 + 一种经批准的 Tokyo editorial artwork”。真实活动摄影只有在来源、授权和活动语境明确时才使用；不混用通用 AI 东京照片、纸张插画、渐变光晕、三维设备和头像墙。
- 全页最多七个产品画布、一个主编辑插画和两个卡片家族；任何章节不得再添加漂浮指标卡、假通知或重复设备。

### 6.4 动效

- 首屏中性产品画布可以使用一次轻微进入和低幅度景深运动，最大位移 12px、单次时长不超过 600ms；移动端默认减半。Apple 官方徽章和产品图不得倾斜、旋转、加反射、加自定义阴影或动画；滚动章节只做透明度/位移的小范围叙事。
- 按钮、导航和链接使用 120–220ms 状态过渡。
- `prefers-reduced-motion: reduce` 时关闭位移、视差和自动运动，信息不得依赖动画出现。
- 不使用自动播放轮播、粒子背景、鼠标追踪光斑或影响阅读的持续动画。

### 6.5 品牌资产锁

- Header、Footer 和可见正文统一使用 title case `Spott`，禁止与全大写 `SPOTT` 混用。
- 文字标志保持 code-native，使用品牌紫、字重 800–850 和紧凑 tracking；周围最小净空为字高的 0.5 倍。
- App icon 只能从权威源 `Spott/AppIcon.icon` 导出并进入运行时资产清单；不得从 `artifacts/` 复制不明版本。图标周围最小净空为图标宽度的 0.25 倍。
- 当前 `apps/web/public/og.jpg` 只作为 Tokyo editorial 方向参考：它含全大写字标且缺少本切片资产来源清单，必须在概念锁定后重制或明确淘汰，不能直接充当新官网的接受图。
- 深浅底、最小尺寸、Wordmark 与 icon 的组合方式必须在概念清单中逐项展示；不额外发明圆点 logo、徽章或 slogan lockup。

## 7. App Store 下载契约

### 7.1 真实链接

新增受控配置 `NEXT_PUBLIC_APP_STORE_STATE=unavailable|preorder|available`、`NEXT_PUBLIC_APP_STORE_URL` 和 `NEXT_PUBLIC_APP_STORE_ID`。默认状态是 `unavailable`。只有 App 已公开下载或已在 App Store 开放预订、且产品所有者具备相应 Apple Developer 营销素材使用资格时，状态、URL 与预期 App ID 三者一致才可：

- 根据真实商店状态显示与当前页面语言对应的 Apple 官方“下载”或“预订”徽章；
- 点击有可访问名称；营销事件只有在独立匿名适配器满足第 12 节边界时才发送；
- 不经过不透明短链或第三方跳转。

商店链接交给当前设备正常导航，不强制新窗口。服务端解析必须同时满足：HTTPS、无 userinfo、无非默认端口、无 fragment、hostname 精确等于 `apps.apple.com`、路径含 `id<数字>`，且数字与 `NEXT_PUBLIC_APP_STORE_ID` 完全一致。缺一项、状态不一致或 URL 指向其他 App 时一律回退到 `unavailable`，客户端只接收判定后的安全展示状态。

### 7.2 尚未公开上架

当前仓库 `APPLE_APP_ID` 为空，Apple 公开 lookup 对 `com.yaokai.Spott` 没有返回公开商店记录。因此在获得真实链接前：

- 官网可以完整显示下载区域和产品画面；
- 不渲染 Apple 官方徽章，也不允许链接到另一款同名 App、App Store 首页或 `#`；
- 使用 Spott 自有文字和图形显示本地化“App Store 即将上线”，不得模仿 Apple 徽章，为非链接状态；
- 可选的网页版入口始终可用；
- 提供真实 App ID、URL 和状态后无需改组件，但必须同步 `.env.example`、Web 构建参数、部署镜像、Compose/平台配置与部署验证，不能只修改运行时环境变量后假定静态构建已生效。

### 7.3 徽章与合规

在具备使用条件后，使用 Apple 官方提供的对应语言徽章，保持宽高比、至少 40px 屏幕高度、规定留白和商标文案；一个版面只使用一个徽章，不自行重绘、改色、倾斜、动画化或把徽章塞入自定义紫色按钮。页面法律区域加入适用的 Apple 商标 credit line。

若使用 Apple 产品图展示 App，只能使用 Apple 官方提供、与 App 支持范围一致的当前产品图，保持原始比例、方向和相对尺度，不增加机壳、反射、阴影、遮挡或穿出屏幕的元素。未满足这些条件时，仅显示真实 App 截图的中性品牌画布，不绘制带传感器、按键等 Apple 独有细节的仿 iPhone 机框。

官方徽章链接的可访问名称固定为：

- 简体中文：“在 App Store 下载 Spott”；
- 日本語：“App StoreでSpottをダウンロード”；
- English: “Download Spott on the App Store”.

未上架状态是普通静态文本，不伪装成禁用按钮，也不使用会造成重复播报的 `role="status"`。

## 8. 真实产品素材

### 8.1 截图

官网只采用从同一确认 HEAD、同一可说明数据集和标准 Dynamic Type 捕获的 iOS/Web 截图。每张素材记录：

- 页面和状态；
- 语言；
- 设备/视口；
- 源代码 HEAD；
- 是否含需脱敏数据。

状态栏、标题、底栏不得重叠；不能使用当前已知存在大字拥挤的截图作为营销成品。截图中的功能必须能在当前产品中重现。

当前素材审计结论：

- `artifacts/i4b-community-final-20260719/*-standard.png` 顶部标题与状态栏重叠，且资产清单没有可证明的源 HEAD，不合格；
- `docs/design/proposals/2026-07-18-tokyo-afterglow-v1/*` 是生成式方向提案，README 明确未接受且含参考/虚构内容，不是真实产品截图；
- `apps/web/public` 当前没有满足本规格的真实 App 发现、详情、社群和主办画面。

因此实现前必须从最终确认 HEAD 重新捕获并完成下列矩阵，每个状态均提供简体中文、日语、英语版本：

| 素材 | 必须显示的真实状态 | 端与尺寸 |
| --- | --- | --- |
| Hero discovery | 真实发现页、可解释活动、无测试占位 | iPhone 当前受支持机型，标准 Dynamic Type |
| Before-you-go detail | 时间、公开地区、费用、语言、名额、主办方 | iPhone + 对应 Web 视口 |
| Community | 公开社群与真实可用动作 | iPhone 或 Web，按当前证据选择 |
| Host workflow | 当前已闭环的创建/管理步骤 | iPhone + Web，禁止展示未闭环步骤 |
| Cross-surface proof | 同一 fixture 的对应 App/Web 状态 | iPhone + 1440px Web |

每张截图先通过 safe area、状态栏、长文案、脱敏、数据来源、第三方内容授权和功能可重现检查。营销运行时资产进入 `apps/web/public/marketing/product/`，提供稳定尺寸的 AVIF/WebP 与 PNG fallback；同时提交 `manifest.json`，记录文件哈希、源 HEAD、fixture/公开数据版本、语言、端、设备/视口、Dynamic Type、状态、尺寸、裁切、脱敏与授权。网站禁止直接引用 `artifacts/`、`output/` 或设计提案目录。

### 8.2 图像生成边界

图像生成可用于完整官网概念和不含产品事实的东京氛围资产。不能用于：

- 伪造 App UI；
- 伪造用户、评价、活动数量或媒体背书；
- 替代真实商店截图；
- 制造产品尚未具备的功能。

### 8.3 官网概念图清单与接受门

现有 Tokyo Afterglow 发现页提案不能作为官网 fidelity 基准。真实截图矩阵完成后，使用它们制作一组全新的官网概念，目录固定为 `docs/design/proposals/2026-07-22-spott-product-website-v1/`：

1. `01-hero-desktop-1440x900.png`；
2. `02-hero-mobile-390x844.png`；
3. `03-full-page-rhythm-desktop.png`（仅用于全页节奏，不替代分节细节图）；
4. `04-before-you-go-1440x900.png`；
5. `05-community-1440x900.png`；
6. `06-host-1440x900.png`；
7. `07-cross-surface-1440x900.png`；
8. `08-japan-safety-1440x900.png`；
9. `09-final-download-footer-1440x900.png`。

同目录 `concept-manifest.md` 为每张图记录原生尺寸、允许可见文案、所用真实截图、编辑插画/装饰资产角色、App Store 状态、生成/编辑来源、资产权利、接受状态、接受人和日期。文字过小、模糊、裁切或容器结构不明确时必须重新生成独立分节图，不能从长图裁切放大代替。

全部概念初始状态为 `PROPOSED`。产品所有者明确接受后才改为 `ACCEPTED` 并进入页面编码；最终浏览器截图必须逐节与这些接受图比较。

## 9. 三语内容契约

- 所有官网可见文案进入现有 `zh-Hans`、`ja`、`en` 消息系统，不在组件里硬编码中文。
- 三种语言拥有相同章节、相同事实和相同 CTA；允许自然本地化，不逐字直译。
- 日文采用日本产品官网的自然语气，中文避免官方文件腔，英文避免直译式句法。
- 语言切换保留当前路径和章节锚点，不把用户送回页面顶部以外的错误路由。
- App Store 徽章、`aria-label`、metadata、Open Graph 文案和图片替代文本都随语言变化。
- 每种语言拥有稳定、可索引 URL：`/`、`/ja`、`/en`。三页分别 self-canonical，并输出互相指向的 `hreflang="zh-Hans"`、`hreflang="ja"`、`hreflang="en"` 与 `hreflang="x-default"`。
- 语言切换必须保留对应章节锚点。Cookie 仍可用于产品应用偏好，但不能作为官网三语 SEO 的唯一寻址机制。
- `marketing.*` 使用独立消息命名空间，不复用含“精选”“真实主办方”“实时同步”等更强声明的现有 `discover.*` 文案。

## 10. 路由外壳、组件与代码边界

### 10.1 官网必须位于产品会话外壳之外

当前根布局无条件挂载 `SessionProvider`、产品 `SiteHeader`、`ServiceWorkerRegistrar` 和 `SyncEngineRegistrar`。仅替换 `app/page.tsx` 会触发会话 bootstrap、同步、产品 Dock，并可能在恢复期间把整页设为 `inert`，不能满足官网契约。

实现必须在服务端请求阶段区分 `marketing` 与 `product` 外壳，禁止用 CSS 隐藏产品 Header/Dock：

- `marketing` 仅对应 `/`、`/ja`、`/en`；不挂载 `SessionProvider`、`AppDialogProvider`、`PreviewModeProvider`、`SyncEngineRegistrar`、`ServiceWorkerRegistrar`、`AccountControl`、`NotificationControl` 或产品 `SiteHeader`。
- `product` 对应 `/discover` 及其他现有公开、登录和 Studio 路由；完整保留当前 Provider 顺序、只读预览 Banner、产品 Header 和移动 Dock。
- `apps/web/proxy.ts` 删除任何入站同名标记后，按规范化 pathname 覆盖内部 `x-spott-route-shell` 与 `x-spott-route-locale`；只有 `/`、`/ja`、`/en` 可标为 `marketing`，其他路径默认 `product`。
- 根布局读取上述由应用覆盖的内部标记，`marketing` 分支以路径语言初始化官网 i18n，`product` 分支继续使用现有协商语言。标记缺失或无效时 fail closed 到 `product`。
- 该 shell 分类、`layout.tsx` 和 `proxy.ts` 属于当前未提交 Session/BFF 工作的重叠所有权。实施前必须完成精确交接或在隔离工作树实现并做冲突感知集成；不得覆盖、stash、reset 或顺手吸收现有会话改动。

若当前框架对内部请求标记的生产行为无法由渲染测试证明，则改用 `(marketing)` / `(product)` 路由组和独立布局实现同等服务端隔离；不得退回客户端 pathname 后再隐藏或延迟 bootstrap。

### 10.2 组件边界

- `app/page.tsx`、`app/ja/page.tsx`、`app/en/page.tsx`：固定语言的服务端主页与 metadata。
- `app/components/marketing/MarketingHome.tsx`：章节组合，不持有业务状态。
- `MarketingHeader` / `MarketingFooter`：官网专用导航，不导入产品账户或通知控件。
- `AppStoreDownload`：服务端解析并渲染安全商店状态。
- `AppStoreClick.client.tsx`：只在真实链接状态下承载最小点击行为；首版不发送分析。
- `MarketingMenu.client.tsx`：唯一手机菜单 island，管理焦点、背景滚动和 `aria-expanded`。
- `ProductStage`：服务端输出中性产品画布、合规 Apple 产品图状态和真实截图清单。
- `MarketingImage.client.tsx`：只有确需自定义加载失败状态的图片使用，不迫使整个 `ProductStage` 客户端化。
- `ProductStorySection`：少量明确变体，不做万能配置引擎。
- `marketing-home.module.css`：官网全部布局与响应式样式；不复用全局 `.site-header`，不污染发现、活动、群组或 Studio。
- `i18n/messages.ts`：三语官网文案与 metadata/alt/aria 独立消息键。
- `lib/app-store.ts`：服务端纯函数配置解析和安全状态，不把原始环境值传给客户端。

`MarketingHome`、章节、文案与截图清单保持 Server Component。页面初始 HTML 就是最终可读状态；JavaScript 禁用时只有菜单增强和可选动效缺失，核心内容与链接仍可用。

## 11. 数据流与错误处理

官网第一版不依赖实时 API 才能完成首屏，避免 API 故障让产品官网空白。它使用版本化、可追溯的真实截图和静态三语文案。

- App Store URL 缺失或无效：安全显示“即将上线”，不渲染假链接。
- 图片加载失败：保持产品画布尺寸，显示品牌化但诚实的替代状态和替代文本。
- 官网首版不导入现有 `app/lib/analytics.ts` 或 `client-api.ts`，也不发送营销事件。未来如启用，只允许独立、用户同意后启动、`credentials: "omit"` 的极小适配器，以及固定事件名和不含个人信息的枚举属性；公开只读预览始终禁用。
- JavaScript 被禁用：核心内容、下载状态、网页版入口、法律链接与语言对应的服务端页面仍可读。
- 动效初始化失败：页面保持最终静态布局，不隐藏正文。
- 公开只读预览的 `/discover` CTA 使用硬导航或现有 `PreviewModeLink` 的无预取语义，不触发 session bootstrap、同步、认证 API 或营销分析；进入产品路由后继续保留现有只读 Banner 和内部测试入口。

### 11.1 官网功能声明登记

每条可见主张都必须在截图捕获时重新绑定当前 HEAD 证据；没有新证据即不展示：

| 主张 | 当前代码锚点 | 允许展示状态 | 禁止展示状态 |
| --- | --- | --- | --- |
| 浏览日本本地活动 | `app/discover`、`app/tokyo`、发现 API/组件 | 同 HEAD 真实发现结果与公开只读浏览 | 假活动、假坐标、无解释的“精选/为你推荐” |
| 参加前决策事实 | `components/event/EventDetail.tsx` 与活动契约 | 重新捕获后展示时间、公开地区、费用、语言、名额、主办方 | 暗示精确地址公开、伪造余位或“平台认证” |
| 公开社群 | `app/groups`、`app/g/[slug]` | 真实公开群组和当下可用的只读/互动状态 | 未验收的关注、加入、评论、私信或假成员 |
| 主办方流程 | `app/create`、`app/studio` | 只展示同 HEAD 已闭环并可复现的创建/管理步骤 | AI 真生成、完整票务、周期活动、多管理员或未闭环步骤 |
| iPhone 与 Web | SwiftUI App 与 Web 对应页面 | 说明两个真实入口存在并展示对应 fixture | “始终同步”“完全一致”“3 秒收敛”等未完成 P0 的承诺 |
| 三语界面 | Web `messages.ts` 与 iOS 三语资源 | 在三语键、渲染与截图复核后说明支持简中/日/英 | “所有内容自动准确翻译”或未经母语审校的保证 |
| 地点与费用边界 | 地址权限、活动费用契约与安全/法律页面 | 展示渐进式地点披露和可证明费用说明 | “绝对安全”“零风险”或未获法律签字的保障 |
| App Store | 当前 `APPLE_APP_ID` 为空且公开 lookup 为 0 | `unavailable` 静态状态 | 官方下载徽章、评分、商店截图、下载量或假链接 |

任何状态从 `WITHHOLD` 变为可展示，必须同时更新资产 manifest、copy lock 和当前证据链接；不能只改 CSS 或营销文案。

## 12. SEO、性能、安全与隐私

- `/`、`/ja`、`/en` 各自有固定语言 title、description、self-canonical、三向 hreflang、Open Graph 图和安全结构化数据；未公开上架时不输出虚假评分、价格或商店 URL。
- 官网 metadata copy lock：
  - 简体中文 title：`Spott｜发现日本本地活动，连接持续的社群`；
  - 日本語 title：`Spott｜日本のローカルイベントと、続いていくつながり`；
  - English title: `Spott | Local events and lasting communities in Japan`；
  - description 使用对应语言 Hero 正文，不加入“最可信”“精选”“实时同步”“已超越竞品”等当前无法证明的修辞。
- 首屏主产品图使用响应式尺寸和优先加载；下方素材懒加载并提供稳定宽高，避免布局偏移。
- 不为背景效果引入大体积 WebGL、视频或第三方营销 SDK。
- 目标：LCP ≤ 2.5s、CLS ≤ 0.1、INP ≤ 200ms（受控桌面/移动实验环境）；最终以真实预发测量为准。
- 外部链接使用白名单；官网不读取登录 token，不在 URL 或分析事件中发送个人数据。
- Content Security Policy 和现有 BFF/会话边界保持不变。
- canonical origin 只来自经过校验的 `SPOTT_WEB_CANONICAL_ORIGIN`，不得与 `NEXT_PUBLIC_SITE_URL` 漂移；三语 URL 由同一 canonical origin 构造。
- JSON-LD 按现有公开城市页边界序列化并转义 `<`。未上架时不得输出 `installUrl`、App Store URL、评分、下载量或价格；只输出可证明的 `WebSite`、`Organization`，`MobileApplication` 只包含本地可证明字段。
- 官网 HTML 文档保持 network-only，不加入 Service Worker document precache；仅内容哈希静态资产可按现有安全策略缓存。

## 13. 无障碍与响应式

- 使用语义 header/nav/main/section/footer 和唯一 H1；章节标题层级连续。
- 所有交互最小 44×44 CSS 像素，焦点清晰，菜单和下载状态有可读名称。
- 产品截图有描述真实产品状态的替代文本；纯装饰图为空替代文本。
- SEO 文案、可见标题、截图替代文本和控件 `aria-label` 使用独立消息键，不用同一句话跨语义复用。截图替代文本只描述画面真实可见状态。
- 颜色对比至少 WCAG 2.2 AA；状态不只靠颜色。
- 200% 缩放、Windows 高对比、减少动态、键盘和 VoiceOver/NVDA 路径纳入最终验收。
- 手机首屏在 390×844 下同时露出品牌主张、下载状态、网页版入口和主要产品画面的一部分；不能只有大标题或纯装饰。
- 移动菜单按钮具有本地化名称、`aria-expanded` 和 `aria-controls`；名称分别为“打开 Spott 官网导航”、“Spottサイト内ナビゲーションを開く”和“Open Spott site navigation”。

## 14. 本地代码优先的交付顺序

按产品所有者要求，先完成用户端本地代码，再集中执行测试和最终验收：

1. 产品所有者确认本书面规格后，先生成逐文件、可回滚、带验收门的实施计划；未确认前不写官网页面代码；
2. 精确盘点并交接当前 `layout.tsx`、`proxy.ts`、Session/BFF 脏改动的所有权，只操作本切片明确拥有的文件，不 stash、reset、覆盖或混入他人改动；
3. 完成截图所需的用户端真实页面与 fixture，修复 safe area、长文案、占位数据和当前可见缺陷，再从同一确认 HEAD 捕获第 8 节矩阵；
4. 使用真实截图生成第 8.3 节全部桌面/手机概念，逐节取得产品所有者明确接受，冻结 `concept-manifest.md`、设计令牌、首屏几何和 CTA 状态；
5. 实现官网服务端路由外壳、结构、组件、三语文案、SEO 和 App Store 配置；
6. 完成全部桌面/手机样式、真实产品画面、菜单、语言切换、下载状态、错误状态和减少动态状态；
7. 统一公开 Web 页面视觉、导航与完整功能；
8. 统一登录用户和主办方 Web 页面视觉与完整功能；
9. 完成 iOS 对应用户端代码、三语、无障碍与跨端旅程；
10. 集中补齐/更新单元、渲染、浏览器、无障碍、性能和视觉回归测试；
11. 真实浏览器与模拟器逐页验收，修复所有可见问题，并重新执行全部受影响测试；
12. 完成独立设计、前端、可访问性和安全复核；精确提交、推送并回写 SSOT。

“测试放在最后”不等于跳过验收，也不允许在测试阶段发现架构错误后降低需求；它只改变本批执行顺序。

## 15. 第一交付验收清单

- `/` 不再重定向，完整产品官网可直接渲染。
- 桌面和手机首屏均有品牌主张、真实 App 界面、合规下载状态和网页版入口。
- App Store URL 有效时使用官方徽章和真实链接；缺失时无假链接。
- 所有章节和 CTA 在简中、日文、英文完整且自然。
- 产品截图来自可追溯的真实 App/Web 状态，无重叠、占位或生成式假 UI。
- 页面无默认卡片网格、假指标、假评价、假背书和未实现功能。
- 官网与 `/discover` 的导航角色清楚，原产品路由和深链不回归。
- 所有交互真实可用，键盘、焦点、减少动态和 200% 缩放通过。
- 桌面、平板、390×844 和 320 像素手机无溢出、裁切、遮挡或不专业折叠。
- 构建、显式 Web TypeScript、lint、单元、渲染、浏览器、a11y、性能与视觉对比最终全部通过。
- 使用接受的概念图与最终浏览器截图进行逐项 fidelity ledger；没有可修复的视觉偏差才可交付。

## 16. 非目标与真实阻塞

本官网切片不声称完成：

- App Store 正式上架、App Review 或真实商店评分；
- 未完成的票务、会员、周期活动、AI 助手或组织层能力；
- 真实用户证明“比 Luma/Meetup 更好”；
- 生产域名、TLS、法律签字、30 天公测或生产发布。

这些项目仍属于总 SSOT 的完整范围。官网本地代码和预发准备可以先完成，但对应外部门未关闭前不得标为 `PRODUCTION_READY` 或 `ACCEPTED`。

## 17. 设计依据与当前外部基线

- Spott 唯一事实源：`docs/Spott-产品工程唯一事实来源与完整开发交接-20260719.md`。
- [Luma Event Themes and Customization](https://help.luma.com/p/event-themes-and-customization)，复核日期：2026-07-22。
- [Luma iOS App](https://help.lu.ma/p/luma-ios-app)，复核日期：2026-07-22。
- [Meetup 官方首页](https://www.meetup.com/)，复核日期：2026-07-22。
- [Meetup About](https://www.meetup.com/about/)，复核日期：2026-07-22。
- [Apple 公开 App Lookup：`com.yaokai.Spott`](https://itunes.apple.com/lookup?bundleId=com.yaokai.Spott&country=jp)，复核日期：2026-07-22，当前 `resultCount=0`。
- [Apple App Store Marketing Resources and Identity Guidelines](https://developer.apple.com/app-store/marketing/guidelines/)，复核日期：2026-07-22。
