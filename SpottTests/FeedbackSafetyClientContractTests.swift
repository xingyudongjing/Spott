import Foundation
import XCTest
@testable import Spott

final class FeedbackSafetyClientContractTests: XCTestCase {
    override func tearDown() {
        FeedbackSafetyURLProtocol.reset()
        super.tearDown()
    }

    func testOwnFeedbackDecodesPrivatePrefillAndEditEligibility() async throws {
        let client = makeClient()
        FeedbackSafetyURLProtocol.responses = [
            Data(#"{"registrationId":"019b0000-0000-7000-8200-000000000003","eventId":"019b0000-0000-7000-8100-000000000001","state":"edit_available","canSubmit":true,"canEdit":true,"windowClosesAt":"2026-08-14T00:00:00.000Z","feedback":{"id":"019b0000-0000-7000-8300-000000000001","attendanceRating":3,"tags":["friendly","safe"],"comment":"Clearer meeting notes, please.","visibility":"private","moderationState":"pending","editCount":0,"createdAt":"2026-07-16T00:00:00.000Z","updatedAt":"2026-07-16T01:00:00.000Z"}}"#.utf8),
        ]

        let value = try await client.ownFeedback(registrationID: registrationID)

        XCTAssertEqual(value.state, .editAvailable)
        XCTAssertTrue(value.canEdit)
        XCTAssertEqual(value.feedback?.attendanceRating, 3)
        XCTAssertEqual(value.feedback?.tags, [.friendly, .safe])
        XCTAssertEqual(value.feedback?.comment, "Clearer meeting notes, please.")
        XCTAssertEqual(value.feedback?.visibility, .private)
        XCTAssertEqual(FeedbackSafetyURLProtocol.requests.first?.httpMethod, "GET")
    }

    func testFeedbackRetryCanReuseTheExactCallerOwnedIdempotencyKey() async throws {
        let client = makeClient()
        let key = UUID(uuidString: "019b0000-0000-7000-8400-000000000001")!
        FeedbackSafetyURLProtocol.responses = [receipt, receipt]
        let payload = FeedbackSubmissionPayload(
            attendanceRating: 5,
            tags: [.friendly],
            comment: nil,
            visibility: .aggregateOnly
        )

        _ = try await client.submitFeedback(registrationID: registrationID, payload: payload, idempotencyKey: key)
        _ = try await client.submitFeedback(registrationID: registrationID, payload: payload, idempotencyKey: key)

        XCTAssertEqual(
            FeedbackSafetyURLProtocol.requests.map { $0.value(forHTTPHeaderField: "Idempotency-Key") },
            [key.uuidString.lowercased(), key.uuidString.lowercased()]
        )
    }

    func testSafetyRetryCanReuseTheExactCallerOwnedIdempotencyKey() async throws {
        let client = makeClient()
        let key = UUID(uuidString: "019b0000-0000-7000-8400-000000000002")!
        FeedbackSafetyURLProtocol.responses = [reportReceipt, reportReceipt]
        let payload = SafetyReportPayload(
            targetType: .event,
            targetId: UUID(uuidString: "019b0000-0000-7000-8100-000000000001")!,
            reason: "danger",
            details: "Unsafe meeting instructions.",
            evidenceAssetIds: []
        )

        _ = try await client.submitSafetyReport(payload, idempotencyKey: key)
        _ = try await client.submitSafetyReport(payload, idempotencyKey: key)

        XCTAssertEqual(
            FeedbackSafetyURLProtocol.requests.map { $0.value(forHTTPHeaderField: "Idempotency-Key") },
            [key.uuidString.lowercased(), key.uuidString.lowercased()]
        )
    }

    func testStableAttemptReusesAKeyOnlyForTheExactEncodedPayload() throws {
        let firstKey = UUID(uuidString: "019b0000-0000-7000-8400-000000000011")!
        let secondKey = UUID(uuidString: "019b0000-0000-7000-8400-000000000012")!
        var generated = [firstKey, secondKey]
        let original = FeedbackSubmissionPayload(
            attendanceRating: 5,
            tags: [.friendly, .safe],
            comment: "Keep the clear meeting note.",
            visibility: .aggregateOnly
        )
        let changed = FeedbackSubmissionPayload(
            attendanceRating: 4,
            tags: [.friendly, .safe],
            comment: "Keep the clear meeting note.",
            visibility: .aggregateOnly
        )

        let first = try StableIdempotencyAttempt.resolve(
            existing: nil,
            payload: original,
            makeKey: { generated.removeFirst() }
        )
        let retry = try StableIdempotencyAttempt.resolve(
            existing: first,
            payload: original,
            makeKey: { generated.removeFirst() }
        )
        let changedAttempt = try StableIdempotencyAttempt.resolve(
            existing: retry,
            payload: changed,
            makeKey: { generated.removeFirst() }
        )

        XCTAssertEqual(first.idempotencyKey, firstKey)
        XCTAssertEqual(retry.idempotencyKey, firstKey)
        XCTAssertEqual(changedAttempt.idempotencyKey, secondKey)
        XCTAssertTrue(generated.isEmpty)
    }

    func testSuccessfulFeedbackEditInvalidatesOldEligibilityUntilARefreshSucceeds() {
        let oldState = OwnFeedbackState(
            registrationId: registrationID,
            eventId: UUID(uuidString: "019b0000-0000-7000-8100-000000000001")!,
            state: .editAvailable,
            canSubmit: true,
            canEdit: true,
            windowClosesAt: nil,
            feedback: nil
        )
        var authority = FeedbackSubmissionAuthority(value: oldState)
        XCTAssertTrue(authority.canEdit)
        XCTAssertTrue(authority.canSubmit)

        authority.mutationSucceeded()
        authority.refreshFailed(afterSubmission: true)

        XCTAssertNil(authority.value)
        XCTAssertFalse(authority.canEdit)
        XCTAssertFalse(authority.canSubmit)
        XCTAssertTrue(authority.refreshFailedAfterSubmission)

        authority.received(oldState)

        XCTAssertTrue(authority.canEdit)
        XCTAssertTrue(authority.canSubmit)
        XCTAssertFalse(authority.refreshFailedAfterSubmission)
    }

    private var registrationID: UUID {
        UUID(uuidString: "019b0000-0000-7000-8200-000000000003")!
    }

    private var receipt: Data {
        Data(#"{"id":"019b0000-0000-7000-8300-000000000001","eventId":"019b0000-0000-7000-8100-000000000001","status":"pending_moderation","editCount":0,"rewardPoints":20,"createdAt":"2026-07-16T00:00:00Z"}"#.utf8)
    }

    private var reportReceipt: Data {
        Data(#"{"reference":"SPT-2026-ABCDEF123456","status":"received","submittedAt":"2026-07-16T00:00:00Z"}"#.utf8)
    }

    private func makeClient() -> SpottAPIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FeedbackSafetyURLProtocol.self]
        return SpottAPIClient(
            environment: .init(baseURL: URL(string: "https://api.spott.test/v1")!),
            credentials: CredentialVault(service: "jp.spott.feedback-safety-tests.\(UUID().uuidString)"),
            session: URLSession(configuration: configuration),
            usesCredentials: false
        )
    }
}

private final class FeedbackSafetyURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var requests: [URLRequest] = []
    nonisolated(unsafe) static var responses: [Data] = []

    static func reset() {
        requests = []
        responses = []
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.requests.append(request)
        let data = Self.responses.isEmpty ? Data() : Self.responses.removeFirst()
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
