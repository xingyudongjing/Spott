import Foundation
import XCTest
@testable import Spott

final class DiscoveryEventPresentationTests: XCTestCase {
    func testDateFactsUseTheEventDisplayTimeZoneAndExplicitAppLocale() throws {
        let event = try makeEvent(overrides: [
            "startsAt": "2026-07-18T08:30:00Z",
            "displayTimeZone": "America/Los_Angeles",
        ])

        let english = DiscoveryEventPresentation(
            event: event,
            locale: Locale(identifier: "en_US")
        )
        let japanese = DiscoveryEventPresentation(
            event: event,
            locale: Locale(identifier: "ja_JP")
        )

        XCTAssertTrue(normalizingSpaces(english.dateText).contains("1:30 AM"), english.dateText)
        XCTAssertTrue(
            normalizingSpaces(english.shortDateText).contains("1:30 AM"),
            english.shortDateText
        )
        XCTAssertTrue(english.dateText.contains("July"), english.dateText)
        XCTAssertTrue(japanese.dateText.contains("1:30"), japanese.dateText)
        XCTAssertTrue(japanese.dateText.contains("7月"), japanese.dateText)
        XCTAssertFalse(japanese.dateText.contains("AM"), japanese.dateText)
    }

    func testDynamicFactsUseTheExplicitAppLocale() throws {
        let event = try makeEvent(overrides: [
            "publicArea": NSNull(),
            "fee": [
                "isFree": true,
                "amountJPY": NSNull(),
                "collectorName": NSNull(),
                "method": NSNull(),
                "paymentDeadlineText": NSNull(),
                "refundPolicy": NSNull(),
            ],
        ])

        let english = DiscoveryEventPresentation(
            event: event,
            locale: Locale(identifier: "en")
        )
        let japanese = DiscoveryEventPresentation(
            event: event,
            locale: Locale(identifier: "ja")
        )

        XCTAssertEqual(english.locationText, "Location pending")
        XCTAssertEqual(english.feeText, "Free")
        XCTAssertEqual(english.capacityText, "7 spots left")
        XCTAssertEqual(english.formatText, "In person · Japanese")
        XCTAssertEqual(japanese.locationText, "場所は公開待ち")
        XCTAssertEqual(japanese.feeText, "無料")
        XCTAssertEqual(japanese.capacityText, "残り7枠")
        XCTAssertEqual(japanese.formatText, "対面 · 日本語")
    }

    func testRoutedEventLoadingMessageExistsInEverySupportedLocale() {
        XCTAssertEqual(
            DiscoveryLocalization.text("正在加载活动…", locale: Locale(identifier: "en")),
            "Loading events…"
        )
        XCTAssertEqual(
            DiscoveryLocalization.text("正在加载活动…", locale: Locale(identifier: "ja")),
            "イベントを読み込み中…"
        )
        XCTAssertEqual(
            DiscoveryLocalization.text("正在加载活动…", locale: Locale(identifier: "zh-Hans")),
            "正在加载活动…"
        )
    }

    private func makeEvent(overrides: [String: Any]) throws -> EventSummary {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(
            EventSummary.self,
            from: JSONSerialization.data(withJSONObject: eventPayload(overrides: overrides))
        )
    }

    private func normalizingSpaces(_ value: String) -> String {
        value.replacingOccurrences(of: "\u{202F}", with: " ")
    }
}
