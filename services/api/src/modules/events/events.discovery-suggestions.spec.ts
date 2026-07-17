import { describe, expect, it } from 'vitest';
import { buildZeroResultSuggestions } from './events.discovery-suggestions.js';

describe('buildZeroResultSuggestions', () => {
  it('always offers creating a wanted event', () => {
    const suggestions = buildZeroResultSuggestions({ limit: 20 });
    expect(suggestions.actions).toContain('create_event');
  });

  it('offers relaxing every applied narrowing filter', () => {
    const suggestions = buildZeroResultSuggestions({
      limit: 20,
      category: 'food',
      price: 'paid',
      capacityScale: 'small',
      certifiedOnly: true,
      availableOnly: true,
      language: 'ja',
      startsBefore: new Date('2026-08-01T00:00:00.000Z'),
    });
    expect(suggestions.actions).toContain('relax_filters');
    expect(suggestions.relaxableFilters).toEqual(
      expect.arrayContaining([
        'category', 'price', 'capacityScale', 'certifiedOnly', 'availableOnly', 'language', 'date',
      ]),
    );
  });

  it('offers switching region when a place filter is applied', () => {
    const withRegion = buildZeroResultSuggestions({ limit: 20, region: 'tokyo' });
    expect(withRegion.actions).toContain('switch_region');
    expect(withRegion.currentRegion).toBe('tokyo');

    const withCity = buildZeroResultSuggestions({ limit: 20, city: '渋谷区' });
    expect(withCity.actions).toContain('switch_region');

    const withDistance = buildZeroResultSuggestions({
      limit: 20, near: { lat: 35.68, lng: 139.76 }, radiusKm: 3,
    });
    expect(withDistance.actions).toContain('switch_region');
  });

  it('offers following the search keyword when a query term is present', () => {
    const suggestions = buildZeroResultSuggestions({ limit: 20, query: 'jazz' });
    expect(suggestions.actions).toContain('follow_keyword');
    expect(suggestions.followKeyword).toBe('jazz');
  });

  it('omits keyword follow and region switch when no such filters are applied', () => {
    const suggestions = buildZeroResultSuggestions({ limit: 20 });
    expect(suggestions.actions).not.toContain('follow_keyword');
    expect(suggestions.actions).not.toContain('switch_region');
    expect(suggestions.followKeyword).toBeNull();
  });
});
