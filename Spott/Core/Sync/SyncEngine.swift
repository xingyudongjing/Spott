import Foundation

enum SyncReason: String, Sendable { case bootstrap, foreground, manual, realtimeHint, backgroundRefresh }
enum SensitiveResetReason: String, Sendable { case signOut, accountMerge, restrictionChanged }
struct SyncResult: Sendable { let applied: Int; let nextCursor: Int64; let hasMore: Bool }
struct FlushResult: Sendable { let applied: Int; let conflicts: Int; let failed: Int }

struct SyncChange: Codable, Sendable {
    let seq: Int64
    let topic: String?
    let entityType: String
    let entityId: UUID
    let operation: String
    let version: Int64
    let changedFields: [String]
    let payload: [String: JSONValue]
}

struct SyncPullPage: Codable, Sendable { let changes: [SyncChange]; let nextCursor: Int64; let hasMore: Bool; let serverTime: Date }

struct PendingOperation: Sendable {
    let operationID: UUID
    let entityType: String
    let entityID: UUID?
    let action: String
    let baseVersion: Int64?
    let payload: Data
    let dependencies: [UUID]
}

struct SyncPushOperation: Codable, Sendable {
    let operationId: UUID
    let entityType: String
    let entityId: UUID?
    let action: String
    let baseVersion: Int64?
    let payload: JSONValue
}

struct SyncPushResponse: Codable, Sendable {
    struct Result: Codable, Sendable { let operationId: UUID; let state: String; let result: JSONValue? }
    let results: [Result]
}

actor SyncEngine {
    private let api: SpottAPIClient
    private let persistence: PersistenceStore
    private var pulling = false
    private var pushing = false
    private var userID: UUID?
    private var latestHint: Int64 = 0
    private let topics = ["user", "profile", "event", "registration", "group", "wallet", "notification"]

    init(api: SpottAPIClient, persistence: PersistenceStore) { self.api = api; self.persistence = persistence }

    func bootstrap(userID: UUID) async throws {
        self.userID = userID
        _ = try await pull(reason: .bootstrap)
        _ = await flushPendingOperations()
    }

    func pull(reason: SyncReason) async throws -> SyncResult {
        guard !pulling else { return .init(applied: 0, nextCursor: try await persistence.cursor(scope: scope), hasMore: false) }
        pulling = true; defer { pulling = false }
        var cursor = try await persistence.cursor(scope: scope)
        var total = 0
        var hasMore = true
        while hasMore {
            let page = try await api.pull(cursor: cursor, topics: topics)
            try await persistence.apply(changes: page.changes, nextCursor: page.nextCursor, scope: scope)
            cursor = page.nextCursor; total += page.changes.count; hasMore = page.hasMore
            if reason == .backgroundRefresh && total >= 500 { break }
        }
        return .init(applied: total, nextCursor: cursor, hasMore: hasMore)
    }

    func enqueue(_ operation: PendingOperation) async throws { try await persistence.enqueue(operation) }

    func flushPendingOperations() async -> FlushResult {
        guard !pushing else { return .init(applied: 0, conflicts: 0, failed: 0) }
        pushing = true; defer { pushing = false }
        do {
            let pending = try await persistence.pendingOperations()
            let sorted = Self.topologicalSort(pending)
            let decoder = JSONDecoder()
            let payload = sorted.map { operation in SyncPushOperation(operationId: operation.operationID, entityType: operation.entityType, entityId: operation.entityID, action: operation.action, baseVersion: operation.baseVersion, payload: (try? decoder.decode(JSONValue.self, from: operation.payload)) ?? .object([:])) }
            guard !payload.isEmpty else { return .init(applied: 0, conflicts: 0, failed: 0) }
            let response = try await api.push(operations: payload)
            let applied = Set(response.results.filter { $0.state == "applied" }.map(\.operationId))
            try await persistence.markApplied(operationIDs: applied)
            return .init(applied: applied.count, conflicts: response.results.filter { $0.state == "conflict" }.count, failed: response.results.filter { $0.state == "failed" }.count)
        } catch { return .init(applied: 0, conflicts: 0, failed: 1) }
    }

    func handleRealtimeHint(sequence: Int64) async {
        guard sequence > latestHint else { return }
        latestHint = sequence
        _ = try? await pull(reason: .realtimeHint)
    }

    func resetSensitiveScope(reason: SensitiveResetReason) async throws {
        _ = reason
        userID = nil; latestHint = 0
        try await persistence.resetSensitive()
    }

    private var scope: String { userID?.uuidString.lowercased() ?? "public" }

    static func topologicalSort(_ operations: [PendingOperation]) -> [PendingOperation] {
        var result: [PendingOperation] = []
        var remaining = Dictionary(uniqueKeysWithValues: operations.map { ($0.operationID, $0) })
        while !remaining.isEmpty {
            let ready = remaining.values.filter { operation in operation.dependencies.allSatisfy { remaining[$0] == nil } }.sorted { $0.operationID.uuidString < $1.operationID.uuidString }
            if ready.isEmpty { return result + remaining.values.sorted { $0.operationID.uuidString < $1.operationID.uuidString } }
            for operation in ready { result.append(operation); remaining.removeValue(forKey: operation.operationID) }
        }
        return result
    }
}
