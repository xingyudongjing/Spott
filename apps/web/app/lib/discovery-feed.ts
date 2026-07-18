import { z } from "zod";

import { parseEventSummary, type EventSummary } from "./event-contract";

const moduleKey = z.string().trim().min(1).max(64).regex(/^[a-z0-9_:-]+$/u);
const dateTime = z.iso.datetime({ offset: true });

const feedEnvelopeSchema = z.object({
  banner: z.unknown().nullable(),
  modules: z.array(z.object({
    key: moduleKey,
    title: z.string().max(160),
    items: z.array(z.unknown()).max(100),
  }).passthrough()).max(40),
  moduleOrder: z.array(moduleKey).max(40),
  weights: z.record(z.string(), z.number()),
  scoringVersion: z.string().min(1).max(128),
  naturalResultsMinRatio: z.number(),
  serverTime: dateTime,
  generatedAt: dateTime,
  queryExplanationId: z.string().min(1).max(256),
}).passthrough();

export interface DiscoveryFeedModule {
  readonly key: string;
  readonly serverTitle: string;
  readonly items: EventSummary[];
}

export interface DiscoveryFeed {
  readonly modules: DiscoveryFeedModule[];
  readonly moduleOrder: string[];
  readonly serverTime: string;
  readonly generatedAt: string;
  readonly queryExplanationId: string;
}

export interface OrderedDiscoveryFeedModule {
  readonly key: string;
  readonly items: EventSummary[];
}

export function parseDiscoveryFeed(value: unknown): DiscoveryFeed {
  const parsed = feedEnvelopeSchema.parse(value);
  return {
    modules: parsed.modules.map((module) => ({
      key: module.key,
      serverTitle: module.title,
      items: module.items.map(parseEventSummary),
    })),
    moduleOrder: [...parsed.moduleOrder],
    serverTime: parsed.serverTime,
    generatedAt: parsed.generatedAt,
    queryExplanationId: parsed.queryExplanationId,
  };
}

/**
 * Applies only the server's presentation order and a cross-module identity
 * boundary. Ranking and module membership remain wholly server-authoritative.
 */
export function orderedDiscoveryFeedModules(
  feed: DiscoveryFeed,
): OrderedDiscoveryFeedModule[] {
  const modulesByKey = new Map<string, DiscoveryFeedModule>();
  for (const feedModule of feed.modules) {
    if (!modulesByKey.has(feedModule.key)) modulesByKey.set(feedModule.key, feedModule);
  }

  const seenKeys = new Set<string>();
  const seenEventIds = new Set<string>();
  const ordered: OrderedDiscoveryFeedModule[] = [];
  for (const key of feed.moduleOrder) {
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const source = modulesByKey.get(key);
    if (!source) continue;
    const items: EventSummary[] = [];
    for (const event of source.items) {
      if (seenEventIds.has(event.id)) continue;
      seenEventIds.add(event.id);
      items.push(event);
    }
    if (items.length > 0) ordered.push({ key, items });
  }
  return ordered;
}
