import { describe, expect, it } from 'vitest';
import { buildDiscoveryStatement, DEFAULT_DISCOVERY_TUNING } from './events.discovery-sql.js';

const viewerId = '019b0000-0000-7000-8000-000000000001';
const cursor = {
  date: '2026-08-01T03:00:00.000Z',
  id: '019b0000-0000-7000-8100-000000000010',
};

describe('buildDiscoveryStatement', () => {
  it('applies every collection filter before stable cursor pagination', () => {
    const statement = buildDiscoveryStatement(viewerId, {
      query: 'coffee',
      region: 'tokyo',
      category: 'food',
      startsAfter: new Date('2026-08-01T00:00:00.000Z'),
      startsBefore: new Date('2026-08-31T23:59:59.000Z'),
      availableOnly: true,
      format: 'hybrid',
      language: 'ja',
      price: 'paid',
      bounds: { west: 139.6, south: 35.5, east: 139.9, north: 35.8 },
      limit: 24,
    }, cursor);

    const orderBy = statement.text.indexOf('ORDER BY e.starts_at, e.id');
    expect(orderBy).toBeGreaterThan(0);
    for (const fragment of [
      'l.region_id',
      'e.category_id',
      'e.starts_at >=',
      'e.starts_at <=',
      'c.confirmed_count',
      'c.pending_count',
      'c.offered_count',
      'e.format',
      'e.locale_confirmed_at IS NOT NULL',
      'ANY(e.supported_locales)',
      'f.is_free',
      'ST_Intersects',
      'ST_MakeEnvelope',
      '(e.starts_at, e.id)',
    ]) {
      expect(statement.text.indexOf(fragment), fragment).toBeGreaterThan(0);
      expect(statement.text.indexOf(fragment), fragment).toBeLessThan(orderBy);
    }
    expect(statement.text).toContain('ORDER BY e.starts_at, e.id');
    expect(statement.text).toContain('LIMIT');
    expect(statement.values.at(-1)).toBe(25);
  });

  it('keeps every user value out of SQL text and in the parameter list', () => {
    const queryMarker = "coffee%' OR true --";
    const regionMarker = 'tokyo-user-value';
    const statement = buildDiscoveryStatement(viewerId, {
      query: queryMarker,
      region: regionMarker,
      category: 'food-user-value',
      language: 'en',
      limit: 20,
    }, null);

    expect(statement.text).not.toContain(queryMarker);
    expect(statement.text).not.toContain(regionMarker);
    expect(statement.values).toEqual(expect.arrayContaining([
      viewerId,
      queryMarker,
      regionMarker,
      'food-user-value',
      'en',
    ]));
  });

  it('selects snapped discovery coordinates, real capacity and trust facts', () => {
    const statement = buildDiscoveryStatement(null, { limit: 20 }, null);

    expect(statement.text).toContain('ST_SnapToGrid');
    expect(statement.text).toContain('AS available_capacity');
    expect(statement.text).toContain('phone_verified_at IS NOT NULL');
    expect(statement.text).toContain('completed_at IS NOT NULL');
    expect(statement.text).toContain("attendance_rate_band");
    expect(statement.text).toContain('offer_expires_at');
    expect(statement.text).toContain('registration_party_size');
    expect(statement.text).not.toContain('events.registration_questions');
  });

  it('keeps the default time sort byte-identical to the legacy ordering', () => {
    const statement = buildDiscoveryStatement(viewerId, { limit: 20 }, null);
    expect(statement.text).toContain('ORDER BY e.starts_at, e.id');
    expect(statement.text).not.toContain('AS sort_rank');
  });

  it('searches titles, descriptions, tags, organizer nicknames and group names', () => {
    const statement = buildDiscoveryStatement(null, { query: 'jazz', limit: 20 }, null);
    // group name field requires the community group join
    expect(statement.text).toContain('community.groups');
    expect(statement.text).toContain('e.title ILIKE');
    expect(statement.text).toContain('e.description ILIKE');
    expect(statement.text).toMatch(/unnest\(e\.tags\)/);
    expect(statement.text).toMatch(/profile\.nickname ILIKE/);
    expect(statement.text).toMatch(/grp\.name ILIKE/);
  });

  it('applies the distance filter with PostGIS ST_DWithin around the origin', () => {
    const statement = buildDiscoveryStatement(null, {
      near: { lat: 35.68, lng: 139.76 },
      radiusKm: 5,
      limit: 20,
    }, null);
    expect(statement.text).toContain('ST_DWithin');
    expect(statement.text).toContain('ST_MakePoint');
    // radius must be applied in metres and stay parameterised
    expect(statement.values).toContain(139.76);
    expect(statement.values).toContain(35.68);
    expect(statement.values).toContain(5000);
  });

  it('caps the distance radius at the configured maximum', () => {
    const statement = buildDiscoveryStatement(null, {
      near: { lat: 35.68, lng: 139.76 },
      radiusKm: 9999,
      limit: 20,
    }, null, { tuning: { ...DEFAULT_DISCOVERY_TUNING, maxRadiusKm: 100 } });
    expect(statement.values).toContain(100_000);
    expect(statement.values).not.toContain(9_999_000);
  });

  it.each([
    ['small', 'e.capacity <='],
    ['large', 'e.capacity >='],
    ['medium', 'e.capacity >'],
  ] as const)('filters by capacity scale %s', (capacityScale, fragment) => {
    const statement = buildDiscoveryStatement(null, { capacityScale, limit: 20 }, null);
    expect(statement.text).toContain(fragment);
  });

  it('restricts to certified (verified) organizers when requested', () => {
    const occurrences = (text: string): number =>
      text.split('organizer.phone_verified_at IS NOT NULL').length - 1;
    const base = buildDiscoveryStatement(null, { limit: 20 }, null);
    const certified = buildDiscoveryStatement(null, { certifiedOnly: true, limit: 20 }, null);
    // The SELECT list always exposes phone_verified; the certified filter adds a
    // second occurrence in the WHERE clause.
    expect(occurrences(base.text)).toBe(1);
    expect(occurrences(certified.text)).toBe(2);
    // The extra occurrence lives in the WHERE clause, not after the final ORDER BY.
    const whereClause = certified.text.slice(certified.text.lastIndexOf('WHERE '));
    expect(whereClause).toContain('organizer.phone_verified_at IS NOT NULL');
  });

  it('filters by public city area', () => {
    const statement = buildDiscoveryStatement(null, { city: '渋谷区', limit: 20 }, null);
    expect(statement.text).toContain('l.public_area ILIKE');
    expect(statement.values).toContain('渋谷区');
  });

  it('orders by newest publication when sort=newest', () => {
    const statement = buildDiscoveryStatement(null, { sort: 'newest', limit: 20 }, null);
    expect(statement.text).toContain('AS sort_rank');
    expect(statement.text).toMatch(/ORDER BY[^]*e\.created_at DESC/);
  });

  it('orders by ascending distance when sort=distance with an origin', () => {
    const statement = buildDiscoveryStatement(null, {
      sort: 'distance', near: { lat: 35.68, lng: 139.76 }, limit: 20,
    }, null);
    expect(statement.text).toContain('ST_Distance');
    expect(statement.text).toMatch(/ORDER BY[^]*sort_rank[^]*ASC|ORDER BY ST_Distance[^]*ASC/);
    // distance sort must exclude events without coordinates for stable keyset paging
    expect(statement.text).toContain('l.point IS NOT NULL');
  });

  it('falls back to the time sort when sort=distance but no origin is provided', () => {
    const statement = buildDiscoveryStatement(null, { sort: 'distance', limit: 20 }, null);
    expect(statement.text).toContain('ORDER BY e.starts_at, e.id');
    expect(statement.text).not.toContain('ST_Distance');
  });

  it('orders by fill ratio descending when sort=almost_full', () => {
    const statement = buildDiscoveryStatement(null, { sort: 'almost_full', limit: 20 }, null);
    expect(statement.text).toContain('AS sort_rank');
    expect(statement.text).toContain('NULLIF(e.capacity, 0)');
    expect(statement.text).toMatch(/DESC/);
  });

  it('orders by an explainable score when sort=recommended', () => {
    const statement = buildDiscoveryStatement(viewerId, {
      sort: 'recommended', limit: 20,
    }, null, { referenceTime: new Date('2026-08-01T00:00:00.000Z') });
    expect(statement.text).toContain('AS sort_rank');
    // freshness term anchored to the stable reference time (parameterised)
    expect(statement.values).toContain('2026-08-01T00:00:00.000Z');
    // trust and follow signals feed the score
    expect(statement.text).toContain('completed_event_count');
  });

  it('applies a rank keyset when paginating a non-time sort', () => {
    const statement = buildDiscoveryStatement(null, { sort: 'newest', limit: 20 }, {
      rank: '2026-08-01T00:00:00.000Z',
      id: '019b0000-0000-7000-8100-000000000010',
    });
    expect(statement.text).not.toContain('(e.starts_at, e.id) >');
    expect(statement.values).toContain('2026-08-01T00:00:00.000Z');
    expect(statement.values).toContain('019b0000-0000-7000-8100-000000000010');
  });

  it('keeps user-supplied capacity scale, city and coordinates out of SQL text', () => {
    const statement = buildDiscoveryStatement(null, {
      city: "shibuya'; DROP TABLE events --",
      near: { lat: 12.34, lng: 56.78 },
      limit: 20,
    }, null);
    expect(statement.text).not.toContain('DROP TABLE');
    expect(statement.values).toContain("shibuya'; DROP TABLE events --");
  });
});
