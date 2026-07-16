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

protocol SyncServing: Actor {
    func pull(cursor: Int64, topics: [String]) async throws -> SyncPullPage
    func push(operations: [SyncPushOperation]) async throws -> SyncPushResponse
}

extension SpottAPIClient: SyncServing {}

protocol SyncPersisting: Actor {
    func cursor(scope: String) throws -> Int64
    func apply(changes: [SyncChange], nextCursor: Int64, scope: String) throws
    func enqueue(_ operation: PendingOperation) throws
    func pendingOperations() throws -> [PendingOperation]
    func markApplied(operationIDs: Set<UUID>) throws
    func resetSensitive() throws
}

extension PersistenceStore: SyncPersisting {}

protocol SyncLifecycleManaging: Actor {
    func bootstrap(userID: UUID, generation: UInt64) async throws
    func resetSensitiveScope(reason: SensitiveResetReason, generation: UInt64) async throws
}

actor SyncEngine: SyncLifecycleManaging {
    private struct Context: Equatable, Sendable {
        let generation: UInt64
        let userID: UUID?
        var scope: String { userID?.uuidString.lowercased() ?? "public" }
    }

    private let api: any SyncServing
    private let persistence: any SyncPersisting
    private var pullingGenerations: Set<UInt64> = []
    private var pushingGenerations: Set<UInt64> = []
    private var userID: UUID?
    private var generation: UInt64 = 0
    private var latestHint: Int64 = 0
    private var sensitiveResetTask: Task<Void, Error>?
    private let topics = ["user", "profile", "event", "registration", "group", "wallet", "notification"]

    init(api: any SyncServing, persistence: any SyncPersisting) {
        self.api = api
        self.persistence = persistence
    }

    func bootstrap(userID: UUID, generation requestedGeneration: UInt64) async throws {
        guard requestedGeneration >= generation else { return }
        let changesAccount = self.userID != nil && self.userID != userID
        generation = requestedGeneration
        self.userID = userID
        let context = currentContext

        if changesAccount {
            latestHint = 0
            sensitiveResetTask = makeSensitiveResetTask(after: sensitiveResetTask)
        }
        if let sensitiveResetTask {
            try await sensitiveResetTask.value
        }
        guard isCurrent(context) else { return }

        _ = try await pull(reason: .bootstrap, context: context)
        guard isCurrent(context) else { return }
        _ = await flushPendingOperations(context: context)
    }

    func pull(reason: SyncReason) async throws -> SyncResult {
        try await pull(reason: reason, context: currentContext)
    }

    private func pull(reason: SyncReason, context: Context) async throws -> SyncResult {
        guard pullingGenerations.insert(context.generation).inserted else {
            return .init(
                applied: 0,
                nextCursor: try await persistence.cursor(scope: context.scope),
                hasMore: false
            )
        }
        defer { pullingGenerations.remove(context.generation) }
        var cursor = try await persistence.cursor(scope: context.scope)
        try ensureCurrent(context)
        var total = 0
        var hasMore = true
        while hasMore {
            let page = try await api.pull(cursor: cursor, topics: topics)
            try ensureCurrent(context)
            try await persistence.apply(
                changes: page.changes,
                nextCursor: page.nextCursor,
                scope: context.scope
            )
            try ensureCurrent(context)
            cursor = page.nextCursor; total += page.changes.count; hasMore = page.hasMore
            if reason == .backgroundRefresh && total >= 500 { break }
        }
        return .init(applied: total, nextCursor: cursor, hasMore: hasMore)
    }

    func enqueue(_ operation: PendingOperation) async throws { try await persistence.enqueue(operation) }

    func flushPendingOperations() async -> FlushResult {
        await flushPendingOperations(context: currentContext)
    }

    private func flushPendingOperations(context: Context) async -> FlushResult {
        guard isCurrent(context), pushingGenerations.insert(context.generation).inserted else {
            return .init(applied: 0, conflicts: 0, failed: 0)
        }
        defer { pushingGenerations.remove(context.generation) }
        do {
            let pending = try await persistence.pendingOperations()
            guard isCurrent(context) else { return .init(applied: 0, conflicts: 0, failed: 0) }
            let sorted = Self.topologicalSort(pending)
            let decoder = JSONDecoder()
            let payload = sorted.map { operation in SyncPushOperation(operationId: operation.operationID, entityType: operation.entityType, entityId: operation.entityID, action: operation.action, baseVersion: operation.baseVersion, payload: (try? decoder.decode(JSONValue.self, from: operation.payload)) ?? .object([:])) }
            guard !payload.isEmpty else { return .init(applied: 0, conflicts: 0, failed: 0) }
            let response = try await api.push(operations: payload)
            guard isCurrent(context) else { return .init(applied: 0, conflicts: 0, failed: 0) }
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

    func resetSensitiveScope(
        reason: SensitiveResetReason,
        generation requestedGeneration: UInt64
    ) async throws {
        _ = reason
        guard requestedGeneration >= generation else { return }
        generation = requestedGeneration
        userID = nil
        latestHint = 0
        let task = makeSensitiveResetTask(after: sensitiveResetTask)
        sensitiveResetTask = task
        try await task.value
    }

    private var currentContext: Context {
        Context(generation: generation, userID: userID)
    }

    private func isCurrent(_ context: Context) -> Bool {
        context == currentContext
    }

    private func ensureCurrent(_ context: Context) throws {
        guard isCurrent(context), !Task.isCancelled else { throw CancellationError() }
    }

    private func makeSensitiveResetTask(after previous: Task<Void, Error>?) -> Task<Void, Error> {
        let persistence = persistence
        return Task {
            if let previous { try await previous.value }
            try await persistence.resetSensitive()
        }
    }

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
