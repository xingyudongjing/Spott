import Foundation
import Observation

protocol ProfileHomeServing: Sendable {
    func profile() async throws -> UserProfile
    func wallet() async throws -> WalletSnapshot
    func achievements() async throws -> AchievementPage
}

extension SpottAPIClient: ProfileHomeServing {}

@MainActor
@Observable
final class ProfileStore {
    private(set) var profile: UserProfile?
    private(set) var wallet: WalletSnapshot?
    private(set) var achievementCount: Int?
    private(set) var isLoading = false
    private(set) var error: UserFacingError?

    @ObservationIgnored private let service: any ProfileHomeServing
    @ObservationIgnored private var generation = 0

    init(service: any ProfileHomeServing) {
        self.service = service
    }

    func load(isSignedIn: Bool) async {
        generation += 1
        let current = generation
        guard isSignedIn else {
            profile = nil
            wallet = nil
            achievementCount = nil
            error = nil
            isLoading = false
            return
        }
        isLoading = profile == nil
        error = nil
        async let profileRequest = service.profile()
        async let walletRequest = service.wallet()
        async let achievementsRequest = service.achievements()
        do {
            let (profileValue, walletValue, achievementsValue) = try await (
                profileRequest, walletRequest, achievementsRequest
            )
            guard generation == current else { return }
            profile = profileValue
            wallet = walletValue
            achievementCount = achievementsValue.items.filter { $0.revokedAt == nil }.count
        } catch {
            guard generation == current else { return }
            self.error = AppModel.map(error)
        }
        guard generation == current else { return }
        isLoading = false
    }
}

protocol WalletServing: Sendable {
    func wallet() async throws -> WalletSnapshot
    func walletTransactions(limit: Int) async throws -> CursorPage<WalletTransaction>
    func dailyCheckIn() async throws -> PointsCheckInResult
    func pointsRules() async throws -> PointsRuleCatalog
}

extension SpottAPIClient: WalletServing {}

@MainActor
@Observable
final class WalletStore {
    private(set) var wallet: WalletSnapshot?
    private(set) var transactions: [WalletTransaction] = []
    private(set) var checkInResult: PointsCheckInResult?
    private(set) var rules: PointsRuleCatalog?
    private(set) var isLoading = false
    private(set) var isCheckingIn = false
    private(set) var isLoadingRules = false
    private(set) var error: UserFacingError?
    private(set) var checkInError: UserFacingError?
    private(set) var rulesError: UserFacingError?

    @ObservationIgnored private let service: any WalletServing
    @ObservationIgnored private var generation = 0

    init(service: any WalletServing) {
        self.service = service
    }

    var hasCheckedInToday: Bool {
        checkInResult != nil
    }

    func load() async {
        generation += 1
        let current = generation
        isLoading = wallet == nil
        error = nil
        async let walletRequest = service.wallet()
        async let transactionsRequest = service.walletTransactions(limit: 50)
        do {
            let (walletValue, transactionsValue) = try await (walletRequest, transactionsRequest)
            guard generation == current else { return }
            wallet = walletValue
            transactions = transactionsValue.items
        } catch {
            guard generation == current else { return }
            self.error = AppModel.map(error)
        }
        guard generation == current else { return }
        isLoading = false
    }

    func checkIn() async {
        guard !isCheckingIn else { return }
        isCheckingIn = true
        checkInError = nil
        do {
            let result = try await service.dailyCheckIn()
            checkInResult = result
            wallet = result.wallet
            if !result.alreadyCheckedIn {
                await refreshTransactions()
            }
        } catch {
            checkInError = AppModel.map(error)
        }
        isCheckingIn = false
    }

    func loadRules() async {
        guard rules == nil, !isLoadingRules else { return }
        isLoadingRules = true
        rulesError = nil
        do {
            rules = try await service.pointsRules()
        } catch {
            rulesError = AppModel.map(error)
        }
        isLoadingRules = false
    }

    func applyPurchase(wallet updated: WalletSnapshot) {
        wallet = updated
        Task { await refreshTransactions() }
    }

    private func refreshTransactions() async {
        if let page = try? await service.walletTransactions(limit: 50) {
            transactions = page.items
        }
    }
}

protocol NotificationsServing: Sendable {
    func notifications() async throws -> CursorPage<NotificationItem>
    func markNotificationRead(_ id: UUID) async throws
}

extension SpottAPIClient: NotificationsServing {}

struct NotificationDaySection: Identifiable, Sendable {
    let day: Date
    let items: [NotificationItem]

    var id: Date { day }
}

@MainActor
@Observable
final class NotificationsStore {
    private(set) var items: [NotificationItem] = []
    private(set) var isLoading = false
    private(set) var didLoad = false
    private(set) var error: UserFacingError?

    @ObservationIgnored private let service: any NotificationsServing
    @ObservationIgnored private var generation = 0

    init(service: any NotificationsServing) {
        self.service = service
    }

    var sections: [NotificationDaySection] {
        let calendar = Calendar.current
        let grouped = Dictionary(grouping: items) { calendar.startOfDay(for: $0.createdAt) }
        return grouped.keys.sorted(by: >).map { day in
            NotificationDaySection(
                day: day,
                items: (grouped[day] ?? []).sorted { $0.createdAt > $1.createdAt }
            )
        }
    }

    func load() async {
        generation += 1
        let current = generation
        isLoading = items.isEmpty
        error = nil
        do {
            let page = try await service.notifications()
            guard generation == current else { return }
            items = page.items
            didLoad = true
        } catch {
            guard generation == current else { return }
            self.error = AppModel.map(error)
        }
        guard generation == current else { return }
        isLoading = false
    }

    func markRead(_ item: NotificationItem) {
        guard item.readAt == nil else { return }
        guard let index = items.firstIndex(where: { $0.id == item.id }) else { return }
        items[index] = NotificationItem(
            id: item.id,
            type: item.type,
            resourceType: item.resourceType,
            resourcePublicId: item.resourcePublicId,
            createdAt: item.createdAt,
            readAt: .now
        )
        Task { try? await service.markNotificationRead(item.id) }
    }
}

protocol AchievementsServing: Sendable {
    func achievements() async throws -> AchievementPage
    func evaluateAchievements() async throws -> AchievementEvaluation
    func setAchievementHidden(id: UUID, hidden: Bool) async throws -> AchievementBadgeVisibilityMutation
    func achievementShareCard(id: UUID) async throws -> AchievementShareCard
}

extension SpottAPIClient: AchievementsServing {}

@MainActor
@Observable
final class AchievementsStore {
    private(set) var achievements: [Achievement] = []
    private(set) var newlyAwardedCodes: Set<String> = []
    private(set) var celebrationTick = 0
    private(set) var isLoading = false
    private(set) var didLoad = false
    private(set) var error: UserFacingError?
    private(set) var mutationError: UserFacingError?
    private(set) var togglingID: UUID?

    @ObservationIgnored private let service: any AchievementsServing
    @ObservationIgnored private var generation = 0

    init(service: any AchievementsServing) {
        self.service = service
    }

    var visibleAchievements: [Achievement] {
        achievements.filter { $0.revokedAt == nil }
    }

    func load() async {
        generation += 1
        let current = generation
        isLoading = achievements.isEmpty
        error = nil
        let evaluation = try? await service.evaluateAchievements()
        guard generation == current else { return }
        do {
            let page = try await service.achievements()
            guard generation == current else { return }
            achievements = page.items
            didLoad = true
            if let evaluation, !evaluation.awarded.isEmpty {
                newlyAwardedCodes = Set(evaluation.awarded)
                celebrationTick += 1
            }
        } catch {
            guard generation == current else { return }
            self.error = AppModel.map(error)
        }
        guard generation == current else { return }
        isLoading = false
    }

    func setHidden(_ achievement: Achievement, hidden: Bool) async {
        guard togglingID == nil else { return }
        togglingID = achievement.id
        mutationError = nil
        do {
            let mutation = try await service.setAchievementHidden(id: achievement.id, hidden: hidden)
            if let index = achievements.firstIndex(where: { $0.id == mutation.awardId }) {
                let existing = achievements[index]
                achievements[index] = Achievement(
                    id: existing.id,
                    code: existing.code,
                    audience: existing.audience,
                    ruleVersion: existing.ruleVersion,
                    visibility: existing.visibility,
                    awardedAt: existing.awardedAt,
                    revokedAt: existing.revokedAt,
                    revocationReason: existing.revocationReason,
                    hidden: mutation.hidden,
                    evidence: existing.evidence
                )
            }
        } catch {
            mutationError = AppModel.map(error)
        }
        togglingID = nil
    }

    func shareCard(for achievement: Achievement) async throws -> AchievementShareCard {
        try await service.achievementShareCard(id: achievement.id)
    }
}
