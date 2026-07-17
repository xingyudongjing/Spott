import { z } from 'zod';

const originListSchema = (defaultOrigin: string) => z
  .string()
  .default(defaultOrigin)
  .transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean))
  .pipe(z.array(z.string().url()).min(1));

const canonicalOriginSchema = z.string().superRefine((value, context) => {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value) {
      context.addIssue({
        code: 'custom',
        message: 'SPOTT_WEB_CANONICAL_ORIGIN must be one canonical HTTP(S) origin without a path',
      });
    }
  } catch {
    context.addIssue({
      code: 'custom',
      message: 'SPOTT_WEB_CANONICAL_ORIGIN must be one canonical HTTP(S) origin without a path',
    });
  }
});

const rawConfigurationSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4100),
  DATABASE_URL: z.string().url().or(z.string().startsWith('postgres://')),
  WEB_ORIGIN: originListSchema('http://localhost:3000'),
  OPS_ORIGIN: originListSchema('http://localhost:3001'),
  ACCESS_TOKEN_SECRET: z.string().min(32),
  REFRESH_TOKEN_SECRET: z.string().min(32),
  FIELD_ENCRYPTION_KEY_BASE64: z.string().min(32),
  LOOKUP_HMAC_PEPPER: z.string().min(16),
  OTP_PROVIDER: z.enum(['console', 'primary', 'secondary']).default('console'),
  APPLE_BUNDLE_ID: z.string().default('com.yaokai.Spott'),
  APPLE_SERVICE_ID: z.preprocess(
    (value) => (value === '' || value === undefined ? undefined : value),
    z.string().min(3).optional(),
  ),
  APPLE_APP_ID: z.preprocess(
    (value) => (value === '' || value === undefined ? undefined : value),
    z.coerce.number().int().positive().optional(),
  ),
  APPLE_STORE_ENVIRONMENT: z.enum(['Sandbox', 'Production']).default('Sandbox'),
  APPLE_ROOT_CA_PATHS: z
    .string()
    .default('services/api/certs/AppleRootCA-G2.cer,services/api/certs/AppleRootCA-G3.cer'),
  APPLE_ENABLE_ONLINE_CHECKS: z.enum(['true', 'false']).default('true'),
  // OAuth Web application client ID. Native iOS client IDs are deliberately
  // not accepted as the backend token audience.
  GOOGLE_SERVER_CLIENT_ID: z.string().optional(),
  SPOTT_WEB_BFF_KEYS: z.string(),
  SPOTT_WEB_BFF_CURRENT_KID: z.string().min(1),
  REFRESH_TOKEN_DERIVATION_KEYS: z.string(),
  REFRESH_TOKEN_DERIVATION_CURRENT_KID: z.string().min(1),
  WEB_SESSION_BFF_ENFORCEMENT: z.enum(['off', 'observe', 'enforce']),
  WEB_SESSION_RECOVERY_SECONDS: z.coerce.number().int().positive(),
  SPOTT_WEB_CANONICAL_ORIGIN: canonicalOriginSchema,
  ACCOUNT_MERGE_EXECUTION_ENABLED: z.enum(['true', 'false']).default('false'),
  // Opt-in local-debugging backdoor: trust `x-spott-user-id`/`x-spott-role` request
  // headers instead of a verified session. Defaults to disabled so a deployment that
  // forgets NODE_ENV cannot serve every Ops capability to anonymous callers, and is
  // forced back to 'false' in production by parseConfiguration.
  ENABLE_DEV_HEADER_AUTH: z.enum(['true', 'false']).default('false'),
});

type RawConfiguration = z.infer<typeof rawConfigurationSchema>;

export interface VersionedKeyring extends Iterable<readonly [string, Buffer]> {
  readonly currentKid: string;
  getKey(kid: string): Buffer | undefined;
  entries(): IterableIterator<readonly [string, Buffer]>;
}

export type Configuration = Omit<
  RawConfiguration,
  'SPOTT_WEB_BFF_KEYS' | 'REFRESH_TOKEN_DERIVATION_KEYS'
> & {
  readonly SPOTT_WEB_BFF_KEYS: VersionedKeyring;
  readonly REFRESH_TOKEN_DERIVATION_KEYS: VersionedKeyring;
};

const nonProductionSessionSecurityDefaults = {
  SPOTT_WEB_BFF_KEYS: 'bff-2026-07:MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY',
  SPOTT_WEB_BFF_CURRENT_KID: 'bff-2026-07',
  REFRESH_TOKEN_DERIVATION_KEYS:
    'refresh-2026-07:ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA',
  REFRESH_TOKEN_DERIVATION_CURRENT_KID: 'refresh-2026-07',
  WEB_SESSION_BFF_ENFORCEMENT: 'off',
  WEB_SESSION_RECOVERY_SECONDS: '120',
  SPOTT_WEB_CANONICAL_ORIGIN: 'https://spott.jp',
} satisfies NodeJS.ProcessEnv;

const publicExampleKeyFingerprints = new Set([
  nonProductionSessionSecurityDefaults.SPOTT_WEB_BFF_KEYS,
  nonProductionSessionSecurityDefaults.REFRESH_TOKEN_DERIVATION_KEYS,
].map((entry) => Buffer.from(entry.slice(entry.indexOf(':') + 1), 'base64url').toString('hex')));

const sessionSecurityVariables = Object.keys(
  nonProductionSessionSecurityDefaults,
) as (keyof typeof nonProductionSessionSecurityDefaults)[];

const keyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const canonicalBase64URLPattern = /^[A-Za-z0-9_-]+$/;

function readonlyVersionedKeyring(
  source: ReadonlyMap<string, Buffer>,
  currentKid: string,
): VersionedKeyring {
  const keys = new Map(
    [...source].map(([kid, key]) => [kid, Buffer.from(key)] as const),
  );
  const entries = function* (): IterableIterator<readonly [string, Buffer]> {
    for (const [kid, key] of keys) yield [kid, Buffer.from(key)] as const;
  };

  return Object.freeze({
    currentKid,
    getKey(kid: string): Buffer | undefined {
      const key = keys.get(kid);
      return key === undefined ? undefined : Buffer.from(key);
    },
    entries,
    [Symbol.iterator]: entries,
  });
}

function parseNamedVersionedKeyring(
  value: string,
  currentKid: string,
  keysVariable: string,
  currentKidVariable: string,
): VersionedKeyring {
  if (!value) throw new Error(`${keysVariable}: keyring must not be empty`);
  if (!keyIdPattern.test(currentKid)) {
    throw new Error(`${currentKidVariable}: current KID is invalid`);
  }

  const keys = new Map<string, Buffer>();
  const decodedKeys = new Set<string>();

  for (const entry of value.split(',')) {
    const separator = entry.indexOf(':');
    if (separator <= 0 || separator !== entry.lastIndexOf(':')) {
      throw new Error(`${keysVariable}: every key must use KID:base64url format`);
    }

    const kid = entry.slice(0, separator);
    const encodedKey = entry.slice(separator + 1);
    if (!keyIdPattern.test(kid)) {
      throw new Error(`${keysVariable}: contains an invalid KID`);
    }
    if (keys.has(kid)) {
      throw new Error(`${keysVariable}: contains a duplicate KID`);
    }
    if (!canonicalBase64URLPattern.test(encodedKey)) {
      throw new Error(`${keysVariable}: contains non-canonical base64url key material`);
    }

    const key = Buffer.from(encodedKey, 'base64url');
    if (key.toString('base64url') !== encodedKey) {
      throw new Error(`${keysVariable}: contains non-canonical base64url key material`);
    }
    if (key.byteLength < 32) {
      throw new Error(`${keysVariable}: every key must contain at least 32 bytes`);
    }

    const fingerprint = key.toString('hex');
    if (decodedKeys.has(fingerprint)) {
      throw new Error(`${keysVariable}: contains duplicate decoded key material`);
    }
    decodedKeys.add(fingerprint);
    keys.set(kid, key);
  }

  if (!keys.has(currentKid)) {
    throw new Error(`${currentKidVariable}: current KID is not present in ${keysVariable}`);
  }

  return readonlyVersionedKeyring(keys, currentKid);
}

export function parseVersionedKeyring(value: string, currentKid: string): VersionedKeyring {
  return parseNamedVersionedKeyring(value, currentKid, 'VERSIONED_KEYRING', 'CURRENT_KID');
}

function withNonProductionSessionSecurityDefaults(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (environment.NODE_ENV !== 'development' && environment.NODE_ENV !== 'test') {
    return environment;
  }

  const hasAnySessionSecurityValue = sessionSecurityVariables.some(
    (variable) => environment[variable] !== undefined,
  );
  if (hasAnySessionSecurityValue) return environment;

  return { ...nonProductionSessionSecurityDefaults, ...environment };
}

export function corsOrigins(
  config: Pick<Configuration, 'NODE_ENV' | 'WEB_ORIGIN' | 'OPS_ORIGIN'>,
): string[] {
  const configured = [...config.WEB_ORIGIN, ...config.OPS_ORIGIN];
  const localDevelopmentOrigins = config.NODE_ENV === 'development'
    ? [
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:3002',
        'http://localhost:3003',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:3001',
        'http://127.0.0.1:3002',
        'http://127.0.0.1:3003',
      ]
    : [];
  return [...new Set([...configured, ...localDevelopmentOrigins])];
}

let cached: Configuration | undefined;

export function parseConfiguration(environment: NodeJS.ProcessEnv): Configuration {
  const raw = rawConfigurationSchema.parse(
    withNonProductionSessionSecurityDefaults(environment),
  );
  if (raw.NODE_ENV === 'production'
    && new URL(raw.SPOTT_WEB_CANONICAL_ORIGIN).protocol !== 'https:') {
    throw new Error('SPOTT_WEB_CANONICAL_ORIGIN must use HTTPS in production');
  }
  const bffKeys = parseNamedVersionedKeyring(
    raw.SPOTT_WEB_BFF_KEYS,
    raw.SPOTT_WEB_BFF_CURRENT_KID,
    'SPOTT_WEB_BFF_KEYS',
    'SPOTT_WEB_BFF_CURRENT_KID',
  );
  const refreshDerivationKeys = parseNamedVersionedKeyring(
    raw.REFRESH_TOKEN_DERIVATION_KEYS,
    raw.REFRESH_TOKEN_DERIVATION_CURRENT_KID,
    'REFRESH_TOKEN_DERIVATION_KEYS',
    'REFRESH_TOKEN_DERIVATION_CURRENT_KID',
  );
  if (raw.NODE_ENV === 'production') {
    if ([...bffKeys].some(([, key]) => publicExampleKeyFingerprints.has(key.toString('hex')))) {
      throw new Error('SPOTT_WEB_BFF_KEYS: public example key material is forbidden in production');
    }
    if ([...refreshDerivationKeys].some(
      ([, key]) => publicExampleKeyFingerprints.has(key.toString('hex')),
    )) {
      throw new Error(
        'REFRESH_TOKEN_DERIVATION_KEYS: public example key material is forbidden in production',
      );
    }
  }

  const bffFingerprints = new Set(
    [...bffKeys].map(([, key]) => key.toString('hex')),
  );

  if ([...refreshDerivationKeys].some(
    ([, key]) => bffFingerprints.has(key.toString('hex')),
  )) {
    throw new Error(
      'SPOTT_WEB_BFF_KEYS and REFRESH_TOKEN_DERIVATION_KEYS must use independent key material',
    );
  }

  return {
    ...raw,
    // Production can never carry the header backdoor, whatever the environment says.
    ENABLE_DEV_HEADER_AUTH: raw.NODE_ENV === 'production' ? 'false' : raw.ENABLE_DEV_HEADER_AUTH,
    SPOTT_WEB_BFF_KEYS: bffKeys,
    REFRESH_TOKEN_DERIVATION_KEYS: refreshDerivationKeys,
  };
}

/**
 * The only sanctioned way to ask whether header-based development authentication may run.
 * Both conditions are re-checked at every call site: an explicit dedicated opt-in, and a
 * non-production NODE_ENV. Neither alone is sufficient.
 */
export function devHeaderAuthEnabled(
  config: Pick<Configuration, 'NODE_ENV' | 'ENABLE_DEV_HEADER_AUTH'>,
): boolean {
  return config.NODE_ENV !== 'production' && config.ENABLE_DEV_HEADER_AUTH === 'true';
}

export function configuration(): Configuration {
  cached ??= parseConfiguration(process.env);
  return cached;
}
