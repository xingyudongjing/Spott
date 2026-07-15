-- REQ-AUTH-001..011, REQ-EVT-001.., REQ-REG-001.., REQ-CHK-001..
BEGIN;

CREATE TABLE identity.users (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  public_handle citext NOT NULL UNIQUE,
  status identity.user_status NOT NULL DEFAULT 'active',
  restriction_flags text[] NOT NULL DEFAULT '{}',
  phone_verified_at timestamptz,
  deletion_requested_at timestamptz,
  deletion_execute_after timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  CHECK (public_handle ~ '^[a-zA-Z0-9_]{3,30}$'),
  CHECK (restriction_flags <@ ARRAY[
    'loginBlocked', 'publishBlocked', 'registerBlocked', 'pointsBlocked', 'commentBlocked'
  ]::text[])
);

CREATE TABLE identity.auth_identities (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES identity.users(id),
  provider identity.identity_provider NOT NULL,
  provider_subject text NOT NULL,
  email_cipher bytea,
  email_hash bytea,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (provider, provider_subject)
);

CREATE TABLE identity.phone_bindings (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES identity.users(id),
  phone_hash bytea NOT NULL,
  phone_cipher bytea NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  unbound_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX uq_active_phone ON identity.phone_bindings(phone_hash) WHERE unbound_at IS NULL;

CREATE TABLE identity.phone_challenges (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  phone_hash bytea NOT NULL,
  phone_cipher bytea NOT NULL,
  otp_hash bytea NOT NULL,
  device_id uuid NOT NULL,
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  expires_at timestamptz NOT NULL,
  suspended_until timestamptz,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE identity.devices (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES identity.users(id),
  platform text NOT NULL CHECK (platform IN ('ios', 'web', 'ops')),
  push_token_cipher bytea,
  risk_state text NOT NULL DEFAULT 'normal' CHECK (risk_state IN ('normal', 'elevated', 'blocked')),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE identity.sessions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES identity.users(id),
  device_id uuid NOT NULL REFERENCES identity.devices(id),
  refresh_hash bytea NOT NULL UNIQUE,
  refresh_family_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  reuse_detected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE identity.profiles (
  user_id uuid PRIMARY KEY REFERENCES identity.users(id),
  nickname varchar(40) NOT NULL,
  avatar_asset_id uuid,
  bio varchar(500) NOT NULL DEFAULT '',
  region_id text,
  birth_range text,
  source_language text NOT NULL DEFAULT 'zh-Hans',
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz
);
CREATE TRIGGER trg_profile_version BEFORE UPDATE ON identity.profiles
FOR EACH ROW EXECUTE FUNCTION spott.touch_version();

CREATE TABLE identity.user_interests (
  user_id uuid NOT NULL REFERENCES identity.users(id),
  tag_id text NOT NULL,
  weight numeric(5,4) NOT NULL DEFAULT 1 CHECK (weight BETWEEN 0 AND 1),
  source text NOT NULL CHECK (source IN ('explicit', 'behavior', 'imported')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, tag_id)
);

CREATE TABLE identity.follows (
  follower_id uuid NOT NULL REFERENCES identity.users(id),
  target_type text NOT NULL CHECK (target_type IN ('user', 'group', 'tag')),
  target_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  PRIMARY KEY (follower_id, target_type, target_id)
);

CREATE TABLE identity.blocks (
  blocker_id uuid NOT NULL REFERENCES identity.users(id),
  blocked_id uuid NOT NULL REFERENCES identity.users(id),
  reason_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

CREATE TABLE events.events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  public_slug citext NOT NULL UNIQUE,
  organizer_id uuid NOT NULL REFERENCES identity.users(id),
  status events.event_status NOT NULL DEFAULT 'draft',
  title varchar(120) NOT NULL,
  description text NOT NULL DEFAULT '',
  category_id text,
  starts_at timestamptz,
  ends_at timestamptz,
  deadline_at timestamptz,
  display_time_zone text NOT NULL DEFAULT 'Asia/Tokyo',
  capacity integer CHECK (capacity BETWEEN 2 AND 500),
  registration_mode text NOT NULL DEFAULT 'automatic'
    CHECK (registration_mode IN ('automatic', 'approval', 'invite_only')),
  waitlist_enabled boolean NOT NULL DEFAULT true,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  created_by uuid REFERENCES identity.users(id),
  updated_by uuid REFERENCES identity.users(id),
  CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at),
  CHECK (deadline_at IS NULL OR starts_at IS NULL OR deadline_at <= starts_at)
);
CREATE TRIGGER trg_event_version BEFORE UPDATE ON events.events
FOR EACH ROW EXECUTE FUNCTION spott.touch_version();

CREATE TABLE events.event_locations (
  event_id uuid PRIMARY KEY REFERENCES events.events(id) ON DELETE CASCADE,
  region_id text NOT NULL,
  public_area varchar(120) NOT NULL,
  exact_address_cipher bytea,
  point geography(Point, 4326),
  visibility text NOT NULL DEFAULT 'confirmed_only'
    CHECK (visibility IN ('public', 'confirmed_only', 'checked_in_only')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ix_event_discovery_geo ON events.event_locations USING gist(point);

CREATE TABLE events.event_media (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  event_id uuid NOT NULL REFERENCES events.events(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL,
  sort_order smallint NOT NULL CHECK (sort_order >= 0),
  focus_x numeric(4,3) NOT NULL DEFAULT 0.5 CHECK (focus_x BETWEEN 0 AND 1),
  focus_y numeric(4,3) NOT NULL DEFAULT 0.5 CHECK (focus_y BETWEEN 0 AND 1),
  moderation_state events.review_state NOT NULL DEFAULT 'unreviewed',
  content_hash bytea,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (event_id, sort_order)
);

CREATE TABLE events.event_fees (
  event_id uuid PRIMARY KEY REFERENCES events.events(id) ON DELETE CASCADE,
  is_free boolean NOT NULL,
  amount_jpy bigint,
  collector_name varchar(120),
  method varchar(120),
  payment_deadline_text varchar(240),
  refund_policy text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (is_free AND amount_jpy IS NULL AND collector_name IS NULL AND method IS NULL)
    OR
    (NOT is_free AND amount_jpy > 0 AND collector_name IS NOT NULL AND method IS NOT NULL
      AND refund_policy IS NOT NULL)
  )
);

CREATE TABLE events.event_risks (
  event_id uuid NOT NULL REFERENCES events.events(id) ON DELETE CASCADE,
  risk_type text NOT NULL,
  declaration text NOT NULL,
  review_state events.review_state NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (event_id, risk_type)
);

CREATE TABLE events.event_questions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  event_id uuid NOT NULL REFERENCES events.events(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('text', 'single_choice', 'multi_choice', 'boolean')),
  label varchar(240) NOT NULL,
  required boolean NOT NULL DEFAULT false,
  options jsonb NOT NULL DEFAULT '[]',
  sort_order smallint NOT NULL CHECK (sort_order >= 0),
  UNIQUE (event_id, sort_order),
  CHECK (jsonb_typeof(options) = 'array')
);

CREATE TABLE events.event_capacity (
  event_id uuid PRIMARY KEY REFERENCES events.events(id) ON DELETE CASCADE,
  confirmed_count integer NOT NULL DEFAULT 0 CHECK (confirmed_count >= 0),
  pending_count integer NOT NULL DEFAULT 0 CHECK (pending_count >= 0),
  waitlist_count integer NOT NULL DEFAULT 0 CHECK (waitlist_count >= 0),
  offered_count integer NOT NULL DEFAULT 0 CHECK (offered_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE events.registrations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  event_id uuid NOT NULL REFERENCES events.events(id),
  user_id uuid NOT NULL REFERENCES identity.users(id),
  status events.registration_status NOT NULL,
  party_size smallint NOT NULL DEFAULT 1 CHECK (party_size BETWEEN 1 AND 10),
  source text NOT NULL DEFAULT 'direct',
  waitlist_joined_at timestamptz,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX uq_active_registration
  ON events.registrations(event_id, user_id)
  WHERE status IN ('pending', 'confirmed', 'waitlisted', 'offered', 'checked_in');
CREATE INDEX ix_waitlist_order
  ON events.registrations(event_id, waitlist_joined_at, id)
  WHERE status = 'waitlisted';
CREATE TRIGGER trg_registration_version BEFORE UPDATE ON events.registrations
FOR EACH ROW EXECUTE FUNCTION spott.touch_version();

CREATE TABLE events.registration_answers (
  registration_id uuid NOT NULL REFERENCES events.registrations(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES events.event_questions(id),
  answer_json jsonb NOT NULL,
  PRIMARY KEY (registration_id, question_id)
);

CREATE TABLE events.waitlist_promotions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  registration_id uuid NOT NULL REFERENCES events.registrations(id),
  offered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  expired_at timestamptz,
  created_by text NOT NULL DEFAULT 'worker',
  CHECK (expires_at > offered_at)
);
CREATE UNIQUE INDEX uq_active_waitlist_offer ON events.waitlist_promotions(registration_id)
WHERE accepted_at IS NULL AND expired_at IS NULL;

CREATE TABLE events.dynamic_checkin_codes (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  event_id uuid NOT NULL REFERENCES events.events(id),
  token_hash bytea NOT NULL UNIQUE,
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (valid_until > valid_from),
  CHECK (valid_until <= valid_from + interval '90 seconds')
);

CREATE TABLE events.checkins (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  event_id uuid NOT NULL REFERENCES events.events(id),
  registration_id uuid NOT NULL UNIQUE REFERENCES events.registrations(id),
  user_id uuid NOT NULL REFERENCES identity.users(id),
  method text NOT NULL CHECK (method IN ('dynamic_qr', 'host_manual', 'offline_replay', 'correction')),
  checked_in_at timestamptz NOT NULL,
  device_recorded_at timestamptz,
  operator_id uuid REFERENCES identity.users(id),
  operation_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE events.attendance_corrections (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  checkin_id uuid REFERENCES events.checkins(id),
  registration_id uuid NOT NULL REFERENCES events.registrations(id),
  requested_by uuid NOT NULL REFERENCES identity.users(id),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by uuid REFERENCES identity.users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX ix_event_title_trgm ON events.events USING gin(title gin_trgm_ops);
CREATE INDEX ix_event_discovery_time ON events.events(status, starts_at, id)
WHERE status IN ('published', 'registration_closed', 'in_progress');

COMMIT;
