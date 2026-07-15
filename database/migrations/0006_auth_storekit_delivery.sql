BEGIN;

ALTER TABLE identity.email_challenges
  ADD COLUMN suspended_until timestamptz;

CREATE INDEX ix_email_challenges_suspension
  ON identity.email_challenges(suspended_until)
  WHERE suspended_until IS NOT NULL AND verified_at IS NULL;

CREATE INDEX ix_phone_challenges_suspension
  ON identity.phone_challenges(suspended_until)
  WHERE suspended_until IS NOT NULL AND verified_at IS NULL;

ALTER TABLE identity.account_merge_jobs
  ADD COLUMN verification_hash bytea,
  ADD COLUMN idempotency_key text;

CREATE UNIQUE INDEX ux_account_merge_idempotency
  ON identity.account_merge_jobs(source_user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE commerce.store_orders
  ADD COLUMN environment text NOT NULL DEFAULT 'Production'
    CHECK (environment IN ('Sandbox', 'Production')),
  ADD COLUMN storefront text,
  ADD COLUMN app_account_token uuid,
  ADD COLUMN revocation_reason integer,
  ADD COLUMN revoked_at timestamptz;

CREATE INDEX ix_store_orders_original_transaction
  ON commerce.store_orders(store, original_transaction_id);

CREATE TABLE commerce.store_webhook_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  store text NOT NULL CHECK (store = 'apple'),
  notification_uuid uuid NOT NULL,
  notification_type text NOT NULL,
  subtype text,
  signed_payload_hash bytea NOT NULL,
  payload_json jsonb NOT NULL,
  state text NOT NULL DEFAULT 'received'
    CHECK (state IN ('received', 'processed', 'ignored', 'failed')),
  failure_code text,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (store, notification_uuid)
);

CREATE TRIGGER trg_store_webhook_events_immutable
BEFORE UPDATE OF store, notification_uuid, notification_type, subtype,
  signed_payload_hash, payload_json, created_at
ON commerce.store_webhook_events
FOR EACH ROW EXECUTE FUNCTION spott.prevent_mutation();

COMMIT;
