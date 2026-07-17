import Foundation
import SwiftData

enum PersistenceStoreError: Error {
    case invalidSyncPage
}

actor PersistenceStore {
    nonisolated let container: ModelContainer
    nonisolated let ownerWriteLeaseAuthority: OwnerWriteLeaseAuthority
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(
        container: ModelContainer,
        ownerWriteLeaseAuthority: OwnerWriteLeaseAuthority = OwnerWriteLeaseAuthority()
    ) {
        self.container = container
        self.ownerWriteLeaseAuthority = ownerWriteLeaseAuthority
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        decoder.dateDecodingStrategy = .iso8601
    }

    static func makeDefault(
        ownerWriteLeaseAuthority: OwnerWriteLeaseAuthority = OwnerWriteLeaseAuthority()
    ) -> PersistenceStore {
        do { return try PersistenceStore(container: ModelContainer(for: CachedEvent.self, StoredOperation.self, StoredCursor.self, StoredSyncEntity.self, LocalEventDraft.self, PersistenceMetadata.self), ownerWriteLeaseAuthority: ownerWriteLeaseAuthority) }
        catch { fatalError("Unable to initialize SwiftData: \(error)") }
    }

    static func makeInMemory(
        ownerWriteLeaseAuthority: OwnerWriteLeaseAuthority = OwnerWriteLeaseAuthority()
    ) -> PersistenceStore {
        let configuration = ModelConfiguration(isStoredInMemoryOnly: true)
        do { return try PersistenceStore(container: ModelContainer(for: CachedEvent.self, StoredOperation.self, StoredCursor.self, StoredSyncEntity.self, LocalEventDraft.self, PersistenceMetadata.self, configurations: configuration), ownerWriteLeaseAuthority: ownerWriteLeaseAuthority) }
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

    func apply(
        changes: [SyncChange],
        nextCursor: Int64,
        scope: String,
        lease: OwnerWriteLease
    ) throws {
        let scope = try OwnerWriteLeaseAuthority.normalizedOwnerScope(scope)
        try ownerWriteLeaseAuthority.validate(lease, ownerScope: scope)
        let context = ModelContext(container)
        let cursorPredicate = #Predicate<StoredCursor> { $0.scope == scope }
        let storedCursor = try context.fetch(FetchDescriptor(predicate: cursorPredicate)).first
        let currentCursor = storedCursor?.value ?? 0

        try validatePage(
            changes: changes,
            nextCursor: nextCursor,
            currentCursor: currentCursor,
            scope: scope
        )

        // A retry or an out-of-order realtime hint may return a page that is already
        // durable. Treat it as an idempotent no-op; never regress the local cursor.
        guard nextCursor > currentCursor else { return }

        let newChanges = changes.filter { $0.seq > currentCursor }
        guard !newChanges.isEmpty else { throw PersistenceStoreError.invalidSyncPage }

        // Encode every payload before mutating the context. A malformed value must
        // reject the entire page rather than leave a partially-applied transaction.
        let prepared = try newChanges.map { change in
            PreparedSyncChange(change: change, payload: try encoder.encode(change.payload))
        }

        let entityPredicate = #Predicate<StoredSyncEntity> { $0.userScope == scope }
        let storedEntities = try context.fetch(FetchDescriptor(predicate: entityPredicate))
        var entitiesByIdentity = Dictionary(
            uniqueKeysWithValues: storedEntities.map { ($0.identity, $0) }
        )

        // Validate version monotonicity using a shadow state first, so a later bad
        // change cannot invalidate earlier mutations in the same page.
        var latestByIdentity = Dictionary(
            uniqueKeysWithValues: storedEntities.map { ($0.identity, ($0.seq, $0.version)) }
        )
        for item in prepared {
            let change = item.change
            let identity = StoredSyncEntity.identity(
                userScope: scope,
                entityType: change.entityType,
                entityID: change.entityId
            )
            if let latest = latestByIdentity[identity], change.seq <= latest.0 {
                continue
            }
            if let latest = latestByIdentity[identity], change.version < latest.1 {
                throw PersistenceStoreError.invalidSyncPage
            }
            latestByIdentity[identity] = (change.seq, change.version)
        }

        let timestamp = Date.now
        for item in prepared {
            let change = item.change
            let identity = StoredSyncEntity.identity(
                userScope: scope,
                entityType: change.entityType,
                entityID: change.entityId
            )
            if let row = entitiesByIdentity[identity] {
                guard change.seq > row.seq else { continue }
                row.version = change.version
                row.seq = change.seq
                row.isTombstone = change.operation == "tombstone"
                row.payload = item.payload
                row.updatedAt = timestamp
            } else {
                let row = StoredSyncEntity(
                    userScope: scope,
                    entityType: change.entityType,
                    entityID: change.entityId,
                    version: change.version,
                    seq: change.seq,
                    isTombstone: change.operation == "tombstone",
                    payload: item.payload
                )
                row.updatedAt = timestamp
                context.insert(row)
                entitiesByIdentity[identity] = row
            }
        }

        let cursor = storedCursor ?? StoredCursor(scope: scope)
        if storedCursor == nil { context.insert(cursor) }
        cursor.value = nextCursor
        cursor.updatedAt = timestamp

        do {
            // SwiftData commits every entity mutation and the cursor in one store
            // transaction. The cursor is therefore never durable ahead of its data.
            try ownerWriteLeaseAuthority.withValidatedLease(lease, ownerScope: scope) {
                try context.save()
            }
        } catch {
            context.rollback()
            throw error
        }
    }

    func validateOwnerScope(_ ownerScope: String) throws {
        _ = try OwnerWriteLeaseAuthority.normalizedOwnerScope(ownerScope)
        let context = ModelContext(container)
        let operations = try context.fetch(FetchDescriptor<StoredOperation>())
        let drafts = try context.fetch(FetchDescriptor<LocalEventDraft>())
        for storedOwnerScope in operations.map(\.ownerScope) + drafts.map(\.ownerScope) {
            guard !storedOwnerScope.isEmpty else {
                throw PersistenceOwnershipError.unresolvedLegacyOwner
            }
            let normalized = try OwnerWriteLeaseAuthority.normalizedOwnerScope(
                storedOwnerScope
            )
            guard normalized == storedOwnerScope else {
                throw PersistenceOwnershipError.invalidOwnerScope
            }
        }
    }

    func enqueue(
        _ operation: PendingOperation,
        ownerScope: String,
        lease: OwnerWriteLease
    ) throws {
        let ownerScope = try OwnerWriteLeaseAuthority.normalizedOwnerScope(ownerScope)
        try ownerWriteLeaseAuthority.validate(lease, ownerScope: ownerScope)
        let context = ModelContext(container)
        context.insert(StoredOperation(ownerScope: ownerScope, operationID: operation.operationID, entityType: operation.entityType, entityID: operation.entityID, action: operation.action, baseVersion: operation.baseVersion, payload: operation.payload, dependencies: operation.dependencies))
        do {
            try ownerWriteLeaseAuthority.withValidatedLease(lease, ownerScope: ownerScope) {
                try context.save()
            }
        } catch {
            context.rollback()
            throw error
        }
    }

    func pendingOperations(ownerScope: String) throws -> [PendingOperation] {
        let ownerScope = try OwnerWriteLeaseAuthority.normalizedOwnerScope(ownerScope)
        let context = ModelContext(container)
        let descriptor = FetchDescriptor<StoredOperation>(
            predicate: #Predicate { $0.ownerScope == ownerScope && $0.state == "pending" },
            sortBy: [SortDescriptor(\.createdAt)]
        )
        return try context.fetch(descriptor).map { PendingOperation(operationID: $0.operationID, entityType: $0.entityType, entityID: $0.entityID, action: $0.action, baseVersion: $0.baseVersion, payload: $0.payload, dependencies: $0.dependencies) }
    }

    func allOperations(ownerScope: String) throws -> [StoredOperationSnapshot] {
        let ownerScope = try OwnerWriteLeaseAuthority.normalizedOwnerScope(ownerScope)
        let context = ModelContext(container)
        let descriptor = FetchDescriptor<StoredOperation>(
            predicate: #Predicate { $0.ownerScope == ownerScope },
            sortBy: [SortDescriptor(\.createdAt), SortDescriptor(\.operationID)]
        )
        return try context.fetch(descriptor).map {
            StoredOperationSnapshot(
                operationID: $0.operationID,
                ownerScope: $0.ownerScope,
                entityType: $0.entityType,
                entityID: $0.entityID,
                action: $0.action,
                baseVersion: $0.baseVersion,
                payload: $0.payload,
                dependencies: $0.dependencies,
                state: $0.state,
                attempts: $0.attempts,
                createdAt: $0.createdAt
            )
        }
    }

    func markApplied(
        operationIDs: Set<UUID>,
        ownerScope: String,
        lease: OwnerWriteLease
    ) throws {
        let ownerScope = try OwnerWriteLeaseAuthority.normalizedOwnerScope(ownerScope)
        try ownerWriteLeaseAuthority.validate(lease, ownerScope: ownerScope)
        let context = ModelContext(container)
        let rows = try context.fetch(
            FetchDescriptor<StoredOperation>(predicate: #Predicate { $0.ownerScope == ownerScope })
        )
        for row in rows where operationIDs.contains(row.operationID) { row.state = "applied" }
        do {
            try ownerWriteLeaseAuthority.withValidatedLease(lease, ownerScope: ownerScope) {
                try context.save()
            }
        } catch {
            context.rollback()
            throw error
        }
    }

    func upsertDraft(
        _ draft: LocalEventDraftSnapshot,
        ownerScope: String,
        lease: OwnerWriteLease
    ) throws {
        let ownerScope = try OwnerWriteLeaseAuthority.normalizedOwnerScope(ownerScope)
        try ownerWriteLeaseAuthority.validate(lease, ownerScope: ownerScope)
        let context = ModelContext(container)
        let localID = draft.localID
        let existing = try context.fetch(
            FetchDescriptor<LocalEventDraft>(predicate: #Predicate { $0.localID == localID })
        ).first
        if let existing {
            guard existing.ownerScope == ownerScope else {
                throw PersistenceOwnershipError.ownershipMismatch
            }
            existing.serverID = draft.serverID
            existing.title = draft.title
            existing.payload = draft.payload
            existing.draftRevision = draft.draftRevision
            existing.serverVersion = draft.serverVersion
            existing.updatedAt = draft.updatedAt
        } else {
            let row = LocalEventDraft(
                ownerScope: ownerScope,
                localID: draft.localID,
                title: draft.title,
                payload: draft.payload
            )
            row.serverID = draft.serverID
            row.draftRevision = draft.draftRevision
            row.serverVersion = draft.serverVersion
            row.updatedAt = draft.updatedAt
            context.insert(row)
        }
        do {
            try ownerWriteLeaseAuthority.withValidatedLease(lease, ownerScope: ownerScope) {
                try context.save()
            }
        } catch {
            context.rollback()
            throw error
        }
    }

    func drafts(ownerScope: String) throws -> [LocalEventDraftSnapshot] {
        let ownerScope = try OwnerWriteLeaseAuthority.normalizedOwnerScope(ownerScope)
        let context = ModelContext(container)
        let rows = try context.fetch(
            FetchDescriptor<LocalEventDraft>(
                predicate: #Predicate { $0.ownerScope == ownerScope },
                sortBy: [SortDescriptor(\.updatedAt), SortDescriptor(\.localID)]
            )
        )
        return rows.map {
            LocalEventDraftSnapshot(
                localID: $0.localID,
                serverID: $0.serverID,
                title: $0.title,
                payload: $0.payload,
                draftRevision: $0.draftRevision,
                serverVersion: $0.serverVersion,
                updatedAt: $0.updatedAt
            )
        }
    }

    private struct PreparedSyncChange {
        let change: SyncChange
        let payload: Data
    }

    private func validatePage(
        changes: [SyncChange],
        nextCursor: Int64,
        currentCursor: Int64,
        scope: String
    ) throws {
        guard !scope.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              nextCursor >= 0 else {
            throw PersistenceStoreError.invalidSyncPage
        }

        var previousSequence: Int64 = 0
        for change in changes {
            guard change.seq > previousSequence,
                  change.version > 0,
                  !change.entityType.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  change.operation == "upsert" || change.operation == "tombstone" else {
                throw PersistenceStoreError.invalidSyncPage
            }
            previousSequence = change.seq
        }

        if let finalSequence = changes.last?.seq {
            guard finalSequence == nextCursor else {
                throw PersistenceStoreError.invalidSyncPage
            }
        } else if nextCursor > currentCursor {
            throw PersistenceStoreError.invalidSyncPage
        }
    }
}
