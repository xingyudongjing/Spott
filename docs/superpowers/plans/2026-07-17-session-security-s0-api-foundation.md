# Session Security S0 API Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Also use superpowers:test-driven-development, superpowers:systematic-debugging, and superpowers:verification-before-completion. Every numbered task requires a fresh independent review before the next task begins.

**Goal:** Build and verify the additive PostgreSQL and API security foundation required for a future memory-only Web session cutover, without changing the current Web client, browser storage, login flow, or deployment behavior.

**Architecture:** Migration 0021 adds stable session generations, immutable transport authority, refresh history, BFF nonce replay protection, persistent device-binding storage, and legacy-migration records while keeping old session inserts compatible. The API then gains versioned keyrings, canonical HMAC framing, a fail-closed BFF authority verifier, stable refresh rotation with exact-successor recovery only for the same independent attempt plus valid binding proof, committed reuse revocation, and DB-backed access authorization. Existing native, Ops, and direct-Web clients retain first-use compatibility while WEB_SESSION_BFF_ENFORCEMENT remains off; no browser Cookie/BFF route or localStorage behavior changes in S0.

**Tech Stack:** PostgreSQL 18, TypeScript 6, Node.js 24, NestJS/Fastify, pg, jose, zod, Vitest, OpenAPI/Redocly, openapi-typescript.

## Global Constraints

- S0 is server-only. Do not modify any file under apps/web, any Swift/iOS file, or any browser-storage behavior.
- S0 must not claim that Web access or refresh tokens have been removed. The current Web remains legacy_unclassified until S1.
- Create only database/migrations/0021_web_session_security.sql. Never edit migrations 0001 through 0020.
- Preserve the current native request body POST /auth/refresh with refreshToken and deviceId and preserve the full native AuthSession response.
- Additive optional attempt and binding fields must not break existing iOS or Ops clients.
- A current unconsumed legacy/native/Ops refresh credential may rotate once without the new proofs. A consumed predecessor without both the original independent attempt and route-correct binding proof must return reauthentication and must never receive a successor.
- A stored web_bff or ops transport class is hard authority in off, observe, and enforce. Missing browser headers, forged platform fields, and headerless curl must never downgrade it.
- WEB_SESSION_BFF_ENFORCEMENT controls only new direct-Web issuance and legacy_unclassified behavior. It is not a bypass for web_bff or ops.
- HMAC/KDF framing uses unsigned 32-bit big-endian byte lengths, UTF-8 NFC strings, fixed field order, authenticated version and KID, and purpose-separated contexts.
- SPOTT_WEB_BFF_KEYS and REFRESH_TOKEN_DERIVATION_KEYS are independent versioned keyrings. Never derive either from ACCESS_TOKEN_SECRET or REFRESH_TOKEN_SECRET.
- BFF nonce storage is PostgreSQL-backed. A duplicate nonce or unavailable nonce store fails closed.
- Reuse revocation must commit before REFRESH_TOKEN_REUSED is mapped to HTTP 401. Never throw that HTTP/domain error inside the mutation transaction.
- Unknown random refresh material must return invalid without revoking a session family.
- Logs and diagnostics must redact Authorization, Cookie, refresh credentials, binding proof, BFF signature, key material, and raw authentication bodies.
- API lint, typecheck, full tests, integration tests, contract generation, migration replay, and git diff checks are mandatory gates. Existing repository lint debt is not an acceptable production exception.

---

## Strict File Scope

### Create

- database/migrations/0021_web_session_security.sql
- services/api/src/platform/web-bff-authority.ts
- services/api/src/platform/web-bff-authority.spec.ts
- services/api/src/platform/session-authority.ts
- services/api/src/platform/session-authority.spec.ts
- services/api/src/modules/auth/session-token.service.ts
- services/api/src/modules/auth/session-token.service.spec.ts
- services/api/src/modules/auth/auth.session-migration.spec.ts
- services/api/src/modules/auth/auth.session-migration.integration.spec.ts
- services/api/src/modules/auth/auth.session.integration.spec.ts
- services/api/src/modules/auth/web-bff-boundary.integration.spec.ts

### Modify

- .env.example
- services/api/src/config.ts
- services/api/src/config.spec.ts
- services/api/src/main.ts
- services/api/src/platform/request-context.ts
- services/api/src/platform/platform.module.ts
- services/api/src/platform/auth.guard.ts
- services/api/src/platform/auth.guard.spec.ts
- services/api/src/modules/auth/auth.module.ts
- services/api/src/modules/auth/auth.controller.ts
- services/api/src/modules/auth/auth.service.ts
- services/api/src/modules/auth/auth.service.spec.ts
- services/api/src/modules/ops/ops.controller.ts
- services/api/package.json
- services/api/vitest.integration.config.ts
- scripts/test-postgis.ts
- packages/contracts/openapi.yaml
- packages/contracts/openapi.bundle.yaml
- packages/api-client/src/schema.d.ts
- packages/api-client/test/client.test.ts

### Forbidden in S0

- apps/web/**
- Spott/**
- SpottTests/**
- SpottUITests/**
- database/migrations/0001* through database/migrations/0020*
- Any production DNS, keyring, secret-manager, or enforcement-mode mutation

## Interfaces Locked for All Tasks

~~~ts
export type SessionTransportClass =
  | 'web_bff'
  | 'native'
  | 'ops'
  | 'legacy_unclassified';

export type WebSessionBFFEnforcement = 'off' | 'observe' | 'enforce';

export interface DeviceBindingProof {
  bindingId: string;
  generation: number;
  proof: string;
}

export interface RefreshMutationInput {
  refreshToken: string;
  deviceId: string;
  attemptKey?: string;
  deviceBindingProof?: DeviceBindingProof;
}

export type RefreshMutationOutcome =
  | { kind: 'rotated'; session: SessionResponse }
  | { kind: 'recovered'; session: SessionResponse }
  | { kind: 'reused'; sessionId: string; familyId: string }
  | { kind: 'reauth_required' }
  | { kind: 'invalid' };

export interface VerifiedBFFAuthority {
  version: 'v1';
  kid: string;
  timestamp: number;
  nonceHash: Buffer;
}
~~~

The new refresh token grammar is:

~~~text
s2.<stable-session-uuid>.<generation-base10>.<base64url-32-byte-secret>
~~~

The parser must continue accepting the existing legacy grammar:

~~~text
<session-uuid>.<base64url-secret>
~~~

Legacy current credentials receive a one-time random successor and no consumed-token recovery. New proof-bearing credentials receive a deterministic, versioned successor that can be reconstructed only for the same attempt and binding while that direct successor remains current.

---

### Task 1: Add the 0021 migration and prove replay/checksum safety

**Files:**

- Create: database/migrations/0021_web_session_security.sql
- Create: services/api/src/modules/auth/auth.session-migration.spec.ts
- Create: services/api/src/modules/auth/auth.session-migration.integration.spec.ts
- Modify: scripts/test-postgis.ts
- Modify: services/api/package.json

**Interfaces:**

- Produces identity.sessions.refresh_generation as bigint, never negative.
- Produces immutable identity.sessions.transport_class.
- Produces identity.session_refresh_history keyed by session_id and generation, with token_hash unique.
- Produces identity.web_bff_request_nonces, identity.device_bindings, identity.web_migration_intents, and identity.web_legacy_migrations.
- Keeps an old API insert that omits new columns valid through migration-owned triggers.

- [x] **Step 1: Write the structural RED test**

Create auth.session-migration.spec.ts with exact assertions that 0021 exists, earlier migration checksums are not rewritten, and the source contains the required schema and triggers:

~~~ts
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../../..');
const migration0020 = resolve(root, 'database/migrations/0020_sync_correctness.sql');
const migration0021 = resolve(root, 'database/migrations/0021_web_session_security.sql');

describe('0021 Web session security migration', () => {
  it('is additive and contains every security-owned table and trigger', () => {
    expect(existsSync(migration0021)).toBe(true);
    const sql = readFileSync(migration0021, 'utf8');
    expect(sql).toContain('refresh_generation');
    expect(sql).toContain('transport_class');
    expect(sql).toContain('identity.session_refresh_history');
    expect(sql).toContain('identity.web_bff_request_nonces');
    expect(sql).toContain('identity.device_bindings');
    expect(sql).toContain('identity.web_migration_intents');
    expect(sql).toContain('identity.web_legacy_migrations');
    expect(sql).toMatch(/BEFORE\s+UPDATE\s+ON\s+identity\.sessions/i);
    expect(sql).toMatch(/AFTER\s+INSERT\s+ON\s+identity\.sessions/i);
  });

  it('pins the current 0020 source checksum', () => {
    const checksum = createHash('sha256')
      .update(readFileSync(migration0020))
      .digest('hex');
    expect(checksum).toBe('c748cfbcf753f33ddc74aceee68db0ec040f4126f0d5ef2621de55558ac1b984');
  });
});
~~~

The pinned value above is the pre-S0 checksum. Reconfirm it before implementing 0021 with:

~~~bash
shasum -a 256 database/migrations/0020_sync_correctness.sql
~~~

The command must print c748cfbcf753f33ddc74aceee68db0ec040f4126f0d5ef2621de55558ac1b984. Do not calculate the expected value from 0020 inside the assertion.

- [x] **Step 2: Run the structural test and confirm RED**

Run:

~~~bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
pnpm --filter @spott/api exec vitest run \
  src/modules/auth/auth.session-migration.spec.ts
~~~

Expected: FAIL because database/migrations/0021_web_session_security.sql is absent.

- [x] **Step 3: Write migration 0021**

The migration must execute in one transaction and implement these exact invariants:

~~~sql
BEGIN;

ALTER TABLE identity.sessions
  ADD COLUMN refresh_generation bigint NOT NULL DEFAULT 0
    CHECK (refresh_generation >= 0),
  ADD COLUMN transport_class text,
  ADD COLUMN current_derivation_kid text,
  ADD COLUMN current_binding_id uuid,
  ADD COLUMN current_binding_generation bigint
    CHECK (current_binding_generation IS NULL OR current_binding_generation >= 0);

UPDATE identity.sessions AS session
SET transport_class = CASE device.platform
  WHEN 'ios' THEN 'native'
  WHEN 'ops' THEN 'ops'
  ELSE 'legacy_unclassified'
END
FROM identity.devices AS device
WHERE device.id = session.device_id;

ALTER TABLE identity.sessions
  ALTER COLUMN transport_class SET NOT NULL,
  ADD CONSTRAINT sessions_transport_class_check
    CHECK (transport_class IN ('web_bff','native','ops','legacy_unclassified'));

CREATE TABLE identity.session_refresh_history (
  session_id uuid NOT NULL REFERENCES identity.sessions(id) ON DELETE CASCADE,
  family_id uuid NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 0),
  token_hash bytea NOT NULL UNIQUE,
  derivation_kid text,
  transport_class text NOT NULL
    CHECK (transport_class IN ('web_bff','native','ops','legacy_unclassified')),
  binding_id uuid,
  binding_generation bigint,
  state text NOT NULL CHECK (state IN ('current','consumed','revoked')),
  consumed_reason text,
  consumed_at timestamptz,
  rotation_key_hash bytea,
  successor_generation bigint,
  successor_hash bytea,
  successor_derivation_kid text,
  recovery_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (session_id, generation),
  CHECK (
    (state = 'current' AND consumed_at IS NULL)
    OR (state <> 'current' AND consumed_at IS NOT NULL)
  )
);

CREATE TABLE identity.web_bff_request_nonces (
  signing_kid text NOT NULL,
  nonce_hash bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (signing_kid, nonce_hash)
);

CREATE TABLE identity.device_bindings (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES identity.users(id),
  device_id uuid NOT NULL REFERENCES identity.devices(id),
  session_id uuid REFERENCES identity.sessions(id) ON DELETE CASCADE,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  current_hash bytea NOT NULL,
  current_kid text NOT NULL,
  previous_hash bytea,
  previous_grace_expires_at timestamptz,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  absolute_expires_at timestamptz NOT NULL,
  rotated_at timestamptz,
  revoked_at timestamptz,
  proof_class text NOT NULL DEFAULT 'persistent'
    CHECK (proof_class = 'persistent'),
  UNIQUE (user_id, device_id, id)
);

CREATE TABLE identity.web_migration_intents (
  id uuid PRIMARY KEY,
  attempt_hash bytea NOT NULL UNIQUE,
  temporary_binding_hash bytea NOT NULL UNIQUE,
  mac_version text NOT NULL,
  mac_kid text NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  terminal_status text
    CHECK (terminal_status IN ('migrated','revoked','expired','invalid')),
  proof_class text NOT NULL DEFAULT 'migration_temporary'
    CHECK (proof_class = 'migration_temporary'),
  CHECK (expires_at <= issued_at + interval '10 minutes')
);

CREATE TABLE identity.web_legacy_migrations (
  legacy_token_hash bytea PRIMARY KEY,
  intent_id uuid NOT NULL UNIQUE
    REFERENCES identity.web_migration_intents(id),
  attempt_hash bytea NOT NULL,
  outcome_session_id uuid NOT NULL REFERENCES identity.sessions(id),
  outcome_generation bigint NOT NULL CHECK (outcome_generation >= 0),
  outcome_binding_id uuid REFERENCES identity.device_bindings(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX ix_sessions_active_user_device
  ON identity.sessions(user_id, device_id, refresh_generation DESC)
  WHERE revoked_at IS NULL;
CREATE INDEX ix_refresh_history_predecessor
  ON identity.session_refresh_history(token_hash, recovery_expires_at)
  WHERE state = 'consumed';
CREATE INDEX ix_bff_nonce_expiry
  ON identity.web_bff_request_nonces(expires_at);
CREATE INDEX ix_device_bindings_active
  ON identity.device_bindings(user_id, device_id, generation DESC)
  WHERE revoked_at IS NULL;

~~~

Continue the same transaction with these compatibility and immutability operations:

~~~sql
CREATE OR REPLACE FUNCTION identity.assign_session_security_defaults()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = identity, pg_temp
AS $$
DECLARE
  stored_platform text;
BEGIN
  IF NEW.transport_class IS NULL THEN
    SELECT platform INTO STRICT stored_platform
    FROM identity.devices
    WHERE id = NEW.device_id;
    NEW.transport_class := CASE stored_platform
      WHEN 'ios' THEN 'native'
      WHEN 'ops' THEN 'ops'
      ELSE 'legacy_unclassified'
    END;
  END IF;
  NEW.refresh_generation := COALESCE(NEW.refresh_generation, 0);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_session_security_defaults
BEFORE INSERT ON identity.sessions
FOR EACH ROW EXECUTE FUNCTION identity.assign_session_security_defaults();

CREATE OR REPLACE FUNCTION identity.reject_session_transport_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = identity, pg_temp
AS $$
BEGIN
  IF NEW.transport_class IS DISTINCT FROM OLD.transport_class THEN
    RAISE EXCEPTION 'session transport_class is immutable'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_session_transport_immutable
BEFORE UPDATE ON identity.sessions
FOR EACH ROW EXECUTE FUNCTION identity.reject_session_transport_change();

INSERT INTO identity.session_refresh_history(
  session_id, family_id, generation, token_hash, derivation_kid,
  transport_class, state
)
SELECT
  id, refresh_family_id, refresh_generation, refresh_hash,
  current_derivation_kid, transport_class, 'current'
FROM identity.sessions
ON CONFLICT (session_id, generation) DO NOTHING;

CREATE OR REPLACE FUNCTION identity.insert_initial_session_history()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = identity, pg_temp
AS $$
BEGIN
  INSERT INTO identity.session_refresh_history(
    session_id, family_id, generation, token_hash, derivation_kid,
    transport_class, state
  ) VALUES (
    NEW.id, NEW.refresh_family_id, NEW.refresh_generation, NEW.refresh_hash,
    NEW.current_derivation_kid, NEW.transport_class, 'current'
  )
  ON CONFLICT (session_id, generation) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_session_initial_history
AFTER INSERT ON identity.sessions
FOR EACH ROW EXECUTE FUNCTION identity.insert_initial_session_history();

CREATE OR REPLACE FUNCTION identity.reject_temporary_proof_as_persistent()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = identity, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM identity.web_migration_intents
    WHERE temporary_binding_hash = NEW.current_hash
       OR (NEW.previous_hash IS NOT NULL
           AND temporary_binding_hash = NEW.previous_hash)
  ) THEN
    RAISE EXCEPTION 'migration proof cannot become persistent binding'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_persistent_proof_class
BEFORE INSERT OR UPDATE OF current_hash, previous_hash
ON identity.device_bindings
FOR EACH ROW EXECUTE FUNCTION identity.reject_temporary_proof_as_persistent();

CREATE OR REPLACE FUNCTION identity.reject_persistent_proof_as_temporary()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = identity, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM identity.device_bindings
    WHERE current_hash = NEW.temporary_binding_hash
       OR previous_hash = NEW.temporary_binding_hash
  ) THEN
    RAISE EXCEPTION 'persistent binding cannot become migration proof'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_temporary_proof_class
BEFORE INSERT OR UPDATE OF temporary_binding_hash
ON identity.web_migration_intents
FOR EACH ROW EXECUTE FUNCTION identity.reject_persistent_proof_as_temporary();

ALTER TABLE identity.sessions
  ADD CONSTRAINT sessions_current_binding_fkey
  FOREIGN KEY (current_binding_id)
  REFERENCES identity.device_bindings(id);

COMMIT;
~~~

- [x] **Step 4: Add the real PostgreSQL migration RED test**

Create auth.session-migration.integration.spec.ts. Seed one ios, one ops, and one web device with old-format sessions before applying 0021, then assert:

~~~ts
expect(rows).toEqual([
  expect.objectContaining({ platform: 'ios', transport_class: 'native', refresh_generation: '0' }),
  expect.objectContaining({ platform: 'ops', transport_class: 'ops', refresh_generation: '0' }),
  expect.objectContaining({ platform: 'web', transport_class: 'legacy_unclassified', refresh_generation: '0' }),
]);
expect(historyRows).toHaveLength(3);
await expect(changeTransport('native', 'web_bff')).rejects.toMatchObject({ code: 'P0001' });
~~~

Add an old-format INSERT that omits every new column and assert the trigger creates its current history row.

- [x] **Step 5: Make the integration runner discover every integration spec**

Update scripts/test-postgis.ts so a literal argument --all recursively discovers services/api/src/**/*.integration.spec.ts, sorts paths, and passes all of them to Vitest. Update services/api/package.json:

~~~json
{
  "scripts": {
    "test:integration": "tsx ../../scripts/test-postgis.ts --all"
  }
}
~~~

The runner must apply migrations through the normal schema_migrations table twice against the same isolated PostgreSQL database. The second pass must report every migration as already applied and must compare the stored checksum for 0020 with the pinned pre-implementation checksum.

- [x] **Step 6: Run migration tests twice and confirm GREEN**

Run:

~~~bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
pnpm --filter @spott/api exec vitest run \
  src/modules/auth/auth.session-migration.spec.ts

SPOTT_TEST_DATABASE_URL=postgres://127.0.0.1:55432/spott_session_security_test \
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
pnpm --filter @spott/api test:integration

SPOTT_TEST_DATABASE_URL=postgres://127.0.0.1:55432/spott_session_security_test \
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
pnpm --filter @spott/api test:integration
~~~

Expected: both integration invocations pass; the second does not reapply or mutate 0020/0021.

- [ ] **Step 7: Review and commit Task 1**

Require independent DB/security review with no Critical or Important finding. Then:

~~~bash
git add database/migrations/0021_web_session_security.sql \
  services/api/src/modules/auth/auth.session-migration.spec.ts \
  services/api/src/modules/auth/auth.session-migration.integration.spec.ts \
  scripts/test-postgis.ts services/api/package.json
git commit -m "feat(api): add stable session security schema"
~~~

---

### Task 2: Add versioned keyrings and canonical HMAC framing

**Files:**

- Modify: .env.example
- Modify: services/api/src/config.ts
- Modify: services/api/src/config.spec.ts
- Create: services/api/src/platform/web-bff-authority.ts
- Create: services/api/src/platform/web-bff-authority.spec.ts

**Interfaces:**

- parseVersionedKeyring(value, currentKid) returns a readonly Map of KID to key bytes plus currentKid.
- frameFields(fields) emits four-byte big-endian byte length followed by the UTF-8 NFC bytes for every field.
- signBFFAuthority and verifyBFFAuthority use context spott:web-bff-authority.

- [x] **Step 1: Write configuration RED tests**

Add tests that reject empty, duplicate, unknown-current, short, and cross-reused keyrings:

~~~ts
it.each([
  ['', 'bff-current'],
  ['bff-current:YWJj,bff-current:ZGVm', 'bff-current'],
  ['bff-old:MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY', 'bff-current'],
])('rejects invalid BFF keyring %s', (keys, currentKid) => {
  expect(() => parseConfiguration(baseEnvironment({
    SPOTT_WEB_BFF_KEYS: keys,
    SPOTT_WEB_BFF_CURRENT_KID: currentKid,
  }))).toThrow();
});

it('rejects using the same decoded key in both keyrings', () => {
  const shared = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY';
  expect(() => parseConfiguration(baseEnvironment({
    SPOTT_WEB_BFF_KEYS: 'bff-current:' + shared,
    SPOTT_WEB_BFF_CURRENT_KID: 'bff-current',
    REFRESH_TOKEN_DERIVATION_KEYS: 'refresh-current:' + shared,
    REFRESH_TOKEN_DERIVATION_CURRENT_KID: 'refresh-current',
  }))).toThrow();
});
~~~

- [x] **Step 2: Run config tests and confirm RED**

Run:

~~~bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
pnpm --filter @spott/api exec vitest run src/config.spec.ts
~~~

Expected: FAIL because the new configuration fields do not exist.

- [x] **Step 3: Implement strict keyring configuration**

Add required production/test configuration:

~~~text
SPOTT_WEB_BFF_KEYS=bff-2026-07:MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY
SPOTT_WEB_BFF_CURRENT_KID=bff-2026-07
REFRESH_TOKEN_DERIVATION_KEYS=refresh-2026-07:ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA
REFRESH_TOKEN_DERIVATION_CURRENT_KID=refresh-2026-07
WEB_SESSION_BFF_ENFORCEMENT=off
WEB_SESSION_RECOVERY_SECONDS=120
SPOTT_WEB_CANONICAL_ORIGIN=https://spott.jp
~~~

Parsing must reject duplicate KIDs, duplicate decoded keys across purposes, unknown current KIDs, padding/non-canonical base64url, and keys shorter than 32 bytes. Configuration errors must name the variable but never print key values.

- [x] **Step 4: Write the fixed-vector RED test**

Use this committed vector:

~~~ts
it('matches the committed BFF authority fixed vector', () => {
  const bodyHash = 'b9e9bfd687bf53a9ceb4de7c56bf4b78ae43e157f03f31556f39a007b36da6ad';
  const signature = signBFFAuthority({
    key: Buffer.from('0123456789abcdef0123456789abcdef'),
    version: 'v1',
    kid: 'bff-2026-07',
    method: 'POST',
    path: '/v1/auth/refresh',
    timestamp: 1784246400000,
    nonce: 'nonce-0000000000000000000000000001',
    bodyHash,
  });
  expect(signature).toBe('9hpIJXAoFYB0tzzG6dzzVjOxLHkqbwZDOvEiPPFrjaM');
});
~~~

Add one-bit/version/KID/path/body mutations and assert all fail constant-time verification.

- [x] **Step 5: Implement framing and fixed-vector verification**

Implement frameFields with this exact behavior:

~~~ts
export function frameFields(fields: readonly string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const field of fields) {
    const bytes = Buffer.from(field.normalize('NFC'), 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    chunks.push(length, bytes);
  }
  return Buffer.concat(chunks);
}
~~~

The BFF frame field order is context, version, KID, uppercase method, canonical path, base-10 timestamp, nonce, lowercase hexadecimal raw-body SHA-256.

- [x] **Step 6: Run fixed-vector/config tests and confirm GREEN**

Run:

~~~bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
pnpm --filter @spott/api exec vitest run \
  src/config.spec.ts src/platform/web-bff-authority.spec.ts
~~~

Expected: PASS.

- [ ] **Step 7: Review and commit Task 2**

~~~bash
git add .env.example services/api/src/config.ts services/api/src/config.spec.ts \
  services/api/src/platform/web-bff-authority.ts \
  services/api/src/platform/web-bff-authority.spec.ts
git commit -m "feat(api): add versioned session security keyrings"
~~~

---

### Task 3: Enforce BFF nonce replay protection and transport authority

**Files:**

- Modify: services/api/src/main.ts
- Modify: services/api/src/platform/request-context.ts
- Modify: services/api/src/platform/platform.module.ts
- Modify: services/api/src/platform/web-bff-authority.ts
- Modify: services/api/src/platform/web-bff-authority.spec.ts
- Create: services/api/src/modules/auth/web-bff-boundary.integration.spec.ts

**Interfaces:**

- verifyRequest(request) returns VerifiedBFFAuthority only after signature, time-window, and one-time nonce insert succeed.
- decideTransport(input) returns allow, reject, or allow_observed without reclassifying an existing row.
- SpottRequest exposes rawBody as Buffer and verifiedBFFAuthority as optional verified metadata.

- [x] **Step 1: Write the complete RED decision matrix**

~~~ts
const modes = ['off', 'observe', 'enforce'] as const;

it.each(modes)('always rejects unsigned stored web_bff in %s', (mode) => {
  expect(decideTransport({
    mode,
    storedTransport: 'web_bff',
    route: 'refresh',
    authority: 'missing',
  })).toEqual({ kind: 'reject', code: 'WEB_BFF_AUTHORITY_REQUIRED' });
});

it.each(modes)('never routes stored ops through consumer BFF in %s', (mode) => {
  expect(decideTransport({
    mode,
    storedTransport: 'ops',
    route: 'refresh',
    authority: 'valid',
  })).toEqual({ kind: 'reject', code: 'SESSION_TRANSPORT_MISMATCH' });
});

it.each([
  ['off', 'allow'],
  ['observe', 'allow_observed'],
  ['enforce', 'reject'],
] as const)('classifies new unsigned direct Web in %s as %s', (mode, expected) => {
  expect(decideTransport({
    mode,
    storedTransport: null,
    route: 'new_consumer_web_session',
    authority: 'missing',
  }).kind).toBe(expected);
});
~~~

Also assert native remains native in all three modes and legacy_unclassified never receives consumed-token recovery.

- [x] **Step 2: Write nonce RED tests**

Test valid insert, duplicate insert, expired timestamp, future timestamp, unknown KID, malformed nonce, and database failure. Duplicate and DB failure both return a safe authority error and never invoke the controller callback.

- [x] **Step 3: Run authority tests and confirm RED**

Run:

~~~bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
pnpm --filter @spott/api exec vitest run \
  src/platform/web-bff-authority.spec.ts
~~~

Expected: FAIL on nonce persistence and matrix decisions.

- [x] **Step 4: Enable exact raw-body verification**

Set Nest rawBody support without changing parsed controller bodies. Add the BFF headers to server-side request typing, but do not trust or expose them as user authority before verification. Extend logger redaction for:

~~~text
req.headers.x-spott-bff-signature
req.headers.x-spott-device-binding
body.refreshToken
body.deviceBindingProof
rawBody
~~~

- [x] **Step 5: Implement atomic nonce consumption**

After signature and clock-window verification:

~~~sql
INSERT INTO identity.web_bff_request_nonces(signing_kid, nonce_hash, expires_at)
VALUES ($1, $2, to_timestamp($3 / 1000.0) + interval '2 minutes')
ON CONFLICT DO NOTHING
RETURNING nonce_hash;
~~~

Require exactly one returned row. Delete expired nonces only in a bounded cleanup query after the successful insert; cleanup failure must not convert a rejected replay into success.

- [x] **Step 6: Implement centralized transport decisions**

The decision function must use stored transport_class whenever a session credential resolves. Browser headers and caller platform fields may help classify first issuance only; they can never change a stored row.

Under off/observe, an unsigned new direct-Web session is inserted as legacy_unclassified. Under enforce it is rejected. A valid BFF authority inserts web_bff in every mode.

- [x] **Step 7: Add raw HTTP integration coverage**

Create a real BFF-issued web_bff credential, remove Origin, Fetch Metadata, platform, and every BFF header, then POST /auth/refresh. Assert 401/403 and recursively scan the JSON response for refreshToken; it must be absent.

Repeat with forged native platform and a valid Ops credential. Neither may downgrade.

- [x] **Step 8: Run focused and integration tests**

~~~bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
pnpm --filter @spott/api exec vitest run \
  src/platform/web-bff-authority.spec.ts

SPOTT_TEST_DATABASE_URL=postgres://127.0.0.1:55432/spott_session_security_test \
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
pnpm --filter @spott/api test:integration
~~~

Expected: PASS in off, observe, and enforce.

- [ ] **Step 9: Review and commit Task 3**

~~~bash
git add services/api/src/main.ts services/api/src/platform/request-context.ts \
  services/api/src/platform/platform.module.ts \
  services/api/src/platform/web-bff-authority.ts \
  services/api/src/platform/web-bff-authority.spec.ts \
  services/api/src/modules/auth/web-bff-boundary.integration.spec.ts
git commit -m "feat(api): enforce immutable session transport authority"
~~~

---

### Task 4: Implement stable refresh rotation and exact-successor recovery

**Files:**

- Create: services/api/src/modules/auth/session-token.service.ts
- Create: services/api/src/modules/auth/session-token.service.spec.ts
- Modify: services/api/src/modules/auth/auth.module.ts

**Interfaces:**

- parseRefreshToken accepts s2 and legacy grammars strictly.
- rotate(client, input, verifiedTransport) returns RefreshMutationOutcome and never throws an HTTP/domain reuse error.
- recover is possible only for the same consumed token, original attempt, verified current binding, unexpired recovery window, and still-current direct successor.

- [x] **Step 1: Write the RED behavior suite**

Use these exact test names:

~~~text
rotates hash while preserving session id and family id
increments exactly one generation
returns the exact successor for the same consumed token and rotation key
requires the same independent attempt plus valid device-binding proof
never returns a successor without caller attempt or binding proof
legacy consumed predecessors require reauthentication
never derives attempt material from token hash device UUID or transport
does not recover after the direct successor was superseded
does not revoke a family for unknown random material
rejects malformed and noncanonical s2 tokens
~~~

The stable-identity assertion must compare the pre/post identity.sessions.id and refresh_family_id, not only the response body.

- [x] **Step 2: Add the refresh KDF fixed vector**

~~~ts
it('matches the committed refresh-successor vector', () => {
  const secret = deriveSuccessorSecret({
    key: Buffer.from('fedcba9876543210fedcba9876543210'),
    version: 'v2',
    kid: 'refresh-2026-07',
    sessionId: '019b0000-0000-7000-8000-000000000001',
    familyId: '019b0000-0000-7000-8000-000000000002',
    predecessorGeneration: 7,
    predecessorHash: Buffer.from('aa'.repeat(32), 'hex'),
    successorGeneration: 8,
    attemptHash: Buffer.from('bb'.repeat(32), 'hex'),
    bindingId: '019b0000-0000-7000-8000-000000000003',
    bindingGeneration: 3,
  });
  expect(secret).toBe('8h-1D-MFacGW9Sf_VAc_v_Q1we62FQ9eVFloO8HomJc');
});
~~~

Mutating version, KID, either generation, predecessor hash, attempt hash, binding ID, or binding generation must produce a different secret.

- [x] **Step 3: Run the unit suite and confirm RED**

~~~bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
pnpm --filter @spott/api exec vitest run \
  src/modules/auth/session-token.service.spec.ts
~~~

Expected: FAIL because SessionTokenService does not exist.

- [x] **Step 4: Implement strict parsing and constant-time matching**

For s2, require exactly four components, canonical lower-case UUID, base-10 generation without leading zero except zero, canonical unpadded base64url, and exactly 32 decoded secret bytes.

For legacy, require exactly two components and retain only first-use compatibility. Compare the full derived hash with timingSafeEqual only after equal-length validation.

- [x] **Step 5: Implement stable rotation**

Lock identity.sessions and its current history row FOR UPDATE. Update the same identity.sessions row with successor hash and generation. Mark the predecessor history consumed and insert the successor current history row in the same transaction.

When attempt and valid persistent binding proof are present, derive the successor with REFRESH_TOKEN_DERIVATION_KEYS. When either is missing on a current legacy/native/Ops token, generate a random successor and leave recovery metadata null.

Never store a plaintext successor.

- [x] **Step 6: Implement recovery and safe negative outcomes**

Recovery requires:

~~~text
same predecessor token hash
same independent attempt hash
same persistent binding ID and generation
binding not revoked or expired
recovery_expires_at greater than database clock
successor generation still current
successor hash still matches identity.sessions.refresh_hash
referenced derivation KID still available
~~~

Missing proof on a consumed compatibility predecessor returns reauth_required. A different valid attempt plus valid binding on the same predecessor returns reused. Unknown token material returns invalid.

- [x] **Step 7: Run the unit suite and confirm GREEN**

~~~bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
pnpm --filter @spott/api exec vitest run \
  src/modules/auth/session-token.service.spec.ts
~~~

Expected: PASS.

- [ ] **Step 8: Review and commit Task 4**

~~~bash
git add services/api/src/modules/auth/session-token.service.ts \
  services/api/src/modules/auth/session-token.service.spec.ts \
  services/api/src/modules/auth/auth.module.ts
git commit -m "feat(api): add stable refresh rotation"
~~~

---

### Task 5: Commit reuse revocation before mapping HTTP 401

**Files:**

- Create: services/api/src/modules/auth/auth.session.integration.spec.ts
- Modify: services/api/src/modules/auth/session-token.service.ts
- Modify: services/api/src/modules/auth/session-token.service.spec.ts
- Modify: services/api/src/modules/auth/auth.service.ts
- Modify: services/api/src/modules/auth/auth.service.spec.ts

**Interfaces:**

- The database transaction resolves to RefreshMutationOutcome.
- AuthService maps reused to DomainError only after Database.transaction has resolved and COMMIT has completed.
- Two same-attempt calls return rotated and recovered with one generation advance.
- Two different valid attempts on one predecessor commit family revocation.

- [ ] **Step 1: Write two-connection RED tests**

Create two independent pg clients. Use a barrier so both submit the same current predecessor before either assertion.

~~~ts
const [first, second] = await Promise.all([
  refreshWith(clientA, predecessor, sameAttempt, binding),
  refreshWith(clientB, predecessor, sameAttempt, binding),
]);
expect(new Set([first.kind, second.kind])).toEqual(new Set(['rotated', 'recovered']));
expect(await currentGeneration(sessionId)).toBe(1);
~~~

For different valid attempts:

~~~ts
const outcomes = await Promise.all([
  refreshWith(clientA, predecessor, attemptA, binding),
  refreshWith(clientB, predecessor, attemptB, binding),
]);
expect(outcomes.some((value) => value.kind === 'reused')).toBe(true);
expect(await familyIsRevoked(familyId)).toBe(true);
~~~

After the API maps reused to 401, open a third connection and assert revoked_at/reuse_detected_at remain committed.

- [ ] **Step 2: Run integration tests and confirm RED**

~~~bash
SPOTT_TEST_DATABASE_URL=postgres://127.0.0.1:55432/spott_session_security_test \
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
pnpm --filter @spott/api test:integration
~~~

Expected: FAIL because current auth.service throws after UPDATE inside the transaction and the transaction rolls back.

- [ ] **Step 3: Return outcomes from the transaction**

The transaction callback must return reused after updating every active session in the stable family:

~~~ts
const outcome = await this.database.transaction((client) =>
  this.sessionTokens.rotate(client, input, transport)
);

switch (outcome.kind) {
  case 'rotated':
  case 'recovered':
    return outcome.session;
  case 'reused':
    throw new DomainError(
      'REFRESH_TOKEN_REUSED',
      '检测到异常登录，已撤销此设备会话。',
      401,
    );
  case 'reauth_required':
  case 'invalid':
    throw new DomainError('TOKEN_EXPIRED', '登录已过期，请重新登录。', 401);
}
~~~

No reused branch may throw before Database.transaction returns.

- [ ] **Step 4: Prove unknown material cannot cause denial of service**

Add a real-DB test that mutates one byte of a random secret while retaining a victim session ID. Assert invalid and verify victim revoked_at and reuse_detected_at remain null.

- [ ] **Step 5: Run unit and integration suites**

~~~bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
pnpm --filter @spott/api exec vitest run \
  src/modules/auth/session-token.service.spec.ts \
  src/modules/auth/auth.service.spec.ts

SPOTT_TEST_DATABASE_URL=postgres://127.0.0.1:55432/spott_session_security_test \
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
pnpm --filter @spott/api test:integration
~~~

Expected: PASS.

- [ ] **Step 6: Review and commit Task 5**

~~~bash
git add services/api/src/modules/auth/auth.session.integration.spec.ts \
  services/api/src/modules/auth/session-token.service.ts \
  services/api/src/modules/auth/session-token.service.spec.ts \
  services/api/src/modules/auth/auth.service.ts \
  services/api/src/modules/auth/auth.service.spec.ts
git commit -m "fix(api): commit refresh reuse revocation"
~~~

---

### Task 6: Make access authorization DB-backed and preserve Ops isolation

**Files:**

- Create: services/api/src/platform/session-authority.ts
- Create: services/api/src/platform/session-authority.spec.ts
- Modify: services/api/src/platform/auth.guard.ts
- Modify: services/api/src/platform/auth.guard.spec.ts
- Modify: services/api/src/platform/platform.module.ts
- Modify: services/api/src/modules/ops/ops.controller.ts

**Interfaces:**

- SessionAuthority.authorize(claims) returns current AuthenticatedUser from the database.
- Supplied invalid credentials on Public routes are rejected; absent credentials remain anonymous.
- Ops browser mutations use exact OPS_ORIGIN and Fetch Metadata independently of consumer BFF authority.

- [ ] **Step 1: Write session-authority RED tests**

Cover:

~~~text
revoked session
expired session
subject/session user mismatch
suspended or anonymized user
loginBlocked restriction
blocked device
fresh phoneVerified and restrictions state
fresh operator roles and disabled operator state
~~~

Assert the returned context uses DB values even when JWT claims contain stale phone/restriction/role values.

- [ ] **Step 2: Write optional-auth RED tests**

For each Public endpoint that can receive Authorization:

~~~ts
await expect(invokePublic({ authorization: undefined })).resolves.toMatchObject({
  user: undefined,
});
await expect(invokePublic({ authorization: 'Bearer revoked-but-cryptographically-valid' }))
  .rejects.toMatchObject({ status: 401 });
~~~

No invalid supplied credential may silently become anonymous personalized state.

- [ ] **Step 3: Write Ops raw-mutation matrix tests**

For verify, refresh, logout, and an ordinary Ops mutation, require:

~~~text
Origin equals one configured OPS_ORIGIN
Sec-Fetch-Site equals same-site
Sec-Fetch-Mode equals cors
Sec-Fetch-Dest is empty
~~~

Run this guard even when the access Cookie is missing or expired. Consumer BFF signature must neither be required nor accepted as an Ops substitute.

- [ ] **Step 4: Run guard tests and confirm RED**

~~~bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
pnpm --filter @spott/api exec vitest run \
  src/platform/session-authority.spec.ts \
  src/platform/auth.guard.spec.ts
~~~

Expected: FAIL because current guard trusts JWT claims and checks only Origin for Cookie mutations.

- [ ] **Step 5: Implement one DB authority query**

Join identity.sessions, identity.devices, identity.users, and the optional admin row. Require:

~~~sql
session.id = JWT sid
session.user_id = JWT sub
session.revoked_at IS NULL
session.expires_at > clock_timestamp()
device.risk_state <> 'blocked'
user.status = 'active'
NOT ('loginBlocked' = ANY(user.restriction_flags))
~~~

Build phone verification, restrictions, and roles from DB rows. Do not accept a session transport mismatch for the current route.

- [ ] **Step 6: Put the Ops raw guard before Public/access short-circuits**

The guard must examine route metadata/path and raw Cookie mutation state before returning true for @Public. It must not parse consumer session Cookies as Ops credentials.

- [ ] **Step 7: Run focused and full API tests**

~~~bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
pnpm --filter @spott/api exec vitest run \
  src/platform/session-authority.spec.ts \
  src/platform/auth.guard.spec.ts

PATH=/opt/homebrew/opt/node@24/bin:$PATH \
pnpm --filter @spott/api test
~~~

Expected: PASS.

- [ ] **Step 8: Review and commit Task 6**

~~~bash
git add services/api/src/platform/session-authority.ts \
  services/api/src/platform/session-authority.spec.ts \
  services/api/src/platform/auth.guard.ts \
  services/api/src/platform/auth.guard.spec.ts \
  services/api/src/platform/platform.module.ts \
  services/api/src/modules/ops/ops.controller.ts
git commit -m "feat(api): authorize access from live session state"
~~~

---

### Task 7: Integrate auth controllers and preserve generated contracts

**Files:**

- Modify: services/api/src/modules/auth/auth.controller.ts
- Modify: services/api/src/modules/auth/auth.service.ts
- Modify: services/api/src/modules/auth/auth.service.spec.ts
- Modify: packages/contracts/openapi.yaml
- Modify: packages/contracts/openapi.bundle.yaml
- Modify: packages/api-client/src/schema.d.ts
- Modify: packages/api-client/test/client.test.ts

**Interfaces:**

- POST /auth/refresh retains required refreshToken and deviceId.
- Idempotency-Key is optional for compatibility.
- deviceBindingProof is optional and discriminated as persistent.
- POST /auth/bootstrap is additive, read-only, and never rotates or extends a refresh credential.
- Native AuthSession remains a full session and adds refreshGeneration without removing existing fields.

- [ ] **Step 1: Write contract RED tests**

Add generated-source assertions:

~~~ts
expect(schema).toContain('"/auth/refresh"');
expect(schema).toContain('refreshToken: string');
expect(schema).toContain('deviceId: components["schemas"]["UUID"]');
expect(schema).toContain('deviceBindingProof?');
expect(schema).toContain('"/auth/bootstrap"');
expect(schema).toContain('refreshGeneration: number');
~~~

Add controller tests proving a caller platform field cannot classify transport and a verified BFF authority can.

- [ ] **Step 2: Run contract tests and confirm RED**

~~~bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
pnpm --filter @spott/api-client test
~~~

Expected: FAIL because bootstrap, binding proof, and refreshGeneration are absent.

- [ ] **Step 3: Update OpenAPI source**

Use this additive request shape:

~~~yaml
deviceBindingProof:
  type: object
  required: [bindingId, generation, proof, proofClass]
  properties:
    bindingId: { $ref: '#/components/schemas/UUID' }
    generation: { type: integer, minimum: 0 }
    proof: { type: string, minLength: 32, maxLength: 1024, writeOnly: true }
    proofClass: { type: string, enum: [persistent] }
~~~

Document that missing Idempotency-Key/binding proof allows only a current credential's first-use compatibility rotation. It never allows consumed-token recovery.

Define bootstrap as POST rather than GET because native supplies credential material in the body. It returns a fresh access JWT for the same current stable sid only when the credential, device, transport, and binding proof are valid; it does not modify generation, expiry, history, or binding timestamps.

- [ ] **Step 4: Integrate controller parsing**

Parse optional Idempotency-Key as UUID and optional deviceBindingProof with zod. Pass verified BFF metadata separately from caller JSON. Never accept platform from refresh JSON.

For current legacy calls without key/proof, pass undefined values to SessionTokenService and preserve first-use behavior.

- [ ] **Step 5: Bundle and regenerate**

~~~bash
pnpm contract:lint
pnpm contract:bundle
pnpm --filter @spott/api-client generate
~~~

- [ ] **Step 6: Prove generated drift is clean**

Run generation a second time and require no diff:

~~~bash
git add packages/contracts/openapi.bundle.yaml packages/api-client/src/schema.d.ts
pnpm contract:bundle
pnpm --filter @spott/api-client generate
git diff --exit-code -- \
  packages/contracts/openapi.bundle.yaml \
  packages/api-client/src/schema.d.ts
~~~

Expected: exit 0 because the second generation produces no unstaged change. Do not hand-edit generated outputs.

- [ ] **Step 7: Run contract/API client gates**

~~~bash
pnpm contract:lint
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api-client test
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api-client typecheck
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api-client lint
~~~

Expected: PASS.

- [ ] **Step 8: Review and commit Task 7**

~~~bash
git add services/api/src/modules/auth/auth.controller.ts \
  services/api/src/modules/auth/auth.service.ts \
  services/api/src/modules/auth/auth.service.spec.ts \
  packages/contracts/openapi.yaml \
  packages/contracts/openapi.bundle.yaml \
  packages/api-client/src/schema.d.ts \
  packages/api-client/test/client.test.ts
git commit -m "feat(api): publish stable session refresh contract"
~~~

---

### Task 8: Run all S0 gates and produce the deployment evidence matrix

**Files:**

- No new production files.
- Update only the test files in Strict File Scope if a gate exposes a missing assertion.

- [ ] **Step 1: Run migration replay twice**

~~~bash
SPOTT_TEST_DATABASE_URL=postgres://127.0.0.1:55432/spott_session_security_test \
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
pnpm --filter @spott/api test:integration

SPOTT_TEST_DATABASE_URL=postgres://127.0.0.1:55432/spott_session_security_test \
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
pnpm --filter @spott/api test:integration
~~~

Record the 0020 stored checksum before/after; they must match the pinned value.

- [ ] **Step 2: Run the full API gates**

~~~bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api test
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api typecheck
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api lint
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api build
~~~

Expected: all exit 0. If full lint exposes pre-existing failures, fix the repository lint baseline in a separately reviewed prerequisite before calling S0 deployable; do not weaken lint configuration or exclude security files.

- [ ] **Step 3: Run contract/generated gates**

~~~bash
pnpm contract:lint
pnpm contract:bundle
pnpm --filter @spott/api-client generate
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api-client test
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api-client typecheck
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api-client lint
~~~

Expected: all exit 0 and a second bundle/generate produces no diff.

- [ ] **Step 4: Run security-specific scans**

~~~bash
rg -n "ACCESS_TOKEN_SECRET.*(BFF|DERIVATION)|REFRESH_TOKEN_SECRET.*(BFF|DERIVATION)" \
  services/api/src .env.example

rg -n "console\\.(log|info|debug).*refresh|body\\.refreshToken|deviceBindingProof|x-spott-bff-signature" \
  services/api/src
~~~

Expected: the secret-reuse scan returns no match. Every logging match is either a redaction declaration or a test proving redaction.

- [ ] **Step 5: Run the transport evidence matrix**

For every off/observe/enforce mode, record PASS for:

~~~text
stored web_bff + valid signature -> allowed
stored web_bff + missing/invalid signature -> rejected
stored ops on Ops route + valid Ops Origin/Fetch Metadata -> allowed
stored ops on consumer/native route -> rejected
stored native on native contract -> first-use compatible
stored native sent by browser/BFF -> rejected
legacy_unclassified current in off -> compatible first use
legacy_unclassified current in observe -> compatible plus would-block metric
legacy_unclassified current in enforce -> only signed migration/revocation
headerless curl with web_bff credential -> rejected without refresh material
unknown random secret -> invalid without family revocation
consumed compatibility predecessor without proof -> reauth without successor
same attempt plus valid binding -> exact successor recovery
different valid attempt plus valid binding -> committed family revocation then 401
~~~

- [ ] **Step 6: Verify the scope boundary**

~~~bash
git diff --name-only -- apps/web Spott SpottTests SpottUITests
git diff --name-only -- database/migrations \
  | rg -v '^database/migrations/0021_web_session_security\.sql$'
~~~

Expected: no S0-caused changes. Because this worktree already contains unrelated dirty paths, compare the output with the status snapshot recorded immediately before S0 and preserve/document every pre-existing path.

- [ ] **Step 7: Run final diff checks**

~~~bash
git diff --check
git status --short
~~~

Expected: no whitespace errors and only intended S0 paths plus already-documented unrelated work.

- [ ] **Step 8: Obtain independent final review**

Require one security reviewer and one code/DB reviewer. Both must explicitly approve:

~~~text
no Web/localStorage behavior changed
0020 checksum unchanged
transport class cannot downgrade
nonce replay fails closed
same-attempt recovery is device-bound
unknown material cannot revoke a victim
reuse revocation commits before HTTP 401
JWT authority is live-DB-backed
native/Ops first-use compatibility remains
OpenAPI source/bundle/generated types do not drift
~~~

Do not mark S0 complete with an open Critical or Important finding.

---

## S0 Deployment State

S0 may be deployed only in this order:

1. Provision both independent keyrings and retained current/previous KIDs.
2. Apply migration 0021.
3. Deploy the API with WEB_SESSION_BFF_ENFORCEMENT=off.
4. Prove the hard web_bff and ops matrix cells in off mode.
5. Prove old iOS/Ops/direct-Web current-token first-use compatibility.
6. Leave the existing Web deployment unchanged.

S0 completion means only that the additive server foundation is ready. It does not mean:

- Web access/refresh credentials have left localStorage.
- Web uses HttpOnly Cookies.
- Web refresh is multi-tab coordinated.
- Legacy Web sessions have migrated.
- Offline/late-response logout is terminal.
- A cached pre-security Web bundle is blocked.

## S1 Atomic Cutover Hard Dependencies

S1 must be a separate plan and coordinated release. It may be implemented in multiple reviewed commits, but these behaviors must activate together:

- Same-origin Web BFF complete/bootstrap/refresh routes.
- Strict refresh, persistent-binding, and migration-intent Cookie codecs.
- Exact Origin and Fetch Metadata mutation boundary.
- Memory-only access token and metadata-only cross-tab coordination.
- One-time legacy localStorage migration adapter.
- Terminal current/all logout intent, cleanup POST, and read-only LOGOUT_PENDING bootstrap.
- Removal of whole-Cookie SSR forwarding.
- Service-worker/cache policy preventing stale pre-security session code.
- Web account-merge commit/recovery, or an API-enforced temporary Web-merge denial.
- API enforcement switch from observe to enforce only after the new Web is verified.

### Mandatory migration response-loss/full-reload contract

Before S1 may claim uninterrupted migration, add an explicit signed recovery route and real-browser test for this sequence:

1. Capture the old localStorage credential once.
2. Create/reuse one live migration intent.
3. Remove the old localStorage value and read back the absence.
4. Commit migration in PostgreSQL.
5. Lose the response and every Set-Cookie before the browser receives them.
6. Reload the page, so the old credential no longer exists in memory or storage.
7. Recover only the already-committed outcome using the same live migration-intent ID and temporary proof.
8. Issue a fresh persistent binding for that recorded attempt while retaining the immediately previous binding hash for at most 120 seconds.
9. Never allow this recovery route to initiate a new migration, accept a different intent, expose another outcome, or use the temporary proof for refresh/bootstrap/merge/logout.

Required later files include:

~~~text
apps/web/app/api/session/migrate/recover/route.ts
services/api/src/modules/auth/web-session.controller.ts
services/api/src/modules/auth/web-session.service.ts
tests/e2e/session-security.spec.ts
~~~

Until S1 and its real-browser HTTPS evidence pass, keep WEB_SESSION_BFF_ENFORCEMENT off and do not claim that browser credential persistence is fixed.
