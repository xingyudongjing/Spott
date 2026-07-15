-- Preserve successful completion as a durable fact instead of inferring it from archived status.
BEGIN;

ALTER TABLE events.events
  ADD COLUMN completed_at timestamptz;

UPDATE events.events
SET completed_at = COALESCE(updated_at, clock_timestamp())
WHERE status = 'ended' AND completed_at IS NULL;

CREATE OR REPLACE FUNCTION events.capture_event_completion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'ended' THEN
      NEW.completed_at := COALESCE(NEW.completed_at, clock_timestamp());
    ELSE
      NEW.completed_at := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.completed_at IS NOT NULL THEN
    NEW.completed_at := OLD.completed_at;
  ELSIF NEW.status = 'ended' AND OLD.status IS DISTINCT FROM 'ended' THEN
    NEW.completed_at := clock_timestamp();
  ELSE
    NEW.completed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_event_completion_fact
BEFORE INSERT OR UPDATE OF status ON events.events
FOR EACH ROW EXECUTE FUNCTION events.capture_event_completion();

CREATE INDEX events_completed_organizer_idx
  ON events.events(organizer_id)
  WHERE completed_at IS NOT NULL AND deleted_at IS NULL;

COMMIT;
