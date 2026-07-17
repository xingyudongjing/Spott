import type { DiscoveryQuery } from './events.discovery-query.js';

export type ZeroResultAction =
  | 'relax_filters'
  | 'switch_region'
  | 'follow_keyword'
  | 'create_event';

export interface ZeroResultSuggestions {
  message: string;
  actions: ZeroResultAction[];
  relaxableFilters: string[];
  followKeyword: string | null;
  currentRegion: string | null;
}

/**
 * Build the D3 zero-result guidance payload. The client renders the returned
 * actions and data; no business logic is duplicated on the client. The four
 * product entry points are: relax filters, switch region, follow the keyword
 * and publish a wanted event.
 */
export function buildZeroResultSuggestions(query: DiscoveryQuery): ZeroResultSuggestions {
  const relaxableFilters: string[] = [];
  if (query.startsAfter || query.startsBefore) relaxableFilters.push('date');
  if (query.category) relaxableFilters.push('category');
  if (query.price) relaxableFilters.push('price');
  if (query.language) relaxableFilters.push('language');
  if (query.format) relaxableFilters.push('format');
  if (query.capacityScale) relaxableFilters.push('capacityScale');
  if (query.certifiedOnly) relaxableFilters.push('certifiedOnly');
  if (query.availableOnly) relaxableFilters.push('availableOnly');
  if (query.radiusKm !== undefined) relaxableFilters.push('distance');

  const hasPlaceFilter = Boolean(query.region || query.city || query.near || query.bounds);
  const followKeyword = query.query ?? null;

  const actions: ZeroResultAction[] = [];
  if (relaxableFilters.length > 0) actions.push('relax_filters');
  if (hasPlaceFilter) actions.push('switch_region');
  if (followKeyword) actions.push('follow_keyword');
  actions.push('create_event');

  return {
    message: '没有符合条件的活动。可以放宽筛选、切换地区、关注关键词，或发布你想参加的活动。',
    actions,
    relaxableFilters,
    followKeyword,
    currentRegion: query.region ?? null,
  };
}
