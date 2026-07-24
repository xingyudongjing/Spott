import Foundation
import XCTest
@testable import Spott

final class DiscoveryQueryTests: XCTestCase {
    override func tearDown() {
        CancellationURLProtocol.onStart = nil
        CancellationURLProtocol.onStop = nil
        super.tearDown()
    }

    func testQueryItemsPreserveEveryDiscoveryFilterInDeterministicOrder() throws {
        let startsAfter = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-07-01T00:00:00Z"))
        let startsBefore = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-08-01T00:00:00Z"))
        let query = EventDiscoveryQuery(
            q: "night walk",
            region: "tokyo",
            category: "walk",
            startsAfter: startsAfter,
            startsBefore: startsBefore,
            availableOnly: true,
            format: .hybrid,
            language: .ja,
            price: .paid,
            bounds: .init(west: 139.6, south: 35.5, east: 139.9, north: 35.8),
            near: .init(latitude: 35.66, longitude: 139.7),
            sort: .almostFull,
            cursor: "2026-07-18T08:30:00Z|019b",
            limit: 20
        )

        XCTAssertEqual(
            query.queryItems.map(\.name),
            [
                "q", "region", "category", "startsAfter", "startsBefore", "availableOnly",
                "format", "language", "price", "bounds", "near", "sort", "cursor", "limit",
            ]
        )
        XCTAssertEqual(query.queryItems.first { $0.name == "format" }?.value, "hybrid")
        XCTAssertEqual(query.queryItems.first { $0.name == "language" }?.value, "ja")
        XCTAssertEqual(query.queryItems.first { $0.name == "availableOnly" }?.value, "true")
        XCTAssertEqual(query.queryItems.first { $0.name == "bounds" }?.value, "139.6,35.5,139.9,35.8")
        XCTAssertEqual(query.queryItems.first { $0.name == "near" }?.value, "35.66,139.7")
        XCTAssertEqual(query.queryItems.first { $0.name == "sort" }?.value, "almost_full")
        XCTAssertEqual(query.queryItems.first { $0.name == "cursor" }?.value, "2026-07-18T08:30:00Z|019b")
    }

    func testSortModesMatchTheServerContractExactly() {
        XCTAssertEqual(
            EventDiscoverySort.allCases.map(\.rawValue).sorted(),
            ["almost_full", "distance", "newest", "recommended", "time"]
        )
    }

    func testEventSummaryRejectsMissingRequiredServerFacts() throws {
        var payload = eventPayload()
        payload.removeValue(forKey: "description")
        let data = try JSONSerialization.data(withJSONObject: payload)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        XCTAssertThrowsError(try decoder.decode(EventSummary.self, from: data))
    }

    func testEventSummaryDecodesTruthfulNullDraftFacts() throws {
        let data = try JSONSerialization.data(withJSONObject: eventPayload(overrides: [
            "status": "draft",
            "region": NSNull(),
            "publicArea": NSNull(),
            "fee": NSNull(),
        ]))
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        let summary = try decoder.decode(EventSummary.self, from: data)

        XCTAssertNil(summary.region)
        XCTAssertNil(summary.publicArea)
        XCTAssertNil(summary.fee)
        XCTAssertEqual(summary.priceLabel, "")
    }

    func testDiscoveryAlwaysUsesSearchAndCancellationStopsTheNetworkRequest() async throws {
        let started = expectation(description: "network request started")
        let stopped = expectation(description: "network request cancelled")
        let requestBox = RequestBox()
        CancellationURLProtocol.onStart = { request in
            requestBox.request = request
            started.fulfill()
        }
        CancellationURLProtocol.onStop = {
            stopped.fulfill()
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CancellationURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let client = SpottAPIClient(
            environment: .init(baseURL: URL(string: "https://api.spott.test/v1")!),
            credentials: CredentialVault(service: "jp.spott.tests.\(UUID().uuidString)"),
            session: session,
            usesCredentials: false
        )

        let task = Task {
            try await client.discovery(.init(region: "tokyo"))
        }
        await fulfillment(of: [started], timeout: 2)
        task.cancel()
        await fulfillment(of: [stopped], timeout: 2)

        XCTAssertEqual(requestBox.request?.url?.path, "/v1/events/search")
        XCTAssertEqual(
            URLComponents(url: try XCTUnwrap(requestBox.request?.url), resolvingAgainstBaseURL: false)?
                .queryItems?.first { $0.name == "region" }?.value,
            "tokyo"
        )
        do {
            _ = try await task.value
            XCTFail("Cancellation must propagate to the caller")
        } catch is CancellationError {
            // Expected: the Swift task and URLSession request share cancellation.
        } catch {
            XCTFail("Expected CancellationError, received \(error)")
        }
    }
}

private final class RequestBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: URLRequest?

    var request: URLRequest? {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
}

private final class CancellationURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var onStart: ((URLRequest) -> Void)?
    nonisolated(unsafe) static var onStop: (() -> Void)?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Self.onStart?(request) }
    override func stopLoading() { Self.onStop?() }
}

func eventPayload(overrides: [String: Any] = [:]) -> [String: Any] {
    var payload: [String: Any] = [
        "id": "019b0000-0000-7000-8100-000000000001",
        "publicSlug": "event",
        "organizerId": "019b0000-0000-7000-8100-000000000010",
        "status": "published",
        "title": "Event",
        "description": "Description",
        "category": "walk",
        "startsAt": "2026-07-18T08:30:00Z",
        "endsAt": "2026-07-18T11:00:00Z",
        "deadlineAt": "2026-07-17T00:00:00Z",
        "displayTimeZone": "Asia/Tokyo",
        "region": "tokyo",
        "publicArea": "Kiyosumi",
        "capacity": 10,
        "confirmedCount": 3,
        "availableCapacity": 7,
        "fee": [
            "isFree": true,
            "amountJPY": NSNull(),
            "collectorName": NSNull(),
            "method": NSNull(),
            "paymentDeadlineText": NSNull(),
            "refundPolicy": NSNull(),
        ],
        "coverURL": NSNull(),
        "tags": [],
        "organizer": [
            "id": "019b0000-0000-7000-8100-000000000010",
            "name": "Host",
            "handle": "host",
            "viewerFollowing": false,
            "trust": [
                "phoneVerified": true,
                "completedEventCount": 18,
                "attendanceRateBand": "90_plus",
            ],
        ],
        "favorited": false,
        "registrationStatus": NSNull(),
        "viewerRegistration": NSNull(),
        "registrationMode": "automatic",
        "waitlistEnabled": true,
        "format": "in_person",
        "primaryLocale": "ja",
        "supportedLocales": ["ja", "en"],
        "localeConfirmed": true,
        "availableActions": ["register"],
        "version": 1,
        "updatedAt": "2026-07-15T00:00:00Z",
        "coordinate": NSNull(),
    ]
    for (key, value) in overrides { payload[key] = value }
    return payload
}
