import Foundation
import Observation

protocol MyActivitiesServing: AuthoritativeTimeProviding, Sendable {
    func registrationItinerary(
        cursor: String?,
        limit: Int
    ) async throws -> RegistrationItineraryPage
    func quote(purpose: String, resourceID: UUID?) async throws -> Quote
    func acceptWaitlist(
        registrationID: UUID,
        quoteID: UUID,
        expectedRegistrationVersion: Int,
        expectedEventVersion: Int,
        idempotencyKey: UUID
    ) async throws -> Registration
    func cancelRegistration(registrationID: UUID) async throws -> RegistrationCancellation
    func reportPayment(registrationID: UUID) async throws -> TicketPaymentReport
}

extension SpottAPIClient: MyActivitiesServing {}

enum MyActivityGroup: String, CaseIterable, Sendable {
    case pending
    case waitlist
    case upcoming
    case past
}

enum MyActivityNextAction: Equatable, Sendable {
    case acceptWaitlist(registrationID: UUID, expiresAt: Date)
    case cancelRegistration(UUID)
    case reportPayment(UUID)
    case checkIn(registrationID: UUID, event: EventRouteReference)
    case correctAttendance(registrationID: UUID, event: EventRouteReference)
    case leaveFeedback(registrationID: UUID, event: EventRouteReference)
    case viewStatus(UUID)
    case viewEvent(EventRouteReference)
    case none
}

struct MyActivityItem: Identifiable, Sendable {
    let registration: Registration
    let event: ItineraryEventSummary?
    let group: MyActivityGroup
    let nextAction: MyActivityNextAction
    let cancellationAction: MyActivityNextAction?

    var id: UUID { registration.id }
}

struct MyActivitiesSection: Identifiable, Sendable {
    let group: MyActivityGroup
    let items: [MyActivityItem]

    var id: MyActivityGroup { group }
}

struct WaitlistAcceptanceReview: Identifiable, Sendable {
    let registrationID: UUID
    let eventID: UUID
    let eventTitle: String
    let partySize: Int
    let offerExpiresAt: Date
    let quote: Quote
    let expectedRegistrationVersion: Int
    let expectedEventVersion: Int
    let idempotencyKey: UUID

    var id: UUID { idempotencyKey }
}

@MainActor
@Observable
final class MyActivitiesStore {
    private(set) var items: [MyActivityItem] = []
    private(set) var sections: [MyActivitiesSection] = []
    private(set) var error: UserFacingError?
    private(set) var isLoading = false
    private(set) var actionInFlight: UUID?
    private(set) var nextTemporalRefreshDate: Date?
    private(set) var waitlistAcceptanceReview: WaitlistAcceptanceReview?
    private(set) var reportedPaymentRegistrationIDs: Set<UUID> = []

    @ObservationIgnored private let service: any MyActivitiesServing
    @ObservationIgnored private let locale: Locale
    @ObservationIgnored private let clock: @Sendable () -> Date
    @ObservationIgnored private var sourceItems: [RegistrationItineraryItem] = []
    @ObservationIgnored private var serverReferenceTime: Date?
    @ObservationIgnored private var localReferenceTime: Date?
    @ObservationIgnored private var refreshGeneration = 0
    @ObservationIgnored private var activeRefreshCount = 0

    init(
        service: any MyActivitiesServing,
        locale: Locale = .current,
        clock: (@Sendable () -> Date)? = nil
    ) {
        self.service = service
        self.locale = locale
        self.clock = clock ?? { service.authoritativeNow() }
    }

    func section(_ group: MyActivityGroup) -> MyActivitiesSection {
        sections.first(where: { $0.group == group })
            ?? .init(group: group, items: [])
    }

    func refresh() async {
        refreshGeneration += 1
        let generation = refreshGeneration
        activeRefreshCount += 1
        isLoading = true
        defer {
            activeRefreshCount -= 1
            isLoading = activeRefreshCount > 0
        }
        do {
            let result = try await loadCompleteItinerary()
            try Task.checkCancellation()
            guard generation == refreshGeneration else { return }
            sourceItems = result.items
            serverReferenceTime = result.serverTime
            localReferenceTime = clock()
            error = nil
            rebuild(at: result.serverTime)
        } catch is CancellationError {
            return
        } catch {
            guard generation == refreshGeneration else { return }
            self.error = map(error)
        }
    }

    func refreshTemporalState() {
        guard !sourceItems.isEmpty else { return }
        rebuild(at: authoritativeNow)
    }

    func temporalRefreshDelay() -> TimeInterval? {
        guard let nextTemporalRefreshDate else { return nil }
        return max(0, nextTemporalRefreshDate.timeIntervalSince(authoritativeNow))
    }

    func perform(_ action: MyActivityNextAction) async {
        let registrationID: UUID
        switch action {
        case .acceptWaitlist(let id, let expiry):
            guard expiry > authoritativeNow else {
                refreshTemporalState()
                error = .init(
                    id: "WAITLIST_OFFER_EXPIRED",
                    message: localized("journey.error.offer_expired"),
                    retryable: false
                )
                return
            }
            registrationID = id
        case .cancelRegistration(let id):
            registrationID = id
        case .reportPayment(let id):
            guard !reportedPaymentRegistrationIDs.contains(id) else { return }
            registrationID = id
        case .checkIn, .correctAttendance, .leaveFeedback, .viewStatus, .viewEvent, .none:
            return
        }
        guard actionInFlight == nil else { return }
        actionInFlight = registrationID
        error = nil
        defer { actionInFlight = nil }
        do {
            switch action {
            case .acceptWaitlist(let id, let offerExpiresAt):
                guard let item = items.first(where: { $0.registration.id == id }),
                      let event = item.event else {
                    throw MyActivitiesStoreError.missingEventVersion
                }
                let quote = try await service.quote(
                    purpose: "registration",
                    resourceID: item.registration.eventId
                )
                try Task.checkCancellation()
                waitlistAcceptanceReview = .init(
                    registrationID: id,
                    eventID: item.registration.eventId,
                    eventTitle: event.title,
                    partySize: item.registration.partySize,
                    offerExpiresAt: offerExpiresAt,
                    quote: quote,
                    expectedRegistrationVersion: item.registration.version,
                    expectedEventVersion: event.version,
                    idempotencyKey: UUID()
                )
                return
            case .cancelRegistration(let id):
                _ = try await service.cancelRegistration(registrationID: id)
            case .reportPayment(let id):
                _ = try await service.reportPayment(registrationID: id)
                try Task.checkCancellation()
                reportedPaymentRegistrationIDs.insert(id)
                // The itinerary payload carries no payment state yet, so the
                // reported chip is session-local; no refresh is needed.
                return
            case .checkIn, .correctAttendance, .leaveFeedback, .viewStatus, .viewEvent, .none:
                return
            }
            try Task.checkCancellation()
            await refresh()
        } catch is CancellationError {
            return
        } catch {
            self.error = map(error)
        }
    }

    func confirmWaitlistAcceptance() async {
        guard let review = waitlistAcceptanceReview,
              actionInFlight == nil else { return }
        guard review.offerExpiresAt > authoritativeNow else {
            waitlistAcceptanceReview = nil
            refreshTemporalState()
            error = .init(
                id: "WAITLIST_OFFER_EXPIRED",
                message: localized("journey.error.offer_expired"),
                retryable: false
            )
            return
        }
        guard review.quote.expiresAt > authoritativeNow else {
            waitlistAcceptanceReview = nil
            error = .init(
                id: "QUOTE_EXPIRED",
                message: localized("journey.error.quote_expired"),
                retryable: true
            )
            return
        }

        actionInFlight = review.registrationID
        error = nil
        defer { actionInFlight = nil }
        do {
            _ = try await service.acceptWaitlist(
                registrationID: review.registrationID,
                quoteID: review.quote.id,
                expectedRegistrationVersion: review.expectedRegistrationVersion,
                expectedEventVersion: review.expectedEventVersion,
                idempotencyKey: review.idempotencyKey
            )
            try Task.checkCancellation()
            waitlistAcceptanceReview = nil
            await refresh()
        } catch is CancellationError {
            return
        } catch {
            if let apiError = error as? APIError,
               ["EVENT_CHANGED", "REGISTRATION_CHANGED", "WAITLIST_OFFER_EXPIRED"]
                .contains(apiError.code) {
                waitlistAcceptanceReview = nil
                await refresh()
            }
            self.error = map(error)
        }
    }

    func dismissWaitlistAcceptanceReview() {
        guard actionInFlight == nil else { return }
        waitlistAcceptanceReview = nil
    }

    func hasReportedPayment(_ registrationID: UUID) -> Bool {
        reportedPaymentRegistrationIDs.contains(registrationID)
    }

    private var authoritativeNow: Date {
        guard let serverReferenceTime, let localReferenceTime else { return clock() }
        let elapsed = max(0, clock().timeIntervalSince(localReferenceTime))
        return serverReferenceTime.addingTimeInterval(elapsed)
    }

    private func loadCompleteItinerary() async throws -> (
        items: [RegistrationItineraryItem],
        serverTime: Date
    ) {
        var allItems: [RegistrationItineraryItem] = []
        var cursor: String?
        var seenCursors: Set<String> = []
        var latestServerTime: Date?

        while true {
            let page = try await service.registrationItinerary(cursor: cursor, limit: 100)
            try Task.checkCancellation()
            allItems.append(contentsOf: page.items)
            latestServerTime = page.serverTime
            guard page.hasMore else { break }
            guard let nextCursor = page.nextCursor?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !nextCursor.isEmpty,
                  seenCursors.insert(nextCursor).inserted else {
                throw MyActivitiesStoreError.invalidCursor
            }
            cursor = nextCursor
        }

        return (allItems, latestServerTime ?? clock())
    }

    private func rebuild(at now: Date) {
        let mapped = sourceItems.map { item in
            Self.makeItem(item, serverTime: now)
        }
        items = mapped.sorted { Self.ordersBefore($0, $1, serverTime: now) }
        sections = MyActivityGroup.allCases.map { group in
            .init(group: group, items: items.filter { $0.group == group })
        }
        nextTemporalRefreshDate = Self.nextTemporalBoundary(
            in: sourceItems,
            after: now
        )
    }

    private static func makeItem(
        _ item: RegistrationItineraryItem,
        serverTime: Date
    ) -> MyActivityItem {
        let group = group(for: item, serverTime: serverTime)
        return .init(
            registration: item.registration,
            event: item.event,
            group: group,
            nextAction: nextAction(for: item, serverTime: serverTime),
            cancellationAction: cancellationAction(for: item)
        )
    }

    private static func group(
        for item: RegistrationItineraryItem,
        serverTime: Date
    ) -> MyActivityGroup {
        if eventHasEnded(item.event, serverTime: serverTime) {
            return .past
        }
        switch item.registration.status {
        case "pending": return .pending
        case "waitlisted", "offered": return .waitlist
        case "cancelled", "rejected", "expired", "no_show", "correction_pending",
             "attendance_disputed", "event_cancelled", "final":
            return .past
        default: break
        }
        return .upcoming
    }

    private static func nextAction(
        for item: RegistrationItineraryItem,
        serverTime: Date
    ) -> MyActivityNextAction {
        let actions = item.registration.availableActions ?? []
        if item.registration.status == "offered",
           !eventHasEnded(item.event, serverTime: serverTime),
           actions.contains(.register),
           let expiry = item.registration.offerExpiresAt,
           expiry > serverTime {
            return .acceptWaitlist(
                registrationID: item.registration.id,
                expiresAt: expiry
            )
        }
        if item.registration.status == "confirmed",
           actions.contains(.checkIn),
           let event = item.event {
            return .checkIn(
                registrationID: item.registration.id,
                event: .init(id: event.id, slug: event.publicSlug)
            )
        }
        if ["confirmed", "no_show", "attendance_disputed"].contains(item.registration.status),
           isWithinPostEventWindow(item, serverTime: serverTime, duration: 48 * 60 * 60),
           let event = item.event {
            return .correctAttendance(
                registrationID: item.registration.id,
                event: .init(id: event.id, slug: event.publicSlug)
            )
        }
        if item.registration.status == "checked_in",
           isWithinPostEventWindow(item, serverTime: serverTime, duration: 30 * 24 * 60 * 60),
           let event = item.event {
            return .leaveFeedback(
                registrationID: item.registration.id,
                event: .init(id: event.id, slug: event.publicSlug)
            )
        }
        if ["pending", "waitlisted", "offered"].contains(item.registration.status) {
            return .viewStatus(item.registration.id)
        }
        if let event = item.event {
            return .viewEvent(.init(id: event.id, slug: event.publicSlug))
        }
        return .none
    }

    private static func eventHasEnded(
        _ event: ItineraryEventSummary?,
        serverTime: Date
    ) -> Bool {
        guard let event else { return false }
        if ["ended", "cancelled", "archived"].contains(event.status) {
            return true
        }
        return event.endsAt.map { $0 < serverTime } == true
    }

    private static func cancellationAction(
        for item: RegistrationItineraryItem
    ) -> MyActivityNextAction? {
        guard (item.registration.availableActions ?? []).contains(.cancelRegistration) else {
            return nil
        }
        return .cancelRegistration(item.registration.id)
    }

    private static func isWithinPostEventWindow(
        _ item: RegistrationItineraryItem,
        serverTime: Date,
        duration: TimeInterval
    ) -> Bool {
        guard let endsAt = item.event?.endsAt else { return false }
        return serverTime >= endsAt && serverTime <= endsAt.addingTimeInterval(duration)
    }

    private static func ordersBefore(
        _ lhs: MyActivityItem,
        _ rhs: MyActivityItem,
        serverTime: Date
    ) -> Bool {
        if lhs.group != rhs.group {
            return order(of: lhs.group) < order(of: rhs.group)
        }
        switch lhs.group {
        case .pending:
            return updatedDescending(lhs, rhs)
        case .waitlist:
            let lhsExpiry = activeOfferExpiry(lhs, serverTime: serverTime)
            let rhsExpiry = activeOfferExpiry(rhs, serverTime: serverTime)
            switch (lhsExpiry, rhsExpiry) {
            case let (.some(left), .some(right)) where left != right:
                return left < right
            case (.some, .none):
                return true
            case (.none, .some):
                return false
            default:
                return updatedDescending(lhs, rhs)
            }
        case .upcoming:
            let lhsStart = lhs.event?.startsAt ?? .distantFuture
            let rhsStart = rhs.event?.startsAt ?? .distantFuture
            return lhsStart == rhsStart ? updatedDescending(lhs, rhs) : lhsStart < rhsStart
        case .past:
            let lhsEnd = lhs.event?.endsAt ?? lhs.registration.updatedAt ?? .distantPast
            let rhsEnd = rhs.event?.endsAt ?? rhs.registration.updatedAt ?? .distantPast
            return lhsEnd == rhsEnd ? updatedDescending(lhs, rhs) : lhsEnd > rhsEnd
        }
    }

    private static func updatedDescending(
        _ lhs: MyActivityItem,
        _ rhs: MyActivityItem
    ) -> Bool {
        let lhsUpdated = lhs.registration.updatedAt ?? .distantPast
        let rhsUpdated = rhs.registration.updatedAt ?? .distantPast
        if lhsUpdated != rhsUpdated { return lhsUpdated > rhsUpdated }
        return lhs.registration.id.uuidString > rhs.registration.id.uuidString
    }

    private static func activeOfferExpiry(
        _ item: MyActivityItem,
        serverTime: Date
    ) -> Date? {
        guard item.registration.status == "offered",
              let expiry = item.registration.offerExpiresAt,
              expiry > serverTime else { return nil }
        return expiry
    }

    private static func nextTemporalBoundary(
        in items: [RegistrationItineraryItem],
        after serverTime: Date
    ) -> Date? {
        items.flatMap { item -> [Date] in
            var boundaries: [Date] = []
            if item.registration.status == "offered",
               let expiry = item.registration.offerExpiresAt,
               expiry > serverTime {
                boundaries.append(expiry)
            }
            if let endsAt = item.event?.endsAt {
                if endsAt > serverTime { boundaries.append(endsAt) }
                let justAfterEnd = endsAt.addingTimeInterval(0.01)
                if justAfterEnd > serverTime { boundaries.append(justAfterEnd) }
                let correctionClose = endsAt.addingTimeInterval(48 * 60 * 60 + 0.01)
                if correctionClose > serverTime { boundaries.append(correctionClose) }
                let feedbackClose = endsAt.addingTimeInterval(30 * 24 * 60 * 60 + 0.01)
                if feedbackClose > serverTime { boundaries.append(feedbackClose) }
            }
            return boundaries
        }.min()
    }

    private static func order(of group: MyActivityGroup) -> Int {
        switch group {
        case .pending: 0
        case .waitlist: 1
        case .upcoming: 2
        case .past: 3
        }
    }

    private func map(_ error: Error) -> UserFacingError {
        if let apiError = error as? APIError {
            if apiError.code == "TICKET_PAYMENT_NOT_APPLICABLE" {
                return .init(
                    id: apiError.code,
                    message: RegistrationExtrasLocalization.text(
                        "regextras.payment.not_applicable",
                        locale: locale
                    ),
                    retryable: false
                )
            }
            return .init(
                id: apiError.code,
                message: apiError.code == "WAITLIST_OFFER_EXPIRED"
                    ? localized("journey.error.offer_expired")
                    : localized("journey.error.action"),
                retryable: apiError.retryable
            )
        }
        if case MyActivitiesStoreError.invalidCursor = error {
            return .init(
                id: "ITINERARY_CURSOR_INVALID",
                message: localized("journey.error.itinerary_cursor"),
                retryable: true
            )
        }
        if case MyActivitiesStoreError.missingEventVersion = error {
            return .init(
                id: "EVENT_VERSION_UNAVAILABLE",
                message: localized("journey.error.content_changed"),
                retryable: true
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

    private enum MyActivitiesStoreError: Error {
        case invalidCursor
        case missingEventVersion
    }
}
