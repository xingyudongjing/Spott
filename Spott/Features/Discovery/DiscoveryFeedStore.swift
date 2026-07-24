import Foundation
import Observation

protocol DiscoveryFeedServing: Sendable {
    func discoveryFeed(query: EventDiscoveryQuery) async throws -> DiscoveryFeedResponse
}

extension SpottAPIClient: DiscoveryFeedServing {}

enum DiscoveryFeedPhase: Equatable, Sendable {
    case idle
    case loading
    case loaded
    case unavailable
}

enum DiscoveryFeedSlot: Identifiable {
    case hero(DiscoveryFeedModule)
    case shelf(DiscoveryFeedModule)
    case nearbyPrompt

    var id: String {
        switch self {
        case .hero(let module): "hero.\(module.key)"
        case .shelf(let module): "shelf.\(module.key)"
        case .nearbyPrompt: "nearby-prompt"
        }
    }
}

struct DiscoveryFeedLayout {
    let slots: [DiscoveryFeedSlot]
    let renderedEventIDs: Set<UUID>

    static let empty = DiscoveryFeedLayout(slots: [], renderedEventIDs: [])
}

/// Single-entry, viewer-neutral snapshot of the canonical (tokyo, unfiltered)
/// feed so a cold offline launch still shows the module home instead of a bare
/// list. Mirrors the sanitation rules of the canonical flat-list cache:
/// favorited / registration / follow state / exactAddress are stripped before
/// anything touches disk.
struct DiscoveryFeedSnapshotStore: Sendable {
    static let canonicalRegion = "tokyo"

    private let fileURL: URL

    init(directory: URL? = nil) {
        let base = directory
            ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        fileURL = base.appendingPathComponent("discovery-feed-snapshot-v1.json")
    }

    func load() -> [DiscoveryFeedModule]? {
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let modules = try? decoder.decode([DiscoveryFeedModule].self, from: data),
              !modules.isEmpty else { return nil }
        return modules
    }

    func save(_ modules: [DiscoveryFeedModule]) {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(modules) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }
}

@MainActor
@Observable
final class DiscoveryFeedStore {
    static let heroItemLimit = 5
    static let minimumModuleItems = 3
    static let nearbyModuleKey = "nearby_hot"

    private(set) var phase: DiscoveryFeedPhase = .idle
    private(set) var modules: [DiscoveryFeedModule] = []
    private(set) var boostedEventIDs: Set<UUID> = []
    private(set) var loadedRegion: String?

    @ObservationIgnored private let service: any DiscoveryFeedServing
    @ObservationIgnored private let snapshotStore: DiscoveryFeedSnapshotStore
    @ObservationIgnored private var generation = 0

    init(
        service: any DiscoveryFeedServing,
        snapshotStore: DiscoveryFeedSnapshotStore = DiscoveryFeedSnapshotStore()
    ) {
        self.service = service
        self.snapshotStore = snapshotStore
    }

    func loadIfNeeded(region: String, bounds: MapBounds?) async {
        guard loadedRegion != region || phase == .unavailable || phase == .idle else { return }
        await load(region: region, bounds: bounds)
    }

    func load(region: String, bounds: MapBounds?) async {
        generation += 1
        let requestGeneration = generation
        if modules.isEmpty { phase = .loading }
        let query = EventDiscoveryQuery(region: region, bounds: bounds)
        do {
            let response = try await service.discoveryFeed(query: query)
            guard requestGeneration == generation else { return }
            modules = Self.ordered(response.modules, order: response.moduleOrder)
            boostedEventIDs = Self.boostedIDs(in: modules)
            loadedRegion = region
            phase = .loaded
            persistSnapshotIfCanonical(region: region, bounds: bounds)
        } catch is CancellationError {
            return
        } catch {
            guard requestGeneration == generation else { return }
            // Keep the last good in-memory snapshot; a feed failure never
            // blocks the flat discovery list.
            if modules.isEmpty {
                await restoreSnapshotIfCanonical(
                    generation: requestGeneration,
                    region: region,
                    bounds: bounds
                )
            } else {
                phase = .loaded
            }
        }
    }

    func resetForSessionChange() {
        generation += 1
        modules = modules.map { module in
            DiscoveryFeedModule(
                key: module.key,
                title: module.title,
                items: module.items.map { item in
                    var event = item.event
                    event.favorited = false
                    return DiscoveryFeedItem(event: event, recommendation: item.recommendation)
                }
            )
        }
        loadedRegion = nil
        if modules.isEmpty { phase = .idle }
    }

    func layout(locationAuthorized: Bool, locationUndetermined: Bool) -> DiscoveryFeedLayout {
        let renderable = modules.filter { module in
            module.items.count >= Self.minimumModuleItems
                && (module.key != Self.nearbyModuleKey || locationAuthorized)
        }
        guard renderable.count >= 2 else { return .empty }

        var slots: [DiscoveryFeedSlot] = []
        var renderedEventIDs: Set<UUID> = []
        var heroAssigned = false
        for module in modules {
            let isRenderable = module.items.count >= Self.minimumModuleItems
                && (module.key != Self.nearbyModuleKey || locationAuthorized)
            if isRenderable {
                if heroAssigned {
                    slots.append(.shelf(module))
                    renderedEventIDs.formUnion(module.items.map(\.id))
                } else {
                    slots.append(.hero(module))
                    renderedEventIDs.formUnion(module.items.prefix(Self.heroItemLimit).map(\.id))
                    heroAssigned = true
                }
            } else if module.key == Self.nearbyModuleKey,
                      locationUndetermined,
                      module.items.count >= Self.minimumModuleItems {
                slots.append(.nearbyPrompt)
            }
        }
        return DiscoveryFeedLayout(slots: slots, renderedEventIDs: renderedEventIDs)
    }

    private func persistSnapshotIfCanonical(region: String, bounds: MapBounds?) {
        guard region == DiscoveryFeedSnapshotStore.canonicalRegion, bounds == nil else { return }
        let neutralModules = Self.viewerNeutral(modules)
        let store = snapshotStore
        Task.detached(priority: .utility) {
            store.save(neutralModules)
        }
    }

    private func restoreSnapshotIfCanonical(
        generation requestGeneration: Int,
        region: String,
        bounds: MapBounds?
    ) async {
        guard region == DiscoveryFeedSnapshotStore.canonicalRegion, bounds == nil else {
            phase = .unavailable
            return
        }
        let store = snapshotStore
        let restored = await Task.detached(priority: .utility) { store.load() }.value
        guard requestGeneration == generation else { return }
        guard let restored else {
            phase = .unavailable
            return
        }
        // The snapshot is viewer-neutral by construction; loadedRegion stays
        // nil so the next browse entry retries the network.
        modules = restored
        boostedEventIDs = Self.boostedIDs(in: restored)
        phase = .loaded
    }

    private static func boostedIDs(in modules: [DiscoveryFeedModule]) -> Set<UUID> {
        Set(
            modules.flatMap(\.items)
                .filter { $0.recommendation?.boosted == true }
                .map(\.id)
        )
    }

    private static func viewerNeutral(_ modules: [DiscoveryFeedModule]) -> [DiscoveryFeedModule] {
        modules.map { module in
            DiscoveryFeedModule(
                key: module.key,
                title: module.title,
                items: module.items.map { item in
                    DiscoveryFeedItem(
                        event: item.event.viewerNeutralDiscoverySummary,
                        recommendation: item.recommendation
                    )
                }
            )
        }
    }

    private static func ordered(
        _ modules: [DiscoveryFeedModule],
        order: [String]
    ) -> [DiscoveryFeedModule] {
        guard !order.isEmpty else { return modules }
        let rank = Dictionary(
            uniqueKeysWithValues: order.enumerated().map { ($0.element, $0.offset) }
        )
        return modules.enumerated().sorted { lhs, rhs in
            let left = rank[lhs.element.key] ?? (order.count + lhs.offset)
            let right = rank[rhs.element.key] ?? (order.count + rhs.offset)
            return left < right
        }.map(\.element)
    }
}

struct DiscoveryModuleDescriptor {
    enum SeeAllAction {
        case todayPreset
        case weekendPreset
        case nearbyMap
    }

    let eyebrowKey: String.LocalizationValue?
    let titleKey: String.LocalizationValue?
    let action: SeeAllAction?

    static func descriptor(forKey key: String) -> DiscoveryModuleDescriptor {
        switch key {
        case "today":
            .init(
                eyebrowKey: "discovery.module.today.eyebrow",
                titleKey: "discovery.module.today.title",
                action: .todayPreset
            )
        case "weekend":
            .init(
                eyebrowKey: "discovery.module.weekend.eyebrow",
                titleKey: "discovery.module.weekend.title",
                action: .weekendPreset
            )
        case DiscoveryFeedStore.nearbyModuleKey:
            .init(
                eyebrowKey: "discovery.module.nearby.eyebrow",
                titleKey: "discovery.module.nearby.title",
                action: .nearbyMap
            )
        case "interest":
            .init(
                eyebrowKey: "discovery.module.interest.eyebrow",
                titleKey: "discovery.module.interest.title",
                action: nil
            )
        case "new_events":
            .init(
                eyebrowKey: "discovery.module.new.eyebrow",
                titleKey: "discovery.module.new.title",
                action: nil
            )
        case "verified_hosts":
            .init(eyebrowKey: nil, titleKey: "discovery.module.verified.title", action: nil)
        case "followed_updates":
            .init(eyebrowKey: nil, titleKey: "discovery.module.followed.title", action: nil)
        default:
            .init(eyebrowKey: nil, titleKey: nil, action: nil)
        }
    }

    func title(serverTitle: String, locale: Locale) -> String {
        guard let titleKey else { return serverTitle }
        return DiscoveryHomeLocalization.text(titleKey, locale: locale)
    }

    func eyebrow(locale: Locale) -> String? {
        guard let eyebrowKey else { return nil }
        return DiscoveryHomeLocalization.text(eyebrowKey, locale: locale)
    }
}
