import SwiftUI

struct AppRootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        Group {
            if #available(iOS 26.0, *) {
                appTabs(selection: $model.selectedTab)
                    .tabBarMinimizeBehavior(.onScrollDown)
            } else {
                appTabs(selection: $model.selectedTab)
            }
        }
        .tint(SpottColor.twilight)
        .sheet(item: $model.presentedGate) { gate in
            GateView(gate: gate)
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

    private func appTabs(selection: Binding<AppTab>) -> some View {
        @Bindable var model = model
        return TabView(selection: selection) {
            NavigationStack(path: $model.discoveryPath) {
                DiscoveryView()
                    .navigationDestination(for: AppRoute.self) { route in
                        RouteView(route: route)
                    }
            }
            .tabItem { Label("发现", systemImage: "safari") }
            .tag(AppTab.discovery)

            NavigationStack {
                MyActivitiesView()
            }
            .tabItem { Label("行程", systemImage: "calendar") }
            .tag(AppTab.activities)

            NavigationStack {
                EventComposerView()
            }
            .tabItem { Label("创建", systemImage: "plus") }
            .tag(AppTab.create)

            NavigationStack {
                GroupsHomeView()
            }
            .tabItem { Label("社群", systemImage: "person.2") }
            .tag(AppTab.groups)

            NavigationStack {
                ProfileHomeView()
            }
            .tabItem { Label("我的", systemImage: "person") }
            .tag(AppTab.profile)
        }
    }
}

private struct RouteView: View {
    let route: AppRoute

    var body: some View {
        switch route {
        case .event(let event): EventDetailView(event: event)
        case .wallet: WalletView()
        case .notifications: NotificationsView()
        case .hostStudio: HostStudioView()
        case .settings: SettingsView()
        case .group(let id): GroupDetailView(groupID: id)
        case .profile(let identifier): PublicProfileView(identifier: identifier)
        }
    }
}

#Preview {
    AppRootView()
        .environment(AppModel.preview)
}
