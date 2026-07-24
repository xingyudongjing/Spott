import AuthenticationServices
import GoogleSignInSwift
import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale
    @AppStorage("app.language") private var appLanguage = AppLanguage.system.rawValue
    @AppStorage("analytics.consent") private var analytics = false
    @AppStorage("privacy.lockScreenAddress") private var lockAddress = false
    @State private var normalNotifications = true
    @State private var emailNotifications = false
    @State private var quietStart = QuietHoursParsing.defaultStart
    @State private var quietEnd = QuietHoursParsing.defaultEnd
    @State private var loadingPreferences = false
    @State private var savingPreferences = false
    @State private var showDeletionConfirmation = false
    @State private var showRevokeConfirmation = false
    @State private var revokingSessions = false
    @State private var deletionSchedule: DeletionSchedule?
    @State private var error: UserFacingError?

    var body: some View {
        Form {
            Section(text("profile.settings.language")) {
                Picker(text("profile.settings.language_picker"), selection: $appLanguage) {
                    ForEach(AppLanguage.allCases) { language in
                        Text(LocalizedStringKey(language.title)).tag(language.rawValue)
                    }
                }
            }
            Section(text("profile.settings.notifications")) {
                Toggle(text("profile.settings.push_reminder"), isOn: normalNotificationBinding)
                    .disabled(model.session == nil || loadingPreferences || savingPreferences)
                Toggle(text("profile.settings.email_reminder"), isOn: emailNotificationBinding)
                    .disabled(model.session == nil || loadingPreferences || savingPreferences)
                Toggle(text("profile.settings.lockscreen_address"), isOn: $lockAddress)
                DatePicker(
                    text("profile.settings.quiet_start"),
                    selection: quietBoundBinding($quietStart),
                    displayedComponents: .hourAndMinute
                )
                .disabled(model.session == nil || loadingPreferences || savingPreferences)
                DatePicker(
                    text("profile.settings.quiet_end"),
                    selection: quietBoundBinding($quietEnd),
                    displayedComponents: .hourAndMinute
                )
                .disabled(model.session == nil || loadingPreferences || savingPreferences)
                Text(text("profile.settings.quiet_hint"))
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
                Text(text("profile.settings.critical_hint"))
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
                if model.session == nil {
                    Button(text("profile.settings.sync_after_login")) { model.presentedGate = .login }
                }
            }
            Section(text("profile.settings.privacy")) {
                Toggle(text("profile.settings.analytics"), isOn: $analytics)
                NavigationLink(text("profile.settings.privacy_summary")) { PrivacySummaryView() }
                if let deletionSchedule {
                    LabeledContent(text("profile.settings.deletion_date")) {
                        Text(deletionSchedule.executeAfter.formatted(date: .abbreviated, time: .shortened))
                    }
                    Button(text("profile.settings.deletion_cancel")) { cancelDeletion() }
                } else {
                    Button(text("profile.settings.deletion_request"), role: .destructive) {
                        if model.session == nil { model.presentedGate = .login }
                        else { showDeletionConfirmation = true }
                    }
                }
            }
            Section(text("profile.settings.account")) {
                NavigationLink(text("profile.settings.merge")) { AccountMergeView() }
                Text(text("profile.settings.merge_hint"))
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
                if model.session != nil {
                    Button(role: .destructive) {
                        showRevokeConfirmation = true
                    } label: {
                        HStack {
                            Text(text("profile.settings.revoke_all"))
                            if revokingSessions {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                    .disabled(revokingSessions)
                    .accessibilityIdentifier("settings.revoke-all-sessions")
                    Text(text("profile.settings.revoke_hint"))
                        .font(.caption)
                        .foregroundStyle(SpottColor.muted)
                }
            }
            if let error {
                Section(text("profile.settings.error_section")) {
                    Label(error.message, systemImage: "exclamationmark.circle.fill")
                        .foregroundStyle(SpottColor.danger)
                    if error.retryable {
                        Button(text("profile.settings.retry_sync")) { Task { await savePreferences() } }
                    }
                }
            }
#if DEBUG
            DeveloperServerSection()
#endif
        }
        .scrollContentBackground(.hidden)
        .background(SpottScreenBackground())
        .navigationTitle(Text(text("profile.settings.title")))
        .task(id: model.session?.sessionId) { await loadPreferences() }
        .onChange(of: appLanguage) { _, _ in
            guard model.session != nil else { return }
            Task { await savePreferences() }
        }
        .alert(text("profile.settings.deletion_confirm_title"), isPresented: $showDeletionConfirmation) {
            Button(text("profile.settings.deletion_confirm_action"), role: .destructive) { requestDeletion() }
            Button(text("profile.common.cancel"), role: .cancel) { }
        } message: {
            Text(text("profile.settings.deletion_confirm_message"))
        }
        .confirmationDialog(
            text("profile.settings.revoke_confirm_title"),
            isPresented: $showRevokeConfirmation,
            titleVisibility: .visible
        ) {
            Button(text("profile.settings.revoke_confirm_action"), role: .destructive) { revokeAllSessions() }
            Button(text("profile.common.cancel"), role: .cancel) { }
        } message: {
            Text(text("profile.settings.revoke_confirm_message"))
        }
    }

    private var normalNotificationBinding: Binding<Bool> {
        Binding(
            get: { normalNotifications },
            set: { value in
                normalNotifications = value
                Task { await savePreferences(requestSystemPermission: value) }
            }
        )
    }

    private var emailNotificationBinding: Binding<Bool> {
        Binding(
            get: { emailNotifications },
            set: { value in
                emailNotifications = value
                Task { await savePreferences() }
            }
        )
    }

    private func quietBoundBinding(_ source: Binding<Date>) -> Binding<Date> {
        Binding(
            get: { source.wrappedValue },
            set: { value in
                source.wrappedValue = value
                guard model.session != nil else { return }
                Task { await savePreferences() }
            }
        )
    }

    private func loadPreferences() async {
        guard model.session != nil else { return }
        loadingPreferences = true
        defer { loadingPreferences = false }
        do {
            let page = try await model.api.notificationPreferences()
            if let preference = page.items.first(where: { $0.type == "event.reminder" }) {
                normalNotifications = preference.push
                emailNotifications = preference.email
                if let range = QuietHoursParsing.parse(preference.quietHours) {
                    quietStart = range.start
                    quietEnd = range.end
                }
            }
        } catch {
            self.error = AppModel.map(error)
        }
    }

    private func savePreferences(requestSystemPermission: Bool = false) async {
        guard model.session != nil else { return }
        savingPreferences = true
        defer { savingPreferences = false }
        if requestSystemPermission {
            _ = try? await NotificationCenterManager.shared.requestAuthorization()
        }
        do {
            _ = try await model.api.updateNotificationPreference(
                type: "event.reminder",
                update: .init(
                    inApp: true,
                    push: normalNotifications,
                    email: emailNotifications,
                    quietStart: QuietHoursParsing.wireValue(quietStart),
                    quietEnd: QuietHoursParsing.wireValue(quietEnd),
                    locale: preferredLocale
                )
            )
            error = nil
        } catch {
            self.error = AppModel.map(error)
        }
    }

    private func revokeAllSessions() {
        guard model.session != nil, !revokingSessions else { return }
        revokingSessions = true
        Task { @MainActor in
            defer { revokingSessions = false }
            do {
                try await model.api.revokeAllSessions()
                error = nil
                model.signOut()
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }

    private func text(_ key: String.LocalizationValue) -> String {
        ProfileTabLocalization.text(key, locale: locale)
    }

    private var preferredLocale: String {
        switch AppLanguage(rawValue: appLanguage) ?? .system {
        case .simplifiedChinese: return "zh-Hans"
        case .japanese: return "ja"
        case .english: return "en"
        case .system:
            let language = Locale.preferredLanguages.first?.lowercased() ?? "en"
            if language.hasPrefix("zh") { return "zh-Hans" }
            if language.hasPrefix("ja") { return "ja" }
            return "en"
        }
    }

    private func requestDeletion() {
        Task { @MainActor in
            do {
                deletionSchedule = try await model.api.requestAccountDeletion()
                error = nil
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }

    private func cancelDeletion() {
        Task { @MainActor in
            do {
                _ = try await model.api.cancelAccountDeletion()
                deletionSchedule = nil
                error = nil
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }
}

enum QuietHoursParsing {
    static var defaultStart: Date { date(hour: 22, minute: 0) }
    static var defaultEnd: Date { date(hour: 8, minute: 0) }

    static func wireValue(_ date: Date) -> String {
        let components = Calendar.current.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", components.hour ?? 0, components.minute ?? 0)
    }

    static func parse(_ rangeText: String?) -> (start: Date, end: Date)? {
        guard let rangeText, !rangeText.isEmpty else { return nil }
        let trimmed = rangeText.trimmingCharacters(in: CharacterSet(charactersIn: "[]()"))
        let parts = trimmed
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "\" ")) }
        guard parts.count == 2,
              let startStamp = timestamp(parts[0]),
              let endStamp = timestamp(parts[1])
        else { return nil }
        var tokyo = Calendar(identifier: .gregorian)
        tokyo.timeZone = TimeZone(identifier: "Asia/Tokyo") ?? .current
        let startComponents = tokyo.dateComponents([.hour, .minute], from: startStamp)
        let endComponents = tokyo.dateComponents([.hour, .minute], from: endStamp)
        return (
            date(hour: startComponents.hour ?? 22, minute: startComponents.minute ?? 0),
            date(hour: endComponents.hour ?? 8, minute: endComponents.minute ?? 0)
        )
    }

    private static func timestamp(_ value: String) -> Date? {
        let formats = [
            "yyyy-MM-dd HH:mm:ssXXXXX",
            "yyyy-MM-dd HH:mm:ssX",
            "yyyy-MM-dd'T'HH:mm:ssXXXXX",
            "yyyy-MM-dd'T'HH:mm:ssX",
            "yyyy-MM-dd HH:mm:ss.SSSSSSXXXXX",
            "yyyy-MM-dd HH:mm:ss.SSSSSSX",
        ]
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        for format in formats {
            formatter.dateFormat = format
            if let date = formatter.date(from: value) { return date }
        }
        return nil
    }

    private static func date(hour: Int, minute: Int) -> Date {
        Calendar.current.date(
            bySettingHour: hour,
            minute: minute,
            second: 0,
            of: .now
        ) ?? .now
    }
}

private struct AccountMergeView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    @State private var email = ""
    @State private var code = ""
    @State private var emailChallenge: EmailChallenge?
    @State private var appleNonce: String?
    @State private var preview: AccountMergePreview?
    @State private var busy = false
    @State private var showCommitConfirmation = false
    @State private var error: UserFacingError?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("验证第二个账号")
                        .font(.system(size: 29, weight: .bold, design: .rounded))
                    Text("选择另一个已经存在的 Spott 登录身份。验证成功后会先展示活动、社群与积分影响，再由你最终确认。")
                        .font(.subheadline)
                        .foregroundStyle(SpottColor.muted)
                        .lineSpacing(4)
                }

                if let preview {
                    mergePreview(preview)
                } else {
                    credentialChoices
                }

                if let error {
                    Label("\(error.message)（\(error.id)）", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(SpottColor.danger)
                        .padding(13)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(SpottColor.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
                }
            }
            .padding(SpottMetric.pageInset)
        }
        .background(SpottColor.canvas.ignoresSafeArea())
        .navigationTitle("账号合并")
        .navigationBarTitleDisplayMode(.inline)
        .alert("确认合并两个账号？", isPresented: $showCommitConfirmation) {
            Button("确认合并", role: .destructive) { commit() }
            Button("取消", role: .cancel) { }
        } message: {
            Text("合并会在一个事务中迁移公开资料、活动、社群、积分与安全记录，并撤销来源账号会话。此操作不能自行撤销。")
        }
        .overlay {
            if busy {
                Color.white.opacity(0.45).ignoresSafeArea()
                ProgressView().controlSize(.large)
            }
        }
    }

    private var credentialChoices: some View {
        VStack(spacing: 14) {
            SignInWithAppleButton(.continue, onRequest: prepareAppleRequest, onCompletion: finishAppleVerification)
                .signInWithAppleButtonStyle(.black)
                .frame(height: 52)
                .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
                .disabled(busy)

            GoogleSignInButton(
                scheme: .light,
                style: .wide,
                state: busy ? .disabled : .normal,
                action: verifyGoogle
            )
            .frame(height: 50)

            HStack {
                Rectangle().fill(SpottColor.divider).frame(height: 1)
                Text("或验证另一个邮箱").font(.caption).foregroundStyle(SpottColor.muted)
                Rectangle().fill(SpottColor.divider).frame(height: 1)
            }

            TextField("另一个账号的邮箱", text: $email)
                .textContentType(.emailAddress)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .padding(.horizontal, 15)
                .padding(.vertical, 13)
                .frame(minHeight: 50)
                .background(
                    Color(uiColor: .secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 16, style: .continuous)
                )

            if emailChallenge != nil {
                TextField("6 位验证码", text: $code)
                    .keyboardType(.numberPad)
                    .textContentType(.oneTimeCode)
                    .padding(.horizontal, 15)
                    .padding(.vertical, 13)
                    .frame(minHeight: 50)
                    .background(
                        Color(uiColor: .secondarySystemGroupedBackground),
                        in: RoundedRectangle(cornerRadius: 16, style: .continuous)
                    )
            }

            Button(emailChallenge == nil ? "发送验证码" : "验证并预览合并") {
                verifyEmail()
            }
            .spottProminentActionStyle()
            .disabled(
                busy || !email.contains("@") ||
                (emailChallenge != nil && code.count != 6)
            )

#if DEBUG
            if let developmentCode = emailChallenge?.developmentCode {
                Label("本地开发验证码：\(developmentCode)", systemImage: "hammer")
                    .font(.caption.monospaced())
                    .foregroundStyle(SpottColor.amber)
            }
#endif
        }
        .padding(18)
        .mergePanelSurface()
    }

    private func mergePreview(_ value: AccountMergePreview) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("第二个账号已验证", systemImage: "checkmark.shield.fill")
                .font(.headline)
                .foregroundStyle(SpottColor.mint)

            HStack(spacing: 10) {
                ProfileStat(value: "\(value.impact.ownedEvents)", title: text("profile.merge.stat_events"))
                ProfileStat(value: "\(value.impact.ownedGroups)", title: text("profile.merge.stat_groups"))
                ProfileStat(
                    value: "\(value.impact.sourceWallet.paid + value.impact.sourceWallet.free)",
                    title: text("profile.merge.stat_points")
                )
            }

            if value.conflicts.isEmpty {
                Text("没有发现手机号、重复报名、重复社群成员或运营账号冲突。")
                    .font(.subheadline)
                    .foregroundStyle(SpottColor.muted)
                Button("确认合并") { showCommitConfirmation = true }
                    .spottProminentActionStyle()
                    .disabled(!value.canCommit || value.expiresAt <= .now)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Label("需要先解决以下冲突", systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(SpottColor.danger)
                    ForEach(value.conflicts, id: \.self) { conflict in
                        Text("• \(conflictTitle(conflict))")
                    }
                }
                .font(.subheadline)
                Button("重新验证其他账号") {
                    preview = nil
                    emailChallenge = nil
                    code = ""
                }
                .buttonStyle(.glass)
            }
            Text("验证证明于 \(value.expiresAt.formatted(date: .omitted, time: .shortened)) 失效。")
                .font(.caption)
                .foregroundStyle(SpottColor.muted)
        }
        .padding(18)
        .mergePanelSurface()
    }

    private func prepareAppleRequest(_ request: ASAuthorizationAppleIDRequest) {
        do {
            let nonce = try AppleSignInNonce.generate()
            appleNonce = nonce
            request.nonce = AppleSignInNonce.sha256(nonce)
            request.requestedScopes = []
        } catch {
            self.error = AppModel.map(error)
        }
    }

    private func finishAppleVerification(_ result: Result<ASAuthorization, Error>) {
        guard case .success(let authorization) = result,
              let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = credential.identityToken,
              let identityToken = String(data: tokenData, encoding: .utf8),
              let nonce = appleNonce
        else {
            if case .failure(let failure) = result,
               (failure as? ASAuthorizationError)?.code == .canceled { return }
            error = .init(
                id: "APPLE_CREDENTIAL_INVALID",
                message: text("profile.merge.apple_credential_invalid"),
                retryable: true
            )
            return
        }
        createPreview(.apple(identityToken: identityToken, nonce: nonce, platform: "ios"))
    }

    private func verifyGoogle() {
        busy = true
        error = nil
        Task { @MainActor in
            defer { busy = false }
            do {
                let token = try await GoogleSignInManager.shared.signIn()
                preview = try await model.api.previewAccountMerge(credential: .google(idToken: token))
            } catch GoogleSignInManager.SignInError.cancelled {
                return
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }

    private func verifyEmail() {
        busy = true
        error = nil
        Task { @MainActor in
            defer { busy = false }
            do {
                if let emailChallenge {
                    preview = try await model.api.previewAccountMerge(
                        credential: .email(challengeId: emailChallenge.challengeId, code: code)
                    )
                } else {
                    let response = try await model.api.requestEmailCode(
                        email: email.trimmingCharacters(in: .whitespacesAndNewlines),
                        deviceID: DeviceIdentity.current
                    )
                    emailChallenge = response
#if DEBUG
                    if let developmentCode = response.developmentCode {
                        code = developmentCode
                    }
#endif
                }
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }

    private func createPreview(_ credential: AccountMergeCredential) {
        busy = true
        error = nil
        Task { @MainActor in
            defer { busy = false; appleNonce = nil }
            do {
                preview = try await model.api.previewAccountMerge(credential: credential)
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }

    private func commit() {
        guard let preview else { return }
        busy = true
        error = nil
        Task { @MainActor in
            defer { busy = false }
            do {
                let session = try await model.api.commitAccountMerge(preview)
                model.didAuthenticate(session)
                dismiss()
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }

    private func conflictTitle(_ code: String) -> String {
        switch code {
        case "phoneBinding": text("profile.merge.conflict.phone")
        case "eventRegistration": text("profile.merge.conflict.event")
        case "groupMembership": text("profile.merge.conflict.group")
        case "operatorAccount": text("profile.merge.conflict.operator")
        default: code
        }
    }

    private func text(_ key: String.LocalizationValue) -> String {
        ProfileTabLocalization.text(key, locale: locale)
    }
}

private extension View {
    /// Content-layer panel (红线2): the merge form and preview are text/content
    /// blocks, so they sit on a solid surface card instead of glass.
    func mergePanelSurface() -> some View {
        self
            .background(
                SpottColor.surface,
                in: RoundedRectangle(cornerRadius: 24, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .stroke(SpottColor.hairline)
            )
            .shadow(color: SpottColor.ink.opacity(0.055), radius: 20, y: 8)
    }
}

private struct PrivacySummaryView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("隐私不是一句口号").font(.largeTitle.bold())
                Text("Spott 只在完成报名、签到、安全和跨端同步所必需的范围内处理数据。精确地址只向有资格的已确认参与者披露，并禁止进入公开缓存。")
                Text("你可以管理公开资料、通知、分析授权、拉黑名单和账号注销。注销申请有 14 天冷静期。")
            }
            .padding(SpottMetric.pageInset)
        }
        .navigationTitle("数据与隐私")
    }
}

#if DEBUG
// Developer-only: choose which API server this build talks to (applies after relaunch).
// Enables real-device testing against the Mac's LAN IP without rebuilding.
private struct DeveloperServerSection: View {
    @State private var customURL: String = UserDefaults.standard
        .string(forKey: APIEnvironment.overrideDefaultsKey) ?? ""
    @State private var applied = false

    private var currentBase: String {
        ProcessInfo.processInfo.environment["SPOTT_API_BASE_URL"]
            ?? UserDefaults.standard.string(forKey: APIEnvironment.overrideDefaultsKey)
            ?? "http://127.0.0.1:4100/v1"
    }

    var body: some View {
        Section {
            LabeledContent("当前服务器") {
                Text(currentBase)
                    .font(.caption.monospaced())
                    .foregroundStyle(SpottColor.muted)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            TextField("http://192.168.x.x:4100/v1", text: $customURL)
                .font(.caption.monospaced())
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("保存并在重启后生效") {
                let trimmed = customURL.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed.isEmpty {
                    UserDefaults.standard.removeObject(forKey: APIEnvironment.overrideDefaultsKey)
                    applied = true
                } else if let url = URL(string: trimmed), url.scheme != nil, url.host() != nil {
                    UserDefaults.standard.set(trimmed, forKey: APIEnvironment.overrideDefaultsKey)
                    applied = true
                } else {
                    applied = false
                }
            }
            .disabled({
                let trimmed = customURL.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed.isEmpty { return false }
                guard let url = URL(string: trimmed) else { return true }
                return url.scheme == nil || url.host() == nil
            }())
            if applied {
                Label("已保存。彻底退出并重新打开 App 后生效。", systemImage: "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(SpottColor.mint)
            }
            Text("仅开发版可见。留空并保存即恢复默认（模拟器连本机 127.0.0.1；真机可填 Mac 的局域网 IP，如 http://192.168.102.109:4100/v1）。")
                .font(.caption2)
                .foregroundStyle(SpottColor.muted)
        } header: {
            Label("开发者 · 服务器", systemImage: "hammer")
        }
    }
}
#endif
