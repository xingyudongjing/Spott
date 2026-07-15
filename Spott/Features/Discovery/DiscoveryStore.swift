import Foundation
import Observation

protocol DiscoveryServing: Sendable {
    func discovery(_ query: EventDiscoveryQuery) async throws -> DiscoveryPage
}

extension SpottAPIClient: DiscoveryServing {}

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

@MainActor
@Observable
final class DiscoveryStore {
    static let defaultDebounce: Duration = .milliseconds(300)

    var phase: DiscoveryPhase = .initial
    var items: [EventSummary] = []
    var fatalError: UserFacingError?
    var refreshError: UserFacingError?
    var paginationError: UserFacingError?
    var isRefreshing = false
    var isLoadingNextPage = false
    var hasMore = false

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
    @ObservationIgnored private let cache: any DiscoveryCaching
    @ObservationIgnored private let debounce: Duration
    @ObservationIgnored private var scheduledReload: Task<Void, Never>?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var nextCursor: String?
    @ObservationIgnored private var usesFixture = false

    init(
        service: any DiscoveryServing,
        cache: any DiscoveryCaching,
        debounce: Duration = DiscoveryStore.defaultDebounce
    ) {
        self.service = service
        self.cache = cache
        self.debounce = debounce
    }

    var mapEvents: [EventSummary] {
        items.filter { $0.coordinate != nil }
    }

    var hasActiveFilters: Bool {
        category != nil || startsAfter != nil || startsBefore != nil || availableOnly != nil
            || format != nil || language != nil || price != nil || bounds != nil
    }

    func loadInitial() async {
        guard !usesFixture else { return }
        scheduledReload?.cancel()
        scheduledReload = nil
        generation += 1
        let requestGeneration = generation

        if items.isEmpty {
            phase = .loading
            if let cached = try? await cache.cachedEvents(), requestGeneration == generation, !cached.isEmpty {
                items = cached.map(\.discoverySafeSummary)
                phase = .offline
            }
        }

        await replaceResults(generation: requestGeneration)
    }

    func refresh() async {
        guard !usesFixture else { return }
        scheduledReload?.cancel()
        scheduledReload = nil
        generation += 1
        await replaceResults(generation: generation)
    }

    func searchDidChange() {
        scheduleReplacement()
    }

    func filtersDidChange() {
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

    func loadNextPage() async {
        guard hasMore, !isLoadingNextPage, let requestedCursor = nextCursor else { return }
        let requestGeneration = generation
        isLoadingNextPage = true
        paginationError = nil
        defer { isLoadingNextPage = false }

        do {
            let page = try await service.discovery(query(cursor: requestedCursor)).privacySanitized
            try Task.checkCancellation()
            guard requestGeneration == generation, nextCursor == requestedCursor else { return }

            items.append(contentsOf: page.items)
            if page.hasMore, page.nextCursor == nil || page.nextCursor == requestedCursor {
                hasMore = false
                nextCursor = nil
                paginationError = .init(
                    id: "DISCOVERY_CURSOR_STALLED",
                    message: String(localized: "更多活动暂时无法加载，请稍后重试。"),
                    retryable: true
                )
            } else {
                hasMore = page.hasMore
                nextCursor = page.nextCursor
            }
            try? await cache.replaceEvents(items)
        } catch is CancellationError {
            return
        } catch {
            guard requestGeneration == generation else { return }
            paginationError = Self.map(error)
        }
    }

    func replaceWithFixture(_ events: [EventSummary]) {
        scheduledReload?.cancel()
        scheduledReload = nil
        generation += 1
        items = events.map(\.discoverySafeSummary)
        phase = items.isEmpty ? .empty : .content
        fatalError = nil
        refreshError = nil
        paginationError = nil
        hasMore = false
        nextCursor = nil
        usesFixture = true
    }

    private func scheduleReplacement() {
        guard !usesFixture else { return }
        scheduledReload?.cancel()
        generation += 1
        let requestGeneration = generation
        scheduledReload = Task { [weak self, debounce] in
            do {
                try await Task.sleep(for: debounce)
                try Task.checkCancellation()
                guard let self, requestGeneration == self.generation else { return }
                await self.replaceResults(generation: requestGeneration)
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

    private func replaceResults(generation requestGeneration: Int) async {
        guard requestGeneration == generation else { return }
        isRefreshing = !items.isEmpty
        if items.isEmpty { phase = .loading }
        fatalError = nil
        refreshError = nil
        paginationError = nil

        do {
            let page = try await service.discovery(query(cursor: nil)).privacySanitized
            try Task.checkCancellation()
            guard requestGeneration == generation else { return }

            items = page.items
            phase = items.isEmpty ? .empty : .content
            if page.hasMore, page.nextCursor == nil {
                hasMore = false
                nextCursor = nil
                paginationError = .init(
                    id: "DISCOVERY_CURSOR_MISSING",
                    message: String(localized: "更多活动暂时无法加载，请稍后重试。"),
                    retryable: true
                )
            } else {
                hasMore = page.hasMore
                nextCursor = page.nextCursor
            }
            try? await cache.replaceEvents(items)
        } catch is CancellationError {
            return
        } catch {
            guard requestGeneration == generation else { return }
            let mapped = Self.map(error)
            if items.isEmpty {
                fatalError = mapped
                phase = .error
            } else {
                refreshError = mapped
                phase = Self.isOffline(error) ? .offline : .content
            }
        }

        if requestGeneration == generation { isRefreshing = false }
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

    private static func map(_ error: Error) -> UserFacingError {
        if let apiError = error as? APIError {
            return .init(id: apiError.code, message: apiError.message, retryable: apiError.retryable)
        }
        return .init(
            id: "NETWORK_UNAVAILABLE",
            message: String(localized: "暂时无法连接 Spott，请检查网络后重试。"),
            retryable: true
        )
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

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
