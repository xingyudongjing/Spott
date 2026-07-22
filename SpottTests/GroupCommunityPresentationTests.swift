import SwiftUI
import XCTest
@testable import Spott

final class GroupCommunityPresentationTests: XCTestCase {
    func testDirectoryScopeAndAuthenticationCopyUseTheExplicitAppLocale() {
        let chinese = GroupCommunityCopy(locale: Locale(identifier: "zh-Hans"))
        let japanese = GroupCommunityCopy(locale: Locale(identifier: "ja"))
        let english = GroupCommunityCopy(locale: Locale(identifier: "en"))

        XCTAssertEqual(chinese.scopeTitle(.discover), "发现")
        XCTAssertEqual(chinese.scopeTitle(.mine), "我的社群")
        XCTAssertEqual(chinese.signInTitle, "登录或注册")

        XCTAssertEqual(japanese.scopeTitle(.discover), "見つける")
        XCTAssertEqual(japanese.scopeTitle(.mine), "マイコミュニティ")
        XCTAssertEqual(japanese.signInTitle, "ログイン／登録")

        XCTAssertEqual(english.scopeTitle(.discover), "Discover")
        XCTAssertEqual(english.scopeTitle(.mine), "My communities")
        XCTAssertEqual(english.signInTitle, "Sign in or join")
    }

    func testJoinAndStatusCopyNeverLeaksTheChineseSourceIntoJapaneseOrEnglish() {
        let japanese = GroupCommunityCopy(locale: Locale(identifier: "ja"))
        let english = GroupCommunityCopy(locale: Locale(identifier: "en"))

        XCTAssertEqual(japanese.joinTitle(.approval), "参加を申請")
        XCTAssertEqual(japanese.statusTitle(
            groupStatus: "active",
            membershipStatus: "pending",
            memberCount: 12,
            capacity: 50,
            joinMode: .approval
        ), "承認待ち")
        XCTAssertEqual(japanese.membershipTitle("muted"), "参加済み・コメント停止中")

        XCTAssertEqual(english.joinTitle(.approval), "Request to join")
        XCTAssertEqual(english.statusTitle(
            groupStatus: "active",
            membershipStatus: nil,
            memberCount: 12,
            capacity: 50,
            joinMode: .approval
        ), "Request to join")
        XCTAssertEqual(english.membershipTitle("muted"), "Joined · Comments paused")
    }

    func testRegionIDsResolveToLocalizedNamesAndUnknownMachineIDsStayPrivate() {
        let chinese = GroupCommunityCopy(locale: Locale(identifier: "zh-Hans"))
        let japanese = GroupCommunityCopy(locale: Locale(identifier: "ja"))
        let english = GroupCommunityCopy(locale: Locale(identifier: "en"))

        XCTAssertEqual(chinese.regionName("tokyo"), "东京")
        XCTAssertEqual(japanese.regionName("tokyo"), "東京")
        XCTAssertEqual(english.regionName("tokyo"), "Tokyo")
        XCTAssertEqual(chinese.regionName("saitama"), "埼玉")
        XCTAssertEqual(japanese.regionName("chiba"), "千葉")
        XCTAssertEqual(english.regionName("nationwide"), "All Japan")

        XCTAssertEqual(chinese.regionName("internal_region_91"), "其他地区")
        XCTAssertEqual(japanese.regionName("internal_region_91"), "その他の地域")
        XCTAssertEqual(english.regionName("internal_region_91"), "Other area")
    }

    func testManagementAndMembershipStatesUseSafeLocalizedCopy() {
        let japanese = GroupCommunityCopy(locale: Locale(identifier: "ja"))
        let english = GroupCommunityCopy(locale: Locale(identifier: "en"))

        XCTAssertEqual(japanese.joinModeTitle(.approval), "承認制")
        XCTAssertEqual(
            japanese.joinModeExplanation(.approval),
            "管理者の承認後にコミュニティメンバーになります。"
        )
        XCTAssertEqual(japanese.memberRoleTitle("owner"), "コミュニティオーナー")
        XCTAssertEqual(japanese.memberStatusTitle("muted"), "コメント停止中")
        XCTAssertEqual(japanese.transferStateTitle("cooling_off"), "24時間のクーリングオフ期間")

        XCTAssertEqual(english.joinModeTitle(.inviteOnly), "Invite only")
        XCTAssertEqual(
            english.joinModeExplanation(.inviteOnly),
            "Enter a valid invite code from an admin."
        )
        XCTAssertEqual(english.memberRoleTitle("admin"), "Admin")
        XCTAssertEqual(english.memberStatusTitle("active"), "Active")
        XCTAssertEqual(english.transferStateTitle("completed"), "Transfer complete")

        XCTAssertEqual(japanese.memberStatusTitle("server_internal_state"), "状態を更新中")
        XCTAssertEqual(english.transferStateTitle("server_internal_state"), "Status updating")
    }

    func testCommunityActionLayoutStacksOnlyAtAccessibilityDynamicTypeSizes() {
        XCTAssertFalse(GroupCommunityLayout.usesVerticalActions(for: .large))
        XCTAssertFalse(GroupCommunityLayout.usesVerticalActions(for: .xxxLarge))
        XCTAssertTrue(GroupCommunityLayout.usesVerticalActions(for: .accessibility1))
        XCTAssertTrue(GroupCommunityLayout.usesVerticalActions(for: .accessibility5))
    }

    func testCreateGroupRegionSelectionUsesSupportedIDsAndLocalizedLabels() {
        let japanese = GroupCommunityCopy(locale: Locale(identifier: "ja"))
        let english = GroupCommunityCopy(locale: Locale(identifier: "en"))

        XCTAssertEqual(GroupCommunityRegion.safeSelection(for: "tokyo"), .tokyo)
        XCTAssertEqual(GroupCommunityRegion.safeSelection(for: "TOKYO"), .tokyo)
        XCTAssertEqual(
            GroupCommunityRegion.safeSelection(for: "internal_region_91"),
            .nationwide
        )
        XCTAssertEqual(GroupCommunityRegion.tokyo.title(using: japanese), "東京")
        XCTAssertEqual(GroupCommunityRegion.nationwide.title(using: english), "All Japan")
        XCTAssertFalse(GroupCommunityRegion.allCases.map(\.rawValue).contains("internal_region_91"))
    }

    func testAccessibilityCardPolicyAvoidsFixedTextCoverAndStacksMetadata() {
        XCTAssertEqual(GroupCommunityLayout.cardCoverMinimumHeight(for: .large), 156)
        XCTAssertEqual(GroupCommunityLayout.cardCoverMinimumHeight(for: .accessibility5), 112)
        XCTAssertFalse(GroupCommunityLayout.usesVerticalCardMetadata(for: .large))
        XCTAssertTrue(GroupCommunityLayout.usesVerticalCardMetadata(for: .accessibility5))
        XCTAssertFalse(GroupCommunityLayout.usesVerticalCardTags(for: .large))
        XCTAssertTrue(GroupCommunityLayout.usesVerticalCardTags(for: .accessibility5))
    }

    func testLargestNonAccessibilityTextSizesStackDenseCardContent() {
        XCTAssertTrue(GroupCommunityLayout.usesVerticalCardMetadata(for: .xxxLarge))
        XCTAssertTrue(GroupCommunityLayout.usesVerticalCardTags(for: .xxxLarge))
    }

    func testCommunityControlsUseComfortableFortyEightPointTargets() {
        XCTAssertEqual(GroupCommunityLayout.minimumTouchTarget, 48)
    }

    func testLiquidGlassIsReservedForFloatingInteractiveChrome() {
        XCTAssertFalse(GroupCommunitySurfacePolicy.usesLiquidGlass(for: .content))
        XCTAssertTrue(GroupCommunitySurfacePolicy.usesLiquidGlass(for: .interactiveControl))
        XCTAssertFalse(GroupCommunitySurfacePolicy.usesLiquidGlass(for: .navigationCard))
    }

    func testCommunityControlsUseOpaqueFallbackForDisplayAccommodations() {
        XCTAssertEqual(
            GroupCommunityControlSurfacePolicy.style(
                reduceTransparency: false,
                increasedContrast: false
            ),
            .glass
        )
        XCTAssertEqual(
            GroupCommunityControlSurfacePolicy.style(
                reduceTransparency: true,
                increasedContrast: false
            ),
            .opaque
        )
        XCTAssertEqual(
            GroupCommunityControlSurfacePolicy.style(
                reduceTransparency: false,
                increasedContrast: true
            ),
            .opaque
        )
        XCTAssertEqual(
            GroupCommunityControlSurfacePolicy.style(
                reduceTransparency: true,
                increasedContrast: true
            ),
            .opaque
        )
    }

    func testDisplayAccommodationFixtureArgumentsResolveThroughProductionSettings() {
        XCTAssertEqual(
            GroupCommunityDisplayAccommodations(
                systemReduceTransparency: false,
                systemIncreasedContrast: false,
                launchArguments: []
            ),
            GroupCommunityDisplayAccommodations(
                reduceTransparency: false,
                increasedContrast: false
            )
        )
        XCTAssertEqual(
            GroupCommunityDisplayAccommodations(
                systemReduceTransparency: false,
                systemIncreasedContrast: false,
                launchArguments: ["-spott-ui-test-community-reduce-transparency"]
            ),
            GroupCommunityDisplayAccommodations(
                reduceTransparency: true,
                increasedContrast: false
            )
        )
        XCTAssertEqual(
            GroupCommunityDisplayAccommodations(
                systemReduceTransparency: false,
                systemIncreasedContrast: false,
                launchArguments: ["-spott-ui-test-community-increase-contrast"]
            ),
            GroupCommunityDisplayAccommodations(
                reduceTransparency: false,
                increasedContrast: true
            )
        )
    }

    func testSelectedScopeAndTagPalettesMeetAAInDarkModeAndIncreaseContrastVisibly() throws {
        let standardScope = GroupCommunityControlPalette.scope(
            isSelected: true,
            increasedContrast: false
        )
        let increasedScope = GroupCommunityControlPalette.scope(
            isSelected: true,
            increasedContrast: true
        )
        let standardTag = GroupCommunityControlPalette.tag(increasedContrast: false)
        let increasedTag = GroupCommunityControlPalette.tag(increasedContrast: true)

        for (name, pair) in [
            ("standard selected scope", standardScope),
            ("increased-contrast selected scope", increasedScope),
            ("standard tag", standardTag),
            ("increased-contrast tag", increasedTag),
        ] {
            XCTAssertGreaterThanOrEqual(
                try contrastRatio(
                    foreground: pair.foreground,
                    background: pair.background,
                    interfaceStyle: .dark
                ),
                4.5,
                "\(name) must meet WCAG AA for normal text."
            )
        }

        XCTAssertNotEqual(
            try rgba(increasedScope.background, interfaceStyle: .dark),
            try rgba(standardScope.background, interfaceStyle: .dark),
            "Increase Contrast must materially change the selected scope fill."
        )
        XCTAssertNotEqual(
            try rgba(increasedTag.background, interfaceStyle: .dark),
            try rgba(standardTag.background, interfaceStyle: .dark),
            "Increase Contrast must materially change tag fills."
        )
    }

#if DEBUG
    func testLocalizedFixtureIsExplicitlyDemoOwnedAndDoesNotClaimProductionUGCTranslation() {
        XCTAssertEqual(GroupCommunityUITestFixture.contentOwnership, .localizedDebugDemo)
        XCTAssertFalse(GroupCommunityContentPolicy.translatesServerAuthoredUGC)

        let english = GroupCommunityUITestFixture.localizedDemoGroups(
            locale: Locale(identifier: "en")
        )[0]
        let japanese = GroupCommunityUITestFixture.localizedDemoGroups(
            locale: Locale(identifier: "ja")
        )[0]
        XCTAssertNotEqual(english.name, japanese.name)
        XCTAssertEqual(english.slug, japanese.slug)
        XCTAssertEqual(english.owner.name, japanese.owner.name)
    }
#endif

    func testUnreadableCoverUsesStableCodeAndExplicitThreeLocaleCopy() {
        XCTAssertThrowsError(
            try GroupCommunityImageDecoder.prepare(data: Data([0x00, 0x01, 0x02]))
        ) { error in
            XCTAssertEqual(error as? GroupCommunityImageFailure, .unreadable)
        }

        let chinese = GroupCommunityImageFailure.unreadable.userFacing(
            locale: Locale(identifier: "zh-Hans")
        )
        let japanese = GroupCommunityImageFailure.unreadable.userFacing(
            locale: Locale(identifier: "ja")
        )
        let english = GroupCommunityImageFailure.unreadable.userFacing(
            locale: Locale(identifier: "en")
        )

        XCTAssertEqual(chinese.id, "GROUP_IMAGE_UNREADABLE")
        XCTAssertEqual(chinese.message, "无法读取这张图片。")
        XCTAssertEqual(japanese.id, "GROUP_IMAGE_UNREADABLE")
        XCTAssertEqual(japanese.message, "この画像を読み込めませんでした。")
        XCTAssertEqual(english.id, "GROUP_IMAGE_UNREADABLE")
        XCTAssertEqual(english.message, "This image could not be read.")
        XCTAssertFalse(japanese.retryable)
        XCTAssertFalse(english.message.contains("无法读取"))
    }

    func testCommentSubmissionLocaleComesFromTheExplicitAppLocale() {
        XCTAssertEqual(
            GroupCommunityCommentLocale.identifier(for: Locale(identifier: "zh-Hans")),
            "zh-Hans"
        )
        XCTAssertEqual(
            GroupCommunityCommentLocale.identifier(for: Locale(identifier: "zh_CN")),
            "zh-Hans"
        )
        XCTAssertEqual(
            GroupCommunityCommentLocale.identifier(for: Locale(identifier: "ja_JP")),
            "ja"
        )
        XCTAssertEqual(
            GroupCommunityCommentLocale.identifier(for: Locale(identifier: "en_US")),
            "en"
        )
        XCTAssertEqual(
            GroupCommunityCommentLocale.identifier(for: Locale(identifier: "fr_FR")),
            "en"
        )
    }

    private func contrastRatio(
        foreground: Color,
        background: Color,
        interfaceStyle: UIUserInterfaceStyle
    ) throws -> Double {
        let foregroundLuminance = try relativeLuminance(
            rgba(foreground, interfaceStyle: interfaceStyle)
        )
        let backgroundLuminance = try relativeLuminance(
            rgba(background, interfaceStyle: interfaceStyle)
        )
        let lighter = max(foregroundLuminance, backgroundLuminance)
        let darker = min(foregroundLuminance, backgroundLuminance)
        return (lighter + 0.05) / (darker + 0.05)
    }

    private func rgba(
        _ color: Color,
        interfaceStyle: UIUserInterfaceStyle
    ) throws -> [CGFloat] {
        let traits = UITraitCollection(userInterfaceStyle: interfaceStyle)
        let resolved = UIColor(color).resolvedColor(with: traits)
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        XCTAssertTrue(resolved.getRed(&red, green: &green, blue: &blue, alpha: &alpha))
        return [red, green, blue, alpha]
    }

    private func relativeLuminance(_ rgba: [CGFloat]) -> Double {
        func linearized(_ value: CGFloat) -> Double {
            let channel = Double(value)
            return channel <= 0.04045
                ? channel / 12.92
                : pow((channel + 0.055) / 1.055, 2.4)
        }

        return 0.2126 * linearized(rgba[0])
            + 0.7152 * linearized(rgba[1])
            + 0.0722 * linearized(rgba[2])
    }
}
