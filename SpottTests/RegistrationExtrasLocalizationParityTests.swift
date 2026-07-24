import Foundation
import XCTest
@testable import Spott

final class RegistrationExtrasLocalizationParityTests: XCTestCase {
    private let locales = ["zh-Hans", "ja", "en"]

    func testRegistrationExtrasTableHasTheSameNonEmptyKeysInAllSupportedLocales() throws {
        let localized = try Dictionary(
            uniqueKeysWithValues: locales.map { locale in
                (locale, try loadStrings(locale: locale))
            }
        )
        let reference = try XCTUnwrap(localized["zh-Hans"])
        let expectedKeys = Set(reference.keys)

        XCTAssertFalse(expectedKeys.isEmpty, "RegistrationExtras must not be empty")

        for locale in locales {
            let values = try XCTUnwrap(localized[locale])
            XCTAssertEqual(
                Set(values.keys),
                expectedKeys,
                "RegistrationExtras key drift for \(locale)"
            )
            XCTAssertEqual(
                values.filter { $0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.map(\.key),
                [],
                "RegistrationExtras contains empty values for \(locale)"
            )
        }
    }

    func testRegistrationExtrasResolvesLocalizedCopyPerLocale() {
        let expectations: [(String, String)] = [
            ("zh-Hans", "免费"),
            ("ja", "無料"),
            ("en", "Free"),
        ]
        for (locale, label) in expectations {
            XCTAssertEqual(
                RegistrationExtrasLocalization.text(
                    "regextras.ticket.free",
                    locale: Locale(identifier: locale)
                ),
                label,
                locale
            )
        }
    }

    func testTicketKeysLiveInRegistrationExtrasNotEventDetailExtras() throws {
        for locale in locales {
            let eventDetailExtras = try loadStrings(
                locale: locale,
                table: "EventDetailExtras"
            )
            XCTAssertEqual(
                eventDetailExtras.keys.filter { $0.hasPrefix("regextras.") },
                [],
                "regextras.* keys must not leak into EventDetailExtras for \(locale)"
            )
        }
    }

    private func loadStrings(
        locale: String,
        table: String = "RegistrationExtras"
    ) throws -> [String: String] {
        let repositoryRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = repositoryRoot
            .appendingPathComponent("Spott/Resources")
            .appendingPathComponent("\(locale).lproj")
            .appendingPathComponent("\(table).strings")
        let data = try Data(contentsOf: url)
        let propertyList = try PropertyListSerialization.propertyList(from: data, format: nil)
        return try XCTUnwrap(
            propertyList as? [String: String],
            "Could not parse \(url.path) as a strings dictionary"
        )
    }
}
