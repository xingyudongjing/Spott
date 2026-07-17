# Task 15: Reproducible, Fail-Closed CI and Release Quality Gates Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` task by task, `superpowers:test-driven-development` for every repository behavior, and `superpowers:verification-before-completion` before checking a gate. Do not weaken a failing product check to make CI green. A repository workflow is not a merge barrier until the external GitHub ruleset has been read back and independently verified.

**Goal:** Convert the current local API, Worker, Web, Ops, and native iOS checks into reproducible GitHub Actions gates for generated contracts, immutable migrations, PostgreSQL 18/PostGIS, Node 24, real browser and native journeys, supply-chain security, accessibility, performance, load, and backup recovery.

**Architecture:** Linux jobs use digest-pinned services and exact toolchain locks. Native jobs use the GitHub-hosted `macos-26` arm64 runner plus a checksum- and signature-pinned arm64 PostgreSQL 18/PostGIS distribution; they start the API and an isolated database on loopback so Release XCUITests traverse the real network and database. Sharded implementation jobs feed seven stable `if: always()` aggregator jobs. A fail-closed catch-all CODEOWNERS rule and external GitHub ruleset protect every transitive gate input. Repository-owner capability is detected first: a personal repository uses strict up-to-date pull-request protection, while an eligible organization repository additionally proves merge queue/`merge_group` behavior.

**Primary references:** GitHub Actions service containers run only on Linux runners; the `macos-26` hosted runner is arm64; skipped dependent jobs may otherwise report success; merge queues require `merge_group` and are not available to the current user-owned public repository. Re-verify repository owner type, hosted-image, and distribution availability during implementation, then record capability profile, immutable URLs, versions, signatures, and SHA-256 values in committed evidence.

---

## Completion boundary

Task 15 has three distinct states:

1. **Repository implementation ready:** all scripts, locks, workflows, real integration tests, clean-clone runs, and independent code/security review are green.
2. **External protection active:** the base branch has effective catch-all CODEOWNERS and a ruleset requiring exactly the seven PR checks from the GitHub Actions App, a non-author trusted code-owner approval, stale-approval dismissal, last-push approval where available, no bypass, and the capability-matched update policy. A user-owned repository requires strict branch-up-to-date validation; an eligible organization repository additionally requires merge queue coverage.
3. **Complete:** both states above are true and a real pull request proves fail-closed behavior. A real merge-group run is additionally mandatory only when the owner-capability preflight reports that merge queue is supported and enabled.

If there is no second trusted reviewer, state 2 is **Externally blocked**. Organization-level required-workflow authority can strengthen but does not replace non-author review. Do not claim that an owner can make their own workflow-changing pull request tamper-proof merely by committing tests to the same repository, and do not claim merge-queue evidence on the current `xingyudongjing/Spott` user-owned repository unless the user explicitly authorizes a transfer to an eligible organization and the owner type is read back afterward.

## Non-negotiable constraints

- Commit `ci/toolchain-lock.json` with exact Node `24.x.y`, pnpm, Xcode path/build, iOS runtime/build, the Playwright `1.61.1` Linux image digest plus Chromium/ffmpeg executable hashes/revision, k6 artifact, PostgreSQL client, macOS PostgreSQL/PostGIS artifact, and every service image digest. Major versions and mutable tags do not satisfy the lock.
- Pin every third-party Action by its full 40-character commit SHA with a human-readable release comment. A test rejects tags and shortened SHAs.
- Java is explicitly `not_applicable` while the tree has no Gradle, Maven, Java, or Kotlin source. A sentinel fails if such a file appears before an exact JDK vendor/version/checksum is added to the lock.
- Required jobs restore no GitHub cache. They delete `.turbo`, `dist`, `.next`, build output, browser caches, test output, DerivedData, databases, and generated temporaries before execution and force the underlying commands to execute. Dependency installation is frozen and integrity-checked from the lockfile.
- Workflow-level permissions are exactly `contents: read` for pull requests and merge groups. Checkout uses `persist-credentials: false`. Required jobs never use `environment:`, repository/environment secrets, `pull_request_target`, a write token, or an untrusted GitHub expression interpolated directly into a shell script.
- Pull requests, including forks and Dependabot, run the same local fail/pass decisions. Secret and dependency findings fail inside the untrusted job; optional SARIF upload is a separate trusted push-only job and cannot turn a PR gate green.
- Database-destructive scripts share one two-phase ownership state machine. A fresh target may be created only after loopback/owned-socket validation, same admin/target endpoint, unpredictable run-ID prefix + `_test`, exact PostgreSQL/PostGIS versions, and a current-token admin registry/run lock. Immediately after CREATE it writes a target marker. Any existing-target reset/drop/restore requires both matching admin registry and target marker; remote, foreign, ambiguous, or half-created state is refused.
- Generated verification runs generators and compares the clean worktree. Migration verification additionally compares the pull request with its base commit and an append-only manifest; a fresh database replay alone is not proof of migration immutability.
- Web E2E uses a production build inside the digest-pinned official Playwright `v1.61.1-noble` image matching the exact package, with locked Chromium/ffmpeg hashes, an isolated real API/database, and no branded Chrome/live browser download.
- iOS Keychain/session tests run a signed Release Simulator product. `CODE_SIGNING_ALLOWED=NO` and `-allowProvisioningUpdates` are forbidden for those gates. Every SwiftPM resolve/build/test/archive command uses checked-in `Package.resolved`, an empty job-owned SourcePackages directory, and all four no-update flags defined in Task 5.
- Required real-API iOS UI tests do not use the existing `#if DEBUG` launch fixtures. The Release app accepts a test endpoint only while launched by XCTest and only when the URL is loopback; the test asserts server request IDs and database outcomes.
- UI tests use one worker and zero product retries. An infrastructure rerun is a separately recorded attempt retaining both `.xcresult` files.
- Every uploaded artifact has a SHA-256 manifest, is scanned for token/credential patterns before upload, uses `if-no-files-found: error`, and has seven-day PR or fourteen-day scheduled retention.
- `continue-on-error`, swallowed exit codes, `|| true`, placeholder commands, path filters, skipped required shards, and mutable downloaded executables are forbidden.
- CI performs no deployment, registry push, App Store/export/upload, release creation, package publication, provider message, purchase, refund, or cloud mutation.

## Stable check contract

### Required PR checks and, when supported, merge-group checks

1. `contracts-generated`
2. `node-quality`
3. `postgres-integration`
4. `web-core-journey`
5. `security-supply-chain`
6. `ios-unit-release`
7. `ios-ui-core-journey`

Each name belongs to a non-matrix aggregator job with `if: always()`. The aggregator receives all relevant shard results through `needs`, asserts every result is exactly `success`, rejects `skipped`, `cancelled`, and missing artifacts, verifies their SHA-256 manifests, and then emits its own bounded status artifact. Branch protection requires exactly these seven names and binds them to the GitHub Actions App integration.

### Scheduled/manual checks, never branch-required

1. `nightly-load-concurrency`
2. `nightly-accessibility-performance`
3. `nightly-backup-restore`

Pull-request workflows and supported merge-group workflows cancel only older runs for the same PR/ref or merge group. Scheduled and manual drills never cancel a previous drill, so a later run cannot hide a failure.

---

## Task 0: Establish immutable trust and toolchain inputs

**Files:**

- Create: `ci/toolchain-lock.json`
- Create: `ci/toolchain-lock.schema.json`
- Create: `scripts/ci/verify-toolchain-lock.mjs`
- Create: `scripts/ci/download-verified-tool.sh`
- Create: `tests/quality/toolchain-lock.test.mjs`
- Create: `.github/CODEOWNERS`

- [x] Write RED tests rejecting semver ranges, mutable container tags without digests, missing SHA-256/signature metadata, unknown fields, unavailable local files, and a Java-family file while Java remains `not_applicable`.
- [x] Lock exact Node/pnpm/Xcode/iOS/k6/PostgreSQL values and digest-pin PostGIS, MinIO, Redis, Mailpit, and ClamAV. Lock `mcr.microsoft.com/playwright:v1.61.1-noble` by manifest digest and record the Chromium/ffmpeg executable paths, revisions, byte sizes, and SHA-256 values inside that image. Record artifact origin/license; the JSON contains no credentials.
- [x] For macOS arm64, lock a PostgreSQL 18 distribution containing the required PostGIS version by HTTPS URL, byte size, SHA-256, code-signing authority/team identifier when signed, and expected `postgres --version`/`SELECT postgis_full_version()` output. Do not install from live Homebrew metadata during a required job.
- [x] `download-verified-tool.sh` enforces HTTPS/TLS, downloads into a job-owned directory, checks size and SHA-256 before extraction, verifies the declared macOS signature when applicable, rejects symlink/path traversal, and prints no environment values.
- [ ] Resolve a real non-author trusted GitHub login from explicit repository authorization. The base-branch CODEOWNERS first rule is fail-closed catch-all `*` owned by that trusted identity; narrower later rules may add specialists but cannot remove catch-all coverage. If no identity is authorized, do not invent one and leave external activation blocked.
- [ ] Build a workflow transitive-input graph from every `run`, local action, package script, test/integration coverage manifest, Xcode scheme/test plan, and invoked config. The contract test proves every executable input—including `scripts/e2e/**`, `scripts/test-postgis.ts`, `scripts/run-core-journey-e2e.ts`, `tests/e2e/**`, `tests/load/**`, `tests/performance/**`, `playwright.config.ts`, Worker real-service specs, shared schemes/test plans, and `SpottUITests/**`—matches effective base-branch CODEOWNERS.

## Task 1: Lock workflow behavior with RED repository tests

**Files:**

- Create: `tests/quality/ci-workflow-contract.test.mjs`
- Create: `tests/quality/required-pr-checks.json`
- Create: `tests/quality/scheduled-checks.json`
- Modify: `package.json`

- [x] Add RED tests proving all workflow files exist, parse as YAML, use exact triggers (`pull_request`, capability-ready `merge_group`, protected-branch `push`, `workflow_dispatch`, and `schedule` only where intended), and have no path filters. The workflow may listen for future `merge_group`, but evidence/rules require it only under the eligible-organization capability profile.
- [x] Assert exact stable aggregator names, `if: always()`, complete `needs` result checks, explicit timeouts, no matrix-derived required names, correct PR/scheduled concurrency, and artifact failure/retention/hash rules.
- [x] Assert exact top-level permissions, checkout `persist-credentials: false`, full-history checkout for secret scanning, no `pull_request_target`, no `environment`, no secret references in untrusted jobs, and safe environment-variable transfer for event data instead of direct shell interpolation.
- [x] Assert full action SHAs, exact toolchain-lock use, digest-only service images, frozen installation, bundled Chromium, zero required-job caches, forced command execution, and absence of `continue-on-error` or shell error suppression.
- [x] Assert workflows contain no App Store/export/upload, registry push, `gh release`, `npm publish`, cloud deploy, provider-send, or issue-writing command. The initial nightly workflow is read-only.
- [x] Add `test:quality:ci` and capture the expected RED result before adding workflows.

## Task 2: Make generation and migrations immutable

**Files:**

- Create: `scripts/verify-generated-artifacts.sh`
- Create: `tests/quality/generated-artifacts.test.mjs`
- Create: `database/migration-manifest.json`
- Create: `database/migration-manifest.schema.json`
- Create: `scripts/ci/verify-migration-manifest.mjs`
- Create: `tests/quality/migration-manifest.test.mjs`
- Create: `scripts/e2e/database-safety.ts`
- Create: `scripts/e2e/database-safety.test.ts`
- Create: `scripts/e2e/database-harness.ts`
- Create: `scripts/e2e/database-harness.test.ts`
- Modify: `scripts/test-postgis.ts`
- Modify: `scripts/run-core-journey-e2e.ts`
- Modify: `scripts/migrate.ts` only after a RED portability/safety test
- Modify: `package.json`

- [x] Generated verification runs contract lint, bundles OpenAPI, regenerates `packages/api-client/src/schema.d.ts`, and rejects any clean-worktree difference. An isolated-copy tamper test proves both files fail and a clean regeneration passes without printing their contents.
- [ ] Seed `migration-manifest.json` with every existing migration using only numeric sequence, exact filename, and SHA-256; do not include a self-referential introduction commit. Review and hash the seed as a one-time immutable baseline, while provenance is derived independently from base-branch git history and the approving workflow run.
- [ ] For pull requests and supported merge groups, fetch the exact base SHA with credentials disabled. Reject deletion, edit, rename, reordering, checksum changes, or manifest rewrites for an existing entry; only a strictly higher, contiguous appended migration and matching manifest row are accepted. Reject duplicate/gapped prefixes and unlisted SQL files.
- [x] After replay, compare every `schema_migrations` row with the manifest, not with the same current SQL file that populated it. Run a second no-op pass and confirm the database checksum set remains identical.
- [ ] Make migration, E2E, fixture, and backup scripts use the shared two-phase database ownership state machine. Under an admin-session advisory lock, an absent target gets an admin registry row in `creating` state before `CREATE DATABASE`, then a target marker on first connection, then registry `ready`. Existing targets require matching registry + marker + current run token before reset/drop/restore; cleanup deletes target only with both proofs and then removes registry.
- [ ] Unit/integration tests cover crash before CREATE, crash after CREATE/before target marker, crash after marker/before registry-ready, retry by same token, refusal by another token, same-name foreign database, TOCTOU between existence check and CREATE, restore into a fresh registered target, and cleanup. Half-created or foreign state is quarantined/refused, never silently dropped.
- [ ] Remove `/opt/homebrew`, fixed ports, hard-coded local binaries, and shell command construction from the core runner. Provide local-owned-cluster, Linux-service, and macOS-pinned-distribution modes with unique database, device bucket, output path, ports, and origin.
- [ ] Add `check:generated` and `test:integration:postgres`; verify both against PostgreSQL 18 and the locked PostGIS version.

## Task 3: Prove integration coverage and add Linux gates

**Files:**

- Create: `tests/quality/integration-coverage.json`
- Create: `tests/quality/integration-coverage.test.mjs`
- Create: `.github/workflows/ci.yml`
- Create: `tests/e2e/ops-rbac.spec.ts`
- Create: `services/worker/test/media.minio.integration.spec.ts`
- Modify: `tests/quality/ci-workflow-contract.test.mjs`
- Modify: `playwright.config.ts`

- [ ] The coverage manifest maps every `*.integration.spec.*`, E2E spec, Worker real-service test, Ops journey, migration replay, and database dependency to one required or scheduled shard. An orphan scanner fails when a new integration/E2E file has no gate or when a manifest path disappears.
- [ ] Switch Playwright from `channel: "chrome"` to bundled Chromium and run the Web browser shard inside the digest-pinned official `v1.61.1-noble` image. Do not run `playwright install` or install live OS packages. Verify the package version, browser revision, Chromium executable SHA-256, and ffmpeg SHA-256 against `ci/toolchain-lock.json` before tests.
- [ ] Linux internal shards use digest-pinned PostGIS/MinIO/Redis/Mailpit/ClamAV as required. Health checks validate versions and bind published ports to loopback.
- [ ] `contracts-generated` aggregator covers clean generation, migration-base immutability, lock/schema validation, and clean-worktree assertions.
- [ ] `node-quality` aggregator covers lint, typecheck, unit tests, rendered-source tests, and production builds for API, Worker, Web, Ops, and packages, with command execution forced and no restored build cache.
- [ ] `postgres-integration` aggregator covers two-pass replay, all discovered API integration specs, real MinIO Worker media processing/cleanup, ownership checks, and machine-readable results.
- [ ] `web-core-journey` aggregator covers a production API/Web/Ops fixture, the runtime permission matrix, all user core journeys, an authenticated Ops least-privilege/RBAC journey, Chromium traces/screenshots, and clean shutdown. Each shard owns its database and ports.
- [ ] Workflow contract and a deliberate failing shard prove each stable aggregator fails on `failure`, `cancelled`, `skipped`, missing report, or bad artifact hash.

## Task 4: Add fork-safe security and supply-chain gates

**Files:**

- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/security-report.yml`
- Create: `docs/operations/security-gate-policy.md`
- Create: `tests/quality/fork-safety.test.mjs`
- Modify: `tests/quality/ci-workflow-contract.test.mjs`

- [ ] `security-supply-chain` performs full-history secret scanning with a reviewed allowlist, dependency review, frozen-lock audit at the documented severity, artifact/config scanning, and workflow-policy validation. Local scanner exit codes determine the gate; upload cannot mask failure.
- [ ] Scan built API/Web/Worker/Ops artifacts and source maps for credential-shaped data, private configuration, and world-readable secret files. Save only redacted JSON.
- [ ] A separate push-only workflow may upload sanitized SARIF with minimal `security-events: write`; it never checks out or executes pull-request code with secrets and is not a required PR check.
- [ ] Run fork and Dependabot fixture events proving no secrets, write token, protected environment, cached artifact, shell injection, or privileged event path is reachable. Record the repository Actions setting that withholds fork secrets and write tokens.
- [ ] Document remediation ownership and time-bounded exceptions. Exceptions require a separately reviewed policy change; inline skip or `continue-on-error` is invalid.

## Task 5: Add signed native iOS 26 gates with a real API

**Files:**

- Create: `.github/workflows/ios.yml`
- Create: `Spott.xcodeproj/xcshareddata/xcschemes/Spott-CI.xcscheme`
- Create: `SpottTests/Spott-CI-Unit.xctestplan`
- Create: `SpottUITests/Spott-CI-RealAPI.xctestplan`
- Create: `scripts/ci/select-ios-simulator.sh`
- Create: `scripts/ci/bootstrap-macos-postgis.sh`
- Create: `scripts/ci/run-ios-real-api-e2e.sh`
- Create: `scripts/ci/summarize-xcresult.sh`
- Create: `scripts/e2e/ios-real-api-fixture.ts`
- Create: `SpottUITests/RealAPICoreJourneyUITests.swift`
- Create: `tests/quality/ios-ci-contract.test.mjs`
- Modify: `Spott/App/AppModel.swift` only through a RED loop for the guarded loopback XCTest endpoint
- Modify: `SpottUITests/SpottUITests.swift` only to share non-fixture helpers

- [ ] Select and verify the exact locked Xcode/iOS runtime. Every direct `xcodebuild` resolve/build/test/archive invocation supplies `-disableAutomaticPackageResolution -skipPackageUpdates -disablePackageRepositoryCache -onlyUsePackageVersionsFromResolvedFile -clonedSourcePackagesDirPath <job-owned-empty-directory>`. Hash the one authoritative checked-in `Package.resolved` before/after, reject any additional workspace/project resolved file, and prove no global repository cache path is read.
- [ ] Bootstrap the locked arm64 PostgreSQL/PostGIS artifact without Homebrew. Initialize a job-owned cluster on an owned Unix socket, verify signature/hash/runtime versions, create the marked `_test` database, and guarantee cleanup through the shared validator.
- [ ] Start API fixture dependencies and the production API build on `127.0.0.1`. A test-only OTP provider writes a one-time code to a mode-600 job-owned file; it adds no production route. Seed users/events through an owner-token control process before launch, not through launch mocks.
- [ ] The Release app accepts `SPOTT_API_BASE_URL` only when XCTest launch evidence is present and the parsed URL is exactly HTTP loopback with the runner-owned port. Malformed, non-loopback, user-info, redirect, and non-test overrides are ignored/rejected. `XCUIApplication.launchEnvironment` sets the validated URL; XCUITest reads test credentials from its own process and never passes provider secrets to the app.
- [ ] `RealAPICoreJourneyUITests` proves login/OTP, discovery, detail, registration/last-seat or waitlist, itinerary, cancellation, account switch/logout, and server-side outcome using request IDs plus direct post-journey database assertions. It runs in Release and contains no `-ui-testing` fixture argument.
- [ ] `ios-unit-release` aggregator requires signed Release build-for-testing and signed unit execution for Keychain add/read/delete, session isolation, localization parity, persistence recovery, analytics, AppIcon verifier, and concurrency diagnostics. Forbid `CODE_SIGNING_ALLOWED=NO` and `-allowProvisioningUpdates`; verify the installed test app with `codesign --verify --deep --strict`.
- [ ] `ios-ui-core-journey` aggregator requires one-worker real-API Release XCUITest plus light/dark, zh-Hans/ja/en, largest Accessibility Text, iPhone/iPad, routing, and screenshot manifests. Missing/skipped required cases fail the summary.
- [ ] Upload sanitized build logs, screenshots, JUnit, and `.xcresult` on pass and failure. An explicit infrastructure rerun uses a new result path and keeps both attempts.
- [ ] A separate unsigned archive may prove package contents and absence of development `.storekit`/debug assets. It is labeled content-audit-only, cannot satisfy signing/Keychain/device gates, and is never exported or uploaded to Apple.
- [ ] Physical-device APNs and StoreKit Sandbox remain protected manual evidence after explicit authorization and are not exposed to pull-request jobs.

## Task 6: Add executable scheduled non-functional drills

**Files:**

- Create: `.github/workflows/nightly.yml`
- Create: `tests/load/registration-last-seat.js`
- Create: `tests/load/discovery-read.js`
- Create: `tests/e2e/accessibility.spec.ts`
- Create: `tests/performance/web-budget.spec.ts`
- Create: `tests/performance/api-budget.spec.ts`
- Create: `tests/performance/web-budgets.json`
- Create: `tests/performance/api-budgets.json`
- Create: `tests/quality/non-functional-report.schema.json`
- Create: `scripts/ci/backup-restore-drill.sh`
- Create: `scripts/ci/verify-evidence-manifest.mjs`
- Create: `docs/operations/non-functional-gates.md`
- Modify: `tests/quality/ci-workflow-contract.test.mjs`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

- [ ] Download the exact locked k6 and PostgreSQL 18 client artifacts through the verified downloader. Runtime version checks must match the lock.
- [ ] `nightly-load-concurrency` runs authenticated last-seat/waitlist contention and discovery reads against isolated fixtures. It validates authoritative counts/idempotency, not only HTTP status, and enforces committed latency/error/correctness budgets in machine-readable JSON.
- [ ] Add direct exact dev dependency `axe-core: 4.12.1` and inject its locked `axe.min.js` into the Playwright accessibility spec; no unpinned CDN/script is allowed. `nightly-accessibility-performance` covers required pages, languages, viewports, keyboard, forced-colors, and Reduce Motion, then runs `web-budget.spec.ts` and `api-budget.spec.ts` against committed Web/API thresholds. Both produce schema-validated machine-readable reports and fail independently on missing samples/budgets.
- [ ] `nightly-backup-restore` seeds representative private/encrypted rows, backs up with matching PG18 tools, destroys only the marked database, restores into a new marked `_test` database, replays pending migrations, and validates row counts, hashes, ownership isolation, and application reads.
- [ ] Scheduled artifacts retain fourteen days, include sanitized logs plus SHA manifests, and cannot write issues or external systems in the initial implementation.

## Task 7: Prove clean-clone behavior and activate external protection

**Files:**

- Create: `docs/operations/required-github-checks.md`
- Create: `docs/quality/ci-evidence-manifest.json`
- Modify: `docs/quality/final-completion-matrix.md`
- Modify: `.superpowers/sdd/progress.md` only after independent approval

- [ ] Run every required command in a clean clone with an empty cache directory, no untracked files, no developer database, and no global Homebrew assumption. Retain exact tool versions, run IDs, result counts, hashes, and clean-worktree proof.
- [ ] Read repository metadata first and record owner login/type plus feature availability. For the current user-owned repository, run a real fork pull request, Dependabot-equivalent event, and ordinary pull request under strict branch-up-to-date protection. Only after an explicitly authorized transfer/readback to an eligible organization may the evidence profile additionally require a real merge queue and `merge_group` run.
- [ ] Deliberately fail one shard, delete one expected artifact in a test branch, alter one old migration, and modify one transitive gate input. Verify the stable aggregator or required non-author code-owner review blocks each case.
- [ ] Obtain independent CI/security review with zero Critical/Important findings across permissions, action/tool pins, fork safety, database ownership, migration-base immutability, real API iOS execution, cache exclusion, artifacts, and failure propagation.
- [ ] Bootstrap fail-closed catch-all CODEOWNERS with the repository-approved non-author trusted reviewer. Before enabling required checks, prove the effective base branch owns every transitive gate input; changes to CODEOWNERS itself require the prior base-branch owner rule.
- [ ] With explicit repository authorization, configure a ruleset requiring exactly the seven PR checks, matching GitHub Actions App integration ID, at least one non-author approval plus code-owner approval, dismissed stale approvals, last-push approval where available, strict branch-up-to-date, and no administrator/bypass actor. On an eligible organization profile, additionally enable/read back merge queue; on the current personal profile, do not claim or require an unavailable feature.
- [ ] Read back and save repository owner type/capabilities, the complete ruleset, Actions fork settings, allowed-actions policy, required-check integration IDs, CODEOWNERS resolution, strict update policy, and organization-only merge-queue configuration when applicable. Redact tokens; store hashes and GitHub run/settings URLs.
- [ ] Prove that scheduled check names are not branch-required. Do not mark Task 15 Complete while any required job is unrun, red, skipped, mutable, unenforced, or self-approvable.

## Mandatory final commands

Run through the locked wrappers from a clean checkout; ellipses below are job-owned loopback values, never remote URLs:

```bash
corepack pnpm install --frozen-lockfile
pnpm test:quality:ci
pnpm check:generated
pnpm lint
pnpm typecheck
pnpm test
pnpm build
SPOTT_TEST_DATABASE_URL=postgres://127.0.0.1/..._test pnpm test:integration:postgres
pnpm test:e2e:core:web
scripts/ci/run-ios-real-api-e2e.sh
git diff --check
```

The iOS wrapper must show the exact underlying signed Release `xcodebuild` commands, shared scheme/test plans, destination UDIDs, API/DB loopback endpoints, and result paths without printing credentials.

## External acceptance boundary

- Hosted-runner availability, Actions minutes, repository owner type/transfer, trusted reviewers, organization-only merge queue, organization policies, branch rules, protected manual environments, physical devices, APNs credentials, and StoreKit Sandbox accounts are external state.
- Repository implementation may proceed without those accounts. External protection and provider/device evidence require explicit user authorization and are recorded as blocked until actually read back.
- This plan authorizes no production deployment, cloud resource creation, DNS/TLS change, provider message, purchase/refund, App Store upload, package publication, or destructive non-test database action.
