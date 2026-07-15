-- Supporting aggregates referenced by the public contract.
BEGIN;

CREATE TABLE identity.email_challenges (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  email_hash bytea NOT NULL,
  email_cipher bytea NOT NULL,
  code_hash bytea NOT NULL,
  device_id uuid NOT NULL,
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ix_email_challenges_hash_created ON identity.email_challenges(email_hash, created_at DESC);

CREATE TABLE identity.account_merge_jobs (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  source_user_id uuid NOT NULL REFERENCES identity.users(id),
  target_user_id uuid NOT NULL REFERENCES identity.users(id),
  preview_json jsonb NOT NULL,
  state text NOT NULL DEFAULT 'previewed' CHECK (state IN ('previewed', 'committed', 'expired', 'failed')),
  expires_at timestamptz NOT NULL,
  committed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (source_user_id <> target_user_id)
);

CREATE TABLE events.event_favorites (
  user_id uuid NOT NULL REFERENCES identity.users(id),
  event_id uuid NOT NULL REFERENCES events.events(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  PRIMARY KEY (user_id, event_id)
);

CREATE TABLE events.event_revisions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  event_id uuid NOT NULL REFERENCES events.events(id),
  base_version bigint NOT NULL,
  new_version bigint NOT NULL,
  changed_fields text[] NOT NULL,
  before_json jsonb NOT NULL,
  after_json jsonb NOT NULL,
  impact_summary text,
  created_by uuid NOT NULL REFERENCES identity.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (new_version > base_version)
);

CREATE TABLE commerce.quotes (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES identity.users(id),
  purpose text NOT NULL,
  resource_id uuid,
  amount bigint NOT NULL CHECK (amount >= 0),
  currency text NOT NULL CHECK (currency IN ('POINTS', 'JPY')),
  config_versions jsonb NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > created_at)
);
CREATE INDEX ix_quotes_active ON commerce.quotes(user_id, purpose, expires_at)
WHERE consumed_at IS NULL;

CREATE TABLE notification.templates (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  type text NOT NULL,
  locale text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  title_template text NOT NULL,
  body_template text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (type, locale, version)
);

CREATE TABLE admin.sensitive_access_logs (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  admin_user_id uuid NOT NULL REFERENCES admin.admin_users(id),
  resource_type text NOT NULL,
  resource_id uuid NOT NULL,
  field_names text[] NOT NULL,
  purpose text NOT NULL,
  ip inet,
  trace_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER trg_sensitive_access_immutable
BEFORE UPDATE OR DELETE ON admin.sensitive_access_logs
FOR EACH ROW EXECUTE FUNCTION spott.prevent_mutation();

COMMIT;
