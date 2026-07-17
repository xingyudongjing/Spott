import CryptoKit
import Darwin
import Foundation

enum PersistenceRecoveryPrimitiveError: Error, Equatable, Sendable {
    case corruptEnvelope
    case unsupportedVersion
    case ownerMismatch
    case invalidPhaseTransition
    case journalAlreadyExists
    case journalMissing
    case journalIdentityMismatch
    case ambiguousTemporaryState
}

protocol RecoveryEnvelopePersisting: Actor {
    func read() throws -> Data?
    func replace(with data: Data) throws
}

enum DurableEnvelopeWriteStep: Int, CaseIterable, Sendable {
    case temporaryCreated
    case bytesWritten
    case fileFlushed
    case atomicallyRenamed
    case directoryFlushed

    var happensBeforeAtomicRename: Bool {
        rawValue < Self.atomicallyRenamed.rawValue
    }
}

enum DurableEnvelopeFaultTiming: CaseIterable, Sendable {
    case before
    case after
}

protocol DurableEnvelopeFaultInjecting: Sendable {
    func reached(_ step: DurableEnvelopeWriteStep) throws
    func reached(
        _ step: DurableEnvelopeWriteStep,
        timing: DurableEnvelopeFaultTiming
    ) throws
}

extension DurableEnvelopeFaultInjecting {
    func reached(_ step: DurableEnvelopeWriteStep) throws { _ = step }

    func reached(
        _ step: DurableEnvelopeWriteStep,
        timing: DurableEnvelopeFaultTiming
    ) throws {
        if timing == .after { try reached(step) }
    }
}

private struct NoDurableEnvelopeFaults: DurableEnvelopeFaultInjecting {
}

/// Same-directory, exclusive temporary writes with both file and directory
/// durability barriers. Any pre-rename temp/final ambiguity is fail-closed.
actor DurableRecoveryEnvelopeFile: RecoveryEnvelopePersisting {
    private let directory: URL
    private let fileName: String
    private let faultInjector: any DurableEnvelopeFaultInjecting

    init(
        directory: URL,
        fileName: String,
        faultInjector: any DurableEnvelopeFaultInjecting = NoDurableEnvelopeFaults()
    ) {
        self.directory = directory
        self.fileName = fileName
        self.faultInjector = faultInjector
    }

    func read() throws -> Data? {
        guard try temporaryURLs().isEmpty else {
            throw PersistenceRecoveryPrimitiveError.ambiguousTemporaryState
        }
        let finalURL = directory.appendingPathComponent(fileName, isDirectory: false)
        guard FileManager.default.fileExists(atPath: finalURL.path) else { return nil }
        return try Data(contentsOf: finalURL, options: [.mappedIfSafe])
    }

    func replace(with data: Data) throws {
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        guard try temporaryURLs().isEmpty else {
            throw PersistenceRecoveryPrimitiveError.ambiguousTemporaryState
        }

        let temporaryURL = directory.appendingPathComponent(
            ".\(fileName).\(UUID().uuidString.lowercased()).tmp",
            isDirectory: false
        )
        let finalURL = directory.appendingPathComponent(fileName, isDirectory: false)
        try faultInjector.reached(.temporaryCreated, timing: .before)
        let descriptor = Darwin.open(
            temporaryURL.path,
            O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC,
            S_IRUSR | S_IWUSR
        )
        guard descriptor >= 0 else { throw Self.posixError() }
        var isOpen = true
        defer {
            if isOpen { _ = Darwin.close(descriptor) }
        }

        try faultInjector.reached(.temporaryCreated, timing: .after)
        try faultInjector.reached(.bytesWritten, timing: .before)
        try Self.writeAll(data, to: descriptor)
        try faultInjector.reached(.bytesWritten, timing: .after)
        try faultInjector.reached(.fileFlushed, timing: .before)
        guard Darwin.fsync(descriptor) == 0 else { throw Self.posixError() }
        try faultInjector.reached(.fileFlushed, timing: .after)
        guard Darwin.close(descriptor) == 0 else { throw Self.posixError() }
        isOpen = false

        try faultInjector.reached(.atomicallyRenamed, timing: .before)
        guard Darwin.rename(temporaryURL.path, finalURL.path) == 0 else {
            throw Self.posixError()
        }
        try faultInjector.reached(.atomicallyRenamed, timing: .after)

        let directoryDescriptor = Darwin.open(directory.path, O_RDONLY | O_CLOEXEC)
        guard directoryDescriptor >= 0 else { throw Self.posixError() }
        defer { _ = Darwin.close(directoryDescriptor) }
        try faultInjector.reached(.directoryFlushed, timing: .before)
        guard Darwin.fsync(directoryDescriptor) == 0 else { throw Self.posixError() }
        try faultInjector.reached(.directoryFlushed, timing: .after)
    }

    private func temporaryURLs() throws -> [URL] {
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        let prefix = ".\(fileName)."
        return try FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil
        ).filter {
            $0.lastPathComponent.hasPrefix(prefix) &&
                $0.lastPathComponent.hasSuffix(".tmp")
        }
    }

    private static func writeAll(_ data: Data, to descriptor: Int32) throws {
        try data.withUnsafeBytes { rawBuffer in
            guard var pointer = rawBuffer.baseAddress else { return }
            var remaining = rawBuffer.count
            while remaining > 0 {
                let written = Darwin.write(descriptor, pointer, remaining)
                if written < 0 {
                    if errno == EINTR { continue }
                    throw posixError()
                }
                guard written > 0 else { throw posixError(code: EIO) }
                remaining -= written
                pointer = pointer.advanced(by: written)
            }
        }
    }

    private static func posixError(code: Int32 = errno) -> POSIXError {
        POSIXError(POSIXErrorCode(rawValue: code) ?? .EIO)
    }
}

enum ConfirmedFreshStartPhase: Int, CaseIterable, Codable, Sendable {
    case prepared = 0
    case recoverySnapshotVerified
    case userStoreResetRecorded
    case cacheStoreResetRecorded
    case legacyOwnerRetired
    case completed
}

struct ConfirmedFreshStartDescriptor: Equatable, Sendable {
    let journalID: UUID
    let authenticatedOwnerScope: String
    let userStoreGeneration: UUID
    let cacheStoreGeneration: UUID
    let sourceManifests: [String]
    let confirmationNonceHashes: [String]
}

struct ConfirmedFreshStartJournalEnvelope: Codable, Equatable, Sendable {
    let formatVersion: Int
    let journalID: UUID
    let phaseSequence: UInt64
    let ownerHash: String
    let userStoreGeneration: UUID
    let cacheStoreGeneration: UUID
    let sourceManifests: [String]
    let phase: ConfirmedFreshStartPhase
    let confirmationNonceHashes: [String]

    fileprivate func encoded() throws -> Data {
        try RecoveryEnvelopeCodec.encode(self)
    }

    fileprivate static func decode(_ data: Data) throws -> Self {
        let envelope: Self = try RecoveryEnvelopeCodec.decode(data)
        guard envelope.formatVersion == 1 else {
            throw PersistenceRecoveryPrimitiveError.unsupportedVersion
        }
        guard envelope.phaseSequence == UInt64(envelope.phase.rawValue),
              envelope.sourceManifests.count >= 1,
              envelope.sourceManifests.allSatisfy({ !$0.isEmpty }),
              envelope.confirmationNonceHashes.count == 2,
              Set(envelope.confirmationNonceHashes).count == 2,
              envelope.confirmationNonceHashes.allSatisfy({ !$0.isEmpty }) else {
            throw PersistenceRecoveryPrimitiveError.corruptEnvelope
        }
        return envelope
    }
}

/// Task 0's non-destructive journal state machine. Its storage is injected so
/// crash tests can replace the process between every durable phase. No method
/// in this primitive can delete a store or mutate Keychain credentials.
actor ConfirmedFreshStartJournalPrimitive {
    private let storage: any RecoveryEnvelopePersisting

    init(storage: any RecoveryEnvelopePersisting) {
        self.storage = storage
    }

    func begin(
        _ descriptor: ConfirmedFreshStartDescriptor
    ) async throws -> ConfirmedFreshStartJournalEnvelope {
        guard try await storage.read() == nil else {
            throw PersistenceRecoveryPrimitiveError.journalAlreadyExists
        }
        let ownerScope = try OwnerWriteLeaseAuthority.normalizedOwnerScope(
            descriptor.authenticatedOwnerScope
        )
        guard !descriptor.sourceManifests.isEmpty,
              descriptor.sourceManifests.allSatisfy({ !$0.isEmpty }),
              descriptor.confirmationNonceHashes.count == 2,
              Set(descriptor.confirmationNonceHashes).count == 2,
              descriptor.confirmationNonceHashes.allSatisfy({ !$0.isEmpty }) else {
            throw PersistenceRecoveryPrimitiveError.corruptEnvelope
        }
        let envelope = ConfirmedFreshStartJournalEnvelope(
            formatVersion: 1,
            journalID: descriptor.journalID,
            phaseSequence: 0,
            ownerHash: RecoveryEnvelopeCodec.ownerHash(ownerScope),
            userStoreGeneration: descriptor.userStoreGeneration,
            cacheStoreGeneration: descriptor.cacheStoreGeneration,
            sourceManifests: descriptor.sourceManifests.sorted(),
            phase: .prepared,
            confirmationNonceHashes: descriptor.confirmationNonceHashes
        )
        try await storage.replace(with: envelope.encoded())
        return envelope
    }

    func recover(
        authenticatedOwnerScope: String
    ) async throws -> ConfirmedFreshStartJournalEnvelope? {
        guard let data = try await storage.read() else { return nil }
        let envelope = try ConfirmedFreshStartJournalEnvelope.decode(data)
        let ownerScope = try OwnerWriteLeaseAuthority.normalizedOwnerScope(
            authenticatedOwnerScope
        )
        guard envelope.ownerHash == RecoveryEnvelopeCodec.ownerHash(ownerScope) else {
            throw PersistenceRecoveryPrimitiveError.ownerMismatch
        }
        return envelope
    }

    func advance(
        journalID: UUID,
        authenticatedOwnerScope: String,
        to nextPhase: ConfirmedFreshStartPhase
    ) async throws -> ConfirmedFreshStartJournalEnvelope {
        guard let current = try await recover(
            authenticatedOwnerScope: authenticatedOwnerScope
        ) else {
            throw PersistenceRecoveryPrimitiveError.journalMissing
        }
        guard current.journalID == journalID else {
            throw PersistenceRecoveryPrimitiveError.journalIdentityMismatch
        }
        guard nextPhase.rawValue == current.phase.rawValue + 1 else {
            throw PersistenceRecoveryPrimitiveError.invalidPhaseTransition
        }
        let next = ConfirmedFreshStartJournalEnvelope(
            formatVersion: current.formatVersion,
            journalID: current.journalID,
            phaseSequence: current.phaseSequence + 1,
            ownerHash: current.ownerHash,
            userStoreGeneration: current.userStoreGeneration,
            cacheStoreGeneration: current.cacheStoreGeneration,
            sourceManifests: current.sourceManifests,
            phase: nextPhase,
            confirmationNonceHashes: current.confirmationNonceHashes
        )
        try await storage.replace(with: next.encoded())
        return next
    }
}

enum LegacyOwnerStateKind: String, Codable, Sendable {
    case bound
    case retired
}

struct LegacyOwnerStateEnvelope: Codable, Equatable, Sendable {
    let formatVersion: Int
    let state: LegacyOwnerStateKind
    let ownerHash: String
    let sourceManifest: String
    let userStoreGeneration: UUID

    static func bound(
        ownerScope: String,
        sourceManifest: String,
        userStoreGeneration: UUID
    ) throws -> Self {
        try make(
            state: .bound,
            ownerScope: ownerScope,
            sourceManifest: sourceManifest,
            userStoreGeneration: userStoreGeneration
        )
    }

    static func retired(
        ownerScope: String,
        noReimportSourceManifest: String,
        userStoreGeneration: UUID
    ) throws -> Self {
        try make(
            state: .retired,
            ownerScope: ownerScope,
            sourceManifest: noReimportSourceManifest,
            userStoreGeneration: userStoreGeneration
        )
    }

    func retiring(noReimportSourceManifest: String) throws -> Self {
        guard state == .bound,
              !noReimportSourceManifest.isEmpty else {
            throw PersistenceRecoveryPrimitiveError.invalidPhaseTransition
        }
        return Self(
            formatVersion: formatVersion,
            state: .retired,
            ownerHash: ownerHash,
            sourceManifest: noReimportSourceManifest,
            userStoreGeneration: userStoreGeneration
        )
    }

    func encoded() throws -> Data {
        try RecoveryEnvelopeCodec.encode(self)
    }

    fileprivate static func decode(_ data: Data) throws -> Self {
        let envelope: Self = try RecoveryEnvelopeCodec.decode(data)
        guard envelope.formatVersion == 1 else {
            throw PersistenceRecoveryPrimitiveError.unsupportedVersion
        }
        guard !envelope.ownerHash.isEmpty,
              !envelope.sourceManifest.isEmpty else {
            throw PersistenceRecoveryPrimitiveError.corruptEnvelope
        }
        return envelope
    }

    private static func make(
        state: LegacyOwnerStateKind,
        ownerScope: String,
        sourceManifest: String,
        userStoreGeneration: UUID
    ) throws -> Self {
        let ownerScope = try OwnerWriteLeaseAuthority.normalizedOwnerScope(ownerScope)
        guard !sourceManifest.isEmpty else {
            throw PersistenceRecoveryPrimitiveError.corruptEnvelope
        }
        return Self(
            formatVersion: 1,
            state: state,
            ownerHash: RecoveryEnvelopeCodec.ownerHash(ownerScope),
            sourceManifest: sourceManifest,
            userStoreGeneration: userStoreGeneration
        )
    }
}

enum LegacyOwnerStateResolution: Equatable, Sendable {
    case bound(ownerHash: String)
    case retired(ownerHash: String)
}

enum LegacyOwnerStateResolver {
    static func resolve(
        envelopeData: Data,
        legacyDefaultsOwnerScope: String?
    ) throws -> LegacyOwnerStateResolution {
        let envelope = try LegacyOwnerStateEnvelope.decode(envelopeData)
        if envelope.state == .retired {
            // A resurrected UserDefaults value is advisory legacy input only and
            // can never override this durable terminal no-reimport tombstone.
            return .retired(ownerHash: envelope.ownerHash)
        }
        guard let legacyDefaultsOwnerScope else {
            throw PersistenceRecoveryPrimitiveError.ownerMismatch
        }
        let normalized = try OwnerWriteLeaseAuthority.normalizedOwnerScope(
            legacyDefaultsOwnerScope
        )
        guard RecoveryEnvelopeCodec.ownerHash(normalized) == envelope.ownerHash else {
            throw PersistenceRecoveryPrimitiveError.ownerMismatch
        }
        return .bound(ownerHash: envelope.ownerHash)
    }
}

protocol LegacyOwnerDefaultsAdvising: Actor {
    func ownerScope() throws -> String?
    func removeOwnerScope() throws
}

/// The old defaults key is migration input only. It is intentionally isolated
/// behind this narrow adapter so bootstrap can read it without making
/// `UserDefaults` a source of truth and can remove it only as advisory cleanup.
actor UserDefaultsLegacyOwnerAdapter: LegacyOwnerDefaultsAdvising {
    static let legacyOwnerKey = "jp.spott.sync.owner-user-id"

    private let defaults: UserDefaults
    private let key: String

    init(
        defaults: UserDefaults = .standard,
        key: String = UserDefaultsLegacyOwnerAdapter.legacyOwnerKey
    ) {
        self.defaults = defaults
        self.key = key
    }

    func ownerScope() -> String? {
        defaults.string(forKey: key)
    }

    func removeOwnerScope() {
        defaults.removeObject(forKey: key)
    }
}

enum LegacyOwnerAdvisoryCleanupFaultPoint: CaseIterable, Sendable {
    case beforeDefaultsRemoval
    case afterDefaultsRemoval
}

protocol LegacyOwnerTransitionFaultInjecting: Sendable {
    func reached(_ point: LegacyOwnerAdvisoryCleanupFaultPoint) throws
}

private struct NoLegacyOwnerTransitionFaults: LegacyOwnerTransitionFaultInjecting {
    func reached(_ point: LegacyOwnerAdvisoryCleanupFaultPoint) throws { _ = point }
}

/// Moves a durable bound owner record to the terminal no-reimport state before
/// touching the advisory legacy defaults key. Defaults cleanup failure is
/// deliberately ignored; injected termination boundaries remain observable to
/// prove that either outcome relaunches from the terminal envelope.
actor LegacyOwnerStateTransitionPrimitive {
    private let envelopeStorage: any RecoveryEnvelopePersisting
    private let legacyDefaults: any LegacyOwnerDefaultsAdvising
    private let faultInjector: any LegacyOwnerTransitionFaultInjecting

    init(
        envelopeStorage: any RecoveryEnvelopePersisting,
        legacyDefaults: any LegacyOwnerDefaultsAdvising,
        faultInjector: any LegacyOwnerTransitionFaultInjecting = NoLegacyOwnerTransitionFaults()
    ) {
        self.envelopeStorage = envelopeStorage
        self.legacyDefaults = legacyDefaults
        self.faultInjector = faultInjector
    }

    func retire(
        authenticatedOwnerScope: String,
        noReimportSourceManifest: String,
        userStoreGeneration: UUID
    ) async throws -> LegacyOwnerStateEnvelope {
        guard let existingData = try await envelopeStorage.read() else {
            throw PersistenceRecoveryPrimitiveError.corruptEnvelope
        }
        let current = try LegacyOwnerStateEnvelope.decode(existingData)
        guard current.state == .bound,
              current.userStoreGeneration == userStoreGeneration else {
            throw PersistenceRecoveryPrimitiveError.invalidPhaseTransition
        }
        let recordedOwner = try LegacyOwnerStateEnvelope.bound(
            ownerScope: authenticatedOwnerScope,
            sourceManifest: current.sourceManifest,
            userStoreGeneration: userStoreGeneration
        )
        guard recordedOwner.ownerHash == current.ownerHash else {
            throw PersistenceRecoveryPrimitiveError.ownerMismatch
        }

        let retired = try current.retiring(
            noReimportSourceManifest: noReimportSourceManifest
        )
        try await envelopeStorage.replace(with: retired.encoded())
        try faultInjector.reached(.beforeDefaultsRemoval)
        do {
            try await legacyDefaults.removeOwnerScope()
        } catch {
            // The durable terminal envelope is authoritative; old defaults are
            // advisory input and cleanup must never weaken that state.
        }
        try faultInjector.reached(.afterDefaultsRemoval)
        return retired
    }
}

/// Task 0 keeps the real legacy row transformation behind this bootstrap-only
/// boundary. Task 4 supplies the verified snapshot-backed implementation.
protocol LegacyOwnerRowMigrating: Actor {
    func scopeAndMigrateLegacyRows(ownerScope: String) throws
}

enum LegacyOwnerBootstrapResult: Equatable, Sendable {
    case noMigrationRequired
    case migrated(ownerScope: String)
    case retiredNoReimport(ownerScope: String)
}

/// Resolves all read-only ownership evidence before allowing the destination
/// migrator to open or write a user store. A first import durably records a
/// bound envelope before the migration callback is invoked.
actor LegacyOwnerBootstrapPrimitive {
    private let authenticatedOwnerProvider: any AuthenticatedOwnerProviding
    private let legacyDefaults: any LegacyOwnerDefaultsAdvising
    private let envelopeStorage: any RecoveryEnvelopePersisting
    private let migrator: any LegacyOwnerRowMigrating

    init(
        authenticatedOwnerProvider: any AuthenticatedOwnerProviding,
        legacyDefaults: any LegacyOwnerDefaultsAdvising,
        envelopeStorage: any RecoveryEnvelopePersisting,
        migrator: any LegacyOwnerRowMigrating
    ) {
        self.authenticatedOwnerProvider = authenticatedOwnerProvider
        self.legacyDefaults = legacyDefaults
        self.envelopeStorage = envelopeStorage
        self.migrator = migrator
    }

    func scopeAndMigrateIfAuthorized(
        hasLegacyUnownedRows: Bool,
        sourceManifest: String,
        userStoreGeneration: UUID,
        durableEnvelopeRequired: Bool
    ) async throws -> LegacyOwnerBootstrapResult {
        let existingEnvelopeData = try await envelopeStorage.read()
        if durableEnvelopeRequired, existingEnvelopeData == nil {
            throw PersistenceRecoveryPrimitiveError.corruptEnvelope
        }
        let normalizedAuthenticatedOwner: String
        let expectedEnvelope: LegacyOwnerStateEnvelope
        if let existingEnvelopeData {
            guard let authenticatedOwner = try await authenticatedOwnerProvider
                .authenticatedOwnerScope() else {
                throw PersistenceOwnershipError.unresolvedLegacyOwner
            }
            normalizedAuthenticatedOwner = try OwnerWriteLeaseAuthority
                .normalizedOwnerScope(authenticatedOwner)
            expectedEnvelope = try LegacyOwnerStateEnvelope.bound(
                ownerScope: normalizedAuthenticatedOwner,
                sourceManifest: sourceManifest,
                userStoreGeneration: userStoreGeneration
            )
            let existingEnvelope = try LegacyOwnerStateEnvelope.decode(existingEnvelopeData)
            guard existingEnvelope.ownerHash == expectedEnvelope.ownerHash else {
                throw PersistenceOwnershipError.ownershipMismatch
            }
            guard existingEnvelope.sourceManifest == sourceManifest,
                  existingEnvelope.userStoreGeneration == userStoreGeneration else {
                throw PersistenceRecoveryPrimitiveError.corruptEnvelope
            }
            switch existingEnvelope.state {
            case .bound:
                break
            case .retired:
                return .retiredNoReimport(ownerScope: normalizedAuthenticatedOwner)
            }
        } else {
            guard hasLegacyUnownedRows else {
                return .noMigrationRequired
            }
            guard let authenticatedOwner = try await authenticatedOwnerProvider
                .authenticatedOwnerScope() else {
                throw PersistenceOwnershipError.unresolvedLegacyOwner
            }
            normalizedAuthenticatedOwner = try OwnerWriteLeaseAuthority
                .normalizedOwnerScope(authenticatedOwner)
            expectedEnvelope = try LegacyOwnerStateEnvelope.bound(
                ownerScope: normalizedAuthenticatedOwner,
                sourceManifest: sourceManifest,
                userStoreGeneration: userStoreGeneration
            )
        }

        guard hasLegacyUnownedRows else {
            return .noMigrationRequired
        }

        guard let legacyDefaultsOwner = try await legacyDefaults.ownerScope() else {
            throw PersistenceOwnershipError.unresolvedLegacyOwner
        }
        let normalizedDefaultsOwner = try OwnerWriteLeaseAuthority
            .normalizedOwnerScope(legacyDefaultsOwner)
        guard normalizedAuthenticatedOwner == normalizedDefaultsOwner else {
            throw PersistenceOwnershipError.ownershipMismatch
        }
        if existingEnvelopeData == nil {
            try await envelopeStorage.replace(with: expectedEnvelope.encoded())
        }

        try await migrator.scopeAndMigrateLegacyRows(
            ownerScope: normalizedAuthenticatedOwner
        )
        return .migrated(ownerScope: normalizedAuthenticatedOwner)
    }
}

enum PersistenceOwnershipEvidenceStatus: Equatable, Sendable {
    case provenRecordedOwner
    case missingOwner
    case corruptOwner
    case mismatchedOwner
}

enum PersistenceRecoveryCapability: Hashable, Sendable {
    case retry
    case redactedManifest
    case reauthenticateRecordedOwner
    case ownerFilteredRawExport
    case confirmedFreshStart
    case deleteRecoveryMaterial
}

enum PersistenceRecoveryCapabilityPolicy {
    static func allowedCapabilities(
        for status: PersistenceOwnershipEvidenceStatus
    ) -> Set<PersistenceRecoveryCapability> {
        let denyByDefault: Set<PersistenceRecoveryCapability> = [
            .retry,
            .redactedManifest,
            .reauthenticateRecordedOwner,
        ]
        guard status == .provenRecordedOwner else { return denyByDefault }
        return denyByDefault.union([
            .ownerFilteredRawExport,
            .confirmedFreshStart,
            .deleteRecoveryMaterial,
        ])
    }
}

private enum RecoveryEnvelopeCodec {
    private struct Checksummed<Payload: Codable>: Codable {
        let payload: Payload
        let checksum: String
    }

    static func encode<Payload: Codable>(_ payload: Payload) throws -> Data {
        do {
            let payloadData = try encoder.encode(payload)
            return try encoder.encode(
                Checksummed(payload: payload, checksum: digest(payloadData))
            )
        } catch let error as PersistenceRecoveryPrimitiveError {
            throw error
        } catch {
            throw PersistenceRecoveryPrimitiveError.corruptEnvelope
        }
    }

    static func decode<Payload: Codable>(_ data: Data) throws -> Payload {
        do {
            let record = try decoder.decode(Checksummed<Payload>.self, from: data)
            let canonicalPayload = try encoder.encode(record.payload)
            guard digest(canonicalPayload) == record.checksum else {
                throw PersistenceRecoveryPrimitiveError.corruptEnvelope
            }
            return record.payload
        } catch let error as PersistenceRecoveryPrimitiveError {
            throw error
        } catch {
            throw PersistenceRecoveryPrimitiveError.corruptEnvelope
        }
    }

    static func ownerHash(_ normalizedOwnerScope: String) -> String {
        digest(Data(normalizedOwnerScope.utf8))
    }

    private static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()

    private static let decoder = JSONDecoder()
}
