-- Event promotion (activity boost / 置顶) closes the paid-points sink that had a
-- price list and a quote endpoint but no purchase path. A promotion is a digital
-- points product: the organizer spends points (immutable double-entry Debit),
-- the event is surfaced and flagged as 推广 in discovery for a configurable
-- window, the promotion auto-expires, and a review takedown or platform fault
-- returns points pro-rata through a ledger Reversal. This never touches activity
-- fees — Spott does not collect or settle event money.
BEGIN;

CREATE TABLE commerce.event_promotions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  event_id uuid NOT NULL REFERENCES events.events(id),
  organizer_id uuid NOT NULL REFERENCES identity.users(id),
  tier text NOT NULL CHECK (tier IN ('boost_24h', 'boost_72h', 'boost_7d')),
  duration_hours integer NOT NULL CHECK (duration_hours > 0),
  amount bigint NOT NULL CHECK (amount > 0),
  purchase_transaction_id uuid NOT NULL REFERENCES commerce.point_transactions(id),
  refund_transaction_id uuid REFERENCES commerce.point_transactions(id),
  refunded_amount bigint NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0 AND refunded_amount <= amount),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'expired', 'refunded')),
  refund_reason text,
  starts_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  refunded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > starts_at)
);

-- Only one live promotion per event; buying again while active is rejected so a
-- second Debit cannot silently stack on top of an unfinished window.
CREATE UNIQUE INDEX uq_event_active_promotion
  ON commerce.event_promotions(event_id) WHERE state = 'active';

-- The worker's expiry sweep scans due active promotions.
CREATE INDEX ix_event_promotion_due
  ON commerce.event_promotions(expires_at) WHERE state = 'active';

CREATE INDEX ix_event_promotion_event ON commerce.event_promotions(event_id);

-- Backend-configurable durations and the discovery natural-result floor. Prices
-- (points.cost.boost_*) already live in the catalog from migration 0011.
INSERT INTO commerce.point_rule_catalog(key, rule_type, launch_value, stable_value, unit, conditions, description)
VALUES
  ('points.boost.hours_24h', 'limit', 24, 24, 'hours', '{}', '置顶二十四小时档时长'),
  ('points.boost.hours_72h', 'limit', 72, 72, 'hours', '{}', '置顶七十二小时档时长'),
  ('points.boost.hours_7d', 'limit', 168, 168, 'hours', '{}', '置顶七天档时长'),
  ('discovery.promotion.min_natural_percent', 'limit', 70, 70, 'percent', '{}', '推荐流每页自然结果最低占比百分比')
ON CONFLICT (key) DO UPDATE SET
  rule_type = EXCLUDED.rule_type,
  launch_value = EXCLUDED.launch_value,
  stable_value = EXCLUDED.stable_value,
  unit = EXCLUDED.unit,
  conditions = EXCLUDED.conditions,
  description = EXCLUDED.description,
  updated_at = clock_timestamp();

COMMIT;
