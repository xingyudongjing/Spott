-- REQ-EVT-IMG, REQ-ACH-001.., REQ-SHR-001.., REQ-GRP-MGMT, REQ-ADM-EXPORT
BEGIN;

CREATE SCHEMA IF NOT EXISTS media;

CREATE TABLE media.assets (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  owner_id uuid NOT NULL REFERENCES identity.users(id),
  purpose text NOT NULL CHECK (purpose IN ('event_cover','profile_avatar','group_cover','report_evidence','share_poster')),
  object_key text NOT NULL UNIQUE,
  original_filename varchar(255),
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp','image/heic')),
  byte_size bigint NOT NULL CHECK (byte_size BETWEEN 1 AND 20971520),
  content_hash bytea,
  focal_x real NOT NULL DEFAULT 0.5 CHECK (focal_x BETWEEN 0 AND 1),
  focal_y real NOT NULL DEFAULT 0.5 CHECK (focal_y BETWEEN 0 AND 1),
  state text NOT NULL DEFAULT 'pending_upload'
    CHECK (state IN ('pending_upload','uploaded','processing','ready','rejected','deleted')),
  moderation_state text NOT NULL DEFAULT 'pending'
    CHECK (moderation_state IN ('pending','approved','rejected')),
  derivatives jsonb NOT NULL DEFAULT '{}',
  uploaded_at timestamptz,
  ready_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (jsonb_typeof(derivatives) = 'object')
);
CREATE INDEX ix_media_assets_owner ON media.assets(owner_id, created_at DESC);
CREATE INDEX ix_media_assets_processing ON media.assets(state, created_at)
  WHERE state IN ('uploaded','processing');

CREATE TABLE community.feedback (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  registration_id uuid NOT NULL UNIQUE REFERENCES events.registrations(id),
  event_id uuid NOT NULL REFERENCES events.events(id),
  author_id uuid NOT NULL REFERENCES identity.users(id),
  attendance_rating smallint NOT NULL CHECK (attendance_rating BETWEEN 1 AND 5),
  tags text[] NOT NULL DEFAULT '{}',
  comment varchar(2000),
  visibility text NOT NULL DEFAULT 'aggregate_only'
    CHECK (visibility IN ('private','aggregate_only','public')),
  moderation_state text NOT NULL DEFAULT 'pending'
    CHECK (moderation_state IN ('pending','approved','rejected')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ix_feedback_event ON community.feedback(event_id, created_at DESC);

CREATE TABLE growth.poster_jobs (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES identity.users(id),
  resource_type text NOT NULL CHECK (resource_type IN ('event','group','profile')),
  resource_id uuid NOT NULL,
  template text NOT NULL DEFAULT 'tokyo_afterglow',
  locale text NOT NULL DEFAULT 'zh-Hans',
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','processing','ready','failed')),
  asset_id uuid REFERENCES media.assets(id),
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ix_poster_jobs_ready ON growth.poster_jobs(state, created_at)
  WHERE state IN ('queued','processing');

CREATE TABLE analytics.consents (
  user_id uuid NOT NULL REFERENCES identity.users(id),
  purpose text NOT NULL CHECK (purpose IN ('essential','product_analytics','marketing','personalization')),
  granted boolean NOT NULL,
  policy_version text NOT NULL,
  source text NOT NULL CHECK (source IN ('ios','web','ops','support')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, purpose)
);

CREATE TABLE admin.point_adjustment_requests (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  target_user_id uuid NOT NULL REFERENCES identity.users(id),
  bucket commerce.point_bucket NOT NULL,
  amount bigint NOT NULL CHECK (amount <> 0),
  reason text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected','executed','failed')),
  requested_by uuid NOT NULL REFERENCES admin.admin_users(id),
  approved_by uuid REFERENCES admin.admin_users(id),
  points_transaction_id uuid REFERENCES commerce.point_transactions(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  executed_at timestamptz,
  CHECK (approved_by IS NULL OR approved_by <> requested_by)
);

ALTER TABLE events.event_media
  ADD COLUMN IF NOT EXISTS media_asset_id uuid REFERENCES media.assets(id);

INSERT INTO community.achievement_definitions(code, audience, rule_version, rule_json, visibility, active_from)
VALUES
  ('first_checkin', 'participant', 1, '{"metric":"checked_in_count","gte":1}', 'public', clock_timestamp()),
  ('city_explorer_5', 'participant', 1, '{"metric":"checked_in_count","gte":5}', 'public', clock_timestamp()),
  ('first_hosted_event', 'host', 1, '{"metric":"hosted_ended_count","gte":1}', 'public', clock_timestamp()),
  ('community_builder', 'community', 1, '{"metric":"owned_group_members","gte":10}', 'public', clock_timestamp())
ON CONFLICT (code, rule_version) DO NOTHING;

COMMIT;
