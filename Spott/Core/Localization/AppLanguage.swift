import Foundation

enum AppLanguage: String, CaseIterable, Identifiable, Sendable {
    case system
    case simplifiedChinese = "zh-Hans"
    case japanese = "ja"
    case english = "en"

    var id: String { rawValue }

    var locale: Locale {
        switch self {
        case .system: .autoupdatingCurrent
        case .simplifiedChinese: Locale(identifier: "zh-Hans")
        case .japanese: Locale(identifier: "ja")
        case .english: Locale(identifier: "en")
        }
    }

    var title: String {
        switch self {
        case .system: "跟随系统"
        case .simplifiedChinese: "简体中文"
        case .japanese: "日本語"
        case .english: "English"
        }
    }
}
