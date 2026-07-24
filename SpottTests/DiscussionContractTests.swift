import Foundation
import XCTest
@testable import Spott

final class DiscussionContractTests: XCTestCase {
    private let groupID = UUID(uuidString: "019b0000-0000-7000-a000-000000000201")!
    private let commentID = UUID(uuidString: "019b0000-0000-7000-a000-000000000202")!

    override func tearDown() {
        DiscussionURLProtocol.onRequest = nil
        super.tearDown()
    }

    func testPostGroupDiscussionSendsIdempotentContractBody() async throws {
        let requests = DiscussionRequestBox()
        DiscussionURLProtocol.onRequest = { request, body in
            requests.append(request, body: body)
            return (201, Self.postJSON)
        }
        let client = makeClient()

        let post = try await client.postGroupDiscussion(
            groupID: groupID,
            body: "周末走隅田川吗？",
            locale: "zh-Hans"
        )

        let captured = try XCTUnwrap(requests.requests.first)
        let request = captured.request
        XCTAssertEqual(request.url?.path, "/v1/groups/\(groupID.uuidString.lowercased())/discussion")
        XCTAssertEqual(request.httpMethod, "POST")
        let idempotencyKey = try XCTUnwrap(request.value(forHTTPHeaderField: "Idempotency-Key"))
        XCTAssertNotNil(UUID(uuidString: idempotencyKey))
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: XCTUnwrap(captured.body)) as? [String: Any]
        )
        XCTAssertEqual(Set(object.keys), ["body", "locale"])
        XCTAssertEqual(object["body"] as? String, "周末走隅田川吗？")
        XCTAssertEqual(object["locale"] as? String, "zh-Hans")

        XCTAssertEqual(post.id, commentID)
        XCTAssertEqual(post.groupId, groupID)
        XCTAssertEqual(post.likeCount, 0)
        XCTAssertFalse(post.viewerLiked)
        XCTAssertEqual(post.replyCount, 0)
    }

    func testSetDiscussionLikeTogglesBetweenPutAndDelete() async throws {
        let requests = DiscussionRequestBox()
        let commentIDString = commentID.uuidString.lowercased()
        DiscussionURLProtocol.onRequest = { request, body in
            requests.append(request, body: body)
            let liked = request.httpMethod == "PUT"
            let json = Data("""
            {"commentId": "\(commentIDString)", "liked": \(liked)}
            """.utf8)
            return (200, json)
        }
        let client = makeClient()

        let liked = try await client.setDiscussionLike(
            groupID: groupID,
            commentID: commentID,
            liked: true
        )
        let unliked = try await client.setDiscussionLike(
            groupID: groupID,
            commentID: commentID,
            liked: false
        )

        XCTAssertEqual(requests.requests.count, 2)
        let expectedPath = "/v1/groups/\(groupID.uuidString.lowercased())"
            + "/discussion/\(commentID.uuidString.lowercased())/like"
        XCTAssertEqual(requests.requests[0].request.url?.path, expectedPath)
        XCTAssertEqual(requests.requests[0].request.httpMethod, "PUT")
        XCTAssertEqual(requests.requests[1].request.url?.path, expectedPath)
        XCTAssertEqual(requests.requests[1].request.httpMethod, "DELETE")

        XCTAssertEqual(liked.commentId, commentID)
        XCTAssertTrue(liked.liked)
        XCTAssertEqual(unliked.commentId, commentID)
        XCTAssertFalse(unliked.liked)
    }

    private func makeClient() -> SpottAPIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DiscussionURLProtocol.self]
        return SpottAPIClient(
            environment: .init(baseURL: URL(string: "https://api.spott.test/v1")!),
            credentials: CredentialVault(service: "jp.spott.discussion-tests.\(UUID().uuidString)"),
            session: URLSession(configuration: configuration),
            usesCredentials: false
        )
    }

    private static let postJSON = Data("""
    {
        "id": "019b0000-0000-7000-a000-000000000202",
        "groupId": "019b0000-0000-7000-a000-000000000201",
        "author": {"id": "019b0000-0000-7000-a000-000000000203", "name": "小光"},
        "body": "周末走隅田川吗？",
        "parentId": null,
        "locale": "zh-Hans",
        "likeCount": 0,
        "viewerLiked": false,
        "replyCount": 0,
        "version": 1,
        "createdAt": "2026-07-23T09:00:00Z",
        "updatedAt": "2026-07-23T09:00:00Z"
    }
    """.utf8)
}

private final class DiscussionRequestBox: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [(request: URLRequest, body: Data?)] = []

    var requests: [(request: URLRequest, body: Data?)] { lock.withLock { storage } }

    func append(_ request: URLRequest, body: Data?) {
        lock.withLock { storage.append((request, body)) }
    }
}

private final class DiscussionURLProtocol: URLProtocol, @unchecked Sendable {
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
