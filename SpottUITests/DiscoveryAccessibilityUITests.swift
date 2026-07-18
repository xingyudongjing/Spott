import UIKit
import XCTest

final class DiscoveryAccessibilityUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
        MainActor.assumeIsolated {
            XCUIDevice.shared.orientation = .portrait
        }
    }

    @MainActor
    func testChineseStandardDiscoveryGeometry() throws {
        try assertDiscovery(locale: "zh-Hans", accessibilitySize: false)
    }

    @MainActor
    func testJapaneseStandardDiscoveryGeometry() throws {
        try assertDiscovery(locale: "ja", accessibilitySize: false)
    }

    @MainActor
    func testEnglishStandardDiscoveryGeometry() throws {
        try assertDiscovery(locale: "en", accessibilitySize: false)
    }

    @MainActor
    func testChineseMaximumAccessibilityDiscoveryGeometry() throws {
        try assertDiscovery(locale: "zh-Hans", accessibilitySize: true)
    }

    @MainActor
    func testJapaneseMaximumAccessibilityDiscoveryGeometry() throws {
        try assertDiscovery(locale: "ja", accessibilitySize: true)
    }

    @MainActor
    func testEnglishMaximumAccessibilityDiscoveryGeometry() throws {
        try assertDiscovery(locale: "en", accessibilitySize: true)
    }

    @MainActor
    private func assertDiscovery(
        locale: String,
        accessibilitySize: Bool,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        let copy = expectedCopy(locale: locale)
        let app = XCUIApplication()
        app.launchArguments = [
            "-spott-ui-test-navigation-fixture",
            "-app.language", locale,
        ]
        if accessibilitySize {
            app.launchArguments += [
                "-UIPreferredContentSizeCategoryName",
                UIContentSizeCategory.accessibilityExtraExtraExtraLarge.rawValue,
            ]
        }
        app.launch()

        let tabBar = app.tabBars.firstMatch
        let discoveryTab = tabBar.buttons[copy.discoveryTab]
        let searchField = app.searchFields.firstMatch
        let firstFilter = app.buttons[copy.allFilter]
        let resultCount = app.staticTexts
            .matching(NSPredicate(format: "label == %@", copy.resultCount))
            .firstMatch
        let modeButton = app.buttons[copy.showMap]
        let featured = app.descendants(matching: .any)["discovery.featured-event"]

        for (name, element) in [
            ("tab", discoveryTab),
            ("search", searchField),
            ("first filter", firstFilter),
            ("result count", resultCount),
            ("mode", modeButton),
            ("featured event", featured),
        ] {
            XCTAssertTrue(
                element.waitForExistence(timeout: 8),
                "Missing discovery element: \(name)",
                file: file,
                line: line
            )
        }

        XCTAssertGreaterThanOrEqual(firstFilter.frame.height, 44, file: file, line: line)
        XCTAssertGreaterThanOrEqual(modeButton.frame.height, 44, file: file, line: line)
        XCTAssertFalse(firstFilter.frame.intersects(modeButton.frame), file: file, line: line)
        XCTAssertLessThanOrEqual(
            resultCount.frame.minY - firstFilter.frame.maxY,
            accessibilitySize ? 40 : 32,
            "Horizontal filters must use intrinsic height instead of reserving blank vertical space",
            file: file,
            line: line
        )

        if accessibilitySize {
            XCTAssertLessThanOrEqual(
                resultCount.frame.maxY,
                modeButton.frame.minY,
                "AX result count and map action must stack without overlap",
                file: file,
                line: line
            )
        } else {
            XCTAssertEqual(
                resultCount.frame.midY,
                modeButton.frame.midY,
                accuracy: 8,
                "Standard result hierarchy must remain one compact row",
                file: file,
                line: line
            )
            XCTAssertLessThanOrEqual(
                featured.frame.minY - searchField.frame.maxY,
                220,
                "A real event must follow compact search/filter chrome without a blank hero",
                file: file,
                line: line
            )
            XCTAssertLessThanOrEqual(
                featured.frame.minY,
                app.windows.firstMatch.frame.midY + 24,
                "The first event cover or title must enter the first viewport",
                file: file,
                line: line
            )
        }

        XCTAssertLessThanOrEqual(
            featured.frame.minY - modeButton.frame.maxY,
            accessibilitySize ? 24 : 16,
            "Results must begin immediately after the mode row",
            file: file,
            line: line
        )

        captureScreenshot(
            named: "discovery-\(locale)-\(accessibilitySize ? "ax5" : "medium")"
        )

        let resultsScroll = app.scrollViews.allElementsBoundByIndex.first {
            $0.frame.width >= app.windows.firstMatch.frame.width - 8
                && $0.frame.minY >= modeButton.frame.maxY - 8
        }
        XCTAssertNotNil(
            resultsScroll,
            "Discovery results must remain a dedicated vertical scroll surface",
            file: file,
            line: line
        )
        let dragStart = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.72))
        let dragEnd = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.42))

        let lastEvent = app.descendants(matching: .any)[
            "discovery.event.019b0000-0000-7000-8100-000000000002"
        ]
        for _ in 0..<20 {
            if lastEvent.exists {
                let clearance = tabBar.frame.minY - lastEvent.frame.maxY
                if lastEvent.isHittable, clearance >= 32 { break }
            }
            dragStart.press(forDuration: 0.05, thenDragTo: dragEnd)
        }
        captureScreenshot(
            named: "discovery-\(locale)-\(accessibilitySize ? "ax5" : "medium")-bottom"
        )
        XCTAssertTrue(
            lastEvent.exists,
            "The final discovery event must materialize while scrolling",
            file: file,
            line: line
        )
        XCTAssertTrue(
            lastEvent.isHittable,
            "The final discovery event must become reachable",
            file: file,
            line: line
        )
        XCTAssertLessThanOrEqual(
            lastEvent.frame.maxY,
            tabBar.frame.minY - 32,
            "Final content must clear the native iOS 26 tab bar by one spacing token",
            file: file,
            line: line
        )
    }

    @MainActor
    private func captureScreenshot(named name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func expectedCopy(locale: String) -> (
        discoveryTab: String,
        allFilter: String,
        showMap: String,
        resultCount: String
    ) {
        switch locale {
        case "ja":
            ("見つける", "すべて", "地図を表示", "2件のイベント")
        case "en":
            ("Discover", "All", "Show map", "2 events")
        default:
            ("发现", "全部", "显示地图", "2 个活动")
        }
    }
}
