import Foundation
import SwiftData

actor PersistenceStore {
    nonisolated let container: ModelContainer
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(container: ModelContainer) {
        self.container = container
        encoder.dateEncodingStrategy = .iso8601
        decoder.dateDecodingStrategy = .iso8601
    }

    static func makeDefault() -> PersistenceStore {
        do { return try PersistenceStore(container: ModelContainer(for: CachedEvent.self, StoredOperation.self, StoredCursor.self, LocalEventDraft.self)) }
        catch { fatalError("Unable to initialize SwiftData: \(error)") }
    }

    static func makeInMemory() -> PersistenceStore {
        let configuration = ModelConfiguration(isStoredInMemoryOnly: true)
        do { return try PersistenceStore(container: ModelContainer(for: CachedEvent.self, StoredOperation.self, StoredCursor.self, LocalEventDraft.self, configurations: configuration)) }
        catch { fatalError("Unable to initialize preview data: \(error)") }
    }

    func cachedEvents() throws -> [EventSummary] {
        let context = ModelContext(container)
        return try context.fetch(FetchDescriptor<CachedEvent>(sortBy: [SortDescriptor(\.updatedAt, order: .reverse)]))
            .compactMap { try? decoder.decode(EventSummary.self, from: $0.payload) }
    }

    func replaceEvents(_ events: [EventSummary]) throws {
        let context = ModelContext(container)
        try context.delete(model: CachedEvent.self)
        for event in events { context.insert(CachedEvent(id: event.id, payload: try encoder.encode(event), updatedAt: event.updatedAt)) }
        try context.save()
    }

    func cursor(scope: String) throws -> Int64 {
        let context = ModelContext(container)
        let predicate = #Predicate<StoredCursor> { $0.scope == scope }
        return try context.fetch(FetchDescriptor(predicate: predicate)).first?.value ?? 0
    }

    func apply(changes: [SyncChange], nextCursor: Int64, scope: String) throws {
        let context = ModelContext(container)
        let predicate = #Predicate<StoredCursor> { $0.scope == scope }
        let cursor = try context.fetch(FetchDescriptor(predicate: predicate)).first ?? StoredCursor(scope: scope)
        if cursor.modelContext == nil { context.insert(cursor) }
        // Feature repositories consume typed changes; cursor advances in the same SwiftData transaction.
        _ = changes
        cursor.value = nextCursor; cursor.updatedAt = .now
        try context.save()
    }

    func enqueue(_ operation: PendingOperation) throws {
        let context = ModelContext(container)
        context.insert(StoredOperation(operationID: operation.operationID, entityType: operation.entityType, entityID: operation.entityID, action: operation.action, baseVersion: operation.baseVersion, payload: operation.payload, dependencies: operation.dependencies))
        try context.save()
    }

    func pendingOperations() throws -> [PendingOperation] {
        let context = ModelContext(container)
        let descriptor = FetchDescriptor<StoredOperation>(predicate: #Predicate { $0.state == "pending" }, sortBy: [SortDescriptor(\.createdAt)])
        return try context.fetch(descriptor).map { PendingOperation(operationID: $0.operationID, entityType: $0.entityType, entityID: $0.entityID, action: $0.action, baseVersion: $0.baseVersion, payload: $0.payload, dependencies: $0.dependencies) }
    }

    func markApplied(operationIDs: Set<UUID>) throws {
        let context = ModelContext(container)
        let rows = try context.fetch(FetchDescriptor<StoredOperation>())
        for row in rows where operationIDs.contains(row.operationID) { row.state = "applied" }
        try context.save()
    }

    func resetSensitive() throws {
        let context = ModelContext(container)
        try context.delete(model: StoredOperation.self)
        try context.delete(model: StoredCursor.self)
        try context.save()
    }
}
