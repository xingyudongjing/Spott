import Foundation
import XCTest
@testable import Spott

final class ServerTimeAuthorityTests: XCTestCase {
    func testCalibratedServerTimeIgnoresAnIncorrectDeviceWallClock() throws {
        let monotonic = ServerTimeTestClock(10)
        let wrongDeviceTime = try XCTUnwrap(
            ISO8601DateFormatter().date(from: "2040-01-01T00:00:00Z")
        )
        let serverTime = try XCTUnwrap(
            ISO8601DateFormatter().date(from: "2026-07-16T03:00:00Z")
        )
        let authority = ServerTimeAuthority(
            wallClock: { wrongDeviceTime },
            monotonicClock: monotonic.now
        )

        XCTAssertEqual(authority.now(), wrongDeviceTime)
        authority.calibrate(serverTime: serverTime)
        monotonic.advance(by: 45)

        XCTAssertEqual(
            authority.now().timeIntervalSince1970,
            serverTime.addingTimeInterval(45).timeIntervalSince1970,
            accuracy: 0.001
        )
    }

    func testRFC1123HTTPDateHeaderCalibratesTheAuthority() throws {
        let monotonic = ServerTimeTestClock(100)
        let serverTime = try XCTUnwrap(
            ISO8601DateFormatter().date(from: "2026-07-16T03:00:00Z")
        )
        let authority = ServerTimeAuthority(
            wallClock: { .distantFuture },
            monotonicClock: monotonic.now
        )

        XCTAssertTrue(
            authority.calibrate(httpDate: "Thu, 16 Jul 2026 03:00:00 GMT")
        )
        monotonic.advance(by: 2.5)

        XCTAssertEqual(
            authority.now().timeIntervalSince1970,
            serverTime.addingTimeInterval(2.5).timeIntervalSince1970,
            accuracy: 0.001
        )
    }

    func testHTTPDateParsingIsPOSIXAndGMTStableAcrossAcceptedWireFormats() throws {
        let expected = try XCTUnwrap(
            ISO8601DateFormatter().date(from: "2026-07-16T03:00:00Z")
        )
        let acceptedDates = [
            "  Thu, 16 Jul 2026 03:00:00 GMT\t",
            "Thursday, 16-Jul-26 03:00:00 GMT",
            "Thu Jul 16 03:00:00 2026",
        ]

        for header in acceptedDates {
            let authority = ServerTimeAuthority(
                wallClock: { .distantFuture },
                monotonicClock: { 42 }
            )

            XCTAssertTrue(authority.calibrate(httpDate: header), header)
            XCTAssertEqual(
                authority.now().timeIntervalSince1970,
                expected.timeIntervalSince1970,
                accuracy: 0.001,
                header
            )
        }
    }

    func testConcurrentHTTPDateCalibrationDoesNotRaceTheFormatter() async {
        let header = "Thu, 16 Jul 2026 03:00:00 GMT"

        let results = await withTaskGroup(of: Bool.self, returning: [Bool].self) { group in
            for _ in 0..<64 {
                group.addTask {
                    let authority = ServerTimeAuthority(
                        wallClock: { .distantFuture },
                        monotonicClock: { 42 }
                    )
                    return authority.calibrate(httpDate: header)
                }
            }

            var values: [Bool] = []
            for await value in group {
                values.append(value)
            }
            return values
        }

        XCTAssertEqual(results.count, 64)
        XCTAssertTrue(results.allSatisfy { $0 })
    }

    func testMalformedHTTPDateDoesNotReplaceAnExistingCalibration() throws {
        let expected = try XCTUnwrap(
            ISO8601DateFormatter().date(from: "2026-07-16T03:00:00Z")
        )
        let authority = ServerTimeAuthority(
            wallClock: { .distantFuture },
            monotonicClock: { 42 }
        )

        XCTAssertTrue(authority.calibrate(httpDate: "Thu, 16 Jul 2026 03:00:00 GMT"))
        XCTAssertFalse(authority.calibrate(httpDate: "2026年7月16日 03:00:00 JST"))
        XCTAssertEqual(
            authority.now().timeIntervalSince1970,
            expected.timeIntervalSince1970,
            accuracy: 0.001
        )
    }

    func testAPIResponsesCalibrateTheClockUsedByEventDetail() async throws {
        let monotonic = ServerTimeTestClock(200)
        let authority = ServerTimeAuthority(
            wallClock: { .distantFuture },
            monotonicClock: monotonic.now
        )
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ServerDateURLProtocol.self]
        let client = SpottAPIClient(
            environment: .init(baseURL: URL(string: "https://api.spott.test/v1")!),
            credentials: CredentialVault(
                service: "jp.spott.server-time.\(UUID().uuidString)"
            ),
            session: URLSession(configuration: configuration),
            usesCredentials: false,
            serverTimeAuthority: authority
        )

        _ = try await client.discovery(.init(region: "tokyo"))
        monotonic.advance(by: 5)

        let expected = try XCTUnwrap(
            ISO8601DateFormatter().date(from: "2026-07-16T03:00:05Z")
        )
        XCTAssertEqual(
            client.authoritativeNow().timeIntervalSince1970,
            expected.timeIntervalSince1970,
            accuracy: 0.001
        )
    }
}

private final class ServerTimeTestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: TimeInterval

    init(_ value: TimeInterval) {
        self.value = value
    }

    func now() -> TimeInterval {
        lock.withLock { value }
    }

    func advance(by interval: TimeInterval) {
        lock.withLock { value += interval }
    }
}

private final class ServerDateURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let data = Data(
            #"{"items":[],"nextCursor":null,"hasMore":false,"serverTime":"2026-07-16T03:00:00Z","queryExplanationId":"clock-test"}"#.utf8
        )
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": "application/json",
                "Date": "Thu, 16 Jul 2026 03:00:00 GMT",
            ]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
