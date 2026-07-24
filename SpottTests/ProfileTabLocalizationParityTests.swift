import Foundation
import XCTest
@testable import Spott

final class ProfileTabLocalizationParityTests: XCTestCase {
    private let locales = ["zh-Hans", "ja", "en"]

    func testProfileTabTableHasTheSameNonEmptyKeysInAllSupportedLocales() throws {
        let localized = try Dictionary(
            uniqueKeysWithValues: locales.map { locale in
                (locale, try loadStrings(locale: locale))
            }
        )
        let reference = try XCTUnwrap(localized["zh-Hans"])
        let expectedKeys = Set(reference.keys)

        XCTAssertFalse(expectedKeys.isEmpty, "ProfileTab must not be empty")

        for locale in locales {
            let values = try XCTUnwrap(localized[locale])
            XCTAssertEqual(
                Set(values.keys),
                expectedKeys,
                "ProfileTab key drift for \(locale)"
            )
            XCTAssertEqual(
                values.filter { $0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.map(\.key),
                [],
                "ProfileTab contains empty values for \(locale)"
            )
        }
    }

    func testProfileTabResolvesLocalizedCopyPerLocale() {
        let expectations: [(String, String)] = [
            ("zh-Hans", "我的行程"),
            ("ja", "マイスケジュール"),
            ("en", "My itinerary"),
        ]
        for (locale, label) in expectations {
            XCTAssertEqual(
                ProfileTabLocalization.text(
                    "profile.itinerary.title",
                    locale: Locale(identifier: locale)
                ),
                label,
                locale
            )
        }
    }

    func testKnownAchievementCodesAllHaveNameAndDetailKeys() throws {
        let reference = try loadStrings(locale: "zh-Hans")
        for code in AchievementPresentation.knownCodes {
            XCTAssertNotNil(
                reference["profile.achievement.\(code).name"],
                "missing name for \(code)"
            )
            XCTAssertNotNil(
                reference["profile.achievement.\(code).detail"],
                "missing detail for \(code)"
            )
        }
    }

    func testKnownWalletTransactionTypesAllHaveTitleKeys() throws {
        let reference = try loadStrings(locale: "zh-Hans")
        for type in WalletPresentation.knownTypes {
            XCTAssertNotNil(reference["profile.tx.\(type)"], "missing title for \(type)")
        }
    }

    func testKnownNotificationTypesAllHaveTitleKeys() throws {
        let reference = try loadStrings(locale: "zh-Hans")
        for type in NotificationPresentation.knownTypes {
            let key = "profile.notification.\(type.replacingOccurrences(of: ".", with: "_"))"
            XCTAssertNotNil(reference[key], "missing title for \(type)")
        }
    }

    private func loadStrings(locale: String) throws -> [String: String] {
        let repositoryRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = repositoryRoot
            .appendingPathComponent("Spott/Resources")
            .appendingPathComponent("\(locale).lproj")
            .appendingPathComponent("ProfileTab.strings")
        let data = try Data(contentsOf: url)
        let propertyList = try PropertyListSerialization.propertyList(from: data, format: nil)
        return try XCTUnwrap(
            propertyList as? [String: String],
            "Could not parse \(url.path) as a strings dictionary"
        )
    }
}
