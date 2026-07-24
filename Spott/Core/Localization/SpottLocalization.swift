import Foundation

private final class SpottLocalizationBundleToken {}

private final class SpottLocalizationBundleCache: @unchecked Sendable {
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

/// Single locale-explicit string resolver shared by all feature localization
/// wrappers (`CoreJourneyLocalization`, `DiscoveryLocalization`, ...). It
/// resolves the best-matching `.lproj` bundle for the requested locale (with a
/// `zh` → `zh-Hans` fallback) and caches the result per locale identifier.
///
/// How a feature adds a new table (example: Groups):
/// 1. Create one `.strings` file per language, named after the table:
///    `Resources/zh-Hans.lproj/Groups.strings`, `Resources/ja.lproj/Groups.strings`,
///    and `Resources/en.lproj/Groups.strings`. The `Resources/{zh-Hans,ja,en}.lproj`
///    directories already hold one file per table (`Localizable.strings`,
///    `CoreJourney.strings`, `InfoPlist.strings`), so per-table `.strings` files
///    are picked up without any project configuration.
/// 2. Resolve keys through `SpottLocalization.text("groups.title", table: "Groups", locale: locale)`,
///    or add a thin wrapper enum mirroring `CoreJourneyLocalization`.
///
/// Passing `table: nil` reads the default `Localizable.strings` table.
enum SpottLocalization {
    static func text(
        _ key: String.LocalizationValue,
        table: String? = nil,
        locale: Locale
    ) -> String {
        String(
            localized: key,
            table: table,
            bundle: localizedBundle(for: locale),
            locale: locale
        )
    }

    private static let sourceBundle = Bundle(for: SpottLocalizationBundleToken.self)
    private static let bundleCache = SpottLocalizationBundleCache()

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
