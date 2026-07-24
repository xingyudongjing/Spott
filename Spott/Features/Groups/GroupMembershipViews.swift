import SwiftUI

struct JoinGroupView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    let group: GroupSummary
    let completion: () async -> Void
    @State private var inviteCode = ""
    @State private var busy = false
    @State private var error: UserFacingError?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent(text("groups.join.group_label")) {
                        Text(verbatim: group.name)
                    }
                    LabeledContent(text("groups.join.mode_label"), value: joinModeTitle(group.joinMode, locale: locale))
                    if group.joinMode == .inviteOnly {
                        TextField(text("groups.join.invite_code"), text: $inviteCode)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                    }
                } header: {
                    Text(verbatim: text("groups.join.title"))
                } footer: {
                    Text(verbatim: joinModeExplanation(group.joinMode))
                }
                if let error {
                    Section {
                        Text(verbatim: GroupsLocalization.format("groups.common.error_inline", locale: locale, error.message, error.id))
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
                            Text(verbatim: group.joinMode == .approval
                                ? text("groups.join.submit_approval")
                                : text("groups.join.submit"))
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .spottProminentActionStyle()
                    .disabled(readiness == .inviteRequired || busy)
                }
            }
            .scrollContentBackground(.hidden)
            .background(SpottColor.canvas)
            .navigationTitle(Text(verbatim: text("groups.join.title")))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(text("groups.common.cancel")) { dismiss() }
                }
            }
        }
    }

    private var readiness: GroupJoinReadiness {
        GroupJoinReadiness(mode: group.joinMode, rawInviteCode: inviteCode)
    }

    private func joinModeExplanation(_ mode: GroupJoinMode) -> String {
        switch mode {
        case .open: text("groups.join.explain_open")
        case .approval: text("groups.join.explain_approval")
        case .inviteOnly: text("groups.join.explain_invite")
        }
    }

    private func join() {
        guard model.session != nil else {
            dismiss()
            model.presentedGate = .login
            return
        }
        guard model.session?.user.phoneVerified == true else {
            dismiss()
            model.presentedGate = .phoneVerification
            return
        }
        guard case .ready(let code) = readiness else { return }
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

    private func text(_ key: String.LocalizationValue) -> String {
        GroupsLocalization.text(key, locale: locale)
    }
}

struct GroupMembersView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale
    let group: GroupSummary
    @State private var members: [GroupMember] = []
    @State private var truncated = false
    @State private var filter = "all"
    @State private var loading = true
    @State private var busyMemberID: UUID?
    @State private var error: UserFacingError?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker(text("groups.members.filter_label"), selection: $filter) {
                        Text(verbatim: text("groups.members.filter_all")).tag("all")
                        Text(verbatim: text("groups.members.filter_pending")).tag("pending")
                        Text(verbatim: text("groups.members.filter_active")).tag("active")
                        Text(verbatim: text("groups.members.filter_muted")).tag("muted")
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
                            text("groups.members.empty_title"),
                            systemImage: "person.2",
                            description: Text(verbatim: text("groups.members.empty_message"))
                        )
                    }
                } else {
                    Section(GroupsLocalization.format("groups.members.section", locale: locale, filteredMembers.count)) {
                        ForEach(filteredMembers) { member in
                            memberRow(member)
                        }
                        if truncated {
                            Text(verbatim: text("groups.members.truncated"))
                                .font(.caption)
                                .foregroundStyle(SpottColor.muted)
                                .frame(maxWidth: .infinity)
                        }
                    }
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
            .navigationTitle(Text(verbatim: text("groups.members.title")))
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
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(verbatim: member.user.name)
                        .font(.subheadline.weight(.bold))
                    GroupRolePill(role: member.role)
                }
                Text(verbatim: "@\(member.user.handle) · \(memberStatusTitle(member.status, locale: locale))")
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
            }
            Spacer()
            if busyMemberID == member.id {
                ProgressView()
            } else if member.role != "owner" {
                Menu {
                    if member.status == "pending" {
                        Button(text("groups.members.approve"), systemImage: "checkmark.circle") {
                            update(member, status: "active")
                        }
                        Button(text("groups.members.reject"), systemImage: "xmark.circle", role: .destructive) {
                            update(member, status: "removed")
                        }
                    } else if member.status == "active" {
                        Button(text("groups.members.mute"), systemImage: "speaker.slash") {
                            update(member, status: "muted")
                        }
                        Button(text("groups.members.remove"), systemImage: "person.badge.minus", role: .destructive) {
                            update(member, status: "removed")
                        }
                    } else if member.status == "muted" {
                        Button(text("groups.members.unmute"), systemImage: "speaker.wave.2") {
                            update(member, status: "active")
                        }
                        Button(text("groups.members.remove"), systemImage: "person.badge.minus", role: .destructive) {
                            update(member, status: "removed")
                        }
                    }
                    if group.membershipRole == "owner", member.status == "active" {
                        Divider()
                        Button(
                            member.role == "admin" ? text("groups.members.demote") : text("groups.members.promote"),
                            systemImage: member.role == "admin" ? "star.slash" : "star"
                        ) {
                            update(member, role: member.role == "admin" ? "member" : "admin")
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .font(.title3)
                }
                .accessibilityLabel(Text(verbatim: text("groups.members.actions_a11y")))
            }
        }
        .padding(.vertical, 4)
    }

    private func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let page = try await model.api.groupMembers(id: group.id)
            members = page.items
            truncated = page.hasMore
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

    private func text(_ key: String.LocalizationValue) -> String {
        GroupsLocalization.text(key, locale: locale)
    }
}

struct GroupInviteView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale
    let group: GroupSummary
    @State private var maxUses = 1
    @State private var expiresInHours = 168
    @State private var invite: GroupInvite?
    @State private var busy = false
    @State private var error: UserFacingError?

    var body: some View {
        NavigationStack {
            Form {
                Section(text("groups.invite.settings")) {
                    Stepper(
                        GroupsLocalization.format("groups.invite.uses", locale: locale, maxUses),
                        value: $maxUses,
                        in: 1...1_000
                    )
                    Picker(text("groups.invite.expiry"), selection: $expiresInHours) {
                        Text(verbatim: text("groups.invite.expiry_day")).tag(24)
                        Text(verbatim: text("groups.invite.expiry_week")).tag(168)
                        Text(verbatim: text("groups.invite.expiry_month")).tag(720)
                    }
                }
                if let invite {
                    Section(text("groups.invite.generated")) {
                        Text(verbatim: invite.code)
                            .font(.system(.title3, design: .monospaced, weight: .bold))
                            .textSelection(.enabled)
                        LabeledContent(
                            text("groups.invite.expires_at"),
                            value: invite.expiresAt.formatted(date: .abbreviated, time: .shortened)
                        )
                        ShareLink(
                            item: invite.code,
                            subject: Text(verbatim: GroupsLocalization.format("groups.invite.share_subject", locale: locale, group.name)),
                            message: Text(verbatim: GroupsLocalization.format("groups.invite.share_message", locale: locale, group.name))
                        ) {
                            Label(text("groups.invite.share"), systemImage: "square.and.arrow.up")
                        }
                    }
                }
                if let error {
                    Section {
                        Text(verbatim: GroupsLocalization.format("groups.common.error_inline", locale: locale, error.message, error.id))
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
                            Text(verbatim: invite == nil
                                ? text("groups.invite.generate")
                                : text("groups.invite.regenerate"))
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .spottProminentActionStyle()
                    .disabled(busy)
                }
            }
            .scrollContentBackground(.hidden)
            .background(SpottColor.canvas)
            .navigationTitle(Text(verbatim: text("groups.invite.title")))
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

    private func text(_ key: String.LocalizationValue) -> String {
        GroupsLocalization.text(key, locale: locale)
    }
}

struct GroupCapacityView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    let group: GroupSummary
    let completion: (GroupSummary) -> Void
    @State private var quote: Quote?
    @State private var loading = true
    @State private var busy = false
    @State private var error: UserFacingError?

    var body: some View {
        NavigationStack {
            Form {
                Section(text("groups.capacity.section")) {
                    LabeledContent(
                        text("groups.capacity.current"),
                        value: GroupsLocalization.format("groups.capacity.people", locale: locale, group.capacity)
                    )
                    LabeledContent(
                        text("groups.capacity.after"),
                        value: GroupsLocalization.format("groups.capacity.people", locale: locale, min(group.capacity + 50, 500))
                    )
                    Text(verbatim: text("groups.capacity.explain"))
                        .font(.caption)
                        .foregroundStyle(SpottColor.muted)
                }
                Section(text("groups.capacity.quote_section")) {
                    if loading {
                        HStack {
                            ProgressView()
                            Text(verbatim: text("groups.capacity.quote_loading"))
                        }
                    } else if let quote {
                        LabeledContent(
                            text("groups.capacity.quote_amount"),
                            value: GroupsLocalization.format("groups.capacity.points", locale: locale, quote.amount)
                        )
                        LabeledContent(
                            text("groups.capacity.quote_expires"),
                            value: quote.expiresAt.formatted(date: .omitted, time: .shortened)
                        )
                    }
                }
                if let error {
                    Section {
                        Text(verbatim: GroupsLocalization.format("groups.common.error_inline", locale: locale, error.message, error.id))
                            .foregroundStyle(SpottColor.danger)
                        Button(text("groups.capacity.requote")) {
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
                                Text(verbatim: GroupsLocalization.format("groups.capacity.confirm", locale: locale, quote.amount))
                                    .frame(maxWidth: .infinity)
                            }
                        }
                        .spottProminentActionStyle()
                        .disabled(busy || quote.expiresAt <= .now)
                    } footer: {
                        Text(verbatim: text("groups.capacity.footer"))
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(SpottColor.canvas)
            .navigationTitle(Text(verbatim: text("groups.capacity.title")))
            .task { await loadQuote() }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(text("groups.common.close")) { dismiss() }
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

    private func text(_ key: String.LocalizationValue) -> String {
        GroupsLocalization.text(key, locale: locale)
    }
}
