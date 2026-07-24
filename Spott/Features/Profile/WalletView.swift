import StoreKit
import SwiftUI

struct WalletView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale

    var body: some View {
        WalletScreen(service: model.api, locale: locale)
    }
}

private struct WalletScreen: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var store: WalletStore
    @State private var storePresented = false
    @State private var rulesPresented = false

    private let locale: Locale

    init(service: any WalletServing, locale: Locale) {
        _store = State(initialValue: WalletStore(service: service))
        self.locale = locale
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                if let error = store.error, store.wallet == nil {
                    SpottEmptyState(
                        icon: "wifi.exclamationmark",
                        title: text("profile.wallet.error_title"),
                        message: error.message,
                        actionTitle: text("profile.home.retry")
                    ) {
                        Task { await store.load() }
                    }
                    .padding(.top, 40)
                } else {
                    balanceCard
                    checkInCard
                    purchaseButton
                    transactionsCard
                    Text(text("profile.wallet.spend_order"))
                        .font(.caption)
                        .foregroundStyle(SpottColor.muted)
                        .lineSpacing(3)
                }
            }
            .padding(SpottMetric.pageInset)
        }
        .background(SpottScreenBackground())
        .navigationTitle(Text(text("profile.wallet.title")))
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    rulesPresented = true
                } label: {
                    Image(systemName: "questionmark.circle")
                }
                .accessibilityLabel(text("profile.wallet.rules_title"))
            }
        }
        .sheet(isPresented: $storePresented) {
            NavigationStack {
                PointStoreView { updatedWallet in
                    store.applyPurchase(wallet: updatedWallet)
                }
            }
        }
        .sheet(isPresented: $rulesPresented) {
            NavigationStack {
                PointsRulesSheet(store: store, locale: locale)
            }
            .presentationDetents([.medium, .large])
        }
        .task { await store.load() }
        .refreshable { await store.load() }
    }

    private var balanceCard: some View {
        SurfaceCard {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 6) {
                    Image(systemName: "sparkles")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(SpottColor.amber)
                        .accessibilityHidden(true)
                    Text(text("profile.wallet.total"))
                        .font(.caption)
                        .foregroundStyle(SpottColor.muted)
                }
                Text("\(store.wallet?.totalBalance ?? 0)")
                    .font(.system(.largeTitle, design: .rounded, weight: .bold))
                    .contentTransition(.numericText())
                    .animation(reduceMotion ? nil : SpottMotion.standard, value: store.wallet?.totalBalance)
                HStack(spacing: 10) {
                    BalanceChip(
                        title: text("profile.wallet.paid"),
                        value: store.wallet?.paidBalance ?? 0,
                        color: SpottColor.amberDeep
                    )
                    BalanceChip(
                        title: text("profile.wallet.free"),
                        value: store.wallet?.freeBalance ?? 0,
                        color: SpottColor.mint
                    )
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .spottSkeleton(store.isLoading)
        .accessibilityElement(children: .combine)
    }

    private var checkInCard: some View {
        SurfaceCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 13) {
                    Image(systemName: "flame.fill")
                        .font(.title3.weight(.bold))
                        .foregroundStyle(
                            LinearGradient(
                                colors: [SpottColor.amber, SpottColor.coral],
                                startPoint: .top,
                                endPoint: .bottom
                            )
                        )
                        .frame(width: 42, height: 42)
                        .background(SpottColor.coralPale.opacity(0.7), in: Circle())
                        .overlay(Circle().strokeBorder(SpottColor.hairline))
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(text("profile.checkin.title"))
                            .font(.headline)
                            .fontDesign(.rounded)
                        Text(text("profile.checkin.subtitle"))
                            .font(.caption)
                            .foregroundStyle(SpottColor.muted)
                    }
                    Spacer()
                    if let result = store.checkInResult {
                        StreakFlame(days: result.streak)
                    }
                }

                if let result = store.checkInResult {
                    if result.alreadyCheckedIn {
                        Label(text("profile.checkin.already"), systemImage: "checkmark.circle.fill")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(SpottColor.mint)
                    } else {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(result.rewards, id: \.self) { reward in
                                HStack {
                                    Label(rewardTitle(reward.type), systemImage: rewardIcon(reward.type))
                                        .font(.subheadline)
                                    Spacer()
                                    Text(verbatim: "+\(reward.points)")
                                        .font(.subheadline.weight(.bold))
                                        .fontDesign(.rounded)
                                        .foregroundStyle(SpottColor.mint)
                                }
                            }
                        }
                        Label(text("profile.checkin.done"), systemImage: "checkmark.circle.fill")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(SpottColor.mint)
                    }
                } else {
                    Button {
                        Task { await store.checkIn() }
                    } label: {
                        HStack(spacing: 8) {
                            if store.isCheckingIn {
                                ProgressView().tint(.white)
                            }
                            Text(text("profile.checkin.action"))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 2)
                    }
                    .spottProminentActionStyle()
                    .disabled(store.isCheckingIn)
                    .accessibilityIdentifier("wallet.checkin")
                }

                if let error = store.checkInError {
                    Label(error.message, systemImage: "exclamationmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(SpottColor.danger)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .sensoryFeedback(.success, trigger: store.checkInResult?.streak)
        .animation(reduceMotion ? nil : SpottMotion.standard, value: store.hasCheckedInToday)
    }

    private var purchaseButton: some View {
        Button {
            storePresented = true
        } label: {
            Label(text("profile.wallet.buy"), systemImage: "cart")
                .font(.subheadline.weight(.semibold))
                .fontDesign(.rounded)
                .frame(maxWidth: .infinity, minHeight: 48)
        }
        .buttonStyle(.glass)
        .tint(SpottColor.ink)
        .accessibilityIdentifier("wallet.buy-points")
    }

    private var transactionsCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            SpottSectionHeader(title: text("profile.wallet.transactions"))
            if store.transactions.isEmpty {
                if !store.isLoading {
                    Text(text("profile.wallet.transactions_empty"))
                        .font(.subheadline)
                        .foregroundStyle(SpottColor.muted)
                        .padding(.vertical, 14)
                }
            } else {
                SurfaceCard {
                    VStack(spacing: 0) {
                        ForEach(store.transactions) { transaction in
                            TransactionRow(transaction: transaction, locale: locale)
                            if transaction.id != store.transactions.last?.id {
                                Divider().padding(.leading, 46)
                            }
                        }
                    }
                }
            }
        }
    }

    private func rewardTitle(_ type: String) -> String {
        WalletPresentation.transactionTitle(type, locale: locale)
    }

    private func rewardIcon(_ type: String) -> String {
        WalletPresentation.transactionIcon(type)
    }

    private func text(_ key: String.LocalizationValue) -> String {
        ProfileTabLocalization.text(key, locale: locale)
    }
}

enum WalletPresentation {
    static let knownTypes: Set<String> = [
        "phone_verified", "attendance_reward", "registration_fee",
        "event_publish", "group_create", "daily_checkin_reward",
        "streak_7_reward", "streak_30_reward", "storekit_purchase",
        "storekit_bonus", "storekit_refund", "point_adjustment",
    ]

    static func transactionTitle(_ type: String, locale: Locale) -> String {
        guard knownTypes.contains(type) else {
            return type.replacingOccurrences(of: "_", with: " ").capitalized
        }
        return ProfileTabLocalization.text(
            String.LocalizationValue("profile.tx.\(type)"),
            locale: locale
        )
    }

    static func transactionIcon(_ type: String) -> String {
        switch type {
        case "phone_verified": "checkmark.seal"
        case "attendance_reward": "flag.checkered"
        case "registration_fee": "ticket"
        case "event_publish": "calendar.badge.plus"
        case "group_create": "person.2.badge.plus"
        case "daily_checkin_reward": "sun.max"
        case "streak_7_reward", "streak_30_reward": "flame"
        case "storekit_purchase": "cart"
        case "storekit_bonus": "gift"
        case "storekit_refund": "arrow.uturn.backward.circle"
        case "point_adjustment": "slider.horizontal.3"
        default: "circle.hexagongrid"
        }
    }
}

private struct PointsRulesSheet: View {
    @Environment(\.dismiss) private var dismiss
    let store: WalletStore
    let locale: Locale

    var body: some View {
        Group {
            if store.isLoadingRules {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = store.rulesError {
                SpottEmptyState(
                    icon: "wifi.exclamationmark",
                    title: text("profile.wallet.rules_error"),
                    message: error.message,
                    actionTitle: text("profile.home.retry")
                ) {
                    Task { await store.loadRules() }
                }
                .padding(SpottMetric.pageInset)
            } else if let rules = store.rules {
                List {
                    ForEach(rules.items) { rule in
                        HStack(alignment: .firstTextBaseline) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(rule.description ?? rule.key.replacingOccurrences(of: "_", with: " "))
                                    .font(.subheadline.weight(.semibold))
                                if rule.description != nil {
                                    Text(rule.key)
                                        .font(.caption2.monospaced())
                                        .foregroundStyle(SpottColor.muted)
                                }
                            }
                            Spacer()
                            Text(ruleValue(rule))
                                .font(.subheadline.weight(.bold))
                                .fontDesign(.rounded)
                                .foregroundStyle(SpottColor.amberDeep)
                        }
                        .padding(.vertical, 3)
                        .listRowBackground(SpottColor.surface)
                    }
                }
                .scrollContentBackground(.hidden)
            }
        }
        .background(SpottScreenBackground())
        .navigationTitle(Text(text("profile.wallet.rules_title")))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button(text("profile.common.close")) { dismiss() }
            }
        }
        .task { await store.loadRules() }
    }

    private func ruleValue(_ rule: PointsRule) -> String {
        let value = rule.effectiveValue
        let formatted = value.truncatingRemainder(dividingBy: 1) == 0
            ? String(Int(value))
            : String(format: "%.2f", locale: locale, value)
        if let unit = rule.unit, !unit.isEmpty {
            return "\(formatted) \(unit)"
        }
        return formatted
    }

    private func text(_ key: String.LocalizationValue) -> String {
        ProfileTabLocalization.text(key, locale: locale)
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
                    .fill(SpottColor.amberPale)
                    .frame(width: 58, height: 58)
                Image(systemName: "sparkles")
                    .font(.system(size: 21, weight: .semibold))
                    .foregroundStyle(SpottColor.amberDeep)
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
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.capsule)
                .tint(SpottColor.twilight)
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
            Text(title).font(.caption).foregroundStyle(SpottColor.muted)
            Text("\(value)")
                .font(.title3.bold())
                .fontDesign(.rounded)
                .foregroundStyle(color)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(13)
        .background(color.opacity(0.08), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

private struct TransactionRow: View {
    let transaction: WalletTransaction
    let locale: Locale

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: WalletPresentation.transactionIcon(transaction.type))
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(delta >= 0 ? SpottColor.mint : SpottColor.muted)
                .frame(width: 34, height: 34)
                .background(
                    (delta >= 0 ? SpottColor.mint : SpottColor.muted).opacity(0.12),
                    in: Circle()
                )
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(WalletPresentation.transactionTitle(transaction.type, locale: locale))
                    .font(.subheadline.weight(.semibold))
                HStack(spacing: 6) {
                    Text(ProfileTabLocalization.relative(transaction.occurredAt, locale: locale))
                        .font(.caption)
                        .foregroundStyle(SpottColor.muted)
                    if transaction.paidDelta != 0 {
                        deltaTag(
                            amount: transaction.paidDelta,
                            label: ProfileTabLocalization.text("profile.wallet.paid", locale: locale),
                            color: SpottColor.twilight
                        )
                    }
                    if transaction.freeDelta != 0 {
                        deltaTag(
                            amount: transaction.freeDelta,
                            label: ProfileTabLocalization.text("profile.wallet.free", locale: locale),
                            color: SpottColor.mint
                        )
                    }
                }
            }
            Spacer()
            Text(delta > 0 ? "+\(delta)" : "\(delta)")
                .font(.callout.weight(.bold))
                .fontDesign(.rounded)
                .foregroundStyle(delta >= 0 ? SpottColor.mint : SpottColor.ink)
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
    }

    private func deltaTag(amount: Int, label: String, color: Color) -> some View {
        Text(verbatim: "\(amount > 0 ? "+" : "")\(amount) \(label)")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.1), in: Capsule())
    }

    private var delta: Int { transaction.paidDelta + transaction.freeDelta }
}
