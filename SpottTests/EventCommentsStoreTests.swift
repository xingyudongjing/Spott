import Foundation
import XCTest
@testable import Spott

@MainActor
final class EventCommentsStoreTests: XCTestCase {
    private let eventID = UUID(uuidString: "019b0000-0000-7000-8100-00000000e001")!
    private let viewerID = UUID(uuidString: "019b0000-0000-7000-8100-00000000a001")!

    func testLoadGroupsThreadsNewestFirstWithChronologicalReplies() async {
        let older = makeComment(id: 1, createdAt: 10)
        let newer = makeComment(id: 2, createdAt: 20)
        let earlyReply = makeComment(id: 3, createdAt: 30, parent: older.id)
        let lateReply = makeComment(id: 4, createdAt: 40, parent: older.id)
        let service = CommentServiceStub(
            page: EventCommentPage(
                eventId: eventID,
                commentPermission: "participants",
                items: [older, newer, lateReply, earlyReply]
            )
        )
        let store = EventCommentsStore(eventID: eventID, service: service)

        await store.load()

        XCTAssertEqual(store.phase, .loaded)
        XCTAssertEqual(store.permission, "participants")
        XCTAssertEqual(store.threads.map(\.comment.id), [newer.id, older.id])
        XCTAssertEqual(store.threads.last?.replies.map(\.id), [earlyReply.id, lateReply.id])
    }

    func testPostFailureRollsBackOptimisticAppendAndSurfacesError() async {
        let existing = makeComment(id: 1, createdAt: 10)
        let service = CommentServiceStub(
            page: EventCommentPage(
                eventId: eventID,
                commentPermission: "participants",
                items: [existing]
            ),
            postFailure: APIError(
                status: 403,
                code: "EVENT_COMMENT_FORBIDDEN",
                message: "只有已确认报名的参加者可以评论。",
                retryable: false
            )
        )
        let store = EventCommentsStore(eventID: eventID, service: service)
        await store.load()

        let posted = await store.post(
            body: "占位评论",
            parentID: nil,
            viewerID: viewerID,
            viewerName: "spott_user"
        )

        XCTAssertFalse(posted)
        XCTAssertEqual(store.comments.map(\.id), [existing.id])
        XCTAssertEqual(store.postError?.id, "EVENT_COMMENT_FORBIDDEN")
    }

    func testPostSuccessKeepsServerCommentAndClearsError() async {
        let existing = makeComment(id: 1, createdAt: 10)
        let created = makeComment(id: 9, createdAt: 50)
        let service = CommentServiceStub(
            page: EventCommentPage(
                eventId: eventID,
                commentPermission: "participants",
                items: [existing, created]
            ),
            postResponse: created
        )
        let store = EventCommentsStore(eventID: eventID, service: service)
        await store.load()

        let posted = await store.post(
            body: created.body,
            parentID: nil,
            viewerID: viewerID,
            viewerName: "spott_user"
        )

        XCTAssertTrue(posted)
        XCTAssertNil(store.postError)
        XCTAssertTrue(store.comments.contains { $0.id == created.id })
        XCTAssertFalse(store.comments.contains { $0.author.id == viewerID })
    }

    func testPostRejectsBodiesOverTheTwoThousandCharacterLimit() async {
        let service = CommentServiceStub(
            page: EventCommentPage(
                eventId: eventID,
                commentPermission: "participants",
                items: []
            )
        )
        let store = EventCommentsStore(eventID: eventID, service: service)
        await store.load()

        let posted = await store.post(
            body: String(repeating: "评", count: EventCommentsStore.maximumBodyLength + 1),
            parentID: nil,
            viewerID: viewerID,
            viewerName: "spott_user"
        )

        XCTAssertFalse(posted)
        XCTAssertTrue(store.comments.isEmpty)
        let postCount = await service.postCount()
        XCTAssertEqual(postCount, 0)
    }

    private func makeComment(
        id suffix: Int,
        createdAt offset: TimeInterval,
        parent: UUID? = nil
    ) -> EventComment {
        let base = Date(timeIntervalSince1970: 1_780_000_000)
        return EventComment(
            id: UUID(uuidString: String(format: "019b0000-0000-7000-8100-0000000000%02d", suffix))!,
            eventId: eventID,
            author: EventCommentAuthor(
                id: UUID(uuidString: "019b0000-0000-7000-8100-0000000000ff")!,
                name: "隅田川散步组"
            ),
            body: "评论内容 \(suffix)",
            parentId: parent,
            locale: "zh-Hans",
            version: 1,
            createdAt: base.addingTimeInterval(offset),
            updatedAt: base.addingTimeInterval(offset)
        )
    }
}

private actor CommentServiceStub: EventCommentServing {
    private let page: EventCommentPage
    private let postResponse: EventComment?
    private let postFailure: Error?
    private var posts = 0

    init(
        page: EventCommentPage,
        postResponse: EventComment? = nil,
        postFailure: Error? = nil
    ) {
        self.page = page
        self.postResponse = postResponse
        self.postFailure = postFailure
    }

    func postCount() -> Int { posts }

    func eventComments(eventID: UUID, cursor: String?, limit: Int) async throws -> EventCommentPage {
        page
    }

    func postEventComment(
        eventID: UUID,
        body: String,
        parentID: UUID?,
        locale: String
    ) async throws -> EventComment {
        posts += 1
        if let postFailure { throw postFailure }
        guard let postResponse else { throw CancellationError() }
        return postResponse
    }
}
