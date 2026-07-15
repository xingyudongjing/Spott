import Foundation

enum AnalyticsEventName: String, Sendable {
    case discoveryViewed = "discovery_viewed"
    case eventDetailViewed = "event_detail_viewed"
    case registrationCompleted = "registration_completed"
    case eventSubmissionCompleted = "event_submission_completed"
}

indirect enum AnalyticsPropertyValue: Encodable, Sendable, Equatable {
    case string(String)
    case integer(Int)
    case double(Double)
    case boolean(Bool)
    case object([String: AnalyticsPropertyValue])
    case array([AnalyticsPropertyValue])
    case null

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value):
            try container.encode(value)
        case .integer(let value):
            try container.encode(value)
        case .double(let value):
            try container.encode(value)
        case .boolean(let value):
            try container.encode(value)
        case .object(let value):
            try container.encode(value)
        case .array(let value):
            try container.encode(value)
        case .null:
            try container.encodeNil()
        }
    }
}

struct P0AnalyticsSignal: Sendable {
    let name: AnalyticsEventName
    let properties: [String: AnalyticsPropertyValue]

    static func discoveryViewed(region: String, itemCount: Int, reason: String) -> Self {
        .init(name: .discoveryViewed, properties: [
            "region": .string(region),
            "itemCount": .integer(itemCount),
            "reason": .string(reason),
        ])
    }

    static func eventDetailViewed(
        eventID: UUID,
        publicSlug: String,
        category: String?
    ) -> Self {
        .init(name: .eventDetailViewed, properties: [
            "eventId": .string(eventID.uuidString.lowercased()),
            "publicSlug": .string(publicSlug),
            "category": .string(category ?? "unknown"),
        ])
    }

    static func registrationCompleted(eventID: UUID, status: String, partySize: Int) -> Self {
        .init(name: .registrationCompleted, properties: [
            "eventId": .string(eventID.uuidString.lowercased()),
            "status": .string(status),
            "partySize": .integer(partySize),
        ])
    }

    static func eventSubmissionCompleted(
        eventID: UUID,
        status: String,
        category: String,
        posterEnabled: Bool
    ) -> Self {
        .init(name: .eventSubmissionCompleted, properties: [
            "eventId": .string(eventID.uuidString.lowercased()),
            "status": .string(status),
            "category": .string(category),
            "posterEnabled": .boolean(posterEnabled),
        ])
    }
}

struct AnalyticsConsentStore: @unchecked Sendable {
    private let defaults: UserDefaults

    static let standard = AnalyticsConsentStore(defaults: .standard)

    init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    func isGranted() -> Bool {
        defaults.bool(forKey: AnalyticsClient.consentKey)
    }
}

actor AnalyticsClient {
    typealias Transport = @Sendable (URLRequest) async throws -> (Data, URLResponse)

    static let consentKey = "analytics.consent"

    private struct Batch: Encodable {
        let events: [Event]
    }

    private struct Event: Encodable {
        let eventName: String
        let schemaVersion: Int
        let anonymousId: String
        let sessionId: String
        let platform: String
        let properties: [String: AnalyticsPropertyValue]
        let occurredAt: String
    }

    private static let forbiddenPropertyWords: Set<String> = [
        "phone", "email", "address", "otp", "code", "token", "password",
        "evidence", "statement", "body", "message",
    ]

    private let environment: APIEnvironment
    private let consentStore: AnalyticsConsentStore
    private let anonymousID: UUID
    private let sessionID: UUID
    private let now: @Sendable () -> Date
    private let transport: Transport
    private let encoder = JSONEncoder()

    init(
        environment: APIEnvironment,
        consentStore: AnalyticsConsentStore = .standard,
        anonymousID: UUID = DeviceIdentity.current,
        sessionID: UUID = UUID(),
        now: @escaping @Sendable () -> Date = { Date() },
        transport: Transport? = nil
    ) {
        self.environment = environment
        self.consentStore = consentStore
        self.anonymousID = anonymousID
        self.sessionID = sessionID
        self.now = now
        if let transport {
            self.transport = transport
        } else {
            let session = URLSession.shared
            self.transport = { request in try await session.data(for: request) }
        }
    }

    func track(
        _ name: AnalyticsEventName,
        properties: [String: AnalyticsPropertyValue] = [:]
    ) async {
        guard consentStore.isGranted() else { return }

        do {
            let event = Event(
                eventName: name.rawValue,
                schemaVersion: 1,
                anonymousId: anonymousID.uuidString.lowercased(),
                sessionId: sessionID.uuidString.lowercased(),
                platform: "ios",
                properties: Self.sanitize(properties),
                occurredAt: Self.timestamp(now())
            )
            let body = try encoder.encode(Batch(events: [event]))
            var request = URLRequest(
                url: environment.baseURL.appending(path: "analytics/events/batch")
            )
            request.httpMethod = "POST"
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            let (_, response) = try await transport(request)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode) else { return }
        } catch {
            return
        }
    }

    private static func sanitize(
        _ properties: [String: AnalyticsPropertyValue]
    ) -> [String: AnalyticsPropertyValue] {
        properties.reduce(into: [:]) { result, entry in
            guard !isForbiddenPropertyKey(entry.key) else { return }
            result[entry.key] = sanitize(entry.value)
        }
    }

    private static func sanitize(_ value: AnalyticsPropertyValue) -> AnalyticsPropertyValue {
        switch value {
        case .object(let object):
            return .object(sanitize(object))
        case .array(let array):
            return .array(array.map(sanitize))
        default:
            return value
        }
    }

    private static func isForbiddenPropertyKey(_ key: String) -> Bool {
        let compact = key.lowercased().filter { $0.isLetter || $0.isNumber }
        return forbiddenPropertyWords.contains { compact.contains($0) }
    }

    private static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter.string(from: date)
    }
}
