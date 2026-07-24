import Foundation

enum HostLocalization {
    static func text(
        _ key: String.LocalizationValue,
        locale: Locale
    ) -> String {
        SpottLocalization.text(key, table: "Host", locale: locale)
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
}
