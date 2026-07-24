import PhotosUI
import SwiftUI
import UIKit

struct GroupCoverEditor: View {
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
                    } else {
                        EventCoverView(
                            url: group.coverURL,
                            category: groupCoverCategory(group.categoryId),
                            cornerRadius: 0
                        )
                    }
                }
                .frame(maxWidth: .infinity)
                .frame(height: 210)
                .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 26).stroke(SpottColor.divider))

                Text(verbatim: text("groups.cover.explain"))
                    .font(.subheadline)
                    .foregroundStyle(SpottColor.muted)
                    .lineSpacing(4)

                PhotosPicker(selection: $selection, matching: .images) {
                    Label(
                        group.coverURL == nil ? text("groups.cover.choose") : text("groups.cover.replace"),
                        systemImage: "photo.on.rectangle.angled"
                    )
                    .frame(maxWidth: .infinity)
                }
                .spottProminentActionStyle()
                .disabled(busy)

                if busy { ProgressView(text("groups.cover.processing")) }
                if let error {
                    Label(
                        GroupsLocalization.format("groups.common.error_inline", locale: locale, error.message, error.id),
                        systemImage: "exclamationmark.triangle.fill"
                    )
                    .font(.caption)
                    .foregroundStyle(SpottColor.danger)
                }
                Spacer()
            }
            .padding(SpottMetric.pageInset)
            .background(SpottColor.canvas.ignoresSafeArea())
            .navigationTitle(Text(verbatim: text("groups.cover.title")))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(text("groups.common.close")) { dismiss() }
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
            guard let data = try await item.loadTransferable(type: Data.self),
                  let image = UIImage(data: data),
                  let jpeg = image.jpegData(compressionQuality: 0.86)
            else {
                throw APIError(
                    status: 0,
                    code: "IMAGE_INVALID",
                    message: text("groups.common.image_invalid"),
                    retryable: false
                )
            }
            _ = try await model.api.uploadGroupCover(
                data: jpeg,
                filename: "group-cover.jpg",
                mimeType: "image/jpeg",
                groupID: group.id
            )
            previewImage = image
            await completion()
            dismiss()
        } catch {
            self.error = AppModel.map(error)
        }
    }

    private func text(_ key: String.LocalizationValue) -> String {
        GroupsLocalization.text(key, locale: locale)
    }
}

struct GroupTransferView: View {
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

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(verbatim: text("groups.transfer.explain"))
                        .font(.subheadline)
                        .foregroundStyle(SpottColor.muted)
                }
                if let lifecycle {
                    transferStatus(lifecycle)
                } else if group.status == "transfer_pending" {
                    Section(text("groups.transfer.in_progress_section")) {
                        Label(text("groups.transfer.in_progress"), systemImage: "clock.arrow.2.circlepath")
                        Text(verbatim: text("groups.transfer.in_progress_note"))
                            .font(.caption)
                            .foregroundStyle(SpottColor.muted)
                    }
                } else {
                    Section(text("groups.transfer.pick_section")) {
                        if loading {
                            ProgressView().frame(maxWidth: .infinity)
                        } else {
                            Picker(text("groups.transfer.member_picker"), selection: $selectedUserID) {
                                Text(verbatim: text("groups.transfer.pick_placeholder")).tag(UUID?.none)
                                ForEach(eligibleMembers) { member in
                                    Text(verbatim: "\(member.user.name) · @\(member.user.handle)")
                                        .tag(Optional(member.id))
                                }
                            }
                        }
                    }
                    Section {
                        Button(text("groups.transfer.start"), systemImage: "arrow.left.arrow.right") {
                            startTransfer()
                        }
                        .disabled(selectedUserID == nil || busy)
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
            .navigationTitle(Text(verbatim: text("groups.transfer.title")))
            .task { await loadMembers() }
        }
    }

    @ViewBuilder
    private func transferStatus(_ lifecycle: GroupLifecycleMutation) -> some View {
        Section(text("groups.transfer.status_section")) {
            Label(transferStateTitle(lifecycle.state), systemImage: "arrow.left.arrow.right.circle.fill")
            if let expiresAt = lifecycle.expiresAt {
                LabeledContent(
                    text("groups.transfer.deadline"),
                    value: expiresAt.formatted(date: .abbreviated, time: .shortened)
                )
            }
            if let cooldown = lifecycle.cooldownUntil {
                LabeledContent(
                    text("groups.transfer.cooldown_end"),
                    value: cooldown.formatted(date: .abbreviated, time: .shortened)
                )
            }
            if lifecycle.state == "awaiting_target", lifecycle.toUserId == model.session?.user.id {
                Button(text("groups.transfer.accept")) { accept(lifecycle) }
                    .disabled(busy)
            }
            if lifecycle.state == "cooling_off", lifecycle.cooldownUntil ?? .distantFuture <= .now {
                Button(text("groups.transfer.complete")) { complete(lifecycle) }
                    .disabled(busy)
            }
            if lifecycle.state == "awaiting_target" || lifecycle.state == "cooling_off" {
                TextField(text("groups.transfer.cancel_reason"), text: $cancelReason, axis: .vertical)
                Button(text("groups.transfer.cancel"), role: .destructive) { cancel(lifecycle) }
                    .disabled(cancelReason.trimmed.count < 2 || busy)
            }
        }
    }

    private var eligibleMembers: [GroupMember] {
        members.filter {
            $0.status == "active" && $0.role != "owner" && $0.id != model.session?.user.id
        }
    }

    private func transferStateTitle(_ state: String) -> String {
        switch state {
        case "awaiting_target": text("groups.transfer.state_awaiting")
        case "cooling_off": text("groups.transfer.state_cooling")
        case "completed": text("groups.transfer.state_completed")
        case "cancelled": text("groups.transfer.state_cancelled")
        default: state
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

    private func text(_ key: String.LocalizationValue) -> String {
        GroupsLocalization.text(key, locale: locale)
    }
}

struct GroupDissolutionView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
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
                    Section(text("groups.dissolve.plan_section")) {
                        Label(text("groups.dissolve.notice_period"), systemImage: "hourglass")
                            .foregroundStyle(SpottColor.danger)
                        if let date = group.dissolveAfter {
                            LabeledContent(
                                text("groups.dissolve.scheduled"),
                                value: date.formatted(date: .abbreviated, time: .shortened)
                            )
                        }
                        Text(verbatim: text("groups.dissolve.revocable"))
                            .font(.caption)
                            .foregroundStyle(SpottColor.muted)
                    }
                    Section {
                        Button(text("groups.dissolve.revoke"), systemImage: "arrow.uturn.backward") {
                            cancel()
                        }
                        .disabled(busy)
                        if let date = group.dissolveAfter, date <= .now {
                            Button(text("groups.dissolve.finalize"), systemImage: "trash", role: .destructive) {
                                finalize()
                            }
                            .disabled(busy)
                        }
                    }
                } else {
                    Section {
                        Text(verbatim: text("groups.dissolve.explain"))
                            .font(.subheadline)
                            .foregroundStyle(SpottColor.muted)
                        TextField(text("groups.dissolve.reason"), text: $reason, axis: .vertical)
                            .lineLimit(3...8)
                    } header: {
                        Text(verbatim: text("groups.dissolve.section"))
                    }
                    Section {
                        Button(text("groups.dissolve.start"), role: .destructive) {
                            confirmRequest = true
                        }
                        .disabled(reason.trimmed.count < 3 || busy)
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
            .navigationTitle(Text(verbatim: text("groups.dissolve.title")))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(text("groups.common.close")) { dismiss() }
                }
            }
            .confirmationDialog(
                text("groups.dissolve.confirm_title"),
                isPresented: $confirmRequest,
                titleVisibility: .visible
            ) {
                Button(text("groups.dissolve.confirm"), role: .destructive) { request() }
                Button(text("groups.common.cancel"), role: .cancel) {}
            } message: {
                Text(verbatim: text("groups.dissolve.confirm_message"))
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

    private func text(_ key: String.LocalizationValue) -> String {
        GroupsLocalization.text(key, locale: locale)
    }
}

struct CreateGroupView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    let completion: (GroupSummary) -> Void
    @State private var name = ""
    @State private var description = ""
    @State private var joinMode = GroupJoinMode.approval
    @State private var region = "tokyo"
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

    var body: some View {
        NavigationStack {
            Form {
                Section(text("groups.create.cover_section")) {
                    if let coverPreview {
                        Image(uiImage: coverPreview)
                            .resizable()
                            .scaledToFill()
                            .frame(maxWidth: .infinity)
                            .frame(height: 150)
                            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                    }
                    PhotosPicker(selection: $coverItem, matching: .images) {
                        Label(text("groups.create.cover_pick"), systemImage: "photo.on.rectangle.angled")
                    }
                    Text(verbatim: text("groups.create.cover_note"))
                        .font(.caption)
                        .foregroundStyle(SpottColor.muted)
                }
                Section(text("groups.create.profile_section")) {
                    TextField(text("groups.create.name"), text: $name)
                    TextField(text("groups.create.description"), text: $description, axis: .vertical)
                        .lineLimit(4...10)
                    Picker(text("groups.create.join_mode"), selection: $joinMode) {
                        ForEach(GroupJoinMode.allCases) { mode in
                            Text(verbatim: joinModeTitle(mode, locale: locale)).tag(mode)
                        }
                    }
                    TextField(text("groups.create.region"), text: $region)
                    Picker(text("groups.create.category"), selection: $category) {
                        Text(verbatim: text("groups.create.category_outdoor")).tag("outdoor")
                        Text(verbatim: text("groups.create.category_culture")).tag("culture")
                        Text(verbatim: text("groups.create.category_sports")).tag("sports")
                        Text(verbatim: text("groups.create.category_family")).tag("family")
                        Text(verbatim: text("groups.create.category_language")).tag("language")
                        Text(verbatim: text("groups.create.category_technology")).tag("technology")
                        Text(verbatim: text("groups.create.category_other")).tag("other")
                    }
                    TextField(text("groups.create.tags"), text: $tags)
                    TextField(text("groups.create.rules"), text: $rules, axis: .vertical)
                        .lineLimit(3...10)
                }
                Section(text("groups.create.capacity_section")) {
                    LabeledContent(
                        text("groups.create.base_capacity"),
                        value: GroupsLocalization.format("groups.capacity.people", locale: locale, 50)
                    )
                    Text(verbatim: text("groups.create.capacity_note"))
                        .font(.caption)
                        .foregroundStyle(SpottColor.muted)
                }
                Section {
                    Toggle(text("groups.create.agree"), isOn: $rulesAccepted)
                }
                if let quote {
                    Section(text("groups.create.quote_section")) {
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
                            Text(verbatim: text("groups.create.retry_cover")).frame(maxWidth: .infinity)
                        } else if let quote {
                            Text(verbatim: GroupsLocalization.format("groups.create.confirm_pay", locale: locale, quote.amount))
                                .frame(maxWidth: .infinity)
                        } else {
                            Text(verbatim: text("groups.create.get_quote"))
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .spottProminentActionStyle()
                    .disabled(
                        busy || loadingQuote ||
                        (createdGroup == nil && (!valid || (quote?.expiresAt ?? .distantFuture) <= .now))
                    )
                } footer: {
                    Text(verbatim: text("groups.create.footer"))
                }
            }
            .scrollContentBackground(.hidden)
            .background(SpottColor.canvas)
            .navigationTitle(Text(verbatim: text("groups.create.title")))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(text("groups.common.close")) { dismiss() }
                }
            }
            .task {
                if region == "tokyo" {
                    region = model.region
                }
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
            && !region.trimmed.isEmpty
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
                    regionId: region.trimmed,
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
            guard let data = try await item.loadTransferable(type: Data.self),
                  let image = UIImage(data: data),
                  let jpeg = image.jpegData(compressionQuality: 0.86)
            else {
                throw APIError(
                    status: 0,
                    code: "IMAGE_INVALID",
                    message: text("groups.common.image_invalid"),
                    retryable: false
                )
            }
            coverPreview = image
            coverJPEG = jpeg
            error = nil
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

    private func text(_ key: String.LocalizationValue) -> String {
        GroupsLocalization.text(key, locale: locale)
    }
}
