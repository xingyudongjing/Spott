# Backend Contract Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the audited API gaps for correction queues, group transfer recovery, organizer profiles, media attachment, poster URLs, and secure account merging.

**Architecture:** Extend the existing NestJS services and append-only PostgreSQL migrations, keeping authorization inside transactional service methods. Model every public response in OpenAPI and regenerate `@spott/api-client`; media URLs come only from worker-approved derivative metadata.

**Tech Stack:** NestJS 11, TypeScript 6, PostgreSQL, Zod, jose, Vitest, OpenAPI 3.1, Redocly.

## Global Constraints

- Do not modify iOS or Web code.
- Preserve and verify the existing `GET /events/{id}/checkin-corrections` implementation.
- Apple iOS tokens remain restricted to `APPLE_BUNDLE_ID`; Web tokens use `APPLE_SERVICE_ID` with the same nonce validation.
- Account merge commit requires a fresh, short-lived second-account credential proof and a serializable transaction.
- Only ready, approved public media derivatives may be returned as public URLs.

---

### Task 1: Verify Host Correction Queue

**Files:**
- Modify: `services/api/src/modules/registrations/registrations.service.spec.ts`
- Modify: `packages/contracts/openapi.yaml`

- [ ] Add tests proving organizers and operators can list the event queue, unrelated users receive `403`, status filtering is parameterized, and attendee/registration identifiers are present.
- [ ] Run `pnpm --filter @spott/api test -- registrations.service.spec.ts` and confirm the new authorization case fails for the expected missing behavior if applicable.
- [ ] Apply the smallest service/contract correction needed and rerun the focused test.

### Task 2: Recover Active Group Transfers

**Files:**
- Modify: `services/api/src/modules/groups/groups.controller.ts`
- Modify: `services/api/src/modules/groups/groups.service.ts`
- Modify: `services/api/src/modules/groups/groups.service.spec.ts`
- Modify: `packages/contracts/openapi.yaml`

- [ ] Add failing service tests for owner/from/to visibility and unrelated-member denial.
- [ ] Implement `GET /groups/{id}/transfers/active` with an active-state query and participant-only authorization.
- [ ] Return the complete `GroupTransfer` shape, including `id`, `groupId`, `fromUserId`, `toUserId`, state, expiry, and cooling deadline.
- [ ] Rerun the focused group tests.

### Task 3: Public Organizer Events

**Files:**
- Modify: `services/api/src/modules/profiles/profiles.controller.ts`
- Modify: `services/api/src/modules/profiles/profiles.service.ts`
- Create: `services/api/src/modules/profiles/profiles.service.spec.ts`
- Modify: `packages/contracts/openapi.yaml`

- [ ] Add failing tests that resolve UUID/handle profiles and return only published, registration-closed, in-progress, ended, or archived non-deleted events.
- [ ] Implement `GET /profiles/{id}/events` with cursor pagination and public event summaries, never drafts/rejected/removed/cancelled rows.
- [ ] Rerun the focused profile tests.

### Task 4: Attach Avatar and Group Cover Media

**Files:**
- Modify: `services/api/src/modules/media/media.controller.ts`
- Modify: `services/api/src/modules/media/media.service.ts`
- Create: `services/api/src/modules/media/media.service.spec.ts`
- Add: `database/migrations/0014_backend_contract_gaps.sql`
- Modify: `services/api/src/modules/profiles/profiles.service.ts`
- Modify: `services/api/src/modules/groups/groups.service.ts`
- Modify: `packages/contracts/openapi.yaml`

- [ ] Add failing tests for correct purpose/owner/state/moderation checks, group-owner authorization, atomic replacement, and returned derivative URL.
- [ ] Add `POST /media/{id}/attach/profile` and `POST /media/{id}/attach/group/{groupId}`.
- [ ] Persist the new binding, mark the replaced asset deleted only when no other live binding exists, record sync changes, and return the usable derivative URL.
- [ ] Update profile/group read models to expose ready derivative URLs and run focused tests plus migrations.

### Task 5: Poster URL Response

**Files:**
- Modify: `services/api/src/modules/growth/growth.service.ts`
- Create: `services/api/src/modules/growth/growth.service.spec.ts`
- Modify: `packages/contracts/openapi.yaml`

- [ ] Add a failing test where a ready poster has a `poster` derivative URL.
- [ ] Join the asset row in `GET /posters/{id}` and return `url` only for ready/approved assets.
- [ ] Rerun the focused growth test.

### Task 6: Secure Second-Identity Account Merge and Web Apple

**Files:**
- Modify: `services/api/src/config.ts`
- Modify: `services/api/src/config.spec.ts`
- Modify: `services/api/src/modules/auth/auth.controller.ts`
- Modify: `services/api/src/modules/auth/auth.service.ts`
- Create: `services/api/src/modules/auth/auth.service.spec.ts`
- Modify: `database/migrations/0014_backend_contract_gaps.sql`
- Modify: `.env.example`
- Modify: `packages/contracts/openapi.yaml`

- [ ] Add failing tests proving iOS Apple uses only the bundle audience, Web Apple uses only the Service ID audience, and both validate the SHA-256 nonce.
- [ ] Add failing tests proving merge preview requires a second credential, rejects the current identity, stores a short-lived proof, and commit rejects missing/expired/replayed proofs.
- [ ] Implement provider credential verification shared by login and merge without broadening audience acceptance.
- [ ] Implement a serializable merge transaction with row locks, deterministic conflict handling, merge audit, session rotation, and one-time job consumption.
- [ ] Rerun auth tests.

### Task 7: Contract Generation and Full Verification

**Files:**
- Modify: `packages/contracts/openapi.yaml`
- Regenerate: `packages/contracts/openapi.bundle.yaml`
- Regenerate: `packages/api-client/src/schema.d.ts`

- [ ] Run `pnpm contract:lint` and `pnpm contract:bundle`.
- [ ] Run `pnpm --filter @spott/api-client generate` and its lint/typecheck/test/build tasks.
- [ ] Run database migrations, API/worker/domain lint, typecheck, tests, and builds.
- [ ] Exercise the new runtime endpoints with curl against the local API and record the authorization matrix and external credential requirements.

### Task 8: Feedback Runtime Contract Alignment

**Files:**
- Modify: `services/api/src/modules/registrations/registrations.service.spec.ts`
- Modify: `packages/contracts/openapi.yaml`
- Regenerate: `packages/api-client/src/schema.d.ts`

- [ ] Add contract assertions for the runtime feedback request (`attendanceRating`, enumerated `tags`, `comment`, `visibility`) and privacy-thresholded summary (`sampleSize`, `minimumSampleSize`, `published`, tag rates).
- [ ] Replace the stale OpenAPI feedback schemas with the exact controller/service shapes and reference the response schema from the summary endpoint.
- [ ] Run Redocly and generated-client verification with the rest of Task 7.

### Task 9: Block/Unblock Transaction Regression

**Files:**
- Modify: `services/api/src/modules/safety/safety.service.spec.ts`
- Modify: `services/api/src/modules/safety/safety.service.ts`

- [ ] Reproduce the polymorphic PostgreSQL parameter failure in the `sync.record_change` JSONB payload.
- [ ] Add the explicit boolean cast at the JSONB construction boundary and rerun the focused service test.
- [ ] Exercise authenticated PUT and DELETE `/users/{id}/block` against PostgreSQL and ask the Web owner to re-verify.
