import Foundation
import XCTest
@testable import Spott

@MainActor
final class SessionIsolationTests: XCTestCase {
    override func tearDown() {
        ControlledRefreshURLProtocol.reset()
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

    func testStaleSignOutCannotResetAReplacementAuthenticatedSession() async throws {
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
        let resetGenerations = await syncLifecycle.resetGenerations()

        XCTAssertEqual(model.session?.sessionId, replacement.sessionId)
        XCTAssertEqual(expectedSessionIDs, [first.sessionId])
        XCTAssertTrue(resetGenerations.isEmpty)
    }

    func testNewSyncGenerationRejectsALateResponseFromThePreviousAccount() async throws {
        let api = ControlledSyncAPI()
        let persistence = RecordingSyncPersistence()
        let engine = SyncEngine(api: api, persistence: persistence)
        let firstUser = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
        let replacementUser = UUID(uuidString: "00000000-0000-0000-0000-000000000002")!

        let first = Task { try? await engine.bootstrap(userID: firstUser, generation: 1) }
        await api.waitUntilFirstPullStarted()
        let replacement = Task { try? await engine.bootstrap(userID: replacementUser, generation: 2) }
        await api.waitUntilSecondPullFinished()
        await api.finishFirstPull()
        _ = await first.value
        _ = await replacement.value

        let applications = await persistence.applications()
        let resetCountAfterSwitch = await persistence.resetCount()
        XCTAssertEqual(applications.map(\.scope), [replacementUser.uuidString.lowercased()])
        XCTAssertEqual(resetCountAfterSwitch, 1)

        try await engine.resetSensitiveScope(reason: .signOut, generation: 1)
        let resetCountAfterStaleReset = await persistence.resetCount()
        XCTAssertEqual(resetCountAfterStaleReset, 1)
    }

    func testAccountSwitchResetsTheRealtimeHintSequence() async throws {
        let api = CountingSyncAPI()
        let persistence = RecordingSyncPersistence()
        let engine = SyncEngine(api: api, persistence: persistence)
        let firstUser = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
        let replacementUser = UUID(uuidString: "00000000-0000-0000-0000-000000000002")!

        try await engine.bootstrap(userID: firstUser, generation: 1)
        await engine.handleRealtimeHint(sequence: 100)
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

private actor RecordingSyncLifecycle: SyncLifecycleManaging {
    private var bootstraps: [(UUID, UInt64)] = []
    private var resets: [UInt64] = []
    private var bootstrapWaiters: [UUID: [CheckedContinuation<Void, Never>]] = [:]

    func bootstrap(userID: UUID, generation: UInt64) async throws {
        bootstraps.append((userID, generation))
        let waiters = bootstrapWaiters.removeValue(forKey: userID) ?? []
        waiters.forEach { $0.resume() }
    }

    func resetSensitiveScope(reason: SensitiveResetReason, generation: UInt64) async throws {
        _ = reason
        resets.append(generation)
    }

    func waitForBootstrap(userID: UUID) async {
        if bootstraps.contains(where: { $0.0 == userID }) { return }
        await withCheckedContinuation { bootstrapWaiters[userID, default: []].append($0) }
    }

    func resetGenerations() -> [UInt64] { resets }
    func bootstrapUserIDs() -> [UUID] { bootstraps.map(\.0) }
}

private actor ControlledSyncAPI: SyncServing {
    private var pullCount = 0
    private var firstPullWaiters: [CheckedContinuation<Void, Never>] = []
    private var secondPullWaiters: [CheckedContinuation<Void, Never>] = []
    private var firstPullContinuation: CheckedContinuation<SyncPullPage, Never>?

    func pull(cursor: Int64, topics: [String]) async throws -> SyncPullPage {
        _ = cursor
        _ = topics
        pullCount += 1
        if pullCount == 1 {
            let waiters = firstPullWaiters
            firstPullWaiters.removeAll()
            waiters.forEach { $0.resume() }
            return await withCheckedContinuation { firstPullContinuation = $0 }
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

    func finishFirstPull() {
        firstPullContinuation?.resume(returning: Self.page(sequence: 1))
        firstPullContinuation = nil
    }

    nonisolated private static func page(sequence: Int64) -> SyncPullPage {
        SyncPullPage(changes: [], nextCursor: sequence, hasMore: false, serverTime: .now)
    }
}

private actor RecordingSyncPersistence: SyncPersisting {
    struct Application: Sendable {
        let scope: String
        let cursor: Int64
    }

    private var applied: [Application] = []
    private var resets = 0

    func cursor(scope: String) throws -> Int64 { 0 }
    func apply(changes: [SyncChange], nextCursor: Int64, scope: String) throws {
        _ = changes
        applied.append(.init(scope: scope, cursor: nextCursor))
    }
    func pendingOperations() throws -> [PendingOperation] { [] }
    func enqueue(_ operation: PendingOperation) throws { _ = operation }
    func markApplied(operationIDs: Set<UUID>) throws { _ = operationIDs }
    func resetSensitive() throws { resets += 1 }
    func applications() -> [Application] { applied }
    func resetCount() -> Int { resets }
}

private actor CountingSyncAPI: SyncServing {
    private var count = 0

    func pull(cursor: Int64, topics: [String]) async throws -> SyncPullPage {
        _ = cursor
        _ = topics
        count += 1
        return SyncPullPage(changes: [], nextCursor: Int64(count), hasMore: false, serverTime: .now)
    }

    func push(operations: [SyncPushOperation]) async throws -> SyncPushResponse {
        _ = operations
        return SyncPushResponse(results: [])
    }

    func pullCount() -> Int { count }
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
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
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
