import SwiftUI

@MainActor
@Observable
final class DiscoveryFavoriteLedger {
    private(set) var overrides: [UUID: Bool] = [:]
    @ObservationIgnored private var inFlight: Set<UUID> = []

    func displayedFavorited(for event: EventSummary) -> Bool {
        overrides[event.id] ?? event.favorited
    }

    func toggle(_ event: EventSummary, model: AppModel) {
        guard model.session != nil else {
            // Keep the tapped heart as a deferred intent: the gate shows the
            // event context and the favorite is applied right after login.
            model.deferFavorite(event: event, desired: !displayedFavorited(for: event))
            return
        }
        guard !inFlight.contains(event.id) else { return }
        let target = !displayedFavorited(for: event)
        overrides[event.id] = target
        inFlight.insert(event.id)
        Task { @MainActor in
            defer { inFlight.remove(event.id) }
            do {
                try await model.api.setFavorite(eventID: event.id, enabled: target)
            } catch {
                overrides[event.id] = !target
                model.banner = .init(title: AppModel.map(error).message, tone: .warning)
            }
        }
    }

    func reset() {
        overrides.removeAll()
    }
}

enum DiscoveryCapacityBadge: Equatable {
    case count(confirmed: Int, capacity: Int)
    case remainingLow(Int)
    case waitlist
    case full
}

struct DiscoveryCardPresentation {
    let event: EventSummary
    let locale: Locale
    let now: Date

    init(event: EventSummary, locale: Locale, now: Date = Date()) {
        self.event = event
        self.locale = locale
        self.now = now
    }

    private var eventTimeZone: TimeZone {
        TimeZone(identifier: event.displayTimeZone) ?? TimeZone(identifier: "Asia/Tokyo")!
    }

    private var eventCalendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = eventTimeZone
        calendar.locale = locale
        return calendar
    }

    var startText: String {
        guard let startsAt = event.startsAt else {
            return DiscoveryHomeLocalization.text("discovery.card.time_pending", locale: locale)
        }
        let timeText = startsAt.formatted(
            Date.FormatStyle(time: .shortened, locale: locale, timeZone: eventTimeZone)
        )
        let calendar = eventCalendar
        if calendar.isDate(startsAt, inSameDayAs: now) {
            return DiscoveryHomeLocalization.format(
                "discovery.card.today", locale: locale, timeText
            )
        }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now),
           calendar.isDate(startsAt, inSameDayAs: tomorrow) {
            return DiscoveryHomeLocalization.format(
                "discovery.card.tomorrow", locale: locale, timeText
            )
        }
        return startsAt.formatted(
            Date.FormatStyle(locale: locale, timeZone: eventTimeZone)
                .month(.defaultDigits)
                .day()
                .weekday(.abbreviated)
                .hour()
                .minute()
        )
    }

    var venueText: String? {
        event.publicArea
    }

    var startVenueLine: String {
        guard let venueText else { return startText }
        return "\(startText) · \(venueText)"
    }

    var categoryText: String? {
        DiscoveryCategoryDescriptor.title(forSlug: event.category, locale: locale)
    }

    var feeText: String {
        guard let fee = event.fee else {
            return DiscoveryHomeLocalization.text("discovery.card.fee_pending", locale: locale)
        }
        if fee.isFree {
            return DiscoveryHomeLocalization.text("discovery.card.free", locale: locale)
        }
        guard let amount = fee.amountJPY else {
            return DiscoveryHomeLocalization.text("discovery.card.fee_pending", locale: locale)
        }
        let amountText = amount.formatted(.number.locale(locale))
        if let collector = fee.collectorName, !collector.isEmpty {
            return "¥\(amountText) · \(collector)"
        }
        return DiscoveryHomeLocalization.format(
            "discovery.card.fee_onsite", locale: locale, amountText
        )
    }

    var categoryFeeLine: String {
        guard let categoryText else { return feeText }
        return "\(categoryText) · \(feeText)"
    }

    var capacityBadge: DiscoveryCapacityBadge {
        let remaining = event.remaining
        if remaining <= 0 {
            return event.waitlistEnabled ? .waitlist : .full
        }
        let threshold = max(2, Int((Double(event.capacity) * 0.2).rounded(.up)))
        if remaining <= threshold {
            return .remainingLow(remaining)
        }
        return .count(confirmed: event.confirmedCount, capacity: event.capacity)
    }

    var capacityText: String {
        switch capacityBadge {
        case .count(let confirmed, let capacity):
            DiscoveryHomeLocalization.format(
                "discovery.card.capacity", locale: locale, confirmed, capacity
            )
        case .remainingLow(let remaining):
            DiscoveryHomeLocalization.format(
                "discovery.card.remaining_low", locale: locale, remaining
            )
        case .waitlist:
            DiscoveryHomeLocalization.text("discovery.card.waitlist", locale: locale)
        case .full:
            DiscoveryHomeLocalization.text("discovery.card.full", locale: locale)
        }
    }

    var isCapacityUrgent: Bool {
        if case .remainingLow = capacityBadge { return true }
        if case .full = capacityBadge { return true }
        return false
    }

    var trustLine: String? {
        var parts: [String] = []
        if event.organizer.trust.completedEventCount > 0 {
            parts.append(DiscoveryHomeLocalization.format(
                "discovery.card.hosted_count",
                locale: locale,
                event.organizer.trust.completedEventCount
            ))
        }
        switch event.organizer.trust.attendanceRateBand {
        case .over90:
            parts.append(
                DiscoveryHomeLocalization.text("discovery.card.attendance_90", locale: locale)
            )
        case .from70To89:
            parts.append(
                DiscoveryHomeLocalization.text("discovery.card.attendance_70", locale: locale)
            )
        case .under70, .unavailable:
            break
        }
        guard !parts.isEmpty else { return nil }
        return parts.joined(separator: " · ")
    }

    var isHostVerified: Bool {
        event.organizer.trust.phoneVerified
    }

    func accessibilitySummary(promoted: Bool) -> String {
        var parts: [String] = []
        if promoted {
            parts.append(DiscoveryHomeLocalization.text("discovery.card.promoted", locale: locale))
        }
        parts.append(event.title)
        parts.append(startText)
        if let venueText { parts.append(venueText) }
        parts.append(feeText)
        parts.append(capacityText)
        if let trustLine { parts.append(trustLine) }
        return parts.joined(separator: ", ")
    }
}

struct DiscoveryFavoriteHeart: View {
    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let event: EventSummary
    let ledger: DiscoveryFavoriteLedger
    var diameter: CGFloat = 36

    private var favorited: Bool {
        ledger.displayedFavorited(for: event)
    }

    var body: some View {
        Button {
            ledger.toggle(event, model: model)
        } label: {
            Image(systemName: favorited ? "heart.fill" : "heart")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(favorited ? Color.white : SpottColor.ink)
                .frame(width: diameter, height: diameter)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .glassEffect(
            favorited
                ? .regular.tint(SpottColor.twilight).interactive()
                : .regular.interactive(),
            in: Circle()
        )
        .frame(width: 44, height: 44)
        .contentShape(Circle())
        .animation(reduceMotion ? nil : SpottMotion.emphatic, value: favorited)
        .sensoryFeedback(.impact, trigger: favorited)
        .accessibilityLabel(Text(verbatim: DiscoveryHomeLocalization.text(
            favorited ? "discovery.card.unfavorite" : "discovery.card.favorite",
            locale: locale
        )))
        .accessibilityIdentifier("discovery.favorite.\(event.id.uuidString.lowercased())")
    }
}

/// Wraps the design-kit `CapacityRing` so its stroke draws in once when the
/// card appears (spec S2), optionally staggered between sibling cards. Under
/// Reduce Motion the final value renders immediately with no animation.
private struct DiscoveryCapacityRing: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let confirmed: Int
    let capacity: Int
    let size: CGFloat
    var revealDelay: Duration = .zero
    @State private var revealed = false

    var body: some View {
        CapacityRing(
            confirmed: revealed || reduceMotion ? confirmed : 0,
            capacity: capacity,
            size: size
        )
        .task {
            guard !revealed, !reduceMotion else { return }
            if revealDelay > .zero {
                try? await Task.sleep(for: revealDelay)
            }
            revealed = true
        }
    }
}

private struct DiscoveryCapacityCluster: View {
    let presentation: DiscoveryCardPresentation
    let ringSize: CGFloat
    var textColor: Color = SpottColor.muted

    var body: some View {
        HStack(spacing: 6) {
            DiscoveryCapacityRing(
                confirmed: presentation.event.confirmedCount,
                capacity: presentation.event.capacity,
                size: ringSize
            )
            Text(verbatim: presentation.capacityText)
                .font(.caption.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(presentation.isCapacityUrgent ? SpottColor.coral : textColor)
        }
    }
}

struct DiscoveryHeroCard: View {
    /// Sized so the poster — including its bottom meta row (capacity ring) —
    /// lands entirely above Discovery's floating chrome at the resting scroll
    /// offset: the tab bar capsule and the create FAB both live in the bottom
    /// ~150pt of the screen, and a taller card pushed the ring underneath them.
    static let posterHeight: CGFloat = 360

    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let event: EventSummary
    let promoted: Bool
    let ledger: DiscoveryFavoriteLedger
    var capacityStaggerIndex: Int = 0
    let open: () -> Void

    private var presentation: DiscoveryCardPresentation {
        DiscoveryCardPresentation(event: event, locale: locale)
    }

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                accessibilityLayout
            } else {
                scrimLayout
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: presentation.accessibilitySummary(promoted: promoted)))
        .accessibilityHint(Text(verbatim: DiscoveryHomeLocalization.text(
            "discovery.card.open_detail", locale: locale
        )))
        .accessibilityAddTraits(.isButton)
        .accessibilityAction {
            open()
        }
        .accessibilityAction(named: Text(verbatim: DiscoveryHomeLocalization.text(
            ledger.displayedFavorited(for: event)
                ? "discovery.card.unfavorite"
                : "discovery.card.favorite",
            locale: locale
        ))) {
            ledger.toggle(event, model: model)
        }
        .accessibilityIdentifier("discovery.hero.\(event.id.uuidString.lowercased())")
    }

    private var scrimLayout: some View {
        Button(action: open) {
            EventCoverView(url: event.coverURL, category: event.category, cornerRadius: 24)
                .frame(height: Self.posterHeight)
                .overlay(alignment: .bottom) { scrim }
                .overlay(alignment: .bottomLeading) { heroText }
                .overlay(alignment: .topLeading) { promotedOverlay }
                .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        }
        .buttonStyle(.plain)
        .spottPressable(scale: 0.98)
        .overlay(alignment: .topTrailing) {
            DiscoveryFavoriteHeart(event: event, ledger: ledger, diameter: 36)
                .padding(10)
        }
    }

    /// The text zone (bottom ~180pt) stays at ≥0.86 black so white type keeps
    /// ≥4.5:1 contrast over any cover, including a pure-white one; only the
    /// upper ramp is translucent for the photographic falloff.
    private var scrim: some View {
        LinearGradient(
            stops: [
                .init(color: .black.opacity(0), location: 0),
                .init(color: .black.opacity(0.32), location: 0.14),
                .init(color: .black.opacity(0.65), location: 0.22),
                .init(color: .black.opacity(0.86), location: 0.32),
                .init(color: .black.opacity(0.94), location: 1)
            ],
            startPoint: .top,
            endPoint: .bottom
        )
        .frame(height: 260)
        .allowsHitTesting(false)
    }

    private var promotedOverlay: some View {
        Group {
            if promoted {
                PromotedBadge()
                    .padding(12)
            }
        }
    }

    private var heroText: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                if let categoryText = presentation.categoryText {
                    Text(verbatim: categoryText)
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(.white.opacity(0.22), in: Capsule())
                }
                Text(verbatim: presentation.startText)
                    .font(.caption.weight(.semibold))
            }
            .foregroundStyle(.white)
            Text(verbatim: event.title)
                .font(.title2.weight(.bold))
                .foregroundStyle(.white)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
            Text(verbatim: heroSubtitle)
                .font(.subheadline)
                .foregroundStyle(.white.opacity(0.85))
                .lineLimit(1)
            HStack(alignment: .bottom, spacing: 8) {
                if let trustLine = presentation.trustLine {
                    Label {
                        Text(verbatim: trustLine)
                    } icon: {
                        Image(systemName: "checkmark.seal.fill")
                    }
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.85))
                    .lineLimit(1)
                }
                Spacer(minLength: 8)
                heroCapacity
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var heroSubtitle: String {
        if let venueText = presentation.venueText {
            "\(venueText) · \(presentation.feeText)"
        } else {
            presentation.feeText
        }
    }

    private var heroCapacity: some View {
        HStack(spacing: 6) {
            DiscoveryCapacityRing(
                confirmed: event.confirmedCount,
                capacity: event.capacity,
                size: 28,
                revealDelay: .milliseconds(capacityStaggerIndex * 40)
            )
            Text(verbatim: presentation.capacityText)
                .font(.caption.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(
                    presentation.isCapacityUrgent ? SpottColor.coral : .white.opacity(0.9)
                )
        }
    }

    private var accessibilityLayout: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 0) {
                EventCoverView(url: event.coverURL, category: event.category, cornerRadius: 0)
                    .frame(height: 200)
                    .overlay(alignment: .topLeading) { promotedOverlay }
                VStack(alignment: .leading, spacing: 8) {
                    Text(verbatim: presentation.startVenueLine)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(SpottColor.muted)
                    Text(verbatim: event.title)
                        .font(.title3.weight(.bold))
                        .foregroundStyle(SpottColor.ink)
                        .multilineTextAlignment(.leading)
                    Text(verbatim: presentation.categoryFeeLine)
                        .font(.footnote)
                        .foregroundStyle(SpottColor.muted)
                    if let trustLine = presentation.trustLine {
                        Label {
                            Text(verbatim: trustLine)
                        } icon: {
                            Image(systemName: "checkmark.seal.fill")
                        }
                        .font(.caption)
                        .foregroundStyle(SpottColor.muted)
                    }
                    DiscoveryCapacityCluster(presentation: presentation, ringSize: 20)
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(SpottColor.surface)
            }
            .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

struct DiscoveryShelfCard: View {
    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let event: EventSummary
    let promoted: Bool
    let ledger: DiscoveryFavoriteLedger
    let open: () -> Void

    private var presentation: DiscoveryCardPresentation {
        DiscoveryCardPresentation(event: event, locale: locale)
    }

    private var cardWidth: CGFloat {
        dynamicTypeSize.isAccessibilitySize ? 300 : 240
    }

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 8) {
                EventCoverView(url: event.coverURL, category: event.category, cornerRadius: 18)
                    .frame(width: cardWidth, height: 132)
                    .overlay(alignment: .topLeading) {
                        if promoted {
                            PromotedBadge()
                                .padding(8)
                        }
                    }
                Text(verbatim: presentation.startText)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(SpottColor.muted)
                Text(verbatim: event.title)
                    .font(.headline)
                    .foregroundStyle(SpottColor.ink)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                if let venueText = presentation.venueText {
                    Text(verbatim: venueText)
                        .font(.footnote)
                        .foregroundStyle(SpottColor.muted)
                        .lineLimit(1)
                }
                HStack(spacing: 4) {
                    Text(verbatim: presentation.feeText)
                        .font(.caption)
                        .foregroundStyle(SpottColor.muted)
                        .lineLimit(1)
                    if presentation.isHostVerified {
                        Image(systemName: "checkmark.seal.fill")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(SpottColor.muted)
                    }
                    Spacer(minLength: 4)
                    DiscoveryCapacityCluster(presentation: presentation, ringSize: 16)
                }
                .frame(minHeight: 20)
            }
            .frame(width: cardWidth, alignment: .leading)
        }
        .buttonStyle(.plain)
        .spottPressable(scale: 0.97)
        .overlay(alignment: .topTrailing) {
            DiscoveryFavoriteHeart(event: event, ledger: ledger, diameter: 32)
                .padding(4)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: presentation.accessibilitySummary(promoted: promoted)))
        .accessibilityHint(Text(verbatim: DiscoveryHomeLocalization.text(
            "discovery.card.open_detail", locale: locale
        )))
        .accessibilityAddTraits(.isButton)
        .accessibilityAction {
            open()
        }
        .accessibilityAction(named: Text(verbatim: DiscoveryHomeLocalization.text(
            ledger.displayedFavorited(for: event)
                ? "discovery.card.unfavorite"
                : "discovery.card.favorite",
            locale: locale
        ))) {
            ledger.toggle(event, model: model)
        }
        .accessibilityIdentifier("discovery.shelf-event.\(event.id.uuidString.lowercased())")
    }
}

struct DiscoveryEventCard: View {
    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let event: EventSummary
    let promoted: Bool
    let ledger: DiscoveryFavoriteLedger
    let open: () -> Void

    private var presentation: DiscoveryCardPresentation {
        DiscoveryCardPresentation(event: event, locale: locale)
    }

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 0) {
                EventCoverView(url: event.coverURL, category: event.category, cornerRadius: 0)
                    .aspectRatio(16 / 9, contentMode: .fit)
                    .overlay(alignment: .topLeading) {
                        if promoted {
                            PromotedBadge()
                                .padding(10)
                        }
                    }
                textBlock
            }
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(SpottColor.hairline)
            )
        }
        .buttonStyle(.plain)
        .spottPressable(scale: 0.98)
        .overlay(alignment: .topTrailing) {
            DiscoveryFavoriteHeart(event: event, ledger: ledger, diameter: 34)
                .padding(8)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: presentation.accessibilitySummary(promoted: promoted)))
        .accessibilityHint(Text(verbatim: DiscoveryHomeLocalization.text(
            "discovery.card.open_detail", locale: locale
        )))
        .accessibilityAddTraits(.isButton)
        .accessibilityAction {
            open()
        }
        .accessibilityAction(named: Text(verbatim: DiscoveryHomeLocalization.text(
            ledger.displayedFavorited(for: event)
                ? "discovery.card.unfavorite"
                : "discovery.card.favorite",
            locale: locale
        ))) {
            ledger.toggle(event, model: model)
        }
        .accessibilityIdentifier("discovery.event.\(event.id.uuidString.lowercased())")
    }

    private var textBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: presentation.startVenueLine)
                .font(.caption.weight(.semibold))
                .foregroundStyle(SpottColor.muted)
                .lineLimit(1)
            Text(verbatim: event.title)
                .font(.headline)
                .foregroundStyle(SpottColor.ink)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
            Text(verbatim: presentation.categoryFeeLine)
                .font(.footnote)
                .foregroundStyle(SpottColor.muted)
                .lineLimit(1)
            metaRow
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(SpottColor.surface)
    }

    @ViewBuilder
    private var metaRow: some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 8) {
                trustCluster
                DiscoveryCapacityCluster(presentation: presentation, ringSize: 20)
            }
        } else {
            HStack(spacing: 8) {
                trustCluster
                Spacer(minLength: 8)
                DiscoveryCapacityCluster(presentation: presentation, ringSize: 20)
            }
            .frame(minHeight: 24)
        }
    }

    @ViewBuilder
    private var trustCluster: some View {
        if let trustLine = presentation.trustLine {
            Label {
                Text(verbatim: trustLine)
            } icon: {
                Image(systemName: presentation.isHostVerified ? "checkmark.seal.fill" : "person.crop.circle")
            }
            .font(.caption)
            .foregroundStyle(SpottColor.muted)
            .lineLimit(1)
        } else if presentation.isHostVerified {
            Label {
                Text(verbatim: DiscoveryHomeLocalization.text(
                    "discovery.card.verified", locale: locale
                ))
            } icon: {
                Image(systemName: "checkmark.seal.fill")
            }
            .font(.caption)
            .foregroundStyle(SpottColor.muted)
            .lineLimit(1)
        }
    }
}
