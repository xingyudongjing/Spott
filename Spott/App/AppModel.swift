import Foundation
import Observation
import SwiftUI
import UIKit

enum ViewLoadState<Value: Sendable>: Sendable {
    case initial
    case loading
    case content(Value)
    case empty
    case error(UserFacingError)
    case offlineContent(Value)
}

struct UserFacingError: Error, Identifiable, Sendable, Equatable {
    let id: String
    let message: String
    let retryable: Bool
}

struct SyncBannerState: Equatable, Sendable {
    enum Tone: Sendable { case syncing, offline, success, warning }
    let title: String
    let tone: Tone
}

@MainActor
@Observable
final class AppModel {
    var presentedGate: AppGate?
    var session: UserSession?
    var banner: SyncBannerState?

    let api: SpottAPIClient
    let analytics: AnalyticsClient
    let persistence: PersistenceStore
    let sync: SyncEngine
    let discovery: DiscoveryStore
    @ObservationIgnored let router: AppRouter
    @ObservationIgnored private let sessionRestorer: any SessionRestoring
    @ObservationIgnored private let sessionEnder: any SessionEnding
    @ObservationIgnored private let syncLifecycle: any SyncLifecycleManaging
    @ObservationIgnored private var authGeneration: UInt64 = 0
    @ObservationIgnored private var authTask: Task<Void, Never>?

    var region: String {
        get { discovery.region }
        set { discovery.region = newValue }
    }

    init(
        api: SpottAPIClient,
        analytics: AnalyticsClient,
        persistence: PersistenceStore,
        sync: SyncEngine,
        router: AppRouter,
        sessionRestorer: (any SessionRestoring)? = nil,
        sessionEnder: (any SessionEnding)? = nil,
        syncLifecycle: (any SyncLifecycleManaging)? = nil
    ) {
        self.api = api
        self.analytics = analytics
        self.persistence = persistence
        self.sync = sync
        self.router = router
        self.sessionRestorer = sessionRestorer ?? api
        self.sessionEnder = sessionEnder ?? api
        self.syncLifecycle = syncLifecycle ?? sync
        discovery = DiscoveryStore(service: api, cache: persistence)
    }

    var usesNavigationUITestFixture: Bool {
#if DEBUG
        ProcessInfo.processInfo.arguments.contains("-spott-ui-test-navigation-fixture")
#else
        false
#endif
    }

    private var navigationUITestRouteTab: AppTab? {
#if DEBUG
        let arguments = ProcessInfo.processInfo.arguments
        guard let keyIndex = arguments.firstIndex(of: "-spott-ui-test-route-tab"),
              arguments.indices.contains(keyIndex + 1) else { return nil }
        switch arguments[keyIndex + 1] {
        case "activities": return .activities
        case "profile": return .profile
        default: return nil
        }
#else
        nil
#endif
    }

    func bootstrap() async {
        if usesNavigationUITestFixture {
            discovery.replaceWithFixture(EventSummary.samples)
            if let targetTab = navigationUITestRouteTab {
                router.selectedTab = targetTab
                router.show(event: EventSummary.samples[0])
            }
            return
        }
        guard discovery.phase == .initial else { return }
        let generation = beginAuthTransition()
        if let restoredSession = try? await sessionRestorer.currentSession() {
            guard isCurrentAuthTransition(generation) else { return }
            session = restoredSession
            try? await syncLifecycle.bootstrap(
                userID: restoredSession.user.id,
                generation: generation
            )
            guard isCurrentAuth(generation, sessionID: restoredSession.sessionId) else { return }
            await discovery.loadInitial()
            guard isCurrentAuth(generation, sessionID: restoredSession.sessionId) else { return }
            await reconcileStorePurchases()
            guard isCurrentAuth(generation, sessionID: restoredSession.sessionId) else { return }
            await registerPendingPushToken()
            guard isCurrentAuth(generation, sessionID: restoredSession.sessionId) else { return }
        } else {
            guard isCurrentSignedOut(generation) else { return }
            await discovery.loadInitial()
            guard isCurrentSignedOut(generation) else { return }
        }
        trackAnalytics(.discoveryViewed(
            region: region,
            itemCount: discovery.items.count,
            reason: "initial"
        ))
    }

    func refresh(reason: SyncReason = .manual) async {
        banner = .init(title: "正在同步…", tone: .syncing)
        do {
            _ = try await sync.pull(reason: reason)
            await discovery.refresh()
            trackAnalytics(.discoveryViewed(
                region: region,
                itemCount: discovery.items.count,
                reason: reason.rawValue
            ))
            banner = .init(title: "已是最新", tone: .success)
        } catch {
            banner = .init(title: Self.map(error).message, tone: .warning)
        }
        try? await Task.sleep(for: .seconds(2))
        banner = nil
    }

    func show(event: EventSummary, in tab: AppTab? = nil) {
        router.show(event: event, in: tab)
    }

    func trackAnalytics(_ signal: P0AnalyticsSignal) {
        Task { [analytics] in
            await analytics.track(signal.name, properties: signal.properties)
        }
    }

    func requireTrust(
        for action: EventAction,
        event: EventSummary? = nil,
        draft: DeferredRegistrationDraft = .init(),
        destination: () -> Void
    ) {
        guard session != nil else {
            if let event, [.register, .joinWaitlist].contains(action) {
                router.deferRegistration(for: event, action: action, draft: draft, requiring: .login)
            }
            presentedGate = .login
            return
        }
        guard session?.user.phoneVerified == true || !action.requiresPhone else {
            if let event, [.register, .joinWaitlist].contains(action) {
                router.deferRegistration(
                    for: event,
                    action: action,
                    draft: draft,
                    requiring: .phoneVerification
                )
            }
            presentedGate = .phoneVerification
            return
        }
        destination()
    }

    func open(url: URL) {
        Task { @MainActor in
            do {
                switch router.route(url: url) {
                case .opened, .rejected:
                    return
                case .requiresResolution(.group(let identifier, let targetTab)):
                    let group = try await api.group(identifier: identifier)
                    router.push(.group(group.id), in: targetTab, selectingExplicitTab: true)
                case .requiresResolution(.share(let code)):
                    let resolution = try await api.resolveShareLink(code: code)
                    await openShareResolution(resolution)
                case .requiresResolution:
                    return
                }
            } catch {
                banner = .init(title: Self.map(error).message, tone: .warning)
            }
        }
    }

    private func openShareResolution(_ resolution: ShareLinkResolution) async {
        switch resolution.resourceType {
        case "event":
            if let event = try? await api.event(identifier: resolution.resourceId.uuidString.lowercased()) {
                router.show(event: event, in: .discovery)
            }
        case "group":
            router.push(.group(resolution.resourceId), in: .groups, selectingExplicitTab: true)
        case "profile":
            router.push(
                .profile(resolution.resourceId.uuidString.lowercased()),
                in: .profile,
                selectingExplicitTab: true
            )
        default:
            break
        }
    }

    func openExternal(url: URL) {
        UIApplication.shared.open(url)
    }

    func didAuthenticate(_ newSession: UserSession) {
        let generation = beginAuthTransition()
        let completedGate = presentedGate
        let authenticatedUserID = newSession.user.id
        let authenticatedSessionID = newSession.sessionId
        if session?.user.id != newSession.user.id {
            discovery.resetForSessionChange()
        }
        if let previousUserID = session?.user.id, previousUserID != newSession.user.id {
            router.resetSensitiveNavigation()
        }
        session = newSession
        if newSession.user.phoneVerified {
            presentedGate = nil
            if let completedGate {
                router.resumeDeferredIntent(after: completedGate)
            }
        } else {
            if router.deferredRegistrationIntent != nil {
                router.transitionDeferredIntent(to: .phoneVerification)
            }
            presentedGate = .phoneVerification
        }
        authTask = Task { [weak self] in
            guard let self, isCurrentAuth(generation, sessionID: authenticatedSessionID) else { return }
            try? await syncLifecycle.bootstrap(userID: authenticatedUserID, generation: generation)
            guard isCurrentAuth(generation, sessionID: authenticatedSessionID) else { return }
            await discovery.refresh()
            guard isCurrentAuth(generation, sessionID: authenticatedSessionID) else { return }
            await reconcileStorePurchases()
            guard isCurrentAuth(generation, sessionID: authenticatedSessionID) else { return }
            await registerPendingPushToken()
        }
    }

    func reconcileStorePurchases() async {
        guard session != nil else { return }
        let store = StoreKitManager.shared
        for purchase in await store.unfinishedPurchases() {
            do {
                _ = try await api.creditAppleStoreTransaction(purchase.signedTransaction)
                await store.finish(purchase)
            } catch {
                banner = .init(title: Self.map(error).message, tone: .warning)
            }
        }
    }

    func registerPendingPushToken() async {
        guard session != nil,
              let token = UserDefaults.standard.string(forKey: "spott.apns.device-token"),
              token.count >= 16 else { return }
#if DEBUG
        let environment = "sandbox"
#else
        let environment = "production"
#endif
        do {
            _ = try await api.registerPushDevice(token: token, environment: environment)
        } catch {
            // The token remains stored and is retried after the next authenticated bootstrap.
        }
    }

    func markPhoneVerified() {
        guard let session else { return }
        self.session = UserSession(
            accessToken: session.accessToken,
            refreshToken: session.refreshToken,
            sessionId: session.sessionId,
            accessTokenExpiresAt: session.accessTokenExpiresAt,
            user: .init(
                id: session.user.id,
                publicHandle: session.user.publicHandle,
                phoneVerified: true,
                restrictions: session.user.restrictions
            )
        )
        presentedGate = nil
        router.resumeDeferredIntent(after: .phoneVerification)
    }

    func cancelPresentedGate() {
        router.cancelDeferredIntent()
        presentedGate = nil
    }

    func signOut() {
        let endingSessionID = session?.sessionId
        let generation = beginAuthTransition()
        GoogleSignInManager.shared.signOut()
        session = nil
        presentedGate = nil
        router.resetSensitiveNavigation()
        discovery.resetForSessionChange()
        authTask = Task { [weak self] in
            guard let self else { return }
            if let endingSessionID {
                _ = try? await sessionEnder.signOut(expectedSessionID: endingSessionID)
            }
            guard isCurrentSignedOut(generation) else { return }
            try? await syncLifecycle.resetSensitiveScope(reason: .signOut, generation: generation)
            guard isCurrentSignedOut(generation) else { return }
            await discovery.refresh()
        }
    }

    private func beginAuthTransition() -> UInt64 {
        authGeneration &+= 1
        authTask?.cancel()
        authTask = nil
        return authGeneration
    }

    private func isCurrentAuth(_ generation: UInt64, sessionID: UUID) -> Bool {
        authGeneration == generation && session?.sessionId == sessionID && !Task.isCancelled
    }

    private func isCurrentAuthTransition(_ generation: UInt64) -> Bool {
        authGeneration == generation && !Task.isCancelled
    }

    private func isCurrentSignedOut(_ generation: UInt64) -> Bool {
        authGeneration == generation && session == nil && !Task.isCancelled
    }

    static func map(_ error: Error) -> UserFacingError {
        if let apiError = error as? APIError {
            return .init(id: apiError.code, message: apiError.message, retryable: apiError.retryable)
        }
        return .init(id: "NETWORK_UNAVAILABLE", message: "暂时无法连接 Spott，请检查网络后重试。", retryable: true)
    }

    static var preview: AppModel {
        let persistence = PersistenceStore.makeInMemory()
        let vault = CredentialVault(service: "jp.spott.preview")
        let api = SpottAPIClient(environment: .preview, credentials: vault)
        let model = AppModel(
            api: api,
            analytics: AnalyticsClient(environment: .preview),
            persistence: persistence,
            sync: SyncEngine(api: api, persistence: persistence),
            router: AppRouter()
        )
        model.discovery.replaceWithFixture(EventSummary.samples)
        model.session = .preview
        return model
    }
}
