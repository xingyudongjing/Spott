import Foundation
import XCTest
@testable import Spott

@MainActor
final class MyActivitiesStoreTests: XCTestCase {
    func testRefreshUsesOneItineraryQueryAndGroupsByServerBackedState() async throws {
        let page = try itineraryPage(items: [
            itineraryItem(index: 1, status: "pending", startsAt: "2026-07-18T09:00:00Z", actions: ["cancelRegistration"]),
            itineraryItem(index: 2, status: "waitlisted", startsAt: "2026-07-19T09:00:00Z", actions: ["cancelRegistration"]),
            itineraryItem(
                index: 3,
                status: "offered",
                startsAt: "2026-07-17T09:00:00Z",
                actions: ["register", "cancelRegistration"],
                offerExpiresAt: "2026-07-16T03:10:00Z"
            ),
            itineraryItem(index: 4, status: "confirmed", startsAt: "2026-07-20T09:00:00Z", actions: ["checkIn", "cancelRegistration"]),
            itineraryItem(index: 5, status: "checked_in", startsAt: "2026-07-10T09:00:00Z", endsAt: "2026-07-10T11:00:00Z"),
            itineraryItem(index: 6, status: "cancelled", event: NSNull()),
        ])
        let service = MyActivitiesServiceStub(pages: [page])
        let store = MyActivitiesStore(service: service)

        await store.refresh()

        let itineraryRequestCount = await service.itineraryRequestCount()
        XCTAssertEqual(itineraryRequestCount, 1)
        XCTAssertEqual(store.section(.pending).items.map(\.registration.status), ["pending"])
        XCTAssertEqual(store.section(.waitlist).items.map(\.registration.status), ["offered", "waitlisted"])
        XCTAssertEqual(store.section(.upcoming).items.map(\.registration.status), ["confirmed"])
        XCTAssertEqual(Set(store.section(.past).items.map(\.registration.status)), Set(["checked_in", "cancelled"]))
        XCTAssertNil(store.error)
    }

    func testEachRowHasExactlyOneAuthoritativeNextAction() async throws {
        let page = try itineraryPage(items: [
            itineraryItem(index: 1, status: "pending", actions: ["cancelRegistration"]),
            itineraryItem(
                index: 2,
                status: "offered",
                actions: ["register", "cancelRegistration"],
                offerExpiresAt: "2026-07-16T03:10:00Z"
            ),
            itineraryItem(index: 3, status: "confirmed", actions: ["checkIn", "cancelRegistration"]),
            itineraryItem(index: 4, status: "checked_in", startsAt: "2026-07-20T09:00:00Z"),
            itineraryItem(index: 5, status: "cancelled", event: NSNull()),
        ])
        let store = MyActivitiesStore(service: MyActivitiesServiceStub(pages: [page]))

        await store.refresh()

        let byStatus = Dictionary(uniqueKeysWithValues: store.items.map { ($0.registration.status, $0.nextAction) })
        guard case .viewStatus = byStatus["pending"] else {
            return XCTFail("pending should keep status as the single primary action")
        }
        guard case .acceptWaitlist(let registrationID, let expiry) = byStatus["offered"] else {
            return XCTFail("offered should expose the real waitlist acceptance")
        }
        XCTAssertEqual(registrationID, registrationIDForIndex(2))
        XCTAssertEqual(expiry, ISO8601DateFormatter().date(from: "2026-07-16T03:10:00Z"))
        guard case .checkIn = byStatus["confirmed"] else {
            return XCTFail("confirmed should prefer the server-backed check-in action")
        }
        guard case .viewEvent = byStatus["checked_in"] else {
            return XCTFail("checked-in should keep event navigation")
        }
        XCTAssertEqual(byStatus["cancelled"], MyActivityNextAction.none)
        XCTAssertEqual(
            store.items.first(where: { $0.registration.status == "pending" })?.cancellationAction,
            .cancelRegistration(registrationIDForIndex(1))
        )
    }

    func testOfferAcceptanceRequiresFreshQuoteAndExplicitReviewBeforeCharge() async throws {
        let offered = try itineraryPage(items: [
            itineraryItem(
                index: 7,
                status: "offered",
                actions: ["register", "cancelRegistration"],
                offerExpiresAt: "2026-07-16T03:10:00Z"
            ),
        ])
        let confirmed = try itineraryPage(items: [
            itineraryItem(index: 7, status: "confirmed", actions: ["cancelRegistration"]),
        ])
        let quote = Quote(
            id: UUID(uuidString: "019b0000-0000-7000-8600-000000000007")!,
            amount: 30,
            currency: "POINT",
            expiresAt: ISO8601DateFormatter().date(from: "2026-07-16T03:05:00Z")!
        )
        let service = MyActivitiesServiceStub(pages: [offered, confirmed], quotes: [quote])
        let store = MyActivitiesStore(service: service)
        await store.refresh()
        let action = try XCTUnwrap(store.items.first?.nextAction)

        await store.perform(action)

        let requestsBeforeConfirmation = await service.acceptedRequests()
        XCTAssertTrue(requestsBeforeConfirmation.isEmpty)
        let review = try XCTUnwrap(store.waitlistAcceptanceReview)
        XCTAssertEqual(review.registrationID, registrationIDForIndex(7))
        XCTAssertEqual(review.eventID, eventIDForIndex(7))
        XCTAssertEqual(review.partySize, 1)
        XCTAssertEqual(review.quote.id, quote.id)
        XCTAssertEqual(review.expectedRegistrationVersion, 1)
        XCTAssertEqual(review.expectedEventVersion, 1)
        let quoteRequestCount = await service.quoteRequestCount()
        XCTAssertEqual(quoteRequestCount, 1)

        await store.confirmWaitlistAcceptance()

        let acceptedRequests = await service.acceptedRequests()
        let acceptedRegistrationIDs = await service.acceptedRegistrationIDs()
        let itineraryRequestCount = await service.itineraryRequestCount()
        XCTAssertEqual(acceptedRegistrationIDs, [registrationIDForIndex(7)])
        XCTAssertEqual(acceptedRequests.first?.quoteID, quote.id)
        XCTAssertEqual(acceptedRequests.first?.expectedRegistrationVersion, 1)
        XCTAssertEqual(acceptedRequests.first?.expectedEventVersion, 1)
        XCTAssertEqual(itineraryRequestCount, 2)
        XCTAssertEqual(store.items.first?.registration.status, "confirmed")
        XCTAssertNil(store.waitlistAcceptanceReview)
    }

    func testWaitlistAcceptanceRetryReusesTheSameIdempotencyKey() async throws {
        let offered = try itineraryPage(items: [
            itineraryItem(
                index: 71,
                status: "offered",
                actions: ["register"],
                offerExpiresAt: "2026-07-16T03:10:00Z"
            ),
        ])
        let confirmed = try itineraryPage(items: [
            itineraryItem(index: 71, status: "confirmed"),
        ])
        let quote = Quote(
            id: UUID(uuidString: "019b0000-0000-7000-8600-000000000071")!,
            amount: 30,
            currency: "POINT",
            expiresAt: ISO8601DateFormatter().date(from: "2026-07-16T03:05:00Z")!
        )
        let service = MyActivitiesServiceStub(
            pages: [offered, confirmed],
            quotes: [quote],
            failFirstAcceptanceAfterRecording: true
        )
        let store = MyActivitiesStore(service: service)
        await store.refresh()
        await store.perform(try XCTUnwrap(store.items.first?.nextAction))

        await store.confirmWaitlistAcceptance()
        let requestsAfterFirstAttempt = await service.acceptedRequests()
        let firstKey = try XCTUnwrap(requestsAfterFirstAttempt.first?.idempotencyKey)
        XCTAssertNotNil(store.waitlistAcceptanceReview)

        await store.confirmWaitlistAcceptance()

        let requests = await service.acceptedRequests()
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests.map(\.idempotencyKey), [firstKey, firstKey])
        XCTAssertNil(store.waitlistAcceptanceReview)
        XCTAssertEqual(store.items.first?.registration.status, "confirmed")
    }

    func testCancellationRefreshesTheItineraryWithoutFetchingEventDetails() async throws {
        let pending = try itineraryPage(items: [
            itineraryItem(index: 8, status: "pending", actions: ["cancelRegistration"]),
        ])
        let cancelled = try itineraryPage(items: [
            itineraryItem(index: 8, status: "cancelled", actions: []),
        ])
        let service = MyActivitiesServiceStub(pages: [pending, cancelled])
        let store = MyActivitiesStore(service: service)
        await store.refresh()
        let action = try XCTUnwrap(store.items.first?.cancellationAction)

        await store.perform(action)

        let cancelledRegistrationIDs = await service.cancelledRegistrationIDs()
        let itineraryRequestCount = await service.itineraryRequestCount()
        XCTAssertEqual(cancelledRegistrationIDs, [registrationIDForIndex(8)])
        XCTAssertEqual(itineraryRequestCount, 2)
        XCTAssertEqual(store.items.first?.registration.status, "cancelled")
    }

    func testOfflineRefreshKeepsExistingItineraryAndSurfacesNonBlockingError() async throws {
        let page = try itineraryPage(items: [
            itineraryItem(index: 9, status: "confirmed", actions: ["cancelRegistration"]),
        ])
        let service = MyActivitiesServiceStub(pages: [page], failAfterPageCount: 1)
        let store = MyActivitiesStore(service: service)
        await store.refresh()

        await store.refresh()

        XCTAssertEqual(store.items.count, 1)
        XCTAssertEqual(store.error?.id, "NETWORK_UNAVAILABLE")
    }

    func testRefreshConsumesEveryCursorPageWithoutDroppingItemsBeyondTheFirstHundred() async throws {
        let first = try itineraryPage(
            items: [itineraryItem(index: 10, status: "pending")],
            nextCursor: "page-2",
            hasMore: true
        )
        let second = try itineraryPage(
            items: [itineraryItem(index: 11, status: "confirmed")]
        )
        let service = MyActivitiesServiceStub(pages: [first, second])
        let store = MyActivitiesStore(service: service)

        await store.refresh()

        let cursors = await service.requestedCursors()
        let limits = await service.requestedLimits()
        XCTAssertEqual(store.items.map(\.id).count, 2)
        XCTAssertNil(cursors.first ?? "unexpected")
        XCTAssertEqual(cursors.dropFirst().compactMap { $0 }, ["page-2"])
        XCTAssertEqual(limits, [100, 100])
    }

    func testServerCheckInActionIsPreservedWhileEndedEventMovesToPast() async throws {
        let page = try itineraryPage(items: [
            itineraryItem(
                index: 12,
                status: "confirmed",
                startsAt: "2026-07-16T01:00:00Z",
                endsAt: "2026-07-16T02:59:00Z",
                actions: ["checkIn"]
            ),
        ])
        let store = MyActivitiesStore(service: MyActivitiesServiceStub(pages: [page]))

        await store.refresh()

        XCTAssertEqual(store.section(.past).items.map(\.id), [registrationIDForIndex(12)])
        XCTAssertTrue(store.section(.upcoming).items.isEmpty)
        guard case .checkIn = store.items.first?.nextAction else {
            return XCTFail("server check-in must remain the single visible action")
        }
    }

    func testOfferExpiryReevaluatesAgainstElapsedTimeAndRejectsAStaleTap() async throws {
        let clock = MyActivitiesTestClock(
            ISO8601DateFormatter().date(from: "2026-07-16T03:00:00Z")!
        )
        let page = try itineraryPage(items: [
            itineraryItem(
                index: 13,
                status: "offered",
                actions: ["register", "cancelRegistration"],
                offerExpiresAt: "2026-07-16T03:10:00Z"
            ),
        ])
        let service = MyActivitiesServiceStub(pages: [page])
        let store = MyActivitiesStore(service: service, clock: clock.now)
        await store.refresh()
        let staleAction = try XCTUnwrap(store.items.first?.nextAction)

        clock.advance(by: 601)
        store.refreshTemporalState()
        await store.perform(staleAction)

        let acceptedIDs = await service.acceptedRegistrationIDs()
        XCTAssertTrue(acceptedIDs.isEmpty)
        XCTAssertEqual(store.error?.id, "WAITLIST_OFFER_EXPIRED")
        guard case .viewStatus = store.items.first?.nextAction else {
            return XCTFail("an expired offer must fall through to status, not destructive cancellation")
        }
        XCTAssertEqual(
            store.items.first?.cancellationAction,
            .cancelRegistration(registrationIDForIndex(13))
        )
    }

    func testDefaultTemporalClockUsesTheServicesMonotonicAuthority() async throws {
        let authority = MyActivitiesTestClock(
            ISO8601DateFormatter().date(from: "2026-07-16T03:00:00Z")!
        )
        let page = try itineraryPage(items: [
            itineraryItem(
                index: 17,
                status: "offered",
                actions: ["register", "cancelRegistration"],
                offerExpiresAt: "2026-07-16T03:10:00Z"
            ),
        ])
        let service = MyActivitiesServiceStub(
            pages: [page],
            authoritativeClock: authority.now
        )
        let store = MyActivitiesStore(service: service)
        await store.refresh()

        authority.advance(by: 601)
        store.refreshTemporalState()

        guard case .viewStatus = store.items.first?.nextAction else {
            return XCTFail("temporal rules must follow the calibrated monotonic service clock")
        }
    }

    func testGroupingMatchesWebTerminalStatusesAndEventLifecycle() async throws {
        let items = [
            "expired", "final", "correction_pending", "attendance_disputed",
        ].enumerated().map { offset, status in
            itineraryItem(index: 20 + offset, status: status)
        } + [
            itineraryItem(index: 24, status: "confirmed", eventStatus: "ended"),
            itineraryItem(index: 25, status: "confirmed", eventStatus: "cancelled"),
            itineraryItem(index: 26, status: "confirmed", eventStatus: "archived"),
        ]
        let store = MyActivitiesStore(
            service: MyActivitiesServiceStub(pages: [try itineraryPage(items: items)])
        )

        await store.refresh()

        XCTAssertEqual(store.section(.past).items.count, items.count)
        XCTAssertTrue(store.section(.upcoming).items.isEmpty)
    }

    func testEndedPendingAndWaitlistOffersMoveToPastAndCannotBeAccepted() async throws {
        let items = [
            itineraryItem(
                index: 28,
                status: "pending",
                startsAt: "2026-07-15T01:00:00Z",
                endsAt: "2026-07-15T03:00:00Z",
                actions: ["cancelRegistration"]
            ),
            itineraryItem(
                index: 29,
                status: "offered",
                startsAt: "2026-07-15T01:00:00Z",
                endsAt: "2026-07-15T03:00:00Z",
                actions: ["register", "cancelRegistration"],
                offerExpiresAt: "2026-07-17T03:00:00Z"
            ),
            itineraryItem(
                index: 30,
                status: "waitlisted",
                actions: ["cancelRegistration"],
                eventStatus: "ended"
            ),
        ]
        let store = MyActivitiesStore(
            service: MyActivitiesServiceStub(
                pages: [try itineraryPage(items: items)]
            )
        )

        await store.refresh()

        XCTAssertEqual(store.section(.past).items.count, items.count)
        XCTAssertTrue(store.section(.pending).items.isEmpty)
        XCTAssertTrue(store.section(.waitlist).items.isEmpty)
        XCTAssertFalse(
            store.items.contains {
                if case .acceptWaitlist = $0.nextAction { return true }
                return false
            }
        )
    }

    func testConfirmedTicketKeepsDetailPrimaryAndCancellationSecondary() async throws {
        let store = MyActivitiesStore(
            service: MyActivitiesServiceStub(pages: [try itineraryPage(items: [
                itineraryItem(
                    index: 27,
                    status: "confirmed",
                    actions: ["viewTicket", "cancelRegistration"]
                ),
            ])])
        )

        await store.refresh()
        let item = try XCTUnwrap(store.items.first)

        guard case .viewEvent = item.nextAction else {
            return XCTFail("ticket/detail must remain the primary action")
        }
        XCTAssertEqual(
            item.cancellationAction,
            .cancelRegistration(registrationIDForIndex(27))
        )
    }

    func testPendingAndWaitlistSortingMatchesWebPriority() async throws {
        let store = MyActivitiesStore(
            service: MyActivitiesServiceStub(pages: [try itineraryPage(items: [
                itineraryItem(
                    index: 30,
                    status: "pending",
                    updatedAt: "2026-07-16T01:00:00Z"
                ),
                itineraryItem(
                    index: 31,
                    status: "pending",
                    updatedAt: "2026-07-16T02:30:00Z"
                ),
                itineraryItem(
                    index: 32,
                    status: "offered",
                    offerExpiresAt: "2026-07-16T03:20:00Z",
                    updatedAt: "2026-07-16T02:50:00Z"
                ),
                itineraryItem(
                    index: 33,
                    status: "offered",
                    offerExpiresAt: "2026-07-16T03:10:00Z",
                    updatedAt: "2026-07-16T01:00:00Z"
                ),
                itineraryItem(
                    index: 34,
                    status: "waitlisted",
                    updatedAt: "2026-07-16T02:59:00Z"
                ),
            ])])
        )

        await store.refresh()

        XCTAssertEqual(
            store.section(.pending).items.map(\.id),
            [registrationIDForIndex(31), registrationIDForIndex(30)]
        )
        XCTAssertEqual(
            store.section(.waitlist).items.map(\.id),
            [
                registrationIDForIndex(33),
                registrationIDForIndex(32),
                registrationIDForIndex(34),
            ]
        )
    }

    func testPostEventActionsUseInclusiveServerTimeWindows() async throws {
        let store = MyActivitiesStore(
            service: MyActivitiesServiceStub(pages: [try itineraryPage(items: [
                itineraryItem(
                    index: 40,
                    status: "attendance_disputed",
                    endsAt: "2026-07-14T03:00:00Z"
                ),
                itineraryItem(
                    index: 41,
                    status: "checked_in",
                    endsAt: "2026-06-16T03:00:00Z"
                ),
                itineraryItem(
                    index: 42,
                    status: "attendance_disputed",
                    endsAt: "2026-07-14T02:59:59Z"
                ),
                itineraryItem(
                    index: 43,
                    status: "checked_in",
                    endsAt: "2026-06-16T02:59:59Z"
                ),
            ])])
        )

        await store.refresh()
        let actions = Dictionary(uniqueKeysWithValues: store.items.map { ($0.id, $0.nextAction) })

        guard case .correctAttendance = actions[registrationIDForIndex(40)] else {
            return XCTFail("48-hour attendance boundary must remain available")
        }
        guard case .leaveFeedback = actions[registrationIDForIndex(41)] else {
            return XCTFail("30-day feedback boundary must remain available")
        }
        guard case .viewEvent = actions[registrationIDForIndex(42)] else {
            return XCTFail("attendance correction must close after 48 hours")
        }
        guard case .viewEvent = actions[registrationIDForIndex(43)] else {
            return XCTFail("feedback must close after 30 days")
        }
    }

    func testCancellingAnActionDoesNotApplyItsLateResultOrRefreshTheList() async throws {
        let offered = try itineraryPage(items: [
            itineraryItem(
                index: 14,
                status: "offered",
                actions: ["register"],
                offerExpiresAt: "2026-07-16T03:10:00Z"
            ),
        ])
        let service = MyActivitiesServiceStub(
            pages: [offered],
            quotes: [Quote(
                id: UUID(uuidString: "019b0000-0000-7000-8600-000000000014")!,
                amount: 30,
                currency: "POINT",
                expiresAt: ISO8601DateFormatter().date(from: "2026-07-16T03:05:00Z")!
            )],
            actionDelay: .milliseconds(120),
            ignoresActionCancellation: true
        )
        let store = MyActivitiesStore(service: service)
        await store.refresh()
        let action = try XCTUnwrap(store.items.first?.nextAction)

        let actionTask = Task { await store.perform(action) }
        await Task.yield()
        actionTask.cancel()
        await actionTask.value

        let itineraryRequestCount = await service.itineraryRequestCount()
        XCTAssertEqual(itineraryRequestCount, 1)
        XCTAssertEqual(store.items.first?.registration.status, "offered")
        XCTAssertNil(store.actionInFlight)
    }

    func testMutationRefreshWinsOverAnOlderDelayedRefresh() async throws {
        let initial = try itineraryPage(items: [
            itineraryItem(
                index: 50,
                status: "confirmed",
                actions: ["viewTicket", "cancelRegistration"]
            ),
        ])
        let stale = try itineraryPage(items: [
            itineraryItem(
                index: 50,
                status: "confirmed",
                actions: ["viewTicket", "cancelRegistration"]
            ),
        ])
        let cancelled = try itineraryPage(items: [
            itineraryItem(index: 50, status: "cancelled")
        ])
        let service = MyActivitiesServiceStub(
            pages: [initial, stale, cancelled],
            itineraryDelays: [.zero, .milliseconds(160), .zero]
        )
        let store = MyActivitiesStore(service: service)
        await store.refresh()
        let cancellation = try XCTUnwrap(store.items.first?.cancellationAction)

        let staleRefresh = Task { await store.refresh() }
        while await service.itineraryRequestCount() < 2 {
            await Task.yield()
        }
        await store.perform(cancellation)
        await staleRefresh.value

        XCTAssertEqual(store.items.first?.registration.status, "cancelled")
        let itineraryRequestCount = await service.itineraryRequestCount()
        XCTAssertEqual(itineraryRequestCount, 3)
    }

    func testItineraryErrorsAreLocalizedInAllSupportedLanguages() async throws {
        let expectations = [
            ("zh-Hans", "暂时无法连接 Spott，请检查网络后重试。"),
            ("ja", "Spottに接続できません。通信環境を確認して、もう一度お試しください。"),
            ("en", "Spott can’t connect right now. Check your connection and try again."),
        ]

        for (identifier, expectedMessage) in expectations {
            let store = MyActivitiesStore(
                service: MyActivitiesServiceStub(pages: []),
                locale: Locale(identifier: identifier)
            )

            await store.refresh()

            XCTAssertEqual(store.error?.message, expectedMessage, identifier)
        }
    }

    func testNativeRowPresentationUsesOnlyTheSingleServerDerivedAction() async throws {
        let page = try itineraryPage(items: [
            itineraryItem(
                index: 15,
                status: "offered",
                actions: ["register", "cancelRegistration"],
                offerExpiresAt: "2026-07-16T03:10:00Z"
            ),
        ])
        let store = MyActivitiesStore(service: MyActivitiesServiceStub(pages: [page]))
        await store.refresh()
        let item = try XCTUnwrap(store.items.first)

        let presentation = MyActivityRowPresentation(
            item: item,
            locale: Locale(identifier: "en")
        )

        XCTAssertEqual(presentation.title, "Event 15")
        XCTAssertEqual(presentation.status, "Spot held for you")
        XCTAssertEqual(presentation.actionTitle, "Accept spot")
        XCTAssertEqual(presentation.actionSystemImage, "checkmark.seal.fill")
    }

    func testNativeRowPresentationHandlesRemovedEventsWithoutInventedFacts() async throws {
        let page = try itineraryPage(items: [
            itineraryItem(index: 16, status: "cancelled", event: NSNull()),
        ])
        let store = MyActivitiesStore(service: MyActivitiesServiceStub(pages: [page]))
        await store.refresh()
        let item = try XCTUnwrap(store.items.first)

        let presentation = MyActivityRowPresentation(
            item: item,
            locale: Locale(identifier: "en")
        )

        XCTAssertEqual(presentation.title, "Event unavailable")
        XCTAssertEqual(presentation.location, "Details are no longer available")
        XCTAssertNil(presentation.actionTitle)
        XCTAssertNil(presentation.actionSystemImage)
    }

    func testItinerarySectionTitlesAreCompleteAndDistinctInThreeLanguages() {
        for localeIdentifier in ["zh-Hans", "ja", "en"] {
            let presentations = MyActivityGroup.allCases.map {
                MyActivitySectionPresentation(
                    group: $0,
                    locale: Locale(identifier: localeIdentifier)
                )
            }
            XCTAssertEqual(Set(presentations.map(\.title)).count, MyActivityGroup.allCases.count)
            XCTAssertTrue(presentations.allSatisfy { !$0.title.isEmpty && !$0.emptyTitle.isEmpty && !$0.emptyMessage.isEmpty })
        }

        XCTAssertEqual(
            MyActivityGroup.allCases.map {
                MyActivitySectionPresentation(
                    group: $0,
                    locale: Locale(identifier: "en")
                ).title
            },
            ["Pending review", "Waitlist", "Upcoming", "Past"]
        )
    }

    func testItineraryPageChromeIsCompleteAndLocalizedInThreeLanguages() {
        let presentations = ["zh-Hans", "ja", "en"].map {
            MyActivitiesPagePresentation(locale: Locale(identifier: $0))
        }

        XCTAssertTrue(
            presentations.allSatisfy {
                !$0.title.isEmpty
                    && !$0.subtitle.isEmpty
                    && !$0.signInTitle.isEmpty
                    && !$0.signInMessage.isEmpty
                    && !$0.signInAction.isEmpty
                    && !$0.emptyTitle.isEmpty
                    && !$0.emptyMessage.isEmpty
                    && !$0.discoverAction.isEmpty
                    && !$0.syncError.isEmpty
            }
        )
        XCTAssertEqual(Set(presentations.map(\.title)).count, 3)
        XCTAssertEqual(presentations.last?.title, "Your itinerary")
    }

    private func itineraryPage(
        items: [[String: Any]],
        nextCursor: String? = nil,
        hasMore: Bool = false,
        serverTime: String = "2026-07-16T03:00:00Z"
    ) throws -> RegistrationItineraryPage {
        let payload: [String: Any] = [
            "items": items,
            "nextCursor": nextCursor as Any? ?? NSNull(),
            "hasMore": hasMore,
            "serverTime": serverTime,
        ]
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(
            RegistrationItineraryPage.self,
            from: JSONSerialization.data(withJSONObject: payload)
        )
    }

    private func itineraryItem(
        index: Int,
        status: String,
        startsAt: String = "2026-07-20T09:00:00Z",
        endsAt: String = "2026-07-20T11:00:00Z",
        actions: [String] = [],
        offerExpiresAt: String? = nil,
        updatedAt: String = "2026-07-16T02:00:00Z",
        eventStatus: String = "published",
        event: Any? = nil
    ) -> [String: Any] {
        let eventPayload: Any = event ?? [
            "id": eventIDForIndex(index).uuidString.lowercased(),
            "publicSlug": "event-\(index)",
            "status": eventStatus,
            "title": "Event \(index)",
            "startsAt": startsAt,
            "endsAt": endsAt,
            "displayTimeZone": "Asia/Tokyo",
            "region": "tokyo",
            "publicArea": "涩谷区",
            "coverURL": NSNull(),
            "format": "in_person",
            "primaryLocale": "ja",
            "localeConfirmed": true,
            "version": 1,
            "updatedAt": "2026-07-15T00:00:00Z",
        ]
        return [
            "registration": [
                "id": registrationIDForIndex(index).uuidString.lowercased(),
                "eventId": eventIDForIndex(index).uuidString.lowercased(),
                "userId": "019b0000-0000-7000-8000-000000000001",
                "status": status,
                "partySize": 1,
                "attendeeNote": NSNull(),
                "availableActions": actions,
                "version": 1,
                "offerExpiresAt": offerExpiresAt as Any? ?? NSNull(),
                "updatedAt": updatedAt,
                "rewardPoints": NSNull(),
                "checkinMethod": NSNull(),
            ],
            "event": eventPayload,
        ]
    }

    private func registrationIDForIndex(_ index: Int) -> UUID {
        UUID(uuidString: String(format: "019b0000-0000-7000-8400-%012d", index))!
    }

    private func eventIDForIndex(_ index: Int) -> UUID {
        UUID(uuidString: String(format: "019b0000-0000-7000-8500-%012d", index))!
    }
}

private final class MyActivitiesTestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Date

    init(_ value: Date) {
        self.value = value
    }

    func now() -> Date {
        lock.withLock { value }
    }

    func advance(by interval: TimeInterval) {
        lock.withLock { value = value.addingTimeInterval(interval) }
    }
}

private actor MyActivitiesServiceStub: MyActivitiesServing {
    struct AcceptanceRequest: Sendable {
        let registrationID: UUID
        let quoteID: UUID
        let expectedRegistrationVersion: Int
        let expectedEventVersion: Int
        let idempotencyKey: UUID
    }

    nonisolated private let authoritativeClock: @Sendable () -> Date
    private var pages: [RegistrationItineraryPage]
    private var quotes: [Quote]
    private let failAfterPageCount: Int?
    private var itineraryDelays: [Duration]
    private let actionDelay: Duration?
    private let ignoresActionCancellation: Bool
    private var itineraryRequests = 0
    private var quoteRequests = 0
    private var cursors: [String?] = []
    private var limits: [Int] = []
    private var acceptedIDs: [UUID] = []
    private var acceptanceRequests: [AcceptanceRequest] = []
    private let failFirstAcceptanceAfterRecording: Bool
    private var didFailAcceptance = false
    private var cancelledIDs: [UUID] = []

    init(
        pages: [RegistrationItineraryPage],
        quotes: [Quote] = [],
        failFirstAcceptanceAfterRecording: Bool = false,
        failAfterPageCount: Int? = nil,
        itineraryDelays: [Duration] = [],
        actionDelay: Duration? = nil,
        ignoresActionCancellation: Bool = false,
        authoritativeClock: @escaping @Sendable () -> Date = { .now }
    ) {
        self.authoritativeClock = authoritativeClock
        self.pages = pages
        self.quotes = quotes
        self.failFirstAcceptanceAfterRecording = failFirstAcceptanceAfterRecording
        self.failAfterPageCount = failAfterPageCount
        self.itineraryDelays = itineraryDelays
        self.actionDelay = actionDelay
        self.ignoresActionCancellation = ignoresActionCancellation
    }

    nonisolated func authoritativeNow() -> Date { authoritativeClock() }

    func registrationItinerary(cursor: String?, limit: Int) async throws -> RegistrationItineraryPage {
        itineraryRequests += 1
        cursors.append(cursor)
        limits.append(limit)
        if let failAfterPageCount, itineraryRequests > failAfterPageCount {
            throw URLError(.notConnectedToInternet)
        }
        guard !pages.isEmpty else { throw StubError.missingPage }
        let page = pages.removeFirst()
        let delay = itineraryDelays.isEmpty ? nil : itineraryDelays.removeFirst()
        if let delay, delay > .zero {
            try await Task.sleep(for: delay)
        }
        return page
    }

    func quote(purpose: String, resourceID: UUID?) async throws -> Quote {
        quoteRequests += 1
        guard purpose == "registration", resourceID != nil, !quotes.isEmpty else {
            throw StubError.missingQuote
        }
        let quote = quotes.removeFirst()
        if let actionDelay {
            do {
                try await Task.sleep(for: actionDelay)
            } catch where ignoresActionCancellation {
                // Return the server result so the store must quarantine a cancelled task.
            }
        }
        return quote
    }

    func acceptWaitlist(
        registrationID: UUID,
        quoteID: UUID,
        expectedRegistrationVersion: Int,
        expectedEventVersion: Int,
        idempotencyKey: UUID
    ) async throws -> Registration {
        if let actionDelay {
            do {
                try await Task.sleep(for: actionDelay)
            } catch where ignoresActionCancellation {
                // Model a server that committed before the client cancellation arrived.
            }
        }
        acceptedIDs.append(registrationID)
        acceptanceRequests.append(.init(
            registrationID: registrationID,
            quoteID: quoteID,
            expectedRegistrationVersion: expectedRegistrationVersion,
            expectedEventVersion: expectedEventVersion,
            idempotencyKey: idempotencyKey
        ))
        if failFirstAcceptanceAfterRecording, !didFailAcceptance {
            didFailAcceptance = true
            throw URLError(.networkConnectionLost)
        }
        return registration(id: registrationID, status: "confirmed")
    }

    func cancelRegistration(registrationID: UUID) async throws -> RegistrationCancellation {
        cancelledIDs.append(registrationID)
        return RegistrationCancellation(
            registration: registration(id: registrationID, status: "cancelled"),
            refundedPoints: 10,
            wallet: WalletSnapshot(paidBalance: 0, freeBalance: 100, totalBalance: 100, version: 2)
        )
    }

    func itineraryRequestCount() -> Int { itineraryRequests }
    func requestedCursors() -> [String?] { cursors }
    func requestedLimits() -> [Int] { limits }
    func acceptedRegistrationIDs() -> [UUID] { acceptedIDs }
    func acceptedRequests() -> [AcceptanceRequest] { acceptanceRequests }
    func quoteRequestCount() -> Int { quoteRequests }
    func cancelledRegistrationIDs() -> [UUID] { cancelledIDs }

    private func registration(id: UUID, status: String) -> Registration {
        Registration(
            id: id,
            eventId: UUID(),
            userId: UUID(),
            status: status,
            partySize: 1,
            attendeeNote: nil,
            availableActions: [],
            version: 2,
            offerExpiresAt: nil,
            updatedAt: .now,
            rewardPoints: nil,
            checkinMethod: nil
        )
    }

    private enum StubError: Error, Sendable {
        case missingPage
        case missingQuote
    }
}
