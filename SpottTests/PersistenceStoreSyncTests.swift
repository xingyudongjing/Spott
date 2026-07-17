import SwiftData
import XCTest
@testable import Spott

@MainActor
final class PersistenceStoreSyncTests: XCTestCase {
    func testMalformedChangeDoesNotAdvanceCursor() async throws {
        let store = PersistenceStore.makeInMemory()
        let scope = UUID().uuidString.lowercased()
        let malformed = makeChange(seq: 1, operation: "replace")

        do {
            try await apply(changes: [malformed], nextCursor: 1, scope: scope, to: store)
            XCTFail("An unsupported sync operation must reject the whole page")
        } catch {
            // Expected: the page is rejected before its cursor can advance.
        }

        let cursor = try await store.cursor(scope: scope)
        XCTAssertEqual(cursor, 0)
    }

    func testAppliedEntityAndCursorSurviveAColdStart() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("spott-sync-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let storeURL = directory.appendingPathComponent("spott.store")
        let scope = UUID().uuidString.lowercased()
        let entityID = UUID()
        let change = makeChange(
            seq: 7,
            entityID: entityID,
            version: 3,
            payload: ["nickname": .string("星宇")]
        )

        try await writePage(
            changes: [change],
            nextCursor: 7,
            scope: scope,
            storeURL: storeURL
        )

        let relaunched = try makePersistentStore(at: storeURL)
        let rows = try syncRows(in: relaunched.container, scope: scope)
        let row = try XCTUnwrap(rows.first)
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(row.userScope, scope)
        XCTAssertEqual(row.entityType, "profile")
        XCTAssertEqual(row.entityID, entityID)
        XCTAssertEqual(row.version, 3)
        XCTAssertEqual(row.seq, 7)
        XCTAssertFalse(row.isTombstone)
        XCTAssertEqual(
            try JSONDecoder().decode([String: JSONValue].self, from: row.payload),
            ["nickname": .string("星宇")]
        )
        let cursor = try await relaunched.cursor(scope: scope)
        XCTAssertEqual(cursor, 7)
    }

    func testRepeatedPageIsIdempotentAndDoesNotDuplicateTheEntity() async throws {
        let store = PersistenceStore.makeInMemory()
        let scope = UUID().uuidString.lowercased()
        let entityID = UUID()
        let change = makeChange(seq: 4, entityID: entityID, version: 2)

        try await apply(changes: [change], nextCursor: 4, scope: scope, to: store)
        try await apply(changes: [change], nextCursor: 4, scope: scope, to: store)

        let rows = try syncRows(in: store.container, scope: scope)
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?.entityID, entityID)
        XCTAssertEqual(rows.first?.version, 2)
        XCTAssertEqual(rows.first?.seq, 4)
        let cursor = try await store.cursor(scope: scope)
        XCTAssertEqual(cursor, 4)
    }

    func testTombstoneSupersedesAnUpsertWithoutLosingDeletionVersion() async throws {
        let store = PersistenceStore.makeInMemory()
        let scope = UUID().uuidString.lowercased()
        let entityID = UUID()
        try await apply(
            changes: [makeChange(seq: 1, entityID: entityID, version: 1)],
            nextCursor: 1,
            scope: scope,
            to: store
        )

        let tombstone = makeChange(
            seq: 2,
            entityID: entityID,
            operation: "tombstone",
            version: 2,
            payload: ["reason": .string("deleted")]
        )
        try await apply(changes: [tombstone], nextCursor: 2, scope: scope, to: store)

        let row = try XCTUnwrap(syncRows(in: store.container, scope: scope).first)
        XCTAssertTrue(row.isTombstone)
        XCTAssertEqual(row.version, 2)
        XCTAssertEqual(row.seq, 2)
        XCTAssertEqual(
            try JSONDecoder().decode([String: JSONValue].self, from: row.payload),
            ["reason": .string("deleted")]
        )
        let cursor = try await store.cursor(scope: scope)
        XCTAssertEqual(cursor, 2)
    }

    func testSameEntityIDIsIsolatedByUserScope() async throws {
        let store = PersistenceStore.makeInMemory()
        let firstScope = UUID().uuidString.lowercased()
        let secondScope = UUID().uuidString.lowercased()
        let entityID = UUID()

        try await apply(
            changes: [makeChange(seq: 1, entityID: entityID, payload: ["owner": .string("first")])],
            nextCursor: 1,
            scope: firstScope,
            to: store
        )
        try await apply(
            changes: [makeChange(seq: 1, entityID: entityID, payload: ["owner": .string("second")])],
            nextCursor: 1,
            scope: secondScope,
            to: store
        )

        let first = try XCTUnwrap(syncRows(in: store.container, scope: firstScope).first)
        let second = try XCTUnwrap(syncRows(in: store.container, scope: secondScope).first)
        XCTAssertNotEqual(first.identity, second.identity)
        XCTAssertEqual(
            try JSONDecoder().decode([String: JSONValue].self, from: first.payload),
            ["owner": .string("first")]
        )
        XCTAssertEqual(
            try JSONDecoder().decode([String: JSONValue].self, from: second.payload),
            ["owner": .string("second")]
        )
    }

    func testEncodingFailureRollsBackEveryChangeAndCursorInThePage() async throws {
        let store = PersistenceStore.makeInMemory()
        let scope = UUID().uuidString.lowercased()
        let originalID = UUID()
        try await apply(
            changes: [makeChange(seq: 1, entityID: originalID, payload: ["name": .string("before")])],
            nextCursor: 1,
            scope: scope,
            to: store
        )

        let validID = UUID()
        let changes = [
            makeChange(seq: 2, entityID: validID, payload: ["name": .string("would-be-partial")]),
            makeChange(seq: 3, payload: ["invalidNumber": .number(.nan)]),
        ]
        do {
            try await apply(changes: changes, nextCursor: 3, scope: scope, to: store)
            XCTFail("A payload encoding failure must reject the whole page")
        } catch {
            // Expected: payloads are encoded before the transaction is mutated.
        }

        let rows = try syncRows(in: store.container, scope: scope)
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?.entityID, originalID)
        let cursor = try await store.cursor(scope: scope)
        XCTAssertEqual(cursor, 1)
    }

    func testNonMonotonicPageDoesNotAdvanceCursorOrApplyAnyEntity() async throws {
        let store = PersistenceStore.makeInMemory()
        let scope = UUID().uuidString.lowercased()
        let changes = [makeChange(seq: 2), makeChange(seq: 1)]

        do {
            try await apply(changes: changes, nextCursor: 2, scope: scope, to: store)
            XCTFail("A page sequence must be strictly increasing")
        } catch {
            // Expected.
        }

        XCTAssertTrue(try syncRows(in: store.container, scope: scope).isEmpty)
        let cursor = try await store.cursor(scope: scope)
        XCTAssertEqual(cursor, 0)
    }

    func testCursorCannotAdvancePastTheLastDurableChange() async throws {
        let store = PersistenceStore.makeInMemory()
        let scope = UUID().uuidString.lowercased()

        do {
            try await apply(changes: [makeChange(seq: 1)], nextCursor: 9, scope: scope, to: store)
            XCTFail("A page cursor must equal its final change sequence")
        } catch {
            // Expected.
        }

        XCTAssertTrue(try syncRows(in: store.container, scope: scope).isEmpty)
        let cursor = try await store.cursor(scope: scope)
        XCTAssertEqual(cursor, 0)
    }

    func testStalePageCannotRegressCursorOrEntity() async throws {
        let store = PersistenceStore.makeInMemory()
        let scope = UUID().uuidString.lowercased()
        let entityID = UUID()
        try await apply(
            changes: [makeChange(seq: 5, entityID: entityID, version: 5, payload: ["name": .string("new")])],
            nextCursor: 5,
            scope: scope,
            to: store
        )

        try await apply(
            changes: [makeChange(seq: 3, entityID: entityID, version: 3, payload: ["name": .string("old")])],
            nextCursor: 3,
            scope: scope,
            to: store
        )

        let row = try XCTUnwrap(syncRows(in: store.container, scope: scope).first)
        XCTAssertEqual(row.version, 5)
        XCTAssertEqual(row.seq, 5)
        XCTAssertEqual(
            try JSONDecoder().decode([String: JSONValue].self, from: row.payload),
            ["name": .string("new")]
        )
        let cursor = try await store.cursor(scope: scope)
        XCTAssertEqual(cursor, 5)
    }

    func testLaterSequenceCannotRegressAnEntityVersionOrAdvanceCursor() async throws {
        let store = PersistenceStore.makeInMemory()
        let scope = UUID().uuidString.lowercased()
        let entityID = UUID()
        try await apply(
            changes: [makeChange(seq: 1, entityID: entityID, version: 3, payload: ["name": .string("new")])],
            nextCursor: 1,
            scope: scope,
            to: store
        )

        do {
            try await apply(
                changes: [makeChange(seq: 2, entityID: entityID, version: 2, payload: ["name": .string("old")])],
                nextCursor: 2,
                scope: scope,
                to: store
            )
            XCTFail("A later change sequence must not regress an entity version")
        } catch {
            // Expected.
        }

        let row = try XCTUnwrap(syncRows(in: store.container, scope: scope).first)
        XCTAssertEqual(row.version, 3)
        XCTAssertEqual(row.seq, 1)
        let cursor = try await store.cursor(scope: scope)
        XCTAssertEqual(cursor, 1)
    }

    func testMissingOwnerScopeLeavesQueueBytesUnchangedAndBlocksPush() async throws {
        let authority = OwnerWriteLeaseAuthority()
        let ownerScope = UUID().uuidString.lowercased()
        let lease = try authority.activate(ownerScope: ownerScope, generation: 1)
        let store = PersistenceStore.makeInMemory(ownerWriteLeaseAuthority: authority)
        let operation = makePendingOperation(payload: Data([0x00, 0x7f, 0xff]))

        try await store.enqueue(operation, ownerScope: ownerScope, lease: lease)
        let before = try await store.allOperations(ownerScope: ownerScope)

        do {
            try await store.enqueue(
                makePendingOperation(payload: Data([0xde, 0xad, 0xbe, 0xef])),
                ownerScope: "  ",
                lease: lease
            )
            XCTFail("An absent owner scope must be rejected before the queue is mutated")
        } catch PersistenceOwnershipError.missingOwnerScope {
            // Expected.
        }

        let after = try await store.allOperations(ownerScope: ownerScope)
        XCTAssertEqual(after, before)
    }

    func testAccountADraftAndOperationAreNeverVisibleOrPushableForAccountB() async throws {
        let authority = OwnerWriteLeaseAuthority()
        let ownerA = UUID().uuidString.lowercased()
        let ownerB = UUID().uuidString.lowercased()
        let leaseA = try authority.activate(ownerScope: ownerA, generation: 1)
        let store = PersistenceStore.makeInMemory(ownerWriteLeaseAuthority: authority)
        let operation = makePendingOperation(payload: Data("owner-a-operation".utf8))
        let draft = LocalEventDraftSnapshot(
            localID: UUID(),
            serverID: nil,
            title: "A only",
            payload: Data("owner-a-draft".utf8),
            draftRevision: 7,
            serverVersion: nil,
            updatedAt: Date(timeIntervalSince1970: 1_700_000_000)
        )

        try await store.enqueue(operation, ownerScope: ownerA, lease: leaseA)
        try await store.upsertDraft(draft, ownerScope: ownerA, lease: leaseA)

        let ownerAPending = try await store.pendingOperations(ownerScope: ownerA)
        let ownerADrafts = try await store.drafts(ownerScope: ownerA)
        let ownerBPending = try await store.pendingOperations(ownerScope: ownerB)
        let ownerBAll = try await store.allOperations(ownerScope: ownerB)
        let ownerBDrafts = try await store.drafts(ownerScope: ownerB)
        XCTAssertEqual(ownerAPending, [operation])
        XCTAssertEqual(ownerADrafts, [draft])
        XCTAssertTrue(ownerBPending.isEmpty)
        XCTAssertTrue(ownerBAll.isEmpty)
        XCTAssertTrue(ownerBDrafts.isEmpty)
    }

    func testValidateOwnerScopeScansEveryUserRowAndAllowsCanonicalOtherOwners() async throws {
        let requestedOwner = UUID().uuidString.lowercased()
        let malformedOwners = [
            "",
            "not-a-uuid",
            UUID().uuidString.uppercased(),
        ]

        for malformedOwner in malformedOwners {
            for rowKind in PersistenceStoreUserRowKind.allCases {
                let store = PersistenceStore.makeInMemory()
                try insertUserRow(
                    kind: rowKind,
                    ownerScope: malformedOwner,
                    into: store.container
                )

                do {
                    try await store.validateOwnerScope(requestedOwner)
                    XCTFail(
                        "A malformed stored \(rowKind) owner must block even when filtered queries would hide it"
                    )
                } catch {
                    // Expected: validation scans every user-data row fail closed.
                }
            }
        }

        let validStore = PersistenceStore.makeInMemory()
        let otherOwner = UUID().uuidString.lowercased()
        try insertUserRow(
            kind: .operation,
            ownerScope: requestedOwner,
            into: validStore.container
        )
        try insertUserRow(
            kind: .draft,
            ownerScope: otherOwner,
            into: validStore.container
        )

        try await validStore.validateOwnerScope(requestedOwner)
    }

    func testPendingQueryFiltersOwnerAndStateWhileAllOperationsRetainsAppliedRows() async throws {
        let authority = OwnerWriteLeaseAuthority()
        let ownerScope = UUID().uuidString.lowercased()
        let lease = try authority.activate(ownerScope: ownerScope, generation: 1)
        let store = PersistenceStore.makeInMemory(ownerWriteLeaseAuthority: authority)
        let applied = makePendingOperation(payload: Data("applied".utf8))
        let pending = makePendingOperation(payload: Data("pending".utf8))

        try await store.enqueue(applied, ownerScope: ownerScope, lease: lease)
        try await store.enqueue(pending, ownerScope: ownerScope, lease: lease)
        try await store.markApplied(
            operationIDs: [applied.operationID],
            ownerScope: ownerScope,
            lease: lease
        )

        let pendingRows = try await store.pendingOperations(ownerScope: ownerScope)
        let allOperationIDs = Set(
            try await store.allOperations(ownerScope: ownerScope).map(\.operationID)
        )
        XCTAssertEqual(pendingRows, [pending])
        XCTAssertEqual(allOperationIDs, [applied.operationID, pending.operationID])
    }

    func testRevokedOwnerWriteLeaseCannotMarkOperationApplied() async throws {
        let authority = OwnerWriteLeaseAuthority()
        let ownerScope = UUID().uuidString.lowercased()
        let lease = try authority.activate(ownerScope: ownerScope, generation: 1)
        let store = PersistenceStore.makeInMemory(ownerWriteLeaseAuthority: authority)
        let operation = makePendingOperation(payload: Data("pending".utf8))
        try await store.enqueue(operation, ownerScope: ownerScope, lease: lease)

        _ = authority.revoke()
        do {
            try await store.markApplied(
                operationIDs: [operation.operationID],
                ownerScope: ownerScope,
                lease: lease
            )
            XCTFail("A revoked lease must not commit an acknowledgement")
        } catch PersistenceOwnershipError.revokedWriteLease {
            // Expected.
        }

        let pendingRows = try await store.pendingOperations(ownerScope: ownerScope)
        XCTAssertEqual(pendingRows, [operation])
    }

    func testScopeRevocationDoesNotDeleteSyncEntitiesOrCursors() async throws {
        let authority = OwnerWriteLeaseAuthority()
        let store = PersistenceStore.makeInMemory(ownerWriteLeaseAuthority: authority)
        let scope = UUID().uuidString.lowercased()
        try await apply(changes: [makeChange(seq: 1)], nextCursor: 1, scope: scope, to: store)

        _ = authority.revoke()

        XCTAssertEqual(try syncRows(in: store.container, scope: scope).count, 1)
        let cursor = try await store.cursor(scope: scope)
        XCTAssertEqual(cursor, 1)
    }

    private func makeChange(
        seq: Int64,
        entityID: UUID = UUID(),
        operation: String = "upsert",
        version: Int64 = 1,
        payload: [String: JSONValue] = ["nickname": .string("Spott")]
    ) -> SyncChange {
        SyncChange(
            seq: seq,
            topic: "user",
            entityType: "profile",
            entityId: entityID,
            operation: operation,
            version: version,
            changedFields: ["nickname"],
            payload: payload
        )
    }

    private func makePendingOperation(payload: Data) -> PendingOperation {
        PendingOperation(
            operationID: UUID(),
            entityType: "registration",
            entityID: UUID(),
            action: "cancel",
            baseVersion: 1,
            payload: payload,
            dependencies: []
        )
    }

    private func writePage(
        changes: [SyncChange],
        nextCursor: Int64,
        scope: String,
        storeURL: URL
    ) async throws {
        let store = try makePersistentStore(at: storeURL)
        try await apply(changes: changes, nextCursor: nextCursor, scope: scope, to: store)
    }

    private func apply(
        changes: [SyncChange],
        nextCursor: Int64,
        scope: String,
        to store: PersistenceStore
    ) async throws {
        let generation = store.ownerWriteLeaseAuthority.revoke()
        let lease = try store.ownerWriteLeaseAuthority.activate(
            ownerScope: scope,
            generation: generation
        )
        try await store.apply(
            changes: changes,
            nextCursor: nextCursor,
            scope: scope,
            lease: lease
        )
    }

    private func makePersistentStore(at url: URL) throws -> PersistenceStore {
        let schema = Schema([
            CachedEvent.self,
            StoredOperation.self,
            StoredCursor.self,
            LocalEventDraft.self,
            StoredSyncEntity.self,
            PersistenceMetadata.self,
        ])
        let configuration = ModelConfiguration(
            "PersistenceStoreSyncTests",
            schema: schema,
            url: url,
            allowsSave: true,
            cloudKitDatabase: .none
        )
        return try PersistenceStore(
            container: ModelContainer(for: schema, configurations: [configuration])
        )
    }

    private func insertUserRow(
        kind: PersistenceStoreUserRowKind,
        ownerScope: String,
        into container: ModelContainer
    ) throws {
        let context = ModelContext(container)
        switch kind {
        case .operation:
            context.insert(StoredOperation(
                ownerScope: ownerScope,
                operationID: UUID(),
                entityType: "registration",
                entityID: UUID(),
                action: "cancel",
                baseVersion: 1,
                payload: Data("owner-validation".utf8)
            ))
        case .draft:
            context.insert(LocalEventDraft(
                ownerScope: ownerScope,
                title: "owner validation",
                payload: Data("owner-validation".utf8)
            ))
        }
        try context.save()
    }

    private func syncRows(
        in container: ModelContainer,
        scope: String
    ) throws -> [StoredSyncEntity] {
        let context = ModelContext(container)
        let descriptor = FetchDescriptor<StoredSyncEntity>(
            predicate: #Predicate { $0.userScope == scope },
            sortBy: [SortDescriptor(\.seq)]
        )
        return try context.fetch(descriptor)
    }
}

private enum PersistenceStoreUserRowKind: String, CaseIterable {
    case operation
    case draft
}
