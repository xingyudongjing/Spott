import SwiftData
import SwiftUI

@main
struct SpottApp: App {
    @UIApplicationDelegateAdaptor(SpottAppDelegate.self) private var appDelegate
    @State private var router: AppRouter
    @State private var model: AppModel
    @AppStorage("app.language") private var appLanguage = AppLanguage.system.rawValue
    private let persistence: PersistenceStore

    init() {
        let persistence = PersistenceStore.makeDefault()
        let vault = CredentialVault(service: "jp.spott.credentials")
        let api = SpottAPIClient(
            environment: .default,
            credentials: vault
        )
        let analytics = AnalyticsClient(environment: .default)
        let sync = SyncEngine(api: api, persistence: persistence)
        let router = AppRouter()
        self.persistence = persistence
        _router = State(initialValue: router)
        _model = State(initialValue: AppModel(
            api: api,
            analytics: analytics,
            persistence: persistence,
            sync: sync,
            router: router
        ))
    }

    var body: some Scene {
        WindowGroup {
            AppRootView()
                .environment(model)
                .environment(router)
                .environment(\.locale, (AppLanguage(rawValue: appLanguage) ?? .system).locale)
                .task { await model.bootstrap() }
                .onReceive(NotificationCenter.default.publisher(for: .spottPushTokenUpdated)) { _ in
                    Task { await model.registerPendingPushToken() }
                }
                .onOpenURL {
                    if !GoogleSignInManager.shared.handle($0) {
                        model.open(url: $0)
                    }
                }
        }
        .modelContainer(persistence.container)
    }
}
