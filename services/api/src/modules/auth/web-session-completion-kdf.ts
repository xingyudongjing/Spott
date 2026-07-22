import { createHash, createHmac } from 'node:crypto';
import { frameFields } from '../../platform/web-bff-authority.js';

const completionAttemptContext = 'spott:web-session-completion-attempt';
const completionRequestContext = 'spott:web-session-completion-request';
const completionDispositionAuthorityContext =
  'spott:web-session-completion-disposition-authority';
const completionRefreshSecretContext = 'spott:web-session-completion-refresh-secret';
const completionVersion = 'v1';

const canonicalUUIDPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const canonicalKIDPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const sixDigitCodePattern = /^[0-9]{6}$/;
const canonicalThirtyTwoByteBase64URLPattern = /^[A-Za-z0-9_-]{43}$/;

export interface WebSessionCompletionRequestDigestInput {
  readonly key: Buffer;
  readonly kid: string;
  readonly attemptId: string;
  readonly challengeId: string;
  readonly code: string;
  readonly deviceId: string;
  readonly bindingId: string;
  readonly bindingGeneration: number;
  readonly proof: string;
}

export interface WebSessionCompletionRefreshInput {
  readonly key: Buffer;
  readonly kid: string;
  readonly attemptHash: Buffer;
  readonly challengeId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly familyId: string;
  readonly bindingId: string;
  readonly generation: number;
  readonly transportClass: string;
}

export interface WebSessionCompletionDispositionAuthorityInput {
  readonly key: Buffer;
  readonly kid: string;
  readonly attemptId: string;
  readonly challengeId: string;
  readonly deviceId: string;
  readonly bindingId: string;
  readonly bindingGeneration: number;
  readonly proof: string;
}

function requireKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.byteLength < 32) {
    throw new Error('Web session completion key must contain at least 32 bytes');
  }
}

function requireKID(kid: string): void {
  if (typeof kid !== 'string' || !canonicalKIDPattern.test(kid)) {
    throw new Error('Web session completion KID is invalid');
  }
}

function requireCanonicalUUID(value: string, field: string): void {
  if (typeof value !== 'string' || !canonicalUUIDPattern.test(value)) {
    throw new Error(`Web session completion ${field} must be a canonical lowercase UUID`);
  }
}

function requireInitialGeneration(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value !== 0) {
    throw new Error(`Web session completion ${field} must be generation zero`);
  }
}

function requireThirtyTwoByteBuffer(value: Buffer, field: string): void {
  if (!Buffer.isBuffer(value) || value.byteLength !== 32) {
    throw new Error(`Web session completion ${field} must contain exactly 32 bytes`);
  }
}

function requireCanonicalThirtyTwoByteBase64URL(value: string, field: string): void {
  if (
    typeof value !== 'string'
    || !canonicalThirtyTwoByteBase64URLPattern.test(value)
  ) {
    throw new Error(`Web session completion ${field} must be canonical 32-byte base64url`);
  }

  const decoded = Buffer.from(value, 'base64url');
  if (decoded.byteLength !== 32 || decoded.toString('base64url') !== value) {
    throw new Error(`Web session completion ${field} must be canonical 32-byte base64url`);
  }
}

export function completionAttemptHash(attemptId: string): Buffer {
  requireCanonicalUUID(attemptId, 'attempt ID');

  return createHash('sha256')
    .update(frameFields([
      completionAttemptContext,
      completionVersion,
      attemptId,
    ]))
    .digest();
}

export function completionRequestDigest(
  input: WebSessionCompletionRequestDigestInput,
): Buffer {
  requireKey(input.key);
  requireKID(input.kid);
  requireCanonicalUUID(input.attemptId, 'attempt ID');
  requireCanonicalUUID(input.challengeId, 'challenge ID');
  if (typeof input.code !== 'string' || !sixDigitCodePattern.test(input.code)) {
    throw new Error('Web session completion code must contain exactly six ASCII digits');
  }
  requireCanonicalUUID(input.deviceId, 'device ID');
  requireCanonicalUUID(input.bindingId, 'binding ID');
  requireInitialGeneration(input.bindingGeneration, 'binding generation');
  requireCanonicalThirtyTwoByteBase64URL(input.proof, 'binding proof');

  return createHmac('sha256', input.key)
    .update(frameFields([
      completionRequestContext,
      completionVersion,
      input.kid,
      input.attemptId,
      input.challengeId,
      input.code,
      input.deviceId,
      input.bindingId,
      String(input.bindingGeneration),
      input.proof,
    ]))
    .digest();
}

export function completionDispositionAuthorityDigest(
  input: WebSessionCompletionDispositionAuthorityInput,
): Buffer {
  requireKey(input.key);
  requireKID(input.kid);
  requireCanonicalUUID(input.attemptId, 'attempt ID');
  requireCanonicalUUID(input.challengeId, 'challenge ID');
  requireCanonicalUUID(input.deviceId, 'device ID');
  requireCanonicalUUID(input.bindingId, 'binding ID');
  requireInitialGeneration(input.bindingGeneration, 'binding generation');
  requireCanonicalThirtyTwoByteBase64URL(input.proof, 'binding proof');

  return createHmac('sha256', input.key)
    .update(frameFields([
      completionDispositionAuthorityContext,
      completionVersion,
      input.kid,
      input.attemptId,
      input.challengeId,
      input.deviceId,
      input.bindingId,
      String(input.bindingGeneration),
      input.proof,
    ]))
    .digest();
}

export function deriveInitialWebRefreshSecret(
  input: WebSessionCompletionRefreshInput,
): string {
  requireKey(input.key);
  requireKID(input.kid);
  requireThirtyTwoByteBuffer(input.attemptHash, 'attempt hash');
  requireCanonicalUUID(input.challengeId, 'challenge ID');
  requireCanonicalUUID(input.userId, 'user ID');
  requireCanonicalUUID(input.deviceId, 'device ID');
  requireCanonicalUUID(input.sessionId, 'session ID');
  requireCanonicalUUID(input.familyId, 'family ID');
  requireCanonicalUUID(input.bindingId, 'binding ID');
  requireInitialGeneration(input.generation, 'refresh generation');
  if (input.transportClass !== 'web_bff') {
    throw new Error('Initial Web refresh secrets require the web_bff transport class');
  }

  return createHmac('sha256', input.key)
    .update(frameFields([
      completionRefreshSecretContext,
      completionVersion,
      input.kid,
      input.attemptHash.toString('hex'),
      input.challengeId,
      input.userId,
      input.deviceId,
      input.sessionId,
      input.familyId,
      input.bindingId,
      String(input.generation),
      input.transportClass,
    ]))
    .digest('base64url');
}
