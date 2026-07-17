import Foundation
import XCTest
@testable import Spott

final class EventCTAStateTests: XCTestCase {
    private let now = ISO8601DateFormatter().date(from: "2026-07-16T00:00:00Z")!
    private let registrationID = "019b0000-0000-7000-8100-000000000099"

    func testOrderedRulesMatchTheSharedTwelveRuleTable() throws {
        let activeOffer = viewerRegistration(status: "offered", expiry: "2026-07-16T00:10:00Z")
        let cases: [(String, [String: Any], EventCTASession, EventCTAState)] = [
            (
                "1 unavailable wins before an offer",
                ["status": "cancelled", "viewerRegistration": activeOffer],
                .verified,
                .init(kind: .eventUnavailable, intent: .none, disabled: true)
            ),
            (
                "2 active waitlist offer",
                ["viewerRegistration": activeOffer],
                .verified,
                .init(
                    kind: .acceptWaitlist,
                    intent: .acceptWaitlist,
                    disabled: false,
                    registrationId: registrationID,
                    offerExpiresAt: ISO8601DateFormatter().date(from: "2026-07-16T00:10:00Z")
                )
            ),
            (
                "3 confirmed itinerary",
                ["deadlineAt": "2026-07-15T00:00:00Z", "viewerRegistration": viewerRegistration(status: "confirmed")],
                .verified,
                .init(kind: .viewItinerary, intent: .itinerary, disabled: false, registrationId: registrationID)
            ),
            (
                "3 checked-in itinerary",
                ["viewerRegistration": viewerRegistration(status: "checked_in")],
                .verified,
                .init(kind: .viewItinerary, intent: .itinerary, disabled: false, registrationId: registrationID)
            ),
            (
                "4 pending itinerary",
                ["viewerRegistration": viewerRegistration(status: "pending")],
                .verified,
                .init(kind: .viewPending, intent: .itinerary, disabled: false, registrationId: registrationID)
            ),
            (
                "5 waitlist itinerary",
                ["viewerRegistration": viewerRegistration(status: "waitlisted")],
                .verified,
                .init(kind: .viewWaitlist, intent: .itinerary, disabled: false, registrationId: registrationID)
            ),
            (
                "6 guest login",
                ["availableActions": []],
                .guest,
                .init(kind: .continueLogin, intent: .login, disabled: false)
            ),
            (
                "7 phone verification",
                ["availableActions": []],
                .unverified,
                .init(kind: .continuePhoneVerification, intent: .phoneVerification, disabled: false)
            ),
            (
                "8 explicit closed status",
                ["status": "registration_closed", "availableActions": ["register"]],
                .verified,
                .init(kind: .registrationClosed, intent: .none, disabled: true)
            ),
            (
                "8 expired deadline",
                ["deadlineAt": "2026-07-16T00:00:00Z"],
                .verified,
                .init(kind: .registrationClosed, intent: .none, disabled: true)
            ),
            (
                "8 closed server action set",
                ["availableActions": []],
                .verified,
                .init(kind: .registrationClosed, intent: .none, disabled: true)
            ),
            (
                "9 join waitlist",
                ["confirmedCount": 8, "availableCapacity": 0, "availableActions": ["joinWaitlist"]],
                .verified,
                .init(kind: .joinWaitlist, intent: .register, disabled: false)
            ),
            (
                "10 full closed",
                ["confirmedCount": 10, "availableCapacity": 0, "waitlistEnabled": false, "availableActions": []],
                .verified,
                .init(kind: .fullClosed, intent: .none, disabled: true)
            ),
            (
                "11 approval application",
                ["registrationMode": "approval", "availableActions": ["register"]],
                .verified,
                .init(kind: .apply, intent: .register, disabled: false)
            ),
            (
                "12 registration",
                [:],
                .verified,
                .init(kind: .register, intent: .register, disabled: false)
            ),
            (
                "fallback",
                ["availableActions": ["joinWaitlist"]],
                .verified,
                .init(kind: .registrationClosed, intent: .none, disabled: true)
            ),
            (
                "expired offer",
                [
                    "confirmedCount": 10,
                    "availableCapacity": 0,
                    "availableActions": ["joinWaitlist"],
                    "viewerRegistration": viewerRegistration(status: "offered", expiry: "2026-07-15T23:59:59Z"),
                ],
                .verified,
                .init(kind: .joinWaitlist, intent: .register, disabled: false)
            ),
        ]

        for (name, overrides, session, expected) in cases {
            XCTAssertEqual(
                EventCTAState.resolve(event: try makeEvent(overrides), session: session, now: now),
                expected,
                name
            )
        }
    }

    func testEveryUnavailableStatusIsTerminal() throws {
        for status in ["cancelled", "ended", "removed"] {
            XCTAssertEqual(
                EventCTAState.resolve(event: try makeEvent(["status": status]), session: .verified, now: now),
                .init(kind: .eventUnavailable, intent: .none, disabled: true)
            )
        }
    }

    func testOfferAtOrPastExpiryNeverRemainsAcceptableAndFallsBackToServerActions() throws {
        let boundaryOffer = viewerRegistration(
            status: "offered",
            expiry: "2026-07-16T00:00:00Z"
        )
        let boundary = EventCTAState.resolve(
            event: try makeEvent([
                "viewerRegistration": boundaryOffer,
                "availableActions": ["register"],
            ]),
            session: .verified,
            now: now
        )

        XCTAssertEqual(boundary, .init(kind: .register, intent: .register, disabled: false))

        let missingExpiry = EventCTAState.resolve(
            event: try makeEvent([
                "viewerRegistration": viewerRegistration(status: "offered"),
                "confirmedCount": 10,
                "availableCapacity": 0,
                "availableActions": ["joinWaitlist"],
            ]),
            session: .verified,
            now: now
        )

        XCTAssertEqual(
            missingExpiry,
            .init(kind: .joinWaitlist, intent: .register, disabled: false)
        )
    }

    func testExpiredOfferDoesNotInventAnActionWhenTheServerProvidesNone() throws {
        let state = EventCTAState.resolve(
            event: try makeEvent([
                "viewerRegistration": viewerRegistration(
                    status: "offered",
                    expiry: "2026-07-15T23:59:59Z"
                ),
                "confirmedCount": 10,
                "availableCapacity": 0,
                "waitlistEnabled": false,
                "availableActions": [],
            ]),
            session: .verified,
            now: now
        )

        XCTAssertEqual(state, .init(kind: .fullClosed, intent: .none, disabled: true))
    }

    private func makeEvent(_ overrides: [String: Any]) throws -> EventSummary {
        let data = try JSONSerialization.data(withJSONObject: eventPayload(overrides: overrides))
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(EventSummary.self, from: data)
    }

    private func viewerRegistration(status: String, expiry: String? = nil) -> [String: Any] {
        [
            "id": registrationID,
            "status": status,
            "partySize": 1,
            "offerExpiresAt": expiry ?? NSNull(),
        ]
    }
}
