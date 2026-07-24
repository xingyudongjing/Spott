import AVFoundation
import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI

enum CheckInCameraPanelState: Equatable, Sendable {
    case requesting
    case denied
    case scanner

    init(cameraAllowed: Bool?) {
        switch cameraAllowed {
        case nil: self = .requesting
        case false: self = .denied
        case true: self = .scanner
        }
    }
}

enum CheckInAccessibilityFocusTarget: Hashable, Sendable {
    case error
    case success
}

enum CheckInAccessibilityEvent: Equatable, Sendable {
    case failure
    case success

    var focusTarget: CheckInAccessibilityFocusTarget {
        switch self {
        case .failure: .error
        case .success: .success
        }
    }

    func announcement(eventTitle: String, locale: Locale) -> String {
        switch self {
        case .failure:
            CoreJourneyLocalization.text("journey.checkin.error", locale: locale)
        case .success:
            CoreJourneyLocalization.format(
                "journey.checkin.success_announcement",
                locale: locale,
                eventTitle
            )
        }
    }
}

struct ParticipantCheckInView: View {
    private enum EntryMode: String, CaseIterable, Identifiable {
        case camera
        case code
        var id: String { rawValue }
        var localizationKey: String.LocalizationValue {
            self == .camera ? "journey.checkin.scan" : "journey.checkin.code"
        }
    }

    private struct Attempt: Equatable {
        let credential: String
        let operationID: UUID
        let idempotencyKey: UUID
    }

    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    let event: EventSummary
    let registration: Registration

    @ScaledMetric(relativeTo: .largeTitle) private var successIconSize = 72.0
    @AccessibilityFocusState private var accessibilityFocus: CheckInAccessibilityFocusTarget?
    @State private var entryMode: EntryMode = .camera
    @State private var token: String?
    @State private var code = ""
    @State private var torch = false
    @State private var cameraAllowed: Bool?
    @State private var busy = false
    @State private var result: Registration?
    @State private var error: UserFacingError?
    @State private var attempt: Attempt?

    var body: some View {
        Group {
            if let result {
                successView(result)
            } else {
                checkInForm
            }
        }
        .background(SpottColor.canvas.ignoresSafeArea())
        .navigationTitle(text("journey.checkin.title"))
        .navigationBarTitleDisplayMode(.inline)
        .task(id: entryMode) {
            guard entryMode == .camera else { return }
            await requestCameraAccessIfNeeded()
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active, entryMode == .camera else { return }
            Task { await requestCameraAccessIfNeeded() }
        }
        .onChange(of: token) { _, newValue in
            guard let newValue else { return }
            submit(token: newValue, code: nil)
        }
    }

    private var checkInForm: some View {
        VStack(spacing: 18) {
            VStack(alignment: .leading, spacing: 6) {
                Text(event.title)
                    .font(.title2.bold())
                    .fontDesign(.rounded)
                    .fixedSize(horizontal: false, vertical: true)
                Text(text("journey.checkin.guidance"))
                    .font(.subheadline)
                    .foregroundStyle(SpottColor.muted)
                    .lineSpacing(3)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Picker(text("journey.checkin.method"), selection: $entryMode) {
                ForEach(EntryMode.allCases) {
                    Text(text($0.localizationKey)).tag($0)
                }
            }
            .pickerStyle(.segmented)

            if entryMode == .camera {
                cameraPanel
            } else {
                codePanel
            }

            if error != nil {
                Label(text("journey.checkin.error"), systemImage: "exclamationmark.circle.fill")
                    .font(.subheadline)
                    .foregroundStyle(SpottColor.danger)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
                    .background(SpottColor.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityFocused($accessibilityFocus, equals: .error)
                    .accessibilityIdentifier("checkin.error")
            }

            Spacer(minLength: 0)
        }
        .padding(SpottMetric.pageInset)
    }

    @ViewBuilder
    private var cameraPanel: some View {
        switch CheckInCameraPanelState(cameraAllowed: cameraAllowed) {
        case .requesting:
            ProgressView(text("journey.checkin.camera_requesting"))
                .frame(maxWidth: .infinity, minHeight: 220)
                .background(
                    Color(uiColor: .secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 24, style: .continuous)
                )
                .accessibilityIdentifier("checkin.camera.requesting")
        case .denied:
            SpottStateCard(
                icon: "camera.fill",
                title: text("journey.checkin.camera_title"),
                message: text("journey.checkin.camera_message"),
                actionTitle: text("journey.checkin.open_settings")
            ) {
                guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                model.openExternal(url: url)
            }
        case .scanner:
            ZStack {
                QRScannerRepresentable(token: $token, torch: torch)
                RoundedRectangle(cornerRadius: 28, style: .continuous)
                    .stroke(.white.opacity(0.95), lineWidth: 2.5)
                    .frame(width: 238, height: 238)
                    .shadow(color: SpottColor.twilight.opacity(0.55), radius: 14)
                VStack {
                    Spacer()
                    Button { torch.toggle() } label: {
                        Label(
                            text(
                                torch
                                    ? "journey.checkin.torch_off"
                                    : "journey.checkin.torch_on"
                            ),
                            systemImage: torch ? "flashlight.off.fill" : "flashlight.on.fill"
                        )
                            .padding(.horizontal, 16)
                            .frame(height: 44)
                    }
                    .buttonStyle(.glass)
                    .foregroundStyle(.white)
                    .padding(.bottom, 18)
                }
                if busy {
                    ProgressView(text("journey.checkin.verifying"))
                        .tint(.white)
                        .foregroundStyle(.white)
                        .padding(18)
                        .background(.black.opacity(0.56), in: RoundedRectangle(cornerRadius: 18))
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 430)
            .clipShape(RoundedRectangle(cornerRadius: 30, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 30).stroke(Color.white.opacity(0.46)))
        }
    }

    private var codePanel: some View {
        VStack(spacing: 18) {
            TextField("000000", text: $code)
                .keyboardType(.numberPad)
                .textContentType(.oneTimeCode)
                .multilineTextAlignment(.center)
                .font(.system(.largeTitle, design: .monospaced, weight: .bold))
                .tracking(9)
                .minimumScaleFactor(0.72)
                .onChange(of: code) { _, value in
                    code = String(value.filter(\.isNumber).prefix(6))
                    if code.count == 6 { error = nil }
                }
                .frame(height: 72)
                .background(
                    Color(uiColor: .secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 22, style: .continuous)
                )
                .overlay {
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .stroke(Color.primary.opacity(0.1), lineWidth: 0.5)
                }
                .accessibilityLabel(text("journey.checkin.code_field"))

            Button {
                submit(token: nil, code: code)
            } label: {
                HStack(spacing: 9) {
                    if busy { ProgressView().tint(.white) }
                    Text(text("journey.checkin.submit"))
                }
                .frame(maxWidth: .infinity)
            }
            .spottProminentActionStyle()
            .controlSize(.large)
            .disabled(busy || code.count != 6)
        }
        .padding(.top, 16)
    }

    private func successView(_ registration: Registration) -> some View {
        ScrollView {
            VStack(spacing: 22) {
                successIcon(registration)
                VStack(spacing: 8) {
                    Text(text("journey.checkin.success"))
                        .font(.largeTitle.bold())
                        .fontDesign(.rounded)
                        .multilineTextAlignment(.center)
                        .accessibilityFocused($accessibilityFocus, equals: .success)
                        .accessibilityIdentifier("checkin.success")
                    Text(event.title)
                        .font(.headline)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                    if let points = registration.rewardPoints, points > 0 {
                        Label(
                            CoreJourneyLocalization.format(
                                "journey.checkin.reward",
                                locale: locale,
                                points
                            ),
                            systemImage: "sparkles"
                        )
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(SpottColor.mint)
                    } else {
                        Text(text("journey.checkin.synced"))
                            .font(.subheadline)
                            .foregroundStyle(SpottColor.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(24)
                .frame(maxWidth: .infinity)
                .background(
                    Color(uiColor: .secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 28, style: .continuous)
                )
            }
            .padding(SpottMetric.pageInset)
            .padding(.top, 36)
            .frame(maxWidth: .infinity)
        }
    }

    private func requestCameraAccessIfNeeded() async {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: cameraAllowed = true
        case .notDetermined: cameraAllowed = await AVCaptureDevice.requestAccess(for: .video)
        default: cameraAllowed = false
        }
    }

    private func submit(token: String?, code: String?) {
        guard !busy else { return }
        let credential = token.map { "token:\($0)" } ?? "code:\(code ?? "")"
        if attempt?.credential != credential {
            attempt = Attempt(credential: credential, operationID: UUID(), idempotencyKey: UUID())
        }
        guard let attempt else { return }
        busy = true
        error = nil
        accessibilityFocus = nil

        Task { @MainActor in
            defer { busy = false }
            do {
                let payload = try CheckInRequestPayload(
                    registrationID: registration.id,
                    operationID: attempt.operationID,
                    token: token,
                    code: code
                )
                result = try await model.api.checkIn(payload, idempotencyKey: attempt.idempotencyKey)
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                focusAndAnnounce(.success)
            } catch {
                self.error = .init(
                    id: (error as? APIError)?.code ?? "CHECK_IN_FAILED",
                    message: text("journey.checkin.error"),
                    retryable: true
                )
                if token != nil { self.token = nil }
                UINotificationFeedbackGenerator().notificationOccurred(.error)
                focusAndAnnounce(.failure)
            }
        }
    }

    @ViewBuilder
    private func successIcon(_ registration: Registration) -> some View {
        let icon = Image(systemName: "checkmark.circle.fill")
            .font(.system(size: successIconSize, weight: .semibold))
            .foregroundStyle(SpottColor.mint)
            .accessibilityHidden(true)
        if reduceMotion {
            icon
        } else {
            icon.symbolEffect(.bounce, value: registration.status)
        }
    }

    private func focusAndAnnounce(_ event: CheckInAccessibilityEvent) {
        let message = event.announcement(eventTitle: self.event.title, locale: locale)
        accessibilityFocus = nil
        Task { @MainActor in
            await Task.yield()
            await Task.yield()
            accessibilityFocus = event.focusTarget
            UIAccessibility.post(notification: .announcement, argument: message)
        }
    }

    private func text(_ key: String.LocalizationValue) -> String {
        CoreJourneyLocalization.text(key, locale: locale)
    }
}

struct HostCheckInView: View {
    private enum Mode: String, CaseIterable, Identifiable {
        case dynamicQR = "dynamic_qr"
        case sixDigit = "six_digit"
        var id: String { rawValue }
        var titleKey: String.LocalizationValue {
            self == .dynamicQR ? "host.checkin.mode_qr" : "host.checkin.mode_six_digit"
        }
    }

    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale
    let event: EventSummary
    @State private var mode: Mode
    @State private var currentCode: CheckInCode?
    @State private var error: UserFacingError?

    init(event: EventSummary) {
        self.event = event
        _mode = State(initialValue: event.checkinMode == "six_digit" ? .sixDigit : .dynamicQR)
    }

    var body: some View {
        ZStack {
            SpottScreenBackground()
            ScrollView {
                VStack(spacing: 22) {
                    VStack(alignment: .leading, spacing: 7) {
                        Text(event.title)
                            .font(.system(size: 25, weight: .bold, design: .rounded))
                        Text(text("host.checkin.guidance"))
                            .font(.subheadline)
                            .foregroundStyle(SpottColor.muted)
                            .lineSpacing(3)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    Picker(text("host.checkin.display_mode"), selection: $mode) {
                        ForEach(Mode.allCases) { Text(text($0.titleKey)).tag($0) }
                    }
                    .pickerStyle(.segmented)

                    codeCard

                    HStack(spacing: 12) {
                        NavigationLink {
                            HostAttendeeManagerView(event: event)
                        } label: {
                            Label(text("host.checkin.attendee_link"), systemImage: "person.2.badge.gearshape")
                                .font(.subheadline.weight(.semibold))
                                .frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.glass)
                    }

                    if let error {
                        Label(error.message, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(SpottColor.danger)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Text(text("host.checkin.audit_note"))
                        .font(.caption)
                        .foregroundStyle(SpottColor.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(SpottMetric.pageInset)
            }
        }
        .background(SpottColor.canvas.ignoresSafeArea())
        .navigationTitle(text("host.checkin.title"))
        .navigationBarTitleDisplayMode(.inline)
        .task(id: mode) { await refreshLoop() }
    }

    @ViewBuilder
    private var codeCard: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            VStack(spacing: 18) {
                if let currentCode {
                    if mode == .dynamicQR, let token = currentCode.token {
                        QRCodeView(value: token)
                            .frame(width: 260, height: 260)
                            .accessibilityLabel(text("host.checkin.qr_accessibility"))
                    } else if let code = currentCode.code {
                        Text(code)
                            .font(.system(size: 50, weight: .bold, design: .monospaced))
                            .tracking(12)
                            .minimumScaleFactor(0.72)
                            .foregroundStyle(Color.black)
                            .accessibilityLabel(
                                HostLocalization.format("host.checkin.code_accessibility", locale: locale, code)
                            )
                    }

                    let remaining = max(0, currentCode.validUntil.timeIntervalSince(context.date))
                    VStack(spacing: 7) {
                        ProgressView(value: remaining, total: 30)
                            .tint(remaining < 8 ? SpottColor.coral : SpottColor.twilight)
                        Text(
                            HostLocalization.format(
                                "host.checkin.refresh_countdown",
                                locale: locale,
                                Int(ceil(remaining))
                            )
                        )
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(Color.black.opacity(0.55))
                    }
                } else {
                    ProgressView {
                        Text(text("host.checkin.generating"))
                            .foregroundStyle(Color.black.opacity(0.7))
                    }
                    .tint(SpottColor.twilight)
                    .frame(height: 260)
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity)
            .background(.white, in: RoundedRectangle(cornerRadius: 30, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 30).stroke(SpottColor.divider))
            .shadow(color: SpottColor.ink.opacity(0.07), radius: 22, y: 10)
        }
    }

    private func text(_ key: String.LocalizationValue) -> String {
        HostLocalization.text(key, locale: locale)
    }

    private func refreshLoop() async {
        currentCode = nil
        error = nil
        while !Task.isCancelled {
            do {
                let code = try await model.api.createCheckInCode(eventID: event.id, mode: mode.rawValue)
                currentCode = code
                error = nil
                let delay = max(2, code.validUntil.timeIntervalSinceNow - 2)
                try await Task.sleep(for: .seconds(delay))
            } catch is CancellationError {
                return
            } catch {
                self.error = AppModel.map(error)
                try? await Task.sleep(for: .seconds(4))
            }
        }
    }
}

struct HostAttendeeManagerView: View {
    private enum Filter: String, CaseIterable, Identifiable {
        case all
        case pending
        case confirmed
        case checkedIn = "checked_in"
        case corrections
        var id: String { rawValue }
        var titleKey: String.LocalizationValue {
            switch self {
            case .all: "host.attendees.filter_all"
            case .pending: "host.attendees.filter_pending"
            case .confirmed: "host.attendees.filter_confirmed"
            case .checkedIn: "host.attendees.filter_checked_in"
            case .corrections: "host.attendees.filter_corrections"
            }
        }
        var apiValue: String? { self == .all || self == .corrections ? nil : rawValue }
    }

    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale
    let event: EventSummary
    @State private var filter: Filter = .all
    @State private var attendees: [EventAttendee] = []
    @State private var corrections: [HostCheckInCorrection] = []
    @State private var loading = true
    @State private var workingID: UUID?
    @State private var error: UserFacingError?
    @State private var searchText = ""
    @State private var statusCounts: [String: Int]?
    @State private var listTruncated = false

    private var visibleAttendees: [EventAttendee] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return attendees }
        return attendees.filter {
            $0.attendee.nickname.lowercased().contains(query)
                || $0.attendee.publicHandle.lowercased().contains(query)
        }
    }

    var body: some View {
        VStack(spacing: 12) {
            Picker(text("host.attendees.filter_label"), selection: $filter) {
                ForEach(Filter.allCases) { Text(text($0.titleKey)).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, SpottMetric.pageInset)

            if let statusCounts, filter != .corrections {
                Text(countsSummary(statusCounts))
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, SpottMetric.pageInset)
            }

            if listTruncated, filter != .corrections {
                Label(text("host.attendees.truncated"), systemImage: "info.circle")
                    .font(.caption)
                    .foregroundStyle(SpottColor.amber)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, SpottMetric.pageInset)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if loading && attendees.isEmpty && corrections.isEmpty {
                Spacer()
                ProgressView(text("host.attendees.loading"))
                Spacer()
            } else if filter == .corrections, corrections.isEmpty {
                Spacer()
                SpottStateCard(
                    icon: "checkmark.seal",
                    title: text("host.attendees.corrections_empty_title"),
                    message: text("host.attendees.corrections_empty_message"),
                    actionTitle: text("host.attendees.refresh")
                ) { Task { await load() } }
                .padding(SpottMetric.pageInset)
                Spacer()
            } else if filter == .corrections {
                List(corrections) { correction in
                    correctionRow(correction)
                        .listRowBackground(SpottColor.surface)
                }
                .listStyle(.plain)
                .refreshable { await load() }
            } else if visibleAttendees.isEmpty {
                Spacer()
                if attendees.isEmpty {
                    SpottStateCard(
                        icon: "person.2",
                        title: text("host.attendees.empty_title"),
                        message: text("host.attendees.empty_message"),
                        actionTitle: text("host.attendees.refresh")
                    ) {
                        Task { await load() }
                    }
                    .padding(SpottMetric.pageInset)
                } else {
                    SpottStateCard(
                        icon: "magnifyingglass",
                        title: text("host.attendees.search_empty_title"),
                        message: text("host.attendees.search_empty_message"),
                        actionTitle: nil
                    ) { }
                    .padding(SpottMetric.pageInset)
                }
                Spacer()
            } else {
                List(visibleAttendees) { attendee in
                    attendeeRow(attendee)
                        .listRowBackground(SpottColor.surface)
                }
                .listStyle(.plain)
                .refreshable { await load() }
            }

            if let error {
                Text("\(error.message)（\(error.id)）")
                    .font(.caption)
                    .foregroundStyle(SpottColor.danger)
                    .padding(.horizontal, SpottMetric.pageInset)
            }
        }
        .background(SpottColor.canvas.ignoresSafeArea())
        .navigationTitle(text("host.attendees.title"))
        .navigationBarTitleDisplayMode(.inline)
        .searchable(
            text: $searchText,
            placement: .navigationBarDrawer(displayMode: .automatic),
            prompt: Text(text("host.attendees.search_prompt"))
        )
        .task(id: filter) { await load() }
    }

    private func countsSummary(_ counts: [String: Int]) -> String {
        let parts: [(String.LocalizationValue, String)] = [
            ("host.attendees.filter_pending", "pending"),
            ("host.attendees.filter_confirmed", "confirmed"),
            ("host.attendees.filter_checked_in", "checked_in"),
            ("host.attendees.count_waitlisted", "waitlisted"),
        ]
        return parts
            .compactMap { key, status in
                guard let count = counts[status], count > 0 else { return nil }
                return "\(text(key)) \(count)"
            }
            .joined(separator: " · ")
    }

    private func correctionRow(_ correction: HostCheckInCorrection) -> some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 12) {
                Text(correction.reason)
                    .font(.subheadline)
                    .lineSpacing(3)
                Text(
                    HostLocalization.format(
                        "host.attendees.correction_submitted_at",
                        locale: locale,
                        correction.createdAt.formatted(date: .abbreviated, time: .shortened)
                    )
                )
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
                HStack(spacing: 10) {
                    Button(text("host.attendees.correction_approve")) { decide(correction, approve: true) }
                        .buttonStyle(.glassProminent)
                        .tint(SpottColor.mint)
                    Button(text("host.attendees.correction_reject")) { decide(correction, approve: false) }
                        .buttonStyle(.glass)
                        .tint(SpottColor.danger)
                }
                .disabled(workingID != nil)
            }
            .padding(.vertical, 5)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "clock.badge.questionmark")
                    .font(.title2)
                    .foregroundStyle(SpottColor.amber)
                VStack(alignment: .leading, spacing: 3) {
                    Text(correction.attendee.nickname).font(.headline)
                    Text(
                        HostLocalization.format(
                            "host.attendees.handle_party",
                            locale: locale,
                            correction.attendee.publicHandle,
                            correction.registration.partySize
                        )
                    )
                        .font(.caption)
                        .foregroundStyle(SpottColor.muted)
                }
                Spacer()
                if workingID == correction.id { ProgressView() }
            }
        }
    }

    private func attendeeRow(_ attendee: EventAttendee) -> some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 9) {
                if let note = attendee.attendeeNote, !note.isEmpty {
                    LabeledContent(text("host.attendees.note_label"), value: note)
                }
                ForEach(answerRows(attendee), id: \.question) { row in
                    LabeledContent(row.question, value: row.answer)
                }
                actionButtons(attendee)
                    .padding(.top, 6)
            }
            .font(.caption)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: attendee.status == "checked_in" ? "checkmark.circle.fill" : "person.crop.circle")
                    .font(.title2)
                    .foregroundStyle(attendee.status == "checked_in" ? SpottColor.mint : SpottColor.twilight)
                VStack(alignment: .leading, spacing: 3) {
                    Text(attendee.attendee.nickname).font(.headline)
                    Text(verbatim: "@\(attendee.attendee.publicHandle) · \(statusTitle(attendee.status))")
                        .font(.caption)
                        .foregroundStyle(SpottColor.muted)
                }
                Spacer()
                if workingID == attendee.id { ProgressView() }
            }
        }
    }

    @ViewBuilder
    private func actionButtons(_ attendee: EventAttendee) -> some View {
        HStack(spacing: 10) {
            if attendee.status == "pending" {
                Button(text("host.attendees.approve")) { mutate(attendee, action: .approve) }
                    .buttonStyle(.glassProminent)
                    .tint(SpottColor.twilight)
                Button(text("host.attendees.reject")) { mutate(attendee, action: .reject) }
                    .buttonStyle(.glass)
                    .tint(SpottColor.danger)
            } else if attendee.status == "confirmed" {
                Button { mutate(attendee, action: .manualCheckIn) } label: {
                    Label(text("host.attendees.manual_checkin"), systemImage: "checkmark.seal")
                }
                .buttonStyle(.glassProminent)
                .tint(SpottColor.mint)
            } else if attendee.status == "checked_in" {
                Label(text("host.attendees.verified"), systemImage: "checkmark.circle.fill")
                    .foregroundStyle(SpottColor.mint)
            }
        }
        .disabled(workingID != nil)
    }

    private enum Mutation { case approve, reject, manualCheckIn }

    private func mutate(_ attendee: EventAttendee, action: Mutation) {
        workingID = attendee.id
        error = nil
        Task { @MainActor in
            defer { workingID = nil }
            do {
                switch action {
                case .approve:
                    _ = try await model.api.decideRegistration(registrationID: attendee.id, approve: true)
                case .reject:
                    _ = try await model.api.decideRegistration(registrationID: attendee.id, approve: false)
                case .manualCheckIn:
                    _ = try await model.api.manualCheckIn(eventID: event.id, registrationID: attendee.id)
                }
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                await load()
            } catch {
                self.error = AppModel.map(error)
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            }
        }
    }

    private func decide(_ correction: HostCheckInCorrection, approve: Bool) {
        workingID = correction.id
        error = nil
        Task { @MainActor in
            defer { workingID = nil }
            do {
                _ = try await model.api.decideCheckInCorrection(
                    correctionID: correction.id,
                    approve: approve
                )
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                await load()
            } catch {
                self.error = AppModel.map(error)
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            }
        }
    }

    private func load() async {
        loading = true
        do {
            if filter == .corrections {
                corrections = try await model.api.checkInCorrections(eventID: event.id).items
                attendees = []
            } else {
                let page = try await model.api.eventAttendees(eventID: event.id, status: filter.apiValue)
                attendees = page.items
                corrections = []
                if filter == .all {
                    listTruncated = page.hasMore
                    if page.hasMore {
                        statusCounts = nil
                    } else {
                        statusCounts = page.items.reduce(into: [:]) { counts, attendee in
                            counts[attendee.status, default: 0] += 1
                        }
                    }
                } else {
                    listTruncated = page.hasMore
                }
            }
            error = nil
        } catch {
            self.error = AppModel.map(error)
        }
        loading = false
    }

    private func answerRows(_ attendee: EventAttendee) -> [(question: String, answer: String)] {
        (event.registrationQuestions ?? []).compactMap { question in
            guard let answer = attendee.answers[question.id.uuidString.lowercased()] else { return nil }
            return (question.prompt, display(answer))
        }
    }

    private func display(_ value: JSONValue) -> String {
        switch value {
        case .string(let value): value
        case .bool(let value): value ? text("host.attendees.answer_yes") : text("host.attendees.answer_no")
        case .number(let value): value.formatted()
        case .null: "—"
        case .array, .object: "—"
        }
    }

    private func statusTitle(_ status: String) -> String {
        let key: String.LocalizationValue? = switch status {
        case "pending": "host.attendees.status_pending"
        case "confirmed": "host.attendees.status_confirmed"
        case "waitlisted": "host.attendees.status_waitlisted"
        case "offered": "host.attendees.status_offered"
        case "checked_in": "host.attendees.status_checked_in"
        case "cancelled": "host.attendees.status_cancelled"
        case "rejected": "host.attendees.status_rejected"
        default: nil
        }
        guard let key else { return status }
        return text(key)
    }

    private func text(_ key: String.LocalizationValue) -> String {
        HostLocalization.text(key, locale: locale)
    }
}

private struct QRCodeView: View {
    let value: String

    var body: some View {
        if let image = makeImage() {
            Image(decorative: image, scale: 1)
                .resizable()
                .interpolation(.none)
                .scaledToFit()
                .padding(10)
                .background(.white)
        } else {
            Image(systemName: "qrcode")
                .resizable()
                .scaledToFit()
                .foregroundStyle(SpottColor.ink)
        }
    }

    private func makeImage() -> CGImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(value.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 12, y: 12))
        return CIContext().createCGImage(scaled, from: scaled.extent)
    }
}

private struct QRScannerRepresentable: UIViewControllerRepresentable {
    @Binding var token: String?
    let torch: Bool

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.onToken = { token = $0 }
        return controller
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) {
        controller.setTorch(torch)
    }
}

private final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onToken: ((String) -> Void)?
    private let capture = CaptureSessionBox()
    private var preview: AVCaptureVideoPreviewLayer?
    private var lastToken: String?
    private var lastRead = Date.distantPast

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        let session = capture.session
        guard
            let device = AVCaptureDevice.default(for: .video),
            let input = try? AVCaptureDeviceInput(device: device),
            session.canAddInput(input)
        else { return }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.addSublayer(preview)
        self.preview = preview
        Task.detached { [capture] in capture.session.startRunning() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        let capture = capture
        Task.detached { capture.session.stopRunning() }
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard
            let value = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue,
            value != lastToken || Date().timeIntervalSince(lastRead) > 2
        else { return }
        lastToken = value
        lastRead = .now
        onToken?(value)
    }

    func setTorch(_ enabled: Bool) {
        guard let device = AVCaptureDevice.default(for: .video), device.hasTorch else { return }
        try? device.lockForConfiguration()
        device.torchMode = enabled ? .on : .off
        device.unlockForConfiguration()
    }
}

/// AVCaptureSession synchronizes its own graph. Start/stop are deliberately
/// kept off the main actor because they can block while the camera warms up.
private final class CaptureSessionBox: @unchecked Sendable {
    let session = AVCaptureSession()
}
