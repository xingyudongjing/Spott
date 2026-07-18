import Foundation
import Observation
import SwiftUI

struct EventActionBarLayoutPolicy {
    let dynamicTypeSize: DynamicTypeSize

    var showsSupportingTextInBar: Bool { !dynamicTypeSize.isAccessibilitySize }
    var pinsActionBar: Bool { !dynamicTypeSize.isAccessibilitySize }
    var actionFillsWidth: Bool { dynamicTypeSize.isAccessibilitySize }
    var actionLineLimit: Int? { dynamicTypeSize.isAccessibilitySize ? nil : 2 }
}

enum EventDetailServerAction: Equatable, Hashable, Identifiable, Sendable {
    case checkIn(registrationID: UUID)
    case openGroup(groupID: UUID)
    case cancelRegistration(registrationID: UUID)

    var id: String {
        switch self {
        case .checkIn(let registrationID):
            "check-in-\(registrationID.uuidString.lowercased())"
        case .openGroup(let groupID):
            "open-group-\(groupID.uuidString.lowercased())"
        case .cancelRegistration(let registrationID):
            "cancel-registration-\(registrationID.uuidString.lowercased())"
        }
    }

    var eventAction: EventAction {
        switch self {
        case .checkIn: .checkIn
        case .openGroup: .joinGroup
        case .cancelRegistration: .cancelRegistration
        }
    }

    var requiresTrustGate: Bool {
        switch self {
        case .checkIn, .cancelRegistration:
            true
        case .openGroup:
            false
        }
    }
}

enum EventDetailServerActionPolicy {
    static func resolve(
        event: EventSummary,
        viewerSnapshotIsCurrent: Bool
    ) -> [EventDetailServerAction] {
        guard viewerSnapshotIsCurrent else { return [] }

        var result: [EventDetailServerAction] = []
        if event.availableActions.contains(.checkIn),
           let registrationID = event.viewerRegistration?.id {
            result.append(.checkIn(registrationID: registrationID))
        }
        if let groupID = event.groupId {
            result.append(.openGroup(groupID: groupID))
        }
        if event.availableActions.contains(.cancelRegistration),
           let registrationID = event.viewerRegistration?.id {
            result.append(.cancelRegistration(registrationID: registrationID))
        }
        return result
    }

    static func canGeneratePoster(event: EventSummary, viewerID: UUID?) -> Bool {
        viewerID == event.organizerId
    }
}

@MainActor
enum EventDetailLinkedGroupNavigation {
    static func open(
        groupID: UUID,
        sourceTab: AppTab,
        router: AppRouter
    ) {
        router.push(.group(groupID), in: sourceTab)
    }
}

enum EventDetailActionLoadOutcome<Value: Sendable>: Sendable {
    case authorized(Value)
    case revoked
    case missing
}

enum EventDetailActionAuthorizer {
    static func isAuthorized(
        _ action: EventDetailServerAction,
        event: EventSummary,
        viewerSnapshotIsCurrent: Bool
    ) -> Bool {
        EventDetailServerActionPolicy.resolve(
            event: event,
            viewerSnapshotIsCurrent: viewerSnapshotIsCurrent
        ).contains(action)
    }

    @MainActor
    static func revalidatedValue<Value: Sendable>(
        for action: EventDetailServerAction,
        currentSnapshot: () -> (
            event: EventSummary,
            viewerSnapshotIsCurrent: Bool
        ),
        load: () async throws -> Value?
    ) async rethrows -> EventDetailActionLoadOutcome<Value> {
        let initial = currentSnapshot()
        guard isAuthorized(
            action,
            event: initial.event,
            viewerSnapshotIsCurrent: initial.viewerSnapshotIsCurrent
        ) else { return .revoked }

        let value = try await load()
        let latest = currentSnapshot()
        guard isAuthorized(
            action,
            event: latest.event,
            viewerSnapshotIsCurrent: latest.viewerSnapshotIsCurrent
        ) else { return .revoked }
        guard let value else { return .missing }
        return .authorized(value)
    }

    @MainActor
    static func authorizedMutation<Value: Sendable>(
        for action: EventDetailServerAction,
        currentSnapshot: () -> (
            event: EventSummary,
            viewerSnapshotIsCurrent: Bool
        ),
        mutation: () async throws -> Value
    ) async rethrows -> EventDetailActionLoadOutcome<Value> {
        let latest = currentSnapshot()
        guard isAuthorized(
            action,
            event: latest.event,
            viewerSnapshotIsCurrent: latest.viewerSnapshotIsCurrent
        ) else { return .revoked }
        return .authorized(try await mutation())
    }
}

struct EventDetailActionTaskContext: Equatable, Sendable {
    let epoch: UUID
    let sessionFingerprint: String
    let eventID: UUID
    let action: EventDetailServerAction

    init(
        epoch: UUID = UUID(),
        sessionFingerprint: String,
        eventID: UUID,
        action: EventDetailServerAction
    ) {
        self.epoch = epoch
        self.sessionFingerprint = sessionFingerprint
        self.eventID = eventID
        self.action = action
    }
}

enum EventDetailActionTaskContextPolicy {
    static func isCurrent(
        _ context: EventDetailActionTaskContext,
        sessionFingerprint: String,
        eventID: UUID,
        activeContext: EventDetailActionTaskContext?
    ) -> Bool {
        activeContext == context
            && context.sessionFingerprint == sessionFingerprint
            && context.eventID == eventID
    }
}

enum EventDetailActionErrorMapper {
    static func map(_ error: Error, locale: Locale) -> UserFacingError {
        if let vaultError = error as? VaultError {
            switch vaultError {
            case .status:
                return localized(
                    id: "SECURE_SESSION_UNAVAILABLE",
                    key: "journey.action_error.secure_session_unavailable",
                    retryable: true,
                    locale: locale
                )
            case .invalidSession:
                return localized(
                    id: "SECURE_SESSION_INVALID",
                    key: "journey.action_error.secure_session_invalid",
                    retryable: false,
                    locale: locale
                )
            }
        }

        if let apiError = error as? APIError {
            let key: String.LocalizationValue
            switch apiError.code {
            case "CHALLENGE_EXPIRED":
                key = "journey.action_error.challenge_expired"
            case "OTP_RATE_LIMITED":
                key = "journey.action_error.rate_limited"
            case "AUTH_CREDENTIAL_INVALID", "PHONE_VERIFICATION_FAILED":
                key = "journey.action_error.credential_invalid"
            case "PHONE_ALREADY_BOUND", "PHONE_BINDING_CONFLICT":
                key = "journey.action_error.phone_conflict"
            case "TOKEN_EXPIRED", "TOKEN_INVALID", "SESSION_NOT_FOUND", "REFRESH_TOKEN_REUSED":
                key = "journey.action_error.session_expired"
            case "VERSION_CONFLICT", "EVENT_CHANGED", "EVENT_VERSION_CONFLICT":
                key = "journey.action_error.content_changed"
            default:
                switch apiError.status {
                case 401:
                    key = "journey.action_error.login_required"
                case 403:
                    key = "journey.action_error.permission_denied"
                case 404:
                    key = "journey.action_error.content_unavailable"
                default:
                    key = "journey.action_error.generic"
                }
            }
            return localized(
                id: apiError.code,
                key: key,
                retryable: apiError.retryable,
                locale: locale
            )
        }

        return localized(
            id: "NETWORK_UNAVAILABLE",
            key: "journey.action_error.network",
            retryable: true,
            locale: locale
        )
    }

    private static func localized(
        id: String,
        key: String.LocalizationValue,
        retryable: Bool,
        locale: Locale
    ) -> UserFacingError {
        .init(
            id: id,
            message: CoreJourneyLocalization.text(key, locale: locale),
            retryable: retryable
        )
    }
}

@MainActor
@Observable
final class EventDetailActionRunner {
    struct Snapshot: Sendable {
        let sessionFingerprint: String
        let event: EventSummary
        let viewerSnapshotIsCurrent: Bool
    }

    enum Effect: Sendable {
        case presentCheckIn(Registration)
        case banner(UserFacingError)
        case cancellationFinished(EventCancellationSyncOutcome)
    }

    typealias SnapshotProvider = @MainActor () -> Snapshot
    typealias RegistrationLoader = @MainActor (
        _ registrationID: UUID,
        _ eventID: UUID
    ) async throws -> Registration?
    typealias Mutation = @MainActor () async throws -> Void
    typealias CancellationRefresh = @MainActor () async -> EventCancellationSyncOutcome
    typealias EffectSink = @MainActor (Effect) -> Void

    private(set) var busyAction: EventDetailServerAction?

    @ObservationIgnored private(set) var activeTask: Task<Void, Never>?
    @ObservationIgnored private(set) var activeContext: EventDetailActionTaskContext?

    func startCheckIn(
        registrationID: UUID,
        locale: Locale,
        snapshot: @escaping SnapshotProvider,
        load: @escaping RegistrationLoader,
        emit: @escaping EffectSink
    ) {
        let action = EventDetailServerAction.checkIn(registrationID: registrationID)
        let initial = snapshot()
        guard busyAction == nil, isAuthorized(action, snapshot: initial) else { return }

        let context = EventDetailActionTaskContext(
            sessionFingerprint: initial.sessionFingerprint,
            eventID: initial.event.id,
            action: action
        )
        busyAction = action
        activeContext = context
        activeTask = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.runCheckIn(
                registrationID: registrationID,
                locale: locale,
                context: context,
                snapshot: snapshot,
                load: load,
                emit: emit
            )
        }
    }

    func startCancellation(
        registrationID: UUID,
        locale: Locale,
        snapshot: @escaping SnapshotProvider,
        mutate: @escaping Mutation,
        refresh: @escaping CancellationRefresh,
        emit: @escaping EffectSink
    ) {
        let action = EventDetailServerAction.cancelRegistration(
            registrationID: registrationID
        )
        let initial = snapshot()
        guard busyAction == nil, isAuthorized(action, snapshot: initial) else { return }

        let context = EventDetailActionTaskContext(
            sessionFingerprint: initial.sessionFingerprint,
            eventID: initial.event.id,
            action: action
        )
        busyAction = action
        activeContext = context
        activeTask = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.runCancellation(
                locale: locale,
                context: context,
                snapshot: snapshot,
                mutate: mutate,
                refresh: refresh,
                emit: emit
            )
        }
    }

    func identityDidChange() {
        cancelAll()
    }

    func eventDidChange() {
        cancelAll()
    }

    func pageDidDisappear() {
        cancelAll()
    }

    func cancelAll() {
        let task = activeTask
        activeContext = nil
        activeTask = nil
        busyAction = nil
        task?.cancel()
    }

    private func runCheckIn(
        registrationID: UUID,
        locale: Locale,
        context: EventDetailActionTaskContext,
        snapshot: @escaping SnapshotProvider,
        load: @escaping RegistrationLoader,
        emit: @escaping EffectSink
    ) async {
        defer { finish(context) }
        let action = context.action
        let queued = snapshot()
        guard isCurrent(context, snapshot: queued),
              isAuthorized(action, snapshot: queued) else { return }

        do {
            let outcome = try await EventDetailActionAuthorizer.revalidatedValue(
                for: action,
                currentSnapshot: {
                    let current = snapshot()
                    return (current.event, current.viewerSnapshotIsCurrent)
                },
                load: {
                    try await load(registrationID, context.eventID)
                }
            )

            // This is deliberately separate from the helper's post-load check. The
            // owning screen may have resumed after a newer authoritative snapshot.
            let latest = snapshot()
            guard isCurrent(context, snapshot: latest),
                  isAuthorized(action, snapshot: latest) else { return }

            switch outcome {
            case .authorized(let registration):
                emit(.presentCheckIn(registration))
            case .revoked:
                return
            case .missing:
                emit(
                    .banner(
                        EventDetailRegistrationLookupError.missing.userFacing(
                            locale: locale
                        )
                    )
                )
            }
        } catch is CancellationError {
            return
        } catch let lookupError as EventDetailRegistrationLookupError {
            let latest = snapshot()
            guard isCurrent(context, snapshot: latest),
                  isAuthorized(action, snapshot: latest) else { return }
            emit(.banner(lookupError.userFacing(locale: locale)))
        } catch {
            let latest = snapshot()
            guard isCurrent(context, snapshot: latest),
                  isAuthorized(action, snapshot: latest) else { return }
            emit(.banner(EventDetailActionErrorMapper.map(error, locale: locale)))
        }
    }

    private func runCancellation(
        locale: Locale,
        context: EventDetailActionTaskContext,
        snapshot: @escaping SnapshotProvider,
        mutate: @escaping Mutation,
        refresh: @escaping CancellationRefresh,
        emit: @escaping EffectSink
    ) async {
        defer { finish(context) }
        let action = context.action
        let queued = snapshot()
        guard isCurrent(context, snapshot: queued),
              isAuthorized(action, snapshot: queued) else { return }

        do {
            let mutation = try await EventDetailActionAuthorizer.authorizedMutation(
                for: action,
                currentSnapshot: {
                    let current = snapshot()
                    return (current.event, current.viewerSnapshotIsCurrent)
                },
                mutation: {
                    let latest = snapshot()
                    guard self.isCurrent(context, snapshot: latest),
                          self.isAuthorized(action, snapshot: latest) else {
                        throw CancellationError()
                    }
                    try Task.checkCancellation()
                    try await mutate()
                }
            )

            let afterMutation = snapshot()
            guard isCurrent(context, snapshot: afterMutation),
                  case .authorized = mutation else { return }
            let outcome = await refresh()
            let afterRefresh = snapshot()
            guard isCurrent(context, snapshot: afterRefresh) else { return }
            emit(.cancellationFinished(outcome))
        } catch is CancellationError {
            return
        } catch {
            let latest = snapshot()
            guard isCurrent(context, snapshot: latest),
                  isAuthorized(action, snapshot: latest) else { return }
            emit(.banner(EventDetailActionErrorMapper.map(error, locale: locale)))
        }
    }

    private func isAuthorized(
        _ action: EventDetailServerAction,
        snapshot: Snapshot
    ) -> Bool {
        EventDetailActionAuthorizer.isAuthorized(
            action,
            event: snapshot.event,
            viewerSnapshotIsCurrent: snapshot.viewerSnapshotIsCurrent
        )
    }

    private func isCurrent(
        _ context: EventDetailActionTaskContext,
        snapshot: Snapshot
    ) -> Bool {
        EventDetailActionTaskContextPolicy.isCurrent(
            context,
            sessionFingerprint: snapshot.sessionFingerprint,
            eventID: snapshot.event.id,
            activeContext: activeContext
        )
    }

    private func finish(_ context: EventDetailActionTaskContext) {
        guard activeContext == context else { return }
        activeContext = nil
        activeTask = nil
        if busyAction == context.action { busyAction = nil }
    }
}

struct EventDetailServerActionPresentation: Equatable, Sendable {
    let title: String
    let systemImage: String
    let isDestructive: Bool

    init(action: EventDetailServerAction, locale: Locale) {
        let titleKey: String.LocalizationValue
        switch action {
        case .checkIn:
            titleKey = "journey.detail.action.check_in"
            systemImage = "qrcode.viewfinder"
            isDestructive = false
        case .openGroup:
            titleKey = "journey.detail.action.open_group"
            systemImage = "person.3.fill"
            isDestructive = false
        case .cancelRegistration:
            titleKey = "journey.detail.action.cancel_registration"
            systemImage = "xmark.circle"
            isDestructive = true
        }
        title = CoreJourneyLocalization.text(titleKey, locale: locale)
    }
}

enum EventShareDestinationPolicy {
    @MainActor
    static func resolve(
        event: EventSummary,
        authenticated: Bool,
        attributedURL: () async throws -> URL
    ) async -> URL {
        let fallback = URL(string: "https://spott.jp/e/\(event.publicSlug)")
            ?? URL(string: "https://spott.jp")!
        guard authenticated else { return fallback }
        return (try? await attributedURL()) ?? fallback
    }
}

enum EventDetailRegistrationLookupError: Error, Equatable {
    case invalidCursor
    case missing

    func userFacing(locale: Locale) -> UserFacingError {
        switch self {
        case .invalidCursor:
            .init(
                id: "REGISTRATION_CURSOR_INVALID",
                message: CoreJourneyLocalization.text(
                    "journey.error.registration_cursor_invalid",
                    locale: locale
                ),
                retryable: false
            )
        case .missing:
            .init(
                id: "REGISTRATION_NOT_FOUND",
                message: CoreJourneyLocalization.text(
                    "journey.error.registration_missing",
                    locale: locale
                ),
                retryable: false
            )
        }
    }
}

enum EventDetailRegistrationLookup {
    @MainActor
    static func find(
        registrationID: UUID,
        eventID: UUID,
        loadPage: (String?, Int) async throws -> CursorPage<Registration>
    ) async throws -> Registration? {
        var cursor: String?
        var seenCursors: Set<String> = []

        while true {
            let page = try await loadPage(cursor, 100)
            try Task.checkCancellation()
            if let registration = page.items.first(where: {
                $0.id == registrationID && $0.eventId == eventID
            }) {
                return registration
            }
            guard page.hasMore else { return nil }
            guard let nextCursor = page.nextCursor?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !nextCursor.isEmpty,
                  seenCursors.insert(nextCursor).inserted else {
                throw EventDetailRegistrationLookupError.invalidCursor
            }
            cursor = nextCursor
        }
    }
}

enum EventCancellationSyncOutcome: Equatable, Sendable {
    case synced
    case refreshFailed
}

enum EventCancellationSyncPolicy {
    static func outcome(
        viewerSnapshotIsCurrent: Bool,
        refreshError: UserFacingError?
    ) -> EventCancellationSyncOutcome {
        viewerSnapshotIsCurrent && refreshError == nil ? .synced : .refreshFailed
    }
}

struct EventPosterPresentation: Sendable {
    let backendLocaleIdentifier: String
    private let locale: Locale

    init(locale: Locale) {
        let normalized = locale.identifier
            .split(separator: "@", maxSplits: 1)
            .first
            .map(String.init)?
            .replacingOccurrences(of: "_", with: "-")
            .lowercased() ?? "en"
        let language = normalized.split(separator: "-", maxSplits: 1).first.map(String.init)
        switch language {
        case "zh": backendLocaleIdentifier = "zh-Hans"
        case "ja": backendLocaleIdentifier = "ja"
        default: backendLocaleIdentifier = "en"
        }
        self.locale = Locale(identifier: backendLocaleIdentifier)
    }

    func text(_ key: String.LocalizationValue) -> String {
        CoreJourneyLocalization.text(key, locale: locale)
    }
}

struct EventDetailActionPresentation: Equatable, Sendable {
    let kind: EventCTAState.Kind
    let title: String
    let supportingText: String
    let systemImage: String
    let isDisabled: Bool

    init(state: EventCTAState, locale: Locale) {
        kind = state.kind
        isDisabled = state.disabled
        let titleKey: String.LocalizationValue
        let supportingKey: String.LocalizationValue
        switch state.kind {
        case .eventUnavailable:
            titleKey = "journey.cta.event_unavailable.title"
            supportingKey = "journey.cta.event_unavailable.support"
        case .acceptWaitlist:
            titleKey = "journey.cta.accept_waitlist.title"
            supportingKey = "journey.cta.accept_waitlist.support"
        case .viewItinerary:
            titleKey = "journey.cta.view_itinerary.title"
            supportingKey = "journey.cta.view_itinerary.support"
        case .viewPending:
            titleKey = "journey.cta.view_pending.title"
            supportingKey = "journey.cta.view_pending.support"
        case .viewWaitlist:
            titleKey = "journey.cta.view_waitlist.title"
            supportingKey = "journey.cta.view_waitlist.support"
        case .continueLogin:
            titleKey = "journey.cta.continue_login.title"
            supportingKey = "journey.cta.continue_login.support"
        case .continuePhoneVerification:
            titleKey = "journey.cta.continue_phone.title"
            supportingKey = "journey.cta.continue_phone.support"
        case .registrationClosed:
            titleKey = "journey.cta.registration_closed.title"
            supportingKey = "journey.cta.registration_closed.support"
        case .joinWaitlist:
            titleKey = "journey.cta.join_waitlist.title"
            supportingKey = "journey.cta.join_waitlist.support"
        case .fullClosed:
            titleKey = "journey.cta.full_closed.title"
            supportingKey = "journey.cta.full_closed.support"
        case .apply:
            titleKey = "journey.cta.apply.title"
            supportingKey = "journey.cta.apply.support"
        case .register:
            titleKey = "journey.cta.register.title"
            supportingKey = "journey.cta.register.support"
        }
        title = CoreJourneyLocalization.text(titleKey, locale: locale)
        supportingText = CoreJourneyLocalization.text(supportingKey, locale: locale)
        systemImage = Self.systemImage(for: state.kind)
    }

    private static func systemImage(for kind: EventCTAState.Kind) -> String {
        switch kind {
        case .eventUnavailable, .registrationClosed, .fullClosed:
            "calendar.badge.exclamationmark"
        case .acceptWaitlist:
            "checkmark.seal.fill"
        case .viewItinerary, .viewPending, .viewWaitlist:
            "calendar.badge.clock"
        case .continueLogin:
            "person.crop.circle.badge.checkmark"
        case .continuePhoneVerification:
            "phone.badge.checkmark"
        case .joinWaitlist:
            "person.crop.circle.badge.plus"
        case .apply:
            "doc.text.fill"
        case .register:
            "ticket.fill"
        }
    }
}

struct EventActionBar: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let presentation: EventDetailActionPresentation
    let isBusy: Bool
    let action: () -> Void

    var body: some View {
        actionSurface
            .background(
                Color(uiColor: .secondarySystemGroupedBackground).opacity(0.96),
                in: RoundedRectangle(cornerRadius: 24, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .stroke(Color.primary.opacity(0.08), lineWidth: 0.5)
            }
        .padding(.horizontal, 12)
        .padding(.bottom, 5)
    }

    private var actionSurface: some View {
        Group {
            if layoutPolicy.showsSupportingTextInBar {
                ViewThatFits(in: .horizontal) {
                    horizontalActionSurface
                    verticalActionSurface
                }
            } else {
                EventPrimaryActionButton(
                    presentation: presentation,
                    isBusy: isBusy,
                    fillsWidth: true,
                    lineLimit: layoutPolicy.actionLineLimit,
                    action: action
                )
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
    }

    private var layoutPolicy: EventActionBarLayoutPolicy {
        EventActionBarLayoutPolicy(dynamicTypeSize: dynamicTypeSize)
    }

    private var horizontalActionSurface: some View {
        HStack(spacing: 14) {
            supportingText
            .frame(maxWidth: .infinity, alignment: .leading)

            EventPrimaryActionButton(
                presentation: presentation,
                isBusy: isBusy,
                fillsWidth: false,
                lineLimit: layoutPolicy.actionLineLimit,
                action: action
            )
        }
    }

    private var verticalActionSurface: some View {
        VStack(alignment: .leading, spacing: 10) {
            supportingText
            EventPrimaryActionButton(
                presentation: presentation,
                isBusy: isBusy,
                fillsWidth: true,
                lineLimit: layoutPolicy.actionLineLimit,
                action: action
            )
        }
    }

    private var supportingText: some View {
        Text(presentation.supportingText)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct EventPrimaryActionButton: View {
    let presentation: EventDetailActionPresentation
    let isBusy: Bool
    let fillsWidth: Bool
    let lineLimit: Int?
    let action: () -> Void

    var body: some View {
        Group {
            if #available(iOS 26.0, *) {
                button.buttonStyle(.glassProminent)
            } else {
                button
                    .buttonStyle(.borderedProminent)
                    .tint(SpottColor.twilight)
            }
        }
        .disabled(presentation.isDisabled || isBusy)
        .accessibilityIdentifier("event.action.\(presentation.kind.rawValue)")
    }

    private var button: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                if isBusy {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: presentation.systemImage)
                }
                Text(presentation.title)
                    .lineLimit(lineLimit)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: fillsWidth ? .infinity : nil, minHeight: 44)
        }
        .buttonBorderShape(
            lineLimit == nil
                ? .roundedRectangle(radius: SpottMetric.controlRadius)
                : .capsule
        )
    }
}
