-- Close audited identity, media, group transfer, and public profile contract gaps.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_avatar_asset_id_fkey'
      AND conrelid = 'identity.profiles'::regclass
  ) THEN
    ALTER TABLE identity.profiles
      ADD CONSTRAINT profiles_avatar_asset_id_fkey
      FOREIGN KEY (avatar_asset_id) REFERENCES media.assets(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_profiles_avatar_asset
  ON identity.profiles(avatar_asset_id)
  WHERE avatar_asset_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS identity.auth_credential_uses (
  provider identity.identity_provider NOT NULL,
  credential_hash bytea NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('account_merge')),
  used_by uuid NOT NULL REFERENCES identity.users(id),
  used_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider, credential_hash, purpose)
);
CREATE INDEX IF NOT EXISTS ix_auth_credential_uses_used_at
  ON identity.auth_credential_uses(used_at);

COMMIT;
