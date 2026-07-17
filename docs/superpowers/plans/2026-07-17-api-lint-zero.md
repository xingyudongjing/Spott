# API Lint Zero Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Also use superpowers:test-driven-development, superpowers:systematic-debugging, superpowers:verification-before-completion, and superpowers:requesting-code-review. Each batch requires a fresh independent review before the next batch starts.

**Goal:** Reduce the API ESLint baseline from exactly 471 errors to zero by replacing untyped PostgreSQL row boundaries with explicit row contracts while preserving every Ops response, SQL predicate, RBAC decision, idempotency claim, lock, audit write, outbox write, and transaction boundary.

**Architecture:** Keep the repair local to `OpsService` and its two linting test files. Model every `pg` result at the query boundary, use a generic cursor-page helper for rows with `id` and `created_at`, keep JSONB as `unknown` unless the code reads object properties, and make nullable `LEFT JOIN` columns explicit. Execute five reviewable RED/GREEN batches; the lint-count checkpoints are part of the contract and prevent one giant, unreviewable type rewrite.

**Tech Stack:** TypeScript 6, Node.js 24, NestJS 11, `pg` 8, ESLint with type-aware `@typescript-eslint`, Vitest 3, pnpm.

## Baseline Evidence and Fixed Checkpoints

The 2026-07-17 baseline is:

| File | Errors | Composition |
|---|---:|---|
| `services/api/src/modules/ops/ops.service.ts` | 459 | 42 `no-explicit-any`, 415 unsafe-cascade errors, 1 unused import, 1 unnecessary assertion |
| `services/api/src/modules/ops/ops.service.spec.ts` | 8 | 3 `no-explicit-any`, 5 unsafe member accesses |
| `services/api/src/platform/auth.guard.spec.ts` | 4 | 2 `no-explicit-any`, 2 unsafe arguments |
| **Total** | **471** | **47 explicit `any` + 422 unsafe cascade + 2 hygiene errors** |

The implementation must stop for review at these exact totals:

| Batch | Owned declarations | Required global lint total |
|---|---|---:|
| 0 | Tests, unused import, unnecessary assertion | **457** |
| 1 | Read-only users/organizers/events/groups/cases, mappers, generic page | **324** |
| 2 | Points/config/export read models, audit/admin read models | **174** |
| 3 | Restriction/group/moderation/claim/event-review paths | **58** |
| 4 | Points/config/export mutation, approval/impact, execution, rollback | **0** |

Use the standard lint command for the authoritative count:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api lint
```

Before Batch 4 the command is expected to exit 1 and print the checkpoint count in its final summary. After Batch 4 it must exit 0. If unrelated concurrent work changes the 471 baseline, do not add errors or weaken types to recreate these numbers; stop, regenerate the three-file JSON report, and have the plan owner approve a rebase of all checkpoints.

The Batch 1 GREEN run established one plan-owned rebaseline: typing the shared `mapCase(ModerationCaseListRow)` boundary removed all 134 errors owned by Batch 1 but correctly exposed one existing `query<any>` caller in the Batch 3 `moderationCase()` detail path. That downstream caller must remain visible until Batch 3 rather than being hidden or pulled across the batch boundary. The approved measured checkpoints are therefore `471 -> 457 -> 324 -> 174 -> 58 -> 0`.

## Global Constraints

- Modify only the three files listed under Strict File Scope. Do not create a row-types file, change controllers, change DTOs, change contracts, change migrations, or change database configuration.
- Never add `eslint-disable`, `eslint-disable-next-line`, `@ts-ignore`, `@ts-expect-error`, `any`, `as any`, or a broad `Record<string, unknown>` in production merely to silence property access.
- A test-only double cast from the small execution-context fixture through `unknown` is allowed because the fixture intentionally implements only the methods exercised by `AccessTokenGuard`. Production row values may not use double casts.
- Every `database.query` or `client.query` whose result is read must have a concrete generic row type. A query whose result is ignored may remain unparameterized.
- PostgreSQL `count`, `bigint`, and `numeric` values are modeled as `string | number | bigint`; keep the existing `integer()` conversion for JSON number responses and use `BigInt(...)` directly for wallet arithmetic.
- PostgreSQL `timestamptz` values read through `pg` are modeled as `Date`; nullable timestamps are `Date | null`. Do not turn them into strings at the query boundary.
- Every column introduced by `LEFT JOIN`, nullable schema state, filtered aggregate, or `CASE` without a non-null guarantee must include `null` in its type.
- JSONB values are `unknown` when forwarded unchanged. Use `Record<string, unknown>` only for schema fields that are contractually JSON objects, such as config audience and export filters. Do not inspect an `unknown` JSONB value without a runtime guard.
- Replace `SELECT *` in config rollback with the five explicit columns actually consumed: `key`, `value_json`, `audience`, `region`, and `min_app_version`.
- Do not change SQL clauses, parameter order, lock mode, RBAC role lists, state transitions, idempotency request hashes, claim/complete order, audit payloads, outbox payloads, or HTTP-facing response shapes unless a characterization test first proves a real defect and the plan owner expands scope.
- A lower lint total before the declared checkpoint is not automatically success: the reviewer must confirm that edits did not cross into a later batch. A higher total fails the batch.
- Each batch must pass its focused tests, API typecheck, the full API suite, whitespace checks, and a fresh independent review with no Critical or Important findings.
- Suggested implementation commits in this plan are for the future execution session. Creating this plan itself must not stage or commit files.

---

## Strict File Scope

### Modify during implementation

- `services/api/src/modules/ops/ops.service.ts`
- `services/api/src/modules/ops/ops.service.spec.ts`
- `services/api/src/platform/auth.guard.spec.ts`

### Forbidden

- `services/api/src/modules/ops/ops.controller.ts`
- `services/api/src/platform/auth.guard.ts`
- `services/api/src/platform/database.ts`
- `services/api/src/platform/idempotency.ts`
- `packages/contracts/**`
- `packages/api-client/**`
- `database/**`
- `apps/**`
- `Spott/**`

## Locked Type Model

Add row contracts next to the existing `AdminContext`, filter, and cursor interfaces in `ops.service.ts`. Introduce them only in the batch that owns their first consumer.

```ts
type PgInteger = string | number | bigint;

interface PageRow {
  id: string;
  created_at: Date;
}

interface PageResult<Item> {
  items: Item[];
  hasMore: boolean;
  nextCursor: string | null;
}
```

The final page helper must be generic and preserve the existing cursor semantics:

```ts
private page<Row extends PageRow, Item>(
  rows: readonly Row[],
  limit: number,
  map: (row: Row) => Item,
): PageResult<Item> {
  const hasMore = rows.length > limit;
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: visible.map(map),
    hasMore,
    nextCursor: hasMore && last ? this.encodeCursor(last.created_at, last.id) : null,
  };
}
```

Do not widen `PageRow.created_at` to `unknown` or `string`. Every paginated query already selects a PostgreSQL timestamp and the cursor encoder calls `toISOString()`.

## Mandatory Commands for Every Batch

Run from the repository worktree root:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
pnpm --filter @spott/api exec vitest run \
  src/modules/ops/ops.service.spec.ts \
  src/platform/auth.guard.spec.ts

PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api typecheck
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api test
git diff --check -- \
  services/api/src/modules/ops/ops.service.ts \
  services/api/src/modules/ops/ops.service.spec.ts \
  services/api/src/platform/auth.guard.spec.ts
```

Expected on every batch: focused tests pass, typecheck exits 0, all API tests pass, and `git diff --check` prints nothing. The lint command has the batch-specific expected count below.

---

### Task 0 / Batch 0: Remove test `any` and the two hygiene errors

**Files:**

- Modify only test result casts in `services/api/src/modules/ops/ops.service.spec.ts`
- Modify only the execution-context fixture and request fixtures in `services/api/src/platform/auth.guard.spec.ts`
- Modify only the crypto import and the post-null-check role expression in `services/api/src/modules/ops/ops.service.ts`

**Risks:**

- A test cast must not weaken assertions or hide an unexpected response shape.
- The guard fixture must remain mutable so `AccessTokenGuard` can attach `request.user`.
- Removing the non-null assertion is safe only after the existing `if (!admin) throw` guard; do not move the role check above it.

**Interfaces:**

- Produces zero lint errors in both spec files.
- Produces an `ExecutionContext` fixture without `any`.
- Leaves exactly 457 errors in `ops.service.ts` and zero elsewhere in API lint.

- [x] **Step 1: Confirm the RED baseline**

Run:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api lint
```

Expected: exit 1 with exactly 471 errors and the three-file distribution documented above. If the distribution differs, stop and rebaseline before editing.

- [x] **Step 2: Replace the three unsafe Ops test result casts**

Add these test-only contracts near the existing `admin` fixture:

```ts
interface OverviewResult {
  queues: { p0Open: number; outboxBacklog: number };
  health: { deliverySuccessRate1h: number };
  growth: { checkinRate30d: number };
}

interface AuditLogPageResult {
  items: Array<{ resourceIdMasked: string; resourceId?: never }>;
}

interface OrganizerPageResult {
  items: Array<{ repeatRate60d: number }>;
}
```

Replace only the three `Record<string, any>` casts:

```ts
const result = await service.overview(operator) as OverviewResult;
const result = await service.auditLogs(operator, {}, undefined, 20) as AuditLogPageResult;
const result = await service.organizers(operator, {}, undefined, 20) as OrganizerPageResult;
```

Keep every current assertion, but use optional element access for the two arrays because the repository enables `noUncheckedIndexedAccess`:

```ts
expect(result.items[0]?.resourceIdMasked).toBe('019f1234…9abc');
expect(result.items[0]).not.toHaveProperty('resourceId');
expect(result.items[0]?.repeatRate60d).toBe(0.4);
```

The value assertions still fail if an item is missing. The optional-never field makes `not.toHaveProperty('resourceId')` explicit without permitting arbitrary members.

- [x] **Step 3: Replace the guard test `any` boundary**

Import the exact Nest and request types:

```ts
import type { ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser } from './request-context.js';

interface GuardRequest {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  user?: AuthenticatedUser;
}

function context(request: GuardRequest): ExecutionContext {
  return {
    getHandler: () => context,
    getClass: () => AccessTokenGuard,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}
```

Construct both fixtures as `GuardRequest`, remove both `Record<string, any>` assertions, and continue asserting `request.user` after `canActivate`.

- [x] **Step 4: Remove the two production hygiene errors**

Change the crypto import to:

```ts
import { createHmac, randomUUID } from 'node:crypto';
```

After the existing `if (!admin) throw` statement, replace `admin!.roles.includes(role)` with `admin.roles.includes(role)`. Do not alter the condition or role list.

- [x] **Step 5: Run GREEN gates**

Run all Mandatory Commands, then run API lint.

Expected: focused tests and full tests pass, typecheck exits 0, and API lint exits 1 with exactly **457 errors**. Both spec files must have zero errors; all 457 must be in `ops.service.ts`.

- [x] **Step 6: Independent review gate**

Give a fresh reviewer only the Batch 0 diff and ask them to reject:

- removed or weakened assertions;
- a guard fixture that cannot receive `user`;
- any new broad test cast outside the single `ExecutionContext` fixture;
- role-check reordering or behavioral production changes.

Proceed only with no Critical or Important findings.

- [ ] **Step 7: Commit the independently approved batch**

```bash
git add \
  services/api/src/modules/ops/ops.service.ts \
  services/api/src/modules/ops/ops.service.spec.ts \
  services/api/src/platform/auth.guard.spec.ts
git commit -m "test(api): remove unsafe ops fixtures"
```

---

### Task 1 / Batch 1: Type read-only core Ops pages and generic pagination

**Files:**

- Modify only the type declarations plus `users`, `organizers`, `events`, `groups`, `cases`, `mapEvent`, `mapCase`, and `page` in `services/api/src/modules/ops/ops.service.ts`
- Add only the `OpsService typed core read models` characterization block in `services/api/src/modules/ops/ops.service.spec.ts`
- Do not modify `services/api/src/platform/auth.guard.spec.ts`

**Risks:**

- `count(*)::text`, `numeric`, and `bigint` values must remain numeric strings until `integer()` or `ratio()` converts them.
- `starts_at`, `submitted_at`, `created_at`, `updated_at`, `sla_due_at`, and `closing_at` are `Date` values; nullable timestamps must stay nullable.
- Event location/fee, case assignee, and group transfer/dissolution fields come from `LEFT JOIN` or filtered aggregates and may be null.
- The generic page helper must use the last visible row, not the over-fetched row, when producing `nextCursor`.
- `risk_reasons` is a PostgreSQL string array, not JSON text.

**Interfaces:**

- Consumes `PgInteger`, `PageRow`, and `PageResult<Item>` from the Locked Type Model.
- Produces the following concrete query-row contracts and a generic page mapper.
- Leaves exactly 324 global API lint errors: the 323 previously measured downstream errors plus the newly visible Batch 3 `moderationCase()` unsafe argument at the now-typed `mapCase` boundary.

- [x] **Step 1: Confirm Batch 1 RED**

Run API lint.

Expected: exactly 457 errors. Confirm every `query<any>` and mapper `any` in the owned declarations is still reported before editing.

- [x] **Step 2: Add characterization tests for nullable joins and cursor ownership**

Add a test-only result contract and the following event test inside the new characterization block:

```ts
interface EventPageResult {
  items: Array<{
    id: string;
    categoryId: string | null;
    startsAt: string | null;
    publicArea: string | null;
    isFree: boolean | null;
    amountJpy: number | null;
    riskReasons: string[];
  }>;
  hasMore: boolean;
  nextCursor: string | null;
}

it('preserves nullable event joins and derives the cursor from the last visible row', async () => {
  const first = {
    id: '00000000-0000-4000-8000-000000000021',
    public_slug: 'night-walk',
    title: 'Night walk',
    status: 'pending_review',
    category_id: null,
    starts_at: null,
    submitted_at: new Date('2026-07-17T10:00:00.000Z'),
    version: '3',
    created_at: new Date('2026-07-17T09:00:00.000Z'),
    organizer_id: '00000000-0000-4000-8000-000000000011',
    organizer_handle: 'city_host',
    organizer_nickname: 'City Host',
    public_area: null,
    region_id: null,
    is_free: null,
    amount_jpy: null,
    risk_score: '0',
    risk_reasons: [],
  };
  const overFetched = {
    ...first,
    id: '00000000-0000-4000-8000-000000000020',
    created_at: new Date('2026-07-17T08:00:00.000Z'),
  };
  const query = vi.fn()
    .mockResolvedValueOnce({ rows: [admin], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [first, overFetched], rowCount: 2 });
  const { service } = serviceWith(query);

  const result = await service.events(operator, {}, undefined, 1) as EventPageResult;

  expect(result.items).toEqual([expect.objectContaining({
    id: first.id,
    categoryId: null,
    startsAt: null,
    publicArea: null,
    isFree: null,
    amountJpy: null,
    riskReasons: [],
  })]);
  const expectedCursor = Buffer.from(JSON.stringify({
    at: first.created_at.toISOString(),
    id: first.id,
  })).toString('base64url');
  expect(result.hasMore).toBe(true);
  expect(result.nextCursor).toBe(expectedCursor);
});
```

This characterization case may pass before the type repair; the required RED signal is the 457-error static-analysis baseline. The existing organizer regression remains the numeric-string behavior guard. The fresh reviewer must compare the users, groups, and cases row contracts field-by-field with their SQL because this batch intentionally avoids adding redundant mock-heavy tests for type-only substitutions.

- [x] **Step 3: Add the exact core read-row types**

Add these declarations without index signatures:

```ts
interface UserListRow extends PageRow {
  public_handle: string;
  nickname: string;
  status: string;
  restriction_flags: string[];
  phone_verified_at: Date | null;
  device_risk: string;
  hosted_count: PgInteger;
  registration_count: PgInteger;
  complaint_count: PgInteger;
  updated_at: Date;
  version: PgInteger;
}

interface OrganizerListRow extends PageRow {
  public_handle: string;
  nickname: string;
  status: string;
  restriction_flags: string[];
  phone_verified_at: Date | null;
  hosted_count: PgInteger;
  upcoming_count: PgInteger;
  completed_count: PgInteger;
  checked_in_count: PgInteger;
  eligible_count: PgInteger;
  participants_60d: PgInteger;
  repeat_participants_60d: PgInteger;
  complaint_count: PgInteger;
  version: PgInteger;
}

interface EventListRow extends PageRow {
  public_slug: string;
  title: string;
  status: string;
  category_id: string | null;
  starts_at: Date | null;
  submitted_at: Date;
  version: PgInteger;
  organizer_id: string;
  organizer_handle: string;
  organizer_nickname: string;
  public_area: string | null;
  region_id: string | null;
  is_free: boolean | null;
  amount_jpy: PgInteger | null;
  risk_score: PgInteger;
  risk_reasons: string[];
}

interface GroupListRow extends PageRow {
  slug: string;
  name: string;
  status: string;
  join_mode: string;
  capacity: PgInteger;
  version: PgInteger;
  owner_id: string;
  owner_handle: string;
  owner_nickname: string;
  member_count: PgInteger;
  open_event_count: PgInteger;
  report_count: PgInteger;
  active_transfer_state: string | null;
  closing_at: Date | null;
}

interface ModerationCaseListRow extends PageRow {
  public_reference: string;
  target_type: string;
  target_id: string;
  reason: string;
  severity: string;
  status: string;
  sla_due_at: Date;
  version: PgInteger;
  assignee_id: string | null;
  assignee_label: string | null;
}
```

- [x] **Step 4: Apply query generics and typed mappers**

Apply the generics by declaration: `users` → `UserListRow`, `organizers` → `OrganizerListRow`, `events` → `EventListRow`, `groups` → `GroupListRow`, and `cases` → `ModerationCaseListRow`. Change `mapEvent` to accept `EventListRow` and `mapCase` to accept `ModerationCaseListRow`. Replace the exact current `page(rows: any[], limit: number, map: (row: any) => unknown)` declaration with the complete generic helper from the Locked Type Model. Do not annotate callback parameters manually; allow the concrete query result to infer them. Keep all response fields and conversions unchanged.

- [x] **Step 5: Run GREEN gates**

Run all Mandatory Commands, then API lint.

Expected: API lint exits 1 with exactly **324 errors**. No owned declaration may contain `any`, an unsafe rule violation, or a new assertion. The only checkpoint delta from the original measurement is the one Batch 3 `moderationCase()` unsafe argument exposed by the typed shared mapper.

- [x] **Step 6: Independent review gate**

The reviewer must compare each interface against its SQL select list and reject:

- a count, numeric, or bigint modeled only as `number`;
- a nullable join modeled as non-null;
- a timestamp modeled as a string;
- a page cursor derived from the over-fetched row;
- a mapper response-shape change;
- edits outside the named declarations.

Proceed only with no Critical or Important findings.

- [ ] **Step 7: Commit the independently approved batch**

```bash
git add services/api/src/modules/ops/ops.service.ts services/api/src/modules/ops/ops.service.spec.ts
git commit -m "refactor(api): type ops core read models"
```

---

### Task 2 / Batch 2: Type points/config/export list/load read models and audit/admin queries

**Files:**

- Modify only type declarations plus `pointAdjustments`, `configRevisions`, `auditLogs`, `adminUsers`, `exports`, `loadPointAdjustment`, `mapPointAdjustment`, `loadConfigRevision`, `mapConfigRevision`, `loadExport`, and `mapExport` in `services/api/src/modules/ops/ops.service.ts`
- Add only the `OpsService typed finance and admin read models` characterization block in `services/api/src/modules/ops/ops.service.spec.ts`
- Do not modify `services/api/src/platform/auth.guard.spec.ts`

**Risks:**

- Point amounts and approval counts may arrive as numeric strings or bigint values.
- Config `value_json` can be any JSON value and must remain `unknown`; config `audience` is an object. Do not stringify, clone, or coerce either value.
- `effective_from`, `effective_to`, point decision/execution times, nullable approvers, audit actors, and disabled admin timestamps are nullable.
- Export expiration/creation timestamps are `Date`; max/download counts use `PgInteger`.
- Admin and audit queries include `LEFT JOIN` labels and actors; nullability must reflect the SQL.

**Interfaces:**

- Consumes the generic page helper from Batch 1.
- Produces typed list/load/map boundaries for points, config, exports, audit logs, and admin users.
- Leaves exactly 174 global API lint errors.

`configImpact` is deliberately excluded from Batch 2: its current 10 errors belong to the config approval/preflight slice in Batch 4. This ownership is what makes the fixed 324→174 checkpoint a 150-error reduction.

- [x] **Step 1: Confirm Batch 2 RED**

Run API lint.

Expected: exactly 324 errors, with the owned `query<any>`, loader, and mapper declarations still reported.

- [x] **Step 2: Add JSONB, nullability, and numeric-string characterization tests**

Add this config regression case:

```ts
interface ConfigPageResult {
  items: Array<{
    value: unknown;
    region: string | null;
    effectiveFrom: string | null;
    effectiveTo: string | null;
    approvedBy: { id: string; label: string } | null;
  }>;
}

it('forwards config JSONB unchanged and preserves nullable read fields', async () => {
  const value = ['city', { enabled: true, threshold: 3 }];
  const configAdmin = { ...admin, roles: ['configApprover'] };
  const query = vi.fn()
    .mockResolvedValueOnce({ rows: [configAdmin], rowCount: 1 })
    .mockResolvedValueOnce({
      rows: [{
        id: '00000000-0000-4000-8000-000000000041',
        key: 'discovery.ranking',
        value_json: value,
        version: '7',
        audience: { locale: ['ja', 'zh-Hans', 'en'] },
        region: null,
        min_app_version: null,
        effective_from: null,
        effective_to: null,
        state: 'draft',
        created_at: new Date('2026-07-17T00:00:00.000Z'),
        reason: 'typed boundary',
        submitter_id: '00000000-0000-4000-8000-000000000042',
        submitter_label: 'Submitter',
        approver_id: null,
        approver_label: null,
      }],
      rowCount: 1,
    });
  const { service } = serviceWith(query);

  const result = await service.configRevisions(operator, {}, undefined, 20) as ConfigPageResult;

  expect(result.items[0]).toMatchObject({
    value,
    region: null,
    effectiveFrom: null,
    effectiveTo: null,
    approvedBy: null,
  });
  expect(result.items[0]?.value).toBe(value);
});
```

The config case is the behavior guard for JSONB identity and nullable timestamps. Existing point self-approval and export approval tests remain green while the point/export list and mapper changes are reviewed field-by-field against their SQL. The above-safe-integer arithmetic case belongs exclusively to Batch 4. The RED signal remains the 324-error lint baseline.

- [x] **Step 3: Add the exact read-model row contracts**

```ts
interface PointAdjustmentRow extends PageRow {
  bucket: string;
  amount: PgInteger;
  reason: string;
  state: string;
  points_transaction_id: string | null;
  decided_at: Date | null;
  executed_at: Date | null;
  required_approvals: PgInteger;
  approval_count: PgInteger;
  version: PgInteger;
  target_id: string;
  target_handle: string;
  target_nickname: string;
  requester_id: string;
  requester_label: string;
  approver_id: string | null;
  approver_label: string | null;
}

interface ConfigRevisionRow extends PageRow {
  key: string;
  value_json: unknown;
  version: PgInteger;
  audience: Record<string, unknown>;
  region: string | null;
  min_app_version: string | null;
  effective_from: Date | null;
  effective_to: Date | null;
  state: string;
  reason: string;
  submitter_id: string;
  submitter_label: string;
  approver_id: string | null;
  approver_label: string | null;
}

interface ExportRow extends PageRow {
  dataset: string;
  purpose: string;
  state: string;
  watermark: string;
  expires_at: Date;
  max_downloads: PgInteger;
  download_count: PgInteger;
  requester_id: string;
  requester_label: string;
  approver_id: string | null;
  approver_label: string | null;
}

interface AuditLogRow extends PageRow {
  actor_id: string | null;
  actor_label: string | null;
  action: string;
  resource: string;
  resource_id: string | null;
  purpose: string | null;
  trace_id: string;
}

interface AdminUserRow {
  id: string;
  identity_user_id: string;
  roles: string[];
  data_scopes: string[];
  mfa_enrolled_at: Date;
  disabled_at: Date | null;
  label: string;
}
```

- [x] **Step 4: Apply the read query, loader, and mapper types**

Apply the matching types as follows:

| Declaration | Query/parameter type |
|---|---|
| `pointAdjustments`, `loadPointAdjustment`, `mapPointAdjustment` | `PointAdjustmentRow` |
| `configRevisions`, `loadConfigRevision`, `mapConfigRevision` | `ConfigRevisionRow` |
| `exports`, `loadExport`, `mapExport` | `ExportRow` |
| `auditLogs` | `AuditLogRow` |
| `adminUsers` | `AdminUserRow` |

The three mapper return types remain `unknown`. Keep JSONB output references unchanged. Do not use object spread on `value_json` or `audience`, and do not change the three select-fragment strings.

- [x] **Step 5: Run GREEN gates**

Run all Mandatory Commands, then API lint.

Expected: API lint exits 1 with exactly **174 errors**. All owned reads, loaders, and mappers must be lint-clean.

- [x] **Step 6: Independent review gate**

The fresh reviewer must reject:

- JSONB coercion or an unjustified object assertion;
- point or export counts narrowed to `number` at the database boundary;
- a nullable approver, actor, timestamp, label, or resource ID made non-null;
- changes to select fragments, response field names, permissions, or pagination;
- edits outside the Batch 2 declarations.

Proceed only with no Critical or Important findings.

- [ ] **Step 7: Commit the independently approved batch**

```bash
git add services/api/src/modules/ops/ops.service.ts services/api/src/modules/ops/ops.service.spec.ts
git commit -m "refactor(api): type ops admin read models"
```

---

### Task 3 / Batch 3: Type restriction, group, moderation, claim, and event-review paths

**Files:**

- Modify only the domain type import, type declarations, `assertVersion`, plus `restrictionDecision`, `groupLifecycleDecision`, `moderationCase`, `claimCase`, `decide`, and `reviewEvent` in `services/api/src/modules/ops/ops.service.ts`
- Add only the `OpsService typed safety mutations` characterization block in `services/api/src/modules/ops/ops.service.spec.ts`
- Do not modify `services/api/src/platform/auth.guard.spec.ts`

**Risks:**

- All state-changing reads use `FOR UPDATE`; typing must not move a query outside its transaction or remove a lock.
- RBAC and separation-of-duty checks must execute before writes exactly as they do now.
- Idempotency claim must remain inside the transaction and before the mutable resource read; completion must remain after audit and outbox writes.
- Moderation evidence uses a `LEFT JOIN` to media assets, so MIME type and byte size can be null. Action expiry and appeal decision time can be null.
- Group version and moderation versions are numeric strings in normal `pg` results.
- Event locale can be null; the existing `zh-Hans` fallback and poster idempotency query must remain unchanged.
- Once version rows use `PgInteger`, `assertVersion` must accept `PgInteger`; leaving its current `string | number` parameter would make bigint-backed rows fail typecheck.
- The four owned `UPDATE ... RETURNING` reads need a locally justified non-null result under `noUncheckedIndexedAccess`; do not hide them behind a broad row-array cast.

**Interfaces:**

- Produces concrete locked-row and detailed-read types for every owned safety workflow.
- Leaves exactly 58 global API lint errors, all in Batch 4 declarations.

- [x] **Step 1: Confirm Batch 3 RED**

Run API lint.

Expected: exactly 174 errors. Confirm every `query<any>` in the owned declarations remains visible before the repair, including the one Batch 3 detail-path callsite exposed by Batch 1's typed shared mapper.

- [x] **Step 2: Add lock/order and nullable-evidence characterization tests**

Add this detailed-case test with a moderator admin fixture:

```ts
interface ModerationCaseResult {
  assignee: { id: string; label: string } | null;
  reporter: { present: boolean };
  evidence: Array<{
    mimeType: string | null;
    byteSize: number;
    signedUrl: string | null;
  }>;
  actions: Array<{ expiresAt: string | null }>;
  appeals: Array<{ decidedAt: string | null }>;
}

it('preserves nullable moderation evidence, action, and appeal fields', async () => {
  const caseId = '00000000-0000-4000-8000-000000000051';
  const query = vi.fn()
    .mockResolvedValueOnce({ rows: [admin], rowCount: 1 })
    .mockResolvedValueOnce({
      rows: [{
        id: caseId,
        report_id: '00000000-0000-4000-8000-000000000052',
        public_reference: 'SPOTT-CASE-1',
        target_type: 'event',
        target_id: '00000000-0000-4000-8000-000000000053',
        reason: 'evidence review',
        severity: 'p1',
        status: 'open',
        sla_due_at: new Date('2026-07-18T00:00:00.000Z'),
        version: '4',
        created_at: new Date('2026-07-17T00:00:00.000Z'),
        reporter_id: null,
        assignee_id: null,
        assignee_label: null,
      }],
      rowCount: 1,
    })
    .mockResolvedValueOnce({
      rows: [{
        id: '00000000-0000-4000-8000-000000000054',
        asset_id: '00000000-0000-4000-8000-000000000055',
        retention_until: new Date('2026-08-17T00:00:00.000Z'),
        created_at: new Date('2026-07-17T00:00:00.000Z'),
        mime_type: null,
        byte_size: null,
      }],
      rowCount: 1,
    })
    .mockResolvedValueOnce({
      rows: [{
        id: '00000000-0000-4000-8000-000000000056',
        action_type: 'note',
        reason: 'triaged',
        expires_at: null,
        created_at: new Date('2026-07-17T00:00:00.000Z'),
      }],
      rowCount: 1,
    })
    .mockResolvedValueOnce({
      rows: [{
        id: '00000000-0000-4000-8000-000000000057',
        status: 'pending',
        created_at: new Date('2026-07-17T00:00:00.000Z'),
        decided_at: null,
      }],
      rowCount: 1,
    });
  const { service } = serviceWith(query);

  const result = await service.moderationCase(operator, caseId) as ModerationCaseResult;

  expect(result).toMatchObject({
    assignee: null,
    reporter: { present: false },
    evidence: [{ mimeType: null, byteSize: 0, signedUrl: null }],
    actions: [{ expiresAt: null }],
    appeals: [{ decidedAt: null }],
  });
});
```

Keep the existing event-review test unchanged and green; it already asserts one idempotency claim, one completion, and the poster job path. The independent reviewer, rather than a mock-order rewrite, must verify that the `FOR UPDATE` event/group/case reads and the claim/complete ordering are byte-for-byte unchanged outside added type parameters.

- [x] **Step 3: Add the exact safety row contracts**

```ts
interface RestrictionRow {
  id: string;
  status: string;
  restriction_flags: string[];
  version: PgInteger;
}

interface GroupLifecycleRow {
  id: string;
  owner_id: string;
  status: string;
  version: PgInteger;
}

interface VersionRow {
  version: PgInteger;
}

interface ModerationCaseDetailRow extends ModerationCaseListRow {
  report_id: string;
  reporter_id: string | null;
}

interface EvidenceRow {
  id: string;
  asset_id: string;
  retention_until: Date;
  created_at: Date;
  mime_type: string | null;
  byte_size: PgInteger | null;
}

interface ModerationActionRow {
  id: string;
  action_type: string;
  reason: string;
  expires_at: Date | null;
  created_at: Date;
}

interface AppealRow {
  id: string;
  status: string;
  created_at: Date;
  decided_at: Date | null;
}

interface ModerationClaimRow {
  id: string;
  assignee_id: string | null;
  status: string;
  version: PgInteger;
}

interface ModerationClaimUpdateRow {
  id: string;
  status: string;
  version: PgInteger;
  updated_at: Date;
}

interface ModerationDecisionRow {
  id: string;
  report_id: string;
  version: PgInteger;
  status: string;
  target_type: string;
  target_id: string;
}

interface EventReviewRow {
  organizer_id: string;
  status: EventStatus;
  version: PgInteger;
  poster_enabled: boolean;
  preferred_locale: string | null;
}
```

- [x] **Step 4: Apply the safety query types without changing transaction semantics**

Apply these exact query mappings:

| Query | Row type |
|---|---|
| restriction locked read and restriction update | `RestrictionRow` |
| group locked read | `GroupLifecycleRow` |
| group version-only update and moderation decision version-only update | `VersionRow` |
| moderation case detail | `ModerationCaseDetailRow` |
| case evidence/assets | `EvidenceRow` |
| moderation actions | `ModerationActionRow` |
| appeals | `AppealRow` |
| moderation claim locked read | `ModerationClaimRow` |
| moderation claim update | `ModerationClaimUpdateRow` |
| moderation decision locked read | `ModerationDecisionRow` |
| event review locked read | `EventReviewRow` |

The `UPDATE ... RETURNING version` calls use `VersionRow`. After typing `GroupLifecycleRow.status` as `string`, replace `let status = group.status as string` with `let status = group.status`; the assertion becomes unnecessary. Do not move any code across `database.transaction` or reorder any query.

Import the domain status type in the existing value import so the event-state-machine call remains exact:

```ts
import { DomainError, transitionEvent, type EventStatus } from '@spott/domain';
```

Widen only the internal version helper to the locked database-number type:

```ts
private assertVersion(actual: PgInteger, expected: number, label: string): void {
  if (this.integer(actual) !== expected) {
    throw new DomainError('VERSION_CONFLICT', `${label}已被其他运营更新。`, 409);
  }
}
```

For the restriction update, group update, moderation claim update, and moderation decision update, bind the returned row before reading it:

```ts
const updatedRow = updated.rows[0]!;
```

Use `updatedRow` for every subsequent response field. The assertion is local and proven: each method first finds the same row under `FOR UPDATE`, rejects absence, and then updates that row by the same primary key with no additional predicate in the same transaction. This preserves current behavior while satisfying `noUncheckedIndexedAccess`; if any SQL update later gains another predicate, replace the assertion with a tested fail-closed branch in that change.

- [x] **Step 5: Run GREEN gates**

Run all Mandatory Commands, then API lint.

Expected: API lint exits 1 with exactly **58 errors**, all owned by point/config/export mutation and approval declarations in Batch 4.

- [x] **Step 6: Independent review gate**

The fresh reviewer must trace each state-changing method from idempotency claim through lock, RBAC/state/version checks, mutation, audit, outbox, and idempotency completion. Reject:

- a lost `FOR UPDATE` or changed query order;
- a narrowed nullable evidence field;
- a locale fallback or poster behavior change;
- a state/version assertion removed rather than typed;
- edits outside the Batch 3 declarations.

Proceed only with no Critical or Important findings.

- [ ] **Step 7: Commit the independently approved batch**

```bash
git add services/api/src/modules/ops/ops.service.ts services/api/src/modules/ops/ops.service.spec.ts
git commit -m "refactor(api): type ops safety workflows"
```

---

### Task 4 / Batch 4: Type points/config/export approval paths and reach zero

**Files:**

- Modify only type declarations plus `decidePointAdjustment`, `executePointAdjustment`, `configImpact`, `approveConfig`, `activateConfig`, `rollbackConfig`, `approveExport`, and `exportDownloadTicket` in `services/api/src/modules/ops/ops.service.ts`
- Add only the `OpsService typed approval and execution mutations` characterization block in `services/api/src/modules/ops/ops.service.spec.ts`
- Do not modify `services/api/src/platform/auth.guard.spec.ts`

**Risks:**

- Wallet and adjustment values can exceed JavaScript's safe integer range. Convert them directly with `BigInt` and do not pass through `Number` or `integer()` before ledger arithmetic.
- Approval separation, required approval counts, current state checks, and version checks are security controls, not typing conveniences.
- Config rollback currently uses `SELECT *`; replace it with only the consumed fields so JSONB and nullable column contracts remain reviewable.
- Config impact is the read-only preflight for config approval: type its key/region/audience/effective-time row without changing the affected-user query, warning rule, or quote-protection response.
- Config activation and rollback must stay idempotent and transactional; do not move the active-revision supersede update.
- Export approval requires the existing `$3::uuid` cast, requester/approver separation, and an audit record. Download count increment must remain atomic.
- Every mutation must preserve claim/complete, audit, outbox, and lock ordering.

**Interfaces:**

- Produces typed approval, execution, rollback, and download rows.
- Eliminates all remaining 58 errors.
- Makes the standard API lint command exit 0 with zero warnings.

The final 58 errors are distributed across point decision/execution (23), config impact/approval/activation/rollback (27), and export approval/download (8).

- [x] **Step 1: Confirm Batch 4 RED**

Run API lint.

Expected: exactly 58 errors, all in the Batch 4 declarations. If an error remains in a prior batch, return it to that batch's reviewer rather than absorbing it here.

- [x] **Step 2: Add bigint and approval-order characterization tests**

Add an execution test using values above the JavaScript safe-integer boundary:

```ts
it('keeps point execution arithmetic in bigint space', async () => {
  const adjustmentId = '00000000-0000-4000-8000-000000000061';
  const targetUserId = '00000000-0000-4000-8000-000000000062';
  const transactionId = '00000000-0000-4000-8000-000000000063';
  const loaded = {
    id: adjustmentId,
    bucket: 'paid',
    amount: '9007199254740993',
    reason: 'restore verified balance',
    state: 'executed',
    points_transaction_id: transactionId,
    created_at: new Date('2026-07-17T00:00:00.000Z'),
    decided_at: new Date('2026-07-17T00:01:00.000Z'),
    executed_at: new Date('2026-07-17T00:02:00.000Z'),
    required_approvals: '2',
    approval_count: '2',
    version: '4',
    target_id: targetUserId,
    target_handle: 'balance_owner',
    target_nickname: 'Balance Owner',
    requester_id: '00000000-0000-4000-8000-000000000064',
    requester_label: 'Requester',
    approver_id: admin.id,
    approver_label: 'Approver',
  };
  const query = vi.fn()
    .mockResolvedValueOnce({ rows: [admin], rowCount: 1 })
    .mockResolvedValueOnce({
      rows: [{
        id: adjustmentId,
        target_user_id: targetUserId,
        bucket: 'paid',
        amount: '9007199254740993',
        state: 'approved',
      }],
      rowCount: 1,
    })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    .mockResolvedValueOnce({
      rows: [{ paid_balance: '9007199254740993', free_balance: '0' }],
      rowCount: 1,
    })
    .mockResolvedValueOnce({
      rows: [{ id: transactionId }],
      rowCount: 1,
    })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [loaded], rowCount: 1 })
    .mockResolvedValue({ rows: [], rowCount: 1 });
  const { service } = serviceWith(query);

  await service.executePointAdjustment(operator, adjustmentId, 'attempt-1', 'trace-bigint');

  const ledgerInsert = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO commerce.point_entries'));
  expect(ledgerInsert?.[1]).toEqual([
    transactionId,
    targetUserId,
    'paid',
    '9007199254740993',
    '-9007199254740993',
  ]);
});
```

Retain unchanged the existing tests that prove point self-approval is rejected before ledger writes and export approval retains `$3::uuid`; both must remain green after the row typing.

Add this complete config rollback regression:

```ts
it('reads only rollback-owned config columns and forwards JSONB unchanged', async () => {
  const revisionId = '00000000-0000-4000-8000-000000000071';
  const replacementId = '00000000-0000-4000-8000-000000000072';
  const value = { ranking: ['distance', 'quality'], enabled: true };
  const audience = { locales: ['zh-Hans', 'ja', 'en'] };
  const configAdmin = { ...admin, roles: ['configEditor'] };
  const query = vi.fn()
    .mockResolvedValueOnce({ rows: [configAdmin], rowCount: 1 })
    .mockResolvedValueOnce({
      rows: [{
        key: 'discovery.ranking',
        value_json: value,
        audience,
        region: null,
        min_app_version: null,
      }],
      rowCount: 1,
    })
    .mockResolvedValueOnce({ rows: [{ id: replacementId }], rowCount: 1 })
    .mockResolvedValueOnce({
      rows: [{
        id: replacementId,
        key: 'discovery.ranking',
        value_json: value,
        version: '8',
        audience,
        region: null,
        min_app_version: null,
        effective_from: null,
        effective_to: null,
        state: 'draft',
        created_at: new Date('2026-07-17T00:00:00.000Z'),
        reason: 'rollback verified revision',
        submitter_id: configAdmin.id,
        submitter_label: 'Config Editor',
        approver_id: null,
        approver_label: null,
      }],
      rowCount: 1,
    })
    .mockResolvedValue({ rows: [], rowCount: 1 });
  const { service } = serviceWith(query);

  await service.rollbackConfig(
    operator,
    revisionId,
    'rollback-attempt-1',
    'rollback verified revision',
    'trace-rollback',
  );

  expect(String(query.mock.calls[1]?.[0]).replace(/\s+/g, ' ').trim()).toBe(
    'SELECT key,value_json,audience,region,min_app_version FROM admin.config_revisions WHERE id=$1',
  );
  expect(query.mock.calls[2]?.[1]).toEqual([
    'discovery.ranking',
    value,
    audience,
    null,
    null,
    configAdmin.id,
    'rollback verified revision',
  ]);
});
```

- [x] **Step 3: Add the exact mutation row contracts**

```ts
interface PointApprovalRow {
  id: string;
  requested_by: string;
  state: string;
  required_approvals: PgInteger;
  approval_count: PgInteger;
}

interface PointExecutionRow {
  id: string;
  target_user_id: string;
  bucket: 'paid' | 'free';
  amount: PgInteger;
  state: string;
}

interface WalletBalanceRow {
  paid_balance: PgInteger;
  free_balance: PgInteger;
}

interface ConfigApprovalRow {
  id: string;
  version: PgInteger;
  state: string;
  submitted_by: string;
}

interface ConfigImpactRow {
  id: string;
  key: string;
  region: string | null;
  audience: unknown;
  effective_from: Date | null;
}

interface ConfigActivationRow {
  id: string;
  key: string;
  version: PgInteger;
  state: string;
}

interface ConfigRollbackRow {
  key: string;
  value_json: unknown;
  audience: Record<string, unknown>;
  region: string | null;
  min_app_version: string | null;
}

interface ExportApprovalRow {
  id: string;
  requested_by: string;
  state: string;
}

interface ExportDownloadRow {
  id: string;
  object_key: string | null;
  expires_at: Date;
  download_count: PgInteger;
  max_downloads: PgInteger;
}
```

- [x] **Step 4: Apply mutation query types and the explicit rollback select**

Apply the exact matching query generics:

| Query | Row type |
|---|---|
| point approval locked read | `PointApprovalRow` |
| point execution locked read | `PointExecutionRow` |
| locked wallet read | `WalletBalanceRow` |
| config impact preflight read | `ConfigImpactRow` |
| config approval locked read | `ConfigApprovalRow` |
| config activation locked read | `ConfigActivationRow` |
| config rollback source read | `ConfigRollbackRow` |
| export approval locked read | `ExportApprovalRow` |
| atomic export download update | `ExportDownloadRow` |

Replace only the config rollback source SQL with:

```ts
const source = await client.query<ConfigRollbackRow>(
  `SELECT key,value_json,audience,region,min_app_version
   FROM admin.config_revisions WHERE id=$1`,
  [revisionId],
);
```

Keep point arithmetic in this form:

```ts
const balance = BigInt(row.bucket === 'paid'
  ? wallet.rows[0]!.paid_balance
  : wallet.rows[0]!.free_balance);
const amount = BigInt(row.amount);
```

The non-null wallet row is justified by the immediately preceding `INSERT ... ON CONFLICT DO NOTHING` within the same locked transaction. If a reviewer prefers a fail-closed guard, add an explicit `WALLET_NOT_FOUND` domain error rather than a cast, but treat that as a separately approved behavior change.

- [x] **Step 5: Run the zero-lint GREEN gate**

Run all Mandatory Commands, then:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api lint
```

Expected: exit 0 with zero errors and zero warnings. Then run a repository search:

```bash
rg -n "query<any>|row: any|rows: any|Record<string, any>|eslint-disable|@ts-ignore|@ts-expect-error" \
  services/api/src/modules/ops/ops.service.ts \
  services/api/src/modules/ops/ops.service.spec.ts \
  services/api/src/platform/auth.guard.spec.ts
```

Expected: no matches.

- [x] **Step 6: Final independent security and correctness review**

Give a fresh reviewer the complete five-batch diff plus this plan. They must trace:

- every SQL select list against its row contract;
- bigint and numeric-string handling;
- every nullable `LEFT JOIN`/schema field;
- every timestamp conversion;
- config JSONB forwarding and the explicit rollback select;
- all RBAC, separation-of-duty, state, version, lock, idempotency, audit, and outbox orderings;
- the exact 471→457→324→174→58→0 evidence recorded by the implementer.

Proceed only with no Critical or Important findings. Minor findings must either be fixed and reverified or recorded with an explicit owner and reason before integration.

- [ ] **Step 7: Run final aggregate API gates from a fresh process**

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api lint
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api typecheck
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api test
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api build
git diff --check
```

Expected: every command exits 0; the current full API suite passes; `git diff --check` prints nothing. Record exact test-file and test-case counts from Vitest rather than copying the pre-implementation count.

- [ ] **Step 8: Commit the independently approved zero-lint batch**

```bash
git add services/api/src/modules/ops/ops.service.ts services/api/src/modules/ops/ops.service.spec.ts
git commit -m "refactor(api): eliminate ops lint debt"
```

## Completion Evidence Required

The executor must attach all of the following to the parent progress ledger:

- baseline three-file ESLint JSON summary showing 459 + 8 + 4 = 471;
- checkpoint totals 457, 324, 174, 58, and 0, with the commit or diff identity for each;
- focused Ops/guard Vitest output for every batch;
- final full API test, typecheck, lint, and build output;
- zero-match unsafe-pattern search output;
- final `git diff --check` output;
- independent reviewer verdicts for every batch, each with no Critical or Important findings.
