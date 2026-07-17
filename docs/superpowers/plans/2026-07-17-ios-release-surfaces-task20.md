# iOS Release Surfaces Task 20 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to execute this plan task-by-task. Use `superpowers:test-driven-development` for each code task and `superpowers:verification-before-completion` before any completion claim.

**Goal:** Close Task 20 with production-grade iOS 26 AppIcon, notification-tap routing, Live Activity extension/lifecycle, and StoreKit purchase/recovery surfaces while retaining an iOS 17 minimum, strict account/privacy boundaries, and exact Simplified Chinese/Japanese/English coverage.

**Architecture:** The containing app remains native SwiftUI and owns APNs, authentication, routing, StoreKit, and ActivityKit lifecycle. Push payloads carry only an opaque notification identifier; authenticated API resolution turns it into a typed route. The Live Activity Widget Extension contains presentation-only shared value types and follows the system language, while all mutable state and tokens remain in the app/API/worker. StoreKit uses one coordinator but two deliberately isolated verification lanes: local `StoreKitTest` with a fake credit gateway, and real Apple Sandbox with the production Apple-root verifier.

**Tech stack:** Swift 6, SwiftUI, iOS 17+, iOS 26 Liquid Glass, ActivityKit, WidgetKit, UserNotifications, StoreKit 2, StoreKitTest, XCTest/XCUITest, NestJS, PostgreSQL 18/PostGIS, APNs HTTP/2, Apple App Store Server Library, OpenAPI, Xcode 26.

**Execution discipline:** Preserve the dirty aggregate worktree. Do not stage, commit, push, or rewrite unrelated changes while executing this plan; the parent aggregate gate owns source control. Each numbered task needs a fresh independent review before the next task begins.

## Baseline and reopen decision

- The three existing 1024 PNGs and SVG exports are useful source art, but they do **not** satisfy the iOS 26 AppIcon requirement. Task 1 is reopened until a real multi-layer `AppIcon.icon` is selected by the app target and legacy fallback renditions are proven.
- APNs token registration exists, but notification responses, opaque route resolution, expiry authority, and cold-start replay do not.
- An app-side `SpottActivityAttributes` sketch exists, but there is no Widget Extension target, exact wire schema, production signing/embed path, token transport, or lifecycle cleanup.
- StoreKit catalog/purchase/server idempotency exists, but the app still conflates pending/cancelled, uses random API attempt IDs, lacks a process-lifetime updates listener, and has no separated local and real Sandbox evidence.

## Apple-authoritative references

- [Creating your app icon using Icon Composer](https://developer.apple.com/documentation/xcode/creating-your-app-icon-using-icon-composer) and [Icon Composer](https://developer.apple.com/icon-composer/): one multi-layer `.icon` file, Xcode target integration, Default/Dark/Mono annotations, and flattened exports only as secondary assets.
- [Creating an app extension](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/ExtensionCreation.html) and [TN3125: Provisioning profiles](https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles): a contained `.appex` is independently signed and provisioned.
- [`UNNotificationDefaultActionIdentifier`](https://developer.apple.com/documentation/usernotifications/unnotificationdefaultactionidentifier), [`UNNotificationResponse.targetScene`](https://developer.apple.com/documentation/usernotifications/unnotificationresponse), and [handling notification actions](https://developer.apple.com/documentation/usernotifications/handling-notifications-and-notification-related-actions): accept only registered actions and account for scene delivery.
- [Displaying Live Activities](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities), [ActivityKit push updates](https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications), [APNs payload keys](https://developer.apple.com/documentation/usernotifications/generating-a-remote-notification), and [APNs request headers](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns): exact ActivityKit state, 4 KB update limit, timestamp ordering, and `liveactivity` topic/header requirements.
- [Setting up StoreKit Testing in Xcode](https://developer.apple.com/documentation/xcode/setting-up-storekit-testing-in-xcode), [`SKTestSession`](https://developer.apple.com/documentation/storekittest/sktestsession), and [testing IAP with Sandbox](https://developer.apple.com/documentation/storekit/testing-in-app-purchases-with-sandbox): local receipts are Xcode-signed and are not App Store receipts; Sandbox uses real App Store Connect product data and Apple-signed transactions.
- [`AppStore.sync()`](https://developer.apple.com/documentation/storekit/appstore/sync%28%29), [`Transaction.unfinished`](https://developer.apple.com/documentation/storekit/transaction/unfinished), and [`appAccountToken`](https://developer.apple.com/documentation/storekit/transaction/appaccounttoken): sync is user initiated, unfinished transactions remain until finish, and account tokens round-trip in Apple transaction data.
- [`SKTestSession(contentsOf:)`](https://developer.apple.com/documentation/storekittest/sktestsession/init%28contentsof%3A%29), [testing refund requests](https://developer.apple.com/documentation/storekit/testing-refund-requests), and [handling refund notifications](https://developer.apple.com/documentation/storekit/handling-refund-notifications): load local configuration from the test-bundle URL; Sandbox refund reasons can generate real `REFUND`/`REFUND_DECLINED`; server notification truth owns reversal.

## Fixed contract decisions

1. **Scene policy:** set `UIApplicationSupportsMultipleScenes` to `false` in `Spott/Info.plist` and assert the built Info.plist also contains `false`. Task 20 therefore has one navigation owner; a process latch cannot deliver into the wrong scene. Multi-window may return only with a separate per-scene router design.
2. **Notification action policy:** only `UNNotificationDefaultActionIdentifier` opens a route. Dismiss and every unknown/custom action call completion and produce no latch entry. The worker emits no `aps.category`. Adding a custom action later requires a registered category/action allow-list in app and matching worker contract tests.
3. **Push privacy policy:** APNs route metadata is exactly `schemaVersion`, `notificationId`, and optional `routeExpiresAt`. It never contains `registrationId`, resource type/ID, account/user ID, address, coordinates, attendee data, ticket/check-in data, arbitrary URL, or credentials. `GET /notifications/:id/route` performs current-user authorization before returning private route data.
4. **Clock policy:** route expiry and Live Activity eligibility use `ServerTimeAuthority` calibrated by response `serverTime`/HTTP `Date` plus monotonic uptime. Device wall time never authorizes, expires, or changes business state. When the app lacks a calibrated sample it defers expiry to the server instead of trusting `.now`.
5. **Extension language policy:** `SpottLiveActivity` follows the system preferred language through its own `zh-Hans.lproj`, `ja.lproj`, and `en.lproj` resources. It does not read the in-app `app.language`, uses no App Group, and stores no shared data. This policy is explained in the app’s language settings.
6. **Extension privilege policy:** Push Notifications capability and `aps-environment` belong only to the containing app. The Widget Extension has no Push, App Group, Keychain Sharing, Associated Domains, Sign in with Apple, App Attest, network, or background-mode entitlement.
7. **Live Activity routing policy:** every Lock Screen/Dynamic Island tap uses a locally constructed trusted URL of the exact form `spott://event/<lowercase-uuid>?source=live-activity`. There is no payload-provided URL and no external `Link`.
8. **StoreKit verification policy:** local `StoreKitTest` JWS never reaches `StoreKitService` and never causes the Apple-root verifier to accept the Xcode StoreKit certificate. Real Sandbox and Production use Apple-signed JWS and the same Apple-root verifier, differing only by the configured Apple environment.
9. **Evidence root:** all Task 20 evidence is written beneath `artifacts/task20/` using the filenames defined in Task 9. Raw APNs tokens, JWS, Apple credentials, Sandbox credentials, provisioning UUIDs, and full customer identifiers must be redacted.
10. **Live Activity duration policy:** a confirmed itinerary with `endsAt == nil`, `endsAt <= startsAt`, or `endsAt - startsAt > 8 hours` is ineligible for a Live Activity and remains available through the in-app itinerary. Neither app nor worker invents an end time. This keeps every activity inside the product's explicit maximum lifetime and gives APNs expiration/dismissal a real server-authored bound.
11. **Release provenance policy:** Task 5's first archive is a signing preflight only. The release evidence is valid only after Task 9 freezes one source-manifest hash, rebuilds a fresh archive/export from that exact hash, validates that same archive in Organizer, verifies its contents recursively, and proves the source hash did not change before or after any of those operations.

## Global security and UX constraints

- Push and Live Activity taps reveal only data authorized for the current authenticated account. A logged-out tap may retain only the opaque notification UUID; logout/account switch clears unresolved entries and server resolution remains fail-closed.
- Live Activity data is public-only: title, coarse public area, public event UUID, public start/end epochs, semantic phase, next phase epoch, and monotonic state version. Exact address/coordinates, attendee answers, phone, registration/ticket/check-in secrets, moderation state, session data, and tokens are forbidden by type and payload tests.
- Live Activity tokens are encrypted at rest, hashed for lookup, scoped by user/device/event/activity/environment, rotated atomically, never logged raw, and disabled on terminal state/logout/dismissal.
- StoreKit verifies locally and server-side before `finish()`. One Apple transaction maps to one deterministic client attempt and one backend order. Owner generation and `appAccountToken` mismatch fail closed.
- Point packs are consumables, not renewable entitlements. “Recover purchases” means user-triggered `AppStore.sync()` followed by verified unfinished/update reconciliation and authoritative server-order/wallet refresh; it does not promise replay of already-finished consumables from Apple history.
- Refund/revocation is server-authoritative through App Store Server Notifications V2. The app refreshes wallet truth and never creates a local reversal.
- iOS 26 app controls use native `.glass`, `.glassProminent`, and grouped `GlassEffectContainer` only where appropriate. iOS 17–25 use existing material/bordered fallbacks. WidgetKit presentation does not apply app-window `glassEffect` APIs.
- All new app and extension copy has exact `zh-Hans`/`ja`/`en` parity, system light/dark support, Dynamic Type through accessibility sizes, VoiceOver labels/values, Reduce Motion behavior, 44-point targets, and no color-only state.

---

### Task 1: Replace flat AppIcon assets with a real Icon Composer source and prove fallback

**Files:**

- Create: `Spott/AppIcon.icon`
- Create: `docs/design/brand/app-icon-layers/background.svg`
- Create: `docs/design/brand/app-icon-layers/orbit.svg`
- Create: `docs/design/brand/app-icon-layers/spott-s.svg`
- Preserve as design exports only: `docs/design/brand/app-icon-default.svg`, `docs/design/brand/app-icon-dark.svg`, `docs/design/brand/app-icon-tinted.svg`
- Remove from target after `.icon` passes: `Spott/Assets.xcassets/AppIcon.appiconset`
- Modify: `Spott.xcodeproj/project.pbxproj`
- Create: `scripts/verify-ios-app-icon.sh`

**Produces:** One target-selected multi-layer `AppIcon.icon`; Xcode-generated legacy renditions for every supported pre-iOS-26 runtime; deterministic icon verification and installed evidence.

- [ ] **Step 1: Write the failing source/build verifier**

`scripts/verify-ios-app-icon.sh` must fail unless all of these are true:

```text
Spott/AppIcon.icon exists and is included in the Spott target
the .icon contains at least background, orbit, and spott-s image layers
ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon in Debug and Release
no AppIcon.appiconset remains selected by the target
the built Assets.car contains an icon stack plus legacy raster renditions
the built product emits no missing/unassigned/alpha AppIcon warning
```

Run it before creating `AppIcon.icon`. Expected: non-zero with `missing multi-layer Spott/AppIcon.icon`.

- [ ] **Step 2: Build the layered source in Icon Composer**

Import the three SVGs as separate layers, not one flattened image. Use an edge-to-edge opaque background; keep the orbit and `S` within Apple’s preview grid without baking rounded corners. Configure iOS/iPadOS, Default, Dark, and Mono annotations; tune refraction/specular/shadow per layer. Preview small sizes and the iOS 26 Default, Dark, Tinted, Clear Light, and Clear Dark rendering modes. Save the editable result as `Spott/AppIcon.icon`. The existing PNGs may be exported to `artifacts/task20/app-icon/exports/` for comparison but are not app-icon source.

- [ ] **Step 3: Select the Icon Composer source in the app target**

Add `AppIcon.icon` to the Spott target, keep `ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon`, and remove the ambiguous `AppIcon.appiconset` only after an app build succeeds. Do not add undocumented `actool` flags. Xcode 26 must generate the pre-iOS-26 flattened renditions from the `.icon` source.

- [ ] **Step 4: Prove compiled fallback, not just source presence**

Run:

```bash
xcodebuild -project Spott.xcodeproj -scheme Spott \
  -configuration Release -sdk iphonesimulator \
  -derivedDataPath /private/tmp/spott-task20-icon-derived build CODE_SIGNING_ALLOWED=NO
xcrun assetutil --info \
  /private/tmp/spott-task20-icon-derived/Build/Products/Release-iphonesimulator/Spott.app/Assets.car \
  > artifacts/task20/app-icon/assetutil.json
bash scripts/verify-ios-app-icon.sh \
  /private/tmp/spott-task20-icon-derived/Build/Products/Release-iphonesimulator/Spott.app
```

Expected: build PASS, verifier PASS, `assetutil.json` proves layered/icon-stack renditions and raster fallbacks. A source-file screenshot alone is not acceptance.

- [ ] **Step 5: Run the installed-device matrix and independent brand review**

Install on iPhone and iPad iOS 26 simulators and on installed iOS 17.x and iOS 18.x runtimes. The `assetutil` assertion must prove that the one compiler-generated legacy raster family covers the app's entire supported pre-26 range (iOS 17–25); installed iOS 17 and iOS 18 checks prove both the minimum and a second old-system consumer. If either runtime is unavailable locally, install it before acceptance. Capture the exact Task 9 icon files. Reviewer rejects clipped grid geometry, pre-rounded edges, transparent output, unreadable 29-point rendering, inconsistent layer geometry, or a missing old-system icon.

---

### Task 2: Ship opaque push-response routing with server-authoritative expiry and authorization

**Client files:**

- Create: `Spott/Integrations/PushRoute.swift`
- Create: `Spott/Integrations/PushResponseBroker.swift`
- Modify: `Spott/Integrations/SystemIntegrations.swift`
- Modify: `Spott/SpottApp.swift`
- Modify: `Spott/App/AppModel.swift`
- Modify: `Spott/App/AppRouter.swift`
- Modify: `Spott/Core/API/ServerTimeAuthority.swift`
- Modify: `Spott/Core/API/SpottAPIClient.swift`
- Modify: `Spott/Core/API/APIModels.swift`
- Modify: `Spott/Info.plist`
- Create: `SpottTests/PushRouteTests.swift`
- Extend: `SpottTests/ServerTimeAuthorityTests.swift`
- Extend: `SpottTests/AppRouterTests.swift`
- Extend: `SpottUITests/SpottUITests.swift`

**API/worker files:**

- Modify: `services/api/src/modules/notifications/notifications.controller.ts`
- Modify: `services/api/src/modules/notifications/notifications.service.ts`
- Create: `services/api/src/modules/notifications/notifications.route.spec.ts`
- Create: `services/api/src/modules/notifications/notifications.route.integration.spec.ts`
- Modify: `services/worker/src/jobs.ts`
- Modify: `services/worker/src/delivery.ts`
- Extend worker delivery tests
- Modify: `packages/contracts/openapi.yaml`
- Regenerate/bundle contract artifacts if the repository generator changes them

**Interfaces:**

```swift
struct PushEnvelopeV1: Equatable, Sendable {
    let notificationID: UUID
    let routeExpiresAt: Date?
}

enum NotificationRoute: Equatable, Sendable {
    case event(publicID: UUID)
    case group(publicID: UUID)
    case profile(handle: String)
    case share(code: String)
    case notifications
    case itinerary(registrationID: UUID?)
}

struct AuthoritativeTimeSample: Sendable {
    let now: Date
    let isCalibrated: Bool
    let calibratedAtMonotonicUptime: TimeInterval?
    let age: TimeInterval?

    func isFresh(maxAge: TimeInterval = 300) -> Bool
}
```

APNs custom data is exactly:

```json
{
  "spott": {
    "schemaVersion": 1,
    "notificationId": "019b0000-0000-7000-9000-000000000001",
    "routeExpiresAt": "2026-07-17T10:00:00Z"
  }
}
```

- [ ] **Step 1: Write RED decoder, action, clock, and lifecycle tests**

Cover strict UUID/RFC3339 decoding; absent optional expiry; rejection of extra nested route objects, resource/registration fields, URL, encoded separator, credentials, port, oversized/non-string values, and unknown schema. Prove only the default notification action enqueues; dismiss/unknown actions do not. Prove foreground, background, and cold-start default-action responses each deliver once; duplicates drain once; capacity is bounded at 32 oldest-first; a cold response before `AppModel.bootstrap()` replays once; logout/account switch clears pending entries; Google OAuth URLs never enter the broker; and built `UIApplicationSupportsMultipleScenes` is false.

Use an injected calibrated time sample and device wall clocks ±24 hours. A fresh calibrated sample after `routeExpiresAt` drops locally; an uncalibrated or older-than-300-second sample calls the server resolver, which remains authoritative. Prove a process restart begins uncalibrated, a foreground resume after more than 300 seconds asleep refreshes before a local fast reject, `UIApplication.significantTimeChangeNotification` invalidates the sample, and an HTTP `Date` older than the last accepted calibration cannot move time backward. Expected RED: types/handler/endpoint are absent.

- [ ] **Step 2: Make the worker payload opaque and category-free**

Select only the notification row fields required to render a lock-screen-safe alert and the opaque route envelope. Alert title/body is limited to the public/coarse notification template; private answers, exact location, ticket/check-in, phone, and moderation content is replaced by generic “Open Spott to view” copy and resolved in-app. The worker must not serialize `resource_type`, `resource_public_id`, `registrationId`, `payload_ref`, or an arbitrary URL into APNs custom data and must omit `aps.category`. `routeExpiresAt` may be copied only from a valid primitive RFC3339 value in controlled notification metadata. Payload tests scan both serialized keys and representative secret values.

Serialize the **entire** normal-push JSON first and enforce `Buffer.byteLength(JSON.stringify(payload), "utf8") <= 4096`, including `aps`, `spott`, punctuation, and escaped content. Add CJK/emoji boundary fixtures whose complete bodies are exactly 4096 bytes (accepted) and 4097 bytes (rejected or replaced by the generic compact alert before send); JavaScript `.length` and per-field character limits are not acceptance.

- [ ] **Step 3: Add the authenticated route resolver**

Implement `GET /notifications/:id/route`. Query with `WHERE notification.id = $1 AND notification.user_id = $2`, parse expiry only from the stored notification metadata, validate it against PostgreSQL `clock_timestamp()`, map only the six `NotificationRoute` cases, and re-check current-user access to the referenced registration/private resource before returning it. Unknown type, expired route, missing resource, malformed stored ID, cross-account UUID, cancelled invitation, or inaccessible event all return the same 404 shape. The response contains no internal database IDs except the current user’s authorized `registrationId`.

- [ ] **Step 4: Add the single-scene response broker and strict router handoff**

Set `UIApplicationSupportsMultipleScenes=false`. `SpottAppDelegate.userNotificationCenter(_:didReceive:withCompletionHandler:)` accepts only `UNNotificationDefaultActionIdentifier`, decodes the opaque envelope, and publishes it to the process actor before calling completion. `SpottApp` drains only after runtime/persistence readiness. `AppModel` resolves through the authenticated endpoint, applies login/phone gates, verifies the owner generation before publication, and hands the typed result to `AppRouter`; it never converts payload data directly to a URL. Logout and account switch cancel in-flight resolution and clear the latch.

- [ ] **Step 5: Use calibrated monotonic time**

Add `ServerTimeAuthority.sample()` so the clock reports calibration uptime and age. A security-sensitive sample is fresh for at most 300 seconds. Calibrated time advances from monotonic uptime and ignores device wall-clock changes; process bootstrap starts with no sample, background/sleep resume checks monotonic age, and significant-time-change invalidates calibration. Client expiry is only a fresh-sample fast reject; every accepted tap still resolves at the API. If calibration is absent, stale, or an older response calibration was rejected as backward drift, obtain fresh server time or send the opaque ID to the API rather than accepting or expiring it using `.now`.

- [ ] **Step 6: Run focused, full, and security gates**

```bash
pnpm --filter @spott/worker test
pnpm --filter @spott/worker lint
pnpm --filter @spott/worker typecheck
pnpm --filter @spott/worker build
pnpm --filter @spott/api test
pnpm --filter @spott/api test:integration
pnpm --filter @spott/api lint
pnpm --filter @spott/api typecheck
pnpm --filter @spott/api build
pnpm contract:lint
pnpm contract:bundle
xcodebuild -project Spott.xcodeproj -scheme Spott \
  -destination 'platform=iOS Simulator,name=Spott-CI' \
  -only-testing:SpottTests/PushRouteTests \
  -only-testing:SpottTests/AppRouterTests \
  -only-testing:SpottTests/ServerTimeAuthorityTests test
```

Then run a cold-launch XCUITest from a real notification response, not a direct deep-link shortcut. Independent review traces every accepted envelope through current-user API authorization to a typed route.

---

### Task 3: Define the exact Live Activity wire contract and add the real Widget Extension target

**Files:**

- Create: `Spott/Integrations/SpottActivityAttributes.swift` with membership in both app and extension targets
- Remove the duplicate attributes/helper from: `Spott/Integrations/SystemIntegrations.swift`
- Create: `SpottLiveActivity/SpottLiveActivityBundle.swift`
- Create: `SpottLiveActivity/SpottLiveActivityWidget.swift`
- Create: `SpottLiveActivity/Info.plist`
- Create: `SpottLiveActivity/zh-Hans.lproj/Localizable.strings`
- Create: `SpottLiveActivity/ja.lproj/Localizable.strings`
- Create: `SpottLiveActivity/en.lproj/Localizable.strings`
- Modify: `Spott/Features/Profile/ProfileViews.swift` to explain the system-language extension policy
- Modify: `Spott.xcodeproj/project.pbxproj`
- Create: `SpottTests/SpottActivityContractTests.swift`
- Create: `SpottTests/LiveActivityRouteTests.swift`

**Exact value contract:**

```swift
struct SpottActivityAttributes: ActivityAttributes, Codable, Hashable {
    struct ContentState: Codable, Hashable {
        enum Phase: String, Codable, CaseIterable {
            case upcoming
            case checkInOpen
            case inProgress
            case ended
            case cancelled
        }

        let schemaVersion: UInt8       // exactly 1
        let phase: Phase
        let phaseEndsAtEpochSeconds: Int64?
        let stateVersion: Int64        // 1...9_007_199_254_740_991, strictly increasing
    }

    let eventPublicID: UUID
    let title: String                  // <= 160 UTF-8 bytes
    let publicArea: String             // <= 80 UTF-8 bytes
    let startsAtEpochSeconds: Int64
    let endsAtEpochSeconds: Int64?
}
```

Use explicit `CodingKeys` with `eventPublicId` and the other spellings shown below. Golden JSON, encoded with sorted keys, is:

```json
{"attributes":{"endsAtEpochSeconds":1784284200,"eventPublicId":"019b0000-0000-7000-8200-000000000001","publicArea":"Shibuya","startsAtEpochSeconds":1784277000,"title":"Spott Tokyo Night"},"content-state":{"phase":"checkInOpen","phaseEndsAtEpochSeconds":1784280600,"schemaVersion":1,"stateVersion":42}}
```

The canonical terminal/nil encoding omits optional keys rather than emitting JSON `null` (this is a wire-codec test vector; Task 4 still rejects starting a Live Activity whose event `endsAt` is nil):

```json
{"attributes":{"eventPublicId":"019b0000-0000-7000-8200-000000000001","publicArea":"Shibuya","startsAtEpochSeconds":1784277000,"title":"Spott Tokyo Night"},"content-state":{"phase":"ended","schemaVersion":1,"stateVersion":43}}
```

- [ ] **Step 1: Write RED contract/privacy/golden tests**

Assert exact raw values and coding keys, both deterministic golden JSON bodies, `stateVersion` in `1...9_007_199_254_740_991` (JavaScript `Number.MAX_SAFE_INTEGER`), epoch range, UTF-8 byte limits, and complete encoded APNs body under 4096 bytes. Canonical encoders must omit nil `endsAtEpochSeconds`/`phaseEndsAtEpochSeconds`; server golden tests reject an explicit `null` or any version outside the safe integer range rather than relying on JavaScript rounding. Source/payload scans must prove forbidden address, coordinate, attendee, registration, ticket, check-in, phone, moderation, session, and token fields cannot be encoded. Expected RED: shared source and extension target are absent.

- [ ] **Step 2: Create the Widget Extension as a production-shaped target**

Add `SpottLiveActivity` as product type `com.apple.product-type.app-extension`, product `SpottLiveActivity.appex`, bundle ID `com.yaokai.Spott.LiveActivity`, deployment target `17.0`, `TARGETED_DEVICE_FAMILY="1,2"`, `APPLICATION_EXTENSION_API_ONLY=YES`, `SKIP_INSTALL=YES`, `GENERATE_INFOPLIST_FILE=NO`, and app-matching `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION`. The containing app must retain `NSSupportsLiveActivities=true`. The extension Info.plist must contain the normal build-setting-backed bundle keys plus the WidgetKit extension declaration:

```xml
<key>CFBundleDisplayName</key><string>Spott</string>
<key>CFBundleDevelopmentRegion</key><string>$(DEVELOPMENT_LANGUAGE)</string>
<key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>
<key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
<key>CFBundleName</key><string>$(PRODUCT_NAME)</string>
<key>CFBundlePackageType</key><string>XPC!</string>
<key>CFBundleShortVersionString</key><string>$(MARKETING_VERSION)</string>
<key>CFBundleVersion</key><string>$(CURRENT_PROJECT_VERSION)</string>
<key>NSExtension</key>
<dict>
  <key>NSExtensionPointIdentifier</key>
  <string>com.apple.widgetkit-extension</string>
</dict>
```

Add an app target dependency and an `Embed App Extensions` Copy Files phase to `PlugIns` with `CodeSignOnCopy` and `RemoveHeadersOnCopy`. Do not create an extension entitlements file. Set `DEVELOPMENT_LANGUAGE=en`; include the extension's three `.lproj` resources in its Resources build phase; and add a built-product test that `CFBundleDevelopmentRegion == "en"` and `Bundle(path: appexPath)?.localizations` contains `zh-Hans`, `ja`, and `en` (allowing Xcode's `Base` entry but no language substitution for those three).

- [ ] **Step 3: Build all ActivityKit presentations**

Use `ActivityConfiguration` for Lock Screen/Home banner and `DynamicIsland` compact-leading, compact-trailing, minimal, and expanded regions. Render phase labels from extension resources and system locale; `context.isStale` must add a localized stale/out-of-date label without changing business phase. The extension may format the server-provided next-boundary epoch as an absolute local time, but it never derives or authorizes a phase from device `.now`; server/app coordinator content state remains authoritative. Keep height under Apple’s 160-point guidance, use semantic system colors/materials, and add explicit VoiceOver labels/values. Construct `.widgetURL` locally as exactly `spott://event/<lowercase-uuid>?source=live-activity` for both Lock Screen and Dynamic Island; do not add external `Link` or arbitrary URL input. The app language settings explain that Live Activities follow the device language, and tests prove the extension has no App Group/read path for `app.language`.

- [ ] **Step 4: Add trusted deep-link and downgrade tests**

Pin `TrustedLiveActivityURL.parse(raw:)` and `AppRouter` to the complete URL grammar. Validate the raw ASCII form before `URLComponents` so Foundation normalization cannot hide a case variant: scheme exactly lower-case `spott`; host exactly lower-case `event`; one and only one path component containing the canonical lower-case UUID string; exactly one query item named `source` whose value is exactly lower-case `live-activity`; no duplicate/extra/empty query, fragment, user, password, port, percent-encoded slash/backslash, host/scheme case variant, noncanonical UUID, or payload-supplied URL. Test the one valid URL plus each individual failure and prove every accepted value maps only to `.event(publicID:)`. On iOS 26 the app-side start/stop controls use native glass styles after layout modifiers; on iOS 17–25 they use `spottProminentActionStyle()` fallback. Devices without Dynamic Island receive the Lock Screen/banner presentation and the in-app itinerary remains the primary surface.

- [ ] **Step 5: Run target-structure and build gates**

```bash
xcodebuild -project Spott.xcodeproj -scheme Spott \
  -configuration Debug -destination 'platform=iOS Simulator,name=Spott-CI' build CODE_SIGNING_ALLOWED=NO
xcodebuild -project Spott.xcodeproj -scheme Spott \
  -configuration Release -destination 'generic/platform=iOS Simulator' build CODE_SIGNING_ALLOWED=NO
```

Inspect the built app for `PlugIns/SpottLiveActivity.appex`, exact bundle/product type, version parity, extension point, and absence of `UIBackgroundModes`. Run contract/route tests and three-language preview compilation.

---

### Task 4: Implement Live Activity lifecycle, token transport, and APNs protocol

**App files:**

- Create: `Spott/Integrations/LiveActivityCoordinator.swift`
- Create: `Spott/Integrations/LiveActivityClient.swift`
- Modify: `Spott/App/AppModel.swift`
- Modify itinerary store/view files that expose start/stop/fallback
- Modify: `Spott/Core/API/SpottAPIClient.swift`
- Modify: `Spott/Core/API/APIModels.swift`
- Create: `SpottTests/LiveActivityCoordinatorTests.swift`

**API/worker files:**

- Create: `database/migrations/0023_live_activity_tokens.sql`
- Create: `services/api/src/modules/notifications/live-activities.controller.ts`
- Create: `services/api/src/modules/notifications/live-activities.service.ts`
- Create: `services/api/src/modules/notifications/live-activities.service.spec.ts`
- Create: `services/api/src/modules/notifications/live-activities.integration.spec.ts`
- Modify: `services/api/src/modules/notifications/notifications.module.ts`
- Modify: `services/api/src/modules/auth/auth.service.ts`
- Extend: `services/api/src/modules/auth/auth.service.spec.ts`
- Modify: `packages/contracts/openapi.yaml`
- Create: `services/worker/src/live-activities.ts`
- Create: `services/worker/src/live-activities.spec.ts`
- Modify: `services/worker/src/delivery.ts`
- Modify: `services/worker/src/jobs.ts`
- Create: `scripts/verify-live-activity-apns-evidence.sh`

**Lifecycle rules:**

- User may start only a current-account `confirmed` itinerary during `[startsAt - 60 minutes, endsAt]`, measured by a server sample fresh within 300 seconds, and only after an explicit tap. A missing/stale sample must be refreshed before authorization; process restart, foreground after sleep/background, or significant-time-change invalidates the preflight sample.
- `endsAt` is mandatory for Live Activity eligibility. Reject rather than synthesize when it is nil, is not later than `startsAt`, or makes the event longer than 8 hours. The in-app itinerary remains available with localized explanation.
- One active activity exists per event/user/device. `Activity<SpottActivityAttributes>.activities` is the recovery source after relaunch; no parallel UserDefaults/SwiftData activity registry is created. The server's partial unique index is the concurrency backstop.
- `ActivityContent.staleDate` equals the next server-authored phase boundary. Relevance scores are `upcoming=50`, `checkInOpen=100`, `inProgress=80`, terminal `0`.
- Normal end sends final `.ended` content and `.after(authoritativeNow + 30 minutes)`. Cancellation/removal/logout sends final `.cancelled` content and `.immediate` because continuing to show it could mislead or leak cross-account context.
- Ending/dismissing a Live Activity disables its server token and removes only the local activity mapping. It never cancels the event registration.

- [ ] **Step 1: Write RED coordinator tests with an injected authoritative clock**

Cover inclusive start-window boundaries; nil/inverted/over-8-hour `endsAt` rejection; uncalibrated, older-than-300-second, restart, and post-sleep clock refresh; one-per-event dedupe; idempotent update; JavaScript-safe `stateVersion` monotonicity; explicit user start; end policies; cancellation/removal/logout; relaunch recovery from `Activity.activities`; missing token; token rotation; request failure; activity disabled; and owner switch during update. Model relaunch before login, login as owner A, then A→B: an activity is quarantined until the server resolves its `activityID` for the current account, adopted only by A, ended and disabled before B credentials become active, and never rebound to B. Observe `activityEnablementUpdates`, `activityStateUpdates`, and `pushTokenUpdates` through injectable adapters. Expected RED: coordinator and transport do not exist.

- [ ] **Step 2: Add encrypted scoped token storage and authenticated endpoints**

Migration `0023_live_activity_tokens.sql` creates both durable tables. Migration `0022_media_upload_attempts.sql` is reserved by parent Task 22 and must already replay successfully before this migration is added:

```text
notification.live_activity_tokens
  id, user_id, device_id, event_id, activity_id, environment,
  token_cipher, token_hash UNIQUE, state,
  last_claimed_state_version, last_accepted_state_version,
  last_apns_timestamp, last_seen_at, disabled_at, disable_reason

notification.live_activity_deliveries
  id UUID, activity_token_id, state_version BIGINT,
  event CHECK (event IN ('update','end')),
  apns_id UUID UNIQUE, apns_timestamp BIGINT CHECK (apns_timestamp > 0),
  body_bytes BYTEA, body_sha256 BYTEA,
  headers_json JSONB, headers_sha256 BYTEA,
  state CHECK (state IN
    ('queued','sending','retry','accepted','superseded','permanent_failure')),
  attempts, available_at, lease_owner, lease_expires_at,
  last_status, last_error_code, accepted_at, superseded_at,
  created_at, updated_at,
  UNIQUE (activity_token_id, state_version),
  CHECK (state_version BETWEEN 1 AND 9007199254740991)
```

Create the PostgreSQL concurrency backstop as a real partial index rather than an invalid partial table constraint:

```sql
CREATE UNIQUE INDEX live_activity_tokens_one_active_per_event_idx
ON notification.live_activity_tokens (user_id, device_id, event_id)
WHERE state = 'active';
```

`headers_json` is the canonical non-secret APNs delivery-header map (`apns-id`, `apns-topic`, `apns-push-type`, `apns-priority`, `apns-expiration`, and content type), and `headers_sha256` hashes its sorted canonical byte representation. An immutability trigger rejects changes after insert to token ID, state version, event, APNs ID/timestamp, body bytes/hash, or canonical headers/hash; state/lease/attempt/result fields are the only mutable delivery fields. The APNs bearer JWT is deliberately not stored in this table: it is a rotating transport credential supplied from the external secret provider at send time and is excluded from delivery identity.

Store raw activity tokens only via existing `FieldCrypto`; logs/telemetry contain a short hash prefix at most. Add authenticated rotate/register, owner-resolution, and disable endpoints. Registration verifies a fresh server clock, current-user confirmed itinerary eligibility, bounded nonnil `endsAt`, and event public UUID; atomically disables the prior token for the same activity; and is idempotent for the same token hash/attempt. Disable is owner-scoped and idempotent. Online logout/session revocation disables every active token for that user/device in the same server transaction. Cross-account event/activity/token access returns the same not-found response.

- [ ] **Step 3: Implement the app coordinator and fallbacks**

The actor starts with `pushType: .token`, observes token and state streams, and calls API rotation/disable without logging bytes. On `.stale`, refresh authoritative itinerary and update/end. On `.ended` or `.dismissed`, disable server delivery and forget the local activity only. At relaunch, activity attributes supply only the public event/activity identity; before login the activity is quarantined and no token is registered. After login the app resolves `activityID` through the owner-scoped endpoint; mismatch/not-found ends it. Account switch A→B ends A's local activities and durably disables A's tokens before activating B's coordinator generation; B must never adopt, rotate, or publish A's activity.

Logout ends local activities before credentials are cleared and attempts server disable; an offline local end invalidates the ActivityKit token, and the worker must convert the resulting APNs 410 into durable server disablement. On authorization disablement, missing token, ActivityKit capacity error, request failure, iOS 17 fallback, unsupported Dynamic Island, or invalid/missing duration, show localized itinerary copy/action and keep registration intact.

- [ ] **Step 4: Implement exact APNs update/end transport**

For local-started activities, every APNs body has only:

```json
{
  "aps": {
    "timestamp": 1784278800,
    "event": "update",
    "content-state": {
      "schemaVersion": 1,
      "phase": "checkInOpen",
      "phaseEndsAtEpochSeconds": 1784280600,
      "stateVersion": 42
    },
    "stale-date": 1784280600
  }
}
```

An end body still includes final `content-state`, uses `event: "end"`, and includes `dismissal-date`; cancellation uses the current server epoch for immediate dismissal, normal end uses server epoch plus 1800 seconds. Headers are:

```text
apns-topic: com.yaokai.Spott.push-type.liveactivity
apns-push-type: liveactivity
apns-priority: 10 for check-in-open/cancel/end, 5 for ordinary upcoming/in-progress refresh
apns-expiration: next stale epoch for updates, authoritative server epoch + 3600 for cancellation, dismissal epoch for normal end
```

Claiming a state is a durable outbox transaction, never an in-memory job reservation:

1. Lock the active token row and read PostgreSQL `clock_timestamp()`; reject disabled/terminal tokens and `stateVersion <= last_claimed_state_version`.
2. Assign `apns_timestamp = max(floor(serverEpoch), last_apns_timestamp + 1)` and one `apns_id` exactly once. Canonically serialize the body bytes and delivery headers, require the complete UTF-8 body to be at most 4096 bytes, and compute `body_sha256`.
3. Insert the immutable delivery row, update the token's claimed version/timestamp, and mark every lower queued/retry delivery `superseded` in the same transaction. Mark a lower `sending` row superseded too while retaining its lease/audit fields: its already-issued network call cannot be recalled, but its result transition is guarded and cannot revive the row. A terminal end/cancellation supersedes all lower nonterminal work, marks the token terminal, and causes every future update claim to fail closed. Commit before any HTTP call.

Workers claim `queued`/`retry` rows or reclaim `sending` rows whose lease expired with `FOR UPDATE SKIP LOCKED`. Before send they verify `body_sha256`, reload the current token state, and send the stored body bytes plus the stored canonical headers, including the same `apns-id`, timestamp, topic, priority, and expiration. Only the short lease/transition transactions hold locks; HTTP never runs inside a database transaction. A fresh external bearer JWT may be attached, but no delivery field is regenerated.

Crash and ambiguity behavior is part of the contract: crash after outbox insert and before lease/send leaves a sendable row; crash after lease is recovered after lease expiry; timeout/connection reset or crash after APNs accepts but before the database marks 200 retries the exact stored body and canonical headers with the same APNs ID/timestamp. ActivityKit's increasing timestamp/state version makes the replay harmless. When 42 and 43 race, unleased 42 is superseded; an already in-flight 42 may complete but cannot overwrite 43, and its ambiguous retry is suppressed once 43 exists. Accepting 43 permanently prevents any later 42 send. A result update uses a guarded state transition and can never move a superseded row back to accepted/retry.

APNs 200 marks that delivery accepted and advances `last_accepted_state_version` monotonically. HTTP 410 `Unregistered` transactionally marks the delivery permanent and the token durably disabled; bad/expired device-token responses do the same according to status/reason. HTTP 429/5xx schedules bounded jittered retry on the same immutable row; other 4xx becomes permanent failure and emits redacted operations telemetry. Never log body, token, bearer JWT, or full APNs ID.

- [ ] **Step 5: Verify malicious/old updates and lifecycle cleanup**

Tests send state versions `42`, `41`, duplicate `42`, and `43` concurrently and cover both “42 queued” and “42 already in flight” schedules. Prove the partial unique index resolves two concurrent starts, lower work is superseded, accepted 43 prevents a 42 retry, and terminal work prevents later updates. Add crash-point tests after durable insert, after lease, after HTTP timeout, and after mocked APNs 200/before result commit; lease expiry must recover the job and every replay must have byte-identical body/hash/canonical headers/APNs ID/timestamp. Test 410 durable disable, 429/5xx retry, invalid raw phase, unsafe integer version, nil/overlong event duration, oversized UTF-8 title/area, future/negative epoch, forbidden keys, cross-environment token, and invalid topic. Exercise `.active`, `.stale`, `.ended`, `.dismissed`, enablement changes, no token, offline relaunch, cancellation, logout, and relaunch owner A→B; verify none modifies registration state.

- [ ] **Step 6: Prove the worker-to-Sandbox-APNs path on a physical device**

Use a development-signed build on a physical iPhone, a real ActivityKit push token, the development APNs endpoint, and the production worker code path. APNs provider Team ID, Key ID, and `.p8` stay in an external secret store; the runbook identifies secret names/access owners only, and the worker creates provider JWTs with current `iat`, rotates them before Apple's one-hour limit, and never writes them to evidence.

Start a real activity and have the worker deliver an update, a normal end, and a cancellation-as-`event: end` (use a second activity after the first terminal state). Require APNs HTTP 200 and capture only redacted status/response headers, delivery-row suffix, APNs-ID suffix, and request body/header hashes. Force an ambiguous retry of one accepted delivery and prove it sends the identical stored body hash, canonical header hash, APNs ID, timestamp, and state version; on device, state remains stable and does not regress. Then locally end/invalidate a token (or use an Apple-invalidated token), send its existing durable row until APNs returns a real HTTP 410, and prove the worker transaction durably disables the token and suppresses later claims.

Save `artifacts/task20/live-activity/apns/device-update.txt`, `device-end.txt`, `device-cancel.txt`, `identical-retry.txt`, and `410-durable-disable.txt`. A mocked APNs server, simulator, locally fabricated 410, or app-direct `Activity.update` does not satisfy this gate. If a physical device, APNs provider key, reachable worker, 200, or real 410 is unavailable, record the exact missing external object and leave Task 4 and Task 20 externally blocked.

- [ ] **Step 7: Run migration, API, worker, iOS, and privacy gates**

Run migration replay twice, API/worker full test/lint/typecheck/build, OpenAPI lint/bundle, focused signed coordinator tests, and app+extension builds. Save payload fixtures, crash/concurrency results, and a forbidden-key scan in `artifacts/task20/live-activity/protocol/` with token values redacted. Run `scripts/verify-live-activity-apns-evidence.sh`; it fails unless every physical-device artifact above contains the expected 200/retry/410 assertions and the evidence manifest links them to the same source hash.

---

### Task 5: Close Widget Extension capabilities, signing, provisioning, archive, and export

**Files:**

- Modify: `Spott/Spott.entitlements`
- Modify: `Spott.xcodeproj/project.pbxproj`
- Create: `config/ios/ExportOptions-AppStore.plist`
- Create: `scripts/verify-ios-archive.sh`
- Create: `docs/runbooks/ios-task20-release-surfaces.md`

**Production identities:**

```text
Team: P22K8NF89K
Containing app bundle ID: com.yaokai.Spott
Widget Extension bundle ID: com.yaokai.Spott.LiveActivity
Containing app App ID: explicit, Push Notifications enabled
Extension App ID: explicit, no Push/App Group/Associated Domains/Sign in with Apple/App Attest
APNs Live Activity topic: com.yaokai.Spott.push-type.liveactivity
```

- [ ] **Step 1: Write the failing archive verifier**

`scripts/verify-ios-archive.sh <xcarchive> <exported-app>` must check app/appex existence, nested signature validity, unique bundle IDs, product type `XPC!`, extension point, version/build equality, target dependency/embed phase, `CodeSignOnCopy`, deployment target 17, `APPLICATION_EXTENSION_API_ONLY=YES`, `SKIP_INSTALL=YES`, and profile application identifiers. It also proves both built bundles resolve `CFBundleDevelopmentRegion=en`, that each bundle's `Bundle.localizations` contains `zh-Hans`/`ja`/`en`, that the extension resources resolve a probe key independently, and that no app localization silently substitutes for the extension. It must fail if the extension has `aps-environment` or any forbidden entitlement, or if the final distribution app does not have `aps-environment=production`.

- [ ] **Step 2: Configure least privilege and Developer-account objects**

In Certificates, Identifiers & Profiles, register/confirm both explicit App IDs. Enable Push Notifications only on `com.yaokai.Spott`. Regenerate Development and App Store distribution profiles for both targets after capability changes. Keep the extension without `CODE_SIGN_ENTITLEMENTS`; system signing identifiers are permitted, feature entitlements are not. Record profile names and expiration dates in the runbook, never profile UUIDs or credentials in git.

- [ ] **Step 3: Prove development signing on a physical device**

Build/install app+appex on an iOS 17+ physical device with automatic or explicitly mapped development profiles. Inspect the installed/archive entitlements: app `aps-environment=development`; extension has no `aps-environment`. Start a Live Activity and obtain a token without printing it. A simulator-only build does not satisfy this gate.

- [ ] **Step 4: Rehearse archive and export with distribution signing**

```bash
xcodebuild archive -project Spott.xcodeproj -scheme Spott \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath /private/tmp/Spott-Task20.xcarchive \
  -allowProvisioningUpdates
xcodebuild -exportArchive \
  -archivePath /private/tmp/Spott-Task20.xcarchive \
  -exportPath /private/tmp/Spott-Task20-export \
  -exportOptionsPlist config/ios/ExportOptions-AppStore.plist \
  -allowProvisioningUpdates
```

`ExportOptions-AppStore.plist` uses these exact values; profile mapping remains Xcode-managed:

```xml
<key>method</key><string>app-store-connect</string>
<key>destination</key><string>export</string>
<key>signingStyle</key><string>automatic</string>
<key>teamID</key><string>P22K8NF89K</string>
<key>uploadSymbols</key><false/>
<key>manageAppVersionAndBuildNumber</key><false/>
```

This archive proves signing configuration but is not final release evidence because commerce/APNs work can still change afterward. Task 9 must delete/rebuild a fresh archive from the final frozen source-manifest hash and use that exact new archive for export, recursive verification, and Organizer validation.

- [ ] **Step 5: Inspect both signatures and embedded profiles**

Run `codesign --verify --deep --strict --verbose=2` on the archived and exported app, and `codesign -d --entitlements :-` separately on app and appex. Decode each `embedded.mobileprovision` with `security cms -D -i`; prove application identifiers end in the exact bundle IDs, distribution app `aps-environment` is `production`, extension lacks it, and profile/team/certificate classes agree. Unzip the IPA and rerun the verifier on the exported product.

- [ ] **Step 6: Validate external release state**

Use Xcode Organizer “Validate App” against App Store Connect as a signing rehearsal and retain the validation report under `artifacts/task20/signing/preflight/`. If Apple account access, certificate, profile, or App ID creation is unavailable, mark Task 5 externally blocked with the exact missing object; never claim Task 20 complete from unsigned simulator output. Task 9 repeats validation against its frozen-source archive, and only that later report counts for completion.

---

### Task 6: Implement one StoreKit coordinator with deterministic attempts and owner-safe UX

**Files:**

- Create: `Spott/Integrations/StorePurchaseCoordinator.swift`
- Create: `Spott/Integrations/AppleStoreKitAdapter.swift`
- Create: `Spott/Integrations/PurchaseAttemptID.swift`
- Refactor: `Spott/Integrations/SystemIntegrations.swift`
- Modify: `Spott/App/AppModel.swift`
- Modify: `Spott/Features/Profile/ProfileViews.swift`
- Modify: `Spott/Core/API/SpottAPIClient.swift`
- Modify: `Spott/Core/API/APIModels.swift`
- Modify: `Spott/Resources/zh-Hans.lproj/Localizable.strings`
- Modify: `Spott/Resources/ja.lproj/Localizable.strings`
- Modify: `Spott/Resources/en.lproj/Localizable.strings`
- Create: `SpottTests/PurchaseAttemptIDTests.swift`
- Create: `SpottTests/StorePurchaseCoordinatorTests.swift`
- Modify: `services/api/src/modules/storekit/storekit.service.ts`
- Modify: `services/api/src/modules/storekit/storekit.controller.ts`
- Extend: `services/api/src/modules/storekit/storekit.service.spec.ts`
- Modify: `packages/contracts/openapi.yaml`

**Interfaces:**

```swift
enum StorePurchaseOutcome: Equatable, Sendable {
    case credited(WalletSnapshot)
    case alreadyCredited(WalletSnapshot)
    case pending
    case cancelled
}

enum StoreCreditDisposition: String, Codable, Equatable, Sendable {
    case credited
    case alreadyCredited
}

struct StoreCreditResult: Codable, Equatable, Sendable {
    let disposition: StoreCreditDisposition
    let wallet: WalletSnapshot
}

struct StoreProductSnapshot: Equatable, Sendable {
    let id: String
    let displayName: String
    let displayDescription: String
    let displayPrice: String
}

struct StoreFinishHandle: Hashable, Sendable {
    let opaqueID: UUID                 // internal initializer; no Apple object
}

struct StoreTransactionSnapshot: Equatable, Sendable {
    let id: UInt64
    let productID: String
    let appAccountToken: UUID?
    let signedTransaction: String
    let finishHandle: StoreFinishHandle
}

enum StoreTransactionEvent: Equatable, Sendable {
    case verified(StoreTransactionSnapshot)
    case unverified(transactionID: UInt64?)
}

enum StoreKitPurchaseResult: Equatable, Sendable {
    case success(StoreTransactionSnapshot)
    case pending
    case cancelled
}

enum StoreRefundRequestOutcome: Equatable, Sendable {
    case submitted
    case cancelled
}

protocol StoreTransactionCrediting: Sendable {
    func credit(signedTransaction: String, attemptID: UUID) async throws -> StoreCreditResult
    func refreshWallet() async throws -> WalletSnapshot
}

protocol StoreKitServicing: Sendable {
    func products(for ids: Set<String>) async throws -> [StoreProductSnapshot]
    func purchase(productID: String, appAccountToken: UUID) async throws -> StoreKitPurchaseResult
    func unfinished() -> AsyncStream<StoreTransactionEvent>
    func updates() -> AsyncStream<StoreTransactionEvent>
    func sync() async throws
    func finish(_ handle: StoreFinishHandle) async throws
    func requestRefund(transactionID: UInt64) async throws -> StoreRefundRequestOutcome
}
```

`StorePurchaseCoordinator`, its fakes, and all coordinator unit tests import no StoreKit types. Only `AppleStoreKitAdapter` imports StoreKit. The real adapter is an actor that privately owns `[String: Product]`, `[StoreFinishHandle: Transaction]`, `[UInt64: StoreFinishHandle]`, and a current-process `[UInt64: Transaction]` refund index capped at the 64 most recent owner-matching transactions. It maps verified Apple values into snapshots and creates one opaque finish handle per transaction ID for the current process; purchase results, unfinished enumeration, and duplicate update delivery for that same ID reuse the handle. It removes both handle mappings only after a successful `Transaction.finish()` and rejects an unknown or already-consumed handle. Relaunch recovery creates a new handle from `Transaction.unfinished`; the opaque UUID is not persisted or sent to the server. The separate transaction-ID index lets an eligible just-purchased transaction call `beginRefundRequest(in:)` while keeping `Transaction` and `UIWindowScene` resolution private to the adapter; logout/account switch clears this index before the new owner becomes active.

**Stable attempt UUID:** implement RFC 9562 UUIDv5 with SHA-1 network-order namespace bytes; do not use Swift `Hasher`, random UUID, locale-sensitive formatting, or process-dependent hash values.

```text
namespace URL name: https://spott.jp/storekit/attempt/v1
fixed namespace UUID: a9dfa353-e8af-5b95-a11e-8f8611d269a6
canonical input: spott.storekit.attempt.v1|<lowercase-user-uuid>|<unsigned-decimal-transaction-id>
golden input: spott.storekit.attempt.v1|019b0000-0000-7000-8000-000000000001|2000000123456789
golden UUID: 2c667644-9e4e-53e0-9cfb-6779346ecde7
```

- [ ] **Step 1: Write RED UUID and coordinator tests**

Add `Equatable` to `WalletSnapshot`, then prove the golden vector, UUID version/variant bits, canonical lower-case owner input, and cross-process stability. Construct every product, event, transaction snapshot, and finish handle directly in unit tests without a StoreKit purchase. The fake service records opaque-handle calls and covers verified credit, unverified event, pending, cancellation, transport loss after Apple success, same-transaction retry/relaunch, account-token mismatch, owner switch during credit, duplicate update delivery, unfinished recovery, explicit sync failure, server replay, refund submission/cancellation, refund wallet refresh, unknown/consumed handle, failed finish retaining a handle, and finish exactly once only after server credit/replay success. StoreKit-backed adapter handle reuse/consumption/relaunch tests run in Task 7's local session. Expected RED: snapshots, adapter, coordinator, and deterministic generator are absent.

- [ ] **Step 2: Isolate StoreKit and credit dependencies**

Move the manager sketch into `AppleStoreKitAdapter`; never expose `Product`, `Transaction`, `VerificationResult`, or a `UIWindowScene` through `StoreKitServicing`. `StorePurchaseCoordinator` is the single actor that starts exactly one adapter `updates()` listener during process bootstrap before authentication and keeps that listener alive until process termination. While logged out it neither credits nor finishes; StoreKit keeps the transaction unfinished for the next authenticated reconciliation. Login drains adapter `unfinished()` snapshots. Logout/account switch cancels owner-bound credit tasks and rotates owner generation but never creates a second listener. Unverified events never reach the server and raw diagnostic/JWS content never reaches user copy or logs.

- [ ] **Step 3: Use stable attempt IDs through the API**

For each verified snapshot, require `snapshot.appAccountToken == currentUserID`, derive `PurchaseAttemptID` from current user plus `snapshot.id`, and pass it as the API idempotency key. Change `creditAppleStoreTransaction` to accept `attemptID` instead of generating `UUID()` internally. The server continues to dedupe by Apple transaction ID/order and records the idempotency key only as metadata; a different account remains a hard conflict.

- [ ] **Step 4: Finish only after authoritative completion**

Change the authenticated API response to `{ disposition: "credited" | "alreadyCredited", wallet: WalletSnapshot }`: the newly inserted order returns `credited`, while an existing same-owner Apple transaction returns `alreadyCredited`. On either disposition, publish the returned wallet to the same owner generation and then call `finish(snapshot.finishHandle)`. On network/503 or finish failure, leave/recover the transaction as unfinished and show retry state; never manufacture a replacement handle inside the coordinator. Pending and cancellation are distinct non-error outcomes. Verification/account mismatch remains visible but privacy-safe and unfinished for investigation; it never credits or switches owner. Contract/API/client tests pin both response shapes.

- [ ] **Step 5: Add accurate recovery and iOS 26 UI**

“Recover purchases” is an explicit user action that calls adapter `sync()`, reconciles verified unfinished/update snapshots, and refreshes server wallet/orders. Copy must say that already-finished consumable point packs may not be replayed by Apple and that the server wallet remains authoritative. Add an eligible wallet-order “Request a refund” action: the coordinator asks the adapter to present Apple's refund sheet for the current transaction ID, distinguishes submitted/cancelled sheet outcomes, then waits for StoreKit revocation and server Notifications V2 truth before refreshing the wallet; it never reverses points locally. Add distinct localized pending, cancelled, unavailable, verification failed, account mismatch, offline retry, recovered, already credited, refund submitted, and refund declined states. Use native iOS 26 glass action styles and existing iOS 17 fallback; preserve focus, VoiceOver announcement, Reduce Motion, and 44-point controls.

- [ ] **Step 6: Run focused and full commerce gates**

Run UUID/coordinator tests repeatedly in fresh processes, adapter seam tests, full signed iOS unit/UI suites, API StoreKit tests/integration, and ledger invariant checks. A source scan fails if any file other than `AppleStoreKitAdapter.swift` (and StoreKitTest-only tests) imports StoreKit or mentions `Product`/`Transaction` in the service boundary. Independent review must prove the fakes are fully constructible, Apple objects remain private, no premature/double finish occurs, no cross-account publication occurs, one order/credit exists per Apple transaction, and paid/free reversal behavior matches the server ledger.

---

### Task 7: Add an automated local StoreKitTest lane that cannot weaken the server verifier

**Files:**

- Create as a **SpottTests-only resource**: `SpottTests/Resources/SpottLocal.storekit`
- Create: `Spott.xcodeproj/xcshareddata/xcschemes/Spott.xcscheme` with StoreKit Configuration `None`
- Create: `Spott.xcodeproj/xcshareddata/xcschemes/Spott-StoreKitLocal.xcscheme` with `SpottLocal.storekit` and the dedicated `StoreKitLocal` build configuration
- Create: `Spott.xcodeproj/xcshareddata/xctestplans/SpottStoreKitLocal.xctestplan`
- Create: `SpottTests/StoreKitLocalSessionTests.swift`
- Create: `SpottTests/AppleStoreKitAdapterLocalTests.swift`
- Create: `SpottUITests/StoreKitLocalUITests.swift`
- Create: `SpottTests/Fixtures/FakeStoreTransactionCrediting.swift`
- Create: `Spott/Integrations/DebugStoreTransactionCrediting.swift` guarded in full by `#if SPOTT_STOREKIT_LOCAL`
- Modify: `Spott/SpottApp.swift` to inject the local gateway only under `#if SPOTT_STOREKIT_LOCAL`
- Modify: `Spott.xcodeproj/project.pbxproj` for test-only resource membership and `StoreKitLocal` configuration
- Create: `scripts/verify-storekit-lanes.sh`

- [ ] **Step 1: Add five matching local products and source validation**

Create consumables `jp.spott.points.500`, `.1000`, `.3000`, `.5000`, and `.10000` with zh-Hans/ja/en display name/description metadata and test prices. A test compares exact product IDs with `database/migrations/0013_store_product_catalog.sql` and asserts all three localizations exist for every product. `SpottLocal.storekit` belongs only to the `SpottTests` Resources build phase: it has no `Spott`, `SpottLiveActivity`, or `SpottUITests` target membership. Local configuration data never changes Release provider/server environment.

- [ ] **Step 2: Make lane separation mechanically testable**

The normal shared `Spott` scheme uses StoreKit Configuration `None`. The dedicated `StoreKitLocal` configuration inherits Debug settings, adds only `SWIFT_ACTIVE_COMPILATION_CONDITIONS=$(inherited) SPOTT_STOREKIT_LOCAL`, and is used only by `Spott-StoreKitLocal`; that scheme may reference the source `.storekit` file as an Xcode run/test option, but the app and appex resource phases remain free of it. Unit tests inject `FakeStoreTransactionCrediting`. Local UI tests launch the local configuration with `-spottStoreCreditMode localFixture`; only code fully enclosed by `#if SPOTT_STOREKIT_LOCAL` recognizes that argument and substitutes `DebugStoreTransactionCrediting`, which returns deterministic fixture wallets without HTTP.

`scripts/verify-storekit-lanes.sh` fails if a local StoreKit certificate/root appears in API config/code, if Release/normal scheme selects `.storekit`, if `APPLE_STORE_ENVIRONMENT` gains a `Local` value, if `SPOTT_STOREKIT_LOCAL` appears in Debug/Release, or if an app/appex Resources phase contains the test configuration. It must archive/export Release, recursively inspect the `.xcarchive` and unzipped IPA, and fail on any `.storekit`, fixture JSON/JWS/certificate, `localFixture`, `LOCAL STOREKIT TEST`, `DebugStoreTransactionCrediting`, local-gateway endpoint, or local compilation marker in resource names, plists, nested files, or `strings` output from either executable. A source-level `#if` assertion alone is insufficient.

- [ ] **Step 3: Automate serial `SKTestSession` setup and reset**

Every test runs serially because StoreKitTest has one shared environment. The test resolves the resource from the **test bundle**, never `Bundle.main`, and initializes by URL:

```swift
let bundle = Bundle(for: StoreKitLocalSessionTests.self)
let url = try XCTUnwrap(
    bundle.url(forResource: "SpottLocal", withExtension: "storekit")
)
session = try SKTestSession(contentsOf: url)
session.disableDialogs = true
session.resetToDefaultState()
session.clearTransactions()
session.askToBuyEnabled = false
session.interruptedPurchasesEnabled = false
session.failTransactionsEnabled = false
```

Teardown resets flags and clears transactions. A test fails if the URL is found in `Bundle.main` or the built app/appex. Tests explicitly enable and resolve Ask to Buy, failed transactions, interrupted purchases, duplicate delivery, offline fake-credit failure/retry, `refundTransaction`, and unfinished relaunch recovery. `AppleStoreKitAdapterLocalTests` prove purchase/update for one transaction reuse one opaque handle, unknown and consumed handles fail, successful finish consumes once, and a fresh adapter/relaunch maps unfinished work to a new handle without exposing a StoreKit object. Cancellation is covered by the coordinator fake because dialogs are disabled in automation.

- [ ] **Step 4: Run local UI/sheet evidence separately from automation**

Run `Spott-StoreKitLocal` using the dedicated local configuration with dialogs enabled for payment-sheet and cancellation screenshots; render a clearly marked `LOCAL STOREKIT TEST` banner in the app-owned wallet screen. Capture three languages under `artifacts/task20/storekit/local/`. No screenshot, log, or fixture may contain full JWS or account credentials. The normal Debug and Release configurations must not compile the gateway symbols or render the banner, and the recursive final artifact scan must prove that absence.

- [ ] **Step 5: Prove Apple-root verifier isolation**

Send one local Xcode-signed JWS to a test instance of the real API verifier and assert `STORE_SIGNATURE_INVALID`; send it only to the fake local gateway for successful coordinator tests. Run `scripts/verify-storekit-lanes.sh`, local test plan, API StoreKit tests, and independent security review.

---

### Task 8: Complete the real App Store Sandbox and Notifications V2 journey

**Files:**

- Extend: `docs/runbooks/ios-task20-release-surfaces.md`
- Add only redacted evidence beneath: `artifacts/task20/storekit/sandbox/`

**Preconditions:** App Store Connect app bundle `com.yaokai.Spott`; all five consumables created/available for Sandbox with Simplified Chinese, Japanese, and English display name/description metadata; dedicated Sandbox Apple Accounts; physical iPhone/iPad in Developer Mode; API reachable over TLS; Sandbox App Store Server Notifications V2 URL configured; Apple root certificates and Sandbox verifier environment configured. App Store Connect/App Store Server API issuer ID, key ID, and `.p8` live only in an external secret manager; the runbook names secret references/access owners, never values. APNs credentials remain separately scoped.

- [ ] **Step 1: Prove local StoreKit is disabled**

Launch the normal `Spott` Release scheme or TestFlight build with StoreKit Configuration `None`. `Product.products(for:)` must return App Store Connect metadata. Prove the lane from the Apple-root-verified transaction JWS `environment=Sandbox`, the Sandbox API endpoint/account context, and the absence of `.storekit`/local gateway in the recursively inspected app/IPA. Apple's visible `[Environment: Sandbox]` label may be supporting screenshot evidence but is not the proof and must not be parsed as a test oracle. Save `scripts/verify-storekit-lanes.sh` output as `sandbox/00-lane-preflight.txt`.

Switch the physical device/App Store storefront language through zh-Hans, ja, and en and record the `StoreProductSnapshot` display name, description, and Apple-formatted display price for every pack. App-owned wallet/recovery/refund copy must have exact three-language key parity. Product names/descriptions come from App Store Connect and Apple payment/refund sheet strings come from the device/App Store locale; neither is copied into app `Localizable.strings`. Fail if any locale falls back to another language or if the app tries to override Apple system-sheet copy.

- [ ] **Step 2: Prove real Apple JWS verification and deterministic replay**

Buy `jp.spott.points.500` for the no-bonus path and `jp.spott.points.1000` for the paid-plus-bonus path. The app sends Apple's Sandbox JWS to API configured with `APPLE_STORE_ENVIRONMENT=Sandbox`, Apple root CAs, exact bundle ID, and App Store app ID. Record only redacted transaction suffix, deterministic attempt UUID, order ID suffix, JWS verification metadata/environment, and wallet versions. Retry each same transaction and prove one `commerce.store_orders` row, one paid credit, zero/one bonus credit as catalogued, unchanged balance on replay, and finish only after server success.

- [ ] **Step 3: Exercise Sandbox user outcomes**

On physical devices, exercise successful purchase, user cancellation, purchases disabled/failure, interrupted purchase and resolution, network loss after Apple success, app termination before server credit, relaunch unfinished recovery, explicit Recover purchases, account switch guard, and duplicate listener delivery. Repeat sheet/copy checks in zh-Hans, ja, and en using dedicated test state. Xcode StoreKitTest scenarios may supplement diagnosis but cannot satisfy any row in this Sandbox step.

- [ ] **Step 4: Prove external App Store Server API credentials and V2 delivery**

Configure the Sandbox V2 HTTPS URL in App Store Connect. Generate a short-lived ES256 App Store Connect API JWT at runtime from external issuer/key references with `exp <= iat + 1200`, never store it in git/logs, and call Apple's Request a Test Notification and Get Test Notification Status endpoints until Apple reports successful delivery. Verify the received `signedPayload` against Apple roots, exact bundle/app IDs, and Sandbox environment; persist only notification UUID/idempotency state plus redacted verification metadata. Re-deliver the same signed notification and prove exactly one processed notification record and no wallet mutation. A local fixture cannot satisfy this network gate.

- [ ] **Step 5: Prove a real approved Sandbox refund and paid/free reversal**

On a physical device, make a fresh `jp.spott.points.1000` purchase so the ledger contains both paid and free/bonus credit. From the app's eligible order action call the real adapter's `Transaction.beginRefundRequest(in:)`, choose an ordinary Sandbox reason that Apple auto-approves, and wait for both the StoreKit revoked transaction update and Apple's real Notifications V2 `REFUND`. Require Apple-root JWS verification with `environment=Sandbox` and matching original transaction/product/app-account identity before mutation.

Prove in SQL/API evidence that the order becomes refunded/revoked; one compensating paid ledger entry exactly negates the original paid credit; one compensating free ledger entry exactly negates the original bonus; wallet paid/free/total balance and version change once; and the same full Apple `signedPayload` delivered again is idempotent with no second reversal/version change. App state refreshes from server truth; the client creates no local debit. `SKTestSession.refundTransaction`, hand-built notifications, and checked-in signed fixtures remain unit/integration evidence only and cannot substitute for this physical-device Sandbox refund.

- [ ] **Step 6: Prove a real declined Sandbox refund has no reversal**

Make a separate fresh Sandbox purchase. Open Apple's refund sheet on the physical device, choose **Other**, enter the documented Sandbox decline trigger `DECLINE`, submit, and require a real Apple-root-verified V2 `REFUND_DECLINED` for that transaction. Prove the order remains credited, no paid/free reversal rows are inserted, wallet balances/version remain unchanged, and duplicate delivery of that exact signed notification is idempotent. The app shows localized declined status only after server refresh; it does not infer decline from sheet dismissal or timeout.

- [ ] **Step 7: Record external evidence without secrets**

Save the exact Task 9 Sandbox screenshots, redacted API/worker verification logs, test-notification status, approved/declined refund status, and SQL invariants. Do not store Sandbox email/password, raw JWS, Apple API private key, APNs token, full transaction ID, or full provisioning identifiers. If any App Store Connect localization/product, API key, notification URL/control, physical-device refund sheet, Apple-signed `REFUND`/`REFUND_DECLINED`, or duplicate-delivery path is unavailable, Task 8 remains externally blocked and Task 20 remains incomplete.

---

### Task 9: Produce the fixed screenshot/accessibility matrix and aggregate release gate

**Files:**

- Create: `scripts/hash-release-source.sh`
- Create: `scripts/verify-task20-evidence-manifest.sh`
- Create during acceptance: `artifacts/task20/source/source-files.txt`
- Create during acceptance: `artifacts/task20/source/source-tree.sha256`
- Create during acceptance: `artifacts/task20/manifest.json`

#### AppIcon evidence matrix

Capture these installed Home Screen/App Library files:

```text
artifacts/task20/app-icon/iphone-ios26-default-light.png
artifacts/task20/app-icon/iphone-ios26-default-dark.png
artifacts/task20/app-icon/iphone-ios26-tinted.png
artifacts/task20/app-icon/iphone-ios26-clear-light.png
artifacts/task20/app-icon/iphone-ios26-clear-dark.png
artifacts/task20/app-icon/ipad-ios26-default-light.png
artifacts/task20/app-icon/ipad-ios26-default-dark.png
artifacts/task20/app-icon/ipad-ios26-tinted.png
artifacts/task20/app-icon/ipad-ios26-clear-light.png
artifacts/task20/app-icon/ipad-ios26-clear-dark.png
artifacts/task20/app-icon/iphone-ios17-fallback-light.png
artifacts/task20/app-icon/iphone-ios17-fallback-dark.png
artifacts/task20/app-icon/iphone-ios18-fallback-light.png
artifacts/task20/app-icon/iphone-ios18-fallback-dark.png
artifacts/task20/app-icon/iphone-ios18-fallback-tinted.png
```

#### Live Activity presentation/state matrix

Base presentation files use en/system Large/light: `dynamic-island-compact.png`, `dynamic-island-minimal.png`, `dynamic-island-expanded.png`, `iphone-lock-screen-dynamic-island.png`, `iphone-lock-screen-no-dynamic-island.png`, and `ipad-lock-screen.png`. State files are `state-active.png`, `state-stale.png`, `state-ended.png`, and `state-cancelled.png`. Store them under `artifacts/task20/live-activity/base/`.

Locale/appearance files are the Cartesian product of `zh-Hans`, `ja`, `en` and `light`, `dark` for Lock Screen plus expanded Dynamic Island, named:

```text
artifacts/task20/live-activity/locales/<locale>-<appearance>-lock-screen.png
artifacts/task20/live-activity/locales/<locale>-<appearance>-expanded.png
```

Accessibility evidence for each locale is:

```text
artifacts/task20/live-activity/accessibility/<locale>-AX5-lock-screen.png
artifacts/task20/live-activity/accessibility/<locale>-AX5-expanded.png
artifacts/task20/live-activity/accessibility/<locale>-voiceover.txt
artifacts/task20/live-activity/accessibility/<locale>-reduce-motion.mov
artifacts/task20/live-activity/accessibility/<locale>-audit.xcresult
```

VoiceOver transcript names title, area, phase, remaining-time meaning, and tap destination without duplicate decorative labels. Reduce Motion evidence contains no custom looping/morphing animation. AX5 evidence has no clipped/truncated primary meaning.

Physical worker-to-APNs evidence is mandatory and separate from presentation screenshots:

```text
artifacts/task20/live-activity/apns/device-update.txt
artifacts/task20/live-activity/apns/device-end.txt
artifacts/task20/live-activity/apns/device-cancel.txt
artifacts/task20/live-activity/apns/identical-retry.txt
artifacts/task20/live-activity/apns/410-durable-disable.txt
```

#### Push-response evidence matrix

```text
artifacts/task20/push/foreground-default-action.xcresult
artifacts/task20/push/background-default-action.xcresult
artifacts/task20/push/cold-start-before-bootstrap.xcresult
artifacts/task20/push/cold-start-login-gate.png
artifacts/task20/push/cold-start-authorized-destination.png
artifacts/task20/push/dismiss-and-unknown-ignored.txt
artifacts/task20/push/cross-account-rejected.txt
artifacts/task20/push/payload-redaction.json
artifacts/task20/push/payload-utf8-4096-boundary.txt
artifacts/task20/push/exact-live-activity-route-tests.txt
artifacts/task20/push/server-time-drift-tests.txt
```

#### StoreKit local versus Sandbox matrix

Local files, always with a visible `LOCAL STOREKIT TEST` test banner outside the Apple sheet:

```text
artifacts/task20/storekit/local/<locale>-purchase-sheet.png
artifacts/task20/storekit/local/<locale>-pending.png
artifacts/task20/storekit/local/<locale>-cancelled.png
artifacts/task20/storekit/local/<locale>-interrupted.png
artifacts/task20/storekit/local/<locale>-recovered.png
artifacts/task20/storekit/local/<locale>-light-wallet.png
artifacts/task20/storekit/local/<locale>-dark-wallet.png
artifacts/task20/storekit/local/<locale>-AX5.png
artifacts/task20/storekit/local/<locale>-voiceover.txt
artifacts/task20/storekit/local/<locale>-reduce-motion.mov
artifacts/task20/storekit/local/<locale>-audit.xcresult
```

Real Sandbox files, proving Apple-root-verified Sandbox state and no local-test fixture/gateway:

```text
artifacts/task20/storekit/sandbox/00-lane-preflight.txt
artifacts/task20/storekit/sandbox/<locale>-sandbox-sheet.png
artifacts/task20/storekit/sandbox/<locale>-catalog-metadata.txt
artifacts/task20/storekit/sandbox/<locale>-credited-wallet.png
artifacts/task20/storekit/sandbox/<locale>-dark-credited-wallet.png
artifacts/task20/storekit/sandbox/<locale>-cancelled.png
artifacts/task20/storekit/sandbox/<locale>-offline-retry.png
artifacts/task20/storekit/sandbox/<locale>-recovered.png
artifacts/task20/storekit/sandbox/notifications-v2-status.json
artifacts/task20/storekit/sandbox/refund-approved-sheet.png
artifacts/task20/storekit/sandbox/refund-approved-v2.json
artifacts/task20/storekit/sandbox/refund-declined-sheet.png
artifacts/task20/storekit/sandbox/refund-declined-v2.json
artifacts/task20/storekit/sandbox/refund-duplicate-idempotency.txt
artifacts/task20/storekit/sandbox/ledger-invariants.txt
```

#### Evidence provenance manifest

`artifacts/task20/manifest.json` is machine-verified and contains: base commit; SHA-256 of the complete tracked/untracked source manifest; SHA-256 of the binary diff; archive/export paths; archive creation UTC; app and appex bundle versions; Mach-O/dSYM UUIDs (the archive UUID set); a canonical sorted per-file SHA-256 manifest for the `.xcarchive`; SHA-256 of that archive manifest, exported IPA, app executable, appex executable, `Assets.car`, and redacted profile/entitlement reports; Xcode/runtime versions; and every evidence file's SHA-256. Each screenshot/movie/transcript entry also records capture origin (`physical-device`, `simulator`, `Organizer`, or `system-sheet`), device model, OS/runtime, locale, appearance, UTC, app build/commit, source-tree hash, and originating app binary UUID/SHA. Evidence from a different source hash or unidentified screenshot origin fails acceptance.

- [ ] **Step 1: Finish all automated code, backend, and migration gates before freezing**

Build Debug and Release app+appex with zero new warnings. Run the full signed `SpottTests` suite and single-worker `SpottUITests` suite on iOS 26.5, focused iOS 17 fallback tests, and the StoreKit local test plan. Run API and worker test/lint/typecheck/build, full PostGIS integration, contract lint/bundle/client drift, and migrations 0001–0023 twice against a fresh PostgreSQL 18 database. Prove notification route authorization, full-payload UTF-8 size limits, server-time freshness, exact Live Activity URL grammar, token encryption/no-log, durable-outbox crash recovery/42→43 supersession, StoreKit order idempotency, and refund paid/free balance invariants. Save `.xcresult` and text reports under `artifacts/task20/xcresults/`; any source fix sends execution back to this step.

- [ ] **Step 2: Freeze one reproducible source/diff hash**

`scripts/hash-release-source.sh` records `git rev-parse HEAD`, current status, and a NUL-safe sorted enumeration from `git ls-files --cached --others --exclude-standard`. Exclude only `artifacts/task20/` and declared DerivedData/archive/export output directories; do not exclude implementation, project, scripts, runbooks, `.icon`, `.storekit`, untracked source, or this plan. For every included path record path bytes, executable/file mode, size, and SHA-256 in `artifacts/task20/source/source-files.txt`, then SHA-256 that manifest into `source-tree.sha256`. Also hash `git diff --binary --no-ext-diff HEAD` as a tracked-diff diagnostic; the file manifest, not this diff alone, covers untracked source.

Record the resulting value as `TASK20_SOURCE_HASH`. From this point onward, no source/project/config/script/runbook change is permitted. Recompute before and after every remaining step; any mismatch invalidates all later evidence, deletes its acceptance status, and restarts at Step 1 with a new hash.

- [ ] **Step 3: Capture accessibility and every physical external gate from the frozen hash**

Build/install a development-signed app+appex from `TASK20_SOURCE_HASH`. Run XCUITest `performAccessibilityAudit` for itinerary controls and wallet purchase/recovery/refund UI in all three locales, system light/dark, AX5, VoiceOver, and Reduce Motion. Widget/Lock Screen VoiceOver is manually recorded because it runs outside the containing app test hierarchy. Log Apple system-sheet issues separately from app-owned failures, and attach origin metadata to every capture.

Repeat the physical-device worker→Sandbox-APNs update/end/cancellation, identical-body retry, and real-410 durable-disable gate from Task 4. Repeat Task 8's real App Store Sandbox purchase/recovery, three-language App Store Connect metadata, V2 test notification, approved `REFUND` with paid/free reversal, declined `REFUND_DECLINED` without reversal, and duplicate-signed-notification idempotency on a build from the same source hash. Earlier experiments are rehearsal only. A simulator, mocked APNs, StoreKitTest, fixture JWS, or screenshot without origin/source hash cannot fill an external row.

- [ ] **Step 4: After all behavior passes, rebuild and validate one final archive from that same hash**

Recompute and require `TASK20_SOURCE_HASH`, discard prior Task 5 preflight DerivedData/archive/export directories, and perform a fresh Release archive to a path containing the source-hash prefix. Export **that exact `.xcarchive`** once with `config/ios/ExportOptions-AppStore.plist`; do not rebuild between archive and export. Open that same archive in Xcode Organizer, run **Validate App**, and save the validation report. Recompute the source hash immediately before archive, after archive, after export, and after Organizer validation; all four values must be identical.

Record `xcodebuild -version`, SDK, archive creation UTC, build settings, the app/appex Mach-O UUIDs from `dwarfdump --uuid`, matching dSYM UUIDs, and archive/export paths. If validation, signing, export, or source-hash equality fails, there is no final archive and Task 20 remains incomplete.

- [ ] **Step 5: Inspect the final archive and exported IPA recursively**

Run `scripts/verify-ios-app-icon.sh`, `scripts/verify-ios-archive.sh`, and `scripts/verify-storekit-lanes.sh` against the frozen archive and unzipped IPA. Verify nested signatures, exact app/appex profiles and entitlements, `aps-environment` only on the app, localization/development-region behavior, bundle/version equality, icon stack plus legacy renditions, and matching executable/dSYM UUIDs. Recursively scan every nested file and both executable `strings` outputs for `.storekit`, fixture JSON/JWS/certificates, `localFixture`, `LOCAL STOREKIT TEST`, debug gateway names/endpoints, raw APNs tokens/JWS/credentials, or forbidden push/Live Activity fields. Compute SHA-256 for the `.xcarchive` representation, IPA, app and appex executables, `Assets.car`, and redacted profile/entitlement reports. Recompute `TASK20_SOURCE_HASH` after inspection.

- [ ] **Step 6: Build and verify the evidence manifest and privacy scans**

Run `git diff --check`; localization key parity; source secret scans; complete normal-push and Live Activity payload scans; screenshot filename/origin completeness; and all evidence verifiers. Generate `artifacts/task20/manifest.json` only after the files are final. It hashes every evidence file except the manifest itself and links each to `TASK20_SOURCE_HASH`; it includes the product hashes/UUIDs and per-capture provenance defined above. `scripts/verify-task20-evidence-manifest.sh` recalculates every hash, rejects absolute secret-bearing paths or raw credentials, rejects a screenshot/transcript with missing device/runtime/locale/origin/product identity, and requires final source hash equality. Any missing or stale row fails the aggregate gate.

- [ ] **Step 7: Obtain independent final reviews**

Require separate brand/icon, push security, Live Activity privacy/extension-signing/APNs durability, StoreKit commerce/refund, accessibility/localization, release provenance, and aggregate release reviewers. Completion requires no Critical or Important findings and explicit confirmation that local StoreKit evidence was not used as real Sandbox evidence, that the physical APNs 200/retry/410 gate is genuine, and that Organizer validated the same frozen-source archive recorded in the manifest.

- [ ] **Step 8: Update parent Task 20 only after external proof exists**

Do not mark Task 20 complete until the real layered icon, exact-hash signed embedded/exported appex, authorized notification cold-start, durable Live Activity worker/APNs lifecycle, StoreKit local lane, real Apple Sandbox/V2 approved-and-declined refund lanes, final recursive artifact scan, and fixed provenance matrix all pass. Simulator builds, mocked servers, fixtures, unsigned/preflight archives, or partial language/surface matrices are not substitutes for the stated external gates.
