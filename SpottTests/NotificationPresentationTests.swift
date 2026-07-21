import SwiftUI
import XCTest
@testable import Spott

final class NotificationPresentationTests: XCTestCase {
    override func tearDown() {
        NotificationURLProtocol.reset()
        super.tearDown()
    }

    func testThreeLocaleFixturesPreserveServerPresentationMetadataAndCopy() throws {
        let fixtures: [(locale: EventLocale, title: String, body: String)] = [
            (.zhHans, "活动已取消", "东京野餐已取消，积分将按规则退回。"),
            (.ja, "イベントは中止されました", "東京ピクニックは中止されました。"),
            (.en, "Event cancelled", "Tokyo Picnic was cancelled."),
        ]

        for (index, fixture) in fixtures.enumerated() {
            let data = try XCTUnwrap(
                """
                {
                  "id": "019b0000-0000-7000-8100-00000000000\(index + 1)",
                  "type": "event.cancelled",
                  "locale": "\(fixture.locale.rawValue)",
                  "templateVersion": 7,
                  "title": "\(fixture.title)",
                  "body": "\(fixture.body)",
                  "variables": { "eventTitle": "Tokyo Picnic" },
                  "resourceType": "event",
                  "resourcePublicId": "tokyo-picnic",
                  "createdAt": "2026-07-19T01:02:03Z",
                  "readAt": null
                }
                """.data(using: .utf8)
            )
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601

            let item = try decoder.decode(NotificationItem.self, from: data)

            XCTAssertEqual(item.locale, fixture.locale)
            XCTAssertEqual(item.templateVersion, 7)
            XCTAssertEqual(item.title, fixture.title)
            XCTAssertEqual(item.body, fixture.body)
            XCTAssertEqual(item.variables["eventTitle"], .string("Tokyo Picnic"))
        }
    }

    func testNotificationVariablesRoundTripLargeAndNestedNumbersWithoutPrecisionLoss() throws {
        let source = Data(
            #"{"sequence":9007199254740993,"nested":{"values":[9007199254740993,12.75]}}"#.utf8
        )

        let decoded = try JSONDecoder().decode(JSONValue.self, from: source)
        let encoded = try JSONEncoder().encode(decoded)
        let encodedText = try XCTUnwrap(String(data: encoded, encoding: .utf8))

        XCTAssertTrue(encodedText.contains("9007199254740993"), encodedText)
        XCTAssertFalse(encodedText.contains("9007199254740992"), encodedText)
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: encoded), decoded)
    }

    func testJSONValueStillRejectsNonFiniteNumbersDuringEncoding() {
        XCTAssertThrowsError(try JSONEncoder().encode(JSONValue.number(.nan)))
    }

    func testCanonicalNotificationTypesRequireExactResourceTypeAndUseExistingDeepLinks() {
        let eventID = "019b0000-0000-7000-8100-000000000041"
        let groupID = "019b0000-0000-7000-8200-000000000042"

        XCTAssertEqual(item(type: "event.cancelled", resourcePublicID: eventID, resourceType: "event").destinationURL, URL(string: "spott://e/\(eventID)"))
        XCTAssertEqual(item(type: "waitlist.offered", resourcePublicID: eventID, resourceType: "event").destinationURL, URL(string: "spott://e/\(eventID)"))
        XCTAssertEqual(item(type: "group.announcement", resourcePublicID: groupID, resourceType: "group").destinationURL, URL(string: "spott://g/\(groupID)"))
        XCTAssertEqual(item(type: "group.dissolution_scheduled", resourcePublicID: groupID, resourceType: "group").destinationURL, URL(string: "spott://g/\(groupID)"))
    }

    func testNilEmptyMismatchedAndUnsafeTargetsStayInNotificationCenter() {
        XCTAssertNil(item(type: "event.cancelled", resourcePublicID: "event-1", resourceType: nil).destinationURL)
        XCTAssertNil(item(type: "event.cancelled", resourcePublicID: "event-1", resourceType: "").destinationURL)
        XCTAssertNil(item(type: "event.cancelled", resourcePublicID: "event-1", resourceType: "group").destinationURL)
        XCTAssertNil(item(type: "group.announcement", resourcePublicID: "group-1", resourceType: "event").destinationURL)
        XCTAssertNil(item(type: "moderation.decided", resourcePublicID: "resource-1", resourceType: "event").destinationURL)
        XCTAssertNil(item(type: "event.cancelled", resourcePublicID: nil, resourceType: "event").destinationURL)
        XCTAssertNil(item(type: "event.cancelled", resourcePublicID: "event/secret", resourceType: "event").destinationURL)
        XCTAssertNil(item(type: "group.announcement", resourcePublicID: " group-id ", resourceType: "group").destinationURL)
    }

    func testAppLocaleMapsToSupportedNotificationLocaleAndRelativeTimeIsExplicitlyLocalized() {
        XCTAssertEqual(NotificationCenterLocale.eventLocale(for: Locale(identifier: "zh-Hans-JP")), .zhHans)
        XCTAssertEqual(NotificationCenterLocale.eventLocale(for: Locale(identifier: "ja-JP")), .ja)
        XCTAssertEqual(NotificationCenterLocale.eventLocale(for: Locale(identifier: "en-GB")), .en)

        let date = Date(timeIntervalSince1970: 1_721_350_800)
        let reference = date.addingTimeInterval(2 * 60 * 60)
        let zh = NotificationTimestampFormatter.string(for: date, relativeTo: reference, locale: Locale(identifier: "zh-Hans"))
        let ja = NotificationTimestampFormatter.string(for: date, relativeTo: reference, locale: Locale(identifier: "ja"))
        let en = NotificationTimestampFormatter.string(for: date, relativeTo: reference, locale: Locale(identifier: "en"))

        XCTAssertNotEqual(zh, ja)
        XCTAssertNotEqual(ja, en)
        XCTAssertTrue(en.lowercased().contains("hour"), en)
    }

    func testUnsupportedSystemLocaleUsesTheSameEnglishFallbackForAPIAndInterfaceCopy() {
        let unsupportedLocale = Locale(identifier: "fr-FR")

        XCTAssertEqual(NotificationCenterLocale.eventLocale(for: unsupportedLocale), .en)
        XCTAssertEqual(
            NotificationCenterCopy(locale: unsupportedLocale).title,
            NotificationCenterCopy(locale: Locale(identifier: "en")).title
        )
        XCTAssertEqual(NotificationCenterCopy(locale: unsupportedLocale).title, "Notifications")
    }

    func testNotificationsAPIForwardsAppLocaleCursorAndDefaultOrCustomLimit() async throws {
        NotificationURLProtocol.configure(
            responseData: Data(#"{"items":[],"nextCursor":null,"hasMore":false}"#.utf8)
        )
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [NotificationURLProtocol.self]
        let client = SpottAPIClient(
            environment: .init(baseURL: URL(string: "https://api.spott.test/v1")!),
            credentials: CredentialVault(service: "jp.spott.tests.\(UUID().uuidString)"),
            session: URLSession(configuration: configuration),
            usesCredentials: false
        )

        _ = try await client.notifications(locale: .ja, cursor: "next-page")

        var components = try XCTUnwrap(
            URLComponents(
                url: try XCTUnwrap(NotificationURLProtocol.requests().last?.url),
                resolvingAgainstBaseURL: false
            )
        )
        XCTAssertEqual(components.path, "/v1/notifications")
        XCTAssertEqual(components.queryItems?.first { $0.name == "locale" }?.value, "ja")
        XCTAssertEqual(components.queryItems?.first { $0.name == "cursor" }?.value, "next-page")
        XCTAssertEqual(components.queryItems?.first { $0.name == "limit" }?.value, "20")

        _ = try await client.notifications(locale: .en, cursor: nil, limit: 47)

        components = try XCTUnwrap(
            URLComponents(
                url: try XCTUnwrap(NotificationURLProtocol.requests().last?.url),
                resolvingAgainstBaseURL: false
            )
        )
        XCTAssertEqual(components.queryItems?.first { $0.name == "locale" }?.value, "en")
        XCTAssertNil(components.queryItems?.first { $0.name == "cursor" })
        XCTAssertEqual(components.queryItems?.first { $0.name == "limit" }?.value, "47")
    }

    func testMarkNotificationReadUsesTheNotificationIDAsAStableIdempotencyKey() async throws {
        NotificationURLProtocol.configure(responseData: Data("{}".utf8))
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [NotificationURLProtocol.self]
        let client = SpottAPIClient(
            environment: .init(baseURL: URL(string: "https://api.spott.test/v1")!),
            credentials: CredentialVault(service: "jp.spott.tests.\(UUID().uuidString)"),
            session: URLSession(configuration: configuration),
            usesCredentials: false
        )
        let notificationID = UUID(uuidString: "019b0000-0000-7000-8100-000000000099")!

        try await client.markNotificationRead(notificationID)
        try await client.markNotificationRead(notificationID)

        let requests = Array(NotificationURLProtocol.requests().suffix(2))
        XCTAssertEqual(requests.count, 2)
        XCTAssertTrue(requests.allSatisfy { $0.httpMethod == "PUT" })
        XCTAssertTrue(
            requests.allSatisfy {
                $0.url?.path == "/v1/notifications/items/\(notificationID.uuidString.lowercased())/read"
            }
        )
        XCTAssertEqual(
            requests.map { $0.value(forHTTPHeaderField: "Idempotency-Key") },
            Array(repeating: notificationID.uuidString.lowercased(), count: 2)
        )
    }

    func testNotificationURLProtocolStorageSnapshotsResponseAtomicallyAcrossReset() throws {
        let storage = NotificationURLProtocolStorage()
        let responseData = Data(#"{"items":[],"nextCursor":null,"hasMore":false}"#.utf8)
        let request = URLRequest(
            url: try XCTUnwrap(URL(string: "https://api.spott.test/v1/notifications"))
        )
        storage.configure(responseData: responseData)

        let snapshot = storage.capture(request)
        storage.reset()

        XCTAssertEqual(snapshot.responseData, responseData)
        XCTAssertTrue(storage.requests().isEmpty)
    }

    func testNotificationURLProtocolRecordsConcurrentClientsWithoutSharedStateRaces() async throws {
        NotificationURLProtocol.configure(
            responseData: Data(#"{"items":[],"nextCursor":null,"hasMore":false}"#.utf8)
        )

        try await withThrowingTaskGroup(of: Void.self) { group in
            for index in 0 ..< 12 {
                group.addTask {
                    let configuration = URLSessionConfiguration.ephemeral
                    configuration.protocolClasses = [NotificationURLProtocol.self]
                    let client = SpottAPIClient(
                        environment: .init(baseURL: URL(string: "https://api.spott.test/v1")!),
                        credentials: CredentialVault(
                            service: "jp.spott.tests.\(UUID().uuidString)"
                        ),
                        session: URLSession(configuration: configuration),
                        usesCredentials: false
                    )
                    _ = try await client.notifications(
                        locale: .en,
                        cursor: "concurrent-\(index)"
                    )
                }
            }
            try await group.waitForAll()
        }

        let cursors = Set(NotificationURLProtocol.requests().compactMap { request in
            URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
                .queryItems?
                .first { $0.name == "cursor" }?
                .value
        })
        XCTAssertEqual(cursors, Set((0 ..< 12).map { "concurrent-\($0)" }))
    }

    @MainActor
    func testInitialLoadEmptyRetryRefreshAndCursorStateAreSeparate() async {
        let store = NotificationCenterStore()
        await store.load { _ in throw StubError.failed }
        XCTAssertEqual(store.phase, .failed)

        await store.load { _ in .init(items: [], nextCursor: nil, hasMore: false) }
        XCTAssertEqual(store.phase, .empty)

        let notification = item(type: "waitlist.offered", resourcePublicID: "event-1", resourceType: "event")
        await store.load { cursor in
            XCTAssertNil(cursor)
            return .init(items: [notification], nextCursor: "page-2", hasMore: true)
        }
        XCTAssertEqual(store.phase, .content([notification]))
        XCTAssertEqual(store.nextCursor, "page-2")
        XCTAssertTrue(store.hasMore)

        await store.load(isRefresh: true) { _ in throw StubError.failed }
        XCTAssertEqual(store.phase, .content([notification]))
        XCTAssertEqual(store.notice, .refreshFailed)
        XCTAssertEqual(store.nextCursor, "page-2")
    }

    @MainActor
    func testPaginationDeduplicatesIDsStopsAtTailAndRetainsItemsForRetryAfterFailure() async {
        let store = NotificationCenterStore()
        let first = item(id: UUID(), type: "event.cancelled", resourcePublicID: "event-1", resourceType: "event")
        let second = item(id: UUID(), type: "group.announcement", resourcePublicID: "group-1", resourceType: "group")
        await store.load { _ in .init(items: [first], nextCursor: "p2", hasMore: true) }

        await store.loadNextPage { cursor in
            XCTAssertEqual(cursor, "p2")
            throw StubError.failed
        }
        XCTAssertEqual(store.phase, .content([first]))
        XCTAssertTrue(store.paginationFailed)

        await store.retryPagination { cursor in
            XCTAssertEqual(cursor, "p2")
            return .init(items: [first, second], nextCursor: nil, hasMore: false)
        }
        XCTAssertEqual(store.phase, .content([first, second]))
        XCTAssertFalse(store.hasMore)
        XCTAssertNil(store.nextCursor)
        XCTAssertFalse(store.paginationFailed)
    }

    @MainActor
    func testEmptyFirstPageWithCursorStaysPageableAndLoadsTheNextPage() async {
        let store = NotificationCenterStore()
        let notification = item(
            type: "event.cancelled",
            resourcePublicID: "event-page-2",
            resourceType: "event"
        )

        await store.load { _ in
            .init(items: [], nextCursor: "p2", hasMore: true)
        }

        XCTAssertEqual(store.phase, .content([]))
        XCTAssertEqual(store.paginationTaskID, "p2")
        await store.loadNextPage { cursor in
            XCTAssertEqual(cursor, "p2")
            return .init(items: [notification], nextCursor: nil, hasMore: false)
        }
        XCTAssertEqual(store.phase, .content([notification]))
    }

    @MainActor
    func testEmptyFirstPageWithMissingCursorExposesRecoverableReload() async {
        let store = NotificationCenterStore()
        let notification = item(
            type: "group.announcement",
            resourcePublicID: "group-reloaded",
            resourceType: "group"
        )

        await store.load { _ in
            .init(items: [], nextCursor: nil, hasMore: true)
        }

        XCTAssertEqual(store.phase, .content([]))
        XCTAssertTrue(store.paginationFailed)
        XCTAssertTrue(store.paginationRecoveryRequiresReload)
        await store.retryPagination { cursor in
            XCTAssertNil(cursor)
            return .init(items: [notification], nextCursor: nil, hasMore: false)
        }
        XCTAssertEqual(store.phase, .content([notification]))
        XCTAssertFalse(store.paginationFailed)
    }

    @MainActor
    func testPaginationCancellationRetainsCursorItemsAndNoFailure() async {
        let store = NotificationCenterStore()
        let first = item(type: "event.cancelled", resourcePublicID: "event-1", resourceType: "event")
        await store.load { _ in .init(items: [first], nextCursor: "p2", hasMore: true) }

        await store.loadNextPage { _ in throw CancellationError() }

        XCTAssertEqual(store.phase, .content([first]))
        XCTAssertEqual(store.nextCursor, "p2")
        XCTAssertTrue(store.hasMore)
        XCTAssertFalse(store.paginationFailed)
    }

    @MainActor
    func testRefreshInvalidatesAnOlderPaginationSuccess() async {
        let store = NotificationCenterStore()
        let first = item(type: "event.cancelled", resourcePublicID: "event-1", resourceType: "event")
        let stale = item(type: "group.announcement", resourcePublicID: "group-stale", resourceType: "group")
        let refreshed = item(type: "waitlist.offered", resourcePublicID: "event-fresh", resourceType: "event")
        await store.load { _ in .init(items: [first], nextCursor: "p2", hasMore: true) }
        let started = AsyncGate()
        let finish = AsyncGate()

        let pagination = Task { @MainActor in
            await store.loadNextPage { _ in
                started.open()
                await finish.wait()
                return .init(items: [stale], nextCursor: nil, hasMore: false)
            }
        }
        await started.wait()
        await store.load(isRefresh: true) { _ in
            .init(items: [refreshed], nextCursor: nil, hasMore: false)
        }
        finish.open()
        await pagination.value

        XCTAssertEqual(store.phase, .content([refreshed]))
        XCTAssertFalse(store.paginationFailed)
        XCTAssertFalse(store.hasMore)
        XCTAssertNil(store.nextCursor)
    }

    @MainActor
    func testOlderPaginationCanFinishWhileRefreshRemainsInFlightWithoutClearingRefreshState() async {
        let store = NotificationCenterStore()
        let first = item(type: "event.cancelled", resourcePublicID: "event-1", resourceType: "event")
        let stale = item(type: "group.announcement", resourcePublicID: "group-stale", resourceType: "group")
        let refreshed = item(type: "waitlist.offered", resourcePublicID: "event-fresh", resourceType: "event")
        await store.load { _ in .init(items: [first], nextCursor: "p2", hasMore: true) }
        let paginationStarted = AsyncGate()
        let finishPagination = AsyncGate()
        let refreshStarted = AsyncGate()
        let finishRefresh = AsyncGate()

        let pagination = Task { @MainActor in
            await store.loadNextPage { _ in
                paginationStarted.open()
                await finishPagination.wait()
                return .init(items: [stale], nextCursor: nil, hasMore: false)
            }
        }
        await paginationStarted.wait()
        let refresh = Task { @MainActor in
            await store.load(isRefresh: true) { _ in
                refreshStarted.open()
                await finishRefresh.wait()
                return .init(items: [refreshed], nextCursor: nil, hasMore: false)
            }
        }
        await refreshStarted.wait()

        finishPagination.open()
        await pagination.value

        XCTAssertTrue(store.isFirstPageRequestInFlight)
        XCTAssertFalse(store.isLoadingMore)
        XCTAssertEqual(store.phase, .content([first]))

        finishRefresh.open()
        await refresh.value

        XCTAssertFalse(store.isFirstPageRequestInFlight)
        XCTAssertFalse(store.isLoadingMore)
        XCTAssertEqual(store.phase, .content([refreshed]))
    }

    @MainActor
    func testRefreshInvalidatesAnOlderPaginationFailureAndRetryDoesNotDeadEnd() async {
        let store = NotificationCenterStore()
        let first = item(type: "event.cancelled", resourcePublicID: "event-1", resourceType: "event")
        let refreshed = item(type: "waitlist.offered", resourcePublicID: "event-fresh", resourceType: "event")
        await store.load { _ in .init(items: [first], nextCursor: "p2", hasMore: true) }
        let started = AsyncGate()
        let finish = AsyncGate()

        let pagination = Task { @MainActor in
            await store.loadNextPage { _ in
                started.open()
                await finish.wait()
                throw StubError.failed
            }
        }
        await started.wait()
        await store.load(isRefresh: true) { _ in
            .init(items: [refreshed], nextCursor: nil, hasMore: false)
        }
        finish.open()
        await pagination.value

        XCTAssertEqual(store.phase, .content([refreshed]))
        XCTAssertFalse(store.paginationFailed)
        XCTAssertFalse(store.paginationRecoveryRequiresReload)
        XCTAssertFalse(store.hasMore)
    }

    @MainActor
    func testRefreshFailureNoticeCannotBeClearedByAConcurrentItemsLaterSuccess() async {
        let store = NotificationCenterStore()
        let notification = item(type: "moderation.decided", resourcePublicID: nil)
        await store.load { _ in
            .init(items: [notification], nextCursor: nil, hasMore: false)
        }
        let started = AsyncGate()
        let finish = AsyncGate()
        let refresh = Task { @MainActor in
            await store.load(isRefresh: true) { _ in
                started.open()
                await finish.wait()
                throw StubError.failed
            }
        }
        await started.wait()
        await store.select(
            notification,
            navigate: { _ in false },
            markRead: { _ in throw StubError.failed }
        )
        XCTAssertEqual(store.notice, .markReadFailedInCenter)

        finish.open()
        await refresh.value
        XCTAssertEqual(store.notice, .refreshFailed)

        await store.select(
            notification,
            navigate: { _ in false },
            markRead: { _ in }
        )
        XCTAssertEqual(store.notice, .refreshFailed)
    }

    @MainActor
    func testCancelledRefreshRetainsAnUnresolvedItemNotice() async {
        let store = NotificationCenterStore()
        let notification = item(type: "moderation.decided", resourcePublicID: nil)
        await store.load { _ in
            .init(items: [notification], nextCursor: nil, hasMore: false)
        }
        await store.select(
            notification,
            navigate: { _ in false },
            markRead: { _ in throw StubError.failed }
        )
        XCTAssertEqual(store.notice, .markReadFailedInCenter)

        await store.load(isRefresh: true) { _ in throw CancellationError() }

        XCTAssertEqual(store.notice, .markReadFailedInCenter)
    }

    @MainActor
    func testSuccessfulRefreshDoesNotClearAnUnresolvedItemNotice() async {
        let store = NotificationCenterStore()
        let notification = item(type: "moderation.decided", resourcePublicID: nil)
        await store.load { _ in
            .init(items: [notification], nextCursor: nil, hasMore: false)
        }
        await store.select(
            notification,
            navigate: { _ in false },
            markRead: { _ in throw StubError.failed }
        )

        await store.load(isRefresh: true) { _ in
            .init(items: [notification], nextCursor: nil, hasMore: false)
        }

        XCTAssertEqual(store.notice, .markReadFailedInCenter)
    }

    @MainActor
    func testConfirmedLocalReadSurvivesAnOlderRefreshSuccess() async {
        let store = NotificationCenterStore()
        let notification = item(type: "moderation.decided", resourcePublicID: nil)
        await store.load { _ in
            .init(items: [notification], nextCursor: nil, hasMore: false)
        }
        let started = AsyncGate()
        let finish = AsyncGate()
        let refresh = Task { @MainActor in
            await store.load(isRefresh: true) { _ in
                started.open()
                await finish.wait()
                return .init(items: [notification], nextCursor: nil, hasMore: false)
            }
        }
        await started.wait()

        await store.select(
            notification,
            navigate: { _ in false },
            markRead: { _ in }
        )
        XCTAssertNotNil(presentedItem(withID: notification.id, in: store.phase)?.readAt)

        finish.open()
        await refresh.value

        XCTAssertNotNil(presentedItem(withID: notification.id, in: store.phase)?.readAt)
    }

    @MainActor
    func testConfirmedLocalReadSurvivesAnOlderRefreshFailure() async {
        let store = NotificationCenterStore()
        let notification = item(type: "moderation.decided", resourcePublicID: nil)
        await store.load { _ in
            .init(items: [notification], nextCursor: nil, hasMore: false)
        }
        let started = AsyncGate()
        let finish = AsyncGate()
        let refresh = Task { @MainActor in
            await store.load(isRefresh: true) { _ in
                started.open()
                await finish.wait()
                throw StubError.failed
            }
        }
        await started.wait()

        await store.select(
            notification,
            navigate: { _ in false },
            markRead: { _ in }
        )
        finish.open()
        await refresh.value

        XCTAssertNotNil(presentedItem(withID: notification.id, in: store.phase)?.readAt)
        XCTAssertEqual(store.notice, .refreshFailed)
    }

    @MainActor
    func testConfirmedLocalReadSurvivesAnOlderRefreshCancellation() async {
        let store = NotificationCenterStore()
        let notification = item(type: "moderation.decided", resourcePublicID: nil)
        await store.load { _ in
            .init(items: [notification], nextCursor: nil, hasMore: false)
        }
        let started = AsyncGate()
        let finish = AsyncGate()
        let refresh = Task { @MainActor in
            await store.load(isRefresh: true) { _ in
                started.open()
                await finish.wait()
                throw CancellationError()
            }
        }
        await started.wait()

        await store.select(
            notification,
            navigate: { _ in false },
            markRead: { _ in }
        )
        finish.open()
        await refresh.value

        XCTAssertNotNil(presentedItem(withID: notification.id, in: store.phase)?.readAt)
        XCTAssertNil(store.notice)
    }

    @MainActor
    func testConfirmedLocalReadSurvivesFailureRestoreAndALaterStaleUnreadResponse() async {
        let store = NotificationCenterStore()
        let notification = item(type: "moderation.decided", resourcePublicID: nil)
        await store.load { _ in
            .init(items: [notification], nextCursor: nil, hasMore: false)
        }
        await store.select(
            notification,
            navigate: { _ in false },
            markRead: { _ in }
        )

        await store.load(isRefresh: true) { _ in throw StubError.failed }
        XCTAssertNotNil(presentedItem(withID: notification.id, in: store.phase)?.readAt)

        await store.load(isRefresh: true) { _ in
            .init(items: [notification], nextCursor: nil, hasMore: false)
        }

        XCTAssertNotNil(presentedItem(withID: notification.id, in: store.phase)?.readAt)
        XCTAssertNil(store.notice)
    }

    @MainActor
    func testNewestOfTwoRefreshesWinsWhenTheOlderOneFinishesLast() async {
        let store = NotificationCenterStore()
        let original = item(type: "event.cancelled", resourcePublicID: "event-original", resourceType: "event")
        let stale = item(type: "group.announcement", resourcePublicID: "group-stale", resourceType: "group")
        let newest = item(type: "waitlist.offered", resourcePublicID: "event-newest", resourceType: "event")
        await store.load { _ in .init(items: [original], nextCursor: nil, hasMore: false) }
        let started = AsyncGate()
        let finish = AsyncGate()
        let olderRefresh = Task { @MainActor in
            await store.load(isRefresh: true) { _ in
                started.open()
                await finish.wait()
                return .init(items: [stale], nextCursor: nil, hasMore: false)
            }
        }
        await started.wait()

        await store.load(isRefresh: true) { _ in
            .init(items: [newest], nextCursor: nil, hasMore: false)
        }
        finish.open()
        await olderRefresh.value

        XCTAssertEqual(store.phase, .content([newest]))
        XCTAssertFalse(store.isFirstPageRequestInFlight)
    }

    @MainActor
    func testRefreshBlocksStartingAnotherPaginationRequest() async {
        let store = NotificationCenterStore()
        let first = item(type: "event.cancelled", resourcePublicID: "event-1", resourceType: "event")
        await store.load { _ in .init(items: [first], nextCursor: "p2", hasMore: true) }
        let started = AsyncGate()
        let finish = AsyncGate()
        let refresh = Task { @MainActor in
            await store.load(isRefresh: true) { _ in
                started.open()
                await finish.wait()
                return .init(items: [first], nextCursor: "p2", hasMore: true)
            }
        }
        await started.wait()
        var paginationCalls = 0

        await store.loadNextPage { _ in
            paginationCalls += 1
            return .init(items: [], nextCursor: nil, hasMore: false)
        }
        finish.open()
        await refresh.value

        XCTAssertEqual(paginationCalls, 0)
    }

    @MainActor
    func testCursorCycleStopsAndRetryReloadsTheFirstPage() async {
        let store = NotificationCenterStore()
        let first = item(type: "event.cancelled", resourcePublicID: "event-1", resourceType: "event")
        let second = item(type: "group.announcement", resourcePublicID: "group-1", resourceType: "group")
        await store.load { _ in .init(items: [first], nextCursor: "p2", hasMore: true) }
        await store.loadNextPage { cursor in
            XCTAssertEqual(cursor, "p2")
            return .init(items: [second], nextCursor: "p3", hasMore: true)
        }
        await store.loadNextPage { cursor in
            XCTAssertEqual(cursor, "p3")
            return .init(items: [first], nextCursor: "p2", hasMore: true)
        }

        XCTAssertTrue(store.paginationFailed)
        XCTAssertTrue(store.paginationRecoveryRequiresReload)
        XCTAssertFalse(store.hasMore)
        XCTAssertNil(store.nextCursor)

        var retryCursors: [String?] = []
        await store.retryPagination { cursor in
            retryCursors.append(cursor)
            return .init(items: [second], nextCursor: nil, hasMore: false)
        }
        XCTAssertEqual(retryCursors.count, 1)
        XCTAssertNil(retryCursors[0])
        XCTAssertEqual(store.phase, .content([second]))
    }

    @MainActor
    func testCancelledPaginationRetryRestoresRetryAffordance() async {
        let store = NotificationCenterStore()
        let first = item(type: "event.cancelled", resourcePublicID: "event-1", resourceType: "event")
        await store.load { _ in .init(items: [first], nextCursor: "p2", hasMore: true) }
        await store.loadNextPage { _ in throw StubError.failed }
        XCTAssertTrue(store.paginationFailed)

        await store.retryPagination { _ in throw CancellationError() }

        XCTAssertTrue(store.paginationFailed)
        XCTAssertTrue(store.hasMore)
        XCTAssertNil(store.paginationTaskID)
    }

    @MainActor
    func testRecoveryRetryIgnoresASecondRequestWhileFirstPageReloadIsInFlight() async {
        let store = NotificationCenterStore()
        let first = item(type: "event.cancelled", resourcePublicID: "event-1", resourceType: "event")
        await store.load { _ in .init(items: [first], nextCursor: nil, hasMore: true) }
        XCTAssertTrue(store.paginationRecoveryRequiresReload)
        let started = AsyncGate()
        let finish = AsyncGate()
        let firstRetry = Task { @MainActor in
            await store.retryPagination { _ in
                started.open()
                await finish.wait()
                return .init(items: [first], nextCursor: nil, hasMore: false)
            }
        }
        await started.wait()
        var secondRetryCalls = 0

        await store.retryPagination { _ in
            secondRetryCalls += 1
            return .init(items: [first], nextCursor: nil, hasMore: false)
        }
        XCTAssertEqual(secondRetryCalls, 0)

        finish.open()
        await firstRetry.value
        XCTAssertFalse(store.paginationFailed)
    }

    @MainActor
    func testDuplicateOnlyPageAdvancesPaginationTaskIdentity() async {
        let store = NotificationCenterStore()
        let first = item(type: "event.cancelled", resourcePublicID: "event-1", resourceType: "event")
        await store.load { _ in .init(items: [first], nextCursor: "p2", hasMore: true) }
        XCTAssertEqual(store.paginationTaskID, "p2")

        await store.loadNextPage { cursor in
            XCTAssertEqual(cursor, "p2")
            return .init(items: [first], nextCursor: "p3", hasMore: true)
        }

        XCTAssertEqual(store.phase, .content([first]))
        XCTAssertEqual(store.paginationTaskID, "p3")
    }

    @MainActor
    func testMissingOrRepeatedCursorRetryReloadsFirstPageInsteadOfNoOp() async {
        let missingCursorStore = NotificationCenterStore()
        let first = item(type: "event.cancelled", resourcePublicID: "event-1", resourceType: "event")
        let refreshed = item(type: "group.announcement", resourcePublicID: "group-1", resourceType: "group")
        await missingCursorStore.load { _ in
            .init(items: [first], nextCursor: nil, hasMore: true)
        }
        XCTAssertTrue(missingCursorStore.paginationFailed)
        XCTAssertTrue(missingCursorStore.paginationRecoveryRequiresReload)
        XCTAssertFalse(missingCursorStore.hasMore)

        var missingCursorRetryRequests: [String?] = []
        await missingCursorStore.retryPagination { cursor in
            missingCursorRetryRequests.append(cursor)
            return .init(items: [refreshed], nextCursor: nil, hasMore: false)
        }
        XCTAssertEqual(missingCursorRetryRequests.count, 1)
        XCTAssertNil(missingCursorRetryRequests[0])
        XCTAssertEqual(missingCursorStore.phase, .content([refreshed]))
        XCTAssertFalse(missingCursorStore.paginationFailed)

        let repeatedCursorStore = NotificationCenterStore()
        await repeatedCursorStore.load { _ in
            .init(items: [first], nextCursor: "p2", hasMore: true)
        }
        await repeatedCursorStore.loadNextPage { cursor in
            XCTAssertEqual(cursor, "p2")
            return .init(items: [refreshed], nextCursor: "p2", hasMore: true)
        }
        XCTAssertTrue(repeatedCursorStore.paginationFailed)
        XCTAssertTrue(repeatedCursorStore.paginationRecoveryRequiresReload)

        var repeatedCursorRetryRequests: [String?] = []
        await repeatedCursorStore.retryPagination { cursor in
            repeatedCursorRetryRequests.append(cursor)
            return .init(items: [first, refreshed], nextCursor: nil, hasMore: false)
        }
        XCTAssertEqual(repeatedCursorRetryRequests.count, 1)
        XCTAssertNil(repeatedCursorRetryRequests[0])
        XCTAssertEqual(repeatedCursorStore.phase, .content([first, refreshed]))
    }

    @MainActor
    func testNavigationCompletesBeforeMarkFailureAndUsesAfterNavigationNotice() async {
        let store = NotificationCenterStore()
        let notification = item(type: "event.cancelled", resourcePublicID: "event-1", resourceType: "event")
        var operations: [String] = []

        await store.select(
            notification,
            navigate: { _ in
                operations.append("navigate-start")
                await Task.yield()
                operations.append("navigate-finished")
                return true
            },
            markRead: { _ in
                operations.append("mark-read")
                throw StubError.failed
            },
            onNotice: { notice in
                XCTAssertEqual(notice, .markReadFailedAfterNavigation)
                operations.append("notice")
            }
        )

        XCTAssertEqual(operations, ["navigate-start", "navigate-finished", "mark-read", "notice"])
        XCTAssertNil(store.notice)
    }

    @MainActor
    func testTargetlessMarkFailureUsesAccurateLocalNotice() async {
        let store = NotificationCenterStore()
        var globalNotices: [NotificationCenterNotice] = []
        await store.select(
            item(type: "moderation.decided", resourcePublicID: nil),
            navigate: { _ in XCTFail("targetless notification must not navigate"); return false },
            markRead: { _ in throw StubError.failed },
            onNotice: { globalNotices.append($0) }
        )

        XCTAssertEqual(store.notice, .markReadFailedInCenter)
        XCTAssertTrue(globalNotices.isEmpty)
    }

    @MainActor
    func testSuccessfulRetryClearsOnlyTheSameItemsLocalFailureNotice() async {
        let store = NotificationCenterStore()
        let failedItem = item(type: "moderation.decided", resourcePublicID: nil)
        let otherItem = item(type: "moderation.decided", resourcePublicID: nil)
        await store.select(
            failedItem,
            navigate: { _ in false },
            markRead: { _ in throw StubError.failed }
        )
        XCTAssertEqual(store.notice, .markReadFailedInCenter)

        await store.select(
            failedItem,
            navigate: { _ in false },
            markRead: { _ in throw CancellationError() }
        )
        XCTAssertEqual(store.notice, .markReadFailedInCenter)

        await store.select(
            otherItem,
            navigate: { _ in false },
            markRead: { _ in }
        )
        XCTAssertEqual(store.notice, .markReadFailedInCenter)

        await store.select(
            failedItem,
            navigate: { _ in false },
            markRead: { _ in }
        )
        XCTAssertNil(store.notice)
    }

    @MainActor
    func testDuplicateClicksShareOneInFlightNavigationAndMarkRead() async {
        let store = NotificationCenterStore()
        let notification = item(type: "event.cancelled", resourcePublicID: "event-1", resourceType: "event")
        let started = AsyncGate()
        let gate = AsyncGate()
        let counts = LockedCounts()

        async let first: Void = store.select(notification, navigate: { _ in
            counts.incrementNavigation()
            started.open()
            await gate.wait()
            return true
        }, markRead: { _ in counts.incrementMarkRead() })
        await started.wait()
        async let second: Void = store.select(notification, navigate: { _ in
            counts.incrementNavigation()
            return true
        }, markRead: { _ in counts.incrementMarkRead() })
        gate.open()
        _ = await (first, second)

        XCTAssertEqual(counts.snapshot(), [1, 1])
        XCTAssertFalse(store.isSelecting(notification.id))
    }

    @MainActor
    func testRouteFailureWinsOverConfiguredMarkFailureAndCancellationIsSilent() async {
        let store = NotificationCenterStore()
        let notification = item(type: "event.cancelled", resourcePublicID: "event-1", resourceType: "event")
        var markCount = 0
        await store.select(
            notification,
            navigate: { _ in throw StubError.failed },
            markRead: { _ in markCount += 1; throw StubError.failed }
        )
        XCTAssertEqual(markCount, 0)
        XCTAssertEqual(store.notice, .navigationFailed)

        store.dismissNotice()
        await store.select(
            notification,
            navigate: { _ in throw CancellationError() },
            markRead: { _ in XCTFail("cancelled navigation must not mark read") }
        )
        XCTAssertNil(store.notice)
    }

    @MainActor
    func testReadNotificationNavigationRetrySuccessClearsItsOldFailureNotice() async {
        let store = NotificationCenterStore()
        let notification = item(
            type: "event.cancelled",
            resourcePublicID: "event-1",
            resourceType: "event",
            readAt: Date(timeIntervalSince1970: 1_721_350_800)
        )
        await store.load { _ in
            .init(items: [notification], nextCursor: nil, hasMore: false)
        }
        await store.select(
            notification,
            navigate: { _ in throw StubError.failed },
            markRead: { _ in XCTFail("read notification must not be marked again") }
        )
        XCTAssertEqual(store.notice, .navigationFailed)

        await store.select(
            notification,
            navigate: { _ in true },
            markRead: { _ in XCTFail("read notification must not be marked again") }
        )

        XCTAssertNil(store.notice)
    }

    func testVoiceOverSummaryIncludesTheSameLocalizedTimeAndUnreadState() {
        let notification = item(type: "waitlist.offered", resourcePublicID: "event-1", resourceType: "event")
        XCTAssertEqual(
            notification.accessibilitySummary(timestamp: "2 hours ago", unreadLabel: "Unread"),
            "Server title, Server body, 2 hours ago, Unread"
        )
    }

    func testMaximumDynamicTypeRiskRemovesDecorativeIconAndTouchTargetExceeds44Points() {
        XCTAssertTrue(NotificationCenterLayout.showsLeadingIcon(for: .large))
        XCTAssertFalse(NotificationCenterLayout.showsLeadingIcon(for: .accessibility5))
        XCTAssertGreaterThan(NotificationCenterLayout.minimumTouchTarget, 44)

        let regularState = NotificationCenterStateCardPresentation(dynamicTypeSize: .large)
        let ax5State = NotificationCenterStateCardPresentation(dynamicTypeSize: .accessibility5)
        XCTAssertTrue(regularState.showsDecorativeIcon)
        XCTAssertFalse(ax5State.showsDecorativeIcon)
        XCTAssertGreaterThanOrEqual(ax5State.minimumActionWidth, 45)
        XCTAssertGreaterThanOrEqual(ax5State.minimumActionHeight, 45)
    }

    @MainActor
    func testLocaleTaskIdentityChangesAndReloadCanRetainPresentedContent() async {
        XCTAssertNotEqual(
            NotificationCenterTaskID(locale: .en),
            NotificationCenterTaskID(locale: .ja)
        )

        let store = NotificationCenterStore()
        XCTAssertFalse(store.hasRetainedPresentation)
        let notification = item(type: "event.cancelled", resourcePublicID: "event-1", resourceType: "event")
        await store.load { _ in .init(items: [notification], nextCursor: nil, hasMore: false) }
        XCTAssertTrue(store.hasRetainedPresentation)

        await store.load(isRefresh: store.hasRetainedPresentation) { _ in throw StubError.failed }
        XCTAssertEqual(store.phase, .content([notification]))
        XCTAssertEqual(store.notice, .refreshFailed)
    }

    func testRelativeTimestampChangesWithTheTimelineClockAndRefreshesAtLeastEveryMinute() {
        let date = Date(timeIntervalSince1970: 1_721_350_800)
        let locale = Locale(identifier: "en")
        let first = NotificationTimestampFormatter.string(
            for: date,
            relativeTo: date.addingTimeInterval(60),
            locale: locale
        )
        let later = NotificationTimestampFormatter.string(
            for: date,
            relativeTo: date.addingTimeInterval(2 * 60 * 60),
            locale: locale
        )

        XCTAssertNotEqual(first, later)
        XCTAssertLessThanOrEqual(NotificationCenterLayout.timestampRefreshInterval, 60)
    }

    func testNotificationCenterHasDistinctAccurateThreeLocaleFailureCopy() {
        for localeID in ["zh-Hans", "ja", "en"] {
            let copy = NotificationCenterCopy(locale: Locale(identifier: localeID))
            XCTAssertNotEqual(copy.markReadFailureInCenter, copy.markReadFailureAfterNavigation)
            XCTAssertFalse(copy.paginationFailure.isEmpty)
            XCTAssertFalse(copy.navigationFailure.isEmpty)
        }
        XCTAssertEqual(NotificationCenterCopy(locale: Locale(identifier: "en")).markReadFailureInCenter, "Couldn’t mark this notification as read. You’re still in Notification Center; try again later.")
        XCTAssertEqual(NotificationCenterCopy(locale: Locale(identifier: "en")).markReadFailureAfterNavigation, "The related details opened, but this notification couldn’t be marked as read. Try again later.")
    }

    private func presentedItem(
        withID id: UUID,
        in phase: NotificationListPhase
    ) -> NotificationItem? {
        guard case .content(let items) = phase else { return nil }
        return items.first { $0.id == id }
    }

    private func item(
        id: UUID = UUID(),
        type: String,
        resourcePublicID: String?,
        resourceType: String? = nil,
        readAt: Date? = nil
    ) -> NotificationItem {
        NotificationItem(
            id: id,
            type: type,
            locale: .en,
            templateVersion: 3,
            title: "Server title",
            body: "Server body",
            variables: [:],
            resourceType: resourceType,
            resourcePublicId: resourcePublicID,
            createdAt: Date(timeIntervalSince1970: 1_721_350_800),
            readAt: readAt
        )
    }
}

private enum StubError: Error { case failed }

private struct NotificationURLProtocolSnapshot: Sendable {
    let responseData: Data?
}

private final class NotificationURLProtocolStorage: @unchecked Sendable {
    private let lock = NSLock()
    private var responseData: Data?
    private var capturedRequests: [URLRequest] = []

    func configure(responseData: Data) {
        lock.withLock {
            self.responseData = responseData
            capturedRequests.removeAll()
        }
    }

    func capture(_ request: URLRequest) -> NotificationURLProtocolSnapshot {
        lock.withLock {
            capturedRequests.append(request)
            return NotificationURLProtocolSnapshot(responseData: responseData)
        }
    }

    func requests() -> [URLRequest] {
        lock.withLock { capturedRequests }
    }

    func reset() {
        lock.withLock {
            responseData = nil
            capturedRequests.removeAll()
        }
    }
}

private final class NotificationURLProtocol: URLProtocol {
    private static let storage = NotificationURLProtocolStorage()

    static func configure(responseData: Data) {
        storage.configure(responseData: responseData)
    }

    static func requests() -> [URLRequest] { storage.requests() }

    static func reset() { storage.reset() }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let snapshot = Self.storage.capture(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if let data = snapshot.responseData { client?.urlProtocol(self, didLoad: data) }
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private actor AsyncGate {
    private var continuations: [CheckedContinuation<Void, Never>] = []
    private var opened = false
    func wait() async {
        if opened { return }
        await withCheckedContinuation { continuations.append($0) }
    }
    nonisolated func open() { Task { await release() } }
    private func release() {
        opened = true
        let pending = continuations
        continuations.removeAll()
        pending.forEach { $0.resume() }
    }
}

private final class LockedCounts: @unchecked Sendable {
    private let lock = NSLock()
    private var navigation = 0
    private var markRead = 0
    func incrementNavigation() { lock.withLock { navigation += 1 } }
    func incrementMarkRead() { lock.withLock { markRead += 1 } }
    func snapshot() -> [Int] { lock.withLock { [navigation, markRead] } }
}
