# Phase 1: Luma-Level Event Operations, With Spott Trust Guarantees

> **Execution discipline:** Use test-driven development for every numbered task, run real PostgreSQL concurrency tests for every ownership or capacity mutation, and obtain a fresh independent review before advancing. Do not start this plan until migrations `0022_media_upload_attempts.sql` and `0023_live_activity_tokens.sql` exist and replay cleanly. This plan owns migration `0024_event_operations.sql`.

**Goal:** Deliver recurring, online/hybrid, team-operated events plus guest operations, compliant outreach, calendars, staff check-in, and organizer analytics on native iOS and responsive Web in Simplified Chinese, Japanese, and English.

**Architecture:** Existing `events.events` rows remain the registration/capacity authority for one concrete occurrence. A new versioned series template generates bounded occurrence rows; single-occurrence overrides never mutate the series template. A central event-capability service authorizes owner, cohost, editor, marketer, check-in staff, and viewer roles for every API path. Online access, guest contact data, calendar tokens, and import/export material are encrypted or hashed and disclosed only to the minimum eligible scope. Campaigns, occurrence generation, exports, and delivery run through durable jobs/outbox receipts. Both clients consume the same OpenAPI contracts and expose native platform UX rather than static parity screens.

## Non-negotiable invariants

- One `events.events` row always represents one concrete occurrence with its own version, capacity, registration, waitlist, check-in, feedback, cancellation, and audit history.
- Existing single events remain valid with `series_id = NULL`; migration never invents recurrence or changes their public slug, time, capacity, or registration state.
- Recurrence is evaluated in the series IANA time zone. DST gaps/overlaps use an explicit, tested policy and never silently shift after a tzdata update; generated occurrences record the rule revision and intended local wall time.
- “This occurrence” changes only one occurrence. “This and future” creates a new immutable series revision boundary. Past, cancelled, checked-in, or registration-bearing occurrences are never rewritten by a broad edit.
- A series generator is bounded by both a rolling horizon and maximum count. Replaying or racing the generator creates exactly one row per `(series_id, occurrence_key)`.
- Public event responses never contain meeting URLs, passcodes, exact addresses, guest contact data, calendar secret tokens, staff device credentials, import rows, or marketing suppression reasons.
- Online access is available only to an authorized current registration and only inside the server-defined join window. Revocation, cancellation, account switch, block, and registration state changes fail closed immediately.
- Event roles are deny-by-default and server-owned. A caller body, route, cached client role, JWT role, or event `organizer_id` guess cannot grant a capability.
- The last owner cannot be removed. Ownership transfer, role elevation, CSV export, bulk removal, and campaign send require fresh step-up proof and immutable audit.
- A bulk operation is bound to an immutable selection snapshot, event version, normalized action, and caller-owned idempotency key. It never means “all rows matching this filter later.”
- CSV import is dry-run first, formula-safe, size/row bounded, encoding-explicit, and owner-scoped. Raw imports and exports have short retention, encryption, access audit, and deterministic deletion.
- Transactional event notices and optional marketing/newsletters have separate consent and suppression rules. Hosts cannot override unsubscribe, block, bounce, complaint, age, or legal suppression.
- Check-in staff receive a least-privilege event/occurrence assignment, not organizer authority. Offline manifests are signed, short-lived, device-bound, revocable, and contain no phone numbers or unrelated attendee answers.
- Web/Ops remain light-only with forced-colors/high-contrast/Reduce Motion support. Native iOS follows system appearance and uses iOS 26 Liquid Glass only at the view/control layer.

## Task 0: Lock contracts, permission matrix, and UX decisions

**Files:**

- Create: `docs/adr/ADR-001-event-series-and-occurrences.md`
- Create: `docs/adr/ADR-002-online-access-and-provider-boundary.md`
- Create: `docs/design/event-operations/permission-matrix.md`
- Create: `docs/design/event-operations/journey-spec.md`
- Modify: `packages/contracts/openapi.yaml`
- Modify generated bundle/client only through repository generation commands

- [ ] Write RED contract tests for series creation/update scopes, occurrence exceptions, team invitations/roles, online access resolution, guest snapshots, CSV jobs, campaigns, calendar feeds, staff assignments, and organizer analytics.
- [ ] Define exact role-to-capability cells for read draft, edit content, edit schedule, manage team, manage guests, send communications, export, check in, cancel, and transfer ownership. Every unspecified cell is denied.
- [ ] Define recurrence v1 as a deliberately bounded subset: single event, daily, weekly with explicit weekdays, and monthly by day-of-month; interval, count/until, exclusions, and local start/duration are explicit. Reject unsupported free-form RRULE rather than guessing.
- [ ] Define the DST policy with golden vectors for Tokyo and at least one DST zone: nonexistent local times reject at authoring; ambiguous times require an explicit earlier/later offset; future generation retains the chosen wall-time/offset policy.
- [ ] Define online access providers as `generic`, `zoom`, or `none`. Generic authenticated links can ship without a provider account; Zoom creation/sync remains fail-closed until external credentials are configured and authorized.
- [ ] Define three-language UX for broad-edit consequences, online-access privacy, role invitations, dry-run imports, suppression, offline staff mode, and partial job failure.
- [ ] Bundle/regenerate and prove zero drift before implementation.

## Task 1: Add the additive `0024_event_operations` schema

**Files:**

- Create: `database/migrations/0024_event_operations.sql`
- Create: `services/api/src/modules/events/events.operations-migration.spec.ts`
- Create: `services/api/src/modules/events/events.operations-migration.integration.spec.ts`
- Modify: `scripts/test-postgis.ts`
- Modify: `services/api/vitest.integration.config.ts`

- [ ] Add versioned `events.event_series`, `events.event_series_revisions`, and nullable series/occurrence identity columns on `events.events`. Enforce unique `(series_id, occurrence_key)` and preserve all legacy rows unchanged.
- [ ] Add `events.event_occurrence_exceptions` for cancel, reschedule, and detached override facts. Never overwrite the canonical generated identity.
- [ ] Add `events.event_team_members` and invitation records with owner/cohost/editor/marketer/checkin_staff/viewer roles, active/revoked timestamps, inviter, accepted owner, and version.
- [ ] Add encrypted `events.event_online_access`, join-window policy, provider reference hash, and disclosure audit; no plaintext URL/passcode appears in indexes or audit payloads.
- [ ] Add immutable guest-selection snapshots, bulk-operation receipts, CSV import/export jobs, audience/campaign/recipient/suppression rows, calendar-feed secrets, staff-device assignments, and delivery receipts with owner/event scope.
- [ ] Add least-privilege RLS/policies and constraints for last-owner protection, one active role per user/event, role enums, generation bounds, campaign state transitions, and job retention.
- [ ] Replay 0001–0024 twice from empty and upgrade a legacy fixture. Compare every pre-existing event/registration byte-relevant field before/after; pass two applies zero migrations.

## Task 2: Centralize event capabilities and team lifecycle

**Files:**

- Create: `services/api/src/modules/events/event-capability.service.ts`
- Create: `services/api/src/modules/events/event-capability.service.spec.ts`
- Create: `services/api/src/modules/events/event-team.service.ts`
- Create: `services/api/src/modules/events/event-team.service.spec.ts`
- Modify: `services/api/src/modules/events/events.module.ts`
- Modify: `services/api/src/modules/events/events.controller.ts`
- Modify: `services/api/src/modules/events/events.service.ts`
- Modify: `services/api/src/modules/registrations/registrations.service.ts`

- [ ] Start with a complete RED role/capability matrix, cross-event probes, revoked invitations, account A→B, blocked users, stale versions, and last-owner cases.
- [ ] Replace organizer-only checks in every event, attendee, feedback, media, check-in, campaign, export, and analytics path with one live-DB capability decision inside the mutation transaction.
- [ ] Team invitation acceptance binds the authenticated user, invitation nonce hash, event, role, expiry, and current event/team version. Forwarded, replayed, cross-account, or downgraded invitations fail closed.
- [ ] Ownership transfer uses fresh step-up proof, two confirmations, one transaction, outbox/audit, and leaves at least one owner. Failure or response loss replays one authoritative outcome.
- [ ] Add real PostgreSQL races for two owners removing each other, accept-vs-revoke, role downgrade-vs-bulk action, and owner transfer response loss.

## Task 3: Build deterministic series and occurrence generation

**Files:**

- Create: `services/api/src/modules/events/event-series.service.ts`
- Create: `services/api/src/modules/events/event-series.service.spec.ts`
- Create: `services/worker/src/event-series.ts`
- Create: `services/worker/test/event-series.test.ts`
- Modify: `services/worker/src/jobs.ts`
- Modify: `services/worker/src/config.ts`
- Modify: `services/api/src/modules/events/events.controller.ts`
- Modify: `services/api/src/modules/events/events.service.ts`

- [ ] RED-test wall-time/DST vectors, rule normalization, horizon/count limits, occurrence-key stability, exclusions, single override, future split, cancellation, response loss, and two-worker races.
- [ ] Create or revise a series and its first bounded occurrence window in one transaction/outbox boundary. The worker extends the horizon with `FOR UPDATE SKIP LOCKED` and unique occurrence keys.
- [ ] Copy only template-owned fields into a new occurrence. Capacity counters, registrations, waitlist offers, check-ins, feedback, version, moderation, and audit remain occurrence-owned.
- [ ] “This and future” closes the old revision boundary and creates a new revision; it does not mutate earlier occurrences or any row with participant state.
- [ ] Replaying generation after a crash or tzdata change converges without duplicate events, slugs, notifications, or capacity rows.

## Task 4: Complete online and hybrid participation safely

**Files:**

- Create: `services/api/src/modules/events/event-online-access.service.ts`
- Create: `services/api/src/modules/events/event-online-access.service.spec.ts`
- Modify: `services/api/src/modules/events/events.controller.ts`
- Modify: `services/api/src/modules/events/events.service.ts`
- Modify: `services/api/src/modules/registrations/registrations.service.ts`
- Modify: `services/worker/src/delivery.ts`
- Modify: `packages/contracts/openapi.yaml`

- [ ] Validate format/location combinations: in-person requires public area/location; online forbids exact physical disclosure; hybrid keeps both but separates eligibility.
- [ ] Encrypt generic/Zoom join URL and passcode with key-version metadata. Return only provider, join-window state, and safe instructions publicly.
- [ ] Resolve access from live registration/session/block/event state on every request. Confirmed/checked-in eligible users receive a short-lived one-time redirect ticket, never the stored URL in caches, logs, notifications, or sync payloads.
- [ ] Cancel, revoke, account switch, registration downgrade, block, and expired join window invalidate access. Add response-loss and concurrent resolve/revoke tests.
- [ ] Provider adapters are explicit fake/generic/Zoom implementations. Production Zoom paths fail closed without secrets; provider webhook signatures, replay IDs, and lifecycle reconciliation are mandatory before enabling creation.

## Task 5: Deliver guest search, immutable bulk operations, and safe CSV jobs

**Files:**

- Create: `services/api/src/modules/registrations/guest-operations.service.ts`
- Create: `services/api/src/modules/registrations/guest-operations.service.spec.ts`
- Create: `services/worker/src/guest-jobs.ts`
- Create: `services/worker/test/guest-jobs.test.ts`
- Modify: `services/api/src/modules/registrations/registrations.controller.ts`
- Modify: `services/api/src/modules/registrations/registrations.service.ts`
- Modify: `services/worker/src/jobs.ts`

- [ ] Search/filter against server-side status, source, attendance, tags, and submitted answers without returning hidden phone/contact values.
- [ ] Create immutable selection snapshots with exact registration IDs and versions. Bulk approve/reject/message/export consumes that snapshot plus event version and idempotency key.
- [ ] CSV import performs upload, encoding/schema validation, dry-run, duplicate/conflict preview, explicit confirmation, then idempotent apply. Escape spreadsheet formulas on every export and reject active content/macros.
- [ ] Encrypt raw contact fields, hash lookup identifiers, redact job errors, cap rows/bytes, expire raw artifacts, and audit every reveal/download with business reason and step-up actor.
- [ ] Two-client races prove no stale filter broadens a snapshot, no duplicate guest/registration is created, and cancelled/blocked users are not silently reactivated.

## Task 6: Add compliant invitations, scheduled campaigns, and calendars

**Files:**

- Create: `services/api/src/modules/events/event-campaign.service.ts`
- Create: `services/api/src/modules/events/event-campaign.service.spec.ts`
- Create: `services/api/src/modules/events/event-calendar.service.ts`
- Create: `services/api/src/modules/events/event-calendar.service.spec.ts`
- Create: `services/worker/src/event-campaigns.ts`
- Create: `services/worker/test/event-campaigns.test.ts`
- Modify: `services/worker/src/jobs.ts`
- Modify: `services/worker/src/delivery.ts`

- [ ] Separate required transactional notices from optional marketing consent. Build recipient snapshots after suppression checks; do not let later membership changes silently alter an approved send.
- [ ] Schedule/cancel/send with stable campaign and delivery attempt IDs. Worker crash, provider timeout, duplicate callback, and reschedule converge to one recipient outcome.
- [ ] Enforce unsubscribe, complaint, bounce, block, locale, age/legal, frequency, and quiet-hour policies before provider handoff. Store template version and rendered content hash, not raw private answers.
- [ ] Generate localized event/series ICS with stable UID/SEQUENCE and cancelled exceptions. Private team/subscriber feeds use rotated hashed tokens, `private, no-store`, revocation, and access audit.
- [ ] Provider credentials and production sends remain externally gated; deterministic fake adapters prove full behavior locally without claiming real delivery.

## Task 7: Ship least-privilege staff and resilient check-in

**Files:**

- Create: `services/api/src/modules/registrations/checkin-staff.service.ts`
- Create: `services/api/src/modules/registrations/checkin-staff.service.spec.ts`
- Modify: `services/api/src/modules/registrations/registrations.controller.ts`
- Modify: `services/api/src/modules/registrations/registrations.service.ts`
- Modify: `Spott/Features/CheckIn/QRScannerView.swift`
- Modify: related Web attendee/check-in surfaces and focused tests

- [ ] Assign/revoke staff devices with event, occurrence, actor, device binding, expiry, and capability version. Assignment never grants guest export, editing, messaging, or other-event access.
- [ ] Create signed incremental offline manifests containing only opaque registration/check-in identifiers and display-minimum names. No phone, answers, exact address, or unrelated attendee rows.
- [ ] Offline check-ins carry caller-owned operation IDs and signed manifest generation. Sync rejects revoked/stale/cross-event operations but preserves them for organizer review instead of silently dropping.
- [ ] Dynamic QR, six-digit, manual, and offline staff paths converge on the same exactly-once attendance reward and auditable correction flow.
- [ ] Real two-device tests cover weak network, clock skew, duplicate scans, revoke while offline, manifest expiry, and later reconciliation.

## Task 8: Build the premium responsive Web organizer experience

**Files:**

- Modify: `apps/web/app/create/EventComposer.tsx`
- Modify: `apps/web/app/studio/events/StudioEventsClient.tsx`
- Modify: `apps/web/app/studio/events/[id]/attendees/AttendeeManager.tsx`
- Modify: `apps/web/app/studio/insights/StudioInsightsClient.tsx`
- Create: series/team/campaign/calendar/import components under `apps/web/app/studio/events/[id]/`
- Modify: `apps/web/app/i18n/messages.ts`
- Add focused Vitest and Playwright files

- [ ] Add progressive recurring/online/team controls without lengthening the default single-event path. Show human-readable next occurrences and broad-edit consequences before mutation.
- [ ] Build one organizer workspace for overview, occurrences, team, guests, communications, calendar, check-in, and insights with URL-authoritative tabs and mobile-safe navigation.
- [ ] Imports use upload→dry run→conflict review→confirm→job progress. Bulk actions show immutable selected count/version and preserve input after safe failures.
- [ ] Campaign composition exposes audience, suppression estimate, locale previews, schedule/quiet hours, and final human confirmation; no AI or template automatically sends.
- [ ] Pass keyboard, screen-reader, 200% zoom, forced-colors, high contrast, reduced motion, phone/tablet/desktop, and light-only visual evidence in all three languages.

## Task 9: Build native iOS 26 organizer and attendee journeys

**Files:**

- Modify: `Spott/Features/EventComposer/EventComposerView.swift`
- Modify: `Spott/Features/CheckIn/QRScannerView.swift`
- Create: `Spott/Features/EventOperations/` native SwiftUI stores/views
- Modify: `Spott/Core/API/APIModels.swift`
- Modify: `Spott/Core/API/SpottAPIClient.swift`
- Modify all three localization catalogs and parity tests
- Add focused XCTest and XCUITest suites

- [ ] Use native SwiftUI navigation, forms, calendars, tables/lists, scanners, share sheets, file import/export, and iOS 26 Liquid Glass controls. Do not embed the Web organizer UI.
- [ ] Mirror the same series scope, team capability, guest snapshot, campaign confirmation, calendar, online-access, and staff-offline state machines as Web.
- [ ] Store private online access and offline staff material only in owner/device-scoped Keychain/protected files; logout/account switch cancels tasks and removes only that active private presentation scope.
- [ ] Support system light/dark, Dynamic Type through accessibility sizes, VoiceOver, Reduce Motion, 44-point targets, keyboard/iPad navigation, and exact zh-Hans/ja/en parity.
- [ ] Real Simulator journeys cover create recurring hybrid series, single exception, invite cohost, guest dry run/bulk action, scheduled notice preview, calendar subscription, staff offline reconciliation, and attendee join-window access.

## Task 10: Prove parity, reliability, and release quality

**Files:**

- Create: `tests/e2e/event-operations-parity.spec.ts`
- Create: `tests/integration/event-series-concurrency.test.ts`
- Create: `tests/integration/event-team-permissions.test.ts`
- Create: `tests/integration/event-campaign-delivery.test.ts`
- Create: `docs/quality/event-operations-evidence.md`
- Modify: `.superpowers/sdd/progress.md` only after approval

- [ ] Run migration replay/legacy upgrade, API/worker full lint/typecheck/build/tests, OpenAPI bundle/client drift, real PostgreSQL concurrency, Web unit/build/Playwright, signed iOS full tests/XCUITest, accessibility/localization, and global diff/secret scans.
- [ ] Run cross-client journeys: Web creates a weekly hybrid series; iOS edits one occurrence; a cohost handles guests; staff checks in offline; Web observes one authoritative result; cancelled/future edits and campaign recipients converge.
- [ ] Capture zh-Hans/ja/en Web phone/tablet/desktop light-only and iOS phone/iPad light/dark screenshots. Include empty, loading, partial failure, permission denied, offline, conflict, and success states.
- [ ] Measure occurrence generation, guest filtering, bulk mutations, calendar feeds, join access, and organizer dashboards against API p95/load budgets; reject N+1 and unbounded series/campaign work.
- [ ] Perform independent security, recurrence/time-zone, privacy/communications, accessibility/localization, Web UX, iOS UX, and aggregate code reviews with zero Critical/Important findings.
- [ ] Update the competitor matrix only after every dual-client real journey and evidence row is current. Local fake provider evidence must not be labeled production email/Zoom delivery.

## Explicit external gates and non-goals

- Production Zoom, email/SMS, object storage, APNs, domain/TLS, and marketing delivery require credentials plus explicit deployment authorization. Code and fake-adapter proof may complete locally; real provider rollout remains externally blocked until then.
- This phase does not add platform ticket payment, refunds, paid membership, chat, private messaging, or AI generation. Those retain their separate ADR/legal/commercial approval gates.
- Android remains out of scope. Native iOS and responsive Web must both be complete before a parity row closes.
