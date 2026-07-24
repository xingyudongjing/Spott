import Foundation
import XCTest
@testable import Spott

final class ComposerLocalizationParityTests: XCTestCase {
    private let locales = ["zh-Hans", "ja", "en"]

    func testComposerTableHasTheSameNonEmptyKeysInAllSupportedLocales() throws {
        let localized = try Dictionary(
            uniqueKeysWithValues: locales.map { locale in
                (locale, try loadStrings(locale: locale))
            }
        )
        let reference = try XCTUnwrap(localized["zh-Hans"])
        let expectedKeys = Set(reference.keys)

        XCTAssertFalse(expectedKeys.isEmpty, "Composer must not be empty")

        for locale in locales {
            let values = try XCTUnwrap(localized[locale])
            XCTAssertEqual(
                Set(values.keys),
                expectedKeys,
                "Composer key drift for \(locale)"
            )
            XCTAssertEqual(
                values.filter { $0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.map(\.key),
                [],
                "Composer contains empty values for \(locale)"
            )
        }
    }

    func testComposerResolvesLocalizedCopyPerLocale() {
        let expectations: [(String, String)] = [
            ("zh-Hans", "登录后创建活动"),
            ("ja", "ログインしてイベントを作成"),
            ("en", "Sign in to create events"),
        ]
        for (locale, label) in expectations {
            XCTAssertEqual(
                ComposerLocalization.text(
                    "composer.gate.signed_out_title",
                    locale: Locale(identifier: locale)
                ),
                label,
                locale
            )
        }
    }

    func testComposerFormatsPositionalArgumentsPerLocale() {
        let expectations: [(String, String)] = [
            ("zh-Hans", "第 2 步 / 6"),
            ("ja", "ステップ 2 / 6"),
            ("en", "Step 2 of 6"),
        ]
        for (locale, label) in expectations {
            XCTAssertEqual(
                ComposerLocalization.format(
                    "composer.step_progress",
                    locale: Locale(identifier: locale),
                    2,
                    6
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
            .appendingPathComponent("Composer.strings")
        let data = try Data(contentsOf: url)
        let propertyList = try PropertyListSerialization.propertyList(from: data, format: nil)
        return try XCTUnwrap(
            propertyList as? [String: String],
            "Could not parse \(url.path) as a strings dictionary"
        )
    }
}
