import Foundation
import Observation

protocol RegistrationServing: Sendable {
    func quote(purpose: String, resourceID: UUID?) async throws -> Quote
    func register(
        eventID: UUID,
        partySize: Int,
        quoteID: UUID,
        expectedEventVersion: Int,
        joinWaitlist: Bool,
        answers: [UUID: RegistrationAnswer],
        attendeeNote: String?,
        idempotencyKey: UUID
    ) async throws -> Registration
    func event(identifier: String) async throws -> EventSummary
}

extension SpottAPIClient: RegistrationServing {}

protocol RegistrationItineraryRefreshing: Sendable {
    func refreshAfterRegistration() async
}

enum RegistrationStep: Equatable, Sendable {
    case form
    case review
    case reconfirmation
    case confirmation
}

enum RegistrationField: Hashable, Sendable {
    case partySize
    case question(UUID)
    case acceptedTerms
    case attendeeNote
}

enum RegistrationConfirmationKind: Equatable, Sendable {
    case confirmed
    case pending
    case waitlisted
}

struct RegistrationConfirmation: Sendable {
    let kind: RegistrationConfirmationKind
    let registration: Registration
    let event: EventSummary
}

@MainActor
@Observable
final class RegistrationStore {
    private(set) var event: EventSummary
    var partySize: Int
    var joinWaitlistIfFull: Bool
    var answers: [UUID: RegistrationAnswer]
    var attendeeNote: String
    var acceptedTerms: Bool
    private(set) var quote: Quote?
    private(set) var step: RegistrationStep = .form
    private(set) var error: UserFacingError?
    private(set) var validationErrors: [RegistrationField: String] = [:]
    private(set) var firstInvalidField: RegistrationField?
    private(set) var isPreparingQuote = false
    private(set) var isSubmitting = false
    private(set) var idempotencyKey: UUID?
    private(set) var confirmation: RegistrationConfirmation?
    private(set) var confirmationRefreshError: String?
    private(set) var isRefreshingConfirmation = false

    @ObservationIgnored private let service: any RegistrationServing
    @ObservationIgnored private let itineraryRefresher: any RegistrationItineraryRefreshing
    @ObservationIgnored private let expectedViewerID: UUID?
    @ObservationIgnored private let locale: Locale
    @ObservationIgnored private let clock: @Sendable () -> Date
    @ObservationIgnored private var lifecycleGeneration = 0
    @ObservationIgnored private var idempotencyAttempt: StableIdempotencyAttempt?
    @ObservationIgnored private var seedIdempotencyKey: UUID?

    init(
        event: EventSummary,
        draft: DeferredRegistrationDraft = .init(),
        service: any RegistrationServing,
        itineraryRefresher: any RegistrationItineraryRefreshing,
        expectedViewerID: UUID? = nil,
        idempotencyKey: UUID = UUID(),
        locale: Locale = .current,
        clock: @escaping @Sendable () -> Date = { .now }
    ) {
        self.event = event
        partySize = min(max(1, draft.partySize), Self.maximumPartySize(for: event))
        joinWaitlistIfFull = draft.joinWaitlistIfFull
        answers = draft.answers
        attendeeNote = draft.attendeeNote
        acceptedTerms = event.fee?.isFree != false || draft.acceptedTerms
        self.service = service
        self.itineraryRefresher = itineraryRefresher
        self.expectedViewerID = expectedViewerID
        self.idempotencyKey = idempotencyKey
        seedIdempotencyKey = idempotencyKey
        self.locale = locale
        self.clock = clock
    }

    convenience init(
        event: EventSummary,
        draft: DeferredRegistrationDraft = .init(),
        service: any RegistrationServing,
        itineraryRefresher: any RegistrationItineraryRefreshing,
        expectedViewerID: UUID? = nil,
        idempotencyKey: UUID = UUID(),
        locale: Locale = .current,
        now: Date
    ) {
        self.init(
            event: event,
            draft: draft,
            service: service,
            itineraryRefresher: itineraryRefresher,
            expectedViewerID: expectedViewerID,
            idempotencyKey: idempotencyKey,
            locale: locale,
            clock: { now }
        )
    }

    var maximumPartySize: Int {
        Self.maximumPartySize(for: event)
    }

    var resumableDraft: DeferredRegistrationDraft? {
        guard idempotencyKey != nil, step != .confirmation else { return nil }
        return .init(
            partySize: partySize,
            joinWaitlistIfFull: joinWaitlistIfFull,
            answers: answers,
            attendeeNote: attendeeNote,
            acceptedTerms: event.fee?.isFree == false ? acceptedTerms : false
        )
    }

    func prepareReview() async {
        guard !isPreparingQuote else { return }
        guard validate() else {
            step = .form
            return
        }
        let generation = lifecycleGeneration
        isPreparingQuote = true
        error = nil
        defer {
            if generation == lifecycleGeneration {
                isPreparingQuote = false
            }
        }
        do {
            let refreshedQuote = try await service.quote(
                purpose: "registration",
                resourceID: event.id
            )
            try Task.checkCancellation()
            guard generation == lifecycleGeneration, idempotencyKey != nil else { return }
            quote = refreshedQuote
            step = .review
        } catch is CancellationError {
            return
        } catch {
            guard generation == lifecycleGeneration else { return }
            self.error = map(error)
            step = .form
        }
    }

    func submit() async {
        guard !isSubmitting,
              step == .review,
              let quote,
              idempotencyKey != nil else { return }
        let normalizedAnswers = sanitizedAnswers
        let payload = RegistrationRequestPayload(
            partySize: partySize,
            quoteID: quote.id,
            expectedEventVersion: event.version,
            joinWaitlistIfFull: joinWaitlistIfFull,
            answers: normalizedAnswers,
            attendeeNote: attendeeNote
        )
        let idempotencyKey: UUID
        do {
            idempotencyKey = try resolveIdempotencyKey(for: payload)
        } catch {
            self.error = map(error)
            return
        }
        let generation = lifecycleGeneration
        isSubmitting = true
        error = nil
        defer {
            if generation == lifecycleGeneration {
                isSubmitting = false
            }
        }
        do {
            let registration = try await service.register(
                eventID: event.id,
                partySize: payload.partySize,
                quoteID: quote.id,
                expectedEventVersion: payload.expectedEventVersion,
                joinWaitlist: payload.joinWaitlistIfFull,
                answers: normalizedAnswers,
                attendeeNote: payload.attendeeNote,
                idempotencyKey: idempotencyKey
            )
            try Task.checkCancellation()
            guard generation == lifecycleGeneration,
                  self.idempotencyKey == idempotencyKey else { return }
            guard registration.eventId == event.id else {
                throw RegistrationStoreError.unexpectedEvent
            }
            guard let expectedViewerID,
                  registration.userId == expectedViewerID else {
                throw RegistrationStoreError.unexpectedViewer
            }
            guard let kind = RegistrationConfirmationKind(status: registration.status) else {
                throw RegistrationStoreError.unsupportedSuccessStatus
            }
            confirmation = .init(kind: kind, registration: registration, event: event)
            confirmationRefreshError = nil
            self.quote = nil
            idempotencyAttempt = nil
            seedIdempotencyKey = nil
            self.idempotencyKey = nil
            step = .confirmation
            await itineraryRefresher.refreshAfterRegistration()

            do {
                let identifier = event.publicSlug.isEmpty
                    ? event.id.uuidString.lowercased()
                    : event.publicSlug
                let authorizedEvent = try await service.event(identifier: identifier)
                try Task.checkCancellation()
                guard generation == lifecycleGeneration,
                      confirmation?.registration.id == registration.id else { return }
                guard authorizedEvent.id == event.id else {
                    throw RegistrationStoreError.unexpectedEvent
                }
                event = authorizedEvent
                confirmation = .init(
                    kind: kind,
                    registration: registration,
                    event: authorizedEvent
                )
            } catch is CancellationError {
                return
            } catch {
                guard generation == lifecycleGeneration,
                      confirmation?.registration.id == registration.id else { return }
                confirmationRefreshError = localized(
                    "journey.confirmation.refresh_failed"
                )
            }
        } catch let apiError as APIError where apiError.status == 409 {
            await reconcileAfterConflict(
                apiError,
                generation: generation,
                expectedKey: idempotencyKey
            )
        } catch let apiError as APIError where !apiError.fieldErrors.isEmpty {
            guard generation == lifecycleGeneration,
                  self.idempotencyKey == idempotencyKey else { return }
            applyServerValidation(apiError)
        } catch is CancellationError {
            return
        } catch {
            guard generation == lifecycleGeneration,
                  self.idempotencyKey == idempotencyKey else { return }
            self.error = map(error)
        }
    }

    func acceptReconfirmation() {
        guard step == .reconfirmation, quote != nil else { return }
        let nextSeed = UUID()
        idempotencyAttempt = nil
        seedIdempotencyKey = nextSeed
        idempotencyKey = nextSeed
        error = nil
        if validate() {
            step = .review
        } else {
            quote = nil
            step = .form
        }
    }

    func retryConfirmationRefresh() async {
        guard step == .confirmation,
              !isRefreshingConfirmation,
              let currentConfirmation = confirmation else { return }
        let generation = lifecycleGeneration
        isRefreshingConfirmation = true
        defer {
            if generation == lifecycleGeneration {
                isRefreshingConfirmation = false
            }
        }

        do {
            let identifier = currentConfirmation.event.publicSlug.isEmpty
                ? currentConfirmation.event.id.uuidString.lowercased()
                : currentConfirmation.event.publicSlug
            let authorizedEvent = try await service.event(identifier: identifier)
            try Task.checkCancellation()
            guard generation == lifecycleGeneration,
                  confirmation?.registration.id == currentConfirmation.registration.id else {
                return
            }
            guard authorizedEvent.id == currentConfirmation.event.id else {
                throw RegistrationStoreError.unexpectedEvent
            }
            event = authorizedEvent
            confirmation = .init(
                kind: currentConfirmation.kind,
                registration: currentConfirmation.registration,
                event: authorizedEvent
            )
            confirmationRefreshError = nil
        } catch is CancellationError {
            return
        } catch {
            guard generation == lifecycleGeneration,
                  confirmation?.registration.id == currentConfirmation.registration.id else {
                return
            }
            confirmationRefreshError = localized(
                "journey.confirmation.refresh_failed"
            )
        }
    }

    func returnToForm() {
        guard step == .review else { return }
        quote = nil
        error = nil
        validationErrors = [:]
        firstInvalidField = nil
        step = .form
    }

    func abandon() {
        lifecycleGeneration += 1
        idempotencyAttempt = nil
        seedIdempotencyKey = nil
        idempotencyKey = nil
        quote = nil
        confirmation = nil
        confirmationRefreshError = nil
        isRefreshingConfirmation = false
        error = nil
        validationErrors = [:]
        firstInvalidField = nil
        isPreparingQuote = false
        isSubmitting = false
        step = .form
    }

    @discardableResult
    func validate() -> Bool {
        var errors: [RegistrationField: String] = [:]
        if !(1...maximumPartySize).contains(partySize) {
            errors[.partySize] = localized("journey.validation.party_size")
        }

        for question in event.registrationQuestions ?? [] {
            let answer = answers[question.id]
            let field = RegistrationField.question(question.id)
            switch (question.kind, answer) {
            case (.text, .text(let value)):
                let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                if question.required && trimmed.isEmpty {
                    errors[field] = localized("journey.validation.required")
                } else if value.count > 1_000 {
                    errors[field] = localized("journey.validation.answer_too_long")
                }
            case (.singleChoice, .choice(let value)):
                if !question.options.contains(value) {
                    errors[field] = localized("journey.validation.choice")
                }
            case (.boolean, .boolean):
                break
            case (_, nil) where !question.required:
                break
            default:
                errors[field] = question.required
                    ? localized("journey.validation.required")
                    : localized("journey.validation.answer_invalid")
            }
        }

        if attendeeNote.count > 1_000 {
            errors[.attendeeNote] = localized("journey.validation.note_too_long")
        }
        if event.fee?.isFree == false, !acceptedTerms {
            errors[.acceptedTerms] = localized("journey.validation.fee_terms")
        }
        validationErrors = errors
        firstInvalidField = orderedFields.first(where: { errors[$0] != nil })
        return errors.isEmpty
    }

    private var orderedFields: [RegistrationField] {
        [.partySize]
            + (event.registrationQuestions ?? []).map { .question($0.id) }
            + [.acceptedTerms, .attendeeNote]
    }

    private var sanitizedAnswers: [UUID: RegistrationAnswer] {
        let allowedQuestionIDs = Set(
            (event.registrationQuestions ?? []).map(\.id)
        )
        return answers.filter { allowedQuestionIDs.contains($0.key) }
            .compactMapValues { answer in
            switch answer {
            case .text(let value):
                let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? nil : .text(trimmed)
            case .choice(let value):
                return value.isEmpty ? nil : .choice(value)
            case .boolean:
                return answer
            }
        }
    }

    private func reconcileAfterConflict(
        _ conflict: APIError,
        generation: Int,
        expectedKey: UUID
    ) async {
        do {
            let identifier = event.publicSlug.isEmpty
                ? event.id.uuidString.lowercased()
                : event.publicSlug
            let refreshed = try await service.event(identifier: identifier)
            let refreshedQuote = try await service.quote(
                purpose: "registration",
                resourceID: refreshed.id
            )
            try Task.checkCancellation()
            guard generation == lifecycleGeneration,
                  idempotencyKey == expectedKey else { return }
            let previousFee = event.fee
            if refreshed.fee?.isFree != false {
                acceptedTerms = true
            } else if refreshed.fee != previousFee {
                acceptedTerms = false
            }
            let allowedQuestionIDs = Set(
                (refreshed.registrationQuestions ?? []).map(\.id)
            )
            answers = Dictionary(
                uniqueKeysWithValues: answers.filter {
                    allowedQuestionIDs.contains($0.key)
                }
            )
            event = refreshed
            partySize = min(max(1, partySize), Self.maximumPartySize(for: refreshed))
            quote = refreshedQuote
            idempotencyAttempt = nil
            seedIdempotencyKey = expectedKey
            idempotencyKey = expectedKey
            error = .init(
                id: conflict.code,
                message: conflict.code == "QUOTE_EXPIRED"
                    ? localized("journey.error.quote_expired")
                    : localized("journey.error.registration_changed"),
                retryable: false
            )
            step = .reconfirmation
        } catch is CancellationError {
            return
        } catch {
            guard generation == lifecycleGeneration,
                  idempotencyKey == expectedKey else { return }
            self.error = map(error)
        }
    }

    private static func maximumPartySize(for event: EventSummary) -> Int {
        let contractMaximum = 10
        if event.availableCapacity > 0 {
            return max(1, min(contractMaximum, event.availableCapacity))
        }
        if event.waitlistEnabled, event.capacity > 0 {
            return max(1, min(contractMaximum, event.capacity))
        }
        return 1
    }

    private func resolveIdempotencyKey(
        for payload: RegistrationRequestPayload
    ) throws -> UUID {
        let nextKey = seedIdempotencyKey ?? UUID()
        let attempt = try StableIdempotencyAttempt.resolve(
            existing: idempotencyAttempt,
            payload: payload,
            makeKey: { nextKey }
        )
        idempotencyAttempt = attempt
        seedIdempotencyKey = nil
        idempotencyKey = attempt.idempotencyKey
        return attempt.idempotencyKey
    }

    private func applyServerValidation(_ apiError: APIError) {
        var errors: [RegistrationField: String] = [:]
        for fieldError in apiError.fieldErrors {
            let field: RegistrationField?
            switch fieldError.field {
            case "partySize":
                field = .partySize
            case "attendeeNote":
                field = .attendeeNote
            case "acceptedTerms":
                field = .acceptedTerms
            default:
                let answerPrefix = "answers."
                if fieldError.field.hasPrefix(answerPrefix),
                   let id = UUID(uuidString: String(fieldError.field.dropFirst(answerPrefix.count))) {
                    field = .question(id)
                } else {
                    field = nil
                }
            }
            if let field {
                switch field {
                case .partySize:
                    errors[field] = localized("journey.validation.party_size")
                case .acceptedTerms:
                    errors[field] = localized("journey.validation.fee_terms")
                case .attendeeNote:
                    errors[field] = localized("journey.validation.note_invalid")
                case .question:
                    errors[field] = localized("journey.validation.answer_invalid")
                }
            }
        }

        guard !errors.isEmpty else {
            error = map(apiError)
            return
        }
        validationErrors = errors
        firstInvalidField = orderedFields.first(where: { errors[$0] != nil })
        error = .init(
            id: apiError.code,
            message: localized("journey.validation.summary"),
            retryable: apiError.retryable
        )
        step = .form
    }

    private func map(_ error: Error) -> UserFacingError {
        if let apiError = error as? APIError {
            return .init(
                id: apiError.code,
                message: apiError.code == "QUOTE_EXPIRED"
                    ? localized("journey.error.quote_expired")
                    : localized("journey.error.action"),
                retryable: apiError.retryable
            )
        }
        if case RegistrationStoreError.unsupportedSuccessStatus = error {
            return .init(
                id: "REGISTRATION_STATUS_INVALID",
                message: localized("journey.error.registration_status"),
                retryable: true
            )
        }
        if case RegistrationStoreError.unexpectedEvent = error {
            return .init(
                id: "REGISTRATION_EVENT_MISMATCH",
                message: localized("journey.error.action"),
                retryable: false
            )
        }
        if case RegistrationStoreError.unexpectedViewer = error {
            return .init(
                id: "REGISTRATION_VIEWER_MISMATCH",
                message: localized("journey.error.action"),
                retryable: false
            )
        }
        return .init(
            id: "NETWORK_UNAVAILABLE",
            message: localized("journey.error.network"),
            retryable: true
        )
    }

    private func localized(_ key: String.LocalizationValue) -> String {
        CoreJourneyLocalization.text(key, locale: locale)
    }

    private enum RegistrationStoreError: Error {
        case unsupportedSuccessStatus
        case unexpectedEvent
        case unexpectedViewer
    }
}

private extension RegistrationConfirmationKind {
    init?(status: String) {
        switch status {
        case "confirmed": self = .confirmed
        case "pending": self = .pending
        case "waitlisted": self = .waitlisted
        default: return nil
        }
    }
}
