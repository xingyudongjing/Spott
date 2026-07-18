import type { DiscoveryQuery } from './events.discovery-query.js';

export interface RecommendationCandidateStatement {
  text: string;
  values: unknown[];
}

export interface ViewerCoordinate {
  latitude: number;
  longitude: number;
}

// Builds the candidate-generation query for the personalised home feed.
//
// Unlike the linear search query, this statement performs the safety and
// account-limitation pre-filter demanded by full-stack doc 7.5 ("安全下架与账号限制
// 在候选生成前过滤") and enriches each row with the personalisation features the
// in-memory ranker needs (interest overlap, followed group, distance). Ordering and
// module grouping happen after scoring, so this only produces a bounded candidate pool.
export function buildRecommendationCandidateStatement(
  viewerId: string | null,
  query: DiscoveryQuery,
  poolSize: number,
  coordinate: ViewerCoordinate | null,
): RecommendationCandidateStatement {
  const values: unknown[] = [];
  const parameter = (value: unknown): string => `$${values.push(value)}`;
  const viewer = parameter(viewerId);

  const filters = [
    "e.status IN ('published','registration_closed','in_progress')",
    'e.deleted_at IS NULL',
    // Safety / account-limitation gate: the host must be an active account that is
    // not suspended, restricted, or publish-blocked, and there must be no block edge
    // in either direction with the viewer.
    "organizer.status = 'active'",
    "NOT ('publishBlocked' = ANY(organizer.restriction_flags))",
    `NOT EXISTS (
       SELECT 1 FROM identity.blocks block
       WHERE (block.blocker_id = ${viewer} AND block.blocked_id = e.organizer_id)
          OR (block.blocker_id = e.organizer_id AND block.blocked_id = ${viewer})
     )`,
  ];

  if (query.startsAfter) {
    filters.push(`e.starts_at >= ${parameter(query.startsAfter.toISOString())}::timestamptz`);
  } else {
    filters.push("e.starts_at >= clock_timestamp() - interval '6 hours'");
  }
  if (query.startsBefore) {
    filters.push(`e.starts_at <= ${parameter(query.startsBefore.toISOString())}::timestamptz`);
  }
  if (query.region) filters.push(`l.region_id = ${parameter(query.region)}::text`);
  if (query.category) filters.push(`e.category_id = ${parameter(query.category)}::text`);
  if (query.format) filters.push(`e.format = ${parameter(query.format)}::text`);
  if (query.price) filters.push(`f.is_free = ${parameter(query.price === 'free')}::boolean`);
  if (query.availableOnly) {
    filters.push(`COALESCE(c.confirmed_count, 0) + COALESCE(c.pending_count, 0)
      + COALESCE(c.offered_count, 0) < e.capacity`);
  }

  const distanceExpression = coordinate
    ? `ST_Distance(
         l.point,
         ST_SetSRID(ST_MakePoint(${parameter(coordinate.longitude)}::double precision,
           ${parameter(coordinate.latitude)}::double precision), 4326)::geography
       ) / 1000.0`
    : 'NULL';

  const limit = parameter(Math.min(Math.max(poolSize, 1), 500));

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
       EXISTS(
         SELECT 1 FROM identity.follows gfollow
         WHERE gfollow.follower_id = ${viewer} AND gfollow.target_type = 'group'
           AND gfollow.target_id = e.group_id AND gfollow.deleted_at IS NULL
       ) AS group_followed,
       COALESCE((
         SELECT SUM(ui.weight)
         FROM identity.user_interests ui
         WHERE ui.user_id = ${viewer}
           AND (ui.tag_id = e.category_id OR ui.tag_id = ANY(e.tags))
       ), 0)::float AS interest_overlap,
       EXISTS(
         SELECT 1 FROM commerce.event_promotions promo
         WHERE promo.event_id = e.id AND promo.state = 'active'
           AND promo.starts_at <= clock_timestamp() AND promo.expires_at > clock_timestamp()
       ) AS promoted,
       ${distanceExpression} AS distance_km,
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
