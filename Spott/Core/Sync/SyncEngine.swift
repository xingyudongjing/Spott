import Foundation

enum SyncReason: String, Sendable { case bootstrap, foreground, manual, realtimeHint, backgroundRefresh }
enum ScopeDeactivationReason: String, Sendable {
    case signOut
    case sessionExpired
    case accountChanged
    case tokenRefreshFailed
}
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

struct PendingOperation: Equatable, Sendable {
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
    nonisolated var ownerWriteLeaseAuthority: OwnerWriteLeaseAuthority { get }
    func validateOwnerScope(_ ownerScope: String) throws
    func cursor(scope: String) throws -> Int64
    func apply(
        changes: [SyncChange],
        nextCursor: Int64,
        scope: String,
        lease: OwnerWriteLease
    ) throws
    func enqueue(
        _ operation: PendingOperation,
        ownerScope: String,
        lease: OwnerWriteLease
    ) throws
    func pendingOperations(ownerScope: String) throws -> [PendingOperation]
    func allOperations(ownerScope: String) throws -> [StoredOperationSnapshot]
    func markApplied(
        operationIDs: Set<UUID>,
        ownerScope: String,
        lease: OwnerWriteLease
    ) throws
}

extension PersistenceStore: SyncPersisting {}

protocol SyncLifecycleManaging: Actor {
    func bootstrap(userID: UUID, generation: UInt64) async throws
    func deactivateScope(reason: ScopeDeactivationReason, generation: UInt64) async throws
}

protocol SyncPulling: Actor {
    func pull(reason: SyncReason) async throws -> SyncResult
}

actor SyncEngine: SyncLifecycleManaging, SyncPulling {
    private struct Context: Equatable, Sendable {
        let generation: UInt64
        let userID: UUID?
        let lease: OwnerWriteLease?
        var scope: String { userID?.uuidString.lowercased() ?? "public" }
    }

    private let api: any SyncServing
    private let persistence: any SyncPersisting
    nonisolated let ownerWriteLeaseAuthority: OwnerWriteLeaseAuthority
    private var pullingGenerations: Set<UInt64> = []
    private var pushingGenerations: Set<UInt64> = []
    private var pullRequestTasks: [UInt64: Task<SyncPullPage, Error>] = [:]
    private var pushRequestTasks: [UInt64: Task<SyncPushResponse, Error>] = [:]
    private var activeLifecycleOperationCounts: [UInt64: Int] = [:]
    private var lifecycleDrainWaiters: [
        UInt64: [CheckedContinuation<Void, Never>]
    ] = [:]
    private var activeDeactivationID: UUID?
    private var userID: UUID?
    private var activeLease: OwnerWriteLease?
    private var generation: UInt64 = 0
    private var latestHint: Int64 = 0
    private let topics = ["user", "profile", "event", "registration", "group", "wallet", "notification"]

    init(
        api: any SyncServing,
        persistence: any SyncPersisting
    ) {
        self.api = api
        self.persistence = persistence
        ownerWriteLeaseAuthority = persistence.ownerWriteLeaseAuthority
    }

    func bootstrap(userID: UUID, generation requestedGeneration: UInt64) async throws {
        guard activeDeactivationID == nil else { throw CancellationError() }
        guard requestedGeneration >= generation else { return }
        guard self.userID == nil || self.userID == userID else {
            throw PersistenceOwnershipError.ownershipMismatch
        }
        let ownerScope = userID.uuidString.lowercased()
        try await persistence.validateOwnerScope(ownerScope)
        guard activeDeactivationID == nil else { throw CancellationError() }
        guard requestedGeneration >= generation else { return }
        let lease = try ownerWriteLeaseAuthority.activate(
            ownerScope: ownerScope,
            generation: requestedGeneration
        )
        generation = requestedGeneration
        self.userID = userID
        activeLease = lease
        let context = currentContext

        _ = try await pull(reason: .bootstrap, context: context)
        guard isCurrent(context) else { return }
        _ = await flushPendingOperations(context: context)
    }

    func pull(reason: SyncReason) async throws -> SyncResult {
        try await pull(reason: reason, context: currentContext)
    }

    private func pull(reason: SyncReason, context: Context) async throws -> SyncResult {
        guard let lease = context.lease else { throw CancellationError() }
        try ensureCurrent(context)
        beginLifecycleOperation(generation: context.generation)
        defer { endLifecycleOperation(generation: context.generation) }
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
            let page = try await pullPage(
                cursor: cursor,
                context: context
            )
            try ensureCurrent(context)
            try await persistence.apply(
                changes: page.changes,
                nextCursor: page.nextCursor,
                scope: context.scope,
                lease: lease
            )
            try ensureCurrent(context)
            cursor = page.nextCursor; total += page.changes.count; hasMore = page.hasMore
            if reason == .backgroundRefresh && total >= 500 { break }
        }
        return .init(applied: total, nextCursor: cursor, hasMore: hasMore)
    }

    func enqueue(_ operation: PendingOperation) async throws {
        let context = currentContext
        let lease = try currentLease(for: context)
        try await persistence.enqueue(
            operation,
            ownerScope: context.scope,
            lease: lease
        )
        try ensureCurrent(context)
        try ownerWriteLeaseAuthority.validate(lease, ownerScope: context.scope)
    }

    func flushPendingOperations() async -> FlushResult {
        await flushPendingOperations(context: currentContext)
    }

    private func flushPendingOperations(context: Context) async -> FlushResult {
        guard let lease = context.lease,
              isCurrent(context) else {
            return .init(applied: 0, conflicts: 0, failed: 0)
        }
        beginLifecycleOperation(generation: context.generation)
        defer { endLifecycleOperation(generation: context.generation) }
        guard pushingGenerations.insert(context.generation).inserted else {
            return .init(applied: 0, conflicts: 0, failed: 0)
        }
        defer { pushingGenerations.remove(context.generation) }
        do {
            let pending = try await persistence.pendingOperations(ownerScope: context.scope)
            guard isCurrent(context) else {
                return .init(applied: 0, conflicts: 0, failed: 0)
            }
            let sorted = Self.topologicalSort(pending)
            let decoder = JSONDecoder()
            let payload = sorted.map { operation in SyncPushOperation(operationId: operation.operationID, entityType: operation.entityType, entityId: operation.entityID, action: operation.action, baseVersion: operation.baseVersion, payload: (try? decoder.decode(JSONValue.self, from: operation.payload)) ?? .object([:])) }
            guard !payload.isEmpty else { return .init(applied: 0, conflicts: 0, failed: 0) }
            let response = try await push(
                operations: payload,
                context: context
            )
            guard isCurrent(context) else {
                return .init(applied: 0, conflicts: 0, failed: 0)
            }
            let applied = Set(response.results.filter { $0.state == "applied" }.map(\.operationId))
            try await persistence.markApplied(
                operationIDs: applied,
                ownerScope: context.scope,
                lease: lease
            )
            return .init(applied: applied.count, conflicts: response.results.filter { $0.state == "conflict" }.count, failed: response.results.filter { $0.state == "failed" }.count)
        } catch { return .init(applied: 0, conflicts: 0, failed: 1) }
    }

    func handleRealtimeHint(sequence: Int64) async {
        guard sequence > latestHint else { return }
        latestHint = sequence
        _ = try? await pull(reason: .realtimeHint)
    }

    func deactivateScope(
        reason: ScopeDeactivationReason,
        generation requestedGeneration: UInt64
    ) async throws {
        _ = reason
        guard requestedGeneration >= generation else { return }
        let deactivationID = UUID()
        activeDeactivationID = deactivationID
        ownerWriteLeaseAuthority.revoke(atLeast: requestedGeneration)
        generation = requestedGeneration
        userID = nil
        activeLease = nil
        latestHint = 0

        let pullRequests = pullRequestTasks
            .filter { $0.key <= requestedGeneration }
        let pushRequests = pushRequestTasks
            .filter { $0.key <= requestedGeneration }
        pullRequests.values.forEach { $0.cancel() }
        pushRequests.values.forEach { $0.cancel() }
        for task in pullRequests.values { _ = await task.result }
        for task in pushRequests.values { _ = await task.result }
        await waitForLifecycleOperations(through: requestedGeneration)

        for key in pullRequests.keys { pullRequestTasks.removeValue(forKey: key) }
        for key in pushRequests.keys { pushRequestTasks.removeValue(forKey: key) }
        if activeDeactivationID == deactivationID {
            activeDeactivationID = nil
        }
    }

    private func pullPage(
        cursor: Int64,
        context: Context
    ) async throws -> SyncPullPage {
        try ensureCurrent(context)
        let api = self.api
        let topics = self.topics
        let request = Task {
            try await api.pull(cursor: cursor, topics: topics)
        }
        pullRequestTasks[context.generation] = request
        do {
            let page = try await withTaskCancellationHandler {
                try await request.value
            } onCancel: {
                request.cancel()
            }
            pullRequestTasks.removeValue(forKey: context.generation)
            return page
        } catch {
            pullRequestTasks.removeValue(forKey: context.generation)
            throw error
        }
    }

    private func push(
        operations: [SyncPushOperation],
        context: Context
    ) async throws -> SyncPushResponse {
        try ensureCurrent(context)
        let api = self.api
        let request = Task {
            try await api.push(operations: operations)
        }
        pushRequestTasks[context.generation] = request
        do {
            let response = try await withTaskCancellationHandler {
                try await request.value
            } onCancel: {
                request.cancel()
            }
            pushRequestTasks.removeValue(forKey: context.generation)
            return response
        } catch {
            pushRequestTasks.removeValue(forKey: context.generation)
            throw error
        }
    }

    private var currentContext: Context {
        Context(generation: generation, userID: userID, lease: activeLease)
    }

    private func isCurrent(_ context: Context) -> Bool {
        context == currentContext
    }

    private func ensureCurrent(_ context: Context) throws {
        guard isCurrent(context), !Task.isCancelled else { throw CancellationError() }
    }

    private func currentLease(for context: Context) throws -> OwnerWriteLease {
        try ensureCurrent(context)
        guard let lease = context.lease else { throw CancellationError() }
        try ownerWriteLeaseAuthority.validate(lease, ownerScope: context.scope)
        return lease
    }

    private func beginLifecycleOperation(generation: UInt64) {
        activeLifecycleOperationCounts[generation, default: 0] += 1
    }

    private func endLifecycleOperation(generation: UInt64) {
        let remaining = activeLifecycleOperationCounts[generation, default: 0] - 1
        guard remaining <= 0 else {
            activeLifecycleOperationCounts[generation] = remaining
            return
        }
        activeLifecycleOperationCounts.removeValue(forKey: generation)
        let waiters = lifecycleDrainWaiters.removeValue(forKey: generation) ?? []
        waiters.forEach { $0.resume() }
    }

    private func waitForLifecycleOperations(through requestedGeneration: UInt64) async {
        let generations = activeLifecycleOperationCounts.keys
            .filter { $0 <= requestedGeneration }
            .sorted()
        for generation in generations {
            guard activeLifecycleOperationCounts[generation, default: 0] > 0 else {
                continue
            }
            await withCheckedContinuation { continuation in
                lifecycleDrainWaiters[generation, default: []].append(continuation)
            }
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
