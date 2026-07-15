# iOS P0 Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a privacy-gated, non-blocking iOS analytics client and connect the four required P0 product events.

**Architecture:** A standalone `AnalyticsClient` actor owns opt-in checks, stable anonymous identity, independent analytics session identity, recursive property sanitization, encoding, and unauthenticated transport. `AppModel` injects it into existing discovery and view success paths through a fire-and-forget wrapper.

**Tech Stack:** Swift 6, Foundation, SwiftUI Observation, Swift Testing, Xcode Simulator tests.

## Global Constraints

- `analytics.consent` defaults to `false`; when false, do not construct, queue, encode, or transmit an event.
- Send only to `POST /v1/analytics/events/batch` with `eventName`, `schemaVersion`, `anonymousId`, `sessionId`, `platform = "ios"`, `properties`, and `occurredAt`.
- Use persisted `DeviceIdentity.current` for `anonymousId` and a separate per-client analytics session UUID.
- Remove sensitive keys including phone, email, address, OTP, code, token, password, evidence, statement, body, and message at any nesting depth.
- Analytics failures must never alter, delay, or fail a business operation.
- Do not modify Web or Ops.
- The workspace has no Git metadata, so verification records replace commit steps.

---

### Task 1: Analytics payload, consent, sanitization, and transport

**Files:**
- Create: `Spott/Core/Analytics/AnalyticsClient.swift`
- Create: `SpottTests/AnalyticsClientTests.swift`

**Interfaces:**
- Produces: `AnalyticsEventName`, `AnalyticsPropertyValue`, and `actor AnalyticsClient`.
- Produces: `AnalyticsClient.track(_:properties:) async` that never throws.
- Consumes: `APIEnvironment`, `DeviceIdentity.current`, `UserDefaults`, and an injectable `AnalyticsClient.Transport` closure.

- [ ] **Step 1: Write failing payload and transport tests**

Create tests that instantiate the wished-for client with fixed IDs and clock, enable the isolated defaults suite, invoke `track`, and inspect a captured request:

```swift
@Test func analyticsPayloadMatchesIOSBatchContract() async throws {
    let defaults = isolatedDefaults(consent: true)
    let recorder = RequestRecorder()
    let client = AnalyticsClient(
        environment: .init(baseURL: URL(string: "https://api.spott.test/v1")!),
        defaults: defaults,
        anonymousID: UUID(uuidString: "00000000-0000-0000-0000-000000000111")!,
        sessionID: UUID(uuidString: "00000000-0000-0000-0000-000000000222")!,
        now: { ISO8601DateFormatter().date(from: "2026-07-16T00:00:00Z")! },
        transport: { request in await recorder.capture(request) }
    )

    await client.track(.discoveryViewed, properties: [
        "region": .string("tokyo"),
        "itemCount": .integer(3),
        "reason": .string("initial"),
    ])

    let request = try #require(await recorder.requests.first)
    #expect(request.url?.path == "/v1/analytics/events/batch")
    #expect(request.httpMethod == "POST")
    #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
    #expect(request.value(forHTTPHeaderField: "Cookie") == nil)
    let data = try #require(request.httpBody)
    let root = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    let events = try #require(root["events"] as? [[String: Any]])
    let event = try #require(events.first)
    #expect(Set(event.keys) == ["eventName", "schemaVersion", "anonymousId", "sessionId", "platform", "properties", "occurredAt"])
    #expect(event["eventName"] as? String == "discovery_viewed")
    #expect(event["schemaVersion"] as? Int == 1)
    #expect(event["anonymousId"] as? String == "00000000-0000-0000-0000-000000000111")
    #expect(event["sessionId"] as? String == "00000000-0000-0000-0000-000000000222")
    #expect(event["platform"] as? String == "ios")
    #expect(event["occurredAt"] as? String == "2026-07-16T00:00:00Z")
    let properties = try #require(event["properties"] as? [String: Any])
    #expect(properties["region"] as? String == "tokyo")
    #expect(properties["itemCount"] as? Int == 3)
    #expect(properties["reason"] as? String == "initial")
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
xcodebuild test -project Spott.xcodeproj -scheme Spott -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -only-testing:SpottTests/AnalyticsClientTests
```

Expected: compilation fails because `AnalyticsClient`, `AnalyticsEventName`, and `AnalyticsPropertyValue` do not exist.

- [ ] **Step 3: Write consent, recursive sanitization, identity, and failure tests**

Add four independent tests: `consentIsDynamicAndDefaultsOff` asserts recorder counts `0`, `1`, and `1` across off/on/off calls; `sanitizerRemovesSensitiveKeysRecursively` asserts `phoneNumber`, `access_token`, and nested `messageBody` are absent while `region`, `eventId`, and nested `source` remain; `analyticsFailureDoesNotEscapeTrack` injects a transport that throws and verifies the awaited nonthrowing call returns; `analyticsSessionIsIndependentFromStableAnonymousIdentity` creates two clients with one anonymous UUID and two session UUIDs, then verifies both payloads keep the anonymous UUID while their session IDs differ.

Use an actor recorder so tests observe real request bodies without unsafe shared mutable state.

- [ ] **Step 4: Implement the minimal actor and models**

Implement these exact shapes:

```swift
enum AnalyticsEventName: String, Sendable {
    case discoveryViewed = "discovery_viewed"
    case eventDetailViewed = "event_detail_viewed"
    case registrationCompleted = "registration_completed"
    case eventSubmissionCompleted = "event_submission_completed"
}

indirect enum AnalyticsPropertyValue: Encodable, Sendable, Equatable {
    case string(String), integer(Int), double(Double), boolean(Bool)
    case object([String: AnalyticsPropertyValue]), array([AnalyticsPropertyValue]), null
}

actor AnalyticsClient {
    typealias Transport = @Sendable (URLRequest) async throws -> (Data, URLResponse)
    init(environment: APIEnvironment, defaults: UserDefaults = .standard,
         anonymousID: UUID = DeviceIdentity.current, sessionID: UUID = UUID(),
         now: @escaping @Sendable () -> Date = Date.init,
         transport: Transport? = nil)
    func track(_ name: AnalyticsEventName,
               properties: [String: AnalyticsPropertyValue] = [:]) async
}
```

`track` must check consent first, sanitize recursively, encode a one-event batch with lowercase UUID strings and ISO 8601 time, invoke the public transport, and contain every error. It must not use `CredentialVault`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the same `xcodebuild test ... -only-testing:SpottTests/AnalyticsClientTests` command. Expected: all analytics tests pass with zero failures.

### Task 2: Inject the client and connect four P0 events

**Files:**
- Modify: `Spott/App/AppModel.swift`
- Modify: `Spott/SpottApp.swift`
- Modify: `Spott/Features/EventDetail/EventDetailView.swift`
- Modify: `Spott/Features/EventComposer/EventComposerView.swift`
- Test: `SpottTests/AnalyticsClientTests.swift`

**Interfaces:**
- Consumes: `AnalyticsClient.track(_:properties:) async` from Task 1.
- Produces: `P0AnalyticsSignal` factories and `AppModel.trackAnalytics(_:)`, a synchronous fire-and-forget wrapper.

- [ ] **Step 1: Add failing tests for the four production-safe P0 signal factories**

Write tests against the wished-for factory API. The tests verify exact event names and allowlisted property keys without reading source text or asserting on a mock:

```swift
@Test func p0SignalsUseStableNamesAndPrivacySafeProperties() {
    let eventID = UUID(uuidString: "00000000-0000-0000-0000-000000000333")!
    let discovery = P0AnalyticsSignal.discoveryViewed(region: "tokyo", itemCount: 3, reason: "initial")
    let detail = P0AnalyticsSignal.eventDetailViewed(eventID: eventID, publicSlug: "city-walk", category: "outdoor")
    let registration = P0AnalyticsSignal.registrationCompleted(eventID: eventID, status: "confirmed", partySize: 2)
    let submission = P0AnalyticsSignal.eventSubmissionCompleted(eventID: eventID, status: "pending_review", category: "outdoor", posterEnabled: true)
    #expect(discovery.name == .discoveryViewed)
    #expect(detail.name == .eventDetailViewed)
    #expect(registration.name == .registrationCompleted)
    #expect(submission.name == .eventSubmissionCompleted)
    #expect(Set(discovery.properties.keys) == ["region", "itemCount", "reason"])
    #expect(Set(detail.properties.keys) == ["eventId", "publicSlug", "category"])
    #expect(Set(registration.properties.keys) == ["eventId", "status", "partySize"])
    #expect(Set(submission.properties.keys) == ["eventId", "status", "category", "posterEnabled"])
}
```

- [ ] **Step 2: Run the integration test and verify RED**

Run the focused analytics test target. Expected: compilation fails because `P0AnalyticsSignal` does not exist.

- [ ] **Step 3: Implement P0 factories and inject `AnalyticsClient` into app composition**

Implement `P0AnalyticsSignal` as a `Sendable` value with four static factory methods whose key sets exactly match the tests. Add `let analytics: AnalyticsClient` to `AppModel`, require it in the initializer, and construct it beside the API client in `SpottApp`. Use `.preview` environment in `AppModel.preview`; consent remains default-off through standard defaults.

Add the non-blocking wrapper:

```swift
func trackAnalytics(_ signal: P0AnalyticsSignal) {
    Task { await analytics.track(signal.name, properties: signal.properties) }
}
```

- [ ] **Step 4: Connect discovery events after successful responses**

After initial discovery succeeds, track `.discoveryViewed(region:itemCount:reason:)` with `reason = "initial"`. After successful refresh, pass `reason.rawValue` so explicit manual refresh is distinguishable and failed refreshes do not emit.

- [ ] **Step 5: Connect detail and success events**

- At the start of the detail task, track `.eventDetailViewed` with event ID, public slug, and first safe tag as category.
- Immediately after `api.register` succeeds, track `.registrationCompleted` with event ID, returned status, and party size, before dismissing.
- Immediately after `api.submitEvent` succeeds, track `.eventSubmissionCompleted` with event ID, returned status, selected category, and poster-enabled boolean.
- Never include title, description, exact address, attendee note, registration answers, or tokens.

- [ ] **Step 6: Run focused analytics tests and verify GREEN**

Run the focused test command. Expected: client behavior and P0 signal factory tests all pass. Use the final requirement audit plus a successful Xcode build to verify the four source call sites.

### Task 3: Full iOS verification

**Files:**
- Verify all files from Tasks 1–2.

**Interfaces:**
- Consumes the complete implementation.
- Produces fresh test and build evidence for handoff.

- [ ] **Step 1: Run all unit tests**

```bash
xcodebuild test -project Spott.xcodeproj -scheme Spott -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -only-testing:SpottTests
```

Expected: `** TEST SUCCEEDED **` and zero failed tests.

- [ ] **Step 2: Run build-for-testing**

```bash
xcodebuild build-for-testing -project Spott.xcodeproj -scheme Spott -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
```

Expected: `** TEST BUILD SUCCEEDED **`.

- [ ] **Step 3: Audit requirements against source and request evidence**

Confirm the payload includes all seven required fields; opt-in is dynamically read; anonymous and analytics session IDs are separate; sensitive-key normalization is recursive; no credential headers are present; all four event names occur only at intended nodes; and every analytics error path is contained.
