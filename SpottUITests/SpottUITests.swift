//
//  SpottUITests.swift
//  SpottUITests
//
//  Created by 姚凯 on 2026/7/15.
//

import XCTest

final class SpottUITests: XCTestCase {

    override func setUpWithError() throws {
        // Put setup code here. This method is called before the invocation of each test method in the class.

        // In UI tests it is usually best to stop immediately when a failure occurs.
        continueAfterFailure = false

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
        XCTAssertTrue(app.tabBars.buttons["我的"].exists)
        XCTAssertEqual(app.tabBars.count, 1, "发现页只能有一套系统底部导航")
        XCTAssertEqual(app.tabBars.firstMatch.buttons.count, 3, "系统底部导航应当正好包含三个入口")

        XCTAssertTrue(app.buttons["显示地图"].exists, "地图切换不能暴露 SF Symbol 的内部名称")
        app.buttons["显示地图"].tap()
        XCTAssertTrue(app.buttons["显示列表"].waitForExistence(timeout: 2))
        app.buttons["显示列表"].tap()

        let createButton = app.buttons["discovery.create-button"]
        XCTAssertTrue(createButton.exists, "发现页必须有浮动发布活动入口")
        XCTAssertEqual(createButton.label, "发布活动", "发布入口必须使用可读的辅助功能标签")
        createButton.tap()
        XCTAssertTrue(app.staticTexts["登录后创建活动"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.buttons["登录"].exists)
        app.buttons["关闭"].tap()
        XCTAssertTrue(createButton.waitForExistence(timeout: 3), "关闭创建面板后应回到发现页")
    }

    @MainActor
    func testEachSystemTabRetainsItsOwnNavigationPath() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-spott-ui-test-navigation-fixture"]
        app.launch()

        XCTAssertTrue(app.buttons["通知"].waitForExistence(timeout: 5))
        app.buttons["通知"].tap()
        XCTAssertTrue(app.navigationBars["通知"].waitForExistence(timeout: 3))

        for tab in ["社群", "我的"] {
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

        try assertPublicEventRouteStaysIn(tab: "我的", routeTab: "activities", app: app)
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
        let itineraryButton = app.descendants(matching: .any)[
            "registration.confirmation.view_itinerary"
        ]
        XCTAssertTrue(itineraryButton.waitForExistence(timeout: 3))
        XCTAssertTrue(itineraryButton.isHittable)
        XCTAssertGreaterThanOrEqual(itineraryButton.frame.height, 44)
        itineraryButton.tap()
        XCTAssertTrue(app.tabBars.buttons["我的"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.tabBars.buttons["我的"].isSelected)
        XCTAssertTrue(
            app.descendants(matching: .any)["itinerary.screen"]
                .waitForExistence(timeout: 5),
            "查看行程必须落在我的 Tab 内推入的行程页"
        )
    }

    @MainActor
    func testItineraryCardOpensNativeDetailAndCancellationRequiresConfirmation() throws {
        let registrationID = "019b0000-0000-7000-8400-000000000001"
        let app = XCUIApplication()
        app.launchArguments = coreJourneyLaunchArguments(
            state: "itinerary",
            routeTab: "itinerary"
        )
        app.launch()

        XCTAssertTrue(app.tabBars.buttons["我的"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.tabBars.buttons["我的"].isSelected)
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
                "UICTContentSizeCategoryAccessibilityExtraExtraExtraLarge",
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
