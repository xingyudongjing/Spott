import Foundation
import XCTest
@testable import Spott

@MainActor
final class DiscoveryFeedStoreTests: XCTestCase {
    // MARK: - Layout rules (spec §3 module downgrade rules)

    func testModulesWithFewerThanThreeItemsAreHiddenEntirely() async throws {
        let store = try await loadedStore(modules: [
            ("today", 5),
            ("weekend", 2),
            ("new_events", 3),
        ])

        let layout = store.layout(locationAuthorized: false, locationUndetermined: false)

        XCTAssertEqual(layout.slots.map(\.id), ["hero.today", "shelf.new_events"])
    }

    func testFewerThanTwoRenderableModulesSkipsEveryShelf() async throws {
        let store = try await loadedStore(modules: [
            ("today", 5),
            ("weekend", 1),
        ])

        let layout = store.layout(locationAuthorized: false, locationUndetermined: false)

        XCTAssertTrue(layout.slots.isEmpty)
        XCTAssertTrue(layout.renderedEventIDs.isEmpty, "hidden modules must not dedupe the flat list")
    }

    func testHeroTakesTheFirstRenderableModuleAndDedupesOnlyItsVisibleItems() async throws {
        let store = try await loadedStore(modules: [
            ("today", 8),
            ("weekend", 4),
        ])

        let layout = store.layout(locationAuthorized: false, locationUndetermined: false)

        XCTAssertEqual(layout.slots.first?.id, "hero.today")
        // Hero renders at most 5 cards; the 3 overflow events must stay in the
        // flat list, so only 5 + 4 ids are deduped.
        XCTAssertEqual(layout.renderedEventIDs.count, DiscoveryFeedStore.heroItemLimit + 4)
    }

    func testNearbyModuleRequiresLocationAuthorization() async throws {
        let store = try await loadedStore(modules: [
            ("today", 3),
            ("nearby_hot", 4),
            ("weekend", 3),
        ])

        let authorized = store.layout(locationAuthorized: true, locationUndetermined: false)
        XCTAssertEqual(
            authorized.slots.map(\.id),
            ["hero.today", "shelf.nearby_hot", "shelf.weekend"]
        )

        let undetermined = store.layout(locationAuthorized: false, locationUndetermined: true)
        XCTAssertEqual(
            undetermined.slots.map(\.id),
            ["hero.today", "nearby-prompt", "shelf.weekend"],
            "notDetermined replaces the nearby shelf with the enable-location prompt row"
        )

        let denied = store.layout(locationAuthorized: false, locationUndetermined: false)
        XCTAssertEqual(
            denied.slots.map(\.id),
            ["hero.today", "shelf.weekend"],
            "denied hides the nearby section entirely"
        )
    }

    func testServerModuleOrderIsRespected() async throws {
        let store = try await loadedStore(
            modules: [("weekend", 3), ("today", 3)],
            moduleOrder: ["today", "weekend"]
        )

        let layout = store.layout(locationAuthorized: false, locationUndetermined: false)

        XCTAssertEqual(layout.slots.map(\.id), ["hero.today", "shelf.weekend"])
    }

    // MARK: - Failure & offline snapshot (spec §3 加载/离线, §8-3)

    func testFeedFailureWithoutSnapshotBecomesUnavailableAndNeverThrows() async throws {
        let store = DiscoveryFeedStore(
            service: TestFeedService(results: [.failure(URLError(.notConnectedToInternet))]),
            snapshotStore: DiscoveryFeedSnapshotStore(directory: emptyTemporaryDirectory())
        )

        await store.load(region: "tokyo", bounds: nil)

        XCTAssertEqual(store.phase, .unavailable)
        XCTAssertTrue(store.modules.isEmpty)
    }

    func testCanonicalFeedIsSnapshottedAndRestoredViewerNeutralAfterAnOfflineRelaunch() async throws {
        let directory = emptyTemporaryDirectory()
        let personalized = try personalizedEvent(id: 1)
        let modules = try (0 ..< 2).map { index in
            DiscoveryFeedModule(
                key: index == 0 ? "today" : "weekend",
                title: "Module \(index)",
                items: try (0 ..< 3).map { item in
                    DiscoveryFeedItem(
                        event: item == 0 && index == 0
                            ? personalized
                            : try event(id: index * 10 + item),
                        recommendation: nil
                    )
                }
            )
        }
        let warmStore = DiscoveryFeedStore(
            service: TestFeedService(results: [.success(feedResponse(modules: modules))]),
            snapshotStore: DiscoveryFeedSnapshotStore(directory: directory)
        )
        await warmStore.load(region: "tokyo", bounds: nil)
        XCTAssertEqual(warmStore.phase, .loaded)
        try await waitForSnapshotFile(in: directory)

        let coldStore = DiscoveryFeedStore(
            service: TestFeedService(results: [.failure(URLError(.notConnectedToInternet))]),
            snapshotStore: DiscoveryFeedSnapshotStore(directory: directory)
        )
        await coldStore.load(region: "tokyo", bounds: nil)

        XCTAssertEqual(coldStore.phase, .loaded)
        XCTAssertEqual(coldStore.modules.map(\.key), ["today", "weekend"])
        let restored = try XCTUnwrap(coldStore.modules.first?.items.first?.event)
        XCTAssertFalse(restored.favorited, "snapshot must be viewer-neutral")
        XCTAssertNil(restored.registrationStatus)
        XCTAssertNil(restored.viewerRegistration)
        XCTAssertNil(restored.exactAddress)
        XCTAssertFalse(restored.organizer.viewerFollowing)
        XCTAssertNil(coldStore.loadedRegion, "a restored snapshot must not suppress the next retry")
    }

    func testNonCanonicalFeedsAreNeverSnapshotted() async throws {
        let directory = emptyTemporaryDirectory()
        let modules = [try module(key: "today", ids: [1, 2, 3])]
        let store = DiscoveryFeedStore(
            service: TestFeedService(results: [.success(feedResponse(modules: modules))]),
            snapshotStore: DiscoveryFeedSnapshotStore(directory: directory)
        )

        await store.load(region: "osaka", bounds: nil)
        XCTAssertEqual(store.phase, .loaded)

        // Give any (incorrect) detached write a chance to land before asserting.
        try await Task.sleep(for: .milliseconds(120))
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: directory.appendingPathComponent("discovery-feed-snapshot-v1.json").path
            ),
            "only the tokyo/no-filter feed may be snapshotted"
        )
    }

    // MARK: - Session isolation

    func testSessionResetStripsFavoritesAndForcesAReload() async throws {
        let favorited = try personalizedEvent(id: 7)
        let modules = [
            DiscoveryFeedModule(
                key: "today",
                title: "Today",
                items: [
                    DiscoveryFeedItem(event: favorited, recommendation: nil),
                    DiscoveryFeedItem(event: try event(id: 8), recommendation: nil),
                    DiscoveryFeedItem(event: try event(id: 9), recommendation: nil),
                ]
            ),
        ]
        let store = DiscoveryFeedStore(
            service: TestFeedService(results: [.success(feedResponse(modules: modules))]),
            snapshotStore: DiscoveryFeedSnapshotStore(directory: emptyTemporaryDirectory())
        )
        await store.load(region: "tokyo", bounds: nil)
        XCTAssertEqual(store.loadedRegion, "tokyo")

        store.resetForSessionChange()

        XCTAssertNil(store.loadedRegion)
        XCTAssertEqual(
            store.modules.flatMap(\.items).filter(\.event.favorited),
            [],
            "favorites must never leak across sessions"
        )
    }

    // MARK: - Fixtures

    private func loadedStore(
        modules: [(key: String, count: Int)],
        moduleOrder: [String] = []
    ) async throws -> DiscoveryFeedStore {
        var nextID = 1
        let feedModules = try modules.map { descriptor in
            let items = try (0 ..< descriptor.count).map { _ in
                let item = DiscoveryFeedItem(event: try event(id: nextID), recommendation: nil)
                nextID += 1
                return item
            }
            return DiscoveryFeedModule(key: descriptor.key, title: descriptor.key, items: items)
        }
        let store = DiscoveryFeedStore(
            service: TestFeedService(results: [
                .success(feedResponse(modules: feedModules, moduleOrder: moduleOrder)),
            ]),
            snapshotStore: DiscoveryFeedSnapshotStore(directory: emptyTemporaryDirectory())
        )
        await store.load(region: "tokyo", bounds: nil)
        XCTAssertEqual(store.phase, .loaded)
        return store
    }

    private func module(key: String, ids: [Int]) throws -> DiscoveryFeedModule {
        DiscoveryFeedModule(
            key: key,
            title: key,
            items: try ids.map { DiscoveryFeedItem(event: try event(id: $0), recommendation: nil) }
        )
    }

    private func feedResponse(
        modules: [DiscoveryFeedModule],
        moduleOrder: [String] = []
    ) -> DiscoveryFeedResponse {
        DiscoveryFeedResponse(
            banner: nil,
            modules: modules,
            moduleOrder: moduleOrder,
            scoringVersion: "test",
            serverTime: Date(timeIntervalSince1970: 1_773_792_000),
            queryExplanationId: "test"
        )
    }

    private func event(id: Int) throws -> EventSummary {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(
            EventSummary.self,
            from: JSONSerialization.data(withJSONObject: eventPayload(overrides: [
                "id": String(format: "019b0000-0000-7000-8300-%012d", id),
                "publicSlug": "feed-event-\(id)",
                "title": "Feed Event \(id)",
            ]))
        )
    }

    private func personalizedEvent(id: Int) throws -> EventSummary {
        var payload = eventPayload(overrides: [
            "id": String(format: "019b0000-0000-7000-8300-%012d", id),
            "publicSlug": "feed-event-\(id)",
            "title": "Feed Event \(id)",
            "favorited": true,
            "registrationStatus": "confirmed",
            "viewerRegistration": [
                "id": "019b0000-0000-7000-8400-000000000001",
                "status": "confirmed",
                "partySize": 1,
                "offerExpiresAt": NSNull(),
            ] as [String: Any],
            "availableActions": ["viewTicket"],
        ])
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

    private func emptyTemporaryDirectory() -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("discovery-feed-tests-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock {
            try? FileManager.default.removeItem(at: url)
        }
        return url
    }

    private func waitForSnapshotFile(in directory: URL) async throws {
        let fileURL = directory.appendingPathComponent("discovery-feed-snapshot-v1.json")
        let deadline = Date().addingTimeInterval(5)
        while !FileManager.default.fileExists(atPath: fileURL.path) {
            guard Date() < deadline else {
                return XCTFail("feed snapshot was never written")
            }
            try await Task.sleep(for: .milliseconds(20))
        }
    }
}

private actor TestFeedService: DiscoveryFeedServing {
    private var results: [Result<DiscoveryFeedResponse, Error>]

    init(results: [Result<DiscoveryFeedResponse, Error>]) {
        self.results = results
    }

    func discoveryFeed(query: EventDiscoveryQuery) async throws -> DiscoveryFeedResponse {
        guard !results.isEmpty else { throw URLError(.cancelled) }
        return try results.removeFirst().get()
    }
}
