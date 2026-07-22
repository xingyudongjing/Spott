# Spott 三语产品下载官网最终浏览器验收

日期：2026-07-23（Asia/Tokyo）  
实现冻结提交：`be1add0adc47a5c9a4e389b45309bea44b5cc2fc`  
产品截图来源提交：`f587d47e7d71e1c82e764364e135abd39e162215`  
现代格式与 schema-v2 来源清单提交：`4de2fce108821a58b563f167c14e3fa3dd064b8a`

## 结论

官网最终本地生产构建通过真实浏览器验收。三语首页、320–1440 响应式、手机菜单键盘与焦点、语言连续性、200% 等价重排、减少动态和强制色均没有发现阻塞发布预览的问题。独立代码增量复审结论为 `ACCEPT — Critical 0 / Important 0 / Minor 0`。

本报告证明本地构建与浏览器门，不等于生产域名、TLS、App Store 上架或产品所有者逐图接受。公开预览部署仍是下一独立门。

## 最终实现增量

- 320px 超窄屏将语言文字收敛为地球图标，不再显示 `Eng…` 省略文本；`summary` 继续保留三语完整 `aria-label`。
- `/`、`/ja`、`/en` 在规范响应中写入固定枚举值的 `spott_locale` Cookie，使官网进入 `/discover` 后继续使用中文、日语或英语。
- HTTPS Cookie 固定 `Path=/; Max-Age=31536000; SameSite=Lax; Secure`；受信 HTTP IP 预览不错误添加 `Secure`；非规范域名先重定向且不写 Cookie。
- 完整全页、Community、Host、320、200% 与强制色证据均来自真实最终页面，不使用概念占位 UI。

## TDD 与静态门

- 320px 回归先以 `1 failed / 21 passed` 证明旧样式仍会省略文字，修复后产品素材套件 `22/22` 通过。
- Marketing locale Cookie 回归先以 `3 failed / 12 passed` 证明三个官网根路径未保存语言，修复后该套件 `17/17` 通过。
- 最终聚焦回归：4 files / `62/62` 通过。
- 构建态 marketing + provenance：`4/4` 通过。
- Node 24 生产构建：通过；仅保留 vinext 的非阻塞大 chunk 警告。
- TypeScript：通过，无诊断。
- 官网范围 ESLint：通过，无诊断。
- `git diff --check`：通过。

## 响应式与三语

基础完整矩阵覆盖 `/`、`/ja`、`/en` × 320、390、768、1024、1440，共 15 组：

- 每组 HTTP 200、`html lang` 与 canonical 对应语言路径一致。
- `document.scrollWidth === document.clientWidth`，实际水平溢出为 0。
- 每页 7/7 产品图片均 `complete` 且 `naturalWidth > 0`。
- 每页 4 个可见 `/discover` 入口。
- 营销页 console warning/error、pageerror、requestfailed、HTTP >= 400 均为 0。

最终增量只影响 `max-width: 374px` 的语言标签与响应 Cookie；在最终构建上又针对中文、日语、英语根页、英语 320、三语 Cookie 和产品页语言连续性补跑。英语 320 的语言区已变为完整可访问名称的图标入口，无截断、无溢出。

## 交互与无障碍

- 390px 三语手机菜单：Enter 打开，`aria-expanded=true`，dialog 可见，body 锁滚动；Escape 关闭，滚动恢复，焦点回到菜单按钮。
- Header 与 Footer 切换语言时保留当前 section hash；实点中文 `#community` → 日语后 URL 为 `/ja#community` 且 section top=68。
- 日语官网 CTA → `/discover` 后 `html lang=ja`、日语 title/H1、语言下拉选中日本語。
- 英语官网 CTA → `/discover` 后 `html lang=en`、英语 title/H1、语言下拉选中 English。
- 200% 等价门：720×450 CSS viewport + deviceScaleFactor=2，对应 1440×900 物理画布；中文与英语均 0 溢出，CTA 与键盘菜单可达。
- `prefers-reduced-motion`：媒体查询为真；动画/过渡最大 1ms；skip link 焦点可见，3px outline；菜单焦点回归通过。
- `forced-colors`：媒体查询为真；主 CTA 与 skip link 均有 3px 可见轮廓；菜单键盘流程通过。

## 冻结视觉证据

| 文件 | 尺寸 | SHA-256 | 说明 |
| --- | ---: | --- | --- |
| `docs/design/proposals/2026-07-22-spott-product-website-v1/03-full-page-rhythm-desktop.png` | 1440×5938 | `f69768b0cfc221d9e0cd1e19942e3e76b0d4f989c55964ba0bdb8a0caf9bfe8e` | 7/7 图片 decode 后回到顶部；header 只出现一次；无 skip link、重复拼接或懒加载空白 |
| `docs/design/proposals/2026-07-22-spott-product-website-v1/05-community-1440x900.png` | 1440×900 | `47789c80ca8359a9f6e6e1a46a48c711612df43ef9f02097015cde499a091fb6` | Community section top=69，真实 iOS 社群产品图完整呈现 |
| `docs/design/proposals/2026-07-22-spott-product-website-v1/06-host-1440x900.png` | 1440×900 | `3ba1142be4e23c9aa765f46ae5108227cbb817c963e3a61a694d8c704884b916` | Host section top=69，真实 Host Studio 捕获替代占位 UI |
| `docs/design/evidence/2026-07-23-marketing-browser/en-320x844.png` | 320×844 | `b1b1ea97f79b8460ebfbc97439ba1735886f9c29d461883cfcd17603af619c42` | 最终英语超窄屏，无 `Eng…` 截断 |
| `docs/design/evidence/2026-07-23-marketing-browser/en-200pct-equivalent-1440x900.png` | 1440×900 | `d6ffad5d7796926e46be45973c201152e493655768acc7c3fb8a47d3ac34039d` | 200% 等价重排物理画布 |
| `docs/design/evidence/2026-07-23-marketing-browser/zh-Hans-forced-colors-390x844.png` | 390×844 | `0c47fb6e2d312f11fa6b4600f61f2edf92e5efeb868c54d7df289baea5a34fe9` | 强制色模式下的结构、CTA 与焦点轮廓 |

## 非阻塞诊断信号

从日语或英语官网实点进入 `/discover` 时，独立自动化各观察到一次 `/api/session/bootstrap` `net::ERR_ABORTED`，但没有 HTTP >= 400、console error 或页面失败。对同一最终服务直接请求该端点得到 HTTP 200 与 `{"state":"anonymous"}`，浏览器控制台也无 warning/error。当前把它记录为导航时的取消信号，部署后的 Web + API 全栈验收需再次复核；它不影响营销页本体门禁。

## 尚未越权声明

- 概念账本仍全部保持 `PROPOSED` 或 `REJECTED`，没有擅自写入 `ACCEPTED`。
- App Store 状态保持 `unavailable`；页面不含 `apps.apple.com` 链接、官方徽章、评分或虚构下载量。
- HTTP IP 预览不是生产域名/TLS，也不证明 App Store、TestFlight、法律或真实用户研究门。
