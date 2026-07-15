# Spott Cross-platform Core Journey Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 Web 与 iOS 共用真实服务端数据的“发现 → 活动详情 → 报名/候补 → 行程确认”核心旅程，并以中日英、浅深色、无障碍、自动化和真实截图证明可发布质量。

**Architecture:** PostgreSQL/PostGIS 和 OpenAPI 是活动事实的唯一来源；NestJS 在稳定游标分页前执行全部发现筛选并按权限降精度；Web 以 URL 驱动发现状态，iOS 以可编码查询和每 Tab 独立路由驱动同一旅程。视觉层使用现有 `packages/design-tokens` 的 Quiet Confidence 语义令牌，CTA 由共享的有限状态规则推导，任何客户端都不得补造坐标、主办方信誉、价格、语言、推荐理由或成功状态。

**Tech Stack:** PostgreSQL 18 + PostGIS 3.6、NestJS 11、Zod 4、OpenAPI/Redocly、Next.js 16/Vinext、React 19、TypeScript 6、MapLibre GL、Vitest/Testing Library/Playwright、Swift 6、SwiftUI/Observation/MapKit、XCTest/XCUITest。

## Global Constraints

- 实施工作区固定为 `/Users/yaokai/Code/xingyu/Spott/.worktrees/core-journey-ui`，分支固定为 `feat/core-journey-ui`。
- GitHub 只允许使用 `xingyudongjing`；提交作者为 `xingyudongjing <305336243+xingyudongjing@users.noreply.github.com>`，不得使用 `yaokai4`。
- 保留主工作区中用户已有的两份未提交文档，不从主工作区复制、覆盖或纳入本分支。
- 所有行为变更严格执行 Red → Green → Refactor；先写会失败的最小测试并记录预期失败原因，再写实现。
- 所有新增可见文案必须同时进入 `zh-Hans`、`ja`、`en` 资源；组件和服务不得返回中文展示文案代替结构化字段。
- 发现列表不允许客户端对已分页结果做会改变成员集合的二次筛选；日期、余位、形态、语言、价格和地图范围必须在 SQL `LIMIT` 之前生效。
- 发现坐标只能是约 0.01° 的 `approximate`；详情只有通过现有地址权限策略才能返回 `exact`；无点活动不得生成坐标。
- 不新增死按钮、假头像、假信誉、假成功、静态推荐或“功能已准备”占位。
- Web 与 iOS 每一屏只有一个主要动作；底部操作栏不得遮挡内容或系统安全区。
- 每项任务完成后运行该任务的窄测试并提交；阶段结束前运行全量验证和真实渲染检查。
- Node 命令统一前置 `PATH=/opt/homebrew/opt/node@24/bin:$PATH`。

---

## Task 1: 恢复可复现的 Web 构建基线

**Files:**

- Create: `tools/vite/sites-vite-plugin.ts`
- Modify: `apps/web/vite.config.ts`
- Modify: `apps/ops/vite.config.ts`
- Modify: `apps/web/package.json`
- Modify: `apps/web/tsconfig.json`
- Modify: `apps/web/app/manifest.ts`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: 记录当前 Red 基线**

Run:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/web exec tsc --noEmit --incremental false
```

Expected: FAIL，错误只包含无效 manifest `purpose`、缺少 `cloudflare:workers`/`Fetcher`/`D1Database` 类型和缺失 `./build/sites-vite-plugin`。

- [ ] **Step 2: 让 Sites 打包插件成为共享、可追踪源码**

把唯一实现放入 `tools/vite/sites-vite-plugin.ts`：`closeBundle` 时把当前 Vite root 下的 `.openai/hosting.json` 与可选 `drizzle/` 复制到 `dist/.openai/`，并对 `ENOENT` 正常降级。Web 与 Ops 的 `vite.config.ts` 都改为：

```ts
import { sites } from "../../tools/vite/sites-vite-plugin";
```

不得复制两份相同逻辑，也不得依赖主工作区的 ignored `apps/*/build` 文件。

- [ ] **Step 3: 补齐 Web Cloudflare 类型与稳定脚本**

在 `apps/web/package.json` 添加：

```json
"typecheck": "tsc --noEmit --incremental false"
```

并把与 Ops 一致的 `@cloudflare/workers-types` 加入 Web `devDependencies`；在 `apps/web/tsconfig.json` 加入：

```json
"types": ["@cloudflare/workers-types"]
```

运行 `pnpm install --lockfile-only` 更新锁文件。

- [ ] **Step 4: 修复 PWA manifest 类型**

把一个非法的 `purpose: "any maskable"` 图标拆成两个合法图标：

```ts
icons: [
  { src: "/spott-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
  { src: "/spott-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
],
```

- [ ] **Step 5: 验证 Green**

Run:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/web typecheck
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/ops typecheck
```

Expected: 两条命令均 PASS，且 `git status --short` 能看到一个共享 Sites 插件和两个 Vite import 修改。

- [ ] **Step 6: 提交基线修复**

```bash
git add tools/vite/sites-vite-plugin.ts apps/web/vite.config.ts apps/ops/vite.config.ts apps/web/package.json apps/web/tsconfig.json apps/web/app/manifest.ts pnpm-lock.yaml
git commit -m "build: restore reproducible web typecheck"
```

---

## Task 2: 建立发现查询、位置、形态、语言与信誉契约

**Files:**

- Create: `database/migrations/0016_core_journey_discovery.sql`
- Modify: `packages/contracts/openapi.yaml`
- Modify: `packages/contracts/openapi.bundle.yaml`
- Create: `services/api/src/modules/events/events.discovery-query.ts`
- Create: `services/api/src/modules/events/events.discovery-query.spec.ts`
- Modify: `services/api/src/modules/events/events.controller.ts`
- Modify: `services/api/src/modules/events/events.service.ts`

- [ ] **Step 1: 为查询解析器写 Red 测试**

新增测试覆盖：完整参数、非法 bounds、结束早于开始、不支持 locale、非法布尔值、1–100 limit。测试直接调用纯函数：

```ts
const parsed = parseDiscoveryQuery({
  q: 'coffee', region: 'tokyo', category: 'food',
  startsAfter: '2026-07-16T00:00:00.000Z',
  startsBefore: '2026-07-20T00:00:00.000Z',
  availableOnly: 'true', format: 'hybrid', language: 'ja',
  price: 'free', bounds: '139.60,35.55,139.90,35.80', limit: '24',
});
expect(parsed.bounds).toEqual({ west: 139.6, south: 35.55, east: 139.9, north: 35.8 });
```

Run:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api test -- events.discovery-query.spec.ts
```

Expected: FAIL，因为解析器尚不存在。

- [ ] **Step 2: 实现唯一查询类型与解析器**

`events.discovery-query.ts` 导出：

```ts
export type EventFormat = 'in_person' | 'online' | 'hybrid';
export type EventLocale = 'zh-Hans' | 'ja' | 'en';
export type EventPriceFilter = 'free' | 'paid';
export interface MapBounds { west: number; south: number; east: number; north: number }
export interface DiscoveryQuery {
  query?: string; region?: string; category?: string;
  startsAfter?: Date; startsBefore?: Date; availableOnly?: boolean;
  format?: EventFormat; language?: EventLocale; price?: EventPriceFilter;
  bounds?: MapBounds; cursor?: string; limit: number;
}
export function parseDiscoveryQuery(input: Record<string, string | undefined>): DiscoveryQuery;
```

`events.controller.ts` 的 `/discovery/feed` 和 `/events/search` 都把 `@Query()` 交给同一解析器；feed 不再丢失高级筛选。

- [ ] **Step 3: 为真实事件字段增加迁移**

迁移必须：

```sql
ALTER TABLE events.events
  ADD COLUMN format text NOT NULL DEFAULT 'in_person',
  ADD COLUMN primary_locale text NOT NULL DEFAULT 'ja',
  ADD COLUMN supported_locales text[] NOT NULL DEFAULT ARRAY['ja']::text[],
  ADD COLUMN locale_confirmed_at timestamptz;

ALTER TABLE events.events
  ADD CONSTRAINT events_format_check CHECK (format IN ('in_person','online','hybrid')),
  ADD CONSTRAINT events_primary_locale_check CHECK (primary_locale IN ('zh-Hans','ja','en')),
  ADD CONSTRAINT events_supported_locales_check CHECK (
    cardinality(supported_locales) BETWEEN 1 AND 3
    AND primary_locale = ANY(supported_locales)
    AND supported_locales <@ ARRAY['zh-Hans','ja','en']::text[]
  );

CREATE INDEX events_discovery_locale_idx
  ON events.events(primary_locale, starts_at, id)
  WHERE deleted_at IS NULL AND locale_confirmed_at IS NOT NULL;
```

旧事件保留 `locale_confirmed_at IS NULL`，因此普通发现仍可出现，但显式语言筛选不得命中。

- [ ] **Step 4: 扩展 OpenAPI**

新增结构化 schema：

```yaml
EventCoordinate:
  type: object
  required: [latitude, longitude, precision]
  properties:
    latitude: { type: number, format: double, minimum: -90, maximum: 90 }
    longitude: { type: number, format: double, minimum: -180, maximum: 180 }
    precision: { type: string, enum: [approximate, exact] }
OrganizerTrust:
  type: object
  required: [phoneVerified, completedEventCount, attendanceRateBand]
  properties:
    phoneVerified: { type: boolean }
    completedEventCount: { type: integer, minimum: 0 }
    attendanceRateBand: { type: string, enum: [unavailable, under_70, 70_89, 90_plus] }
```

`EventSummary` 加 `format`、`primaryLocale`、`supportedLocales`、`localeConfirmed`、nullable `coordinate`、结构化 `organizer.trust` 和结构化费用；`EventDetail.coordinate` 描述权限精度。发现路径声明全部查询参数，`EventPage.required` 加 `queryExplanationId`。

- [ ] **Step 5: 验证 contract Green 并生成 bundle**

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm contract:lint
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm contract:bundle
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api test -- events.discovery-query.spec.ts
```

Expected: 全部 PASS，bundle 与源契约同步。

- [ ] **Step 6: 提交数据契约**

```bash
git add database/migrations/0016_core_journey_discovery.sql packages/contracts services/api/src/modules/events
git commit -m "feat(events): define real discovery contract"
```

---

## Task 3: 在分页前实现真实筛选、坐标隐私与主办方信誉

**Files:**

- Create: `services/api/src/modules/events/events.discovery-sql.ts`
- Create: `services/api/src/modules/events/events.discovery-sql.spec.ts`
- Create: `services/api/src/modules/events/events.discovery.integration.spec.ts`
- Modify: `services/api/src/modules/events/events.service.ts`
- Modify: `services/api/src/modules/events/events.service.spec.ts`
- Create: `scripts/test-postgis.ts`
- Modify: `services/api/package.json`

- [ ] **Step 1: 为 SQL 构建器写 Red 测试**

测试断言：所有成员筛选都位于 `ORDER BY/LIMIT` 前；参数化而非字符串插值；游标仍是 `(e.starts_at,e.id)`；bounds 使用 `ST_Intersects`/`ST_MakeEnvelope`；语言要求 `locale_confirmed_at IS NOT NULL`；余位判断为 `capacity IS NULL OR confirmed_count < capacity`；价格判断来自 `event_fees`。

同时为映射函数写 Red 断言：

```ts
expect(summary.coordinate?.precision).toBe('approximate');
expect(summary.coordinate).toEqual({ latitude: 35.68, longitude: 139.77, precision: 'approximate' });
expect(JSON.stringify(summary)).not.toContain('手机号已验证');
```

Run:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api test -- events.discovery-sql.spec.ts events.service.spec.ts
```

Expected: FAIL，因为结构化 SQL 和真实字段尚未实现。

- [ ] **Step 2: 构建参数化发现查询**

`events.discovery-sql.ts` 导出：

```ts
export interface DiscoveryStatement { text: string; values: unknown[] }
export function buildDiscoveryStatement(
  viewerId: string | null,
  query: DiscoveryQuery,
  cursor: { date: string; id: string } | null,
): DiscoveryStatement;
```

坐标选择必须在数据库侧降精度：

```sql
CASE WHEN l.point IS NULL THEN NULL ELSE ST_Y(ST_SnapToGrid(l.point::geometry, 0.01)) END AS latitude,
CASE WHEN l.point IS NULL THEN NULL ELSE ST_X(ST_SnapToGrid(l.point::geometry, 0.01)) END AS longitude
```

bounds 使用精确内部点筛选，但响应仍只输出降精度点。所有 query 值进入 `values`，不得拼接用户输入。

- [ ] **Step 3: 用真实身份/履约数据计算信任字段**

查询返回布尔 `phone_verified`、已结束且成功举办的 `completed_event_count`，以及在足够样本下由确认/签到聚合得到的 `attendance_rate_band`。样本不足返回 `unavailable`。`toView` 只返回：

```ts
organizer: {
  id, name, handle, viewerFollowing,
  trust: { phoneVerified, completedEventCount, attendanceRateBand },
}
```

删除 `categoryLabel`、`priceLabel`、`boundaryStatement` 等服务端中文展示文案，客户端基于结构化字段本地化。

- [ ] **Step 4: 正确输出详情坐标精度**

发现：有点即 `approximate`。详情：只有 `canSeeAddress` 为真时输出原始点和 `exact`，否则返回与发现相同的 `approximate`。无点时统一为 `null`。精确地址和在线加入信息不得进入 summary。

- [ ] **Step 5: 增加隔离 PostGIS 集成测试**

`scripts/test-postgis.ts` 只连接 `SPOTT_TEST_DATABASE_URL` 且数据库名必须以 `_test` 结尾，否则立即退出。测试临时 schema/事务覆盖：

- 日期、余位、价格、语言、形态、bounds 均在分页前过滤。
- 相同 `starts_at` 的三条记录跨页无重复、无跳项。
- 有点/无点与发现/未授权详情/授权详情三种精度。
- 未确认旧 locale 不匹配显式语言筛选。
- 信誉没有硬编码且聚合边界正确。

在本机使用隔离 PG18，不触碰正在 5432 运行的 PG16：

```bash
initdb -D /tmp/spott-pg18-core-journey
pg_ctl -D /tmp/spott-pg18-core-journey -o '-p 55433' start
createdb -p 55433 spott_core_journey_test
SPOTT_TEST_DATABASE_URL=postgres://localhost:55433/spott_core_journey_test PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api test:integration -- events.discovery.integration.spec.ts
pg_ctl -D /tmp/spott-pg18-core-journey stop
```

Expected: PASS；清理动作即使测试失败也必须执行。

- [ ] **Step 6: 运行 API 全量验证并提交**

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/domain build
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api test
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api typecheck
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm contract:lint
git add services/api scripts/test-postgis.ts
git commit -m "feat(events): filter discovery before pagination"
```

---

## Task 4: 建立跨客户端查询模型和 CTA 状态机

**Files:**

- Create: `apps/web/app/lib/discovery-query.ts`
- Create: `apps/web/app/lib/event-cta.ts`
- Create: `apps/web/app/lib/event-contract.ts`
- Create: `apps/web/tests/discovery-query.test.ts`
- Create: `apps/web/tests/event-cta.test.ts`
- Modify: `apps/web/app/lib/api.ts`
- Modify: `apps/web/app/lib/demo-data.ts`
- Modify: `apps/web/package.json`
- Create: `apps/web/vitest.config.ts`
- Modify: `Spott/Core/API/APIModels.swift`
- Modify: `Spott/Core/API/SpottAPIClient.swift`
- Create: `SpottTests/DiscoveryQueryTests.swift`
- Create: `SpottTests/EventCTAStateTests.swift`

- [ ] **Step 1: 写 Web 查询与 CTA Red 测试**

查询 round-trip 必须保留：`q`、`region`、`category`、两个日期、`availableOnly`、`format`、`language`、`price`、`bounds`、`cursor`。CTA 表驱动测试覆盖设计中的 12 个状态，输入只接受结构化 event/session 数据。

```ts
expect(resolveEventCTA(fullWaitlistEvent, signedInUser)).toEqual({
  kind: 'join_waitlist', intent: 'register', disabled: false,
});
expect(resolveEventCTA(confirmedEvent, signedInUser).kind).toBe('view_itinerary');
```

Run:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/web test:unit -- discovery-query event-cta
```

Expected: FAIL，因为模块和 test 脚本尚不存在。

- [ ] **Step 2: 实现 Web 结构化 contract**

`event-contract.ts` 定义 `EventCoordinate`、`EventFormat`、`EventLocale`、`OrganizerTrust`、`EventFee`、`EventSummary`、`EventDetail`、`EventPage`；`normalizeEvent` 改成验证/保留服务端事实，删除当前时间、免费、东京、Spott 用户、手机号已验证等可见默认值。无效必填字段应变成明确解析错误，而不是伪造内容。

`serializeDiscoveryQuery` 使用 `URLSearchParams`；快捷日期先按 `displayTimeZone` 解析成明确 ISO 区间，再发给服务端。

- [ ] **Step 3: 写 iOS 查询与 CTA Red 测试**

```swift
let query = EventDiscoveryQuery(region: "tokyo", format: .hybrid, language: .ja,
                                availableOnly: true, bounds: .init(west: 139.6, south: 35.5,
                                                                   east: 139.9, north: 35.8))
XCTAssertEqual(query.queryItems.first { $0.name == "format" }?.value, "hybrid")
XCTAssertEqual(EventCTAState.resolve(event: .fullWaitlistSample, session: .verified).kind, .joinWaitlist)
```

Run the named XCTest cases and expect compile failure before implementation.

- [ ] **Step 4: 实现 iOS contract 与 URL 编码**

新增 Codable/Hashable/Sendable 类型：

```swift
enum EventFormat: String, Codable, CaseIterable, Sendable { case inPerson = "in_person", online, hybrid }
enum EventLocale: String, Codable, CaseIterable, Sendable { case zhHans = "zh-Hans", ja, en }
enum CoordinatePrecision: String, Codable, Sendable { case approximate, exact }
struct EventCoordinate: Codable, Hashable, Sendable { let latitude: Double; let longitude: Double; let precision: CoordinatePrecision }
struct MapBounds: Codable, Hashable, Sendable { let west, south, east, north: Double }
struct EventDiscoveryQuery: Hashable, Sendable { var queryItems: [URLQueryItem] { get } }
```

`SpottAPIClient.discovery(_:)` 始终调用 `/events/search` 并使用该编码器；取消 Task 时 URLSession 请求同步取消。

- [ ] **Step 5: 验证模型 Green 并提交**

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/web test:unit
xcodebuild -project Spott.xcodeproj -scheme Spott -destination 'platform=iOS Simulator,id=82BDA2F9-2D63-4AD1-8365-1463209BF9BF' -derivedDataPath /tmp/spott-core-journey-derived test -only-testing:SpottTests/DiscoveryQueryTests -only-testing:SpottTests/EventCTAStateTests CODE_SIGNING_ALLOWED=NO
git add apps/web Spott/Core/API SpottTests
git commit -m "feat(ui): share discovery and event action semantics"
```

---

## Task 5: 实现 Web 真实发现界面与地图

**Files:**

- Create: `apps/web/app/components/discovery/DiscoveryShell.tsx`
- Create: `apps/web/app/components/discovery/DiscoveryToolbar.tsx`
- Create: `apps/web/app/components/discovery/DiscoveryFilters.tsx`
- Create: `apps/web/app/components/discovery/EventGrid.tsx`
- Create: `apps/web/app/components/discovery/EventMap.tsx`
- Create: `apps/web/app/components/discovery/DiscoveryState.tsx`
- Modify: `apps/web/app/components/DiscoverExperience.tsx`
- Modify: `apps/web/app/components/EventCard.tsx`
- Modify: `apps/web/app/components/EventCover.tsx`
- Modify: `apps/web/app/discover/page.tsx`
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/app/i18n/messages.ts`
- Create: `apps/web/tests/DiscoveryShell.test.tsx`
- Create: `apps/web/tests/EventCard.test.tsx`
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: 写发现界面 Red 组件测试**

用 Testing Library 断言：390px 首屏 DOM 顺序在搜索后立即出现第一张真实卡；筛选改变会更新 URL 和 API 查询；late response 不覆盖新查询；加载更多不会去重掩盖服务端游标错误；无 MapLibre 样式 URL 时不出现地图切换；有坐标只渲染真实 marker；错误时保留旧列表并显示 live region。

- [ ] **Step 2: 将状态改为 URL 驱动、可取消请求**

`DiscoveryShell` 仅持有 `EventPage`、pending/error、selected event 和 list/map mode；筛选从 URL 解析。搜索 300ms 防抖，每个请求拥有 `AbortController`：

```ts
requestRef.current?.abort();
const controller = new AbortController();
requestRef.current = controller;
const page = await searchEvents(query, { signal: controller.signal });
if (!controller.signal.aborted) setPage(page);
```

删除现有 `filtered`/`tokyoParts` 客户端成员过滤和硬编码 categories/regions 三语对象，选项标签由 i18n key 提供。

- [ ] **Step 3: 实现 Quiet Confidence 首屏**

桌面：紧凑标题/搜索/地区/列表地图切换，下面立即是两栏或三栏 Event Grid；不使用大 Hero。移动：360px 高度内出现第一张卡的标题或封面。卡片显示本地化时间、公开区域、结构化价格、format、语言确认状态、余位/候补和真实 organizer trust；无 cover 使用类别占位，不造摄影图。

- [ ] **Step 4: 懒加载 MapLibre 适配层**

仅在 `NEXT_PUBLIC_MAP_STYLE_URL` 存在且用户切换地图时 `dynamic import('maplibre-gl')`。marker 只来自非空 `coordinate`，`precision === 'approximate'` 显示本地化“约在此区域”。地图和列表共享 `EventDiscoveryQuery`；移动/缩放完成后更新 `bounds` URL。无坐标活动仍留在旁边列表。

- [ ] **Step 5: 完成响应式、深浅色、键盘与减少动态**

CSS 值映射 design tokens：12 control、18 card、24 cover、28 panel；交互 44px；焦点可见；390/768/1440 无横向滚动；`prefers-reduced-motion` 将过渡降至 1ms；`prefers-contrast` 加强边界。

- [ ] **Step 6: 验证与提交 Web 发现**

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/web test:unit -- DiscoveryShell EventCard
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/web typecheck
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/web lint
git add apps/web
git commit -m "feat(web): deliver real discovery experience"
```

---

## Task 6: 实现 Web 详情、报名与行程闭环

**Files:**

- Create: `apps/web/app/components/event/EventFacts.tsx`
- Create: `apps/web/app/components/event/OrganizerTrust.tsx`
- Create: `apps/web/app/components/event/EventActionBar.tsx`
- Create: `apps/web/app/components/registration/RegistrationForm.tsx`
- Create: `apps/web/app/components/registration/RegistrationConfirmation.tsx`
- Modify: `apps/web/app/e/[slug]/page.tsx`
- Modify: `apps/web/app/e/[slug]/EventActions.tsx`
- Modify: `apps/web/app/register/[slug]/RegistrationFlow.tsx`
- Modify: `apps/web/app/me/events/MyEventsClient.tsx`
- Modify: `apps/web/app/i18n/messages.ts`
- Modify: `apps/web/app/globals.css`
- Create: `apps/web/tests/EventDetail.test.tsx`
- Create: `apps/web/tests/RegistrationFlow.test.tsx`
- Create: `apps/web/tests/MyEventsClient.test.tsx`

- [ ] **Step 1: 写 CTA、事实区和表单 Red 测试**

覆盖 12 种 CTA、七个首屏事实、地址精度、语言未确认、真实 trust、字段错误聚焦、登录/手机 Gate return URL、quote、固定幂等键、防重复提交、409 冲突刷新、离线不成功、确认页和新报名进入正确行程分组。

- [ ] **Step 2: 重构活动详情为可扫描事实层级**

桌面用主内容 + sticky 报名卡；移动用 `safe-area-inset-bottom` Action Bar。首屏按结构化字段回答标题、时间、位置、价格、主办方、名额、语言。只有 `coordinate.precision === 'exact'` 或 `exactAddress` 授权时显示精确信息；否则明确约略区域。空反馈不显示星级。

- [ ] **Step 3: 实现可恢复报名意图**

未登录跳转 `/login?returnTo=/register/{slug}`；未验证跳转 `/phone-verification?returnTo=...`；返回后恢复人数、答案和当前步骤。quote 变化刷新最终摘要；同一次提交保存一个 idempotency key，失败重试复用它，成功后才清除。

- [ ] **Step 4: 实现完整确认页与行程同步**

确认页显示 confirmed/pending/waitlisted、时间、公开地点、人数、日历、分享、查看行程。行程页以服务端 registrations 为准分为 pending、waitlist、upcoming、past；每卡只有一个下一步，点击进入真实详情。

- [ ] **Step 5: 验证并提交 Web 闭环**

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/web test:unit -- EventDetail RegistrationFlow MyEventsClient
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/web typecheck
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/web lint
git add apps/web
git commit -m "feat(web): complete registration and itinerary journey"
```

---

## Task 7: 修复 iOS 每 Tab 独立导航与 Gate 意图恢复

**Files:**

- Modify: `Spott/App/AppModel.swift`
- Modify: `Spott/App/AppRootView.swift`
- Create: `Spott/App/AppRouter.swift`
- Modify: `Spott/Features/Auth/GateView.swift`
- Modify: `Spott/Features/Activities/MyActivitiesView.swift`
- Modify: `Spott/Features/Profile/ProfileViews.swift`
- Create: `SpottTests/AppRouterTests.swift`

- [ ] **Step 1: 写路由 Red 测试**

测试每个 Tab 保留独立 path；从行程和个人页打开活动写入当前可见 path；事件 deep link 先切换目标 Tab 再追加；login/phone Gate 完成后执行一次原报名 intent，取消 Gate 回到原详情且不丢路径。

- [ ] **Step 2: 实现集中 Router**

```swift
@MainActor @Observable final class AppRouter {
    var selectedTab: AppTab = .discovery
    var paths: [AppTab: [AppRoute]] = Dictionary(uniqueKeysWithValues: AppTab.allCases.map { ($0, []) })
    var deferredRegistrationIntent: DeferredRegistrationIntent?
    func show(event: EventSummary, in tab: AppTab? = nil)
    func open(url: URL) async
    func resumeDeferredIntent(after gate: AppGate)
}
```

`AppRootView` 的五个 `NavigationStack` 全部绑定对应 path 并注册同一 destination。删除 `discoveryPath` 单路径和所有绕过 Router 的 append。

- [ ] **Step 3: 验证路由 Green 并提交**

```bash
xcodebuild -project Spott.xcodeproj -scheme Spott -destination 'platform=iOS Simulator,id=82BDA2F9-2D63-4AD1-8365-1463209BF9BF' -derivedDataPath /tmp/spott-core-journey-derived test -only-testing:SpottTests/AppRouterTests CODE_SIGNING_ALLOWED=NO
git add Spott/App Spott/Features/Auth Spott/Features/Activities Spott/Features/Profile SpottTests/AppRouterTests.swift
git commit -m "fix(ios): preserve navigation and registration intent"
```

---

## Task 8: 实现 iOS 真实发现、筛选与 MapKit

**Files:**

- Create: `Spott/Features/Discovery/DiscoveryStore.swift`
- Modify: `Spott/Features/Discovery/DiscoveryView.swift`
- Create: `Spott/Features/Discovery/DiscoveryToolbar.swift`
- Create: `Spott/Features/Discovery/DiscoveryFiltersView.swift`
- Create: `Spott/Features/Discovery/EventCardView.swift`
- Create: `Spott/Features/Discovery/EventMapView.swift`
- Create: `Spott/Features/Discovery/DiscoveryStateView.swift`
- Modify: `Spott/DesignSystem/SpottTheme.swift`
- Create: `SpottTests/DiscoveryStoreTests.swift`

- [ ] **Step 1: 写 DiscoveryStore Red 测试**

注入可控 API 协议，测试 300ms 防抖、取消旧请求、晚响应不覆盖、分页附加、刷新失败保留缓存、筛选完全编码到服务端、地图 bounds 更新、无坐标不产生 annotation。明确删除当前基于 `enumerated()`/数组下标生成经纬度的逻辑。

- [ ] **Step 2: 实现可测试 Store**

```swift
@MainActor @Observable final class DiscoveryStore {
    var query = EventDiscoveryQuery()
    var page = DiscoveryPage.empty
    var phase: LoadPhase = .initial
    var mode: DiscoveryMode = .list
    private var searchTask: Task<Void, Never>?
    func update(_ mutation: (inout EventDiscoveryQuery) -> Void)
    func load(reset: Bool) async
    func loadNextPage() async
}
```

Store 取消旧 Task；失败且已有内容时保留列表并显示刷新 banner；客户端不再按 category/date/availability 过滤 page.items。

- [ ] **Step 3: 重组原生发现 UI**

首屏是紧凑 top bar、搜索和横向 chips，随后立即出现真实活动卡。卡片使用结构化 format/language/fee/trust/status；字体改为语义 Dynamic Type。加载、空、错误、离线统一状态组件。

- [ ] **Step 4: MapKit 只使用真实坐标**

`EventMapView` 的 annotations 为 `events.compactMap(\.coordinate)`；approximate marker 的 accessibility label 包含“约略区域”；提供等价列表 Sheet；地图相机稳定后把 bounds 发到服务端。无坐标活动只在列表出现。

- [ ] **Step 5: 验证并提交 iOS 发现**

```bash
xcodebuild -project Spott.xcodeproj -scheme Spott -destination 'platform=iOS Simulator,id=82BDA2F9-2D63-4AD1-8365-1463209BF9BF' -derivedDataPath /tmp/spott-core-journey-derived test -only-testing:SpottTests/DiscoveryStoreTests CODE_SIGNING_ALLOWED=NO
git add Spott/Features/Discovery Spott/DesignSystem SpottTests/DiscoveryStoreTests.swift
git commit -m "feat(ios): deliver real discovery and map"
```

---

## Task 9: 实现 iOS 详情、报名与行程闭环

**Files:**

- Create: `Spott/Features/EventDetail/EventDetailStore.swift`
- Modify: `Spott/Features/EventDetail/EventDetailView.swift`
- Create: `Spott/Features/EventDetail/EventFactsView.swift`
- Create: `Spott/Features/EventDetail/OrganizerTrustView.swift`
- Create: `Spott/Features/EventDetail/EventActionBar.swift`
- Create: `Spott/Features/Registration/RegistrationStore.swift`
- Create: `Spott/Features/Registration/RegistrationFlowView.swift`
- Create: `Spott/Features/Registration/RegistrationConfirmationView.swift`
- Create: `Spott/Features/Activities/MyActivitiesStore.swift`
- Modify: `Spott/Features/Activities/MyActivitiesView.swift`
- Create: `SpottTests/EventDetailStoreTests.swift`
- Create: `SpottTests/RegistrationStoreTests.swift`
- Create: `SpottTests/MyActivitiesStoreTests.swift`

- [ ] **Step 1: 写三个 Store 的 Red 测试**

覆盖详情刷新/地址权限/12 CTA；报名 quote、固定幂等键、问题校验、重复点击、409 刷新、离线失败、Gate 恢复、confirmed/pending/waitlisted 完成态；行程正确分组和唯一下一步。

- [ ] **Step 2: 实现详情事实区与安全区 CTA**

保持标题、时间、公开地点、format、语言、费用、容量在首屏可扫描。Action Bar 使用 `.safeAreaInset(edge: .bottom)`，不会覆盖说明最后一段；只显示 `EventCTAState` 推导的一个主动作。

- [ ] **Step 3: 实现原生报名表单和确认态**

短表单渐进分组，长表单 NavigationStack 分步；错误字段使用 `@FocusState` 聚焦并发送 VoiceOver layout changed；提交期间按钮禁用；错误保留输入。成功使用完整 confirmation view，不以 Toast 代替。

- [ ] **Step 4: 实现服务端驱动行程**

`MyActivitiesStore` 从 `api.registrations` 读取，报名成功后立即 refresh；pending/waitlist/upcoming/past 卡片进入当前 `.activities` 路由栈；候补接受/取消等已有动作保留并刷新。

- [ ] **Step 5: 验证并提交 iOS 闭环**

```bash
xcodebuild -project Spott.xcodeproj -scheme Spott -destination 'platform=iOS Simulator,id=82BDA2F9-2D63-4AD1-8365-1463209BF9BF' -derivedDataPath /tmp/spott-core-journey-derived test -only-testing:SpottTests/EventDetailStoreTests -only-testing:SpottTests/RegistrationStoreTests -only-testing:SpottTests/MyActivitiesStoreTests CODE_SIGNING_ALLOWED=NO
git add Spott/Features/EventDetail Spott/Features/Registration Spott/Features/Activities SpottTests
git commit -m "feat(ios): complete registration and itinerary journey"
```

---

## Task 10: 收口三语、主题和无障碍质量门

**Files:**

- Modify: `apps/web/app/i18n/messages.ts`
- Create: `apps/web/tests/i18n-parity.test.ts`
- Modify: `apps/web/app/layout.tsx`
- Modify: `apps/web/app/globals.css`
- Modify: `Spott/Resources/en.lproj/Localizable.strings`
- Modify: `Spott/Resources/ja.lproj/Localizable.strings`
- Modify: `Spott/Resources/zh-Hans.lproj/Localizable.strings`
- Create: `SpottTests/LocalizationParityTests.swift`
- Modify: `Spott/SpottApp.swift`
- Modify: `Spott/DesignSystem/SpottTheme.swift`

- [ ] **Step 1: 写三语键集合 Red 测试**

Web 测试递归比较三套 message key、拒绝空值；iOS 测试解析三个 `.strings` 文件，比较键集合并检查新增核心旅程键非空。另用源码扫描拒绝核心旅程文件中的直接中文 UI literal（样例/用户内容除外）。

- [ ] **Step 2: 集中全部动态文案和格式化**

Web aria/metadata/state/form/CTA 全部使用集中 key；iOS 静态 Text 使用 localization key，动态 CTA/复数/日期/日元通过 `String(localized:)`、`Date.FormatStyle`、`CurrencyFormatStyle`。用户标题/描述保持原文。

- [ ] **Step 3: 启用系统深浅色与语义字体**

删除 `SpottApp.swift` forced light；Web 和 iOS 色值映射到 design tokens。iOS 固定字号改成 `.title/.headline/.body/.caption` 或 `@ScaledMetric`；Web 200% zoom 不截断。

- [ ] **Step 4: 完成无障碍行为**

Web：landmark/headings、label/description/error association、dialog focus trap/Escape/restore、live region、44px target。iOS：VoiceOver 顺序、简洁卡片 label、44pt target、Reduce Motion、地图等价列表、最大辅助字号可完成报名。

- [ ] **Step 5: 验证并提交质量门**

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/web test:unit -- i18n-parity
xcodebuild -project Spott.xcodeproj -scheme Spott -destination 'platform=iOS Simulator,id=82BDA2F9-2D63-4AD1-8365-1463209BF9BF' -derivedDataPath /tmp/spott-core-journey-derived test -only-testing:SpottTests/LocalizationParityTests CODE_SIGNING_ALLOWED=NO
git add apps/web Spott/Resources Spott/SpottApp.swift Spott/DesignSystem SpottTests/LocalizationParityTests.swift
git commit -m "feat(ui): complete trilingual accessible theming"
```

---

## Task 11: 自动化真实旅程和视觉证据

**Files:**

- Modify: `playwright.config.ts`
- Create: `tests/e2e/core-journey.spec.ts`
- Create: `tests/e2e/fixtures/core-journey.ts`
- Modify: `SpottUITests/SpottUITests.swift`
- Create: `docs/quality/core-journey-screenshot-matrix.md`
- Create: `docs/quality/core-journey/README.md`
- Modify: `.gitignore`

- [ ] **Step 1: 写 Web E2E Red 路径**

固定测试数据通过 API/数据库 fixture 建立，覆盖访客发现 → 筛选 → 详情 → 登录恢复 → 手机验证恢复 → 报名/候补 → 确认 → 行程。测试不得拦截成静态页面；只可对后端建立可重复 fixture。

- [ ] **Step 2: 增加状态与视觉矩阵**

Playwright 覆盖 loading、empty、refresh error with stale content、offline、full、waitlist、pending、confirmed、409 changed event；截图矩阵为三语 × 浅/深 × 390/768/1440 的发现/详情/报名/确认关键页。键盘和 reduced motion 独立断言。

- [ ] **Step 3: 写 iOS XCUITest 真实路径**

使用 launch arguments 指向隔离 API fixture；覆盖发现 → 详情 → Gate → 报名 → 行程，并验证每 Tab 路径。截图至少覆盖中日英、浅深、小/大 iPhone、最大 Dynamic Type、Reduce Motion。UI 测试先单 worker 执行，解决此前 runner materialization 不稳定后才增加并发。

- [ ] **Step 4: 运行真实渲染并人工复核**

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm test:e2e -- tests/e2e/core-journey.spec.ts --workers=1
xcodebuild -project Spott.xcodeproj -scheme Spott -destination 'platform=iOS Simulator,id=82BDA2F9-2D63-4AD1-8365-1463209BF9BF' -derivedDataPath /tmp/spott-core-journey-ui-derived test -only-testing:SpottUITests -parallel-testing-enabled NO CODE_SIGNING_ALLOWED=NO
```

人工复核每张截图：390px/iPhone 首屏看到真实活动；单一主操作；sticky/safe-area 不遮挡；三语无截断；深色对比；无假坐标/假头像/假信誉/假成功/死按钮。结果写入 screenshot matrix，失败项修复后重跑。

- [ ] **Step 5: 提交 E2E 与质量证据**

```bash
git add playwright.config.ts tests/e2e SpottUITests docs/quality .gitignore
git commit -m "test(ui): prove cross-platform core journey"
```

---

## Task 12: 全量验证、代码评审与发布分支

**Files:**

- Modify only files required by verification/review findings.

- [ ] **Step 1: 运行合同/API/Web 全量门**

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm contract:lint
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm contract:bundle
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/domain build
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api test
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api typecheck
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/web test:unit
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/web typecheck
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/web lint
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/web build
```

Expected: 全部 exit 0；OpenAPI bundle 无漂移。

- [ ] **Step 2: 运行 iOS 全量单元与 UI 门**

```bash
xcodebuild -project Spott.xcodeproj -scheme Spott -destination 'platform=iOS Simulator,id=82BDA2F9-2D63-4AD1-8365-1463209BF9BF' -derivedDataPath /tmp/spott-core-journey-derived test -only-testing:SpottTests CODE_SIGNING_ALLOWED=NO
xcodebuild -project Spott.xcodeproj -scheme Spott -destination 'platform=iOS Simulator,id=82BDA2F9-2D63-4AD1-8365-1463209BF9BF' -derivedDataPath /tmp/spott-core-journey-ui-derived test -only-testing:SpottUITests -parallel-testing-enabled NO CODE_SIGNING_ALLOWED=NO
```

Expected: 全部 exit 0，保存 `.xcresult` 路径与关键截图。

- [ ] **Step 3: 执行规范与实现双重评审**

逐条核对设计文档第 15/16 节；评审重点为服务端分页前筛选、坐标隐私、无假字段、Gate 恢复、每 Tab 路由、三语 parity、深色/无障碍、真实渲染证据。所有 P0/P1 finding 必须修复并重跑相关测试；P2 必须明确处理或记录为后续批次且不得破坏本批完成定义。

- [ ] **Step 4: 检查提交身份与工作树**

```bash
git config user.name
git config user.email
gh auth status
git status --short
git log --format='%h %an <%ae> %s' origin/main..HEAD
```

Expected: 身份只显示 `xingyudongjing`；无意外未提交文件；提交不包含主工作区用户文档。

- [ ] **Step 5: 推送功能分支**

```bash
git push -u origin feat/core-journey-ui
```

Expected: 推送到 `https://github.com/xingyudongjing/Spott.git` 成功。该批完成只代表核心旅程完成；随后继续 Host Studio、票务/会员、群组/消息、团队/营销/分析、AI/安全和 Ops 批次，直到产品审计文档全部关闭。
