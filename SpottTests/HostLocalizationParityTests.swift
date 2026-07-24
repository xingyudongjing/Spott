import Foundation
import XCTest
@testable import Spott

final class HostLocalizationParityTests: XCTestCase {
    private let locales = ["zh-Hans", "ja", "en"]

    func testHostTableHasTheSameNonEmptyKeysInAllSupportedLocales() throws {
        let localized = try Dictionary(
            uniqueKeysWithValues: locales.map { locale in
                (locale, try loadStrings(locale: locale))
            }
        )
        let reference = try XCTUnwrap(localized["zh-Hans"])
        let expectedKeys = Set(reference.keys)

        XCTAssertFalse(expectedKeys.isEmpty, "Host must not be empty")

        for locale in locales {
            let values = try XCTUnwrap(localized[locale])
            XCTAssertEqual(
                Set(values.keys),
                expectedKeys,
                "Host key drift for \(locale)"
            )
            XCTAssertEqual(
                values.filter { $0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.map(\.key),
                [],
                "Host contains empty values for \(locale)"
            )
        }
    }

    func testHostResolvesLocalizedCopyPerLocale() {
        let expectations: [(String, String)] = [
            ("zh-Hans", "局头工作台"),
            ("ja", "主催者スタジオ"),
            ("en", "Host Studio"),
        ]
        for (locale, label) in expectations {
            XCTAssertEqual(
                HostLocalization.text(
                    "host.title",
                    locale: Locale(identifier: locale)
                ),
                label,
                locale
            )
        }
    }

    func testHostFormatsPositionalArgumentsPerLocale() {
        let expectations: [(String, String)] = [
            ("zh-Hans", "用 120 积分购买"),
            ("ja", "120 ポイントで購入"),
            ("en", "Buy for 120 points"),
        ]
        for (locale, label) in expectations {
            XCTAssertEqual(
                HostLocalization.format(
                    "host.promotion.purchase",
                    locale: Locale(identifier: locale),
                    120
                ),
                label,
                locale
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
            .appendingPathComponent("Host.strings")
        let data = try Data(contentsOf: url)
        let propertyList = try PropertyListSerialization.propertyList(from: data, format: nil)
        return try XCTUnwrap(
            propertyList as? [String: String],
            "Could not parse \(url.path) as a strings dictionary"
        )
    }
}
