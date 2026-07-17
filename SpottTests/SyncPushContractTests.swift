import Foundation
import XCTest
@testable import Spott

final class SyncPushContractTests: XCTestCase {
    override func tearDown() {
        SyncPushURLProtocol.onRequest = nil
        super.tearDown()
    }

    func testPushBodyIncludesCurrentRegisteredDeviceID() async throws {
        let requests = SyncPushRequestBox()
        SyncPushURLProtocol.onRequest = { request, body in
            requests.append(request, body: body)
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SyncPushURLProtocol.self]
        let client = SpottAPIClient(
            environment: .init(baseURL: URL(string: "https://api.spott.test/v1")!),
            credentials: CredentialVault(service: "jp.spott.sync-push-tests.\(UUID().uuidString)"),
            session: URLSession(configuration: configuration),
            usesCredentials: false
        )
        let operation = SyncPushOperation(
            operationId: UUID(uuidString: "019b0000-0000-7000-a000-000000000001")!,
            entityType: "favorite",
            entityId: UUID(uuidString: "019b0000-0000-7000-8100-000000000001"),
            action: "put",
            baseVersion: nil,
            payload: .object([:])
        )

        _ = try await client.push(operations: [operation])

        let captured = try XCTUnwrap(requests.requests.first)
        let request = captured.request
        let body = try XCTUnwrap(captured.body)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: body) as? [String: Any]
        )
        XCTAssertEqual(request.url?.path, "/v1/sync/push")
        XCTAssertEqual(
            object["deviceId"] as? String,
            DeviceIdentity.current.uuidString.lowercased()
        )
        XCTAssertEqual((object["operations"] as? [[String: Any]])?.count, 1)
    }
}

private final class SyncPushRequestBox: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [(request: URLRequest, body: Data?)] = []

    var requests: [(request: URLRequest, body: Data?)] { lock.withLock { storage } }

    func append(_ request: URLRequest, body: Data?) {
        lock.withLock { storage.append((request, body)) }
    }
}

private final class SyncPushURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var onRequest: ((URLRequest, Data?) -> Void)?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.onRequest?(request, Self.bodyData(from: request))
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"results":[]}"#.utf8))
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
