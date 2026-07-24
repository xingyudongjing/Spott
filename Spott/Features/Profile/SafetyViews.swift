import SwiftUI

struct SafetyCenterView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        List {
            Section("见面前") {
                Label("优先选择公共场所", systemImage: "building.2")
                Label("不要预付来源不明的费用", systemImage: "yensign.trianglebadge.exclamationmark")
                Label("把行程分享给可信联系人", systemImage: "person.crop.circle.badge.checkmark")
            }
            Section("遇到问题") {
                NavigationLink("举报活动或用户") { SafetyReportView() }
                NavigationLink("查看拉黑名单") { BlockedUsersView() }
                NavigationLink("申诉与处理进度") { SafetyCasesView() }
            }
            if model.session == nil {
                Section {
                    Button("登录后使用安全支持") { model.presentedGate = .login }
                }
            }
        }
        .navigationTitle("帮助与安全")
    }
}

private struct SafetyCasesView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale
    @State private var cases: [SafetyCase] = []
    @State private var loading = true
    @State private var error: UserFacingError?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                if loading {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 100)
                } else if let error, cases.isEmpty {
                    SpottStateCard(
                        icon: "wifi.exclamationmark",
                        title: "暂时无法加载处理进度",
                        message: String(
                            format: SpottLocalization.text("%@\n错误编号：%@", locale: locale),
                            error.message,
                            error.id
                        ),
                        actionTitle: "重新连接"
                    ) { Task { await load() } }
                } else if cases.isEmpty {
                    SpottStateCard(
                        icon: "checkmark.shield",
                        title: "暂无安全处理记录",
                        message: "提交举报后，公开参考编号、处理时限与申诉状态会安全地显示在这里。",
                        actionTitle: nil
                    ) { }
                } else {
                    ForEach(cases) { item in
                        SafetyCaseCard(item: item) {
                            SafetyAppealView(item: item) { Task { await load() } }
                        }
                    }
                    if let error {
                        Label("\(error.message)（\(error.id)）", systemImage: "exclamationmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(SpottColor.danger)
                    }
                }
            }
            .padding(SpottMetric.pageInset)
        }
        .background(SpottColor.canvas.ignoresSafeArea())
        .navigationTitle("处理与申诉")
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        guard model.session != nil else {
            cases = []
            loading = false
            model.presentedGate = .login
            return
        }
        loading = true
        do {
            cases = try await model.api.safetyCases().items
            error = nil
        } catch {
            self.error = AppModel.map(error)
        }
        loading = false
    }
}

private struct SafetyCaseCard<Appeal: View>: View {
    let item: SafetyCase
    @ViewBuilder let appeal: () -> Appeal

    var body: some View {
        VStack(alignment: .leading, spacing: 15) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(item.reference)
                        .font(.system(size: 12, weight: .bold, design: .monospaced))
                        .textSelection(.enabled)
                    Text(item.relationship == "submitted" ? "我提交的举报" : "与我相关的处理")
                        .font(.caption)
                        .foregroundStyle(SpottColor.muted)
                }
                Spacer()
                Text(statusTitle)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(statusColor)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(statusColor.opacity(0.12), in: Capsule())
            }

            VStack(alignment: .leading, spacing: 8) {
                LabeledContent("问题类型", value: item.reason)
                LabeledContent("处理等级", value: item.severity.uppercased())
                if let decision = item.decision, !decision.isEmpty {
                    LabeledContent("处理决定", value: decision)
                }
                if let due = item.slaDueAt, !resolved {
                    LabeledContent("预计处理前", value: due.formatted(date: .abbreviated, time: .shortened))
                }
            }
            .font(.subheadline)

            if let existing = item.appeal {
                Label("申诉状态：\(existing.status)", systemImage: "arrow.triangle.2.circlepath.circle.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(SpottColor.twilight)
            } else if item.canAppeal {
                NavigationLink(destination: appeal) {
                    Label("对处理决定提出申诉", systemImage: "doc.text.magnifyingglass")
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.glass)
            }
        }
        .padding(17)
        .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(SpottColor.hairline))
        .shadow(color: SpottColor.ink.opacity(0.055), radius: 20, y: 8)
    }

    private var resolved: Bool {
        ["decided", "closed", "appealed"].contains(item.caseStatus ?? "")
    }

    private var statusTitle: LocalizedStringKey {
        switch item.caseStatus ?? item.status {
        case "open": "已受理"
        case "triaged", "investigating": "处理中"
        case "decided": "已决定"
        case "closed": "已结案"
        case "appealed": "申诉中"
        default: "状态更新"
        }
    }

    private var statusColor: Color {
        switch item.caseStatus ?? item.status {
        case "decided", "closed": SpottColor.mint
        case "appealed": SpottColor.twilight
        default: SpottColor.amber
        }
    }
}

private struct SafetyAppealView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    let item: SafetyCase
    let completion: () -> Void

    @State private var statement = ""
    @State private var busy = false
    @State private var submitted = false
    @State private var error: UserFacingError?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if submitted {
                    SpottStateCard(
                        icon: "checkmark.seal.fill",
                        title: "申诉已提交",
                        message: String(
                            format: SpottLocalization.text(
                                "参考编号：%@\n安全团队会保留原始处理记录并独立复核。",
                                locale: locale
                            ),
                            item.reference
                        ),
                        actionTitle: "完成"
                    ) {
                        completion()
                        dismiss()
                    }
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("说明你不同意决定的原因")
                            .font(.system(size: 25, weight: .bold, design: .rounded))
                        Text(item.reference)
                            .font(.caption.monospaced().weight(.semibold))
                            .foregroundStyle(SpottColor.muted)
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        TextField("请提供有助于复核的新信息", text: $statement, axis: .vertical)
                            .lineLimit(8...16)
                            .padding(14)
                            .background(Color.white.opacity(0.52), in: RoundedRectangle(cornerRadius: 16))
                            .onChange(of: statement) { _, value in
                                if value.count > 5_000 { statement = String(value.prefix(5_000)) }
                            }
                        Text("申诉不会删除原始举报或审计记录。每个处理决定仅受理一份有效申诉。")
                            .font(.caption)
                            .foregroundStyle(SpottColor.muted)
                            .lineSpacing(3)
                    }
                    .padding(17)
                    .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(SpottColor.hairline))
        .shadow(color: SpottColor.ink.opacity(0.055), radius: 20, y: 8)

                    if let error {
                        Label("\(error.message)（\(error.id)）", systemImage: "exclamationmark.circle.fill")
                            .foregroundStyle(SpottColor.danger)
                    }
                    Button(action: submit) {
                        HStack {
                            if busy { ProgressView().tint(.white) }
                            Text(busy ? "正在提交…" : "提交申诉")
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .spottProminentActionStyle()
                    .disabled(statement.trimmingCharacters(in: .whitespacesAndNewlines).count < 10 || busy)
                }
            }
            .padding(SpottMetric.pageInset)
        }
        .background(SpottColor.canvas.ignoresSafeArea())
        .navigationTitle("安全申诉")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func submit() {
        busy = true
        error = nil
        Task { @MainActor in
            defer { busy = false }
            do {
                _ = try await model.api.submitSafetyAppeal(
                    reference: item.reference,
                    statement: statement.trimmingCharacters(in: .whitespacesAndNewlines)
                )
                submitted = true
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }
}

struct SafetyReportTarget: Identifiable, Sendable {
    let type: SafetyTargetType
    let targetID: UUID
    let displayName: String
    var id: String { "\(type.rawValue):\(targetID.uuidString.lowercased())" }
}

struct SafetyReportView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    let target: SafetyReportTarget?
    @State private var targetType: SafetyTargetType
    @State private var targetIDText: String
    @State private var reason = ""
    @State private var details = ""
    @State private var busy = false
    @State private var receipt: SafetyReportReceipt?
    @State private var attempt: StableIdempotencyAttempt?
    @State private var error: UserFacingError?

    init(target: SafetyReportTarget? = nil) {
        self.target = target
        _targetType = State(initialValue: target?.type ?? .event)
        _targetIDText = State(initialValue: target?.targetID.uuidString.lowercased() ?? "")
    }

    var body: some View {
        Group {
            if let receipt {
                ScrollView {
                    SpottStateCard(
                        icon: "checkmark.shield.fill",
                        title: text("journey.safety.report_success"),
                        message: CoreJourneyLocalization.format(
                            "journey.safety.report_reference",
                            locale: locale,
                            receipt.reference
                        ),
                        actionTitle: text("journey.common.done")
                    ) { dismiss() }
                    .padding(SpottMetric.pageInset)
                }
                .background(SpottColor.canvas.ignoresSafeArea())
            } else {
                Form {
                    Section(text("journey.safety.target")) {
                        if let target {
                            LabeledContent(targetTypeText(target.type), value: target.displayName)
                        } else {
                            Picker(text("journey.safety.target_type"), selection: $targetType) {
                                ForEach(SafetyTargetType.allCases, id: \.self) { type in
                                    Text(targetTypeText(type)).tag(type)
                                }
                            }
                            TextField(text("journey.safety.target_id"), text: $targetIDText)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        }
                    }
                    Section(text("journey.safety.issue")) {
                        Picker(text("journey.safety.issue_type"), selection: $reason) {
                            Text(text("journey.safety.choose")).tag("")
                            Text(text("journey.safety.danger")).tag("danger")
                            Text(text("journey.safety.fraud")).tag("fraud")
                            Text(text("journey.safety.harassment")).tag("harassment")
                            Text(text("journey.safety.spam")).tag("spam")
                            Text(text("journey.safety.minor")).tag("minor_safety")
                        }
                        TextField(text("journey.safety.details"), text: $details, axis: .vertical)
                            .lineLimit(5...12)
                            .onChange(of: details) { _, value in
                                if value.count > 2_000 {
                                    details = String(value.prefix(2_000))
                                }
                            }
                    }
                    if error != nil {
                        Section(text("journey.safety.submit_failed")) {
                            Label(text("journey.safety.error"), systemImage: "exclamationmark.circle.fill")
                                .foregroundStyle(SpottColor.danger)
                        }
                    }
                    Section {
                        Button(action: submit) {
                            HStack {
                                if busy { ProgressView().tint(.white) }
                                Text(text(busy ? "journey.safety.submitting" : "journey.safety.submit"))
                            }
                        }
                        .spottProminentActionStyle()
                        .disabled(!canSubmit || busy)
                    } footer: {
                        Text(text("journey.safety.privacy"))
                    }
                }
            }
        }
        .navigationTitle(text("journey.safety.title"))
    }

    private var resolvedTargetID: UUID? { UUID(uuidString: targetIDText) }
    private var canSubmit: Bool { resolvedTargetID != nil && !reason.isEmpty && details.count >= 5 }

    private func submit() {
        guard model.session != nil else { model.presentedGate = .login; return }
        guard let targetID = resolvedTargetID else { return }
        let payload = SafetyReportPayload(
            targetType: targetType,
            targetId: targetID,
            reason: reason,
            details: details,
            evidenceAssetIds: []
        )
        guard let resolvedAttempt = try? StableIdempotencyAttempt.resolve(
            existing: attempt,
            payload: payload
        ) else {
            error = .init(
                id: "SAFETY_REPORT_ENCODING_FAILED",
                message: text("journey.safety.error"),
                retryable: true
            )
            return
        }
        attempt = resolvedAttempt
        busy = true
        error = nil
        Task { @MainActor in
            defer { busy = false }
            do {
                receipt = try await model.api.submitSafetyReport(
                    payload,
                    idempotencyKey: resolvedAttempt.idempotencyKey
                )
                attempt = nil
            } catch {
                self.error = .init(
                    id: (error as? APIError)?.code ?? "SAFETY_REPORT_FAILED",
                    message: text("journey.safety.error"),
                    retryable: true
                )
            }
        }
    }

    private func targetTypeText(_ type: SafetyTargetType) -> String {
        let key: String.LocalizationValue = switch type {
        case .event: "journey.safety.target.event"
        case .group: "journey.safety.target.group"
        case .user: "journey.safety.target.user"
        case .comment: "journey.safety.target.comment"
        case .announcement: "journey.safety.target.announcement"
        }
        return text(key)
    }

    private func text(_ key: String.LocalizationValue) -> String {
        CoreJourneyLocalization.text(key, locale: locale)
    }
}

struct BlockedUsersView: View {
    @Environment(AppModel.self) private var model
    @State private var users: [BlockedUser] = []
    @State private var loading = true
    @State private var error: UserFacingError?

    var body: some View {
        Group {
            if loading {
                ProgressView()
            } else if users.isEmpty {
                SpottStateCard(
                    icon: "person.slash",
                    title: "没有已拉黑用户",
                    message: "拉黑会同时取消互相关注，并阻止对方与你加入同一受控互动空间。",
                    actionTitle: nil
                ) { }
                .padding(SpottMetric.pageInset)
            } else {
                List {
                    ForEach(users) { user in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(user.nickname ?? "@\(user.publicHandle)")
                                .font(.headline)
                            Text("@\(user.publicHandle) · \(user.blockedAt.formatted(date: .abbreviated, time: .omitted))")
                                .font(.caption)
                                .foregroundStyle(SpottColor.muted)
                        }
                        .swipeActions {
                            Button("解除拉黑", role: .destructive) { unblock(user) }
                        }
                    }
                    if let error {
                        Label(error.message, systemImage: "exclamationmark.circle.fill")
                            .foregroundStyle(SpottColor.danger)
                    }
                }
                .scrollContentBackground(.hidden)
            }
        }
        .background(SpottColor.canvas.ignoresSafeArea())
        .navigationTitle("拉黑名单")
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        guard model.session != nil else {
            loading = false
            model.presentedGate = .login
            return
        }
        do {
            users = try await model.api.blockedUsers().items
            error = nil
        } catch {
            self.error = AppModel.map(error)
        }
        loading = false
    }

    private func unblock(_ user: BlockedUser) {
        Task { @MainActor in
            do {
                _ = try await model.api.setUserBlocked(user.userId, blocked: false)
                users.removeAll { $0.id == user.id }
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }
}

private extension SafetyTargetType {
    var displayTitle: LocalizedStringKey {
        switch self {
        case .event: "活动"
        case .group: "社群"
        case .user: "用户"
        case .comment: "评论"
        case .announcement: "公告"
        }
    }
}
