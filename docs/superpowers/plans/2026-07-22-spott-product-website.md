# Spott 产品下载官网实施计划

日期：2026-07-22  
状态：规格已由产品所有者确认，进入实施  
基准：`docs/superpowers/specs/2026-07-22-spott-product-website-design.md`  
工作树：`/Users/yaokai/Code/xingyu/Spott/.worktrees/core-journey-ui`

## 目标与边界

第一交付把 `/`、`/ja`、`/en` 从发现页重定向改为高级、精致、可直接访问的 Spott 产品下载官网，并保留 `/discover` 及全部既有产品路由。官网只展示当前代码与真实截图可证明的能力。当前仓库没有真实 Apple App ID，因此首版必须显示本地化“即将上线”，不得渲染 Apple 官方徽章或假链接。

按产品所有者要求，本批先完成用户端本地代码，再集中执行测试与最终验收。任何测试后发现的架构或可见缺陷都必须回到代码修复，不得降低规格。

## 所有权与不可触碰边界

- 保留当前大规模 dirty tree，不 stash、reset、clean 或覆盖无关改动。
- `apps/web/app/layout.tsx`、`apps/web/proxy.ts` 与当前会话安全切片重叠；只有会话作者交接完成且全新独立审查通过后才集成。
- 官网首轮不导入 `client-api.ts`、Session、Sync、产品 Header、通知、账户或营销分析。
- App Store 原始环境值只在服务器解析；客户端只接收安全的判定结果。
- 设计提案图不是产品截图，不得复制到运行时产品素材目录。

## 任务 1：安全 App Store 配置

文件：

- 新增 `apps/web/app/lib/app-store.ts`
- 修改 `.env.example`
- 修改 `apps/web/package.json`
- 修改 `turbo.json`
- 修改 `infrastructure/deploy/ip-preview/Runtime.Dockerfile`
- 修改 `infrastructure/deploy/ip-preview/compose.yaml`
- 修改 `infrastructure/deploy/ip-preview/bootstrap-secrets.sh`
- 修改 `infrastructure/deploy/ip-preview/verify.sh`
- 修改 `scripts/run-core-journey-e2e.ts`

实现：

1. 定义 `unavailable | preorder | available` 服务端判定类型，默认 `unavailable`。
2. 仅接受 HTTPS、无 userinfo、无非默认端口、无 fragment、hostname 精确为 `apps.apple.com`、路径 `id<数字>` 与配置 ID 完全一致的 URL。
3. `preorder`/`available` 缺少任一有效字段时安全回退 `unavailable`。
4. 把三个构建变量贯穿本地构建、Turbo、镜像、Compose 和部署验证；首版环境仍显式配置 `unavailable`。

验收：无 App ID 时页面没有链接、`#` 或 Apple 徽章；未来填写一致配置无需改组件即可切换真实状态。

## 任务 2：服务端官网外壳

文件：

- 修改 `apps/web/proxy.ts`
- 修改 `apps/web/app/layout.tsx`
- 修改 `apps/web/app/page.tsx`
- 新增 `apps/web/app/ja/page.tsx`
- 新增 `apps/web/app/en/page.tsx`

实现：

1. Proxy 删除入站伪造的 `x-spott-route-shell` / `x-spott-route-locale`，再按规范化路径覆盖内部值。
2. 只有 `/`、`/ja`、`/en` 为 `marketing`；缺失或非法值一律为 `product`。
3. 根布局在服务端分支：marketing 不挂载 Session、Sync、Service Worker、产品 Header、Dialog 或 Preview Provider；product 保持现有顺序与行为。
4. 三个主页固定语言，不依赖 Cookie 才能索引；根路径不再重定向。

验收：查看服务端 HTML 即可读完整官网；访问官网不触发 `/api/session/*`、同步或产品移动 Dock；所有既有产品路径仍使用原外壳。

## 任务 3：三语官网内容与 SEO

文件：

- 修改 `apps/web/app/i18n/messages.ts`
- 新增 `apps/web/app/components/marketing/marketing-copy.ts`
- 新增 `apps/web/app/components/marketing/MarketingMetadata.ts`

实现：

1. 建立独立 `marketing.*` 三语消息，严格使用已确认 copy lock。
2. 三页分别输出固定 title、description、canonical、三向 hreflang 和 x-default。
3. 输出可证明的 WebSite/Organization JSON-LD；未上架时不输出 install URL、评分、下载量或价格。
4. 图片 alt、菜单名称、下载动作名称和 metadata 使用独立语义键。

验收：简中、日文、英文章节、事实与 CTA 完整同构；不存在硬编码单语或更强营销声明。

## 任务 4：官网组件与交互

新增文件：

- `apps/web/app/components/marketing/MarketingHome.tsx`
- `apps/web/app/components/marketing/MarketingHeader.tsx`
- `apps/web/app/components/marketing/MarketingFooter.tsx`
- `apps/web/app/components/marketing/AppStoreDownload.tsx`
- `apps/web/app/components/marketing/AppStoreClick.client.tsx`
- `apps/web/app/components/marketing/MarketingMenu.client.tsx`
- `apps/web/app/components/marketing/ProductStage.tsx`
- `apps/web/app/components/marketing/MarketingImage.client.tsx`
- `apps/web/app/components/marketing/ProductStorySection.tsx`
- `apps/web/app/components/marketing/marketing-home.module.css`

实现：

1. Header、Hero、参加前事实、社群、Host workflow、跨端、Japan/safety、最终下载和 Footer 按确认顺序组合。
2. 首屏在 unavailable 状态只有一个主动作“浏览网页版”；商店状态是静态辅助文字。
3. 手机菜单是唯一主要客户端 island，支持焦点进入/返回、Escape、背景滚动锁、`aria-expanded` 和 `aria-controls`。
4. 语言切换保留当前章节 hash；跨外壳链接使用硬导航，避免营销页状态污染产品页。
5. 所有视觉样式限定在 marketing 根 class，不污染现有 Web 产品。

验收：320、390、768、1024、1440 宽度无溢出；390×844 的 CTA 在 y≤430、产品画面从 y≤520 开始；200% 缩放、键盘、减少动态和强制色可用。

## 任务 5：真实产品素材与 manifest

文件：

- 新增 `apps/web/public/marketing/product/manifest.json`
- 新增同目录受控 Web/iOS PNG fallback 与 WebP/AVIF
- 更新 `docs/design/proposals/2026-07-22-spott-product-website-v1/concept-manifest.md`

实现：

1. 从同一冻结 HEAD、同一 synthetic fixture、标准 Dynamic Type 捕获发现、详情、社群、Host 和跨端对应状态。
2. 先修复用户指出的真实 iOS 社群页安全区、语言混杂、发灰与层级问题，再捕获新截图。
3. 每个素材记录 hash、HEAD、fixture、语言、端、视口、Dynamic Type、裁切、脱敏和权利。
4. 官网只引用 `public/marketing/product/`，绝不直接引用 `artifacts/` 或设计提案。

验收：所有产品画面能从当前运行代码重现；无状态栏/标题重叠、测试占位、私人数据或生成式假 UI。

## 任务 6：构建、浏览器与部署收口

代码完成后集中执行：

1. App Store parser、shell 分类、三页结构、菜单、metadata 与渲染测试。
2. Web typecheck、lint、unit、rendered build。
3. Browser/IAB 优先验证；如不可用，记录原因并使用仓库 Playwright Chromium。
4. 1440×900、390×844、320、768、1024 浏览器截图；键盘、200%、Reduce Motion、强制色与无障碍树检查。
5. 用 `view_image` 同时查看接受概念与最新真实浏览器截图，写 fidelity ledger，逐项修复。
6. 制作不可变发布目录，部署到现有 `18.178.203.117` 只读预览；运行 public/internal verify，保留可回滚前一 release。

部署状态必须精确：IP HTTP 只读预览不等于生产域名、TLS、App Store 上架或生产就绪。

## 后续连续范围

官网预览交付后立即继续，不把第一交付当作总任务完成：

1. Web 公开发现、活动、群组与主办方视觉/功能；
2. 登录用户 Web 与恢复；
3. iOS 核心旅程、三语、Dynamic Type、VoiceOver；
4. Luma 级活动运营与 Meetup 级社群关系；
5. 商业化、Push、Live Activity、StoreKit 与发布面；
6. 跨端全量验收和唯一事实源回写。
