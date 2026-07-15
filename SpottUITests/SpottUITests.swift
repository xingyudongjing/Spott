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
        XCTAssertTrue(app.tabBars.buttons["行程"].exists)
        XCTAssertTrue(app.tabBars.buttons["创建"].exists)
        XCTAssertTrue(app.tabBars.buttons["社群"].exists)
        XCTAssertTrue(app.tabBars.buttons["我的"].exists)
        XCTAssertEqual(app.tabBars.count, 1, "发现页只能有一套系统底部导航")
        XCTAssertEqual(app.tabBars.firstMatch.buttons.count, 5, "系统底部导航应当正好包含五个入口")

        XCTAssertTrue(app.buttons["显示地图"].exists, "地图切换不能暴露 SF Symbol 的内部名称")
        app.buttons["显示地图"].tap()
        XCTAssertTrue(app.buttons["显示列表"].waitForExistence(timeout: 2))
        app.buttons["显示列表"].tap()

        app.tabBars.buttons["创建"].tap()
        XCTAssertTrue(app.staticTexts["登录后创建活动"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.buttons["登录"].exists)
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
    func testLaunchPerformance() throws {
        // This measures how long it takes to launch your application.
        measure(metrics: [XCTApplicationLaunchMetric()]) {
            XCUIApplication().launch()
        }
    }
}
