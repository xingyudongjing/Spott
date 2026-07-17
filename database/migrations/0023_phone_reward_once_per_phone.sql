-- Make the phone verification welcome reward payable once per phone number and once per account.
--
-- The reward used to be keyed on identity.phone_bindings.id, which is minted fresh on every bind.
-- Binding a second number (or unbinding and re-binding the same number) therefore produced a new
-- idempotency key and paid the 500 point reward again, an uncapped free-points faucet.
--
-- Two independent guards are introduced:
--   1. commerce.phone_verification_reward_grants, keyed by the HMAC lookup hash of the phone
--      number, enforces "once per phone number, lifetime" across every account.
--   2. A stable business key ('phone_verified:account') on commerce.point_transactions reuses the
--      existing UNIQUE (user_id, business_key) to enforce "once per account".
BEGIN;

CREATE TABLE commerce.phone_verification_reward_grants (
  phone_hash bytea PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  transaction_id uuid REFERENCES commerce.point_transactions(id),
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX ix_phone_verification_reward_grants_user
  ON commerce.phone_verification_reward_grants(user_id);

COMMENT ON TABLE commerce.phone_verification_reward_grants IS
  'Lifetime ledger of phone numbers that have ever unlocked the phone verification welcome reward. Keyed by identity.phone_bindings.phone_hash (HMAC-SHA256 with LOOKUP_HMAC_PEPPER), never by plaintext.';

-- Backfill from history BEFORE the business keys are normalised below: the legacy business key is
-- the only link from an existing reward back to the phone number it was paid for. Rewards whose
-- binding row has since been purged (account deletion) cannot be recovered and are skipped; those
-- numbers stay eligible once, which is the conservative direction for existing users.
INSERT INTO commerce.phone_verification_reward_grants(phone_hash, user_id, transaction_id, granted_at)
SELECT DISTINCT ON (binding.phone_hash)
  binding.phone_hash, reward.user_id, reward.id, reward.created_at
FROM commerce.point_transactions AS reward
JOIN identity.phone_bindings AS binding
  ON binding.id = substring(reward.business_key FROM 'phone_verified:(.*)$')::uuid
WHERE reward.type = 'phone_verified_reward'
  AND reward.business_key ~ '^phone_verified:[0-9a-fA-F-]{36}$'
ORDER BY binding.phone_hash, reward.created_at, reward.id
ON CONFLICT (phone_hash) DO NOTHING;

-- Collapse each account's historical rewards onto the new stable business key. Only the earliest
-- reward per account is renamed, so the UNIQUE (user_id, business_key) constraint holds and any
-- already-granted duplicate points stay untouched -- clawing points back needs operations approval,
-- but the renamed row is what now blocks every future duplicate grant for that account.
UPDATE commerce.point_transactions AS reward
SET business_key = 'phone_verified:account'
FROM (
  SELECT DISTINCT ON (user_id) id
  FROM commerce.point_transactions
  WHERE type = 'phone_verified_reward'
    AND business_key LIKE 'phone_verified:%'
  ORDER BY user_id, created_at, id
) AS earliest
WHERE reward.id = earliest.id;

COMMIT;
