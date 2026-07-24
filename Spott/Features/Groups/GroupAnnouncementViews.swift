import SwiftUI

struct GroupAnnouncementCard: View {
    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale
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
                                Label(text("groups.announcements.pinned"), systemImage: "pin.fill")
                                    .font(.caption2.weight(.bold))
                                    .foregroundStyle(SpottColor.coral)
                            }
                            Text(verbatim: announcement.visibility == "public"
                                ? text("groups.announcements.visibility_public")
                                : text("groups.announcements.visibility_members"))
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(SpottColor.muted)
                        }
                        Text(verbatim: announcement.title)
                            .font(.headline)
                            .foregroundStyle(SpottColor.ink)
                    }
                    Spacer()
                    if canManage {
                        Menu {
                            Button(text("groups.announcements.edit"), systemImage: "pencil", action: onEdit)
                            Button(text("groups.announcements.delete"), systemImage: "trash", role: .destructive) {
                                deleteConfirmation = true
                            }
                        } label: {
                            Image(systemName: "ellipsis.circle")
                                .foregroundStyle(SpottColor.muted)
                                .frame(width: 44, height: 44, alignment: .topTrailing)
                        }
                        .accessibilityLabel(Text(verbatim: text("groups.announcements.manage_a11y")))
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
                        .frame(minHeight: 44)
                    }
                    .buttonStyle(.plain)
                    .disabled(busy || !canReact)
                    .accessibilityLabel(Text(verbatim: text("groups.announcements.like_a11y")))
                    .accessibilityValue(Text(verbatim: "\(announcement.likeCount)"))

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
                            announcement.commentsEnabled
                                ? "\(announcement.commentCount)"
                                : text("groups.announcements.comments_disabled"),
                            systemImage: announcement.commentsEnabled ? "bubble.left" : "bubble.left.slash"
                        )
                        .frame(minHeight: 44)
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
                    Text(verbatim: GroupsLocalization.format("groups.common.error_inline", locale: locale, error.message, error.id))
                        .font(.caption)
                        .foregroundStyle(SpottColor.danger)
                }
            }
        }
        .confirmationDialog(
            text("groups.announcements.delete_confirm_title"),
            isPresented: $deleteConfirmation,
            titleVisibility: .visible
        ) {
            Button(text("groups.announcements.delete"), role: .destructive) { deleteAnnouncement() }
            Button(text("groups.common.cancel"), role: .cancel) {}
        } message: {
            Text(verbatim: text("groups.announcements.delete_confirm_message"))
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

    private func text(_ key: String.LocalizationValue) -> String {
        GroupsLocalization.text(key, locale: locale)
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
        .background(SpottScreenBackground())
        .navigationTitle(Text(verbatim: text("groups.announcements.detail_title")))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if canManage {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(text("groups.announcements.edit_button"), systemImage: "pencil") {
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
            text("groups.comments.delete_confirm_title"),
            isPresented: Binding(
                get: { deleteTarget != nil },
                set: { if !$0 { deleteTarget = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button(text("groups.comments.delete_confirm"), role: .destructive) {
                if let deleteTarget { deleteComment(deleteTarget) }
            }
            Button(text("groups.common.cancel"), role: .cancel) { deleteTarget = nil }
        }
    }

    private var announcementBody: some View {
        GroupContentCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    if announcement.pinnedAt != nil {
                        Label(text("groups.announcements.pinned_full"), systemImage: "pin.fill")
                            .foregroundStyle(SpottColor.coral)
                    }
                    Spacer()
                    Text(verbatim: announcement.visibility == "public"
                        ? text("groups.announcements.visibility_public")
                        : text("groups.announcements.visibility_members"))
                        .foregroundStyle(SpottColor.muted)
                }
                .font(.caption.weight(.semibold))
                Text(verbatim: announcement.title)
                    .font(.title3.bold())
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
                .buttonStyle(.glass)
                .buttonBorderShape(.capsule)
                .disabled(busy || !canReact)
                .accessibilityLabel(Text(verbatim: text("groups.announcements.like_a11y")))
                .accessibilityValue(Text(verbatim: "\(announcement.likeCount)"))
            }
        }
    }

    private var commentsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(verbatim: text("groups.comments.title"))
                    .font(.title3.bold())
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                Text(verbatim: GroupsLocalization.format("groups.comments.count", locale: locale, comments.count))
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
                        announcement.commentsEnabled
                            ? text("groups.comments.empty")
                            : text("groups.comments.disabled"),
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
                        TextField(text("groups.comments.placeholder"), text: $draft, axis: .vertical)
                            .lineLimit(2...6)
                        HStack {
                            Text(verbatim: "\(draft.count) / 2000")
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(SpottColor.muted)
                            Spacer()
                            Button(text("groups.comments.post"), systemImage: "paperplane.fill") {
                                createComment()
                            }
                            .buttonStyle(.glassProminent)
                            .buttonBorderShape(.capsule)
                            .tint(SpottColor.twilight)
                            .disabled(draft.trimmed.isEmpty || draft.count > 2_000 || busy)
                        }
                    }
                }
            } else if announcement.commentsEnabled, model.session == nil {
                Button(text("groups.comments.signin")) {
                    model.presentedGate = .login
                }
                .buttonStyle(.glass)
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
                Button(text("groups.comments.edit"), systemImage: "pencil") {
                    editTarget = CommentEditTarget(comment: comment)
                }
                Button(text("groups.comments.delete"), systemImage: "trash", role: .destructive) {
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
                    locale: groupContentLocale()
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

    private func text(_ key: String.LocalizationValue) -> String {
        GroupsLocalization.text(key, locale: locale)
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

    init(comment: GroupComment, completion: @escaping (GroupComment) -> Void) {
        self.comment = comment
        self.completion = completion
        _commentText = State(initialValue: comment.body)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section(text("groups.comments.editor_section")) {
                    TextField(text("groups.comments.editor_placeholder"), text: $commentText, axis: .vertical)
                        .lineLimit(4...12)
                    Text(verbatim: "\(commentText.count) / 2000")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(SpottColor.muted)
                }
                if let error {
                    Section {
                        Text(verbatim: GroupsLocalization.format("groups.common.error_inline", locale: locale, error.message, error.id))
                            .foregroundStyle(SpottColor.danger)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(SpottColor.canvas)
            .navigationTitle(Text(verbatim: text("groups.comments.editor_title")))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(text("groups.common.cancel")) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? text("groups.common.saving") : text("groups.common.save")) { save() }
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

    private func text(_ key: String.LocalizationValue) -> String {
        GroupsLocalization.text(key, locale: locale)
    }
}

struct GroupAnnouncementEditor: View {
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
                Section(text("groups.announcement_editor.content_section")) {
                    TextField(text("groups.announcement_editor.title_placeholder"), text: $title)
                    TextField(text("groups.announcement_editor.body_placeholder"), text: $announcementBody, axis: .vertical)
                        .lineLimit(6...16)
                }
                Section {
                    Picker(text("groups.announcement_editor.visibility_label"), selection: $visibility) {
                        Text(verbatim: text("groups.announcement_editor.visibility_public")).tag("public")
                        Text(verbatim: text("groups.announcement_editor.visibility_members")).tag("members")
                    }
                    Toggle(text("groups.announcement_editor.comments_toggle"), isOn: $commentsEnabled)
                } header: {
                    Text(verbatim: text("groups.announcement_editor.visibility_section"))
                } footer: {
                    Text(verbatim: text("groups.announcement_editor.footer"))
                }
                if let error {
                    Section {
                        Text(verbatim: GroupsLocalization.format("groups.common.error_inline", locale: locale, error.message, error.id))
                            .foregroundStyle(SpottColor.danger)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(SpottColor.canvas)
            .navigationTitle(Text(verbatim: announcement == nil
                ? text("groups.announcement_editor.title_new")
                : text("groups.announcement_editor.title_edit")))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(text("groups.common.cancel")) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? text("groups.common.saving") : text("groups.common.save")) { save() }
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

    private func text(_ key: String.LocalizationValue) -> String {
        GroupsLocalization.text(key, locale: locale)
    }
}
