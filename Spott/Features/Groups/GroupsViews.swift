import PhotosUI
import SwiftUI
import UIKit

enum GroupDirectoryScope: String, CaseIterable, Identifiable, Sendable {
    case discover
    case mine

    var id: String { rawValue }
    var requiresAuthentication: Bool { self == .mine }
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

struct GroupsHomeView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.locale) private var locale
    @State private var groups: [GroupSummary] = []
    @State private var scope = GroupDirectoryScope.discover
    @State private var query = ""
    @State private var loading = false
    @State private var error: UserFacingError?
    @State private var sheet: GroupHomeSheet?

    private var copy: GroupCommunityCopy { GroupCommunityCopy(locale: locale) }
    private var usesVerticalActions: Bool {
        GroupCommunityLayout.usesVerticalActions(for: dynamicTypeSize)
    }
    private var displayAccommodations: GroupCommunityDisplayAccommodations {
        GroupCommunityDisplayAccommodations(
            systemReduceTransparency: reduceTransparency,
            systemIncreasedContrast: colorSchemeContrast == .increased
        )
    }

    var body: some View {
        ZStack {
            GroupCommunityBackdrop(accommodations: displayAccommodations)

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    header
                    controls
                    content
                    if model.session == nil {
                        signedOutCard
                    }
                }
                .padding(.horizontal, SpottMetric.pageInset)
                .padding(.top, 14)
                .padding(.bottom, 36)
            }
            .safeAreaPadding(.top, 8)
        }
        .toolbar(.hidden, for: .navigationBar)
        .task(id: loadID) {
            if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                try? await Task.sleep(for: .milliseconds(250))
            }
            guard !Task.isCancelled else { return }
            await load()
        }
        .refreshable { await load() }
        .onChange(of: model.session?.sessionId) { _, sessionID in
            if sessionID == nil, scope.requiresAuthentication {
                scope = .discover
            }
        }
        .sheet(item: $sheet) { destination in
            switch destination {
            case .create:
                CreateGroupView { group in
                    query = ""
                    scope = .mine
                    groups = [group]
                    Task { await load() }
                }
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(copy.text("找到你的社群"))
                .font(.system(.largeTitle, design: .rounded, weight: .bold))
                .fontDesign(.rounded)
                .foregroundStyle(SpottColor.ink)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("community.header.title")
            Text(copy.text("找到同好，也找到下一次见面的理由。"))
                .font(.body)
                .fontDesign(.rounded)
                .foregroundStyle(SpottColor.muted)
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("community.header.subtitle")
        }
        .padding(.top, 2)
    }

    private var controls: some View {
        VStack(spacing: 12) {
            scopeControlPanel

            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(SpottColor.twilightDeep)
                    .accessibilityHidden(true)
                TextField(
                    copy.text("搜索社群名称、兴趣或地区"),
                    text: $query,
                    prompt: Text(copy.text("搜索社群名称、兴趣或地区"))
                        .foregroundStyle(SpottColor.muted)
                )
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityLabel(copy.text("搜索社群名称、兴趣或地区"))
                .accessibilityIdentifier("community.search")
                if !query.isEmpty {
                    Button {
                        query = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(SpottColor.muted)
                            .frame(
                                minWidth: GroupCommunityLayout.minimumTouchTarget,
                                minHeight: GroupCommunityLayout.minimumTouchTarget
                            )
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(copy.text("清除搜索"))
                }
            }
            .padding(.leading, 17)
            .padding(.trailing, query.isEmpty ? 17 : 4)
            .frame(minHeight: 56)
            .background(
                SpottColor.surface,
                in: RoundedRectangle(cornerRadius: SpottMetric.controlRadius, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: SpottMetric.controlRadius, style: .continuous)
                    .stroke(
                        displayAccommodations.increasedContrast
                            ? SpottColor.ink.opacity(0.42)
                            : SpottColor.ink.opacity(0.10),
                        lineWidth: displayAccommodations.increasedContrast ? 1.5 : 1
                    )
            }
            .shadow(
                color: displayAccommodations.reduceTransparency
                    ? .clear
                    : SpottColor.ink.opacity(0.045),
                radius: 12,
                y: 5
            )
        }
    }

    @ViewBuilder
    private var content: some View {
        if loading, groups.isEmpty {
            GroupSkeleton()
            GroupSkeleton()
        } else if let error, groups.isEmpty {
            SpottStateCard(
                icon: "wifi.exclamationmark",
                title: copy.text("暂时无法加载社群"),
                message: String(
                    format: copy.text("%@\n错误编号：%@"),
                    locale: locale,
                    error.message,
                    error.id
                ),
                actionTitle: copy.text("重新连接")
            ) {
                Task { await load() }
            }
        } else if groups.isEmpty {
            SpottStateCard(
                icon: query.isEmpty ? "person.3" : "magnifyingglass",
                title: emptyTitle,
                message: emptyMessage,
                actionTitle: scope == .mine ? copy.text("发现公开社群") : nil
            ) {
                scope = .discover
            }
        } else {
            if let error {
                GroupErrorBanner(error: error) {
                    self.error = nil
                }
            }
            LazyVStack(spacing: 16) {
                ForEach(groups) { group in
                    NavigationLink {
                        GroupDetailView(groupID: group.id)
                    } label: {
                        CommunityCard(
                            group: group,
                            increasedContrast: displayAccommodations.increasedContrast
                        )
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint(copy.text("查看社群详情"))
                }
            }
        }
    }

    private var signedOutCard: some View {
        GroupContentCard {
            if usesVerticalActions {
                VStack(alignment: .leading, spacing: 14) {
                    signedOutIcon
                    signedOutCopy
                }
            } else {
                HStack(alignment: .top, spacing: 15) {
                    signedOutIcon
                    signedOutCopy
                }
            }
        }
    }

    private var signedOutIcon: some View {
        Image(systemName: "person.3.sequence.fill")
            .font(.system(size: 24, weight: .medium))
            .foregroundStyle(SpottColor.twilight)
            .frame(width: 48, height: 48)
            .background(SpottColor.twilightPale, in: Circle())
            .accessibilityHidden(true)
    }

    private var signedOutCopy: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(copy.text("无需登录也能浏览公开社群"))
                .font(.headline.weight(.bold))
            Text(copy.text("登录后可以加入、关注、评论，并在 iOS 与 Web 实时同步。"))
                .font(.subheadline)
                .foregroundStyle(SpottColor.muted)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("community.signed-out.message")
            Button {
                model.presentedGate = .login
            } label: {
                Text(copy.signInTitle)
                    .font(.headline.weight(.semibold))
                    .frame(
                        maxWidth: usesVerticalActions ? .infinity : nil,
                        minHeight: GroupCommunityLayout.minimumTouchTarget
                    )
            }
            .spottProminentActionStyle()
            .accessibilityIdentifier("community.sign-in")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var loadID: String {
        "\(scope.rawValue)|\(query)|\(model.session?.sessionId.uuidString ?? "guest")"
    }

    private var emptyTitle: String {
        if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return copy.text("没有找到匹配的社群")
        }
        return scope == .mine ? copy.text("还没有加入社群") : copy.text("暂时没有公开社群")
    }

    private var emptyMessage: String {
        if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return copy.text("试试更短的关键词，或搜索兴趣标签与地区。")
        }
        return scope == .mine
            ? copy.text("从一个感兴趣的社群开始，或创建属于你的长期社区。")
            : copy.text("新的公开社群出现后会展示在这里。")
    }

    private func select(_ item: GroupDirectoryScope) {
        guard !item.requiresAuthentication || model.session != nil else {
            model.presentedGate = .login
            return
        }
        scope = item
    }

    private func load() async {
#if DEBUG
        if GroupCommunityUITestFixture.isEnabled {
            loading = false
            error = nil
            groups = GroupCommunityUITestFixture.localizedDemoGroups(locale: locale)
            return
        }
#endif
        if scope.requiresAuthentication, model.session == nil {
            scope = .discover
            return
        }
        loading = true
        error = nil
        defer { loading = false }
        do {
            let page: GroupPage
            if scope == .mine {
                page = try await model.api.groups()
            } else {
                page = try await model.api.discoverGroups(
                    region: model.region,
                    query: query.trimmed.nilIfEmpty
                )
            }
            guard !Task.isCancelled else { return }
            if scope == .mine, !query.trimmed.isEmpty {
                let needle = query.trimmed.folding(
                    options: [.caseInsensitive, .diacriticInsensitive],
                    locale: .current
                )
                groups = page.items.filter { group in
                    ([group.name, group.description, group.regionId] + group.tags)
                        .contains { $0.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current).contains(needle) }
                }
            } else {
                groups = page.items
            }
        } catch is CancellationError {
            return
        } catch {
            self.error = AppModel.map(error)
        }
    }

    @ViewBuilder
    private var scopeControlPanel: some View {
        if usesVerticalActions {
            VStack(spacing: 8) {
                ForEach(GroupDirectoryScope.allCases) { item in
                    scopeButton(item)
                }
                if model.session != nil {
                    createGroupButton(expanded: true)
                }
            }
            .padding(6)
            .groupAdaptiveControlSurface(
                shape: RoundedRectangle(cornerRadius: SpottMetric.controlRadius, style: .continuous),
                reduceTransparency: displayAccommodations.reduceTransparency,
                increasedContrast: displayAccommodations.increasedContrast
            )
        } else {
            HStack(spacing: 8) {
                ForEach(GroupDirectoryScope.allCases) { item in
                    scopeButton(item)
                }
                if model.session != nil {
                    createGroupButton(expanded: false)
                }
            }
            .padding(5)
            .groupAdaptiveControlSurface(
                shape: Capsule(),
                reduceTransparency: displayAccommodations.reduceTransparency,
                increasedContrast: displayAccommodations.increasedContrast
            )
        }
    }

    private func scopeButton(_ item: GroupDirectoryScope) -> some View {
        let isSelected = scope == item
        let colors = GroupCommunityControlPalette.scope(
            isSelected: isSelected,
            increasedContrast: displayAccommodations.increasedContrast
        )

        return Button {
            select(item)
        } label: {
            Label(copy.scopeTitle(item), systemImage: item == .discover ? "sparkles" : "person.2.fill")
                .font(.subheadline.weight(.semibold))
                .lineLimit(2)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity)
                .foregroundStyle(colors.foreground)
        }
        .buttonStyle(.plain)
        .frame(
            maxWidth: .infinity,
            minHeight: GroupCommunityLayout.minimumTouchTarget
        )
        .background(
            colors.background,
            in: Capsule()
        )
        .overlay {
            if isSelected {
                Capsule()
                    .stroke(
                        displayAccommodations.increasedContrast
                            ? SpottColor.canvas.opacity(0.72)
                            : SpottColor.twilight.opacity(0.18),
                        lineWidth: displayAccommodations.increasedContrast ? 1.5 : 1
                    )
            }
        }
        .contentShape(Capsule())
        .accessibilityLabel(copy.scopeTitle(item))
        .accessibilityIdentifier("community.scope.\(item.rawValue)")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityRemoveTraits(isSelected ? [] : .isSelected)
    }

    @ViewBuilder
    private func createGroupButton(expanded: Bool) -> some View {
        Button {
            model.requireTrust(for: .joinGroup) { sheet = .create }
        } label: {
            if expanded {
                Label(copy.text("创建社群"), systemImage: "plus")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(.white)
                    .frame(
                        maxWidth: .infinity,
                        minHeight: GroupCommunityLayout.minimumTouchTarget
                    )
                    .background(SpottColor.twilight, in: Capsule())
            } else {
                Image(systemName: "plus")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(
                        width: GroupCommunityLayout.minimumTouchTarget,
                        height: GroupCommunityLayout.minimumTouchTarget
                    )
                    .background(SpottColor.twilight, in: Circle())
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(copy.text("创建社群"))
    }
}

private enum GroupHomeSheet: String, Identifiable {
    case create
    var id: String { rawValue }
}

private struct CommunityCard: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.locale) private var locale
    let group: GroupSummary
    var increasedContrast = false

    private var copy: GroupCommunityCopy { GroupCommunityCopy(locale: locale) }
    private var usesVerticalMetadata: Bool {
        GroupCommunityLayout.usesVerticalCardMetadata(for: dynamicTypeSize)
    }
    private var usesVerticalTags: Bool {
        GroupCommunityLayout.usesVerticalCardTags(for: dynamicTypeSize)
    }

    var body: some View {
        cardContent
            .background(SpottColor.surface)
            .clipShape(cardShape)
            .overlay(
                cardShape.stroke(
                    increasedContrast
                        ? SpottColor.ink.opacity(0.44)
                        : SpottColor.ink.opacity(0.10),
                    lineWidth: increasedContrast ? 1.5 : 1
                )
            )
            .shadow(color: SpottColor.ink.opacity(0.09), radius: 22, y: 10)
            .contentShape(cardShape)
    }

    private var cardShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous)
    }

    private var cardContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            artwork

            VStack(alignment: .leading, spacing: 14) {
                Text(verbatim: group.name)
                    .font(.system(.title2, design: .rounded, weight: .bold))
                    .foregroundStyle(SpottColor.ink)
                    .lineLimit(usesVerticalMetadata ? nil : 2)
                    .fixedSize(horizontal: false, vertical: true)

                if !group.description.isEmpty {
                    Text(verbatim: group.description)
                        .font(.body)
                        .fontDesign(.rounded)
                        .foregroundStyle(SpottColor.muted)
                        .lineLimit(usesVerticalMetadata ? nil : 3)
                        .lineSpacing(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !group.tags.isEmpty {
                    if usesVerticalTags {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(group.tags.prefix(4), id: \.self) { tag in
                                tagPill(tag)
                            }
                        }
                        .accessibilityElement(children: .contain)
                    } else {
                        ViewThatFits(in: .horizontal) {
                            HStack(spacing: 7) {
                                ForEach(group.tags.prefix(4), id: \.self) { tag in
                                    tagPill(tag)
                                }
                            }
                            VStack(alignment: .leading, spacing: 8) {
                                ForEach(group.tags.prefix(4), id: \.self) { tag in
                                    tagPill(tag)
                                }
                            }
                        }
                        .accessibilityElement(children: .contain)
                    }
                }

                Divider()
                    .overlay(SpottColor.divider)

                metadata
            }
            .padding(18)
        }
    }

    private var artwork: some View {
        ZStack(alignment: .bottomLeading) {
            LinearGradient(
                colors: palette,
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )

            Circle()
                .stroke(Color.white.opacity(0.24), lineWidth: 1.5)
                .frame(width: 250, height: 250)
                .offset(x: 154, y: -78)
            Circle()
                .stroke(Color.white.opacity(0.16), lineWidth: 1)
                .frame(width: 176, height: 176)
                .offset(x: 94, y: 54)
            RoundedRectangle(cornerRadius: 64, style: .continuous)
                .stroke(Color.white.opacity(0.18), lineWidth: 1.5)
                .frame(width: 290, height: 96)
                .rotationEffect(.degrees(-16))
                .offset(x: 46, y: -18)

            Image(systemName: groupSymbol)
                .font(.system(size: 31, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 62, height: 62)
                .background(Color.black.opacity(0.13), in: RoundedRectangle(cornerRadius: 19, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 19, style: .continuous)
                        .stroke(Color.white.opacity(0.28), lineWidth: 1)
                }
                .padding(18)
        }
        .frame(
            maxWidth: .infinity,
            minHeight: GroupCommunityLayout.cardCoverMinimumHeight(for: dynamicTypeSize),
            maxHeight: GroupCommunityLayout.cardCoverMinimumHeight(for: dynamicTypeSize),
            alignment: .bottomLeading
        )
        .clipped()
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private var metadata: some View {
        if usesVerticalMetadata {
            VStack(alignment: .leading, spacing: 10) {
                memberCountLabel
                regionLabel
                GroupStatusPill(group: group)
            }
        } else {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) {
                    memberCountLabel
                    regionLabel
                    Spacer(minLength: 0)
                    GroupStatusPill(group: group)
                }
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 16) {
                        memberCountLabel
                        regionLabel
                    }
                    GroupStatusPill(group: group)
                }
            }
        }
    }

    private var memberCountLabel: some View {
        Label("\(group.memberCount) / \(group.capacity)", systemImage: "person.2")
            .font(.subheadline.weight(.semibold))
            .fontDesign(.rounded)
            .foregroundStyle(SpottColor.muted)
    }

    private var regionLabel: some View {
        Label {
            Text(copy.regionName(group.regionId))
                .accessibilityIdentifier("community.fixture.region")
        } icon: {
            Image(systemName: "mappin")
        }
        .font(.subheadline.weight(.semibold))
        .fontDesign(.rounded)
        .foregroundStyle(SpottColor.muted)
    }

    private func tagPill(_ tag: String) -> some View {
        let colors = GroupCommunityControlPalette.tag(
            increasedContrast: increasedContrast
        )

        return Text(verbatim: "#\(tag)")
            .font(.caption.weight(.semibold))
            .foregroundStyle(colors.foreground)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(colors.background, in: Capsule())
            .overlay {
                if increasedContrast {
                    Capsule()
                        .stroke(SpottColor.canvas.opacity(0.72), lineWidth: 1.5)
                }
            }
            .accessibilityIdentifier("community.fixture.tag.\(tag)")
    }

    private var palette: [Color] {
        switch group.categoryId {
        case "outdoor", "sports":
            [SpottColor.twilightDeep, SpottColor.twilight, SpottColor.mint]
        case "family", "culture":
            [SpottColor.coral, SpottColor.twilight, SpottColor.twilightDeep]
        default:
            [SpottColor.twilightDeep, SpottColor.coral, SpottColor.amber]
        }
    }

    private var groupSymbol: String {
        switch group.categoryId {
        case "outdoor": "figure.hiking"
        case "sports": "figure.run"
        case "family": "figure.2.and.child.holdinghands"
        case "language": "character.bubble"
        case "technology": "laptopcomputer"
        case "culture": "theatermasks"
        default: "person.3.fill"
        }
    }
}

private struct GroupStatusPill: View {
    @Environment(\.locale) private var locale
    let group: GroupSummary

    private var copy: GroupCommunityCopy { GroupCommunityCopy(locale: locale) }

    var body: some View {
        Label(title, systemImage: symbol)
            .font(.caption.weight(.bold))
            .foregroundStyle(color)
            .padding(.horizontal, 11)
            .frame(minHeight: 36)
            .background(color.opacity(0.14), in: Capsule())
            .overlay(Capsule().stroke(color.opacity(0.18), lineWidth: 1))
            .accessibilityIdentifier("community.fixture.status")
    }

    private var title: String {
        copy.statusTitle(
            groupStatus: group.status,
            membershipStatus: group.membershipStatus,
            memberCount: group.memberCount,
            capacity: group.capacity,
            joinMode: group.joinMode
        )
    }

    private var color: Color {
        if group.status == "closing" { return SpottColor.danger }
        if group.membershipStatus == "pending" { return SpottColor.amber }
        if group.membershipStatus != nil { return SpottColor.mint }
        return group.memberCount >= group.capacity ? SpottColor.amber : SpottColor.twilight
    }

    private var symbol: String {
        if group.status == "closing" { return "exclamationmark.triangle.fill" }
        if group.membershipStatus == "pending" { return "clock.fill" }
        if group.membershipStatus != nil { return "checkmark.circle.fill" }
        if group.memberCount >= group.capacity { return "person.2.slash" }
        return group.joinMode == .approval ? "person.badge.clock" : "person.badge.plus"
    }
}

struct GroupDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.locale) private var locale
    let groupID: UUID
    @State private var group: GroupSummary?
    @State private var announcements: [GroupAnnouncement] = []
    @State private var loading = true
    @State private var mutating = false
    @State private var error: UserFacingError?
    @State private var sheet: GroupDetailSheet?

    private var copy: GroupCommunityCopy { GroupCommunityCopy(locale: locale) }
    private var usesVerticalActions: Bool {
        GroupCommunityLayout.usesVerticalActions(for: dynamicTypeSize)
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                if loading, group == nil {
                    ProgressView()
                        .controlSize(.large)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 110)
                } else if let group {
                    hero(group)
                    if group.status == "closing" {
                        dissolutionBanner(group)
                    }
                    about(group)
                    announcementsSection(group)
                    if let error {
                        GroupErrorBanner(error: error) { self.error = nil }
                    }
                } else {
                    SpottStateCard(
                        icon: "person.3",
                        title: copy.text("社群不可用"),
                        message: error?.message ?? copy.text("社群已关闭或暂时不可见。"),
                        actionTitle: copy.text("重新加载")
                    ) {
                        Task { await loadAll() }
                    }
                }
            }
            .padding(.horizontal, SpottMetric.pageInset)
            .padding(.top, 12)
            .padding(.bottom, 40)
        }
        .background(SpottColor.canvas.ignoresSafeArea())
        .navigationTitle(group?.name ?? copy.text("社群"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let group {
                ToolbarItem(placement: .topBarTrailing) {
                    managementMenu(group)
                }
            }
        }
        .task(id: model.session?.sessionId) { await loadAll() }
        .onChange(of: model.groupMutationRevision) { _, _ in
            Task { await loadAll() }
        }
        .refreshable { await loadAll() }
        .sheet(item: $sheet) { destination in
            switch destination {
            case .join(let group):
                JoinGroupView(group: group) {
                    await loadAll()
                }
            case .announcementEditor(let group, let announcement):
                GroupAnnouncementEditor(group: group, announcement: announcement) {
                    await loadAnnouncements()
                }
            case .members(let group):
                GroupMembersView(group: group)
            case .invite(let group):
                GroupInviteView(group: group)
            case .capacity(let group):
                GroupCapacityView(group: group) { updated in
                    self.group = updated
                }
            case .cover(let group):
                GroupCoverEditor(group: group) {
                    await loadAll()
                }
            case .transfer(let group):
                GroupTransferView(group: group) {
                    await loadAll()
                }
            case .dissolution(let group):
                GroupDissolutionView(group: group) {
                    await loadAll()
                }
            }
        }
    }

    private func hero(_ group: GroupSummary) -> some View {
        VStack(alignment: .leading, spacing: 17) {
            if let coverURL = group.coverURL {
                AsyncImage(url: coverURL) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    ZStack {
                        SpottColor.twilightPale
                        ProgressView()
                    }
                }
                .frame(maxWidth: .infinity)
                .frame(height: 150)
                .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 20).stroke(Color.white.opacity(0.82)))
            }
            if usesVerticalActions {
                VStack(alignment: .leading, spacing: 12) {
                    heroIcon
                    heroCapacity(group, alignment: .leading)
                }
            } else {
                HStack(alignment: .top, spacing: 12) {
                    heroIcon
                    Spacer()
                    heroCapacity(group, alignment: .trailing)
                }
            }
            VStack(alignment: .leading, spacing: 7) {
                Text(verbatim: group.name)
                    .font(.title.weight(.bold))
                    .fontDesign(.rounded)
                    .foregroundStyle(SpottColor.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Label {
                    Text(verbatim: "\(group.owner.name) · \(copy.regionName(group.regionId))")
                } icon: {
                    Image(systemName: "person.crop.circle")
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(SpottColor.muted)
            }
            groupActions(group)
        }
        .padding(20)
        .background(
            LinearGradient(
                colors: [
                    SpottColor.twilightPale,
                    SpottColor.coralPale.opacity(0.72),
                    Color(red: 0.89, green: 0.97, blue: 0.93)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ),
            in: RoundedRectangle(cornerRadius: SpottMetric.coverRadius, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: SpottMetric.coverRadius, style: .continuous)
                .stroke(Color.white.opacity(0.92), lineWidth: 1)
        )
        .shadow(color: SpottColor.ink.opacity(0.07), radius: 20, y: 9)
    }

    private var heroIcon: some View {
        Image(systemName: "person.3.fill")
            .font(.title2.weight(.semibold))
            .foregroundStyle(SpottColor.twilightDeep)
            .frame(
                minWidth: GroupCommunityLayout.minimumTouchTarget,
                minHeight: GroupCommunityLayout.minimumTouchTarget
            )
            .padding(5)
            .background(Color.white.opacity(0.68), in: Circle())
            .overlay(Circle().stroke(Color.white.opacity(0.9)))
            .accessibilityHidden(true)
    }

    private func heroCapacity(
        _ group: GroupSummary,
        alignment: HorizontalAlignment
    ) -> some View {
        VStack(alignment: alignment, spacing: 6) {
            Text("\(group.memberCount) / \(group.capacity)")
                .font(.caption.monospaced().weight(.bold))
                .foregroundStyle(SpottColor.ink)
            GroupStatusPill(group: group)
        }
    }

    @ViewBuilder
    private func about(_ group: GroupSummary) -> some View {
        if !group.description.isEmpty || !group.rules.isEmpty || !group.tags.isEmpty {
            GroupContentCard {
                VStack(alignment: .leading, spacing: 15) {
                    Label("关于社群", systemImage: "info.circle")
                        .font(.headline.weight(.bold))
                        .fontDesign(.rounded)
                    if !group.description.isEmpty {
                        Text(verbatim: group.description)
                            .font(.body)
                            .foregroundStyle(SpottColor.ink)
                            .lineSpacing(5)
                    }
                    if !group.tags.isEmpty {
                        FlowTagRow(tags: group.tags)
                    }
                    if !group.rules.isEmpty {
                        Divider()
                        VStack(alignment: .leading, spacing: 6) {
                            Text("社群规则")
                                .font(.subheadline.weight(.bold))
                            Text(verbatim: group.rules)
                                .font(.subheadline)
                                .foregroundStyle(SpottColor.muted)
                                .lineSpacing(4)
                        }
                    }
                }
            }
        }
    }

    private func announcementsSection(_ group: GroupSummary) -> some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack {
                Label("公告", systemImage: "megaphone.fill")
                    .font(.title3.weight(.bold))
                    .fontDesign(.rounded)
                Spacer()
                Text("\(announcements.count) 条")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(SpottColor.muted)
                if policy(group).canManageAnnouncements {
                    Button {
                        sheet = .announcementEditor(group, nil)
                    } label: {
                        Image(systemName: "square.and.pencil")
                            .font(.system(size: 14, weight: .bold))
                            .frame(
                                width: GroupCommunityLayout.minimumTouchTarget,
                                height: GroupCommunityLayout.minimumTouchTarget
                            )
                            .spottGlassPanel(shape: Circle(), tint: SpottColor.twilightPale)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("发布公告")
                }
            }
            if announcements.isEmpty {
                GroupContentCard {
                    HStack(spacing: 13) {
                        Image(systemName: "megaphone")
                            .font(.system(size: 22))
                            .foregroundStyle(SpottColor.muted)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("还没有公告")
                                .font(.subheadline.weight(.bold))
                            Text(copy.text(
                                policy(group).canManageAnnouncements
                                    ? "发布第一条公告，让成员看到最新安排。"
                                    : "管理员发布更新后会展示在这里。"
                            ))
                                .font(.caption)
                                .foregroundStyle(SpottColor.muted)
                        }
                    }
                }
            } else {
                ForEach(announcements) { announcement in
                    GroupAnnouncementCard(
                        group: group,
                        announcement: announcement,
                        canManage: policy(group).canManageAnnouncements,
                        onEdit: { sheet = .announcementEditor(group, announcement) },
                        onRefresh: { await loadAnnouncements() }
                    )
                }
            }
        }
    }

    private func dissolutionBanner(_ group: GroupSummary) -> some View {
        GroupContentCard(tint: SpottColor.coralPale.opacity(0.62)) {
            HStack(alignment: .top, spacing: 13) {
                Image(systemName: "hourglass")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(SpottColor.danger)
                VStack(alignment: .leading, spacing: 5) {
                    Text("社群处于 7 天解散通知期")
                        .font(.subheadline.weight(.bold))
                    if let date = group.dissolveAfter {
                        Text("计划解散时间：\(date.formatted(date: .abbreviated, time: .shortened))")
                            .font(.caption)
                            .foregroundStyle(SpottColor.muted)
                    }
                    if policy(group).canDissolve {
                        Button("查看或撤销解散") {
                            sheet = .dissolution(group)
                        }
                        .font(.caption.weight(.semibold))
                    }
                }
            }
        }
    }

    private func followButton(_ group: GroupSummary) -> some View {
        Button {
            setFollow(group)
        } label: {
            Label(
                copy.text(group.viewerFollowing ? "已关注" : "关注"),
                systemImage: group.viewerFollowing ? "star.fill" : "star"
            )
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(group.viewerFollowing ? SpottColor.twilightDeep : SpottColor.ink)
            .frame(
                maxWidth: .infinity,
                minHeight: GroupCommunityLayout.minimumTouchTarget
            )
            .spottGlassPanel(shape: Capsule(), tint: group.viewerFollowing ? SpottColor.twilightPale : nil)
        }
        .buttonStyle(.plain)
        .disabled(mutating)
    }

    private func joinButton(_ group: GroupSummary) -> some View {
        Button {
            if group.joinMode == .inviteOnly {
                sheet = .join(group)
            } else {
                performJoin(group, inviteCode: nil)
            }
        } label: {
            Label(copy.joinTitle(group.joinMode), systemImage: "person.badge.plus")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(.white)
                .frame(
                    maxWidth: .infinity,
                    minHeight: GroupCommunityLayout.minimumTouchTarget
                )
                .background(SpottColor.twilight, in: Capsule())
                .shadow(color: SpottColor.twilight.opacity(0.2), radius: 10, y: 5)
        }
        .buttonStyle(.plain)
        .disabled(mutating)
    }

    @ViewBuilder
    private func managementMenu(_ group: GroupSummary) -> some View {
        let policy = policy(group)
        if policy.canManageAnnouncements || policy.canManageMembers || policy.canPurchaseCapacity || policy.canTransferOwnership || policy.canDissolve {
            Menu {
                if policy.canManageAnnouncements {
                    Button("发布公告", systemImage: "megaphone") {
                        sheet = .announcementEditor(group, nil)
                    }
                }
                if policy.canManageMembers {
                    Button("成员管理", systemImage: "person.2.badge.gearshape") {
                        sheet = .members(group)
                    }
                    Button("生成邀请", systemImage: "link.badge.plus") {
                        sheet = .invite(group)
                    }
                }
                if policy.canPurchaseCapacity {
                    Divider()
                    Button("社群扩容", systemImage: "person.3.fill") {
                        sheet = .capacity(group)
                    }
                }
                if policy.canTransferOwnership {
                    Button("更换社群封面", systemImage: "photo") {
                        sheet = .cover(group)
                    }
                    Button("转让社群", systemImage: "arrow.left.arrow.right") {
                        sheet = .transfer(group)
                    }
                }
                if policy.canDissolve {
                    Divider()
                    Button(
                        copy.text(group.status == "closing" ? "查看解散计划" : "申请解散"),
                        systemImage: "hourglass",
                        role: group.status == "closing" ? nil : .destructive
                    ) {
                        sheet = .dissolution(group)
                    }
                }
            } label: {
                Image(systemName: "ellipsis")
            }
            .accessibilityLabel("社群管理")
        }
    }

    @ViewBuilder
    private func groupActions(_ group: GroupSummary) -> some View {
        if usesVerticalActions {
            VStack(spacing: 9) {
                actionItems(group)
            }
        } else {
            HStack(spacing: 9) {
                actionItems(group)
            }
        }
    }

    @ViewBuilder
    private func actionItems(_ group: GroupSummary) -> some View {
        followButton(group)
        if group.membershipStatus == nil, group.availableActions.contains("joinGroup") {
            joinButton(group)
        } else if let membershipStatus = group.membershipStatus {
            Label(
                copy.membershipTitle(membershipStatus),
                systemImage: membershipStatus == "pending" ? "clock.fill" : "checkmark.circle.fill"
            )
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(membershipStatus == "pending" ? SpottColor.amber : SpottColor.mint)
            .frame(
                maxWidth: .infinity,
                minHeight: GroupCommunityLayout.minimumTouchTarget
            )
            .background(Color.white.opacity(0.64), in: Capsule())
        }
    }

    private func policy(_ group: GroupSummary) -> GroupPresentationPolicy {
        GroupPresentationPolicy(
            membershipRole: group.membershipRole,
            availableActions: group.availableActions
        )
    }

    private func loadAll() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            async let loadedGroup = model.api.group(identifier: groupID.uuidString.lowercased())
            async let loadedAnnouncements = model.api.groupAnnouncements(id: groupID)
            let (group, page) = try await (loadedGroup, loadedAnnouncements)
            self.group = group
            announcements = page.items
        } catch is CancellationError {
            return
        } catch {
            self.error = AppModel.map(error)
        }
    }

    private func loadAnnouncements() async {
        do {
            announcements = try await model.api.groupAnnouncements(id: groupID).items
            group = try await model.api.group(identifier: groupID.uuidString.lowercased())
        } catch {
            self.error = AppModel.map(error)
        }
    }

    private func setFollow(_ group: GroupSummary) {
        guard model.session != nil else {
            model.presentedGate = .login
            return
        }
        mutating = true
        error = nil
        Task {
            defer { mutating = false }
            do {
                _ = try await model.api.setGroupFollow(id: group.id, following: !group.viewerFollowing)
                self.group = try await model.api.group(identifier: group.id.uuidString.lowercased())
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }

    private func performJoin(_ group: GroupSummary, inviteCode: String?) {
        model.requireGroupJoinTrust(for: group, inviteCode: inviteCode) {
            mutating = true
            error = nil
            Task {
                defer { mutating = false }
                do {
                    _ = try await model.api.joinGroup(id: group.id, inviteCode: inviteCode)
                    await loadAll()
                } catch {
                    self.error = AppModel.map(error)
                }
            }
        }
    }
}

private enum GroupDetailSheet: Identifiable {
    case join(GroupSummary)
    case announcementEditor(GroupSummary, GroupAnnouncement?)
    case members(GroupSummary)
    case invite(GroupSummary)
    case capacity(GroupSummary)
    case cover(GroupSummary)
    case transfer(GroupSummary)
    case dissolution(GroupSummary)

    var id: String {
        switch self {
        case .join: "join"
        case .announcementEditor(_, let item): "announcement-\(item?.id.uuidString ?? "new")"
        case .members: "members"
        case .invite: "invite"
        case .capacity: "capacity"
        case .cover: "cover"
        case .transfer: "transfer"
        case .dissolution: "dissolution"
        }
    }
}

private struct GroupAnnouncementCard: View {
    @Environment(AppModel.self) private var model
    let group: GroupSummary
    let announcement: GroupAnnouncement
    let canManage: Bool
    let onEdit: () -> Void
    let onRefresh: () async -> Void
    @State private var busy = false
    @State private var deleteConfirmation = false
    @State private var error: UserFacingError?

    var body: some View {
        GroupContentCard {
            VStack(alignment: .leading, spacing: 13) {
                HStack(alignment: .top, spacing: 10) {
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 7) {
                            if announcement.pinnedAt != nil {
                                Label("置顶", systemImage: "pin.fill")
                                    .font(.caption2.weight(.bold))
                                    .foregroundStyle(SpottColor.coral)
                            }
                            Text(LocalizedStringKey(
                                announcement.visibility == "public" ? "公开" : "仅成员"
                            ))
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(SpottColor.muted)
                        }
                        Text(verbatim: announcement.title)
                            .font(.headline.weight(.bold))
                            .fontDesign(.rounded)
                            .foregroundStyle(SpottColor.ink)
                    }
                    Spacer()
                    if canManage {
                        Menu {
                            Button("编辑公告", systemImage: "pencil", action: onEdit)
                            Button("删除公告", systemImage: "trash", role: .destructive) {
                                deleteConfirmation = true
                            }
                        } label: {
                            Image(systemName: "ellipsis.circle")
                                .foregroundStyle(SpottColor.muted)
                        }
                    }
                }
                Text(verbatim: announcement.body)
                    .font(.subheadline)
                    .foregroundStyle(SpottColor.ink)
                    .lineLimit(5)
                    .lineSpacing(4)
                HStack {
                    Label {
                        Text(verbatim: announcement.authorName ?? "Spott")
                    } icon: {
                        Image(systemName: "person.crop.circle")
                    }
                    Spacer()
                    Text(announcement.createdAt.formatted(date: .abbreviated, time: .shortened))
                }
                .font(.caption)
                .foregroundStyle(SpottColor.muted)
                Divider()
                HStack(spacing: 18) {
                    Button {
                        setLiked()
                    } label: {
                        Label(
                            "\(announcement.likeCount)",
                            systemImage: announcement.viewerLiked ? "heart.fill" : "heart"
                        )
                        .foregroundStyle(announcement.viewerLiked ? SpottColor.coral : SpottColor.muted)
                    }
                    .buttonStyle(.plain)
                    .disabled(busy || !canReact)

                    NavigationLink {
                        GroupAnnouncementDetailView(
                            group: group,
                            initialAnnouncement: announcement,
                            canManage: canManage
                        ) {
                            await onRefresh()
                        }
                    } label: {
                        Label(
                            announcement.commentsEnabled ? "\(announcement.commentCount)" : "评论已关闭",
                            systemImage: announcement.commentsEnabled ? "bubble.left" : "bubble.left.slash"
                        )
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(SpottColor.muted)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.caption.bold())
                        .foregroundStyle(SpottColor.muted)
                }
                .font(.subheadline.weight(.semibold))
                if let error {
                    Text("\(error.message)（\(error.id)）")
                        .font(.caption)
                        .foregroundStyle(SpottColor.danger)
                }
            }
        }
        .confirmationDialog(
            "删除这条公告？",
            isPresented: $deleteConfirmation,
            titleVisibility: .visible
        ) {
            Button("删除公告", role: .destructive) { deleteAnnouncement() }
            Button("取消", role: .cancel) {}
        } message: {
            Text("删除后，成员将无法再查看公告及其评论。")
        }
    }

    private var canReact: Bool {
        group.membershipStatus == "active" || group.membershipStatus == "muted"
    }

    private func setLiked() {
        guard model.session != nil else {
            model.presentedGate = .login
            return
        }
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                _ = try await model.api.setGroupAnnouncementLiked(
                    groupID: group.id,
                    announcementID: announcement.id,
                    liked: !announcement.viewerLiked
                )
                await onRefresh()
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }

    private func deleteAnnouncement() {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                try await model.api.deleteGroupAnnouncement(
                    groupID: group.id,
                    announcementID: announcement.id
                )
                await onRefresh()
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }
}

private struct GroupAnnouncementDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale
    let group: GroupSummary
    let canManage: Bool
    let onAnnouncementChange: () async -> Void
    @State private var announcement: GroupAnnouncement
    @State private var comments: [GroupComment] = []
    @State private var draft = ""
    @State private var loading = true
    @State private var busy = false
    @State private var error: UserFacingError?
    @State private var editTarget: CommentEditTarget?
    @State private var editingAnnouncement = false
    @State private var deleteTarget: GroupComment?

    init(
        group: GroupSummary,
        initialAnnouncement: GroupAnnouncement,
        canManage: Bool,
        onAnnouncementChange: @escaping () async -> Void
    ) {
        self.group = group
        self.canManage = canManage
        self.onAnnouncementChange = onAnnouncementChange
        _announcement = State(initialValue: initialAnnouncement)
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                announcementBody
                commentsSection
            }
            .padding(SpottMetric.pageInset)
            .padding(.bottom, 24)
        }
        .background(SpottColor.canvas.ignoresSafeArea())
        .navigationTitle("公告")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if canManage {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("编辑", systemImage: "pencil") {
                        editingAnnouncement = true
                    }
                }
            }
        }
        .task { await loadComments() }
        .refreshable { await loadComments() }
        .sheet(item: $editTarget) { target in
            GroupCommentEditor(comment: target.comment) { updated in
                if let index = comments.firstIndex(where: { $0.id == updated.id }) {
                    comments[index] = updated
                }
            }
        }
        .sheet(isPresented: $editingAnnouncement) {
            GroupAnnouncementEditor(group: group, announcement: announcement) {
                await refreshAnnouncement()
            }
        }
        .confirmationDialog(
            "删除这条评论？",
            isPresented: Binding(
                get: { deleteTarget != nil },
                set: { if !$0 { deleteTarget = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("删除评论", role: .destructive) {
                if let deleteTarget { deleteComment(deleteTarget) }
            }
            Button("取消", role: .cancel) { deleteTarget = nil }
        }
    }

    private var announcementBody: some View {
        GroupContentCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    if announcement.pinnedAt != nil {
                        Label("置顶公告", systemImage: "pin.fill")
                            .foregroundStyle(SpottColor.coral)
                    }
                    Spacer()
                    Text(LocalizedStringKey(
                        announcement.visibility == "public" ? "公开" : "仅成员"
                    ))
                        .foregroundStyle(SpottColor.muted)
                }
                .font(.caption.weight(.semibold))
                Text(verbatim: announcement.title)
                    .font(.title2.weight(.bold))
                    .fontDesign(.rounded)
                Text(verbatim: announcement.body)
                    .font(.body)
                    .lineSpacing(6)
                Divider()
                HStack {
                    Label {
                        Text(verbatim: announcement.authorName ?? "Spott")
                    } icon: {
                        Image(systemName: "person.crop.circle")
                    }
                    Spacer()
                    Text(announcement.updatedAt.formatted(date: .abbreviated, time: .shortened))
                }
                .font(.caption)
                .foregroundStyle(SpottColor.muted)
                Button {
                    toggleLike()
                } label: {
                    Label(
                        "\(announcement.likeCount)",
                        systemImage: announcement.viewerLiked ? "heart.fill" : "heart"
                    )
                    .foregroundStyle(announcement.viewerLiked ? SpottColor.coral : SpottColor.muted)
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .disabled(busy || !canReact)
            }
        }
    }

    private var commentsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("评论")
                    .font(.title3.weight(.bold))
                    .fontDesign(.rounded)
                Spacer()
                Text("\(comments.count) 条")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(SpottColor.muted)
            }
            if loading {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .padding()
            } else if comments.isEmpty {
                GroupContentCard {
                    Label(
                        LocalizedStringKey(
                            announcement.commentsEnabled ? "还没有评论" : "这条公告已关闭评论"
                        ),
                        systemImage: announcement.commentsEnabled ? "bubble.left" : "bubble.left.slash"
                    )
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(SpottColor.muted)
                }
            } else {
                ForEach(comments) { comment in
                    commentRow(comment)
                }
            }
            if announcement.commentsEnabled, group.membershipStatus == "active" {
                GroupContentCard {
                    VStack(alignment: .leading, spacing: 10) {
                        TextField("写下对公告的回应", text: $draft, axis: .vertical)
                            .lineLimit(2...6)
                        HStack {
                            Text("\(draft.count) / 2000")
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(SpottColor.muted)
                            Spacer()
                            Button("发布", systemImage: "paperplane.fill") {
                                createComment()
                            }
                            .buttonStyle(.borderedProminent)
                            .buttonBorderShape(.capsule)
                            .tint(SpottColor.twilight)
                            .disabled(draft.trimmed.isEmpty || draft.count > 2_000 || busy)
                        }
                    }
                }
            } else if announcement.commentsEnabled, model.session == nil {
                Button("登录后参与评论") {
                    model.presentedGate = .login
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
            }
            if let error {
                GroupErrorBanner(error: error) { self.error = nil }
            }
        }
    }

    private func commentRow(_ comment: GroupComment) -> some View {
        GroupContentCard {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "person.crop.circle.fill")
                    .font(.system(size: 29))
                    .foregroundStyle(SpottColor.twilight.opacity(0.78))
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(verbatim: comment.author.name)
                            .font(.subheadline.weight(.bold))
                        Spacer()
                        Text(comment.createdAt.formatted(date: .omitted, time: .shortened))
                            .font(.caption)
                            .foregroundStyle(SpottColor.muted)
                    }
                    Text(verbatim: comment.body)
                        .font(.subheadline)
                        .lineSpacing(4)
                }
            }
        }
        .contextMenu {
            if comment.author.id == model.session?.user.id {
                Button("编辑", systemImage: "pencil") {
                    editTarget = CommentEditTarget(comment: comment)
                }
                Button("删除", systemImage: "trash", role: .destructive) {
                    deleteTarget = comment
                }
            }
        }
    }

    private var canReact: Bool {
        group.membershipStatus == "active" || group.membershipStatus == "muted"
    }

    private func loadComments() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            comments = try await model.api.groupComments(
                groupID: group.id,
                announcementID: announcement.id
            ).items
        } catch {
            self.error = AppModel.map(error)
        }
    }

    private func createComment() {
        let body = draft.trimmed
        guard !body.isEmpty, body.count <= 2_000 else { return }
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                let comment = try await model.api.createGroupComment(
                    groupID: group.id,
                    announcementID: announcement.id,
                    body: body,
                    locale: GroupCommunityCommentLocale.identifier(for: locale)
                )
                comments.append(comment)
                draft = ""
                await refreshAnnouncement()
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }

    private func deleteComment(_ comment: GroupComment) {
        busy = true
        deleteTarget = nil
        error = nil
        Task {
            defer { busy = false }
            do {
                try await model.api.deleteGroupComment(id: comment.id)
                comments.removeAll { $0.id == comment.id }
                await refreshAnnouncement()
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }

    private func toggleLike() {
        guard model.session != nil else {
            model.presentedGate = .login
            return
        }
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                _ = try await model.api.setGroupAnnouncementLiked(
                    groupID: group.id,
                    announcementID: announcement.id,
                    liked: !announcement.viewerLiked
                )
                await refreshAnnouncement()
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }

    private func refreshAnnouncement() async {
        do {
            let page = try await model.api.groupAnnouncements(id: group.id)
            if let updated = page.items.first(where: { $0.id == announcement.id }) {
                announcement = updated
            }
            await onAnnouncementChange()
        } catch {
            self.error = AppModel.map(error)
        }
    }
}

private struct CommentEditTarget: Identifiable {
    let comment: GroupComment
    var id: UUID { comment.id }
}

private struct GroupCommentEditor: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    let comment: GroupComment
    let completion: (GroupComment) -> Void
    @State private var commentText: String
    @State private var busy = false
    @State private var error: UserFacingError?

    private var copy: GroupCommunityCopy { GroupCommunityCopy(locale: locale) }

    init(comment: GroupComment, completion: @escaping (GroupComment) -> Void) {
        self.comment = comment
        self.completion = completion
        _commentText = State(initialValue: comment.body)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("评论内容") {
                    TextField("评论", text: $commentText, axis: .vertical)
                        .lineLimit(4...12)
                    Text("\(commentText.count) / 2000")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(SpottColor.muted)
                }
                if let error {
                    Section {
                        Text("\(error.message)（\(error.id)）")
                            .foregroundStyle(SpottColor.danger)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(SpottColor.canvas)
            .navigationTitle("编辑评论")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(copy.text(busy ? "保存中…" : "保存")) { save() }
                        .disabled(commentText.trimmed.isEmpty || commentText.count > 2_000 || busy)
                }
            }
        }
    }

    private func save() {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                let updated = try await model.api.updateGroupComment(
                    id: comment.id,
                    version: comment.version,
                    body: commentText.trimmed
                )
                completion(updated)
                dismiss()
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }
}

private struct GroupAnnouncementEditor: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    let group: GroupSummary
    let announcement: GroupAnnouncement?
    let completion: () async -> Void
    @State private var title: String
    @State private var announcementBody: String
    @State private var visibility: String
    @State private var commentsEnabled: Bool
    @State private var busy = false
    @State private var error: UserFacingError?

    private var copy: GroupCommunityCopy { GroupCommunityCopy(locale: locale) }

    init(
        group: GroupSummary,
        announcement: GroupAnnouncement?,
        completion: @escaping () async -> Void
    ) {
        self.group = group
        self.announcement = announcement
        self.completion = completion
        _title = State(initialValue: announcement?.title ?? "")
        _announcementBody = State(initialValue: announcement?.body ?? "")
        _visibility = State(initialValue: announcement?.visibility ?? "members")
        _commentsEnabled = State(initialValue: announcement?.commentsEnabled ?? true)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("公告内容") {
                    TextField("标题", text: $title)
                    TextField("正文", text: $announcementBody, axis: .vertical)
                        .lineLimit(6...16)
                }
                Section {
                    Picker("谁可以查看", selection: $visibility) {
                        Text("所有人").tag("public")
                        Text("仅社群成员").tag("members")
                    }
                    Toggle("允许成员评论", isOn: $commentsEnabled)
                } header: {
                    Text("可见范围")
                } footer: {
                    Text("普通公告每天最多发布 2 条；编辑已有公告不占用当日额度。")
                }
                if let error {
                    Section {
                        Text("\(error.message)（\(error.id)）")
                            .foregroundStyle(SpottColor.danger)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(SpottColor.canvas)
            .navigationTitle(copy.text(announcement == nil ? "发布公告" : "编辑公告"))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(copy.text(busy ? "保存中…" : "保存")) { save() }
                        .disabled(!valid || busy)
                }
            }
        }
    }

    private var valid: Bool {
        (2...120).contains(title.trimmed.count) && (1...4_000).contains(announcementBody.trimmed.count)
    }

    private func save() {
        guard valid else { return }
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                if let announcement {
                    _ = try await model.api.updateGroupAnnouncement(
                        groupID: group.id,
                        announcementID: announcement.id,
                        version: announcement.version,
                        title: title.trimmed,
                        body: announcementBody.trimmed,
                        visibility: visibility,
                        commentsEnabled: commentsEnabled
                    )
                } else {
                    _ = try await model.api.createGroupAnnouncement(
                        groupID: group.id,
                        title: title.trimmed,
                        body: announcementBody.trimmed,
                        visibility: visibility,
                        commentsEnabled: commentsEnabled
                    )
                }
                await completion()
                dismiss()
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }
}

private struct JoinGroupView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    let group: GroupSummary
    let completion: () async -> Void
    @State private var inviteCode = ""
    @State private var busy = false
    @State private var error: UserFacingError?

    private var copy: GroupCommunityCopy { GroupCommunityCopy(locale: locale) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("社群") {
                        Text(verbatim: group.name)
                    }
                    LabeledContent("加入方式", value: copy.joinModeTitle(group.joinMode))
                    if group.joinMode == .inviteOnly {
                        TextField("邀请码", text: $inviteCode)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                    }
                } header: {
                    Text("加入社群")
                } footer: {
                    Text(copy.joinModeExplanation(group.joinMode))
                }
                if let error {
                    Section {
                        Text("\(error.message)（\(error.id)）")
                            .foregroundStyle(SpottColor.danger)
                    }
                }
                Section {
                    Button {
                        join()
                    } label: {
                        if busy {
                            ProgressView().frame(maxWidth: .infinity)
                        } else {
                            Text(copy.text(group.joinMode == .approval ? "提交加入申请" : "确认加入"))
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(readiness == .inviteRequired || busy)
                }
            }
            .scrollContentBackground(.hidden)
            .background(SpottColor.canvas)
            .navigationTitle("加入社群")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
            }
        }
    }

    private var readiness: GroupJoinReadiness {
        GroupJoinReadiness(mode: group.joinMode, rawInviteCode: inviteCode)
    }

    private func join() {
        guard case .ready(let code) = readiness else { return }
        var authorizedImmediately = false
        model.requireGroupJoinTrust(for: group, inviteCode: code) {
            authorizedImmediately = true
            submit(code: code)
        }
        if !authorizedImmediately {
            dismiss()
        }
    }

    private func submit(code: String?) {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                _ = try await model.api.joinGroup(id: group.id, inviteCode: code)
                await completion()
                dismiss()
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }
}

private struct GroupMembersView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale
    let group: GroupSummary
    @State private var members: [GroupMember] = []
    @State private var filter = "all"
    @State private var loading = true
    @State private var busyMemberID: UUID?
    @State private var error: UserFacingError?

    private var copy: GroupCommunityCopy { GroupCommunityCopy(locale: locale) }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("成员状态", selection: $filter) {
                        Text("全部").tag("all")
                        Text("待审核").tag("pending")
                        Text("活跃").tag("active")
                        Text("已禁言").tag("muted")
                    }
                    .pickerStyle(.segmented)
                }
                if loading {
                    Section {
                        ProgressView().frame(maxWidth: .infinity)
                    }
                } else if filteredMembers.isEmpty {
                    Section {
                        ContentUnavailableView(
                            "没有符合条件的成员",
                            systemImage: "person.2",
                            description: Text("切换状态查看其他成员。")
                        )
                    }
                } else {
                    Section("成员 · \(filteredMembers.count)") {
                        ForEach(filteredMembers) { member in
                            memberRow(member)
                        }
                    }
                }
                if let error {
                    Section {
                        Text("\(error.message)（\(error.id)）")
                            .foregroundStyle(SpottColor.danger)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(SpottColor.canvas)
            .navigationTitle("成员管理")
            .refreshable { await load() }
            .task { await load() }
        }
    }

    private var filteredMembers: [GroupMember] {
        filter == "all" ? members : members.filter { $0.status == filter }
    }

    private func memberRow(_ member: GroupMember) -> some View {
        HStack(spacing: 12) {
            Image(systemName: member.role == "owner" ? "crown.fill" : member.role == "admin" ? "star.circle.fill" : "person.crop.circle.fill")
                .font(.system(size: 27))
                .foregroundStyle(member.role == "owner" ? SpottColor.amber : SpottColor.twilight)
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: member.user.name)
                    .font(.subheadline.weight(.bold))
                Text(verbatim: "@\(member.user.handle) · \(copy.memberRoleTitle(member.role)) · \(copy.memberStatusTitle(member.status))")
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
            }
            Spacer()
            if busyMemberID == member.id {
                ProgressView()
            } else if member.role != "owner" {
                Menu {
                    if member.status == "pending" {
                        Button("批准加入", systemImage: "checkmark.circle") {
                            update(member, status: "active")
                        }
                        Button("拒绝申请", systemImage: "xmark.circle", role: .destructive) {
                            update(member, status: "removed")
                        }
                    } else if member.status == "active" {
                        Button("暂停评论", systemImage: "speaker.slash") {
                            update(member, status: "muted")
                        }
                        Button("移出社群", systemImage: "person.badge.minus", role: .destructive) {
                            update(member, status: "removed")
                        }
                    } else if member.status == "muted" {
                        Button("恢复评论", systemImage: "speaker.wave.2") {
                            update(member, status: "active")
                        }
                        Button("移出社群", systemImage: "person.badge.minus", role: .destructive) {
                            update(member, status: "removed")
                        }
                    }
                    if group.membershipRole == "owner", member.status == "active" {
                        Divider()
                        Button(
                            copy.text(member.role == "admin" ? "撤销管理员" : "设为管理员"),
                            systemImage: member.role == "admin" ? "star.slash" : "star"
                        ) {
                            update(member, role: member.role == "admin" ? "member" : "admin")
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .font(.title3)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            members = try await model.api.groupMembers(id: group.id).items
        } catch {
            self.error = AppModel.map(error)
        }
    }

    private func update(_ member: GroupMember, role: String? = nil, status: String? = nil) {
        busyMemberID = member.id
        error = nil
        Task {
            defer { busyMemberID = nil }
            do {
                _ = try await model.api.updateGroupMember(
                    groupID: group.id,
                    userID: member.id,
                    role: role,
                    status: status
                )
                await load()
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }
}

private struct GroupInviteView: View {
    @Environment(AppModel.self) private var model
    let group: GroupSummary
    @State private var maxUses = 1
    @State private var expiresInHours = 168
    @State private var invite: GroupInvite?
    @State private var busy = false
    @State private var error: UserFacingError?

    var body: some View {
        NavigationStack {
            Form {
                Section("邀请设置") {
                    Stepper("可使用 \(maxUses) 次", value: $maxUses, in: 1...1_000)
                    Picker("有效期", selection: $expiresInHours) {
                        Text("24 小时").tag(24)
                        Text("7 天").tag(168)
                        Text("30 天").tag(720)
                    }
                }
                if let invite {
                    Section("邀请已生成") {
                        Text(verbatim: invite.code)
                            .font(.system(.title3, design: .monospaced, weight: .bold))
                            .textSelection(.enabled)
                        LabeledContent(
                            "失效时间",
                            value: invite.expiresAt.formatted(date: .abbreviated, time: .shortened)
                        )
                        ShareLink(
                            item: invite.code,
                            subject: Text("加入 \(group.name)"),
                            message: Text("在 Spott 社群「\(group.name)」中输入这个邀请码。")
                        ) {
                            Label("分享邀请码", systemImage: "square.and.arrow.up")
                        }
                    }
                }
                if let error {
                    Section {
                        Text("\(error.message)（\(error.id)）")
                            .foregroundStyle(SpottColor.danger)
                    }
                }
                Section {
                    Button {
                        generate()
                    } label: {
                        if busy {
                            ProgressView().frame(maxWidth: .infinity)
                        } else {
                            Text(LocalizedStringKey(invite == nil ? "生成邀请" : "生成新邀请"))
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(busy)
                }
            }
            .scrollContentBackground(.hidden)
            .background(SpottColor.canvas)
            .navigationTitle("邀请成员")
        }
    }

    private func generate() {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                invite = try await model.api.createGroupInvite(
                    id: group.id,
                    maxUses: maxUses,
                    expiresInHours: expiresInHours
                )
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }
}

private struct GroupCapacityView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let group: GroupSummary
    let completion: (GroupSummary) -> Void
    @State private var quote: Quote?
    @State private var loading = true
    @State private var busy = false
    @State private var error: UserFacingError?

    var body: some View {
        NavigationStack {
            Form {
                Section("容量变化") {
                    LabeledContent("当前容量", value: "\(group.capacity) 人")
                    LabeledContent("扩容后", value: "\(min(group.capacity + 50, 500)) 人")
                    Text("每次增加 50 个永久名额，普通社群最多 500 人。")
                        .font(.caption)
                        .foregroundStyle(SpottColor.muted)
                }
                Section("服务端报价") {
                    if loading {
                        HStack {
                            ProgressView()
                            Text("正在获取最新报价…")
                        }
                    } else if let quote {
                        LabeledContent("需支付", value: "\(quote.amount) 积分")
                        LabeledContent(
                            "报价有效至",
                            value: quote.expiresAt.formatted(date: .omitted, time: .shortened)
                        )
                    }
                }
                if let error {
                    Section {
                        Text("\(error.message)（\(error.id)）")
                            .foregroundStyle(SpottColor.danger)
                        Button("重新获取报价") {
                            Task { await loadQuote() }
                        }
                    }
                }
                if let quote {
                    Section {
                        Button {
                            purchase(quote)
                        } label: {
                            if busy {
                                ProgressView().frame(maxWidth: .infinity)
                            } else {
                                Text("确认支付 \(quote.amount) 积分并扩容")
                                    .frame(maxWidth: .infinity)
                            }
                        }
                        .buttonStyle(PrimaryButtonStyle())
                        .disabled(busy || quote.expiresAt <= .now)
                    } footer: {
                        Text("只有点击确认后才会扣除积分。")
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(SpottColor.canvas)
            .navigationTitle("社群扩容")
            .task { await loadQuote() }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
            }
        }
    }

    private func loadQuote() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            quote = try await model.api.quote(purpose: "group_capacity", resourceID: group.id)
        } catch {
            self.error = AppModel.map(error)
        }
    }

    private func purchase(_ quote: Quote) {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                let updated = try await model.api.purchaseGroupCapacity(
                    id: group.id,
                    quoteID: quote.id
                )
                completion(updated)
                dismiss()
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }
}

private struct GroupCoverEditor: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    let group: GroupSummary
    let completion: () async -> Void
    @State private var selection: PhotosPickerItem?
    @State private var previewImage: UIImage?
    @State private var busy = false
    @State private var error: UserFacingError?

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Group {
                    if let previewImage {
                        Image(uiImage: previewImage).resizable().scaledToFill()
                    } else if let url = group.coverURL {
                        AsyncImage(url: url) { image in
                            image.resizable().scaledToFill()
                        } placeholder: {
                            ProgressView()
                        }
                    } else {
                        LinearGradient(
                            colors: [SpottColor.twilightPale, SpottColor.coralPale],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                        .overlay(Image(systemName: "person.3.fill").font(.largeTitle).foregroundStyle(SpottColor.twilight))
                    }
                }
                .frame(maxWidth: .infinity)
                .frame(height: 210)
                .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 26).stroke(SpottColor.divider))

                Text("封面会显示在公开社群主页。图片先经过病毒扫描和内容安全处理，再原子替换现有封面。")
                    .font(.subheadline)
                    .foregroundStyle(SpottColor.muted)
                    .lineSpacing(4)

                PhotosPicker(selection: $selection, matching: .images) {
                    Label(
                        LocalizedStringKey(group.coverURL == nil ? "选择社群封面" : "更换社群封面"),
                        systemImage: "photo.on.rectangle.angled"
                    )
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(busy)

                if busy { ProgressView("正在安全处理图片…") }
                if let error {
                    Label("\(error.message)（\(error.id)）", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(SpottColor.danger)
                }
                Spacer()
            }
            .padding(SpottMetric.pageInset)
            .background(SpottColor.canvas.ignoresSafeArea())
            .navigationTitle("社群封面")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
            }
            .onChange(of: selection) { _, item in
                guard let item else { return }
                Task { await upload(item) }
            }
        }
    }

    private func upload(_ item: PhotosPickerItem) async {
        busy = true
        defer { busy = false }
        do {
            let data = try await item.loadTransferable(type: Data.self)
            let prepared = try GroupCommunityImageDecoder.prepare(data: data)
            _ = try await model.api.uploadGroupCover(
                data: prepared.jpegData,
                filename: "group-cover.jpg",
                mimeType: "image/jpeg",
                groupID: group.id
            )
            previewImage = prepared.image
            await completion()
            dismiss()
        } catch let failure as GroupCommunityImageFailure {
            self.error = failure.userFacing(locale: locale)
        } catch {
            self.error = AppModel.map(error)
        }
    }
}

private struct GroupTransferView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale
    let group: GroupSummary
    let completion: () async -> Void
    @State private var members: [GroupMember] = []
    @State private var selectedUserID: UUID?
    @State private var lifecycle: GroupLifecycleMutation?
    @State private var cancelReason = ""
    @State private var loading = true
    @State private var busy = false
    @State private var error: UserFacingError?

    private var copy: GroupCommunityCopy { GroupCommunityCopy(locale: locale) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("接收人必须验证日本手机号，并且已加入该社群至少 7 天。发起后，接收人需要确认，随后进入 24 小时冷静期。")
                        .font(.subheadline)
                        .foregroundStyle(SpottColor.muted)
                }
                if let lifecycle {
                    transferStatus(lifecycle)
                } else if group.status == "transfer_pending" {
                    Section("转让进行中") {
                        Label("转让已进入确认或冷静期", systemImage: "clock.arrow.2.circlepath")
                        Text("请从转让通知继续操作；完成前社群仍保持可用。")
                            .font(.caption)
                            .foregroundStyle(SpottColor.muted)
                    }
                } else {
                    Section("选择接收人") {
                        if loading {
                            ProgressView().frame(maxWidth: .infinity)
                        } else {
                            Picker("社群成员", selection: $selectedUserID) {
                                Text("请选择").tag(UUID?.none)
                                ForEach(eligibleMembers) { member in
                                    Text(verbatim: "\(member.user.name) · @\(member.user.handle)")
                                        .tag(Optional(member.id))
                                }
                            }
                        }
                    }
                    Section {
                        Button("发起转让", systemImage: "arrow.left.arrow.right") {
                            startTransfer()
                        }
                        .disabled(selectedUserID == nil || busy)
                    }
                }
                if let error {
                    Section {
                        Text("\(error.message)（\(error.id)）")
                            .foregroundStyle(SpottColor.danger)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(SpottColor.canvas)
            .navigationTitle("转让社群")
            .task { await loadMembers() }
        }
    }

    @ViewBuilder
    private func transferStatus(_ lifecycle: GroupLifecycleMutation) -> some View {
        Section("转让状态") {
            Label(copy.transferStateTitle(lifecycle.state), systemImage: "arrow.left.arrow.right.circle.fill")
            if let expiresAt = lifecycle.expiresAt {
                LabeledContent(
                    "接收确认截止",
                    value: expiresAt.formatted(date: .abbreviated, time: .shortened)
                )
            }
            if let cooldown = lifecycle.cooldownUntil {
                LabeledContent(
                    "冷静期结束",
                    value: cooldown.formatted(date: .abbreviated, time: .shortened)
                )
            }
            if lifecycle.state == "awaiting_target", lifecycle.toUserId == model.session?.user.id {
                Button("接受转让") { accept(lifecycle) }
                    .disabled(busy)
            }
            if lifecycle.state == "cooling_off", lifecycle.cooldownUntil ?? .distantFuture <= .now {
                Button("完成转让") { complete(lifecycle) }
                    .disabled(busy)
            }
            if lifecycle.state == "awaiting_target" || lifecycle.state == "cooling_off" {
                TextField("取消原因", text: $cancelReason, axis: .vertical)
                Button("取消转让", role: .destructive) { cancel(lifecycle) }
                    .disabled(cancelReason.trimmed.count < 2 || busy)
            }
        }
    }

    private var eligibleMembers: [GroupMember] {
        members.filter {
            $0.status == "active" && $0.role != "owner" && $0.id != model.session?.user.id
        }
    }

    private func loadMembers() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            members = try await model.api.groupMembers(id: group.id).items
            do {
                let active = try await model.api.activeGroupTransfer(groupID: group.id)
                lifecycle = GroupLifecycleMutation(active: active)
            } catch let apiError as APIError where apiError.status == 404 {
                lifecycle = nil
            }
        } catch {
            self.error = AppModel.map(error)
        }
    }

    private func startTransfer() {
        guard let selectedUserID else { return }
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                lifecycle = try await model.api.startGroupTransfer(
                    groupID: group.id,
                    targetUserID: selectedUserID
                )
                await completion()
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }

    private func accept(_ transfer: GroupLifecycleMutation) {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                lifecycle = try await model.api.acceptGroupTransfer(
                    groupID: group.id,
                    transferID: transfer.id
                )
                await completion()
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }

    private func complete(_ transfer: GroupLifecycleMutation) {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                lifecycle = try await model.api.completeGroupTransfer(
                    groupID: group.id,
                    transferID: transfer.id
                )
                await completion()
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }

    private func cancel(_ transfer: GroupLifecycleMutation) {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                lifecycle = try await model.api.cancelGroupTransfer(
                    groupID: group.id,
                    transferID: transfer.id,
                    reason: cancelReason.trimmed
                )
                await completion()
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }
}

private struct GroupDissolutionView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let group: GroupSummary
    let completion: () async -> Void
    @State private var reason = ""
    @State private var busy = false
    @State private var error: UserFacingError?
    @State private var confirmRequest = false

    var body: some View {
        NavigationStack {
            Form {
                if group.status == "closing" {
                    Section("解散计划") {
                        Label("社群正处于 7 天通知期", systemImage: "hourglass")
                            .foregroundStyle(SpottColor.danger)
                        if let date = group.dissolveAfter {
                            LabeledContent(
                                "计划解散",
                                value: date.formatted(date: .abbreviated, time: .shortened)
                            )
                        }
                        Text("通知期内可以撤销，成员与公告会继续保留。")
                            .font(.caption)
                            .foregroundStyle(SpottColor.muted)
                    }
                    Section {
                        Button("撤销解散计划", systemImage: "arrow.uturn.backward") {
                            cancel()
                        }
                        .disabled(busy)
                        if let date = group.dissolveAfter, date <= .now {
                            Button("完成解散", systemImage: "trash", role: .destructive) {
                                finalize()
                            }
                            .disabled(busy)
                        }
                    }
                } else {
                    Section {
                        Text("提交后会开始 7 天通知期。期间可以撤销；社群有未结束活动时，服务端会拒绝解散。")
                            .font(.subheadline)
                            .foregroundStyle(SpottColor.muted)
                        TextField("解散原因", text: $reason, axis: .vertical)
                            .lineLimit(3...8)
                    } header: {
                        Text("解散社群")
                    }
                    Section {
                        Button("开始 7 天解散通知期", role: .destructive) {
                            confirmRequest = true
                        }
                        .disabled(reason.trimmed.count < 3 || busy)
                    }
                }
                if let error {
                    Section {
                        Text("\(error.message)（\(error.id)）")
                            .foregroundStyle(SpottColor.danger)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(SpottColor.canvas)
            .navigationTitle("社群解散")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
            }
            .confirmationDialog(
                "确认开始解散通知期？",
                isPresented: $confirmRequest,
                titleVisibility: .visible
            ) {
                Button("确认申请解散", role: .destructive) { request() }
                Button("取消", role: .cancel) {}
            } message: {
                Text("所有成员会收到通知，7 天内可以撤销。")
            }
        }
    }

    private func request() {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                _ = try await model.api.requestGroupDissolution(
                    id: group.id,
                    reason: reason.trimmed
                )
                await completion()
                dismiss()
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }

    private func cancel() {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                _ = try await model.api.cancelGroupDissolution(id: group.id)
                await completion()
                dismiss()
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }

    private func finalize() {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                _ = try await model.api.finalizeGroupDissolution(id: group.id)
                await completion()
                dismiss()
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }
}

private struct CreateGroupView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    let completion: (GroupSummary) -> Void
    @State private var name = ""
    @State private var description = ""
    @State private var joinMode = GroupJoinMode.approval
    @State private var region = GroupCommunityRegion.tokyo
    @State private var category = "outdoor"
    @State private var tags = ""
    @State private var rules = ""
    @State private var rulesAccepted = false
    @State private var quote: Quote?
    @State private var loadingQuote = false
    @State private var busy = false
    @State private var error: UserFacingError?
    @State private var coverItem: PhotosPickerItem?
    @State private var coverJPEG: Data?
    @State private var coverPreview: UIImage?
    @State private var createdGroup: GroupSummary?

    private var copy: GroupCommunityCopy { GroupCommunityCopy(locale: locale) }

    var body: some View {
        NavigationStack {
            Form {
                Section("社群封面") {
                    if let coverPreview {
                        Image(uiImage: coverPreview)
                            .resizable()
                            .scaledToFill()
                            .frame(maxWidth: .infinity)
                            .frame(height: 150)
                            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                    }
                    PhotosPicker(selection: $coverItem, matching: .images) {
                        Label("选择或更换封面", systemImage: "photo.on.rectangle.angled")
                    }
                    Text("可稍后在社群管理中更换；图片会经过安全处理。")
                        .font(.caption)
                        .foregroundStyle(SpottColor.muted)
                }
                Section("社群资料") {
                    TextField("名称", text: $name)
                    TextField("介绍（至少 20 个字符）", text: $description, axis: .vertical)
                        .lineLimit(4...10)
                    Picker("加入方式", selection: $joinMode) {
                        ForEach(GroupJoinMode.allCases) { mode in
                            Text(copy.joinModeTitle(mode)).tag(mode)
                        }
                    }
                    Picker("地区", selection: $region) {
                        ForEach(GroupCommunityRegion.allCases) { option in
                            Text(option.title(using: copy)).tag(option)
                        }
                    }
                    .accessibilityIdentifier("community.create.region")
                    Picker("类别", selection: $category) {
                        Text("户外").tag("outdoor")
                        Text("文化").tag("culture")
                        Text("运动").tag("sports")
                        Text("亲子").tag("family")
                        Text("语言").tag("language")
                        Text("科技").tag("technology")
                        Text("其他").tag("other")
                    }
                    TextField("兴趣标签，用逗号分隔，最多 5 个", text: $tags)
                    TextField("社群规则", text: $rules, axis: .vertical)
                        .lineLimit(3...10)
                }
                Section("容量") {
                    LabeledContent("基础容量", value: "50 人")
                    Text("创建成功后可按服务端报价，每次永久增加 50 人，最多 500 人。")
                        .font(.caption)
                        .foregroundStyle(SpottColor.muted)
                }
                Section {
                    Toggle("我同意群主责任与社群规则", isOn: $rulesAccepted)
                }
                if let quote {
                    Section("创建报价") {
                        LabeledContent("需支付", value: "\(quote.amount) 积分")
                        LabeledContent(
                            "报价有效至",
                            value: quote.expiresAt.formatted(date: .omitted, time: .shortened)
                        )
                    }
                }
                if let error {
                    Section {
                        Text("\(error.message)（\(error.id)）")
                            .foregroundStyle(SpottColor.danger)
                    }
                }
                Section {
                    Button {
                        if createdGroup != nil {
                            retryCoverUpload()
                        } else {
                            quote == nil ? prepareQuote() : create()
                        }
                    } label: {
                        if busy || loadingQuote {
                            ProgressView().frame(maxWidth: .infinity)
                        } else if createdGroup != nil {
                            Text("重试上传封面").frame(maxWidth: .infinity)
                        } else if let quote {
                            Text("确认支付 \(quote.amount) 积分并创建")
                                .frame(maxWidth: .infinity)
                        } else {
                            Text("获取创建报价")
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(
                        busy || loadingQuote ||
                        (createdGroup == nil && (!valid || (quote?.expiresAt ?? .distantFuture) <= .now))
                    )
                } footer: {
                    Text("只有确认创建后才会扣除积分。")
                }
            }
            .scrollContentBackground(.hidden)
            .background(SpottColor.canvas)
            .navigationTitle("创建社群")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
            }
            .task {
                region = GroupCommunityRegion.safeSelection(for: model.region)
            }
            .onChange(of: coverItem) { _, item in
                guard let item else { return }
                Task { await loadCover(item) }
            }
            .onChange(of: name) { _, _ in invalidateQuote() }
            .onChange(of: description) { _, _ in invalidateQuote() }
            .onChange(of: joinMode) { _, _ in invalidateQuote() }
            .onChange(of: region) { _, _ in invalidateQuote() }
            .onChange(of: category) { _, _ in invalidateQuote() }
            .onChange(of: tags) { _, _ in invalidateQuote() }
            .onChange(of: rules) { _, _ in invalidateQuote() }
        }
    }

    private var valid: Bool {
        (2...30).contains(name.trimmed.count)
            && (20...1_000).contains(description.trimmed.count)
            && !category.isEmpty
            && parsedTags.count <= 5
            && rules.count <= 4_000
            && rulesAccepted
    }

    private var parsedTags: [String] {
        tags
            .components(separatedBy: CharacterSet(charactersIn: ",，"))
            .map(\.trimmed)
            .filter { !$0.isEmpty }
            .reduce(into: [String]()) { result, tag in
                if !result.contains(tag), result.count < 6 {
                    result.append(String(tag.prefix(40)))
                }
            }
    }

    private func invalidateQuote() {
        if quote != nil { quote = nil }
    }

    private func prepareQuote() {
        guard valid else { return }
        loadingQuote = true
        error = nil
        Task {
            defer { loadingQuote = false }
            do {
                quote = try await model.api.quote(purpose: "group_create", resourceID: nil)
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }

    private func create() {
        guard let quote, valid else { return }
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                let payload = GroupCreationPayload(
                    quoteId: quote.id,
                    name: name.trimmed,
                    slug: slug,
                    description: description.trimmed,
                    joinMode: joinMode,
                    regionId: region.rawValue,
                    categoryId: category,
                    tags: Array(parsedTags.prefix(5)),
                    rules: rules.trimmed
                )
                let group = try await model.api.createGroup(payload)
                createdGroup = group
                completion(group)
                if coverJPEG == nil {
                    dismiss()
                } else {
                    try await uploadCover(to: group)
                    dismiss()
                }
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }

    private func loadCover(_ item: PhotosPickerItem) async {
        do {
            let data = try await item.loadTransferable(type: Data.self)
            let prepared = try GroupCommunityImageDecoder.prepare(data: data)
            coverPreview = prepared.image
            coverJPEG = prepared.jpegData
            error = nil
        } catch let failure as GroupCommunityImageFailure {
            self.error = failure.userFacing(locale: locale)
        } catch {
            self.error = AppModel.map(error)
        }
    }

    private func retryCoverUpload() {
        guard let createdGroup else { return }
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                try await uploadCover(to: createdGroup)
                dismiss()
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }

    private func uploadCover(to group: GroupSummary) async throws {
        guard let coverJPEG else { return }
        _ = try await model.api.uploadGroupCover(
            data: coverJPEG,
            filename: "group-cover.jpg",
            mimeType: "image/jpeg",
            groupID: group.id
        )
    }

    private var slug: String {
        let latin = name
            .applyingTransform(.toLatin, reverse: false)?
            .applyingTransform(.stripDiacritics, reverse: false) ?? name
        let cleaned = latin
            .lowercased()
            .replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        let base = String((cleaned.isEmpty ? "spott-community" : cleaned).prefix(58))
        return "\(base)-\(String(UUID().uuidString.prefix(6)).lowercased())"
    }
}

private struct GroupContentCard<Content: View>: View {
    let tint: Color?
    @ViewBuilder let content: Content

    init(tint: Color? = nil, @ViewBuilder content: () -> Content) {
        self.tint = tint
        self.content = content()
    }

    var body: some View {
        content
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                tint ?? SpottColor.surface,
                in: RoundedRectangle(
                    cornerRadius: SpottMetric.cardRadius,
                    style: .continuous
                )
            )
            .overlay {
                RoundedRectangle(
                    cornerRadius: SpottMetric.cardRadius,
                    style: .continuous
                )
                .stroke(SpottColor.ink.opacity(0.06), lineWidth: 1)
            }
            .shadow(color: SpottColor.ink.opacity(0.05), radius: 14, y: 6)
    }
}

private struct GroupCommunityBackdrop: View {
    let accommodations: GroupCommunityDisplayAccommodations

    var body: some View {
        ZStack {
            SpottColor.canvas

            if !accommodations.increasedContrast {
                RadialGradient(
                    colors: [
                        SpottColor.twilight.opacity(
                            accommodations.reduceTransparency ? 0.045 : 0.09
                        ),
                        .clear,
                    ],
                    center: .topTrailing,
                    startRadius: 12,
                    endRadius: 280
                )
                RadialGradient(
                    colors: [
                        SpottColor.coral.opacity(
                            accommodations.reduceTransparency ? 0.025 : 0.055
                        ),
                        .clear,
                    ],
                    center: .bottomLeading,
                    startRadius: 20,
                    endRadius: 340
                )
            }
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}

private extension View {
    @ViewBuilder
    func groupAdaptiveControlSurface<S: Shape>(
        shape: S,
        reduceTransparency: Bool,
        increasedContrast: Bool
    ) -> some View {
        if GroupCommunityControlSurfacePolicy.style(
            reduceTransparency: reduceTransparency,
            increasedContrast: increasedContrast
        ) == .opaque {
            self
                .background(SpottColor.surface, in: shape)
                .overlay(
                    shape.stroke(
                        SpottColor.ink.opacity(increasedContrast ? 0.44 : 0.12),
                        lineWidth: increasedContrast ? 1.5 : 1
                    )
                )
        } else {
            self
                .spottGlassPanel(shape: shape, interactive: true)
                .overlay(shape.stroke(SpottColor.ink.opacity(0.08), lineWidth: 1))
                .shadow(color: SpottColor.ink.opacity(0.045), radius: 12, y: 5)
        }
    }
}

private struct FlowTagRow: View {
    let tags: [String]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 7) {
                ForEach(tags, id: \.self) { tag in
                    Text(verbatim: "#\(tag)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(SpottColor.twilightDeep)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 5)
                        .background(SpottColor.twilightPale, in: Capsule())
                }
            }
        }
    }
}

private struct GroupErrorBanner: View {
    let error: UserFacingError
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(SpottColor.danger)
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: error.message)
                    .font(.subheadline.weight(.semibold))
                Text("错误编号：\(error.id)")
                    .font(.caption.monospaced())
                    .foregroundStyle(SpottColor.muted)
            }
            Spacer()
            Button(action: dismiss) {
                Image(systemName: "xmark")
                    .foregroundStyle(SpottColor.muted)
            }
            .buttonStyle(.plain)
        }
        .padding(14)
        .background(SpottColor.coralPale.opacity(0.54), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(SpottColor.danger.opacity(0.16)))
    }
}

private struct GroupSkeleton: View {
    var body: some View {
        RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous)
            .fill(Color.black.opacity(0.045))
            .frame(height: 246)
            .redacted(reason: .placeholder)
    }
}

private extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

#if DEBUG
private struct CommunityCardPreview: View {
    let locale: Locale

    var body: some View {
        ZStack {
            GroupCommunityBackdrop(
                accommodations: GroupCommunityDisplayAccommodations(
                    reduceTransparency: false,
                    increasedContrast: false
                )
            )
            ScrollView {
                CommunityCard(group: GroupCommunityUITestFixture.localizedDemoGroups(locale: locale)[0])
                    .padding(20)
            }
        }
        .environment(\.locale, locale)
    }
}

#Preview("Community card · Japanese") {
    CommunityCardPreview(locale: Locale(identifier: "ja"))
        .preferredColorScheme(.light)
}

#Preview("Community card · AX5") {
    CommunityCardPreview(locale: Locale(identifier: "en"))
        .environment(\.dynamicTypeSize, .accessibility5)
        .preferredColorScheme(.dark)
}
#endif
