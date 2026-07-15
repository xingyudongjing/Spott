import type { DiscoveryQuery } from './events.discovery-query.js';

export interface DiscoveryStatement {
  text: string;
  values: unknown[];
}

export function buildDiscoveryStatement(
  viewerId: string | null,
  query: DiscoveryQuery,
  cursor: { date: string; id: string } | null,
): DiscoveryStatement {
  const values: unknown[] = [];
  const parameter = (value: unknown): string => `$${values.push(value)}`;
  const viewer = parameter(viewerId);
  const filters = [
    "e.status IN ('published','registration_closed','in_progress')",
    'e.deleted_at IS NULL',
  ];

  if (query.startsAfter) filters.push(`e.starts_at >= ${parameter(query.startsAfter.toISOString())}::timestamptz`);
  else filters.push("e.starts_at >= clock_timestamp() - interval '6 hours'");
  if (query.startsBefore) filters.push(`e.starts_at <= ${parameter(query.startsBefore.toISOString())}::timestamptz`);
  if (query.region) filters.push(`l.region_id = ${parameter(query.region)}::text`);
  if (query.query) {
    const value = parameter(query.query);
    filters.push(`(e.title ILIKE '%' || ${value}::text || '%'
      OR e.description ILIKE '%' || ${value}::text || '%'
      OR similarity(e.title, ${value}::text) > 0.15)`);
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
  if (cursor) {
    filters.push(`(e.starts_at, e.id) > (
      ${parameter(cursor.date)}::timestamptz,
      ${parameter(cursor.id)}::uuid
    )`);
  }
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
       ), '[]'::jsonb) AS media_items
     FROM events.events e
     JOIN identity.users organizer ON organizer.id = e.organizer_id
     LEFT JOIN identity.profiles profile
       ON profile.user_id = e.organizer_id AND profile.deleted_at IS NULL
     LEFT JOIN events.event_locations l ON l.event_id = e.id
     LEFT JOIN events.event_fees f ON f.event_id = e.id
     LEFT JOIN events.event_capacity c ON c.event_id = e.id
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
     ORDER BY e.starts_at, e.id
     LIMIT ${limit}`,
    values,
  };
}
