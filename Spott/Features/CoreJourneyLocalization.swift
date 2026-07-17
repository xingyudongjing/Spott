import Foundation

private final class CoreJourneyLocalizationBundleToken {}

private final class CoreJourneyLocalizationBundleCache: @unchecked Sendable {
    private var bundles: [String: Bundle] = [:]
    private let lock = NSLock()

    func bundle(for key: String, resolve: () -> Bundle) -> Bundle {
        lock.lock()
        if let bundle = bundles[key] {
            lock.unlock()
            return bundle
        }
        lock.unlock()

        let resolved = resolve()
        lock.lock()
        defer { lock.unlock() }
        if let bundle = bundles[key] {
            return bundle
        }
        bundles[key] = resolved
        return resolved
    }
}

enum CoreJourneyLocalization {
    static func text(
        _ key: String.LocalizationValue,
        locale: Locale
    ) -> String {
        String(
            localized: key,
            table: "CoreJourney",
            bundle: localizedBundle(for: locale),
            locale: locale
        )
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

    private static let sourceBundle = Bundle(for: CoreJourneyLocalizationBundleToken.self)
    private static let bundleCache = CoreJourneyLocalizationBundleCache()

    private static func localizedBundle(for locale: Locale) -> Bundle {
        let requestedIdentifier = locale.identifier
            .split(separator: "@", maxSplits: 1)
            .first
            .map(String.init)?
            .replacingOccurrences(of: "_", with: "-") ?? locale.identifier
        let language = requestedIdentifier
            .split(separator: "-", maxSplits: 1)
            .first
            .map(String.init)

        return bundleCache.bundle(for: requestedIdentifier.lowercased()) {
            var candidates = [requestedIdentifier]
            if language?.lowercased() == "zh" {
                candidates.append("zh-Hans")
            }
            if let language {
                candidates.append(language)
            }

            for candidate in candidates {
                guard let localization = sourceBundle.localizations.first(where: {
                    $0.replacingOccurrences(of: "_", with: "-")
                        .caseInsensitiveCompare(candidate) == .orderedSame
                }),
                    let path = sourceBundle.path(forResource: localization, ofType: "lproj"),
                    let bundle = Bundle(path: path)
                else { continue }
                return bundle
            }

            return sourceBundle
        }
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
