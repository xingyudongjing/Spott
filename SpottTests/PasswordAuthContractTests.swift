import Foundation
import XCTest
@testable import Spott

final class PasswordAuthContractTests: XCTestCase {
    override func tearDown() {
        PasswordAuthURLProtocol.onRequest = nil
        super.tearDown()
    }

    func testRegisterSendsContractBodyAndPersistsSession() async throws {
        let requests = PasswordAuthRequestBox()
        PasswordAuthURLProtocol.onRequest = { request, body in
            requests.append(request, body: body)
            return (200, Self.sessionJSON)
        }
        let vault = CredentialVaultStub()
        let client = makeClient(vault: vault)

        let session = try await client.registerWithPassword(
            email: "hikari@example.jp",
            password: "correct-horse-battery",
            nickname: "小光"
        )

        let captured = try XCTUnwrap(requests.requests.first)
        let request = captured.request
        XCTAssertEqual(request.url?.path, "/v1/auth/password/register")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: XCTUnwrap(captured.body)) as? [String: Any]
        )
        XCTAssertEqual(object["email"] as? String, "hikari@example.jp")
        XCTAssertEqual(object["password"] as? String, "correct-horse-battery")
        XCTAssertEqual(object["nickname"] as? String, "小光")
        XCTAssertEqual(
            object["deviceId"] as? String,
            DeviceIdentity.current.uuidString.lowercased()
        )
        XCTAssertEqual(Set(object.keys), ["email", "password", "nickname", "deviceId"])

        XCTAssertEqual(session.sessionId, Self.sessionID)
        XCTAssertEqual(session.user.publicHandle, "tokyo_hikari")
        let stored = try await vault.session()
        XCTAssertEqual(stored?.sessionId, Self.sessionID)
        XCTAssertEqual(stored?.accessToken, "access-token-1")
    }

    func testLoginSendsContractBodyWithoutNicknameAndPersistsSession() async throws {
        let requests = PasswordAuthRequestBox()
        PasswordAuthURLProtocol.onRequest = { request, body in
            requests.append(request, body: body)
            return (200, Self.sessionJSON)
        }
        let vault = CredentialVaultStub()
        let client = makeClient(vault: vault)

        let session = try await client.loginWithPassword(
            email: "hikari@example.jp",
            password: "correct-horse-battery"
        )

        let captured = try XCTUnwrap(requests.requests.first)
        XCTAssertEqual(captured.request.url?.path, "/v1/auth/password/login")
        XCTAssertEqual(captured.request.httpMethod, "POST")
        XCTAssertNil(captured.request.value(forHTTPHeaderField: "Authorization"))
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: XCTUnwrap(captured.body)) as? [String: Any]
        )
        XCTAssertEqual(Set(object.keys), ["email", "password", "deviceId"])
        XCTAssertEqual(object["email"] as? String, "hikari@example.jp")
        XCTAssertEqual(object["password"] as? String, "correct-horse-battery")
        XCTAssertEqual(
            object["deviceId"] as? String,
            DeviceIdentity.current.uuidString.lowercased()
        )

        XCTAssertEqual(session.sessionId, Self.sessionID)
        let stored = try await vault.session()
        XCTAssertEqual(stored?.sessionId, Self.sessionID)
    }

    private func makeClient(vault: CredentialVaultStub) -> SpottAPIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PasswordAuthURLProtocol.self]
        return SpottAPIClient(
            environment: .init(baseURL: URL(string: "https://api.spott.test/v1")!),
            credentials: vault,
            session: URLSession(configuration: configuration)
        )
    }

    private static let sessionID = UUID(uuidString: "019b0000-0000-7000-a000-000000000101")!

    private static let sessionJSON = Data("""
    {
        "accessToken": "access-token-1",
        "accessTokenExpiresAt": "2026-07-23T10:15:00Z",
        "refreshToken": "refresh-token-1",
        "refreshGeneration": 1,
        "sessionId": "019b0000-0000-7000-a000-000000000101",
        "user": {
            "id": "019b0000-0000-7000-a000-000000000102",
            "publicHandle": "tokyo_hikari",
            "phoneVerified": false,
            "restrictions": []
        }
    }
    """.utf8)
}

private actor CredentialVaultStub: CredentialStoring {
    private var active: UserSession?

    func save(session: UserSession) throws {
        active = session
    }

    @discardableResult
    func replace(session: UserSession, expectedSessionID: UUID) throws -> Bool {
        guard active?.sessionId == expectedSessionID else { return false }
        active = session
        return true
    }

    func session() throws -> UserSession? { active }

    @discardableResult
    func clear(expectedSessionID: UUID) throws -> Bool {
        guard active?.sessionId == expectedSessionID else { return false }
        active = nil
        return true
    }
}

private final class PasswordAuthRequestBox: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [(request: URLRequest, body: Data?)] = []

    var requests: [(request: URLRequest, body: Data?)] { lock.withLock { storage } }

    func append(_ request: URLRequest, body: Data?) {
        lock.withLock { storage.append((request, body)) }
    }
}

private final class PasswordAuthURLProtocol: URLProtocol, @unchecked Sendable {
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
