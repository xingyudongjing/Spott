import { describe, expect, it, vi } from 'vitest';
import { EventsService } from './events.service.js';

interface RankRow {
  id: string;
  promoted: boolean;
}

function buildService(configPercent: string | null) {
  const database = {
    query: vi.fn(async () => ({ rows: [{ value: configPercent }], rowCount: 1 })),
  };
  const service = new EventsService(database as never, {} as never, {} as never, {} as never);
  const rank = (service as unknown as {
    rankByPromotion: (page: RankRow[]) => Promise<RankRow[]>;
  }).rankByPromotion.bind(service);
  return { service, database, rank };
}

function page(promotedIds: Set<string>, length: number): RankRow[] {
  return Array.from({ length }, (_value, index) => {
    const id = `e${index}`;
    return { id, promoted: promotedIds.has(id) };
  });
}

describe('EventsService discovery promotion ranking', () => {
  it('surfaces promoted events but reserves the configured natural-result floor', async () => {
    const { rank, database } = buildService('70');
    const promoted = new Set(['e1', 'e3', 'e5', 'e8']);
    const ordered = await rank(page(promoted, 10));

    // 70% natural floor on a 10-card page => at most floor(10 * 0.3) = 3 promoted surfaced.
    const surfaced = ordered.slice(0, 3);
    expect(surfaced.map((row) => row.id)).toEqual(['e1', 'e3', 'e5']);
    expect(surfaced.every((row) => row.promoted)).toBe(true);

    // The middle of the page is all natural, guaranteeing >= 70% natural above the tail.
    const naturalBlock = ordered.slice(3, 9);
    expect(naturalBlock.every((row) => !row.promoted)).toBe(true);
    expect(naturalBlock).toHaveLength(6);

    // The 4th promoted card is demoted below the natural block, not dropped.
    expect(ordered.at(-1)).toMatchObject({ id: 'e8', promoted: true });
    expect(ordered).toHaveLength(10);
    expect(database.query).toHaveBeenCalledOnce();
  });

  it('leaves the page untouched when no event is promoted', async () => {
    const { rank, database } = buildService('70');
    const original = page(new Set(), 5);
    const ordered = await rank(original);
    expect(ordered).toEqual(original);
    // Config is not even consulted when there is nothing to rerank.
    expect(database.query).not.toHaveBeenCalled();
  });

  it('keeps natural order when the page is too small to allow any promoted slot', async () => {
    const { rank } = buildService('70');
    // floor(3 * 0.3) = 0 promoted slots -> no reordering.
    const original = page(new Set(['e0']), 3);
    const ordered = await rank(original);
    expect(ordered).toEqual(original);
  });
});
