import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as completionKDF from './web-session-completion-kdf.js';
import {
  completionAttemptHash,
  completionRequestDigest,
  deriveInitialWebRefreshSecret,
  type WebSessionCompletionRefreshInput,
  type WebSessionCompletionRequestDigestInput,
} from './web-session-completion-kdf.js';

const key = Buffer.from('0123456789abcdef0123456789abcdef');
const kid = 'refresh-2026-07';
const attemptId = '019b0000-0000-7000-8000-000000000010';
const challengeId = '019b0000-0000-7000-8000-000000000011';
const userId = '019b0000-0000-7000-8000-000000000012';
const deviceId = '019b0000-0000-7000-8000-000000000013';
const sessionId = '019b0000-0000-7000-8000-000000000014';
const familyId = '019b0000-0000-7000-8000-000000000015';
const bindingId = '019b0000-0000-7000-8000-000000000016';
const code = '482913';
const proof = Buffer.alloc(32, 0xa5).toString('base64url');

function referenceFrame(fields: readonly string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const field of fields) {
    const bytes = Buffer.from(field.normalize('NFC'), 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.byteLength);
    chunks.push(length, bytes);
  }
  return Buffer.concat(chunks);
}

const requestInput = {
  key,
  kid,
  attemptId,
  challengeId,
  code,
  deviceId,
  bindingId,
  bindingGeneration: 0,
  proof,
} as const satisfies WebSessionCompletionRequestDigestInput;

const refreshInput = {
  key,
  kid,
  attemptHash: Buffer.from(
    'd13842a03c43350b68f5861e91b72173181780a42e7c71c56db9808201710475',
    'hex',
  ),
  challengeId,
  userId,
  deviceId,
  sessionId,
  familyId,
  bindingId,
  generation: 0,
  transportClass: 'web_bff',
} as const satisfies WebSessionCompletionRefreshInput;

describe('completionDispositionAuthorityDigest', () => {
  it('exports a domain-separated authority KDF bound to every caller-held attempt field', () => {
    expect(completionKDF).toHaveProperty('completionDispositionAuthorityDigest');
    const digest = (
      completionKDF as typeof completionKDF & {
        completionDispositionAuthorityDigest(input: {
          key: Buffer;
          kid: string;
          attemptId: string;
          challengeId: string;
          deviceId: string;
          bindingId: string;
          bindingGeneration: number;
          proof: string;
        }): Buffer;
      }
    ).completionDispositionAuthorityDigest({
      key,
      kid,
      attemptId,
      challengeId,
      deviceId,
      bindingId,
      bindingGeneration: 0,
      proof,
    });
    const expected = createHmac('sha256', key)
      .update(referenceFrame([
        'spott:web-session-completion-disposition-authority',
        'v1',
        kid,
        attemptId,
        challengeId,
        deviceId,
        bindingId,
        '0',
        proof,
      ]))
      .digest();

    expect(digest).toEqual(expected);
    expect(digest).toHaveLength(32);
    expect(digest).not.toEqual(completionRequestDigest(requestInput));
  });
});

describe('completionAttemptHash', () => {
  it('matches the frozen domain-separated v1 vector', () => {
    expect(completionAttemptHash(attemptId).toString('hex')).toBe(
      'd13842a03c43350b68f5861e91b72173181780a42e7c71c56db9808201710475',
    );
  });

  it('length-frames the attempt and binds it to its own context and version', () => {
    const actual = completionAttemptHash(attemptId);
    const unframed = createHash('sha256').update(attemptId).digest();
    const otherContext = createHash('sha256')
      .update(referenceFrame(['spott:other-attempt', 'v1', attemptId]))
      .digest();
    const otherVersion = createHash('sha256')
      .update(referenceFrame(['spott:web-session-completion-attempt', 'v2', attemptId]))
      .digest();

    expect(actual).toHaveLength(32);
    expect(actual).not.toEqual(unframed);
    expect(actual).not.toEqual(otherContext);
    expect(actual).not.toEqual(otherVersion);
  });

  it.each([
    ['uppercase', attemptId.toUpperCase()],
    ['nil UUID', '00000000-0000-0000-0000-000000000000'],
    ['bad variant', '019b0000-0000-7000-7000-000000000010'],
    ['surrounding whitespace', ` ${attemptId}`],
    ['non UUID', 'attempt-1'],
  ])('rejects a non-canonical attempt ID: %s', (_label, value) => {
    expect(() => completionAttemptHash(value)).toThrow(Error);
  });
});

describe('completionRequestDigest', () => {
  it('matches the frozen domain-separated v1 vector', () => {
    expect(completionRequestDigest(requestInput).toString('hex')).toBe(
      '58e69d82e9fd71f2a7eb5a4888fc8aa83d2aa3e2fe457e733934083a27ff43c5',
    );
  });

  it('is sensitive to every request field', () => {
    const baseline = completionRequestDigest(requestInput);
    const mutations: readonly WebSessionCompletionRequestDigestInput[] = [
      { ...requestInput, key: Buffer.from('fedcba9876543210fedcba9876543210') },
      { ...requestInput, kid: 'refresh-2026-08' },
      { ...requestInput, attemptId: '019b0000-0000-7000-8000-000000000020' },
      { ...requestInput, challengeId: '019b0000-0000-7000-8000-000000000021' },
      { ...requestInput, code: '482914' },
      { ...requestInput, deviceId: '019b0000-0000-7000-8000-000000000023' },
      { ...requestInput, bindingId: '019b0000-0000-7000-8000-000000000026' },
      { ...requestInput, proof: Buffer.alloc(32, 0xa6).toString('base64url') },
    ];

    for (const mutation of mutations) {
      expect(completionRequestDigest(mutation)).not.toEqual(baseline);
    }
  });

  it('cannot collide with an unframed, different-context, or different-version request MAC', () => {
    const actual = completionRequestDigest(requestInput);
    const payload = [
      kid,
      attemptId,
      challengeId,
      code,
      deviceId,
      bindingId,
      '0',
      proof,
    ] as const;
    const unframed = createHmac('sha256', key).update(payload.join('')).digest();
    const otherContext = createHmac('sha256', key)
      .update(referenceFrame(['spott:other-request', 'v1', ...payload]))
      .digest();
    const otherVersion = createHmac('sha256', key)
      .update(referenceFrame(['spott:web-session-completion-request', 'v2', ...payload]))
      .digest();

    expect(actual).toHaveLength(32);
    expect(actual).not.toEqual(unframed);
    expect(actual).not.toEqual(otherContext);
    expect(actual).not.toEqual(otherVersion);
  });

  it.each([
    ['short key', { ...requestInput, key: Buffer.alloc(31) }],
    ['invalid KID', { ...requestInput, kid: 'bad kid' }],
    ['uppercase attempt UUID', { ...requestInput, attemptId: attemptId.toUpperCase() }],
    ['bad challenge UUID', { ...requestInput, challengeId: 'challenge' }],
    ['bad device UUID', { ...requestInput, deviceId: 'device' }],
    ['bad binding UUID', { ...requestInput, bindingId: 'binding' }],
    ['short code', { ...requestInput, code: '48291' }],
    ['non-numeric code', { ...requestInput, code: '48291a' }],
    ['non-zero binding generation', { ...requestInput, bindingGeneration: 1 }],
    ['short proof', { ...requestInput, proof: Buffer.alloc(31).toString('base64url') }],
    ['padded proof', { ...requestInput, proof: `${proof}=` }],
    ['non-canonical proof', { ...requestInput, proof: `${proof.slice(0, -1)}V` }],
  ] as const)('rejects malformed input: %s', (_label, malformed) => {
    expect(() => completionRequestDigest(malformed)).toThrow(Error);
  });
});

describe('deriveInitialWebRefreshSecret', () => {
  it('matches the frozen domain-separated v1 vector and returns canonical 32-byte base64url', () => {
    const secret = deriveInitialWebRefreshSecret(refreshInput);

    expect(secret).toBe('RmFFf4ATqaa3T54q8mqmPD7jFEYzuOuk9hcWuLooras');
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
    expect(Buffer.from(secret, 'base64url').toString('base64url')).toBe(secret);
  });

  it('is sensitive to every refresh reconstruction field', () => {
    const baseline = deriveInitialWebRefreshSecret(refreshInput);
    const mutations: readonly WebSessionCompletionRefreshInput[] = [
      { ...refreshInput, key: Buffer.from('fedcba9876543210fedcba9876543210') },
      { ...refreshInput, kid: 'refresh-2026-08' },
      { ...refreshInput, attemptHash: Buffer.alloc(32, 0x7f) },
      { ...refreshInput, challengeId: '019b0000-0000-7000-8000-000000000021' },
      { ...refreshInput, userId: '019b0000-0000-7000-8000-000000000022' },
      { ...refreshInput, deviceId: '019b0000-0000-7000-8000-000000000023' },
      { ...refreshInput, sessionId: '019b0000-0000-7000-8000-000000000024' },
      { ...refreshInput, familyId: '019b0000-0000-7000-8000-000000000025' },
      { ...refreshInput, bindingId: '019b0000-0000-7000-8000-000000000026' },
    ];

    for (const mutation of mutations) {
      expect(deriveInitialWebRefreshSecret(mutation)).not.toBe(baseline);
    }
  });

  it('cannot collide with a different context, version, or unframed payload', () => {
    const actual = Buffer.from(deriveInitialWebRefreshSecret(refreshInput), 'base64url');
    const payload = [
      kid,
      refreshInput.attemptHash.toString('hex'),
      challengeId,
      userId,
      deviceId,
      sessionId,
      familyId,
      bindingId,
      '0',
      'web_bff',
    ] as const;
    const unframed = createHmac('sha256', key).update(payload.join('')).digest();
    const otherContext = createHmac('sha256', key)
      .update(referenceFrame(['spott:other-refresh-secret', 'v1', ...payload]))
      .digest();
    const otherVersion = createHmac('sha256', key)
      .update(referenceFrame([
        'spott:web-session-completion-refresh-secret',
        'v2',
        ...payload,
      ]))
      .digest();

    expect(actual).not.toEqual(unframed);
    expect(actual).not.toEqual(otherContext);
    expect(actual).not.toEqual(otherVersion);
  });

  it.each([
    ['short key', { ...refreshInput, key: Buffer.alloc(31) }],
    ['invalid KID', { ...refreshInput, kid: '.bad' }],
    ['short attempt hash', { ...refreshInput, attemptHash: Buffer.alloc(31) }],
    ['uppercase challenge UUID', { ...refreshInput, challengeId: challengeId.toUpperCase() }],
    ['bad user UUID', { ...refreshInput, userId: 'user' }],
    ['bad device UUID', { ...refreshInput, deviceId: 'device' }],
    ['bad session UUID', { ...refreshInput, sessionId: 'session' }],
    ['bad family UUID', { ...refreshInput, familyId: 'family' }],
    ['bad binding UUID', { ...refreshInput, bindingId: 'binding' }],
    ['non-zero generation', { ...refreshInput, generation: 1 }],
    ['native transport', { ...refreshInput, transportClass: 'native' }],
  ] as const)('rejects malformed or non-Web input: %s', (_label, malformed) => {
    expect(() => deriveInitialWebRefreshSecret(malformed)).toThrow(Error);
  });
});
