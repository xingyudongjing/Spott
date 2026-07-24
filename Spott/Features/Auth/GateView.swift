import SwiftUI

struct GateView: View {
    let gate: AppGate

    var body: some View {
        switch gate {
        case .login, .phoneVerification:
            AuthGateSheetView()
        case .notificationPermission:
            NotificationPermissionGateView()
        }
    }
}

enum AuthGateStep: Hashable {
    case phoneVerification
}

struct AuthGateSheetView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale
    @Environment(\.dismiss) private var dismiss
    @State private var rootGate: AppGate?
    @State private var path: [AuthGateStep] = []
    @State private var detent: PresentationDetent = .medium

    var body: some View {
        NavigationStack(path: $path) {
            rootContent
                .navigationDestination(for: AuthGateStep.self) { step in
                    switch step {
                    case .phoneVerification:
                        PhoneVerificationView(variant: .chainedStep)
                            .navigationBarBackButtonHidden(true)
                            .background(AuthSheetBackground())
                    }
                }
        }
        .presentationDetents([.medium, .large], selection: $detent)
        .presentationDragIndicator(.visible)
        .onAppear {
            if rootGate == nil { rootGate = model.presentedGate }
        }
        .onChange(of: model.presentedGate) { _, newValue in
            guard rootGate == .login, newValue == .phoneVerification, path.isEmpty else { return }
            path = [.phoneVerification]
            detent = .large
        }
    }

    @ViewBuilder
    private var rootContent: some View {
        if (rootGate ?? model.presentedGate) == .phoneVerification {
            PhoneVerificationView(variant: .gateRoot)
                .background(AuthSheetBackground())
        } else {
            loginRoot
        }
    }

    private var loginRoot: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                AuthIntentHeader(intent: AuthGateIntent.current(model: model, locale: locale))
                AuthFormView(layout: .sheet) { detent = .large }
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .padding(.bottom, 24)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(AuthSheetBackground())
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    closeGate()
                } label: {
                    Image(systemName: "xmark")
                }
                .accessibilityLabel(AuthLocalization.text("auth.gate.close", locale: locale))
                .accessibilityIdentifier("auth.close")
            }
        }
    }

    private func closeGate() {
        model.cancelPresentedGate()
        dismiss()
    }
}

private struct AuthSheetBackground: View {
    var body: some View {
        ZStack(alignment: .top) {
            SpottColor.surface
            LinearGradient(
                colors: [SpottColor.twilight.opacity(0.08), .clear],
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(height: 120)
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}

struct AuthGateIntent {
    let event: EventSummary?
    let caption: String

    @MainActor
    static func current(model: AppModel, locale: Locale) -> AuthGateIntent {
        if let intent = model.router.deferredRegistrationIntent,
           [.register, .joinWaitlist].contains(intent.action) {
            return .init(
                event: model.router.cachedEvent(for: intent.event),
                caption: AuthLocalization.text("auth.header.intent.register", locale: locale)
            )
        }
        if let favorite = model.deferredFavoriteIntent {
            return .init(
                event: favorite.event,
                caption: AuthLocalization.text("auth.header.intent.favorite", locale: locale)
            )
        }
        if model.router.presentedComposer {
            return .init(
                event: nil,
                caption: AuthLocalization.text("auth.header.intent.create", locale: locale)
            )
        }
        return .init(
            event: nil,
            caption: AuthLocalization.text("auth.header.intent.default", locale: locale)
        )
    }
}

private struct AuthIntentHeader: View {
    let intent: AuthGateIntent
    var stepLabel: String?

    @Environment(\.locale) private var locale

    var body: some View {
        HStack(spacing: 12) {
            if let event = intent.event {
                EventCoverView(url: event.coverURL, category: event.category, cornerRadius: 12)
                    .frame(width: 40, height: 40)
            }
            VStack(alignment: .leading, spacing: 2) {
                if let stepLabel {
                    Text(stepLabel)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(SpottColor.muted)
                }
                Text(AuthLocalization.text("auth.header.title", locale: locale))
                    .font(.headline)
                Text(intent.caption)
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
            }
            Spacer(minLength: 0)
        }
        .frame(minHeight: 56)
        .accessibilityElement(children: .combine)
    }
}

private struct PhoneVerificationView: View {
    enum Variant {
        case gateRoot
        case chainedStep
    }

    let variant: Variant

    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var focusedField: Field?
    @State private var phone = "+81"
    @State private var code = ""
    @State private var challenge: PhoneChallenge?
    @State private var challengeTarget = AuthenticationChallengeTarget()
    @State private var busy = false
    @State private var error: UserFacingError?
    @State private var operationAuthority = AuthenticationGateOperationAuthority()
    @State private var verificationTask: Task<Void, Never>?
    @State private var gateIsActive = true

    private enum Field { case phone, code }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if variant == .chainedStep {
                    AuthIntentHeader(
                        intent: AuthGateIntent.current(model: model, locale: locale),
                        stepLabel: text("auth.phone.step")
                    )
                }

                Image(systemName: "iphone.gen3.badge.checkmark")
                    .font(.title2.weight(.medium))
                    .foregroundStyle(SpottColor.twilight)
                    .frame(width: 62, height: 62)
                    .background(
                        SpottColor.twilightPale.opacity(0.6),
                        in: Circle()
                    )
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 9) {
                    Text(text("auth.phone.title"))
                        .font(.title2.bold())
                    Text(text("auth.phone.message"))
                        .font(.subheadline)
                        .foregroundStyle(SpottColor.muted)
                        .lineSpacing(4)
                }

                solidField(
                    icon: "phone",
                    placeholder: text("auth.phone.placeholder"),
                    text: $phone,
                    field: .phone,
                    disabled: challenge != nil
                )
                    .keyboardType(.phonePad)
                    .textContentType(.telephoneNumber)

                if let lockedPhone = challengeTarget.lockedValue {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(text("auth.phone.sent_to"))
                                .font(.caption)
                                .foregroundStyle(SpottColor.muted)
                            Text(lockedPhone)
                                .font(.subheadline.weight(.semibold))
                                .textSelection(.enabled)
                        }
                        Spacer()
                        Button(text("auth.phone.change"), action: changePhone)
                            .font(.caption.weight(.semibold))
                            .disabled(busy)
                    }
                }

                if challenge != nil {
                    solidField(
                        icon: "number",
                        placeholder: text("auth.otp.code_placeholder"),
                        text: $code,
                        field: .code
                    )
                        .keyboardType(.numberPad)
                        .textContentType(.oneTimeCode)
                        .transition(
                            reduceMotion
                                ? .opacity
                                : .move(edge: .top).combined(with: .opacity)
                        )
                }

                Button(action: verify) {
                    HStack(spacing: 9) {
                        if busy { ProgressView().tint(.white) }
                        Text(phoneActionTitle)
                            .font(.body.weight(.semibold))
                    }
                    .frame(maxWidth: .infinity, minHeight: 34)
                }
                .spottProminentActionStyle()
                .controlSize(.large)
                .disabled(busy || normalizedPhone.count < 11 || (challenge != nil && code.count != 6))
                .accessibilityIdentifier("auth.phone.primary")

                Label(text("auth.phone.reward"), systemImage: "sparkles")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(SpottColor.mint)

#if DEBUG
                if let developmentCode = challenge?.developmentCode {
                    Text(AuthLocalization.format("auth.debug.code", locale: locale, developmentCode))
                        .font(.caption.monospaced())
                        .foregroundStyle(SpottColor.amber)
                }
#endif
                if let error {
                    Label(error.message, systemImage: "exclamationmark.circle.fill")
                        .font(.footnote)
                        .foregroundStyle(SpottColor.danger)
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            SpottColor.danger.opacity(0.08),
                            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                        )
                        .accessibilityIdentifier("auth.error.\(error.id)")
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .padding(.bottom, 24)
        }
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle(text("auth.phone.nav_title"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button(text("auth.phone.cancel")) {
                    gateIsActive = false
                    cancelPendingOperation()
                    model.cancelPresentedGate()
                }
            }
        }
        .animation(reduceMotion ? nil : SpottMotion.standard, value: challenge != nil)
        .onAppear { gateIsActive = true }
        .onDisappear {
            gateIsActive = false
            cancelPendingOperation()
        }
    }

    private func text(_ key: String.LocalizationValue) -> String {
        AuthLocalization.text(key, locale: locale)
    }

    private func solidField(
        icon: String,
        placeholder: String,
        text: Binding<String>,
        field: Field,
        disabled: Bool = false
    ) -> some View {
        HStack(spacing: 11) {
            Image(systemName: icon)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(SpottColor.muted)
                .frame(width: 20)
                .accessibilityHidden(true)
            TextField(placeholder, text: text)
                .font(.body)
                .focused($focusedField, equals: field)
                .disabled(disabled)
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 52)
        .background(
            Color(uiColor: .secondarySystemGroupedBackground),
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
    }

    private var phoneActionTitle: String {
        challenge == nil ? text("auth.cta.send_code") : text("auth.phone.verify")
    }

    private func verify() {
        focusedField = nil
        error = nil
        let requestedPhone = normalizedPhone
        let expectedChallenge = challenge
        guard challengeTarget.accepts(requestedPhone) else { return }
        beginVerificationOperation { generation in
            do {
                if let expectedChallenge {
                    _ = try await model.api.verifyPhone(
                        challengeID: expectedChallenge.challengeId,
                        code: code
                    )
                    guard operationIsCurrent(generation) else { return }
                    if let session = try await model.api.currentSession() {
                        guard operationIsCurrent(generation) else { return }
                        model.didAuthenticate(session)
                    } else {
                        model.markPhoneVerified()
                    }
                } else {
                    let response = try await model.api.requestPhoneCode(
                        phone: requestedPhone,
                        deviceID: DeviceIdentity.current
                    )
                    guard operationIsCurrent(generation) else { return }
                    challenge = response
                    challengeTarget.lock(requestedPhone)
#if DEBUG
                    if let developmentCode = response.developmentCode {
                        code = developmentCode
                    }
#endif
                    focusedField = .code
                }
            } catch is CancellationError {
                return
            } catch {
                guard operationIsCurrent(generation) else { return }
                self.error = AppModel.map(error)
            }
        }
    }

    private func changePhone() {
        cancelPendingOperation()
        challenge = nil
        challengeTarget.reset()
        code = ""
        error = nil
        focusedField = .phone
    }

    private func beginVerificationOperation(
        _ operation: @escaping @MainActor (Int) async -> Void
    ) {
        guard gateIsActive else { return }
        verificationTask?.cancel()
        let generation = operationAuthority.begin()
        busy = true
        verificationTask = Task { @MainActor in
            await operation(generation)
            guard operationIsCurrent(generation) else { return }
            busy = false
            verificationTask = nil
        }
    }

    private func operationIsCurrent(_ generation: Int) -> Bool {
        operationAuthority.isCurrent(generation) && !Task.isCancelled
    }

    private func cancelPendingOperation() {
        operationAuthority.cancel()
        verificationTask?.cancel()
        verificationTask = nil
        busy = false
    }

    private var normalizedPhone: String {
        phone.replacingOccurrences(of: " ", with: "").replacingOccurrences(of: "-", with: "")
    }
}

private struct NotificationPermissionGateView: View {
    @Environment(\.locale) private var locale

    var body: some View {
        PermissionExplanationView(
            icon: "bell.badge",
            title: AuthLocalization.text("auth.notification.title", locale: locale),
            message: AuthLocalization.text("auth.notification.message", locale: locale),
            action: AuthLocalization.text("auth.notification.action", locale: locale)
        ) {
            Task { _ = try? await NotificationCenterManager.shared.requestAuthorization() }
        }
    }
}

struct PermissionExplanationView: View {
    let icon: String
    let title: String
    let message: String
    let action: String
    let completion: () -> Void

    var body: some View {
        ZStack {
            SpottScreenBackground()
            VStack(spacing: 22) {
                Spacer()
                Image(systemName: icon)
                    .font(.title2.weight(.medium))
                    .foregroundStyle(SpottColor.twilight)
                    .frame(width: 70, height: 70)
                    .background(SpottColor.twilightPale.opacity(0.6), in: Circle())
                    .accessibilityHidden(true)
                Text(title)
                    .font(.title.bold())
                    .multilineTextAlignment(.center)
                Text(message)
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(SpottColor.muted)
                    .lineSpacing(4)
                Button(action: completion) {
                    Text(action)
                        .font(.body.weight(.semibold))
                        .frame(maxWidth: .infinity, minHeight: 34)
                }
                .spottProminentActionStyle()
                .controlSize(.large)
                Spacer()
            }
            .padding(28)
        }
    }
}

#Preview("Auth gate sheet") {
    Color.clear
        .sheet(isPresented: .constant(true)) {
            GateView(gate: .login)
                .presentationDetents([.medium, .large])
        }
        .environment(AppModel.preview)
}
