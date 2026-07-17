import Foundation

enum PersistenceOwnershipError: Error, Equatable, Sendable {
    case missingOwnerScope
    case invalidOwnerScope
    case ownershipMismatch
    case unresolvedLegacyOwner
    case staleGeneration
    case revokedWriteLease
}
struct OwnerWriteLease: Equatable, Sendable {
    let ownerScope: String
    let generation: UInt64
    fileprivate let nonce: UUID
}

/// Process-wide authority for user-store writes. Revocation is synchronous so an
/// authentication boundary can close before `AppModel` publishes a new session.
final class OwnerWriteLeaseAuthority: @unchecked Sendable {
    private struct State {
        var generation: UInt64 = 0
        var activeLease: OwnerWriteLease?
    }

    private let lock = NSLock()
    private var state = State()

    func activate(ownerScope: String, generation: UInt64) throws -> OwnerWriteLease {
        let normalizedOwner = try Self.normalizedOwnerScope(ownerScope)
        return try lock.withLock {
            guard generation >= state.generation else {
                throw PersistenceOwnershipError.staleGeneration
            }
            if generation == state.generation, let activeLease = state.activeLease {
                guard activeLease.ownerScope == normalizedOwner else {
                    throw PersistenceOwnershipError.staleGeneration
                }
                return activeLease
            }
            state.generation = generation
            let lease = OwnerWriteLease(
                ownerScope: normalizedOwner,
                generation: generation,
                nonce: UUID()
            )
            state.activeLease = lease
            return lease
        }
    }

    /// Closes the current lease and advances the process epoch in one lock hold.
    @discardableResult
    func revoke() -> UInt64 {
        lock.withLock {
            state.generation &+= 1
            state.activeLease = nil
            return state.generation
        }
    }

    /// Idempotent companion used by the async lifecycle after synchronous revoke.
    @discardableResult
    func revoke(atLeast generation: UInt64) -> UInt64 {
        lock.withLock {
            if generation > state.generation {
                state.generation = generation
            }
            state.activeLease = nil
            return state.generation
        }
    }

    func validate(_ lease: OwnerWriteLease, ownerScope: String) throws {
        let normalizedOwner = try Self.normalizedOwnerScope(ownerScope)
        try lock.withLock {
            guard lease.ownerScope == normalizedOwner else {
                throw PersistenceOwnershipError.ownershipMismatch
            }
            guard state.activeLease == lease,
                  state.generation == lease.generation else {
                throw PersistenceOwnershipError.revokedWriteLease
            }
        }
    }

    /// The save runs while the authority lock is held. Therefore revoke either
    /// wins before the save (and the save is rejected) or waits until that save
    /// has fully committed; it can never return while a stale save is in flight.
    func withValidatedLease<T>(
        _ lease: OwnerWriteLease,
        ownerScope: String,
        _ body: () throws -> T
    ) throws -> T {
        let normalizedOwner = try Self.normalizedOwnerScope(ownerScope)
        return try lock.withLock {
            guard lease.ownerScope == normalizedOwner else {
                throw PersistenceOwnershipError.ownershipMismatch
            }
            guard state.activeLease == lease,
                  state.generation == lease.generation else {
                throw PersistenceOwnershipError.revokedWriteLease
            }
            return try body()
        }
    }

    static func normalizedOwnerScope(_ ownerScope: String) throws -> String {
        let candidate = ownerScope.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !candidate.isEmpty else { throw PersistenceOwnershipError.missingOwnerScope }
        guard let ownerID = UUID(uuidString: candidate) else {
            throw PersistenceOwnershipError.invalidOwnerScope
        }
        return ownerID.uuidString.lowercased()
    }
}
