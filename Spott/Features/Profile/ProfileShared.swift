import SwiftUI

struct ProfileStat: View {
    let value: String
    let title: String
    var body: some View {
        VStack(spacing: 5) {
            Text(value)
                .font(.title3.bold())
                .fontDesign(.rounded)
            Text(LocalizedStringKey(title)).font(.caption).foregroundStyle(SpottColor.muted)
        }
        // Content tile (红线2): solid surface, not glass.
        .frame(maxWidth: .infinity, minHeight: 72)
        .background(
            SpottColor.canvas,
            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(SpottColor.divider)
        )
        .accessibilityElement(children: .combine)
    }
}

struct CompactEventRow: View {
    @Environment(\.locale) private var locale
    let event: EventSummary
    var body: some View {
        HStack(spacing: 14) {
            EventCoverView(url: event.coverURL, category: event.category, cornerRadius: 14)
                .frame(width: 78, height: 78)
            VStack(alignment: .leading, spacing: 6) {
                Text(event.title)
                    .font(.subheadline.weight(.bold))
                    .fontDesign(.rounded)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Text(
                    event.startsAt?.formatted(.dateTime.month().day().hour().minute())
                        ?? ProfileTabLocalization.text("profile.favorites.time_tbd", locale: locale)
                )
                .font(.caption)
                .foregroundStyle(SpottColor.muted)
                Text(event.publicArea ?? "").font(.caption).foregroundStyle(SpottColor.muted).lineLimit(1)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption.weight(.bold))
                .foregroundStyle(SpottColor.muted.opacity(0.55))
                .accessibilityHidden(true)
        }
        .foregroundStyle(SpottColor.ink)
        .padding(13)
        .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous)
                .stroke(SpottColor.hairline)
        )
        .accessibilityElement(children: .combine)
    }
}
