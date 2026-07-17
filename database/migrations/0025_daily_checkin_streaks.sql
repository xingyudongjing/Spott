-- Persist the daily points-center check-in streak so retention rewards (daily,
-- seven-day and thirty-day bonuses) can be granted deterministically.
--
-- The streak is the authoritative server fact behind product I2's 每日签到 /
-- 连续 7 日 / 连续 30 日 rewards. It is stored as a single row per user holding the
-- last Asia/Tokyo civil day the user checked in and the length of the unbroken
-- run ending on that day. The row is the concurrency anchor for a check-in: the
-- service locks it (or serialises via an advisory lock) before computing and
-- crediting the reward, and the per-day idempotency lives on the existing
-- commerce.point_transactions UNIQUE (user_id, business_key) via the
-- `daily_checkin:{userId}:{civilDay}` business key.
BEGIN;

CREATE TABLE commerce.daily_checkin_streaks (
  user_id uuid PRIMARY KEY REFERENCES identity.users(id),
  last_checkin_date date NOT NULL,
  current_streak integer NOT NULL DEFAULT 1 CHECK (current_streak >= 1),
  longest_streak integer NOT NULL DEFAULT 1 CHECK (longest_streak >= 1),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMENT ON TABLE commerce.daily_checkin_streaks IS
  'One row per user tracking the daily points-center check-in streak. last_checkin_date is the Asia/Tokyo civil day; current_streak is the length of the unbroken run ending on it. Reward idempotency is enforced by commerce.point_transactions business keys, not by this table.';

COMMIT;
