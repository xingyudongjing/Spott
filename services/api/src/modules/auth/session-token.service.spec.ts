import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client, type PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { SessionTransportClass } from '../../platform/web-bff-authority.js';
import {
  deriveSuccessorSecret,
  parseRefreshToken,
  SessionTokenService,
  type DeviceBindingProof,
  type RefreshMutationInput,
  type RefreshMutationOutcome,
} from './session-token.service.js';

const refreshHmacKey = 'task4-refresh-token-secret-at-least-32-bytes';
const derivationKeyBytes = Buffer.from('fedcba9876543210fedcba9876543210');
const bffKeyBytes = Buffer.from('0123456789abcdef0123456789abcdef');
const derivationKid = 'refresh-2026-07';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://127.0.0.1:55432/spott_task4_unit_test',
  ACCESS_TOKEN_SECRET: 'task4-access-token-secret-at-least-32-bytes',
  REFRESH_TOKEN_SECRET: refreshHmacKey,
  FIELD_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 4).toString('base64'),
  LOOKUP_HMAC_PEPPER: 'task4-lookup-pepper-at-least-16-bytes',
  SPOTT_WEB_BFF_KEYS: `bff-2026-07:${bffKeyBytes.toString('base64url')}`,
  SPOTT_WEB_BFF_CURRENT_KID: 'bff-2026-07',
  REFRESH_TOKEN_DERIVATION_KEYS: `${derivationKid}:${derivationKeyBytes.toString('base64url')}`,
  REFRESH_TOKEN_DERIVATION_CURRENT_KID: derivationKid,
  WEB_SESSION_BFF_ENFORCEMENT: 'off',
  WEB_SESSION_RECOVERY_SECONDS: '120',
  SPOTT_WEB_CANONICAL_ORIGIN: 'https://spott.jp',
});

const sessionId = '019b0000-0000-7000-8000-000000000001';
const familyId = '019b0000-0000-7000-8000-000000000002';
const bindingId = '019b0000-0000-7000-8000-000000000003';
const userId = '019b0000-0000-7000-8000-000000000004';
const deviceId = '019b0000-0000-7000-8000-000000000005';
const otherDeviceId = '019b0000-0000-7000-8000-000000000006';
const attemptA = '019b0000-0000-7000-8000-000000000010';
const attemptB = '019b0000-0000-7000-8000-000000000011';
const initialSecret = Buffer.alloc(32, 7).toString('base64url');
const bindingSecret = Buffer.alloc(32, 8).toString('base64url');

interface MemorySession {
  id: string;
  userId: string;
  deviceId: string;
  refreshHash: Buffer;
  familyId: string;
  generation: number;
  derivationKid: string | null;
  bindingId: string | null;
  bindingGeneration: number | null;
  expiresAt: Date;
  revokedAt: Date | null;
  reuseDetectedAt: Date | null;
  transportClass: SessionTransportClass;
}

interface MemoryHistory {
  sessionId: string;
  familyId: string;
  generation: number;
  tokenHash: Buffer;
  derivationKid: string | null;
  transportClass: SessionTransportClass;
  bindingId: string | null;
  bindingGeneration: number | null;
  state: 'current' | 'consumed' | 'revoked';
  consumedAt: Date | null;
  rotationKeyHash: Buffer | null;
  successorGeneration: number | null;
  successorHash: Buffer | null;
  successorDerivationKid: string | null;
  recoveryExpiresAt: Date | null;
}

interface MemoryBinding {
  id: string;
  userId: string;
  deviceId: string;
  sessionId: string;
  generation: number;
  currentHash: Buffer;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
  proofClass: 'persistent';
}

function refreshHash(secret: string): Buffer {
  return createHmac('sha256', refreshHmacKey).update(secret).digest();
}

function bindingHash(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

function bufferEqual(left: unknown, right: Buffer): boolean {
  return Buffer.isBuffer(left) && left.byteLength === right.byteLength && left.equals(right);
}

class MemoryPoolClient {
  readonly queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  readonly histories = new Map<number, MemoryHistory>();
  readonly binding: MemoryBinding;
  session: MemorySession;
  now = new Date('2026-07-17T00:00:00.000Z');

  constructor(options: {
    tokenVersion?: 'legacy' | 's2';
    transportClass?: SessionTransportClass;
  } = {}) {
    const tokenVersion = options.tokenVersion ?? 's2';
    const transportClass = options.transportClass ?? 'native';
    this.session = {
      id: sessionId,
      userId,
      deviceId,
      refreshHash: refreshHash(initialSecret),
      familyId,
      generation: 0,
      derivationKid: tokenVersion === 'legacy' ? null : derivationKid,
      bindingId,
      bindingGeneration: 3,
      expiresAt: new Date('2026-07-18T00:00:00.000Z'),
      revokedAt: null,
      reuseDetectedAt: null,
      transportClass,
    };
    this.histories.set(0, {
      sessionId,
      familyId,
      generation: 0,
      tokenHash: Buffer.from(this.session.refreshHash),
      derivationKid: this.session.derivationKid,
      transportClass,
      bindingId,
      bindingGeneration: 3,
      state: 'current',
      consumedAt: null,
      rotationKeyHash: null,
      successorGeneration: null,
      successorHash: null,
      successorDerivationKid: null,
      recoveryExpiresAt: null,
    });
    this.binding = {
      id: bindingId,
      userId,
      deviceId,
      sessionId,
      generation: 3,
      currentHash: bindingHash(bindingSecret),
      absoluteExpiresAt: new Date('2026-07-18T00:00:00.000Z'),
      revokedAt: null,
      proofClass: 'persistent',
    };
  }

  token(version: 'legacy' | 's2' = 's2', secret = initialSecret, generation = 0): string {
    return version === 'legacy'
      ? `${sessionId}.${secret}`
      : `s2.${sessionId}.${generation}.${secret}`;
  }

  proof(secret = bindingSecret): DeviceBindingProof {
    return { bindingId, generation: 3, proof: secret };
  }

  input(overrides: Partial<RefreshMutationInput> = {}): RefreshMutationInput {
    return {
      refreshToken: this.token(),
      deviceId,
      attemptKey: attemptA,
      deviceBindingProof: this.proof(),
      ...overrides,
    };
  }

  async query(sql: string, values: readonly unknown[] = []): Promise<unknown> {
    this.queries.push({ sql, values });

    if (sql.includes('FROM identity.sessions AS session')) {
      if (values[0] !== this.session.id) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          id: this.session.id,
          user_id: this.session.userId,
          device_id: this.session.deviceId,
          refresh_hash: Buffer.from(this.session.refreshHash),
          refresh_family_id: this.session.familyId,
          refresh_generation: String(this.session.generation),
          current_derivation_kid: this.session.derivationKid,
          current_binding_id: this.session.bindingId,
          current_binding_generation: this.session.bindingGeneration === null
            ? null
            : String(this.session.bindingGeneration),
          expires_at: this.session.expiresAt,
          session_unexpired: this.session.expiresAt > this.now,
          revoked_at: this.session.revokedAt,
          reuse_detected_at: this.session.reuseDetectedAt,
          transport_class: this.session.transportClass,
          public_handle: 'spott_task4',
          status: 'active',
          phone_verified_at: null,
          restriction_flags: [],
        }],
        rowCount: 1,
      };
    }

    if (sql.includes('FROM identity.session_refresh_history')) {
      if (sql.includes('token_hash = $2')) {
        const candidate = values[1];
        const row = [...this.histories.values()].find((history) => (
          history.sessionId === values[0] && bufferEqual(candidate, history.tokenHash)
        ));
        return { rows: row ? [this.historyRow(row)] : [], rowCount: row ? 1 : 0 };
      }
      const generation = Number(values[1]);
      const row = this.histories.get(generation);
      return { rows: row ? [this.historyRow(row)] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes('FROM identity.device_bindings')) {
      const [candidateId, candidateUserId, candidateDeviceId, candidateSessionId, generation] = values;
      const valid = candidateId === this.binding.id
        && candidateUserId === this.binding.userId
        && candidateDeviceId === this.binding.deviceId
        && candidateSessionId === this.binding.sessionId
        && Number(generation) === this.binding.generation
        && this.binding.proofClass === 'persistent'
        && this.binding.revokedAt === null
        && this.binding.absoluteExpiresAt > this.now;
      return {
        rows: valid ? [{
          id: this.binding.id,
          generation: String(this.binding.generation),
          current_hash: Buffer.from(this.binding.currentHash),
        }] : [],
        rowCount: valid ? 1 : 0,
      };
    }

    if (sql.startsWith('UPDATE identity.sessions') && sql.includes('refresh_family_id = $1')) {
      if (values[0] !== this.session.familyId || this.session.revokedAt !== null) {
        return { rows: [], rowCount: 0 };
      }
      this.session.reuseDetectedAt = new Date(this.now);
      this.session.revokedAt = new Date(this.now);
      return { rows: [{ id: this.session.id }], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE identity.sessions')) {
      const [candidateSessionId, predecessorGeneration, predecessorHash, successorGeneration,
        successorHash, successorKid, successorBindingId, successorBindingGeneration] = values;
      const valid = candidateSessionId === this.session.id
        && Number(predecessorGeneration) === this.session.generation
        && bufferEqual(predecessorHash, this.session.refreshHash);
      if (!valid || !Buffer.isBuffer(successorHash)) return { rows: [], rowCount: 0 };
      this.session.refreshHash = Buffer.from(successorHash);
      this.session.generation = Number(successorGeneration);
      this.session.derivationKid = typeof successorKid === 'string' ? successorKid : null;
      if (typeof successorBindingId === 'string') this.session.bindingId = successorBindingId;
      if (successorBindingGeneration !== null && successorBindingGeneration !== undefined) {
        this.session.bindingGeneration = Number(successorBindingGeneration);
      }
      return { rows: [{ id: this.session.id }], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE identity.session_refresh_history')) {
      const history = this.histories.get(Number(values[1]));
      if (!history || history.sessionId !== values[0] || history.state !== 'current') {
        return { rows: [], rowCount: 0 };
      }
      history.state = 'consumed';
      history.consumedAt = new Date(this.now);
      if (values.length > 2) {
        history.rotationKeyHash = Buffer.isBuffer(values[2]) ? Buffer.from(values[2]) : null;
        history.successorGeneration = Number(values[3]);
        history.successorHash = Buffer.isBuffer(values[4]) ? Buffer.from(values[4]) : null;
        history.successorDerivationKid = typeof values[5] === 'string' ? values[5] : null;
        history.bindingId = typeof values[6] === 'string' ? values[6] : null;
        history.bindingGeneration = values[7] === null ? null : Number(values[7]);
        history.recoveryExpiresAt = new Date(this.now.getTime() + Number(values[8]) * 1_000);
      }
      return { rows: [{ generation: String(history.generation) }], rowCount: 1 };
    }

    if (sql.startsWith('INSERT INTO identity.session_refresh_history')) {
      const [candidateSessionId, candidateFamilyId, generation, tokenHash, kid, transportClass,
        successorBindingId, successorBindingGeneration] = values;
      const numericGeneration = Number(generation);
      if (this.histories.has(numericGeneration) || !Buffer.isBuffer(tokenHash)) {
        throw Object.assign(new Error('duplicate session generation'), { code: '23505' });
      }
      this.histories.set(numericGeneration, {
        sessionId: String(candidateSessionId),
        familyId: String(candidateFamilyId),
        generation: numericGeneration,
        tokenHash: Buffer.from(tokenHash),
        derivationKid: typeof kid === 'string' ? kid : null,
        transportClass: transportClass as SessionTransportClass,
        bindingId: typeof successorBindingId === 'string' ? successorBindingId : null,
        bindingGeneration: successorBindingGeneration === null ? null : Number(successorBindingGeneration),
        state: 'current',
        consumedAt: null,
        rotationKeyHash: null,
        successorGeneration: null,
        successorHash: null,
        successorDerivationKid: null,
        recoveryExpiresAt: null,
      });
      return { rows: [{ generation: String(numericGeneration) }], rowCount: 1 };
    }

    if (sql.includes('FROM admin.admin_users')) return { rows: [], rowCount: 0 };
    throw new Error(`Unexpected Task 4 query: ${sql}`);
  }

  private historyRow(history: MemoryHistory): Record<string, unknown> {
    return {
      session_id: history.sessionId,
      family_id: history.familyId,
      generation: String(history.generation),
      token_hash: Buffer.from(history.tokenHash),
      derivation_kid: history.derivationKid,
      transport_class: history.transportClass,
      binding_id: history.bindingId,
      binding_generation: history.bindingGeneration === null ? null : String(history.bindingGeneration),
      state: history.state,
      consumed_at: history.consumedAt,
      rotation_key_hash: history.rotationKeyHash && Buffer.from(history.rotationKeyHash),
      successor_generation: history.successorGeneration === null ? null : String(history.successorGeneration),
      successor_hash: history.successorHash && Buffer.from(history.successorHash),
      successor_derivation_kid: history.successorDerivationKid,
      recovery_expires_at: history.recoveryExpiresAt,
      recovery_open: history.recoveryExpiresAt !== null && history.recoveryExpiresAt > this.now,
    };
  }
}

function serviceHarness(options: ConstructorParameters<typeof MemoryPoolClient>[0] = {}) {
  const memory = new MemoryPoolClient(options);
  const service = new SessionTokenService();
  return {
    memory,
    service,
    rotate: (input = memory.input(), transport = memory.session.transportClass) => (
      service.rotate(memory as unknown as PoolClient, input, transport)
    ),
  };
}

function expectNoSuccessor(outcome: RefreshMutationOutcome): void {
  expect(outcome.kind).not.toBe('rotated');
  expect(outcome.kind).not.toBe('recovered');
  expect('session' in outcome).toBe(false);
  expect(JSON.stringify(outcome).toLowerCase()).not.toContain('refreshtoken');
}

describe('refresh successor KDF', () => {
  const vector = {
    key: derivationKeyBytes,
    version: 'v2',
    kid: derivationKid,
    sessionId,
    familyId,
    predecessorGeneration: 7,
    predecessorHash: Buffer.from('aa'.repeat(32), 'hex'),
    successorGeneration: 8,
    attemptHash: Buffer.from('bb'.repeat(32), 'hex'),
    bindingId,
    bindingGeneration: 3,
  } as const;

  it('matches the committed refresh-successor vector', () => {
    expect(deriveSuccessorSecret(vector)).toBe('8h-1D-MFacGW9Sf_VAc_v_Q1we62FQ9eVFloO8HomJc');
  });

  it.each([
    ['version', { version: 'v3' }],
    ['KID', { kid: 'refresh-2026-08' }],
    ['predecessor generation', { predecessorGeneration: 6 }],
    ['successor generation', { successorGeneration: 9 }],
    ['predecessor hash', { predecessorHash: Buffer.from('ab'.repeat(32), 'hex') }],
    ['attempt hash', { attemptHash: Buffer.from('bc'.repeat(32), 'hex') }],
    ['binding ID', { bindingId: '019b0000-0000-7000-8000-000000000099' }],
    ['binding generation', { bindingGeneration: 4 }],
  ] as const)('authenticates the %s field', (_label, mutation) => {
    expect(deriveSuccessorSecret({ ...vector, ...mutation })).not.toBe(
      deriveSuccessorSecret(vector),
    );
  });
});

describe('strict refresh token grammar', () => {
  it('accepts only canonical legacy and s2 tokens', () => {
    expect(parseRefreshToken(`${sessionId}.${initialSecret}`)).toEqual({
      version: 'legacy', sessionId, secret: initialSecret,
    });
    expect(parseRefreshToken(`s2.${sessionId}.0.${initialSecret}`)).toEqual({
      version: 's2', sessionId, generation: 0, secret: initialSecret,
    });
  });

  it.each([
    undefined,
    null,
    '',
    `${sessionId}.${initialSecret}.extra`,
    `s2.${sessionId}.${initialSecret}`,
    `S2.${sessionId}.0.${initialSecret}`,
    `s2.${sessionId}.00.${initialSecret}`,
    `s2.${sessionId}.-1.${initialSecret}`,
    `s2.${sessionId}.9007199254740992.${initialSecret}`,
    `s2.${sessionId.toUpperCase()}.0.${initialSecret}`,
    `${sessionId}.${initialSecret}=`,
    `${sessionId}.${initialSecret.slice(1)}`,
    `${sessionId}.${'a'.repeat(44)}`,
    `${sessionId}.${'a'.repeat(1_024)}`,
  ])('rejects malformed and noncanonical s2 tokens: %j', (token) => {
    expect(parseRefreshToken(token)).toBeNull();
  });

  it('rejects malformed material before any database access', async () => {
    const client = { query: vi.fn() };
    const service = new SessionTokenService();
    await expect(service.rotate(client as unknown as PoolClient, {
      refreshToken: `${sessionId}.${'a'.repeat(1_024)}`,
      deviceId,
    }, 'native')).resolves.toEqual({ kind: 'invalid' });
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe('SessionTokenService stable rotation and exact recovery', () => {
  it('rotates hash while preserving session id and family id', async () => {
    const { memory, rotate } = serviceHarness();
    const before = { id: memory.session.id, familyId: memory.session.familyId };

    const outcome = await rotate();

    expect(outcome).toMatchObject({ kind: 'rotated', session: { sessionId, refreshGeneration: 1 } });
    expect({ id: memory.session.id, familyId: memory.session.familyId }).toEqual(before);
    expect(memory.session.refreshHash).not.toEqual(refreshHash(initialSecret));
  });

  it('increments exactly one generation', async () => {
    const { memory, rotate } = serviceHarness();
    await rotate();
    expect(memory.session.generation).toBe(1);
    expect([...memory.histories.keys()].toSorted()).toEqual([0, 1]);
    expect([...memory.histories.values()].filter(({ state }) => state === 'current')).toHaveLength(1);
  });

  it('returns the exact successor for the same consumed token and rotation key', async () => {
    const { memory, rotate } = serviceHarness();
    const input = memory.input();
    const first = await rotate(input);
    const retry = await rotate(input);

    expect(first.kind).toBe('rotated');
    expect(retry.kind).toBe('recovered');
    if (first.kind !== 'rotated' || retry.kind !== 'recovered') throw new Error('expected sessions');
    expect(retry.session.refreshToken).toBe(first.session.refreshToken);
    expect(retry.session.sessionId).toBe(first.session.sessionId);
    expect(retry.session.refreshGeneration).toBe(1);
    expect(memory.histories).toHaveLength(2);
  });

  it('requires the same independent attempt plus valid device-binding proof', async () => {
    const firstHarness = serviceHarness();
    const original = firstHarness.memory.input();
    await firstHarness.rotate(original);
    const differentAttempt = await firstHarness.rotate({ ...original, attemptKey: attemptB });
    expect(differentAttempt).toMatchObject({ kind: 'reused', sessionId, familyId });
    expect(firstHarness.memory.session.revokedAt).toEqual(firstHarness.memory.now);
    expect(firstHarness.memory.session.reuseDetectedAt).toEqual(firstHarness.memory.now);
    expect(firstHarness.memory.queries.some(({ sql }) => (
      sql.includes('refresh_family_id = $1') && sql.includes('reuse_detected_at')
    ))).toBe(true);

    const secondHarness = serviceHarness();
    const secondOriginal = secondHarness.memory.input();
    await secondHarness.rotate(secondOriginal);
    const wrongProof = await secondHarness.rotate({
      ...secondOriginal,
      deviceBindingProof: secondHarness.memory.proof(Buffer.alloc(32, 9).toString('base64url')),
    });
    expectNoSuccessor(wrongProof);
  });

  it('never returns a successor without caller attempt or binding proof', async () => {
    const { memory, rotate } = serviceHarness();
    const original = memory.input();
    await rotate(original);

    expectNoSuccessor(await rotate({ ...original, attemptKey: undefined }));
    expectNoSuccessor(await rotate({ ...original, deviceBindingProof: undefined }));
  });

  it('legacy consumed predecessors require reauthentication', async () => {
    const { memory, rotate } = serviceHarness({ tokenVersion: 'legacy' });
    const legacy = memory.input({
      refreshToken: memory.token('legacy'),
      attemptKey: undefined,
      deviceBindingProof: undefined,
    });
    const first = await rotate(legacy);
    expect(first.kind).toBe('rotated');

    const retry = await rotate({ ...legacy, attemptKey: attemptA, deviceBindingProof: memory.proof() });
    expect(retry).toEqual({ kind: 'reauth_required' });
    expectNoSuccessor(retry);
  });

  it('does not relabel a legacy generation-zero credential as recoverable s2 material', async () => {
    const { memory, rotate } = serviceHarness({ tokenVersion: 'legacy' });
    const alias = memory.input({ refreshToken: memory.token('s2', initialSecret, 0) });

    const outcome = await rotate(alias);

    expect(outcome).toEqual({ kind: 'invalid' });
    expect(memory.session.generation).toBe(0);
    expect(memory.histories).toHaveLength(1);
    expectNoSuccessor(outcome);
  });

  it('never derives attempt material from token hash device UUID or transport', async () => {
    const left = serviceHarness({ tokenVersion: 'legacy' });
    const right = serviceHarness({ tokenVersion: 'legacy' });
    const leftOutcome = await left.rotate(left.memory.input({
      refreshToken: left.memory.token('legacy'),
      attemptKey: undefined,
    }));
    const rightOutcome = await right.rotate(right.memory.input({
      refreshToken: right.memory.token('legacy'),
      attemptKey: undefined,
    }));
    expect(leftOutcome.kind).toBe('rotated');
    expect(rightOutcome.kind).toBe('rotated');
    if (leftOutcome.kind !== 'rotated' || rightOutcome.kind !== 'rotated') throw new Error('expected rotation');
    expect(leftOutcome.session.refreshToken).not.toBe(rightOutcome.session.refreshToken);
    for (const harness of [left, right]) {
      const predecessor = harness.memory.histories.get(0);
      expect(predecessor).toMatchObject({
        rotationKeyHash: null,
        successorGeneration: null,
        successorHash: null,
        successorDerivationKid: null,
        recoveryExpiresAt: null,
      });
    }
  });

  it('does not recover after the direct successor was superseded', async () => {
    const { memory, rotate } = serviceHarness();
    const predecessor = memory.input();
    const first = await rotate(predecessor);
    if (first.kind !== 'rotated') throw new Error('expected first rotation');
    await rotate({
      refreshToken: first.session.refreshToken,
      deviceId,
      attemptKey: attemptB,
      deviceBindingProof: memory.proof(),
    });

    const lateRetry = await rotate(predecessor);
    expect(lateRetry).toEqual({ kind: 'reauth_required' });
    expectNoSuccessor(lateRetry);
  });

  it('does not recover when the recorded successor skips a generation', async () => {
    const { memory, rotate } = serviceHarness();
    const predecessorInput = memory.input();
    const first = await rotate(predecessorInput);
    if (first.kind !== 'rotated') throw new Error('expected first rotation');
    const predecessor = memory.histories.get(0);
    const directSuccessor = memory.histories.get(1);
    if (!predecessor || !directSuccessor) throw new Error('missing refresh history');

    const skippedSuccessorSecret = deriveSuccessorSecret({
      key: derivationKeyBytes,
      version: 'v2',
      kid: derivationKid,
      sessionId,
      familyId,
      predecessorGeneration: 0,
      predecessorHash: refreshHash(initialSecret),
      successorGeneration: 2,
      attemptHash: createHash('sha256').update(attemptA).digest(),
      bindingId,
      bindingGeneration: 3,
    });
    const skippedSuccessorHash = refreshHash(skippedSuccessorSecret);
    memory.histories.delete(1);
    memory.histories.set(2, {
      ...directSuccessor,
      generation: 2,
      tokenHash: Buffer.from(skippedSuccessorHash),
    });
    predecessor.successorGeneration = 2;
    predecessor.successorHash = Buffer.from(skippedSuccessorHash);
    memory.session.generation = 2;
    memory.session.refreshHash = Buffer.from(skippedSuccessorHash);

    const outcome = await rotate(predecessorInput);

    expect(outcome).toEqual({ kind: 'reauth_required' });
    expectNoSuccessor(outcome);
  });

  it('does not revoke a family for unknown random material', async () => {
    const { memory, rotate } = serviceHarness();
    const before = structuredClone({
      generation: memory.session.generation,
      revokedAt: memory.session.revokedAt,
      reuseDetectedAt: memory.session.reuseDetectedAt,
      historySize: memory.histories.size,
    });
    const random = Buffer.alloc(32, 99).toString('base64url');

    const outcome = await rotate(memory.input({ refreshToken: memory.token('s2', random, 0) }));

    expect(outcome).toEqual({ kind: 'invalid' });
    expect({
      generation: memory.session.generation,
      revokedAt: memory.session.revokedAt,
      reuseDetectedAt: memory.session.reuseDetectedAt,
      historySize: memory.histories.size,
    }).toEqual(before);
    expectNoSuccessor(outcome);
  });

  it('fails closed without a successor when current session and history KIDs diverge', async () => {
    const { memory, rotate } = serviceHarness();
    const current = memory.histories.get(0);
    if (!current) throw new Error('missing current history');
    current.derivationKid = 'tampered-refresh-kid';

    const outcome = await rotate();

    expect(outcome).toEqual({ kind: 'invalid' });
    expect(memory.session.generation).toBe(0);
    expect(memory.histories).toHaveLength(1);
    expectNoSuccessor(outcome);
  });

  it.each([
    ['cross-device', (memory: MemoryPoolClient) => memory.input({ deviceId: otherDeviceId })],
    ['expired', (memory: MemoryPoolClient) => {
      memory.session.expiresAt = new Date(memory.now.getTime() - 1);
      return memory.input();
    }],
    ['revoked', (memory: MemoryPoolClient) => {
      memory.session.revokedAt = new Date(memory.now);
      return memory.input();
    }],
    ['reuse-detected', (memory: MemoryPoolClient) => {
      memory.session.reuseDetectedAt = new Date(memory.now);
      return memory.input();
    }],
  ] as const)('never exposes a successor for %s credentials', async (_label, arrange) => {
    const { memory, rotate } = serviceHarness();
    const outcome = await rotate(arrange(memory));
    expectNoSuccessor(outcome);
    expect(memory.session.generation).toBe(0);
    expect(memory.histories).toHaveLength(1);
  });

  it('rejects a stored transport mismatch before any token mutation', async () => {
    const { memory, service } = serviceHarness();
    const outcome = await service.rotate(memory as unknown as PoolClient, memory.input(), 'web_bff');
    expect(outcome).toEqual({ kind: 'invalid' });
    expect(memory.session.generation).toBe(0);
  });

  it('does not downgrade an invalid supplied binding to compatibility rotation', async () => {
    const { memory, rotate } = serviceHarness();
    const outcome = await rotate(memory.input({
      deviceBindingProof: memory.proof(Buffer.alloc(32, 21).toString('base64url')),
    }));
    expectNoSuccessor(outcome);
    expect(memory.session.generation).toBe(0);
  });

  it('does not recover outside the database-clock recovery window', async () => {
    const { memory, rotate } = serviceHarness();
    const input = memory.input();
    await rotate(input);
    memory.now = new Date(memory.now.getTime() + 120_001);
    const outcome = await rotate(input);
    expect(outcome).toEqual({ kind: 'reauth_required' });
    expectNoSuccessor(outcome);
  });

  it('does not recover when the recorded derivation KID is unavailable', async () => {
    const { memory, rotate } = serviceHarness();
    const input = memory.input();
    await rotate(input);
    const predecessor = memory.histories.get(0);
    if (!predecessor) throw new Error('missing predecessor');
    predecessor.successorDerivationKid = 'retired-and-unavailable';

    const outcome = await rotate(input);
    expect(outcome).toEqual({ kind: 'reauth_required' });
    expectNoSuccessor(outcome);
  });

  it('locks the stable session and history rows and inserts no duplicate generation', async () => {
    const { memory, rotate } = serviceHarness();
    await rotate();
    expect(memory.queries.some(({ sql }) => (
      sql.includes('FROM identity.sessions AS session') && sql.includes('FOR UPDATE OF session')
    ))).toBe(true);
    expect(memory.queries.filter(({ sql }) => (
      sql.includes('FROM identity.session_refresh_history') && sql.includes('FOR UPDATE')
    )).length).toBeGreaterThanOrEqual(1);
    expect(memory.histories).toHaveLength(2);
    expect(new Set(memory.histories.keys()).size).toBe(memory.histories.size);
  });

  it('never sends plaintext predecessor successor attempt or binding secrets to PostgreSQL', async () => {
    const { memory, rotate } = serviceHarness();
    const outcome = await rotate();
    if (outcome.kind !== 'rotated') throw new Error('expected rotation');
    const successorSecret = outcome.session.refreshToken.split('.')[3];
    if (!successorSecret) throw new Error('missing successor secret');
    const forbidden = [
      initialSecret,
      successorSecret,
      outcome.session.refreshToken,
      attemptA,
      bindingSecret,
    ];
    const serializedValues = memory.queries.flatMap(({ values }) => values).map((value) => (
      Buffer.isBuffer(value) ? value.toString('hex') : String(value)
    ));
    for (const secret of forbidden) expect(serializedValues).not.toContain(secret);
  });
});

describe('Task 4 module registration', () => {
  it('registers and exports SessionTokenService without changing controllers', () => {
    const source = readFileSync(resolve(import.meta.dirname, 'auth.module.ts'), 'utf8');
    expect(source).toContain("import { SessionTokenService } from './session-token.service.js'");
    expect(source).toMatch(/providers:\s*\[[^\]]*AuthService[^\]]*SessionTokenService[^\]]*\]/s);
    expect(source).toMatch(/exports:\s*\[[^\]]*AuthService[^\]]*SessionTokenService[^\]]*\]/s);
  });
});

const task4DatabaseURL = process.env.SPOTT_TASK4_TEST_DATABASE_URL;

describe.runIf(task4DatabaseURL !== undefined)('SessionTokenService PostgreSQL transaction proof', () => {
  it('serializes same-attempt recovery and advances each successor generation only once', async () => {
    if (!task4DatabaseURL) throw new Error('SPOTT_TASK4_TEST_DATABASE_URL is required');
    const setup = new Client({ connectionString: task4DatabaseURL });
    const clientA = new Client({ connectionString: task4DatabaseURL });
    const clientB = new Client({ connectionString: task4DatabaseURL });
    const realSessionId = randomUUID();
    const realFamilyId = randomUUID();
    const realBindingId = randomUUID();
    const realUserId = randomUUID();
    const realDeviceId = randomUUID();
    const realSecret = randomBytes(32).toString('base64url');
    const realBindingSecret = randomBytes(32).toString('base64url');
    const service = new SessionTokenService();

    await Promise.all([setup.connect(), clientA.connect(), clientB.connect()]);
    try {
      await setup.query(
        'INSERT INTO identity.users(id, public_handle) VALUES ($1, $2)',
        [realUserId, `task4_${realUserId.replaceAll('-', '').slice(0, 12)}`],
      );
      await setup.query(
        "INSERT INTO identity.devices(id, user_id, platform) VALUES ($1, $2, 'ios')",
        [realDeviceId, realUserId],
      );
      await setup.query(
        `INSERT INTO identity.sessions(
           id, user_id, device_id, refresh_hash, refresh_family_id,
           refresh_generation, current_derivation_kid, expires_at, transport_class
         ) VALUES ($1, $2, $3, $4, $5, 0, $6, clock_timestamp() + interval '1 day', 'native')`,
        [realSessionId, realUserId, realDeviceId, refreshHash(realSecret), realFamilyId, derivationKid],
      );
      await setup.query(
        `INSERT INTO identity.device_bindings(
           id, user_id, device_id, session_id, generation, current_hash, current_kid,
           absolute_expires_at
         ) VALUES ($1, $2, $3, $4, 3, $5, $6, clock_timestamp() + interval '1 day')`,
        [
          realBindingId,
          realUserId,
          realDeviceId,
          realSessionId,
          bindingHash(realBindingSecret),
          derivationKid,
        ],
      );
      await setup.query(
        `UPDATE identity.sessions
         SET current_binding_id = $2, current_binding_generation = 3
         WHERE id = $1`,
        [realSessionId, realBindingId],
      );
      await setup.query(
        `UPDATE identity.session_refresh_history
         SET binding_id = $2, binding_generation = 3
         WHERE session_id = $1 AND generation = 0`,
        [realSessionId, realBindingId],
      );

      const predecessor: RefreshMutationInput = {
        refreshToken: `s2.${realSessionId}.0.${realSecret}`,
        deviceId: realDeviceId,
        attemptKey: attemptA,
        deviceBindingProof: {
          bindingId: realBindingId,
          generation: 3,
          proof: realBindingSecret,
        },
      };
      const [first, second] = await Promise.all([
        transaction(clientA, (client) => service.rotate(client, predecessor, 'native')),
        transaction(clientB, (client) => service.rotate(client, predecessor, 'native')),
      ]);
      expect(new Set([first.kind, second.kind])).toEqual(new Set(['rotated', 'recovered']));
      const rotated = first.kind === 'rotated' ? first : second;
      const recovered = first.kind === 'recovered' ? first : second;
      if (rotated.kind !== 'rotated' || recovered.kind !== 'recovered') {
        throw new Error('expected one rotated and one recovered outcome');
      }
      expect(recovered.session.refreshToken).toBe(rotated.session.refreshToken);

      const afterRecovery = await setup.query<{
        id: string;
        refresh_family_id: string;
        refresh_generation: string;
        current_count: string;
        history_count: string;
      }>(
        `SELECT session.id, session.refresh_family_id, session.refresh_generation,
                (SELECT count(*) FROM identity.session_refresh_history history
                 WHERE history.session_id = session.id AND history.state = 'current')::text AS current_count,
                (SELECT count(*) FROM identity.session_refresh_history history
                 WHERE history.session_id = session.id)::text AS history_count
         FROM identity.sessions session WHERE session.id = $1`,
        [realSessionId],
      );
      expect(afterRecovery.rows).toEqual([{
        id: realSessionId,
        refresh_family_id: realFamilyId,
        refresh_generation: '1',
        current_count: '1',
        history_count: '2',
      }]);

      const successor = await transaction(clientA, (client) => service.rotate(client, {
        refreshToken: rotated.session.refreshToken,
        deviceId: realDeviceId,
        attemptKey: attemptB,
        deviceBindingProof: predecessor.deviceBindingProof,
      }, 'native'));
      expect(successor).toMatchObject({ kind: 'rotated', session: { refreshGeneration: 2 } });

      const unknownSecret = randomBytes(32).toString('base64url');
      const unknown = await transaction(clientB, (client) => service.rotate(client, {
        refreshToken: `s2.${realSessionId}.2.${unknownSecret}`,
        deviceId: realDeviceId,
        attemptKey: randomUUID(),
        deviceBindingProof: predecessor.deviceBindingProof,
      }, 'native'));
      expect(unknown).toEqual({ kind: 'invalid' });
      const finalState = await setup.query<{ refresh_generation: string; history_count: string }>(
        `SELECT refresh_generation,
                (SELECT count(*) FROM identity.session_refresh_history WHERE session_id = $1)::text
                  AS history_count
         FROM identity.sessions WHERE id = $1`,
        [realSessionId],
      );
      expect(finalState.rows).toEqual([{ refresh_generation: '2', history_count: '3' }]);
    } finally {
      await setup.query('DELETE FROM identity.sessions WHERE id = $1', [realSessionId]).catch(() => undefined);
      await setup.query('DELETE FROM identity.devices WHERE id = $1', [realDeviceId]).catch(() => undefined);
      await setup.query('DELETE FROM identity.users WHERE id = $1', [realUserId]).catch(() => undefined);
      await Promise.all([setup.end(), clientA.end(), clientB.end()]);
    }
  }, 30_000);
});

async function transaction<T>(client: Client, work: (client: PoolClient) => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const result = await work(client as unknown as PoolClient);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
