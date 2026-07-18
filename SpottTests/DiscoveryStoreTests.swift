import Foundation
import XCTest
@testable import Spott

@MainActor
final class DiscoveryStoreTests: XCTestCase {
    func testSuccessfulInitialReplacementReturnsAnAppliedResponseReceipt() async throws {
        let event = try Self.event(id: 1, title: "Applied")
        let store = DiscoveryStore(
            service: TestDiscoveryService { _, _ in Self.page(items: [event]) },
            cache: TestDiscoveryCache()
        )

        let receipt = await store.loadInitial()

        XCTAssertEqual(
            receipt,
            DiscoveryReplacementReceipt(region: "tokyo", itemCount: 1)
        )
    }

    func testFailedInitialReplacementReturnsNoReceiptWhenOfflineCacheRemainsVisible() async throws {
        let cached = try Self.event(id: 1, title: "Cached")
        let store = DiscoveryStore(
            service: TestDiscoveryService { _, _ in
                throw URLError(.notConnectedToInternet)
            },
            cache: TestDiscoveryCache(cached: [cached])
        )

        let receipt = await store.loadInitial()

        XCTAssertNil(receipt)
        XCTAssertEqual(store.items.map(\.title), ["Cached"])
        XCTAssertEqual(store.phase, .offline)
    }

    func testCancelledOlderReplacementReturnsNoReceipt() async throws {
        let firstStarted = expectation(description: "first request started")
        let firstCancelled = expectation(description: "first request cancelled")
        let replacement = try Self.event(id: 2, title: "Replacement")
        let service = TestDiscoveryService { _, requestNumber in
            if requestNumber == 1 {
                firstStarted.fulfill()
                do {
                    try await Task.sleep(for: .seconds(5))
                } catch is CancellationError {
                    firstCancelled.fulfill()
                    throw CancellationError()
                }
            }
            return Self.page(items: [replacement])
        }
        let store = DiscoveryStore(service: service, cache: TestDiscoveryCache())

        let older = Task { await store.loadInitial() }
        await fulfillment(of: [firstStarted], timeout: 1)
        let latest = await store.refresh()
        await fulfillment(of: [firstCancelled], timeout: 1)

        let olderReceipt = await older.value
        XCTAssertNil(olderReceipt)
        XCTAssertEqual(latest, DiscoveryReplacementReceipt(region: "tokyo", itemCount: 1))
    }

    func testFixtureNeverProducesAnAppliedNetworkReceipt() async throws {
        let fixture = try Self.event(id: 1, title: "Fixture")
        let service = TestDiscoveryService { _, _ in Self.page(items: []) }
        let store = DiscoveryStore(service: service, cache: TestDiscoveryCache())
        store.replaceWithFixture([fixture])

        let initialReceipt = await store.loadInitial()
        let refreshReceipt = await store.refresh()

        XCTAssertNil(initialReceipt)
        XCTAssertNil(refreshReceipt)
        let queryCount = await service.recordedQueryCount()
        XCTAssertEqual(queryCount, 0)
    }

    func testDefaultSearchDebounceIsExactlyThreeHundredMilliseconds() async throws {
        let service = TestDiscoveryService { _, _ in Self.page(items: []) }
        let store = DiscoveryStore(service: service, cache: TestDiscoveryCache())

        store.searchText = "night"
        store.searchDidChange()
        try await Task.sleep(for: .milliseconds(240))
        var queries = await service.recordedQueries()
        XCTAssertEqual(queries.count, 0)

        try await Task.sleep(for: .milliseconds(100))
        queries = await service.recordedQueries()
        XCTAssertEqual(queries.map(\.q), ["night"])
    }

    func testReplacingSearchCancelsTheInFlightServiceRequest() async throws {
        let firstStarted = expectation(description: "first search started")
        let firstCancelled = expectation(description: "first search cancelled")
        let replacement = try Self.event(id: 2, title: "Replacement")
        let service = TestDiscoveryService { query, _ in
            if query.q == "first" {
                firstStarted.fulfill()
                do {
                    try await Task.sleep(for: .seconds(5))
                } catch is CancellationError {
                    firstCancelled.fulfill()
                    throw CancellationError()
                }
            }
            return Self.page(items: [replacement])
        }
        let store = DiscoveryStore(
            service: service,
            cache: TestDiscoveryCache(),
            debounce: .milliseconds(10)
        )

        store.searchText = "first"
        store.searchDidChange()
        await fulfillment(of: [firstStarted], timeout: 1)
        store.searchText = "second"
        store.searchDidChange()

        await fulfillment(of: [firstCancelled], timeout: 1)
        try await Task.sleep(for: .milliseconds(80))
        XCTAssertEqual(store.items.map(\.title), ["Replacement"])
        let queries = await service.recordedQueries()
        XCTAssertEqual(queries.map(\.q), ["first", "second"])
    }

    func testLateCancelledResponseCannotReplaceNewerResults() async throws {
        let older = try Self.event(id: 1, title: "Older")
        let newer = try Self.event(id: 2, title: "Newer")
        let service = TestDiscoveryService { query, _ in
            if query.q == "slow" {
                try? await Task.sleep(for: .milliseconds(180))
                return Self.page(items: [older])
            }
            try await Task.sleep(for: .milliseconds(10))
            return Self.page(items: [newer])
        }
        let store = DiscoveryStore(
            service: service,
            cache: TestDiscoveryCache(),
            debounce: .milliseconds(5)
        )

        store.searchText = "slow"
        store.searchDidChange()
        try await Task.sleep(for: .milliseconds(25))
        store.searchText = "new"
        store.searchDidChange()
        try await Task.sleep(for: .milliseconds(240))

        XCTAssertEqual(store.items.map(\.title), ["Newer"])
        XCTAssertEqual(store.phase, .content)
    }

    func testPaginationAppendsServerOrderAndForwardsCursor() async throws {
        let first = try Self.event(id: 1, title: "First")
        let second = try Self.event(id: 2, title: "Second")
        let service = TestDiscoveryService { query, _ in
            if query.cursor == nil {
                return Self.page(items: [first], nextCursor: "cursor-1", hasMore: true)
            }
            return Self.page(items: [second], nextCursor: nil, hasMore: false)
        }
        let store = DiscoveryStore(service: service, cache: TestDiscoveryCache())

        await store.loadInitial()
        await store.loadNextPage()

        XCTAssertEqual(store.items.map(\.title), ["First", "Second"])
        let queries = await service.recordedQueries()
        XCTAssertEqual(queries.map(\.cursor), [nil, "cursor-1"])
        XCTAssertFalse(store.hasMore)
        XCTAssertNil(store.paginationError)
    }

    func testPaginationSurfacesAStalledCursorInsteadOfSilentlyDeduplicatingIt() async throws {
        let first = try Self.event(id: 1, title: "First")
        let second = try Self.event(id: 2, title: "Second")
        let service = TestDiscoveryService { query, _ in
            if query.cursor == nil {
                return Self.page(items: [first], nextCursor: "cursor-1", hasMore: true)
            }
            return Self.page(items: [second], nextCursor: "cursor-1", hasMore: true)
        }
        let store = DiscoveryStore(service: service, cache: TestDiscoveryCache())

        await store.loadInitial()
        await store.loadNextPage()

        XCTAssertEqual(store.items.map(\.title), ["First", "Second"])
        XCTAssertFalse(store.hasMore)
        XCTAssertEqual(store.paginationError?.id, "DISCOVERY_CURSOR_STALLED")
    }

    func testReplacingQueryCancelsPaginationAndAllowsTheNewQueryToPaginate() async throws {
        let oldPageStarted = expectation(description: "old pagination started")
        let oldPageCancelled = expectation(description: "old pagination cancelled")
        let initial = try Self.event(id: 1, title: "Initial")
        let replacement = try Self.event(id: 2, title: "Replacement")
        let replacementNext = try Self.event(id: 3, title: "Replacement next")
        let service = TestDiscoveryService { query, _ in
            switch (query.q, query.cursor) {
            case (nil, nil):
                return Self.page(items: [initial], nextCursor: "old-cursor", hasMore: true)
            case (nil, "old-cursor"):
                oldPageStarted.fulfill()
                do {
                    try await Task.sleep(for: .milliseconds(500))
                } catch is CancellationError {
                    oldPageCancelled.fulfill()
                    throw CancellationError()
                }
                return Self.page(items: [], nextCursor: nil, hasMore: false)
            case ("replacement", nil):
                return Self.page(items: [replacement], nextCursor: "new-cursor", hasMore: true)
            case ("replacement", "new-cursor"):
                return Self.page(items: [replacementNext], nextCursor: nil, hasMore: false)
            default:
                return Self.page(items: [])
            }
        }
        let store = DiscoveryStore(
            service: service,
            cache: TestDiscoveryCache(),
            debounce: .milliseconds(10)
        )

        await store.loadInitial()
        let oldPagination = Task { await store.loadNextPage() }
        await fulfillment(of: [oldPageStarted], timeout: 1)

        store.searchText = "replacement"
        store.searchDidChange()

        await fulfillment(of: [oldPageCancelled], timeout: 0.3)
        try await Task.sleep(for: .milliseconds(80))
        XCTAssertFalse(store.isLoadingNextPage)
        await store.loadNextPage()
        await oldPagination.value

        XCTAssertEqual(store.items.map(\.title), ["Replacement", "Replacement next"])
        let queries = await service.recordedQueries()
        XCTAssertTrue(queries.contains { $0.q == "replacement" && $0.cursor == "new-cursor" })
    }

    func testReplacementInvalidatesTheOldCursorBeforeTheDebounceFinishes() async throws {
        let initial = try Self.event(id: 1, title: "Initial")
        let replacement = try Self.event(id: 2, title: "Replacement")
        let service = TestDiscoveryService { query, _ in
            if query.q == nil {
                return Self.page(items: [initial], nextCursor: "old-cursor", hasMore: true)
            }
            return Self.page(items: [replacement])
        }
        let store = DiscoveryStore(
            service: service,
            cache: TestDiscoveryCache(),
            debounce: .milliseconds(80)
        )

        await store.loadInitial()
        store.searchText = "replacement"
        store.searchDidChange()

        await store.loadNextPage()
        var queries = await service.recordedQueries()
        XCTAssertEqual(queries.count, 1)
        XCTAssertFalse(store.hasMore)

        try await Task.sleep(for: .milliseconds(140))
        queries = await service.recordedQueries()
        XCTAssertEqual(queries.map(\.cursor), [nil, nil])
        XCTAssertEqual(queries.map(\.q), [nil, "replacement"])
    }

    func testRetryingAStalledCursorRestartsFromTheFirstPage() async throws {
        let first = try Self.event(id: 1, title: "First")
        let stalled = try Self.event(id: 2, title: "Stalled")
        let recovered = try Self.event(id: 3, title: "Recovered")
        let service = TestDiscoveryService { query, requestNumber in
            if requestNumber == 1 {
                return Self.page(items: [first], nextCursor: "cursor-1", hasMore: true)
            }
            if requestNumber == 2 {
                return Self.page(items: [stalled], nextCursor: "cursor-1", hasMore: true)
            }
            XCTAssertNil(query.cursor)
            return Self.page(items: [recovered], nextCursor: nil, hasMore: false)
        }
        let store = DiscoveryStore(service: service, cache: TestDiscoveryCache())

        await store.loadInitial()
        await store.loadNextPage()
        XCTAssertEqual(store.paginationError?.id, "DISCOVERY_CURSOR_STALLED")

        await store.retryPagination()

        XCTAssertEqual(store.items.map(\.title), ["Recovered"])
        let queries = await service.recordedQueries()
        XCTAssertEqual(queries.map(\.cursor), [nil, "cursor-1", nil])
    }

    func testSelectedFiltersAreServerOnlyAndNeverRefilterReturnedItems() async throws {
        let serverResult = try Self.event(id: 1, title: "Server truth", category: "walk")
        let service = TestDiscoveryService { _, _ in Self.page(items: [serverResult]) }
        let store = DiscoveryStore(service: service, cache: TestDiscoveryCache())
        store.category = "music"

        await store.loadInitial()

        XCTAssertEqual(store.items.map(\.title), ["Server truth"])
        let queries = await service.recordedQueries()
        XCTAssertEqual(queries.last?.category, "music")
    }

    func testSettledMapBoundsAreForwardedToTheServer() async throws {
        let service = TestDiscoveryService { _, _ in Self.page(items: []) }
        let store = DiscoveryStore(
            service: service,
            cache: TestDiscoveryCache(),
            debounce: .milliseconds(15)
        )
        let bounds = MapBounds(west: 139.6, south: 35.5, east: 139.9, north: 35.8)

        store.mapBoundsDidSettle(bounds)
        try await Task.sleep(for: .milliseconds(80))

        let queries = await service.recordedQueries()
        XCTAssertEqual(queries.last?.bounds, bounds)
        XCTAssertEqual(store.mapCameraRevision, 0)
    }

    func testSelectingRegionClearsStaleBoundsAndRequestsCameraRefitAfterReplacement() async throws {
        let osaka = try Self.event(
            id: 1,
            title: "Osaka",
            coordinate: ["latitude": 34.6937, "longitude": 135.5023, "precision": "approximate"]
        )
        let service = TestDiscoveryService { query, _ in
            XCTAssertEqual(query.region, "osaka")
            XCTAssertNil(query.bounds)
            return Self.page(items: [osaka])
        }
        let store = DiscoveryStore(
            service: service,
            cache: TestDiscoveryCache(),
            debounce: .milliseconds(10)
        )
        store.bounds = MapBounds(west: 139.6, south: 35.5, east: 139.9, north: 35.8)
        let initialRevision = store.mapCameraRevision

        store.selectRegion("osaka")

        XCTAssertEqual(store.region, "osaka")
        XCTAssertNil(store.bounds)
        XCTAssertEqual(store.mapCameraRevision, initialRevision)

        try await Task.sleep(for: .milliseconds(80))

        let queries = await service.recordedQueries()
        XCTAssertEqual(queries.count, 1)
        XCTAssertEqual(queries.last?.region, "osaka")
        XCTAssertNil(queries.last?.bounds)
        XCTAssertEqual(store.mapEvents.map(\.title), ["Osaka"])
        XCTAssertEqual(store.mapCameraRevision, initialRevision + 1)
    }

    func testRegionCameraRefitPendingSurvivesRetryableFailureAndAdvancesOnceAfterRetry() async throws {
        let osaka = try Self.event(
            id: 1,
            title: "Osaka retry",
            coordinate: ["latitude": 34.6937, "longitude": 135.5023, "precision": "approximate"]
        )
        let service = TestDiscoveryService { query, requestNumber in
            XCTAssertEqual(query.region, "osaka")
            XCTAssertNil(query.bounds)
            if requestNumber == 1 {
                throw URLError(.networkConnectionLost)
            }
            return Self.page(items: [osaka])
        }
        let store = DiscoveryStore(
            service: service,
            cache: TestDiscoveryCache(),
            debounce: .milliseconds(10)
        )
        store.bounds = MapBounds(west: 139.6, south: 35.5, east: 139.9, north: 35.8)

        store.selectRegion("osaka")
        try await Task.sleep(for: .milliseconds(80))

        XCTAssertEqual(store.mapCameraRevision, 0)
        XCTAssertEqual(store.fatalError?.id, "NETWORK_UNAVAILABLE")
        XCTAssertTrue(store.fatalError?.retryable == true)

        await store.refresh()

        XCTAssertEqual(store.mapCameraRevision, 1)
        XCTAssertEqual(store.mapEvents.map(\.title), ["Osaka retry"])

        await store.refresh()

        XCTAssertEqual(
            store.mapCameraRevision,
            1,
            "A settled region intent must be consumed after its authoritative retry succeeds"
        )
        let queries = await service.recordedQueries()
        XCTAssertEqual(queries.count, 3)
    }

    func testSessionResetClearsPendingRegionRefitBeforeOldAndSameRegionResultsArrive() async throws {
        let firstRequestStarted = expectation(description: "region replacement started")
        let osaka = try Self.event(
            id: 1,
            title: "Osaka after reset",
            coordinate: ["latitude": 34.6937, "longitude": 135.5023, "precision": "approximate"]
        )
        let service = TestDiscoveryService { _, requestNumber in
            if requestNumber == 1 {
                firstRequestStarted.fulfill()
                try? await Task.sleep(for: .milliseconds(120))
            }
            return Self.page(items: [osaka])
        }
        let store = DiscoveryStore(
            service: service,
            cache: TestDiscoveryCache(),
            debounce: .milliseconds(5)
        )

        store.selectRegion("osaka")
        await fulfillment(of: [firstRequestStarted], timeout: 1)
        store.resetForSessionChange()
        await store.refresh()
        try await Task.sleep(for: .milliseconds(40))

        XCTAssertEqual(store.mapCameraRevision, 0)
        let queries = await service.recordedQueries()
        XCTAssertEqual(queries.count, 2)
        XCTAssertTrue(queries.allSatisfy { $0.region == "osaka" && $0.bounds == nil })
    }

    func testFixtureReplacementClearsPendingRegionRefitAndRejectsTheOldResponse() async throws {
        let firstRequestStarted = expectation(description: "region replacement started")
        let stale = try Self.event(
            id: 1,
            title: "Stale Osaka",
            coordinate: ["latitude": 34.6937, "longitude": 135.5023, "precision": "approximate"]
        )
        let fixture = try Self.event(
            id: 2,
            title: "Fixture Osaka",
            coordinate: ["latitude": 34.7000, "longitude": 135.4900, "precision": "approximate"]
        )
        let service = TestDiscoveryService { _, _ in
            firstRequestStarted.fulfill()
            try? await Task.sleep(for: .milliseconds(120))
            return Self.page(items: [stale])
        }
        let store = DiscoveryStore(
            service: service,
            cache: TestDiscoveryCache(),
            debounce: .milliseconds(5)
        )

        store.selectRegion("osaka")
        await fulfillment(of: [firstRequestStarted], timeout: 1)
        store.replaceWithFixture([fixture])
        await store.refresh()
        try await Task.sleep(for: .milliseconds(40))

        XCTAssertEqual(store.mapCameraRevision, 0)
        XCTAssertEqual(store.items.map(\.title), ["Fixture Osaka"])
        let queryCount = await service.recordedQueryCount()
        XCTAssertEqual(queryCount, 1)
    }

    func testWorldSizedMapBoundsAreIgnoredInsteadOfReplacingDiscoveryResults() async throws {
        let service = TestDiscoveryService { _, _ in Self.page(items: []) }
        let store = DiscoveryStore(
            service: service,
            cache: TestDiscoveryCache(),
            debounce: .milliseconds(10)
        )

        store.mapBoundsDidSettle(.init(west: -180, south: -85, east: 180, north: 85))
        try await Task.sleep(for: .milliseconds(80))

        XCTAssertNil(store.bounds)
        let queryCount = await service.recordedQueryCount()
        XCTAssertEqual(queryCount, 0)
    }

    func testMapViewportFitsOnlyRealServerCoordinatesWithoutInventingAFallbackLocation() throws {
        let first = try Self.event(
            id: 1,
            title: "East",
            coordinate: ["latitude": 35.68, "longitude": 139.80, "precision": "approximate"]
        )
        let second = try Self.event(
            id: 2,
            title: "West",
            coordinate: ["latitude": 35.66, "longitude": 139.67, "precision": "approximate"]
        )
        let missing = try Self.event(id: 3, title: "Private", coordinate: nil)

        let viewport = try XCTUnwrap(DiscoveryMapViewport.fitting([first, missing, second]))

        XCTAssertEqual(viewport.centerLatitude, 35.67, accuracy: 0.000_01)
        XCTAssertEqual(viewport.centerLongitude, 139.735, accuracy: 0.000_01)
        XCTAssertGreaterThanOrEqual(viewport.latitudeDelta, 0.06)
        XCTAssertGreaterThan(viewport.longitudeDelta, 0.13)
        XCTAssertNil(DiscoveryMapViewport.fitting([missing]))
    }

    func testCachedContentSurvivesRefreshFailureAsAnOfflineState() async throws {
        let cached = try Self.event(id: 1, title: "Cached")
        let service = TestDiscoveryService { _, _ in throw URLError(.notConnectedToInternet) }
        let cache = TestDiscoveryCache(cached: [cached])
        let store = DiscoveryStore(service: service, cache: cache)

        await store.loadInitial()

        XCTAssertEqual(store.items.map(\.title), ["Cached"])
        XCTAssertEqual(store.phase, .offline)
        XCTAssertEqual(store.refreshError?.id, "NETWORK_UNAVAILABLE")
    }

    func testFilteredInitialLoadDoesNotDisplayTheCanonicalCache() async throws {
        let cached = try Self.event(id: 1, title: "Cached baseline")
        let store = DiscoveryStore(
            service: TestDiscoveryService { _, _ in throw URLError(.notConnectedToInternet) },
            cache: TestDiscoveryCache(cached: [cached])
        )
        store.category = "music"

        await store.loadInitial()

        XCTAssertTrue(store.items.isEmpty)
        XCTAssertEqual(store.phase, .error)
    }

    func testChangingLocaleRebuildsKnownDiscoveryErrorsWithoutAnotherRequest() async {
        let service = TestDiscoveryService { _, _ in throw URLError(.notConnectedToInternet) }
        let store = DiscoveryStore(
            service: service,
            cache: TestDiscoveryCache(),
            locale: Locale(identifier: "zh-Hans")
        )

        await store.loadInitial()
        XCTAssertEqual(store.fatalError?.message, "暂时无法连接 Spott，请检查网络后重试。")

        store.updateLocale(Locale(identifier: "en"))

        XCTAssertEqual(
            store.fatalError?.message,
            "Unable to connect to Spott. Check your network and try again."
        )
        let queryCount = await service.recordedQueryCount()
        XCTAssertEqual(queryCount, 1)
    }

    func testDiscoveryAPIErrorUsesLocalizedSafeCopyAndNeverServerMessage() async {
        let diagnostic = "SQLSTATE 42P01 registrations_internal request_id=secret"
        let service = TestDiscoveryService { _, _ in
            throw APIError(
                status: 500,
                code: "DISCOVERY_QUERY_FAILED",
                message: diagnostic,
                retryable: true
            )
        }
        let store = DiscoveryStore(
            service: service,
            cache: TestDiscoveryCache(),
            locale: Locale(identifier: "zh-Hans")
        )

        await store.loadInitial()

        XCTAssertEqual(store.fatalError?.id, "DISCOVERY_QUERY_FAILED")
        XCTAssertTrue(store.fatalError?.retryable == true)
        XCTAssertEqual(store.fatalError?.message, "请求暂时无法完成。")
        XCTAssertFalse(store.fatalError?.message.contains(diagnostic) == true)

        store.updateLocale(Locale(identifier: "ja"))
        XCTAssertEqual(store.fatalError?.message, "現在リクエストを完了できません。")
        XCTAssertFalse(store.fatalError?.message.contains(diagnostic) == true)

        store.updateLocale(Locale(identifier: "en"))
        XCTAssertEqual(store.fatalError?.message, "Unable to complete the request right now.")
        XCTAssertFalse(store.fatalError?.message.contains(diagnostic) == true)
        XCTAssertEqual(store.fatalError?.id, "DISCOVERY_QUERY_FAILED")
        XCTAssertTrue(store.fatalError?.retryable == true)
        let queryCount = await service.recordedQueryCount()
        XCTAssertEqual(queryCount, 1)
    }

    func testFilteredResultsDoNotOverwriteTheCanonicalCache() async throws {
        let baseline = try Self.event(id: 1, title: "Cached baseline")
        let filtered = try Self.event(id: 2, title: "Filtered")
        let cache = TestDiscoveryCache(cached: [baseline])
        let store = DiscoveryStore(
            service: TestDiscoveryService { _, _ in Self.page(items: [filtered]) },
            cache: cache
        )
        store.category = "music"

        await store.loadInitial()

        let persisted = await cache.storedEvents()
        XCTAssertEqual(persisted.map(\.title), ["Cached baseline"])
    }

    func testCanonicalCachePersistsOnlyAPublicViewerNeutralProjection() async throws {
        let personalized = try Self.personalizedEvent(id: 1, title: "Personalized")
        let cache = TestDiscoveryCache()
        let store = DiscoveryStore(
            service: TestDiscoveryService { _, _ in Self.page(items: [personalized]) },
            cache: cache
        )

        await store.loadInitial()

        XCTAssertNotNil(store.items.first?.viewerRegistration)
        XCTAssertTrue(store.items.first?.favorited == true)
        let cachedEvents = await cache.storedEvents()
        let persisted = try XCTUnwrap(cachedEvents.first)
        XCTAssertNil(persisted.viewerRegistration)
        XCTAssertNil(persisted.registrationStatus)
        XCTAssertFalse(persisted.favorited)
        XCTAssertFalse(persisted.organizer.viewerFollowing)
        XCTAssertTrue(persisted.availableActions.isEmpty)
    }

    func testLegacyCachedViewerStateIsStrippedBeforeOfflineDisplay() async throws {
        let personalized = try Self.personalizedEvent(id: 1, title: "Legacy personalized")
        let cache = TestDiscoveryCache(cached: [personalized])
        let store = DiscoveryStore(
            service: TestDiscoveryService { _, _ in throw URLError(.notConnectedToInternet) },
            cache: cache
        )

        await store.loadInitial()

        let displayed = try XCTUnwrap(store.items.first)
        XCTAssertNil(displayed.viewerRegistration)
        XCTAssertNil(displayed.registrationStatus)
        XCTAssertFalse(displayed.favorited)
        XCTAssertFalse(displayed.organizer.viewerFollowing)
        XCTAssertTrue(displayed.availableActions.isEmpty)
        let rewrittenCache = await cache.storedEvents()
        let persisted = try XCTUnwrap(rewrittenCache.first)
        XCTAssertNil(persisted.viewerRegistration)
        XCTAssertNil(persisted.registrationStatus)
        XCTAssertFalse(persisted.favorited)
        XCTAssertFalse(persisted.organizer.viewerFollowing)
        XCTAssertTrue(persisted.availableActions.isEmpty)
    }

    func testSigningOutRemovesViewerStateFromInMemoryDiscoveryAndRouterCache() throws {
        let personalized = try Self.personalizedEvent(id: 1, title: "Signed in")
        let model = AppModel.preview
        model.discovery.replaceWithFixture([personalized])
        model.show(event: personalized)
        let reference = EventRouteReference(event: personalized)
        XCTAssertNil(model.router.cachedEvent(for: reference)?.viewerRegistration)

        model.signOut()

        let displayed = try XCTUnwrap(model.discovery.items.first)
        XCTAssertNil(displayed.viewerRegistration)
        XCTAssertNil(displayed.registrationStatus)
        XCTAssertFalse(displayed.favorited)
        XCTAssertFalse(displayed.organizer.viewerFollowing)
        XCTAssertTrue(displayed.availableActions.isEmpty)
        XCTAssertNil(model.router.cachedEvent(for: reference))
    }

    func testRouterEventSnapshotsAreAlwaysPublicAndViewerNeutral() throws {
        var personalized = try Self.personalizedEvent(id: 1, title: "Private route")
        personalized.organizerContact = try OrganizerContact(
            kind: .email,
            label: "Host",
            value: "host@example.com"
        )
        personalized.exactAddress = "東京都千代田区1-1"
        personalized.coordinate = .init(
            latitude: 35.681236,
            longitude: 139.767125,
            precision: .exact
        )
        let router = AppRouter()
        let reference = EventRouteReference(event: personalized)

        router.show(event: personalized)
        assertViewerNeutral(router.cachedEvent(for: reference))

        router.cache(event: personalized)
        assertViewerNeutral(router.cachedEvent(for: reference))

        router.deferRegistration(
            for: personalized,
            action: .register,
            requiring: .login
        )
        assertViewerNeutral(router.cachedEvent(for: reference))
    }

    func testSwitchingAccountsClearsPersonalizedDiscoveryAndRouterCache() throws {
        let personalized = try Self.personalizedEvent(id: 1, title: "First account")
        let model = AppModel.preview
        model.discovery.replaceWithFixture([personalized])
        model.show(event: personalized)
        let reference = EventRouteReference(event: personalized)
        let previous = try XCTUnwrap(model.session)
        let replacement = UserSession(
            accessToken: "replacement-access",
            refreshToken: "replacement-refresh",
            sessionId: UUID(),
            accessTokenExpiresAt: previous.accessTokenExpiresAt,
            user: .init(
                id: UUID(),
                publicHandle: "replacement",
                phoneVerified: true,
                restrictions: []
            )
        )

        model.didAuthenticate(replacement)

        let displayed = try XCTUnwrap(model.discovery.items.first)
        XCTAssertNil(displayed.viewerRegistration)
        XCTAssertNil(displayed.registrationStatus)
        XCTAssertFalse(displayed.favorited)
        XCTAssertFalse(displayed.organizer.viewerFollowing)
        XCTAssertTrue(displayed.availableActions.isEmpty)
        XCTAssertNil(model.router.cachedEvent(for: reference))
    }

    private func assertViewerNeutral(
        _ event: EventSummary?,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        guard let event else {
            XCTFail("Expected a cached public event snapshot", file: file, line: line)
            return
        }
        XCTAssertNil(event.viewerRegistration, file: file, line: line)
        XCTAssertNil(event.registrationStatus, file: file, line: line)
        XCTAssertFalse(event.favorited, file: file, line: line)
        XCTAssertTrue(event.availableActions.isEmpty, file: file, line: line)
        XCTAssertFalse(event.organizer.viewerFollowing, file: file, line: line)
        XCTAssertNil(event.organizerContact, file: file, line: line)
        XCTAssertNil(event.exactAddress, file: file, line: line)
        XCTAssertNil(event.coordinate, file: file, line: line)
        XCTAssertNil(event.attendeeRequirements, file: file, line: line)
        XCTAssertNil(event.riskFlags, file: file, line: line)
        XCTAssertNil(event.riskDetails, file: file, line: line)
        XCTAssertNil(event.checkinMode, file: file, line: line)
        XCTAssertNil(event.commentPermission, file: file, line: line)
        XCTAssertNil(event.posterEnabled, file: file, line: line)
        XCTAssertNil(event.exactAddressVisibility, file: file, line: line)
    }

    func testEmptyAndFatalErrorHaveDistinctStates() async {
        let emptyStore = DiscoveryStore(
            service: TestDiscoveryService { _, _ in Self.page(items: []) },
            cache: TestDiscoveryCache()
        )
        await emptyStore.loadInitial()
        XCTAssertEqual(emptyStore.phase, .empty)

        let errorStore = DiscoveryStore(
            service: TestDiscoveryService { _, _ in throw APIError(
                status: 503,
                code: "DISCOVERY_DOWN",
                message: "Unavailable",
                retryable: true
            ) },
            cache: TestDiscoveryCache()
        )
        await errorStore.loadInitial()
        XCTAssertEqual(errorStore.phase, .error)
        XCTAssertEqual(errorStore.fatalError?.id, "DISCOVERY_DOWN")
    }

    func testAnnotationSourceUsesOnlyServerCoordinates() async throws {
        let mapped = try Self.event(
            id: 1,
            title: "Mapped",
            coordinate: ["latitude": 35.68, "longitude": 139.80, "precision": "approximate"]
        )
        let unmapped = try Self.event(id: 2, title: "Unmapped", coordinate: nil)
        let store = DiscoveryStore(
            service: TestDiscoveryService { _, _ in Self.page(items: [mapped, unmapped]) },
            cache: TestDiscoveryCache()
        )

        await store.loadInitial()

        XCTAssertEqual(store.mapEvents.map(\.title), ["Mapped"])
        XCTAssertEqual(store.mapEvents.first?.coordinate?.latitude, 35.68)
    }

    func testPublicNavigationFixtureNeverFallsThroughToTheNetwork() async throws {
        let fixture = try Self.event(
            id: 1,
            title: "Fixture",
            coordinate: ["latitude": 35.68, "longitude": 139.80, "precision": "approximate"]
        )
        let service = TestDiscoveryService { _, _ in Self.page(items: []) }
        let store = DiscoveryStore(
            service: service,
            cache: TestDiscoveryCache(),
            debounce: .milliseconds(10)
        )
        store.replaceWithFixture([fixture])

        store.searchText = "camera update"
        store.searchDidChange()
        store.mapBoundsDidSettle(.init(west: 139.6, south: 35.5, east: 139.9, north: 35.8))
        try await Task.sleep(for: .milliseconds(80))

        let queryCount = await service.recordedQueryCount()
        XCTAssertEqual(queryCount, 0)
        XCTAssertEqual(store.items.map(\.title), ["Fixture"])
    }

    func testDiscoveryPageStripsDetailOnlyAndExactLocationFields() throws {
        let unsafe = try Self.eventObject(
            id: 1,
            title: "Unsafe",
            coordinate: ["latitude": 35.681236, "longitude": 139.767125, "precision": "exact"]
        )
        var event = unsafe
        event["exactAddress"] = "東京都千代田区1-1"
        event["attendeeRequirements"] = "Private joining instructions"
        event["riskFlags"] = ["manual_review"]
        event["riskDetails"] = ["note": "detail only"]
        event["checkinMode"] = "qr"
        event["commentPermission"] = "attendees"
        event["posterEnabled"] = true
        event["exactAddressVisibility"] = "confirmed"
        let object: [String: Any] = [
            "items": [event],
            "nextCursor": NSNull(),
            "hasMore": false,
            "serverTime": "2026-07-16T00:00:00Z",
            "queryExplanationId": "privacy-test",
            "joinInstructions": "unknown forward-compatible field",
        ]
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        let page = try decoder.decode(
            DiscoveryPage.self,
            from: JSONSerialization.data(withJSONObject: object)
        )
        let summary = try XCTUnwrap(page.items.first)

        XCTAssertNil(summary.coordinate)
        XCTAssertNil(summary.exactAddress)
        XCTAssertNil(summary.attendeeRequirements)
        XCTAssertNil(summary.riskFlags)
        XCTAssertNil(summary.riskDetails)
        XCTAssertNil(summary.checkinMode)
        XCTAssertNil(summary.commentPermission)
        XCTAssertNil(summary.posterEnabled)
        XCTAssertNil(summary.exactAddressVisibility)
    }

    nonisolated private static func page(
        items: [EventSummary],
        nextCursor: String? = nil,
        hasMore: Bool = false
    ) -> DiscoveryPage {
        DiscoveryPage(
            items: items,
            nextCursor: nextCursor,
            hasMore: hasMore,
            serverTime: Date(timeIntervalSince1970: 1_773_792_000),
            queryExplanationId: "test"
        )
    }

    nonisolated private static func event(
        id: Int,
        title: String,
        category: String = "walk",
        coordinate: [String: Any]? = nil
    ) throws -> EventSummary {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(
            EventSummary.self,
            from: JSONSerialization.data(
                withJSONObject: try eventObject(id: id, title: title, category: category, coordinate: coordinate)
            )
        )
    }

    nonisolated private static func eventObject(
        id: Int,
        title: String,
        category: String = "walk",
        coordinate: [String: Any]? = nil
    ) throws -> [String: Any] {
        var payload = eventPayload(overrides: [
            "id": String(format: "019b0000-0000-7000-8100-%012d", id),
            "publicSlug": "event-\(id)",
            "title": title,
            "category": category,
            "tags": [category],
        ])
        payload["coordinate"] = coordinate ?? NSNull()
        return payload
    }

    nonisolated private static func personalizedEvent(id: Int, title: String) throws -> EventSummary {
        var payload = try eventObject(id: id, title: title)
        payload["favorited"] = true
        payload["registrationStatus"] = "confirmed"
        payload["viewerRegistration"] = [
            "id": "019b0000-0000-7000-8200-000000000001",
            "status": "confirmed",
            "partySize": 2,
            "offerExpiresAt": NSNull(),
        ]
        payload["availableActions"] = ["viewTicket"]
        if var organizer = payload["organizer"] as? [String: Any] {
            organizer["viewerFollowing"] = true
            payload["organizer"] = organizer
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(
            EventSummary.self,
            from: JSONSerialization.data(withJSONObject: payload)
        )
    }
}

private actor TestDiscoveryService: DiscoveryServing {
    typealias Handler = @Sendable (EventDiscoveryQuery, Int) async throws -> DiscoveryPage

    private let handler: Handler
    private var queries: [EventDiscoveryQuery] = []

    init(handler: @escaping Handler) {
        self.handler = handler
    }

    func discovery(_ query: EventDiscoveryQuery) async throws -> DiscoveryPage {
        queries.append(query)
        return try await handler(query, queries.count)
    }

    func recordedQueries() -> [EventDiscoveryQuery] { queries }
    func recordedQueryCount() -> Int { queries.count }
}

private actor TestDiscoveryCache: DiscoveryCaching {
    private var cached: [EventSummary]

    init(cached: [EventSummary] = []) {
        self.cached = cached
    }

    func cachedEvents() async throws -> [EventSummary] { cached }
    func replaceEvents(_ events: [EventSummary]) async throws { cached = events }
    func storedEvents() -> [EventSummary] { cached }
}
