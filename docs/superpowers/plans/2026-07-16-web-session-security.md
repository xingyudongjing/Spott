# Web Session Security and Cross-Tab Consistency Plan

> **Execution rule:** Use `superpowers:executing-plans`, `superpowers:test-driven-development`, `superpowers:systematic-debugging`, and `superpowers:verification-before-completion`. Execute one numbered slice at a time, preserve native iOS compatibility, and require independent review at each DB/API/Web boundary.

**Goal:** Remove all Web access/refresh credentials from persistent browser storage while providing stable refresh rotation, committed reuse detection, response-loss recovery, immediate server-side revocation, safe legacy migration, and deterministic multi-tab behavior.

**Architecture:** The browser talks only to same-origin `/api/session/*` BFF routes for cookie-backed session operations. A host-only `__Host-spott_refresh` cookie carries the refresh credential; browser JavaScript holds the access token only in module memory and broadcasts metadata only. The API retains the native body-token/Bearer contract for iOS. A new additive migration introduces a stable session ID/family, refresh generations, and consumed-token history. Rotation returns a transaction outcome and maps reuse to an error only after revocation commits.

**Cookie contract:**

```text
__Host-spott_refresh=v1.<envelopeMacKid>.<base64url(canonicalPayload)>.<base64url(mac)>;
Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000; Priority=High

__Host-spott_device_binding=v1.<envelopeMacKid>.<base64url(canonicalPayload)>.<base64url(mac)>;
Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2678400; Priority=High

__Host-spott_migration_intent=v1.<envelopeMacKid>.<base64url(canonicalPayload)>.<base64url(mac)>;
Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=600; Priority=High

__Host-spott_logout_intent=v1.<epoch>.<scope=current|all>.<optionalSessionId>;
Path=/; Secure; SameSite=Strict; Max-Age=2678400; Priority=High
```

The refresh payload contains the opaque API refresh token, stable session/family/generation, immutable `transport_class=web_bff`, issued/expiry timestamps, persistent binding ID, and the pinned BFF business-attempt KID. The persistent device-binding payload contains its random 256-bit secret, binding ID, device ID, owner/session scope, issued/expiry timestamps, and binding generation. It lives for exactly 31 days, is rotated only after a full authenticated sign-in, an explicit binding-upgrade/rebind, or account switch (not during ordinary refresh, so response loss cannot strand a successor); rotation atomically revokes/clears the old owner Cookie before issuing the new one. It is cleared without replacement on current/all-session logout, terminal revocation, invalid/expired binding, and abandoned owner switch. The server stores only its versioned hash and retains the immediately previous binding hash for at most 120 seconds solely to finish an already-recorded same-attempt binding replacement; the prior hash cannot authorize a new attempt, refresh, rebind, merge, or logout.

The migration-intent payload contains a CSPRNG intent ID, independently random attempt UUID, random 256-bit temporary binding secret, issued/expiry timestamps, and no refresh/session credential. Its server row stores only hashes. The endpoint reuses the same unconsumed intent Cookie until terminal migration, explicit abort, or the 10-minute expiry; then it rotates to fresh random values. It is cleared after successful migration, verified legacy revocation, expiry, logout/account switch, or any validation failure. This temporary proof is accepted only by `migrate`/`revoke-legacy`; it can never satisfy persistent device possession for refresh, merge, rebind, bootstrap, or logout. Conversely, a persistent device-binding Cookie is never silently treated as the missing migration intent.

The logout-intent Cookie is deliberately non-HttpOnly so an offline browser can set and read it synchronously; it contains no credential and is therefore untrusted. Its lifetime is the maximum refresh lifetime plus recovery grace (31 days for the current 30-day refresh). `scope` and `sessionId` are navigation/cleanup hints only: the server authorizes and selects rows exclusively from the refresh/access credential plus persistent binding proof verified on that POST. A forged scope/session ID can never revoke a named victim session. Read-only bootstrap checks the intent before the refresh Cookie, returns `LOGOUT_PENDING`, and issues no access state; the client then calls the protected POST route selected by local intent, whose current/all authority is recomputed from the currently verified credential, before retrying bootstrap. Every logout, logout-all, cleanup retry, and background logout network call must first synchronously rewrite and read back a fresh intent in the same call path before invoking `fetch`.

Never set `Domain`. `SPOTT_WEB_CANONICAL_ORIGIN` is a single configured origin and is never inferred from `Host` or forwarded headers. Add a tested canonical-host middleware/hosting rule that redirects `www` before any session handler.

**Secret separation, framing, and versioning:** Use two versioned keyrings: `SPOTT_WEB_BFF_KEYS` and `REFRESH_TOKEN_DERIVATION_KEYS`, each with an explicit current KID and retained previous keys. Every HMAC/KDF input starts with an ASCII protocol context, then includes protocol version and KID as length-prefixed fields before every other field; version/KID are authenticated data, never merely parser or key-selection metadata. Use unsigned 32-bit big-endian length prefixes, UTF-8/NFC strings where specified, fixed field order, and reject non-canonical encodings. Separate contexts are required for BFF authority, refresh successor derivation, refresh-Cookie MAC, persistent-binding Cookie MAC/hash, and temporary migration-intent Cookie MAC/hash. Store the applicable KID/version with refresh and binding history.

All three HttpOnly Cookie envelopes are integrity-protected with a purpose-specific HMAC and strict four-component (`version.kid.payload.mac`) grammar. Before any upstream call, parse must reject missing/extra components or fields, unknown version/KID, duplicate fields, non-canonical base64url, invalid lengths/UTF-8, MAC mismatch using a constant-time comparison, future-issued or expired timestamps, and wrong audience/purpose. After MAC validation, the refresh envelope's session/family/generation/transport/binding fields must exactly match the row found by the full verified token hash inside the API mutation transaction and before rotation/recovery/merge/logout changes any row. Mismatch fails closed, clears affected session Cookies, emits only a safe reauthentication code, and never invokes native compatibility, recovery, or reuse revocation. Unknown/retired KID, tamper, and expiry follow the same fail-closed path. Add committed fixed vectors for every purpose plus one-bit mutations of version, KID, payload fields, MAC, expiry, and DB-row consistency.

The HttpOnly refresh envelope pins the BFF business-attempt KID used for every rotation from that predecessor, so a current-key switch cannot change the business idempotency key after response loss. Retain referenced BFF attempt/MAC keys for at least the Cookie lifetime plus recovery window. Emergency compromised-key removal fails closed and clears client session Cookies instead of attempting recovery; revoke a DB family only when the underlying token and stored binding can still be independently verified, never from an unverifiable envelope. Never derive refresh material from `ACCESS_TOKEN_SECRET`.

**Compatibility:** Keep `/auth/refresh` body `{ refreshToken, deviceId }` and the full native session response. Add an optional `Idempotency-Key` and device-binding proof; new iOS sends one random attempt per refresh flight and retrieves binding proof from Keychain. Existing native, Ops, and legacy clients without both an independent random attempt and the route-correct possession proof retain first-use rotation compatibility only: refresh/merge requires persistent binding, while signed legacy migration requires its original temporary migration-intent binding. Once their predecessor is consumed they always receive a safe reauthentication outcome: no exact successor, migration result, merge result, or server-derived compatibility attempt may be recovered without both original values. A refresh-token hash is an index/lookup key only and must never derive, substitute for, or select an attempt. Unsigned consumer-Web requests never receive a native compatibility path.

**BFF enforcement-state matrix:** `WEB_SESSION_BFF_ENFORCEMENT` controls only first-time consumer-Web classification and `legacy_unclassified` transition behavior. Immutable transport authority is hard policy in all three modes:

| Request/session class | `off` | `observe` | `enforce` |
| --- | --- | --- | --- |
| `web_bff` session or BFF-only route | Require valid BFF authority; reject missing/invalid signature | Same hard rejection plus metrics | Same hard rejection plus metrics |
| `ops` session or `/ops/*` Cookie route | Require Ops Origin/Fetch-Metadata/Cookie policy; never accept native/BFF fallback | Same hard rejection plus metrics | Same hard rejection plus metrics |
| `native` session | Explicit native contract only; browser/BFF cannot downgrade into it | Same | Same |
| `legacy_unclassified` current credential | Permit only the pre-recorded compatibility operation; never reclassify from headers | Permit and emit would-block telemetry; no consumed-token recovery | Only signed migration or verified revocation; otherwise reject/reauth |
| New direct consumer-Web issuance | Temporarily permit and persist `legacy_unclassified` | Temporarily permit, persist `legacy_unclassified`, emit would-block | Reject unless valid BFF authority, then persist `web_bff` |

No mode may turn a stored `web_bff` or `ops` session into `native`/`legacy_unclassified`, skip its hard transport policy, expose either class's refresh material in browser JSON, or use absent/forged headers as downgrade evidence. Temporary direct-Web compatibility in `off`/`observe` is restricted to persisted `legacy_unclassified` rows and is removed in `enforce`. Tests execute every matrix cell, including raw headerless HTTP with genuine `web_bff` and `ops` credentials.

---

## Task 13.0: Enforce the Web BFF boundary at the API

This slice is required before any Web credential migration. A client-side BFF convention is not a security boundary.

Execution order is `13.0 RED -> 13.1 migration RED/GREEN -> 13.0 GREEN -> 13.2...`, because the verifier's PostgreSQL nonce store is created by migration `0021`.

### RED

Add API and real-browser tests for an explicit consumer matrix:

- every BFF-only route and every operation on a persisted `web_bff` session is rejected without a valid, unexpired Web-BFF signature in all modes; unsigned new direct-Web and `legacy_unclassified` behavior follows only the explicit matrix below;
- execute every `off|observe|enforce` matrix cell above; a session whose server-side `transport_class` is `web_bff` requires a valid BFF signature in all three modes even when a raw client omits or forges every browser header;
- native requests without browser headers retain their explicit native contract;
- Ops `/ops/*` Cookie routes do not require the consumer BFF signature, but require exact configured `OPS_ORIGIN`, `Sec-Fetch-Site: same-site`, `Mode: cors`, and empty destination in all three modes, including missing/expired access-Cookie cases;
- changing the flag cannot downgrade existing `web_bff`/`ops` rows, and a genuine credential sent by headerless curl cannot acquire native or legacy behavior;
- HMAC fixed vectors authenticate context, protocol version, signing KID, method, path, timestamp, nonce, and raw-body hash; changing only version or KID fails verification.

Under `enforce`, cover cached/pre-security consumer Web behavior that calls the API directly and assert the response contains no refresh token. Under `off`/`observe`, cover only the temporary `legacy_unclassified` compatibility path and prove it cannot touch a `web_bff`/`ops` credential or gain consumed-token recovery.

Add rollback tests proving a pre-security API binary cannot be deployed after this boundary and that the only allowed Web rollback artifact is a credentialless logout shell.

### GREEN

Create an API `WebBFFAuthority` before auth controllers:

- BFF requests carry version/KID, timestamp, nonce, and HMAC over length-prefixed context `spott:web-bff-authority`, protocol version, signing KID, method, canonical path, timestamp, nonce, and raw-body SHA-256 in that exact order;
- accept current/previous signing KIDs, enforce a short clock window, and atomically insert the nonce hash into the PostgreSQL nonce table; duplicate nonce or unavailable nonce storage fails closed;
- every BFF-to-API transport retry generates a fresh timestamp/nonce/signature, while the separate business `Idempotency-Key` remains unchanged for rotation recovery;
- reject unsigned consumer-Web issuance and `legacy_unclassified` operations in `enforce`; in every mode reject an absent/invalid signature on BFF-only routes and any operation whose persisted transport is `web_bff`;
- after parsing any existing session credential, enforce its immutable DB `transport_class`: `web_bff` can never fall through to native compatibility, `ops` only uses Ops routes/policy, and `legacy_unclassified` can only migrate or revoke once enforcement is active;
- implement `off|observe|enforce` exactly as the matrix above and centralize the decision so controllers cannot reinterpret it; `off`/`observe` are not bypasses for an existing `web_bff` or `ops` credential;
- reject browser direct calls even if they lie about `platform`; old iOS email login currently has no platform field, so browser headers and BFF signature classify first issuance, while the persisted transport class governs every later operation;
- route Ops through a separate raw Cookie-mutation policy keyed to `OPS_ORIGIN`; same-site subdomain requests are expected and must never be forced through the consumer BFF;
- BFF and API logs redact signature, body credentials, Cookie, and Authorization.

Enable raw-body verification in API bootstrap without changing parsed-controller inputs. Keep global CORS only for non-session browser API usage; CORS success must never bypass BFF authority.

Add a raw HTTP regression that takes a genuinely BFF-issued refresh token, removes `Origin` and all Fetch Metadata, and calls `/auth/refresh` directly: it must be rejected without any refresh token in JSON. Browser headers help classify first issuance and legacy migration; they are never the authority for an existing session.

---

## Task 13.1: Add stable refresh-generation storage

### RED

Create `services/api/src/modules/auth/auth.session-migration.spec.ts` with tests that migration `0021_web_session_security.sql`:

- adds stable refresh generation without replacing session identity;
- backfills exactly one current history row for every existing session;
- indexes active sessions by user/device;
- keeps old session inserts compatible through an insert trigger.

Run:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter @spott/api test -- auth.session-migration
```

Confirm RED because `0021` is absent.

### GREEN

Create `database/migrations/0021_web_session_security.sql` only; never edit migrations `0001`-`0020`. Add:

- `identity.sessions.refresh_generation` and stable-family constraints;
- immutable `identity.sessions.transport_class` (`web_bff`, `native`, `ops`, `legacy_unclassified`); existing iOS/Ops sessions backfill from trusted server records, while existing direct-Web sessions remain `legacy_unclassified` until BFF migration;
- `identity.session_refresh_history` containing session/family/generation, token hash, derivation KID, consumed-at, rotation namespace/key hash, successor generation/hash/KID, and recovery expiry;
- `identity.web_migration_intents` keyed by a CSPRNG intent ID and containing hashed independent random attempt, hashed temporary binding secret, MAC KID/version, issued/expiry/consumed timestamps, and terminal status; it contains no legacy token, persistent device binding, or session credential;
- `identity.web_legacy_migrations` keyed by the full verified legacy-token hash strictly as a lookup/index, atomically linked to one still-valid `web_migration_intents` row and recording its already-random attempt, outcome session/generation, and expiry so concurrent tabs and a keyring switch cannot choose different attempts; no SQL/default/application path may derive the attempt from token/token hash;
- `identity.web_bff_request_nonces` containing signing KID, nonce hash, and expiry for one-time transport replay protection;
- a dedicated persistent device-binding table with binding ID, versioned current hash, optional immediately previous hash/grace expiry, issued/absolute-expiry/rotated/revoked timestamps, owner/device/session scope, and binding generation; the binding secret is never stored plaintext and a client UUID is never treated as possession proof;
- database constraints preventing any migration-intent hash from being copied into the persistent device-binding table or accepted after its 10-minute expiry, and preventing a persistent binding hash from satisfying a migration-intent lookup;
- one backfilled generation-zero current row;
- partial indexes for active user/device sessions and direct predecessor lookup;
- an insert trigger that backfills history for an old API binary during rollback.

Replay every migration twice against isolated PostgreSQL 18 and verify `0020` checksum is unchanged.

---

## Task 13.2: Implement stable rotation and response-loss recovery

### RED

Create `session-token.service.spec.ts` with:

- `rotates hash while preserving session id and family id`;
- `returns the exact successor for the same consumed token and rotation key`;
- `requires the same independent attempt plus valid device-binding proof for exact-successor recovery`;
- `never returns a successor to a stolen consumed predecessor that lacks caller attempt or binding proof`;
- `legacy native and Ops consumed predecessors without both random attempt and binding proof require reauthentication`;
- `never derives an attempt from refresh token hash device UUID transport class or compatibility namespace`;
- `does not recover a predecessor after its direct successor was superseded`;
- `does not revoke a family for an unknown random secret`.

### GREEN

Create `session-token.service.ts` and implement:

- strict refresh token parsing and constant-time hash comparison;
- stable `sid`/family with monotonically increasing generation;
- successor secret derived with a versioned, domain-separated HMAC over length-prefixed session/family/generation fields using `REFRESH_TOKEN_DERIVATION_KEYS`;
- the successor HMAC frame authenticates context, protocol version, derivation KID, session, family, predecessor generation/hash, successor generation, independent attempt hash, and binding ID/generation in a fixed order; version and KID mutations fail fixed-vector verification;
- a 120-second recovery window only for the same consumed token, independently generated caller attempt, valid device-binding proof, and still-current direct successor;
- no plaintext successor token in PostgreSQL;
- a hard `reauth_required` result for every consumed predecessor missing either proof, including legacy/native/Ops compatibility calls; never synthesize an attempt from token hash, device ID, route, or server namespace;
- unknown random secrets return invalid without revoking a family, preventing session-ID-only denial of service.

Define the new token envelope and deterministic UUID mapping byte-for-byte, retain legacy parsing, store the successor KID, and add fixed vectors. Key rotation must preserve the exact-successor recovery window by keeping every referenced prior KID available until its history expires.

Run the focused unit tests after each behavior.

---

## Task 13.3: Commit reuse revocation before returning 401

### RED

Add tests:

- `commits family revocation before returning REFRESH_TOKEN_REUSED`;
- `serializes two same-key rotations into one generation advance`;
- `revokes on concurrent different-key use of one predecessor`.

Create `auth.session.integration.spec.ts` using two real PostgreSQL connections.

### GREEN

Return a transaction outcome (`rotated`, `recovered`, `reused`, `invalid`) instead of throwing inside the transaction. Revoke the whole family for confirmed keyed reuse, commit, then map `reused` to `DomainError` outside the transaction. Never derive a recoverable attempt solely from the refresh token. A legacy client without an independent attempt/binding proof may rotate a current token once, but a consumed-token retry cannot receive the successor and must reauthenticate; unknown random secrets still cannot trigger family revocation.

Run:

```bash
SPOTT_TEST_DATABASE_URL=postgres://127.0.0.1:55432/spott_test \
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
pnpm --filter @spott/api test:integration
```

Update `services/api/package.json`/Vitest integration configuration so `test:integration` discovers every `*.integration.spec.ts`, including the new session and nonce suites. Add a collection assertion or CI listing so hard-coded legacy file names cannot produce a false green.

---

## Task 13.4: Bootstrap, device rebinding, and merge safety

### RED

Add tests that bootstrap issues access only for the current unconsumed generation; two real PostgreSQL connections serializing the first bind of one previously nonexistent device cannot leave two owners active; an attacker who supplies another installation's UUID without possession proof cannot rebind or revoke it; auth/bootstrap/refresh reject blocked devices and inactive/login-blocked users; merge idempotency storage contains no access/refresh token; merge keeps the authenticated stable session ID; merge commit followed by response loss plus native process restart advances generation once and recovers a usable full session only with the same independent attempt and valid persistent device-binding proof; client coordinators serialize merge/refresh; and a deliberately injected different-key predecessor replay still commits reuse-family revocation. Add negative commit/recover cases for missing, wrong-owner, expired, revoked, migration-intent-only, previous-binding-outside-grace, and correct-attempt-but-wrong-binding proofs; each returns reauthentication without reading merge outcome metadata, advancing generation, revoking another family, or minting credentials.

### GREEN

In `auth.service.ts` and related tests:

- add `bootstrapSession()` that neither consumes nor extends refresh;
- acquire a transaction-scoped advisory lock derived from the device UUID before lookup/upsert (a nonexistent row cannot be `FOR UPDATE` locked), then revoke the prior account/device session before rebinding;
- add a random device-binding secret whose hash is stored server-side and whose value is stored only in native Keychain or a separate host-only HttpOnly Web device Cookie; a UUID alone is never possession proof;
- distinguish the persistent binding proof from the 10-minute migration-intent proof at the type, table, HMAC-context, controller DTO, and verifier layers; no shared union/default/fallback may allow one proof class to satisfy the other;
- require valid device-binding proof before cross-account rebind/revocation and revoke all active old-owner/device sessions, not a single row; when proof is absent or invalid, fail closed and allocate/restart login with a fresh device identity rather than mutating the victim device;
- issue/upgrade the binding secret through a dedicated authenticated POST operation only from an already valid session; bootstrap itself remains read-only. Add contract/native/BFF storage tests and redact the secret from JS/telemetry;
- remove non-authoritative pending-operation claims owned by the prior account/device only after authorized possession is established;
- make merge perform a deterministic forced rotation on the stable session;
- persist the merge attempt key across native process restarts until terminal resolution;
- require both the independently random merge attempt and current persistent device-binding proof before merge commit mutates state; bind the recorded outcome to binding ID/generation as well as predecessor/session/family;
- store only merge outcome metadata: stable session ID, family, result generation, target user/job, and status—never an access/refresh token;
- expose a dedicated authenticated merge-attempt recovery endpoint that accepts the persisted attempt key plus predecessor session credential and persistent device-binding proof; it validates the proof and the recorded predecessor hash/binding ID+generation/outcome before reading or reconstructing the deterministic still-current successor, and mints a fresh access JWT without requiring the expired preview token or rerunning merge;
- missing/invalid/expired/revoked binding, a temporary migration proof, or binding/outcome mismatch returns reauthentication and performs no outcome disclosure, successor reconstruction, access mint, generation advance, or victim-session revocation;
- on replay/recovery with the same key, return a response compatible with native `AuthSession` without generic idempotency body storage;
- if that result generation is no longer current, require bootstrap/reauthentication rather than re-running merge or consuming another predecessor;
- coordinate refresh, merge, logout, and account switch through one per-session mutation coordinator in Web Locks/BroadcastChannel and the native actor. A waiter never sends the predecessor after merge; it bootstraps/recovers the published successor. Server-side `consumed_reason` alone is never proof of legitimate concurrency: a predecessor replay with a different/unrelated key still commits family revocation. Do not add a `SESSION_TRANSITIONED` exemption unless a later design supplies a server-verifiable, device-bound transition proof and dedicated RED security tests.
- accept explicit `platform` for email/google, defaulting compatibly for old clients.

---

## Task 13.5: Make access authorization DB-backed

### RED

Create `session-authority.spec.ts` for revoked session, suspended/anonymized/login-blocked user, blocked device, and fresh phone/restriction/operator-role state. Add subject/`sid` mismatch coverage to `auth.guard.spec.ts`. For every `@Public` endpoint that accepts optional credentials, prove an absent credential remains anonymous while a supplied revoked/invalid credential is rejected and never populates personalized projection state. Add raw-request tests for every Ops cookie mutation, including verify/refresh with no or expired access cookie.

### GREEN

Create `services/api/src/platform/session-authority.ts`. After JWT verification, join the session, device, user, and applicable operator state once per protected or optionally authenticated request. Reject revoked/expired sessions, blocked devices, inactive users, and mismatched subject/session. Build current request context from DB state rather than stale JWT claims. Public requests without credentials remain anonymous; public requests that supplied invalid credentials return 401 rather than trusting or silently personalizing from stale claims.

Put Origin/Fetch-Metadata enforcement in a raw browser-mutation guard that runs before `@Public`/access-token short circuits. Keep Ops cookie transport, but require this guard for verify, refresh, logout, and every Ops Cookie mutation even when the access cookie is absent or expired.

---

## Task 13.6: Preserve contracts and upgrade iOS refresh flights

### RED

Add contract tests requiring the existing refresh body, optional `Idempotency-Key`, stable-session documentation, and bootstrap endpoint. Add iOS tests:

- `testRefreshKeepsSessionIdentityAndReusesOneAttemptKeyAcrossTransportRetry`;
- `testRefreshRejectsAnUnexpectedServerSessionIdentity`.
- `testLegacyRefreshWithoutAttemptKeyRequiresReauthenticationAfterTransportLoss` at the API compatibility boundary;
- `testMergeAttemptSurvivesProcessRestartAndRecoversOneGeneration` using persistent native attempt state;
- `testOpsConsumedRefreshWithoutRandomAttemptAndBindingRequiresReauthentication` and a new-Ops positive recovery case using its persisted random attempt plus protected binding proof; no `legacy-ops-v1` or token-derived key exists.

### GREEN

Update controller/OpenAPI/API client without deleting native fields. Generate contract bundle/types. In `SpottAPIClient`, create one UUID per refresh flight, reuse it across the exact transport retry, attach Keychain-backed persistent binding proof, and require the returned `sessionId` to equal the current one. Upgrade Ops to the same independently random per-flight attempt plus protected binding proof before claiming response-loss recovery; old Ops remains first-use compatible but reauthenticates after a consumed response-loss predecessor. Persist the merge attempt key/session identity and binding reference in Keychain until terminal resolution. After process restart, call the dedicated merge-attempt recovery endpoint with persistent binding proof; do not depend on an irreversible fingerprint or persist the short-lived preview credential merely to replay the original commit.

Run contract/client generation checks and focused `SessionIsolationTests` on an available iOS 26 simulator.

---

## Task 13.7: Add same-origin BFF, Cookie, and CSRF boundary

### RED

Create Web tests proving:

- missing/mismatched/cross-site Origin is rejected;
- navigate/no-cors/non-empty destination mutations are rejected;
- only configured same-origin fetch mutations pass;
- the exact four host-only `__Host-` Cookies use the attributes/TTL above and clearing repeats `Path=/; Secure; SameSite=Strict` with `Max-Age=0` (and `HttpOnly` for the three protected Cookies);
- refresh tokens never appear in browser JSON;
- browser-supplied upstream rotation keys are ignored;
- the same refresh Cookie alone cannot derive a recoverable upstream key; only the same Cookie plus the exact persisted independent caller attempt and valid persistent binding derives the same upstream rotation key;
- a lost-response retry with that same attempt/binding still derives the same key after the configured current BFF KID changes, while a fresh/missing attempt or wrong proof reauthenticates;
- concurrent legacy migration still advances once if the current migration KID changes;
- migration intent/attempt/binding are independently random, two tabs reuse one live intent, and the legacy token hash is only an atomic lookup index—not attempt entropy;
- temporary migration proof cannot authorize refresh/bootstrap/rebind/merge/logout, and persistent device proof cannot replace a missing migration-intent proof;
- merge commit and recover require the same valid persistent binding proof; missing/wrong/expired/temporary proof yields no outcome or credential;
- a valid versioned BFF signature is required upstream and fixed vectors, including authenticated version and KID, match the API verifier;
- refresh, persistent-binding, and migration-intent Cookie fixed vectors match their strict parsers; unknown/tampered/expired envelopes, noncanonical encoding, wrong purpose, and refresh-envelope/DB field mismatch fail closed before any upstream mutation;
- canonical-origin redirects do not depend on a spoofed Host header;
- authenticated SSR upstream requests contain no Cookie, refresh token, or Authorization header.
- GET bootstrap with or without logout intent never changes DB state or emits/clears Cookie; intent returns `LOGOUT_PENDING` until a protected POST cleanup succeeds.

### GREEN

Create narrow helpers under `apps/web/app/lib/` for session types, BFF fetch, cookie serialization, and request security. Add route handlers:

- `/api/session/complete`
- `/api/session/bootstrap`
- `/api/session/refresh`
- `/api/session/device-binding/upgrade`
- `/api/session/migration-intent`
- `/api/session/migrate`
- `/api/session/revoke-legacy`
- `/api/session/logout`
- `/api/session/logout-all`
- `/api/session/merge/commit`
- `/api/session/merge/recover`

Every mutation must require exact canonical Origin plus:

```text
Sec-Fetch-Site: same-origin
Sec-Fetch-Mode: cors | same-origin
Sec-Fetch-Dest: empty
```

Bootstrap is side-effect-free. Every session response is `Cache-Control: private, no-store`. For refresh, the Web coordinator generates a random non-secret attempt UUID independent of the refresh token and persists/broadcasts it until terminal resolution. The BFF unwraps `bffAttemptKid` from the predecessor Cookie, verifies the separate HttpOnly device-binding Cookie, and derives the upstream UUID from the pinned KID plus token hash, caller attempt, and device-binding context—not from the token alone and not from whichever KID is current at retry time. A successful response clears attempt metadata and wraps the successor with the chosen current KID for its future rotation. The BFF accepts the caller value only as attempt entropy and never forwards it as the upstream key.

Implement one strict envelope codec per Cookie purpose using the framing contract above. Verify MAC/expiry/audience before decoding credential fields. The BFF then includes the canonical refresh-envelope claims in the raw body covered by BFF authority; inside the same API transaction that locks the token row, compare session/family/generation/transport/binding fields before any rotation, recovery, merge, logout, or revocation mutation. Unknown or retired KID, any payload/MAC/version/KID mutation, expiry, wrong-purpose envelope, and pre-mutation DB mismatch clear refresh/device Cookies and return safe reauthentication without falling through to native/legacy behavior or classifying the value as malicious reuse. Cookie issue/clear helpers hard-code the exact names, attributes, TTLs, and no `Domain`; callers cannot override them.

All BFF-to-API session requests carry the signed authority envelope from Task 13.0. Before exposing a legacy token to migration, acquire the cross-tab session-mutation lock and call same-origin `migration-intent`; under that lock it reuses a valid unconsumed migration-intent Cookie or creates fresh CSPRNG intent ID, random attempt UUID, and random 256-bit temporary binding secret, persists only their hashes, and sets the 10-minute HttpOnly migration-intent Cookie. The lock remains held until the non-secret intent metadata is published, so concurrent empty-Cookie tabs cannot create different attempts; a crashed holder releases Web Locks and the next holder reuses the already-set host Cookie. This is explicitly not the 31-day persistent device-binding Cookie. `migrate` must rotate and invalidate the legacy localStorage token immediately. After fully verifying the legacy token and temporary proof, the API uses its token hash only to atomically find/create `web_legacy_migrations`, binds the first still-valid random intent/attempt, and reuses that recorded attempt across coordinated tabs, response retries, and current-key changes. A second different intent cannot recover a consumed predecessor and must reauthenticate. `revoke-legacy` requires the full verified token plus its matching live temporary proof, never a session ID/token hash alone. Successful migration issues a separately generated persistent binding and clears the temporary Cookie; no temporary secret/hash is promoted or copied. BFF transport retries create a fresh signature nonce/timestamp but preserve the same independently random business attempt.

Remove whole-`Cookie` forwarding from `events-server.ts`/`events-api.ts`; if a non-sensitive preference is required, forward only an explicit allowlist. Add canonical-origin middleware using `SPOTT_WEB_CANONICAL_ORIGIN` and a tested `www` redirect before session routes.

Update `.env.example`, validated config, and test orchestration for the two keyrings/current KIDs, canonical consumer/Ops origins, API internal URL, enforcement mode, recovery window, and device-binding Cookie. Configuration must reject duplicate/missing KIDs and redact every secret in diagnostics.

---

## Task 13.8: Move Web session to memory and coordinate tabs

### RED

Rewrite/add client tests proving:

- neither access nor refresh credentials enter localStorage/sessionStorage;
- refresh goes only to same-origin BFF;
- one tab shares one in-flight refresh;
- multiple tabs advance generation only once;
- response-loss/page-reload retry reuses the independent metadata attempt while a stolen predecessor without that attempt/binding cannot recover;
- refresh, migration intent/migrate, merge, logout, and account switch share one per-session mutation lock and epoch;
- a forced merge transition racing a refresh never becomes malicious-reuse revocation;
- waiters bootstrap the leader generation instead of rotating again;
- CustomEvent/BroadcastChannel payloads contain metadata only;
- a refresh completion whose local session/logout epoch changed is ignored and cannot restore memory state.

### GREEN

Create `session-runtime.ts`, a general `cross-tab-session-mutation.ts`, and `SessionProvider.tsx`:

- remove `refreshToken` from the browser `WebSession`; add `refreshGeneration`;
- keep access token in module memory only;
- use `navigator.locks` first;
- use a metadata-only localStorage owner/expiry lease as fallback;
- persist only the current random refresh-attempt UUID/KID/session metadata (never token material) until success, explicit reuse failure, or expiry;
- broadcast only user ID, session ID, generation, and state;
- maintain a monotonic local logout/session epoch; every async completion validates it before updating memory;
- route refresh, migration-intent/migrate/revoke-legacy, merge commit/recovery, logout, and account switch through the same coordinator rather than a refresh-only lock;
- before Web merge commit, persist a non-credential locator `{ attemptId, sessionId, jobId, createdAt }` under a dedicated metadata key and broadcast it; on full page reload, `SessionProvider` calls `/api/session/merge/recover` before ordinary bootstrap, then clears the locator only after terminal recovery/expiry;
- after acquiring the lock, bootstrap first and rotate only if generation did not advance;
- authenticated API calls bootstrap before redirecting when memory is empty;
- direct API requests use `credentials: "omit"`; only same-origin BFF routes use Cookie credentials;
- show a stable placeholder until initial bootstrap settles.

---

## Task 13.9: Migrate legacy localStorage safely and make logout terminal

### RED

Add tests that legacy credentials are removed before migration, migration-intent establishes an independently random attempt plus temporary proof, two tabs reuse one live intent and advance one migration, migration response loss recovers the exact successor even across a KID switch, token/token-hash-derived attempts are impossible, a stolen consumed predecessor without the original random attempt and temporary proof cannot recover, a second independently valid but different intent cannot recover it, temporary proof cannot authorize persistent-session operations, migration consumes the old token, and removal failure invokes verified revoke-legacy. Add offline/late-response logout tests and account-switch private-draft clearing. Add a real-browser race: pause refresh response, start terminal logout, deliver refresh response late, reload, and prove logout intent forces revoke/clear before any bootstrap or authenticated request. Repeat with localStorage throwing on write/read-back, advance time beyond 7 days but below refresh expiry, and cover both `scope=current` and `scope=all`; logout-all recovery must revoke every device session.

For logout authorization, add boundary tests that forged `sessionId`, another user's session ID, omitted/malformed IDs, and changed `scope` hints never supply a principal/session predicate or bypass endpoint authorization. `scope` may only choose the client route: `/logout` can revoke the currently verified bound session and `/logout-all` can revoke only sessions owned by the currently verified bound user. Missing/expired/revoked refresh/access credential, UUID-only input, temporary migration proof, or wrong persistent binding returns reauthentication and leaves every victim session unchanged. Instrument every logout network entry point—including initial click, offline retry, `LOGOUT_PENDING` cleanup, background retry, account switch, and logout-all—to assert a fresh intent write/read-back occurs before each individual `fetch`; direct helper bypass fails the test.

### GREEN

- Read `spott.web.session.v1` once into memory.
- Call `/api/session/migration-intent` without sending the legacy credential; reuse/create its CSPRNG intent ID, independent random attempt, and temporary binding proof before any migrate/revoke call.
- Remove/blank it and read back to prove removal before sending the old refresh token to `/api/session/migrate`.
- If removal cannot be proved, call `/api/session/revoke-legacy` with the complete captured token plus that live temporary proof and remain logged out; never write the credential back.
- Use only migration-intent's random metadata. Never derive or select migration attempt material from the legacy token, its hash, session/device ID, KID, or route. The full verified token hash is only the transactional index that links the first valid live intent to `web_legacy_migrations`; coordinated tabs reuse the shared live intent Cookie/metadata. A successful migrate always consumes the old token, issues a separately random persistent device binding, and clears the temporary intent before setting the refresh Cookie.
- Before every logout/logout-all/cleanup/retry network call, synchronously write/read-back both the metadata localStorage tombstone and a freshly timestamped non-secret `__Host-spott_logout_intent` Cookie in that exact call path, then invoke `fetch`. Either durable channel is sufficient to block bootstrap; if localStorage is unavailable, the Cookie is mandatory. If the browser cannot persist either while a refresh Cookie exists, do not issue the logout fetch; remain memory-logged-out and present an explicit close-this-tab/retry-clear state rather than claiming terminal cleanup.
- Clear registration, event-composer, and group-transfer private drafts on logout/account switch.
- Settings logout/logout-all synchronously clear memory and preserve the tombstone even if the network fails.
- Treat logout-intent `scope`/`sessionId` only as untrusted UI routing hints. Each POST independently validates current refresh/access credential and persistent binding, derives the only revocable stable session/user from those verified rows, and never places hinted identifiers in an authorization predicate. `/logout` revokes that verified session; `/logout-all` revokes sessions for that verified user. Invalid proof returns reauthentication without acting on the hint.
- SSR/BFF GET bootstrap that sees pending logout intent returns `LOGOUT_PENDING`/anonymous and performs no DB or Cookie mutation. The client then calls the hinted same-origin POST clear/revoke route, which recomputes current/all authority from verified credentials, and retries GET bootstrap only after terminal cleanup. While offline it remains logged out. This recovers from a late refresh response that re-applied `Set-Cookie`; the DB family remains revoked and the next online cleanup removes refresh, persistent-binding, migration-intent, and logout-intent Cookies before any authenticated state is exposed.

---

## Task 13.10: Centralize safe `returnTo` and update every gate consumer

### RED

Create `safe-return.test.ts` rejecting protocol-relative, backslash, encoded-backslash, absolute URL, control-character, and auth-loop destinations while accepting a normal relative path with query/hash.

### GREEN

Create one `safeReturnPath` and replace all hand-written checks in login, phone verification, ChatGPT auth, registration gating, and related account flows. No client effect may redirect before session bootstrap finishes. Account merge must never pass the raw full API session response into browser state.

---

## Task 13.11: Real-browser and real-database security E2E

Add `tests/e2e/session-security.spec.ts` proving:

- exactly one HttpOnly/Strict/host-only refresh cookie after login;
- exact persistent-binding and temporary migration-intent Cookie attributes/TTLs/rotation/clearing, with the two proof classes never substitutable;
- a cached/pre-security browser bundle cannot obtain a refresh token directly from API auth endpoints;
- every `off|observe|enforce` matrix cell, including that `web_bff` and `ops` hard transport policies never weaken when the flag changes and headerless curl cannot downgrade them;
- a `web_bff` token sent by curl without any browser headers still cannot use native refresh/bootstrap/merge/logout paths;
- BFF authority and Cookie envelope fixed vectors authenticate version/KID; unknown/tampered/expired/wrong-purpose envelopes and refresh-envelope/DB mismatches fail closed without upstream mutation or compatibility fallback;
- no bearer/refresh credential in storage, DOM, event, or broadcast payloads;
- two-tab refresh advances DB generation once;
- lost response recovers the exact successor;
- lost response across current BFF/API KID switches recovers with the predecessor's pinned KID;
- replay with another key commits family revocation;
- logout revokes stable `sid` and clears the cookie;
- suspension blocks access before JWT expiry;
- cross-site Origin cannot refresh/logout;
- malicious `returnTo` never leaves the canonical origin;
- anonymous and authenticated SSR upstream fetches contain no session Cookie or browser credential;
- first-time concurrent device rebind has one surviving owner/session;
- an attacker knowing only a victim device UUID cannot rebind it or revoke any victim session;
- Web/native coordinators prevent merge and normal refresh from sending two predecessor mutations; a deliberately injected unrelated-key predecessor replay still revokes the family, while merge recovery works after process restart;
- merge commit/recover with the right attempt but missing/wrong/expired/temporary binding yields reauthentication, no outcome disclosure, and no generation/session mutation;
- direct Ops Cookie refresh follows the Ops Origin/same-site matrix without a consumer BFF signature;
- legacy two-tab migration reuses one random live migration intent, rotates once, and leaves the old localStorage token unusable; token-hash-derived attempt and a second different intent cannot recover a consumed migration predecessor;
- paused refresh followed by logout and late response cannot survive logout-intent cleanup, including localStorage failure;
- forged logout scope/session hints never select a victim; each initial/retry/background current/all logout fetch has a preceding fresh synchronous intent write/read-back and derives authority only from the currently verified credential plus persistent binding;
- merge commit response loss followed by a full Web page reload uses the persisted non-secret locator and `/api/session/merge/recover` to recover the same generation once;
- `www` redirects to the configured canonical origin before session handling.

Update Vinext/E2E startup to bind Web on IPv6 dual-stack (`::` with IPv4 mapping) or another explicitly verified host mode so `http://localhost:3000` resolves in the test browser; keep API at `http://127.0.0.1:4100`. Assert the Web health endpoint through the exact browser hostname before running. If the browser does not honor Secure Cookie semantics on HTTP localhost, run a local HTTPS origin rather than weakening the Cookie. Inspect Cookie attributes and storage with a real browser; jsdom is not sufficient evidence.

---

## Final gates

Run contracts/generation, full API unit+integration, API typecheck/lint, full Web unit/typecheck/lint/build, focused iOS session/merge tests, Ops refresh tests, real session-security E2E, migration replay, all three enforcement modes, BFF signature/KDF/Cookie-envelope fixed vectors, direct-browser API denial, SSR-header redaction, secret/storage scan, and `git diff --check`. The final matrix must explicitly show: consumed legacy/native/Ops without both independent attempt and binding proof reauthenticate; migration attempt is random-intent-only; temporary/persistent proofs cannot substitute; merge commit/recover require persistent proof; unknown/tampered/expired versioned envelopes fail closed; forged logout hints cannot target rows; every logout fetch is preceded by an intent write/read-back. Obtain independent security/code review with no open Critical or Important finding.

**Deployment order:** migration `0021` -> API verifier/dual native protocol/DB guard with `off` -> prove existing `web_bff`/`ops` hard-policy cells -> compatible iOS and Ops -> switch to `observe` and verify would-block telemetry only for new direct Web/`legacy_unclassified` -> Web BFF/canonical host plus memory-only Web -> verify BFF success, Cookie integrity, and storage absence -> atomically switch to `enforce` -> legacy migration. The flag changes only new direct consumer-Web and `legacy_unclassified` behavior; `web_bff`, `ops`, and `native` transport rules are hard in `off`, `observe`, and `enforce`. Enabling is a coordinated release gate or maintenance window, so the current direct Web is never broken before BFF availability. Once enforcement is enabled, never roll API back behind that boundary. The only permitted Web rollback is a credentialless logout shell; a pre-security localStorage bundle is forbidden. Production/DNS/keyring deployment remains gated on explicit external authorization.
