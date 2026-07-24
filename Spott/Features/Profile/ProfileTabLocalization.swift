import Foundation

enum ProfileTabLocalization {
    static func text(
        _ key: String.LocalizationValue,
        locale: Locale
    ) -> String {
        SpottLocalization.text(key, table: "ProfileTab", locale: locale)
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

    static func relative(_ date: Date, locale: Locale, now: Date = .now) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = locale
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: now)
    }

    static func day(_ date: Date, locale: Locale, calendar: Calendar = .current) -> String {
        if calendar.isDateInToday(date) { return text("profile.day.today", locale: locale) }
        if calendar.isDateInYesterday(date) { return text("profile.day.yesterday", locale: locale) }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.calendar = calendar
        formatter.setLocalizedDateFormatFromTemplate("MMMdE")
        return formatter.string(from: date)
    }
}
