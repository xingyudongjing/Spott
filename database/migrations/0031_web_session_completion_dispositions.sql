BEGIN;

CREATE TABLE identity.web_session_completion_dispositions (
  attempt_hash bytea PRIMARY KEY
    CHECK (octet_length(attempt_hash) = 32),
  challenge_id uuid NOT NULL,
  device_id uuid NOT NULL,
  binding_id uuid NOT NULL,
  binding_generation bigint NOT NULL
    CHECK (binding_generation = 0),
  authority_digest bytea NOT NULL
    CHECK (octet_length(authority_digest) = 32),
  authority_version text NOT NULL
    CHECK (authority_version IN ('v1','legacy-v0')),
  authority_kid text NOT NULL
    CHECK (authority_kid ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  state text NOT NULL
    CHECK (state IN ('pending','accepted','discarded')),
  session_id uuid UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  decision_expires_at timestamptz NOT NULL,
  retained_until timestamptz NOT NULL,
  accepted_at timestamptz,
  discarded_at timestamptz,
  CHECK (
    decision_expires_at >= created_at
    AND retained_until > decision_expires_at
    AND retained_until <= decision_expires_at + interval '31 days'
  ),
  CHECK (
    (
      state = 'pending'
      AND session_id IS NOT NULL
      AND completed_at IS NOT NULL
      AND accepted_at IS NULL
      AND discarded_at IS NULL
    )
    OR (
      state = 'accepted'
      AND session_id IS NOT NULL
      AND completed_at IS NOT NULL
      AND accepted_at IS NOT NULL
      AND discarded_at IS NULL
    )
    OR (
      state = 'discarded'
      AND accepted_at IS NULL
      AND discarded_at IS NOT NULL
      AND (
        (session_id IS NULL AND completed_at IS NULL)
        OR (session_id IS NOT NULL AND completed_at IS NOT NULL)
      )
    )
  )
);

CREATE INDEX ix_web_session_completion_dispositions_pending
  ON identity.web_session_completion_dispositions(decision_expires_at, attempt_hash)
  WHERE state = 'pending';

CREATE INDEX ix_web_session_completion_dispositions_terminal_retention
  ON identity.web_session_completion_dispositions(retained_until, attempt_hash)
  WHERE state IN ('accepted','discarded');

CREATE INDEX ix_web_session_completion_dispositions_challenge
  ON identity.web_session_completion_dispositions(challenge_id);

-- Existing outcomes were already published by the pre-disposition protocol. Backfill them
-- as accepted while retaining only their existing keyed request digest, never OTP/proof/token
-- plaintext. Every pre-0031 outcome is explicit after this statement; runtime absence fails closed.
WITH migration_clock AS (
  SELECT clock_timestamp() AS recorded_at
)
INSERT INTO identity.web_session_completion_dispositions(
  attempt_hash, challenge_id, device_id, binding_id, binding_generation,
  authority_digest, authority_version, authority_kid, state, session_id,
  created_at, completed_at, decision_expires_at, retained_until,
  accepted_at, discarded_at
)
SELECT
  outcome.attempt_hash,
  outcome.challenge_id,
  outcome.device_id,
  outcome.binding_id,
  outcome.binding_generation,
  outcome.request_digest,
  'legacy-v0',
  outcome.derivation_kid,
  'accepted',
  outcome.session_id,
  outcome.created_at,
  outcome.created_at,
  GREATEST(outcome.recovery_expires_at, migration_clock.recorded_at),
  GREATEST(outcome.recovery_expires_at, migration_clock.recorded_at) + interval '30 days',
  outcome.created_at,
  NULL
FROM identity.web_session_completion_outcomes AS outcome
CROSS JOIN migration_clock;

CREATE OR REPLACE FUNCTION identity.guard_web_session_completion_disposition_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = identity, pg_temp
AS $$
BEGIN
  IF NEW.attempt_hash IS DISTINCT FROM OLD.attempt_hash
     OR NEW.challenge_id IS DISTINCT FROM OLD.challenge_id
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.binding_id IS DISTINCT FROM OLD.binding_id
     OR NEW.binding_generation IS DISTINCT FROM OLD.binding_generation
     OR NEW.authority_digest IS DISTINCT FROM OLD.authority_digest
     OR NEW.authority_version IS DISTINCT FROM OLD.authority_version
     OR NEW.authority_kid IS DISTINCT FROM OLD.authority_kid
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
     OR NEW.decision_expires_at IS DISTINCT FROM OLD.decision_expires_at
     OR NEW.retained_until IS DISTINCT FROM OLD.retained_until THEN
    RAISE EXCEPTION 'web session completion disposition authority is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.state = 'pending'
     AND NEW.state = 'accepted'
     AND OLD.accepted_at IS NULL
     AND NEW.accepted_at IS NOT NULL
     AND NEW.discarded_at IS NULL THEN
    RETURN NEW;
  END IF;

  IF OLD.state = 'pending'
     AND NEW.state = 'discarded'
     AND OLD.discarded_at IS NULL
     AND NEW.discarded_at IS NOT NULL
     AND NEW.accepted_at IS NULL THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid web session completion disposition transition'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER trg_web_session_completion_disposition_transition
BEFORE UPDATE ON identity.web_session_completion_dispositions
FOR EACH ROW EXECUTE FUNCTION identity.guard_web_session_completion_disposition_transition();

COMMIT;
