-- Scope offline-operation idempotency to its authenticated owner/device and
-- enforce monotonic entity versions at the durable change-log boundary.
BEGIN;

-- A device may only claim operations for the user it currently belongs to.
-- Remove any legacy cross-account claims before installing the composite FK;
-- these rows are unsafe to replay and contain no authoritative domain state.
DELETE FROM sync.pending_operations operation
WHERE NOT EXISTS (
  SELECT 1
  FROM identity.devices device
  WHERE device.id = operation.device_id
    AND device.user_id = operation.user_id
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_identity_devices_id_user
  ON identity.devices(id, user_id);

ALTER TABLE sync.pending_operations
  DROP CONSTRAINT IF EXISTS pending_operations_device_id_fkey,
  DROP CONSTRAINT IF EXISTS pending_operations_device_user_fkey,
  DROP CONSTRAINT IF EXISTS pending_operations_pkey;

ALTER TABLE sync.pending_operations
  ADD CONSTRAINT pending_operations_device_user_fkey
    FOREIGN KEY (device_id, user_id) REFERENCES identity.devices(id, user_id),
  ADD CONSTRAINT pending_operations_pkey
    PRIMARY KEY (user_id, device_id, operation_id);

CREATE OR REPLACE FUNCTION sync.enforce_change_version_monotonic()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = sync, pg_temp
AS $$
DECLARE
  latest_version bigint;
  lock_identity text;
BEGIN
  lock_identity := COALESCE(NEW.user_scope::text, 'public')
    || ':' || NEW.entity_type || ':' || NEW.entity_id::text;
  PERFORM pg_advisory_xact_lock(hashtextextended(lock_identity, 0));

  SELECT change.version
  INTO latest_version
  FROM sync.change_log change
  WHERE change.user_scope IS NOT DISTINCT FROM NEW.user_scope
    AND change.entity_type = NEW.entity_type
    AND change.entity_id = NEW.entity_id
  ORDER BY change.seq DESC
  LIMIT 1;

  IF latest_version IS NOT NULL AND NEW.version < latest_version THEN
    RAISE EXCEPTION 'sync change version regressed from % to %', latest_version, NEW.version
      USING ERRCODE = '23514', CONSTRAINT = 'change_log_version_monotonic';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_change_log_version_monotonic ON sync.change_log;
CREATE TRIGGER trg_change_log_version_monotonic
BEFORE INSERT ON sync.change_log
FOR EACH ROW EXECUTE FUNCTION sync.enforce_change_version_monotonic();

COMMIT;
