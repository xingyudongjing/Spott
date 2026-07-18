import Foundation
import XCTest
@testable import Spott

final class EventComposerContactDraftTests: XCTestCase {
    func testContactDraftBuildsEverySupportedOrganizerContact() throws {
        let cases: [(
            kind: OrganizerContact.Kind,
            label: String,
            value: String,
            expectedLabel: String?,
            expectedValue: String
        )] = [
            (.email, " 当日联系 ", " Host@Example.COM ", "当日联系", "host@example.com"),
            (.line, "", " weekend_host ", nil, "weekend_host"),
            (.website, "活动帮助页", " https://example.com/help ", "活动帮助页", "https://example.com/help"),
        ]

        for item in cases {
            var draft = EventComposerContactDraft()
            draft.updateKind(item.kind)
            draft.updateLabel(item.label)
            draft.updateValue(item.value)

            let contact = try draft.contactForSubmission()

            XCTAssertEqual(contact.kind, item.kind)
            XCTAssertEqual(contact.label, item.expectedLabel)
            XCTAssertEqual(contact.value, item.expectedValue)
        }
    }

    func testContactDraftRejectsUnsafeOrMalformedWebsiteValues() {
        for value in [
            "http://example.com/help",
            "javascript:alert(1)",
            "https://",
            "https://user:password@example.com/help",
        ] {
            var draft = EventComposerContactDraft()
            draft.updateKind(.website)
            draft.updateValue(value)

            XCTAssertThrowsError(try draft.contactForSubmission(), value)
            XCTAssertNil(draft.contactForDraftSave(), value)
        }
    }

    func testBlankEarlySaveOmitsOrganizerContactFromDraftPayload() throws {
        let input = makeInput(organizerContact: nil)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(input)) as? [String: Any]
        )

        XCTAssertNil(object["organizerContact"])
    }

    func testValidOrganizerContactRoundTripsThroughDraftPayload() throws {
        let expected = try OrganizerContact(
            kind: .line,
            label: "当日 LINE",
            value: "weekend_host"
        )
        let input = makeInput(organizerContact: expected)
        let data = try JSONEncoder().encode(input)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        let contactObject = try XCTUnwrap(object["organizerContact"] as? [String: Any])

        XCTAssertEqual(contactObject["kind"] as? String, "line")
        XCTAssertEqual(contactObject["label"] as? String, "当日 LINE")
        XCTAssertEqual(contactObject["value"] as? String, "weekend_host")

        let decoded = try JSONDecoder().decode(EventDraftInput.self, from: data)
        XCTAssertEqual(decoded.organizerContact, expected)
    }

    func testAuthorizedCloudContactRestoresIntoAnUntouchedDraft() throws {
        let contact = try OrganizerContact(
            kind: .website,
            label: "参加者帮助",
            value: "https://example.com/attendees"
        )
        let event = try makeEvent(status: "draft", contact: contact)
        var draft = EventComposerContactDraft()

        let accepted = draft.reconcileAuthorizedResponse(
            event,
            expectedContact: false
        )

        XCTAssertTrue(accepted)
        XCTAssertEqual(draft.recoveryState, .ready)
        XCTAssertEqual(draft.kind, .website)
        XCTAssertEqual(draft.label, "参加者帮助")
        XCTAssertEqual(draft.value, "https://example.com/attendees")
        XCTAssertEqual(try draft.contactForSubmission(), contact)
    }

    func testAuthorizedResponseDoesNotOverwriteUnsavedContactEdits() throws {
        let cloudContact = try OrganizerContact(
            kind: .email,
            label: "Cloud",
            value: "cloud@example.com"
        )
        let event = try makeEvent(status: "draft", contact: cloudContact)
        var draft = EventComposerContactDraft()
        draft.updateKind(.line)
        draft.updateLabel("New LINE")
        draft.updateValue("new_host")

        XCTAssertTrue(
            draft.reconcileAuthorizedResponse(event, expectedContact: false)
        )
        XCTAssertEqual(draft.kind, .line)
        XCTAssertEqual(draft.label, "New LINE")
        XCTAssertEqual(draft.value, "new_host")
    }

    func testMismatchedSaveResponseFailsClosedBeforePublication() throws {
        let staleCloudContact = try OrganizerContact(
            kind: .email,
            label: "Old",
            value: "old@example.com"
        )
        let event = try makeEvent(status: "draft", contact: staleCloudContact)
        var draft = EventComposerContactDraft()
        draft.updateKind(.line)
        draft.updateLabel("New")
        draft.updateValue("new_host")

        XCTAssertFalse(
            draft.reconcileAuthorizedResponse(event, expectedContact: true)
        )
        XCTAssertEqual(draft.recoveryState, .failed)
        XCTAssertNil(draft.contactForDraftSave())
        XCTAssertThrowsError(try draft.contactForSubmission())
    }

    func testMissingExpectedAuthorizedContactFailsClosedWithoutClearingRemoteData() throws {
        let event = try makeEvent(status: "draft", contact: nil)
        var draft = EventComposerContactDraft()

        XCTAssertFalse(
            draft.reconcileAuthorizedResponse(event, expectedContact: true)
        )
        XCTAssertEqual(draft.recoveryState, .failed)
        XCTAssertNil(draft.contactForDraftSave())
        XCTAssertThrowsError(try draft.contactForSubmission()) { error in
            XCTAssertEqual(
                error as? EventComposerContactError,
                .authorizedContactUnavailable
            )
        }

        XCTAssertFalse(
            draft.reconcileAuthorizedResponse(event, expectedContact: false),
            "A retry without the authorized contact must remain fail closed"
        )
    }

    func testNewBlankCloudDraftMaySaveEarlyButCannotSubmitWithoutContact() throws {
        let event = try makeEvent(status: "draft", contact: nil)
        var draft = EventComposerContactDraft()

        XCTAssertTrue(
            draft.reconcileAuthorizedResponse(event, expectedContact: false)
        )
        XCTAssertEqual(draft.recoveryState, .blank)
        XCTAssertNil(draft.contactForDraftSave())
        XCTAssertThrowsError(try draft.contactForSubmission()) { error in
            XCTAssertEqual(error as? EventComposerContactError, .missing)
        }
    }

    func testEveryNonDraftResponseWithoutAuthorizedContactFailsClosed() throws {
        for status in ["in_review", "published", "needs_changes"] {
            let event = try makeEvent(status: status, contact: nil)
            var draft = EventComposerContactDraft()

            XCTAssertFalse(
                draft.reconcileAuthorizedResponse(event, expectedContact: false),
                "A \(status) response must never be treated as a new blank draft"
            )
            XCTAssertEqual(draft.recoveryState, .failed, status)
        }
    }

    func testDraftResponsePolicyRejectsAResponseForAnotherEvent() throws {
        let event = try makeEvent(status: "draft", contact: nil)
        let anotherEventID = UUID(
            uuidString: "019b0000-0000-7000-8100-000000000099"
        )!

        XCTAssertTrue(
            EventComposerDraftResponsePolicy.accepts(
                event,
                expectedID: event.id,
                expectedOrganizerID: event.organizerId
            )
        )
        XCTAssertFalse(
            EventComposerDraftResponsePolicy.accepts(
                event,
                expectedID: anotherEventID,
                expectedOrganizerID: event.organizerId
            ),
            "A same-contact response for another event must fail closed"
        )
    }

    func testDraftResponsePolicyRejectsAnotherOrganizersNewOrExistingDraft() throws {
        let event = try makeEvent(status: "draft", contact: nil)
        let anotherOrganizerID = UUID(
            uuidString: "019b0000-0000-7000-8100-000000000098"
        )!

        XCTAssertTrue(
            EventComposerDraftResponsePolicy.accepts(
                event,
                expectedID: nil,
                expectedOrganizerID: event.organizerId
            )
        )
        XCTAssertFalse(
            EventComposerDraftResponsePolicy.accepts(
                event,
                expectedID: nil,
                expectedOrganizerID: anotherOrganizerID
            )
        )
        XCTAssertFalse(
            EventComposerDraftResponsePolicy.accepts(
                event,
                expectedID: event.id,
                expectedOrganizerID: anotherOrganizerID
            )
        )
    }

    func testComposerContactCopyExistsInChineseJapaneseAndEnglish() {
        let expectations: [(String, String, String)] = [
            ("zh-Hans", "报名确认后的联系方式", "请填写主办方联系方式。"),
            ("ja", "参加確定後の連絡先", "主催者の連絡先を入力してください。"),
            ("en", "Contact after confirmation", "Add a host contact method."),
        ]

        for (identifier, title, missing) in expectations {
            let copy = EventComposerContactCopy(
                locale: Locale(identifier: identifier)
            )
            XCTAssertEqual(copy.title, title, identifier)
            XCTAssertEqual(copy.missingMessage, missing, identifier)
        }
    }

    func testComposerSessionPresentationRequiresMatchingSessionAndUser() {
        let sharedSessionID = UUID(
            uuidString: "019b0000-0000-7000-8100-000000000041"
        )!
        let firstUser = EventComposerSessionIdentity(
            sessionID: sharedSessionID,
            userID: UUID(
                uuidString: "019b0000-0000-7000-8100-000000000042"
            )!
        )
        let secondUser = EventComposerSessionIdentity(
            sessionID: sharedSessionID,
            userID: UUID(
                uuidString: "019b0000-0000-7000-8100-000000000043"
            )!
        )

        XCTAssertTrue(
            EventComposerSessionPresentation.canRenderSensitiveDraft(
                boundIdentity: firstUser,
                currentIdentity: firstUser
            )
        )
        XCTAssertFalse(
            EventComposerSessionPresentation.canRenderSensitiveDraft(
                boundIdentity: firstUser,
                currentIdentity: secondUser
            ),
            "The same session token must not authorize another user's draft"
        )
        XCTAssertFalse(
            EventComposerSessionPresentation.canRenderSensitiveDraft(
                boundIdentity: nil,
                currentIdentity: firstUser
            )
        )
        XCTAssertFalse(
            EventComposerSessionPresentation.canRenderSensitiveDraft(
                boundIdentity: firstUser,
                currentIdentity: nil
            )
        )
    }

    func testComposerRequestContextRejectsOldATaskAfterAToBToA() {
        let identityA = EventComposerSessionIdentity(
            sessionID: UUID(
                uuidString: "019b0000-0000-7000-8100-000000000061"
            )!,
            userID: UUID(
                uuidString: "019b0000-0000-7000-8100-000000000062"
            )!
        )
        let oldA = EventComposerRequestContext(identity: identityA, generation: 1)
        let currentA = EventComposerRequestContext(identity: identityA, generation: 3)

        XCTAssertFalse(
            EventComposerSessionPresentation.canAcceptResponse(
                oldA,
                boundIdentity: identityA,
                currentIdentity: identityA,
                currentGeneration: 3
            )
        )
        XCTAssertTrue(
            EventComposerSessionPresentation.canAcceptResponse(
                currentA,
                boundIdentity: identityA,
                currentIdentity: identityA,
                currentGeneration: 3
            )
        )
    }

    func testFailedOptionalRefreshCannotContinueAfterGenerationChanges() {
        let identityA = EventComposerSessionIdentity(
            sessionID: UUID(
                uuidString: "019b0000-0000-7000-8100-000000000071"
            )!,
            userID: UUID(
                uuidString: "019b0000-0000-7000-8100-000000000072"
            )!
        )
        let oldA = EventComposerRequestContext(
            identity: identityA,
            generation: 1
        )
        let failedResponse: EventSummary? = nil

        XCTAssertFalse(
            EventComposerOptionalResponsePolicy.canContinue(
                after: failedResponse,
                context: oldA,
                boundIdentity: identityA,
                currentIdentity: identityA,
                currentGeneration: 3
            ),
            "A failed optional refresh must still re-check generation before mutation"
        )
        XCTAssertTrue(
            EventComposerOptionalResponsePolicy.canContinue(
                after: failedResponse,
                context: oldA,
                boundIdentity: identityA,
                currentIdentity: identityA,
                currentGeneration: 1
            )
        )
    }

    private func makeInput(
        organizerContact: OrganizerContact?
    ) -> EventDraftInput {
        EventDraftInput(
            title: "东京周末散步",
            description: String(repeating: "活动说明", count: 20),
            categoryId: "city-walk",
            startsAt: Date(timeIntervalSince1970: 1_800_000_000),
            endsAt: Date(timeIntervalSince1970: 1_800_007_200),
            deadlineAt: Date(timeIntervalSince1970: 1_799_900_000),
            regionId: "tokyo",
            publicArea: "代代木公园入口",
            exactAddress: "東京都渋谷区代々木神園町2-1",
            capacity: 12,
            registrationMode: "automatic",
            waitlistEnabled: true,
            fee: .init(
                isFree: true,
                amountJPY: nil,
                collectorName: nil,
                method: nil,
                paymentDeadlineText: nil,
                refundPolicy: nil
            ),
            organizerContact: organizerContact
        )
    }

    private func makeEvent(
        status: String,
        contact: OrganizerContact?
    ) throws -> EventSummary {
        var overrides: [String: Any] = ["status": status]
        if let contact {
            overrides["organizerContact"] = [
                "kind": contact.kind.rawValue,
                "label": contact.label.map { $0 as Any } ?? NSNull(),
                "value": contact.value,
            ]
        } else {
            overrides["organizerContact"] = NSNull()
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
}
