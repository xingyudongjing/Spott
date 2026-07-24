import Foundation

enum CoreJourneyLocalization {
    static func text(
        _ key: String.LocalizationValue,
        locale: Locale
    ) -> String {
        SpottLocalization.text(key, table: "CoreJourney", locale: locale)
    }

    static func format(
        _ key: String.LocalizationValue,
        locale: Locale,
        _ arguments: CVarArg...
    ) -> String {
        String(
            format: text(key, locale: locale),
            locale: locale,
            arguments: arguments
        )
    }

    static func dateTime(
        _ date: Date?,
        timeZoneIdentifier: String,
        locale: Locale
    ) -> String {
        guard let date else {
            return text("journey.fact.time_tbd", locale: locale)
        }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = TimeZone(identifier: timeZoneIdentifier) ?? .current
        formatter.setLocalizedDateFormatFromTemplate("MMMEdjmz")
        return formatter.string(from: date)
    }

    static func datePart(
        _ date: Date,
        template: String,
        timeZoneIdentifier: String,
        locale: Locale
    ) -> String {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = TimeZone(identifier: timeZoneIdentifier) ?? .current
        formatter.setLocalizedDateFormatFromTemplate(template)
        return formatter.string(from: date)
    }
}

#if DEBUG
enum CoreJourneyUIFixtureState: String, Equatable, Sendable {
    case registration
    case confirmed
    case pending
    case waitlisted
    case itinerary

    static let argument = "-spott-ui-test-core-journey-state"

    static func resolve(arguments: [String] = ProcessInfo.processInfo.arguments) -> Self? {
        guard let index = arguments.firstIndex(of: argument),
              arguments.indices.contains(index + 1) else { return nil }
        return Self(rawValue: arguments[index + 1])
    }
}
#endif
