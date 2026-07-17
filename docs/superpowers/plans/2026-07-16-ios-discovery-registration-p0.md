# iOS Discovery and Registration P0 Implementation Plan

> **Execution rule:** Use `superpowers:executing-plans`, `superpowers:test-driven-development`, the iOS SwiftUI patterns skill, and `superpowers:verification-before-completion`. Complete one RED/GREEN slice at a time and obtain independent review before advancing.

**Goal:** Close four native-iOS correctness gaps without mixing in Liquid Glass visual work or fixture-based E2E: stale region bounds/map camera, unsafe Discovery errors, registration idempotency not bound to the exact wire payload, and untranslated routed-event copy.

**Architecture:** `DiscoveryStore` owns request correctness and publishes only a monotonic camera-refit revision; SwiftUI continues to own `MapCameraPosition`. Registration reuses the existing exact-payload `StableIdempotencyAttempt` against the final normalized `RegistrationRequestPayload`. Routed copy is a small locale-derived value type backed by three `CoreJourney.strings` files.

**Strict allowed files:**

- `Spott/Features/Discovery/DiscoveryStore.swift`
- `Spott/Features/Discovery/DiscoveryView.swift`
- `Spott/Features/Discovery/DiscoveryMapView.swift`
- `Spott/Features/Registration/RegistrationStore.swift`
- `Spott/App/AppRootView.swift`
- `Spott/Resources/zh-Hans.lproj/CoreJourney.strings`
- `Spott/Resources/ja.lproj/CoreJourney.strings`
- `Spott/Resources/en.lproj/CoreJourney.strings`
- `SpottTests/DiscoveryStoreTests.swift`
- `SpottTests/RegistrationStoreTests.swift`
- `SpottTests/LocalizationParityTests.swift`

Do not modify Liquid Glass/theme files, API models/client, router, Web/API/database code, UI-test fixtures, or unrelated source.

---

## Task 1: Clear stale region bounds and refit only after authoritative replacement

### Step 1: Add the failing store test

In `SpottTests/DiscoveryStoreTests.swift`, add:

```swift
func testSelectingRegionClearsStaleBoundsAndRequestsCameraRefitAfterReplacement() async throws
```

Arrange Tokyo bounds, select Osaka, and assert immediately that bounds are nil. Resolve the Osaka request with real coordinates and assert the query contains Osaka with no Tokyo bounds and that `mapCameraRevision` advances exactly once. Extend the settled-bounds test to prove ordinary user map movement does not advance the revision.

Run only the new test and confirm RED because `selectRegion` and `mapCameraRevision` do not exist.

### Step 2: Implement the minimal store transition

In `DiscoveryStore.swift`:

- add read-only `mapCameraRevision`;
- add an observation-ignored pending camera region;
- add `selectRegion(_:)` that synchronously changes region, clears bounds, records the pending region, and uses the existing debounced/generation-safe replacement flow;
- advance the revision only when the latest successful response matches the pending region;
- retain pending intent across a retryable failure and clear it during account/session reset or fixture replacement.

In `DiscoveryView.swift`, route the region control through `store.selectRegion(_:)`.

### Step 3: Wire SwiftUI camera refit without feedback loops

In `DiscoveryMapView.swift`, observe the revision, clear stale selection, and set the existing local camera position to `.fitting(store.mapEvents)`. Preserve the `positionedByUser` guard so programmatic refits do not send another bounds request.

Run the new test, then the full `DiscoveryStoreTests` suite.

---

## Task 2: Localize Discovery failures without exposing backend diagnostics

### Step 1: Add the failing localization/security test

Add:

```swift
func testDiscoveryAPIErrorUsesLocalizedSafeCopyAndNeverServerMessage() async
```

Return an `APIError` whose message contains a database/request diagnostic. Assert safe copy in zh-Hans, ja, and en; assert the stable error code and retryability survive; assert the diagnostic never appears; and assert changing locale re-localizes the existing error.

Run the test and confirm RED because the server message is currently rendered.

### Step 2: Implement safe error classification

In `DiscoveryStore.swift`:

- map API and non-offline unknown errors to the existing localized generic request-failure key;
- use the existing network copy only for genuine offline `URLError` cases;
- retain the dedicated cursor error;
- make the re-localization default regenerate safe copy instead of carrying the old rendered string.

Run the focused test and all `DiscoveryStoreTests`.

---

## Task 3: Bind registration idempotency to the exact normalized wire payload

### Step 1: Add the failing exact-payload test

In `SpottTests/RegistrationStoreTests.swift`, add:

```swift
func testRegistrationIdempotencyKeyMatchesExactEncodedPayload() async throws
```

Prove:

1. a response-loss retry with the identical final payload reuses the key;
2. party size, a valid answer, normalized note, waitlist choice, quote ID, or expected version changes rotate the key;
3. whitespace changes that normalize to the same transmitted note do not rotate it;
4. returning to the form and accepting a new quote rotates the attempt even if visible fields are otherwise unchanged.

Run the new test and confirm RED because the store currently holds a lifecycle-wide key.

### Step 2: Use the existing stable-attempt primitive

In `RegistrationStore.swift`:

- retain `StableIdempotencyAttempt?` plus the injectable seed key used by existing tests;
- build the final `RegistrationRequestPayload` first and fingerprint exactly that normalized/encoded value;
- reuse only when the exact payload matches; rotate for any transmitted change;
- clear the old attempt on conflict re-confirmation and seed the next authoritative payload consistently;
- clear attempt/seed/public key after success or abandonment.

Do not fingerprint raw UI drafts and do not create a second canonicalization implementation.

Run the new test, the existing response-loss/conflict tests, and then all `RegistrationStoreTests`.

---

## Task 4: Replace routed-event Chinese literals with explicit trilingual keys

### Step 1: Add the failing parity test

In `SpottTests/LocalizationParityTests.swift`, add:

```swift
func testRoutedEventCopyIsLocalizedInAllSupportedLocales()
```

Assert exact zh-Hans/ja/en values for event-open failure title, invalid-link message, reload, and loading.

Run the test and confirm RED because `RoutedEventCopy` does not exist.

### Step 2: Implement routed copy and resources

In `AppRootView.swift`, add an internal locale-derived `RoutedEventCopy` and make `RoutedEventView` consume it via `@Environment(\.locale)`.

Add these keys to all three `CoreJourney.strings` files:

- `journey.route.event_error_title`
- `journey.route.event_invalid`
- `journey.route.reload`
- `journey.route.event_loading`

Keep API failures on the existing safe `AppModel` mapping.

Run the focused parity test, all localization tests, and `plutil -lint` for all three resources.

---

## Task 5: Batch verification and independent review

### Step 1: Run focused suites

```bash
xcodebuild test -quiet -project Spott.xcodeproj -scheme Spott \
  -destination 'platform=iOS Simulator,id=82BDA2F9-2D63-4AD1-8365-1463209BF9BF' \
  -derivedDataPath /private/tmp/spott-ios-p0-focused \
  -only-testing:SpottTests/DiscoveryStoreTests \
  -only-testing:SpottTests/RegistrationStoreTests \
  -only-testing:SpottTests/LocalizationParityTests
```

### Step 2: Run full iOS tests and build

```bash
xcodebuild test -quiet -project Spott.xcodeproj -scheme Spott \
  -destination 'platform=iOS Simulator,id=82BDA2F9-2D63-4AD1-8365-1463209BF9BF' \
  -derivedDataPath /private/tmp/spott-ios-p0-full

xcodebuild build -quiet -project Spott.xcodeproj -scheme Spott \
  -configuration Debug \
  -destination 'platform=iOS Simulator,id=82BDA2F9-2D63-4AD1-8365-1463209BF9BF' \
  -derivedDataPath /private/tmp/spott-ios-p0-build CODE_SIGNING_ALLOWED=NO
```

If the named simulator no longer exists, select an available iOS 26 simulator and record its exact ID; do not silently skip execution.

### Step 3: Run static gates

```bash
plutil -lint Spott/Resources/zh-Hans.lproj/CoreJourney.strings \
  Spott/Resources/ja.lproj/CoreJourney.strings \
  Spott/Resources/en.lproj/CoreJourney.strings
git diff --check
```

### Step 4: Review the scoped diff

Require an independent spec/code-quality review with no open Critical or Important finding. Update `.superpowers/sdd/progress.md` with exact RED/GREEN counts and remaining evidence.

This batch does not complete Tasks 8-11. Real API-backed Gate-to-registration-to-itinerary XCUITest, the screenshot/accessibility matrix, and Liquid Glass visual/performance acceptance remain separate required work.
