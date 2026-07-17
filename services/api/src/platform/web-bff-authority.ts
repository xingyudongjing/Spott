import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { DomainError } from '@spott/domain';
import type { VersionedKeyring } from '../config.js';
import { configuration } from '../config.js';
import { Database } from './database.js';
import type { SpottRequest } from './request-context.js';

const authorityContext = 'spott:web-bff-authority';
const lowercaseSHA256Pattern = /^[0-9a-f]{64}$/;
const canonicalBase64URLPattern = /^[A-Za-z0-9_-]+$/;
const canonicalNoncePattern = /^[A-Za-z0-9_-]{32,128}$/;
const canonicalTimestampPattern = /^(0|[1-9][0-9]{0,15})$/;
const canonicalSessionUUIDPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const canonicalRefreshSecretPattern = /^[A-Za-z0-9_-]{43}$/;
const canonicalRefreshGenerationPattern = /^(0|[1-9][0-9]{0,15})$/;
const maximumRefreshCredentialLength = 512;
const authorityWindowMilliseconds = 120_000;
const bffHeaderNames = [
  'x-spott-bff-version',
  'x-spott-bff-kid',
  'x-spott-bff-timestamp',
  'x-spott-bff-nonce',
  'x-spott-bff-signature',
] as const;

export type SessionTransportClass = 'web_bff' | 'native' | 'ops' | 'legacy_unclassified';

export type WebSessionBFFEnforcement = 'off' | 'observe' | 'enforce';
export type BFFAuthorityState = 'valid' | 'missing' | 'invalid';
export type SessionRequestChannel = 'headerless_native' | 'consumer_web' | 'verified_bff' | 'ops';
export type SessionAuthorityRoute =
  | 'refresh'
  | 'ops_refresh'
  | 'new_consumer_web_session'
  | 'new_native_session'
  | 'session_successor'
  | 'consumed_token_recovery';

export type ParsedRefreshCredential =
  | {
      readonly version: 'legacy';
      readonly sessionId: string;
      readonly secret: string;
    }
  | {
      readonly version: 's2';
      readonly sessionId: string;
      readonly generation: number;
      readonly secret: string;
    };

export interface VerifiedBFFAuthority {
  readonly version: 'v1';
  readonly kid: string;
  readonly timestamp: number;
  readonly nonceHash: Buffer;
}

export interface BFFVerificationRequest {
  readonly method: string;
  readonly url: string;
  readonly rawBody?: Buffer;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

export type TransportDecision =
  | { readonly kind: 'allow'; readonly transportClass?: SessionTransportClass }
  | { readonly kind: 'allow_observed'; readonly transportClass?: SessionTransportClass }
  | {
      readonly kind: 'reject';
      readonly code:
        'WEB_BFF_AUTHORITY_REQUIRED' | 'WEB_BFF_AUTHORITY_INVALID' | 'SESSION_TRANSPORT_MISMATCH';
    };

export interface TransportDecisionInput {
  readonly mode: WebSessionBFFEnforcement;
  readonly storedTransport: SessionTransportClass | null;
  readonly route: SessionAuthorityRoute;
  readonly authority: BFFAuthorityState;
  readonly requestChannel: SessionRequestChannel;
}

export interface NewSessionRouteInput {
  readonly path: string;
  readonly hasVerifiedAuthority: boolean;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

export interface BFFAuthorityFields {
  readonly keyring: VersionedKeyring;
  readonly version: string;
  readonly kid: string;
  readonly method: string;
  readonly path: string;
  readonly timestamp: number;
  readonly nonce: string;
  readonly bodyHash: string;
}

export type SignedBFFAuthorityFields = BFFAuthorityFields & {
  readonly signature: string;
};

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

function authorityDigest(fields: BFFAuthorityFields): Buffer {
  if (!fields.version || !fields.kid || !fields.method || !fields.path || !fields.nonce) {
    throw new Error('BFF authority fields must not be empty');
  }
  const key = fields.keyring.getKey(fields.kid);
  if (key === undefined) throw new Error('BFF authority KID is unknown');
  if (key.byteLength < 32) throw new Error('BFF authority key must contain at least 32 bytes');
  if (!Number.isSafeInteger(fields.timestamp) || fields.timestamp < 0) {
    throw new Error('BFF authority timestamp must be a non-negative safe integer');
  }
  if (!lowercaseSHA256Pattern.test(fields.bodyHash)) {
    throw new Error('BFF authority body hash must be canonical lowercase hexadecimal SHA-256');
  }

  return createHmac('sha256', key)
    .update(
      frameFields([
        authorityContext,
        fields.version,
        fields.kid,
        fields.method.toUpperCase(),
        fields.path,
        String(fields.timestamp),
        fields.nonce,
        fields.bodyHash,
      ]),
    )
    .digest();
}

export function signBFFAuthority(fields: BFFAuthorityFields): string {
  return authorityDigest(fields).toString('base64url');
}

export function verifyBFFAuthority(fields: SignedBFFAuthorityFields): boolean {
  if (!canonicalBase64URLPattern.test(fields.signature)) return false;

  const supplied = Buffer.from(fields.signature, 'base64url');
  if (supplied.toString('base64url') !== fields.signature) return false;

  try {
    const expected = authorityDigest(fields);
    return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
  } catch {
    return false;
  }
}

export function parseRefreshCredential(value: unknown): ParsedRefreshCredential | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumRefreshCredentialLength
  ) {
    return null;
  }
  const parts = value.split('.');
  if (parts.length === 2) {
    const [sessionId, secret] = parts;
    if (!sessionId || !secret || !validRefreshSessionId(sessionId) || !validRefreshSecret(secret))
      return null;
    return { version: 'legacy', sessionId, secret };
  }
  if (parts.length !== 4 || parts[0] !== 's2') return null;
  const [, sessionId, generationValue, secret] = parts;
  if (
    !sessionId ||
    !generationValue ||
    !secret ||
    !validRefreshSessionId(sessionId) ||
    !canonicalRefreshGenerationPattern.test(generationValue) ||
    !validRefreshSecret(secret)
  ) {
    return null;
  }
  const generation = Number(generationValue);
  if (!Number.isSafeInteger(generation)) return null;
  return { version: 's2', sessionId, generation, secret };
}

function validRefreshSessionId(value: string): boolean {
  return canonicalSessionUUIDPattern.test(value);
}

function validRefreshSecret(value: string): boolean {
  if (!canonicalRefreshSecretPattern.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.byteLength === 32 && decoded.toString('base64url') === value;
}

export function classifyNewSessionRoute(
  input: NewSessionRouteInput,
): 'new_consumer_web_session' | 'new_native_session' {
  return classifySessionRequestChannel(input) === 'headerless_native'
    ? 'new_native_session'
    : 'new_consumer_web_session';
}

export function classifySessionRequestChannel(input: {
  readonly hasVerifiedAuthority: boolean;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}): Exclude<SessionRequestChannel, 'ops'> {
  if (input.hasVerifiedAuthority) return 'verified_bff';
  const hasWebContext =
    input.headers.origin !== undefined ||
    input.headers['sec-fetch-site'] !== undefined ||
    input.headers['sec-fetch-mode'] !== undefined ||
    input.headers['sec-fetch-dest'] !== undefined ||
    bffHeaderNames.some((name) => input.headers[name] !== undefined);
  return hasWebContext ? 'consumer_web' : 'headerless_native';
}

export function decideTransport(input: TransportDecisionInput): TransportDecision {
  if (input.storedTransport === 'ops') {
    return input.route === 'ops_refresh' &&
      input.authority === 'missing' &&
      input.requestChannel === 'ops'
      ? { kind: 'allow' }
      : { kind: 'reject', code: 'SESSION_TRANSPORT_MISMATCH' };
  }

  if (input.storedTransport === 'native') {
    return (input.route === 'refresh' || input.route === 'session_successor') &&
      input.authority === 'missing' &&
      input.requestChannel === 'headerless_native'
      ? { kind: 'allow' }
      : { kind: 'reject', code: 'SESSION_TRANSPORT_MISMATCH' };
  }

  if (input.storedTransport === 'web_bff') {
    if (input.route !== 'refresh' && input.route !== 'session_successor') {
      return { kind: 'reject', code: 'SESSION_TRANSPORT_MISMATCH' };
    }
    if (input.authority === 'missing') {
      return { kind: 'reject', code: 'WEB_BFF_AUTHORITY_REQUIRED' };
    }
    if (input.authority === 'invalid') {
      return { kind: 'reject', code: 'WEB_BFF_AUTHORITY_INVALID' };
    }
    return input.requestChannel === 'verified_bff'
      ? { kind: 'allow' }
      : { kind: 'reject', code: 'SESSION_TRANSPORT_MISMATCH' };
  }

  if (input.storedTransport === 'legacy_unclassified') {
    if (
      (input.route !== 'refresh' && input.route !== 'session_successor') ||
      input.authority !== 'missing' ||
      (input.requestChannel !== 'headerless_native' && input.requestChannel !== 'consumer_web')
    ) {
      return { kind: 'reject', code: 'SESSION_TRANSPORT_MISMATCH' };
    }
    if (input.mode === 'off') return { kind: 'allow' };
    if (input.mode === 'observe') return { kind: 'allow_observed' };
    return { kind: 'reject', code: 'WEB_BFF_AUTHORITY_REQUIRED' };
  }

  if (input.route === 'new_native_session') {
    return input.authority === 'missing' && input.requestChannel === 'headerless_native'
      ? { kind: 'allow', transportClass: 'native' }
      : { kind: 'reject', code: 'SESSION_TRANSPORT_MISMATCH' };
  }

  if (input.route === 'new_consumer_web_session') {
    if (input.authority === 'invalid') {
      return { kind: 'reject', code: 'WEB_BFF_AUTHORITY_INVALID' };
    }
    if (input.authority === 'valid') {
      return input.requestChannel === 'verified_bff'
        ? { kind: 'allow', transportClass: 'web_bff' }
        : { kind: 'reject', code: 'SESSION_TRANSPORT_MISMATCH' };
    }
    if (input.requestChannel !== 'consumer_web') {
      return { kind: 'reject', code: 'SESSION_TRANSPORT_MISMATCH' };
    }
    if (input.mode === 'off') {
      return { kind: 'allow', transportClass: 'legacy_unclassified' };
    }
    if (input.mode === 'observe') {
      return { kind: 'allow_observed', transportClass: 'legacy_unclassified' };
    }
    return { kind: 'reject', code: 'WEB_BFF_AUTHORITY_REQUIRED' };
  }

  return { kind: 'reject', code: 'SESSION_TRANSPORT_MISMATCH' };
}

@Injectable()
export class WebBFFAuthority {
  constructor(private readonly database: Database) {}

  async verifyRequest(request: BFFVerificationRequest): Promise<VerifiedBFFAuthority> {
    const version = this.singleHeader(request, 'x-spott-bff-version');
    const kid = this.singleHeader(request, 'x-spott-bff-kid');
    const timestampValue = this.singleHeader(request, 'x-spott-bff-timestamp');
    const nonce = this.singleHeader(request, 'x-spott-bff-nonce');
    const signature = this.singleHeader(request, 'x-spott-bff-signature');
    if (version !== 'v1' || !kid || !timestampValue || !nonce || !signature) {
      throw this.invalidAuthority();
    }
    if (!canonicalTimestampPattern.test(timestampValue) || !canonicalNoncePattern.test(nonce)) {
      throw this.invalidAuthority();
    }

    const timestamp = Number(timestampValue);
    const now = Date.now();
    if (
      !Number.isSafeInteger(timestamp) ||
      Math.abs(now - timestamp) > authorityWindowMilliseconds
    ) {
      throw this.invalidAuthority();
    }
    if (!Buffer.isBuffer(request.rawBody)) throw this.invalidAuthority();

    const path = request.url.split('?', 1)[0];
    if (!path || !path.startsWith('/') || path.includes('#')) throw this.invalidAuthority();
    const keyring = configuration().SPOTT_WEB_BFF_KEYS;
    const bodyHash = createHash('sha256').update(request.rawBody).digest('hex');
    if (
      !verifyBFFAuthority({
        keyring,
        version,
        kid,
        method: request.method,
        path,
        timestamp,
        nonce,
        bodyHash,
        signature,
      })
    ) {
      throw this.invalidAuthority();
    }

    const nonceHash = createHash('sha256').update(nonce).digest();
    let inserted: {
      readonly rowCount: number | null;
      readonly rows: Array<{ nonce_hash: Buffer }>;
    };
    try {
      inserted = await this.database.query<{ nonce_hash: Buffer }>(
        `INSERT INTO identity.web_bff_request_nonces(signing_kid, nonce_hash, expires_at)
         VALUES ($1, $2, to_timestamp($3 / 1000.0) + interval '2 minutes')
         ON CONFLICT DO NOTHING
         RETURNING nonce_hash`,
        [kid, nonceHash, timestamp],
      );
    } catch {
      throw this.invalidAuthority();
    }
    const storedHash = inserted.rows[0]?.nonce_hash;
    if (
      inserted.rowCount !== 1 ||
      !storedHash ||
      storedHash.byteLength !== nonceHash.byteLength ||
      !timingSafeEqual(storedHash, nonceHash)
    ) {
      throw this.invalidAuthority();
    }

    try {
      await this.database.query(
        `DELETE FROM identity.web_bff_request_nonces
         WHERE ctid IN (
           SELECT ctid FROM identity.web_bff_request_nonces
           WHERE expires_at < clock_timestamp()
             AND NOT (signing_kid = $1 AND nonce_hash = $2)
           ORDER BY expires_at
           LIMIT 100
         )`,
        [kid, nonceHash],
      );
    } catch {
      // The accepted nonce is already durable. Cleanup is bounded maintenance only.
    }

    return { version: 'v1', kid, timestamp, nonceHash };
  }

  hasAuthorityHeaders(request: Pick<BFFVerificationRequest, 'headers'>): boolean {
    return bffHeaderNames.some((name) => request.headers[name] !== undefined);
  }

  private singleHeader(
    request: BFFVerificationRequest,
    name: (typeof bffHeaderNames)[number],
  ): string | undefined {
    const value = request.headers[name];
    return typeof value === 'string' ? value : undefined;
  }

  private invalidAuthority(): DomainError {
    return new DomainError('WEB_BFF_AUTHORITY_INVALID', '请求认证无效，请重新发起操作。', 401, {
      retryable: false,
    });
  }
}

@Injectable()
export class WebBFFTransportGuard implements CanActivate {
  private readonly logger = new Logger(WebBFFTransportGuard.name);

  constructor(
    private readonly database: Database,
    private readonly authority: WebBFFAuthority,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<SpottRequest>();
    if (request.method !== 'POST') return true;
    const path = request.url.split('?', 1)[0];
    if (
      path === '/v1/auth/email/verify' ||
      path === '/v1/auth/apple' ||
      path === '/v1/auth/google'
    ) {
      return this.authorizeNewSession(request, path);
    }
    if (path === '/v1/accounts/merge/commit') {
      if (this.authority.hasAuthorityHeaders(request)) {
        request.verifiedBFFAuthority = await this.authority.verifyRequest(request);
      }
      request.sessionRequestChannel = classifySessionRequestChannel({
        hasVerifiedAuthority: request.verifiedBFFAuthority !== undefined,
        headers: request.headers,
      });
      return true;
    }
    const isRefresh = path === '/v1/auth/refresh';
    const isBootstrap = path === '/v1/auth/bootstrap';
    if (!isRefresh && !isBootstrap) return true;

    const refreshToken = this.refreshToken(request.body);
    const parsed = parseRefreshCredential(refreshToken);
    if (!parsed) this.rejectInvalidRefresh();

    const stored = await this.database.query<{ transport_class: SessionTransportClass }>(
      'SELECT transport_class FROM identity.sessions WHERE id = $1',
      [parsed.sessionId],
    );
    const storedTransport = stored.rows[0]?.transport_class ?? null;
    const hasAuthority = this.authority.hasAuthorityHeaders(request);
    let authorityState: BFFAuthorityState = hasAuthority ? 'invalid' : 'missing';

    if (hasAuthority && storedTransport !== 'native' && storedTransport !== 'ops') {
      request.verifiedBFFAuthority = await this.authority.verifyRequest(request);
      authorityState = 'valid';
    }
    request.sessionRequestChannel = classifySessionRequestChannel({
      hasVerifiedAuthority: authorityState === 'valid',
      headers: request.headers,
    });
    if (storedTransport === null) return true;

    const decision = decideTransport({
      mode: configuration().WEB_SESSION_BFF_ENFORCEMENT,
      storedTransport,
      route: isBootstrap ? 'session_successor' : 'refresh',
      authority: authorityState,
      requestChannel: request.sessionRequestChannel,
    });
    if (decision.kind === 'reject') this.reject(decision.code);
    if (decision.kind === 'allow_observed') {
      this.logger.warn('Legacy Web refresh would be blocked under BFF enforcement');
    }
    return true;
  }

  private async authorizeNewSession(request: SpottRequest, path: string): Promise<true> {
    const hasAuthority = this.authority.hasAuthorityHeaders(request);
    let authorityState: BFFAuthorityState = 'missing';
    if (hasAuthority) {
      request.verifiedBFFAuthority = await this.authority.verifyRequest(request);
      authorityState = 'valid';
    }
    const route = classifyNewSessionRoute({
      path,
      hasVerifiedAuthority: authorityState === 'valid',
      headers: request.headers,
    });
    request.sessionRequestChannel = classifySessionRequestChannel({
      hasVerifiedAuthority: authorityState === 'valid',
      headers: request.headers,
    });
    const decision = decideTransport({
      mode: configuration().WEB_SESSION_BFF_ENFORCEMENT,
      storedTransport: null,
      route,
      authority: authorityState,
      requestChannel: request.sessionRequestChannel,
    });
    if (decision.kind === 'reject') this.reject(decision.code);
    if (!decision.transportClass) this.reject('SESSION_TRANSPORT_MISMATCH');
    request.issuedSessionTransportClass = decision.transportClass;
    if (decision.kind === 'allow_observed') {
      this.logger.warn('Unsigned new Web session would be blocked under BFF enforcement');
    }
    return true;
  }

  private refreshToken(body: unknown): string | undefined {
    if (typeof body !== 'object' || body === null || !('refreshToken' in body)) return undefined;
    const value = body.refreshToken;
    return typeof value === 'string' ? value : undefined;
  }

  private rejectInvalidRefresh(): never {
    throw new DomainError('TOKEN_INVALID', '登录凭证无效。', 401, { retryable: false });
  }

  private reject(code: Extract<TransportDecision, { kind: 'reject' }>['code']): never {
    const message =
      code === 'WEB_BFF_AUTHORITY_REQUIRED'
        ? '此会话需要通过安全 Web 通道刷新。'
        : '会话通道不匹配，请重新登录。';
    throw new DomainError(code, message, 403, { retryable: false });
  }
}
