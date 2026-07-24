import Foundation
import XCTest
@testable import Spott

final class AppShellLocalizationParityTests: XCTestCase {
    private let locales = ["zh-Hans", "ja", "en"]

    func testAppShellTableHasTheSameNonEmptyKeysInAllSupportedLocales() throws {
        let localized = try Dictionary(
            uniqueKeysWithValues: locales.map { locale in
                (locale, try loadStrings(locale: locale))
            }
        )
        let reference = try XCTUnwrap(localized["zh-Hans"])
        let expectedKeys = Set(reference.keys)

        XCTAssertFalse(expectedKeys.isEmpty, "AppShell must not be empty")

        for locale in locales {
            let values = try XCTUnwrap(localized[locale])
            XCTAssertEqual(
                Set(values.keys),
                expectedKeys,
                "AppShell key drift for \(locale)"
            )
            XCTAssertEqual(
                values.filter { $0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.map(\.key),
                [],
                "AppShell contains empty values for \(locale)"
            )
        }
    }

    func testAppShellResolvesLocalizedCopyPerLocale() {
        let expectations: [(String, String)] = [
            ("zh-Hans", "发布活动"),
            ("ja", "イベントを作成"),
            ("en", "Create event"),
        ]
        for (locale, label) in expectations {
            XCTAssertEqual(
                AppShellLocalization.text(
                    "appshell.create.accessibility_label",
                    locale: Locale(identifier: locale)
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
            .appendingPathComponent("AppShell.strings")
        let data = try Data(contentsOf: url)
        let propertyList = try PropertyListSerialization.propertyList(from: data, format: nil)
        return try XCTUnwrap(
            propertyList as? [String: String],
            "Could not parse \(url.path) as a strings dictionary"
        )
    }
}
