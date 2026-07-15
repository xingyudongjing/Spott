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
        Task { await store.loadNextPage() }
    }
}

struct DiscoveryEventRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let event: EventSummary

    private var locationText: String {
        event.publicArea ?? String(localized: "地点待发布")
    }

    private var feeText: String {
        guard let fee = event.fee else { return String(localized: "费用待发布") }
        if fee.isFree { return String(localized: "免费") }
        if let amount = fee.amountJPY { return "¥\(amount.formatted())" }
        let method = [fee.collectorName, fee.method].compactMap { $0 }.joined(separator: " · ")
        return method.isEmpty ? String(localized: "费用待发布") : method
    }

    private var capacityText: String {
        if event.remaining > 0 { return String(localized: "余 \(event.remaining)") }
        return event.waitlistEnabled ? String(localized: "候补中") : String(localized: "已满员")
    }

    private var capacitySymbol: String {
        event.remaining > 0 ? "person.badge.plus" : (event.waitlistEnabled ? "hourglass" : "person.2.slash")
    }

    private var formatText: String {
        let format: String = switch event.format {
        case .inPerson: String(localized: "线下")
        case .online: String(localized: "线上")
        case .hybrid: String(localized: "混合")
        }
        guard event.localeConfirmed else {
            return "\(format) · \(String(localized: "活动语言待确认"))"
        }
        return "\(format) · \(localeText(event.primaryLocale))"
    }

    private var formatSymbol: String {
        switch event.format {
        case .inPerson: "person.2"
        case .online: "video"
        case .hybrid: "person.2.wave.2"
        }
    }

    private var accessibilitySummary: String {
        [event.title, dateText, locationText, formatText, feeText, capacityText]
            .joined(separator: ", ")
    }

    private var dateText: String {
        event.startsAt?.formatted(date: .long, time: .shortened) ?? String(localized: "时间待定")
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
        .accessibilityLabel(Text(verbatim: accessibilitySummary))
        .accessibilityHint("打开活动详情")
        .accessibilityIdentifier("discovery.event.\(event.id.uuidString.lowercased())")
    }

    private func localeText(_ locale: EventLocale) -> String {
        switch locale {
        case .zhHans: String(localized: "简体中文")
        case .ja: String(localized: "日本語")
        case .en: "English"
        }
    }
}

private struct DiscoveryEventFacts: View {
    let event: EventSummary
    let dynamicTypeSize: DynamicTypeSize

    private var locationText: String { event.publicArea ?? String(localized: "地点待发布") }

    private var feeText: String {
        guard let fee = event.fee else { return String(localized: "费用待发布") }
        if fee.isFree { return String(localized: "免费") }
        if let amount = fee.amountJPY { return "¥\(amount.formatted())" }
        let method = [fee.collectorName, fee.method].compactMap { $0 }.joined(separator: " · ")
        return method.isEmpty ? String(localized: "费用待发布") : method
    }

    private var capacityText: String {
        if event.remaining > 0 { return String(localized: "余 \(event.remaining)") }
        return event.waitlistEnabled ? String(localized: "候补中") : String(localized: "已满员")
    }

    private var capacitySymbol: String {
        event.remaining > 0 ? "person.badge.plus" : (event.waitlistEnabled ? "hourglass" : "person.2.slash")
    }

    private var formatText: String {
        let format: String = switch event.format {
        case .inPerson: String(localized: "线下")
        case .online: String(localized: "线上")
        case .hybrid: String(localized: "混合")
        }
        guard event.localeConfirmed else {
            return "\(format) · \(String(localized: "活动语言待确认"))"
        }
        let language: String = switch event.primaryLocale {
        case .zhHans: String(localized: "简体中文")
        case .ja: String(localized: "日本語")
        case .en: "English"
        }
        return "\(format) · \(language)"
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
            EventStartLabel(startsAt: event.startsAt)
            Text(verbatim: event.title)
                .font(.headline)
                .foregroundStyle(.primary)
                .multilineTextAlignment(.leading)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
            factLine(symbol: "mappin.and.ellipse", text: locationText)
            factLine(symbol: formatSymbol, text: formatText)
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 8) {
                    Label(feeText, systemImage: "yensign.circle")
                    Label(capacityText, systemImage: capacitySymbol)
                }
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
            } else {
                HStack(spacing: 12) {
                    Label(feeText, systemImage: "yensign.circle")
                    Spacer(minLength: 4)
                    Label(capacityText, systemImage: capacitySymbol)
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
    let startsAt: Date?

    var body: some View {
        if let startsAt {
            Text(startsAt.formatted(date: .abbreviated, time: .shortened))
                .font(.caption.weight(.semibold))
                .foregroundStyle(SpottColor.twilight)
        } else {
            Label("时间待定", systemImage: "calendar.badge.clock")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
        }
    }
}
