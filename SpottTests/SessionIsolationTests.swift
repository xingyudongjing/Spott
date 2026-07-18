import CryptoKit
import Foundation
import Security
import XCTest
@testable import Spott

@MainActor
final class SessionIsolationTests: XCTestCase {
    override func tearDown() {
        ControlledRefreshURLProtocol.reset()
        SessionBoundaryURLProtocol.reset()
        BootstrapURLProtocol.reset()
        OptionalAuthenticationURLProtocol.reset()
        UserDefaults.standard.removeObject(forKey: Self.syncOwnerKey)
        super.tearDown()
    }

    func testCredentialVaultDoesNotClearAReplacementSession() async throws {
        let vault = CredentialVault(service: "jp.spott.session-isolation.\(UUID().uuidString)")
        let first = Self.session(user: 1, session: 1)
        let replacement = Self.session(user: 2, session: 2)
        try await vault.save(session: first)
        try await vault.save(session: replacement)

        let cleared = try await vault.clear(expectedSessionID: first.sessionId)
        let storedSessionID = try await vault.session()?.sessionId

        XCTAssertFalse(cleared)
        XCTAssertEqual(storedSessionID, replacement.sessionId)
        _ = try await vault.clear(expectedSessionID: replacement.sessionId)
    }

    func testCredentialVaultCompareAndSwapDoesNotOverwriteAReplacementSession() async throws {
        let vault = CredentialVault(service: "jp.spott.session-cas.\(UUID().uuidString)")
        let first = Self.session(user: 1, session: 1)
        let replacement = Self.session(user: 2, session: 2)
        let refreshedFirst = Self.session(user: 1, session: 3)
        try await vault.save(session: first)
        try await vault.save(session: replacement)

        let replaced = try await vault.replace(
            session: refreshedFirst,
            expectedSessionID: first.sessionId
        )
        let storedSessionID = try await vault.session()?.sessionId

        XCTAssertFalse(replaced)
        XCTAssertEqual(storedSessionID, replacement.sessionId)
        _ = try await vault.clear(expectedSessionID: replacement.sessionId)
    }

    func testRefreshFlightsAreSessionKeyedAndLateAResponseCannotOverwriteB() async throws {
        let vault = CredentialVault(service: "jp.spott.refresh-cas.\(UUID().uuidString)")
        let first = Self.session(user: 1, session: 1)
        let replacement = Self.session(user: 2, session: 2)
        let refreshedFirst = Self.session(user: 1, session: 3)
        let refreshedReplacement = Self.session(user: 2, session: 4)
        try await vault.save(session: first)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ControlledRefreshURLProtocol.self]
        let client = SpottAPIClient(
            environment: .init(baseURL: URL(string: "https://api.spott.test/v1")!),
            credentials: vault,
            session: URLSession(configuration: configuration)
        )

        let firstStarted = expectation(description: "first refresh started")
        let replacementStarted = expectation(description: "replacement refresh started")
        ControlledRefreshURLProtocol.onStart = { requestNumber in
            if requestNumber == 1 { firstStarted.fulfill() }
            if requestNumber == 2 { replacementStarted.fulfill() }
        }

        let firstRefresh = Task { try await client.refreshCurrentSession() }
        await fulfillment(of: [firstStarted], timeout: 1)
        try await vault.save(session: replacement)
        let replacementRefresh = Task { try await client.refreshCurrentSession() }
        await fulfillment(of: [replacementStarted], timeout: 1)

        try ControlledRefreshURLProtocol.succeed(
            requestNumber: 2,
            session: refreshedReplacement
        )
        let replacementRefreshResult = try await replacementRefresh.value
        XCTAssertEqual(replacementRefreshResult.sessionId, refreshedReplacement.sessionId)
        try ControlledRefreshURLProtocol.succeed(
            requestNumber: 1,
            session: refreshedFirst
        )
        do {
            _ = try await firstRefresh.value
            XCTFail("A stale refresh must not succeed after account B becomes active")
        } catch is CancellationError {
            // Expected: the compare-and-swap rejected A's late response.
        }
        let storedSessionID = try await vault.session()?.sessionId
        XCTAssertEqual(storedSessionID, refreshedReplacement.sessionId)
        XCTAssertEqual(ControlledRefreshURLProtocol.requestNumbers(), [1, 2])
        _ = try await vault.clear(expectedSessionID: refreshedReplacement.sessionId)
    }

    func testAuthenticatedSuccessFromAIsRejectedAfterBBecomesActive() async throws {
        let vault = CredentialVault(service: "jp.spott.request-success-boundary.\(UUID().uuidString)")
        let first = Self.session(user: 1, session: 1)
        let replacement = Self.session(user: 2, session: 2)
        try await vault.save(session: first)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SessionBoundaryURLProtocol.self]
        let client = SpottAPIClient(
            environment: .init(baseURL: URL(string: "https://api.spott.test/v1")!),
            credentials: vault,
            session: URLSession(configuration: configuration)
        )
        let requestStarted = expectation(description: "A request started")
        SessionBoundaryURLProtocol.onStart = { _, requestNumber in
            if requestNumber == 1 { requestStarted.fulfill() }
        }

        let request = Task { try await client.discovery(.init(region: "tokyo")) }
        await fulfillment(of: [requestStarted], timeout: 1)
        try await vault.save(session: replacement)
        try SessionBoundaryURLProtocol.respond(
            requestNumber: 1,
            status: 200,
            data: Self.emptyDiscoveryPageData
        )

        do {
            _ = try await request.value
            XCTFail("A response must not cross into B's authenticated lifetime")
        } catch is CancellationError {
            // Expected: the authenticated request no longer belongs to the active account.
        }
        XCTAssertEqual(SessionBoundaryURLProtocol.requests().count, 1)
        let storedAfterSuccess = try await vault.session()
        XCTAssertEqual(storedAfterSuccess?.sessionId, replacement.sessionId)
        _ = try await vault.clear(expectedSessionID: replacement.sessionId)
    }

    func testAuthenticatedSuccessIsRejectedAfterSameUserStartsANewSession() async throws {
        let vault = CredentialVault(service: "jp.spott.request-same-user-boundary.\(UUID().uuidString)")
        let first = Self.session(user: 1, session: 1)
        let replacement = Self.session(user: 1, session: 2)
        try await vault.save(session: first)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SessionBoundaryURLProtocol.self]
        let client = SpottAPIClient(
            environment: .init(baseURL: URL(string: "https://api.spott.test/v1")!),
            credentials: vault,
            session: URLSession(configuration: configuration)
        )
        let requestStarted = expectation(description: "old session request started")
        SessionBoundaryURLProtocol.onStart = { _, requestNumber in
            if requestNumber == 1 { requestStarted.fulfill() }
        }

        let request = Task { try await client.discovery(.init(region: "tokyo")) }
        await fulfillment(of: [requestStarted], timeout: 1)
        try await vault.save(session: replacement)
        try SessionBoundaryURLProtocol.respond(
            requestNumber: 1,
            status: 200,
            data: Self.emptyDiscoveryPageData
        )

        do {
            _ = try await request.value
            XCTFail("A response from an earlier login epoch must be rejected")
        } catch is CancellationError {
            // Expected: a same-user login still establishes a new authentication boundary.
        }
        XCTAssertEqual(SessionBoundaryURLProtocol.requests().count, 1)
        _ = try await vault.clear(expectedSessionID: replacement.sessionId)
    }

    func testTransientFailureFromAIsNotRetriedAfterBBecomesActive() async throws {
        let vault = CredentialVault(service: "jp.spott.request-retry-boundary.\(UUID().uuidString)")
        let first = Self.session(user: 1, session: 1)
        let replacement = Self.session(user: 2, session: 2)
        try await vault.save(session: first)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SessionBoundaryURLProtocol.self]
        let client = SpottAPIClient(
            environment: .init(baseURL: URL(string: "https://api.spott.test/v1")!),
            credentials: vault,
            session: URLSession(configuration: configuration)
        )
        let requestStarted = expectation(description: "A request started")
        SessionBoundaryURLProtocol.onStart = { _, requestNumber in
            if requestNumber == 1 {
                requestStarted.fulfill()
            } else {
                try? SessionBoundaryURLProtocol.respond(
                    requestNumber: requestNumber,
                    status: 200,
                    data: Self.emptyDiscoveryPageData
                )
            }
        }

        let request = Task { try await client.discovery(.init(region: "tokyo")) }
        await fulfillment(of: [requestStarted], timeout: 1)
        try await vault.save(session: replacement)
        try SessionBoundaryURLProtocol.fail(
            requestNumber: 1,
            error: URLError(.timedOut)
        )

        do {
            _ = try await request.value
            XCTFail("A failed request must not retry after B becomes active")
        } catch is CancellationError {
            // Expected: the retry boundary detects the account transition.
        }
        XCTAssertEqual(SessionBoundaryURLProtocol.requests().count, 1)
        _ = try await vault.clear(expectedSessionID: replacement.sessionId)
    }

    func testA401NeverRefreshesOrRetriesWithB() async throws {
        let vault = CredentialVault(service: "jp.spott.request-401-boundary.\(UUID().uuidString)")
        let first = Self.session(user: 1, session: 1)
        let replacement = Self.session(user: 2, session: 2)
        let refreshedReplacement = Self.session(user: 2, session: 3)
        try await vault.save(session: first)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SessionBoundaryURLProtocol.self]
        let client = SpottAPIClient(
            environment: .init(baseURL: URL(string: "https://api.spott.test/v1")!),
            credentials: vault,
            session: URLSession(configuration: configuration)
        )
        let requestStarted = expectation(description: "A request started")
        let refreshedReplacementData = try Self.encodedSession(refreshedReplacement)
        SessionBoundaryURLProtocol.onStart = { _, requestNumber in
            switch requestNumber {
            case 1:
                requestStarted.fulfill()
            case 2:
                try? SessionBoundaryURLProtocol.respond(
                    requestNumber: requestNumber,
                    status: 200,
                    data: refreshedReplacementData
                )
            case 3:
                try? SessionBoundaryURLProtocol.respond(
                    requestNumber: requestNumber,
                    status: 200,
                    data: Self.emptyDiscoveryPageData
                )
            default:
                break
            }
        }

        let request = Task { try await client.discovery(.init(region: "tokyo")) }
        await fulfillment(of: [requestStarted], timeout: 1)
        try await vault.save(session: replacement)
        try SessionBoundaryURLProtocol.respond(
            requestNumber: 1,
            status: 401,
            data: Self.authenticationErrorData
        )

        do {
            _ = try await request.value
            XCTFail("A 401 must not refresh B and retry the stale A request")
        } catch is CancellationError {
            // Expected: account B is outside the request's authentication boundary.
        }
        XCTAssertEqual(SessionBoundaryURLProtocol.requests().count, 1)
        let storedAfter401 = try await vault.session()
        XCTAssertEqual(storedAfter401?.sessionId, replacement.sessionId)
        _ = try await vault.clear(expectedSessionID: replacement.sessionId)
    }

    func testA401NeverRetriesWithSameUsersReplacementSession() async throws {
        let vault = CredentialVault(service: "jp.spott.request-401-same-user-boundary.\(UUID().uuidString)")
        let first = Self.session(user: 1, session: 1)
        let replacement = Self.session(user: 1, session: 2)
        try await vault.save(session: first)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SessionBoundaryURLProtocol.self]
        let client = SpottAPIClient(
            environment: .init(baseURL: URL(string: "https://api.spott.test/v1")!),
            credentials: vault,
            session: URLSession(configuration: configuration)
        )
        let requestStarted = expectation(description: "old session request started")
        SessionBoundaryURLProtocol.onStart = { _, requestNumber in
            if requestNumber == 1 {
                requestStarted.fulfill()
            } else {
                try? SessionBoundaryURLProtocol.respond(
                    requestNumber: requestNumber,
                    status: 200,
                    data: Self.emptyDiscoveryPageData
                )
            }
        }

        let request = Task { try await client.discovery(.init(region: "tokyo")) }
        await fulfillment(of: [requestStarted], timeout: 1)
        try await vault.save(session: replacement)
        try SessionBoundaryURLProtocol.respond(
            requestNumber: 1,
            status: 401,
            data: Self.authenticationErrorData
        )

        do {
            _ = try await request.value
            XCTFail("A 401 from an earlier login epoch must not replay as the new session")
        } catch is CancellationError {
            // Expected.
        }
        XCTAssertEqual(SessionBoundaryURLProtocol.requests().count, 1)
        _ = try await vault.clear(expectedSessionID: replacement.sessionId)
    }

    func testCurrentSession401RefreshesAndRetriesWithinTheSameAuthBoundary() async throws {
        let vault = CredentialVault(service: "jp.spott.request-current-refresh.\(UUID().uuidString)")
        let current = Self.session(user: 1, session: 1)
        let refreshed = Self.session(user: 1, session: 3)
        let refreshedData = try Self.encodedSession(refreshed)
        try await vault.save(session: current)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SessionBoundaryURLProtocol.self]
        let client = SpottAPIClient(
            environment: .init(baseURL: URL(string: "https://api.spott.test/v1")!),
            credentials: vault,
            session: URLSession(configuration: configuration)
        )
        let requestStarted = expectation(description: "authenticated request started")
        SessionBoundaryURLProtocol.onStart = { _, requestNumber in
            switch requestNumber {
            case 1:
                requestStarted.fulfill()
            case 2:
                try? SessionBoundaryURLProtocol.respond(
                    requestNumber: requestNumber,
                    status: 200,
                    data: refreshedData
                )
            case 3:
                try? SessionBoundaryURLProtocol.respond(
                    requestNumber: requestNumber,
                    status: 200,
                    data: Self.emptyDiscoveryPageData
                )
            default:
                break
            }
        }

        let request = Task { try await client.discovery(.init(region: "tokyo")) }
        await fulfillment(of: [requestStarted], timeout: 1)
        try SessionBoundaryURLProtocol.respond(
            requestNumber: 1,
            status: 401,
            data: Self.authenticationErrorData
        )

        let page = try await request.value
        let requests = SessionBoundaryURLProtocol.requests()
        XCTAssertTrue(page.items.isEmpty)
        XCTAssertEqual(requests.count, 3)
        XCTAssertEqual(requests[0].value(forHTTPHeaderField: "Authorization"), "Bearer \(current.accessToken)")
        XCTAssertEqual(requests[2].value(forHTTPHeaderField: "Authorization"), "Bearer \(refreshed.accessToken)")
        let storedSessionID = try await vault.session()?.sessionId
        XCTAssertEqual(storedSessionID, refreshed.sessionId)
        _ = try await vault.clear(expectedSessionID: refreshed.sessionId)
    }

    func testTerminalRefresh401ClearsEverySensitiveAppBoundaryBeforeReturning() async throws {
        let current = Self.session(user: 1, session: 1)
        let vault = InMemoryCredentialStore(session: current)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SessionBoundaryURLProtocol.self]
        let api = SpottAPIClient(
            environment: .init(baseURL: URL(string: "https://api.spott.test/v1")!),
            credentials: vault,
            session: URLSession(configuration: configuration)
        )
        let persistence = PersistenceStore.makeInMemory()
        let discoveryService = BootstrapDiscoveryService(outcome: .success([]))
        let lifecycle = RecordingSyncLifecycle()
        let router = AppRouter()
        var sensitiveEvent = EventSummary.samples[0]
        sensitiveEvent.exactAddress = "participant-only exact address"
        router.show(event: sensitiveEvent, in: .activities)
        let reference = EventRouteReference(event: sensitiveEvent)
        let model = AppModel(
            api: api,
            analytics: AnalyticsClient(environment: .preview),
            persistence: persistence,
            sync: SyncEngine(api: api, persistence: persistence),
            router: router,
            syncLifecycle: lifecycle,
            discovery: DiscoveryStore(
                service: discoveryService,
                cache: persistence,
                debounce: .zero
            )
        )
        model.session = current
        SessionBoundaryURLProtocol.onStart = { _, requestNumber in
            switch requestNumber {
            case 1, 2:
                try? SessionBoundaryURLProtocol.respond(
                    requestNumber: requestNumber,
                    status: 401,
                    data: Self.authenticationErrorData
                )
            case 3:
                try? SessionBoundaryURLProtocol.respond(
                    requestNumber: requestNumber,
                    status: 200,
                    data: Self.emptyDiscoveryPageData
                )
            default:
                break
            }
        }

        do {
            _ = try await api.discovery(.init(region: "tokyo"))
            XCTFail("A terminal refresh failure must be surfaced")
        } catch let error as APIError {
            XCTAssertEqual(error.status, 401)
        }

        XCTAssertNil(model.session)
        XCTAssertEqual(model.presentedGate, .login)
        XCTAssertTrue(AppTab.allCases.allSatisfy { router.path(for: $0).isEmpty })
        XCTAssertNil(router.cachedEvent(for: reference))
        let expiredStoredSession = try await vault.session()
        let expirationDeactivationReasons = await lifecycle.deactivationReasons()
        XCTAssertNil(expiredStoredSession)
        XCTAssertEqual(expirationDeactivationReasons, [.sessionExpired])
    }

    func testTransientRefreshFailureRetriesWithoutClearingTheSession() async throws {
        let current = Self.session(user: 1, session: 1)
        let vault = InMemoryCredentialStore(session: current)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SessionBoundaryURLProtocol.self]
        let api = SpottAPIClient(
            environment: .init(baseURL: URL(string: "https://api.spott.test/v1")!),
            credentials: vault,
            session: URLSession(configuration: configuration)
        )
        let persistence = PersistenceStore.makeInMemory()
        let lifecycle = RecordingSyncLifecycle()
        let model = AppModel(
            api: api,
            analytics: AnalyticsClient(environment: .preview),
            persistence: persistence,
            sync: SyncEngine(api: api, persistence: persistence),
            router: AppRouter(),
            syncLifecycle: lifecycle
        )
        model.session = current
        SessionBoundaryURLProtocol.onStart = { _, requestNumber in
            if requestNumber == 1 {
                try? SessionBoundaryURLProtocol.respond(
                    requestNumber: requestNumber,
                    status: 401,
                    data: Self.authenticationErrorData
                )
            } else {
                try? SessionBoundaryURLProtocol.respond(
                    requestNumber: requestNumber,
                    status: 503,
                    data: Self.serviceUnavailableErrorData,
                    headerFields: ["Retry-After": "0"]
                )
            }
        }

        do {
            _ = try await api.discovery(.init(region: "tokyo"))
            XCTFail("The exhausted refresh failure must be surfaced")
        } catch let error as APIError {
            XCTAssertEqual(error.status, 503)
            XCTAssertTrue(error.retryable)
        }

        XCTAssertEqual(SessionBoundaryURLProtocol.requests().count, 4)
        XCTAssertEqual(model.session?.sessionId, current.sessionId)
        let transientStoredSessionID = try await vault.session()?.sessionId
        let transientDeactivationReasons = await lifecycle.deactivationReasons()
        XCTAssertEqual(transientStoredSessionID, current.sessionId)
        XCTAssertTrue(transientDeactivationReasons.isEmpty)
        _ = try await vault.clear(expectedSessionID: current.sessionId)
    }

    func testTerminalRefreshStillQuarantinesNavigationWhenScopeDeactivationFails() async throws {
        let current = Self.session(user: 1, session: 1)
        let credentials = InMemoryCredentialStore(session: current)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SessionBoundaryURLProtocol.self]
        let api = SpottAPIClient(
            environment: .init(baseURL: URL(string: "https://api.spott.test/v1")!),
            credentials: credentials,
            session: URLSession(configuration: configuration)
        )
        let lifecycle = FailingSyncLifecycle(failBootstrap: false, failDeactivate: true)
        let persistence = PersistenceStore.makeInMemory()
        let router = AppRouter()
        router.show(event: EventSummary.samples[0], in: .activities)
        let model = AppModel(
            api: api,
            analytics: AnalyticsClient(environment: .preview),
            persistence: persistence,
            sync: SyncEngine(api: api, persistence: persistence),
            router: router,
            syncLifecycle: lifecycle
        )
        model.session = current
        SessionBoundaryURLProtocol.onStart = { _, requestNumber in
            try? SessionBoundaryURLProtocol.respond(
                requestNumber: requestNumber,
                status: 401,
                data: Self.authenticationErrorData
            )
        }

        do {
            _ = try await api.discovery(.init(region: "tokyo"))
            XCTFail("A terminal refresh failure must be surfaced")
        } catch let error as APIError {
            XCTAssertEqual(error.status, 401)
        }

        let deactivationAttempts = await lifecycle.deactivationAttemptCount()
        XCTAssertEqual(deactivationAttempts, 1)
        XCTAssertNil(model.session)
        XCTAssertEqual(model.presentedGate, .login)
        XCTAssertTrue(AppTab.allCases.allSatisfy { router.path(for: $0).isEmpty })
        XCTAssertEqual(SessionBoundaryURLProtocol.requests().count, 2)
    }

    func testStaleAPostIsNeverRetriedAsB() async throws {
        let vault = CredentialVault(service: "jp.spott.request-post-boundary.\(UUID().uuidString)")
        let first = Self.session(user: 1, session: 1)
        let replacement = Self.session(user: 2, session: 2)
        let refreshedReplacement = Self.session(user: 2, session: 3)
        try await vault.save(session: first)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SessionBoundaryURLProtocol.self]
        let client = SpottAPIClient(
            environment: .init(baseURL: URL(string: "https://api.spott.test/v1")!),
            credentials: vault,
            session: URLSession(configuration: configuration)
        )
        let requestStarted = expectation(description: "A POST started")
        let refreshedReplacementData = try Self.encodedSession(refreshedReplacement)
        SessionBoundaryURLProtocol.onStart = { _, requestNumber in
            switch requestNumber {
            case 1:
                requestStarted.fulfill()
            case 2:
                try? SessionBoundaryURLProtocol.respond(
                    requestNumber: requestNumber,
                    status: 200,
                    data: refreshedReplacementData
                )
            case 3:
                try? SessionBoundaryURLProtocol.respond(
                    requestNumber: requestNumber,
                    status: 200,
                    data: Data("{}".utf8)
                )
            default:
                break
            }
        }

        let request = Task {
            try await client.registerPushDevice(
                token: "0123456789abcdef0123456789abcdef",
                environment: "sandbox"
            )
        }
        await fulfillment(of: [requestStarted], timeout: 1)
        try await vault.save(session: replacement)
        try SessionBoundaryURLProtocol.respond(
            requestNumber: 1,
            status: 401,
            data: Self.authenticationErrorData
        )

        do {
            _ = try await request.value
            XCTFail("A stale POST must not be replayed with B's credentials")
        } catch is CancellationError {
            // Expected: the account transition cancels the mutation.
        } catch {
            XCTFail("Expected cancellation, received \(error)")
        }
        let requests = SessionBoundaryURLProtocol.requests()
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.map(\.httpMethod), ["POST"])
        XCTAssertEqual(requests.first?.value(forHTTPHeaderField: "Authorization"), "Bearer \(first.accessToken)")
        let storedAfterPost = try await vault.session()
        XCTAssertEqual(storedAfterPost?.sessionId, replacement.sessionId)
        _ = try await vault.clear(expectedSessionID: replacement.sessionId)
    }

    func testStaleRemoteSignOutCannotReplaceANewerAuthenticatedSession() async throws {
        let sessionEnder = ControlledSessionEnder()
        let syncLifecycle = RecordingSyncLifecycle()
        let model = Self.model(sessionEnder: sessionEnder, syncLifecycle: syncLifecycle)
        let first = Self.session(user: 1, session: 1)
        let replacement = Self.session(user: 2, session: 2)
        model.session = first

        model.signOut()
        await sessionEnder.waitUntilStarted()
        model.didAuthenticate(replacement)
        await syncLifecycle.waitForBootstrap(userID: replacement.user.id)
        await sessionEnder.finish()
        await Task.yield()
        let expectedSessionIDs = await sessionEnder.expectedSessionIDs()
        let deactivationReasons = await syncLifecycle.deactivationReasons()

        XCTAssertEqual(model.session?.sessionId, replacement.sessionId)
        XCTAssertEqual(expectedSessionIDs, [first.sessionId])
        XCTAssertEqual(deactivationReasons, [.signOut])
    }

    func testAppModelSignOutAndExpirationNeverInvokeDestructivePersistenceReset() async throws {
        let expirationBoundary = AuthenticationExpirationBoundary()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [BootstrapURLProtocol.self]
        let api = SpottAPIClient(
            environment: .init(baseURL: URL(string: "https://api.spott.test/v1")!),
            credentials: InMemoryCredentialStore(session: nil),
            session: URLSession(configuration: configuration),
            authenticationExpirationBoundary: expirationBoundary
        )
        let persistenceSpy = DestructivePersistenceResetSpy()
        let discoveryService = BootstrapDiscoveryService(outcome: .success([]))
        let syncPersistence = RecordingSyncPersistence()
        let syncLifecycle = RecordingSyncLifecycle()
        let model = AppModel(
            api: api,
            analytics: AnalyticsClient(environment: .preview),
            persistence: persistenceSpy,
            sync: SyncEngine(api: api, persistence: syncPersistence),
            router: AppRouter(),
            sessionEnder: ImmediateSessionEnder(),
            syncLifecycle: syncLifecycle,
            discovery: DiscoveryStore(
                service: discoveryService,
                cache: persistenceSpy,
                debounce: .zero
            )
        )
        let signedOutSession = Self.session(user: 31, session: 31)
        let expiredSession = Self.session(user: 32, session: 32)

        model.session = signedOutSession
        model.signOut()
        await persistenceSpy.waitForCacheReplacement(count: 1)

        model.session = expiredSession
        await expirationBoundary.expire(sessionID: expiredSession.sessionId)
        await persistenceSpy.waitForCacheReplacement(count: 2)

        let destructiveInvocationCount = await persistenceSpy.destructiveInvocationCount()
        let deactivationReasons = await syncLifecycle.deactivationReasons()
        XCTAssertEqual(destructiveInvocationCount, 0)
        XCTAssertEqual(deactivationReasons, [.signOut, .sessionExpired])
        XCTAssertNil(model.session)
        XCTAssertEqual(model.presentedGate, .login)
    }

    func testNewSyncGenerationRejectsALateResponseFromThePreviousAccount() async throws {
        let api = ControlledSyncAPI()
        let persistence = RecordingSyncPersistence()
        let engine = SyncEngine(api: api, persistence: persistence)
        let firstUser = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
        let replacementUser = UUID(uuidString: "00000000-0000-0000-0000-000000000002")!

        let first = Task { try? await engine.bootstrap(userID: firstUser, generation: 1) }
        await api.waitUntilFirstPullStarted()
        let replacement = Task {
            try? await engine.deactivateScope(reason: .accountChanged, generation: 2)
            try? await engine.bootstrap(userID: replacementUser, generation: 2)
        }
        await api.waitUntilFirstPullCancellationObserved()
        await api.finishFirstPull()
        await api.waitUntilSecondPullFinished()
        _ = await first.value
        _ = await replacement.value

        let applications = await persistence.applications()
        XCTAssertEqual(applications.map(\.scope), [replacementUser.uuidString.lowercased()])

        try await engine.deactivateScope(reason: .signOut, generation: 1)
        let retainedApplications = await persistence.applications()
        XCTAssertEqual(retainedApplications.map(\.scope), [replacementUser.uuidString.lowercased()])
    }

    func testAccountSwitchResetsTheRealtimeHintSequence() async throws {
        let api = CountingSyncAPI()
        let persistence = RecordingSyncPersistence()
        let engine = SyncEngine(api: api, persistence: persistence)
        let firstUser = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
        let replacementUser = UUID(uuidString: "00000000-0000-0000-0000-000000000002")!

        try await engine.bootstrap(userID: firstUser, generation: 1)
        await engine.handleRealtimeHint(sequence: 100)
        try await engine.deactivateScope(reason: .accountChanged, generation: 2)
        try await engine.bootstrap(userID: replacementUser, generation: 2)
        await engine.handleRealtimeHint(sequence: 1)

        let pullCount = await api.pullCount()
        XCTAssertEqual(pullCount, 4)
    }

    func testColdStartRestoresSessionIntoItsUserSyncScope() async throws {
        let restored = Self.session(user: 7, session: 7)
        let vault = CredentialVault(service: "jp.spott.bootstrap-session.\(UUID().uuidString)")
        try await vault.save(session: restored)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [BootstrapURLProtocol.self]
        let api = SpottAPIClient(
            environment: .init(baseURL: URL(string: "https://api.spott.test/v1")!),
            credentials: vault,
            session: URLSession(configuration: configuration)
        )
        let persistence = PersistenceStore.makeInMemory()
        let syncLifecycle = RecordingSyncLifecycle()
        let model = AppModel(
            api: api,
            analytics: AnalyticsClient(environment: .preview),
            persistence: persistence,
            sync: SyncEngine(api: api, persistence: persistence),
            router: AppRouter(),
            syncLifecycle: syncLifecycle
        )

        await model.bootstrap()
        let bootstrapUserIDs = await syncLifecycle.bootstrapUserIDs()

        XCTAssertEqual(model.session?.sessionId, restored.sessionId)
        XCTAssertEqual(bootstrapUserIDs, [restored.user.id])
        _ = try await vault.clear(expectedSessionID: restored.sessionId)
    }

    func testMissingEntitlementIsNotReportedAsANetworkFailure() {
        let mapped = AppModel.map(VaultError.status(errSecMissingEntitlement))

        XCTAssertEqual(mapped.id, "SECURE_SESSION_UNAVAILABLE")
        XCTAssertNotEqual(mapped.id, "NETWORK_UNAVAILABLE")
        XCTAssertTrue(mapped.retryable)
    }

    func testSecureSessionMessagesRemainStableKeysAcrossAppLocales() throws {
        let unavailable = AppModel.map(VaultError.status(errSecMissingEntitlement))
        let invalid = AppModel.map(VaultError.invalidSession)

        XCTAssertEqual(unavailable.message, Self.secureSessionUnavailableMessageKey)
        XCTAssertEqual(invalid.message, Self.secureSessionInvalidMessageKey)

        let expectations: [(AppLanguage, String, String)] = [
            (
                .simplifiedChinese,
                "无法读取此设备上的登录信息。你仍可浏览公开活动，请稍后重试。",
                "此设备上的登录信息已失效。你仍可浏览公开活动，请重新登录。"
            ),
            (
                .japanese,
                "このデバイスのログイン情報を読み込めません。公開イベントは引き続き閲覧できます。しばらくしてからもう一度お試しください。",
                "このデバイスのログイン情報は無効になりました。公開イベントは引き続き閲覧できます。もう一度ログインしてください。"
            ),
            (
                .english,
                "Unable to read sign-in information on this device. You can still browse public events. Try again later.",
                "Sign-in information on this device is no longer valid. You can still browse public events. Sign in again."
            ),
        ]

        for (language, unavailableMessage, invalidMessage) in expectations {
            XCTAssertEqual(
                try Self.localizedAppString(unavailable.message, language: language),
                unavailableMessage,
                "The stable key must resolve using the in-app \(language.rawValue) locale"
            )
            XCTAssertEqual(
                try Self.localizedAppString(invalid.message, language: language),
                invalidMessage,
                "The stable key must resolve using the in-app \(language.rawValue) locale"
            )
        }
    }

    func testMalformedKeychainSessionIsReportedAsInvalidSecureSession() async throws {
        let service = "jp.spott.malformed-session.\(UUID().uuidString)"
        let account = "active-session"
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        var insert = query
        insert[kSecValueData as String] = Data("not-a-user-session".utf8)
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemDelete(query as CFDictionary)
        let insertStatus = SecItemAdd(insert as CFDictionary, nil)
        try XCTSkipIf(
            insertStatus == errSecMissingEntitlement,
            "The test runner does not have a Keychain entitlement"
        )
        XCTAssertEqual(insertStatus, errSecSuccess)
        defer { SecItemDelete(query as CFDictionary) }

        do {
            _ = try await CredentialVault(service: service).session()
            XCTFail("Malformed session bytes must not restore a signed-in user")
        } catch {
            let mapped = AppModel.map(error)
            XCTAssertEqual(mapped.id, "SECURE_SESSION_INVALID")
            XCTAssertNotEqual(mapped.id, "NETWORK_UNAVAILABLE")
            XCTAssertFalse(mapped.retryable)
        }
    }

    func testMissingKeychainItemRestoresAnonymousState() async throws {
        let service = "jp.spott.missing-session.\(UUID().uuidString)"
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "active-session"
        ]
        SecItemDelete(query as CFDictionary)

        let restored = try await CredentialVault(service: service).session()

        XCTAssertNil(restored)
    }

    func testMissingEntitlementFallsBackToTheAnonymousPublicDiscoveryFeed() async throws {
        try await assertVaultFailureFallsBackToAnonymousDiscovery(
            .status(errSecMissingEntitlement)
        )
    }

    func testMalformedSessionFallsBackToTheAnonymousPublicDiscoveryFeed() async throws {
        try await assertVaultFailureFallsBackToAnonymousDiscovery(.invalidSession)
    }

    func testPublicSearchFallsBackToAnonymousWhenTheVaultCannotBeRead() async throws {
        try OptionalAuthenticationURLProtocol.configure(
            feedData: Self.discoveryFeedData(),
            searchData: Self.discoveryPageData()
        )
        let credentials = ThrowingCredentialStore(
            failure: .status(errSecMissingEntitlement)
        )
        let client = Self.optionalAuthenticationClient(credentials: credentials)

        let page = try await client.discovery(.init(q: "night walk", region: "tokyo"))
        let requests = OptionalAuthenticationURLProtocol.requests()
        XCTAssertEqual(requests.count, 1)
        let request = try XCTUnwrap(requests.first)

        XCTAssertEqual(page.items.map(\.id), [EventSummary.samples[0].id])
        XCTAssertEqual(request.url?.path, "/v1/events/search")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
    }

    func testReadableSessionPreservesBearerAndViewerFactsInThePublicFeed() async throws {
        try OptionalAuthenticationURLProtocol.configure(
            feedData: Self.discoveryFeedData(personalized: true),
            searchData: Self.discoveryPageData()
        )
        let authenticated = Self.session(user: 41, session: 41)
        let credentials = InMemoryCredentialStore(session: authenticated)
        let client = Self.optionalAuthenticationClient(credentials: credentials)

        let feed = try await client.discoveryFeed(.init(region: "tokyo"))
        let requests = OptionalAuthenticationURLProtocol.requests()
        XCTAssertEqual(requests.count, 1)
        let request = try XCTUnwrap(requests.first)
        let event = try XCTUnwrap(feed.modules.first?.items.first?.event)

        XCTAssertEqual(
            request.value(forHTTPHeaderField: "Authorization"),
            "Bearer \(authenticated.accessToken)"
        )
        XCTAssertTrue(event.favorited)
        XCTAssertEqual(event.viewerRegistration?.status, .confirmed)
        XCTAssertTrue(event.organizer.viewerFollowing)
    }

    func testReadableSessionPreservesRefreshForThePublicFeed() async throws {
        let authenticated = Self.session(user: 42, session: 42)
        let refreshed = Self.session(user: 42, session: 43)
        try OptionalAuthenticationURLProtocol.configureRefresh(
            feedData: Self.discoveryFeedData(personalized: true),
            searchData: Self.discoveryPageData(),
            refreshedSessionData: try Self.encodedSession(refreshed)
        )
        let credentials = InMemoryCredentialStore(session: authenticated)
        let client = Self.optionalAuthenticationClient(credentials: credentials)

        let feed = try await client.discoveryFeed(.init(region: "tokyo"))
        let requests = OptionalAuthenticationURLProtocol.requests()
        let storedSession = try await credentials.session()

        XCTAssertEqual(feed.modules.first?.items.first?.event.id, EventSummary.samples[0].id)
        XCTAssertEqual(
            requests.compactMap { $0.url?.path },
            ["/v1/discovery/feed", "/v1/auth/refresh", "/v1/discovery/feed"]
        )
        XCTAssertEqual(
            requests.first?.value(forHTTPHeaderField: "Authorization"),
            "Bearer \(authenticated.accessToken)"
        )
        XCTAssertNil(requests.dropFirst().first?.value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(
            requests.last?.value(forHTTPHeaderField: "Authorization"),
            "Bearer \(refreshed.accessToken)"
        )
        XCTAssertEqual(storedSession?.sessionId, refreshed.sessionId)
    }

    func testPublicFeedDoesNotSwallowANonVaultCredentialFailure() async throws {
        try OptionalAuthenticationURLProtocol.configure(
            feedData: Self.discoveryFeedData(),
            searchData: Self.discoveryPageData()
        )
        let credentials = CredentialProbeFailureStore(failure: .nonVault)
        let client = Self.optionalAuthenticationClient(credentials: credentials)

        do {
            _ = try await client.discoveryFeed(.init(region: "tokyo"))
            XCTFail("Optional authentication may only recover from VaultError")
        } catch CredentialProbeError.injected {
            // Expected.
        } catch {
            XCTFail("Expected the original non-Vault failure, received \(error)")
        }

        XCTAssertTrue(OptionalAuthenticationURLProtocol.requests().isEmpty)
    }

    func testPublicFeedDoesNotSwallowCredentialCancellation() async throws {
        try OptionalAuthenticationURLProtocol.configure(
            feedData: Self.discoveryFeedData(),
            searchData: Self.discoveryPageData()
        )
        let credentials = CredentialProbeFailureStore(failure: .cancellation)
        let client = Self.optionalAuthenticationClient(credentials: credentials)

        do {
            _ = try await client.discoveryFeed(.init(region: "tokyo"))
            XCTFail("Credential cancellation must remain cancellation")
        } catch is CancellationError {
            // Expected.
        } catch {
            XCTFail("Expected CancellationError, received \(error)")
        }

        XCTAssertTrue(OptionalAuthenticationURLProtocol.requests().isEmpty)
    }

    func testAuthenticatedWriteDoesNotFallBackToAnonymousWhenTheVaultCannotBeRead() async throws {
        try OptionalAuthenticationURLProtocol.configure(
            feedData: Self.discoveryFeedData(),
            searchData: Self.discoveryPageData()
        )
        let credentials = ThrowingCredentialStore(
            failure: .status(errSecMissingEntitlement)
        )
        let client = Self.optionalAuthenticationClient(credentials: credentials)

        do {
            try await client.markNotificationRead(UUID())
            XCTFail("Authenticated writes must fail closed when secure credentials are unavailable")
        } catch VaultError.status(let status) {
            XCTAssertEqual(status, errSecMissingEntitlement)
        } catch {
            XCTFail("Expected the original VaultError, received \(error)")
        }

        XCTAssertTrue(
            OptionalAuthenticationURLProtocol.requests().isEmpty,
            "A write must never be retried anonymously"
        )
    }

    func testSessionVaultFailureLeavesExplicitDiscoveryErrorInsteadOfInitialSkeleton() async {
        let discoveryService = BootstrapDiscoveryService(outcome: .offline)
        let model = Self.publicBootstrapModel(
            sessionRestorer: FailingVaultSessionRestorer(failure: .missingEntitlement),
            discoveryService: discoveryService
        )

        await model.bootstrap()
        let requestCount = await discoveryService.requestCount()

        XCTAssertNil(model.session)
        XCTAssertEqual(model.discovery.phase, .error)
        XCTAssertNotNil(model.discovery.fatalError)
        XCTAssertEqual(requestCount, 1)
    }

    func testAccountASignOutThenBThenAReturnPreservesAQueueBytesExactly() async throws {
        let api = NonAcknowledgingSyncAPI()
        let persistence = RecordingSyncPersistence()
        let firstUser = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
        let replacementUser = UUID(uuidString: "00000000-0000-0000-0000-000000000002")!
        let engine = SyncEngine(api: api, persistence: persistence)

        try await engine.bootstrap(userID: firstUser, generation: 1)
        let operation = PendingOperation(
            operationID: UUID(),
            entityType: "registration",
            entityID: UUID(),
            action: "cancel",
            baseVersion: 1,
            payload: Data([0x00, 0x7f, 0xff, 0x42]),
            dependencies: [UUID()]
        )
        try await engine.enqueue(operation)
        let ownerA = firstUser.uuidString.lowercased()
        let before = try await persistence.allOperations(ownerScope: ownerA)

        try await engine.deactivateScope(reason: .signOut, generation: 2)
        try await engine.bootstrap(userID: replacementUser, generation: 2)
        let pushedBeforeAReturn = await api.pushedOperationIDs()
        try await engine.deactivateScope(reason: .signOut, generation: 3)
        try await engine.bootstrap(userID: firstUser, generation: 3)

        let after = try await persistence.allOperations(ownerScope: ownerA)
        let ownerAPending = try await persistence.pendingOperations(ownerScope: ownerA)
        let ownerBPending = try await persistence.pendingOperations(
            ownerScope: replacementUser.uuidString.lowercased()
        )
        XCTAssertTrue(pushedBeforeAReturn.isEmpty, "B must never push A's operation")
        XCTAssertEqual(after, before)
        XCTAssertEqual(ownerAPending, [operation])
        XCTAssertTrue(ownerBPending.isEmpty)
    }

    func testMissingOwnerScopeBlocksBootstrapWithoutMutatingLegacyRows() async throws {
        let api = CountingSyncAPI()
        let persistence = RecordingSyncPersistence(hasUnownedLegacyRows: true)
        let user = UUID(uuidString: "00000000-0000-0000-0000-000000000009")!
        let engine = SyncEngine(api: api, persistence: persistence)

        do {
            try await engine.bootstrap(userID: user, generation: 1)
            XCTFail("Unresolved legacy ownership must block before sync starts")
        } catch PersistenceOwnershipError.unresolvedLegacyOwner {
            // Expected.
        }

        let writeCount = await persistence.writeCount()
        let pushedOperationIDs = await api.pushedOperationIDs()
        XCTAssertEqual(writeCount, 0)
        XCTAssertTrue(pushedOperationIDs.isEmpty)
    }

    func testSignOutDeactivatesScopeWithoutDeletingOrRewritingOwnerRows() async throws {
        let api = NonAcknowledgingSyncAPI()
        let persistence = RecordingSyncPersistence()
        let engine = SyncEngine(api: api, persistence: persistence)
        let owner = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
        let operation = PendingOperation(
            operationID: UUID(),
            entityType: "event",
            entityID: UUID(),
            action: "update",
            baseVersion: 2,
            payload: Data([0xde, 0xad, 0xbe, 0xef]),
            dependencies: []
        )

        try await engine.bootstrap(userID: owner, generation: 1)
        try await engine.enqueue(operation)
        let scope = owner.uuidString.lowercased()
        let before = try await persistence.allOperations(ownerScope: scope)
        let writesBefore = await persistence.writeCount()

        try await engine.deactivateScope(reason: .signOut, generation: 2)

        let after = try await persistence.allOperations(ownerScope: scope)
        let writesAfter = await persistence.writeCount()
        XCTAssertEqual(after, before)
        XCTAssertEqual(writesAfter, writesBefore)
    }

    func testSessionExpiryDeactivatesScopeWithoutDeletingOrRewritingOwnerRows() async throws {
        let api = NonAcknowledgingSyncAPI()
        let authority = OwnerWriteLeaseAuthority()
        let persistence = PersistenceStore.makeInMemory(
            ownerWriteLeaseAuthority: authority
        )
        let engine = SyncEngine(api: api, persistence: persistence)
        let owner = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
        let scope = owner.uuidString.lowercased()
        let operation = PendingOperation(
            operationID: UUID(),
            entityType: "event",
            entityID: UUID(),
            action: "update",
            baseVersion: 2,
            payload: Data([0x00, 0xde, 0xad, 0xff]),
            dependencies: [UUID()]
        )
        let draft = LocalEventDraftSnapshot(
            localID: UUID(),
            serverID: UUID(),
            title: "expiry must preserve",
            payload: Data([0xff, 0x00, 0x7f]),
            draftRevision: 4,
            serverVersion: 2,
            updatedAt: Date(timeIntervalSince1970: 1_700_000_123)
        )

        try await engine.bootstrap(userID: owner, generation: 1)
        try await engine.enqueue(operation)
        let lease = try authority.activate(ownerScope: scope, generation: 1)
        try await persistence.upsertDraft(draft, ownerScope: scope, lease: lease)
        let operationsBefore = try await persistence.allOperations(ownerScope: scope)
        let draftsBefore = try await persistence.drafts(ownerScope: scope)

        try await engine.deactivateScope(reason: .sessionExpired, generation: 2)

        let operationsAfter = try await persistence.allOperations(ownerScope: scope)
        let draftsAfter = try await persistence.drafts(ownerScope: scope)
        XCTAssertEqual(operationsAfter, operationsBefore)
        XCTAssertEqual(draftsAfter, draftsBefore)
    }

    func testAccountASignOutThenBThenAReturnPreservesAQueueAndDraftDigestAndBytesExactly() async throws {
        let syncAPI = AccountTransitionSyncAPI()
        let syncPersistence = RecordingSyncPersistence()
        let authority = syncPersistence.ownerWriteLeaseAuthority
        let persistence = PersistenceStore.makeInMemory(
            ownerWriteLeaseAuthority: authority
        )
        let sync = SyncEngine(api: syncAPI, persistence: syncPersistence)
        let lifecycle = ObservedSyncLifecycle(engine: sync)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [BootstrapURLProtocol.self]
        let api = SpottAPIClient(
            environment: .preview,
            credentials: CredentialVault(service: "jp.spott.owner-transition.\(UUID().uuidString)"),
            session: URLSession(configuration: configuration)
        )
        let model = AppModel(
            api: api,
            analytics: AnalyticsClient(environment: .preview),
            persistence: persistence,
            sync: sync,
            router: AppRouter(),
            sessionEnder: ImmediateSessionEnder(),
            syncLifecycle: lifecycle,
            ownerWriteLeaseAuthority: authority
        )
        let sessionA = Self.session(user: 1, session: 1)
        let sessionB = Self.session(user: 2, session: 2)
        let ownerA = sessionA.user.id.uuidString.lowercased()
        let ownerB = sessionB.user.id.uuidString.lowercased()

        model.didAuthenticate(sessionA)
        await lifecycle.waitForBootstrap(userID: sessionA.user.id, count: 1)
        let operation = PendingOperation(
            operationID: UUID(),
            entityType: "registration",
            entityID: UUID(),
            action: "cancel",
            baseVersion: 9,
            payload: Data([0x00, 0x7f, 0x80, 0xff, 0x42]),
            dependencies: [UUID(), UUID()]
        )
        let draft = LocalEventDraftSnapshot(
            localID: UUID(),
            serverID: UUID(),
            title: "A exact-byte draft",
            payload: Data([0xff, 0x00, 0x01, 0x7f, 0x80]),
            draftRevision: 11,
            serverVersion: 8,
            updatedAt: Date(timeIntervalSince1970: 1_700_000_456.789)
        )
        try await sync.enqueue(operation)
        let leaseA = try authority.activate(ownerScope: ownerA, generation: 1)
        try await persistence.upsertDraft(draft, ownerScope: ownerA, lease: leaseA)
        let before = try await SessionIsolationOwnerDataCapture.capture(
            ownerScope: ownerA,
            syncPersistence: syncPersistence,
            draftPersistence: persistence
        )
        await syncPersistence.resetMutationCount(ownerScope: ownerA)

        model.signOut()
        await lifecycle.waitForDeactivation(count: 1)
        model.didAuthenticate(sessionB)
        await lifecycle.waitForBootstrap(userID: sessionB.user.id, count: 1)
        let ownerBPending = try await syncPersistence.pendingOperations(ownerScope: ownerB)
        let pushedBeforeAReturn = await syncAPI.pushedOperationIDs()
        XCTAssertTrue(ownerBPending.isEmpty)
        XCTAssertTrue(pushedBeforeAReturn.isEmpty)

        model.signOut()
        await lifecycle.waitForDeactivation(count: 2)
        model.didAuthenticate(sessionA)
        await syncAPI.waitUntilPullStarted(number: 3)

        let after = try await SessionIsolationOwnerDataCapture.capture(
            ownerScope: ownerA,
            syncPersistence: syncPersistence,
            draftPersistence: persistence
        )
        let ownerAMutationCount = await syncPersistence.mutationCount(ownerScope: ownerA)
        XCTAssertEqual(after.canonicalDigest, before.canonicalDigest)
        XCTAssertEqual(after.operations, before.operations)
        XCTAssertEqual(after.drafts, before.drafts)
        XCTAssertEqual(ownerAMutationCount, 0)

        await syncAPI.finishPull(number: 3)
        await lifecycle.waitForBootstrap(userID: sessionA.user.id, count: 2)
        let lifecycleFailed = await lifecycle.didFail()
        XCTAssertFalse(lifecycleFailed)
    }

    func testInFlightPushCannotMarkAppliedAfterScopeDeactivationBegins() async throws {
        let api = ControlledPushSyncAPI()
        let persistence = RecordingSyncPersistence()
        let engine = SyncEngine(api: api, persistence: persistence)
        let owner = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
        let scope = owner.uuidString.lowercased()
        let operation = PendingOperation(
            operationID: UUID(),
            entityType: "registration",
            entityID: UUID(),
            action: "cancel",
            baseVersion: 3,
            payload: Data("must-remain-pending".utf8),
            dependencies: []
        )
        try await engine.bootstrap(userID: owner, generation: 1)
        try await engine.enqueue(operation)

        let flushTask = Task { await engine.flushPendingOperations() }
        await api.waitUntilPushStarted()
        let deactivationCompletion = SessionIsolationCompletionFlag()
        let deactivationTask = Task {
            do {
                try await engine.deactivateScope(reason: .signOut, generation: 2)
                await deactivationCompletion.finish(failed: false)
            } catch {
                await deactivationCompletion.finish(failed: true)
            }
        }

        for _ in 0..<100 {
            let cancellationObserved = await api.wasCancellationObserved()
            let deactivationFinished = await deactivationCompletion.isFinished()
            if cancellationObserved || deactivationFinished {
                break
            }
            await Task.yield()
        }

        let cancellationObserved = await api.wasCancellationObserved()
        let deactivationFinishedEarly = await deactivationCompletion.isFinished()
        XCTAssertTrue(
            cancellationObserved,
            "Scope deactivation must cancel the owner-bound push task"
        )
        XCTAssertFalse(
            deactivationFinishedEarly,
            "Deactivation must wait for cancelled network work to quiesce"
        )

        await api.finishPushWithAppliedAcknowledgement()
        await deactivationTask.value
        _ = await flushTask.value

        let deactivationFailed = await deactivationCompletion.didFail()
        let pending = try await persistence.pendingOperations(ownerScope: scope)
        XCTAssertFalse(deactivationFailed)
        XCTAssertEqual(pending, [operation])
    }

    func testDeactivateScopeWaitsForCursorBoundaryBeforeNetworkStarts() async throws {
        try await assertDeactivationWaitsForPersistenceBoundary(.cursor)
    }

    func testDeactivateScopeWaitsForApplyBoundaryAfterNetworkFinishes() async throws {
        try await assertDeactivationWaitsForPersistenceBoundary(.apply)
    }

    func testDeactivateScopeWaitsForPendingOperationsBoundaryBeforePushStarts() async throws {
        try await assertDeactivationWaitsForPersistenceBoundary(.pendingOperations)
    }

    func testDeactivateScopeWaitsForMarkAppliedBoundaryAfterPushFinishes() async throws {
        try await assertDeactivationWaitsForPersistenceBoundary(.markApplied)
    }

    func testAuthenticationBootstrapFailureStopsAuthenticatedFollowOnWork() async throws {
        let lifecycle = FailingSyncLifecycle(failBootstrap: true, failDeactivate: false)
        let model = Self.model(
            sessionEnder: ImmediateSessionEnder(),
            syncLifecycle: lifecycle
        )

        model.didAuthenticate(Self.session(user: 8, session: 8))
        await lifecycle.waitForBootstrapAttempt()
        await Self.yieldRepeatedly()

        XCTAssertEqual(BootstrapURLProtocol.requestCount(), 0)
        XCTAssertEqual(model.banner?.tone, .warning)
    }

    func testSignOutDeactivationFailureDoesNotReloadPublicDiscoveryFromSensitiveStorage() async throws {
        let lifecycle = FailingSyncLifecycle(failBootstrap: false, failDeactivate: true)
        let model = Self.model(
            sessionEnder: ImmediateSessionEnder(),
            syncLifecycle: lifecycle
        )
        model.session = Self.session(user: 9, session: 9)

        model.signOut()
        await lifecycle.waitForDeactivationAttempt()
        await Self.yieldRepeatedly()

        XCTAssertEqual(BootstrapURLProtocol.requestCount(), 0)
        XCTAssertEqual(model.banner?.tone, .warning)
    }

    func testLateColdStartRestoreCannotReplaceANewerAuthentication() async throws {
        let staleRestored = Self.session(user: 1, session: 1)
        let authenticated = Self.session(user: 2, session: 2)
        let restorer = ControlledSessionRestorer(session: staleRestored)
        let persistence = PersistenceStore.makeInMemory()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [BootstrapURLProtocol.self]
        let api = SpottAPIClient(
            environment: .init(baseURL: URL(string: "https://api.spott.test/v1")!),
            credentials: CredentialVault(service: "jp.spott.bootstrap-race.\(UUID().uuidString)"),
            session: URLSession(configuration: configuration)
        )
        let syncLifecycle = RecordingSyncLifecycle()
        let model = AppModel(
            api: api,
            analytics: AnalyticsClient(environment: .preview),
            persistence: persistence,
            sync: SyncEngine(api: api, persistence: persistence),
            router: AppRouter(),
            sessionRestorer: restorer,
            syncLifecycle: syncLifecycle
        )

        let bootstrap = Task { await model.bootstrap() }
        await restorer.waitUntilStarted()
        model.didAuthenticate(authenticated)
        await syncLifecycle.waitForBootstrap(userID: authenticated.user.id)
        await restorer.finish()
        await bootstrap.value

        XCTAssertEqual(model.session?.sessionId, authenticated.sessionId)
    }

    func testLateColdStartVaultFailureCannotWarnOrLoadAnonymousDiscoveryAfterNewAuthentication() async {
        let authenticated = Self.session(user: 3, session: 3)
        let restorer = ControlledFailingSessionRestorer()
        let discoveryService = BootstrapDiscoveryService(outcome: .success(EventSummary.samples))
        let syncLifecycle = RecordingSyncLifecycle()
        let model = Self.publicBootstrapModel(
            sessionRestorer: restorer,
            discoveryService: discoveryService,
            syncLifecycle: syncLifecycle
        )

        let bootstrap = Task { await model.bootstrap() }
        await restorer.waitUntilStarted()
        model.didAuthenticate(authenticated)
        await syncLifecycle.waitForBootstrap(userID: authenticated.user.id)
        let authenticatedDiscoveryStarted = await Self.waitForDiscoveryRequest(
            discoveryService,
            count: 1
        )
        XCTAssertTrue(
            authenticatedDiscoveryStarted,
            "Authenticated discovery did not start before the bounded deadline"
        )

        await restorer.failWithMissingEntitlement()
        await bootstrap.value
        await Self.yieldRepeatedly()

        let requestCount = await discoveryService.requestCount()
        XCTAssertEqual(model.session?.sessionId, authenticated.sessionId)
        XCTAssertNil(model.banner, "A stale Keychain failure must not warn after a newer login")
        XCTAssertEqual(requestCount, 1, "Only authenticated discovery may load")
        XCTAssertEqual(model.discovery.items.map(\.id), EventSummary.samples.map(\.id))
    }

    func testAPIErrorPreservesServerFieldErrors() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FieldErrorURLProtocol.self]
        let client = SpottAPIClient(
            environment: .init(baseURL: URL(string: "https://api.spott.test/v1")!),
            credentials: CredentialVault(service: "jp.spott.field-error.\(UUID().uuidString)"),
            session: URLSession(configuration: configuration),
            usesCredentials: false
        )

        do {
            _ = try await client.discovery(.init(region: "tokyo"))
            XCTFail("A validation response must throw APIError")
        } catch let error as APIError {
            XCTAssertEqual(error.status, 422)
            XCTAssertEqual(error.code, "VALIDATION_ERROR")
            XCTAssertEqual(
                error.fieldErrors,
                [
                    APIFieldError(field: "partySize", message: "最多可报名 4 人"),
                    APIFieldError(
                        field: "answers.00000000-0000-0000-0000-000000000001",
                        message: "请填写答案"
                    ),
                ]
            )
        }
    }

    private static func model(
        sessionEnder: any SessionEnding,
        syncLifecycle: any SyncLifecycleManaging
    ) -> AppModel {
        let persistence = PersistenceStore.makeInMemory()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [BootstrapURLProtocol.self]
        let api = SpottAPIClient(
            environment: .preview,
            credentials: CredentialVault(service: "jp.spott.session-model.\(UUID().uuidString)"),
            session: URLSession(configuration: configuration)
        )
        return AppModel(
            api: api,
            analytics: AnalyticsClient(environment: .preview),
            persistence: persistence,
            sync: SyncEngine(api: api, persistence: persistence),
            router: AppRouter(),
            sessionEnder: sessionEnder,
            syncLifecycle: syncLifecycle
        )
    }

    nonisolated private static func session(user: Int, session: Int) -> UserSession {
        UserSession(
            accessToken: "access-\(session)",
            refreshToken: "refresh-\(session)",
            sessionId: UUID(uuidString: String(format: "00000000-0000-0000-1000-%012d", session))!,
            accessTokenExpiresAt: Date(timeIntervalSince1970: 1_800_000_000),
            user: .init(
                id: UUID(uuidString: String(format: "00000000-0000-0000-2000-%012d", user))!,
                publicHandle: "user-\(user)",
                phoneVerified: true,
                restrictions: []
            )
        )
    }

    nonisolated private static func encodedSession(_ session: UserSession) throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return try encoder.encode(session)
    }

    nonisolated private static let emptyDiscoveryPageData = Data(
        #"{"items":[],"nextCursor":null,"hasMore":false,"serverTime":"2026-07-16T00:00:00Z","queryExplanationId":"session-boundary"}"#.utf8
    )

    nonisolated private static let authenticationErrorData = Data(
        #"{"error":{"code":"TOKEN_EXPIRED","message":"expired","requestId":"session-boundary","retryable":false}}"#.utf8
    )

    nonisolated private static let serviceUnavailableErrorData = Data(
        #"{"error":{"code":"AUTH_SERVICE_UNAVAILABLE","message":"temporary","requestId":"session-boundary","retryable":true}}"#.utf8
    )

    nonisolated private static let syncOwnerKey = "jp.spott.sync.owner-user-id"
    nonisolated private static let secureSessionUnavailableMessageKey =
        "无法读取此设备上的登录信息。你仍可浏览公开活动，请稍后重试。"
    nonisolated private static let secureSessionInvalidMessageKey =
        "此设备上的登录信息已失效。你仍可浏览公开活动，请重新登录。"

    private func assertVaultFailureFallsBackToAnonymousDiscovery(
        _ failure: VaultError,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws {
        try OptionalAuthenticationURLProtocol.configure(
            feedData: Self.discoveryFeedData(),
            searchData: Self.discoveryPageData()
        )
        let credentials = ThrowingCredentialStore(failure: failure)
        let api = Self.optionalAuthenticationClient(credentials: credentials)
        let persistence = PersistenceStore.makeInMemory()
        let model = AppModel(
            api: api,
            analytics: AnalyticsClient(environment: .preview),
            persistence: persistence,
            sync: SyncEngine(api: api, persistence: persistence),
            router: AppRouter()
        )

        await model.bootstrap()

        let requests = OptionalAuthenticationURLProtocol.requests()
        XCTAssertNil(model.session, file: file, line: line)
        XCTAssertEqual(model.discovery.phase, .content, file: file, line: line)
        XCTAssertEqual(
            model.discovery.items.map(\.id),
            [EventSummary.samples[0].id],
            file: file,
            line: line
        )
        XCTAssertEqual(model.banner?.tone, .warning, file: file, line: line)
        XCTAssertEqual(
            model.banner?.title,
            AppModel.map(failure).message,
            file: file,
            line: line
        )
        XCTAssertEqual(requests.count, 1, file: file, line: line)
        let request = try XCTUnwrap(requests.first, file: file, line: line)
        XCTAssertEqual(request.url?.path, "/v1/discovery/feed", file: file, line: line)
        XCTAssertNil(
            request.value(forHTTPHeaderField: "Authorization"),
            file: file,
            line: line
        )
    }

    private static func optionalAuthenticationClient(
        credentials: any CredentialStoring
    ) -> SpottAPIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [OptionalAuthenticationURLProtocol.self]
        return SpottAPIClient(
            environment: .init(baseURL: URL(string: "https://api.spott.test/v1")!),
            credentials: credentials,
            session: URLSession(configuration: configuration)
        )
    }

    nonisolated private static func discoveryFeedData(
        personalized: Bool = false
    ) throws -> Data {
        var event = try eventJSONObject(personalized: personalized)
        event["recommendation"] = [
            "score": 1.0,
            "boosted": false,
            "components": ["freshness": 1.0],
        ]
        return try JSONSerialization.data(withJSONObject: [
            "banner": NSNull(),
            "modules": [[
                "key": "today",
                "title": "Today",
                "items": [event],
            ]],
            "moduleOrder": ["today"],
            "weights": ["freshness": 1.0],
            "scoringVersion": "optional-auth-test-v1",
            "naturalResultsMinRatio": 0.6,
            "serverTime": "2026-07-19T00:00:00Z",
            "generatedAt": "2026-07-19T00:00:00Z",
            "queryExplanationId": "optional-auth-feed-test",
        ])
    }

    nonisolated private static func discoveryPageData() throws -> Data {
        try JSONSerialization.data(withJSONObject: [
            "items": [try eventJSONObject(personalized: false)],
            "nextCursor": NSNull(),
            "hasMore": false,
            "serverTime": "2026-07-19T00:00:00Z",
            "queryExplanationId": "optional-auth-search-test",
        ])
    }

    nonisolated private static func eventJSONObject(
        personalized: Bool
    ) throws -> [String: Any] {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(EventSummary.samples[0])
        guard var event = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw URLError(.cannotParseResponse)
        }
        guard personalized else { return event }

        event["favorited"] = true
        event["registrationStatus"] = "confirmed"
        event["viewerRegistration"] = [
            "id": "019b0000-0000-7000-8200-000000000041",
            "status": "confirmed",
            "partySize": 2,
            "offerExpiresAt": NSNull(),
        ]
        if var organizer = event["organizer"] as? [String: Any] {
            organizer["viewerFollowing"] = true
            event["organizer"] = organizer
        }
        return event
    }

    private static func waitForDiscoveryRequest(
        _ service: BootstrapDiscoveryService,
        count: Int,
        timeout: Duration = .seconds(1)
    ) async -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while await service.requestCount() < count {
            guard clock.now < deadline else { return false }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return true
    }

    private static func localizedAppString(
        _ key: String,
        language: AppLanguage
    ) throws -> String {
        let path = try XCTUnwrap(
            Bundle.main.path(forResource: language.rawValue, ofType: "lproj"),
            "Missing \(language.rawValue).lproj from the built app"
        )
        let bundle = try XCTUnwrap(Bundle(path: path))
        return bundle.localizedString(forKey: key, value: nil, table: "Localizable")
    }

    private static func publicBootstrapModel(
        sessionRestorer: any SessionRestoring,
        discoveryService: any DiscoveryServing,
        syncLifecycle: (any SyncLifecycleManaging)? = nil
    ) -> AppModel {
        let credentials = InMemoryCredentialStore()
        let persistence = PersistenceStore.makeInMemory()
        let api = SpottAPIClient(
            environment: .init(baseURL: URL(string: "https://api.spott.test/v1")!),
            credentials: credentials,
            session: URLSession(configuration: .ephemeral)
        )
        return AppModel(
            api: api,
            analytics: AnalyticsClient(environment: .preview),
            persistence: persistence,
            sync: SyncEngine(api: api, persistence: persistence),
            router: AppRouter(),
            sessionRestorer: sessionRestorer,
            syncLifecycle: syncLifecycle ?? RecordingSyncLifecycle(),
            discovery: DiscoveryStore(
                service: discoveryService,
                cache: persistence,
                debounce: .zero
            )
        )
    }

    private static func yieldRepeatedly() async {
        for _ in 0..<20 { await Task.yield() }
    }

    private func assertDeactivationWaitsForPersistenceBoundary(
        _ boundary: LifecyclePersistenceBoundary
    ) async throws {
        let gate = LifecyclePersistenceBoundaryGate(selectedBoundary: boundary)
        let operation = PendingOperation(
            operationID: UUID(),
            entityType: "registration",
            entityID: UUID(),
            action: "cancel",
            baseVersion: 3,
            payload: Data(#"{"reason":"boundary-test"}"#.utf8),
            dependencies: []
        )
        let persistence = LifecycleBlockingSyncPersistence(
            gate: gate,
            pendingOperation: boundary == .pendingOperations || boundary == .markApplied
                ? operation
                : nil
        )
        let api = LifecycleBoundarySyncAPI(
            changes: boundary == .apply ? [Self.lifecycleBoundaryChange] : []
        )
        let engine = SyncEngine(api: api, persistence: persistence)
        let owner = UUID(uuidString: "00000000-0000-0000-0000-000000000081")!

        let bootstrapTask = Task {
            try? await engine.bootstrap(userID: owner, generation: 1)
        }
        let boundaryEntered = await Task.detached {
            gate.waitUntilEntered(timeout: 2)
        }.value
        XCTAssertTrue(boundaryEntered, "Expected sync to enter the \(boundary) persistence boundary")

        let completion = SessionIsolationCompletionFlag()
        let deactivationTask = Task {
            await completion.start()
            do {
                try await engine.deactivateScope(reason: .signOut, generation: 2)
                await completion.finish(failed: false)
            } catch {
                await completion.finish(failed: true)
            }
        }
        await completion.waitUntilStarted()
        try await Task.sleep(for: .milliseconds(50))

        let finishedWhileOldContextWasActive = await completion.isFinished()
        XCTAssertTrue(gate.isActive)
        XCTAssertFalse(
            finishedWhileOldContextWasActive,
            "Deactivation returned while old-generation \(boundary) work was still alive"
        )

        gate.release()
        await deactivationTask.value
        _ = await bootstrapTask.value

        let deactivationFailed = await completion.didFail()
        let deactivationFinished = await completion.isFinished()
        let pushCount = await api.pushCount()
        XCTAssertFalse(deactivationFailed)
        XCTAssertTrue(deactivationFinished)
        XCTAssertFalse(
            gate.isActive,
            "No old-generation persistence context may remain alive when deactivation returns"
        )
        if boundary == .pendingOperations {
            XCTAssertEqual(pushCount, 0, "Revoked pending work must not reach the network")
        }
    }

    nonisolated private static let lifecycleBoundaryChange = SyncChange(
        seq: 1,
        topic: "event",
        entityType: "event",
        entityId: UUID(uuidString: "00000000-0000-0000-0000-000000000091")!,
        operation: "upsert",
        version: 1,
        changedFields: ["title"],
        payload: ["title": .string("Boundary")]
    )
}

private actor ControlledSessionEnder: SessionEnding {
    private var expectedIDs: [UUID] = []
    private var startedWaiters: [CheckedContinuation<Void, Never>] = []
    private var finishContinuation: CheckedContinuation<Bool, Never>?

    func signOut(expectedSessionID: UUID) async throws -> Bool {
        expectedIDs.append(expectedSessionID)
        let waiters = startedWaiters
        startedWaiters.removeAll()
        waiters.forEach { $0.resume() }
        return await withCheckedContinuation { finishContinuation = $0 }
    }

    func waitUntilStarted() async {
        if !expectedIDs.isEmpty { return }
        await withCheckedContinuation { startedWaiters.append($0) }
    }

    func finish() {
        finishContinuation?.resume(returning: true)
        finishContinuation = nil
    }

    func expectedSessionIDs() -> [UUID] { expectedIDs }
}

private actor ImmediateSessionEnder: SessionEnding {
    func signOut(expectedSessionID: UUID) async throws -> Bool {
        _ = expectedSessionID
        return true
    }
}

private protocol DestructivePersistenceResetEntry: Actor {
    func resetSensitiveScope(
        reason: ScopeDeactivationReason,
        generation: UInt64
    ) async throws
}

private actor DestructivePersistenceResetSpy:
    DiscoveryCaching,
    DestructivePersistenceResetEntry {
    private var cached: [EventSummary] = []
    private var replacementCount = 0
    private var destructiveInvocations = 0
    private var replacementWaiters: [
        (count: Int, continuation: CheckedContinuation<Void, Never>)
    ] = []

    func cachedEvents() async throws -> [EventSummary] { cached }

    func replaceEvents(_ events: [EventSummary]) async throws {
        cached = events
        replacementCount += 1
        let waiters = replacementWaiters
        replacementWaiters.removeAll()
        for waiter in waiters {
            if waiter.count <= replacementCount {
                waiter.continuation.resume()
            } else {
                replacementWaiters.append(waiter)
            }
        }
    }

    func resetSensitiveScope(
        reason: ScopeDeactivationReason,
        generation: UInt64
    ) async throws {
        _ = reason
        _ = generation
        destructiveInvocations += 1
    }

    func waitForCacheReplacement(count: Int) async {
        if replacementCount >= count { return }
        await withCheckedContinuation {
            replacementWaiters.append((count, $0))
        }
    }

    func destructiveInvocationCount() -> Int { destructiveInvocations }
}

private actor InMemoryCredentialStore: CredentialStoring {
    private var storedSession: UserSession?

    init(session: UserSession? = nil) {
        storedSession = session
    }

    func save(session: UserSession) throws {
        storedSession = session
    }

    func replace(session: UserSession, expectedSessionID: UUID) throws -> Bool {
        guard storedSession?.sessionId == expectedSessionID else { return false }
        storedSession = session
        return true
    }

    func session() throws -> UserSession? { storedSession }

    func clear(expectedSessionID: UUID) throws -> Bool {
        guard storedSession?.sessionId == expectedSessionID else { return false }
        storedSession = nil
        return true
    }
}

private actor ThrowingCredentialStore: CredentialStoring {
    private let failure: VaultError

    init(failure: VaultError) {
        self.failure = failure
    }

    func save(session: UserSession) throws {
        _ = session
        throw failure
    }

    func replace(session: UserSession, expectedSessionID: UUID) throws -> Bool {
        _ = session
        _ = expectedSessionID
        throw failure
    }

    func session() throws -> UserSession? {
        throw failure
    }

    func clear(expectedSessionID: UUID) throws -> Bool {
        _ = expectedSessionID
        throw failure
    }
}

private enum CredentialProbeError: Error {
    case injected
}

private actor CredentialProbeFailureStore: CredentialStoring {
    enum Failure: Sendable {
        case nonVault
        case cancellation
    }

    private let failure: Failure

    init(failure: Failure) {
        self.failure = failure
    }

    func save(session: UserSession) throws {
        _ = session
        try fail()
    }

    func replace(session: UserSession, expectedSessionID: UUID) throws -> Bool {
        _ = session
        _ = expectedSessionID
        try fail()
    }

    func session() throws -> UserSession? {
        try fail()
    }

    func clear(expectedSessionID: UUID) throws -> Bool {
        _ = expectedSessionID
        try fail()
    }

    private func fail() throws -> Never {
        switch failure {
        case .nonVault:
            throw CredentialProbeError.injected
        case .cancellation:
            throw CancellationError()
        }
    }
}

private actor ControlledSessionRestorer: SessionRestoring {
    private let restoredSession: UserSession
    private var started = false
    private var startedWaiters: [CheckedContinuation<Void, Never>] = []
    private var finishContinuation: CheckedContinuation<Void, Never>?

    init(session: UserSession) {
        restoredSession = session
    }

    func currentSession() async throws -> UserSession? {
        started = true
        let waiters = startedWaiters
        startedWaiters.removeAll()
        waiters.forEach { $0.resume() }
        await withCheckedContinuation { finishContinuation = $0 }
        return restoredSession
    }

    func waitUntilStarted() async {
        if started { return }
        await withCheckedContinuation { startedWaiters.append($0) }
    }

    func finish() {
        finishContinuation?.resume()
        finishContinuation = nil
    }
}

private actor ControlledFailingSessionRestorer: SessionRestoring {
    private var started = false
    private var startedWaiters: [CheckedContinuation<Void, Never>] = []
    private var finishContinuation: CheckedContinuation<UserSession?, any Error>?

    func currentSession() async throws -> UserSession? {
        started = true
        let waiters = startedWaiters
        startedWaiters.removeAll()
        waiters.forEach { $0.resume() }
        return try await withCheckedThrowingContinuation { finishContinuation = $0 }
    }

    func waitUntilStarted() async {
        if started { return }
        await withCheckedContinuation { startedWaiters.append($0) }
    }

    func failWithMissingEntitlement() {
        finishContinuation?.resume(throwing: VaultError.status(errSecMissingEntitlement))
        finishContinuation = nil
    }
}

private actor FailingVaultSessionRestorer: SessionRestoring {
    enum Failure: Sendable {
        case missingEntitlement
    }

    private let failure: Failure

    init(failure: Failure) {
        self.failure = failure
    }

    func currentSession() async throws -> UserSession? {
        switch failure {
        case .missingEntitlement:
            throw VaultError.status(errSecMissingEntitlement)
        }
    }
}

private actor BootstrapDiscoveryService: DiscoveryServing {
    enum Outcome: Sendable {
        case success([EventSummary])
        case offline
    }

    private let outcome: Outcome
    private var requests = 0

    init(outcome: Outcome) {
        self.outcome = outcome
    }

    func discovery(_ query: EventDiscoveryQuery) async throws -> DiscoveryPage {
        _ = query
        requests += 1
        switch outcome {
        case .success(let events):
            return DiscoveryPage(
                items: events,
                nextCursor: nil,
                hasMore: false,
                serverTime: Date(timeIntervalSince1970: 1_773_792_000),
                queryExplanationId: "session-vault-bootstrap-test"
            )
        case .offline:
            throw URLError(.notConnectedToInternet)
        }
    }

    func requestCount() -> Int { requests }
}

private actor RecordingSyncLifecycle: SyncLifecycleManaging {
    private var bootstraps: [(UUID, UInt64)] = []
    private var deactivations: [(ScopeDeactivationReason, UInt64)] = []
    private var bootstrapWaiters: [UUID: [CheckedContinuation<Void, Never>]] = [:]

    func bootstrap(userID: UUID, generation: UInt64) async throws {
        bootstraps.append((userID, generation))
        let waiters = bootstrapWaiters.removeValue(forKey: userID) ?? []
        waiters.forEach { $0.resume() }
    }

    func deactivateScope(reason: ScopeDeactivationReason, generation: UInt64) async throws {
        deactivations.append((reason, generation))
    }

    func waitForBootstrap(userID: UUID) async {
        if bootstraps.contains(where: { $0.0 == userID }) { return }
        await withCheckedContinuation { bootstrapWaiters[userID, default: []].append($0) }
    }

    func deactivationGenerations() -> [UInt64] { deactivations.map(\.1) }
    func deactivationReasons() -> [ScopeDeactivationReason] { deactivations.map(\.0) }
    func bootstrapUserIDs() -> [UUID] { bootstraps.map(\.0) }
}

private actor FailingSyncLifecycle: SyncLifecycleManaging {
    enum Failure: Error { case injected }

    private let failBootstrap: Bool
    private let failDeactivate: Bool
    private var bootstrapAttempts = 0
    private var deactivationAttempts = 0
    private var bootstrapWaiters: [CheckedContinuation<Void, Never>] = []
    private var deactivationWaiters: [CheckedContinuation<Void, Never>] = []

    init(failBootstrap: Bool, failDeactivate: Bool) {
        self.failBootstrap = failBootstrap
        self.failDeactivate = failDeactivate
    }

    func bootstrap(userID: UUID, generation: UInt64) async throws {
        _ = userID
        _ = generation
        bootstrapAttempts += 1
        let waiters = bootstrapWaiters
        bootstrapWaiters.removeAll()
        waiters.forEach { $0.resume() }
        if failBootstrap { throw Failure.injected }
    }

    func deactivateScope(
        reason: ScopeDeactivationReason,
        generation: UInt64
    ) async throws {
        _ = reason
        _ = generation
        deactivationAttempts += 1
        let waiters = deactivationWaiters
        deactivationWaiters.removeAll()
        waiters.forEach { $0.resume() }
        if failDeactivate { throw Failure.injected }
    }

    func waitForBootstrapAttempt() async {
        if bootstrapAttempts > 0 { return }
        await withCheckedContinuation { bootstrapWaiters.append($0) }
    }

    func waitForDeactivationAttempt() async {
        if deactivationAttempts > 0 { return }
        await withCheckedContinuation { deactivationWaiters.append($0) }
    }

    func deactivationAttemptCount() -> Int { deactivationAttempts }
}

private actor ObservedSyncLifecycle: SyncLifecycleManaging {
    private let engine: SyncEngine
    private var bootstrapCounts: [UUID: Int] = [:]
    private var bootstrapWaiters: [
        UUID: [(count: Int, continuation: CheckedContinuation<Void, Never>)]
    ] = [:]
    private var deactivationCount = 0
    private var deactivationWaiters: [
        (count: Int, continuation: CheckedContinuation<Void, Never>)
    ] = []
    private var failed = false

    init(engine: SyncEngine) {
        self.engine = engine
    }

    func bootstrap(userID: UUID, generation: UInt64) async throws {
        do {
            try await engine.bootstrap(userID: userID, generation: generation)
            finishBootstrap(userID: userID, failed: false)
        } catch {
            finishBootstrap(userID: userID, failed: true)
            throw error
        }
    }

    func deactivateScope(
        reason: ScopeDeactivationReason,
        generation: UInt64
    ) async throws {
        do {
            try await engine.deactivateScope(reason: reason, generation: generation)
            finishDeactivation(failed: false)
        } catch {
            finishDeactivation(failed: true)
            throw error
        }
    }

    func waitForBootstrap(userID: UUID, count: Int) async {
        if bootstrapCounts[userID, default: 0] >= count { return }
        await withCheckedContinuation {
            bootstrapWaiters[userID, default: []].append((count, $0))
        }
    }

    func waitForDeactivation(count: Int) async {
        if deactivationCount >= count { return }
        await withCheckedContinuation { deactivationWaiters.append((count, $0)) }
    }

    func didFail() -> Bool { failed }

    private func finishBootstrap(userID: UUID, failed: Bool) {
        self.failed = self.failed || failed
        bootstrapCounts[userID, default: 0] += 1
        let completedCount = bootstrapCounts[userID, default: 0]
        let waiters = bootstrapWaiters.removeValue(forKey: userID) ?? []
        for waiter in waiters {
            if waiter.count <= completedCount {
                waiter.continuation.resume()
            } else {
                bootstrapWaiters[userID, default: []].append(waiter)
            }
        }
    }

    private func finishDeactivation(failed: Bool) {
        self.failed = self.failed || failed
        deactivationCount += 1
        let waiters = deactivationWaiters
        deactivationWaiters.removeAll()
        for waiter in waiters {
            if waiter.count <= deactivationCount {
                waiter.continuation.resume()
            } else {
                deactivationWaiters.append(waiter)
            }
        }
    }
}

private actor ControlledSyncAPI: SyncServing {
    private var pullCount = 0
    private var firstPullWaiters: [CheckedContinuation<Void, Never>] = []
    private var secondPullWaiters: [CheckedContinuation<Void, Never>] = []
    private var firstPullContinuation: CheckedContinuation<SyncPullPage, Never>?
    private var firstPullCancellationObserved = false
    private var firstPullCancellationWaiters: [CheckedContinuation<Void, Never>] = []

    func pull(cursor: Int64, topics: [String]) async throws -> SyncPullPage {
        _ = cursor
        _ = topics
        pullCount += 1
        if pullCount == 1 {
            let waiters = firstPullWaiters
            firstPullWaiters.removeAll()
            waiters.forEach { $0.resume() }
            return await withTaskCancellationHandler {
                await withCheckedContinuation { firstPullContinuation = $0 }
            } onCancel: {
                Task { await self.noteFirstPullCancellation() }
            }
        }
        let waiters = secondPullWaiters
        secondPullWaiters.removeAll()
        waiters.forEach { $0.resume() }
        return Self.page(sequence: 2)
    }

    func push(operations: [SyncPushOperation]) async throws -> SyncPushResponse {
        _ = operations
        return SyncPushResponse(results: [])
    }

    func waitUntilFirstPullStarted() async {
        if pullCount >= 1 { return }
        await withCheckedContinuation { firstPullWaiters.append($0) }
    }

    func waitUntilSecondPullFinished() async {
        if pullCount >= 2 { return }
        await withCheckedContinuation { secondPullWaiters.append($0) }
    }

    func waitUntilFirstPullCancellationObserved() async {
        if firstPullCancellationObserved { return }
        await withCheckedContinuation { firstPullCancellationWaiters.append($0) }
    }

    func finishFirstPull() {
        firstPullContinuation?.resume(returning: Self.page(sequence: 1))
        firstPullContinuation = nil
    }

    private func noteFirstPullCancellation() {
        firstPullCancellationObserved = true
        let waiters = firstPullCancellationWaiters
        firstPullCancellationWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }

    nonisolated private static func page(sequence: Int64) -> SyncPullPage {
        SyncPullPage(changes: [], nextCursor: sequence, hasMore: false, serverTime: .now)
    }
}

private actor ControlledPushSyncAPI: SyncServing {
    private var pushedOperations: [SyncPushOperation] = []
    private var pushContinuation: CheckedContinuation<SyncPushResponse, Never>?
    private var pushStartedWaiters: [CheckedContinuation<Void, Never>] = []
    private var cancellationObserved = false

    func pull(cursor: Int64, topics: [String]) async throws -> SyncPullPage {
        _ = topics
        return SyncPullPage(
            changes: [],
            nextCursor: cursor,
            hasMore: false,
            serverTime: .now
        )
    }

    func push(operations: [SyncPushOperation]) async throws -> SyncPushResponse {
        pushedOperations = operations
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                pushContinuation = continuation
                let waiters = pushStartedWaiters
                pushStartedWaiters.removeAll()
                waiters.forEach { $0.resume() }
            }
        } onCancel: {
            Task { await self.noteCancellation() }
        }
    }

    func waitUntilPushStarted() async {
        if pushContinuation != nil { return }
        await withCheckedContinuation { pushStartedWaiters.append($0) }
    }

    func wasCancellationObserved() -> Bool { cancellationObserved }

    func finishPushWithAppliedAcknowledgement() {
        pushContinuation?.resume(returning: SyncPushResponse(
            results: pushedOperations.map {
                .init(operationId: $0.operationId, state: "applied", result: nil)
            }
        ))
        pushContinuation = nil
    }

    private func noteCancellation() {
        cancellationObserved = true
    }
}

private actor AccountTransitionSyncAPI: SyncServing {
    private var pullCount = 0
    private var pullStartedWaiters: [
        (number: Int, continuation: CheckedContinuation<Void, Never>)
    ] = []
    private var pullFinishContinuations: [Int: CheckedContinuation<Void, Never>] = [:]
    private var pushed: [UUID] = []

    func pull(cursor: Int64, topics: [String]) async throws -> SyncPullPage {
        _ = topics
        pullCount += 1
        let number = pullCount
        let waiters = pullStartedWaiters
        pullStartedWaiters.removeAll()
        for waiter in waiters {
            if waiter.number <= number {
                waiter.continuation.resume()
            } else {
                pullStartedWaiters.append(waiter)
            }
        }
        if number == 3 {
            await withCheckedContinuation { pullFinishContinuations[number] = $0 }
        }
        return SyncPullPage(
            changes: [],
            nextCursor: cursor,
            hasMore: false,
            serverTime: .now
        )
    }

    func push(operations: [SyncPushOperation]) async throws -> SyncPushResponse {
        pushed.append(contentsOf: operations.map(\.operationId))
        return SyncPushResponse(results: operations.map {
            .init(operationId: $0.operationId, state: "failed", result: nil)
        })
    }

    func waitUntilPullStarted(number: Int) async {
        if pullCount >= number { return }
        await withCheckedContinuation { pullStartedWaiters.append((number, $0)) }
    }

    func finishPull(number: Int) {
        pullFinishContinuations.removeValue(forKey: number)?.resume()
    }

    func pushedOperationIDs() -> [UUID] { pushed }
}

private actor SessionIsolationCompletionFlag {
    private var started = false
    private var finished = false
    private var failed = false
    private var startedWaiters: [CheckedContinuation<Void, Never>] = []

    func start() {
        started = true
        let waiters = startedWaiters
        startedWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }

    func waitUntilStarted() async {
        if started { return }
        await withCheckedContinuation { startedWaiters.append($0) }
    }

    func finish(failed: Bool) {
        self.failed = failed
        finished = true
    }

    func isFinished() -> Bool { finished }
    func didFail() -> Bool { failed }
}

private enum LifecyclePersistenceBoundary: String, Sendable {
    case cursor
    case apply
    case pendingOperations
    case markApplied
}

private final class LifecyclePersistenceBoundaryGate: @unchecked Sendable {
    private let condition = NSCondition()
    private let selectedBoundary: LifecyclePersistenceBoundary
    private var entered = false
    private var active = false
    private var released = false

    init(selectedBoundary: LifecyclePersistenceBoundary) {
        self.selectedBoundary = selectedBoundary
    }

    var isActive: Bool {
        condition.lock()
        defer { condition.unlock() }
        return active
    }

    func blockIfSelected(_ boundary: LifecyclePersistenceBoundary) {
        guard boundary == selectedBoundary else { return }
        condition.lock()
        entered = true
        active = true
        condition.broadcast()
        while !released {
            condition.wait()
        }
        active = false
        condition.broadcast()
        condition.unlock()
    }

    func waitUntilEntered(timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        condition.lock()
        defer { condition.unlock() }
        while !entered {
            guard condition.wait(until: deadline) else { return entered }
        }
        return true
    }

    func release() {
        condition.lock()
        released = true
        condition.broadcast()
        condition.unlock()
    }
}

private actor LifecycleBlockingSyncPersistence: SyncPersisting {
    nonisolated let ownerWriteLeaseAuthority = OwnerWriteLeaseAuthority()
    private let gate: LifecyclePersistenceBoundaryGate
    private let pendingOperation: PendingOperation?

    init(
        gate: LifecyclePersistenceBoundaryGate,
        pendingOperation: PendingOperation?
    ) {
        self.gate = gate
        self.pendingOperation = pendingOperation
    }

    func validateOwnerScope(_ ownerScope: String) throws {
        _ = try OwnerWriteLeaseAuthority.normalizedOwnerScope(ownerScope)
    }

    func cursor(scope: String) throws -> Int64 {
        _ = scope
        gate.blockIfSelected(.cursor)
        return 0
    }

    func apply(
        changes: [SyncChange],
        nextCursor: Int64,
        scope: String,
        lease: OwnerWriteLease
    ) throws {
        _ = changes
        _ = nextCursor
        gate.blockIfSelected(.apply)
        try ownerWriteLeaseAuthority.validate(lease, ownerScope: scope)
    }

    func enqueue(
        _ operation: PendingOperation,
        ownerScope: String,
        lease: OwnerWriteLease
    ) throws {
        _ = operation
        try ownerWriteLeaseAuthority.validate(lease, ownerScope: ownerScope)
    }

    func pendingOperations(ownerScope: String) throws -> [PendingOperation] {
        _ = ownerScope
        gate.blockIfSelected(.pendingOperations)
        return pendingOperation.map { [$0] } ?? []
    }

    func allOperations(ownerScope: String) throws -> [StoredOperationSnapshot] {
        _ = ownerScope
        return []
    }

    func markApplied(
        operationIDs: Set<UUID>,
        ownerScope: String,
        lease: OwnerWriteLease
    ) throws {
        _ = operationIDs
        gate.blockIfSelected(.markApplied)
        try ownerWriteLeaseAuthority.validate(lease, ownerScope: ownerScope)
    }
}

private actor LifecycleBoundarySyncAPI: SyncServing {
    private let changes: [SyncChange]
    private var pushes = 0

    init(changes: [SyncChange]) {
        self.changes = changes
    }

    func pull(cursor: Int64, topics: [String]) async throws -> SyncPullPage {
        _ = topics
        return SyncPullPage(
            changes: changes,
            nextCursor: cursor + 1,
            hasMore: false,
            serverTime: .now
        )
    }

    func push(operations: [SyncPushOperation]) async throws -> SyncPushResponse {
        pushes += 1
        return SyncPushResponse(results: operations.map {
            .init(operationId: $0.operationId, state: "applied", result: nil)
        })
    }

    func pushCount() -> Int { pushes }
}

private actor RecordingSyncPersistence: SyncPersisting {
    struct Application: Sendable {
        let scope: String
        let cursor: Int64
    }

    private struct OwnedOperation: Sendable {
        let ownerScope: String
        let operation: PendingOperation
        var state: String
        let createdAt: Date
    }

    nonisolated let ownerWriteLeaseAuthority = OwnerWriteLeaseAuthority()
    private let hasUnownedLegacyRows: Bool
    private var applied: [Application] = []
    private var operations: [OwnedOperation] = []
    private var writes = 0
    private var ownerMutationCounts: [String: Int] = [:]

    init(hasUnownedLegacyRows: Bool = false) {
        self.hasUnownedLegacyRows = hasUnownedLegacyRows
    }

    func validateOwnerScope(_ ownerScope: String) throws {
        _ = try OwnerWriteLeaseAuthority.normalizedOwnerScope(ownerScope)
        if hasUnownedLegacyRows {
            throw PersistenceOwnershipError.unresolvedLegacyOwner
        }
    }

    func cursor(scope: String) throws -> Int64 { 0 }
    func apply(
        changes: [SyncChange],
        nextCursor: Int64,
        scope: String,
        lease: OwnerWriteLease
    ) throws {
        _ = changes
        try ownerWriteLeaseAuthority.validate(lease, ownerScope: scope)
        applied.append(.init(scope: scope, cursor: nextCursor))
        writes += 1
        ownerMutationCounts[scope, default: 0] += 1
    }

    func pendingOperations(ownerScope: String) throws -> [PendingOperation] {
        operations
            .filter { $0.ownerScope == ownerScope && $0.state == "pending" }
            .map(\.operation)
    }

    func allOperations(ownerScope: String) throws -> [StoredOperationSnapshot] {
        operations.filter { $0.ownerScope == ownerScope }.map {
            StoredOperationSnapshot(
                operationID: $0.operation.operationID,
                ownerScope: $0.ownerScope,
                entityType: $0.operation.entityType,
                entityID: $0.operation.entityID,
                action: $0.operation.action,
                baseVersion: $0.operation.baseVersion,
                payload: $0.operation.payload,
                dependencies: $0.operation.dependencies,
                state: $0.state,
                attempts: 0,
                createdAt: $0.createdAt
            )
        }
    }

    func enqueue(
        _ operation: PendingOperation,
        ownerScope: String,
        lease: OwnerWriteLease
    ) throws {
        try ownerWriteLeaseAuthority.validate(lease, ownerScope: ownerScope)
        operations.append(.init(
            ownerScope: ownerScope,
            operation: operation,
            state: "pending",
            createdAt: Date(timeIntervalSince1970: 1_700_000_000)
        ))
        writes += 1
        ownerMutationCounts[ownerScope, default: 0] += 1
    }

    func markApplied(
        operationIDs: Set<UUID>,
        ownerScope: String,
        lease: OwnerWriteLease
    ) throws {
        try ownerWriteLeaseAuthority.validate(lease, ownerScope: ownerScope)
        for index in operations.indices where
            operations[index].ownerScope == ownerScope &&
            operationIDs.contains(operations[index].operation.operationID) {
            operations[index].state = "applied"
        }
        writes += 1
        ownerMutationCounts[ownerScope, default: 0] += 1
    }

    func applications() -> [Application] { applied }
    func writeCount() -> Int { writes }
    func mutationCount(ownerScope: String) -> Int {
        ownerMutationCounts[ownerScope, default: 0]
    }
    func resetMutationCount(ownerScope: String) {
        ownerMutationCounts[ownerScope] = 0
    }
}

private struct SessionIsolationOwnerDataCapture {
    let canonicalDigest: String
    let operations: [StoredOperationSnapshot]
    let drafts: [LocalEventDraftSnapshot]

    static func capture(
        ownerScope: String,
        syncPersistence: RecordingSyncPersistence,
        draftPersistence: PersistenceStore
    ) async throws -> Self {
        let operations = try await syncPersistence.allOperations(ownerScope: ownerScope)
        let drafts = try await draftPersistence.drafts(ownerScope: ownerScope)
        let operationObjects: [[String: Any]] = operations.map { operation in
            [
                "operationID": operation.operationID.uuidString.lowercased(),
                "ownerScope": operation.ownerScope,
                "entityType": operation.entityType,
                "entityID": operation.entityID.map {
                    $0.uuidString.lowercased() as Any
                } ?? NSNull(),
                "action": operation.action,
                "baseVersion": operation.baseVersion.map { $0 as Any } ?? NSNull(),
                "payload": operation.payload.base64EncodedString(),
                "dependencies": operation.dependencies.map { $0.uuidString.lowercased() },
                "state": operation.state,
                "attempts": operation.attempts,
                "createdAtBits": String(
                    operation.createdAt.timeIntervalSinceReferenceDate.bitPattern,
                    radix: 16
                ),
            ]
        }
        let draftObjects: [[String: Any]] = drafts.map { draft in
            [
                "ownerScope": ownerScope,
                "localID": draft.localID.uuidString.lowercased(),
                "serverID": draft.serverID.map {
                    $0.uuidString.lowercased() as Any
                } ?? NSNull(),
                "title": draft.title,
                "payload": draft.payload.base64EncodedString(),
                "draftRevision": draft.draftRevision,
                "serverVersion": draft.serverVersion.map { $0 as Any } ?? NSNull(),
                "updatedAtBits": String(
                    draft.updatedAt.timeIntervalSinceReferenceDate.bitPattern,
                    radix: 16
                ),
            ]
        }
        let canonicalData = try JSONSerialization.data(
            withJSONObject: [
                "digestVersion": 1,
                "ownerScope": ownerScope,
                "operations": operationObjects,
                "drafts": draftObjects,
            ],
            options: [.sortedKeys]
        )
        let digest = SHA256.hash(data: canonicalData)
            .map { String(format: "%02x", $0) }
            .joined()
        return Self(
            canonicalDigest: "spott-owner-data-v1:\(digest)",
            operations: operations,
            drafts: drafts
        )
    }
}

private actor CountingSyncAPI: SyncServing {
    private var count = 0
    private var pushed: [UUID] = []

    func pull(cursor: Int64, topics: [String]) async throws -> SyncPullPage {
        _ = cursor
        _ = topics
        count += 1
        return SyncPullPage(changes: [], nextCursor: Int64(count), hasMore: false, serverTime: .now)
    }

    func push(operations: [SyncPushOperation]) async throws -> SyncPushResponse {
        pushed.append(contentsOf: operations.map(\.operationId))
        return SyncPushResponse(
            results: operations.map {
                .init(operationId: $0.operationId, state: "applied", result: nil)
            }
        )
    }

    func pullCount() -> Int { count }
    func pushedOperationIDs() -> [UUID] { pushed }
}

private actor NonAcknowledgingSyncAPI: SyncServing {
    private var pushed: [UUID] = []

    func pull(cursor: Int64, topics: [String]) async throws -> SyncPullPage {
        _ = topics
        return SyncPullPage(changes: [], nextCursor: cursor, hasMore: false, serverTime: .now)
    }

    func push(operations: [SyncPushOperation]) async throws -> SyncPushResponse {
        pushed.append(contentsOf: operations.map(\.operationId))
        return SyncPushResponse(
            results: operations.map {
                .init(operationId: $0.operationId, state: "failed", result: nil)
            }
        )
    }

    func pushedOperationIDs() -> [UUID] { pushed }
}

private final class ControlledRefreshURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var onStart: ((Int) -> Void)?
    private static let storage = RefreshProtocolStorage()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let requestNumber = Self.storage.insert(self)
        Self.onStart?(requestNumber)
    }

    override func stopLoading() {}

    static func succeed(requestNumber: Int, session: UserSession) throws {
        let data = try Self.encoder.encode(session)
        guard let request = storage.remove(requestNumber: requestNumber) else {
            throw URLError(.resourceUnavailable)
        }
        let response = HTTPURLResponse(
            url: request.request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        request.client?.urlProtocol(request, didReceive: response, cacheStoragePolicy: .notAllowed)
        request.client?.urlProtocol(request, didLoad: data)
        request.client?.urlProtocolDidFinishLoading(request)
    }

    static func requestNumbers() -> [Int] { storage.requestNumbers() }

    static func reset() {
        onStart = nil
        storage.reset()
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()
}

private final class SessionBoundaryURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var onStart: ((URLRequest, Int) -> Void)?
    private static let storage = SessionBoundaryProtocolStorage()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let requestNumber = Self.storage.insert(self)
        Self.onStart?(request, requestNumber)
    }

    override func stopLoading() {}

    static func respond(
        requestNumber: Int,
        status: Int,
        data: Data,
        headerFields: [String: String] = [:]
    ) throws {
        guard let request = storage.remove(requestNumber: requestNumber) else {
            throw URLError(.resourceUnavailable)
        }
        let response = HTTPURLResponse(
            url: request.request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
                .merging(headerFields) { _, new in new }
        )!
        request.client?.urlProtocol(request, didReceive: response, cacheStoragePolicy: .notAllowed)
        request.client?.urlProtocol(request, didLoad: data)
        request.client?.urlProtocolDidFinishLoading(request)
    }

    static func fail(requestNumber: Int, error: Error) throws {
        guard let request = storage.remove(requestNumber: requestNumber) else {
            throw URLError(.resourceUnavailable)
        }
        request.client?.urlProtocol(request, didFailWithError: error)
    }

    static func requests() -> [URLRequest] { storage.requests() }

    static func reset() {
        onStart = nil
        storage.reset()
    }
}

private final class SessionBoundaryProtocolStorage: @unchecked Sendable {
    private let lock = NSLock()
    private var active: [Int: SessionBoundaryURLProtocol] = [:]
    private var recorded: [URLRequest] = []

    func insert(_ request: SessionBoundaryURLProtocol) -> Int {
        lock.withLock {
            let requestNumber = recorded.count + 1
            active[requestNumber] = request
            recorded.append(request.request)
            return requestNumber
        }
    }

    func remove(requestNumber: Int) -> SessionBoundaryURLProtocol? {
        lock.withLock { active.removeValue(forKey: requestNumber) }
    }

    func requests() -> [URLRequest] { lock.withLock { recorded } }

    func reset() {
        lock.withLock {
            active.removeAll()
            recorded.removeAll()
        }
    }
}

private final class RefreshProtocolStorage: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [Int: ControlledRefreshURLProtocol] = [:]
    private var seenRequestNumbers: [Int] = []

    func insert(_ request: ControlledRefreshURLProtocol) -> Int {
        lock.withLock {
            let requestNumber = seenRequestNumbers.count + 1
            requests[requestNumber] = request
            seenRequestNumbers.append(requestNumber)
            return requestNumber
        }
    }

    func remove(requestNumber: Int) -> ControlledRefreshURLProtocol? {
        lock.withLock { requests.removeValue(forKey: requestNumber) }
    }

    func requestNumbers() -> [Int] { lock.withLock { seenRequestNumbers } }

    func reset() {
        lock.withLock {
            requests.removeAll()
            seenRequestNumbers.removeAll()
        }
    }
}

private final class BootstrapURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var count = 0

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.withLock { Self.count += 1 }
        let payload: [String: Any] = [
            "items": [],
            "nextCursor": NSNull(),
            "hasMore": false,
            "serverTime": "2026-07-16T00:00:00Z",
            "queryExplanationId": "bootstrap-test",
        ]
        let data = try! JSONSerialization.data(withJSONObject: payload)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    static func requestCount() -> Int { lock.withLock { count } }

    static func reset() {
        lock.withLock { count = 0 }
    }
}

private final class OptionalAuthenticationURLProtocol: URLProtocol, @unchecked Sendable {
    private static let storage = OptionalAuthenticationProtocolStorage()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let stub = Self.storage.response(for: request)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: stub.statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: stub.data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    static func configure(feedData: Data, searchData: Data) {
        storage.configure(feedData: feedData, searchData: searchData)
    }

    static func configureRefresh(
        feedData: Data,
        searchData: Data,
        refreshedSessionData: Data
    ) {
        storage.configureRefresh(
            feedData: feedData,
            searchData: searchData,
            refreshedSessionData: refreshedSessionData
        )
    }

    static func requests() -> [URLRequest] { storage.requests() }

    static func reset() { storage.reset() }
}

private final class OptionalAuthenticationProtocolStorage: @unchecked Sendable {
    private let lock = NSLock()
    private var feedData = Data()
    private var searchData = Data()
    private var refreshedSessionData: Data?
    private var feedRequestCount = 0
    private var recordedRequests: [URLRequest] = []

    func configure(feedData: Data, searchData: Data) {
        lock.withLock {
            self.feedData = feedData
            self.searchData = searchData
            refreshedSessionData = nil
            feedRequestCount = 0
            recordedRequests.removeAll()
        }
    }

    func configureRefresh(
        feedData: Data,
        searchData: Data,
        refreshedSessionData: Data
    ) {
        lock.withLock {
            self.feedData = feedData
            self.searchData = searchData
            self.refreshedSessionData = refreshedSessionData
            feedRequestCount = 0
            recordedRequests.removeAll()
        }
    }

    func response(for request: URLRequest) -> (statusCode: Int, data: Data) {
        lock.withLock {
            recordedRequests.append(request)
            switch request.url?.path {
            case "/v1/discovery/feed":
                feedRequestCount += 1
                if refreshedSessionData != nil, feedRequestCount == 1 {
                    return (
                        401,
                        Data(
                            #"{"error":{"code":"TOKEN_EXPIRED","message":"expired","requestId":"optional-auth-refresh","retryable":false}}"#.utf8
                        )
                    )
                }
                return (200, feedData)
            case "/v1/events/search":
                return (200, searchData)
            case "/v1/auth/refresh":
                return (200, refreshedSessionData ?? Data("{}".utf8))
            default:
                return (200, Data("{}".utf8))
            }
        }
    }

    func requests() -> [URLRequest] {
        lock.withLock { recordedRequests }
    }

    func reset() {
        lock.withLock {
            feedData = Data()
            searchData = Data()
            refreshedSessionData = nil
            feedRequestCount = 0
            recordedRequests.removeAll()
        }
    }
}

private final class FieldErrorURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let payload: [String: Any] = [
            "error": [
                "code": "VALIDATION_ERROR",
                "message": "请检查报名信息",
                "requestId": "field-error-test",
                "retryable": false,
                "fieldErrors": [
                    ["field": "partySize", "message": "最多可报名 4 人"],
                    [
                        "field": "answers.00000000-0000-0000-0000-000000000001",
                        "message": "请填写答案",
                    ],
                ],
            ],
        ]
        let data = try! JSONSerialization.data(withJSONObject: payload)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 422,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
