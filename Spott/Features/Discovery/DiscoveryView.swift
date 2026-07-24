import SwiftUI
import UIKit

private enum DiscoveryDisplayMode: String, CaseIterable, Identifiable {
    case list
    case map

    var id: String { rawValue }
}

private enum DiscoveryRecentSearchStore {
    static let storageKey = "spott.discovery.recent-searches"
    static let limit = 5

    static func load() -> [String] {
        UserDefaults.standard.stringArray(forKey: storageKey) ?? []
    }

    static func save(_ terms: [String]) {
        UserDefaults.standard.set(Array(terms.prefix(limit)), forKey: storageKey)
    }
}

struct DiscoveryView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var store: DiscoveryStore
    @State private var feed: DiscoveryFeedStore?
    @State private var ledger = DiscoveryFavoriteLedger()
    @State private var locationAuthority = DiscoveryLocationAuthority()
    @State private var displayMode = DiscoveryDisplayMode.list
    @State private var showsMapResults = false
    @State private var selectedMapEventID: UUID?
    @State private var mapSheetDetent = PresentationDetent.height(188)
    @State private var showsFilterSheet = false
    @State private var showsLocationDeniedAlert = false
    @State private var nearMeActive = false
    @State private var recentSearches = DiscoveryRecentSearchStore.load()

    init(store: DiscoveryStore) {
        _store = State(initialValue: store)
    }

    private var isBrowse: Bool {
        store.searchText.trimmed.isEmpty && !store.hasActiveFilters
    }

    private var activeFilterCount: Int {
        var count = 0
        if store.startsAfter != nil || store.startsBefore != nil { count += 1 }
        if store.availableOnly != nil { count += 1 }
        if store.format != nil { count += 1 }
        if store.language != nil { count += 1 }
        if store.price != nil { count += 1 }
        if store.bounds != nil { count += 1 }
        return count
    }

    var body: some View {
        @Bindable var store = store
        DiscoveryContent(
            store: store,
            feed: feed,
            isBrowse: isBrowse,
            displayMode: displayMode,
            ledger: ledger,
            nearMeActive: nearMeActive,
            locationAuthorized: locationAuthority.isAuthorized,
            locationUndetermined: locationAuthority.isUndetermined,
            actions: moduleActions,
            onClearNearMe: { nearMeActive = false },
            openMap: { displayMode = .map },
            applyWeekendPreset: applyWeekendPreset,
            selectSort: applySort,
            selectedMapEventID: $selectedMapEventID,
            showsMapResults: $showsMapResults
        )
        .refreshable { await refreshAll() }
        .navigationTitle(Text(verbatim: text("discovery.title")))
        .navigationBarTitleDisplayMode(.large)
        .searchable(
            text: $store.searchText,
            placement: .navigationBarDrawer(displayMode: .automatic),
            prompt: Text(verbatim: text("discovery.search.prompt"))
        )
        .searchSuggestions {
            DiscoverySearchSuggestions(
                recentSearches: recentSearches,
                onSelectTerm: applyRecentSearch,
                onDeleteTerm: deleteRecentSearch,
                onSelectCategory: applyCategoryShortcut
            )
        }
        .onChange(of: store.searchText, searchChanged)
        .onSubmit(of: .search, submitSearch)
        .toolbar { discoveryToolbar }
        .safeAreaInset(edge: .top, spacing: 0) {
            if let error = store.refreshError {
                DiscoveryRefreshBanner(phase: store.phase, error: error, retry: refresh)
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            DiscoveryChipBar(
                store: store,
                nearMeActive: nearMeActive,
                activeFilterCount: activeFilterCount,
                onFilterTap: { showsFilterSheet = true },
                onNearMeTap: toggleNearMe
            )
        }
        .sheet(isPresented: $showsFilterSheet) {
            DiscoveryFilterSheet(store: store, selectSort: applySort)
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
        .alert(
            Text(verbatim: text("discovery.location.denied.title")),
            isPresented: $showsLocationDeniedAlert
        ) {
            Button(text("discovery.location.denied.settings")) {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    model.openExternal(url: url)
                }
            }
            Button(text("discovery.location.denied.cancel"), role: .cancel) {}
        } message: {
            Text(verbatim: text("discovery.location.denied.message"))
        }
        .onAppear(perform: prepare)
        .task(id: store.region) { await loadFeedIfNeeded() }
        .onChange(of: isBrowse) { _, entersBrowse in
            guard entersBrowse else { return }
            Task { await loadFeedIfNeeded() }
        }
        .onChange(of: model.session?.sessionId) { _, _ in
            ledger.reset()
            feed?.resetForSessionChange()
            Task { await loadFeedIfNeeded() }
        }
        .onChange(of: store.bounds) { _, bounds in
            if bounds == nil { nearMeActive = false }
        }
        .onChange(of: locale.identifier, initial: true) { _, _ in
            store.updateLocale(locale)
        }
        .overlay(alignment: .bottomTrailing) {
            // Anchored to Discovery's own safe area (above the tab bar) instead
            // of a hand-tuned app-shell offset; hidden in MAP mode so it never
            // collides with the map results pill / selected-pin mini card.
            if displayMode == .list, model.router.path(for: .discovery).isEmpty {
                DiscoveryCreateButton()
                    .padding(.trailing, 16)
                    .padding(.bottom, 12)
            }
        }
        .accessibilityIdentifier("discovery.screen")
    }

    private var moduleActions: DiscoveryModuleActions {
        DiscoveryModuleActions(
            openEvent: { event, promoted in model.show(event: event, promoted: promoted) },
            applyTodayPreset: applyTodayPreset,
            applyWeekendPreset: applyWeekendPreset,
            openNearbyMap: openNearbyMap,
            enableLocation: enableLocationForNearby
        )
    }

    @ToolbarContentBuilder
    private var discoveryToolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Menu {
                ForEach(DiscoveryRegionCatalog.regions, id: \.value) { region in
                    regionButton(
                        DiscoveryHomeLocalization.text(region.titleKey, locale: locale),
                        value: region.value
                    )
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "location")
                    Text(verbatim: DiscoveryRegionCatalog.title(for: store.region, locale: locale))
                    Image(systemName: "chevron.down")
                        .font(.caption2.weight(.bold))
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(SpottColor.ink)
            }
            .accessibilityLabel(Text(verbatim: text("discovery.region.accessibility")))
            .accessibilityIdentifier("discovery.region")
        }

        ToolbarItemGroup(placement: .topBarTrailing) {
            Button(action: openNotifications) {
                Label {
                    Text(verbatim: text("discovery.toolbar.notifications"))
                } icon: {
                    Image(systemName: "bell")
                }
            }
            .tint(SpottColor.ink)
            .accessibilityIdentifier("discovery.notifications")

            Button(action: toggleDisplayMode) {
                Label {
                    Text(verbatim: text(
                        displayMode == .list
                            ? "discovery.toolbar.show_map"
                            : "discovery.toolbar.show_list"
                    ))
                } icon: {
                    Image(systemName: displayMode == .list ? "map" : "list.bullet")
                        .contentTransition(.symbolEffect(.replace))
                }
            }
            .tint(SpottColor.ink)
            .accessibilityIdentifier("discovery.mode")
        }
    }

    private func regionButton(_ title: String, value: String) -> some View {
        Button {
            store.selectRegion(value)
        } label: {
            if store.region == value {
                Label {
                    Text(verbatim: title)
                } icon: {
                    Image(systemName: "checkmark")
                }
            } else {
                Text(verbatim: title)
            }
        }
    }

    private func prepare() {
        if feed == nil {
            feed = DiscoveryFeedStore(service: model.api)
        }
        locationAuthority.prepare()
    }

    private func loadFeedIfNeeded() async {
        guard !model.usesNavigationUITestFixture, isBrowse else { return }
        if feed == nil {
            feed = DiscoveryFeedStore(service: model.api)
        }
        await feed?.loadIfNeeded(
            region: store.region,
            bounds: locationAuthority.isAuthorized ? locationAuthority.boundsAroundLatestFix() : nil
        )
    }

    private func refreshAll() async {
        if !model.usesNavigationUITestFixture, isBrowse, let feed {
            async let feedRefresh: Void = feed.load(
                region: store.region,
                bounds: locationAuthority.isAuthorized
                    ? locationAuthority.boundsAroundLatestFix()
                    : nil
            )
            _ = await store.refresh()
            await feedRefresh
        } else {
            _ = await store.refresh()
        }
    }

    private func searchChanged(oldValue: String, newValue: String) {
        store.searchDidChange()
    }

    private func submitSearch() {
        recordRecentSearch(store.searchText)
        Task { await store.refresh() }
    }

    private func refresh() {
        Task { await refreshAll() }
    }

    private func toggleDisplayMode() {
        displayMode = displayMode == .list ? .map : .list
        if displayMode == .list {
            selectedMapEventID = nil
        }
    }

    private func openNotifications() {
        model.router.push(.notifications)
    }

    private func toggleNearMe() {
        if nearMeActive {
            nearMeActive = false
            store.bounds = nil
            store.filtersDidChange()
            return
        }
        if locationAuthority.isDenied {
            showsLocationDeniedAlert = true
            return
        }
        locationAuthority.requestFix { fix in
            guard let fix else {
                if locationAuthority.isDenied {
                    showsLocationDeniedAlert = true
                }
                return
            }
            nearMeActive = true
            store.bounds = DiscoveryLocationAuthority.bounds(around: fix)
            store.filtersDidChange()
        }
    }

    private func enableLocationForNearby() {
        locationAuthority.requestFix { fix in
            guard let fix, !model.usesNavigationUITestFixture else { return }
            Task {
                await feed?.load(
                    region: store.region,
                    bounds: DiscoveryLocationAuthority.bounds(around: fix)
                )
            }
        }
    }

    private func openNearbyMap() {
        displayMode = .map
        locationAuthority.requestFix { fix in
            guard let fix else { return }
            nearMeActive = true
            store.bounds = DiscoveryLocationAuthority.bounds(around: fix)
            store.filtersDidChange()
        }
    }

    /// Applies a sort selection. The distance sort needs a real location
    /// origin — the server would silently fall back to the time sort without
    /// one — so it runs the same when-in-use authorization flow as 附近 and
    /// only activates once a fix exists. No fix, no distance sort.
    private func applySort(_ sort: EventDiscoverySort?) {
        guard sort != store.sort else { return }
        guard sort == .distance else {
            store.sort = sort
            store.nearOrigin = nil
            store.filtersDidChange()
            return
        }
        if locationAuthority.isDenied {
            showsLocationDeniedAlert = true
            return
        }
        locationAuthority.requestFix { fix in
            guard let fix else {
                if locationAuthority.isDenied {
                    showsLocationDeniedAlert = true
                }
                return
            }
            store.nearOrigin = DiscoveryNearOrigin(
                latitude: fix.latitude,
                longitude: fix.longitude
            )
            store.sort = .distance
            store.filtersDidChange()
        }
    }

    private func applyTodayPreset() {
        let range = DiscoveryDateFilterEngine().todayRange()
        store.startsAfter = range.after
        store.startsBefore = range.before
        store.filtersDidChange()
    }

    private func applyWeekendPreset() {
        let range = DiscoveryDateFilterEngine().weekendRange()
        store.startsAfter = range.after
        store.startsBefore = range.before
        store.filtersDidChange()
    }

    private func applyRecentSearch(_ term: String) {
        store.searchText = term
        recordRecentSearch(term)
    }

    private func deleteRecentSearch(_ term: String) {
        recentSearches.removeAll { $0 == term }
        DiscoveryRecentSearchStore.save(recentSearches)
    }

    private func applyCategoryShortcut(_ category: String?) {
        store.searchText = ""
        guard store.category != category else { return }
        store.category = category
        store.filtersDidChange()
    }

    private func recordRecentSearch(_ rawTerm: String) {
        let term = rawTerm.trimmed
        guard !term.isEmpty else { return }
        var terms = recentSearches.filter { $0 != term }
        terms.insert(term, at: 0)
        recentSearches = Array(terms.prefix(DiscoveryRecentSearchStore.limit))
        DiscoveryRecentSearchStore.save(recentSearches)
    }

    private func text(_ key: String.LocalizationValue) -> String {
        DiscoveryHomeLocalization.text(key, locale: locale)
    }
}

private struct DiscoveryContent: View {
    let store: DiscoveryStore
    let feed: DiscoveryFeedStore?
    let isBrowse: Bool
    let displayMode: DiscoveryDisplayMode
    let ledger: DiscoveryFavoriteLedger
    let nearMeActive: Bool
    let locationAuthorized: Bool
    let locationUndetermined: Bool
    let actions: DiscoveryModuleActions
    let onClearNearMe: () -> Void
    let openMap: () -> Void
    let applyWeekendPreset: () -> Void
    let selectSort: (EventDiscoverySort?) -> Void
    @Binding var selectedMapEventID: UUID?
    @Binding var showsMapResults: Bool

    var body: some View {
        Group {
            switch store.phase {
            case .initial, .loading:
                DiscoverySkeleton(showsModules: isBrowse)
            case .empty:
                DiscoveryEmptyState(
                    store: store,
                    applyWeekendPreset: applyWeekendPreset,
                    onClearNearMe: onClearNearMe
                )
            case .error:
                DiscoveryErrorState(store: store)
            case .content, .offline:
                if displayMode == .list {
                    DiscoveryHomeList(
                        store: store,
                        feed: feed,
                        isBrowse: isBrowse,
                        ledger: ledger,
                        nearMeActive: nearMeActive,
                        locationAuthorized: locationAuthorized,
                        locationUndetermined: locationUndetermined,
                        actions: actions,
                        onClearNearMe: onClearNearMe,
                        openMap: openMap,
                        selectSort: selectSort
                    )
                } else {
                    DiscoveryMap(
                        store: store,
                        locationAuthorized: locationAuthorized,
                        selectedEventID: $selectedMapEventID,
                        showsResults: $showsMapResults,
                        openEvent: { actions.openEvent($0, false) }
                    )
                }
            }
        }
    }
}

private struct DiscoverySearchSuggestions: View {
    @Environment(\.locale) private var locale
    @Environment(\.dismissSearch) private var dismissSearch
    let recentSearches: [String]
    let onSelectTerm: (String) -> Void
    let onDeleteTerm: (String) -> Void
    let onSelectCategory: (String?) -> Void

    var body: some View {
        if !recentSearches.isEmpty {
            Section {
                ForEach(recentSearches, id: \.self) { term in
                    HStack(spacing: 8) {
                        Button {
                            onSelectTerm(term)
                        } label: {
                            Label {
                                Text(verbatim: term)
                                    .foregroundStyle(.primary)
                            } icon: {
                                Image(systemName: "clock.arrow.circlepath")
                            }
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        Button {
                            onDeleteTerm(term)
                        } label: {
                            Image(systemName: "xmark")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                                .frame(width: 44, height: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(Text(verbatim: DiscoveryHomeLocalization.format(
                            "discovery.search.recent.delete", locale: locale, term
                        )))
                    }
                }
            } header: {
                Text(verbatim: DiscoveryHomeLocalization.text(
                    "discovery.search.recent", locale: locale
                ))
            }
        }
        Section {
            ForEach(DiscoveryCategoryDescriptor.all.filter { $0.value != nil }) { category in
                Button {
                    onSelectCategory(category.value)
                    dismissSearch()
                } label: {
                    Label {
                        Text(verbatim: DiscoveryHomeLocalization.text(
                            category.titleKey, locale: locale
                        ))
                        .foregroundStyle(.primary)
                    } icon: {
                        Image(systemName: category.symbol)
                            .foregroundStyle(DiscoveryCategoryDescriptor.accent(
                                forValue: category.value
                            ))
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        } header: {
            Text(verbatim: DiscoveryHomeLocalization.text(
                "discovery.search.categories", locale: locale
            ))
        }
    }
}
