-- REQ-GRP-001.., REQ-PTS-001.., REQ-SAFE-001.., REQ-ADM-001..
BEGIN;

CREATE TABLE community.groups (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  owner_id uuid NOT NULL REFERENCES identity.users(id),
  name varchar(80) NOT NULL,
  slug citext NOT NULL UNIQUE,
  description varchar(1000) NOT NULL DEFAULT '',
  join_mode text NOT NULL DEFAULT 'open' CHECK (join_mode IN ('open', 'approval', 'invite_only')),
  capacity integer NOT NULL DEFAULT 50 CHECK (capacity BETWEEN 50 AND 5000 AND capacity % 50 = 0),
  status community.group_status NOT NULL DEFAULT 'active',
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz
);
CREATE TRIGGER trg_group_version BEFORE UPDATE ON community.groups
FOR EACH ROW EXECUTE FUNCTION spott.touch_version();

CREATE TABLE community.group_memberships (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  group_id uuid NOT NULL REFERENCES community.groups(id),
  user_id uuid NOT NULL REFERENCES identity.users(id),
  role community.group_role NOT NULL DEFAULT 'member',
  status community.membership_status NOT NULL DEFAULT 'active',
  joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (group_id, user_id)
);
CREATE INDEX ix_group_members_active ON community.group_memberships(group_id, joined_at, id)
WHERE status IN ('active', 'muted');

CREATE TABLE community.group_admin_grants (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  group_id uuid NOT NULL REFERENCES community.groups(id),
  user_id uuid NOT NULL REFERENCES identity.users(id),
  granted_by uuid NOT NULL REFERENCES identity.users(id),
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX uq_active_group_admin ON community.group_admin_grants(group_id, user_id)
WHERE revoked_at IS NULL;

CREATE TABLE community.announcements (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  group_id uuid NOT NULL REFERENCES community.groups(id),
  author_id uuid NOT NULL REFERENCES identity.users(id),
  body varchar(4000) NOT NULL,
  visibility text NOT NULL DEFAULT 'members' CHECK (visibility IN ('public', 'members')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz
);
CREATE TRIGGER trg_announcement_version BEFORE UPDATE ON community.announcements
FOR EACH ROW EXECUTE FUNCTION spott.touch_version();

CREATE TABLE community.comments (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  target_type text NOT NULL CHECK (target_type IN ('event', 'group', 'announcement')),
  target_id uuid NOT NULL,
  author_id uuid NOT NULL REFERENCES identity.users(id),
  body varchar(2000) NOT NULL,
  status text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'hidden', 'removed')),
  source_language text NOT NULL DEFAULT 'zh-Hans',
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz
);
CREATE TRIGGER trg_comment_version BEFORE UPDATE ON community.comments
FOR EACH ROW EXECUTE FUNCTION spott.touch_version();

CREATE TABLE community.group_transfers (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  group_id uuid NOT NULL REFERENCES community.groups(id),
  from_user uuid NOT NULL REFERENCES identity.users(id),
  to_user uuid NOT NULL REFERENCES identity.users(id),
  state text NOT NULL DEFAULT 'awaiting_target'
    CHECK (state IN ('awaiting_target', 'cooling_off', 'completed', 'cancelled', 'expired')),
  from_confirmed_at timestamptz,
  to_confirmed_at timestamptz,
  cooldown_until timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (from_user <> to_user)
);
CREATE UNIQUE INDEX uq_active_group_transfer ON community.group_transfers(group_id)
WHERE state IN ('awaiting_target', 'cooling_off');

CREATE TABLE commerce.wallets (
  user_id uuid PRIMARY KEY REFERENCES identity.users(id),
  paid_balance bigint NOT NULL DEFAULT 0,
  free_balance bigint NOT NULL DEFAULT 0,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (free_balance >= 0)
);
CREATE TRIGGER trg_wallet_version BEFORE UPDATE ON commerce.wallets
FOR EACH ROW EXECUTE FUNCTION spott.touch_version();

CREATE TABLE commerce.point_transactions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES identity.users(id),
  type text NOT NULL,
  business_key text NOT NULL,
  status commerce.transaction_status NOT NULL DEFAULT 'pending',
  reversal_of uuid REFERENCES commerce.point_transactions(id),
  metadata jsonb NOT NULL DEFAULT '{}',
  posted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (user_id, business_key),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE TABLE commerce.point_entries (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  transaction_id uuid NOT NULL REFERENCES commerce.point_transactions(id),
  account_code text NOT NULL,
  bucket commerce.point_bucket NOT NULL,
  amount bigint NOT NULL CHECK (amount <> 0),
  expires_at timestamptz,
  source_lot_id uuid REFERENCES commerce.point_entries(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ix_point_entries_transaction ON commerce.point_entries(transaction_id);
CREATE INDEX ix_point_lot_expiry ON commerce.point_entries(expires_at, id)
WHERE bucket = 'free' AND amount > 0 AND expires_at IS NOT NULL;

CREATE OR REPLACE FUNCTION commerce.assert_transaction_balanced()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  transaction_to_check uuid;
  imbalance bigint;
BEGIN
  transaction_to_check := COALESCE(NEW.transaction_id, OLD.transaction_id);
  SELECT COALESCE(sum(amount), 0) INTO imbalance
  FROM commerce.point_entries
  WHERE transaction_id = transaction_to_check;
  IF imbalance <> 0 THEN
    RAISE EXCEPTION 'point transaction % is unbalanced by %', transaction_to_check, imbalance
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_point_entries_balanced
AFTER INSERT ON commerce.point_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION commerce.assert_transaction_balanced();
CREATE TRIGGER trg_point_entries_immutable
BEFORE UPDATE OR DELETE ON commerce.point_entries
FOR EACH ROW EXECUTE FUNCTION spott.prevent_mutation();

CREATE TABLE commerce.point_holds (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES identity.users(id),
  business_key text NOT NULL,
  bucket_allocations jsonb NOT NULL,
  total_amount bigint NOT NULL CHECK (total_amount > 0),
  expires_at timestamptz NOT NULL,
  state commerce.hold_state NOT NULL DEFAULT 'active',
  transaction_id uuid REFERENCES commerce.point_transactions(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (user_id, business_key),
  CHECK (jsonb_typeof(bucket_allocations) = 'array')
);

CREATE TABLE commerce.store_products (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  store text NOT NULL CHECK (store IN ('apple')),
  product_id text NOT NULL,
  points bigint NOT NULL CHECK (points > 0),
  bonus_points bigint NOT NULL DEFAULT 0 CHECK (bonus_points >= 0),
  active_from timestamptz NOT NULL,
  active_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (store, product_id),
  CHECK (active_until IS NULL OR active_until > active_from)
);

CREATE TABLE commerce.store_orders (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES identity.users(id),
  store text NOT NULL CHECK (store = 'apple'),
  product_id text NOT NULL,
  transaction_id text NOT NULL,
  original_transaction_id text NOT NULL,
  signed_payload_hash bytea NOT NULL,
  state text NOT NULL CHECK (state IN ('verified', 'credited', 'refunded', 'revoked', 'failed')),
  points_transaction_id uuid REFERENCES commerce.point_transactions(id),
  purchased_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (store, transaction_id)
);

CREATE TABLE commerce.refunds (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  order_id uuid NOT NULL REFERENCES commerce.store_orders(id),
  store_event_id text NOT NULL UNIQUE,
  points_reversed bigint NOT NULL CHECK (points_reversed >= 0),
  state text NOT NULL CHECK (state IN ('received', 'posted', 'failed')),
  reversal_transaction_id uuid REFERENCES commerce.point_transactions(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE community.group_capacity_purchases (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  group_id uuid NOT NULL REFERENCES community.groups(id),
  points_transaction_id uuid NOT NULL UNIQUE REFERENCES commerce.point_transactions(id),
  before_capacity integer NOT NULL,
  after_capacity integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (after_capacity > before_capacity),
  CHECK ((after_capacity - before_capacity) % 50 = 0)
);

CREATE TABLE community.achievement_definitions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  code text NOT NULL,
  audience text NOT NULL CHECK (audience IN ('participant', 'host', 'community')),
  rule_version integer NOT NULL CHECK (rule_version > 0),
  rule_json jsonb NOT NULL,
  visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  active_from timestamptz NOT NULL,
  active_until timestamptz,
  UNIQUE (code, rule_version)
);

CREATE TABLE community.achievement_awards (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES identity.users(id),
  definition_id uuid NOT NULL REFERENCES community.achievement_definitions(id),
  awarded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  evidence_ref jsonb NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX uq_active_achievement_award
ON community.achievement_awards(user_id, definition_id) WHERE revoked_at IS NULL;

CREATE TABLE safety.reports (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  public_reference text NOT NULL UNIQUE,
  reporter_id uuid REFERENCES identity.users(id),
  target_type text NOT NULL CHECK (target_type IN ('event', 'group', 'user', 'comment', 'announcement')),
  target_id uuid NOT NULL,
  reason text NOT NULL,
  details_cipher bytea,
  severity safety.severity NOT NULL,
  status safety.case_status NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE safety.evidence_assets (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  report_id uuid NOT NULL REFERENCES safety.reports(id),
  asset_id uuid NOT NULL,
  kms_key_ref text NOT NULL,
  content_hash bytea NOT NULL,
  retention_until timestamptz NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE safety.moderation_cases (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  report_id uuid NOT NULL UNIQUE REFERENCES safety.reports(id),
  assignee_id uuid,
  status safety.case_status NOT NULL DEFAULT 'open',
  sla_due_at timestamptz NOT NULL,
  decision text,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER trg_moderation_case_version BEFORE UPDATE ON safety.moderation_cases
FOR EACH ROW EXECUTE FUNCTION spott.touch_version();

CREATE TABLE safety.moderation_actions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  case_id uuid NOT NULL REFERENCES safety.moderation_cases(id),
  actor_id uuid NOT NULL,
  action_type text NOT NULL,
  subject_id uuid NOT NULL,
  reason text NOT NULL,
  before_json jsonb NOT NULL,
  after_json jsonb NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER trg_moderation_action_immutable
BEFORE UPDATE OR DELETE ON safety.moderation_actions
FOR EACH ROW EXECUTE FUNCTION spott.prevent_mutation();

CREATE TABLE safety.appeals (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  case_id uuid NOT NULL REFERENCES safety.moderation_cases(id),
  appellant_id uuid NOT NULL REFERENCES identity.users(id),
  statement text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE notification.notifications (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES identity.users(id),
  type text NOT NULL,
  template_version integer NOT NULL,
  payload_ref jsonb NOT NULL,
  resource_type text,
  resource_public_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  read_at timestamptz,
  CHECK (jsonb_typeof(payload_ref) = 'object')
);
CREATE INDEX ix_notifications_unread ON notification.notifications(user_id, created_at DESC, id)
WHERE read_at IS NULL;

CREATE TABLE notification.preferences (
  user_id uuid NOT NULL REFERENCES identity.users(id),
  notification_type text NOT NULL,
  in_app boolean NOT NULL DEFAULT true,
  push boolean NOT NULL DEFAULT true,
  email boolean NOT NULL DEFAULT false,
  quiet_hours tstzrange,
  locale text NOT NULL DEFAULT 'zh-Hans',
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, notification_type)
);

CREATE TABLE notification.deliveries (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  notification_id uuid NOT NULL REFERENCES notification.notifications(id),
  channel text NOT NULL CHECK (channel IN ('in_app', 'push', 'email', 'sms')),
  provider_id text,
  state notification.delivery_state NOT NULL DEFAULT 'queued',
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX uq_delivery_provider ON notification.deliveries(channel, provider_id)
WHERE provider_id IS NOT NULL;

CREATE TABLE admin.admin_users (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  identity_user_id uuid NOT NULL UNIQUE REFERENCES identity.users(id),
  roles text[] NOT NULL,
  data_scopes text[] NOT NULL DEFAULT '{}',
  mfa_enrolled_at timestamptz NOT NULL,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE admin.feature_flag_revisions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  key text NOT NULL,
  scope text NOT NULL DEFAULT 'global',
  rules_json jsonb NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'approved', 'active', 'superseded', 'rejected')),
  submitted_by uuid NOT NULL REFERENCES admin.admin_users(id),
  approved_by uuid REFERENCES admin.admin_users(id),
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (key, scope, version),
  CHECK (approved_by IS NULL OR approved_by <> submitted_by),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);

CREATE TABLE admin.config_revisions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  key text NOT NULL,
  value_json jsonb NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  audience jsonb NOT NULL DEFAULT '{}',
  region text,
  min_app_version text,
  effective_from timestamptz,
  effective_to timestamptz,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'approved', 'active', 'superseded', 'rejected')),
  submitted_by uuid NOT NULL REFERENCES admin.admin_users(id),
  approved_by uuid REFERENCES admin.admin_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (key, version),
  CHECK (approved_by IS NULL OR approved_by <> submitted_by)
);

CREATE TABLE admin.approvals (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  resource_type text NOT NULL,
  resource_id uuid NOT NULL,
  submitted_by uuid NOT NULL REFERENCES admin.admin_users(id),
  approved_by uuid REFERENCES admin.admin_users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'executed')),
  purpose text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  CHECK (approved_by IS NULL OR approved_by <> submitted_by)
);

CREATE TABLE admin.audit_logs (
  id uuid NOT NULL DEFAULT uuidv7(),
  actor_id uuid,
  action text NOT NULL,
  resource text NOT NULL,
  resource_id text,
  purpose text,
  before_hash bytea,
  after_hash bytea,
  ip inet,
  trace_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE TABLE admin.audit_logs_default PARTITION OF admin.audit_logs DEFAULT;
CREATE TRIGGER trg_audit_logs_immutable
BEFORE UPDATE OR DELETE ON admin.audit_logs_default
FOR EACH ROW EXECUTE FUNCTION spott.prevent_mutation();

CREATE TABLE admin.exports (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  requested_by uuid NOT NULL REFERENCES admin.admin_users(id),
  approved_by uuid REFERENCES admin.admin_users(id),
  purpose text NOT NULL,
  object_key text,
  watermark text NOT NULL,
  expires_at timestamptz NOT NULL,
  max_downloads integer NOT NULL DEFAULT 1 CHECK (max_downloads BETWEEN 1 AND 5),
  download_count integer NOT NULL DEFAULT 0 CHECK (download_count >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (approved_by IS NULL OR approved_by <> requested_by)
);

COMMIT;
