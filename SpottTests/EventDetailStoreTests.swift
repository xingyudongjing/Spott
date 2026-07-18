import Foundation
import XCTest
@testable import Spott

@MainActor
final class EventDetailStoreTests: XCTestCase {
    private let now = ISO8601DateFormatter().date(from: "2026-07-16T00:00:00Z")!

    func testRefreshReplacesTheDiscoverySnapshotWithStrictAuthorizedDetail() async throws {
        let viewerID = UUID(uuidString: "019b0000-0000-7000-8100-000000000020")!
        let discoveryEvent = try makeEvent([
            "publicArea": "涩谷区",
            "coordinate": [
                "latitude": 35.6762,
                "longitude": 139.6503,
                "precision": "approximate",
            ],
            "exactAddress": NSNull(),
        ])
        let strictDetail = try makeEvent([
            "publicArea": "涩谷区",
            "coordinate": [
                "latitude": 35.681236,
                "longitude": 139.767125,
                "precision": "exact",
            ],
            "exactAddress": "東京都千代田区丸の内1-9-1",
            "exactAddressVisibility": "confirmed",
            "viewerRegistration": viewerRegistration("confirmed"),
        ])
        let service = EventDetailServiceStub(responses: [strictDetail])
        let store = EventDetailStore(
            initialEvent: discoveryEvent,
            service: service,
            session: .verified,
            now: now
        )

        XCTAssertEqual(
            store.locationDisclosure(viewerID: viewerID),
            .approximate("涩谷区")
        )

        await store.refresh()

        XCTAssertEqual(store.event, strictDetail)
        XCTAssertEqual(
            store.locationDisclosure(viewerID: viewerID),
            .exact(
                publicArea: "涩谷区",
                address: "東京都千代田区丸の内1-9-1",
                coordinate: strictDetail.coordinate
            )
        )
        XCTAssertNil(store.error)
        let requestedIdentifiers = await service.requestedIdentifiers()
        XCTAssertEqual(requestedIdentifiers, [discoveryEvent.publicSlug])
    }

    func testPendingViewerCannotReadConfirmedOnlyExactLocationFromMalformedResponse() throws {
        let viewerID = UUID(uuidString: "019b0000-0000-7000-8100-000000000020")!
        let malformed = try makeEvent([
            "publicArea": "涩谷区",
            "viewerRegistration": viewerRegistration("pending"),
            "coordinate": [
                "latitude": 35.681236,
                "longitude": 139.767125,
                "precision": "exact",
            ],
            "exactAddress": "東京都千代田区丸の内1-9-1",
            "exactAddressVisibility": "confirmed",
        ])
        let store = EventDetailStore(
            initialEvent: malformed,
            service: EventDetailServiceStub(responses: []),
            session: .verified,
            initialViewerSnapshotIsCurrent: true,
            now: now
        )

        XCTAssertEqual(
            store.locationDisclosure(viewerID: viewerID),
            .approximate("涩谷区")
        )
    }

    func testConfirmedContactIsHiddenUntilThisSessionRefreshesTheViewerSnapshot() async throws {
        let stale = try makeEvent([
            "viewerRegistration": viewerRegistration("confirmed"),
            "organizerContact": organizerContact,
        ])
        let authorized = try makeEvent([
            "viewerRegistration": viewerRegistration("confirmed"),
            "organizerContact": organizerContact,
        ])
        let viewerID = UUID(uuidString: "019b0000-0000-7000-8100-000000000020")!
        let store = EventDetailStore(
            initialEvent: stale,
            service: EventDetailServiceStub(responses: [authorized]),
            session: .verified,
            now: now
        )

        XCTAssertFalse(store.hasAuthoritativeViewerSnapshot)
        XCTAssertNil(
            OrganizerContactDisclosurePolicy.contactForEventDetail(
                event: store.event,
                viewerID: viewerID,
                viewerSnapshotIsCurrent: store.hasAuthoritativeViewerSnapshot
            )
        )

        await store.refresh()

        XCTAssertTrue(store.hasAuthoritativeViewerSnapshot)
        XCTAssertEqual(
            OrganizerContactDisclosurePolicy.contactForEventDetail(
                event: store.event,
                viewerID: viewerID,
                viewerSnapshotIsCurrent: store.hasAuthoritativeViewerSnapshot
            )?.value,
            "host@example.com"
        )

        store.invalidateViewerSnapshot()

        XCTAssertFalse(store.hasAuthoritativeViewerSnapshot)
        XCTAssertNil(
            OrganizerContactDisclosurePolicy.contactForEventDetail(
                event: store.event,
                viewerID: UUID(),
                viewerSnapshotIsCurrent: store.hasAuthoritativeViewerSnapshot
            )
        )
    }

    func testFreshSessionBoundRouteShowsContactThenInvalidationHidesContactAndExactLocation() throws {
        let fresh = try makeEvent([
            "publicArea": "涩谷区",
            "viewerRegistration": viewerRegistration("confirmed"),
            "organizerContact": organizerContact,
            "coordinate": [
                "latitude": 35.681236,
                "longitude": 139.767125,
                "precision": "exact",
            ],
            "exactAddress": "東京都千代田区丸の内1-9-1",
            "exactAddressVisibility": "confirmed",
        ])
        let viewerID = UUID(uuidString: "019b0000-0000-7000-8100-000000000020")!
        let store = EventDetailStore(
            initialEvent: fresh,
            service: EventDetailServiceStub(responses: []),
            session: .verified,
            initialViewerSnapshotIsCurrent: true,
            now: now
        )

        XCTAssertTrue(store.hasAuthoritativeViewerSnapshot)
        XCTAssertEqual(
            OrganizerContactDisclosurePolicy.contactForEventDetail(
                event: store.event,
                viewerID: viewerID,
                viewerSnapshotIsCurrent: store.hasAuthoritativeViewerSnapshot
            )?.value,
            "host@example.com"
        )
        XCTAssertEqual(
            store.locationDisclosure(viewerID: viewerID),
            .exact(
                publicArea: "涩谷区",
                address: "東京都千代田区丸の内1-9-1",
                coordinate: fresh.coordinate
            )
        )

        store.invalidateViewerSnapshot()

        XCTAssertNil(
            OrganizerContactDisclosurePolicy.contactForEventDetail(
                event: store.event,
                viewerID: UUID(),
                viewerSnapshotIsCurrent: store.hasAuthoritativeViewerSnapshot
            )
        )
        XCTAssertEqual(
            store.locationDisclosure(viewerID: UUID()),
            .approximate("涩谷区")
        )
    }

    func testSessionInvalidationRejectsALateViewerScopedRefresh() async throws {
        let stale = try makeEvent([
            "title": "Old account snapshot",
            "viewerRegistration": viewerRegistration("confirmed"),
            "organizerContact": organizerContact,
        ])
        let lateResponse = try makeEvent([
            "title": "Late old-account response",
            "viewerRegistration": viewerRegistration("confirmed"),
            "organizerContact": organizerContact,
        ])
        let service = EventDetailServiceStub(
            responses: [lateResponse],
            responseDelay: .milliseconds(150)
        )
        let store = EventDetailStore(
            initialEvent: stale,
            service: service,
            session: .verified,
            now: now
        )

        let oldRefresh = Task { await store.refresh() }
        while await service.requestedIdentifiers().isEmpty {
            await Task.yield()
        }
        store.invalidateViewerSnapshot()
        await oldRefresh.value

        XCTAssertFalse(store.hasAuthoritativeViewerSnapshot)
        XCTAssertEqual(store.event.title, "Old account snapshot")
    }

    func testRefreshRejectsViewerDetailsForADifferentEventRoute() async throws {
        let initial = try makeEvent(["title": "Expected event"])
        let wrongEvent = try makeEvent([
            "id": "019b0000-0000-7000-8100-000000000099",
            "title": "Wrong event",
            "viewerRegistration": viewerRegistration("confirmed"),
            "organizerContact": organizerContact,
        ])
        let store = EventDetailStore(
            initialEvent: initial,
            service: EventDetailServiceStub(responses: [wrongEvent]),
            session: .verified,
            now: now
        )

        await store.refresh()

        XCTAssertEqual(store.event.id, initial.id)
        XCTAssertEqual(store.event.title, "Expected event")
        XCTAssertFalse(store.hasAuthoritativeViewerSnapshot)
        XCTAssertEqual(store.error?.id, "EVENT_ROUTE_MISMATCH")
    }

    func testStrictResponseWithoutAddressNeverPromotesApproximateLocation() async throws {
        let initial = try makeEvent(["publicArea": "涩谷区"])
        let unauthorized = try makeEvent([
            "publicArea": "涩谷区",
            "coordinate": [
                "latitude": 35.6762,
                "longitude": 139.6503,
                "precision": "approximate",
            ],
            "exactAddress": NSNull(),
            "exactAddressVisibility": "confirmed",
        ])
        let store = EventDetailStore(
            initialEvent: initial,
            service: EventDetailServiceStub(responses: [unauthorized]),
            session: .verified,
            now: now
        )

        await store.refresh()

        XCTAssertEqual(store.locationDisclosure, .approximate("涩谷区"))
        XCTAssertNil(store.event.exactAddress)
        XCTAssertEqual(store.event.coordinate?.precision, .approximate)
    }

    func testRefreshFailureRetainsExistingFactsAndSurfacesRecoverableError() async throws {
        let initial = try makeEvent()
        let service = EventDetailServiceStub(responses: [], failure: .offline)
        let store = EventDetailStore(
            initialEvent: initial,
            service: service,
            session: .verified,
            now: now
        )

        await store.refresh()

        XCTAssertEqual(store.event, initial)
        XCTAssertEqual(store.error?.id, "NETWORK_UNAVAILABLE")
        XCTAssertTrue(store.error?.retryable == true)
    }

    func testPublishedIncompleteDetailIsRejectedAsAContractFailure() async throws {
        let initial = try makeEvent()
        let incomplete = try makeEvent([
            "publicArea": NSNull(),
            "fee": NSNull(),
        ])
        let store = EventDetailStore(
            initialEvent: initial,
            service: EventDetailServiceStub(responses: [incomplete]),
            session: .verified,
            now: now
        )

        await store.refresh()

        XCTAssertEqual(store.event, initial)
        XCTAssertEqual(store.error?.id, "EVENT_DATA_INCOMPLETE")
        XCTAssertFalse(store.error?.retryable == true)
    }

    func testOnlinePublishedDetailDoesNotRequireAPhysicalLocation() async throws {
        let initial = try makeEvent()
        let online = try makeEvent([
            "format": "online",
            "region": NSNull(),
            "publicArea": NSNull(),
        ])
        let store = EventDetailStore(
            initialEvent: initial,
            service: EventDetailServiceStub(responses: [online]),
            session: .verified,
            now: now
        )

        await store.refresh()

        XCTAssertEqual(store.event, online)
        XCTAssertEqual(store.locationDisclosure, .unavailable)
        XCTAssertNil(store.error)
    }

    func testHybridPublishedDetailStillRequiresAPublicPhysicalLocation() async throws {
        let initial = try makeEvent()
        let incompleteHybrid = try makeEvent([
            "format": "hybrid",
            "publicArea": NSNull(),
        ])
        let store = EventDetailStore(
            initialEvent: initial,
            service: EventDetailServiceStub(responses: [incompleteHybrid]),
            session: .verified,
            now: now
        )

        await store.refresh()

        XCTAssertEqual(store.event, initial)
        XCTAssertEqual(store.error?.id, "EVENT_DATA_INCOMPLETE")
    }

    func testCTAReevaluatesAnOfferAgainstTheInjectedClock() throws {
        let clock = EventDetailTestClock(now)
        let event = try makeEvent([
            "viewerRegistration": [
                "id": "019b0000-0000-7000-8100-000000000099",
                "status": "offered",
                "partySize": 1,
                "offerExpiresAt": "2026-07-16T00:10:00Z",
            ],
        ])
        let store = EventDetailStore(
            initialEvent: event,
            service: EventDetailServiceStub(responses: []),
            session: .verified,
            clock: clock.now
        )

        XCTAssertEqual(store.ctaState.kind, .acceptWaitlist)

        clock.advance(by: 601)

        XCTAssertEqual(store.ctaState.kind, .register)
    }

    func testTemporalBoundaryUsesTheInjectedClockAndStopsSchedulingAfterExpiry() throws {
        let clock = EventDetailTestClock(now)
        let event = try makeEvent([
            "viewerRegistration": [
                "id": "019b0000-0000-7000-8100-000000000099",
                "status": "offered",
                "partySize": 1,
                "offerExpiresAt": "2026-07-16T00:10:00Z",
            ],
        ])
        let store = EventDetailStore(
            initialEvent: event,
            service: EventDetailServiceStub(responses: []),
            session: .verified,
            clock: clock.now
        )

        let delay = try XCTUnwrap(store.temporalRefreshDelay())
        XCTAssertEqual(delay, 600, accuracy: 0.001)
        clock.advance(by: 601)
        store.refreshTemporalState()

        XCTAssertNil(store.nextTemporalRefreshDate)
        XCTAssertEqual(store.ctaState.kind, .register)
    }

    func testHeroDatePartsUseTheEventTimeZoneInsteadOfTheDeviceZone() throws {
        let date = try XCTUnwrap(
            ISO8601DateFormatter().date(from: "2026-07-16T23:30:00Z")
        )
        let locale = Locale(identifier: "en")

        XCTAssertEqual(
            CoreJourneyLocalization.datePart(
                date,
                template: "d",
                timeZoneIdentifier: "Asia/Tokyo",
                locale: locale
            ),
            "17"
        )
        XCTAssertEqual(
            CoreJourneyLocalization.datePart(
                date,
                template: "d",
                timeZoneIdentifier: "America/Los_Angeles",
                locale: locale
            ),
            "16"
        )
    }

    func testVisibleDateTimeNamesTheEventTimeZoneForTravelingUsers() throws {
        let date = try XCTUnwrap(
            ISO8601DateFormatter().date(from: "2026-07-16T23:30:00Z")
        )
        let locale = Locale(identifier: "en")
        let tokyo = CoreJourneyLocalization.dateTime(
            date,
            timeZoneIdentifier: "Asia/Tokyo",
            locale: locale
        )
        let losAngeles = CoreJourneyLocalization.dateTime(
            date,
            timeZoneIdentifier: "America/Los_Angeles",
            locale: locale
        )

        XCTAssertTrue(tokyo.contains("GMT+9") || tokyo.contains("JST"), tokyo)
        XCTAssertTrue(
            losAngeles.contains("GMT-7") || losAngeles.contains("PDT"),
            losAngeles
        )
        XCTAssertNotEqual(tokyo, losAngeles)
    }

    func testAPIErrorsNeverLeakAServerLanguageIntoAnotherLocale() async throws {
        for identifier in ["zh-Hans", "ja", "en"] {
            let store = EventDetailStore(
                initialEvent: try makeEvent(),
                service: EventDetailServiceStub(responses: [], failure: .api),
                session: .verified,
                locale: Locale(identifier: identifier),
                now: now
            )

            await store.refresh()

            XCTAssertNotEqual(store.error?.message, "服务器内部错误", identifier)
            XCTAssertEqual(store.error?.id, "SERVER_FAILURE", identifier)
        }
    }

    func testRecoverableErrorsAreLocalizedInAllSupportedLanguages() async throws {
        let expectations = [
            ("zh-Hans", "暂时无法连接 Spott，请检查网络后重试。"),
            ("ja", "Spottに接続できません。通信環境を確認して、もう一度お試しください。"),
            ("en", "Spott can’t connect right now. Check your connection and try again."),
        ]

        for (identifier, expectedMessage) in expectations {
            let store = EventDetailStore(
                initialEvent: try makeEvent(),
                service: EventDetailServiceStub(responses: [], failure: .offline),
                session: .verified,
                locale: Locale(identifier: identifier),
                now: now
            )

            await store.refresh()

            XCTAssertEqual(store.error?.message, expectedMessage, identifier)
        }
    }

    func testStoreExposesEverySharedCTAOutcomeWithoutInventingAnAction() throws {
        let registrationID = "019b0000-0000-7000-8100-000000000099"
        let activeOffer: [String: Any] = [
            "id": registrationID,
            "status": "offered",
            "partySize": 1,
            "offerExpiresAt": "2026-07-16T00:10:00Z",
        ]
        let cases: [([String: Any], EventCTASession, EventCTAState.Kind)] = [
            (["status": "cancelled", "viewerRegistration": activeOffer], .verified, .eventUnavailable),
            (["viewerRegistration": activeOffer], .verified, .acceptWaitlist),
            (["viewerRegistration": viewerRegistration("confirmed")], .verified, .viewItinerary),
            (["viewerRegistration": viewerRegistration("pending")], .verified, .viewPending),
            (["viewerRegistration": viewerRegistration("waitlisted")], .verified, .viewWaitlist),
            (["availableActions": []], .guest, .continueLogin),
            (["availableActions": []], .unverified, .continuePhoneVerification),
            (["status": "registration_closed"], .verified, .registrationClosed),
            (["confirmedCount": 8, "availableCapacity": 0, "availableActions": ["joinWaitlist"]], .verified, .joinWaitlist),
            (["confirmedCount": 10, "availableCapacity": 0, "waitlistEnabled": false, "availableActions": []], .verified, .fullClosed),
            (["registrationMode": "approval"], .verified, .apply),
            ([:], .verified, .register),
        ]

        for (overrides, session, expectedKind) in cases {
            let event = try makeEvent(overrides)
            let store = EventDetailStore(
                initialEvent: event,
                service: EventDetailServiceStub(responses: []),
                session: session,
                now: now
            )
            XCTAssertEqual(store.ctaState.kind, expectedKind)
        }
    }

    func testNativeFactsKeepTheRequiredScanOrderAndNeverInventAnOnlineAddress() throws {
        let online = try makeEvent([
            "format": "online",
            "region": NSNull(),
            "publicArea": NSNull(),
            "coordinate": NSNull(),
            "exactAddress": NSNull(),
        ])
        let presentation = EventFactsPresentation(
            event: online,
            disclosure: .unavailable,
            locale: Locale(identifier: "en")
        )

        XCTAssertEqual(
            presentation.items.map(\.kind),
            [.time, .location, .format, .language, .fee, .capacity]
        )
        XCTAssertEqual(presentation.items.first(where: { $0.kind == .location })?.value, "Online event")
        XCTAssertFalse(presentation.items.contains(where: { $0.value.contains("Tokyo") }))
        XCTAssertTrue(presentation.items.allSatisfy { !$0.title.isEmpty && !$0.value.isEmpty })
    }

    func testEveryCTAHasLocalizedNativeActionCopyInThreeLanguages() {
        let kinds: [EventCTAState.Kind] = [
            .eventUnavailable,
            .acceptWaitlist,
            .viewItinerary,
            .viewPending,
            .viewWaitlist,
            .continueLogin,
            .continuePhoneVerification,
            .registrationClosed,
            .joinWaitlist,
            .fullClosed,
            .apply,
            .register,
        ]
        let locales = ["zh-Hans", "ja", "en"].map(Locale.init(identifier:))

        for locale in locales {
            let copies = kinds.map {
                EventDetailActionPresentation(
                    state: .init(kind: $0, intent: .none, disabled: true),
                    locale: locale
                )
            }
            XCTAssertTrue(copies.allSatisfy { !$0.title.isEmpty && !$0.supportingText.isEmpty })
            XCTAssertEqual(Set(copies.map(\.title)).count, kinds.count)
        }

        let registerTitles = locales.map {
            EventDetailActionPresentation(
                state: .init(kind: .register, intent: .register, disabled: false),
                locale: $0
            ).title
        }
        XCTAssertEqual(Set(registerTitles).count, 3)
    }

    func testOrganizerTrustPresentationUsesServerTrustSignalsWithoutInventingMetrics() throws {
        let event = try makeEvent()
        let presentation = OrganizerTrustPresentation(
            organizer: event.organizer,
            locale: Locale(identifier: "en")
        )

        XCTAssertEqual(presentation.name, event.organizer.name)
        XCTAssertEqual(presentation.handle, "@\(event.organizer.handle)")
        XCTAssertEqual(
            presentation.signals,
            ["Phone verified", "18 completed events", "90%+ attendance"]
        )

        let unavailable = OrganizerTrustPresentation(
            organizer: .init(
                id: event.organizer.id,
                name: event.organizer.name,
                handle: event.organizer.handle,
                viewerFollowing: false,
                trust: .init(
                    phoneVerified: false,
                    completedEventCount: 0,
                    attendanceRateBand: .unavailable
                )
            ),
            locale: Locale(identifier: "en")
        )
        XCTAssertEqual(unavailable.signals, ["Attendance history unavailable"])
    }

    private func makeEvent(_ overrides: [String: Any] = [:]) throws -> EventSummary {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(
            EventSummary.self,
            from: JSONSerialization.data(withJSONObject: eventPayload(overrides: overrides))
        )
    }

    private func viewerRegistration(_ status: String) -> [String: Any] {
        [
            "id": "019b0000-0000-7000-8100-000000000099",
            "status": status,
            "partySize": 1,
            "offerExpiresAt": NSNull(),
        ]
    }

    private var organizerContact: [String: Any] {
        [
            "kind": "email",
            "label": "Host support",
            "value": "host@example.com",
        ]
    }
}

private final class EventDetailTestClock: @unchecked Sendable {
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

private actor EventDetailServiceStub: EventDetailServing {
    enum Failure: Error, Sendable {
        case offline
        case api
    }

    private var responses: [EventSummary]
    private let failure: Failure?
    private let responseDelay: Duration?
    private var identifiers: [String] = []

    init(
        responses: [EventSummary],
        failure: Failure? = nil,
        responseDelay: Duration? = nil
    ) {
        self.responses = responses
        self.failure = failure
        self.responseDelay = responseDelay
    }

    func event(identifier: String) async throws -> EventSummary {
        identifiers.append(identifier)
        if let responseDelay {
            try await Task.sleep(for: responseDelay)
        }
        if let failure {
            switch failure {
            case .api:
                throw APIError(
                    status: 500,
                    code: "SERVER_FAILURE",
                    message: "服务器内部错误",
                    retryable: true
                )
            case .offline:
                throw failure
            }
        }
        guard !responses.isEmpty else { throw CancellationError() }
        return responses.removeFirst()
    }

    func requestedIdentifiers() -> [String] {
        identifiers
    }
}
