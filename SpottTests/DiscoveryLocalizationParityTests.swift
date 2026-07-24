import Foundation
import XCTest
@testable import Spott

final class DiscoveryLocalizationParityTests: XCTestCase {
    private let locales = ["zh-Hans", "ja", "en"]

    func testDiscoveryTableHasTheSameNonEmptyKeysInAllSupportedLocales() throws {
        let localized = try Dictionary(
            uniqueKeysWithValues: locales.map { locale in
                (locale, try loadStrings(locale: locale))
            }
        )
        let reference = try XCTUnwrap(localized["zh-Hans"])
        let expectedKeys = Set(reference.keys)

        XCTAssertFalse(expectedKeys.isEmpty, "Discovery must not be empty")

        for locale in locales {
            let values = try XCTUnwrap(localized[locale])
            XCTAssertEqual(
                Set(values.keys),
                expectedKeys,
                "Discovery key drift for \(locale)"
            )
            XCTAssertEqual(
                values.filter { $0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.map(\.key),
                [],
                "Discovery contains empty values for \(locale)"
            )
        }
    }

    func testDiscoveryFormatArgumentsStayCompatibleAcrossLocales() throws {
        let localized = try Dictionary(
            uniqueKeysWithValues: locales.map { locale in
                (locale, try loadStrings(locale: locale))
            }
        )
        let reference = try XCTUnwrap(localized["zh-Hans"])

        for key in reference.keys {
            let expected = formatArguments(in: try XCTUnwrap(reference[key]))
            for locale in locales {
                let value = try XCTUnwrap(localized[locale]?[key])
                XCTAssertEqual(
                    formatArguments(in: value),
                    expected,
                    "Discovery format argument drift for \(locale):\(key)"
                )
            }
        }
    }

    func testDiscoveryResolvesLocalizedCopyPerLocale() {
        let expectations: [(String, String, String)] = [
            ("zh-Hans", "发现", "按推荐"),
            ("ja", "見つける", "おすすめ順"),
            ("en", "Discover", "Recommended"),
        ]
        for (locale, title, sort) in expectations {
            XCTAssertEqual(
                DiscoveryHomeLocalization.text(
                    "discovery.title",
                    locale: Locale(identifier: locale)
                ),
                title,
                locale
            )
            XCTAssertEqual(
                DiscoveryHomeLocalization.text(
                    EventDiscoverySort.recommended.titleKey,
                    locale: Locale(identifier: locale)
                ),
                sort,
                locale
            )
        }
    }

    func testEveryCategoryChipAndSortModeHasALocalizedTitleKeyInTheTable() throws {
        let reference = try loadStrings(locale: "zh-Hans")

        for category in DiscoveryCategoryDescriptor.all {
            let resolved = DiscoveryHomeLocalization.text(
                category.titleKey,
                locale: Locale(identifier: "zh-Hans")
            )
            XCTAssertTrue(
                reference.values.contains(resolved),
                "Category chip \(category.id) does not resolve from Discovery.strings"
            )
        }

        for sort in EventDiscoverySort.allCases {
            let resolved = DiscoveryHomeLocalization.text(
                sort.titleKey,
                locale: Locale(identifier: "zh-Hans")
            )
            XCTAssertTrue(
                reference.values.contains(resolved),
                "Sort mode \(sort.rawValue) does not resolve from Discovery.strings"
            )
        }
    }

    private func loadStrings(locale: String) throws -> [String: String] {
        let repositoryRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = repositoryRoot
            .appendingPathComponent("Spott/Resources")
            .appendingPathComponent("\(locale).lproj")
            .appendingPathComponent("Discovery.strings")
        let data = try Data(contentsOf: url)
        let propertyList = try PropertyListSerialization.propertyList(from: data, format: nil)
        return try XCTUnwrap(
            propertyList as? [String: String],
            "Could not parse \(url.path) as a strings dictionary"
        )
    }

    private func formatArguments(in value: String) -> [String] {
        let pattern = #"%(?:\d+\$)?(?:lld|llu|ld|lu|d|u|f|@)"#
        let expression = try! NSRegularExpression(pattern: pattern)
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        return expression.matches(in: value, range: range).compactMap { match in
            guard let range = Range(match.range, in: value) else { return nil }
            return value[range]
                .replacingOccurrences(of: #"%\d+\$"#, with: "%", options: .regularExpression)
                .description
        }.sorted()
    }
}
