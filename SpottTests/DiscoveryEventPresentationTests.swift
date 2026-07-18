import Foundation
import SwiftUI
import UIKit
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

    func testInvalidEventTimeZoneNeverSilentlyFormatsTheStartInUTC() throws {
        let event = try makeEvent(overrides: [
            "startsAt": "2026-07-18T08:30:00Z",
            "displayTimeZone": "Not/A_Time_Zone",
        ])

        let presentation = DiscoveryEventPresentation(
            event: event,
            locale: Locale(identifier: "en")
        )

        XCTAssertEqual(presentation.dateText, "Event time unavailable")
        XCTAssertEqual(presentation.shortDateText, "Event time unavailable")
        XCTAssertFalse(presentation.dateText.contains("8:30"))
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

    func testRecommendationModuleTitlesUseTheServerKeyAndTheActiveAppLocale() {
        XCTAssertEqual(
            DiscoveryModulePresentation.title(
                for: "new_events",
                serverFallback: "服务器中文标题",
                locale: Locale(identifier: "en")
            ),
            "New events"
        )
        XCTAssertEqual(
            DiscoveryModulePresentation.title(
                for: "nearby_hot",
                serverFallback: "服务器中文标题",
                locale: Locale(identifier: "ja")
            ),
            "近くで人気"
        )
        XCTAssertEqual(
            DiscoveryModulePresentation.title(
                for: "followed_updates",
                serverFallback: "服务器中文标题",
                locale: Locale(identifier: "zh-Hans")
            ),
            "关注动态"
        )
    }

    func testUnknownRecommendationModuleKeepsTheServerTitleForForwardCompatibility() {
        XCTAssertEqual(
            DiscoveryModulePresentation.title(
                for: "future_module",
                serverFallback: "A future module",
                locale: Locale(identifier: "en")
            ),
            "A future module"
        )
    }

    @MainActor
    func testLoadingSkeletonStartsWithAFullWidthEditorialCover() throws {
        let controller = UIHostingController(rootView:
            DiscoverySkeleton()
                .frame(width: 390, height: 500)
                .environment(\.colorScheme, .light)
        )
        controller.view.frame = CGRect(x: 0, y: 0, width: 390, height: 500)
        controller.view.backgroundColor = .systemBackground
        controller.view.layoutIfNeeded()
        let rendererFormat = UIGraphicsImageRendererFormat()
        rendererFormat.scale = 1
        let rendered = UIGraphicsImageRenderer(
            bounds: controller.view.bounds,
            format: rendererFormat
        ).image { _ in
            controller.view.drawHierarchy(in: controller.view.bounds, afterScreenUpdates: true)
        }
        let image = try XCTUnwrap(rendered.cgImage)
        let safeInsets = controller.view.safeAreaInsets
        let leadingProbeX = Int(safeInsets.left + SpottMetric.pageInset + 24)
        let trailingProbeX = Int(
            controller.view.bounds.width - safeInsets.right - SpottMetric.pageInset - 24
        )
        XCTAssertGreaterThan(
            trailingProbeX - leadingProbeX,
            180,
            "The skeleton test must sample two distant points inside the safe content width."
        )
        let leading = try pixelBytes(in: image, x: leadingProbeX, y: 140)
        let trailing = try pixelBytes(in: image, x: trailingProbeX, y: 140)

        XCTAssertLessThanOrEqual(
            pixelDistance(leading, trailing),
            12,
            "The leading skeleton must be one full-width editorial cover, not a compact row."
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

    private func pixelBytes(in image: CGImage, x: Int, y: Int) throws -> [UInt8] {
        let data = try XCTUnwrap(image.dataProvider?.data)
        let bytes = CFDataGetBytePtr(data)
        let bytesPerPixel = image.bitsPerPixel / 8
        let offset = y * image.bytesPerRow + x * bytesPerPixel
        return Array(0..<min(4, bytesPerPixel)).map { bytes?[offset + $0] ?? 0 }
    }

    private func pixelDistance(_ lhs: [UInt8], _ rhs: [UInt8]) -> Int {
        zip(lhs.prefix(3), rhs.prefix(3)).reduce(0) { partial, values in
            partial + abs(Int(values.0) - Int(values.1))
        }
    }
}
