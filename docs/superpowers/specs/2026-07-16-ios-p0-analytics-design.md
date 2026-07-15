# iOS P0 Analytics Design

## Goal

Add a privacy-gated iOS analytics client for `POST /v1/analytics/events/batch` and connect the four P0 product events without allowing analytics failures to affect user-facing work.

## Scope

- Track `discovery_viewed`, `event_detail_viewed`, `registration_completed`, and `event_submission_completed`.
- Use the existing `analytics.consent` preference as an explicit opt-in. Its default remains `false`.
- Reuse the stable, persisted `DeviceIdentity.current` UUID as `anonymousId`.
- Create a separate in-memory analytics session UUID for each `AnalyticsClient` lifetime.
- Keep Web and Ops unchanged.

## Architecture

`Core/Analytics/AnalyticsClient.swift` owns analytics event construction, privacy sanitization, JSON encoding, and public transport. It is an actor so event construction and transmission are serialized without blocking the main actor. `AppModel` receives the client through initialization and exposes a fire-and-forget tracking method to views and success handlers.

Analytics transport is intentionally separate from `SpottAPIClient`. The analytics endpoint is public, so the client never reads the credential vault and never adds an authorization or cookie header. A transport closure is injectable for deterministic tests.

## Payload

Each request contains one event in the backend batch envelope:

```json
{
  "events": [
    {
      "eventName": "discovery_viewed",
      "schemaVersion": 1,
      "anonymousId": "stable-device-uuid",
      "sessionId": "analytics-session-uuid",
      "platform": "ios",
      "properties": {},
      "occurredAt": "2026-07-16T00:00:00Z"
    }
  ]
}
```

The event and batch models are `Encodable`, `Sendable`, and testable as values. UUID strings are lowercase and dates use ISO 8601.

## Consent and Identity

The client reads `UserDefaults.bool(forKey: "analytics.consent")` for every call. When the value is `false`, the client returns before creating an event, queueing work, encoding a body, or invoking transport. Changing the preference therefore affects the next event immediately.

`anonymousId` is the existing persisted device UUID. `sessionId` is a distinct UUID created when the analytics client starts and remains stable only for that client lifetime. It is not the login session ID.

## Privacy Sanitization

Properties use a typed JSON value rather than `[String: Any]`. Before encoding, the client recursively removes object keys whose normalized word tokens contain backend-sensitive names: `phone`, `email`, `address`, `otp`, `code`, `token`, `password`, `evidence`, `statement`, `body`, or `message`. Normalization handles snake case, punctuation, and camel case, so names such as `phoneNumber`, `access_token`, and `messageBody` are all removed.

Sanitization applies to nested objects and objects inside arrays. Values are not inspected for semantic content because all production call sites use allowlisted identifiers, counts, statuses, regions, categories, and source values.

## Event Integration

- `discovery_viewed`: after a successful initial discovery response with `reason = "initial"`; after a successful explicit refresh with `reason = "manual"` or the matching `SyncReason` value. The reason prevents refresh events from being indistinguishable duplicates.
- `event_detail_viewed`: when `EventDetailView` begins its detail-loading task, with event ID, public slug, and category.
- `registration_completed`: only after the registration API succeeds, with event ID, registration status, and party size.
- `event_submission_completed`: only after event submission succeeds, with event ID, resulting status, category, and poster-enabled state.

No free-form note, description, exact location, message, token, answer, or other user-entered body is collected.

## Failure Behavior

Tracking is best-effort. Encoding failures, transport errors, cancellations, and non-2xx responses are contained inside `AnalyticsClient.track`. Business flows do not await an analytics result and never show an analytics error. There is no retry queue in this P0 implementation, which also guarantees that consent-off events are not retained for later transmission.

## Testing

Swift Testing tests use an isolated UserDefaults suite plus injected UUIDs, clock, and transport recorder. They prove:

1. The request path, method, batch envelope, event fields, fixed `ios` platform, lowercase IDs, ISO timestamp, and absence of authorization/cookie headers.
2. Consent defaults to off, produces no event or transport call, turns on dynamically, and stops immediately after being turned off again.
3. Sensitive keys are removed recursively while safe keys remain.
4. A transport failure is swallowed and the async tracking call completes normally.
5. Separate analytics client lifetimes receive independent session IDs while using the same injected stable anonymous ID.

The focused analytics tests run first for each red-green cycle, followed by the full `SpottTests` suite and an iOS Simulator build-for-testing/test run.
