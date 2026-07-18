import { describe, expect, it } from 'vitest';
import { buildRecommendationCandidateStatement } from './events.recommendation-sql.js';

const viewerId = '019b0000-0000-7000-8000-000000000001';

describe('buildRecommendationCandidateStatement', () => {
  it('filters safety take-downs and account-limited hosts before scoring', () => {
    const statement = buildRecommendationCandidateStatement(viewerId, { limit: 20 }, 200, null);
    // Only surfaceable statuses; removed/cancelled/appeal never enter the candidate pool.
    expect(statement.text).toContain("e.status IN ('published','registration_closed','in_progress')");
    expect(statement.text).toContain("organizer.status = 'active'");
    expect(statement.text).toContain("NOT ('publishBlocked' = ANY(organizer.restriction_flags))");
    expect(statement.text).toContain('identity.blocks');
  });

  it('enriches candidates with interest overlap and followed-group personalisation', () => {
    const statement = buildRecommendationCandidateStatement(viewerId, { limit: 20 }, 200, null);
    expect(statement.text).toContain('identity.user_interests');
    expect(statement.text).toContain('AS interest_overlap');
    expect(statement.text).toContain('AS group_followed');
    expect(statement.text).toContain('AS organizer_followed');
  });

  it('marks candidates with an active paid promotion so the feed can flag boosts', () => {
    const statement = buildRecommendationCandidateStatement(viewerId, { limit: 20 }, 200, null);
    expect(statement.text).toContain('commerce.event_promotions');
    expect(statement.text).toContain('AS promoted');
    // Only a currently-active promotion counts (not expired or refunded).
    expect(statement.text).toContain("promo.state = 'active'");
    expect(statement.text).toContain('promo.expires_at > clock_timestamp()');
  });

  it('computes distance only when a viewer coordinate is supplied', () => {
    const withoutCoordinate = buildRecommendationCandidateStatement(viewerId, { limit: 20 }, 200, null);
    expect(withoutCoordinate.text).toContain('NULL AS distance_km');

    const withCoordinate = buildRecommendationCandidateStatement(
      viewerId,
      { limit: 20 },
      200,
      { latitude: 35.66, longitude: 139.7 },
    );
    expect(withCoordinate.text).toContain('ST_Distance');
    expect(withCoordinate.text).toContain('AS distance_km');
    expect(withCoordinate.values).toEqual(expect.arrayContaining([35.66, 139.7]));
  });

  it('keeps every user-supplied value parameterised, never interpolated', () => {
    const injection = "tokyo'; DROP TABLE events.events; --";
    const statement = buildRecommendationCandidateStatement(
      viewerId,
      { region: injection, category: 'food-value', limit: 20 },
      200,
      null,
    );
    expect(statement.text).not.toContain(injection);
    expect(statement.text).not.toContain('food-value');
    expect(statement.values).toEqual(expect.arrayContaining([viewerId, injection, 'food-value']));
  });

  it('bounds the candidate pool to a hard maximum', () => {
    const statement = buildRecommendationCandidateStatement(viewerId, { limit: 20 }, 5000, null);
    expect(statement.values.at(-1)).toBe(500);
  });
});
