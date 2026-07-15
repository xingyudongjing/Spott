import EventKit
import SwiftUI
import UIKit

struct EventDetailView: View {
    @Environment(AppModel.self) private var model
    private let sourceTab: AppTab
    private let refreshOnAppear: Bool
    @State private var detail: EventSummary
    @State private var registrationPresented = false
    @State private var registrationDraft = DeferredRegistrationDraft()
    @State private var favorited: Bool
    @State private var notice: String?
    @State private var busy = false
    @State private var reportTarget: SafetyReportTarget?
    @State private var showBlockConfirmation = false
    @State private var checkInRegistration: Registration?
    @State private var feedbackSummary: FeedbackSummary?
    @State private var shareItem: EventShareItem?
    @State private var posterPresented = false

    init(event: EventSummary, sourceTab: AppTab, refreshOnAppear: Bool = true) {
        self.sourceTab = sourceTab
        self.refreshOnAppear = refreshOnAppear
        _detail = State(initialValue: event)
        _favorited = State(initialValue: event.favorited)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                EventHero(event: detail)
                VStack(alignment: .leading, spacing: 24) {
                    titleBlock
                    essentialFacts
                    quickActions
                    if detail.fee?.isFree == false, let fee = detail.fee { FeeBoundaryCard(fee: fee) }
                    aboutSection
                    if let requirements = detail.attendeeRequirements, !requirements.isEmpty { requirementsSection(requirements) }
                    NavigationLink {
                        PublicProfileView(identifier: detail.organizerId.uuidString.lowercased())
                    } label: {
                        OrganizerCard(event: detail)
                    }
                    .buttonStyle(.plain)
                    if let feedbackSummary { EventFeedbackSummaryCard(summary: feedbackSummary) }
                    if !detail.riskFlags.orEmpty.isEmpty { RiskDisclosure(flags: detail.riskFlags.orEmpty) }
                    SafetyNote()
                    if let notice {
                        Label(notice, systemImage: "checkmark.circle.fill")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(SpottColor.mint)
                    }
                }
                .padding(.horizontal, SpottMetric.pageInset)
                .padding(.top, 22)
                .padding(.bottom, 116)
            }
        }
        .background(SpottColor.canvas.ignoresSafeArea())
        .ignoresSafeArea(edges: .top)
        .safeAreaInset(edge: .bottom, spacing: 0) { actionBar }
        .toolbar(.hidden, for: .tabBar)
        .toolbarBackground(.hidden, for: .navigationBar)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { prepareShare() } label: { Image(systemName: "square.and.arrow.up") }
                    .accessibilityLabel("分享")
                Button { toggleFavorite() } label: { Image(systemName: favorited ? "heart.fill" : "heart") }
                    .accessibilityLabel("收藏")
                Menu {
                    if model.session?.user.id == detail.organizerId {
                        Button {
                            posterPresented = true
                        } label: {
                            Label("生成分享海报", systemImage: "rectangle.portrait.on.rectangle.portrait")
                        }
                        Divider()
                    }
                    Button {
                        reportTarget = .init(type: .event, targetID: detail.id, displayName: detail.title)
                    } label: {
                        Label("举报活动", systemImage: "exclamationmark.bubble")
                    }
                    if model.session?.user.id != detail.organizerId {
                        Button {
                            reportTarget = .init(
                                type: .user,
                                targetID: detail.organizerId,
                                displayName: detail.organizerName ?? "@\(detail.organizerHandle ?? String(detail.organizerId.uuidString.prefix(8)))"
                            )
                        } label: {
                            Label("举报主办方", systemImage: "person.crop.circle.badge.exclamationmark")
                        }
                        Button(role: .destructive) { showBlockConfirmation = true } label: {
                            Label("拉黑主办方", systemImage: "person.slash")
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis")
                }
                .accessibilityLabel("更多操作")
            }
        }
        .sheet(isPresented: $registrationPresented) {
            RegistrationSheet(event: detail, draft: registrationDraft) { registration in
                detail.registrationStatus = registration.status
                detail.availableActions = registration.availableActions ?? [.cancelRegistration, .viewTicket]
                notice = registration.status == "waitlisted" ? "已加入候补。" : "报名成功，已同步到你的行程。"
            }
        }
        .sheet(item: $checkInRegistration) { registration in
            NavigationStack {
                ParticipantCheckInView(event: detail, registration: registration)
            }
        }
        .sheet(item: $reportTarget) { target in
            NavigationStack {
                SafetyReportView(target: target)
            }
        }
        .sheet(item: $shareItem) { item in
            ShareActivityView(items: [item.url])
                .presentationDetents([.medium])
        }
        .sheet(isPresented: $posterPresented) {
            NavigationStack {
                PosterGeneratorView(resourceType: "event", resourceID: detail.id, title: detail.title)
            }
        }
        .alert("拉黑这位主办方？", isPresented: $showBlockConfirmation) {
            Button("拉黑", role: .destructive) { blockOrganizer() }
            Button("取消", role: .cancel) { }
        } message: {
            Text("拉黑会取消互相关注，并限制你们进入同一受控互动空间。")
        }
        .task {
            if model.usesNavigationUITestFixture { return }
            model.trackAnalytics(.eventDetailViewed(
                eventID: detail.id,
                publicSlug: detail.publicSlug,
                category: detail.tags.first
            ))
            async let feedbackRequest = try? model.api.feedbackSummary(eventID: detail.id)
            if refreshOnAppear,
               let current = try? await model.api.event(identifier: detail.publicSlug) {
                detail = current
                favorited = current.favorited
            }
            feedbackSummary = await feedbackRequest
        }
        .task(id: model.router.pendingRegistrationPresentation?.id) {
            let reference = EventRouteReference(event: detail)
            guard let intent = model.router.takeRegistrationPresentation(
                for: reference,
                in: sourceTab
            ) else { return }
            registrationDraft = intent.draft
            registrationPresented = true
        }
    }

    private var titleBlock: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(statusTitle)
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .foregroundStyle(statusColor)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(statusColor.opacity(0.11), in: Capsule())
                Spacer()
                Text(detail.priceLabel)
                    .font(.system(size: 13, weight: .bold, design: .rounded))
            }
            Text(detail.title)
                .font(.system(size: 31, weight: .bold, design: .rounded))
                .tracking(-1)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("event.detail.title")
            if !detail.tags.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 7) {
                        ForEach(detail.tags, id: \.self) { tag in
                            Text(displayTag(tag))
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(SpottColor.muted)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 7)
                                .spottGlassPanel(shape: Capsule())
                        }
                    }
                }
            }
        }
    }

    private var essentialFacts: some View {
        VStack(spacing: 0) {
            DetailFact(icon: "calendar", title: "时间", value: detail.startsAt?.formatted(.dateTime.month(.wide).day().weekday().hour().minute()) ?? "时间待定")
            Divider().padding(.leading, 47)
            DetailFact(icon: "mappin.and.ellipse", title: "集合范围", value: detail.publicArea ?? "")
            if let exact = detail.exactAddress, !exact.isEmpty {
                Divider().padding(.leading, 47)
                DetailFact(icon: "lock.open", title: "精确地址", value: exact)
            }
            Divider().padding(.leading, 47)
            DetailFact(icon: "person.2", title: "名额", value: "\(detail.confirmedCount) / \(detail.capacity) · 余 \(detail.remaining)")
            Divider().padding(.leading, 47)
            DetailFact(icon: "yensign.circle", title: "费用", value: detail.priceLabel)
        }
        .padding(.horizontal, 14)
        .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: SpottMetric.cardRadius).stroke(SpottColor.divider))
    }

    private var quickActions: some View {
        HStack(spacing: 10) {
            DetailQuickAction(icon: "calendar.badge.plus", title: "加日历") { addToCalendar() }
            DetailQuickAction(icon: "map", title: "路线") { openMaps() }
            Button { prepareShare() } label: {
                VStack(spacing: 7) {
                    Image(systemName: "square.and.arrow.up").font(.system(size: 17, weight: .semibold))
                    Text("分享").font(.caption.weight(.semibold))
                }
                .foregroundStyle(SpottColor.ink)
                .frame(maxWidth: .infinity, minHeight: 68)
                .spottGlassPanel(shape: RoundedRectangle(cornerRadius: 18))
            }
            .buttonStyle(.plain)
        }
    }

    private var aboutSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("关于这次活动").font(.system(size: 21, weight: .bold, design: .rounded))
            Text(detail.description)
                .font(.body)
                .foregroundStyle(SpottColor.ink.opacity(0.88))
                .lineSpacing(6)
        }
    }

    private func requirementsSection(_ value: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("参与要求").font(.system(size: 19, weight: .bold, design: .rounded))
            Text(value).font(.body).lineSpacing(5)
        }
        .padding(17)
        .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: SpottMetric.cardRadius))
    }

    private var actionBar: some View {
        HStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 2) {
                Text(detail.priceLabel).font(.system(size: 15, weight: .bold, design: .rounded))
                Text(detail.remaining > 0 ? "还剩 \(detail.remaining) 个名额" : "当前可加入候补")
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
            }
            Spacer()
            if let action = primaryAction {
                Button(actionTitle(action)) { perform(action) }
                    .font(.system(size: 14.5, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 20)
                    .frame(minHeight: 48)
                    .background(SpottColor.ink, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                    .disabled(busy)
            } else {
                Text("当前不可操作").font(.subheadline).foregroundStyle(SpottColor.muted)
            }
        }
        .padding(.horizontal, 17)
        .padding(.vertical, 11)
        .spottGlassPanel(shape: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .padding(.horizontal, 12)
        .padding(.bottom, 5)
    }

    private var primaryAction: EventAction? {
        let priority: [EventAction] = [.register, .joinWaitlist, .viewTicket, .checkIn, .cancelRegistration, .edit, .appeal]
        return priority.first { detail.availableActions.contains($0) }
    }

    private var statusTitle: String {
        switch detail.status {
        case "published": "报名开放"
        case "registration_closed": "报名已截止"
        case "in_progress": "活动进行中"
        case "ended": "活动已结束"
        case "cancelled": "活动已取消"
        case "under_review": "审核中"
        default: detail.status
        }
    }
    private var statusColor: Color { ["published", "in_progress"].contains(detail.status) ? SpottColor.mint : detail.status == "cancelled" ? SpottColor.danger : SpottColor.amber }

    private func actionTitle(_ action: EventAction) -> String {
        switch action {
        case .register: "报名参加"
        case .joinWaitlist: "加入候补"
        case .cancelRegistration: "取消报名"
        case .viewTicket: "查看票码"
        case .checkIn: "现场签到"
        case .edit: "编辑活动"
        case .cancelEvent: "取消活动"
        case .appeal: "提交申诉"
        case .joinGroup: "加入社群"
        case .submit: "提交审核"
        }
    }

    private func perform(_ action: EventAction) {
        model.requireTrust(for: action, event: detail) {
            switch action {
            case .register, .joinWaitlist:
                registrationDraft = .init()
                registrationPresented = true
            case .viewTicket: model.router.selectedTab = .activities
            case .checkIn: openCheckIn()
            case .cancelRegistration: cancelRegistration()
            case .joinGroup:
                if let id = detail.groupId { model.router.push(.group(id)) }
            default: notice = "操作入口已准备。"
            }
        }
    }

    private func openCheckIn() {
        busy = true
        Task { @MainActor in
            defer { busy = false }
            do {
                let registrations = try await model.api.registrations().items
                guard let registration = registrations.first(where: { $0.eventId == detail.id }) else {
                    throw APIError(
                        status: 404,
                        code: "REGISTRATION_NOT_FOUND",
                        message: "没有找到可签到的报名记录。",
                        retryable: false
                    )
                }
                checkInRegistration = registration
            } catch {
                model.banner = .init(title: AppModel.map(error).message, tone: .warning)
            }
        }
    }

    private func blockOrganizer() {
        guard model.session != nil else { model.presentedGate = .login; return }
        busy = true
        Task { @MainActor in
            defer { busy = false }
            do {
                _ = try await model.api.setUserBlocked(detail.organizerId, blocked: true, reason: "event_safety")
                notice = "已拉黑主办方。你们的关注关系和受控互动已断开。"
            } catch {
                notice = AppModel.map(error).message
            }
        }
    }

    private func prepareShare() {
        Task { @MainActor in
            if model.session != nil,
               let receipt = try? await model.api.createShareLink(
                   resourceType: "event",
                   resourceID: detail.id,
                   campaign: "ios_event_detail"
               ) {
                shareItem = .init(url: receipt.url)
            } else {
                shareItem = .init(url: URL(string: "https://spott.jp/e/\(detail.publicSlug)")!)
            }
        }
    }

    private func toggleFavorite() {
        guard model.session != nil else { model.presentedGate = .login; return }
        let target = !favorited
        favorited = target
        Task {
            do { try await model.api.setFavorite(eventID: detail.id, enabled: target) }
            catch { favorited.toggle(); model.banner = .init(title: AppModel.map(error).message, tone: .warning) }
        }
    }

    private func cancelRegistration() {
        busy = true
        Task {
            do {
                let registrations = try await model.api.registrations().items
                guard let registration = registrations.first(where: { $0.eventId == detail.id }) else { throw APIError(status: 404, code: "REGISTRATION_NOT_FOUND", message: "没有找到报名记录。", retryable: false) }
                _ = try await model.api.cancelRegistration(registrationID: registration.id)
                detail.registrationStatus = "cancelled"
                detail.availableActions = [.register]
                notice = "报名已取消，积分处理结果已同步。"
            } catch { model.banner = .init(title: AppModel.map(error).message, tone: .warning) }
            busy = false
        }
    }

    private func addToCalendar() {
        guard let start = detail.startsAt else { return }
        let end = detail.endsAt ?? start.addingTimeInterval(7200)
        Task {
            try? await CalendarIntegration().add(
                title: detail.title,
                start: start,
                end: end,
                notes: "Spott · \(detail.publicArea ?? "")\nhttps://spott.jp/e/\(detail.publicSlug)"
            )
            notice = "已添加到系统日历。"
        }
    }

    private func openMaps() {
        let encoded = detail.publicArea?.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        if let url = URL(string: "http://maps.apple.com/?q=\(encoded)") { model.openExternal(url: url) }
    }

    private func displayTag(_ tag: String) -> String {
        ["city-walk": "城市探索", "family": "亲子", "outdoor": "户外", "sports": "运动", "food": "美食", "games": "游戏", "art": "文化艺术", "learning": "技能学习", "networking": "职业交流"][tag] ?? tag
    }
}

private struct EventShareItem: Identifiable {
    let id = UUID()
    let url: URL
}

private struct ShareActivityView: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) { }
}

private struct PosterGeneratorView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let resourceType: String
    let resourceID: UUID
    let title: String
    @State private var template = "tokyo_afterglow"
    @State private var job: PosterJob?
    @State private var busy = false
    @State private var shareItem: EventShareItem?
    @State private var error: UserFacingError?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 7) {
                    Text("为这次相遇留一张海报")
                        .font(.system(size: 28, weight: .bold, design: .rounded))
                    Text(title)
                        .font(.subheadline)
                        .foregroundStyle(SpottColor.muted)
                }

                if let url = job?.url, job?.state == "ready" {
                    AsyncImage(url: url) { image in
                        image.resizable().scaledToFit()
                    } placeholder: {
                        ProgressView().frame(maxWidth: .infinity, minHeight: 360)
                    }
                    .frame(maxWidth: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 26).stroke(SpottColor.divider))

                    Button {
                        shareItem = .init(url: url)
                    } label: {
                        Label("分享海报", systemImage: "square.and.arrow.up")
                    }
                    .buttonStyle(PrimaryButtonStyle())
                } else {
                    Picker("海报风格", selection: $template) {
                        Text("东京余光").tag("tokyo_afterglow")
                        Text("夜间电车").tag("night_transit")
                        Text("纸灯笼").tag("paper_lantern")
                    }
                    .pickerStyle(.segmented)

                    VStack(spacing: 14) {
                        Image(systemName: busy ? "wand.and.sparkles" : "rectangle.portrait.on.rectangle.portrait")
                            .font(.system(size: 42, weight: .light))
                            .foregroundStyle(SpottColor.twilight)
                        Text(posterStatus)
                            .font(.headline)
                        if busy { ProgressView() }
                    }
                    .frame(maxWidth: .infinity, minHeight: 260)
                    .spottGlassPanel(shape: RoundedRectangle(cornerRadius: 26, style: .continuous), interactive: false)

                    Button("生成品牌海报") { create() }
                        .buttonStyle(PrimaryButtonStyle())
                        .disabled(busy)
                }

                if let error {
                    Label("\(error.message)（\(error.id)）", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(SpottColor.danger)
                }
                Text("海报只使用已获准公开的活动信息与图片，不会包含精确地址、手机号或报名答案。")
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
            }
            .padding(SpottMetric.pageInset)
        }
        .background(SpottColor.canvas.ignoresSafeArea())
        .navigationTitle("分享海报")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("关闭") { dismiss() }
            }
        }
        .sheet(item: $shareItem) { item in
            ShareActivityView(items: [item.url])
                .presentationDetents([.medium])
        }
        .task(id: resourceID) {
            await recoverApprovedPoster()
        }
    }

    private var posterStatus: LocalizedStringKey {
        switch job?.state {
        case "queued": "海报已排队"
        case "processing": "正在生成海报"
        case "failed": "海报生成失败"
        default: "选择一个品牌模板"
        }
    }

    private var locale: String {
        let language = Locale.preferredLanguages.first?.lowercased() ?? "en"
        if language.hasPrefix("zh") { return "zh-Hans" }
        if language.hasPrefix("ja") { return "ja" }
        return "en"
    }

    private func create() {
        busy = true
        error = nil
        Task { @MainActor in
            defer { busy = false }
            do {
                let receipt = try await model.api.createPoster(
                    resourceType: resourceType,
                    resourceID: resourceID,
                    template: template,
                    locale: locale
                )
                try await poll(jobID: receipt.id)
            } catch is CancellationError {
                return
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }

    @MainActor
    private func recoverApprovedPoster() async {
        guard resourceType == "event", job == nil else { return }
        do {
            let current = try await model.api.eventPoster(eventID: resourceID)
            job = current
            if current.state == "queued" || current.state == "processing" {
                busy = true
                defer { busy = false }
                try await poll(jobID: current.id)
            }
        } catch let apiError as APIError where apiError.status == 404 {
            // An approved poster is optional until the event has passed moderation.
        } catch is CancellationError {
            return
        } catch {
            self.error = AppModel.map(error)
        }
    }

    @MainActor
    private func poll(jobID: UUID) async throws {
        for attempt in 0..<20 {
            let current = try await model.api.poster(jobID: jobID)
            job = current
            if current.state == "ready" || current.state == "failed" { return }
            if attempt < 19 { try await Task.sleep(for: .seconds(1)) }
        }
    }
}

private struct EventFeedbackSummaryCard: View {
    let summary: FeedbackSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Label("参加者反馈", systemImage: "sparkles")
                    .font(.system(size: 18, weight: .bold, design: .rounded))
                Spacer()
                Text("\(summary.sampleSize) 份")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(SpottColor.muted)
            }
            if summary.published {
                VStack(spacing: 10) {
                    ForEach(summary.tags.prefix(4)) { item in
                        VStack(alignment: .leading, spacing: 5) {
                            HStack {
                                Text(item.tag.feedbackTitle)
                                Spacer()
                                Text(item.rate, format: .percent.precision(.fractionLength(0)))
                                    .foregroundStyle(SpottColor.muted)
                            }
                            .font(.subheadline.weight(.semibold))
                            GeometryReader { proxy in
                                ZStack(alignment: .leading) {
                                    Capsule().fill(SpottColor.ink.opacity(0.07))
                                    Capsule()
                                        .fill(SpottColor.twilight)
                                        .frame(width: proxy.size.width * min(max(item.rate, 0), 1))
                                }
                            }
                            .frame(height: 6)
                        }
                    }
                }
                Text("只展示达到隐私样本门槛后的匿名聚合标签，不公开个人文字。")
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
            } else {
                Text("已有 \(summary.sampleSize) 份反馈；达到 \(summary.minimumSampleSize) 份后才会展示匿名聚合结果。")
                    .font(.subheadline)
                    .foregroundStyle(SpottColor.muted)
                    .lineSpacing(3)
            }
        }
        .padding(17)
        .spottGlassPanel(shape: RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous))
    }
}

extension FeedbackTag {
    var feedbackTitle: LocalizedStringKey {
        switch self {
        case .friendly: "氛围友好"
        case .wellOrganized: "组织有序"
        case .clearInformation: "信息清楚"
        case .safe: "让人安心"
        case .wouldJoinAgain: "愿意再参加"
        }
    }
}

private struct EventHero: View {
    let event: EventSummary
    var body: some View {
        ZStack(alignment: .bottomLeading) {
            Group {
                if let url = event.coverURL {
                    AsyncImage(url: url) { image in image.resizable().scaledToFill() } placeholder: { fallback }
                } else { fallback }
            }
            .frame(height: 338)
            .clipped()
            LinearGradient(colors: [.clear, .black.opacity(0.48)], startPoint: .center, endPoint: .bottom)
            VStack(alignment: .leading, spacing: 2) {
                Text(event.startsAt?.formatted(.dateTime.month(.wide)) ?? "SPOTT")
                    .font(.caption.monospaced().bold())
                    .textCase(.uppercase)
                Text(event.startsAt?.formatted(.dateTime.day()) ?? "·")
                    .font(.system(size: 48, weight: .bold, design: .rounded))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 22)
            .padding(.bottom, 20)
        }
        .frame(height: 338)
        .accessibilityLabel("\(event.title) 的活动封面")
    }

    private var fallback: some View {
        ZStack {
            LinearGradient(colors: [Color(red: 0.08, green: 0.25, blue: 0.36), Color(red: 0.35, green: 0.30, blue: 0.72)], startPoint: .topLeading, endPoint: .bottomTrailing)
            Circle().fill(Color.white.opacity(0.12)).frame(width: 260, height: 260).offset(x: 160, y: -90)
            Capsule().fill(Color.black.opacity(0.13)).frame(width: 350, height: 105).rotationEffect(.degrees(-30)).offset(x: -80, y: 100)
        }
    }
}

private struct DetailFact: View {
    let icon: String
    let title: String
    let value: String
    var body: some View {
        HStack(alignment: .top, spacing: 13) {
            Image(systemName: icon)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(SpottColor.ink)
                .frame(width: 32, height: 32)
                .background(Color.black.opacity(0.045), in: Circle())
            VStack(alignment: .leading, spacing: 3) {
                Text(LocalizedStringKey(title)).font(.caption).foregroundStyle(SpottColor.muted)
                Text(value).font(.system(size: 14.5, weight: .semibold, design: .rounded)).lineLimit(3)
            }
            Spacer()
        }
        .padding(.vertical, 12)
    }
}

private struct DetailQuickAction: View {
    let icon: String
    let title: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            VStack(spacing: 7) {
                Image(systemName: icon).font(.system(size: 17, weight: .semibold))
                Text(LocalizedStringKey(title)).font(.caption.weight(.semibold))
            }
            .foregroundStyle(SpottColor.ink)
            .frame(maxWidth: .infinity, minHeight: 68)
            .spottGlassPanel(shape: RoundedRectangle(cornerRadius: 18))
        }
        .buttonStyle(.plain)
    }
}

private struct FeeBoundaryCard: View {
    let fee: EventFee
    var body: some View {
        SurfaceCard {
            VStack(alignment: .leading, spacing: 11) {
                Label("活动费用边界", systemImage: "hand.raised.fill").font(.headline)
                Text(fee.boundaryStatement).font(.subheadline).foregroundStyle(SpottColor.muted).lineSpacing(3)
                if let collector = fee.collectorName { LabeledContent("收款主体", value: collector) }
                if let method = fee.method { LabeledContent("方式", value: method) }
                if let deadline = fee.paymentDeadlineText { LabeledContent("付款期限", value: deadline) }
                if let policy = fee.refundPolicy { Divider(); Text(policy).font(.caption).foregroundStyle(SpottColor.muted) }
            }
        }
    }
}

private struct OrganizerCard: View {
    let event: EventSummary
    var body: some View {
        HStack(spacing: 13) {
            Circle()
                .fill(LinearGradient(colors: [Color(red: 0.18, green: 0.33, blue: 0.46), SpottColor.twilight], startPoint: .topLeading, endPoint: .bottomTrailing))
                .frame(width: 52, height: 52)
                .overlay(Text(String((event.organizerName ?? event.organizerHandle ?? "S").prefix(1))).font(.title3.bold()).foregroundStyle(.white))
            VStack(alignment: .leading, spacing: 3) {
                Text(event.organizerName ?? "Spott 局头").font(.system(size: 16, weight: .bold, design: .rounded))
                Text("@\(event.organizerHandle ?? String(event.organizerId.uuidString.prefix(8))) · 手机号已验证")
                    .font(.caption).foregroundStyle(SpottColor.muted)
            }
            Spacer()
            Image(systemName: "chevron.right").font(.caption.bold()).foregroundStyle(SpottColor.muted)
        }
        .padding(16)
        .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: SpottMetric.cardRadius))
        .overlay(RoundedRectangle(cornerRadius: SpottMetric.cardRadius).stroke(SpottColor.divider))
    }
}

private struct RiskDisclosure: View {
    let flags: [String]
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("活动风险披露", systemImage: "exclamationmark.shield")
                .font(.headline)
            Text(flags.map(display).joined(separator: " · "))
                .font(.subheadline).foregroundStyle(SpottColor.muted)
        }
        .padding(16)
        .background(SpottColor.amber.opacity(0.09), in: RoundedRectangle(cornerRadius: 17))
    }
    private func display(_ value: String) -> String { ["alcohol": "酒精", "late_night": "深夜", "family": "亲子", "minors": "未成年人", "outdoor": "户外", "mountain": "山地", "water": "涉水", "high_fee": "高额费用", "career": "职业招募", "investment": "投资相关", "gender_limited": "性别限制"][value] ?? value }
}

private struct SafetyNote: View {
    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 4) {
                Text("见面安全提示").font(.subheadline.bold())
                Text("首次见面请选择公共场所，不要在 Spott 外预付不明款项。")
                    .font(.caption).foregroundStyle(SpottColor.muted)
            }
        } icon: {
            Image(systemName: "shield.lefthalf.filled").foregroundStyle(SpottColor.mint)
        }
        .padding(16)
        .background(SpottColor.mint.opacity(0.08), in: RoundedRectangle(cornerRadius: 17))
    }
}

private struct RegistrationSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let event: EventSummary
    let completion: (Registration) -> Void
    @State private var partySize: Int
    @State private var joinWaitlist: Bool
    @State private var answers: [UUID: RegistrationAnswer]
    @State private var attendeeNote: String
    @State private var submitting = false
    @State private var error: UserFacingError?

    init(
        event: EventSummary,
        draft: DeferredRegistrationDraft = .init(),
        completion: @escaping (Registration) -> Void
    ) {
        self.event = event
        self.completion = completion
        _partySize = State(initialValue: draft.partySize)
        _joinWaitlist = State(initialValue: draft.joinWaitlistIfFull)
        _answers = State(initialValue: draft.answers)
        _attendeeNote = State(initialValue: draft.attendeeNote)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("报名确认") {
                    Text(event.title).font(.headline)
                    Stepper("参加人数：\(partySize)", value: $partySize, in: 1...10)
                    Toggle("满员时加入候补", isOn: $joinWaitlist)
                }
                if let questions = event.registrationQuestions, !questions.isEmpty {
                    Section("报名问题") {
                        ForEach(questions) { question in
                            questionField(question)
                        }
                    }
                }
                Section("给局头的备注") {
                    TextField("饮食、无障碍或其他需要说明的事项（选填）", text: $attendeeNote, axis: .vertical)
                        .lineLimit(2...5)
                    Text("仅局头和必要的活动管理员可见，最多 1000 字。")
                        .font(.caption)
                        .foregroundStyle(SpottColor.muted)
                }
                Section("积分与收费") {
                    LabeledContent("Spott 报名积分", value: "10")
                    Text(event.fee?.boundaryStatement ?? "Spott 报名积分不等同活动费用。")
                        .font(.caption).foregroundStyle(SpottColor.muted)
                }
                if let error { Section { Text("\(error.message)（\(error.id)）").foregroundStyle(SpottColor.danger) } }
                Section {
                    Button { submit() } label: { if submitting { ProgressView().frame(maxWidth: .infinity) } else { Text("确认并报名").frame(maxWidth: .infinity) } }
                        .buttonStyle(PrimaryButtonStyle())
                        .disabled(submitting || !requiredAnswersComplete || attendeeNote.count > 1_000)
                }
            }
            .navigationTitle("报名")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
        }
    }

    @ViewBuilder
    private func questionField(_ question: RegistrationQuestion) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(question.prompt)
                    .font(.subheadline.weight(.semibold))
                if question.required {
                    Text("必填")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(SpottColor.coral)
                }
            }

            switch question.kind {
            case .text:
                TextField("请输入回答", text: stringAnswerBinding(for: question), axis: .vertical)
                    .lineLimit(2...6)
            case .singleChoice:
                Picker("请选择", selection: stringAnswerBinding(for: question)) {
                    Text("请选择").tag("")
                    ForEach(question.options, id: \.self) { Text($0).tag($0) }
                }
                .pickerStyle(.menu)
            case .boolean:
                Picker("请选择", selection: booleanAnswerBinding(for: question)) {
                    Text("请选择").tag(Optional<Bool>.none)
                    Text("是").tag(Optional(true))
                    Text("否").tag(Optional(false))
                }
                .pickerStyle(.segmented)
            }
        }
        .padding(.vertical, 3)
    }

    private func stringAnswerBinding(for question: RegistrationQuestion) -> Binding<String> {
        Binding {
            switch answers[question.id] {
            case .text(let value), .choice(let value): value
            default: ""
            }
        } set: { value in
            answers[question.id] = question.kind == .singleChoice ? .choice(value) : .text(value)
        }
    }

    private func booleanAnswerBinding(for question: RegistrationQuestion) -> Binding<Bool?> {
        Binding {
            if case .boolean(let value) = answers[question.id] { return value }
            return nil
        } set: { value in
            if let value { answers[question.id] = .boolean(value) }
            else { answers.removeValue(forKey: question.id) }
        }
    }

    private var requiredAnswersComplete: Bool {
        (event.registrationQuestions ?? []).allSatisfy { question in
            guard question.required else { return true }
            switch answers[question.id] {
            case .text(let value): return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && value.count <= 1_000
            case .choice(let value): return question.options.contains(value)
            case .boolean: return true
            case nil: return false
            }
        }
    }

    private var sanitizedAnswers: [UUID: RegistrationAnswer] {
        answers.filter { _, answer in
            switch answer {
            case .text(let value), .choice(let value): !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            case .boolean: true
            }
        }
    }

    private func submit() {
        submitting = true; error = nil
        Task {
            do {
                let quote = try await model.api.quote(purpose: "registration", resourceID: event.id)
                let registration = try await model.api.register(
                    eventID: event.id,
                    partySize: partySize,
                    quoteID: quote.id,
                    joinWaitlist: joinWaitlist,
                    answers: sanitizedAnswers,
                    attendeeNote: attendeeNote,
                    idempotencyKey: UUID()
                )
                model.trackAnalytics(.registrationCompleted(
                    eventID: event.id,
                    status: registration.status,
                    partySize: partySize
                ))
                completion(registration); dismiss()
            } catch { self.error = AppModel.map(error) }
            submitting = false
        }
    }
}

private extension Optional where Wrapped == [String] {
    var orEmpty: [String] { self ?? [] }
}
