import SwiftUI

struct DiscoveryResultsList: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let store: DiscoveryStore

    var body: some View {
        List {
            Text("\(store.items.count) 个活动")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
                .listRowSeparator(.hidden)
                .accessibilityIdentifier("discovery.result-count")

            ForEach(store.items) { event in
                Button { open(event) } label: {
                    DiscoveryEventRow(event: event)
                }
                .buttonStyle(.plain)
                .contentShape(Rectangle())
                .listRowInsets(.init(top: 12, leading: 16, bottom: 12, trailing: 16))
                .onAppear { loadNextPageIfNeeded(after: event) }
            }

            DiscoveryPaginationFooter(store: store)

            Color.clear
                .frame(height: dynamicTypeSize.isAccessibilitySize ? 96 : 24)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .accessibilityHidden(true)
        }
        .listStyle(.plain)
        .scrollDismissesKeyboard(.immediately)
        .refreshable { await store.refresh() }
        .accessibilityIdentifier("discovery.list")
    }

    private func open(_ event: EventSummary) {
        model.show(event: event)
    }

    private func loadNextPageIfNeeded(after event: EventSummary) {
        guard event.id == store.items.last?.id, store.hasMore else { return }
        Task { await store.loadNextPage() }
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
                        .frame(width: 112, height: 112)
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
                .foregroundStyle(SpottColor.twilight)
        } else {
            Label("时间待定", systemImage: "calendar.badge.clock")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
        }
    }
}
