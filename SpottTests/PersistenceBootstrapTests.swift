import XCTest
@testable import Spott

@MainActor
final class PersistenceBootstrapTests: XCTestCase {
    func testAuthenticatedOwnerProviderReturnsOnlyNormalizedSessionOwner() async throws {
        let session = UserSession(
            accessToken: "must-never-escape",
            refreshToken: "must-never-escape",
            sessionId: UUID(),
            accessTokenExpiresAt: Date(timeIntervalSince1970: 1_800_000_000),
            user: .init(
                id: UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")!,
                publicHandle: "private-handle",
                phoneVerified: true,
                restrictions: []
            )
        )
        let provider = KeychainAuthenticatedOwnerProvider(
            credentials: PersistenceBootstrapCredentialStore(session: session)
        )

        let owner = try await provider.authenticatedOwnerScope()

        XCTAssertEqual(owner, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
        XCTAssertFalse(owner?.contains(session.accessToken) == true)
        XCTAssertFalse(owner?.contains(session.user.publicHandle) == true)
    }

    func testAuthenticatedOwnerProviderReturnsNilWithoutSession() async throws {
        let provider = KeychainAuthenticatedOwnerProvider(
            credentials: PersistenceBootstrapCredentialStore(session: nil)
        )

        let owner = try await provider.authenticatedOwnerScope()
        XCTAssertNil(owner)
    }

    func testEveryConfirmedFreshStartJournalPhaseRecoversAfterSimulatedTermination() async throws {
        let storage = PersistenceBootstrapEnvelopeStorage()
        let ownerScope = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        let descriptor = ConfirmedFreshStartDescriptor(
            journalID: UUID(),
            authenticatedOwnerScope: ownerScope,
            userStoreGeneration: UUID(),
            cacheStoreGeneration: UUID(),
            sourceManifests: ["cache-manifest", "user-manifest"],
            confirmationNonceHashes: ["first-confirmation", "second-confirmation"]
        )
        var primitive = ConfirmedFreshStartJournalPrimitive(storage: storage)
        let initial = try await primitive.begin(descriptor)
        XCTAssertEqual(initial.phase, .prepared)

        for phase in ConfirmedFreshStartPhase.allCases.dropFirst() {
            _ = try await primitive.advance(
                journalID: descriptor.journalID,
                authenticatedOwnerScope: ownerScope,
                to: phase
            )
            primitive = ConfirmedFreshStartJournalPrimitive(storage: storage)
            let recovered = try await primitive.recover(
                authenticatedOwnerScope: ownerScope
            )
            XCTAssertEqual(recovered?.phase, phase)
            XCTAssertEqual(recovered?.phaseSequence, UInt64(phase.rawValue))
        }
    }

    func testFailedFreshStartBlocksImmediateDifferentAccountBootstrapInSameProcess() async throws {
        let storage = PersistenceBootstrapEnvelopeStorage()
        let primitive = ConfirmedFreshStartJournalPrimitive(storage: storage)
        let descriptor = ConfirmedFreshStartDescriptor.fixture(
            ownerScope: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        )
        _ = try await primitive.begin(descriptor)

        do {
            _ = try await primitive.recover(
                authenticatedOwnerScope: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff"
            )
            XCTFail("Another account must not continue a recorded owner's fresh start")
        } catch PersistenceRecoveryPrimitiveError.ownerMismatch {
            // Expected.
        }
    }

    func testFreshStartJournalCannotSkipAPhase() async throws {
        let storage = PersistenceBootstrapEnvelopeStorage()
        let primitive = ConfirmedFreshStartJournalPrimitive(storage: storage)
        let descriptor = ConfirmedFreshStartDescriptor.fixture(
            ownerScope: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        )
        _ = try await primitive.begin(descriptor)

        do {
            _ = try await primitive.advance(
                journalID: descriptor.journalID,
                authenticatedOwnerScope: descriptor.authenticatedOwnerScope,
                to: .cacheStoreResetRecorded
            )
            XCTFail("A durable participant phase must never be skipped")
        } catch PersistenceRecoveryPrimitiveError.invalidPhaseTransition {
            // Expected.
        }
    }

    func testLegacyOwnerStateParticipatesInTheSameFreshStartJournal() async throws {
        let owner = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        let generation = UUID()
        let journalStorage = PersistenceBootstrapEnvelopeStorage()
        let journal = ConfirmedFreshStartJournalPrimitive(storage: journalStorage)
        let descriptor = ConfirmedFreshStartDescriptor.fixture(
            ownerScope: owner,
            userStoreGeneration: generation
        )
        _ = try await journal.begin(descriptor)
        for phase in [
            ConfirmedFreshStartPhase.recoverySnapshotVerified,
            .userStoreResetRecorded,
            .cacheStoreResetRecorded,
        ] {
            _ = try await journal.advance(
                journalID: descriptor.journalID,
                authenticatedOwnerScope: owner,
                to: phase
            )
        }

        let bound = try LegacyOwnerStateEnvelope.bound(
            ownerScope: owner,
            sourceManifest: "sha256:legacy-source",
            userStoreGeneration: generation
        )
        let legacyStorage = PersistenceBootstrapEnvelopeStorage(data: try bound.encoded())
        let legacyDefaults = PersistenceBootstrapLegacyDefaults(ownerScope: owner)
        let legacyTransition = LegacyOwnerStateTransitionPrimitive(
            envelopeStorage: legacyStorage,
            legacyDefaults: legacyDefaults
        )
        _ = try await legacyTransition.retire(
            authenticatedOwnerScope: owner,
            noReimportSourceManifest: "sha256:no-reimport",
            userStoreGeneration: generation
        )
        let advanced = try await journal.advance(
            journalID: descriptor.journalID,
            authenticatedOwnerScope: owner,
            to: .legacyOwnerRetired
        )

        let legacyBytesValue = await legacyStorage.read()
        let legacyBytes = try XCTUnwrap(legacyBytesValue)
        XCTAssertEqual(advanced.phase, .legacyOwnerRetired)
        XCTAssertEqual(
            try LegacyOwnerStateResolver.resolve(
                envelopeData: legacyBytes,
                legacyDefaultsOwnerScope: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff"
            ),
            .retired(ownerHash: bound.ownerHash)
        )
        let remainingLegacyDefault = await legacyDefaults.currentOwnerScope()
        XCTAssertNil(remainingLegacyDefault)
    }

    func testCorruptFreshStartJournalBlocksAllAccountBootstrapAndPreservesBytes() async throws {
        let descriptor = ConfirmedFreshStartDescriptor.fixture(
            ownerScope: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        )
        let validStorage = PersistenceBootstrapEnvelopeStorage()
        _ = try await ConfirmedFreshStartJournalPrimitive(storage: validStorage)
            .begin(descriptor)
        let validBytesValue = await validStorage.read()
        var corruptBytes = try XCTUnwrap(validBytesValue)
        corruptBytes[corruptBytes.index(before: corruptBytes.endIndex)] ^= 0x01
        let storage = PersistenceBootstrapEnvelopeStorage(data: corruptBytes)
        let primitive = ConfirmedFreshStartJournalPrimitive(storage: storage)

        for owner in [
            descriptor.authenticatedOwnerScope,
            "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
        ] {
            do {
                _ = try await primitive.recover(
                    authenticatedOwnerScope: owner
                )
                XCTFail("A corrupt journal must block every account bootstrap")
            } catch PersistenceRecoveryPrimitiveError.corruptEnvelope {
                // Expected.
            }
        }
        let preservedBytes = await storage.read()
        XCTAssertEqual(preservedBytes, corruptBytes)
    }

    func testTruncatedFreshStartJournalBlocksAllAccountBootstrapAndPreservesBytes() async throws {
        let descriptor = ConfirmedFreshStartDescriptor.fixture(
            ownerScope: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        )
        let validStorage = PersistenceBootstrapEnvelopeStorage()
        _ = try await ConfirmedFreshStartJournalPrimitive(storage: validStorage)
            .begin(descriptor)
        let validBytesValue = await validStorage.read()
        let validBytes = try XCTUnwrap(validBytesValue)
        let truncatedBytes = Data(validBytes.prefix(max(1, validBytes.count / 2)))
        let storage = PersistenceBootstrapEnvelopeStorage(data: truncatedBytes)
        let primitive = ConfirmedFreshStartJournalPrimitive(storage: storage)

        for owner in [
            descriptor.authenticatedOwnerScope,
            "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
        ] {
            do {
                _ = try await primitive.recover(authenticatedOwnerScope: owner)
                XCTFail("A truncated journal must block every account bootstrap")
            } catch PersistenceRecoveryPrimitiveError.corruptEnvelope {
                // Expected.
            }
        }
        let preservedBytes = await storage.read()
        XCTAssertEqual(preservedBytes, truncatedBytes)
    }

    func testDurableTerminalTombstoneIgnoresResurrectedLegacyUserDefaultsValue() throws {
        let recordedOwner = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        let resurrectedOwner = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff"
        let retired = try LegacyOwnerStateEnvelope.retired(
            ownerScope: recordedOwner,
            noReimportSourceManifest: "sha256:legacy-source",
            userStoreGeneration: UUID()
        )

        let resolution = try LegacyOwnerStateResolver.resolve(
            envelopeData: retired.encoded(),
            legacyDefaultsOwnerScope: resurrectedOwner
        )

        XCTAssertEqual(resolution, .retired(ownerHash: retired.ownerHash))
    }

    func testLegacyOwnerEnvelopeChecksumFailureBlocksInsteadOfAdoptingCurrentLogin() throws {
        let bound = try LegacyOwnerStateEnvelope.bound(
            ownerScope: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            sourceManifest: "sha256:legacy-source",
            userStoreGeneration: UUID()
        )
        var bytes = try bound.encoded()
        bytes[bytes.startIndex] ^= 0xff

        XCTAssertThrowsError(
            try LegacyOwnerStateResolver.resolve(
                envelopeData: bytes,
                legacyDefaultsOwnerScope: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
            )
        ) { error in
            XCTAssertEqual(error as? PersistenceRecoveryPrimitiveError, .corruptEnvelope)
        }
    }

    func testDurableEnvelopeFileBlocksPreRenameAmbiguityAndRecoversPostRenameState() async throws {
        for step in DurableEnvelopeWriteStep.allCases {
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent("spott-envelope-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true
            )
            defer { try? FileManager.default.removeItem(at: directory) }
            let initial = Data("initial-envelope".utf8)
            let replacement = Data("replacement-envelope".utf8)
            let initialStore = DurableRecoveryEnvelopeFile(
                directory: directory,
                fileName: "legacy-owner-state"
            )
            try await initialStore.replace(with: initial)
            let faultingStore = DurableRecoveryEnvelopeFile(
                directory: directory,
                fileName: "legacy-owner-state",
                faultInjector: PersistenceBootstrapEnvelopeFault(step: step)
            )

            do {
                try await faultingStore.replace(with: replacement)
                XCTFail("The injected termination point must interrupt the write")
            } catch PersistenceBootstrapEnvelopeFault.Injected.termination {
                // Expected.
            }

            let relaunched = DurableRecoveryEnvelopeFile(
                directory: directory,
                fileName: "legacy-owner-state"
            )
            if step.happensBeforeAtomicRename {
                do {
                    _ = try await relaunched.read()
                    XCTFail("A temp/final ambiguity must block recovery")
                } catch PersistenceRecoveryPrimitiveError.ambiguousTemporaryState {
                    // Expected.
                }
            } else {
                let recovered = try await relaunched.read()
                XCTAssertEqual(recovered, replacement)
            }
        }
    }

    func testDurableEnvelopeFileCoversBeforeAndAfterEveryDurabilityBoundary() async throws {
        for step in DurableEnvelopeWriteStep.allCases {
            for timing in DurableEnvelopeFaultTiming.allCases {
                let directory = FileManager.default.temporaryDirectory
                    .appendingPathComponent(
                        "spott-envelope-boundary-\(UUID().uuidString)",
                        isDirectory: true
                    )
                try FileManager.default.createDirectory(
                    at: directory,
                    withIntermediateDirectories: true
                )
                defer { try? FileManager.default.removeItem(at: directory) }
                let initial = Data("initial-envelope".utf8)
                let replacement = Data("replacement-envelope".utf8)
                try await DurableRecoveryEnvelopeFile(
                    directory: directory,
                    fileName: "legacy-owner-state"
                ).replace(with: initial)
                let faultingStore = DurableRecoveryEnvelopeFile(
                    directory: directory,
                    fileName: "legacy-owner-state",
                    faultInjector: PersistenceBootstrapEnvelopeBoundaryFault(
                        step: step,
                        timing: timing
                    )
                )

                do {
                    try await faultingStore.replace(with: replacement)
                    XCTFail("Every before/after durability boundary must be injectable")
                } catch PersistenceBootstrapEnvelopeFault.Injected.termination {
                    // Expected.
                }

                let relaunched = DurableRecoveryEnvelopeFile(
                    directory: directory,
                    fileName: "legacy-owner-state"
                )
                let renameCompleted =
                    step.rawValue > DurableEnvelopeWriteStep.atomicallyRenamed.rawValue ||
                    (step == .atomicallyRenamed && timing == .after)
                if step == .temporaryCreated, timing == .before {
                    let recovered = try await relaunched.read()
                    XCTAssertEqual(recovered, initial)
                } else if !renameCompleted {
                    do {
                        _ = try await relaunched.read()
                        XCTFail("A surviving pre-rename temporary must block recovery")
                    } catch PersistenceRecoveryPrimitiveError.ambiguousTemporaryState {
                        // Expected.
                    }
                } else {
                    let recovered = try await relaunched.read()
                    XCTAssertEqual(recovered, replacement)
                }
            }
        }
    }

    func testMatchingKeychainOwnerAndLegacyMarkerScopesRowsAndMigrates() async throws {
        let owner = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        let storage = PersistenceBootstrapEnvelopeStorage()
        let migrator = PersistenceBootstrapLegacyMigrator()
        let primitive = LegacyOwnerBootstrapPrimitive(
            authenticatedOwnerProvider: PersistenceBootstrapOwnerProvider(ownerScope: owner),
            legacyDefaults: PersistenceBootstrapLegacyDefaults(ownerScope: owner),
            envelopeStorage: storage,
            migrator: migrator
        )
        let generation = UUID()

        let result = try await primitive.scopeAndMigrateIfAuthorized(
            hasLegacyUnownedRows: true,
            sourceManifest: "sha256:legacy-source",
            userStoreGeneration: generation,
            durableEnvelopeRequired: false
        )

        XCTAssertEqual(result, .migrated(ownerScope: owner))
        let migratedOwnerScopes = await migrator.migratedOwnerScopes()
        let storedEnvelopeData = await storage.read()
        XCTAssertEqual(migratedOwnerScopes, [owner])
        let envelopeData = try XCTUnwrap(storedEnvelopeData)
        XCTAssertEqual(
            try LegacyOwnerStateResolver.resolve(
                envelopeData: envelopeData,
                legacyDefaultsOwnerScope: owner
            ),
            .bound(ownerHash: try LegacyOwnerStateEnvelope.bound(
                ownerScope: owner,
                sourceManifest: "sha256:legacy-source",
                userStoreGeneration: generation
            ).ownerHash)
        )
    }

    func testBootstrapTerminalTombstoneIgnoresResurrectedLegacyDefaultsValue() async throws {
        let owner = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        let resurrectedOwner = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff"
        let generation = UUID()
        let retired = try LegacyOwnerStateEnvelope.retired(
            ownerScope: owner,
            noReimportSourceManifest: "sha256:legacy-source",
            userStoreGeneration: generation
        )
        let storage = PersistenceBootstrapEnvelopeStorage(data: try retired.encoded())
        let migrator = PersistenceBootstrapLegacyMigrator()
        let primitive = LegacyOwnerBootstrapPrimitive(
            authenticatedOwnerProvider: PersistenceBootstrapOwnerProvider(ownerScope: owner),
            legacyDefaults: PersistenceBootstrapLegacyDefaults(ownerScope: resurrectedOwner),
            envelopeStorage: storage,
            migrator: migrator
        )

        let result = try await primitive.scopeAndMigrateIfAuthorized(
            hasLegacyUnownedRows: true,
            sourceManifest: "sha256:legacy-source",
            userStoreGeneration: generation,
            durableEnvelopeRequired: true
        )

        XCTAssertEqual(result, .retiredNoReimport(ownerScope: owner))
        let migratedOwnerScopes = await migrator.migratedOwnerScopes()
        XCTAssertEqual(migratedOwnerScopes, [])
    }

    func testLegacyOwnerStateSurvivesEveryRenameFsyncAndDefaultsRemovalCrashPoint() async throws {
        let owner = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        let generation = UUID()
        for point in LegacyOwnerAdvisoryCleanupFaultPoint.allCases {
            let bound = try LegacyOwnerStateEnvelope.bound(
                ownerScope: owner,
                sourceManifest: "sha256:legacy-source",
                userStoreGeneration: generation
            )
            let storage = PersistenceBootstrapEnvelopeStorage(data: try bound.encoded())
            let legacyDefaults = PersistenceBootstrapLegacyDefaults(ownerScope: owner)
            let transition = LegacyOwnerStateTransitionPrimitive(
                envelopeStorage: storage,
                legacyDefaults: legacyDefaults,
                faultInjector: PersistenceBootstrapLegacyTransitionFault(point: point)
            )

            do {
                _ = try await transition.retire(
                    authenticatedOwnerScope: owner,
                    noReimportSourceManifest: "sha256:no-reimport",
                    userStoreGeneration: generation
                )
                XCTFail("The simulated termination must interrupt advisory cleanup")
            } catch PersistenceBootstrapEnvelopeFault.Injected.termination {
                // Expected.
            }

            let storedDurableBytes = await storage.read()
            let durableBytes = try XCTUnwrap(storedDurableBytes)
            XCTAssertEqual(
                try LegacyOwnerStateResolver.resolve(
                    envelopeData: durableBytes,
                    legacyDefaultsOwnerScope: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff"
                ),
                .retired(ownerHash: bound.ownerHash)
            )
        }
    }

    func testMissingKeychainOwnerWithLegacyUnownedRowsBlocksAndPreservesBytes() async throws {
        let storage = PersistenceBootstrapEnvelopeStorage()
        let migrator = PersistenceBootstrapLegacyMigrator()
        let primitive = LegacyOwnerBootstrapPrimitive(
            authenticatedOwnerProvider: PersistenceBootstrapOwnerProvider(ownerScope: nil),
            legacyDefaults: PersistenceBootstrapLegacyDefaults(
                ownerScope: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
            ),
            envelopeStorage: storage,
            migrator: migrator
        )

        do {
            _ = try await primitive.scopeAndMigrateIfAuthorized(
                hasLegacyUnownedRows: true,
                sourceManifest: "sha256:legacy-source",
                userStoreGeneration: UUID(),
                durableEnvelopeRequired: false
            )
            XCTFail("Missing authenticated-owner evidence must block legacy migration")
        } catch PersistenceOwnershipError.unresolvedLegacyOwner {
            // Expected.
        }

        let migratedOwnerScopes = await migrator.migratedOwnerScopes()
        let storedEnvelopeData = await storage.read()
        XCTAssertEqual(migratedOwnerScopes, [])
        XCTAssertNil(storedEnvelopeData)
    }

    func testKeychainOwnerMismatchWithLegacyMarkerBlocksAndPreservesBytes() async throws {
        let storage = PersistenceBootstrapEnvelopeStorage()
        let migrator = PersistenceBootstrapLegacyMigrator()
        let primitive = LegacyOwnerBootstrapPrimitive(
            authenticatedOwnerProvider: PersistenceBootstrapOwnerProvider(
                ownerScope: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
            ),
            legacyDefaults: PersistenceBootstrapLegacyDefaults(
                ownerScope: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff"
            ),
            envelopeStorage: storage,
            migrator: migrator
        )

        do {
            _ = try await primitive.scopeAndMigrateIfAuthorized(
                hasLegacyUnownedRows: true,
                sourceManifest: "sha256:legacy-source",
                userStoreGeneration: UUID(),
                durableEnvelopeRequired: false
            )
            XCTFail("Mismatched owner evidence must block legacy migration")
        } catch PersistenceOwnershipError.ownershipMismatch {
            // Expected.
        }

        let migratedOwnerScopes = await migrator.migratedOwnerScopes()
        let storedEnvelopeData = await storage.read()
        XCTAssertEqual(migratedOwnerScopes, [])
        XCTAssertNil(storedEnvelopeData)
    }

    func testCorruptKeychainOrLegacyOwnerEvidenceBlocksWithoutOpeningOrMutatingUserStore() async throws {
        let owner = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        for corruptSource in PersistenceBootstrapCorruptEvidenceSource.allCases {
            let storage = PersistenceBootstrapEnvelopeStorage()
            let migrator = PersistenceBootstrapLegacyMigrator()
            let primitive = LegacyOwnerBootstrapPrimitive(
                authenticatedOwnerProvider: PersistenceBootstrapOwnerProvider(
                    ownerScope: owner,
                    error: corruptSource == .keychain ? .corruptEnvelope : nil
                ),
                legacyDefaults: PersistenceBootstrapLegacyDefaults(
                    ownerScope: owner,
                    error: corruptSource == .legacyMarker ? .corruptEnvelope : nil
                ),
                envelopeStorage: storage,
                migrator: migrator
            )

            do {
                _ = try await primitive.scopeAndMigrateIfAuthorized(
                    hasLegacyUnownedRows: true,
                    sourceManifest: "sha256:legacy-source",
                    userStoreGeneration: UUID(),
                    durableEnvelopeRequired: false
                )
                XCTFail("Corrupt \(corruptSource) evidence must block before migration")
            } catch PersistenceRecoveryPrimitiveError.corruptEnvelope {
                // Expected.
            }

            let migratedOwnerScopes = await migrator.migratedOwnerScopes()
            let storedEnvelopeData = await storage.read()
            XCTAssertEqual(migratedOwnerScopes, [])
            XCTAssertNil(storedEnvelopeData)
        }
    }

    func testDurableEnvelopeRequiredCorruptStateBlocksEvenWithoutLegacyRows() async throws {
        let owner = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        let corruptBytes = Data("{\"truncated\":".utf8)
        let storage = PersistenceBootstrapEnvelopeStorage(data: corruptBytes)
        let migrator = PersistenceBootstrapLegacyMigrator()
        let primitive = LegacyOwnerBootstrapPrimitive(
            authenticatedOwnerProvider: PersistenceBootstrapOwnerProvider(ownerScope: owner),
            legacyDefaults: PersistenceBootstrapLegacyDefaults(ownerScope: owner),
            envelopeStorage: storage,
            migrator: migrator
        )

        do {
            _ = try await primitive.scopeAndMigrateIfAuthorized(
                hasLegacyUnownedRows: false,
                sourceManifest: "sha256:legacy-source",
                userStoreGeneration: UUID(),
                durableEnvelopeRequired: true
            )
            XCTFail("A required corrupt durable owner envelope must block before no-migration")
        } catch PersistenceRecoveryPrimitiveError.corruptEnvelope {
            // Expected.
        }

        let preservedBytes = await storage.read()
        let migratedOwnerScopes = await migrator.migratedOwnerScopes()
        XCTAssertEqual(preservedBytes, corruptBytes)
        XCTAssertTrue(migratedOwnerScopes.isEmpty)
    }

    func testDurableEnvelopeRequiredStaleStateBlocksEvenWithoutLegacyRows() async throws {
        let owner = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        let sourceManifest = "sha256:legacy-source"
        let generation = UUID()
        let staleEnvelopes = [
            try LegacyOwnerStateEnvelope.bound(
                ownerScope: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
                sourceManifest: sourceManifest,
                userStoreGeneration: generation
            ),
            try LegacyOwnerStateEnvelope.bound(
                ownerScope: owner,
                sourceManifest: "sha256:stale-source",
                userStoreGeneration: generation
            ),
            try LegacyOwnerStateEnvelope.bound(
                ownerScope: owner,
                sourceManifest: sourceManifest,
                userStoreGeneration: UUID()
            ),
        ]

        for staleEnvelope in staleEnvelopes {
            let staleBytes = try staleEnvelope.encoded()
            let storage = PersistenceBootstrapEnvelopeStorage(data: staleBytes)
            let migrator = PersistenceBootstrapLegacyMigrator()
            let primitive = LegacyOwnerBootstrapPrimitive(
                authenticatedOwnerProvider: PersistenceBootstrapOwnerProvider(ownerScope: owner),
                legacyDefaults: PersistenceBootstrapLegacyDefaults(ownerScope: owner),
                envelopeStorage: storage,
                migrator: migrator
            )

            do {
                _ = try await primitive.scopeAndMigrateIfAuthorized(
                    hasLegacyUnownedRows: false,
                    sourceManifest: sourceManifest,
                    userStoreGeneration: generation,
                    durableEnvelopeRequired: true
                )
                XCTFail("A stale required durable owner envelope must block")
            } catch PersistenceOwnershipError.ownershipMismatch {
                // Expected for the wrong recorded owner.
            } catch PersistenceRecoveryPrimitiveError.corruptEnvelope {
                // Expected for stale manifest or store generation.
            }

            let preservedBytes = await storage.read()
            let migratedOwnerScopes = await migrator.migratedOwnerScopes()
            XCTAssertEqual(preservedBytes, staleBytes)
            XCTAssertTrue(migratedOwnerScopes.isEmpty)
        }
    }

    func testAccountBCannotExportResetOrFreshStartAccountARecords() {
        let capabilities = PersistenceRecoveryCapabilityPolicy.allowedCapabilities(
            for: .mismatchedOwner
        )

        XCTAssertEqual(
            capabilities,
            [.retry, .redactedManifest, .reauthenticateRecordedOwner]
        )
        XCTAssertFalse(capabilities.contains(.ownerFilteredRawExport))
        XCTAssertFalse(capabilities.contains(.confirmedFreshStart))
        XCTAssertFalse(capabilities.contains(.deleteRecoveryMaterial))
    }

    func testMissingOrCorruptRecordOwnerOffersOnlyManifestRetryAndReauthentication() {
        let expected: Set<PersistenceRecoveryCapability> = [
            .retry,
            .redactedManifest,
            .reauthenticateRecordedOwner,
        ]

        XCTAssertEqual(
            PersistenceRecoveryCapabilityPolicy.allowedCapabilities(for: .missingOwner),
            expected
        )
        XCTAssertEqual(
            PersistenceRecoveryCapabilityPolicy.allowedCapabilities(for: .corruptOwner),
            expected
        )
    }
}

private extension ConfirmedFreshStartDescriptor {
    static func fixture(
        ownerScope: String,
        userStoreGeneration: UUID = UUID()
    ) -> Self {
        .init(
            journalID: UUID(),
            authenticatedOwnerScope: ownerScope,
            userStoreGeneration: userStoreGeneration,
            cacheStoreGeneration: UUID(),
            sourceManifests: ["user-manifest", "cache-manifest"],
            confirmationNonceHashes: ["first-confirmation", "second-confirmation"]
        )
    }
}

private actor PersistenceBootstrapEnvelopeStorage: RecoveryEnvelopePersisting {
    private var data: Data?

    init(data: Data? = nil) {
        self.data = data
    }

    func read() -> Data? { data }
    func replace(with data: Data) { self.data = data }
}

private struct PersistenceBootstrapEnvelopeFault: DurableEnvelopeFaultInjecting {
    enum Injected: Error { case termination }
    let step: DurableEnvelopeWriteStep

    func reached(_ step: DurableEnvelopeWriteStep) throws {
        if self.step == step { throw Injected.termination }
    }
}

private struct PersistenceBootstrapEnvelopeBoundaryFault: DurableEnvelopeFaultInjecting {
    let step: DurableEnvelopeWriteStep
    let timing: DurableEnvelopeFaultTiming

    func reached(
        _ step: DurableEnvelopeWriteStep,
        timing: DurableEnvelopeFaultTiming
    ) throws {
        if self.step == step, self.timing == timing {
            throw PersistenceBootstrapEnvelopeFault.Injected.termination
        }
    }
}

private struct PersistenceBootstrapLegacyTransitionFault: LegacyOwnerTransitionFaultInjecting {
    let point: LegacyOwnerAdvisoryCleanupFaultPoint

    func reached(_ point: LegacyOwnerAdvisoryCleanupFaultPoint) throws {
        if self.point == point {
            throw PersistenceBootstrapEnvelopeFault.Injected.termination
        }
    }
}

private enum PersistenceBootstrapCorruptEvidenceSource: CaseIterable {
    case keychain
    case legacyMarker
}

private actor PersistenceBootstrapOwnerProvider: AuthenticatedOwnerProviding {
    private let ownerScope: String?
    private let error: PersistenceRecoveryPrimitiveError?

    init(ownerScope: String?, error: PersistenceRecoveryPrimitiveError? = nil) {
        self.ownerScope = ownerScope
        self.error = error
    }

    func authenticatedOwnerScope() throws -> String? {
        if let error { throw error }
        return ownerScope
    }
}

private actor PersistenceBootstrapLegacyDefaults: LegacyOwnerDefaultsAdvising {
    private var storedOwnerScope: String?
    private let error: PersistenceRecoveryPrimitiveError?

    init(ownerScope: String?, error: PersistenceRecoveryPrimitiveError? = nil) {
        storedOwnerScope = ownerScope
        self.error = error
    }

    func ownerScope() throws -> String? {
        if let error { throw error }
        return storedOwnerScope
    }

    func removeOwnerScope() {
        storedOwnerScope = nil
    }

    func currentOwnerScope() -> String? { storedOwnerScope }
}

private actor PersistenceBootstrapLegacyMigrator: LegacyOwnerRowMigrating {
    private var scopes: [String] = []

    func scopeAndMigrateLegacyRows(ownerScope: String) {
        scopes.append(ownerScope)
    }

    func migratedOwnerScopes() -> [String] { scopes }
}

private actor PersistenceBootstrapCredentialStore: CredentialStoring {
    private var storedSession: UserSession?

    init(session: UserSession?) {
        storedSession = session
    }

    func save(session: UserSession) throws { storedSession = session }

    func replace(session: UserSession, expectedSessionID: UUID) throws -> Bool {
        guard storedSession?.sessionId == expectedSessionID else { return false }
        storedSession = session
        return true
    }

    func session() throws -> UserSession? { storedSession }

    func clear(expectedSessionID: UUID) throws -> Bool {
        guard storedSession?.sessionId == expectedSessionID else { return false }
        storedSession = nil
        return true
    }
}
