BEGIN;

ALTER TABLE events.events
  ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS attendee_requirements text,
  ADD COLUMN IF NOT EXISTS risk_flags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS risk_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS checkin_mode text NOT NULL DEFAULT 'dynamic_qr',
  ADD COLUMN IF NOT EXISTS comment_permission text NOT NULL DEFAULT 'participants',
  ADD COLUMN IF NOT EXISTS poster_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE events.events DROP CONSTRAINT IF EXISTS events_checkin_mode_check;
ALTER TABLE events.events ADD CONSTRAINT events_checkin_mode_check
  CHECK (checkin_mode IN ('dynamic_qr', 'six_digit', 'manual'));
ALTER TABLE events.events DROP CONSTRAINT IF EXISTS events_comment_permission_check;
ALTER TABLE events.events ADD CONSTRAINT events_comment_permission_check
  CHECK (comment_permission IN ('disabled', 'participants', 'group_members'));

ALTER TABLE events.event_locations
  ADD COLUMN IF NOT EXISTS exact_address_visibility text NOT NULL DEFAULT 'confirmed';
ALTER TABLE events.event_locations DROP CONSTRAINT IF EXISTS event_locations_exact_address_visibility_check;
ALTER TABLE events.event_locations ADD CONSTRAINT event_locations_exact_address_visibility_check
  CHECK (exact_address_visibility IN ('public', 'confirmed'));

CREATE TABLE IF NOT EXISTS events.registration_questions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  event_id uuid NOT NULL REFERENCES events.events(id) ON DELETE CASCADE,
  prompt text NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND 240),
  kind text NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'single_choice', 'boolean')),
  required boolean NOT NULL DEFAULT false,
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  sort_order smallint NOT NULL CHECK (sort_order BETWEEN 0 AND 20),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (event_id, sort_order)
);

CREATE INDEX IF NOT EXISTS registration_questions_event_idx
  ON events.registration_questions(event_id, sort_order);

COMMIT;
