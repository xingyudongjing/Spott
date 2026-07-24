import Foundation
import XCTest
@testable import Spott

final class AuthLocalizationParityTests: XCTestCase {
    private let locales = ["zh-Hans", "ja", "en"]

    func testAuthTableHasTheSameNonEmptyKeysInAllSupportedLocales() throws {
        let localized = try Dictionary(
            uniqueKeysWithValues: locales.map { locale in
                (locale, try loadStrings(locale: locale))
            }
        )
        let reference = try XCTUnwrap(localized["zh-Hans"])
        let expectedKeys = Set(reference.keys)

        XCTAssertFalse(expectedKeys.isEmpty, "Auth must not be empty")

        for locale in locales {
            let values = try XCTUnwrap(localized[locale])
            XCTAssertEqual(
                Set(values.keys),
                expectedKeys,
                "Auth key drift for \(locale)"
            )
            XCTAssertEqual(
                values.filter { $0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.map(\.key),
                [],
                "Auth contains empty values for \(locale)"
            )
        }
    }

    func testAuthResolvesLocalizedCopyPerLocale() {
        let expectations: [(String, String)] = [
            ("zh-Hans", "注册并继续"),
            ("ja", "登録して続行"),
            ("en", "Sign up and continue"),
        ]
        for (locale, label) in expectations {
            XCTAssertEqual(
                AuthLocalization.text(
                    "auth.cta.register",
                    locale: Locale(identifier: locale)
                ),
                label,
                locale
            )
        }
    }

    func testAuthDebugCodeFormatsItsArgument() {
        XCTAssertEqual(
            AuthLocalization.format(
                "auth.debug.code",
                locale: Locale(identifier: "zh-Hans"),
                "123456"
            ),
            "本地开发验证码：123456"
        )
    }

    private func loadStrings(locale: String) throws -> [String: String] {
        let repositoryRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = repositoryRoot
            .appendingPathComponent("Spott/Resources")
            .appendingPathComponent("\(locale).lproj")
            .appendingPathComponent("Auth.strings")
        let data = try Data(contentsOf: url)
        let propertyList = try PropertyListSerialization.propertyList(from: data, format: nil)
        return try XCTUnwrap(
            propertyList as? [String: String],
            "Could not parse \(url.path) as a strings dictionary"
        )
    }
}
