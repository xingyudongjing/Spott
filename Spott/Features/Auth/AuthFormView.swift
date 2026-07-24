import AuthenticationServices
import GoogleSignInSwift
import SwiftUI

struct AuthFormView: View {
    enum Layout {
        case sheet
        case fullscreen
    }

    enum AuthMode: String {
        case login
        case register
    }

    enum AuthMethod {
        case password
        case emailCode
    }

    enum AuthField: String, Hashable {
        case email
        case password
        case nickname
        case code
    }

    let layout: Layout
    var onFieldFocus: (() -> Void)?

    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage("spott.auth.completed-before") private var hasAuthenticatedBefore = false
    @AppStorage("spott.auth.last-mode") private var storedModeRaw = AuthMode.login.rawValue
    @FocusState private var focusedField: AuthField?
    @AccessibilityFocusState private var accessibilityErrorFocus: AuthField?
    @State private var didConfigureInitialMode = false
    @State private var mode: AuthMode = .login
    @State private var method: AuthMethod = .password
    @State private var email = ""
    @State private var password = ""
    @State private var nickname = ""
    @State private var code = ""
    @State private var showsPassword = false
    @State private var challenge: EmailChallenge?
    @State private var challengeTarget = AuthenticationChallengeTarget()
    @State private var currentAppleNonce: String?
    @State private var busy = false
    @State private var fieldErrors: [AuthField: String] = [:]
    @State private var formError: UserFacingError?
    @State private var throttleNotice: String?
    @State private var operationAuthority = AuthenticationGateOperationAuthority()
    @State private var authenticationTask: Task<Void, Never>?
    @State private var gateIsActive = true
    @State private var successPulse = false

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            if method == .password {
                modeToggle
            }
            fields
            noticeBanners
            primaryCTA
            dividerRow
            providerSection
            // Spec §7 ordering: the email-code method toggle sits BELOW the
            // providers so it never competes with Sign in with Apple.
            methodToggle
            footer
        }
        .animation(reduceMotion ? nil : SpottMotion.standard, value: mode)
        .animation(reduceMotion ? nil : SpottMotion.standard, value: method)
        .animation(reduceMotion ? nil : SpottMotion.standard, value: challenge != nil)
        .sensoryFeedback(.success, trigger: successPulse)
        .onChange(of: focusedField) { _, newValue in
            if newValue != nil { onFieldFocus?() }
        }
        .onChange(of: model.presentedGate) { oldValue, newValue in
            guard layout == .sheet, oldValue != nil, newValue == nil else { return }
            gateIsActive = false
            cancelPendingOperation()
        }
        .onAppear {
            gateIsActive = true
            configureInitialModeIfNeeded()
        }
        .onDisappear {
            gateIsActive = false
            cancelPendingOperation()
        }
    }

    private func text(_ key: String.LocalizationValue) -> String {
        AuthLocalization.text(key, locale: locale)
    }

    // MARK: - Mode & method switching

    private var modeToggle: some View {
        Picker(text("auth.header.title"), selection: modeSelection) {
            Text(text("auth.mode.login")).tag(AuthMode.login)
            Text(text("auth.mode.register")).tag(AuthMode.register)
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .disabled(busy)
        .accessibilityIdentifier("auth.mode")
    }

    private var modeSelection: Binding<AuthMode> {
        Binding(
            get: { mode },
            set: { switchMode(to: $0) }
        )
    }

    private func switchMode(to newMode: AuthMode) {
        guard mode != newMode else { return }
        cancelPendingOperation()
        mode = newMode
        storedModeRaw = newMode.rawValue
        clearErrors()
    }

    private func switchMethod(to newMethod: AuthMethod) {
        guard method != newMethod else { return }
        cancelPendingOperation()
        method = newMethod
        challenge = nil
        challengeTarget.reset()
        code = ""
        clearErrors()
    }

    private func configureInitialModeIfNeeded() {
        guard !didConfigureInitialMode else { return }
        didConfigureInitialMode = true
        mode = hasAuthenticatedBefore
            ? (AuthMode(rawValue: storedModeRaw) ?? .login)
            : .register
    }

    // MARK: - Fields

    @ViewBuilder
    private var fields: some View {
        VStack(alignment: .leading, spacing: 12) {
            emailField
            if method == .password {
                passwordField
                if mode == .register {
                    Text(text("auth.password.hint"))
                        .font(.caption)
                        .foregroundStyle(SpottColor.muted)
                    nicknameField
                }
            } else {
                otpSection
            }
        }
    }

    private var emailField: some View {
        fieldContainer(.email) {
            HStack(spacing: 11) {
                Image(systemName: "envelope")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(SpottColor.muted)
                    .frame(width: 20)
                    .accessibilityHidden(true)
                TextField(text("auth.field.email.placeholder"), text: $email)
                    .font(.body)
                    .textContentType(.username)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.next)
                    .onSubmit { advanceFromEmail() }
                    .focused($focusedField, equals: .email)
                    .disabled(method == .emailCode && challenge != nil)
                    .accessibilityLabel(text("auth.field.email"))
                    .accessibilityIdentifier("auth.email")
            }
        }
    }

    private var passwordField: some View {
        fieldContainer(.password) {
            HStack(spacing: 11) {
                Image(systemName: "lock")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(SpottColor.muted)
                    .frame(width: 20)
                    .accessibilityHidden(true)
                Group {
                    if showsPassword {
                        TextField(text("auth.field.password"), text: $password)
                    } else {
                        SecureField(text("auth.field.password"), text: $password)
                    }
                }
                .font(.body)
                .textContentType(mode == .login ? .password : .newPassword)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .onSubmit { submitPrimaryAction() }
                .focused($focusedField, equals: .password)
                .accessibilityLabel(text("auth.field.password"))
                .accessibilityIdentifier("auth.password")
                Button {
                    showsPassword.toggle()
                } label: {
                    Image(systemName: showsPassword ? "eye.slash" : "eye")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(SpottColor.muted)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(
                    showsPassword ? text("auth.password.hide") : text("auth.password.show")
                )
            }
        }
    }

    private var nicknameField: some View {
        fieldContainer(.nickname) {
            HStack(spacing: 11) {
                Image(systemName: "person")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(SpottColor.muted)
                    .frame(width: 20)
                    .accessibilityHidden(true)
                TextField(text("auth.field.nickname"), text: $nickname)
                    .font(.body)
                    .textContentType(.nickname)
                    .submitLabel(.go)
                    .onSubmit { submitPrimaryAction() }
                    .focused($focusedField, equals: .nickname)
                    .accessibilityLabel(text("auth.field.nickname"))
                    .accessibilityIdentifier("auth.nickname")
            }
        }
    }

    @ViewBuilder
    private var otpSection: some View {
        if let lockedEmail = challengeTarget.lockedValue {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(text("auth.otp.sent_to"))
                        .font(.caption)
                        .foregroundStyle(SpottColor.muted)
                    Text(lockedEmail)
                        .font(.subheadline.weight(.semibold))
                        .textSelection(.enabled)
                }
                Spacer()
                Button(text("auth.otp.change_email"), action: resetEmailChallenge)
                    .font(.caption.weight(.semibold))
                    .disabled(busy)
            }
        }

        if challenge != nil {
            fieldContainer(.code) {
                HStack(spacing: 11) {
                    Image(systemName: "number")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(SpottColor.muted)
                        .frame(width: 20)
                        .accessibilityHidden(true)
                    TextField(text("auth.otp.code_placeholder"), text: $code)
                        .font(.body)
                        .keyboardType(.numberPad)
                        .textContentType(.oneTimeCode)
                        .focused($focusedField, equals: .code)
                        .accessibilityLabel(text("auth.otp.code_placeholder"))
                        .accessibilityIdentifier("auth.code")
                }
            }
            .transition(
                reduceMotion
                    ? .opacity
                    : .move(edge: .top).combined(with: .opacity)
            )
        }

#if DEBUG
        if let developmentCode = challenge?.developmentCode {
            Label(
                AuthLocalization.format("auth.debug.code", locale: locale, developmentCode),
                systemImage: "hammer"
            )
            .font(.caption.monospaced())
            .foregroundStyle(SpottColor.amber)
        }
#endif
    }

    private func fieldContainer(
        _ field: AuthField,
        @ViewBuilder content: () -> some View
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            content()
                .padding(.horizontal, 14)
                .frame(minHeight: 52)
                .background(
                    Color(uiColor: .secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                )
                .overlay {
                    if fieldErrors[field] != nil {
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .stroke(SpottColor.danger, lineWidth: 1)
                    }
                }
            if let message = fieldErrors[field] {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(SpottColor.danger)
                    .accessibilityFocused($accessibilityErrorFocus, equals: field)
                    .accessibilityIdentifier("auth.field-error.\(field.rawValue)")
            }
        }
    }

    private func advanceFromEmail() {
        if method == .password {
            focusedField = .password
        } else if canSubmit {
            submitPrimaryAction()
        }
    }

    // MARK: - Notices

    @ViewBuilder
    private var noticeBanners: some View {
        if let throttleNotice {
            Label(throttleNotice, systemImage: "clock.badge.exclamationmark")
                .font(.footnote)
                .foregroundStyle(SpottColor.amber)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    SpottColor.amber.opacity(0.1),
                    in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                )
                .accessibilityIdentifier("auth.throttle")
        }
        if let formError {
            Label(formError.message, systemImage: "exclamationmark.circle.fill")
                .font(.footnote)
                .foregroundStyle(SpottColor.danger)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    SpottColor.danger.opacity(0.08),
                    in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                )
                .accessibilityIdentifier("auth.error.\(formError.id)")
        }
    }

    // MARK: - Primary CTA

    private var primaryCTA: some View {
        Button(action: submitPrimaryAction) {
            HStack(spacing: 9) {
                if busy { ProgressView().tint(.white) }
                Text(primaryTitle)
                    .font(.body.weight(.semibold))
            }
            .frame(maxWidth: .infinity, minHeight: 34)
        }
        .spottProminentActionStyle()
        .controlSize(.large)
        .disabled(busy || !canSubmit)
        .accessibilityIdentifier("auth.primary")
    }

    private var primaryTitle: String {
        switch method {
        case .password:
            return mode == .login ? text("auth.cta.login") : text("auth.cta.register")
        case .emailCode:
            return challenge == nil ? text("auth.cta.send_code") : text("auth.cta.verify_code")
        }
    }

    private var emailIsValid: Bool {
        let trimmed = email.trimmed
        return trimmed.contains("@") && trimmed.contains(".")
    }

    private var passwordMeetsPolicy: Bool {
        password.count >= 8
            && password.contains(where: \.isLetter)
            && password.contains(where: \.isNumber)
    }

    private var canSubmit: Bool {
        switch method {
        case .password:
            guard emailIsValid else { return false }
            return mode == .login ? !password.isEmpty : passwordMeetsPolicy
        case .emailCode:
            return challenge == nil ? emailIsValid : code.count == 6
        }
    }

    private func submitPrimaryAction() {
        guard canSubmit, !busy else { return }
        switch method {
        case .password: submitPassword()
        case .emailCode: submitEmailCode()
        }
    }

    // MARK: - Method toggle & providers

    private var methodToggle: some View {
        Button {
            switchMethod(to: method == .password ? .emailCode : .password)
        } label: {
            Text(
                method == .password
                    ? text("auth.method.email_code")
                    : text("auth.method.password")
            )
            .font(.footnote.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.plain)
        .foregroundStyle(SpottColor.twilight)
        .disabled(busy)
        .accessibilityIdentifier("auth.method-toggle")
    }

    private var dividerRow: some View {
        HStack(spacing: 12) {
            Rectangle().fill(SpottColor.divider).frame(height: 1)
            Text(text("auth.divider.or"))
                .font(.caption.weight(.medium))
                .foregroundStyle(SpottColor.muted)
                .fixedSize()
            Rectangle().fill(SpottColor.divider).frame(height: 1)
        }
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private var providerSection: some View {
        switch layout {
        case .sheet:
            HStack(spacing: 12) {
                appleButton(height: 44)
                googleButton(height: 44, style: .standard)
            }
        case .fullscreen:
            VStack(spacing: 12) {
                appleButton(height: 50)
                googleButton(height: 50, style: .wide)
            }
        }
    }

    private func appleButton(height: CGFloat) -> some View {
        SignInWithAppleButton(.continue, onRequest: prepareAppleRequest, onCompletion: finishAppleSignIn)
            .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
            .frame(maxWidth: .infinity)
            .frame(height: height)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .disabled(busy)
            .accessibilityIdentifier("auth.apple")
    }

    private func googleButton(height: CGFloat, style: GoogleSignInButtonStyle) -> some View {
        GoogleSignInButton(
            scheme: colorScheme == .dark ? .dark : .light,
            style: style,
            state: busy ? .disabled : .normal,
            action: authenticateByGoogle
        )
        .frame(maxWidth: .infinity)
        .frame(height: height)
        .accessibilityIdentifier("auth.google")
    }

    private var footer: some View {
        Text(text("auth.footer.terms"))
            .font(.caption2)
            .foregroundStyle(SpottColor.muted)
            .frame(maxWidth: .infinity, alignment: .center)
            .multilineTextAlignment(.center)
    }

    // MARK: - Password auth

    private func submitPassword() {
        focusedField = nil
        clearErrors()
        let requestedEmail = email.trimmed
        let requestedPassword = password
        let requestedNickname = nickname.trimmed.nilIfEmpty
        let requestedMode = mode
        beginAuthenticationOperation { generation in
            do {
                let session: UserSession
                if requestedMode == .login {
                    session = try await model.api.loginWithPassword(
                        email: requestedEmail,
                        password: requestedPassword
                    )
                } else {
                    session = try await model.api.registerWithPassword(
                        email: requestedEmail,
                        password: requestedPassword,
                        nickname: requestedNickname
                    )
                }
                guard operationIsCurrent(generation) else { return }
                completeAuthentication(session)
            } catch is CancellationError {
                return
            } catch {
                guard operationIsCurrent(generation) else { return }
                present(error)
            }
        }
    }

    // MARK: - Email OTP auth (existing flow, kept intact)

    private func submitEmailCode() {
        focusedField = nil
        clearErrors()
        let requestedEmail = email.trimmed
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
                    completeAuthentication(session)
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
                present(error)
            }
        }
    }

    private func resetEmailChallenge() {
        cancelPendingOperation()
        challenge = nil
        challengeTarget.reset()
        code = ""
        clearErrors()
        focusedField = .email
    }

    // MARK: - Apple

    private func prepareAppleRequest(_ request: ASAuthorizationAppleIDRequest) {
        clearErrors()
        do {
            let nonce = try AppleSignInNonce.generate()
            currentAppleNonce = nonce
            request.requestedScopes = [.fullName, .email]
            request.nonce = AppleSignInNonce.sha256(nonce)
        } catch {
            currentAppleNonce = nil
            formError = .init(
                id: "APPLE_NONCE_FAILED",
                message: text("auth.error.apple_nonce"),
                retryable: true
            )
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
                formError = .init(
                    id: "APPLE_CREDENTIAL_INVALID",
                    message: text("auth.error.apple_credential"),
                    retryable: true
                )
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
                    completeAuthentication(session)
                } catch is CancellationError {
                    return
                } catch {
                    guard operationIsCurrent(generation) else { return }
                    currentAppleNonce = nil
                    present(error)
                }
            }

        case .failure(let authorizationError):
            if let appleError = authorizationError as? ASAuthorizationError, appleError.code == .canceled {
                return
            }
            formError = AppModel.map(authorizationError)
        }
    }

    // MARK: - Google

    private func authenticateByGoogle() {
        clearErrors()
        beginAuthenticationOperation { generation in
            do {
                let idToken = try await GoogleSignInManager.shared.signIn()
                guard operationIsCurrent(generation) else { return }
                let session = try await model.api.authenticateGoogle(
                    idToken: idToken,
                    deviceID: DeviceIdentity.current
                )
                guard operationIsCurrent(generation) else { return }
                completeAuthentication(session)
            } catch GoogleSignInManager.SignInError.cancelled {
                return
            } catch GoogleSignInManager.SignInError.notConfigured {
                guard operationIsCurrent(generation) else { return }
                formError = .init(
                    id: "GOOGLE_AUTH_NOT_CONFIGURED",
                    message: text("auth.error.google_not_configured"),
                    retryable: false
                )
            } catch is CancellationError {
                return
            } catch {
                guard operationIsCurrent(generation) else { return }
                present(error)
            }
        }
    }

    // MARK: - Shared completion & errors

    private func completeAuthentication(_ session: UserSession) {
        successPulse.toggle()
        hasAuthenticatedBefore = true
        storedModeRaw = AuthMode.login.rawValue
        model.didAuthenticate(session)
    }

    private func clearErrors() {
        fieldErrors = [:]
        formError = nil
        throttleNotice = nil
    }

    private func present(_ error: Error) {
        guard let apiError = error as? APIError else {
            formError = AppModel.map(error)
            return
        }
        if !apiError.fieldErrors.isEmpty {
            var mapped: [AuthField: String] = [:]
            var unmappedMessages: [String] = []
            for fieldError in apiError.fieldErrors {
                if let field = authField(for: fieldError.field) {
                    if mapped[field] == nil { mapped[field] = fieldError.message }
                } else {
                    unmappedMessages.append(fieldError.message)
                }
            }
            fieldErrors = mapped
            if let message = unmappedMessages.first {
                formError = .init(id: apiError.code, message: message, retryable: apiError.retryable)
            }
            focusFirstFieldError()
            if !mapped.isEmpty || formError != nil { return }
        }
        switch apiError.code {
        case "INVALID_CREDENTIALS":
            formError = .init(
                id: apiError.code,
                message: text("auth.error.invalid_credentials"),
                retryable: true
            )
        case "EMAIL_ALREADY_REGISTERED":
            fieldErrors[.email] = text("auth.error.email_registered")
            focusFirstFieldError()
        case "OTP_RATE_LIMITED":
            throttleNotice = text("auth.error.rate_limited")
        default:
            if apiError.status == 429 {
                throttleNotice = text("auth.error.rate_limited")
            } else {
                formError = AppModel.map(apiError)
            }
        }
    }

    private func authField(for serverField: String) -> AuthField? {
        switch serverField.lowercased() {
        case "email": return .email
        case "password": return .password
        case "nickname", "displayname", "display_name": return .nickname
        case "code": return .code
        default: return nil
        }
    }

    private func focusFirstFieldError() {
        let order: [AuthField] = [.email, .password, .nickname, .code]
        guard let first = order.first(where: { fieldErrors[$0] != nil }) else { return }
        focusedField = first
        accessibilityErrorFocus = first
    }

    // MARK: - Operation lifecycle (generation-guarded, mirrors the gate policy)

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

#Preview("Sheet form") {
    ScrollView {
        AuthFormView(layout: .sheet)
            .padding(20)
    }
    .background(SpottColor.surface)
    .environment(AppModel.preview)
}

#Preview("Fullscreen form") {
    ScrollView {
        AuthFormView(layout: .fullscreen)
            .padding(20)
    }
    .background(SpottScreenBackground())
    .environment(AppModel.preview)
}
