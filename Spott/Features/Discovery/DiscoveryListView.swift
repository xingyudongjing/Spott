import SwiftUI

struct DiscoveryResultsContentLayout {
    let operationalBanner: DiscoveryOperationalBanner?
    let recommendationSections: [DiscoveryRecommendationSection]

    var firstScreenBanner: DiscoveryOperationalBanner? {
        guard let operationalBanner,
              operationalBanner.promotional else { return nil }
        return operationalBanner
    }

    var usesRecommendationSections: Bool {
        !recommendationSections.isEmpty
    }
}

struct DiscoveryResultsList: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.locale) private var locale
    let store: DiscoveryStore

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 16) {
                if let banner = contentLayout.firstScreenBanner {
                    DiscoveryOperationalEventCard(banner: banner) {
                        open(banner.event)
                    }
                }

                if contentLayout.usesRecommendationSections {
                    recommendationResults
                } else {
                    linearResults
                }

                DiscoveryPaginationFooter(store: store)
            }
            .padding(.horizontal, SpottMetric.pageInset)
            .padding(.top, 8)
        }
        .contentMargins(
            .bottom,
            layoutPolicy.listBottomContentMargin,
            for: .scrollContent
        )
        .background(SpottColor.canvas)
        .scrollDismissesKeyboard(.immediately)
        .refreshable { await store.refresh() }
        .accessibilityIdentifier("discovery.list")
    }

    private var layoutPolicy: DiscoveryChromeLayoutPolicy {
        DiscoveryChromeLayoutPolicy(dynamicTypeSize: dynamicTypeSize)
    }

    private var contentLayout: DiscoveryResultsContentLayout {
        DiscoveryResultsContentLayout(
            operationalBanner: store.operationalBanner,
            recommendationSections: store.recommendationSections
        )
    }

    @ViewBuilder
    private var linearResults: some View {
        if let featured = store.items.first {
            featuredButton(featured)
        }

        ForEach(Array(store.items.dropFirst())) { event in
            compactButton(event)
        }
    }

    @ViewBuilder
    private var recommendationResults: some View {
        ForEach(Array(store.recommendationSections.enumerated()), id: \.element.id) { index, section in
            DiscoveryRecommendationHeader(
                title: DiscoveryModulePresentation.title(
                    for: section.key,
                    serverFallback: section.serverTitle,
                    locale: locale
                ),
                count: section.events.count
            )
            .padding(.top, index == 0 ? 0 : 8)
            .accessibilityIdentifier("discovery.module.\(section.key)")

            if index == 0, let featured = section.events.first {
                featuredButton(featured)
                ForEach(Array(section.events.dropFirst())) { event in
                    compactButton(event)
                }
            } else {
                ForEach(section.events) { event in
                    compactButton(event)
                }
            }
        }
    }

    private func featuredButton(_ event: EventSummary) -> some View {
        Button { open(event) } label: {
            DiscoveryFeaturedEventCard(event: event)
        }
        .buttonStyle(.plain)
        .contentShape(RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous))
        .accessibilityLabel(
            Text(verbatim: DiscoveryEventPresentation(
                event: event,
                locale: locale
            ).accessibilitySummary)
        )
        .accessibilityHint("打开活动详情")
        .accessibilityIdentifier("discovery.featured-event")
        .onAppear { loadNextPageIfNeeded(after: event) }
    }

    private func compactButton(_ event: EventSummary) -> some View {
        Button { open(event) } label: {
            DiscoveryEventRow(event: event)
                .padding(14)
                .background(SpottColor.surface)
                .clipShape(RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous)
                        .stroke(SpottColor.hairline)
                }
        }
        .buttonStyle(.plain)
        .contentShape(Rectangle())
        .accessibilityIdentifier("discovery.event.\(event.id.uuidString.lowercased())")
        .onAppear { loadNextPageIfNeeded(after: event) }
    }

    private func open(_ event: EventSummary) {
        model.show(event: event)
    }

    private func loadNextPageIfNeeded(after event: EventSummary) {
        guard event.id == store.items.last?.id, store.hasMore else { return }
        Task { await store.loadNextPage() }
    }
}

private struct DiscoveryRecommendationHeader: View {
    let title: String
    let count: Int

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(verbatim: title)
                .font(.title2.bold())
                .foregroundStyle(SpottColor.ink)
            Spacer(minLength: 8)
            Text("\(count) 个活动")
                .font(.caption.weight(.semibold))
                .foregroundStyle(SpottColor.muted)
                .monospacedDigit()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

private struct DiscoveryOperationalEventCard: View {
    let banner: DiscoveryOperationalBanner
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 14) {
                DiscoveryEventCover(event: banner.event)
                    .frame(width: 88, height: 88)

                VStack(alignment: .leading, spacing: 5) {
                    Text(verbatim: banner.label)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(SpottColor.twilight)
                    Text(verbatim: banner.headline ?? banner.event.title)
                        .font(.headline)
                        .foregroundStyle(SpottColor.ink)
                        .multilineTextAlignment(.leading)
                        .lineLimit(2)
                    Text(verbatim: banner.event.publicArea ?? "")
                        .font(.caption)
                        .foregroundStyle(SpottColor.muted)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Image(systemName: "arrow.up.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(SpottColor.twilight)
            }
            .padding(12)
            .background(SpottColor.twilightPale.opacity(0.7))
            .clipShape(RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(verbatim: "\(banner.label), \(banner.event.title)"))
        .accessibilityHint("打开活动详情")
        .accessibilityIdentifier("discovery.operational-event")
    }
}

private struct DiscoveryFeaturedEventCard: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.locale) private var locale
    let event: EventSummary

    private var presentation: DiscoveryEventPresentation {
        DiscoveryEventPresentation(event: event, locale: locale)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack(alignment: .bottomLeading) {
                DiscoveryEventCover(event: event, cornerRadius: 0)
                    .aspectRatio(dynamicTypeSize.isAccessibilitySize ? 2.2 : 16 / 9, contentMode: .fit)

                Text(verbatim: presentation.shortDateText)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(SpottColor.ink)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(.regularMaterial, in: Capsule())
                    .padding(14)
            }

            VStack(alignment: .leading, spacing: 13) {
                Text(verbatim: event.title)
                    .font(.title2.bold())
                    .foregroundStyle(SpottColor.ink)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)

                Label(presentation.locationText, systemImage: "mappin.and.ellipse")
                    .font(.subheadline)
                    .foregroundStyle(SpottColor.muted)

                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 16) { eventFacts }
                    VStack(alignment: .leading, spacing: 8) { eventFacts }
                }

                HStack(spacing: 10) {
                    Text(String(event.organizer.name.prefix(1)))
                        .font(.subheadline.bold())
                        .frame(width: 34, height: 34)
                        .background(SpottColor.twilightPale, in: Circle())
                        .foregroundStyle(SpottColor.twilight)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(verbatim: event.organizer.name)
                            .font(.subheadline.weight(.semibold))
                        Text(verbatim: "@\(event.organizer.handle)")
                            .font(.caption)
                            .foregroundStyle(SpottColor.muted)
                    }
                    Spacer(minLength: 0)
                }

                if !event.tags.isEmpty {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 7) { tagChips }
                        VStack(alignment: .leading, spacing: 7) { tagChips }
                    }
                }
            }
            .padding(18)
        }
        .background(SpottColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous)
                .stroke(SpottColor.hairline)
        }
        .shadow(color: SpottColor.ink.opacity(0.07), radius: 24, y: 10)
    }

    @ViewBuilder
    private var eventFacts: some View {
        Label(presentation.feeText, systemImage: "yensign.circle")
        Label(presentation.capacityText, systemImage: event.remaining > 0 ? "person.badge.plus" : "hourglass")
    }

    @ViewBuilder
    private var tagChips: some View {
        ForEach(Array(event.tags.prefix(3)), id: \.self) { tag in
            Text(verbatim: tag)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(SpottColor.muted)
                .padding(.horizontal, 9)
                .padding(.vertical, 6)
                .background(SpottColor.canvas, in: Capsule())
        }
    }
}

private struct DiscoveryPaginationFooter: View {
    let store: DiscoveryStore

    var body: some View {
        Group {
            if store.isLoadingNextPage {
                HStack {
                    Spacer()
                    ProgressView("加载更多活动…")
                    Spacer()
                }
            } else if let error = store.paginationError {
                Button(action: retry) {
                    Label(error.message, systemImage: "arrow.clockwise")
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
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
                        .frame(width: 112, height: 168)
                    DiscoveryEventFacts(event: event, dynamicTypeSize: dynamicTypeSize)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: presentation.accessibilitySummary))
        .accessibilityHint("打开活动详情")
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

            Divider()

            DiscoveryOrganizerLine(organizer: event.organizer)

            if !event.tags.isEmpty {
                DiscoveryCompactTagChips(tags: Array(event.tags.prefix(3)))
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

private struct DiscoveryOrganizerLine: View {
    let organizer: EventOrganizer

    var body: some View {
        HStack(spacing: 8) {
            Text(String(organizer.name.prefix(1)))
                .font(.caption.weight(.bold))
                .foregroundStyle(SpottColor.twilight)
                .frame(width: 28, height: 28)
                .background(SpottColor.twilightPale, in: Circle())

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 6) { organizerIdentity }
                VStack(alignment: .leading, spacing: 1) { organizerIdentity }
            }
            Spacer(minLength: 0)
        }
        .frame(minHeight: 28)
    }

    @ViewBuilder
    private var organizerIdentity: some View {
        Text(verbatim: organizer.name)
            .font(.caption.weight(.semibold))
            .foregroundStyle(SpottColor.ink)
            .lineLimit(1)
        Text(verbatim: "@\(organizer.handle)")
            .font(.caption2)
            .foregroundStyle(SpottColor.muted)
            .lineLimit(1)
    }
}

private struct DiscoveryCompactTagChips: View {
    let tags: [String]

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 6) { chips }
            VStack(alignment: .leading, spacing: 6) { chips }
        }
    }

    @ViewBuilder
    private var chips: some View {
        ForEach(tags, id: \.self) { tag in
            Text(verbatim: "#\(tag)")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(SpottColor.twilight)
                .lineLimit(1)
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(SpottColor.twilightPale, in: Capsule())
        }
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
                .foregroundStyle(SpottColor.twilight)
        } else {
            Label("时间待定", systemImage: "calendar.badge.clock")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
        }
    }
}
