import XCTest
import UIKit

final class GroupCommunityAccessibilityUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
        MainActor.assumeIsolated {
            XCUIDevice.shared.orientation = .portrait
        }
    }

    @MainActor
    func testChineseStandardCommunityUIAndLocalizedDemoFixture() throws {
        try assertCommunity(locale: "zh-Hans", accessibilitySize: false)
    }

    @MainActor
    func testJapaneseStandardCommunityUIAndLocalizedDemoFixture() throws {
        try assertCommunity(locale: "ja", accessibilitySize: false)
    }

    @MainActor
    func testEnglishStandardCommunityUIAndLocalizedDemoFixture() throws {
        try assertCommunity(locale: "en", accessibilitySize: false)
    }

    @MainActor
    func testChineseMaximumAccessibilityCommunityUIAndLocalizedDemoFixture() throws {
        try assertCommunity(locale: "zh-Hans", accessibilitySize: true)
    }

    @MainActor
    func testJapaneseMaximumAccessibilityCommunityUIAndLocalizedDemoFixture() throws {
        try assertCommunity(locale: "ja", accessibilitySize: true)
    }

    @MainActor
    func testEnglishMaximumAccessibilityCommunityUIAndLocalizedDemoFixture() throws {
        try assertCommunity(locale: "en", accessibilitySize: true)
    }

    @MainActor
    func testCommunityDisplayAccommodationsChangeTheRenderedProductionControls() throws {
        let standard = try renderedScopeControl(arguments: [])
        let reducedTransparency = try renderedScopeControl(
            arguments: ["-spott-ui-test-community-reduce-transparency"]
        )
        let increasedContrast = try renderedScopeControl(
            arguments: ["-spott-ui-test-community-increase-contrast"]
        )

        XCTAssertGreaterThan(
            normalizedPixelDifference(standard, reducedTransparency),
            0.005,
            "Reduce Transparency must visibly replace the glass control surface."
        )
        XCTAssertGreaterThan(
            normalizedPixelDifference(standard, increasedContrast),
            0.04,
            "Increase Contrast must visibly change the selected scope treatment."
        )
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
        let headerTitle = app.staticTexts["community.header.title"]
        let headerSubtitle = app.staticTexts["community.header.subtitle"]
        let search = app.textFields["community.search"]
        let signedOutMessage = app.staticTexts["community.signed-out.message"]
        // These four values belong to the localized DEBUG demo fixture. They validate
        // single-language screenshots and layout only, not translation of production UGC.
        let groupName = app.staticTexts[expected.groupName]
        let groupDescription = app.staticTexts[expected.groupDescription]
        let walkingTag = app.staticTexts[expected.firstTag]
        let weekendTag = app.staticTexts[expected.secondTag]
        let region = app.staticTexts["community.fixture.region"]
        let status = app.staticTexts["community.fixture.status"]

        for (name, element) in [
            ("header title", headerTitle),
            ("header subtitle", headerSubtitle),
            ("discover scope", discover),
            ("my communities scope", mine),
            ("search", search),
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

        XCTAssertEqual(headerTitle.label, expected.headerTitle, file: file, line: line)
        XCTAssertEqual(headerSubtitle.label, expected.headerSubtitle, file: file, line: line)
        XCTAssertEqual(discover.label, expected.discover, file: file, line: line)
        XCTAssertEqual(mine.label, expected.mine, file: file, line: line)
        XCTAssertEqual(
            app.buttons.matching(identifier: "community.scope.discover").count,
            1,
            "Discover must be one concise accessibility element, not duplicate icon/text nodes.",
            file: file,
            line: line
        )
        XCTAssertEqual(
            app.buttons.matching(identifier: "community.scope.mine").count,
            1,
            "My communities must be one concise accessibility element, not duplicate icon/text nodes.",
            file: file,
            line: line
        )
        XCTAssertTrue(discover.isSelected, "Discover scope must expose its selected state", file: file, line: line)
        XCTAssertFalse(mine.isSelected, "Inactive scope must not expose a selected state", file: file, line: line)
        XCTAssertEqual(search.placeholderValue ?? "", expected.search, file: file, line: line)
        XCTAssertEqual(signIn.label, expected.signIn, file: file, line: line)

        if !accessibilitySize {
            let placeholderWidth = (expected.search as NSString).size(
                withAttributes: [.font: UIFont.preferredFont(forTextStyle: .body)]
            ).width
            print(
                "COMMUNITY_SEARCH_WIDTH locale=\(locale) "
                    + "placeholder=\(placeholderWidth) available=\(search.frame.width)"
            )
            XCTAssertLessThanOrEqual(
                placeholderWidth,
                search.frame.width,
                "Search placeholder truncates at standard size: required \(placeholderWidth), "
                    + "available \(search.frame.width)",
                file: file,
                line: line
            )
        }

        let windowFrame = app.windows.firstMatch.frame
        let statusBar = app.statusBars.firstMatch
        let protectedTopEdge = statusBar.exists
            ? statusBar.frame.maxY
            : windowFrame.minY + 44
        let horizontalViewport = windowFrame.insetBy(dx: -0.5, dy: 0)
        for (name, element) in [
            ("header title", headerTitle),
            ("header subtitle", headerSubtitle),
            ("discover scope", discover),
            ("my communities scope", mine),
            ("search field", search),
        ] {
            print("COMMUNITY_FRAME locale=\(locale) name=\(name) frame=\(element.frame) window=\(windowFrame)")
            XCTAssertGreaterThanOrEqual(
                element.frame.minX,
                horizontalViewport.minX,
                "\(name) escapes the leading window edge: \(element.frame), window: \(windowFrame)",
                file: file,
                line: line
            )
            XCTAssertLessThanOrEqual(
                element.frame.maxX,
                horizontalViewport.maxX,
                "\(name) escapes the trailing window edge: \(element.frame), window: \(windowFrame)",
                file: file,
                line: line
            )
        }
        XCTAssertGreaterThanOrEqual(
            headerTitle.frame.minY,
            protectedTopEdge + 8,
            "Header overlaps the protected top region: \(headerTitle.frame), status: \(statusBar.frame)",
            file: file,
            line: line
        )

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
        XCTAssertTrue(groupName.exists, "Missing localized group name", file: file, line: line)
        XCTAssertTrue(groupDescription.exists, "Missing localized group description", file: file, line: line)
        XCTAssertEqual(groupName.label, expected.groupName, file: file, line: line)
        XCTAssertEqual(groupDescription.label, expected.groupDescription, file: file, line: line)
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
    private func renderedScopeControl(arguments: [String]) throws -> UIImage {
        let app = XCUIApplication()
        app.launchArguments = [
            "-spott-ui-test-navigation-fixture",
            "-spott-ui-test-community-fixture",
            "-app.language", "en",
        ] + arguments
        app.launch()

        let communityTab = app.tabBars.buttons["Communities"]
        XCTAssertTrue(communityTab.waitForExistence(timeout: 8))
        communityTab.tap()

        let discover = app.buttons["community.scope.discover"]
        let mine = app.buttons["community.scope.mine"]
        XCTAssertTrue(discover.waitForExistence(timeout: 8))
        XCTAssertTrue(mine.waitForExistence(timeout: 8))
        XCTAssertTrue(waitForStableFrames([discover, mine]))

        let scopeFrame = discover.frame
            .union(mine.frame)
            .insetBy(dx: -6, dy: -6)
            .intersection(app.windows.firstMatch.frame)
        let screenshot = XCUIScreen.main.screenshot().image
        let scale = screenshot.scale
        let crop = CGRect(
            x: scopeFrame.minX * scale,
            y: scopeFrame.minY * scale,
            width: scopeFrame.width * scale,
            height: scopeFrame.height * scale
        ).integral
        let image = try XCTUnwrap(screenshot.cgImage?.cropping(to: crop))
        app.terminate()
        return UIImage(cgImage: image, scale: scale, orientation: .up)
    }

    private func normalizedPixelDifference(_ lhs: UIImage, _ rhs: UIImage) -> Double {
        guard let lhsImage = lhs.cgImage,
              let rhsImage = rhs.cgImage,
              lhsImage.width == rhsImage.width,
              lhsImage.height == rhsImage.height,
              let lhsData = lhsImage.dataProvider?.data,
              let rhsData = rhsImage.dataProvider?.data,
              let lhsBytes = CFDataGetBytePtr(lhsData),
              let rhsBytes = CFDataGetBytePtr(rhsData)
        else { return 0 }

        let count = min(CFDataGetLength(lhsData), CFDataGetLength(rhsData))
        guard count > 0 else { return 0 }
        var total = 0
        for index in 0..<count {
            total += abs(Int(lhsBytes[index]) - Int(rhsBytes[index]))
        }
        return Double(total) / Double(count * 255)
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
        headerTitle: String,
        headerSubtitle: String,
        discover: String,
        mine: String,
        search: String,
        signIn: String,
        groupName: String,
        groupDescription: String,
        firstTag: String,
        secondTag: String,
        region: String,
        status: String
    ) {
        switch locale {
        case "ja": (
            "コミュニティ",
            "コミュニティを見つける",
            "共通の興味から、次の出会いへ。",
            "見つける",
            "マイコミュニティ",
            "コミュニティ名、興味、地域を検索",
            "ログイン／登録",
            "週末シティウォーク",
            "週末にゆったり街歩きを楽しむ公開コミュニティです。",
            "#街歩き",
            "#週末",
            "東京",
            "参加を申請"
        )
        case "en": (
            "Communities",
            "Find your community",
            "Shared interests. Your next gathering.",
            "Discover",
            "My communities",
            "Search groups, interests, or places",
            "Sign in or join",
            "Weekend City Walks",
            "A welcoming community for relaxed weekend walks.",
            "#walking",
            "#weekend",
            "Tokyo",
            "Request to join"
        )
        default: (
            "社群",
            "找到你的社群",
            "找到同好，也找到下一次见面的理由。",
            "发现",
            "我的社群",
            "搜索社群名称、兴趣或地区",
            "登录或注册",
            "周末城市漫步",
            "周末一起轻松漫步的友好社群。",
            "#散步",
            "#周末",
            "东京",
            "申请加入"
        )
        }
    }
}
