import Foundation

private final class DiscoveryLocalizationBundleToken {}

private final class DiscoveryLocalizationBundleCache: @unchecked Sendable {
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

enum DiscoveryLocalization {
    static func text(
        _ key: String.LocalizationValue,
        locale: Locale
    ) -> String {
        String(
            localized: key,
            bundle: localizedBundle(for: locale),
            locale: locale
        )
    }

    private static let sourceBundle = Bundle(for: DiscoveryLocalizationBundleToken.self)
    private static let bundleCache = DiscoveryLocalizationBundleCache()

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

struct DiscoveryEventPresentation {
    let event: EventSummary
    let locale: Locale

    var locationText: String {
        event.publicArea ?? localized("地点待发布")
    }

    var feeText: String {
        guard let fee = event.fee else { return localized("费用待发布") }
        if fee.isFree { return localized("免费") }
        if let amount = fee.amountJPY {
            return "¥\(amount.formatted(.number.locale(locale)))"
        }
        let method = [fee.collectorName, fee.method].compactMap { $0 }.joined(separator: " · ")
        return method.isEmpty ? localized("费用待发布") : method
    }

    var capacityText: String {
        if event.remaining > 0 {
            return localized("余 \(event.remaining)")
        }
        return event.waitlistEnabled ? localized("候补中") : localized("已满员")
    }

    var formatText: String {
        let format: String = switch event.format {
        case .inPerson: localized("线下")
        case .online: localized("线上")
        case .hybrid: localized("混合")
        }
        guard event.localeConfirmed else {
            return "\(format) · \(localized("活动语言待确认"))"
        }
        return "\(format) · \(languageText(event.primaryLocale))"
    }

    var dateText: String {
        formattedStart(date: .long)
    }

    var shortDateText: String {
        formattedStart(date: .abbreviated)
    }

    var accessibilitySummary: String {
        [event.title, dateText, locationText, formatText, feeText, capacityText]
            .joined(separator: ", ")
    }

    var approximateLocationAccessibilityLabel: String {
        "\(event.title), \(locationText), \(localized("约略位置"))"
    }

    private var eventTimeZone: TimeZone {
        TimeZone(identifier: event.displayTimeZone) ?? TimeZone(secondsFromGMT: 0)!
    }

    private func formattedStart(date dateStyle: Date.FormatStyle.DateStyle) -> String {
        guard let startsAt = event.startsAt else { return localized("时间待定") }
        return startsAt.formatted(Date.FormatStyle(
            date: dateStyle,
            time: .shortened,
            locale: locale,
            timeZone: eventTimeZone
        ))
    }

    private func languageText(_ eventLocale: EventLocale) -> String {
        switch eventLocale {
        case .zhHans: localized("简体中文")
        case .ja: localized("日本語")
        case .en: "English"
        }
    }

    private func localized(_ key: String.LocalizationValue) -> String {
        DiscoveryLocalization.text(key, locale: locale)
    }
}
