import SwiftUI

private enum DiscoveryDisplayMode: String, CaseIterable, Identifiable {
    case list
    case map

    var id: String { rawValue }
}

struct DiscoveryView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale
    @State private var store: DiscoveryStore
    @State private var displayMode = DiscoveryDisplayMode.list
    @State private var showsMapResults = false
    @State private var selectedMapEventID: UUID?
    @State private var mapSheetDetent = PresentationDetent.height(188)

    init(store: DiscoveryStore) {
        _store = State(initialValue: store)
    }

    var body: some View {
        @Bindable var store = store
        VStack(spacing: 0) {
            DiscoveryFilterStrip(store: store)
            Divider()
            DiscoveryContent(
                store: store,
                displayMode: displayMode,
                selectedMapEventID: $selectedMapEventID,
                showsMapResults: $showsMapResults
            )
        }
        .background(Color(uiColor: .systemBackground))
        .navigationTitle("发现")
        .navigationBarTitleDisplayMode(.large)
        .searchable(
            text: $store.searchText,
            placement: .navigationBarDrawer(displayMode: .automatic),
            prompt: Text("搜索活动、地区或兴趣")
        )
        .onChange(of: store.searchText, searchChanged)
        .onSubmit(of: .search, submitSearch)
        .toolbar { discoveryToolbar }
        .safeAreaInset(edge: .top, spacing: 0) {
            if let error = store.refreshError {
                DiscoveryRefreshBanner(phase: store.phase, error: error, retry: refresh)
            }
        }
        .sheet(isPresented: $showsMapResults) {
            MapResultsSheet(
                events: store.mapEvents,
                selectedEventID: $selectedMapEventID
            )
            .presentationDetents([.height(188), .medium, .large], selection: $mapSheetDetent)
            .presentationDragIndicator(.visible)
            .presentationBackgroundInteraction(.enabled(upThrough: .medium))
        }
        .onChange(of: locale.identifier, initial: true) { _, _ in
            store.updateLocale(locale)
        }
        .accessibilityIdentifier("discovery.screen")
    }

    @ToolbarContentBuilder
    private var discoveryToolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            Menu {
                regionButton("东京", value: "tokyo")
                regionButton("神奈川", value: "kanagawa")
                regionButton("大阪", value: "osaka")
                regionButton("京都", value: "kyoto")
            } label: {
                Label(regionTitle, systemImage: "location")
            }
            .accessibilityLabel("地区")
            .accessibilityIdentifier("discovery.region")

            Button(action: toggleDisplayMode) {
                Label(
                    displayMode == .list ? "显示地图" : "显示列表",
                    systemImage: displayMode == .list ? "map" : "list.bullet"
                )
            }
            .accessibilityIdentifier("discovery.mode")

            Button(action: openNotifications) {
                Label("通知", systemImage: "bell")
            }
            .accessibilityIdentifier("discovery.notifications")
        }
    }

    private var regionTitle: LocalizedStringKey {
        switch store.region {
        case "tokyo": "东京"
        case "kanagawa": "神奈川"
        case "osaka": "大阪"
        case "kyoto": "京都"
        default: "日本"
        }
    }

    private func regionButton(_ title: LocalizedStringKey, value: String) -> some View {
        Button {
            selectRegion(value)
        } label: {
            if store.region == value {
                Label(title, systemImage: "checkmark")
            } else {
                Text(title)
            }
        }
    }

    private func searchChanged(oldValue: String, newValue: String) {
        store.searchDidChange()
    }

    private func submitSearch() {
        Task { await store.refresh() }
    }

    private func refresh() {
        Task { await store.refresh() }
    }

    private func toggleDisplayMode() {
        displayMode = displayMode == .list ? .map : .list
        showsMapResults = displayMode == .map
        if showsMapResults { mapSheetDetent = .height(188) }
    }

    private func selectRegion(_ value: String) {
        store.selectRegion(value)
    }

    private func openNotifications() {
        model.router.push(.notifications)
    }
}

private struct DiscoveryContent: View {
    let store: DiscoveryStore
    let displayMode: DiscoveryDisplayMode
    @Binding var selectedMapEventID: UUID?
    @Binding var showsMapResults: Bool

    var body: some View {
        Group {
            switch store.phase {
            case .initial, .loading:
                DiscoverySkeleton()
            case .empty:
                DiscoveryEmptyState(store: store)
            case .error:
                DiscoveryErrorState(store: store)
            case .content, .offline:
                if displayMode == .list {
                    DiscoveryResultsList(store: store)
                } else {
                    DiscoveryMap(
                        store: store,
                        selectedEventID: $selectedMapEventID,
                        showsResults: $showsMapResults
                    )
                }
            }
        }
    }
}
