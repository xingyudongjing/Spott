BEGIN;

ALTER TABLE identity.sessions
  ADD COLUMN refresh_generation bigint NOT NULL DEFAULT 0
    CHECK (refresh_generation >= 0),
  ADD COLUMN transport_class text,
  ADD COLUMN current_derivation_kid text,
  ADD COLUMN current_binding_id uuid,
  ADD COLUMN current_binding_generation bigint
    CHECK (current_binding_generation IS NULL OR current_binding_generation >= 0);

UPDATE identity.sessions AS session
SET transport_class = CASE device.platform
  WHEN 'ios' THEN 'native'
  WHEN 'ops' THEN 'ops'
  ELSE 'legacy_unclassified'
END
FROM identity.devices AS device
WHERE device.id = session.device_id;

ALTER TABLE identity.sessions
  ALTER COLUMN transport_class SET NOT NULL,
  ADD CONSTRAINT sessions_transport_class_check
    CHECK (transport_class IN ('web_bff','native','ops','legacy_unclassified'));

CREATE TABLE identity.session_refresh_history (
  session_id uuid NOT NULL REFERENCES identity.sessions(id) ON DELETE CASCADE,
  family_id uuid NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 0),
  token_hash bytea NOT NULL UNIQUE,
  derivation_kid text,
  transport_class text NOT NULL
    CHECK (transport_class IN ('web_bff','native','ops','legacy_unclassified')),
  binding_id uuid,
  binding_generation bigint,
  state text NOT NULL CHECK (state IN ('current','consumed','revoked')),
  consumed_reason text,
  consumed_at timestamptz,
  rotation_key_hash bytea,
  successor_generation bigint,
  successor_hash bytea,
  successor_derivation_kid text,
  recovery_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (session_id, generation),
  CHECK (
    (state = 'current' AND consumed_at IS NULL)
    OR (state <> 'current' AND consumed_at IS NOT NULL)
  )
);

CREATE TABLE identity.web_bff_request_nonces (
  signing_kid text NOT NULL,
  nonce_hash bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (signing_kid, nonce_hash)
);

CREATE TABLE identity.proof_hash_classes (
  proof_hash bytea PRIMARY KEY,
  proof_class text NOT NULL
    CHECK (proof_class IN ('persistent','migration_temporary')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE identity.device_bindings (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES identity.users(id),
  device_id uuid NOT NULL REFERENCES identity.devices(id),
  session_id uuid REFERENCES identity.sessions(id) ON DELETE CASCADE,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  current_hash bytea NOT NULL,
  current_kid text NOT NULL,
  previous_hash bytea,
  previous_grace_expires_at timestamptz,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  absolute_expires_at timestamptz NOT NULL,
  rotated_at timestamptz,
  revoked_at timestamptz,
  proof_class text NOT NULL DEFAULT 'persistent'
    CHECK (proof_class = 'persistent'),
  UNIQUE (user_id, device_id, id)
);

CREATE TABLE identity.web_migration_intents (
  id uuid PRIMARY KEY,
  attempt_hash bytea NOT NULL UNIQUE,
  temporary_binding_hash bytea NOT NULL UNIQUE,
  mac_version text NOT NULL,
  mac_kid text NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  terminal_status text
    CHECK (terminal_status IN ('migrated','revoked','expired','invalid')),
  proof_class text NOT NULL DEFAULT 'migration_temporary'
    CHECK (proof_class = 'migration_temporary'),
  CHECK (expires_at <= issued_at + interval '10 minutes')
);

CREATE TABLE identity.web_legacy_migrations (
  legacy_token_hash bytea PRIMARY KEY,
  intent_id uuid NOT NULL UNIQUE
    REFERENCES identity.web_migration_intents(id),
  attempt_hash bytea NOT NULL,
  outcome_session_id uuid NOT NULL REFERENCES identity.sessions(id),
  outcome_generation bigint NOT NULL CHECK (outcome_generation >= 0),
  outcome_binding_id uuid REFERENCES identity.device_bindings(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX ix_sessions_active_user_device
  ON identity.sessions(user_id, device_id, refresh_generation DESC)
  WHERE revoked_at IS NULL;
CREATE INDEX ix_refresh_history_predecessor
  ON identity.session_refresh_history(token_hash, recovery_expires_at)
  WHERE state = 'consumed';
CREATE INDEX ix_bff_nonce_expiry
  ON identity.web_bff_request_nonces(expires_at);
CREATE INDEX ix_device_bindings_active
  ON identity.device_bindings(user_id, device_id, generation DESC)
  WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION identity.assign_session_security_defaults()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = identity, pg_temp
AS $$
DECLARE
  stored_platform text;
BEGIN
  IF NEW.transport_class IS NULL THEN
    SELECT platform INTO STRICT stored_platform
    FROM identity.devices
    WHERE id = NEW.device_id;
    NEW.transport_class := CASE stored_platform
      WHEN 'ios' THEN 'native'
      WHEN 'ops' THEN 'ops'
      ELSE 'legacy_unclassified'
    END;
  END IF;
  NEW.refresh_generation := COALESCE(NEW.refresh_generation, 0);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_session_security_defaults
BEFORE INSERT ON identity.sessions
FOR EACH ROW EXECUTE FUNCTION identity.assign_session_security_defaults();

CREATE OR REPLACE FUNCTION identity.reject_session_transport_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = identity, pg_temp
AS $$
BEGIN
  IF NEW.transport_class IS DISTINCT FROM OLD.transport_class THEN
    RAISE EXCEPTION 'session transport_class is immutable'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_session_transport_immutable
BEFORE UPDATE ON identity.sessions
FOR EACH ROW EXECUTE FUNCTION identity.reject_session_transport_change();

INSERT INTO identity.session_refresh_history(
  session_id, family_id, generation, token_hash, derivation_kid,
  transport_class, state
)
SELECT
  id, refresh_family_id, refresh_generation, refresh_hash,
  current_derivation_kid, transport_class, 'current'
FROM identity.sessions
ON CONFLICT (session_id, generation) DO NOTHING;

CREATE OR REPLACE FUNCTION identity.insert_initial_session_history()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = identity, pg_temp
AS $$
BEGIN
  INSERT INTO identity.session_refresh_history(
    session_id, family_id, generation, token_hash, derivation_kid,
    transport_class, state
  ) VALUES (
    NEW.id, NEW.refresh_family_id, NEW.refresh_generation, NEW.refresh_hash,
    NEW.current_derivation_kid, NEW.transport_class, 'current'
  )
  ON CONFLICT (session_id, generation) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_session_initial_history
AFTER INSERT ON identity.sessions
FOR EACH ROW EXECUTE FUNCTION identity.insert_initial_session_history();

CREATE OR REPLACE FUNCTION identity.claim_proof_hash_class(
  candidate_hash bytea,
  candidate_class text
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = identity, pg_temp
AS $$
DECLARE
  stored_class text;
BEGIN
  IF candidate_hash IS NULL THEN
    RETURN true;
  END IF;
  IF candidate_class NOT IN ('persistent','migration_temporary') THEN
    RAISE EXCEPTION 'invalid proof hash class'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO identity.proof_hash_classes(proof_hash, proof_class)
  VALUES (candidate_hash, candidate_class)
  ON CONFLICT (proof_hash) DO UPDATE
  SET proof_hash = EXCLUDED.proof_hash
  RETURNING proof_class INTO stored_class;

  RETURN stored_class = candidate_class;
END;
$$;

CREATE OR REPLACE FUNCTION identity.reject_proof_hash_class_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = identity, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'proof hash classes are append-only'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.proof_hash IS DISTINCT FROM OLD.proof_hash
     OR NEW.proof_class IS DISTINCT FROM OLD.proof_class
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'proof hash class is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_proof_hash_classes_immutable
BEFORE UPDATE OR DELETE ON identity.proof_hash_classes
FOR EACH ROW EXECUTE FUNCTION identity.reject_proof_hash_class_mutation();

CREATE OR REPLACE FUNCTION identity.reject_temporary_proof_as_persistent()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = identity, pg_temp
AS $$
DECLARE
  candidate_hash bytea;
BEGIN
  FOR candidate_hash IN
    SELECT DISTINCT hashes.value
    FROM (VALUES (NEW.current_hash), (NEW.previous_hash)) AS hashes(value)
    WHERE hashes.value IS NOT NULL
    ORDER BY hashes.value
  LOOP
    IF NOT identity.claim_proof_hash_class(candidate_hash, 'persistent') THEN
      RAISE EXCEPTION 'migration proof cannot become persistent binding'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_persistent_proof_class
BEFORE INSERT OR UPDATE OF current_hash, previous_hash
ON identity.device_bindings
FOR EACH ROW EXECUTE FUNCTION identity.reject_temporary_proof_as_persistent();

CREATE OR REPLACE FUNCTION identity.reject_persistent_proof_as_temporary()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = identity, pg_temp
AS $$
BEGIN
  IF NOT identity.claim_proof_hash_class(
    NEW.temporary_binding_hash,
    'migration_temporary'
  ) THEN
    RAISE EXCEPTION 'persistent binding cannot become migration proof'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_temporary_proof_class
BEFORE INSERT OR UPDATE OF temporary_binding_hash
ON identity.web_migration_intents
FOR EACH ROW EXECUTE FUNCTION identity.reject_persistent_proof_as_temporary();

ALTER TABLE identity.sessions
  ADD CONSTRAINT sessions_current_binding_fkey
  FOREIGN KEY (current_binding_id)
  REFERENCES identity.device_bindings(id);

COMMIT;
