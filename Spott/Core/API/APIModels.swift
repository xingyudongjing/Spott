import Foundation

struct EventSummary: Codable, Identifiable, Hashable, Sendable {
    let id: UUID
    let publicSlug: String
    let organizerId: UUID
    let status: String
    let title: String
    let startsAt: Date?
    let endsAt: Date?
    let displayTimeZone: String
    let region: String
    let publicArea: String
    let capacity: Int
    let confirmedCount: Int
    let priceLabel: String
    let coverURL: URL?
    let tags: [String]
    var availableActions: [EventAction]
    let version: Int
    let updatedAt: Date
    var description: String?
    var exactAddress: String?
    var registrationStatus: String?
    var fee: EventFee?
    var organizerName: String? = nil
    var organizerHandle: String? = nil
    var favorited: Bool? = nil
    var attendeeRequirements: String? = nil
    var riskFlags: [String]? = nil
    var riskDetails: [String: String]? = nil
    var groupId: UUID? = nil
    var checkinMode: String? = nil
    var commentPermission: String? = nil
    var posterEnabled: Bool? = nil
    var exactAddressVisibility: String? = nil
    var registrationQuestions: [RegistrationQuestion]? = nil

    var remaining: Int { max(0, capacity - confirmedCount) }
}

struct EventFee: Codable, Hashable, Sendable {
    let isFree: Bool
    let amountJPY: Int?
    let collectorName: String?
    let method: String?
    let paymentDeadlineText: String?
    let refundPolicy: String?
    let boundaryStatement: String
}

struct EventDraftInput: Codable, Sendable {
    struct Fee: Codable, Sendable {
        let isFree: Bool
        let amountJPY: Int?
        let collectorName: String?
        let method: String?
        let paymentDeadlineText: String?
        let refundPolicy: String?
    }

    struct Question: Codable, Sendable, Identifiable {
        private var localID = UUID()
        let serverID: UUID?
        let prompt: String
        let kind: String
        let required: Bool
        let options: [String]

        var id: UUID { serverID ?? localID }

        init(
            id: UUID? = nil,
            prompt: String,
            kind: String,
            required: Bool,
            options: [String]
        ) {
            serverID = id
            self.prompt = prompt
            self.kind = kind
            self.required = required
            self.options = options
        }

        enum CodingKeys: String, CodingKey {
            case serverID = "id"
            case prompt, kind, required, options
        }
    }

    let title: String
    let description: String
    let categoryId: String
    let startsAt: Date
    let endsAt: Date
    var deadlineAt: Date? = nil
    let regionId: String
    let publicArea: String
    let exactAddress: String
    let capacity: Int
    let registrationMode: String
    let waitlistEnabled: Bool
    let fee: Fee
    var tags: [String] = []
    var attendeeRequirements: String? = nil
    var riskFlags: [String] = []
    var riskDetails: [String: String] = [:]
    var groupId: UUID? = nil
    var checkinMode: String = "dynamic_qr"
    var commentPermission: String = "participants"
    var posterEnabled: Bool = true
    var exactAddressVisibility: String = "confirmed"
    var registrationQuestions: [Question] = []
}

enum RegistrationQuestionKind: String, Codable, Hashable, Sendable {
    case text
    case singleChoice = "single_choice"
    case boolean
}

struct RegistrationQuestion: Codable, Identifiable, Hashable, Sendable {
    let id: UUID
    let prompt: String
    let kind: RegistrationQuestionKind
    let required: Bool
    let options: [String]
}

enum RegistrationAnswer: Codable, Hashable, Sendable {
    case text(String)
    case choice(String)
    case boolean(Bool)

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(Bool.self) {
            self = .boolean(value)
        } else {
            self = .text(try container.decode(String.self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .text(let value), .choice(let value): try container.encode(value)
        case .boolean(let value): try container.encode(value)
        }
    }
}

struct RegistrationRequestPayload: Encodable, Sendable {
    let partySize: Int
    let quoteId: String
    let joinWaitlistIfFull: Bool
    let answers: [String: RegistrationAnswer]
    let attendeeNote: String?

    init(
        partySize: Int,
        quoteID: UUID,
        joinWaitlistIfFull: Bool,
        answers: [UUID: RegistrationAnswer],
        attendeeNote: String? = nil
    ) {
        self.partySize = partySize
        quoteId = quoteID.uuidString.lowercased()
        self.joinWaitlistIfFull = joinWaitlistIfFull
        self.answers = Dictionary(uniqueKeysWithValues: answers.map {
            ($0.key.uuidString.lowercased(), $0.value)
        })
        self.attendeeNote = attendeeNote?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    }
}

enum EventAction: String, Codable, Hashable, Sendable {
    case register, joinWaitlist, cancelRegistration, viewTicket, checkIn, edit, submit, cancelEvent, appeal, joinGroup
    var requiresPhone: Bool { [.register, .joinWaitlist, .edit, .submit, .joinGroup].contains(self) }
}

struct DiscoveryPage: Codable, Sendable {
    let items: [EventSummary]
    let nextCursor: String?
    let hasMore: Bool
    let serverTime: Date
    let queryExplanationId: String
}

struct EventCollection: Codable, Sendable { let items: [EventSummary] }

struct UserSession: Codable, Sendable {
    struct User: Codable, Sendable {
        let id: UUID
        let publicHandle: String
        let phoneVerified: Bool
        let restrictions: [String]
    }
    let accessToken: String
    let refreshToken: String
    let sessionId: UUID
    let accessTokenExpiresAt: Date
    let user: User
}

struct AppleAuthenticationPayload: Codable, Sendable {
    let identityToken: String
    let nonce: String
    let deviceId: String
    let platform: String

    init(identityToken: String, nonce: String, deviceId: UUID) {
        self.identityToken = identityToken
        self.nonce = nonce
        self.deviceId = deviceId.uuidString.lowercased()
        self.platform = "ios"
    }
}

struct GoogleAuthenticationPayload: Codable, Sendable {
    let idToken: String
    let deviceId: String

    init(idToken: String, deviceId: UUID) {
        self.idToken = idToken
        self.deviceId = deviceId.uuidString.lowercased()
    }
}

enum SafetyTargetType: String, Codable, CaseIterable, Sendable {
    case event
    case group
    case user
    case comment
    case announcement
}

struct SafetyReportPayload: Codable, Sendable {
    let targetType: SafetyTargetType
    let targetId: String
    let reason: String
    let details: String?
    let evidenceAssetIds: [String]

    init(
        targetType: SafetyTargetType,
        targetId: UUID,
        reason: String,
        details: String?,
        evidenceAssetIds: [UUID]
    ) {
        self.targetType = targetType
        self.targetId = targetId.uuidString.lowercased()
        self.reason = reason
        self.details = details
        self.evidenceAssetIds = evidenceAssetIds.map { $0.uuidString.lowercased() }
    }
}

struct SafetyReportReceipt: Codable, Sendable {
    let reference: String
    let status: String
    let submittedAt: Date
}

struct SafetyCase: Codable, Identifiable, Sendable {
    struct Appeal: Codable, Identifiable, Sendable {
        let id: UUID
        let status: String
        let createdAt: Date?
        let decidedAt: Date?
    }

    let reference: String
    let relationship: String
    let targetType: SafetyTargetType
    let targetId: UUID
    let reason: String
    let severity: String
    let status: String
    let caseStatus: String?
    let decision: String?
    let slaDueAt: Date?
    let createdAt: Date
    let updatedAt: Date
    let appeal: Appeal?

    var id: String { reference }
    var canAppeal: Bool {
        appeal == nil && ["decided", "closed"].contains(caseStatus ?? "")
    }
}

struct SafetyCasePage: Codable, Sendable { let items: [SafetyCase] }

struct SafetyAppealPayload: Codable, Sendable {
    let caseReference: String
    let statement: String
}

struct SafetyAppealReceipt: Codable, Identifiable, Sendable {
    let id: UUID
    let caseReference: String
    let status: String
    let createdAt: Date
}

enum FeedbackTag: String, Codable, CaseIterable, Identifiable, Sendable {
    case friendly
    case wellOrganized = "well_organized"
    case clearInformation = "clear_information"
    case safe
    case wouldJoinAgain = "would_join_again"

    var id: String { rawValue }
}

enum FeedbackVisibility: String, Codable, CaseIterable, Sendable {
    case `private`
    case aggregateOnly = "aggregate_only"
}

struct FeedbackSubmissionPayload: Codable, Sendable {
    let attendanceRating: Int
    let tags: [FeedbackTag]
    let comment: String?
    let visibility: FeedbackVisibility
}

struct FeedbackReceipt: Codable, Identifiable, Sendable {
    let id: UUID
    let eventId: UUID
    let status: String
    let editCount: Int
    let rewardPoints: Int
    let createdAt: Date
}

struct FeedbackSummary: Codable, Sendable {
    struct Tag: Codable, Identifiable, Sendable {
        let tag: FeedbackTag
        let count: Int
        let rate: Double
        var id: FeedbackTag { tag }
    }

    let sampleSize: Int
    let minimumSampleSize: Int
    let published: Bool
    let tags: [Tag]
}

struct PrivateFeedback: Codable, Identifiable, Sendable {
    let id: UUID
    let tags: [FeedbackTag]
    let privateSuggestion: String?
    let createdAt: Date
    let updatedAt: Date
}

struct PrivateFeedbackPage: Codable, Sendable { let items: [PrivateFeedback] }

struct CheckInCorrection: Codable, Identifiable, Sendable {
    let id: UUID
    let registrationId: UUID
    let status: String
    let rewardPoints: Int?
    let createdAt: Date?
}

struct HostCheckInCorrection: Codable, Identifiable, Sendable {
    struct RegistrationReference: Codable, Sendable {
        let id: UUID
        let userId: UUID
        let status: String
        let partySize: Int
    }

    struct Attendee: Codable, Sendable {
        let id: UUID
        let nickname: String
        let publicHandle: String
    }

    let id: UUID
    let eventId: UUID
    let registration: RegistrationReference
    let attendee: Attendee
    let reason: String
    let status: String
    let createdAt: Date
    let decidedAt: Date?
}

struct HostCheckInCorrectionPage: Codable, Sendable { let items: [HostCheckInCorrection] }

struct BlockedUser: Codable, Identifiable, Sendable {
    let userId: UUID
    let publicHandle: String
    let nickname: String?
    let reason: String?
    let blockedAt: Date
    var id: UUID { userId }
}

struct BlockedUserPage: Codable, Sendable { let items: [BlockedUser] }
struct BlockMutation: Codable, Sendable { let userId: UUID; let blocked: Bool }

struct NotificationPreference: Codable, Identifiable, Sendable {
    let type: String
    let inApp: Bool
    let push: Bool
    let email: Bool
    let quietHours: String?
    let locale: String
    var id: String { type }
}

struct NotificationPreferencePage: Codable, Sendable { let items: [NotificationPreference] }

struct NotificationPreferenceUpdate: Codable, Sendable {
    let inApp: Bool
    let push: Bool
    let email: Bool
    let quietStart: String?
    let quietEnd: String?
    let locale: String
}

struct NotificationPreferenceUpdateResult: Codable, Sendable {
    let type: String
    let inApp: Bool
    let push: Bool
    let email: Bool
    let quietStart: String?
    let quietEnd: String?
    let locale: String
    let updatedAt: Date
}

struct PushDeviceRegistration: Codable, Identifiable, Sendable {
    let id: UUID
    let tokenHash: String
    let platform: String
    let lastSeenAt: Date
}

struct DeletionSchedule: Codable, Sendable { let executeAfter: Date }
struct DeletionCancellation: Codable, Sendable { let cancelled: Bool }
struct AppleStoreTransactionPayload: Codable, Sendable { let signedTransaction: String }

struct StorePointProduct: Codable, Identifiable, Sendable {
    let productId: String
    let points: Int
    let bonusPoints: Int
    var id: String { productId }
}

struct StoreProductCatalog: Codable, Sendable {
    let store: String
    let items: [StorePointProduct]
}

extension UserSession {
    static let preview = UserSession(
        accessToken: "preview-access",
        refreshToken: "preview-refresh",
        sessionId: UUID(),
        accessTokenExpiresAt: .now.addingTimeInterval(900),
        user: .init(id: UUID(), publicHandle: "tokyo_hikari", phoneVerified: true, restrictions: [])
    )
}

struct WalletSnapshot: Codable, Sendable {
    let paidBalance: Int
    let freeBalance: Int
    let totalBalance: Int
    let version: Int
}

struct Registration: Codable, Identifiable, Sendable {
    let id: UUID
    let eventId: UUID
    let userId: UUID?
    let status: String
    let partySize: Int
    let attendeeNote: String?
    let availableActions: [EventAction]?
    let version: Int
    let offerExpiresAt: Date?
    let updatedAt: Date?
    let rewardPoints: Int?
    let checkinMethod: String?
}

struct EventAttendee: Codable, Identifiable, Sendable {
    struct Identity: Codable, Sendable {
        let id: UUID
        let nickname: String
        let publicHandle: String
    }

    let id: UUID
    let eventId: UUID
    let userId: UUID
    let status: String
    let partySize: Int
    let attendeeNote: String?
    let offerExpiresAt: Date?
    let availableActions: [EventAction]
    let version: Int
    let updatedAt: Date
    let attendee: Identity
    let answers: [String: JSONValue]
}

struct CheckInCode: Codable, Sendable {
    let mode: String
    let token: String?
    let code: String?
    let validFrom: Date
    let validUntil: Date
}

struct CheckInRequestPayload: Encodable, Sendable {
    enum ValidationError: Error, Equatable, Sendable { case credentialCount, codeFormat }

    let registrationId: String
    let operationId: String
    let token: String?
    let code: String?
    let deviceRecordedAt: Date?

    init(
        registrationID: UUID,
        operationID: UUID,
        token: String? = nil,
        code: String? = nil,
        deviceRecordedAt: Date? = .now
    ) throws {
        let cleanToken = token?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        let cleanCode = code?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        guard (cleanToken != nil) != (cleanCode != nil) else { throw ValidationError.credentialCount }
        if let cleanCode, cleanCode.count != 6 || !cleanCode.allSatisfy(\.isNumber) {
            throw ValidationError.codeFormat
        }
        registrationId = registrationID.uuidString.lowercased()
        operationId = operationID.uuidString.lowercased()
        self.token = cleanToken
        self.code = cleanCode
        self.deviceRecordedAt = deviceRecordedAt
    }
}

struct ManualCheckInRequestPayload: Encodable, Sendable {
    let registrationId: String
    let operationId: String
    let deviceRecordedAt: Date

    init(registrationID: UUID, operationID: UUID = UUID(), deviceRecordedAt: Date = .now) {
        registrationId = registrationID.uuidString.lowercased()
        operationId = operationID.uuidString.lowercased()
        self.deviceRecordedAt = deviceRecordedAt
    }
}

struct RegistrationCancellation: Codable, Sendable {
    let registration: Registration
    let refundedPoints: Int
    let wallet: WalletSnapshot
}

enum GroupJoinMode: String, Codable, CaseIterable, Identifiable, Sendable {
    case open
    case approval
    case inviteOnly = "invite_only"
    var id: String { rawValue }
}

struct GroupPerson: Codable, Hashable, Sendable {
    let id: UUID
    let name: String
    let handle: String
}

struct GroupAnnouncement: Codable, Identifiable, Hashable, Sendable {
    let id: UUID
    let groupId: UUID
    let authorId: UUID
    let authorName: String?
    let title: String
    let body: String
    let visibility: String
    let commentsEnabled: Bool
    let pinnedAt: Date?
    let likeCount: Int
    let viewerLiked: Bool
    let commentCount: Int
    let version: Int
    let createdAt: Date
    let updatedAt: Date
}

struct GroupSummary: Codable, Identifiable, Hashable, Sendable {
    let id: UUID
    let ownerId: UUID
    let owner: GroupPerson
    let name: String
    let slug: String
    let description: String
    let joinMode: GroupJoinMode
    let regionId: String
    let categoryId: String?
    let tags: [String]
    let rules: String
    let capacity: Int
    let memberCount: Int
    let status: String
    let membershipStatus: String?
    let membershipRole: String?
    let viewerFollowing: Bool
    let announcementSummary: [GroupAnnouncement]
    let closingAt: Date?
    let dissolveAfter: Date?
    let availableActions: [String]
    let version: Int
    let updatedAt: Date
    var coverURL: URL? = nil
}

struct GroupPage: Codable, Sendable { let items: [GroupSummary] }

struct GroupCreationPayload: Codable, Sendable {
    let quoteId: String
    let name: String
    let slug: String
    let description: String
    let joinMode: GroupJoinMode
    let regionId: String
    let categoryId: String
    let tags: [String]
    let rules: String

    init(
        quoteId: UUID,
        name: String,
        slug: String,
        description: String,
        joinMode: GroupJoinMode,
        regionId: String,
        categoryId: String,
        tags: [String],
        rules: String
    ) {
        self.quoteId = quoteId.uuidString.lowercased()
        self.name = name
        self.slug = slug
        self.description = description
        self.joinMode = joinMode
        self.regionId = regionId
        self.categoryId = categoryId
        self.tags = tags
        self.rules = rules
    }
}

struct GroupMembership: Codable, Sendable {
    let groupId: UUID
    let status: String
}

struct GroupAnnouncementPage: Codable, Sendable {
    let items: [GroupAnnouncement]
    let hasMore: Bool
    let nextCursor: String?
}

struct GroupComment: Codable, Identifiable, Sendable {
    let id: UUID
    let announcementId: UUID
    let author: GroupPersonSummary
    let body: String
    let parentId: UUID?
    let locale: String
    let version: Int
    let createdAt: Date
    let updatedAt: Date
}

struct GroupPersonSummary: Codable, Sendable {
    let id: UUID
    let name: String
}

struct GroupCommentPage: Codable, Sendable { let items: [GroupComment] }

struct GroupMember: Codable, Identifiable, Sendable {
    let user: GroupPerson
    let role: String
    let status: String
    let joinedAt: Date
    let updatedAt: Date
    var id: UUID { user.id }
}

struct GroupMemberPage: Codable, Sendable {
    let items: [GroupMember]
    let hasMore: Bool
    let nextCursor: String?
}

struct GroupMemberMutation: Codable, Sendable {
    let groupId: UUID
    let userId: UUID
    let role: String
    let status: String
}

struct GroupInvite: Codable, Identifiable, Sendable {
    let id: UUID
    let groupId: UUID
    let code: String
    let expiresAt: Date
}

struct GroupFollowMutation: Codable, Sendable {
    let groupId: UUID
    let following: Bool
}

struct GroupAnnouncementLikeMutation: Codable, Sendable {
    let announcementId: UUID
    let liked: Bool
}

struct GroupLifecycleMutation: Codable, Identifiable, Sendable {
    let id: UUID
    let groupId: UUID
    let state: String
    let scheduledFor: Date?
    let cooldownUntil: Date?
    let expiresAt: Date?
    let ownerId: UUID?
    let fromUserId: UUID?
    let toUserId: UUID?
}

struct ShareLinkReceipt: Codable, Identifiable, Sendable {
    let id: UUID
    let code: String
    let url: URL
    let createdAt: Date
}

struct ShareLinkResolution: Codable, Sendable {
    let resourceType: String
    let resourceId: UUID
    let canonicalPath: String
    let sessionId: UUID
}

struct UserProfile: Codable, Sendable {
    let userId: UUID
    let nickname: String
    let bio: String
    let regionId: String?
    let avatarURL: URL?
    let version: Int
    let updatedAt: Date
}

struct PublicUserProfile: Codable, Identifiable, Sendable {
    let userId: UUID
    let nickname: String
    let bio: String
    let regionId: String?
    let avatarURL: URL?
    let preferredLocale: String
    let contentLanguages: [String]
    let version: Int
    let updatedAt: Date
    let publicHandle: String
    let followerCount: Int
    let viewerFollowing: Bool
    var id: UUID { userId }
}

struct PublicHostedEvent: Codable, Identifiable, Sendable {
    let id: UUID
    let publicSlug: String
    let status: String
    let title: String
    let startsAt: Date
    let endsAt: Date
    let region: String
    let publicArea: String
    let priceLabel: String
    let coverURL: URL?
}

struct PublicHostedEventPage: Codable, Sendable {
    let items: [PublicHostedEvent]
    let hasMore: Bool
    let nextCursor: String?
}

struct ProfileAvatarAttachment: Codable, Sendable {
    let assetId: UUID
    let profileId: UUID
    let url: URL
    let version: Int
}

struct GroupCoverAttachment: Codable, Sendable {
    let assetId: UUID
    let groupId: UUID
    let url: URL
    let version: Int
}

struct PosterJobReceipt: Codable, Identifiable, Sendable {
    let id: UUID
    let state: String
    let createdAt: Date
}

struct PosterJob: Codable, Identifiable, Sendable {
    let id: UUID
    let state: String
    let assetId: UUID?
    let url: URL?
    let failureCode: String?
    let template: String
    let locale: String
    let updatedAt: Date
}

struct ActiveGroupTransfer: Codable, Identifiable, Sendable {
    let id: UUID
    let groupId: UUID
    let fromUserId: UUID
    let toUserId: UUID
    let state: String
    let expiresAt: Date
    let cooldownUntil: Date?
}

extension GroupLifecycleMutation {
    init(active transfer: ActiveGroupTransfer) {
        self.init(
            id: transfer.id,
            groupId: transfer.groupId,
            state: transfer.state,
            scheduledFor: nil,
            cooldownUntil: transfer.cooldownUntil,
            expiresAt: transfer.expiresAt,
            ownerId: nil,
            fromUserId: transfer.fromUserId,
            toUserId: transfer.toUserId
        )
    }
}

enum AccountMergeCredential: Encodable, Sendable {
    case apple(identityToken: String, nonce: String, platform: String)
    case google(idToken: String)
    case email(challengeId: UUID, code: String)

    private enum CodingKeys: String, CodingKey {
        case provider, identityToken, nonce, platform, idToken, challengeId, code
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .apple(let identityToken, let nonce, let platform):
            try container.encode("apple", forKey: .provider)
            try container.encode(identityToken, forKey: .identityToken)
            try container.encode(nonce, forKey: .nonce)
            try container.encode(platform, forKey: .platform)
        case .google(let idToken):
            try container.encode("google", forKey: .provider)
            try container.encode(idToken, forKey: .idToken)
        case .email(let challengeId, let code):
            try container.encode("email", forKey: .provider)
            try container.encode(challengeId.uuidString.lowercased(), forKey: .challengeId)
            try container.encode(code, forKey: .code)
        }
    }
}

struct AccountMergePreviewRequest: Encodable, Sendable {
    let credential: AccountMergeCredential
}

struct AccountMergeImpact: Codable, Sendable {
    struct Wallet: Codable, Sendable {
        let paid: Int
        let free: Int
    }

    let ownedEvents: Int
    let ownedGroups: Int
    let sourceWallet: Wallet
    let targetWallet: Wallet
}

struct AccountMergePreview: Codable, Identifiable, Sendable {
    let jobId: UUID
    let mergeToken: String
    let expiresAt: Date
    let sourceUserId: UUID
    let targetUserId: UUID
    let impact: AccountMergeImpact
    let conflicts: [String]
    let canCommit: Bool
    let requiresSecondVerification: Bool
    var id: UUID { jobId }
}

struct AccountMergeCommitRequest: Encodable, Sendable {
    let jobId: UUID
    let mergeToken: String
    let deviceId: UUID
    let platform: String

    private enum CodingKeys: String, CodingKey { case jobId, mergeToken, deviceId, platform }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(jobId.uuidString.lowercased(), forKey: .jobId)
        try container.encode(mergeToken, forKey: .mergeToken)
        try container.encode(deviceId.uuidString.lowercased(), forKey: .deviceId)
        try container.encode(platform, forKey: .platform)
    }
}

struct UserFollowMutation: Codable, Sendable {
    let targetUserId: UUID
    let following: Bool
}

struct Achievement: Codable, Identifiable, Sendable {
    let id: UUID
    let code: String
    let audience: String
    let ruleVersion: Int
    let visibility: String
    let awardedAt: Date
    let revokedAt: Date?
    let evidence: JSONValue?
}

struct AchievementPage: Codable, Sendable { let items: [Achievement] }

struct WalletTransaction: Codable, Identifiable, Sendable {
    let id: UUID
    let type: String
    let status: String
    let paidDelta: Int
    let freeDelta: Int
    let occurredAt: Date
}

struct MediaUploadIntent: Codable, Sendable {
    let assetId: UUID
    let method: String
    let uploadUrl: URL
    let requiredHeaders: [String: String]
    let expiresAt: Date
    let maxBytes: Int
}

struct MediaProcessingState: Codable, Sendable {
    let assetId: UUID
    let state: String
    let moderationState: String
}

struct NotificationItem: Codable, Identifiable, Sendable {
    let id: UUID
    let type: String
    let resourceType: String?
    let resourcePublicId: String?
    let createdAt: Date
    let readAt: Date?
}

struct CursorPage<Value: Codable & Sendable>: Codable, Sendable {
    let items: [Value]
    let nextCursor: String?
    let hasMore: Bool
}

struct APIProblem: Codable, Sendable {
    struct Detail: Codable, Sendable {
        struct Field: Codable, Sendable { let field: String; let message: String }
        struct Action: Codable, Sendable { let type: String; let label: String }
        let code: String
        let message: String
        let requestId: String?
        let retryable: Bool?
        let fieldErrors: [Field]?
        let actions: [Action]?
        let meta: [String: JSONValue]?
    }
    let error: Detail
}

enum JSONValue: Codable, Hashable, Sendable {
    case string(String), number(Double), bool(Bool), object([String: JSONValue]), array([JSONValue]), null
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([String: JSONValue].self) { self = .object(value) }
        else { self = .array(try container.decode([JSONValue].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self { case .string(let value): try container.encode(value); case .number(let value): try container.encode(value); case .bool(let value): try container.encode(value); case .object(let value): try container.encode(value); case .array(let value): try container.encode(value); case .null: try container.encodeNil() }
    }
}

extension EventSummary {
    static let samples: [EventSummary] = [
        .init(id: UUID(uuidString: "019B0000-0000-7000-8100-000000000001")!, publicSlug: "tokyo-afterglow-walk", organizerId: UUID(), status: "published", title: "东京余光 · 隅田川蓝调散步", startsAt: ISO8601DateFormatter().date(from: "2026-07-18T08:30:00Z"), endsAt: ISO8601DateFormatter().date(from: "2026-07-18T11:00:00Z"), displayTimeZone: "Asia/Tokyo", region: "tokyo", publicArea: "清澄白河站附近", capacity: 24, confirmedCount: 12, priceLabel: "免费", coverURL: nil, tags: ["city-walk", "摄影"], availableActions: [.register], version: 1, updatedAt: .now, description: "从清澄白河走到隅田川，在入夜前后记录城市颜色。", exactAddress: nil, registrationStatus: nil, fee: nil),
        .init(id: UUID(uuidString: "019B0000-0000-7000-8100-000000000002")!, publicSlug: "shimokita-vinyl-night", organizerId: UUID(), status: "published", title: "下北泽黑胶交换夜", startsAt: ISO8601DateFormatter().date(from: "2026-07-20T10:00:00Z"), endsAt: nil, displayTimeZone: "Asia/Tokyo", region: "tokyo", publicArea: "下北泽", capacity: 16, confirmedCount: 8, priceLabel: "免费", coverURL: nil, tags: ["music", "新朋友"], availableActions: [.register], version: 1, updatedAt: .now, description: "带一张最近循环播放的唱片，认识同样认真听歌的人。", exactAddress: nil, registrationStatus: nil, fee: nil)
    ]
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
