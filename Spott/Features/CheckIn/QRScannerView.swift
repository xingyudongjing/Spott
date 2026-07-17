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
                    .modifier(CheckInFloatingButtonStyle())
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
            }
            .buttonStyle(PrimaryButtonStyle())
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

private struct CheckInFloatingButtonStyle: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.buttonStyle(.glass)
        } else {
            content.buttonStyle(.bordered)
        }
    }
}

struct HostCheckInView: View {
    private enum Mode: String, CaseIterable, Identifiable {
        case dynamicQR = "dynamic_qr"
        case sixDigit = "six_digit"
        var id: String { rawValue }
        var title: LocalizedStringKey { self == .dynamicQR ? "动态二维码" : "6 位动态码" }
    }

    @Environment(AppModel.self) private var model
    let event: EventSummary
    @State private var mode: Mode
    @State private var currentCode: CheckInCode?
    @State private var error: UserFacingError?

    init(event: EventSummary) {
        self.event = event
        _mode = State(initialValue: event.checkinMode == "six_digit" ? .sixDigit : .dynamicQR)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                VStack(alignment: .leading, spacing: 7) {
                    Text(event.title)
                        .font(.system(size: 25, weight: .bold, design: .rounded))
                    Text("把这一页展示给现场参与者。签到码仅在 30 秒内有效，截屏或远程转发会很快失效。")
                        .font(.subheadline)
                        .foregroundStyle(SpottColor.muted)
                        .lineSpacing(3)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Picker("展示方式", selection: $mode) {
                    ForEach(Mode.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)

                codeCard

                HStack(spacing: 12) {
                    NavigationLink {
                        HostAttendeeManagerView(event: event)
                    } label: {
                        Label("报名与人工签到", systemImage: "person.2.badge.gearshape")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }

                if let error {
                    Label(error.message, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(SpottColor.danger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                Text("Spott 会记录签到方式、操作者和时间；同一报名只发放一次真实到场奖励。")
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(SpottMetric.pageInset)
        }
        .background(SpottColor.canvas.ignoresSafeArea())
        .navigationTitle("现场签到台")
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
                            .accessibilityLabel("现场动态签到二维码")
                    } else if let code = currentCode.code {
                        Text(code)
                            .font(.system(size: 50, weight: .bold, design: .monospaced))
                            .tracking(12)
                            .minimumScaleFactor(0.72)
                            .accessibilityLabel("现场签到码 \(code)")
                    }

                    let remaining = max(0, currentCode.validUntil.timeIntervalSince(context.date))
                    VStack(spacing: 7) {
                        ProgressView(value: remaining, total: 30)
                            .tint(remaining < 8 ? SpottColor.coral : SpottColor.twilight)
                        Text("\(Int(ceil(remaining))) 秒后自动更新")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(SpottColor.muted)
                    }
                } else {
                    ProgressView("正在生成安全签到码…")
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
        var title: LocalizedStringKey {
            switch self {
            case .all: "全部"
            case .pending: "待审核"
            case .confirmed: "已确认"
            case .checkedIn: "已签到"
            case .corrections: "补签"
            }
        }
        var apiValue: String? { self == .all || self == .corrections ? nil : rawValue }
    }

    @Environment(AppModel.self) private var model
    let event: EventSummary
    @State private var filter: Filter = .all
    @State private var attendees: [EventAttendee] = []
    @State private var corrections: [HostCheckInCorrection] = []
    @State private var loading = true
    @State private var workingID: UUID?
    @State private var error: UserFacingError?

    var body: some View {
        VStack(spacing: 12) {
            Picker("名单筛选", selection: $filter) {
                ForEach(Filter.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, SpottMetric.pageInset)

            if loading && attendees.isEmpty && corrections.isEmpty {
                Spacer()
                ProgressView("正在同步报名名单…")
                Spacer()
            } else if filter == .corrections, corrections.isEmpty {
                Spacer()
                SpottStateCard(
                    icon: "checkmark.seal",
                    title: "没有待处理补签",
                    message: "参与者在活动结束后 48 小时内提交的申请会出现在这里。",
                    actionTitle: "刷新"
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
            } else if attendees.isEmpty {
                Spacer()
                SpottStateCard(icon: "person.2", title: "当前没有成员", message: "新的报名会实时出现在这里。", actionTitle: "刷新") {
                    Task { await load() }
                }
                .padding(SpottMetric.pageInset)
                Spacer()
            } else {
                List(attendees) { attendee in
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
        .navigationTitle("报名与签到")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: filter) { await load() }
    }

    private func correctionRow(_ correction: HostCheckInCorrection) -> some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 12) {
                Text(correction.reason)
                    .font(.subheadline)
                    .lineSpacing(3)
                Text("提交于 \(correction.createdAt.formatted(date: .abbreviated, time: .shortened))")
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
                HStack(spacing: 10) {
                    Button("确认补签") { decide(correction, approve: true) }
                        .buttonStyle(.borderedProminent)
                        .tint(SpottColor.mint)
                    Button("拒绝") { decide(correction, approve: false) }
                        .buttonStyle(.bordered)
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
                    Text("@\(correction.attendee.publicHandle) · \(correction.registration.partySize) 人")
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
                    LabeledContent("参与备注", value: note)
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
                    Text("@\(attendee.attendee.publicHandle) · \(statusTitle(attendee.status))")
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
                Button("确认报名") { mutate(attendee, action: .approve) }
                    .buttonStyle(.borderedProminent)
                Button("拒绝") { mutate(attendee, action: .reject) }
                    .buttonStyle(.bordered)
                    .tint(SpottColor.danger)
            } else if attendee.status == "confirmed" {
                Button { mutate(attendee, action: .manualCheckIn) } label: {
                    Label("人工签到", systemImage: "checkmark.seal")
                }
                .buttonStyle(.borderedProminent)
                .tint(SpottColor.mint)
            } else if attendee.status == "checked_in" {
                Label("已完成现场核验", systemImage: "checkmark.circle.fill")
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
                attendees = try await model.api.eventAttendees(eventID: event.id, status: filter.apiValue).items
                corrections = []
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
        case .bool(let value): value ? String(localized: "是") : String(localized: "否")
        case .number(let value): value.formatted()
        case .null: "—"
        case .array, .object: "—"
        }
    }

    private func statusTitle(_ status: String) -> String {
        switch status {
        case "pending": String(localized: "待审核")
        case "confirmed": String(localized: "已确认")
        case "waitlisted": String(localized: "候补中")
        case "offered": String(localized: "待递补确认")
        case "checked_in": String(localized: "已签到")
        case "cancelled": String(localized: "已取消")
        case "rejected": String(localized: "已拒绝")
        default: status
        }
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
