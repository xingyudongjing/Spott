import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import UIKit

struct EventComposerView: View {
    enum Mode: Equatable {
        case create
        case editPublished
    }

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var confirmDiscard = false
    @State private var step = 0
    @State private var title: String
    @State private var description: String
    @State private var category: String
    @State private var extraCategory: String?
    @State private var tags: [String]
    @State private var newTag = ""
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var photos: [ComposerPhoto] = []

    @State private var startsAt: Date
    @State private var endsAt: Date
    @State private var deadlineAt: Date
    @State private var region: String
    @State private var extraRegion: String?
    @State private var publicArea: String
    @State private var exactAddress: String
    @State private var exactAddressVisibility: String

    @State private var capacity: Int
    @State private var registrationMode: String
    @State private var waitlistEnabled: Bool
    @State private var attendeeRequirements: String
    @State private var questions: [EventDraftInput.Question]
    @State private var editingQuestionID: UUID?
    @State private var newQuestion = ""
    @State private var newQuestionKind: RegistrationQuestionKind = .text
    @State private var newQuestionRequired = false
    @State private var newQuestionOptions = ""

    @State private var isFree: Bool
    @State private var amountText: String
    @State private var collectorName: String
    @State private var paymentMethod: String
    @State private var paymentDeadlineText: String
    @State private var refundPolicy: String
    @State private var riskFlags: Set<String>
    @State private var riskNote: String

    @State private var groups: [GroupSummary] = []
    @State private var groupID: UUID?
    @State private var checkinMode: String
    @State private var commentPermission: String
    @State private var posterEnabled: Bool
    @State private var showGuestList: Bool

    @State private var savedAt: Date?
    @State private var remoteDraft: EventSummary?
    @State private var busy = false
    @State private var error: UserFacingError?
    @State private var conflictNotice = false
    @State private var submitted = false
    @State private var editSaved = false
    @State private var resumableDraft: EventSummary?
    @State private var resumeDismissed = false

    private let mode: Mode
    private let prefilledEvent: EventSummary?

    private static let stepKeys: [String.LocalizationValue] = [
        "composer.step.content",
        "composer.step.schedule",
        "composer.step.registration",
        "composer.step.fee_risk",
        "composer.step.community",
        "composer.step.preview",
    ]

    private static let categoryOptions: [(value: String, key: String.LocalizationValue)] = [
        ("family", "composer.category.family"),
        ("outdoor", "composer.category.outdoor"),
        ("sports", "composer.category.sports"),
        ("city-walk", "composer.category.city_walk"),
        ("food", "composer.category.food"),
        ("games", "composer.category.games"),
        ("art", "composer.category.art"),
        ("learning", "composer.category.learning"),
        ("networking", "composer.category.networking"),
    ]

    private static let regionOptions: [(value: String, key: String.LocalizationValue)] = [
        ("tokyo", "composer.region.tokyo"),
        ("kanagawa", "composer.region.kanagawa"),
        ("osaka", "composer.region.osaka"),
        ("kyoto", "composer.region.kyoto"),
    ]

    init(editing event: EventSummary? = nil) {
        prefilledEvent = event
        mode = event?.status == "published" ? .editPublished : .create

        let normalizedCategory = Self.normalizedCategory(event?.category ?? "city-walk")
        let knownCategory = Self.categoryOptions.contains { $0.value == normalizedCategory }
        let regionValue = event?.region ?? "tokyo"
        let knownRegion = Self.regionOptions.contains { $0.value == regionValue }
        let defaultStart = Date.now.addingTimeInterval(86_400 * 7)

        _remoteDraft = State(initialValue: event)
        _title = State(initialValue: event?.title ?? "")
        _description = State(initialValue: event?.description ?? "")
        _category = State(initialValue: normalizedCategory)
        _extraCategory = State(initialValue: knownCategory ? nil : normalizedCategory)
        _tags = State(initialValue: (event?.tags ?? []).filter {
            $0 != normalizedCategory && $0 != event?.category
        })
        _startsAt = State(initialValue: event?.startsAt ?? defaultStart)
        _endsAt = State(initialValue: event?.endsAt ?? defaultStart.addingTimeInterval(7_200))
        _deadlineAt = State(initialValue: event?.deadlineAt
            ?? (event?.startsAt ?? defaultStart).addingTimeInterval(-86_400))
        _region = State(initialValue: regionValue)
        _extraRegion = State(initialValue: knownRegion ? nil : regionValue)
        _publicArea = State(initialValue: event?.publicArea ?? "")
        _exactAddress = State(initialValue: event?.exactAddress ?? "")
        _exactAddressVisibility = State(initialValue: event?.exactAddressVisibility ?? "confirmed")
        _capacity = State(initialValue: (event?.capacity ?? 0) >= 2 ? event!.capacity : 12)
        _registrationMode = State(initialValue: event?.registrationMode ?? "automatic")
        _waitlistEnabled = State(initialValue: event?.waitlistEnabled ?? true)
        _attendeeRequirements = State(initialValue: event?.attendeeRequirements ?? "")
        _questions = State(initialValue: (event?.registrationQuestions ?? []).map {
            .init(id: $0.id, prompt: $0.prompt, kind: $0.kind.rawValue, required: $0.required, options: $0.options)
        })
        _isFree = State(initialValue: event?.fee?.isFree ?? true)
        _amountText = State(initialValue: event?.fee?.amountJPY.map(String.init) ?? "")
        _collectorName = State(initialValue: event?.fee?.collectorName ?? "")
        _paymentMethod = State(initialValue: event?.fee?.method ?? "")
        _paymentDeadlineText = State(initialValue: event?.fee?.paymentDeadlineText ?? "")
        _refundPolicy = State(initialValue: event?.fee?.refundPolicy ?? "")
        _riskFlags = State(initialValue: Set(event?.riskFlags ?? []))
        _riskNote = State(initialValue: event?.riskDetails?.values.first ?? "")
        _groupID = State(initialValue: event?.groupId)
        _checkinMode = State(initialValue: event?.checkinMode ?? "dynamic_qr")
        _commentPermission = State(initialValue: event?.commentPermission ?? "participants")
        _posterEnabled = State(initialValue: event?.posterEnabled ?? true)
        _showGuestList = State(initialValue: event?.showGuestList ?? true)
    }

    private var hasUnsavedEntry: Bool {
        guard !submitted, !editSaved else { return false }
        if prefilledEvent != nil { return true }
        return step > 0
            || !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !photos.isEmpty
            || !tags.isEmpty
    }

    /// True when the working draft already has a cover stored server-side —
    /// the event being edited, a resumed cloud draft, or this session's draft
    /// after its photos finished uploading.
    private var hasServerCover: Bool {
        (remoteDraft?.coverURL ?? prefilledEvent?.coverURL) != nil
    }

    private var serverCoverURL: URL? {
        remoteDraft?.coverURL ?? prefilledEvent?.coverURL
    }

    private var photosLocked: Bool {
        hasServerCover || photos.contains { $0.assetID != nil }
    }

    var body: some View {
        Group {
            if model.session == nil { signedOutState }
            else if model.session?.user.phoneVerified != true { phoneGate }
            else if submitted { submittedState }
            else if editSaved { editSavedState }
            else { composer }
        }
        .background(SpottColor.canvas.ignoresSafeArea())
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button(AppShellLocalization.text("appshell.composer.close", locale: locale)) {
                    if hasUnsavedEntry {
                        confirmDiscard = true
                    } else {
                        dismiss()
                    }
                }
            }
        }
        .confirmationDialog(
            AppShellLocalization.text("appshell.composer.discard_title", locale: locale),
            isPresented: $confirmDiscard,
            titleVisibility: .visible
        ) {
            Button(
                AppShellLocalization.text("appshell.composer.discard_confirm", locale: locale),
                role: .destructive
            ) {
                dismiss()
            }
            Button(
                AppShellLocalization.text("appshell.composer.discard_cancel", locale: locale),
                role: .cancel
            ) {}
        } message: {
            Text(AppShellLocalization.text("appshell.composer.discard_message", locale: locale))
        }
        .task(id: model.session?.sessionId) {
            groups = (try? await model.api.groups().items) ?? []
            await loadResumableDraft()
        }
        .onChange(of: photoItems) { _, items in Task { await loadPhotos(items) } }
    }

    private var signedOutState: some View {
        SpottStateCard(
            icon: "plus.circle",
            title: text("composer.gate.signed_out_title"),
            message: text("composer.gate.signed_out_message"),
            actionTitle: text("composer.gate.signed_out_action")
        ) { model.presentedGate = .login }
            .padding(SpottMetric.pageInset)
    }

    private var phoneGate: some View {
        SpottStateCard(
            icon: "iphone.badge.checkmark",
            title: text("composer.gate.phone_title"),
            message: text("composer.gate.phone_message"),
            actionTitle: text("composer.gate.phone_action")
        ) { model.presentedGate = .phoneVerification }
            .padding(SpottMetric.pageInset)
    }

    private var submittedState: some View {
        let published = remoteDraft?.status == "published"
        return ScrollView {
            VStack(spacing: 18) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(SpottColor.mint)
                    .accessibilityHidden(true)
                Text(text(published ? "composer.submitted.published_title" : "composer.submitted.review_title"))
                    .font(.system(size: 27, weight: .bold, design: .rounded))
                Text(text(published ? "composer.submitted.published_message" : "composer.submitted.review_message"))
                    .foregroundStyle(SpottColor.muted)
                    .multilineTextAlignment(.center)
                if let event = remoteDraft {
                    Button {
                        dismiss()
                        model.router.show(event: event)
                    } label: {
                        Text(text("composer.submitted.view_event")).frame(maxWidth: .infinity)
                    }
                    .spottProminentActionStyle()

                    if published, let url = shareURL(for: event) {
                        ShareLink(item: url) {
                            Label(text("composer.submitted.share"), systemImage: "square.and.arrow.up")
                                .font(.subheadline.weight(.semibold))
                                .frame(maxWidth: .infinity, minHeight: 48)
                        }
                        .buttonStyle(.glass)
                    } else if !published {
                        Text(text("composer.submitted.share_after_review"))
                            .font(.caption)
                            .foregroundStyle(SpottColor.muted)
                    }
                }
                if prefilledEvent == nil {
                    Button(text("composer.submitted.create_another")) { reset() }
                        .font(.subheadline.weight(.semibold))
                        .buttonStyle(.glass)
                }
            }
            .padding(28)
        }
    }

    private var editSavedState: some View {
        ScrollView {
            VStack(spacing: 18) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(SpottColor.mint)
                    .accessibilityHidden(true)
                Text(text("composer.edit_saved.title"))
                    .font(.system(size: 27, weight: .bold, design: .rounded))
                Text(text("composer.edit_saved.message"))
                    .foregroundStyle(SpottColor.muted)
                    .multilineTextAlignment(.center)
                if let event = remoteDraft {
                    Button {
                        dismiss()
                        model.router.show(event: event)
                    } label: {
                        Text(text("composer.submitted.view_event")).frame(maxWidth: .infinity)
                    }
                    .spottProminentActionStyle()
                }
                Button(text("composer.edit_saved.done")) { dismiss() }
                    .font(.subheadline.weight(.semibold))
                    .buttonStyle(.glass)
            }
            .padding(28)
        }
    }

    private var composer: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                if let resumableDraft, shouldOfferResume {
                    resumeCard(resumableDraft)
                }
                stepProgress
                stepFields
                if conflictNotice {
                    Label(text("composer.conflict.reloaded"), systemImage: "arrow.triangle.2.circlepath")
                        .font(.caption)
                        .foregroundStyle(SpottColor.amber)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let savedAt {
                    Label(
                        ComposerLocalization.format(
                            "composer.saved_status",
                            locale: locale,
                            remoteDraft?.version ?? 1,
                            savedAt.formatted(date: .omitted, time: .shortened)
                        ),
                        systemImage: "checkmark.icloud"
                    )
                        .font(.caption)
                        .foregroundStyle(SpottColor.mint)
                }
                if let error {
                    Label("\(error.message)（\(error.id)）", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(SpottColor.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
                navigationControls
            }
            .padding(.horizontal, SpottMetric.pageInset)
            .padding(.top, 18)
            .padding(.bottom, 36)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(verbatim: "HOST ON SPOTT")
                .font(.system(size: 10.5, weight: .bold, design: .monospaced))
                .tracking(1.6)
                .foregroundStyle(SpottColor.coral)
                .accessibilityHidden(true)
            Text(text(mode == .editPublished ? "composer.header.edit_title" : "composer.header.create_title"))
                .font(.system(size: 34, weight: .bold, design: .rounded))
                .tracking(-1.1)
            Text(text(mode == .editPublished ? "composer.header.edit_subtitle" : "composer.header.create_subtitle"))
                .font(.subheadline)
                .foregroundStyle(SpottColor.muted)
        }
    }

    private var shouldOfferResume: Bool {
        mode == .create
            && prefilledEvent == nil
            && remoteDraft == nil
            && !resumeDismissed
            && step == 0
            && title.trimmingCharacters(in: .whitespaces).isEmpty
            && description.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private func resumeCard(_ draft: EventSummary) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(text("composer.resume.title"), systemImage: "arrow.uturn.backward.circle")
                .font(.subheadline.weight(.bold))
            Text(draft.title)
                .font(.footnote)
                .foregroundStyle(SpottColor.muted)
                .lineLimit(2)
            Text(
                ComposerLocalization.format(
                    "composer.resume.updated_at",
                    locale: locale,
                    draft.updatedAt.formatted(date: .abbreviated, time: .shortened)
                )
            )
                .font(.caption)
                .foregroundStyle(SpottColor.muted)
            HStack(spacing: 10) {
                Button(text("composer.resume.continue")) { resume(draft) }
                    .buttonStyle(.glassProminent)
                    .tint(SpottColor.twilight)
                Button(text("composer.resume.dismiss")) { resumeDismissed = true }
                    .buttonStyle(.glass)
            }
            .font(.footnote.weight(.semibold))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(SpottColor.twilightPale.opacity(0.55), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(SpottColor.twilight.opacity(0.25)))
    }

    private var stepProgress: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack(spacing: 6) {
                ForEach(Self.stepKeys.indices, id: \.self) { index in
                    Capsule()
                        .fill(index <= step ? SpottColor.twilight : SpottColor.ink.opacity(0.09))
                        .frame(height: 5)
                }
            }
            .accessibilityHidden(true)
            HStack {
                Text(ComposerLocalization.format("composer.step_progress", locale: locale, step + 1, Self.stepKeys.count))
                Spacer()
                Text(text(Self.stepKeys[step]))
                    .fontWeight(.semibold)
            }
            .font(.caption)
            .foregroundStyle(SpottColor.muted)
        }
        .padding(15)
        .spottGlassPanel(shape: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    @ViewBuilder private var stepFields: some View {
        switch step {
        case 0: contentStep
        case 1: placeStep
        case 2: registrationStep
        case 3: feeStep
        case 4: communityStep
        default: previewStep
        }
    }

    private var contentStep: some View {
        VStack(spacing: 16) {
            ComposerSection(
                title: text("composer.photos.section_title"),
                subtitle: text("composer.photos.section_subtitle")
            ) {
                if mode == .editPublished {
                    if let cover = serverCoverURL {
                        EventCoverView(url: cover, category: category)
                            .frame(height: 150)
                    }
                    Label(text("composer.photos.published_locked"), systemImage: "lock")
                        .font(.caption)
                        .foregroundStyle(SpottColor.muted)
                        .fixedSize(horizontal: false, vertical: true)
                } else if photosLocked {
                    if photos.isEmpty, let cover = serverCoverURL {
                        EventCoverView(url: cover, category: category)
                            .frame(height: 150)
                    } else {
                        ComposerPhotoGrid(photos: $photos, locked: true, locale: locale)
                    }
                    Label(text("composer.photos.uploaded_locked"), systemImage: "lock")
                        .font(.caption)
                        .foregroundStyle(SpottColor.muted)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    if photos.count < 6 {
                        PhotosPicker(
                            selection: $photoItems,
                            maxSelectionCount: 6 - photos.count,
                            matching: .images
                        ) {
                            Label(
                                photos.isEmpty
                                    ? text("composer.photos.pick")
                                    : ComposerLocalization.format("composer.photos.add_more", locale: locale, photos.count),
                                systemImage: "photo.on.rectangle.angled"
                            )
                                .frame(maxWidth: .infinity, minHeight: 48)
                        }
                        .buttonStyle(.glass)
                    }
                    if !photos.isEmpty {
                        ComposerPhotoGrid(photos: $photos, locked: false, locale: locale)
                        Text(text("composer.photos.reorder_hint"))
                            .font(.caption2)
                            .foregroundStyle(SpottColor.muted)
                    }
                }
            }
            ComposerSection(
                title: text("composer.basics.section_title"),
                subtitle: text("composer.basics.section_subtitle")
            ) {
                TextField(text("composer.basics.title_placeholder"), text: $title).composerField()
                TextField(text("composer.basics.description_placeholder"), text: $description, axis: .vertical)
                    .lineLimit(7...14)
                    .composerField()
                HStack {
                    Spacer()
                    Text(verbatim: "\(description.count) / 3000")
                        .font(.caption)
                        .foregroundStyle(SpottColor.muted)
                }
            }
            ComposerSection(
                title: text("composer.category.section_title"),
                subtitle: text("composer.category.section_subtitle")
            ) {
                Picker(text("composer.category.picker_label"), selection: $category) {
                    ForEach(Self.categoryOptions, id: \.value) { option in
                        Text(text(option.key)).tag(option.value)
                    }
                    if let extraCategory {
                        Text(extraCategory).tag(extraCategory)
                    }
                }
                .pickerStyle(.menu)
                HStack {
                    TextField(text("composer.tags.placeholder"), text: $newTag).composerField()
                    Button(text("composer.tags.add")) { addTag() }
                        .buttonStyle(.glass)
                        .disabled(newTag.trimmingCharacters(in: .whitespaces).isEmpty || tags.count >= 5)
                }
                if !tags.isEmpty {
                    ComposerFlowTags(
                        tags: tags,
                        removeLabel: { ComposerLocalization.format("composer.tags.remove", locale: locale, $0) }
                    ) { tag in
                        tags.removeAll { $0 == tag }
                    }
                }
            }
        }
    }

    private var placeStep: some View {
        VStack(spacing: 16) {
            ComposerSection(
                title: text("composer.schedule.section_title"),
                subtitle: text("composer.schedule.section_subtitle")
            ) {
                DatePicker(text("composer.schedule.starts"), selection: $startsAt)
                DatePicker(text("composer.schedule.ends"), selection: $endsAt, in: startsAt...)
                DatePicker(
                    text("composer.schedule.deadline"),
                    selection: $deadlineAt,
                    in: min(Date.now, deadlineAt)...startsAt
                )
            }
            ComposerSection(
                title: text("composer.place.section_title"),
                subtitle: text("composer.place.section_subtitle")
            ) {
                Picker(text("composer.place.region"), selection: $region) {
                    ForEach(Self.regionOptions, id: \.value) { option in
                        Text(text(option.key)).tag(option.value)
                    }
                    if let extraRegion {
                        Text(extraRegion).tag(extraRegion)
                    }
                }
                TextField(text("composer.place.public_area_placeholder"), text: $publicArea).composerField()
                TextField(text("composer.place.exact_address_placeholder"), text: $exactAddress, axis: .vertical)
                    .lineLimit(2...5)
                    .composerField()
                Picker(text("composer.place.visibility"), selection: $exactAddressVisibility) {
                    Text(text("composer.place.visibility_confirmed")).tag("confirmed")
                    Text(text("composer.place.visibility_public")).tag("public")
                }
                Text(text("composer.place.privacy_note"))
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
            }
        }
    }

    private var registrationStep: some View {
        VStack(spacing: 16) {
            ComposerSection(
                title: text("composer.registration.section_title"),
                subtitle: text("composer.registration.section_subtitle")
            ) {
                Stepper(
                    ComposerLocalization.format("composer.registration.capacity", locale: locale, capacity),
                    value: $capacity,
                    in: 2...500
                )
                Picker(text("composer.registration.mode"), selection: $registrationMode) {
                    Text(text("composer.registration.mode_automatic")).tag("automatic")
                    Text(text("composer.registration.mode_approval")).tag("approval")
                    Text(text("composer.registration.mode_invite")).tag("invite_only")
                }
                Toggle(text("composer.registration.waitlist"), isOn: $waitlistEnabled)
                TextField(text("composer.registration.requirements_placeholder"), text: $attendeeRequirements, axis: .vertical)
                    .lineLimit(3...8)
                    .composerField()
            }
            ComposerSection(
                title: text("composer.questions.section_title"),
                subtitle: text("composer.questions.section_subtitle")
            ) {
                ForEach(Array(questions.enumerated()), id: \.element.id) { index, question in
                    ComposerQuestionRow(
                        question: question,
                        index: index,
                        count: questions.count,
                        isEditing: editingQuestionID == question.id,
                        locale: locale,
                        onEdit: { beginEditing(question) },
                        onMoveUp: { moveQuestion(question, offset: -1) },
                        onMoveDown: { moveQuestion(question, offset: 1) },
                        onDelete: { deleteQuestion(question) }
                    )
                }
                Divider()
                if editingQuestionID != nil {
                    Label(text("composer.questions.editing_notice"), systemImage: "pencil.circle")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(SpottColor.twilight)
                }
                TextField(text("composer.questions.prompt_placeholder"), text: $newQuestion, axis: .vertical)
                    .lineLimit(2...5)
                    .composerField()
                Picker(text("composer.questions.kind"), selection: $newQuestionKind) {
                    Text(text("composer.questions.kind_text")).tag(RegistrationQuestionKind.text)
                    Text(text("composer.questions.kind_single_choice")).tag(RegistrationQuestionKind.singleChoice)
                    Text(text("composer.questions.kind_boolean")).tag(RegistrationQuestionKind.boolean)
                }
                .pickerStyle(.segmented)
                if newQuestionKind == .singleChoice {
                    TextField(text("composer.questions.options_placeholder"), text: $newQuestionOptions, axis: .vertical)
                        .lineLimit(2...6)
                        .composerField()
                }
                Toggle(text("composer.questions.required"), isOn: $newQuestionRequired)
                HStack(spacing: 10) {
                    Button(text(editingQuestionID == nil ? "composer.questions.add" : "composer.questions.save_edit")) {
                        commitQuestion()
                    }
                    .buttonStyle(.glass)
                    .disabled(!canCommitQuestion)
                    if editingQuestionID != nil {
                        Button(text("composer.questions.cancel_edit")) { cancelQuestionEditing() }
                            .buttonStyle(.glass)
                    }
                }
            }
        }
    }

    private var feeStep: some View {
        VStack(spacing: 16) {
            ComposerSection(
                title: text("composer.fee.section_title"),
                subtitle: text("composer.fee.section_subtitle")
            ) {
                Toggle(text("composer.fee.free"), isOn: $isFree)
                if !isFree {
                    TextField(text("composer.fee.amount_placeholder"), text: $amountText)
                        .keyboardType(.numberPad)
                        .composerField()
                    TextField(text("composer.fee.collector_placeholder"), text: $collectorName).composerField()
                    TextField(text("composer.fee.method_placeholder"), text: $paymentMethod).composerField()
                    TextField(text("composer.fee.deadline_placeholder"), text: $paymentDeadlineText).composerField()
                    TextField(text("composer.fee.refund_placeholder"), text: $refundPolicy, axis: .vertical)
                        .lineLimit(4...10)
                        .composerField()
                }
            }
            ComposerSection(
                title: text("composer.risk.section_title"),
                subtitle: text("composer.risk.section_subtitle")
            ) {
                ForEach(riskOptions, id: \.0) { value, key in
                    Toggle(
                        text(key),
                        isOn: Binding(
                            get: { riskFlags.contains(value) },
                            set: { enabled in
                                if enabled { riskFlags.insert(value) } else { riskFlags.remove(value) }
                            }
                        )
                    )
                }
                if !riskFlags.isEmpty {
                    TextField(text("composer.risk.note_placeholder"), text: $riskNote, axis: .vertical)
                        .lineLimit(4...10)
                        .composerField()
                }
            }
        }
    }

    private var communityStep: some View {
        VStack(spacing: 16) {
            ComposerSection(
                title: text("composer.group.section_title"),
                subtitle: text("composer.group.section_subtitle")
            ) {
                Picker(text("composer.group.picker_label"), selection: $groupID) {
                    Text(text("composer.group.none")).tag(UUID?.none)
                    ForEach(groups) { group in Text(group.name).tag(Optional(group.id)) }
                }
            }
            ComposerSection(
                title: text("composer.checkin.section_title"),
                subtitle: text("composer.checkin.section_subtitle")
            ) {
                Picker(text("composer.checkin.mode"), selection: $checkinMode) {
                    Text(text("composer.checkin.dynamic_qr")).tag("dynamic_qr")
                    Text(text("composer.checkin.six_digit")).tag("six_digit")
                    Text(text("composer.checkin.manual")).tag("manual")
                }
                .pickerStyle(.segmented)
            }
            ComposerSection(
                title: text("composer.interaction.section_title"),
                subtitle: text("composer.interaction.section_subtitle")
            ) {
                Picker(text("composer.interaction.comments"), selection: $commentPermission) {
                    Text(text("composer.interaction.comments_disabled")).tag("disabled")
                    Text(text("composer.interaction.comments_participants")).tag("participants")
                    Text(text("composer.interaction.comments_group")).tag("group_members")
                }
                Toggle(text("composer.interaction.poster"), isOn: $posterEnabled)
                Toggle(text("composer.interaction.guest_list"), isOn: $showGuestList)
            }
        }
    }

    private var previewStep: some View {
        VStack(spacing: 16) {
            ComposerSection(
                title: text("composer.preview.section_title"),
                subtitle: text(mode == .editPublished ? "composer.preview.edit_subtitle" : "composer.preview.create_subtitle")
            ) {
                ComposerPreviewRow(title: text("composer.preview.event"), value: title.isEmpty ? text("composer.preview.missing") : title)
                ComposerPreviewRow(
                    title: text("composer.preview.photos"),
                    value: photos.isEmpty && hasServerCover
                        ? text("composer.preview.photos_uploaded")
                        : ComposerLocalization.format("composer.preview.photo_count", locale: locale, photos.count)
                )
                ComposerPreviewRow(title: text("composer.preview.time"), value: startsAt.formatted(date: .abbreviated, time: .shortened))
                ComposerPreviewRow(title: text("composer.preview.place"), value: publicArea.isEmpty ? text("composer.preview.missing") : publicArea)
                ComposerPreviewRow(title: text("composer.preview.capacity"), value: "\(capacity)")
                ComposerPreviewRow(title: text("composer.preview.mode"), value: registrationModeTitle)
                ComposerPreviewRow(
                    title: text("composer.preview.fee"),
                    value: isFree
                        ? text("composer.preview.fee_free")
                        : ComposerLocalization.format("composer.preview.fee_onsite", locale: locale, amountText)
                )
                if mode == .create {
                    ComposerPreviewRow(title: text("composer.preview.points"), value: text("composer.preview.points_value"))
                }
            }
            SurfaceCard {
                VStack(alignment: .leading, spacing: 10) {
                    Label(
                        text(mode == .editPublished ? "composer.preview.edit_notice_title" : "composer.preview.submit_notice_title"),
                        systemImage: "shield.checkered"
                    )
                        .font(.headline)
                    Text(text(mode == .editPublished ? "composer.preview.edit_notice_body" : "composer.preview.submit_notice_body"))
                        .font(.subheadline)
                        .foregroundStyle(SpottColor.muted)
                        .lineSpacing(4)
                }
            }
        }
    }

    private var navigationControls: some View {
        HStack(spacing: 12) {
            if step > 0 {
                Button(text("composer.nav.back")) {
                    if reduceMotion { step -= 1 } else { withAnimation(SpottMotion.quick) { step -= 1 } }
                }
                    .buttonStyle(.glass)
            }
            Button {
                advance()
            } label: {
                if busy {
                    ProgressView().tint(.white).frame(maxWidth: .infinity)
                } else {
                    Text(primaryButtonTitle).frame(maxWidth: .infinity)
                }
            }
            .spottProminentActionStyle()
            .disabled(busy)
        }
        .controlSize(.large)
    }

    private var primaryButtonTitle: String {
        let isLast = step == Self.stepKeys.count - 1
        switch mode {
        case .create:
            return text(isLast ? "composer.nav.submit" : "composer.nav.save_continue")
        case .editPublished:
            return text(isLast ? "composer.nav.save_finish" : "composer.nav.save_edit_continue")
        }
    }

    private var draftInput: EventDraftInput {
        .init(
            title: title.trimmingCharacters(in: .whitespacesAndNewlines),
            description: description.trimmingCharacters(in: .whitespacesAndNewlines),
            categoryId: category,
            startsAt: startsAt,
            endsAt: endsAt,
            deadlineAt: deadlineAt,
            regionId: region,
            publicArea: publicArea,
            exactAddress: exactAddress,
            capacity: capacity,
            registrationMode: registrationMode,
            waitlistEnabled: waitlistEnabled,
            fee: .init(
                isFree: isFree,
                amountJPY: isFree ? nil : Int(amountText),
                collectorName: isFree ? nil : collectorName,
                method: isFree ? nil : paymentMethod,
                paymentDeadlineText: isFree ? nil : paymentDeadlineText,
                refundPolicy: isFree ? nil : refundPolicy
            ),
            tags: Array(([category] + tags).prefix(5)),
            attendeeRequirements: attendeeRequirements.nilIfBlank,
            riskFlags: Array(riskFlags).sorted(),
            riskDetails: riskFlags.isEmpty ? [:] : Dictionary(uniqueKeysWithValues: riskFlags.map { ($0, riskNote) }),
            groupId: groupID,
            checkinMode: checkinMode,
            commentPermission: commentPermission,
            posterEnabled: posterEnabled,
            showGuestList: showGuestList,
            exactAddressVisibility: exactAddressVisibility,
            registrationQuestions: questions
        )
    }

    private func advance() {
        if let validation = validationError(for: step) { error = validation; return }
        busy = true
        error = nil
        conflictNotice = false
        Task {
            do {
                var draft: EventSummary
                if let remoteDraft {
                    draft = try await model.api.updateEventDraft(id: remoteDraft.id, version: remoteDraft.version, draft: draftInput)
                } else {
                    draft = try await model.api.createEventDraft(draftInput)
                }
                remoteDraft = draft
                if step == 0, mode == .create {
                    for index in photos.indices where photos[index].assetID == nil {
                        let id = try await model.api.uploadEventImage(
                            data: photos[index].data,
                            filename: photos[index].filename,
                            mimeType: photos[index].mimeType,
                            eventID: draft.id,
                            sortOrder: index
                        )
                        photos[index].assetID = id
                    }
                    if let refreshed = try? await model.api.event(identifier: draft.id.uuidString.lowercased()) {
                        draft = refreshed
                        remoteDraft = refreshed
                    }
                }
                reconcileQuestions(from: draft)
                savedAt = .now
                if step < Self.stepKeys.count - 1 {
                    if reduceMotion { step += 1 } else { withAnimation(SpottMotion.quick) { step += 1 } }
                } else {
                    switch mode {
                    case .editPublished:
                        editSaved = true
                    case .create:
                        let quote = try await model.api.quote(purpose: "event_publish", resourceID: draft.id)
                        let submittedEvent = try await model.api.submitEvent(
                            id: draft.id,
                            version: draft.version,
                            quoteID: quote.id
                        )
                        remoteDraft = submittedEvent
                        model.trackAnalytics(.eventSubmissionCompleted(
                            eventID: submittedEvent.id,
                            status: submittedEvent.status,
                            category: category,
                            posterEnabled: posterEnabled
                        ))
                        submitted = true
                    }
                }
            } catch {
                let mapped = AppModel.map(error)
                // The risk engine's verdicts come back as unmapped 422s whose
                // generic copy says "retry" — replace with honest, specific copy.
                switch mapped.id {
                case "EVENT_REVIEW_REQUIRED":
                    self.error = .init(id: mapped.id, message: text("composer.error.review_required"), retryable: false)
                case "EVENT_RISK_PROHIBITED":
                    self.error = .init(id: mapped.id, message: text("composer.error.risk_prohibited"), retryable: false)
                default:
                    self.error = mapped
                }
                if mapped.id == "VERSION_CONFLICT", let current = remoteDraft {
                    if let latest = try? await model.api.event(identifier: current.id.uuidString.lowercased()) {
                        remoteDraft = latest
                        conflictNotice = true
                    }
                }
            }
            busy = false
        }
    }

    private func validationError(for step: Int) -> UserFacingError? {
        func invalid(_ key: String.LocalizationValue) -> UserFacingError {
            .init(id: "DRAFT_STEP_INVALID", message: text(key), retryable: false)
        }
        switch step {
        case 0:
            if photos.isEmpty && !hasServerCover { return invalid("composer.validation.photos") }
            if !(4...40).contains(title.trimmingCharacters(in: .whitespaces).count) { return invalid("composer.validation.title") }
            if !(50...3000).contains(description.trimmingCharacters(in: .whitespacesAndNewlines).count) { return invalid("composer.validation.description") }
        case 1:
            if endsAt <= startsAt { return invalid("composer.validation.ends") }
            if deadlineAt > startsAt { return invalid("composer.validation.deadline") }
            if publicArea.trimmingCharacters(in: .whitespaces).isEmpty || exactAddress.trimmingCharacters(in: .whitespaces).isEmpty { return invalid("composer.validation.place") }
        case 2:
            if capacity < 2 { return invalid("composer.validation.capacity") }
        case 3:
            if !isFree && (Int(amountText) ?? 0) <= 0 { return invalid("composer.validation.fee_amount") }
            if !isFree && (collectorName.nilIfBlank == nil || refundPolicy.nilIfBlank == nil) { return invalid("composer.validation.fee_fields") }
            if !riskFlags.isEmpty && riskNote.trimmingCharacters(in: .whitespacesAndNewlines).count < 10 { return invalid("composer.validation.risk_note") }
        default: break
        }
        return nil
    }

    private func loadPhotos(_ items: [PhotosPickerItem]) async {
        guard !items.isEmpty, !photosLocked else { return }
        var appended = photos
        for item in items {
            guard appended.count < 6 else { break }
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            let type = item.supportedContentTypes.first ?? .jpeg
            appended.append(
                .init(
                    data: data,
                    mimeType: type.preferredMIMEType ?? "image/jpeg",
                    filename: "spott-event-\(appended.count + 1).\(type.preferredFilenameExtension ?? "jpg")"
                )
            )
        }
        photos = appended
        photoItems = []
    }

    private func addTag() {
        let value = newTag.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, tags.count < 5, !tags.contains(value) else { return }
        tags.append(value)
        newTag = ""
    }

    private func beginEditing(_ question: EventDraftInput.Question) {
        editingQuestionID = question.id
        newQuestion = question.prompt
        newQuestionKind = RegistrationQuestionKind(rawValue: question.kind) ?? .text
        newQuestionRequired = question.required
        newQuestionOptions = question.options.joined(separator: "\n")
    }

    private func cancelQuestionEditing() {
        editingQuestionID = nil
        newQuestion = ""
        newQuestionKind = .text
        newQuestionRequired = false
        newQuestionOptions = ""
    }

    private func commitQuestion() {
        let value = newQuestion.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canCommitQuestion else { return }
        let options = newQuestionKind == .singleChoice ? parsedQuestionOptions : []
        if let editingQuestionID, let index = questions.firstIndex(where: { $0.id == editingQuestionID }) {
            questions[index] = .init(
                id: questions[index].serverID,
                prompt: value,
                kind: newQuestionKind.rawValue,
                required: newQuestionRequired,
                options: options
            )
        } else {
            questions.append(
                .init(
                    prompt: value,
                    kind: newQuestionKind.rawValue,
                    required: newQuestionRequired,
                    options: options
                )
            )
        }
        cancelQuestionEditing()
    }

    private func moveQuestion(_ question: EventDraftInput.Question, offset: Int) {
        guard let index = questions.firstIndex(where: { $0.id == question.id }) else { return }
        let target = index + offset
        guard (0..<questions.count).contains(target) else { return }
        let apply = { questions.swapAt(index, target) }
        if reduceMotion { apply() } else { withAnimation(SpottMotion.standard, apply) }
    }

    private func deleteQuestion(_ question: EventDraftInput.Question) {
        if editingQuestionID == question.id { cancelQuestionEditing() }
        questions.removeAll { $0.id == question.id }
    }

    private var parsedQuestionOptions: [String] {
        newQuestionOptions
            .components(separatedBy: CharacterSet(charactersIn: ",，\n"))
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .reduce(into: [String]()) { values, value in
                if !values.contains(value), values.count < 12 { values.append(value) }
            }
    }

    private var canCommitQuestion: Bool {
        let prompt = newQuestion.trimmingCharacters(in: .whitespacesAndNewlines)
        let underLimit = editingQuestionID != nil || questions.count < 10
        return !prompt.isEmpty
            && prompt.count <= 240
            && underLimit
            && (newQuestionKind != .singleChoice || parsedQuestionOptions.count >= 2)
    }

    private func loadResumableDraft() async {
        guard mode == .create, prefilledEvent == nil, remoteDraft == nil,
              model.session?.user.phoneVerified == true else { return }
        let hosted = (try? await model.api.hostedEvents().items) ?? []
        resumableDraft = hosted.first {
            $0.status == "draft" && !$0.title.trimmingCharacters(in: .whitespaces).isEmpty
        }
    }

    private func resume(_ draft: EventSummary) {
        remoteDraft = draft
        title = draft.title
        description = draft.description
        let normalized = Self.normalizedCategory(draft.category)
        category = normalized
        extraCategory = Self.categoryOptions.contains { $0.value == normalized } ? nil : normalized
        tags = draft.tags.filter { $0 != normalized && $0 != draft.category }
        if let starts = draft.startsAt { startsAt = starts }
        if let ends = draft.endsAt { endsAt = ends }
        deadlineAt = draft.deadlineAt ?? startsAt.addingTimeInterval(-86_400)
        if let value = draft.region {
            region = value
            extraRegion = Self.regionOptions.contains { $0.value == value } ? nil : value
        }
        publicArea = draft.publicArea ?? ""
        exactAddress = draft.exactAddress ?? ""
        exactAddressVisibility = draft.exactAddressVisibility ?? "confirmed"
        capacity = draft.capacity >= 2 ? draft.capacity : 12
        registrationMode = draft.registrationMode
        waitlistEnabled = draft.waitlistEnabled
        attendeeRequirements = draft.attendeeRequirements ?? ""
        questions = (draft.registrationQuestions ?? []).map {
            .init(id: $0.id, prompt: $0.prompt, kind: $0.kind.rawValue, required: $0.required, options: $0.options)
        }
        isFree = draft.fee?.isFree ?? true
        amountText = draft.fee?.amountJPY.map(String.init) ?? ""
        collectorName = draft.fee?.collectorName ?? ""
        paymentMethod = draft.fee?.method ?? ""
        paymentDeadlineText = draft.fee?.paymentDeadlineText ?? ""
        refundPolicy = draft.fee?.refundPolicy ?? ""
        riskFlags = Set(draft.riskFlags ?? [])
        riskNote = draft.riskDetails?.values.first ?? ""
        groupID = draft.groupId
        checkinMode = draft.checkinMode ?? "dynamic_qr"
        commentPermission = draft.commentPermission ?? "participants"
        posterEnabled = draft.posterEnabled ?? true
        showGuestList = draft.showGuestList ?? true
        resumableDraft = nil
        savedAt = nil
    }

    private func reconcileQuestions(from event: EventSummary) {
        guard let serverQuestions = event.registrationQuestions else { return }
        questions = serverQuestions.map {
            .init(
                id: $0.id,
                prompt: $0.prompt,
                kind: $0.kind.rawValue,
                required: $0.required,
                options: $0.options
            )
        }
    }

    private var registrationModeTitle: String {
        switch registrationMode {
        case "approval": text("composer.registration.mode_approval")
        case "invite_only": text("composer.registration.mode_invite")
        default: text("composer.registration.mode_automatic")
        }
    }

    private var riskOptions: [(String, String.LocalizationValue)] {
        [
            ("alcohol", "composer.risk.alcohol"),
            ("late_night", "composer.risk.late_night"),
            ("family", "composer.risk.family"),
            ("minors", "composer.risk.minors"),
            ("outdoor", "composer.risk.outdoor"),
            ("mountain", "composer.risk.mountain"),
            ("water", "composer.risk.water"),
            ("high_fee", "composer.risk.high_fee"),
            ("career", "composer.risk.career"),
            ("investment", "composer.risk.investment"),
            ("gender_limited", "composer.risk.gender_limited"),
        ]
    }

    private static func normalizedCategory(_ raw: String) -> String {
        switch raw {
        case "art-culture": "art"
        case "skill": "learning"
        case "career": "networking"
        case "walk": "city-walk"
        default: raw
        }
    }

    private func shareURL(for event: EventSummary) -> URL? {
        guard !event.publicSlug.isEmpty else { return nil }
        return URL(string: "https://spott.jp/e/\(event.publicSlug)")
    }

    private func reset() {
        step = 0; title = ""; description = ""; tags = []; photos = []; photoItems = []
        publicArea = ""; exactAddress = ""; attendeeRequirements = ""; questions = []
        cancelQuestionEditing()
        amountText = ""; collectorName = ""; paymentMethod = ""; paymentDeadlineText = ""; refundPolicy = ""; riskFlags = []; riskNote = ""
        remoteDraft = nil; savedAt = nil; submitted = false; editSaved = false; error = nil; conflictNotice = false
        resumableDraft = nil; resumeDismissed = false
    }

    private func text(_ key: String.LocalizationValue) -> String {
        ComposerLocalization.text(key, locale: locale)
    }
}

private extension String {
    var nilIfBlank: String? { trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : self }
}
