import { z } from 'zod';

const originListSchema = (defaultOrigin: string) => z
  .string()
  .default(defaultOrigin)
  .transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean))
  .pipe(z.array(z.string().url()).min(1));

const configurationSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
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
});

export type Configuration = z.infer<typeof configurationSchema>;

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
  return configurationSchema.parse(environment);
}

export function configuration(): Configuration {
  cached ??= parseConfiguration(process.env);
  return cached;
}
