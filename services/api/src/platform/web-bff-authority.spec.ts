import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseVersionedKeyring } from '../config.js';
import {
  frameFields,
  signBFFAuthority,
  verifyBFFAuthority,
  type BFFAuthorityFields,
} from './web-bff-authority.js';
import * as authorityModule from './web-bff-authority.js';

type SessionTransportClass = 'web_bff' | 'native' | 'ops' | 'legacy_unclassified';
type WebSessionBFFEnforcement = 'off' | 'observe' | 'enforce';
type AuthorityState = 'valid' | 'missing' | 'invalid';
type SessionRequestChannel = 'headerless_native' | 'consumer_web' | 'verified_bff' | 'ops';
type AuthorityRoute =
  | 'refresh'
  | 'ops_refresh'
  | 'new_consumer_web_session'
  | 'new_native_session'
  | 'session_successor'
  | 'binding_upgrade'
  | 'consumed_token_recovery';
type ParsedRefreshCredential =
  | { readonly version: 'legacy'; readonly sessionId: string; readonly secret: string }
  | {
      readonly version: 's2';
      readonly sessionId: string;
      readonly generation: number;
      readonly secret: string;
    };
type TransportDecision =
  | { readonly kind: 'allow'; readonly transportClass?: SessionTransportClass }
  | { readonly kind: 'allow_observed'; readonly transportClass?: SessionTransportClass }
  | {
      readonly kind: 'reject';
      readonly code: 'WEB_BFF_AUTHORITY_REQUIRED' | 'WEB_BFF_AUTHORITY_INVALID' | 'SESSION_TRANSPORT_MISMATCH';
    };
interface BFFVerificationRequest {
  readonly method: string;
  readonly url: string;
  readonly rawBody?: Buffer;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}
interface VerifiedBFFAuthority {
  readonly version: 'v1';
  readonly kid: string;
  readonly timestamp: number;
  readonly nonceHash: Buffer;
}

const decideTransportImplementation = (authorityModule as unknown as {
  readonly decideTransport: (input: {
    readonly mode: WebSessionBFFEnforcement;
    readonly storedTransport: SessionTransportClass | null;
    readonly route: AuthorityRoute;
    readonly authority: AuthorityState;
    readonly requestChannel: SessionRequestChannel;
  }) => TransportDecision;
}).decideTransport;
function decideTransport(input: {
  readonly mode: WebSessionBFFEnforcement;
  readonly storedTransport: SessionTransportClass | null;
  readonly route: AuthorityRoute;
  readonly authority: AuthorityState;
  readonly requestChannel?: SessionRequestChannel;
}): TransportDecision {
  const requestChannel = input.requestChannel
    ?? (input.route === 'ops_refresh'
      ? 'ops'
      : input.authority === 'valid'
        ? 'verified_bff'
        : input.route === 'new_consumer_web_session'
          ? 'consumer_web'
          : 'headerless_native');
  return decideTransportImplementation({ ...input, requestChannel });
}
const classifyNewSessionRoute = (authorityModule as unknown as {
  readonly classifyNewSessionRoute: (input: {
    readonly path: string;
    readonly hasVerifiedAuthority: boolean;
    readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
    readonly bodyPlatform?: string;
  }) => 'new_consumer_web_session' | 'new_native_session';
}).classifyNewSessionRoute;
const parseRefreshCredential = (authorityModule as unknown as {
  readonly parseRefreshCredential: (value: unknown) => ParsedRefreshCredential | null;
}).parseRefreshCredential;
const WebBFFAuthority = (authorityModule as unknown as {
  readonly WebBFFAuthority: new (database: unknown) => {
    verifyRequest(request: BFFVerificationRequest): Promise<VerifiedBFFAuthority>;
  };
}).WebBFFAuthority;

const fixedKey = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY';
const fixedRefreshKey = 'ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://127.0.0.1:55432/spott_task3_unit_test',
  ACCESS_TOKEN_SECRET: 'task3-access-token-secret-at-least-32-bytes',
  REFRESH_TOKEN_SECRET: 'task3-refresh-token-secret-at-least-32-bytes',
  FIELD_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 4).toString('base64'),
  LOOKUP_HMAC_PEPPER: 'task3-lookup-pepper-at-least-16-bytes',
  SPOTT_WEB_BFF_KEYS: `bff-2026-07:${fixedKey}`,
  SPOTT_WEB_BFF_CURRENT_KID: 'bff-2026-07',
  REFRESH_TOKEN_DERIVATION_KEYS: `refresh-2026-07:${fixedRefreshKey}`,
  REFRESH_TOKEN_DERIVATION_CURRENT_KID: 'refresh-2026-07',
  WEB_SESSION_BFF_ENFORCEMENT: 'off',
  WEB_SESSION_RECOVERY_SECONDS: '120',
  SPOTT_WEB_CANONICAL_ORIGIN: 'https://spott.jp',
});

const fixedKeyring = parseVersionedKeyring(`bff-2026-07:${fixedKey}`, 'bff-2026-07');
const fixedFields: BFFAuthorityFields = {
  keyring: fixedKeyring,
  version: 'v1',
  kid: 'bff-2026-07',
  method: 'POST',
  path: '/v1/auth/refresh',
  timestamp: 1_784_246_400_000,
  nonce: 'nonce-0000000000000000000000000001',
  bodyHash: 'b9e9bfd687bf53a9ceb4de7c56bf4b78ae43e157f03f31556f39a007b36da6ad',
};

const fixedSignature = '9hpIJXAoFYB0tzzG6dzzVjOxLHkqbwZDOvEiPPFrjaM';
const modes = ['off', 'observe', 'enforce'] as const satisfies readonly WebSessionBFFEnforcement[];

function signedRequest(overrides: {
  readonly now?: number;
  readonly nonce?: string;
  readonly kid?: string;
  readonly version?: string;
  readonly signature?: string;
} = {}): BFFVerificationRequest {
  const rawBody = Buffer.from(JSON.stringify({
    refreshToken: '019b0000-0000-7000-8000-000000000001.secret',
    deviceId: '019b0000-0000-7000-8000-000000000002',
  }));
  const timestamp = overrides.now ?? fixedFields.timestamp;
  const nonce = overrides.nonce ?? fixedFields.nonce;
  const kid = overrides.kid ?? fixedFields.kid;
  const version = overrides.version ?? fixedFields.version;
  const fields = {
    ...fixedFields,
    version,
    kid,
    timestamp,
    nonce,
    bodyHash: createHash('sha256').update(rawBody).digest('hex'),
  };
  return {
    method: 'POST',
    url: '/v1/auth/refresh',
    rawBody,
    headers: {
      'x-spott-bff-version': version,
      'x-spott-bff-kid': kid,
      'x-spott-bff-timestamp': String(timestamp),
      'x-spott-bff-nonce': nonce,
      'x-spott-bff-signature': overrides.signature ?? signBFFAuthority(fields),
    },
  };
}

describe('canonical BFF authority framing', () => {
  it('frames NFC UTF-8 byte lengths as unsigned 32-bit big-endian values', () => {
    expect(frameFields(['A', 'e\u0301']).toString('hex')).toBe(
      '000000014100000002c3a9',
    );
  });

  it('matches the committed BFF authority fixed vector', () => {
    expect(signBFFAuthority(fixedFields)).toBe(fixedSignature);
    expect(verifyBFFAuthority({ ...fixedFields, signature: fixedSignature })).toBe(true);
  });

  it('uses a defensive keyring lookup for every HMAC operation', () => {
    const returnedKey = fixedKeyring.getKey(fixedFields.kid);
    returnedKey?.fill(0);

    expect(signBFFAuthority(fixedFields)).toBe(fixedSignature);
  });

  it('fails closed for an unknown signing KID', () => {
    expect(() => signBFFAuthority({
      ...fixedFields,
      kid: 'unknown-kid',
    })).toThrow(/KID/);
    expect(verifyBFFAuthority({
      ...fixedFields,
      kid: 'unknown-kid',
      signature: fixedSignature,
    })).toBe(false);
  });

  it.each([
    ['version', { version: 'v2' }],
    ['KID', { kid: 'bff-2026-08' }],
    ['method', { method: 'PUT' }],
    ['path', { path: '/v1/auth/refresh/' }],
    ['timestamp', { timestamp: fixedFields.timestamp + 1 }],
    ['nonce', { nonce: `${fixedFields.nonce}x` }],
    ['body hash', { bodyHash: `a${fixedFields.bodyHash.slice(1)}` }],
  ] satisfies [string, Partial<BFFAuthorityFields>][])('rejects a mutated %s', (_label, mutation) => {
    expect(verifyBFFAuthority({
      ...fixedFields,
      ...mutation,
      signature: fixedSignature,
    })).toBe(false);
  });

  it('rejects a one-bit signature mutation', () => {
    const mutation = Buffer.from(fixedSignature, 'base64url');
    mutation.writeUInt8(mutation.readUInt8(0) ^ 0x01, 0);

    expect(verifyBFFAuthority({
      ...fixedFields,
      signature: mutation.toString('base64url'),
    })).toBe(false);
  });

  it.each([
    '',
    `${fixedSignature}=`,
    fixedSignature.slice(1),
    '*'.repeat(fixedSignature.length),
  ])('rejects a malformed non-canonical signature', (signature) => {
    expect(verifyBFFAuthority({ ...fixedFields, signature })).toBe(false);
  });

  it('rejects a non-canonical uppercase body hash', () => {
    expect(verifyBFFAuthority({
      ...fixedFields,
      bodyHash: fixedFields.bodyHash.toUpperCase(),
      signature: fixedSignature,
    })).toBe(false);
  });
});

describe('immutable session transport decisions', () => {
  it.each(modes)('always rejects unsigned stored web_bff in %s', (mode) => {
    expect(decideTransport({
      mode,
      storedTransport: 'web_bff',
      route: 'refresh',
      authority: 'missing',
    })).toEqual({ kind: 'reject', code: 'WEB_BFF_AUTHORITY_REQUIRED' });
  });

  it.each(modes)('always rejects invalid authority for stored web_bff in %s', (mode) => {
    expect(decideTransport({
      mode,
      storedTransport: 'web_bff',
      route: 'refresh',
      authority: 'invalid',
    })).toEqual({ kind: 'reject', code: 'WEB_BFF_AUTHORITY_INVALID' });
  });

  it.each(modes)('allows stored web_bff only with verified authority in %s', (mode) => {
    expect(decideTransport({
      mode,
      storedTransport: 'web_bff',
      route: 'refresh',
      authority: 'valid',
    })).toEqual({ kind: 'allow' });
  });

  it.each(modes)('never routes stored ops through consumer refresh in %s', (mode) => {
    for (const authority of ['missing', 'invalid', 'valid'] as const) {
      expect(decideTransport({
        mode,
        storedTransport: 'ops',
        route: 'refresh',
        authority,
      })).toEqual({ kind: 'reject', code: 'SESSION_TRANSPORT_MISMATCH' });
    }
  });

  it.each(modes)('keeps stored ops on the Ops refresh route in %s', (mode) => {
    expect(decideTransport({
      mode,
      storedTransport: 'ops',
      route: 'ops_refresh',
      authority: 'missing',
    })).toEqual({ kind: 'allow' });
  });

  it.each(modes)('keeps stored native on the unsigned native refresh contract in %s', (mode) => {
    expect(decideTransport({
      mode,
      storedTransport: 'native',
      route: 'refresh',
      authority: 'missing',
    })).toEqual({ kind: 'allow' });
    expect(decideTransport({
      mode,
      storedTransport: 'native',
      route: 'refresh',
      authority: 'valid',
    })).toEqual({ kind: 'reject', code: 'SESSION_TRANSPORT_MISMATCH' });
  });

  it.each(modes)('rejects browser-context use of a stored native credential in %s', (mode) => {
    expect(decideTransport({
      mode,
      storedTransport: 'native',
      route: 'refresh',
      authority: 'missing',
      requestChannel: 'consumer_web',
    })).toEqual({ kind: 'reject', code: 'SESSION_TRANSPORT_MISMATCH' });
  });

  it.each(modes)('rejects BFF use of a stored native credential in %s', (mode) => {
    expect(decideTransport({
      mode,
      storedTransport: 'native',
      route: 'refresh',
      authority: 'valid',
      requestChannel: 'verified_bff',
    })).toEqual({ kind: 'reject', code: 'SESSION_TRANSPORT_MISMATCH' });
    expect(decideTransport({
      mode,
      storedTransport: 'native',
      route: 'refresh',
      authority: 'invalid',
      requestChannel: 'consumer_web',
    })).toEqual({ kind: 'reject', code: 'SESSION_TRANSPORT_MISMATCH' });
  });

  it.each([
    ['off', 'allow'],
    ['observe', 'allow_observed'],
    ['enforce', 'reject'],
  ] as const)('classifies new unsigned direct Web in %s as %s', (mode, expected) => {
    const decision = decideTransport({
      mode,
      storedTransport: null,
      route: 'new_consumer_web_session',
      authority: 'missing',
    });
    expect(decision.kind).toBe(expected);
    if (decision.kind !== 'reject') expect(decision.transportClass).toBe('legacy_unclassified');
    else expect(decision).toEqual({ kind: 'reject', code: 'WEB_BFF_AUTHORITY_REQUIRED' });
  });

  it.each(modes)('classifies a verified new consumer Web session as web_bff in %s', (mode) => {
    expect(decideTransport({
      mode,
      storedTransport: null,
      route: 'new_consumer_web_session',
      authority: 'valid',
    })).toEqual({ kind: 'allow', transportClass: 'web_bff' });
  });

  it.each(modes)('never grants consumed-token recovery to legacy_unclassified in %s', (mode) => {
    expect(decideTransport({
      mode,
      storedTransport: 'legacy_unclassified',
      route: 'consumed_token_recovery',
      authority: 'missing',
    })).toEqual({ kind: 'reject', code: 'SESSION_TRANSPORT_MISMATCH' });
  });

  it.each([
    ['off', { kind: 'allow' }],
    ['observe', { kind: 'allow_observed' }],
    ['enforce', { kind: 'reject', code: 'WEB_BFF_AUTHORITY_REQUIRED' }],
  ] as const)('preserves legacy current first-use compatibility in %s', (mode, expected) => {
    expect(decideTransport({
      mode,
      storedTransport: 'legacy_unclassified',
      route: 'refresh',
      authority: 'missing',
    })).toEqual(expected);
  });

  it.each(modes)('allows unsigned new native issuance without reclassification in %s', (mode) => {
    expect(decideTransport({
      mode,
      storedTransport: null,
      route: 'new_native_session',
      authority: 'missing',
    })).toEqual({ kind: 'allow', transportClass: 'native' });
  });

  it.each(modes)('does not reinterpret any stored class from caller input in %s', (mode) => {
    const storedClasses: readonly SessionTransportClass[] = [
      'web_bff',
      'native',
      'ops',
      'legacy_unclassified',
    ];
    for (const storedTransport of storedClasses) {
      const decision = decideTransport({
        mode,
        storedTransport,
        route: 'refresh',
        authority: 'missing',
      });
      if ('transportClass' in decision) expect(decision.transportClass).toBe(storedTransport);
    }
  });

  it.each(modes)('requires the stored authority when a merge creates a successor in %s', (mode) => {
    expect(decideTransport({
      mode,
      storedTransport: 'web_bff',
      route: 'session_successor',
      authority: 'missing',
    })).toEqual({ kind: 'reject', code: 'WEB_BFF_AUTHORITY_REQUIRED' });
    expect(decideTransport({
      mode,
      storedTransport: 'web_bff',
      route: 'session_successor',
      authority: 'valid',
    })).toEqual({ kind: 'allow' });
    expect(decideTransport({
      mode,
      storedTransport: 'native',
      route: 'session_successor',
      authority: 'missing',
    })).toEqual({ kind: 'allow' });
    expect(decideTransport({
      mode,
      storedTransport: 'ops',
      route: 'session_successor',
      authority: 'missing',
    })).toEqual({ kind: 'reject', code: 'SESSION_TRANSPORT_MISMATCH' });
  });

  it.each(modes)('hard-requires verified BFF authority for persistent binding upgrade in %s', (mode) => {
    expect(decideTransport({
      mode,
      storedTransport: 'web_bff',
      route: 'binding_upgrade',
      authority: 'valid',
      requestChannel: 'verified_bff',
    })).toEqual({ kind: 'allow' });
    expect(decideTransport({
      mode,
      storedTransport: 'web_bff',
      route: 'binding_upgrade',
      authority: 'missing',
      requestChannel: 'headerless_native',
    })).toEqual({ kind: 'reject', code: 'WEB_BFF_AUTHORITY_REQUIRED' });
    expect(decideTransport({
      mode,
      storedTransport: 'native',
      route: 'binding_upgrade',
      authority: 'missing',
      requestChannel: 'headerless_native',
    })).toEqual({ kind: 'reject', code: 'SESSION_TRANSPORT_MISMATCH' });
  });

  it.each(modes)('rejects a browser-context native merge successor in %s', (mode) => {
    expect(decideTransport({
      mode,
      storedTransport: 'native',
      route: 'session_successor',
      authority: 'missing',
      requestChannel: 'consumer_web',
    })).toEqual({ kind: 'reject', code: 'SESSION_TRANSPORT_MISMATCH' });
  });

  it('does not classify Apple transport from caller-controlled body platform', () => {
    expect(classifyNewSessionRoute({
      path: '/v1/auth/apple',
      hasVerifiedAuthority: false,
      headers: {},
      bodyPlatform: 'web',
    })).toBe('new_native_session');
  });

  it.each(modes)('keeps a headerless native Google issuance native in %s', (mode) => {
    const route = classifyNewSessionRoute({
      path: '/v1/auth/google',
      hasVerifiedAuthority: false,
      headers: {},
    });

    expect(route).toBe('new_native_session');
    expect(decideTransport({
      mode,
      storedTransport: null,
      route,
      authority: 'missing',
    })).toEqual({ kind: 'allow', transportClass: 'native' });
  });

  it.each([
    ['off', { kind: 'allow', transportClass: 'legacy_unclassified' }],
    ['observe', { kind: 'allow_observed', transportClass: 'legacy_unclassified' }],
    ['enforce', { kind: 'reject', code: 'WEB_BFF_AUTHORITY_REQUIRED' }],
  ] as const)('keeps browser Google issuance on the Web boundary in %s', (mode, expected) => {
    const route = classifyNewSessionRoute({
      path: '/v1/auth/google',
      hasVerifiedAuthority: false,
      headers: {
        origin: 'https://spott.jp',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': '',
      },
    });

    expect(route).toBe('new_consumer_web_session');
    expect(decideTransport({
      mode,
      storedTransport: null,
      route,
      authority: 'missing',
    })).toEqual(expected);
  });

  it.each(modes)('classifies verified BFF Google issuance as web_bff in %s', (mode) => {
    const route = classifyNewSessionRoute({
      path: '/v1/auth/google',
      hasVerifiedAuthority: true,
      headers: {},
    });

    expect(route).toBe('new_consumer_web_session');
    expect(decideTransport({
      mode,
      storedTransport: null,
      route,
      authority: 'valid',
    })).toEqual({ kind: 'allow', transportClass: 'web_bff' });
  });

  it.each(modes)('applies the same trusted issuance channel matrix to Email, Apple, and Google in %s', (mode) => {
    for (const path of [
      '/v1/auth/email/verify',
      '/v1/auth/apple',
      '/v1/auth/google',
    ] as const) {
      const nativeRoute = classifyNewSessionRoute({
        path,
        hasVerifiedAuthority: false,
        headers: {},
      });
      expect(decideTransport({
        mode,
        storedTransport: null,
        route: nativeRoute,
        authority: 'missing',
        requestChannel: 'headerless_native',
      })).toEqual({ kind: 'allow', transportClass: 'native' });

      const browserRoute = classifyNewSessionRoute({
        path,
        hasVerifiedAuthority: false,
        headers: { origin: 'https://spott.jp', 'sec-fetch-site': 'same-origin' },
      });
      const browserDecision = decideTransport({
        mode,
        storedTransport: null,
        route: browserRoute,
        authority: 'missing',
        requestChannel: 'consumer_web',
      });
      expect(browserDecision.kind).toBe(mode === 'enforce'
        ? 'reject'
        : mode === 'observe' ? 'allow_observed' : 'allow');

      const verifiedRoute = classifyNewSessionRoute({
        path,
        hasVerifiedAuthority: true,
        headers: {},
      });
      expect(decideTransport({
        mode,
        storedTransport: null,
        route: verifiedRoute,
        authority: 'valid',
        requestChannel: 'verified_bff',
      })).toEqual({ kind: 'allow', transportClass: 'web_bff' });
    }
  });
});

describe('strict refresh credential grammar', () => {
  const sessionId = '019b0000-0000-7000-8000-000000000001';
  const secret = Buffer.alloc(32, 7).toString('base64url');

  it('parses only canonical legacy and s2 credentials', () => {
    expect(parseRefreshCredential(`${sessionId}.${secret}`)).toEqual({
      version: 'legacy',
      sessionId,
      secret,
    });
    expect(parseRefreshCredential(`s2.${sessionId}.0.${secret}`)).toEqual({
      version: 's2',
      sessionId,
      generation: 0,
      secret,
    });
    expect(parseRefreshCredential(`s2.${sessionId}.42.${secret}`)).toEqual({
      version: 's2',
      sessionId,
      generation: 42,
      secret,
    });
  });

  it.each([
    undefined,
    null,
    '',
    sessionId,
    `${sessionId}.${secret}.extra`,
    `s2.${sessionId}.${secret}`,
    `s2.${sessionId}.0.${secret}.extra`,
    `S2.${sessionId}.0.${secret}`,
    `s2.${sessionId}.00.${secret}`,
    `s2.${sessionId}.-1.${secret}`,
    `s2.${sessionId}.9007199254740992.${secret}`,
    `s2.${sessionId.toUpperCase()}.0.${secret}`,
    `s2.00000000-0000-0000-0000-000000000000.0.${secret}`,
    `${sessionId}.${secret}=`,
    `${sessionId}.${secret.slice(1)}`,
    `${sessionId}.${'a'.repeat(44)}`,
    `${sessionId}.${secret}\n`,
    `${sessionId}.${secret}\u0000`,
    `${sessionId}.${'a'.repeat(1_024)}`,
  ])('rejects malformed or oversized refresh material without partial parsing: %j', (value) => {
    expect(parseRefreshCredential(value)).toBeNull();
  });
});

describe('PostgreSQL-backed BFF nonce verification', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(fixedFields.timestamp);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns verified metadata only after an atomic one-time insert', async () => {
    const nonceHash = createHash('sha256').update(fixedFields.nonce).digest();
    const database = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ nonce_hash: nonceHash }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }),
    };
    const authority = new WebBFFAuthority(database);

    await expect(authority.verifyRequest(signedRequest())).resolves.toEqual({
      version: 'v1',
      kid: fixedFields.kid,
      timestamp: fixedFields.timestamp,
      nonceHash,
    });

    expect(database.query).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/INSERT INTO identity\.web_bff_request_nonces[\s\S]*ON CONFLICT DO NOTHING[\s\S]*RETURNING nonce_hash/),
      [fixedFields.kid, nonceHash, fixedFields.timestamp],
    );
    expect(database.query).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(
        /DELETE FROM identity\.web_bff_request_nonces[\s\S]*NOT \(signing_kid = \$1 AND nonce_hash = \$2\)[\s\S]*LIMIT 100/,
      ),
      [fixedFields.kid, nonceHash],
    );
  });

  it.each([
    ['expired', fixedFields.timestamp - 120_001],
    ['future', fixedFields.timestamp + 120_001],
  ] as const)('rejects an %s timestamp before touching PostgreSQL', async (_label, timestamp) => {
    const database = { query: vi.fn() };
    const authority = new WebBFFAuthority(database);
    const controller = vi.fn();

    await expect(authority.verifyRequest(signedRequest({ now: timestamp })).then(controller))
      .rejects.toMatchObject({ code: 'WEB_BFF_AUTHORITY_INVALID' });
    expect(controller).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });

  it('rejects an unknown KID before touching PostgreSQL', async () => {
    const database = { query: vi.fn() };
    const authority = new WebBFFAuthority(database);
    const controller = vi.fn();

    await expect(authority.verifyRequest(signedRequest({
      kid: 'unknown-kid',
      signature: fixedSignature,
    })).then(controller)).rejects.toMatchObject({ code: 'WEB_BFF_AUTHORITY_INVALID' });
    expect(controller).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });

  it.each(['short', 'nonce with spaces', 'a'.repeat(129)])(
    'rejects malformed nonce %s before touching PostgreSQL',
    async (nonce) => {
      const database = { query: vi.fn() };
      const authority = new WebBFFAuthority(database);

      await expect(authority.verifyRequest(signedRequest({ nonce })))
        .rejects.toMatchObject({ code: 'WEB_BFF_AUTHORITY_INVALID' });
      expect(database.query).not.toHaveBeenCalled();
    },
  );

  it('rejects a duplicate nonce and never invokes the controller callback or cleanup', async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    const authority = new WebBFFAuthority(database);
    const controller = vi.fn();

    await expect(authority.verifyRequest(signedRequest()).then(controller))
      .rejects.toMatchObject({ code: 'WEB_BFF_AUTHORITY_INVALID' });
    expect(controller).not.toHaveBeenCalled();
    expect(database.query).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the nonce store is unavailable and never invokes the controller callback', async () => {
    const database = { query: vi.fn().mockRejectedValue(new Error('database unavailable')) };
    const authority = new WebBFFAuthority(database);
    const controller = vi.fn();

    await expect(authority.verifyRequest(signedRequest()).then(controller))
      .rejects.toMatchObject({ code: 'WEB_BFF_AUTHORITY_INVALID' });
    expect(controller).not.toHaveBeenCalled();
    expect(database.query).toHaveBeenCalledTimes(1);
  });

  it('does not fail an already consumed valid nonce when bounded cleanup fails', async () => {
    const nonceHash = createHash('sha256').update(fixedFields.nonce).digest();
    const database = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ nonce_hash: nonceHash }], rowCount: 1 })
        .mockRejectedValueOnce(new Error('cleanup unavailable')),
    };
    const authority = new WebBFFAuthority(database);

    await expect(authority.verifyRequest(signedRequest())).resolves.toMatchObject({ nonceHash });
  });
});

describe('production bootstrap security contract', () => {
  const apiRoot = resolve(import.meta.dirname, '..');

  it('enables raw-body capture and redacts every session authority secret', () => {
    const source = readFileSync(resolve(apiRoot, 'main.ts'), 'utf8');
    expect(source).toMatch(/rawBody:\s*true/);
    for (const redaction of [
      'req.headers.x-spott-bff-signature',
      'req.headers.x-spott-device-binding',
      'body.refreshToken',
      'body.deviceBindingProof',
      'body.newBinding.proof',
      'rawBody',
    ]) {
      expect(source).toContain(`'${redaction}'`);
    }
  });

  it('types raw bytes and verified metadata separately from untrusted BFF headers', () => {
    const source = readFileSync(resolve(apiRoot, 'platform/request-context.ts'), 'utf8');
    expect(source).toContain('rawBody');
    expect(source).toContain('verifiedBFFAuthority');
    expect(source).toContain('x-spott-bff-signature');
  });
});
