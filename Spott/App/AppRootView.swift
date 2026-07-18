import SwiftUI

struct AppRootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var router = model.router
        Group {
            if #available(iOS 26.0, *) {
                appTabs(selection: $router.selectedTab)
                    .tabBarMinimizeBehavior(.onScrollDown)
            } else {
                appTabs(selection: $router.selectedTab)
            }
        }
        .tint(SpottColor.twilight)
        .sheet(isPresented: presentedGateBinding) {
            GatePresentationView()
                .presentationDetents([.medium, .large])
        }
        .overlay(alignment: .top) {
            if let banner = model.banner {
                SyncBanner(banner: banner)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .padding(.top, 8)
            }
        }
    }

    private var presentedGateBinding: Binding<Bool> {
        Binding(
            get: { model.presentedGate != nil },
            set: { isPresented in
                if !isPresented, model.presentedGate != nil {
                    model.cancelPresentedGate()
                }
            }
        )
    }

    private func appTabs(selection: Binding<AppTab>) -> some View {
        return TabView(selection: selection) {
            NavigationStack(path: model.router.binding(for: .discovery)) {
                DiscoveryView(store: model.discovery)
                    .appRouteDestinations(in: .discovery)
            }
            .tabItem { Label("发现", systemImage: "safari") }
            .tag(AppTab.discovery)

            NavigationStack(path: model.router.binding(for: .groups)) {
                GroupsHomeView()
                    .appRouteDestinations(in: .groups)
            }
            .tabItem { Label("社群", systemImage: "person.2") }
            .tag(AppTab.groups)

            NavigationStack(path: model.router.binding(for: .create)) {
                EventComposerView()
                    .appRouteDestinations(in: .create)
            }
            .tabItem { Label("创建", systemImage: "plus") }
            .tag(AppTab.create)

            NavigationStack(path: model.router.binding(for: .activities)) {
                MyActivitiesView()
                    .appRouteDestinations(in: .activities)
            }
            .tabItem { Label("行程", systemImage: "calendar") }
            .tag(AppTab.activities)

            NavigationStack(path: model.router.binding(for: .profile)) {
                ProfileHomeView()
                    .appRouteDestinations(in: .profile)
            }
            .tabItem { Label("我的", systemImage: "person") }
            .tag(AppTab.profile)
        }
    }
}

private struct GatePresentationView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let gate = model.presentedGate {
            GateView(gate: gate)
        }
    }
}

private struct RouteView: View {
    let route: AppRoute
    let sourceTab: AppTab

    var body: some View {
        switch route {
        case .event(let reference): RoutedEventView(reference: reference, sourceTab: sourceTab)
        case .wallet: WalletView()
        case .notifications: NotificationsView()
        case .hostStudio: HostStudioView()
        case .settings: SettingsView()
        case .group(let id): GroupDetailView(groupID: id)
        case .profile(let identifier): PublicProfileView(identifier: identifier)
        }
    }
}

private extension View {
    func appRouteDestinations(in sourceTab: AppTab) -> some View {
        navigationDestination(for: AppRoute.self) { route in
            RouteView(route: route, sourceTab: sourceTab)
        }
    }
}

struct RoutedEventCopy: Equatable {
    let errorTitle: String
    let invalidMessage: String
    let reload: String
    let loading: String

    init(locale: Locale) {
        errorTitle = CoreJourneyLocalization.text(
            "journey.route.event_error_title",
            locale: locale
        )
        invalidMessage = CoreJourneyLocalization.text(
            "journey.route.event_invalid",
            locale: locale
        )
        reload = CoreJourneyLocalization.text("journey.route.reload", locale: locale)
        loading = CoreJourneyLocalization.text(
            "journey.route.event_loading",
            locale: locale
        )
    }

    func displayMessage(for error: UserFacingError) -> String {
        error.id == "EVENT_ROUTE_INVALID" ? invalidMessage : error.message
    }
}

struct RoutedEventSnapshotPresentation {
    let event: EventSummary?
    let isCurrent: Bool

    static func resolve(
        event: EventSummary?,
        boundLoadIdentity: String?,
        currentLoadIdentity: String,
        isAuthoritative: Bool
    ) -> RoutedEventSnapshotPresentation {
        guard boundLoadIdentity == currentLoadIdentity else {
            return .init(
                event: event?.discoverySafeSummary,
                isCurrent: false
            )
        }
        return .init(event: event, isCurrent: isAuthoritative)
    }

    static func response(
        _ event: EventSummary,
        matches reference: EventRouteReference
    ) -> Bool {
        if let expectedID = reference.id {
            return event.id == expectedID
        }
        let identifier = reference.identifier
        if let expectedID = UUID(uuidString: identifier) {
            return event.id == expectedID
        }
        return event.publicSlug == identifier
    }
}

private struct RoutedEventView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale
    let reference: EventRouteReference
    let sourceTab: AppTab
    @State private var event: EventSummary?
    @State private var error: UserFacingError?
    @State private var refreshEventOnAppear = true
    @State private var initialViewerSnapshotIsCurrent = false
    @State private var eventLoadIdentity: String?

    private var copy: RoutedEventCopy { RoutedEventCopy(locale: locale) }
    private var sessionFingerprint: String {
        "\(model.session?.sessionId.uuidString ?? "guest")-"
            + "\(model.session?.user.id.uuidString ?? "anonymous")"
    }
    private var loadIdentity: String {
        "\(reference.id?.uuidString ?? "none")-\(reference.slug)-\(sessionFingerprint)"
    }

    var body: some View {
        let presentation = RoutedEventSnapshotPresentation.resolve(
            event: event,
            boundLoadIdentity: eventLoadIdentity,
            currentLoadIdentity: loadIdentity,
            isAuthoritative: initialViewerSnapshotIsCurrent
        )
        Group {
            if let event = presentation.event {
                EventDetailView(
                    event: event,
                    sourceTab: sourceTab,
                    refreshOnAppear: refreshEventOnAppear,
                    initialViewerSnapshotIsCurrent: presentation.isCurrent
                )
            } else if let error {
                SpottStateCard(
                    icon: "calendar.badge.exclamationmark",
                    title: copy.errorTitle,
                    message: copy.displayMessage(for: error),
                    actionTitle: copy.reload
                ) {
                    Task { await load(force: true) }
                }
                .padding(SpottMetric.pageInset)
            } else {
                ProgressView(copy.loading)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(SpottColor.canvas.ignoresSafeArea())
        .task(id: loadIdentity) { await load(force: false) }
    }

    private func load(force: Bool) async {
        let requestedSessionFingerprint = sessionFingerprint
        let requestedLoadIdentity = loadIdentity
        let snapshotChanged = eventLoadIdentity != nil
            && eventLoadIdentity != requestedLoadIdentity

        if force || snapshotChanged {
            event = nil
            eventLoadIdentity = nil
            error = nil
            refreshEventOnAppear = false
            initialViewerSnapshotIsCurrent = false
        }

        if !force,
           !snapshotChanged,
           let cached = model.router.cachedEvent(for: reference) {
            event = cached.discoverySafeSummary
            eventLoadIdentity = requestedLoadIdentity
            error = nil
            initialViewerSnapshotIsCurrent = false
            refreshEventOnAppear = !model.usesNavigationUITestFixture
            return
        }
        guard !reference.identifier.isEmpty else {
            error = .init(
                id: "EVENT_ROUTE_INVALID",
                message: copy.invalidMessage,
                retryable: false
            )
            return
        }
        do {
            let current = try await model.api.event(identifier: reference.identifier)
            try Task.checkCancellation()
            guard requestedSessionFingerprint == sessionFingerprint,
                  requestedLoadIdentity == loadIdentity else { return }
            guard RoutedEventSnapshotPresentation.response(current, matches: reference) else {
                error = .init(
                    id: "EVENT_ROUTE_MISMATCH",
                    message: CoreJourneyLocalization.text(
                        "journey.error.event_incomplete",
                        locale: locale
                    ),
                    retryable: false
                )
                return
            }
            model.router.cache(event: current)
            event = current
            eventLoadIdentity = requestedLoadIdentity
            error = nil
            refreshEventOnAppear = false
            initialViewerSnapshotIsCurrent = true
        } catch is CancellationError {
            return
        } catch {
            guard requestedSessionFingerprint == sessionFingerprint,
                  requestedLoadIdentity == loadIdentity else { return }
            if event == nil { self.error = AppModel.map(error) }
        }
    }
}

#Preview {
    AppRootView()
        .environment(AppModel.preview)
}
