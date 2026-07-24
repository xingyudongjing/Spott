import Foundation

enum EventFormat: String, Codable, CaseIterable, Sendable {
    case inPerson = "in_person"
    case online
    case hybrid
}

enum EventLocale: String, Codable, CaseIterable, Sendable {
    case zhHans = "zh-Hans"
    case ja
    case en
}

enum CoordinatePrecision: String, Codable, Sendable {
    case approximate
    case exact
}

enum EventPriceFilter: String, Codable, CaseIterable, Sendable {
    case free
    case paid
}

enum EventDiscoverySort: String, Codable, CaseIterable, Sendable {
    case recommended
    case time
    case newest
    case almostFull = "almost_full"
    case distance
}

struct DiscoveryNearOrigin: Hashable, Sendable {
    let latitude: Double
    let longitude: Double

    init(latitude: Double, longitude: Double) {
        self.latitude = latitude
        self.longitude = longitude
    }
}

struct EventCoordinate: Codable, Hashable, Sendable {
    let latitude: Double
    let longitude: Double
    let precision: CoordinatePrecision
}

struct MapBounds: Codable, Hashable, Sendable {
    let west: Double
    let south: Double
    let east: Double
    let north: Double
}

struct EventDiscoveryQuery: Hashable, Sendable {
    var q: String?
    var region: String?
    var category: String?
    var startsAfter: Date?
    var startsBefore: Date?
    var availableOnly: Bool?
    var format: EventFormat?
    var language: EventLocale?
    var price: EventPriceFilter?
    var bounds: MapBounds?
    var near: DiscoveryNearOrigin?
    var sort: EventDiscoverySort?
    var cursor: String?
    var limit: Int?

    init(
        q: String? = nil,
        region: String? = nil,
        category: String? = nil,
        startsAfter: Date? = nil,
        startsBefore: Date? = nil,
        availableOnly: Bool? = nil,
        format: EventFormat? = nil,
        language: EventLocale? = nil,
        price: EventPriceFilter? = nil,
        bounds: MapBounds? = nil,
        near: DiscoveryNearOrigin? = nil,
        sort: EventDiscoverySort? = nil,
        cursor: String? = nil,
        limit: Int? = nil
    ) {
        self.q = q
        self.region = region
        self.category = category
        self.startsAfter = startsAfter
        self.startsBefore = startsBefore
        self.availableOnly = availableOnly
        self.format = format
        self.language = language
        self.price = price
        self.bounds = bounds
        self.near = near
        self.sort = sort
        self.cursor = cursor
        self.limit = limit
    }

    var queryItems: [URLQueryItem] {
        var items: [URLQueryItem] = []
        append("q", q, to: &items)
        append("region", region, to: &items)
        append("category", category, to: &items)
        append("startsAfter", startsAfter?.ISO8601Format(), to: &items)
        append("startsBefore", startsBefore?.ISO8601Format(), to: &items)
        append("availableOnly", availableOnly.map(String.init), to: &items)
        append("format", format?.rawValue, to: &items)
        append("language", language?.rawValue, to: &items)
        append("price", price?.rawValue, to: &items)
        if let bounds {
            append(
                "bounds",
                [bounds.west, bounds.south, bounds.east, bounds.north]
                    .map { String(format: "%.15g", locale: Locale(identifier: "en_US_POSIX"), $0) }
                    .joined(separator: ","),
                to: &items
            )
        }
        if let near {
            append(
                "near",
                [near.latitude, near.longitude]
                    .map { String(format: "%.15g", locale: Locale(identifier: "en_US_POSIX"), $0) }
                    .joined(separator: ","),
                to: &items
            )
        }
        append("sort", sort?.rawValue, to: &items)
        append("cursor", cursor, to: &items)
        append("limit", limit.map(String.init), to: &items)
        return items
    }

    private func append(_ name: String, _ value: String?, to items: inout [URLQueryItem]) {
        guard let value, !value.isEmpty else { return }
        items.append(.init(name: name, value: value))
    }
}

struct OrganizerTrust: Codable, Hashable, Sendable {
    enum AttendanceRateBand: String, Codable, Sendable {
        case unavailable
        case under70 = "under_70"
        case from70To89 = "70_89"
        case over90 = "90_plus"
    }

    let phoneVerified: Bool
    let completedEventCount: Int
    let attendanceRateBand: AttendanceRateBand
}

struct EventOrganizer: Codable, Hashable, Sendable {
    let id: UUID
    let name: String
    let handle: String
    let viewerFollowing: Bool
    let trust: OrganizerTrust
}

struct ViewerRegistration: Codable, Hashable, Sendable {
    enum Status: String, Codable, Sendable {
        case pending
        case confirmed
        case waitlisted
        case offered
        case checkedIn = "checked_in"
    }

    let id: UUID
    let status: Status
    let partySize: Int
    let offerExpiresAt: Date?
}

struct EventSummary: Codable, Identifiable, Hashable, Sendable {
    let id: UUID
    let publicSlug: String
    let organizerId: UUID
    let status: String
    let title: String
    let description: String
    let category: String
    let startsAt: Date?
    let endsAt: Date?
    let deadlineAt: Date?
    let displayTimeZone: String
    let region: String?
    let publicArea: String?
    let capacity: Int
    let confirmedCount: Int
    let availableCapacity: Int
    let coverURL: URL?
    let tags: [String]
    let organizer: EventOrganizer
    var favorited: Bool
    var registrationStatus: String?
    let viewerRegistration: ViewerRegistration?
    let registrationMode: String
    let waitlistEnabled: Bool
    let format: EventFormat
    let primaryLocale: EventLocale
    let supportedLocales: [EventLocale]
    let localeConfirmed: Bool
    var availableActions: [EventAction]
    let version: Int
    let updatedAt: Date
    var coordinate: EventCoordinate?
    var exactAddress: String?
    var fee: EventFee?
    var attendeeRequirements: String? = nil
    var riskFlags: [String]? = nil
    var riskDetails: [String: String]? = nil
    var groupId: UUID? = nil
    var checkinMode: String? = nil
    var commentPermission: String? = nil
    var posterEnabled: Bool? = nil
    var showGuestList: Bool? = nil
    var exactAddressVisibility: String? = nil
    var registrationQuestions: [RegistrationQuestion]? = nil

    var remaining: Int { availableCapacity }
    var organizerName: String? { organizer.name }
    var organizerHandle: String? { organizer.handle }
    var priceLabel: String {
        guard let fee else { return "" }
        if fee.isFree { return "¥0" }
        if let amount = fee.amountJPY { return "¥\(amount.formatted())" }
        return [fee.collectorName, fee.method].compactMap { $0 }.joined(separator: " · ")
    }
}

struct EventFee: Codable, Hashable, Sendable {
    let isFree: Bool
    let amountJPY: Int?
    let collectorName: String?
    let method: String?
    let paymentDeadlineText: String?
    let refundPolicy: String?
    private let legacyBoundaryStatement: String?

    var boundaryStatement: String { legacyBoundaryStatement ?? "" }

    init(
        isFree: Bool,
        amountJPY: Int?,
        collectorName: String?,
        method: String?,
        paymentDeadlineText: String?,
        refundPolicy: String?,
        boundaryStatement: String? = nil
    ) {
        self.isFree = isFree
        self.amountJPY = amountJPY
        self.collectorName = collectorName
        self.method = method
        self.paymentDeadlineText = paymentDeadlineText
        self.refundPolicy = refundPolicy
        legacyBoundaryStatement = boundaryStatement
    }

    enum CodingKeys: String, CodingKey {
        case isFree, amountJPY, collectorName, method, paymentDeadlineText, refundPolicy
        case legacyBoundaryStatement = "boundaryStatement"
    }
}

struct EventCTASession: Hashable, Sendable {
    let authenticated: Bool
    let phoneVerified: Bool

    static let guest = Self(authenticated: false, phoneVerified: false)
    static let unverified = Self(authenticated: true, phoneVerified: false)
    static let verified = Self(authenticated: true, phoneVerified: true)
}

struct EventCTAState: Hashable, Sendable {
    enum Kind: String, Hashable, Sendable {
        case eventUnavailable = "event_unavailable"
        case acceptWaitlist = "accept_waitlist"
        case viewItinerary = "view_itinerary"
        case viewPending = "view_pending"
        case viewWaitlist = "view_waitlist"
        case continueLogin = "continue_login"
        case continuePhoneVerification = "continue_phone_verification"
        case registrationClosed = "registration_closed"
        case joinWaitlist = "join_waitlist"
        case fullClosed = "full_closed"
        case apply
        case register
    }

    enum Intent: String, Hashable, Sendable {
        case none
        case acceptWaitlist = "accept_waitlist"
        case itinerary
        case login
        case phoneVerification = "phone_verification"
        case register
    }

    let kind: Kind
    let intent: Intent
    let disabled: Bool
    var registrationId: String? = nil
    var offerExpiresAt: Date? = nil

    static func resolve(
        event: EventSummary,
        session: EventCTASession,
        now: Date = .now
    ) -> EventCTAState {
        if ["cancelled", "ended", "removed"].contains(event.status) {
            return disabled(.eventUnavailable)
        }

        if let registration = event.viewerRegistration,
           registration.status == .offered,
           let expiry = registration.offerExpiresAt,
           expiry > now {
            return .init(
                kind: .acceptWaitlist,
                intent: .acceptWaitlist,
                disabled: false,
                registrationId: registration.id.uuidString.lowercased(),
                offerExpiresAt: expiry
            )
        }
        if let registration = event.viewerRegistration,
           [.confirmed, .checkedIn].contains(registration.status) {
            return itinerary(.viewItinerary, registration.id)
        }
        if let registration = event.viewerRegistration, registration.status == .pending {
            return itinerary(.viewPending, registration.id)
        }
        if let registration = event.viewerRegistration, registration.status == .waitlisted {
            return itinerary(.viewWaitlist, registration.id)
        }

        let isFull = event.capacity > 0 && event.availableCapacity == 0
        let windowOpen = event.status == "published" && (event.deadlineAt.map { $0 > now } ?? true)
        let structurallyRegistrable = windowOpen && (!isFull || event.waitlistEnabled)
        if !session.authenticated && structurallyRegistrable {
            return .init(kind: .continueLogin, intent: .login, disabled: false)
        }
        if session.authenticated && !session.phoneVerified && structurallyRegistrable {
            return .init(kind: .continuePhoneVerification, intent: .phoneVerification, disabled: false)
        }

        let canRegister = event.availableActions.contains(.register)
        let canJoinWaitlist = event.availableActions.contains(.joinWaitlist)
        if !windowOpen || (!isFull && !canRegister && !canJoinWaitlist) {
            return disabled(.registrationClosed)
        }
        if isFull && event.waitlistEnabled && canJoinWaitlist {
            return .init(kind: .joinWaitlist, intent: .register, disabled: false)
        }
        if isFull { return disabled(.fullClosed) }
        if event.registrationMode == "approval" && canRegister {
            return .init(kind: .apply, intent: .register, disabled: false)
        }
        if canRegister { return .init(kind: .register, intent: .register, disabled: false) }
        return disabled(.registrationClosed)
    }

    private static func itinerary(_ kind: Kind, _ registrationID: UUID) -> EventCTAState {
        .init(
            kind: kind,
            intent: .itinerary,
            disabled: false,
            registrationId: registrationID.uuidString.lowercased()
        )
    }

    private static func disabled(_ kind: Kind) -> EventCTAState {
        .init(kind: kind, intent: .none, disabled: true)
    }
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
    var showGuestList: Bool = true
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
    let expectedEventVersion: Int
    let joinWaitlistIfFull: Bool
    let answers: [String: RegistrationAnswer]
    let attendeeNote: String?
    let ticketTypeId: String?

    init(
        partySize: Int,
        quoteID: UUID,
        expectedEventVersion: Int,
        joinWaitlistIfFull: Bool,
        answers: [UUID: RegistrationAnswer],
        attendeeNote: String? = nil,
        ticketTypeID: UUID? = nil
    ) {
        self.partySize = partySize
        quoteId = quoteID.uuidString.lowercased()
        self.expectedEventVersion = expectedEventVersion
        self.joinWaitlistIfFull = joinWaitlistIfFull
        self.answers = Dictionary(uniqueKeysWithValues: answers.map {
            ($0.key.uuidString.lowercased(), $0.value)
        })
        self.attendeeNote = attendeeNote?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        ticketTypeId = ticketTypeID?.uuidString.lowercased()
    }
}

struct WaitlistAcceptancePayload: Encodable, Sendable {
    let quoteId: String
    let expectedRegistrationVersion: Int
    let expectedEventVersion: Int

    init(
        quoteID: UUID,
        expectedRegistrationVersion: Int,
        expectedEventVersion: Int
    ) {
        quoteId = quoteID.uuidString.lowercased()
        self.expectedRegistrationVersion = expectedRegistrationVersion
        self.expectedEventVersion = expectedEventVersion
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

    init(
        items: [EventSummary],
        nextCursor: String?,
        hasMore: Bool,
        serverTime: Date,
        queryExplanationId: String
    ) {
        self.items = items.map(\.discoverySafeSummary)
        self.nextCursor = nextCursor
        self.hasMore = hasMore
        self.serverTime = serverTime
        self.queryExplanationId = queryExplanationId
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            items: try container.decode([EventSummary].self, forKey: .items),
            nextCursor: try container.decodeIfPresent(String.self, forKey: .nextCursor),
            hasMore: try container.decode(Bool.self, forKey: .hasMore),
            serverTime: try container.decode(Date.self, forKey: .serverTime),
            queryExplanationId: try container.decode(String.self, forKey: .queryExplanationId)
        )
    }

    var privacySanitized: DiscoveryPage {
        DiscoveryPage(
            items: items,
            nextCursor: nextCursor,
            hasMore: hasMore,
            serverTime: serverTime,
            queryExplanationId: queryExplanationId
        )
    }
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

struct StableIdempotencyAttempt: Equatable, Sendable {
    let idempotencyKey: UUID
    private let payloadFingerprint: Data

    static func resolve<Payload: Encodable>(
        existing: StableIdempotencyAttempt?,
        payload: Payload,
        makeKey: () -> UUID = UUID.init
    ) throws -> StableIdempotencyAttempt {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let fingerprint = try encoder.encode(payload)
        if let existing, existing.payloadFingerprint == fingerprint {
            return existing
        }
        return StableIdempotencyAttempt(
            idempotencyKey: makeKey(),
            payloadFingerprint: fingerprint
        )
    }
}

struct FeedbackReceipt: Codable, Identifiable, Sendable {
    let id: UUID
    let eventId: UUID
    let status: String
    let editCount: Int
    let rewardPoints: Int
    let createdAt: Date
}

enum FeedbackSubmissionState: String, Codable, Sendable {
    case notSubmitted = "not_submitted"
    case editAvailable = "edit_available"
    case editLimitReached = "edit_limit_reached"
    case windowClosed = "window_closed"
    case notEligible = "not_eligible"
}

struct OwnFeedback: Codable, Identifiable, Sendable {
    let id: UUID
    let attendanceRating: Int
    let tags: [FeedbackTag]
    let comment: String?
    let visibility: FeedbackVisibility
    let moderationState: String
    let editCount: Int
    let createdAt: Date?
    let updatedAt: Date?
}

struct OwnFeedbackState: Codable, Sendable {
    let registrationId: UUID
    let eventId: UUID
    let state: FeedbackSubmissionState
    let canSubmit: Bool
    let canEdit: Bool
    let windowClosesAt: Date?
    let feedback: OwnFeedback?
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

/// A host → attendee broadcast the organizer has published, as shown in the
/// organizer's own "sent" list. `recipientCount` is the number of confirmed
/// attendees who received it in their inbox.
struct EventAnnouncement: Codable, Identifiable, Sendable {
    let id: UUID
    let title: String
    let body: String
    let recipientCount: Int
    let sentAt: Date
}

/// The organizer's announcement list plus the remaining daily quota so the
/// composer can honestly show how many more can be sent today.
struct EventAnnouncementPage: Codable, Sendable {
    let items: [EventAnnouncement]
    let dailyLimit: Int
    let remainingToday: Int
}

/// The receipt returned right after publishing an announcement.
struct EventAnnouncementReceipt: Codable, Sendable {
    let announcementId: UUID
    let title: String
    let body: String
    let recipientCount: Int
    let sentAt: Date
    let dailyLimit: Int
    let remainingToday: Int
}

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

struct ItineraryEventSummary: Codable, Identifiable, Hashable, Sendable {
    let id: UUID
    let publicSlug: String
    let status: String
    let title: String
    let startsAt: Date?
    let endsAt: Date?
    let displayTimeZone: String
    let region: String?
    let publicArea: String?
    let coverURL: URL?
    let format: EventFormat
    let primaryLocale: EventLocale
    let localeConfirmed: Bool
    let version: Int
    let updatedAt: Date

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case id, publicSlug, status, title, startsAt, endsAt, displayTimeZone
        case region, publicArea, coverURL, format, primaryLocale, localeConfirmed, version, updatedAt
    }

    init(from decoder: Decoder) throws {
        try rejectUnknownItineraryKeys(CodingKeys.self, from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        publicSlug = try container.decode(String.self, forKey: .publicSlug)
        status = try container.decode(String.self, forKey: .status)
        title = try container.decode(String.self, forKey: .title)
        startsAt = try container.decode(Date?.self, forKey: .startsAt)
        endsAt = try container.decode(Date?.self, forKey: .endsAt)
        displayTimeZone = try container.decode(String.self, forKey: .displayTimeZone)
        region = try container.decode(String?.self, forKey: .region)
        publicArea = try container.decode(String?.self, forKey: .publicArea)
        coverURL = try container.decode(URL?.self, forKey: .coverURL)
        format = try container.decode(EventFormat.self, forKey: .format)
        primaryLocale = try container.decode(EventLocale.self, forKey: .primaryLocale)
        localeConfirmed = try container.decode(Bool.self, forKey: .localeConfirmed)
        version = try container.decode(Int.self, forKey: .version)
        updatedAt = try container.decode(Date.self, forKey: .updatedAt)
    }
}

struct RegistrationItineraryItem: Codable, Sendable {
    let registration: Registration
    let event: ItineraryEventSummary?

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case registration, event
    }

    init(from decoder: Decoder) throws {
        try rejectUnknownItineraryKeys(CodingKeys.self, from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        registration = try container.decode(Registration.self, forKey: .registration)
        event = try container.decode(ItineraryEventSummary?.self, forKey: .event)
    }
}

struct RegistrationItineraryPage: Codable, Sendable {
    let items: [RegistrationItineraryItem]
    let nextCursor: String?
    let hasMore: Bool
    let serverTime: Date

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case items, nextCursor, hasMore, serverTime
    }

    init(from decoder: Decoder) throws {
        try rejectUnknownItineraryKeys(CodingKeys.self, from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        items = try container.decode([RegistrationItineraryItem].self, forKey: .items)
        nextCursor = try container.decode(String?.self, forKey: .nextCursor)
        hasMore = try container.decode(Bool.self, forKey: .hasMore)
        serverTime = try container.decode(Date.self, forKey: .serverTime)
    }
}

private struct ItineraryCodingKey: CodingKey, Hashable {
    let stringValue: String
    let intValue: Int?

    init?(stringValue: String) {
        self.stringValue = stringValue
        intValue = nil
    }

    init?(intValue: Int) {
        stringValue = String(intValue)
        self.intValue = intValue
    }
}

private func rejectUnknownItineraryKeys<Keys>(
    _ keys: Keys.Type,
    from decoder: Decoder
) throws where Keys: CodingKey & CaseIterable {
    let container = try decoder.container(keyedBy: ItineraryCodingKey.self)
    let allowed = Set(Keys.allCases.map(\.stringValue))
    let unexpected = container.allKeys.map(\.stringValue).filter { !allowed.contains($0) }.sorted()
    guard unexpected.isEmpty else {
        throw DecodingError.dataCorrupted(.init(
            codingPath: decoder.codingPath,
            debugDescription: "Unexpected itinerary fields: \(unexpected.joined(separator: ", "))"
        ))
    }
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

/// "Who's coming" social proof (Luma signature). Public, unauthenticated payload
/// exposing only confirmed-attendee count plus up to eight public preview avatars.
/// Never carries email or phone. When the organizer hides the guest list the server
/// returns `previews` empty while still reporting `confirmedCount`.
struct GoingPreview: Codable, Sendable {
    struct Attendee: Codable, Identifiable, Sendable {
        let userId: UUID
        let displayName: String
        let avatarURL: URL?
        var id: UUID { userId }
    }

    let confirmedCount: Int
    let previews: [Attendee]
    let hasMore: Bool
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
    let isInvite: Bool?
    let sessionId: UUID
}

struct ShareAcceptance: Codable, Sendable {
    let accepted: Bool
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
    let revocationReason: String?
    let hidden: Bool?
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
    var discoverySafeSummary: EventSummary {
        var result = self
        if let coordinate = result.coordinate,
           coordinate.precision == .exact
            || !coordinate.latitude.isFinite
            || !coordinate.longitude.isFinite
            || !(-90 ... 90).contains(coordinate.latitude)
            || !(-180 ... 180).contains(coordinate.longitude) {
            result.coordinate = nil
        }
        result.exactAddress = nil
        result.attendeeRequirements = nil
        result.riskFlags = nil
        result.riskDetails = nil
        result.groupId = nil
        result.checkinMode = nil
        result.commentPermission = nil
        result.posterEnabled = nil
        result.showGuestList = nil
        result.exactAddressVisibility = nil
        result.registrationQuestions = nil
        return result
    }

    static let samples: [EventSummary] = [
        .init(
            id: UUID(uuidString: "019B0000-0000-7000-8100-000000000001")!,
            publicSlug: "tokyo-afterglow-walk",
            organizerId: UUID(uuidString: "019B0000-0000-7000-8100-000000000010")!,
            status: "published",
            title: "东京余光 · 隅田川蓝调散步",
            description: "从清澄白河走到隅田川，在入夜前后记录城市颜色。",
            category: "city-walk",
            startsAt: ISO8601DateFormatter().date(from: "2026-07-18T08:30:00Z"),
            endsAt: ISO8601DateFormatter().date(from: "2026-07-18T11:00:00Z"),
            deadlineAt: ISO8601DateFormatter().date(from: "2026-07-18T07:30:00Z"),
            displayTimeZone: "Asia/Tokyo",
            region: "tokyo",
            publicArea: "清澄白河站附近",
            capacity: 24,
            confirmedCount: 12,
            availableCapacity: 12,
            coverURL: nil,
            tags: ["city-walk", "摄影"],
            organizer: .init(
                id: UUID(uuidString: "019B0000-0000-7000-8100-000000000010")!,
                name: "周末开局",
                handle: "weekend_kai",
                viewerFollowing: false,
                trust: .init(phoneVerified: true, completedEventCount: 18, attendanceRateBand: .over90)
            ),
            favorited: false,
            registrationStatus: nil,
            viewerRegistration: nil,
            registrationMode: "automatic",
            waitlistEnabled: true,
            format: .inPerson,
            primaryLocale: .ja,
            supportedLocales: [.ja, .zhHans],
            localeConfirmed: true,
            availableActions: [.register],
            version: 1,
            updatedAt: ISO8601DateFormatter().date(from: "2026-07-16T00:00:00Z")!,
            coordinate: .init(latitude: 35.68, longitude: 139.80, precision: .approximate),
            exactAddress: nil,
            fee: .init(
                isFree: true,
                amountJPY: nil,
                collectorName: nil,
                method: nil,
                paymentDeadlineText: nil,
                refundPolicy: nil,
                boundaryStatement: "本活动免费。"
            )
        ),
        .init(
            id: UUID(uuidString: "019B0000-0000-7000-8100-000000000002")!,
            publicSlug: "shimokita-vinyl-night",
            organizerId: UUID(uuidString: "019B0000-0000-7000-8100-000000000011")!,
            status: "published",
            title: "下北泽黑胶交换夜",
            description: "带一张最近循环播放的唱片，认识同样认真听歌的人。",
            category: "music",
            startsAt: ISO8601DateFormatter().date(from: "2026-07-20T10:00:00Z"),
            endsAt: ISO8601DateFormatter().date(from: "2026-07-20T13:00:00Z"),
            deadlineAt: ISO8601DateFormatter().date(from: "2026-07-20T09:00:00Z"),
            displayTimeZone: "Asia/Tokyo",
            region: "tokyo",
            publicArea: "下北泽",
            capacity: 16,
            confirmedCount: 8,
            availableCapacity: 8,
            coverURL: nil,
            tags: ["music", "新朋友"],
            organizer: .init(
                id: UUID(uuidString: "019B0000-0000-7000-8100-000000000011")!,
                name: "小光",
                handle: "tokyo_hikari",
                viewerFollowing: false,
                trust: .init(phoneVerified: true, completedEventCount: 6, attendanceRateBand: .from70To89)
            ),
            favorited: false,
            registrationStatus: nil,
            viewerRegistration: nil,
            registrationMode: "automatic",
            waitlistEnabled: true,
            format: .inPerson,
            primaryLocale: .ja,
            supportedLocales: [.ja],
            localeConfirmed: true,
            availableActions: [.register],
            version: 1,
            updatedAt: ISO8601DateFormatter().date(from: "2026-07-16T00:00:00Z")!,
            coordinate: .init(latitude: 35.66, longitude: 139.67, precision: .approximate),
            exactAddress: nil,
            fee: .init(
                isFree: true,
                amountJPY: nil,
                collectorName: nil,
                method: nil,
                paymentDeadlineText: nil,
                refundPolicy: nil,
                boundaryStatement: "本活动免费。"
            )
        ),
    ]
}

struct PasswordRegistrationPayload: Encodable, Sendable {
    let email: String
    let password: String
    let nickname: String?
    let deviceId: String

    init(email: String, password: String, nickname: String?, deviceId: UUID) {
        self.email = email
        self.password = password
        self.nickname = nickname?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        self.deviceId = deviceId.uuidString.lowercased()
    }
}

struct PasswordLoginPayload: Encodable, Sendable {
    let email: String
    let password: String
    let deviceId: String

    init(email: String, password: String, deviceId: UUID) {
        self.email = email
        self.password = password
        self.deviceId = deviceId.uuidString.lowercased()
    }
}

struct DiscoveryFeedRecommendation: Codable, Hashable, Sendable {
    let score: Double
    let boosted: Bool
    let components: [String: Double]
}

struct DiscoveryFeedItem: Codable, Identifiable, Hashable, Sendable {
    let event: EventSummary
    let recommendation: DiscoveryFeedRecommendation?

    var id: UUID { event.id }

    private enum CodingKeys: String, CodingKey {
        case recommendation
    }

    init(event: EventSummary, recommendation: DiscoveryFeedRecommendation? = nil) {
        self.event = event
        self.recommendation = recommendation
    }

    init(from decoder: Decoder) throws {
        event = try EventSummary(from: decoder).discoverySafeSummary
        let container = try decoder.container(keyedBy: CodingKeys.self)
        recommendation = try container.decodeIfPresent(
            DiscoveryFeedRecommendation.self,
            forKey: .recommendation
        )
    }

    func encode(to encoder: Encoder) throws {
        try event.encode(to: encoder)
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(recommendation, forKey: .recommendation)
    }
}

struct DiscoveryFeedModule: Codable, Identifiable, Sendable {
    let key: String
    let title: String
    let items: [DiscoveryFeedItem]

    var id: String { key }
}

struct DiscoveryFeedBanner: Codable, Sendable {
    let label: String
    let kind: String
    let promotional: Bool
    let headline: String?
    let imageURL: URL?
    let event: EventSummary
}

struct DiscoveryFeedResponse: Codable, Sendable {
    let banner: DiscoveryFeedBanner?
    let modules: [DiscoveryFeedModule]
    let moduleOrder: [String]
    let scoringVersion: String
    let serverTime: Date
    let queryExplanationId: String
}

struct EventCommentAuthor: Codable, Hashable, Sendable {
    let id: UUID
    let name: String
}

struct EventComment: Codable, Identifiable, Hashable, Sendable {
    let id: UUID
    let eventId: UUID
    let author: EventCommentAuthor
    let body: String
    let parentId: UUID?
    let locale: String
    let version: Int
    let createdAt: Date
    let updatedAt: Date
}

struct EventCommentPage: Codable, Sendable {
    let eventId: UUID
    let commentPermission: String?
    let items: [EventComment]
}

struct GroupDiscussionPost: Codable, Identifiable, Sendable {
    let id: UUID
    let groupId: UUID
    let author: GroupPersonSummary
    let body: String
    let parentId: UUID?
    let locale: String
    let likeCount: Int
    let viewerLiked: Bool
    let replyCount: Int
    let version: Int
    let createdAt: Date
    let updatedAt: Date
}

struct GroupDiscussionPage: Codable, Sendable {
    let items: [GroupDiscussionPost]
    let hasMore: Bool
    let nextCursor: String?
}

struct GroupDiscussionReplyPage: Codable, Sendable {
    let items: [GroupDiscussionPost]
}

struct GroupDiscussionLikeMutation: Codable, Sendable {
    let commentId: UUID
    let liked: Bool
}

struct GroupDiscussionModerationResult: Codable, Identifiable, Sendable {
    let id: UUID
    let groupId: UUID
    let author: GroupPersonSummary
    let body: String
    let parentId: UUID?
    let locale: String
    let version: Int
    let createdAt: Date
    let updatedAt: Date

    private enum CodingKeys: String, CodingKey {
        case id
        case groupId = "announcementId"
        case author, body, parentId, locale, version, createdAt, updatedAt
    }
}

struct EventTicketType: Codable, Identifiable, Sendable {
    let id: UUID
    let eventId: UUID
    let name: String
    let description: String?
    let isFree: Bool
    let amountJPY: Int?
    let collectorName: String?
    let method: String?
    let paymentDeadlineText: String?
    let refundPolicy: String?
    let quota: Int?
    let soldCount: Int
    let remaining: Int?
    let soldOut: Bool
    let active: Bool
    let sortOrder: Int
    let availableActions: [String]
    let updatedAt: Date
}

struct EventTicketTypePage: Codable, Sendable {
    let items: [EventTicketType]
}

struct TicketTypeInput: Encodable, Sendable {
    let name: String
    var description: String? = nil
    let isFree: Bool
    var amountJPY: Int? = nil
    var collectorName: String? = nil
    var method: String? = nil
    var paymentDeadlineText: String? = nil
    var refundPolicy: String? = nil
    var quota: Int? = nil
}

struct TicketTypeUpdateInput: Encodable, Sendable {
    var name: String? = nil
    var description: String? = nil
    var isFree: Bool? = nil
    var amountJPY: Int? = nil
    var collectorName: String? = nil
    var method: String? = nil
    var paymentDeadlineText: String? = nil
    var refundPolicy: String? = nil
    var quota: Int? = nil
    var active: Bool? = nil
}

struct TicketPaymentReport: Codable, Sendable {
    let registrationId: UUID
    let paymentStatus: String
    let selfReportedAt: Date
}

struct TicketPaymentConfirmation: Codable, Sendable {
    let registrationId: UUID
    let paymentStatus: String
    let confirmedAt: Date
    let confirmedBy: UUID
}

enum EventPromotionTier: String, Codable, CaseIterable, Identifiable, Sendable {
    case boost24h = "boost_24h"
    case boost72h = "boost_72h"
    case boost7d = "boost_7d"

    var id: String { rawValue }
    var quotePurpose: String { rawValue }
}

struct EventPromotion: Codable, Identifiable, Sendable {
    let id: UUID
    let eventId: UUID
    let tier: String
    let amount: Int
    let durationHours: Int
    let state: String
    let startsAt: Date
    let expiresAt: Date
    let purchaseTransactionId: UUID
}

struct PointsCheckInReward: Codable, Hashable, Sendable {
    let type: String
    let points: Int
}

struct PointsCheckInResult: Codable, Sendable {
    let alreadyCheckedIn: Bool
    let streak: Int
    let civilDay: String
    let rewards: [PointsCheckInReward]
    let wallet: WalletSnapshot
}

struct PointsRule: Codable, Identifiable, Sendable {
    let key: String
    let type: String
    let launchValue: Double
    let stableValue: Double
    let effectiveValue: Double
    let unit: String?
    let conditions: [String: JSONValue]?
    let description: String?

    var id: String { key }
}

struct PointsRuleCatalog: Codable, Sendable {
    let stage: String
    let items: [PointsRule]
}

struct AchievementEvaluation: Codable, Sendable {
    struct Revocation: Codable, Sendable {
        let code: String
        let reason: String
    }

    let awarded: [String]
    let revoked: [Revocation]
}

struct AchievementVisibilityMutation: Codable, Sendable {
    let hidden: Bool
    let affected: Int
}

struct AchievementBadgeVisibilityMutation: Codable, Sendable {
    let awardId: UUID
    let hidden: Bool
}

struct AchievementShareCard: Codable, Sendable {
    struct Summary: Codable, Sendable {
        let code: String
        let audience: String
        let ruleVersion: Int
        let awardedAt: Date
    }

    let brand: String
    let nickname: String
    let achievement: Summary
    let dataRange: [String: JSONValue]
    let link: URL
}

struct PublicAchievement: Codable, Identifiable, Sendable {
    let code: String
    let audience: String
    let ruleVersion: Int
    let awardedAt: Date
    let hidden: Bool?

    var id: String { code }
}

struct HostReputation: Codable, Sendable {
    let completedEvents: Int
    let attendanceBand: String
    let continuousOrganizingMonths: Int
}

struct PublicAchievementPage: Codable, Sendable {
    let userId: UUID
    let items: [PublicAchievement]
    let hostReputation: HostReputation?
}
