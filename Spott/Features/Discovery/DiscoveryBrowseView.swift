import SwiftUI

struct DiscoveryModuleActions {
    /// `promoted` carries the feed item's recommendation.boosted flag so the
    /// detail hero can seed its 推广 badge from the originating card.
    var openEvent: (EventSummary, _ promoted: Bool) -> Void
    var applyTodayPreset: () -> Void
    var applyWeekendPreset: () -> Void
    var openNearbyMap: () -> Void
    var enableLocation: () -> Void
}

struct DiscoveryDateHeader: View {
    @Environment(\.locale) private var locale
    let region: String

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: "calendar")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(SpottColor.muted)
            Text(verbatim: dateText)
                .foregroundStyle(SpottColor.ink)
            Text(verbatim: "· \(regionText)")
                .foregroundStyle(SpottColor.muted)
        }
        .font(.footnote.weight(.medium))
        .lineLimit(1)
        .frame(minHeight: 28, alignment: .leading)
        .padding(.horizontal, 16)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isStaticText)
        .accessibilityIdentifier("discovery.date-header")
    }

    private var dateText: String {
        let timeZone = TimeZone(identifier: "Asia/Tokyo") ?? .current
        return Date().formatted(
            Date.FormatStyle(locale: locale, timeZone: timeZone)
                .month(.defaultDigits)
                .day()
                .weekday(.wide)
        )
    }

    private var regionText: String {
        DiscoveryRegionCatalog.title(for: region, locale: locale)
    }
}

struct DiscoveryModuleHeader: View {
    let eyebrow: String?
    let title: String
    let actionTitle: String?
    let action: (() -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                if let eyebrow {
                    Text(verbatim: eyebrow)
                        .font(.caption.weight(.semibold))
                        .kerning(1.2)
                        .foregroundStyle(SpottColor.muted)
                        .accessibilityHidden(true)
                }
                Text(verbatim: title)
                    .font(.title2.weight(.bold))
                    .foregroundStyle(SpottColor.ink)
                    .accessibilityAddTraits(.isHeader)
            }
            Spacer(minLength: 0)
            if let actionTitle, let action {
                Button(action: action) {
                    HStack(spacing: 3) {
                        Text(verbatim: actionTitle)
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.bold))
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(SpottColor.ink)
                    .frame(minHeight: 44)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 16)
    }
}

struct DiscoveryHeroSection: View {
    @Environment(\.locale) private var locale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let module: DiscoveryFeedModule
    let ledger: DiscoveryFavoriteLedger
    let actions: DiscoveryModuleActions

    private var descriptor: DiscoveryModuleDescriptor {
        .descriptor(forKey: module.key)
    }

    private var items: [DiscoveryFeedItem] {
        Array(module.items.prefix(DiscoveryFeedStore.heroItemLimit))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            DiscoveryModuleHeader(
                eyebrow: descriptor.eyebrow(locale: locale),
                title: descriptor.title(serverTitle: module.title, locale: locale),
                actionTitle: nil,
                action: nil
            )
            if dynamicTypeSize.isAccessibilitySize {
                VStack(spacing: 16) {
                    ForEach(items) { item in
                        heroCard(for: item)
                    }
                }
                .padding(.horizontal, 16)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                            heroCard(for: item, staggerIndex: index)
                                .containerRelativeFrame(.horizontal) { length, _ in
                                    max(length - 48, 200)
                                }
                                .scrollTransition { content, phase in
                                    content
                                        .scaleEffect(
                                            reduceMotion || phase.isIdentity ? 1 : 0.96
                                        )
                                        .opacity(
                                            reduceMotion || phase.isIdentity ? 1 : 0.92
                                        )
                                }
                        }
                    }
                    .scrollTargetLayout()
                }
                .scrollTargetBehavior(.viewAligned)
                .contentMargins(.horizontal, 16, for: .scrollContent)
                .scrollClipDisabled()
            }
        }
        .accessibilityIdentifier("discovery.module.\(module.key)")
    }

    private func heroCard(for item: DiscoveryFeedItem, staggerIndex: Int = 0) -> some View {
        DiscoveryHeroCard(
            event: item.event,
            promoted: item.recommendation?.boosted == true,
            ledger: ledger,
            capacityStaggerIndex: staggerIndex
        ) {
            actions.openEvent(item.event, item.recommendation?.boosted == true)
        }
    }
}

struct DiscoveryShelfSection: View {
    @Environment(\.locale) private var locale
    let module: DiscoveryFeedModule
    let locationAuthorized: Bool
    let ledger: DiscoveryFavoriteLedger
    let actions: DiscoveryModuleActions

    private var descriptor: DiscoveryModuleDescriptor {
        .descriptor(forKey: module.key)
    }

    private var isNearby: Bool {
        module.key == DiscoveryFeedStore.nearbyModuleKey
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            DiscoveryModuleHeader(
                eyebrow: descriptor.eyebrow(locale: locale),
                title: descriptor.title(serverTitle: module.title, locale: locale),
                actionTitle: seeAllTitle,
                action: seeAllAction
            )
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 12) {
                    ForEach(module.items) { item in
                        DiscoveryShelfCard(
                            event: item.event,
                            promoted: item.recommendation?.boosted == true,
                            ledger: ledger
                        ) {
                            actions.openEvent(item.event, item.recommendation?.boosted == true)
                        }
                    }
                }
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.viewAligned)
            .contentMargins(.horizontal, 16, for: .scrollContent)
            .scrollClipDisabled()
            if isNearby {
                Button(action: actions.openNearbyMap) {
                    Text(verbatim: DiscoveryHomeLocalization.text(
                        "discovery.module.nearby.view_map", locale: locale
                    ))
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.capsule)
                .tint(SpottColor.ink)
                .padding(.horizontal, 16)
            }
        }
        .accessibilityIdentifier("discovery.module.\(module.key)")
    }

    private var seeAllTitle: String? {
        switch descriptor.action {
        case .todayPreset, .weekendPreset:
            DiscoveryHomeLocalization.text("discovery.module.see_all", locale: locale)
        case .nearbyMap, nil:
            nil
        }
    }

    private var seeAllAction: (() -> Void)? {
        switch descriptor.action {
        case .todayPreset:
            actions.applyTodayPreset
        case .weekendPreset:
            actions.applyWeekendPreset
        case .nearbyMap, nil:
            nil
        }
    }
}

struct DiscoveryNearbyPromptRow: View {
    @Environment(\.locale) private var locale
    let enable: () -> Void

    var body: some View {
        SpottGlassGroup {
            HStack(spacing: 12) {
                Image(systemName: "location.circle")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(SpottColor.muted)
                Text(verbatim: DiscoveryHomeLocalization.text(
                    "discovery.module.nearby.enable.title", locale: locale
                ))
                .font(.footnote)
                .foregroundStyle(SpottColor.ink)
                .lineLimit(2)
                Spacer(minLength: 8)
                Button(action: enable) {
                    Text(verbatim: DiscoveryHomeLocalization.text(
                        "discovery.module.nearby.enable.action", locale: locale
                    ))
                    .font(.subheadline.weight(.semibold))
                    .padding(.horizontal, 4)
                    .frame(minHeight: 44)
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.capsule)
                .tint(SpottColor.ink)
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 72)
            .glassEffect(
                .regular,
                in: RoundedRectangle(cornerRadius: 18, style: .continuous)
            )
        }
        .padding(.horizontal, 16)
        .accessibilityIdentifier("discovery.nearby-prompt")
    }
}

struct DiscoveryColophon: View {
    @Environment(\.locale) private var locale
    let region: String
    let openMap: () -> Void

    var body: some View {
        VStack(spacing: 12) {
            Text(verbatim: DiscoveryHomeLocalization.format(
                "discovery.colophon.title",
                locale: locale,
                DiscoveryRegionCatalog.title(for: region, locale: locale)
            ))
            .font(.caption)
            .foregroundStyle(SpottColor.muted)
            Button(action: openMap) {
                Label(
                    DiscoveryHomeLocalization.text("discovery.colophon.map", locale: locale),
                    systemImage: "map"
                )
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 6)
                .frame(minHeight: 44)
            }
            .buttonStyle(.glass)
            .buttonBorderShape(.capsule)
            .tint(SpottColor.ink)
        }
        .frame(maxWidth: .infinity, minHeight: 96)
        .accessibilityIdentifier("discovery.colophon")
    }
}
