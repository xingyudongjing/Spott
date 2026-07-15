-- REQ-SYNC-001.., REQ-SHR-001.., REQ-DATA-001.., defense in depth
BEGIN;

CREATE SEQUENCE sync.global_change_seq AS bigint;

CREATE TABLE sync.change_log (
  seq bigint PRIMARY KEY DEFAULT nextval('sync.global_change_seq'),
  user_scope uuid,
  topic text,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  operation sync.change_operation NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  changed_fields text[] NOT NULL DEFAULT '{}',
  payload jsonb NOT NULL DEFAULT '{}',
  visibility_scope text NOT NULL DEFAULT 'user'
    CHECK (visibility_scope IN ('public', 'user', 'sensitive')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ix_change_log_user_seq ON sync.change_log(user_scope, seq);
CREATE INDEX ix_change_log_topic_seq ON sync.change_log(topic, seq);
CREATE INDEX ix_change_log_created_at ON sync.change_log(created_at);

CREATE TABLE sync.outbox_events (
  event_id uuid PRIMARY KEY DEFAULT uuidv7(),
  aggregate text NOT NULL,
  aggregate_id uuid NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  locked_at timestamptz,
  locked_by text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  published_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (jsonb_typeof(payload) = 'object')
);
CREATE INDEX ix_outbox_ready ON sync.outbox_events(available_at, created_at)
WHERE published_at IS NULL;

CREATE TABLE sync.idempotency_keys (
  key uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  request_hash bytea NOT NULL,
  response_code integer,
  response_body jsonb,
  resource_type text,
  resource_id uuid,
  locked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, key),
  CHECK (response_code IS NULL OR response_code BETWEEN 100 AND 599)
);
CREATE INDEX ix_idempotency_expiry ON sync.idempotency_keys(expires_at);

CREATE TABLE sync.device_cursors (
  device_id uuid NOT NULL REFERENCES identity.devices(id),
  user_id uuid NOT NULL REFERENCES identity.users(id),
  cursor bigint NOT NULL DEFAULT 0 CHECK (cursor >= 0),
  last_synced_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (device_id, user_id)
);

CREATE TABLE sync.pending_operations (
  operation_id uuid PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES identity.devices(id),
  user_id uuid NOT NULL REFERENCES identity.users(id),
  entity_type text NOT NULL,
  entity_id uuid,
  action text NOT NULL,
  base_version bigint,
  request_hash bytea NOT NULL,
  state text NOT NULL CHECK (state IN ('received', 'applied', 'conflict', 'failed')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE growth.share_links (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  public_code text NOT NULL UNIQUE,
  resource_type text NOT NULL CHECK (resource_type IN ('event', 'group', 'profile')),
  resource_id uuid NOT NULL,
  creator_id uuid REFERENCES identity.users(id),
  campaign text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz,
  disabled_at timestamptz
);

CREATE TABLE growth.attributions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  share_link_id uuid REFERENCES growth.share_links(id),
  anonymous_user_id uuid,
  user_id uuid REFERENCES identity.users(id),
  session_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('opened', 'registered', 'checked_in')),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE analytics.events (
  id uuid NOT NULL DEFAULT uuidv7(),
  event_name text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  anonymous_user_id uuid,
  user_id uuid,
  session_id uuid NOT NULL,
  device_id uuid NOT NULL,
  platform text NOT NULL,
  app_version text NOT NULL,
  trace_id text NOT NULL,
  properties jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (id, received_at)
) PARTITION BY RANGE (received_at);
CREATE TABLE analytics.events_default PARTITION OF analytics.events DEFAULT;

-- Restricted/admin tables use RLS as defense in depth. The API still performs policy checks.
ALTER TABLE safety.evidence_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin.exports ENABLE ROW LEVEL SECURITY;

CREATE POLICY evidence_deny_by_default ON safety.evidence_assets USING (false);
CREATE POLICY audit_deny_by_default ON admin.audit_logs USING (false);
CREATE POLICY export_deny_by_default ON admin.exports USING (false);

CREATE OR REPLACE FUNCTION sync.record_change(
  p_user_scope uuid,
  p_topic text,
  p_entity_type text,
  p_entity_id uuid,
  p_operation sync.change_operation,
  p_version bigint,
  p_changed_fields text[],
  p_payload jsonb,
  p_visibility_scope text DEFAULT 'user'
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = sync, pg_temp
AS $$
DECLARE
  new_seq bigint;
BEGIN
  INSERT INTO sync.change_log(
    user_scope, topic, entity_type, entity_id, operation, version,
    changed_fields, payload, visibility_scope
  ) VALUES (
    p_user_scope, p_topic, p_entity_type, p_entity_id, p_operation, p_version,
    p_changed_fields, p_payload, p_visibility_scope
  ) RETURNING seq INTO new_seq;
  RETURN new_seq;
END;
$$;

COMMIT;
