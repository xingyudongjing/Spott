import { describe, expect, it } from 'vitest';
import {
  corsOrigins,
  devHeaderAuthEnabled,
  parseConfiguration,
  parseVersionedKeyring,
} from './config.js';

const bffKey = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY';
const refreshKey = 'ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA';
const productionBffKey = Buffer.alloc(32, 0xa1).toString('base64url');
const productionRefreshKey = Buffer.alloc(32, 0xb2).toString('base64url');

const sessionSecurityVariables = [
  'SPOTT_WEB_BFF_KEYS',
  'SPOTT_WEB_BFF_CURRENT_KID',
  'REFRESH_TOKEN_DERIVATION_KEYS',
  'REFRESH_TOKEN_DERIVATION_CURRENT_KID',
  'WEB_SESSION_BFF_ENFORCEMENT',
  'WEB_SESSION_RECOVERY_SECONDS',
  'SPOTT_WEB_CANONICAL_ORIGIN',
] as const;

function baseEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://127.0.0.1:55432/spott_test',
    ACCESS_TOKEN_SECRET: 'test-access-token-secret-at-least-32-bytes',
    REFRESH_TOKEN_SECRET: 'test-refresh-token-secret-at-least-32-bytes',
    FIELD_ENCRYPTION_KEY_BASE64: Buffer.alloc(32).toString('base64'),
    LOOKUP_HMAC_PEPPER: 'test-lookup-pepper-at-least-16',
    SPOTT_WEB_BFF_KEYS: `bff-current:${bffKey}`,
    SPOTT_WEB_BFF_CURRENT_KID: 'bff-current',
    REFRESH_TOKEN_DERIVATION_KEYS: `refresh-current:${refreshKey}`,
    REFRESH_TOKEN_DERIVATION_CURRENT_KID: 'refresh-current',
    WEB_SESSION_BFF_ENFORCEMENT: 'off',
    WEB_SESSION_RECOVERY_SECONDS: '120',
    SPOTT_WEB_CANONICAL_ORIGIN: 'https://spott.jp',
    ...overrides,
  };
}

function productionEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return baseEnvironment({
    NODE_ENV: 'production',
    SPOTT_WEB_BFF_KEYS: `production-bff:${productionBffKey}`,
    SPOTT_WEB_BFF_CURRENT_KID: 'production-bff',
    REFRESH_TOKEN_DERIVATION_KEYS: `production-refresh:${productionRefreshKey}`,
    REFRESH_TOKEN_DERIVATION_CURRENT_KID: 'production-refresh',
    ...overrides,
  });
}

function errorMessage(callback: () => unknown): string {
  try {
    callback();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

describe('corsOrigins', () => {
  it('allows the web fallback port in development and removes duplicates', () => {
    expect(corsOrigins({
      NODE_ENV: 'development',
      WEB_ORIGIN: ['http://localhost:3000', 'http://localhost:3003'],
      OPS_ORIGIN: ['http://localhost:3001'],
    })).toEqual(expect.arrayContaining([
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:3003',
    ]));
    expect(new Set(corsOrigins({
      NODE_ENV: 'development',
      WEB_ORIGIN: ['http://localhost:3000'],
      OPS_ORIGIN: ['http://localhost:3000'],
    })).size).toBe(corsOrigins({
      NODE_ENV: 'development',
      WEB_ORIGIN: ['http://localhost:3000'],
      OPS_ORIGIN: ['http://localhost:3000'],
    }).length);
  });

  it('does not broaden the production allowlist', () => {
    expect(corsOrigins({
      NODE_ENV: 'production',
      WEB_ORIGIN: ['https://spott.jp'],
      OPS_ORIGIN: ['https://ops.spott.jp'],
    })).toEqual(['https://spott.jp', 'https://ops.spott.jp']);
  });

  it('allows private-LAN web origins on dev ports in development only', () => {
    const developmentOrigins = corsOrigins({
      NODE_ENV: 'development',
      WEB_ORIGIN: ['http://localhost:3000'],
      OPS_ORIGIN: [],
    });
    const lanPattern = developmentOrigins.find(
      (origin): origin is RegExp => origin instanceof RegExp,
    );
    expect(lanPattern).toBeDefined();
    expect(lanPattern?.test('http://192.168.102.109:3002')).toBe(true);
    expect(lanPattern?.test('http://10.0.0.7:3003')).toBe(true);
    expect(lanPattern?.test('http://172.20.1.5:3000')).toBe(true);
    expect(lanPattern?.test('http://192.168.1.4:8080')).toBe(false);
    expect(lanPattern?.test('http://8.8.8.8:3002')).toBe(false);
    expect(lanPattern?.test('https://evil.example')).toBe(false);

    const productionOrigins = corsOrigins({
      NODE_ENV: 'production',
      WEB_ORIGIN: ['https://spott.jp'],
      OPS_ORIGIN: [],
    });
    expect(productionOrigins.some((origin) => origin instanceof RegExp)).toBe(false);
  });
});

describe('session security configuration', () => {
  it('parses independent versioned keyrings and session controls', () => {
    const parsed = parseConfiguration(baseEnvironment());

    expect(parsed.SPOTT_WEB_BFF_KEYS.currentKid).toBe('bff-current');
    expect(parsed.SPOTT_WEB_BFF_KEYS.getKey('bff-current')).toEqual(
      Buffer.from('0123456789abcdef0123456789abcdef'),
    );
    expect(parsed.REFRESH_TOKEN_DERIVATION_KEYS.currentKid).toBe('refresh-current');
    expect(parsed.REFRESH_TOKEN_DERIVATION_KEYS.getKey('refresh-current')).toEqual(
      Buffer.from('fedcba9876543210fedcba9876543210'),
    );
    expect(parsed.WEB_SESSION_BFF_ENFORCEMENT).toBe('off');
    expect(parsed.WEB_SESSION_RECOVERY_SECONDS).toBe(120);
    expect(parsed.SPOTT_WEB_CANONICAL_ORIGIN).toBe('https://spott.jp');
  });

  it.each([
    {
      label: 'an empty BFF keyring',
      variable: 'SPOTT_WEB_BFF_KEYS',
      overrides: { SPOTT_WEB_BFF_KEYS: '' },
      secrets: [''],
    },
    {
      label: 'an empty refresh-derivation keyring',
      variable: 'REFRESH_TOKEN_DERIVATION_KEYS',
      overrides: { REFRESH_TOKEN_DERIVATION_KEYS: '' },
      secrets: [''],
    },
    {
      label: 'duplicate KIDs',
      variable: 'SPOTT_WEB_BFF_KEYS',
      overrides: {
        SPOTT_WEB_BFF_KEYS: `bff-current:${bffKey},bff-current:${refreshKey}`,
      },
      secrets: [bffKey, refreshKey],
    },
    {
      label: 'an unknown current KID',
      variable: 'SPOTT_WEB_BFF_CURRENT_KID',
      overrides: { SPOTT_WEB_BFF_CURRENT_KID: 'bff-unknown' },
      secrets: [bffKey],
    },
    {
      label: 'a key shorter than 32 bytes',
      variable: 'SPOTT_WEB_BFF_KEYS',
      overrides: {
        SPOTT_WEB_BFF_KEYS: `bff-current:${Buffer.alloc(31, 1).toString('base64url')}`,
      },
      secrets: [Buffer.alloc(31, 1).toString('base64url')],
    },
    {
      label: 'padded base64url',
      variable: 'SPOTT_WEB_BFF_KEYS',
      overrides: { SPOTT_WEB_BFF_KEYS: `bff-current:${bffKey}=` },
      secrets: [`${bffKey}=`],
    },
    {
      label: 'duplicate decoded key bytes under different KIDs',
      variable: 'SPOTT_WEB_BFF_KEYS',
      overrides: {
        SPOTT_WEB_BFF_KEYS: `bff-current:${bffKey},bff-old:${bffKey}`,
      },
      secrets: [bffKey],
    },
  ])('rejects $label without disclosing key material', ({ variable, overrides, secrets }) => {
    const message = errorMessage(() => parseConfiguration(baseEnvironment(overrides)));

    expect(message).toContain(variable);
    for (const secret of secrets) {
      if (secret) expect(message).not.toContain(secret);
    }
  });

  it('rejects using the same decoded key across purposes without disclosing it', () => {
    const message = errorMessage(() => parseConfiguration(baseEnvironment({
      SPOTT_WEB_BFF_KEYS: `bff-current:${bffKey}`,
      SPOTT_WEB_BFF_CURRENT_KID: 'bff-current',
      REFRESH_TOKEN_DERIVATION_KEYS: `refresh-current:${bffKey}`,
      REFRESH_TOKEN_DERIVATION_CURRENT_KID: 'refresh-current',
    })));

    expect(message).toMatch(/SPOTT_WEB_BFF_KEYS.*REFRESH_TOKEN_DERIVATION_KEYS/);
    expect(message).not.toContain(bffKey);
  });

  it.each(['development', 'test'] as const)(
    'injects public example keyrings only for explicit %s environments',
    (nodeEnvironment) => {
      const environment = baseEnvironment({ NODE_ENV: nodeEnvironment });
      for (const variable of sessionSecurityVariables) delete environment[variable];

      const parsed = parseConfiguration(environment);
      expect(parsed.SPOTT_WEB_BFF_KEYS.getKey('bff-2026-07')).toEqual(
        Buffer.from(bffKey, 'base64url'),
      );
      expect(parsed.REFRESH_TOKEN_DERIVATION_KEYS.getKey('refresh-2026-07')).toEqual(
        Buffer.from(refreshKey, 'base64url'),
      );
    },
  );

  it('fails closed when NODE_ENV is missing instead of injecting example keys', () => {
    const environment = baseEnvironment();
    delete environment.NODE_ENV;
    for (const variable of sessionSecurityVariables) delete environment[variable];

    expect(errorMessage(() => parseConfiguration(environment))).toContain('NODE_ENV');
  });

  it.each([
    {
      label: 'the original BFF example KID',
      variable: 'SPOTT_WEB_BFF_KEYS',
      secret: bffKey,
      overrides: {
        SPOTT_WEB_BFF_KEYS: `bff-2026-07:${bffKey}`,
        SPOTT_WEB_BFF_CURRENT_KID: 'bff-2026-07',
      },
    },
    {
      label: 'a renamed BFF example KID',
      variable: 'SPOTT_WEB_BFF_KEYS',
      secret: bffKey,
      overrides: {
        SPOTT_WEB_BFF_KEYS: `production-renamed:${bffKey}`,
        SPOTT_WEB_BFF_CURRENT_KID: 'production-renamed',
      },
    },
    {
      label: 'the original refresh example KID',
      variable: 'REFRESH_TOKEN_DERIVATION_KEYS',
      secret: refreshKey,
      overrides: {
        REFRESH_TOKEN_DERIVATION_KEYS: `refresh-2026-07:${refreshKey}`,
        REFRESH_TOKEN_DERIVATION_CURRENT_KID: 'refresh-2026-07',
      },
    },
    {
      label: 'a renamed refresh example KID',
      variable: 'REFRESH_TOKEN_DERIVATION_KEYS',
      secret: refreshKey,
      overrides: {
        REFRESH_TOKEN_DERIVATION_KEYS: `production-renamed:${refreshKey}`,
        REFRESH_TOKEN_DERIVATION_CURRENT_KID: 'production-renamed',
      },
    },
  ])('rejects $label in production by decoded fingerprint', ({ variable, secret, overrides }) => {
    const message = errorMessage(() => parseConfiguration(productionEnvironment(overrides)));

    expect(message).toContain(variable);
    expect(message).not.toContain(secret);
  });

  it('does not expose mutable key storage or key bytes', () => {
    const keyring = parseVersionedKeyring(`bff-current:${bffKey}`, 'bff-current');
    const returnedKey = keyring.getKey('bff-current');
    expect(returnedKey).toBeDefined();
    returnedKey?.fill(0);

    const entries = [...keyring.entries()];
    entries[0]?.[1].fill(0xff);
    const forcedMap = new Map([['attacker', Buffer.alloc(32, 0xcc)]]);
    expect(Reflect.set(keyring, 'keys', forcedMap)).toBe(false);

    expect((keyring as unknown as { keys?: Map<string, Buffer> }).keys).toBeUndefined();
    expect(keyring.getKey('attacker')).toBeUndefined();
    expect(keyring.getKey('bff-current')).toEqual(Buffer.from(bffKey, 'base64url'));
    expect([...keyring.entries()]).toEqual([
      ['bff-current', Buffer.from(bffKey, 'base64url')],
    ]);
  });

  it.each(['observe', 'enforce'] as const)('accepts the %s enforcement mode', (mode) => {
    expect(parseConfiguration(baseEnvironment({
      WEB_SESSION_BFF_ENFORCEMENT: mode,
    })).WEB_SESSION_BFF_ENFORCEMENT).toBe(mode);
  });

  it.each(['-1', '0', '1.5', 'not-a-number'])(
    'rejects an invalid recovery window of %s seconds',
    (seconds) => {
      expect(() => parseConfiguration(baseEnvironment({
        WEB_SESSION_RECOVERY_SECONDS: seconds,
      }))).toThrow(/WEB_SESSION_RECOVERY_SECONDS/);
    },
  );

  it('rejects a canonical origin with a path', () => {
    expect(() => parseConfiguration(baseEnvironment({
      SPOTT_WEB_CANONICAL_ORIGIN: 'https://spott.jp/session',
    }))).toThrow(/SPOTT_WEB_CANONICAL_ORIGIN/);
  });

  it('accepts a canonical loopback HTTP origin in development', () => {
    expect(parseConfiguration(baseEnvironment({
      NODE_ENV: 'development',
      SPOTT_WEB_CANONICAL_ORIGIN: 'http://127.0.0.1:3000',
    })).SPOTT_WEB_CANONICAL_ORIGIN).toBe('http://127.0.0.1:3000');
  });

  it('keeps account-merge execution disabled unless explicitly enabled', () => {
    expect(parseConfiguration(baseEnvironment()).ACCOUNT_MERGE_EXECUTION_ENABLED).toBe('false');
    expect(parseConfiguration(baseEnvironment({
      ACCOUNT_MERGE_EXECUTION_ENABLED: 'true',
    })).ACCOUNT_MERGE_EXECUTION_ENABLED).toBe('true');
    expect(() => parseConfiguration(baseEnvironment({
      ACCOUNT_MERGE_EXECUTION_ENABLED: 'yes',
    }))).toThrow(/ACCOUNT_MERGE_EXECUTION_ENABLED/);
  });

  it('keeps header authentication disabled unless explicitly enabled outside production', () => {
    expect(parseConfiguration(baseEnvironment()).ENABLE_DEV_HEADER_AUTH).toBe('false');
    expect(devHeaderAuthEnabled(parseConfiguration(baseEnvironment()))).toBe(false);
    expect(devHeaderAuthEnabled(parseConfiguration(baseEnvironment({
      ENABLE_DEV_HEADER_AUTH: 'true',
    })))).toBe(true);
    expect(() => parseConfiguration(baseEnvironment({
      ENABLE_DEV_HEADER_AUTH: 'yes',
    }))).toThrow(/ENABLE_DEV_HEADER_AUTH/);
  });

  it('forces header authentication off in production even when the switch asks for it', () => {
    const config = parseConfiguration(productionEnvironment({ ENABLE_DEV_HEADER_AUTH: 'true' }));

    expect(config.ENABLE_DEV_HEADER_AUTH).toBe('false');
    expect(devHeaderAuthEnabled(config)).toBe(false);
    // Second line of defence: the helper refuses production even if the value leaked through.
    expect(devHeaderAuthEnabled({ NODE_ENV: 'production', ENABLE_DEV_HEADER_AUTH: 'true' })).toBe(false);
  });

  it('requires HTTPS for the canonical production origin', () => {
    expect(() => parseConfiguration(productionEnvironment({
      SPOTT_WEB_CANONICAL_ORIGIN: 'http://spott.jp',
    }))).toThrow(/SPOTT_WEB_CANONICAL_ORIGIN/);
  });

  it('requires explicit session-security keyrings in production', () => {
    const environment = productionEnvironment();
    delete environment.SPOTT_WEB_BFF_KEYS;
    delete environment.SPOTT_WEB_BFF_CURRENT_KID;

    expect(() => parseConfiguration(environment)).toThrow(/SPOTT_WEB_BFF_KEYS/);
  });
});
