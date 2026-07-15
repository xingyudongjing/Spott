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
    var entityType: String
    var entityID: UUID?
    var action: String
    var baseVersion: Int64?
    var payload: Data
    var dependencies: [UUID]
    var state: String
    var attempts: Int
    var createdAt: Date
    init(operationID: UUID, entityType: String, entityID: UUID?, action: String, baseVersion: Int64?, payload: Data, dependencies: [UUID] = []) {
        self.operationID = operationID; self.entityType = entityType; self.entityID = entityID; self.action = action; self.baseVersion = baseVersion; self.payload = payload; self.dependencies = dependencies; state = "pending"; attempts = 0; createdAt = .now
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
final class LocalEventDraft {
    @Attribute(.unique) var localID: UUID
    var serverID: UUID?
    var title: String
    var payload: Data
    var draftRevision: Int
    var serverVersion: Int?
    var updatedAt: Date
    init(localID: UUID = UUID(), title: String = "", payload: Data = Data()) { self.localID = localID; self.title = title; self.payload = payload; draftRevision = 1; updatedAt = .now }
}
