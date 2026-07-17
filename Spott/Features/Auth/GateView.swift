import AuthenticationServices
import GoogleSignInSwift
import SwiftUI

struct GateView: View {
    let gate: AppGate

    var body: some View {
        switch gate {
        case .login:
            LoginView()
        case .phoneVerification:
            PhoneVerificationView()
        case .notificationPermission:
            PermissionExplanationView(
                icon: "bell.badge",
                title: "及时知道关键变化",
                message: "仅在候补递补、活动取消和安全提醒时发送必要通知。",
                action: "允许通知"
            ) {
                Task { _ = try? await NotificationCenterManager.shared.requestAuthorization() }
            }
        }
    }
}

private struct LoginView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var focusedField: Field?
    @State private var email = ""
    @State private var code = ""
    @State private var challenge: EmailChallenge?
    @State private var challengeTarget = AuthenticationChallengeTarget()
    @State private var currentAppleNonce: String?
    @State private var busy = false
    @State private var error: UserFacingError?
    @State private var operationAuthority = AuthenticationGateOperationAuthority()
    @State private var authenticationTask: Task<Void, Never>?
    @State private var gateIsActive = true

    private enum Field { case email, code }

    var body: some View {
        NavigationStack {
            ZStack {
                GateCanvas()
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        brand
                        introduction
                        accountBenefits
                        appleSignIn
                        googleSignIn
                        divider
                        emailSignIn
                        privacyNote
                    }
                    .padding(.horizontal, 24)
                    .padding(.top, 22)
                    .padding(.bottom, 34)
                }
                .scrollDismissesKeyboard(.interactively)

                if busy {
                    Color.white.opacity(0.18).ignoresSafeArea()
                    ProgressView()
                        .controlSize(.large)
                        .padding(24)
                        .spottGlassPanel(shape: Circle(), interactive: false)
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("关闭") {
                        gateIsActive = false
                        cancelPendingOperation()
                        model.cancelPresentedGate()
                        dismiss()
                    }
                }
            }
            .onAppear { gateIsActive = true }
            .onDisappear {
                gateIsActive = false
                cancelPendingOperation()
            }
        }
    }

    private var brand: some View {
        Text("spott")
            .font(.system(size: 23, weight: .bold, design: .rounded))
            .tracking(-0.8)
            .accessibilityLabel("Spott")
    }

    private var introduction: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("把每一次见面，\n留在同一个账号里。")
                .font(.system(size: 34, weight: .bold, design: .rounded))
                .tracking(-1.1)
                .lineSpacing(-2)
                .foregroundStyle(SpottColor.ink)
            Text("报名、候补、票码与主办方工具会在 iPhone 和 Web 安全同步。")
                .font(.system(size: 15, design: .rounded))
                .foregroundStyle(SpottColor.muted)
                .lineSpacing(4)
        }
    }

    private var accountBenefits: some View {
        HStack(spacing: 9) {
            benefit("iphone.and.arrow.forward", "跨端同步")
            benefit("lock.shield", "隐私保护")
            benefit("person.2", "活动身份")
        }
    }

    private func benefit(_ icon: String, _ title: LocalizedStringKey) -> some View {
        Label(title, systemImage: icon)
            .font(.system(size: 11, weight: .semibold, design: .rounded))
            .foregroundStyle(SpottColor.muted)
            .frame(maxWidth: .infinity)
            .frame(height: 36)
            .spottGlassPanel(shape: Capsule(), interactive: false)
    }

    private var appleSignIn: some View {
        SignInWithAppleButton(.continue, onRequest: prepareAppleRequest, onCompletion: finishAppleSignIn)
            .signInWithAppleButtonStyle(.whiteOutline)
            .frame(height: 54)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .disabled(busy)
            .accessibilityIdentifier("auth.apple")
    }

    private var googleSignIn: some View {
        GoogleSignInButton(
            scheme: .light,
            style: .wide,
            state: busy ? .disabled : .normal,
            action: authenticateByGoogle
        )
        .frame(maxWidth: .infinity)
        .frame(height: 50)
        .accessibilityIdentifier("auth.google")
    }

    private var divider: some View {
        HStack(spacing: 12) {
            Rectangle().fill(SpottColor.divider).frame(height: 1)
            Text("或使用邮箱")
                .font(.system(size: 11, weight: .medium, design: .rounded))
                .foregroundStyle(SpottColor.muted)
                .fixedSize()
            Rectangle().fill(SpottColor.divider).frame(height: 1)
        }
    }

    private var emailSignIn: some View {
        VStack(alignment: .leading, spacing: 13) {
            field(
                icon: "envelope",
                placeholder: "you@example.jp",
                text: $email,
                field: .email,
                disabled: challenge != nil
            )
                .textContentType(.emailAddress)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)

            if let lockedEmail = challengeTarget.lockedValue {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("验证码已发送至")
                            .font(.caption)
                            .foregroundStyle(SpottColor.muted)
                        Text(lockedEmail)
                            .font(.subheadline.weight(.semibold))
                            .textSelection(.enabled)
                    }
                    Spacer()
                    Button("更换邮箱", action: changeEmail)
                        .font(.caption.weight(.semibold))
                        .disabled(busy)
                }
            }

            if challenge != nil {
                field(icon: "number", placeholder: "6 位验证码", text: $code, field: .code)
                    .keyboardType(.numberPad)
                    .textContentType(.oneTimeCode)
                    .transition(
                        reduceMotion
                            ? .opacity
                            : .move(edge: .top).combined(with: .opacity)
                    )
            }

            Button(action: authenticateByEmail) {
                HStack(spacing: 9) {
                    if busy { ProgressView().tint(.white) }
                    Text(emailActionTitle)
                }
            }
            .spottProminentActionStyle()
            .disabled(busy || !emailIsValid || (challenge != nil && code.count != 6))

#if DEBUG
            if let developmentCode = challenge?.developmentCode {
                Label("本地开发验证码：\(developmentCode)", systemImage: "hammer")
                    .font(.caption.monospaced())
                    .foregroundStyle(SpottColor.amber)
            }
#endif

            if let error {
                Label(error.message, systemImage: "exclamationmark.circle.fill")
                    .font(.system(size: 12.5, design: .rounded))
                    .foregroundStyle(SpottColor.danger)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(SpottColor.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
                    .accessibilityIdentifier("auth.error.\(error.id)")
            }
        }
        .animation(reduceMotion ? nil : .snappy, value: challenge != nil)
    }

    private func field(
        icon: String,
        placeholder: LocalizedStringKey,
        text: Binding<String>,
        field: Field,
        disabled: Bool = false
    ) -> some View {
        HStack(spacing: 11) {
            Image(systemName: icon)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(SpottColor.twilight)
                .frame(width: 20)
            TextField(placeholder, text: text)
                .font(.system(size: 15, weight: .medium, design: .rounded))
                .focused($focusedField, equals: field)
                .disabled(disabled)
        }
        .padding(.horizontal, 16)
        .frame(height: 52)
        .spottGlassPanel(shape: RoundedRectangle(cornerRadius: 17, style: .continuous))
    }

    private var privacyNote: some View {
        Text("继续即表示你同意服务条款与隐私政策。Spott 不会出售个人信息。")
            .font(.system(size: 10.5, design: .rounded))
            .foregroundStyle(SpottColor.muted)
            .frame(maxWidth: .infinity, alignment: .center)
            .multilineTextAlignment(.center)
    }

    private var emailActionTitle: LocalizedStringKey {
        challenge == nil ? "发送验证码" : "验证并继续"
    }

    private var emailIsValid: Bool {
        email.contains("@") && email.contains(".")
    }

    private func prepareAppleRequest(_ request: ASAuthorizationAppleIDRequest) {
        error = nil
        do {
            let nonce = try AppleSignInNonce.generate()
            currentAppleNonce = nonce
            request.requestedScopes = [.fullName, .email]
            request.nonce = AppleSignInNonce.sha256(nonce)
        } catch {
            currentAppleNonce = nil
            self.error = .init(id: "APPLE_NONCE_FAILED", message: "暂时无法启动 Apple 登录，请重试。", retryable: true)
        }
    }

    private func finishAppleSignIn(_ result: Result<ASAuthorization, Error>) {
        guard gateIsActive else { return }
        switch result {
        case .success(let authorization):
            guard
                let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                let tokenData = credential.identityToken,
                let identityToken = String(data: tokenData, encoding: .utf8),
                let nonce = currentAppleNonce
            else {
                error = .init(id: "APPLE_CREDENTIAL_INVALID", message: "Apple 没有返回有效登录凭证，请重试。", retryable: true)
                return
            }

            beginAuthenticationOperation { generation in
                do {
                    let session = try await model.api.authenticateApple(
                        identityToken: identityToken,
                        nonce: nonce,
                        deviceID: DeviceIdentity.current
                    )
                    guard operationIsCurrent(generation) else { return }
                    currentAppleNonce = nil
                    model.didAuthenticate(session)
                } catch is CancellationError {
                    return
                } catch {
                    guard operationIsCurrent(generation) else { return }
                    currentAppleNonce = nil
                    self.error = AppModel.map(error)
                }
            }

        case .failure(let authorizationError):
            if let appleError = authorizationError as? ASAuthorizationError, appleError.code == .canceled {
                return
            }
            error = AppModel.map(authorizationError)
        }
    }

    private func authenticateByEmail() {
        focusedField = nil
        error = nil
        let requestedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        let expectedChallenge = challenge
        guard challengeTarget.accepts(requestedEmail) else { return }
        beginAuthenticationOperation { generation in
            do {
                if let expectedChallenge {
                    let session = try await model.api.verifyEmail(
                        challengeID: expectedChallenge.challengeId,
                        code: code,
                        deviceID: DeviceIdentity.current
                    )
                    guard operationIsCurrent(generation) else { return }
                    model.didAuthenticate(session)
                } else {
                    let response = try await model.api.requestEmailCode(
                        email: requestedEmail,
                        deviceID: DeviceIdentity.current
                    )
                    guard operationIsCurrent(generation) else { return }
                    challenge = response
                    challengeTarget.lock(requestedEmail)
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

    private func authenticateByGoogle() {
        error = nil
        beginAuthenticationOperation { generation in
            do {
                let idToken = try await GoogleSignInManager.shared.signIn()
                guard operationIsCurrent(generation) else { return }
                let session = try await model.api.authenticateGoogle(
                    idToken: idToken,
                    deviceID: DeviceIdentity.current
                )
                guard operationIsCurrent(generation) else { return }
                model.didAuthenticate(session)
            } catch GoogleSignInManager.SignInError.cancelled {
                return
            } catch GoogleSignInManager.SignInError.notConfigured {
                guard operationIsCurrent(generation) else { return }
                self.error = .init(
                    id: "GOOGLE_AUTH_NOT_CONFIGURED",
                    message: "Google 登录尚未配置发布凭证，请使用 Apple 或邮箱继续。",
                    retryable: false
                )
            } catch is CancellationError {
                return
            } catch {
                guard operationIsCurrent(generation) else { return }
                self.error = AppModel.map(error)
            }
        }
    }

    private func changeEmail() {
        cancelPendingOperation()
        challenge = nil
        challengeTarget.reset()
        code = ""
        error = nil
        focusedField = .email
    }

    private func beginAuthenticationOperation(
        _ operation: @escaping @MainActor (Int) async -> Void
    ) {
        guard gateIsActive else { return }
        authenticationTask?.cancel()
        let generation = operationAuthority.begin()
        busy = true
        authenticationTask = Task { @MainActor in
            await operation(generation)
            guard operationIsCurrent(generation) else { return }
            busy = false
            authenticationTask = nil
        }
    }

    private func operationIsCurrent(_ generation: Int) -> Bool {
        operationAuthority.isCurrent(generation) && !Task.isCancelled
    }

    private func cancelPendingOperation() {
        operationAuthority.cancel()
        authenticationTask?.cancel()
        authenticationTask = nil
        currentAppleNonce = nil
        busy = false
    }
}

private struct PhoneVerificationView: View {
    @Environment(AppModel.self) private var model
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
        NavigationStack {
            ZStack {
                GateCanvas()
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        Image(systemName: "iphone.gen3.badge.checkmark")
                            .font(.system(size: 31, weight: .medium))
                            .foregroundStyle(SpottColor.twilight)
                            .frame(width: 62, height: 62)
                            .spottGlassPanel(shape: Circle(), interactive: false)

                        VStack(alignment: .leading, spacing: 9) {
                            Text("验证日本手机号")
                                .font(.system(size: 32, weight: .bold, design: .rounded))
                            Text("用于提高线下活动的信任与安全。号码会加密保存，其他用户无法看到。")
                                .font(.system(size: 15, design: .rounded))
                                .foregroundStyle(SpottColor.muted)
                                .lineSpacing(4)
                        }

                        glassField(
                            icon: "phone",
                            placeholder: "+81 90 1234 5678",
                            text: $phone,
                            field: .phone,
                            disabled: challenge != nil
                        )
                            .keyboardType(.phonePad)
                            .textContentType(.telephoneNumber)

                        if let lockedPhone = challengeTarget.lockedValue {
                            HStack(alignment: .firstTextBaseline, spacing: 10) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("验证码已发送至")
                                        .font(.caption)
                                        .foregroundStyle(SpottColor.muted)
                                    Text(lockedPhone)
                                        .font(.subheadline.weight(.semibold))
                                        .textSelection(.enabled)
                                }
                                Spacer()
                                Button("更换手机号", action: changePhone)
                                    .font(.caption.weight(.semibold))
                                    .disabled(busy)
                            }
                        }

                        if challenge != nil {
                            glassField(
                                icon: "number",
                                placeholder: "6 位验证码",
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
                            }
                        }
                        .spottProminentActionStyle()
                        .disabled(busy || normalizedPhone.count < 11 || (challenge != nil && code.count != 6))

                        Label("首次验证奖励 500 免费积分", systemImage: "sparkles")
                            .font(.system(size: 13, weight: .semibold, design: .rounded))
                            .foregroundStyle(SpottColor.mint)

#if DEBUG
                        if let developmentCode = challenge?.developmentCode {
                            Text("本地开发验证码：\(developmentCode)")
                                .font(.caption.monospaced())
                                .foregroundStyle(SpottColor.amber)
                        }
#endif
                        if let error {
                            Label(error.message, systemImage: "exclamationmark.circle.fill")
                                .font(.caption)
                                .foregroundStyle(SpottColor.danger)
                        }
                    }
                    .padding(24)
                }
            }
            .navigationTitle("安全验证")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") {
                        gateIsActive = false
                        cancelPendingOperation()
                        model.cancelPresentedGate()
                    }
                }
            }
            .animation(reduceMotion ? nil : .snappy, value: challenge != nil)
            .onAppear { gateIsActive = true }
            .onDisappear {
                gateIsActive = false
                cancelPendingOperation()
            }
        }
    }

    private func glassField(
        icon: String,
        placeholder: LocalizedStringKey,
        text: Binding<String>,
        field: Field,
        disabled: Bool = false
    ) -> some View {
        HStack(spacing: 11) {
            Image(systemName: icon)
                .foregroundStyle(SpottColor.twilight)
                .frame(width: 20)
            TextField(placeholder, text: text)
                .font(.system(size: 15, weight: .medium, design: .rounded))
                .focused($focusedField, equals: field)
                .disabled(disabled)
        }
        .padding(.horizontal, 16)
        .frame(height: 54)
        .spottGlassPanel(shape: RoundedRectangle(cornerRadius: 17, style: .continuous))
    }

    private var phoneActionTitle: LocalizedStringKey {
        challenge == nil ? "发送验证码" : "完成验证"
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

struct PermissionExplanationView: View {
    let icon: String
    let title: LocalizedStringKey
    let message: LocalizedStringKey
    let action: LocalizedStringKey
    let completion: () -> Void

    var body: some View {
        ZStack {
            GateCanvas()
            VStack(spacing: 22) {
                Spacer()
                Image(systemName: icon)
                    .font(.system(size: 32, weight: .medium))
                    .foregroundStyle(SpottColor.twilight)
                    .frame(width: 70, height: 70)
                    .spottGlassPanel(shape: Circle(), interactive: false)
                Text(title)
                    .font(.system(size: 29, weight: .bold, design: .rounded))
                    .multilineTextAlignment(.center)
                Text(message)
                    .font(.system(size: 15, design: .rounded))
                    .multilineTextAlignment(.center)
                    .foregroundStyle(SpottColor.muted)
                    .lineSpacing(4)
                Button(action: completion) { Text(action) }
                    .spottProminentActionStyle()
                Spacer()
            }
            .padding(28)
        }
    }
}

private struct GateCanvas: View {
    var body: some View {
        ZStack {
            SpottColor.canvas
            Circle()
                .fill(SpottColor.twilight.opacity(0.10))
                .frame(width: 280, height: 280)
                .blur(radius: 42)
                .offset(x: 150, y: -250)
            Circle()
                .fill(SpottColor.coral.opacity(0.07))
                .frame(width: 230, height: 230)
                .blur(radius: 46)
                .offset(x: -170, y: 300)
        }
        .ignoresSafeArea()
    }
}
