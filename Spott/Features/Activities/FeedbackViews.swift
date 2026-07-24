import SwiftUI

struct FeedbackSubmissionAuthority: Sendable {
    private(set) var value: OwnFeedbackState?
    private(set) var refreshFailedAfterSubmission = false

    init(value: OwnFeedbackState? = nil) {
        self.value = value
    }

    var canSubmit: Bool { value?.canSubmit == true }
    var canEdit: Bool { value?.canEdit == true }

    mutating func mutationSucceeded() {
        value = nil
        refreshFailedAfterSubmission = false
    }

    mutating func received(_ value: OwnFeedbackState) {
        self.value = value
        refreshFailedAfterSubmission = false
    }

    mutating func refreshFailed(afterSubmission: Bool) {
        guard afterSubmission else { return }
        value = nil
        refreshFailedAfterSubmission = true
    }
}

struct FeedbackSubmissionView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    let event: EventSummary
    let registration: Registration

    @State private var rating = 5
    @State private var tags = Set<FeedbackTag>()
    @State private var comment = ""
    @State private var visibility: FeedbackVisibility = .aggregateOnly
    @State private var busy = false
    @State private var loading = true
    @State private var authority = FeedbackSubmissionAuthority()
    @State private var editingExisting = false
    @State private var submittedReceipt: FeedbackReceipt?
    @State private var attempt: StableIdempotencyAttempt?
    @State private var error: UserFacingError?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if loading {
                        ProgressView(text("journey.feedback.loading"))
                            .frame(maxWidth: .infinity, minHeight: 260)
                    } else if let feedback = authority.value?.feedback, !editingExisting {
                        submittedStatus(feedback)
                    } else if let submittedReceipt, authority.value?.feedback == nil {
                        submittedFallback(submittedReceipt)
                    } else if authority.value == nil {
                        loadFailure
                    } else if !authority.canSubmit {
                        unavailableState
                    } else {
                        form
                    }
                }
                .padding(SpottMetric.pageInset)
                .padding(.bottom, 24)
            }
            .background(SpottScreenBackground())
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(text("journey.common.close")) { dismiss() }
                }
            }
            .task(id: registration.id) { await loadState() }
        }
    }

    @ViewBuilder private var form: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(text(editingExisting ? "journey.feedback.edit_title" : "journey.feedback.title"))
                .font(.system(size: 31, weight: .bold, design: .rounded))
            Text(event.title)
                .font(.subheadline)
                .foregroundStyle(SpottColor.muted)
        }

        feedbackSection(title: text("journey.feedback.overall")) {
            HStack(spacing: 8) {
                ForEach(1...5, id: \.self) { value in
                    Button { rating = value } label: {
                        Image(systemName: value <= rating ? "star.fill" : "star")
                            .font(.system(size: 22, weight: .medium))
                            .foregroundStyle(value <= rating ? SpottColor.amber : SpottColor.muted)
                            .frame(maxWidth: .infinity, minHeight: 46)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(
                        CoreJourneyLocalization.format("journey.feedback.star_label", locale: locale, value)
                    )
                    .accessibilityValue(value == rating ? text("journey.feedback.star_selected") : "")
                    .accessibilityAddTraits(value == rating ? .isSelected : [])
                }
            }
        }

        feedbackSection(title: text("journey.feedback.highlights")) {
            SpottGlassGroup(spacing: 8) {
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 132), spacing: 8)],
                    alignment: .leading,
                    spacing: 8
                ) {
                    ForEach(FeedbackTag.allCases) { tag in
                        GlassChip(
                            title: text(tag.localizationKey),
                            isSelected: tags.contains(tag)
                        ) {
                            if tags.contains(tag) {
                                tags.remove(tag)
                            } else {
                                tags.insert(tag)
                            }
                        }
                    }
                }
            }
        }

        feedbackSection(title: text("journey.feedback.suggestion")) {
            TextField(
                text("journey.feedback.comment_placeholder"),
                text: $comment,
                axis: .vertical
            )
            .lineLimit(4...8)
            .padding(14)
            .background(
                Color(uiColor: .tertiarySystemGroupedBackground),
                in: RoundedRectangle(cornerRadius: 16)
            )
            .onChange(of: comment) { _, value in
                if value.count > 500 { comment = String(value.prefix(500)) }
            }
        }

        feedbackSection(title: text("journey.feedback.privacy")) {
            Picker(text("journey.feedback.privacy"), selection: $visibility) {
                Text(text("journey.feedback.private")).tag(FeedbackVisibility.private)
                Text(text("journey.feedback.aggregate")).tag(FeedbackVisibility.aggregateOnly)
            }
            .pickerStyle(.segmented)
            Text(
                visibility == .private
                    ? text("journey.feedback.private_note")
                    : text("journey.feedback.aggregate_note")
            )
            .font(.caption)
            .foregroundStyle(SpottColor.muted)
            .lineSpacing(3)
        }

        if error != nil {
            Label(submissionErrorText, systemImage: "exclamationmark.circle.fill")
                .font(.caption)
                .foregroundStyle(SpottColor.danger)
                .accessibilityIdentifier("feedback-submission-error")
        }

        JourneyPrimaryActionButton(
            title: text(
                busy
                    ? "journey.feedback.submitting"
                    : editingExisting
                        ? "journey.feedback.save_edit"
                        : "journey.feedback.submit"
            ),
            systemImage: "paperplane.fill",
            isBusy: busy,
            action: submit
        )
    }

    private func feedbackSection<Content: View>(
        title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 13) {
            Text(title).font(.system(size: 17, weight: .bold, design: .rounded))
            content()
        }
        .padding(17)
        .background(
            Color(uiColor: .secondarySystemGroupedBackground),
            in: RoundedRectangle(cornerRadius: 22, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(Color.primary.opacity(0.08), lineWidth: 0.5)
        }
    }

    private func submittedFallback(_ receipt: FeedbackReceipt) -> some View {
        SpottStateCard(
            icon: "heart.text.clipboard.fill",
            title: text("journey.feedback.success_title"),
            message: submittedFallbackMessage(receipt),
            actionTitle: text(
                authority.refreshFailedAfterSubmission
                    ? "journey.common.retry"
                    : "journey.common.done"
            )
        ) {
            if authority.refreshFailedAfterSubmission {
                Task { await loadState() }
            } else {
                dismiss()
            }
        }
    }

    private func submittedFallbackMessage(_ receipt: FeedbackReceipt) -> String {
        let confirmation = receipt.rewardPoints > 0
            ? CoreJourneyLocalization.format(
                "journey.feedback.success_points",
                locale: locale,
                receipt.rewardPoints
            )
            : text("journey.feedback.submitted_message")
        guard authority.refreshFailedAfterSubmission else { return confirmation }
        return confirmation + "\n\n" + text("journey.feedback.status_refresh_failed")
    }

    private func submittedStatus(_ feedback: OwnFeedback) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            Image(systemName: "heart.text.clipboard.fill")
                .font(.system(size: 40, weight: .semibold))
                .foregroundStyle(SpottColor.twilight)
                .accessibilityHidden(true)
            Text(text("journey.feedback.received_title"))
                .font(.system(size: 29, weight: .bold, design: .rounded))
            Text(statusMessage(feedback))
                .foregroundStyle(SpottColor.muted)
                .lineSpacing(4)
            if canEditFeedback {
                JourneyPrimaryActionButton(
                    title: text("journey.feedback.edit_once"),
                    systemImage: "pencil",
                    isBusy: false
                ) {
                    editingExisting = true
                    error = nil
                }
            }
            Button(text("journey.common.done")) { dismiss() }
                .buttonStyle(.glass)
                .buttonBorderShape(.capsule)
                .frame(minHeight: 44)
        }
        .padding(22)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            Color(uiColor: .secondarySystemGroupedBackground),
            in: RoundedRectangle(cornerRadius: 24, style: .continuous)
        )
    }

    private var loadFailure: some View {
        SpottStateCard(
            icon: "wifi.exclamationmark",
            title: text("journey.feedback.load_error_title"),
            message: text("journey.feedback.load_error_message"),
            actionTitle: text("journey.common.retry")
        ) { Task { await loadState() } }
    }

    private var unavailableState: some View {
        SpottStateCard(
            icon: "clock.badge.xmark",
            title: text("journey.feedback.unavailable_title"),
            message: authority.value?.state == .windowClosed
                ? text("journey.feedback.window_closed")
                : text("journey.feedback.not_eligible"),
            actionTitle: text("journey.common.done")
        ) { dismiss() }
    }

    private func statusMessage(_ feedback: OwnFeedback) -> String {
        if let rewardPoints = submittedReceipt?.rewardPoints, rewardPoints > 0 {
            return CoreJourneyLocalization.format(
                "journey.feedback.success_points",
                locale: locale,
                rewardPoints
            )
        }
        if authority.canEdit {
            return text("journey.feedback.edit_available_message")
        }
        return feedback.editCount >= 1
            ? text("journey.feedback.edit_used_message")
            : text("journey.feedback.submitted_message")
    }

    private var canEditFeedback: Bool {
        authority.canEdit && (submittedReceipt?.editCount ?? 0) < 1
    }

    private var submissionErrorText: String {
        switch error?.id {
        case "FEEDBACK_WINDOW_CLOSED": text("journey.feedback.window_closed")
        case "FEEDBACK_EDIT_LIMIT_REACHED": text("journey.feedback.edit_used_message")
        case "FEEDBACK_NOT_ALLOWED": text("journey.feedback.not_eligible")
        default: text("journey.feedback.submit_error")
        }
    }

    private func text(_ key: String.LocalizationValue) -> String {
        CoreJourneyLocalization.text(key, locale: locale)
    }

    @MainActor
    private func loadState() async {
        loading = authority.value == nil
        error = nil
        defer { loading = false }
        do {
            let value = try await model.api.ownFeedback(registrationID: registration.id)
            authority.received(value)
            if let feedback = value.feedback {
                rating = feedback.attendanceRating
                tags = Set(feedback.tags)
                comment = feedback.comment ?? ""
                visibility = feedback.visibility
            }
            editingExisting = false
        } catch {
            authority.refreshFailed(afterSubmission: submittedReceipt != nil)
            self.error = AppModel.map(error)
        }
    }

    private func submit() {
        let trimmedComment = comment.trimmingCharacters(in: .whitespacesAndNewlines)
        let submittedTags = FeedbackTag.allCases.filter(tags.contains)
        let payload = FeedbackSubmissionPayload(
            attendanceRating: rating,
            tags: submittedTags,
            comment: trimmedComment.isEmpty ? nil : trimmedComment,
            visibility: visibility
        )
        guard let resolvedAttempt = try? StableIdempotencyAttempt.resolve(
            existing: attempt,
            payload: payload
        ) else {
            error = .init(
                id: "FEEDBACK_ENCODING_FAILED",
                message: text("journey.feedback.submit_error"),
                retryable: true
            )
            return
        }
        attempt = resolvedAttempt
        busy = true
        error = nil
        Task { @MainActor in
            defer { busy = false }
            do {
                let receipt = try await model.api.submitFeedback(
                    registrationID: registration.id,
                    payload: payload,
                    idempotencyKey: resolvedAttempt.idempotencyKey
                )
                authority.mutationSucceeded()
                submittedReceipt = receipt
                attempt = nil
                editingExisting = false
                await loadState()
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }
}

struct CheckInCorrectionView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    let event: EventSummary
    let registration: Registration

    @State private var reason = ""
    @State private var busy = false
    @State private var submitted = false
    @State private var error: UserFacingError?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if submitted {
                        SpottStateCard(
                            icon: "checkmark.seal.fill",
                            title: text("journey.correction.success_title"),
                            message: text("journey.correction.success_message"),
                            actionTitle: text("journey.common.done")
                        ) { dismiss() }
                    } else {
                        Text(text("journey.correction.title"))
                            .font(.system(size: 31, weight: .bold, design: .rounded))
                        Text(event.title)
                            .foregroundStyle(SpottColor.muted)
                        VStack(alignment: .leading, spacing: 12) {
                            Text(text("journey.correction.situation"))
                                .font(.headline)
                            TextField(
                                text("journey.correction.placeholder"),
                                text: $reason,
                                axis: .vertical
                            )
                                .lineLimit(5...10)
                                .padding(14)
                                .background(
                                    Color(uiColor: .tertiarySystemGroupedBackground),
                                    in: RoundedRectangle(cornerRadius: 16, style: .continuous)
                                )
                                .onChange(of: reason) { _, value in
                                    if value.count > 1_000 { reason = String(value.prefix(1_000)) }
                                }
                            Text(text("journey.correction.window_hint"))
                                .font(.caption)
                                .foregroundStyle(SpottColor.muted)
                        }
                        .padding(17)
                        .background(
                            Color(uiColor: .secondarySystemGroupedBackground),
                            in: RoundedRectangle(cornerRadius: 22, style: .continuous)
                        )
                        if error != nil {
                            Label(text("journey.error.action"), systemImage: "exclamationmark.circle.fill")
                                .font(.caption)
                                .foregroundStyle(SpottColor.danger)
                        }
                        Button(action: submit) {
                            HStack(spacing: 8) {
                                if busy {
                                    ProgressView().controlSize(.small)
                                } else {
                                    Image(systemName: "paperplane.fill")
                                }
                                Text(text(busy ? "journey.correction.submitting" : "journey.correction.submit"))
                            }
                            .font(.body.weight(.semibold))
                            .frame(maxWidth: .infinity, minHeight: 50)
                        }
                        .spottProminentActionStyle()
                        .disabled(reason.trimmingCharacters(in: .whitespacesAndNewlines).count < 3 || busy)
                    }
                }
                .padding(SpottMetric.pageInset)
            }
            .background(SpottScreenBackground())
            .navigationTitle(text("journey.correction.navigation_title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(text("journey.common.close")) { dismiss() }
                }
            }
        }
    }

    private func submit() {
        busy = true
        error = nil
        Task { @MainActor in
            defer { busy = false }
            do {
                _ = try await model.api.requestCheckInCorrection(
                    registrationID: registration.id,
                    reason: reason.trimmingCharacters(in: .whitespacesAndNewlines)
                )
                submitted = true
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }

    private func text(_ key: String.LocalizationValue) -> String {
        CoreJourneyLocalization.text(key, locale: locale)
    }
}

extension FeedbackTag {
    var feedbackTitle: LocalizedStringKey {
        switch self {
        case .friendly: "氛围友好"
        case .wellOrganized: "组织有序"
        case .clearInformation: "信息清楚"
        case .safe: "让人安心"
        case .wouldJoinAgain: "愿意再参加"
        }
    }
}

private extension FeedbackTag {
    var localizationKey: String.LocalizationValue {
        switch self {
        case .friendly: "journey.feedback.tag.friendly"
        case .wellOrganized: "journey.feedback.tag.well_organized"
        case .clearInformation: "journey.feedback.tag.clear_information"
        case .safe: "journey.feedback.tag.safe"
        case .wouldJoinAgain: "journey.feedback.tag.join_again"
        }
    }
}
