import SwiftUI
import XCTest
@testable import Spott

@MainActor
final class AppRouterTests: XCTestCase {
    private let firstEvent = EventSummary.samples[0]
    private let secondEvent = EventSummary.samples[1]

    override func tearDown() {
        AppRouterURLProtocol.reset()
        super.tearDown()
    }

    func testEveryTabKeepsAnIndependentNavigationPath() {
        let router = AppRouter()

        router.selectedTab = .activities
        router.show(event: firstEvent)
        router.selectedTab = .profile
        router.show(event: secondEvent)

        XCTAssertEqual(router.path(for: .activities), [.event(.init(event: firstEvent))])
        XCTAssertEqual(router.path(for: .profile), [.event(.init(event: secondEvent))])
        XCTAssertTrue(router.path(for: .discovery).isEmpty)
    }

    func testBindingWritesOnlyTheRequestedTabPath() {
        let router = AppRouter()
        let discovery = router.binding(for: .discovery)
        let activities = router.binding(for: .activities)

        discovery.wrappedValue = [.notifications]
        activities.wrappedValue = [.wallet]

        XCTAssertEqual(router.path(for: .discovery), [.notifications])
        XCTAssertEqual(router.path(for: .activities), [.wallet])
        XCTAssertTrue(router.path(for: .groups).isEmpty)
    }

    func testExplicitTabPushSelectsThatTabWithoutDestroyingOtherHistory() {
        let router = AppRouter()
        router.setPath([.notifications], for: .discovery)

        router.show(event: firstEvent, in: .activities)

        XCTAssertEqual(router.selectedTab, .activities)
        XCTAssertEqual(router.path(for: .activities), [.event(.init(event: firstEvent))])
        XCTAssertEqual(router.path(for: .discovery), [.notifications])
    }

    func testTrustedEventDeepLinkSwitchesTabThenAppendsStableReference() async throws {
        let router = AppRouter()
        router.setPath([.wallet], for: .activities)
        let url = try XCTUnwrap(URL(string: "https://spott.jp/e/summer-night?tab=activities"))

        let opened = await router.open(url: url)
        XCTAssertTrue(opened)

        XCTAssertEqual(router.selectedTab, .activities)
        XCTAssertEqual(
            router.path(for: .activities),
            [.wallet, .event(.init(id: nil, slug: "summer-night"))]
        )
    }

    func testCustomSchemeGroupAndShareLinksUseTheSameStrictParser() throws {
        let router = AppRouter()

        XCTAssertEqual(
            router.route(
                url: try XCTUnwrap(URL(string: "spott://g/tokyo-weekend"))
            ),
            .requiresResolution(.group(identifier: "tokyo-weekend", targetTab: .groups))
        )
        XCTAssertEqual(
            router.route(
                url: try XCTUnwrap(URL(string: "spott://s/share_code-42"))
            ),
            .requiresResolution(.share(code: "share_code-42"))
        )
        XCTAssertTrue(router.path(for: .groups).isEmpty)
    }

    func testDeepLinksRejectExtraSegmentsAndEncodedSeparators() throws {
        let router = AppRouter()

        XCTAssertEqual(
            router.route(
                url: try XCTUnwrap(URL(string: "https://spott.jp/g/tokyo-weekend/extra"))
            ),
            .rejected
        )
        XCTAssertEqual(
            router.route(
                url: try XCTUnwrap(URL(string: "https://spott.jp/e/private%2Fsegment"))
            ),
            .rejected
        )
        for rawURL in [
            "https://spott.jp/e/%2Fprivate",
            "https://spott.jp/e/private%2f",
            "https://spott.jp/e//private"
        ] {
            XCTAssertEqual(
                router.route(url: try XCTUnwrap(URL(string: rawURL))),
                .rejected,
                "encoded or empty path segments must never be normalized into a trusted route"
            )
        }
        XCTAssertEqual(
            router.route(
                url: try XCTUnwrap(URL(string: "spott://s/%20"))
            ),
            .rejected
        )
        XCTAssertTrue(AppTab.allCases.allSatisfy { router.path(for: $0).isEmpty })
    }

    func testMalformedAndExternalURLsDoNotMutateNavigation() async throws {
        let router = AppRouter()
        router.setPath([.notifications], for: .discovery)

        let externalOpened = await router.open(
            url: try XCTUnwrap(URL(string: "https://evil.example/e/private"))
        )
        let malformedOpened = await router.open(
            url: try XCTUnwrap(URL(string: "https://spott.jp/e/%20"))
        )
        XCTAssertFalse(externalOpened)
        XCTAssertFalse(malformedOpened)

        XCTAssertEqual(router.selectedTab, .discovery)
        XCTAssertEqual(router.path(for: .discovery), [.notifications])
    }

    func testAppModelAwaitableOpenReturnsOnlyAfterTheRouteMutationCompletes() async throws {
        let router = AppRouter()
        let model = makeAppModel(router: router)
        let eventURL = try XCTUnwrap(URL(string: "spott://e/summer-night"))

        let opened = try await model.openAndWait(url: eventURL)

        XCTAssertTrue(opened)
        XCTAssertEqual(router.selectedTab, .discovery)
        XCTAssertEqual(router.path(for: .discovery), [.event(.init(id: nil, slug: "summer-night"))])
        let rejected = try await model.openAndWait(
            url: XCTUnwrap(URL(string: "https://evil.example/e/summer-night"))
        )
        XCTAssertFalse(rejected)
    }

    func testAppModelAwaitableGroupResolutionUsesServerResultBeforeMutatingRoute() async throws {
        let router = AppRouter()
        let groupID = UUID(uuidString: "019b0000-0000-7000-8200-000000000601")!
        let model = makeAppModel(
            router: router,
            responses: [
                "/v1/groups/tokyo-weekend": .json(
                    #"{"id":"019b0000-0000-7000-8200-000000000601","ownerId":"019b0000-0000-7000-8200-000000000602","owner":{"id":"019b0000-0000-7000-8200-000000000602","name":"Hikari","handle":"hikari"},"name":"Tokyo Weekend","slug":"tokyo-weekend","description":"Walk together","joinMode":"open","regionId":"tokyo","categoryId":"city-walk","tags":["city-walk"],"rules":"Be kind","capacity":30,"memberCount":8,"status":"active","membershipStatus":null,"membershipRole":null,"viewerFollowing":false,"announcementSummary":[],"closingAt":null,"dissolveAfter":null,"availableActions":[],"version":1,"updatedAt":"2026-07-22T00:00:00Z"}"#
                )
            ]
        )

        let opened = try await model.openAndWait(
            url: XCTUnwrap(URL(string: "spott://g/tokyo-weekend"))
        )

        XCTAssertTrue(opened)
        XCTAssertEqual(router.selectedTab, .groups)
        XCTAssertEqual(router.path(for: .groups), [.group(groupID)])
        XCTAssertEqual(AppRouterURLProtocol.requestPaths(), ["/v1/groups/tokyo-weekend"])
    }

    func testAppModelAwaitableResolutionPropagatesFailureWithoutMutatingRoute() async throws {
        let router = AppRouter()
        router.setPath([.notifications], for: .discovery)
        let model = makeAppModel(
            router: router,
            responses: [
                "/v1/groups/missing-group": .json(
                    #"{"error":{"code":"GROUP_UNAVAILABLE","message":"Unavailable"}}"#,
                    statusCode: 503
                )
            ]
        )

        do {
            _ = try await model.openAndWait(
                url: XCTUnwrap(URL(string: "spott://g/missing-group"))
            )
            XCTFail("server failure must be propagated")
        } catch {
            XCTAssertTrue(router.path(for: .groups).isEmpty)
            XCTAssertEqual(router.selectedTab, .discovery)
            XCTAssertEqual(router.path(for: .discovery), [.notifications])
        }
    }

    func testAppModelAwaitableShareResolutionWaitsForServerAndRoutesItsResource() async throws {
        let router = AppRouter()
        let groupID = UUID(uuidString: "019b0000-0000-7000-8200-000000000611")!
        let model = makeAppModel(
            router: router,
            responses: [
                "/v1/shares/share-code": .json(
                    #"{"resourceType":"group","resourceId":"019b0000-0000-7000-8200-000000000611","canonicalPath":"/g/tokyo-weekend","sessionId":"019b0000-0000-7000-8300-000000000612"}"#
                )
            ]
        )

        let opened = try await model.openAndWait(
            url: XCTUnwrap(URL(string: "spott://s/share-code"))
        )

        XCTAssertTrue(opened)
        XCTAssertEqual(router.selectedTab, .groups)
        XCTAssertEqual(router.path(for: .groups), [.group(groupID)])
        XCTAssertEqual(AppRouterURLProtocol.requestPaths(), ["/v1/shares/share-code"])
    }

    func testAppModelAwaitableResolutionCancellationDoesNotMutateRoute() async throws {
        let router = AppRouter()
        router.setPath([.notifications], for: .discovery)
        let model = makeAppModel(
            router: router,
            responses: ["/v1/groups/slow-group": .pending()]
        )
        let resolution = Task { @MainActor in
            try await model.openAndWait(
                url: XCTUnwrap(URL(string: "spott://g/slow-group"))
            )
        }
        for _ in 0 ..< 200 {
            if !AppRouterURLProtocol.requestPaths().isEmpty { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertEqual(AppRouterURLProtocol.requestPaths(), ["/v1/groups/slow-group"])

        resolution.cancel()

        do {
            _ = try await resolution.value
            XCTFail("cancelled resolution must throw")
        } catch {
            XCTAssertTrue(error is CancellationError || (error as? URLError)?.code == .cancelled)
        }
        XCTAssertEqual(router.selectedTab, .discovery)
        XCTAssertEqual(router.path(for: .discovery), [.notifications])
        XCTAssertTrue(router.path(for: .groups).isEmpty)
    }

    func testGroupResponseBoundaryCancellationCannotMutateRoute() async throws {
        let router = AppRouter()
        router.setPath([.notifications], for: .discovery)
        let cancellation = AppRouterTaskCancellationLatch()
        let model = makeAppModel(
            router: router,
            responses: [
                "/v1/groups/cancel-after-response": .json(
                    #"{"id":"019b0000-0000-7000-8200-000000000621","ownerId":"019b0000-0000-7000-8200-000000000622","owner":{"id":"019b0000-0000-7000-8200-000000000622","name":"Hikari","handle":"hikari"},"name":"Cancelled Group","slug":"cancel-after-response","description":"Must not open","joinMode":"open","regionId":"tokyo","categoryId":"city-walk","tags":[],"rules":"Be kind","capacity":20,"memberCount":1,"status":"active","membershipStatus":null,"membershipRole":null,"viewerFollowing":false,"announcementSummary":[],"closingAt":null,"dissolveAfter":null,"availableActions":[],"version":1,"updatedAt":"2026-07-22T00:00:00Z"}"#,
                    onDelivered: { cancellation.cancel() }
                )
            ]
        )
        let resolution = Task { @MainActor in
            try await model.openAndWait(
                url: XCTUnwrap(URL(string: "spott://g/cancel-after-response"))
            )
        }
        cancellation.install(resolution)

        do {
            _ = try await resolution.value
            XCTFail("cancellation after response delivery must still win")
        } catch {
            XCTAssertTrue(error is CancellationError || (error as? URLError)?.code == .cancelled)
        }
        XCTAssertEqual(router.selectedTab, .discovery)
        XCTAssertEqual(router.path(for: .discovery), [.notifications])
        XCTAssertTrue(router.path(for: .groups).isEmpty)
    }

    func testShareEventResponseBoundaryCancellationCannotMutateRoute() async throws {
        let router = AppRouter()
        router.setPath([.notifications], for: .discovery)
        let cancellation = AppRouterTaskCancellationLatch()
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let eventData = try encoder.encode(firstEvent)
        let eventID = firstEvent.id.uuidString.lowercased()
        let model = makeAppModel(
            router: router,
            responses: [
                "/v1/shares/cancel-event": .json(
                    """
                    {"resourceType":"event","resourceId":"\(eventID)","canonicalPath":"/e/cancelled-event","sessionId":"019b0000-0000-7000-8300-000000000632"}
                    """
                ),
                "/v1/events/\(eventID)": .data(
                    eventData,
                    onDelivered: { cancellation.cancel() }
                )
            ]
        )
        let resolution = Task { @MainActor in
            try await model.openAndWait(
                url: XCTUnwrap(URL(string: "spott://s/cancel-event"))
            )
        }
        cancellation.install(resolution)

        do {
            _ = try await resolution.value
            XCTFail("share-event cancellation after event response must still win")
        } catch {
            XCTAssertTrue(error is CancellationError || (error as? URLError)?.code == .cancelled)
        }
        XCTAssertEqual(router.selectedTab, .discovery)
        XCTAssertEqual(router.path(for: .discovery), [.notifications])
    }

    func testShareResolutionBoundaryCancellationCannotMutateRoute() async throws {
        let router = AppRouter()
        router.setPath([.notifications], for: .discovery)
        let cancellation = AppRouterTaskCancellationLatch()
        let model = makeAppModel(
            router: router,
            responses: [
                "/v1/shares/cancel-share": .json(
                    #"{"resourceType":"group","resourceId":"019b0000-0000-7000-8200-000000000641","canonicalPath":"/g/cancelled-share","sessionId":"019b0000-0000-7000-8300-000000000642"}"#,
                    onDelivered: { cancellation.cancel() }
                )
            ]
        )
        let resolution = Task { @MainActor in
            try await model.openAndWait(
                url: XCTUnwrap(URL(string: "spott://s/cancel-share"))
            )
        }
        cancellation.install(resolution)

        do {
            _ = try await resolution.value
            XCTFail("share cancellation after response delivery must still win")
        } catch {
            XCTAssertTrue(error is CancellationError || (error as? URLError)?.code == .cancelled)
        }
        XCTAssertEqual(router.selectedTab, .discovery)
        XCTAssertEqual(router.path(for: .discovery), [.notifications])
        XCTAssertTrue(router.path(for: .groups).isEmpty)
    }

    func testDeferredRegistrationResumesExactlyOnceAfterMatchingGate() {
        let router = AppRouter()
        router.selectedTab = .activities
        router.setPath([.wallet, .event(.init(event: firstEvent))], for: .activities)
        let draft = DeferredRegistrationDraft(
            partySize: 3,
            joinWaitlistIfFull: true,
            answers: [UUID(uuidString: "019b0000-0000-7000-8100-000000000077")!: .text("Vegetarian")],
            attendeeNote: "Step-free access"
        )

        router.deferRegistration(
            for: firstEvent,
            action: .register,
            draft: draft,
            requiring: .login
        )

        XCTAssertNil(router.resumeDeferredIntent(after: .phoneVerification))
        let resumed = router.resumeDeferredIntent(after: .login)
        XCTAssertEqual(resumed?.draft, draft)
        XCTAssertEqual(resumed?.sourceTab, .activities)
        XCTAssertEqual(resumed?.sourcePath, [.wallet, .event(.init(event: firstEvent))])
        XCTAssertNil(router.resumeDeferredIntent(after: .login))
    }

    func testGateCancellationLeavesOriginalPathAndClearsIntent() {
        let router = AppRouter()
        router.selectedTab = .profile
        router.setPath([.settings, .event(.init(event: firstEvent))], for: .profile)
        router.deferRegistration(for: firstEvent, action: .joinWaitlist, requiring: .phoneVerification)

        router.cancelDeferredIntent()

        XCTAssertNil(router.deferredRegistrationIntent)
        XCTAssertNil(router.pendingRegistrationPresentation)
        XCTAssertEqual(router.selectedTab, .profile)
        XCTAssertEqual(router.path(for: .profile), [.settings, .event(.init(event: firstEvent))])
    }

    func testLoginCanAdvanceToPhoneGateWithoutLosingTheIntent() {
        let router = AppRouter()
        router.deferRegistration(for: firstEvent, action: .register, requiring: .login)

        router.transitionDeferredIntent(to: .phoneVerification)

        XCTAssertNil(router.resumeDeferredIntent(after: .login))
        XCTAssertNotNil(router.resumeDeferredIntent(after: .phoneVerification))
    }

    func testDeferredGroupJoinPreservesInviteAndResumesExactlyOnceAfterMatchingGate() {
        let router = AppRouter()
        let groupID = UUID(uuidString: "019b0000-0000-7000-8200-000000000091")!
        router.selectedTab = .groups
        router.setPath([.group(groupID)], for: .groups)

        router.deferGroupJoin(
            groupID: groupID,
            inviteCode: "  INVITE-42  ",
            requiring: .login
        )
        router.transitionDeferredIntent(to: .phoneVerification)

        XCTAssertNil(router.takeDeferredGroupJoinIntent(after: .login))
        let resumed = router.takeDeferredGroupJoinIntent(after: .phoneVerification)
        XCTAssertEqual(resumed?.groupID, groupID)
        XCTAssertEqual(resumed?.inviteCode, "INVITE-42")
        XCTAssertEqual(resumed?.sourceTab, .groups)
        XCTAssertEqual(resumed?.sourcePath, [.group(groupID)])
        XCTAssertNil(router.takeDeferredGroupJoinIntent(after: .phoneVerification))
    }

    func testNewestDestructiveIntentReplacesAnyPreviouslyDeferredAction() {
        let router = AppRouter()
        let groupID = UUID(uuidString: "019b0000-0000-7000-8200-000000000091")!

        router.deferRegistration(for: firstEvent, action: .register, requiring: .login)
        router.deferGroupJoin(groupID: groupID, inviteCode: nil, requiring: .login)

        XCTAssertNil(router.deferredRegistrationIntent)
        XCTAssertNotNil(router.deferredGroupJoinIntent)
        XCTAssertNil(router.pendingRegistrationPresentation)

        router.deferRegistration(for: firstEvent, action: .register, requiring: .login)

        XCTAssertNotNil(router.deferredRegistrationIntent)
        XCTAssertNil(router.deferredGroupJoinIntent)
    }

    func testPendingRegistrationPresentationCanOnlyBeTakenFromItsSourceTab() {
        let router = AppRouter()
        router.selectedTab = .activities
        router.setPath([.event(.init(event: firstEvent))], for: .activities)
        router.setPath([.event(.init(event: firstEvent))], for: .profile)
        router.deferRegistration(for: firstEvent, action: .register, requiring: .login)

        XCTAssertNotNil(router.resumeDeferredIntent(after: .login))

        XCTAssertNil(
            router.takeRegistrationPresentation(
                for: .init(event: firstEvent),
                in: .profile
            )
        )
        XCTAssertNotNil(router.pendingRegistrationPresentation)
        XCTAssertNotNil(
            router.takeRegistrationPresentation(
                for: .init(event: firstEvent),
                in: .activities
            )
        )
        XCTAssertNil(router.pendingRegistrationPresentation)
    }

    func testItineraryNavigationPreservesTheRegistrationToFocusUntilConsumed() {
        let router = AppRouter()
        let registrationID = UUID(
            uuidString: "019b0000-0000-7000-8100-000000000088"
        )!
        router.setPath([.event(.init(event: firstEvent))], for: .activities)
        router.setPath([.settings], for: .profile)

        router.showItinerary(registrationID: registrationID)

        XCTAssertEqual(router.selectedTab, .activities)
        XCTAssertTrue(router.path(for: .activities).isEmpty)
        XCTAssertEqual(router.path(for: .profile), [.settings])
        XCTAssertEqual(router.pendingItineraryRegistrationID, registrationID)
        XCTAssertFalse(router.completeItineraryFocus(UUID()))
        XCTAssertEqual(router.pendingItineraryRegistrationID, registrationID)
        XCTAssertTrue(router.completeItineraryFocus(registrationID))
        XCTAssertNil(router.pendingItineraryRegistrationID)
    }

    private func makeAppModel(router: AppRouter) -> AppModel {
        let persistence = PersistenceStore.makeInMemory()
        let api = SpottAPIClient(
            environment: .preview,
            credentials: CredentialVault(service: "jp.spott.tests.\(UUID().uuidString)"),
            usesCredentials: false
        )
        return AppModel(
            api: api,
            analytics: AnalyticsClient(environment: .preview),
            persistence: persistence,
            sync: SyncEngine(api: api, persistence: persistence),
            router: router
        )
    }

    private func makeAppModel(
        router: AppRouter,
        responses: [String: AppRouterURLProtocolResponse]
    ) -> AppModel {
        AppRouterURLProtocol.configure(responses: responses)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AppRouterURLProtocol.self]
        let persistence = PersistenceStore.makeInMemory()
        let api = SpottAPIClient(
            environment: .init(baseURL: URL(string: "https://api.spott.test/v1")!),
            credentials: CredentialVault(service: "jp.spott.tests.\(UUID().uuidString)"),
            session: URLSession(configuration: configuration),
            usesCredentials: false
        )
        return AppModel(
            api: api,
            analytics: AnalyticsClient(environment: .preview),
            persistence: persistence,
            sync: SyncEngine(api: api, persistence: persistence),
            router: router
        )
    }

    func testAccountResetClearsSensitivePathsAndRegistrationIntent() {
        let router = AppRouter()
        router.selectedTab = .profile
        router.setPath([.settings], for: .profile)
        router.deferRegistration(for: firstEvent, action: .register, requiring: .login)

        router.resetSensitiveNavigation()

        XCTAssertEqual(router.selectedTab, .discovery)
        XCTAssertTrue(AppTab.allCases.allSatisfy { router.path(for: $0).isEmpty })
        XCTAssertNil(router.deferredRegistrationIntent)
        XCTAssertNil(router.pendingRegistrationPresentation)
        XCTAssertNil(router.pendingItineraryRegistrationID)
    }

    func testPushDeepLinkExtractsServerDecidedURL() throws {
        let userInfo: [AnyHashable: Any] = [
            "aps": ["alert": ["title": "t", "body": "b"]],
            "spott": ["type": "event.cancelled", "deepLink": "spott://e/tokyo-picnic"],
        ]
        let url = try XCTUnwrap(pushDeepLink(from: userInfo))
        XCTAssertEqual(url, URL(string: "spott://e/tokyo-picnic"))

        // A tapped notification deep link routes through the same validated router path.
        let router = AppRouter()
        XCTAssertEqual(router.route(url: url), .opened)
        XCTAssertEqual(router.selectedTab, .discovery)
        XCTAssertEqual(router.path(for: .discovery), [.event(.init(id: nil, slug: "tokyo-picnic"))])
    }

    func testPushDeepLinkIgnoresPayloadsWithoutADeepLink() {
        XCTAssertNil(pushDeepLink(from: ["spott": ["type": "moderation.decided"]]))
        XCTAssertNil(pushDeepLink(from: ["aps": ["alert": "hi"]]))
        XCTAssertNil(pushDeepLink(from: ["spott": ["deepLink": ""]]))
    }

    func testPushDeepLinkBufferReturnsAndClears() {
        _ = PushDeepLinkBuffer.take()
        let url = URL(string: "spott://g/hikers")!
        PushDeepLinkBuffer.store(url)
        XCTAssertEqual(PushDeepLinkBuffer.take(), url)
        XCTAssertNil(PushDeepLinkBuffer.take())
    }
}

private struct AppRouterURLProtocolResponse: Sendable {
    let statusCode: Int
    let data: Data
    let completes: Bool
    let onDelivered: @Sendable () -> Void

    static func json(
        _ body: String,
        statusCode: Int = 200,
        onDelivered: @escaping @Sendable () -> Void = { }
    ) -> AppRouterURLProtocolResponse {
        .init(
            statusCode: statusCode,
            data: Data(body.utf8),
            completes: true,
            onDelivered: onDelivered
        )
    }

    static func data(
        _ data: Data,
        statusCode: Int = 200,
        onDelivered: @escaping @Sendable () -> Void = { }
    ) -> AppRouterURLProtocolResponse {
        .init(
            statusCode: statusCode,
            data: data,
            completes: true,
            onDelivered: onDelivered
        )
    }

    static func pending() -> AppRouterURLProtocolResponse {
        .init(statusCode: 200, data: Data(), completes: false, onDelivered: { })
    }
}

private final class AppRouterURLProtocolStorage: @unchecked Sendable {
    private let lock = NSLock()
    private var responses: [String: AppRouterURLProtocolResponse] = [:]
    private var paths: [String] = []

    func configure(responses: [String: AppRouterURLProtocolResponse]) {
        lock.withLock {
            self.responses = responses
            paths.removeAll()
        }
    }

    func response(for request: URLRequest) -> AppRouterURLProtocolResponse {
        lock.withLock {
            let path = request.url?.path ?? ""
            paths.append(path)
            return responses[path] ?? .json(
                #"{"error":{"code":"UNEXPECTED_REQUEST","message":"Unexpected request"}}"#,
                statusCode: 500
            )
        }
    }

    func requestPaths() -> [String] { lock.withLock { paths } }

    func reset() {
        lock.withLock {
            responses.removeAll()
            paths.removeAll()
        }
    }
}

private final class AppRouterURLProtocol: URLProtocol {
    private static let storage = AppRouterURLProtocolStorage()

    static func configure(responses: [String: AppRouterURLProtocolResponse]) {
        storage.configure(responses: responses)
    }

    static func requestPaths() -> [String] { storage.requestPaths() }

    static func reset() { storage.reset() }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let stub = Self.storage.response(for: request)
        guard stub.completes else { return }
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: stub.statusCode,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: stub.data)
        client?.urlProtocolDidFinishLoading(self)
        stub.onDelivered()
    }

    override func stopLoading() { }
}

private final class AppRouterTaskCancellationLatch: @unchecked Sendable {
    private let lock = NSLock()
    private var task: Task<Bool, Error>?
    private var cancellationRequested = false

    func install(_ task: Task<Bool, Error>) {
        let shouldCancel = lock.withLock {
            self.task = task
            return cancellationRequested
        }
        if shouldCancel { task.cancel() }
    }

    func cancel() {
        let task = lock.withLock {
            cancellationRequested = true
            return self.task
        }
        task?.cancel()
    }
}
