import Foundation
import XCTest
@testable import Spott

final class ItineraryContractTests: XCTestCase {
    override func tearDown() {
        ItineraryURLProtocol.onRequest = nil
        ItineraryURLProtocol.responseData = Data()
        super.tearDown()
    }

    func testPageDecodesAuthoritativeServerTimeAndLimitedEventSummary() throws {
        let page = try decoder().decode(
            RegistrationItineraryPage.self,
            from: try JSONSerialization.data(withJSONObject: itineraryPagePayload())
        )

        XCTAssertEqual(page.items.count, 1)
        XCTAssertEqual(page.items[0].registration.status, "offered")
        XCTAssertEqual(page.items[0].event?.publicSlug, "evening-walk")
        XCTAssertEqual(page.items[0].event?.format, .inPerson)
        XCTAssertEqual(page.items[0].event?.primaryLocale, .ja)
        XCTAssertEqual(
            page.serverTime,
            try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-07-16T03:00:00Z"))
        )
        XCTAssertTrue(page.hasMore)
        XCTAssertNotNil(page.nextCursor)
    }

    func testUnavailableEventKeepsItsRegistration() throws {
        let page = try decoder().decode(
            RegistrationItineraryPage.self,
            from: try JSONSerialization.data(withJSONObject: itineraryPagePayload(event: NSNull()))
        )

        XCTAssertEqual(
            page.items[0].registration.id,
            UUID(uuidString: "019b0000-0000-7000-8200-000000000003")
        )
        XCTAssertNil(page.items[0].event)
    }

    func testDecoderRejectsEveryPrivacyForbiddenEventField() throws {
        let forbidden: [(String, Any)] = [
            ("exactAddress", "1-2-3 Jingumae"),
            ("coordinate", ["latitude": 35.668, "longitude": 139.706, "precision": "exact"]),
            ("onlineJoinURL", "https://meet.example/private"),
            ("joinInstructions", "Use the private room code"),
            ("registrationQuestions", [["prompt": "Private"]]),
            ("description", "Detail-only copy"),
            ("organizer", ["privateNote": "Private"]),
        ]

        for (field, value) in forbidden {
            var event = itineraryEventPayload()
            event[field] = value
            let data = try JSONSerialization.data(withJSONObject: itineraryPagePayload(event: event))

            XCTAssertThrowsError(
                try decoder().decode(RegistrationItineraryPage.self, from: data),
                "Itinerary decoder accepted forbidden field \(field)"
            )
        }
    }

    func testClientFetchesOneItineraryPageWithCursorAndNoDetailRequests() async throws {
        let log = ItineraryRequestLog()
        ItineraryURLProtocol.onRequest = { log.append($0) }
        ItineraryURLProtocol.responseData = try JSONSerialization.data(withJSONObject: itineraryPagePayload())
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ItineraryURLProtocol.self]
        let client = SpottAPIClient(
            environment: .init(baseURL: URL(string: "https://api.spott.test/v1")!),
            credentials: CredentialVault(service: "jp.spott.itinerary-tests.\(UUID().uuidString)"),
            session: URLSession(configuration: configuration),
            usesCredentials: false
        )

        let page = try await client.registrationItinerary(cursor: "opaque-cursor", limit: 25)

        let request = try XCTUnwrap(log.requests.first)
        let components = try XCTUnwrap(URLComponents(url: request.url!, resolvingAgainstBaseURL: false))
        XCTAssertEqual(log.requests.count, 1)
        XCTAssertEqual(components.path, "/v1/me/registrations")
        XCTAssertEqual(components.queryItems?.first { $0.name == "cursor" }?.value, "opaque-cursor")
        XCTAssertEqual(components.queryItems?.first { $0.name == "limit" }?.value, "25")
        XCTAssertEqual(page.items[0].event?.id, UUID(uuidString: "019b0000-0000-7000-8100-000000000001"))
    }

    private func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}

private func itineraryPagePayload(event: Any = itineraryEventPayload()) -> [String: Any] {
    [
        "items": [[
            "registration": [
                "id": "019b0000-0000-7000-8200-000000000003",
                "eventId": "019b0000-0000-7000-8100-000000000001",
                "userId": "019b0000-0000-7000-8000-000000000001",
                "status": "offered",
                "partySize": 2,
                "attendeeNote": NSNull(),
                "offerExpiresAt": "2026-07-16T03:10:00Z",
                "availableActions": ["cancelRegistration", "register"],
                "version": 4,
                "updatedAt": "2026-07-16T02:00:00Z",
            ],
            "event": event,
        ]],
        "nextCursor": "eyJkYXRlIjoiMjAyNi0wNy0xNlQwMjowMDowMC4wMDBaIiwiaWQiOiIwMTliIn0",
        "hasMore": true,
        "serverTime": "2026-07-16T03:00:00Z",
    ]
}

private func itineraryEventPayload() -> [String: Any] {
    [
        "id": "019b0000-0000-7000-8100-000000000001",
        "publicSlug": "evening-walk",
        "status": "published",
        "title": "Evening walk",
        "startsAt": "2026-07-20T09:00:00Z",
        "endsAt": "2026-07-20T11:00:00Z",
        "displayTimeZone": "Asia/Tokyo",
        "region": "tokyo",
        "publicArea": "Shibuya",
        "coverURL": "https://cdn.spott.jp/events/evening-walk.webp",
        "format": "in_person",
        "primaryLocale": "ja",
        "localeConfirmed": true,
        "version": 7,
        "updatedAt": "2026-07-15T02:00:00Z",
    ]
}

private final class ItineraryRequestLog: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [URLRequest] = []

    var requests: [URLRequest] { lock.withLock { storage } }

    func append(_ request: URLRequest) {
        lock.withLock { storage.append(request) }
    }
}

private final class ItineraryURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var onRequest: ((URLRequest) -> Void)?
    nonisolated(unsafe) static var responseData = Data()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.onRequest?(request)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseData)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
