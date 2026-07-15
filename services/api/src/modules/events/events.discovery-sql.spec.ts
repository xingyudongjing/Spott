import { describe, expect, it } from 'vitest';
import { buildDiscoveryStatement } from './events.discovery-sql.js';

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
  });
});
