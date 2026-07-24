-- Email + password authentication credentials.
--
-- Adds a dedicated credential table so users can register and log in with email + password
-- before the SMS provider lands. The canonical identity row stays in identity.auth_identities
-- (provider = 'email', subject = HMAC lookup hash of the email), exactly like OTP signup; this
-- table only carries the login secret and the plaintext email needed for credential lookup.
--
-- password_hash is an scrypt digest produced by the API (N=16384, r=8, p=1, random 16-byte
-- salt) encoded as 'scrypt:16384:8:1:<salt hex>:<hash hex>'. The database never sees plaintext
-- passwords. CITEXT keeps email uniqueness case-insensitive.
BEGIN;

CREATE TABLE identity.user_credentials (
  user_id uuid PRIMARY KEY REFERENCES identity.users(id),
  email citext NOT NULL UNIQUE,
  password_hash text NOT NULL CHECK (password_hash <> ''),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (char_length(email) <= 254)
);

COMMENT ON TABLE identity.user_credentials IS
  'Email + password login credentials: one row per user, scrypt digest only (never plaintext). Identity linkage lives in identity.auth_identities.';

COMMIT;
