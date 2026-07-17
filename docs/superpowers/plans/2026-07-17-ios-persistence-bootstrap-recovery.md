# iOS SwiftData Bootstrap Recovery Implementation Plan

> **Execution discipline:** Implement task-by-task with test-driven development, systematic debugging, verification before completion, and a fresh independent review after every numbered task. Do not commit until the parent branch reaches its aggregate release gate.

**Goal:** Replace the pre-UI SwiftData `fatalError` path with a production-safe bootstrap and recovery experience that never silently discards drafts or queued mutations, safely rebuilds disposable caches, preserves account isolation and Keychain state, and remains fully usable in Simplified Chinese, Japanese, and English on iOS 26.

**Architecture:** Production persistence is split into an owner-scoped user-data store (`StoredOperation`, `LocalEventDraft`, `PersistenceMetadata`) and a disposable cache store (`CachedEvent`, `StoredCursor`, `StoredSyncEntity`, `CachePersistenceMetadata`). A lightweight `@MainActor` coordinator publishes a single-flight `loading -> ready(runtime)` / `blocked(issue)` state machine, while a dedicated bootstrap actor performs container opening, hashing, file copies, migration, and confirmed-fresh-start recovery off the main actor and returns only Sendable results. The actor receives an injected, read-only `AuthenticatedOwnerProviding` adapter that reads only the authenticated user ID from the existing Keychain session; it never exposes tokens or constructs the API, SyncEngine, analytics, or AppModel. Existing installs are snapshotted twice—one manifest-addressed, immutable verified recovery snapshot and one openable working copy—before retryable legacy migration. Completion journals bind the canonical source manifest to the destination user-store generation; cache metadata durably binds a cache generation to its paired user-store generation. A checksummed durable legacy-owner-state file replaces `UserDefaults` as the post-migration authority. Cache-only failures may rebuild after verified quarantine; user-store, ownership, downgrade, disk, permission, and unknown failures block normal startup and expose only the actions permitted by the ownership capability matrix. The normal `AppModel`, API, SyncEngine, analytics, and app bootstrap are created exactly once only after durable persistence is ready.

**Non-negotiable constraints:**

- Never fall back to an in-memory store in production and then allow the user to create data.
- Never delete or rewrite `StoredOperation` or `LocalEventDraft` during ordinary sign-out, session expiry, token refresh failure, or account A -> B -> A transition. These transitions cancel/flush the active sync scope and clear only in-memory presentation state; the persisted owner rows remain byte-for-byte intact.
- Destructive user-data deletion exists only inside the double-confirmed fresh-start flow after fresh reauthentication as the recorded owner. It is never reachable from ordinary authentication lifecycle callbacks.
- Never automatically delete `StoredOperation`, `LocalEventDraft`, the legacy store, immutable recovery material, or Keychain credentials.
- Never print or place tokens, decoded payload contents, phone numbers, absolute sandbox paths, or raw backend diagnostics in logs or the normal redacted support bundle. The separately disclosed raw-recovery-backup capability may copy the proven owner's raw payload byte fields into a newly created owner-filtered archive after fresh proof; it never exports an original/immutable SQLite family with unknown free pages or WAL history, and the app never decodes or previews payloads during export.
- Cache rebuild must not touch the user store. A user-store failure must never be classified as cache-only.
- Copy the complete existing SQLite family (`store`, `-wal`, `-shm`, and `-journal` when present) before migration, quarantine, or reset. Verify every copied member before destructive work and durably flush files plus parent directories.
- Never open the only verified recovery snapshot. Open a separate working copy; a working-copy mutation or corruption cannot change recovery bytes.
- A legacy completion journal is written only after the new user store reopens and every persisted field, owner scope, identity, count, and uniqueness constraint matches a canonical semantic digest. It binds the source manifest/fingerprint to the destination `storeGeneration`; a corrupt journal is never treated as absent.
- `StoredSyncEntity` and `StoredCursor` remain in the same cache container and the same `ModelContext.save()` transaction.
- Every draft and queued operation has an explicit owner scope supplied by the authenticated caller. Missing, corrupt, legacy-unresolved, or mismatched ownership is blocked/quarantined without deletion, push, or cross-account presentation.
- The cross-store destructive journal is exclusive to double-confirmed fresh start. It is restart-safe and idempotent across the user store, cache store, durable legacy-owner-state file, and no-reimport tombstone; another account cannot bootstrap over an unfinished or failed fresh start.
- Preserve `PersistenceStore.init(container:)` and `makeInMemory()` as test-only-compatible call surfaces. Production must not call `makeInMemory()`.
- Preserve current sync validation, version monotonicity, tombstones, cursor semantics, and Keychain behavior. Replace the current `AppModel.signOut()` / session-expiry / account-change calls into `resetSensitiveScope` and the unowned/orphan queue deletion path with a non-destructive scope-deactivation/activation protocol plus explicit blocked quarantine; do not preserve destructive orphan cleanup.
- Recovery UI follows system light/dark appearance, Dynamic Type, VoiceOver, Reduce Motion, and iOS 26 native Liquid Glass. It must not require `AppModel`.
- Active stores use the minimum file protection compatible with background sync (`completeUntilFirstUserAuthentication` where required). Immutable snapshots, openable migration/validation working copies, raw quarantine, and export temporary files use `.complete`, are excluded from device backup, and have capacity preflight plus a shared total quota. Working copies and completed share-session temporaries have deterministic cleanup; immutable snapshots and raw quarantine/recovery backups are retained until the recorded owner explicitly confirms deletion in a separate action—age, quota pressure, logout, or account switching never authorizes their removal. Every working-copy handle must close before its complete SQLite family is deterministically removed; a retry recreates it only after re-verifying the immutable snapshot manifest.
- Debug fault injection is compiled only in DEBUG and accepts only documented launch arguments plus a fixed fixture-root identifier under a dedicated UI-test persistence root. It must never fill the developer machine disk or corrupt a normal app container.
- Downgrade is explicitly unsupported for migrated stores: a changed legacy source fingerprint after completion blocks and requires reconcile/export rather than silently ignoring new old-version writes.
- Ownership capability is deny-by-default: when record ownership is missing, corrupt, unresolved, or mismatched, the only available actions are retry, a payload-free redacted manifest, and reauthentication as the recorded owner. Account B cannot export raw bytes, fresh-start, reset, reassign, or delete account A data.

## Strict file scope

### Create

- `Spott/Core/Persistence/PersistenceSchemas.swift`
- `Spott/Core/Persistence/PersistenceBootstrap.swift`
- `Spott/Core/Persistence/PersistenceRecoverySupport.swift`
- `Spott/Features/Recovery/PersistenceRecoveryView.swift`
- `SpottTests/PersistenceBootstrapTests.swift`

### Modify

- `Spott/Core/Persistence/PersistenceStore.swift`
- `Spott/Core/Persistence/Models.swift`
- `Spott/Core/Sync/SyncEngine.swift`
- `Spott/App/AppModel.swift`
- `Spott/SpottApp.swift`
- `SpottTests/PersistenceStoreSyncTests.swift`
- `SpottTests/SessionIsolationTests.swift`
- `SpottTests/LocalizationParityTests.swift`
- `SpottUITests/SpottUITests.swift`
- `Spott/Resources/zh-Hans.lproj/CoreJourney.strings`
- `Spott/Resources/ja.lproj/CoreJourney.strings`
- `Spott/Resources/en.lproj/CoreJourney.strings`

The Xcode project uses filesystem-synchronized groups; do not hand-edit `project.pbxproj` unless a build proves that a target membership is actually missing.

---

## Task 0: Make ownership explicit before any store split or migration

- [ ] **Write ownership, authentication-transition, and owner-state RED tests**

Add tests proving:

1. `testMissingOwnerScopeLeavesQueueBytesUnchangedAndBlocksPush`
2. `testAccountADraftAndOperationAreNeverVisibleOrPushableForAccountB`
3. `testSignOutDeactivatesScopeWithoutDeletingOrRewritingOwnerRows`
4. `testSessionExpiryDeactivatesScopeWithoutDeletingOrRewritingOwnerRows`
5. `testAccountASignOutThenBThenAReturnPreservesAQueueAndDraftDigestAndBytesExactly`
6. `testAppModelSignOutAndExpirationNeverInvokeDestructivePersistenceReset`
7. `testEveryConfirmedFreshStartJournalPhaseRecoversAfterSimulatedTermination`
8. `testFailedFreshStartBlocksImmediateDifferentAccountBootstrapInSameProcess`
9. `testLegacyOwnerStateParticipatesInTheSameFreshStartJournal`
10. `testMatchingKeychainOwnerAndLegacyMarkerScopesRowsAndMigrates`
11. `testMissingKeychainOwnerWithLegacyUnownedRowsBlocksAndPreservesBytes`
12. `testKeychainOwnerMismatchWithLegacyMarkerBlocksAndPreservesBytes`
13. `testCorruptKeychainOrLegacyOwnerEvidenceBlocksWithoutOpeningOrMutatingUserStore`
14. `testCorruptFreshStartJournalBlocksAllAccountBootstrapAndPreservesBytes`
15. `testTruncatedFreshStartJournalBlocksAllAccountBootstrapAndPreservesBytes`
16. `testAccountBCannotExportResetOrFreshStartAccountARecords`
17. `testMissingOrCorruptRecordOwnerOffersOnlyManifestRetryAndReauthentication`
18. `testInFlightPushCannotMarkAppliedAfterScopeDeactivationBegins`

For the A -> sign-out -> B -> A test, capture both (a) the versioned canonical aggregate digest and (b) every exact stored byte column for A's `StoredOperation` and `LocalEventDraft` rows before the transition. Run the actual `AppModel` sign-out, B authentication/bootstrap, B sign-out, and A authentication/bootstrap path with a deterministic transport that produces no legitimate A acknowledgement, then compare both captures exactly before A's owner-authorized sync is released. The spy persistence layer must also assert zero insert/update/delete calls against A rows throughout the two transitions; comparing only decoded values is insufficient.

- [ ] **Add owner-scoped models and protocol boundaries**

Add a durable `ownerScope` to `StoredOperation` and `LocalEventDraft`. Add `PersistenceMetadata` to the user schema with a random `storeGeneration`, schema version, and optional legacy source identifier. Define `AuthenticatedOwnerProviding` as an injected actor protocol with `func authenticatedOwnerScope() async throws -> String?`. Implement a read-only Keychain adapter over the existing `CredentialStoring` session reader; normalize and return only `session.user.id`, never tokens or the full session. Construct that adapter before persistence bootstrap, but do not construct the API, SyncEngine, analytics, or AppModel until persistence is ready.

The authenticated owner scope is passed explicitly into persistence calls; it is never inferred from a filesystem path, global `UserDefaults`, payload content, or the legacy marker alone. Migration may scope legacy-unowned rows only when the read-only Keychain owner is valid and exactly matches the valid legacy owner marker. Missing/corrupt Keychain evidence, a missing/corrupt marker when legacy-unowned rows exist, or a mismatch blocks before the destination user store is opened or mutated and leaves every source byte unchanged.

Change `SyncPersisting` and its callers to explicit scoped APIs such as `allOperations(ownerScope:)` for migration/verification, `pendingOperations(ownerScope:)` for push (whose predicate must also require `state == "pending"`), and scoped draft reads/writes. A missing, corrupt, unresolved-legacy, or mismatched owner returns a blocked/quarantined result. It must not delete, push, render, reassign, or silently adopt a row.

- [ ] **Replace destructive authentication resets with scope deactivation**

Change `SyncLifecycleManaging` so ordinary authentication lifecycle uses `deactivateScope(reason:generation:)`. Add one process-scoped `OwnerWriteLeaseAuthority`: a small lock-protected, monotonic Sendable authority shared by `AppModel`, `SyncEngine`, and `PersistenceStore`. `AppModel.beginAuthTransition()` synchronously revokes the active lease before changing `session`, returning to the run loop, or spawning any remote sign-out task; it does not wait for actor scheduling. Deactivation then cancels/coalesces in-flight pull and push work, clears in-memory hints, waits for cancelled work to quiesce, and releases owner-bound presentation/cache handles without writing or deleting user-store rows. Every persistence mutation/mark-applied call carries and revalidates that owner/generation lease inside the persistence actor immediately before save; work that raced with revocation rolls back. `bootstrap(userID:generation:)` activates the requested owner by scoped queries only and issues a new lease only after ownership validation; an account change must not call persistence reset or mutate the previous owner's rows.

Modify the current executable call paths in `Spott/App/AppModel.swift`:

- `signOut()` synchronously revokes the lease, then calls `deactivateScope(.signOut, generation:)` before awaiting/best-efforting the remote `sessionEnder`; it never calls `resetSensitiveScope`;
- `handleSessionExpiration(expectedSessionID:)` calls the same non-destructive deactivation and never retries a destructive store operation;
- `didAuthenticate(_:)` deactivates an existing different owner before activating the new owner, and a failed deactivation blocks the new sync runtime rather than deleting/adopting rows;
- router/discovery presentation clearing remains in-memory-only and cannot be used as evidence that persisted data was cleared.

Remove the ordinary `SensitiveResetReason`/`resetSensitiveScope` deletion route. The persistence deletion entry point accepts only an unforgeable `ConfirmedFreshStartRequest` issued by the recovery coordinator after recorded-owner proof and two confirmations. Unit spies in `SessionIsolationTests` must fail if sign-out, expiration, token failure, or A -> B invokes that entry point.

- [ ] **Make legacy owner evidence durably one-way**

Treat `jp.spott.sync.owner-user-id` in `UserDefaults` as read-only legacy input, not a durable state machine. Before importing or changing any legacy evidence, write a versioned, checksummed `legacy-owner-state` envelope in the persistence root. Its states are `bound(ownerHash, sourceManifest, userStoreGeneration)` and terminal `retired(ownerHash, noReimportSourceManifest, userStoreGeneration)`. The terminal state/no-reimport tombstone, never `UserDefaults` absence, is authoritative after migration or fresh start.

Each transition uses a same-directory uniquely named temporary created with exclusive-create semantics, writes the complete canonical envelope, flushes the file, performs same-volume atomic rename/replace, then flushes the containing directory. Only after the durable terminal envelope is observable may the implementation best-effort remove the old `UserDefaults` key; a crash that leaves or resurrects that key cannot override the durable envelope. A missing/corrupt/unsupported envelope when a migration/fresh-start journal says it must exist blocks; it is never regenerated from a convenient current login.

Use an injected legacy-defaults adapter and filesystem fault boundary to terminate before/after every temporary write, file flush, rename, directory flush, and advisory `UserDefaults` removal. On recovery, exactly one old or new valid state must win; a temp/final ambiguity, checksum mismatch, or missing terminal tombstone blocks with zero store writes. Add `testLegacyOwnerStateSurvivesEveryRenameFsyncAndDefaultsRemovalCrashPoint` and `testDurableTerminalTombstoneIgnoresResurrectedLegacyUserDefaultsValue`.

- [ ] **Define the restart-safe confirmed-fresh-start journal primitive**

The destructive journal envelope records a format version, random journal ID, monotonically increasing phase sequence, freshly reauthenticated hashed record-owner scope, user/cache store generations, source manifests, enum phase, confirmation nonce hashes, and a SHA-256 checksum over the canonical envelope payload. Use the same exclusive temporary -> file flush -> atomic rename -> directory flush protocol before mutating the next participant. A malformed, unsupported-version, checksum-invalid, truncated, or ambiguous journal/temp state blocks all account bootstrap and is never treated as journal absence. Task 0 implements and fault-tests the journal transition primitive with non-destructive fakes; Task 5 is the only task allowed to wire it to real deletion. Recovery completes or blocks the same confirmed fresh start before any account runtime is constructed, including a different account attempted in the same process.

- [ ] **Run GREEN and independent data-isolation review**

Run all sync/persistence/session-isolation tests. Reviewer must reject automatic orphan deletion, logout/expiry/account-switch persistence mutation, owner adoption, a process-global owner guess, a journal phase that can be skipped, reliance on `UserDefaults` deletion for durability, and any Keychain mutation.

---

## Task 1: Lock the error contract, schemas, and filesystem boundary

- [ ] **Write RED tests**

Add `PersistenceBootstrapTests` covering:

1. `testContainerOpenFailureReturnsBlockedStateInsteadOfTrapping`
2. `testFailureClassifierWalksUnderlyingErrorsAndRedactsDescriptions`
3. `testDiskFullAndReadOnlyFailureLeaveBothStoreFamiliesBytePreserved`
4. `testUserStoreCorruptionNeverBootsWithEphemeralPersistence`
5. `testCapacityAndPermissionTakePriorityOverCacheCorruptionForEitherStoreRole`
6. `testUnderlyingErrorCycleTerminatesWithoutDescriptionMatching`
7. `testMissingCacheMetadataBlocksBeforeRuntimeAndPreservesBothFamilies`
8. `testWrongCacheGenerationBlocksBeforeRuntimeAndPreservesBothFamilies`
9. `testStaleCacheUserGenerationBindingBlocksBeforeRuntimeAndPreservesBothFamilies`

Use injected container-open and filesystem protocols; tests must not attempt to catch a real `fatalError`.

- [ ] **Add explicit schemas and store layout**

Define versioned schemas and migration plans for:

- user store: owner-scoped `StoredOperation`, owner-scoped `LocalEventDraft`, `PersistenceMetadata`;
- cache store: `CachedEvent`, `StoredCursor`, `StoredSyncEntity`, `CachePersistenceMetadata`.

Define a single persistence root with stable `user.store`, `cache.store`, migration journal, confirmed-fresh-start journal, durable legacy-owner-state, diagnostics, immutable snapshots, working copies, exports, and quarantine paths. File names remain stable across schema versions; schema evolution belongs to `VersionedSchema`/`SchemaMigrationPlan`.

`CachePersistenceMetadata` is the durable source of truth for a random `cacheGeneration`, cache schema version, and `pairedUserStoreGeneration`; do not derive these values from filenames, `UserDefaults`, process memory, or a reset journal. On every normal bootstrap, reopen both stores and require exactly one metadata row in each, then require the cache row's paired generation to equal the reopened user metadata generation before constructing runtime. Missing, duplicate, wrong, or stale cache metadata/generation is an ownership/generation block with zero store writes. An explicit cache-repair flow may later create a new cache generation and binding only after verified cache quarantine; normal startup may not silently synthesize metadata.

Apply `completeUntilFirstUserAuthentication` only to active stores that must support background operation. Apply `.complete`, backup exclusion, free-space preflight, and bounded total quota to raw quarantine/snapshot/export material. Deterministically clean only closed working copies and completed share-session temporaries. Immutable snapshots and raw recovery/quarantine material require a separate recorded-owner confirmation before deletion.

- [ ] **Add safe failure classification**

Classify cache corruption/migration, user corruption/migration, ownership/generation mismatch, capacity, read-only/permission, downgrade/source drift, and unknown failures from the complete underlying-error chain with cycle detection. Every classifier input carries an explicit store role; capacity and permission conditions take priority over corruption for both roles. The public issue contains only a random incident ID, category, retryability, and localized-copy key. Redacted diagnostics may contain error domain/code, timestamp, app/OS version, available capacity, and basename/size only.

- [ ] **Run GREEN and independent review**

Reviewer must reject string matching on localized error descriptions, absolute paths, payload logging, and any production in-memory fallback.

---

## Task 2: Build the single-flight bootstrap and create runtime only after persistence

- [ ] **Write RED tests**

Add:

1. `testRetryIsSingleFlightAndDoesNotCreateAnAutomaticLaunchLoop`
2. `testAppRuntimeAndBootstrapAreCreatedExactlyOnceAfterStoresOpen`
3. `testBlockedBootstrapReadsOnlyOwnerScopeAndDoesNotConstructAPIAppModelSyncOrAnalytics`
4. `testQueuedDeepLinkIsDeliveredOnceAfterReady`
5. `testCancelledLaunchAttemptCannotPublishAStaleRuntime`
6. `testTwoScenesShareOneBootstrapAttemptAndOneRuntime`
7. `testQueuedURLsAreBoundedDeduplicatedAndOAuthIsNeverQueued`
8. `testPushTokenArrivingBeforeSubscriptionRegistersExactlyOnceAfterReady`
9. `testBlockedLaunchDoesNotConstructRecoveryAuthenticationTransportUntilUserRequestsIt`

- [ ] **Implement the coordinator and runtime factory**

Create a `@MainActor` observable coordinator with explicit `idle`, `loading`, `ready`, and `blocked` states. Launch performs one attempt; retry is user-driven and coalesces concurrent taps and scenes. The coordinator only owns task generation/cancellation and publishes Sendable state. A dedicated bootstrap actor performs filesystem work, container opening, snapshot hashing, migration, and confirmed-fresh-start journal recovery; its `ModelContext` and fetched models never cross actors. A ready result may carry the Sendable model containers and immutable metadata needed to construct the main-actor runtime.

Refactor `SpottApp` so its initializer creates only the process-scoped coordinator, read-only Keychain `AuthenticatedOwnerProviding` adapter, and a lazy recovery-reauthentication factory whose network transport is not constructed until the user explicitly chooses reauthentication. A lightweight root renders progress, recovery, or the fully injected app. Call `AppModel.bootstrap()` exactly once per ready runtime. Queue a bounded, deduplicated allow-list of non-OAuth URLs while blocked/loading and deliver each once after ready. OAuth callback URLs are never persisted or queued. Latch push-token updates that arrive before the view subscription and register the current token exactly once after ready.

- [ ] **Run GREEN and independent review**

Reviewer must verify no launch loop, stale cancelled publication, duplicate multi-scene bootstrap/task execution, lost early push token, queued OAuth secret, eager API/reauth transport during blocked launch, `fatalError` production path, or normal UI over ephemeral persistence.

---

## Task 3: Split persistence without changing sync correctness

- [ ] **Write RED tests**

Extend `PersistenceStoreSyncTests` with:

1. pending-operation and draft cold-start persistence in the user store;
2. cached event/entity/cursor cold-start persistence in the cache store;
3. entity plus cursor atomic rollback in the split cache store;
4. a compatibility test for `init(container:)` used by existing fixtures.
5. explicit owner-scoped queue/draft queries never return another owner's rows;
6. a user-container failure cannot be misreported as a disposable-cache failure;
7. every stored operation state survives a split-store cold start while only `pending` rows are returned to push;
8. cache metadata/generation is created once, reopened, and never synthesized over a missing/stale row;
9. account A -> sign-out -> B -> A through the real split containers leaves A row digests and exact payload/dependency bytes unchanged.

- [ ] **Route models to the correct containers**

Give `PersistenceStore` explicit `userContainer` and `cacheContainer` properties and store-role-specific contexts. Keep compatible convenience methods only where their ownership is unambiguous. Route owner-scoped queue/draft work and the user generation metadata to the user store; route cached event/sync work and the cache generation metadata to the cache store. Define `init(container:)` as a test-only compatibility initializer that intentionally maps the supplied in-memory container to both roles; production factories must use two distinct persistent containers. Do not change page validation, sequence/version rules, tombstone behavior, cursor ownership, or JSON encoding.

- [ ] **Remove ordinary destructive reset from the split-store contract**

Delete the current unscoped `resetSensitive()` implementation and remove it from `SyncPersisting`. Ordinary sign-out, session expiry, token failure, account merge/restriction events, and account switching call only the non-persisting `deactivateScope` lifecycle defined in Task 0. Owner-scoped rows remain available when that same owner returns; `pendingOperations(ownerScope:)` filters by both owner and pending state, while applied rows remain durable for migration/audit integrity and are never pushed.

Expose no general-purpose delete API. Reserve a package-internal `performConfirmedFreshStart(_ request: ConfirmedFreshStartRequest)` entry point whose request type cannot be initialized by `AppModel`, `SyncEngine`, or authentication code. Until Task 5 wires the verified snapshot, fresh owner proof, double-confirmation nonces, and journal, the entry point returns blocked and performs zero writes. Missing/mismatched ownership never invokes it. On cold start, an existing confirmed-fresh-start journal is recovered or blocked before any account runtime; the presence of that journal does not authorize a different owner to continue it.

- [ ] **Run GREEN and independent review**

Run all existing persistence and session-isolation tests. Reviewer must explicitly check blocked/quarantined orphan queues, non-destructive sign-out/expiry/A -> B -> A, confirmed-fresh-start journal isolation, pending-only push, applied-row retention, cursor atomicity, cache generation binding, and that Keychain is untouched.

---

## Task 4: Migrate the legacy default store without silent loss

- [ ] **Write RED tests**

Add:

1. `testLegacyMigrationCopiesAndVerifiesEveryPersistedFieldBeforeJournalCompletion`
2. `testLegacyMigrationWriteFailureKeepsLegacyDataAndMarkerAbsent`
3. `testLegacyMigrationCanRetryAfterInterruptionWithoutDuplicates`
4. `testLegacyCacheStartsFromCursorZeroAfterVerifiedUserMigration`
5. `testCompletedMarkerWithMissingDestinationBlocks`
6. `testCorruptMarkerNeverMeansAbsent`
7. `testFreshStartCrashCannotReimportLegacy`
8. `testWrongStoreGenerationBlocks`
9. `testTargetSemanticConflictBlocksInsteadOfOverwriting`
10. `testDuplicateIdentityOrMetadataDriftBlocksCompletion`
11. `testWorkingCopyCorruptionLeavesImmutableSnapshotVerifiable`
12. `testChangedLegacyFingerprintAfterDowngradeBlocksReconciliation`
13. `testCanonicalDigestRejectsEachStoredOperationFieldMutationIncludingState`
14. `testCanonicalDigestRejectsEachLocalEventDraftFieldMutation`
15. `testWorkingCopyUsesCompleteProtectionBackupExclusionQuotaAndClosesBeforeCleanup`
16. `testLegacyMigrationCopiesPendingAppliedAndEveryOtherStoredOperationState`
17. `testPushQueryReturnsOnlyPendingAfterAppliedOperationColdMigration`
18. `testImmutableSnapshotUsesManifestAddressedUniqueExclusivePathAndFinalizesReadOnly`
19. `testEveryWorkingCopyReverifiesImmutableManifestBeforeCreation`
20. `testDowngradeFixtureMigratesThenOldWriterChangesLegacyThenNextColdLaunchBlocks`
21. `testDowngradeSourceDriftPerformsZeroWritesAndAllowsOnlyOwnerSafeRecoveryCapabilities`
22. `testDowngradeOwnerSafeExportIncludesNewAppliedAndPendingRowsWithoutDestinationWrites`

- [ ] **Implement copy, import, verification, and journal order**

When a legacy store exists and no valid completed journal exists:

1. close all handles;
2. after capacity preflight against the shared quota, hash the closed full SQLite family and construct a canonical manifest containing only member roles, sizes, hashes, and a format version. Create a unique staging directory at `snapshots/<source-manifest-digest>/<random-snapshot-id>.building` with exclusive-create semantics; an existing path is never reused or overwritten;
3. copy every family member into the staging directory, apply `.complete` protection and backup exclusion, flush every file and the staging directory, and verify each copied size/hash against the closed source manifest. Write and flush the canonical manifest, atomically rename the directory to the same unique `.snapshot` path, flush both parent directories, remove write permission from the finalized directory and members, and re-read/re-hash the finalized snapshot. Only that fully finalized read-only path becomes immutable recovery evidence;
4. before **every** initial or retry working-copy creation, re-read and recompute every immutable snapshot member hash and require exact equality with its manifest. Then capacity-preflight and copy into a new exclusive unique working directory, apply `.complete`/backup exclusion, flush, and verify again. Any immutable mismatch or ambiguous staging/final path blocks; no working copy is created and no fallback to the live source is allowed;
5. open only the working copy with a compatibility schema;
6. resolve and validate owner scope, then import drafts and **all** `StoredOperation` rows with compare-or-insert semantics by stable identity, including `pending`, `applied`, conflict/failed, and any recognized legacy state. Migration never uses the push predicate. Unsupported/corrupt state blocks with source and snapshot preserved rather than silently omitting the row;
7. if a destination identity exists with a different semantic digest, stop blocked and never overwrite;
8. reopen the destination and verify owner, uniqueness, per-state counts, total count, and a canonical semantic digest over every field. Build each digest from a versioned, typed, length-prefixed row encoding; encode UUIDs as lowercase bytes, optionals with an explicit presence tag, integer/date values in a fixed-width representation, strings as length-prefixed UTF-8, payload as length-prefixed raw bytes, and dependency arrays in persisted order. Sort rows by stable identity before the aggregate digest. Operations include operation identity, owner scope, entity type/id, action, payload, base version, dependencies, **state**, attempts, and created time; drafts include local/server identity, owner scope, title, payload, revision, server version, and updated time. Table-driven tests must mutate each field independently and prove that every mutation—including only `StoredOperation.state`—blocks completion. Separately verify `pendingOperations(ownerScope:)` returns only migrated pending rows while all applied rows remain queryable through migration/audit APIs after another cold start;
9. read the destination `PersistenceMetadata.storeGeneration` and atomically write/flush a completion journal binding source manifest, legacy source ID, destination generation, and schema version;
10. create a fresh cache store at cursor zero with exactly one new `CachePersistenceMetadata` row bound to the reopened user-store generation, close/reopen it, and verify that binding before ready.

If a completion journal exists, inspect the source family and destination metadata through read-only handles first and require an existing destination with matching metadata/generation and the same source fingerprint. A missing store/metadata, corrupt journal, wrong generation, or changed source fingerprint after an old-version write is blocked—not treated as a fresh or completed migration. Drift detection performs zero writes to the source, immutable snapshot, user store, cache store, journals, or durable owner state.

The downgrade acceptance is a real three-stage disk fixture, not a mocked fingerprint comparison: (1) seed and migrate a complete frozen-legacy SQLite family through the current app until completion is durable; (2) terminate the app, reopen that same legacy family with the frozen old-schema fixture writer, append a valid new applied operation plus a valid pending operation, save/close/flush it; (3) cold-launch the current app and prove it detects source drift before any writable destination open. Capture full-family hashes at the end of stage 2 and require byte-for-byte equality after the blocked stage 3 launch. The blocked UI follows the ownership capability matrix: a payload-free manifest is available, but raw backup/fresh start is unavailable to B. After fresh proof of known recorded owner A, an explicit owner-safe export action may exclusively snapshot the changed legacy family, re-verify it, open only a working copy with the frozen compatibility schema, prove every exported row belongs to A, and build an owner-filtered backup; it never reconciles or writes the active source/destination/cache. If any row cannot be bound to A, raw export remains disabled.

Never delete the legacy source or immutable snapshot automatically. After every working-copy open attempt, close all compatibility-container and SQLite handles before deterministically removing the complete working-copy family; if cleanup fails, account the closed files against the shared quota and block rather than reopening or deleting protected recovery bytes. A retry re-verifies the immutable manifest and creates a new exclusive protected working copy from those verified bytes. If any step fails, keep source and immutable snapshots, omit completion, and return a retryable or blocked issue as appropriate. Import retry is idempotent and compare-only for existing identities. Even after successful migration, snapshot deletion is a separate recorded-owner action with an explicit retention explanation and confirmation; background aging or quota pressure may prompt but never perform deletion.

- [ ] **Run GREEN and independent review**

Reviewer must test interruption at every boundary and reject opening the immutable snapshot, a reusable/overwritable snapshot path, working-copy creation without a fresh immutable re-hash, partial-field hashes, pending-only migration, overwrite-on-conflict, a journal written before reopen verification/durability flush, or any stale/corrupt journal treated as absent.

---

## Task 5: Implement cache recovery, support export, and confirmed fresh start

- [ ] **Write RED tests**

Add:

1. `testCacheCorruptionRebuildsOnlyCacheAndKeepsDraftsAndPendingOperations`
2. `testSupportExportContainsRecoveryDataButNoCredentialsOrAbsolutePaths`
3. `testFreshStartRequiresConfirmationAndVerifiedQuarantine`
4. `testFailedQuarantineCopyLeavesOriginalStoreFamilyUntouched`
5. `testFreshStartJournalPersistsNewGenerationAndLegacyNoReimportTombstone`
6. `testRawBackupUsesCompleteProtectionBackupExclusionAndQuota`
7. `testOrphanExportCleanupNeverTouchesActiveOrImmutableRecoveryFiles`
8. `testOwnershipMismatchCapabilityMatrixDeniesAccountBRawExportAndFreshStartOfA`
9. `testMissingOrCorruptOwnerCapabilityMatrixAllowsOnlyRedactedManifestRetryAndReauthentication`
10. `testRawBackupRequiresFreshSingleUseProofMatchingEveryExportedRecordOwner`
11. `testOwnerFilteredRawBackupContainsNoOtherOwnersRows`
12. `testOpaqueMultiOwnerFamilyCannotBeRawExported`
13. `testFreshStartDeletesOnlyReauthenticatedOwnerAndPreservesOtherOwnerDigests`
14. `testRecoverySnapshotRetentionDeletionRequiresSeparateOwnerConfirmation`
15. `testOriginalAndImmutableSQLiteFamiliesAreNeverRawExportedEvenWithOwnerEvidence`
16. `testRecoveryReauthenticationUsesVolatileCredentialsAndNeverMutatesKeychain`
17. `testFreshStartIsDisabledWhenAnyRecordOwnerCannotBeEnumerated`

- [ ] **Implement failure-specific actions**

- Cache-only failure: immutable verified quarantine snapshot plus separate validation copy, then remove only the cache family and rebuild.
- User-store failure: block; permit retry and the payload-free redacted manifest. Raw recovery backup is offered only if the capability policy below independently authorizes it. Never auto-delete.
- Disk/read-only/permission failure: do not move/delete either family; tell the user to fix the condition and retry.
- Unknown failure: block with incident ID; do not guess.

Generate a normal redacted support manifest. A raw recovery backup is considered only after the capability policy below accepts fresh recorded-owner proof and the user separately accepts the privacy disclosure. Raw backup/export temporary files use `.complete`, backup exclusion, capacity preflight, an explicit total quota, and deterministic orphan cleanup after the share session; cleanup never includes active stores, immutable recovery snapshots, or retained quarantine archives.

Implement this deny-by-default recovery capability matrix in one policy type shared by coordinator tests and UI; do not infer UI capabilities ad hoc:

| Record-owner evidence | Current authentication | Allowed before new proof | After fresh proof | Explicitly denied |
| --- | --- | --- | --- | --- |
| Valid owner A | Signed out or authenticated B | Payload-free redacted manifest, retry, reauthenticate recorded owner | If the new single-use proof is A: owner-safe raw-backup candidate and A-only fresh-start candidate, each only after complete row/owner validation | B raw export, B reset/fresh start of A, reassignment, payload preview |
| Missing/unresolved | Any | Payload-free redacted manifest, retry, attempt recorded-owner reauthentication | Remains blocked unless durable evidence can bind every affected record to the newly proven owner | Raw backup, reset/fresh start, adoption, deletion |
| Corrupt/ambiguous | Any | Payload-free redacted manifest, retry, attempt recorded-owner reauthentication | Remains blocked until independently verified durable evidence removes the ambiguity | Raw backup, reset/fresh start, adoption, deletion |
| Valid owner A | Freshly reauthenticated A | Payload-free manifest and retry plus the proof-gated actions | Owner-safe raw backup and A-only double-confirmed fresh start after complete row/owner validation while proof is valid | Export/deletion of any B record |

`OwnerReauthenticationProviding` returns only a normalized owner scope plus issued/expiry times after a new interactive authentication challenge; the existing restored Keychain session is not fresh proof. It lazily constructs a narrowly scoped unauthenticated auth transport only after the user taps reauthenticate, uses an injected volatile in-memory credential sink rather than `CredentialVault`, converts the returned session to the proof inside the provider, and immediately discards access/refresh tokens. It never constructs `AppModel`, SyncEngine, analytics, or the normal authenticated API runtime and never reads/writes/clears Keychain. The proof is single-use, expires after a short documented interval, remains in memory only, and must exactly match the durable record-owner evidence. Issuing either a raw backup or a confirmed-fresh-start request consumes it; doing both requires two fresh challenges. The policy never reveals another owner's raw ID in recovery copy.

The normal support bundle contains only the redacted manifest and can never include payload bytes. A raw recovery backup is a distinct, prominently disclosed artifact that may contain opaque user content. Never share the active, legacy, quarantine, or immutable SQLite family directly: free pages, rollback journals, or WAL history could contain another owner's bytes even when current rows look single-owner. Instead, create a brand-new owner-filtered recovery store, copy only rows whose `ownerScope` exactly equals the freshly proven owner (preserving their raw payload `Data` without decoding), close/reopen it, and prove expected count/digest plus zero foreign-owner rows before sharing. Source-drift legacy export first uses a verified working copy and resolves every legacy row to the freshly proven owner under the migration evidence rules. If any source/working copy cannot be completely enumerated, any row owner is missing/corrupt/mismatched, or validation is incomplete, raw backup remains disabled. Never decode, preview, log, or copy payload bytes into the surrounding manifest/filename.

A fresh start requires fresh recorded-owner proof, complete enumeration of every current row owner, two distinct confirmations bound to single-use nonces, and a verified immutable full-family snapshot first. If a working copy cannot enumerate any row or bind it to an owner, fresh start stays disabled; the implementation never assumes the unreadable bytes belong to A. It runs through the restart-safe journal: record the source manifest and exact pre-action per-owner digests; build a replacement user store with a new generation that omits only the proven owner's queue/drafts while preserving every other owner's rows and exact semantic/opaque byte fields; bind a new cache generation; durably write a legacy-no-reimport tombstone for the proven owner/source/generation; reopen and validate the replacement plus all preserved-owner digests; and only then complete the journal. Account B can never issue or continue A's request. A crash at any phase resumes only with the journal's same proven owner or blocks without importing legacy data again. Fresh start does not clear Keychain.

Immutable recovery snapshots and raw quarantine archives have no unattended expiry deletion. After success, the UI may explain their size and offer a separate deletion action, but deletion requires a fresh matching-owner proof and explicit confirmation for the exact manifest IDs; quota pressure may block new artifacts but never evict recovery evidence. Only closed working copies and completed share-session temporaries are eligible for deterministic automatic cleanup.

- [ ] **Run GREEN and independent privacy review**

Reviewer must inspect exported bytes/filenames, logs, and accessibility copy and prove no token, payload, phone number, raw path, or server diagnostic appears in the normal support bundle. It must also prove B cannot export/reset A, a restored session is not accepted as fresh proof, every raw-backup record matches the newly proven owner, and retention cleanup cannot delete immutable recovery evidence without a separate owner confirmation.

---

## Task 6: Deliver the trilingual iOS 26 recovery experience

- [ ] **Write localization and UI RED tests**

Add parity keys and UI tests:

1. `testPersistenceRecoveryCopyIsLocalizedInEverySupportedLanguage`
2. `testPersistenceRecoveryRetriesWithoutCrashLoop`
3. `testCacheRecoveryPreservesSeededLocalDraft`
4. `testPersistenceRecoverySupportsLargestAccessibilityText`
5. `testPersistenceRecoveryRunsInZhHansJapaneseAndEnglishColdLaunches`
6. `testPersistenceRecoveryPassesAccessibilityAuditInLightAndDark`
7. `testSeededDraftSurvivesFaultRecoveryAndSecondRelaunch`
8. `testOwnershipMismatchRecoveryShowsOnlyManifestRetryAndReauthenticate`
9. `testFreshRecordedOwnerProofUnlocksRawBackupAndDoubleConfirmedFreshStart`

- [ ] **Implement the recovery view**

The view reads the existing `app.language` preference without AppModel. It includes:

- clear localized title, safe explanation, incident ID, and next step;
- primary retry action;
- secondary payload-free redacted-support manifest;
- context-specific cache repair action;
- recorded-owner reauthentication when the policy requires it;
- raw-backup and destructive fresh-start actions only when the Task 5 policy has accepted a fresh matching single-use proof;
- two distinct confirmations for fresh start and a separate privacy warning/confirmation before raw backup sharing.

For missing, corrupt, unresolved, or mismatched ownership, render exactly the capability matrix result: retry, redacted manifest, and reauthenticate recorded owner. Do not render disabled-but-discoverable raw export/reset controls, do not disclose the other owner's identifier, and do not let a UI route directly construct `ConfirmedFreshStartRequest`.

Use native SwiftUI controls and `GlassEffectContainer` / `.glassProminent` on iOS 26 with the existing fallback on older supported iOS. Preserve system light/dark appearance, 44-point targets, semantic fonts, largest accessibility sizes, VoiceOver heading/first focus, Reduce Motion, and single stable accessibility identifiers.

- [ ] **Run GREEN and independent UI/accessibility review**

Launch each of zh-Hans, Japanese, and English as a separate cold UI-test process. Exercise largest Dynamic Type, system light/dark, Reduce Motion, stable identifiers, first VoiceOver focus, and `performAccessibilityAudit`. Reject clipped actions, scroll traps, duplicate accessibility elements, untranslated diagnostics, low-contrast custom glass, or a test that merely checks in-memory state without proving the seeded draft after a second relaunch.

---

## Task 7: Real simulator fault injection and aggregate release gates

- [ ] **Add DEBUG-only deterministic injection**

Support only the following DEBUG launch contract against a dedicated fixture root identifier allow-list:

- `-SpottPersistenceFixtureRoot <fixed-test-id>`
- `-SpottPersistenceSeedOwner <fixture-owner-id>`
- `-SpottPersistenceSeedDraft <fixture-draft-id>`
- `-SpottPersistenceFault cache-corrupt|user-open-failure|capacity|read-only|cache-metadata-missing|cache-generation-stale|legacy-source-drift`
- `-SpottPersistencePhase seed|exercise|verify|downgrade-migrate|downgrade-old-write|downgrade-verify`

The seed/exercise/verify phases persist across real relaunches and never accept an arbitrary path. The downgrade phases operate only on a fixed allow-listed fixture: migrate the frozen real legacy SQLite family, terminate and use the frozen old-schema writer to add valid rows to that same legacy family, then cold-launch current bootstrap to verify the drift block and zero writes. Production builds contain no active fault switch or frozen writer. Never emulate disk full by filling the host disk; inject the typed capacity failure at the filesystem boundary.

- [ ] **Run focused signed tests**

```bash
xcodebuild test -quiet \
  -project Spott.xcodeproj -scheme Spott \
  -destination 'id=82BDA2F9-2D63-4AD1-8365-1463209BF9BF' \
  -derivedDataPath /private/tmp/spott-task19-focus-derived \
  -resultBundlePath /private/tmp/spott-task19-focus.xcresult \
  -only-testing:SpottTests/PersistenceBootstrapTests \
  -only-testing:SpottTests/PersistenceStoreSyncTests \
  -only-testing:SpottTests/SessionIsolationTests \
  -only-testing:SpottTests/LocalizationParityTests \
  -parallel-testing-enabled NO
```

- [ ] **Run complete signed unit and single-worker UI suites separately**

Do not disable code signing; Keychain session tests require entitlements. Reuse one derived-data directory where possible and set `-maximum-concurrent-test-simulator-destinations 1` for UI tests.

- [ ] **Perform real file-family acceptance**

On a dedicated fixture install, terminate the app, seed an owner-scoped draft plus pending and applied operations, corrupt only the test cache store, relaunch, verify recovery, terminate again, then run the verify phase and prove the same owner/semantic digest remains and the applied operation was neither omitted nor pushed. Repeat the blocked user-store, read-only, capacity, missing-cache-metadata, and stale-cache-generation cases through safe injection.

Run a real A -> sign-out -> B -> sign-out -> A sequence through `AppModel`, taking A's canonical digest and exact stored payload/dependency byte captures before and after; require equality and zero A-row mutations. Exercise simultaneous scene startup, launch-task cancellation, bounded deep-link replay, OAuth exclusion, and an early push-token event.

Run the three downgrade phases as separate processes. After `downgrade-old-write`, record every legacy/user/cache/journal/owner-state family hash; after `downgrade-verify`, require all hashes unchanged, a source-drift block, and the ownership-safe recovery actions only. Also fault every durable legacy-owner-state and confirmed-fresh-start envelope boundary (temporary write, file flush, rename, directory flush, terminal tombstone, advisory `UserDefaults` removal) across separate relaunches. Save xcresults, screenshots, the payload-free redacted support bundle, capability-policy decisions, and verification hashes under the quality-evidence directory.

- [ ] **Final independent review**

Completion requires no crash/launch loop, no silent loss, exact user/cache isolation, non-destructive sign-out/expiry/A -> B -> A evidence, all-state legacy operation migration with pending-only push, durable cache generation binding, real three-stage downgrade drift/zero-write evidence, owner-gated raw export/fresh start, retention confirmation, uninterrupted sync cursor atomicity, Keychain preservation, three-language parity, VoiceOver/Dynamic Type evidence, all iOS unit/UI tests green, and no Critical/Important review finding.

---

## Independent-review finding closure map

Implementation may start only after a fresh reviewer confirms that every row below is concrete and testable. A later implementation review must cite the named tests/evidence, not merely state that the design is safe.

| Review finding | Plan closure | Required evidence |
| --- | --- | --- |
| **Critical: ordinary logout/session expiry/A -> B deleted owner queue or drafts; current `AppModel` called destructive reset** | Task 0 adds `AppModel.swift` to strict scope, replaces both current calls with lease-revoking `deactivateScope`, makes account change non-destructive, and makes the destructive request type constructible only by recovery. Task 3 removes `resetSensitive()` from the ordinary sync contract. | Task 0 tests 3-6 and 18; Task 3 test 9; Task 7 real A -> B -> A digest plus exact-byte acceptance. |
| **Critical: legacy migration omitted applied operations** | Task 0 separates all-operation migration/audit reads from pending-only push reads. Task 4 imports/verifies every recognized `StoredOperation.state`, including applied, and counts/digests by state. | Task 4 tests 13, 16, and 17; Task 7 seeded applied-row relaunch proof and no-push assertion. |
| **Critical: mismatch/missing/corrupt ownership capabilities leaked export/reset; raw backup contradicted no-payload rule** | Task 5 centralizes the deny-by-default capability matrix. Before proof, only payload-free manifest/retry/recorded-owner reauthentication exist. B cannot export/reset A. Raw backup is explicitly separate from the normal bundle, requires fresh single-use matching proof through a volatile non-Keychain auth path, and is rebuilt into a new owner-filtered store; original/immutable families are never shared and unverifiable rows disable export/fresh start. | Task 0 tests 16-17; Task 5 tests 8-13 and 15-17; Task 6 UI tests 8-9 plus privacy review of actual bundle bytes. |
| **Important: cache generation/metadata had no durable source or stale-binding block** | Tasks 1 and 3 add exactly one `CachePersistenceMetadata` row as the durable source and bind it to the reopened user generation; normal bootstrap blocks on missing/duplicate/wrong/stale metadata without synthesis. | Task 1 tests 7-9; Task 3 test 8; Task 7 missing/stale metadata cold launches. |
| **Important: legacy `UserDefaults` marker lacked a crash-durable protocol/terminal tombstone** | Task 0 demotes `UserDefaults` to read-only legacy input, adds checksummed durable owner-state plus terminal tombstone, specifies exclusive temp/file flush/atomic rename/directory flush order, and makes defaults removal advisory only. | `testLegacyOwnerStateSurvivesEveryRenameFsyncAndDefaultsRemovalCrashPoint`, `testDurableTerminalTombstoneIgnoresResurrectedLegacyUserDefaultsValue`, and Task 7 separate-process fault matrix. |
| **Important: downgrade/source drift was not a true three-stage fixture** | Task 4 specifies a frozen real SQLite family, current migration completion, a post-termination frozen old-schema write, and a subsequent current cold launch that detects drift before writable destination open. | Task 4 tests 20-21; Task 7 three-process hashes proving the blocked launch made zero writes and exposed only owner-safe capabilities. |
| **Minor: immutable snapshots could be reused/overwritten/opened; working copies did not revalidate; retention was ambiguous** | Task 4 uses manifest-addressed unique exclusive staging/final paths, fsync plus read-only finalization, never opens the snapshot, and re-hashes it before every working copy. Tasks 4-5 require separate matching-owner confirmation to delete immutable/quarantine recovery evidence. | Task 4 tests 18-19 and interruption review; Task 5 test 14; Task 7 manifest/hash and retention-policy evidence. |
