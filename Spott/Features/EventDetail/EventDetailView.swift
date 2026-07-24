import SwiftUI
import UIKit

struct EventDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale

    private let event: EventSummary
    private let sourceTab: AppTab
    private let refreshOnAppear: Bool

    init(event: EventSummary, sourceTab: AppTab, refreshOnAppear: Bool = true) {
        self.event = event
        self.sourceTab = sourceTab
        self.refreshOnAppear = refreshOnAppear
    }

    var body: some View {
        EventDetailNativeScreen(
            initialEvent: event,
            service: model.api,
            commentService: model.api,
            session: ctaSession,
            locale: locale,
            sourceTab: sourceTab,
            refreshOnAppear: refreshOnAppear,
            initiallyPromoted: model.router.isKnownPromoted(event.id)
        )
        .id("\(model.session?.sessionId.uuidString ?? "guest")-\(locale.identifier)-\(event.id)")
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
private struct EventDetailNativeScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL

    @State private var store: EventDetailStore
    @State private var commentsStore: EventCommentsStore
    @State private var registrationPresented = false
    @State private var registrationDraft = DeferredRegistrationDraft()
    /// Optimistic favorite override (mirrors DiscoveryFavoriteLedger): while a
    /// mutation is pending or unreconciled, this wins over the store snapshot so
    /// a concurrent refresh whose GET predates the PUT cannot revert the heart.
    @State private var favoriteOverride: Bool?
    @State private var favoriteInFlight = false
    @State private var isPrimaryActionBusy = false
    @State private var isAddingToCalendar = false
    @State private var didStart = false
    @State private var notice: String?
    @State private var reportTarget: SafetyReportTarget?
    @State private var showBlockConfirmation = false
    @State private var feedbackSummary: FeedbackSummary?
    @State private var goingPreview: GoingPreview?
    @State private var activePromotion: EventPromotion?
    @State private var isPromoted: Bool
    @State private var shareItem: EventShareItem?
    @State private var isPreparingShare = false
    @State private var posterPresented = false
    @State private var commentsComposerFocused = false

    private let sourceTab: AppTab
    private let refreshOnAppear: Bool
    private let locale: Locale

    init(
        initialEvent: EventSummary,
        service: any EventDetailServing,
        commentService: any EventCommentServing,
        session: EventCTASession,
        locale: Locale,
        sourceTab: AppTab,
        refreshOnAppear: Bool,
        initiallyPromoted: Bool = false
    ) {
        _store = State(
            initialValue: EventDetailStore(
                initialEvent: initialEvent,
                service: service,
                session: session,
                locale: locale
            )
        )
        _commentsStore = State(
            initialValue: EventCommentsStore(
                eventID: initialEvent.id,
                service: commentService,
                locale: locale
            )
        )
        // 推广透明: the badge is seeded from the originating feed item's boosted
        // flag; the eventPromotion fetch refreshes it rather than being the sole
        // source, so a slow/failed fetch cannot silently hide a promoted badge.
        _isPromoted = State(initialValue: initiallyPromoted)
        self.sourceTab = sourceTab
        self.refreshOnAppear = refreshOnAppear
        self.locale = locale
    }

    private var favorited: Bool {
        favoriteOverride ?? store.event.favorited
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                EventDetailHeroView(
                    event: store.event,
                    isPromoted: isPromoted,
                    locale: locale
                )

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
                            disclosure: store.locationDisclosure,
                            locale: locale
                        )
                    )

                    if let coordinate = store.event.coordinate, mapQuery != nil {
                        EventLocationMapCard(
                            coordinate: coordinate,
                            isExact: hasExactDisclosedCoordinate,
                            locale: locale,
                            openRoute: openRoute
                        )
                    }

                    EventSecondaryActions(
                        canOpenRoute: mapQuery != nil,
                        canAddCalendar: store.event.startsAt != nil,
                        isAddingToCalendar: isAddingToCalendar,
                        locale: locale,
                        openRoute: openRoute,
                        addToCalendar: addToCalendar
                    )

                    NavigationLink {
                        PublicProfileView(identifier: store.event.organizerId.uuidString.lowercased())
                    } label: {
                        OrganizerTrustView(organizer: store.event.organizer, locale: locale)
                    }
                    .buttonStyle(.plain)

                    if let goingPreview,
                       goingPreview.confirmedCount > 0,
                       !goingPreview.previews.isEmpty {
                        EventGoingPreviewView(preview: goingPreview, locale: locale)
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

                    EventCommentsSection(
                        store: commentsStore,
                        event: store.event,
                        viewerUser: model.session?.user,
                        locale: locale,
                        requestSignIn: requestCommentSignIn,
                        onComposerFocusChange: { commentsComposerFocused = $0 }
                    )

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
        .refreshable {
            await refresh()
            if !model.usesNavigationUITestFixture {
                await commentsStore.load()
            }
            // A failed gate-resume leaves the pending intent parked (its task id
            // never changes), so pull-to-refresh doubles as the retry path.
            await resumeDeferredRegistrationIfNeeded()
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            // While the comments composer has keyboard focus the CTA bar steps
            // aside instead of riding up and crowding the field being typed in.
            if !commentsComposerFocused {
                EventActionBar(
                    presentation: .init(state: store.ctaState, locale: locale),
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
                onCompletion: registrationCompleted,
                onDismissDraft: { registrationDraft = $0 }
            )
        }
        .sheet(item: $reportTarget) { target in
            NavigationStack { SafetyReportView(target: target) }
        }
        .sheet(item: $shareItem) { item in
            ShareActivityView(items: [item.url])
                .presentationDetents([.medium])
        }
        .sheet(isPresented: $posterPresented) {
            NavigationStack {
                PosterGeneratorView(
                    resourceType: "event",
                    resourceID: store.event.id,
                    title: store.event.title
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
        .task { await startIfNeeded() }
        .task(id: store.nextTemporalRefreshDate) {
            await refreshAtNextTemporalBoundary()
        }
        .task(id: model.router.pendingRegistrationPresentation?.id) {
            await resumeDeferredRegistrationIfNeeded()
        }
        .onChange(of: sessionFingerprint) { _, _ in
            store.session = ctaSession
            Task { await refresh() }
            if !model.usesNavigationUITestFixture {
                Task { await commentsStore.load() }
            }
        }
        .onChange(of: store.event.favorited) { _, serverValue in
            // Reconcile: once the server agrees with the optimistic override and
            // no mutation is pending, drop the override.
            if !favoriteInFlight, favoriteOverride == serverValue {
                favoriteOverride = nil
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            Button(action: shareEvent) {
                if isPreparingShare {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "square.and.arrow.up")
                }
            }
            .disabled(isPreparingShare)
            .tint(SpottColor.ink)
            .accessibilityLabel(text("journey.common.share"))

            Button(action: toggleFavorite) {
                Image(systemName: favorited ? "heart.fill" : "heart")
            }
            .tint(favorited ? SpottColor.coral : SpottColor.ink)
            .accessibilityLabel(
                text(favorited ? "journey.detail.unfavorite" : "journey.detail.favorite")
            )

            Menu {
                if model.session?.user.id == store.event.organizerId,
                   store.event.posterEnabled == true {
                    Button {
                        posterPresented = true
                    } label: {
                        Label(
                            EventDetailExtrasLocalization.text(
                                "eventdetail.poster.menu",
                                locale: locale
                            ),
                            systemImage: "photo.artframe"
                        )
                    }
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
            .tint(SpottColor.ink)
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

    private var shareURL: URL {
        URL(string: "https://spott.jp/e/\(store.event.publicSlug)")
            ?? URL(string: "https://spott.jp")!
    }

    private var sessionFingerprint: String {
        "\(model.session?.sessionId.uuidString ?? "guest")-\(model.session?.user.phoneVerified == true)"
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
        switch store.locationDisclosure {
        case .exact(_, let address, _): address
        case .approximate(let publicArea): publicArea
        case .unavailable: nil
        }
    }

    private var hasExactDisclosedCoordinate: Bool {
        if case .exact(_, _, let coordinate) = store.locationDisclosure {
            return coordinate != nil
        }
        return false
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
            goingPreview = try? await model.api.goingPreview(eventID: store.event.id)
            feedbackSummary = try? await model.api.feedbackSummary(eventID: store.event.id)
            do {
                let promotion = try await model.api.eventPromotion(eventID: store.event.id)
                activePromotion = promotion
                isPromoted = promotion != nil
            } catch {
                // Fetch failed: keep the seeded feed-item value instead of
                // silently hiding a badge the discovery card already showed.
            }
            await commentsStore.load()
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
        // The heart reads `favorited` (override ?? store snapshot); no direct
        // assignment here, so a stale refresh cannot clobber a pending toggle.
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

    private func shareEvent() {
        guard !isPreparingShare else { return }
        isPreparingShare = true
        Task { @MainActor in
            defer { isPreparingShare = false }
            var url = shareURL
            if model.session != nil,
               let receipt = try? await model.api.createShareLink(
                   resourceType: "event",
                   resourceID: store.event.id,
                   campaign: nil,
                   channel: "other",
                   purpose: "share"
               ) {
                url = receipt.url
            }
            shareItem = EventShareItem(url: url)
        }
    }

    private func requestCommentSignIn() {
        model.requireTrust(for: .submit) { }
    }

    private func toggleFavorite() {
        guard model.session != nil else {
            // Record the favorite intent so the gate shows event context and the
            // heart is applied right after a successful login.
            model.deferFavorite(event: store.event, desired: !favorited)
            return
        }
        // Serialize: ignore taps while a mutation is pending so two rapid
        // toggles cannot interleave their PUTs and end on a stale value.
        guard !favoriteInFlight else { return }
        let target = !favorited
        favoriteOverride = target
        favoriteInFlight = true
        Task { @MainActor in
            defer { favoriteInFlight = false }
            do {
                try await model.api.setFavorite(eventID: store.event.id, enabled: target)
                if store.event.favorited == target {
                    favoriteOverride = nil
                }
            } catch {
                favoriteOverride = store.event.favorited == !target ? nil : !target
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
              let url = URL(string: "https://maps.apple.com/?q=\(encoded)") else { return }
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
    let isPromoted: Bool
    let locale: Locale

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            EventCoverView(url: event.coverURL, category: event.category, cornerRadius: 0)
                .frame(maxWidth: .infinity)
                .frame(height: 246)

            LinearGradient(
                colors: [.clear, .black.opacity(0.56)],
                startPoint: .center,
                endPoint: .bottom
            )
            .accessibilityHidden(true)

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
        .overlay(alignment: .topTrailing) {
            if isPromoted {
                PromotedBadge()
                    .padding(12)
                    .accessibilityIdentifier("event.detail.promoted_badge")
            }
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
        .buttonStyle(.glass)
        .buttonBorderShape(.capsule)
        // Restraint: route + add-to-calendar are secondary utilities, not the
        // screen's accent. Neutral glass keeps purple exclusive to the single
        // primary CTA (预留名额).
        .tint(SpottColor.ink)
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

    private var avatarSeedColor: Color {
        let palette = [
            SpottColor.twilight,
            SpottColor.coral,
            SpottColor.mint,
            SpottColor.amber,
            SpottColor.twilightDeep
        ]
        let seed = presentation.name.unicodeScalars
            .reduce(7) { ($0 &* 31 &+ Int($1.value)) & 0xFFFF }
        return palette[seed % palette.count]
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
            // Restraint: a single seeded brand hue, not a twilight→mint rainbow.
            // Matches the kit's AvatarInitialCircle so identity chips read as one
            // system across the app.
            Circle()
                .fill(avatarSeedColor.gradient)
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

/// "Who's coming" social-proof wall (Luma signature). Renders the confirmed head
/// count with a row of overlapping, real attendee avatars. Each avatar deep-links
/// to that attendee's public profile. Only reached when the organizer exposes the
/// guest list and at least one attendee has confirmed — the parent gates on that.
private struct EventGoingPreviewView: View {
    let preview: GoingPreview
    let locale: Locale

    private static let displayCap = 6
    private let avatarDiameter: CGFloat = 40
    private let avatarOverlap: CGFloat = 13

    private var visible: [GoingPreview.Attendee] {
        Array(preview.previews.prefix(Self.displayCap))
    }

    private var overflow: Int {
        max(0, preview.confirmedCount - visible.count)
    }

    private func text(_ key: String.LocalizationValue) -> String {
        EventDetailExtrasLocalization.text(key, locale: locale)
    }

    private var countLabel: String {
        EventDetailExtrasLocalization.format(
            "eventdetail.going.count",
            locale: locale,
            preview.confirmedCount
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(text("eventdetail.going.title"))
                .font(.title3.bold())
                .accessibilityAddTraits(.isHeader)

            HStack(spacing: 12) {
                avatarWall
                Text(countLabel)
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
            .padding(16)
            .background(
                Color(uiColor: .secondarySystemGroupedBackground),
                in: RoundedRectangle(cornerRadius: 20, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(Color.primary.opacity(0.08), lineWidth: 0.5)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("event.detail.going")
    }

    private var avatarWall: some View {
        HStack(spacing: -avatarOverlap) {
            ForEach(visible) { attendee in
                NavigationLink {
                    PublicProfileView(identifier: attendee.userId.uuidString.lowercased())
                } label: {
                    EventAttendeeAvatar(attendee: attendee, diameter: avatarDiameter)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(attendee.displayName)
            }

            if overflow > 0 {
                overflowChip
            }
        }
    }

    private var overflowChip: some View {
        ZStack {
            Circle().fill(SpottColor.muted.opacity(0.18))
            Text(verbatim: "+\(overflow)")
                .font(.caption.weight(.bold))
                .monospacedDigit()
                .foregroundStyle(.secondary)
        }
        .frame(width: avatarDiameter, height: avatarDiameter)
        .overlay(Circle().stroke(Color(uiColor: .secondarySystemGroupedBackground), lineWidth: 2))
        .accessibilityHidden(true)
    }
}

/// A single attendee identity chip: the real profile photo when the attendee has
/// one, otherwise a seeded monogram derived from their public display name. No
/// stock or fabricated faces — an attendee without a photo shows their initial.
private struct EventAttendeeAvatar: View {
    let attendee: GoingPreview.Attendee
    let diameter: CGFloat

    private var initial: String {
        let trimmed = attendee.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        let stripped = trimmed.hasPrefix("@") ? String(trimmed.dropFirst()) : trimmed
        return String(stripped.prefix(1)).uppercased()
    }

    private var seedColor: Color {
        let palette = [
            SpottColor.twilight,
            SpottColor.coral,
            SpottColor.mint,
            SpottColor.amber,
            SpottColor.twilightDeep
        ]
        let seed = attendee.userId.uuidString.unicodeScalars
            .reduce(7) { ($0 &* 31 &+ Int($1.value)) & 0xFFFF }
        return palette[seed % palette.count]
    }

    var body: some View {
        ZStack {
            if let url = attendee.avatarURL {
                AsyncImage(url: url) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    monogram
                }
            } else {
                monogram
            }
        }
        .frame(width: diameter, height: diameter)
        .clipShape(Circle())
        .overlay(Circle().stroke(Color(uiColor: .secondarySystemGroupedBackground), lineWidth: 2))
    }

    private var monogram: some View {
        ZStack {
            Circle().fill(seedColor.gradient)
            Text(initial.isEmpty ? "S" : initial)
                .font(.subheadline.bold())
                .foregroundStyle(.white)
        }
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
        HStack(alignment: .top, spacing: 13) {
            Image(systemName: "checkmark.shield.fill")
                .font(.title3)
                .foregroundStyle(SpottColor.mint)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
                Text(text("journey.detail.safety_title"))
                    .font(.headline)
                    .accessibilityAddTraits(.isHeader)
                Text(text("journey.detail.safety_body"))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(
            SpottColor.mint.opacity(0.09),
            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(SpottColor.mint.opacity(0.20), lineWidth: 0.5)
        }
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
                            .foregroundStyle(.secondary)
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
                Label {
                    Text(text("journey.detail.feedback_title"))
                } icon: {
                    Image(systemName: "sparkles").foregroundStyle(SpottColor.amber)
                }
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
