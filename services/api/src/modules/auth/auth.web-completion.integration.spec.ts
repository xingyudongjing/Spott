import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { DomainError } from '@spott/domain';
import { Client, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FieldCrypto } from '../../platform/crypto.js';
import { SessionAuthority } from '../../platform/session-authority.js';
import type { VerifiedBFFAuthority } from '../../platform/web-bff-authority.js';
import { IdempotencyService } from '../../platform/idempotency.js';
import {
  AuthService,
  type WebEmailSessionCompletionInput,
  type WebSessionCompletionMaterial,
  type WebSessionCompletionPendingResult,
} from './auth.service.js';
import {
  parseRefreshToken,
  persistentDeviceBindingHash,
  SessionTokenService,
} from './session-token.service.js';
import {
  completionAttemptHash,
  deriveInitialWebRefreshSecret,
} from './web-session-completion-kdf.js';

const databaseURL = process.env.SPOTT_TEST_DATABASE_URL;
if (!databaseURL) throw new Error('SPOTT_TEST_DATABASE_URL is required');

const refreshHashKey = 'web-completion-refresh-hash-key-at-least-32-bytes';
const primaryDerivationKid = 'completion-2026-07-primary';
const retainedDerivationKid = 'completion-2026-07-retained';
const primaryDerivationKey = Buffer.from('0123456789abcdef0123456789abcdef');
const retainedDerivationKey = Buffer.from('fedcba9876543210fedcba9876543210');

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: databaseURL,
  ACCESS_TOKEN_SECRET: 'web-completion-access-secret-at-least-32-bytes',
  REFRESH_TOKEN_SECRET: refreshHashKey,
  FIELD_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 9).toString('base64'),
  LOOKUP_HMAC_PEPPER: 'web-completion-lookup-pepper-at-least-16-bytes',
  SPOTT_WEB_BFF_KEYS:
    `completion-bff:${Buffer.from('bff-authority-key-material-32byte').toString('base64url')}`,
  SPOTT_WEB_BFF_CURRENT_KID: 'completion-bff',
  REFRESH_TOKEN_DERIVATION_KEYS:
    `${primaryDerivationKid}:${primaryDerivationKey.toString('base64url')},` +
    `${retainedDerivationKid}:${retainedDerivationKey.toString('base64url')}`,
  REFRESH_TOKEN_DERIVATION_CURRENT_KID: primaryDerivationKid,
  WEB_SESSION_BFF_ENFORCEMENT: 'off',
  WEB_SESSION_RECOVERY_SECONDS: '1',
  WEB_SESSION_COMPLETION_RECOVERY_SECONDS: '1',
  SPOTT_WEB_CANONICAL_ORIGIN: 'https://spott.jp',
});

const authority: VerifiedBFFAuthority = {
  version: 'v1',
  kid: 'completion-bff',
  timestamp: 1_784_346_245_000,
  nonceHash: Buffer.alloc(32, 17),
};

interface CompletionFixture {
  readonly userId: string;
  readonly challengeId: string;
  readonly deviceId: string;
  readonly code: string;
  readonly input: WebEmailSessionCompletionInput;
}

interface NewIdentityCompletionFixture {
  readonly providerSubject: string;
  readonly challengeId: string;
  readonly deviceId: string;
  readonly code: string;
  readonly input: WebEmailSessionCompletionInput;
}

interface CompletionStateRow {
  readonly session_id: string;
  readonly session_user_id: string;
  readonly session_device_id: string;
  readonly refresh_hash: Buffer;
  readonly refresh_family_id: string;
  readonly refresh_generation: string;
  readonly current_derivation_kid: string;
  readonly current_binding_id: string;
  readonly current_binding_generation: string;
  readonly transport_class: string;
  readonly session_expires_at: Date;
  readonly session_revoked_at: Date | null;
  readonly reuse_detected_at: Date | null;
  readonly history_family_id: string;
  readonly history_generation: string;
  readonly history_token_hash: Buffer;
  readonly history_derivation_kid: string;
  readonly history_transport_class: string;
  readonly history_binding_id: string;
  readonly history_binding_generation: string;
  readonly history_state: string;
  readonly binding_user_id: string;
  readonly binding_device_id: string;
  readonly binding_session_id: string;
  readonly binding_generation: string;
  readonly binding_current_hash: Buffer;
  readonly binding_current_kid: string;
  readonly binding_proof_class: string;
  readonly binding_revoked_at: Date | null;
  readonly binding_absolute_expires_at: Date;
  readonly registry_proof_class: string;
  readonly outcome_challenge_id: string;
  readonly outcome_attempt_hash: Buffer;
  readonly outcome_request_digest: Buffer;
  readonly outcome_user_id: string;
  readonly outcome_device_id: string;
  readonly outcome_session_id: string;
  readonly outcome_family_id: string;
  readonly outcome_binding_id: string;
  readonly outcome_refresh_generation: string;
  readonly outcome_binding_generation: string;
  readonly outcome_derivation_version: string;
  readonly outcome_derivation_kid: string;
  readonly outcome_created_at: Date;
  readonly outcome_recovery_expires_at: Date;
  readonly outcome_recorded_after_verification: boolean;
  readonly challenge_verified_at: Date | null;
}

class ClientDatabaseAdapter {
  constructor(
    private readonly client: Client,
    private readonly failAfterQuery?: (text: string) => boolean,
  ) {}

  query<T extends QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.client.query<T>(text, [...values]);
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.client.query('BEGIN');
    await this.client.query("SET LOCAL TIME ZONE 'UTC'");
    try {
      const transactionClient = this.failAfterQuery === undefined
        ? this.client as unknown as PoolClient
        : {
            query: async (text: string, values: readonly unknown[] = []) => {
              const result = await this.client.query(text, [...values]);
              if (this.failAfterQuery?.(text) === true) {
                throw new Error('INJECTED_POST_QUERY_TRANSACTION_FAILURE');
              }
              return result;
            },
          } as unknown as PoolClient;
      const result = await work(transactionClient);
      await this.client.query('COMMIT');
      return result;
    } catch (error) {
      await this.client.query('ROLLBACK');
      throw error;
    }
  }
}

const fieldCrypto = new FieldCrypto();
const fixtures: CompletionFixture[] = [];
const newIdentityFixtures: NewIdentityCompletionFixture[] = [];
let observer: Client;
let firstClient: Client;
let secondClient: Client;
let firstService: AuthService;
let secondService: AuthService;

async function acceptPendingCompletion(
  service: AuthService,
  fixture: Pick<CompletionFixture, 'challengeId' | 'deviceId' | 'input'>
    | Pick<NewIdentityCompletionFixture, 'challengeId' | 'deviceId' | 'input'>,
  pending: WebSessionCompletionPendingResult,
): Promise<WebSessionCompletionMaterial> {
  const accepted = await service.acceptWebSessionCompletionAttempt(
    fixture.input.attemptId,
    {
      challengeId: fixture.challengeId,
      deviceId: fixture.deviceId,
      binding: fixture.input.newBinding,
    },
    authority,
    'verified_bff',
  );
  if (accepted.state !== 'accepted') {
    throw new Error(`Expected accepted completion for ${pending.sessionId}`);
  }
  expect(accepted.material).toMatchObject({
    sessionId: pending.sessionId,
    bindingId: pending.bindingId,
  });
  return accepted.material;
}

async function completeAndAccept(
  service: AuthService,
  fixture: Pick<CompletionFixture, 'challengeId' | 'deviceId' | 'input'>
    | Pick<NewIdentityCompletionFixture, 'challengeId' | 'deviceId' | 'input'>,
): Promise<{ pending: WebSessionCompletionPendingResult; material: WebSessionCompletionMaterial }> {
  const pending = await service.completeWebEmailSession(fixture.input, authority, 'verified_bff');
  return { pending, material: await acceptPendingCompletion(service, fixture, pending) };
}

async function rotateAcceptedCompletion(
  service: AuthService,
  fixture: Pick<CompletionFixture, 'deviceId' | 'input'>,
  material: WebSessionCompletionMaterial,
  refreshToken: string,
  generation: number,
) {
  return service.refresh(
    refreshToken,
    fixture.deviceId,
    'web',
    authority,
    'verified_bff',
    randomUUID(),
    fixture.input.newBinding,
    {
      sessionId: material.sessionId,
      familyId: material.refreshFamilyId,
      generation,
      transportClass: 'web_bff',
      persistentBindingId: material.bindingId,
      persistentBindingGeneration: material.bindingGeneration,
    },
  );
}

async function insertPersistentBinding(
  fixture: Pick<CompletionFixture, 'userId' | 'deviceId'>,
  sessionId: string,
  generation: number,
): Promise<string> {
  const bindingId = randomUUID();
  const bindingHash = randomBytes(32);
  await observer.query(
    `SELECT identity.claim_proof_hash_class($1, 'persistent')`,
    [bindingHash],
  );
  await observer.query(
    `INSERT INTO identity.device_bindings(
       id, user_id, device_id, session_id, generation, current_hash, current_kid,
       absolute_expires_at, proof_class
     ) VALUES ($1, $2, $3, $4, $5, $6, $7,
       clock_timestamp() + interval '30 days', 'persistent')`,
    [bindingId, fixture.userId, fixture.deviceId, sessionId, generation,
      bindingHash, primaryDerivationKid],
  );
  return bindingId;
}

function completionDispositionInput(
  fixture: Pick<CompletionFixture, 'challengeId' | 'deviceId' | 'input'>
    | Pick<NewIdentityCompletionFixture, 'challengeId' | 'deviceId' | 'input'>,
) {
  return {
    challengeId: fixture.challengeId,
    deviceId: fixture.deviceId,
    binding: fixture.input.newBinding,
  };
}

async function retainedSessionMutationState(sessionId: string): Promise<unknown> {
  const result = await observer.query<{ state: unknown }>(
    `SELECT jsonb_build_object(
       'sessionRevokedAt', session.revoked_at,
       'sessionFamilyId', session.refresh_family_id,
       'sessionGeneration', session.refresh_generation,
       'sessionBindingId', session.current_binding_id,
       'sessionBindingGeneration', session.current_binding_generation,
       'histories', (
         SELECT jsonb_agg(jsonb_build_object(
           'familyId', history.family_id,
           'generation', history.generation,
           'bindingId', history.binding_id,
           'bindingGeneration', history.binding_generation,
           'state', history.state,
           'consumedReason', history.consumed_reason
         ) ORDER BY history.generation)
         FROM identity.session_refresh_history AS history
         WHERE history.session_id = session.id
       ),
       'bindings', (
         SELECT jsonb_agg(jsonb_build_object(
           'id', binding.id,
           'generation', binding.generation,
           'revokedAt', binding.revoked_at
         ) ORDER BY binding.id)
         FROM identity.device_bindings AS binding
         WHERE binding.session_id = session.id
       )
     ) AS state
     FROM identity.sessions AS session
     WHERE session.id = $1`,
    [sessionId],
  );
  return result.rows[0]?.state;
}

async function expectRetainedRevokeFailsClosed(
  fixture: CompletionFixture,
  sessionId: string,
): Promise<void> {
  const before = await retainedSessionMutationState(sessionId);
  await expect(firstService.revokeWebSessionCompletionAttempt(
    fixture.input.attemptId,
    completionDispositionInput(fixture),
    authority,
    'verified_bff',
  )).rejects.toMatchObject({
    code: 'WEB_SESSION_COMPLETION_AUTHORITY_INVALID',
    status: 401,
  });
  expect(await retainedSessionMutationState(sessionId)).toEqual(before);
}

function createService(client: Client, failAfterQuery?: (text: string) => boolean): AuthService {
  return new AuthService(
    new ClientDatabaseAdapter(client, failAfterQuery) as never,
    fieldCrypto,
    new IdempotencyService(),
    new SessionTokenService(),
  );
}

function codeHash(code: string): Buffer {
  return createHmac('sha256', refreshHashKey).update(code).digest();
}

function refreshHash(secret: string): Buffer {
  return createHmac('sha256', refreshHashKey).update(secret).digest();
}

async function seedCompletionFixture(): Promise<CompletionFixture> {
  const userId = randomUUID();
  const challengeId = randomUUID();
  const deviceId = randomUUID();
  const attemptId = randomUUID();
  const bindingId = randomUUID();
  const code = '734921';
  const email = `completion-${randomUUID()}@example.test`;
  const emailHash = fieldCrypto.lookupHash(email);
  const emailCipher = fieldCrypto.encrypt(email);
  const proof = randomBytes(32).toString('base64url');

  await observer.query(
    'INSERT INTO identity.users(id, public_handle) VALUES ($1, $2)',
    [userId, `complete_${userId.replaceAll('-', '').slice(0, 12)}`],
  );
  await observer.query(
    `INSERT INTO identity.auth_identities(
       user_id, provider, provider_subject, email_cipher, email_hash
     ) VALUES ($1, 'email', $2, $3, $4)`,
    [userId, emailHash.toString('hex'), emailCipher, emailHash],
  );
  await observer.query(
    `INSERT INTO identity.email_challenges(
       id, email_hash, email_cipher, code_hash, device_id, expires_at
     ) VALUES ($1, $2, $3, $4, $5, clock_timestamp() + interval '10 minutes')`,
    [challengeId, emailHash, emailCipher, codeHash(code), deviceId],
  );

  const fixture: CompletionFixture = {
    userId,
    challengeId,
    deviceId,
    code,
    input: {
      credential: { provider: 'email', challengeId, code },
      deviceId,
      attemptId,
      newBinding: {
        bindingId,
        generation: 0,
        proof,
        proofClass: 'persistent',
      },
    },
  };
  fixtures.push(fixture);
  return fixture;
}

async function seedNewIdentityCompletionFixture(
  expiresInMilliseconds = 600_000,
): Promise<NewIdentityCompletionFixture> {
  const challengeId = randomUUID();
  const deviceId = randomUUID();
  const attemptId = randomUUID();
  const bindingId = randomUUID();
  const code = '842367';
  const email = `new-completion-${randomUUID()}@example.test`;
  const emailHash = fieldCrypto.lookupHash(email);
  const emailCipher = fieldCrypto.encrypt(email);
  const providerSubject = emailHash.toString('hex');
  const proof = randomBytes(32).toString('base64url');

  await observer.query(
    `INSERT INTO identity.email_challenges(
       id, email_hash, email_cipher, code_hash, device_id, expires_at
     ) VALUES (
       $1, $2, $3, $4, $5,
       clock_timestamp() + ($6::integer * interval '1 millisecond')
     )`,
    [challengeId, emailHash, emailCipher, codeHash(code), deviceId, expiresInMilliseconds],
  );

  const fixture: NewIdentityCompletionFixture = {
    providerSubject,
    challengeId,
    deviceId,
    code,
    input: {
      credential: { provider: 'email', challengeId, code },
      deviceId,
      attemptId,
      newBinding: {
        bindingId,
        generation: 0,
        proof,
        proofClass: 'persistent',
      },
    },
  };
  newIdentityFixtures.push(fixture);
  return fixture;
}

async function completionState(challengeId: string): Promise<CompletionStateRow> {
  const result = await observer.query<CompletionStateRow>(
    `SELECT
       session.id AS session_id,
       session.user_id AS session_user_id,
       session.device_id AS session_device_id,
       session.refresh_hash,
       session.refresh_family_id,
       session.refresh_generation,
       session.current_derivation_kid,
       session.current_binding_id,
       session.current_binding_generation,
       session.transport_class,
       session.expires_at AS session_expires_at,
       session.revoked_at AS session_revoked_at,
       session.reuse_detected_at,
       history.family_id AS history_family_id,
       history.generation AS history_generation,
       history.token_hash AS history_token_hash,
       history.derivation_kid AS history_derivation_kid,
       history.transport_class AS history_transport_class,
       history.binding_id AS history_binding_id,
       history.binding_generation AS history_binding_generation,
       history.state AS history_state,
       binding.user_id AS binding_user_id,
       binding.device_id AS binding_device_id,
       binding.session_id AS binding_session_id,
       binding.generation AS binding_generation,
       binding.current_hash AS binding_current_hash,
       binding.current_kid AS binding_current_kid,
       binding.proof_class AS binding_proof_class,
       binding.revoked_at AS binding_revoked_at,
       binding.absolute_expires_at AS binding_absolute_expires_at,
       registry.proof_class AS registry_proof_class,
       outcome.challenge_id AS outcome_challenge_id,
       outcome.attempt_hash AS outcome_attempt_hash,
       outcome.request_digest AS outcome_request_digest,
       outcome.user_id AS outcome_user_id,
       outcome.device_id AS outcome_device_id,
       outcome.session_id AS outcome_session_id,
       outcome.family_id AS outcome_family_id,
       outcome.binding_id AS outcome_binding_id,
       outcome.refresh_generation AS outcome_refresh_generation,
       outcome.binding_generation AS outcome_binding_generation,
       outcome.derivation_version AS outcome_derivation_version,
       outcome.derivation_kid AS outcome_derivation_kid,
       outcome.created_at AS outcome_created_at,
       outcome.recovery_expires_at AS outcome_recovery_expires_at,
       outcome.created_at >= challenge.verified_at
         AS outcome_recorded_after_verification,
       challenge.verified_at AS challenge_verified_at
     FROM identity.web_session_completion_outcomes AS outcome
     JOIN identity.email_challenges AS challenge ON challenge.id = outcome.challenge_id
     JOIN identity.sessions AS session ON session.id = outcome.session_id
     JOIN identity.session_refresh_history AS history
       ON history.session_id = session.id
      AND history.generation = outcome.refresh_generation
     JOIN identity.device_bindings AS binding ON binding.id = outcome.binding_id
     JOIN identity.proof_hash_classes AS registry
       ON registry.proof_hash = binding.current_hash
     WHERE outcome.challenge_id = $1`,
    [challengeId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Expected one completed Web session state');
  return row;
}

async function mutationCounts(fixture: CompletionFixture): Promise<{
  readonly attempts: number;
  readonly verified_at: Date | null;
  readonly devices: string;
  readonly sessions: string;
  readonly bindings: string;
  readonly outcomes: string;
}> {
  const result = await observer.query<{
    attempts: number;
    verified_at: Date | null;
    devices: string;
    sessions: string;
    bindings: string;
    outcomes: string;
  }>(
    `SELECT challenge.attempts, challenge.verified_at,
       (SELECT count(*) FROM identity.devices WHERE id = $2)::text AS devices,
       (SELECT count(*) FROM identity.sessions WHERE user_id = $3)::text AS sessions,
       (SELECT count(*) FROM identity.device_bindings WHERE user_id = $3)::text AS bindings,
       (SELECT count(*) FROM identity.web_session_completion_outcomes
         WHERE challenge_id = $1)::text AS outcomes
     FROM identity.email_challenges AS challenge
     WHERE challenge.id = $1`,
    [fixture.challengeId, fixture.deviceId, fixture.userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Expected seeded challenge mutation counters');
  return row;
}

async function expectSingleCompletion(fixture: CompletionFixture): Promise<void> {
  const counts = await mutationCounts(fixture);
  expect(counts).toMatchObject({ devices: '1', sessions: '1', bindings: '1', outcomes: '1' });
}

interface GlobalCompletionCounts {
  readonly users: string;
  readonly profiles: string;
  readonly wallets: string;
  readonly identities: string;
  readonly devices: string;
  readonly sessions: string;
  readonly bindings: string;
  readonly outcomes: string;
  readonly changes: string;
  readonly outbox: string;
}

async function globalCompletionCounts(): Promise<GlobalCompletionCounts> {
  const result = await observer.query<GlobalCompletionCounts>(
    `SELECT
       (SELECT count(*) FROM identity.users)::text AS users,
       (SELECT count(*) FROM identity.profiles)::text AS profiles,
       (SELECT count(*) FROM commerce.wallets)::text AS wallets,
       (SELECT count(*) FROM identity.auth_identities)::text AS identities,
       (SELECT count(*) FROM identity.devices)::text AS devices,
       (SELECT count(*) FROM identity.sessions)::text AS sessions,
       (SELECT count(*) FROM identity.device_bindings)::text AS bindings,
       (SELECT count(*) FROM identity.web_session_completion_outcomes)::text AS outcomes,
       (SELECT count(*) FROM sync.change_log)::text AS changes,
       (SELECT count(*) FROM sync.outbox_events)::text AS outbox`,
  );
  const row = result.rows[0];
  if (!row) throw new Error('Expected global completion counters');
  return row;
}

function countDelta(
  before: GlobalCompletionCounts,
  after: GlobalCompletionCounts,
): Record<keyof GlobalCompletionCounts, number> {
  return Object.fromEntries(
    Object.keys(before).map((key) => [
      key,
      Number(after[key as keyof GlobalCompletionCounts])
        - Number(before[key as keyof GlobalCompletionCounts]),
    ]),
  ) as Record<keyof GlobalCompletionCounts, number>;
}

async function challengeSafetyState(challengeId: string): Promise<{
  readonly attempts: number;
  readonly verified_at: Date | null;
  readonly suspended_until: Date | null;
}> {
  const result = await observer.query<{
    attempts: number;
    verified_at: Date | null;
    suspended_until: Date | null;
  }>(
    `SELECT attempts, verified_at, suspended_until
     FROM identity.email_challenges
     WHERE id = $1`,
    [challengeId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Expected challenge safety state');
  return row;
}

async function completeInFreshProcess(
  input: WebEmailSessionCompletionInput,
  currentKid: string,
): Promise<{ configuredKid: string; material: WebSessionCompletionMaterial }> {
  const childPath = resolve(
    import.meta.dirname,
    'web-session-completion-recovery.child.ts',
  );
  const apiDirectory = resolve(import.meta.dirname, '../../..');
  const child = spawn(process.execPath, ['--import', 'tsx', childPath], {
    cwd: apiDirectory,
    env: {
      ...process.env,
      DATABASE_URL: databaseURL,
      SPOTT_TEST_DATABASE_URL: databaseURL,
      REFRESH_TOKEN_DERIVATION_CURRENT_KID: currentKid,
      WEB_SESSION_RECOVERY_SECONDS: '120',
      WEB_SESSION_COMPLETION_RECOVERY_SECONDS: '120',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(JSON.stringify(input));
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal !== null) reject(new Error(`Fresh recovery child terminated by ${signal}`));
      else resolveExit(code ?? 1);
    });
  });
  if (exitCode !== 0) {
    throw new Error(`Fresh recovery child exited ${exitCode}: ${stderr}`);
  }
  return JSON.parse(stdout) as {
    configuredKid: string;
    material: WebSessionCompletionMaterial;
  };
}

describe('atomic Web email session completion on PostgreSQL', () => {
  beforeAll(async () => {
    observer = new Client({
      connectionString: databaseURL,
      application_name: 'spott-web-completion-integration-observer',
    });
    firstClient = new Client({
      connectionString: databaseURL,
      application_name: 'spott-web-completion-integration-first',
    });
    secondClient = new Client({
      connectionString: databaseURL,
      application_name: 'spott-web-completion-integration-second',
    });
    await Promise.all([observer.connect(), firstClient.connect(), secondClient.connect()]);
    firstService = createService(firstClient);
    secondService = createService(secondClient);
  });

  afterEach(async () => {
    if (fixtures.length === 0 && newIdentityFixtures.length === 0) return;
    const completed = fixtures.splice(0);
    const newIdentities = newIdentityFixtures.splice(0);
    const challengeIds = [
      ...completed.map((fixture) => fixture.challengeId),
      ...newIdentities.map((fixture) => fixture.challengeId),
    ];
    const discoveredUsers = newIdentities.length === 0
      ? []
      : (await observer.query<{ user_id: string }>(
          `SELECT user_id
           FROM identity.auth_identities
           WHERE provider = 'email' AND provider_subject = ANY($1::text[])`,
          [newIdentities.map((fixture) => fixture.providerSubject)],
        )).rows.map((row) => row.user_id);
    const userIds = [...new Set([
      ...completed.map((fixture) => fixture.userId),
      ...discoveredUsers,
    ])];

    await observer.query(
      `DELETE FROM identity.web_session_completion_dispositions
       WHERE challenge_id = ANY($1::uuid[])`,
      [challengeIds],
    );
    await observer.query(
      `DELETE FROM identity.web_session_completion_outcomes
       WHERE challenge_id = ANY($1::uuid[])`,
      [challengeIds],
    );
    if (userIds.length !== 0) {
      await observer.query(
        `UPDATE identity.sessions
         SET current_binding_id = NULL, current_binding_generation = NULL
         WHERE user_id = ANY($1::uuid[])`,
        [userIds],
      );
      await observer.query(
        'DELETE FROM identity.device_bindings WHERE user_id = ANY($1::uuid[])',
        [userIds],
      );
      await observer.query(
        'DELETE FROM identity.sessions WHERE user_id = ANY($1::uuid[])',
        [userIds],
      );
      await observer.query(
        'DELETE FROM identity.devices WHERE user_id = ANY($1::uuid[])',
        [userIds],
      );
      await observer.query(
        'DELETE FROM identity.auth_identities WHERE user_id = ANY($1::uuid[])',
        [userIds],
      );
      await observer.query(
        'DELETE FROM identity.profiles WHERE user_id = ANY($1::uuid[])',
        [userIds],
      );
      await observer.query(
        'DELETE FROM commerce.wallets WHERE user_id = ANY($1::uuid[])',
        [userIds],
      );
      await observer.query(
        `DELETE FROM sync.change_log
         WHERE user_scope = ANY($1::uuid[]) OR entity_id = ANY($1::uuid[])`,
        [userIds],
      );
      await observer.query(
        `DELETE FROM sync.outbox_events
         WHERE aggregate = 'identity.user' AND aggregate_id = ANY($1::uuid[])`,
        [userIds],
      );
      await observer.query('DELETE FROM identity.users WHERE id = ANY($1::uuid[])', [userIds]);
    }
    await observer.query(
      'DELETE FROM identity.email_challenges WHERE id = ANY($1::uuid[])',
      [challengeIds],
    );
    process.env.REFRESH_TOKEN_DERIVATION_CURRENT_KID = primaryDerivationKid;
  });

  afterAll(async () => {
    await Promise.all([
      observer?.end(),
      firstClient?.end(),
      secondClient?.end(),
    ]);
  });

  it('creates one canonical s2 generation-zero session with every persisted layer aligned', async () => {
    const fixture = await seedCompletionFixture();
    const { pending, material: completed } = await completeAndAccept(firstService, fixture);
    expect(pending).toEqual({
      state: 'pending',
      sessionId: completed.sessionId,
      bindingId: completed.bindingId,
      deviceId: fixture.deviceId,
    });
    expect(JSON.stringify(pending).toLowerCase()).not.toMatch(/token|proof|secret/u);
    const credential = parseRefreshToken(completed.refreshToken);

    expect(credential).toMatchObject({
      version: 's2',
      sessionId: completed.sessionId,
      generation: 0,
    });
    if (!credential || credential.version !== 's2') {
      throw new Error('Atomic completion did not return a canonical s2 refresh token');
    }
    expect(credential.secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(completed).toMatchObject({
      refreshGeneration: 0,
      transportClass: 'web_bff',
      bindingId: fixture.input.newBinding.bindingId,
      bindingGeneration: 0,
      user: { id: fixture.userId },
    });

    const state = await completionState(fixture.challengeId);
    expect(state).toMatchObject({
      session_id: completed.sessionId,
      session_user_id: fixture.userId,
      session_device_id: fixture.deviceId,
      refresh_family_id: completed.refreshFamilyId,
      refresh_generation: '0',
      current_derivation_kid: primaryDerivationKid,
      current_binding_id: fixture.input.newBinding.bindingId,
      current_binding_generation: '0',
      transport_class: 'web_bff',
      session_revoked_at: null,
      reuse_detected_at: null,
      history_family_id: completed.refreshFamilyId,
      history_generation: '0',
      history_derivation_kid: primaryDerivationKid,
      history_transport_class: 'web_bff',
      history_binding_id: fixture.input.newBinding.bindingId,
      history_binding_generation: '0',
      history_state: 'current',
      binding_user_id: fixture.userId,
      binding_device_id: fixture.deviceId,
      binding_session_id: completed.sessionId,
      binding_generation: '0',
      binding_current_kid: primaryDerivationKid,
      binding_proof_class: 'persistent',
      binding_revoked_at: null,
      registry_proof_class: 'persistent',
      outcome_challenge_id: fixture.challengeId,
      outcome_user_id: fixture.userId,
      outcome_device_id: fixture.deviceId,
      outcome_session_id: completed.sessionId,
      outcome_family_id: completed.refreshFamilyId,
      outcome_binding_id: fixture.input.newBinding.bindingId,
      outcome_refresh_generation: '0',
      outcome_binding_generation: '0',
      outcome_derivation_version: 'v1',
      outcome_derivation_kid: primaryDerivationKid,
    });
    expect(state.challenge_verified_at).toBeInstanceOf(Date);
    expect(state.session_expires_at.toISOString()).toBe(completed.refreshTokenExpiresAt);
    expect(state.binding_absolute_expires_at.toISOString()).toBe(
      completed.bindingAbsoluteExpiresAt,
    );
    expect(state.outcome_attempt_hash).toEqual(completionAttemptHash(fixture.input.attemptId));
    expect(state.outcome_request_digest).toHaveLength(32);
    expect(
      state.outcome_recovery_expires_at.getTime() - state.outcome_created_at.getTime(),
    ).toBe(1_000);
    expect(state.outcome_recorded_after_verification).toBe(true);
    expect(state.refresh_hash).toEqual(refreshHash(credential.secret));
    expect(state.history_token_hash).toEqual(state.refresh_hash);
    expect(state.binding_current_hash).toEqual(persistentDeviceBindingHash({
      proof: fixture.input.newBinding.proof,
      kid: primaryDerivationKid,
      userId: fixture.userId,
      deviceId: fixture.deviceId,
      sessionId: completed.sessionId,
      bindingId: fixture.input.newBinding.bindingId,
      generation: 0,
    }));
    await expectSingleCompletion(fixture);
  });

  it('atomically creates a first user, profile, wallet, identity, device, session, binding, and outcome', async () => {
    const fixture = await seedNewIdentityCompletionFixture();
    const before = await globalCompletionCounts();

    const { material: completed } = await completeAndAccept(firstService, fixture);

    const after = await globalCompletionCounts();
    expect(countDelta(before, after)).toEqual({
      users: 1,
      profiles: 1,
      wallets: 1,
      identities: 1,
      devices: 1,
      sessions: 1,
      bindings: 1,
      outcomes: 1,
      changes: 1,
      outbox: 1,
    });
    const identity = await observer.query<{ user_id: string }>(
      `SELECT user_id FROM identity.auth_identities
       WHERE provider = 'email' AND provider_subject = $1`,
      [fixture.providerSubject],
    );
    expect(identity.rows).toEqual([{ user_id: completed.user.id }]);
    const challenge = await challengeSafetyState(fixture.challengeId);
    expect(challenge.attempts).toBe(0);
    expect(challenge.verified_at).toBeInstanceOf(Date);
    expect(challenge.suspended_until).toBeNull();
  });

  it('rolls back every first-user layer and challenge consumption when a post-outcome transaction step fails', async () => {
    const fixture = await seedNewIdentityCompletionFixture();
    const before = await globalCompletionCounts();
    const failingService = createService(
      firstClient,
      (sql) => sql.includes('INSERT INTO identity.web_session_completion_outcomes'),
    );

    await expect(failingService.completeWebEmailSession(
      fixture.input,
      authority,
      'verified_bff',
    )).rejects.toThrow('INJECTED_POST_QUERY_TRANSACTION_FAILURE');

    expect(await globalCompletionCounts()).toEqual(before);
    expect(await challengeSafetyState(fixture.challengeId)).toEqual({
      attempts: 0,
      verified_at: null,
      suspended_until: null,
    });
    const identity = await observer.query(
      `SELECT user_id FROM identity.auth_identities
       WHERE provider = 'email' AND provider_subject = $1`,
      [fixture.providerSubject],
    );
    expect(identity.rowCount).toBe(0);
  });

  it('uses the database clock for challenge expiry even when the API host clock is far ahead', async () => {
    const fixture = await seedCompletionFixture();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2099-01-01T00:00:00.000Z'));
    try {
      const completed = await firstService.completeWebEmailSession(
        fixture.input,
        authority,
        'verified_bff',
      );
      expect(completed.sessionId).toMatch(/^[0-9a-f-]{36}$/u);
    } finally {
      vi.useRealTimers();
    }
    await expectSingleCompletion(fixture);
  });

  it('uses the database clock for elapsed suspension even when the API host clock is far behind', async () => {
    const fixture = await seedCompletionFixture();
    await observer.query(
      `UPDATE identity.email_challenges
       SET suspended_until = clock_timestamp() - interval '1 second'
       WHERE id = $1`,
      [fixture.challengeId],
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));
    try {
      const completed = await firstService.completeWebEmailSession(
        fixture.input,
        authority,
        'verified_bff',
      );
      expect(completed.sessionId).toMatch(/^[0-9a-f-]{36}$/u);
    } finally {
      vi.useRealTimers();
    }
    await expectSingleCompletion(fixture);
  });

  it('guarantees the configured recovery window even when OTP validity is about to expire', async () => {
    const fixture = await seedNewIdentityCompletionFixture(800);

    await firstService.completeWebEmailSession(fixture.input, authority, 'verified_bff');

    const state = await completionState(fixture.challengeId);
    expect(
      state.outcome_recovery_expires_at.getTime() - state.outcome_created_at.getTime(),
    ).toBe(1_000);
    expect(state.outcome_recorded_after_verification).toBe(true);
  });

  it('stores only hashes and metadata, never OTP, binding proof, or refresh plaintext', async () => {
    const fixture = await seedCompletionFixture();
    const { material: completed } = await completeAndAccept(firstService, fixture);
    const credential = parseRefreshToken(completed.refreshToken);
    if (!credential || credential.version !== 's2') throw new Error('Expected canonical s2 token');

    const state = await completionState(fixture.challengeId);
    const scopedRows = await observer.query<{ persisted: string }>(
      `SELECT concat_ws('|',
         outcome::text,
         disposition::text,
         session::text,
         history::text,
         binding::text,
         challenge::text
       ) AS persisted
       FROM identity.web_session_completion_outcomes AS outcome
       JOIN identity.web_session_completion_dispositions AS disposition
         ON disposition.attempt_hash = outcome.attempt_hash
       JOIN identity.sessions AS session ON session.id = outcome.session_id
       JOIN identity.session_refresh_history AS history
         ON history.session_id = session.id AND history.generation = 0
       JOIN identity.device_bindings AS binding ON binding.id = outcome.binding_id
       JOIN identity.email_challenges AS challenge ON challenge.id = outcome.challenge_id
       WHERE outcome.challenge_id = $1`,
      [fixture.challengeId],
    );
    const persisted = scopedRows.rows[0]?.persisted ?? '';

    expect(persisted).not.toContain(fixture.code);
    expect(persisted).not.toContain(fixture.input.newBinding.proof);
    expect(persisted).not.toContain(completed.refreshToken);
    expect(persisted).not.toContain(credential.secret);
    expect(state.refresh_hash).not.toEqual(Buffer.from(credential.secret, 'utf8'));
    expect(state.history_token_hash).not.toEqual(Buffer.from(credential.secret, 'utf8'));
    expect(state.binding_current_hash).not.toEqual(
      Buffer.from(fixture.input.newBinding.proof, 'utf8'),
    );
    expect(state.outcome_request_digest).not.toEqual(
      createHash('sha256').update(fixture.code).digest(),
    );
  });

  it('reconstructs the same session and refresh credential on an exact retry', async () => {
    const fixture = await seedCompletionFixture();
    const first = await firstService.completeWebEmailSession(
      fixture.input,
      authority,
      'verified_bff',
    );
    const retry = await firstService.completeWebEmailSession(
      fixture.input,
      authority,
      'verified_bff',
    );

    expect(retry).toEqual(first);
    const firstAccepted = await firstService.acceptWebSessionCompletionAttempt(
      fixture.input.attemptId,
      {
        challengeId: fixture.challengeId,
        deviceId: fixture.deviceId,
        binding: fixture.input.newBinding,
      },
      authority,
      'verified_bff',
    );
    await observer.query('SELECT pg_sleep(1.1)');
    const retryAccepted = await firstService.acceptWebSessionCompletionAttempt(
      fixture.input.attemptId,
      {
        challengeId: fixture.challengeId,
        deviceId: fixture.deviceId,
        binding: fixture.input.newBinding,
      },
      authority,
      'verified_bff',
    );
    if (firstAccepted.state !== 'accepted' || retryAccepted.state !== 'accepted') {
      throw new Error('Expected idempotent accepted completion material');
    }
    expect(retryAccepted.material.sessionId).toBe(firstAccepted.material.sessionId);
    expect(retryAccepted.material.refreshFamilyId).toBe(firstAccepted.material.refreshFamilyId);
    expect(retryAccepted.material.refreshToken).toBe(firstAccepted.material.refreshToken);
    expect(retryAccepted.material.bindingId).toBe(firstAccepted.material.bindingId);
    expect(retryAccepted.material.accessToken).not.toBe(firstAccepted.material.accessToken);
    await expectSingleCompletion(fixture);
  });

  it('closes recovery by the database clock even when the API host clock is behind', async () => {
    const fixture = await seedCompletionFixture();
    await firstService.completeWebEmailSession(fixture.input, authority, 'verified_bff');
    await observer.query('SELECT pg_sleep(1.1)');

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));
    try {
      await expect(secondService.completeWebEmailSession(
        fixture.input,
        authority,
        'verified_bff',
      )).rejects.toMatchObject({ code: 'AUTH_CHALLENGE_UNAVAILABLE', status: 401 });
    } finally {
      vi.useRealTimers();
    }

    await expectSingleCompletion(fixture);
  });

  it('recovers with the persisted derivation KID after a fresh process boots on a rotated current KID', async () => {
    const fixture = await seedCompletionFixture();
    const firstProcess = await completeInFreshProcess(
      fixture.input,
      primaryDerivationKid,
    );
    const first = firstProcess.material;
    expect(firstProcess.configuredKid).toBe(primaryDerivationKid);
    const before = await completionState(fixture.challengeId);
    expect(before.outcome_derivation_kid).toBe(primaryDerivationKid);
    expect(before.current_derivation_kid).toBe(primaryDerivationKid);
    expect(before.binding_current_kid).toBe(primaryDerivationKid);

    const recovered = await completeInFreshProcess(fixture.input, retainedDerivationKid);
    const retry = recovered.material;

    expect(recovered.configuredKid).toBe(retainedDerivationKid);
    expect(retry.sessionId).toBe(first.sessionId);
    expect(retry.refreshToken).toBe(first.refreshToken);
    const after = await completionState(fixture.challengeId);
    expect(after.outcome_derivation_kid).toBe(primaryDerivationKid);
    expect(after.current_derivation_kid).toBe(primaryDerivationKid);
    await expectSingleCompletion(fixture);
  }, 15_000);

  it('allows only the OTP safety counter mutation for a wrong first-user code', async () => {
    const fixture = await seedNewIdentityCompletionFixture();
    const before = await globalCompletionCounts();

    await expect(firstService.completeWebEmailSession(
      {
        ...fixture.input,
        credential: { ...fixture.input.credential, code: '000000' },
      },
      authority,
      'verified_bff',
    )).rejects.toMatchObject({ code: 'OTP_INVALID', status: 400 });

    expect(await globalCompletionCounts()).toEqual(before);
    expect(await challengeSafetyState(fixture.challengeId)).toEqual({
      attempts: 1,
      verified_at: null,
      suspended_until: null,
    });
  });

  it('allows suspension after five wrong codes but still creates no identity or session state', async () => {
    const fixture = await seedNewIdentityCompletionFixture();
    const before = await globalCompletionCounts();
    const wrongInput: WebEmailSessionCompletionInput = {
      ...fixture.input,
      credential: { ...fixture.input.credential, code: '000000' },
    };

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expect(firstService.completeWebEmailSession(
        wrongInput,
        authority,
        'verified_bff',
      )).rejects.toMatchObject({
        code: 'OTP_INVALID',
        status: 400,
        meta: { remainingAttempts: 5 - attempt },
      });
    }
    let limitedError: unknown;
    try {
      await firstService.completeWebEmailSession(wrongInput, authority, 'verified_bff');
    } catch (error) {
      limitedError = error;
    }
    expect(limitedError).toBeInstanceOf(DomainError);
    if (!(limitedError instanceof DomainError)) throw new Error('Expected OTP rate limit');
    expect(limitedError).toMatchObject({
      code: 'OTP_RATE_LIMITED',
      status: 429,
      meta: { remainingAttempts: 0 },
    });
    expect(typeof limitedError.meta.retryAt).toBe('string');

    expect(await globalCompletionCounts()).toEqual(before);
    const challenge = await challengeSafetyState(fixture.challengeId);
    expect(challenge.attempts).toBe(5);
    expect(challenge.verified_at).toBeNull();
    expect(challenge.suspended_until).toBeInstanceOf(Date);
  });

  it('rejects changed proof, attempt, code, and challenge without minting another session', async () => {
    const completedFixture = await seedCompletionFixture();
    await firstService.completeWebEmailSession(
      completedFixture.input,
      authority,
      'verified_bff',
    );
    const changedProof: WebEmailSessionCompletionInput = {
      ...completedFixture.input,
      newBinding: {
        ...completedFixture.input.newBinding,
        proof: randomBytes(32).toString('base64url'),
      },
    };
    const changedAttempt: WebEmailSessionCompletionInput = {
      ...completedFixture.input,
      attemptId: randomUUID(),
    };

    await expect(firstService.completeWebEmailSession(
      changedProof,
      authority,
      'verified_bff',
    )).rejects.toMatchObject({
      code: 'WEB_SESSION_COMPLETION_AUTHORITY_INVALID',
      status: 401,
    });
    await expect(firstService.completeWebEmailSession(
      changedAttempt,
      authority,
      'verified_bff',
    )).rejects.toMatchObject({ code: 'AUTH_CHALLENGE_UNAVAILABLE', status: 401 });
    await expectSingleCompletion(completedFixture);

    const wrongCodeFixture = await seedCompletionFixture();
    await expect(firstService.completeWebEmailSession(
      {
        ...wrongCodeFixture.input,
        credential: { ...wrongCodeFixture.input.credential, code: '000000' },
      },
      authority,
      'verified_bff',
    )).rejects.toMatchObject({ code: 'OTP_INVALID', status: 400 });
    expect(await mutationCounts(wrongCodeFixture)).toMatchObject({
      attempts: 1,
      verified_at: null,
      devices: '0',
      sessions: '0',
      bindings: '0',
      outcomes: '0',
    });

    const missingChallengeFixture = await seedCompletionFixture();
    await expect(firstService.completeWebEmailSession(
      {
        ...missingChallengeFixture.input,
        credential: {
          ...missingChallengeFixture.input.credential,
          challengeId: randomUUID(),
        },
      },
      authority,
      'verified_bff',
    )).rejects.toMatchObject({ code: 'AUTH_CHALLENGE_UNAVAILABLE', status: 401 });
    expect(await mutationCounts(missingChallengeFixture)).toMatchObject({
      attempts: 0,
      verified_at: null,
      devices: '0',
      sessions: '0',
      bindings: '0',
      outcomes: '0',
    });
  });

  it('requires verified BFF authority and channel before any database mutation', async () => {
    const missingAuthority = await seedCompletionFixture();
    await expect(firstService.completeWebEmailSession(
      missingAuthority.input,
      undefined,
      'verified_bff',
    )).rejects.toMatchObject({ code: 'WEB_BFF_AUTHORITY_REQUIRED', status: 403 });
    expect(await mutationCounts(missingAuthority)).toMatchObject({
      attempts: 0,
      verified_at: null,
      devices: '0',
      sessions: '0',
      bindings: '0',
      outcomes: '0',
    });

    const wrongChannel = await seedCompletionFixture();
    await expect(firstService.completeWebEmailSession(
      wrongChannel.input,
      authority,
      'consumer_web',
    )).rejects.toMatchObject({ code: 'SESSION_TRANSPORT_MISMATCH', status: 403 });
    expect(await mutationCounts(wrongChannel)).toMatchObject({
      attempts: 0,
      verified_at: null,
      devices: '0',
      sessions: '0',
      bindings: '0',
      outcomes: '0',
    });
  });

  it.each([
    ['restricted', []],
    ['suspended', []],
    ['active', ['loginBlocked']],
  ] as const)(
    'rejects a %s account before creating any Web session state',
    async (status, restrictions) => {
      const fixture = await seedCompletionFixture();
      await observer.query(
        `UPDATE identity.users
         SET status = $2::identity.user_status, restriction_flags = $3::text[]
         WHERE id = $1`,
        [fixture.userId, status, [...restrictions]],
      );

      await expect(firstService.completeWebEmailSession(
        fixture.input,
        authority,
        'verified_bff',
      )).rejects.toMatchObject({ code: 'AUTH_CHALLENGE_UNAVAILABLE', status: 401 });

      expect(await mutationCounts(fixture)).toMatchObject({
        attempts: 0,
        verified_at: null,
        devices: '0',
        sessions: '0',
        bindings: '0',
        outcomes: '0',
      });
    },
  );

  it('rejects a blocked device before creating any Web session state', async () => {
    const fixture = await seedCompletionFixture();
    await observer.query(
      `INSERT INTO identity.devices(id, user_id, platform, risk_state)
       VALUES ($1, $2, 'web', 'blocked')`,
      [fixture.deviceId, fixture.userId],
    );

    await expect(firstService.completeWebEmailSession(
      fixture.input,
      authority,
      'verified_bff',
    )).rejects.toMatchObject({ code: 'AUTH_CHALLENGE_UNAVAILABLE', status: 401 });

    expect(await mutationCounts(fixture)).toMatchObject({
      attempts: 0,
      verified_at: null,
      devices: '1',
      sessions: '0',
      bindings: '0',
      outcomes: '0',
    });
  });

  it('does not resurrect generation zero after the completed session has rotated', async () => {
    const fixture = await seedCompletionFixture();
    const pending = await firstService.completeWebEmailSession(
      fixture.input,
      authority,
      'verified_bff',
    );
    const completed = await acceptPendingCompletion(firstService, fixture, pending);
    const rotated = await firstService.refresh(
      completed.refreshToken,
      fixture.deviceId,
      'web',
      authority,
      'verified_bff',
      randomUUID(),
      fixture.input.newBinding,
      {
        sessionId: completed.sessionId,
        familyId: completed.refreshFamilyId,
        generation: 0,
        transportClass: 'web_bff',
        persistentBindingId: completed.bindingId,
        persistentBindingGeneration: 0,
      },
    );
    expect(rotated).toMatchObject({ sessionId: completed.sessionId, refreshGeneration: 1 });

    await expect(firstService.completeWebEmailSession(
      fixture.input,
      authority,
      'verified_bff',
    )).rejects.toMatchObject({ code: 'AUTH_CHALLENGE_UNAVAILABLE', status: 401 });

    const state = await observer.query<{
      refresh_generation: string;
      session_count: string;
      generation_zero_state: string;
      generation_one_state: string;
    }>(
      `SELECT session.refresh_generation,
         (SELECT count(*) FROM identity.sessions counted
           WHERE counted.user_id = session.user_id)::text AS session_count,
         zero_history.state AS generation_zero_state,
         one_history.state AS generation_one_state
       FROM identity.sessions AS session
       JOIN identity.session_refresh_history AS zero_history
         ON zero_history.session_id = session.id AND zero_history.generation = 0
       JOIN identity.session_refresh_history AS one_history
         ON one_history.session_id = session.id AND one_history.generation = 1
       WHERE session.id = $1`,
      [completed.sessionId],
    );
    expect(state.rows).toEqual([{
      refresh_generation: '1',
      session_count: '1',
      generation_zero_state: 'consumed',
      generation_one_state: 'current',
    }]);
  });

  it('serializes the same attempt across independent connections into exactly one session', async () => {
    const fixture = await seedCompletionFixture();
    const [first, second] = await Promise.all([
      firstService.completeWebEmailSession(fixture.input, authority, 'verified_bff'),
      secondService.completeWebEmailSession(fixture.input, authority, 'verified_bff'),
    ]);

    expect(second).toEqual(first);
    await expectSingleCompletion(fixture);
  });

  it('serializes one challenge with different attempts so exactly one identity can win', async () => {
    const fixture = await seedCompletionFixture();
    const competingInput: WebEmailSessionCompletionInput = {
      ...fixture.input,
      attemptId: randomUUID(),
    };

    const results = await Promise.allSettled([
      firstService.completeWebEmailSession(fixture.input, authority, 'verified_bff'),
      secondService.completeWebEmailSession(competingInput, authority, 'verified_bff'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { code: 'AUTH_CHALLENGE_UNAVAILABLE', status: 401 },
    });
    await expectSingleCompletion(fixture);
  });

  it('serializes one attempt reused across different challenges so exactly one challenge can win', async () => {
    const firstFixture = await seedCompletionFixture();
    const secondFixture = await seedCompletionFixture();
    const competingInput: WebEmailSessionCompletionInput = {
      ...secondFixture.input,
      attemptId: firstFixture.input.attemptId,
    };

    const results = await Promise.allSettled([
      firstService.completeWebEmailSession(firstFixture.input, authority, 'verified_bff'),
      secondService.completeWebEmailSession(competingInput, authority, 'verified_bff'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { code: 'WEB_SESSION_COMPLETION_AUTHORITY_INVALID', status: 401 },
    });
    const aggregate = await observer.query<{
      outcomes: string;
      sessions: string;
      bindings: string;
      verified: string;
    }>(
      `SELECT
         (SELECT count(*) FROM identity.web_session_completion_outcomes
          WHERE challenge_id = ANY($1::uuid[]))::text AS outcomes,
         (SELECT count(*) FROM identity.sessions
          WHERE user_id = ANY($2::uuid[]))::text AS sessions,
         (SELECT count(*) FROM identity.device_bindings
          WHERE user_id = ANY($2::uuid[]))::text AS bindings,
         (SELECT count(*) FROM identity.email_challenges
          WHERE id = ANY($1::uuid[]) AND verified_at IS NOT NULL)::text AS verified`,
      [
        [firstFixture.challengeId, secondFixture.challengeId],
        [firstFixture.userId, secondFixture.userId],
      ],
    );
    expect(aggregate.rows).toEqual([{
      outcomes: '1',
      sessions: '1',
      bindings: '1',
      verified: '1',
    }]);
  });

  it('requires a matching accepted outcome across every session authority path', async () => {
    const fixture = await seedCompletionFixture();
    const pending = await firstService.completeWebEmailSession(
      fixture.input,
      authority,
      'verified_bff',
    );
    const stateBeforeAccept = await completionState(fixture.challengeId);
    const pendingRefreshSecret = deriveInitialWebRefreshSecret({
      key: primaryDerivationKey,
      kid: primaryDerivationKid,
      attemptHash: completionAttemptHash(fixture.input.attemptId),
      challengeId: fixture.challengeId,
      userId: fixture.userId,
      deviceId: fixture.deviceId,
      sessionId: pending.sessionId,
      familyId: stateBeforeAccept.outcome_family_id,
      bindingId: fixture.input.newBinding.bindingId,
      generation: 0,
      transportClass: 'web_bff',
    });
    const pendingRefreshToken = `s2.${pending.sessionId}.0.${pendingRefreshSecret}`;
    const dispositionInput = {
      challengeId: fixture.challengeId,
      deviceId: fixture.deviceId,
      binding: fixture.input.newBinding,
    };
    const envelope = {
      sessionId: pending.sessionId,
      familyId: stateBeforeAccept.outcome_family_id,
      generation: 0,
      transportClass: 'web_bff' as const,
      persistentBindingId: pending.bindingId,
      persistentBindingGeneration: 0,
    };
    const sessionAuthority = new SessionAuthority(
      new ClientDatabaseAdapter(observer) as never,
    );

    await expect(sessionAuthority.authorize({
      sub: fixture.userId,
      sid: pending.sessionId,
    }, 'consumer')).resolves.toBeNull();
    await expect(firstService.bootstrap(
      pendingRefreshToken,
      fixture.deviceId,
      fixture.input.newBinding,
      authority,
      'verified_bff',
      envelope,
    )).rejects.toMatchObject({ code: 'TOKEN_EXPIRED', status: 401 });
    await expect(firstService.refresh(
      pendingRefreshToken,
      fixture.deviceId,
      'web',
      authority,
      'verified_bff',
      randomUUID(),
      fixture.input.newBinding,
      envelope,
    )).rejects.toMatchObject({ code: 'TOKEN_EXPIRED', status: 401 });

    const accepted = await firstService.acceptWebSessionCompletionAttempt(
      fixture.input.attemptId,
      dispositionInput,
      authority,
      'verified_bff',
    );
    if (accepted.state !== 'accepted') throw new Error('Expected accepted completion');
    expect(accepted.material).toMatchObject({
      sessionId: pending.sessionId,
      refreshToken: pendingRefreshToken,
      refreshFamilyId: stateBeforeAccept.outcome_family_id,
      bindingId: fixture.input.newBinding.bindingId,
    });
    const repeatedAccept = await firstService.acceptWebSessionCompletionAttempt(
      fixture.input.attemptId,
      dispositionInput,
      authority,
      'verified_bff',
    );
    const discardAfterAccept = await firstService.discardWebSessionCompletionAttempt(
      fixture.input.attemptId,
      dispositionInput,
      authority,
      'verified_bff',
    );
    for (const replay of [repeatedAccept, discardAfterAccept]) {
      if (replay.state !== 'accepted') throw new Error('Expected recoverable accepted replay');
      expect(replay.material).toMatchObject({
        sessionId: accepted.material.sessionId,
        refreshToken: accepted.material.refreshToken,
        refreshFamilyId: accepted.material.refreshFamilyId,
        bindingId: accepted.material.bindingId,
      });
    }
    await expect(sessionAuthority.authorize({
      sub: fixture.userId,
      sid: pending.sessionId,
    }, 'consumer')).resolves.toMatchObject({
      id: fixture.userId,
      sessionId: pending.sessionId,
    });
    await expect(firstService.bootstrap(
      accepted.material.refreshToken,
      fixture.deviceId,
      fixture.input.newBinding,
      authority,
      'verified_bff',
      envelope,
    )).resolves.toMatchObject({
      sessionId: pending.sessionId,
      refreshToken: accepted.material.refreshToken,
      refreshGeneration: 0,
    });

    // An accepted disposition is not standalone authority. If its immutable outcome is
    // absent or no longer matches, every consumer of the shared predicate must fail closed.
    await observer.query(
      `DELETE FROM identity.web_session_completion_outcomes
       WHERE challenge_id = $1`,
      [fixture.challengeId],
    );
    await expect(sessionAuthority.authorize({
      sub: fixture.userId,
      sid: pending.sessionId,
    }, 'consumer')).resolves.toBeNull();
    await expect(firstService.bootstrap(
      accepted.material.refreshToken,
      fixture.deviceId,
      fixture.input.newBinding,
      authority,
      'verified_bff',
      envelope,
    )).rejects.toMatchObject({ code: 'TOKEN_EXPIRED', status: 401 });
    await expect(firstService.refresh(
      accepted.material.refreshToken,
      fixture.deviceId,
      'web',
      authority,
      'verified_bff',
      randomUUID(),
      fixture.input.newBinding,
      envelope,
    )).rejects.toMatchObject({ code: 'TOKEN_EXPIRED', status: 401 });
    await expect(firstService.logoutWebSession({
      refreshToken: accepted.material.refreshToken,
      deviceId: fixture.deviceId,
      deviceBindingProof: fixture.input.newBinding,
      refreshEnvelopeClaims: envelope,
    }, authority, 'verified_bff')).rejects.toMatchObject({
      code: 'TOKEN_EXPIRED',
      status: 401,
    });
    await expect(firstService.upgradeDeviceBinding({
      refreshToken: accepted.material.refreshToken,
      deviceId: fixture.deviceId,
      attemptId: randomUUID(),
      newBinding: fixture.input.newBinding,
    }, authority, 'verified_bff')).rejects.toMatchObject({
      code: 'TOKEN_EXPIRED',
      status: 401,
    });
  });

  it('fails closed across every session authority path when an outcome has no disposition', async () => {
    const fixture = await seedCompletionFixture();
    const pending = await firstService.completeWebEmailSession(
      fixture.input,
      authority,
      'verified_bff',
    );
    const state = await completionState(fixture.challengeId);
    const refreshSecret = deriveInitialWebRefreshSecret({
      key: primaryDerivationKey,
      kid: primaryDerivationKid,
      attemptHash: completionAttemptHash(fixture.input.attemptId),
      challengeId: fixture.challengeId,
      userId: fixture.userId,
      deviceId: fixture.deviceId,
      sessionId: pending.sessionId,
      familyId: state.outcome_family_id,
      bindingId: fixture.input.newBinding.bindingId,
      generation: 0,
      transportClass: 'web_bff',
    });
    const refreshToken = `s2.${pending.sessionId}.0.${refreshSecret}`;
    const refreshEnvelopeClaims = {
      sessionId: pending.sessionId,
      familyId: state.outcome_family_id,
      generation: 0,
      transportClass: 'web_bff' as const,
      persistentBindingId: pending.bindingId,
      persistentBindingGeneration: 0,
    };
    await observer.query(
      `DELETE FROM identity.web_session_completion_dispositions
       WHERE attempt_hash = $1`,
      [completionAttemptHash(fixture.input.attemptId)],
    );

    const sessionAuthority = new SessionAuthority(
      new ClientDatabaseAdapter(observer) as never,
    );
    await expect(sessionAuthority.authorize({
      sub: fixture.userId,
      sid: pending.sessionId,
    }, 'consumer')).resolves.toBeNull();
    await expect(firstService.bootstrap(
      refreshToken,
      fixture.deviceId,
      fixture.input.newBinding,
      authority,
      'verified_bff',
      refreshEnvelopeClaims,
    )).rejects.toMatchObject({ code: 'TOKEN_EXPIRED', status: 401 });
    await expect(firstService.refresh(
      refreshToken,
      fixture.deviceId,
      'web',
      authority,
      'verified_bff',
      randomUUID(),
      fixture.input.newBinding,
      refreshEnvelopeClaims,
    )).rejects.toMatchObject({ code: 'TOKEN_EXPIRED', status: 401 });
    await expect(firstService.logoutWebSession({
      refreshToken,
      deviceId: fixture.deviceId,
      deviceBindingProof: fixture.input.newBinding,
      refreshEnvelopeClaims,
    }, authority, 'verified_bff')).rejects.toMatchObject({
      code: 'TOKEN_EXPIRED',
      status: 401,
    });
    await expect(firstService.upgradeDeviceBinding({
      refreshToken,
      deviceId: fixture.deviceId,
      attemptId: randomUUID(),
      newBinding: fixture.input.newBinding,
    }, authority, 'verified_bff')).rejects.toMatchObject({
      code: 'TOKEN_EXPIRED',
      status: 401,
    });
    await expect(firstService.completeWebEmailSession(
      fixture.input,
      authority,
      'verified_bff',
    )).rejects.toMatchObject({ code: 'AUTH_CHALLENGE_UNAVAILABLE', status: 401 });

    const unchanged = await observer.query<{
      revoked_at: Date | null;
      history_state: string;
      binding_revoked_at: Date | null;
    }>(
      `SELECT session.revoked_at, history.state AS history_state,
              binding.revoked_at AS binding_revoked_at
       FROM identity.sessions AS session
       JOIN identity.session_refresh_history AS history
         ON history.session_id = session.id AND history.generation = 0
       JOIN identity.device_bindings AS binding ON binding.id = $2
       WHERE session.id = $1`,
      [pending.sessionId, pending.bindingId],
    );
    expect(unchanged.rows).toEqual([{
      revoked_at: null,
      history_state: 'current',
      binding_revoked_at: null,
    }]);
  });

  it('discards only its pending session, binding, and history and remains a terminal tombstone', async () => {
    const fixture = await seedCompletionFixture();
    const survivor = await seedCompletionFixture();
    const completed = await firstService.completeWebEmailSession(
      fixture.input,
      authority,
      'verified_bff',
    );
    const survivingCompletion = await secondService.completeWebEmailSession(
      survivor.input,
      authority,
      'verified_bff',
    );
    const dispositionInput = {
      challengeId: fixture.challengeId,
      deviceId: fixture.deviceId,
      binding: fixture.input.newBinding,
    };

    const discarded = await firstService.discardWebSessionCompletionAttempt(
      fixture.input.attemptId,
      dispositionInput,
      authority,
      'verified_bff',
    );
    expect(discarded).toEqual({
      state: 'discarded',
      sessionId: completed.sessionId,
      bindingId: fixture.input.newBinding.bindingId,
      deviceId: fixture.deviceId,
    });
    await expect(firstService.discardWebSessionCompletionAttempt(
      fixture.input.attemptId,
      dispositionInput,
      authority,
      'verified_bff',
    )).resolves.toEqual(discarded);
    await expect(firstService.acceptWebSessionCompletionAttempt(
      fixture.input.attemptId,
      dispositionInput,
      authority,
      'verified_bff',
    )).rejects.toMatchObject({ code: 'WEB_SESSION_COMPLETION_DISCARDED', status: 409 });
    await expect(firstService.completeWebEmailSession(
      fixture.input,
      authority,
      'verified_bff',
    )).rejects.toMatchObject({ code: 'WEB_SESSION_COMPLETION_DISCARDED', status: 409 });

    const state = await observer.query<{
      session_id: string;
      session_revoked: boolean;
      binding_revoked: boolean;
      history_state: string;
      survivor_revoked: boolean;
      survivor_disposition: string;
    }>(
      `SELECT discarded_session.id AS session_id,
         discarded_session.revoked_at IS NOT NULL AS session_revoked,
         discarded_binding.revoked_at IS NOT NULL AS binding_revoked,
         discarded_history.state AS history_state,
         survivor_session.revoked_at IS NOT NULL AS survivor_revoked,
         survivor_disposition.state AS survivor_disposition
       FROM identity.sessions AS discarded_session
       JOIN identity.device_bindings AS discarded_binding
         ON discarded_binding.id = $2
       JOIN identity.session_refresh_history AS discarded_history
         ON discarded_history.session_id = discarded_session.id
        AND discarded_history.generation = 0
       JOIN identity.sessions AS survivor_session ON survivor_session.id = $3
       JOIN identity.web_session_completion_dispositions AS survivor_disposition
         ON survivor_disposition.session_id = survivor_session.id
       WHERE discarded_session.id = $1`,
      [completed.sessionId, fixture.input.newBinding.bindingId, survivingCompletion.sessionId],
    );
    expect(state.rows).toEqual([{
      session_id: completed.sessionId,
      session_revoked: true,
      binding_revoked: true,
      history_state: 'revoked',
      survivor_revoked: false,
      survivor_disposition: 'pending',
    }]);
  });

  it('records discard-before-complete as a secret-free terminal attempt tombstone', async () => {
    const fixture = await seedCompletionFixture();
    const dispositionInput = {
      challengeId: fixture.challengeId,
      deviceId: fixture.deviceId,
      binding: fixture.input.newBinding,
    };

    const discarded = await firstService.discardWebSessionCompletionAttempt(
      fixture.input.attemptId,
      dispositionInput,
      authority,
      'verified_bff',
    );
    expect(discarded).toEqual({
      state: 'discarded',
      bindingId: fixture.input.newBinding.bindingId,
      deviceId: fixture.deviceId,
    });
    await expect(firstService.completeWebEmailSession(
      fixture.input,
      authority,
      'verified_bff',
    )).rejects.toMatchObject({ code: 'WEB_SESSION_COMPLETION_DISCARDED', status: 409 });
    expect(await mutationCounts(fixture)).toMatchObject({
      verified_at: null,
      sessions: '0',
      bindings: '0',
      outcomes: '0',
    });
  });

  it('reports not-ready for accept-before-complete without recording a tombstone', async () => {
    const fixture = await seedCompletionFixture();
    const dispositionInput = {
      challengeId: fixture.challengeId,
      deviceId: fixture.deviceId,
      binding: fixture.input.newBinding,
    };

    await expect(firstService.acceptWebSessionCompletionAttempt(
      fixture.input.attemptId,
      dispositionInput,
      authority,
      'verified_bff',
    )).rejects.toMatchObject({
      code: 'WEB_SESSION_COMPLETION_NOT_READY',
      status: 409,
    });
    const dispositions = await observer.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM identity.web_session_completion_dispositions
       WHERE attempt_hash = $1`,
      [completionAttemptHash(fixture.input.attemptId)],
    );
    expect(dispositions.rows).toEqual([{ count: '0' }]);
    await expect(firstService.completeWebEmailSession(
      fixture.input,
      authority,
      'verified_bff',
    )).resolves.toMatchObject({ state: 'pending' });
  });

  it('rejects changed disposition authority without changing pending state', async () => {
    const fixture = await seedCompletionFixture();
    await firstService.completeWebEmailSession(fixture.input, authority, 'verified_bff');
    const changed = {
      challengeId: fixture.challengeId,
      deviceId: fixture.deviceId,
      binding: {
        ...fixture.input.newBinding,
        proof: randomBytes(32).toString('base64url'),
      },
    };

    await expect(firstService.acceptWebSessionCompletionAttempt(
      fixture.input.attemptId,
      changed,
      authority,
      'verified_bff',
    )).rejects.toMatchObject({
      code: 'WEB_SESSION_COMPLETION_AUTHORITY_INVALID',
      status: 401,
    });
    const state = await observer.query<{ state: string }>(
      `SELECT state FROM identity.web_session_completion_dispositions
       WHERE attempt_hash = $1`,
      [completionAttemptHash(fixture.input.attemptId)],
    );
    expect(state.rows).toEqual([{ state: 'pending' }]);
  });

  it.each([
    ['restricted user', "status = 'restricted'::identity.user_status"],
    ['login-blocked user', "restriction_flags = ARRAY['loginBlocked']::text[]"],
    ['deleted user', 'deleted_at = clock_timestamp()'],
  ] as const)(
    'revalidates and locks the %s before publishing a pending completion',
    async (_label, mutation) => {
      const fixture = await seedCompletionFixture();
      await firstService.completeWebEmailSession(fixture.input, authority, 'verified_bff');
      await observer.query(`UPDATE identity.users SET ${mutation} WHERE id = $1`, [fixture.userId]);

      await expect(firstService.acceptWebSessionCompletionAttempt(
        fixture.input.attemptId,
        completionDispositionInput(fixture),
        authority,
        'verified_bff',
      )).rejects.toMatchObject({ code: 'AUTH_CHALLENGE_UNAVAILABLE', status: 401 });

      const disposition = await observer.query<{ state: string }>(
        `SELECT state FROM identity.web_session_completion_dispositions
         WHERE attempt_hash = $1`,
        [completionAttemptHash(fixture.input.attemptId)],
      );
      expect(disposition.rows).toEqual([{ state: 'pending' }]);
    },
  );

  it('revalidates and locks the exact device before publishing a pending completion', async () => {
    const fixture = await seedCompletionFixture();
    await firstService.completeWebEmailSession(fixture.input, authority, 'verified_bff');
    await observer.query(
      `UPDATE identity.devices SET risk_state = 'blocked' WHERE id = $1`,
      [fixture.deviceId],
    );

    await expect(firstService.acceptWebSessionCompletionAttempt(
      fixture.input.attemptId,
      completionDispositionInput(fixture),
      authority,
      'verified_bff',
    )).rejects.toMatchObject({ code: 'AUTH_CHALLENGE_UNAVAILABLE', status: 401 });

    const disposition = await observer.query<{ state: string }>(
      `SELECT state FROM identity.web_session_completion_dispositions
       WHERE attempt_hash = $1`,
      [completionAttemptHash(fixture.input.attemptId)],
    );
    expect(disposition.rows).toEqual([{ state: 'pending' }]);
  });

  it('observes a concurrently committed user restriction before acceptance', async () => {
    const fixture = await seedCompletionFixture();
    await firstService.completeWebEmailSession(fixture.input, authority, 'verified_bff');
    await observer.query('BEGIN');
    try {
      await observer.query(
        `UPDATE identity.users SET restriction_flags = ARRAY['loginBlocked']::text[]
         WHERE id = $1`,
        [fixture.userId],
      );
      const accepting = firstService.acceptWebSessionCompletionAttempt(
        fixture.input.attemptId,
        completionDispositionInput(fixture),
        authority,
        'verified_bff',
      );
      await new Promise<void>((resolveTick) => setImmediate(resolveTick));
      await observer.query('COMMIT');
      await expect(accepting).rejects.toMatchObject({
        code: 'AUTH_CHALLENGE_UNAVAILABLE',
        status: 401,
      });
    } catch (error) {
      await observer.query('ROLLBACK');
      throw error;
    }
  });

  it('retains exact v1 revoke authority through the full 31-day capability and session expiry', async () => {
    const fixture = await seedCompletionFixture();
    const { material } = await completeAndAccept(firstService, fixture);
    const retention = await observer.query<{
      retained_seconds: string;
      capability_covered: boolean;
      extends_past_session: boolean;
    }>(
      `SELECT
         EXTRACT(EPOCH FROM (disposition.retained_until - disposition.decision_expires_at))
           ::bigint::text AS retained_seconds,
         disposition.retained_until >= disposition.completed_at + interval '31 days'
           AS capability_covered,
         disposition.retained_until > session.expires_at AS extends_past_session
       FROM identity.web_session_completion_dispositions AS disposition
       JOIN identity.sessions AS session ON session.id = disposition.session_id
       WHERE disposition.attempt_hash = $1`,
      [completionAttemptHash(fixture.input.attemptId)],
    );
    expect(retention.rows).toEqual([{
      retained_seconds: '2678400',
      capability_covered: true,
      extends_past_session: true,
    }]);

    await observer.query(
      `UPDATE identity.sessions SET expires_at = clock_timestamp() - interval '1 second'
       WHERE id = $1`,
      [material.sessionId],
    );
    await expect(firstService.revokeWebSessionCompletionAttempt(
      fixture.input.attemptId,
      completionDispositionInput(fixture),
      authority,
      'verified_bff',
    )).resolves.toMatchObject({ state: 'revoked', sessionId: material.sessionId });
  });

  it('deterministically discards pending revoke and repeats the exact tombstone result', async () => {
    const fixture = await seedCompletionFixture();
    const pending = await firstService.completeWebEmailSession(
      fixture.input,
      authority,
      'verified_bff',
    );
    const expected = {
      state: 'discarded',
      sessionId: pending.sessionId,
      bindingId: pending.bindingId,
      deviceId: pending.deviceId,
    } as const;

    const discarded = await firstService.revokeWebSessionCompletionAttempt(
      fixture.input.attemptId,
      completionDispositionInput(fixture),
      authority,
      'verified_bff',
    );
    expect(discarded).toEqual(expected);
    expect(discarded).not.toHaveProperty('material');
    await expect(firstService.revokeWebSessionCompletionAttempt(
      fixture.input.attemptId,
      completionDispositionInput(fixture),
      authority,
      'verified_bff',
    )).resolves.toEqual(expected);

    const state = await observer.query<{
      dispositions: string;
      disposition_state: string;
      session_revoked: boolean;
      history_state: string;
      binding_revoked: boolean;
    }>(
      `SELECT
         count(*) OVER ()::text AS dispositions,
         disposition.state AS disposition_state,
         session.revoked_at IS NOT NULL AS session_revoked,
         history.state AS history_state,
         binding.revoked_at IS NOT NULL AS binding_revoked
       FROM identity.web_session_completion_dispositions AS disposition
       JOIN identity.sessions AS session ON session.id = disposition.session_id
       JOIN identity.session_refresh_history AS history
         ON history.session_id = session.id AND history.generation = 0
       JOIN identity.device_bindings AS binding ON binding.id = disposition.binding_id
       WHERE disposition.attempt_hash = $1`,
      [completionAttemptHash(fixture.input.attemptId)],
    );
    expect(state.rows).toEqual([{
      dispositions: '1',
      disposition_state: 'discarded',
      session_revoked: true,
      history_state: 'revoked',
      binding_revoked: true,
    }]);
  });

  it('revokes an accepted generation-zero completion without returning session material', async () => {
    const fixture = await seedCompletionFixture();
    const { pending } = await completeAndAccept(firstService, fixture);

    const revoked = await firstService.revokeWebSessionCompletionAttempt(
      fixture.input.attemptId,
      completionDispositionInput(fixture),
      authority,
      'verified_bff',
    );
    expect(revoked).toEqual({
      state: 'revoked',
      sessionId: pending.sessionId,
      bindingId: pending.bindingId,
      deviceId: pending.deviceId,
    });
    expect(revoked).not.toHaveProperty('material');
    await expect(firstService.revokeWebSessionCompletionAttempt(
      fixture.input.attemptId,
      completionDispositionInput(fixture),
      authority,
      'verified_bff',
    )).resolves.toEqual(revoked);

    const state = await observer.query<{
      session_revoked: boolean;
      history_states: string[];
      bindings_revoked: boolean;
    }>(
      `SELECT session.revoked_at IS NOT NULL AS session_revoked,
         ARRAY_AGG(DISTINCT history.state ORDER BY history.state) AS history_states,
         BOOL_AND(binding.revoked_at IS NOT NULL) AS bindings_revoked
       FROM identity.sessions AS session
       JOIN identity.session_refresh_history AS history ON history.session_id = session.id
       JOIN identity.device_bindings AS binding ON binding.session_id = session.id
       WHERE session.id = $1
       GROUP BY session.id`,
      [pending.sessionId],
    );
    expect(state.rows).toEqual([{
      session_revoked: true,
      history_states: ['revoked'],
      bindings_revoked: true,
    }]);
  });

  it('revokes every refresh generation after an accepted session rotates', async () => {
    const fixture = await seedCompletionFixture();
    const { material } = await completeAndAccept(firstService, fixture);
    const rotated = await firstService.refresh(
      material.refreshToken,
      fixture.deviceId,
      'web',
      authority,
      'verified_bff',
      randomUUID(),
      fixture.input.newBinding,
      {
        sessionId: material.sessionId,
        familyId: material.refreshFamilyId,
        generation: 0,
        transportClass: 'web_bff',
        persistentBindingId: material.bindingId,
        persistentBindingGeneration: 0,
      },
    );
    expect(rotated.refreshGeneration).toBe(1);

    await expect(firstService.revokeWebSessionCompletionAttempt(
      fixture.input.attemptId,
      completionDispositionInput(fixture),
      authority,
      'verified_bff',
    )).resolves.toMatchObject({ state: 'revoked', sessionId: material.sessionId });

    const history = await observer.query<{
      generation: string;
      state: string;
      consumed_reason: string | null;
      rotation_key_cleared: boolean;
      successor_cleared: boolean;
      recovery_cleared: boolean;
    }>(
      `SELECT generation, state, consumed_reason,
         rotation_key_hash IS NULL AS rotation_key_cleared,
         successor_hash IS NULL AND successor_generation IS NULL
           AND successor_derivation_kid IS NULL AS successor_cleared,
         recovery_expires_at IS NULL AS recovery_cleared
       FROM identity.session_refresh_history
       WHERE session_id = $1
       ORDER BY generation`,
      [material.sessionId],
    );
    expect(history.rows).toEqual([
      {
        generation: '0',
        state: 'revoked',
        consumed_reason: 'rotated',
        rotation_key_cleared: true,
        successor_cleared: true,
        recovery_cleared: true,
      },
      {
        generation: '1',
        state: 'revoked',
        consumed_reason: 'completion_revoked',
        rotation_key_cleared: true,
        successor_cleared: true,
        recovery_cleared: true,
      },
    ]);
  });

  it('revokes original and upgraded binding authority by immutable completion session id', async () => {
    const fixture = await seedCompletionFixture();
    const { material } = await completeAndAccept(firstService, fixture);
    const rotated = await rotateAcceptedCompletion(
      firstService,
      fixture,
      material,
      material.refreshToken,
      0,
    );
    expect(rotated.refreshGeneration).toBe(1);
    const upgradedBindingId = randomUUID();
    const upgradedBindingHash = randomBytes(32);
    await observer.query(
      `SELECT identity.claim_proof_hash_class($1, 'persistent')`,
      [upgradedBindingHash],
    );
    await observer.query(
      `INSERT INTO identity.device_bindings(
         id, user_id, device_id, session_id, generation, current_hash, current_kid,
         absolute_expires_at, proof_class
       ) VALUES ($1, $2, $3, $4, 1, $5, $6, clock_timestamp() + interval '30 days', 'persistent')`,
      [
        upgradedBindingId,
        fixture.userId,
        fixture.deviceId,
        material.sessionId,
        upgradedBindingHash,
        primaryDerivationKid,
      ],
    );
    await observer.query(
      `UPDATE identity.sessions
       SET current_binding_id = $2, current_binding_generation = 1
       WHERE id = $1`,
      [material.sessionId, upgradedBindingId],
    );
    await observer.query(
      `UPDATE identity.session_refresh_history
       SET binding_id = $2, binding_generation = 1
       WHERE session_id = $1 AND state = 'current'`,
      [material.sessionId, upgradedBindingId],
    );

    await expect(firstService.revokeWebSessionCompletionAttempt(
      fixture.input.attemptId,
      completionDispositionInput(fixture),
      authority,
      'verified_bff',
    )).resolves.toMatchObject({ state: 'revoked', sessionId: material.sessionId });

    const bindings = await observer.query<{ id: string; revoked: boolean }>(
      `SELECT id, revoked_at IS NOT NULL AS revoked
       FROM identity.device_bindings WHERE session_id = $1 ORDER BY id`,
      [material.sessionId],
    );
    expect(bindings.rows).toHaveLength(2);
    expect(bindings.rows.every(({ revoked }) => revoked)).toBe(true);
  });

  it('revokes the immutable completion session after user and device authority become invalid', async () => {
    const fixture = await seedCompletionFixture();
    const { material } = await completeAndAccept(firstService, fixture);
    await observer.query(
      `UPDATE identity.users
       SET status = 'anonymized', deleted_at = clock_timestamp(),
           restriction_flags = ARRAY['loginBlocked']::text[]
       WHERE id = $1`,
      [fixture.userId],
    );
    await observer.query(
      `UPDATE identity.devices SET risk_state = 'blocked' WHERE id = $1`,
      [fixture.deviceId],
    );

    await expect(firstService.revokeWebSessionCompletionAttempt(
      fixture.input.attemptId,
      completionDispositionInput(fixture),
      authority,
      'verified_bff',
    )).resolves.toMatchObject({ state: 'revoked', sessionId: material.sessionId });
  });

  it('fails closed without mutation when retained outcome and session families diverge', async () => {
    const fixture = await seedCompletionFixture();
    const { material } = await completeAndAccept(firstService, fixture);
    await observer.query(
      `WITH removed AS (
         DELETE FROM identity.web_session_completion_outcomes
         WHERE attempt_hash = $1
         RETURNING challenge_id, attempt_hash, request_digest, user_id, device_id,
           session_id, binding_id, refresh_generation, binding_generation,
           derivation_version, derivation_kid, created_at, recovery_expires_at
       )
       INSERT INTO identity.web_session_completion_outcomes(
         challenge_id, attempt_hash, request_digest, user_id, device_id,
         session_id, family_id, binding_id, refresh_generation,
         binding_generation, derivation_version, derivation_kid,
         created_at, recovery_expires_at
       )
       SELECT challenge_id, attempt_hash, request_digest, user_id, device_id,
         session_id, $2, binding_id, refresh_generation, binding_generation,
         derivation_version, derivation_kid, created_at, recovery_expires_at
       FROM removed`,
      [completionAttemptHash(fixture.input.attemptId), randomUUID()],
    );

    await expectRetainedRevokeFailsClosed(fixture, material.sessionId);
  });

  it('fails closed without mutation when one locked history row has a divergent family', async () => {
    const fixture = await seedCompletionFixture();
    const { material } = await completeAndAccept(firstService, fixture);
    await observer.query(
      `UPDATE identity.session_refresh_history
       SET family_id = $2
       WHERE session_id = $1 AND generation = 0`,
      [material.sessionId, randomUUID()],
    );

    await expectRetainedRevokeFailsClosed(fixture, material.sessionId);
  });

  it('fails closed without mutation when the session current generation has no locked history row', async () => {
    const fixture = await seedCompletionFixture();
    const { material } = await completeAndAccept(firstService, fixture);
    const rotated = await firstService.refresh(
      material.refreshToken,
      fixture.deviceId,
      'web',
      authority,
      'verified_bff',
      randomUUID(),
      fixture.input.newBinding,
      {
        sessionId: material.sessionId,
        familyId: material.refreshFamilyId,
        generation: 0,
        transportClass: 'web_bff',
        persistentBindingId: material.bindingId,
        persistentBindingGeneration: 0,
      },
    );
    expect(rotated.refreshGeneration).toBe(1);
    await observer.query(
      `DELETE FROM identity.session_refresh_history
       WHERE session_id = $1 AND generation = 1`,
      [material.sessionId],
    );

    await expectRetainedRevokeFailsClosed(fixture, material.sessionId);
  });

  it('fails closed without mutation when the session current binding has no ordered binding row', async () => {
    const fixture = await seedCompletionFixture();
    const { material } = await completeAndAccept(firstService, fixture);
    const divergentBindingId = randomUUID();
    const divergentBindingHash = randomBytes(32);
    await observer.query(
      `SELECT identity.claim_proof_hash_class($1, 'persistent')`,
      [divergentBindingHash],
    );
    await observer.query(
      `INSERT INTO identity.device_bindings(
         id, user_id, device_id, session_id, generation, current_hash, current_kid,
         absolute_expires_at, proof_class
       ) VALUES ($1, $2, $3, $4, 1, $5, $6,
         clock_timestamp() + interval '30 days', 'persistent')`,
      [divergentBindingId, fixture.userId, fixture.deviceId, material.sessionId,
        divergentBindingHash, primaryDerivationKid],
    );
    await observer.query(
      `UPDATE identity.sessions
       SET current_binding_id = $2, current_binding_generation = 1
       WHERE id = $1`,
      [material.sessionId, divergentBindingId],
    );

    await expectRetainedRevokeFailsClosed(fixture, material.sessionId);
  });

  it('fails closed without mutation when generation-zero history points at the wrong locked binding', async () => {
    const fixture = await seedCompletionFixture();
    const { material } = await completeAndAccept(firstService, fixture);
    const wrongBindingId = await insertPersistentBinding(fixture, material.sessionId, 0);
    await observer.query(
      `UPDATE identity.sessions
       SET current_binding_id = $2, current_binding_generation = 0
       WHERE id = $1`,
      [material.sessionId, wrongBindingId],
    );
    await observer.query(
      `UPDATE identity.session_refresh_history
       SET binding_id = $2, binding_generation = 0
       WHERE session_id = $1 AND generation = 0`,
      [material.sessionId, wrongBindingId],
    );

    await expectRetainedRevokeFailsClosed(fixture, material.sessionId);
  });

  it('fails closed without mutation when generation-zero history points at a dangling binding', async () => {
    const fixture = await seedCompletionFixture();
    const { material } = await completeAndAccept(firstService, fixture);
    const rotated = await rotateAcceptedCompletion(
      firstService,
      fixture,
      material,
      material.refreshToken,
      0,
    );
    expect(rotated.refreshGeneration).toBe(1);
    await observer.query(
      `UPDATE identity.session_refresh_history
       SET binding_id = $2
       WHERE session_id = $1 AND generation = 0`,
      [material.sessionId, randomUUID()],
    );

    await expectRetainedRevokeFailsClosed(fixture, material.sessionId);
  });

  it('fails closed without mutation when intermediate history has the wrong locked binding generation', async () => {
    const fixture = await seedCompletionFixture();
    const { material } = await completeAndAccept(firstService, fixture);
    const firstRotation = await rotateAcceptedCompletion(
      firstService,
      fixture,
      material,
      material.refreshToken,
      0,
    );
    const secondRotation = await rotateAcceptedCompletion(
      firstService,
      fixture,
      material,
      firstRotation.refreshToken,
      1,
    );
    expect(secondRotation.refreshGeneration).toBe(2);
    await observer.query(
      `UPDATE identity.session_refresh_history
       SET binding_generation = 1
       WHERE session_id = $1 AND generation = 1`,
      [material.sessionId],
    );

    await expectRetainedRevokeFailsClosed(fixture, material.sessionId);
  });

  it('fails closed without mutation when intermediate history points at a dangling binding', async () => {
    const fixture = await seedCompletionFixture();
    const { material } = await completeAndAccept(firstService, fixture);
    const firstRotation = await rotateAcceptedCompletion(
      firstService,
      fixture,
      material,
      material.refreshToken,
      0,
    );
    const secondRotation = await rotateAcceptedCompletion(
      firstService,
      fixture,
      material,
      firstRotation.refreshToken,
      1,
    );
    expect(secondRotation.refreshGeneration).toBe(2);
    await observer.query(
      `UPDATE identity.session_refresh_history
       SET binding_id = $2
       WHERE session_id = $1 AND generation = 1`,
      [material.sessionId, randomUUID()],
    );

    await expectRetainedRevokeFailsClosed(fixture, material.sessionId);
  });

  it('fails closed for missing, changed, or retention-expired revoke authority', async () => {
    const missing = await seedCompletionFixture();
    await expect(firstService.revokeWebSessionCompletionAttempt(
      missing.input.attemptId,
      completionDispositionInput(missing),
      authority,
      'verified_bff',
    )).rejects.toMatchObject({
      code: 'WEB_SESSION_COMPLETION_AUTHORITY_INVALID',
      status: 401,
    });

    const changed = await seedCompletionFixture();
    const changedPending = await firstService.completeWebEmailSession(
      changed.input,
      authority,
      'verified_bff',
    );
    await expect(firstService.revokeWebSessionCompletionAttempt(
      changed.input.attemptId,
      {
        ...completionDispositionInput(changed),
        binding: { ...changed.input.newBinding, proof: randomBytes(32).toString('base64url') },
      },
      authority,
      'verified_bff',
    )).rejects.toMatchObject({
      code: 'WEB_SESSION_COMPLETION_AUTHORITY_INVALID',
      status: 401,
    });
    const changedState = await observer.query<{ revoked: boolean }>(
      `SELECT revoked_at IS NOT NULL AS revoked FROM identity.sessions WHERE id = $1`,
      [changedPending.sessionId],
    );
    expect(changedState.rows).toEqual([{ revoked: false }]);

    const expired = await seedCompletionFixture();
    await completeAndAccept(firstService, expired);
    await observer.query(
      `WITH removed AS (
         DELETE FROM identity.web_session_completion_dispositions
         WHERE attempt_hash = $1
         RETURNING attempt_hash, challenge_id, device_id, binding_id,
           binding_generation, authority_digest, authority_version, authority_kid,
           state, session_id
       )
       INSERT INTO identity.web_session_completion_dispositions(
         attempt_hash, challenge_id, device_id, binding_id, binding_generation,
         authority_digest, authority_version, authority_kid, state, session_id,
         created_at, completed_at, decision_expires_at, retained_until,
         accepted_at, discarded_at
       )
       SELECT attempt_hash, challenge_id, device_id, binding_id, binding_generation,
         authority_digest, authority_version, authority_kid, state, session_id,
         clock_timestamp() - interval '31 days',
         clock_timestamp() - interval '31 days',
         clock_timestamp() - interval '30 days 23 hours',
         clock_timestamp() - interval '1 second',
         clock_timestamp() - interval '31 days', NULL
       FROM removed`,
      [completionAttemptHash(expired.input.attemptId)],
    );
    await expect(firstService.revokeWebSessionCompletionAttempt(
      expired.input.attemptId,
      completionDispositionInput(expired),
      authority,
      'verified_bff',
    )).rejects.toMatchObject({
      code: 'WEB_SESSION_COMPLETION_AUTHORITY_INVALID',
      status: 401,
    });
  });

  it.each([
    ['legacy-v0 authority', 'legacy-v0', 'legacy-retained'],
    ['unknown v1 KID', 'v1', 'unknown-retained-kid'],
  ] as const)('fails closed without mutation for %s', async (_label, authorityVersion, authorityKid) => {
    const fixture = await seedCompletionFixture();
    const { material } = await completeAndAccept(firstService, fixture);
    await observer.query(
      `WITH removed AS (
         DELETE FROM identity.web_session_completion_dispositions
         WHERE attempt_hash = $1
         RETURNING attempt_hash, challenge_id, device_id, binding_id,
           binding_generation, state, session_id, created_at, completed_at,
           decision_expires_at, retained_until, accepted_at, discarded_at
       )
       INSERT INTO identity.web_session_completion_dispositions(
         attempt_hash, challenge_id, device_id, binding_id, binding_generation,
         authority_digest, authority_version, authority_kid, state, session_id,
         created_at, completed_at, decision_expires_at, retained_until,
         accepted_at, discarded_at
       )
       SELECT attempt_hash, challenge_id, device_id, binding_id, binding_generation,
         $2, $3, $4, state, session_id, created_at, completed_at,
         decision_expires_at, retained_until, accepted_at, discarded_at
       FROM removed`,
      [completionAttemptHash(fixture.input.attemptId), Buffer.alloc(32, 19), authorityVersion, authorityKid],
    );

    await expect(firstService.revokeWebSessionCompletionAttempt(
      fixture.input.attemptId,
      completionDispositionInput(fixture),
      authority,
      'verified_bff',
    )).rejects.toMatchObject({
      code: 'WEB_SESSION_COMPLETION_AUTHORITY_INVALID',
      status: 401,
    });
    const state = await observer.query<{ revoked: boolean; current_histories: string }>(
      `SELECT session.revoked_at IS NOT NULL AS revoked,
         count(*) FILTER (WHERE history.state = 'current')::text AS current_histories
       FROM identity.sessions AS session
       JOIN identity.session_refresh_history AS history ON history.session_id = session.id
       WHERE session.id = $1
       GROUP BY session.id`,
      [material.sessionId],
    );
    expect(state.rows).toEqual([{ revoked: false, current_histories: '1' }]);
  });

  it('does not let a later accept resurrect or return material after revoke', async () => {
    const fixture = await seedCompletionFixture();
    const { material } = await completeAndAccept(firstService, fixture);
    await firstService.revokeWebSessionCompletionAttempt(
      fixture.input.attemptId,
      completionDispositionInput(fixture),
      authority,
      'verified_bff',
    );

    await expect(firstService.acceptWebSessionCompletionAttempt(
      fixture.input.attemptId,
      completionDispositionInput(fixture),
      authority,
      'verified_bff',
    )).rejects.toMatchObject({ code: 'AUTH_CHALLENGE_UNAVAILABLE', status: 401 });
    const state = await observer.query<{ disposition_state: string; session_revoked: boolean }>(
      `SELECT disposition.state AS disposition_state,
         session.revoked_at IS NOT NULL AS session_revoked
       FROM identity.web_session_completion_dispositions AS disposition
       JOIN identity.sessions AS session ON session.id = disposition.session_id
       WHERE disposition.attempt_hash = $1`,
      [completionAttemptHash(fixture.input.attemptId)],
    );
    expect(state.rows).toEqual([{ disposition_state: 'accepted', session_revoked: true }]);
    expect(material.refreshToken).toBeTypeOf('string');
  });

  it('serializes refresh and revoke without leaving a current refresh generation', async () => {
    const fixture = await seedCompletionFixture();
    const { material } = await completeAndAccept(firstService, fixture);
    const envelope = {
      sessionId: material.sessionId,
      familyId: material.refreshFamilyId,
      generation: 0,
      transportClass: 'web_bff' as const,
      persistentBindingId: material.bindingId,
      persistentBindingGeneration: 0,
    };

    const [refresh, revoke] = await Promise.allSettled([
      firstService.refresh(
        material.refreshToken,
        fixture.deviceId,
        'web',
        authority,
        'verified_bff',
        randomUUID(),
        fixture.input.newBinding,
        envelope,
      ),
      secondService.revokeWebSessionCompletionAttempt(
        fixture.input.attemptId,
        completionDispositionInput(fixture),
        authority,
        'verified_bff',
      ),
    ]);
    expect(revoke.status).toBe('fulfilled');
    if (revoke.status === 'fulfilled') expect(revoke.value.state).toBe('revoked');
    if (refresh.status === 'rejected') {
      expect(refresh.reason).toMatchObject({ code: 'TOKEN_EXPIRED', status: 401 });
    }

    const state = await observer.query<{
      session_revoked: boolean;
      current_histories: string;
      non_revoked_histories: string;
    }>(
      `SELECT session.revoked_at IS NOT NULL AS session_revoked,
         count(*) FILTER (WHERE history.state = 'current')::text AS current_histories,
         count(*) FILTER (WHERE history.state <> 'revoked')::text AS non_revoked_histories
       FROM identity.sessions AS session
       JOIN identity.session_refresh_history AS history ON history.session_id = session.id
       WHERE session.id = $1
       GROUP BY session.id`,
      [material.sessionId],
    );
    expect(state.rows).toEqual([{
      session_revoked: true,
      current_histories: '0',
      non_revoked_histories: '0',
    }]);
  });

  it('serializes accept and revoke into one terminal non-resurrectable outcome', async () => {
    const fixture = await seedCompletionFixture();
    const pending = await firstService.completeWebEmailSession(
      fixture.input,
      authority,
      'verified_bff',
    );
    const [accept, revoke] = await Promise.allSettled([
      firstService.acceptWebSessionCompletionAttempt(
        fixture.input.attemptId,
        completionDispositionInput(fixture),
        authority,
        'verified_bff',
      ),
      secondService.revokeWebSessionCompletionAttempt(
        fixture.input.attemptId,
        completionDispositionInput(fixture),
        authority,
        'verified_bff',
      ),
    ]);
    expect(revoke.status).toBe('fulfilled');
    if (revoke.status === 'fulfilled') {
      expect(['discarded', 'revoked']).toContain(revoke.value.state);
      expect(revoke.value).not.toHaveProperty('material');
    }
    if (accept.status === 'rejected') {
      expect(accept.reason).toMatchObject({ code: 'WEB_SESSION_COMPLETION_DISCARDED' });
    }

    const state = await observer.query<{
      session_revoked: boolean;
      current_history: string;
      binding_revoked: boolean;
    }>(
      `SELECT session.revoked_at IS NOT NULL AS session_revoked,
         history.state AS current_history,
         binding.revoked_at IS NOT NULL AS binding_revoked
       FROM identity.sessions AS session
       JOIN identity.session_refresh_history AS history
         ON history.session_id = session.id AND history.generation = 0
       JOIN identity.device_bindings AS binding ON binding.id = $2
       WHERE session.id = $1`,
      [pending.sessionId, pending.bindingId],
    );
    expect(state.rows).toEqual([{
      session_revoked: true,
      current_history: 'revoked',
      binding_revoked: true,
    }]);
  });
});
