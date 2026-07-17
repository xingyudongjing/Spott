import Foundation
import XCTest
@testable import Spott

final class LocalizationParityTests: XCTestCase {
    private let locales = ["zh-Hans", "ja", "en"]
    private let tables = ["Localizable", "CoreJourney"]

    func testEveryLocalizationTableHasTheSameNonEmptyKeysInAllSupportedLocales() throws {
        for table in tables {
            let localized = try Dictionary(
                uniqueKeysWithValues: locales.map { locale in
                    (locale, try loadStrings(locale: locale, table: table))
                }
            )
            let reference = try XCTUnwrap(localized["zh-Hans"])
            let expectedKeys = Set(reference.keys)

            XCTAssertFalse(expectedKeys.isEmpty, "\(table) must not be empty")

            for locale in locales {
                let values = try XCTUnwrap(localized[locale])
                XCTAssertEqual(
                    Set(values.keys),
                    expectedKeys,
                    "\(table) key drift for \(locale)"
                )
                XCTAssertEqual(
                    values.filter { $0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.map(\.key),
                    [],
                    "\(table) contains empty values for \(locale)"
                )
            }
        }
    }

    func testCoreJourneyFormatArgumentsStayCompatibleAcrossLocales() throws {
        let localized = try Dictionary(
            uniqueKeysWithValues: locales.map { locale in
                (locale, try loadStrings(locale: locale, table: "CoreJourney"))
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
                    "CoreJourney format argument drift for \(locale):\(key)"
                )
            }
        }
    }

    func testEveryLiteralCoreJourneyKeyUsedByNativeFeaturesExistsInAllLocales() throws {
        let repositoryRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let featuresRoot = repositoryRoot
            .appendingPathComponent("Spott/Features", isDirectory: true)
        let fileManager = FileManager.default
        let swiftFiles = try XCTUnwrap(
            fileManager.enumerator(
                at: featuresRoot,
                includingPropertiesForKeys: nil
            )?.allObjects as? [URL]
        ).filter { $0.pathExtension == "swift" }
        let expression = try NSRegularExpression(
            pattern: #"journey\.[a-z0-9_.]+"#
        )
        var usedKeys = Set<String>()
        for file in swiftFiles {
            let source = try String(contentsOf: file, encoding: .utf8)
            let range = NSRange(source.startIndex..<source.endIndex, in: source)
            for match in expression.matches(in: source, range: range) {
                guard let keyRange = Range(match.range, in: source) else { continue }
                usedKeys.insert(String(source[keyRange]))
            }
        }

        XCTAssertFalse(usedKeys.isEmpty)
        for locale in locales {
            let localized = try loadStrings(locale: locale, table: "CoreJourney")
            XCTAssertEqual(
                usedKeys.subtracting(localized.keys),
                [],
                "CoreJourney has missing native feature keys for \(locale)"
            )
        }
    }

    func testRoutedEventCopyIsLocalizedInAllSupportedLocales() {
        let expectations: [(String, String, String, String, String)] = [
            (
                "zh-Hans",
                "无法打开活动",
                "活动链接无效。",
                "重新加载",
                "正在加载活动…"
            ),
            (
                "ja",
                "イベントを開けません",
                "イベントのリンクが無効です。",
                "再読み込み",
                "イベントを読み込み中…"
            ),
            (
                "en",
                "Couldn’t open event",
                "This event link is invalid.",
                "Reload",
                "Loading event…"
            ),
        ]

        for (locale, errorTitle, invalidMessage, reload, loading) in expectations {
            let copy = RoutedEventCopy(locale: Locale(identifier: locale))
            XCTAssertEqual(copy.errorTitle, errorTitle, locale)
            XCTAssertEqual(copy.invalidMessage, invalidMessage, locale)
            XCTAssertEqual(copy.reload, reload, locale)
            XCTAssertEqual(copy.loading, loading, locale)
        }

        let staleInvalidError = UserFacingError(
            id: "EVENT_ROUTE_INVALID",
            message: "活动链接无效。",
            retryable: false
        )
        let english = RoutedEventCopy(locale: Locale(identifier: "en"))
        XCTAssertEqual(
            english.displayMessage(for: staleInvalidError),
            "This event link is invalid."
        )
        let safeAPIFailure = UserFacingError(
            id: "EVENT_NOT_FOUND",
            message: "Safe AppModel copy",
            retryable: false
        )
        XCTAssertEqual(
            english.displayMessage(for: safeAPIFailure),
            "Safe AppModel copy",
            "API failures must retain AppModel's safe mapping"
        )
    }

    private func loadStrings(locale: String, table: String) throws -> [String: String] {
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
