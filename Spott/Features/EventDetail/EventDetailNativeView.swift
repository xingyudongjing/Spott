import SwiftUI
import UIKit

struct EventDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale

    private let event: EventSummary
    private let sourceTab: AppTab
    private let refreshOnAppear: Bool
    private let initialViewerSnapshotIsCurrent: Bool
    private let actionRunner: EventDetailActionRunner?

    init(
        event: EventSummary,
        sourceTab: AppTab,
        refreshOnAppear: Bool = true,
        initialViewerSnapshotIsCurrent: Bool = false,
        actionRunner: EventDetailActionRunner? = nil
    ) {
        self.event = event
        self.sourceTab = sourceTab
        self.refreshOnAppear = refreshOnAppear
        self.initialViewerSnapshotIsCurrent = initialViewerSnapshotIsCurrent
        self.actionRunner = actionRunner
    }

    var body: some View {
        EventDetailNativeScreen(
            initialEvent: event,
            service: model.api,
            session: ctaSession,
            locale: locale,
            sourceTab: sourceTab,
            refreshOnAppear: refreshOnAppear,
            initialViewerSnapshotIsCurrent: initialViewerSnapshotIsCurrent,
            actionRunner: actionRunner
        )
        .id(
            "\(model.session?.sessionId.uuidString ?? "guest")-"
                + "\(model.session?.user.id.uuidString ?? "anonymous")-"
                + "\(locale.identifier)-\(event.id)"
        )
    }

    private var ctaSession: EventCTASession {
#if DEBUG
        if let fixture = CoreJourneyUIFixtureState.resolve(),
           [.registration, .confirmed, .pending, .waitlisted].contains(fixture) {
            return .verified
        }
#endif
        guard let session = model.session else { return .guest }
        return session.user.phoneVerified ? .verified : .unverified
    }
}

@MainActor
struct EventDetailNativeScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    @State private var store: EventDetailStore
    @State private var registrationPresented = false
    @State private var registrationDraft = DeferredRegistrationDraft()
    @State private var favorited: Bool
    @State private var isPrimaryActionBusy = false
    @State private var isAddingToCalendar = false
    @State private var didStart = false
    @State private var notice: String?
    @State private var reportTarget: SafetyReportTarget?
    @State private var showBlockConfirmation = false
    @State private var feedbackSummary: FeedbackSummary?
    @State private var shareItem: EventShareItem?
    @State private var posterEvent: EventSummary?
    @State private var checkInRegistration: Registration?
    @State private var cancellationRegistrationID: UUID?
    @State private var actionRunner: EventDetailActionRunner

    private let sourceTab: AppTab
    private let refreshOnAppear: Bool
    private let locale: Locale

    init(
        initialEvent: EventSummary,
        service: any EventDetailServing,
        session: EventCTASession,
        locale: Locale,
        sourceTab: AppTab,
        refreshOnAppear: Bool,
        initialViewerSnapshotIsCurrent: Bool,
        actionRunner: EventDetailActionRunner? = nil
    ) {
        _store = State(
            initialValue: EventDetailStore(
                initialEvent: initialEvent,
                service: service,
                session: session,
                initialViewerSnapshotIsCurrent: initialViewerSnapshotIsCurrent,
                locale: locale
            )
        )
        _favorited = State(initialValue: initialEvent.favorited)
        _actionRunner = State(initialValue: actionRunner ?? EventDetailActionRunner())
        self.sourceTab = sourceTab
        self.refreshOnAppear = refreshOnAppear
        self.locale = locale
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                EventDetailHeroView(event: store.event, locale: locale)

                VStack(alignment: .leading, spacing: 24) {
                    titleSection

                    if store.isRefreshing {
                        Label(text("journey.detail.refreshing"), systemImage: "arrow.triangle.2.circlepath")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }

                    if store.error != nil {
                        Label(
                            text("journey.detail.refresh_failed"),
                            systemImage: "wifi.exclamationmark"
                        )
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("event.detail.refresh_error")
                    }

                    EventFactsView(
                        presentation: EventFactsPresentation(
                            event: store.event,
                            disclosure: store.locationDisclosure(
                                viewerID: model.session?.user.id
                            ),
                            locale: locale
                        )
                    )

                    if !actionBarLayoutPolicy.showsSupportingTextInBar {
                        Text(actionPresentation.supportingText)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(14)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(
                                Color(uiColor: .secondarySystemGroupedBackground),
                                in: RoundedRectangle(cornerRadius: 16, style: .continuous)
                            )
                            .accessibilityIdentifier("event.action.supporting-text")
                    }

                    if !actionBarLayoutPolicy.pinsActionBar {
                        EventActionBar(
                            presentation: actionPresentation,
                            isBusy: isPrimaryActionBusy,
                            action: performPrimaryAction
                        )
                        .padding(.horizontal, -12)
                    }

                    EventSecondaryActions(
                        canOpenRoute: mapQuery != nil,
                        canAddCalendar: store.event.startsAt != nil,
                        isAddingToCalendar: isAddingToCalendar,
                        locale: locale,
                        openRoute: openRoute,
                        addToCalendar: addToCalendar
                    )

                    let serverActions = EventDetailServerActionPolicy.resolve(
                        event: store.event,
                        viewerSnapshotIsCurrent: store.hasAuthoritativeViewerSnapshot
                    )
                    if !serverActions.isEmpty {
                        EventDetailServerActionsView(
                            actions: serverActions,
                            busyAction: actionRunner.busyAction,
                            locale: locale,
                            action: performServerAction
                        )
                    }

                    NavigationLink {
                        PublicProfileView(identifier: store.event.organizerId.uuidString.lowercased())
                    } label: {
                        OrganizerTrustView(organizer: store.event.organizer, locale: locale)
                    }
                    .buttonStyle(.plain)

                    if let organizerContact {
                        if canReportOrganizer {
                            OrganizerContactCard(
                                contact: organizerContact,
                                locale: locale,
                                onReportHost: reportOrganizer
                            )
                        } else {
                            OrganizerContactCard(
                                contact: organizerContact,
                                locale: locale,
                                onReportHost: nil
                            )
                        }
                    }

                    EventTextSection(
                        title: text("journey.detail.about"),
                        content: store.event.description
                    )

                    if let requirements = store.event.attendeeRequirements?
                        .trimmingCharacters(in: .whitespacesAndNewlines),
                       !requirements.isEmpty {
                        EventTextSection(
                            title: text("journey.detail.requirements"),
                            content: requirements
                        )
                    }

                    if let questions = store.event.registrationQuestions,
                       !questions.isEmpty {
                        RegistrationQuestionPreviewView(
                            questions: questions,
                            locale: locale
                        )
                    }

                    if let fee = store.event.fee, !fee.isFree {
                        EventFeeDetailsView(fee: fee, locale: locale)
                    }

                    EventRiskDisclosureView(
                        flags: store.event.riskFlags ?? [],
                        details: store.event.riskDetails ?? [:],
                        locale: locale
                    )

                    EventSafetyNoteView(locale: locale)

                    if let feedbackSummary {
                        EventFeedbackSummaryView(
                            summary: feedbackSummary,
                            locale: locale
                        )
                    }

                    if let notice {
                        Label(notice, systemImage: "checkmark.circle.fill")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(SpottColor.mint)
                            .accessibilityIdentifier("event.detail.notice")
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 22)
                .padding(.bottom, 124)
            }
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .refreshable { await refresh() }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if actionBarLayoutPolicy.pinsActionBar {
                EventActionBar(
                    presentation: actionPresentation,
                    isBusy: isPrimaryActionBusy,
                    action: performPrimaryAction
                )
            }
        }
        .navigationTitle(store.event.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .toolbar { toolbarContent }
        .sheet(isPresented: $registrationPresented) {
            RegistrationFlowView(
                event: store.event,
                draft: registrationDraft,
                onCompletion: registrationCompleted
            )
        }
        .sheet(item: $reportTarget) { target in
            NavigationStack { SafetyReportView(target: target) }
        }
        .sheet(item: $checkInRegistration) { registration in
            NavigationStack {
                ParticipantCheckInView(event: store.event, registration: registration)
            }
        }
        .sheet(item: $shareItem) { item in
            ShareActivityView(items: [item.url], subject: item.subject)
                .presentationDetents([.medium])
        }
        .sheet(item: $posterEvent) { event in
            NavigationStack {
                PosterGeneratorView(
                    resourceType: "event",
                    resourceID: event.id,
                    title: event.title
                )
            }
        }
        .alert(
            text("journey.detail.block_host"),
            isPresented: $showBlockConfirmation
        ) {
            Button(text("journey.detail.block_host"), role: .destructive, action: blockOrganizer)
            Button(text("journey.common.cancel"), role: .cancel) { }
        } message: {
            Text(text("journey.detail.block_message"))
        }
        .alert(
            text("journey.detail.action.cancel_title"),
            isPresented: cancellationConfirmationBinding
        ) {
            Button(
                text("journey.detail.action.cancel_confirm"),
                role: .destructive,
                action: confirmCancellation
            )
            Button(text("journey.common.cancel"), role: .cancel) {
                cancellationRegistrationID = nil
            }
        } message: {
            Text(text("journey.detail.action.cancel_message"))
        }
        .task { await startIfNeeded() }
        .task(id: store.nextTemporalRefreshDate) {
            await refreshAtNextTemporalBoundary()
        }
        .task(id: model.router.pendingRegistrationPresentation?.id) {
            await resumeDeferredRegistrationIfNeeded()
        }
        .onChange(of: sessionFingerprint) { _, _ in
            actionRunner.identityDidChange()
            resetServerActionPresentation()
            store.invalidateViewerSnapshot()
            store.session = ctaSession
            Task { await refresh() }
        }
        .onChange(of: store.event.id) { _, _ in
            actionRunner.eventDidChange()
            resetServerActionPresentation()
        }
        .onChange(of: store.event.version) { _, _ in
            favorited = store.event.favorited
        }
        .onDisappear {
            actionRunner.pageDidDisappear()
            resetServerActionPresentation()
        }
    }

    private var actionPresentation: EventDetailActionPresentation {
        EventDetailActionPresentation(state: store.ctaState, locale: locale)
    }

    private var actionBarLayoutPolicy: EventActionBarLayoutPolicy {
        EventActionBarLayoutPolicy(dynamicTypeSize: dynamicTypeSize)
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            Button(action: prepareShare) {
                Image(systemName: "square.and.arrow.up")
            }
            .accessibilityLabel(text("journey.common.share"))

            Button(action: toggleFavorite) {
                Image(systemName: favorited ? "heart.fill" : "heart")
            }
            .accessibilityLabel(
                text(favorited ? "journey.detail.unfavorite" : "journey.detail.favorite")
            )

            Menu {
                if EventDetailServerActionPolicy.canGeneratePoster(
                    event: store.event,
                    viewerID: model.session?.user.id
                ) {
                    Button {
                        posterEvent = store.event
                    } label: {
                        Label(
                            text("journey.poster.menu"),
                            systemImage: "rectangle.portrait.on.rectangle.portrait"
                        )
                    }
                    Divider()
                }

                Button {
                    reportTarget = .init(
                        type: .event,
                        targetID: store.event.id,
                        displayName: store.event.title
                    )
                } label: {
                    Label(text("journey.detail.report_event"), systemImage: "exclamationmark.bubble")
                }

                if model.session?.user.id != store.event.organizerId {
                    Button {
                        reportTarget = .init(
                            type: .user,
                            targetID: store.event.organizerId,
                            displayName: store.event.organizer.name
                        )
                    } label: {
                        Label(
                            text("journey.detail.report_host"),
                            systemImage: "person.crop.circle.badge.exclamationmark"
                        )
                    }

                    Button(role: .destructive) {
                        requestBlockOrganizer()
                    } label: {
                        Label(text("journey.detail.block_host"), systemImage: "person.slash")
                    }
                }
            } label: {
                Image(systemName: "ellipsis")
            }
            .accessibilityLabel(text("journey.detail.more"))
        }
    }

    private var titleSection: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(store.event.title)
                .font(.largeTitle.bold())
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("event.detail.title")

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 6) {
                    organizerName
                    organizerHandle
                }
                VStack(alignment: .leading, spacing: 3) {
                    organizerName
                    organizerHandle
                }
            }
            .accessibilityElement(children: .combine)
        }
    }

    private var organizerName: some View {
        Text(store.event.organizer.name)
            .font(.subheadline.weight(.semibold))
            .fixedSize(horizontal: false, vertical: true)
    }

    private var organizerHandle: some View {
        Text("@\(store.event.organizer.handle)")
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var cancellationConfirmationBinding: Binding<Bool> {
        Binding(
            get: { cancellationRegistrationID != nil },
            set: { isPresented in
                if !isPresented { cancellationRegistrationID = nil }
            }
        )
    }

    private var sessionFingerprint: String {
        "\(model.session?.sessionId.uuidString ?? "guest")-"
            + "\(model.session?.user.id.uuidString ?? "anonymous")-"
            + "\(model.session?.user.phoneVerified == true)"
    }

    private var ctaSession: EventCTASession {
#if DEBUG
        if let fixture = CoreJourneyUIFixtureState.resolve(),
           [.registration, .confirmed, .pending, .waitlisted].contains(fixture) {
            return .verified
        }
#endif
        guard let session = model.session else { return .guest }
        return session.user.phoneVerified ? .verified : .unverified
    }

    private var mapQuery: String? {
        switch store.locationDisclosure(viewerID: model.session?.user.id) {
        case .exact(_, let address, _): address
        case .approximate(let publicArea): publicArea
        case .unavailable: nil
        }
    }

    private var organizerContact: OrganizerContact? {
        OrganizerContactDisclosurePolicy.contactForEventDetail(
            event: store.event,
            viewerID: model.session?.user.id,
            viewerSnapshotIsCurrent: store.hasAuthoritativeViewerSnapshot
        )
    }

    private var canReportOrganizer: Bool {
        model.session?.user.id != store.event.organizerId
    }

    private func reportOrganizer() {
        reportTarget = .init(
            type: .user,
            targetID: store.event.organizerId,
            displayName: store.event.organizer.name
        )
    }

    private func startIfNeeded() async {
        guard !didStart else { return }
        didStart = true
        model.trackAnalytics(
            .eventDetailViewed(
                eventID: store.event.id,
                publicSlug: store.event.publicSlug,
                category: store.event.category
            )
        )
        if refreshOnAppear {
            await refresh()
        }
        if !model.usesNavigationUITestFixture {
            feedbackSummary = try? await model.api.feedbackSummary(eventID: store.event.id)
        }
        presentCoreJourneyFixtureIfNeeded()
    }

    private func presentCoreJourneyFixtureIfNeeded() {
#if DEBUG
        guard let fixture = CoreJourneyUIFixtureState.resolve(),
              [.registration, .confirmed, .pending, .waitlisted].contains(fixture) else {
            return
        }
        registrationPresented = true
#endif
    }

    private func refresh() async {
        await store.refresh()
        favorited = store.event.favorited
    }

    private func performPrimaryAction() {
        let state = store.ctaState
        guard !state.disabled else { return }
        switch state.intent {
        case .none:
            return
        case .itinerary:
            model.router.showItinerary(
                registrationID: state.registrationId.flatMap(UUID.init(uuidString:))
            )
        case .acceptWaitlist:
            model.router.showItinerary(
                registrationID: state.registrationId.flatMap(UUID.init(uuidString:))
            )
        case .login, .phoneVerification, .register:
            let action: EventAction = state.kind == .joinWaitlist ? .joinWaitlist : .register
            model.requireTrust(
                for: action,
                event: store.event,
                draft: registrationDraft
            ) {
                registrationPresented = true
            }
        }
    }

    private func registrationCompleted(_ registration: Registration) {
        model.trackAnalytics(
            .registrationCompleted(
                eventID: store.event.id,
                status: registration.status,
                partySize: registration.partySize
            )
        )
        Task { await refresh() }
    }

    private func resumeDeferredRegistrationIfNeeded() async {
        let reference = EventRouteReference(event: store.event)
        guard let pending = model.router.pendingRegistrationPresentation,
              pending.event == reference,
              pending.sourceTab == sourceTab else { return }

        await refresh()
        guard store.error == nil else {
            model.banner = .init(
                title: text("journey.registration.resume_refresh_failed"),
                tone: .warning
            )
            return
        }

        guard let intent = model.router.takeRegistrationPresentation(
            for: reference,
            in: sourceTab
        ) else { return }
        guard store.ctaState.intent == .register else {
            notice = text("journey.registration.no_longer_available")
            return
        }
        registrationDraft = intent.draft
        registrationPresented = true
    }

    private func prepareShare() {
        let event = store.event
        Task { @MainActor in
            let url = await EventShareDestinationPolicy.resolve(
                event: event,
                authenticated: model.session != nil
            ) {
                let receipt = try await model.api.createShareLink(
                    resourceType: "event",
                    resourceID: event.id,
                    campaign: "ios_event_detail"
                )
                return receipt.url
            }
            shareItem = .init(url: url, subject: event.title)
        }
    }

    private func performServerAction(_ action: EventDetailServerAction) {
        guard actionRunner.busyAction == nil,
              isCurrentlyAuthorized(action) else { return }
        if action.requiresTrustGate {
            model.requireTrust(for: action.eventAction, event: store.event) {
                executeServerAction(action)
            }
        } else {
            executeServerAction(action)
        }
    }

    private func executeServerAction(_ action: EventDetailServerAction) {
        guard isCurrentlyAuthorized(action) else { return }
        switch action {
        case .checkIn(let registrationID):
            openCheckIn(registrationID: registrationID)
        case .openGroup(let groupID):
            EventDetailLinkedGroupNavigation.open(
                groupID: groupID,
                sourceTab: sourceTab,
                router: model.router
            )
        case .cancelRegistration(let registrationID):
            cancellationRegistrationID = registrationID
        }
    }

    private func openCheckIn(registrationID: UUID) {
        actionRunner.startCheckIn(
            registrationID: registrationID,
            locale: locale,
            snapshot: actionSnapshot,
            load: { registrationID, eventID in
                try await EventDetailRegistrationLookup.find(
                    registrationID: registrationID,
                    eventID: eventID,
                    loadPage: { cursor, limit in
                        let page = try await model.api.registrationItinerary(
                            cursor: cursor,
                            limit: limit
                        )
                        return CursorPage(
                            items: page.items.map(\.registration),
                            nextCursor: page.nextCursor,
                            hasMore: page.hasMore
                        )
                    }
                )
            },
            emit: handleActionEffect
        )
    }

    private func confirmCancellation() {
        guard let registrationID = cancellationRegistrationID else { return }
        cancellationRegistrationID = nil
        actionRunner.startCancellation(
            registrationID: registrationID,
            locale: locale,
            snapshot: actionSnapshot,
            mutate: {
                _ = try await model.api.cancelRegistration(
                    registrationID: registrationID
                )
            },
            refresh: {
                await refresh()
                return EventCancellationSyncPolicy.outcome(
                    viewerSnapshotIsCurrent: store.hasAuthoritativeViewerSnapshot,
                    refreshError: store.error
                )
            },
            emit: handleActionEffect
        )
    }

    private func isCurrentlyAuthorized(_ action: EventDetailServerAction) -> Bool {
        EventDetailActionAuthorizer.isAuthorized(
            action,
            event: store.event,
            viewerSnapshotIsCurrent: store.hasAuthoritativeViewerSnapshot
        )
    }

    private func actionSnapshot() -> EventDetailActionRunner.Snapshot {
        .init(
            sessionFingerprint: sessionFingerprint,
            event: store.event,
            viewerSnapshotIsCurrent: store.hasAuthoritativeViewerSnapshot
        )
    }

    private func handleActionEffect(_ effect: EventDetailActionRunner.Effect) {
        switch effect {
        case .presentCheckIn(let registration):
            checkInRegistration = registration
        case .banner(let error):
            model.banner = .init(title: error.message, tone: .warning)
        case .cancellationFinished(.synced):
            notice = text("journey.detail.action.cancelled")
        case .cancellationFinished(.refreshFailed):
            notice = nil
            model.banner = .init(
                title: text("journey.detail.action.cancelled_sync_failed"),
                tone: .warning
            )
        }
    }

    private func resetServerActionPresentation() {
        checkInRegistration = nil
        cancellationRegistrationID = nil
    }

    private func toggleFavorite() {
        guard model.session != nil else {
            model.presentedGate = .login
            return
        }
        let target = !favorited
        favorited = target
        Task { @MainActor in
            do {
                try await model.api.setFavorite(eventID: store.event.id, enabled: target)
            } catch {
                favorited.toggle()
                model.banner = .init(title: text("journey.error.action"), tone: .warning)
            }
        }
    }

    private func requestBlockOrganizer() {
        guard model.session != nil else {
            model.presentedGate = .login
            return
        }
        showBlockConfirmation = true
    }

    private func blockOrganizer() {
        Task { @MainActor in
            do {
                _ = try await model.api.setUserBlocked(
                    store.event.organizerId,
                    blocked: true,
                    reason: "event_safety"
                )
                notice = text("journey.detail.blocked")
            } catch {
                model.banner = .init(title: text("journey.error.action"), tone: .warning)
            }
        }
    }

    private func openRoute() {
        guard let mapQuery,
              let encoded = mapQuery.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "http://maps.apple.com/?q=\(encoded)") else { return }
        openURL(url)
    }

    private func addToCalendar() {
        guard let start = store.event.startsAt, !isAddingToCalendar else { return }
        let event = store.event
        isAddingToCalendar = true
        notice = nil
        Task { @MainActor in
            defer { isAddingToCalendar = false }
            let end = event.endsAt ?? start.addingTimeInterval(7_200)
            do {
                try await CalendarIntegration().add(
                    title: event.title,
                    start: start,
                    end: end,
                    notes: "Spott · \(mapQuery ?? "")\nhttps://spott.jp/e/\(event.publicSlug)"
                )
                notice = text("journey.detail.calendar_added")
                UIAccessibility.post(
                    notification: .announcement,
                    argument: text("journey.detail.calendar_added")
                )
            } catch {
                let message = (error as? CalendarIntegrationError)?.localizedMessage(locale: locale)
                    ?? text("journey.calendar.write_failed")
                model.banner = .init(title: message, tone: .warning)
                UIAccessibility.post(notification: .announcement, argument: message)
            }
        }
    }

    private func text(_ key: String.LocalizationValue) -> String {
        CoreJourneyLocalization.text(key, locale: locale)
    }

    private func refreshAtNextTemporalBoundary() async {
        guard let delay = store.temporalRefreshDelay() else { return }
        do {
            try await Task.sleep(for: .seconds(max(0.01, delay)))
            try Task.checkCancellation()
            store.refreshTemporalState()
            Task { await refresh() }
        } catch {
            return
        }
    }
}

private struct EventDetailHeroView: View {
    let event: EventSummary
    let locale: Locale

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            Group {
                if let coverURL = event.coverURL {
                    AsyncImage(url: coverURL) { phase in
                        switch phase {
                        case .success(let image):
                            image.resizable().scaledToFill()
                        default:
                            fallback
                        }
                    }
                } else {
                    fallback
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 246)
            .clipped()
            .accessibilityHidden(true)

            LinearGradient(
                colors: [.clear, .black.opacity(0.56)],
                startPoint: .center,
                endPoint: .bottom
            )

            if let startsAt = event.startsAt {
                VStack(alignment: .leading, spacing: 1) {
                    Text(
                        CoreJourneyLocalization.datePart(
                            startsAt,
                            template: "MMM",
                            timeZoneIdentifier: event.displayTimeZone,
                            locale: locale
                        )
                    )
                        .font(.caption.monospaced().weight(.bold))
                        .textCase(.uppercase)
                    Text(
                        CoreJourneyLocalization.datePart(
                            startsAt,
                            template: "d",
                            timeZoneIdentifier: event.displayTimeZone,
                            locale: locale
                        )
                    )
                        .font(.system(.largeTitle, design: .rounded, weight: .bold))
                }
                .foregroundStyle(.white)
                .padding(20)
                .accessibilityHidden(true)
            }
        }
        .frame(height: 246)
    }

    private var fallback: some View {
        ZStack {
            Color(uiColor: .secondarySystemGroupedBackground)
            LinearGradient(
                colors: [SpottColor.twilight.opacity(0.82), SpottColor.mint.opacity(0.72)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            Image(systemName: event.format == .online ? "video.fill" : "person.3.fill")
                .font(.system(size: 52, weight: .medium))
                .foregroundStyle(.white.opacity(0.86))
        }
    }
}

private struct EventTextSection: View {
    let title: String
    let content: String

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(title)
                .font(.title3.bold())
                .accessibilityAddTraits(.isHeader)
            Text(content)
                .font(.body)
                .foregroundStyle(.secondary)
                .lineSpacing(4)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }
}

private struct EventSecondaryActions: View {
    let canOpenRoute: Bool
    let canAddCalendar: Bool
    let isAddingToCalendar: Bool
    let locale: Locale
    let openRoute: () -> Void
    let addToCalendar: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Button(action: openRoute) {
                Label(text("journey.detail.route"), systemImage: "map")
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .disabled(!canOpenRoute)

            Button(action: addToCalendar) {
                HStack(spacing: 8) {
                    if isAddingToCalendar {
                        ProgressView()
                    } else {
                        Image(systemName: "calendar.badge.plus")
                    }
                    Text(text("journey.common.add_calendar"))
                }
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .disabled(!canAddCalendar || isAddingToCalendar)
            .accessibilityIdentifier("event.detail.add_calendar")
        }
        .buttonStyle(.bordered)
        .buttonBorderShape(.capsule)
    }

    private func text(_ key: String.LocalizationValue) -> String {
        CoreJourneyLocalization.text(key, locale: locale)
    }
}

private struct EventDetailServerActionsView: View {
    let actions: [EventDetailServerAction]
    let busyAction: EventDetailServerAction?
    let locale: Locale
    let action: (EventDetailServerAction) -> Void

    private let columns = [
        GridItem(.adaptive(minimum: 145), spacing: 10, alignment: .leading),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            Text(text("journey.detail.action.section"))
                .font(.title3.bold())
                .accessibilityAddTraits(.isHeader)

            if #available(iOS 26.0, *) {
                GlassEffectContainer(spacing: 10) {
                    actionGrid
                }
            } else {
                actionGrid
            }
        }
        .accessibilityIdentifier("event.detail.server_actions")
    }

    private var actionGrid: some View {
        LazyVGrid(columns: columns, alignment: .leading, spacing: 10) {
            ForEach(actions) { serverAction in
                actionButton(serverAction)
            }
        }
    }

    @ViewBuilder
    private func actionButton(_ serverAction: EventDetailServerAction) -> some View {
        let presentation = EventDetailServerActionPresentation(
            action: serverAction,
            locale: locale
        )
        let button = Button(
            role: presentation.isDestructive ? .destructive : nil,
            action: { action(serverAction) }
        ) {
            HStack(spacing: 8) {
                if busyAction == serverAction {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: presentation.systemImage)
                }
                Text(presentation.title)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        }
        .buttonBorderShape(.roundedRectangle(radius: 15))
        .disabled(busyAction != nil)
        .accessibilityIdentifier(accessibilityIdentifier(for: serverAction))

        if #available(iOS 26.0, *) {
            button.buttonStyle(.glass)
        } else {
            button.buttonStyle(.bordered)
        }
    }

    private func accessibilityIdentifier(
        for action: EventDetailServerAction
    ) -> String {
        switch action {
        case .checkIn: "event.detail.action.check_in"
        case .openGroup: "event.detail.action.open_group"
        case .cancelRegistration: "event.detail.action.cancel_registration"
        }
    }

    private func text(_ key: String.LocalizationValue) -> String {
        CoreJourneyLocalization.text(key, locale: locale)
    }
}

private struct EventFeeDetailsView: View {
    let fee: EventFee
    let locale: Locale

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(text("journey.detail.payment_details"), systemImage: "yensign.circle")
                .font(.title3.bold())
                .accessibilityAddTraits(.isHeader)

            if let collector = nonempty(fee.collectorName) {
                LabeledContent(text("journey.detail.payment_collector"), value: collector)
            }
            if let method = nonempty(fee.method) {
                LabeledContent(text("journey.detail.payment_method"), value: method)
            }
            if let deadline = nonempty(fee.paymentDeadlineText) {
                LabeledContent(text("journey.detail.payment_deadline"), value: deadline)
            }
            if let refundPolicy = nonempty(fee.refundPolicy) {
                Divider()
                VStack(alignment: .leading, spacing: 4) {
                    Text(text("journey.detail.refund_policy"))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(refundPolicy)
                        .font(.subheadline)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(16)
        .background(
            Color(uiColor: .secondarySystemGroupedBackground),
            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
    }

    private func nonempty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else { return nil }
        return value
    }

    private func text(_ key: String.LocalizationValue) -> String {
        CoreJourneyLocalization.text(key, locale: locale)
    }
}

struct OrganizerTrustPresentation: Equatable, Sendable {
    let sectionTitle: String
    let name: String
    let handle: String
    let initial: String
    let signals: [String]

    init(organizer: EventOrganizer, locale: Locale) {
        sectionTitle = CoreJourneyLocalization.text(
            "journey.detail.organizer",
            locale: locale
        )
        name = organizer.name
        handle = "@\(organizer.handle)"
        initial = String(organizer.name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1))

        var values: [String] = []
        if organizer.trust.phoneVerified {
            values.append(
                CoreJourneyLocalization.text(
                    "journey.detail.verified_host",
                    locale: locale
                )
            )
        }
        if organizer.trust.completedEventCount > 0 {
            values.append(
                CoreJourneyLocalization.format(
                    "journey.detail.completed_events",
                    locale: locale,
                    organizer.trust.completedEventCount
                )
            )
        }
        let attendanceKey: String.LocalizationValue = switch organizer.trust.attendanceRateBand {
        case .unavailable: "journey.detail.attendance_unavailable"
        case .under70: "journey.detail.attendance_under70"
        case .from70To89: "journey.detail.attendance_70_89"
        case .over90: "journey.detail.attendance_90_plus"
        }
        values.append(CoreJourneyLocalization.text(attendanceKey, locale: locale))
        signals = values
    }
}

private struct OrganizerTrustView: View {
    let organizer: EventOrganizer
    let locale: Locale

    private var presentation: OrganizerTrustPresentation {
        .init(organizer: organizer, locale: locale)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(presentation.sectionTitle)
                .font(.title3.bold())
                .accessibilityAddTraits(.isHeader)

            content
                .background(
                    Color(uiColor: .secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 20, style: .continuous)
                )
                .overlay {
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .stroke(Color.primary.opacity(0.08), lineWidth: 0.5)
                }
        }
    }

    private var content: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 14) {
                avatar
                organizerSummary
                Spacer(minLength: 4)
                disclosureIndicator
            }
            VStack(alignment: .leading, spacing: 12) {
                avatar
                organizerSummary
                disclosureIndicator
            }
        }
        .padding(16)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("event.detail.organizer")
    }

    private var avatar: some View {
        ZStack {
            Circle()
                .fill(
                    LinearGradient(
                        colors: [SpottColor.twilight, SpottColor.mint],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
            Text(presentation.initial.isEmpty ? "S" : presentation.initial)
                .font(.title3.bold())
                .foregroundStyle(.white)
        }
        .frame(width: 52, height: 52)
        .accessibilityHidden(true)
    }

    private var organizerSummary: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(presentation.name)
                .font(.headline)
                .lineLimit(2)
            Text(presentation.handle)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text(presentation.signals.joined(separator: " · "))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var disclosureIndicator: some View {
        Image(systemName: "chevron.right")
            .font(.caption.bold())
            .foregroundStyle(.tertiary)
            .accessibilityHidden(true)
    }
}

private struct EventRiskDisclosureView: View {
    let flags: [String]
    let details: [String: String]
    let locale: Locale

    var body: some View {
        if !flags.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Label(text("journey.detail.risk_title"), systemImage: "exclamationmark.shield.fill")
                    .font(.title3.bold())
                    .foregroundStyle(SpottColor.amber)
                    .accessibilityAddTraits(.isHeader)

                VStack(alignment: .leading, spacing: 12) {
                    ForEach(Array(flags.enumerated()), id: \.offset) { _, flag in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(title(for: flag))
                                .font(.subheadline.weight(.semibold))
                            if let detail = nonempty(details[flag]) {
                                Text(detail)
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
                .padding(16)
                .background(
                    SpottColor.amber.opacity(0.09),
                    in: RoundedRectangle(cornerRadius: 18, style: .continuous)
                )
                .overlay {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .stroke(SpottColor.amber.opacity(0.22), lineWidth: 0.5)
                }
            }
            .accessibilityIdentifier("event.detail.risk_disclosure")
        }
    }

    private func title(for flag: String) -> String {
        let key: String.LocalizationValue = switch flag {
        case "alcohol": "journey.detail.risk.alcohol"
        case "late_night": "journey.detail.risk.late_night"
        case "family", "minors": "journey.detail.risk.family"
        case "outdoor": "journey.detail.risk.outdoor"
        case "mountain": "journey.detail.risk.mountain"
        case "water": "journey.detail.risk.water"
        case "high_fee": "journey.detail.risk.high_fee"
        case "career", "investment": "journey.detail.risk.financial"
        case "gender_limited": "journey.detail.risk.gender_limited"
        default: "journey.detail.risk.other"
        }
        return text(key)
    }

    private func nonempty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else { return nil }
        return value
    }

    private func text(_ key: String.LocalizationValue) -> String {
        CoreJourneyLocalization.text(key, locale: locale)
    }
}

private struct EventSafetyNoteView: View {
    let locale: Locale

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(text("journey.detail.safety_title"), systemImage: "checkmark.shield.fill")
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
            Text(text("journey.detail.safety_body"))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .background(
            Color(uiColor: .secondarySystemGroupedBackground),
            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
        .accessibilityIdentifier("event.detail.safety_note")
    }

    private func text(_ key: String.LocalizationValue) -> String {
        CoreJourneyLocalization.text(key, locale: locale)
    }
}

private struct RegistrationQuestionPreviewView: View {
    let questions: [RegistrationQuestion]
    let locale: Locale

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text(text("journey.detail.questions_title"))
                    .font(.title3.bold())
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                Text(
                    CoreJourneyLocalization.format(
                        "journey.detail.questions_count",
                        locale: locale,
                        questions.count
                    )
                )
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 10) {
                ForEach(questions.prefix(3)) { question in
                    HStack(alignment: .top, spacing: 9) {
                        Image(systemName: "text.bubble")
                            .foregroundStyle(SpottColor.twilight)
                            .accessibilityHidden(true)
                        Text(question.prompt)
                            .font(.subheadline)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 4)
                        Text(
                            text(
                                question.required
                                    ? "journey.registration.required"
                                    : "journey.registration.optional"
                            )
                        )
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.secondary)
                    }
                }
            }
            .padding(16)
            .background(
                Color(uiColor: .secondarySystemGroupedBackground),
                in: RoundedRectangle(cornerRadius: 18, style: .continuous)
            )
        }
        .accessibilityIdentifier("event.detail.registration_questions")
    }

    private func text(_ key: String.LocalizationValue) -> String {
        CoreJourneyLocalization.text(key, locale: locale)
    }
}

private struct EventFeedbackSummaryView: View {
    let summary: FeedbackSummary
    let locale: Locale

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Label(text("journey.detail.feedback_title"), systemImage: "sparkles")
                    .font(.title3.bold())
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                Text(
                    CoreJourneyLocalization.format(
                        "journey.detail.feedback_count",
                        locale: locale,
                        summary.sampleSize
                    )
                )
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            }

            if summary.published {
                ForEach(summary.tags.prefix(4)) { item in
                    HStack {
                        Text(tagTitle(item.tag))
                            .font(.subheadline.weight(.semibold))
                        Spacer()
                        Text(item.rate, format: .percent.precision(.fractionLength(0)))
                            .font(.subheadline.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                }
                Text(text("journey.detail.feedback_privacy"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Text(
                    CoreJourneyLocalization.format(
                        "journey.detail.feedback_threshold",
                        locale: locale,
                        summary.sampleSize,
                        summary.minimumSampleSize
                    )
                )
                .font(.subheadline)
                .foregroundStyle(.secondary)
            }
        }
        .padding(16)
        .background(
            Color(uiColor: .secondarySystemGroupedBackground),
            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
        .accessibilityIdentifier("event.detail.feedback_summary")
    }

    private func tagTitle(_ tag: FeedbackTag) -> String {
        let key: String.LocalizationValue = switch tag {
        case .friendly: "journey.feedback.tag.friendly"
        case .wellOrganized: "journey.feedback.tag.well_organized"
        case .clearInformation: "journey.feedback.tag.clear_information"
        case .safe: "journey.feedback.tag.safe"
        case .wouldJoinAgain: "journey.feedback.tag.join_again"
        }
        return text(key)
    }

    private func text(_ key: String.LocalizationValue) -> String {
        CoreJourneyLocalization.text(key, locale: locale)
    }
}
