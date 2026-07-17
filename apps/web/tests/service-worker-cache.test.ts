import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, test, vi } from "vitest";

type FetchEvent = {
  request: {
    method: string;
    url: string;
    mode: string;
    destination: string;
    cache: string;
    headers: Headers;
  };
  respondWith(response: Promise<Response>): void;
  waitUntil(promise: Promise<unknown>): void;
};

function loadServiceWorker(fetchResponse: Response) {
  const listeners = new Map<string, (event: FetchEvent) => void>();
  const cache = {
    addAll: vi.fn(async () => undefined),
    match: vi.fn(async () => undefined),
    put: vi.fn(async () => undefined),
  };
  const caches = {
    keys: vi.fn(async () => []),
    delete: vi.fn(async () => true),
    match: cache.match,
    open: vi.fn(async () => cache),
  };
  const fetch = vi.fn(async () => fetchResponse.clone());
  const self = {
    location: { origin: "https://spott.jp" },
    clients: { claim: vi.fn(async () => undefined) },
    skipWaiting: vi.fn(async () => undefined),
    addEventListener: vi.fn((name: string, listener: (event: FetchEvent) => void) => {
      listeners.set(name, listener);
    }),
  };

  vm.runInNewContext(
    readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8"),
    { self, caches, fetch, URL, Response, Headers, Set, Promise, Error, console },
  );

  async function dispatch(path: string, options: { authorization?: string; destination?: string; cache?: string } = {}) {
    let response: Promise<Response> | undefined;
    const lifetimes: Promise<unknown>[] = [];
    listeners.get("fetch")?.({
      request: {
        method: "GET",
        url: `https://spott.jp${path}`,
        mode: "same-origin",
        destination: options.destination ?? "script",
        cache: options.cache ?? "default",
        headers: new Headers(options.authorization ? { Authorization: options.authorization } : undefined),
      },
      respondWith(value) { response = value; },
      waitUntil(value) { lifetimes.push(value); },
    });
    if (response) await response;
    await Promise.all(lifetimes);
    await vi.waitFor(() => undefined);
    return { intercepted: Boolean(response) };
  }

  return { cache, dispatch, fetch };
}

describe("public service-worker cache boundary", () => {
  test("runtime-caches only a versioned /assets resource", async () => {
    const worker = loadServiceWorker(new Response("asset", {
      status: 200,
      headers: { "Cache-Control": "public, max-age=31536000, immutable" },
    }));

    await expect(worker.dispatch("/assets/index-Ab12_cd3.js")).resolves.toEqual({ intercepted: true });
    expect(worker.cache.put).toHaveBeenCalledTimes(1);
  });

  test("never intercepts an arbitrary same-origin image outside the explicit public allow-list", async () => {
    const worker = loadServiceWorker(new Response("private photo", { status: 200 }));

    await expect(worker.dispatch("/account/avatar.png", { destination: "image" }))
      .resolves.toEqual({ intercepted: false });
    expect(worker.cache.put).not.toHaveBeenCalled();
  });

  test("never serves or stores an authorized asset request from the shared public cache", async () => {
    const worker = loadServiceWorker(new Response("authorized asset", { status: 200 }));

    await expect(worker.dispatch("/assets/index-Ab12_cd3.js", { authorization: "Bearer secret" }))
      .resolves.toEqual({ intercepted: false });
    expect(worker.cache.match).not.toHaveBeenCalled();
    expect(worker.cache.put).not.toHaveBeenCalled();
  });

  test.each([
    ["private, max-age=60"],
    ["no-store"],
  ])("does not store a cache-control %s response", async (cacheControl) => {
    const worker = loadServiceWorker(new Response("sensitive", {
      status: 200,
      headers: { "Cache-Control": cacheControl },
    }));

    await expect(worker.dispatch("/assets/index-Ab12_cd3.js")).resolves.toEqual({ intercepted: true });
    expect(worker.cache.put).not.toHaveBeenCalled();
  });
});
