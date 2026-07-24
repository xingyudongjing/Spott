import Foundation

enum AppShellLocalization {
    static func text(
        _ key: String.LocalizationValue,
        locale: Locale
    ) -> String {
        SpottLocalization.text(key, table: "AppShell", locale: locale)
    }
}
