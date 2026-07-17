import Foundation
import SwiftUI

enum EventFactKind: String, CaseIterable, Sendable {
    case time
    case location
    case format
    case language
    case fee
    case capacity
}

struct EventFactPresentation: Identifiable, Equatable, Sendable {
    let kind: EventFactKind
    let systemImage: String
    let title: String
    let value: String
    let detail: String?

    var id: EventFactKind { kind }
}

struct EventFactsPresentation: Equatable, Sendable {
    let items: [EventFactPresentation]

    init(
        event: EventSummary,
        disclosure: EventLocationDisclosure,
        locale: Locale
    ) {
        items = [
            Self.timeFact(event: event, locale: locale),
            Self.locationFact(event: event, disclosure: disclosure, locale: locale),
            Self.formatFact(event: event, locale: locale),
            Self.languageFact(event: event, locale: locale),
            Self.feeFact(event: event, locale: locale),
            Self.capacityFact(event: event, locale: locale),
        ]
    }

    private static func timeFact(
        event: EventSummary,
        locale: Locale
    ) -> EventFactPresentation {
        let value = CoreJourneyLocalization.dateTime(
            event.startsAt,
            timeZoneIdentifier: event.displayTimeZone,
            locale: locale
        )
        let detail: String?
        if let endsAt = event.endsAt {
            detail = CoreJourneyLocalization.format(
                "journey.fact.ends_at",
                locale: locale,
                CoreJourneyLocalization.dateTime(
                    endsAt,
                    timeZoneIdentifier: event.displayTimeZone,
                    locale: locale
                )
            )
        } else {
            detail = nil
        }
        return .init(
            kind: .time,
            systemImage: "calendar",
            title: text("journey.fact.time", locale),
            value: value,
            detail: detail
        )
    }

    private static func locationFact(
        event: EventSummary,
        disclosure: EventLocationDisclosure,
        locale: Locale
    ) -> EventFactPresentation {
        let value: String
        let detail: String?
        switch disclosure {
        case .exact(let publicArea, let address, _):
            value = publicArea
            detail = address
        case .approximate(let publicArea):
            value = publicArea
            detail = text("journey.fact.approximate_location", locale)
        case .unavailable where event.format == .online:
            value = text("journey.fact.online_event", locale)
            detail = nil
        case .unavailable:
            value = text("journey.fact.location_unavailable", locale)
            detail = nil
        }
        return .init(
            kind: .location,
            systemImage: event.format == .online ? "video" : "mappin.and.ellipse",
            title: text("journey.fact.location", locale),
            value: value,
            detail: detail
        )
    }

    private static func formatFact(
        event: EventSummary,
        locale: Locale
    ) -> EventFactPresentation {
        let key: String.LocalizationValue = switch event.format {
        case .inPerson: "journey.format.in_person"
        case .online: "journey.format.online"
        case .hybrid: "journey.format.hybrid"
        }
        return .init(
            kind: .format,
            systemImage: event.format == .online ? "video.fill" : "person.2.fill",
            title: text("journey.fact.format", locale),
            value: text(key, locale),
            detail: nil
        )
    }

    private static func languageFact(
        event: EventSummary,
        locale: Locale
    ) -> EventFactPresentation {
        let supported = event.supportedLocales.isEmpty
            ? [event.primaryLocale]
            : event.supportedLocales
        let languages = supported.map { languageName($0, locale: locale) }
            .joined(separator: text("journey.fact.language_separator", locale))
        let detail = event.localeConfirmed
            ? nil
            : text("journey.fact.language_unconfirmed", locale)
        return .init(
            kind: .language,
            systemImage: "character.bubble.fill",
            title: text("journey.fact.language", locale),
            value: languages,
            detail: detail
        )
    }

    private static func feeFact(
        event: EventSummary,
        locale: Locale
    ) -> EventFactPresentation {
        let value: String
        let detail: String?
        if let fee = event.fee {
            if fee.isFree {
                value = text("journey.fee.free", locale)
            } else if let amount = fee.amountJPY {
                value = amount.formatted(
                    .currency(code: "JPY")
                        .precision(.fractionLength(0))
                        .locale(locale)
                )
            } else {
                value = [fee.collectorName, fee.method]
                    .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { !$0.isEmpty }
                    .joined(separator: " · ")
                detail = nil
                return .init(
                    kind: .fee,
                    systemImage: "yensign.circle",
                    title: text("journey.fact.fee", locale),
                    value: value.isEmpty ? text("journey.fee.details", locale) : value,
                    detail: nil
                )
            }
            detail = fee.refundPolicy?.trimmingCharacters(in: .whitespacesAndNewlines)
        } else {
            value = text("journey.fee.unavailable", locale)
            detail = nil
        }
        return .init(
            kind: .fee,
            systemImage: "yensign.circle",
            title: text("journey.fact.fee", locale),
            value: value,
            detail: detail?.isEmpty == false ? detail : nil
        )
    }

    private static func capacityFact(
        event: EventSummary,
        locale: Locale
    ) -> EventFactPresentation {
        let value: String
        if event.capacity <= 0 {
            value = text("journey.capacity.open", locale)
        } else if event.availableCapacity > 0 {
            value = CoreJourneyLocalization.format(
                "journey.capacity.remaining",
                locale: locale,
                event.availableCapacity,
                event.capacity
            )
        } else if event.waitlistEnabled {
            value = text("journey.capacity.waitlist", locale)
        } else {
            value = text("journey.capacity.full", locale)
        }
        let detail = event.capacity > 0
            ? CoreJourneyLocalization.format(
                "journey.capacity.confirmed",
                locale: locale,
                event.confirmedCount,
                event.capacity
            )
            : nil
        return .init(
            kind: .capacity,
            systemImage: "person.2",
            title: text("journey.fact.capacity", locale),
            value: value,
            detail: detail
        )
    }

    private static func languageName(
        _ language: EventLocale,
        locale: Locale
    ) -> String {
        let key: String.LocalizationValue = switch language {
        case .zhHans: "journey.language.zh_hans"
        case .ja: "journey.language.ja"
        case .en: "journey.language.en"
        }
        return text(key, locale)
    }

    private static func text(
        _ key: String.LocalizationValue,
        _ locale: Locale
    ) -> String {
        CoreJourneyLocalization.text(key, locale: locale)
    }
}

struct EventFactsView: View {
    let presentation: EventFactsPresentation

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(presentation.items.enumerated()), id: \.element.id) { index, item in
                EventFactRow(item: item)
                if index < presentation.items.count - 1 {
                    Divider().padding(.leading, 54)
                }
            }
        }
        .background(
            Color(uiColor: .secondarySystemGroupedBackground),
            in: RoundedRectangle(cornerRadius: 20, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(Color.primary.opacity(0.08), lineWidth: 0.5)
        }
    }
}

private struct EventFactRow: View {
    let item: EventFactPresentation

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: item.systemImage)
                .font(.body.weight(.semibold))
                .foregroundStyle(SpottColor.twilight)
                .frame(width: 28, height: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(item.value)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail = item.detail {
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 13)
        .accessibilityElement(children: .combine)
    }
}
