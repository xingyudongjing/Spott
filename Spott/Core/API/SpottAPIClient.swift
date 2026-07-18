import CryptoKit
import Foundation

struct APIEnvironment: Sendable {
    let baseURL: URL
    static let `default`: APIEnvironment = {
        if let configured = ProcessInfo.processInfo.environment["SPOTT_API_BASE_URL"],
           let url = URL(string: configured) {
            return APIEnvironment(baseURL: url)
        }
#if DEBUG
        return APIEnvironment(baseURL: URL(string: "http://127.0.0.1:4100/v1")!)
#else
        return APIEnvironment(baseURL: URL(string: "https://api.spott.jp/v1")!)
#endif
    }()
    static let preview = APIEnvironment(baseURL: URL(string: "https://api.spott.invalid/v1")!)
}

struct APIFieldError: Equatable, Sendable {
    let field: String
    let message: String
}

struct APIError: Error, Sendable {
    let status: Int
    let code: String
    let message: String
    let retryable: Bool
    let fieldErrors: [APIFieldError]

    init(
        status: Int,
        code: String,
        message: String,
        retryable: Bool,
        fieldErrors: [APIFieldError] = []
    ) {
        self.status = status
        self.code = code
        self.message = message
        self.retryable = retryable
        self.fieldErrors = fieldErrors
    }
}

protocol SessionEnding: Actor {
    @discardableResult
    func signOut(expectedSessionID: UUID) async throws -> Bool
}

protocol SessionRestoring: Actor {
    func currentSession() async throws -> UserSession?
}

actor SpottAPIClient: SessionEnding, SessionRestoring {
    private enum AuthenticationPolicy: Sendable {
        case required
        case optional
        case none

        var permitsRefresh: Bool {
            switch self {
            case .required, .optional: true
            case .none: false
            }
        }
    }

    private struct AuthenticatedRequestContext: Sendable {
        let userID: UUID?
        let sessionID: UUID?

        init(session: UserSession?) {
            userID = session?.user.id
            sessionID = session?.sessionId
        }
    }

    private struct RefreshFlight {
        let sessionID: UUID
        let task: Task<UserSession, Error>
    }

    private let environment: APIEnvironment
    private let credentials: any CredentialStoring
    private let session: URLSession
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private let usesCredentials: Bool
    private nonisolated let serverTimeAuthority: ServerTimeAuthority
    private nonisolated let authenticationExpirationBoundary: AuthenticationExpirationBoundary
    private var refreshFlight: RefreshFlight?

    init(
        environment: APIEnvironment,
        credentials: any CredentialStoring,
        session: URLSession = .shared,
        usesCredentials: Bool = true,
        serverTimeAuthority: ServerTimeAuthority = .init(),
        authenticationExpirationBoundary: AuthenticationExpirationBoundary = .init()
    ) {
        self.environment = environment
        self.credentials = credentials
        self.session = session
        self.usesCredentials = usesCredentials
        self.serverTimeAuthority = serverTimeAuthority
        self.authenticationExpirationBoundary = authenticationExpirationBoundary
        encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
    }

    func discovery(_ query: EventDiscoveryQuery) async throws -> DiscoveryPage {
        var components = URLComponents(
            url: environment.baseURL.appending(path: "events/search"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = query.queryItems
        let page: DiscoveryPage = try await send(
            URLRequest(url: components.url!),
            authentication: .optional
        )
        serverTimeAuthority.calibrate(serverTime: page.serverTime)
        return page
    }

    func discoveryFeed(_ query: EventDiscoveryQuery) async throws -> DiscoveryFeed {
        var components = URLComponents(
            url: environment.baseURL.appending(path: "discovery/feed"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = query.queryItems.filter { $0.name != "cursor" }
        let feed: DiscoveryFeed = try await send(
            URLRequest(url: components.url!),
            authentication: .optional
        )
        serverTimeAuthority.calibrate(serverTime: feed.serverTime)
        return feed
    }

    func discovery(region: String, query: String? = nil) async throws -> DiscoveryPage {
        try await discovery(.init(q: query, region: region))
    }

    func event(identifier: String) async throws -> EventSummary {
        try await send(URLRequest(url: environment.baseURL.appending(path: "events/\(identifier)")))
    }

    nonisolated func authoritativeNow() -> Date {
        serverTimeAuthority.now()
    }

    nonisolated func setAuthenticationExpirationHandler(
        _ handler: @escaping AuthenticationExpirationBoundary.Handler
    ) {
        authenticationExpirationBoundary.setHandler(handler)
    }

    func wallet() async throws -> WalletSnapshot {
        try await send(URLRequest(url: environment.baseURL.appending(path: "wallet")))
    }

    func notifications() async throws -> CursorPage<NotificationItem> {
        try await send(URLRequest(url: environment.baseURL.appending(path: "notifications")))
    }

    func markNotificationRead(_ id: UUID) async throws {
        var request = URLRequest(url: environment.baseURL.appending(path: "notifications/items/\(id.uuidString.lowercased())/read"))
        request.httpMethod = "PUT"
        let _: EmptyResponse = try await send(request)
    }

    func notificationPreferences() async throws -> NotificationPreferencePage {
        try await send(URLRequest(url: environment.baseURL.appending(path: "notifications/preferences")))
    }

    func updateNotificationPreference(
        type: String,
        update: NotificationPreferenceUpdate
    ) async throws -> NotificationPreferenceUpdateResult {
        var request = URLRequest(url: environment.baseURL.appending(path: "notifications/preferences/\(type)"))
        request.httpMethod = "PUT"
        request.httpBody = try encoder.encode(update)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return try await send(request)
    }

    func registerPushDevice(token: String, environment: String) async throws -> PushDeviceRegistration {
        struct Body: Encodable, Sendable {
            let deviceId: String
            let platform: String
            let token: String
            let environment: String
        }
        return try await post(
            "notifications/device-tokens",
            body: Body(
                deviceId: DeviceIdentity.current.uuidString.lowercased(),
                platform: "ios",
                token: token,
                environment: environment
            )
        )
    }

    func registrationItinerary(
        cursor: String? = nil,
        limit: Int = 50
    ) async throws -> RegistrationItineraryPage {
        var components = URLComponents(url: environment.baseURL.appending(path: "me/registrations"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "limit", value: String(min(max(limit, 1), 100)))
        ]
        if let cursor, !cursor.isEmpty {
            components.queryItems?.append(URLQueryItem(name: "cursor", value: cursor))
        }
        let page: RegistrationItineraryPage = try await send(
            URLRequest(url: components.url!)
        )
        serverTimeAuthority.calibrate(serverTime: page.serverTime)
        return page
    }

    func registrations(limit: Int = 50) async throws -> CursorPage<Registration> {
        let page = try await registrationItinerary(limit: limit)
        return CursorPage(
            items: page.items.map(\.registration),
            nextCursor: page.nextCursor,
            hasMore: page.hasMore
        )
    }

    func acceptWaitlist(
        registrationID: UUID,
        quoteID: UUID,
        expectedRegistrationVersion: Int,
        expectedEventVersion: Int,
        idempotencyKey: UUID
    ) async throws -> Registration {
        try await post(
            "registrations/\(registrationID.uuidString.lowercased())/waitlist-acceptance",
            body: WaitlistAcceptancePayload(
                quoteID: quoteID,
                expectedRegistrationVersion: expectedRegistrationVersion,
                expectedEventVersion: expectedEventVersion
            ),
            idempotencyKey: idempotencyKey
        )
    }

    func cancelRegistration(registrationID: UUID) async throws -> RegistrationCancellation {
        try await post(
            "registrations/\(registrationID.uuidString.lowercased())/cancel",
            body: EmptyRequest(),
            idempotencyKey: UUID()
        )
    }

    func hostedEvents() async throws -> EventCollection {
        try await send(URLRequest(url: environment.baseURL.appending(path: "me/hosted-events")))
    }

    func eventAttendees(eventID: UUID, status: String? = nil, limit: Int = 100) async throws -> CursorPage<EventAttendee> {
        var components = URLComponents(
            url: environment.baseURL.appending(path: "events/\(eventID.uuidString.lowercased())/attendees"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [URLQueryItem(name: "limit", value: String(min(max(limit, 1), 100)))]
        if let status { components.queryItems?.append(URLQueryItem(name: "status", value: status)) }
        return try await send(URLRequest(url: components.url!))
    }

    func decideRegistration(registrationID: UUID, approve: Bool, reason: String? = nil) async throws -> Registration {
        struct Body: Encodable, Sendable { let decision: String; let reason: String? }
        return try await post(
            "registrations/\(registrationID.uuidString.lowercased())/decision",
            body: Body(decision: approve ? "approve" : "reject", reason: reason),
            idempotencyKey: UUID()
        )
    }

    func createCheckInCode(eventID: UUID, mode: String? = nil) async throws -> CheckInCode {
        struct Body: Encodable, Sendable { let mode: String? }
        return try await post(
            "events/\(eventID.uuidString.lowercased())/checkin-codes",
            body: Body(mode: mode)
        )
    }

    func checkIn(_ payload: CheckInRequestPayload, idempotencyKey: UUID) async throws -> Registration {
        try await post("checkins", body: payload, idempotencyKey: idempotencyKey)
    }

    func manualCheckIn(eventID: UUID, registrationID: UUID) async throws -> Registration {
        try await post(
            "events/\(eventID.uuidString.lowercased())/checkins/manual",
            body: ManualCheckInRequestPayload(registrationID: registrationID),
            idempotencyKey: UUID()
        )
    }

    func requestCheckInCorrection(registrationID: UUID, reason: String) async throws -> CheckInCorrection {
        try await post(
            "registrations/\(registrationID.uuidString.lowercased())/checkin-corrections",
            body: ["reason": reason]
        )
    }

    func checkInCorrections(
        eventID: UUID,
        status: String? = "pending",
        limit: Int = 100
    ) async throws -> HostCheckInCorrectionPage {
        var components = URLComponents(
            url: environment.baseURL.appending(path: "events/\(eventID.uuidString.lowercased())/checkin-corrections"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [URLQueryItem(name: "limit", value: String(min(max(limit, 1), 100)))]
        if let status { components.queryItems?.append(.init(name: "status", value: status)) }
        return try await send(URLRequest(url: components.url!))
    }

    func decideCheckInCorrection(
        correctionID: UUID,
        approve: Bool,
        reason: String? = nil
    ) async throws -> CheckInCorrection {
        struct Body: Encodable, Sendable { let decision: String; let reason: String? }
        return try await post(
            "checkin-corrections/\(correctionID.uuidString.lowercased())/decision",
            body: Body(decision: approve ? "approve" : "reject", reason: reason)
        )
    }

    func submitFeedback(
        registrationID: UUID,
        payload: FeedbackSubmissionPayload,
        idempotencyKey: UUID
    ) async throws -> FeedbackReceipt {
        try await post(
            "registrations/\(registrationID.uuidString.lowercased())/feedback",
            body: payload,
            idempotencyKey: idempotencyKey
        )
    }

    func ownFeedback(registrationID: UUID) async throws -> OwnFeedbackState {
        try await send(
            URLRequest(
                url: environment.baseURL.appending(
                    path: "registrations/\(registrationID.uuidString.lowercased())/feedback"
                )
            )
        )
    }

    func feedbackSummary(eventID: UUID) async throws -> FeedbackSummary {
        try await send(
            URLRequest(url: environment.baseURL.appending(path: "events/\(eventID.uuidString.lowercased())/feedback-summary")),
            authentication: .none
        )
    }

    func privateFeedback(eventID: UUID) async throws -> PrivateFeedbackPage {
        try await send(
            URLRequest(url: environment.baseURL.appending(path: "events/\(eventID.uuidString.lowercased())/feedback/private"))
        )
    }

    func favoriteEvents() async throws -> EventCollection {
        try await send(URLRequest(url: environment.baseURL.appending(path: "me/favorite-events")))
    }

    func setFavorite(eventID: UUID, enabled: Bool) async throws {
        var request = URLRequest(url: environment.baseURL.appending(path: "events/\(eventID.uuidString.lowercased())/favorite"))
        request.httpMethod = enabled ? "PUT" : "DELETE"
        let _: EmptyResponse = try await send(request)
    }

    func groups() async throws -> GroupPage {
        try await send(URLRequest(url: environment.baseURL.appending(path: "me/groups")))
    }

    func discoverGroups(
        region: String? = nil,
        category: String? = nil,
        query: String? = nil,
        limit: Int = 50
    ) async throws -> GroupPage {
        var components = URLComponents(
            url: environment.baseURL.appending(path: "groups"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [URLQueryItem(name: "limit", value: String(min(max(limit, 1), 100)))]
        if let region, !region.isEmpty { components.queryItems?.append(.init(name: "region", value: region)) }
        if let category, !category.isEmpty { components.queryItems?.append(.init(name: "category", value: category)) }
        if let query, !query.isEmpty { components.queryItems?.append(.init(name: "q", value: query)) }
        return try await send(URLRequest(url: components.url!))
    }

    func group(identifier: String) async throws -> GroupSummary {
        try await send(URLRequest(url: environment.baseURL.appending(path: "groups/\(identifier)")))
    }

    func createGroup(_ payload: GroupCreationPayload) async throws -> GroupSummary {
        return try await post(
            "groups",
            body: payload,
            idempotencyKey: UUID()
        )
    }

    func joinGroup(id: UUID, inviteCode: String? = nil) async throws -> GroupMembership {
        struct Body: Encodable, Sendable { let inviteCode: String? }
        return try await post(
            "groups/\(id.uuidString.lowercased())/join",
            body: Body(inviteCode: inviteCode),
            idempotencyKey: UUID()
        )
    }

    func setGroupFollow(id: UUID, following: Bool) async throws -> GroupFollowMutation {
        var request = URLRequest(url: environment.baseURL.appending(path: "groups/\(id.uuidString.lowercased())/follow"))
        request.httpMethod = following ? "PUT" : "DELETE"
        return try await send(request)
    }

    func groupAnnouncements(id: UUID) async throws -> GroupAnnouncementPage {
        try await send(
            URLRequest(url: environment.baseURL.appending(path: "groups/\(id.uuidString.lowercased())/announcements"))
        )
    }

    func createGroupAnnouncement(
        groupID: UUID,
        title: String,
        body: String,
        visibility: String,
        commentsEnabled: Bool
    ) async throws -> GroupAnnouncement {
        struct Body: Encodable, Sendable {
            let title: String
            let body: String
            let visibility: String
            let commentsEnabled: Bool
        }
        return try await post(
            "groups/\(groupID.uuidString.lowercased())/announcements",
            body: Body(title: title, body: body, visibility: visibility, commentsEnabled: commentsEnabled),
            idempotencyKey: UUID()
        )
    }

    func updateGroupAnnouncement(
        groupID: UUID,
        announcementID: UUID,
        version: Int,
        title: String,
        body: String,
        visibility: String,
        commentsEnabled: Bool
    ) async throws -> GroupAnnouncement {
        struct Body: Encodable, Sendable {
            let title: String
            let body: String
            let visibility: String
            let commentsEnabled: Bool
        }
        var request = URLRequest(
            url: environment.baseURL.appending(
                path: "groups/\(groupID.uuidString.lowercased())/announcements/\(announcementID.uuidString.lowercased())"
            )
        )
        request.httpMethod = "PATCH"
        request.httpBody = try encoder.encode(
            Body(title: title, body: body, visibility: visibility, commentsEnabled: commentsEnabled)
        )
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("\"\(version)\"", forHTTPHeaderField: "If-Match")
        return try await send(request)
    }

    func deleteGroupAnnouncement(groupID: UUID, announcementID: UUID) async throws {
        var request = URLRequest(
            url: environment.baseURL.appending(
                path: "groups/\(groupID.uuidString.lowercased())/announcements/\(announcementID.uuidString.lowercased())"
            )
        )
        request.httpMethod = "DELETE"
        let _: EmptyResponse = try await send(request)
    }

    func groupComments(groupID: UUID, announcementID: UUID) async throws -> GroupCommentPage {
        try await send(
            URLRequest(
                url: environment.baseURL.appending(
                    path: "groups/\(groupID.uuidString.lowercased())/announcements/\(announcementID.uuidString.lowercased())/comments"
                )
            )
        )
    }

    func createGroupComment(
        groupID: UUID,
        announcementID: UUID,
        body: String,
        parentID: UUID? = nil,
        locale: String
    ) async throws -> GroupComment {
        struct Body: Encodable, Sendable {
            let body: String
            let parentId: String?
            let locale: String
        }
        return try await post(
            "groups/\(groupID.uuidString.lowercased())/announcements/\(announcementID.uuidString.lowercased())/comments",
            body: Body(body: body, parentId: parentID?.uuidString.lowercased(), locale: locale),
            idempotencyKey: UUID()
        )
    }

    func updateGroupComment(id: UUID, version: Int, body: String) async throws -> GroupComment {
        var request = URLRequest(url: environment.baseURL.appending(path: "comments/\(id.uuidString.lowercased())"))
        request.httpMethod = "PATCH"
        request.httpBody = try encoder.encode(["body": body])
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("\"\(version)\"", forHTTPHeaderField: "If-Match")
        return try await send(request)
    }

    func deleteGroupComment(id: UUID) async throws {
        var request = URLRequest(url: environment.baseURL.appending(path: "comments/\(id.uuidString.lowercased())"))
        request.httpMethod = "DELETE"
        let _: EmptyResponse = try await send(request)
    }

    func setGroupAnnouncementLiked(
        groupID: UUID,
        announcementID: UUID,
        liked: Bool
    ) async throws -> GroupAnnouncementLikeMutation {
        var request = URLRequest(
            url: environment.baseURL.appending(
                path: "groups/\(groupID.uuidString.lowercased())/announcements/\(announcementID.uuidString.lowercased())/like"
            )
        )
        request.httpMethod = liked ? "PUT" : "DELETE"
        return try await send(request)
    }

    func groupMembers(id: UUID) async throws -> GroupMemberPage {
        try await send(
            URLRequest(url: environment.baseURL.appending(path: "groups/\(id.uuidString.lowercased())/members"))
        )
    }

    func updateGroupMember(
        groupID: UUID,
        userID: UUID,
        role: String? = nil,
        status: String? = nil
    ) async throws -> GroupMemberMutation {
        struct Body: Encodable, Sendable { let role: String?; let status: String? }
        var request = URLRequest(
            url: environment.baseURL.appending(
                path: "groups/\(groupID.uuidString.lowercased())/members/\(userID.uuidString.lowercased())"
            )
        )
        request.httpMethod = "PATCH"
        request.httpBody = try encoder.encode(Body(role: role, status: status))
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return try await send(request)
    }

    func createGroupInvite(id: UUID, maxUses: Int, expiresInHours: Int) async throws -> GroupInvite {
        try await post(
            "groups/\(id.uuidString.lowercased())/invites",
            body: ["maxUses": maxUses, "expiresInHours": expiresInHours]
        )
    }

    func purchaseGroupCapacity(id: UUID, quoteID: UUID) async throws -> GroupSummary {
        try await post(
            "groups/\(id.uuidString.lowercased())/capacity-purchases",
            body: ["quoteId": quoteID.uuidString.lowercased()],
            idempotencyKey: UUID()
        )
    }

    func startGroupTransfer(groupID: UUID, targetUserID: UUID) async throws -> GroupLifecycleMutation {
        try await post(
            "groups/\(groupID.uuidString.lowercased())/transfers",
            body: ["targetUserId": targetUserID.uuidString.lowercased()]
        )
    }

    func activeGroupTransfer(groupID: UUID) async throws -> ActiveGroupTransfer {
        try await send(
            URLRequest(
                url: environment.baseURL.appending(
                    path: "groups/\(groupID.uuidString.lowercased())/transfers/active"
                )
            )
        )
    }

    func acceptGroupTransfer(groupID: UUID, transferID: UUID) async throws -> GroupLifecycleMutation {
        try await post(
            "groups/\(groupID.uuidString.lowercased())/transfers/\(transferID.uuidString.lowercased())/accept",
            body: EmptyRequest()
        )
    }

    func completeGroupTransfer(groupID: UUID, transferID: UUID) async throws -> GroupLifecycleMutation {
        try await post(
            "groups/\(groupID.uuidString.lowercased())/transfers/\(transferID.uuidString.lowercased())/complete",
            body: EmptyRequest()
        )
    }

    func cancelGroupTransfer(groupID: UUID, transferID: UUID, reason: String) async throws -> GroupLifecycleMutation {
        try await post(
            "groups/\(groupID.uuidString.lowercased())/transfers/\(transferID.uuidString.lowercased())/cancel",
            body: ["reason": reason]
        )
    }

    func requestGroupDissolution(id: UUID, reason: String) async throws -> GroupLifecycleMutation {
        try await post("groups/\(id.uuidString.lowercased())/dissolution", body: ["reason": reason])
    }

    func cancelGroupDissolution(id: UUID) async throws -> GroupLifecycleMutation {
        var request = URLRequest(url: environment.baseURL.appending(path: "groups/\(id.uuidString.lowercased())/dissolution"))
        request.httpMethod = "DELETE"
        return try await send(request)
    }

    func finalizeGroupDissolution(id: UUID) async throws -> GroupLifecycleMutation {
        try await post(
            "groups/\(id.uuidString.lowercased())/dissolution/finalize",
            body: EmptyRequest()
        )
    }

    func profile() async throws -> UserProfile {
        try await send(URLRequest(url: environment.baseURL.appending(path: "me/profile")))
    }

    func publicProfile(identifier: String) async throws -> PublicUserProfile {
        try await send(URLRequest(url: environment.baseURL.appending(path: "profiles/\(identifier)")))
    }

    func publicProfileEvents(
        identifier: String,
        cursor: String? = nil,
        limit: Int = 20
    ) async throws -> PublicHostedEventPage {
        var components = URLComponents(
            url: environment.baseURL.appending(path: "profiles/\(identifier)/events"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [URLQueryItem(name: "limit", value: String(min(max(limit, 1), 50)))]
        if let cursor { components.queryItems?.append(.init(name: "cursor", value: cursor)) }
        return try await send(URLRequest(url: components.url!), authentication: .none)
    }

    func createShareLink(
        resourceType: String,
        resourceID: UUID,
        campaign: String? = nil
    ) async throws -> ShareLinkReceipt {
        struct Body: Encodable, Sendable {
            let resourceType: String
            let resourceId: String
            let campaign: String?
        }
        return try await post(
            "shares",
            body: Body(
                resourceType: resourceType,
                resourceId: resourceID.uuidString.lowercased(),
                campaign: campaign
            )
        )
    }

    func resolveShareLink(code: String) async throws -> ShareLinkResolution {
        try await send(
            URLRequest(url: environment.baseURL.appending(path: "shares/\(code)")),
            authentication: .none
        )
    }

    func createPoster(
        resourceType: String,
        resourceID: UUID,
        template: String = "tokyo_afterglow",
        locale: String,
        mode: String = "template"
    ) async throws -> PosterJobReceipt {
        struct Body: Encodable, Sendable {
            let resourceType: String
            let resourceId: String
            let template: String
            let locale: String
            let mode: String
        }
        return try await post(
            "posters",
            body: Body(
                resourceType: resourceType,
                resourceId: resourceID.uuidString.lowercased(),
                template: template,
                locale: locale,
                mode: mode
            )
        )
    }

    func poster(jobID: UUID) async throws -> PosterJob {
        try await send(
            URLRequest(url: environment.baseURL.appending(path: "posters/\(jobID.uuidString.lowercased())"))
        )
    }

    func eventPoster(eventID: UUID) async throws -> PosterJob {
        try await send(
            URLRequest(url: environment.baseURL.appending(path: "events/\(eventID.uuidString.lowercased())/poster"))
        )
    }

    func setProfileFollow(identifier: String, following: Bool) async throws -> UserFollowMutation {
        var request = URLRequest(url: environment.baseURL.appending(path: "profiles/\(identifier)/follow"))
        request.httpMethod = following ? "PUT" : "DELETE"
        return try await send(request)
    }

    func updateProfile(_ profile: UserProfile, nickname: String, bio: String, regionID: String) async throws -> UserProfile {
        struct Body: Encodable, Sendable { let nickname: String; let bio: String; let regionId: String }
        var request = URLRequest(url: environment.baseURL.appending(path: "me/profile"))
        request.httpMethod = "PATCH"
        request.httpBody = try encoder.encode(Body(nickname: nickname, bio: bio, regionId: regionID))
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("\"\(profile.version)\"", forHTTPHeaderField: "If-Match")
        return try await send(request)
    }

    func achievements() async throws -> AchievementPage {
        try await send(URLRequest(url: environment.baseURL.appending(path: "me/achievements")))
    }

    func submitSafetyReport(
        _ report: SafetyReportPayload,
        idempotencyKey: UUID
    ) async throws -> SafetyReportReceipt {
        try await post("reports", body: report, idempotencyKey: idempotencyKey)
    }

    func safetyCases() async throws -> SafetyCasePage {
        try await send(URLRequest(url: environment.baseURL.appending(path: "me/safety-cases")))
    }

    func submitSafetyAppeal(reference: String, statement: String) async throws -> SafetyAppealReceipt {
        try await post(
            "appeals",
            body: SafetyAppealPayload(
                caseReference: reference.trimmingCharacters(in: .whitespacesAndNewlines).uppercased(),
                statement: statement
            )
        )
    }

    func blockedUsers() async throws -> BlockedUserPage {
        try await send(URLRequest(url: environment.baseURL.appending(path: "me/blocks")))
    }

    func setUserBlocked(_ userID: UUID, blocked: Bool, reason: String? = nil) async throws -> BlockMutation {
        struct Body: Encodable, Sendable { let reason: String? }
        var request = URLRequest(url: environment.baseURL.appending(path: "users/\(userID.uuidString.lowercased())/block"))
        request.httpMethod = blocked ? "PUT" : "DELETE"
        if blocked {
            request.httpBody = try encoder.encode(Body(reason: reason))
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return try await send(request)
    }

    func requestAccountDeletion() async throws -> DeletionSchedule {
        try await post("accounts/deletion-request", body: EmptyRequest(), idempotencyKey: UUID())
    }

    func cancelAccountDeletion() async throws -> DeletionCancellation {
        var request = URLRequest(url: environment.baseURL.appending(path: "accounts/deletion-request"))
        request.httpMethod = "DELETE"
        return try await send(request)
    }

    func previewAccountMerge(credential: AccountMergeCredential) async throws -> AccountMergePreview {
        try await post(
            "accounts/merge/preview",
            body: AccountMergePreviewRequest(credential: credential)
        )
    }

    func commitAccountMerge(_ preview: AccountMergePreview) async throws -> UserSession {
        let response: UserSession = try await post(
            "accounts/merge/commit",
            body: AccountMergeCommitRequest(
                jobId: preview.jobId,
                mergeToken: preview.mergeToken,
                deviceId: DeviceIdentity.current,
                platform: "ios"
            ),
            idempotencyKey: UUID()
        )
        try await credentials.save(session: response)
        return response
    }

    func creditAppleStoreTransaction(_ signedTransaction: String) async throws -> WalletSnapshot {
        try await post(
            "store/apple/transactions",
            body: AppleStoreTransactionPayload(signedTransaction: signedTransaction),
            idempotencyKey: UUID()
        )
    }

    func storeProducts() async throws -> StoreProductCatalog {
        try await send(
            URLRequest(url: environment.baseURL.appending(path: "store/products")),
            authentication: .none
        )
    }

    func walletTransactions(limit: Int = 50) async throws -> CursorPage<WalletTransaction> {
        var components = URLComponents(url: environment.baseURL.appending(path: "wallet/transactions"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "limit", value: String(limit))]
        return try await send(URLRequest(url: components.url!))
    }

    func uploadEventImage(data: Data, filename: String, mimeType: String, eventID: UUID, sortOrder: Int) async throws -> UUID {
        let assetID = try await uploadMediaAsset(
            data: data,
            filename: filename,
            mimeType: mimeType,
            purpose: "event_cover"
        )
        struct AttachBody: Encodable, Sendable { let kind: String; let sortOrder: Int }
        let _: MediaAttachment = try await post(
            "media/\(assetID.uuidString.lowercased())/attach/event/\(eventID.uuidString.lowercased())",
            body: AttachBody(kind: sortOrder == 0 ? "cover" : "gallery", sortOrder: sortOrder)
        )
        return assetID
    }

    func uploadProfileAvatar(data: Data, filename: String, mimeType: String) async throws -> ProfileAvatarAttachment {
        let assetID = try await uploadMediaAsset(
            data: data,
            filename: filename,
            mimeType: mimeType,
            purpose: "profile_avatar"
        )
        return try await attachProcessedMedia(
            path: "media/\(assetID.uuidString.lowercased())/attach/profile"
        )
    }

    func uploadGroupCover(
        data: Data,
        filename: String,
        mimeType: String,
        groupID: UUID
    ) async throws -> GroupCoverAttachment {
        let assetID = try await uploadMediaAsset(
            data: data,
            filename: filename,
            mimeType: mimeType,
            purpose: "group_cover"
        )
        return try await attachProcessedMedia(
            path: "media/\(assetID.uuidString.lowercased())/attach/group/\(groupID.uuidString.lowercased())"
        )
    }

    private func uploadMediaAsset(
        data: Data,
        filename: String,
        mimeType: String,
        purpose: String
    ) async throws -> UUID {
        struct IntentBody: Encodable, Sendable {
            let purpose: String
            let filename: String
            let mimeType: String
            let byteSize: Int
            let focalX: Double
            let focalY: Double
        }
        let intent: MediaUploadIntent = try await post(
            "media/upload-intents",
            body: IntentBody(purpose: purpose, filename: filename, mimeType: mimeType, byteSize: data.count, focalX: 0.5, focalY: 0.5)
        )
        var upload = URLRequest(url: intent.uploadUrl)
        upload.httpMethod = intent.method
        for (name, value) in intent.requiredHeaders { upload.setValue(value, forHTTPHeaderField: name) }
        let (_, response) = try await session.upload(for: upload, from: data)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError(status: (response as? HTTPURLResponse)?.statusCode ?? 0, code: "MEDIA_UPLOAD_FAILED", message: "图片上传失败，请重试。", retryable: true)
        }
        let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        var complete = URLRequest(url: environment.baseURL.appending(path: "media/\(intent.assetId.uuidString.lowercased())/complete"))
        complete.httpMethod = "POST"
        complete.setValue(hash, forHTTPHeaderField: "X-Content-SHA256")
        let _: MediaProcessingState = try await send(complete)
        return intent.assetId
    }

    private func attachProcessedMedia<Response: Decodable & Sendable>(path: String) async throws -> Response {
        var lastError: APIError?
        for attempt in 0..<8 {
            do {
                return try await post(path, body: EmptyRequest())
            } catch let error as APIError where error.code == "MEDIA_NOT_READY" || error.status == 409 {
                lastError = error
                if attempt < 7 {
                    try await Task.sleep(for: .milliseconds(750))
                }
            }
        }
        throw lastError ?? APIError(
            status: 409,
            code: "MEDIA_NOT_READY",
            message: "图片仍在安全处理，请稍后重试。",
            retryable: true
        )
    }

    func requestEmailCode(email: String, deviceID: UUID) async throws -> EmailChallenge {
        try await post(
            "auth/email/challenges",
            body: ["email": email, "deviceId": deviceID.uuidString.lowercased()],
            authentication: .none
        )
    }

    func authenticateApple(identityToken: String, nonce: String, deviceID: UUID) async throws -> UserSession {
        let response: UserSession = try await post(
            "auth/apple",
            body: AppleAuthenticationPayload(identityToken: identityToken, nonce: nonce, deviceId: deviceID),
            authentication: .none
        )
        try await credentials.save(session: response)
        return response
    }

    func authenticateGoogle(idToken: String, deviceID: UUID) async throws -> UserSession {
        let response: UserSession = try await post(
            "auth/google",
            body: GoogleAuthenticationPayload(idToken: idToken, deviceId: deviceID),
            authentication: .none
        )
        try await credentials.save(session: response)
        return response
    }

    func verifyEmail(challengeID: UUID, code: String, deviceID: UUID) async throws -> UserSession {
        let response: UserSession = try await post(
            "auth/email/verify",
            body: [
                "challengeId": challengeID.uuidString.lowercased(),
                "code": code,
                "deviceId": deviceID.uuidString.lowercased(),
            ],
            authentication: .none
        )
        try await credentials.save(session: response)
        return response
    }

    func requestPhoneCode(phone: String, deviceID: UUID) async throws -> PhoneChallenge {
        try await post("phone/challenges", body: ["phoneNumber": phone, "deviceId": deviceID.uuidString.lowercased()])
    }

    func verifyPhone(challengeID: UUID, code: String) async throws -> PhoneVerification {
        let verification: PhoneVerification = try await post("phone/challenges/\(challengeID.uuidString.lowercased())/verify", body: ["code": code])
        _ = try await refresh()
        return verification
    }

    func quote(purpose: String, resourceID: UUID?) async throws -> Quote {
        var body = ["purpose": purpose]
        if let resourceID { body["resourceId"] = resourceID.uuidString.lowercased() }
        return try await post("quotes", body: body)
    }

    func register(
        eventID: UUID,
        partySize: Int,
        quoteID: UUID,
        expectedEventVersion: Int,
        joinWaitlist: Bool,
        answers: [UUID: RegistrationAnswer] = [:],
        attendeeNote: String? = nil,
        idempotencyKey: UUID
    ) async throws -> Registration {
        let payload = RegistrationRequestPayload(
            partySize: partySize,
            quoteID: quoteID,
            expectedEventVersion: expectedEventVersion,
            joinWaitlistIfFull: joinWaitlist,
            answers: answers,
            attendeeNote: attendeeNote
        )
        return try await post(
            "events/\(eventID.uuidString.lowercased())/registrations",
            body: payload,
            idempotencyKey: idempotencyKey
        )
    }

    func createEventDraft(_ draft: EventDraftInput) async throws -> EventSummary {
        try await post("events/drafts", body: draft, idempotencyKey: UUID())
    }

    func createBlankEventDraft() async throws -> EventSummary {
        try await post("events/drafts", body: EmptyRequest(), idempotencyKey: UUID())
    }

    func updateEventDraft(id: UUID, version: Int, draft: EventDraftInput) async throws -> EventSummary {
        var request = URLRequest(url: environment.baseURL.appending(path: "events/\(id.uuidString.lowercased())"))
        request.httpMethod = "PATCH"
        request.httpBody = try encoder.encode(draft)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(UUID().uuidString.lowercased(), forHTTPHeaderField: "Idempotency-Key")
        request.setValue("\"\(version)\"", forHTTPHeaderField: "If-Match")
        return try await send(request)
    }

    func submitEvent(id: UUID, version: Int, quoteID: UUID) async throws -> EventSummary {
        var request = URLRequest(url: environment.baseURL.appending(path: "events/\(id.uuidString.lowercased())/submit"))
        request.httpMethod = "POST"
        request.httpBody = try encoder.encode(["quoteId": quoteID.uuidString.lowercased()])
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(UUID().uuidString.lowercased(), forHTTPHeaderField: "Idempotency-Key")
        request.setValue("\"\(version)\"", forHTTPHeaderField: "If-Match")
        return try await send(request)
    }

    func pull(cursor: Int64, topics: [String]) async throws -> SyncPullPage {
        var components = URLComponents(url: environment.baseURL.appending(path: "sync/pull"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "cursor", value: String(cursor)), URLQueryItem(name: "topics", value: topics.joined(separator: ","))]
        let page: SyncPullPage = try await send(URLRequest(url: components.url!))
        serverTimeAuthority.calibrate(serverTime: page.serverTime)
        return page
    }

    func push(operations: [SyncPushOperation]) async throws -> SyncPushResponse {
        struct Body: Encodable, Sendable {
            let deviceId: String
            let operations: [SyncPushOperation]
        }
        return try await post(
            "sync/push",
            body: Body(
                deviceId: DeviceIdentity.current.uuidString.lowercased(),
                operations: operations
            )
        )
    }

    func currentSession() async throws -> UserSession? { try await credentials.session() }
    func refreshCurrentSession() async throws -> UserSession { try await refresh() }
    @discardableResult
    func signOut(expectedSessionID: UUID) async throws -> Bool {
        try await credentials.clear(expectedSessionID: expectedSessionID)
    }

    private func post<Response: Decodable & Sendable, Body: Encodable & Sendable>(
        _ path: String,
        body: Body,
        authentication: AuthenticationPolicy = .required,
        idempotencyKey: UUID? = nil
    ) async throws -> Response {
        var request = URLRequest(url: environment.baseURL.appending(path: path))
        request.httpMethod = "POST"
        request.httpBody = try encoder.encode(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let idempotencyKey { request.setValue(idempotencyKey.uuidString.lowercased(), forHTTPHeaderField: "Idempotency-Key") }
        return try await send(request, authentication: authentication)
    }

    private func send<Response: Decodable & Sendable>(
        _ source: URLRequest,
        authentication: AuthenticationPolicy = .required,
        canRefresh: Bool = true,
        requestContext: AuthenticatedRequestContext? = nil
    ) async throws -> Response {
        var request = source
        var context = requestContext
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(UUID().uuidString.lowercased(), forHTTPHeaderField: "X-Request-Id")
        if context == nil, usesCredentials {
            let stored: UserSession?
            switch authentication {
            case .required:
                stored = try await credentials.session()
            case .optional:
                do {
                    stored = try await credentials.session()
                } catch is VaultError {
                    stored = nil
                }
            case .none:
                stored = nil
            }
            if let stored {
                context = .init(session: stored)
                request.setValue("Bearer \(stored.accessToken)", forHTTPHeaderField: "Authorization")
            }
        }
        var attempt = 0
        while true {
            try Task.checkCancellation()
            try await ensureActiveAuthentication(context)
            do {
                let (data, response) = try await session.data(for: request)
                guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
                serverTimeAuthority.calibrate(
                    httpDate: http.value(forHTTPHeaderField: "Date")
                )
                try await ensureActiveAuthentication(context)
                if http.statusCode == 401,
                   authentication.permitsRefresh,
                   canRefresh,
                   let sessionID = context?.sessionID,
                   let userID = context?.userID {
                    let refreshed = try await refresh(
                        expectedSessionID: sessionID,
                        expectedUserID: userID
                    )
                    request.setValue("Bearer \(refreshed.accessToken)", forHTTPHeaderField: "Authorization")
                    return try await send(
                        request,
                        authentication: authentication,
                        canRefresh: false,
                        requestContext: .init(session: refreshed)
                    )
                }
                guard (200..<300).contains(http.statusCode) else { throw decodeError(data: data, status: http.statusCode) }
                if Response.self == EmptyResponse.self { return EmptyResponse() as! Response }
                return try decoder.decode(Response.self, from: data)
            } catch is CancellationError { throw CancellationError() }
            catch let error as URLError where error.code == .cancelled { throw CancellationError() }
            catch let error as APIError { throw error }
            catch {
                guard attempt < 2, request.httpMethod == "GET" || request.value(forHTTPHeaderField: "Idempotency-Key") != nil else { throw error }
                try await ensureActiveAuthentication(context)
                attempt += 1
                try await Task.sleep(for: .milliseconds(250 * (1 << attempt)))
                try await ensureActiveAuthentication(context)
            }
        }
    }

    private func refresh() async throws -> UserSession {
        guard let current = try await credentials.session() else {
            throw APIError(status: 401, code: "AUTH_REQUIRED", message: "请重新登录。", retryable: false)
        }
        return try await refresh(
            expectedSessionID: current.sessionId,
            expectedUserID: current.user.id
        )
    }

    private func refresh(expectedSessionID: UUID, expectedUserID: UUID) async throws -> UserSession {
        guard let current = try await credentials.session(),
              current.sessionId == expectedSessionID,
              current.user.id == expectedUserID else { throw CancellationError() }
        if let refreshFlight, refreshFlight.sessionID == current.sessionId {
            return try await refreshFlight.task.value
        }
        let task = Task {
            [
                credentials,
                environment,
                session,
                encoder,
                decoder,
                serverTimeAuthority,
                authenticationExpirationBoundary,
            ] in
            var request = URLRequest(url: environment.baseURL.appending(path: "auth/refresh"))
            request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try encoder.encode(["refreshToken": current.refreshToken, "deviceId": DeviceIdentity.current.uuidString.lowercased()])
            var attempt = 0
            while true {
                do {
                    let (data, response) = try await session.data(for: request)
                    guard let http = response as? HTTPURLResponse else {
                        throw URLError(.badServerResponse)
                    }
                    serverTimeAuthority.calibrate(
                        httpDate: http.value(forHTTPHeaderField: "Date")
                    )
                    if (http.statusCode == 429 || http.statusCode >= 500), attempt < 2 {
                        let retryAfter = http.value(forHTTPHeaderField: "Retry-After")
                            .flatMap(Double.init)
                        let fallback = 0.25 * Double(1 << attempt)
                        attempt += 1
                        try await Task.sleep(
                            for: .seconds(min(max(retryAfter ?? fallback, 0), 5))
                        )
                        continue
                    }
                    guard (200..<300).contains(http.statusCode) else {
                        let problem = try? decoder.decode(APIProblem.self, from: data)
                        let apiError = APIError(
                            status: http.statusCode,
                            code: problem?.error.code ?? "HTTP_\(http.statusCode)",
                            message: problem?.error.message ?? "请求暂时无法完成。",
                            retryable: problem?.error.retryable
                                ?? (http.statusCode == 429 || http.statusCode >= 500),
                            fieldErrors: problem?.error.fieldErrors?.map {
                                APIFieldError(field: $0.field, message: $0.message)
                            } ?? []
                        )
                        if http.statusCode == 401 {
                            guard try await credentials.clear(
                                expectedSessionID: current.sessionId
                            ) else { throw CancellationError() }
                            await authenticationExpirationBoundary.expire(
                                sessionID: current.sessionId
                            )
                        }
                        throw apiError
                    }
                    let updated = try decoder.decode(UserSession.self, from: data)
                    guard updated.user.id == current.user.id else { throw CancellationError() }
                    guard try await credentials.replace(
                        session: updated,
                        expectedSessionID: current.sessionId
                    ) else { throw CancellationError() }
                    return updated
                } catch is CancellationError {
                    throw CancellationError()
                } catch let error as APIError {
                    throw error
                } catch let error as URLError where attempt < 2 {
                    guard error.code != .cancelled else { throw CancellationError() }
                    let fallback = 0.25 * Double(1 << attempt)
                    attempt += 1
                    try await Task.sleep(for: .seconds(fallback))
                } catch {
                    throw error
                }
            }
        }
        refreshFlight = .init(sessionID: current.sessionId, task: task)
        defer {
            if refreshFlight?.sessionID == current.sessionId {
                refreshFlight = nil
            }
        }
        return try await task.value
    }

    private func ensureActiveAuthentication(
        _ context: AuthenticatedRequestContext?
    ) async throws {
        guard let context else { return }
        let active = try await credentials.session()
        guard active?.user.id == context.userID,
              active?.sessionId == context.sessionID else { throw CancellationError() }
    }

    private func decodeError(data: Data, status: Int) -> APIError {
        if let problem = try? decoder.decode(APIProblem.self, from: data) {
            return .init(
                status: status,
                code: problem.error.code,
                message: problem.error.message,
                retryable: problem.error.retryable ?? (status >= 500),
                fieldErrors: problem.error.fieldErrors?.map {
                    APIFieldError(field: $0.field, message: $0.message)
                } ?? []
            )
        }
        return .init(status: status, code: "HTTP_\(status)", message: "请求暂时无法完成。", retryable: status >= 500)
    }
}

struct EmptyResponse: Codable, Sendable {}
private struct EmptyRequest: Codable, Sendable {}
private struct MediaAttachment: Codable, Sendable { let id: UUID; let eventId: UUID; let assetId: UUID; let kind: String }
struct EmailChallenge: Codable, Sendable {
    let challengeId: UUID
    let expiresAt: Date
    let retryAfterSeconds: Int
#if DEBUG
    let developmentCode: String?
#endif
}
typealias PhoneChallenge = EmailChallenge
struct PhoneVerification: Codable, Sendable { let verifiedAt: Date; let reward: WalletSnapshot }
struct Quote: Codable, Sendable { let id: UUID; let amount: Int; let currency: String; let expiresAt: Date }

enum DeviceIdentity {
    static let current: UUID = {
        let key = "spott.device.id"
        if let value = UserDefaults.standard.string(forKey: key), let id = UUID(uuidString: value) { return id }
        let id = UUID(); UserDefaults.standard.set(id.uuidString, forKey: key); return id
    }()
}
