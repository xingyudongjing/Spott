-- Keep draft location facts truthful and make completion provenance immutable.
BEGIN;

ALTER TABLE events.event_locations
  ALTER COLUMN region_id DROP NOT NULL,
  ALTER COLUMN public_area DROP NOT NULL;

CREATE OR REPLACE FUNCTION events.capture_event_completion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'ended' THEN
      NEW.completed_at := clock_timestamp();
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

DROP TRIGGER trg_event_completion_fact ON events.events;

CREATE TRIGGER trg_event_completion_fact
BEFORE INSERT OR UPDATE OF status, completed_at ON events.events
FOR EACH ROW EXECUTE FUNCTION events.capture_event_completion();

COMMIT;
