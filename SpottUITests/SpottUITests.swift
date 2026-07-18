//
//  SpottUITests.swift
//  SpottUITests
//
//  Created by 姚凯 on 2026/7/15.
//

import UIKit
import XCTest

final class SpottUITests: XCTestCase {

    override func setUpWithError() throws {
        // Put setup code here. This method is called before the invocation of each test method in the class.

        // In UI tests it is usually best to stop immediately when a failure occurs.
        continueAfterFailure = false

        // UI configuration and previous simulator sessions can leave the device
        // rotated. Every product-flow assertion in this suite targets the
        // documented portrait iPhone experience, so restore that invariant
        // before launching the app.
        MainActor.assumeIsolated {
            XCUIDevice.shared.orientation = .portrait
        }

        // In UI tests it’s important to set the initial state - such as interface orientation - required for your tests before they run. The setUp method is a good place to do this.
    }

    override func tearDownWithError() throws {
        // Put teardown code here. This method is called after the invocation of each test method in the class.
    }

    @MainActor
    func testPrimaryNavigationAndAccessibilityLabels() throws {
        let app = XCUIApplication()
        app.launch()

        XCTAssertTrue(app.tabBars.buttons["发现"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.tabBars.buttons["社群"].exists)
        XCTAssertTrue(app.tabBars.buttons["创建"].exists)
        XCTAssertTrue(app.tabBars.buttons["行程"].exists)
        XCTAssertTrue(app.tabBars.buttons["我的"].exists)
        XCTAssertEqual(app.tabBars.count, 1, "发现页只能有一套系统底部导航")
        XCTAssertEqual(app.tabBars.firstMatch.buttons.count, 5, "系统底部导航应当正好包含五个入口")
        XCTAssertEqual(
            app.tabBars.firstMatch.buttons.allElementsBoundByIndex.map(\.label),
            ["发现", "社群", "创建", "行程", "我的"],
            "底部导航必须遵守产品文档的信息架构，而不是复制 Web 的导航顺序"
        )

        XCTAssertTrue(app.buttons["显示地图"].exists, "地图切换不能暴露 SF Symbol 的内部名称")
        app.buttons["显示地图"].tap()
        XCTAssertTrue(app.buttons["显示列表"].waitForExistence(timeout: 2))
        app.buttons["显示列表"].tap()

        app.tabBars.buttons["创建"].tap()
        XCTAssertTrue(app.staticTexts["登录后创建活动"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.buttons["登录"].exists)
    }

    @MainActor
    func testDiscoveryFirstViewportPrioritizesARealEditorialEventCard() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-spott-ui-test-navigation-fixture"]
        app.launch()

        let featuredCard = app.descendants(matching: .any)["discovery.featured-event"]
        XCTAssertTrue(featuredCard.waitForExistence(timeout: 5))
        XCTAssertTrue(featuredCard.isHittable, "首屏真实活动卡必须可直接进入详情")
        XCTAssertTrue(featuredCard.label.contains("周末开局"), "活动卡必须展示局头，而不只是标题和图片")
        XCTAssertTrue(featuredCard.label.contains("city-walk"), "活动卡必须展示最多三个真实标签")
        XCTAssertTrue(featuredCard.label.contains("摄影"))
        XCTAssertLessThan(
            featuredCard.frame.minY,
            app.tabBars.firstMatch.frame.minY,
            "首屏必须在底部导航之前出现真实活动内容"
        )
        XCTAssertTrue(app.buttons["显示地图"].exists, "地图切换应保留，但不能挤占顶栏身份入口")
        XCTAssertTrue(app.buttons["通知"].exists)
        XCTAssertTrue(app.buttons["打开我的页面"].exists)
    }

    @MainActor
    func testDiscoveryRegionControlShowsAndReadsTheCurrentLocalizedRegion() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-spott-ui-test-navigation-fixture"]
        app.launch()

        let regionControl = app.buttons["东京"]
        XCTAssertTrue(
            regionControl.waitForExistence(timeout: 5),
            "当前地区必须以本地化文字可见，不能退化成只有定位图标"
        )
        XCTAssertTrue(regionControl.isHittable)
    }

    @MainActor
    func testCompactDiscoveryCardVisuallyReservesSpaceForHostAndThreeTags() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-spott-ui-test-navigation-fixture"]
        app.launch()

        let compactCard = app.descendants(matching: .any)[
            "discovery.event.019b0000-0000-7000-8100-000000000002"
        ]
        XCTAssertTrue(compactCard.waitForExistence(timeout: 5))
        for _ in 0..<4 where !compactCard.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(compactCard.isHittable)
        XCTAssertTrue(compactCard.label.contains("小光"))
        XCTAssertTrue(compactCard.label.contains("music"))
        XCTAssertTrue(compactCard.label.contains("新朋友"))
        XCTAssertGreaterThanOrEqual(
            compactCard.frame.height,
            160,
            "紧凑卡必须为视觉上的局头和标签留出空间，而不只是把信息塞进 VoiceOver 标签"
        )
    }

    @MainActor
    func testEachSystemTabRetainsItsOwnNavigationPath() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-spott-ui-test-navigation-fixture"]
        app.launch()

        XCTAssertTrue(app.buttons["通知"].waitForExistence(timeout: 5))
        app.buttons["通知"].tap()
        XCTAssertTrue(app.navigationBars["通知"].waitForExistence(timeout: 3))

        for tab in ["社群", "创建", "行程", "我的"] {
            app.tabBars.buttons[tab].tap()
            XCTAssertTrue(app.tabBars.buttons[tab].isSelected, "\(tab) 应使用自己的系统 Tab")
            XCTAssertFalse(app.navigationBars["通知"].exists)
        }

        app.tabBars.buttons["发现"].tap()
        XCTAssertTrue(
            app.navigationBars["通知"].waitForExistence(timeout: 3),
            "切换 Tab 后，发现 Tab 的原生 NavigationStack 应保留自己的路径"
        )
        XCTAssertEqual(app.tabBars.count, 1)

        try assertPublicEventRouteStaysIn(tab: "行程", routeTab: "activities", app: app)
        try assertPublicEventRouteStaysIn(tab: "我的", routeTab: "profile", app: app)
    }

    @MainActor
    private func assertPublicEventRouteStaysIn(
        tab: String,
        routeTab: String,
        app: XCUIApplication
    ) throws {
        app.terminate()
        app.launchArguments = [
            "-spott-ui-test-navigation-fixture",
            "-spott-ui-test-route-tab",
            routeTab
        ]
        app.launch()
        XCTAssertTrue(app.staticTexts["event.detail.title"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["event.detail.title"].label, "东京余光 · 隅田川蓝调散步")
        try tapNativeBackButton(in: app)
        XCTAssertTrue(app.tabBars.buttons[tab].waitForExistence(timeout: 3))
        XCTAssertTrue(app.tabBars.buttons[tab].isSelected)
    }

    @MainActor
    private func tapNativeBackButton(in app: XCUIApplication) throws {
        let backButton = app.navigationBars.buttons.element(boundBy: 0)
        XCTAssertTrue(backButton.waitForExistence(timeout: 3), "活动详情必须保留系统返回按钮")
        backButton.tap()
    }

    @MainActor
    private func nativeAlertAction(
        identifier: String,
        label: String,
        in alert: XCUIElement,
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> XCUIElement {
        let matches = alert.descendants(matching: .any).matching(identifier: identifier)
        let count = matches.count

        // iOS 26 UIKit may expose one UIAlertAction as a wrapper and a nested
        // control. They are the same native button only when their frames match.
        XCTAssertTrue(
            (1...2).contains(count),
            "系统 Alert 操作必须只有一个按钮，或 iOS 26 已知的同按钮双 XCUI 表示",
            file: file,
            line: line
        )
        guard count > 0 else { return matches.firstMatch }

        let elements = (0..<count).map(matches.element(boundBy:))
        let referenceFrame = elements[0].frame
        XCTAssertGreaterThan(referenceFrame.width, 0, file: file, line: line)
        XCTAssertGreaterThan(referenceFrame.height, 0, file: file, line: line)

        for element in elements {
            XCTAssertTrue(element.exists, file: file, line: line)
            XCTAssertTrue(element.isHittable, file: file, line: line)
            XCTAssertEqual(element.label, label, file: file, line: line)
            XCTAssertEqual(
                element.frame.origin.x,
                referenceFrame.origin.x,
                accuracy: 0.5,
                file: file,
                line: line
            )
            XCTAssertEqual(
                element.frame.origin.y,
                referenceFrame.origin.y,
                accuracy: 0.5,
                file: file,
                line: line
            )
            XCTAssertEqual(
                element.frame.width,
                referenceFrame.width,
                accuracy: 0.5,
                file: file,
                line: line
            )
            XCTAssertEqual(
                element.frame.height,
                referenceFrame.height,
                accuracy: 0.5,
                file: file,
                line: line
            )
        }
        return matches.firstMatch
    }

    @MainActor
    func testCoreJourneyRegistrationAndConfirmationRemainUsableAtLargestAccessibilityText() throws {
        let app = XCUIApplication()
        app.launchArguments = coreJourneyLaunchArguments(
            state: "registration",
            routeTab: "activities",
            largestAccessibilityText: true
        )
        app.launch()

        let form = app.descendants(matching: .any)["registration.form"]
        XCTAssertTrue(form.waitForExistence(timeout: 5))
        let continueButton = app.descendants(matching: .any)["registration.continue"]
        XCTAssertTrue(continueButton.waitForExistence(timeout: 3))
        XCTAssertTrue(continueButton.isHittable)
        XCTAssertGreaterThanOrEqual(continueButton.frame.height, 44)

        app.terminate()
        app.launchArguments = coreJourneyLaunchArguments(
            state: "confirmed",
            routeTab: "activities",
            largestAccessibilityText: true
        )
        app.launch()

        let confirmation = app.descendants(matching: .any)["registration.confirmation"]
        XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
        let contactCard = app.descendants(matching: .any)["registration.contact.card"]
        XCTAssertTrue(contactCard.waitForExistence(timeout: 3))
        let contactAction = app.descendants(matching: .any)["registration.contact.action"]
        let reportAction = app.descendants(matching: .any)["registration.contact.report"]
        XCTAssertTrue(contactAction.waitForExistence(timeout: 3))
        XCTAssertTrue(reportAction.waitForExistence(timeout: 3))
        for _ in 0..<4 where !contactAction.isHittable || !reportAction.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(contactAction.isHittable)
        XCTAssertTrue(reportAction.isHittable)
        XCTAssertGreaterThanOrEqual(contactAction.frame.height, 44)
        XCTAssertGreaterThanOrEqual(reportAction.frame.height, 44)
        let itineraryButton = app.descendants(matching: .any)[
            "registration.confirmation.view_itinerary"
        ]
        XCTAssertTrue(itineraryButton.waitForExistence(timeout: 3))
        XCTAssertTrue(itineraryButton.isHittable)
        XCTAssertGreaterThanOrEqual(itineraryButton.frame.height, 44)
        itineraryButton.tap()
        XCTAssertTrue(app.tabBars.buttons["行程"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.tabBars.buttons["行程"].isSelected)
    }

    @MainActor
    func testComposerContactEditorRemainsUsableAtLargestAccessibilityText() throws {
        let app = XCUIApplication()
        app.launchArguments = [
            "-spott-ui-test-navigation-fixture",
            "-spott-ui-test-composer-contact",
            "-UIPreferredContentSizeCategoryName",
            UIContentSizeCategory.accessibilityExtraExtraExtraLarge.rawValue,
        ]
        app.launch()

        let createTab = app.tabBars.buttons["创建"]
        XCTAssertTrue(createTab.waitForExistence(timeout: 5))
        createTab.tap()

        let editor = app.descendants(matching: .any)[
            "event.composer.contact.editor"
        ]
        let kind = app.descendants(matching: .any)[
            "event.composer.contact.kind"
        ]
        let value = app.descendants(matching: .any)[
            "event.composer.contact.value"
        ]
        let privacy = app.descendants(matching: .any)[
            "event.composer.contact.privacy"
        ]

        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        XCTAssertTrue(kind.waitForExistence(timeout: 3))
        XCTAssertTrue(value.waitForExistence(timeout: 3))
        XCTAssertTrue(privacy.waitForExistence(timeout: 3))

        for _ in 0..<6 where !value.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(value.isHittable)
        XCTAssertGreaterThanOrEqual(value.frame.height, 48)
        value.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
    }

    @MainActor
    func testVisibleSurfacesAtStandardText() throws {
        try assertVisibleSurfaces(largestAccessibilityText: false)
    }

    @MainActor
    func testVisibleSurfacesAtLargestAccessibilityText() throws {
        try assertVisibleSurfaces(largestAccessibilityText: true)
    }

    @MainActor
    private func assertVisibleSurfaces(largestAccessibilityText: Bool) throws {
        let app = XCUIApplication()
        app.launchArguments = ["-spott-ui-test-navigation-fixture"]
        if largestAccessibilityText {
            app.launchArguments += [
                "-UIPreferredContentSizeCategoryName",
                UIContentSizeCategory.accessibilityExtraExtraExtraLarge.rawValue,
            ]
        }
        app.launch()

        let sizeName = largestAccessibilityText ? "ax" : "standard"
        let discovery = app.descendants(matching: .any)["discovery.screen"]
        let firstFilter = app.buttons["全部"]
        let modeButton = app.buttons["显示地图"]
        XCTAssertTrue(discovery.waitForExistence(timeout: 5))
        XCTAssertTrue(firstFilter.waitForExistence(timeout: 3))
        XCTAssertTrue(firstFilter.isHittable)
        XCTAssertTrue(modeButton.waitForExistence(timeout: 3))
        XCTAssertTrue(modeButton.isHittable)
        XCTAssertGreaterThanOrEqual(modeButton.frame.height, 44)
        captureScreenshot(named: "i4a-\(sizeName)-discovery")

        let featured = app.descendants(matching: .any)["discovery.featured-event"]
        XCTAssertTrue(featured.waitForExistence(timeout: 5))
        for _ in 0..<5 where !featured.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(featured.isHittable)
        featured.tap()

        let detailTitle = app.descendants(matching: .any)["event.detail.title"]
        let detailAction = app.buttons
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "event.action."))
            .firstMatch
        XCTAssertTrue(detailTitle.waitForExistence(timeout: 5))
        XCTAssertTrue(detailAction.waitForExistence(timeout: 3))
        XCTAssertGreaterThan(detailAction.frame.width, 80)
        XCTAssertGreaterThanOrEqual(detailAction.frame.height, 44)
        captureScreenshot(named: "i4a-\(sizeName)-detail")
        try tapNativeBackButton(in: app)

        app.tabBars.buttons["创建"].tap()
        let composerGate = app.staticTexts["登录后创建活动"]
        let composerAction = app.buttons["登录"]
        XCTAssertTrue(composerGate.waitForExistence(timeout: 5))
        XCTAssertTrue(composerAction.waitForExistence(timeout: 3))
        for _ in 0..<4 where !composerAction.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(composerAction.isHittable)
        XCTAssertGreaterThanOrEqual(composerAction.frame.height, 44)
        XCTAssertTrue(app.staticTexts["草稿会自动保存，并可在 Web 工作台继续编辑。"].exists)
        captureScreenshot(named: "i4a-\(sizeName)-create")

        app.tabBars.buttons["我的"].tap()
        let profileAction = app.buttons["登录或注册"]
        XCTAssertTrue(profileAction.waitForExistence(timeout: 5))
        XCTAssertTrue(profileAction.isHittable)
        XCTAssertGreaterThanOrEqual(profileAction.frame.height, 44)
        captureScreenshot(named: "i4a-\(sizeName)-profile")
    }

    @MainActor
    private func captureScreenshot(named name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor
    func testItineraryCardOpensNativeDetailAndCancellationRequiresConfirmation() throws {
        let registrationID = "019b0000-0000-7000-8400-000000000001"
        let app = XCUIApplication()
        app.launchArguments = coreJourneyLaunchArguments(state: "itinerary")
        app.launch()

        XCTAssertTrue(app.tabBars.buttons["行程"].waitForExistence(timeout: 5))
        app.tabBars.buttons["行程"].tap()
        XCTAssertTrue(
            app.descendants(matching: .any)["itinerary.screen"]
                .waitForExistence(timeout: 5)
        )

        let openButton = app.descendants(matching: .any)[
            "itinerary.item.\(registrationID).open"
        ]
        XCTAssertTrue(openButton.waitForExistence(timeout: 3))
        openButton.tap()

        let detailTitle = app.staticTexts["event.detail.title"]
        XCTAssertTrue(detailTitle.waitForExistence(timeout: 5))
        XCTAssertEqual(detailTitle.label, "Tokyo Makers Night")
        try tapNativeBackButton(in: app)

        let moreButton = app.descendants(matching: .any)[
            "itinerary.item.\(registrationID).more"
        ]
        XCTAssertTrue(moreButton.waitForExistence(timeout: 3))
        moreButton.tap()
        let cancelAction = app.descendants(matching: .any)[
            "itinerary.item.\(registrationID).cancel"
        ]
        XCTAssertTrue(cancelAction.waitForExistence(timeout: 3))
        cancelAction.tap()

        let alert = app.alerts.firstMatch
        XCTAssertTrue(alert.waitForExistence(timeout: 3))
        _ = nativeAlertAction(
            identifier: "itinerary.cancel.confirm",
            label: "取消报名",
            in: alert
        )
        let dismissButton = nativeAlertAction(
            identifier: "itinerary.cancel.dismiss",
            label: "取消",
            in: alert
        )
        dismissButton.tap()
        XCTAssertTrue(alert.waitForNonExistence(timeout: 3))
        XCTAssertTrue(openButton.exists, "放弃取消后行程卡必须仍然存在")
    }

    private func coreJourneyLaunchArguments(
        state: String,
        routeTab: String? = nil,
        largestAccessibilityText: Bool = false
    ) -> [String] {
        var arguments = [
            "-spott-ui-test-navigation-fixture",
            "-spott-ui-test-core-journey-state",
            state,
        ]
        if let routeTab {
            arguments += ["-spott-ui-test-route-tab", routeTab]
        }
        if largestAccessibilityText {
            arguments += [
                "-UIPreferredContentSizeCategoryName",
                UIContentSizeCategory.accessibilityExtraExtraExtraLarge.rawValue,
            ]
        }
        return arguments
    }

    @MainActor
    func testLaunchPerformance() throws {
        // This measures how long it takes to launch your application.
        measure(metrics: [XCTApplicationLaunchMetric()]) {
            XCUIApplication().launch()
        }
    }
}
