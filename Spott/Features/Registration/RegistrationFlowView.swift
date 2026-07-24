import Foundation
import SwiftUI

struct RegistrationFormPage: Identifiable, Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        case combined
        case attendance
        case questions
    }

    let id: Int
    let kind: Kind
    let questions: [RegistrationQuestion]
}

struct RegistrationFormPlan: Equatable, Sendable {
    let pages: [RegistrationFormPage]

    var isProgressive: Bool { pages.count > 1 }

    init(questions: [RegistrationQuestion]) {
        guard questions.count > 3 else {
            pages = [.init(id: 0, kind: .combined, questions: questions)]
            return
        }

        var progressivePages: [RegistrationFormPage] = [
            .init(id: 0, kind: .attendance, questions: []),
        ]
        for start in stride(from: 0, to: questions.count, by: 3) {
            progressivePages.append(
                .init(
                    id: progressivePages.count,
                    kind: .questions,
                    questions: Array(questions[start..<min(start + 3, questions.count)])
                )
            )
        }
        pages = progressivePages
    }
}

extension Notification.Name {
    static let spottItineraryNeedsRefresh = Notification.Name(
        "jp.spott.itinerary-needs-refresh"
    )
}

struct RegistrationItineraryRefreshNotifier: RegistrationItineraryRefreshing, Sendable {
    func refreshAfterRegistration() async {
        await MainActor.run {
            NotificationCenter.default.post(
                name: .spottItineraryNeedsRefresh,
                object: nil
            )
        }
    }
}

struct RegistrationDismissalPolicy {
    static func requiresConfirmation(
        step: RegistrationStep,
        partySize: Int,
        joinWaitlistIfFull: Bool,
        answers: [UUID: RegistrationAnswer],
        attendeeNote: String,
        isPaid: Bool,
        acceptedTerms: Bool
    ) -> Bool {
        guard step != .confirmation else { return false }
        if step != .form { return true }
        return partySize != 1
            || !joinWaitlistIfFull
            || !answers.isEmpty
            || !attendeeNote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || (isPaid && acceptedTerms)
    }
}

struct RegistrationFlowView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale
    @Environment(\.dismiss) private var dismiss

    let event: EventSummary
    let draft: DeferredRegistrationDraft
    let onCompletion: (Registration) -> Void
    /// Called when the flow disappears mid-form with resumable state (an
    /// idempotency key exists and no confirmation was reached), so the caller
    /// can pre-fill the next presentation instead of starting from defaults.
    var onDismissDraft: ((DeferredRegistrationDraft) -> Void)? = nil

    var body: some View {
        Group {
#if DEBUG
            if let kind = fixtureConfirmationKind {
                NavigationStack {
                    RegistrationConfirmationView(
                        confirmation: fixtureConfirmation(kind: kind),
                        locale: locale,
                        onViewItinerary: {
                            openItinerary(registrationID: fixtureRegistrationID)
                            dismiss()
                        },
                        onDone: dismiss.callAsFunction
                    )
                    .navigationTitle(
                        CoreJourneyLocalization.text(
                            "journey.registration.title",
                            locale: locale
                        )
                    )
                    .navigationBarTitleDisplayMode(.inline)
                }
            } else {
                flowScreen
            }
#else
            flowScreen
#endif
        }
        .id("\(model.session?.sessionId.uuidString ?? "guest")-\(locale.identifier)")
    }

    private var flowScreen: some View {
        RegistrationFlowScreen(
            event: event,
            draft: draft,
            service: model.api,
            itineraryRefresher: RegistrationItineraryRefreshNotifier(),
            locale: locale,
            onCompletion: onCompletion,
            onViewItinerary: openItinerary,
            onDismissDraft: onDismissDraft
        )
    }

    private func openItinerary(registrationID: UUID) {
        model.router.showItinerary(registrationID: registrationID)
    }

#if DEBUG
    private var fixtureConfirmationKind: RegistrationConfirmationKind? {
        switch CoreJourneyUIFixtureState.resolve() {
        case .confirmed: .confirmed
        case .pending: .pending
        case .waitlisted: .waitlisted
        case .registration, .itinerary, .none: nil
        }
    }

    private func fixtureConfirmation(
        kind: RegistrationConfirmationKind
    ) -> RegistrationConfirmation {
        let status = switch kind {
        case .confirmed: "confirmed"
        case .pending: "pending"
        case .waitlisted: "waitlisted"
        }
        return .init(
            kind: kind,
            registration: .init(
                id: fixtureRegistrationID,
                eventId: event.id,
                userId: UUID(uuidString: "019b0000-0000-7000-8800-000000000002")!,
                status: status,
                partySize: max(1, draft.partySize),
                attendeeNote: draft.attendeeNote,
                availableActions: [],
                version: 1,
                offerExpiresAt: nil,
                updatedAt: .now,
                rewardPoints: nil,
                checkinMethod: nil,
                paymentSelfReportedAt: nil,
                paymentConfirmedAt: nil
            ),
            event: event
        )
    }

    private var fixtureRegistrationID: UUID {
        UUID(uuidString: "019b0000-0000-7000-8800-000000000001")!
    }
#endif
}

@MainActor
private struct RegistrationFlowScreen: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var store: RegistrationStore
    @State private var pageIndex = 0
    @State private var showDiscardConfirmation = false
    @State private var deliveredRegistrationID: UUID?
    @FocusState private var focusedField: RegistrationField?
    @AccessibilityFocusState private var accessibilityFocusedField: RegistrationField?

    private let locale: Locale
    private let onCompletion: (Registration) -> Void
    private let onViewItinerary: (UUID) -> Void
    private let onDismissDraft: ((DeferredRegistrationDraft) -> Void)?

    init(
        event: EventSummary,
        draft: DeferredRegistrationDraft,
        service: any RegistrationServing,
        itineraryRefresher: any RegistrationItineraryRefreshing,
        locale: Locale,
        onCompletion: @escaping (Registration) -> Void,
        onViewItinerary: @escaping (UUID) -> Void,
        onDismissDraft: ((DeferredRegistrationDraft) -> Void)? = nil
    ) {
        _store = State(
            initialValue: RegistrationStore(
                event: event,
                draft: draft,
                service: service,
                itineraryRefresher: itineraryRefresher,
                locale: locale
            )
        )
        self.locale = locale
        self.onCompletion = onCompletion
        self.onViewItinerary = onViewItinerary
        self.onDismissDraft = onDismissDraft
    }

    private var plan: RegistrationFormPlan {
        RegistrationFormPlan(
            questions: store.event.registrationQuestions ?? []
        )
    }

    var body: some View {
        NavigationStack {
            Group {
                switch store.step {
                case .form:
                    RegistrationNativeForm(
                        store: store,
                        plan: plan,
                        pageIndex: $pageIndex,
                        focusedField: $focusedField,
                        accessibilityFocusedField: $accessibilityFocusedField,
                        locale: locale,
                        continueAction: continueFromForm
                    )
                case .review:
                    RegistrationReviewView(
                        store: store,
                        locale: locale,
                        submit: submit
                    )
                case .reconfirmation:
                    RegistrationReconfirmationView(
                        store: store,
                        locale: locale
                    )
                case .confirmation:
                    if let confirmation = store.confirmation {
                        RegistrationConfirmationView(
                            confirmation: confirmation,
                            locale: locale,
                            refreshMessage: store.confirmationRefreshError,
                            inviteURL: store.inviteURL,
                            paymentReport: store.canReportPayment
                                ? RegistrationPaymentReportUI(
                                    isBusy: store.isReportingPayment,
                                    reported: store.paymentReported,
                                    confirmed: store.paymentConfirmed,
                                    errorMessage: store.paymentReportError,
                                    report: reportPayment
                                )
                                : nil,
                            onViewItinerary: viewItinerary,
                            onDone: dismiss.callAsFunction
                        )
                        .task { await store.prepareInviteLink() }
                    }
                }
            }
            .navigationTitle(text("journey.registration.title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbarContent }
        }
        .interactiveDismissDisabled(store.isSubmitting || requiresDiscardConfirmation)
        .alert(
            text("journey.registration.cancel_title"),
            isPresented: $showDiscardConfirmation
        ) {
            Button(text("journey.registration.discard"), role: .destructive) {
                abandonAndDismiss()
            }
            Button(text("journey.common.back"), role: .cancel) { }
        } message: {
            Text(text("journey.registration.cancel_message"))
        }
        .onChange(of: store.firstInvalidField) { _, field in
            focusFirstInvalidField(field)
        }
        .onChange(of: store.paymentReported) { _, reported in
            guard reported else { return }
            UIAccessibility.post(
                notification: .announcement,
                argument: RegistrationExtrasLocalization.text(
                    "regextras.payment.reported_chip",
                    locale: locale
                )
            )
        }
        .onDisappear {
            // Hand mid-form state (party size, answers, note, accepted terms)
            // back to the presenter so a re-opened flow resumes where the user
            // left off instead of starting from defaults.
            if let resumable = store.resumableDraft {
                onDismissDraft?(resumable)
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            if store.step == .review {
                Button(text("journey.common.back"), action: returnToForm)
            } else if store.step != .confirmation {
                Button(text("journey.common.close"), action: requestDismissal)
            }
        }
        if store.step == .confirmation {
            ToolbarItem(placement: .confirmationAction) {
                Button(text("journey.common.done")) { dismiss() }
            }
        }
    }

    private func continueFromForm() {
        guard !store.isPreparingQuote else { return }
        if pageIndex < plan.pages.count - 1 {
            if reduceMotion {
                pageIndex += 1
            } else {
                withAnimation(.snappy) { pageIndex += 1 }
            }
            return
        }
        Task { await prepareReview() }
    }

    private func prepareReview() async {
        await store.prepareReview()
        if store.step == .form {
            focusFirstInvalidField(store.firstInvalidField)
        }
    }

    private func submit() {
        guard !store.isSubmitting else { return }
        Task { await submitAsync() }
    }

    private func reportPayment() {
        guard !store.isReportingPayment else { return }
        Task { await store.reportPayment() }
    }

    private func submitAsync() async {
        await store.submit()
        guard let confirmation = store.confirmation,
              deliveredRegistrationID != confirmation.registration.id else {
            focusFirstInvalidField(store.firstInvalidField)
            return
        }
        deliveredRegistrationID = confirmation.registration.id
        onCompletion(confirmation.registration)
        UIAccessibility.post(notification: .screenChanged, argument: nil)
    }

    private func returnToForm() {
        store.returnToForm()
        pageIndex = max(0, plan.pages.count - 1)
    }

    private func requestDismissal() {
        if requiresDiscardConfirmation {
            showDiscardConfirmation = true
        } else {
            abandonAndDismiss()
        }
    }

    private var requiresDiscardConfirmation: Bool {
        RegistrationDismissalPolicy.requiresConfirmation(
            step: store.step,
            partySize: store.partySize,
            joinWaitlistIfFull: store.joinWaitlistIfFull,
            answers: store.answers,
            attendeeNote: store.attendeeNote,
            isPaid: store.isPaidShell,
            acceptedTerms: store.acceptedTerms
        )
    }

    private func abandonAndDismiss() {
        store.abandon()
        dismiss()
    }

    private func viewItinerary() {
        guard let registrationID = store.confirmation?.registration.id else { return }
        onViewItinerary(registrationID)
        dismiss()
    }

    private func focusFirstInvalidField(_ field: RegistrationField?) {
        guard let field else { return }
        accessibilityFocusedField = nil
        if let questionIndex = questionPageIndex(for: field) {
            pageIndex = questionIndex
        }
        focusedField = field
        Task { @MainActor in
            await Task.yield()
            await Task.yield()
            accessibilityFocusedField = field
            UIAccessibility.post(
                notification: .layoutChanged,
                argument: store.validationErrors[field]
            )
        }
    }

    private func questionPageIndex(for field: RegistrationField) -> Int? {
        guard case .question(let id) = field else {
            return switch field {
            case .ticketType, .partySize, .acceptedTerms, .attendeeNote: 0
            case .question: nil
            }
        }
        return plan.pages.firstIndex { page in
            page.questions.contains(where: { $0.id == id })
        }
    }

    private func text(_ key: String.LocalizationValue) -> String {
        CoreJourneyLocalization.text(key, locale: locale)
    }
}

private struct RegistrationNativeForm: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @Bindable var store: RegistrationStore
    let plan: RegistrationFormPlan
    @Binding var pageIndex: Int
    let focusedField: FocusState<RegistrationField?>.Binding
    let accessibilityFocusedField: AccessibilityFocusState<RegistrationField?>.Binding
    let locale: Locale
    let continueAction: () -> Void

    private var page: RegistrationFormPage {
        plan.pages[min(max(pageIndex, 0), plan.pages.count - 1)]
    }

    var body: some View {
        Form {
            if plan.isProgressive {
                Section {
                    ProgressView(
                        value: Double(pageIndex + 1),
                        total: Double(plan.pages.count)
                    )
                    Text(
                        CoreJourneyLocalization.format(
                            "journey.registration.page_progress",
                            locale: locale,
                            pageIndex + 1,
                            plan.pages.count
                        )
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            }

            if let error = store.error {
                Section {
                    Label(error.message, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("registration.error.summary")
                }
            }

            switch page.kind {
            case .combined:
                RegistrationTicketTypeSection(
                    store: store,
                    focusedField: focusedField,
                    accessibilityFocusedField: accessibilityFocusedField,
                    locale: locale
                )
                RegistrationAttendanceSection(
                    store: store,
                    focusedField: focusedField,
                    accessibilityFocusedField: accessibilityFocusedField,
                    locale: locale
                )
                RegistrationPaymentTermsSection(
                    store: store,
                    focusedField: focusedField,
                    accessibilityFocusedField: accessibilityFocusedField,
                    locale: locale
                )
                RegistrationQuestionsSection(
                    store: store,
                    questions: page.questions,
                    focusedField: focusedField,
                    accessibilityFocusedField: accessibilityFocusedField,
                    locale: locale
                )
            case .attendance:
                RegistrationTicketTypeSection(
                    store: store,
                    focusedField: focusedField,
                    accessibilityFocusedField: accessibilityFocusedField,
                    locale: locale
                )
                RegistrationAttendanceSection(
                    store: store,
                    focusedField: focusedField,
                    accessibilityFocusedField: accessibilityFocusedField,
                    locale: locale
                )
                RegistrationPaymentTermsSection(
                    store: store,
                    focusedField: focusedField,
                    accessibilityFocusedField: accessibilityFocusedField,
                    locale: locale
                )
            case .questions:
                RegistrationQuestionsSection(
                    store: store,
                    questions: page.questions,
                    focusedField: focusedField,
                    accessibilityFocusedField: accessibilityFocusedField,
                    locale: locale
                )
            }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
        .background(Color(uiColor: .systemGroupedBackground))
        .scrollDismissesKeyboard(.interactively)
        .task { await store.loadTicketTypes() }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            RegistrationFormFooter(
                canGoBack: pageIndex > 0,
                isBusy: store.isPreparingQuote,
                locale: locale,
                back: goBack,
                continueAction: continueAction
            )
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("registration.form")
    }

    private func goBack() {
        if reduceMotion {
            pageIndex -= 1
        } else {
            withAnimation(.snappy) { pageIndex -= 1 }
        }
    }
}

private struct RegistrationTicketTypeSection: View {
    @Bindable var store: RegistrationStore
    let focusedField: FocusState<RegistrationField?>.Binding
    let accessibilityFocusedField: AccessibilityFocusState<RegistrationField?>.Binding
    let locale: Locale

    var body: some View {
        if store.isLoadingTicketTypes, store.activeTicketTypes.isEmpty {
            Section(extras("regextras.ticket.section")) {
                HStack(spacing: 10) {
                    ProgressView()
                    Text(extras("regextras.ticket.loading"))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
        } else if store.requiresTicketSelection {
            Section(extras("regextras.ticket.section")) {
                ForEach(store.activeTicketTypes) { ticket in
                    ticketRow(ticket)
                }
                if let error = store.validationErrors[.ticketType] {
                    RegistrationFieldError(message: error)
                }
            }
        } else if store.ticketTypesUnavailable {
            Section(extras("regextras.ticket.section")) {
                Label(
                    extras("regextras.ticket.unavailable"),
                    systemImage: "wifi.exclamationmark"
                )
                .font(.subheadline)
                .foregroundStyle(.secondary)
            }
        }
    }

    private func ticketRow(_ ticket: EventTicketType) -> some View {
        Button {
            store.selectTicketType(ticket.id)
        } label: {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(ticket.name)
                        .font(.body.weight(.medium))
                        .foregroundStyle(ticket.soldOut ? .secondary : .primary)
                    if let description = ticket.description?
                        .trimmingCharacters(in: .whitespacesAndNewlines),
                        !description.isEmpty {
                        Text(description)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                    if ticket.soldOut {
                        Text(extras("regextras.ticket.sold_out_badge"))
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(SpottColor.coral)
                    } else if let remaining = ticket.remaining, remaining <= 10 {
                        Text(
                            RegistrationExtrasLocalization.format(
                                "regextras.ticket.remaining",
                                locale: locale,
                                remaining
                            )
                        )
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(SpottColor.coral)
                    } else if let quota = ticket.quota {
                        Text(
                            RegistrationExtrasLocalization.format(
                                "regextras.ticket.quota",
                                locale: locale,
                                quota
                            )
                        )
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                    }
                    if let refundPolicy = ticket.refundPolicy?
                        .trimmingCharacters(in: .whitespacesAndNewlines),
                        !refundPolicy.isEmpty {
                        Text(refundPolicy)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 2) {
                    if ticket.isFree {
                        Text(extras("regextras.ticket.free"))
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(ticket.soldOut ? .secondary : .primary)
                    } else if let amount = ticket.amountJPY {
                        Text(amount, format: .currency(code: "JPY"))
                            .font(.subheadline.weight(.semibold))
                            .monospacedDigit()
                            .foregroundStyle(ticket.soldOut ? .secondary : .primary)
                        Text(extras("regextras.ticket.pay_onsite"))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                Image(
                    systemName: store.selectedTicketTypeID == ticket.id
                        ? "checkmark.circle.fill"
                        : "circle"
                )
                .font(.title3)
                .foregroundStyle(
                    store.selectedTicketTypeID == ticket.id
                        ? AnyShapeStyle(SpottColor.twilight)
                        : AnyShapeStyle(.tertiary)
                )
                .accessibilityHidden(true)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(ticket.soldOut)
        .focused(focusedField, equals: .ticketType)
        .accessibilityFocused(accessibilityFocusedField, equals: .ticketType)
        .accessibilityIdentifier("registration.ticket_type.\(ticket.id.uuidString.lowercased())")
        .accessibilityAddTraits(
            store.selectedTicketTypeID == ticket.id ? .isSelected : []
        )
    }

    private func extras(_ key: String.LocalizationValue) -> String {
        RegistrationExtrasLocalization.text(key, locale: locale)
    }
}

private struct RegistrationPaymentTermsSection: View {
    @Bindable var store: RegistrationStore
    let focusedField: FocusState<RegistrationField?>.Binding
    let accessibilityFocusedField: AccessibilityFocusState<RegistrationField?>.Binding
    let locale: Locale

    var body: some View {
        if let shell = store.paymentShell {
            Section(text("journey.registration.payment_terms")) {
                if let amount = shell.amountJPY {
                    LabeledContent(text("journey.registration.fee_amount")) {
                        Text(amount, format: .currency(code: "JPY"))
                            .font(.body.weight(.semibold))
                    }
                }
                paymentFact(
                    label: "journey.detail.payment_collector",
                    value: shell.collectorName
                )
                paymentFact(
                    label: "journey.detail.payment_method",
                    value: shell.method
                )
                paymentFact(
                    label: "journey.detail.payment_deadline",
                    value: shell.paymentDeadlineText
                )
                paymentFact(
                    label: "journey.detail.refund_policy",
                    value: shell.refundPolicy
                )
                Toggle(
                    text("journey.registration.accept_fee_terms"),
                    isOn: $store.acceptedTerms
                )
                .focused(focusedField, equals: .acceptedTerms)
                .accessibilityFocused(accessibilityFocusedField, equals: .acceptedTerms)
                .accessibilityIdentifier("registration.accepted_terms")
                if let error = store.validationErrors[.acceptedTerms] {
                    RegistrationFieldError(message: error)
                }
            }
        }
    }

    @ViewBuilder
    private func paymentFact(
        label: String.LocalizationValue,
        value: String?
    ) -> some View {
        if let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
           !value.isEmpty {
            LabeledContent(text(label)) {
                Text(value)
                    .multilineTextAlignment(.trailing)
            }
        }
    }

    private func text(_ key: String.LocalizationValue) -> String {
        CoreJourneyLocalization.text(key, locale: locale)
    }
}

private struct RegistrationAttendanceSection: View {
    @Bindable var store: RegistrationStore
    let focusedField: FocusState<RegistrationField?>.Binding
    let accessibilityFocusedField: AccessibilityFocusState<RegistrationField?>.Binding
    let locale: Locale

    var body: some View {
        Section(text("journey.registration.attendance")) {
            Stepper(
                value: $store.partySize,
                in: 1...max(1, store.maximumPartySize)
            ) {
                LabeledContent(text("journey.registration.party_size")) {
                    Text(store.partySize, format: .number)
                        .font(.body.monospacedDigit().weight(.semibold))
                }
            }
            .focused(focusedField, equals: .partySize)
            .accessibilityFocused(accessibilityFocusedField, equals: .partySize)
            .accessibilityIdentifier("registration.party_size")
            Text(text("journey.registration.party_size_hint"))
                .font(.caption)
                .foregroundStyle(.secondary)
            if let error = store.validationErrors[.partySize] {
                RegistrationFieldError(message: error)
            }
            if store.event.waitlistEnabled {
                Toggle(
                    text("journey.registration.waitlist_toggle"),
                    isOn: $store.joinWaitlistIfFull
                )
            }
            TextField(
                text("journey.registration.note_placeholder"),
                text: $store.attendeeNote,
                axis: .vertical
            )
            .lineLimit(2...5)
            .focused(focusedField, equals: .attendeeNote)
            .accessibilityFocused(accessibilityFocusedField, equals: .attendeeNote)
            .accessibilityIdentifier("registration.attendee_note")
            if let error = store.validationErrors[.attendeeNote] {
                RegistrationFieldError(message: error)
            }
        }
    }

    private func text(_ key: String.LocalizationValue) -> String {
        CoreJourneyLocalization.text(key, locale: locale)
    }
}

private struct RegistrationQuestionsSection: View {
    @Bindable var store: RegistrationStore
    let questions: [RegistrationQuestion]
    let focusedField: FocusState<RegistrationField?>.Binding
    let accessibilityFocusedField: AccessibilityFocusState<RegistrationField?>.Binding
    let locale: Locale

    var body: some View {
        if !questions.isEmpty {
            Section(text("journey.registration.questions")) {
                ForEach(questions) { question in
                    RegistrationQuestionRow(
                        store: store,
                        question: question,
                        focusedField: focusedField,
                        accessibilityFocusedField: accessibilityFocusedField,
                        locale: locale
                    )
                }
            }
        }
    }

    private func text(_ key: String.LocalizationValue) -> String {
        CoreJourneyLocalization.text(key, locale: locale)
    }
}

private struct RegistrationQuestionRow: View {
    @Bindable var store: RegistrationStore
    let question: RegistrationQuestion
    let focusedField: FocusState<RegistrationField?>.Binding
    let accessibilityFocusedField: AccessibilityFocusState<RegistrationField?>.Binding
    let locale: Locale

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text(question.prompt).font(.body.weight(.medium))
                Text(text(question.required ? "journey.registration.required" : "journey.registration.optional"))
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(question.required ? SpottColor.coral : .secondary)
            }
            switch question.kind {
            case .text:
                TextField(
                    text("journey.registration.text_placeholder"),
                    text: textAnswer,
                    axis: .vertical
                )
                .lineLimit(2...5)
                .focused(focusedField, equals: .question(question.id))
                .accessibilityFocused(
                    accessibilityFocusedField,
                    equals: .question(question.id)
                )
            case .singleChoice:
                Picker(question.prompt, selection: choiceAnswer) {
                    Text("—").tag("")
                    ForEach(question.options, id: \.self) { option in
                        Text(option).tag(option)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .focused(focusedField, equals: .question(question.id))
                .accessibilityFocused(
                    accessibilityFocusedField,
                    equals: .question(question.id)
                )
            case .boolean:
                Picker(question.prompt, selection: booleanAnswer) {
                    Text("—").tag("unset")
                    Text(text("journey.registration.yes")).tag("true")
                    Text(text("journey.registration.no")).tag("false")
                }
                .labelsHidden()
                .pickerStyle(.segmented)
                .focused(focusedField, equals: .question(question.id))
                .accessibilityFocused(
                    accessibilityFocusedField,
                    equals: .question(question.id)
                )
            }
            if let error = store.validationErrors[.question(question.id)] {
                RegistrationFieldError(message: error)
            }
        }
        .padding(.vertical, 4)
        .accessibilityIdentifier("registration.question.\(question.id.uuidString.lowercased())")
    }

    private var textAnswer: Binding<String> {
        Binding(
            get: {
                guard case .text(let value) = store.answers[question.id] else { return "" }
                return value
            },
            set: { store.answers[question.id] = .text($0) }
        )
    }

    private var choiceAnswer: Binding<String> {
        Binding(
            get: {
                guard case .choice(let value) = store.answers[question.id] else { return "" }
                return value
            },
            set: { value in
                store.answers[question.id] = value.isEmpty ? nil : .choice(value)
            }
        )
    }

    private var booleanAnswer: Binding<String> {
        Binding(
            get: {
                guard case .boolean(let value) = store.answers[question.id] else { return "unset" }
                return value ? "true" : "false"
            },
            set: { value in
                switch value {
                case "true": store.answers[question.id] = .boolean(true)
                case "false": store.answers[question.id] = .boolean(false)
                default: store.answers[question.id] = nil
                }
            }
        )
    }

    private func text(_ key: String.LocalizationValue) -> String {
        CoreJourneyLocalization.text(key, locale: locale)
    }
}

private struct RegistrationFieldError: View {
    let message: String

    var body: some View {
        Label(message, systemImage: "exclamationmark.circle.fill")
            .font(.caption)
            .foregroundStyle(.red)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct RegistrationFormFooter: View {
    let canGoBack: Bool
    let isBusy: Bool
    let locale: Locale
    let back: () -> Void
    let continueAction: () -> Void

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) {
                if canGoBack { backButton(fillsWidth: false) }
                continueButton
            }
            VStack(spacing: 8) {
                continueButton
                if canGoBack { backButton(fillsWidth: true) }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private var continueButton: some View {
        JourneyPrimaryActionButton(
            title: text(isBusy ? "journey.registration.preparing" : "journey.common.continue"),
            systemImage: "arrow.right",
            isBusy: isBusy,
            action: continueAction
        )
        .accessibilityIdentifier("registration.continue")
    }

    private func backButton(fillsWidth: Bool) -> some View {
        Button(text("journey.common.back"), action: back)
            .buttonStyle(.glass)
            .buttonBorderShape(.capsule)
            .frame(maxWidth: fillsWidth ? .infinity : nil, minHeight: 44)
    }

    private func text(_ key: String.LocalizationValue) -> String {
        CoreJourneyLocalization.text(key, locale: locale)
    }
}

private struct RegistrationReviewView: View {
    @Bindable var store: RegistrationStore
    let locale: Locale
    let submit: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(text("journey.registration.review_title"))
                        .font(.largeTitle.bold())
                    Text(text("journey.registration.review_message"))
                        .foregroundStyle(.secondary)
                }
                EventFactsView(
                    presentation: EventFactsPresentation(
                        event: store.event,
                        disclosure: locationDisclosure,
                        locale: locale
                    )
                )
                RegistrationReviewAnswers(store: store, locale: locale)
                if let quote = store.quote {
                    LabeledContent {
                        VStack(alignment: .trailing, spacing: 3) {
                            Text("\(quote.amount) \(quote.currency)")
                                .font(.body.weight(.semibold))
                            Text(
                                CoreJourneyLocalization.format(
                                    "journey.registration.quote_expires",
                                    locale: locale,
                                    CoreJourneyLocalization.dateTime(
                                        quote.expiresAt,
                                        timeZoneIdentifier: store.event.displayTimeZone,
                                        locale: locale
                                    )
                                )
                            )
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                    } label: {
                        Label(text("journey.registration.quote"), systemImage: "timer")
                    }
                    .padding(16)
                    .background(
                        Color(uiColor: .secondarySystemGroupedBackground),
                        in: RoundedRectangle(cornerRadius: 18, style: .continuous)
                    )
                }
                if let error = store.error {
                    RegistrationFieldError(message: error.message)
                        .accessibilityIdentifier("registration.error.summary")
                }
            }
            .padding(20)
            .padding(.bottom, 90)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .safeAreaInset(edge: .bottom, spacing: 0) {
            JourneyPrimaryActionButton(
                title: text(store.isSubmitting ? "journey.registration.submitting" : "journey.registration.submit"),
                systemImage: "paperplane.fill",
                isBusy: store.isSubmitting,
                action: submit
            )
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.bar)
        }
        .accessibilityIdentifier("registration.review")
    }

    private var locationDisclosure: EventLocationDisclosure {
        if let exact = store.event.exactAddress?.trimmingCharacters(in: .whitespacesAndNewlines),
           !exact.isEmpty,
           let area = store.event.publicArea?.trimmingCharacters(in: .whitespacesAndNewlines),
           !area.isEmpty {
            return .exact(publicArea: area, address: exact, coordinate: store.event.coordinate)
        }
        if let area = store.event.publicArea?.trimmingCharacters(in: .whitespacesAndNewlines),
           !area.isEmpty {
            return .approximate(area)
        }
        return .unavailable
    }

    private func text(_ key: String.LocalizationValue) -> String {
        CoreJourneyLocalization.text(key, locale: locale)
    }
}

private struct RegistrationReviewAnswers: View {
    @Bindable var store: RegistrationStore
    let locale: Locale

    var body: some View {
        VStack(spacing: 0) {
            if let ticket = store.selectedTicketType {
                LabeledContent(
                    RegistrationExtrasLocalization.text(
                        "regextras.ticket.section",
                        locale: locale
                    )
                ) {
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(ticket.name)
                            .multilineTextAlignment(.trailing)
                        Text(ticketPrice(ticket))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 12)
                Divider()
            }
            LabeledContent(text("journey.registration.party_size")) {
                Text(store.partySize, format: .number)
            }
            .padding(.vertical, 12)
            ForEach(store.event.registrationQuestions ?? []) { question in
                Divider()
                LabeledContent(question.prompt) {
                    Text(answer(for: question))
                        .multilineTextAlignment(.trailing)
                }
                .padding(.vertical, 12)
            }
            if !store.attendeeNote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Divider()
                LabeledContent(text("journey.registration.note")) {
                    Text(store.attendeeNote).multilineTextAlignment(.trailing)
                }
                .padding(.vertical, 12)
            }
        }
        .padding(.horizontal, 16)
        .background(
            Color(uiColor: .secondarySystemGroupedBackground),
            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
    }

    private func answer(for question: RegistrationQuestion) -> String {
        guard let answer = store.answers[question.id] else { return "—" }
        switch answer {
        case .text(let value), .choice(let value): return value
        case .boolean(let value):
            return text(value ? "journey.registration.yes" : "journey.registration.no")
        }
    }

    private func ticketPrice(_ ticket: EventTicketType) -> String {
        if ticket.isFree {
            return RegistrationExtrasLocalization.text(
                "regextras.ticket.free",
                locale: locale
            )
        }
        let payOnSite = RegistrationExtrasLocalization.text(
            "regextras.ticket.pay_onsite",
            locale: locale
        )
        guard let amount = ticket.amountJPY else { return payOnSite }
        let price = amount.formatted(.currency(code: "JPY").locale(locale))
        return "\(price) · \(payOnSite)"
    }

    private func text(_ key: String.LocalizationValue) -> String {
        CoreJourneyLocalization.text(key, locale: locale)
    }
}

private struct RegistrationReconfirmationView: View {
    @Bindable var store: RegistrationStore
    let locale: Locale

    var body: some View {
        VStack(spacing: 16) {
            Spacer(minLength: 0)
            Image(systemName: "arrow.triangle.2.circlepath.circle.fill")
                .font(.system(size: 52, weight: .semibold))
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(SpottColor.amber)
                .accessibilityHidden(true)
            VStack(spacing: 7) {
                Text(text("journey.registration.reconfirmation_title"))
                    .font(.title2.bold())
                    .multilineTextAlignment(.center)
                    .accessibilityAddTraits(.isHeader)
                Text(text("journey.registration.reconfirmation_message"))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            JourneyPrimaryActionButton(
                title: text("journey.registration.review_updates"),
                systemImage: "checkmark",
                isBusy: false,
                action: store.acceptReconfirmation
            )
            .fixedSize(horizontal: true, vertical: false)
            .padding(.top, 4)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemGroupedBackground))
        .accessibilityIdentifier("registration.reconfirmation")
    }

    private func text(_ key: String.LocalizationValue) -> String {
        CoreJourneyLocalization.text(key, locale: locale)
    }
}

struct JourneyPrimaryActionButton: View {
    let title: String
    let systemImage: String
    let isBusy: Bool
    let action: () -> Void

    var body: some View {
        button
            .buttonStyle(.glassProminent)
            .tint(SpottColor.twilight)
            .buttonBorderShape(.capsule)
            .disabled(isBusy)
    }

    private var button: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if isBusy {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: systemImage)
                }
                Text(title)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
            }
            .font(.body.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 50)
        }
    }
}
