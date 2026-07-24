import SwiftUI

struct DiscoveryChipBar: View {
    @Environment(\.locale) private var locale
    let store: DiscoveryStore
    let nearMeActive: Bool
    let activeFilterCount: Int
    let onFilterTap: () -> Void
    let onNearMeTap: () -> Void

    var body: some View {
        SpottGlassGroup(spacing: 8) {
            HStack(spacing: 8) {
                filterButton
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        nearMeChip
                        ForEach(DiscoveryCategoryDescriptor.all) { category in
                            GlassChip(
                                title: DiscoveryHomeLocalization.text(
                                    category.titleKey, locale: locale
                                ),
                                systemImage: category.symbol,
                                isSelected: store.category == category.value,
                                tint: DiscoveryCategoryDescriptor.accent(
                                    forValue: category.value
                                )
                            ) {
                                select(category.value)
                            }
                        }
                    }
                    .padding(.vertical, 8)
                }
                .contentMargins(.trailing, 16, for: .scrollContent)
                .scrollClipDisabled()
            }
            .padding(.leading, 16)
        }
        // minHeight (not a fixed height) so Dynamic Type can grow the bar
        // instead of clipping chip text at accessibility sizes.
        .frame(minHeight: 52)
        .sensoryFeedback(.selection, trigger: store.category)
        .accessibilityIdentifier("discovery.filters")
    }

    private var filterButton: some View {
        GlassIconButton(
            systemImage: "line.3.horizontal.decrease",
            accessibilityLabel: DiscoveryHomeLocalization.text(
                "discovery.chip.filters", locale: locale
            ),
            tint: activeFilterCount > 0 ? SpottColor.twilight : nil,
            action: onFilterTap
        )
        .overlay(alignment: .topTrailing) {
            if activeFilterCount > 0 {
                Text(verbatim: "\(activeFilterCount)")
                    .font(.caption2.weight(.bold))
                    .monospacedDigit()
                    .foregroundStyle(.white)
                    .frame(minWidth: 16, minHeight: 16)
                    .background(SpottColor.twilight, in: Circle())
                    .accessibilityHidden(true)
            }
        }
        .accessibilityValue(
            activeFilterCount > 0
                ? Text(verbatim: DiscoveryHomeLocalization.format(
                    "discovery.chip.filters.active", locale: locale, activeFilterCount
                ))
                : Text(verbatim: "")
        )
        .accessibilityIdentifier("discovery.more-filters")
    }

    private var nearMeChip: some View {
        GlassChip(
            title: DiscoveryHomeLocalization.text("discovery.chip.nearby", locale: locale),
            systemImage: "location.fill",
            isSelected: nearMeActive,
            action: onNearMeTap
        )
    }

    private func select(_ category: String?) {
        guard store.category != category else { return }
        store.category = category
        store.filtersDidChange()
    }
}

extension EventDiscoverySort {
    var titleKey: String.LocalizationValue {
        switch self {
        case .recommended: "discovery.sort.recommended"
        case .time: "discovery.sort.time"
        case .newest: "discovery.sort.newest"
        case .almostFull: "discovery.sort.almost_full"
        case .distance: "discovery.sort.distance"
        }
    }
}

/// Sort menu pill shared by the S5 "全部活动" header, the RESULTS summary row
/// and the Filter Sheet. Selection is forwarded to the owner so the distance
/// sort can run the CoreLocation authorization flow before it activates.
struct DiscoverySortMenu: View {
    @Environment(\.locale) private var locale
    let sort: EventDiscoverySort?
    let select: (EventDiscoverySort?) -> Void

    private var selection: Binding<EventDiscoverySort> {
        Binding(
            get: { sort ?? .recommended },
            set: { select($0 == .recommended ? nil : $0) }
        )
    }

    var body: some View {
        Menu {
            Picker(
                DiscoveryHomeLocalization.text("discovery.sort.title", locale: locale),
                selection: selection
            ) {
                ForEach(EventDiscoverySort.allCases, id: \.self) { option in
                    Text(verbatim: DiscoveryHomeLocalization.text(
                        option.titleKey, locale: locale
                    ))
                    .tag(option)
                }
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "arrow.up.arrow.down")
                    .font(.caption2.weight(.semibold))
                Text(verbatim: DiscoveryHomeLocalization.text(
                    (sort ?? .recommended).titleKey, locale: locale
                ))
                .font(.caption.weight(.semibold))
                .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.bold))
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 6)
            .foregroundStyle(sort == nil ? SpottColor.ink : Color.white)
            .glassEffect(
                sort == nil ? .regular.interactive() : .regular.tint(SpottColor.twilight).interactive(),
                in: Capsule()
            )
            .contentShape(Capsule())
            .frame(minHeight: 44)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(verbatim: DiscoveryHomeLocalization.text(
            "discovery.sort.title", locale: locale
        )))
        .accessibilityValue(Text(verbatim: DiscoveryHomeLocalization.text(
            (sort ?? .recommended).titleKey, locale: locale
        )))
        .accessibilityIdentifier("discovery.sort")
    }
}

struct DiscoveryResultsSummaryRow: View {
    @Environment(\.locale) private var locale
    let store: DiscoveryStore
    let nearMeActive: Bool
    let onClearNearMe: () -> Void
    let selectSort: (EventDiscoverySort?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text(verbatim: countText)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(SpottColor.muted)
                    .monospacedDigit()
                    .accessibilityIdentifier("discovery.result-count")
                if store.hasActiveFilters {
                    Button {
                        onClearNearMe()
                        store.clearFilters()
                    } label: {
                        Text(verbatim: DiscoveryHomeLocalization.text(
                            "discovery.results.clear", locale: locale
                        ))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(SpottColor.ink)
                        .frame(minHeight: 44)
                    }
                    .buttonStyle(.plain)
                }
                Spacer(minLength: 8)
                DiscoverySortMenu(sort: store.sort, select: selectSort)
            }
            if !activeChips.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(activeChips) { chip in
                            RemovableFilterChip(title: chip.title, remove: chip.remove)
                        }
                    }
                }
                .scrollClipDisabled()
            }
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

    private struct ActiveChip: Identifiable {
        let id: String
        let title: String
        let remove: () -> Void
    }

    private var activeChips: [ActiveChip] {
        var chips: [ActiveChip] = []
        let engine = DiscoveryDateFilterEngine()
        if let dateLabel = engine.chipLabel(
            startsAfter: store.startsAfter,
            startsBefore: store.startsBefore,
            locale: locale
        ) {
            chips.append(.init(id: "date", title: dateLabel) {
                store.startsAfter = nil
                store.startsBefore = nil
                store.filtersDidChange()
            })
        }
        if let price = store.price {
            let key: String.LocalizationValue = price == .free
                ? "discovery.filter.price.free"
                : "discovery.filter.price.paid"
            chips.append(.init(
                id: "price",
                title: DiscoveryHomeLocalization.text(key, locale: locale)
            ) {
                store.price = nil
                store.filtersDidChange()
            })
        }
        if let format = store.format {
            let key: String.LocalizationValue = switch format {
            case .inPerson: "discovery.filter.format.in_person"
            case .online: "discovery.filter.format.online"
            case .hybrid: "discovery.filter.format.hybrid"
            }
            chips.append(.init(
                id: "format",
                title: DiscoveryHomeLocalization.text(key, locale: locale)
            ) {
                store.format = nil
                store.filtersDidChange()
            })
        }
        if let language = store.language {
            let key: String.LocalizationValue = switch language {
            case .zhHans: "discovery.filter.language.zh"
            case .ja: "discovery.filter.language.ja"
            case .en: "discovery.filter.language.en"
            }
            chips.append(.init(
                id: "language",
                title: DiscoveryHomeLocalization.text(key, locale: locale)
            ) {
                store.language = nil
                store.filtersDidChange()
            })
        }
        if store.availableOnly == true {
            chips.append(.init(
                id: "available",
                title: DiscoveryHomeLocalization.text("discovery.filter.available", locale: locale)
            ) {
                store.availableOnly = nil
                store.filtersDidChange()
            })
        }
        if store.bounds != nil {
            let key: String.LocalizationValue = nearMeActive
                ? "discovery.results.chip.nearby"
                : "discovery.results.chip.map_area"
            chips.append(.init(
                id: "bounds",
                title: DiscoveryHomeLocalization.text(key, locale: locale)
            ) {
                onClearNearMe()
                store.bounds = nil
                store.filtersDidChange()
            })
        }
        return chips
    }
}

private struct RemovableFilterChip: View {
    @Environment(\.locale) private var locale
    let title: String
    let remove: () -> Void

    var body: some View {
        Button(action: remove) {
            HStack(spacing: 5) {
                Text(verbatim: title)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                Image(systemName: "xmark")
                    .font(.caption2.weight(.bold))
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 7)
            .foregroundStyle(SpottColor.twilightDeep)
            .background(SpottColor.twilightPale, in: Capsule())
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(verbatim: DiscoveryHomeLocalization.format(
            "discovery.results.chip.remove", locale: locale, title
        )))
    }
}
