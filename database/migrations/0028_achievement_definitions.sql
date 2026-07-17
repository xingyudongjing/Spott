-- Seed the achievement definitions the rule engine already supports but that were
-- never seeded, so participant/host achievements become actually earnable.
--
-- Only definitions with unambiguous rule shapes are seeded here: the exact rule_json
-- forms below are the ones covered by achievement-rules.spec.ts, and every metric is
-- populated by the CommunityService metric snapshot. Category-scoped badges
-- (city_explorer, interest specialist) and the composite "trusted host" badge depend
-- on a verified category slug and on the certified / no_severe_complaint flags, so
-- they are intentionally left for a follow-up that can verify those inputs.
--
-- Product doc H1/H2:
--   持续参与  — a monthly check-in streak of 3 (>=1 check-in per month, 3 months)
--   守约达人  — attendance rate >= 90% over the last 10 registrations
--   友好贡献  — 10 valid structured feedback submissions
--   连续组织  — a monthly hosting streak of 3

BEGIN;

INSERT INTO community.achievement_definitions(code, audience, rule_version, rule_json, visibility, active_from)
VALUES
  ('continuous_participation', 'participant', 1,
   '{"type":"streak","metric":"monthly_checkin_streak","gte":3}', 'public', clock_timestamp()),
  ('reliable_attendee', 'participant', 1,
   '{"type":"rate","metric":"recent_attendance_rate","gte":0.9,"minSample":10}', 'public', clock_timestamp()),
  ('friendly_contributor', 'participant', 1,
   '{"metric":"valid_feedback_count","gte":10}', 'public', clock_timestamp()),
  ('continuous_organizer', 'host', 1,
   '{"type":"streak","metric":"monthly_hosting_streak","gte":3}', 'public', clock_timestamp())
ON CONFLICT (code, rule_version) DO NOTHING;

COMMIT;
