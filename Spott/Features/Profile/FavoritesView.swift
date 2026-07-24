import SwiftUI

struct FavoritesView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale
    @State private var events: [EventSummary] = []
    @State private var loading = true
    @State private var error: UserFacingError?

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 14) {
                if loading {
                    ProgressView().padding(.top, 90)
                } else if let error {
                    SpottEmptyState(
                        icon: "wifi.exclamationmark",
                        title: text("profile.favorites.error_title"),
                        message: error.message,
                        actionTitle: text("profile.home.retry")
                    ) {
                        Task { await load() }
                    }
                    .padding(.top, 40)
                } else if events.isEmpty {
                    SpottEmptyState(
                        icon: "heart",
                        title: text("profile.favorites.empty_title"),
                        message: text("profile.favorites.empty_message")
                    )
                    .padding(.top, 40)
                } else {
                    ForEach(events) { event in
                        Button {
                            model.show(event: event)
                        } label: {
                            FavoriteEventCard(event: event, locale: locale)
                        }
                        .buttonStyle(.plain)
                        .spottPressable()
                        .accessibilityIdentifier("favorite.event.\(event.publicSlug)")
                    }
                }
            }
            .padding(SpottMetric.pageInset)
        }
        .background(SpottScreenBackground())
        .navigationTitle(Text(text("profile.favorites.title")))
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        do {
            events = try await model.api.favoriteEvents().items
            error = nil
        } catch {
            self.error = AppModel.map(error)
        }
        loading = false
    }

    private func text(_ key: String.LocalizationValue) -> String {
        ProfileTabLocalization.text(key, locale: locale)
    }
}

private struct FavoriteEventCard: View {
    let event: EventSummary
    let locale: Locale

    var body: some View {
        HStack(spacing: 14) {
            EventCoverView(url: event.coverURL, category: event.category, cornerRadius: 16)
                .frame(width: 86, height: 86)
            VStack(alignment: .leading, spacing: 5) {
                Text(event.title)
                    .font(.subheadline.weight(.bold))
                    .fontDesign(.rounded)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Label(timeText, systemImage: "clock")
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
                    .lineLimit(1)
                if let area = event.publicArea, !area.isEmpty {
                    Label(area, systemImage: "mappin.and.ellipse")
                        .font(.caption)
                        .foregroundStyle(SpottColor.muted)
                        .lineLimit(1)
                }
                if let feeText {
                    Text(feeText)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(event.fee?.isFree == true ? SpottColor.mint : SpottColor.ink)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(
                            (event.fee?.isFree == true ? SpottColor.mint : SpottColor.ink).opacity(0.08),
                            in: Capsule()
                        )
                }
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.bold))
                .foregroundStyle(SpottColor.muted.opacity(0.55))
                .accessibilityHidden(true)
        }
        .foregroundStyle(SpottColor.ink)
        .padding(12)
        .frame(minHeight: 44)
        .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous)
                .stroke(SpottColor.hairline)
        )
        .contentShape(RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    private var timeText: String {
        guard let startsAt = event.startsAt else {
            return ProfileTabLocalization.text("profile.favorites.time_tbd", locale: locale)
        }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = TimeZone(identifier: event.displayTimeZone) ?? .current
        formatter.setLocalizedDateFormatFromTemplate("MMMdEjm")
        return formatter.string(from: startsAt)
    }

    private var feeText: String? {
        guard let fee = event.fee else { return nil }
        if fee.isFree {
            return ProfileTabLocalization.text("profile.favorites.fee_free", locale: locale)
        }
        guard let amount = fee.amountJPY else { return nil }
        return ProfileTabLocalization.format("profile.favorites.fee_onsite", locale: locale, amount)
    }
}
