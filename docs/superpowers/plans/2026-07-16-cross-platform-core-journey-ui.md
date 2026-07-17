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
- Create: `apps/web/worker-configuration.d.ts`
- Modify: `apps/web/app/manifest.ts`
- Modify: `pnpm-lock.yaml`

- [x] **Step 1: 记录当前 Red 基线**

Run:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/web exec tsc --noEmit --incremental false
```

Expected: FAIL，错误只包含无效 manifest `purpose`、缺少 `cloudflare:workers`/`Fetcher`/`D1Database` 类型和缺失 `./build/sites-vite-plugin`。

- [x] **Step 2: 让 Sites 打包插件成为共享、可追踪源码**

把唯一实现放入 `tools/vite/sites-vite-plugin.ts`：`closeBundle` 时把当前 Vite root 下的 `.openai/hosting.json` 与可选 `drizzle/` 复制到 `dist/.openai/`，并对 `ENOENT` 正常降级。Web 与 Ops 的 `vite.config.ts` 都改为：

```ts
import { sites } from "../../tools/vite/sites-vite-plugin";
```

不得复制两份相同逻辑，也不得依赖主工作区的 ignored `apps/*/build` 文件。

- [x] **Step 3: 补齐 Web Cloudflare 类型与稳定脚本**

在 `apps/web/package.json` 添加：

```json
"typecheck": "tsc --noEmit --incremental false"
```

并把与 Ops 一致的 `@cloudflare/workers-types` 加入 Web `devDependencies`；在 `apps/web/tsconfig.json` 加入：

```json
"types": ["@cloudflare/workers-types"]
```

创建 Web 自己的 worker binding 声明，避免引用 Ops 类型造成跨应用耦合：

```ts
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
  }
}
```

运行 `pnpm install --lockfile-only` 更新锁文件。

- [x] **Step 4: 修复 PWA manifest 类型**

把一个非法的 `purpose: "any maskable"` 图标拆成两个合法图标：

```ts
icons: [
  { src: "/spott-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
  { src: "/spott-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
],
```

- [x] **Step 5: 验证 Green**

Run:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/web typecheck
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/ops typecheck
```

Expected: 两条命令均 PASS，且 `git status --short` 能看到一个共享 Sites 插件和两个 Vite import 修改。

- [x] **Step 6: 提交基线修复**

```bash
git add tools/vite/sites-vite-plugin.ts apps/web/vite.config.ts apps/ops/vite.config.ts apps/web/package.json apps/web/tsconfig.json apps/web/worker-configuration.d.ts apps/web/app/manifest.ts pnpm-lock.yaml
git commit -m "build: restore reproducible web typecheck"
```

---

## Task 2: 建立发现查询、位置、形态、语言与信誉契约

**Files:**

- Create: `database/migrations/0016_core_journey_discovery.sql`
- Modify: `packages/contracts/openapi.yaml`
- Modify: `packages/contracts/openapi.bundle.yaml`
- Modify: `packages/api-client/src/schema.d.ts`
- Create: `services/api/src/modules/events/events.discovery-query.ts`
- Create: `services/api/src/modules/events/events.discovery-query.spec.ts`
- Modify: `services/api/src/modules/events/events.controller.ts`
- Modify: `services/api/src/modules/events/events.service.ts`

- [x] **Step 1: 为查询解析器写 Red 测试**

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

- [x] **Step 2: 实现唯一查询类型与解析器**

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

- [x] **Step 3: 为真实事件字段增加迁移**

迁移必须使用一个 immutable helper 同时阻止越界 locale、缺少 primary 和重复 locale；普通 `cardinality + <@` 不足以阻止 `['ja','ja']`：

```sql
ALTER TABLE events.events
  ADD COLUMN format text NOT NULL DEFAULT 'in_person',
  ADD COLUMN primary_locale text NOT NULL DEFAULT 'ja',
  ADD COLUMN supported_locales text[] NOT NULL DEFAULT ARRAY['ja']::text[],
  ADD COLUMN locale_confirmed_at timestamptz;

ALTER TABLE events.events
  ADD CONSTRAINT events_format_check CHECK (format IN ('in_person','online','hybrid')),
  ADD CONSTRAINT events_primary_locale_check CHECK (primary_locale IN ('zh-Hans','ja','en')),
  ADD CONSTRAINT events_supported_locales_check
    CHECK (events.valid_event_locales(supported_locales, primary_locale));

CREATE INDEX events_discovery_locale_idx
  ON events.events(primary_locale, starts_at, id)
  WHERE deleted_at IS NULL AND locale_confirmed_at IS NOT NULL;
```

旧事件保留 `locale_confirmed_at IS NULL`，因此普通发现仍可出现，但显式语言筛选不得命中。

其中 helper 的行为必须等价于：

```sql
SELECT cardinality(locales) BETWEEN 1 AND 3
  AND locales <@ ARRAY['zh-Hans','ja','en']::text[]
  AND primary_locale = ANY(locales)
  AND cardinality(locales) = (SELECT count(DISTINCT locale) FROM unnest(locales) AS locale);
```

同时给 `draftSchema`、`EventDraftInput`、OpenAPI `EventDraftInput` 与 `createDraft`/`update` 保存路径加入：

```text
format: in_person | online | hybrid
primaryLocale: zh-Hans | ja | en
supportedLocales: 1...3 个不重复 locale，且包含 primaryLocale
coordinate: optional { latitude: -90...90, longitude: -180...180 }（输入不含 precision）
```

`primaryLocale` 与 `supportedLocales` 是原子字段组：请求必须两者都省略或两者同时出现；只出现一个返回 400。两者都省略时，create 使用迁移默认且保持 `locale_confirmed_at = NULL`，update 保留现值和原确认时间；两者同时出现并验证通过时才保存两字段并写 `locale_confirmed_at = clock_timestamp()`。缺省迁移值不得自动变成“主办方已确认”。

- [x] **Step 4: 扩展 OpenAPI**

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

`EventSummary` 加 `format`、`primaryLocale`、`supportedLocales`、`localeConfirmed`、nullable `coordinate`、结构化 `organizer.trust` 和结构化费用；`EventDetail.coordinate` 描述权限精度。发现路径声明全部查询参数，`EventPage.required` 加 `queryExplanationId`。完整形态固定为：

```text
EventFee (all required):
  isFree: boolean
  amountJPY: integer|null
  collectorName: string|null
  method: string|null
  paymentDeadlineText: string|null
  refundPolicy: string|null

EventOrganizer (all required):
  id: UUID
  name: string
  handle: string
  viewerFollowing: boolean
  trust: OrganizerTrust

ViewerRegistration (all required):
  id: UUID
  status: pending|confirmed|waitlisted|offered|checked_in
  partySize: integer >= 1
  offerExpiresAt: date-time|null

EventSummary required:
  id, publicSlug, organizerId, status, title, description, category,
  startsAt|null, endsAt|null, deadlineAt|null, displayTimeZone,
  region, publicArea, capacity, confirmedCount, availableCapacity, fee, coverURL|null,
  tags, organizer, favorited, registrationStatus|null, viewerRegistration|null, registrationMode,
  waitlistEnabled, format, primaryLocale, supportedLocales,
  localeConfirmed, coordinate|null, availableActions, version, updatedAt

EventDetail required in addition to EventSummary:
  exactAddress|null, attendeeRequirements|null, riskFlags, riskDetails,
  exactAddressVisibility, registrationQuestions, media, mediaCount
```

`EventSummary.coordinate` 的 schema 只允许 `precision: approximate`；`EventDetail.coordinate` 允许 `approximate|exact`。保留结构化 `availableActions`、`deadlineAt` 等客户端权限/状态输入；只删除 `priceLabel`、`boundaryStatement`、`categoryLabel` 和 `organizer.reliability` 这些服务端展示文案。

- [x] **Step 5: 验证 contract Green 并生成 bundle**

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm contract:lint
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm contract:bundle
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api-client generate
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api-client typecheck
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api test -- events.discovery-query.spec.ts
```

Expected: 全部 PASS，bundle 与 `packages/api-client/src/schema.d.ts` 都和源契约同步；`git diff --exit-code -- packages/contracts/openapi.bundle.yaml packages/api-client/src/schema.d.ts` 在生成文件已暂存/提交的验证阶段为零漂移。

- [x] **Step 6: 提交数据契约**

```bash
git add database/migrations/0016_core_journey_discovery.sql packages/contracts packages/api-client/src/schema.d.ts services/api/src/modules/events
git commit -m "feat(events): define real discovery contract"
```

---

## Task 3: 在分页前实现真实筛选、坐标隐私与主办方信誉

**Files:**

- Create: `database/migrations/0017_event_completion_fact.sql`
- Create: `services/api/src/modules/events/events.discovery-sql.ts`
- Create: `services/api/src/modules/events/events.discovery-sql.spec.ts`
- Create: `services/api/src/modules/events/events.discovery.integration.spec.ts`
- Create: `services/api/vitest.config.ts`
- Create: `services/api/vitest.integration.config.ts`
- Modify: `services/api/src/modules/events/events.service.ts`
- Modify: `services/api/src/modules/events/events.service.spec.ts`
- Modify: `services/api/src/modules/registrations/registrations.service.ts`
- Modify: `services/api/src/modules/registrations/registrations.service.spec.ts`
- Modify: `services/worker/src/jobs.ts`
- Modify: `services/worker/test/jobs.test.ts`
- Modify: `packages/domain/src/policy.ts`
- Modify: `packages/domain/test/domain.test.ts`
- Create: `scripts/test-postgis.ts`
- Modify: `services/api/package.json`

- [x] **Step 1: 为 SQL 构建器写 Red 测试**

测试断言：所有成员筛选都位于 `ORDER BY/LIMIT` 前；参数化而非字符串插值；游标仍是 `(e.starts_at,e.id)`；bounds 使用 `ST_Intersects`/`ST_MakeEnvelope`；语言要求 `locale_confirmed_at IS NOT NULL` 且匹配 `supported_locales`；余位判断使用 `confirmed_count + pending_count + offered_count < capacity`；价格判断来自 `event_fees`。

同时为映射函数写 Red 断言：

```ts
expect(summary.availableCapacity).toBe(3);
expect(summary.coordinate?.precision).toBe('approximate');
expect(summary.coordinate).toEqual({ latitude: 35.68, longitude: 139.77, precision: 'approximate' });
expect(JSON.stringify(summary)).not.toContain('手机号已验证');
```

Run:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api test -- events.discovery-sql.spec.ts events.service.spec.ts
```

Expected: FAIL，因为结构化 SQL 和真实字段尚未实现。

- [x] **Step 2: 先修正容量和完成事实的根数据**

在 worker/registration 的现有测试中先增加多人数候补案例并观察失败：`partySize=3` 从 waitlisted → offered → accepted/expired/cancelled 时，`offered_count` 必须分别 `+3/-3`；`waitlist_count` 仍表示报名记录数所以只 `±1`。把 `services/worker/src/jobs.ts` 和 `registrations.service.ts` 的所有 offered 更新改成 party size，保证报名判满、发现余位与提交一致。

`0017_event_completion_fact.sql` 新增 nullable `events.events.completed_at`，把当前 `status='ended'` 的记录保守回填为 `COALESCE(updated_at, clock_timestamp())`，并创建 `BEFORE INSERT OR UPDATE OF status` trigger：只有进入 `ended` 时设置，之后归档仍保留；cancelled/removed/rejected → archived 永远不设置。旧 archived 无法判断来源，保持 null，不猜测成功举办。

信任口径固定：

```text
completedEventCount = organizer 的 completed_at IS NOT NULL 且 deleted_at IS NULL 的活动数
attendance sample = 这些活动中 registration.status 为 checked_in 或 no_show 的 party-size 总人数
attendance rate = checked_in party-size / sample party-size
sample < 5 => unavailable
sample >= 5 且 rate < 0.70 => under_70
0.70 <= rate < 0.90 => 70_89
rate >= 0.90 => 90_plus
```

不使用 Ops 旧 `ended|archived` 或 `final` 口径。

- [x] **Step 3: 构建参数化发现查询**

`events.discovery-sql.ts` 导出：

```ts
export interface DiscoveryStatement { text: string; values: unknown[] }
export function buildDiscoveryStatement(
  viewerId: string | null,
  query: DiscoveryQuery,
  cursor: { date: string; id: string } | null,
): DiscoveryStatement;
```

坐标选择必须在数据库侧降精度；`EventRow` 同时选择 `pending_count`、按 party-size 修正后的 `offered_count`，并映射：

```sql
CASE WHEN l.point IS NULL THEN NULL ELSE ST_Y(ST_SnapToGrid(l.point::geometry, 0.01)) END AS latitude,
CASE WHEN l.point IS NULL THEN NULL ELSE ST_X(ST_SnapToGrid(l.point::geometry, 0.01)) END AS longitude
GREATEST(0, e.capacity - COALESCE(c.confirmed_count,0) - COALESCE(c.pending_count,0) - COALESCE(c.offered_count,0)) AS available_capacity
```

bounds 使用精确内部点筛选，但响应仍只输出降精度点。所有 query 值进入 `values`，不得拼接用户输入。

- [x] **Step 4: 用真实身份/履约数据计算信任字段**

查询返回布尔 `phone_verified`、已结束且成功举办的 `completed_event_count`，以及在足够样本下由确认/签到聚合得到的 `attendance_rate_band`。样本不足返回 `unavailable`。`toView` 只返回：

```ts
organizer: {
  id, name, handle, viewerFollowing,
  trust: { phoneVerified, completedEventCount, attendanceRateBand },
}
```

删除 `categoryLabel`、`priceLabel`、`boundaryStatement` 等服务端中文展示文案，客户端基于结构化字段本地化。

同一查询返回当前 viewer 的 registration `id/status/party_size`，并从最新未处理 `events.waitlist_promotions` 取得 `offer_expires_at`；映射为 nullable `viewerRegistration`。`offered` 状态必须携带 registration id 和真实到期时间，使双端可调用既有 `/registrations/{id}/waitlist-acceptance`，不得仅凭字符串状态画不可执行 CTA。

- [x] **Step 5: 正确输出详情坐标精度、写入真实 point 并锁定地址权限矩阵**

发现：任何人有点即只得到 `approximate`，且永不返回 exact address。详情权限矩阵固定为：

| Viewer / visibility | public | confirmed |
|---|---|---|
| organizer | exact | exact |
| guest / unrelated signed-in user | exact（仅 event status 非 `removed/cancelled`） | approximate |
| pending / waitlisted / offered registration | exact（仅 event status 非 `removed/cancelled`） | approximate |
| confirmed / checked_in registration | exact（仅 event status 非 `removed/cancelled`） | exact（仅 event status 非 `removed/cancelled`） |

把 visibility 纳入 domain policy 的显式输入；`packages/domain/test/domain.test.ts` 对表中每格和 `removed/cancelled` 逐项测试。详情只有 policy 返回 true 时解密 `exactAddress` 并输出原始点 `exact`，否则返回发现同款 `approximate`。无点统一 `null`，不得生成坐标；在线加入信息不得进入 summary。

`upsertDetails` 在 draft input 含 coordinate 时使用完全参数化 SQL 写入：

```sql
ST_SetSRID(ST_MakePoint($longitude, $latitude), 4326)::geography
```

经纬度已由 Zod 契约限界，SQL 参数顺序固定 longitude 在前、latitude 在后；省略 coordinate 保留现有 point，不得清空或合成。

- [x] **Step 6: 增加隔离 PostGIS 集成测试**

`scripts/test-postgis.ts` 只连接 `SPOTT_TEST_DATABASE_URL` 且数据库名必须以 `_test` 结尾，否则立即退出。它必须用 `fileURLToPath(new URL('..', import.meta.url))` 得到仓库根，绝不能依赖调用者 `process.cwd()`；从绝对路径 `<repoRoot>/database/migrations` 按序运行全部 migration，然后以 `cwd=<repoRoot>/services/api` 启动 Vitest 和传入的 `src/...spec.ts`。`services/api/package.json` 添加：

```json
"test:integration": "tsx ../../scripts/test-postgis.ts src/modules/events/events.discovery.integration.spec.ts"
```

集成测试用事务/fixture 覆盖：

- 日期、余位、价格、语言、形态、bounds 均在分页前过滤。
- 相同 `starts_at` 的三条记录跨页无重复、无跳项。
- 有点/无点与发现/未授权详情/授权详情三种精度。
- 未确认旧 locale 不匹配显式语言筛选。
- 信誉没有硬编码且聚合边界正确。
- 多人数 pending/offered 占位影响 availableOnly/availableCapacity，且与报名服务判满一致。
- draft coordinate 能写入真实 PostGIS point，省略时保留，无点时不合成。

默认 `services/api/vitest.config.ts` 必须 exclude `**/*.integration.spec.ts`；`vitest.integration.config.ts` 只 include integration specs。这样普通 `pnpm --filter @spott/api test` 不依赖外部 PG。

在本机使用隔离 PG18，不触碰正在 5432 运行的 PG16：

```bash
PG18_BIN=/opt/homebrew/opt/postgresql@18/bin
rm -rf /tmp/spott-pg18-core-journey
"$PG18_BIN/initdb" -D /tmp/spott-pg18-core-journey
"$PG18_BIN/pg_ctl" -D /tmp/spott-pg18-core-journey -o '-p 55433' start
cleanup() { "$PG18_BIN/pg_ctl" -D /tmp/spott-pg18-core-journey stop >/dev/null 2>&1 || true; }
trap cleanup EXIT
"$PG18_BIN/createdb" -p 55433 spott_core_journey_test
SPOTT_TEST_DATABASE_URL=postgres://127.0.0.1:55433/spott_core_journey_test DATABASE_URL=postgres://127.0.0.1:55433/spott_core_journey_test PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api test:integration
```

Expected: PASS；测试脚本验证 PostGIS extension 可用，migration 成功应用；shell cleanup 用 trap 保证测试失败也停止 PG18。命令绝不调用 `/opt/homebrew/bin` 中的 PG16，也不连接 5432。

- [x] **Step 7: 运行 API/Worker 全量验证并提交**

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/domain build
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api test
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api typecheck
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/worker test
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/worker typecheck
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm contract:lint
git add database/migrations/0017_event_completion_fact.sql services/api services/worker packages/domain scripts/test-postgis.ts
git commit -m "feat(events): filter discovery before pagination"
```

---

## Task 4: 建立跨客户端查询模型和 CTA 状态机

**Files:**

- Create: `apps/web/app/lib/discovery-query.ts`
- Create: `apps/web/app/lib/event-cta.ts`
- Create: `apps/web/app/lib/event-contract.ts`
- Create: `apps/web/app/lib/events-api.ts`
- Create: `apps/web/tests/discovery-query.test.ts`
- Create: `apps/web/tests/event-cta.test.ts`
- Modify: `apps/web/app/lib/api.ts`
- Modify: `apps/web/app/lib/demo-data.ts`
- Modify: `apps/web/package.json`
- Create: `apps/web/vitest.config.ts`
- Modify: `pnpm-lock.yaml`
- Modify: `Spott/Core/API/APIModels.swift`
- Modify: `Spott/Core/API/SpottAPIClient.swift`
- Create: `SpottTests/DiscoveryQueryTests.swift`
- Create: `SpottTests/EventCTAStateTests.swift`

- [x] **Step 1: 写 Web 查询与 CTA Red 测试**

查询 round-trip 必须保留：`q`、`region`、`category`、两个日期、`availableOnly`、`format`、`language`、`price`、`bounds`、`cursor`。CTA 表驱动测试覆盖以下有序规则，输入固定为 event 的 `status`、`viewerRegistration`（含 id/status/offerExpiresAt）、`registrationMode`、`waitlistEnabled`、`capacity`、`confirmedCount`、`availableCapacity`、`deadlineAt`、`availableActions` 与 session 的 authenticated/phoneVerified；输出固定为 `{ kind, intent, disabled, registrationId?: string, offerExpiresAt?: string }`，第一条命中即为唯一 CTA。有限容量的 full 只由 `capacity > 0 && availableCapacity === 0` 判定；不得忽略 pending/offered 占位退回 `confirmedCount >= capacity`：

| Priority | Condition | kind / intent / disabled |
|---|---|---|
| 1 | status `cancelled|ended|removed` | `event_unavailable / none / true` |
| 2 | viewerRegistration.status `offered` 且 offer 未过期 | `accept_waitlist / accept_waitlist / false`，携带 registrationId/offerExpiresAt |
| 3 | viewerRegistration.status `confirmed|checked_in` | `view_itinerary / itinerary / false`，携带 registrationId |
| 4 | viewerRegistration.status `pending` | `view_pending / itinerary / false`，携带 registrationId |
| 5 | viewerRegistration.status `waitlisted` | `view_waitlist / itinerary / false`，携带 registrationId |
| 6 | guest and otherwise registrable | `continue_login / login / false` |
| 7 | signed in, phone unverified, otherwise registrable | `continue_phone_verification / phone_verification / false` |
| 8 | status/deadline/action set says registration closed | `registration_closed / none / true` |
| 9 | full and `joinWaitlist` allowed | `join_waitlist / register / false` |
| 10 | full and waitlist unavailable | `full_closed / none / true` |
| 11 | `registrationMode=approval` and `register` allowed | `apply / register / false` |
| 12 | `register` allowed | `register / register / false` |

无法命中时返回 `registration_closed / none / true`；UI 不自行放宽 `availableActions` 的服务端权限判断。

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

- [x] **Step 2: 实现 Web 结构化 contract**

`event-contract.ts` 定义 `EventCoordinate`、`EventFormat`、`EventLocale`、`OrganizerTrust`、`EventFee`、`EventSummary`、`EventDetail`、`EventPage`；`normalizeEvent` 改成验证/保留服务端事实，删除当前时间、免费、东京、Spott 用户、手机号已验证等可见默认值。无效必填字段应变成明确解析错误，而不是伪造内容。

`serializeDiscoveryQuery` 使用 `URLSearchParams`；快捷日期先按 `displayTimeZone` 解析成明确 ISO 区间，再发给服务端。

`events-api.ts` 明确导出：

```ts
export async function searchEvents(
  query: EventDiscoveryQuery,
  options?: { signal?: AbortSignal },
): Promise<EventPage>;
export async function fetchEvent(identifier: string, options?: { signal?: AbortSignal }): Promise<EventDetail>;
```

在 `apps/web/package.json` 添加：

```json
"test:unit": "vitest run"
```

并加入精确测试依赖：`vitest`、`jsdom`、`@testing-library/react`、`@testing-library/user-event`、`@testing-library/jest-dom`。`vitest.config.ts` 使用 `environment: 'jsdom'` 并加载 jest-dom setup；更新 `pnpm-lock.yaml`。

- [x] **Step 3: 写 iOS 查询与 CTA Red 测试**

```swift
let query = EventDiscoveryQuery(region: "tokyo", format: .hybrid, language: .ja,
                                availableOnly: true, bounds: .init(west: 139.6, south: 35.5,
                                                                   east: 139.9, north: 35.8))
XCTAssertEqual(query.queryItems.first { $0.name == "format" }?.value, "hybrid")
XCTAssertEqual(EventCTAState.resolve(event: .fullWaitlistSample, session: .verified).kind, .joinWaitlist)
```

Run the named XCTest cases and expect compile failure before implementation.

- [x] **Step 4: 实现 iOS contract 与 URL 编码**

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

- [x] **Step 5: 验证模型 Green 并提交**

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/web test:unit
xcodebuild -project Spott.xcodeproj -scheme Spott -destination 'platform=iOS Simulator,id=82BDA2F9-2D63-4AD1-8365-1463209BF9BF' -derivedDataPath /tmp/spott-core-journey-derived test -only-testing:SpottTests/DiscoveryQueryTests -only-testing:SpottTests/EventCTAStateTests CODE_SIGNING_ALLOWED=NO
git add apps/web Spott/Core/API SpottTests
git commit -m "feat(ui): share discovery and event action semantics"
```

---

## Task 4A: 建立无 N+1 的跨端行程摘要契约

**Files:**

- Modify: `packages/contracts/openapi.yaml`
- Modify: `packages/contracts/openapi.bundle.yaml`
- Modify: `packages/api-client/src/schema.d.ts`
- Modify: `services/api/src/modules/registrations/registrations.service.ts`
- Modify: `services/api/src/modules/registrations/registrations.service.spec.ts`
- Modify: `apps/web/app/lib/event-contract.ts`
- Create: `apps/web/tests/itinerary-contract.test.ts`
- Modify: `Spott/Core/API/APIModels.swift`
- Modify: `Spott/Core/API/SpottAPIClient.swift`
- Create: `SpottTests/ItineraryContractTests.swift`

- [x] **Step 1: 写行程契约与稳定游标 Red 测试**

`GET /me/registrations` 不得让 Web/iOS 再逐条请求活动详情。测试先断言返回每项包含 registration 与隐私安全的 `event` 摘要，同时两条相同 `updated_at` 的 registration 跨页无重复/跳项；cursor 固定编码 `(updated_at,id)`，不能只编码时间。

`ItineraryEventSummary` 只包含行程所需事实：`id/publicSlug/status/title/startsAt/endsAt/displayTimeZone/region/publicArea/coverURL/format/primaryLocale/localeConfirmed/version/updatedAt`。不返回精确地址、精确坐标、在线加入信息、报名问题或详情说明。

响应固定为：

```text
RegistrationItineraryItem: { registration: Registration, event: ItineraryEventSummary|null }
RegistrationItineraryPage: { items, nextCursor|null, hasMore, serverTime }
```

- [x] **Step 2: 用单次参数化查询返回行程摘要**

`mine` 在同一 SQL 中 join event/location/首张可见 cover 和最新未过期 promotion，按 `r.updated_at DESC,r.id DESC` 稳定分页；活动被删除/无权查看时 `event:null`，仍保留报名状态供用户理解，不静默丢项。`serverTime` 来自数据库/服务端，使 offered 到期和 upcoming/past 分组不依赖不可信设备时钟。

- [x] **Step 3: 同步 OpenAPI 与双端模型**

生成 bundle/client 后，Web Zod 与 Swift Codable 都严格解析上述结构；三端测试拒绝 exactAddress/exact coordinate/join URL 等越权字段。现有详情 API 仍在用户打开行程项后按需调用，不在列表 N+1 请求。

- [x] **Step 4: 验证并提交**

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api test -- registrations.service.spec.ts
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/web test:unit -- itinerary-contract
xcodebuild -project Spott.xcodeproj -scheme Spott -destination 'platform=iOS Simulator,id=82BDA2F9-2D63-4AD1-8365-1463209BF9BF' -derivedDataPath /tmp/spott-core-journey-derived test -only-testing:SpottTests/ItineraryContractTests CODE_SIGNING_ALLOWED=NO
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm contract:lint
git add packages/contracts packages/api-client/src/schema.d.ts services/api/src/modules/registrations apps/web/app/lib/event-contract.ts apps/web/tests/itinerary-contract.test.ts Spott/Core/API SpottTests/ItineraryContractTests.swift
git commit -m "feat(itinerary): return privacy-safe event summaries"
```

---

## Task 5: 实现 Web 真实发现界面与地图

**Visual references (read before RED):**

- `docs/design/core-journey/visual-spec.md`
- `docs/design/core-journey/web-discovery-desktop-concept.png`
- `docs/design/core-journey/discovery-mobile-concept.png`

**Files:**

- Create: `apps/web/app/components/discovery/DiscoveryShell.tsx`
- Create: `apps/web/app/components/discovery/DiscoveryToolbar.tsx`
- Create: `apps/web/app/components/discovery/DiscoveryFilters.tsx`
- Create: `apps/web/app/components/discovery/EventResults.tsx`
- Create: `apps/web/app/components/discovery/EventList.tsx`
- Create: `apps/web/app/components/discovery/EventResultCard.tsx`
- Create: `apps/web/app/components/discovery/EventMap.tsx`
- Create: `apps/web/app/components/discovery/DiscoveryState.tsx`
- Create: `apps/web/app/components/discovery/DiscoveryShell.module.css`
- Modify: `apps/web/app/components/DiscoverExperience.tsx`
- Modify: `apps/web/app/components/EventCard.tsx`
- Modify: `apps/web/app/components/EventCover.tsx`
- Modify: `apps/web/app/components/SiteHeader.tsx`
- Modify: `apps/web/app/lib/format.ts`
- Modify: `apps/web/app/page.tsx`
- Modify: `apps/web/app/discover/page.tsx`
- Modify: `apps/web/app/layout.tsx`
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/app/i18n/messages.ts`
- Modify: `apps/web/next.config.ts`
- Create: `apps/web/tests/DiscoveryShell.test.tsx`
- Create: `apps/web/tests/DiscoveryResponsive.test.tsx`
- Create: `apps/web/tests/EventMap.test.tsx`
- Create: `apps/web/tests/EventCard.test.tsx`
- Create: `apps/web/tests/SiteHeader.test.tsx`
- Create: `apps/web/tests/discovery-rendered.spec.ts`
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`

- [x] **Step 1: 写发现界面 Red 组件测试**

用 Testing Library 断言：390px 首屏 DOM 顺序在搜索后立即出现第一张真实卡；筛选改变会更新 URL 和 API 查询；late response 不覆盖新查询；加载更多不会去重掩盖服务端游标错误；无 MapLibre 样式 URL 时不出现地图切换；有坐标只渲染真实 marker；错误时保留旧列表并显示 live region。Playwright 渲染测试再断言 390×844 第一活动媒体/标题 `top <= 330`、360×800 `top <= 360`，页面无横向溢出且所有可见主交互命中区至少 44×44。

先把 `maplibre-gl` 与 `@spott/design-tokens` 加入 Web dependencies 并更新 lockfile；测试只替换 MapLibre 的 WebGL 边界，不断言 mock marker，自身断言来自真实 `EventSummary.coordinate` 到 adapter input 的行为。测试必须覆盖 `/discover` 首次 SSR 不重复请求、back/forward 恢复全部筛选、`hasMore=true` 但无 cursor 的显式 contract 错误、初始错误不与 empty 同时出现。

- [x] **Step 2: 将状态改为 URL 驱动、可取消请求**

`/discover` 在服务端解析 `searchParams` 并取得一次 `initialPage`；根路由重定向或复用同一 server helper，不维护第二套发现实现。`DiscoveryShell` 仅持有 `EventPage`、pending/error、selected event 和 list/map mode；筛选从 URL 解析。搜索 300ms 防抖，每个请求拥有 `AbortController` 与单调 request sequence：

```ts
requestRef.current?.abort();
const controller = new AbortController();
requestRef.current = controller;
const page = await searchEvents(query, { signal: controller.signal });
if (!controller.signal.aborted) setPage(page);
```

删除现有 `filtered`/`tokyoParts` 客户端成员过滤和硬编码 categories/regions 三语对象，选项标签由 i18n key 提供。popstate 恢复 URL 状态只触发一次请求；刷新失败保留旧页面，AbortError 不显示为失败；服务端返回重复 id 时不得由 UI 去重掩盖游标错误。

- [x] **Step 3: 实现 Quiet Confidence 首屏**

桌面：紧凑标题/搜索/地区/列表地图切换，下面立即是单一带边界的活动列表表面；不使用大 Hero，也不把每一项拆成漂浮 dashboard 卡。移动 Web：针对拇指与单手操作重排为高完成度内容卡，目标 y=210–260，390×844 最晚 y=330、360×800 最晚 y=360 出现第一张卡标题或封面，不是简单缩小桌面。两端都显示本地化时间、公开区域、结构化价格、format、语言确认状态、余位/候补和真实 organizer trust；无 cover 使用抽象类别占位，不造摄影图、城市、时间或活动事实。卡片只有一个整体主链接，不嵌套互相竞争的链接。

- [x] **Step 4: 懒加载 MapLibre 适配层**

仅在 `NEXT_PUBLIC_MAP_STYLE_URL` 存在且用户切换地图时 `dynamic import('maplibre-gl')`。marker 只来自非空 `coordinate`，`precision === 'approximate'` 显示本地化“约在此区域”。地图和列表共享 `EventDiscoveryQuery`；移动/缩放完成后防抖、归一化并仅在真实变化时更新 `bounds` URL，忽略首次程序化相机移动，避免 URL↔地图循环。无坐标活动仍留在旁边列表；切换/卸载移除 listeners、markers、observer 并调用 `map.remove()`；style/CORS/WebGL 失败回到仍可用的真实列表。

- [x] **Step 5: 完成响应式、深浅色、键盘与减少动态**

新旅程样式优先使用 scoped CSS module 并导入共享 design tokens，不继续堆叠全局覆盖。CSS 值映射 design tokens：12 control、18 card、24 cover、28 panel；交互 44px；焦点可见；移除 `body min-width: 320px`；360/390/768/1440 与 200% zoom 无页面级横向滚动（只允许明确 chip rail 横滚）；`prefers-reduced-motion` 将过渡降至 1ms；`prefers-contrast` 加强边界。Header/dock 当前路由带 `aria-current="page"`，移动 header 保留地区与通知；详情/报名页不得与全局 dock 叠加。

`EventCover` 使用安全的远程图片策略或首方代理，移除无理由的 `unoptimized`，提供准确 `sizes`，只有首张 LCP cover 可 priority。生产构建验证首屏 chunk 不包含 MapLibre。

- [x] **Step 6: 验证与提交 Web 发现**

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/web test:unit -- DiscoveryShell EventCard
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/web typecheck
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/web lint
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/web build
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
- Create: `apps/web/app/components/event/EventDetail.module.css`
- Create: `apps/web/app/components/registration/RegistrationFlow.module.css`
- Modify: `apps/web/app/e/[slug]/page.tsx`
- Modify: `apps/web/app/e/[slug]/EventActions.tsx`
- Modify: `apps/web/app/register/[slug]/RegistrationFlow.tsx`
- Modify: `apps/web/app/me/events/MyEventsClient.tsx`
- Modify: `apps/web/app/components/SiteHeader.tsx`
- Modify: `apps/web/app/lib/client-api.ts`
- Modify: `apps/web/app/lib/events-api.ts`
- Modify: `apps/web/app/lib/format.ts`
- Create: `apps/web/app/lib/registration-draft.ts`
- Create: `apps/web/app/lib/itinerary.ts`
- Modify: `apps/web/app/i18n/messages.ts`
- Modify: `apps/web/app/globals.css`
- Create: `apps/web/tests/EventDetail.test.tsx`
- Create: `apps/web/tests/RegistrationFlow.test.tsx`
- Create: `apps/web/tests/MyEventsClient.test.tsx`
- Create: `apps/web/tests/registration-draft.test.ts`
- Create: `apps/web/tests/itinerary.test.ts`
- Create: `apps/web/tests/registration-rendered.spec.ts`

- [ ] **Step 1: 写 CTA、事实区和表单 Red 测试**

覆盖 12 种 CTA 且每种只有一个 primary action、七个首屏事实、地址精度、语言未确认、真实 trust、字段错误聚焦、登录/手机 Gate return URL、quote、固定幂等键、防重复提交、409 冲突刷新、离线不成功、确认页和新报名进入正确行程分组。详情 JSON-LD 必须按 status/format 生成且绝不泄露或夸大私有位置；同一详情请求须缓存/合并，metadata 与页面不得重复取数。

- [ ] **Step 2: 重构活动详情为可扫描事实层级**

桌面用主内容 + sticky 报名卡；移动用 `safe-area-inset-bottom` Action Bar，并隐藏全局 dock、补足内容底部空间，避免双层底部 chrome。首屏按结构化字段回答标题、时间、位置、价格、主办方、名额、语言。只有 `coordinate.precision === 'exact'` 或 `exactAddress` 授权时显示精确信息；否则明确约略区域。空反馈不显示星级。报名页为沉浸式 route；sticky review/submit bar 依据 visual viewport 移到软键盘上方。

- [ ] **Step 3: 实现可恢复报名意图**

未登录跳转 `/login?returnTo=/register/{slug}`；未验证跳转 `/phone-verification?returnTo=...`；跳转前把人数、答案、备注、活动版本、当前步骤与逻辑幂等键写入带版本号、按 event id/version 隔离的 `sessionStorage` 草稿，返回后完整恢复。quote 变化/过期时刷新最终摘要；同一次提交由调用方保存一个 idempotency key，网络失败与 409 流程复用，成功或明确重新开始后才清除。API 字段错误关联稳定 input id/`aria-describedby` 并聚焦第一个错误；409 保留答案、展示变化并要求重新确认。

- [ ] **Step 4: 实现完整确认页与行程同步**

确认页显示 confirmed/pending/waitlisted 的不同文案与下一步、时间、公开地点、人数、日历、分享、查看行程，不能把 HTTP 成功等同 confirmed。行程页直接使用 Task 4A 的单次 `RegistrationItineraryPage`，不得 N 次详情请求；以 `serverTime` 与服务端 registration/viewer facts 分为 pending、waitlist/offered、upcoming、past。排序规则：offered 按到期紧迫度、upcoming 正序、pending/waitlist 按服务端更新时间、past 倒序；每卡只有一个下一步，破坏性/次要操作移入详情或上下文菜单。刷新失败保留旧行程并 live announce。

- [ ] **Step 5: 验证并提交 Web 闭环**

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/web test:unit -- EventDetail RegistrationFlow MyEventsClient
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/web typecheck
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/web lint
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/web build
git add apps/web
git commit -m "feat(web): complete registration and itinerary journey"
```

---

## Task 7: 修复 iOS 每 Tab 独立导航与 Gate 意图恢复

**Native visual reference (read before RED):**

- `docs/design/core-journey/ios26-native-visual-spec.md`

**Files:**

- Modify: `Spott/App/AppModel.swift`
- Modify: `Spott/App/AppRootView.swift`
- Create: `Spott/App/AppRouter.swift`
- Modify: `Spott/SpottApp.swift`
- Modify: `Spott/Features/Auth/GateView.swift`
- Modify: `Spott/Features/Activities/MyActivitiesView.swift`
- Modify: `Spott/Features/Profile/ProfileViews.swift`
- Create: `SpottTests/AppRouterTests.swift`
- Modify: `SpottUITests/SpottUITests.swift`

- [x] **Step 1: 写路由 Red 测试**

测试每个 Tab 保留独立 path；从行程和个人页打开活动写入当前可见 path；事件 deep link 先切换目标 Tab 再追加；login/phone Gate 完成后执行一次原报名 intent，取消 Gate 回到原详情且不丢路径。

- [x] **Step 2: 实现集中 Router**

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

`AppTab` 加 `CaseIterable`；Router 提供 `binding(for:) -> Binding<[AppRoute]>`。`AppRoute` 只保存稳定 event id/slug，不把整个可变 `EventSummary` 放进导航状态。`SpottApp.onOpenURL` 统一交给 Router；退出登录/切换账号时清除敏感 path 与 deferred intent。

保留 iOS 26 系统 `TabView` 与原生 tab bar，不实现移动 Web 的自定义 dock；iPhone 滚动时使用 `.tabBarMinimizeBehavior(.onScrollDown)`。系统导航、返回手势、toolbar、sheet 和 safe area 行为不得用网页式自定义壳替代。

`GateView` 在真实 challenge 请求返回后，仅在 `#if DEBUG` 且响应含 `developmentCode` 时把该值写入验证码输入 state；Release 不读取、不显示、不自动填充 OTP。Web 已有同等 development-only 自动填充。这样本地/XCUITest 仍点击真实发送与验证动作，不需要测试专用认证入口。

- [x] **Step 3: 验证路由 Green 并提交**

```bash
xcodebuild -project Spott.xcodeproj -scheme Spott -destination 'platform=iOS Simulator,id=82BDA2F9-2D63-4AD1-8365-1463209BF9BF' -derivedDataPath /tmp/spott-core-journey-derived test -only-testing:SpottTests/AppRouterTests CODE_SIGNING_ALLOWED=NO
git add Spott/App Spott/Features/Auth Spott/Features/Activities Spott/Features/Profile SpottTests/AppRouterTests.swift
git commit -m "fix(ios): preserve navigation and registration intent"
```

---

## Task 8: 实现 iOS 真实发现、筛选与 MapKit

**Native visual reference (read before RED):**

- `docs/design/core-journey/ios26-native-visual-spec.md`

**Files:**

- Create: `Spott/Features/Discovery/DiscoveryStore.swift`
- Modify: `Spott/Features/Discovery/DiscoveryView.swift`
- Create: `Spott/Features/Discovery/DiscoveryToolbar.swift`
- Create: `Spott/Features/Discovery/DiscoveryFiltersView.swift`
- Create: `Spott/Features/Discovery/EventCardView.swift`
- Create: `Spott/Features/Discovery/EventMapView.swift`
- Create: `Spott/Features/Discovery/DiscoveryStateView.swift`
- Modify: `Spott/DesignSystem/SpottTheme.swift`
- Modify: `SpottTests/SpottTests.swift`
- Create: `SpottTests/DiscoveryStoreTests.swift`
- Modify: `SpottUITests/SpottUITests.swift`

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

- [ ] **Step 3: 重组 iOS 26 原生发现 UI**

首屏使用系统 navigation/search/toolbar、横向高价值 filters，随后立即出现真实活动内容；不复制移动 Web 顶栏和底部 dock。卡片使用结构化 format/language/fee/trust/status；字体改为语义 Dynamic Type。加载、空、错误、离线统一为原生状态组件。

系统 `TabView`、navigation bar、sheet 和 menu 自带 iOS 26 Liquid Glass。仅对浮动 filter cluster、地图/列表控件等少量交互 chrome 在 `GlassEffectContainer` 内使用 `.glassEffect(.regular.interactive(), in: ...)` 或 `.buttonStyle(.glass)`；内容卡保持清晰语义表面，禁止全屏玻璃卡堆叠。

删除当前强制自绘渐变 edge/shadow 的 glass 测试，custom glass helper 默认 `interactive=false`。基线避免当前 SDK 中 iOS 26.1+ 才有的 `.glass(customGlass)` initializer，只在 iOS 26 availability 分支使用 `.glass`/`.glassProminent`；iOS 17–25 使用系统 material/bordered fallback。

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

**Native visual reference (read before RED):**

- `docs/design/core-journey/ios26-native-visual-spec.md`

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
- Modify: `SpottUITests/SpottUITests.swift`

- [ ] **Step 1: 写三个 Store 的 Red 测试**

覆盖详情刷新/地址权限/12 CTA；报名 quote、固定幂等键、问题校验、重复点击、409 刷新、离线失败、Gate 恢复、confirmed/pending/waitlisted 完成态；行程正确分组和唯一下一步。

- [ ] **Step 2: 实现详情事实区与安全区 CTA**

保持标题、时间、公开地点、format、语言、费用、容量在首屏可扫描。Action Bar 使用 `.safeAreaInset(edge: .bottom)`，不会覆盖说明最后一段；只显示 `EventCTAState` 推导的一个主动作。主动作采用 iOS 26 原生 prominent glass button，次动作使用系统 glass/toolbar 样式，不自绘网页式 sticky bar。

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

- [ ] **Step 3: 落实平台外观与语义字体**

删除 `SpottApp.swift` forced light，让 iOS 跟随系统浅/深色；Web/Ops 按最新交接固定 light-only，移除对系统 dark 的自动声明和会改变品牌表面的 dark overrides，同时保留高对比、forced colors 与 Reduce Motion。Web 和 iOS 色值映射到 design tokens。iOS 固定字号改成 `.title/.headline/.body/.caption` 或 `@ScaledMetric`；Web 200% zoom 不截断。

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

- Create: `playwright.config.ts`
- Create: `scripts/run-core-journey-e2e.ts`
- Create: `tests/e2e/core-journey.spec.ts`
- Create: `tests/e2e/fixtures/core-journey.ts`
- Modify: `package.json`
- Modify: `SpottUITests/SpottUITests.swift`
- Create: `docs/quality/core-journey-screenshot-matrix.md`
- Create: `docs/quality/core-journey/README.md`
- Modify: `.gitignore`

- [ ] **Step 1: 写 Web E2E Red 路径**

固定测试数据通过真实 PG18 migration 和数据库 fixture 建立，覆盖访客发现 → 筛选 → 详情 → 登录恢复 → 手机验证恢复 → 报名/候补 → 确认 → 行程。测试不得拦截成静态页面；只可对后端建立可重复 fixture。

`scripts/run-core-journey-e2e.ts` 是唯一栈编排器：使用 `/opt/homebrew/opt/postgresql@18/bin` 在 `/tmp/spott-core-journey-e2e-pg18` 启动 55434；创建 `spott_core_journey_e2e_test`；按序应用 migrations；运行 `tests/e2e/fixtures/core-journey.ts` 创建相对当前时间未来 7 天的已发布活动、自动/审批/已满候补三种容量状态和已验证 host；构建并启动 API 4100、Web 3000；轮询 health/页面；执行目标测试；finally 终止子进程和 PG。数据库名不以 `_test` 结尾时必须拒绝运行。

API 使用 `NODE_ENV=development` + `OTP_PROVIDER=console`，因此现有真实 challenge response 返回 `developmentCode`，Web 登录和手机号表单会自动填入；E2E 点击实际发送/验证按钮，不添加测试专用认证 endpoint。编排器只设置隔离测试 secrets、`DATABASE_URL`、`API_INTERNAL_URL`、`NEXT_PUBLIC_API_URL` 和 `SPOTT_API_BASE_URL`。

Root scripts 固定为：

```json
"test:e2e:core:web": "tsx scripts/run-core-journey-e2e.ts web",
"test:e2e:core:ios": "tsx scripts/run-core-journey-e2e.ts ios"
```

- [ ] **Step 2: 增加状态与视觉矩阵**

Playwright 覆盖 loading、empty、refresh error with stale content、offline、full、waitlist、pending、confirmed、409 changed event；按最新交接要求，Web/Ops 为 light-only，截图矩阵为三语 × Light × 390/768/1440 的发现/详情/报名/确认关键页，并另测高对比、forced colors、键盘和 Reduce Motion。iOS 仍跟随系统浅/深色。

- [ ] **Step 3: 写 iOS XCUITest 真实路径**

XCUITest 在 `XCUIApplication.launchEnvironment` 设置 `SPOTT_API_BASE_URL=http://127.0.0.1:4100/v1`，并使用与 Web 相同的隔离 fixture；覆盖发现 → 详情 → Gate → 报名 → 行程，并验证每 Tab 路径。development challenge code 通过真实 API 响应自动填入，不读取日志、不绕过认证。截图至少覆盖中日英、浅深、小/大 iPhone、最大 Dynamic Type、Reduce Motion。UI 测试先单 worker 执行，解决此前 runner materialization 不稳定后才增加并发。

- [ ] **Step 4: 运行真实渲染并人工复核**

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm test:e2e:core:web
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm test:e2e:core:ios
```

人工复核每张截图：390px/iPhone 首屏看到真实活动；单一主操作；sticky/safe-area 不遮挡；三语无截断；Web Light、高对比与 forced-colors 可读，iOS 系统浅/深色对比合格；无假坐标/假头像/假信誉/假成功/死按钮。结果写入 screenshot matrix，失败项修复后重跑。

- [ ] **Step 5: 提交 E2E 与质量证据**

```bash
git add playwright.config.ts scripts/run-core-journey-e2e.ts tests/e2e package.json SpottUITests docs/quality .gitignore
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
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api-client generate
git diff --exit-code -- packages/contracts/openapi.bundle.yaml packages/api-client/src/schema.d.ts
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api-client typecheck
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api-client test
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
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm test:e2e:core:web
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm test:e2e:core:ios
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

---

## Task 13: 完成 Web 会话安全与跨 Tab 一致性

> 来源：`Spott项目交接文档-20260716.docx` 的 Web Session Security P0。不得在浏览器持久化 access/refresh token，也不得以 UI 隐藏代替服务端授权。

- [ ] **Step 1: 以威胁模型和失败测试锁定边界**

覆盖 refresh rotation/reuse、登出撤销、跨账号切换、恶意 `returnTo`、跨站 Origin/CSRF、多 Tab 同时刷新、旧 localStorage token 迁移和无 cookie SSR。

- [ ] **Step 2: 实现 cookie/BFF 会话架构**

refresh token 只进入 `HttpOnly + Secure + SameSite` cookie；access token 仅内存或可信 BFF；引入稳定 session id、严格同源 `returnTo`、Origin/CSRF 验证和服务端撤销链。

- [ ] **Step 3: 实现多 Tab refresh lock 与兼容迁移**

同一 session 同时只允许一个 refresh；其余 Tab 等待结果并恢复请求。一次性清理旧 localStorage 凭证，迁移失败时安全退出且不泄漏 token。

- [ ] **Step 4: 安全验证并提交**

运行单元、集成、Playwright 多上下文、cookie 属性和重放攻击测试；浏览器存储快照不得出现任何 bearer/refresh token。

---

## Task 14: 修复离线同步、游标与跨设备一致性

> 来源：交接文档的 Sync Correctness P0。`PersistenceStore.apply` 不得只推进 cursor 而漏应用 changes。

- [ ] **Step 1: 为 cursor 原子性写 Red 测试**

覆盖冷启动恢复、重复 pull、分页中断、apply 失败、push 冲突、删除墓碑、乱序 realtime 和 cursor 不得超前。

- [ ] **Step 2: 修复 iOS 本地持久化 apply/pull/push**

changes 与 cursor 必须在同一事务提交；失败回滚；恢复登录时按用户/设备作用域重建安全同步上下文。

- [ ] **Step 3: 建立 Web IndexedDB 同步层**

实现 pull/push、冲突策略、realtime 去重、离线队列、账号切换隔离和可观察同步状态；不得以 localStorage 代替结构化存储。

- [ ] **Step 4: 证明跨设备收敛**

以 Web + 两台 iOS 模拟设备跑收藏、报名、取消、候补、资料修改和删除的断网/重连 E2E；最终状态、cursor 与审计事件一致。

---

## Task 15: 建立真实 CI、生成物漂移与发布质量门

- [ ] **Step 1: 清零 API lint/typecheck 基线**

逐类修复交接快照中的 API lint 债务；根目录 `check`/`typecheck` 必须真实覆盖 contracts、API、worker、Web、Ops 和 iOS 可自动化检查，不允许空脚本或吞错。

- [ ] **Step 2: 固化 GitHub Actions 与分支保护要求**

CI 必须验证 OpenAPI bundle/client 生成物无漂移、迁移可重放、Node 24、Swift Release、单元/集成/E2E、secret scan 和依赖审计。

- [ ] **Step 3: 建立非功能质量矩阵**

加入 Playwright、XCUITest、PostgreSQL 18/PostGIS、并发/负载、安全、无障碍、性能、备份恢复演练，并保存机器可读报告与截图证据。

- [ ] **Step 4: 让失败成为硬门禁**

所有门在干净 clone 可复现；P0/P1、生成物漂移、迁移失败、凭证泄漏或核心旅程 E2E 失败时禁止合并/发布。

---

## Task 16: 关闭后端异步任务、Ops 与数据安全缺口

- [ ] **Step 1: 强化 Ops 身份与数据作用域**

实现 MFA、refresh/CSRF、最小权限 RBAC/RLS、审计日志、敏感字段遮罩和组织/地区数据作用域，并以越权测试证明。

- [ ] **Step 2: 完成风险处置工作流**

把 risk flags 从展示扩展为分派、证据、复核、升级、解除和不可篡改审计；高风险动作要求双人或二次认证策略。

- [ ] **Step 3: 完成容量与通知异步正确性**

pending hold 过期必须原子释放名额；候补 offer、取消、重试和幂等一致；接入可配置的真实 OTP/APNs/email/SMS provider，测试环境使用明确 fake adapter。

- [ ] **Step 4: 完成媒体、导出与后台作业**

媒体走对象存储、扫描、审核、派生图和生命周期策略；数据导出生成真实可下载包；worker 具备幂等、退避、死信、追踪和告警。

---

## Task 17: 完成生产基础设施、隐私与恢复准备

> 云账号、域名、Apple/Google 账号、DNS/TLS、APNs/StoreKit、法律条款和真实供应商开通属于外部状态；没有用户授权或凭证时只完成可审查的 IaC、runbook、配置校验和本地/沙箱演练，不伪报已上线。

- [ ] **Step 1: 编写可复现 IaC 与环境合同**

覆盖网络、数据库、缓存、对象存储/CDN/扫描、secret manager、队列、监控、日志、告警、最小权限和 dev/staging/prod 隔离。

- [ ] **Step 2: 建立 SLO、可观测性与容量基线**

定义核心旅程 SLI/SLO、告警预算、追踪关联、容量/成本阈值和故障演练；从客户端到 worker/DB 可串联一次请求。

- [ ] **Step 3: 证明备份与灾难恢复**

定义并演练 RPO/RTO、数据库 PITR、对象恢复、密钥轮换、供应商故障和区域恢复；保存带时间戳证据。

- [ ] **Step 4: 完成合规与商店材料**

落实 APPI/隐私、未成年人、积分、费用/退款、SLA、数据保留/删除、支持与事故响应；准备 App Store/Web 法律页面和审核证据。

- [ ] **Step 5: 经用户授权后部署 staging/production**

仅在外部账号、域名、证书、计费和法律文本获得明确授权后执行；发布后跑 smoke、回滚和恢复验证。

---

## Task 18: 完成 Luma/Meetup 对标与超越功能批次

> 每项必须同时具有 Web、iOS 原生、三语、平台约定外观（Web/Ops light-only；iOS 跟随系统浅/深色）、无障碍、权限/隐私、分析事件、测试和真实服务端；不接受静态占位或仅一端实现。支付和聊天会扩大数据/合规/运维边界，先提交 ADR 与范围确认，再进入实现。

- [ ] **Step 1: 活动与主办方能力**

实现 recurring、online/hybrid、活动团队/共同主办/工作人员、CSV/联系人/批量邀请、newsletter、组织主页、品牌日历和主办方工具箱。

- [ ] **Step 2: 社群与互动能力**

实现群组/会员生命周期、订阅、活动消息/聊天、照片、通知偏好、举报/拉黑/审核，以及跨端实时与离线一致性。

- [ ] **Step 3: 商业化能力**

实现票务/支付/退款/税费/对账、会员付费、赞助/广告/品牌账号和推广活动；资金流必须具备账本、幂等、风控与审计。

- [ ] **Step 4: 增长、分析与生态**

实现邀请奖励、可解释推荐、主办方漏斗/留存/收入分析、公开 API/webhooks、配额/签名/重放防护和开发者文档。

- [ ] **Step 5: 逐功能对标验收**

维护 Luma/Meetup 可验证能力矩阵；每个条目只有在双端真实旅程、三语、视觉/无障碍、性能、安全和自动化证据齐全后才可关闭。

- [x] **Step 6: 固定当前客户端范围**

当前交付范围固定为原生 iOS 26 SwiftUI 与响应式 Web；Android 不属于本轮范围。未来若用户另行授权 Android，再提交独立原生 Android 对等计划；iOS 原生交付不得被跨平台壳替代。

- [ ] **Step 7: 落地六项领先能力**

实现并验证 AI 活动创建助手、原文/译文切换与关键规则高质量翻译、可解释推荐、候补/防爽约优化、主办方 Copilot，以及安全同行/到场确认/活动后关怀。每项必须有明确的人类确认、隐私边界、失败降级、双端三语旅程和可关闭证据，不能只做静态 AI 文案入口。

---

## Task 19: 消除 SwiftData 启动致命失败

- [ ] **Step 1: 写初始化失败 Red 测试**

覆盖模型迁移失败、缓存损坏、磁盘空间/写入错误和只读目录；`PersistenceStore.makeDefault()` 不得 `fatalError` 或无限启动循环。

- [ ] **Step 2: 实现可恢复启动策略**

区分可安全重建的缓存与不可丢失的用户数据，保存诊断、隔离损坏 store、提供本地化恢复 UI/重试/导出支持，并保证账号隔离和 Keychain 不被误清除。

- [ ] **Step 3: 真实模拟器验收**

在 iOS 26 模拟器注入三类失败，验证三语、VoiceOver、重启恢复、无崩溃和无静默数据丢失；保存日志和测试证据。

---

## Task 20: 关闭 iOS 发布面缺口

- [ ] **Step 1: 完成 AppIcon 与品牌资源**

交付真实 1024px AppIcon 及 Xcode 资产变体，验证无透明/占位资源、构建告警和浅深系统外观下的辨识度。

- [ ] **Step 2: 完成 Push 点击路由**

实现通知响应 delegate、签名/允许列表深链解析、冷启动与前后台路由、账号/权限 Gate 恢复，并覆盖错误/过期/恶意 payload。

- [ ] **Step 3: 完成 Live Activity Extension**

新增真实 Extension target、Activity attributes、生命周期/推送更新/过期清理、隐私与耗电边界、三语和模拟器验收；App 内 helper 不能作为完成证据。

- [ ] **Step 4: 完成 StoreKit Sandbox**

增加 `.storekit` 配置和 Sandbox 旅程，覆盖购买、恢复、取消、退款/撤销、网络失败、重复回调、收据/服务端幂等和三语错误；涉及真实资金前仍需商业/法律 ADR。

---

## Task 21: 完成 Web 城市入口、SEO 与 PWA 三语

- [x] **Step 1: 建立 `/tokyo` 城市入口**

使用真实发现合同和可索引 metadata，不复制静态假活动；覆盖移动/桌面、空态、筛选、canonical 和三语 URL/语言切换。

- [x] **Step 2: 本地化 Manifest 与系统页面**

修复 `manifest.ts` 的语言/名称/描述/shortcuts，完成三语 manifest 策略、`not-found`、offline/install 文案、图标与 light-only theme colors。

- [x] **Step 3: 完成 SEO 语言合同**

为可索引页面生成正确 canonical、`hreflang`/language alternates、Open Graph/Twitter/JSON-LD；自动测试不得让 `lang=zh-Hans` 与英文 metadata 混用。

---

## Task 22: 让媒体上传阶段可幂等恢复

- [ ] **Step 1: 定义 upload-intent 与 complete 幂等合同**

调用方为每个稳定文件实例和阶段持有独立 attempt；服务端以精确 payload/owner/scope 绑定 outcome，响应丢失后可查询或安全重放，不能仅凭对象 key 猜测成功。

- [ ] **Step 2: 实现 API、Web/iOS 客户端与清理**

覆盖 partial-stage reuse、替换/删除文件、账号切换、签名 URL 过期、哈希竞态、恶意 asset ID、孤儿清理和审计，不把上传完成等同举报提交成功。

- [ ] **Step 3: 运行响应丢失与跨设备测试**

在 intent、上传和 complete 三个边界分别注入断网/超时，验证同一文件只形成一个权威资产、三语 UI 可恢复且无跨账号泄漏。

---

## Task 23: 校正历史计划状态并关闭验证债务

- [ ] **Step 1: 复核 Backend contract gaps**

Tasks 1–6、8–9 已有实现/测试时标为“实现存在、当前全量验证待关闭”，运行真实 PostgreSQL/curl 权限矩阵、OpenAPI bundle/client drift 和全套门禁后再勾选，不重复开发也不虚报完成。

- [ ] **Step 2: 复核 iOS Analytics**

核对 `AnalyticsClient`、四个 P0 信号、隐私清洗与生产接线；以当前 212-test 基线外的聚焦/全量验证和事件证据更新 `ios-p0-analytics.md`。

- [ ] **Step 3: 建立最终单一完成矩阵**

把审计、开发提示、去重后的交接文档和 Tasks 1–23 映射到代码、自动测试、真实旅程、截图/性能/安全/发布证据；只有证据齐全才关闭条目。
