import SwiftUI

protocol GroupDiscussionServing: Sendable {
    func groupDiscussion(groupID: UUID, cursor: String?, limit: Int) async throws -> GroupDiscussionPage
    func postGroupDiscussion(groupID: UUID, body: String, locale: String) async throws -> GroupDiscussionPost
    func discussionReplies(groupID: UUID, postID: UUID, cursor: String?, limit: Int) async throws -> GroupDiscussionReplyPage
    func postDiscussionReply(groupID: UUID, postID: UUID, body: String, locale: String) async throws -> GroupDiscussionPost
    func setDiscussionLike(groupID: UUID, commentID: UUID, liked: Bool) async throws -> GroupDiscussionLikeMutation
    func moderateDiscussion(groupID: UUID, commentID: UUID, status: String) async throws -> GroupDiscussionModerationResult
}

extension SpottAPIClient: GroupDiscussionServing {}

@MainActor
@Observable
final class GroupDiscussionStore {
    static let bodyLimit = 2_000
    static let pageSize = 20

    private let groupID: UUID
    private let service: GroupDiscussionServing

    private(set) var posts: [GroupDiscussionPost] = []
    private(set) var hasMore = false
    private(set) var loading = false
    private(set) var loadingMore = false
    private(set) var posting = false
    private(set) var hasLoaded = false
    private(set) var replies: [UUID: [GroupDiscussionPost]] = [:]
    private(set) var loadingReplies: Set<UUID> = []
    private(set) var replyBusy: Set<UUID> = []
    private(set) var likeBusy: Set<UUID> = []
    private(set) var moderationBusy: Set<UUID> = []
    var error: UserFacingError?
    private var nextCursor: String?
    /// Bumped by refresh() so a loadMore() that raced a pull-to-refresh cannot
    /// append a stale page or overwrite the cursor from the pre-refresh sequence.
    private var pageGeneration = 0

    init(groupID: UUID, service: GroupDiscussionServing) {
        self.groupID = groupID
        self.service = service
    }

    func loadIfNeeded() async {
        guard !hasLoaded, !loading else { return }
        await refresh()
    }

    func refresh() async {
        pageGeneration += 1
        let generation = pageGeneration
        loading = true
        error = nil
        defer { loading = false }
        do {
            let page = try await service.groupDiscussion(
                groupID: groupID,
                cursor: nil,
                limit: Self.pageSize
            )
            guard generation == pageGeneration else { return }
            posts = page.items
            hasMore = page.hasMore
            nextCursor = page.nextCursor
            hasLoaded = true
        } catch is CancellationError {
            return
        } catch {
            guard generation == pageGeneration else { return }
            self.error = AppModel.map(error)
        }
    }

    func loadMore() async {
        guard hasMore, !loadingMore, let cursor = nextCursor else { return }
        let generation = pageGeneration
        loadingMore = true
        defer { loadingMore = false }
        do {
            let page = try await service.groupDiscussion(
                groupID: groupID,
                cursor: cursor,
                limit: Self.pageSize
            )
            guard generation == pageGeneration else { return }
            let known = Set(posts.map(\.id))
            posts.append(contentsOf: page.items.filter { !known.contains($0.id) })
            hasMore = page.hasMore
            nextCursor = page.nextCursor
        } catch is CancellationError {
            return
        } catch {
            guard generation == pageGeneration else { return }
            self.error = AppModel.map(error)
        }
    }

    func post(body: String, locale: String) async -> Bool {
        let trimmed = body.trimmed
        guard !trimmed.isEmpty, trimmed.count <= Self.bodyLimit, !posting else { return false }
        posting = true
        error = nil
        defer { posting = false }
        do {
            let created = try await service.postGroupDiscussion(
                groupID: groupID,
                body: trimmed,
                locale: locale
            )
            posts.insert(created, at: 0)
            return true
        } catch {
            self.error = AppModel.map(error)
            return false
        }
    }

    func loadReplies(for postID: UUID) async {
        guard !loadingReplies.contains(postID) else { return }
        loadingReplies.insert(postID)
        defer { loadingReplies.remove(postID) }
        do {
            let page = try await service.discussionReplies(
                groupID: groupID,
                postID: postID,
                cursor: nil,
                limit: 50
            )
            replies[postID] = page.items
        } catch is CancellationError {
            return
        } catch {
            self.error = AppModel.map(error)
        }
    }

    func postReply(to postID: UUID, body: String, locale: String) async -> Bool {
        let trimmed = body.trimmed
        guard !trimmed.isEmpty, trimmed.count <= Self.bodyLimit, !replyBusy.contains(postID) else { return false }
        replyBusy.insert(postID)
        error = nil
        defer { replyBusy.remove(postID) }
        do {
            let created = try await service.postDiscussionReply(
                groupID: groupID,
                postID: postID,
                body: trimmed,
                locale: locale
            )
            replies[postID, default: []].append(created)
            if let index = posts.firstIndex(where: { $0.id == postID }) {
                posts[index] = adjusted(posts[index], replyCountDelta: 1)
            }
            return true
        } catch {
            self.error = AppModel.map(error)
            return false
        }
    }

    func toggleLike(_ post: GroupDiscussionPost) async {
        guard !likeBusy.contains(post.id) else { return }
        let target = !post.viewerLiked
        likeBusy.insert(post.id)
        error = nil
        defer { likeBusy.remove(post.id) }
        apply(postID: post.id) { adjusted($0, liked: target) }
        do {
            _ = try await service.setDiscussionLike(
                groupID: groupID,
                commentID: post.id,
                liked: target
            )
        } catch {
            apply(postID: post.id) { adjusted($0, liked: !target) }
            self.error = AppModel.map(error)
        }
    }

    func moderate(_ post: GroupDiscussionPost, status: String) async {
        guard !moderationBusy.contains(post.id) else { return }
        moderationBusy.insert(post.id)
        error = nil
        defer { moderationBusy.remove(post.id) }
        do {
            _ = try await service.moderateDiscussion(
                groupID: groupID,
                commentID: post.id,
                status: status
            )
            guard status != "visible" else { return }
            if let parentID = post.parentId {
                replies[parentID]?.removeAll { $0.id == post.id }
                if let index = posts.firstIndex(where: { $0.id == parentID }) {
                    posts[index] = adjusted(posts[index], replyCountDelta: -1)
                }
            } else {
                posts.removeAll { $0.id == post.id }
                replies[post.id] = nil
            }
        } catch {
            self.error = AppModel.map(error)
        }
    }

    private func apply(postID: UUID, _ transform: (GroupDiscussionPost) -> GroupDiscussionPost) {
        if let index = posts.firstIndex(where: { $0.id == postID }) {
            posts[index] = transform(posts[index])
            return
        }
        for (parentID, thread) in replies {
            if let index = thread.firstIndex(where: { $0.id == postID }) {
                var updated = thread
                updated[index] = transform(thread[index])
                replies[parentID] = updated
                return
            }
        }
    }

    private func adjusted(
        _ post: GroupDiscussionPost,
        liked: Bool? = nil,
        replyCountDelta: Int = 0
    ) -> GroupDiscussionPost {
        let likeDelta: Int
        if let liked, liked != post.viewerLiked {
            likeDelta = liked ? 1 : -1
        } else {
            likeDelta = 0
        }
        return GroupDiscussionPost(
            id: post.id,
            groupId: post.groupId,
            author: post.author,
            body: post.body,
            parentId: post.parentId,
            locale: post.locale,
            likeCount: max(0, post.likeCount + likeDelta),
            viewerLiked: liked ?? post.viewerLiked,
            replyCount: max(0, post.replyCount + replyCountDelta),
            version: post.version,
            createdAt: post.createdAt,
            updatedAt: post.updatedAt
        )
    }
}

struct GroupDiscussionSection: View {
    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale
    let group: GroupSummary
    let policy: GroupPresentationPolicy
    let store: GroupDiscussionStore
    let onJoin: () -> Void
    @State private var draft = ""

    private var isMember: Bool {
        group.membershipStatus == "active" || group.membershipStatus == "muted"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if !isMember {
                lockedCard
            } else {
                if group.membershipStatus == "muted" {
                    mutedNote
                } else {
                    composer
                }
                threadList
            }
            if let error = store.error {
                GroupErrorBanner(error: error) { store.error = nil }
            }
        }
        .task(id: ObjectIdentifier(store)) {
            if isMember {
                await store.loadIfNeeded()
            }
        }
    }

    @ViewBuilder
    private var lockedCard: some View {
        if model.session == nil {
            SpottEmptyState(
                icon: "lock",
                title: text("groups.discussion.locked_title"),
                message: text("groups.discussion.locked_message"),
                actionTitle: text("groups.discussion.signin_action")
            ) {
                model.presentedGate = .login
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 24)
        } else if group.membershipStatus == "pending" {
            SpottEmptyState(
                icon: "clock",
                title: text("groups.discussion.pending_title"),
                message: text("groups.discussion.pending_message")
            )
            .frame(maxWidth: .infinity)
            .padding(.vertical, 24)
        } else {
            SpottEmptyState(
                icon: "lock",
                title: text("groups.discussion.locked_title"),
                message: text("groups.discussion.locked_message"),
                actionTitle: group.availableActions.contains("joinGroup") ? text("groups.discussion.join_action") : nil
            ) {
                onJoin()
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 24)
        }
    }

    private var mutedNote: some View {
        GroupContentCard(tint: SpottColor.coralPale.opacity(0.4)) {
            Label(
                text("groups.discussion.muted_note"),
                systemImage: "speaker.slash"
            )
            .font(.footnote.weight(.semibold))
            .foregroundStyle(SpottColor.muted)
        }
    }

    private var composer: some View {
        GroupContentCard {
            VStack(alignment: .leading, spacing: 10) {
                TextField(
                    text("groups.discussion.composer_placeholder"),
                    text: $draft,
                    axis: .vertical
                )
                .lineLimit(2...6)
                HStack {
                    Text(verbatim: "\(draft.count) / \(GroupDiscussionStore.bodyLimit)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(
                            draft.count > GroupDiscussionStore.bodyLimit ? SpottColor.danger : SpottColor.muted
                        )
                    Spacer()
                    Button {
                        submit()
                    } label: {
                        if store.posting {
                            ProgressView()
                        } else {
                            Label(text("groups.discussion.post"), systemImage: "paperplane.fill")
                                .font(.subheadline.weight(.semibold))
                        }
                    }
                    .buttonStyle(.glassProminent)
                    .buttonBorderShape(.capsule)
                    .tint(SpottColor.twilight)
                    .disabled(
                        draft.trimmed.isEmpty
                            || draft.trimmed.count > GroupDiscussionStore.bodyLimit
                            || store.posting
                    )
                }
            }
        }
    }

    @ViewBuilder
    private var threadList: some View {
        if store.loading, store.posts.isEmpty {
            VStack(spacing: 12) {
                ForEach(0..<3, id: \.self) { _ in
                    RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous)
                        .fill(SpottColor.surface)
                        .frame(height: 110)
                        .spottSkeleton()
                }
            }
        } else if store.hasLoaded, store.posts.isEmpty {
            SpottEmptyState(
                icon: "bubble.left.and.bubble.right",
                title: text("groups.discussion.empty_title"),
                message: text("groups.discussion.empty_message")
            )
            .frame(maxWidth: .infinity)
            .padding(.vertical, 24)
        } else {
            ForEach(store.posts) { post in
                GroupDiscussionPostCard(
                    group: group,
                    post: post,
                    policy: policy,
                    store: store
                )
            }
            if store.hasMore {
                Button {
                    Task { await store.loadMore() }
                } label: {
                    if store.loadingMore {
                        ProgressView()
                            .frame(maxWidth: .infinity, minHeight: 44)
                    } else {
                        Text(text("groups.discussion.load_more"))
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                }
                .buttonStyle(.glass)
                .disabled(store.loadingMore)
            }
        }
    }

    private func submit() {
        Task {
            if await store.post(body: draft, locale: groupContentLocale()) {
                draft = ""
            }
        }
    }

    private func text(_ key: String.LocalizationValue) -> String {
        GroupsLocalization.text(key, locale: locale)
    }
}

private struct GroupDiscussionPostCard: View {
    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let group: GroupSummary
    let post: GroupDiscussionPost
    let policy: GroupPresentationPolicy
    let store: GroupDiscussionStore
    @State private var repliesExpanded = false
    @State private var replyDraft = ""

    private var canPost: Bool { group.membershipStatus == "active" }

    var body: some View {
        GroupContentCard {
            VStack(alignment: .leading, spacing: 10) {
                header(for: post)
                Text(verbatim: post.body)
                    .font(.subheadline)
                    .foregroundStyle(SpottColor.ink)
                    .lineSpacing(4)
                actionRow
                if repliesExpanded {
                    replyThread
                }
            }
        }
        .contextMenu {
            if policy.canModerateDiscussion {
                Button(text("groups.discussion.moderate.visible"), systemImage: "eye") {
                    Task { await store.moderate(post, status: "visible") }
                }
                Button(text("groups.discussion.moderate.hidden"), systemImage: "eye.slash") {
                    Task { await store.moderate(post, status: "hidden") }
                }
                Button(text("groups.discussion.moderate.removed"), systemImage: "trash", role: .destructive) {
                    Task { await store.moderate(post, status: "removed") }
                }
            }
        }
    }

    private func header(for post: GroupDiscussionPost) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(verbatim: post.author.name)
                .font(.subheadline.weight(.bold))
            Spacer()
            Text(
                post.createdAt.formatted(
                    .relative(presentation: .named)
                        .locale(locale)
                )
            )
            .font(.caption)
            .foregroundStyle(SpottColor.muted)
        }
    }

    private var actionRow: some View {
        HStack(spacing: 16) {
            Button {
                Task { await store.toggleLike(post) }
            } label: {
                Label(
                    "\(post.likeCount)",
                    systemImage: post.viewerLiked ? "heart.fill" : "heart"
                )
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(post.viewerLiked ? SpottColor.coral : SpottColor.muted)
                .frame(minHeight: 44)
            }
            .buttonStyle(.plain)
            .disabled(store.likeBusy.contains(post.id))
            .accessibilityLabel(Text(verbatim: text("groups.discussion.like_a11y")))
            .accessibilityValue(Text(verbatim: "\(post.likeCount)"))

            Button {
                toggleReplies()
            } label: {
                Label(
                    post.replyCount > 0
                        ? GroupsLocalization.format("groups.discussion.replies_count", locale: locale, post.replyCount)
                        : text("groups.discussion.reply"),
                    systemImage: "bubble.left"
                )
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(SpottColor.muted)
                .frame(minHeight: 44)
            }
            .buttonStyle(.plain)
            Spacer()
        }
    }

    @ViewBuilder
    private var replyThread: some View {
        VStack(alignment: .leading, spacing: 10) {
            Divider()
            if store.loadingReplies.contains(post.id) {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 4)
            } else if let thread = store.replies[post.id] {
                if thread.isEmpty {
                    Text(verbatim: text("groups.discussion.no_replies"))
                        .font(.caption)
                        .foregroundStyle(SpottColor.muted)
                } else {
                    ForEach(thread) { reply in
                        replyRow(reply)
                    }
                }
            }
            if canPost {
                replyComposer
            }
            Button(text("groups.discussion.hide_replies")) {
                withAnimation(reduceMotion ? nil : SpottMotion.standard) {
                    repliesExpanded = false
                }
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(SpottColor.muted)
            .frame(minHeight: 32)
            .buttonStyle(.plain)
        }
    }

    private func replyRow(_ reply: GroupDiscussionPost) -> some View {
        HStack(alignment: .top, spacing: 8) {
            RoundedRectangle(cornerRadius: 2)
                .fill(SpottColor.twilightPale)
                .frame(width: 3)
            VStack(alignment: .leading, spacing: 4) {
                header(for: reply)
                Text(verbatim: reply.body)
                    .font(.footnote)
                    .foregroundStyle(SpottColor.ink)
                    .lineSpacing(3)
            }
        }
        .padding(.leading, 4)
        .contextMenu {
            if policy.canModerateDiscussion {
                Button(text("groups.discussion.moderate.hidden"), systemImage: "eye.slash") {
                    Task { await store.moderate(reply, status: "hidden") }
                }
                Button(text("groups.discussion.moderate.removed"), systemImage: "trash", role: .destructive) {
                    Task { await store.moderate(reply, status: "removed") }
                }
            }
        }
    }

    private var replyComposer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(
                text("groups.discussion.reply_placeholder"),
                text: $replyDraft,
                axis: .vertical
            )
            .lineLimit(1...4)
            .font(.footnote)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(SpottColor.canvas, in: RoundedRectangle(cornerRadius: SpottMetric.controlRadius, style: .continuous))
            Button {
                submitReply()
            } label: {
                if store.replyBusy.contains(post.id) {
                    ProgressView()
                        .frame(width: 44, height: 44)
                } else {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 14, weight: .bold))
                        .frame(width: 44, height: 44)
                }
            }
            .buttonStyle(.glassProminent)
            .buttonBorderShape(.circle)
            .tint(SpottColor.twilight)
            .disabled(
                replyDraft.trimmed.isEmpty
                    || replyDraft.trimmed.count > GroupDiscussionStore.bodyLimit
                    || store.replyBusy.contains(post.id)
            )
            .accessibilityLabel(Text(verbatim: text("groups.discussion.post")))
        }
    }

    private func toggleReplies() {
        if repliesExpanded {
            withAnimation(reduceMotion ? nil : SpottMotion.standard) {
                repliesExpanded = false
            }
        } else {
            withAnimation(reduceMotion ? nil : SpottMotion.standard) {
                repliesExpanded = true
            }
            if store.replies[post.id] == nil {
                Task { await store.loadReplies(for: post.id) }
            }
        }
    }

    private func submitReply() {
        Task {
            if await store.postReply(to: post.id, body: replyDraft, locale: groupContentLocale()) {
                replyDraft = ""
            }
        }
    }

    private func text(_ key: String.LocalizationValue) -> String {
        GroupsLocalization.text(key, locale: locale)
    }
}
