import Foundation

enum DiscoveryLocalization {
    static func text(
        _ key: String.LocalizationValue,
        locale: Locale
    ) -> String {
        SpottLocalization.text(key, locale: locale)
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

    private var eventTimeZone: TimeZone? {
        TimeZone(identifier: event.displayTimeZone)
    }

    private func formattedStart(date dateStyle: Date.FormatStyle.DateStyle) -> String {
        guard let startsAt = event.startsAt else { return localized("时间待定") }
        guard let eventTimeZone else { return localized("活动时间不可用") }
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
