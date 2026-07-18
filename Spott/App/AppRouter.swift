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

enum AppDeepLink: Equatable, Sendable {
    case event(identifier: String, targetTab: AppTab)
    case group(identifier: String, targetTab: AppTab)
    case profile(identifier: String, targetTab: AppTab)
    case share(code: String)
}

enum AppDeepLinkRoutingResult: Equatable, Sendable {
    case opened
    case requiresResolution(AppDeepLink)
    case rejected
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
    var acceptedTerms: Bool

    init(
        partySize: Int = 1,
        joinWaitlistIfFull: Bool = true,
        answers: [UUID: RegistrationAnswer] = [:],
        attendeeNote: String = "",
        acceptedTerms: Bool = false
    ) {
        self.partySize = max(1, partySize)
        self.joinWaitlistIfFull = joinWaitlistIfFull
        self.answers = answers
        self.attendeeNote = attendeeNote
        self.acceptedTerms = acceptedTerms
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
    private(set) var pendingItineraryRegistrationID: UUID?
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
        eventSnapshots[reference] = event.discoverySafeSummary
        push(.event(reference), in: tab, selectingExplicitTab: tab != nil)
    }

    func showItinerary(registrationID: UUID?) {
        pendingItineraryRegistrationID = registrationID
        paths[.activities] = []
        selectedTab = .activities
    }

    @discardableResult
    func completeItineraryFocus(_ registrationID: UUID) -> Bool {
        guard pendingItineraryRegistrationID == registrationID else { return false }
        pendingItineraryRegistrationID = nil
        return true
    }

    func cachedEvent(for reference: EventRouteReference) -> EventSummary? {
        eventSnapshots[reference]
    }

    func cache(event: EventSummary) {
        eventSnapshots[EventRouteReference(event: event)] = event.discoverySafeSummary
    }

    @discardableResult
    func open(url: URL) async -> Bool {
        route(url: url) == .opened
    }

    @discardableResult
    func route(url: URL) -> AppDeepLinkRoutingResult {
        guard let deepLink = validatedDeepLink(from: url) else { return .rejected }
        switch deepLink {
        case .event(let identifier, let targetTab):
            push(
                .event(.init(id: nil, slug: identifier)),
                in: targetTab,
                selectingExplicitTab: true
            )
            return .opened
        case .group(let identifier, let targetTab):
            guard let id = UUID(uuidString: identifier) else {
                return .requiresResolution(deepLink)
            }
            push(.group(id), in: targetTab, selectingExplicitTab: true)
            return .opened
        case .profile(let identifier, let targetTab):
            push(.profile(identifier), in: targetTab, selectingExplicitTab: true)
            return .opened
        case .share:
            return .requiresResolution(deepLink)
        }
    }

    func deferRegistration(
        for event: EventSummary,
        action: EventAction,
        draft: DeferredRegistrationDraft = .init(),
        requiring gate: AppGate
    ) {
        let reference = EventRouteReference(event: event)
        eventSnapshots[reference] = event.discoverySafeSummary
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

    func takeRegistrationPresentation(
        for event: EventRouteReference,
        in sourceTab: AppTab
    ) -> DeferredRegistrationIntent? {
        guard let intent = pendingRegistrationPresentation,
              intent.event == event,
              intent.sourceTab == sourceTab else { return nil }
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
        pendingItineraryRegistrationID = nil
        eventSnapshots.removeAll()
    }

    private func validatedDeepLink(from url: URL) -> AppDeepLink? {
        guard let segments = trustedSegments(for: url), segments.count == 2 else { return nil }
        let identifier = segments[1]
        guard isValidDeepLinkIdentifier(identifier) else { return nil }
        let requestedTab = deepLinkTab(from: url)
        switch segments[0].lowercased() {
        case "e": return .event(identifier: identifier, targetTab: requestedTab ?? .discovery)
        case "g": return .group(identifier: identifier, targetTab: requestedTab ?? .groups)
        case "u": return .profile(identifier: identifier, targetTab: requestedTab ?? .profile)
        case "s": return .share(code: identifier)
        default: return nil
        }
    }

    private func trustedSegments(for url: URL) -> [String]? {
        guard url.user == nil, url.password == nil, url.port == nil else { return nil }
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        var pathSegments = components.percentEncodedPath
            .split(separator: "/", omittingEmptySubsequences: false)
            .map(String.init)
        if pathSegments.first == "" { pathSegments.removeFirst() }
        guard !pathSegments.isEmpty, !pathSegments.contains("") else { return nil }
        let encoded: [String]
        switch url.scheme?.lowercased() {
        case "https":
            guard let host = url.host?.lowercased(), ["spott.jp", "www.spott.jp"].contains(host) else {
                return nil
            }
            encoded = pathSegments
        case "spott":
            guard let host = url.host, !host.isEmpty else { return nil }
            encoded = [host] + pathSegments
        default:
            return nil
        }
        var decoded: [String] = []
        for segment in encoded {
            guard let value = segment.removingPercentEncoding else { return nil }
            decoded.append(value)
        }
        return decoded
    }

    private func isValidDeepLinkIdentifier(_ value: String) -> Bool {
        guard !value.isEmpty,
              value.count <= 128,
              value == value.trimmingCharacters(in: .whitespacesAndNewlines) else { return false }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        return value.unicodeScalars.allSatisfy(allowed.contains)
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
