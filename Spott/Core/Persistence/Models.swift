import Foundation
import SwiftData

@Model
final class CachedEvent {
    @Attribute(.unique) var id: UUID
    var payload: Data
    var updatedAt: Date
    init(id: UUID, payload: Data, updatedAt: Date) { self.id = id; self.payload = payload; self.updatedAt = updatedAt }
}

@Model
final class StoredOperation {
    @Attribute(.unique) var operationID: UUID
    var ownerScope: String = ""
    var entityType: String
    var entityID: UUID?
    var action: String
    var baseVersion: Int64?
    var payload: Data
    var dependencies: [UUID]
    var state: String
    var attempts: Int
    var createdAt: Date
    init(ownerScope: String, operationID: UUID, entityType: String, entityID: UUID?, action: String, baseVersion: Int64?, payload: Data, dependencies: [UUID] = []) {
        self.ownerScope = ownerScope; self.operationID = operationID; self.entityType = entityType; self.entityID = entityID; self.action = action; self.baseVersion = baseVersion; self.payload = payload; self.dependencies = dependencies; state = "pending"; attempts = 0; createdAt = .now
    }
}

@Model
final class StoredCursor {
    @Attribute(.unique) var scope: String
    var value: Int64
    var updatedAt: Date
    init(scope: String, value: Int64 = 0) { self.scope = scope; self.value = value; updatedAt = .now }
}

@Model
final class StoredSyncEntity {
    @Attribute(.unique) var identity: String
    var userScope: String
    var entityType: String
    var entityID: UUID
    var version: Int64
    var seq: Int64
    var isTombstone: Bool
    var payload: Data
    var updatedAt: Date

    init(
        userScope: String,
        entityType: String,
        entityID: UUID,
        version: Int64,
        seq: Int64,
        isTombstone: Bool,
        payload: Data
    ) {
        identity = Self.identity(userScope: userScope, entityType: entityType, entityID: entityID)
        self.userScope = userScope
        self.entityType = entityType
        self.entityID = entityID
        self.version = version
        self.seq = seq
        self.isTombstone = isTombstone
        self.payload = payload
        updatedAt = .now
    }

    static func identity(userScope: String, entityType: String, entityID: UUID) -> String {
        let encodedScope = Data(userScope.utf8).base64EncodedString()
        let encodedType = Data(entityType.utf8).base64EncodedString()
        return "\(encodedScope):\(encodedType):\(entityID.uuidString.lowercased())"
    }
}

@Model
final class LocalEventDraft {
    @Attribute(.unique) var localID: UUID
    var ownerScope: String = ""
    var serverID: UUID?
    var title: String
    var payload: Data
    var draftRevision: Int
    var serverVersion: Int?
    var updatedAt: Date
    init(ownerScope: String, localID: UUID = UUID(), title: String = "", payload: Data = Data()) { self.ownerScope = ownerScope; self.localID = localID; self.title = title; self.payload = payload; draftRevision = 1; updatedAt = .now }
}

@Model
final class PersistenceMetadata {
    @Attribute(.unique) var identity: String
    var storeGeneration: UUID
    var schemaVersion: Int
    var legacySourceIdentifier: String?

    init(
        identity: String = "user-store",
        storeGeneration: UUID = UUID(),
        schemaVersion: Int = 1,
        legacySourceIdentifier: String? = nil
    ) {
        self.identity = identity
        self.storeGeneration = storeGeneration
        self.schemaVersion = schemaVersion
        self.legacySourceIdentifier = legacySourceIdentifier
    }
}

struct StoredOperationSnapshot: Equatable, Sendable {
    let operationID: UUID
    let ownerScope: String
    let entityType: String
    let entityID: UUID?
    let action: String
    let baseVersion: Int64?
    let payload: Data
    let dependencies: [UUID]
    let state: String
    let attempts: Int
    let createdAt: Date
}

struct LocalEventDraftSnapshot: Equatable, Sendable {
    let localID: UUID
    let serverID: UUID?
    let title: String
    let payload: Data
    let draftRevision: Int
    let serverVersion: Int?
    let updatedAt: Date
}
