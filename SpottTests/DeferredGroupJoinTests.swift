import XCTest
@testable import Spott

@MainActor
final class DeferredGroupJoinTests: XCTestCase {
    func testGuestInviteJoinSurvivesLoginAndPhoneVerificationThenRunsOnce() async throws {
        let group = makeGroup(joinMode: .inviteOnly)
        let service = RecordingGroupJoinService(latestGroup: group)
        let model = makeModel(groupJoinService: service)
        var immediateDestinations = 0

        model.requireGroupJoinTrust(for: group, inviteCode: "  INVITE-42  ") {
            immediateDestinations += 1
        }

        XCTAssertEqual(model.presentedGate, .login)
        XCTAssertEqual(model.router.deferredGroupJoinIntent?.groupID, group.id)
        XCTAssertEqual(model.router.deferredGroupJoinIntent?.inviteCode, "INVITE-42")
        XCTAssertEqual(immediateDestinations, 0)

        model.didAuthenticate(makeSession(phoneVerified: false))

        XCTAssertEqual(model.presentedGate, .phoneVerification)
        XCTAssertEqual(model.router.deferredGroupJoinIntent?.requiredGate, .phoneVerification)
        let countsBeforeVerification = await service.requestCounts()
        XCTAssertEqual(countsBeforeVerification, .init(loads: 0, joins: 0))

        model.markPhoneVerified()
        try await waitUntil { await service.requestCounts().joins == 1 }

        let completedOperations = await service.operations()
        XCTAssertEqual(completedOperations, [.load(group.id), .join(group.id, "INVITE-42")])
        XCTAssertNil(model.router.deferredGroupJoinIntent)

        model.markPhoneVerified()
        await Task.yield()

        let countsAfterRepeatedVerification = await service.requestCounts()
        XCTAssertEqual(countsAfterRepeatedVerification.joins, 1)
        XCTAssertEqual(immediateDestinations, 0)
    }

    func testRecoveryRefreshesAndRefusesARevokedJoinAction() async throws {
        let initial = makeGroup()
        let revoked = makeGroup(availableActions: [])
        let service = RecordingGroupJoinService(latestGroup: revoked)
        let model = makeModel(groupJoinService: service)
        model.session = makeSession(phoneVerified: false)

        model.requireGroupJoinTrust(for: initial, inviteCode: nil) {
            XCTFail("An unverified session must not execute immediately")
        }
        model.markPhoneVerified()
        try await waitUntil { await service.requestCounts().loads == 1 }

        let operations = await service.operations()
        let counts = await service.requestCounts()
        XCTAssertEqual(operations, [.load(initial.id)])
        XCTAssertEqual(counts.joins, 0)
    }

    func testRecoveryNeverBlindlyJoinsAFullClosingOrAlreadyJoinedGroup() async throws {
        let unavailableGroups = [
            makeGroup(memberCount: 50, capacity: 50),
            makeGroup(status: "closing"),
            makeGroup(membershipStatus: "active"),
        ]

        for latest in unavailableGroups {
            let initial = makeGroup()
            let service = RecordingGroupJoinService(latestGroup: latest)
            let model = makeModel(groupJoinService: service)
            model.session = makeSession(phoneVerified: false)

            model.requireGroupJoinTrust(for: initial, inviteCode: nil) {
                XCTFail("An unverified session must not execute immediately")
            }
            model.markPhoneVerified()
            try await waitUntil { await service.requestCounts().loads == 1 }

            let counts = await service.requestCounts()
            XCTAssertEqual(counts.joins, 0, "Unavailable state: \(latest)")
        }
    }

    func testRecoveryNeverJoinsAGroupWithADifferentIdentityThanTheDeferredIntent() async throws {
        let initial = makeGroup()
        let unexpected = makeGroup(
            id: UUID(uuidString: "019b0000-0000-7000-8200-000000000099")!
        )
        let service = RecordingGroupJoinService(latestGroup: unexpected)
        let model = makeModel(groupJoinService: service)
        model.session = makeSession(phoneVerified: false)

        model.requireGroupJoinTrust(for: initial, inviteCode: nil) {
            XCTFail("An unverified session must not execute immediately")
        }
        model.markPhoneVerified()
        try await waitUntil { await service.requestCounts().loads == 1 }

        let counts = await service.requestCounts()
        XCTAssertEqual(counts.joins, 0)
    }

    private func makeModel(groupJoinService: some GroupJoinServing) -> AppModel {
        let persistence = PersistenceStore.makeInMemory()
        let api = SpottAPIClient(
            environment: .preview,
            credentials: DeferredGroupJoinCredentialStore(),
            usesCredentials: false
        )
        return AppModel(
            api: api,
            analytics: AnalyticsClient(environment: .preview),
            persistence: persistence,
            sync: SyncEngine(api: api, persistence: persistence),
            router: AppRouter(),
            syncLifecycle: ImmediateGroupJoinSyncLifecycle(),
            groupJoinService: groupJoinService,
            discovery: DiscoveryStore(
                service: EmptyGroupJoinDiscoveryService(),
                cache: persistence,
                debounce: .zero
            )
        )
    }

    private func makeSession(phoneVerified: Bool) -> UserSession {
        UserSession(
            accessToken: "access",
            refreshToken: "refresh",
            sessionId: UUID(uuidString: "019b0000-0000-7000-8100-000000000001")!,
            accessTokenExpiresAt: Date(timeIntervalSince1970: 1_800_000_000),
            user: .init(
                id: UUID(uuidString: "019b0000-0000-7000-8100-000000000002")!,
                publicHandle: "member",
                phoneVerified: phoneVerified,
                restrictions: []
            )
        )
    }

    private func makeGroup(
        id: UUID = UUID(uuidString: "019b0000-0000-7000-8200-000000000001")!,
        joinMode: GroupJoinMode = .open,
        memberCount: Int = 12,
        capacity: Int = 50,
        status: String = "active",
        membershipStatus: String? = nil,
        availableActions: [String] = ["joinGroup"]
    ) -> GroupSummary {
        let ownerID = UUID(uuidString: "019b0000-0000-7000-8200-000000000002")!
        return GroupSummary(
            id: id,
            ownerId: ownerID,
            owner: .init(id: ownerID, name: "Mika", handle: "mika"),
            name: "Weekend Walks",
            slug: "weekend-walks",
            description: "A welcoming community.",
            joinMode: joinMode,
            regionId: "tokyo",
            categoryId: "outdoor",
            tags: ["walking"],
            rules: "Be kind.",
            capacity: capacity,
            memberCount: memberCount,
            status: status,
            membershipStatus: membershipStatus,
            membershipRole: nil,
            viewerFollowing: false,
            announcementSummary: [],
            closingAt: nil,
            dissolveAfter: nil,
            availableActions: availableActions,
            version: 1,
            updatedAt: Date(timeIntervalSince1970: 1_773_792_000)
        )
    }

    private func waitUntil(
        timeout: Duration = .seconds(1),
        _ predicate: @escaping @Sendable () async -> Bool
    ) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while !(await predicate()) {
            guard clock.now < deadline else {
                XCTFail("Timed out waiting for the deferred group join")
                return
            }
            try await Task.sleep(for: .milliseconds(10))
        }
    }
}

private actor RecordingGroupJoinService: GroupJoinServing {
    enum Operation: Equatable {
        case load(UUID)
        case join(UUID, String?)
    }

    struct Counts: Equatable {
        let loads: Int
        let joins: Int
    }

    private let latestGroup: GroupSummary
    private var recordedOperations: [Operation] = []

    init(latestGroup: GroupSummary) {
        self.latestGroup = latestGroup
    }

    func group(identifier: String) async throws -> GroupSummary {
        let id = UUID(uuidString: identifier) ?? latestGroup.id
        recordedOperations.append(.load(id))
        return latestGroup
    }

    func joinGroup(id: UUID, inviteCode: String?) async throws -> GroupMembership {
        recordedOperations.append(.join(id, inviteCode))
        return .init(groupId: id, status: "active")
    }

    func requestCounts() -> Counts {
        .init(
            loads: recordedOperations.filter { if case .load = $0 { true } else { false } }.count,
            joins: recordedOperations.filter { if case .join = $0 { true } else { false } }.count
        )
    }

    func operations() -> [Operation] { recordedOperations }
}

private actor EmptyGroupJoinDiscoveryService: DiscoveryServing {
    func discovery(_ query: EventDiscoveryQuery) async throws -> DiscoveryPage {
        _ = query
        return .init(
            items: [],
            nextCursor: nil,
            hasMore: false,
            serverTime: Date(timeIntervalSince1970: 1_773_792_000),
            queryExplanationId: "deferred-group-join-test"
        )
    }
}

private actor ImmediateGroupJoinSyncLifecycle: SyncLifecycleManaging {
    func bootstrap(userID: UUID, generation: UInt64) async throws {
        _ = (userID, generation)
    }

    func deactivateScope(reason: ScopeDeactivationReason, generation: UInt64) async throws {
        _ = (reason, generation)
    }
}

private actor DeferredGroupJoinCredentialStore: CredentialStoring {
    func save(session: UserSession) throws { _ = session }
    func replace(session: UserSession, expectedSessionID: UUID) throws -> Bool {
        _ = (session, expectedSessionID)
        return false
    }
    func session() throws -> UserSession? { nil }
    func clear(expectedSessionID: UUID) throws -> Bool {
        _ = expectedSessionID
        return false
    }
}
