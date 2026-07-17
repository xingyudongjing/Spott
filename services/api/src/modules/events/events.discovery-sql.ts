import type { DiscoveryQuery, DiscoverySort } from './events.discovery-query.js';

export interface DiscoveryStatement {
  text: string;
  values: unknown[];
}

/**
 * Explainable weights and thresholds for D3 discovery search and ranking.
 * Every value is expected to be sourced from admin.config_revisions at query
 * time; these defaults are the fallback the SQL builder uses when the service
 * has not resolved live configuration.
 */
export interface DiscoveryTuning {
  capacityScaleSmallMax: number;
  capacityScaleLargeMin: number;
  maxRadiusKm: number;
  trigramThreshold: number;
  recommend: {
    freshness: number;
    availability: number;
    trust: number;
    follow: number;
    distance: number;
    relevance: number;
    trustCap: number;
    freshnessHalfLifeDays: number;
  };
}

export const DEFAULT_DISCOVERY_TUNING: DiscoveryTuning = {
  capacityScaleSmallMax: 10,
  capacityScaleLargeMin: 50,
  maxRadiusKm: 100,
  trigramThreshold: 0.15,
  recommend: {
    freshness: 1,
    availability: 0.6,
    trust: 0.8,
    follow: 1.2,
    distance: 0.7,
    relevance: 1.5,
    trustCap: 20,
    freshnessHalfLifeDays: 14,
  },
};

export type DiscoveryCursor =
  | { date: string; id: string }
  | { rank: string; id: string };

export interface DiscoveryStatementOptions {
  tuning?: DiscoveryTuning;
  referenceTime?: Date;
}

/** Resolve the effective sort, downgrading distance sorts without an origin. */
export function resolveDiscoverySort(query: DiscoveryQuery): DiscoverySort {
  const requested = query.sort ?? 'time';
  if (requested === 'distance' && !query.near) return 'time';
  return requested;
}

export function buildDiscoveryStatement(
  viewerId: string | null,
  query: DiscoveryQuery,
  cursor: DiscoveryCursor | null,
  options: DiscoveryStatementOptions = {},
): DiscoveryStatement {
  const tuning = options.tuning ?? DEFAULT_DISCOVERY_TUNING;
  const referenceTime = options.referenceTime ?? new Date();
  const sort = resolveDiscoverySort(query);

  const values: unknown[] = [];
  const parameter = (value: unknown): string => `$${values.push(value)}`;
  const viewer = parameter(viewerId);

  // Shared origin geography for distance filter, distance sort and the
  // recommendation proximity term. Parameterised once so it is reusable.
  const origin = query.near
    ? `ST_SetSRID(ST_MakePoint(${parameter(query.near.lng)}::double precision, `
      + `${parameter(query.near.lat)}::double precision), 4326)::geography`
    : null;

  const filters = [
    "e.status IN ('published','registration_closed','in_progress')",
    'e.deleted_at IS NULL',
  ];

  if (query.startsAfter) filters.push(`e.starts_at >= ${parameter(query.startsAfter.toISOString())}::timestamptz`);
  else filters.push("e.starts_at >= clock_timestamp() - interval '6 hours'");
  if (query.startsBefore) filters.push(`e.starts_at <= ${parameter(query.startsBefore.toISOString())}::timestamptz`);
  if (query.region) filters.push(`l.region_id = ${parameter(query.region)}::text`);
  if (query.city) filters.push(`l.public_area ILIKE '%' || ${parameter(query.city)}::text || '%'`);
  if (query.query) {
    const value = parameter(query.query);
    const threshold = parameter(tuning.trigramThreshold);
    // Search across the five D3 fields: title, description, tags, organizer
    // nickname and linked group name. Substring matching plus pg_trgm
    // similarity covers CJK queries where token-based FTS under-segments.
    filters.push(`(
      e.title ILIKE '%' || ${value}::text || '%'
      OR e.description ILIKE '%' || ${value}::text || '%'
      OR profile.nickname ILIKE '%' || ${value}::text || '%'
      OR grp.name ILIKE '%' || ${value}::text || '%'
      OR EXISTS (SELECT 1 FROM unnest(e.tags) tag WHERE tag ILIKE '%' || ${value}::text || '%')
      OR similarity(e.title, ${value}::text) > ${threshold}::real
      OR similarity(COALESCE(profile.nickname, ''), ${value}::text) > ${threshold}::real
      OR EXISTS (SELECT 1 FROM unnest(e.tags) tag WHERE similarity(tag, ${value}::text) > ${threshold}::real)
    )`);
  }
  if (query.category) filters.push(`e.category_id = ${parameter(query.category)}::text`);
  if (query.availableOnly) {
    filters.push(`COALESCE(c.confirmed_count, 0) + COALESCE(c.pending_count, 0)
      + COALESCE(c.offered_count, 0) < e.capacity`);
  }
  if (query.format) filters.push(`e.format = ${parameter(query.format)}::text`);
  if (query.language) {
    filters.push(`e.locale_confirmed_at IS NOT NULL
      AND ${parameter(query.language)}::text = ANY(e.supported_locales)`);
  }
  if (query.price) filters.push(`f.is_free = ${parameter(query.price === 'free')}::boolean`);
  if (query.capacityScale === 'small') {
    filters.push(`e.capacity <= ${parameter(tuning.capacityScaleSmallMax)}::int`);
  } else if (query.capacityScale === 'large') {
    filters.push(`e.capacity >= ${parameter(tuning.capacityScaleLargeMin)}::int`);
  } else if (query.capacityScale === 'medium') {
    filters.push(`e.capacity > ${parameter(tuning.capacityScaleSmallMax)}::int
      AND e.capacity < ${parameter(tuning.capacityScaleLargeMin)}::int`);
  }
  if (query.certifiedOnly) filters.push('organizer.phone_verified_at IS NOT NULL');
  if (query.bounds) {
    const west = parameter(query.bounds.west);
    const south = parameter(query.bounds.south);
    const east = parameter(query.bounds.east);
    const north = parameter(query.bounds.north);
    filters.push(`ST_Intersects(
      l.point,
      ST_MakeEnvelope(${west}::double precision, ${south}::double precision,
        ${east}::double precision, ${north}::double precision, 4326)::geography
    )`);
  }
  if (origin && query.radiusKm !== undefined) {
    const radiusMeters = Math.min(query.radiusKm, tuning.maxRadiusKm) * 1000;
    filters.push(`ST_DWithin(l.point, ${origin}, ${parameter(radiusMeters)}::double precision)`);
  }

  // Build the ordering expression. The time sort is intentionally kept
  // byte-identical to the historical query so its keyset pagination and the
  // existing golden tests remain unchanged.
  let sortRankSelect = '';
  let orderBy = 'e.starts_at, e.id';
  if (sort === 'newest') {
    const primary = 'e.created_at';
    sortRankSelect = `,\n       ${primary} AS sort_rank`;
    orderBy = `${primary} DESC, e.id`;
    applyRankKeyset(filters, cursor, primary, 'timestamptz', 'desc', parameter);
  } else if (sort === 'distance' && origin) {
    const primary = `ST_Distance(l.point, ${origin})`;
    filters.push('l.point IS NOT NULL');
    sortRankSelect = `,\n       ${primary} AS sort_rank`;
    orderBy = `${primary} ASC, e.id`;
    applyRankKeyset(filters, cursor, primary, 'numeric', 'asc', parameter);
  } else if (sort === 'almost_full') {
    filters.push('e.capacity IS NOT NULL');
    const primary = `((COALESCE(c.confirmed_count, 0) + COALESCE(c.pending_count, 0)
      + COALESCE(c.offered_count, 0))::numeric / NULLIF(e.capacity, 0))`;
    sortRankSelect = `,\n       ${primary} AS sort_rank`;
    orderBy = `${primary} DESC, e.id`;
    applyRankKeyset(filters, cursor, primary, 'numeric', 'desc', parameter);
  } else if (sort === 'recommended') {
    const primary = recommendationScore({
      viewer,
      origin,
      queryValue: query.query ? parameter(query.query) : null,
      referenceTime: parameter(referenceTime.toISOString()),
      tuning,
      parameter,
    });
    sortRankSelect = `,\n       ${primary} AS sort_rank`;
    orderBy = `${primary} DESC, e.id`;
    applyRankKeyset(filters, cursor, primary, 'numeric', 'desc', parameter);
  } else if (cursor && 'date' in cursor) {
    // Default time sort keyset (unchanged legacy behaviour).
    filters.push(`(e.starts_at, e.id) > (
      ${parameter(cursor.date)}::timestamptz,
      ${parameter(cursor.id)}::uuid
    )`);
  }

  const groupJoin = query.query
    ? '\n     LEFT JOIN community.groups grp ON grp.id = e.group_id AND grp.deleted_at IS NULL'
    : '';

  const limit = parameter(Math.min(Math.max(query.limit, 1), 100) + 1);

  return {
    text: `SELECT e.*, l.region_id, l.public_area, NULL::bytea AS exact_address_cipher,
       f.is_free, f.amount_jpy, f.collector_name, f.method, f.payment_deadline_text,
       f.refund_policy,
       COALESCE(c.confirmed_count, 0)::int AS confirmed_count,
       COALESCE(c.pending_count, 0)::int AS pending_count,
       COALESCE(c.offered_count, 0)::int AS offered_count,
       GREATEST(0, e.capacity - COALESCE(c.confirmed_count, 0)
         - COALESCE(c.pending_count, 0) - COALESCE(c.offered_count, 0))::int AS available_capacity,
       registration.id AS registration_id,
       registration.status::text AS registration_status,
       registration.party_size::int AS registration_party_size,
       promotion.expires_at AS offer_expires_at,
       profile.nickname AS organizer_name,
       organizer.public_handle AS organizer_handle,
       organizer.phone_verified_at IS NOT NULL AS phone_verified,
       COALESCE(trust.completed_event_count, 0)::int AS completed_event_count,
       CASE
         WHEN COALESCE(trust.attendance_sample, 0) < 5 THEN 'unavailable'
         WHEN trust.checked_in_party_count::numeric / NULLIF(trust.attendance_sample, 0) < 0.70 THEN 'under_70'
         WHEN trust.checked_in_party_count::numeric / NULLIF(trust.attendance_sample, 0) < 0.90 THEN '70_89'
         ELSE '90_plus'
       END AS attendance_rate_band,
       favorite.event_id IS NOT NULL AS favorited,
       EXISTS(
         SELECT 1 FROM identity.follows follow
         WHERE follow.follower_id = ${viewer} AND follow.target_type = 'user'
           AND follow.target_id = e.organizer_id AND follow.deleted_at IS NULL
       ) AS organizer_followed,
       l.exact_address_visibility,
       CASE WHEN l.point IS NULL THEN NULL
         ELSE ST_Y(ST_SnapToGrid(l.point::geometry, 0.01))
       END AS latitude,
       CASE WHEN l.point IS NULL THEN NULL
         ELSE ST_X(ST_SnapToGrid(l.point::geometry, 0.01))
       END AS longitude,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'id', media.id, 'assetId', media.media_asset_id,
           'sortOrder', media.sort_order, 'state', asset.state,
           'moderationState', asset.moderation_state,
           'url', asset.derivatives->'card'->>'url'
         ) ORDER BY media.sort_order)
         FROM events.event_media media
         LEFT JOIN media.assets asset ON asset.id = media.media_asset_id
         WHERE media.event_id = e.id
       ), '[]'::jsonb) AS media_items${sortRankSelect}
     FROM events.events e
     JOIN identity.users organizer ON organizer.id = e.organizer_id
     LEFT JOIN identity.profiles profile
       ON profile.user_id = e.organizer_id AND profile.deleted_at IS NULL
     LEFT JOIN events.event_locations l ON l.event_id = e.id
     LEFT JOIN events.event_fees f ON f.event_id = e.id
     LEFT JOIN events.event_capacity c ON c.event_id = e.id${groupJoin}
     LEFT JOIN LATERAL (
       SELECT candidate.id, candidate.status, candidate.party_size
       FROM events.registrations candidate
       WHERE candidate.event_id = e.id AND candidate.user_id = ${viewer}
         AND candidate.deleted_at IS NULL
         AND candidate.status IN ('pending','confirmed','waitlisted','offered','checked_in')
       ORDER BY candidate.updated_at DESC, candidate.id DESC
       LIMIT 1
     ) registration ON true
     LEFT JOIN LATERAL (
       SELECT offer.expires_at
       FROM events.waitlist_promotions offer
       WHERE offer.registration_id = registration.id
         AND offer.accepted_at IS NULL AND offer.expired_at IS NULL
       ORDER BY offer.offered_at DESC, offer.id DESC
       LIMIT 1
     ) promotion ON true
     LEFT JOIN events.event_favorites favorite
       ON favorite.event_id = e.id AND favorite.user_id = ${viewer}
       AND favorite.deleted_at IS NULL
     LEFT JOIN LATERAL (
       SELECT
         count(DISTINCT completed.id)::int AS completed_event_count,
         COALESCE(sum(attendance.party_size)
           FILTER (WHERE attendance.status = 'checked_in'), 0)::int AS checked_in_party_count,
         COALESCE(sum(attendance.party_size)
           FILTER (WHERE attendance.status IN ('checked_in','no_show')), 0)::int AS attendance_sample
       FROM events.events completed
       LEFT JOIN events.registrations attendance
         ON attendance.event_id = completed.id AND attendance.deleted_at IS NULL
       WHERE completed.organizer_id = e.organizer_id
         AND completed.completed_at IS NOT NULL
         AND completed.deleted_at IS NULL
     ) trust ON true
     WHERE ${filters.join('\n       AND ')}
     ORDER BY ${orderBy}
     LIMIT ${limit}`,
    values,
  };
}

/**
 * Explainable recommendation score. Every term is row-static given the anchored
 * reference time, so the ordering is stable across paginated requests. Signals:
 * time freshness, name/tag relevance, availability, organizer trust, follow
 * relationship and (when an origin is supplied) proximity.
 */
function recommendationScore(input: {
  viewer: string;
  origin: string | null;
  queryValue: string | null;
  referenceTime: string;
  tuning: DiscoveryTuning;
  parameter: (value: unknown) => string;
}): string {
  const { viewer, origin, queryValue, referenceTime, tuning, parameter } = input;
  const weights = tuning.recommend;
  const freshness = `(1.0 / (1.0 + EXTRACT(EPOCH FROM (${referenceTime}::timestamptz - e.created_at))
      / (86400.0 * ${parameter(weights.freshnessHalfLifeDays)}::numeric)))`;
  const availability = `(CASE WHEN COALESCE(c.confirmed_count, 0) + COALESCE(c.pending_count, 0)
      + COALESCE(c.offered_count, 0) < e.capacity THEN 1 ELSE 0 END)`;
  const trust = `(LEAST(COALESCE(trust.completed_event_count, 0), ${parameter(weights.trustCap)}::int)::numeric
      / NULLIF(${parameter(weights.trustCap)}::numeric, 0))`;
  const follow = `(CASE WHEN EXISTS(
      SELECT 1 FROM identity.follows follow
      WHERE follow.follower_id = ${viewer} AND follow.target_type = 'user'
        AND follow.target_id = e.organizer_id AND follow.deleted_at IS NULL
    ) THEN 1 ELSE 0 END)`;
  const distance = origin
    ? `(CASE WHEN l.point IS NOT NULL
        THEN 1.0 / (1.0 + ST_Distance(l.point, ${origin}) / 1000.0) ELSE 0 END)`
    : '0';
  const relevance = queryValue
    ? `GREATEST(similarity(e.title, ${queryValue}::text),
        0.5 * similarity(e.description, ${queryValue}::text))`
    : '0';
  return `(
      ${parameter(weights.freshness)}::numeric * ${freshness}
      + ${parameter(weights.availability)}::numeric * ${availability}
      + ${parameter(weights.trust)}::numeric * COALESCE(${trust}, 0)
      + ${parameter(weights.follow)}::numeric * ${follow}
      + ${parameter(weights.distance)}::numeric * ${distance}
      + ${parameter(weights.relevance)}::numeric * ${relevance}
    )`;
}

/** Push a stable keyset predicate for a non-time (rank) sort. */
function applyRankKeyset(
  filters: string[],
  cursor: DiscoveryCursor | null,
  primary: string,
  rankType: 'timestamptz' | 'numeric',
  direction: 'asc' | 'desc',
  parameter: (value: unknown) => string,
): void {
  if (!cursor || !('rank' in cursor)) return;
  const cast = rankType === 'timestamptz' ? '::timestamptz' : '::double precision';
  const rank = `${parameter(cursor.rank)}${cast}`;
  const id = `${parameter(cursor.id)}::uuid`;
  const comparison = direction === 'asc' ? '>' : '<';
  filters.push(`(${primary} ${comparison} ${rank}
      OR (${primary} = ${rank} AND e.id > ${id}))`);
}
