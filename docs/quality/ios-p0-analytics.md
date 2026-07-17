# iOS P0 Analytics Current-Tree Evidence

Updated: 2026-07-17 (Asia/Tokyo)

Status: **Implemented, closeout open**. This file records current evidence; it does not replace the final signed iOS aggregate or an independent production-wiring review.

## Contract and privacy boundary

- `AnalyticsClient` is injected by the production `SpottApp` composition and uses the public `POST /v1/analytics/events/batch` boundary without credential-vault access, Authorization, or Cookie headers.
- Consent is read for every event from `analytics.consent` and defaults off. Consent-off work returns before event creation, encoding, or transport.
- The anonymous device UUID and per-client analytics-session UUID are separate.
- Property values use a typed Sendable JSON model. Forbidden property keys are removed recursively from nested objects and arrays.
- Production signals contain only public event/category identifiers, status, counts, region, reason, and a poster boolean. No title, description, exact address, note, answers, phone, token, or free-form message is passed by the four call sites.
- Encoding, network, cancellation, non-2xx, and response failures are best-effort and do not affect business operations.

## Production call-site inventory

| Signal | Production entry | Current condition |
|---|---|---|
| `discovery_viewed` | `AppModel.bootstrap()` and `AppModel.refresh(reason:)` | Wired, but success attribution requires the correction below |
| `event_detail_viewed` | `EventDetailNativeView.startIfNeeded()` | One guarded view-lifetime emission before optional refresh |
| `registration_completed` | `EventDetailNativeView.registrationCompleted(_:)` | Only after API registration success |
| `event_submission_completed` | `EventComposerView` final submit branch | Only after API event submission success |

`LegacyEventDetailView` also contains historical analytics calls but is private and not routed; production `RoutedEventView` resolves to the native `EventDetailView` declared in `EventDetailNativeView.swift`.

## Current automated evidence

- Focused result: `/private/tmp/spott-analytics-task23-20260717.xcresult`
- Environment: signed iOS 26.5 `Spott-CI` Simulator
- Result at the recorded checkpoint: 6 passed / 0 failed / 0 skipped
- Covered behavior: exact request contract, default-off/dynamic consent, recursive sanitizer, contained transport failure, independent session identity, and stable four-signal factories.

## Open correctness finding

`DiscoveryStore.loadInitial()` and `refresh()` currently contain transport errors in observable state and return `Void`. `AppModel` therefore emits `discovery_viewed` after the call even when the remote request failed or only stale offline cache remains. The original approved analytics plan requires discovery analytics after a successful response.

Close this with RED/GREEN tests that make the store return an explicit success receipt (or equivalent generation-bound result), emit only for the current successful replacement, and prove cancellation, stale generation, offline fallback, and error paths do not emit. Callers that do not need the receipt may discard it explicitly.

## Required before Complete

1. Fix and verify discovery success attribution without changing discovery UI/error behavior.
2. Run a fresh focused analytics suite plus the current signed full iOS unit aggregate.
3. Obtain an independent production-wiring/privacy review with zero Critical/Important findings.
4. Record exact current-tree call sites, result bundle checksums, and final aggregate evidence in the single completion matrix.
