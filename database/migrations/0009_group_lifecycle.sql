-- REQ-GRP-TRANSFER, REQ-GRP-DISSOLVE, event-to-community relationship
BEGIN;

ALTER TABLE events.events
  ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES community.groups(id);
CREATE INDEX IF NOT EXISTS ix_events_group_time ON events.events(group_id, starts_at DESC)
  WHERE group_id IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE community.groups
  ADD COLUMN IF NOT EXISTS closing_at timestamptz,
  ADD COLUMN IF NOT EXISTS dissolve_after timestamptz;

COMMIT;
