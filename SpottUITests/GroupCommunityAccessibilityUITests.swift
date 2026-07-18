import XCTest

final class GroupCommunityAccessibilityUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
        MainActor.assumeIsolated {
            XCUIDevice.shared.orientation = .portrait
        }
    }

    @MainActor
    func testChineseStandardCommunityCopyAndFrames() throws {
        try assertCommunity(locale: "zh-Hans", accessibilitySize: false)
    }

    @MainActor
    func testJapaneseStandardCommunityCopyAndFrames() throws {
        try assertCommunity(locale: "ja", accessibilitySize: false)
    }

    @MainActor
    func testEnglishStandardCommunityCopyAndFrames() throws {
        try assertCommunity(locale: "en", accessibilitySize: false)
    }

    @MainActor
    func testChineseMaximumAccessibilityCommunityCopyAndFrames() throws {
        try assertCommunity(locale: "zh-Hans", accessibilitySize: true)
    }

    @MainActor
    func testJapaneseMaximumAccessibilityCommunityCopyAndFrames() throws {
        try assertCommunity(locale: "ja", accessibilitySize: true)
    }

    @MainActor
    func testEnglishMaximumAccessibilityCommunityCopyAndFrames() throws {
        try assertCommunity(locale: "en", accessibilitySize: true)
    }

    @MainActor
    private func assertCommunity(
        locale: String,
        accessibilitySize: Bool,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        let expected = expectedCopy(locale: locale)
        let app = XCUIApplication()
        app.launchArguments = [
            "-spott-ui-test-navigation-fixture",
            "-spott-ui-test-community-fixture",
            "-app.language", locale,
        ]
        if accessibilitySize {
            app.launchArguments += [
                "-UIPreferredContentSizeCategoryName",
                "UICTContentSizeCategoryAccessibilityXXXL",
            ]
        }
        app.launch()

        let communityTab = app.tabBars.buttons[expected.tab]
        XCTAssertTrue(communityTab.waitForExistence(timeout: 8), file: file, line: line)
        communityTab.tap()

        let discover = app.buttons["community.scope.discover"]
        let mine = app.buttons["community.scope.mine"]
        let signIn = app.buttons["community.sign-in"]
        let signedOutMessage = app.staticTexts["community.signed-out.message"]
        let walkingTag = app.staticTexts["community.fixture.tag.walking"]
        let weekendTag = app.staticTexts["community.fixture.tag.weekend"]
        let region = app.staticTexts["community.fixture.region"]
        let status = app.staticTexts["community.fixture.status"]

        for (name, element) in [
            ("discover scope", discover),
            ("my communities scope", mine),
            ("sign-in", signIn),
            ("signed-out message", signedOutMessage),
        ] {
            XCTAssertTrue(
                element.waitForExistence(timeout: 8),
                "Missing top element: \(name)",
                file: file,
                line: line
            )
        }

        XCTAssertEqual(discover.label, expected.discover, file: file, line: line)
        XCTAssertEqual(mine.label, expected.mine, file: file, line: line)
        XCTAssertEqual(signIn.label, expected.signIn, file: file, line: line)

        XCTAssertGreaterThanOrEqual(
            discover.frame.height,
            44,
            "Discover scope frame: \(discover.frame)",
            file: file,
            line: line
        )
        XCTAssertGreaterThanOrEqual(
            mine.frame.height,
            44,
            "My communities scope frame: \(mine.frame)",
            file: file,
            line: line
        )
        XCTAssertGreaterThanOrEqual(
            signIn.frame.height,
            44,
            "Sign-in frame: \(signIn.frame)",
            file: file,
            line: line
        )
        XCTAssertFalse(discover.frame.intersects(mine.frame), file: file, line: line)
        XCTAssertFalse(signIn.frame.intersects(signedOutMessage.frame), file: file, line: line)

        if accessibilitySize {
            XCTAssertLessThanOrEqual(discover.frame.maxY, mine.frame.minY, file: file, line: line)
        } else {
            XCTAssertLessThanOrEqual(discover.frame.maxX, mine.frame.minX, file: file, line: line)
        }

        let windowFrame = app.windows.firstMatch.frame
        let tabBar = app.tabBars.firstMatch
        let contentMaxY = tabBar.exists
            ? min(windowFrame.maxY, tabBar.frame.minY - 4)
            : windowFrame.maxY
        let contentViewport = CGRect(
            x: windowFrame.minX,
            y: windowFrame.minY,
            width: windowFrame.width,
            height: max(0, contentMaxY - windowFrame.minY)
        )
        let tolerantViewport = contentViewport.insetBy(dx: -0.5, dy: -0.5)
        for _ in 0..<10 {
            let cardDetailsAreVisible = [walkingTag, weekendTag, region, status].allSatisfy {
                $0.exists && tolerantViewport.contains($0.frame)
            }
            if cardDetailsAreVisible { break }
            app.swipeUp()
            _ = walkingTag.waitForExistence(timeout: 1)
            _ = weekendTag.waitForExistence(timeout: 1)
            _ = region.waitForExistence(timeout: 1)
            _ = status.waitForExistence(timeout: 1)
        }
        XCTAssertTrue(
            waitForStableFrames([walkingTag, weekendTag, region, status]),
            "Community card did not settle after scrolling",
            file: file,
            line: line
        )
        XCTAssertTrue(walkingTag.exists, "Missing walking tag", file: file, line: line)
        XCTAssertTrue(weekendTag.exists, "Missing weekend tag", file: file, line: line)
        XCTAssertTrue(region.exists, "Missing localized region after scrolling", file: file, line: line)
        XCTAssertTrue(status.waitForExistence(timeout: 4), "Missing join status", file: file, line: line)
        XCTAssertEqual(region.label, expected.region, file: file, line: line)
        XCTAssertEqual(status.label, expected.status, file: file, line: line)

        XCTAssertFalse(windowFrame.isEmpty, "Missing app window frame", file: file, line: line)
        XCTAssertFalse(region.frame.isEmpty, "Empty region frame", file: file, line: line)
        XCTAssertFalse(status.frame.isEmpty, "Empty status frame", file: file, line: line)
        for (name, element) in [
            ("walking tag", walkingTag),
            ("weekend tag", weekendTag),
            ("region", region),
            ("status", status),
        ] {
            XCTAssertFalse(element.frame.isEmpty, "Empty \(name) frame", file: file, line: line)
            XCTAssertTrue(
                tolerantViewport.contains(element.frame),
                "\(name) is clipped or behind navigation: \(element.frame), viewport: \(contentViewport)",
                file: file,
                line: line
            )
        }
        XCTAssertFalse(
            walkingTag.frame.intersects(weekendTag.frame),
            "Tag overlap: \(walkingTag.frame), \(weekendTag.frame)",
            file: file,
            line: line
        )
        XCTAssertFalse(
            region.frame.intersects(status.frame),
            "Region/status overlap: \(region.frame), \(status.frame)",
            file: file,
            line: line
        )

        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "i4b-community-\(locale)-\(accessibilitySize ? "ax5" : "standard")"
        screenshot.lifetime = .keepAlways
        add(screenshot)

        if locale != "zh-Hans" {
            XCTAssertFalse(app.buttons["发现"].exists, file: file, line: line)
            XCTAssertFalse(app.buttons["我的社群"].exists, file: file, line: line)
            XCTAssertFalse(app.staticTexts["申请加入"].exists, file: file, line: line)
            XCTAssertFalse(app.staticTexts["tokyo"].exists, file: file, line: line)
        }
    }

    @MainActor
    private func waitForStableFrames(
        _ elements: [XCUIElement],
        timeout: TimeInterval = 3
    ) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        var previousFrames: [CGRect]?
        var stableSamples = 0

        while Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
            let frames = elements.map(\.frame)
            if frames == previousFrames {
                stableSamples += 1
                if stableSamples >= 3 {
                    return true
                }
            } else {
                previousFrames = frames
                stableSamples = 0
            }
        }

        return false
    }

    private func expectedCopy(locale: String) -> (
        tab: String,
        discover: String,
        mine: String,
        signIn: String,
        region: String,
        status: String
    ) {
        switch locale {
        case "ja": (
            "コミュニティ",
            "見つける",
            "マイコミュニティ",
            "ログイン／登録",
            "東京",
            "参加を申請"
        )
        case "en": (
            "Communities",
            "Discover",
            "My communities",
            "Sign in or join",
            "Tokyo",
            "Request to join"
        )
        default: (
            "社群",
            "发现",
            "我的社群",
            "登录或注册",
            "东京",
            "申请加入"
        )
        }
    }
}
