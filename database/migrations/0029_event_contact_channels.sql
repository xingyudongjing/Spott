BEGIN;

CREATE TABLE events.event_contact_channels (
  event_id uuid PRIMARY KEY REFERENCES events.events(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('email', 'line', 'website')),
  label_cipher bytea,
  value_cipher bytea NOT NULL,
  updated_by uuid NOT NULL REFERENCES identity.users(id),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMIT;
