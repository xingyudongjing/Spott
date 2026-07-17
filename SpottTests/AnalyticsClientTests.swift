import Foundation
import Testing
@testable import Spott

struct AnalyticsClientTests {
    @Test func payloadMatchesIOSBatchContractWithoutCredentials() async throws {
        let defaults = makeDefaults(consent: true)
        let recorder = AnalyticsRequestRecorder()
        let client = AnalyticsClient(
            environment: APIEnvironment(baseURL: URL(string: "https://api.spott.test/v1")!),
            consentStore: AnalyticsConsentStore(defaults: defaults),
            anonymousID: UUID(uuidString: "00000000-0000-0000-0000-000000000111")!,
            sessionID: UUID(uuidString: "00000000-0000-0000-0000-000000000222")!,
            now: { ISO8601DateFormatter().date(from: "2026-07-16T00:00:00Z")! },
            transport: { request in try await recorder.capture(request) }
        )

        await client.track(.discoveryViewed, properties: [
            "region": .string("tokyo"),
            "itemCount": .integer(3),
            "reason": .string("initial"),
        ])

        let request = try #require(await recorder.firstRequest())
        #expect(request.url?.absoluteString == "https://api.spott.test/v1/analytics/events/batch")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
        #expect(request.value(forHTTPHeaderField: "Cookie") == nil)

        let event = try eventObject(from: request)
        #expect(Set(event.keys) == Set([
            "eventName", "schemaVersion", "anonymousId", "sessionId",
            "platform", "properties", "occurredAt",
        ]))
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

    @Test func consentDefaultsOffAndChangesTakeEffectImmediately() async {
        let defaults = makeDefaults()
        let recorder = AnalyticsRequestRecorder()
        let client = makeClient(defaults: defaults, recorder: recorder)

        await client.track(.discoveryViewed)
        #expect(await recorder.count == 0)

        defaults.set(true, forKey: AnalyticsClient.consentKey)
        await client.track(.discoveryViewed)
        #expect(await recorder.count == 1)

        defaults.set(false, forKey: AnalyticsClient.consentKey)
        await client.track(.discoveryViewed)
        #expect(await recorder.count == 1)
    }

    @Test func sanitizerRemovesSensitiveKeysRecursively() async throws {
        let recorder = AnalyticsRequestRecorder()
        let client = makeClient(defaults: makeDefaults(consent: true), recorder: recorder)

        await client.track(.eventDetailViewed, properties: [
            "region": .string("tokyo"),
            "phoneNumber": .string("+81000000000"),
            "OTP": .string("123456"),
            "profile": .object([
                "source": .string("discovery"),
                "messageBody": .string("private text"),
            ]),
            "items": .array([
                .object([
                    "eventId": .string("00000000-0000-0000-0000-000000000333"),
                    "access_token": .string("secret"),
                ]),
            ]),
        ])

        let event = try eventObject(from: #require(await recorder.firstRequest()))
        let properties = try #require(event["properties"] as? [String: Any])
        #expect(properties["region"] as? String == "tokyo")
        #expect(properties["phoneNumber"] == nil)
        #expect(properties["OTP"] == nil)
        let profile = try #require(properties["profile"] as? [String: Any])
        #expect(profile["source"] as? String == "discovery")
        #expect(profile["messageBody"] == nil)
        let items = try #require(properties["items"] as? [[String: Any]])
        #expect(items.first?["eventId"] as? String == "00000000-0000-0000-0000-000000000333")
        #expect(items.first?["access_token"] == nil)
    }

    @Test func transportFailureDoesNotEscapeTrack() async {
        let defaults = makeDefaults(consent: true)
        let client = AnalyticsClient(
            environment: APIEnvironment(baseURL: URL(string: "https://api.spott.test/v1")!),
            consentStore: AnalyticsConsentStore(defaults: defaults),
            anonymousID: UUID(),
            sessionID: UUID(),
            transport: { _ in throw AnalyticsTransportFailure.offline }
        )

        await client.track(.registrationCompleted, properties: ["status": .string("confirmed")])

        #expect(true)
    }

    @Test func analyticsSessionIsIndependentFromStableAnonymousIdentity() async throws {
        let anonymousID = UUID(uuidString: "00000000-0000-0000-0000-000000000111")!
        let firstSession = UUID(uuidString: "00000000-0000-0000-0000-000000000222")!
        let secondSession = UUID(uuidString: "00000000-0000-0000-0000-000000000444")!
        let defaults = makeDefaults(consent: true)
        let firstRecorder = AnalyticsRequestRecorder()
        let secondRecorder = AnalyticsRequestRecorder()
        let first = AnalyticsClient(
            environment: APIEnvironment(baseURL: URL(string: "https://api.spott.test/v1")!),
            consentStore: AnalyticsConsentStore(defaults: defaults),
            anonymousID: anonymousID,
            sessionID: firstSession,
            transport: { request in try await firstRecorder.capture(request) }
        )
        let second = AnalyticsClient(
            environment: APIEnvironment(baseURL: URL(string: "https://api.spott.test/v1")!),
            consentStore: AnalyticsConsentStore(defaults: defaults),
            anonymousID: anonymousID,
            sessionID: secondSession,
            transport: { request in try await secondRecorder.capture(request) }
        )

        await first.track(.discoveryViewed)
        await second.track(.discoveryViewed)

        let firstEvent = try eventObject(from: #require(await firstRecorder.firstRequest()))
        let secondEvent = try eventObject(from: #require(await secondRecorder.firstRequest()))
        #expect(firstEvent["anonymousId"] as? String == secondEvent["anonymousId"] as? String)
        #expect(firstEvent["sessionId"] as? String == firstSession.uuidString.lowercased())
        #expect(secondEvent["sessionId"] as? String == secondSession.uuidString.lowercased())
        #expect(firstEvent["sessionId"] as? String != secondEvent["sessionId"] as? String)
    }

    @Test func p0SignalsUseStableNamesAndPrivacySafeProperties() {
        let eventID = UUID(uuidString: "00000000-0000-0000-0000-000000000333")!
        let discovery = P0AnalyticsSignal.discoveryViewed(region: "tokyo", itemCount: 3, reason: "initial")
        let detail = P0AnalyticsSignal.eventDetailViewed(
            eventID: eventID,
            publicSlug: "city-walk",
            category: "outdoor"
        )
        let registration = P0AnalyticsSignal.registrationCompleted(
            eventID: eventID,
            status: "confirmed",
            partySize: 2
        )
        let submission = P0AnalyticsSignal.eventSubmissionCompleted(
            eventID: eventID,
            status: "pending_review",
            category: "outdoor",
            posterEnabled: true
        )

        #expect(discovery.name == .discoveryViewed)
        #expect(detail.name == .eventDetailViewed)
        #expect(registration.name == .registrationCompleted)
        #expect(submission.name == .eventSubmissionCompleted)
        #expect(Set(discovery.properties.keys) == Set(["region", "itemCount", "reason"]))
        #expect(Set(detail.properties.keys) == Set(["eventId", "publicSlug", "category"]))
        #expect(Set(registration.properties.keys) == Set(["eventId", "status", "partySize"]))
        #expect(Set(submission.properties.keys) == Set(["eventId", "status", "category", "posterEnabled"]))
    }

    @Test @MainActor func bootstrapAttributesDiscoveryOnlyAfterAResponseIsApplied() async throws {
        let recorder = AnalyticsRequestRecorder()
        let model = makeAttributionModel(
            discoveryService: AttributionDiscoveryService(outcomes: [
                .success(Array(EventSummary.samples.prefix(2))),
            ]),
            discoveryCache: AttributionDiscoveryCache(),
            recorder: recorder
        )

        await model.bootstrap()

        let request = try #require(await waitForRequest(recorder))
        let event = try eventObject(from: request)
        let properties = try #require(event["properties"] as? [String: Any])
        #expect(properties["region"] as? String == "tokyo")
        #expect(properties["itemCount"] as? Int == 2)
        #expect(properties["reason"] as? String == "initial")
    }

    @Test @MainActor func bootstrapDoesNotAttributeAFailedDiscoveryRequest() async throws {
        let recorder = AnalyticsRequestRecorder()
        let model = makeAttributionModel(
            discoveryService: AttributionDiscoveryService(outcomes: [.offline]),
            discoveryCache: AttributionDiscoveryCache(),
            recorder: recorder
        )

        await model.bootstrap()
        try await Task.sleep(for: .milliseconds(100))

        #expect(await recorder.count == 0)
        #expect(model.discovery.phase == .error)
    }

    @Test @MainActor func bootstrapDoesNotAttributeOfflineCacheAsANetworkSuccess() async throws {
        let recorder = AnalyticsRequestRecorder()
        let cached = Array(EventSummary.samples.prefix(1))
        let model = makeAttributionModel(
            discoveryService: AttributionDiscoveryService(outcomes: [.offline]),
            discoveryCache: AttributionDiscoveryCache(events: cached),
            recorder: recorder
        )

        await model.bootstrap()
        try await Task.sleep(for: .milliseconds(100))

        #expect(await recorder.count == 0)
        #expect(model.discovery.items.count == 1)
        #expect(model.discovery.phase == .offline)
    }

    @Test @MainActor func manualRefreshAttributesOnlyTheSuccessfulAppliedResponse() async throws {
        let recorder = AnalyticsRequestRecorder()
        let service = AttributionDiscoveryService(outcomes: [
            .success(Array(EventSummary.samples.prefix(1))),
            .success(Array(EventSummary.samples.prefix(3))),
        ])
        let model = makeAttributionModel(
            discoveryService: service,
            discoveryCache: AttributionDiscoveryCache(),
            recorder: recorder
        )
        _ = await model.discovery.loadInitial()

        await model.refresh(reason: .manual)

        let request = try #require(await waitForRequest(recorder))
        let event = try eventObject(from: request)
        let properties = try #require(event["properties"] as? [String: Any])
        #expect(properties["itemCount"] as? Int == Array(EventSummary.samples.prefix(3)).count)
        #expect(properties["reason"] as? String == "manual")
    }

    @Test @MainActor func manualRefreshDoesNotAttributeFailureOrShowFalseSuccess() async throws {
        let recorder = AnalyticsRequestRecorder()
        let service = AttributionDiscoveryService(outcomes: [
            .success(Array(EventSummary.samples.prefix(1))),
            .offline,
        ])
        let model = makeAttributionModel(
            discoveryService: service,
            discoveryCache: AttributionDiscoveryCache(),
            recorder: recorder
        )
        _ = await model.discovery.loadInitial()

        let refresh = Task { await model.refresh(reason: .manual) }
        for _ in 0..<50 where model.discovery.refreshError == nil {
            try await Task.sleep(for: .milliseconds(10))
        }

        #expect(await recorder.count == 0)
        #expect(model.banner?.tone == .warning)
        refresh.cancel()
        await refresh.value
    }

    @MainActor
    private func makeAttributionModel(
        discoveryService: any DiscoveryServing,
        discoveryCache: any DiscoveryCaching,
        recorder: AnalyticsRequestRecorder
    ) -> AppModel {
        let persistence = PersistenceStore.makeInMemory()
        let vault = CredentialVault(service: "jp.spott.analytics-tests.\(UUID().uuidString)")
        let api = SpottAPIClient(
            environment: APIEnvironment(baseURL: URL(string: "https://api.spott.test/v1")!),
            credentials: vault
        )
        let analytics = makeClient(defaults: makeDefaults(consent: true), recorder: recorder)
        return AppModel(
            api: api,
            analytics: analytics,
            persistence: discoveryCache,
            sync: SyncEngine(api: api, persistence: persistence),
            router: AppRouter(),
            sessionRestorer: AttributionSessionRestorer(),
            syncPuller: AttributionSyncPuller(),
            discovery: DiscoveryStore(service: discoveryService, cache: discoveryCache)
        )
    }

    private func waitForRequest(_ recorder: AnalyticsRequestRecorder) async -> URLRequest? {
        for _ in 0..<50 {
            if let request = await recorder.firstRequest() { return request }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return await recorder.firstRequest()
    }

    private func makeClient(
        defaults: UserDefaults,
        recorder: AnalyticsRequestRecorder
    ) -> AnalyticsClient {
        AnalyticsClient(
            environment: APIEnvironment(baseURL: URL(string: "https://api.spott.test/v1")!),
            consentStore: AnalyticsConsentStore(defaults: defaults),
            anonymousID: UUID(uuidString: "00000000-0000-0000-0000-000000000111")!,
            sessionID: UUID(uuidString: "00000000-0000-0000-0000-000000000222")!,
            transport: { request in try await recorder.capture(request) }
        )
    }

    private func makeDefaults(consent: Bool? = nil) -> UserDefaults {
        let suite = "AnalyticsClientTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        if let consent {
            defaults.set(consent, forKey: AnalyticsClient.consentKey)
        }
        return defaults
    }

    private func eventObject(from request: URLRequest) throws -> [String: Any] {
        let data = try #require(request.httpBody)
        let root = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let events = try #require(root["events"] as? [[String: Any]])
        #expect(events.count == 1)
        return try #require(events.first)
    }
}

private actor AnalyticsRequestRecorder {
    private(set) var requests: [URLRequest] = []

    var count: Int { requests.count }

    func firstRequest() -> URLRequest? { requests.first }

    func capture(_ request: URLRequest) throws -> (Data, URLResponse) {
        requests.append(request)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 202,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        return (Data(#"{"accepted":1}"#.utf8), response)
    }
}

private enum AnalyticsTransportFailure: Error {
    case offline
}

private actor AttributionSessionRestorer: SessionRestoring {
    func currentSession() async throws -> UserSession? { nil }
}

private actor AttributionSyncPuller: SyncPulling {
    func pull(reason: SyncReason) async throws -> SyncResult {
        _ = reason
        return SyncResult(applied: 0, nextCursor: 0, hasMore: false)
    }
}

private actor AttributionDiscoveryService: DiscoveryServing {
    enum Outcome: Sendable {
        case success([EventSummary])
        case offline
    }

    private var outcomes: [Outcome]

    init(outcomes: [Outcome]) {
        self.outcomes = outcomes
    }

    func discovery(_ query: EventDiscoveryQuery) async throws -> DiscoveryPage {
        _ = query
        let outcome = outcomes.isEmpty ? .offline : outcomes.removeFirst()
        switch outcome {
        case .success(let events):
            return DiscoveryPage(
                items: events,
                nextCursor: nil,
                hasMore: false,
                serverTime: Date(timeIntervalSince1970: 1_773_792_000),
                queryExplanationId: "analytics-attribution-test"
            )
        case .offline:
            throw URLError(.notConnectedToInternet)
        }
    }
}

private actor AttributionDiscoveryCache: DiscoveryCaching {
    private var events: [EventSummary]

    init(events: [EventSummary] = []) {
        self.events = events
    }

    func cachedEvents() async throws -> [EventSummary] { events }
    func replaceEvents(_ events: [EventSummary]) async throws { self.events = events }
}
