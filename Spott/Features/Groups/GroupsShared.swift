import SwiftUI

enum GroupsLocalization {
    static func text(_ key: String.LocalizationValue, locale: Locale) -> String {
        SpottLocalization.text(key, table: "Groups", locale: locale)
    }

    static func format(
        _ key: String.LocalizationValue,
        locale: Locale,
        _ arguments: CVarArg...
    ) -> String {
        String(
            format: text(key, locale: locale),
            locale: locale,
            arguments: arguments
        )
    }
}

struct GroupPresentationPolicy: Sendable {
    let membershipRole: String?
    let availableActions: Set<String>

    init(membershipRole: String?, availableActions: [String]) {
        self.membershipRole = membershipRole
        self.availableActions = Set(availableActions)
    }

    private var isManager: Bool {
        membershipRole == "owner" || membershipRole == "admin" || availableActions.contains("manage")
    }

    var canManageAnnouncements: Bool { isManager }
    var canManageMembers: Bool { isManager }
    var canModerateDiscussion: Bool { isManager }
    var canPurchaseCapacity: Bool { availableActions.contains("purchaseCapacity") }
    var canTransferOwnership: Bool { availableActions.contains("transferGroup") }
    var canDissolve: Bool { availableActions.contains("dissolveGroup") }
}

enum GroupJoinReadiness: Equatable, Sendable {
    case inviteRequired
    case ready(inviteCode: String?)

    init(mode: GroupJoinMode, rawInviteCode: String) {
        let code = rawInviteCode.trimmingCharacters(in: .whitespacesAndNewlines)
        if mode == .inviteOnly, code.isEmpty {
            self = .inviteRequired
        } else {
            self = .ready(inviteCode: code.isEmpty ? nil : code)
        }
    }
}

func groupCoverCategory(_ categoryId: String?) -> String {
    switch categoryId {
    case "outdoor": "outdoor"
    case "sports": "sports"
    case "family": "family"
    case "culture": "art-culture"
    case "language": "skill"
    case "technology": "career"
    default: categoryId ?? "community"
    }
}

/// Per-category brand accent so each community reads with its own color moment
/// (chip tints + cover wash) instead of an all-twilight palette.
func groupCategoryColor(_ categoryId: String?) -> Color {
    switch categoryId {
    case "outdoor", "sports": SpottColor.mint
    case "family": SpottColor.coral
    case "culture": SpottColor.amber
    case "technology", "language": SpottColor.twilight
    default: SpottColor.twilight
    }
}

func groupContentLocale() -> String {
    let language = Locale.preferredLanguages.first?.lowercased() ?? "en"
    if language.hasPrefix("zh") { return "zh-Hans" }
    if language.hasPrefix("ja") { return "ja" }
    return "en"
}

struct CommunityCard: View {
    @Environment(\.locale) private var locale
    let group: GroupSummary

    private var accent: Color { groupCategoryColor(group.categoryId) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            EventCoverView(
                url: group.coverURL,
                category: groupCoverCategory(group.categoryId),
                cornerRadius: 0
            )
            .frame(height: 148)
            .overlay(alignment: .bottom) {
                // Per-category color wash keeps the pills legible over the photo
                // and gives each community its own color identity.
                LinearGradient(
                    colors: [.clear, accent.opacity(0.45)],
                    startPoint: .center,
                    endPoint: .bottom
                )
                .allowsHitTesting(false)
            }
            .overlay(alignment: .topLeading) {
                GroupStatusPill(group: group)
                    .padding(10)
            }
            .overlay(alignment: .topTrailing) {
                GlassPill(
                    text: "\(group.memberCount)/\(group.capacity)",
                    systemImage: "person.2.fill"
                )
                .padding(10)
            }

            VStack(alignment: .leading, spacing: 10) {
                Text(verbatim: group.name)
                    .font(.headline)
                    .foregroundStyle(SpottColor.ink)
                    .lineLimit(2)
                if !group.description.isEmpty {
                    Text(verbatim: group.description)
                        .font(.footnote)
                        .foregroundStyle(SpottColor.muted)
                        .lineLimit(2)
                        .lineSpacing(2)
                }
                if !group.tags.isEmpty {
                    GroupTagRow(tags: Array(group.tags.prefix(4)), tint: accent)
                }

                GroupMemberProof(group: group, accent: accent)

                Label {
                    Text(verbatim: group.regionId)
                } icon: {
                    Image(systemName: "mappin.and.ellipse")
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(SpottColor.muted)
            }
            .padding(14)
        }
        .background(SpottColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous)
                .stroke(SpottColor.hairline)
        )
        .shadow(color: SpottColor.ink.opacity(0.055), radius: 20, y: 8)
        .contentShape(RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

struct GroupTagRow: View {
    let tags: [String]
    // Retained for call-site compatibility; tags now read as neutral metadata so
    // the category color stays reserved for the cover wash and member-proof meter
    // rather than being repeated on every chip.
    var tint: Color = SpottColor.muted

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 7) {
                ForEach(tags, id: \.self) { tag in
                    Text(verbatim: "#\(tag)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(SpottColor.muted)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 5)
                        .background(SpottColor.muted.opacity(0.10), in: Capsule())
                }
            }
        }
    }
}

/// Member social proof: a category-tinted capacity meter plus a member count and
/// remaining-seats line, so a community reads as "people are already here" at a
/// glance instead of a bare "5/50".
struct GroupMemberProof: View {
    @Environment(\.locale) private var locale
    let group: GroupSummary
    var accent: Color = SpottColor.twilight

    private var fill: Double {
        guard group.capacity > 0 else { return 0 }
        return min(1, max(0.04, Double(group.memberCount) / Double(group.capacity)))
    }

    private var seatsLeft: Int { max(0, group.capacity - group.memberCount) }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 6) {
                Image(systemName: "person.2.fill")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(accent)
                Text(verbatim: GroupsLocalization.format(
                    "groups.social.members",
                    locale: locale,
                    group.memberCount
                ))
                .font(.caption.weight(.bold))
                .foregroundStyle(SpottColor.ink)
                Spacer(minLength: 6)
                Text(verbatim: seatsLeft > 0
                    ? GroupsLocalization.format("groups.social.seats_left", locale: locale, seatsLeft)
                    : GroupsLocalization.text("groups.social.full", locale: locale))
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(seatsLeft > 0 ? SpottColor.muted : accent)
            }
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(accent.opacity(0.14))
                    Capsule()
                        .fill(accent)
                        .frame(width: max(6, proxy.size.width * fill))
                }
            }
            .frame(height: 5)
        }
        .accessibilityElement(children: .combine)
    }
}

struct GroupStatusPill: View {
    @Environment(\.locale) private var locale
    let group: GroupSummary

    var body: some View {
        GlassPill(text: title, systemImage: symbol, tint: color)
    }

    private var title: String {
        GroupsLocalization.text(key, locale: locale)
    }

    private var symbol: String {
        if group.status == "closing" { return "hourglass" }
        if group.membershipStatus == "pending" { return "clock.fill" }
        if group.membershipStatus != nil { return "checkmark.circle.fill" }
        if group.memberCount >= group.capacity { return "person.2.slash" }
        switch group.joinMode {
        case .open: return "sparkles"
        case .approval: return "hand.raised.fill"
        case .inviteOnly: return "envelope.fill"
        }
    }

    private var key: String.LocalizationValue {
        if group.status == "closing" { return "groups.status.closing" }
        if group.membershipStatus == "pending" { return "groups.status.pending" }
        if group.membershipStatus == "active" || group.membershipStatus == "muted" { return "groups.status.joined" }
        if group.memberCount >= group.capacity { return "groups.status.full" }
        switch group.joinMode {
        case .open: return "groups.status.open"
        case .approval: return "groups.status.approval"
        case .inviteOnly: return "groups.status.invite"
        }
    }

    private var color: Color {
        if group.status == "closing" { return SpottColor.danger }
        if group.membershipStatus == "pending" { return SpottColor.amber }
        if group.membershipStatus != nil { return SpottColor.mint }
        return group.memberCount >= group.capacity ? SpottColor.amber : SpottColor.twilight
    }
}

struct GroupRolePill: View {
    @Environment(\.locale) private var locale
    let role: String

    var body: some View {
        Text(verbatim: memberRoleTitle(role, locale: locale))
            .font(.caption2.weight(.bold))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(color.opacity(0.12), in: Capsule())
    }

    private var color: Color {
        switch role {
        case "owner": SpottColor.amber
        case "admin": SpottColor.twilight
        default: SpottColor.muted
        }
    }
}

struct GroupContentCard<Content: View>: View {
    let tint: Color?
    @ViewBuilder let content: Content

    init(tint: Color? = nil, @ViewBuilder content: () -> Content) {
        self.tint = tint
        self.content = content()
    }

    var body: some View {
        content
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tint ?? SpottColor.surface)
            .clipShape(RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous)
                    .stroke(SpottColor.hairline)
            )
    }
}

struct GroupErrorBanner: View {
    @Environment(\.locale) private var locale
    let error: UserFacingError
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(SpottColor.danger)
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: error.message)
                    .font(.subheadline.weight(.semibold))
                Text(verbatim: GroupsLocalization.format("groups.common.error_code", locale: locale, error.id))
                    .font(.caption.monospaced())
                    .foregroundStyle(SpottColor.muted)
            }
            Spacer()
            Button(action: dismiss) {
                Image(systemName: "xmark")
                    .foregroundStyle(SpottColor.muted)
                    .frame(width: 44, height: 44, alignment: .topTrailing)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(verbatim: GroupsLocalization.text("groups.common.dismiss", locale: locale)))
        }
        .padding(14)
        .background(SpottColor.coralPale.opacity(0.54), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(SpottColor.danger.opacity(0.16)))
    }
}

func joinModeTitle(_ mode: GroupJoinMode, locale: Locale) -> String {
    switch mode {
    case .open: GroupsLocalization.text("groups.join_mode.open", locale: locale)
    case .approval: GroupsLocalization.text("groups.join_mode.approval", locale: locale)
    case .inviteOnly: GroupsLocalization.text("groups.join_mode.invite", locale: locale)
    }
}

func memberRoleTitle(_ role: String, locale: Locale) -> String {
    switch role {
    case "owner": GroupsLocalization.text("groups.role.owner", locale: locale)
    case "admin": GroupsLocalization.text("groups.role.admin", locale: locale)
    default: GroupsLocalization.text("groups.role.member", locale: locale)
    }
}

func memberStatusTitle(_ status: String, locale: Locale) -> String {
    switch status {
    case "pending": GroupsLocalization.text("groups.member_status.pending", locale: locale)
    case "active": GroupsLocalization.text("groups.member_status.active", locale: locale)
    case "muted": GroupsLocalization.text("groups.member_status.muted", locale: locale)
    case "removed": GroupsLocalization.text("groups.member_status.removed", locale: locale)
    default: status
    }
}
