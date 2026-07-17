# Backend Contract Gaps Current-Tree Evidence

Updated: 2026-07-17 (Asia/Tokyo)

Status: **Implemented, closeout open**. Historical Tasks 1–6 and 8–9 have substantial implementation, but this document records only evidence actually rerun against the active worktree.

## Generated contract parity

- OpenAPI source lint: passed at the recorded Task 23 checkpoint.
- Regenerated `packages/contracts/openapi.bundle.yaml` SHA-256: `8adb2fb2ea556d7edb6abc30ae24e8064974e7a807148c2e99d405c253dd1b20` and unchanged at that checkpoint.
- Regenerated `packages/api-client/src/schema.d.ts` SHA-256: `17b36559cca32b109ffc6a83188f358c73d797774e2a7bb6415ecc36b28612f4` and unchanged at that checkpoint.
- API client lint, typecheck, build, and unit tests passed; unit count was 9/9.

These hashes are checkpoint evidence, not permanent checksum pins. The final gate must regenerate on the final source tree and reject any diff.

## PostgreSQL 18/PostGIS evidence

- `scripts/test-postgis.ts --all` discovered every current API `*.integration.spec.ts` on the exact current tree.
- Migrations 0001–0021 replayed from an empty isolated `_test` database.
- The second migration pass applied zero migrations.
- The pinned 0020 source checksum and PostGIS availability were verified.
- Exact-current integration result: 4 files / 22 tests passed, including the real HTTP Web-BFF boundary matrix, session migration, registration concurrency, and discovery/PostGIS suites.

The same run also passed API unit tests 27 files / 308 tests, lint, typecheck, and production build. Later migrations and integration specs invalidate these numeric totals until the same aggregate is rerun.

## Runtime authorization matrix

- Test source: `tests/e2e/api-permission-matrix.spec.ts`.
- Runner wiring: `scripts/run-core-journey-e2e.ts` explicitly includes the permission spec.
- Source of operations: every OpenAPI operation without an operation-level `security: []` declaration.
- Exact-current-tree combined result: 121 protected operations / 121 denials; every response was HTTP 401 and carried an `x-request-id`.
- Credential-shaped response fields were absent.
- Evidence file: `output/playwright/api-permission-matrix.json`.
- Current evidence SHA-256: `8a65adc690e70579024ebab6837cdfd5dc5bf58b727551f76f95acf34c9d3303`.

The first combined browser run exposed shared anonymous rate-limit state rather than an authorization escape. The matrix now sends a dedicated valid device UUID so its 121 requests use a separate rate-limit bucket. `APIExceptionFilter` was also corrected so a Fastify rate-limit error remains safe HTTP 429 rather than becoming 500, and unknown exception stacks no longer log request secrets. The exact-current-tree production fixture then passed all 35/35 Playwright cases in one run: the 121-operation permission matrix plus every existing rendered discovery and core-journey case. The runner exited 0 after cleanly terminating Web/API and PostgreSQL.

## Required before Complete

1. Finish and independently approve the active S0 Task 3 auth changes.
2. Rerun OpenAPI lint, bundle regeneration, client generation, API-client gates, full API unit tests, and all PostgreSQL integration specs after every new migration.
3. Run a final independent route/permission review and retain the machine-readable matrix plus logs without credentials.
4. Record exact final-tree hashes and links in `docs/quality/final-completion-matrix.md`; do not check historical tasks merely because matching files exist.
