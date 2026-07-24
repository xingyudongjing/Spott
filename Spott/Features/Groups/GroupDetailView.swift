import SwiftUI

enum GroupDetailSection: String, CaseIterable, Identifiable {
    case overview
    case discussion
    case announcements

    var id: String { rawValue }

    var symbol: String {
        switch self {
        case .overview: "info.circle"
        case .discussion: "bubble.left.and.bubble.right"
        case .announcements: "megaphone"
        }
    }

    var titleKey: String.LocalizationValue {
        switch self {
        case .overview: "groups.detail.section.overview"
        case .discussion: "groups.detail.section.discussion"
        case .announcements: "groups.detail.section.announcements"
        }
    }
}

struct GroupDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let groupID: UUID
    @State private var group: GroupSummary?
    @State private var announcements: [GroupAnnouncement] = []
    @State private var announcementsTruncated = false
    @State private var loading = true
    @State private var mutating = false
    @State private var error: UserFacingError?
    @State private var sheet: GroupDetailSheet?
    @State private var section = GroupDetailSection.overview
    @State private var discussionStore: GroupDiscussionStore?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                if loading, group == nil {
                    detailSkeleton
                } else if let group {
                    hero(group)
                    if group.status == "closing" {
                        dissolutionBanner(group)
                    }
                    sectionPicker
                    switch section {
                    case .overview:
                        about(group)
                    case .discussion:
                        if let discussionStore {
                            GroupDiscussionSection(
                                group: group,
                                policy: policy(group),
                                store: discussionStore
                            ) {
                                startJoin(group)
                            }
                        }
                    case .announcements:
                        announcementsSection(group)
                    }
                    if let error {
                        GroupErrorBanner(error: error) { self.error = nil }
                    }
                } else {
                    SpottEmptyState(
                        icon: "person.3",
                        title: text("groups.detail.unavailable_title"),
                        message: error?.message ?? text("groups.detail.unavailable_message"),
                        actionTitle: text("groups.detail.reload")
                    ) {
                        Task { await loadAll() }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 80)
                }
            }
            .padding(.horizontal, SpottMetric.pageInset)
            .padding(.top, 12)
            .padding(.bottom, 40)
        }
        .background(SpottScreenBackground())
        .navigationTitle(group.map { Text(verbatim: $0.name) } ?? Text(verbatim: text("groups.detail.fallback_title")))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let group {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        sheet = .report(group)
                    } label: {
                        Image(systemName: "flag")
                    }
                    .accessibilityLabel(Text(verbatim: text("groups.detail.report")))
                }
                ToolbarItem(placement: .topBarTrailing) {
                    managementMenu(group)
                }
            }
        }
        .task(id: model.session?.sessionId) { await loadAll() }
        .refreshable { await refreshCurrentSection() }
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
            case .report(let group):
                NavigationStack {
                    SafetyReportView(
                        target: SafetyReportTarget(
                            type: .group,
                            targetID: group.id,
                            displayName: group.name
                        )
                    )
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button(text("groups.common.close")) { sheet = nil }
                        }
                    }
                }
            }
        }
    }

    private var detailSkeleton: some View {
        VStack(alignment: .leading, spacing: 16) {
            RoundedRectangle(cornerRadius: SpottMetric.coverRadius, style: .continuous)
                .fill(SpottColor.surface)
                .frame(height: 168)
            RoundedRectangle(cornerRadius: SpottMetric.controlRadius, style: .continuous)
                .fill(SpottColor.surface)
                .frame(width: 220, height: 28)
            RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous)
                .fill(SpottColor.surface)
                .frame(height: 130)
        }
        .spottSkeleton()
    }

    private func hero(_ group: GroupSummary) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            EventCoverView(
                url: group.coverURL,
                category: groupCoverCategory(group.categoryId)
            )
            .frame(height: 168)
            .overlay(alignment: .topTrailing) {
                GlassPill(
                    text: "\(group.memberCount)/\(group.capacity)",
                    systemImage: "person.2.fill"
                )
                .padding(12)
            }
            .overlay(alignment: .bottomLeading) {
                GroupStatusPill(group: group)
                    .padding(12)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text(verbatim: group.name)
                    .font(.title2.bold())
                    .foregroundStyle(SpottColor.ink)
                    .accessibilityAddTraits(.isHeader)
                Label {
                    Text(verbatim: "\(group.owner.name) · \(group.regionId)")
                } icon: {
                    Image(systemName: "person.crop.circle")
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(SpottColor.muted)
            }

            GroupMemberProof(group: group, accent: groupCategoryColor(group.categoryId))

            HStack(spacing: 10) {
                followButton(group)
                if group.membershipStatus == nil, group.availableActions.contains("joinGroup") {
                    joinButton(group)
                } else if let membershipStatus = group.membershipStatus {
                    membershipLabel(membershipStatus)
                }
            }
        }
    }

    private func membershipLabel(_ status: String) -> some View {
        Label(
            status == "pending"
                ? text("groups.detail.member_pending")
                : status == "muted" ? text("groups.detail.member_muted") : text("groups.detail.member_active"),
            systemImage: status == "pending" ? "clock.fill" : "checkmark.circle.fill"
        )
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(status == "pending" ? SpottColor.amber : SpottColor.mint)
        .frame(maxWidth: .infinity, minHeight: 44)
        .background(SpottColor.surface, in: Capsule())
        .overlay(Capsule().stroke(SpottColor.hairline))
    }

    private var sectionPicker: some View {
        SpottGlassGroup(spacing: 8) {
            HStack(spacing: 8) {
                ForEach(GroupDetailSection.allCases) { item in
                    GlassChip(
                        title: text(item.titleKey),
                        systemImage: item.symbol,
                        isSelected: section == item
                    ) {
                        withAnimation(reduceMotion ? nil : SpottMotion.standard) {
                            section = item
                        }
                    }
                }
                Spacer(minLength: 0)
            }
        }
    }

    @ViewBuilder
    private func about(_ group: GroupSummary) -> some View {
        if group.description.isEmpty, group.rules.isEmpty, group.tags.isEmpty {
            SpottEmptyState(
                icon: "text.alignleft",
                title: text("groups.detail.about_empty_title"),
                message: text("groups.detail.about_empty_message")
            )
            .frame(maxWidth: .infinity)
            .padding(.vertical, 24)
        } else {
            GroupContentCard {
                VStack(alignment: .leading, spacing: 14) {
                    Label(text("groups.detail.about"), systemImage: "info.circle")
                        .font(.headline)
                    if !group.description.isEmpty {
                        Text(verbatim: group.description)
                            .font(.body)
                            .foregroundStyle(SpottColor.ink)
                            .lineSpacing(5)
                    }
                    if !group.tags.isEmpty {
                        GroupTagRow(tags: group.tags, tint: groupCategoryColor(group.categoryId))
                    }
                    if !group.rules.isEmpty {
                        Divider()
                        VStack(alignment: .leading, spacing: 6) {
                            Text(verbatim: text("groups.detail.rules"))
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
                Text(verbatim: GroupsLocalization.format("groups.announcements.count", locale: locale, announcements.count))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(SpottColor.muted)
                Spacer()
                if policy(group).canManageAnnouncements {
                    GlassIconButton(
                        systemImage: "square.and.pencil",
                        accessibilityLabel: text("groups.announcements.compose")
                    ) {
                        sheet = .announcementEditor(group, nil)
                    }
                }
            }
            if announcements.isEmpty {
                SpottEmptyState(
                    icon: "megaphone",
                    title: text("groups.announcements.empty_title"),
                    message: policy(group).canManageAnnouncements
                        ? text("groups.announcements.empty_admin")
                        : text("groups.announcements.empty_member")
                )
                .frame(maxWidth: .infinity)
                .padding(.vertical, 24)
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
                if announcementsTruncated {
                    Text(verbatim: text("groups.announcements.truncated"))
                        .font(.caption)
                        .foregroundStyle(SpottColor.muted)
                        .frame(maxWidth: .infinity)
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
                    Text(verbatim: text("groups.detail.dissolution_title"))
                        .font(.subheadline.weight(.bold))
                    if let date = group.dissolveAfter {
                        Text(verbatim: GroupsLocalization.format(
                            "groups.detail.dissolution_scheduled",
                            locale: locale,
                            date.formatted(date: .abbreviated, time: .shortened)
                        ))
                        .font(.caption)
                        .foregroundStyle(SpottColor.muted)
                    }
                    if policy(group).canDissolve {
                        Button(text("groups.detail.dissolution_review")) {
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
                group.viewerFollowing ? text("groups.detail.following") : text("groups.detail.follow"),
                systemImage: group.viewerFollowing ? "star.fill" : "star"
            )
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.capsule)
        .tint(group.viewerFollowing ? SpottColor.twilight : nil)
        .disabled(mutating)
    }

    private func joinButton(_ group: GroupSummary) -> some View {
        Button {
            startJoin(group)
        } label: {
            Label(joinTitle(group), systemImage: "person.badge.plus")
                .font(.subheadline.weight(.bold))
                .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.glassProminent)
        .buttonBorderShape(.capsule)
        .tint(SpottColor.twilight)
        .disabled(mutating)
    }

    @ViewBuilder
    private func managementMenu(_ group: GroupSummary) -> some View {
        let policy = policy(group)
        if policy.canManageAnnouncements || policy.canManageMembers || policy.canPurchaseCapacity || policy.canTransferOwnership || policy.canDissolve {
            Menu {
                if policy.canManageAnnouncements {
                    Button(text("groups.announcements.compose"), systemImage: "megaphone") {
                        sheet = .announcementEditor(group, nil)
                    }
                }
                if policy.canManageMembers {
                    Button(text("groups.detail.menu_members"), systemImage: "person.2.badge.gearshape") {
                        sheet = .members(group)
                    }
                    Button(text("groups.detail.menu_invite"), systemImage: "link.badge.plus") {
                        sheet = .invite(group)
                    }
                }
                if policy.canPurchaseCapacity {
                    Divider()
                    Button(text("groups.detail.menu_capacity"), systemImage: "person.3.fill") {
                        sheet = .capacity(group)
                    }
                }
                if policy.canTransferOwnership {
                    Button(text("groups.detail.menu_cover"), systemImage: "photo") {
                        sheet = .cover(group)
                    }
                    Button(text("groups.detail.menu_transfer"), systemImage: "arrow.left.arrow.right") {
                        sheet = .transfer(group)
                    }
                }
                if policy.canDissolve {
                    Divider()
                    Button(
                        group.status == "closing" ? text("groups.detail.menu_dissolve_plan") : text("groups.detail.menu_dissolve"),
                        systemImage: "hourglass",
                        role: group.status == "closing" ? nil : .destructive
                    ) {
                        sheet = .dissolution(group)
                    }
                }
            } label: {
                Image(systemName: "ellipsis")
            }
            .accessibilityLabel(Text(verbatim: text("groups.detail.manage")))
        }
    }

    private func joinTitle(_ group: GroupSummary) -> String {
        switch group.joinMode {
        case .open: text("groups.detail.join_open")
        case .approval: text("groups.detail.join_approval")
        case .inviteOnly: text("groups.detail.join_invite")
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
        discussionStore = GroupDiscussionStore(groupID: groupID, service: model.api)
        defer { loading = false }
        do {
            async let loadedGroup = model.api.group(identifier: groupID.uuidString.lowercased())
            async let loadedAnnouncements = model.api.groupAnnouncements(id: groupID)
            let (group, page) = try await (loadedGroup, loadedAnnouncements)
            self.group = group
            announcements = page.items
            announcementsTruncated = page.hasMore
        } catch is CancellationError {
            return
        } catch {
            self.error = AppModel.map(error)
        }
    }

    private func refreshCurrentSection() async {
        await loadAll()
        if section == .discussion,
           let group,
           group.membershipStatus == "active" || group.membershipStatus == "muted" {
            await discussionStore?.refresh()
        }
    }

    private func loadAnnouncements() async {
        do {
            let page = try await model.api.groupAnnouncements(id: groupID)
            announcements = page.items
            announcementsTruncated = page.hasMore
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

    private func startJoin(_ group: GroupSummary) {
        guard model.session != nil else {
            model.presentedGate = .login
            return
        }
        if group.joinMode == .inviteOnly {
            sheet = .join(group)
        } else {
            performJoin(group, inviteCode: nil)
        }
    }

    private func performJoin(_ group: GroupSummary, inviteCode: String?) {
        model.requireTrust(for: .joinGroup) {
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

    private func text(_ key: String.LocalizationValue) -> String {
        GroupsLocalization.text(key, locale: locale)
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
    case report(GroupSummary)

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
        case .report: "report"
        }
    }
}
