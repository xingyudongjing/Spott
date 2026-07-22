import { describe, expect, test, vi } from "vitest";

import {
  createSessionRefreshCoordinator,
  type CoordinationChannel,
  type CoordinationLockManager,
  type CoordinationStorage,
} from "../app/lib/session-refresh-coordinator";

interface SessionVersion {
  readonly sessionId: string;
  readonly userId: string;
  readonly refreshGeneration: number;
}

const predecessor: SessionVersion = {
  sessionId: "019d0000-0000-7000-8000-000000000301",
  userId: "019d0000-0000-7000-8000-000000000302",
  refreshGeneration: 4,
};

class SerialLockManager implements CoordinationLockManager {
  private readonly tails = new Map<string, Promise<unknown>>();

  request<T>(name: string, callback: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(name) ?? Promise.resolve();
    const result = previous.then(callback, callback);
    this.tails.set(name, result.catch(() => undefined));
    return result.finally(() => {
      if (this.tails.get(name) === result) this.tails.delete(name);
    });
  }
}

class SharedStorage implements CoordinationStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

class ChannelHub {
  readonly messages: unknown[] = [];
  private readonly listeners = new Set<(event: { data: unknown }) => void>();

  endpoint(): CoordinationChannel {
    return {
      postMessage: (message) => {
        this.messages.push(message);
        queueMicrotask(() => {
          for (const listener of this.listeners) listener({ data: message });
        });
      },
      addEventListener: (_type, listener) => this.listeners.add(listener),
      removeEventListener: (_type, listener) => this.listeners.delete(listener),
    };
  }
}

function successor(generation = 5): SessionVersion {
  return { ...predecessor, refreshGeneration: generation };
}

describe("cross-tab refresh coordination", () => {
  test("one origin mutation lock serializes refresh and terminal logout", async () => {
    const locks = new SerialLockManager();
    let authoritative = predecessor;
    let releaseRotation!: () => void;
    const rotationReleased = new Promise<void>((resolve) => {
      releaseRotation = resolve;
    });
    const rotate = vi.fn(async () => {
      await rotationReleased;
      authoritative = successor();
      return authoritative;
    });
    const logout = vi.fn(async () => true);
    const first = createSessionRefreshCoordinator({ ownerId: "tab-a", locks });
    const second = createSessionRefreshCoordinator({ ownerId: "tab-b", locks });

    const refreshResult = first.coordinateRefresh(predecessor, {
      synchronize: async () => authoritative,
      rotate,
    });
    await vi.waitFor(() => expect(rotate).toHaveBeenCalledOnce());
    const logoutResult = second.coordinateMutation(logout);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(logout).not.toHaveBeenCalled();

    releaseRotation();
    await expect(refreshResult).resolves.toEqual(successor());
    await expect(logoutResult).resolves.toBe(true);
    expect(logout).toHaveBeenCalledOnce();
  });

  test("navigator.locks allows only one authoritative rotation for the same predecessor", async () => {
    const locks = new SerialLockManager();
    let authoritative = predecessor;
    const rotate = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      authoritative = successor();
      return authoritative;
    });
    const operations = {
      synchronize: async () => authoritative,
      rotate,
    };
    const first = createSessionRefreshCoordinator({ ownerId: "tab-a", locks });
    const second = createSessionRefreshCoordinator({ ownerId: "tab-b", locks });

    const [left, right] = await Promise.all([
      first.coordinateRefresh(predecessor, operations),
      second.coordinateRefresh(predecessor, operations),
    ]);

    expect(left).toEqual(successor());
    expect(right).toEqual(successor());
    expect(rotate).toHaveBeenCalledOnce();
  });

  test("lease plus BroadcastChannel fallback elects one refresher and wakes the follower", async () => {
    const storage = new SharedStorage();
    const hub = new ChannelHub();
    let authoritative = predecessor;
    const rotate = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 8));
      authoritative = successor();
      return authoritative;
    });
    const shared = {
      locks: null,
      storage,
      now: Date.now,
      wait: (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
      leaseDurationMilliseconds: 1_000,
      leaseSettleMilliseconds: 2,
      leasePollMilliseconds: 2,
    } as const;
    const first = createSessionRefreshCoordinator({
      ...shared,
      ownerId: "tab-a",
      channel: hub.endpoint(),
    });
    const second = createSessionRefreshCoordinator({
      ...shared,
      ownerId: "tab-b",
      channel: hub.endpoint(),
    });

    const [left, right] = await Promise.all([
      first.coordinateRefresh(predecessor, { synchronize: async () => authoritative, rotate }),
      second.coordinateRefresh(predecessor, { synchronize: async () => authoritative, rotate }),
    ]);

    expect(left).toEqual(successor());
    expect(right).toEqual(successor());
    expect(rotate).toHaveBeenCalledOnce();
    expect(hub.messages).toContainEqual(expect.objectContaining({
      kind: "session-mutation-release",
    }));
  });

  test("fallback lease propagates operation failures after releasing authority", async () => {
    const storage = new SharedStorage();
    const coordinator = createSessionRefreshCoordinator({
      ownerId: "failing-tab",
      locks: null,
      storage,
      channel: null,
      now: Date.now,
      wait: (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
      leaseDurationMilliseconds: 1_000,
      leaseSettleMilliseconds: 1,
      leasePollMilliseconds: 2,
    });
    const failure = new Error("operation failed");

    await expect(coordinator.coordinateMutation(async () => {
      throw failure;
    })).rejects.toBe(failure);

    expect(storage.values.size).toBe(0);
  });

  test("never runs a staged final commit after fallback authority is fenced", async () => {
    const storage = new SharedStorage();
    const coordinator = createSessionRefreshCoordinator({
      ownerId: "prepared-commit-tab",
      locks: null,
      storage,
      channel: null,
      now: Date.now,
      wait: (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
      leaseDurationMilliseconds: 1_000,
      leaseSettleMilliseconds: 1,
      leasePollMilliseconds: 2,
    });
    let committed = false;
    let rolledBack = false;

    const result = coordinator.coordinateCommittedMutation(async (_signal, _ownsAuthority, stage) => {
      const leaseKey = [...storage.values.keys()][0];
      if (!leaseKey) throw new Error("active fallback lease missing");
      const prepared = stage(
        () => {
          committed = true;
          return "committed";
        },
        () => { rolledBack = true; },
      );
      storage.values.set(leaseKey, JSON.stringify({
        version: 1,
        ownerId: "fencing-tab",
        nonce: "fencing-lease",
        expiresAt: Date.now() + 10_000,
      }));
      return prepared;
    });

    await expect(result).resolves.toBeNull();
    expect(committed).toBe(false);
    expect(rolledBack).toBe(false);
  });

  test("rolls back a staged final commit when authority is lost inside the synchronous finalizer", async () => {
    const storage = new SharedStorage();
    const coordinator = createSessionRefreshCoordinator({
      ownerId: "finalizer-fence-tab",
      locks: null,
      storage,
      channel: null,
      now: Date.now,
      wait: (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
      leaseDurationMilliseconds: 1_000,
      leaseSettleMilliseconds: 1,
      leasePollMilliseconds: 2,
    });
    let visibleState = "anonymous";
    let rolledBack = false;

    const result = coordinator.coordinateCommittedMutation(async (_signal, _ownsAuthority, stage) => (
      stage(
        (ownsAuthority) => {
          visibleState = "authenticated";
          const leaseKey = [...storage.values.keys()][0];
          if (!leaseKey) throw new Error("active fallback lease missing");
          storage.values.set(leaseKey, JSON.stringify({
            version: 1,
            ownerId: "other-tab",
            nonce: "other-lease",
            expiresAt: Date.now() + 10_000,
          }));
          if (!ownsAuthority()) throw new Error("authority fenced during finalizer");
          return "committed";
        },
        () => {
          visibleState = "anonymous";
          rolledBack = true;
        },
      )
    ));

    await expect(result).rejects.toThrow("authority fenced during finalizer");
    expect(visibleState).toBe("anonymous");
    expect(rolledBack).toBe(true);
  });

  test("renews a fallback lease while rotation exceeds its original lifetime", async () => {
    const storage = new SharedStorage();
    const hub = new ChannelHub();
    let authoritative = predecessor;
    const rotate = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_200));
      authoritative = successor();
      return authoritative;
    });
    const shared = {
      locks: null,
      storage,
      now: Date.now,
      wait: (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
      leaseDurationMilliseconds: 1_000,
      leaseSettleMilliseconds: 5,
      leasePollMilliseconds: 10,
      coordinationTimeoutMilliseconds: 5_000,
    } as const;
    const first = createSessionRefreshCoordinator({
      ...shared,
      ownerId: "slow-tab-a",
      channel: hub.endpoint(),
    });
    const second = createSessionRefreshCoordinator({
      ...shared,
      ownerId: "slow-tab-b",
      channel: hub.endpoint(),
    });

    const [left, right] = await Promise.all([
      first.coordinateRefresh(predecessor, { synchronize: async () => authoritative, rotate }),
      second.coordinateRefresh(predecessor, { synchronize: async () => authoritative, rotate }),
    ]);

    expect(left).toEqual(successor());
    expect(right).toEqual(successor());
    expect(rotate).toHaveBeenCalledOnce();
  });

  test("aborts in-flight authority when another owner fences the fallback lease", async () => {
    const storage = new SharedStorage();
    let observedSignal: AbortSignal | undefined;
    const rotate = vi.fn(async (signal?: AbortSignal) => {
      observedSignal = signal;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return successor();
    });
    const coordinator = createSessionRefreshCoordinator({
      ownerId: "fenced-tab",
      locks: null,
      storage,
      channel: null,
      now: Date.now,
      wait: (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
      leaseDurationMilliseconds: 60,
      leaseSettleMilliseconds: 1,
      leasePollMilliseconds: 2,
      coordinationTimeoutMilliseconds: 200,
    });

    const result = coordinator.coordinateRefresh(predecessor, {
      synchronize: async () => predecessor,
      rotate,
    });
    await vi.waitFor(() => expect(rotate).toHaveBeenCalledOnce());
    const key = [...storage.values.keys()][0];
    if (!key) throw new Error("active fallback lease missing");
    storage.values.set(key, JSON.stringify({
      version: 1,
      ownerId: "other-tab",
      nonce: "other-lease",
      sessionId: predecessor.sessionId,
      refreshGeneration: predecessor.refreshGeneration,
      expiresAt: Date.now() + 1_000,
    }));

    await expect(result).resolves.toBeNull();
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal?.aborted).toBe(true);
  });

  test("fails closed when neither a browser lock nor a readable lease is available", async () => {
    const rotate = vi.fn(async () => successor());
    const coordinator = createSessionRefreshCoordinator({
      ownerId: "blocked-tab",
      locks: null,
      storage: {
        getItem: () => null,
        setItem: () => { throw new DOMException("blocked", "SecurityError"); },
        removeItem: () => undefined,
      },
      channel: null,
    });

    await expect(coordinator.coordinateRefresh(predecessor, {
      synchronize: async () => predecessor,
      rotate,
    })).resolves.toBeNull();
    expect(rotate).not.toHaveBeenCalled();
  });
});
