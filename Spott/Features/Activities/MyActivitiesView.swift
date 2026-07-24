import SwiftUI
import UIKit

struct MyActivitiesView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale

    var body: some View {
        content
            .id("\(model.session?.sessionId.uuidString ?? "guest")-\(locale.identifier)")
    }

    @ViewBuilder
    private var content: some View {
#if DEBUG
        if CoreJourneyUIFixtureState.resolve() == .itinerary {
            MyActivitiesNativeScreen(
                service: MyActivitiesUIFixtureService(),
                locale: locale
            )
        } else {
            sessionContent
        }
#else
        sessionContent
#endif
    }

    @ViewBuilder
    private var sessionContent: some View {
        Group {
            if model.session == nil {
                MyActivitiesSignedOutView(locale: locale) {
                    model.presentedGate = .login
                }
            } else {
                MyActivitiesNativeScreen(
                    service: model.api,
                    locale: locale
                )
            }
        }
    }
}

@MainActor
private struct MyActivitiesNativeScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var store: MyActivitiesStore
    @State private var selectedCheckIn: MyActivitiesCheckInTarget?
    @State private var selectedFeedback: MyActivitiesCheckInTarget?
    @State private var selectedCorrection: MyActivitiesCheckInTarget?
    @State private var selectedStatus: MyActivityItem?
    @State private var cancellationTarget: MyActivityItem?
    @State private var routeInFlight: UUID?
    @State private var didStart = false
    @State private var focusedRegistrationID: UUID?

    private let locale: Locale
    private let presentation: MyActivitiesPagePresentation

    init(service: any MyActivitiesServing, locale: Locale) {
        _store = State(initialValue: MyActivitiesStore(service: service, locale: locale))
        self.locale = locale
        presentation = .init(locale: locale)
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 24) {
                    MyActivitiesHeader(presentation: presentation)

                    if let error = store.error, !store.items.isEmpty {
                        MyActivitiesInlineNotice(
                            message: error.message,
                            retry: { Task { await store.refresh() } }
                        )
                    }

                    content
                }
                .padding(.horizontal, 18)
                .padding(.top, 18)
                .padding(.bottom, 42)
            }
            .background(Color(uiColor: .systemGroupedBackground).ignoresSafeArea())
            .refreshable { await store.refresh() }
            .task {
                await startIfNeeded()
                focusPendingRegistration(using: proxy)
            }
            .onChange(of: model.router.pendingItineraryRegistrationID) { _, _ in
                focusPendingRegistration(using: proxy)
            }
            .onChange(of: store.items.map(\.registration.id)) { _, _ in
                focusPendingRegistration(using: proxy)
            }
        }
        .task(id: store.nextTemporalRefreshDate) {
            await refreshAtNextTemporalBoundary()
        }
        .onReceive(
            NotificationCenter.default.publisher(for: .spottItineraryNeedsRefresh)
        ) { _ in
            Task { await store.refresh() }
        }
        .sheet(item: $selectedCheckIn, onDismiss: refreshAfterCheckIn) { target in
            NavigationStack {
                ParticipantCheckInView(
                    event: target.event,
                    registration: target.registration
                )
            }
        }
        .sheet(item: $selectedFeedback, onDismiss: refreshAfterCheckIn) { target in
            FeedbackSubmissionView(
                event: target.event,
                registration: target.registration
            )
        }
        .sheet(item: $selectedCorrection, onDismiss: refreshAfterCheckIn) { target in
            CheckInCorrectionView(
                event: target.event,
                registration: target.registration
            )
        }
        .sheet(item: $selectedStatus) { item in
            MyActivityStatusSheet(item: item, locale: locale)
        }
        .sheet(item: waitlistAcceptanceReviewBinding) { review in
            WaitlistAcceptanceReviewSheet(
                review: review,
                locale: locale,
                isBusy: store.actionInFlight == review.registrationID,
                confirm: { Task { await store.confirmWaitlistAcceptance() } },
                cancel: { store.dismissWaitlistAcceptanceReview() }
            )
            .interactiveDismissDisabled(store.actionInFlight == review.registrationID)
        }
        .alert(
            text("journey.itinerary.cancel.title"),
            isPresented: cancellationAlertPresented
        ) {
            Button(text("journey.itinerary.cancel.confirm"), role: .destructive) {
                confirmCancellation()
            }
            .accessibilityIdentifier("itinerary.cancel.confirm")
            Button(text("journey.common.cancel"), role: .cancel) {
                cancellationTarget = nil
            }
            .accessibilityIdentifier("itinerary.cancel.dismiss")
        } message: {
            Text(text("journey.itinerary.cancel.message"))
        }
        .accessibilityIdentifier("itinerary.screen")
    }

    @ViewBuilder
    private var content: some View {
        if store.isLoading && store.items.isEmpty {
            VStack(spacing: 14) {
                ForEach(0..<3, id: \.self) { _ in
                    MyActivityNativeSkeleton()
                }
            }
            .accessibilityLabel(CoreJourneyLocalization.text(
                "journey.detail.refreshing",
                locale: locale
            ))
        } else if let error = store.error, store.items.isEmpty {
            MyActivitiesStateCard(
                systemImage: "wifi.exclamationmark",
                title: error.message,
                message: presentation.syncError,
                actionTitle: CoreJourneyLocalization.text(
                    "journey.common.retry",
                    locale: locale
                )
            ) {
                Task { await store.refresh() }
            }
        } else if store.items.isEmpty {
            SpottEmptyState(
                icon: "calendar.badge.plus",
                title: presentation.emptyTitle,
                message: presentation.emptyMessage,
                actionTitle: presentation.discoverAction
            ) {
                model.router.selectedTab = .discovery
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 42)
        } else {
            ForEach(store.sections.filter { !$0.items.isEmpty }) { section in
                MyActivitiesNativeSection(
                    section: section,
                    locale: locale,
                    actionInFlight: store.actionInFlight ?? routeInFlight,
                    focusedRegistrationID: focusedRegistrationID,
                    reportedPaymentIDs: store.reportedPaymentRegistrationIDs,
                    action: perform
                )
            }
        }
    }

    private func startIfNeeded() async {
        guard !didStart else { return }
        didStart = true
        await store.refresh()
    }

    private func perform(_ action: MyActivityNextAction, item: MyActivityItem) {
        switch action {
        case .acceptWaitlist, .reportPayment:
            Task { await store.perform(action) }
        case .cancelRegistration:
            cancellationTarget = item
        case .checkIn(_, let reference):
            loadEvent(reference: reference, item: item, destination: .checkIn)
        case .correctAttendance(_, let reference):
            loadEvent(reference: reference, item: item, destination: .correction)
        case .leaveFeedback(_, let reference):
            loadEvent(reference: reference, item: item, destination: .feedback)
        case .viewStatus:
            selectedStatus = item
        case .viewEvent(let reference):
#if DEBUG
            if CoreJourneyUIFixtureState.resolve() == .itinerary,
               let event = item.event {
                model.router.show(event: event.coreJourneyDetailFixture, in: .profile)
                return
            }
#endif
            model.router.push(.event(reference), in: .profile)
        case .none:
            break
        }
    }

    private func loadEvent(
        reference: EventRouteReference,
        item: MyActivityItem,
        destination: MyActivitiesLoadedDestination
    ) {
        guard routeInFlight == nil else { return }
        routeInFlight = item.registration.id
        Task { @MainActor in
            defer { routeInFlight = nil }
            do {
                let event = try await model.api.event(identifier: reference.identifier)
                let target = MyActivitiesCheckInTarget(
                    event: event,
                    registration: item.registration
                )
                switch destination {
                case .checkIn: selectedCheckIn = target
                case .correction: selectedCorrection = target
                case .feedback: selectedFeedback = target
                }
            } catch {
                model.banner = .init(
                    title: text("journey.error.action"),
                    tone: .warning
                )
            }
        }
    }

    private func refreshAfterCheckIn() {
        Task { await store.refresh() }
    }

    private var waitlistAcceptanceReviewBinding: Binding<WaitlistAcceptanceReview?> {
        Binding(
            get: { store.waitlistAcceptanceReview },
            set: { value in
                if value == nil { store.dismissWaitlistAcceptanceReview() }
            }
        )
    }

    private func focusPendingRegistration(using proxy: ScrollViewProxy) {
        guard let registrationID = model.router.pendingItineraryRegistrationID,
              store.items.contains(where: { $0.registration.id == registrationID }) else {
            return
        }
        focusedRegistrationID = registrationID
        if reduceMotion {
            proxy.scrollTo(registrationID, anchor: .center)
        } else {
            withAnimation(.snappy) {
                proxy.scrollTo(registrationID, anchor: .center)
            }
        }
        _ = model.router.completeItineraryFocus(registrationID)
        UIAccessibility.post(notification: .screenChanged, argument: nil)
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(2))
            if focusedRegistrationID == registrationID {
                focusedRegistrationID = nil
            }
        }
    }

    private func refreshAtNextTemporalBoundary() async {
        guard let delay = store.temporalRefreshDelay() else { return }
        do {
            try await Task.sleep(for: .seconds(max(0.01, delay)))
            try Task.checkCancellation()
            store.refreshTemporalState()
            await store.refresh()
        } catch {
            return
        }
    }

    private var cancellationAlertPresented: Binding<Bool> {
        Binding(
            get: { cancellationTarget != nil },
            set: { if !$0 { cancellationTarget = nil } }
        )
    }

    private func confirmCancellation() {
        guard let item = cancellationTarget,
              let action = item.cancellationAction else { return }
        cancellationTarget = nil
        Task { await store.perform(action) }
    }

    private func text(_ key: String.LocalizationValue) -> String {
        CoreJourneyLocalization.text(key, locale: locale)
    }
}

private struct MyActivitiesSignedOutView: View {
    let locale: Locale
    let signIn: () -> Void

    private var presentation: MyActivitiesPagePresentation {
        .init(locale: locale)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                MyActivitiesHeader(presentation: presentation)

                MyActivitiesStateCard(
                    systemImage: "person.crop.circle.badge.checkmark",
                    title: presentation.signInTitle,
                    message: presentation.signInMessage,
                    actionTitle: presentation.signInAction,
                    action: signIn
                )
            }
            .padding(.horizontal, 18)
            .padding(.top, 18)
            .padding(.bottom, 42)
        }
        .background(Color(uiColor: .systemGroupedBackground).ignoresSafeArea())
        .accessibilityIdentifier("itinerary.signed_out")
    }
}

private struct MyActivitiesHeader: View {
    let presentation: MyActivitiesPagePresentation

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("SPOTT", systemImage: "sparkles")
                .font(.caption.monospaced().bold())
                .foregroundStyle(SpottColor.coral)
                .accessibilityHidden(true)

            Text(presentation.title)
                .font(.largeTitle.bold())
                .tracking(-0.8)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("itinerary.title")

            Text(presentation.subtitle)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct MyActivitiesNativeSection: View {
    let section: MyActivitiesSection
    let locale: Locale
    let actionInFlight: UUID?
    let focusedRegistrationID: UUID?
    let reportedPaymentIDs: Set<UUID>
    let action: (MyActivityNextAction, MyActivityItem) -> Void

    private var presentation: MyActivitySectionPresentation {
        .init(group: section.group, locale: locale)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text(presentation.title)
                    .font(.title3.bold())
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                Text(section.items.count, format: .number)
                    .font(.caption.monospacedDigit().weight(.semibold))
                    .foregroundStyle(.secondary)
            }

            rows
        }
        .accessibilityIdentifier("itinerary.section.\(section.group.rawValue)")
    }

    private var rows: some View {
        LazyVStack(spacing: 14) {
            ForEach(section.items) { item in
                MyActivityNativeRow(
                    item: item,
                    locale: locale,
                    isBusy: actionInFlight == item.registration.id,
                    isFocused: focusedRegistrationID == item.registration.id,
                    paymentReported: reportedPaymentIDs.contains(item.registration.id),
                    open: {
                        if let event = item.event {
                            action(
                                .viewEvent(.init(id: event.id, slug: event.publicSlug)),
                                item
                            )
                        } else {
                            action(.viewStatus(item.registration.id), item)
                        }
                    },
                    primaryAction: { action(item.nextAction, item) },
                    reportPayment: item.registration.status == "confirmed"
                        && !reportedPaymentIDs.contains(item.registration.id)
                        ? { action(.reportPayment(item.registration.id), item) }
                        : nil,
                    cancel: item.cancellationAction.map { cancellationAction in
                        { action(cancellationAction, item) }
                    }
                )
                .id(item.registration.id)
            }
        }
    }
}

private struct MyActivityNativeRow: View {
    let item: MyActivityItem
    let locale: Locale
    let isBusy: Bool
    let isFocused: Bool
    let paymentReported: Bool
    let open: () -> Void
    let primaryAction: () -> Void
    let reportPayment: (() -> Void)?
    let cancel: (() -> Void)?

    private var presentation: MyActivityRowPresentation {
        .init(item: item, locale: locale)
    }

    var body: some View {
        content
            .background(
                Color(uiColor: .secondarySystemGroupedBackground),
                in: RoundedRectangle(cornerRadius: 22, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .stroke(
                        isFocused ? SpottColor.coral : Color.primary.opacity(0.08),
                        lineWidth: isFocused ? 2 : 0.5
                    )
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(
                "itinerary.item.\(item.registration.id.uuidString.lowercased())"
            )
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 15) {
            Button(action: open) {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .top, spacing: 14) {
                        MyActivityNativeCover(event: item.event)
                            .frame(width: 86, height: 96)
                        eventSummary
                        Spacer(minLength: 0)
                    }
                    VStack(alignment: .leading, spacing: 12) {
                        MyActivityNativeCover(event: item.event)
                            .frame(maxWidth: .infinity)
                            .frame(height: 142)
                        eventSummary
                    }
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier(
                "itinerary.item.\(item.registration.id.uuidString.lowercased()).open"
            )

            if paymentReported {
                paymentReportedChip
            }

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) {
                    partySize
                    Spacer(minLength: 0)
                    actionButton(fillsWidth: false)
                    overflowMenu
                }
                VStack(alignment: .leading, spacing: 10) {
                    partySize
                    actionButton(fillsWidth: true)
                    overflowMenu
                }
            }
        }
        .padding(15)
    }

    private var paymentReportedChip: some View {
        GlassPill(
            text: RegistrationExtrasLocalization.text(
                "regextras.payment.reported_chip",
                locale: locale
            ),
            systemImage: "clock.badge.checkmark",
            tint: SpottColor.amber
        )
        .accessibilityIdentifier(
            "itinerary.item.\(item.registration.id.uuidString.lowercased()).payment_chip"
        )
    }

    private var eventSummary: some View {
        VStack(alignment: .leading, spacing: 7) {
            GlassPill(text: presentation.status, tint: statusTint)

            Text(presentation.title)
                .font(.headline)
                .foregroundStyle(.primary)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)

            Label(presentation.date, systemImage: "calendar")
                .lineLimit(3)
            Label(
                presentation.location,
                systemImage: item.event?.format == .online ? "video" : "mappin.and.ellipse"
            )
            .lineLimit(3)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    private var partySize: some View {
        Label {
            Text(item.registration.partySize, format: .number)
        } icon: {
            Image(systemName: "person.2")
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
        .accessibilityLabel(
            "\(CoreJourneyLocalization.text("journey.registration.party_size", locale: locale)): \(item.registration.partySize)"
        )
    }

    @ViewBuilder
    private func actionButton(fillsWidth: Bool) -> some View {
        if let title = presentation.actionTitle,
           let systemImage = presentation.actionSystemImage {
            MyActivityNativeActionButton(
                title: title,
                systemImage: systemImage,
                isBusy: isBusy,
                isProminent: isProminentAction,
                fillsWidth: fillsWidth,
                action: primaryAction
            )
        }
    }

    @ViewBuilder
    private var overflowMenu: some View {
        if cancel != nil || reportPayment != nil {
            Menu {
                if let reportPayment {
                    Button(action: reportPayment) {
                        Label(
                            RegistrationExtrasLocalization.text(
                                "regextras.payment.report_action",
                                locale: locale
                            ),
                            systemImage: "yensign.circle"
                        )
                    }
                    .accessibilityIdentifier(
                        "itinerary.item.\(item.registration.id.uuidString.lowercased()).report_payment"
                    )
                }
                if let cancel {
                    Button(role: .destructive, action: cancel) {
                        Label(
                            text("journey.itinerary.action.cancel"),
                            systemImage: "xmark.circle"
                        )
                    }
                    .accessibilityIdentifier(
                        "itinerary.item.\(item.registration.id.uuidString.lowercased()).cancel"
                    )
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.body.weight(.semibold))
                    .frame(minWidth: 44, minHeight: 44)
                    .accessibilityLabel(text("journey.itinerary.action.more"))
            }
            .buttonBorderShape(.circle)
            .modifier(MyActivityOverflowButtonStyle())
            .disabled(isBusy)
            .accessibilityIdentifier(
                "itinerary.item.\(item.registration.id.uuidString.lowercased()).more"
            )
        }
    }

    private var isProminentAction: Bool {
        switch item.nextAction {
        case .acceptWaitlist, .checkIn, .correctAttendance, .leaveFeedback: true
        case .cancelRegistration, .reportPayment, .viewStatus, .viewEvent, .none: false
        }
    }

    private var statusTint: Color {
        switch item.registration.status {
        case "confirmed", "checked_in": SpottColor.mint
        case "offered": SpottColor.coral
        case "pending", "waitlisted": SpottColor.amber
        default: .secondary
        }
    }

    private func text(_ key: String.LocalizationValue) -> String {
        CoreJourneyLocalization.text(key, locale: locale)
    }
}

private struct MyActivityOverflowButtonStyle: ViewModifier {
    func body(content: Content) -> some View {
        content.buttonStyle(.glass)
    }
}

private struct MyActivityNativeActionButton: View {
    let title: String
    let systemImage: String
    let isBusy: Bool
    let isProminent: Bool
    let fillsWidth: Bool
    let action: () -> Void

    var body: some View {
        Group {
            if isProminent {
                button
                    .buttonStyle(.glassProminent)
                    .tint(SpottColor.twilight)
            } else {
                button.buttonStyle(.glass)
            }
        }
        .buttonBorderShape(.capsule)
        .disabled(isBusy)
    }

    private var button: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                if isBusy {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: systemImage)
                }
                Text(title)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
            }
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: fillsWidth ? .infinity : nil, minHeight: 44)
        }
    }
}

private struct MyActivityNativeCover: View {
    let event: ItineraryEventSummary?

    var body: some View {
        EventCoverView(
            url: event?.coverURL,
            category: "",
            cornerRadius: 16
        )
    }
}

private struct MyActivitiesInlineNotice: View {
    @Environment(\.locale) private var locale
    let message: String
    let retry: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 11) {
            Image(systemName: "arrow.triangle.2.circlepath.circle.fill")
                .foregroundStyle(SpottColor.amber)
            Text(message)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: retry) {
                Image(systemName: "arrow.clockwise")
                    .frame(minWidth: 44, minHeight: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(
                CoreJourneyLocalization.text("journey.common.retry", locale: locale)
            )
        }
        .padding(13)
        .background(
            SpottColor.amber.opacity(0.08),
            in: RoundedRectangle(cornerRadius: 16, style: .continuous)
        )
        .accessibilityIdentifier("itinerary.sync_error")
    }
}

private struct MyActivitiesStateCard: View {
    let systemImage: String
    let title: String
    let message: String
    let actionTitle: String
    let action: () -> Void

    var body: some View {
        content
            .background(
                Color(uiColor: .secondarySystemGroupedBackground),
                in: RoundedRectangle(cornerRadius: 24, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .stroke(Color.primary.opacity(0.08), lineWidth: 0.5)
            }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 16) {
            Image(systemName: systemImage)
                .font(.system(size: 30, weight: .semibold))
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(SpottColor.muted)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 7) {
                Text(title)
                    .font(.title2.bold())
                    .fixedSize(horizontal: false, vertical: true)
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            JourneyPrimaryActionButton(
                title: actionTitle,
                systemImage: "arrow.right",
                isBusy: false,
                action: action
            )
        }
        .padding(22)
    }
}

private struct MyActivityNativeSkeleton: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 22, style: .continuous)
            .fill(Color.primary.opacity(0.055))
            .frame(height: 158)
            .redacted(reason: .placeholder)
            .accessibilityHidden(true)
    }
}

private struct MyActivityStatusSheet: View {
    @Environment(\.dismiss) private var dismiss

    let item: MyActivityItem
    let locale: Locale

    private var presentation: MyActivityRowPresentation {
        .init(item: item, locale: locale)
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    LabeledContent(
                        CoreJourneyLocalization.text(
                            "journey.registration.status_label",
                            locale: locale
                        ),
                        value: presentation.status
                    )
                    LabeledContent(
                        CoreJourneyLocalization.text(
                            "journey.registration.party_size",
                            locale: locale
                        )
                    ) {
                        Text(item.registration.partySize, format: .number)
                    }
                }
                if let note = item.registration.attendeeNote?.trimmingCharacters(
                    in: .whitespacesAndNewlines
                ), !note.isEmpty {
                    Section(
                        CoreJourneyLocalization.text(
                            "journey.registration.note",
                            locale: locale
                        )
                    ) {
                        Text(note)
                    }
                }
            }
            .navigationTitle(presentation.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(
                        CoreJourneyLocalization.text("journey.common.done", locale: locale)
                    ) { dismiss() }
                }
            }
        }
        .accessibilityIdentifier("itinerary.status")
    }
}

private struct WaitlistAcceptanceReviewSheet: View {
    let review: WaitlistAcceptanceReview
    let locale: Locale
    let isBusy: Bool
    let confirm: () -> Void
    let cancel: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    hero
                    reviewCard
                    chargeNote
                    actions
                }
                .padding(.horizontal, 20)
                .padding(.top, 26)
                .padding(.bottom, 32)
            }
            .background(background.ignoresSafeArea())
            .navigationTitle(text("journey.waitlist.review.navigation_title"))
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(.ultraThinMaterial)
        .accessibilityIdentifier("itinerary.waitlist.review")
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(text("journey.waitlist.review.eyebrow"), systemImage: "ticket.fill")
                .font(.caption.weight(.bold))
                .foregroundStyle(SpottColor.coral)
                .textCase(.uppercase)

            Text(text("journey.waitlist.review.title"))
                .font(.system(.largeTitle, design: .rounded, weight: .bold))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)

            Text(text("journey.waitlist.review.body"))
                .font(.body)
                .foregroundStyle(.secondary)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var reviewCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            LabeledContent(text("journey.waitlist.review.event")) {
                Text(review.eventTitle)
                    .multilineTextAlignment(.trailing)
            }
            LabeledContent(text("journey.waitlist.review.party")) {
                Text(review.partySize, format: .number)
            }

            Divider()

            VStack(alignment: .leading, spacing: 6) {
                Text(text("journey.waitlist.review.cost"))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                HStack(alignment: .firstTextBaseline, spacing: 7) {
                    Text(review.quote.amount, format: .number)
                        .font(.system(size: 38, weight: .bold, design: .rounded))
                        .monospacedDigit()
                    Text(pointsLabel)
                        .font(.headline)
                        .foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel(
                    "\(text("journey.waitlist.review.cost")): \(review.quote.amount) \(pointsLabel)"
                )
            }

            Divider()

            Label {
                VStack(alignment: .leading, spacing: 3) {
                    Text(text("journey.waitlist.review.offer_deadline"))
                        .font(.caption.weight(.semibold))
                    Text(deadline)
                        .font(.subheadline.monospacedDigit())
                }
            } icon: {
                Image(systemName: "timer")
                    .foregroundStyle(SpottColor.amber)
            }
        }
        // Content card (红线2): the offer review block is multi-line text, so it
        // sits on a solid surface instead of glass.
        .padding(18)
        .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).stroke(SpottColor.hairline))
        .shadow(color: SpottColor.ink.opacity(0.055), radius: 20, y: 8)
    }

    private var chargeNote: some View {
        Label {
            Text(text("journey.waitlist.review.charge_note"))
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "checkmark.shield.fill")
                .foregroundStyle(SpottColor.mint)
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 4)
    }

    private var actions: some View {
        VStack(spacing: 12) {
            Button(action: confirm) {
                HStack(spacing: 9) {
                    if isBusy { ProgressView().controlSize(.small) }
                    Text(text(
                        isBusy
                            ? "journey.waitlist.review.confirming"
                            : "journey.waitlist.review.confirm"
                    ))
                    .font(.headline)
                }
                .frame(maxWidth: .infinity, minHeight: 50)
            }
            .spottProminentActionStyle()
            .disabled(isBusy)
            .accessibilityIdentifier("itinerary.waitlist.review.confirm")

            Button(text("journey.common.cancel"), action: cancel)
                .font(.headline)
                .frame(maxWidth: .infinity, minHeight: 48)
                .buttonStyle(.plain)
                .disabled(isBusy)
                .accessibilityIdentifier("itinerary.waitlist.review.cancel")
        }
    }

    private var pointsLabel: String {
        text(
            review.quote.amount == 1
                ? "journey.waitlist.review.points.one"
                : "journey.waitlist.review.points.other"
        )
    }

    private var deadline: String {
        let deadline = min(review.offerExpiresAt, review.quote.expiresAt)
        return CoreJourneyLocalization.dateTime(
            deadline,
            timeZoneIdentifier: TimeZone.current.identifier,
            locale: locale
        )
    }

    private var background: some View {
        LinearGradient(
            colors: [
                Color(uiColor: .systemGroupedBackground),
                SpottColor.twilight.opacity(0.09),
                SpottColor.coral.opacity(0.07),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    private func text(_ key: String.LocalizationValue) -> String {
        CoreJourneyLocalization.text(key, locale: locale)
    }
}

private enum MyActivitiesLoadedDestination {
    case checkIn
    case correction
    case feedback
}

private struct MyActivitiesCheckInTarget: Identifiable {
    let event: EventSummary
    let registration: Registration

    var id: UUID { registration.id }
}

#if DEBUG
private actor MyActivitiesUIFixtureService: MyActivitiesServing {
    func registrationItinerary(
        cursor: String?,
        limit: Int
    ) async throws -> RegistrationItineraryPage {
        try Self.makePage()
    }

    func quote(purpose: String, resourceID: UUID?) async throws -> Quote {
        .init(
            id: UUID(uuidString: "019b0000-0000-7000-8600-000000000001")!,
            amount: 10,
            currency: "POINTS",
            expiresAt: Date().addingTimeInterval(15 * 60)
        )
    }

    func acceptWaitlist(
        registrationID: UUID,
        quoteID: UUID,
        expectedRegistrationVersion: Int,
        expectedEventVersion: Int,
        idempotencyKey: UUID
    ) async throws -> Registration {
        try Self.registration(id: registrationID)
    }

    func cancelRegistration(registrationID: UUID) async throws -> RegistrationCancellation {
        .init(
            registration: try Self.registration(id: registrationID),
            refundedPoints: 0,
            wallet: .init(paidBalance: 0, freeBalance: 0, totalBalance: 0, version: 1)
        )
    }

    func reportPayment(registrationID: UUID) async throws -> TicketPaymentReport {
        .init(
            registrationId: registrationID,
            paymentStatus: "self_reported",
            selfReportedAt: Date()
        )
    }

    private static func registration(id: UUID) throws -> Registration {
        guard let registration = try makePage().items
            .map(\.registration)
            .first(where: { $0.id == id }) else {
            throw MyActivitiesUIFixtureError.missingRegistration
        }
        return registration
    }

    private static func makePage() throws -> RegistrationItineraryPage {
        let payload: [String: Any] = [
            "items": [
                item(
                    index: 1,
                    title: "Tokyo Makers Night",
                    status: "pending",
                    startsAt: "2026-07-18T10:00:00Z",
                    endsAt: "2026-07-18T12:00:00Z",
                    actions: ["cancelRegistration"]
                ),
                item(
                    index: 2,
                    title: "Tea, Type & Design",
                    status: "offered",
                    startsAt: "2026-07-19T05:00:00Z",
                    endsAt: "2026-07-19T07:00:00Z",
                    actions: ["register", "cancelRegistration"],
                    offerExpiresAt: "2026-07-18T03:00:00Z"
                ),
                item(
                    index: 3,
                    title: "Sunset Photo Walk",
                    status: "confirmed",
                    startsAt: "2026-07-20T08:30:00Z",
                    endsAt: "2026-07-20T10:30:00Z",
                    actions: ["checkIn", "cancelRegistration"]
                ),
            ],
            "nextCursor": NSNull(),
            "hasMore": false,
            "serverTime": "2026-07-16T03:00:00Z",
        ]
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(
            RegistrationItineraryPage.self,
            from: JSONSerialization.data(withJSONObject: payload)
        )
    }

    private static func item(
        index: Int,
        title: String,
        status: String,
        startsAt: String,
        endsAt: String,
        actions: [String],
        offerExpiresAt: String? = nil
    ) -> [String: Any] {
        let registrationID = String(format: "019b0000-0000-7000-8400-%012d", index)
        let eventID = String(format: "019b0000-0000-7000-8500-%012d", index)
        return [
            "registration": [
                "id": registrationID,
                "eventId": eventID,
                "userId": "019b0000-0000-7000-8000-000000000001",
                "status": status,
                "partySize": index == 3 ? 2 : 1,
                "attendeeNote": NSNull(),
                "availableActions": actions,
                "version": 1,
                "offerExpiresAt": offerExpiresAt as Any? ?? NSNull(),
                "updatedAt": "2026-07-16T02:00:00Z",
                "rewardPoints": NSNull(),
                "checkinMethod": NSNull(),
            ],
            "event": [
                "id": eventID,
                "publicSlug": "fixture-event-\(index)",
                "status": "published",
                "title": title,
                "startsAt": startsAt,
                "endsAt": endsAt,
                "displayTimeZone": "Asia/Tokyo",
                "region": "tokyo",
                "publicArea": index == 2 ? "Daikanyama" : "Shibuya",
                "coverURL": NSNull(),
                "format": index == 2 ? "hybrid" : "in_person",
                "primaryLocale": index == 1 ? "en" : "ja",
                "localeConfirmed": true,
                "version": 1,
                "updatedAt": "2026-07-15T00:00:00Z",
            ],
        ]
    }
}

private enum MyActivitiesUIFixtureError: Error {
    case missingRegistration
}

private extension ItineraryEventSummary {
    var coreJourneyDetailFixture: EventSummary {
        let template = EventSummary.samples[0]
        return .init(
            id: id,
            publicSlug: publicSlug,
            organizerId: template.organizerId,
            status: status,
            title: title,
            description: "A deterministic native event-detail fixture.",
            category: "community",
            startsAt: startsAt,
            endsAt: endsAt,
            deadlineAt: startsAt?.addingTimeInterval(-3_600),
            displayTimeZone: displayTimeZone,
            region: region,
            publicArea: publicArea,
            capacity: 24,
            confirmedCount: 12,
            availableCapacity: 12,
            coverURL: coverURL,
            tags: ["fixture"],
            organizer: template.organizer,
            favorited: false,
            registrationStatus: nil,
            viewerRegistration: nil,
            registrationMode: "automatic",
            waitlistEnabled: true,
            format: format,
            primaryLocale: primaryLocale,
            supportedLocales: [primaryLocale],
            localeConfirmed: localeConfirmed,
            availableActions: [.register],
            version: version,
            updatedAt: updatedAt,
            coordinate: nil,
            exactAddress: nil,
            fee: template.fee
        )
    }
}
#endif
