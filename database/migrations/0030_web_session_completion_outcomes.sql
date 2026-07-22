BEGIN;

CREATE TABLE identity.web_session_completion_outcomes (
  challenge_id uuid PRIMARY KEY
    REFERENCES identity.email_challenges(id) ON DELETE RESTRICT,
  attempt_hash bytea NOT NULL UNIQUE
    CHECK (octet_length(attempt_hash) = 32),
  request_digest bytea NOT NULL
    CHECK (octet_length(request_digest) = 32),
  user_id uuid NOT NULL REFERENCES identity.users(id),
  device_id uuid NOT NULL REFERENCES identity.devices(id),
  session_id uuid NOT NULL UNIQUE
    REFERENCES identity.sessions(id) ON DELETE CASCADE,
  family_id uuid NOT NULL,
  binding_id uuid NOT NULL UNIQUE
    REFERENCES identity.device_bindings(id) ON DELETE CASCADE,
  refresh_generation bigint NOT NULL
    CHECK (refresh_generation = 0),
  binding_generation bigint NOT NULL
    CHECK (binding_generation = 0),
  derivation_version text NOT NULL
    CHECK (derivation_version = 'v1'),
  derivation_kid text NOT NULL
    CHECK (derivation_kid ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  recovery_expires_at timestamptz NOT NULL,
  CHECK (
    recovery_expires_at > created_at
    AND recovery_expires_at <= created_at + interval '15 minutes'
  )
);

CREATE INDEX ix_web_session_completion_outcomes_recovery_expiry
  ON identity.web_session_completion_outcomes(recovery_expires_at);

CREATE INDEX ix_email_challenges_cleanup_verified
  ON identity.email_challenges(verified_at, id)
  WHERE verified_at IS NOT NULL;

CREATE INDEX ix_email_challenges_cleanup_expired_unverified
  ON identity.email_challenges(expires_at, id)
  WHERE verified_at IS NULL;

CREATE OR REPLACE FUNCTION identity.reject_web_session_completion_outcome_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = identity, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'web session completion outcomes are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER trg_web_session_completion_outcome_immutable
BEFORE UPDATE ON identity.web_session_completion_outcomes
FOR EACH ROW EXECUTE FUNCTION identity.reject_web_session_completion_outcome_update();

COMMIT;
