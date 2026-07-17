# Spott single completion matrix

Updated: 2026-07-17 (Asia/Tokyo)

This is the only closeout ledger for the product audit, the Codex development prompt, the deduplicated handoff document, and parent Tasks 1–23. A checked implementation plan is not enough: `Complete` requires current code, current automated gates, real rendered journeys, localization/accessibility evidence, independent review, and any required release/external evidence.

## Source keys

- `A-P0/P1`: `SPOTT_FULL_PRODUCT_AUDIT.md` sections 4–5.
- `A-Parity`: audit sections 6–8 and roadmap phases 1–4.
- `A-Design`: audit sections 9, 12, and 13.
- `D-Constraints`: `CODEX_DEVELOPMENT_PROMPT.md` sections 5–9.
- `D-Backlog`: development prompt section 10.
- `H`: `Spott项目交接文档-20260716.docx`; the `_副本` file is byte-identical and is not a second requirement set.
- `P`: `docs/superpowers/plans/2026-07-16-cross-platform-core-journey-ui.md`.

## Status vocabulary

- `Complete`: every required evidence class is current and independently approved.
- `Implemented, closeout open`: product code exists and substantial tests pass, but one or more required current evidence classes remain.
- `In progress`: an active TDD/review loop is modifying the slice.
- `Planned, approved`: an independently approved execution plan exists; implementation has not closed.
- `Planned, review open`: the plan exists but is rejected or awaiting independent approval.
- `Externally blocked`: code may be ready, but credentials, commercial/legal decisions, physical-device provider evidence, or deployment authorization are absent.

## Tasks 1–23

| Task | Source mapping | Current state | Current evidence | Required before Complete |
|---|---|---|---|---|
| 1. Reproducible Web build | A-P0-4/5, D-Constraints | Implemented, closeout open | Shared Sites source, stable scripts, manifest typing, repeated Web builds | Final CI execution and branch-protection evidence |
| 2. Discovery/location/reputation contract | A-P0-1/3, D-Backlog | Implemented, closeout open | OpenAPI/query models/migrations and generated clients exist | Final aggregate contract and real API matrix |
| 3. Server-side discovery/privacy filters | A-P0-1/3, A-Design | Implemented, closeout open | Real PostGIS integration and privacy query tests pass | Final load/performance and cross-client acceptance |
| 4. Cross-client query/CTA model | A-P0-3, D-Constraints | Implemented, closeout open | Web/iOS models and focused tests exist | Final aggregate Web+iOS contract drift gate |
| 4A. Itinerary summary without N+1 | A-Design, D-Backlog | Implemented, closeout open | API/Web/iOS itinerary models and tests exist | Real API cross-device convergence evidence |
| 5. Web discovery and map | A-P1-2, A-Design | Implemented, closeout open | Task 21 current Web unit 278/278, rendered 25/25, real Chrome 34/34 and independent review all pass | Final whole-product screenshots and later aggregate regression rerun |
| 6. Web detail/registration/itinerary | A-Design, A-Parity | Implemented, closeout open | Current browser core journey and 409 reconfirmation pass | Parent checklist reconciliation and final accessibility evidence |
| 7. iOS router and Gate recovery | A-P1-3, D-Constraints | Implemented, closeout open | Router 13/13; native UI journey 17/17 | Real API-backed route/registration journey |
| 8. Native iOS discovery/MapKit | A-P0-1, A-P1-1/3 | Implemented, closeout open | Native store/view tests and simulator UI exist | Final real API, coordinate privacy, light/dark/language screenshots |
| 9. Native detail/registration/itinerary | A-Design, A-Parity | Implemented, closeout open | Native stores, registration, itinerary and simulator UI exist | Real API cross-device/last-seat journey |
| 10. Trilingual/theme/accessibility | A-P1-1/3, D-Constraints | In progress | zh-Hans/ja/en parity tests, iOS system appearance, Web light-only foundations | Whole-product string audit, contrast/forced-colors and final a11y matrix |
| 11. Real journeys/visual evidence | A-Design, D-Constraints | In progress | Web 33/33 and iOS UI 17/17 checkpoints exist | Exact final-tree reruns, real API two-device flows, complete screenshot matrix |
| 12. Aggregate release branch | D-Constraints | In progress | API/Web/iOS focused/full checkpoints exist | All tasks closed, final review, identity check, intentional commit/push |
| 13. Web session security/cross-tab | A-P0-2, D-Backlog | In progress | S0 Tasks 1–6 independently approved C0/I0/M0 after Task 6 repaired real Fetch Metadata, supplied-invalid credential, strict Bearer/Cookie, and DB-boundary gaps; reviewer-current focused 76/76 + API 505/505 | Finish S0 Tasks 7–8 after Task 22 releases shared `auth.service.ts`, then S1 cookie/BFF cutover and cross-tab/full-reload/logout E2E |
| 14. Offline sync/cursor/convergence | A-P0/P1 stability, D-Backlog | Implemented, closeout open | iOS cursor/operation foundations and migration 0020 exist | Web IndexedDB sync, durable conflicts, two-iOS+Web convergence |
| 15. CI/generated/non-functional gates | A-P0-4/5, D-Constraints | In progress | Toolchain 15/15; generated artifacts 3/3; ownership/portable runner green; migration atomic 7/7; exact Postgres/PostGIS 13/13; fail-closed aggregator/evidence/coverage/Chromium/clean-job/owned-command/event-base/secret gates 53/53; real 32-commit secret scan clean | Real replay after 0022 stabilizes, independent Task 2/3 review, complete real workflows/Tasks 3–7, transitive input ownership graph, clean-clone evidence, trusted non-author reviewer, required-check/ruleset read-back and deliberate-failure PR proof |
| 16. Ops/async/data security | A-Design trust, D-Backlog | Implemented, closeout open | RBAC/audit/RLS/worker foundations and focused tests exist | Step-up, complete scope proof, providers, exports/lifecycle/alerts |
| 17. Production/SLO/DR/compliance | Audit phase 0, D-Backlog | Planned, review open | Local infrastructure and requirements exist | IaC, observability, restore/DR drill, compliance; deployment authorization |
| 18. Luma/Meetup parity and leadership | A-Parity, audit phases 1–4, H | In progress | Activity/group/safety/share/media/points foundations exist | Remaining organizer/community/commerce/growth features and six leading capabilities |
| 19. Recoverable SwiftData bootstrap | A-P1-4, H | In progress | Task 0 review repair now passes exact-current full-Scheme aggregate 70/70 and the real AppModel destructive-reset guard 1/1 on signed iOS 26.5 | Fresh zero-Important re-review, Tasks 1–5, corruption/downgrade simulator evidence |
| 20. iOS release surfaces | A-P1-3/5, H | In progress | AppIcon layers/provenance and installed evidence are being finalized exclusively on owner-mandated iOS 26.5 build 23F77; older-runtime evidence is historical and no longer a gate | Zero-Important Task 1 re-review on iOS 26.5, Tasks 2–4, final archive/device APNs/real Sandbox evidence |
| 21. Tokyo/SEO/PWA trilingual Web | A-P1-1/2, H | Complete | Root-current Web unit 278/278, rendered 25/25, real Chrome 34/34, lint/typecheck/build/diff-check; independent review Critical/Important/Minor 0 | Closed on the current Task 21 tree; later aggregate rerun guards against subsequent regressions |
| 22. Recoverable media upload | D-Constraints cross-layer, H | In progress | Task 1 independently approved C0/I0/M0 after repair; focused 57/57, API full 428 passes, api-client 9/9 and generation stable | Task 2 durable migration active, then API/Web/iOS response-loss, concurrent PUT, SIGKILL cleanup and report replay implementation plus final review |
| 23. Reconcile historical evidence | D-Constraints completion definition | In progress | Contract hashes stable; exact-current combined browser fixture 35/35 including runtime permission matrix 121/121; Analytics 6/6 with a discovery-success attribution defect documented | Analytics correction/review, final API/contract rerun after later migrations, independent route review, final source-to-evidence manifest |

## Current verified artifacts

- Web/API exact-current-tree Playwright: 35/35, including 121 protected-operation permission probes, real pointer hit-testing, forced-colors interaction, and all prior core journeys.
- Web unit: 24 files / 278 tests; rendered HTML/font/source: 25/25.
- API exact-current Task 3 aggregate: 27 files / 326 unit tests; 4 files / 26 PostgreSQL integration tests; lint, typecheck, build, migrations 0001–0021 first pass plus no-op second pass all passed. Fresh security review remains open.
- API contract regeneration: bundle and generated schema hashes unchanged; API client 9/9.
- iOS Analytics: `/private/tmp/spott-analytics-task23-20260717.xcresult`, 6/6 on iOS 26.5.
- Runtime permission matrix: 121/121 protected OpenAPI operations rejected anonymous access with request IDs inside the passing 35/35 combined run; current evidence SHA-256 is `8a65adc690e70579024ebab6837cdfd5dc5bf58b727551f76f95acf34c9d3303`.
- Persistence Task 0 repair: exact-current full-Scheme aggregate 70/70 and real AppModel sign-out/expiration destructive-reset guard 1/1 on signed iOS 26.5; independent data-isolation re-review remains open.
- iOS native UI: `/private/tmp/spott-ios-ui-final-full.xcresult`, 17/17 at that checkpoint.
- iOS router: `/private/tmp/spott-ios-router-suite-final.xcresult`, 13/13 at that checkpoint.

These artifacts are evidence for their rows only. None alone makes the whole product Complete.
