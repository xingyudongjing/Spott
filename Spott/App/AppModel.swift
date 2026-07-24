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

/// A favorite tap that hit the login gate: kept so the auth sheet can show the
/// event context and the heart is applied right after authentication succeeds
/// (spec §7 step 9 收藏类 intent).
struct DeferredFavoriteIntent: Sendable {
    let event: EventSummary
    let desired: Bool
}

@MainActor
@Observable
final class AppModel {
    var presentedGate: AppGate?
    var session: UserSession?
    var banner: SyncBannerState?
    private(set) var deferredFavoriteIntent: DeferredFavoriteIntent?

    let api: SpottAPIClient
    let analytics: AnalyticsClient
    let persistence: any DiscoveryCaching
    let sync: SyncEngine
    let discovery: DiscoveryStore
    @ObservationIgnored let router: AppRouter
    @ObservationIgnored private let sessionRestorer: any SessionRestoring
    @ObservationIgnored private let sessionEnder: any SessionEnding
    @ObservationIgnored private let syncLifecycle: any SyncLifecycleManaging
    @ObservationIgnored private let syncPuller: any SyncPulling
    @ObservationIgnored private let ownerWriteLeaseAuthority: OwnerWriteLeaseAuthority
    @ObservationIgnored private var authGeneration: UInt64 = 0
    @ObservationIgnored private var authTask: Task<Void, Never>?

    var region: String {
        get { discovery.region }
        set { discovery.region = newValue }
    }

    init(
        api: SpottAPIClient,
        analytics: AnalyticsClient,
        persistence: any DiscoveryCaching,
        sync: SyncEngine,
        router: AppRouter,
        sessionRestorer: (any SessionRestoring)? = nil,
        sessionEnder: (any SessionEnding)? = nil,
        syncLifecycle: (any SyncLifecycleManaging)? = nil,
        syncPuller: (any SyncPulling)? = nil,
        ownerWriteLeaseAuthority: OwnerWriteLeaseAuthority? = nil,
        discovery injectedDiscovery: DiscoveryStore? = nil
    ) {
        self.api = api
        self.analytics = analytics
        self.persistence = persistence
        self.sync = sync
        self.router = router
        self.sessionRestorer = sessionRestorer ?? api
        self.sessionEnder = sessionEnder ?? api
        self.syncLifecycle = syncLifecycle ?? sync
        self.syncPuller = syncPuller ?? sync
        self.ownerWriteLeaseAuthority = ownerWriteLeaseAuthority ?? sync.ownerWriteLeaseAuthority
        discovery = injectedDiscovery ?? DiscoveryStore(service: api, cache: persistence)
        api.setAuthenticationExpirationHandler { [weak self] sessionID in
            guard let self else { return }
            await self.handleSessionExpiration(expectedSessionID: sessionID)
        }
    }

    var usesNavigationUITestFixture: Bool {
#if DEBUG
        ProcessInfo.processInfo.arguments.contains("-spott-ui-test-navigation-fixture")
#else
        false
#endif
    }

    private struct NavigationUITestRoute {
        let tab: AppTab
        let path: [AppRoute]
        let showsEvent: Bool
    }

    private var navigationUITestRoute: NavigationUITestRoute? {
#if DEBUG
        let arguments = ProcessInfo.processInfo.arguments
        guard let keyIndex = arguments.firstIndex(of: "-spott-ui-test-route-tab"),
              arguments.indices.contains(keyIndex + 1) else { return nil }
        switch arguments[keyIndex + 1] {
        case "activities": return .init(tab: .profile, path: [.itinerary], showsEvent: true)
        case "itinerary": return .init(tab: .profile, path: [.itinerary], showsEvent: false)
        case "profile": return .init(tab: .profile, path: [], showsEvent: true)
        default: return nil
        }
#else
        nil
#endif
    }

    func bootstrap() async {
        if usesNavigationUITestFixture {
            discovery.replaceWithFixture(EventSummary.samples)
            if let route = navigationUITestRoute {
                router.selectedTab = route.tab
                router.setPath(route.path, for: route.tab)
                if route.showsEvent {
                    router.show(event: EventSummary.samples[0])
                }
            }
            return
        }
        guard discovery.phase == .initial else { return }
        let generation = beginAuthTransition()
        let discoveryReceipt: DiscoveryReplacementReceipt?
        let restoredSession: UserSession?
        do {
            restoredSession = try await sessionRestorer.currentSession()
        } catch {
            guard isCurrentAuthTransition(generation) else { return }
            banner = .init(title: Self.map(error).message, tone: .warning)
            return
        }
        if let restoredSession {
            guard isCurrentAuthTransition(generation) else { return }
            session = restoredSession
            do {
                try await syncLifecycle.bootstrap(
                    userID: restoredSession.user.id,
                    generation: generation
                )
            } catch {
                guard isCurrentAuth(generation, sessionID: restoredSession.sessionId) else { return }
                banner = .init(title: Self.map(error).message, tone: .warning)
                return
            }
            guard isCurrentAuth(generation, sessionID: restoredSession.sessionId) else { return }
            discoveryReceipt = await discovery.loadInitial()
            guard isCurrentAuth(generation, sessionID: restoredSession.sessionId) else { return }
            await reconcileStorePurchases()
            guard isCurrentAuth(generation, sessionID: restoredSession.sessionId) else { return }
            await registerPendingPushToken()
            guard isCurrentAuth(generation, sessionID: restoredSession.sessionId) else { return }
        } else {
            guard isCurrentSignedOut(generation) else { return }
            discoveryReceipt = await discovery.loadInitial()
            guard isCurrentSignedOut(generation) else { return }
        }
        guard let discoveryReceipt else { return }
        trackAnalytics(.discoveryViewed(
            region: discoveryReceipt.region,
            itemCount: discoveryReceipt.itemCount,
            reason: "initial"
        ))
    }

    func refresh(reason: SyncReason = .manual) async {
        let generation = authGeneration
        let sessionID = session?.sessionId
        banner = .init(title: "正在同步…", tone: .syncing)
        do {
            _ = try await syncPuller.pull(reason: reason)
            guard isCurrentRefresh(generation: generation, sessionID: sessionID) else { return }
            let receipt = await discovery.refresh()
            guard isCurrentRefresh(generation: generation, sessionID: sessionID) else { return }
            guard let receipt else {
                banner = .init(
                    title: discovery.refreshError?.message
                        ?? discovery.fatalError?.message
                        ?? String(localized: "操作暂时无法完成，请重试。"),
                    tone: .warning
                )
                await dismissRefreshBanner(generation: generation, sessionID: sessionID)
                return
            }
            trackAnalytics(.discoveryViewed(
                region: receipt.region,
                itemCount: receipt.itemCount,
                reason: reason.rawValue
            ))
            banner = .init(title: "已是最新", tone: .success)
        } catch {
            guard isCurrentRefresh(generation: generation, sessionID: sessionID) else { return }
            banner = .init(title: Self.map(error).message, tone: .warning)
        }
        await dismissRefreshBanner(generation: generation, sessionID: sessionID)
    }

    private func dismissRefreshBanner(generation: UInt64, sessionID: UUID?) async {
        try? await Task.sleep(for: .seconds(2))
        guard authGeneration == generation, session?.sessionId == sessionID else { return }
        banner = nil
    }

    func show(event: EventSummary, in tab: AppTab? = nil, promoted: Bool = false) {
        router.show(event: event, in: tab, promoted: promoted)
    }

    /// Records a signed-out favorite tap and opens the login gate. The intent
    /// is applied (PUT) right after authentication, before discovery refreshes,
    /// so hearts reflect it everywhere without extra taps.
    func deferFavorite(event: EventSummary, desired: Bool) {
        router.cache(event: event)
        deferredFavoriteIntent = .init(event: event, desired: desired)
        presentedGate = .login
    }

    private func applyDeferredFavorite() async {
        guard let intent = deferredFavoriteIntent, session != nil else { return }
        deferredFavoriteIntent = nil
        do {
            try await api.setFavorite(eventID: intent.event.id, enabled: intent.desired)
        } catch {
            banner = .init(title: Self.map(error).message, tone: .warning)
        }
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
        let previousUserID = session?.user.id
        let generation = beginAuthTransition()
        let completedGate = presentedGate
        let authenticatedUserID = newSession.user.id
        let authenticatedSessionID = newSession.sessionId
        if session?.user.id != newSession.user.id {
            discovery.resetForSessionChange()
        }
        if let previousUserID, previousUserID != newSession.user.id {
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
            do {
                if let previousUserID, previousUserID != authenticatedUserID {
                    try await syncLifecycle.deactivateScope(
                        reason: .accountChanged,
                        generation: generation
                    )
                    guard isCurrentAuth(generation, sessionID: authenticatedSessionID) else { return }
                }
                try await syncLifecycle.bootstrap(userID: authenticatedUserID, generation: generation)
            } catch {
                guard isCurrentAuth(generation, sessionID: authenticatedSessionID) else { return }
                banner = .init(title: Self.map(error).message, tone: .warning)
                return
            }
            guard isCurrentAuth(generation, sessionID: authenticatedSessionID) else { return }
            // Apply a gate-deferred favorite before the discovery refresh so the
            // refreshed feed already carries the heart the user tapped.
            await applyDeferredFavorite()
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
        deferredFavoriteIntent = nil
        presentedGate = nil
    }

    func signOut() {
        let endingSessionID = session?.sessionId
        let generation = beginAuthTransition()
        GoogleSignInManager.shared.signOut()
        session = nil
        presentedGate = nil
        deferredFavoriteIntent = nil
        router.resetSensitiveNavigation()
        discovery.resetForSessionChange()
        authTask = Task { [weak self] in
            guard let self else { return }
            guard isCurrentSignedOut(generation) else { return }
            do {
                try await syncLifecycle.deactivateScope(reason: .signOut, generation: generation)
            } catch {
                guard isCurrentSignedOut(generation) else { return }
                banner = .init(title: Self.map(error).message, tone: .warning)
                return
            }
            guard isCurrentSignedOut(generation) else { return }
            if let endingSessionID {
                _ = try? await sessionEnder.signOut(expectedSessionID: endingSessionID)
            }
            guard isCurrentSignedOut(generation) else { return }
            await discovery.refresh()
        }
    }

    private func handleSessionExpiration(expectedSessionID: UUID) async {
        guard session?.sessionId == expectedSessionID else { return }
        let generation = beginAuthTransition()
        GoogleSignInManager.shared.signOut()
        session = nil
        presentedGate = .login
        deferredFavoriteIntent = nil
        router.resetSensitiveNavigation()
        discovery.resetForSessionChange()
        banner = .init(
            title: String(localized: "登录已过期。"),
            tone: .warning
        )
        do {
            try await syncLifecycle.deactivateScope(
                reason: .sessionExpired,
                generation: generation
            )
        } catch {
            guard isCurrentSignedOut(generation) else { return }
            return
        }
        guard isCurrentSignedOut(generation) else { return }
        await discovery.refresh()
    }

    private func beginAuthTransition() -> UInt64 {
        authGeneration = ownerWriteLeaseAuthority.revoke()
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

    private func isCurrentRefresh(generation: UInt64, sessionID: UUID?) -> Bool {
        guard !Task.isCancelled, authGeneration == generation else { return false }
        return session?.sessionId == sessionID
    }

    static func map(_ error: Error) -> UserFacingError {
        if let apiError = error as? APIError {
            let message: String
            switch apiError.code {
            case "CHALLENGE_EXPIRED":
                message = String(localized: "验证码已过期，请重新获取。")
            case "OTP_RATE_LIMITED":
                message = String(localized: "尝试次数过多，请稍后再试。")
            case "AUTH_CREDENTIAL_INVALID", "PHONE_VERIFICATION_FAILED":
                message = String(localized: "验证码或登录凭证不正确，请重新检查。")
            case "PHONE_ALREADY_BOUND", "PHONE_BINDING_CONFLICT":
                message = String(localized: "此手机号已绑定其他账号。")
            case "TOKEN_EXPIRED", "TOKEN_INVALID", "SESSION_NOT_FOUND", "REFRESH_TOKEN_REUSED":
                message = String(localized: "登录已过期，请重新登录。")
            case "VERSION_CONFLICT", "EVENT_CHANGED", "EVENT_VERSION_CONFLICT":
                message = String(localized: "内容已更新，请重新核对后继续。")
            case "INVALID_CREDENTIALS":
                message = String(localized: "邮箱或密码不正确。")
            case "EMAIL_ALREADY_REGISTERED":
                message = String(localized: "该邮箱已注册，请直接登录。")
            case "PHONE_VERIFICATION_REQUIRED":
                message = String(localized: "此操作需要先验证手机号。")
            case "ACCOUNT_RESTRICTED", "DISCUSSION_RESTRICTED":
                message = String(localized: "当前账号已被限制，暂不能执行此操作。")
            case "COMMENT_CONTENT_BLOCKED", "DISCUSSION_CONTENT_BLOCKED":
                message = String(localized: "内容包含不被允许的词语，请修改后再发送。")
            case "COMMENT_PARENT_NOT_FOUND", "DISCUSSION_POST_NOT_FOUND":
                message = String(localized: "要回复的内容不存在或已删除。")
            case "EVENT_COMMENTS_DISABLED":
                message = String(localized: "该活动未开放评论。")
            case "EVENT_COMMENT_FORBIDDEN":
                message = String(localized: "只有活动参与者可以在此评论。")
            case "GROUP_DISCUSSION_FORBIDDEN":
                message = String(localized: "只有群成员可以查看或参与群讨论。")
            case "GROUP_DISCUSSION_MUTED":
                message = String(localized: "你已被禁言，暂不能在讨论区发言。")
            case "DISCUSSION_RATE_LIMITED", "GROUP_ANNOUNCEMENT_RATE_LIMITED":
                message = String(localized: "发布过于频繁，请稍后再试。")
            case "TICKET_TYPE_INVALID":
                message = String(localized: "票种信息不完整，请检查后重试。")
            case "TICKET_TYPE_LIMIT_REACHED":
                message = String(localized: "票种数量已达上限。")
            case "TICKET_TYPE_QUOTA_BELOW_SOLD":
                message = String(localized: "票种名额不能低于已占用的名额。")
            case "TICKET_TYPE_NOT_FOUND":
                message = String(localized: "票种不存在或已停用。")
            case "TICKET_MANAGE_FORBIDDEN", "TICKET_PAYMENT_CONFIRM_FORBIDDEN":
                message = String(localized: "只有活动组织者可以执行此操作。")
            case "TICKET_PAYMENT_NOT_APPLICABLE":
                message = String(localized: "此报名无需线下付款。")
            case "PROMOTION_TIER_INVALID":
                message = String(localized: "不支持的置顶档位。")
            case "PROMOTION_FORBIDDEN":
                message = String(localized: "只有活动组织者可以购买置顶。")
            case "PROMOTION_ALREADY_ACTIVE":
                message = String(localized: "该活动已有生效中的置顶。")
            case "PROMOTION_EVENT_NOT_OPEN":
                message = String(localized: "活动需审核通过且仍可报名才能置顶。")
            case "POINTS_INSUFFICIENT":
                message = String(localized: "积分余额不足。")
            case "QUOTE_EXPIRED", "QUOTE_PURPOSE_INVALID":
                message = String(localized: "报价已失效，请重新发起。")
            case "CHECKIN_STATE_UNAVAILABLE":
                message = String(localized: "签到暂时不可用，请稍后再试。")
            case "INVITE_NOT_FOUND", "SHARE_NOT_FOUND":
                message = String(localized: "链接不存在或已失效。")
            case "INVITE_SELF_FORBIDDEN":
                message = String(localized: "不能使用自己的邀请链接。")
            case "ACHIEVEMENT_HIDDEN":
                message = String(localized: "已隐藏的成就无法分享。")
            default:
                switch apiError.status {
                case 401:
                    message = String(localized: "请登录后继续。")
                case 403:
                    message = String(localized: "当前账号没有执行此操作的权限。")
                case 404:
                    message = String(localized: "内容不存在或已下线。")
                default:
                    message = String(localized: "操作暂时无法完成，请重试。")
                }
            }
            return .init(id: apiError.code, message: message, retryable: apiError.retryable)
        }
        return .init(
            id: "NETWORK_UNAVAILABLE",
            message: String(localized: "暂时无法连接 Spott，请检查网络后重试。"),
            retryable: true
        )
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
