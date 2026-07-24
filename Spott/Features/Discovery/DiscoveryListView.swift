import SwiftUI

struct DiscoveryHomeList: View {
    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let store: DiscoveryStore
    let feed: DiscoveryFeedStore?
    let isBrowse: Bool
    let ledger: DiscoveryFavoriteLedger
    let nearMeActive: Bool
    let locationAuthorized: Bool
    let locationUndetermined: Bool
    let actions: DiscoveryModuleActions
    let onClearNearMe: () -> Void
    let openMap: () -> Void
    let selectSort: (EventDiscoverySort?) -> Void

    private var feedLayout: DiscoveryFeedLayout {
        guard isBrowse, let feed else { return .empty }
        return feed.layout(
            locationAuthorized: locationAuthorized,
            locationUndetermined: locationUndetermined
        )
    }

    private var displayItems: [EventSummary] {
        guard isBrowse else { return store.items }
        let rendered = feedLayout.renderedEventIDs
        guard !rendered.isEmpty else { return store.items }
        return store.items.filter { !rendered.contains($0.id) }
    }

    private var boostedEventIDs: Set<UUID> {
        feed?.boostedEventIDs ?? []
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 24) {
                if isBrowse {
                    Group {
                        DiscoveryDateHeader(region: store.region)
                        browseModules
                        allEventsHeader
                    }
                    .transition(reduceMotion ? .identity : .opacity.combined(with: .offset(y: 8)))
                } else {
                    DiscoveryResultsSummaryRow(
                        store: store,
                        nearMeActive: nearMeActive,
                        onClearNearMe: onClearNearMe,
                        selectSort: selectSort
                    )
                    .transition(reduceMotion ? .identity : .opacity.combined(with: .offset(y: 8)))
                }
                eventCards
                DiscoveryPaginationFooter(store: store)
                    .padding(.horizontal, 16)
                if isBrowse, !store.hasMore, !displayItems.isEmpty {
                    DiscoveryColophon(region: store.region, openMap: openMap)
                }
                Color.clear
                    .frame(height: dynamicTypeSize.isAccessibilitySize ? 150 : 120)
                    .accessibilityHidden(true)
            }
            .padding(.top, 8)
            .animation(reduceMotion ? nil : SpottMotion.standard, value: isBrowse)
        }
        .scrollDismissesKeyboard(.immediately)
        .scrollEdgeEffectStyle(.soft, for: .top)
        .background(SpottScreenBackground())
        .accessibilityIdentifier("discovery.list")
    }

    @ViewBuilder
    private var browseModules: some View {
        let layout = feedLayout
        if layout.slots.isEmpty {
            if feed?.phase == .loading {
                DiscoveryFeedSkeleton()
            }
        } else {
            ForEach(layout.slots) { slot in
                switch slot {
                case .hero(let module):
                    DiscoveryHeroSection(module: module, ledger: ledger, actions: actions)
                case .shelf(let module):
                    DiscoveryShelfSection(
                        module: module,
                        locationAuthorized: locationAuthorized,
                        ledger: ledger,
                        actions: actions
                    )
                case .nearbyPrompt:
                    DiscoveryNearbyPromptRow(enable: actions.enableLocation)
                }
            }
        }
    }

    private var allEventsHeader: some View {
        HStack(alignment: .center, spacing: 12) {
            Text(verbatim: DiscoveryHomeLocalization.text("discovery.all.title", locale: locale))
                .font(.title2.weight(.bold))
                .foregroundStyle(SpottColor.ink)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            Text(verbatim: countText)
                .font(.caption.weight(.semibold))
                .foregroundStyle(SpottColor.muted)
                .monospacedDigit()
                .accessibilityIdentifier("discovery.result-count")
            DiscoverySortMenu(sort: store.sort, select: selectSort)
        }
        .padding(.horizontal, 16)
    }

    private var countText: String {
        DiscoveryHomeLocalization.format(
            store.hasMore ? "discovery.all.count_more" : "discovery.all.count",
            locale: locale,
            store.items.count
        )
    }

    private var eventCards: some View {
        ForEach(displayItems) { event in
            DiscoveryEventCard(
                event: event,
                promoted: boostedEventIDs.contains(event.id),
                ledger: ledger
            ) {
                actions.openEvent(event, boostedEventIDs.contains(event.id))
            }
            .padding(.horizontal, 16)
            .onAppear { loadNextPageIfNeeded(after: event) }
        }
    }

    private func loadNextPageIfNeeded(after event: EventSummary) {
        guard event.id == displayItems.last?.id, store.hasMore else { return }
        Task { await store.loadNextPage() }
    }
}

struct DiscoveryPaginationFooter: View {
    @Environment(\.locale) private var locale
    let store: DiscoveryStore

    var body: some View {
        Group {
            if store.isLoadingNextPage {
                HStack {
                    Spacer()
                    ProgressView(DiscoveryHomeLocalization.text(
                        "discovery.pagination.loading", locale: locale
                    ))
                    Spacer()
                }
            } else if let error = store.paginationError {
                Button(action: retry) {
                    Label(error.message, systemImage: "arrow.clockwise")
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.capsule)
            }
        }
    }

    private func retry() {
        Task { await store.retryPagination() }
    }
}

struct DiscoveryEventRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.locale) private var locale
    let event: EventSummary

    private var presentation: DiscoveryEventPresentation {
        DiscoveryEventPresentation(event: event, locale: locale)
    }

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 12) {
                    DiscoveryEventCover(event: event)
                        .frame(maxWidth: .infinity)
                        .aspectRatio(3.2, contentMode: .fit)
                    DiscoveryEventFacts(event: event, dynamicTypeSize: dynamicTypeSize)
                }
            } else {
                HStack(alignment: .top, spacing: 14) {
                    DiscoveryEventCover(event: event)
                        .frame(width: 112, height: 112)
                    DiscoveryEventFacts(event: event, dynamicTypeSize: dynamicTypeSize)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: presentation.accessibilitySummary))
        .accessibilityHint(Text(verbatim: DiscoveryHomeLocalization.text(
            "discovery.card.open_detail", locale: locale
        )))
        .accessibilityIdentifier("discovery.event.\(event.id.uuidString.lowercased())")
    }
}

private struct DiscoveryEventFacts: View {
    @Environment(\.locale) private var locale
    let event: EventSummary
    let dynamicTypeSize: DynamicTypeSize

    private var presentation: DiscoveryEventPresentation {
        DiscoveryEventPresentation(event: event, locale: locale)
    }

    private var capacitySymbol: String {
        event.remaining > 0 ? "person.badge.plus" : (event.waitlistEnabled ? "hourglass" : "person.2.slash")
    }

    private var formatSymbol: String {
        switch event.format {
        case .inPerson: "person.2"
        case .online: "video"
        case .hybrid: "person.2.wave.2"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            EventStartLabel(event: event)
            Text(verbatim: event.title)
                .font(.headline)
                .foregroundStyle(.primary)
                .multilineTextAlignment(.leading)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
            factLine(symbol: "mappin.and.ellipse", text: presentation.locationText)
            factLine(symbol: formatSymbol, text: presentation.formatText)
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 8) {
                    Label(presentation.feeText, systemImage: "yensign.circle")
                    Label(presentation.capacityText, systemImage: capacitySymbol)
                }
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
            } else {
                HStack(spacing: 12) {
                    Label(presentation.feeText, systemImage: "yensign.circle")
                    Spacer(minLength: 4)
                    Label(presentation.capacityText, systemImage: capacitySymbol)
                }
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func factLine(symbol: String, text: String) -> some View {
        Label {
            Text(verbatim: text)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
        } icon: {
            Image(systemName: symbol)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }
}

private struct EventStartLabel: View {
    @Environment(\.locale) private var locale
    let event: EventSummary

    private var presentation: DiscoveryEventPresentation {
        DiscoveryEventPresentation(event: event, locale: locale)
    }

    var body: some View {
        if event.startsAt != nil {
            Text(verbatim: presentation.shortDateText)
                .font(.caption.weight(.semibold))
                .foregroundStyle(SpottColor.muted)
        } else {
            Label {
                Text(verbatim: DiscoveryHomeLocalization.text(
                    "discovery.card.time_pending", locale: locale
                ))
            } icon: {
                Image(systemName: "calendar.badge.clock")
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
        }
    }
}
