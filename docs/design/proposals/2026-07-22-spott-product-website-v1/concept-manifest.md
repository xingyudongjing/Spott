# Spott 产品下载官网概念图事实账本

更新：2026-07-22（Asia/Tokyo）  
规格：`docs/superpowers/specs/2026-07-22-spott-product-website-design.md`  
方向：Tokyo Afterglow / Quiet Confidence

## 接受规则

- `PROPOSED`：仅是供产品所有者查看的候选图，不是已接受设计。
- `REJECTED`：产品所有者已经明确要求重做，禁止作为实现或 fidelity 基准。
- `BLOCKED`：缺少真实产品素材、可复现来源或规格要求的画面，不能进入接受状态。
- `ACCEPTED`：只在产品所有者明确接受这张具体图后使用；当前没有任何条目被标为 `ACCEPTED`。
- 产品所有者在 2026-07-22 明确指出旧社区手机产品画面需要重点优化，并表示其余当时可见页面“都还可以”。这属于页面方向反馈，不等于对本目录每个具体文件的逐张接受。
- 当前 App Store 公开查询没有 Spott 商店条目。所有概念均按 `unavailable` 处理：不显示 Apple 徽章、商店链接、评分、下载量或“立即下载”声明。

## 规格锁定矩阵

| 规格文件 | 当前文件 | 原生尺寸 | SHA-256 | 允许可见内容 | 产品截图与装饰角色 | 来源与权利记录 | 状态 | 接受人 / 日期 |
| --- | --- | ---: | --- | --- | --- | --- | --- | --- |
| `01-hero-desktop-1440x900.png` | 同名 | 1586×992 | `ad21274a6b5ceadae7e1afaf304418722ae7f8a73f8dba8523f6d44d5733597d` | Spott 品牌、相遇价值、产品预览、诚实的 Web 体验入口 | 本地 Spott Web 画面用于产品事实；东京暮色形状只承担氛围 | 本轮项目专用概念生成；未保存可重放生成 ID，真实截图尚未绑定冻结提交；禁止对外发布为最终事实图 | `PROPOSED / BLOCKED` | 待产品所有者逐图确认 |
| `02-hero-mobile-390x844.png` | 同名 | 853×1844 | `18452555f580af0bf9ce0c142ff5abb7eff57f891ee4d399ae1ec646739161e4` | 与桌面首屏相同事实，不得出现假商店按钮 | 本地 Spott 产品画面；装饰只做背景 | 同上；还需用最终 390×844 浏览器画面核对几何、清晰度和裁切 | `PROPOSED / BLOCKED` | 待产品所有者逐图确认 |
| `03-full-page-rhythm-desktop.png` | 缺失；现有 `03-community-rejected.png` 不得代替 | — | — | 全页章节节奏，不替代分节细节 | 必须由完整官网候选生成，不得把社区手机图冒充全页节奏 | 规格要求的文件尚未生成 | `BLOCKED` | — |
| — | `03-community-rejected.png` | 1586×992 | `7069c902dd513b9e31ed09717fd62addbd1ba9b99874dbfdaa6eb7d3614ce6a7` | 仅作否决证据 | 旧社区手机画面存在发灰、裁切和语言不匹配问题 | 产品所有者于 2026-07-22 明确要求重点优化 | `REJECTED` | 产品所有者 / 2026-07-22 |
| `04-before-you-go-1440x900.png` | 同名 | 1586×992 | `b960fca82e3ff9bcde4579af867802e423f314434cb8cc0396bb1aad7394c759` | 活动前关键信息、到场前准备，不得伪造活动数据 | 本地 Spott 活动详情画面；编辑形状只做层级 | 本轮项目专用概念生成；真实截图来源仍需绑定冻结提交 | `PROPOSED / BLOCKED` | 待产品所有者逐图确认 |
| `05-community-1440x900.png` | 缺失；现有 `05-community-mobile-reference.png` 仅为参考 | — | — | 三语真实社区目录或详情、完整安全区、清晰层级 | 必须使用最终 zh-Hans / ja / en iOS 实机或模拟器真实捕获 | 桌面分节概念尚未生成 | `BLOCKED` | — |
| — | `05-community-mobile-reference.png` | 853×1844 | `3b15ad8f6b71e57f60fff1344d5051714accfec97347b70f853910801ce83cf6` | 社区移动端清晰度、完整手机轮廓与不裁切方向参考 | 不可代替三语真实产品截图 | 本轮项目专用参考图；未绑定可复现产品源，因此不是产品事实 | `PROPOSED REFERENCE` | 待产品所有者查看最终真实实现 |
| `06-host-1440x900.png` | 同名 | 1586×992 | `d0025fc73f86aebba7b32b5c3e9ee24d409d5f204a4b720f523cac3367b867a0` | 只允许当前真实主办方活动管理能力 | 当前概念中的占位产品面板必须被真实 `StudioEventsClient` 捕获替换 | 本轮项目专用概念生成；当前产品证据不合格 | `PROPOSED / BLOCKED` | 待真实捕获与逐图确认 |
| `07-cross-surface-1440x900.png` | 同名 | 1586×992 | `96303abe997baa999d099baa2bbf22c6ad5d15c02ff4b9ac9459570ff8dd8cce` | 同一旅程跨 Web / App 连续，不能暗示未实现同步 | 本地 Web 与 iOS 真实状态；装饰仅连接两端 | 本轮项目专用概念生成；两端截图仍需绑定同一冻结源和 fixture | `PROPOSED / BLOCKED` | 待产品所有者逐图确认 |
| `08-japan-safety-1440x900.png` | 同名 | 1586×992 | `0a530e3680774eb51a92b8965fc5c759cb9562e0c48522b15c48ad7b1a66d2ff` | 日本语境、安全与透明边界，不作法律或平台担保 | 产品事实为文字与现有控制；氛围形状不承载事实 | 本轮项目专用概念生成；最终文案需与代码和政策边界逐项复核 | `PROPOSED / BLOCKED` | 待产品所有者逐图确认 |
| `09-final-download-footer-1440x900.png` | 同名 | 1725×912 | `0cc7ea5aae697b20e033d47a67f4d6c254c67c423e682cc2080a3cf0079ee10a` | Web 体验入口、App 尚未上架状态、三语页脚 | 不得出现非官方 Apple 徽章或虚构下载信息 | 本轮项目专用概念生成；当前状态只允许 `unavailable` | `PROPOSED / BLOCKED` | 待产品所有者逐图确认 |

## 完成条件

1. 从同一冻结源提交、同一合成 fixture 捕获 Web 发现、活动详情、社群、Host 与 iOS 三语标准字号画面。
2. 生成缺失的 `03-full-page-rhythm-desktop.png` 和 `05-community-1440x900.png`，用真实 Host 捕获更新 `06`，并保留被否决的 `03-community-rejected.png` 作为历史证据。
3. 浏览器在 1440×900、390×844、320、768、1024 下通过无溢出、清晰度、焦点、200% 缩放、减少动态和强制色验收。
4. 将最终浏览器截图与候选图逐节写入 fidelity ledger；产品所有者查看部署预览并明确接受后，才把对应具体条目改为 `ACCEPTED`。

