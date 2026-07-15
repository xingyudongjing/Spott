import Foundation
import Observation
import SwiftUI

enum AppTab: Hashable, CaseIterable, Sendable {
    case discovery
    case groups
    case create
    case activities
    case profile
}

struct EventRouteReference: Hashable, Sendable {
    let id: UUID?
    let slug: String

    init(id: UUID?, slug: String) {
        self.id = id
        self.slug = slug
    }

    init(event: EventSummary) {
        id = event.id
        slug = event.publicSlug
    }

    var identifier: String {
        slug.isEmpty ? id?.uuidString.lowercased() ?? "" : slug
    }
}

enum AppRoute: Hashable, Sendable {
    case event(EventRouteReference)
    case wallet
    case notifications
    case hostStudio
    case settings
    case group(UUID)
    case profile(String)
}

enum AppGate: String, Identifiable, Sendable {
    case login
    case phoneVerification
    case notificationPermission

    var id: String { rawValue }
}

struct DeferredRegistrationDraft: Hashable, Sendable {
    var partySize: Int
    var joinWaitlistIfFull: Bool
    var answers: [UUID: RegistrationAnswer]
    var attendeeNote: String

    init(
        partySize: Int = 1,
        joinWaitlistIfFull: Bool = true,
        answers: [UUID: RegistrationAnswer] = [:],
        attendeeNote: String = ""
    ) {
        self.partySize = max(1, partySize)
        self.joinWaitlistIfFull = joinWaitlistIfFull
        self.answers = answers
        self.attendeeNote = attendeeNote
    }
}

struct DeferredRegistrationIntent: Identifiable, Hashable, Sendable {
    let id: UUID
    let event: EventRouteReference
    let action: EventAction
    let draft: DeferredRegistrationDraft
    let sourceTab: AppTab
    let sourcePath: [AppRoute]
    var requiredGate: AppGate

    init(
        id: UUID = UUID(),
        event: EventRouteReference,
        action: EventAction,
        draft: DeferredRegistrationDraft,
        sourceTab: AppTab,
        sourcePath: [AppRoute],
        requiredGate: AppGate
    ) {
        self.id = id
        self.event = event
        self.action = action
        self.draft = draft
        self.sourceTab = sourceTab
        self.sourcePath = sourcePath
        self.requiredGate = requiredGate
    }
}

@MainActor
@Observable
final class AppRouter {
    var selectedTab: AppTab = .discovery
    private(set) var paths: [AppTab: [AppRoute]]
    private(set) var deferredRegistrationIntent: DeferredRegistrationIntent?
    private(set) var pendingRegistrationPresentation: DeferredRegistrationIntent?
    private var eventSnapshots: [EventRouteReference: EventSummary] = [:]

    init() {
        paths = Dictionary(uniqueKeysWithValues: AppTab.allCases.map { ($0, []) })
    }

    func path(for tab: AppTab) -> [AppRoute] {
        paths[tab, default: []]
    }

    func setPath(_ path: [AppRoute], for tab: AppTab) {
        paths[tab] = path
    }

    func binding(for tab: AppTab) -> Binding<[AppRoute]> {
        Binding(
            get: { [self] in path(for: tab) },
            set: { [self] in setPath($0, for: tab) }
        )
    }

    func push(_ route: AppRoute, in tab: AppTab? = nil, selectingExplicitTab: Bool = false) {
        let target = tab ?? selectedTab
        paths[target, default: []].append(route)
        if selectingExplicitTab || tab != nil {
            selectedTab = target
        }
    }

    func show(event: EventSummary, in tab: AppTab? = nil) {
        let reference = EventRouteReference(event: event)
        eventSnapshots[reference] = event
        push(.event(reference), in: tab, selectingExplicitTab: tab != nil)
    }

    func cachedEvent(for reference: EventRouteReference) -> EventSummary? {
        eventSnapshots[reference]
    }

    func cache(event: EventSummary) {
        eventSnapshots[EventRouteReference(event: event)] = event
    }

    @discardableResult
    func open(url: URL) async -> Bool {
        guard let segments = trustedSegments(for: url), segments.count == 2 else { return false }
        let identifier = segments[1].trimmingCharacters(in: .whitespacesAndNewlines)
        guard !identifier.isEmpty else { return false }
        let requestedTab = deepLinkTab(from: url)

        switch segments[0] {
        case "e":
            let target = requestedTab ?? .discovery
            push(.event(.init(id: nil, slug: identifier)), in: target, selectingExplicitTab: true)
            return true
        case "g":
            guard let id = UUID(uuidString: identifier) else { return false }
            let target = requestedTab ?? .groups
            push(.group(id), in: target, selectingExplicitTab: true)
            return true
        case "u":
            let target = requestedTab ?? .profile
            push(.profile(identifier), in: target, selectingExplicitTab: true)
            return true
        default:
            return false
        }
    }

    func isTrustedDeepLink(_ url: URL) -> Bool {
        trustedSegments(for: url) != nil
    }

    func deferRegistration(
        for event: EventSummary,
        action: EventAction,
        draft: DeferredRegistrationDraft = .init(),
        requiring gate: AppGate
    ) {
        let reference = EventRouteReference(event: event)
        eventSnapshots[reference] = event
        deferredRegistrationIntent = .init(
            event: reference,
            action: action,
            draft: draft,
            sourceTab: selectedTab,
            sourcePath: path(for: selectedTab),
            requiredGate: gate
        )
        pendingRegistrationPresentation = nil
    }

    func transitionDeferredIntent(to gate: AppGate) {
        deferredRegistrationIntent?.requiredGate = gate
    }

    @discardableResult
    func resumeDeferredIntent(after gate: AppGate) -> DeferredRegistrationIntent? {
        guard let intent = deferredRegistrationIntent, intent.requiredGate == gate else { return nil }
        deferredRegistrationIntent = nil
        selectedTab = intent.sourceTab
        paths[intent.sourceTab] = intent.sourcePath
        pendingRegistrationPresentation = intent
        return intent
    }

    func takeRegistrationPresentation(for event: EventRouteReference) -> DeferredRegistrationIntent? {
        guard let intent = pendingRegistrationPresentation, intent.event == event else { return nil }
        pendingRegistrationPresentation = nil
        return intent
    }

    func cancelDeferredIntent() {
        deferredRegistrationIntent = nil
        pendingRegistrationPresentation = nil
    }

    func resetSensitiveNavigation() {
        selectedTab = .discovery
        paths = Dictionary(uniqueKeysWithValues: AppTab.allCases.map { ($0, []) })
        deferredRegistrationIntent = nil
        pendingRegistrationPresentation = nil
        eventSnapshots.removeAll()
    }

    private func trustedSegments(for url: URL) -> [String]? {
        let raw: [String]
        switch url.scheme?.lowercased() {
        case "https":
            guard let host = url.host?.lowercased(), ["spott.jp", "www.spott.jp"].contains(host) else {
                return nil
            }
            raw = url.pathComponents.filter { $0 != "/" }
        case "spott":
            guard let host = url.host, !host.isEmpty else { return nil }
            raw = [host] + url.pathComponents.filter { $0 != "/" }
        default:
            return nil
        }
        return raw.compactMap { $0.removingPercentEncoding }
    }

    private func deepLinkTab(from url: URL) -> AppTab? {
        guard let value = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "tab" })?.value else { return nil }
        switch value {
        case "discover", "discovery": return .discovery
        case "groups": return .groups
        case "create": return .create
        case "activities", "itinerary": return .activities
        case "profile": return .profile
        default: return nil
        }
    }
}
