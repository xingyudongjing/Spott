import Foundation
import Observation

protocol EventDetailServing: AuthoritativeTimeProviding {
    func event(identifier: String) async throws -> EventSummary
}

extension SpottAPIClient: EventDetailServing {}

enum EventLocationDisclosure: Equatable, Sendable {
    case exact(publicArea: String, address: String, coordinate: EventCoordinate?)
    case approximate(String)
    case unavailable
}

@MainActor
@Observable
final class EventDetailStore {
    private(set) var event: EventSummary
    private(set) var error: UserFacingError?
    private(set) var isRefreshing = false
    private(set) var temporalRevision = 0
    var session: EventCTASession

    @ObservationIgnored private let service: any EventDetailServing
    @ObservationIgnored private let locale: Locale
    @ObservationIgnored private let clock: @Sendable () -> Date
    @ObservationIgnored private var refreshTask: Task<EventSummary, Error>?
    @ObservationIgnored private var generation = 0

    init(
        initialEvent: EventSummary,
        service: any EventDetailServing,
        session: EventCTASession,
        locale: Locale = .current,
        clock: (@Sendable () -> Date)? = nil
    ) {
        event = initialEvent
        self.service = service
        self.session = session
        self.locale = locale
        self.clock = clock ?? { service.authoritativeNow() }
    }

    convenience init(
        initialEvent: EventSummary,
        service: any EventDetailServing,
        session: EventCTASession,
        locale: Locale = .current,
        now: Date
    ) {
        self.init(
            initialEvent: initialEvent,
            service: service,
            session: session,
            locale: locale,
            clock: { now }
        )
    }

    var ctaState: EventCTAState {
        _ = temporalRevision
        return EventCTAState.resolve(event: event, session: session, now: clock())
    }

    func ctaState(at date: Date) -> EventCTAState {
        EventCTAState.resolve(event: event, session: session, now: date)
    }

    var nextTemporalRefreshDate: Date? {
        let now = clock()
        if let registration = event.viewerRegistration {
            guard registration.status == .offered,
                  let expiry = registration.offerExpiresAt,
                  expiry > now else { return nil }
            return expiry
        }
        guard let deadline = event.deadlineAt, deadline > now else { return nil }
        return deadline
    }

    func temporalRefreshDelay() -> TimeInterval? {
        guard let nextTemporalRefreshDate else { return nil }
        return max(0, nextTemporalRefreshDate.timeIntervalSince(clock()))
    }

    func refreshTemporalState() {
        temporalRevision &+= 1
    }

    var locationDisclosure: EventLocationDisclosure {
        let publicArea = event.publicArea?.trimmingCharacters(in: .whitespacesAndNewlines)
        let exactAddress = event.exactAddress?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let publicArea, !publicArea.isEmpty,
           let exactAddress, !exactAddress.isEmpty {
            return .exact(
                publicArea: publicArea,
                address: exactAddress,
                coordinate: event.coordinate?.precision == .exact ? event.coordinate : nil
            )
        }
        if let publicArea, !publicArea.isEmpty {
            return .approximate(publicArea)
        }
        return .unavailable
    }

    func refresh() async {
        refreshTask?.cancel()
        generation += 1
        let requestGeneration = generation
        isRefreshing = true
        error = nil
        let identifier = event.publicSlug.isEmpty
            ? event.id.uuidString.lowercased()
            : event.publicSlug
        let request = Task { [service] in
            try await service.event(identifier: identifier)
        }
        refreshTask = request

        do {
            let refreshed = try await request.value
            try Task.checkCancellation()
            guard requestGeneration == generation else { return }
            if hasIncompletePublishedContract(refreshed) {
                error = .init(
                    id: "EVENT_DATA_INCOMPLETE",
                    message: localized("journey.error.event_incomplete"),
                    retryable: false
                )
            } else {
                event = refreshed
            }
        } catch is CancellationError {
            // A newer refresh or the owning view cancelled this result.
        } catch {
            guard requestGeneration == generation else { return }
            self.error = map(error)
        }

        if requestGeneration == generation {
            isRefreshing = false
            refreshTask = nil
        }
    }

    private func hasIncompletePublishedContract(_ event: EventSummary) -> Bool {
        guard ["published", "registration_closed", "in_progress"].contains(event.status) else {
            return false
        }
        guard event.fee != nil else { return true }
        guard event.format != .online else { return false }
        let missingRegion = event.region?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false
        let missingPublicArea = event.publicArea?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false
        return missingRegion || missingPublicArea
    }

    private func map(_ error: Error) -> UserFacingError {
        if let apiError = error as? APIError {
            return .init(
                id: apiError.code,
                message: localized("journey.error.action"),
                retryable: apiError.retryable
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
}
