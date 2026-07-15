import AuthenticationServices
import GoogleSignInSwift
import PhotosUI
import StoreKit
import SwiftUI
import UIKit

struct ProfileHomeView: View {
    @Environment(AppModel.self) private var model
    @State private var profile: UserProfile?
    @State private var wallet: WalletSnapshot?
    @State private var achievementCount = 0

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 22) {
                Text("PROFILE")
                    .font(.system(size: 10.5, weight: .bold, design: .monospaced))
                    .tracking(1.7)
                    .foregroundStyle(SpottColor.coral)
                if model.session == nil { signedOutHeader } else { profileHeader }
                if model.session != nil { stats }
                destinationSection
                trustSection
                if model.session != nil {
                    Button("退出登录", role: .destructive) { model.signOut() }
                        .font(.system(size: 14, weight: .semibold, design: .rounded))
                        .frame(maxWidth: .infinity, minHeight: 48)
                        .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: 15))
                }
            }
            .padding(.horizontal, SpottMetric.pageInset)
            .padding(.top, 18)
            .padding(.bottom, 36)
        }
        .background(SpottColor.canvas.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .task(id: model.session?.sessionId) { await load() }
    }

    private var signedOutHeader: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                Circle()
                    .fill(Color.white.opacity(0.55))
                    .frame(width: 68, height: 68)
                    .overlay(Image(systemName: "person").font(.system(size: 25, weight: .medium)))
                Spacer()
                Text("iOS + Web")
                    .font(.caption.monospaced().weight(.semibold))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(Color.white.opacity(0.56), in: Capsule())
            }
            VStack(alignment: .leading, spacing: 7) {
                Text("把每一次见面，留在同一个账号里。")
                    .font(.system(size: 24, weight: .bold, design: .rounded))
                    .tracking(-0.6)
                Text("登录后同步收藏、活动、群组、成就和积分钱包。")
                    .font(.subheadline)
                    .foregroundStyle(SpottColor.muted)
            }
            Button("登录或注册") { model.presentedGate = .login }
                .buttonStyle(PrimaryButtonStyle())
        }
        .padding(22)
        .background(
            LinearGradient(
                colors: [Color(red: 0.91, green: 0.94, blue: 1), Color(red: 1, green: 0.93, blue: 0.89)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ),
            in: RoundedRectangle(cornerRadius: SpottMetric.coverRadius, style: .continuous)
        )
    }

    private var profileHeader: some View {
        HStack(spacing: 16) {
            Circle()
                .fill(
                    LinearGradient(
                        colors: [Color(red: 0.18, green: 0.32, blue: 0.48), SpottColor.twilight],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .frame(width: 72, height: 72)
                .overlay {
                    Text(String((profile?.nickname ?? model.session?.user.publicHandle ?? "S").prefix(1)).uppercased())
                        .font(.system(size: 27, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                }
            VStack(alignment: .leading, spacing: 5) {
                Text(profile?.nickname ?? model.session?.user.publicHandle ?? "Spott")
                    .font(.system(size: 24, weight: .bold, design: .rounded))
                    .tracking(-0.5)
                HStack(spacing: 5) {
                    Image(systemName: "checkmark.seal.fill")
                        .foregroundStyle(model.session?.user.phoneVerified == true ? SpottColor.mint : SpottColor.amber)
                    Text(model.session?.user.phoneVerified == true ? "日本手机号已验证" : "手机号待验证")
                }
                .font(.system(size: 12.5, weight: .medium, design: .rounded))
                .foregroundStyle(SpottColor.muted)
            }
            Spacer()
            NavigationLink { EditProfileView() } label: {
                Image(systemName: "pencil")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(SpottColor.ink)
                    .frame(width: 40, height: 40)
                    .spottGlassPanel(shape: Circle())
            }
            .buttonStyle(.plain)
        }
    }

    private var stats: some View {
        HStack(spacing: 10) {
            ProfileStat(value: "\(wallet?.totalBalance ?? 0)", title: "积分")
            ProfileStat(value: "\(achievementCount)", title: "成就")
            ProfileStat(value: profile?.regionId == "tokyo" ? "东京" : "日本", title: "常驻")
        }
    }

    private var destinationSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionTitle("我的 Spott")
            VStack(spacing: 0) {
                NavigationLink { FavoritesView() } label: { ProfileRow(icon: "heart", title: "收藏", subtitle: "稍后想参加的活动") }
                    .accessibilityIdentifier("profile.favorites")
                Divider().padding(.leading, 58)
                NavigationLink { WalletView() } label: { ProfileRow(icon: "circle.hexagongrid", title: "积分钱包", subtitle: "免费与付费积分分开记录") }
                Divider().padding(.leading, 58)
                NavigationLink { NotificationsView() } label: { ProfileRow(icon: "bell", title: "通知中心", subtitle: "候补、变更和安全消息") }
                Divider().padding(.leading, 58)
                NavigationLink { AchievementsView() } label: { ProfileRow(icon: "medal", title: "成就", subtitle: "由真实履约形成的身份") }
                Divider().padding(.leading, 58)
                NavigationLink { HostStudioView() } label: { ProfileRow(icon: "rectangle.3.group", title: "局头工作台", subtitle: "活动、名单与现场签到") }
            }
            .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: SpottMetric.cardRadius).stroke(SpottColor.divider))
        }
    }

    private var trustSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionTitle("信任与设置")
            VStack(spacing: 0) {
                NavigationLink { SafetyCenterView() } label: { ProfileRow(icon: "shield", title: "帮助与安全", subtitle: "举报、拉黑与线下见面守则") }
                Divider().padding(.leading, 58)
                NavigationLink { SettingsView() } label: { ProfileRow(icon: "gearshape", title: "隐私与设置", subtitle: "语言、通知与账号控制") }
            }
            .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: SpottMetric.cardRadius).stroke(SpottColor.divider))
        }
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(LocalizedStringKey(title))
            .font(.system(size: 18, weight: .bold, design: .rounded))
    }

    private func load() async {
        guard model.session != nil else { profile = nil; wallet = nil; achievementCount = 0; return }
        async let profileRequest = try? model.api.profile()
        async let walletRequest = try? model.api.wallet()
        async let achievementsRequest = try? model.api.achievements()
        profile = await profileRequest
        wallet = await walletRequest
        achievementCount = await achievementsRequest?.items.count ?? 0
    }
}

struct PublicProfileView: View {
    @Environment(AppModel.self) private var model
    let identifier: String
    @State private var profile: PublicUserProfile?
    @State private var loading = true
    @State private var following = false
    @State private var busy = false
    @State private var error: UserFacingError?
    @State private var reportTarget: SafetyReportTarget?
    @State private var blockConfirmation = false
    @State private var hostedEvents: [PublicHostedEvent] = []
    @State private var eventsCursor: String?
    @State private var eventsHaveMore = false
    @State private var loadingMoreEvents = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if loading {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 120)
                } else if let profile {
                    profileHeader(profile)
                    VStack(alignment: .leading, spacing: 10) {
                        Text("关于")
                            .font(.system(size: 20, weight: .bold, design: .rounded))
                        Text(profile.bio.isEmpty ? "这位用户还没有填写公开简介。" : profile.bio)
                            .font(.body)
                            .foregroundStyle(profile.bio.isEmpty ? SpottColor.muted : SpottColor.ink)
                            .lineSpacing(5)
                    }
                    .padding(17)
                    .spottGlassPanel(shape: RoundedRectangle(cornerRadius: 22, style: .continuous))

                    VStack(alignment: .leading, spacing: 12) {
                        Label(regionTitle(profile.regionId), systemImage: "mappin.and.ellipse")
                        Label(languageTitle(profile.contentLanguages), systemImage: "character.bubble")
                        Label("公开资料不包含手机号与安全记录", systemImage: "lock.shield")
                    }
                    .font(.subheadline)
                    .foregroundStyle(SpottColor.muted)

                    hostedEventsSection

                    if let error {
                        Label("\(error.message)（\(error.id)）", systemImage: "exclamationmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(SpottColor.danger)
                    }
                } else {
                    SpottStateCard(
                        icon: "person.crop.circle.badge.questionmark",
                        title: "无法查看这份资料",
                        message: error?.message ?? "用户可能已停用公开资料。",
                        actionTitle: "重新加载"
                    ) { Task { await load() } }
                }
            }
            .padding(SpottMetric.pageInset)
        }
        .background(SpottColor.canvas.ignoresSafeArea())
        .navigationTitle(profile?.nickname ?? "公开资料")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let profile, model.session?.user.id != profile.userId {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button {
                            reportTarget = .init(type: .user, targetID: profile.userId, displayName: profile.nickname)
                        } label: {
                            Label("举报用户", systemImage: "exclamationmark.bubble")
                        }
                        Button(role: .destructive) { blockConfirmation = true } label: {
                            Label("拉黑用户", systemImage: "person.slash")
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                }
            }
        }
        .sheet(item: $reportTarget) { target in
            NavigationStack { SafetyReportView(target: target) }
        }
        .alert("拉黑这位用户？", isPresented: $blockConfirmation) {
            Button("拉黑", role: .destructive) { block() }
            Button("取消", role: .cancel) { }
        } message: {
            Text("拉黑会取消互相关注，并限制双方进入同一受控互动空间。")
        }
        .task(id: identifier) { await load() }
        .refreshable { await load() }
    }

    @ViewBuilder
    private var hostedEventsSection: some View {
        if !hostedEvents.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text("主办的公开活动")
                    .font(.system(size: 20, weight: .bold, design: .rounded))
                ForEach(hostedEvents) { event in
                    Button { open(event) } label: {
                        HStack(spacing: 13) {
                            Group {
                                if let url = event.coverURL {
                                    AsyncImage(url: url) { image in
                                        image.resizable().scaledToFill()
                                    } placeholder: {
                                        SpottColor.twilightPale
                                    }
                                } else {
                                    SpottColor.twilightPale
                                        .overlay(Image(systemName: "calendar").foregroundStyle(SpottColor.twilight))
                                }
                            }
                            .frame(width: 76, height: 68)
                            .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))

                            VStack(alignment: .leading, spacing: 5) {
                                Text(event.title)
                                    .font(.system(size: 15, weight: .bold, design: .rounded))
                                    .foregroundStyle(SpottColor.ink)
                                    .lineLimit(2)
                                Text("\(event.startsAt.formatted(date: .abbreviated, time: .shortened)) · \(event.publicArea)")
                                    .font(.caption)
                                    .foregroundStyle(SpottColor.muted)
                                    .lineLimit(1)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(SpottColor.muted)
                        }
                        .padding(10)
                        .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: 19, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 19).stroke(SpottColor.divider))
                    }
                    .buttonStyle(.plain)
                }
                if eventsHaveMore {
                    Button {
                        Task { await loadMoreEvents() }
                    } label: {
                        HStack {
                            if loadingMoreEvents { ProgressView() }
                            Text("查看更多活动")
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .disabled(loadingMoreEvents)
                }
            }
        }
    }

    private func profileHeader(_ profile: PublicUserProfile) -> some View {
        VStack(spacing: 17) {
            ZStack {
                Circle()
                    .fill(
                        LinearGradient(
                            colors: [Color(red: 0.18, green: 0.33, blue: 0.46), SpottColor.twilight],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .frame(width: 86, height: 86)
                if let avatarURL = profile.avatarURL {
                    AsyncImage(url: avatarURL) { image in
                        image.resizable().scaledToFill()
                    } placeholder: {
                        Text(String(profile.nickname.prefix(1)))
                            .font(.system(size: 30, weight: .bold, design: .rounded))
                            .foregroundStyle(.white)
                    }
                    .frame(width: 82, height: 82)
                    .clipShape(Circle())
                } else {
                    Text(String(profile.nickname.prefix(1)))
                        .font(.system(size: 30, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                }
            }
            VStack(spacing: 5) {
                Text(profile.nickname)
                    .font(.system(size: 27, weight: .bold, design: .rounded))
                Text("@\(profile.publicHandle)")
                    .font(.subheadline)
                    .foregroundStyle(SpottColor.muted)
                Text("\(max(0, profile.followerCount + (following ? 1 : 0) - (profile.viewerFollowing ? 1 : 0))) 位关注者")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(SpottColor.muted)
            }
            if model.session?.user.id == profile.userId {
                NavigationLink("编辑我的资料") { EditProfileView() }
                    .buttonStyle(.bordered)
            } else {
                Button(action: toggleFollow) {
                    Label(following ? "已关注" : "关注", systemImage: following ? "checkmark" : "plus")
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .tint(following ? SpottColor.muted : SpottColor.ink)
                .disabled(busy)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(22)
        .spottGlassPanel(shape: RoundedRectangle(cornerRadius: 28, style: .continuous))
    }

    private func load() async {
        loading = true
        do {
            async let profileRequest = model.api.publicProfile(identifier: identifier)
            async let eventRequest = model.api.publicProfileEvents(identifier: identifier)
            let value = try await profileRequest
            profile = value
            following = value.viewerFollowing
            if let page = try? await eventRequest {
                hostedEvents = page.items
                eventsCursor = page.nextCursor
                eventsHaveMore = page.hasMore
            }
            error = nil
        } catch {
            profile = nil
            self.error = AppModel.map(error)
        }
        loading = false
    }

    private func loadMoreEvents() async {
        guard eventsHaveMore, let eventsCursor else { return }
        loadingMoreEvents = true
        defer { loadingMoreEvents = false }
        do {
            let page = try await model.api.publicProfileEvents(
                identifier: identifier,
                cursor: eventsCursor
            )
            let known = Set(hostedEvents.map(\.id))
            hostedEvents.append(contentsOf: page.items.filter { !known.contains($0.id) })
            self.eventsCursor = page.nextCursor
            eventsHaveMore = page.hasMore
        } catch {
            self.error = AppModel.map(error)
        }
    }

    private func open(_ publicEvent: PublicHostedEvent) {
        Task { @MainActor in
            do {
                let event = try await model.api.event(identifier: publicEvent.publicSlug)
                model.show(event: event)
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }

    private func toggleFollow() {
        guard model.session != nil else {
            model.presentedGate = .login
            return
        }
        busy = true
        Task { @MainActor in
            defer { busy = false }
            do {
                let result = try await model.api.setProfileFollow(identifier: identifier, following: !following)
                following = result.following
                error = nil
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }

    private func block() {
        guard let profile else { return }
        guard model.session != nil else {
            model.presentedGate = .login
            return
        }
        Task { @MainActor in
            do {
                _ = try await model.api.setUserBlocked(profile.userId, blocked: true, reason: "profile")
                following = false
                model.banner = .init(title: "已拉黑 @\(profile.publicHandle)", tone: .success)
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }

    private func regionTitle(_ region: String?) -> String {
        ["tokyo": "东京", "kanagawa": "神奈川", "osaka": "大阪", "kyoto": "京都", "nationwide": "日本全国"][region ?? ""] ?? "未公开常驻地区"
    }

    private func languageTitle(_ languages: [String]) -> String {
        let values = languages.map { ["zh-Hans": "中文", "ja": "日本語", "en": "English"][$0] ?? $0 }
        return values.isEmpty ? "未设置内容语言" : values.joined(separator: " · ")
    }
}

private struct ProfileStat: View {
    let value: String
    let title: String
    var body: some View {
        VStack(spacing: 5) {
            Text(value).font(.system(size: 19, weight: .bold, design: .rounded))
            Text(LocalizedStringKey(title)).font(.caption).foregroundStyle(SpottColor.muted)
        }
        .frame(maxWidth: .infinity, minHeight: 72)
        .spottGlassPanel(shape: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

private struct ProfileRow: View {
    let icon: String
    let title: String
    let subtitle: String
    var body: some View {
        HStack(spacing: 13) {
            Image(systemName: icon)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(SpottColor.ink)
                .frame(width: 34, height: 34)
                .background(Color.black.opacity(0.045), in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(LocalizedStringKey(title)).font(.system(size: 15, weight: .semibold, design: .rounded))
                Text(LocalizedStringKey(subtitle)).font(.caption).foregroundStyle(SpottColor.muted)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption.weight(.bold))
                .foregroundStyle(SpottColor.muted.opacity(0.55))
        }
        .foregroundStyle(SpottColor.ink)
        .padding(.horizontal, 13)
        .frame(minHeight: 62)
        .contentShape(Rectangle())
    }
}

struct FavoritesView: View {
    @Environment(AppModel.self) private var model
    @State private var events: [EventSummary] = []
    @State private var loading = true

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 14) {
                if loading {
                    ProgressView().padding(.top, 90)
                } else if events.isEmpty {
                    SpottStateCard(icon: "heart", title: "还没有收藏", message: "收藏让你稍后再决定，不会占用活动名额。", actionTitle: nil) {}
                } else {
                    ForEach(events) { event in
                        Button { model.router.show(event: event) } label: { CompactEventRow(event: event) }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("favorite.event.\(event.publicSlug)")
                    }
                }
            }
            .padding(SpottMetric.pageInset)
        }
        .background(SpottColor.canvas.ignoresSafeArea())
        .navigationTitle("收藏")
        .task { await load() }
    }

    private func load() async {
        events = (try? await model.api.favoriteEvents().items) ?? []
        loading = false
    }
}

struct WalletView: View {
    @Environment(AppModel.self) private var model
    @State private var wallet: WalletSnapshot?
    @State private var transactions: [WalletTransaction] = []
    @State private var storePresented = false

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 20) {
                    Text("总积分").font(.caption).foregroundStyle(SpottColor.muted)
                    Text("\(wallet?.totalBalance ?? 0)")
                        .font(.system(size: 50, weight: .bold, design: .rounded))
                        .tracking(-1.5)
                    HStack(spacing: 10) {
                        BalanceChip(title: "付费积分", value: wallet?.paidBalance ?? 0, color: SpottColor.twilight)
                        BalanceChip(title: "免费积分", value: wallet?.freeBalance ?? 0, color: SpottColor.mint)
                    }
                }
                .padding(22)
                .background(
                    LinearGradient(
                        colors: [Color(red: 0.93, green: 0.94, blue: 1), Color.white],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    ),
                    in: RoundedRectangle(cornerRadius: SpottMetric.coverRadius, style: .continuous)
                )

                Button("购买积分") { storePresented = true }
                    .buttonStyle(PrimaryButtonStyle())

                VStack(alignment: .leading, spacing: 12) {
                    Text("最近流水").font(.system(size: 19, weight: .bold, design: .rounded))
                    if transactions.isEmpty {
                        Text("积分获得与消耗会在这里逐笔记录。")
                            .font(.subheadline)
                            .foregroundStyle(SpottColor.muted)
                            .padding(.vertical, 18)
                    } else {
                        ForEach(transactions) { transaction in
                            TransactionRow(transaction: transaction)
                            if transaction.id != transactions.last?.id { Divider() }
                        }
                    }
                }
                .padding(18)
                .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: SpottMetric.cardRadius))

                Text("优先使用即将到期的免费积分，其次其他免费积分，最后使用付费积分。付费积分不设有效期。")
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
                    .lineSpacing(3)
            }
            .padding(SpottMetric.pageInset)
        }
        .background(SpottColor.canvas.ignoresSafeArea())
        .navigationTitle("积分钱包")
        .sheet(isPresented: $storePresented) {
            NavigationStack {
                PointStoreView { updatedWallet in
                    wallet = updatedWallet
                    Task { transactions = (try? await model.api.walletTransactions().items) ?? transactions }
                }
            }
        }
        .task {
            async let walletRequest = try? model.api.wallet()
            async let transactionRequest = try? model.api.walletTransactions()
            wallet = await walletRequest
            transactions = await transactionRequest?.items ?? []
        }
    }
}

private struct PointStoreView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let completion: (WalletSnapshot) -> Void
    @State private var catalog: [StorePointProduct] = []
    @State private var products: [String: Product] = [:]
    @State private var loading = true
    @State private var purchasingID: String?
    @State private var error: UserFacingError?
    @State private var purchaseComplete = false

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 7) {
                    Text("为下一次见面补充积分")
                        .font(.system(size: 27, weight: .bold, design: .rounded))
                    Text("付费积分永久有效；赠送积分单独记录有效期。价格与付款均由 App Store 安全处理。")
                        .font(.subheadline)
                        .foregroundStyle(SpottColor.muted)
                        .lineSpacing(4)
                }

                if loading {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 80)
                } else if purchaseComplete {
                    SpottStateCard(
                        icon: "checkmark.circle.fill",
                        title: "积分已到账",
                        message: "钱包与 Web 已同步更新。App Store 交易也已完成确认。",
                        actionTitle: "完成"
                    ) { dismiss() }
                } else if catalog.isEmpty {
                    SpottStateCard(
                        icon: "cart.badge.questionmark",
                        title: "积分商店暂时不可用",
                        message: error?.message ?? "App Store 商品目录暂时没有返回内容，请稍后重试。",
                        actionTitle: "重新加载"
                    ) { Task { await load() } }
                } else {
                    ForEach(catalog) { item in
                        pointProduct(item)
                    }
                    if let error {
                        Label(error.message, systemImage: "exclamationmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(SpottColor.danger)
                    }
                }

                Text("购买只用于 Spott 平台积分。活动费用仍由主办方在 Spott 外按活动说明直接收取，Spott 不代收、不结算、不担保。")
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
                    .lineSpacing(3)
            }
            .padding(SpottMetric.pageInset)
        }
        .background(SpottColor.canvas.ignoresSafeArea())
        .navigationTitle("购买积分")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } }
        }
        .task { await load() }
    }

    private func pointProduct(_ item: StorePointProduct) -> some View {
        HStack(spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 17, style: .continuous)
                    .fill(SpottColor.twilightPale)
                    .frame(width: 58, height: 58)
                Image(systemName: "sparkles")
                    .font(.system(size: 21, weight: .semibold))
                    .foregroundStyle(SpottColor.twilight)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("\(item.points.formatted()) 积分")
                    .font(.system(size: 17, weight: .bold, design: .rounded))
                if item.bonusPoints > 0 {
                    Text("另赠 \(item.bonusPoints.formatted()) 免费积分")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(SpottColor.mint)
                } else {
                    Text("全部为永久有效付费积分")
                        .font(.caption)
                        .foregroundStyle(SpottColor.muted)
                }
            }
            Spacer()
            if let product = products[item.productId] {
                Button {
                    purchase(product, catalogItem: item)
                } label: {
                    if purchasingID == item.productId {
                        ProgressView().controlSize(.small)
                    } else {
                        Text(product.displayPrice)
                            .font(.system(size: 13, weight: .bold, design: .rounded))
                    }
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .disabled(purchasingID != nil)
            } else {
                Text("不可购买")
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
            }
        }
        .padding(16)
        .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: SpottMetric.cardRadius).stroke(SpottColor.divider))
    }

    private func load() async {
        loading = true
        error = nil
        do {
            let response = try await model.api.storeProducts()
            catalog = response.items
            let storeProducts = try await StoreKitManager.shared.products(ids: Set(response.items.map(\.productId)))
            products = Dictionary(uniqueKeysWithValues: storeProducts.map { ($0.id, $0) })
        } catch {
            catalog = []
            products = [:]
            self.error = AppModel.map(error)
        }
        loading = false
    }

    private func purchase(_ product: Product, catalogItem: StorePointProduct) {
        guard let userID = model.session?.user.id else {
            model.presentedGate = .login
            return
        }
        purchasingID = catalogItem.productId
        error = nil
        Task { @MainActor in
            defer { purchasingID = nil }
            do {
                guard let purchase = try await StoreKitManager.shared.purchase(product, appAccountToken: userID) else {
                    return
                }
                let wallet = try await model.api.creditAppleStoreTransaction(purchase.signedTransaction)
                await StoreKitManager.shared.finish(purchase)
                completion(wallet)
                purchaseComplete = true
            } catch {
                self.error = AppModel.map(error)
            }
        }
    }
}

private struct BalanceChip: View {
    let title: String
    let value: Int
    let color: Color
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(LocalizedStringKey(title)).font(.caption).foregroundStyle(SpottColor.muted)
            Text("\(value)").font(.title3.bold()).foregroundStyle(color)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(13)
        .background(Color.white.opacity(0.68), in: RoundedRectangle(cornerRadius: 14))
    }
}

private struct TransactionRow: View {
    let transaction: WalletTransaction
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(transactionTitle).font(.subheadline.weight(.semibold))
                Text(transaction.occurredAt.formatted(.relative(presentation: .named))).font(.caption).foregroundStyle(SpottColor.muted)
            }
            Spacer()
            Text(delta > 0 ? "+\(delta)" : "\(delta)")
                .font(.system(size: 16, weight: .bold, design: .rounded))
                .foregroundStyle(delta >= 0 ? SpottColor.mint : SpottColor.ink)
        }
        .padding(.vertical, 5)
    }
    private var delta: Int { transaction.paidDelta + transaction.freeDelta }
    private var transactionTitle: String {
        switch transaction.type {
        case "phone_verified": "手机验证奖励"
        case "attendance_reward": "真实到场奖励"
        case "registration_fee": "活动报名"
        case "event_publish": "发布活动"
        case "group_create": "创建群组"
        default: transaction.type.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }
}

struct NotificationsView: View {
    @Environment(AppModel.self) private var model
    @State private var items: [NotificationItem] = []
    @State private var loading = true

    var body: some View {
        Group {
            if loading { ProgressView() }
            else if items.isEmpty {
                SpottStateCard(icon: "bell.slash", title: "没有新通知", message: "候补、取消和安全通知会保留在这里。", actionTitle: nil) {}
                    .padding(SpottMetric.pageInset)
            } else {
                List(items) { item in
                    Button { markRead(item) } label: {
                        HStack(spacing: 13) {
                            Image(systemName: notificationIcon(item.type))
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundStyle(item.readAt == nil ? SpottColor.twilight : SpottColor.muted)
                                .frame(width: 38, height: 38)
                                .background(Color.black.opacity(0.045), in: Circle())
                            VStack(alignment: .leading, spacing: 4) {
                                Text(notificationTitle(item.type)).font(.subheadline.weight(.semibold))
                                Text(item.createdAt.formatted(.relative(presentation: .named))).font(.caption).foregroundStyle(SpottColor.muted)
                            }
                            Spacer()
                            if item.readAt == nil { Circle().fill(SpottColor.twilight).frame(width: 7, height: 7) }
                        }
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(SpottColor.surface)
                }
                .scrollContentBackground(.hidden)
            }
        }
        .background(SpottColor.canvas.ignoresSafeArea())
        .navigationTitle("通知")
        .task { items = (try? await model.api.notifications().items) ?? []; loading = false }
    }

    private func markRead(_ item: NotificationItem) {
        Task { try? await model.api.markNotificationRead(item.id); items = (try? await model.api.notifications().items) ?? items }
    }
    private func notificationIcon(_ type: String) -> String { type.contains("waitlist") ? "hourglass" : type.contains("cancel") ? "calendar.badge.exclamationmark" : type.contains("point") ? "sparkles" : "bell" }
    private func notificationTitle(_ type: String) -> String { type.contains("cancel") ? "活动已取消" : type.contains("waitlist") ? "候补名额已开放" : type.contains("point") ? "积分有新变化" : "活动有新变化" }
}

struct AchievementsView: View {
    @Environment(AppModel.self) private var model
    @State private var achievements: [Achievement] = []
    var body: some View {
        ScrollView {
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 14) {
                if achievements.isEmpty {
                    SpottStateCard(icon: "medal", title: "成就从真实见面开始", message: "完成签到、认真组织活动和建设社群都会留下可控隐私的成就。", actionTitle: nil) {}
                        .gridCellColumns(2)
                } else {
                    ForEach(achievements) { achievement in AchievementCard(achievement: achievement) }
                }
            }
            .padding(SpottMetric.pageInset)
        }
        .background(SpottColor.canvas.ignoresSafeArea())
        .navigationTitle("成就")
        .task { achievements = (try? await model.api.achievements().items) ?? [] }
    }
}

private struct AchievementCard: View {
    let achievement: Achievement
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Image(systemName: achievement.code.contains("host") ? "star.circle.fill" : "medal.fill")
                .font(.system(size: 27))
                .foregroundStyle(SpottColor.twilight)
            Text(achievement.code.replacingOccurrences(of: "_", with: " ").capitalized)
                .font(.system(size: 15, weight: .bold, design: .rounded))
            Text(achievement.awardedAt.formatted(date: .abbreviated, time: .omitted))
                .font(.caption)
                .foregroundStyle(SpottColor.muted)
        }
        .frame(maxWidth: .infinity, minHeight: 150, alignment: .topLeading)
        .padding(17)
        .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: SpottMetric.cardRadius))
        .overlay(RoundedRectangle(cornerRadius: SpottMetric.cardRadius).stroke(SpottColor.divider))
    }
}

struct EditProfileView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var profile: UserProfile?
    @State private var nickname = ""
    @State private var bio = ""
    @State private var region = "tokyo"
    @State private var saving = false
    @State private var error: UserFacingError?
    @State private var avatarItem: PhotosPickerItem?
    @State private var avatarPreview: UIImage?
    @State private var avatarUploading = false

    var body: some View {
        Form {
            Section("头像") {
                HStack(spacing: 16) {
                    Group {
                        if let avatarPreview {
                            Image(uiImage: avatarPreview).resizable().scaledToFill()
                        } else if let avatarURL = profile?.avatarURL {
                            AsyncImage(url: avatarURL) { image in
                                image.resizable().scaledToFill()
                            } placeholder: {
                                ProgressView()
                            }
                        } else {
                            Image(systemName: "person.crop.circle.fill")
                                .resizable()
                                .foregroundStyle(SpottColor.twilightPale)
                        }
                    }
                    .frame(width: 72, height: 72)
                    .clipShape(Circle())
                    .overlay(Circle().stroke(SpottColor.divider))

                    PhotosPicker(selection: $avatarItem, matching: .images) {
                        Label("更换头像", systemImage: "photo")
                    }
                    .disabled(avatarUploading)
                    if avatarUploading { ProgressView() }
                }
                Text("图片会先完成病毒扫描与内容安全处理，再替换当前头像。")
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
            }
            Section("公开资料") {
                TextField("昵称", text: $nickname)
                TextField("简介", text: $bio, axis: .vertical).lineLimit(3...8)
                Picker("常驻地区", selection: $region) { Text("东京").tag("tokyo"); Text("神奈川").tag("kanagawa"); Text("大阪").tag("osaka"); Text("京都").tag("kyoto") }
            }
            Section { Text("手机号、生日和安全记录永远不会显示在公开主页。") }
            if let error { Section { Text("\(error.message)（\(error.id)）").foregroundStyle(SpottColor.danger) } }
        }
        .navigationTitle("编辑资料")
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("保存") { save() }.disabled(profile == nil || nickname.isEmpty || saving) } }
        .onChange(of: avatarItem) { _, item in
            guard let item else { return }
            Task { await uploadAvatar(item) }
        }
        .task {
            guard let loaded = try? await model.api.profile() else { return }
            profile = loaded; nickname = loaded.nickname; bio = loaded.bio; region = loaded.regionId ?? "tokyo"
        }
    }

    private func uploadAvatar(_ item: PhotosPickerItem) async {
        avatarUploading = true
        defer { avatarUploading = false }
        do {
            guard let data = try await item.loadTransferable(type: Data.self),
                  let image = UIImage(data: data),
                  let jpeg = image.jpegData(compressionQuality: 0.86)
            else {
                throw APIError(status: 0, code: "IMAGE_INVALID", message: "无法读取这张图片。", retryable: false)
            }
            _ = try await model.api.uploadProfileAvatar(
                data: jpeg,
                filename: "profile-avatar.jpg",
                mimeType: "image/jpeg"
            )
            avatarPreview = image
            profile = try await model.api.profile()
            error = nil
        } catch {
            self.error = AppModel.map(error)
        }
    }

    private func save() {
        guard let profile else { return }
        saving = true
        Task {
            do { _ = try await model.api.updateProfile(profile, nickname: nickname, bio: bio, regionID: region); dismiss() }
            catch { self.error = AppModel.map(error) }
            saving = false
        }
    }
}

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("app.language") private var appLanguage = AppLanguage.system.rawValue
    @AppStorage("analytics.consent") private var analytics = false
    @AppStorage("privacy.lockScreenAddress") private var lockAddress = false
    @State private var normalNotifications = true
    @State private var emailNotifications = false
    @State private var loadingPreferences = false
    @State private var savingPreferences = false
    @State private var showDeletionConfirmation = false
    @State private var deletionSchedule: DeletionSchedule?
    @State private var error: UserFacingError?

    var body: some View {
        Form {
            Section("语言") {
                Picker("界面语言", selection: $appLanguage) {
                    ForEach(AppLanguage.allCases) { language in
                        Text(LocalizedStringKey(language.title)).tag(language.rawValue)
                    }
                }
            }
            Section("通知") {
                Toggle("允许普通活动提醒", isOn: normalNotificationBinding)
                    .disabled(model.session == nil || loadingPreferences || savingPreferences)
                Toggle("通过邮箱接收活动提醒", isOn: emailNotificationBinding)
                    .disabled(model.session == nil || loadingPreferences || savingPreferences)
                Toggle("锁屏显示精确地址", isOn: $lockAddress)
                Text("取消、候补递补与安全通知不会被静默。")
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
                if model.session == nil {
                    Button("登录后同步通知偏好") { model.presentedGate = .login }
                }
            }
            Section("隐私") {
                Toggle("匿名产品体验分析", isOn: $analytics)
                NavigationLink("数据与隐私说明") { PrivacySummaryView() }
                if let deletionSchedule {
                    LabeledContent("账号注销执行时间") {
                        Text(deletionSchedule.executeAfter.formatted(date: .abbreviated, time: .shortened))
                    }
                    Button("撤销注销申请") { cancelDeletion() }
                } else {
                    Button("请求注销账号", role: .destructive) {
                        if model.session == nil { model.presentedGate = .login }
                        else { showDeletionConfirmation = true }
                    }
                }
            }
            Section("账号") {
                NavigationLink("合并另一个账号") { AccountMergeView() }
                Text("必须重新验证另一个现有账号；Spott 不会仅凭当前登录状态直接合并。")
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
            }
            if let error {
                Section("无法完成") {
                    Label(error.message, systemImage: "exclamationmark.circle.fill")
                        .foregroundStyle(SpottColor.danger)
                    if error.retryable {
                        Button("重试通知同步") { Task { await savePreferences() } }
                    }
                }
            }
        }
        .navigationTitle("设置")
        .task(id: model.session?.sessionId) { await loadPreferences() }
        .onChange(of: appLanguage) { _, _ in
            guard model.session != nil else { return }
            Task { await savePreferences() }
        }
        .alert("确认请求注销账号？", isPresented: $showDeletionConfirmation) {
            Button("请求注销", role: .destructive) { requestDeletion() }
            Button("取消", role: .cancel) { }
        } message: {
            Text("申请后有 14 天冷静期。未结束活动、仍由你管理的群组或负积分会阻止注销。")
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

    private func loadPreferences() async {
        guard model.session != nil else { return }
        loadingPreferences = true
        defer { loadingPreferences = false }
        do {
            let page = try await model.api.notificationPreferences()
            if let preference = page.items.first(where: { $0.type == "event.reminder" }) {
                normalNotifications = preference.push
                emailNotifications = preference.email
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
                    quietStart: "22:00",
                    quietEnd: "08:00",
                    locale: preferredLocale
                )
            )
            error = nil
        } catch {
            self.error = AppModel.map(error)
        }
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

private struct AccountMergeView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
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
                .frame(height: 50)
                .spottGlassPanel(shape: RoundedRectangle(cornerRadius: 16))

            if emailChallenge != nil {
                TextField("6 位验证码", text: $code)
                    .keyboardType(.numberPad)
                    .textContentType(.oneTimeCode)
                    .padding(.horizontal, 15)
                    .frame(height: 50)
                    .spottGlassPanel(shape: RoundedRectangle(cornerRadius: 16))
            }

            Button(emailChallenge == nil ? "发送验证码" : "验证并预览合并") {
                verifyEmail()
            }
            .buttonStyle(PrimaryButtonStyle())
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
        .spottGlassPanel(shape: RoundedRectangle(cornerRadius: 24, style: .continuous))
    }

    private func mergePreview(_ value: AccountMergePreview) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("第二个账号已验证", systemImage: "checkmark.shield.fill")
                .font(.headline)
                .foregroundStyle(SpottColor.mint)

            HStack(spacing: 10) {
                ProfileStat(value: "\(value.impact.ownedEvents)", title: "迁移活动")
                ProfileStat(value: "\(value.impact.ownedGroups)", title: "迁移社群")
                ProfileStat(
                    value: "\(value.impact.sourceWallet.paid + value.impact.sourceWallet.free)",
                    title: "迁移积分"
                )
            }

            if value.conflicts.isEmpty {
                Text("没有发现手机号、重复报名、重复社群成员或运营账号冲突。")
                    .font(.subheadline)
                    .foregroundStyle(SpottColor.muted)
                Button("确认合并") { showCommitConfirmation = true }
                    .buttonStyle(PrimaryButtonStyle())
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
                .buttonStyle(.bordered)
            }
            Text("验证证明于 \(value.expiresAt.formatted(date: .omitted, time: .shortened)) 失效。")
                .font(.caption)
                .foregroundStyle(SpottColor.muted)
        }
        .padding(18)
        .spottGlassPanel(shape: RoundedRectangle(cornerRadius: 24, style: .continuous))
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
            error = .init(id: "APPLE_CREDENTIAL_INVALID", message: "Apple 没有返回有效的第二账号凭证。", retryable: true)
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
        case "phoneBinding": "两个账号都绑定了手机号"
        case "eventRegistration": "两个账号报名了同一活动"
        case "groupMembership": "两个账号加入了同一社群"
        case "operatorAccount": "来源账号具有运营后台权限"
        default: code
        }
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
                        message: "\(error.message)\n错误编号：\(error.id)",
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
                .buttonStyle(.borderedProminent)
                .tint(SpottColor.ink)
            }
        }
        .padding(17)
        .spottGlassPanel(shape: RoundedRectangle(cornerRadius: 22, style: .continuous))
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
                        message: "参考编号：\(item.reference)\n安全团队会保留原始处理记录并独立复核。",
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
                    .spottGlassPanel(shape: RoundedRectangle(cornerRadius: 22, style: .continuous))

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
                    .buttonStyle(PrimaryButtonStyle())
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
    let target: SafetyReportTarget?
    @State private var targetType: SafetyTargetType
    @State private var targetIDText: String
    @State private var reason = ""
    @State private var details = ""
    @State private var busy = false
    @State private var receipt: SafetyReportReceipt?
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
                        title: "举报已安全提交",
                        message: "参考编号：\(receipt.reference)\n你可以凭此编号查询处理进度。",
                        actionTitle: "完成"
                    ) { dismiss() }
                    .padding(SpottMetric.pageInset)
                }
                .background(SpottColor.canvas.ignoresSafeArea())
            } else {
                Form {
                    Section("举报对象") {
                        if let target {
                            LabeledContent(target.type.displayTitle, value: target.displayName)
                        } else {
                            Picker("对象类型", selection: $targetType) {
                                ForEach(SafetyTargetType.allCases, id: \.self) { type in
                                    Text(type.displayTitle).tag(type)
                                }
                            }
                            TextField("活动或用户编号", text: $targetIDText)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        }
                    }
                    Section("问题") {
                        Picker("问题类型", selection: $reason) {
                            Text("请选择").tag("")
                            Text("不安全或欺诈").tag("unsafe")
                            Text("骚扰或歧视").tag("harassment")
                            Text("垃圾内容").tag("spam")
                            Text("涉及未成年人安全").tag("minor safety")
                        }
                        TextField("补充说明", text: $details, axis: .vertical)
                            .lineLimit(5...12)
                    }
                    if let error {
                        Section("无法提交") {
                            Label(error.message, systemImage: "exclamationmark.circle.fill")
                                .foregroundStyle(SpottColor.danger)
                        }
                    }
                    Section {
                        Button(action: submit) {
                            HStack {
                                if busy { ProgressView().tint(.white) }
                                Text("安全提交")
                            }
                        }
                        .buttonStyle(PrimaryButtonStyle())
                        .disabled(!canSubmit || busy)
                    } footer: {
                        Text("举报内容会加密保存。被举报者不会看到你的身份或补充说明。")
                    }
                }
            }
        }
        .navigationTitle("安全支持")
    }

    private var resolvedTargetID: UUID? { UUID(uuidString: targetIDText) }
    private var canSubmit: Bool { resolvedTargetID != nil && !reason.isEmpty && details.count >= 5 }

    private func submit() {
        guard model.session != nil else { model.presentedGate = .login; return }
        guard let targetID = resolvedTargetID else { return }
        busy = true
        error = nil
        Task { @MainActor in
            defer { busy = false }
            do {
                receipt = try await model.api.submitSafetyReport(
                    .init(
                        targetType: targetType,
                        targetId: targetID,
                        reason: reason,
                        details: details,
                        evidenceAssetIds: []
                    )
                )
            } catch {
                self.error = AppModel.map(error)
            }
        }
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

struct HostStudioView: View {
    @Environment(AppModel.self) private var model
    @State private var events: [EventSummary] = []
    @State private var loading = true

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                HStack(spacing: 10) {
                    ProfileStat(value: "\(events.filter { $0.startsAt ?? .distantPast > .now }.count)", title: "未来活动")
                    ProfileStat(value: "\(events.reduce(0) { $0 + $1.confirmedCount })", title: "已确认")
                    ProfileStat(value: "\(events.filter { $0.status == "draft" }.count)", title: "草稿")
                }
                Text("活动").font(.system(size: 20, weight: .bold, design: .rounded))
                if loading { ProgressView() }
                else if events.isEmpty { SpottStateCard(icon: "calendar.badge.plus", title: "还没有主办活动", message: "从创建页开始，草稿会同时出现在 Web 工作台。", actionTitle: nil) {} }
                else {
                    ForEach(events) { event in
                        VStack(spacing: 0) {
                            Button { model.router.show(event: event) } label: {
                                CompactEventRow(event: event)
                            }
                            .buttonStyle(.plain)

                            Divider().padding(.horizontal, 14)
                            HStack(spacing: 10) {
                                NavigationLink { HostAttendeeManagerView(event: event) } label: {
                                    Label("报名管理", systemImage: "person.2")
                                        .frame(maxWidth: .infinity)
                                }
                                .buttonStyle(.bordered)

                                NavigationLink { HostCheckInView(event: event) } label: {
                                    Label("现场签到台", systemImage: "qrcode")
                                        .frame(maxWidth: .infinity)
                                }
                                .buttonStyle(.borderedProminent)
                                .tint(SpottColor.ink)
                            }
                            .font(.caption.weight(.semibold))
                            .padding(12)

                            NavigationLink { HostPrivateFeedbackView(event: event) } label: {
                                Label("参与者反馈", systemImage: "heart.text.clipboard")
                                    .font(.caption.weight(.semibold))
                                    .frame(maxWidth: .infinity, minHeight: 38)
                            }
                            .buttonStyle(.bordered)
                            .padding(.horizontal, 12)
                            .padding(.bottom, 12)
                        }
                        .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: SpottMetric.cardRadius, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: SpottMetric.cardRadius).stroke(SpottColor.divider))
                    }
                }
                Text("报名名单默认不展示手机号；敏感字段揭示会记录业务理由与审计日志。")
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
            }
            .padding(SpottMetric.pageInset)
        }
        .background(SpottColor.canvas.ignoresSafeArea())
        .navigationTitle("局头工作台")
        .task { events = (try? await model.api.hostedEvents().items) ?? []; loading = false }
    }
}

private struct HostPrivateFeedbackView: View {
    @Environment(AppModel.self) private var model
    let event: EventSummary
    @State private var items: [PrivateFeedback] = []
    @State private var loading = true
    @State private var error: UserFacingError?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 15) {
                VStack(alignment: .leading, spacing: 7) {
                    Text("只用于改进下一次")
                        .font(.system(size: 26, weight: .bold, design: .rounded))
                    Text("反馈不展示参与者身份，也不会把私密建议公开到活动页。")
                        .font(.subheadline)
                        .foregroundStyle(SpottColor.muted)
                        .lineSpacing(3)
                }
                if loading {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 70)
                } else if let error, items.isEmpty {
                    SpottStateCard(
                        icon: "wifi.exclamationmark",
                        title: "暂时无法加载反馈",
                        message: "\(error.message)\n错误编号：\(error.id)",
                        actionTitle: "重新连接"
                    ) { Task { await load() } }
                } else if items.isEmpty {
                    SpottStateCard(
                        icon: "heart.text.clipboard",
                        title: "还没有参与者反馈",
                        message: "完成签到的参与者可在活动结束后 30 天内提交一次反馈。",
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
                                Text("匿名反馈")
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
                                Text("这位参与者只提交了体验标签。")
                                    .font(.subheadline)
                                    .foregroundStyle(SpottColor.muted)
                            }
                        }
                        .padding(17)
                        .spottGlassPanel(shape: RoundedRectangle(cornerRadius: 22, style: .continuous))
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
}

private struct CompactEventRow: View {
    let event: EventSummary
    var body: some View {
        HStack(spacing: 14) {
            RoundedRectangle(cornerRadius: 14)
                .fill(LinearGradient(colors: [Color(red: 0.17, green: 0.33, blue: 0.48), SpottColor.twilight], startPoint: .topLeading, endPoint: .bottomTrailing))
                .frame(width: 78, height: 78)
                .overlay(Image(systemName: "calendar").foregroundStyle(.white))
            VStack(alignment: .leading, spacing: 6) {
                Text(event.title).font(.system(size: 15.5, weight: .bold, design: .rounded)).lineLimit(2)
                Text(event.startsAt?.formatted(.dateTime.month().day().hour().minute()) ?? "时间待定")
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
                Text(event.publicArea).font(.caption).foregroundStyle(SpottColor.muted).lineLimit(1)
            }
            Spacer()
            Image(systemName: "chevron.right").font(.caption.weight(.bold)).foregroundStyle(SpottColor.muted.opacity(0.55))
        }
        .foregroundStyle(SpottColor.ink)
        .padding(13)
        .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: SpottMetric.cardRadius))
        .overlay(RoundedRectangle(cornerRadius: SpottMetric.cardRadius).stroke(SpottColor.divider))
    }
}
