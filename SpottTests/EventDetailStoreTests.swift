import Foundation
import Observation
import SwiftUI
import UIKit
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

    func testServerActionsRequireAnAuthoritativeSnapshotAndUseOnlyAvailableActions() throws {
        let registrationID = UUID(uuidString: "019b0000-0000-7000-8100-000000000099")!
        let groupID = UUID(uuidString: "019b0000-0000-7000-8100-000000000066")!
        let event = try makeEvent([
            "viewerRegistration": viewerRegistration("confirmed"),
            "groupId": groupID.uuidString.lowercased(),
            "availableActions": [
                "edit",
                "appeal",
                "checkIn",
                "cancelRegistration",
                "joinGroup",
            ],
        ])

        XCTAssertEqual(
            EventDetailServerActionPolicy.resolve(
                event: event,
                viewerSnapshotIsCurrent: false
            ),
            []
        )
        XCTAssertEqual(
            EventDetailServerActionPolicy.resolve(
                event: event,
                viewerSnapshotIsCurrent: true
            ),
            [
                .checkIn(registrationID: registrationID),
                .openGroup(groupID: groupID),
                .cancelRegistration(registrationID: registrationID),
            ]
        )
    }

    func testServerActionPolicyNeverInventsMissingResourceIdentifiers() throws {
        let event = try makeEvent([
            "viewerRegistration": NSNull(),
            "groupId": NSNull(),
            "availableActions": ["checkIn", "cancelRegistration", "joinGroup"],
        ])

        XCTAssertEqual(
            EventDetailServerActionPolicy.resolve(
                event: event,
                viewerSnapshotIsCurrent: true
            ),
            []
        )
    }

    func testServerActionAuthorizationRequiresTheExactCurrentAction() throws {
        let originalRegistrationID = UUID(uuidString: "019b0000-0000-7000-8100-000000000099")!
        let replacementRegistrationID = UUID(uuidString: "019b0000-0000-7000-8100-000000000098")!
        let original = try makeEvent([
            "viewerRegistration": viewerRegistration("confirmed"),
            "availableActions": ["checkIn"],
        ])
        let replacement = try makeEvent([
            "viewerRegistration": [
                "id": replacementRegistrationID.uuidString.lowercased(),
                "status": "confirmed",
                "partySize": 1,
                "offerExpiresAt": NSNull(),
            ],
            "availableActions": ["checkIn"],
        ])
        let action = EventDetailServerAction.checkIn(registrationID: originalRegistrationID)

        XCTAssertTrue(
            EventDetailActionAuthorizer.isAuthorized(
                action,
                event: original,
                viewerSnapshotIsCurrent: true
            )
        )
        XCTAssertFalse(
            EventDetailActionAuthorizer.isAuthorized(
                action,
                event: replacement,
                viewerSnapshotIsCurrent: true
            )
        )
        XCTAssertFalse(
            EventDetailActionAuthorizer.isAuthorized(
                action,
                event: original,
                viewerSnapshotIsCurrent: false
            )
        )
    }

    func testDelayedCheckInResultIsDiscardedAfterTheAuthoritativeActionIsRevoked() async throws {
        let registrationID = UUID(uuidString: "019b0000-0000-7000-8100-000000000099")!
        let authorized = try makeEvent([
            "viewerRegistration": viewerRegistration("confirmed"),
            "availableActions": ["checkIn"],
        ])
        let revoked = try makeEvent([
            "viewerRegistration": viewerRegistration("checked_in"),
            "availableActions": [],
            "version": 13,
        ])
        let action = EventDetailServerAction.checkIn(registrationID: registrationID)
        let registration = makeRegistration(id: registrationID, eventID: authorized.id)
        var currentEvent = authorized
        var isAuthoritative = true

        let result = await EventDetailActionAuthorizer.revalidatedValue(
            for: action,
            currentSnapshot: { (currentEvent, isAuthoritative) }
        ) {
            await Task.yield()
            currentEvent = revoked
            return registration
        }

        guard case .revoked = result else {
            return XCTFail("Expected the delayed value to be revoked")
        }
        isAuthoritative = false
        XCTAssertFalse(
            EventDetailActionAuthorizer.isAuthorized(
                action,
                event: currentEvent,
                viewerSnapshotIsCurrent: isAuthoritative
            )
        )
    }

    func testRevalidatedValueSeparatesAuthorizedMissingAndRevokedOutcomes() async throws {
        let registrationID = UUID(uuidString: "019b0000-0000-7000-8100-000000000099")!
        let event = try makeEvent([
            "viewerRegistration": viewerRegistration("confirmed"),
            "availableActions": ["checkIn"],
        ])
        let registration = makeRegistration(id: registrationID, eventID: event.id)
        let action = EventDetailServerAction.checkIn(registrationID: registrationID)

        let authorized = await EventDetailActionAuthorizer.revalidatedValue(
            for: action,
            currentSnapshot: { (event, true) }
        ) { registration }
        guard case .authorized(let value) = authorized else {
            return XCTFail("Expected an authorized value")
        }
        XCTAssertEqual(value.id, registrationID)

        let missing = await EventDetailActionAuthorizer.revalidatedValue(
            for: action,
            currentSnapshot: { (event, true) }
        ) { Optional<Registration>.none }
        guard case .missing = missing else {
            return XCTFail("Expected an itinerary-missing outcome")
        }

        let revoked = await EventDetailActionAuthorizer.revalidatedValue(
            for: action,
            currentSnapshot: { (event, false) }
        ) { registration }
        guard case .revoked = revoked else {
            return XCTFail("Expected a revoked outcome")
        }
    }

    func testCallerResumeGapRequiresASynchronousAuthorizationCheckBeforeCommittingCheckIn() async throws {
        let registrationID = UUID(uuidString: "019b0000-0000-7000-8100-000000000099")!
        let authorized = try makeEvent([
            "viewerRegistration": viewerRegistration("confirmed"),
            "availableActions": ["checkIn"],
        ])
        let revoked = try makeEvent([
            "viewerRegistration": viewerRegistration("checked_in"),
            "availableActions": [],
            "version": 13,
        ])
        let action = EventDetailServerAction.checkIn(registrationID: registrationID)
        let registration = makeRegistration(id: registrationID, eventID: authorized.id)
        var currentEvent = authorized

        let helperResult = await EventDetailActionAuthorizer.revalidatedValue(
            for: action,
            currentSnapshot: { (currentEvent, true) }
        ) { registration }
        guard case .authorized = helperResult else {
            return XCTFail("Expected helper authorization before caller resumed")
        }

        currentEvent = revoked
        XCTAssertFalse(
            EventDetailActionAuthorizer.isAuthorized(
                action,
                event: currentEvent,
                viewerSnapshotIsCurrent: true
            ),
            "The synchronous caller-side commit gate must reject a newly revoked action"
        )
    }

    func testCancellationTaskSchedulingGapRechecksAuthorizationBeforeStartingTheMutation() async throws {
        let registrationID = UUID(uuidString: "019b0000-0000-7000-8100-000000000099")!
        let authorized = try makeEvent([
            "viewerRegistration": viewerRegistration("confirmed"),
            "availableActions": ["cancelRegistration"],
        ])
        let revoked = try makeEvent([
            "viewerRegistration": viewerRegistration("confirmed"),
            "availableActions": [],
            "version": 13,
        ])
        let action = EventDetailServerAction.cancelRegistration(registrationID: registrationID)
        var currentEvent = authorized
        var mutationCallCount = 0

        let task = Task { @MainActor in
            await Task.yield()
            return await EventDetailActionAuthorizer.authorizedMutation(
                for: action,
                currentSnapshot: { (currentEvent, true) }
            ) {
                mutationCallCount += 1
                return true
            }
        }
        currentEvent = revoked

        let outcome = await task.value
        guard case .revoked = outcome else {
            return XCTFail("Expected the scheduled mutation to be revoked")
        }
        XCTAssertEqual(mutationCallCount, 0)
    }

    func testActionRunnerRechecksAuthorizationAfterTheHelperReturnsBeforePresentingCheckIn() async throws {
        let registrationID = UUID(uuidString: "019b0000-0000-7000-8100-000000000099")!
        let authorized = try makeEvent([
            "viewerRegistration": viewerRegistration("confirmed"),
            "availableActions": ["checkIn"],
        ])
        let revoked = try makeEvent([
            "viewerRegistration": viewerRegistration("checked_in"),
            "availableActions": [],
            "version": 13,
        ])
        let sequence = EventDetailActionSnapshotSequence(
            authorized: .init(
                sessionFingerprint: "session-a",
                event: authorized,
                viewerSnapshotIsCurrent: true
            ),
            revoked: .init(
                sessionFingerprint: "session-a",
                event: revoked,
                viewerSnapshotIsCurrent: true
            ),
            authorizedReadCount: 4
        )
        let recorder = EventDetailActionEffectRecorder()
        let runner = EventDetailActionRunner()

        runner.startCheckIn(
            registrationID: registrationID,
            locale: Locale(identifier: "en"),
            snapshot: { sequence.next() },
            load: { registrationID, eventID in
                self.makeRegistration(id: registrationID, eventID: eventID)
            },
            emit: recorder.record
        )
        let task = try XCTUnwrap(runner.activeTask)
        await task.value

        XCTAssertTrue(recorder.effects.isEmpty)
        XCTAssertNil(runner.busyAction)
        XCTAssertNil(runner.activeTask)
        XCTAssertNil(runner.activeContext)
    }

    func testActionRunnerRechecksAQueuedCancellationBeforeCallingTheAPI() async throws {
        let registrationID = UUID(uuidString: "019b0000-0000-7000-8100-000000000099")!
        let authorized = try makeEvent([
            "viewerRegistration": viewerRegistration("confirmed"),
            "availableActions": ["cancelRegistration"],
        ])
        let revoked = try makeEvent([
            "viewerRegistration": viewerRegistration("confirmed"),
            "availableActions": [],
            "version": 13,
        ])
        let snapshot = EventDetailActionSnapshotBox(
            .init(
                sessionFingerprint: "session-a",
                event: authorized,
                viewerSnapshotIsCurrent: true
            )
        )
        let recorder = EventDetailActionEffectRecorder()
        let runner = EventDetailActionRunner()
        var mutationCallCount = 0

        runner.startCancellation(
            registrationID: registrationID,
            locale: Locale(identifier: "en"),
            snapshot: { snapshot.value },
            mutate: { mutationCallCount += 1 },
            refresh: { .synced },
            emit: recorder.record
        )
        let task = try XCTUnwrap(runner.activeTask)
        snapshot.value = .init(
            sessionFingerprint: "session-a",
            event: revoked,
            viewerSnapshotIsCurrent: true
        )
        await task.value

        XCTAssertEqual(mutationCallCount, 0)
        XCTAssertTrue(recorder.effects.isEmpty)
        XCTAssertNil(runner.busyAction)
        XCTAssertNil(runner.activeTask)
    }

    func testActionRunnerSessionChangeCancelsAnInFlightCheckIn() async throws {
        let event = try makeEvent([
            "viewerRegistration": viewerRegistration("confirmed"),
            "availableActions": ["checkIn"],
        ])
        let registrationID = try XCTUnwrap(event.viewerRegistration?.id)
        let snapshot = EventDetailActionSnapshotBox(
            .init(
                sessionFingerprint: "session-a",
                event: event,
                viewerSnapshotIsCurrent: true
            )
        )
        let load = EventDetailActionContinuation<Registration?>()
        let recorder = EventDetailActionEffectRecorder()
        let runner = EventDetailActionRunner()

        runner.startCheckIn(
            registrationID: registrationID,
            locale: Locale(identifier: "en"),
            snapshot: { snapshot.value },
            load: { _, _ in try await load.value() },
            emit: recorder.record
        )
        let task = try XCTUnwrap(runner.activeTask)
        await assertEventually { load.started }

        snapshot.value = .init(
            sessionFingerprint: "session-b",
            event: event,
            viewerSnapshotIsCurrent: true
        )
        runner.identityDidChange()

        XCTAssertNil(runner.busyAction)
        XCTAssertNil(runner.activeTask)
        XCTAssertNil(runner.activeContext)
        load.resume(throwing: CancellationError())
        await task.value
        XCTAssertTrue(recorder.effects.isEmpty)
    }

    func testActionRunnerEventChangeDropsALateCancellationErrorWithoutBanner() async throws {
        let event = try makeEvent([
            "viewerRegistration": viewerRegistration("confirmed"),
            "availableActions": ["cancelRegistration"],
        ])
        let replacement = try makeEvent([
            "id": "019b0000-0000-7000-8100-000000000777",
            "viewerRegistration": viewerRegistration("confirmed"),
            "availableActions": ["cancelRegistration"],
        ])
        let registrationID = try XCTUnwrap(event.viewerRegistration?.id)
        let snapshot = EventDetailActionSnapshotBox(
            .init(
                sessionFingerprint: "session-a",
                event: event,
                viewerSnapshotIsCurrent: true
            )
        )
        let mutation = EventDetailActionContinuation<Void>()
        let recorder = EventDetailActionEffectRecorder()
        let runner = EventDetailActionRunner()

        runner.startCancellation(
            registrationID: registrationID,
            locale: Locale(identifier: "en"),
            snapshot: { snapshot.value },
            mutate: { try await mutation.value() },
            refresh: { .synced },
            emit: recorder.record
        )
        let task = try XCTUnwrap(runner.activeTask)
        await assertEventually { mutation.started }

        snapshot.value = .init(
            sessionFingerprint: "session-a",
            event: replacement,
            viewerSnapshotIsCurrent: true
        )
        runner.eventDidChange()
        mutation.resume(throwing: EventDetailRunnerTestError.lateFailure)
        await task.value

        XCTAssertTrue(recorder.effects.isEmpty)
        XCTAssertNil(runner.busyAction)
        XCTAssertNil(runner.activeTask)
        XCTAssertNil(runner.activeContext)
    }

    func testActionRunnerCancellationErrorIsSilentAndReleasesTheActionSlot() async throws {
        let event = try makeEvent([
            "viewerRegistration": viewerRegistration("confirmed"),
            "availableActions": ["cancelRegistration"],
        ])
        let registrationID = try XCTUnwrap(event.viewerRegistration?.id)
        let snapshot = EventDetailActionSnapshotBox(
            .init(
                sessionFingerprint: "session-a",
                event: event,
                viewerSnapshotIsCurrent: true
            )
        )
        let recorder = EventDetailActionEffectRecorder()
        let runner = EventDetailActionRunner()

        runner.startCancellation(
            registrationID: registrationID,
            locale: Locale(identifier: "en"),
            snapshot: { snapshot.value },
            mutate: { throw CancellationError() },
            refresh: { .synced },
            emit: recorder.record
        )
        let task = try XCTUnwrap(runner.activeTask)
        await task.value

        XCTAssertTrue(recorder.effects.isEmpty)
        XCTAssertNil(runner.busyAction)
        XCTAssertNil(runner.activeTask)
        XCTAssertNil(runner.activeContext)
    }

    func testActionRunnerCheckInMapsEveryGenericErrorUsingTheExplicitAppLocale() async throws {
        let event = try makeEvent([
            "viewerRegistration": viewerRegistration("confirmed"),
            "availableActions": ["checkIn"],
        ])
        let registrationID = try XCTUnwrap(event.viewerRegistration?.id)
        let snapshot = EventDetailActionSnapshotBox(
            .init(
                sessionFingerprint: "session-a",
                event: event,
                viewerSnapshotIsCurrent: true
            )
        )
        let systemLanguage = Locale.current.language.languageCode?.identifier
        let appLocales = ["zh-Hans", "ja", "en"]

        XCTAssertGreaterThanOrEqual(
            appLocales.filter {
                Locale(identifier: $0).language.languageCode?.identifier != systemLanguage
            }.count,
            2,
            "The regression must exercise app locales that differ from the process locale"
        )

        for scenario in genericActionErrorScenarios {
            for localeIdentifier in appLocales {
                let recorder = EventDetailActionEffectRecorder()
                let runner = EventDetailActionRunner()
                runner.startCheckIn(
                    registrationID: registrationID,
                    locale: Locale(identifier: localeIdentifier),
                    snapshot: { snapshot.value },
                    load: { _, _ in throw scenario.error },
                    emit: recorder.record
                )
                let task = try XCTUnwrap(runner.activeTask)
                await task.value

                let banner = try XCTUnwrap(
                    recorder.bannerErrors.only,
                    "Expected one check-in banner for \(scenario.name):\(localeIdentifier)"
                )
                XCTAssertEqual(banner.id, scenario.id, scenario.name)
                XCTAssertEqual(
                    banner.message,
                    try XCTUnwrap(scenario.messages[localeIdentifier]),
                    "Check-in must follow the explicit App locale for \(scenario.name)"
                )
                XCTAssertEqual(banner.retryable, scenario.retryable, scenario.name)
                XCTAssertNil(runner.activeTask)
                XCTAssertNil(runner.activeContext)
                XCTAssertNil(runner.busyAction)
            }
        }
    }

    func testActionRunnerCancellationMapsEveryGenericErrorUsingTheExplicitAppLocale() async throws {
        let event = try makeEvent([
            "viewerRegistration": viewerRegistration("confirmed"),
            "availableActions": ["cancelRegistration"],
        ])
        let registrationID = try XCTUnwrap(event.viewerRegistration?.id)
        let snapshot = EventDetailActionSnapshotBox(
            .init(
                sessionFingerprint: "session-a",
                event: event,
                viewerSnapshotIsCurrent: true
            )
        )
        let systemLanguage = Locale.current.language.languageCode?.identifier
        let appLocales = ["zh-Hans", "ja", "en"]

        XCTAssertGreaterThanOrEqual(
            appLocales.filter {
                Locale(identifier: $0).language.languageCode?.identifier != systemLanguage
            }.count,
            2,
            "The regression must exercise app locales that differ from the process locale"
        )

        for scenario in genericActionErrorScenarios {
            for localeIdentifier in appLocales {
                let recorder = EventDetailActionEffectRecorder()
                let runner = EventDetailActionRunner()
                runner.startCancellation(
                    registrationID: registrationID,
                    locale: Locale(identifier: localeIdentifier),
                    snapshot: { snapshot.value },
                    mutate: { throw scenario.error },
                    refresh: { .synced },
                    emit: recorder.record
                )
                let task = try XCTUnwrap(runner.activeTask)
                await task.value

                let banner = try XCTUnwrap(
                    recorder.bannerErrors.only,
                    "Expected one cancellation banner for \(scenario.name):\(localeIdentifier)"
                )
                XCTAssertEqual(banner.id, scenario.id, scenario.name)
                XCTAssertEqual(
                    banner.message,
                    try XCTUnwrap(scenario.messages[localeIdentifier]),
                    "Cancellation must follow the explicit App locale for \(scenario.name)"
                )
                XCTAssertEqual(banner.retryable, scenario.retryable, scenario.name)
                XCTAssertNil(runner.activeTask)
                XCTAssertNil(runner.activeContext)
                XCTAssertNil(runner.busyAction)
            }
        }
    }

    func testActionRunnerShowsMissingCheckInButKeepsRevocationSilent() async throws {
        let authorized = try makeEvent([
            "viewerRegistration": viewerRegistration("confirmed"),
            "availableActions": ["checkIn"],
        ])
        let revoked = try makeEvent([
            "viewerRegistration": viewerRegistration("checked_in"),
            "availableActions": [],
            "version": 13,
        ])
        let registrationID = try XCTUnwrap(authorized.viewerRegistration?.id)
        let missingSnapshot = EventDetailActionSnapshotBox(
            .init(
                sessionFingerprint: "session-a",
                event: authorized,
                viewerSnapshotIsCurrent: true
            )
        )
        let missingRecorder = EventDetailActionEffectRecorder()
        let missingRunner = EventDetailActionRunner()

        missingRunner.startCheckIn(
            registrationID: registrationID,
            locale: Locale(identifier: "en"),
            snapshot: { missingSnapshot.value },
            load: { _, _ in nil },
            emit: missingRecorder.record
        )
        let missingTask = try XCTUnwrap(missingRunner.activeTask)
        await missingTask.value

        XCTAssertEqual(missingRecorder.bannerErrors.map(\.id), ["REGISTRATION_NOT_FOUND"])

        let revokedSnapshot = EventDetailActionSnapshotBox(missingSnapshot.value)
        let delayedLoad = EventDetailActionContinuation<Registration?>()
        let revokedRecorder = EventDetailActionEffectRecorder()
        let revokedRunner = EventDetailActionRunner()
        revokedRunner.startCheckIn(
            registrationID: registrationID,
            locale: Locale(identifier: "en"),
            snapshot: { revokedSnapshot.value },
            load: { _, _ in try await delayedLoad.value() },
            emit: revokedRecorder.record
        )
        let revokedTask = try XCTUnwrap(revokedRunner.activeTask)
        await assertEventually { delayedLoad.started }
        revokedSnapshot.value = .init(
            sessionFingerprint: "session-a",
            event: revoked,
            viewerSnapshotIsCurrent: true
        )
        delayedLoad.resume(returning: nil)
        await revokedTask.value

        XCTAssertTrue(revokedRecorder.effects.isEmpty)
    }

    func testActionRunnerReportsCancellationSuccessAfterRefreshRevokesTheAction() async throws {
        let authorized = try makeEvent([
            "viewerRegistration": viewerRegistration("confirmed"),
            "availableActions": ["cancelRegistration"],
        ])
        let revoked = try makeEvent([
            "viewerRegistration": viewerRegistration("confirmed"),
            "availableActions": [],
            "version": 13,
        ])
        let registrationID = try XCTUnwrap(authorized.viewerRegistration?.id)
        let snapshot = EventDetailActionSnapshotBox(
            .init(
                sessionFingerprint: "session-a",
                event: authorized,
                viewerSnapshotIsCurrent: true
            )
        )
        let recorder = EventDetailActionEffectRecorder()
        let runner = EventDetailActionRunner()

        runner.startCancellation(
            registrationID: registrationID,
            locale: Locale(identifier: "en"),
            snapshot: { snapshot.value },
            mutate: { },
            refresh: {
                snapshot.value = .init(
                    sessionFingerprint: "session-a",
                    event: revoked,
                    viewerSnapshotIsCurrent: true
                )
                return .synced
            },
            emit: recorder.record
        )
        let task = try XCTUnwrap(runner.activeTask)
        await task.value

        XCTAssertEqual(recorder.cancellationOutcomes, [.synced])
        XCTAssertNil(runner.busyAction)
    }

    func testEventDetailViewPageExitCancelsTheInjectedActionRunner() async throws {
        let event = try makeEvent([
            "viewerRegistration": viewerRegistration("confirmed"),
            "availableActions": ["checkIn"],
        ])
        let registrationID = try XCTUnwrap(event.viewerRegistration?.id)
        let snapshot = EventDetailActionSnapshotBox(
            .init(
                sessionFingerprint: "session-a",
                event: event,
                viewerSnapshotIsCurrent: true
            )
        )
        let load = EventDetailActionContinuation<Registration?>()
        let recorder = EventDetailActionEffectRecorder()
        let runner = EventDetailActionRunner()
        runner.startCheckIn(
            registrationID: registrationID,
            locale: Locale(identifier: "en"),
            snapshot: { snapshot.value },
            load: { _, _ in try await load.value() },
            emit: recorder.record
        )
        let task = try XCTUnwrap(runner.activeTask)
        await assertEventually { load.started }

        let visibility = EventDetailScreenVisibility()
        let model = makeEventDetailHostModel()
        let host = UIHostingController(
            rootView: EventDetailScreenHost(
                visibility: visibility,
                event: event,
                runner: runner,
                model: model
            )
        )
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = host
        window.makeKeyAndVisible()
        await yieldRepeatedly()

        visibility.isVisible = false
        await assertEventually { runner.activeTask == nil }

        XCTAssertNil(runner.busyAction)
        XCTAssertNil(runner.activeContext)
        load.resume(throwing: CancellationError())
        await task.value
        XCTAssertTrue(recorder.effects.isEmpty)
        window.isHidden = true
        window.rootViewController = nil
    }

    func testDelayedActionTaskCannotCommitAfterSessionSwitchOrViewExit() async {
        let eventID = UUID()
        let action = EventDetailServerAction.checkIn(registrationID: UUID())
        let context = EventDetailActionTaskContext(
            sessionFingerprint: "session-a",
            eventID: eventID,
            action: action
        )
        let state = EventDetailActionContextTestState(
            sessionFingerprint: "session-a",
            activeContext: context
        )

        let switchedSessionTask = Task { @MainActor in
            await Task.yield()
            return EventDetailActionTaskContextPolicy.isCurrent(
                context,
                sessionFingerprint: state.sessionFingerprint,
                eventID: eventID,
                activeContext: state.activeContext
            )
        }
        state.sessionFingerprint = "session-b"
        let switchedSessionMayCommit = await switchedSessionTask.value
        XCTAssertFalse(switchedSessionMayCommit)

        state.sessionFingerprint = "session-a"
        state.activeContext = context
        let exitedViewTask = Task { @MainActor in
            await Task.yield()
            return EventDetailActionTaskContextPolicy.isCurrent(
                context,
                sessionFingerprint: state.sessionFingerprint,
                eventID: eventID,
                activeContext: state.activeContext
            )
        }
        state.activeContext = nil
        let exitedViewMayCommit = await exitedViewTask.value
        XCTAssertFalse(exitedViewMayCommit)

        let replacementEpoch = EventDetailActionTaskContext(
            sessionFingerprint: "session-a",
            eventID: eventID,
            action: action
        )
        XCTAssertFalse(
            EventDetailActionTaskContextPolicy.isCurrent(
                context,
                sessionFingerprint: "session-a",
                eventID: eventID,
                activeContext: replacementEpoch
            ),
            "A completed task from an older epoch must not commit into a newer task"
        )
    }

    func testPosterEntryIsRestrictedToTheOrganizer() throws {
        let event = try makeEvent()

        XCTAssertTrue(
            EventDetailServerActionPolicy.canGeneratePoster(
                event: event,
                viewerID: event.organizerId
            )
        )
        XCTAssertFalse(
            EventDetailServerActionPolicy.canGeneratePoster(
                event: event,
                viewerID: UUID()
            )
        )
        XCTAssertFalse(
            EventDetailServerActionPolicy.canGeneratePoster(
                event: event,
                viewerID: nil
            )
        )
    }

    func testAttributedShareUsesTheServerLinkAndFallsBackWithoutCredentialsOrOnFailure() async throws {
        let event = try makeEvent()
        let attributed = URL(string: "https://spott.jp/s/attributed")!
        var requestCount = 0

        let authenticated = await EventShareDestinationPolicy.resolve(
            event: event,
            authenticated: true
        ) {
            requestCount += 1
            return attributed
        }
        XCTAssertEqual(authenticated, attributed)
        XCTAssertEqual(requestCount, 1)

        let guest = await EventShareDestinationPolicy.resolve(
            event: event,
            authenticated: false
        ) {
            requestCount += 1
            return attributed
        }
        XCTAssertEqual(guest, URL(string: "https://spott.jp/e/event"))
        XCTAssertEqual(requestCount, 1)

        let failed = await EventShareDestinationPolicy.resolve(
            event: event,
            authenticated: true
        ) {
            requestCount += 1
            throw URLError(.notConnectedToInternet)
        }
        XCTAssertEqual(failed, URL(string: "https://spott.jp/e/event"))
        XCTAssertEqual(requestCount, 2)
    }

    func testEventShareItemCarriesTheEventTitleAsTheActivitySubject() {
        let item = EventShareItem(
            url: URL(string: "https://spott.jp/e/event")!,
            subject: "Harbor walk"
        )

        XCTAssertEqual(item.subject, "Harbor walk")
    }

    func testCheckInRegistrationLookupFollowsEveryCursorUntilTheExactEventRegistration() async throws {
        let eventID = UUID()
        let targetID = UUID()
        let unrelated = makeRegistration(id: UUID(), eventID: UUID())
        let target = makeRegistration(id: targetID, eventID: eventID)
        var requestedCursors: [String?] = []

        let result = try await EventDetailRegistrationLookup.find(
            registrationID: targetID,
            eventID: eventID
        ) { cursor, limit in
            requestedCursors.append(cursor)
            XCTAssertEqual(limit, 100)
            if cursor == nil {
                return CursorPage(items: [unrelated], nextCursor: "page-2", hasMore: true)
            }
            return CursorPage(items: [target], nextCursor: nil, hasMore: false)
        }

        XCTAssertEqual(result?.id, targetID)
        XCTAssertEqual(requestedCursors, [nil, "page-2"])
    }

    func testCheckInRegistrationLookupRejectsMissingBlankRepeatedAndCyclicCursors() async {
        let empty = CursorPage<Registration>(items: [], nextCursor: nil, hasMore: true)
        let blank = CursorPage<Registration>(items: [], nextCursor: "   ", hasMore: true)
        await assertInvalidRegistrationCursor([empty])
        await assertInvalidRegistrationCursor([blank])
        await assertInvalidRegistrationCursor([
            CursorPage(items: [], nextCursor: "same", hasMore: true),
            CursorPage(items: [], nextCursor: "same", hasMore: true),
        ])
        await assertInvalidRegistrationCursor([
            CursorPage(items: [], nextCursor: "a", hasMore: true),
            CursorPage(items: [], nextCursor: "b", hasMore: true),
            CursorPage(items: [], nextCursor: "a", hasMore: true),
        ])
    }

    func testCheckInRegistrationLookupRejectsTheSameRegistrationIDFromAnotherEvent() async throws {
        let registrationID = UUID()
        let expectedEventID = UUID()
        let wrongEventRegistration = makeRegistration(
            id: registrationID,
            eventID: UUID()
        )

        let result = try await EventDetailRegistrationLookup.find(
            registrationID: registrationID,
            eventID: expectedEventID
        ) { _, _ in
            CursorPage(
                items: [wrongEventRegistration],
                nextCursor: nil,
                hasMore: false
            )
        }

        XCTAssertNil(result)
    }

    func testInvalidRegistrationCursorMapsToAnAccurateNonNetworkErrorInThreeLanguages() {
        let errors = ["zh-Hans", "ja", "en"].map {
            EventDetailRegistrationLookupError.invalidCursor.userFacing(
                locale: Locale(identifier: $0)
            )
        }

        XCTAssertTrue(errors.allSatisfy { $0.id == "REGISTRATION_CURSOR_INVALID" })
        XCTAssertTrue(errors.allSatisfy { !$0.retryable })
        XCTAssertEqual(Set(errors.map(\.message)).count, 3)
    }

    func testMissingCheckInItineraryMapsToAnAccurateWarningInThreeLanguages() {
        let errors = ["zh-Hans", "ja", "en"].map {
            EventDetailRegistrationLookupError.missing.userFacing(
                locale: Locale(identifier: $0)
            )
        }

        XCTAssertTrue(errors.allSatisfy { $0.id == "REGISTRATION_NOT_FOUND" })
        XCTAssertTrue(errors.allSatisfy { !$0.retryable })
        XCTAssertEqual(Set(errors.map(\.message)).count, 3)
    }

    func testCancellationSyncOutcomeDistinguishesAConfirmedRefreshFromARefreshFailure() {
        XCTAssertEqual(
            EventCancellationSyncPolicy.outcome(
                viewerSnapshotIsCurrent: true,
                refreshError: nil
            ),
            .synced
        )
        XCTAssertEqual(
            EventCancellationSyncPolicy.outcome(
                viewerSnapshotIsCurrent: false,
                refreshError: .init(id: "OFFLINE", message: "offline", retryable: true)
            ),
            .refreshFailed
        )
    }

    func testPosterPresentationNormalizesInjectedLocaleAndLocalizesEverySurface() {
        XCTAssertEqual(
            EventPosterPresentation(locale: Locale(identifier: "zh-CN")).backendLocaleIdentifier,
            "zh-Hans"
        )
        XCTAssertEqual(
            EventPosterPresentation(locale: Locale(identifier: "ja-JP")).backendLocaleIdentifier,
            "ja"
        )
        XCTAssertEqual(
            EventPosterPresentation(locale: Locale(identifier: "en-US")).backendLocaleIdentifier,
            "en"
        )
        XCTAssertEqual(
            EventPosterPresentation(locale: Locale(identifier: "fr-FR")).backendLocaleIdentifier,
            "en"
        )

        let keys: [String.LocalizationValue] = [
            "journey.poster.menu",
            "journey.poster.hero",
            "journey.poster.share",
            "journey.poster.style",
            "journey.poster.template.tokyo_afterglow",
            "journey.poster.template.night_transit",
            "journey.poster.template.paper_lantern",
            "journey.poster.status.queued",
            "journey.poster.status.processing",
            "journey.poster.status.failed",
            "journey.poster.status.choose",
            "journey.poster.generate",
            "journey.poster.privacy",
            "journey.poster.title",
            "journey.poster.close",
        ]
        let locales = ["zh-Hans", "ja", "en"].map(Locale.init(identifier:))
        for key in keys {
            let values = locales.map { EventPosterPresentation(locale: $0).text(key) }
            XCTAssertTrue(values.allSatisfy { !$0.isEmpty })
            XCTAssertEqual(Set(values).count, 3, "Expected distinct copy for \(key)")
        }
    }

    func testEveryServerActionHasLocalizedNativeCopyInThreeLanguages() {
        let registrationID = UUID(uuidString: "019b0000-0000-7000-8100-000000000099")!
        let groupID = UUID(uuidString: "019b0000-0000-7000-8100-000000000066")!
        let actions: [EventDetailServerAction] = [
            .checkIn(registrationID: registrationID),
            .openGroup(groupID: groupID),
            .cancelRegistration(registrationID: registrationID),
        ]
        let locales = ["zh-Hans", "ja", "en"].map(Locale.init(identifier:))

        for action in actions {
            let presentations = locales.map {
                EventDetailServerActionPresentation(action: action, locale: $0)
            }
            XCTAssertTrue(presentations.allSatisfy { !$0.title.isEmpty })
            XCTAssertEqual(Set(presentations.map(\.title)).count, 3)
        }
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

    private func makeRegistration(id: UUID, eventID: UUID) -> Registration {
        Registration(
            id: id,
            eventId: eventID,
            userId: UUID(),
            status: "confirmed",
            partySize: 1,
            attendeeNote: nil,
            availableActions: [.checkIn],
            version: 1,
            offerExpiresAt: nil,
            updatedAt: now,
            rewardPoints: nil,
            checkinMethod: nil
        )
    }

    private func assertInvalidRegistrationCursor(
        _ pages: [CursorPage<Registration>]
    ) async {
        var index = 0
        do {
            _ = try await EventDetailRegistrationLookup.find(
                registrationID: UUID(),
                eventID: UUID()
            ) { _, _ in
                defer { index += 1 }
                return pages[min(index, pages.count - 1)]
            }
            XCTFail("Expected an invalid cursor failure")
        } catch EventDetailRegistrationLookupError.invalidCursor {
            // Expected fail-closed result.
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }

    private func assertEventually(
        _ condition: @escaping @MainActor () -> Bool,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        for _ in 0..<100 where !condition() {
            await Task.yield()
        }
        XCTAssertTrue(condition(), file: file, line: line)
    }

    private func yieldRepeatedly() async {
        for _ in 0..<20 { await Task.yield() }
    }

    private func makeEventDetailHostModel() -> AppModel {
        let persistence = PersistenceStore.makeInMemory()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [EventDetailHostURLProtocol.self]
        let api = SpottAPIClient(
            environment: .init(baseURL: URL(string: "https://api.spott.test/v1")!),
            credentials: CredentialVault(
                service: "jp.spott.event-detail-host.\(UUID().uuidString)"
            ),
            session: URLSession(configuration: configuration)
        )
        return AppModel(
            api: api,
            analytics: AnalyticsClient(environment: .preview),
            persistence: persistence,
            sync: SyncEngine(api: api, persistence: persistence),
            router: AppRouter()
        )
    }

    private var genericActionErrorScenarios: [EventDetailActionErrorScenario] {
        [
            .init(
                name: "vault-status",
                error: VaultError.status(-34_018),
                id: "SECURE_SESSION_UNAVAILABLE",
                retryable: true,
                messages: [
                    "zh-Hans": "无法读取此设备上的登录信息。你仍可浏览公开活动，请稍后重试。",
                    "ja": "このデバイスのログイン情報を読み込めません。公開イベントは引き続き閲覧できます。しばらくしてからもう一度お試しください。",
                    "en": "Unable to read sign-in information on this device. You can still browse public events. Try again later.",
                ]
            ),
            .init(
                name: "vault-invalid-session",
                error: VaultError.invalidSession,
                id: "SECURE_SESSION_INVALID",
                retryable: false,
                messages: [
                    "zh-Hans": "此设备上的登录信息已失效。你仍可浏览公开活动，请重新登录。",
                    "ja": "このデバイスのログイン情報は無効になりました。公開イベントは引き続き閲覧できます。もう一度ログインしてください。",
                    "en": "Sign-in information on this device is no longer valid. You can still browse public events. Sign in again.",
                ]
            ),
            .api(
                name: "challenge-expired",
                status: 400,
                code: "CHALLENGE_EXPIRED",
                retryable: false,
                messages: [
                    "zh-Hans": "验证码已过期，请重新获取。",
                    "ja": "認証コードの有効期限が切れました。新しいコードを取得してください。",
                    "en": "That verification code has expired. Request a new code.",
                ]
            ),
            .api(
                name: "rate-limited",
                status: 429,
                code: "OTP_RATE_LIMITED",
                retryable: true,
                messages: [
                    "zh-Hans": "尝试次数过多，请稍后再试。",
                    "ja": "試行回数が多すぎます。しばらくしてからもう一度お試しください。",
                    "en": "Too many attempts. Wait a moment and try again.",
                ]
            ),
            .api(
                name: "credential-invalid",
                status: 400,
                code: "AUTH_CREDENTIAL_INVALID",
                retryable: false,
                messages: [
                    "zh-Hans": "验证码或登录凭证不正确，请重新检查。",
                    "ja": "認証コードまたはログイン情報が正しくありません。もう一度確認してください。",
                    "en": "The verification code or sign-in credential is incorrect. Check it and try again.",
                ]
            ),
            .api(
                name: "phone-conflict",
                status: 409,
                code: "PHONE_BINDING_CONFLICT",
                retryable: false,
                messages: [
                    "zh-Hans": "此手机号已绑定其他账号。",
                    "ja": "この電話番号は別のアカウントに登録されています。",
                    "en": "That phone number is linked to another account.",
                ]
            ),
            .api(
                name: "session-expired",
                status: 401,
                code: "TOKEN_EXPIRED",
                retryable: false,
                messages: [
                    "zh-Hans": "登录已过期，请重新登录。",
                    "ja": "ログインの有効期限が切れました。もう一度ログインしてください。",
                    "en": "Your session has expired. Sign in again.",
                ]
            ),
            .api(
                name: "content-changed",
                status: 409,
                code: "EVENT_CHANGED",
                retryable: true,
                messages: [
                    "zh-Hans": "内容已更新，请重新核对后继续。",
                    "ja": "内容が更新されました。もう一度確認してから続けてください。",
                    "en": "This information changed. Review it again before continuing.",
                ]
            ),
            .api(
                name: "login-required",
                status: 401,
                code: "AUTH_REQUIRED",
                retryable: false,
                messages: [
                    "zh-Hans": "请登录后继续。",
                    "ja": "ログインして続けてください。",
                    "en": "Sign in to continue.",
                ]
            ),
            .api(
                name: "permission-denied",
                status: 403,
                code: "NOT_ALLOWED",
                retryable: false,
                messages: [
                    "zh-Hans": "当前账号没有执行此操作的权限。",
                    "ja": "このアカウントには、この操作を行う権限がありません。",
                    "en": "This account does not have permission to perform that action.",
                ]
            ),
            .api(
                name: "content-unavailable",
                status: 404,
                code: "EVENT_NOT_FOUND",
                retryable: false,
                messages: [
                    "zh-Hans": "内容不存在或已下线。",
                    "ja": "この内容は存在しないか、公開を終了しています。",
                    "en": "This content does not exist or is no longer available.",
                ]
            ),
            .api(
                name: "generic-api",
                status: 500,
                code: "SERVER_FAILURE",
                retryable: true,
                messages: [
                    "zh-Hans": "操作暂时无法完成，请重试。",
                    "ja": "現在この操作を完了できません。もう一度お試しください。",
                    "en": "That action could not be completed. Try again.",
                ]
            ),
            .init(
                name: "network",
                error: URLError(.notConnectedToInternet),
                id: "NETWORK_UNAVAILABLE",
                retryable: true,
                messages: [
                    "zh-Hans": "暂时无法连接 Spott，请检查网络后重试。",
                    "ja": "Spottに接続できません。ネットワークを確認して、もう一度お試しください。",
                    "en": "Unable to connect to Spott. Check your network and try again.",
                ]
            ),
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

@MainActor
private final class EventDetailActionSnapshotSequence {
    private let authorized: EventDetailActionRunner.Snapshot
    private let revoked: EventDetailActionRunner.Snapshot
    private let authorizedReadCount: Int
    private var readCount = 0

    init(
        authorized: EventDetailActionRunner.Snapshot,
        revoked: EventDetailActionRunner.Snapshot,
        authorizedReadCount: Int
    ) {
        self.authorized = authorized
        self.revoked = revoked
        self.authorizedReadCount = authorizedReadCount
    }

    func next() -> EventDetailActionRunner.Snapshot {
        defer { readCount += 1 }
        return readCount < authorizedReadCount ? authorized : revoked
    }
}

@MainActor
private final class EventDetailActionSnapshotBox {
    var value: EventDetailActionRunner.Snapshot

    init(_ value: EventDetailActionRunner.Snapshot) {
        self.value = value
    }
}

@MainActor
private final class EventDetailActionEffectRecorder {
    private(set) var effects: [EventDetailActionRunner.Effect] = []

    func record(_ effect: EventDetailActionRunner.Effect) {
        effects.append(effect)
    }

    var bannerErrors: [UserFacingError] {
        effects.compactMap {
            guard case .banner(let error) = $0 else { return nil }
            return error
        }
    }

    var cancellationOutcomes: [EventCancellationSyncOutcome] {
        effects.compactMap {
            guard case .cancellationFinished(let outcome) = $0 else { return nil }
            return outcome
        }
    }
}

@MainActor
private final class EventDetailActionContinuation<Value: Sendable> {
    private var continuation: CheckedContinuation<Value, Error>?
    private(set) var started = false

    func value() async throws -> Value {
        started = true
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
        }
    }

    func resume(returning value: sending Value) {
        continuation?.resume(returning: value)
        continuation = nil
    }

    func resume(throwing error: Error) {
        continuation?.resume(throwing: error)
        continuation = nil
    }
}

private enum EventDetailRunnerTestError: Error {
    case lateFailure
}

private struct EventDetailActionErrorScenario {
    let name: String
    let error: any Error
    let id: String
    let retryable: Bool
    let messages: [String: String]

    static func api(
        name: String,
        status: Int,
        code: String,
        retryable: Bool,
        messages: [String: String]
    ) -> Self {
        .init(
            name: name,
            error: APIError(
                status: status,
                code: code,
                message: "Untrusted server copy",
                retryable: retryable
            ),
            id: code,
            retryable: retryable,
            messages: messages
        )
    }
}

private extension Collection {
    var only: Element? {
        count == 1 ? first : nil
    }
}

@MainActor
@Observable
private final class EventDetailScreenVisibility {
    var isVisible = true
}

@MainActor
private struct EventDetailScreenHost: View {
    @Bindable var visibility: EventDetailScreenVisibility
    let event: EventSummary
    let runner: EventDetailActionRunner
    let model: AppModel

    var body: some View {
        if visibility.isVisible {
            NavigationStack {
                EventDetailView(
                    event: event,
                    sourceTab: .discovery,
                    refreshOnAppear: false,
                    initialViewerSnapshotIsCurrent: true,
                    actionRunner: runner
                )
            }
            .environment(model)
        }
    }
}

private final class EventDetailHostURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
    }

    override func stopLoading() { }
}

@MainActor
private final class EventDetailActionContextTestState {
    var sessionFingerprint: String
    var activeContext: EventDetailActionTaskContext?

    init(
        sessionFingerprint: String,
        activeContext: EventDetailActionTaskContext?
    ) {
        self.sessionFingerprint = sessionFingerprint
        self.activeContext = activeContext
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
