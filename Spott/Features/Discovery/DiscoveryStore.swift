import Foundation
import Observation

protocol DiscoveryServing: Sendable {
    func discovery(_ query: EventDiscoveryQuery) async throws -> DiscoveryPage
}

extension SpottAPIClient: DiscoveryServing {}

protocol DiscoveryFeedServing: Sendable {
    func discoveryFeed(_ query: EventDiscoveryQuery) async throws -> DiscoveryFeed
}

extension SpottAPIClient: DiscoveryFeedServing {}

protocol DiscoveryCaching: Sendable {
    func cachedEvents() async throws -> [EventSummary]
    func replaceEvents(_ events: [EventSummary]) async throws
}

extension PersistenceStore: DiscoveryCaching {}

enum DiscoveryPhase: Equatable, Sendable {
    case initial
    case loading
    case content
    case empty
    case offline
    case error
}

struct DiscoveryReplacementReceipt: Equatable, Sendable {
    let region: String
    let itemCount: Int
}

struct DiscoveryRecommendationSection: Identifiable, Sendable {
    let key: String
    let serverTitle: String
    let events: [EventSummary]

    var id: String { key }
}

@MainActor
@Observable
final class DiscoveryStore {
    static let defaultDebounce: Duration = .milliseconds(300)

    var phase: DiscoveryPhase = .initial
    var items: [EventSummary] = []
    var recommendationModules: [DiscoveryRecommendationModule] = []
    var operationalBanner: DiscoveryOperationalBanner?
    var fatalError: UserFacingError?
    var refreshError: UserFacingError?
    var paginationError: UserFacingError?
    var isRefreshing = false
    var isLoadingNextPage = false
    var hasMore = false
    var locale: Locale
    private(set) var mapCameraRevision = 0

    var searchText = ""
    var region = "tokyo"
    var category: String?
    var startsAfter: Date?
    var startsBefore: Date?
    var availableOnly: Bool?
    var format: EventFormat?
    var language: EventLocale?
    var price: EventPriceFilter?
    var bounds: MapBounds?

    @ObservationIgnored private let service: any DiscoveryServing
    @ObservationIgnored private let feedService: (any DiscoveryFeedServing)?
    @ObservationIgnored private let cache: any DiscoveryCaching
    @ObservationIgnored private let debounce: Duration
    @ObservationIgnored private var scheduledReload: Task<Void, Never>?
    @ObservationIgnored private var replacementRequest: Task<DiscoveryPage, Error>?
    @ObservationIgnored private var feedReplacementRequest: Task<DiscoveryFeed, Error>?
    @ObservationIgnored private var paginationRequest: Task<DiscoveryPage, Error>?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var nextCursor: String?
    @ObservationIgnored private var paginationBaseQuery: EventDiscoveryQuery?
    @ObservationIgnored private var paginationRecoveryRequiresReplacement = false
    @ObservationIgnored private var usesFixture = false
    @ObservationIgnored private var pendingCameraRegion: String?

    init(
        service: any DiscoveryServing,
        cache: any DiscoveryCaching,
        debounce: Duration = DiscoveryStore.defaultDebounce,
        locale: Locale = .autoupdatingCurrent
    ) {
        self.service = service
        feedService = service as? any DiscoveryFeedServing
        self.cache = cache
        self.debounce = debounce
        self.locale = locale
    }

    var mapEvents: [EventSummary] {
        items.filter { $0.coordinate != nil }
    }

    var recommendationSections: [DiscoveryRecommendationSection] {
        var seen = Set<UUID>()
        return recommendationModules.compactMap { module in
            let events = module.items.compactMap { item in
                seen.insert(item.event.id).inserted ? item.event : nil
            }
            guard !events.isEmpty else { return nil }
            return DiscoveryRecommendationSection(
                key: module.key,
                serverTitle: module.title,
                events: events
            )
        }
    }

    var hasActiveFilters: Bool {
        category != nil || startsAfter != nil || startsBefore != nil || availableOnly != nil
            || format != nil || language != nil || price != nil || bounds != nil
    }

    func loadInitial() async -> DiscoveryReplacementReceipt? {
        guard !usesFixture else { return nil }
        beginReplacement()
        let requestGeneration = generation
        let requestQuery = query(cursor: nil)

        if items.isEmpty {
            phase = .loading
            if isCanonicalCacheQuery(requestQuery),
               let cached = try? await cache.cachedEvents(),
               requestGeneration == generation,
               !cached.isEmpty {
                let neutralCache = cached.map(\.viewerNeutralDiscoverySummary)
                items = neutralCache
                phase = .offline
                try? await cache.replaceEvents(neutralCache)
            }
        }

        return await replaceResults(generation: requestGeneration, query: requestQuery)
    }

    func refresh() async -> DiscoveryReplacementReceipt? {
        guard !usesFixture else { return nil }
        beginReplacement()
        return await replaceResults(generation: generation, query: query(cursor: nil))
    }

    func searchDidChange() {
        scheduleReplacement()
    }

    func filtersDidChange() {
        scheduleReplacement()
    }

    func selectRegion(_ region: String) {
        guard self.region != region else { return }
        self.region = region
        bounds = nil
        pendingCameraRegion = region
        scheduleReplacement()
    }

    func mapBoundsDidSettle(_ bounds: MapBounds) {
        guard bounds.isUsefulDiscoveryViewport, self.bounds != bounds else { return }
        self.bounds = bounds
        scheduleReplacement()
    }

    func clearFilters() {
        category = nil
        startsAfter = nil
        startsBefore = nil
        availableOnly = nil
        format = nil
        language = nil
        price = nil
        bounds = nil
        scheduleReplacement()
    }

    func updateLocale(_ locale: Locale) {
        guard self.locale.identifier != locale.identifier else { return }
        self.locale = locale
        fatalError = relocalized(fatalError)
        refreshError = relocalized(refreshError)
        paginationError = relocalized(paginationError)
    }

    func loadNextPage() async {
        guard hasMore, !isLoadingNextPage, let requestedCursor = nextCursor else { return }
        let requestGeneration = generation
        let baseQuery = query(cursor: nil)
        guard paginationBaseQuery == baseQuery else {
            invalidatePagination()
            return
        }
        let requestQuery = query(cursor: requestedCursor)
        isLoadingNextPage = true
        paginationError = nil
        paginationRecoveryRequiresReplacement = false
        let request = Task { [service] in
            try await service.discovery(requestQuery).privacySanitized
        }
        paginationRequest = request
        defer {
            if requestGeneration == generation {
                isLoadingNextPage = false
                paginationRequest = nil
            }
        }

        do {
            let page = try await request.value
            try Task.checkCancellation()
            guard requestGeneration == generation,
                  paginationBaseQuery == baseQuery,
                  nextCursor == requestedCursor else { return }

            items.append(contentsOf: page.items)
            if page.hasMore, page.nextCursor == nil || page.nextCursor == requestedCursor {
                hasMore = false
                nextCursor = nil
                paginationRecoveryRequiresReplacement = true
                paginationError = .init(
                    id: "DISCOVERY_CURSOR_STALLED",
                    message: localized("更多活动暂时无法加载，请稍后重试。"),
                    retryable: true
                )
            } else {
                hasMore = page.hasMore
                nextCursor = page.nextCursor
            }
            await persistCanonicalCacheIfNeeded(query: baseQuery)
        } catch is CancellationError {
            return
        } catch {
            guard requestGeneration == generation else { return }
            paginationError = map(error)
        }
    }

    func retryPagination() async {
        guard paginationError != nil else { return }
        if paginationRecoveryRequiresReplacement {
            await refresh()
        } else {
            await loadNextPage()
        }
    }

    func resetForSessionChange() {
        cancelRequests()
        generation += 1
        items = items.map(\.viewerNeutralDiscoverySummary)
        recommendationModules = recommendationModules.map { module in
            DiscoveryRecommendationModule(
                key: module.key,
                title: module.title,
                items: module.items.map { item in
                    DiscoveryRecommendationItem(
                        event: item.event.viewerNeutralDiscoverySummary,
                        recommendation: item.recommendation
                    )
                }
            )
        }
        if let banner = operationalBanner {
            operationalBanner = DiscoveryOperationalBanner(
                label: banner.label,
                kind: banner.kind,
                promotional: banner.promotional,
                headline: banner.headline,
                imageURL: banner.imageURL,
                event: banner.event.viewerNeutralDiscoverySummary
            )
        }
        fatalError = nil
        refreshError = nil
        paginationError = nil
        isRefreshing = false
        isLoadingNextPage = false
        hasMore = false
        nextCursor = nil
        paginationBaseQuery = nil
        paginationRecoveryRequiresReplacement = false
        pendingCameraRegion = nil
        phase = items.isEmpty ? .initial : .content
    }

    func replaceWithFixture(_ events: [EventSummary]) {
        cancelRequests()
        generation += 1
        items = events.map(\.discoverySafeSummary)
        recommendationModules = []
        operationalBanner = nil
        phase = items.isEmpty ? .empty : .content
        fatalError = nil
        refreshError = nil
        paginationError = nil
        hasMore = false
        nextCursor = nil
        paginationBaseQuery = nil
        paginationRecoveryRequiresReplacement = false
        pendingCameraRegion = nil
        usesFixture = true
    }

    private func scheduleReplacement() {
        guard !usesFixture else { return }
        beginReplacement()
        let requestGeneration = generation
        let requestQuery = query(cursor: nil)
        scheduledReload = Task { [weak self, debounce] in
            do {
                try await Task.sleep(for: debounce)
                try Task.checkCancellation()
                guard let self, requestGeneration == self.generation else { return }
                await self.replaceResults(generation: requestGeneration, query: requestQuery)
                if requestGeneration == self.generation {
                    self.scheduledReload = nil
                }
            } catch is CancellationError {
                return
            } catch {
                return
            }
        }
    }

    private func replaceResults(
        generation requestGeneration: Int,
        query requestQuery: EventDiscoveryQuery
    ) async -> DiscoveryReplacementReceipt? {
        guard requestGeneration == generation else { return nil }
        if isHomeFeedQuery(requestQuery), let feedService {
            return await replaceFeedResults(
                generation: requestGeneration,
                query: requestQuery,
                service: feedService
            )
        }
        isRefreshing = !items.isEmpty
        if items.isEmpty { phase = .loading }
        fatalError = nil
        refreshError = nil
        paginationError = nil
        paginationRecoveryRequiresReplacement = false
        let request = Task { [service] in
            try await service.discovery(requestQuery).privacySanitized
        }
        replacementRequest = request
        defer {
            if requestGeneration == generation {
                isRefreshing = false
                replacementRequest = nil
            }
        }

        do {
            let page = try await request.value
            try Task.checkCancellation()
            guard requestGeneration == generation else { return nil }

            items = page.items
            recommendationModules = []
            operationalBanner = nil
            phase = items.isEmpty ? .empty : .content
            paginationBaseQuery = requestQuery
            if pendingCameraRegion == requestQuery.region {
                mapCameraRevision += 1
                pendingCameraRegion = nil
            }
            if page.hasMore, page.nextCursor == nil {
                hasMore = false
                nextCursor = nil
                paginationRecoveryRequiresReplacement = true
                paginationError = .init(
                    id: "DISCOVERY_CURSOR_MISSING",
                    message: localized("更多活动暂时无法加载，请稍后重试。"),
                    retryable: true
                )
            } else {
                hasMore = page.hasMore
                nextCursor = page.nextCursor
            }
            await persistCanonicalCacheIfNeeded(query: requestQuery)
            guard requestGeneration == generation, !Task.isCancelled else { return nil }
            return DiscoveryReplacementReceipt(
                region: requestQuery.region ?? region,
                itemCount: page.items.count
            )
        } catch is CancellationError {
            return nil
        } catch {
            guard requestGeneration == generation else { return nil }
            let mapped = map(error)
            if items.isEmpty {
                fatalError = mapped
                phase = .error
            } else {
                refreshError = mapped
                phase = Self.isOffline(error) ? .offline : .content
            }
            return nil
        }
    }

    private func replaceFeedResults(
        generation requestGeneration: Int,
        query requestQuery: EventDiscoveryQuery,
        service: any DiscoveryFeedServing
    ) async -> DiscoveryReplacementReceipt? {
        isRefreshing = !items.isEmpty
        if items.isEmpty { phase = .loading }
        fatalError = nil
        refreshError = nil
        paginationError = nil
        paginationRecoveryRequiresReplacement = false
        let request = Task {
            try await service.discoveryFeed(requestQuery)
        }
        feedReplacementRequest = request
        defer {
            if requestGeneration == generation {
                isRefreshing = false
                feedReplacementRequest = nil
            }
        }

        do {
            let feed = try await request.value
            try Task.checkCancellation()
            guard requestGeneration == generation else { return nil }

            let orderedModules = Self.orderedModules(from: feed)
            var seen = Set<UUID>()
            let orderedItems = orderedModules.flatMap(\.items).compactMap { item in
                seen.insert(item.event.id).inserted ? item.event : nil
            }

            recommendationModules = orderedModules
            operationalBanner = feed.banner
            items = orderedItems
            phase = orderedItems.isEmpty && feed.banner == nil ? .empty : .content
            paginationBaseQuery = nil
            hasMore = false
            nextCursor = nil
            if pendingCameraRegion == requestQuery.region {
                mapCameraRevision += 1
                pendingCameraRegion = nil
            }
            await persistCanonicalCacheIfNeeded(query: requestQuery)
            guard requestGeneration == generation, !Task.isCancelled else { return nil }
            return DiscoveryReplacementReceipt(
                region: requestQuery.region ?? region,
                itemCount: orderedItems.count
            )
        } catch is CancellationError {
            return nil
        } catch {
            guard requestGeneration == generation else { return nil }
            let mapped = map(error)
            if items.isEmpty {
                fatalError = mapped
                phase = .error
            } else {
                refreshError = mapped
                phase = Self.isOffline(error) ? .offline : .content
            }
            return nil
        }
    }

    private static func orderedModules(from feed: DiscoveryFeed) -> [DiscoveryRecommendationModule] {
        var modulesByKey: [String: DiscoveryRecommendationModule] = [:]
        var responseOrder: [String] = []
        for module in feed.modules where modulesByKey[module.key] == nil {
            modulesByKey[module.key] = module
            responseOrder.append(module.key)
        }

        var seen = Set<String>()
        let requestedOrder = feed.moduleOrder + responseOrder
        return requestedOrder.compactMap { key in
            guard seen.insert(key).inserted else { return nil }
            return modulesByKey[key]
        }
    }

    private func beginReplacement() {
        cancelRequests()
        generation += 1
        isLoadingNextPage = false
        paginationError = nil
        invalidatePagination()
        paginationRecoveryRequiresReplacement = false
    }

    private func cancelRequests() {
        scheduledReload?.cancel()
        scheduledReload = nil
        replacementRequest?.cancel()
        replacementRequest = nil
        feedReplacementRequest?.cancel()
        feedReplacementRequest = nil
        paginationRequest?.cancel()
        paginationRequest = nil
    }

    private func invalidatePagination() {
        hasMore = false
        nextCursor = nil
        paginationBaseQuery = nil
    }

    private func persistCanonicalCacheIfNeeded(query: EventDiscoveryQuery) async {
        guard isCanonicalCacheQuery(query) else { return }
        try? await cache.replaceEvents(items.map(\.viewerNeutralDiscoverySummary))
    }

    private func isCanonicalCacheQuery(_ query: EventDiscoveryQuery) -> Bool {
        query.q == nil
            && query.region == "tokyo"
            && query.category == nil
            && query.startsAfter == nil
            && query.startsBefore == nil
            && query.availableOnly == nil
            && query.format == nil
            && query.language == nil
            && query.price == nil
            && query.bounds == nil
            && query.cursor == nil
    }

    private func isHomeFeedQuery(_ query: EventDiscoveryQuery) -> Bool {
        query.q == nil
            && query.category == nil
            && query.startsAfter == nil
            && query.startsBefore == nil
            && query.availableOnly == nil
            && query.format == nil
            && query.language == nil
            && query.price == nil
            && query.bounds == nil
            && query.cursor == nil
    }

    private func query(cursor: String?) -> EventDiscoveryQuery {
        EventDiscoveryQuery(
            q: searchText.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            region: region,
            category: category,
            startsAfter: startsAfter,
            startsBefore: startsBefore,
            availableOnly: availableOnly,
            format: format,
            language: language,
            price: price,
            bounds: bounds,
            cursor: cursor,
            limit: 20
        )
    }

    private func map(_ error: Error) -> UserFacingError {
        if let apiError = error as? APIError {
            return .init(
                id: apiError.code,
                message: localized("请求暂时无法完成。"),
                retryable: apiError.retryable
            )
        }
        guard Self.isOffline(error) else {
            return .init(
                id: "DISCOVERY_REQUEST_FAILED",
                message: localized("请求暂时无法完成。"),
                retryable: true
            )
        }
        return .init(
            id: "NETWORK_UNAVAILABLE",
            message: localized("暂时无法连接 Spott，请检查网络后重试。"),
            retryable: true
        )
    }

    private func localized(_ key: String.LocalizationValue) -> String {
        DiscoveryLocalization.text(key, locale: locale)
    }

    private func relocalized(_ error: UserFacingError?) -> UserFacingError? {
        guard let error else { return nil }
        let message: String
        switch error.id {
        case "NETWORK_UNAVAILABLE":
            message = localized("暂时无法连接 Spott，请检查网络后重试。")
        case "DISCOVERY_CURSOR_MISSING", "DISCOVERY_CURSOR_STALLED":
            message = localized("更多活动暂时无法加载，请稍后重试。")
        default:
            message = localized("请求暂时无法完成。")
        }
        return .init(id: error.id, message: message, retryable: error.retryable)
    }

    private static func isOffline(_ error: Error) -> Bool {
        if let urlError = error as? URLError {
            return [
                .notConnectedToInternet,
                .networkConnectionLost,
                .cannotConnectToHost,
                .cannotFindHost,
                .timedOut,
            ].contains(urlError.code)
        }
        return false
    }
}

private extension EventSummary {
    var viewerNeutralDiscoverySummary: EventSummary {
        discoverySafeSummary
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
