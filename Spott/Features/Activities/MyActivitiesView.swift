import SwiftUI

struct MyActivitiesView: View {
    @Environment(AppModel.self) private var model
    @State private var selection: ActivityScope = .upcoming
    @State private var items: [ActivityItem] = []
    @State private var loading = false
    @State private var error: UserFacingError?
    @State private var selectedCheckIn: ActivityItem?
    @State private var selectedFeedback: ActivityItem?
    @State private var selectedCorrection: ActivityItem?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                pageHeader
                if model.session == nil {
                    signedOutCard
                } else {
                    scopePicker
                    content
                }
            }
            .padding(.horizontal, SpottMetric.pageInset)
            .padding(.top, 18)
            .padding(.bottom, 34)
        }
        .background(SpottColor.canvas.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .task(id: model.session?.sessionId) { await load() }
        .refreshable { await load() }
        .sheet(item: $selectedCheckIn, onDismiss: { Task { await load() } }) { item in
            NavigationStack {
                ParticipantCheckInView(event: item.event, registration: item.registration)
            }
        }
        .sheet(item: $selectedFeedback, onDismiss: { Task { await load() } }) { item in
            FeedbackSubmissionView(event: item.event, registration: item.registration)
        }
        .sheet(item: $selectedCorrection, onDismiss: { Task { await load() } }) { item in
            CheckInCorrectionView(event: item.event, registration: item.registration)
        }
    }

    private var pageHeader: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("MY SPOTTS")
                .font(.system(size: 10.5, weight: .bold, design: .monospaced))
                .tracking(1.6)
                .foregroundStyle(SpottColor.coral)
            Text("你的行程")
                .font(.system(size: 34, weight: .bold, design: .rounded))
                .tracking(-1.2)
            Text("报名、候补、票码和活动变化会在 iOS 与 Web 实时同步。")
                .font(.system(size: 14.5, design: .rounded))
                .foregroundStyle(SpottColor.muted)
                .lineSpacing(3)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var signedOutCard: some View {
        VStack(alignment: .leading, spacing: 22) {
            HStack(alignment: .top) {
                Image(systemName: "calendar.badge.checkmark")
                    .font(.system(size: 25, weight: .medium))
                Spacer()
                Text("跨端同步")
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(Color.white.opacity(0.56), in: Capsule())
            }
            VStack(alignment: .leading, spacing: 7) {
                Text("登录后，现场不会手忙脚乱。")
                    .font(.system(size: 22, weight: .bold, design: .rounded))
                Text("票码、精确地址、候补确认和签到状态都只属于你的账号。")
                    .font(.subheadline)
                    .foregroundStyle(SpottColor.muted)
                    .lineSpacing(4)
            }
            Button("登录或注册") { model.presentedGate = .login }
                .buttonStyle(PrimaryButtonStyle())
        }
        .padding(22)
        .background(
            LinearGradient(
                colors: [Color(red: 0.93, green: 0.95, blue: 1), Color(red: 1, green: 0.93, blue: 0.91)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ),
            in: RoundedRectangle(cornerRadius: SpottMetric.coverRadius, style: .continuous)
        )
    }

    private var scopePicker: some View {
        HStack(spacing: 5) {
            ForEach(ActivityScope.allCases) { scope in
                Button {
                    withAnimation(.snappy(duration: 0.25)) { selection = scope }
                } label: {
                    Text(LocalizedStringKey(scope.title))
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .foregroundStyle(selection == scope ? SpottColor.ink : SpottColor.muted)
                        .frame(maxWidth: .infinity, minHeight: 38)
                        .background(selection == scope ? Color.white.opacity(0.72) : .clear, in: Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(4)
        .spottGlassPanel(shape: Capsule())
    }

    @ViewBuilder private var content: some View {
        if loading && items.isEmpty {
            VStack(spacing: 12) {
                ForEach(0..<2, id: \.self) { _ in ActivitySkeleton() }
            }
        } else if let error, items.isEmpty {
            SpottStateCard(
                icon: "wifi.exclamationmark",
                title: "暂时无法同步行程",
                message: "\(error.message)\n错误编号：\(error.id)",
                actionTitle: "重新连接"
            ) { Task { await load() } }
        } else if filteredItems.isEmpty {
            SpottStateCard(
                icon: selection == .past ? "clock.arrow.circlepath" : "calendar",
                title: selection.emptyTitle,
                message: selection.emptyMessage,
                actionTitle: selection == .upcoming ? "去发现活动" : nil
            ) {
                if selection == .upcoming { model.router.selectedTab = .discovery }
            }
        } else {
            ForEach(filteredItems) { item in
                ActivityCard(
                    item: item,
                    onOpen: { model.show(event: item.event) },
                    onCheckIn: { selectedCheckIn = item },
                    onFeedback: { selectedFeedback = item },
                    onCorrection: { selectedCorrection = item }
                ) {
                    await performPrimaryAction(item)
                }
            }
        }
    }

    private var filteredItems: [ActivityItem] {
        items.filter { selection.includes($0) }
    }

    private func load() async {
        guard model.session != nil else { items = []; return }
        loading = true
        error = nil
        do {
            let registrations = try await model.api.registrations().items
            var loaded: [ActivityItem] = []
            await withTaskGroup(of: ActivityItem?.self) { group in
                for registration in registrations {
                    group.addTask {
                        guard let event = try? await model.api.event(identifier: registration.eventId.uuidString.lowercased()) else { return nil }
                        return ActivityItem(registration: registration, event: event)
                    }
                }
                for await item in group {
                    if let item { loaded.append(item) }
                }
            }
            items = loaded.sorted { ($0.event.startsAt ?? .distantFuture) < ($1.event.startsAt ?? .distantFuture) }
        } catch {
            self.error = AppModel.map(error)
        }
        loading = false
    }

    private func performPrimaryAction(_ item: ActivityItem) async {
        do {
            if item.registration.status == "offered" {
                _ = try await model.api.acceptWaitlist(registrationID: item.registration.id)
            } else if ["pending", "confirmed", "waitlisted"].contains(item.registration.status) {
                _ = try await model.api.cancelRegistration(registrationID: item.registration.id)
            } else {
                model.show(event: item.event)
                return
            }
            await load()
        } catch {
            self.error = AppModel.map(error)
        }
    }
}

private enum ActivityScope: String, CaseIterable, Identifiable {
    case upcoming, pending, past
    var id: String { rawValue }
    var title: String { switch self { case .upcoming: "即将开始"; case .pending: "待确认"; case .past: "过去" } }
    var emptyTitle: String { switch self { case .upcoming: "下一次见面还没安排"; case .pending: "没有需要处理的报名"; case .past: "参加过的活动会留在这里" } }
    var emptyMessage: String { switch self { case .upcoming: "收藏不算行程，完成报名后活动会出现在这里。"; case .pending: "审核、候补和递补确认会集中显示。"; case .past: "签到后可以评价、领取到场积分并沉淀成就。" } }
    func includes(_ item: ActivityItem) -> Bool {
        let status = item.registration.status
        let ended = (item.event.endsAt ?? item.event.startsAt ?? .distantFuture) < .now
        switch self {
        case .upcoming: return !ended && ["confirmed", "checked_in"].contains(status)
        case .pending: return !ended && ["pending", "waitlisted", "offered"].contains(status)
        case .past: return ended || ["cancelled", "rejected", "event_cancelled", "no_show"].contains(status)
        }
    }
}

private struct ActivityItem: Identifiable, Sendable {
    let registration: Registration
    let event: EventSummary
    var id: UUID { registration.id }
}

private struct ActivityCard: View {
    let item: ActivityItem
    let onOpen: () -> Void
    let onCheckIn: () -> Void
    let onFeedback: () -> Void
    let onCorrection: () -> Void
    let onPrimary: () async -> Void
    @State private var busy = false

    var body: some View {
        VStack(spacing: 0) {
            Button(action: onOpen) {
                HStack(spacing: 15) {
                    ActivityCover(event: item.event)
                        .frame(width: 88, height: 100)
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(LocalizedStringKey(statusTitle))
                                .font(.system(size: 11.5, weight: .bold, design: .rounded))
                                .foregroundStyle(statusColor)
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(SpottColor.muted.opacity(0.65))
                        }
                        Text(item.event.title)
                            .font(.system(size: 17, weight: .bold, design: .rounded))
                            .foregroundStyle(SpottColor.ink)
                            .lineLimit(2)
                        Label(dateLabel, systemImage: "calendar")
                            .font(.system(size: 12, weight: .medium, design: .rounded))
                            .foregroundStyle(SpottColor.muted)
                            .lineLimit(1)
                    }
                }
                .padding(14)
            }
            .buttonStyle(.plain)

            Divider().padding(.horizontal, 14)

            HStack(spacing: 12) {
                if item.registration.status == "confirmed" {
                    Button(action: onCheckIn) {
                        Label("现场签到", systemImage: "qrcode.viewfinder")
                    }
                } else if item.registration.status == "checked_in" {
                    Label("已签到", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(SpottColor.mint)
                } else {
                    Label("\(item.registration.partySize) 人", systemImage: "person.2")
                        .foregroundStyle(SpottColor.muted)
                }
                Spacer()
                if feedbackAvailable {
                    Button("活动反馈", action: onFeedback)
                        .buttonStyle(.borderedProminent)
                        .tint(SpottColor.ink)
                } else if correctionAvailable {
                    Button("申请补签", action: onCorrection)
                        .buttonStyle(.bordered)
                } else {
                    Button(primaryTitle) {
                        busy = true
                        Task { await onPrimary(); busy = false }
                    }
                    .disabled(busy)
                }
            }
            .font(.system(size: 12.5, weight: .semibold, design: .rounded))
            .padding(.horizontal, 16)
            .frame(height: 48)
        }
        .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: SpottMetric.cardRadius).stroke(SpottColor.divider))
        .shadow(color: SpottColor.ink.opacity(0.055), radius: 18, y: 8)
    }

    private var statusTitle: String {
        switch item.registration.status {
        case "confirmed": "已确认"
        case "pending": "等待局头确认"
        case "waitlisted": "候补中"
        case "offered": "名额已为你保留"
        case "checked_in": "已签到"
        case "cancelled": "已取消"
        case "event_cancelled": "活动已取消"
        case "no_show": "未记录到场"
        case "correction_pending": "补签审核中"
        default: item.registration.status
        }
    }

    private var statusColor: Color {
        switch item.registration.status {
        case "confirmed", "checked_in": SpottColor.mint
        case "offered": SpottColor.coral
        case "pending", "waitlisted": SpottColor.amber
        default: SpottColor.muted
        }
    }

    private var primaryTitle: String {
        switch item.registration.status {
        case "offered": "确认名额"
        case "pending", "confirmed", "waitlisted": "取消"
        default: "查看详情"
        }
    }

    private var dateLabel: String {
        guard let date = item.event.startsAt else { return "时间待定" }
        return date.formatted(.dateTime.month().day().weekday().hour().minute())
    }

    private var hasEnded: Bool {
        (item.event.endsAt ?? item.event.startsAt ?? .distantFuture) < .now
    }

    private var feedbackAvailable: Bool {
        hasEnded && item.registration.status == "checked_in"
    }

    private var correctionAvailable: Bool {
        hasEnded && ["confirmed", "no_show", "attendance_disputed"].contains(item.registration.status)
    }
}

private struct FeedbackSubmissionView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let event: EventSummary
    let registration: Registration

    @State private var rating = 5
    @State private var tags = Set<FeedbackTag>()
    @State private var comment = ""
    @State private var visibility: FeedbackVisibility = .aggregateOnly
    @State private var busy = false
    @State private var receipt: FeedbackReceipt?
    @State private var error: UserFacingError?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if let receipt {
                        success(receipt)
                    } else {
                        VStack(alignment: .leading, spacing: 7) {
                            Text("活动反馈")
                                .font(.system(size: 31, weight: .bold, design: .rounded))
                            Text(event.title)
                                .font(.subheadline)
                                .foregroundStyle(SpottColor.muted)
                        }

                        feedbackSection(title: "这次见面整体如何？") {
                            HStack(spacing: 8) {
                                ForEach(1...5, id: \.self) { value in
                                    Button {
                                        rating = value
                                    } label: {
                                        Image(systemName: value <= rating ? "star.fill" : "star")
                                            .font(.system(size: 22, weight: .medium))
                                            .foregroundStyle(value <= rating ? SpottColor.amber : SpottColor.muted)
                                            .frame(maxWidth: .infinity, minHeight: 46)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }

                        feedbackSection(title: "哪些体验值得保留？") {
                            LazyVGrid(
                                columns: [GridItem(.adaptive(minimum: 132), spacing: 8)],
                                alignment: .leading,
                                spacing: 8
                            ) {
                                ForEach(FeedbackTag.allCases) { tag in
                                    Button {
                                        if tags.contains(tag) { tags.remove(tag) } else { tags.insert(tag) }
                                    } label: {
                                        Label(tag.title, systemImage: tags.contains(tag) ? "checkmark.circle.fill" : "circle")
                                            .font(.subheadline.weight(.semibold))
                                            .foregroundStyle(tags.contains(tag) ? SpottColor.twilight : SpottColor.ink)
                                            .padding(.horizontal, 12)
                                            .frame(minHeight: 38)
                                            .spottGlassPanel(
                                                shape: Capsule(),
                                                tint: tags.contains(tag) ? SpottColor.twilight.opacity(0.11) : .clear
                                            )
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }

                        feedbackSection(title: "给局头的改进建议") {
                            TextField("可选，最多 500 字", text: $comment, axis: .vertical)
                                .lineLimit(4...8)
                                .padding(14)
                                .background(Color.white.opacity(0.5), in: RoundedRectangle(cornerRadius: 16))
                                .onChange(of: comment) { _, value in
                                    if value.count > 500 { comment = String(value.prefix(500)) }
                                }
                        }

                        feedbackSection(title: "隐私方式") {
                            Picker("隐私方式", selection: $visibility) {
                                Text("仅局头可见").tag(FeedbackVisibility.private)
                                Text("匿名聚合").tag(FeedbackVisibility.aggregateOnly)
                            }
                            .pickerStyle(.segmented)
                            Text(visibility == .private
                                 ? "建议只会出现在局头的私密改进面板，不公开展示。"
                                 : "不会公开你的文字；仅当至少 5 人提交后，展示匿名标签比例。")
                                .font(.caption)
                                .foregroundStyle(SpottColor.muted)
                                .lineSpacing(3)
                        }

                        if let error {
                            Label("\(error.message)（\(error.id)）", systemImage: "exclamationmark.circle.fill")
                                .font(.caption)
                                .foregroundStyle(SpottColor.danger)
                        }

                        Button(action: submit) {
                            HStack {
                                if busy { ProgressView().tint(.white) }
                                Text(busy ? "正在提交…" : "提交反馈")
                            }
                            .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(PrimaryButtonStyle())
                        .disabled(busy)
                    }
                }
                .padding(SpottMetric.pageInset)
                .padding(.bottom, 24)
            }
            .background(SpottColor.canvas.ignoresSafeArea())
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
            }
        }
    }

    private func feedbackSection<Content: View>(
        title: LocalizedStringKey,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 13) {
            Text(title).font(.system(size: 17, weight: .bold, design: .rounded))
            content()
        }
        .padding(17)
        .spottGlassPanel(shape: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    private func success(_ receipt: FeedbackReceipt) -> some View {
        SpottStateCard(
            icon: "heart.text.clipboard.fill",
            title: "谢谢你的认真反馈",
            message: receipt.rewardPoints > 0
                ? "反馈已提交并进入隐私审核。你获得了 \(receipt.rewardPoints) 积分。"
                : "反馈已提交并进入隐私审核。每份反馈最多可修改一次。",
            actionTitle: "完成"
        ) { dismiss() }
    }

    private func submit() {
        busy = true
        error = nil
        Task { @MainActor in
            defer { busy = false }
            do {
                receipt = try await model.api.submitFeedback(
                    registrationID: registration.id,
                    payload: .init(
                        attendanceRating: rating,
                        tags: FeedbackTag.allCases.filter(tags.contains),
                        comment: comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : comment,
                        visibility: visibility
                    )
                )
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }
}

private struct CheckInCorrectionView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let event: EventSummary
    let registration: Registration

    @State private var reason = ""
    @State private var busy = false
    @State private var submitted = false
    @State private var error: UserFacingError?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if submitted {
                        SpottStateCard(
                            icon: "checkmark.seal.fill",
                            title: "补签申请已提交",
                            message: "局头确认后，到场状态和积分会自动在 iOS 与 Web 同步。",
                            actionTitle: "完成"
                        ) { dismiss() }
                    } else {
                        Text("申请补签")
                            .font(.system(size: 31, weight: .bold, design: .rounded))
                        Text(event.title)
                            .foregroundStyle(SpottColor.muted)
                        VStack(alignment: .leading, spacing: 12) {
                            Text("说明现场情况")
                                .font(.headline)
                            TextField("例如：已到场，但扫码时网络中断", text: $reason, axis: .vertical)
                                .lineLimit(5...10)
                                .padding(14)
                                .background(Color.white.opacity(0.52), in: RoundedRectangle(cornerRadius: 16))
                                .onChange(of: reason) { _, value in
                                    if value.count > 1_000 { reason = String(value.prefix(1_000)) }
                                }
                            Text("补签只在活动结束后 48 小时内开放，提交记录可审计。")
                                .font(.caption)
                                .foregroundStyle(SpottColor.muted)
                        }
                        .padding(17)
                        .spottGlassPanel(shape: RoundedRectangle(cornerRadius: 22, style: .continuous))
                        if let error {
                            Label("\(error.message)（\(error.id)）", systemImage: "exclamationmark.circle.fill")
                                .foregroundStyle(SpottColor.danger)
                        }
                        Button(action: submit) {
                            HStack {
                                if busy { ProgressView().tint(.white) }
                                Text(busy ? "正在提交…" : "提交补签申请")
                            }
                            .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(PrimaryButtonStyle())
                        .disabled(reason.trimmingCharacters(in: .whitespacesAndNewlines).count < 3 || busy)
                    }
                }
                .padding(SpottMetric.pageInset)
            }
            .background(SpottColor.canvas.ignoresSafeArea())
            .navigationTitle("签到纠错")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
        }
    }

    private func submit() {
        busy = true
        error = nil
        Task { @MainActor in
            defer { busy = false }
            do {
                _ = try await model.api.requestCheckInCorrection(
                    registrationID: registration.id,
                    reason: reason.trimmingCharacters(in: .whitespacesAndNewlines)
                )
                submitted = true
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }
}

private extension FeedbackTag {
    var title: LocalizedStringKey {
        switch self {
        case .friendly: "氛围友好"
        case .wellOrganized: "组织有序"
        case .clearInformation: "信息清楚"
        case .safe: "让人安心"
        case .wouldJoinAgain: "愿意再参加"
        }
    }
}

private struct ActivityCover: View {
    let event: EventSummary
    var body: some View {
        Group {
            if let url = event.coverURL {
                AsyncImage(url: url) { image in image.resizable().scaledToFill() } placeholder: { fallback }
            } else { fallback }
        }
        .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
    }

    private var fallback: some View {
        LinearGradient(
            colors: [Color(red: 0.13, green: 0.30, blue: 0.46), Color(red: 0.42, green: 0.35, blue: 0.82)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
        .overlay {
            Image(systemName: "calendar")
                .font(.system(size: 23, weight: .light))
                .foregroundStyle(.white.opacity(0.9))
        }
    }
}

private struct ActivitySkeleton: View {
    var body: some View {
        RoundedRectangle(cornerRadius: SpottMetric.cardRadius)
            .fill(Color.black.opacity(0.055))
            .frame(height: 168)
            .redacted(reason: .placeholder)
    }
}
