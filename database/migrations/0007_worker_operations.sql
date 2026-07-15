-- REQ-NOTIF-001.., REQ-OPS-001.., REQ-OBS-001.., REQ-SEC-001..
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_delivery_channel
  ON notification.deliveries(notification_id, channel);

CREATE TABLE IF NOT EXISTS notification.device_tokens (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES identity.users(id),
  device_id uuid REFERENCES identity.devices(id),
  platform text NOT NULL CHECK (platform IN ('ios', 'web')),
  token_cipher bytea NOT NULL,
  token_hash bytea NOT NULL UNIQUE,
  environment text NOT NULL DEFAULT 'production'
    CHECK (environment IN ('sandbox', 'production')),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  disabled_at timestamptz,
  disable_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS ix_device_tokens_user_active
  ON notification.device_tokens(user_id, platform) WHERE disabled_at IS NULL;

CREATE TABLE IF NOT EXISTS sync.dead_letter_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  outbox_event_id uuid NOT NULL UNIQUE,
  aggregate text NOT NULL,
  aggregate_id uuid NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  attempt_count integer NOT NULL,
  last_error text NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES admin.admin_users(id),
  resolution text,
  CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE IF NOT EXISTS admin.reconciliation_cases (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  kind text NOT NULL CHECK (kind IN ('ledger_imbalance','wallet_mismatch','store_order_gap','delivery_backlog')),
  severity text NOT NULL CHECK (severity IN ('p0','p1','p2')),
  fingerprint text NOT NULL,
  details jsonb NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','investigating','resolved','false_positive')),
  first_detected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_detected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  UNIQUE (kind, fingerprint),
  CHECK (jsonb_typeof(details) = 'object')
);

CREATE TABLE IF NOT EXISTS admin.worker_runs (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  worker_id text NOT NULL,
  job_name text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed')),
  processed_count integer NOT NULL DEFAULT 0,
  error_code text,
  duration_ms integer,
  metadata jsonb NOT NULL DEFAULT '{}',
  CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX IF NOT EXISTS ix_worker_runs_job_started
  ON admin.worker_runs(job_name, started_at DESC);

CREATE TABLE IF NOT EXISTS analytics.product_events (
  id uuid NOT NULL DEFAULT uuidv7(),
  event_name text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  anonymous_id uuid,
  user_id uuid REFERENCES identity.users(id),
  session_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('ios','web','ops','server')),
  properties jsonb NOT NULL DEFAULT '{}',
  trace_id text,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (id, received_at),
  CHECK (jsonb_typeof(properties) = 'object')
) PARTITION BY RANGE (received_at);
CREATE TABLE IF NOT EXISTS analytics.product_events_default
  PARTITION OF analytics.product_events DEFAULT;
CREATE INDEX IF NOT EXISTS ix_product_events_name_time
  ON analytics.product_events_default(event_name, occurred_at DESC);

COMMIT;
