import Foundation
import SwiftUI
import UIKit

private final class GroupCommunityLocalizationBundleToken {}

private final class GroupCommunityLocalizationBundleCache: @unchecked Sendable {
    private var bundles: [String: Bundle] = [:]
    private let lock = NSLock()

    func bundle(for key: String, resolve: () -> Bundle) -> Bundle {
        lock.lock()
        if let bundle = bundles[key] {
            lock.unlock()
            return bundle
        }
        lock.unlock()

        let resolved = resolve()
        lock.lock()
        defer { lock.unlock() }
        if let bundle = bundles[key] { return bundle }
        bundles[key] = resolved
        return resolved
    }
}

enum GroupCommunityLocalization {
    static func text(
        _ key: String.LocalizationValue,
        locale: Locale
    ) -> String {
        String(
            localized: key,
            bundle: localizedBundle(for: locale),
            locale: locale
        )
    }

    private static let sourceBundle = Bundle(for: GroupCommunityLocalizationBundleToken.self)
    private static let bundleCache = GroupCommunityLocalizationBundleCache()

    private static func localizedBundle(for locale: Locale) -> Bundle {
        let requestedIdentifier = locale.identifier
            .split(separator: "@", maxSplits: 1)
            .first
            .map(String.init)?
            .replacingOccurrences(of: "_", with: "-") ?? locale.identifier
        let language = requestedIdentifier
            .split(separator: "-", maxSplits: 1)
            .first
            .map(String.init)

        return bundleCache.bundle(for: requestedIdentifier.lowercased()) {
            var candidates = [requestedIdentifier]
            if language?.lowercased() == "zh" { candidates.append("zh-Hans") }
            if let language { candidates.append(language) }

            for candidate in candidates {
                guard let localization = sourceBundle.localizations.first(where: {
                    $0.replacingOccurrences(of: "_", with: "-")
                        .caseInsensitiveCompare(candidate) == .orderedSame
                }),
                    let path = sourceBundle.path(forResource: localization, ofType: "lproj"),
                    let bundle = Bundle(path: path)
                else { continue }
                return bundle
            }
            return sourceBundle
        }
    }
}

struct GroupCommunityCopy: Sendable {
    let locale: Locale

    var signInTitle: String { text("登录或注册") }

    func scopeTitle(_ scope: GroupDirectoryScope) -> String {
        text(scope == .discover ? "发现" : "我的社群")
    }

    func joinTitle(_ mode: GroupJoinMode) -> String {
        switch mode {
        case .open: text("加入社群")
        case .approval: text("申请加入")
        case .inviteOnly: text("使用邀请码")
        }
    }

    func statusTitle(
        groupStatus: String,
        membershipStatus: String?,
        memberCount: Int,
        capacity: Int,
        joinMode: GroupJoinMode
    ) -> String {
        if groupStatus == "closing" { return text("解散通知期") }
        if membershipStatus == "pending" { return text("等待审核") }
        if membershipStatus == "active" || membershipStatus == "muted" {
            return text("已加入")
        }
        if memberCount >= capacity { return text("已满员") }
        switch joinMode {
        case .open: return text("开放加入")
        case .approval: return text("申请加入")
        case .inviteOnly: return text("邀请加入")
        }
    }

    func membershipTitle(_ status: String) -> String {
        switch status {
        case "pending": text("申请审核中")
        case "muted": text("已加入 · 暂停评论")
        case "active": text("已加入社群")
        default: text("状态更新中")
        }
    }

    func regionName(_ regionID: String) -> String {
        let key: String.LocalizationValue = switch regionID.lowercased() {
        case "tokyo": "东京"
        case "kanagawa": "神奈川"
        case "saitama": "埼玉"
        case "chiba": "千叶"
        case "osaka": "大阪"
        case "kyoto": "京都"
        case "fukuoka": "福冈"
        case "hokkaido": "北海道"
        case "okinawa": "冲绳"
        case "nationwide": "日本全国"
        default: "其他地区"
        }
        return text(key)
    }

    func joinModeTitle(_ mode: GroupJoinMode) -> String {
        switch mode {
        case .open: text("公开加入")
        case .approval: text("申请审核")
        case .inviteOnly: text("仅限邀请")
        }
    }

    func joinModeExplanation(_ mode: GroupJoinMode) -> String {
        switch mode {
        case .open: text("确认后会立即成为社群成员。")
        case .approval: text("管理员审核通过后才会成为社群成员。")
        case .inviteOnly: text("请输入管理员提供的有效邀请码。")
        }
    }

    func memberRoleTitle(_ role: String) -> String {
        switch role {
        case "owner": text("群主")
        case "admin": text("管理员")
        default: text("成员")
        }
    }

    func memberStatusTitle(_ status: String) -> String {
        switch status {
        case "pending": text("待审核")
        case "active": text("活跃")
        case "muted": text("已暂停评论")
        case "removed": text("已移除")
        default: text("状态更新中")
        }
    }

    func transferStateTitle(_ state: String) -> String {
        switch state {
        case "awaiting_target": text("等待接收人确认")
        case "cooling_off": text("24 小时冷静期")
        case "completed": text("转让已完成")
        case "cancelled": text("转让已取消")
        default: text("状态更新中")
        }
    }

    func text(_ key: String.LocalizationValue) -> String {
        GroupCommunityLocalization.text(key, locale: locale)
    }
}

enum GroupCommunityRegion: String, CaseIterable, Identifiable, Sendable {
    case tokyo
    case kanagawa
    case saitama
    case chiba
    case osaka
    case kyoto
    case fukuoka
    case hokkaido
    case okinawa
    case nationwide

    var id: String { rawValue }

    static func safeSelection(for regionID: String) -> Self {
        Self(rawValue: regionID.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
            ?? .nationwide
    }

    func title(using copy: GroupCommunityCopy) -> String {
        copy.regionName(rawValue)
    }
}

enum GroupCommunityLayout {
    /// A small margin avoids Core Animation rounding a nominal 44 pt frame just below 44.
    static let minimumTouchTarget: CGFloat = 45

    static func usesVerticalActions(for dynamicTypeSize: DynamicTypeSize) -> Bool {
        dynamicTypeSize.isAccessibilitySize
    }

    static func usesVerticalCardMetadata(for dynamicTypeSize: DynamicTypeSize) -> Bool {
        dynamicTypeSize.isAccessibilitySize
    }

    static func usesVerticalCardTags(for dynamicTypeSize: DynamicTypeSize) -> Bool {
        dynamicTypeSize.isAccessibilitySize
    }

    static func cardCoverMinimumHeight(for dynamicTypeSize: DynamicTypeSize) -> CGFloat {
        dynamicTypeSize.isAccessibilitySize ? 96 : 132
    }
}

enum GroupCommunitySurfaceRole: Sendable {
    case content
    case interactiveControl
    case navigationCard
}

enum GroupCommunitySurfacePolicy {
    static func usesLiquidGlass(for role: GroupCommunitySurfaceRole) -> Bool {
        switch role {
        case .content, .navigationCard:
            false
        case .interactiveControl:
            true
        }
    }
}

enum GroupCommunityImageFailure: Error, Equatable, Sendable {
    case unreadable

    func userFacing(locale: Locale) -> UserFacingError {
        switch self {
        case .unreadable:
            UserFacingError(
                id: "GROUP_IMAGE_UNREADABLE",
                message: GroupCommunityLocalization.text("无法读取这张图片。", locale: locale),
                retryable: false
            )
        }
    }
}

enum GroupCommunityImageDecoder {
    static func prepare(data: Data?) throws -> (image: UIImage, jpegData: Data) {
        guard let data,
              let image = UIImage(data: data),
              let jpegData = image.jpegData(compressionQuality: 0.86)
        else {
            throw GroupCommunityImageFailure.unreadable
        }
        return (image, jpegData)
    }
}

enum GroupCommunityCommentLocale {
    static func identifier(for locale: Locale) -> String {
        let normalized = locale.identifier
            .replacingOccurrences(of: "_", with: "-")
            .lowercased()
        if normalized == "zh" || normalized.hasPrefix("zh-") { return "zh-Hans" }
        if normalized == "ja" || normalized.hasPrefix("ja-") { return "ja" }
        return "en"
    }
}

#if DEBUG
enum GroupCommunityUITestFixture {
    static let argument = "-spott-ui-test-community-fixture"

    static var isEnabled: Bool {
        ProcessInfo.processInfo.arguments.contains(argument)
    }

    static let groups = [
        GroupSummary(
            id: UUID(uuidString: "019b0000-0000-7000-8200-000000000001")!,
            ownerId: UUID(uuidString: "019b0000-0000-7000-8200-000000000002")!,
            owner: GroupPerson(
                id: UUID(uuidString: "019b0000-0000-7000-8200-000000000002")!,
                name: "Mika",
                handle: "mika"
            ),
            name: "Weekend City Walks",
            slug: "weekend-city-walks",
            description: "A welcoming community for relaxed weekend walks.",
            joinMode: .approval,
            regionId: "tokyo",
            categoryId: "outdoor",
            tags: ["walking", "weekend"],
            rules: "Be kind and arrive on time.",
            capacity: 50,
            memberCount: 18,
            status: "active",
            membershipStatus: nil,
            membershipRole: nil,
            viewerFollowing: false,
            announcementSummary: [],
            closingAt: nil,
            dissolveAfter: nil,
            availableActions: ["joinGroup"],
            version: 1,
            updatedAt: Date(timeIntervalSince1970: 1_721_376_000)
        ),
    ]
}
#endif
