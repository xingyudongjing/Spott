import SwiftUI

enum DiscoveryHomeLocalization {
    static func text(_ key: String.LocalizationValue, locale: Locale) -> String {
        SpottLocalization.text(key, table: "Discovery", locale: locale)
    }

    static func format(
        _ key: String.LocalizationValue,
        locale: Locale,
        _ arguments: CVarArg...
    ) -> String {
        String(format: text(key, locale: locale), arguments: arguments)
    }
}

struct DiscoveryCategoryDescriptor: Identifiable {
    let value: String?
    let titleKey: String.LocalizationValue
    let symbol: String

    var id: String { value ?? "all" }

    static let all: [DiscoveryCategoryDescriptor] = [
        .init(value: nil, titleKey: "discovery.category.all", symbol: "square.grid.2x2"),
        .init(value: "family", titleKey: "discovery.category.family", symbol: "figure.and.child.holdinghands"),
        .init(value: "outdoor", titleKey: "discovery.category.outdoor", symbol: "mountain.2"),
        .init(value: "sports", titleKey: "discovery.category.sports", symbol: "figure.run"),
        .init(value: "city-walk", titleKey: "discovery.category.city_walk", symbol: "building.2"),
        .init(value: "food", titleKey: "discovery.category.food", symbol: "fork.knife"),
        .init(value: "games", titleKey: "discovery.category.games", symbol: "dice"),
        .init(value: "art", titleKey: "discovery.category.art", symbol: "paintpalette"),
        .init(value: "learning", titleKey: "discovery.category.learning", symbol: "book.closed"),
        .init(value: "networking", titleKey: "discovery.category.networking", symbol: "person.2")
    ]

    /// Per-category accent used for the chip's selected glass tint and the
    /// search-drawer category glyphs, so each category reads with its own
    /// color instead of a flat grey row. Derived from the shared cover
    /// gradient so chips, drawer glyphs and covers stay one visual system.
    /// `全部` (nil) is the neutral default: an ink-filled selected chip keeps
    /// the top chrome monochrome so the brand accent reads only on the create
    /// FAB. Specific categories still carry their own cover-derived color.
    static func accent(forValue value: String?) -> Color {
        guard let value else { return SpottColor.ink }
        return EventCoverStyle.style(for: value).gradient.last ?? SpottColor.ink
    }

    static func title(forSlug slug: String, locale: Locale) -> String? {
        let key: String.LocalizationValue? = switch slug {
        case "family": "discovery.category.family"
        case "outdoor": "discovery.category.outdoor"
        case "sports": "discovery.category.sports"
        case "city-walk", "walk": "discovery.category.city_walk"
        case "food": "discovery.category.food"
        case "art", "art-culture": "discovery.category.art"
        case "learning", "skill": "discovery.category.learning"
        case "networking", "career": "discovery.category.networking"
        case "music": "discovery.category.music"
        case "games": "discovery.category.games"
        default: nil
        }
        guard let key else { return nil }
        return DiscoveryHomeLocalization.text(key, locale: locale)
    }
}

enum DiscoveryRegionCatalog {
    static let regions: [(value: String, titleKey: String.LocalizationValue)] = [
        ("tokyo", "discovery.region.tokyo"),
        ("kanagawa", "discovery.region.kanagawa"),
        ("osaka", "discovery.region.osaka"),
        ("kyoto", "discovery.region.kyoto")
    ]

    static func title(for value: String, locale: Locale) -> String {
        let key: String.LocalizationValue = switch value {
        case "tokyo": "discovery.region.tokyo"
        case "kanagawa": "discovery.region.kanagawa"
        case "osaka": "discovery.region.osaka"
        case "kyoto": "discovery.region.kyoto"
        default: "discovery.region.fallback"
        }
        return DiscoveryHomeLocalization.text(key, locale: locale)
    }
}
