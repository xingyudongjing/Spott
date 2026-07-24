import Observation
import SwiftUI

protocol HostPromotionService: Sendable {
    func eventPromotion(eventID: UUID) async throws -> EventPromotion?
    func quote(purpose: String, resourceID: UUID?) async throws -> Quote
    func purchasePromotion(eventID: UUID, tier: EventPromotionTier, quoteID: UUID) async throws -> EventPromotion
    func wallet() async throws -> WalletSnapshot
}

extension SpottAPIClient: HostPromotionService {}

@MainActor
@Observable
final class HostPromotionStore {
    private(set) var active: EventPromotion?
    private(set) var wallet: WalletSnapshot?
    private(set) var quotes: [EventPromotionTier: Quote] = [:]
    private(set) var loading = false
    private(set) var purchasing = false
    private(set) var error: UserFacingError?

    private let service: HostPromotionService
    private let eventID: UUID

    init(eventID: UUID, service: HostPromotionService) {
        self.eventID = eventID
        self.service = service
    }

    func load() async {
        loading = true
        error = nil
        do {
            active = try await service.eventPromotion(eventID: eventID)
            wallet = try await service.wallet()
            if active == nil {
                var loaded: [EventPromotionTier: Quote] = [:]
                for tier in EventPromotionTier.allCases {
                    loaded[tier] = try await service.quote(purpose: tier.quotePurpose, resourceID: eventID)
                }
                quotes = loaded
            } else {
                quotes = [:]
            }
        } catch {
            self.error = AppModel.map(error)
        }
        loading = false
    }

    func purchase(tier: EventPromotionTier) async {
        guard !purchasing else { return }
        purchasing = true
        error = nil
        do {
            var quote = quotes[tier]
            if quote == nil || quote!.expiresAt <= .now {
                quote = try await service.quote(purpose: tier.quotePurpose, resourceID: eventID)
                quotes[tier] = quote
            }
            guard let quote else { return }
            active = try await service.purchasePromotion(eventID: eventID, tier: tier, quoteID: quote.id)
            do {
                wallet = try await service.wallet()
            } catch {
                // Honest failure: the purchase succeeded but the balance shown
                // gates the next decision, so surface the refresh error instead
                // of silently keeping a stale number.
                self.error = AppModel.map(error)
            }
        } catch {
            self.error = AppModel.map(error)
        }
        purchasing = false
    }

    func canAfford(_ tier: EventPromotionTier) -> Bool? {
        guard let wallet, let quote = quotes[tier] else { return nil }
        return wallet.totalBalance >= quote.amount
    }
}

struct HostPromotionView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    let event: EventSummary

    @State private var store: HostPromotionStore?
    @State private var selectedTier: EventPromotionTier = .boost24h

    var body: some View {
        Group {
            if let store {
                content(store)
            } else {
                ProgressView()
            }
        }
        .background(SpottColor.canvas.ignoresSafeArea())
        .navigationTitle(text("host.promotion.title"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button(text("host.common.close")) { dismiss() }
            }
        }
        .task {
            if store == nil {
                store = HostPromotionStore(eventID: event.id, service: model.api)
            }
            await store?.load()
        }
    }

    @ViewBuilder
    private func content(_ store: HostPromotionStore) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(event.title)
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                    Text(text("host.promotion.transparency"))
                        .font(.caption)
                        .foregroundStyle(SpottColor.muted)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if store.loading, store.active == nil, store.quotes.isEmpty {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 60)
                } else if let active = store.active {
                    activeCard(active)
                } else {
                    tierPicker(store)
                    walletRow(store)
                    purchaseButton(store)
                }

                if let error = store.error {
                    Label("\(error.message)（\(error.id)）", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(SpottColor.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(SpottMetric.pageInset)
        }
        .refreshable { await store.load() }
    }

    private func activeCard(_ promotion: EventPromotion) -> some View {
        SurfaceCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    PromotedBadge()
                    Spacer()
                    Text(tierTitle(EventPromotionTier(rawValue: promotion.tier)))
                        .font(.caption.weight(.bold))
                        .foregroundStyle(SpottColor.twilight)
                }
                Label(
                    HostLocalization.format(
                        "host.promotion.active_until",
                        locale: locale,
                        promotion.expiresAt.formatted(date: .abbreviated, time: .shortened)
                    ),
                    systemImage: "clock"
                )
                    .font(.subheadline.weight(.semibold))
                Text(
                    HostLocalization.format(
                        "host.promotion.active_spent",
                        locale: locale,
                        promotion.amount
                    )
                )
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
                Text(text("host.promotion.active_note"))
                    .font(.caption)
                    .foregroundStyle(SpottColor.muted)
                    .lineSpacing(3)
            }
        }
    }

    private func tierPicker(_ store: HostPromotionStore) -> some View {
        VStack(spacing: 10) {
            ForEach(EventPromotionTier.allCases) { tier in
                let quote = store.quotes[tier]
                Button {
                    selectedTier = tier
                } label: {
                    HStack {
                        Image(systemName: selectedTier == tier ? "largecircle.fill.circle" : "circle")
                            .foregroundStyle(selectedTier == tier ? SpottColor.twilight : SpottColor.muted)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(tierTitle(tier))
                                .font(.subheadline.weight(.bold))
                            Text(tierDuration(tier))
                                .font(.caption)
                                .foregroundStyle(SpottColor.muted)
                        }
                        Spacer()
                        if let quote {
                            Text(HostLocalization.format("host.promotion.cost", locale: locale, quote.amount))
                                .font(.subheadline.weight(.semibold))
                                .monospacedDigit()
                        } else {
                            Text(text("host.promotion.cost_unavailable"))
                                .font(.caption)
                                .foregroundStyle(SpottColor.muted)
                        }
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(SpottColor.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 16)
                            .stroke(selectedTier == tier ? SpottColor.twilight : SpottColor.divider, lineWidth: selectedTier == tier ? 1.5 : 1)
                    )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(tierAccessibilityLabel(tier, quote: quote))
                .accessibilityAddTraits(selectedTier == tier ? .isSelected : [])
            }
        }
    }

    private func walletRow(_ store: HostPromotionStore) -> some View {
        HStack {
            Label(text("host.promotion.wallet"), systemImage: "creditcard")
                .font(.caption.weight(.semibold))
                .foregroundStyle(SpottColor.muted)
            Spacer()
            if let wallet = store.wallet {
                Text(HostLocalization.format("host.promotion.wallet_balance", locale: locale, wallet.totalBalance))
                    .font(.caption.weight(.bold))
                    .monospacedDigit()
            }
        }
        .padding(.horizontal, 4)
    }

    @ViewBuilder
    private func purchaseButton(_ store: HostPromotionStore) -> some View {
        let affordable = store.canAfford(selectedTier)
        Button {
            Task { await store.purchase(tier: selectedTier) }
        } label: {
            if store.purchasing {
                ProgressView().tint(.white).frame(maxWidth: .infinity)
            } else if let quote = store.quotes[selectedTier] {
                Text(HostLocalization.format("host.promotion.purchase", locale: locale, quote.amount))
                    .frame(maxWidth: .infinity)
            } else {
                Text(text("host.promotion.purchase_generic")).frame(maxWidth: .infinity)
            }
        }
        .spottProminentActionStyle()
        .controlSize(.large)
        .disabled(store.purchasing || store.quotes[selectedTier] == nil || affordable == false)

        if affordable == false {
            Label(text("host.promotion.insufficient"), systemImage: "exclamationmark.circle")
                .font(.caption)
                .foregroundStyle(SpottColor.danger)
        }
    }

    private func tierTitle(_ tier: EventPromotionTier?) -> String {
        switch tier {
        case .boost24h: text("host.promotion.tier_24h")
        case .boost72h: text("host.promotion.tier_72h")
        case .boost7d: text("host.promotion.tier_7d")
        case nil: text("host.promotion.tier_unknown")
        }
    }

    private func tierDuration(_ tier: EventPromotionTier) -> String {
        switch tier {
        case .boost24h: text("host.promotion.duration_24h")
        case .boost72h: text("host.promotion.duration_72h")
        case .boost7d: text("host.promotion.duration_7d")
        }
    }

    private func tierAccessibilityLabel(_ tier: EventPromotionTier, quote: Quote?) -> String {
        if let quote {
            return HostLocalization.format(
                "host.promotion.tier_accessibility",
                locale: locale,
                tierTitle(tier),
                quote.amount
            )
        }
        return tierTitle(tier)
    }

    private func text(_ key: String.LocalizationValue) -> String {
        HostLocalization.text(key, locale: locale)
    }
}
