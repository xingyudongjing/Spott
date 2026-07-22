BEGIN;

DROP TRIGGER trg_web_session_completion_disposition_transition
ON identity.web_session_completion_dispositions;

UPDATE identity.web_session_completion_dispositions
SET retained_until = decision_expires_at + interval '31 days'
WHERE authority_version = 'v1'
  AND retained_until = decision_expires_at + interval '30 days';

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
