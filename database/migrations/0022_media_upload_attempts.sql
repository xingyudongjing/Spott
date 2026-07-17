-- Recoverable media upload attempts, lifetime receipts, and fenced cleanup.
BEGIN;

ALTER TABLE media.assets RENAME COLUMN owner_id TO current_owner_id;
ALTER TABLE media.assets RENAME CONSTRAINT assets_owner_id_fkey TO assets_current_owner_id_fkey;
ALTER INDEX media.ix_media_assets_owner RENAME TO ix_media_assets_current_owner;

ALTER TABLE media.assets RENAME COLUMN object_key TO legacy_preallocated_object_key;
ALTER TABLE media.assets
  RENAME CONSTRAINT assets_object_key_key TO assets_legacy_preallocated_object_key_key;
ALTER TABLE media.assets ALTER COLUMN legacy_preallocated_object_key DROP NOT NULL;

ALTER TABLE media.assets
  ADD COLUMN created_owner_id uuid,
  ADD COLUMN authoritative_object_key text,
  ADD COLUMN authoritative_object_version text,
  ADD COLUMN authoritative_object_checksum bytea,
  ADD COLUMN legacy_object_reconciliation_required boolean NOT NULL DEFAULT false,
  ADD COLUMN legacy_object_reconciled_at timestamptz,
  ADD COLUMN legacy_object_reconciliation_error text,
  ADD COLUMN upload_attempt_id uuid,
  ADD COLUMN intent_request_hash bytea,
  ADD COLUMN expected_content_hash bytea,
  ADD COLUMN capability_generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN latest_authorization_expires_at timestamptz,
  ADD COLUMN authorization_clock_skew interval NOT NULL DEFAULT interval '5 minutes',
  ADD COLUMN renewal_disabled_at timestamptz,
  ADD COLUMN cleanup_not_before timestamptz,
  ADD COLUMN abandoned_at timestamptz,
  ADD COLUMN tombstoned_at timestamptz,
  ADD COLUMN cleanup_verified_at timestamptz,
  ADD COLUMN row_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN processing_generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN processing_lease_id uuid,
  ADD COLUMN processing_lease_expires_at timestamptz;

UPDATE media.assets
SET created_owner_id = current_owner_id,
    authoritative_object_key = CASE
      WHEN state IN ('uploaded', 'processing', 'ready', 'rejected')
        THEN legacy_preallocated_object_key
      ELSE NULL
    END,
    legacy_object_reconciliation_required =
      state IN ('uploaded', 'processing', 'ready', 'rejected'),
    renewal_disabled_at = CASE
      WHEN state = 'deleted' THEN COALESCE(deleted_at, clock_timestamp())
      ELSE renewal_disabled_at
    END,
    tombstoned_at = CASE
      WHEN state = 'deleted' THEN COALESCE(deleted_at, clock_timestamp())
      ELSE tombstoned_at
    END,
    cleanup_not_before = CASE
      WHEN state = 'deleted' THEN COALESCE(deleted_at, clock_timestamp())
      ELSE cleanup_not_before
    END,
    processing_generation = 0,
    row_version = 0;

CREATE TABLE media.legacy_asset_content_hash_quarantine (
  asset_id uuid PRIMARY KEY REFERENCES media.assets(id),
  original_content_hash bytea NOT NULL,
  original_state text NOT NULL,
  original_updated_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (reason = 'invalid_content_hash_length'),
  quarantined_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO media.legacy_asset_content_hash_quarantine(
  asset_id,
  original_content_hash,
  original_state,
  original_updated_at,
  reason
)
SELECT asset.id,
       asset.content_hash,
       asset.state,
       asset.updated_at,
       'invalid_content_hash_length'
FROM media.assets asset
WHERE asset.content_hash IS NOT NULL
  AND octet_length(asset.content_hash) <> 32;

UPDATE media.assets asset
SET content_hash = NULL,
    updated_at = clock_timestamp()
FROM media.legacy_asset_content_hash_quarantine quarantine
WHERE quarantine.asset_id = asset.id;

ALTER TABLE media.legacy_asset_content_hash_quarantine ENABLE ROW LEVEL SECURITY;
ALTER TABLE media.legacy_asset_content_hash_quarantine FORCE ROW LEVEL SECURITY;
CREATE POLICY legacy_asset_content_hash_quarantine_deny_by_default
  ON media.legacy_asset_content_hash_quarantine USING (false);
CREATE TRIGGER trg_legacy_asset_content_hash_quarantine_immutable
BEFORE UPDATE OR DELETE ON media.legacy_asset_content_hash_quarantine
FOR EACH ROW EXECUTE FUNCTION spott.prevent_mutation();

ALTER TABLE media.assets
  ALTER COLUMN created_owner_id SET NOT NULL,
  ADD CONSTRAINT assets_created_owner_id_fkey
    FOREIGN KEY (created_owner_id) REFERENCES identity.users(id),
  ADD CONSTRAINT assets_expected_content_hash_check
    CHECK (expected_content_hash IS NULL OR octet_length(expected_content_hash) = 32),
  ADD CONSTRAINT assets_intent_request_hash_check
    CHECK (intent_request_hash IS NULL OR octet_length(intent_request_hash) = 32),
  ADD CONSTRAINT assets_content_hash_check
    CHECK (content_hash IS NULL OR octet_length(content_hash) = 32),
  ADD CONSTRAINT assets_authoritative_object_checksum_check
    CHECK (
      authoritative_object_checksum IS NULL
      OR octet_length(authoritative_object_checksum) = 32
    ),
  ADD CONSTRAINT assets_attempt_binding_check
    CHECK (
      (upload_attempt_id IS NULL AND intent_request_hash IS NULL AND expected_content_hash IS NULL)
      OR
      (upload_attempt_id IS NOT NULL AND intent_request_hash IS NOT NULL AND expected_content_hash IS NOT NULL)
    ),
  ADD CONSTRAINT assets_new_attempt_has_binding_check
    CHECK (legacy_preallocated_object_key IS NOT NULL OR upload_attempt_id IS NOT NULL),
  ADD CONSTRAINT assets_authoritative_triplet_check
    CHECK (
      (
        authoritative_object_key IS NULL
        AND authoritative_object_version IS NULL
        AND authoritative_object_checksum IS NULL
      )
      OR
      (
        authoritative_object_key IS NOT NULL
        AND authoritative_object_version IS NOT NULL
        AND authoritative_object_checksum IS NOT NULL
      )
      OR
      (
        legacy_object_reconciliation_required
        AND authoritative_object_key IS NOT NULL
        AND authoritative_object_version IS NULL
        AND authoritative_object_checksum IS NULL
      )
    ),
  ADD CONSTRAINT assets_legacy_reconciliation_scope_check
    CHECK (NOT legacy_object_reconciliation_required OR upload_attempt_id IS NULL),
  ADD CONSTRAINT assets_capability_generation_check CHECK (capability_generation >= 0),
  ADD CONSTRAINT assets_authorization_clock_skew_check
    CHECK (authorization_clock_skew >= interval '0 seconds'
       AND authorization_clock_skew <= interval '30 minutes'),
  ADD CONSTRAINT assets_row_version_check CHECK (row_version >= 0),
  ADD CONSTRAINT assets_processing_generation_check CHECK (processing_generation >= 0),
  ADD CONSTRAINT assets_processing_lease_check
    CHECK (
      (processing_lease_id IS NULL AND processing_lease_expires_at IS NULL)
      OR
      (processing_lease_id IS NOT NULL AND processing_lease_expires_at IS NOT NULL)
    );

ALTER TABLE media.assets DROP CONSTRAINT assets_state_check;
ALTER TABLE media.assets ADD CONSTRAINT assets_state_check
  CHECK (state IN (
    'pending_upload', 'uploaded', 'processing', 'ready', 'rejected', 'abandoned', 'deleted'
  ));

CREATE UNIQUE INDEX uq_media_assets_authoritative_object_key
  ON media.assets(authoritative_object_key)
  WHERE authoritative_object_key IS NOT NULL;
CREATE UNIQUE INDEX uq_media_assets_current_owner_attempt
  ON media.assets(current_owner_id, upload_attempt_id)
  WHERE upload_attempt_id IS NOT NULL;
CREATE INDEX ix_media_assets_recoverable_upload
  ON media.assets(current_owner_id, upload_attempt_id, capability_generation)
  WHERE upload_attempt_id IS NOT NULL
    AND state = 'pending_upload'
    AND renewal_disabled_at IS NULL;
CREATE INDEX ix_media_assets_cleanup_ready
  ON media.assets(cleanup_not_before, id)
  WHERE tombstoned_at IS NOT NULL AND cleanup_verified_at IS NULL;
CREATE INDEX ix_media_assets_created_owner_audit
  ON media.assets(created_owner_id, created_at DESC);

CREATE TABLE media.account_merge_transfer_authorizations (
  job_id uuid PRIMARY KEY REFERENCES identity.account_merge_jobs(id),
  source_owner_id uuid NOT NULL REFERENCES identity.users(id),
  target_owner_id uuid NOT NULL REFERENCES identity.users(id),
  transaction_id xid8 NOT NULL,
  backend_pid integer NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'committed')),
  transferred_asset_count integer NOT NULL DEFAULT 0 CHECK (transferred_asset_count >= 0),
  transferred_receipt_count integer NOT NULL DEFAULT 0 CHECK (transferred_receipt_count >= 0),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  committed_at timestamptz,
  CHECK (source_owner_id <> target_owner_id),
  CHECK ((state = 'active' AND committed_at IS NULL) OR (state = 'committed' AND committed_at IS NOT NULL)),
  UNIQUE (transaction_id, backend_pid)
);
REVOKE ALL ON TABLE media.account_merge_transfer_authorizations FROM PUBLIC;
REVOKE UPDATE (current_owner_id) ON media.assets FROM PUBLIC;

CREATE OR REPLACE FUNCTION media.enforce_account_merge_transfer_authorization()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'media owner transfer authorization is append-only'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.state <> 'active'
     OR NEW.state <> 'committed'
     OR NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.source_owner_id IS DISTINCT FROM OLD.source_owner_id
     OR NEW.target_owner_id IS DISTINCT FROM OLD.target_owner_id
     OR NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
     OR NEW.backend_pid IS DISTINCT FROM OLD.backend_pid
     OR NEW.started_at IS DISTINCT FROM OLD.started_at
     OR OLD.transaction_id <> pg_current_xact_id()
     OR OLD.backend_pid <> pg_backend_pid() THEN
    RAISE EXCEPTION 'invalid media owner transfer authorization transition'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_media_account_merge_transfer_authorization
BEFORE UPDATE OR DELETE ON media.account_merge_transfer_authorizations
FOR EACH ROW EXECUTE FUNCTION media.enforce_account_merge_transfer_authorization();

CREATE OR REPLACE FUNCTION media.enforce_asset_invariants()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_owner_id IS DISTINCT FROM NEW.current_owner_id THEN
      RAISE EXCEPTION 'created owner must equal current owner at creation'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.upload_attempt_id IS NOT NULL
       AND (
         NEW.authoritative_object_key IS NOT NULL
         OR NEW.authoritative_object_version IS NOT NULL
         OR NEW.authoritative_object_checksum IS NOT NULL
       ) THEN
      RAISE EXCEPTION 'new upload attempt must begin without an authoritative object'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.created_owner_id IS DISTINCT FROM OLD.created_owner_id THEN
    RAISE EXCEPTION 'created owner is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.current_owner_id IS DISTINCT FROM OLD.current_owner_id
     AND NOT EXISTS (
       SELECT 1
       FROM media.account_merge_transfer_authorizations transfer_auth
       WHERE transfer_auth.state = 'active'
         AND transfer_auth.transaction_id = pg_current_xact_id()
         AND transfer_auth.backend_pid = pg_backend_pid()
         AND transfer_auth.source_owner_id = OLD.current_owner_id
         AND transfer_auth.target_owner_id = NEW.current_owner_id
     ) THEN
    RAISE EXCEPTION 'direct media owner updates are forbidden' USING ERRCODE = '55000';
  END IF;
  IF OLD.legacy_preallocated_object_key IS NOT NULL
     AND NEW.legacy_preallocated_object_key IS DISTINCT FROM OLD.legacy_preallocated_object_key THEN
    RAISE EXCEPTION 'legacy object key is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.upload_attempt_id IS DISTINCT FROM OLD.upload_attempt_id THEN
    RAISE EXCEPTION 'upload attempt is immutable; upload attempt binding is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.intent_request_hash IS DISTINCT FROM OLD.intent_request_hash THEN
    RAISE EXCEPTION 'intent request hash is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.expected_content_hash IS DISTINCT FROM OLD.expected_content_hash THEN
    RAISE EXCEPTION 'expected content hash is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.content_hash IS NOT NULL AND NEW.content_hash IS DISTINCT FROM OLD.content_hash THEN
    RAISE EXCEPTION 'verified content hash is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.content_hash IS NULL
     AND NEW.content_hash IS NOT NULL
     AND octet_length(NEW.content_hash) = 32
     AND OLD.upload_attempt_id IS NOT NULL
     AND (
       NEW.state NOT IN ('uploaded', 'processing', 'ready', 'rejected')
       OR NEW.content_hash IS DISTINCT FROM OLD.expected_content_hash
       OR NEW.content_hash IS DISTINCT FROM NEW.authoritative_object_checksum
       OR NEW.authoritative_object_key IS NULL
       OR NEW.authoritative_object_version IS NULL
       OR NEW.authoritative_object_checksum IS NULL
       OR NOT EXISTS (
         SELECT 1
         FROM media.gateway_upload_leases lease
         WHERE lease.asset_id = OLD.id
           AND lease.capability_generation = NEW.capability_generation
           AND lease.state = 'committed'
           AND lease.staging_object_key = NEW.authoritative_object_key
           AND lease.provider_object_version = NEW.authoritative_object_version
           AND lease.provider_object_checksum = NEW.content_hash
       )
     ) THEN
    RAISE EXCEPTION 'verified content hash requires the committed provider receipt'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.authoritative_object_key IS NOT NULL
     AND NEW.authoritative_object_key IS DISTINCT FROM OLD.authoritative_object_key THEN
    RAISE EXCEPTION 'authoritative object key is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.authoritative_object_version IS NOT NULL
     AND NEW.authoritative_object_version IS DISTINCT FROM OLD.authoritative_object_version THEN
    RAISE EXCEPTION 'authoritative object version is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.authoritative_object_checksum IS NOT NULL
     AND NEW.authoritative_object_checksum IS DISTINCT FROM OLD.authoritative_object_checksum THEN
    RAISE EXCEPTION 'authoritative object checksum is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.upload_attempt_id IS NULL
     AND NOT OLD.legacy_object_reconciliation_required
     AND OLD.authoritative_object_key IS NULL
     AND OLD.authoritative_object_version IS NULL
     AND OLD.authoritative_object_checksum IS NULL
     AND (
       NEW.authoritative_object_key IS NOT NULL
       OR NEW.authoritative_object_version IS NOT NULL
       OR NEW.authoritative_object_checksum IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'legacy preallocated object cannot become authoritative'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.upload_attempt_id IS NOT NULL
     AND OLD.authoritative_object_key IS NULL
     AND OLD.authoritative_object_version IS NULL
     AND OLD.authoritative_object_checksum IS NULL
     AND (
       NEW.authoritative_object_key IS NOT NULL
       OR NEW.authoritative_object_version IS NOT NULL
       OR NEW.authoritative_object_checksum IS NOT NULL
     )
     AND (
       OLD.state <> 'pending_upload'
       OR NEW.row_version <> OLD.row_version + 1
       OR NEW.authoritative_object_checksum IS DISTINCT FROM OLD.expected_content_hash
       OR NOT EXISTS (
         SELECT 1
         FROM media.gateway_upload_leases lease
         WHERE lease.asset_id = OLD.id
           AND lease.capability_generation = NEW.capability_generation
           AND lease.starting_asset_row_version = OLD.row_version
           AND lease.state = 'committed'
           AND lease.staging_object_key = NEW.authoritative_object_key
           AND lease.provider_object_version = NEW.authoritative_object_version
           AND lease.provider_object_checksum = NEW.authoritative_object_checksum
           AND lease.provider_object_checksum = OLD.expected_content_hash
       )
     ) THEN
    RAISE EXCEPTION 'authoritative object requires the committed generation lease'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.capability_generation < OLD.capability_generation
     OR NEW.processing_generation < OLD.processing_generation
     OR NEW.row_version < OLD.row_version THEN
    RAISE EXCEPTION 'media generations and row version are monotonic' USING ERRCODE = '23514';
  END IF;
  IF OLD.latest_authorization_expires_at IS NOT NULL
     AND (
       NEW.latest_authorization_expires_at IS NULL
       OR NEW.latest_authorization_expires_at < OLD.latest_authorization_expires_at
     ) THEN
    RAISE EXCEPTION 'latest authorization expiry is monotonic' USING ERRCODE = '23514';
  END IF;
  IF NEW.authorization_clock_skew IS DISTINCT FROM OLD.authorization_clock_skew THEN
    RAISE EXCEPTION 'authorization clock skew is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.cleanup_not_before IS NOT NULL
     AND (NEW.cleanup_not_before IS NULL OR NEW.cleanup_not_before < OLD.cleanup_not_before) THEN
    RAISE EXCEPTION 'cleanup fence is monotonic' USING ERRCODE = '23514';
  END IF;
  IF OLD.renewal_disabled_at IS NOT NULL AND NEW.renewal_disabled_at IS NULL THEN
    RAISE EXCEPTION 'renewal cannot be re-enabled' USING ERRCODE = '55000';
  END IF;
  IF OLD.state IN ('abandoned', 'deleted') AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION 'terminal media state cannot be revived' USING ERRCODE = '55000';
  END IF;

  IF OLD.legacy_object_reconciliation_required
     AND NEW.legacy_object_reconciliation_required THEN
    IF NEW.state IS DISTINCT FROM OLD.state
       OR NEW.latest_authorization_expires_at IS DISTINCT FROM OLD.latest_authorization_expires_at
       OR NEW.processing_generation IS DISTINCT FROM OLD.processing_generation
       OR NEW.processing_lease_id IS DISTINCT FROM OLD.processing_lease_id
       OR NEW.processing_lease_expires_at IS DISTINCT FROM OLD.processing_lease_expires_at
       OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
       OR NEW.abandoned_at IS DISTINCT FROM OLD.abandoned_at
       OR NEW.tombstoned_at IS DISTINCT FROM OLD.tombstoned_at
       OR NEW.cleanup_verified_at IS DISTINCT FROM OLD.cleanup_verified_at THEN
      RAISE EXCEPTION 'unreconciled legacy asset is frozen' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF OLD.legacy_object_reconciliation_required
     AND NOT NEW.legacy_object_reconciliation_required
     AND (
       NEW.authoritative_object_key IS NULL
       OR NEW.authoritative_object_version IS NULL
       OR NEW.authoritative_object_checksum IS NULL
       OR NEW.legacy_object_reconciled_at IS NULL
     ) THEN
    RAISE EXCEPTION 'legacy reconciliation requires verified object identity'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_media_assets_invariants
BEFORE INSERT OR UPDATE ON media.assets
FOR EACH ROW EXECUTE FUNCTION media.enforce_asset_invariants();

CREATE OR REPLACE FUNCTION media.safe_replay_json(value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  entry record;
  child jsonb;
  normalized_key text;
  scalar_value text;
BEGIN
  IF jsonb_typeof(value) = 'object' THEN
    FOR entry IN SELECT key, json_value FROM jsonb_each(value) AS item(key, json_value)
    LOOP
      normalized_key := regexp_replace(lower(entry.key), '[^a-z0-9]', '', 'g');
      IF normalized_key = ANY (ARRAY[
        'authorization',
        'authoritativeobjectkey',
        'capability',
        'cookie',
        'gatewaycapability',
        'gatewayurl',
        'legacypreallocatedobjectkey',
        'objectkey',
        'presignedurl',
        'privatekey',
        'providerobjectkey',
        'providercredential',
        'refreshtoken',
        'requiredheaders',
        'secret',
        'signedurl',
        'stagingobjectkey',
        'token',
        'uploadurl',
        'accesstoken',
        'xspottuploadcapability'
      ])
      OR normalized_key LIKE 'xamz%'
      OR normalized_key LIKE 'xgoog%' THEN
        RETURN false;
      END IF;
      IF NOT media.safe_replay_json(entry.json_value) THEN
        RETURN false;
      END IF;
    END LOOP;
  ELSIF jsonb_typeof(value) = 'array' THEN
    FOR child IN SELECT json_value FROM jsonb_array_elements(value) AS item(json_value)
    LOOP
      IF NOT media.safe_replay_json(child) THEN
        RETURN false;
      END IF;
    END LOOP;
  ELSIF jsonb_typeof(value) = 'string' THEN
    scalar_value := lower(value #>> '{}');
    IF scalar_value ~ '(^|[[:space:]])bearer[[:space:]]+[a-z0-9._~+/-]+'
       OR scalar_value ~ '([?&]|%3f|%26)(x-amz-(signature|credential|security-token)|x-goog-(signature|credential)|access_token|token|signature)='
       OR scalar_value ~ '(^|["''[:space:]])(private|gateway|provider|staging|temporary|tmp)/[a-z0-9._~+/-]+'
       OR scalar_value ~ '-----begin [a-z0-9 ]*private key-----' THEN
      RETURN false;
    END IF;
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION media.json_object_has_only_keys(value jsonb, allowed_keys text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT jsonb_typeof(value) = 'object'
     AND NOT EXISTS (
       SELECT 1
       FROM jsonb_object_keys(value) AS entry(key)
       WHERE NOT entry.key = ANY (allowed_keys)
     )
$$;

CREATE OR REPLACE FUNCTION media.json_uuid_string(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT jsonb_typeof(value) = 'string'
     AND (value #>> '{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
$$;

CREATE OR REPLACE FUNCTION media.json_integer_between(value jsonb, minimum bigint, maximum bigint)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT CASE
    WHEN jsonb_typeof(value) <> 'number' OR (value #>> '{}') !~ '^[0-9]+$' THEN false
    ELSE (value #>> '{}')::numeric BETWEEN minimum::numeric AND maximum::numeric
  END
$$;

CREATE OR REPLACE FUNCTION media.json_uuid_array(
  value jsonb,
  minimum_length integer,
  maximum_length integer
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT CASE
    WHEN jsonb_typeof(value) <> 'array' THEN false
    WHEN jsonb_array_length(value) NOT BETWEEN minimum_length AND maximum_length THEN false
    ELSE NOT EXISTS (
           SELECT 1
           FROM jsonb_array_elements(value) AS item(element)
           WHERE NOT COALESCE(media.json_uuid_string(item.element), false)
         )
         AND (
           SELECT count(*) = count(DISTINCT item.element #>> '{}')
           FROM jsonb_array_elements(value) AS item(element)
         )
  END
$$;

CREATE OR REPLACE FUNCTION media.safe_public_media_url(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT jsonb_typeof(value) = 'null'
     OR (
       jsonb_typeof(value) = 'string'
       AND (value #>> '{}') ~ '^https://(media|cdn)\.spott\.jp/public/[A-Za-z0-9._~!$&''()*+,;=:@%/-]+$'
     )
$$;

CREATE OR REPLACE FUNCTION media.safe_asset_state(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT jsonb_typeof(value) = 'string'
     AND (value #>> '{}') = ANY (ARRAY[
       'pending_upload', 'uploaded', 'processing', 'ready', 'rejected',
       'abandoned', 'deleted', 'legacy_recovery_required'
     ])
$$;

CREATE OR REPLACE FUNCTION media.safe_media_replay_stub(resource_type text, value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  normalized_type text := lower(resource_type);
BEGIN
  IF jsonb_typeof(value) <> 'object' OR NOT media.safe_replay_json(value) THEN
    RETURN false;
  END IF;

  CASE normalized_type
    WHEN 'media.upload_intent' THEN
      RETURN (
               media.json_object_has_only_keys(
                 value,
                 ARRAY['resourceType', 'resourceId', 'state']
               )
               AND value ?& ARRAY['resourceType', 'resourceId', 'state']
               AND value->>'resourceType' = 'media.upload_intent'
               AND COALESCE(media.json_uuid_string(value->'resourceId'), false)
               AND COALESCE(media.safe_asset_state(value->'state'), false)
             )
          OR (
               media.json_object_has_only_keys(
                 value,
                 ARRAY['attemptId', 'assetId', 'state', 'gatewayLeaseState', 'moderationState']
               )
               AND value ?& ARRAY['attemptId', 'assetId', 'state']
               AND COALESCE(media.json_uuid_string(value->'attemptId'), false)
               AND COALESCE(media.json_uuid_string(value->'assetId'), false)
               AND value->>'state' = 'pending_upload'
               AND (
                 NOT value ? 'gatewayLeaseState'
                 OR value->>'gatewayLeaseState' = ANY (ARRAY[
                   'receiving', 'provider_writing', 'committed',
                   'failed_cleanup_pending', 'failed_clean'
                 ])
               )
               AND (
                 NOT value ? 'moderationState'
                 OR value->>'moderationState' = 'pending'
               )
             );
    WHEN 'media.completion' THEN
      RETURN media.json_object_has_only_keys(value, ARRAY['assetId', 'state', 'moderationState'])
         AND value ?& ARRAY['assetId', 'state']
         AND COALESCE(media.json_uuid_string(value->'assetId'), false)
         AND value->>'state' = ANY (ARRAY['uploaded', 'processing', 'ready', 'rejected'])
         AND (
           NOT value ? 'moderationState'
           OR value->>'moderationState' = ANY (ARRAY['pending', 'approved', 'rejected'])
         );
    WHEN 'media.asset_abandonment' THEN
      RETURN media.json_object_has_only_keys(value, ARRAY['assetId', 'state', 'cleanupNotBefore'])
         AND value ?& ARRAY['assetId', 'state', 'cleanupNotBefore']
         AND COALESCE(media.json_uuid_string(value->'assetId'), false)
         AND value->>'state' = ANY (ARRAY['abandoned', 'deleted'])
         AND jsonb_typeof(value->'cleanupNotBefore') = 'string'
         AND value->>'cleanupNotBefore' ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$';
    WHEN 'media.event_attachment' THEN
      RETURN media.json_object_has_only_keys(
               value, ARRAY['id', 'eventId', 'assetId', 'kind', 'sortOrder', 'mediaCount']
             )
         AND value ?& ARRAY['id', 'eventId', 'assetId', 'kind', 'sortOrder', 'mediaCount']
         AND COALESCE(media.json_uuid_string(value->'id'), false)
         AND COALESCE(media.json_uuid_string(value->'eventId'), false)
         AND COALESCE(media.json_uuid_string(value->'assetId'), false)
         AND value->>'kind' = ANY (ARRAY['cover', 'gallery'])
         AND COALESCE(media.json_integer_between(value->'sortOrder', 0, 5), false)
         AND COALESCE(media.json_integer_between(value->'mediaCount', 1, 6), false);
    WHEN 'media.profile_attachment' THEN
      RETURN media.json_object_has_only_keys(value, ARRAY['assetId', 'profileId', 'url', 'version'])
         AND value ?& ARRAY['assetId', 'profileId', 'url', 'version']
         AND COALESCE(media.json_uuid_string(value->'assetId'), false)
         AND COALESCE(media.json_uuid_string(value->'profileId'), false)
         AND COALESCE(media.safe_public_media_url(value->'url'), false)
         AND COALESCE(media.json_integer_between(value->'version', 1, 9223372036854775807), false);
    WHEN 'media.group_attachment' THEN
      RETURN media.json_object_has_only_keys(value, ARRAY['assetId', 'groupId', 'url', 'version'])
         AND value ?& ARRAY['assetId', 'groupId', 'url', 'version']
         AND COALESCE(media.json_uuid_string(value->'assetId'), false)
         AND COALESCE(media.json_uuid_string(value->'groupId'), false)
         AND COALESCE(media.safe_public_media_url(value->'url'), false)
         AND COALESCE(media.json_integer_between(value->'version', 1, 9223372036854775807), false);
    WHEN 'media.event_arrangement' THEN
      RETURN media.json_object_has_only_keys(value, ARRAY['eventId', 'assetIds', 'version'])
         AND value ?& ARRAY['eventId', 'assetIds', 'version']
         AND COALESCE(media.json_uuid_string(value->'eventId'), false)
         AND COALESCE(media.json_uuid_array(value->'assetIds', 1, 6), false)
         AND COALESCE(media.json_integer_between(value->'version', 1, 9223372036854775807), false);
    WHEN 'media.report_submission' THEN
      RETURN media.json_object_has_only_keys(
               value,
               ARRAY['reportId', 'caseId', 'publicReference', 'state']
             )
         AND value ?& ARRAY['reportId', 'caseId']
         AND COALESCE(media.json_uuid_string(value->'reportId'), false)
         AND COALESCE(media.json_uuid_string(value->'caseId'), false)
         AND (
           NOT value ? 'publicReference'
           OR (
             jsonb_typeof(value->'publicReference') = 'string'
             AND value->>'publicReference' ~ '^SPT-[0-9]{4}-[A-F0-9]{12}$'
           )
         )
         AND (NOT value ? 'state' OR value->>'state' = 'open');
    ELSE
      RETURN false;
  END CASE;
END;
$$;

CREATE OR REPLACE FUNCTION media.safe_completion_replay_json(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT media.safe_replay_json(value)
     AND media.json_object_has_only_keys(value, ARRAY['assetId', 'state', 'moderationState'])
     AND value ?& ARRAY['assetId', 'state']
     AND COALESCE(media.json_uuid_string(value->'assetId'), false)
     AND value->>'state' = ANY (ARRAY['uploaded', 'processing', 'ready', 'rejected'])
     AND (
       NOT value ? 'moderationState'
       OR value->>'moderationState' = ANY (ARRAY['pending', 'approved', 'rejected'])
     )
$$;

CREATE OR REPLACE FUNCTION media.safe_mutation_replay_json(operation_type text, value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
BEGIN
  IF jsonb_typeof(value) <> 'object' OR NOT media.safe_replay_json(value) THEN
    RETURN false;
  END IF;

  CASE operation_type
    WHEN 'event_attachment' THEN
      RETURN media.json_object_has_only_keys(
               value, ARRAY['id', 'eventId', 'assetId', 'kind', 'sortOrder', 'mediaCount']
             )
         AND value ?& ARRAY['id', 'eventId', 'assetId', 'kind', 'sortOrder', 'mediaCount']
         AND COALESCE(media.json_uuid_string(value->'id'), false)
         AND COALESCE(media.json_uuid_string(value->'eventId'), false)
         AND COALESCE(media.json_uuid_string(value->'assetId'), false)
         AND value->>'kind' = ANY (ARRAY['cover', 'gallery'])
         AND COALESCE(media.json_integer_between(value->'sortOrder', 0, 5), false)
         AND COALESCE(media.json_integer_between(value->'mediaCount', 1, 6), false);
    WHEN 'profile_attachment' THEN
      RETURN media.json_object_has_only_keys(value, ARRAY['assetId', 'profileId', 'url', 'version'])
         AND value ?& ARRAY['assetId', 'profileId', 'url', 'version']
         AND COALESCE(media.json_uuid_string(value->'assetId'), false)
         AND COALESCE(media.json_uuid_string(value->'profileId'), false)
         AND COALESCE(media.safe_public_media_url(value->'url'), false)
         AND COALESCE(media.json_integer_between(value->'version', 1, 9223372036854775807), false);
    WHEN 'group_attachment' THEN
      RETURN media.json_object_has_only_keys(value, ARRAY['assetId', 'groupId', 'url', 'version'])
         AND value ?& ARRAY['assetId', 'groupId', 'url', 'version']
         AND COALESCE(media.json_uuid_string(value->'assetId'), false)
         AND COALESCE(media.json_uuid_string(value->'groupId'), false)
         AND COALESCE(media.safe_public_media_url(value->'url'), false)
         AND COALESCE(media.json_integer_between(value->'version', 1, 9223372036854775807), false);
    WHEN 'event_arrangement' THEN
      RETURN media.json_object_has_only_keys(value, ARRAY['eventId', 'assetIds', 'version'])
         AND value ?& ARRAY['eventId', 'assetIds', 'version']
         AND COALESCE(media.json_uuid_string(value->'eventId'), false)
         AND COALESCE(media.json_uuid_array(value->'assetIds', 1, 6), false)
         AND COALESCE(media.json_integer_between(value->'version', 1, 9223372036854775807), false);
    WHEN 'report_submission' THEN
      RETURN media.json_object_has_only_keys(
               value,
               ARRAY['reportId', 'caseId', 'publicReference', 'state']
             )
         AND value ?& ARRAY['reportId', 'caseId']
         AND COALESCE(media.json_uuid_string(value->'reportId'), false)
         AND COALESCE(media.json_uuid_string(value->'caseId'), false)
         AND (
           NOT value ? 'publicReference'
           OR (
             jsonb_typeof(value->'publicReference') = 'string'
             AND value->>'publicReference' ~ '^SPT-[0-9]{4}-[A-F0-9]{12}$'
           )
         )
         AND (NOT value ? 'state' OR value->>'state' = 'open');
    WHEN 'asset_abandonment' THEN
      RETURN media.json_object_has_only_keys(value, ARRAY['assetId', 'state', 'cleanupNotBefore'])
         AND value ?& ARRAY['assetId', 'state', 'cleanupNotBefore']
         AND COALESCE(media.json_uuid_string(value->'assetId'), false)
         AND value->>'state' = ANY (ARRAY['abandoned', 'deleted'])
         AND jsonb_typeof(value->'cleanupNotBefore') = 'string'
         AND value->>'cleanupNotBefore' ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$';
    ELSE
      RETURN false;
  END CASE;
END;
$$;

UPDATE sync.idempotency_keys generic
SET response_body = CASE
      WHEN generic.resource_id IS NULL OR lower(generic.resource_type) <> 'media.upload_intent'
        THEN NULL
      ELSE jsonb_build_object(
        'resourceType', generic.resource_type,
        'resourceId', generic.resource_id,
        'state', COALESCE(
          (SELECT asset.state FROM media.assets asset WHERE asset.id = generic.resource_id),
          'legacy_recovery_required'
        )
      )
    END
WHERE lower(COALESCE(generic.resource_type, '')) ~ '^media([._]|$)'
  AND generic.response_body IS NOT NULL
  AND NOT media.safe_media_replay_stub(generic.resource_type, generic.response_body);

ALTER TABLE sync.idempotency_keys
  ADD CONSTRAINT idempotency_keys_media_safe_replay_check
  CHECK (
    NOT lower(COALESCE(resource_type, '')) ~ '^media([._]|$)'
    OR response_body IS NULL
    OR media.safe_media_replay_stub(resource_type, response_body)
  );

CREATE TABLE media.legacy_reconciliation_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category text NOT NULL CHECK (category IN ('duplicate_processing_outbox')),
  source_id uuid NOT NULL,
  survivor_id uuid NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  reconciled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (category, source_id)
);

WITH ranked AS (
  SELECT event_id,
         first_value(event_id) OVER (
           PARTITION BY aggregate_id
           ORDER BY (published_at IS NOT NULL) DESC, created_at, event_id
         ) AS survivor_id,
         row_number() OVER (
           PARTITION BY aggregate_id
           ORDER BY (published_at IS NOT NULL) DESC, created_at, event_id
         ) AS ordinal
  FROM sync.outbox_events
  WHERE aggregate = 'media.asset' AND type = 'media.processing_requested'
)
INSERT INTO media.legacy_reconciliation_log(category, source_id, survivor_id, details)
SELECT 'duplicate_processing_outbox', event_id, survivor_id,
       jsonb_build_object('reason', 'lifetime_duplicate', 'ordinal', ordinal)
FROM ranked
WHERE ordinal > 1;

UPDATE sync.outbox_events event
SET type = 'media.processing_requested.legacy_duplicate',
    published_at = COALESCE(event.published_at, clock_timestamp()),
    last_error = 'reconciled_by_0022_lifetime_uniqueness',
    payload = event.payload || jsonb_build_object(
      'legacyDuplicateOf', reconciliation.survivor_id,
      'reconciledBy', '0022_media_upload_attempts'
    )
FROM media.legacy_reconciliation_log reconciliation
WHERE reconciliation.category = 'duplicate_processing_outbox'
  AND event.event_id = reconciliation.source_id;

CREATE UNIQUE INDEX uq_sync_outbox_media_processing_lifetime
  ON sync.outbox_events(aggregate_id)
  WHERE aggregate = 'media.asset' AND type = 'media.processing_requested';

CREATE TABLE media.completion_receipts (
  asset_id uuid PRIMARY KEY REFERENCES media.assets(id),
  completion_attempt_id uuid,
  request_fingerprint bytea,
  verified_content_hash bytea,
  replay_response jsonb,
  outbox_event_id uuid UNIQUE REFERENCES sync.outbox_events(event_id),
  legacy_backfilled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (request_fingerprint IS NULL OR octet_length(request_fingerprint) = 32),
  CHECK (verified_content_hash IS NULL OR octet_length(verified_content_hash) = 32),
  CHECK (replay_response IS NULL OR jsonb_typeof(replay_response) = 'object'),
  CONSTRAINT completion_receipts_safe_replay_check
    CHECK (replay_response IS NULL OR media.safe_completion_replay_json(replay_response)),
  CHECK (
    legacy_backfilled
    OR (
      completion_attempt_id IS NOT NULL
      AND request_fingerprint IS NOT NULL
      AND verified_content_hash IS NOT NULL
      AND replay_response IS NOT NULL
      AND outbox_event_id IS NOT NULL
    )
  )
);

INSERT INTO media.completion_receipts(
  asset_id,
  verified_content_hash,
  outbox_event_id,
  legacy_backfilled
)
SELECT asset.id, asset.content_hash, outbox.event_id, true
FROM media.assets asset
LEFT JOIN sync.outbox_events outbox
  ON outbox.aggregate = 'media.asset'
 AND outbox.aggregate_id = asset.id
 AND outbox.type = 'media.processing_requested'
WHERE asset.state IN ('uploaded', 'processing', 'ready', 'rejected');

CREATE TRIGGER trg_media_completion_receipts_immutable
BEFORE UPDATE OR DELETE ON media.completion_receipts
FOR EACH ROW EXECUTE FUNCTION spott.prevent_mutation();

CREATE TABLE media.mutation_receipts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  current_owner_id uuid NOT NULL REFERENCES identity.users(id),
  created_owner_id uuid NOT NULL REFERENCES identity.users(id),
  operation_type text NOT NULL CHECK (operation_type IN (
    'event_attachment',
    'profile_attachment',
    'group_attachment',
    'event_arrangement',
    'report_submission',
    'asset_abandonment'
  )),
  idempotency_key uuid NOT NULL,
  request_fingerprint bytea NOT NULL CHECK (octet_length(request_fingerprint) = 32),
  canonical_request jsonb NOT NULL CHECK (jsonb_typeof(canonical_request) = 'object'),
  replay_response jsonb NOT NULL CHECK (jsonb_typeof(replay_response) = 'object'),
  resource_type text NOT NULL,
  resource_id uuid NOT NULL,
  resource_version bigint CHECK (resource_version IS NULL OR resource_version > 0),
  outbox_event_id uuid REFERENCES sync.outbox_events(event_id),
  previous_asset_id uuid REFERENCES media.assets(id),
  previous_asset_action_id uuid,
  report_target_type text,
  report_target_id uuid,
  report_category text,
  report_description_hash bytea,
  report_id uuid REFERENCES safety.reports(id),
  safety_case_id uuid REFERENCES safety.moderation_cases(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (report_description_hash IS NULL OR octet_length(report_description_hash) = 32),
  CONSTRAINT mutation_receipts_safe_replay_check
    CHECK (media.safe_mutation_replay_json(operation_type, replay_response)),
  CHECK (
    (
      operation_type = 'report_submission'
      AND resource_type = 'safety.report'
      AND report_target_type IS NOT NULL
      AND report_target_id IS NOT NULL
      AND report_category IS NOT NULL
      AND report_description_hash IS NOT NULL
      AND report_id IS NOT NULL
      AND safety_case_id IS NOT NULL
      AND resource_id = report_id
      AND replay_response->>'reportId' = report_id::text
      AND replay_response->>'caseId' = safety_case_id::text
    )
    OR (
      operation_type <> 'report_submission'
      AND report_target_type IS NULL
      AND report_target_id IS NULL
      AND report_category IS NULL
      AND report_description_hash IS NULL
      AND report_id IS NULL
      AND safety_case_id IS NULL
    )
  ),
  UNIQUE (current_owner_id, operation_type, idempotency_key)
);
CREATE INDEX ix_media_mutation_receipts_resource
  ON media.mutation_receipts(resource_type, resource_id, created_at DESC);
REVOKE UPDATE (current_owner_id) ON media.mutation_receipts FROM PUBLIC;

CREATE OR REPLACE FUNCTION media.enforce_mutation_receipt_invariants()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'mutation receipt is immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_owner_id IS DISTINCT FROM NEW.current_owner_id THEN
      RAISE EXCEPTION 'created owner must equal current owner at receipt creation'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.created_owner_id IS DISTINCT FROM OLD.created_owner_id
     OR (to_jsonb(NEW) - 'current_owner_id')
        IS DISTINCT FROM (to_jsonb(OLD) - 'current_owner_id') THEN
    RAISE EXCEPTION 'mutation receipt is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.current_owner_id IS DISTINCT FROM OLD.current_owner_id
     AND NOT EXISTS (
       SELECT 1
       FROM media.account_merge_transfer_authorizations transfer_auth
       WHERE transfer_auth.state = 'active'
         AND transfer_auth.transaction_id = pg_current_xact_id()
         AND transfer_auth.backend_pid = pg_backend_pid()
         AND transfer_auth.source_owner_id = OLD.current_owner_id
         AND transfer_auth.target_owner_id = NEW.current_owner_id
     ) THEN
    RAISE EXCEPTION 'direct media receipt owner updates are forbidden' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_media_mutation_receipt_invariants
BEFORE INSERT OR UPDATE OR DELETE ON media.mutation_receipts
FOR EACH ROW EXECUTE FUNCTION media.enforce_mutation_receipt_invariants();

CREATE TABLE media.report_receipt_evidence (
  receipt_id uuid NOT NULL REFERENCES media.mutation_receipts(id),
  sort_order integer NOT NULL CHECK (sort_order >= 0),
  asset_id uuid NOT NULL REFERENCES media.assets(id),
  verified_content_hash bytea NOT NULL CHECK (octet_length(verified_content_hash) = 32),
  PRIMARY KEY (receipt_id, sort_order),
  UNIQUE (receipt_id, asset_id)
);
CREATE INDEX ix_media_report_receipt_evidence_asset
  ON media.report_receipt_evidence(asset_id);
CREATE TRIGGER trg_media_report_receipt_evidence_immutable
BEFORE UPDATE OR DELETE ON media.report_receipt_evidence
FOR EACH ROW EXECUTE FUNCTION spott.prevent_mutation();

CREATE TABLE media.gateway_upload_leases (
  asset_id uuid NOT NULL REFERENCES media.assets(id),
  capability_generation bigint NOT NULL CHECK (capability_generation >= 0),
  lease_id uuid NOT NULL UNIQUE,
  starting_asset_row_version bigint NOT NULL CHECK (starting_asset_row_version >= 0),
  inbound_deadline_at timestamptz NOT NULL,
  provider_deadline_at timestamptz,
  provider_abort_confirmed_at timestamptz,
  state text NOT NULL CHECK (state IN (
    'receiving',
    'provider_writing',
    'committed',
    'failed_cleanup_pending',
    'failed_clean'
  )),
  staging_object_key text NOT NULL UNIQUE,
  provider_object_version text,
  provider_object_checksum bytea,
  temp_manifest_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  committed_at timestamptz,
  failed_at timestamptz,
  PRIMARY KEY (asset_id, capability_generation),
  CHECK (provider_object_checksum IS NULL OR octet_length(provider_object_checksum) = 32),
  CHECK (
    state <> 'committed'
    OR (
      provider_deadline_at IS NOT NULL
      AND provider_object_version IS NOT NULL
      AND provider_object_checksum IS NOT NULL
      AND committed_at IS NOT NULL
    )
  ),
  CHECK (
    state NOT IN ('failed_cleanup_pending', 'failed_clean')
    OR failed_at IS NOT NULL
  )
);
CREATE UNIQUE INDEX uq_media_gateway_committed_asset
  ON media.gateway_upload_leases(asset_id)
  WHERE state = 'committed';
CREATE INDEX ix_media_gateway_lease_recovery
  ON media.gateway_upload_leases(asset_id, state, updated_at DESC);

CREATE OR REPLACE FUNCTION media.enforce_gateway_lease_invariants()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  asset media.assets%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO asset
    FROM media.assets
    WHERE id = NEW.asset_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'gateway lease asset does not exist' USING ERRCODE = '23503';
    END IF;
    IF asset.upload_attempt_id IS NULL OR asset.expected_content_hash IS NULL THEN
      RAISE EXCEPTION 'gateway lease requires a recoverable upload attempt'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.state <> 'receiving' THEN
      RAISE EXCEPTION 'gateway lease must start in receiving state'
        USING ERRCODE = '55000';
    END IF;
    IF asset.state <> 'pending_upload'
       OR asset.renewal_disabled_at IS NOT NULL
       OR asset.legacy_object_reconciliation_required
       OR asset.authoritative_object_key IS NOT NULL
       OR asset.authoritative_object_version IS NOT NULL
       OR asset.authoritative_object_checksum IS NOT NULL
       OR NEW.capability_generation <> asset.capability_generation
       OR NEW.starting_asset_row_version <> asset.row_version THEN
      RAISE EXCEPTION 'gateway lease binding does not match the current upload generation'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.provider_deadline_at IS NOT NULL
       OR NEW.provider_abort_confirmed_at IS NOT NULL
       OR NEW.provider_object_version IS NOT NULL
       OR NEW.provider_object_checksum IS NOT NULL
       OR NEW.committed_at IS NOT NULL
       OR NEW.failed_at IS NOT NULL THEN
      RAISE EXCEPTION 'receiving gateway lease must not contain provider outcome fields'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'gateway lease history is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'committed' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'committed gateway receipt is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'failed_clean' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'clean gateway failure receipt is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.asset_id IS DISTINCT FROM OLD.asset_id
     OR NEW.capability_generation IS DISTINCT FROM OLD.capability_generation
     OR NEW.lease_id IS DISTINCT FROM OLD.lease_id
     OR NEW.starting_asset_row_version IS DISTINCT FROM OLD.starting_asset_row_version
     OR NEW.inbound_deadline_at IS DISTINCT FROM OLD.inbound_deadline_at
     OR NEW.staging_object_key IS DISTINCT FROM OLD.staging_object_key
     OR NEW.temp_manifest_id IS DISTINCT FROM OLD.temp_manifest_id THEN
    RAISE EXCEPTION 'gateway lease binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.provider_deadline_at IS NOT NULL
     AND NEW.provider_deadline_at IS DISTINCT FROM OLD.provider_deadline_at THEN
    RAISE EXCEPTION 'provider deadline is immutable once persisted' USING ERRCODE = '55000';
  END IF;
  IF OLD.provider_abort_confirmed_at IS NOT NULL
     AND NEW.provider_abort_confirmed_at IS DISTINCT FROM OLD.provider_abort_confirmed_at THEN
    RAISE EXCEPTION 'provider abort confirmation is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.provider_object_version IS NOT NULL
     AND NEW.provider_object_version IS DISTINCT FROM OLD.provider_object_version THEN
    RAISE EXCEPTION 'provider object version is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.provider_object_checksum IS NOT NULL
     AND NEW.provider_object_checksum IS DISTINCT FROM OLD.provider_object_checksum THEN
    RAISE EXCEPTION 'provider object checksum is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'receiving'
     AND NEW.state = 'provider_writing'
     AND NEW.provider_deadline_at IS NULL THEN
    RAISE EXCEPTION 'provider writing requires a durable provider deadline'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state IN ('receiving', 'provider_writing')
     AND (
       NEW.provider_object_version IS NOT NULL
       OR NEW.provider_object_checksum IS NOT NULL
       OR NEW.committed_at IS NOT NULL
       OR NEW.failed_at IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'provider outcome fields require a terminal lease state'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'provider_writing' AND NEW.state = 'committed' THEN
    SELECT * INTO asset
    FROM media.assets
    WHERE id = NEW.asset_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'gateway lease asset does not exist' USING ERRCODE = '23503';
    END IF;
    IF NEW.provider_object_checksum IS DISTINCT FROM asset.expected_content_hash THEN
      RAISE EXCEPTION 'provider checksum must match expected content hash'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NOT (
    NEW.state = OLD.state
    OR (OLD.state = 'receiving' AND NEW.state IN ('provider_writing', 'failed_cleanup_pending'))
    OR (OLD.state = 'provider_writing' AND NEW.state IN ('committed', 'failed_cleanup_pending'))
    OR (OLD.state = 'failed_cleanup_pending' AND NEW.state = 'failed_clean')
  ) THEN
    RAISE EXCEPTION 'invalid gateway lease state transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_media_gateway_lease_invariants
BEFORE INSERT OR UPDATE OR DELETE ON media.gateway_upload_leases
FOR EACH ROW EXECUTE FUNCTION media.enforce_gateway_lease_invariants();

CREATE TABLE media.worker_processing_leases (
  asset_id uuid NOT NULL REFERENCES media.assets(id),
  processing_generation bigint NOT NULL CHECK (processing_generation > 0),
  lease_id uuid NOT NULL UNIQUE,
  lease_expires_at timestamptz NOT NULL,
  staging_object_key text NOT NULL,
  staging_object_version text,
  provider_deadline_at timestamptz,
  provider_abort_confirmed_at timestamptz,
  state text NOT NULL CHECK (state IN (
    'processing', 'committed', 'failed_cleanup_pending', 'failed_clean'
  )),
  failed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (asset_id, processing_generation),
  UNIQUE NULLS NOT DISTINCT (staging_object_key, staging_object_version),
  CHECK (
    state <> 'failed_cleanup_pending'
    OR (
      failed_at IS NOT NULL
      AND (provider_deadline_at IS NULL OR provider_abort_confirmed_at IS NOT NULL)
    )
  ),
  CHECK (state <> 'failed_clean' OR completed_at IS NOT NULL)
);
CREATE INDEX ix_media_worker_processing_lease_asset
  ON media.worker_processing_leases(asset_id, state, processing_generation DESC);
REVOKE ALL ON TABLE media.worker_processing_leases FROM PUBLIC;

CREATE OR REPLACE FUNCTION media.enforce_worker_processing_lease_invariants()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  asset media.assets%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'worker processing lease history is immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO asset
    FROM media.assets
    WHERE id = NEW.asset_id
    FOR UPDATE;
    IF NOT FOUND
       OR asset.processing_generation IS DISTINCT FROM NEW.processing_generation
       OR asset.processing_lease_id IS DISTINCT FROM NEW.lease_id
       OR asset.processing_lease_expires_at IS DISTINCT FROM NEW.lease_expires_at THEN
      RAISE EXCEPTION 'worker lease must bind the current durable processing claim'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.state <> 'processing'
       OR NEW.provider_abort_confirmed_at IS NOT NULL
       OR NEW.failed_at IS NOT NULL
       OR NEW.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'worker lease must start in processing state'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state IN ('committed', 'failed_clean') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal worker processing lease is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.asset_id IS DISTINCT FROM OLD.asset_id
     OR NEW.processing_generation IS DISTINCT FROM OLD.processing_generation
     OR NEW.lease_id IS DISTINCT FROM OLD.lease_id
     OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
     OR NEW.staging_object_key IS DISTINCT FROM OLD.staging_object_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'worker processing lease binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.staging_object_version IS NOT NULL
     AND NEW.staging_object_version IS DISTINCT FROM OLD.staging_object_version THEN
    RAISE EXCEPTION 'worker staging object version is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.provider_deadline_at IS NOT NULL
     AND NEW.provider_deadline_at IS DISTINCT FROM OLD.provider_deadline_at THEN
    RAISE EXCEPTION 'worker provider deadline is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.provider_abort_confirmed_at IS NOT NULL
     AND NEW.provider_abort_confirmed_at IS DISTINCT FROM OLD.provider_abort_confirmed_at THEN
    RAISE EXCEPTION 'worker provider abort confirmation is immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    NEW.state = OLD.state
    OR (OLD.state = 'processing' AND NEW.state IN ('committed', 'failed_cleanup_pending'))
    OR (OLD.state = 'failed_cleanup_pending' AND NEW.state = 'failed_clean')
  ) THEN
    RAISE EXCEPTION 'invalid worker processing lease transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_media_worker_processing_lease_invariants
BEFORE INSERT OR UPDATE OR DELETE ON media.worker_processing_leases
FOR EACH ROW EXECUTE FUNCTION media.enforce_worker_processing_lease_invariants();

CREATE OR REPLACE FUNCTION media.cleanup_fence_for_asset(p_asset_id uuid)
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT max(fence.fence_at)
  FROM (
    SELECT asset.cleanup_not_before AS fence_at
    FROM media.assets asset
    WHERE asset.id = p_asset_id
    UNION ALL
    SELECT asset.latest_authorization_expires_at + asset.authorization_clock_skew
    FROM media.assets asset
    WHERE asset.id = p_asset_id
    UNION ALL
    SELECT asset.processing_lease_expires_at
    FROM media.assets asset
    WHERE asset.id = p_asset_id
    UNION ALL
    SELECT lease.inbound_deadline_at
    FROM media.gateway_upload_leases lease
    WHERE lease.asset_id = p_asset_id
    UNION ALL
    SELECT lease.provider_deadline_at
    FROM media.gateway_upload_leases lease
    WHERE lease.asset_id = p_asset_id
    UNION ALL
    SELECT lease.provider_abort_confirmed_at
    FROM media.gateway_upload_leases lease
    WHERE lease.asset_id = p_asset_id
    UNION ALL
    SELECT lease.lease_expires_at
    FROM media.worker_processing_leases lease
    WHERE lease.asset_id = p_asset_id
    UNION ALL
    SELECT lease.provider_deadline_at
    FROM media.worker_processing_leases lease
    WHERE lease.asset_id = p_asset_id
    UNION ALL
    SELECT lease.provider_abort_confirmed_at
    FROM media.worker_processing_leases lease
    WHERE lease.asset_id = p_asset_id
  ) fence
$$;
REVOKE ALL ON FUNCTION media.cleanup_fence_for_asset(uuid) FROM PUBLIC;

CREATE TABLE media.object_cleanup_tasks (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  asset_id uuid NOT NULL REFERENCES media.assets(id),
  object_kind text NOT NULL CHECK (object_kind IN (
    'legacy_preallocated',
    'authoritative_original',
    'gateway_staging',
    'worker_staging',
    'derivative'
  )),
  object_key text NOT NULL,
  object_version text,
  capability_generation bigint CHECK (capability_generation IS NULL OR capability_generation >= 0),
  processing_generation bigint CHECK (processing_generation IS NULL OR processing_generation >= 0),
  lease_id uuid,
  cleanup_not_before timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN (
    'pending', 'claimed', 'delete_requested', 'verifying_absence', 'verified_absent', 'failed'
  )),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  verification_state text NOT NULL DEFAULT 'unverified' CHECK (verification_state IN (
    'unverified', 'head_present', 'delete_sent', 'absence_verified', 'unsupported', 'failed'
  )),
  last_error text,
  tombstone_recheck_after timestamptz,
  claimed_at timestamptz,
  claimed_by text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE NULLS NOT DISTINCT (
    asset_id,
    object_kind,
    object_key,
    object_version,
    capability_generation,
    processing_generation
  ),
  CHECK (
    object_kind <> 'gateway_staging'
    OR (capability_generation IS NOT NULL AND lease_id IS NOT NULL)
  ),
  CHECK (
    object_kind <> 'worker_staging'
    OR (processing_generation IS NOT NULL AND lease_id IS NOT NULL)
  ),
  CHECK (
    state <> 'verified_absent'
    OR (verification_state = 'absence_verified' AND completed_at IS NOT NULL)
  )
);
CREATE INDEX ix_media_object_cleanup_ready
  ON media.object_cleanup_tasks(cleanup_not_before, tombstone_recheck_after, created_at)
  WHERE state IN ('pending', 'failed');
CREATE INDEX ix_media_object_cleanup_asset
  ON media.object_cleanup_tasks(asset_id, state, created_at);

CREATE OR REPLACE FUNCTION media.enforce_cleanup_task_invariants()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  asset media.assets%ROWTYPE;
  gateway_lease media.gateway_upload_leases%ROWTYPE;
  worker_lease media.worker_processing_leases%ROWTYPE;
  required_fence timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cleanup ledger is append-only' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
       OR NEW.object_kind IS DISTINCT FROM OLD.object_kind
       OR NEW.object_key IS DISTINCT FROM OLD.object_key
       OR NEW.object_version IS DISTINCT FROM OLD.object_version
       OR NEW.capability_generation IS DISTINCT FROM OLD.capability_generation
       OR NEW.processing_generation IS DISTINCT FROM OLD.processing_generation
       OR NEW.lease_id IS DISTINCT FROM OLD.lease_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'cleanup object identity is immutable' USING ERRCODE = '55000';
    END IF;
    IF NEW.cleanup_not_before < OLD.cleanup_not_before THEN
      RAISE EXCEPTION 'cleanup fence cannot move earlier' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT * INTO asset FROM media.assets WHERE id = NEW.asset_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cleanup asset does not exist' USING ERRCODE = '23503';
  END IF;
  IF asset.legacy_object_reconciliation_required THEN
    RAISE EXCEPTION 'unreconciled legacy object cannot be destructively cleaned'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.object_kind IN ('gateway_staging', 'worker_staging')
     AND NEW.object_key = asset.authoritative_object_key
     AND (
       NEW.object_version IS NULL
       OR asset.authoritative_object_version IS NULL
       OR NEW.object_version = asset.authoritative_object_version
     ) THEN
    RAISE EXCEPTION 'losing cleanup cannot target the authoritative object'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.object_kind = 'gateway_staging' THEN
    SELECT * INTO gateway_lease
    FROM media.gateway_upload_leases lease
    WHERE lease.asset_id = NEW.asset_id
      AND lease.capability_generation = NEW.capability_generation
      AND lease.lease_id = NEW.lease_id
    FOR SHARE;
    IF NOT FOUND
       OR gateway_lease.state NOT IN ('failed_cleanup_pending', 'failed_clean')
       OR NEW.object_key IS DISTINCT FROM gateway_lease.staging_object_key
       OR NEW.object_version IS DISTINCT FROM gateway_lease.provider_object_version THEN
      RAISE EXCEPTION 'gateway cleanup must match an exact failed lease identity'
        USING ERRCODE = '55000';
    END IF;
    IF gateway_lease.provider_deadline_at IS NOT NULL
       AND gateway_lease.provider_abort_confirmed_at IS NULL THEN
      RAISE EXCEPTION 'provider abort confirmation is required before cleanup'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NEW.object_kind = 'worker_staging' THEN
    SELECT * INTO worker_lease
    FROM media.worker_processing_leases lease
    WHERE lease.asset_id = NEW.asset_id
      AND lease.processing_generation = NEW.processing_generation
      AND lease.lease_id = NEW.lease_id
    FOR SHARE;
    IF NOT FOUND
       OR worker_lease.state NOT IN ('failed_cleanup_pending', 'failed_clean')
       OR NEW.object_key IS DISTINCT FROM worker_lease.staging_object_key
       OR NEW.object_version IS DISTINCT FROM worker_lease.staging_object_version THEN
      RAISE EXCEPTION 'worker cleanup must match an exact historical processing lease identity'
        USING ERRCODE = '55000';
    END IF;
    IF worker_lease.provider_deadline_at IS NOT NULL
       AND worker_lease.provider_abort_confirmed_at IS NULL THEN
      RAISE EXCEPTION 'provider abort confirmation is required before cleanup'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NEW.object_kind = 'legacy_preallocated'
     AND (
       asset.tombstoned_at IS NULL
       OR NEW.object_key IS DISTINCT FROM asset.legacy_preallocated_object_key
       OR NEW.object_version IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'legacy cleanup must match a tombstoned preallocated object'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.object_kind = 'authoritative_original'
     AND (
       asset.tombstoned_at IS NULL
       OR NEW.object_key IS DISTINCT FROM asset.authoritative_object_key
       OR NEW.object_version IS NULL
       OR NEW.object_version IS DISTINCT FROM asset.authoritative_object_version
     ) THEN
    RAISE EXCEPTION 'authoritative cleanup must match a tombstoned object version'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
       SELECT 1
       FROM media.gateway_upload_leases lease
       WHERE lease.asset_id = NEW.asset_id
         AND lease.provider_deadline_at IS NOT NULL
         AND lease.provider_abort_confirmed_at IS NULL
         AND lease.state <> 'committed'
     )
     OR EXISTS (
       SELECT 1
       FROM media.worker_processing_leases lease
       WHERE lease.asset_id = NEW.asset_id
         AND lease.provider_deadline_at IS NOT NULL
         AND lease.provider_abort_confirmed_at IS NULL
         AND lease.state <> 'committed'
     ) THEN
    RAISE EXCEPTION 'provider abort confirmation is required before cleanup'
      USING ERRCODE = '55000';
  END IF;
  required_fence := media.cleanup_fence_for_asset(NEW.asset_id);
  IF required_fence IS NOT NULL AND NEW.cleanup_not_before < required_fence THEN
    RAISE EXCEPTION 'cleanup fence precedes the greatest persisted write fence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_media_object_cleanup_invariants
BEFORE INSERT OR UPDATE OR DELETE ON media.object_cleanup_tasks
FOR EACH ROW EXECUTE FUNCTION media.enforce_cleanup_task_invariants();

INSERT INTO media.object_cleanup_tasks(
  asset_id,
  object_kind,
  object_key,
  cleanup_not_before
)
SELECT id,
       'legacy_preallocated',
       legacy_preallocated_object_key,
       COALESCE(cleanup_not_before, clock_timestamp())
FROM media.assets
WHERE state = 'deleted' AND legacy_preallocated_object_key IS NOT NULL;

CREATE TABLE media.legacy_asset_reference_quarantine (
  reference_table text NOT NULL CHECK (reference_table = 'events.event_media'),
  reference_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  conflicting_media_asset_id uuid,
  reason text NOT NULL CHECK (reason IN (
    'missing_media_asset', 'conflicting_media_asset_reference'
  )),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  original_created_at timestamptz NOT NULL,
  quarantined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (reference_table, reference_id)
);

INSERT INTO media.legacy_asset_reference_quarantine(
  reference_table,
  reference_id,
  asset_id,
  conflicting_media_asset_id,
  reason,
  details,
  original_created_at
)
SELECT 'events.event_media',
       event_media.id,
       event_media.asset_id,
       event_media.media_asset_id,
       CASE
         WHEN event_media.media_asset_id IS NOT NULL
           AND event_media.media_asset_id <> event_media.asset_id
           THEN 'conflicting_media_asset_reference'
         ELSE 'missing_media_asset'
       END,
       jsonb_build_object(
         'eventId', event_media.event_id,
         'sortOrder', event_media.sort_order
       ),
       event_media.created_at
FROM events.event_media event_media
LEFT JOIN media.assets legacy_asset ON legacy_asset.id = event_media.asset_id
WHERE (event_media.media_asset_id IS NULL AND legacy_asset.id IS NULL)
   OR (
     event_media.media_asset_id IS NOT NULL
     AND event_media.media_asset_id <> event_media.asset_id
   );

UPDATE events.event_media event_media
SET media_asset_id = asset.id,
    content_hash = asset.content_hash
FROM media.assets asset
WHERE event_media.media_asset_id IS NULL
  AND event_media.asset_id = asset.id;

UPDATE events.event_media event_media
SET content_hash = asset.content_hash
FROM media.assets asset
WHERE event_media.media_asset_id = asset.id
  AND event_media.asset_id = asset.id;

ALTER TABLE media.legacy_asset_reference_quarantine ENABLE ROW LEVEL SECURITY;
ALTER TABLE media.legacy_asset_reference_quarantine FORCE ROW LEVEL SECURITY;
CREATE POLICY legacy_asset_reference_quarantine_deny_by_default
  ON media.legacy_asset_reference_quarantine USING (false);
CREATE TRIGGER trg_legacy_asset_reference_quarantine_immutable
BEFORE UPDATE OR DELETE ON media.legacy_asset_reference_quarantine
FOR EACH ROW EXECUTE FUNCTION spott.prevent_mutation();

CREATE TABLE safety.evidence_asset_quarantine (
  evidence_id uuid PRIMARY KEY,
  report_id uuid NOT NULL REFERENCES safety.reports(id),
  asset_id uuid NOT NULL,
  kms_key_ref text NOT NULL,
  stored_content_hash bytea NOT NULL,
  retention_until timestamptz NOT NULL,
  deleted_at timestamptz,
  original_created_at timestamptz NOT NULL,
  survivor_evidence_id uuid,
  reason text NOT NULL CHECK (reason IN (
    'missing_media_asset', 'unverified_media_hash', 'legacy_hash_mismatch',
    'duplicate_report_asset'
  )),
  quarantined_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO safety.evidence_asset_quarantine(
  evidence_id,
  report_id,
  asset_id,
  kms_key_ref,
  stored_content_hash,
  retention_until,
  deleted_at,
  original_created_at,
  reason
)
SELECT evidence.id,
       evidence.report_id,
       evidence.asset_id,
       evidence.kms_key_ref,
       evidence.content_hash,
       evidence.retention_until,
       evidence.deleted_at,
       evidence.created_at,
       CASE
         WHEN asset.id IS NULL THEN 'missing_media_asset'
         WHEN asset.content_hash IS NULL OR octet_length(asset.content_hash) <> 32
           THEN 'unverified_media_hash'
         ELSE 'legacy_hash_mismatch'
       END
FROM safety.evidence_assets evidence
LEFT JOIN media.assets asset ON asset.id = evidence.asset_id
WHERE asset.id IS NULL
   OR asset.content_hash IS NULL
   OR octet_length(asset.content_hash) <> 32
   OR evidence.content_hash IS DISTINCT FROM asset.content_hash;

DELETE FROM safety.evidence_assets evidence
USING safety.evidence_asset_quarantine quarantine
WHERE evidence.id = quarantine.evidence_id;

WITH ranked AS (
  SELECT evidence.*,
         first_value(evidence.id) OVER (
           PARTITION BY evidence.report_id, evidence.asset_id
           ORDER BY evidence.created_at, evidence.id
         ) AS survivor_evidence_id,
         row_number() OVER (
           PARTITION BY evidence.report_id, evidence.asset_id
           ORDER BY evidence.created_at, evidence.id
         ) AS ordinal
  FROM safety.evidence_assets evidence
)
INSERT INTO safety.evidence_asset_quarantine(
  evidence_id,
  report_id,
  asset_id,
  kms_key_ref,
  stored_content_hash,
  retention_until,
  deleted_at,
  original_created_at,
  survivor_evidence_id,
  reason
)
SELECT ranked.id,
       ranked.report_id,
       ranked.asset_id,
       ranked.kms_key_ref,
       ranked.content_hash,
       ranked.retention_until,
       ranked.deleted_at,
       ranked.created_at,
       ranked.survivor_evidence_id,
       'duplicate_report_asset'
FROM ranked
WHERE ranked.ordinal > 1;

DELETE FROM safety.evidence_assets evidence
USING safety.evidence_asset_quarantine quarantine
WHERE evidence.id = quarantine.evidence_id
  AND quarantine.reason = 'duplicate_report_asset';

ALTER TABLE safety.evidence_assets ADD COLUMN sort_order integer;

WITH ordered AS (
  SELECT id,
         row_number() OVER (PARTITION BY report_id ORDER BY created_at, id) - 1 AS position
  FROM safety.evidence_assets
)
UPDATE safety.evidence_assets evidence
SET sort_order = ordered.position
FROM ordered
WHERE evidence.id = ordered.id;

UPDATE safety.evidence_assets evidence
SET content_hash = asset.content_hash
FROM media.assets asset
WHERE asset.id = evidence.asset_id;

ALTER TABLE safety.evidence_assets
  ALTER COLUMN sort_order SET NOT NULL,
  ADD CONSTRAINT evidence_assets_sort_order_check CHECK (sort_order >= 0),
  ADD CONSTRAINT evidence_assets_content_hash_check CHECK (octet_length(content_hash) = 32),
  ADD CONSTRAINT evidence_assets_asset_id_fkey
    FOREIGN KEY (asset_id) REFERENCES media.assets(id);

CREATE UNIQUE INDEX uq_media_assets_id_content_hash
  ON media.assets(id, content_hash);
ALTER TABLE media.report_receipt_evidence
  ADD CONSTRAINT report_receipt_evidence_verified_content_fkey
    FOREIGN KEY (asset_id, verified_content_hash)
    REFERENCES media.assets(id, content_hash);
ALTER TABLE safety.evidence_assets
  ADD CONSTRAINT evidence_assets_verified_content_fkey
    FOREIGN KEY (asset_id, content_hash) REFERENCES media.assets(id, content_hash);
CREATE UNIQUE INDEX uq_evidence_assets_report_sort
  ON safety.evidence_assets(report_id, sort_order);
CREATE UNIQUE INDEX uq_evidence_assets_report_asset
  ON safety.evidence_assets(report_id, asset_id);
CREATE INDEX ix_evidence_assets_asset_id
  ON safety.evidence_assets(asset_id);

ALTER TABLE safety.evidence_asset_quarantine ENABLE ROW LEVEL SECURITY;
ALTER TABLE safety.evidence_asset_quarantine FORCE ROW LEVEL SECURITY;
CREATE POLICY evidence_quarantine_deny_by_default
  ON safety.evidence_asset_quarantine USING (false);
CREATE TRIGGER trg_evidence_asset_quarantine_immutable
BEFORE UPDATE OR DELETE ON safety.evidence_asset_quarantine
FOR EACH ROW EXECUTE FUNCTION spott.prevent_mutation();

CREATE OR REPLACE FUNCTION media.prevent_unreconciled_asset_reference()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  referenced_asset_id uuid;
  reconciliation_required boolean;
BEGIN
  referenced_asset_id := NULLIF(to_jsonb(NEW)->>TG_ARGV[0], '')::uuid;
  IF referenced_asset_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT legacy_object_reconciliation_required
  INTO reconciliation_required
  FROM media.assets
  WHERE id = referenced_asset_id;
  IF reconciliation_required THEN
    RAISE EXCEPTION 'unreconciled legacy asset cannot be attached'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_event_media_reconciled_asset
BEFORE INSERT OR UPDATE OF media_asset_id ON events.event_media
FOR EACH ROW EXECUTE FUNCTION media.prevent_unreconciled_asset_reference('media_asset_id');
CREATE TRIGGER trg_event_media_reconciled_legacy_asset
BEFORE INSERT OR UPDATE OF asset_id ON events.event_media
FOR EACH ROW EXECUTE FUNCTION media.prevent_unreconciled_asset_reference('asset_id');
CREATE TRIGGER trg_profile_reconciled_avatar
BEFORE INSERT OR UPDATE OF avatar_asset_id ON identity.profiles
FOR EACH ROW EXECUTE FUNCTION media.prevent_unreconciled_asset_reference('avatar_asset_id');
CREATE TRIGGER trg_group_reconciled_cover
BEFORE INSERT OR UPDATE OF cover_asset_id ON community.groups
FOR EACH ROW EXECUTE FUNCTION media.prevent_unreconciled_asset_reference('cover_asset_id');
CREATE TRIGGER trg_poster_reconciled_asset
BEFORE INSERT OR UPDATE OF asset_id ON growth.poster_jobs
FOR EACH ROW EXECUTE FUNCTION media.prevent_unreconciled_asset_reference('asset_id');
CREATE TRIGGER trg_evidence_reconciled_asset
BEFORE INSERT OR UPDATE OF asset_id ON safety.evidence_assets
FOR EACH ROW EXECUTE FUNCTION media.prevent_unreconciled_asset_reference('asset_id');

CREATE INDEX IF NOT EXISTS ix_event_media_media_asset
  ON events.event_media(media_asset_id) WHERE media_asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_event_media_legacy_asset
  ON events.event_media(asset_id);
CREATE INDEX IF NOT EXISTS ix_groups_cover_asset
  ON community.groups(cover_asset_id) WHERE cover_asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_poster_jobs_asset
  ON growth.poster_jobs(asset_id) WHERE asset_id IS NOT NULL;

ALTER TABLE identity.account_merge_jobs
  ADD COLUMN failure_code text,
  ADD COLUMN blocked_at timestamptz,
  ADD COLUMN media_collision_json jsonb;
ALTER TABLE identity.account_merge_jobs
  ADD CONSTRAINT account_merge_jobs_media_collision_check
    CHECK (
      (failure_code IS NULL AND blocked_at IS NULL AND media_collision_json IS NULL)
      OR
      (
        failure_code = 'blocked_media_collision'
        AND state = 'failed'
        AND blocked_at IS NOT NULL
        AND jsonb_typeof(media_collision_json) = 'object'
      )
    );

CREATE OR REPLACE FUNCTION media.apply_account_merge(p_job_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  merge_job identity.account_merge_jobs%ROWTYPE;
  collision_kind text;
  collision_key text;
  moved_assets integer;
  moved_receipts integer;
BEGIN
  SELECT * INTO merge_job
  FROM identity.account_merge_jobs
  WHERE id = p_job_id
  FOR UPDATE;
  IF NOT FOUND OR merge_job.state <> 'previewed' THEN
    RAISE EXCEPTION 'account merge job is not executable' USING ERRCODE = '55000';
  END IF;

  PERFORM 1
  FROM identity.users
  WHERE id IN (merge_job.source_user_id, merge_job.target_user_id)
  ORDER BY id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account merge identity is missing' USING ERRCODE = '23503';
  END IF;

  PERFORM 1
  FROM media.assets
  WHERE current_owner_id IN (merge_job.source_user_id, merge_job.target_user_id)
  ORDER BY current_owner_id, id
  FOR UPDATE;
  PERFORM 1
  FROM media.mutation_receipts
  WHERE current_owner_id IN (merge_job.source_user_id, merge_job.target_user_id)
  ORDER BY current_owner_id, operation_type, idempotency_key
  FOR UPDATE;
  PERFORM 1
  FROM media.gateway_upload_leases lease
  JOIN media.assets asset ON asset.id = lease.asset_id
  WHERE asset.current_owner_id IN (merge_job.source_user_id, merge_job.target_user_id)
  ORDER BY asset.current_owner_id, lease.asset_id, lease.capability_generation
  FOR UPDATE OF lease;
  PERFORM 1
  FROM sync.idempotency_keys
  WHERE user_id IN (merge_job.source_user_id, merge_job.target_user_id)
    AND expires_at > clock_timestamp()
    AND resource_type LIKE 'media.%'
  ORDER BY user_id, key
  FOR UPDATE;

  SELECT 'upload_attempt', source.upload_attempt_id::text
  INTO collision_kind, collision_key
  FROM media.assets source
  JOIN media.assets target
    ON target.current_owner_id = merge_job.target_user_id
   AND target.upload_attempt_id = source.upload_attempt_id
  WHERE source.current_owner_id = merge_job.source_user_id
    AND source.upload_attempt_id IS NOT NULL
  ORDER BY source.upload_attempt_id
  LIMIT 1;

  IF collision_kind IS NULL THEN
    SELECT 'mutation_receipt', source.operation_type || ':' || source.idempotency_key::text
    INTO collision_kind, collision_key
    FROM media.mutation_receipts source
    JOIN media.mutation_receipts target
      ON target.current_owner_id = merge_job.target_user_id
     AND target.operation_type = source.operation_type
     AND target.idempotency_key = source.idempotency_key
    WHERE source.current_owner_id = merge_job.source_user_id
    ORDER BY source.operation_type, source.idempotency_key
    LIMIT 1;
  END IF;

  IF collision_kind IS NOT NULL THEN
    UPDATE identity.account_merge_jobs
    SET state = 'failed',
        failure_code = 'blocked_media_collision',
        blocked_at = clock_timestamp(),
        media_collision_json = jsonb_build_object(
          'kind', collision_kind,
          'keyHash', encode(digest(collision_key, 'sha256'), 'hex')
        )
    WHERE id = p_job_id;
    INSERT INTO admin.audit_logs(action, resource, resource_id, purpose, trace_id)
    VALUES (
      'account_merge.blocked_media_collision',
      'identity.account_merge_job',
      p_job_id::text,
      'account_merge_collision_preflight',
      'media-account-merge:' || p_job_id::text
    );
    RETURN 'blocked_media_collision';
  END IF;

  INSERT INTO media.account_merge_transfer_authorizations(
    job_id,
    source_owner_id,
    target_owner_id,
    transaction_id,
    backend_pid,
    state
  ) VALUES (
    p_job_id,
    merge_job.source_user_id,
    merge_job.target_user_id,
    pg_current_xact_id(),
    pg_backend_pid(),
    'active'
  );

  UPDATE media.assets
  SET current_owner_id = merge_job.target_user_id,
      capability_generation = capability_generation + 1,
      row_version = row_version + 1,
      updated_at = clock_timestamp()
  WHERE current_owner_id = merge_job.source_user_id;
  GET DIAGNOSTICS moved_assets = ROW_COUNT;

  UPDATE media.mutation_receipts
  SET current_owner_id = merge_job.target_user_id
  WHERE current_owner_id = merge_job.source_user_id;
  GET DIAGNOSTICS moved_receipts = ROW_COUNT;

  DELETE FROM sync.idempotency_keys generic
  WHERE generic.user_id = merge_job.source_user_id
    AND generic.expires_at > clock_timestamp()
    AND generic.resource_type LIKE 'media.%'
    AND (
      EXISTS (
        SELECT 1 FROM media.assets asset
        WHERE asset.current_owner_id = merge_job.target_user_id
          AND (asset.id = generic.resource_id OR asset.upload_attempt_id = generic.key)
      )
      OR EXISTS (
        SELECT 1 FROM media.mutation_receipts receipt
        WHERE receipt.current_owner_id = merge_job.target_user_id
          AND receipt.idempotency_key = generic.key
      )
      OR EXISTS (
        SELECT 1 FROM media.completion_receipts receipt
        JOIN media.assets asset ON asset.id = receipt.asset_id
        WHERE asset.current_owner_id = merge_job.target_user_id
          AND (receipt.asset_id = generic.resource_id OR receipt.completion_attempt_id = generic.key)
      )
    );

  IF EXISTS (
    SELECT 1 FROM sync.idempotency_keys
    WHERE user_id = merge_job.source_user_id
      AND expires_at > clock_timestamp()
      AND resource_type LIKE 'media.%'
  ) THEN
    RAISE EXCEPTION 'source media idempotency lacks durable target replay proof'
      USING ERRCODE = '55000';
  END IF;

  UPDATE media.account_merge_transfer_authorizations
  SET state = 'committed',
      transferred_asset_count = moved_assets,
      transferred_receipt_count = moved_receipts,
      committed_at = clock_timestamp()
  WHERE job_id = p_job_id
    AND state = 'active'
    AND transaction_id = pg_current_xact_id()
    AND backend_pid = pg_backend_pid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'media owner transfer authorization receipt is missing'
      USING ERRCODE = '55000';
  END IF;

  UPDATE identity.account_merge_jobs
  SET state = 'committed', committed_at = clock_timestamp()
  WHERE id = p_job_id;
  INSERT INTO admin.audit_logs(action, resource, resource_id, purpose, trace_id)
  VALUES (
    'account_merge.media_ownership_committed',
    'identity.account_merge_job',
    p_job_id::text,
    'account_merge_media_transfer',
    'media-account-merge:' || p_job_id::text
  );
  RETURN 'committed';
END;
$$;
REVOKE ALL ON FUNCTION media.apply_account_merge(uuid) FROM PUBLIC;

COMMIT;
