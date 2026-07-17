import Foundation
import XCTest
@testable import Spott

final class CalendarIntegrationTests: XCTestCase {
    func testAddRequestsWriteOnlyAccessBeforeSavingTheEvent() async throws {
        let writer = CalendarEventWriterSpy(authorization: .granted)
        let integration = CalendarIntegration(writer: writer)
        let start = Date(timeIntervalSince1970: 1_784_150_400)
        let end = start.addingTimeInterval(7_200)

        try await integration.add(
            title: "Tokyo Design Walk",
            start: start,
            end: end,
            notes: "Spott event"
        )

        let snapshot = await writer.snapshot()
        XCTAssertEqual(snapshot.authorizationRequests, 1)
        XCTAssertEqual(
            snapshot.savedDrafts,
            [
                CalendarEventDraft(
                    title: "Tokyo Design Walk",
                    start: start,
                    end: end,
                    notes: "Spott event"
                ),
            ]
        )
    }

    func testDeniedWriteOnlyAccessThrowsTypedErrorWithoutSaving() async {
        let writer = CalendarEventWriterSpy(authorization: .denied)
        let integration = CalendarIntegration(writer: writer)

        await XCTAssertThrowsErrorAsync(
            try await integration.add(
                title: "Tokyo Design Walk",
                start: .now,
                end: .now.addingTimeInterval(7_200),
                notes: "Spott event"
            )
        ) { error in
            XCTAssertEqual(error as? CalendarIntegrationError, .permissionDenied)
        }

        let snapshot = await writer.snapshot()
        XCTAssertEqual(snapshot.savedDrafts, [])
    }

    func testAuthorizationFailureIsMappedToTypedError() async {
        let writer = CalendarEventWriterSpy(authorization: .failure)
        let integration = CalendarIntegration(writer: writer)

        await XCTAssertThrowsErrorAsync(
            try await integration.add(
                title: "Tokyo Design Walk",
                start: .now,
                end: .now.addingTimeInterval(7_200),
                notes: "Spott event"
            )
        ) { error in
            XCTAssertEqual(error as? CalendarIntegrationError, .authorizationFailed)
        }
    }

    func testSaveFailureIsMappedToTypedError() async {
        let writer = CalendarEventWriterSpy(authorization: .granted, saveFails: true)
        let integration = CalendarIntegration(writer: writer)

        await XCTAssertThrowsErrorAsync(
            try await integration.add(
                title: "Tokyo Design Walk",
                start: .now,
                end: .now.addingTimeInterval(7_200),
                notes: "Spott event"
            )
        ) { error in
            XCTAssertEqual(error as? CalendarIntegrationError, .writeFailed)
        }
    }
}

private actor CalendarEventWriterSpy: CalendarEventWriting {
    enum Authorization: Sendable {
        case granted
        case denied
        case failure
    }

    struct Snapshot: Sendable {
        let authorizationRequests: Int
        let savedDrafts: [CalendarEventDraft]
    }

    private enum StubError: Error {
        case unavailable
    }

    private let authorization: Authorization
    private let saveFails: Bool
    private var authorizationRequests = 0
    private var savedDrafts: [CalendarEventDraft] = []

    init(authorization: Authorization, saveFails: Bool = false) {
        self.authorization = authorization
        self.saveFails = saveFails
    }

    func requestWriteOnlyAccess() async throws -> Bool {
        authorizationRequests += 1
        return switch authorization {
        case .granted: true
        case .denied: false
        case .failure: throw StubError.unavailable
        }
    }

    func save(_ draft: CalendarEventDraft) async throws {
        if saveFails { throw StubError.unavailable }
        savedDrafts.append(draft)
    }

    func snapshot() -> Snapshot {
        Snapshot(
            authorizationRequests: authorizationRequests,
            savedDrafts: savedDrafts
        )
    }
}

private func XCTAssertThrowsErrorAsync<T>(
    _ expression: @autoclosure () async throws -> T,
    _ errorHandler: (Error) -> Void,
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        _ = try await expression()
        XCTFail("Expected expression to throw", file: file, line: line)
    } catch {
        errorHandler(error)
    }
}
