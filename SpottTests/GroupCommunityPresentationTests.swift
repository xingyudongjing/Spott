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
        XCTAssertEqual(GroupCommunityLayout.cardCoverMinimumHeight(for: .large), 132)
        XCTAssertEqual(GroupCommunityLayout.cardCoverMinimumHeight(for: .accessibility5), 96)
        XCTAssertFalse(GroupCommunityLayout.usesVerticalCardMetadata(for: .large))
        XCTAssertTrue(GroupCommunityLayout.usesVerticalCardMetadata(for: .accessibility5))
        XCTAssertFalse(GroupCommunityLayout.usesVerticalCardTags(for: .large))
        XCTAssertTrue(GroupCommunityLayout.usesVerticalCardTags(for: .accessibility5))
    }

    func testTouchTargetsKeepAStableMarginAboveTheMinimum() {
        XCTAssertGreaterThan(GroupCommunityLayout.minimumTouchTarget, 44)
    }

    func testLiquidGlassIsReservedForFloatingInteractiveChrome() {
        XCTAssertFalse(GroupCommunitySurfacePolicy.usesLiquidGlass(for: .content))
        XCTAssertTrue(GroupCommunitySurfacePolicy.usesLiquidGlass(for: .interactiveControl))
        XCTAssertFalse(GroupCommunitySurfacePolicy.usesLiquidGlass(for: .navigationCard))
    }

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
}
