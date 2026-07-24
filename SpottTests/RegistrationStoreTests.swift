import Foundation
import XCTest
@testable import Spott

@MainActor
final class RegistrationStoreTests: XCTestCase {
    private let now = ISO8601DateFormatter().date(from: "2026-07-16T00:00:00Z")!
    private let fixedKey = UUID(uuidString: "019b0000-0000-7000-8300-000000000001")!

    func testDismissalPolicyProtectsWaitlistChoiceAndReviewProgress() {
        XCTAssertTrue(
            RegistrationDismissalPolicy.requiresConfirmation(
                step: .form,
                partySize: 1,
                joinWaitlistIfFull: false,
                answers: [:],
                attendeeNote: "",
                isPaid: false,
                acceptedTerms: true
            )
        )
        XCTAssertTrue(
            RegistrationDismissalPolicy.requiresConfirmation(
                step: .review,
                partySize: 1,
                joinWaitlistIfFull: true,
                answers: [:],
                attendeeNote: "",
                isPaid: false,
                acceptedTerms: true
            )
        )
        XCTAssertFalse(
            RegistrationDismissalPolicy.requiresConfirmation(
                step: .confirmation,
                partySize: 2,
                joinWaitlistIfFull: false,
                answers: [:],
                attendeeNote: "saved",
                isPaid: true,
                acceptedTerms: true
            )
        )
    }

    func testGateRecoveryRestoresEveryRegistrationInput() throws {
        let questionID = UUID(uuidString: "019b0000-0000-7000-8300-000000000010")!
        let event = try makeEvent(registrationQuestions: [textQuestion(id: questionID)])
        let draft = DeferredRegistrationDraft(
            partySize: 3,
            joinWaitlistIfFull: false,
            answers: [questionID: .text("靠近无障碍入口")],
            attendeeNote: "对坚果过敏"
        )
        let store = RegistrationStore(
            event: event,
            draft: draft,
            service: RegistrationServiceStub(),
            itineraryRefresher: ItineraryRefreshSpy(),
            idempotencyKey: fixedKey,
            now: now
        )

        XCTAssertEqual(store.partySize, 3)
        XCTAssertFalse(store.joinWaitlistIfFull)
        XCTAssertEqual(store.answers[questionID], .text("靠近无障碍入口"))
        XCTAssertEqual(store.attendeeNote, "对坚果过敏")
        XCTAssertEqual(store.resumableDraft, draft)
        XCTAssertEqual(store.idempotencyKey, fixedKey)
    }

    func testValidationFocusesTheFirstInvalidQuestionWithoutRequestingAQuote() async throws {
        let firstQuestionID = UUID(uuidString: "019b0000-0000-7000-8300-000000000011")!
        let secondQuestionID = UUID(uuidString: "019b0000-0000-7000-8300-000000000012")!
        let event = try makeEvent(registrationQuestions: [
            textQuestion(id: firstQuestionID),
            choiceQuestion(id: secondQuestionID),
        ])
        let service = RegistrationServiceStub(quotes: [quote(id: 1)])
        let store = RegistrationStore(
            event: event,
            service: service,
            itineraryRefresher: ItineraryRefreshSpy(),
            idempotencyKey: fixedKey,
            now: now
        )
        store.answers[secondQuestionID] = .choice("无效选项")

        await store.prepareReview()

        XCTAssertEqual(store.step, .form)
        XCTAssertEqual(store.firstInvalidField, .question(firstQuestionID))
        XCTAssertNotNil(store.validationErrors[.question(firstQuestionID)])
        let quoteRequestCount = await service.quoteRequestCount()
        XCTAssertEqual(quoteRequestCount, 0)
    }

    func testPreparingReviewCreatesOneAuthoritativeQuote() async throws {
        let expectedQuote = quote(id: 1)
        let service = RegistrationServiceStub(quotes: [expectedQuote])
        let store = RegistrationStore(
            event: try makeEvent(),
            service: service,
            itineraryRefresher: ItineraryRefreshSpy(),
            idempotencyKey: fixedKey,
            now: now
        )

        await store.prepareReview()

        XCTAssertEqual(store.step, .review)
        XCTAssertEqual(store.quote?.id, expectedQuote.id)
        let quoteRequestCount = await service.quoteRequestCount()
        XCTAssertEqual(quoteRequestCount, 1)
    }

    func testReturningFromReviewInvalidatesTheQuoteButPreservesTheDraftAndKey() async throws {
        let service = RegistrationServiceStub(quotes: [quote(id: 1)])
        let store = RegistrationStore(
            event: try makeEvent(),
            draft: .init(partySize: 2, attendeeNote: "keep"),
            service: service,
            itineraryRefresher: ItineraryRefreshSpy(),
            idempotencyKey: fixedKey,
            now: now
        )
        await store.prepareReview()

        store.returnToForm()

        XCTAssertEqual(store.step, .form)
        XCTAssertNil(store.quote)
        XCTAssertEqual(store.partySize, 2)
        XCTAssertEqual(store.attendeeNote, "keep")
        XCTAssertEqual(store.idempotencyKey, fixedKey)
    }

    func testOfflineRetriesReuseOneIdempotencyKeyAndPreserveInput() async throws {
        let questionID = UUID(uuidString: "019b0000-0000-7000-8300-000000000013")!
        let service = RegistrationServiceStub(
            quotes: [quote(id: 1)],
            registrationResults: [.offline, .offline]
        )
        let refresher = ItineraryRefreshSpy()
        let store = RegistrationStore(
            event: try makeEvent(registrationQuestions: [textQuestion(id: questionID)]),
            draft: .init(
                partySize: 2,
                joinWaitlistIfFull: true,
                answers: [questionID: .text("保留这份回答")],
                attendeeNote: "保留这份备注"
            ),
            service: service,
            itineraryRefresher: refresher,
            idempotencyKey: fixedKey,
            now: now
        )
        await store.prepareReview()

        await store.submit()
        await store.submit()

        let submittedKeys = await service.submittedKeys()
        XCTAssertEqual(submittedKeys, [fixedKey, fixedKey])
        XCTAssertEqual(store.partySize, 2)
        XCTAssertEqual(store.answers[questionID], .text("保留这份回答"))
        XCTAssertEqual(store.attendeeNote, "保留这份备注")
        XCTAssertEqual(store.idempotencyKey, fixedKey)
        XCTAssertEqual(store.error?.id, "NETWORK_UNAVAILABLE")
        let itineraryRefreshCount = await refresher.refreshCount()
        XCTAssertEqual(itineraryRefreshCount, 0)
    }

    func testRegistrationIdempotencyKeyMatchesExactEncodedPayload() async throws {
        let questionID = UUID(uuidString: "019b0000-0000-7000-8300-000000000015")!
        let event = try makeEvent(registrationQuestions: [textQuestion(id: questionID)])
        let service = RegistrationServiceStub(
            quotes: [quote(id: 1), quote(id: 2)],
            registrationResults: Array(repeating: .responseLost, count: 8)
        )
        let store = RegistrationStore(
            event: event,
            draft: .init(
                partySize: 2,
                joinWaitlistIfFull: false,
                answers: [questionID: .text("first valid answer")],
                attendeeNote: "  same note\n"
            ),
            service: service,
            itineraryRefresher: ItineraryRefreshSpy(),
            idempotencyKey: fixedKey,
            now: now
        )
        await store.prepareReview()

        await store.submit()
        await store.submit()

        store.attendeeNote = "\nsame note\t"
        await store.submit()

        store.partySize = 3
        await store.submit()

        store.answers[questionID] = .text("second valid answer")
        await store.submit()

        store.attendeeNote = "different note"
        await store.submit()

        store.joinWaitlistIfFull = true
        await store.submit()

        store.returnToForm()
        await store.prepareReview()
        await store.submit()

        let payloads = await service.submittedPayloads()
        let keys = await service.submittedKeys()
        XCTAssertEqual(payloads.count, 8)
        XCTAssertEqual(keys.count, payloads.count)
        XCTAssertEqual(payloads[0], payloads[1], "response-loss retry must send the same payload")
        XCTAssertEqual(keys[0], keys[1], "response-loss retry must reuse its key")
        XCTAssertEqual(payloads[1], payloads[2], "note whitespace must normalize on the wire")
        XCTAssertEqual(keys[1], keys[2], "equivalent normalized notes must reuse the key")

        let changedFields = ["party size", "answer", "normalized note", "waitlist choice", "quote"]
        for (offset, field) in changedFields.enumerated() {
            let index = offset + 3
            XCTAssertNotEqual(payloads[index - 1], payloads[index], "\(field) must change the wire payload")
            XCTAssertNotEqual(keys[index - 1], keys[index], "\(field) must rotate the key")
        }
        XCTAssertNotEqual(payloads[6].quoteId, payloads[7].quoteId)

        let updatedEvent = try makeEvent(
            ["version": event.version + 1],
            registrationQuestions: [textQuestion(id: questionID)]
        )
        let sharedQuote = quote(id: 3)
        let versionService = RegistrationServiceStub(
            quotes: [sharedQuote, sharedQuote],
            registrationResults: [.conflict, .responseLost],
            refreshedEvent: updatedEvent
        )
        let versionStore = RegistrationStore(
            event: event,
            draft: .init(answers: [questionID: .text("first valid answer")]),
            service: versionService,
            itineraryRefresher: ItineraryRefreshSpy(),
            idempotencyKey: fixedKey,
            now: now
        )
        await versionStore.prepareReview()
        await versionStore.submit()
        XCTAssertEqual(versionStore.step, .reconfirmation)

        versionStore.acceptReconfirmation()
        await versionStore.submit()

        let versionPayloads = await versionService.submittedPayloads()
        let versionKeys = await versionService.submittedKeys()
        XCTAssertEqual(versionPayloads.count, 2)
        XCTAssertEqual(versionPayloads[0].quoteId, versionPayloads[1].quoteId)
        XCTAssertNotEqual(
            versionPayloads[0].expectedEventVersion,
            versionPayloads[1].expectedEventVersion
        )
        XCTAssertNotEqual(versionPayloads[0], versionPayloads[1])
        XCTAssertNotEqual(versionKeys[0], versionKeys[1], "expected event version must rotate the key")
    }

    func testDoubleSubmitProducesOnlyOneRegistrationRequest() async throws {
        let event = try makeEvent()
        let registration = makeRegistration(eventID: event.id, status: "confirmed")
        let service = RegistrationServiceStub(
            quotes: [quote(id: 1)],
            registrationResults: [.success(registration)],
            registrationDelay: .milliseconds(120)
        )
        let store = RegistrationStore(
            event: event,
            service: service,
            itineraryRefresher: ItineraryRefreshSpy(),
            idempotencyKey: fixedKey,
            now: now
        )
        await store.prepareReview()

        let first = Task { await store.submit() }
        await Task.yield()
        let second = Task { await store.submit() }
        await first.value
        await second.value

        let registrationRequestCount = await service.registrationRequestCount()
        let submittedEventVersions = await service.submittedEventVersions()
        XCTAssertEqual(registrationRequestCount, 1)
        XCTAssertEqual(submittedEventVersions, [event.version])
    }

    func testSuccessfulRegistrationRefreshesTheNewlyAuthorizedEventForConfirmation() async throws {
        let initial = try makeEvent()
        let authorized = try makeEvent([
            "exactAddress": "2-9-14 Kiyosumi, Koto-ku",
            "registrationStatus": "confirmed",
        ])
        let service = RegistrationServiceStub(
            quotes: [quote(id: 1)],
            registrationResults: [
                .success(makeRegistration(eventID: initial.id, status: "confirmed")),
            ],
            refreshedEvent: authorized
        )
        let store = RegistrationStore(
            event: initial,
            service: service,
            itineraryRefresher: ItineraryRefreshSpy(),
            idempotencyKey: fixedKey,
            now: now
        )
        await store.prepareReview()

        await store.submit()

        XCTAssertEqual(store.step, .confirmation)
        XCTAssertEqual(
            store.confirmation?.event.exactAddress,
            "2-9-14 Kiyosumi, Koto-ku"
        )
        XCTAssertNil(store.confirmationRefreshError)
        let detailRequestCount = await service.detailRequestCount()
        XCTAssertEqual(detailRequestCount, 1)
    }

    func testConflictRefreshesEventAndQuoteThenRequiresExplicitReconfirmation() async throws {
        let initial = try makeEvent()
        let updated = try makeEvent([
            "title": "服务端刚刚更新的活动",
            "confirmedCount": 8,
            "availableCapacity": 0,
            "availableActions": ["joinWaitlist"],
        ])
        let firstQuote = quote(id: 1)
        let replacementQuote = quote(id: 2)
        let service = RegistrationServiceStub(
            quotes: [firstQuote, replacementQuote],
            registrationResults: [.conflict],
            refreshedEvent: updated
        )
        let store = RegistrationStore(
            event: initial,
            draft: .init(partySize: 2, attendeeNote: "保留输入"),
            service: service,
            itineraryRefresher: ItineraryRefreshSpy(),
            idempotencyKey: fixedKey,
            now: now
        )
        await store.prepareReview()

        await store.submit()

        XCTAssertEqual(store.step, .reconfirmation)
        XCTAssertEqual(store.event.title, "服务端刚刚更新的活动")
        XCTAssertEqual(store.quote?.id, replacementQuote.id)
        XCTAssertEqual(store.partySize, 2)
        XCTAssertEqual(store.attendeeNote, "保留输入")
        XCTAssertEqual(store.idempotencyKey, fixedKey)
        let detailRequestCount = await service.detailRequestCount()
        XCTAssertEqual(detailRequestCount, 1)

        store.acceptReconfirmation()

        XCTAssertEqual(store.step, .review)
        XCTAssertNotEqual(store.idempotencyKey, fixedKey)
    }

    func testConflictThatAddsARequiredQuestionReturnsToTheLiveFormBeforeResubmission() async throws {
        let newQuestionID = UUID(
            uuidString: "019b0000-0000-7000-8300-000000000099"
        )!
        let initial = try makeEvent()
        let updated = try makeEvent(
            ["title": "Updated event"],
            registrationQuestions: [textQuestion(id: newQuestionID)]
        )
        let service = RegistrationServiceStub(
            quotes: [quote(id: 1), quote(id: 2), quote(id: 3)],
            registrationResults: [.conflict],
            refreshedEvent: updated
        )
        let store = RegistrationStore(
            event: initial,
            service: service,
            itineraryRefresher: ItineraryRefreshSpy(),
            idempotencyKey: fixedKey,
            now: now
        )
        await store.prepareReview()
        await store.submit()

        XCTAssertEqual(store.step, .reconfirmation)
        XCTAssertEqual(
            RegistrationFormPlan(
                questions: store.event.registrationQuestions ?? []
            ).pages.flatMap(\.questions).map(\.id),
            [newQuestionID]
        )

        store.acceptReconfirmation()

        XCTAssertEqual(store.step, .form)
        XCTAssertEqual(store.firstInvalidField, .question(newQuestionID))
        XCTAssertNotNil(store.validationErrors[.question(newQuestionID)])
        XCTAssertNil(store.quote)

        store.answers[newQuestionID] = .text("My live answer")
        await store.prepareReview()

        XCTAssertEqual(store.step, .review)
        XCTAssertEqual(store.quote?.id, quote(id: 3).id)
    }

    func testConflictDropsAnswersForQuestionsRemovedByTheAuthoritativeEvent() async throws {
        let removedQuestionID = UUID(
            uuidString: "019b0000-0000-7000-8300-000000000098"
        )!
        let initial = try makeEvent(
            registrationQuestions: [textQuestion(id: removedQuestionID)]
        )
        let updated = try makeEvent(["title": "Question removed"])
        let service = RegistrationServiceStub(
            quotes: [quote(id: 1), quote(id: 2)],
            registrationResults: [
                .conflict,
                .success(makeRegistration(eventID: initial.id, status: "confirmed")),
            ],
            refreshedEvent: updated
        )
        let store = RegistrationStore(
            event: initial,
            draft: .init(answers: [removedQuestionID: .text("stale private answer")]),
            service: service,
            itineraryRefresher: ItineraryRefreshSpy(),
            idempotencyKey: fixedKey,
            now: now
        )
        await store.prepareReview()
        await store.submit()

        XCTAssertNil(store.answers[removedQuestionID])
        store.acceptReconfirmation()
        XCTAssertEqual(store.step, .review)
        await store.submit()

        let submittedAnswers = await service.submittedAnswers()
        XCTAssertEqual(submittedAnswers.count, 2)
        XCTAssertEqual(submittedAnswers[0][removedQuestionID], .text("stale private answer"))
        XCTAssertTrue(submittedAnswers[1].isEmpty)
    }

    func testDeviceClockCannotRejectAnAuthoritativeQuoteBeforeTheServerDoes() async throws {
        let clock = RegistrationTestClock(now)
        let event = try makeEvent()
        let initialQuote = quote(id: 1, expiresAt: now.addingTimeInterval(30))
        let replacementQuote = quote(id: 2, expiresAt: now.addingTimeInterval(300))
        let service = RegistrationServiceStub(
            quotes: [initialQuote, replacementQuote],
            registrationResults: [.conflict],
            refreshedEvent: event
        )
        let store = RegistrationStore(
            event: event,
            service: service,
            itineraryRefresher: ItineraryRefreshSpy(),
            idempotencyKey: fixedKey,
            clock: clock.now
        )
        await store.prepareReview()

        clock.advance(by: 31)
        await store.submit()

        let registrationRequestCount = await service.registrationRequestCount()
        let detailRequestCount = await service.detailRequestCount()
        XCTAssertEqual(
            registrationRequestCount,
            1,
            "Device time is not authoritative; the server must decide quote expiry"
        )
        XCTAssertEqual(detailRequestCount, 1)
        XCTAssertEqual(store.quote?.id, replacementQuote.id)
        XCTAssertEqual(store.step, .reconfirmation)
        XCTAssertEqual(store.idempotencyKey, fixedKey)
    }

    func testDeferredDraftNeverSubmitsAnswersForQuestionsNoLongerInTheEvent() async throws {
        let staleQuestionID = UUID(
            uuidString: "019b0000-0000-7000-8300-000000000097"
        )!
        let event = try makeEvent()
        let service = RegistrationServiceStub(
            quotes: [quote(id: 1)],
            registrationResults: [
                .success(makeRegistration(eventID: event.id, status: "confirmed")),
            ],
            refreshedEvent: event
        )
        let store = RegistrationStore(
            event: event,
            draft: .init(
                answers: [staleQuestionID: .text("private answer from an old form")]
            ),
            service: service,
            itineraryRefresher: ItineraryRefreshSpy(),
            idempotencyKey: fixedKey,
            now: now
        )

        await store.prepareReview()
        await store.submit()

        let submittedAnswers = await service.submittedAnswers()
        XCTAssertEqual(submittedAnswers, [[:]])
    }

    func testPartySizeUsesLiveAvailabilityAndClampsAfterAConflict() async throws {
        let initial = try makeEvent([
            "capacity": 30,
            "availableCapacity": 20,
        ])
        let updated = try makeEvent([
            "capacity": 30,
            "confirmedCount": 28,
            "availableCapacity": 2,
        ])
        let service = RegistrationServiceStub(
            quotes: [quote(id: 1), quote(id: 2)],
            registrationResults: [.conflict],
            refreshedEvent: updated
        )
        let store = RegistrationStore(
            event: initial,
            draft: .init(partySize: 20),
            service: service,
            itineraryRefresher: ItineraryRefreshSpy(),
            idempotencyKey: fixedKey,
            now: now
        )

        XCTAssertEqual(store.maximumPartySize, 10)
        XCTAssertEqual(store.partySize, 10)
        XCTAssertTrue(store.validate(), "party size must match the API maximum of ten")
        await store.prepareReview()
        await store.submit()

        XCTAssertEqual(store.maximumPartySize, 2)
        XCTAssertEqual(store.partySize, 2)
        XCTAssertEqual(store.step, .reconfirmation)
    }

    func testPaidRegistrationRequiresFeeAndRefundAcknowledgementBeforeQuote() async throws {
        let event = try makeEvent([
            "fee": [
                "isFree": false,
                "amountJPY": 3_500,
                "collectorName": "Host",
                "method": "Cash at venue",
                "paymentDeadlineText": "At check-in",
                "refundPolicy": "Full refund until 48 hours before start",
            ],
        ])
        let service = RegistrationServiceStub(quotes: [quote(id: 1)])
        let store = RegistrationStore(
            event: event,
            service: service,
            itineraryRefresher: ItineraryRefreshSpy(),
            idempotencyKey: fixedKey,
            now: now
        )

        XCTAssertFalse(store.acceptedTerms)
        await store.prepareReview()

        XCTAssertEqual(store.step, .form)
        XCTAssertEqual(store.firstInvalidField, .acceptedTerms)
        XCTAssertNotNil(store.validationErrors[.acceptedTerms])
        let quoteRequestsBeforeAcceptance = await service.quoteRequestCount()
        XCTAssertEqual(quoteRequestsBeforeAcceptance, 0)

        store.acceptedTerms = true
        await store.prepareReview()

        XCTAssertEqual(store.step, .review)
        let quoteRequestsAfterAcceptance = await service.quoteRequestCount()
        XCTAssertEqual(quoteRequestsAfterAcceptance, 1)
        XCTAssertEqual(store.resumableDraft?.acceptedTerms, true)
    }

    func testAbandoningDuringSubmissionIgnoresTheLateSuccess() async throws {
        let event = try makeEvent()
        let service = RegistrationServiceStub(
            quotes: [quote(id: 1)],
            registrationResults: [.success(makeRegistration(eventID: event.id, status: "confirmed"))],
            registrationDelay: .milliseconds(120)
        )
        let refresher = ItineraryRefreshSpy()
        let store = RegistrationStore(
            event: event,
            draft: .init(partySize: 2, attendeeNote: "仍然属于已放弃的草稿"),
            service: service,
            itineraryRefresher: refresher,
            idempotencyKey: fixedKey,
            now: now
        )
        await store.prepareReview()

        let submission = Task { await store.submit() }
        while await service.registrationRequestCount() == 0 {
            await Task.yield()
        }
        store.abandon()
        await submission.value

        let itineraryRefreshCount = await refresher.refreshCount()
        XCTAssertEqual(store.step, .form)
        XCTAssertNil(store.confirmation)
        XCTAssertNil(store.idempotencyKey)
        XCTAssertEqual(itineraryRefreshCount, 0)
    }

    func testNetworkErrorsAreLocalizedWithoutClearingInput() async throws {
        let expectations = [
            ("zh-Hans", "暂时无法连接 Spott，请检查网络后重试。"),
            ("ja", "Spottに接続できません。通信環境を確認して、もう一度お試しください。"),
            ("en", "Spott can’t connect right now. Check your connection and try again."),
        ]

        for (identifier, expectedMessage) in expectations {
            let service = RegistrationServiceStub(
                quotes: [quote(id: 1)],
                registrationResults: [.offline]
            )
            let store = RegistrationStore(
                event: try makeEvent(),
                draft: .init(partySize: 2, attendeeNote: "keep"),
                service: service,
                itineraryRefresher: ItineraryRefreshSpy(),
                idempotencyKey: fixedKey,
                locale: Locale(identifier: identifier),
                now: now
            )
            await store.prepareReview()

            await store.submit()

            XCTAssertEqual(store.error?.message, expectedMessage, identifier)
            XCTAssertEqual(store.partySize, 2, identifier)
            XCTAssertEqual(store.attendeeNote, "keep", identifier)
            XCTAssertEqual(store.idempotencyKey, fixedKey, identifier)
        }
    }

    func testAPIFieldErrorsReturnToTheFormAndFocusTheFirstMappedField() async throws {
        let questionID = UUID(uuidString: "019b0000-0000-7000-8300-000000000014")!
        let event = try makeEvent(registrationQuestions: [textQuestion(id: questionID)])
        let service = RegistrationServiceStub(
            quotes: [quote(id: 1)],
            registrationResults: [
                .api(
                    APIError(
                        status: 422,
                        code: "VALIDATION_FAILED",
                        message: "Check the highlighted fields.",
                        retryable: false,
                        fieldErrors: [
                            .init(
                                field: "answers.\(questionID.uuidString.lowercased())",
                                message: "Please use a supported answer."
                            ),
                            .init(field: "attendeeNote", message: "This note is not allowed."),
                        ]
                    )
                ),
            ]
        )
        let store = RegistrationStore(
            event: event,
            draft: .init(
                partySize: 2,
                answers: [questionID: .text("keep this answer")],
                attendeeNote: "keep this note"
            ),
            service: service,
            itineraryRefresher: ItineraryRefreshSpy(),
            idempotencyKey: fixedKey,
            locale: Locale(identifier: "en"),
            now: now
        )
        await store.prepareReview()

        await store.submit()

        XCTAssertEqual(store.step, .form)
        XCTAssertEqual(
            store.validationErrors[.question(questionID)],
            "Check this answer and try again."
        )
        XCTAssertEqual(
            store.validationErrors[.attendeeNote],
            "Review the note and try again."
        )
        XCTAssertNotEqual(
            store.validationErrors[.question(questionID)],
            "Please use a supported answer.",
            "Server-authored validation copy must not bypass the selected app locale"
        )
        XCTAssertEqual(store.firstInvalidField, .question(questionID))
        XCTAssertEqual(store.answers[questionID], .text("keep this answer"))
        XCTAssertEqual(store.attendeeNote, "keep this note")
        XCTAssertEqual(store.idempotencyKey, fixedKey)
    }

    func testConfirmedPendingAndWaitlistedSuccessCreateFullConfirmationAndRefreshItinerary() async throws {
        let expectations: [(String, RegistrationConfirmationKind)] = [
            ("confirmed", .confirmed),
            ("pending", .pending),
            ("waitlisted", .waitlisted),
        ]

        for (status, expectedKind) in expectations {
            let event = try makeEvent()
            let service = RegistrationServiceStub(
                quotes: [quote(id: 1)],
                registrationResults: [.success(makeRegistration(eventID: event.id, status: status))]
            )
            let refresher = ItineraryRefreshSpy()
            let store = RegistrationStore(
                event: event,
                draft: .init(partySize: 2, attendeeNote: "提交后清除"),
                service: service,
                itineraryRefresher: refresher,
                idempotencyKey: fixedKey,
                now: now
            )
            await store.prepareReview()

            await store.submit()

            XCTAssertEqual(store.step, .confirmation, status)
            XCTAssertEqual(store.confirmation?.kind, expectedKind, status)
            XCTAssertEqual(store.confirmation?.event.id, event.id, status)
            XCTAssertEqual(store.confirmation?.registration.partySize, 2, status)
            XCTAssertNil(store.idempotencyKey, status)
            XCTAssertNil(store.resumableDraft, status)
            let itineraryRefreshCount = await refresher.refreshCount()
            XCTAssertEqual(itineraryRefreshCount, 1, status)
        }
    }

    func testLongQuestionnaireUsesNativeProgressivePagesWithoutDroppingQuestions() {
        let questions = (0..<7).map { index in
            RegistrationQuestion(
                id: UUID(uuidString: String(format: "019b0000-0000-7000-8310-%012d", index))!,
                prompt: "Question \(index)",
                kind: .text,
                required: index.isMultiple(of: 2),
                options: []
            )
        }

        let plan = RegistrationFormPlan(questions: questions)

        XCTAssertTrue(plan.isProgressive)
        XCTAssertEqual(plan.pages.map(\.kind), [.attendance, .questions, .questions, .questions])
        XCTAssertEqual(plan.pages.dropFirst().flatMap(\.questions).map(\.id), questions.map(\.id))
        XCTAssertTrue(plan.pages.dropFirst().allSatisfy { $0.questions.count <= 3 })
    }

    func testShortQuestionnaireStaysInOneNativeFormPage() {
        let questions = (0..<3).map { index in
            RegistrationQuestion(
                id: UUID(uuidString: String(format: "019b0000-0000-7000-8320-%012d", index))!,
                prompt: "Question \(index)",
                kind: .boolean,
                required: false,
                options: []
            )
        }

        let plan = RegistrationFormPlan(questions: questions)

        XCTAssertFalse(plan.isProgressive)
        XCTAssertEqual(plan.pages.map(\.kind), [.combined])
        XCTAssertEqual(plan.pages.first?.questions.map(\.id), questions.map(\.id))
    }

    func testAllConfirmationOutcomesHaveDistinctCompleteCopyInThreeLanguages() {
        let kinds: [RegistrationConfirmationKind] = [.confirmed, .pending, .waitlisted]

        for localeIdentifier in ["zh-Hans", "ja", "en"] {
            let presentations = kinds.map {
                RegistrationConfirmationPresentation(
                    kind: $0,
                    locale: Locale(identifier: localeIdentifier)
                )
            }
            XCTAssertEqual(Set(presentations.map(\.title)).count, kinds.count, localeIdentifier)
            XCTAssertEqual(Set(presentations.map(\.systemImage)).count, kinds.count, localeIdentifier)
            XCTAssertTrue(
                presentations.allSatisfy {
                    !$0.title.isEmpty && !$0.message.isEmpty && !$0.nextStep.isEmpty && !$0.actionTitle.isEmpty
                },
                localeIdentifier
            )
        }
    }

#if DEBUG
    func testCoreJourneyUIFixtureParserRequiresAnExplicitSupportedState() {
        XCTAssertNil(CoreJourneyUIFixtureState.resolve(arguments: []))
        XCTAssertNil(
            CoreJourneyUIFixtureState.resolve(arguments: [
                "-spott-ui-test-core-journey-state",
                "unknown",
            ])
        )
        XCTAssertEqual(
            CoreJourneyUIFixtureState.resolve(arguments: [
                "Spott",
                "-spott-ui-test-core-journey-state",
                "registration",
            ]),
            .registration
        )
        XCTAssertEqual(
            CoreJourneyUIFixtureState.resolve(arguments: [
                "-spott-ui-test-core-journey-state",
                "waitlisted",
            ]),
            .waitlisted
        )
    }
#endif

    func testTicketSelectionIsRequiredAndSelectedTicketFlowsIntoRegisterCall() async throws {
        let paid = ticketType(id: 1, name: "普通票")
        let event = try makeEvent()
        let service = RegistrationServiceStub(
            quotes: [quote(id: 1)],
            registrationResults: [
                .success(makeRegistration(eventID: event.id, status: "confirmed")),
            ],
            ticketTypes: [paid]
        )
        let store = RegistrationStore(
            event: event,
            service: service,
            itineraryRefresher: ItineraryRefreshSpy(),
            idempotencyKey: fixedKey,
            now: now
        )

        await store.loadTicketTypes()
        XCTAssertTrue(store.requiresTicketSelection)

        await store.prepareReview()
        XCTAssertEqual(store.step, .form)
        XCTAssertNotNil(store.validationErrors[.ticketType])
        XCTAssertEqual(store.firstInvalidField, .ticketType)

        store.selectTicketType(paid.id)
        XCTAssertFalse(store.acceptedTerms, "paid shell must be re-accepted per ticket")
        store.acceptedTerms = true

        await store.prepareReview()
        XCTAssertEqual(store.step, .review)
        await store.submit()

        XCTAssertEqual(store.step, .confirmation)
        let submittedTicketIDs = await service.submittedTicketTypeIDs()
        XCTAssertEqual(submittedTicketIDs, [paid.id])
    }

    func testEventWithoutTicketTypesSkipsSelectionAndSubmitsNilTicketType() async throws {
        let event = try makeEvent()
        let service = RegistrationServiceStub(
            quotes: [quote(id: 1)],
            registrationResults: [
                .success(makeRegistration(eventID: event.id, status: "confirmed")),
            ]
        )
        let store = RegistrationStore(
            event: event,
            service: service,
            itineraryRefresher: ItineraryRefreshSpy(),
            idempotencyKey: fixedKey,
            now: now
        )

        await store.loadTicketTypes()
        XCTAssertFalse(store.requiresTicketSelection)
        XCTAssertNil(store.validationErrors[.ticketType])

        await store.prepareReview()
        XCTAssertEqual(store.step, .review)
        await store.submit()

        XCTAssertEqual(store.step, .confirmation)
        let submittedTicketIDs = await service.submittedTicketTypeIDs()
        XCTAssertEqual(submittedTicketIDs, [UUID?.none])
    }

    func testSoldOutTicketCannotBeSelected() async throws {
        let soldOut = ticketType(id: 1, name: "早鸟票", soldOut: true)
        let open = ticketType(id: 2, name: "普通票", sortOrder: 1)
        let service = RegistrationServiceStub(ticketTypes: [soldOut, open])
        let store = RegistrationStore(
            event: try makeEvent(),
            service: service,
            itineraryRefresher: ItineraryRefreshSpy(),
            idempotencyKey: fixedKey,
            now: now
        )

        await store.loadTicketTypes()
        store.selectTicketType(soldOut.id)
        XCTAssertNil(store.selectedTicketTypeID)

        store.selectTicketType(open.id)
        XCTAssertEqual(store.selectedTicketTypeID, open.id)
    }

    func testReportPaymentAfterPaidConfirmationSetsHonestChipState() async throws {
        let paid = ticketType(id: 1, name: "普通票")
        let event = try makeEvent()
        let registration = makeRegistration(eventID: event.id, status: "confirmed")
        let service = RegistrationServiceStub(
            quotes: [quote(id: 1)],
            registrationResults: [.success(registration)],
            ticketTypes: [paid],
            paymentReport: TicketPaymentReport(
                registrationId: registration.id,
                paymentStatus: "self_reported",
                selfReportedAt: now
            )
        )
        let store = RegistrationStore(
            event: event,
            service: service,
            itineraryRefresher: ItineraryRefreshSpy(),
            idempotencyKey: fixedKey,
            now: now
        )

        await store.loadTicketTypes()
        store.selectTicketType(paid.id)
        store.acceptedTerms = true
        await store.prepareReview()
        await store.submit()
        XCTAssertEqual(store.step, .confirmation)
        XCTAssertTrue(store.canReportPayment)
        XCTAssertFalse(store.paymentReported)

        await store.reportPayment()

        XCTAssertTrue(store.paymentReported)
        XCTAssertNil(store.paymentReportError)
        let reportedIDs = await service.reportedPaymentIDs()
        XCTAssertEqual(reportedIDs, [registration.id])

        // Idempotent from the UI: a second tap must not re-send.
        await store.reportPayment()
        let secondReportedIDs = await service.reportedPaymentIDs()
        XCTAssertEqual(secondReportedIDs, [registration.id])
    }

    func testReportPaymentNotApplicableShowsHonestMessageWithoutChip() async throws {
        let paid = ticketType(id: 1, name: "普通票")
        let event = try makeEvent()
        let service = RegistrationServiceStub(
            quotes: [quote(id: 1)],
            registrationResults: [
                .success(makeRegistration(eventID: event.id, status: "confirmed")),
            ],
            ticketTypes: [paid],
            paymentReportFailure: APIError(
                status: 409,
                code: "TICKET_PAYMENT_NOT_APPLICABLE",
                message: "not applicable",
                retryable: false
            )
        )
        let store = RegistrationStore(
            event: event,
            service: service,
            itineraryRefresher: ItineraryRefreshSpy(),
            idempotencyKey: fixedKey,
            locale: Locale(identifier: "zh-Hans"),
            now: now
        )

        await store.loadTicketTypes()
        store.selectTicketType(paid.id)
        store.acceptedTerms = true
        await store.prepareReview()
        await store.submit()

        await store.reportPayment()

        XCTAssertFalse(store.paymentReported)
        XCTAssertEqual(
            store.paymentReportError,
            RegistrationExtrasLocalization.text(
                "regextras.payment.not_applicable",
                locale: Locale(identifier: "zh-Hans")
            )
        )
    }

    func testPrepareInviteLinkRequestsInvitePurposeShareLink() async throws {
        let event = try makeEvent()
        let inviteURL = URL(string: "https://spott.jp/s/abc123")!
        let service = RegistrationServiceStub(
            quotes: [quote(id: 1)],
            registrationResults: [
                .success(makeRegistration(eventID: event.id, status: "confirmed")),
            ],
            shareReceipt: ShareLinkReceipt(
                id: UUID(),
                code: "abc123",
                url: inviteURL,
                createdAt: now
            )
        )
        let store = RegistrationStore(
            event: event,
            service: service,
            itineraryRefresher: ItineraryRefreshSpy(),
            idempotencyKey: fixedKey,
            now: now
        )

        await store.prepareInviteLink()
        XCTAssertNil(store.inviteURL, "no invite link before a confirmation exists")

        await store.prepareReview()
        await store.submit()
        XCTAssertEqual(store.step, .confirmation)

        await store.prepareInviteLink()

        XCTAssertEqual(store.inviteURL, inviteURL)
        let requests = await service.shareLinkRequests()
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first?.resourceType, "event")
        XCTAssertEqual(requests.first?.purpose, "invite")
    }

    private func ticketType(
        id: Int,
        name: String,
        isFree: Bool = false,
        quota: Int? = nil,
        remaining: Int? = nil,
        soldOut: Bool = false,
        active: Bool = true,
        sortOrder: Int = 0
    ) -> EventTicketType {
        EventTicketType(
            id: UUID(uuidString: String(format: "019b0000-0000-7000-8900-%012d", id))!,
            eventId: UUID(uuidString: "019b0000-0000-7000-8a00-000000000001")!,
            name: name,
            description: nil,
            isFree: isFree,
            amountJPY: isFree ? nil : 1_500,
            collectorName: "主办方",
            method: "现金",
            paymentDeadlineText: nil,
            refundPolicy: "活动开始前 24 小时可退",
            quota: quota,
            soldCount: 0,
            remaining: remaining,
            soldOut: soldOut,
            active: active,
            sortOrder: sortOrder,
            availableActions: [],
            updatedAt: now
        )
    }

    private func makeEvent(
        _ overrides: [String: Any] = [:],
        registrationQuestions: [[String: Any]]? = nil
    ) throws -> EventSummary {
        var values = overrides
        if let registrationQuestions {
            values["registrationQuestions"] = registrationQuestions
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(
            EventSummary.self,
            from: JSONSerialization.data(withJSONObject: eventPayload(overrides: values))
        )
    }

    private func textQuestion(id: UUID) -> [String: Any] {
        [
            "id": id.uuidString.lowercased(),
            "prompt": "请说明参加理由",
            "kind": "text",
            "required": true,
            "options": [],
        ]
    }

    private func choiceQuestion(id: UUID) -> [String: Any] {
        [
            "id": id.uuidString.lowercased(),
            "prompt": "请选择到达方式",
            "kind": "single_choice",
            "required": true,
            "options": ["步行", "电车"],
        ]
    }

    private func quote(id: Int, expiresAt: Date? = nil) -> Quote {
        Quote(
            id: UUID(uuidString: String(format: "019b0000-0000-7000-8300-%012d", id))!,
            amount: 10,
            currency: "POINTS",
            expiresAt: expiresAt ?? now.addingTimeInterval(300)
        )
    }

    private func makeRegistration(eventID: UUID, status: String) -> Registration {
        Registration(
            id: UUID(),
            eventId: eventID,
            userId: UUID(),
            status: status,
            partySize: 2,
            attendeeNote: nil,
            availableActions: [.cancelRegistration],
            version: 1,
            offerExpiresAt: nil,
            updatedAt: now,
            rewardPoints: nil,
            checkinMethod: nil
        )
    }
}

private final class RegistrationTestClock: @unchecked Sendable {
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

private actor RegistrationServiceStub: RegistrationServing {
    enum RegistrationResult: Sendable {
        case success(Registration)
        case conflict
        case offline
        case responseLost
        case api(APIError)
    }

    private var quotes: [Quote]
    private var registrationResults: [RegistrationResult]
    private let refreshedEvent: EventSummary?
    private let registrationDelay: Duration?
    private let stubTicketTypes: [EventTicketType]
    private var quoteRequests = 0
    private var registrationRequests = 0
    private var detailRequests = 0
    private var keys: [UUID] = []
    private var payloads: [RegistrationRequestPayloadSnapshot] = []
    private var answerPayloads: [[UUID: RegistrationAnswer]] = []
    private var eventVersions: [Int] = []
    private var ticketTypeIDs: [UUID?] = []
    private let stubPaymentReport: TicketPaymentReport?
    private let stubPaymentReportFailure: APIError?
    private let stubShareReceipt: ShareLinkReceipt?
    private var paymentReportIDs: [UUID] = []
    private var shareRequests: [(resourceType: String, purpose: String?)] = []

    init(
        quotes: [Quote] = [],
        registrationResults: [RegistrationResult] = [],
        refreshedEvent: EventSummary? = nil,
        registrationDelay: Duration? = nil,
        ticketTypes: [EventTicketType] = [],
        paymentReport: TicketPaymentReport? = nil,
        paymentReportFailure: APIError? = nil,
        shareReceipt: ShareLinkReceipt? = nil
    ) {
        self.quotes = quotes
        self.registrationResults = registrationResults
        self.refreshedEvent = refreshedEvent
        self.registrationDelay = registrationDelay
        stubTicketTypes = ticketTypes
        stubPaymentReport = paymentReport
        stubPaymentReportFailure = paymentReportFailure
        stubShareReceipt = shareReceipt
    }

    func quote(purpose: String, resourceID: UUID?) async throws -> Quote {
        quoteRequests += 1
        guard purpose == "registration", resourceID != nil, !quotes.isEmpty else {
            throw StubError.missingResponse
        }
        return quotes.removeFirst()
    }

    func register(
        eventID: UUID,
        partySize: Int,
        quoteID: UUID,
        expectedEventVersion: Int,
        joinWaitlist: Bool,
        answers: [UUID: RegistrationAnswer],
        attendeeNote: String?,
        ticketTypeID: UUID?,
        idempotencyKey: UUID
    ) async throws -> Registration {
        registrationRequests += 1
        keys.append(idempotencyKey)
        ticketTypeIDs.append(ticketTypeID)
        payloads.append(RegistrationRequestPayloadSnapshot(
            partySize: partySize,
            quoteID: quoteID,
            expectedEventVersion: expectedEventVersion,
            joinWaitlistIfFull: joinWaitlist,
            answers: answers,
            attendeeNote: attendeeNote
        ))
        answerPayloads.append(answers)
        eventVersions.append(expectedEventVersion)
        if let registrationDelay {
            try await Task.sleep(for: registrationDelay)
        }
        guard !registrationResults.isEmpty else { throw StubError.missingResponse }
        switch registrationResults.removeFirst() {
        case .success(let registration): return registration
        case .conflict:
            throw APIError(
                status: 409,
                code: "REGISTRATION_CAPACITY_FULL",
                message: "活动名额刚刚发生变化。",
                retryable: false
            )
        case .offline:
            throw URLError(.notConnectedToInternet)
        case .responseLost:
            throw URLError(.networkConnectionLost)
        case .api(let error):
            throw error
        }
    }

    func event(identifier: String) async throws -> EventSummary {
        detailRequests += 1
        guard let refreshedEvent else { throw StubError.missingResponse }
        return refreshedEvent
    }

    func ticketTypes(eventID: UUID) async throws -> EventTicketTypePage {
        EventTicketTypePage(items: stubTicketTypes)
    }

    func reportPayment(registrationID: UUID) async throws -> TicketPaymentReport {
        paymentReportIDs.append(registrationID)
        if let stubPaymentReportFailure {
            throw stubPaymentReportFailure
        }
        guard let stubPaymentReport else { throw StubError.missingResponse }
        return stubPaymentReport
    }

    func createShareLink(
        resourceType: String,
        resourceID: UUID,
        campaign: String?,
        channel: String?,
        purpose: String?
    ) async throws -> ShareLinkReceipt {
        shareRequests.append((resourceType: resourceType, purpose: purpose))
        guard let stubShareReceipt else { throw StubError.missingResponse }
        return stubShareReceipt
    }

    func reportedPaymentIDs() -> [UUID] { paymentReportIDs }
    func shareLinkRequests() -> [(resourceType: String, purpose: String?)] {
        shareRequests
    }

    func quoteRequestCount() -> Int { quoteRequests }
    func submittedTicketTypeIDs() -> [UUID?] { ticketTypeIDs }
    func registrationRequestCount() -> Int { registrationRequests }
    func detailRequestCount() -> Int { detailRequests }
    func submittedKeys() -> [UUID] { keys }
    func submittedPayloads() -> [RegistrationRequestPayloadSnapshot] { payloads }
    func submittedAnswers() -> [[UUID: RegistrationAnswer]] { answerPayloads }
    func submittedEventVersions() -> [Int] { eventVersions }

    private enum StubError: Error, Sendable {
        case missingResponse
    }
}

private struct RegistrationRequestPayloadSnapshot: Equatable, Sendable {
    let partySize: Int
    let quoteId: String
    let expectedEventVersion: Int
    let joinWaitlistIfFull: Bool
    let answers: [String: RegistrationAnswer]
    let attendeeNote: String?

    init(
        partySize: Int,
        quoteID: UUID,
        expectedEventVersion: Int,
        joinWaitlistIfFull: Bool,
        answers: [UUID: RegistrationAnswer],
        attendeeNote: String?
    ) {
        let payload = RegistrationRequestPayload(
            partySize: partySize,
            quoteID: quoteID,
            expectedEventVersion: expectedEventVersion,
            joinWaitlistIfFull: joinWaitlistIfFull,
            answers: answers,
            attendeeNote: attendeeNote
        )
        self.partySize = payload.partySize
        quoteId = payload.quoteId
        self.expectedEventVersion = payload.expectedEventVersion
        self.joinWaitlistIfFull = payload.joinWaitlistIfFull
        self.answers = payload.answers
        self.attendeeNote = payload.attendeeNote
    }
}

private actor ItineraryRefreshSpy: RegistrationItineraryRefreshing {
    private var count = 0

    func refreshAfterRegistration() async {
        count += 1
    }

    func refreshCount() -> Int { count }
}
