"use client";

export type CoordinatedSessionVersion = {
  readonly sessionId: string;
  readonly refreshGeneration: number;
} & (
  | { readonly userId: string }
  | { readonly user: { readonly id: string } }
);

export interface CoordinationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type CoordinationMessageListener = (event: { readonly data: unknown }) => void;

export interface CoordinationChannel {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: CoordinationMessageListener): void;
  removeEventListener(type: "message", listener: CoordinationMessageListener): void;
  close?(): void;
}

export interface CoordinationLockManager {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export interface RefreshCoordinationOperations<T extends CoordinatedSessionVersion> {
  readonly synchronize: (signal: AbortSignal) => Promise<T | null>;
  readonly rotate: (signal: AbortSignal) => Promise<T | null>;
}

export interface SessionRefreshCoordinator {
  coordinateMutation<T>(
    operation: (signal: AbortSignal, ownsAuthority: () => boolean) => Promise<T>,
  ): Promise<T | null>;
  coordinateCommittedMutation<T>(
    operation: (
      signal: AbortSignal,
      ownsAuthority: () => boolean,
      stage: StageSessionMutationCommit,
    ) => Promise<CoordinatedSessionMutationCommit<T>>,
  ): Promise<T | null>;
  coordinateRefresh<T extends CoordinatedSessionVersion>(
    predecessor: CoordinatedSessionVersion,
    operations: RefreshCoordinationOperations<T>,
  ): Promise<T | null>;
}

const coordinatedCommitBrand: unique symbol = Symbol("spott-coordinated-session-commit");

export interface CoordinatedSessionMutationCommit<T> {
  readonly [coordinatedCommitBrand]: T;
}

export type StageSessionMutationCommit = <T>(
  finalize: (ownsAuthority: () => boolean) => T,
  rollback: () => void,
) => CoordinatedSessionMutationCommit<T>;

interface InternalSessionMutationCommit<T> extends CoordinatedSessionMutationCommit<T> {
  readonly finalize: (ownsAuthority: () => boolean) => T;
  readonly rollback: () => void;
  consumed: boolean;
}

export interface SessionRefreshCoordinatorDependencies {
  readonly ownerId?: string;
  readonly locks?: CoordinationLockManager | null;
  readonly storage?: CoordinationStorage | null;
  readonly channel?: CoordinationChannel | null;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly leaseDurationMilliseconds?: number;
  readonly leaseSettleMilliseconds?: number;
  readonly leasePollMilliseconds?: number;
  readonly coordinationTimeoutMilliseconds?: number;
}

export type CrossContextSessionMetadata =
  | { readonly state: "anonymous" }
  | {
      readonly state: "authenticated";
      readonly userId: string;
      readonly sessionId: string;
      readonly refreshGeneration: number;
    };

export interface CrossContextLoginSwitchResumeSnapshot {
  readonly challengeId: string;
  readonly raw: string;
  readonly createdAt: number;
}

export type CrossContextAnonymousTransition =
  | {
      readonly kind: "user_logout";
      readonly resumeSnapshots: readonly CrossContextLoginSwitchResumeSnapshot[];
    }
  | {
      readonly kind: "account_switch";
      readonly preservedSwitchChallengeId: string;
      readonly resumeSnapshots: readonly CrossContextLoginSwitchResumeSnapshot[];
    };

interface SessionMutationLease {
  readonly version: 1;
  readonly ownerId: string;
  readonly nonce: string;
  readonly expiresAt: number;
}

interface SessionMutationReleaseMessage {
  readonly version: 1;
  readonly kind: "session-mutation-release";
  readonly sourceId: string;
}

interface SessionStateMessage {
  readonly version: 1;
  readonly kind: "session-state";
  readonly sourceId: string;
  readonly metadata: CrossContextSessionMetadata;
  readonly anonymousTransition?: CrossContextAnonymousTransition;
  readonly updatedAt: number;
}

const channelName = "spott:web-session:v1";
const mutationLockName = "spott:web-session-mutation:v1";
const mutationLeaseKey = "spott.web.session-mutation-lease.v1";
const defaultLeaseDurationMilliseconds = 10_000;
const defaultLeaseSettleMilliseconds = 24;
const defaultLeasePollMilliseconds = 80;
const defaultCoordinationTimeoutMilliseconds = 20_000;
const canonicalIdentifierPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const maximumAnonymousTransitionSnapshots = 64;
const maximumResumeSnapshotRawLength = 4_096;

let sharedChannel: CoordinationChannel | null = null;
let sharedChannelConstructor: unknown = null;
let sharedSourceId: string | null = null;

function browserSourceId(): string {
  if (sharedSourceId !== null) return sharedSourceId;
  sharedSourceId = randomId();
  return sharedSourceId;
}

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function browserChannel(): CoordinationChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  if (sharedChannel !== null && sharedChannelConstructor === BroadcastChannel) return sharedChannel;
  sharedChannel?.close?.();
  sharedChannel = new BroadcastChannel(channelName) as CoordinationChannel;
  sharedChannelConstructor = BroadcastChannel;
  return sharedChannel;
}

function browserStorage(): CoordinationStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function browserLocks(): CoordinationLockManager | null {
  if (typeof navigator === "undefined" || !("locks" in navigator) || !navigator.locks) return null;
  return {
    request: <T>(name: string, callback: () => Promise<T>) =>
      navigator.locks.request(name, { mode: "exclusive" }, callback),
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function sameAuthority(
  candidate: CoordinatedSessionVersion,
  predecessor: CoordinatedSessionVersion,
): boolean {
  return candidate.sessionId === predecessor.sessionId
    && coordinatedUserId(candidate) === coordinatedUserId(predecessor);
}

function coordinatedUserId(session: CoordinatedSessionVersion): string {
  return "userId" in session ? session.userId : session.user.id;
}

async function resolveUnderExclusiveAuthority<T extends CoordinatedSessionVersion>(
  predecessor: CoordinatedSessionVersion,
  operations: RefreshCoordinationOperations<T>,
  ownsAuthority: () => boolean = () => true,
  signal: AbortSignal = new AbortController().signal,
): Promise<T | null> {
  if (!ownsAuthority()) return null;
  const synchronized = await operations.synchronize(signal);
  if (!ownsAuthority() || !synchronized || !sameAuthority(synchronized, predecessor)) return null;
  if (synchronized.refreshGeneration > predecessor.refreshGeneration) return synchronized;
  if (synchronized.refreshGeneration !== predecessor.refreshGeneration) return null;

  if (!ownsAuthority()) return null;
  const successor = await operations.rotate(signal);
  if (
    !ownsAuthority()
    || !successor
    || !sameAuthority(successor, predecessor)
    || successor.refreshGeneration !== predecessor.refreshGeneration + 1
  ) return null;
  return successor;
}

function parseLease(value: string | null): SessionMutationLease | null {
  if (value === null) return null;
  try {
    const lease = JSON.parse(value) as Partial<SessionMutationLease>;
    return lease.version === 1
      && typeof lease.ownerId === "string"
      && typeof lease.nonce === "string"
      && typeof lease.expiresAt === "number"
      && Number.isSafeInteger(lease.expiresAt)
      ? lease as SessionMutationLease
      : null;
  } catch {
    return null;
  }
}

function sameLeaseOwner(
  candidate: SessionMutationLease | null,
  owner: SessionMutationLease,
): boolean {
  return candidate !== null
    && candidate.version === owner.version
    && candidate.ownerId === owner.ownerId
    && candidate.nonce === owner.nonce;
}

function isMutationRelease(value: unknown): value is SessionMutationReleaseMessage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Partial<SessionMutationReleaseMessage>;
  return message.version === 1
    && message.kind === "session-mutation-release";
}

async function waitForLeaseProgress(
  channel: CoordinationChannel | null,
  wait: (milliseconds: number) => Promise<void>,
  pollMilliseconds: number,
): Promise<void> {
  if (!channel) {
    await wait(pollMilliseconds);
    return;
  }
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const listener: CoordinationMessageListener = (event) => {
    if (isMutationRelease(event.data)) release();
  };
  channel.addEventListener("message", listener);
  try {
    await Promise.race([released, wait(pollMilliseconds)]);
  } finally {
    channel.removeEventListener("message", listener);
  }
}

export function createSessionRefreshCoordinator(
  dependencies: SessionRefreshCoordinatorDependencies = {},
): SessionRefreshCoordinator {
  const ownerId = dependencies.ownerId ?? browserSourceId();
  const locks = dependencies.locks === undefined ? browserLocks() : dependencies.locks;
  const storage = dependencies.storage === undefined ? browserStorage() : dependencies.storage;
  const channel = dependencies.channel === undefined ? browserChannel() : dependencies.channel;
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.wait ?? delay;
  const leaseDuration = dependencies.leaseDurationMilliseconds
    ?? defaultLeaseDurationMilliseconds;
  const settle = dependencies.leaseSettleMilliseconds ?? defaultLeaseSettleMilliseconds;
  const poll = dependencies.leasePollMilliseconds ?? defaultLeasePollMilliseconds;
  const timeout = dependencies.coordinationTimeoutMilliseconds
    ?? defaultCoordinationTimeoutMilliseconds;

  async function coordinateExclusive<Prepared, Result>(
    operation: (signal: AbortSignal, ownsAuthority: () => boolean) => Promise<Prepared>,
    resolvePrepared: (
      prepared: Prepared,
      ownsAuthority: () => boolean,
      renewAuthorityForCommit: () => boolean,
    ) => Result | null,
  ): Promise<Result | null> {
    if (locks) {
      return locks.request(
        mutationLockName,
        async () => {
          const controller = new AbortController();
          const ownsAuthority = () => !controller.signal.aborted;
          const prepared = await operation(controller.signal, ownsAuthority);
          return resolvePrepared(prepared, ownsAuthority, ownsAuthority);
        },
      );
    }
    if (!storage) return null;

    const deadline = now() + timeout;
    while (now() < deadline) {
      let observed: SessionMutationLease | null;
      try {
        observed = parseLease(storage.getItem(mutationLeaseKey));
      } catch {
        return null;
      }
      if (!observed || observed.expiresAt <= now()) {
        const candidate: SessionMutationLease = {
          version: 1,
          ownerId,
          nonce: randomId(),
          expiresAt: now() + leaseDuration,
        };
        const encoded = JSON.stringify(candidate);
        let operationFailed = false;
        let operationFailure: unknown;
        try {
          storage.setItem(mutationLeaseKey, encoded);
          await wait(settle);
          if (storage.getItem(mutationLeaseKey) === encoded) {
            let ownershipLost = false;
            const authorityController = new AbortController();
            const loseOwnership = (): void => {
              ownershipLost = true;
              authorityController.abort();
            };
            let heartbeatStopped = false;
            let stopHeartbeat!: () => void;
            const heartbeatStop = new Promise<void>((resolve) => {
              stopHeartbeat = resolve;
            });
            const heartbeatInterval = Math.max(1, Math.floor(leaseDuration / 3));
            const ownsLease = (): boolean => {
              if (ownershipLost) return false;
              try {
                const current = parseLease(storage.getItem(mutationLeaseKey));
                const owns = current !== null
                  && sameLeaseOwner(current, candidate)
                  && current.expiresAt > now();
                if (!owns) loseOwnership();
                return owns;
              } catch {
                loseOwnership();
                return false;
              }
            };
            const renewLeaseForCommit = (): boolean => {
              if (!ownsLease()) return false;
              try {
                const renewed: SessionMutationLease = {
                  ...candidate,
                  expiresAt: now() + leaseDuration,
                };
                const renewedValue = JSON.stringify(renewed);
                storage.setItem(mutationLeaseKey, renewedValue);
                if (storage.getItem(mutationLeaseKey) !== renewedValue) {
                  loseOwnership();
                  return false;
                }
                return ownsLease();
              } catch {
                loseOwnership();
                return false;
              }
            };
            const heartbeat = (async () => {
              try {
                while (!heartbeatStopped) {
                  await Promise.race([wait(heartbeatInterval), heartbeatStop]);
                  if (heartbeatStopped) return;
                  const current = parseLease(storage.getItem(mutationLeaseKey));
                  if (
                    current === null
                    || !sameLeaseOwner(current, candidate)
                    || current.expiresAt <= now()
                  ) {
                    loseOwnership();
                    return;
                  }
                  const renewed: SessionMutationLease = {
                    ...candidate,
                    expiresAt: now() + leaseDuration,
                  };
                  const renewedValue = JSON.stringify(renewed);
                  storage.setItem(mutationLeaseKey, renewedValue);
                  if (storage.getItem(mutationLeaseKey) !== renewedValue) {
                    loseOwnership();
                    return;
                  }
                }
              } catch {
                loseOwnership();
              }
            })();
            try {
              if (!ownsLease()) return null;
              let prepared: Prepared;
              try {
                prepared = await operation(authorityController.signal, ownsLease);
              } catch (error) {
                operationFailed = true;
                operationFailure = error;
                throw error;
              }
              try {
                return resolvePrepared(
                  prepared,
                  ownsLease,
                  renewLeaseForCommit,
                );
              } catch (error) {
                operationFailed = true;
                operationFailure = error;
                throw error;
              }
            } finally {
              heartbeatStopped = true;
              stopHeartbeat();
              await heartbeat;
              try {
                if (sameLeaseOwner(parseLease(storage.getItem(mutationLeaseKey)), candidate)) {
                  storage.removeItem(mutationLeaseKey);
                }
              } finally {
                channel?.postMessage({
                  version: 1,
                  kind: "session-mutation-release",
                  sourceId: ownerId,
                } satisfies SessionMutationReleaseMessage);
              }
            }
          }
        } catch {
          if (operationFailed) throw operationFailure;
          return null;
        }
      }
      await waitForLeaseProgress(channel, wait, poll);
    }
    return null;
  }

  function coordinateMutation<T>(
    operation: (signal: AbortSignal, ownsAuthority: () => boolean) => Promise<T>,
  ): Promise<T | null> {
    return coordinateExclusive(
      operation,
      (result, ownsAuthority) => ownsAuthority() ? result : null,
    );
  }

  function coordinateCommittedMutation<T>(
    operation: (
      signal: AbortSignal,
      ownsAuthority: () => boolean,
      stage: StageSessionMutationCommit,
    ) => Promise<CoordinatedSessionMutationCommit<T>>,
  ): Promise<T | null> {
    let staged = false;
    const stage: StageSessionMutationCommit = (finalize, rollback) => {
      if (staged) throw new Error("A coordinated mutation commit can only be staged once.");
      staged = true;
      return {
        [coordinatedCommitBrand]: undefined as never,
        finalize,
        rollback,
        consumed: false,
      } satisfies InternalSessionMutationCommit<unknown> as CoordinatedSessionMutationCommit<never>;
    };
    return coordinateExclusive(
      (signal, ownsAuthority) => operation(signal, ownsAuthority, stage),
      (opaque, ownsAuthority, renewAuthorityForCommit) => {
        const commit = opaque as InternalSessionMutationCommit<T>;
        if (
          !staged
          || commit === null
          || typeof commit !== "object"
          || !(coordinatedCommitBrand in commit)
          || commit.consumed
          || !ownsAuthority()
          || !renewAuthorityForCommit()
          || !ownsAuthority()
        ) return null;
        commit.consumed = true;
        try {
          const result = commit.finalize(ownsAuthority);
          if (
            result !== null
            && typeof result === "object"
            && "then" in result
            && typeof (result as { readonly then?: unknown }).then === "function"
          ) throw new TypeError("A coordinated mutation finalizer must be synchronous.");
          return result;
        } catch (error) {
          commit.rollback();
          throw error;
        }
      },
    );
  }

  return {
    coordinateMutation,
    coordinateCommittedMutation,
    coordinateRefresh<T extends CoordinatedSessionVersion>(
      predecessor: CoordinatedSessionVersion,
      operations: RefreshCoordinationOperations<T>,
    ): Promise<T | null> {
      return coordinateMutation((signal, ownsAuthority) => resolveUnderExclusiveAuthority(
        predecessor,
        operations,
        ownsAuthority,
        signal,
      ));
    },
  };
}

function validMetadata(value: unknown): value is CrossContextSessionMetadata {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const metadata = value as Partial<CrossContextSessionMetadata>;
  if (metadata.state === "anonymous") return Object.keys(metadata).length === 1;
  return metadata.state === "authenticated"
    && typeof metadata.userId === "string"
    && typeof metadata.sessionId === "string"
    && typeof metadata.refreshGeneration === "number"
    && Number.isSafeInteger(metadata.refreshGeneration)
    && metadata.refreshGeneration >= 0;
}

function validResumeSnapshot(
  value: unknown,
  updatedAt: number,
): value is CrossContextLoginSwitchResumeSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Partial<CrossContextLoginSwitchResumeSnapshot>;
  if (
    Object.keys(value).length !== 3
    || typeof snapshot.challengeId !== "string"
    || !canonicalIdentifierPattern.test(snapshot.challengeId)
    || typeof snapshot.raw !== "string"
    || snapshot.raw.length === 0
    || snapshot.raw.length > maximumResumeSnapshotRawLength
    || typeof snapshot.createdAt !== "number"
    || !Number.isSafeInteger(snapshot.createdAt)
    || snapshot.createdAt < 0
    || snapshot.createdAt > updatedAt
  ) return false;
  try {
    const resume = JSON.parse(snapshot.raw) as Record<string, unknown>;
    const expectedKeys = [
      "candidateDeviceId",
      "challengeId",
      "createdAt",
      "expectedSessionId",
      "expectedUserId",
      "predecessorDeviceId",
      "version",
    ].sort();
    const keys = Object.keys(resume).sort();
    return keys.length === expectedKeys.length
      && keys.every((key, index) => key === expectedKeys[index])
      && resume.version === 1
      && resume.challengeId === snapshot.challengeId
      && resume.createdAt === snapshot.createdAt
      && typeof resume.predecessorDeviceId === "string"
      && canonicalIdentifierPattern.test(resume.predecessorDeviceId)
      && typeof resume.candidateDeviceId === "string"
      && canonicalIdentifierPattern.test(resume.candidateDeviceId)
      && resume.predecessorDeviceId !== resume.candidateDeviceId
      && typeof resume.expectedUserId === "string"
      && canonicalIdentifierPattern.test(resume.expectedUserId)
      && typeof resume.expectedSessionId === "string"
      && canonicalIdentifierPattern.test(resume.expectedSessionId);
  } catch {
    return false;
  }
}

function validResumeSnapshots(value: unknown, updatedAt: number): boolean {
  if (!Array.isArray(value) || value.length > maximumAnonymousTransitionSnapshots) return false;
  const seen = new Set<string>();
  for (const snapshot of value) {
    if (!validResumeSnapshot(snapshot, updatedAt) || seen.has(snapshot.challengeId)) return false;
    seen.add(snapshot.challengeId);
  }
  return true;
}

function sessionStateMessage(value: unknown): value is SessionStateMessage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Partial<SessionStateMessage>;
  const transition = message.anonymousTransition;
  if (
    message.version !== 1
    || message.kind !== "session-state"
    || typeof message.sourceId !== "string"
    || typeof message.updatedAt !== "number"
    || !Number.isSafeInteger(message.updatedAt)
    || message.updatedAt < 0
    || !validMetadata(message.metadata)
  ) return false;
  const validTransition = transition === undefined || (
    transition !== null
    && typeof transition === "object"
    && !Array.isArray(transition)
    && (
      (
        transition.kind === "user_logout"
        && Object.keys(transition).length === 2
        && validResumeSnapshots(transition.resumeSnapshots, message.updatedAt)
      )
      || (
        transition.kind === "account_switch"
        && Object.keys(transition).length === 3
        && typeof transition.preservedSwitchChallengeId === "string"
        && canonicalIdentifierPattern.test(transition.preservedSwitchChallengeId)
        && validResumeSnapshots(transition.resumeSnapshots, message.updatedAt)
        && transition.resumeSnapshots.some(
          (snapshot) => snapshot.challengeId === transition.preservedSwitchChallengeId,
        )
      )
    )
  );
  return message.version === 1
    && message.kind === "session-state"
    && validTransition
    && (transition === undefined || message.metadata?.state === "anonymous");
}

export function publishCrossContextSessionState(
  metadata: CrossContextSessionMetadata,
  anonymousTransition?: CrossContextAnonymousTransition,
): void {
  const channel = browserChannel();
  if (!channel) return;
  channel.postMessage({
    version: 1,
    kind: "session-state",
    sourceId: browserSourceId(),
    metadata,
    ...(anonymousTransition === undefined ? {} : { anonymousTransition }),
    updatedAt: Date.now(),
  } satisfies SessionStateMessage);
}

export function subscribeCrossContextSessionState(
  listener: (
    metadata: CrossContextSessionMetadata,
    anonymousTransition?: CrossContextAnonymousTransition,
    updatedAt?: number,
  ) => void,
): () => void {
  const channel = browserChannel();
  if (!channel) return () => undefined;
  const sourceId = browserSourceId();
  const onMessage: CoordinationMessageListener = (event) => {
    if (!sessionStateMessage(event.data) || event.data.sourceId === sourceId) return;
    listener(event.data.metadata, event.data.anonymousTransition, event.data.updatedAt);
  };
  channel.addEventListener("message", onMessage);
  return () => channel.removeEventListener("message", onMessage);
}
