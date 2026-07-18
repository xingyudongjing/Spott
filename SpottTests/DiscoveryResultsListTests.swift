import Foundation
import XCTest
@testable import Spott

@MainActor
final class DiscoveryResultsListTests: XCTestCase {
    func testBannerOnlyFeedRendersTheOperationalEventOnTheFirstScreen() async throws {
        let bannerEvent = try makeEvent(title: "Tonight in Shimokitazawa")
        let banner = DiscoveryOperationalBanner(
            label: "Tonight",
            kind: "event",
            promotional: true,
            headline: "A small gathering worth leaving home for",
            imageURL: nil,
            event: bannerEvent
        )
        let store = DiscoveryStore(
            service: BannerOnlyDiscoveryService(banner: banner),
            cache: EmptyDiscoveryCache(),
            locale: Locale(identifier: "en")
        )

        _ = await store.loadInitial()

        XCTAssertEqual(store.phase, .content)
        XCTAssertTrue(store.items.isEmpty)
        XCTAssertTrue(store.recommendationSections.isEmpty)
        XCTAssertEqual(store.operationalBanner?.event.id, bannerEvent.id)

        let layout = DiscoveryResultsContentLayout(
            operationalBanner: store.operationalBanner,
            recommendationSections: store.recommendationSections
        )
        XCTAssertEqual(
            layout.firstScreenBanner?.event.id,
            bannerEvent.id,
            "The banner-only content state must put its operational event on the first screen."
        )
    }

    private func makeEvent(title: String) throws -> EventSummary {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(
            EventSummary.self,
            from: JSONSerialization.data(withJSONObject: eventPayload(overrides: ["title": title]))
        )
    }
}

private struct BannerOnlyDiscoveryService: DiscoveryServing, DiscoveryFeedServing {
    let banner: DiscoveryOperationalBanner

    func discovery(_ query: EventDiscoveryQuery) async throws -> DiscoveryPage {
        DiscoveryPage(
            items: [],
            nextCursor: nil,
            hasMore: false,
            serverTime: Date(timeIntervalSince1970: 1_773_792_000),
            queryExplanationId: "banner-only-search-test"
        )
    }

    func discoveryFeed(_ query: EventDiscoveryQuery) async throws -> DiscoveryFeed {
        DiscoveryFeed(
            banner: banner,
            modules: [],
            moduleOrder: [],
            weights: ["freshness": 1],
            scoringVersion: "v1",
            naturalResultsMinRatio: 0.6,
            serverTime: Date(timeIntervalSince1970: 1_773_792_000),
            generatedAt: Date(timeIntervalSince1970: 1_773_792_000),
            queryExplanationId: "banner-only-feed-test"
        )
    }
}

private actor EmptyDiscoveryCache: DiscoveryCaching {
    func cachedEvents() async throws -> [EventSummary] { [] }
    func replaceEvents(_ events: [EventSummary]) async throws {}
}
