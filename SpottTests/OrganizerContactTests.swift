import Foundation
import XCTest
@testable import Spott

final class OrganizerContactTests: XCTestCase {
    private let organizerID = UUID(uuidString: "019b0000-0000-7000-8100-000000000010")!
    private let attendeeID = UUID(uuidString: "019b0000-0000-7000-8100-000000000020")!

    func testOrganizerContactDecodesEverySupportedContractVariant() throws {
        let expectations: [([String: Any], OrganizerContact.Kind, URL)] = [
            (
                ["kind": "email", "label": "当日联系", "value": "host@example.com"],
                .email,
                URL(string: "mailto:host@example.com")!
            ),
            (
                ["kind": "line", "label": NSNull(), "value": "weekend_host"],
                .line,
                URL(string: "https://line.me/R/ti/p/~weekend_host")!
            ),
            (
                ["kind": "website", "label": "活动帮助页", "value": "https://example.com/help"],
                .website,
                URL(string: "https://example.com/help")!
            ),
        ]

        for (payload, kind, expectedURL) in expectations {
            let event = try decodeEvent(contact: payload)

            XCTAssertEqual(event.organizerContact?.kind, kind)
            XCTAssertEqual(event.organizerContact?.actionURL, expectedURL)
        }
    }

    func testOrganizerContactRejectsUnknownKindsAndNonHTTPSWebsites() {
        XCTAssertThrowsError(
            try decodeEvent(contact: [
                "kind": "sms",
                "label": NSNull(),
                "value": "+819012345678",
            ])
        )
        XCTAssertThrowsError(
            try decodeEvent(contact: [
                "kind": "website",
                "label": NSNull(),
                "value": "http://example.com/help",
            ])
        )
    }

    func testOrganizerContactRejectsMailtoInjectionAndWebsiteCredentials() {
        let injectedEmails = [
            "host?subject=x@example.com",
            "host#fragment@example.com",
            "host&bcc=x@example.com",
            "host%0Abcc@example.com",
            "host/name@example.com",
            "host:name@example.com",
            "host;name@example.com",
            ".host@example.com",
            "host..team@example.com",
            "host\nBcc:attacker@example.com",
        ]

        for value in injectedEmails {
            XCTAssertThrowsError(
                try OrganizerContact(kind: .email, label: nil, value: value),
                value
            )
        }
        XCTAssertThrowsError(
            try OrganizerContact(
                kind: .website,
                label: nil,
                value: "https://user:password@example.com/help"
            )
        )

        for value in [
            "https://example.com/help bad",
            "https://example.com/help\nnext",
            "https://example.com/help?next=%0D%0AInjected:yes",
            "https://example.com/%00hidden",
        ] {
            XCTAssertThrowsError(
                try OrganizerContact(kind: .website, label: nil, value: value),
                value
            )
        }
    }

    func testEmailActionURLIsBuiltWithoutQueryOrFragmentComponents() throws {
        let contact = try OrganizerContact(
            kind: .email,
            label: nil,
            value: "host.team+tokyo@example.com"
        )
        let components = try XCTUnwrap(
            URLComponents(url: try XCTUnwrap(contact.actionURL), resolvingAgainstBaseURL: false)
        )

        XCTAssertEqual(components.scheme, "mailto")
        XCTAssertNil(components.query)
        XCTAssertNil(components.fragment)
        XCTAssertEqual(components.path, "host.team+tokyo@example.com")
    }

    func testDiscoverySanitizationAlwaysStripsOrganizerContact() throws {
        let event = try decodeEvent(contact: emailContact)

        XCTAssertNotNil(event.organizerContact)
        XCTAssertNil(event.discoverySafeSummary.organizerContact)
    }

    func testDiscoverySanitizationStripsEveryViewerAndPrivateField() throws {
        let event = try decodeEvent(
            contact: emailContact,
            viewerStatus: "confirmed",
            overrides: [
                "favorited": true,
                "registrationStatus": "confirmed",
                "availableActions": ["cancelRegistration", "viewTicket"],
                "exactAddress": "1-2-3 private address",
                "coordinate": [
                    "latitude": 35.6812,
                    "longitude": 139.7671,
                    "precision": "exact",
                ],
                "organizer": [
                    "id": organizerID.uuidString.lowercased(),
                    "name": "Host",
                    "handle": "host",
                    "viewerFollowing": true,
                    "trust": [
                        "phoneVerified": true,
                        "completedEventCount": 18,
                        "attendanceRateBand": "90_plus",
                    ],
                ],
                "attendeeRequirements": "private requirement",
                "riskFlags": ["night"],
                "riskDetails": ["night": "private details"],
                "checkinMode": "dynamic_qr",
                "commentPermission": "participants",
                "posterEnabled": true,
                "exactAddressVisibility": "confirmed",
            ]
        )

        let safe = event.discoverySafeSummary

        XCTAssertNil(safe.organizerContact)
        XCTAssertNil(safe.viewerRegistration)
        XCTAssertNil(safe.registrationStatus)
        XCTAssertFalse(safe.favorited)
        XCTAssertTrue(safe.availableActions.isEmpty)
        XCTAssertFalse(safe.organizer.viewerFollowing)
        XCTAssertNil(safe.exactAddress)
        XCTAssertNil(safe.coordinate)
        XCTAssertNil(safe.attendeeRequirements)
        XCTAssertNil(safe.riskFlags)
        XCTAssertNil(safe.riskDetails)
        XCTAssertNil(safe.checkinMode)
        XCTAssertNil(safe.commentPermission)
        XCTAssertNil(safe.posterEnabled)
        XCTAssertNil(safe.exactAddressVisibility)
    }

    func testRoutedEventPresentationNeutralizesAnOldAccountSnapshotBeforeTaskRuns() throws {
        let oldAccountEvent = try decodeEvent(
            contact: emailContact,
            viewerStatus: "confirmed",
            overrides: [
                "favorited": true,
                "registrationStatus": "confirmed",
                "availableActions": ["viewTicket"],
            ]
        )

        let presentation = RoutedEventSnapshotPresentation.resolve(
            event: oldAccountEvent,
            boundLoadIdentity: "route-a-session-a-user-a",
            currentLoadIdentity: "route-a-session-b-user-b",
            isAuthoritative: true
        )

        XCTAssertFalse(presentation.isCurrent)
        XCTAssertNil(presentation.event?.organizerContact)
        XCTAssertNil(presentation.event?.viewerRegistration)
        XCTAssertNil(presentation.event?.registrationStatus)
        XCTAssertFalse(presentation.event?.favorited == true)
        XCTAssertTrue(presentation.event?.availableActions.isEmpty == true)
    }

    func testRoutedEventPresentationKeepsFreshBoundSnapshotAuthoritative() throws {
        let currentEvent = try decodeEvent(
            contact: emailContact,
            viewerStatus: "confirmed"
        )

        let presentation = RoutedEventSnapshotPresentation.resolve(
            event: currentEvent,
            boundLoadIdentity: "route-a-session-a-user-a",
            currentLoadIdentity: "route-a-session-a-user-a",
            isAuthoritative: true
        )

        XCTAssertTrue(presentation.isCurrent)
        XCTAssertEqual(presentation.event?.organizerContact, currentEvent.organizerContact)
    }

    func testRoutedEventPresentationNeutralizesOldRouteBeforeTaskRunsInSameSession() throws {
        let routeAEvent = try decodeEvent(
            contact: emailContact,
            viewerStatus: "confirmed"
        )

        let presentation = RoutedEventSnapshotPresentation.resolve(
            event: routeAEvent,
            boundLoadIdentity: "route-a-session-a-user-a",
            currentLoadIdentity: "route-b-session-a-user-a",
            isAuthoritative: true
        )

        XCTAssertFalse(presentation.isCurrent)
        XCTAssertNil(presentation.event?.organizerContact)
        XCTAssertNil(presentation.event?.viewerRegistration)
    }

    func testRoutedEventResponseMustMatchIDOrSlugBeforeCaching() throws {
        let event = try decodeEvent(
            contact: emailContact,
            overrides: ["publicSlug": "expected-slug"]
        )

        XCTAssertTrue(
            RoutedEventSnapshotPresentation.response(
                event,
                matches: .init(id: event.id, slug: "ignored-slug")
            )
        )
        XCTAssertFalse(
            RoutedEventSnapshotPresentation.response(
                event,
                matches: .init(id: UUID(), slug: "expected-slug")
            )
        )
        XCTAssertTrue(
            RoutedEventSnapshotPresentation.response(
                event,
                matches: .init(id: nil, slug: "expected-slug")
            )
        )
        XCTAssertFalse(
            RoutedEventSnapshotPresentation.response(
                event,
                matches: .init(id: nil, slug: "wrong-slug")
            )
        )
        XCTAssertTrue(
            RoutedEventSnapshotPresentation.response(
                event,
                matches: .init(id: nil, slug: event.id.uuidString.lowercased())
            )
        )
    }

    func testEventDetailDisclosesContactOnlyToOrganizerOrConfirmedParticipant() throws {
        for status in ["pending", "waitlisted", "offered"] {
            let event = try decodeEvent(contact: emailContact, viewerStatus: status)
            XCTAssertNil(
                OrganizerContactDisclosurePolicy.contactForEventDetail(
                    event: event,
                    viewerID: attendeeID,
                    viewerSnapshotIsCurrent: true
                ),
                status
            )
        }

        for status in ["confirmed", "checked_in"] {
            let event = try decodeEvent(contact: emailContact, viewerStatus: status)
            XCTAssertEqual(
                OrganizerContactDisclosurePolicy.contactForEventDetail(
                    event: event,
                    viewerID: attendeeID,
                    viewerSnapshotIsCurrent: true
                ),
                event.organizerContact,
                status
            )
        }

        let ownerEvent = try decodeEvent(contact: emailContact)
        XCTAssertEqual(
            OrganizerContactDisclosurePolicy.contactForEventDetail(
                event: ownerEvent,
                viewerID: organizerID,
                viewerSnapshotIsCurrent: false
            ),
            ownerEvent.organizerContact
        )
        XCTAssertNil(
            OrganizerContactDisclosurePolicy.contactForEventDetail(
                event: ownerEvent,
                viewerID: attendeeID,
                viewerSnapshotIsCurrent: true
            )
        )
    }

    func testStaleConfirmedViewerSnapshotNeverDisclosesContactToANewSession() throws {
        let staleEvent = try decodeEvent(contact: emailContact, viewerStatus: "confirmed")

        XCTAssertNil(
            OrganizerContactDisclosurePolicy.contactForEventDetail(
                event: staleEvent,
                viewerID: attendeeID,
                viewerSnapshotIsCurrent: false
            )
        )
    }

    func testGuestNeverReceivesConfirmedContactEvenFromACurrentMalformedSnapshot() throws {
        let malformedGuestEvent = try decodeEvent(
            contact: emailContact,
            viewerStatus: "confirmed"
        )

        XCTAssertNil(
            OrganizerContactDisclosurePolicy.contactForEventDetail(
                event: malformedGuestEvent,
                viewerID: nil,
                viewerSnapshotIsCurrent: true
            )
        )
    }

    func testConfirmationDisclosesContactOnlyForConfirmedOrCheckedInRegistration() throws {
        let event = try decodeEvent(contact: emailContact)

        for status in ["pending", "waitlisted", "offered", "cancelled"] {
            XCTAssertNil(
                OrganizerContactDisclosurePolicy.contactForConfirmation(
                    event: event,
                    registration: registration(event: event, status: status),
                    viewerID: attendeeID
                ),
                status
            )
        }

        for status in ["confirmed", "checked_in"] {
            XCTAssertEqual(
                OrganizerContactDisclosurePolicy.contactForConfirmation(
                    event: event,
                    registration: registration(event: event, status: status),
                    viewerID: attendeeID
                ),
                event.organizerContact,
                status
            )
        }

        var wrongEventRegistration = registration(event: event, status: "confirmed")
        wrongEventRegistration = Registration(
            id: wrongEventRegistration.id,
            eventId: UUID(),
            userId: wrongEventRegistration.userId,
            status: wrongEventRegistration.status,
            partySize: wrongEventRegistration.partySize,
            attendeeNote: wrongEventRegistration.attendeeNote,
            availableActions: wrongEventRegistration.availableActions,
            version: wrongEventRegistration.version,
            offerExpiresAt: wrongEventRegistration.offerExpiresAt,
            updatedAt: wrongEventRegistration.updatedAt,
            rewardPoints: wrongEventRegistration.rewardPoints,
            checkinMethod: wrongEventRegistration.checkinMethod
        )
        XCTAssertNil(
            OrganizerContactDisclosurePolicy.contactForConfirmation(
                event: event,
                registration: wrongEventRegistration,
                viewerID: attendeeID
            )
        )
        XCTAssertNil(
            OrganizerContactDisclosurePolicy.contactForConfirmation(
                event: event,
                registration: registration(event: event, status: "confirmed"),
                viewerID: UUID()
            ),
            "A confirmation belonging to another user must never reveal contact"
        )
        XCTAssertNil(
            OrganizerContactDisclosurePolicy.contactForConfirmation(
                event: event,
                registration: registration(event: event, status: "confirmed"),
                viewerID: nil
            ),
            "A signed-out confirmation must never reveal contact"
        )
    }

    private var emailContact: [String: Any] {
        ["kind": "email", "label": "当日联系", "value": "host@example.com"]
    }

    private func decodeEvent(
        contact: [String: Any],
        viewerStatus: String? = nil,
        overrides: [String: Any] = [:]
    ) throws -> EventSummary {
        var overrides = overrides
        overrides["organizerContact"] = contact
        if let viewerStatus {
            overrides["viewerRegistration"] = [
                "id": "019b0000-0000-7000-8100-000000000030",
                "status": viewerStatus,
                "partySize": 1,
                "offerExpiresAt": NSNull(),
            ]
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(
            EventSummary.self,
            from: JSONSerialization.data(
                withJSONObject: eventPayload(overrides: overrides)
            )
        )
    }

    private func registration(event: EventSummary, status: String) -> Registration {
        Registration(
            id: UUID(),
            eventId: event.id,
            userId: attendeeID,
            status: status,
            partySize: 1,
            attendeeNote: nil,
            availableActions: [],
            version: 1,
            offerExpiresAt: nil,
            updatedAt: nil,
            rewardPoints: nil,
            checkinMethod: nil
        )
    }
}
