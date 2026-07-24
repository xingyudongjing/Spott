import SwiftUI

struct HostStudioView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale
    @State private var events: [EventSummary] = []
    @State private var loading = true
    @State private var loadError: UserFacingError?
    @State private var editingEvent: EventSummary?
    @State private var ticketEvent: EventSummary?
    @State private var promotionEvent: EventSummary?
    @State private var cancellingEvent: EventSummary?
    @State private var announcingEvent: EventSummary?

    var body: some View {
        ZStack {
            SpottScreenBackground()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    HStack(spacing: 10) {
                        StatTile(
                            value: "\(events.filter { ($0.startsAt ?? .distantPast) > .now }.count)",
                            label: text("host.stats.upcoming"),
                            symbol: "calendar"
                        )
                        StatTile(
                            value: "\(events.reduce(0) { $0 + $1.confirmedCount })",
                            label: text("host.stats.confirmed"),
                            symbol: "person.2",
                            tint: SpottColor.mint
                        )
                        StatTile(
                            value: "\(events.filter { $0.status == "draft" }.count)",
                            label: text("host.stats.drafts"),
                            symbol: "square.and.pencil",
                            tint: SpottColor.amber
                        )
                    }
                    SpottSectionHeader(title: text("host.events.section"))
                    if loading, events.isEmpty {
                        VStack(spacing: 14) {
                            ForEach(0..<3, id: \.self) { _ in
                                RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous)
                                    .fill(SpottColor.surface)
                                    .frame(height: 168)
                                    .spottSkeleton()
                            }
                        }
                    } else if let loadError, events.isEmpty {
                        SpottStateCard(
                            icon: "wifi.exclamationmark",
                            title: text("host.events.error_title"),
                            message: "\(loadError.message)（\(loadError.id)）",
                            actionTitle: text("host.events.retry")
                        ) { Task { await load() } }
                    } else if events.isEmpty {
                        SpottEmptyState(
                            icon: "calendar.badge.plus",
                            title: text("host.events.empty_title"),
                            message: text("host.events.empty_message")
                        )
                    } else {
                        ForEach(events) { event in
                            HostEventCard(
                                event: event,
                                locale: locale,
                                onOpen: { model.router.show(event: event) },
                                onEdit: { editingEvent = event },
                                onCancel: { cancellingEvent = event },
                                onTickets: { ticketEvent = event },
                                onPromotion: { promotionEvent = event },
                                onAnnounce: { announcingEvent = event }
                            )
                        }
                    }
                    Text(text("host.footer.privacy"))
                        .font(.caption)
                        .foregroundStyle(SpottColor.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(SpottMetric.pageInset)
            }
        }
        .background(SpottColor.canvas.ignoresSafeArea())
        .navigationTitle(text("host.title"))
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $editingEvent, onDismiss: { Task { await load() } }) { event in
            NavigationStack {
                EventComposerView(editing: event)
            }
            .tint(SpottColor.twilight)
        }
        .sheet(item: $ticketEvent) { event in
            NavigationStack {
                HostTicketTypesView(event: event)
            }
            .tint(SpottColor.twilight)
        }
        .sheet(item: $promotionEvent) { event in
            NavigationStack {
                HostPromotionView(event: event)
            }
            .tint(SpottColor.twilight)
            .presentationDetents([.large])
        }
        .sheet(item: $cancellingEvent) { event in
            NavigationStack {
                HostCancelEventView(event: event) { cancelled in
                    if let index = events.firstIndex(where: { $0.id == cancelled.id }) {
                        events[index] = cancelled
                    }
                }
            }
            .tint(SpottColor.twilight)
            .presentationDetents([.medium, .large])
        }
        .sheet(item: $announcingEvent) { event in
            NavigationStack {
                HostAnnouncementComposerView(event: event)
            }
            .tint(SpottColor.twilight)
            .presentationDetents([.large])
        }
    }

    private func load() async {
        loading = true
        do {
            events = try await model.api.hostedEvents().items
            loadError = nil
        } catch {
            loadError = AppModel.map(error)
        }
        loading = false
    }

    private func text(_ key: String.LocalizationValue) -> String {
        HostLocalization.text(key, locale: locale)
    }
}

private struct HostEventCard: View {
    let event: EventSummary
    let locale: Locale
    let onOpen: () -> Void
    let onEdit: () -> Void
    let onCancel: () -> Void
    let onTickets: () -> Void
    let onPromotion: () -> Void
    let onAnnounce: () -> Void

    private var canAnnounce: Bool {
        ["published", "registration_closed", "in_progress", "ended"].contains(event.status)
    }

    private var canEdit: Bool {
        event.availableActions.contains(.edit)
            && ["draft", "needs_changes", "published"].contains(event.status)
    }

    private var canCancel: Bool {
        event.availableActions.contains(.cancelEvent)
    }

    private var canPromote: Bool {
        event.status == "published"
    }

    private var canRunCheckIn: Bool {
        ["published", "registration_closed", "in_progress"].contains(event.status)
    }

    var body: some View {
        VStack(spacing: 0) {
            Button(action: onOpen) {
                VStack(alignment: .leading, spacing: 0) {
                    EventCoverView(url: event.coverURL, category: event.category, cornerRadius: 0)
                        .frame(height: 118)
                        .overlay(alignment: .topLeading) {
                            HostStatusPill(status: event.status, locale: locale)
                                .padding(10)
                        }
                    HStack(alignment: .top, spacing: 12) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(event.title)
                                .font(.system(size: 16, weight: .bold, design: .rounded))
                                .multilineTextAlignment(.leading)
                                .lineLimit(2)
                            Text(
                                event.startsAt?.formatted(.dateTime.month().day().hour().minute())
                                    ?? text("host.card.time_tbd")
                            )
                                .font(.caption)
                                .foregroundStyle(SpottColor.muted)
                            if let area = event.publicArea, !area.isEmpty {
                                Text(area)
                                    .font(.caption)
                                    .foregroundStyle(SpottColor.muted)
                                    .lineLimit(1)
                            }
                        }
                        Spacer()
                        if event.capacity > 0 {
                            VStack(spacing: 3) {
                                CapacityRing(confirmed: event.confirmedCount, capacity: event.capacity)
                                Text(
                                    HostLocalization.format(
                                        "host.card.confirmed_count",
                                        locale: locale,
                                        event.confirmedCount,
                                        event.capacity
                                    )
                                )
                                    .font(.caption2)
                                    .foregroundStyle(SpottColor.muted)
                            }
                        }
                    }
                    .padding(14)
                }
            }
            .buttonStyle(.plain)
            .foregroundStyle(SpottColor.ink)

            Divider().padding(.horizontal, 14)

            LazyVGrid(columns: [GridItem(.adaptive(minimum: 96), spacing: 8)], spacing: 8) {
                if canEdit {
                    quickAction(
                        event.status == "published" ? "host.action.edit" : "host.action.continue_edit",
                        systemImage: "square.and.pencil",
                        action: onEdit
                    )
                }
                quickAction("host.action.tickets", systemImage: "ticket", action: onTickets)
                if canPromote {
                    quickAction("host.action.promotion", systemImage: "megaphone", action: onPromotion)
                }
                if canRunCheckIn {
                    NavigationLink { HostCheckInView(event: event) } label: {
                        quickActionLabel("host.action.checkin", systemImage: "qrcode")
                    }
                    .buttonStyle(.glass)
                }
                if canAnnounce {
                    quickAction("host.action.announce", systemImage: "megaphone.fill", action: onAnnounce)
                }
                NavigationLink { HostAttendeeManagerView(event: event) } label: {
                    quickActionLabel("host.action.attendees", systemImage: "person.2")
                }
                .buttonStyle(.glass)
                NavigationLink { HostPrivateFeedbackView(event: event) } label: {
                    quickActionLabel("host.action.feedback", systemImage: "heart.text.clipboard")
                }
                .buttonStyle(.glass)
                if canCancel {
                    Button(role: .destructive, action: onCancel) {
                        quickActionLabel("host.action.cancel", systemImage: "xmark.circle")
                    }
                    .buttonStyle(.glass)
                    .tint(SpottColor.danger)
                }
            }
            .padding(12)
        }
        .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: SpottMetric.cardRadius).stroke(SpottColor.divider))
    }

    private func quickAction(
        _ key: String.LocalizationValue,
        systemImage: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            quickActionLabel(key, systemImage: systemImage)
        }
        .buttonStyle(.glass)
    }

    private func quickActionLabel(_ key: String.LocalizationValue, systemImage: String) -> some View {
        Label(text(key), systemImage: systemImage)
            .font(.caption.weight(.semibold))
            .lineLimit(1)
            .frame(maxWidth: .infinity, minHeight: 30)
    }

    private func text(_ key: String.LocalizationValue) -> String {
        HostLocalization.text(key, locale: locale)
    }
}

struct HostStatusPill: View {
    let status: String
    let locale: Locale

    var body: some View {
        Text(title)
            .font(.caption2.weight(.bold))
            .foregroundStyle(.white)
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(tint.opacity(0.92), in: Capsule())
            .accessibilityLabel(title)
    }

    private var title: String {
        let key: String.LocalizationValue = switch status {
        case "draft": "host.status.draft"
        case "pending_review": "host.status.pending_review"
        case "needs_changes": "host.status.needs_changes"
        case "published": "host.status.published"
        case "registration_closed": "host.status.registration_closed"
        case "in_progress": "host.status.in_progress"
        case "ended": "host.status.ended"
        case "cancelled": "host.status.cancelled"
        case "removed": "host.status.removed"
        case "rejected": "host.status.rejected"
        case "archived": "host.status.archived"
        default: "host.status.unknown"
        }
        return HostLocalization.text(key, locale: locale)
    }

    private var tint: Color {
        switch status {
        case "published", "in_progress": SpottColor.mint
        case "pending_review", "needs_changes": SpottColor.amber
        case "cancelled", "removed", "rejected": SpottColor.danger
        case "registration_closed": SpottColor.twilight
        default: SpottColor.muted
        }
    }
}

private struct HostCancelEventView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    let event: EventSummary
    let onCancelled: (EventSummary) -> Void

    @State private var reason = ""
    @State private var busy = false
    @State private var error: UserFacingError?
    @State private var confirming = false

    private var trimmedReason: String {
        reason.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var reasonValid: Bool {
        (3...500).contains(trimmedReason.count)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 7) {
                    Text(event.title)
                        .font(.system(size: 22, weight: .bold, design: .rounded))
                    Text(text("host.cancel.warning"))
                        .font(.subheadline)
                        .foregroundStyle(SpottColor.muted)
                        .lineSpacing(3)
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text(text("host.cancel.reason_label"))
                        .font(.subheadline.weight(.semibold))
                    TextField(text("host.cancel.reason_placeholder"), text: $reason, axis: .vertical)
                        .lineLimit(4...10)
                        .composerField()
                    Text(HostLocalization.format("host.cancel.reason_count", locale: locale, trimmedReason.count))
                        .font(.caption)
                        .foregroundStyle(reasonValid ? SpottColor.muted : SpottColor.danger)
                }
                if let error {
                    Label("\(error.message)（\(error.id)）", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(SpottColor.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Button {
                    confirming = true
                } label: {
                    if busy {
                        ProgressView().tint(.white).frame(maxWidth: .infinity, minHeight: 54)
                    } else {
                        Text(text("host.cancel.confirm_button"))
                            .font(.headline)
                            .frame(maxWidth: .infinity, minHeight: 54)
                    }
                }
                .buttonStyle(.glassProminent)
                .tint(SpottColor.danger)
                .disabled(!reasonValid || busy)
                .confirmationDialog(
                    text("host.cancel.dialog_title"),
                    isPresented: $confirming,
                    titleVisibility: .visible
                ) {
                    Button(text("host.cancel.dialog_confirm"), role: .destructive) { cancelEvent() }
                    Button(text("host.cancel.dialog_dismiss"), role: .cancel) {}
                } message: {
                    Text(text("host.cancel.dialog_message"))
                }
            }
            .padding(SpottMetric.pageInset)
        }
        .background(SpottColor.canvas.ignoresSafeArea())
        .navigationTitle(text("host.cancel.title"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button(text("host.common.close")) { dismiss() }
            }
        }
    }

    private func cancelEvent() {
        busy = true
        error = nil
        Task {
            do {
                let cancelled = try await model.api.cancelEvent(id: event.id, reason: trimmedReason)
                onCancelled(cancelled)
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                dismiss()
            } catch {
                self.error = AppModel.map(error)
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            }
            busy = false
        }
    }

    private func text(_ key: String.LocalizationValue) -> String {
        HostLocalization.text(key, locale: locale)
    }
}

private struct HostPrivateFeedbackView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale
    let event: EventSummary
    @State private var items: [PrivateFeedback] = []
    @State private var loading = true
    @State private var error: UserFacingError?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 15) {
                VStack(alignment: .leading, spacing: 7) {
                    Text(text("host.feedback.title"))
                        .font(.system(size: 26, weight: .bold, design: .rounded))
                    Text(text("host.feedback.subtitle"))
                        .font(.subheadline)
                        .foregroundStyle(SpottColor.muted)
                        .lineSpacing(3)
                }
                if loading {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 70)
                } else if let error, items.isEmpty {
                    SpottStateCard(
                        icon: "wifi.exclamationmark",
                        title: text("host.feedback.error_title"),
                        message: "\(error.message)\n\(HostLocalization.format("host.common.error_code", locale: locale, error.id))",
                        actionTitle: text("host.events.retry")
                    ) { Task { await load() } }
                } else if items.isEmpty {
                    SpottStateCard(
                        icon: "heart.text.clipboard",
                        title: text("host.feedback.empty_title"),
                        message: text("host.feedback.empty_message"),
                        actionTitle: nil
                    ) { }
                } else {
                    ForEach(items) { item in
                        VStack(alignment: .leading, spacing: 12) {
                            HStack {
                                Text(item.createdAt.formatted(date: .abbreviated, time: .omitted))
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(SpottColor.muted)
                                Spacer()
                                Text(text("host.feedback.anonymous"))
                                    .font(.caption2.weight(.bold))
                                    .foregroundStyle(SpottColor.twilight)
                            }
                            if !item.tags.isEmpty {
                                LazyVGrid(columns: [GridItem(.adaptive(minimum: 104), spacing: 7)], alignment: .leading, spacing: 7) {
                                    ForEach(item.tags) { tag in
                                        Text(tag.feedbackTitle)
                                            .font(.caption.weight(.semibold))
                                            .padding(.horizontal, 9)
                                            .padding(.vertical, 6)
                                            .background(SpottColor.twilightPale, in: Capsule())
                                    }
                                }
                            }
                            if let suggestion = item.privateSuggestion, !suggestion.isEmpty {
                                Text(suggestion)
                                    .font(.body)
                                    .lineSpacing(4)
                            } else {
                                Text(text("host.feedback.tags_only"))
                                    .font(.subheadline)
                                    .foregroundStyle(SpottColor.muted)
                            }
                        }
                        .padding(17)
                        .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: SpottMetric.cardRadius).stroke(SpottColor.divider))
                    }
                }
            }
            .padding(SpottMetric.pageInset)
        }
        .background(SpottColor.canvas.ignoresSafeArea())
        .navigationTitle(event.title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        loading = true
        do {
            items = try await model.api.privateFeedback(eventID: event.id).items
            error = nil
        } catch {
            self.error = AppModel.map(error)
        }
        loading = false
    }

    private func text(_ key: String.LocalizationValue) -> String {
        HostLocalization.text(key, locale: locale)
    }
}

// MARK: - Host → attendee broadcast composer

private struct HostAnnouncementComposerView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    let event: EventSummary

    @State private var title = ""
    @State private var messageBody = ""
    @State private var sent: [EventAnnouncement] = []
    @State private var dailyLimit = 5
    @State private var remainingToday = 5
    @State private var loading = true
    @State private var sending = false
    @State private var error: UserFacingError?

    private var trimmedTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedBody: String { messageBody.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var canSend: Bool {
        (2...120).contains(trimmedTitle.count)
            && (1...2000).contains(trimmedBody.count)
            && remainingToday > 0
            && !sending
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                composer
                if let error {
                    Label("\(error.message)（\(error.id)）", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(SpottColor.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
                sentSection
            }
            .padding(SpottMetric.pageInset)
        }
        .background(SpottColor.canvas.ignoresSafeArea())
        .navigationTitle(text("host.announce.title"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button(text("host.common.close")) { dismiss() }
            }
        }
        .task { await load() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(event.title)
                .font(.system(size: 22, weight: .bold, design: .rounded))
                .lineLimit(2)
            Text(text("host.announce.subtitle"))
                .font(.subheadline)
                .foregroundStyle(SpottColor.muted)
                .lineSpacing(3)
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 8) {
                Text(text("host.announce.field_title_label"))
                    .font(.subheadline.weight(.semibold))
                TextField(text("host.announce.field_title_placeholder"), text: $title)
                    .composerField()
            }
            VStack(alignment: .leading, spacing: 8) {
                Text(text("host.announce.field_body_label"))
                    .font(.subheadline.weight(.semibold))
                TextField(text("host.announce.field_body_placeholder"), text: $messageBody, axis: .vertical)
                    .lineLimit(4...12)
                    .composerField()
            }
            HStack {
                Label(
                    HostLocalization.format("host.announce.remaining", locale: locale, remainingToday),
                    systemImage: "gauge.with.dots.needle.33percent"
                )
                .font(.caption.weight(.semibold))
                .foregroundStyle(remainingToday > 0 ? SpottColor.muted : SpottColor.danger)
                Spacer()
            }
            Button {
                Task { await send() }
            } label: {
                if sending {
                    ProgressView().tint(.white).frame(maxWidth: .infinity, minHeight: 52)
                } else {
                    Text(text("host.announce.send_button"))
                        .font(.headline)
                        .frame(maxWidth: .infinity, minHeight: 52)
                }
            }
            .buttonStyle(.glassProminent)
            .tint(SpottColor.twilight)
            .disabled(!canSend)
        }
        .padding(16)
        .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: SpottMetric.cardRadius).stroke(SpottColor.divider))
    }

    @ViewBuilder
    private var sentSection: some View {
        SpottSectionHeader(title: text("host.announce.sent_section"))
        if loading, sent.isEmpty {
            ProgressView().frame(maxWidth: .infinity).padding(.top, 24)
        } else if sent.isEmpty {
            SpottEmptyState(
                icon: "megaphone",
                title: text("host.announce.empty_title"),
                message: text("host.announce.empty_message")
            )
        } else {
            ForEach(sent) { announcement in
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(announcement.title)
                            .font(.system(size: 15, weight: .bold, design: .rounded))
                            .lineLimit(2)
                        Spacer()
                        Text(announcement.sentAt.formatted(.dateTime.month().day().hour().minute()))
                            .font(.caption2)
                            .foregroundStyle(SpottColor.muted)
                    }
                    Text(announcement.body)
                        .font(.subheadline)
                        .foregroundStyle(SpottColor.ink)
                        .lineSpacing(3)
                    Label(
                        HostLocalization.format(
                            "host.announce.recipient_count",
                            locale: locale,
                            announcement.recipientCount
                        ),
                        systemImage: "checkmark.circle.fill"
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(SpottColor.mint)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(15)
                .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: SpottMetric.cardRadius).stroke(SpottColor.divider))
            }
        }
    }

    private func load() async {
        loading = true
        do {
            let page = try await model.api.hostEventAnnouncements(eventID: event.id)
            sent = page.items
            dailyLimit = page.dailyLimit
            remainingToday = page.remainingToday
            error = nil
        } catch {
            self.error = AppModel.map(error)
        }
        loading = false
    }

    private func send() async {
        sending = true
        error = nil
        do {
            let receipt = try await model.api.sendEventAnnouncement(
                eventID: event.id,
                title: trimmedTitle,
                body: trimmedBody
            )
            remainingToday = receipt.remainingToday
            title = ""
            messageBody = ""
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            await load()
        } catch {
            self.error = AppModel.map(error)
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
        sending = false
    }

    private func text(_ key: String.LocalizationValue) -> String {
        HostLocalization.text(key, locale: locale)
    }
}
