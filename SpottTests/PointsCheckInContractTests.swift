import Foundation
import XCTest
@testable import Spott

final class PointsCheckInContractTests: XCTestCase {
    override func tearDown() {
        PointsCheckInURLProtocol.onRequest = nil
        super.tearDown()
    }

    func testDailyCheckInPostsEmptyBodyAndDecodesResult() async throws {
        let requests = PointsCheckInRequestBox()
        PointsCheckInURLProtocol.onRequest = { request, body in
            requests.append(request, body: body)
            return (200, Self.resultJSON)
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PointsCheckInURLProtocol.self]
        let client = SpottAPIClient(
            environment: .init(baseURL: URL(string: "https://api.spott.test/v1")!),
            credentials: CredentialVault(service: "jp.spott.checkin-tests.\(UUID().uuidString)"),
            session: URLSession(configuration: configuration),
            usesCredentials: false
        )

        let result = try await client.dailyCheckIn()

        let captured = try XCTUnwrap(requests.requests.first)
        let request = captured.request
        XCTAssertEqual(request.url?.path, "/v1/points/checkin")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try XCTUnwrap(captured.body)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertTrue(object.isEmpty, "daily check-in must send an empty JSON body")

        XCTAssertFalse(result.alreadyCheckedIn)
        XCTAssertEqual(result.streak, 7)
        XCTAssertEqual(result.civilDay, "2026-07-23")
        XCTAssertEqual(result.rewards.count, 2)
        XCTAssertEqual(result.rewards.first?.type, "daily_checkin_reward")
        XCTAssertEqual(result.rewards.first?.points, 10)
        XCTAssertEqual(result.rewards.last?.type, "streak_7_reward")
        XCTAssertEqual(result.rewards.last?.points, 50)
        XCTAssertEqual(result.wallet.totalBalance, 360)
        XCTAssertEqual(result.wallet.version, 4)
    }

    func testAlreadyCheckedInDecodesEmptyRewards() async throws {
        PointsCheckInURLProtocol.onRequest = { _, _ in
            (200, Data("""
            {
                "alreadyCheckedIn": true,
                "streak": 12,
                "civilDay": "2026-07-23",
                "rewards": [],
                "wallet": {"paidBalance": 0, "freeBalance": 80, "totalBalance": 80, "version": 9}
            }
            """.utf8))
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PointsCheckInURLProtocol.self]
        let client = SpottAPIClient(
            environment: .init(baseURL: URL(string: "https://api.spott.test/v1")!),
            credentials: CredentialVault(service: "jp.spott.checkin-tests.\(UUID().uuidString)"),
            session: URLSession(configuration: configuration),
            usesCredentials: false
        )

        let result = try await client.dailyCheckIn()

        XCTAssertTrue(result.alreadyCheckedIn)
        XCTAssertEqual(result.streak, 12)
        XCTAssertTrue(result.rewards.isEmpty)
        XCTAssertEqual(result.wallet.freeBalance, 80)
    }

    private static let resultJSON = Data("""
    {
        "alreadyCheckedIn": false,
        "streak": 7,
        "civilDay": "2026-07-23",
        "rewards": [
            {"type": "daily_checkin_reward", "points": 10},
            {"type": "streak_7_reward", "points": 50}
        ],
        "wallet": {"paidBalance": 100, "freeBalance": 260, "totalBalance": 360, "version": 4}
    }
    """.utf8)
}

private final class PointsCheckInRequestBox: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [(request: URLRequest, body: Data?)] = []

    var requests: [(request: URLRequest, body: Data?)] { lock.withLock { storage } }

    func append(_ request: URLRequest, body: Data?) {
        lock.withLock { storage.append((request, body)) }
    }
}

private final class PointsCheckInURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var onRequest: ((URLRequest, Data?) -> (Int, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let (status, body) = Self.onRequest?(request, Self.bodyData(from: request)) ?? (200, Data("{}".utf8))
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func bodyData(from request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var body = Data()
        var buffer = [UInt8](repeating: 0, count: 4_096)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count == 0 { return body }
            if count < 0 { return nil }
            body.append(buffer, count: count)
        }
    }
}
