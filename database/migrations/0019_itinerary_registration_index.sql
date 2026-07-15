BEGIN;

CREATE INDEX IF NOT EXISTS ix_registrations_user_itinerary
  ON events.registrations(user_id, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;

COMMIT;
